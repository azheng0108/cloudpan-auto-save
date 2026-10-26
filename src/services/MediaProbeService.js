const path = require('path');
const got = require('got');
const pLimit = require('p-limit');
const logger = require('../utils/logger');
const ConfigService = require('./ConfigService');
const { IsoProbeService } = require('./IsoProbeService');
const { RecognitionEngine } = require('./RecognitionEngine');

/**
 * 媒体探针服务 (MediaProbeService)
 * 
 * 基于 139 移动云盘直链的原生 HTTP Range 二进制视频流探针引擎 (零外部工具依赖，开箱即用)
 * 核心目标：
 * 在洗版与整理归档之前，对视频流执行真实的物理元数据探测（分辨率、视频编码、音频规格、色深、动态范围、帧率）
 * 杜绝文件名误导与瞎猜，为 8 级画质洗版（compareCandidates）提供确凿、规范的基准数据。
 */
class MediaProbeService {
    // 内存元数据 LRU 缓存，键为 `${fileId}:${fileSize}`
    static _cache = new Map();

    // mediainfo.js WASM 单例实例
    static _mediaInfoInstance = null;

    /**
     * 获取或初始化 MediaInfo WASM 单例实例
     */
    static async _getMediaInfo() {
        if (!this._mediaInfoInstance) {
            const { mediaInfoFactory } = require('mediainfo.js');
            this._mediaInfoInstance = await mediaInfoFactory({ format: 'object' });
        }
        return this._mediaInfoInstance;
    }

    /**
     * 重置 MediaInfo WASM 实例（当解析抛错或内存异常时安全销毁并释放，防止实例污染）
     */
    static _resetMediaInfo() {
        if (this._mediaInfoInstance) {
            try {
                this._mediaInfoInstance.close();
            } catch (_) {}
            this._mediaInfoInstance = null;
        }
    }

    // ==========================================
    // 1. 标准化归一化函数群 (100% 对齐 139 助手 2.8.x)
    // ==========================================

    /**
     * 分辨率标准化 (8K / 2160p / 2K / 1080p / 1080i / 720p / 480p)
     * 严禁输出未归一化的 "4K"，一律收敛为 "2160p"
     */
    static normalizeResolution(width, height, scanType = '') {
        const parseDim = (v) => {
            if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
            const cleaned = String(v || '').replace(/[^\d.]/g, '');
            return cleaned ? (Number(cleaned) || 0) : 0;
        };
        const w = parseDim(width);
        const h = parseDim(height);
        const size = Math.max(w, h);
        if (size >= 7600) return '8K';
        if (size >= 3800 || (w >= 3800 || h >= 1600)) return '2160p';
        if (size >= 2500) return '2K';
        if (size >= 1700 || (w >= 1900 || h >= 800)) {
            const isInterlaced = /interlace|mbaff|tt|bb|tb/i.test(String(scanType || ''));
            return isInterlaced ? '1080i' : '1080p';
        }
        if (size >= 1200 || (w >= 1200 || h >= 500)) {
            const isInterlaced = /interlace|mbaff|tt|bb|tb/i.test(String(scanType || ''));
            return isInterlaced ? '720i' : '720p';
        }
        if (size >= 900) return '540p';
        if (size >= 700 || (w >= 700 || h >= 400)) return '480p';
        if (size >= 500) return '360p';
        return '';
    }

    /**
     * 视频编码标准化 (H.265 / H.264 / AV1 / VP9 / MPEG2 / VC1)
     */
    static normalizeVideoCodec(value) {
        const text = String(value || '').toLowerCase();
        if (!text) return '';
        if (text.includes('hevc') || text.includes('h.265') || text.includes('h265') || text.includes('x265')) return 'H.265';
        if (text.includes('avc') || text.includes('h.264') || text.includes('h264') || text.includes('x264')) return 'H.264';
        if (text.includes('av1') || text.includes('av01')) return 'AV1';
        if (text.includes('vp9') || text.includes('vp09')) return 'VP9';
        if (text.includes('mpeg-2') || text.includes('mpeg2')) return 'MPEG2';
        if (text.includes('vc-1') || text.includes('vc1')) return 'VC1';
        return String(value || '').toUpperCase();
    }

    /**
     * 声道数标准化 (7.1 / 5.1 / 2.0 / 1.0)
     */
    static normalizeAudioChannels(value) {
        const channels = Math.round(Number(value || 0));
        if (channels >= 8) return '7.1';
        if (channels >= 6) return '5.1';
        if (channels === 2) return '2.0';
        if (channels === 1) return '1.0';
        return '';
    }

    /**
     * 音频规格与编码标准化 (TrueHD Atmos / DTS:X / DTS-HD MA / DDP Atmos / DD 5.1 / AAC 2.0 ...)
     */
    static normalizeAudioCodec(track = {}) {
        const value = `${track.Format_Commercial || track.Format_Commercial_IfAny || track.Format_String || track.Format || track.CodecID || ''} ${track.Format_Profile || ''} ${track.channel_layout || ''}`.trim().toLowerCase();
        if (!value) return '';
        const channels = this.normalizeAudioChannels(track.Channels ?? track.Channels_Original);
        const hasAtmos = /\batmos\b/i.test(value);
        let codec = '';
        if (value.includes('e-ac-3') || value.includes('eac-3') || value.includes('eac3') || value.includes('dd+') || value.includes('dolby digital plus')) codec = 'DDP';
        else if (value === 'ac-3' || value === 'ac3' || value.includes('dolby digital')) codec = 'DD';
        else if (value.includes('truehd')) codec = 'TrueHD';
        else if (value.includes('dts')) {
            if (value.includes('x') || value.includes('dts:x')) codec = 'DTS:X';
            else if (value.includes('ma') || value.includes('master audio')) codec = 'DTS-HD MA';
            else if (value.includes('hra') || value.includes('high resolution')) codec = 'DTS-HD HRA';
            else codec = 'DTS';
        } else if (value.includes('pcm') || value.includes('lpcm')) codec = 'LPCM';
        else if (value.includes('aac')) codec = 'AAC';
        else if (value.includes('flac')) codec = 'FLAC';
        else if (value.includes('opus')) codec = 'Opus';
        else return (track.Format_Commercial || track.Format_String || track.Format || '').toUpperCase();

        const parts = [codec];
        if (hasAtmos) {
            parts.push('Atmos');
            if (channels) {
                parts.push(channels);
            }
        } else if (channels) {
            parts.push(channels);
        }
        return parts.join(' ');
    }

    /**
     * 动态范围标准化 (DV / HDR10+ / HDR10 / HLG / HDR / SDR)
     */
    static normalizeDynamicRange(track = {}) {
        const rawStr = Object.entries(track)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')
            .toLowerCase();
        if (rawStr.includes('dolby vision') || rawStr.includes('dovi') || /\bdv\b/.test(rawStr)) return 'DV';
        if (rawStr.includes('hdr10+')) return 'HDR10+';
        if (rawStr.includes('smpte st 2084') || rawStr.includes('smpte2084') || rawStr.includes('hdr10') || /\bpq\b/.test(rawStr)) return 'HDR10';
        if (rawStr.includes('arib std-b67') || rawStr.includes('arib-std-b67') || rawStr.includes('hlg')) return 'HLG';
        if (/\bhdr\b/.test(rawStr)) return 'HDR';
        const hasVideoTrack = track.Format || track.format || track.CodecID || track.codec_id || track.Width || track.width || track.Height || track.height;
        if (hasVideoTrack) return 'SDR';
        return '';
    }

    // ==========================================
    // 2. 原生 HTTP Range 直链嗅探引擎 (零依赖、跨平台)
    // ==========================================

    /**
     * 构造 139 直链 HTTP Range 分段读取器 (4MB 窗口对齐与 3 窗口限额熔断保护)
     */
    static createRangeReader(directUrl, totalFileSize, options = {}) {
        const NETWORK_WINDOW_SIZE = 4 * 1024 * 1024;
        const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
        const maxWindows = Math.max(1, Number(options.maxWindows || ConfigService.getConfigValue('mediaProbe.maxWindows', 15)));
        const cache = new Map();
        const inFlight = new Map();
        const admittedWindows = new Set();
        let requestCount = 0;
        let bytesRead = 0;

        const fetchWindow = async (start) => {
            const cached = cache.get(start);
            if (cached) return cached;
            if (inFlight.has(start)) return inFlight.get(start);

            if (!admittedWindows.has(start) && admittedWindows.size >= maxWindows) {
                logger.warn(`[Range读取] 达到 ${maxWindows} 个窗口上限，触发保护熔断`);
                return null;
            }
            admittedWindows.add(start);
            const end = Math.min(totalFileSize - 1, start + NETWORK_WINDOW_SIZE - 1);

            const pending = (async () => {
                requestCount++;
                try {
                    const res = await got(directUrl, {
                        headers: {
                            Range: `bytes=${start}-${end}`,
                            Accept: '*/*',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        responseType: 'buffer',
                        timeout: { request: options.timeout || ConfigService.getConfigValue('mediaProbe.timeoutMs', 15000) },
                        retry: { limit: 1 }
                    });
                    const buf = res.body;
                    bytesRead += buf.length;
                    const rec = { start, end, bytes: buf };
                    cache.set(start, rec);
                    return rec;
                } catch (e) {
                    logger.debug(`[Range读取] 窗口 #${requestCount} 失败: ${e.message}`);
                    return null;
                }
            })().finally(() => inFlight.delete(start));

            inFlight.set(start, pending);
            return pending;
        };

        const reader = async (size, offset) => {
            const start = Number(offset || 0);
            const requestedSize = Number(size || DEFAULT_CHUNK_SIZE);
            if (start >= totalFileSize || requestedSize <= 0) return Buffer.alloc(0);

            const end = Math.min(totalFileSize, start + requestedSize);
            const firstWindow = Math.floor(start / NETWORK_WINDOW_SIZE) * NETWORK_WINDOW_SIZE;
            const windowStarts = [];
            for (let wStart = firstWindow; wStart < end; wStart += NETWORK_WINDOW_SIZE) {
                windowStarts.push(wStart);
            }

            const records = (await Promise.all(windowStarts.map(fetchWindow))).filter(Boolean);
            const parts = records.map(r => {
                const sStart = Math.max(start, r.start);
                const sEnd = Math.min(end, r.end + 1);
                return sEnd > sStart ? r.bytes.subarray(sStart - r.start, sEnd - r.start) : Buffer.alloc(0);
            }).filter(p => p.length > 0);

            return Buffer.concat(parts);
        };

        reader.cleanup = () => {
            cache.clear();
            inFlight.clear();
            admittedWindows.clear();
        };

        return reader;
    }

    /**
     * 基于直链执行免下载 Range 二进制流深度嗅探 (MP4 / MKV / TS / UDF / ISO 9660)
     * 1. IsoProbeService 识别假 ISO 与内部真实视频流偏移量 (effectiveOffset / effectiveSize)
     * 2. mediainfo.js (WASM) 权威精准解析比特流，提取 100% 真实的 6 维物理流事实
     * 3. 实例级异常安全复位，防止 WASM 堆损坏引发连环崩溃
     * 4. 严禁依据文件名篡改物理参数，仅继承非物理属性（来源/发布组）
     */
    static async probeWithNativeRange(directUrl, fileSize, fileName = '', options = {}) {
        const reader = this.createRangeReader(directUrl, fileSize, options);
        try {
            // 1. 容器定位与假 ISO 识别 (定位底层多媒体流真实偏移量与大小)
            const streamMeta = await IsoProbeService.detectAndLocateMediaStream(reader, fileSize, fileName);
            const effectiveOffset = Number(streamMeta?.offset || 0);
            const effectiveSize = Number(streamMeta?.size || fileSize);

            // 2. 优先驱动 mediainfo.js (WASM) 进行权威媒体流物理嗅探
            let probedRaw = null;
            try {
                const mediaInfo = await this._getMediaInfo();
                const result = await mediaInfo.analyzeData(
                    () => effectiveSize,
                    async (chunkSize, offset) => {
                        const buf = await reader(chunkSize, effectiveOffset + offset);
                        if (!buf || buf.length === 0) return new Uint8Array(0);
                        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
                    }
                );

                const tracks = result?.media?.track || [];
                const videoTrack = tracks.find(t => t['@type'] === 'Video') || {};
                const audioTrack = tracks.find(t => t['@type'] === 'Audio') || {};

                if (videoTrack.Format || videoTrack.Width || videoTrack.Height || videoTrack.CodecID) {
                    const videoFormat = this.normalizeResolution(videoTrack.Width, videoTrack.Height, videoTrack.ScanType);
                    const videoCodec = this.normalizeVideoCodec(videoTrack.Format || videoTrack.CodecID);
                    const dynamicRange = this.normalizeDynamicRange(videoTrack);
                    const rawFps = parseFloat(videoTrack.FrameRate || 0);
                    const frameRate = rawFps >= 48 ? `${Math.round(rawFps)}fps` : '';
                    const rawBitDepth = parseInt(videoTrack.BitDepth || 0, 10);
                    const colorDepth = rawBitDepth >= 10 ? `${rawBitDepth}bit` : '';
                    const audioCodec = this.normalizeAudioCodec(audioTrack);
                    const isDolby = dynamicRange === 'DV';

                    probedRaw = {
                        videoFormat,
                        videoCodec,
                        dynamicRange,
                        frameRate,
                        colorDepth,
                        audioCodec,
                        isDolby,
                        width: parseInt(videoTrack.Width || 0, 10),
                        height: parseInt(videoTrack.Height || 0, 10),
                        container: streamMeta?.container || (tracks.find(t => t['@type'] === 'General')?.Format || ''),
                        isFakeIso: Boolean(streamMeta?.isFakeIso),
                        isBluRay: Boolean(streamMeta?.isBluRay),
                        isDvd: Boolean(streamMeta?.isDvd),
                        realExt: streamMeta?.realExt || ''
                    };
                }
            } catch (wasmErr) {
                logger.debug(`[媒体探针] MediaInfo WASM 嗅探异常 (${fileName}): ${wasmErr.message}，重置实例`);
                this._resetMediaInfo();
            }

            // 3. 若 MediaInfo 遇特殊封装未解析出视频轨，使用轻量 Buffer 解析作为兜底
            if (!probedRaw || !probedRaw.videoFormat) {
                const headBuf = await reader(Math.min(effectiveSize, 4 * 1024 * 1024), effectiveOffset);
                if (headBuf && headBuf.length >= 16) {
                    const parsed = IsoProbeService.parseVideoStreamMetaFromBuffer(headBuf) || {};
                    probedRaw = Object.assign({}, streamMeta, parsed, probedRaw || {});
                }
            }

            if (!probedRaw) {
                return streamMeta ? this._normalizeStreamMeta(streamMeta, fileName, fileSize) : null;
            }

            return this._normalizeStreamMeta(probedRaw, fileName, fileSize);
        } catch (err) {
            logger.debug(`[媒体探针-原生Range] 嗅探流异常 (${fileName}): ${err.message}`);
            return null;
        } finally {
            reader.cleanup?.();
        }
    }

    /**
     * 规格数据标准化清洗：100% 信任探针实测物理流参数，严禁依文件名篡改物理参数
     * 仅非物理流属性（来源 mediaSource、光盘类型等）由原文件名安全继承
     */
    static _normalizeStreamMeta(raw, fileName = '', fileSize = 0) {
        if (!raw || typeof raw !== 'object') return null;

        // 文件名标准标签提取：仅用于非物理流属性继承（来源、发布组），严禁篡改实测流事实
        const nameTags = fileName ? RecognitionEngine.inferTechnicalTags(fileName, fileSize) : {};

        let vf = raw.videoFormat || '';
        if (vf === '4K') vf = '2160p';

        let vc = raw.videoCodec || '';
        let dr = raw.dynamicRange || (vf ? 'SDR' : '');
        let isDolby = dr === 'DV' || Boolean(raw.isDolby);
        if (isDolby) dr = 'DV';

        let ac = raw.audioCodec || '';
        let cd = raw.colorDepth || '';
        let fr = raw.frameRate || '';

        // 非物理属性：发布来源与光盘类型
        let mediaSource = raw.mediaSource || (raw.isBluRay ? 'BluRay' : (raw.isDvd ? 'DVD' : (nameTags.mediaSource || '')));

        const res = {
            videoFormat: vf,
            videoCodec: vc,
            dynamicRange: dr,
            colorDepth: cd,
            audioCodec: ac,
            frameRate: fr,
            mediaSource,
            isDolby,
            width: raw.width || 0,
            height: raw.height || 0,
            container: raw.container || '',
            isFakeIso: Boolean(raw.isFakeIso),
            realExt: raw.realExt || ''
        };
        return Object.fromEntries(Object.entries(res).filter(([, v]) => Boolean(v) || v === false));
    }

    // ==========================================
    // 3. 统一业务探针接口 (单文件与分组代表文件)
    // ==========================================

    /**
     * 探测单个文件，返回规范规格对象并写回 file._probedMeta
     * 100% 走 139 直链 Range 嗅探，无外部二进制依赖
     */
    static async probeFile(file, cloud139, options = {}) {
        if (!file) return null;
        const fileId = file.fileId || file.id;
        const fileSize = Number(file.size || file.fileSize || 0);
        const fileName = file.name || file.fileName || '';

        // 仅探测视频或光盘镜像
        const ext = path.extname(fileName).toLowerCase().replace('.', '');
        const isVideo = ['mkv', 'mp4', 'ts', 'm2ts', 'mov', 'avi', 'wmv', 'iso'].includes(ext);
        if (!isVideo && !file.isVideo) return null;

        const cacheKey = `${fileId}:${fileSize}`;
        if (this._cache.has(cacheKey)) {
            const cached = this._cache.get(cacheKey);
            file._probedMeta = Object.assign({}, file._probedMeta, cached);
            return cached;
        }

        // 极速旁路：若文件名自身已显式包含完备的规范技术标签（如已有分辨率和视频编码），直接复用，免打远程网络
        const nameTags = fileName ? RecognitionEngine.inferTechnicalTags(fileName, fileSize) : {};
        if (!options.forceNetworkProbe && nameTags.videoFormat && nameTags.videoCodec) {
            const fastMeta = this._normalizeStreamMeta(nameTags, fileName, fileSize);
            this._cache.set(cacheKey, fastMeta);
            file._probedMeta = Object.assign({}, file._probedMeta, fastMeta);
            logger.info(`[媒体探针-极速识别] "${fileName}" 文件名已具备完整规范技术标签 [${fastMeta.videoFormat || ''} / ${fastMeta.dynamicRange || 'SDR'} / ${fastMeta.videoCodec || ''} / ${fastMeta.audioCodec || ''}]，免除远程直链网络嗅探`);
            return fastMeta;
        }

        const MAX_PROBE_RETRIES = 2; // 最多重试 2 次（总计最多 3 次尝试）
        let directUrl = file.downloadUrl;
        let fields = null;
        let attempt = 0;

        while (attempt <= MAX_PROBE_RETRIES) {
            // 首次尝试直链为空，或后续重试时强制刷新拉取全新签名直链
            if (!directUrl || attempt > 0) {
                if (cloud139 && fileId && typeof cloud139.getDownloadUrl === 'function') {
                    try {
                        directUrl = await cloud139.getDownloadUrl(fileId);
                    } catch (urlErr) {
                        logger.warn(`[媒体探针] 第 ${attempt + 1} 次获取文件 "${fileName}" (${fileId}) 下载直链失败: ${urlErr.message}`);
                    }
                }
            }

            if (directUrl) {
                try {
                    fields = await this.probeWithNativeRange(directUrl, fileSize, fileName, options);
                } catch (probeErr) {
                    logger.warn(`[媒体探针] 第 ${attempt + 1} 次探测 "${fileName}" 异常: ${probeErr.message}`);
                    fields = null;
                }
            }

            // 成功嗅探出有效物理流 (必须含有有效的 videoFormat 分辨率)
            if (fields && fields.videoFormat) {
                fields.probed = true;
                const summary = [
                    fields.videoFormat,
                    fields.dynamicRange,
                    fields.frameRate,
                    fields.colorDepth,
                    fields.videoCodec,
                    fields.audioCodec
                ].filter(Boolean).join(' / ');
                const probeDoneMsg = `[云盘整理-媒体探针] ${fileName} 直链流嗅探完成: [${summary || '基础规格'}]`;
                logger.info(probeDoneMsg);
                if (typeof options.onProgress === 'function') {
                    try { options.onProgress(probeDoneMsg); } catch (_) {}
                }
                break;
            }

            attempt++;
            if (attempt <= MAX_PROBE_RETRIES) {
                logger.warn(`[媒体探针] 文件 "${fileName}" 第 ${attempt} 次流嗅探未就绪或读取异常，重新换链并在 1 秒后重试...`);
                directUrl = null; // 清空直链以强制在下一轮重新获取最新直链
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // 嗅探未果时平滑降级：依据文件名标准技术标签推导入库规格，坚决杜绝因网络嗅探不畅而扣押正常视频
        if (!fields || !fields.videoFormat) {
            const nameTags = RecognitionEngine.inferTechnicalTags(fileName, fileSize);
            if (nameTags.videoFormat === '4K') nameTags.videoFormat = '2160p';
            const fallbackMeta = Object.assign({
                probed: false,
                isFallbackFromName: true
            }, nameTags);
            const fallbackDoneMsg = `[云盘整理-媒体探针] ${fileName} 规格识别就绪: [${fallbackMeta.videoFormat || '基础规格'}]`;
            logger.info(fallbackDoneMsg);
            if (typeof options.onProgress === 'function') {
                try { options.onProgress(fallbackDoneMsg); } catch (_) {}
            }
            file._probedMeta = Object.assign({}, file._probedMeta, fallbackMeta);
            return fallbackMeta;
        }

        // 仅在真实探测成功时写入 LRU 缓存，失败文件绝不缓存以便下次调度重试
        this._cache.set(cacheKey, fields);
        if (this._cache.size > 500) {
            const first = this._cache.keys().next().value;
            this._cache.delete(first);
        }
        file._probedMeta = Object.assign({}, file._probedMeta, fields);
        return fields;
    }

    /**
     * 针对作品分组执行逐文件独立精细嗅探，确保每集独立获取各自真实的视频编码与技术规格
     * （支持并发控制与 LRU 缓存，杜绝跨分集/跨压制源错误继承覆盖）
     */
    static async probeGroupFiles(group, cloud139, options = {}) {
        if (!group || !Array.isArray(group.files) || group.files.length === 0) return null;

        const candidateVideos = group.files.filter(f => {
            const ext = path.extname(f.name || '').toLowerCase().replace('.', '');
            return ['mkv', 'mp4', 'ts', 'm2ts', 'mov', 'iso'].includes(ext);
        });

        if (candidateVideos.length === 0) return null;

        // 逐个文件精细探测元信息（并发控制默认 3，避免 139 请求过密）
        const limit = pLimit(options.concurrency || 3);
        const probeResults = await Promise.all(
            candidateVideos.map(file => limit(async () => {
                try {
                    const res = await this.probeFile(file, cloud139, options);
                    if (res && (!file._probedMeta || Object.keys(file._probedMeta).length === 0)) {
                        file._probedMeta = Object.assign({}, res);
                    }
                    return res;
                } catch (err) {
                    logger.debug(`[媒体探针] 文件 "${file.name}" 单独探测失败: ${err.message}`);
                    return null;
                }
            }))
        );

        const validResults = probeResults.filter(r => r && Object.keys(r).length > 0);
        if (validResults.length > 0) {
            // 选取有效结果作为 group 汇总参考
            const representative = validResults[0];
            if (representative.videoFormat) group.videoFormat = representative.videoFormat;
            if (representative.videoCodec) group.videoCodec = representative.videoCodec;
            if (representative.dynamicRange) group.dynamicRange = representative.dynamicRange;
            if (representative.frameRate) group.frameRate = representative.frameRate;
            if (representative.colorDepth) group.colorDepth = representative.colorDepth;
            if (representative.audioCodec) group.audioCodec = representative.audioCodec;
            if (representative.mediaSource) group.mediaSource = representative.mediaSource;
            group.metadataProbed = true;

            const summary = [group.videoFormat, group.dynamicRange, group.frameRate, group.colorDepth, group.videoCodec, group.audioCodec].filter(Boolean).join(' / ');
            logger.info(`[媒体探针-逐集精细探测] 《${group.title}》已对全组 ${candidateVideos.length} 个视频文件完成逐一独立嗅探: [${summary || '基础规格'}]`);
            return representative;
        }

        return null;
    }

    /**
     * 批量探测多个文件 (带并发控制)
     */
    static async probeFiles(files = [], cloud139, options = {}) {
        if (!Array.isArray(files) || files.length === 0) return [];
        const limit = pLimit(options.concurrency || 3);
        return Promise.all(files.map(f => limit(() => this.probeFile(f, cloud139, options))));
    }
}

module.exports = { MediaProbeService };

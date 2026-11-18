const got = require('got');
const logger = require('../utils/logger');

class IsoProbeService {
    /**
     * 探测与定位镜像文件内部媒体流（UDF 2.50 蓝光 / ISO 9660 DVD / 假 ISO 伪装识别）
     * 保持与底层 I/O 解耦，通过注入 reader(size, offset) 读取指定字节区间
     *
     * @param {Function} reader - (size, offset) => Promise<Buffer>
     * @param {number} totalFileSize - 文件总大小
     * @param {string} fileName - 原始文件名
     * @returns {Promise<object|null>} 探测结果
     */
    static async detectAndLocateMediaStream(reader, totalFileSize, fileName = '') {
        try {
            const initialSize = Math.min(totalFileSize, 4 * 1024 * 1024);
            const headBytes = await reader(initialSize, 0);
            if (!headBytes || headBytes.length < 4) return null;

            const isIsoExt = /\.iso$/i.test(fileName);
            const view = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
            const streamMeta = IsoProbeService.parseVideoStreamMetaFromBuffer(headBytes) || {};

            // 1. 检查是否为「假 ISO」（实际为 MKV / MP4 / TS 等视频文件更名防和谐）
            // Matroska (MKV) EBML Magic: 1A 45 DF A3
            if (headBytes.length >= 4 && headBytes[0] === 0x1a && headBytes[1] === 0x45 && headBytes[2] === 0xdf && headBytes[3] === 0xa3) {
                logger.debug('[媒体探针] 检测到二进制签名 1A 45 DF A3，实为 MKV 封装 (假 ISO 探针识别命中)');
                return { isFakeIso: isIsoExt, container: 'Matroska', realExt: '.mkv', offset: 0, size: totalFileSize, ...streamMeta };
            }
            // MP4 / QuickTime: [4..7] === 'ftyp'
            if (headBytes.length >= 8 && headBytes[4] === 0x66 && headBytes[5] === 0x74 && headBytes[6] === 0x79 && headBytes[7] === 0x70) {
                logger.debug('[媒体探针] 检测到二进制签名 ftyp，实为 MP4 封装 (假 ISO 探针识别命中)');
                return { isFakeIso: isIsoExt, container: 'MPEG-4', realExt: '.mp4', offset: 0, size: totalFileSize, ...streamMeta };
            }
            // MPEG-TS 直接分段: 0x47, 0x47 at 188
            if (headBytes.length >= 189 && headBytes[0] === 0x47 && headBytes[188] === 0x47) {
                logger.debug('[媒体探针] 检测到二进制签名 0x47 TS Sync，实为 TS 流封装');
                return { isFakeIso: isIsoExt, container: 'MPEG-TS', realExt: '.ts', offset: 0, size: totalFileSize, ...streamMeta };
            }

            // 若非 ISO 后缀，直接作为常规媒体流返回
            if (!isIsoExt) {
                return { isFakeIso: false, container: 'Direct', offset: 0, size: totalFileSize, ...streamMeta };
            }

            // 2. 真实光盘镜像探测 (UDF 2.50 Blu-ray 或 ISO 9660 DVD 原盘)
            const sectorSize = 2048;

            // --- A. 探测 UDF (Blu-ray ISO 原盘) ---
            const avdpOffset = 256 * sectorSize; // Sector 256 (524288)
            if (headBytes.length >= avdpOffset + 512 && view.getUint16(avdpOffset, true) === 2) {
                const mvdsSector = view.getUint32(avdpOffset + 20, true);
                const mvdsOffset = mvdsSector * sectorSize;
                let partitionStart = 288;
                let metaPartitionStart = 320;

                for (let off = mvdsOffset; off < Math.min(headBytes.length - 512, mvdsOffset + 32 * sectorSize); off += sectorSize) {
                    const tag = view.getUint16(off, true);
                    if (tag === 5) { // Partition Descriptor
                        partitionStart = view.getUint32(off + 188, true);
                    } else if (tag === 6) { // LVD
                        const numPartMaps = view.getUint32(off + 264, true);
                        let pmOff = off + 440;
                        for (let p = 0; p < Math.min(numPartMaps, 10); p++) {
                            const pmType = headBytes[pmOff];
                            const pmLen = headBytes[pmOff + 1];
                            if (pmType === 2 && pmLen >= 64) {
                                const metaFileLoc = view.getUint32(pmOff + 40, true);
                                const metaFileOffset = (partitionStart + metaFileLoc) * sectorSize;
                                if (metaFileOffset + 224 <= headBytes.length) {
                                    const isExt = view.getUint16(metaFileOffset, true) === 266;
                                    const lEa = view.getUint32(metaFileOffset + (isExt ? 208 : 168), true);
                                    const adOff = metaFileOffset + (isExt ? 216 : 176) + lEa;
                                    if (adOff + 8 <= headBytes.length) {
                                        const adPos = view.getUint32(adOff + 4, true);
                                        metaPartitionStart = partitionStart + adPos;
                                    }
                                }
                                break;
                            }
                            if (pmLen <= 0) break;
                            pmOff += pmLen;
                        }
                    }
                }

                let bestStream = null;
                for (let i = 0; i < headBytes.length - 64; i += 4) {
                    if (view.getUint16(i, true) === 257) { // FID
                        const lFi = headBytes[i + 19];
                        const lIu = view.getUint16(i + 36, true);
                        const nameOffset = i + 38 + lIu;
                        if (lFi > 0 && nameOffset + lFi <= headBytes.length) {
                            let name = '';
                            const compId = headBytes[nameOffset];
                            if (compId === 8) {
                                for (let c = 1; c < lFi; c++) name += String.fromCharCode(headBytes[nameOffset + c]);
                            } else if (compId === 16) {
                                for (let c = 1; c < lFi; c += 2) name += String.fromCharCode((headBytes[nameOffset + c] << 8) | headBytes[nameOffset + c + 1]);
                            }

                            if (/\.m2ts$/i.test(name)) {
                                const icbSector = view.getUint32(i + 24, true);
                                const partRef = view.getUint16(i + 28, true);
                                const feSector = (partRef === 1 ? metaPartitionStart : partitionStart) + icbSector;
                                const feOffset = feSector * sectorSize;

                                let feBytes = null;
                                if (feOffset + 512 <= headBytes.length) {
                                    feBytes = headBytes.subarray(feOffset, feOffset + 512);
                                } else {
                                    feBytes = await reader(512, feOffset);
                                }

                                if (feBytes && feBytes.length >= 256) {
                                    const feView = new DataView(feBytes.buffer, feBytes.byteOffset, feBytes.byteLength);
                                    const tagId = feView.getUint16(0, true);
                                    if (tagId === 261 || tagId === 266) {
                                        const isExt = tagId === 266;
                                        const infoLen = Number(feView.getBigUint64(isExt ? 72 : 56, true));
                                        const lEa = feView.getUint32(isExt ? 208 : 168, true);
                                        const adOff = (isExt ? 216 : 176) + lEa;
                                        if (adOff + 8 <= feBytes.length) {
                                            const extentLen = feView.getUint32(adOff, true);
                                            const dataPos = feView.getUint32(adOff + 4, true);
                                            const streamOffset = (partitionStart + dataPos) * sectorSize;
                                            const rankSize = Math.max(infoLen, extentLen);
                                            if (rankSize > (bestStream?.rankSize || 0)) {
                                                bestStream = {
                                                    isFakeIso: false,
                                                    isBluRay: true,
                                                    type: 'm2ts',
                                                    name,
                                                    offset: streamOffset,
                                                    size: rankSize,
                                                    rankSize
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if (bestStream) {
                    const MIN_BLURAY_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 物理蓝光 BD-25 最小有效容量门槛 (10GB)
                    const isPhysicalBluRay = (totalFileSize >= MIN_BLURAY_SIZE_BYTES);
                    bestStream.isBluRay = isPhysicalBluRay;
                    bestStream.isFakeDisc = !isPhysicalBluRay;
                    if (!isPhysicalBluRay) {
                        const sizeGb = (totalFileSize / (1024 * 1024 * 1024)).toFixed(2);
                        logger.info(`[媒体探针] UDF 2.50 虽含 M2TS 结构，但容量仅 ${sizeGb}GB (远低于物理蓝光 BD-25 门槛 10GB)，判定为防封打包假原盘，禁止虚标 BluRay`);
                    } else {
                        logger.debug(`[媒体探针] UDF 2.50 成功定位真蓝光原盘主流: ${bestStream.name}, 偏移量: ${bestStream.offset}`);
                    }
                    return bestStream;
                }
            }

            // --- B. 探测 ISO 9660 (DVD ISO 原盘) ---
            const pvdOffset = 16 * sectorSize; // Sector 16 (32768)
            if (headBytes.length >= pvdOffset + 2048 && headBytes[pvdOffset] === 1 &&
                headBytes[pvdOffset + 1] === 67 && headBytes[pvdOffset + 2] === 68 && headBytes[pvdOffset + 3] === 48 &&
                headBytes[pvdOffset + 4] === 48 && headBytes[pvdOffset + 5] === 49) {

                const rootDirSector = view.getUint32(pvdOffset + 156 + 2, true);
                const rootDirLen = view.getUint32(pvdOffset + 156 + 10, true);
                const rootBytes = await reader(rootDirLen, rootDirSector * sectorSize);
                if (rootBytes) {
                    let videoTsSector = 0, videoTsLen = 0, ptr = 0;
                    while (ptr < rootBytes.length) {
                        const len = rootBytes[ptr];
                        if (len === 0) { ptr = Math.floor(ptr / sectorSize + 1) * sectorSize; continue; }
                        const nameLen = rootBytes[ptr + 32];
                        let name = '';
                        for (let c = 0; c < nameLen; c++) name += String.fromCharCode(rootBytes[ptr + 33 + c]);
                        if (name === 'VIDEO_TS') {
                            const rView = new DataView(rootBytes.buffer, rootBytes.byteOffset, rootBytes.byteLength);
                            videoTsSector = rView.getUint32(ptr + 2, true);
                            videoTsLen = rView.getUint32(ptr + 10, true);
                            break;
                        }
                        ptr += len;
                    }

                    if (videoTsSector > 0 && videoTsLen > 0) {
                        const vtsBytes = await reader(videoTsLen, videoTsSector * sectorSize);
                        if (vtsBytes) {
                            let bestVob = null;
                            ptr = 0;
                            const vView = new DataView(vtsBytes.buffer, vtsBytes.byteOffset, vtsBytes.byteLength);
                            while (ptr < vtsBytes.length) {
                                const len = vtsBytes[ptr];
                                if (len === 0) { ptr = Math.floor(ptr / sectorSize + 1) * sectorSize; continue; }
                                const nameLen = vtsBytes[ptr + 32];
                                let name = '';
                                for (let c = 0; c < nameLen; c++) name += String.fromCharCode(vtsBytes[ptr + 33 + c]);
                                if (/\.VOB$/i.test(name)) {
                                    const vobSector = vView.getUint32(ptr + 2, true);
                                    const vobLen = vView.getUint32(ptr + 10, true);
                                    if (vobLen > (bestVob?.size || 0)) {
                                        bestVob = {
                                            isFakeIso: false,
                                            isDvd: true,
                                            type: 'vob',
                                            name,
                                            offset: vobSector * sectorSize,
                                            size: vobLen
                                        };
                                    }
                                }
                                ptr += len;
                            }
                            if (bestVob) {
                                const MIN_DVD_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB (标准 DVD-5 / DVD-9 物理最小门槛)
                                const isPhysicalDvd = (totalFileSize >= MIN_DVD_SIZE_BYTES);
                                bestVob.isDvd = isPhysicalDvd;
                                bestVob.isFakeDisc = !isPhysicalDvd;
                                if (!isPhysicalDvd) {
                                    const sizeGb = (totalFileSize / (1024 * 1024 * 1024)).toFixed(2);
                                    logger.info(`[媒体探针] ISO 9660 虽含 VOB 结构，但容量仅 ${sizeGb}GB (远低于标准 DVD 门槛 1GB)，判定为假原盘`);
                                } else {
                                    logger.debug(`[媒体探针] ISO 9660 成功定位 DVD 原盘主流: ${bestVob.name}, 偏移量: ${bestVob.offset}`);
                                }
                                return bestVob;
                            }
                        }
                    }
                }
            }

            return { isFakeIso: false, container: 'ISO-Unknown', offset: 0, size: totalFileSize };
        } catch (error) {
            logger.warn(`[媒体探针] 镜像读取或流定位失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 从前导二进制 Buffer 中快速嗅探视频流的分辨率规格与编码
     * @param {Buffer} buf 
     * @returns {{ videoFormat?: string, videoCodec?: string, dynamicRange?: string, width?: number, height?: number }|null}
     */
    static parseVideoStreamMetaFromBuffer(buf) {
        if (!buf || buf.length < 16) return null;

        let width = 0;
        let height = 0;
        let videoCodec = '';
        let dynamicRange = 'SDR';

        // 1. MP4 / MOV / M4V 容器解析
        const tkhdIdx = buf.indexOf(Buffer.from('tkhd'));
        if (tkhdIdx !== -1 && tkhdIdx + 84 <= buf.length) {
            const version = buf[tkhdIdx + 4];
            const wOff = tkhdIdx + (version === 1 ? 88 : 76);
            const hOff = tkhdIdx + (version === 1 ? 92 : 80);
            if (hOff + 4 <= buf.length) {
                width = buf.readUInt32BE(wOff) >> 16;
                height = buf.readUInt32BE(hOff) >> 16;
            }
        }
        if (buf.includes(Buffer.from('hvc1')) || buf.includes(Buffer.from('hev1'))) {
            videoCodec = 'H.265';
        } else if (buf.includes(Buffer.from('avc1')) || buf.includes(Buffer.from('avc3'))) {
            videoCodec = 'H.264';
        } else if (buf.includes(Buffer.from('av01'))) {
            videoCodec = 'AV1';
        } else if (buf.includes(Buffer.from('vp09'))) {
            videoCodec = 'VP9';
        }

        // 2. MKV / WebM 容器解析
        if (buf.includes(Buffer.from('V_MPEGH/ISO/HEVC'))) {
            videoCodec = 'H.265';
        } else if (buf.includes(Buffer.from('V_MPEG4/ISO/AVC'))) {
            videoCodec = 'H.264';
        } else if (buf.includes(Buffer.from('V_AV1'))) {
            videoCodec = 'AV1';
        } else if (buf.includes(Buffer.from('V_VP9'))) {
            videoCodec = 'VP9';
        }

        // 3. TS / M2TS / 裸流 NAL 单元特征嗅探
        if (!videoCodec) {
            if (buf.includes(Buffer.from([0x00, 0x00, 0x01, 0x42])) || buf.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42])) ||
                buf.includes(Buffer.from([0x00, 0x00, 0x01, 0x40])) || buf.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x40])) ||
                buf.includes(Buffer.from([0x00, 0x00, 0x01, 0x4E])) || buf.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x4E]))) {
                videoCodec = 'H.265';
            } else if (buf.includes(Buffer.from([0x00, 0x00, 0x01, 0x67])) || buf.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]))) {
                videoCodec = 'H.264';
            }
        }

        // 4. 杜比视界 / HDR 特征标志嗅探
        if (buf.includes(Buffer.from('dvh1')) || buf.includes(Buffer.from('dvhe')) || buf.includes(Buffer.from('DOVI'))) {
            dynamicRange = 'DV';
        }

        let videoFormat = '';
        if (width >= 3800 || height >= 2100) videoFormat = '2160p';
        else if (width >= 1900 || height >= 1000) videoFormat = '1080p';
        else if (width >= 1200 || height >= 700) videoFormat = '720p';
        else if (width >= 700 || height >= 480) videoFormat = '480p';

        if (!videoFormat && !videoCodec && (!width || !height)) return null;

        return { videoFormat, videoCodec, dynamicRange, width, height };
    }

    /**
     * 基于 139 直链构造支持 HTTP Range 分段读取的 reader
     * @param {string} directUrl - 139 文件的直链下载地址
     * @param {object} [options] - 请求选项
     * @returns {Function} (size, offset) => Promise<Buffer>
     */
    static createHttpRangeReader(directUrl, options = {}) {
        return async (size, offset = 0) => {
            if (!size || size <= 0) return Buffer.alloc(0);
            const rangeEnd = offset + size - 1;
            const headers = {
                ...(options.headers || {}),
                Range: `bytes=${offset}-${rangeEnd}`
            };
            const res = await got(directUrl, {
                headers,
                responseType: 'buffer',
                timeout: { request: 15000 },
                retry: { limit: 2 }
            });
            return res.body;
        };
    }
}

module.exports = { IsoProbeService };

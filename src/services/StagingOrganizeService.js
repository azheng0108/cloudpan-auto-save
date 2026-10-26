const { AppDataSource } = require('../database');
const { Account } = require('../entities');
const { Cloud139Service } = require('./cloud139');
const { TMDBService } = require('./tmdb');
const { RecognitionEngine } = require('./RecognitionEngine');
const { MediaProbeService } = require('./MediaProbeService');
const { TmdbOrganizeService } = require('./TmdbOrganizeService');
const { OrganizeProtectionService } = require('./OrganizeProtectionService');
const { CloudMaintenanceService } = require('./CloudMaintenanceService');
const { EventService } = require('./eventService');
const ConfigService = require('./ConfigService');
const { MessageUtil } = require('./message');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');

function getAccountRepository() {
    try {
        if (AppDataSource && AppDataSource.isInitialized) {
            return AppDataSource.getRepository(Account);
        }
    } catch (_) {}
    return {
        findOne: async () => null,
        find: async () => []
    };
}

/**
 * 暂存区影视规范整理与归档服务 (StagingOrganizeService)
 * 职责：负责全系统暂存区文件的多层级影视识别、TMDB匹配、WASM Range探针实测、8级画质洗版、
 *      批量移动归档至媒体库、修剪源空目录、以及向外广播 taskComplete 事件。
 * 作为全系统整理引擎的唯一核心，彻底解耦 Telegram 监控、单链任务追更与定时调度。
 */
class StagingOrganizeService {
    constructor() {
        this._isOrganizing = false;
        this._dirCache = new Map();
        this._tmdbService = null;
        this._messageUtil = new MessageUtil();
        this._initTmdb();
    }

    static getInstance() {
        if (!StagingOrganizeService._instance) {
            StagingOrganizeService._instance = new StagingOrganizeService();
        }
        return StagingOrganizeService._instance;
    }

    _initTmdb() {
        const apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        if (apiKey) {
            this._tmdbService = new TMDBService();
        } else {
            this._tmdbService = null;
        }
    }

    /**
     * 判断扩展名是否属于视频文件
     */
    isVideoFile(extension) {
        if (!extension) return false;
        const ext = String(extension).toLowerCase().replace(/^\./, '');
        const configExts = ConfigService.getConfigValue('channelMonitor.videoExtensions');
        if (Array.isArray(configExts) && configExts.length > 0) {
            return configExts.map(e => String(e).toLowerCase().replace(/^\./, '')).includes(ext);
        }
        const globalMedia = ConfigService.getConfigValue('task.mediaSuffix');
        if (globalMedia && typeof globalMedia === 'string') {
            const list = globalMedia.split(';').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
            if (list.includes(ext)) return true;
        }
        return RecognitionEngine.VIDEO_EXTENSIONS.has(ext);
    }

    /**
     * 判断是否为广告、教程、说明或废弃垃圾文件（通用领域分类，严禁特例硬编码）
     * @param {string} filename - 文件名
     * @param {string} [extension] - 扩展名
     * @param {string} [relativePath] - 相对路径（用于检测所在父级是否属于教程/说明目录）
     */
    static isAdOrPromoFile(filename, extension, relativePath = '') {
        if (!filename) return false;
        const name = String(filename).toLowerCase();
        const ext = String(extension || (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '')).toLowerCase().replace(/^\./, '');

        // 1. 可执行文件、脚本、系统包与快捷方式等在影视暂存区绝对属于废弃垃圾
        const JUNK_EXTENSIONS = new Set([
            'exe', 'bat', 'cmd', 'com', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
            'ps1', 'sh', 'bash', 'apk', 'msi', 'url', 'lnk', 'webloc', 'website'
        ]);
        if (JUNK_EXTENSIONS.has(ext)) return true;

        // 2. 教程、使用说明、引流广告、防封网址等通用语义模式
        const PROMO_OR_TUTORIAL_PATTERN = /(?:教程|使用说明|如何使用|使用方法|播放说明|播放指南|解压(?:说明|方法|密码|码)?|安装(?:说明|教程|指南)?|操作(?:指南|说明)|新手(?:必看|指南|须知)|必读|请读|readme|manual|instructions?|常见问题|免责声明|最新(?:地址|网址|发布)|防(?:走丢|封|失联)|永久地址|备用(?:地址|网址)|发布(?:页|网|频道)|官方频道|交流群|内部群|通知群|企鹅群|微信群|qq群|裙|公众号|关注|扫码|引流|福利(?:群)?|海量资源|how[-_ ]?to[-_ ]?(?:use|play|install|watch)|tutorial)/i;

        // 检查文件名是否命中教程/广告模式
        if (PROMO_OR_TUTORIAL_PATTERN.test(name)) return true;

        // 检查所在相对路径目录层级（若某层父目录属于教程/说明/广告目录，内部所有非视频文件一律归入垃圾）
        if (relativePath) {
            const rel = String(relativePath).replace(/\\/g, '/');
            const segs = rel.split('/').filter(Boolean);
            for (let i = 0; i < segs.length - 1; i++) {
                if (PROMO_OR_TUTORIAL_PATTERN.test(segs[i])) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 清理文件名中的防封干扰字符
     */
    static cleanInterferenceChars(name) {
        if (!name) return '';
        return String(name)
            .replace(/[丨|丨]/g, '')
            .replace(/[【\[](?:最新|发布|严禁|防封|备用)[^】\]]*[】\]]/gi, '')
            .trim();
    }

    /**
     * 确保网盘目录层级物理存在，返回最终叶子目录 ID
     */
    async ensureFolderPath(cloud139, folderPath, baseFolderId = '/', targetFolderName = '') {
        const normalized = '/' + String(folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (normalized === '/' || normalized === '') return baseFolderId || '/';

        const cacheKey = `${baseFolderId || '/'}::${normalized}`;
        if (this._dirCache.has(cacheKey)) {
            return this._dirCache.get(cacheKey);
        }

        let segments = normalized.split('/').filter(Boolean);
        if (segments.length > 0 && /^[A-Za-z0-9_-]{30,}$/.test(segments[0])) {
            logger.warn(`[暂存整理-路径] 路径首段识别为直接目录ID ("${segments[0]}")，自动跳过父目录探测`);
            let curr = segments[0];
            for (let i = 1; i < segments.length; i++) {
                const subName = segments[i];
                const subCacheKey = `${curr}::${subName}`;
                if (this._dirCache.has(subCacheKey)) {
                    curr = this._dirCache.get(subCacheKey);
                    continue;
                }
                let foundSubId = null;
                if (typeof cloud139.findFolderByName === 'function') {
                    foundSubId = await cloud139.findFolderByName(curr, subName).catch(() => null);
                }
                if (foundSubId) {
                    this._dirCache.set(subCacheKey, foundSubId);
                    curr = foundSubId;
                    continue;
                }
                const res = await cloud139.createFolderHcy(curr, subName).catch(err => {
                    logger.warn(`[暂存整理-建目录] 创建子目录 "${subName}" 失败: ${err.message}`);
                    return null;
                });
                if (res?.fileId) {
                    this._dirCache.set(subCacheKey, res.fileId);
                    curr = res.fileId;
                } else {
                    const matched = await this._findFolderIdByName(cloud139, curr, subName);
                    if (matched) {
                        this._dirCache.set(subCacheKey, matched);
                        curr = matched;
                    }
                }
            }
            this._dirCache.set(cacheKey, curr);
            return curr;
        }

        // 核心规范：当传入了有效的基准目录 baseFolderId（如目标媒体库目录 ID）且提供了 targetFolderName 时，
        // 若待建路径前缀包含目标基准目录自身，按相对路径剥除该前缀，避免在目标目录下重复嵌套自身（纯相对路径映射，严禁特例硬编码）
        if (baseFolderId && baseFolderId !== '/' && targetFolderName && segments.length > 0) {
            const targetNameClean = String(targetFolderName || '').replace(/^\/+|\/+$/g, '');
            const targetSegs = targetNameClean.split('/').filter(Boolean);
            if (targetSegs.length > 0 && segments.length >= targetSegs.length) {
                const prefixMatches = targetSegs.every((seg, idx) => seg.toLowerCase() === segments[idx].toLowerCase());
                if (prefixMatches) {
                    segments = segments.slice(targetSegs.length);
                }
            }
        }
        if (segments.length === 0) return baseFolderId || '/';

        let currentId = baseFolderId || '/';
        for (const seg of segments) {
            const stepKey = `${currentId}::${seg}`;
            if (this._dirCache.has(stepKey)) {
                currentId = this._dirCache.get(stepKey);
                continue;
            }
            // 核心铁律：139 API 在同名目录已存在时调用 createFolderHcy 不会报错，而是会自动追加 "_YYYYMMDD_HHMMSS" 时间戳后缀创建重复目录！
            // 因此必须【先查重，后建目录】，只有未查到时才执行创建。
            let foundSegId = null;
            if (typeof cloud139.findFolderByName === 'function') {
                foundSegId = await cloud139.findFolderByName(currentId, seg).catch(() => null);
            }
            if (foundSegId) {
                this._dirCache.set(stepKey, foundSegId);
                currentId = foundSegId;
                continue;
            }

            const res = await cloud139.createFolderHcy(currentId, seg).catch(err => {
                logger.warn(`[暂存整理-建目录] 创建目录 "${seg}" 失败: ${err.message}`);
                return null;
            });
            if (res?.fileId) {
                this._dirCache.set(stepKey, res.fileId);
                currentId = res.fileId;
            } else {
                const matched = await this._findFolderIdByName(cloud139, currentId, seg);
                if (matched) {
                    this._dirCache.set(stepKey, matched);
                    currentId = matched;
                }
            }
        }

        this._dirCache.set(cacheKey, currentId);
        return currentId;
    }

    async _findFolderIdByName(cloud139, parentId, name) {
        try {
            const list = await cloud139.listDiskDirAll(parentId);
            const found = list.find(item => item.type === 'folder' && item.name === name);
            return found?.fileId || null;
        } catch (_) {
            return null;
        }
    }

    /**
     * 递归收集暂存区目录树下的所有文件与子目录
     */
    async _collectAllStagingEntries(cloud139, rootCatalogId, initialParentName = '暂存根目录', initialTopId = '', initialTopName = '') {
        const results = [];
        const visitedDirs = new Set();

        const walk = async (folderId, parentFolderName = '', topFolderId = '', topFolderName = '', currentPath = '') => {
            if (visitedDirs.has(folderId)) return;
            visitedDirs.add(folderId);

            const items = await cloud139.listDiskDirAll(folderId).catch(() => []);
            for (const item of items) {
                const isDirectChild = (folderId === rootCatalogId);
                const curTopId = isDirectChild ? (topFolderId || (item.type === 'folder' ? item.fileId : '')) : topFolderId;
                const curTopName = isDirectChild ? (topFolderName || (item.type === 'folder' ? item.name : '')) : topFolderName;
                const relPath = currentPath ? `${currentPath}/${item.name}` : item.name;

                item.parentCatalogId = folderId;
                item.parentFolderName = parentFolderName;
                item.topCatalogId = curTopId;
                item.topFolderName = curTopName;
                item.relativePath = relPath;

                results.push(item);

                if (item.type === 'folder') {
                    await walk(item.fileId, item.name, curTopId, curTopName, relPath);
                }
            }
        };

        await walk(rootCatalogId, initialParentName, initialTopId, initialTopName, '');
        return results;
    }

    /**
     * 整理前置门禁检查
     */
    static async validateOrganizePrerequisites(options = {}) {
        const missing = [];
        const reasons = [];

        const tmdbApiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        const tmdbConfigured = Boolean(tmdbApiKey && String(tmdbApiKey).trim());
        if (!tmdbConfigured) {
            missing.push('tmdb');
            missing.push('tmdbApiKey');
            reasons.push('TMDB API 尚未配置（请在系统配置或媒体整理中配置 TMDB API Key）');
        }

        const cmConfig = ConfigService.getConfigValue('channelMonitor') || {};
        const stagingId = options.stagingFolderId || cmConfig.stagingFolderId;
        const stagingConfigured = Boolean(stagingId && String(stagingId).trim());
        if (!stagingConfigured) {
            missing.push('channelMonitorStaging');
            missing.push('stagingFolder');
            reasons.push('未配置待整理暂存目录（请在「媒体整理」中选定暂存目录）');
        }

        let channelMonitorConfigured = true;
        if (!options.skipChannelCheck) {
            if (cmConfig.enabled === false) {
                missing.push('channelMonitorDisabled');
                reasons.push('频道监控功能未开启');
                channelMonitorConfigured = false;
            }
            const channels = cmConfig.channels;
            let hasChannels = Array.isArray(channels) && channels.length > 0;
            if (!hasChannels) {
                try {
                    const repo = getChannelMonitorRepository();
                    if (repo && typeof repo.count === 'function') {
                        const count = await repo.count();
                        if (count > 0) hasChannels = true;
                    }
                } catch (_) {}
            }
            if (!hasChannels) {
                missing.push('channelMonitorChannels');
                reasons.push('未配置监控频道');
                channelMonitorConfigured = false;
            }
        }

        const targetId = options.defaultTargetFolderId || options.targetFolderId || cmConfig.defaultTargetFolderId;
        const targetFolderName = cmConfig.defaultTargetFolderName || '/媒体库';
        const targetConfigured = Boolean((targetId && String(targetId).trim()) || (targetFolderName && String(targetFolderName).trim()));

        return {
            ready: missing.length === 0,
            missing,
            reason: reasons.join('；'),
            details: {
                tmdbConfigured,
                stagingConfigured,
                targetConfigured,
                channelMonitorConfigured,
                skipChannelCheck: Boolean(options.skipChannelCheck)
            }
        };
    }

    /**
     * 立即对 139 云盘暂存区现存的所有文件执行全量影视规范整理与流式归档入库
     * 工业级流式原子闭环：即扫 -> 即探 -> 即理 -> 即移 -> 即删暂存批次
     */
    async organizeStagingFolder(options = {}) {
        if (StagingOrganizeService._isOrganizingRunning || this._isOrganizing) {
            const busyMsg = '[云盘整理-防并发重入] 当前已有正在执行的整理任务，跳过本次触发';
            logger.warn(busyMsg);
            if (!options.silentIfEmpty) {
                logTaskEvent(busyMsg);
            }
            return { scanned: 0, organized: 0, status: 'already_running', message: busyMsg };
        }
        StagingOrganizeService._isOrganizingRunning = true;
        this._isOrganizing = true;

        try {
            if (options.force) {
                OrganizeProtectionService.clearAll();
            }
            const prereq = await StagingOrganizeService.validateOrganizePrerequisites({ skipChannelCheck: true, ...options });
            if (!prereq.ready) {
                const warningMsg = `[云盘整理] 整理功能触发拦截（前置配置未完成）: ${prereq.reason}`;
                logger.warn(warningMsg);
                logTaskEvent(warningMsg);
                return {
                    scanned: 0,
                    organized: 0,
                    status: 'unconfigured',
                    missing: prereq.missing,
                    message: prereq.reason
                };
            }

            const accountRepo = getAccountRepository();
            let account = null;
            if (options.accountId) {
                account = await accountRepo.findOne({ where: { id: options.accountId } });
            }
            if (!account) {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isDefault: true } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            if (!account) {
                const errMsg = '未找到可用的 139 移动云盘账号，请先在「云盘账号」页面绑定账号';
                logTaskEvent(`[云盘整理失败] ${errMsg}`);
                logger.error(`[云盘整理] ${errMsg}`);
                throw new Error(errMsg);
            }

            const cloud139 = Cloud139Service.getInstance(account);
            this._dirCache.clear();
            const globalStagingId = options.stagingFolderId || ConfigService.getConfigValue('channelMonitor.stagingFolderId', '');
            const globalStagingName = ConfigService.getConfigValue('channelMonitor.stagingFolderName', '/暂存区/频道转存');

            let stagingFolderId = globalStagingId;
            if (!stagingFolderId || !stagingFolderId.trim()) {
                stagingFolderId = await this.ensureFolderPath(cloud139, globalStagingName);
            }

            if (!options.silentIfEmpty) {
                logTaskEvent(`[云盘整理] 开始扫描待整理目录: ${globalStagingName} (${stagingFolderId})...`);
            }
            logger.info(`[云盘整理] 开始扫描待整理目录: ${globalStagingName} (${stagingFolderId})...`);

            const allStagingEntries = await this._collectAllStagingEntries(cloud139, stagingFolderId);
            logger.info(`[云盘整理] 扫描完成，共扫描到 ${allStagingEntries.length} 个条目`);

            if (allStagingEntries.length === 0) {
                if (!options.silentIfEmpty) {
                    logTaskEvent(`[云盘整理] 待整理目录当前为空，暂无待整理文件`);
                }
                logger.info(`[云盘整理] 待整理目录当前为空，暂无待整理文件`);
                return { scanned: 0, organized: 0, details: [] };
            }

            // 1. 清理防封干扰字符
            for (const entry of allStagingEntries) {
                const cleaned = StagingOrganizeService.cleanInterferenceChars(entry.name);
                if (cleaned !== entry.name) {
                    try {
                        await cloud139.renameFile(entry.fileId, cleaned);
                        entry.name = cleaned;
                    } catch (err) {
                        logger.warn(`[云盘整理-字符清洗] 重命名失败: ${err.message}`);
                    }
                }
            }

            // 2. 垃圾与广告说明文件移入回收站
            const mediaEntries = [];
            const trashIds = [];
            for (const entry of allStagingEntries) {
                if (entry.type === 'file') {
                    if (StagingOrganizeService.isAdOrPromoFile(entry.name, entry.extension, entry.relativePath)) {
                        logger.info(`[云盘整理-垃圾过滤] 广告/说明文件移入回收站: ${entry.name}`);
                        trashIds.push(entry.fileId);
                    } else {
                        mediaEntries.push(entry);
                    }
                }
            }
            if (trashIds.length > 0) {
                await cloud139.deleteFiles(trashIds).catch(err => {
                    logger.warn(`[云盘整理-垃圾过滤] 移入回收站失败: ${err.message}`);
                });
            }

            // 3. 筛选有效视频文件
            const videoEntries = mediaEntries.filter(e => this.isVideoFile(e.name) || this.isVideoFile(e.extension) || /\.iso$/i.test(e.name));
            if (videoEntries.length === 0) {
                if (!options.silentIfEmpty) {
                    logTaskEvent('[云盘整理] 未检测到有效视频文件');
                }
                logger.info('[云盘整理] 未检测到有效视频文件');
                return { scanned: allStagingEntries.length, organized: 0, details: [] };
            }

            // 4. 聚类作品与消歧
            const classifyRegion = ConfigService.getConfigValue('channelMonitor.classifyRegion', true);
            const classifyYear = ConfigService.getConfigValue('channelMonitor.classifyYear', false);
            const classifyChildren = ConfigService.getConfigValue('channelMonitor.classifyChildren', true);
            const classifyConcerts = ConfigService.getConfigValue('channelMonitor.classifyConcerts', true);
            const enableRename = ConfigService.getConfigValue('channelMonitor.enableRename', true);
            const enableMediaInfo = ConfigService.getConfigValue('channelMonitor.enableMediaInfo', true);
            const includeEpisodeTitle = ConfigService.getConfigValue('channelMonitor.includeEpisodeTitle', true);
            const autoWash = ConfigService.getConfigValue('channelMonitor.autoWash', true);
            const keepDolbyMultiVersion = ConfigService.getConfigValue('channelMonitor.keepDolbyMultiVersion', false);
            const washPolicy = ConfigService.getConfigValue('channelMonitor.washPolicy', 'qualityFirst');

            this._initTmdb();
            const groupsMap = await TmdbOrganizeService.clusterFiles(videoEntries, {
                tmdbService: this._tmdbService,
                post: options.post,
                task: options.task,
                isBatchIsolated: options.isBatchIsolated
            });

            const readyGroups = Array.from(groupsMap.values());
            if (readyGroups.length === 0) {
                logger.info('[云盘整理] 未识别出具备有效影视属性的视频文件，暂无待整理任务');
                return { scanned: allStagingEntries.length, organized: 0, details: [] };
            }

            const targetFolderId = options.targetFolderId || ConfigService.getConfigValue('channelMonitor.defaultTargetFolderId', '/');
            const defaultTargetFolderName = options.targetFolderName || ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName', '/媒体库');
            const targetDirPath = (defaultTargetFolderName && defaultTargetFolderName !== '/') ? defaultTargetFolderName : '/媒体库';

            const previewSettings = {
                targetDirPath,
                classifyRegion,
                classifyYear,
                classifyChildren,
                classifyConcerts,
                enableRename,
                enableMediaInfo,
                includeEpisodeTitle,
                autoWash,
                keepDolbyMultiVersion,
                sourceFolders: allStagingEntries.filter(e => e.type === 'folder').map(f => {
                    const fullPath = f.relativePath || f.name || '';
                    const depth = fullPath.split('/').filter(Boolean).length;
                    return { id: f.fileId, path: fullPath, depth };
                }),
                post: options.post
            };

            // 5. 流式按作品组（Work Group）即刻归档入库 (Per-Job Streaming Pipeline: 即刮 -> 即探 -> 即理 -> 即移 -> 即删)
            const totalMovedFiles = [];
            let totalDiscarded = 0;
            let totalDeletedFolders = 0;
            let groupIdx = 0;

            for (const group of readyGroups) {
                groupIdx++;
                const gTitle = group.title || '影视作品';

                logger.info(`[云盘整理-流式归档] [${groupIdx}/${readyGroups.length}] 开始归档作品《${gTitle}》(${group.files?.length || 0} 个文件)...`);
                logTaskEvent(`[云盘整理] [${groupIdx}/${readyGroups.length}] 开始归档《${gTitle}》...`);

                // 5.1 即查/即刮：单作品在线元数据对齐 (若路径已带 tmdbId 则极速直查，否则针对本作品发起多级检索)
                if (this._tmdbService) {
                    try {
                        await TmdbOrganizeService.scrapeGroups([group], this._tmdbService, (msg) => {
                            logger.debug(`[云盘整理-TMDB] 《${gTitle}》: ${msg}`);
                        });
                    } catch (scrapeErr) {
                        logger.warn(`[云盘整理-TMDB] 《${gTitle}》在线刮削异常: ${scrapeErr.message}`);
                    }
                }

                // 5.2 即探：单作品媒体规格实测嗅探
                const shouldProbe = (options.enableMediaInfo !== false) && (enableMediaInfo !== false) && ConfigService.getConfigValue('mediaProbe.enable', true);
                if (shouldProbe) {
                    try {
                        const probed = await MediaProbeService.probeGroupFiles(group, cloud139, {
                            onProgress: (msg) => logTaskEvent(msg)
                        });
                        if (probed) {
                            const summary = [
                                probed.videoFormat,
                                probed.dynamicRange,
                                probed.frameRate,
                                probed.colorDepth,
                                probed.videoCodec,
                                probed.audioCodec
                            ].filter(Boolean).join(' / ');
                            const pMsg = `[云盘整理-媒体探针] 《${group.title}》嗅探完毕: [${summary || '基础规格'}]`;
                            logger.info(pMsg);
                            logTaskEvent(pMsg);
                        }
                    } catch (probeErr) {
                        logger.warn(`[云盘整理-媒体探针] 分组 "${group.title}" 嗅探异常: ${probeErr.message}`);
                    }
                } else {
                    for (const file of group.files) {
                        const tags = RecognitionEngine.inferTechnicalTags(file.name, file.size);
                        if (tags.videoFormat === '4K') tags.videoFormat = '2160p';
                        file._probedMeta = Object.assign({}, file._probedMeta, tags);
                    }
                }

                // 5.3 即理：单作品规划与 8 级画质洗版裁决
                // 严格隔离：仅传递属于本作品组的源目录集合，杜绝单作品流式清理时越界清理其他作品目录导致日志与逻辑污染
                const groupFolderIds = new Set();
                for (const file of group.files || []) {
                    if (file.parentCatalogId) groupFolderIds.add(file.parentCatalogId);
                    if (file.topCatalogId) groupFolderIds.add(file.topCatalogId);
                }
                const groupSourceFolders = (previewSettings.sourceFolders || []).filter(f => {
                    if (groupFolderIds.has(f.id)) return true;
                    return (group.files || []).some(file => file.relativePath && f.path && (
                        file.relativePath === f.path ||
                        file.relativePath.startsWith(f.path + '/')
                    ));
                });

                const singleGroupSnapshot = TmdbOrganizeService.buildPreview([group], {
                    ...previewSettings,
                    sourceFolders: groupSourceFolders
                });
                singleGroupSnapshot.sourceFolders = groupSourceFolders;

                const singleExecResult = await TmdbOrganizeService.execute(singleGroupSnapshot, {
                    cloud139,
                    washPolicy,
                    post: options.post,
                    ensureFolderPath: (p) => this.ensureFolderPath(cloud139, p, targetFolderId, defaultTargetFolderName)
                }, {
                    cleanEmptySources: ConfigService.getConfigValue('channelMonitor.sweepEmptyFolders', true),
                    onProgress: (done, total, msg) => {
                        logger.info(`[云盘整理] 《${gTitle}》: ${msg} (${done}/${total})`);
                        logTaskEvent(`[云盘整理] 《${gTitle}》: ${msg}`);
                    }
                });

                totalDiscarded += (singleExecResult?.discardedCount || 0);
                totalDeletedFolders += (singleExecResult?.deletedFolderCount || 0);

                const groupMovedFiles = (singleGroupSnapshot.tasks || []).filter(t => t.status === 'success').map(t => ({
                    fileId: t.fileId,
                    originalName: t.oldName,
                    finalName: t.newName,
                    targetFolderPath: t.targetFolderPath,
                    size: t.fileSize,
                    tmdbId: t.tmdbId || group?.tmdbId || '',
                    posterPath: t.posterPath || group?.posterPath || '',
                    mediaType: group?.mediaType || (t.seasonEpisode ? 'tv' : 'movie'),
                    category: group?.category || (group?.mediaType === 'tv' ? '剧集' : '电影'),
                    secondaryCategory: group?.secondaryCategory || '',
                    episodeTitle: t.episodeTitle || '',
                    seasonEpisode: t.seasonEpisode || ''
                }));

                for (const moved of groupMovedFiles) {
                    OrganizeProtectionService.markResolved(moved.fileId || moved.originalName);
                    totalMovedFiles.push(moved);
                }

                if (groupMovedFiles.length > 0) {
                    const gDoneMsg = `[云盘整理-作品入库] 《${gTitle}》已成功归档入库 (成功: ${groupMovedFiles.length}/${group.files?.length || 0} 集)`;
                    logger.info(gDoneMsg);
                    logTaskEvent(gDoneMsg);
                }

                // 5.4 支柱 2 & 支柱 3：单作品流式原子闭环与暂存批次销毁 (即扫 -> 即探 -> 即理 -> 即移 -> 即删)
                // 若该作品所属的暂存批次目录内部的视频已全部成功移出，检查并销毁该暂存批次子目录
                const batchTopCatalogId = group.batchFolderId || group.files?.[0]?.topCatalogId;
                const batchTopFolderName = group.batchFolderName || group.files?.[0]?.topFolderName;
                if (batchTopCatalogId && batchTopCatalogId !== stagingFolderId && !batchTopCatalogId.includes('/')) {
                    // 确认该批次目录下是否还有其它待处理视频组
                    const hasRemainingVideosInBatch = readyGroups.slice(groupIdx).some(otherGroup => {
                        const otherBatchId = otherGroup.batchFolderId || otherGroup.files?.[0]?.topCatalogId;
                        return otherBatchId === batchTopCatalogId;
                    });

                    if (!hasRemainingVideosInBatch) {
                        try {
                            let isDirExisted = true;
                            const remainingItems = await cloud139.listDiskDirAll(batchTopCatalogId).catch(() => {
                                isDirExisted = false;
                                return [];
                            });

                            if (isDirExisted) {
                                const nonJunkRemaining = remainingItems.filter(i => {
                                    if (i.type === 'folder') return false;
                                    return !StagingOrganizeService.isAdOrPromoFile(i.name, i.extension, i.relativePath);
                                });

                                if (nonJunkRemaining.length === 0) {
                                    logger.info(`[云盘整理-批次销毁] 批次目录《${batchTopFolderName}》已无有效媒体资产，移入回收站销毁批次目录 (${batchTopCatalogId})`);
                                    logTaskEvent(`[云盘整理] 《${batchTopFolderName}》已完成全量入库，销毁暂存批次目录`);
                                    await cloud139.deleteFiles([batchTopCatalogId]).catch(delErr => {
                                        if (!delErr?.message?.includes('04000010') && !delErr?.message?.includes('资源不存在')) {
                                            logger.warn(`[云盘整理-批次销毁] 销毁批次目录异常: ${delErr.message}`);
                                        }
                                    });
                                }
                            }
                        } catch (batchErr) {
                            logger.warn(`[云盘整理-批次销毁] 检查批次目录残留异常: ${batchErr.message}`);
                        }
                    }
                }
            }

            // 6. 修剪暂存区残留空目录
            if (ConfigService.getConfigValue('channelMonitor.sweepEmptyFolders', true)) {
                const sweepMsg = `[云盘整理-暂存区清理] 启动自底向上空目录修剪: ${globalStagingName} (${stagingFolderId})`;
                logger.info(sweepMsg);
                logTaskEvent(sweepMsg);
                const sweepRes = await CloudMaintenanceService.sweepEmptyFolders(cloud139, {
                    rootCatalogId: stagingFolderId,
                    protectedPaths: ['/媒体库', '/media', '/strm', '/公共目录', globalStagingName]
                }).catch(err => {
                    logger.warn(`[云盘整理-暂存区清理] 修剪异常: ${err.message}`);
                    return null;
                });
                if (sweepRes?.deletedFoldersCount > 0) {
                    const cleanDoneMsg = `[云盘整理-暂存区清理] 成功清理 ${sweepRes.deletedFoldersCount} 个残留空目录`;
                    logger.info(cleanDoneMsg);
                    logTaskEvent(cleanDoneMsg);
                }
            }

            // 7. 资产闭环后广播事件解耦后处理 (STRM / AList / Emby)
            const notifyOnOrganize = ConfigService.getConfigValue('channelMonitor.notifyOnOrganize', true);
            if (totalMovedFiles.length > 0) {
                if (notifyOnOrganize) {
                    const pushMsg = `[139云盘整理] 全量规范整理完成\n已归档 ${totalMovedFiles.length} 个视频文件至媒体库。\n包含作品组: ${readyGroups.length} 部。`;
                    await this._messageUtil.sendMessage(pushMsg).catch(() => {});
                }

                EventService.getInstance().emit('taskComplete', {
                    taskId: 'manual-organize',
                    taskName: `云盘全量整理 - 归档 ${totalMovedFiles.length} 部`,
                    sourceMode: 'staging_organize',
                    fileList: totalMovedFiles.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    items: totalMovedFiles.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    task: {
                        id: 'manual-organize',
                        account,
                        name: `云盘全量整理 - 归档 ${totalMovedFiles.length} 部`,
                        resourceName: '云盘全量整理',
                        realFolderName: totalMovedFiles[0]?.targetFolderPath || '',
                        disableRename: true
                    }
                });
            }

            const finishMsg = `[云盘整理] 整理完成，共成功规范归档 ${totalMovedFiles.length} 个文件至媒体库 (清理废弃/冲突: ${totalDiscarded}, 清理空目录: ${totalDeletedFolders})`;
            logTaskEvent(finishMsg);
            logger.info(finishMsg);

            return {
                scanned: allStagingEntries.length,
                organized: totalMovedFiles.length,
                details: totalMovedFiles
            };
        } finally {
            StagingOrganizeService._isOrganizingRunning = false;
            this._isOrganizing = false;
        }
    }
}

StagingOrganizeService._isOrganizingRunning = false;
StagingOrganizeService._instance = null;

module.exports = { StagingOrganizeService };

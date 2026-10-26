/**
 * TmdbOrganizeService - 139 移动云盘工业级 TMDB 刮削、多季分集校准与影视整理引擎
 * 
 * 100% 完整继承自 139云盘助手脚本 (139云盘助手-2.8.111.js, Lines 7131–9932)
 * 严禁反复造轮子与私自篡改核心计算规则！
 */

const { RecognitionEngine } = require('./RecognitionEngine');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');

const Logger = {
    info: (...args) => { logger.info(args.join(' ')); },
    warn: (...args) => { logger.warn(args.join(' ')); },
    warning: (...args) => { logger.warn(args.join(' ')); },
    error: (...args) => { logger.error(args.join(' ')); },
    debug: (...args) => { if (logger.debug) logger.debug(args.join(' ')); }
};

const _storageMap = new Map();
const localStorage = (typeof global !== 'undefined' && global.localStorage) ? global.localStorage : {
    getItem: (k) => _storageMap.get(k) || null,
    setItem: (k, v) => _storageMap.set(k, String(v)),
    removeItem: (k) => _storageMap.delete(k),
    clear: () => _storageMap.clear()
};

const UI = (typeof global !== 'undefined' && global.UI) ? global.UI : {
    showToast: (msg) => Logger.info(`[UI Toast] ${msg}`),
    renderTranslationsChipsHTML: () => ''
};

const FileService = {
    _pathCache: new Map(),
    resolvePathToId: async (folderPath, modeConfig, createIfMissing = true) => {
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (modeConfig?.ensureFolderPath && typeof modeConfig.ensureFolderPath === 'function') {
            return await modeConfig.ensureFolderPath(folderPath);
        }
        if (!cloud) return '/';
        const normalized = '/' + String(folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (normalized === '/' || normalized === '') return '/';

        if (FileService._pathCache.has(normalized)) {
            return FileService._pathCache.get(normalized);
        }

        const segments = normalized.split('/').filter(Boolean);
        let currentId = '/';
        let currentPath = '';

        for (const seg of segments) {
            currentPath += '/' + seg;
            if (FileService._pathCache.has(currentPath)) {
                currentId = FileService._pathCache.get(currentPath);
                continue;
            }

            let foundId = await cloud.findFolderByName(currentId, seg);
            if (!foundId && createIfMissing) {
                const created = await cloud.createFolderHcy(currentId, seg);
                if (!created || !created.fileId) {
                    throw new Error(`创建网盘目录失败: ${seg} (父ID: ${currentId})`);
                }
                foundId = created.fileId;
            }
            if (!foundId) throw new Error(`未找到目录节点: ${seg} (父ID: ${currentId})`);
            FileService._pathCache.set(currentPath, foundId);
            currentId = foundId;
        }

        FileService._pathCache.set(normalized, currentId);
        return currentId;
    }
};

const Context = {
    state: { isAbortRequested: false },
    settings: { tmdb: {} },
    cache: { dirMeta: {} },
    getTmdbConfig: () => ({ credential: '' }),
    getActiveEngine: () => ({}),
    clearCache: () => {
        FileService._pathCache.clear();
        Context.cache.dirMeta = {};
    }
};

const Utils = {
    escapeHTML: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatSize: (b) => {
        const bytes = Number(b || 0);
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / 1024).toFixed(0) + ' KB';
    },
    isDirectoryItem: (item) => item?.type === 'folder' || item?.fileType === 'folder' || item?.category === 'folder' || item?.isDir === true || !!item?.catalogID,
    getItemId: (item) => String(item?.fileId || item?.id || item?.catalogID || ''),
    getItemName: (item) => String(item?.name || item?.fileName || item?.catalogName || '')
};

const DriveAPI = {
    fetchDir: async (folderId, modeConfig) => {
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (!cloud) return [];
        if (typeof cloud.listDiskDirAll === 'function') {
            return await cloud.listDiskDirAll(folderId);
        }
        if (typeof cloud.listDiskDir === 'function') {
            const res = await cloud.listDiskDir(folderId);
            const catalogs = (res?.catalogList || []).map(c => ({ fileId: c.catalogID, name: c.catalogName, type: 'folder' }));
            const files = (res?.fileList || []).map(f => ({ fileId: f.fileId, name: f.fileName, size: f.fileSize, type: 'file' }));
            return [...catalogs, ...files];
        }
        return [];
    },
    batchDelete: async (fileIds, modeConfig) => {
        if (!fileIds || !fileIds.length) return null;
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (cloud && typeof cloud.deleteFiles === 'function') {
            return await cloud.deleteFiles(fileIds);
        }
        return null;
    },
    rename: async (fileId, newName, modeConfig) => {
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (cloud && typeof cloud.renameFile === 'function') {
            return await cloud.renameFile(fileId, newName);
        }
        return null;
    },
    batchMove: async (fileIds, toParentFileId, modeConfig) => {
        if (!fileIds || !fileIds.length) return null;
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (cloud && typeof cloud.batchMoveHcy === 'function') {
            return await cloud.batchMoveHcy(fileIds, toParentFileId);
        }
        return null;
    }
};

let _CloudMaintenanceService = null;
function getCloudMaintenanceService() {
    if (!_CloudMaintenanceService) {
        try {
            _CloudMaintenanceService = require('./CloudMaintenanceService');
        } catch (_) {}
    }
    return _CloudMaintenanceService;
}
try {
    _CloudMaintenanceService = require('./CloudMaintenanceService');
} catch (_) {}

let _ScrapeJournalService = null;
function getScrapeJournalService() {
    if (!_ScrapeJournalService) {
        try {
            _ScrapeJournalService = require('./ScrapeJournalService').ScrapeJournalService;
        } catch (_) {}
    }
    return _ScrapeJournalService;
}
try {
    _ScrapeJournalService = require('./ScrapeJournalService').ScrapeJournalService;
} catch (_) {}

const TaskManager = {
    sweepEmptyFolders: async (sortedFolders, modeConfig, options = {}) => {
        const cloud = modeConfig?.cloud139 || modeConfig;
        if (!cloud) return { deletedFolderCount: 0 };

        // 1. 若提供了由扫描和移动任务按深度逆序收集好的源目录列表，优先精准自底向上修剪
        if (Array.isArray(sortedFolders) && sortedFolders.length > 0) {
            const targetDirPath = ('/' + String(options.targetDirPath || '/媒体库').replace(/^\/+|\/+$/g, '')).toLowerCase();
            const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '@eadir']);
            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
            let deletedFolderCount = 0;

            for (const folder of sortedFolders) {
                if (!folder || !folder.id) continue;
                const folderId = String(folder.id);
                const normPath = ('/' + String(folder.path || '').replace(/^\/+|\/+$/g, '')).toLowerCase();

                // 严禁修剪网盘根、暂存区根目录本身、或媒体库目标目录
                if (folderId === '/' || folderId === '0' || folderId === '00019700101000000001') continue;
                if (normPath === '/' || normPath === '/暂存区' || normPath === targetDirPath || normPath.startsWith(targetDirPath + '/')) continue;

                try {
                    let items = [];
                    let dirExists = true;
                    if (typeof cloud.listDiskDirAll === 'function') {
                        try {
                            items = await cloud.listDiskDirAll(folderId, { ignoreNotFound: true });
                        } catch (listErr) {
                            if (listErr.notFound || listErr.apiCode === '04000010' || String(listErr.message || '').includes('04000010') || String(listErr.message || '').includes('资源不存在')) {
                                dirExists = false;
                            } else {
                                throw listErr;
                            }
                        }
                    } else if (typeof cloud.listDiskDir === 'function') {
                        try {
                            const res = await cloud.listDiskDir(folderId);
                            const catalogs = (res?.catalogList || []).map(c => ({ fileId: c.catalogID, type: 'folder' }));
                            const files = (res?.fileList || []).map(f => ({ fileId: f.fileId, name: f.fileName, size: f.fileSize, type: 'file' }));
                            items = [...catalogs, ...files];
                        } catch (listErr) {
                            if (listErr.notFound || listErr.apiCode === '04000010' || String(listErr.message || '').includes('04000010') || String(listErr.message || '').includes('资源不存在')) {
                                dirExists = false;
                            } else {
                                throw listErr;
                            }
                        }
                    }

                    if (!dirExists) {
                        Logger.debug(`[TMDB整理-空目录修剪] 目录在云端已不存在或已被父级删除，跳过: ${folder.path || folderId}`);
                        continue;
                    }

                    let files = (items || []).filter(i => i.type !== 'folder');
                    const subFolders = (items || []).filter(i => i.type === 'folder');

                    // 若允许清理系统垃圾，且目录中除系统垃圾与说明/广告文件外无其它文件
                    if (options.cleanJunk !== false && files.length > 0) {
                        const junkFiles = files.filter(f => {
                            const fname = (f.name || '').toLowerCase();
                            if (JUNK_NAMES.has(fname) || Number(f.size || 0) === 0) return true;
                            try {
                                const { StagingOrganizeService } = require('./StagingOrganizeService');
                                const ext = fname.includes('.') ? fname.slice(fname.lastIndexOf('.') + 1) : '';
                                return StagingOrganizeService.isAdOrPromoFile(fname, ext, folder.path ? `${folder.path}/${fname}` : fname);
                            } catch (_) {
                                return false;
                            }
                        });
                        if (junkFiles.length === files.length) {
                            const junkIds = junkFiles.map(j => j.fileId);
                            Logger.info(`[TMDB整理-空目录修剪] 发现残留系统垃圾或说明文件 (${junkFiles.map(j => j.name).join(', ')})，清理移入回收站: ${folder.path || folderId}`);
                            if (typeof cloud.deleteFiles === 'function') {
                                await cloud.deleteFiles(junkIds).catch(() => null);
                            }
                            files = [];
                        }
                    }

                    // 若目录无任何实体文件与子目录，安全将其删除
                    if (files.length === 0 && subFolders.length === 0) {
                        if (typeof cloud.deleteFiles === 'function') {
                            Logger.info(`[TMDB整理-空目录修剪] 目录已腾空，移入回收站: ${folder.path || folderId}`);
                            const ok = await cloud.deleteFiles([folderId]).catch(() => null);
                            if (ok) {
                                deletedFolderCount++;
                                Logger.info(`[TMDB整理-空目录修剪] 成功清理被搬空源目录: ${folder.path || folderId}`);
                                onProgress(`已清理空目录: ${folder.path || folderId}`);
                            }
                        }
                    } else {
                        Logger.debug(`[TMDB整理-空目录修剪] 目录保留 (非空): ${folder.path || folderId} [实体文件: ${files.length}, 子目录: ${subFolders.length}]`);
                    }
                } catch (err) {
                    Logger.warn(`[TMDB整理-空目录修剪] 检查目录 ${folder.path || folderId} 失败: ${err.message}`);
                }
            }
            return { deletedFolderCount };
        }

        // 2. 兜底回退：若未提供 sortedFolders，回退至全局 CloudMaintenanceService
        const cms = getCloudMaintenanceService();
        if (cms && typeof cms.sweepEmptyFolders === 'function') {
            const res = await cms.sweepEmptyFolders(cloud, options);
            return { deletedFolderCount: res.deletedFoldersCount || res.deletedFolderCount || 0 };
        }
        return { deletedFolderCount: 0 };
    }
};

    class TmdbOrganizeService {

        // ★ 核心智能推导：根据本地资源公历年份推断对应的 TMDB 官方季号 (SSOT)
        // 彻底解决国漫/季播剧首播年在前 (如 2021)、更新年在后 (如 2026年播出第3季)，导致错误归入 Season 01 的缺陷
        static inferSeasonFromYear(seasons, year) {
            if (!Array.isArray(seasons) || !year) return null;
            const targetY = String(year).trim();
            if (!/^(?:19|20)\d{2}$/.test(targetY)) return null;
            const validSeasons = seasons.filter(s => {
                const sNum = Number(s.season_number ?? s.seasonNumber);
                const airDate = String(s.air_date || s.airDate || '');
                return sNum > 0 && airDate.startsWith(targetY);
            });
            if (validSeasons.length === 1) {
                return Number(validSeasons[0].season_number ?? validSeasons[0].seasonNumber);
            }
            if (validSeasons.length > 1) {
                return Number(validSeasons[0].season_number ?? validSeasons[0].seasonNumber);
            }
            return null;
        }

        // ★ 核心放行门禁：判定媒体分组是否具备安全放行批量整理的资格 (SSOT)
        static isGroupReadyToOrganize(group) {
            if (!group) return false;
            const hasValidId = Boolean(group.tmdbId && String(group.tmdbId).trim() && String(group.tmdbId).trim() !== '0');
            const isNamed = Boolean(group.title && group.title !== '待识别影视' && group.title !== '未命名媒体');
            const isSafe = !group.isSuspicious;
            // ★ 集数合理性校验：单季集数若超过 200 且官方无对应分集，坚决拒绝放行
            if (group.mediaType === 'tv' && group.files) {
                const hasAbnormalEp = (group.files || []).some(f => {
                    const se = RecognitionEngine.parseSeasonEpisode(f.name, Number(group.season || 1));
                    return se.episode > 200 && (!group.officialEpisodes || !group.officialEpisodes.some(ep => (ep.episode_number ?? ep.episodeNumber) === se.episode));
                });
                if (hasAbnormalEp) return false;
            }
            return hasValidId && isNamed && isSafe;
        }

        // ★ TMDB 官方多语言译本 (Translations) 权威按需拉取与内存缓存 (SSOT)
        static async fetchTranslations(id, mediaType, tmdbClient = null) {
            if (!id) return [];
            if (!this._translationsCache) this._translationsCache = {};
            const cacheKey = `${mediaType || 'movie'}:${id}`;
            if (this._translationsCache[cacheKey]) return this._translationsCache[cacheKey];

            const path = mediaType === 'tv' ? `/tv/${id}/translations` : `/movie/${id}/translations`;
            try {
                if (!tmdbClient) {
                    try {
                        const { TMDBService } = require('./tmdb');
                        tmdbClient = new TMDBService();
                    } catch (_) {
                        const cred = Context.getTmdbConfig()?.credential || '';
                        if (cred && typeof TmdbClient !== 'undefined') tmdbClient = new TmdbClient(cred);
                    }
                }
                if (!tmdbClient) return [];
                const data = await tmdbClient.request(path, {});
                const regional = {};
                const zhTitles = [];
                for (const t of (data.translations || [])) {
                    if (t.iso_639_1 === 'zh' && (t.data?.title || t.data?.name)) {
                        const title = (t.data?.title || t.data?.name || '').trim();
                        if (title) {
                            zhTitles.push(title);
                            if (t.iso_3166_1) regional[t.iso_3166_1.toUpperCase()] = title;
                        }
                    }
                }
                const result = Array.from(new Set(zhTitles));
                result.regional = regional;
                const parts = [];
                if (regional.TW) parts.push(`台: ${regional.TW}`);
                if (regional.HK) parts.push(`港: ${regional.HK}`);
                if (regional.CN) parts.push(`陆: ${regional.CN}`);
                if (regional.SG) parts.push(`新: ${regional.SG}`);
                result.display = parts.join(' · ');
                this._translationsCache[cacheKey] = result;
                return result;
            } catch (_) {
                return [];
            }
        }
        static async scanDirectory(targetDirId, options = {}) {
            const modeConfig = options.modeConfig || Context.getActiveEngine();
            const onProgress = options.onProgress;
            const signal = options.signal;

            // 统一构造待扫描根队列，支持传入单个 ID、多个 target 描述对象或数组
            let targetsList = [];
            if (Array.isArray(targetDirId)) {
                targetsList = targetDirId;
            } else if (typeof targetDirId === 'object' && targetDirId !== null) {
                targetsList = [targetDirId];
            } else {
                targetsList = [{ id: targetDirId, path: options.path || '/', name: options.name || 'root' }];
            }

            const queue = [];
            const visitedDirs = new Set();
            const sourceFolders = new Map();

            for (const item of targetsList) {
                let tid = typeof item === 'object' ? (item.id || item.fileId) : item;
                let tpath = typeof item === 'object' ? (item.path || '/') : '/';
                let tname = typeof item === 'object' ? (item.name || 'root') : 'root';

                // 核心防线：若 ID 为 'unknown' 或为空，根据路径自动下钻解析出真实 fileId
                if (!tid || tid === 'unknown') {
                    if (tpath && tpath !== '/') {
                        try {
                            Logger.debug(`[TMDB整理] 发现待扫描目录 ID 为 unknown，自动按路径解析: ${tpath}`);
                            tid = await FileService.resolvePathToId(tpath, modeConfig, false);
                            if (tid) {
                                Context.cache.pathMap[tpath] = tid;
                            }
                        } catch (e) {
                            Logger.warn(`[TMDB整理] 路径下钻定位失败 ${tpath}: ${e.message}`);
                        }
                    }
                }
                // ★★★ 绝对安全防线：若指定了特定子路径但无法解析出真实 ID，绝不可降级全盘扫描！
                if (!tid || tid === 'unknown') {
                    if (tpath && tpath !== '/') {
                        throw new Error(`未能获取目录【${tname || tpath}】的真实ID，为保护网盘数据已安全中止扫描，防止全盘误扫！`);
                    }
                    tid = Context.state.currentDirId || '/';
                }

                if (!visitedDirs.has(tid)) {
                    visitedDirs.add(tid);
                    queue.push({ id: tid, path: tpath, name: tname, depth: 0, parentId: item.parentId || null });
                }
            }

            onProgress?.('正在检索目录结构...');
            Logger.info(`[TMDB整理] 开始递归扫描目录，起始端点数: ${queue.length}`);

            const allItems = [];

            while (queue.length > 0) {
                if (signal?.aborted || Context.state.isAbortRequested) throw new Error('ABORTED');
                const current = queue.shift();
                onProgress?.(`正在扫描: ${current.path}`);
                sourceFolders.set(current.id, {
                    id: current.id,
                    path: current.path,
                    depth: current.depth,
                    parentId: current.parentId || Context.cache?.dirMeta?.[current.id]?.parentId || null
                });

                try {
                    const items = await DriveAPI.fetchDir(current.id, modeConfig);
                    if (signal?.aborted || Context.state.isAbortRequested) throw new Error('ABORTED');
                    for (const item of items) {
                        const isFolder = Utils.isDirectoryItem(item);
                        const itemId = Utils.getItemId(item);
                        const itemName = Utils.getItemName(item);
                        const itemPath = `${current.path === '/' ? '' : current.path}/${itemName}`;

                        if (isFolder) {
                            if (current.depth < 8 && itemId && !visitedDirs.has(itemId)) {
                                visitedDirs.add(itemId);
                                queue.push({ id: itemId, path: itemPath, name: itemName, depth: current.depth + 1, parentId: current.id });
                            }
                        } else if (RecognitionEngine.isVideoFile(itemName) || RecognitionEngine.isSidecarFile(itemName) || RecognitionEngine.isDiscardFile(itemName)) {
                            allItems.push({
                                ...item,
                                name: itemName,
                                fileId: itemId,
                                parentFileId: current.id,
                                parentFolderName: /^\[?已选/i.test(current.name) ? ((current.path || '').split('/').filter(Boolean).pop() || 'root') : current.name,
                                relativePath: itemPath
                            });
                        }
                    }
                } catch (e) {
                    Logger.warning(`[TMDB整理] 读取目录失败 ${current.path}: ${e.message}`);
                }
            }

            Logger.info(`[TMDB整理] 扫描完毕，发现 ${allItems.length} 个候选媒体/字幕文件，涉及 ${sourceFolders.size} 个来源文件夹。`);
            allItems.sourceFolders = Array.from(sourceFolders.values());
            allItems.files = allItems;
            return allItems;
        }

        static clusterFiles(files) {
            const groupsMap = new Map();

            // 统计各目录下视频数量，用于区分单片合集与分集
            const dirVideoCounts = new Map();
            for (const f of files) {
                if (RecognitionEngine.isVideoFile(f.name)) {
                    const p = f.relativePath ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : (f.parentFolderName || 'root');
                    dirVideoCounts.set(p, (dirVideoCounts.get(p) || 0) + 1);
                }
            }

            // 第一轮：严格以主视频文件（含 .iso）作为锚点创建影视分组
            for (const file of files) {
                const isVideo = RecognitionEngine.isVideoFile(file.name);
                if (!isVideo) continue;

                // 路径智能解耦：自底向上寻找真正的媒体专属目录 (跳过 Season 1 等子目录) 并嗅探 {tmdb-xxxx} 或 [tmdbid-xxxx]
                let pathTmdbId = '';
                let effectiveFolderName = '';
                let effectiveFolderPath = '';

                if (file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);

                    // 1. 全局先行嗅探：整条路径链条中任何层级带有 {tmdb-xxxx} 或 [tmdbid-xxxx]，都是最权威的 TMDB ID
                    for (const seg of parts) {
                        const m = seg.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                        if (m) {
                            pathTmdbId = m[1];
                            break;
                        }
                    }

                    for (let p = parts.length - 2; p >= 0; p--) {
                        const seg = parts[p];
                        if (RecognitionEngine.isGenericFolder(seg)) continue;

                        // ★ 核心强锚点：
                        // 若当前目录包含 {tmdb-xxxx} 或 {tmdbid-xxxx}，此为最权威的影视主目录，绝对锁定并立即停止向上越界攀爬
                        const tmdbFolderMatch = seg.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                        if (tmdbFolderMatch) {
                            pathTmdbId = tmdbFolderMatch[1];
                            effectiveFolderName = seg;
                            effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                            break;
                        }

                        // 2. 唯有自身无独立片名的纯分季/分卷/特别篇子目录（如 "Season 1", "Season 1 SDR", "S02", "第1季", "特别篇", "SP", "BDMV" 等），
                        //    且父级存在有效非通用目录时，才允许向上溯源至父级剧集目录
                        const isCollectionFolder = RecognitionEngine.isCollectionFolder(seg);
                        const folderSeasonVal = RecognitionEngine.targetSeasonFromFolder(seg);
                        const isSubSeason = RecognitionEngine.isSubSeasonFolder(seg) || (folderSeasonVal !== null) ||
                            /(?:Season|S|第)\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇]|OVA|OAD|SP|特别篇|剧场版|劇場版/i.test(seg) ||
                            /[篇章]\s*$/i.test(seg);

                        if (isSubSeason && !isCollectionFolder && p > 0 && !RecognitionEngine.isGenericFolder(parts[p - 1])) {
                            continue;
                        }

                        // ★ 核心防越界门禁 (阻断跨剧污染至顶级分类目录)：
                        // 检查当前目录是否具备独立有效影视剧名（非纯分季子目录）
                        const cleanedSeg = RecognitionEngine.cleanAnimeFolderName(seg);
                        const hasSubstantialTitle = Boolean(
                            cleanedSeg &&
                            cleanedSeg.length >= 2 &&
                            !/^\d+$/.test(cleanedSeg) &&
                            !isSubSeason &&
                            !RecognitionEngine.isGenericFolder(cleanedSeg)
                        );

                        // 若当前目录具备独立剧名（如 "[路人女主的养成方法 第一季][DIY中字]"、"[变形金刚：领袖之证 第一季]"、"真救世主传说_北斗神拳剧场版五部合集"），
                        // 确立该目录本身即为影视主目录，坚决锁定并立即终止向上攀爬，严禁越界污染到父级通用分类目录
                        if (hasSubstantialTitle) {
                            effectiveFolderName = seg;
                            effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                            break;
                        }

                        effectiveFolderName = seg;
                        effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                        break;
                    }
                }

                // 若未在目录树上命中 tmdbId，再检查直接文件名
                if (!pathTmdbId) {
                    const fileTmdbMatch = (file.name || '').match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                    if (fileTmdbMatch) pathTmdbId = fileTmdbMatch[1];
                }
                if (!effectiveFolderName && file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName)) {
                    effectiveFolderName = file.parentFolderName;
                }
                if (!file.parentFolderName && effectiveFolderName) {
                    file.parentFolderName = effectiveFolderName;
                }
                const parentId = file.parentFileId || (file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : 'root');

                // 检查媒体目录名是否为有效影视主文件夹
                const isGenericFolder = RecognitionEngine.isGenericFolder(effectiveFolderName);
                const cleanFolder = !isGenericFolder ? RecognitionEngine.cleanAnimeFolderName(effectiveFolderName) : '';
                const folderYear = !isGenericFolder && effectiveFolderName ? RecognitionEngine.extractYear(effectiveFolderName) : '';

                const pureFileName = RecognitionEngine.getBaseFileName(file.name);
                const animeFile = RecognitionEngine.parseAnimeFilename(pureFileName);
                // 优先采用 inferTitle 提取纯净影视片名 (杜绝将 .S01E07.夏祭之夜.1080p 等连带作为片名)
                const inferredFromEngine = RecognitionEngine.inferTitle(pureFileName);
                const fileTitle = inferredFromEngine || animeFile.title;
                const fileYear = RecognitionEngine.extractYear(pureFileName);

                const isWeakFileTitle = !fileTitle || fileTitle.length < 2 ||
                    /^(?:cd\d*|disc\d*|part\d*|sample|video|movie|feature|remux|web-?dl|bdrip|hdrip|1080p|2160p|4k|720p|hevc|x26[45]|h\.?26[45]|aac|ac3|dts|atmos|ep?\d+|第?\s*\d+\s*[集话話期]|s\d+e\d+)$/i.test(fileTitle) ||
                    /^\d+$/.test(fileTitle) ||
                    /^\d{1,4}\s*(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|生肉|熟肉)?$/i.test(fileTitle);
                const hasStrongFolderTitle = Boolean(cleanFolder && cleanFolder.length >= 2 && !isGenericFolder);

                // 季推导：优先检查直接父目录，再检查整条路径中的季标记，最后回退到 effectiveFolderName (严禁从通用容器目录提取季度)
                let folderSeason = (!RecognitionEngine.isGenericFolder(file.parentFolderName)) ? RecognitionEngine.targetSeasonFromFolder(file.parentFolderName) : null;
                if (!folderSeason && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    for (let p = parts.length - 2; p >= 0; p--) {
                        if (RecognitionEngine.isGenericFolder(parts[p])) continue;
                        const s = RecognitionEngine.targetSeasonFromFolder(parts[p]);
                        if (s !== null) { folderSeason = s; break; }
                    }
                }
                if (!folderSeason && effectiveFolderName && !RecognitionEngine.isGenericFolder(effectiveFolderName)) {
                    folderSeason = RecognitionEngine.targetSeasonFromFolder(effectiveFolderName);
                }
                file._folderSeason = folderSeason !== null && folderSeason !== undefined ? String(folderSeason) : '';

                const hasEpisodeRangeInFolder = Boolean(
                    file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName) && (
                        file.parentFolderName.match(/\[\s*\d{1,4}\s*[-~到至]\s*\d{1,4}\s*\]/) ||
                        file.parentFolderName.match(/\[\s*全\s*\d{1,4}\s*[集话話期]\s*\]/)
                    )
                );

                const se = RecognitionEngine.parseSeasonEpisode(pureFileName, Number(folderSeason || 1));

                // 通用演唱会 / 音乐会判定：演唱会属于 Movie，分类属于演唱会
                const isConcert = Boolean(
                    pureFileName.match(/(?:演唱会|音乐会|歌会|音乐节|独唱会|演奏会|Concert|Live\b|Livehouse|Symphony|交响乐|Philharmonic|歌剧|舞剧)/i) ||
                    file.relativePath?.match(/(?:演唱会|音乐会|Concerts?|音乐节)/i)
                );

                // 通用动漫判定：真实日文假名、真实动画别名库或明确动漫目录；演唱会直接排除
                const isAnime = !isConcert && Boolean(
                    RecognitionEngine.isAnimeIdentifier(file.parentFolderName || '', pureFileName) ||
                    /[\u3040-\u309f\u30a0-\u30ff]/.test(pureFileName) ||
                    /(?:台配动漫|国配动漫|日漫|美漫|动漫|动画|Anime)/i.test(file.relativePath || '')
                );

                // 通用 TV 判定：严禁将演唱会的 Live 25, 40th, Special Live, Top 50 误判为 TV
                const hasDiscIndicator = /(?:^|[ ._\-[\]【】])(?:Disc|Disk|D)\s*\d{1,2}(?=$|[ ._\-[\]【】])/i.test(pureFileName);
                const hasExplicitTvEp = Boolean(
                    pureFileName.match(/\bS\d{1,3}(?:[\s._-]*E\d{1,4})?\b/i) ||
                    pureFileName.match(/第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇集话話]/) ||
                    pureFileName.match(/\bEP\d{1,4}\b/i) ||
                    hasDiscIndicator
                );

                // 具备硬性剧集证据 (显式SxxExx/第X集/季目录/集数范围/Disc光盘分卷) 时 100% 确立为 TV
                const hasHardTvEvidence = Boolean(hasExplicitTvEp || folderSeason || hasEpisodeRangeInFolder);
                // 弱剧集判定：当单文件带有明确单片独立上映年份且无显式剧集标记时，坚决保护为电影，杜绝篡改
                const hasWeakTvEvidence = (!/\.iso$/i.test(pureFileName) || hasDiscIndicator) && (
                    se.isSpecial ||
                    se.isDate ||
                    se.hasEpisode ||
                    (animeFile.episode !== null && animeFile.episode > 0)
                );

                const isTv = !isConcert && (hasHardTvEvidence || (hasWeakTvEvidence && !fileYear));

                // ★ 电影合集独立单片判定：同一目录下有多个电影视频，且无 CD/Part 分卷标记时，判定为独立电影单片合集
                const dirPath = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : (file.parentFolderName || 'root');
                const dirVideoCount = dirVideoCounts.get(dirPath) || 1;
                const variantTag = RecognitionEngine.extractMediaVariantTag(file.name, isTv);
                const isMultiVideoCollection = !isTv && dirVideoCount > 1 && !variantTag;

                let inferredTitle = '';
                let year = fileYear || folderYear;

                if (isMultiVideoCollection) {
                    const fileStem = pureFileName.replace(/\.[a-z0-9]+$/i, '').trim();
                    const cleanStem = RecognitionEngine.inferTitle(fileStem) || fileStem.replace(/[\[【][^\]】]*[\]】]/g, ' ').replace(/\s+/g, ' ').trim();
                    const isFolderCategorical = isGenericFolder || RecognitionEngine.isGenericFolder(cleanFolder) || RecognitionEngine.isCollectionFolder(cleanFolder) || RecognitionEngine.isCollectionFolder(effectiveFolderName);
                    // 核心治理：若父目录属于合集/分类容器，或子文件自身已具备实质独立片名（非依附性弱序号标题），
                    // 坚决直接采纳 cleanStem 作为独立标题，绝对禁止强行拼装 `${cleanFolder} ${cleanStem}`
                    const fileIsIndependent = Boolean(
                        cleanStem && cleanStem.length >= 2 &&
                        !/^\d+$/.test(cleanStem) &&
                        !/^(?:cd\d*|disc\d*|part\d*|ep?\d+|第?\s*\d+\s*[集话話期]|s\d+e\d+|上[集部]?|下[集部]?)$/i.test(cleanStem)
                    );
                    if (cleanFolder && !isFolderCategorical && !fileIsIndependent && !cleanStem.includes(cleanFolder)) {
                        inferredTitle = `${cleanFolder} ${cleanStem}`;
                    } else {
                        inferredTitle = cleanStem;
                    }
                } else {
                    inferredTitle = (hasStrongFolderTitle ? cleanFolder : fileTitle);
                    if (!inferredTitle || /^\d+$/.test(inferredTitle) || (isWeakFileTitle && !hasStrongFolderTitle)) {
                        if (file.relativePath) {
                            const parts = file.relativePath.split('/').filter(Boolean);
                            for (let p = parts.length - 2; p >= 0; p--) {
                                const seg = parts[p];
                                if (!RecognitionEngine.isGenericFolder(seg) && !/^\d+$/.test(seg)) {
                                    const cleaned = RecognitionEngine.cleanAnimeFolderName(seg);
                                    if (cleaned && !/^\d+$/.test(cleaned) && !RecognitionEngine.isGenericFolder(cleaned)) {
                                        inferredTitle = cleaned;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!inferredTitle) inferredTitle = cleanFolder || '待识别影视';
                    }
                }

                inferredTitle = RecognitionEngine.getCanonicalTitle(inferredTitle);

                // 通用中英文双语标题拆分：若同时含有中文与英文副标题，自动解耦
                let englishTitle = '';
                const bilingual = RecognitionEngine.splitBilingualTitle(inferredTitle);
                if (bilingual.englishTitle) {
                    inferredTitle = bilingual.title;
                    englishTitle = bilingual.englishTitle;
                }

                // 英文副标题提取：必须为纯西文字符，严禁将未清洗的中文杂质填入别名
                if (!englishTitle && animeFile.title && animeFile.title !== inferredTitle && /[a-zA-Z]{2,}/.test(animeFile.title) && !/[\u3400-\u9fff]/.test(animeFile.title)) {
                    englishTitle = animeFile.title;
                }

                // 核心优化：影视分组聚合键设计
                // 1. 剧集解绑年份，跨目录合并同一剧集的多个分季与特别篇 (tv:规范标题)
                // 2. 电影合集多单片：每个电影分配专属独立组键，杜绝折叠为同一电影与 .part 命名
                // 3. 单部电影按片名与年份聚合
                // 演唱会公演日期智能识别：若包含明确演出日期 (如 8.30, 8.31, 2010.08.28, 2009.08.22)，将日期独立入键以防多日公演串组
                const concertDate = isConcert ? (RecognitionEngine.extractConcertDate(file.name) || RecognitionEngine.extractConcertDate(file.relativePath)) : null;

                // 季号精确推导：严禁使用 0 || 1 导致 OVA / 特别篇 (季 0) 被误转为季 1
                // 单一事实来源 (SSOT)：若文件名自身含有显式季集标记 (如 S01E01, 第1季第1集)，以文件自身硬证据为准，严禁被父级模糊数字篡改
                const hasExplicitSeasonInFile = RecognitionEngine.hasExplicitSeasonEpisode(file.name);
                const effInitialSeason = (hasExplicitSeasonInFile && se.season !== undefined && se.season !== null)
                    ? String(se.season)
                    : ((folderSeason !== null && folderSeason !== undefined && folderSeason !== '')
                        ? String(folderSeason)
                        : (se.season !== undefined && se.season !== null ? String(se.season) : '1'));

                let groupKey;
                const cleanBaseTitle = isTv ? RecognitionEngine.stripLooseEpisodeTail(inferredTitle || cleanFolder || '') : (inferredTitle || cleanFolder || '');
                const normTitle = (cleanBaseTitle || inferredTitle || cleanFolder || '').toLowerCase().replace(/\s+/g, '');
                const dateSuffix = (isConcert && concertDate) ? (':' + concertDate) : '';
                const effTmdbId = pathTmdbId || animeFile.tmdbId || '';
                if (isTv) {
                    // 剧集按季独立分组（对齐 123 助手 looseGroupKeyTitle 规范）：
                    // 核心事实隔离：
                    // 1. 若路径/文件带有权威 TMDB ID，以 tmdbId 为唯一事实隔离剧集（防止同名动漫与真人剧串组，如凡人修仙传 2020 动漫 tmdb-106449 vs 2025 真人剧 tmdb-243224）
                    // 2. 若无 TMDB ID 但带有明确上映年份，按年份隔离独立同名剧集
                    // 3. 无论文件处于独立媒体目录还是平铺目录，不同季度一律按季独立建组
                    const seriesKey = effTmdbId ? `tmdb:${effTmdbId}` : (normTitle + (year ? ':' + year : ''));
                    groupKey = `tv:${seriesKey}:s${effInitialSeason || '1'}`;
                } else if (isMultiVideoCollection) {
                    const movieKey = effTmdbId ? `tmdb:${effTmdbId}` : `${normTitle}${year ? ':' + year : ''}`;
                    groupKey = `movie:${movieKey}${dateSuffix}`;
                } else if (hasStrongFolderTitle || (inferredTitle && !isWeakFileTitle && normTitle.length >= 2 && !RecognitionEngine.isGenericFolder(inferredTitle))) {
                    const movieKey = effTmdbId ? `tmdb:${effTmdbId}` : `${normTitle}${year ? ':' + year : ''}`;
                    groupKey = `movie:${movieKey}${dateSuffix}`;
                } else {
                    groupKey = (hasStrongFolderTitle && effectiveFolderPath) ? `folder:${effectiveFolderPath}${dateSuffix}` : ((inferredTitle || parentId) + dateSuffix);
                }

                const fileCountryInfo = RecognitionEngine.extractAndStripCountryTag(file.name.replace(/\.[a-z0-9]+$/i, ''));
                if (!groupsMap.has(groupKey)) {
                    const fallbackTitle = (!RecognitionEngine.isGenericFolder(file.parentFolderName) ? file.parentFolderName : '') || '待识别影视';
                    let safeTitle = isTv ? (cleanBaseTitle || inferredTitle || cleanFolder || fallbackTitle) : (inferredTitle || cleanFolder || fallbackTitle);
                    if (RecognitionEngine.isGenericFolder(safeTitle) || RecognitionEngine.isSubSeasonFolder(safeTitle) || /^(?:Season\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷])$/i.test(safeTitle)) {
                        safeTitle = '待识别影视';
                    }
                    const isSuspicious = safeTitle === '待识别影视' || safeTitle === '未命名媒体';
                    groupsMap.set(groupKey, {
                        key: groupKey,
                        id: `group-${groupsMap.size + 1}`,
                        title: safeTitle,
                        englishTitle,
                        year,
                        localYear: year,
                        country: fileCountryInfo.country || '',
                        countryCode: fileCountryInfo.countryCode || '',
                        tmdbId: pathTmdbId || animeFile.tmdbId || '',
                        mediaType: isTv ? 'tv' : 'movie',
                        category: isConcert ? '演唱会' : (isAnime ? '动漫' : (isTv ? '剧集' : '电影')),
                        season: effInitialSeason || '1',
                        targetSeason: (se.isSpecial || se.season === 0 || effInitialSeason === '0') ? '0' : (effInitialSeason || '1'),
                        startEp: '',
                        seasonOffset: 0,
                        epOffset: 0,
                        rating: '0.0',
                        overview: '',
                        posterPath: '',
                        videoFormat: '',
                        mediaSource: '',
                        resourceType: '',
                        colorDepth: '',
                        videoCodec: '',
                        dynamicRange: '',
                        audioCodec: '',
                        releaseGroup: animeFile.releaseGroup || '',
                        mediaFolderOverride: '',
                        concertDate: concertDate || '',
                        isConcert: Boolean(isConcert),
                        files: [],
                        candidateList: [],
                        officialEpisodes: [],
                        metadataProbed: false
                    });
                }

                const group = groupsMap.get(groupKey);
                if (isConcert) group.isConcert = true;
                group.files.push(file);
                // 多季合并自适应：若已有其它季文件并入本组，自动将 targetSeason 置空，转为按每文件各自季号自动分季
                if (group.targetSeason && file._folderSeason && String(group.targetSeason) !== String(file._folderSeason)) {
                    group.targetSeason = '';
                }

                const fileTags = RecognitionEngine.inferTechnicalTags(file.name);
                let folderTags = null;
                if (file.parentFolderName) {
                    folderTags = RecognitionEngine.inferTechnicalTags(file.parentFolderName);
                }
                if ((!folderTags || (!folderTags.mediaSource && !folderTags.releaseGroup)) && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    for (let i = parts.length - 2; i >= 0; i--) {
                        const seg = parts[i];
                        if (seg) {
                            const pTags = RecognitionEngine.inferTechnicalTags(seg);
                            if (pTags.mediaSource || pTags.releaseGroup || pTags.videoFormat || pTags.videoCodec) {
                                folderTags = Object.assign({}, pTags, folderTags || {});
                                break;
                            }
                        }
                    }
                }
                const getTag = (key) => fileTags[key] || folderTags?.[key] || '';

                if (!group.videoFormat && getTag('videoFormat')) group.videoFormat = getTag('videoFormat');
                if (!group.mediaSource && getTag('mediaSource')) group.mediaSource = getTag('mediaSource');
                if (!group.resourceType && getTag('resourceType')) group.resourceType = getTag('resourceType');
                if (!group.videoCodec && getTag('videoCodec')) group.videoCodec = getTag('videoCodec');
                if (!group.colorDepth && getTag('colorDepth')) group.colorDepth = getTag('colorDepth');
                if (!group.dynamicRange && getTag('dynamicRange')) group.dynamicRange = getTag('dynamicRange');
                if (!group.audioCodec && getTag('audioCodec')) group.audioCodec = getTag('audioCodec');
                if (!group.originalEdition && getTag('originalEdition')) group.originalEdition = getTag('originalEdition');
                if (!group.releaseGroup && getTag('releaseGroup')) group.releaseGroup = getTag('releaseGroup');
                if (!group.releaseGroup) {
                    const anime = RecognitionEngine.parseAnimeFilename(file.name);
                    if (anime && anime.releaseGroup) group.releaseGroup = anime.releaseGroup;
                    const tags = RecognitionEngine.inferTechnicalTags(file.name);
                    if (tags.releaseGroup) group.releaseGroup = tags.releaseGroup;
                    if (!group.releaseGroup && folderTags?.releaseGroup) {
                        group.releaseGroup = folderTags.releaseGroup;
                    }
                }
            }

            // 第二轮：字幕文件 (ass, srt, ssa, sub, vtt) 归并到主视频分组
            // 核心修复：四级精准归属决策树，彻底废黜 inDirGroups[0] 无脑兜底，严格隔离未匹配孤儿字幕
            for (const file of files) {
                if (RecognitionEngine.isVideoFile(file.name)) continue;
                if (!RecognitionEngine.isSidecarFile(file.name) && !RecognitionEngine.isDiscardFile(file.name)) continue;

                if (!file.parentFolderName && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    if (parts.length >= 2) file.parentFolderName = parts[parts.length - 2];
                }
                const parentId = file.parentFileId || (file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : 'root');
                const pureFileName = RecognitionEngine.getBaseFileName(file.name);
                const [fileStem] = RecognitionEngine.splitExtension(pureFileName);
                const fileStemLower = fileStem.toLowerCase();
                const inferredTitle = RecognitionEngine.inferTitle(pureFileName);
                const normSubTitle = inferredTitle ? inferredTitle.toLowerCase().replace(/\s+/g, '') : '';
                const subSe = RecognitionEngine.parseSeasonEpisode(pureFileName, 1);
                const subHasSeason = Boolean((subSe.hasEpisode || subSe.isSpecial || subSe.isDate) && subSe.season !== null && subSe.season !== undefined);
                const subYear = RecognitionEngine.extractYear(pureFileName);

                let matchedGroup = null;

                // 收集同目录下的视频组
                const inDirGroups = (parentId !== 'root') ? Array.from(groupsMap.values()).filter(g =>
                    g.files.some(f => (f.parentFileId || (f.relativePath ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : 'root')) === parentId)
                ) : [];

                // ★ Level 1: 同目录同视频主干前缀匹配 / 同季集精准映射 (最高精确度，如 恶魔之浴 / 俄罗斯方块 / S04E07)
                if (inDirGroups.length > 0) {
                    for (const g of inDirGroups) {
                        const videoFiles = g.files.filter(f => RecognitionEngine.isVideoFile(f.name));
                        const matchedVid = videoFiles.find(v => {
                            const [vStem] = RecognitionEngine.splitExtension(v.name);
                            const vStemLower = vStem.toLowerCase();
                            if (fileStemLower === vStemLower ||
                                fileStemLower.startsWith(vStemLower + '.') ||
                                fileStemLower.startsWith(vStemLower + '-') ||
                                fileStemLower.startsWith(vStemLower + '_') ||
                                fileStemLower.startsWith(vStemLower + ' ') ||
                                vStemLower.startsWith(fileStemLower + '.') ||
                                vStemLower.startsWith(fileStemLower + ' ')) {
                                return true;
                            }
                            // 若剥离语言后缀后主干一致 (如 .chs, .cht, .zh-CN 等)
                            const cleanSubStem = fileStemLower.replace(/\.(?:zh[\-_](?:cn|tw|hk|hans|hant)|zh|chs&cht|cht&chs|chs|cht|sc|tc|chi|zho|cmn|yue|en[\-_](?:us|gb)|eng?|jap?|kor?|forced|default|commentary|sdh|简繁双语|简繁|双语|中字|中文|简体|繁体)$/i, '');
                            if (vStemLower.startsWith(cleanSubStem) || cleanSubStem.startsWith(vStemLower)) {
                                return true;
                            }
                            // 同季集号同目录匹配
                            if (subHasSeason && subSe.episode) {
                                const vSe = RecognitionEngine.parseSeasonEpisode(v.name, g.season || 1);
                                if (vSe.season === subSe.season && vSe.episode === subSe.episode) {
                                    return true;
                                }
                            }
                            return false;
                        });
                        if (matchedVid) {
                            matchedGroup = g;
                            break;
                        }
                    }
                }

                // ★ Level 2: 片名 + 年份/季号精准匹配
                if (!matchedGroup && normSubTitle && normSubTitle.length >= 2) {
                    if (subHasSeason) {
                        // 剧集：优先同目录同季，再跨目录同季
                        matchedGroup = inDirGroups.find(g => g.mediaType === 'tv' && String(g.season) === String(subSe.season) && (g.title.toLowerCase().replace(/\s+/g, '') === normSubTitle || normSubTitle.includes(g.title.toLowerCase().replace(/\s+/g, ''))))
                            || groupsMap.get(`tv:${normSubTitle}:s${subSe.season}`)
                            || Array.from(groupsMap.values()).find(g => g.mediaType === 'tv' && String(g.season) === String(subSe.season) && (g.title.toLowerCase().replace(/\s+/g, '') === normSubTitle || normSubTitle.includes(g.title.toLowerCase().replace(/\s+/g, ''))));
                    } else {
                        // 电影：匹配归一化标题高度一致，且年份匹配（若双方均有年份则必须相等）
                        const findMovieMatch = (candidateGroups) => candidateGroups.find(g => {
                            if (g.mediaType === 'tv') return false;
                            const normGTitle = (g.title || '').toLowerCase().replace(/\s+/g, '');
                            if (!normGTitle || !normSubTitle) return false;
                            const isExact = normGTitle === normSubTitle;
                            const isVeryClose = !isExact && (normGTitle.includes(normSubTitle) || normSubTitle.includes(normGTitle)) &&
                                Math.abs(normGTitle.length - normSubTitle.length) <= 2;
                            if (!isExact && !isVeryClose) return false;
                            if (subYear && g.year && subYear !== g.year) return false;
                            return true;
                        });
                        matchedGroup = findMovieMatch(inDirGroups) || findMovieMatch(Array.from(groupsMap.values()));
                    }
                }

                // ★ Level 3: 专属单一影视文件夹继承 (同目录下所有组属于同一作品，或仅单一专属组)
                if (!matchedGroup && inDirGroups.length >= 1 && parentId !== 'root') {
                    const firstGroup = inDirGroups[0];
                    const isAllSameShow = inDirGroups.every(g => (g.title || '').toLowerCase().replace(/\s+/g, '') === (firstGroup.title || '').toLowerCase().replace(/\s+/g, ''));
                    if (isAllSameShow) {
                        let folderName = file.parentFolderName || '';
                        if (!folderName && file.relativePath && file.relativePath.includes('/')) {
                            const parts = file.relativePath.split('/').filter(Boolean);
                            if (parts.length > 1) folderName = parts[parts.length - 2];
                        }
                        const isCategorical = !folderName || RecognitionEngine.isGenericFolder(folderName);
                        if (!isCategorical) {
                            const isDiscard = RecognitionEngine.isDiscardFile(file.name);
                            const isCommonAsset = /^(?:poster|fanart|backdrop|logo|clearart|banner|thumb|landscape|folder|disc|clearlogo|character|tvshow|season\d*(?:-poster|-fanart)?)(?:[._-].*)?$/i.test(fileStem);
                            const normSoleTitle = (firstGroup.title || '').toLowerCase().replace(/\s+/g, '');
                            // 废弃文件/常见海报元数据不具备相斥片名属性，直接继承并随组处理/清障
                            const hasConflictTitle = !isDiscard && !isCommonAsset && normSubTitle && normSubTitle.length >= 2 && normSoleTitle && !normSoleTitle.includes(normSubTitle) && !normSubTitle.includes(normSoleTitle);
                            if (!hasConflictTitle) {
                                matchedGroup = firstGroup;
                            }
                        }
                    }
                }

                // ★ Level 4: 孤立未匹配字幕隔离：若均未命中，判定为孤儿字幕，严禁强塞给任何不相关的影视组
                if (matchedGroup) {
                    matchedGroup.files.push(file);
                }
            }

            // ★ 文件自然排序：先视频后字幕/附属文件，组内文件名自然数字排序 (避免接口返回次序导致集数错位)
            for (const group of groupsMap.values()) {
                group.files.sort((a, b) => {
                    const aVid = RecognitionEngine.isVideoFile(a.name) ? 0 : 1;
                    const bVid = RecognitionEngine.isVideoFile(b.name) ? 0 : 1;
                    if (aVid !== bVid) return aVid - bVid;
                    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
                });
            }

            return Array.from(groupsMap.values());
        }

        static async ensureGroupSeasonsLoaded(group, targetSeasonNum = null, tmdbClient = null) {
            if (!group || group.mediaType !== 'tv' || !group.tmdbId) return;
            if (!tmdbClient) {
                try {
                    const { TMDBService } = require('./tmdb');
                    tmdbClient = new TMDBService();
                } catch (_) {
                    const tmdb = Context.settings.tmdb || {};
                    const cred = (tmdb.credential && tmdb.credential.trim())
                        || (typeof GM_getValue === 'function' ? GM_getValue('tmdb_api_key', '') : '');
                    if (cred && typeof TmdbClient !== 'undefined') {
                        tmdbClient = new TmdbClient(cred);
                    }
                }
            }
            if (!tmdbClient) return;

            // 1. 若尚无官方各季列表或当前 TMDB ID 与已加载季度的 ID 不一致，强制通过 details 接口拉取全量官方季信息 (含 S00, S01, S02 等)
            const currentTmdbId = String(group.tmdbId || '').trim();
            const isTmdbIdChanged = group._seasonsTmdbId && String(group._seasonsTmdbId) !== currentTmdbId;
            if (isTmdbIdChanged) {
                group.seasons = [];
                group.seasonEpisodesMap = {};
                group.officialEpisodes = [];
                group.episodeGroups = [];
                group.episodeGroupsLoaded = false;
                delete group._seasonsTmdbId;
                delete group._egTmdbId;
            }

            group.seasonEpisodesMap = group.seasonEpisodesMap || {};
            group.seasons = Array.isArray(group.seasons) ? group.seasons : [];

            if (!group.seasons.length || String(group._seasonsTmdbId || '') !== currentTmdbId) {
                try {
                    const tvDetail = await tmdbClient.details('tv', group.tmdbId);
                    if (tvDetail?.seasons?.length) {
                        group.seasons = tvDetail.seasons;
                        group._seasonsTmdbId = currentTmdbId;
                    }
                } catch (e) {
                    Logger.warn('[TMDB季播] 拉取剧集详情季信息失败:', e.message);
                }
            }

            // 1.5 预加载剧集官方剧集组列表（用于 Filmix 策略下拉菜单快速切换）
            if (!group.episodeGroupsLoaded || group._egTmdbId !== currentTmdbId) {
                try {
                    const egList = await tmdbClient.episodeGroups(group.tmdbId);
                    group.episodeGroups = Array.isArray(egList) ? egList : [];
                    group.episodeGroupsLoaded = true;
                    group._egTmdbId = currentTmdbId;
                } catch (e) {
                    group.episodeGroups = [];
                    group.episodeGroupsLoaded = true;
                }
            }

            // 2. 收集需要预加载分集的季号
            const neededSeasons = new Set();
            if (targetSeasonNum !== null && targetSeasonNum !== undefined && !isNaN(Number(targetSeasonNum))) {
                neededSeasons.add(Number(targetSeasonNum));
            }
            const rawTargetS = (group.targetSeason !== '' && group.targetSeason !== undefined) ? group.targetSeason : group.season;
            if (rawTargetS !== '' && rawTargetS !== undefined && !isNaN(Number(rawTargetS))) {
                neededSeasons.add(Number(rawTargetS));
            }

            // 收集当前组内所有文件推断出的季
            for (const f of (group.files || [])) {
                const fSeason = f._folderSeason ?? RecognitionEngine.targetSeasonFromFolder(f.parentFolderName);
                if (fSeason !== null && fSeason !== undefined && fSeason !== '' && !isNaN(Number(fSeason))) {
                    neededSeasons.add(Number(fSeason));
                } else {
                    const se = RecognitionEngine.parseSeasonEpisode(f.name, Number(rawTargetS || 1));
                    if (se.season !== undefined && se.season !== null && !isNaN(Number(se.season))) {
                        neededSeasons.add(Number(se.season));
                    }
                }
            }
            if (neededSeasons.size === 0) neededSeasons.add(1);

            // 如果总季数 <= 10，直接将所有官方季 (含特别篇 S00) 全部纳入拉取范围，彻底消灭工作台只能看到 S1 的问题
            if (group.seasons.length > 0 && group.seasons.length <= 10) {
                group.seasons.forEach(s => {
                    const sNum = s.season_number ?? s.seasonNumber;
                    if (sNum !== undefined && sNum !== null) neededSeasons.add(Number(sNum));
                });
            } else if (group.seasons.length > 10) {
                // 大部头动漫 (如柯南、海贼王)，确保包含 S00 (特别篇/OVA) 与 S01
                const hasS00 = group.seasons.some(s => (s.season_number ?? s.seasonNumber) === 0);
                if (hasS00) neededSeasons.add(0);
                neededSeasons.add(1);
            }

            // 3. 并发拉取未缓存的季数据
            const seasonsToFetch = Array.from(neededSeasons).filter(sNum => !group.seasonEpisodesMap[sNum]);
            if (seasonsToFetch.length > 0) {
                await Promise.all(seasonsToFetch.map(async (sNum) => {
                    try {
                        const sData = await tmdbClient.season(group.tmdbId, sNum);
                        group.seasonEpisodesMap[sNum] = Array.isArray(sData) ? sData : (sData.episodes || []);
                    } catch (e) {
                        Logger.debug(`[TMDB季播] 影视【${group.title}】(TMDB:${group.tmdbId}) 未包含第 ${sNum} 季分集数据 (${e.message})`);
                        group.seasonEpisodesMap[sNum] = group.seasonEpisodesMap[sNum] || [];
                    }
                }));
            }

            // 4. 合并各季分集至 officialEpisodes，按季号升序、集号升序规整排序
            group.officialEpisodes = Object.keys(group.seasonEpisodesMap)
                .sort((a, b) => Number(a) - Number(b))
                .flatMap(sNum => group.seasonEpisodesMap[sNum]);
        }

        static formatEpisodeRanges(epNumbers, sTag = 'E') {
            if (!epNumbers || !epNumbers.length) return '';
            const sorted = Array.from(new Set(epNumbers.map(Number))).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b);
            if (!sorted.length) return '';
            const ranges = [];
            let start = sorted[0];
            let prev = sorted[0];

            for (let i = 1; i < sorted.length; i++) {
                const cur = sorted[i];
                if (cur === prev + 1) {
                    prev = cur;
                } else {
                    if (start === prev) {
                        ranges.push(`${sTag}${String(start).padStart(2, '0')}`);
                    } else if (prev === start + 1) {
                        ranges.push(`${sTag}${String(start).padStart(2, '0')}, ${sTag}${String(prev).padStart(2, '0')}`);
                    } else {
                        ranges.push(`${sTag}${String(start).padStart(2, '0')}~${sTag}${String(prev).padStart(2, '0')}`);
                    }
                    start = cur;
                    prev = cur;
                }
            }
            if (start === prev) {
                ranges.push(`${sTag}${String(start).padStart(2, '0')}`);
            } else if (prev === start + 1) {
                ranges.push(`${sTag}${String(start).padStart(2, '0')}, ${sTag}${String(prev).padStart(2, '0')}`);
            } else {
                ranges.push(`${sTag}${String(start).padStart(2, '0')}~${sTag}${String(prev).padStart(2, '0')}`);
            }
            return ranges.join(', ');
        }

        static analyzeMissingEpisodes(group, seasonNum = null) {
            if (!group || group.mediaType !== 'tv') {
                return {
                    mediaType: group?.mediaType || 'unknown',
                    season: 1,
                    seasonLabel: '第 1 季',
                    localCount: 0,
                    coveredCount: 0,
                    tmdbCount: 0,
                    missingCount: 0,
                    missingEpisodes: [],
                    missingRangesStr: '',
                    shortRangesStr: '',
                    detailedList: [],
                    tooltipTitle: '',
                    isMatch: true,
                    isExtra: false
                };
            }

            const groupSeason = (seasonNum !== null && seasonNum !== undefined && !isNaN(Number(seasonNum)))
                ? Number(seasonNum)
                : ((group.targetSeason !== '' && group.targetSeason !== undefined)
                    ? Number(group.targetSeason)
                    : Number(group.season || 1));
            const sTag = `S${String(groupSeason).padStart(2, '0')}`;

            const videoFiles = (group.files || []).filter(f => RecognitionEngine.isVideoFile(f.name));
            const localCoveredEps = new Set();

            videoFiles.forEach(vf => {
                let ep = null;
                if (vf._lockedEpisode) {
                    const m = String(vf._lockedEpisode).match(/S(\d+)E(\d+)/i) || String(vf._lockedEpisode).match(/E(\d+)/i);
                    if (m) {
                        if (m.length === 3) {
                            if (Number(m[1]) === groupSeason) ep = Number(m[2]);
                        } else {
                            ep = Number(m[1]);
                        }
                    }
                }
                if (ep === null) {
                    const se = RecognitionEngine.parseSeasonEpisode(vf.name, groupSeason);
                    if ((se.season === undefined || se.season === null || Number(se.season) === groupSeason) && se.episode) {
                        ep = Number(se.episode);
                    }
                }
                if (ep !== null && !isNaN(ep) && ep > 0) {
                    localCoveredEps.add(ep);
                }
            });

            const targetSeasonEpisodes = group.seasonEpisodesMap?.[groupSeason] || [];
            const tmdbSeason = (group.seasons || []).find(item => (item.season_number ?? item.seasonNumber) === groupSeason);
            const tmdbCount = (tmdbSeason && (tmdbSeason.episode_count ?? tmdbSeason.episodeCount)) || targetSeasonEpisodes.length || 0;

            let expectedEps = [];
            if (targetSeasonEpisodes.length > 0) {
                expectedEps = Array.from(new Set(
                    targetSeasonEpisodes.map(ep => Number(ep.episodeNumber || ep.episode_number)).filter(n => !isNaN(n) && n > 0)
                )).sort((a, b) => a - b);
            } else if (tmdbCount > 0) {
                expectedEps = Array.from({ length: tmdbCount }, (_, i) => i + 1);
            } else if (localCoveredEps.size > 0) {
                const maxEp = Math.max(...Array.from(localCoveredEps));
                if (maxEp > localCoveredEps.size && maxEp <= 1000) {
                    expectedEps = Array.from({ length: maxEp }, (_, i) => i + 1);
                }
            }

            const missingEpisodes = [];
            const detailedList = [];
            expectedEps.forEach(epNum => {
                if (!localCoveredEps.has(epNum)) {
                    const offEp = targetSeasonEpisodes.find(ep => Number(ep.episodeNumber || ep.episode_number) === epNum);
                    const epTag = `${sTag}E${String(epNum).padStart(2, '0')}`;
                    const epName = offEp ? (offEp.name || offEp.title || '') : '';
                    const epDate = offEp ? (offEp.air_date || offEp.airDate || '') : '';
                    missingEpisodes.push({
                        season: groupSeason,
                        episode: epNum,
                        tag: epTag,
                        name: epName,
                        airDate: epDate
                    });
                    let detailLine = `• ${epTag}`;
                    if (epName) detailLine += `: ${epName}`;
                    if (epDate) detailLine += ` (${epDate})`;
                    detailedList.push(detailLine);
                }
            });

            const missingCount = missingEpisodes.length;
            const missingEpNumbers = missingEpisodes.map(m => m.episode);
            const missingRangesStr = this.formatEpisodeRanges(missingEpNumbers, 'E');

            let shortRangesStr = missingRangesStr;
            if (missingRangesStr.length > 18) {
                const parts = missingRangesStr.split(', ');
                if (parts.length > 2) {
                    shortRangesStr = `${parts.slice(0, 2).join(', ')} 等`;
                }
            }

            const localCount = videoFiles.length;
            const isMatch = (tmdbCount > 0) ? (missingCount === 0 && localCount === tmdbCount) : (missingCount === 0);
            const isExtra = (tmdbCount > 0) ? (localCount > tmdbCount) : false;

            const sLabel = groupSeason === 0 ? '特别篇' : `第 ${groupSeason} 季`;
            let tooltipTitle = '';
            if (missingCount > 0) {
                tooltipTitle = `【${group.title || '影视'} ${sLabel}】缺失集数 (共 ${missingCount} 集):&#10;` +
                    detailedList.slice(0, 15).join('&#10;') +
                    (detailedList.length > 15 ? `&#10;... 等共 ${missingCount} 集` : '') +
                    '&#10;&#10;👉 点击可查看并复制完整缺失清单';
            } else if (isMatch && tmdbCount > 0) {
                tooltipTitle = `本地视频集数 (${localCount} 集) 与 TMDB 官方共 ${tmdbCount} 集完全吻合 (✓)`;
            } else if (isExtra) {
                tooltipTitle = `本地视频 (${localCount} 个) 多于 TMDB 官方集数 (${tmdbCount} 集)，可能含同集多版本或花絮`;
            }

            return {
                mediaType: 'tv',
                season: groupSeason,
                seasonLabel: sLabel,
                localCount,
                coveredCount: localCoveredEps.size,
                tmdbCount,
                missingCount,
                missingEpisodes,
                missingRangesStr,
                shortRangesStr,
                detailedList,
                tooltipTitle,
                isMatch,
                isExtra
            };
        }

        static async scrapeGroups(groups, tmdbClient, onProgress, signal = null) {
            if (!tmdbClient || !tmdbClient.credential || !tmdbClient.credential.trim()) {
                throw new Error('未配置 TMDB API 密钥，无法执行在线媒体刮削');
            }
            Logger.debug(`[TMDB整理] 开始执行全部分组在线刮削 (共 ${groups.length} 个影视组)...`);

            for (let i = 0; i < groups.length; i++) {
                if (signal?.aborted || Context.state.isAbortRequested) throw new Error('ABORTED');
                const group = groups[i];
                onProgress?.(`正在刮削第 ${i + 1}/${groups.length} 组: ${group.title}`);
                Logger.debug(`[TMDB整理] 刮削分组 [${i + 1}/${groups.length}] -> 本地识别名: "${group.title}", 年份: "${group.year || '未知'}"${group.tmdbId ? `, 已锁定 TMDB ID: ${group.tmdbId}` : ''}`);

                try {
                    let searchResults = [];
                    let best = null;
                    if (signal?.aborted || Context.state.isAbortRequested) throw new Error('ABORTED');

                    // ★★★ 最高优先级：若本地识别或目录嗅探已命中 TMDB ID (如 {tmdb-61459})，直接调取该 ID 详情直查！
                    if (group.tmdbId && /^\d+$/.test(String(group.tmdbId).trim())) {
                        try {
                            const curId = String(group.tmdbId).trim();
                            const repFile = (group.files || []).find(f => RecognitionEngine.isVideoFile(f.name)) || group.files[0];
                            Logger.debug(`[TMDB刮削] 命中已知 TMDB ID (${curId})，模态: ${group.mediaType}，发起双模态自校验直查...`);
                            const idMatches = await tmdbClient.lookup(curId, group.mediaType, {});
                            if (idMatches && idMatches.length > 0) {
                                searchResults = idMatches;
                                // 双模态片名自校验：优先选择与本地文件名/标题无冲突的条目
                                let matchedCandidate = null;
                                for (const c of idMatches) {
                                    const conflict = repFile ? RecognitionEngine.checkCandidateConflict(repFile, c, group) : false;
                                    if (!conflict) {
                                        matchedCandidate = c;
                                        break;
                                    }
                                }
                                // 若首选模态冲突但备选模态高度吻合，采纳备选条目并就地矫正分组媒体类型 (movie <-> tv)
                                if (matchedCandidate) {
                                    best = matchedCandidate;
                                    if (best.mediaType && best.mediaType !== group.mediaType) {
                                        Logger.info(`[TMDB刮削] TMDB ID (${curId}) 在模态 ${best.mediaType} 下片名精准吻合 ("${best.title}")，自动校正媒体类型: ${group.mediaType} -> ${best.mediaType}`);
                                        group.mediaType = best.mediaType;
                                        group.category = best.mediaType === 'tv' ? '剧集' : '电影';
                                    }
                                    Logger.info(`[TMDB刮削] TMDB ID (${curId}) 直查命中并自校验通过: "${best.title}" (${best.year || '未知年份'}, 模态: ${group.mediaType})`);
                                } else {
                                    // 若所有模态均与文件名冲突，保留第一个条目供后续熔断机制安全报警
                                    best = idMatches[0];
                                    Logger.warn(`[TMDB刮削] TMDB ID (${curId}) 直查条目与本地片名均存在疑似冲突`);
                                }
                            }
                        } catch (idErr) {
                            Logger.warn(`[TMDB刮削] TMDB ID (${group.tmdbId}) 直查失败，降级为标题检索:`, idErr.message);
                        }
                    }

                    // 仅当没有已知 TMDB ID 或直查未命中时，才执行多级关键字检索
                    if (!best) {
                        const queries = RecognitionEngine.tmdbSearchQueries(group.title, group.files[0]?.name || '', group.englishTitle);
                        // 过滤掉无意义的搜索词（如 "Season 1", "S01", "第1季", "第(2)", "待识别影视", 纯数字如 "100", 集数区间如 "0-100", "201～250" 等）
                        const validQueries = queries.filter(q => {
                            const s = q.trim();
                            if (!s || s === '待识别影视' || s === '未命名媒体') return false;
                            if (RecognitionEngine.isGenericFolder(s)) return false;
                            if (/^\d+$/.test(s)) return false;
                            if (/^\d+\s*[-~～－—–_+＋到至一]\s*(?:\d+)?$/.test(s)) return false;
                            if (/^(?:Season\s*\d+|S\d+|第?\s*[\(\[（【]?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[\)\]）】]?\s*[季期部卷]?)$/i.test(s)) return false;
                            return true;
                        });

                        // 多级智能降级检索：依次尝试候选词 (累积候选并在找到高分匹配时及时截断)
                        for (const q of validQueries) {
                            if (signal?.aborted) throw new Error('ABORTED');
                            let batch = [];
                            if (group.year) {
                                try {
                                    batch = await tmdbClient.lookup(q, group.mediaType, { year: group.year });
                                } catch (err) {
                                    Logger.debug(`[TMDB整理] 带年份 (${group.year}) 检索 "${q}" 未直接命中，准备放宽无年份检索:`, err?.message || err);
                                }
                            }
                            if (!batch.length) {
                                try {
                                    batch = await tmdbClient.lookup(q, group.mediaType, {});
                                } catch (err) {
                                    Logger.warn(`[TMDB整理] 关键词 "${q}" TMDB 检索异常:`, err?.message || err);
                                }
                            }
                            if (batch.length > 0) {
                                for (const c of batch) {
                                    c._searchedQuery = q;
                                    if (!searchResults.some(existing => String(existing.id) === String(c.id))) {
                                        searchResults.push(c);
                                    }
                                }
                                const chosen = await RecognitionEngine.chooseTmdbCandidate(searchResults, group, tmdbClient);
                                best = chosen?.candidate || (chosen?.id ? chosen : null);
                                if (best) break;
                            }
                        }
                    }

                    if (searchResults.length > 0) {
                        group.candidateList = searchResults;
                        if (best) {
                            // 核心安全检测：比对代表性原视频文件名与刮削结果，若存在明显冲突则触发熔断机制，坚决拒绝自动采纳冲突候选
                            const repFile = (group.files || []).find(f => RecognitionEngine.isVideoFile(f.name)) || group.files[0];
                            const isConflict = RecognitionEngine.checkCandidateConflict(repFile, best, group);
                            if (isConflict) {
                                group.isSuspicious = true;
                                group.conflictCandidateTitle = best.title || '';
                                group.candidateList = searchResults;
                                Logger.warn(`[TMDB整理] 分组 "${group.title}" 疑似存在标题识别冲突 (代表性原文件名: ${repFile?.name})，熔断保护：拒绝自动采纳 "${best.title}"，保留本地分组待手动校准`);
                                best = null;
                            }
                        }
                        if (best) {
                            group.tmdbId = String(best.id);
                            group.title = best.title || group.title;
                            group.englishTitle = best.originalTitle || group.title;
                            if (best.mediaType && (best.mediaType === 'movie' || best.mediaType === 'tv')) {
                                group.mediaType = best.mediaType; // ★ 同步权威媒体模态 (Movie vs TV)
                            }
                            group.year = best.year || group.year;
                            group.translatedTitles = best.translatedTitles || [];
                            group.regionalTranslations = best.regionalTranslations || best.translatedTitles?.regional || {};
                            group.translationsDisplay = best.translationsDisplay || best.translatedTitles?.display || '';
                            const rawBestGenres = (Array.isArray(best.genre_ids) && best.genre_ids.length > 0)
                                ? best.genre_ids
                                : ((Array.isArray(best.genreIds) && best.genreIds.length > 0)
                                    ? best.genreIds
                                    : (Array.isArray(best.genres) ? best.genres.map(g => (typeof g === 'object' ? g?.id : g)).filter(Boolean) : []));
                            group.genre_ids = (Array.isArray(rawBestGenres) && rawBestGenres.length > 0) ? rawBestGenres : (group.genre_ids || []);
                            group.original_language = best.original_language || best.originalLanguage || group.original_language || '';
                            const rawBestCountries = (Array.isArray(best.origin_country) && best.origin_country.length > 0)
                                ? best.origin_country
                                : ((Array.isArray(best.originCountry) && best.originCountry.length > 0)
                                    ? best.originCountry
                                    : (Array.isArray(best.countries) && best.countries.length > 0
                                        ? best.countries
                                        : (Array.isArray(best.production_countries) && best.production_countries.length > 0
                                            ? best.production_countries.map(c => typeof c === 'object' ? (c.iso_3166_1 || c.name) : c).filter(Boolean)
                                            : (group.origin_country || []))));
                            group.origin_country = rawBestCountries;
                            group.category = RecognitionEngine.inferLibraryCategory(group, best);
                            group.secondaryCategory = RecognitionEngine.inferSecondaryCategory(group.mediaType, group, Context.settings?.tmdb || {});
                            group.rating = best.voteAverage || '0.0';
                            group.overview = best.overview || '';
                            group.posterPath = best.posterPath || best.poster_path || '';
                            group.candidateList = searchResults;

                            // ★ 歧义防错护栏：若本地资源未明确标注年份，且检索结果中存在 >= 2 个完全同名（或高相似）但上映年份不同的独立作品
                            // 坚决杜绝静默标记为已核对通过，自动标黄为存疑 (isSuspicious=true)，强提示人工核验，防止年份错配
                            const repFile = (group.files || []).find(f => RecognitionEngine.isVideoFile(f.name)) || group.files[0];
                            const hasLocalYear = Boolean(group.year || RecognitionEngine.inferYear(repFile?.name || ''));
                            let isAmbiguous = false;
                            if (!hasLocalYear && best) {
                                const normBestTitle = (best.title || '').trim().toLowerCase().replace(/[\s._\-–—()[\]【】:：·・!！]/g, '');
                                const sameTitleOtherYears = searchResults.filter(c => {
                                    if (String(c.id) === String(best.id)) return false;
                                    const cNorm = (c.title || '').trim().toLowerCase().replace(/[\s._\-–—()[\]【】:：·・!！]/g, '');
                                    return (cNorm === normBestTitle || (normBestTitle.length >= 2 && cNorm.includes(normBestTitle))) && c.year && best.year && String(c.year) !== String(best.year);
                                });
                                if (sameTitleOtherYears.length > 0) {
                                    isAmbiguous = true;
                                    group.isSuspicious = true;
                                    group.suspiciousReason = `存在 ${sameTitleOtherYears.length + 1} 部不同年份同名作品 (${[best.year, ...sameTitleOtherYears.map(x=>x.year)].filter(Boolean).join(' / ')})，请核对版本`;
                                    Logger.warn(`[TMDB整理] 分组 "${group.title}" 无年份标记且存在多部不同年份同名作品，触发歧义保护，提示人工核对`);
                                }
                            }
                            if (!isAmbiguous) {
                                group.isSuspicious = false;
                            }

                            // 若为剧集，支持多季并发预拉取 (包含 特别篇/OVA S00, S01, S02 等)，消除工作台只能看到 S1 的限制
                            if (group.mediaType === 'tv') {
                                try {
                                    if (Array.isArray(best.seasons) && best.seasons.length > 0) {
                                        group.seasons = best.seasons;
                                    }
                                    // ★ 核心按年份推断季号：若本地资源带有明确年份且当前季为默认 1，依据 TMDB 官方季首播年份自动校准
                                    const effLocalYear = group.localYear || (group.files || []).map(f => RecognitionEngine.extractYear(f.parentFolderName) || RecognitionEngine.extractYear(f.name)).find(Boolean);
                                    if (effLocalYear && (!group.targetSeason || group.targetSeason === '1' || group.season === '1')) {
                                        const yearInferredSeason = TmdbOrganizeService.inferSeasonFromYear(group.seasons, effLocalYear);
                                        if (yearInferredSeason && yearInferredSeason > 0) {
                                            Logger.info(`[TMDB季播] 影视【${group.title}】依据本地资源年份 (${effLocalYear}) 命中 TMDB 官方第 ${yearInferredSeason} 季首播年，自动校准季号: ${group.season || 1} -> ${yearInferredSeason}`);
                                            group.season = String(yearInferredSeason);
                                            group.targetSeason = String(yearInferredSeason);
                                        }
                                    }
                                    await TmdbOrganizeService.ensureGroupSeasonsLoaded(group, null, tmdbClient);
                                    Logger.debug(`[TMDB整理] 预加载官方各季与分集成功 (季数: ${group.seasons?.length || 0}, 已加载 ${Object.keys(group.seasonEpisodesMap || {}).length} 季共 ${group.officialEpisodes?.length || 0} 集)`);
                                } catch (err) {
                                    Logger.warn(`[TMDB整理] 预加载官方分集失败:`, err?.message || err);
                                }
                            }

                            Logger.debug(`[TMDB整理] 分组 "${group.title}" 刮削成功 -> 匹配条目: "${best.title}" (TMDB ID: ${best.id}, 二级分类: ${group.category})`);
                        }
                    } else {
                        Logger.debug(`[TMDB整理] 分组 "${group.title}" 未检索到 TMDB 条目，保留本地分组待手动校准`);
                    }
                } catch (e) {
                    Logger.warning(`[TMDB整理] 刮削 "${group.title}" 异常: ${e.message}`);
                }
            }
        }

        static renderTranslationsChipsHTML(group) {
            return (typeof UI !== 'undefined' && UI.renderTranslationsChipsHTML) ? UI.renderTranslationsChipsHTML(group) : '';
        }

        // 多版本智能识别与流媒体标准消歧机制 (支持洗版置换优胜者/杜比共存豁免)
        static resolveGroupCollisions(tasks, groups = null, settings = null) {
            const groupsMap = new Map((Array.isArray(groups) ? groups : (groups ? [groups] : [])).map(g => [g.id || g.key, g]));
            const autoWash = settings?.autoWash !== false;
            const keepDolbyMultiVersion = Boolean(settings?.keepDolbyMultiVersion);

            // 1. 按目标目录+季集标识聚合所有非 discard 的视频任务（识别同一集的多个版本）
            const videoEpisodeMap = new Map();
            for (const t of tasks) {
                if (t.discard || t.isProtected || t.skipOrganize) continue;
                if (!t.isSidecar) {
                    const epKey = t.seasonEpisode ? `${t.targetFolderPath.toLowerCase()}#${t.seasonEpisode.toLowerCase()}` : t.targetPath.toLowerCase();
                    if (!videoEpisodeMap.has(epKey)) videoEpisodeMap.set(epKey, []);
                    videoEpisodeMap.get(epKey).push(t);
                }
            }

            const washPolicy = {
                autoWash,
                keepDolbyMultiVersion,
                enableReleaseGroupPriority: true,
                preferRemux: true,
                preferHighResolution: true,
                preferDolby: true,
                conflictMode: 1
            };

            // 2. 多版本评估与规范化消歧
            for (const [epKey, vTasks] of videoEpisodeMap.entries()) {
                if (vTasks.length <= 1) continue;

                const firstGroup = groupsMap.get(vTasks[0].groupId);
                const mode = firstGroup?.multiVersionMode || (autoWash ? 'bestOnly' : 'coexist');

                for (const t of vTasks) {
                    t.isMultiVersion = true;
                    t.multiVersionTotal = vTasks.length;
                }

                // 权威画质仲裁排序：使用 RecognitionEngine 8级质量判定与规格推断
                vTasks.sort((tA, tB) => {
                    const tagsA = RecognitionEngine.inferTechnicalTags(tA.newName || tA.oldName, tA.fileSize, tA._probedMeta || tA.file?._probedMeta);
                    const tagsB = RecognitionEngine.inferTechnicalTags(tB.newName || tB.oldName, tB.fileSize, tB._probedMeta || tB.file?._probedMeta);
                    const cmp = RecognitionEngine.compareCandidates(tagsA, tagsB, washPolicy);
                    if (cmp !== 0) return cmp;
                    return Number(tB.fileSize || 0) - Number(tA.fileSize || 0);
                });

                const best = vTasks[0];
                best.isBestVersion = true;

                if (mode === 'bestOnly') {
                    // 【模式 A：自动洗版 — 仅保留最佳画质，次选版本淘汰移入回收站】
                    best.conflictDiscard = false;
                    best.conflictAction = '';
                    for (let i = 1; i < vTasks.length; i++) {
                        const sec = vTasks[i];
                        // 若开启了保留杜比多版本，且是一组 DV 与非-DV 组合，则准许并存豁免
                        const isDvPair = keepDolbyMultiVersion && (
                            (Boolean(best.file?._probedMeta?.isDolby) !== Boolean(sec.file?._probedMeta?.isDolby))
                        );
                        if (isDvPair) {
                            sec.conflictDiscard = false;
                            sec.conflictAction = '';
                            const tag = sec.file?._probedMeta?.isDolby ? 'DV' : 'SDR';
                            const dot = sec.newName.lastIndexOf('.');
                            const stem = dot > 0 ? sec.newName.slice(0, dot) : sec.newName;
                            const ext = dot > 0 ? sec.newName.slice(dot) : '';
                            sec.newName = `${stem} - ${tag}${ext}`;
                            sec.targetPath = `${sec.targetFolderPath}/${sec.newName}`.replace(/\/+/g, '/');
                        } else {
                            sec.conflictDiscard = true;
                            sec.conflictAction = `多版本洗版：同批次已保留最佳画质版本【${best.oldName}】，次选版本淘汰移入回收站`;
                            sec.washDetails = {
                                type: "skipped",
                                incomingName: sec.newName || sec.oldName,
                                incomingSize: sec.fileSize || 0,
                                incomingTags: tagsB,
                                existingName: best.newName || best.oldName,
                                existingSize: best.fileSize || 0,
                                existingTags: tagsA,
                                cmp: 1
                            };
                        }
                    }
                } else {
                    // 【模式 B：全部多版本共存 - Plex/Emby/Jellyfin 规范】
                    for (let i = 0; i < vTasks.length; i++) {
                        const cur = vTasks[i];
                        cur.conflictDiscard = false;
                        cur.conflictAction = '';
                        if (i === 0) continue; // 最佳版本保持干净文件名

                        // 次选版本生成版本标签 " - [Tag]"
                        const fn = cur.oldName || cur.sourcePath || '';
                        let tag = '';
                        const resMatch = fn.match(/\b(2160p|4k|1080p|720p|remux)\b/i);
                        if (resMatch) {
                            tag = resMatch[1].toUpperCase();
                        } else if (cur.fileSize) {
                            tag = Utils.formatSize(cur.fileSize).replace(/\s+/g, '');
                        } else {
                            tag = `v${i + 1}`;
                        }

                        const dot = cur.newName.lastIndexOf('.');
                        const stem = dot > 0 ? cur.newName.slice(0, dot) : cur.newName;
                        const ext = dot > 0 ? cur.newName.slice(dot) : '';

                        // 格式遵循 Emby/Plex: "stem - tag.ext"
                        cur.newName = `${stem} - ${tag}${ext}`;
                        cur.targetPath = `${cur.targetFolderPath}/${cur.newName}`.replace(/\/+/g, '/');
                    }
                }
            }

            // 3. 兜底保护：字幕同名消歧（如多语言字幕）或剩余重名冲突
            const counts = new Map();
            for (const t of tasks) {
                if (t.discard || t.conflictDiscard || t.isProtected || t.skipOrganize) continue;
                const k = t.targetPath.toLowerCase();
                counts.set(k, (counts.get(k) || 0) + 1);
            }
            const seen = new Map();
            for (const t of tasks) {
                if (t.discard || t.conflictDiscard || t.isProtected || t.skipOrganize) continue;
                const k = t.targetPath.toLowerCase();
                if ((counts.get(k) || 0) > 1) {
                    const idx = (seen.get(k) || 0) + 1;
                    seen.set(k, idx);
                    if (idx > 1) {
                        const dot = t.newName.lastIndexOf('.');
                        const stem = dot > 0 ? t.newName.slice(0, dot) : t.newName;
                        const ext = dot > 0 ? t.newName.slice(dot) : '';
                        const disambiguator = t.isSidecar ? `sub${idx}` : `v${idx}`;
                        t.newName = `${stem}.${disambiguator}${ext}`;
                        t.targetPath = `${t.targetFolderPath}/${t.newName}`.replace(/\/+/g, '/');
                    }
                }
            }
        }

        static annotatePreviewConflicts(tasks) {
            const proposedMap = new Map();
            for (const task of tasks) {
                if (task.discard || task.conflictDiscard || task.isProtected || task.skipOrganize) continue;
                const pathKey = String(task.targetPath || '').toLocaleLowerCase();
                if (proposedMap.has(pathKey)) {
                    task.conflictDiscard = true;
                    task.conflictAction = '本次任务中已有同名目标，当前文件将跳过并清理';
                    Logger.warn(`[冲突检测] 批次内同名冲突: "${task.newName}" -> 路径: ${task.targetPath}`);
                } else {
                    proposedMap.set(pathKey, task);
                }
            }
        }

        static TMDB_EPISODE_GROUP_TYPES = {
            1: '首播顺序',
            2: '绝对顺序',
            3: 'DVD 顺序',
            4: '数字/流媒体顺序',
            5: '故事线',
            6: '制作顺序'
        };

        static ORGANIZE_STRATEGY_KINDS = [
            { kind: 'default', title: '默认策略：识别到的季集', desc: '例：按照文件名和文件夹名正常识别的季集信息，如“权力的游戏.S06E05”为第6季第5集。' },
            { kind: 'splitSequential', title: '拆分策略：单季顺序拆多季', desc: '例：适用类似动漫“龙珠Z”，原文件1季，共291集，按 TMDB 官方各季集数顺序拆分为多季，每季从第1集开始重新编号。' },
            { kind: 'splitKeep', title: '拆分策略：单季跳序拆多季', desc: '例：适用短剧或动漫，原文件为绝对集数且存在缺集跳号，按 TMDB 各季容量范围拆分为各季，并保持季内对应跳序（如第2季起始为EP10，则EP10对应S02E01，EP13对应S02E04）。' },
            { kind: 'merge', title: '合并策略：多季合并一季', desc: '例：适用类似动漫“名侦探柯南”，原文件有多季，合并为一季后，集信息按顺序累加；其他同名分组的文件会一并纳入连续编号。' },
            { kind: 'episodeGroup', title: '剧集组策略：按 TMDB 剧集组', desc: '读取该剧在 TMDB 的剧集组（DVD 顺序、绝对顺序、故事线等），剧集组的子组作为目标季，组内顺序作为集号。' }
        ];

                static parseEpisodeAirDateTimestamp(value) {
            const text = String(value || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
            const time = Date.parse(`${text}T00:00:00Z`);
            return Number.isFinite(time) ? time : null;
        }

        // ★ 核心对齐 123 助手：按正片首播与收官时间跨度动态计算时间窗口，圈定属于当前季的 S00 特别篇
        static relatedSpecialEpisodes(specials, regularSeasonEps) {
            const regular = Array.isArray(regularSeasonEps) ? regularSeasonEps : [];
            const special = Array.isArray(specials) ? specials : [];
            if (!special.length) return regular;

            const regularDates = regular.map(ep => this.parseEpisodeAirDateTimestamp(ep.air_date || ep.airDate)).filter(Boolean);
            if (!regularDates.length) return regular;
            const minRegDate = Math.min(...regularDates);
            const maxRegDate = Math.max(...regularDates);
            // 时间窗口：正片首播前 45 天 ~ 收官后 120 天
            const windowStart = minRegDate - 45 * 24 * 60 * 60 * 1000;
            const windowEnd = maxRegDate + 120 * 24 * 60 * 60 * 1000;

            const related = special.filter(ep => {
                const airDate = this.parseEpisodeAirDateTimestamp(ep.air_date || ep.airDate);
                return airDate !== null && airDate >= windowStart && airDate <= windowEnd;
            });
            return [...regular, ...related];
        }

        // ★ 提取特殊篇与衍生类型特征关键词集 (用于多集同播出日期特征消歧)
        static extractSpecialKeywords(text) {
            const SPECIAL_TAGS = ['先导片', '先导', '加更', '还有加更', '特别加更', '名场面', '特辑', '纯享', '直播', '空降', '花絮', '彩蛋', '番外', '回顾', '精编', '超前企划', '特别企划', '正片'];
            const s = String(text || '').toLowerCase();
            const set = new Set();
            for (const tag of SPECIAL_TAGS) {
                if (s.includes(tag.toLowerCase())) {
                    if (tag === '先导片' || tag === '先导') set.add('先导');
                    else if (tag === '还有加更' || tag === '特别加更' || tag === '加更') set.add('加更');
                    else if (tag === '特别企划' || tag === '超前企划') set.add('企划');
                    else set.add(tag);
                }
            }
            return set;
        }

        // ★ 计算文件名与官方分集名称的标题文本重合度
        static calculateTitleOverlapScore(strA, strB) {
            if (!strA || !strB) return 0;
            const cleanA = strA.replace(/(?:20\d{2}|19\d{2}|2160p|1080p|720p|4k|sdr|hdr|60fps|10bit|h\.?265|hevc|x264|aac|mp4|mkv)/gi, ' ');
            const cleanB = strB.replace(/(?:20\d{2}|19\d{2}|2160p|1080p|720p|4k|sdr|hdr|60fps|10bit|h\.?265|hevc|x264|aac|mp4|mkv)/gi, ' ');

            let maxSub = 0;
            const s1 = cleanA.length < cleanB.length ? cleanA : cleanB;
            const s2 = cleanA.length < cleanB.length ? cleanB : cleanA;

            for (let len = Math.min(s1.length, 20); len >= 2; len--) {
                for (let i = 0; i <= s1.length - len; i++) {
                    const sub = s1.substr(i, len).trim();
                    if (sub.length >= 2 && !/^[\s._\-\d]+$/.test(sub) && s2.includes(sub)) {
                        maxSub = Math.max(maxSub, sub.length);
                        break;
                    }
                }
                if (maxSub >= 2) break;
            }
            return maxSub * 10;
        }

        // ★ 核心算法升级：多维分集匹配与同播出日期消歧引擎 (单一事实来源 SSOT)
        static findBestEpisodeMatch(file, candidates, se, isSpecialFile, effectiveTargetSeason, assignedEpKeys = new Set()) {
            if (!candidates || !candidates.length) return null;

            const fn = file.name || '';
            const fileDate = se.airDate || '';
            const filePart = RecognitionEngine.extractPartIndicator(fn) || (se.periodPart ? { canonical: se.periodPart, index: se.periodPart === '上' ? 1 : (se.periodPart === '下' ? 2 : 3) } : null);
            const fileKeywords = this.extractSpecialKeywords(fn);

            let datePool = [];
            if (fileDate) {
                datePool = candidates.filter(ep => (ep.air_date || ep.airDate) === fileDate);
            }

            const pool = datePool.length ? datePool : candidates;

            let bestEp = null;
            let bestScore = -999;

            for (const ep of pool) {
                const epName = ep.name || '';
                const sNum = Number(ep.season_number ?? ep.seasonNumber ?? 0);
                const epNum = Number(ep.episode_number ?? ep.episodeNumber ?? 0);
                const epKey = `S${sNum}E${epNum}`;
                const epPart = RecognitionEngine.extractPartIndicator(epName);
                const epKeywords = this.extractSpecialKeywords(epName);

                let score = 0;

                // ★ 核心首要硬证据：显式集号完全对齐 (如 S00E36 必须严格对应官方特别篇第 36 集)
                if (se.episode && se.episode > 0) {
                    const targetFileSeason = (se.season !== undefined && se.season !== null) ? Number(se.season) : 0;
                    if (epNum === Number(se.episode) && sNum === targetFileSeason) {
                        score += 500; // 绝对决定性加分，杜绝同分平局被 E01 霸占篡改
                    } else if (epNum === Number(se.episode)) {
                        score += 200; // 跨季但集号完全吻合，高置信度候选
                    } else if (!fileDate && !se.periodNum) {
                        // 文件自身已带明确集号，且候选集号完全不同、又无播出日期覆盖时，实施惩罚性扣分
                        score -= 80;
                    }
                }

                // 0. 日期基准分
                const epDate = ep.air_date || ep.airDate || '';
                if (fileDate && epDate === fileDate) {
                    score += 100;
                }

                // 1. 期号匹配 (第X期)
                if (se.periodNum) {
                    if (epName.includes(`第${se.periodNum}期`)) {
                        score += 60;
                    } else {
                        const epPeriodMatch = epName.match(/第\s*(\d{1,3})\s*期/i);
                        if (epPeriodMatch && parseInt(epPeriodMatch[1], 10) !== se.periodNum) {
                            score -= 100;
                        }
                    }
                }

                // 2. 分部标记消歧 (上/下/中 / Part 1 / Part 2)
                if (filePart && epPart) {
                    if (filePart.index === epPart.index) {
                        score += 80;
                    } else {
                        score -= 120;
                    }
                } else if (filePart && !epPart) {
                    score -= 10;
                }

                // 3. 特殊类型与关键词协同
                let kwHits = 0;
                for (const kw of fileKeywords) {
                    if (epKeywords.has(kw)) kwHits++;
                }
                if (kwHits > 0) score += kwHits * 40;

                // 互斥正片 vs 特别篇
                const fileIsSpec = isSpecialFile || sNum === 0 || /(?:加更|特辑|先导|花絮|名场面|直播|纯享|企划)/i.test(fn);
                const epIsSpec = sNum === 0 || /(?:加更|特辑|先导|花絮|名场面|直播|纯享|企划)/i.test(epName);
                if (fileIsSpec && epIsSpec) score += 30;
                if (!fileIsSpec && !epIsSpec) {
                    score += 30;
                    if (effectiveTargetSeason !== undefined && sNum === effectiveTargetSeason) score += 20;
                }
                if (fileIsSpec !== epIsSpec) score -= 80;

                // 4. 标题文本重合度
                score += this.calculateTitleOverlapScore(fn, epName);

                // 5. 独占分配与平局时的自然顺延奖励
                if (assignedEpKeys.has(epKey)) {
                    score -= 35;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestEp = ep;
                }
            }

            if (bestScore < 0) return null;
            return bestEp;
        }

        static tmdbSeasonCapacities(media) {
            return (Array.isArray(media?.seasons) ? media.seasons : []).map(s => ({
                season: Number(s.season_number ?? s.seasonNumber ?? 0),
                count: Number(s.episode_count ?? s.episodeCount ?? 0)
            })).filter(item => Number.isInteger(item.season) && item.season > 0 && Number.isInteger(item.count) && item.count > 0)
                .sort((a, b) => a.season - b.season);
        }

        // ★【提示词11·分季识别】分季推导的输入必须按「季 → 集」有序。
        //   buildPreview 里的自动分季完全依赖「集号回落 → 进入下一季」与「本季已满 TMDB 容量 → 顺延」两条
        //   顺序敏感规则；一旦 group.files 的扫描顺序不是季集顺序（例如 02.mkv 排在 01.mkv 前面），
        //   推导就会整体错乱：02 被当成本季第 2 集、随后的 01 被判定为「集号回落」而误推进到下一季，
        //   于是同一季的文件被拆到两季、或不同季的文件被并到一季 —— 表现为串季。
        //   这里只在「确实乱序」时才重排，已有序的输入行为与之前完全一致。
        static orderSeasonDerivationInput(videoFiles, fallbackSeason = 1) {
            const list = Array.isArray(videoFiles) ? videoFiles.slice() : [];
            if (list.length < 2) return list;
            const keyOf = (f) => {
                const folderS = (f && f._folderSeason !== undefined && f._folderSeason !== null && f._folderSeason !== '' && !isNaN(Number(f._folderSeason))) ? Number(f._folderSeason) : null;
                let se = null, explicit = false;
                try { se = RecognitionEngine.parseSeasonEpisode(f.name, fallbackSeason); } catch (e) { }
                try { explicit = RecognitionEngine.hasExplicitSeasonEpisode(f.name); } catch (e) { }
                const season = folderS !== null ? folderS : ((explicit && se && se.season) ? Number(se.season) : null);
                const epRaw = se && se.episode;
                const episode = (epRaw !== undefined && epRaw !== null && !isNaN(Number(epRaw))) ? Number(epRaw) : null;
                return { season, episode };
            };
            const keys = list.map(keyOf);
            // 可排序的前提：多数条目能解析出集号；否则保持原顺序，避免把无法解析的文件挪乱
            if (keys.filter(k => k.episode !== null).length < Math.ceil(list.length / 2)) return list;
            const S = k => (k.season === null ? Number.MAX_SAFE_INTEGER : k.season);
            const E = k => (k.episode === null ? Number.MAX_SAFE_INTEGER : k.episode);
            let ordered = true;
            for (let i = 1; i < keys.length; i++) {
                if (S(keys[i - 1]) > S(keys[i]) || (S(keys[i - 1]) === S(keys[i]) && E(keys[i - 1]) > E(keys[i]))) { ordered = false; break; }
            }
            if (ordered) return list;
            Logger.warning(`[TMDB整理] 检测到 ${list.length} 个视频文件的顺序与季集不符，已按「季·集」重排后再做分季推导（原顺序会导致串季）`);
            return list.map((f, i) => ({ f, k: keys[i], i }))
                .sort((x, y) => {
                    if (S(x.k) !== S(y.k)) return S(x.k) - S(y.k);
                    if (E(x.k) !== E(y.k)) return E(x.k) - E(y.k);
                    return x.i - y.i;   // 稳定排序，保证同键条目相对顺序不变
                })
                .map(x => x.f);
        }

        static strategyEpisodeItems(files, fallbackSeason = 1) {
            const items = [];
            for (const file of files || []) {
                const fname = file.name || '';
                if (!RecognitionEngine.isVideoFile(fname) || RecognitionEngine.isSpecialEpisodeHint(fname)) continue;
                const parsed = RecognitionEngine.parseSeasonEpisode(fname, fallbackSeason);
                if (parsed.isSpecial || parsed.season === 0) continue;
                const endEpisode = Number(parsed.endEpisode || 0);
                const episode = Number(parsed.episode || 0);
                items.push({
                    file,
                    fileId: file.fileId || file.id,
                    parsed,
                    season: Number(file._folderSeason || parsed.season || fallbackSeason || 1),
                    episode: episode > 0 ? episode : Number.MAX_SAFE_INTEGER,
                    span: endEpisode > episode ? endEpisode - episode + 1 : 1,
                    sortName: String(file.relativePath || file.name || '')
                });
            }
            return items.sort((a, b) => a.season - b.season || a.episode - b.episode || a.sortName.localeCompare(b.sortName, 'zh-CN', { numeric: true }));
        }

        static planSplitSequentialAssignments(items, capacities, reason) {
            if (!capacities.length) return { assignments: new Map(), warnings: ['未读取到 TMDB 各季集数，无法按季拆分'] };
            if (!items.length) return { assignments: new Map(), warnings: [] };
            const warnings = [];
            const seasons = items.map(i => i.season).filter(s => s > 0);
            const startSeason = seasons.length ? Math.min(...seasons) : 1;
            let index = capacities.findIndex(c => c.season >= startSeason);
            if (index < 0) {
                index = 0;
                warnings.push(`TMDB 没有第 ${startSeason} 季及之后的正片季，已从第 ${capacities[0].season} 季开始拆分`);
            }
            let position = 0;
            let consumed = 0;
            let overflow = false;
            const overflowTotal = capacities.reduce((sum, c) => sum + c.count, 0);
            const assignments = new Map();
            for (const item of items) {
                if (!overflow) {
                    const capacity = capacities[index];
                    if (!capacity) {
                        overflow = true;
                    } else if (position > 0 && position + item.span > capacity.count) {
                        index += 1;
                        position = 0;
                        if (!capacities[index]) overflow = true;
                    } else if (position >= capacity.count) {
                        index += 1;
                        position = 0;
                        if (!capacities[index]) overflow = true;
                    }
                    if (overflow) warnings.push(`文件超出 TMDB 总集数（${overflowTotal} 集），超出部分已顺延到最后一季`);
                }
                const key = String(item.fileId);
                if (overflow) {
                    const last = capacities[capacities.length - 1];
                    const season = last ? last.season : Math.max(1, startSeason);
                    assignments.set(key, {
                        seasonNumber: season,
                        episodeNumber: consumed + 1,
                        seasonEpisode: `S${String(season).padStart(2, '0')}E${String(consumed + 1).padStart(2, '0')}`,
                        reason
                    });
                } else {
                    const capacity = capacities[index];
                    const spanEnd = item.span > 1 ? position + item.span : 0;
                    const endTag = spanEnd ? `-E${String(spanEnd).padStart(2, '0')}` : '';
                    assignments.set(key, {
                        seasonNumber: capacity.season,
                        episodeNumber: position + 1,
                        seasonEpisode: `S${String(capacity.season).padStart(2, '0')}E${String(position + 1).padStart(2, '0')}${endTag}`,
                        reason
                    });
                    position += item.span;
                }
                consumed += item.span;
            }
            return { assignments, warnings };
        }

        static planSplitKeepAssignments(items, capacities, reason) {
            if (!capacities.length) return { assignments: new Map(), warnings: ['未读取到 TMDB 各季集数，无法按季拆分'] };
            const warnings = [];
            const bounds = [];
            let total = 0;
            for (const capacity of capacities) {
                bounds.push({ season: capacity.season, from: total + 1, to: total + capacity.count });
                total += capacity.count;
            }
            const assignments = new Map();
            let beyond = 0;
            const lastBound = bounds[bounds.length - 1];
            for (const item of items) {
                const episode = item.episode === Number.MAX_SAFE_INTEGER ? 0 : item.episode;
                if (!episode) continue;
                const bound = bounds.find(b => episode >= b.from && episode <= b.to);
                if (!bound) beyond += 1;
                const effBound = bound || lastBound;
                const season = effBound.season;
                const epInSeason = Math.max(1, episode - (effBound.from - 1));
                const spanEndInSeason = item.span > 1 ? epInSeason + item.span - 1 : 0;
                const endTag = spanEndInSeason ? `-E${String(spanEndInSeason).padStart(2, '0')}` : '';
                assignments.set(String(item.fileId), {
                    seasonNumber: season,
                    episodeNumber: epInSeason,
                    seasonEpisode: `S${String(season).padStart(2, '0')}E${String(epInSeason).padStart(2, '0')}${endTag}`,
                    reason
                });
            }
            if (beyond) warnings.push(`${beyond} 个文件超出 TMDB 总集数（${total} 集），已保留在最后一季`);
            return { assignments, warnings };
        }

        static planMergeAssignments(items, options = {}, reason) {
            const warnings = [];
            const seasons = items.map(i => i.season).filter(s => s > 0);
            const baseSeason = Number(options.targetSeason) > 0 ? Math.floor(Number(options.targetSeason)) : (seasons.length ? Math.max(1, Math.min(...seasons)) : 1);
            let counter = Math.max(1, Math.floor(Number(options.episodeStart) || 1));
            const assignments = new Map();
            for (const item of items) {
                const spanEnd = item.span > 1 ? counter + item.span - 1 : 0;
                const endTag = spanEnd ? `-E${String(spanEnd).padStart(2, '0')}` : '';
                assignments.set(String(item.fileId), {
                    seasonNumber: baseSeason,
                    episodeNumber: counter,
                    seasonEpisode: `S${String(baseSeason).padStart(2, '0')}E${String(counter).padStart(2, '0')}${endTag}`,
                    reason
                });
                counter += item.span;
            }
            return { assignments, warnings };
        }

        static normalizeEpisodeGroupDetail(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const id = String(raw.id || '');
            const rawGroups = (Array.isArray(raw.groups) ? raw.groups : []).slice().sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0));
            const groups = rawGroups.map((subGroup, index) => {
                const episodes = (Array.isArray(subGroup?.episodes) ? subGroup.episodes : []).slice().sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0)).map((ep, epIdx) => ({
                    id: `eg:${id || 'group'}:${subGroup?.id || index}:${ep?.id ?? epIdx + 1}`,
                    order: epIdx + 1,
                    targetSeason: index + 1,
                    targetEpisode: epIdx + 1,
                    originSeasonNumber: Number(ep.season_number ?? 0),
                    originEpisodeNumber: Number(ep.episode_number ?? 0),
                    name: ep.name || '',
                    airDate: ep.air_date || ''
                }));
                return {
                    id: String(subGroup?.id || index + 1),
                    name: subGroup?.name || `第 ${index + 1} 组`,
                    order: index + 1,
                    episodes
                };
            });
            return { id, name: raw.name || '', groups };
        }

        static matchEpisodeGroupFiles(items, detail, reason, options = {}) {
            const rawGroups = detail?.groups || [];
            const episodes = rawGroups.flatMap(sg => sg.episodes || []);
            if (!episodes.length) return { assignments: new Map(), warnings: ['该剧集组没有可用的集数据'] };
            const warnings = [];
            const byOriginKey = new Map();
            const byEpisodeNumber = new Map();
            const push = (map, key, val) => {
                if (!key) return;
                const list = map.get(key) || [];
                list.push(val);
                map.set(key, list);
            };
            for (const ep of episodes) {
                if (ep.originSeasonNumber > 0 && ep.originEpisodeNumber > 0) push(byOriginKey, `${ep.originSeasonNumber}x${ep.originEpisodeNumber}`, ep);
                if (ep.originEpisodeNumber > 0) push(byEpisodeNumber, ep.originEpisodeNumber, ep);
            }
            const assignments = new Map();
            let unmatched = 0;
            for (const item of items) {
                let ep = null;
                if (item.parsed.season > 0 && item.parsed.episode > 0) {
                    ep = (byOriginKey.get(`${item.parsed.season}x${item.parsed.episode}`) || [])[0] || null;
                }
                if (!ep && item.parsed.episode > 0) {
                    const cands = byEpisodeNumber.get(item.parsed.episode) || [];
                    if (cands.length === 1) ep = cands[0];
                    else if (cands.length > 1) {
                        ep = cands.find(c => item.parsed.season > 0 && c.originSeasonNumber === item.parsed.season) || cands[0];
                    }
                }
                if (ep) {
                    assignments.set(String(item.fileId), {
                        seasonNumber: ep.targetSeason,
                        episodeNumber: ep.targetEpisode,
                        seasonEpisode: `S${String(ep.targetSeason).padStart(2, '0')}E${String(ep.targetEpisode).padStart(2, '0')}`,
                        name: ep.name,
                        airDate: ep.airDate,
                        reason
                    });
                } else {
                    unmatched += 1;
                }
            }
            if (unmatched) warnings.push(`${unmatched} 个文件未能匹配到剧集组集数，已保留原识别结果`);
            return { assignments, warnings };
        }

        static computeGroupStrategyAssignments(strategy, files, media, context = {}) {
            const kind = strategy?.kind || 'default';
            if (!strategy || !kind || kind === 'default') {
                return { assignments: new Map(), warnings: [] };
            }
            const labelObj = this.ORGANIZE_STRATEGY_KINDS.find(k => k.kind === kind);
            const reason = `策略：${strategy.episodeGroupName ? '剧集组：' + strategy.episodeGroupName : (labelObj ? labelObj.title.split('：')[1] || labelObj.title : kind)}`;
            const items = this.strategyEpisodeItems(files, context.fallbackSeason || 1);
            const capacities = this.tmdbSeasonCapacities(media);

            let result;
            if (kind === 'splitSequential') {
                result = this.planSplitSequentialAssignments(items, capacities, reason);
            } else if (kind === 'splitKeep') {
                result = this.planSplitKeepAssignments(items, capacities, reason);
            } else if (kind === 'merge') {
                result = this.planMergeAssignments(items, strategy, reason);
            } else if (kind === 'episodeGroup') {
                result = context.episodeGroupDetail ? this.matchEpisodeGroupFiles(items, context.episodeGroupDetail, reason, context) : { assignments: new Map(), warnings: ['剧集组数据尚未加载'] };
            } else {
                result = { assignments: new Map(), warnings: [] };
            }
            return result;
        }

        // 跨同名/同 TMDB 兄弟分组捕获（对齐 123 助手 captureMergeScope）
        static captureMergeScope(group, allGroups) {
            const keyOf = (item) => {
                if (item.tmdbId) return `tmdb:${item.tmdbId}`;
                return `title:${String(item.title || '').replace(/\s+/g, '').toLowerCase()}`;
            };
            const targetKey = keyOf(group);
            const siblings = (allGroups || []).filter(item => (item.id || item.key) !== (group.id || group.key) && keyOf(item) === targetKey);
            return [group, ...siblings];
        }

        // 生成分类选择下拉项：统一直接定死为精细化二级目录
        static getCategoryOptions(group) {
            const isTv = group.mediaType === 'tv';
            const curVal = group.secondaryCategory || RecognitionEngine.inferSecondaryCategory(group.mediaType, group);
            const defaultList = isTv
                ? ['国产剧', '欧美剧', '日韩剧', '国漫', '日番', '动漫', '纪录片', '综艺', '儿童', '演唱会', '未分类']
                : ['华语电影', '欧美电影', '日韩电影', '动画电影', '纪录片', '演唱会', '外语电影'];
            const allOpts = defaultList.includes(curVal) ? defaultList : [curVal, ...defaultList];
            return allOpts.map(c => `<option value="${Utils.escapeHTML(c)}" ${c === curVal ? 'selected' : ''}>${Utils.escapeHTML(c)}</option>`).join('');
        }

        static buildPreview(groups, settings) {
            const effSettings = settings || {};
            const organizeLocation = effSettings.organizeLocation || 'target';
            const targetDirPath = (effSettings.targetDirPath || '/媒体库').replace(/\/+$/, '');
            const inPlace = organizeLocation === 'inPlace';
            const tasks = [];

            // ★ 全局 Filmix 策略预计算（支持 merge 多季合并一季自动跨同名兄弟组捕获，对齐 123 助手 prepareMergeStrategyAssignments）
            const globalStrategyAssignments = new Map();
            const globalSidecarInherit = new Map();
            const mergeProcessedGroups = new Set();

            for (const g of groups) {
                if (g.mediaType === 'tv' && g.strategy && g.strategy.kind && g.strategy.kind !== 'default') {
                    if (g.strategy.kind === 'merge') {
                        const gId = g.id || g.key;
                        if (mergeProcessedGroups.has(gId)) continue;
                        const scope = TmdbOrganizeService.captureMergeScope(g, groups);
                        scope.forEach(sg => mergeProcessedGroups.add(sg.id || sg.key));
                        const allMergeFiles = scope.flatMap(sg => sg.files || []);
                        const stratRes = TmdbOrganizeService.computeGroupStrategyAssignments(
                            g.strategy,
                            allMergeFiles,
                            { seasons: g.seasons || [] },
                            {
                                fallbackSeason: Number(g.targetSeason || g.season || 1),
                                episodeGroupDetail: g.strategyEpisodeGroupDetail
                            }
                        );
                        for (const [fId, match] of stratRes.assignments.entries()) {
                            globalStrategyAssignments.set(fId, match);
                        }
                        for (const f of allMergeFiles) {
                            const parsed = RecognitionEngine.parseSeasonEpisode(f.name, Number(f._folderSeason || g.season || 1));
                            const match = stratRes.assignments.get(String(f.fileId || f.id));
                            if (match && parsed.episode) {
                                globalSidecarInherit.set(`${parsed.season || 1}x${parsed.episode}`, match);
                                globalSidecarInherit.set(String(parsed.episode), match);
                            }
                        }
                    } else {
                        const stratRes = TmdbOrganizeService.computeGroupStrategyAssignments(
                            g.strategy,
                            g.files,
                            { seasons: g.seasons || [] },
                            {
                                fallbackSeason: Number(g.targetSeason || g.season || 1),
                                episodeGroupDetail: g.strategyEpisodeGroupDetail
                            }
                        );
                        for (const [fId, match] of stratRes.assignments.entries()) {
                            globalStrategyAssignments.set(fId, match);
                        }
                        for (const f of g.files) {
                            const parsed = RecognitionEngine.parseSeasonEpisode(f.name, Number(f._folderSeason || g.season || 1));
                            const match = stratRes.assignments.get(String(f.fileId || f.id));
                            if (match && parsed.episode) {
                                globalSidecarInherit.set(`${parsed.season || 1}x${parsed.episode}`, match);
                                globalSidecarInherit.set(String(parsed.episode), match);
                            }
                        }
                    }
                }
            }

            for (const group of groups) {
                const isTv = group.mediaType === 'tv';
                const getSeasonNum = (val) => (val !== undefined && val !== null && val !== '' && !isNaN(Number(val))) ? Number(val) : null;
                let rawTargetSeason = getSeasonNum(group.targetSeason);
                let rawGroupSeason = getSeasonNum(group.season) !== null ? getSeasonNum(group.season) : 1;

                // ★ 若当前为剧集且未显式指定更高季，通过本地文件/目录年份二次校准季号
                if (isTv && (!rawTargetSeason || rawTargetSeason === 1) && (rawGroupSeason === 1)) {
                    const effLocalYear = group.localYear || (group.files || []).map(f => RecognitionEngine.extractYear(f.parentFolderName) || RecognitionEngine.extractYear(f.name)).find(Boolean);
                    if (effLocalYear) {
                        const yearInferred = TmdbOrganizeService.inferSeasonFromYear(group.seasons, effLocalYear);
                        if (yearInferred && yearInferred > 0) {
                            rawGroupSeason = yearInferred;
                            rawTargetSeason = yearInferred;
                            group.season = String(yearInferred);
                            group.targetSeason = String(yearInferred);
                        }
                    }
                }
                const effectiveTargetSeason = rawTargetSeason !== null ? rawTargetSeason : rawGroupSeason;

                // ★ 对齐 123 助手：按正片时间跨度自动圈定属于当前季的 S00 特别篇候选池
                const currentRegularEps = (group.seasonEpisodesMap?.[effectiveTargetSeason] || []).slice();
                const allSpecialEps = (group.seasonEpisodesMap?.[0] || []).slice();
                const activeCandidates = (isTv && effectiveTargetSeason > 0)
                    ? TmdbOrganizeService.relatedSpecialEpisodes(allSpecialEps, currentRegularEps)
                    : ((allSpecialEps.length ? allSpecialEps : (group.officialEpisodes || [])));
                const groupCandidatesPool = activeCandidates.length ? activeCandidates : (group.officialEpisodes || []);
                const pilotOffset = isTv ? RecognitionEngine.detectPilotEpisodeOffset(group.files, group.officialEpisodes || []) : 0;

                // ★ Filmix 策略集成：单季顺序拆多季、单季跳序拆多季、多季合并一季、TMDB 剧集组
                const hasGlobalStrat = isTv && (group.files || []).some(f => globalStrategyAssignments.has(String(f.fileId || f.id)));
                const strategyAssignments = hasGlobalStrat ? globalStrategyAssignments : null;
                const sidecarInherit = hasGlobalStrat ? globalSidecarInherit : new Map();

                // ★ 对齐 123 助手：多季自动推导与容量拆分（当未手动指定目标季且未激活特殊策略时）
                const autoSeasons = new Map();
                const autoEpisodes = new Map();
                if (isTv && !group.targetSeason && !strategyAssignments) {
                    const videoFiles = group.files.filter(f => RecognitionEngine.isVideoFile(f.name));
                    const capacities = TmdbOrganizeService.tmdbSeasonCapacities({ seasons: group.seasons || [] });
                    const getSeasonNum = (val) => (val !== undefined && val !== null && val !== '' && !isNaN(Number(val))) ? Number(val) : null;
                    const rawGroupSeason = getSeasonNum(group.season) !== null ? getSeasonNum(group.season) : 1;
                    // ★【提示词11】先按季集重排，再做顺序敏感的自动分季推导。
                    //   注意顺序：必须在 rawGroupSeason 声明【之后】调用，否则会踩到 const 的暂时性死区。
                    const derivedVideoFiles = TmdbOrganizeService.orderSeasonDerivationInput(videoFiles, rawGroupSeason);

                    let curSeason = rawGroupSeason;
                    let lastEp = -1;
                    let capIdx = capacities.findIndex(c => c.season >= curSeason);
                    if (capIdx < 0) capIdx = 0;
                    let curSeasonCount = 0;

                    for (let vIdx = 0; vIdx < derivedVideoFiles.length; vIdx++) {
                        const vf = derivedVideoFiles[vIdx];
                        const vfFolderS = getSeasonNum(vf._folderSeason);
                        const se = RecognitionEngine.parseSeasonEpisode(vf.name, curSeason);
                        const k = String(vf.fileId || vf.id);

                        if (se.isSpecial || se.season === 0) {
                            autoSeasons.set(k, 0);
                            autoEpisodes.set(k, se.episode || (vIdx + 1));
                            continue;
                        }

                        if (vfFolderS !== null) {
                            curSeason = vfFolderS;
                            curSeasonCount = 0;
                            lastEp = -1;
                            capIdx = capacities.findIndex(c => c.season >= curSeason);
                            if (capIdx < 0) capIdx = 0;
                        } else if (se.season && se.season > 0 && RecognitionEngine.hasExplicitSeasonEpisode(vf.name)) {
                            curSeason = se.season;
                            curSeasonCount = 0;
                            lastEp = -1;
                            capIdx = capacities.findIndex(c => c.season >= curSeason);
                            if (capIdx < 0) capIdx = 0;
                        } else {
                            const parsedEp = se.episode || (vIdx + 1);
                            // 123 机制：检测集号回落 (如 12 变 01) 自动识别为进入下一季
                            if (lastEp > 0 && parsedEp < lastEp && parsedEp <= 5) {
                                if (capacities.length > capIdx + 1) {
                                    capIdx++;
                                    curSeason = capacities[capIdx].season;
                                } else {
                                    curSeason++;
                                }
                                curSeasonCount = 0;
                            } else if (capacities.length > 0 && capacities[capIdx] && curSeasonCount >= capacities[capIdx].count) {
                                // 123 机制：正片文件数达到 TMDB 官方季容量上限，自动顺延推进至下一季
                                if (capacities.length > capIdx + 1) {
                                    capIdx++;
                                    curSeason = capacities[capIdx].season;
                                } else {
                                    curSeason++;
                                }
                                curSeasonCount = 0;
                            }
                            lastEp = parsedEp;
                        }

                        let effEp = se.episode;
                        if (capacities.length > 0 && capIdx > 0 && se.episode) {
                            const priorCount = capacities.slice(0, capIdx).reduce((acc, c) => acc + c.count, 0);
                            if (se.episode > priorCount) {
                                effEp = se.episode - priorCount;
                            }
                        }

                        autoSeasons.set(k, curSeason);
                        autoEpisodes.set(k, effEp || (curSeasonCount + 1));
                        curSeasonCount++;
                    }
                }

                // ============= 多版本季目录智能分流 (两阶段分流) =============
                // 第一阶段：预计算各文件的元数据与规格，统计每季实际包含的规格变体
                const preparedFiles = [];
                const seasonVariantMap = new Map(); // Map<seasonNumStr, Set<specFolderStr>>
                const groupAssignedEpKeys = new Set();

                let videoIdx = 0;
                for (let fileIdx = 0; fileIdx < group.files.length; fileIdx++) {
                    const file = group.files[fileIdx];
                    const isVideo = RecognitionEngine.isVideoFile(file.name);
                    const isSidecar = RecognitionEngine.isSidecarFile(file.name);
                    const isDiscard = RecognitionEngine.isDiscardFile(file.name);
                    const ext = RecognitionEngine.getFileExt(file.name);
                    const fileExtWithDot = '.' + ext;

                    let seasonEpisodeTag = '';
                    const getSeasonNum = (val) => (val !== undefined && val !== null && val !== '' && !isNaN(Number(val))) ? Number(val) : null;
                    const rawFileSeason = getSeasonNum(file._folderSeason);
                    const rawTargetSeason = getSeasonNum(group.targetSeason);
                    const rawGroupSeason = getSeasonNum(group.season) !== null ? getSeasonNum(group.season) : 1;
                    const hasTargetSeason = rawTargetSeason !== null;

                    // 若当前文件直接父目录带有独立年份，优先检查该年份是否命中特定季
                    let fileYearInferred = null;
                    if (isTv && (rawFileSeason === null || rawFileSeason === 1) && (!hasTargetSeason || rawTargetSeason === 1)) {
                        const fileYear = RecognitionEngine.extractYear(file.parentFolderName) || RecognitionEngine.extractYear(file.name);
                        if (fileYear) {
                            fileYearInferred = TmdbOrganizeService.inferSeasonFromYear(group.seasons, fileYear);
                        }
                    }

                    let effSeason = isTv ? (fileYearInferred !== null ? fileYearInferred : (hasTargetSeason ? rawTargetSeason : (rawFileSeason !== null ? rawFileSeason : rawGroupSeason))) : 1;
                    let effEpisode = 1;
                    let matchedOfficialEp = null;
                    let isSpecialFile = false;

                    if (isTv) {
                        const fKey = String(file.fileId || file.id);
                        const autoS = autoSeasons.get(fKey);
                        const autoEp = autoEpisodes.get(fKey);
                        const parseBaseSeason = hasTargetSeason ? rawTargetSeason : (autoS !== undefined ? autoS : (rawFileSeason !== null ? rawFileSeason : rawGroupSeason));
                        const se = RecognitionEngine.parseSeasonEpisode(file.name, parseBaseSeason);
                        isSpecialFile = Boolean(se.isSpecial || se.season === 0);
                        const stratMatch = strategyAssignments ? (
                            strategyAssignments.get(String(file.fileId || file.id)) ||
                            (isSidecar && se.episode ? (sidecarInherit.get(`${se.season || 1}x${se.episode}`) || sidecarInherit.get(String(se.episode))) : null)
                        ) : null;

                        // 若用户在工作台手动锁定点选了某官方分集，直接最高优先级采用
                        if (file._lockedEpisode) {
                            seasonEpisodeTag = file._lockedEpisode;
                            groupAssignedEpKeys.add(file._lockedEpisode);
                            const lm = seasonEpisodeTag.match(/S(\d{1,3})E(\d{1,4})/i);
                            if (lm) {
                                effSeason = parseInt(lm[1], 10);
                                effEpisode = parseInt(lm[2], 10);
                                // ★【提示词11·串季修复②】区分两种锁定来源：
                                //   · _calibrated：由「季集校准」按 TMDB 官方季号写入，属于推导结果 → 必须叠加季偏移，
                                //     否则用户设了偏移、校准之后偏移被静默吞掉，校准过的文件和没校准的文件会落到不同季；
                                //   · 无 _calibrated：用户在分集下拉里明确点选，代表其最终意图 → 绝不偏移。
                                if (file._calibrated) {
                                    const off2 = Number(group.seasonOffset || 0);
                                    const shifted = Math.max(0, effSeason + off2);
                                    if (shifted !== effSeason) {
                                        // 只替换季号前缀，保留 -E05 / D01 之类的后缀
                                        seasonEpisodeTag = seasonEpisodeTag.replace(/S\d{1,3}/i, `S${String(shifted).padStart(2, '0')}`);
                                        effSeason = shifted;
                                    }
                                }
                            }
                        } else if (stratMatch) {
                            // 命中 Filmix 策略计算结果
                            // ★【提示词11】策略（顺序/跳序拆多季等）给出的季号是依据 TMDB 官方季容量算出的绝对季号，
                            //   刻意不再叠加季偏移；否则会与策略自身的季边界冲突而串季。
                            //   但用户设了偏移却看不到效果容易误判，这里提示一次。
                            if (Number(group.seasonOffset || 0) !== 0 && !group._offsetNoticeLogged) {
                                group._offsetNoticeLogged = true;
                                Logger.info(`[TMDB整理] 当前启用了「${group.strategy?.title || '拆分策略'}」，季号由策略按 TMDB 季容量计算，季偏移（${group.seasonOffset}）不参与；如需整体平移请改用「默认」策略后设置季偏移`);
                            }
                            effSeason = stratMatch.seasonNumber;
                            effEpisode = stratMatch.episodeNumber;
                            seasonEpisodeTag = stratMatch.seasonEpisode;
                            if (isVideo) videoIdx++;
                        } else {
                            // ★ 核心升级：以播出日期 airDate 与多维特征（分部上下篇/类型关键词/标题相似度/独占顺延）进行智能消歧对齐
                            matchedOfficialEp = null;
                            if (groupCandidatesPool.length && (se.airDate || isSpecialFile || se.periodNum || se.partIndicator || RecognitionEngine.extractPartIndicator(file.name))) {
                                matchedOfficialEp = TmdbOrganizeService.findBestEpisodeMatch(
                                    file,
                                    groupCandidatesPool,
                                    se,
                                    isSpecialFile,
                                    effectiveTargetSeason,
                                    groupAssignedEpKeys
                                );
                                if (matchedOfficialEp) {
                                    const s = Number(matchedOfficialEp.season_number ?? matchedOfficialEp.seasonNumber ?? 0);
                                    const e = Number(matchedOfficialEp.episode_number ?? matchedOfficialEp.episodeNumber ?? 0);
                                    groupAssignedEpKeys.add(`S${s}E${e}`);
                                }
                            }

                            if (matchedOfficialEp) {
                                // ★ 核心修复：命中 TMDB 官方分集为确定性硬事实，直接生效，绝不被 autoEp 伪顺延冲刷覆盖！
                                effSeason = Number(matchedOfficialEp.season_number ?? matchedOfficialEp.seasonNumber ?? 0);
                                effEpisode = Number(matchedOfficialEp.episode_number ?? matchedOfficialEp.episodeNumber ?? 1);
                                if (isVideo && effSeason > 0) videoIdx++;
                            } else {
                                // 未命中官方分集（含未在 TMDB 建档的特别篇/直播）：优雅兜底，杜绝侵占正片坑位
                                const rawFolderSeason = (file._folderSeason !== undefined && file._folderSeason !== null && file._folderSeason !== '' && !isNaN(Number(file._folderSeason))) ? Number(file._folderSeason) : null;
                                const baseSeason = isSpecialFile
                                    ? 0
                                    : (hasTargetSeason ? rawTargetSeason : (autoS !== undefined ? autoS : (rawFolderSeason !== null ? rawFolderSeason : (se.season ? se.season : rawGroupSeason))));
                                const seasonOffsetNum = isSpecialFile ? 0 : Number(group.seasonOffset || 0);
                                effSeason = isSpecialFile ? 0 : Math.max(0, baseSeason + seasonOffsetNum);
                                if (isSpecialFile) {
                                    // 未收录特别篇保持原解析集数或 0，不侵占正片 videoIdx 顺延
                                    effEpisode = Number(se.hasEpisode && se.episode ? se.episode : 0);
                                } else if (isVideo) {
                                    effEpisode = (group.startEp ? (Number(group.startEp) + videoIdx) : Number(autoEp || se.episode || (videoIdx + 1))) + Number(group.epOffset || 0) - pilotOffset;
                                    if (videoIdx === 0 && pilotOffset > 0) effEpisode = 1;
                                    videoIdx++;
                                } else {
                                    effEpisode = Number(se.episode || 1) + Number(group.epOffset || 0);
                                }
                            }

                            if (matchedOfficialEp) {
                                const sTag = `S${String(Math.max(0, effSeason)).padStart(2, '0')}`;
                                const eTag = `E${String(Math.max(1, effEpisode)).padStart(2, '0')}`;
                                seasonEpisodeTag = `${sTag}${eTag}`;
                            } else if (file._lockedEpisode) {
                                seasonEpisodeTag = file._lockedEpisode;
                            } else if (isSpecialFile) {
                                // ★ 未命中 TMDB 官方分集的特别篇/加更：绝不生成伪造集号（杜绝变造 S00E01）
                                if (effEpisode > 0) {
                                    seasonEpisodeTag = `S00E${String(effEpisode).padStart(2, '0')}`;
                                } else {
                                    seasonEpisodeTag = '';
                                }
                            } else {
                                const sTag = `S${String(Math.max(0, effSeason)).padStart(2, '0')}`;
                                const eTag = effEpisode > 0 ? `E${String(effEpisode).padStart(2, '0')}` : '';
                                const endEpisodeVal = se.endEpisode || se.episodeEnd || 0;
                                const endTag = endEpisodeVal ? `-E${String(endEpisodeVal).padStart(2, '0')}` : '';
                                seasonEpisodeTag = `${sTag}${eTag}${endTag}`;
                            }
                        }
                    }

                    const effSeasonVal = (effSeason !== undefined && effSeason !== null && effSeason !== '') ? effSeason : (hasTargetSeason ? rawTargetSeason : rawGroupSeason);

                    // ★ 核心对齐 123 助手 Per-File 独立推断机制：杜绝多季/多规格被单一视频同化覆盖
                    let resolvedSpecs = null;
                    if (isVideo) {
                        const fileTags = RecognitionEngine.inferTechnicalTags(file.name);
                        let fileRGroup = fileTags.releaseGroup || '';
                        if (!fileRGroup) {
                            const anime = RecognitionEngine.parseAnimeFilename(file.name);
                            if (anime?.releaseGroup) fileRGroup = anime.releaseGroup;
                        }
                        let parentFolderTags = null;
                        if (file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName)) {
                            parentFolderTags = RecognitionEngine.inferTechnicalTags(file.parentFolderName);
                            if (!fileRGroup && parentFolderTags.releaseGroup) {
                                fileRGroup = parentFolderTags.releaseGroup;
                            }
                        }
                        resolvedSpecs = {
                            videoFormat: fileTags.videoFormat || parentFolderTags?.videoFormat || '',
                            mediaSource: fileTags.mediaSource || parentFolderTags?.mediaSource || '',
                            resourceType: fileTags.resourceType || parentFolderTags?.resourceType || '',
                            effect: fileTags.effect || parentFolderTags?.effect || '',
                            highQuality: fileTags.highQuality || parentFolderTags?.highQuality || '',
                            dolbyVision: fileTags.dolbyVision || parentFolderTags?.dolbyVision || '',
                            dynamicRange: fileTags.dynamicRange || parentFolderTags?.dynamicRange || '',
                            frameRate: fileTags.frameRate || parentFolderTags?.frameRate || '',
                            colorDepth: fileTags.colorDepth || parentFolderTags?.colorDepth || '',
                            originalEdition: fileTags.originalEdition || parentFolderTags?.originalEdition || '',
                            videoCodec: fileTags.videoCodec || parentFolderTags?.videoCodec || '',
                            audioCodec: fileTags.audioCodec || parentFolderTags?.audioCodec || '',
                            releaseGroup: fileRGroup || ''
                        };
                    } else if (isSidecar) {
                        // 字幕等附属文件智能匹配同组对应视频，继承该主视频的硬件规格
                        const [sStem] = RecognitionEngine.splitExtension(file.name);
                        const cleanSStem = sStem
                            .replace(/\.(?:zh[\-_](?:cn|tw|hk|hans|hant)|zh|chs&cht|cht&chs|chs|cht|sc|tc|chi|zho|cmn|yue|en[\-_](?:us|gb)|eng?|jap?|kor?|forced|default|commentary|sdh|简繁双语|简繁|双语|中字|中文|简体|繁体)$/i, '')
                            .replace(/[._\- ]第?\d{1,4}集?[._\- ]/g, '.');
                        let matchedVf = group.files.find(f => {
                            if (!RecognitionEngine.isVideoFile(f.name)) return false;
                            const [vfStem] = RecognitionEngine.splitExtension(f.name);
                            const cleanVfStem = vfStem.replace(/[._\- ]第?\d{1,4}集?[._\- ]/g, '.');
                            return vfStem === cleanSStem || cleanVfStem === cleanSStem || vfStem.startsWith(cleanSStem) || cleanSStem.startsWith(vfStem);
                        });
                        if (!matchedVf && isTv) {
                            const parsedSub = RecognitionEngine.parseSeasonEpisode(file.name, effSeason);
                            const subEp = parsedSub.episode;
                            const subS = parsedSub.season !== undefined ? parsedSub.season : effSeason;
                            if (subEp) {
                                matchedVf = group.files.find(f => {
                                    if (!RecognitionEngine.isVideoFile(f.name)) return false;
                                    const parsedV = RecognitionEngine.parseSeasonEpisode(f.name, effSeason);
                                    return (parsedV.season === subS || (!parsedV.season && subS === 1)) && parsedV.episode === subEp;
                                });
                            }
                        }
                        if (matchedVf) {
                            const vfTags = RecognitionEngine.inferTechnicalTags(matchedVf.name);
                            let vfRGroup = vfTags.releaseGroup || '';
                            if (!vfRGroup) {
                                const anime = RecognitionEngine.parseAnimeFilename(matchedVf.name);
                                if (anime?.releaseGroup) vfRGroup = anime.releaseGroup;
                            }
                            resolvedSpecs = {
                                videoFormat: vfTags.videoFormat || '',
                                mediaSource: vfTags.mediaSource || '',
                                resourceType: vfTags.resourceType || '',
                                effect: vfTags.effect || '',
                                highQuality: vfTags.highQuality || '',
                                dolbyVision: vfTags.dolbyVision || '',
                                dynamicRange: vfTags.dynamicRange || '',
                                frameRate: vfTags.frameRate || '',
                                colorDepth: vfTags.colorDepth || '',
                                originalEdition: vfTags.originalEdition || '',
                                videoCodec: vfTags.videoCodec || '',
                                audioCodec: vfTags.audioCodec || '',
                                releaseGroup: vfRGroup || ''
                            };
                        } else {
                            const sidecarTags = RecognitionEngine.inferTechnicalTags(file.name);
                            let pTags = null;
                            if (file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName)) {
                                pTags = RecognitionEngine.inferTechnicalTags(file.parentFolderName);
                            }
                            resolvedSpecs = {
                                videoFormat: sidecarTags.videoFormat || pTags?.videoFormat || '',
                                mediaSource: sidecarTags.mediaSource || pTags?.mediaSource || '',
                                resourceType: sidecarTags.resourceType || pTags?.resourceType || '',
                                effect: sidecarTags.effect || pTags?.effect || '',
                                highQuality: sidecarTags.highQuality || pTags?.highQuality || '',
                                dolbyVision: sidecarTags.dolbyVision || pTags?.dolbyVision || '',
                                dynamicRange: sidecarTags.dynamicRange || pTags?.dynamicRange || '',
                                frameRate: sidecarTags.frameRate || pTags?.frameRate || '',
                                colorDepth: sidecarTags.colorDepth || pTags?.colorDepth || '',
                                originalEdition: sidecarTags.originalEdition || pTags?.originalEdition || '',
                                videoCodec: sidecarTags.videoCodec || pTags?.videoCodec || '',
                                audioCodec: sidecarTags.audioCodec || pTags?.audioCodec || '',
                                releaseGroup: sidecarTags.releaseGroup || pTags?.releaseGroup || ''
                            };
                        }
                    } else {
                        resolvedSpecs = {};
                    }

                    // 规格覆盖优先级 (按字段逐项独立继承)：
                    // 1. 用户手动显式覆盖 (group._manualOverrides)
                    // 2. 文件底层 MediaInfo 嗅探硬参数 (file._probedMeta)
                    // 3. 单文件/关联主视频解析出的独立规格 (resolvedSpecs)
                    // 4. 组级规格继承控制 (多版本物理隔离防污染)：
                    //    - 若当前为独立视频且组内存在多个视频 (多版本电影/多压制版共存)，绝对禁止从 group[k] 跨文件继承已污染的来源介质与编码等硬件规格
                    //    - 若为附属字幕 (isSidecar) 或组内仅单个视频，允许从 group[k] 平滑回退继承
                    const isMultiVideo = (group.files || []).filter(f => RecognitionEngine.isVideoFile(f.name)).length > 1;
                    const isDirectVideo = RecognitionEngine.isVideoFile(file.name);
                    const specKeys = ['videoFormat', 'mediaSource', 'resourceType', 'effect', 'highQuality', 'dolbyVision', 'dynamicRange', 'frameRate', 'colorDepth', 'originalEdition', 'videoCodec', 'audioCodec', 'releaseGroup'];
                    const finalSpecs = {};

                    // ★ 规格反哺与一致性保证：
                    // 若首个主视频解析出的独立规格有效，且组级属性为空、用户未手动覆盖，平滑反哺赋给 group，保证 UI 规格面板与文件名 100% 绝对一致
                    if (isVideo && resolvedSpecs) {
                        for (const sk of specKeys) {
                            const specVal = file._probedMeta?.[sk] || resolvedSpecs[sk];
                            if (!group[sk] && specVal && (group._manualOverrides?.[sk] === undefined)) {
                                group[sk] = specVal;
                            }
                        }
                    }

                    for (const k of specKeys) {
                        if (group._manualOverrides && group._manualOverrides[k] !== undefined) {
                            finalSpecs[k] = group._manualOverrides[k];
                        } else if (file._probedMeta && file._probedMeta[k] && !file._probedMeta.isFallbackFromName) {
                            finalSpecs[k] = file._probedMeta[k];
                        } else if (resolvedSpecs && resolvedSpecs[k]) {
                            finalSpecs[k] = resolvedSpecs[k];
                        } else if (file._probedMeta && file._probedMeta[k]) {
                            finalSpecs[k] = file._probedMeta[k];
                        } else if (!isMultiVideo || isTv) {
                            // 剧集季批次同行共识 (Peer Spec Consensus)：同季单集缺失规格平滑继承组级权威规格
                            finalSpecs[k] = group[k] || '';
                        } else {
                            finalSpecs[k] = '';
                        }
                    }

                    // ★ 剧集同行共识增强：单集若因网络探针超时降级 (isFallbackFromName)，自动对齐同组权威 HDR/编码规格
                    if (isTv) {
                        if (group.videoCodec && !finalSpecs.videoCodec) {
                            finalSpecs.videoCodec = group.videoCodec;
                        }
                        if (group.audioCodec && !finalSpecs.audioCodec) {
                            finalSpecs.audioCodec = group.audioCodec;
                        }
                        if (group.colorDepth && !finalSpecs.colorDepth) {
                            finalSpecs.colorDepth = group.colorDepth;
                        }
                        if (file._probedMeta?.isFallbackFromName && group.dynamicRange && group.dynamicRange !== 'SDR' && (!finalSpecs.dynamicRange || finalSpecs.dynamicRange === 'SDR')) {
                            finalSpecs.dynamicRange = group.dynamicRange;
                        }
                    }

                    // 提取单集标题 (仅当剧集开启 includeEpisodeTitle 时受控注入)
                    let currentEpTitle = '';
                    const shouldIncludeEpTitle = Boolean(group.includeEpisodeTitle !== undefined ? group.includeEpisodeTitle : (effSettings.includeEpisodeTitle ?? true));
                    if (isTv && shouldIncludeEpTitle) {
                        let curSNum = (effSeasonVal !== '' && effSeasonVal !== undefined) ? Number(effSeasonVal) : 1;
                        let curENum = Number(effEpisode || 1);
                        if (file._lockedEpisode) {
                            const lk = String(file._lockedEpisode).match(/S(\d{1,2})E(\d{1,4})/i);
                            if (lk) {
                                curSNum = Number(lk[1]);
                                curENum = Number(lk[2]);
                            }
                        }
                        const targetSeasonEps = group.seasonEpisodesMap?.[curSNum] || group.officialEpisodes || [];
                        if (targetSeasonEps.length > 0) {
                            // ★ 核心防错乱保护：未在 TMDB 建档的特别篇绝对禁止冒充 S00E01 的官方标题
                            const isUnmatchedSpecial = curSNum === 0 && !matchedOfficialEp && !file._lockedEpisode;
                            if (!isUnmatchedSpecial && curENum > 0) {
                                const foundEp = targetSeasonEps.find(ep => {
                                    const s = Number(ep.season_number ?? ep.seasonNumber ?? curSNum);
                                    const e = Number(ep.episode_number ?? ep.episodeNumber);
                                    return s === curSNum && e === curENum;
                                });
                                if (foundEp && foundEp.name) {
                                    currentEpTitle = foundEp.name;
                                }
                            }
                        }
                    }

                    const fields = {
                        title: group.title,
                        chineseTitle: group.title,
                        englishTitle: group.englishTitle,
                        year: group.year,
                        tmdbId: group.tmdbId,
                        mediaType: group.mediaType,
                        category: group.category || (isTv ? '剧集' : '电影'),
                        secondaryCategory: group.secondaryCategory || '',
                        season: String(effSeasonVal),
                        seasonEpisode: seasonEpisodeTag,
                        episodeTitle: currentEpTitle,
                        videoFormat: finalSpecs.videoFormat,
                        mediaSource: finalSpecs.mediaSource,
                        resourceType: finalSpecs.resourceType,
                        effect: finalSpecs.effect,
                        highQuality: finalSpecs.highQuality,
                        dolbyVision: finalSpecs.dolbyVision,
                        colorDepth: finalSpecs.colorDepth,
                        videoCodec: finalSpecs.videoCodec,
                        dynamicRange: finalSpecs.dynamicRange,
                        frameRate: finalSpecs.frameRate,
                        audioCodec: finalSpecs.audioCodec,
                        originalEdition: (() => {
                            if (!isTv) return finalSpecs.originalEdition;
                            const vTag = RecognitionEngine.extractMediaVariantTag(file.name, true);
                            if (vTag && !/^(?:Part\d+|[上中下])$/i.test(vTag)) {
                                const normV = vTag.replace(/[\s._'-]+/g, '').toUpperCase();
                                const normE = String(finalSpecs.originalEdition || '').replace(/[\s._'-]+/g, '').toUpperCase();
                                if (normV === normE || normV.includes(normE) || normE.includes(normV)) {
                                    return ''; // 剧集已在 SxxEyy 锚点注入，模板技术规格位抑制重复输出
                                }
                            }
                            return finalSpecs.originalEdition;
                        })(),
                        releaseGroup: finalSpecs.releaseGroup,
                        mediaFolderOverride: group.mediaFolderOverride
                    };

                    let specFolder = '';
                    if (isTv) {
                        specFolder = RecognitionEngine.buildSeasonFolder(fields, RecognitionEngine.DEFAULT_TEMPLATES.specSeasonFolder);
                        if (isVideo) {
                            const sKey = String(effSeasonVal);
                            if (!seasonVariantMap.has(sKey)) seasonVariantMap.set(sKey, new Set());
                            seasonVariantMap.get(sKey).add(specFolder);
                        }
                    }

                    preparedFiles.push({
                        file,
                        isVideo,
                        isSidecar,
                        isDiscard,
                        fileExtWithDot,
                        effSeasonVal,
                        effEpisode,
                        seasonEpisodeTag,
                        fields,
                        specFolder,
                        matchedOfficialEp,
                        isSpecialFile
                    });
                }

                // 第二阶段：根据每季版本数决定季目录，并构建重命名与移动任务
                for (const prep of preparedFiles) {
                    const { file, isVideo, isSidecar, isDiscard, fileExtWithDot, effSeasonVal, effEpisode, seasonEpisodeTag, fields, specFolder, matchedOfficialEp, isSpecialFile } = prep;

                    let resolvedSeasonFolder = null;
                    if (isTv) {
                        const sKey = String(effSeasonVal);
                        const variants = seasonVariantMap.get(sKey);
                        // ★ 核心修复：受控开关 splitSeasonBySpecs 控制是否按规格拆分季目录
                        //   默认关闭（false）：保持纯净季目录 Season X，全季集数完整聚拢，避免肢解断层；
                        //   用户显式开启（true）：才允许在检测到多版本规格时拆分子季目录 Season X [规格]
                        const shouldSplit = effSettings.splitSeasonBySpecs === true || (Context.settings.tmdb && Context.settings.tmdb.splitSeasonBySpecs === true);
                        if (shouldSplit && variants && variants.size >= 2) {
                            resolvedSeasonFolder = specFolder;
                        }
                    }

                    const targetNaming = RecognitionEngine.buildStandardTargetName(fields, fileExtWithDot, inPlace, resolvedSeasonFolder);

                    // 核心优化：字幕保留语言/变体标识 (如 .chs.ass, .cht.ass, .zh-CN.ass, .双语.ass)；视频保留多CD/分部标识 (Part01/Part02)
                    let finalFilename = targetNaming.filename;
                    const isUnmatchedSpecial = !matchedOfficialEp && !file._lockedEpisode && isSpecialFile;
                    if (isUnmatchedSpecial) {
                        finalFilename = file.name;
                    } else if (isSidecar) {
                        const subTag = RecognitionEngine.extractSubtitleTag(file.name);
                        const [stem, ext] = RecognitionEngine.splitExtension(targetNaming.filename);
                        finalFilename = subTag ? `${stem}.${subTag}${ext}` : `${stem}${ext}`;
                    } else if (isVideo) {
                        const variantTag = RecognitionEngine.extractMediaVariantTag(file.name, isTv);
                        if (variantTag) {
                            if (isTv) {
                                // 剧集场景：修订单/分卷标签 (Directors.Cut/Part01/加更版) 统一锚定注入在 SxxEyy 之后
                                finalFilename = RecognitionEngine.injectVariantTag(targetNaming.filename, variantTag);
                            } else {
                                // 电影场景：IMAX/导剪版/加长版已由模板 originalEdition 权威管理，变体注入仅限物理切片 (Part01/上集等)
                                const isPhysicalPart = /^(?:Part\d+|[上中下])$/i.test(variantTag);
                                if (isPhysicalPart) {
                                    finalFilename = RecognitionEngine.injectVariantTag(targetNaming.filename, variantTag);
                                }
                            }
                        }
                    }

                    // ★ 核心保障：用户手动微调文件名最高优先级锁存（防交互重算冲掉）
                    const fKey = String(file.fileId || file.id);
                    const userOverrideName = (group.nameOverrides && group.nameOverrides[fKey]) || file._userNewName;
                    let isUserOverridden = false;
                    if (userOverrideName && typeof userOverrideName === 'string' && userOverrideName.trim()) {
                        finalFilename = userOverrideName.trim();
                        isUserOverridden = true;
                    }

                    let targetFolder = '';
                    let targetPath = '';
                    let isProtected = false;
                    let skipOrganize = false;
                    let taskStatus = 'ready';
                    let decisionReason = '';
                    let isFallbackSeason = false;

                    const isUnmatched = !group.tmdbId;
                    const isSuspicious = Boolean(group.isSuspicious);

                    if (isDiscard) {
                        taskStatus = 'discard';
                        decisionReason = '废弃垃圾文件（缩略图/网址说明等），清理至回收站';
                    } else if (file.probeFailed || file._probedMeta?.probeFailed) {
                        // ★ 核心铁律防线：物理流探测失败（重试耗尽），坚决原地不动保留在源目录！
                        isProtected = true;
                        skipOrganize = true;
                        taskStatus = 'protected';
                        targetFolder = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) || '/' : (file.parentFolderName || '/');
                        targetPath = file.relativePath || ('/' + file.name);
                        finalFilename = file.name;
                        decisionReason = '物理流嗅探失败(已换链重试耗尽)，安全熔断：原地留置暂存区等待自愈';
                    } else if (isUnmatched) {
                        // ★ 核心铁律：识别不了就不要动！原地保护保留在源目录
                        isProtected = true;
                        skipOrganize = true;
                        taskStatus = 'unmatched';
                        targetFolder = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) || '/' : (file.parentFolderName || '/');
                        targetPath = file.relativePath || ('/' + file.name);
                        finalFilename = file.name;
                        decisionReason = '未匹配到 TMDB 官方影视条目，安全熔断：原地保护不移动不改名';
                    } else if (isSuspicious) {
                        // ★ 核心铁律：识别存疑或年份冲突，坚决原地不动存入待处理箱
                        isProtected = true;
                        skipOrganize = true;
                        taskStatus = 'suspicious';
                        targetFolder = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) || '/' : (file.parentFolderName || '/');
                        targetPath = file.relativePath || ('/' + file.name);
                        finalFilename = file.name;
                        decisionReason = group.suspiciousReason || '识别结果存在标题或年份冲突，安全熔断：原地保护存入待处理箱';
                    } else if (isTv && group.tmdbId) {
                        const curS = Number(effSeasonVal);
                        const hasOfficialSeason = (group.seasons || []).some(s => Number(s.season_number ?? s.seasonNumber) === curS);
                        const officialEps = group.seasonEpisodesMap?.[curS] || [];
                        const hasOfficialEps = officialEps.length > 0;
                        const isTmdbMissingSeason = !hasOfficialSeason || !hasOfficialEps;

                        if (isTmdbMissingSeason) {
                            const unmatchedSeasonPolicy = effSettings.unmatchedSeasonPolicy || 'fallbackCleanSeason';
                            if (unmatchedSeasonPolicy === 'protectInPlace') {
                                isProtected = true;
                                skipOrganize = true;
                                taskStatus = 'pending_review';
                                targetFolder = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) || '/' : (file.parentFolderName || '/');
                                targetPath = file.relativePath || ('/' + file.name);
                                finalFilename = file.name;
                                decisionReason = `TMDB 官方暂无第 ${curS} 季数据，已原地保护存入待处理箱`;
                            } else {
                                // fallbackCleanSeason (默认): 自动自愈兜底为纯净季目录 (如 Season 04) 规范归档，绝不报错崩溃！
                                isFallbackSeason = true;
                                taskStatus = 'fallback';
                                const sFolder = targetNaming.seasonFolder || `Season ${String(curS).padStart(2, '0')}`;
                                decisionReason = `TMDB 官方暂无第 ${curS} 季分集数据，已自愈兜底为纯净季目录 (${sFolder}) 规范归档`;
                            }
                        }
                    }

                    if (!isUnmatched && !isSuspicious && (!isProtected || isFallbackSeason)) {
                        if (inPlace) {
                            const rawRel = file.relativePath;
                            const isRootFallback = !rawRel || rawRel === '/' || rawRel === ('/' + file.name) || rawRel === file.name;
                            if (!isRootFallback) {
                                const rel = rawRel.startsWith('/') ? rawRel : '/' + rawRel;
                                const baseDir = rel.slice(0, rel.lastIndexOf('/')) || '/';
                                const segments = baseDir === '/' ? [] : baseDir.split('/').filter(Boolean);

                                while (segments.length > 1) {
                                    const last = segments[segments.length - 1];
                                    if (RecognitionEngine.GENERIC_FOLDERS.test(last) || RecognitionEngine.isCollectionFolder(last)) break;
                                    if (/^(?:cd\s*\d+|disc\s*\d+|part\s*\d+|bd|dvd)$/i.test(last)) { segments.pop(); continue; }
                                    if (/^(?:Season\s*\d{1,3}|Seasons\s*\d{1,3}|S\d{1,3}|第?\s*[0-9零〇一二两兩三四五六七八九十百]+\s*[季期部卷])(?:\s.*)?$/i.test(last)) { segments.pop(); continue; }
                                    if (/^(?:Specials?|SP\d*|Extras?|Bonus|Featurettes?|Behind the Scenes|特别篇|番外|花絮)$/i.test(last)) { segments.pop(); continue; }
                                    if (/^(?:国语|粤语|中配|日配|台配|国配|日语|国日|简日|繁日|中日|英语|韩语|法语|德语|西语|双语|多语|生肉|熟肉|字幕组?|subs?|subtitles?|BDMV|CERTIFICATE|VIDEO_TS|BDROM)$/i.test(last)) { segments.pop(); continue; }
                                    if (/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/i.test(last)) { segments.pop(); continue; }
                                    if (/^\d{1,3}$/.test(last)) { segments.pop(); continue; }
                                    if (/^\d{1,4}[-~～－—–至到]\d{1,4}(?:集|话)?$/i.test(last)) { segments.pop(); continue; }
                                    break;
                                }

                                if (segments.length > 0) {
                                    const last = segments[segments.length - 1];
                                    const isGeneric = RecognitionEngine.isGenericFolder(last);
                                    const cleanLast = RecognitionEngine.cleanAnimeFolderName(last).toLowerCase();
                                    const titleLower = String(group.title || '').toLowerCase();
                                    const origTitleLower = String(group.englishTitle || '').toLowerCase();
                                    const tmdbIdStr = String(group.tmdbId || '');
                                    const hasTmdbMatch = Boolean(tmdbIdStr && last.includes(tmdbIdStr));
                                    const hasTitleMatch = Boolean(cleanLast && (
                                        (cleanLast.length >= 2 && titleLower.includes(cleanLast)) ||
                                        (titleLower.length >= 2 && cleanLast.includes(titleLower)) ||
                                        (origTitleLower.length >= 3 && cleanLast.includes(origTitleLower))
                                    ));
                                    const isCurrentMediaFolder = hasTmdbMatch || hasTitleMatch;
                                    if (!isGeneric && isCurrentMediaFolder && targetNaming.folderName) {
                                        segments.pop();
                                    }
                                }

                                if (targetNaming.folderName) {
                                    segments.push(targetNaming.folderName);
                                }
                                if (targetNaming.seasonFolder) {
                                    segments.push(targetNaming.seasonFolder);
                                }
                                targetFolder = '/' + segments.join('/');
                                targetPath = `${targetFolder}/${finalFilename}`.replace(/\/+/g, '/');
                            } else {
                                const primaryCat = isTv ? '剧集' : '电影';
                                const secCat = group.secondaryCategory || RecognitionEngine.inferSecondaryCategory(group.mediaType, group, effSettings);
                                group.secondaryCategory = secCat;
                                targetFolder = `${targetDirPath}/${primaryCat}/${secCat}/${targetNaming.folderName}${targetNaming.seasonFolder ? '/' + targetNaming.seasonFolder : ''}`.replace(/\/+/g, '/');
                                targetPath = `${targetFolder}/${finalFilename}`.replace(/\/+/g, '/');
                                Logger.warn(`[TMDB整理] inPlace降级：${file.name} relativePath缺失，已改走target目录: ${targetFolder}`);
                            }
                        } else {
                            const primaryCat = isTv ? '剧集' : '电影';
                            const secCat = group.secondaryCategory || RecognitionEngine.inferSecondaryCategory(group.mediaType, group, effSettings);
                            group.secondaryCategory = secCat;
                            targetFolder = `${targetDirPath}/${primaryCat}/${secCat}/${targetNaming.folderName}${targetNaming.seasonFolder ? '/' + targetNaming.seasonFolder : ''}`.replace(/\/+/g, '/');
                            targetPath = `${targetFolder}/${finalFilename}`.replace(/\/+/g, '/');
                        }
                    }

                    const rawParentPath = file.relativePath
                        ? (file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : '/')
                        : (file.parentFolderName || '/');
                    const oldParentPath = rawParentPath.startsWith('/') ? rawParentPath : ('/' + rawParentPath);

                    tasks.push({
                        file: file,
                        _probedMeta: file._probedMeta || {},
                        fileId: file.fileId || file.id,
                        oldName: file.name,
                        oldParentPath: oldParentPath,
                        sourcePath: file.relativePath || ('/' + file.name),
                        newName: finalFilename,
                        isUserOverridden: isUserOverridden,
                        seasonEpisode: isTv ? seasonEpisodeTag : '',
                        season: isTv ? Number(effSeasonVal || 1) : null,
                        episode: isTv ? Number(effEpisode || 1) : null,
                        episodeTitle: isTv ? (fields.episodeTitle || '') : '',
                        oldParentId: file.parentFileId || file.parentCatalogId || file.parentFolderId || file.parentId || '',
                        targetFolderPath: targetFolder,
                        targetPath: targetPath,
                        isSidecar: !isVideo,
                        discard: isDiscard,
                        conflictDiscard: false,
                        conflictAction: '',
                        groupId: group.id || group.key,
                        matchedOfficialEp: Boolean(matchedOfficialEp || fields.episodeTitle),
                        isMatched: Boolean(matchedOfficialEp || fields.episodeTitle || file._lockedEpisode || isFallbackSeason),
                        needsManualEpisode: Boolean(isTv && isVideo && isSpecialFile && !matchedOfficialEp && !file._lockedEpisode),
                        fileSize: file.size || 0,
                        isProtected,
                        skipOrganize,
                        isFallbackSeason,
                        status: taskStatus,
                        decisionReason,
                        mediaType: group.mediaType || (isTv ? 'tv' : 'movie'),
                        title: group.title,
                        tmdbId: group.tmdbId,
                        posterPath: group.posterPath
                    });
                }
            }

            // 核心优化：多版本智能消歧与流媒体规范化，杜绝 .part2 串播
            this.resolveGroupCollisions(tasks, groups, settings);

            // 执行冲突预检
            this.annotatePreviewConflicts(tasks);

            const summary = {
                total: tasks.length,
                ready: tasks.filter(t => t.status === 'ready' || t.status === 'fallback').length,
                fallbackCount: tasks.filter(t => t.isFallbackSeason).length,
                protectedCount: tasks.filter(t => t.isProtected || t.skipOrganize).length,
                suspiciousCount: tasks.filter(t => t.status === 'suspicious').length,
                unmatchedCount: tasks.filter(t => t.status === 'unmatched').length,
                discardCount: tasks.filter(t => t.discard || t.conflictDiscard).length
            };

            return {
                groups,
                tasks,
                summary,
                activeGroupIndex: 0,
                settings
            };
        }

        // ★ 单项精准撤销（支持从完成报告列表中单选撤回单独一条）
        static async rollbackSingleTask(t, modeConfig = null) {
            if (!t || !t.fileId) {
                return { success: false, message: '无效文件项' };
            }
            const activeEngine = modeConfig || Context.getActiveEngine();
            let moved = false, renamed = false;

            // 1. 若曾发生跨目录移动，移回原始父目录 oldParentId
            if (t.oldParentId) {
                try {
                    await DriveAPI.batchMove([t.fileId], t.oldParentId, activeEngine);
                    moved = true;
                } catch (err) {
                    Logger.warn(`[TMDB单项撤回] 移回原目录失败 (${t.fileId}):`, err?.message || err);
                }
            }

            // 2. 若曾改名，恢复旧文件名 oldName
            if (t.oldName && t.newName && t.oldName !== t.newName) {
                try {
                    await DriveAPI.rename(t.fileId, t.oldName, activeEngine);
                    renamed = true;
                } catch (err) {
                    Logger.warn(`[TMDB单项撤回] 恢复文件名失败 (${t.fileId}):`, err?.message || err);
                }
            }

            // 3. 同步更新本地存储快照 (剔除已被撤回的单条记录)
            try {
                const raw = localStorage.getItem('139_tmdb_last_organize_snapshot');
                if (raw) {
                    const snap = JSON.parse(raw);
                    snap.tasks = (snap.tasks || []).filter(item => String(item.fileId) !== String(t.fileId));
                    snap.count = snap.tasks.length;
                    if (snap.tasks.length > 0) {
                        localStorage.setItem('139_tmdb_last_organize_snapshot', JSON.stringify(snap));
                    } else {
                        localStorage.removeItem('139_tmdb_last_organize_snapshot');
                    }
                }
            } catch (_) {}

            return { success: true, moved, renamed };
        }

        // ★ 批量整理“后悔药”逆向还原与腾空目录打扫引擎
        static async rollbackLastOrganize(modeConfig = null, options = {}) {
            const rawSnap = localStorage.getItem('139_tmdb_last_organize_snapshot');
            if (!rawSnap) {
                UI.showToast('暂无记录的批量整理快照可供撤销');
                return { success: false, message: '暂无快照' };
            }

            let snapData = null;
            try {
                snapData = JSON.parse(rawSnap);
            } catch (e) {
                localStorage.removeItem('139_tmdb_last_organize_snapshot');
                UI.showToast('撤销快照损坏，已自动清理');
                return { success: false, message: '快照解析失败' };
            }

            const tasks = snapData.tasks || [];
            if (!tasks.length) {
                localStorage.removeItem('139_tmdb_last_organize_snapshot');
                UI.showToast('快照中无可恢复的文件项');
                return { success: false, message: '空快照' };
            }

            const timeStr = new Date(snapData.timestamp).toLocaleTimeString();
            const confirmed = (typeof window !== 'undefined' && typeof window.confirm === 'function')
                ? window.confirm(`确认撤销于 ${timeStr} 执行的批量整理？\n\n将把 ${tasks.length} 个文件原路移回原目录并恢复原文件名。\n此操作安全可逆。`)
                : true;
            if (!confirmed) return { success: false, message: '用户取消' };

            const progressCb = options.onProgress || ((curr, total, msg) => {
                UI.showToast(`[撤销整理] (${curr}/${total}) ${msg}`);
            });

            const activeEngine = modeConfig || Context.getActiveEngine();
            let restoredCount = 0;
            let errorCount = 0;

            try {
                // 1. 按原始目录 oldParentId 聚类批量移回
                const groupsByOldParent = new Map();
                for (const t of tasks) {
                    if (!t.oldParentId) continue;
                    if (!groupsByOldParent.has(t.oldParentId)) groupsByOldParent.set(t.oldParentId, []);
                    groupsByOldParent.get(t.oldParentId).push(t);
                }

                let step = 0;
                const totalSteps = tasks.length * 2;

                for (const [oldParentId, groupTasks] of groupsByOldParent.entries()) {
                    const fileIdsToMove = groupTasks.map(t => t.fileId);
                    try {
                        progressCb(step, totalSteps, `正在将 ${groupTasks.length} 个文件原路移回原目录...`);
                        await DriveAPI.batchMove(fileIdsToMove, oldParentId, activeEngine);
                        step += groupTasks.length;
                    } catch (err) {
                        Logger.warn(`[TMDB撤销] 批量移回原目录失败 (${oldParentId}):`, err?.message || err);
                    }
                }

                // 2. 逐一将文件名恢复为原始旧文件名 oldName
                for (let i = 0; i < tasks.length; i++) {
                    const t = tasks[i];
                    step++;
                    progressCb(step, totalSteps, `正在恢复文件名 (${i + 1}/${tasks.length}): ${t.oldName}`);
                    if (t.oldName && t.newName && t.oldName !== t.newName) {
                        try {
                            await DriveAPI.rename(t.fileId, t.oldName, activeEngine);
                            restoredCount++;
                        } catch (err) {
                            Logger.warn(`[TMDB撤销] 恢复文件名失败 (${t.fileId}):`, err?.message || err);
                            errorCount++;
                        }
                    } else {
                        restoredCount++;
                    }
                }

                // 3. 消费后立即清除快照
                localStorage.removeItem('139_tmdb_last_organize_snapshot');
                UI.showToast(`✓ 已成功撤销上次批量整理！恢复 ${restoredCount} 项${errorCount > 0 ? ` (失败 ${errorCount} 项)` : ''}`);
                Logger.info(`[TMDB撤销] 批量整理撤销完毕: 成功恢复 ${restoredCount} 个文件，快照已自毁`);

                // 4. 尝试刷新当前网盘视图
                try {
                    if (typeof DriveAPI.refreshCurrentFolder === 'function') {
                        DriveAPI.refreshCurrentFolder();
                    }
                } catch (_) {}

                return { success: true, restoredCount, errorCount };
            } catch (globalErr) {
                Logger.error('[TMDB撤销] 撤销批量整理出现未捕获异常:', globalErr);
                UI.showToast('撤销过程中出现异常，请查看控制台日志');
                return { success: false, error: globalErr };
            }
        }

        static async execute(snapshot, modeConfig, options = {}) {
            const onProgress = options.onProgress;
            const tasks = snapshot.tasks;
            const total = tasks.length;
            let successCount = 0, failCount = 0, discardedCount = 0, deletedFolderCount = 0;

            Context.clearCache('path'); // 确保执行整理时路径映射全新解析，杜绝历史缓存污染
            Logger.info(`[TMDB整理] 开始执行媒体整理，共计 ${total} 个任务。`);

            // 1. 批量清理废弃垃圾旁挂与冲突文件入回收站
            const discardTasks = tasks.filter(t => t.discard || t.conflictDiscard);
            if (discardTasks.length > 0) {
                onProgress?.(0, total, `正在清理 ${discardTasks.length} 个废弃旁挂与冲突文件...`);
                const discardIds = discardTasks.map(t => t.fileId);
                Logger.debug(`[TMDB整理] 触发清理 -> 共计 ${discardIds.length} 项`);
                try {
                    await DriveAPI.batchDelete(discardIds, modeConfig);
                    discardedCount += discardTasks.length;
                    Logger.info(`[TMDB整理] 成功清理 ${discardTasks.length} 个废弃文件至回收站。`);
                } catch (e) {
                    Logger.warning(`[TMDB整理] 批量清理文件失败: ${e.message}`);
                }
            }

            const activeTasks = tasks.filter(t => !t.discard && !t.conflictDiscard);
            const folderMap = new Map();
            let protectedCount = 0;
            for (const task of activeTasks) {
                // ★ 铁律防线：识别不了或存疑保护的条目坚决原地不动，绝对不移动、不改名！
                if (task.isProtected || task.skipOrganize || task.status === 'protected' || task.status === 'pending_review' || task.status === 'unmatched' || task.status === 'suspicious') {
                    protectedCount++;
                    task.status = 'protected';
                    try {
                        const { OrganizeProtectionService } = require('./OrganizeProtectionService');
                        OrganizeProtectionService.recordProtection(task, task.decisionReason || '未识别/待处理箱');
                    } catch (_) {}
                    const protectMsg = `[TMDB整理-熔断保护] 文件【${task.oldName}】处于原地保护状态 (${task.decisionReason || '未识别/待处理箱'})，原地保留在源目录`;
                    Logger.info(protectMsg);
                    logTaskEvent(protectMsg);
                    continue;
                }
                if (!folderMap.has(task.targetFolderPath)) {
                    folderMap.set(task.targetFolderPath, []);
                }
                folderMap.get(task.targetFolderPath).push(task);
            }

            let done = 0;
            const movedSourceFolderIds = new Set();

            for (const [folderPath, folderTasks] of folderMap.entries()) {
                if (Context.state.isAbortRequested) {
                    Logger.warning('[TMDB整理] 检测到用户终止信号，立即停止后续目录处理。');
                    break;
                }
                onProgress?.(done, activeTasks.length, `正在准备目标目录: ${folderPath}`);

                let targetDirId = null;
                try {
                    targetDirId = await FileService.resolvePathToId(folderPath, modeConfig, true);
                } catch (e) {
                    Logger.error(`[TMDB整理] 创建目标目录失败 ${folderPath}: ${e.message}`);
                    failCount += folderTasks.length;
                    done += folderTasks.length;
                    continue;
                }

                // 洗版策略与云盘目标目录现有文件画质仲裁
                const washPolicy = modeConfig?.washPolicy || {
                    autoWash: true,
                    keepDolbyMultiVersion: Boolean(options?.keepDolbyMultiVersion || snapshot?.settings?.keepDolbyMultiVersion),
                    enableReleaseGroupPriority: true,
                    preferRemux: true,
                    preferHighResolution: true,
                    preferDolby: true
                };

                const cloud = modeConfig?.cloud139 || modeConfig;
                let existingDiskFiles = [];
                if (cloud && typeof cloud.listDiskDirAll === 'function' && washPolicy.autoWash !== false) {
                    try {
                        const items = await cloud.listDiskDirAll(targetDirId);
                        existingDiskFiles = (items || []).filter(i => i.type !== 'folder');
                    } catch (listErr) {
                        Logger.warn(`[TMDB整理-洗版] 获取目标目录已有文件列表失败: ${listErr.message}`);
                    }
                }

                if (existingDiskFiles.length > 0 && washPolicy.autoWash !== false) {
                    for (const task of folderTasks) {
                        if (task.discard || task.conflictDiscard || task.isSidecar) continue;

                        const matchingExisting = existingDiskFiles.filter(ef => {
                            // 严禁自身与自身比较！若待整理文件已在目标目录（原地整理），或原文件名完全同名，绝不能当做旧版洗版删除
                            if (String(ef.fileId) === String(task.fileId)) return false;
                            if (task.oldName && ef.name && String(task.oldName).trim().toLowerCase() === String(ef.name).trim().toLowerCase()) return false;

                            if (task.seasonEpisode) {
                                const parsedExisting = RecognitionEngine.parseSeasonEpisode(ef.name);
                                const efSeason = parsedExisting.season !== null && parsedExisting.season !== undefined ? parsedExisting.season : 1;
                                const efEp = parsedExisting.episode;
                                if (efEp !== null && efEp !== undefined) {
                                    const efTag = `S${String(efSeason).padStart(2, '0')}E${String(efEp).padStart(2, '0')}`;
                                    const taskTag = String(task.seasonEpisode || '').toUpperCase();
                                    return taskTag.includes(efTag) || efTag.includes(taskTag) || (task.seasonEpisode.replace(/[^0-9]/g, '') === String(efEp));
                                }
                            }
                            const [taskStem] = RecognitionEngine.splitExtension(task.newName);
                            const [efStem] = RecognitionEngine.splitExtension(ef.name);
                            return taskStem.toLowerCase() === efStem.toLowerCase();
                        });

                        for (const matchedExisting of matchingExisting) {
                            const incomingTags = RecognitionEngine.inferTechnicalTags(task.newName, task.fileSize, task._probedMeta || task.file?._probedMeta);
                            const existingTags = RecognitionEngine.inferTechnicalTags(matchedExisting.name, matchedExisting.size);
                            const cmp = RecognitionEngine.compareCandidates(incomingTags, existingTags, washPolicy);

                            Logger.info(`[TMDB整理-画质比对] 进场文件【${task.oldName}】(${incomingTags.resolution || '未知分辨率'}, ${incomingTags.codec || '未知编码'}, ${incomingTags.hdr || 'SDR'}) vs 目标库已有【${matchedExisting.name}】(${existingTags.resolution || '未知分辨率'}, ${existingTags.codec || '未知编码'}, ${existingTags.hdr || 'SDR'}) => 仲裁判定: ${cmp < 0 ? '进场版本更优 (洗版置换)' : cmp > 0 ? '已有版本更优 (淘汰暂存副本)' : '同画质'}`);

                            if (cmp < 0 || (cmp === 0 && /(?:\s*-\s*(?:\d+(?:\.\d+)?(?:GB|MB|G|M)|4K|1080P|v\d+))\./i.test(matchedExisting.name))) {
                                // 新版本质量更优，或旧版带有历史消歧脏后缀 -> 标记洗版置换，延后淘汰（严禁提前删除！只有在新文件成功重命名和移动后才淘汰旧版）
                                task.pendingWashReplaces = task.pendingWashReplaces || [];
                                task.pendingWashReplaces.push({ fileId: matchedExisting.fileId, name: matchedExisting.name });
                                task.washAction = `洗版置换：新版本画质更优，旧版本【${matchedExisting.name}】将在新版入库成功后移入回收站`;
                                task.decisionReason = task.washAction;
                                task.washDetails = {
                                    type: "upgrade",
                                    incomingName: task.newName || task.oldName,
                                    incomingSize: task.fileSize || 0,
                                    incomingTags,
                                    existingName: matchedExisting.name,
                                    existingSize: matchedExisting.size || 0,
                                    existingTags,
                                    cmp
                                };
                                Logger.info(`[TMDB整理-洗版置换规划] 进场文件 (${task.newName}) 优于目标库旧版本 (${matchedExisting.name})，已标记待入库就绪后延后淘汰`);
                            } else if (cmp > 0) {
                                // 目标库中已有更高质量版本 -> 淘汰暂存区次级副本，移入 139 回收站
                                task.conflictDiscard = true;
                                task.conflictAction = `目标媒体库中已有更高画质版本【${matchedExisting.name}】，暂存区次级副本【${task.oldName}】清理移入回收站`;
                                task.decisionReason = task.conflictAction;
                                task.washDetails = {
                                    type: "skipped",
                                    incomingName: task.newName || task.oldName,
                                    incomingSize: task.fileSize || 0,
                                    incomingTags,
                                    existingName: matchedExisting.name,
                                    existingSize: matchedExisting.size || 0,
                                    existingTags,
                                    cmp
                                };
                                try {
                                    await DriveAPI.batchDelete([task.fileId], modeConfig);
                                    discardedCount++;
                                    Logger.info(`[TMDB整理-淘汰清理] 目标媒体库已有更高画质版本 (${matchedExisting.name} > ${task.newName})，已将暂存区次级副本【${task.oldName}】移入 139 回收站！`);
                                    onProgress?.(done, activeTasks.length, `[淘汰清理] 媒体库已有更优版本，暂存区次级副本 ${task.oldName} 已移入回收站`);
                                } catch (delErr) {
                                    Logger.warn(`[TMDB整理-淘汰清理] 清理暂存区次级副本失败: ${delErr.message}`);
                                }
                                break;
                            } else {
                                if (task.newName === matchedExisting.name) {
                                    // 目标库中已存在完全同名文件 -> 淘汰暂存区重复副本，移入 139 回收站
                                    task.conflictDiscard = true;
                                    task.conflictAction = `目标媒体库中已存在完全同名文件【${matchedExisting.name}】，暂存区重复副本【${task.oldName}】清理移入回收站`;
                                    task.decisionReason = task.conflictAction;
                                    task.washDetails = {
                                        type: "duplicate",
                                        incomingName: task.newName || task.oldName,
                                        incomingSize: task.fileSize || 0,
                                        incomingTags,
                                        existingName: matchedExisting.name,
                                        existingSize: matchedExisting.size || 0,
                                        existingTags,
                                        cmp: 0
                                    };
                                    try {
                                        await DriveAPI.batchDelete([task.fileId], modeConfig);
                                        discardedCount++;
                                        Logger.info(`[TMDB整理-同名清理] 目标媒体库已有完全同名文件 (${matchedExisting.name})，已将暂存区重复副本【${task.oldName}】移入 139 回收站！`);
                                        onProgress?.(done, activeTasks.length, `[同名清理] 目标库已有相同文件，暂存区重复副本 ${task.oldName} 已移入回收站`);
                                    } catch (delErr) {
                                        Logger.warn(`[TMDB整理-同名清理] 清理暂存区重复副本失败: ${delErr.message}`);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }

                // 2. 两阶段防死锁重命名机制 (临时命名中转 -> 最终命名)
                const moveIds = [];

                for (const task of folderTasks) {
                    if (Context.state.isAbortRequested) {
                        Logger.warning('[TMDB整理] 检测到用户终止信号，停止当前组剩余文件重命名。');
                        break;
                    }
                    if (task.discard || task.conflictDiscard) {
                        done++;
                        continue;
                    }
                    try {
                        if (task.oldName !== task.newName) {
                            Logger.info(`[TMDB整理-文件重命名] [${done + 1}/${activeTasks.length}] 原名:【${task.oldName}】-> 规范名:【${task.newName}】(ID: ${task.fileId})`);
                            onProgress?.(done, activeTasks.length, `正在重命名: ${task.newName}`);

                            // 若原地重命名且目标同名可能碰撞，先中转临时文件名防死锁
                            const isSameFolder = task.oldParentId === targetDirId;
                            if (isSameFolder) {
                                const tmpName = RecognitionEngine.temporaryName(task.newName);
                                const tmpRes = await DriveAPI.rename(task.fileId, tmpName, modeConfig);
                                if (tmpRes?.notFound) {
                                    Logger.warn(`[TMDB整理-文件跳过] 文件在云端已不存在或已被清理移入回收站，跳过后续操作: ${task.oldName}`);
                                    done++;
                                    continue;
                                }
                                // C6: 两阶段改名之间给服务端 50ms 异步落盘缓冲，防临时名未写入就收到最终名请求
                                await new Promise(r => setTimeout(r, 50));
                            }
                            const renameRes = await DriveAPI.rename(task.fileId, task.newName, modeConfig);
                            if (renameRes?.notFound) {
                                Logger.warn(`[TMDB整理-文件跳过] 文件在云端已不存在或已被清理移入回收站，跳过后续移动: ${task.oldName}`);
                                done++;
                                continue;
                            }
                        }

                        if (task.oldParentId !== targetDirId) {
                            moveIds.push(task.fileId);
                            movedSourceFolderIds.add(task.oldParentId);
                        } else {
                            // 原地重命名且无需移动，改名成功即确立为 success
                            task.status = 'success';
                            successCount++;
                        }
                    } catch (e) {
                        task.status = 'failed';
                        task.error = e.message;
                        failCount++;
                        Logger.error(`[TMDB整理] 处理文件失败 ${task.oldName}: ${e.message}`);
                    }
                    done++;
                    // C5: 每个文件处理后等 150ms，防连续请求触发 139 服务端限速（HTTP 429）
                    await new Promise(r => setTimeout(r, 150));
                }

                if (moveIds.length > 0) {
                    if (Context.state.isAbortRequested) {
                        Logger.warning('[TMDB整理] 检测到用户终止信号，放弃批次移动操作。');
                        break;
                    }
                    try {
                        // C7: 分批提交 batchMove，每批 30 条，批次间等待 300ms
                        // 一次性提交全量 moveIds 时，服务端超时/payload过大会导致整批失败（漏文件根因）
                        const MOVE_BATCH_SIZE = 30;
                        const MOVE_BATCH_DELAY = 300;
                        for (let bi = 0; bi < moveIds.length; bi += MOVE_BATCH_SIZE) {
                            if (Context.state.isAbortRequested) {
                                Logger.warning('[TMDB整理] 批次移动中检测到用户终止信号，立即停止后续批次。');
                                break;
                            }
                            const chunk = moveIds.slice(bi, bi + MOVE_BATCH_SIZE);
                            Logger.info(`[TMDB整理-批量移动] 正在将 ${chunk.length} 个文件批量移动至【${folderPath}】(TargetDirId: ${targetDirId}) [${bi + chunk.length}/${moveIds.length}]`);
                            onProgress?.(done, activeTasks.length, `正在移动 ${bi + chunk.length}/${moveIds.length} 项至 ${folderPath}...`);
                            await DriveAPI.batchMove(chunk, targetDirId, modeConfig);
                            if (bi + MOVE_BATCH_SIZE < moveIds.length) {
                                await new Promise(r => setTimeout(r, MOVE_BATCH_DELAY));
                            }
                        }
                        // 移动成功：将移动项确立为 success
                        folderTasks.filter(t => moveIds.includes(t.fileId) && t.status !== 'failed').forEach(t => {
                            t.status = 'success';
                            successCount++;
                        });
                    } catch (e) {
                        Logger.error(`[TMDB整理] 批量移动至 ${folderPath} 失败: ${e.message}`);
                        // 移动失败：将移动项确立为 failed，绝不虚假上报成功
                        folderTasks.filter(t => moveIds.includes(t.fileId) && t.status !== 'failed').forEach(t => {
                            t.status = 'failed';
                            t.error = `批量移动失败: ${e.message}`;
                            failCount++;
                        });
                    }
                }

                // 3. 执行洗版置换的延后淘汰（只有在新版本重命名与移动完全成功后，才安全将旧版移入回收站，杜绝因改名/移动失败导致目标库空空如也）
                const successfulWashTasks = folderTasks.filter(t => t.status === 'success' && Array.isArray(t.pendingWashReplaces) && t.pendingWashReplaces.length > 0);
                for (const task of successfulWashTasks) {
                    for (const oldFile of task.pendingWashReplaces) {
                        try {
                            Logger.info(`[TMDB整理-洗版置换] 新版本已成功入库 (${task.newName})，旧版本 (${oldFile.name}) 淘汰移入回收站！`);
                            onProgress?.(done, activeTasks.length, `[洗版置换] 旧版本 ${oldFile.name} 已移入回收站`);
                            await DriveAPI.batchDelete([oldFile.fileId], modeConfig);
                            discardedCount++;
                        } catch (delErr) {
                            Logger.warn(`[TMDB整理-洗版置换] 清理旧版本失败: ${delErr.message}`);
                        }
                    }
                }
            }

            // 3. 整理完成后的被搬空源目录逆序自动清理 (参考 123 助手深度优先自底向上清理空目录)
            if (options.cleanEmptySources !== false && !Context.state.isAbortRequested) {
                try {
                    onProgress?.(done, activeTasks.length, '正在检查并清理被搬空的残留源目录...');
                    const folderMap = new Map();
                    // 收集扫描阶段发现的所有源目录与其深度
                    if (Array.isArray(snapshot.sourceFolders)) {
                        for (const f of snapshot.sourceFolders) {
                            if (f && f.id) folderMap.set(f.id, { id: f.id, path: f.path || '', depth: Number(f.depth || 0) });
                        }
                    }
                    // 收集所有发生移动或垃圾清理的任务源父目录
                    for (const task of tasks) {
                        if (task.oldParentId && !folderMap.has(task.oldParentId)) {
                            folderMap.set(task.oldParentId, { id: task.oldParentId, path: '', depth: 0 });
                        }
                    }

                    // 深度逆序排序 (depth DESC，内层子目录优先清理，清空后再删除上层父目录)
                    const sortedFolders = Array.from(folderMap.values()).sort((a, b) => {
                        if (b.depth !== a.depth) return b.depth - a.depth;
                        return (b.path?.length || 0) - (a.path?.length || 0);
                    });

                    // 给予网盘服务端 800ms 异步文件移动/删除结算缓冲
                    await new Promise(r => setTimeout(r, 800));

                    const targetDirPath = snapshot.settings?.targetDirPath || '/媒体库';
                    const sweepRes = await TaskManager.sweepEmptyFolders(sortedFolders, modeConfig, {
                        cleanJunk: true,
                        targetDirPath,
                        onProgress: (msg) => onProgress?.(done, activeTasks.length, msg)
                    });
                    deletedFolderCount = sweepRes.deletedFolderCount || 0;
                    if (deletedFolderCount > 0) {
                        Logger.info(`[TMDB整理] 成功自动清理 ${deletedFolderCount} 个空源目录`);
                    }
                } catch (e) {
                    Logger.warn('[TMDB整理] 清理空源目录异常:', e.message);
                }
            }

            // ★ 批量整理“后悔药”：静默落盘保存上一次批量整理恢复快照
            let snapshotData = null;
            const successfulTasks = tasks.filter(t => t.status === 'success');
            if (successfulTasks.length > 0) {
                for (const t of successfulTasks) {
                    try {
                        const { OrganizeProtectionService } = require('./OrganizeProtectionService');
                        OrganizeProtectionService.markResolved(t.fileId || t.oldName);
                    } catch (_) {}
                }
                try {
                    snapshotData = {
                        timestamp: Date.now(),
                        count: successfulTasks.length,
                        targetDirPath: snapshot.settings?.targetDirPath || '',
                        tasks: successfulTasks.map(t => ({
                            fileId: t.fileId,
                            oldName: t.oldName,
                            newName: t.newName,
                            oldParentId: t.oldParentId,
                            targetFolderPath: t.targetFolderPath,
                            targetFolderId: t.targetFolderId || t.targetParentId
                        }))
                    };
                    localStorage.setItem('139_tmdb_last_organize_snapshot', JSON.stringify(snapshotData));
                    Logger.info(`[TMDB撤销快照] 已成功为本次批量整理记录安全恢复快照 (共 ${successfulTasks.length} 项)`);
                } catch (e) {
                    Logger.warn('[TMDB撤销快照] 记录快照失败:', e.message);
                }
            }

            // ★ 同步持久化至 SQLite WAL 操作日志库 (供媒体整理历史看板与逆向撤回持久查询)
            try {
                const ScrapeJournalService = getScrapeJournalService();
                if (ScrapeJournalService && ScrapeJournalService.batchRepo) {
                    const batch = await ScrapeJournalService.createBatch({
                        driveType: 'cloud139',
                        accountId: Number(modeConfig?.accountId || 0),
                        rootRef: snapshot.settings?.sourceDirId || '',
                        rootPath: snapshot.settings?.sourceDirPath || '',
                        targetRootRef: snapshot.settings?.targetDirId || '',
                        targetRootPath: snapshot.settings?.targetDirPath || '',
                        trigger: 'manual',
                        organize: true
                    });
                    const postInfo = modeConfig?.post || options?.post || snapshot?.settings?.post || null;
                    const postTitle = postInfo?.postTitle || (postInfo?.text ? postInfo.text.split('\n')[0].trim() : '') || '';

                    const ops = tasks.map(t => {
                        const calculatedOldParentPath = t.oldParentPath || (t.sourcePath && t.sourcePath.includes('/') ? t.sourcePath.slice(0, t.sourcePath.lastIndexOf('/')) : '') || t.file?.parentFolderName || '/';
                        return {
                            driveType: 'cloud139',
                            accountId: Number(modeConfig?.accountId || 0),
                            kind: t.isSidecar ? 'subtitle' : 'video',
                            fileRef: String(t.fileId || ''),
                            oldParentRef: String(t.oldParentId || ''),
                            oldParentPath: calculatedOldParentPath,
                            oldName: t.oldName,
                            size: t.fileSize || 0,
                            newParentPath: t.targetFolderPath,
                            newName: t.newName,
                            mediaType: t.mediaType || (t.seasonEpisode ? 'tv' : ((t.targetFolderPath && t.targetFolderPath.includes('电影')) ? 'movie' : 'tv')),
                            tmdbId: t.tmdbId ? String(t.tmdbId) : null,
                            season: (t.mediaType === 'movie' || (!t.mediaType && t.targetFolderPath && t.targetFolderPath.includes('电影'))) ? null : (t.season !== undefined && t.season !== null ? Number(t.season) : null),
                            episode: (t.mediaType === 'movie' || (!t.mediaType && t.targetFolderPath && t.targetFolderPath.includes('电影'))) ? null : (t.episode !== undefined && t.episode !== null ? Number(t.episode) : null),
                            episodeTitle: t.episodeTitle || '',
                            posterPath: t.posterPath || '',
                            title: t.title || '',
                            status: t.status === 'success' ? 'applied' : (t.status === 'failed' ? 'failed' : (t.isProtected ? 'protected' : 'skipped')),
                            reason: t.washAction || t.conflictAction || t.decisionReason || t.error || '',
                            evidence: {
                                originalFolder: calculatedOldParentPath,
                                originalName: t.oldName,
                                episodeTitle: t.episodeTitle || '',
                                posterPath: t.posterPath || '',
                                sourcePath: t.sourcePath || '',
                                postTitle: postTitle,
                                washDetails: t.washDetails || null
                            }
                        };
                    });

                    for (const t of tasks) {
                        const calcOldParent = t.oldParentPath || (t.sourcePath && t.sourcePath.includes('/') ? t.sourcePath.slice(0, t.sourcePath.lastIndexOf('/')) : '') || t.file?.parentFolderName || '/';
                        Logger.info(`[TMDB整理-落盘追踪] 文件: "${t.oldName}" -> "${t.newName}" [${t.status || 'unknown'}], 原父目录: "${calcOldParent}"${postTitle ? `, 来源推文: "${postTitle}"` : ''}`);
                    }

                    const recorded = await ScrapeJournalService.recordOperations(batch.id, ops);
                    const appliedIds = recorded.filter((_, idx) => tasks[idx]?.status === 'success').map(r => r.id);
                    if (appliedIds.length > 0) {
                        await ScrapeJournalService.markApplied(appliedIds);
                    }
                }
            } catch (journalErr) {
                Logger.warn(`[TMDB整理] SQLite 日志持久化异常 (非致命): ${journalErr.message}`);
            }

            const wasAborted = Context.state.isAbortRequested;
            Logger.info(`[TMDB整理] 执行完毕！成功: ${successCount}, 原地保护: ${protectedCount}, 失败: ${failCount}, 清理废弃/冲突: ${discardedCount}${wasAborted ? ' (已被用户终止)' : ''}`);
            return {
                success: !wasAborted && failCount === 0,
                successCount,
                failCount,
                failedCount: failCount,
                discardedCount,
                protectedCount: typeof protectedCount !== 'undefined' ? protectedCount : 0,
                deletedFolderCount: typeof deletedFolderCount !== 'undefined' ? deletedFolderCount : 0,
                aborted: wasAborted,
                snapshotData
            };
        }
    }

module.exports = { TmdbOrganizeService };

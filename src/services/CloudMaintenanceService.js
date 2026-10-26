const path = require('path');
const logger = require('../utils/logger');
const ConfigService = require('./ConfigService');

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.iso', '.rmvb', '.webm', '.mpg', '.mpeg', '.vob'
]);

class Inspector {
    static BANNED_HASHES = ['e4ff93b79cfb91e56ef68df02256c094'];

    static WARNING_URL_MARKERS = [
        'hw-warning',            // 官方违规占位缩略图/预览（png/jpg/mp4/任意后缀）
        'warning%2f',            // URL 编码路径片段
        'warning/',              // 未编码路径片段
        '/warning_',
        'audit-fail',
        'illegal-content',
        'content-warning'
    ];

    static AUDIT_FAIL_CODES = ['3'];
    static AUDIT_FAIL_TEXT = /未通过|不通过|违规|拦截|封禁|禁止|下架|屏蔽|侵权|失效|已删除|不存在/;

    static collectMediaUrls(file) {
        if (!file || typeof file !== 'object') return [];
        const out = [];
        const push = v => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
        if (Array.isArray(file.thumbnailUrls)) {
            file.thumbnailUrls.forEach(t => {
                if (!t) return;
                if (typeof t === 'string') push(t);
                else { push(t.url); push(t.URL); push(t.src); push(t.thumbnailUrl); }
            });
        }
        [
            'thumbnailURL', 'thumbnailUrl', 'smallThumbnailURL', 'midthumbnailURL', 'midthumbnailUrl',
            'bigthumbnailURL', 'bigthumbnailUrl', 'presentURL', 'presentUrl', 'presentLURL', 'presentHURL',
            'coverURL', 'coverUrl', 'posterURL', 'posterUrl', 'imageURL', 'imageUrl', 'previewURL', 'previewUrl'
        ].forEach(k => push(file[k]));
        return out;
    }

    /**
     * 139 云盘 6 层违规判定探针（100% 对齐 123 助手成熟规则）
     * @param {object} file 
     * @returns {string|null} 违规定性原因，未违规返回 null
     */
    static isBanned(file) {
        if (!file || typeof file !== 'object') return null;

        // ① 黑名单哈希
        const hash = (file.contentHash || file.sha256 || file.fileHash || file.digest || '').toLowerCase();
        if (this.BANNED_HASHES.includes(hash)) return '违规文件命中（黑名单特征值）';

        // ② 缩略图 / 预览图被替换为警告占位
        for (const u of this.collectMediaUrls(file)) {
            const low = u.toLowerCase();
            if (this.WARNING_URL_MARKERS.some(m => low.includes(m))) return '违规内容拦截（预览已被替换为警告占位图）';
        }

        // ③ 审核结论字段：兼容数字 3 / 字符串 '3' / 中文结论
        const auditNodes = [file.contentAuditInfo, file.auditInfo, file.audit, file].filter(v => v && typeof v === 'object');
        for (const node of auditNodes) {
            const raw = node.auditResult ?? node.auditStatus ?? node.auditCode ?? node.resultCode ?? node.status;
            if (raw === undefined || raw === null || raw === '') continue;
            const txt = String(raw).trim();
            if (this.AUDIT_FAIL_CODES.includes(txt)) return `内容审核未通过（auditResult=${txt}）`;
            if (this.AUDIT_FAIL_TEXT.test(txt)) return `内容审核未通过（${txt}）`;
        }

        // ④ 审核描述文本字段
        const descText = ['auditResultStr', 'auditDesc', 'auditMessage', 'statusText', 'banReason', 'reason']
            .map(k => (file.contentAuditInfo && file.contentAuditInfo[k]) || file[k])
            .filter(v => typeof v === 'string' && v.trim())
            .join(' ');
        if (descText && this.AUDIT_FAIL_TEXT.test(descText)) return `内容审核未通过（${descText.trim().slice(0, 30)}）`;

        // ⑤ 服务端布尔型封禁标记
        if (file.isBanned === true || file.banned === true || file.isIllegal === true || file.isBlocked === true) {
            return '违规内容拦截（服务端封禁标记）';
        }

        // ⑥ 深度兜底：扫描对象内所有形似 URL 的字符串（限深 3 层）
        const seen = new Set();
        const walk = (node, depth) => {
            if (depth > 3 || !node || typeof node !== 'object' || seen.has(node)) return null;
            seen.add(node);
            for (const k in node) {
                const v = node[k];
                if (typeof v === 'string') {
                    if (/^https?:\/\//i.test(v) || v.includes('/')) {
                        const low = v.toLowerCase();
                        if (this.WARNING_URL_MARKERS.some(m => low.includes(m))) {
                            return `违规内容拦截（字段 ${k} 命中警告占位）`;
                        }
                    }
                } else if (v && typeof v === 'object') {
                    const r = walk(v, depth + 1);
                    if (r) return r;
                }
            }
            return null;
        };
        const deep = walk(file, 0);
        if (deep) return deep;

        return null;
    }
}

class CloudMaintenanceService {
    static Inspector = Inspector;

    static COMPANION_EXTENSIONS = new Set([
        '.nfo', '.strm', '.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx'
    ]);

    /**
     * 判断某文件是否是指定视频文件的同基名伴生文件
     * @param {string} videoBaseName - 视频文件名（不含扩展名）
     * @param {string} candidateFileName - 待判定的文件名
     * @returns {boolean}
     */
    static isCompanionFile(videoBaseName, candidateFileName) {
        if (!videoBaseName || !candidateFileName) return false;
        const vBase = videoBaseName.toLowerCase();
        const cName = candidateFileName.toLowerCase();
        if (!cName.startsWith(vBase + '.')) return false;
        for (const ext of this.COMPANION_EXTENSIONS) {
            if (cName.endsWith(ext)) return true;
        }
        return false;
    }

    /**
     * 确保网盘目录路径存在（逐级查找，不存在则创建）
     * @param {object} cloud139
     * @param {string} folderPath - 如 /.quarantine 或 /隔离区
     * @returns {Promise<string>} 返回目标目录 catalogId/fileId
     */
    static async ensureFolderPath(cloud139, folderPath) {
        const segments = String(folderPath || '')
            .replace(/\\/g, '/')
            .split('/')
            .map(s => s.trim())
            .filter(Boolean);
        if (!segments.length) return '/';

        let currentId = '/';
        for (const seg of segments) {
            let found = null;
            if (typeof cloud139.findFolderByName === 'function') {
                found = await cloud139.findFolderByName(currentId, seg).catch(() => null);
            }
            if (found) {
                currentId = found;
            } else {
                let created = null;
                if (typeof cloud139.createFolderHcy === 'function') {
                    created = await cloud139.createFolderHcy(currentId, seg).catch(() => null);
                } else if (typeof cloud139.createFolder === 'function') {
                    created = await cloud139.createFolder(seg, currentId).catch(() => null);
                }
                const newId = created?.fileId || created?.catalogID || created?.id;
                if (newId) {
                    currentId = newId;
                } else if (typeof cloud139.findFolderByName === 'function') {
                    const retryFound = await cloud139.findFolderByName(currentId, seg).catch(() => null);
                    if (retryFound) currentId = retryFound;
                    else throw new Error(`无法在网盘创建子目录: ${seg}`);
                } else {
                    throw new Error(`无法在网盘创建子目录: ${seg}`);
                }
            }
        }
        return currentId;
    }

    /**
     * 全盘/指定目录递归扫描违规失效文件
     * @param {object} cloud139 - 139 云盘客户端实例
     * @param {object} [options]
     * @returns {Promise<object>} { bannedFiles, scannedFolders, totalFiles, totalBannedSize }
     */
    static async scanBannedFiles(cloud139, options = {}) {
        const startTime = Date.now();
        const rootId = options.rootCatalogId || options.rootCatalogID || '/';
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const scope = options.scope === 'all' ? 'all' : 'video'; // 默认仅扫描视频媒体文件
        const customExts = (Array.isArray(options.customExtensions) ? options.customExtensions : [])
            .map(e => String(e || '').trim().toLowerCase())
            .map(e => (e.startsWith('.') ? e : `.${e}`))
            .filter(Boolean);
        const targetExtensions = new Set([...VIDEO_EXTENSIONS, ...customExts]);

        const autoQuarantine = options.quarantinePath || '/.quarantine';
        const userExcludes = options.excludePaths !== undefined
            ? (Array.isArray(options.excludePaths) ? options.excludePaths : [options.excludePaths])
            : [];
        const rawExcludes = [autoQuarantine, '/.quarantine', '/quarantine', ...userExcludes];
        const excludePaths = Array.from(new Set(rawExcludes))
            .map(p => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, ''))
            .filter(Boolean);
        const ignoredIdsSet = new Set((Array.isArray(options.ignoredIds) ? options.ignoredIds : []).map(String));

        const isPathExcluded = (targetPath) => {
            if (!targetPath) return false;
            const norm = targetPath.replace(/\\/g, '/').replace(/\/+$/, '');
            return excludePaths.some(ep => norm === ep || norm.startsWith(`${ep}/`));
        };

        const rangeDesc = scope === 'all'
            ? '全类型深度排查 (包含所有格式)'
            : `快速巡检 (包含 ${targetExtensions.size} 种格式: ${Array.from(targetExtensions).slice(0, 15).join(', ')}${targetExtensions.size > 15 ? '...' : ''})`;
        logger.info(`[巡检维护] 开始违规失效文件检测，起点: ${rootId}, 范围: ${rangeDesc}, 排除路径: [${excludePaths.join(', ')}], 白名单: ${ignoredIdsSet.size} 项`);
        const bannedFiles = [];
        const queue = [{ id: rootId, path: '' }];
        let scannedFolders = 0;
        let totalFiles = 0;
        let scannedTargetFiles = 0;
        let ignoredCount = 0;
        let totalBannedSize = 0;

        while (queue.length > 0) {
            const current = queue.shift();
            scannedFolders++;
            onProgress({ phase: 'scanning', path: current.path || '/', scannedFolders, totalFiles, bannedCount: bannedFiles.length });

            try {
                let fileList = [];
                let catalogList = [];
                if (typeof cloud139.listDiskDirAll === 'function') {
                    const allItems = await cloud139.listDiskDirAll(current.id).catch(() => []);
                    fileList = allItems.filter(i => i.type !== 'folder');
                    catalogList = allItems.filter(i => i.type === 'folder').map(c => ({
                        catalogID: c.fileId || c.catalogID || c.id,
                        catalogName: c.name || c.catalogName
                    }));
                } else {
                    const dirRes = await cloud139.listDiskDir(current.id);
                    if (dirRes?.fileList || dirRes?.catalogList) {
                        fileList = dirRes.fileList || [];
                        catalogList = dirRes.catalogList || [];
                    } else if (Array.isArray(dirRes?.items)) {
                        fileList = dirRes.items.filter(i => i.type !== 'folder');
                        catalogList = dirRes.items.filter(i => i.type === 'folder').map(c => ({
                            catalogID: c.fileId || c.catalogID || c.id,
                            catalogName: c.name || c.catalogName
                        }));
                    }
                }

                for (const cat of catalogList) {
                    const catName = cat.catalogName || cat.name || '';
                    const catId = cat.catalogID || cat.fileId || cat.id;
                    const subPath = current.path ? `${current.path}/${catName}` : `/${catName}`;
                    if (isPathExcluded(subPath)) {
                        logger.info(`[巡检维护-隔离保护] 自动跳过排除/隔离目录: ${subPath}`);
                        continue;
                    }
                    queue.push({ id: catId, path: subPath });
                }

                for (const file of fileList) {
                    totalFiles++;
                    const fileName = file.contentName || file.name || '';
                    const fileId = String(file.contentID || file.fileId || file.id || '');

                    // 1. 永久白名单跳过
                    if (ignoredIdsSet.has(fileId)) {
                        ignoredCount++;
                        continue;
                    }

                    // 2. 媒体类型范围控制 (全类型排查开启时扫描全部格式；关闭时排查天然视频格式与自定义追加格式)
                    if (scope !== 'all') {
                        const ext = path.extname(fileName).toLowerCase();
                        if (!targetExtensions.has(ext)) {
                            continue;
                        }
                    }

                    scannedTargetFiles++;
                    const filePath = current.path ? `${current.path}/${fileName}` : `/${fileName}`;
                    const banReason = Inspector.isBanned(file);
                    if (banReason) {
                        const size = parseInt(file.contentSize || file.size || '0', 10) || 0;
                        totalBannedSize += size;
                        logger.warn(`[违规探测警报] 定位异常死链文件: ${filePath} (定性: ${banReason})`);
                        bannedFiles.push({
                            id: fileId,
                            name: fileName,
                            path: filePath,
                            parentId: current.id,
                            size,
                            sizeFormatted: formatBytes(size),
                            reason: banReason,
                            contentHash: file.contentHash || file.sha256 || ''
                        });
                    }
                }
            } catch (err) {
                logger.error(`[巡检维护] 扫描目录 ${current.path || '/'} 失败: ${err.message}`);
            }
        }

        const durationMs = Date.now() - startTime;
        const bannedCount = bannedFiles.length;
        const totalBannedSizeFormatted = formatBytes(totalBannedSize);

        onProgress({ phase: 'done', scannedFolders, totalFiles, scannedTargetFiles, ignoredCount, bannedCount, totalBannedSize, totalBannedSizeFormatted, durationMs });
        logger.info(`[巡检维护] 扫描完成: 遍历 ${scannedFolders} 个目录，总文件 ${totalFiles}，检测目标 ${scannedTargetFiles}，白名单跳过 ${ignoredCount}，定位违规 ${bannedCount} 项，耗时 ${durationMs}ms`);
        return {
            bannedFiles,
            scannedFolders,
            totalScannedDirs: scannedFolders,
            totalFiles,
            totalScannedFiles: totalFiles,
            scannedTargetFiles,
            ignoredCount,
            scope,
            bannedCount,
            totalBannedSize,
            totalBannedSizeFormatted,
            durationMs
        };
    }

    /**
     * 复查已删除的文件是否确实已从目录中消失
     * @param {object} cloud139
     * @param {Array<object>} entries - { id, parentId, name }
     * @returns {Promise<object>} { gone: [], stillThere: [] }
     */
    static async verifyIdsGone(cloud139, entries = []) {
        const gone = [];
        const stillThere = [];
        const byParent = new Map();

        for (const e of entries) {
            if (!e.parentId) {
                gone.push(e); // 无法复查直接视为已处理
                continue;
            }
            const list = byParent.get(e.parentId) || [];
            list.push(e);
            byParent.set(e.parentId, list);
        }

        for (const [parentId, items] of byParent.entries()) {
            try {
                const dirRes = await cloud139.listDiskDir(parentId);
                const existingIds = new Set((dirRes?.fileList || []).map(f => String(f.contentID || f.fileId || f.id)));
                for (const item of items) {
                    if (existingIds.has(item.id)) {
                        stillThere.push(item);
                    } else {
                        gone.push(item);
                    }
                }
            } catch (_) {
                // 若父目录无法获取，将项放入 gone
                gone.push(...items);
            }
        }

        return { gone, stillThere };
    }

    /**
     * 分批安全处置违规文件（支持移入回收站 vs 移到隔离区、伴生文件级联、Emby 刷新）
     * @param {object} cloud139
     * @param {Array<object>} bannedFiles
     * @param {object} [options]
     * @returns {Promise<object>}
     */
    static async cleanBannedFiles(cloud139, bannedFiles = [], options = {}) {
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const chunkSize = options.chunkSize || 100;
        const action = options.action === 'quarantine' ? 'quarantine' : 'trash';
        const quarantinePath = options.quarantinePath || '/.quarantine';
        const cascadeCompanion = options.cascadeCompanion === true;
        const notifyEmby = Boolean(options.notifyEmby);
        const pruneEmptyParent = Boolean(options.pruneEmptyParent);

        const validEntries = bannedFiles.filter(f => f && f.id && typeof f.id === 'string' && f.id.trim());
        if (validEntries.length === 0) {
            return {
                action,
                quarantinePath: action === 'quarantine' ? quarantinePath : null,
                successCount: 0,
                cleanedCount: 0,
                failedCount: 0,
                freedBytes: 0,
                freedSizeFormatted: '0 B',
                processedVideos: 0,
                processedCompanions: 0,
                affectedDirectories: [],
                embyResult: { notified: false, reason: '无有效违规文件' },
                prunedEmptyDirsCount: 0,
                stillThere: []
            };
        }

        // 1. 级联探测同基名伴生文件 (.nfo / .srt / .ass / .strm 等)
        const companionEntries = [];
        if (cascadeCompanion) {
            const byParent = new Map();
            for (const v of validEntries) {
                if (v.parentId) {
                    const list = byParent.get(v.parentId) || [];
                    list.push(v);
                    byParent.set(v.parentId, list);
                }
            }
            for (const [parentId, vList] of byParent.entries()) {
                try {
                    let dirFiles = [];
                    if (typeof cloud139.listDiskDirAll === 'function') {
                        const all = await cloud139.listDiskDirAll(parentId).catch(() => []);
                        dirFiles = all.filter(i => i.type !== 'folder');
                    } else if (typeof cloud139.listDiskDir === 'function') {
                        const res = await cloud139.listDiskDir(parentId).catch(() => null);
                        dirFiles = res?.items?.filter(i => i.type !== 'folder') || res?.fileList || [];
                    }
                    const existingIds = new Set(validEntries.map(x => String(x.id)));
                    for (const video of vList) {
                        const vName = video.name || '';
                        const baseName = vName.replace(/\.[^/.]+$/, '');
                        if (!baseName) continue;
                        for (const f of dirFiles) {
                            const fId = String(f.fileId || f.contentID || f.id);
                            const fName = f.name || f.contentName || '';
                            if (existingIds.has(fId)) continue;
                            if (CloudMaintenanceService.isCompanionFile(baseName, fName)) {
                                existingIds.add(fId);
                                const size = parseInt(f.size || f.contentSize || '0', 10) || 0;
                                const parentDir = video.path ? path.dirname(video.path).replace(/\\/g, '/') : '';
                                companionEntries.push({
                                    id: fId,
                                    name: fName,
                                    parentId,
                                    path: parentDir ? `${parentDir}/${fName}` : `/${fName}`,
                                    size,
                                    isCompanion: true,
                                    companionFor: vName
                                });
                            }
                        }
                    }
                } catch (compErr) {
                    logger.warn(`[违规处置-伴生探测] 查询目录伴生文件失败 (parentId: ${parentId}): ${compErr.message}`);
                }
            }
        }

        // 合并所有需要处置的文件
        const allTargets = [...validEntries, ...companionEntries];
        let successCount = 0;
        let failedCount = 0;
        let freedBytes = 0;
        const stillThere = [];

        // 2. 隔离模式目标目录解析与创建
        let quarantineCatalogId = null;
        if (action === 'quarantine') {
            try {
                quarantineCatalogId = await CloudMaintenanceService.ensureFolderPath(cloud139, quarantinePath);
                logger.info(`[违规处置-隔离] 目标隔离目录就绪: path=${quarantinePath}, catalogId=${quarantineCatalogId}`);
            } catch (err) {
                logger.error(`[违规处置-隔离] 确保隔离目录失败: ${err.message}`);
                throw new Error(`无法创建或定位隔离目录 ${quarantinePath}: ${err.message}`);
            }
        }

        logger.info(`[违规处置] 模式=${action}, 目标数=${allTargets.length} (视频 ${validEntries.length}, 伴生 ${companionEntries.length})...`);

        // 3. 分批执行回收站/隔离操作
        for (let i = 0; i < allTargets.length; i += chunkSize) {
            const chunk = allTargets.slice(i, i + chunkSize);
            const chunkIds = chunk.map(x => x.id);

            try {
                if (action === 'quarantine') {
                    if (typeof cloud139.batchMoveHcy === 'function') {
                        await cloud139.batchMoveHcy(chunkIds, quarantineCatalogId);
                    } else if (typeof cloud139.moveFiles === 'function') {
                        await cloud139.moveFiles(chunkIds, [], quarantineCatalogId);
                    } else {
                        throw new Error('当前 139 驱动不支持文件移动');
                    }
                } else {
                    const ok = await cloud139.deleteFiles(chunkIds);
                    if (!ok) {
                        logger.error(`[违规清理] 本批 ${chunk.length} 个未被服务端确认删除`);
                    }
                }

                const vr = await this.verifyIdsGone(cloud139, chunk);
                successCount += vr.gone.length;
                failedCount += vr.stillThere.length;
                stillThere.push(...vr.stillThere);
                vr.gone.forEach(g => { freedBytes += (g.size || 0); });
                logger.info(`[违规处置-复查] 本批确认已移出原目录 ${vr.gone.length} 项，残留 ${vr.stillThere.length} 项`);
            } catch (e) {
                failedCount += chunk.length;
                logger.error(`[违规处置] 批次执行异常: ${e.message}`);
            }

            onProgress({
                current: Math.min(i + chunkSize, allTargets.length),
                total: allTargets.length,
                successCount,
                failedCount,
                freedBytes
            });
            await new Promise(r => setTimeout(r, 200));
        }

        // 4. 收集受影响剧集目录
        const affectedDirPaths = new Set();
        for (const item of validEntries) {
            if (item.path) {
                const dir = path.dirname(item.path).replace(/\\/g, '/');
                if (dir && dir !== '.' && dir !== '/') {
                    affectedDirPaths.add(dir);
                }
            }
        }
        const affectedDirectories = [...affectedDirPaths];

        // 5. Emby 媒体库直连通知联动
        let embyResult = { notified: false, reason: '未勾选' };
        if (notifyEmby && affectedDirectories.length > 0) {
            try {
                const { EmbyService } = require('./emby');
                const embyService = new EmbyService();
                if (embyService.enable && embyService.embyUrl && embyService.embyApiKey) {
                    const embyLibraryPath = ConfigService.getConfigValue('emby.libraryPath') || '';
                    const embyPaths = affectedDirectories.map(p => embyService._replacePath(p, embyLibraryPath));
                    const ok = await embyService.refreshMediaByPaths(embyPaths);
                    embyResult = {
                        notified: Boolean(ok),
                        updatedDirsCount: embyPaths.length,
                        targetPaths: embyPaths
                    };
                    logger.info(`[违规处置-Emby联动] 通知 Emby 增量刷新 ${embyPaths.length} 个目录: ${ok ? '成功' : '失败'}`);
                } else {
                    embyResult = { notified: false, reason: 'Emby 媒体库直连未启用或未配置 ServerUrl/ApiKey' };
                }
            } catch (embyErr) {
                logger.warn(`[违规处置-Emby联动] 发送通知异常: ${embyErr.message}`);
                embyResult = { notified: false, reason: embyErr.message };
            }
        }

        // 6. 若配置了修剪空父目录
        let prunedEmptyDirsCount = 0;
        if (pruneEmptyParent && successCount > 0) {
            const parentIds = [...new Set(validEntries.map(v => v.parentId).filter(Boolean))];
            for (const pid of parentIds) {
                try {
                    let fCount = 0;
                    let cCount = 0;
                    if (typeof cloud139.listDiskDir === 'function') {
                        const check = await cloud139.listDiskDir(pid);
                        fCount = (check?.items?.filter(i => i.type !== 'folder') || check?.fileList || []).length;
                        cCount = (check?.items?.filter(i => i.type === 'folder') || check?.catalogList || []).length;
                    }
                    if (fCount === 0 && cCount === 0) {
                        await cloud139.deleteFiles([pid]);
                        prunedEmptyDirsCount++;
                        logger.info(`[违规处置-修剪空目录] 处置后原父目录变空，已顺手清理: ${pid}`);
                    }
                } catch (pErr) {
                    logger.debug(`[违规处置-修剪空目录] 跳过或失败: ${pErr.message}`);
                }
            }
        }

        // 7. 提取被处置视频的影视元数据（生成和谐墓碑档案）
        const tombstones = [];
        try {
            const { RecognitionEngine } = require('./RecognitionEngine');
            for (const item of validEntries) {
                const isStillThere = stillThere.some(st => String(st.id) === String(item.id));
                if (isStillThere) continue;

                const parsed = RecognitionEngine.parseMediaFilename ? RecognitionEngine.parseMediaFilename(item.name || '') : null;
                const showTitle = parsed?.title || (item.path ? path.basename(path.dirname(item.path)) : '未知剧集');
                const season = parsed?.season ? Number(parsed.season) : 1;
                const episode = parsed?.episode ? Number(parsed.episode) : null;

                tombstones.push({
                    id: `tb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    fileId: item.id,
                    fileName: item.name,
                    showTitle,
                    season,
                    episode,
                    action,
                    quarantinePath: action === 'quarantine' ? quarantinePath : null,
                    originalPath: item.path || '',
                    size: item.size || 0,
                    sizeFormatted: formatBytes(item.size || 0),
                    timestamp: Date.now()
                });
            }
        } catch (tErr) {
            logger.warn(`[违规处置-墓碑记录] 提取墓碑元数据异常: ${tErr.message}`);
        }

        const freedSizeFormatted = formatBytes(freedBytes);
        logger.info(`[违规处置完成] 模式: ${action}, 成功: ${successCount}, 失败: ${failedCount}, 涉及体积: ${freedSizeFormatted}`);

        return {
            action,
            quarantinePath: action === 'quarantine' ? quarantinePath : null,
            successCount,
            cleanedCount: successCount,
            failedCount,
            freedBytes,
            freedSizeFormatted,
            processedVideos: validEntries.length,
            processedCompanions: companionEntries.length,
            affectedDirectories,
            embyResult,
            prunedEmptyDirsCount,
            tombstones,
            stillThere
        };
    }

    /**
     * 安全空文件夹递归自底向上修剪
     * @param {object} cloud139
     * @param {object} [options]
     * @returns {Promise<object>} { deletedFoldersCount, sweptCount, deletedDirs, durationMs }
     */
    static async sweepEmptyFolders(cloud139, options = {}) {
        const startTime = Date.now();
        const rootId = options.rootCatalogId || options.rootCatalogID || '/';
        const ConfigService = require('./ConfigService');
        const customProtected = [...(options.protectedPaths || ['/媒体库', '/media', '/strm'])];
        const exactProtected = [...(options.protectedExactPaths || ['/暂存区'])];
        try {
            const stagingName = ConfigService.getConfigValue('channelMonitor.stagingFolderName', '');
            const targetName = ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName', '');
            if (stagingName) exactProtected.push(stagingName);
            if (targetName) customProtected.push(targetName);
        } catch (_) {}
        const protectedPaths = customProtected
            .map(p => ('/' + String(p).replace(/^\/+|\/+$/g, '')).toLowerCase())
            .filter(p => p && p !== '/');
        const protectedExactPaths = exactProtected
            .map(p => ('/' + String(p).replace(/^\/+|\/+$/g, '')).toLowerCase())
            .filter(p => p && p !== '/');
        const cleanJunk = options.cleanJunk !== undefined ? Boolean(options.cleanJunk) : true;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

        const isProtected = (id, path) => {
            if (!id && !path) return true;
            if (id === '/' || id === '0' || id === '00019700101000000001' || id === rootId) return true;
            if (path) {
                const norm = ('/' + String(path).replace(/^\/+|\/+$/g, '')).toLowerCase();
                if (norm === '/') return true;
                // 媒体库整树保护：自身、子孙及祖先皆受保护
                if (protectedPaths.some(prot => norm === prot || norm.startsWith(prot + '/') || prot.startsWith(norm + '/'))) {
                    return true;
                }
                // 暂存区容器精确保护：保护根目录容器自身与祖先，但放行其内部被搬空的子目录
                if (protectedExactPaths.some(prot => norm === prot || prot.startsWith(norm + '/'))) {
                    return true;
                }
            }
            return false;
        };

        const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '@eaDir']);
        let deletedFoldersCount = 0;
        const deletedDirs = [];

        // 目录条目获取适配器（兼容现代 HCY 与旧版响应）
        async function getDirEntries(folderId) {
            if (typeof cloud139.listDiskDirAll === 'function') {
                const list = await cloud139.listDiskDirAll(folderId).catch(() => []);
                const files = list.filter(i => i.type !== 'folder');
                const folders = list.filter(i => i.type === 'folder');
                return { files, folders };
            }
            const dirRes = await cloud139.listDiskDir(folderId).catch(() => null);
            const items = dirRes?.items ?? dirRes?.fileList ?? [];
            const files = items.filter(i => i.type !== 'folder' && i.category !== 'folder');
            const folders = items.filter(i => i.type === 'folder' || i.category === 'folder');
            if (Array.isArray(dirRes?.catalogList)) {
                for (const cat of dirRes.catalogList) {
                    const cid = cat.catalogID || cat.fileId || cat.id;
                    if (cid && !folders.some(f => (f.fileId || f.id) === cid)) {
                        folders.push({ fileId: cid, name: cat.catalogName || cat.name, type: 'folder' });
                    }
                }
            }
            return { files, folders };
        }

        // 后序遍历（自底向上处理叶子目录）
        async function postOrderSweep(node) {
            try {
                const { files, folders } = await getDirEntries(node.id);

                // 递归处理子目录（自底向上）
                for (const cat of folders) {
                    const catId = cat.fileId || cat.id || cat.catalogID;
                    const catName = cat.name || cat.catalogName;
                    const childPath = node.path ? `${node.path}/${catName}` : `/${catName}`;
                    await postOrderSweep({ id: catId, path: childPath });
                }

                // 严禁修剪起点根目录自身或受保护目录
                if (node.id === rootId || isProtected(node.id, node.path)) {
                    return;
                }

                // 重新读取当前目录内容（子目录可能已在刚才的递归中被删除）
                const refreshed = await getDirEntries(node.id);
                let currentFiles = refreshed.files;
                const currentFolders = refreshed.folders;

                // 如果包含系统垃圾或说明/广告文件且允许清理，先清理垃圾
                if (cleanJunk && currentFiles.length > 0) {
                    const junkFiles = currentFiles.filter(f => {
                        const fname = (f.name || f.contentName || '').toLowerCase();
                        if (JUNK_NAMES.has(fname) || f.size === 0 || f.contentSize === '0') return true;
                        try {
                            const { StagingOrganizeService } = require('./StagingOrganizeService');
                            const ext = fname.includes('.') ? fname.slice(fname.lastIndexOf('.') + 1) : '';
                            return StagingOrganizeService.isAdOrPromoFile(fname, ext, node.path ? `${node.path}/${fname}` : fname);
                        } catch (_) {
                            return false;
                        }
                    });
                    if (junkFiles.length === currentFiles.length) {
                        const junkIds = junkFiles.map(j => String(j.fileId || j.contentID || j.id));
                        await cloud139.deleteFiles(junkIds);
                        currentFiles = [];
                    }
                }

                // 若文件列表为空且子目录列表为空，则当前目录为空目录，安全修剪
                if (currentFiles.length === 0 && currentFolders.length === 0) {
                    logger.info(`[空目录修剪] 发现纯空目录，执行清理: ${node.path} (${node.id})`);
                    const ok = await cloud139.deleteFiles([node.id]);
                    if (ok) {
                        deletedFoldersCount++;
                        deletedDirs.push(node.path);
                        onProgress({ deletedFoldersCount, currentPath: node.path });
                    }
                }
            } catch (err) {
                logger.error(`[空目录修剪] 检查目录 ${node.path} 失败: ${err.message}`);
            }
        }

        logger.info(`[空目录修剪] 启动安全空文件夹递归修剪，起点: ${rootId}`);
        await postOrderSweep({ id: rootId, path: '' });
        const durationMs = Date.now() - startTime;
        logger.info(`[空目录修剪完成] 共修剪 ${deletedFoldersCount} 个空目录，耗时 ${durationMs}ms`);
        return {
            deletedFoldersCount,
            sweptCount: deletedFoldersCount,
            deletedDirs,
            durationMs
        };
    }
}

module.exports = { CloudMaintenanceService, Inspector };

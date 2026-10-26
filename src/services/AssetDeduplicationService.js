const logger = require('../utils/logger');
const { RecognitionEngine } = require('./RecognitionEngine');

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

class AssetDeduplicationService {
    /**
     * 提取文件的媒体资产唯一指纹键 (0 刮削纯计算)
     * @param {string} filename 
     * @returns {object|null} { assetKey, mediaType, title, season, episode, year, parsed }
     */
    static buildMediaAssetKey(filename) {
        if (!filename || typeof filename !== 'string') return null;
        const s = filename.trim();
        if (!s) return null;

        const extMatch = s.match(/\.([a-zA-Z0-9]{2,10})$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : '';
        if (!ext || !RecognitionEngine.VIDEO_EXTENSIONS.has(ext)) {
            return null; // 非视频媒体文件不参与主资产去重
        }

        const parsed = RecognitionEngine.parseMediaFilename(s);
        if (!parsed || !parsed.title) return null;

        const normTitle = RecognitionEngine.normalizeTitleKey(parsed.title);
        if (!normTitle) return null;

        if (parsed.season && parsed.episode) {
            const seasonStr = String(parsed.season).padStart(2, '0');
            const episodeStr = String(parsed.episode).padStart(2, '0');
            return {
                assetKey: `${normTitle}::S${seasonStr}E${episodeStr}`,
                mediaType: 'tv',
                title: parsed.title,
                season: String(parsed.season),
                episode: String(parsed.episode),
                season_episode: `S${seasonStr}E${episodeStr}`,
                parsed
            };
        }

        const yearStr = parsed.year ? String(parsed.year) : 'movie';
        return {
            assetKey: `${normTitle}::${yearStr}`,
            mediaType: 'movie',
            title: parsed.title,
            year: parsed.year || '',
            season_episode: '',
            parsed
        };
    }

    /**
     * 递归遍历指定网盘目录收集文件列表
     * @param {object} cloud139
     * @param {object} [options] - { rootCatalogId: '/' }
     * @returns {Promise<Array<object>>}
     */
    static async scanCloudFiles(cloud139, options = {}) {
        const rootId = options.rootCatalogId || options.rootCatalogID || '/';
        const queue = [{ id: rootId, path: '' }];
        const files = [];

        while (queue.length > 0) {
            const current = queue.shift();
            try {
                // 优先使用 listDiskDirAll 分页全量接口；向下兼容 listDiskDir
                let items = [];
                if (typeof cloud139.listDiskDirAll === 'function') {
                    items = await cloud139.listDiskDirAll(current.id);
                } else if (typeof cloud139.listDiskDir === 'function') {
                    const dirRes = await cloud139.listDiskDir(current.id);
                    items = dirRes?.items || [];
                    if (!items.length && (dirRes?.catalogList || dirRes?.fileList)) {
                        for (const cat of (dirRes.catalogList || [])) {
                            items.push({ fileId: cat.catalogID, name: cat.catalogName, type: 'folder' });
                        }
                        for (const f of (dirRes.fileList || [])) {
                            items.push({ fileId: f.contentID || f.fileId, name: f.contentName || f.name, type: 'file', size: f.contentSize || f.size });
                        }
                    }
                }

                for (const item of (items || [])) {
                    const subPath = current.path ? `${current.path}/${item.name}` : `/${item.name}`;
                    if (item.type === 'folder' || item.isFolder || item.fileType === 1) {
                        queue.push({ id: item.fileId || item.id, path: subPath });
                    } else {
                        files.push({
                            id: String(item.fileId || item.id),
                            name: item.name,
                            path: subPath,
                            parentId: current.id,
                            size: Number(item.size || 0)
                        });
                    }
                }
            } catch (err) {
                logger.error(`[资产遍历] 扫描目录 ${current.path || '/'} 失败: ${err.message}`);
            }
        }
        return files;
    }

    /**
     * 对文件列表进行多版本聚类并根据 5 级策略计算择优去重方案
     * @param {Array<object>} files - 网盘文件列表 [{ id, name, size, path, ... }]
     * @param {object} [policy] - 用户 5 级策略配置 (发布组/Remux/分辨率/杜比/文件大小)
     * @returns {object} 去重分析方案
     */
    static analyzeDuplicates(files = [], policy = {}) {
        const fileList = Array.isArray(files) ? files : [];
        const groupsMap = new Map();
        let scannedCount = 0;

        for (const file of fileList) {
            const name = file?.name || file?.contentName || '';
            const keyInfo = this.buildMediaAssetKey(name);
            if (!keyInfo) continue;

            scannedCount++;
            const fileId = String(file.id || file.contentID || file.fileId || '');
            const size = Number(file.size || file.contentSize || 0);
            const pathStr = file.path || '';

            const enrichedFile = {
                ...file,
                id: fileId,
                name,
                size,
                path: pathStr,
                ...RecognitionEngine.inferTechnicalTags(name, size)
            };

            if (!groupsMap.has(keyInfo.assetKey)) {
                groupsMap.set(keyInfo.assetKey, {
                    assetKey: keyInfo.assetKey,
                    mediaType: keyInfo.mediaType,
                    title: keyInfo.title,
                    season_episode: keyInfo.season_episode || '',
                    files: []
                });
            }
            groupsMap.get(keyInfo.assetKey).files.push(enrichedFile);
        }

        const duplicateGroups = [];
        let totalFreedBytes = 0;
        let redundantFilesCount = 0;

        for (const group of groupsMap.values()) {
            if (group.files.length < 2) {
                continue; // 单一版本无需去重
            }

            // 根据用户 5 级策略进行择优排序（compareCandidates 返回越小越优）
            group.files.sort((a, b) => RecognitionEngine.compareCandidates(a, b, policy));

            const keeper = group.files[0];
            const losers = group.files.slice(1);
            const groupFreedBytes = losers.reduce((acc, cur) => acc + (cur.size || 0), 0);

            totalFreedBytes += groupFreedBytes;
            redundantFilesCount += losers.length;

            duplicateGroups.push({
                assetKey: group.assetKey,
                mediaType: group.mediaType,
                title: group.title,
                season_episode: group.season_episode,
                keeper: {
                    id: keeper.id,
                    name: keeper.name,
                    size: keeper.size,
                    path: keeper.path,
                    videoFormat: keeper.videoFormat,
                    dynamicRange: keeper.dynamicRange,
                    releaseGroup: keeper.releaseGroup,
                    isRemux: keeper.isRemux,
                    isBluRay: keeper.isBluRay
                },
                losers: losers.map(l => ({
                    id: l.id,
                    name: l.name,
                    size: l.size,
                    path: l.path,
                    videoFormat: l.videoFormat,
                    dynamicRange: l.dynamicRange,
                    releaseGroup: l.releaseGroup,
                    isRemux: l.isRemux,
                    isBluRay: l.isBluRay
                })),
                freedBytes: groupFreedBytes,
                freedFormatted: formatBytes(groupFreedBytes)
            });
        }

        return {
            scannedFilesCount: scannedCount,
            duplicateGroupsCount: duplicateGroups.length,
            redundantFilesCount,
            totalFreedBytes,
            totalFreedFormatted: formatBytes(totalFreedBytes),
            groups: duplicateGroups
        };
    }

    /**
     * 执行多版本去重清理（严格移入回收站，防误删熔断）
     * @param {object} cloud139 - Cloud139Service 实例
     * @param {object} plan - analyzeDuplicates 输出的去重方案
     * @param {object} [options] - { dryRun, protectedPaths, chunkSize, transferredFileRepo, onProgress }
     * @returns {Promise<object>}
     */
    static async executePrune(cloud139, plan, options = {}) {
        const dryRun = Boolean(options.dryRun);
        const chunkSize = options.chunkSize || 50;
        const protectedPaths = (options.protectedPaths || []).map(p => p.toLowerCase());
        const transferredFileRepo = options.transferredFileRepo || null;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

        if (!plan || !Array.isArray(plan.groups) || plan.groups.length === 0) {
            return {
                dryRun,
                successCount: 0,
                failedCount: 0,
                freedBytes: 0,
                freedFormatted: '0 B',
                skippedProtected: []
            };
        }

        const isProtectedPath = (filePath) => {
            if (!filePath) return false;
            const norm = ('/' + String(filePath).replace(/^\/+|\/+$/g, '')).toLowerCase();
            if (norm === '/') return true;
            return protectedPaths.some(prot => norm === prot || norm.startsWith(prot + '/'));
        };

        const targetLosers = [];
        const skippedProtected = [];

        for (const group of plan.groups) {
            for (const loser of (group.losers || [])) {
                if (!loser.id) continue;
                if (isProtectedPath(loser.path)) {
                    skippedProtected.push(loser);
                    logger.warn(`[资产去重-白名单拦截] 候选淘汰文件位于受保护目录，跳过: ${loser.path} (${loser.name})`);
                } else {
                    targetLosers.push(loser);
                }
            }
        }

        if (dryRun) {
            logger.info(`[资产去重-DryRun] 探测完成，拟清理 ${targetLosers.length} 个冗余版本，预估释放空间: ${plan.totalFreedFormatted}`);
            return {
                dryRun: true,
                successCount: targetLosers.length,
                failedCount: 0,
                freedBytes: plan.totalFreedBytes,
                freedFormatted: plan.totalFreedFormatted,
                skippedProtected
            };
        }

        if (targetLosers.length === 0) {
            return {
                dryRun: false,
                successCount: 0,
                failedCount: 0,
                freedBytes: 0,
                freedFormatted: '0 B',
                skippedProtected
            };
        }

        let successCount = 0;
        let failedCount = 0;
        let freedBytes = 0;

        logger.info(`[资产去重] 开始将 ${targetLosers.length} 个冗余版本移入 139 回收站...`);

        for (let i = 0; i < targetLosers.length; i += chunkSize) {
            const chunk = targetLosers.slice(i, i + chunkSize);
            const chunkIds = chunk.map(x => x.id);

            try {
                const ok = await cloud139.deleteFiles(chunkIds);
                if (ok) {
                    successCount += chunk.length;
                    const chunkFreed = chunk.reduce((sum, f) => sum + (f.size || 0), 0);
                    freedBytes += chunkFreed;

                    // 若提供 transferredFileRepo，同步清理冗余文件的历史防重漏斗记录
                    if (transferredFileRepo && typeof transferredFileRepo.delete === 'function') {
                        try {
                            const { In } = require('typeorm');
                            await transferredFileRepo.delete({ fileId: In(chunkIds) });
                        } catch (err) {
                            logger.warn(`[资产去重] 同步清理 TransferredFile 记录异常: ${err.message}`);
                        }
                    }
                } else {
                    failedCount += chunk.length;
                    logger.error(`[资产去重] 批次移入回收站未被网盘服务端确认`);
                }
            } catch (err) {
                failedCount += chunk.length;
                logger.error(`[资产去重] 批次执行异常: ${err.message}`);
            }

            onProgress({
                current: Math.min(i + chunkSize, targetLosers.length),
                total: targetLosers.length,
                successCount,
                failedCount,
                freedBytes
            });
            await new Promise(r => setTimeout(r, 100));
        }

        const freedFormatted = formatBytes(freedBytes);
        logger.info(`[资产去重完成] 成功移入回收站: ${successCount}, 失败: ${failedCount}, 释放空间: ${freedFormatted}`);

        return {
            dryRun: false,
            successCount,
            failedCount,
            freedBytes,
            freedFormatted,
            skippedProtected
        };
    }
}

module.exports = { AssetDeduplicationService };

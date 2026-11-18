const logger = require('../utils/logger');
const { AppDataSource } = require('../database');
const { Account } = require('../entities');
const Cloud139Service = require('./Cloud139Service');
const ConfigService = require('./ConfigService');

class AsyncResolveService {
    static currentJob = {
        active: false,
        id: null,
        mode: 'single', // 'single' | 'batch'
        status: 'idle', // 'running' | 'completed' | 'failed' | 'idle' | 'aborted'
        current: 0,
        total: 0,
        percent: 0,
        currentGroupIndex: 0,
        totalGroups: 0,
        groupTitle: '',
        currentFileName: '',
        processedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        startTime: null,
        endTime: null,
        error: null,
        resolvedIds: [],
        completedGroupIds: []
    };
    static abortRequested = false;

    static getStatus() {
        return {
            ...this.currentJob,
            // 浅拷贝数组，防止外部直接引用修改
            resolvedIds: [...this.currentJob.resolvedIds],
            completedGroupIds: [...this.currentJob.completedGroupIds]
        };
    }

    static abort() {
        if (this.currentJob.active) {
            this.abortRequested = true;
            this.currentJob.status = 'aborted';
            logger.warn(`[后台归档任务] 用户手动请求终止当前任务 (jobId=${this.currentJob.id})`);
            return true;
        }
        return false;
    }

    static async startJob(payload) {
        if (this.currentJob.active) {
            throw new Error('后台已有归档任务正在执行中，请等待其执行完成');
        }

        const {
            accountId,
            mode = 'single',
            groups = [],
            targetDirPath = '/媒体库',
            cleanEmptySourceDir = true
        } = payload || {};

        if (!groups || !Array.isArray(groups) || groups.length === 0) {
            throw new Error('缺少待归档的媒体分组列表');
        }

        let grandTotal = 0;
        for (const g of groups) {
            grandTotal += (g.items || []).length;
        }
        if (grandTotal === 0) {
            throw new Error('已勾选分组中未包含任何可归档的视频文件');
        }

        this.abortRequested = false;
        const jobId = 'job_' + Date.now();
        this.currentJob = {
            active: true,
            id: jobId,
            mode,
            status: 'running',
            current: 0,
            total: grandTotal,
            percent: 0,
            currentGroupIndex: 1,
            totalGroups: groups.length,
            groupTitle: groups[0]?.groupTitle || groups[0]?.title || '',
            currentFileName: '',
            processedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            startTime: new Date(),
            endTime: null,
            error: null,
            resolvedIds: [],
            completedGroupIds: []
        };

        logger.info(`[后台归档任务] 已启动后台驻留任务 (jobId=${jobId}, 模式=${mode}, 分组数=${groups.length}, 文件总数=${grandTotal})`);

        // 脱离 HTTP 连接，由 Node.js / Docker 容器后台全权托管执行，即使前端页面关闭也能平稳运行到底
        setImmediate(() => {
            this._runLoop({
                accountId,
                mode,
                groups,
                targetDirPath,
                cleanEmptySourceDir
            }).catch(err => {
                logger.error(`[后台归档任务] 执行异常终止: ${err.message}`, err);
                this.currentJob.active = false;
                this.currentJob.status = 'failed';
                this.currentJob.error = err.message;
                this.currentJob.endTime = new Date();
            });
        });

        return { jobId, total: grandTotal };
    }

    static async _runLoop({ accountId, groups, targetDirPath, cleanEmptySourceDir }) {
        const accountRepo = AppDataSource.getRepository(Account);
        const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
            || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
            || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
        if (!account) {
            throw new Error('未找到有效的 139 移动云盘账号，无法执行归档');
        }

        const cloud139 = Cloud139Service.getInstance(account);
        const { MediaScrapeService } = require('./MediaScrapeService');
        const { ScrapeJournalService } = require('./ScrapeJournalService');
        const { RecognitionEngine } = require('./RecognitionEngine');
        const { MediaProbeService } = require('./MediaProbeService');
        const adapter = await MediaScrapeService.getAdapter({ driveType: 'cloud139', accountId: account.id });

        const channelCfg = ConfigService.getConfigValue('channelMonitor') || {};
        const washPriorityOrder = channelCfg.washPriorityOrder
            || ConfigService.getConfigValue('washPriorityOrder')
            || ['videoFormat', 'dynamicRange', 'videoCodec', 'resourceType', 'releaseGroup', 'colorDepth', 'audioCodec', 'frameRate', 'fileSize'];

        const washPolicy = {
            autoWash: channelCfg.autoWash !== false,
            keepDolbyMultiVersion: Boolean(channelCfg.keepDolbyMultiVersion),
            washPriorityOrder,
            enableReleaseGroupPriority: channelCfg.enableReleaseGroupPriority !== false,
            preferRemux: channelCfg.preferRemux !== false,
            preferHighResolution: channelCfg.preferHighResolution !== false,
            preferDolby: channelCfg.preferDolby !== false,
            conflictMode: channelCfg.conflictMode !== undefined ? channelCfg.conflictMode : 1
        };

        let targetRoot = String(targetDirPath || '/媒体库').trim().replace(/\/+$/, '');
        if (!targetRoot || targetRoot === '/' || targetRoot === '默认媒体库' || targetRoot === '/默认媒体库' || targetRoot.includes('默认媒体库')) {
            targetRoot = '/媒体库';
        }
        if (!targetRoot.startsWith('/')) {
            targetRoot = '/' + targetRoot;
        }
        const targetRootId = await adapter.ensureDirPath(targetRoot);

        let batch = await ScrapeJournalService.createBatch({
            driveType: 'cloud139',
            accountId: Number(account.id),
            rootRef: '/',
            rootPath: '/',
            targetRootRef: targetRootId,
            targetRootPath: targetRoot,
            trigger: 'async_background_resolve',
            organize: true
        });

        const targetDirFileCache = new Map();
        const sourceFoldersToClean = new Set();
        let totalMovedTasks = [];

        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            if (this.abortRequested) {
                logger.warn(`[后台归档任务] 检测到中止请求，提前退出分组循环`);
                break;
            }

            const g = groups[gIdx];
            const groupTitle = g.groupTitle || g.title || '';
            const groupTmdbId = String(g.targetTmdbId || g.tmdbId || '');
            const groupYear = g.targetYear || g.year || '';
            const groupMediaType = g.targetMediaType || g.mediaType || 'tv';
            const groupCategory = g.targetCategory || (groupMediaType === 'tv' ? '国产剧' : '电影');
            const groupDefaultSeason = (g.targetSeason !== undefined && g.targetSeason !== null && !isNaN(Number(g.targetSeason))) ? Number(g.targetSeason) : 1;

            this.currentJob.currentGroupIndex = gIdx + 1;
            this.currentJob.groupTitle = groupTitle;

            const items = g.items || [];
            for (const item of items) {
                if (this.abortRequested) {
                    logger.warn(`[后台归档任务] 检测到中止请求，提前退出文件循环`);
                    break;
                }

                try {
                    const fileId = item.fileId || item.id;
                    const oldName = item.name || item.oldName;
                    const tmdbId = String(item.targetTmdbId || item.tmdbId || groupTmdbId);
                    const title = (item.targetTitle || item.title || groupTitle).trim();
                    const year = item.targetYear || item.year || groupYear;
                    const mediaType = item.targetMediaType || item.mediaType || groupMediaType;
                    const category = item.targetCategory || (mediaType === 'tv' ? (groupCategory || '国产剧') : '电影');
                    const season = mediaType === 'tv'
                        ? ((item.targetSeason !== undefined && item.targetSeason !== null && !isNaN(Number(item.targetSeason))) ? Number(item.targetSeason) : ((item.season !== undefined && item.season !== null && !isNaN(Number(item.season))) ? Number(item.season) : groupDefaultSeason))
                        : null;
                    const episode = mediaType === 'tv'
                        ? ((item.targetEpisode !== undefined && item.targetEpisode !== null && !isNaN(Number(item.targetEpisode))) ? Number(item.targetEpisode) : ((item.episode !== undefined && item.episode !== null && !isNaN(Number(item.episode))) ? Number(item.episode) : 1))
                        : null;
                    const episodeTitle = item.targetEpisodeTitle || '';

                    this.currentJob.currentFileName = item.targetNewFileName || oldName;

                    // 1. 深度物理流嗅探
                    let probedMeta = item.probedMeta;
                    if (!probedMeta || !probedMeta.videoFormat) {
                        try {
                            probedMeta = await MediaProbeService.probeFile({
                                fileId,
                                id: fileId,
                                name: oldName,
                                size: item.size || 0,
                                isVideo: true
                            }, cloud139, { forceNetworkProbe: false });
                        } catch (probeErr) {
                            logger.warn(`[后台归档-探针] 嗅探文件 ${oldName} 失败: ${probeErr.message}`);
                        }
                    }

                    // 2. 推导目标相对子路径
                    let subDir = '';
                    let tmdbTag = tmdbId ? ` {tmdb-${tmdbId}}` : '';
                    let titleYear = year ? `${title} (${year})` : title;

                    if (mediaType === 'tv') {
                        const sStr = String(season !== null ? season : 1).padStart(2, '0');
                        subDir = `剧集/${category}/${titleYear}${tmdbTag}/Season ${sStr}`.replace(/\/+/g, '/');
                    } else {
                        subDir = `电影/${category}/${titleYear}${tmdbTag}`.replace(/\/+/g, '/');
                    }

                    // 3. 推导规范化文件名
                    const extMatch = oldName.match(/\.([a-zA-Z0-9]+)$/);
                    const ext = extMatch ? `.${extMatch[1]}` : '.mp4';
                    const tech = RecognitionEngine.inferTechnicalTags(oldName, item.size || 0, probedMeta);

                    const techParts = [];
                    if (tech.resolution) techParts.push(tech.resolution);
                    if (tech.resourceType) techParts.push(tech.resourceType);
                    if (tech.dynamicRange && tech.dynamicRange !== 'SDR') techParts.push(tech.dynamicRange);
                    if (tech.colorDepth && tech.colorDepth !== '8bit') techParts.push(tech.colorDepth);
                    if (tech.videoCodec) techParts.push(tech.videoCodec);
                    if (tech.audioCodec) techParts.push(tech.audioCodec);
                    const techTagStr = techParts.length > 0 ? '.' + techParts.join('.') : '';

                    let newName = '';
                    if (item.targetNewFileName && typeof item.targetNewFileName === 'string' && item.targetNewFileName.trim()) {
                        newName = item.targetNewFileName.trim();
                    } else if (mediaType === 'tv') {
                        const sStr = String(season !== null ? season : 1).padStart(2, '0');
                        const eStr = String(episode || 1).padStart(2, '0');
                        const epTitleStr = episodeTitle ? `.${episodeTitle}` : '';
                        newName = `${title}.${year ? year + '.' : ''}S${sStr}E${eStr}${epTitleStr}${techTagStr}${ext}`;
                    } else {
                        newName = `${title}.${year ? year : ''}${techTagStr}${ext}`;
                    }
                    newName = newName.replace(/\.{2,}/g, '.');

                    // 4. 幂等创建目标目录
                    let currentParentRef = targetRootId;
                    const segs = subDir.split('/').filter(Boolean);
                    for (const seg of segs) {
                        currentParentRef = await adapter.ensureDir(currentParentRef, seg);
                    }

                    // 5. 目标媒体库洗版仲裁比对
                    if (!targetDirFileCache.has(currentParentRef)) {
                        try {
                            const diskFiles = await cloud139.listDiskDirAll(currentParentRef);
                            targetDirFileCache.set(currentParentRef, (diskFiles || []).filter(f => !f.isDir && f.type !== 'folder' && f.fileType !== 1));
                        } catch (err) {
                            logger.warn(`[后台归档] 读取目标目录文件列表失败: ${err.message}`);
                            targetDirFileCache.set(currentParentRef, []);
                        }
                    }
                    const existingDiskFiles = targetDirFileCache.get(currentParentRef) || [];

                    const matchedExisting = existingDiskFiles.find(ef => {
                        if (String(ef.fileId || ef.id) === String(fileId)) return false;
                        if (mediaType === 'tv') {
                            const parsed = RecognitionEngine.parseSeasonEpisode(ef.name);
                            const efSeason = (parsed.season !== null && parsed.season !== undefined) ? parsed.season : 1;
                            const efEp = parsed.episode;
                            return efSeason === (season || 1) && efEp === (episode || 1);
                        } else {
                            return RecognitionEngine.isVideoFile(ef.name);
                        }
                    });

                    let shouldMove = true;
                    let fileToRecycleAfterMove = null;
                    let washLogDetail = '';
                    let finalNewName = newName;

                    if (matchedExisting) {
                        const incomingTags = RecognitionEngine.inferTechnicalTags(newName, item.size || 0, probedMeta);
                        const existingTags = RecognitionEngine.inferTechnicalTags(matchedExisting.name, matchedExisting.size || 0);
                        const decisiveRes = RecognitionEngine.compareCandidatesDecisive(incomingTags, existingTags, washPolicy);
                        const cmp = decisiveRes.cmp;

                        if (cmp < 0 || (cmp === 0 && /(?:\s*-\s*(?:\d+(?:\.\d+)?(?:GB|MB|G|M)|4K|1080P|v\d+))\./i.test(matchedExisting.name))) {
                            fileToRecycleAfterMove = matchedExisting;
                            washLogDetail = `洗版置换旧版【${matchedExisting.name}】（在【${decisiveRes.decisiveLabel}】胜出: ${decisiveRes.decisiveDetail}）`;
                            logger.info(`[后台归档-洗版置换] ${oldName} 在【${decisiveRes.decisiveLabel}】胜出 (${decisiveRes.decisiveDetail})，将在新版入库后移入回收站旧版本: ${matchedExisting.name}`);
                        } else if (cmp > 0) {
                            shouldMove = false;
                            washLogDetail = `洗版拦截：目标媒体库已有更高画质版本【${matchedExisting.name}】（在【${decisiveRes.decisiveLabel}】更优: ${decisiveRes.decisiveDetail}），已拦截清理暂存副本`;
                            logger.info(`[后台归档-洗版拦截] 目标库已有更高画质版本 (${matchedExisting.name} > ${newName})，清理暂存区副本【${oldName}】移入回收站`);

                            try {
                                await cloud139.deleteFiles([fileId]);
                            } catch (delErr) {
                                logger.warn(`[后台归档-洗版拦截] 清理暂存区副本失败: ${delErr.message}`);
                            }

                            const targetDisplayDir = `${targetRoot}/${subDir}`.replace(/\/+/g, '/');
                            await ScrapeJournalService.recordOperations(batch.id, [{
                                driveType: 'cloud139',
                                accountId: Number(account.id),
                                kind: 'video',
                                fileRef: fileId,
                                oldParentRef: item.parentFolderId || '/',
                                oldParentPath: item.oldPath || item.relativePath || '/',
                                oldName,
                                newName,
                                newParentPath: targetDisplayDir,
                                targetSubDir: subDir,
                                mediaType,
                                tmdbId: tmdbId || null,
                                season,
                                episode,
                                title,
                                year: year ? String(year) : null,
                                confidence: 500,
                                status: 'discarded',
                                source: 'async_resolve_wash_intercept'
                            }]);

                            if (item.parentFolderId) {
                                sourceFoldersToClean.add(item.parentFolderId);
                            }

                            this.currentJob.skippedCount++;
                            this.currentJob.resolvedIds.push(fileId);
                            this.currentJob.current++;
                            this.currentJob.percent = Math.round((this.currentJob.current / this.currentJob.total) * 100);
                            continue;
                        } else {
                            const isDvPair = washPolicy.keepDolbyMultiVersion && (
                                (incomingTags.dynamicRange === 'DV') !== (existingTags.dynamicRange === 'DV')
                            );
                            if (isDvPair) {
                                const tag = incomingTags.dynamicRange === 'DV' ? 'DV' : 'SDR';
                                const dot = newName.lastIndexOf('.');
                                const stem = dot > 0 ? newName.slice(0, dot) : newName;
                                const fileExt = dot > 0 ? newName.slice(dot) : '';
                                finalNewName = `${stem} - ${tag}${fileExt}`;
                                washLogDetail = `杜比双版本共存，自动追加 [${tag}] 标识`;
                            }
                        }
                    }

                    // 6. 记录 WAL
                    const targetDisplayDir = `${targetRoot}/${subDir}`.replace(/\/+/g, '/');
                    const [record] = await ScrapeJournalService.recordOperations(batch.id, [{
                        driveType: 'cloud139',
                        accountId: Number(account.id),
                        kind: 'video',
                        fileRef: fileId,
                        oldParentRef: item.parentFolderId || '/',
                        oldParentPath: item.oldPath || item.relativePath || '/',
                        oldName,
                        newName: finalNewName,
                        newParentRef: String(currentParentRef),
                        newParentPath: targetDisplayDir,
                        targetSubDir: subDir,
                        mediaType,
                        tmdbId: tmdbId || null,
                        season,
                        episode,
                        title,
                        year: year ? String(year) : null,
                        confidence: 500,
                        status: 'applying',
                        source: 'async_background_resolve'
                    }]);

                    // 7. 两阶段安全重命名与移动入库
                    let renameDone = false;
                    if (finalNewName !== oldName) {
                        try {
                            await adapter.rename(fileId, finalNewName);
                            renameDone = true;
                        } catch (rnErr) {
                            logger.warn(`[后台归档-重命名] 源端重命名 ${oldName} -> ${finalNewName} 遇阻 (${rnErr.message})，将在移动入库后重试`);
                        }
                    }
                    await adapter.batchMove([fileId], currentParentRef);
                    if (finalNewName !== oldName && !renameDone) {
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                await new Promise(r => setTimeout(r, 600 * attempt));
                                await adapter.rename(fileId, finalNewName);
                                renameDone = true;
                                logger.info(`[后台归档-重命名] 目标目录下重命名 ${oldName} -> ${finalNewName} 成功`);
                                break;
                            } catch (retryErr) {
                                logger.warn(`[后台归档-重命名] 目标目录下重试第 ${attempt} 次失败: ${retryErr.message}`);
                            }
                        }
                    }

                    // 8. 洗版置换旧版回收
                    if (fileToRecycleAfterMove) {
                        try {
                            const oldFileId = fileToRecycleAfterMove.fileId || fileToRecycleAfterMove.id;
                            await cloud139.deleteFiles([oldFileId]);
                            logger.info(`[后台归档-洗版置换] 旧版文件【${fileToRecycleAfterMove.name}】(${oldFileId}) 已安全移入 139 回收站`);
                        } catch (delOldErr) {
                            logger.warn(`[后台归档-洗版置换] 回收旧版文件失败: ${delOldErr.message}`);
                        }
                    }

                    // 标记应用完成
                    await ScrapeJournalService.markApplied([record.id], { [record.id]: fileId });
                    if (ScrapeJournalService.recordRepo) {
                        await ScrapeJournalService.recordRepo.update(record.id, {
                            newParentRef: String(currentParentRef)
                        });
                    }

                    if (item.parentFolderId) {
                        sourceFoldersToClean.add(item.parentFolderId);
                    }

                    this.currentJob.processedCount++;
                    this.currentJob.resolvedIds.push(fileId);
                    totalMovedTasks.push({
                        fileId,
                        originalName: oldName,
                        finalName: finalNewName,
                        targetFolderPath: targetDisplayDir,
                        size: item.size || 0,
                        tmdbId
                    });
                } catch (itemErr) {
                    logger.error(`[后台归档] 处理单个文件失败 (${item.name}): ${itemErr.message}`);
                    this.currentJob.failedCount++;
                } finally {
                    this.currentJob.current++;
                    this.currentJob.percent = Math.round((this.currentJob.current / this.currentJob.total) * 100);
                }
            }

            // 完成该组，推入 completedGroupIds
            const gid = g.groupId || g.id;
            if (gid) {
                this.currentJob.completedGroupIds.push(gid);
            }
        }

        // 9. 清理空源目录
        if (cleanEmptySourceDir && sourceFoldersToClean.size > 0 && !this.abortRequested) {
            for (const fId of sourceFoldersToClean) {
                try {
                    const subEntries = await adapter.listDir(fId).catch(() => []);
                    if (!subEntries || subEntries.length === 0) {
                        await adapter.deleteDir(fId).catch(() => {});
                    }
                } catch (_) {}
            }
        }

        // 10. Emby 与事件通知
        if (totalMovedTasks.length > 0) {
            try {
                const EventService = require('./eventService');
                EventService.getInstance().emit('taskComplete', {
                    taskId: 'async-resolve',
                    taskName: `后台智能归档 - 归档 ${totalMovedTasks.length} 部`,
                    sourceMode: 'staging_organize',
                    fileList: totalMovedTasks.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    items: totalMovedTasks.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    task: {
                        id: 'async-resolve',
                        account,
                        name: `后台智能归档 - 归档 ${totalMovedTasks.length} 部`,
                        resourceName: '后台归档',
                        realFolderName: totalMovedTasks[0]?.targetFolderPath || '',
                        disableRename: true
                    }
                });
            } catch (_) {}
        }

        this.currentJob.active = false;
        this.currentJob.status = this.abortRequested ? 'aborted' : 'completed';
        this.currentJob.percent = 100;
        this.currentJob.endTime = new Date();
        logger.info(`[后台归档任务] 全流程执行完毕: 状态=${this.currentJob.status}, 成功=${this.currentJob.processedCount}, 拦截=${this.currentJob.skippedCount}, 失败=${this.currentJob.failedCount}`);
    }
}

module.exports = { AsyncResolveService };

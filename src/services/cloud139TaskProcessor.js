const { Cloud139Service } = require('./cloud139');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { TaskCompleteEventDto } = require('../dto/TaskCompleteEventDto');
const CheckpointManager = require('./checkpointManager');
const { ErrorClassifier } = require('./errorClassifier');

async function saveShareBatchWithRetryAndVerify({
    cloud139,
    linkID,
    coPathLst,
    targetCatalogID,
    needPassword,
    expectedNames = [],
    checkpoint = null,
    batchKey = '',
    taskService = null,
    task = null,
}) {
    const hasCheckpointCtx = checkpoint && batchKey && taskService && task;
    const alreadySubmitted = hasCheckpointCtx && CheckpointManager.isFolderSubmitted(checkpoint, batchKey);

    if (alreadySubmitted) {
        logTaskEvent(`[139] 检测到批次已提交转存(${batchKey})，跳过重复转存，仅做可见性确认`);
    } else {
        const saveRes = await cloud139.saveShareFilesWithRetry(
            linkID,
            coPathLst,
            [],
            targetCatalogID,
            needPassword,
            { maxAttempts: 3, baseDelayMs: 700 }
        );
        if (!saveRes) {
            throw new Error('转存失败');
        }

        // 先落检查点，再做可见性确认；即使确认超时，重试也不会重复提交转存。
        if (hasCheckpointCtx) {
            checkpoint = CheckpointManager.updateProgress(checkpoint, { submittedFolder: batchKey });
            await CheckpointManager.saveCheckpoint(taskService.taskRepo, task, checkpoint);
        }
    }

    // 异步转存任务存在延迟可见，轮询目标目录确认文件已落盘。
    const visibility = await cloud139.waitForFilesVisible(targetCatalogID, expectedNames, {
        timeoutMs: 90000,
        intervalMs: 2000,
    });
    if (!visibility.allVisible) {
        throw new Error(`转存可见性校验失败，仍缺少 ${visibility.missing.length} 个文件`);
    }

    return checkpoint;
}

function toPlainObject(value) {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
    return {};
}

/**
 * 判断检查点是否已达到完成态（用于清理陈旧检查点，避免重复恢复）。
 * @param {object|null} checkpoint
 * @returns {boolean}
 */
function isCheckpointCompleted(checkpoint) {
    if (!checkpoint) return false;
    const totalBatches = Number(checkpoint.metadata?.totalBatches || 0);
    const currentBatchIndex = Number(checkpoint.currentBatchIndex || 0);
    return totalBatches > 0 && currentBatchIndex >= totalBatches;
}

/**
 * 生成推送文案：
 * - 单次新增 >= threshold 时使用摘要，避免消息过长；
 * - 小批量保留明细，方便直接查看文件名。
 */
function buildPushMessageWithThreshold({
    title,
    fileCount,
    detailLines = [],
    compactLines = [],
    threshold = 20,
}) {
    if (fileCount >= threshold) {
        return `${title}\n${compactLines.join('\n')}`;
    }
    return `${title}\n${detailLines.join('\n')}`;
}

function buildNameToFileIdMap(files = []) {
    const map = new Map();
    for (const f of files) {
        const name = String(f?.name || '').trim();
        const fileId = String(f?.fileId || '').trim();
        if (!name || !fileId || map.has(name)) continue;
        map.set(name, fileId);
    }
    return map;
}

function dedupeTransferCandidates(files = [], getBucketKey = () => 'default') {
    const unique = [];
    const seenSource = new Set();
    const seenName = new Set();
    let droppedBySource = 0;
    let droppedByName = 0;

    for (const f of files) {
        const bucket = String(getBucketKey(f) || 'default');
        const sourceId = String(f?.path || f?.coID || '').trim();
        const name = String(f?.coName || '').trim().toLowerCase();

        if (sourceId) {
            const sourceKey = `${bucket}::${sourceId}`;
            if (seenSource.has(sourceKey)) {
                droppedBySource += 1;
                continue;
            }
            seenSource.add(sourceKey);
        }

        if (name) {
            const nameKey = `${bucket}::${name}`;
            if (seenName.has(nameKey)) {
                droppedByName += 1;
                continue;
            }
            seenName.add(nameKey);
        }

        unique.push(f);
    }

    return {
        files: unique,
        droppedBySource,
        droppedByName,
        droppedTotal: droppedBySource + droppedByName,
    };
}

async function processCloud139Task(taskService, task, account) {
    const cloud139 = Cloud139Service.getInstance(account);
    try {
        const linkID = task.shareId;
        const passwd = task.accessCode || '';

        if (task.shareFolderId === 'root-files') {
            const rootDirInfo = await cloud139.listShareDir(linkID, passwd, 'root');
            const rootFolderList = rootDirInfo?.folderList ?? [];
            const rootFileListRaw = rootDirInfo?.fileList ?? [];
            let effectiveRootDir = 'root';
            let directFilesRaw = rootFileListRaw;
            if (rootFolderList.length === 1 && rootFileListRaw.length === 0) {
                effectiveRootDir = String(rootFolderList[0].catalogID ?? rootFolderList[0].caID);
                const childDirInfo = await cloud139.listShareDir(linkID, passwd, effectiveRootDir);
                directFilesRaw = childDirInfo?.fileList ?? [];
            }
            const directFiles = directFilesRaw.map((f) => ({ ...f, pCaID: effectiveRootDir }));

            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map((s) => s.toLowerCase());
            const enableOnlySaveMedia = ConfigService.getConfigValue('task.enableOnlySaveMedia');

            const allFiles = directFiles.filter((f) => {
                const fileId = f.path || String(f.coID ?? '');
                if (!fileId) return false;
                const name = (f.coName || '').toLowerCase();
                if (enableOnlySaveMedia && !mediaSuffixs.some((s) => name.endsWith(s))) return false;
                if (!taskService._handleMatchMode(task, { name: f.coName || '' })) return false;
                return true;
            });

            const realFolderCheck = await cloud139.listDiskDir(task.realFolderId).catch(() => null);
            if (!realFolderCheck) {
                logTaskEvent('[139] 根文件目标目录不存在!');
                if (ConfigService.getConfigValue('task.enableAutoCreateFolder')) {
                    await taskService._autoCreateFolder139(cloud139, task);
                } else {
                    throw new Error('目标目录不存在，请检查任务配置或开启自动创建目录');
                }
            }

            let existingNames = new Set();
            try {
                const existingOnDisk = await cloud139.listAllDiskFiles(task.realFolderId);
                existingNames = new Set(existingOnDisk.map((f) => f.name));
            } catch (e) {
                logTaskEvent('[139] 根文件目标目录文件列取失败，降级使用DB记录去重');
            }

            let transferredIds = new Set();
            if (taskService.transferredFileRepo) {
                try {
                    const records = await taskService.transferredFileRepo.find({ where: { taskId: task.id } });
                    transferredIds = new Set((records || []).map((r) => r.fileId));
                    if (transferredIds.size > 0) {
                        logTaskEvent(`[已转存DB] 从数据库加载已转存文件: ${transferredIds.size} 个`);
                    }
                } catch (error) {
                    logTaskEvent(`⚠️ [已转存DB] 加载已转存文件失败: ${error.message}，将仅依赖磁盘检查`);
                }
            }

            const alreadyOnDisk = allFiles.filter((f) => existingNames.has(f.coName || ''));
            if (alreadyOnDisk.length > 0) {
                const toRecord = alreadyOnDisk.filter((f) => !transferredIds.has(f.path || String(f.coID ?? '')));
                if (toRecord.length > 0) {
                    await taskService._recordTransferredFiles(task.id, toRecord.map((f) => ({
                        fileId: f.path || String(f.coID ?? ''),
                        fileName: f.coName || '',
                        md5: null,
                    })));
                    toRecord.forEach((f) => transferredIds.add(f.path || String(f.coID ?? '')));
                }
            }

            const newFiles = allFiles.filter((f) => {
                const fileId = f.path || String(f.coID ?? '');
                if (transferredIds.has(fileId)) return false;
                if (existingNames.size > 0) return !existingNames.has(f.coName || '');
                return true;
            });

            const rootDedup = dedupeTransferCandidates(newFiles, () => `root:${task.realFolderId}`);
            const dedupedNewFiles = rootDedup.files;
            logTaskEvent(`扫描完成: 候选 ${allFiles.length} 个，新增 ${newFiles.length} 个，去重后 ${dedupedNewFiles.length} 个，已转存 ${transferredIds.size} 个`);
            if (rootDedup.droppedTotal > 0) {
                logTaskEvent(`转存去重: 移除 ${rootDedup.droppedTotal} 个重复文件（来源重复 ${rootDedup.droppedBySource} 个，同名重复 ${rootDedup.droppedByName} 个）`);
            }

            if (dedupedNewFiles.length === 0) {
                logTaskEvent(`${task.resourceName}(根目录文件) 没有新文件`);
                logTaskEvent(`跳过后处理 [任务 ${task.id}]: 无新文件`);
                task.currentEpisodes = transferredIds.size;
                task.lastCheckTime = new Date();
                await taskService.taskRepo.save(task);
                return '';
            }

            // root-files 仅一个物理目录批次，也需要检查点保护避免可见性超时后的重复转存。
            let checkpoint = CheckpointManager.loadCheckpoint(task);
            if (isCheckpointCompleted(checkpoint)) {
                logTaskEvent(`[检查点] 任务 ${task.id} 检查点已完成，清理后重新评估增量`);
                await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
                checkpoint = null;
            }
            const isResuming = CheckpointManager.shouldResume(task, checkpoint);
            const rootBatchKey = `root:${task.realFolderId}`;
            if (!checkpoint || !isResuming) {
                checkpoint = CheckpointManager.createCheckpoint({
                    metadata: {
                        totalBatches: 1,
                        startTime: new Date().toISOString(),
                        mode: 'root-files',
                    },
                });
            }

            const coPathLst = dedupedNewFiles.filter((f) => f.path).map((f) => f.path);
            if (coPathLst.length > 0) {
                checkpoint = await saveShareBatchWithRetryAndVerify({
                    cloud139,
                    linkID,
                    coPathLst,
                    targetCatalogID: task.realFolderId,
                    needPassword: !!passwd,
                    expectedNames: dedupedNewFiles.map((f) => f.coName || '').filter(Boolean),
                    checkpoint,
                    batchKey: rootBatchKey,
                    taskService,
                    task,
                });
                checkpoint = CheckpointManager.updateProgress(checkpoint, {
                    processedFolder: rootBatchKey,
                    currentBatchIndex: 1,
                });
                await CheckpointManager.saveCheckpoint(taskService.taskRepo, task, checkpoint);
            }

            await taskService._recordTransferredFiles(task.id, dedupedNewFiles.map((f) => ({
                fileId: f.path || String(f.coID ?? ''),
                fileName: f.coName || '',
                md5: null,
            })));

            const fileCount = dedupedNewFiles.length;
            const firstExecution = !task.lastFileUpdateTime;
            task.status = 'processing';
            task.currentEpisodes = (task.currentEpisodes || 0) + fileCount;
            task.lastFileUpdateTime = new Date();
            task.lastCheckTime = new Date();
            await taskService.taskRepo.save(task);

            const rootDiskFiles = await cloud139.listAllDiskFiles(task.realFolderId).catch(() => []);
            const rootNameToFileId = buildNameToFileIdMap(rootDiskFiles);
            const eventFileList = dedupedNewFiles.map((f) => ({
                id: rootNameToFileId.get(f.coName || '') || f.coID,
                name: f.coName || '',
                md5: null,
            }));
            const mappedCount = eventFileList.filter((f) => rootNameToFileId.has(f.name)).length;
            logTaskEvent(`文件磁盘 ID 映射完成: ${mappedCount}/${eventFileList.length} 个`);

            process.nextTick(() => {
                logTaskEvent(`触发后处理 [任务 ${task.id}]: 共 ${dedupedNewFiles.length} 个文件，首次执行: ${firstExecution ? '是' : '否'}`);
                taskService.eventService.emit('taskComplete', new TaskCompleteEventDto({
                    task,
                    fileList: eventFileList,
                    overwriteStrm: false,
                    firstExecution,
                }));
            });

            const fileNameList = dedupedNewFiles.map((f) => f.coName || '(文件名未知)').filter(Boolean);
            const title = `[追更通知] ${task.resourceName}(根目录文件)追更${fileCount}集`;
            const detailLines = fileNameList.map((name) => `- ${name}`);
            const compactLines = [`${task.resourceName}(根目录文件) 新增 ${fileCount} 个文件`];
            return buildPushMessageWithThreshold({
                title,
                fileCount,
                detailLines,
                compactLines,
                threshold: 20,
            });
        }

        let rootPCaID = (!task.shareFolderId || task.shareFolderId === 'root' || task.shareFolderId === -1 || task.shareFolderId === '-1')
            ? 'root'
            : task.shareFolderId;

        if (rootPCaID === 'root') {
            const rootDirInfo = await cloud139.listShareDir(linkID, passwd, 'root');
            const rootFolders = rootDirInfo?.folderList ?? [];
            const rootFiles = rootDirInfo?.fileList ?? [];
            if (rootFolders.length === 1 && rootFiles.length === 0) {
                rootPCaID = String(rootFolders[0].catalogID ?? rootFolders[0].caID);
            }
        }

        const { files: coLst, catalogMap } = await cloud139.listAllShareFilesWithFolderMap(linkID, passwd, rootPCaID);
        if (!coLst) throw new Error('获取分享信息失败');
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map((s) => s.toLowerCase());
        const enableOnlySaveMedia = ConfigService.getConfigValue('task.enableOnlySaveMedia');

        const allFiles = coLst.filter((f) => {
            const fileId = f.path || String(f.coID ?? '');
            if (!fileId) return false;
            const name = (f.coName || '').toLowerCase();
            if (enableOnlySaveMedia && !mediaSuffixs.some((s) => name.endsWith(s))) return false;
            if (!taskService._handleMatchMode(task, { name: f.coName || '' })) return false;
            return true;
        });

        const realFolderCheck = await cloud139.listDiskDir(task.realFolderId).catch(() => null);
        if (!realFolderCheck) {
            logTaskEvent('[139] 目标目录不存在!');
            const enableAutoCreateFolder = ConfigService.getConfigValue('task.enableAutoCreateFolder');
            if (enableAutoCreateFolder) {
                logTaskEvent('[139] 正在重新创建目录');
                await taskService._autoCreateFolder139(cloud139, task);
            } else {
                throw new Error('目标目录不存在，请检查任务配置或开启自动创建目录');
            }
        }

        const uniquePCaIDs = [...new Set(allFiles.map((f) => String(f.pCaID)))];
        const physicalFolderMap = new Map();
        const pathIdCache = new Map();
        const pathsWithSegments = uniquePCaIDs.map((caID) => ({
            caID,
            segments: taskService._getCatalogPathSegments(caID, rootPCaID, catalogMap),
        })).sort((a, b) => a.segments.length - b.segments.length);

        for (const item of pathsWithSegments) {
            const normalizedSegments = item.segments.map(seg => String(seg || '').trim()).filter(Boolean);
            const pathKey = `${task.realFolderId}/${normalizedSegments.join('/')}`;

            if (!pathIdCache.has(pathKey)) {
                const physicalId = await taskService._ensureCloud139FolderPath(cloud139, task.realFolderId, normalizedSegments);
                pathIdCache.set(pathKey, physicalId);
            }

            physicalFolderMap.set(item.caID, pathIdCache.get(pathKey));
        }

        const diskFilesMap = new Map();
        await Promise.all([...new Set(physicalFolderMap.values())].map(async (physicalId) => {
            try {
                const existing = await cloud139.listAllDiskFiles(physicalId);
                diskFilesMap.set(physicalId, new Set(existing.map((f) => f.name)));
            } catch (e) {
                diskFilesMap.set(physicalId, null);
                logTaskEvent(`[139] 目录 ${physicalId} 文件列取失败，降级使用DB记录去重`);
            }
        }));

        let transferredIds = new Set();
        if (taskService.transferredFileRepo) {
            try {
                const records = await taskService.transferredFileRepo.find({ where: { taskId: task.id } });
                transferredIds = new Set((records || []).map((r) => r.fileId));
                if (transferredIds.size > 0) {
                    logTaskEvent(`[已转存DB] 从数据库加载已转存文件: ${transferredIds.size} 个`);
                }
            } catch (error) {
                logTaskEvent(`⚠️ [已转存DB] 加载已转存文件失败: ${error.message}，将仅依赖磁盘检查`);
            }
        }

        const alreadyOnDisk = allFiles.filter((f) => {
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            const names = diskFilesMap.get(physicalId);
            return names !== null && names !== undefined && names.has(f.coName || '');
        });
        if (alreadyOnDisk.length > 0) {
            const toRecord = alreadyOnDisk.filter((f) => !transferredIds.has(f.path || String(f.coID ?? '')));
            if (toRecord.length > 0) {
                await taskService._recordTransferredFiles(task.id, toRecord.map((f) => ({
                    fileId: f.path || String(f.coID ?? ''),
                    fileName: f.coName || '',
                    md5: null,
                })));
                toRecord.forEach((f) => transferredIds.add(f.path || String(f.coID ?? '')));
            }
            logTaskEvent(`${task.resourceName} 目标目录已有 ${alreadyOnDisk.length} 个文件，跳过`);
        }

        const newFiles = allFiles.filter((f) => {
            const fileId = f.path || String(f.coID ?? '');
            if (transferredIds.has(fileId)) return false;
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            const names = diskFilesMap.get(physicalId);
            if (names !== null && names !== undefined) {
                return !names.has(f.coName || '');
            }
            return true;
        });

        const dedup = dedupeTransferCandidates(newFiles, (f) => {
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            return physicalId || 'unknown-folder';
        });
        const dedupedNewFiles = dedup.files;
        logTaskEvent(`扫描完成: 候选 ${allFiles.length} 个，新增 ${newFiles.length} 个，去重后 ${dedupedNewFiles.length} 个，已转存 ${transferredIds.size} 个`);
        if (dedup.droppedTotal > 0) {
            logTaskEvent(`转存去重: 移除 ${dedup.droppedTotal} 个重复文件（来源重复 ${dedup.droppedBySource} 个，同名重复 ${dedup.droppedByName} 个）`);
        }

        if (dedupedNewFiles.length === 0) {
            logTaskEvent(`${task.resourceName} 没有增量剧集`);
            logTaskEvent(`跳过后处理 [任务 ${task.id}]: 无新文件`);
            const totalExisting = [...diskFilesMap.values()]
                .filter((names) => names !== null)
                .reduce((sum, names) => {
                    let count = 0;
                    names.forEach((name) => {
                        if (mediaSuffixs.some((s) => name.toLowerCase().endsWith(s))) count++;
                    });
                    return sum + count;
                }, 0) || transferredIds.size;
            task.currentEpisodes = totalExisting;
            if (task.lastFileUpdateTime) {
                const daysDiff = (Date.now() - new Date(task.lastFileUpdateTime).getTime()) / 86400000;
                if (daysDiff >= ConfigService.getConfigValue('task.taskExpireDays')) {
                    task.status = 'completed';
                }
            }
            task.lastCheckTime = new Date();
            await taskService.taskRepo.save(task);
            await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
            return '';
        }

        const groupedByFolder = new Map();
        for (const f of dedupedNewFiles) {
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            if (!physicalId) continue;
            if (!groupedByFolder.has(physicalId)) groupedByFolder.set(physicalId, []);
            groupedByFolder.get(physicalId).push(f);
        }

        // P1-01: 初始化检查点
        let checkpoint = CheckpointManager.loadCheckpoint(task);
        if (isCheckpointCompleted(checkpoint)) {
            logTaskEvent(`[检查点] 任务 ${task.id} 检查点已完成，清理后重新评估增量`);
            await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
            checkpoint = null;
        }
        const isResuming = CheckpointManager.shouldResume(task, checkpoint);
        
        if (!checkpoint || !isResuming) {
            // 创建新检查点
            checkpoint = CheckpointManager.createCheckpoint({
                catalogMap: toPlainObject(catalogMap),
                physicalFolderMap: toPlainObject(physicalFolderMap),
                metadata: {
                    totalBatches: groupedByFolder.size,
                    startTime: new Date().toISOString()
                }
            });
        } else {
            logTaskEvent(`[恢复] 任务 ${task.id} 从检查点恢复，进度: ${checkpoint.currentBatchIndex}/${checkpoint.metadata.totalBatches}`);
        }

        let processedBatchCount = Array.isArray(checkpoint.processedFolders) ? checkpoint.processedFolders.length : 0;
        for (const [physicalId, files] of groupedByFolder) {
            // P1-01: 跳过已处理的批次
            if (isResuming && CheckpointManager.isFolderProcessed(checkpoint, physicalId)) {
                logTaskEvent(`[恢复] 跳过已处理的文件夹: ${physicalId}`);
                continue;
            }

            const coPathLst = files.filter((f) => f.path).map((f) => f.path);
            if (!coPathLst.length) {
                continue;
            }

            checkpoint = await saveShareBatchWithRetryAndVerify({
                cloud139,
                linkID,
                coPathLst,
                targetCatalogID: physicalId,
                needPassword: !!passwd,
                expectedNames: files.map((f) => f.coName || '').filter(Boolean),
                checkpoint,
                batchKey: physicalId,
                taskService,
                task,
            });

            // P1-01: 保存批次检查点
            processedBatchCount += 1;
            checkpoint = CheckpointManager.updateProgress(checkpoint, {
                processedFolder: physicalId,
                currentBatchIndex: processedBatchCount
            });
            
            await CheckpointManager.saveCheckpoint(taskService.taskRepo, task, checkpoint);
        }

        const taskInfoList = dedupedNewFiles.map((f) => ({
            fileId: f.path || String(f.coID ?? ''),
            fileName: f.coName || '',
            md5: null,
        }));
        await taskService._recordTransferredFiles(task.id, taskInfoList);

        const fileCount = dedupedNewFiles.filter((f) => {
            const name = (f.coName || '').toLowerCase();
            return mediaSuffixs.some((s) => name.endsWith(s));
        }).length || dedupedNewFiles.length;

        const groupMap = new Map();
        for (const f of dedupedNewFiles) {
            const segments = taskService._getCatalogPathSegments(String(f.pCaID), rootPCaID, catalogMap);
            const label = segments.length > 0 ? segments.join('/') : '';
            if (!groupMap.has(label)) groupMap.set(label, []);
            groupMap.get(label).push(f);
        }
        const lines = [];
        const groups = [...groupMap.entries()];
        for (let gi = 0; gi < groups.length; gi++) {
            const [label, files] = groups[gi];
            lines.push(`  📁 ${task.resourceName}${label ? `/${label}` : ''}/ (${files.length}个)`);
            for (let fi = 0; fi < files.length; fi++) {
                const tree = fi < files.length - 1 ? '  ├─' : '  └─';
                lines.push(`${tree} ${files[fi].coName || '(文件名未知)'}`);
            }
        }

        const resourceName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;
        const summary = `${resourceName} 追更 ${fileCount} 集:\n${lines.join('\n')}`;
        logTaskEvent(summary);
        const compactLines = groups.map(([label, files]) => `- ${resourceName}${label ? `/${label}` : ''}/: ${files.length} 个`);
        const title = `[追更通知] ${resourceName}追更${fileCount}集`;
        const pushMessage = buildPushMessageWithThreshold({
            title,
            fileCount,
            detailLines: lines,
            compactLines,
            threshold: 20,
        });

        const firstExecution = !task.lastFileUpdateTime;
        task.status = 'processing';
        task.lastFileUpdateTime = new Date();
        const existingMediaCount = [...diskFilesMap.values()]
            .filter((names) => names !== null)
            .reduce((sum, names) => {
                let count = 0;
                names.forEach((name) => {
                    if (mediaSuffixs.some((s) => name.toLowerCase().endsWith(s))) count++;
                });
                return sum + count;
            }, 0);
        task.currentEpisodes = existingMediaCount + fileCount;
        task.retryCount = 0;
        task.lastCheckTime = new Date();
        
        // P1-01: 清除检查点（任务完成）
        await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
        
        await taskService.taskRepo.save(task);

        const physicalIdToNameMap = new Map();
        await Promise.all([...new Set(physicalFolderMap.values())].map(async (physicalId) => {
            try {
                const diskFiles = await cloud139.listAllDiskFiles(physicalId);
                physicalIdToNameMap.set(physicalId, buildNameToFileIdMap(diskFiles));
            } catch (_) {
                physicalIdToNameMap.set(physicalId, new Map());
            }
        }));

        let mappedCount = 0;
        const eventFileList = dedupedNewFiles.map((f) => {
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            const nameToFileId = physicalIdToNameMap.get(physicalId) || new Map();
            const mappedId = nameToFileId.get(f.coName || '');
            if (mappedId) mappedCount += 1;
            return {
                id: mappedId || f.coID,
                name: f.coName || '',
                md5: null,
            };
        });
        logTaskEvent(`文件磁盘 ID 映射完成: ${mappedCount}/${eventFileList.length} 个`);

        process.nextTick(() => {
            logTaskEvent(`触发后处理 [任务 ${task.id}]: 共 ${dedupedNewFiles.length} 个文件，首次执行: ${firstExecution ? '是' : '否'}`);
            taskService.eventService.emit('taskComplete', new TaskCompleteEventDto({
                task,
                fileList: eventFileList,
                overwriteStrm: false,
                firstExecution,
            }));
        });

        return pushMessage;
    } catch (err) {
        // 增强错误处理
        const classifiedError = ErrorClassifier.enhance(err);
        
        logTaskEvent(`任务执行错误: ${classifiedError.errorTypeName || '未知'} - ${classifiedError.message}`);
        
        // 记录错误到数据库
        if (taskService.taskErrorService) {
            await taskService.taskErrorService.recordError(task.id, classifiedError, {
                shareLink: task.shareLink,
                shareFolderId: task.shareFolderId,
                accountId: task.accountId
            });
        }

        if (classifiedError.fatal) {
            // 致命错误：直接标记失败
            logTaskEvent(`致命错误，任务标记为失败: [${classifiedError.errorType}] ${classifiedError.message}`);
            task.status = 'failed';
            task.lastError = `[${classifiedError.errorTypeName}] ${classifiedError.message}`;
            task.lastCheckTime = new Date();
            
            // 清除检查点
            await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
            
            await taskService.taskRepo.save(task);
            return '';
        }

        // 可重试错误：保留检查点，交给重试机制处理
        // 使用 taskRetryService.handleTaskFailure 并传入分类后的错误
        if (taskService.taskRetryService) {
            return await taskService.taskRetryService.handleTaskFailure(task, classifiedError);
        } else {
            // 降级处理：直接设置重试
            task.status = 'pending';
            task.retryCount = (task.retryCount || 0) + 1;
            task.nextRetryTime = new Date(Date.now() + 600000); // 默认10分钟后重试
            await taskService.taskRepo.save(task);
            return '';
        }
    }
}

module.exports = {
    processCloud139Task,
};

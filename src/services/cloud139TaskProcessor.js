const { Cloud139Service } = require('./cloud139');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { TaskCompleteEventDto } = require('../dto/TaskCompleteEventDto');

async function saveShareBatchWithRetryAndVerify(cloud139, linkID, coPathLst, targetCatalogID, needPassword, expectedNames = []) {
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

    // 异步转存任务存在延迟可见，轮询目标目录确认文件已落盘。
    const visibility = await cloud139.waitForFilesVisible(targetCatalogID, expectedNames, {
        timeoutMs: 35000,
        intervalMs: 1500,
    });
    if (!visibility.allVisible) {
        throw new Error(`转存可见性校验失败，仍缺少 ${visibility.missing.length} 个文件`);
    }
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

            const transferredIds = taskService.transferredFileRepo
                ? new Set((await taskService.transferredFileRepo.find({ where: { taskId: task.id } })).map((r) => r.fileId))
                : new Set();

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

            if (newFiles.length === 0) {
                logTaskEvent(`${task.resourceName}(根目录文件) 没有新文件`);
                task.currentEpisodes = transferredIds.size;
                task.lastCheckTime = new Date();
                await taskService.taskRepo.save(task);
                return '';
            }

            const coPathLst = newFiles.filter((f) => f.path).map((f) => f.path);
            if (coPathLst.length > 0) {
                await saveShareBatchWithRetryAndVerify(
                    cloud139,
                    linkID,
                    coPathLst,
                    task.realFolderId,
                    !!passwd,
                    newFiles.map((f) => f.coName || '').filter(Boolean)
                );
            }

            await taskService._recordTransferredFiles(task.id, newFiles.map((f) => ({
                fileId: f.path || String(f.coID ?? ''),
                fileName: f.coName || '',
                md5: null,
            })));

            const fileCount = newFiles.length;
            task.currentEpisodes = (task.currentEpisodes || 0) + fileCount;
            task.lastFileUpdateTime = new Date();
            task.lastCheckTime = new Date();
            await taskService.taskRepo.save(task);

            const fileNameList = newFiles.map((f) => f.coName || f.path);
            return `${task.resourceName}(根目录文件) 新增${fileCount}个:\n${fileNameList.join('\n')}`;
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
        await Promise.all(uniquePCaIDs.map(async (caID) => {
            const segments = taskService._getCatalogPathSegments(caID, rootPCaID, catalogMap);
            const physicalId = await taskService._ensureCloud139FolderPath(cloud139, task.realFolderId, segments);
            physicalFolderMap.set(caID, physicalId);
        }));

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

        const transferredIds = taskService.transferredFileRepo
            ? new Set((await taskService.transferredFileRepo.find({ where: { taskId: task.id } })).map((r) => r.fileId))
            : new Set();

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

        if (newFiles.length === 0) {
            logTaskEvent(`${task.resourceName} 没有增量剧集`);
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
            return '';
        }

        const groupedByFolder = new Map();
        for (const f of newFiles) {
            const physicalId = physicalFolderMap.get(String(f.pCaID));
            if (!physicalId) continue;
            if (!groupedByFolder.has(physicalId)) groupedByFolder.set(physicalId, []);
            groupedByFolder.get(physicalId).push(f);
        }
        for (const [physicalId, files] of groupedByFolder) {
            const coPathLst = files.filter((f) => f.path).map((f) => f.path);
            if (!coPathLst.length) continue;
            await saveShareBatchWithRetryAndVerify(
                cloud139,
                linkID,
                coPathLst,
                physicalId,
                !!passwd,
                files.map((f) => f.coName || '').filter(Boolean)
            );
        }

        const taskInfoList = newFiles.map((f) => ({
            fileId: f.path || String(f.coID ?? ''),
            fileName: f.coName || '',
            md5: null,
        }));
        await taskService._recordTransferredFiles(task.id, taskInfoList);

        const fileCount = newFiles.filter((f) => {
            const name = (f.coName || '').toLowerCase();
            return mediaSuffixs.some((s) => name.endsWith(s));
        }).length || newFiles.length;

        const groupMap = new Map();
        for (const f of newFiles) {
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
                lines.push(`${tree} ${files[fi].coName || files[fi].path}`);
            }
        }

        const resourceName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;
        const summary = `${resourceName} 追更 ${fileCount} 集:\n${lines.join('\n')}`;
        logTaskEvent(summary);

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
        await taskService.taskRepo.save(task);

        process.nextTick(() => {
            taskService.eventService.emit('taskComplete', new TaskCompleteEventDto({
                task,
                cloud189: null,
                fileList: newFiles.map((f) => ({ id: f.coID, name: f.coName || '', md5: null })),
                overwriteStrm: false,
                firstExecution,
            }));
        });

        return `${resourceName}追更${fileCount}集: \n${lines.join('\n')}`;
    } catch (err) {
        if (err.fatal) {
            logTaskEvent(`[139] 分享链接已失效 [${err.apiCode}]: ${err.message}`);
            task.status = 'failed';
            task.lastError = err.message;
            task.lastCheckTime = new Date();
            await taskService.taskRepo.save(task);
            return '';
        }
        return await taskService._handleTaskFailure(task, err);
    }
}

module.exports = {
    processCloud139Task,
};

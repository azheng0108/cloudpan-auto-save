const path = require('path');
const { Cloud139Service } = require('./cloud139');
const Cloud139Utils = require('../utils/Cloud139Utils');
const { logTaskEvent } = require('../utils/logUtils');
const { SchedulerService } = require('./scheduler');

async function createCloud139Tasks(taskService, params, account, taskDto) {
    const cloud139 = Cloud139Service.getInstance(account);
    const { linkID, passwd } = Cloud139Utils.parseShareLink(taskDto.shareLink);
    const effectivePasswd = taskDto.accessCode || passwd;

    const rootInfo = await cloud139.listShareDir(linkID, effectivePasswd, 'root');
    if (!rootInfo) throw new Error('获取分享信息失败');

    let folderListForLookup = rootInfo.folderList ?? [];
    {
        const rootFiles = rootInfo.fileList ?? [];
        if (folderListForLookup.length === 1 && rootFiles.length === 0) {
            const singleFolderID = folderListForLookup[0].catalogID ?? folderListForLookup[0].caID;
            const childInfo = await cloud139.listShareDir(linkID, effectivePasswd, singleFolderID);
            folderListForLookup = childInfo?.folderList ?? [];
        }
    }

    const linkName = rootInfo.linkName || linkID;
    const taskName = taskDto.taskName || linkName;
    const tasks = [];
    const selectedFolders = taskDto.selectedFolders || [];

    let effectiveTargetFolderId = taskDto.targetFolderId;
    const targetFolderCheck = await cloud139.listDiskDir(effectiveTargetFolderId).catch(() => null);
    if (!targetFolderCheck) {
        const folderPath = taskDto.targetFolder || '';
        logTaskEvent(`[139] 目标目录 fileId(${effectiveTargetFolderId}) 无效，尝试通过路径 "${folderPath}" 重新解析`);
        try {
            effectiveTargetFolderId = await taskService._resolveCloud139FolderByPath(cloud139, folderPath);
            logTaskEvent(`[139] 路径解析成功，新 fileId: ${effectiveTargetFolderId}`);
        } catch (resolveErr) {
            throw new Error(`目标目录不存在或已失效，请重新在账号页面设置常用目录（路径: ${folderPath}）`);
        }
    }

    const matchedRootId = await taskService._findMatchingFolder139(cloud139, effectiveTargetFolderId, taskName);
    let realRootFolderId;
    if (matchedRootId) {
        realRootFolderId = matchedRootId;
        logTaskEvent(`[139] 使用已有目录: "${taskName}" (${matchedRootId})`);
    } else {
        logTaskEvent(`[139] 目标目录下无 "${taskName}"，自动创建`);
        const created = await cloud139.createFolderHcy(effectiveTargetFolderId, taskName);
        if (!created?.fileId) throw new Error(`创建目录 "${taskName}" 失败`);
        realRootFolderId = created.fileId;
        logTaskEvent(`[139] 已创建根目录: "${taskName}" (${realRootFolderId})`);
    }

    const wantsRoot = !selectedFolders.length ||
        selectedFolders.includes('-1') ||
        selectedFolders.includes(-1) ||
        (typeof selectedFolders[0] === 'number' && selectedFolders[0] === -1);

    if (wantsRoot) {
        const task = taskService.taskRepo.create({
            accountId: taskDto.accountId,
            shareLink: taskDto.shareLink,
            shareId: linkID,
            shareFolderId: 'root',
            shareFolderName: '',
            shareMode: 0,
            targetFolderId: effectiveTargetFolderId,
            realFolderId: realRootFolderId,
            realFolderName: path.join(taskDto.targetFolder || '', taskName),
            realRootFolderId: realRootFolderId,
            resourceName: taskName,
            status: 'pending',
            totalEpisodes: taskDto.totalEpisodes,
            currentEpisodes: 0,
            accessCode: effectivePasswd,
            matchPattern: taskDto.matchPattern,
            matchOperator: taskDto.matchOperator,
            matchValue: taskDto.matchValue,
            remark: taskDto.remark,
            enableCron: taskDto.enableCron,
            cronExpression: taskDto.cronExpression,
            sourceRegex: taskDto.sourceRegex,
            targetRegex: taskDto.targetRegex,
            movieRenameFormat: taskDto.movieRenameFormat || '',
            tvRenameFormat: taskDto.tvRenameFormat || '',
            isFolder: true,
        });
        tasks.push(await taskService.taskRepo.save(task));
    }

    if (wantsRoot) {
        if (tasks.length === 0) {
            throw new Error('未选择任何目录，请至少选择一个目录');
        }
        if (taskDto.enableCron) {
            for (const task of tasks) {
                SchedulerService.saveTaskJob(task, taskService);
            }
        }
        return tasks;
    }

    if (selectedFolders.map(String).includes('root-files')) {
        const rootFilesTask = taskService.taskRepo.create({
            accountId: taskDto.accountId,
            shareLink: taskDto.shareLink,
            shareId: linkID,
            shareFolderId: 'root-files',
            shareFolderName: '',
            shareMode: 0,
            targetFolderId: effectiveTargetFolderId,
            realFolderId: realRootFolderId,
            realFolderName: path.join(taskDto.targetFolder || '', taskName),
            realRootFolderId: realRootFolderId,
            resourceName: taskName,
            status: 'pending',
            totalEpisodes: taskDto.totalEpisodes,
            currentEpisodes: 0,
            accessCode: effectivePasswd,
            matchPattern: taskDto.matchPattern,
            matchOperator: taskDto.matchOperator,
            matchValue: taskDto.matchValue,
            remark: taskDto.remark,
            enableCron: taskDto.enableCron,
            cronExpression: taskDto.cronExpression,
            sourceRegex: taskDto.sourceRegex,
            targetRegex: taskDto.targetRegex,
            movieRenameFormat: taskDto.movieRenameFormat || '',
            tvRenameFormat: taskDto.tvRenameFormat || '',
            isFolder: true,
        });
        tasks.push(await taskService.taskRepo.save(rootFilesTask));
        logTaskEvent('[139] 已创建根目录文件任务（仅同步直属文件，不递归子目录）');
    }

    for (const caID of selectedFolders.filter((id) => String(id) !== '-1' && String(id) !== 'root-files')) {
        const folder = folderListForLookup.find((f) => {
            const id = f.catalogID || f.caID;
            return String(id) === String(caID);
        });
        const folderName = folder ? (folder.catalogName || folder.caName || String(caID)) : String(caID);

        const matchedSubId = await taskService._findMatchingFolder139(cloud139, realRootFolderId, folderName);
        let realFolderId;
        if (matchedSubId) {
            realFolderId = matchedSubId;
            logTaskEvent(`[139] 使用已有子目录: "${folderName}" (${matchedSubId})`);
        } else {
            logTaskEvent(`[139] 创建子目录: "${folderName}" 在 (${realRootFolderId})`);
            const createdSub = await cloud139.createFolderHcy(realRootFolderId, folderName);
            if (!createdSub?.fileId) throw new Error(`创建子目录 "${folderName}" 失败`);
            realFolderId = createdSub.fileId;
            logTaskEvent(`[139] 已创建子目录: "${folderName}" (${realFolderId})`);
        }

        const task = taskService.taskRepo.create({
            accountId: taskDto.accountId,
            shareLink: taskDto.shareLink,
            shareId: linkID,
            shareFolderId: String(caID),
            shareFolderName: folderName,
            shareMode: 0,
            targetFolderId: effectiveTargetFolderId,
            realFolderId: realFolderId,
            realFolderName: path.join(taskDto.targetFolder || '', taskName, folderName),
            realRootFolderId: realRootFolderId,
            resourceName: taskName,
            status: 'pending',
            totalEpisodes: taskDto.totalEpisodes,
            currentEpisodes: 0,
            accessCode: effectivePasswd,
            matchPattern: taskDto.matchPattern,
            matchOperator: taskDto.matchOperator,
            matchValue: taskDto.matchValue,
            remark: taskDto.remark,
            enableCron: taskDto.enableCron,
            cronExpression: taskDto.cronExpression,
            sourceRegex: taskDto.sourceRegex,
            targetRegex: taskDto.targetRegex,
            movieRenameFormat: taskDto.movieRenameFormat || '',
            tvRenameFormat: taskDto.tvRenameFormat || '',
            isFolder: true,
        });
        tasks.push(await taskService.taskRepo.save(task));
    }

    if (tasks.length === 0) {
        throw new Error('未选择任何目录，请至少选择一个目录');
    }

    if (taskDto.enableCron) {
        for (const task of tasks) {
            SchedulerService.saveTaskJob(task, taskService);
        }
    }
    return tasks;
}

module.exports = {
    createCloud139Tasks,
};

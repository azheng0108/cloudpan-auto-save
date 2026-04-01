const { Cloud189Service } = require('./cloud189');
const { logTaskEvent } = require('../../utils/logUtils');
const { BatchTaskDto } = require('../../dto/BatchTaskDto');

async function pollBatchTaskStatus(cloud189, taskService, taskId, batchTaskDto, count = 0) {
    if (count > 5) {
        return false;
    }
    const task = await cloud189.checkTaskStatus(taskId, batchTaskDto);
    if (!task) {
        return false;
    }
    logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}`);
    if (task.taskStatus === 3 || task.taskStatus === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return pollBatchTaskStatus(cloud189, taskService, taskId, batchTaskDto, count + 1);
    }
    if (task.taskStatus === 4) {
        return true;
    }
    if (task.taskStatus === 2) {
        const conflictTaskInfo = await cloud189.getConflictTaskInfo(taskId);
        if (!conflictTaskInfo) {
            return false;
        }
        const taskInfos = conflictTaskInfo.taskInfos;
        for (const taskInfo of taskInfos) {
            taskInfo.dealWay = 1;
        }
        await cloud189.manageBatchTask(taskId, conflictTaskInfo.targetFolderId, taskInfos);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return pollBatchTaskStatus(cloud189, taskService, taskId, batchTaskDto, count + 1);
    }
    return false;
}

async function createBatchTask(cloud189, taskService, batchTaskDto) {
    const resp = await cloud189.createBatchTask(batchTaskDto);
    if (!resp) {
        throw new Error('批量任务处理失败');
    }
    if (resp.res_code != 0) {
        throw new Error(resp.res_msg);
    }
    logTaskEvent(`批量任务处理中: ${JSON.stringify(resp)}`);
    const ok = await pollBatchTaskStatus(cloud189, taskService, resp.taskId, batchTaskDto);
    if (!ok) {
        throw new Error('检查批量任务状态: 批量任务处理失败');
    }
    logTaskEvent('批量任务处理完成');
}

async function createBatchTaskLegacy(taskService, cloud189, batchTaskDto) {
    return createBatchTask(cloud189, taskService, batchTaskDto);
}

async function saveShareBatchLegacy(taskService, cloud189, taskInfoList, targetFolderId, shareId) {
    const batchTaskDto = new BatchTaskDto({
        taskInfos: JSON.stringify(taskInfoList),
        type: 'SHARE_SAVE',
        targetFolderId,
        shareId,
    });
    await createBatchTask(cloud189, taskService, batchTaskDto);
}

async function deleteCloudFileLegacy(taskService, cloud189, file, isFolder) {
    if (!file) return;
    const taskInfos = [];
    if (Array.isArray(file)) {
        for (const f of file) {
            taskInfos.push({
                fileId: f.id,
                fileName: f.name,
                isFolder: isFolder,
            });
        }
    } else {
        taskInfos.push({
            fileId: file.id,
            fileName: file.name,
            isFolder: isFolder,
        });
    }
    const batchTaskDto = new BatchTaskDto({
        taskInfos: JSON.stringify(taskInfos),
        type: 'DELETE',
        targetFolderId: '',
    });
    await createBatchTask(cloud189, taskService, batchTaskDto);
}

async function deleteCloudByAccountLegacy(taskService, account, file, isFolder) {
    const cloud189 = Cloud189Service.getInstance(account);
    await deleteCloudFileLegacy(taskService, cloud189, file, isFolder);
}

async function clearRecycleForAccount(cloud189, taskService, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
    const batchTaskDto = new BatchTaskDto({
        taskInfos: '[]',
        type: 'EMPTY_RECYCLE',
    });
    if (enableAutoClearRecycle) {
        logTaskEvent(`开始清空[${username}]个人回收站`);
        await createBatchTask(cloud189, taskService, batchTaskDto);
        logTaskEvent(`清空[${username}]个人回收站完成`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    if (enableAutoClearFamilyRecycle) {
        const familyInfo = await cloud189.getFamilyInfo();
        if (familyInfo == null) {
            logTaskEvent(`用户${username}没有家庭主账号, 跳过`);
            return;
        }
        logTaskEvent(`开始清空[${username}]家庭回收站`);
        batchTaskDto.familyId = familyInfo.familyId;
        await createBatchTask(cloud189, taskService, batchTaskDto);
        logTaskEvent(`清空[${username}]家庭回收站完成`);
    }
}

async function clearLegacy189RecycleBin(taskService, enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
    const accounts = await taskService.accountRepo.find();
    if (!accounts) {
        return;
    }
    for (const account of accounts) {
        if (account.accountType === 'cloud139') continue;
        const username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
        try {
            const cloud189 = Cloud189Service.getInstance(account);
            await clearRecycleForAccount(cloud189, taskService, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle);
        } catch (error) {
            logTaskEvent(`定时[${username}]清空回收站任务执行失败:${error.message}`);
        }
    }
}

module.exports = {
    clearLegacy189RecycleBin,
    createBatchTaskLegacy,
    saveShareBatchLegacy,
    deleteCloudFileLegacy,
    deleteCloudByAccountLegacy,
};

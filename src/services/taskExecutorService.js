const { logTaskEvent } = require('../utils/logUtils');
const harmonizedFilter = require('../utils/BloomFilter');

class TaskExecutorService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async checkTaskStatus(cloud189, taskId, count = 0, batchTaskDto) {
        if (count > 5) {
            return false;
        }
        const type = batchTaskDto.type || 'SHARE_SAVE';
        const task = await cloud189.checkTaskStatus(taskId, batchTaskDto);
        if (!task) {
            return false;
        }
        logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}`);
        if (task.taskStatus == 3 || task.taskStatus == 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return this.checkTaskStatus(cloud189, taskId, count + 1, batchTaskDto);
        }
        if (task.taskStatus == 4) {
            if (task.failedCount > 0 && type == 'SHARE_SAVE') {
                const targetFolderId = batchTaskDto.targetFolderId;
                const fileList = await this.taskService.getAllFolderFiles(cloud189, {
                    enableSystemProxy: false,
                    realFolderId: targetFolderId,
                });
                const taskInfos = JSON.parse(batchTaskDto.taskInfos);
                const conflictFiles = taskInfos.filter((taskInfo) => !fileList.some((file) => file.md5 === taskInfo.md5));
                if (conflictFiles.length > 0) {
                    logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}, 有${conflictFiles.length}个文件冲突, 已忽略: ${conflictFiles.map((file) => file.fileName).join(',')}`);
                    harmonizedFilter.addHarmonizedList(conflictFiles.map((file) => file.md5));
                }
            }
            return true;
        }
        if (task.taskStatus == 2) {
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
            return this.checkTaskStatus(cloud189, taskId, count + 1, batchTaskDto);
        }
        return false;
    }

    async createBatchTask(cloud189, batchTaskDto) {
        const resp = await cloud189.createBatchTask(batchTaskDto);
        if (!resp) {
            throw new Error('批量任务处理失败');
        }
        if (resp.res_code != 0) {
            throw new Error(resp.res_msg);
        }
        logTaskEvent(`批量任务处理中: ${JSON.stringify(resp)}`);
        if (!await this.checkTaskStatus(cloud189, resp.taskId, 0, batchTaskDto)) {
            throw new Error('检查批量任务状态: 批量任务处理失败');
        }
        logTaskEvent('批量任务处理完成');
    }
}

module.exports = { TaskExecutorService };

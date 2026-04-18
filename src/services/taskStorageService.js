const { Cloud139Service } = require('./cloud139');
const { SchedulerService } = require('./scheduler');
const { logTaskEvent } = require('../utils/logUtils');

class TaskStorageService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async deleteTask(taskId, deleteCloud) {
        const task = await this.taskService.getTaskById(taskId);
        if (!task) throw new Error('任务不存在');
        if (!task.enableSystemProxy && deleteCloud) {
            const account = await this.taskService.accountRepo.findOneBy({ id: task.accountId });
            if (!account) throw new Error('账号不存在');
            if (account.accountType === 'cloud139') {
                const cloud139 = Cloud139Service.getInstance(account);
                await this.deleteCloudFile139(cloud139, await this.getRootFolder(task), 1);
            }
        }
        if (task.enableCron) {
            SchedulerService.removeTaskJob(task.id);
        }
        if (this.taskService.transferredFileRepo) {
            await this.taskService.transferredFileRepo.delete({ taskId: task.id });
        }
        await this.taskService.taskRepo.remove(task);
    }

    async deleteTasks(taskIds, deleteCloud) {
        for (const taskId of taskIds) {
            try {
                await this.deleteTask(taskId, deleteCloud);
            } catch (_) {
                // keep behavior: ignore single delete failures in batch
            }
        }
    }

    async getRootFolder(task) {
        if (task.realRootFolderId) {
            const tasks = await this.taskService.taskRepo.find({
                where: {
                    realRootFolderId: task.realRootFolderId
                }
            });
            if (tasks.length > 1) {
                return { id: task.realFolderId, name: task.realFolderName };
            }
            return { id: task.realRootFolderId, name: task.shareFolderName };
        }
        logTaskEvent(`任务[${task.resourceName}]为老版本系统创建, 无法删除网盘内容, 跳过`);
        return null;
    }

    async deleteFiles(taskId, files) {
        const task = await this.taskService.getTaskById(taskId);
        if (!task) {
            throw new Error('任务不存在');
        }
        if (!task.enableSystemProxy) {
            const cloud139 = Cloud139Service.getInstance(task.account);
            await this.deleteCloudFile139(cloud139, files);
        }
    }

    async deleteCloudFile139(cloud139, file) {
        if (!file) return;
        const fileIds = [];
        if (Array.isArray(file)) {
            for (const f of file) {
                if (f.id) fileIds.push(f.id);
            }
        } else if (file.id) {
            fileIds.push(file.id);
        }
        if (!fileIds.length) {
            logTaskEvent('[139] 无有效 fileId，跳过删除');
            return;
        }
        logTaskEvent(`[139] 删除网盘内容: fileIds=${JSON.stringify(fileIds)}`);
        const result = await cloud139.deleteFiles(fileIds);
        if (!result) {
            logTaskEvent('[139] 删除网盘内容失败，请检查文件ID是否正确');
        } else {
            logTaskEvent('[139] 删除网盘内容成功');
        }
    }
}

module.exports = { TaskStorageService };


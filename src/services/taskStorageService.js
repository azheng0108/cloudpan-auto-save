const { Cloud139Service } = require('./cloud139');
const { SchedulerService } = require('./scheduler');
const { logTaskEvent } = require('../utils/logUtils');

class TaskStorageService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async deleteTask(taskId, deleteCloud) {
        const id = Number(taskId);
        const task = await this.taskService.getTaskById(id);
        if (!task) return;

        // 尝试从网盘中删除文件（资产删除尽力而为，网盘异常或Token失效不应阻断本地任务记录的清除）
        if (!task.enableSystemProxy && deleteCloud) {
            try {
                const account = await this.taskService.accountRepo.findOneBy({ id: task.accountId });
                if (account && account.accountType === 'cloud139') {
                    const cloud139 = Cloud139Service.getInstance(account);
                    const rootFolder = await this.getRootFolder(task);
                    if (rootFolder) {
                        await this.deleteCloudFile139(cloud139, rootFolder, 1);
                    }
                }
            } catch (cloudErr) {
                logTaskEvent(`⚠️ [139] 同步删除网盘文件异常 (账号Token失效或网盘受限): ${cloudErr.message}，继续清理本地任务记录`);
            }
        }

        if (task.enableCron) {
            try {
                SchedulerService.removeTaskJob(task.id);
            } catch (_) {}
        }
        if (this.taskService.transferredFileRepo) {
            try {
                await this.taskService.transferredFileRepo.delete({ taskId: task.id });
            } catch (_) {}
        }
        const targetId = task.id;
        const targetName = task.resourceName;
        await this.taskService.taskRepo.remove(task);
        logTaskEvent(`[任务删除] 本地任务记录已成功清除: taskId=${targetId}, resourceName=${targetName}`);
    }

    async deleteTasks(taskIds, deleteCloud) {
        if (!Array.isArray(taskIds) || taskIds.length === 0) return;
        for (const taskId of taskIds) {
            try {
                await this.deleteTask(Number(taskId), deleteCloud);
            } catch (err) {
                logTaskEvent(`[批量删除] 删除任务 [${taskId}] 失败: ${err.message}`);
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


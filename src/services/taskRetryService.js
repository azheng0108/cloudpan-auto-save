const { LessThan, IsNull, Or } = require('typeorm');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

class TaskRetryService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async handleTaskFailure(task, error) {
        logTaskEvent(error);
        const maxRetries = ConfigService.getConfigValue('task.maxRetries');
        const retryInterval = ConfigService.getConfigValue('task.retryInterval');
        const baseRetryDelay = Number(error && error.retryDelay) > 0
            ? Number(error.retryDelay)
            : retryInterval;
        if (!task.retryCount) {
            task.retryCount = 0;
        }

        if (task.retryCount < maxRetries) {
            task.retryCount++;
            task.status = 'pending';
            task.lastError = `${error.message} (重试 ${task.retryCount}/${maxRetries})`;
            const retryDelay = Math.min(baseRetryDelay * Math.pow(2, Math.max(0, task.retryCount - 1)), 3600);
            task.nextRetryTime = new Date(Date.now() + retryDelay * 1000);
            logTaskEvent(`任务将在 ${retryDelay} 秒后重试 (${task.retryCount}/${maxRetries})`);
        } else {
            task.status = 'failed';
            task.lastError = `${error.message} (已达到最大重试次数 ${maxRetries})`;
            logTaskEvent(`任务达到最大重试次数 ${maxRetries}，标记为失败`);
        }

        await this.taskService.taskRepo.save(task);
        return '';
    }

    async getRetryTasks() {
        const now = new Date();
        return await this.taskService.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    isActive: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
            where: {
                status: 'pending',
                nextRetryTime: LessThan(now),
                retryCount: LessThan(ConfigService.getConfigValue('task.maxRetries')),
                enableSystemProxy: Or(IsNull(), false)
            }
        });
        return tasks.filter((task) => task.account?.isActive !== false);
    }

    async processRetryTasks() {
        const retryTasks = await this.getRetryTasks();
        if (retryTasks.length === 0) {
            return [];
        }
        const saveResults = [];
        logTaskEvent('================================');
        for (const task of retryTasks) {
            const taskName = task.shareFolderName ? (task.resourceName + '/' + task.shareFolderName) : task.resourceName || '未知';
            logTaskEvent(`任务[${taskName}]开始重试`);
            try {
                const result = await this.taskService.processTask(task);
                if (result) {
                    saveResults.push(result);
                }
            } catch (error) {
                logTaskEvent(`重试任务[${taskName}]执行失败: ${error.message}`);
            } finally {
                logTaskEvent(`任务[${taskName}]重试完成`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (saveResults.length > 0) {
            this.taskService.messageUtil.sendMessage(saveResults.join('\n\n'));
        }
        logTaskEvent('================================');
        return saveResults;
    }
}

module.exports = { TaskRetryService };


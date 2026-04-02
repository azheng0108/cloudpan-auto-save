const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database');

class SchedulerService {
    static taskJobs = new Map();
    static messageUtil = new MessageUtil();
    static DEFAULT_TASK_CHECK_CRON = '0 19-23 * * *';
    static DEFAULT_RETRY_TASK_CRON = '*/1 * * * *';
    static DEFAULT_CLEAN_RECYCLE_CRON = '0 */8 * * *';
    static DEFAULT_VACUUM_CRON = '0 4 * * 0';

    static async initTaskJobs(taskRepo, taskService) {
        // 初始化所有启用定时任务的任务
        const tasks = await taskRepo.find({ where: { enableCron: true } });
        tasks.forEach(task => {
            this.saveTaskJob(task, taskService);
        });

        logTaskEvent('初始化系统定时任务...');
        try {
            this.applySystemJobs(taskService, ConfigService.getConfigValue('task') || {});
        } catch (error) {
            logTaskEvent(`初始化系统定时任务失败，尝试使用默认配置重新初始化系统任务。原因: ${error?.message || error}`);
            try {
                this.applySystemJobs(taskService, {});
                logTaskEvent('使用默认配置初始化系统定时任务成功。');
            } catch (fallbackError) {
                logTaskEvent(`使用默认配置初始化系统定时任务仍然失败，将跳过系统任务初始化。原因: ${fallbackError?.message || fallbackError}`);
            }
        }
    }

    static saveTaskJob(task, taskService) {
        if (this.taskJobs.has(task.id)) {
            this.taskJobs.get(task.id).stop();
        }
        const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
        // 校验表达式是否有效
        if (!cron.validate(task.cronExpression)) {
            logTaskEvent(`定时任务[${taskName}]表达式无效，跳过...`);
            return;
        }
        if (task.enableCron && task.cronExpression) {
            logTaskEvent(`创建定时任务 ${taskName}, 表达式: ${task.cronExpression}`)
            const job = cron.schedule(task.cronExpression, async () => {
                logTaskEvent(`================================`);
                logTaskEvent(`任务[${taskName}]自定义定时检查...`);
                // 重新获取最新的任务信息
                const latestTask = await taskService.getTaskById(task.id);
                if (!latestTask) {
                    logTaskEvent(`任务[${taskName}]已被删除，跳过执行`);
                    this.removeTaskJob(task.id);
                    return;
                }
                const result = await taskService.processTask(latestTask);
                if (result) {
                    this.messageUtil.sendMessage(result)
                }
                logTaskEvent(`================================`);
            });
            this.taskJobs.set(task.id, job);
            logTaskEvent(`定时任务 ${taskName}, 表达式: ${task.cronExpression} 已设置`)
        }
    }

    // 内置定时任务
    static saveDefaultTaskJob(name, cronExpression, task) {
        if (this.taskJobs.has(name)) {
            this.taskJobs.get(name).stop();
        }
        // 校验表达式是否有效
        if (!cron.validate(cronExpression)) {
            logTaskEvent(`定时任务[${name}]表达式无效，跳过...`);
            return;
        }
        const job = cron.schedule(cronExpression, task);
        this.taskJobs.set(name, job);
        logTaskEvent(`定时任务 ${name}, 表达式: ${cronExpression} 已设置`)
        return job;
    }

    static removeTaskJob(taskId) {
        if (this.taskJobs.has(taskId)) {
            this.taskJobs.get(taskId).stop();
            this.taskJobs.delete(taskId);
            logTaskEvent(`定时任务[${taskId}]已移除`);
        }
    }

    static _removeJobsByPrefix(prefix) {
        const keys = [...this.taskJobs.keys()];
        keys.forEach((key) => {
            if (String(key).startsWith(prefix)) {
                this.removeTaskJob(key);
            }
        });
    }

    static _parseCronList(value, fallback) {
        const source = (typeof value === 'string' && value.trim())
            ? value
            : fallback;
        return source
            .split('|')
            .map(item => item.trim())
            .filter(Boolean);
    }

    static validateTaskScheduleSettings(taskSettings = {}) {
        const taskCheckCrons = this._parseCronList(
            taskSettings.taskCheckCron,
            this.DEFAULT_TASK_CHECK_CRON
        );
        taskCheckCrons.forEach((expression) => {
            if (!cron.validate(expression)) {
                throw new Error(`任务定时检查 Cron 无效: ${expression}`);
            }
        });

        const retryTaskCron = (typeof taskSettings.retryTaskCron === 'string' && taskSettings.retryTaskCron.trim())
            ? taskSettings.retryTaskCron.trim()
            : this.DEFAULT_RETRY_TASK_CRON;
        if (!cron.validate(retryTaskCron)) {
            throw new Error(`重试任务检查 Cron 无效: ${retryTaskCron}`);
        }

        const cleanRecycleCron = (typeof taskSettings.cleanRecycleCron === 'string' && taskSettings.cleanRecycleCron.trim())
            ? taskSettings.cleanRecycleCron.trim()
            : this.DEFAULT_CLEAN_RECYCLE_CRON;
        if (!cron.validate(cleanRecycleCron)) {
            throw new Error(`回收站清理 Cron 无效: ${cleanRecycleCron}`);
        }

        const vacuumCron = (typeof taskSettings.vacuumCron === 'string' && taskSettings.vacuumCron.trim())
            ? taskSettings.vacuumCron.trim()
            : this.DEFAULT_VACUUM_CRON;
        if (!cron.validate(vacuumCron)) {
            throw new Error(`VACUUM Cron 无效: ${vacuumCron}`);
        }

        return {
            taskCheckCron: taskCheckCrons.join('|'),
            retryTaskCron,
            cleanRecycleCron,
            vacuumCron,
        };
    }

    static applySystemJobs(taskService, taskSettings = {}) {
        const normalized = this.validateTaskScheduleSettings(taskSettings);
        const taskCheckCrons = this._parseCronList(normalized.taskCheckCron, this.DEFAULT_TASK_CHECK_CRON);
        this._removeJobsByPrefix('任务定时检查-');
        taskCheckCrons.forEach((cronExpression, index) => {
            this.saveDefaultTaskJob(`任务定时检查-${index}`, cronExpression, async () => {
                taskService.processAllTasks();
            });
        });

        this.saveDefaultTaskJob('重试任务检查', normalized.retryTaskCron, async () => {
            await taskService.processRetryTasks();
        });

        const enableAutoClearRecycle = taskSettings.enableAutoClearRecycle === true;
        const enableAutoClearFamilyRecycle = taskSettings.enableAutoClearFamilyRecycle === true;
        if (enableAutoClearRecycle || enableAutoClearFamilyRecycle) {
            this.saveDefaultTaskJob('自动清空回收站', normalized.cleanRecycleCron, async () => {
                await taskService.clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle);
            });
        } else {
            this.removeTaskJob('自动清空回收站');
        }

        this.saveDefaultTaskJob('SQLite-VACUUM', normalized.vacuumCron, async () => {
            try {
                if (!AppDataSource.isInitialized) {
                    logTaskEvent('VACUUM 跳过：数据库未初始化');
                    return;
                }
                await AppDataSource.query('VACUUM');
                logTaskEvent('VACUUM 执行成功');
            } catch (error) {
                logTaskEvent(`VACUUM 执行失败: ${error.message}`);
            }
        });

        return normalized;
    }

    static stopAllJobs() {
        for (const [key, job] of this.taskJobs.entries()) {
            try {
                job.stop();
            } catch (_) {
                // ignore stop errors during shutdown
            }
            this.taskJobs.delete(key);
        }
        logTaskEvent('所有定时任务已停止');
    }

    // 处理默认定时任务配置
    static handleScheduleTasks(settings,taskService) {
        const taskSettings = settings?.task || {};
        return this.applySystemJobs(taskService, taskSettings);
    }
}

module.exports = { SchedulerService };

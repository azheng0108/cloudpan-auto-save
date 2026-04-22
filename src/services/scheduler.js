const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database');

class SchedulerService {
    static taskJobs = new Map();
    static messageUtil = new MessageUtil();
    static DEFAULT_TASK_CHECK_CRON = '0 19-23 * * *';
    static DEFAULT_RETRY_TASK_CRON = '*/10 * * * *';
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
            logTaskEvent(`[Scheduler] 停止已存在的定时任务: ${task.id}`);
        }
        const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
        
        // 标准化 cron 表达式
        const normalized = this.normalizeCronExpression(task.cronExpression);
        
        if (task.cronExpression !== normalized) {
            logTaskEvent(`[Scheduler] Cron 标准化: "${task.cronExpression}" → "${normalized}"`);
        }
        
        // 校验表达式是否有效
        if (!cron.validate(normalized)) {
            logTaskEvent(`[Scheduler] 定时任务[${taskName}]表达式无效: ${task.cronExpression} (标准化后: ${normalized})，跳过...`);
            return;
        }
        if (task.enableCron && normalized) {
            logTaskEvent(`[Scheduler] 创建定时任务 ${taskName}, 表达式: ${normalized}`)
            const job = cron.schedule(normalized, async () => {
                logTaskEvent(`================================`);
                logTaskEvent(`任务[${taskName}]自定义定时检查...`);
                // 重新获取最新的任务信息
                const latestTask = await taskService.getTaskById(task.id);
                if (!latestTask) {
                    logTaskEvent(`任务[${taskName}]已被删除，跳过执行`);
                    this.removeTaskJob(task.id);
                    return;
                }
                if (taskService.isTaskRunning(latestTask.id)) {
                    logTaskEvent(`任务[${taskName}]已在运行中，跳过本次自定义调度`);
                    logTaskEvent(`================================`);
                    return;
                }
                const result = await taskService.processTask(latestTask);
                if (result) {
                    this.messageUtil.sendMessage(result)
                }
                logTaskEvent(`================================`);
            });
            this.taskJobs.set(task.id, job);
            logTaskEvent(`[Scheduler] 定时任务 ${taskName} (ID: ${task.id}), 表达式: ${normalized} 已设置并加载`)
        } else if (!task.enableCron) {
            logTaskEvent(`[Scheduler] 任务 ${taskName} 未启用定时调度，跳过...`);
        }
    }

    // 内置定时任务
    static saveDefaultTaskJob(name, cronExpression, task) {
        if (this.taskJobs.has(name)) {
            this.taskJobs.get(name).stop();
        }
        
        // 标准化 cron 表达式：5位自动补0秒
        const normalized = this.normalizeCronExpression(cronExpression);
        
        // 校验表达式是否有效
        if (!cron.validate(normalized)) {
            logTaskEvent(`定时任务[${name}]表达式无效: ${cronExpression} (标准化后: ${normalized})，跳过...`);
            return;
        }
        const job = cron.schedule(normalized, task);
        this.taskJobs.set(name, job);
        logTaskEvent(`定时任务 ${name}, 表达式: ${normalized} 已设置`)
        return job;
    }
    
    /**
     * 标准化 cron 表达式：统一为 6 位格式（秒 分 时 日 月 周）
     * @param {string} expression - 5位或6位cron表达式
     * @returns {string} - 6位cron表达式
     */
    static normalizeCronExpression(expression) {
        if (!expression || typeof expression !== 'string') {
            return expression;
        }
        
        const trimmed = expression.trim();
        const parts = trimmed.split(/\s+/);
        
        // 如果是5位，补0秒在开头
        if (parts.length === 5) {
            return `0 ${trimmed}`;
        }
        
        // 6位或其他格式直接返回
        return trimmed;
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

        const vacuumCron = (typeof taskSettings.vacuumCron === 'string' && taskSettings.vacuumCron.trim())
            ? taskSettings.vacuumCron.trim()
            : this.DEFAULT_VACUUM_CRON;
        if (!cron.validate(vacuumCron)) {
            throw new Error(`VACUUM Cron 无效: ${vacuumCron}`);
        }

        return {
            taskCheckCron: taskCheckCrons.join('|'),
            retryTaskCron,
            vacuumCron,
        };
    }

    static applySystemJobs(taskService, taskSettings = {}) {
        const normalized = this.validateTaskScheduleSettings(taskSettings);
        const taskCheckCrons = this._parseCronList(normalized.taskCheckCron, this.DEFAULT_TASK_CHECK_CRON);
        this._removeJobsByPrefix('任务定时检查-');
        taskCheckCrons.forEach((cronExpression, index) => {
            this.saveDefaultTaskJob(`任务定时检查-${index}`, cronExpression, async () => {
                logTaskEvent(`[定时检查] 全局任务检查触发（表达式: ${cronExpression}）`);
                await taskService.processAllTasks();
            });
        });

        this.saveDefaultTaskJob('重试任务检查', normalized.retryTaskCron, async () => {
            logTaskEvent(`[定时检查] 重试任务检查触发`);
            await taskService.processRetryTasks();
        });

        this.saveDefaultTaskJob('SQLite-VACUUM', normalized.vacuumCron, async () => {
            logTaskEvent(`[定时检查] SQLite VACUUM 触发`);
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

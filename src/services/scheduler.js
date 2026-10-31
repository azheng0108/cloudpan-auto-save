const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database');

let _TgChannelMonitorService = null;
function getTgChannelMonitorService() {
    if (!_TgChannelMonitorService) {
        try {
            _TgChannelMonitorService = require('./channel/TgChannelMonitorService').TgChannelMonitorService;
        } catch (err) {
            logger.error(`[调度器] 加载 TgChannelMonitorService 失败: ${err.message}`);
        }
    }
    return _TgChannelMonitorService;
}
try {
    _TgChannelMonitorService = require('./channel/TgChannelMonitorService').TgChannelMonitorService;
} catch (_) {}

class SchedulerService {
    static taskJobs = new Map();
    static messageUtil = new MessageUtil();
    static DEFAULT_TASK_CHECK_CRON = '0 19-23 * * *';
    static DEFAULT_RETRY_TASK_CRON = '*/10 * * * *';
    static DEFAULT_VACUUM_CRON = '0 4 * * 0';
    static DEFAULT_BANNED_SCAN_CRON = '0 3 * * 0';
    static DEFAULT_SWEEP_EMPTY_CRON = '0 4 * * 0';
    static DEFAULT_DEDUP_CRON = '0 5 * * 0';
    static DEFAULT_MISSING_SCAN_CRON = '0 6 * * *';

    static async initTaskJobs(taskRepo, taskService) {
        // 初始化所有启用定时任务的任务
        const tasks = await taskRepo.find({ where: { enableCron: true } });
        tasks.forEach(task => {
            this.saveTaskJob(task, taskService);
        });

        logTaskEvent('初始化系统定时任务...');
        try {
            this.applySystemJobs(
                taskService,
                ConfigService.getConfigValue('task') || {},
                ConfigService.getConfigValue('maintenance') || {}
            );
        } catch (error) {
            logTaskEvent(`初始化系统定时任务失败，尝试使用默认配置重新初始化系统任务。原因: ${error?.message || error}`);
            try {
                this.applySystemJobs(taskService, {}, {});
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

    static validateTaskScheduleSettings(taskSettings = {}, maintenanceSettings = {}) {
        const taskCheckCrons = this._parseCronList(
            taskSettings.taskCheckCron,
            this.DEFAULT_TASK_CHECK_CRON
        );
        taskCheckCrons.forEach((expression) => {
            if (!cron.validate(this.normalizeCronExpression(expression))) {
                throw new Error(`任务定时检查 Cron 无效: ${expression}`);
            }
        });

        const retryTaskCron = (typeof taskSettings.retryTaskCron === 'string' && taskSettings.retryTaskCron.trim())
            ? taskSettings.retryTaskCron.trim()
            : this.DEFAULT_RETRY_TASK_CRON;
        if (!cron.validate(this.normalizeCronExpression(retryTaskCron))) {
            throw new Error(`重试任务检查 Cron 无效: ${retryTaskCron}`);
        }

        const vacuumCron = (typeof taskSettings.vacuumCron === 'string' && taskSettings.vacuumCron.trim())
            ? taskSettings.vacuumCron.trim()
            : this.DEFAULT_VACUUM_CRON;
        if (!cron.validate(this.normalizeCronExpression(vacuumCron))) {
            throw new Error(`VACUUM Cron 无效: ${vacuumCron}`);
        }

        let bannedScanCron = maintenanceSettings?.bannedScanCron || this.DEFAULT_BANNED_SCAN_CRON;
        if (maintenanceSettings?.enableBannedScanCron) {
            bannedScanCron = this.normalizeCronExpression(bannedScanCron);
            if (!cron.validate(bannedScanCron)) {
                throw new Error(`违规巡检 Cron 无效: ${maintenanceSettings.bannedScanCron}`);
            }
        }

        let sweepEmptyCron = maintenanceSettings?.sweepEmptyCron || this.DEFAULT_SWEEP_EMPTY_CRON;
        if (maintenanceSettings?.enableSweepEmptyCron) {
            sweepEmptyCron = this.normalizeCronExpression(sweepEmptyCron);
            if (!cron.validate(sweepEmptyCron)) {
                throw new Error(`空目录修剪 Cron 无效: ${maintenanceSettings.sweepEmptyCron}`);
            }
        }

        let dedupCron = maintenanceSettings?.dedupCron || this.DEFAULT_DEDUP_CRON;
        if (maintenanceSettings?.enableDedupCron) {
            dedupCron = this.normalizeCronExpression(dedupCron);
            if (!cron.validate(dedupCron)) {
                throw new Error(`多版本资产去重 Cron 无效: ${maintenanceSettings.dedupCron}`);
            }
        }

        let missingScanCron = maintenanceSettings?.missingScanCron || this.DEFAULT_MISSING_SCAN_CRON;
        if (maintenanceSettings?.enableMissingScanCron) {
            missingScanCron = this.normalizeCronExpression(missingScanCron);
            if (!cron.validate(missingScanCron)) {
                throw new Error(`剧集缺更巡检 Cron 表达式无效: ${maintenanceSettings.missingScanCron}`);
            }
        }

        return {
            taskCheckCron: taskCheckCrons.join('|'),
            retryTaskCron,
            vacuumCron,
            bannedScanCron,
            sweepEmptyCron,
            dedupCron,
            missingScanCron,
        };
    }

    static applySystemJobs(taskService, taskSettings = {}, maintenanceSettings = {}) {
        const normalized = this.validateTaskScheduleSettings(taskSettings, maintenanceSettings);
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

        // 违规文件定时巡检
        if (maintenanceSettings?.enableBannedScanCron) {
            this.saveDefaultTaskJob('违规文件定时巡检', normalized.bannedScanCron, async () => {
                logTaskEvent(`[定时检查] 违规文件定时巡检触发（表达式: ${normalized.bannedScanCron}）`);
                const { MaintenanceJobService } = require('./MaintenanceJobService');
                const startTime = Date.now();
                let cronJob = null;
                try {
                    cronJob = await MaintenanceJobService.createJob({
                        type: 'banned_scan',
                        triggerType: 'cron',
                        title: '违规死链定时巡检',
                        folderPath: '/',
                        summary: '定时任务启动，正在深度排查网盘违规死链...'
                    });

                    const { Account } = require('../entities');
                    const { Cloud139Service } = require('./cloud139');
                    const { CloudMaintenanceService } = require('./CloudMaintenanceService');
                    const accountRepo = AppDataSource.getRepository(Account);
                    const account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                                    (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
                    if (!account) {
                        logTaskEvent('[违规巡检] 跳过：未找到可用的 139 账号');
                        if (cronJob) await MaintenanceJobService.failJob(cronJob.id, new Error('未找到可用的 139 账号'));
                        return;
                    }
                    const cloud139 = Cloud139Service.getInstance(account);
                    const scanRes = await CloudMaintenanceService.scanBannedFiles(cloud139, { rootCatalogId: '/' });
                    logTaskEvent(`[违规巡检] 完成：发现 ${scanRes.bannedCount} 个违规文件，共占用 ${scanRes.totalBannedSizeFormatted}`);

                    let cleanSummary = '';
                    let cleanRes = null;
                    if (maintenanceSettings.autoCleanBanned && scanRes.bannedCount > 0) {
                        logTaskEvent(`[违规巡检] 开启了自动清理，开始清理 ${scanRes.bannedCount} 个违规文件...`);
                        cleanRes = await CloudMaintenanceService.cleanBannedFiles(cloud139, scanRes.bannedFiles);
                        cleanSummary = `\n已自动移入回收站：成功 ${cleanRes.cleanedCount} 个（释放 ${cleanRes.freedSizeFormatted}），失败 ${cleanRes.failedCount} 个`;
                    }

                    if (cronJob) {
                        const jobSummary = scanRes.bannedCount === 0
                            ? `排查 ${scanRes.scannedFolders} 目录、${scanRes.totalFiles} 文件，未发现违规死链 (耗时 ${(scanRes.durationMs / 1000).toFixed(1)}s)`
                            : `发现违规死链 ${scanRes.bannedCount} 项 (${scanRes.totalBannedSizeFormatted})${cleanRes ? `，已自动清理 ${cleanRes.cleanedCount} 项` : ''}`;
                        await MaintenanceJobService.completeJob(cronJob.id, {
                            status: cleanRes ? 'cleaned' : 'completed',
                            summary: jobSummary,
                            durationMs: scanRes.durationMs,
                            scannedFolders: scanRes.scannedFolders,
                            totalFiles: scanRes.totalFiles,
                            bannedCount: scanRes.bannedCount,
                            cleanedCount: cleanRes?.cleanedCount || 0,
                            freedFormatted: cleanRes?.freedSizeFormatted || scanRes.totalBannedSizeFormatted,
                            findings: scanRes.bannedFiles,
                            cleanedDetails: cleanRes?.details
                        });
                    }

                    if (maintenanceSettings.notifyOnMaintenance !== false && scanRes.bannedCount > 0) {
                        const sampleText = scanRes.bannedFiles.slice(0, 5).map(f => `• ${f.path || f.name} (${f.reason || '违规'})`).join('\n');
                        const moreText = scanRes.bannedCount > 5 ? `\n...等共 ${scanRes.bannedCount} 个文件` : '';
                        const pushMsg = `【139网盘违规检测提醒】\n发现违规死链: ${scanRes.bannedCount} 个\n占用空间: ${scanRes.totalBannedSizeFormatted}${cleanSummary}\n抽样详情:\n${sampleText}${moreText}`;
                        await this.messageUtil.sendMessage(pushMsg);
                    }
                } catch (err) {
                    logTaskEvent(`[违规巡检] 执行异常: ${err.message}`);
                    if (cronJob) await MaintenanceJobService.failJob(cronJob.id, err, Date.now() - startTime);
                }
            });
        } else {
            this.removeTaskJob('违规文件定时巡检');
        }

        // 空文件夹定时修剪
        if (maintenanceSettings?.enableSweepEmptyCron) {
            this.saveDefaultTaskJob('空文件夹定时修剪', normalized.sweepEmptyCron, async () => {
                logTaskEvent(`[定时检查] 空文件夹定时修剪触发（表达式: ${normalized.sweepEmptyCron}）`);
                const { MaintenanceJobService } = require('./MaintenanceJobService');
                const startTime = Date.now();
                let cronJob = null;
                try {
                    cronJob = await MaintenanceJobService.createJob({
                        type: 'empty_prune',
                        triggerType: 'cron',
                        title: '空目录定时自动修剪',
                        folderPath: '/',
                        summary: '定时任务启动，正在修剪纯空目录...'
                    });

                    const { Account } = require('../entities');
                    const { Cloud139Service } = require('./cloud139');
                    const { CloudMaintenanceService } = require('./CloudMaintenanceService');
                    const accountRepo = AppDataSource.getRepository(Account);
                    const account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                                    (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
                    if (!account) {
                        logTaskEvent('[空目录修剪] 跳过：未找到可用的 139 账号');
                        if (cronJob) await MaintenanceJobService.failJob(cronJob.id, new Error('未找到可用的 139 账号'));
                        return;
                    }
                    const cloud139 = Cloud139Service.getInstance(account);
                    const sweepRes = await CloudMaintenanceService.sweepEmptyFolders(cloud139, { rootCatalogId: '/' });
                    logTaskEvent(`[空目录修剪] 完成：共修剪 ${sweepRes.sweptCount} 个空目录`);

                    if (cronJob) {
                        await MaintenanceJobService.completeJob(cronJob.id, {
                            summary: `成功修剪 ${sweepRes.sweptCount} 个空目录 (耗时 ${(sweepRes.durationMs / 1000).toFixed(1)}s)`,
                            durationMs: sweepRes.durationMs,
                            cleanedCount: sweepRes.sweptCount,
                            cleanedDetails: sweepRes.deletedDirs
                        });
                    }

                    if (maintenanceSettings.notifyOnMaintenance !== false && sweepRes.sweptCount > 0) {
                        const pushMsg = `【139网盘清理报告】\n空文件夹清理完成\n成功清理纯空目录: ${sweepRes.sweptCount} 个\n耗时: ${sweepRes.durationMs}ms`;
                        await this.messageUtil.sendMessage(pushMsg);
                    }
                } catch (err) {
                    logTaskEvent(`[空目录修剪] 执行异常: ${err.message}`);
                    if (cronJob) await MaintenanceJobService.failJob(cronJob.id, err, Date.now() - startTime);
                }
            });
        } else {
            this.removeTaskJob('空文件夹定时修剪');
        }

        // 多版本资产定时去重
        if (maintenanceSettings?.enableDedupCron) {
            this.saveDefaultTaskJob('多版本资产定时去重', normalized.dedupCron, async () => {
                logTaskEvent(`[定时检查] 多版本资产定时去重触发（表达式: ${normalized.dedupCron}）`);
                try {
                    const { Account } = require('../entities');
                    const { Cloud139Service } = require('./cloud139');
                    const { AssetDeduplicationService } = require('./AssetDeduplicationService');
                    const accountRepo = AppDataSource.getRepository(Account);
                    const account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                                    (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
                    if (!account) {
                        logTaskEvent('[资产去重] 跳过：未找到可用的 139 账号');
                        return;
                    }
                    const cloud139 = Cloud139Service.getInstance(account);
                    const files = await AssetDeduplicationService.scanCloudFiles(cloud139, { rootCatalogId: '/' });
                    const policy = ConfigService.getConfigValue('policy') || {};
                    const plan = AssetDeduplicationService.analyzeDuplicates(files, policy);
                    logTaskEvent(`[资产去重] 扫描完成：发现 ${plan.duplicateGroupsCount} 组多版本资产，淘汰版本 ${plan.redundantFilesCount} 个，可释放 ${plan.totalFreedFormatted}`);

                    let pruneSummary = '';
                    if (maintenanceSettings.autoPruneDedup && plan.duplicateGroupsCount > 0) {
                        logTaskEvent(`[资产去重] 开启了自动清理，开始将 ${plan.redundantFilesCount} 个淘汰版本移入回收站...`);
                        const transferredFileRepo = AppDataSource.isInitialized ? AppDataSource.getRepository('TransferredFile') : null;
                        const pruneRes = await AssetDeduplicationService.executePrune(cloud139, plan, {
                            dryRun: false,
                            protectedPaths: maintenanceSettings.protectedPaths || ['/媒体库'],
                            transferredFileRepo
                        });
                        pruneSummary = `\n已自动移入回收站：成功 ${pruneRes.successCount} 个（释放 ${pruneRes.freedFormatted}），失败 ${pruneRes.failedCount} 个`;
                    }

                    if (maintenanceSettings.notifyOnMaintenance !== false && plan.duplicateGroupsCount > 0) {
                        const sampleText = plan.groups.slice(0, 3).map(g => `• ${g.title}: 保留 [${g.keeper?.name}]，淘汰 ${g.losers?.length} 个`).join('\n');
                        const moreText = plan.groups.length > 3 ? `\n...等共 ${plan.groups.length} 组资产` : '';
                        const pushMsg = `【139网盘资产去重报告】\n发现多版本资产: ${plan.duplicateGroupsCount} 组\n淘汰冗余版本: ${plan.redundantFilesCount} 个\n占用空间: ${plan.totalFreedFormatted}${pruneSummary}\n方案抽样:\n${sampleText}${moreText}`;
                        await this.messageUtil.sendMessage(pushMsg);
                    }
                } catch (err) {
                    logTaskEvent(`[资产去重] 执行异常: ${err.message}`);
                }
            });
        } else {
            this.removeTaskJob('多版本资产定时去重');
        }

        // 剧集缺更定时巡检
        if (maintenanceSettings?.enableMissingScanCron) {
            this.saveDefaultTaskJob('剧集缺更定时巡检', normalized.missingScanCron, async () => {
                logTaskEvent(`[定时检查] 剧集缺更定时巡检触发（表达式: ${normalized.missingScanCron}）`);
                const { MaintenanceJobService } = require('./MaintenanceJobService');
                const targetFolder = maintenanceSettings.missingFolderId || '/';
                const startTime = Date.now();
                let cronJob = null;
                try {
                    cronJob = await MaintenanceJobService.createJob({
                        type: 'missing_scan',
                        triggerType: 'cron',
                        title: 'TMDB 剧集缺更巡检',
                        folderPath: targetFolder,
                        summary: `定时任务启动剧集缺更巡检: ${targetFolder}...`,
                    });
                } catch (_) {}

                try {
                    const { Account } = require('../entities');
                    const { Cloud139Service } = require('./cloud139');
                    const { EpisodeInspectionService } = require('./EpisodeInspectionService');
                    const accountRepo = AppDataSource.getRepository(Account);
                    const account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                                    (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
                    if (!account) {
                        logTaskEvent('[缺更巡检] 跳过：未找到可用的 139 账号');
                        if (cronJob) {
                            await MaintenanceJobService.failJob(cronJob.id, new Error('未找到可用的 139 账号'));
                        }
                        return;
                    }
                    const cloud139 = Cloud139Service.getInstance(account);
                    const scanRes = await EpisodeInspectionService.inspectDirectory(cloud139, {
                        rootCatalogId: targetFolder,
                        excludeUnreleased: maintenanceSettings.excludeUnreleased !== false,
                        ignoreSeasonZero: maintenanceSettings.ignoreSeasonZero !== false,
                    });
                    const durationMs = scanRes.durationMs || (Date.now() - startTime);
                    logTaskEvent(`[缺更巡检] 完成：分析 ${scanRes.scannedShowsCount} 个剧集季组，发现缺集 ${scanRes.missingShowsCount} 组，累计缺失 ${scanRes.totalMissingCount} 集`);

                    // 同步刷新本地缓存与内存态，保证用户次日打开 Web 端能直接看到夜间巡检最新结果
                    EpisodeInspectionService.saveCache(scanRes, targetFolder, durationMs);
                    if (EpisodeInspectionService.scanJob) {
                        EpisodeInspectionService.scanJob.status = 'completed';
                        EpisodeInspectionService.scanJob.result = scanRes;
                        EpisodeInspectionService.scanJob.durationMs = durationMs;
                    }

                    // 写入持久化流水作业
                    if (cronJob) {
                        const missingSeasons = (scanRes.items || []).filter(i => i.missingCount > 0);
                        await MaintenanceJobService.completeJob(cronJob.id, {
                            status: 'completed',
                            summary: `分析 ${scanRes.scannedShowsCount} 部剧集 · 发现缺更 ${scanRes.missingShowsCount} 部 (累计缺 ${scanRes.totalMissingCount} 集)`,
                            durationMs,
                            scannedFolders: scanRes.scannedShowsCount,
                            totalFiles: scanRes.scannedFilesCount,
                            bannedCount: scanRes.missingShowsCount,
                            cleanedCount: scanRes.totalMissingCount,
                            freedFormatted: `${scanRes.totalMissingCount} 集`,
                            findings: missingSeasons.length > 0 ? missingSeasons : scanRes.items,
                        });
                    }

                    if (maintenanceSettings.notifyOnMaintenance !== false && scanRes.missingShowsCount > 0) {
                        const missingList = scanRes.items.filter(i => i.missingCount > 0);
                        const sampleLines = missingList.slice(0, 5).map((m, idx) =>
                            `${idx + 1}. 《${m.title}》${m.seasonLabel}\n   已收录: ${m.localCount}/${m.tmdbCount || m.localCount + m.missingCount} 集 (缺 ${m.missingCount} 集: ${m.missingRangesStr})`
                        ).join('\n');
                        const moreText = missingList.length > 5 ? `\n...等共 ${missingList.length} 部剧集存在缺更` : '';
                        const pushMsg = `📺【139网盘 剧集缺更巡检报告】\n巡检目录: ${targetFolder}\n分析剧集: ${scanRes.scannedShowsCount} 部 | 发现缺更: ${scanRes.missingShowsCount} 部 (累计缺 ${scanRes.totalMissingCount} 集)\n\n${sampleLines}${moreText}\n\n建议及时关注补更缺失资源。`;
                        await this.messageUtil.sendMessage(pushMsg);
                    }
                } catch (err) {
                    logTaskEvent(`[缺更巡检] 执行异常: ${err.message}`);
                    if (cronJob) {
                        await MaintenanceJobService.failJob(cronJob.id, err, Date.now() - startTime);
                    }
                }
            });
        } else {
            this.removeTaskJob('剧集缺更定时巡检');
        }

        // 影视规范刮削定时整理
        const scrapeSettings = ConfigService.getConfigValue('scrape') || {};
        if (scrapeSettings?.enabled && scrapeSettings?.rules?.length > 0) {
            const scrapeCron = this.normalizeCronExpression(scrapeSettings.cron || '0 4 * * *');
            if (cron.validate(scrapeCron)) {
                this.saveDefaultTaskJob('影视规范刮削定时整理', scrapeCron, async () => {
                    logTaskEvent(`[定时检查] 影视规范刮削定时整理触发（表达式: ${scrapeCron}）`);
                    try {
                        const { MediaScrapeService } = require('./MediaScrapeService');
                        await MediaScrapeService.runScheduledRules();
                    } catch (err) {
                        logTaskEvent(`[影视刮削] 定时整理执行异常: ${err.message}`);
                    }
                });
            }
        } else {
            this.removeTaskJob('影视规范刮削定时整理');
        }

        // 1. Telegram 频道监控定时轮询
        const channelMonitorConfig = ConfigService.getConfigValue('channelMonitor') || {};
        if (channelMonitorConfig.enabled !== false) {
            const channelCron = this.normalizeCronExpression(channelMonitorConfig.cron || '*/5 * * * *');
            if (cron.validate(channelCron)) {
                this.saveDefaultTaskJob('Telegram频道监控轮询', channelCron, async () => {
                    logTaskEvent(`[定时检查] Telegram 频道监控轮询触发（表达式: ${channelCron}）`);
                    try {
                        const TgChannelMonitorService = getTgChannelMonitorService();
                        if (!TgChannelMonitorService) {
                            throw new Error('TgChannelMonitorService 核心服务模块未加载就绪');
                        }
                        await TgChannelMonitorService.getInstance().scanAllMonitors();
                    } catch (err) {
                        logTaskEvent(`[频道监控轮询] 执行异常: ${err.message}`);
                    }
                });
            }
        } else {
            this.removeTaskJob('Telegram频道监控轮询');
        }

        // 2. 自动定时整理（独立运作，只受 autoOrganize 开关控制，绝不受频道监控全局开关牵连）
        if (channelMonitorConfig.autoOrganize !== false) {
            const organizeCron = this.normalizeCronExpression(channelMonitorConfig.cron || '*/5 * * * *');
            if (cron.validate(organizeCron)) {
                this.removeTaskJob('139云盘暂存区定时整理'); // 清理历史旧任务键
                this.saveDefaultTaskJob('自动定时整理', organizeCron, async () => {
                    try {
                        const cmConfig = ConfigService.getConfigValue('channelMonitor') || {};
                        if (cmConfig.autoOrganize === false) {
                            return;
                        }
                        const { StagingOrganizeService } = require('./StagingOrganizeService');
                        const prereq = await StagingOrganizeService.validateOrganizePrerequisites({ skipChannelCheck: true });
                        if (!prereq.ready) {
                            logger.warn(`[定时检查] 跳过自动定时整理（前置门禁未通过）: ${prereq.reason}`);
                            return;
                        }
                        logTaskEvent(`[定时检查] 自动定时整理触发（表达式: ${organizeCron}）`);
                        await StagingOrganizeService.getInstance().organizeStagingFolder({ silentIfEmpty: true });
                    } catch (err) {
                        logTaskEvent(`[云盘整理] 定时整理执行异常: ${err.message}`);
                    }
                });
            }
        } else {
            this.removeTaskJob('自动定时整理');
            this.removeTaskJob('139云盘暂存区定时整理');
        }

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
        const maintenanceSettings = settings?.maintenance || {};
        return this.applySystemJobs(taskService, taskSettings, maintenanceSettings);
    }
}

module.exports = { SchedulerService };

const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const path = require('path');
const { webhookService } = require('./WebhookService');
const { EmbyService } = require('./emby');
const { StrmService } = require('./strm');
const { ScrapeService } = require('./ScrapeService');
const ConfigService = require('./ConfigService');


class TaskEventHandler {
    constructor(messageUtil) {
        this.messageUtil = messageUtil;
        this._embyNotifyAt = new Map();
    }

    async handle(taskCompleteEventDto) {
        // 全局后处理总开关：阶段性关闭后处理流程 (自动重命名/STRM/NFO/Emby/Webhook)
        const isPostProcessEnabled = ConfigService.getConfigValue('postProcess.enable', false)
            || ConfigService.getConfigValue('postProcess.enabled', false);
        const isStrmAutoGenerate = (taskCompleteEventDto.sourceMode === 'staging_organize' || taskCompleteEventDto.sourceMode === 'manual_resolve') && (
            ConfigService.getConfigValue('strm.autoGenerateOnOrganize', true) &&
            (ConfigService.getConfigValue('strm.enable', false) || ConfigService.getConfigValue('channelMonitor.linkStrm', false))
        );
        if (!isPostProcessEnabled && !isStrmAutoGenerate) {
            logger.debug('[后处理] 全局后处理总开关已关闭，跳过后处理流程');
            return;
        }

        const task = taskCompleteEventDto.task || {};
        const fileCount = Array.isArray(taskCompleteEventDto.fileList) ? taskCompleteEventDto.fileList.length : 0;
        const resourceName = task.resourceName || taskCompleteEventDto.taskName || '云盘整理';
        logTaskEvent(`── 后处理开始: ${resourceName}（共 ${fileCount} 个文件）──`);
        if (!Array.isArray(taskCompleteEventDto.fileList) || taskCompleteEventDto.fileList.length === 0) {
            logTaskEvent(`[任务 ${task.id || 'manual'}] 文件列表为空，跳过后处理`);
            logTaskEvent(`── 后处理完成 ──`);
            return;
        }
        try {
            logTaskEvent('[1] 自动重命名');
            await this._handleAutoRename(taskCompleteEventDto);
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[1] 自动重命名失败: ${error.message}`);
        }
        try {
            logTaskEvent('[2] 本地 STRM 生成');
            await this._handleLocalStrmGenerate(taskCompleteEventDto);
        } catch (error) {
            logger.error('本地 STRM 生成失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[2] 本地 STRM 生成失败: ${error.message}`);
        }
        try {
            logTaskEvent('[3] NFO 刮削');
            await this._handleNfoGenerate(taskCompleteEventDto);
        } catch (error) {
            logger.error('NFO 刮削失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[3] NFO 刮削失败（不阻断后续流程）: ${error.message}`);
        }
        try {
            logTaskEvent('[4] Emby 媒体库直连刷新');
            const embyResult = await this._handleEmbyNotify(taskCompleteEventDto);
            if (embyResult?.status === 'success') {
                logTaskEvent(`[4] Emby 媒体库刷新完成: 模式=${embyResult.refreshMode || '目录增量'}`);
            } else if (embyResult?.status === 'skipped') {
                logTaskEvent(`[4] Emby 媒体库刷新跳过: ${embyResult.reason || '未启用'}`);
            }
        } catch (error) {
            logger.error('Emby 媒体库刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[4] Emby 媒体库刷新失败: ${error.message}`);
        }
        try {
            logTaskEvent('[5] Webhook 入库通知 (SmartStrm / 第三方)');
            const notifyResult = await this._handleWebhookNotify(taskCompleteEventDto);
            if (notifyResult?.status === 'success') {
                logTaskEvent(
                    `[5] Webhook 通知完成（HTTP ${notifyResult.statusCode || 200}）`
                );
            } else if (notifyResult?.status === 'skipped') {
                logTaskEvent(`[5] Webhook 通知跳过: ${notifyResult.reason || '未启用'}`);
            }
        } catch (error) {
            logger.error('Webhook 出站通知失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[5] Webhook 出站通知失败: ${error.message}`);
        }
        logTaskEvent(`── 后处理完成 ──`);
    }

    async _handleAutoRename(taskCompleteEventDto) {
        try {
            if (
                taskCompleteEventDto.sourceMode === 'staging_organize' ||
                taskCompleteEventDto.sourceMode === 'manual_resolve' ||
                taskCompleteEventDto.task?.enableTaskScraper === true ||
                Boolean(taskCompleteEventDto.task?.tmdbId) ||
                !taskCompleteEventDto.taskService
            ) {
                logTaskEvent('[1] 媒体文件已由 TMDB 整理归档引擎规范化处理，跳过旧版二次重命名');
                return;
            }
            const task = taskCompleteEventDto.task || {};
            const fileCount = Array.isArray(taskCompleteEventDto.fileList) ? taskCompleteEventDto.fileList.length : 0;
            const hasTaskTemplate = !!(String(task.movieRenameFormat || '').trim() || String(task.tvRenameFormat || '').trim());
            const hasGlobalTemplate = !!(
                String(ConfigService.getConfigValue('tmdb.movieRenameFormat') || '').trim() ||
                String(ConfigService.getConfigValue('tmdb.tvRenameFormat') || '').trim()
            );
            const hasRegexRule = !!(String(task.sourceRegex || '').trim() && String(task.targetRegex || '').trim());
            const templateLabel = task.disableRename === true ? '已禁用'
                : hasTaskTemplate ? '任务级模板'
                : hasGlobalTemplate ? '全局模板'
                : hasRegexRule ? '正则规则'
                : '139规范洗版';
            logTaskEvent(
                `[1] 自动重命名（共 ${fileCount} 个文件，命名规则: ${templateLabel}）`
            );

            const newFiles = await taskCompleteEventDto.taskService.autoRename(
                taskCompleteEventDto.task,
                taskCompleteEventDto.fileList
            );
            if (newFiles.length > 0) {
                taskCompleteEventDto.fileList = newFiles;
            }
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[1] 自动重命名失败: ${error.message}`);
        }
    }

    /**
     * 追更后本地生成 .strm 文件（仅 strm.enable=true 且 localStrmPrefix 已配置时触发）。
     * 两种使用方式：
     *   1. 用户外部工具自行生成：strm.enable=false，本方法直接跳过
     *   2. App 自动生成：strm.enable=true + account.localStrmPrefix 非空
     * @param {TaskCompleteEventDto} dto
     */
    async _handleLocalStrmGenerate(dto) {
        const linkStrm = ConfigService.getConfigValue('channelMonitor.linkStrm', false);
        const strmEnabled = ConfigService.getConfigValue('strm.enable', false);

        // 影视整理联动 STRM 生成处理
        if (dto.sourceMode === 'staging_organize') {
            const autoGenerate = ConfigService.getConfigValue('strm.autoGenerateOnOrganize', true);
            if (!autoGenerate && !linkStrm && !strmEnabled) {
                logTaskEvent('[2] 影视整理联动 STRM 生成未启用，跳过');
                return;
            }
            const files = Array.isArray(dto.fileList) ? dto.fileList : [];
            if (files.length === 0) return;
            const { StrmService } = require('./strm');
            const strmService = new StrmService();
            logTaskEvent(`[2] 触发影视整理联动 STRM 增量生成: 共 ${files.length} 个文件`);
            await strmService.generateForOrganizedFiles(files, {
                cleanObsolete: true,
                cleanEmptyDirs: true
            });
            return;
        }

        if (!strmEnabled) {
            logTaskEvent('STRM 本地生成未启用，跳过（使用外部工具生成或不使用本地 STRM）');
            return;
        }
        const task = dto.task || {};
        const files = Array.isArray(dto.fileList) ? dto.fileList : [];
        if (files.length === 0) {
            logTaskEvent(`[2] 跳过本地 STRM 生成 [任务 ${task.id}]: 文件列表为空`);
            return;
        }
        const { StrmService } = require('./strm');
        const strmService = new StrmService();
        logTaskEvent(`[2] 开始本地 STRM 生成 [任务 ${task.id}]: 共 ${files.length} 个文件`);
        await strmService.generate(task, files, dto.overwriteStrm ?? false);
    }

    /**
     * 追更后 NFO 刮削：本地 STRM 生成成功后自动从 TMDB 获取元数据并写入 NFO 文件。
     * 需要同时满足：tmdb.tmdbApiKey 已填写 + strm.enable=true + strm.localStrmPrefix 已配置。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleNfoGenerate(dto) {
        const tmdbApiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey');
        if (!tmdbApiKey) {
            logTaskEvent('TMDB API Key 未配置，跳过 NFO 刮削');
            return;
        }
        const strmEnabled = ConfigService.getConfigValue('strm.enable');
        if (!strmEnabled) {
            logTaskEvent('本地 STRM 未启用，跳过 NFO 刮削');
            return;
        }
        const localStrmPrefix = ConfigService.getConfigValue('strm.localStrmPrefix') || '';
        if (!localStrmPrefix) {
            logTaskEvent('strm.localStrmPrefix 未配置，跳过 NFO 刮削');
            return;
        }
        const task = dto.task;
        const taskName = (task.realFolderName || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
        const baseDir = path.join(__dirname, '../../../strm');
        const targetDir = path.join(baseDir, localStrmPrefix, taskName);
        const scrapeService = new ScrapeService();
        logTaskEvent(`[3] 开始 NFO 刮削 [任务 ${task.id}]: ${targetDir}`);
        await scrapeService.scrapeFromDirectory(targetDir);
        logTaskEvent('NFO 刮削完成');
    }

    /**
     * 通知 Emby 刷新对应媒体库 (适用于本地 STRM 用户或直连用户)。
     * 向 Emby 发送标准轻量目录事件通知。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleEmbyNotify(dto) {
        const embyEnable = ConfigService.getConfigValue('emby.enable', false);
        if (!embyEnable) {
            logTaskEvent('[4] Emby 媒体库直连刷新跳过: 未开启 Emby 联动入库');
            return { status: 'skipped', reason: 'disabled' };
        }
        try {
            const embyService = new EmbyService();
            if (!embyService.enable || !embyService.embyUrl || !embyService.embyApiKey) {
                logTaskEvent('[4] Emby 媒体库直连刷新跳过: 未配置 Emby 服务端地址或 API Key');
                return { status: 'skipped', reason: 'not_configured' };
            }
            logTaskEvent('[4] 正在联动通知 Emby 刷新媒体库...');

            // 收集需通知的目录
            let paths = [];
            if (dto?.files && Array.isArray(dto.files)) {
                for (const f of dto.files) {
                    const dir = f.targetPath ? require('path').dirname(f.targetPath) : (f.parentPath || '');
                    if (dir) paths.push(dir);
                }
            }

            const embyMountPrefix = ConfigService.getConfigValue('webhook.embyMountPrefix', '') || ConfigService.getConfigValue('emby.mountPrefix', '');
            if (paths.length > 0) {
                const mappedPaths = paths.map(p => {
                    const norm = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
                    return embyMountPrefix ? `${embyMountPrefix.replace(/\/+$/, '')}/${norm}` : `/${norm}`;
                });
                const ok = await embyService.refreshMediaByPaths(mappedPaths);
                if (ok) {
                    logTaskEvent(`[4] 已成功通知 Emby 刷新入库: ${mappedPaths.slice(0, 3).join(', ')}`);
                    return { status: 'success', refreshMode: 'path_updated', paths: mappedPaths };
                }
            }

            const res = await embyService.notify(dto?.task || {}, {});
            return res;
        } catch (err) {
            logger.warn(`[Emby联动] 通知入库刷新异常: ${err.message}`);
            logTaskEvent(`[4] 联动 Emby 入库通知异常: ${err.message}`);
            return { status: 'failed', error: err.message };
        }
    }

    /**
     * 通知 SmartStrm / 第三方 Webhook 服务触发媒体入库或生成 302 STRM
     * @param {TaskCompleteEventDto} dto
     */
    async _handleWebhookNotify(dto) {
        if (!webhookService.outboundEnable) {
            return { status: 'skipped', reason: 'disabled' };
        }
        const task = dto.task || {};
        const account = task.account || {};
        if (!task.id) {
            return { status: 'skipped', reason: 'no_task' };
        }

        const taskSubfolder = String(task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\/+|\/+$/g, '');

        const normalizedBasePath = String(account.alistNativePath || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');

        const fullCloudPath = normalizedBasePath
            ? (taskSubfolder
                ? `${normalizedBasePath}/${taskSubfolder}`.replace(/\/+/g, '/').replace(/\/+$/g, '')
                : normalizedBasePath)
            : taskSubfolder;

        return await webhookService.notifyTransferComplete(task, {
            savePath: fullCloudPath,
            subfolder: taskSubfolder,
            files: dto.fileList || []
        });
    }

}

module.exports = { TaskEventHandler };

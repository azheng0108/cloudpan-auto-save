const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const path = require('path');
const { webhookService } = require('./WebhookService');
const { EmbyService } = require('./emby');
const { StrmService } = require('./strm');
const { ScrapeService } = require('./ScrapeService');
const alistService = require('./alistService');
const ConfigService = require('./ConfigService');


class TaskEventHandler {
    constructor(messageUtil) {
        this.messageUtil = messageUtil;
        this._embyNotifyAt = new Map();
        this._alistFirstLevelCache = new Map();
    }

    async _buildNormalizedTaskSubfolder(task, account, normalizedBasePath) {
        let taskSubfolder = String(task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\/+|\/+$/g, '');

        const rawSegments = taskSubfolder.split('/').filter(Boolean);
        if (rawSegments.length === 0) {
            return {
                taskSubfolder,
                matchedAnchor: '',
                rootFolders: [],
            };
        }

        const rootFolders = await this._getAListRootFolders(normalizedBasePath);
        if (rootFolders.length === 0) {
            logTaskEvent('未获取到 OpenList 挂载根首层目录，保持原始相对路径');
            return {
                taskSubfolder,
                matchedAnchor: '',
                rootFolders,
            };
        }

        const exactSet = new Set(rootFolders);
        const lowerMap = new Map(rootFolders.map(name => [name.toLowerCase(), name]));
        let matchedIndex = -1;
        let matchedAnchor = '';
        for (let i = 0; i < rawSegments.length; i++) {
            const seg = rawSegments[i];
            if (exactSet.has(seg)) {
                matchedIndex = i;
                matchedAnchor = seg;
                break;
            }
            const ciMatch = lowerMap.get(seg.toLowerCase());
            if (ciMatch) {
                matchedIndex = i;
                matchedAnchor = ciMatch;
                break;
            }
        }

        if (matchedIndex > 0) {
            taskSubfolder = rawSegments.slice(matchedIndex).join('/');
            logger.debug(`OpenList 路径锚点命中: ${matchedAnchor}`);
        } else if (matchedIndex === 0) {
            logger.debug(`OpenList 路径锚点命中: ${matchedAnchor}`);
        } else {
            logTaskEvent(`OpenList 路径锚点未命中，保持原路径: ${taskSubfolder}`);
            matchedAnchor = '';
        }

        return {
            taskSubfolder,
            matchedAnchor,
            rootFolders,
        };
    }

    async _getAListRootFolders(normalizedBasePath) {
        const cacheKey = normalizedBasePath || '/';
        const now = Date.now();
        const ttlMs = 60 * 1000;
        const cached = this._alistFirstLevelCache.get(cacheKey);
        if (cached && now - cached.timestamp < ttlMs) {
            return cached.folders;
        }

        try {
            const folders = await alistService.getFirstLevelFolders(cacheKey);
            this._alistFirstLevelCache.set(cacheKey, { folders, timestamp: now });
            if (folders.length > 0) {
                logger.debug(`OpenList 挂载根首层目录: ${folders.join(', ')}`);
            }
            return folders;
        } catch (error) {
            logTaskEvent(`读取 OpenList 挂载根首层目录失败: ${error.message}`);
            this._alistFirstLevelCache.set(cacheKey, { folders: [], timestamp: now });
            return [];
        }
    }

    async handle(taskCompleteEventDto) {
        // 全局后处理总开关：阶段性关闭后处理流程 (自动重命名/STRM/NFO/OpenList/Emby/Webhook)
        const isPostProcessEnabled = ConfigService.getConfigValue('postProcess.enable', false)
            || ConfigService.getConfigValue('postProcess.enabled', false);
        if (!isPostProcessEnabled) {
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
        let refreshContext = null;
        try {
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
            logTaskEvent('[4] OpenList 缓存刷新');
            refreshContext = await this._handleCloudCacheRefresh(taskCompleteEventDto);
        } catch (error) {
            logger.error('OpenList 缓存刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[4] OpenList 缓存刷新失败（不阻断后续通知）: ${error.message}`);
        }
        try {
            logTaskEvent('[5] Emby 媒体库直连刷新');
            const embyResult = await this._handleEmbyNotify(taskCompleteEventDto, refreshContext);
            if (embyResult?.status === 'success') {
                logTaskEvent(`[5] Emby 媒体库刷新完成: 模式=${embyResult.refreshMode || '目录增量'}`);
            } else if (embyResult?.status === 'skipped') {
                logTaskEvent(`[5] Emby 媒体库刷新跳过: ${embyResult.reason || '未启用'}`);
            }
        } catch (error) {
            logger.error('Emby 媒体库刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[5] Emby 媒体库刷新失败: ${error.message}`);
        }
        try {
            logTaskEvent('[6] Webhook 入库通知 (SmartStrm / 第三方)');
            const notifyResult = await this._handleWebhookNotify(taskCompleteEventDto, refreshContext);
            if (notifyResult?.status === 'success') {
                logTaskEvent(
                    `[6] Webhook 通知完成（HTTP ${notifyResult.statusCode || 200}）`
                );
            } else if (notifyResult?.status === 'skipped') {
                logTaskEvent(`[6] Webhook 通知跳过: ${notifyResult.reason || '未启用'}`);
            }
        } catch (error) {
            logger.error('Webhook 出站通知失败', { error: error.message, stack: error.stack });
            logTaskEvent(`[6] Webhook 出站通知失败: ${error.message}`);
        }
        logTaskEvent(`── 后处理完成 ──`);
    }

    async _handleAutoRename(taskCompleteEventDto) {
        try {
            if (
                taskCompleteEventDto.sourceMode === 'staging_organize' ||
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
        const strmEnabled = ConfigService.getConfigValue('strm.enable');
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
     * 单层刷新 OpenList 挂载点目录缓存。
     * 同时刷新原生路径（alistNativePath）和 STRM 虚拟路径（alistStrmPath 或自动推算），
     * 确保 OpenList STRM 驱动能为 Emby 暴露最新 .strm 文件。
     * 只发送 fs/list(refresh=true)，不做递归。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleCloudCacheRefresh(dto) {
        if (!alistService.Enable()) {
            const baseUrlExists = !!ConfigService.getConfigValue('alist.baseUrl');
            const apiKeyExists = !!ConfigService.getConfigValue('alist.apiKey');
            logTaskEvent(`Alist 未启用，跳过 OpenList 缓存刷新 | enable=false | baseUrl=${baseUrlExists} | apiKey=${apiKeyExists}`);
            return;
        }

        const task = dto.task || {};
        const account = task.account || {};
        if (!task.id) {
            logTaskEvent(`未指定任务实体，跳过 OpenList 缓存刷新`);
            return null;
        }
        const alistNativePath = account.alistNativePath?.trim();
        const alistStrmPathRaw = account.alistStrmPath?.trim();

        if (!alistNativePath && !alistStrmPathRaw) {
            logTaskEvent(`alistNativePath 与 alistStrmPath 均未配置，跳过 OpenList 缓存刷新 | taskId=${task.id} | realFolderName=${task.realFolderName}`);
            return;
        }

        // 推算 STRM 虚拟路径：账号手动配置 > 全局 strmMountPath + alistNativePath > 无
        let strmBasePath = alistStrmPathRaw;
        if (!strmBasePath && alistNativePath) {
            const strmMountPath = String(ConfigService.getConfigValue('alist.strmMountPath') || '')
                .trim()
                .replace(/\/+$/, '');
            if (strmMountPath) {
                const nativeSuffix = alistNativePath.replace(/^\/+/, '');
                strmBasePath = `${strmMountPath}/${nativeSuffix}`;
                logger.debug(`STRM 虚拟路径自动推算: ${strmBasePath}`);
            } else {
                logger.debug('STRM 挂载路径未配置，跳过 STRM 虚拟路径自动推算');
            }
        }

        // 原生路径刷新（优先，若 alistNativePath 存在）
        let nativeRefreshResult = null;
        let taskSubfolder = null;
        let nativeRefreshPath = null;

        if (alistNativePath) {
            const normalizedNative = String(alistNativePath)
                .replace(/\\/g, '/')
                .replace(/\/+/g, '/')
                .replace(/\/+$/g, '');

            const subfolder = await this._buildNormalizedTaskSubfolder(task, account, normalizedNative);
            taskSubfolder = subfolder.taskSubfolder;

            nativeRefreshPath = taskSubfolder
                ? `${normalizedNative}/${taskSubfolder}`
                : normalizedNative;

            await new Promise(resolve => setTimeout(resolve, 5000));

            if (dto.firstExecution) {
                const parentPath = nativeRefreshPath.includes('/')
                    ? nativeRefreshPath.substring(0, nativeRefreshPath.lastIndexOf('/'))
                    : null;
                if (parentPath) {
                    logger.debug(`首次执行，预热原生父目录缓存: ${parentPath}`);
                    await alistService.refreshSingleDirectory(parentPath).catch(e =>
                        logger.debug(`原生父目录预热失败(忽略): ${e.message}`)
                    );
                }
            }

            logger.debug(`触发 OpenList 原生路径缓存刷新: ${nativeRefreshPath}`);
            try {
                nativeRefreshResult = await alistService.refreshSingleDirectory(nativeRefreshPath);
                logTaskEvent(`原生目录刷新完成: ${nativeRefreshPath}（共 ${nativeRefreshResult.contentCount} 个文件）`);
            } catch (e) {
                if (dto.firstExecution && /object not found/i.test(e.message)) {
                    logTaskEvent(`OpenList 原生路径新目录刷新失败(首次执行容错，不阻断): ${e.message}`);
                    nativeRefreshResult = { success: false, firstExecutionPartial: true };
                } else {
                    throw e;
                }
            }
        } else {
            // 无原生路径，延迟移到 STRM 刷新前
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // STRM 虚拟路径刷新（在原生路径刷新后执行，确保原生缓存先就绪）
        let strmRefreshResult = null;
        let strmRefreshPath = null;

        if (strmBasePath) {
            const normalizedStrm = String(strmBasePath)
                .replace(/\\/g, '/')
                .replace(/\/+/g, '/')
                .replace(/\/+$/g, '');

            // 若原生路径未提供 taskSubfolder，则基于 STRM 路径重新计算
            if (!taskSubfolder && alistNativePath == null) {
                const subfolder = await this._buildNormalizedTaskSubfolder(task, account, normalizedStrm);
                taskSubfolder = subfolder.taskSubfolder;
            }

            strmRefreshPath = taskSubfolder
                ? `${normalizedStrm}/${taskSubfolder}`
                : normalizedStrm;

            if (dto.firstExecution) {
                const parentPath = strmRefreshPath.includes('/')
                    ? strmRefreshPath.substring(0, strmRefreshPath.lastIndexOf('/'))
                    : null;
                if (parentPath) {
                    logger.debug(`首次执行，预热 STRM 父目录缓存: ${parentPath}`);
                    await alistService.refreshSingleDirectory(parentPath).catch(e =>
                        logger.debug(`STRM 父目录预热失败(忽略): ${e.message}`)
                    );
                }
            }

            logger.debug(`触发 OpenList STRM 路径缓存刷新: ${strmRefreshPath}`);
            try {
                strmRefreshResult = await alistService.refreshSingleDirectory(strmRefreshPath);
                logTaskEvent(`STRM 目录刷新完成: ${strmRefreshPath}（共 ${strmRefreshResult.contentCount} 个文件）`);
            } catch (e) {
                if (dto.firstExecution && /object not found/i.test(e.message)) {
                    logTaskEvent(`OpenList STRM 路径新目录刷新失败(首次执行容错，不阻断): ${e.message}`);
                    strmRefreshResult = { success: false, firstExecutionPartial: true };
                } else {
                    logTaskEvent(`OpenList STRM 路径刷新失败(不阻断 Emby): ${e.message}`);
                    strmRefreshResult = { success: false, error: e.message };
                }
            }

            // 刷新后验证 STRM 内容是否已更新
            if (strmRefreshResult?.success !== false && Array.isArray(dto.fileList) && dto.fileList.length > 0) {
                const expectedFileNames = dto.fileList.map(f => {
                    const name = typeof f === 'string' ? f : (f?.fileName || f?.name || '');
                    return name.replace(/\.[^.]+$/, '') + '.strm';
                }).filter(Boolean);

                if (expectedFileNames.length > 0) {
                    let verifyResult = await alistService.verifyStrmContent(strmRefreshPath, expectedFileNames);
                    if (!verifyResult.verified) {
                        logTaskEvent(`STRM 内容验证未通过，等待 3 秒后重试：找到 ${verifyResult.foundCount} 个，缺失 ${verifyResult.missingCount} 个`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        verifyResult = await alistService.verifyStrmContent(strmRefreshPath, expectedFileNames);
                    }
                    if (verifyResult.verified) {
                        logTaskEvent(`STRM 内容验证通过（共 ${verifyResult.foundCount} 个文件）`);
                    } else {
                        logger.debug(`STRM 内容验证未通过: found=${verifyResult.foundCount}, missing=${verifyResult.missingCount}`);
                    }
                }
            }
        }

        const bothFailed = (alistNativePath && !nativeRefreshResult?.success && !nativeRefreshResult?.firstExecutionPartial)
            && (strmBasePath && !strmRefreshResult?.success && !strmRefreshResult?.firstExecutionPartial);
        if (bothFailed) {
            throw new Error(`OpenList 原生路径与 STRM 路径均刷新失败`);
        }

        const refreshPath = nativeRefreshPath || strmRefreshPath;
        const refreshMode = alistNativePath
            ? (strmBasePath ? '双路径' : '原生专用')
            : 'STRM 专用';

        logTaskEvent(`OpenList 缓存刷新完成（模式: ${refreshMode}）`);
        return {
            taskSubfolder,
            refreshPath,
            refreshMode,
        };
    }

    /**
     * 通知 Emby 刷新对应媒体库 (适用于 OpenList 原生 STRM 或本地 STRM 用户)。
     * 在 OpenList 目录缓存刷新后调用，向 Emby 发送标准轻量目录事件通知。
     * @param {TaskCompleteEventDto} dto
     * @param {object} refreshContext
     */
    async _handleEmbyNotify(dto, refreshContext = null) {
        // 用户明确要求：emby自动触发流程先不要触发
        logTaskEvent('[5] Emby 媒体库直连刷新跳过: 用户要求暂不自动触发');
        return { status: 'skipped', reason: 'auto_trigger_paused_by_user' };
    }

    /**
     * 通知 SmartStrm / 第三方 Webhook 服务触发媒体入库或生成 302 STRM
     * @param {TaskCompleteEventDto} dto
     * @param {object} refreshContext
     */
    async _handleWebhookNotify(dto, refreshContext = null) {
        if (!webhookService.outboundEnable) {
            return { status: 'skipped', reason: 'disabled' };
        }
        const task = dto.task || {};
        const account = task.account || {};
        if (!task.id) {
            return { status: 'skipped', reason: 'no_task' };
        }

        const normalizedBasePath = String(account.alistNativePath || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');
        const normalizedFromRefresh = String(refreshContext?.taskSubfolder || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\/+|\/+$/g, '');
        const { taskSubfolder: autoSubfolder } = await this._buildNormalizedTaskSubfolder(task, account, normalizedBasePath);
        const taskSubfolder = normalizedFromRefresh || autoSubfolder;

        const fallbackRawPath = String(task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');
        const fullCloudPath = normalizedBasePath
            ? (taskSubfolder
                ? `${normalizedBasePath}/${taskSubfolder}`.replace(/\/+/g, '/').replace(/\/+$/g, '')
                : normalizedBasePath)
            : fallbackRawPath;

        return await webhookService.notifyTransferComplete(task, {
            savePath: fullCloudPath,
            subfolder: taskSubfolder,
            files: dto.fileList || []
        });
    }

}

module.exports = { TaskEventHandler };

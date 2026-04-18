const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const path = require('path');
const { EmbyService } = require('./emby');
const { StrmService } = require('./strm');
const { ScrapeService } = require('./ScrapeService');
const alistService = require('./alistService');
const ConfigService = require('./ConfigService');

/**
 * 任务完成事件处理器
 * 按顺序执行：自动重命名 → 本地 STRM 生成 → OpenList 缓存刷新 → Emby 通知
 * STRM 文件始终存储在本地供 Emby 读取；OpenList 刷新仅用于解决转存后缓存不及时的问题
 */
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
            logTaskEvent(`OpenList 路径锚点命中: ${matchedAnchor}`);
        } else if (matchedIndex === 0) {
            logTaskEvent(`OpenList 路径锚点命中: ${matchedAnchor}`);
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
                logTaskEvent(`OpenList 挂载根首层目录: ${folders.join(', ')}`);
            }
            return folders;
        } catch (error) {
            logTaskEvent(`读取 OpenList 挂载根首层目录失败: ${error.message}`);
            this._alistFirstLevelCache.set(cacheKey, { folders: [], timestamp: now });
            return [];
        }
    }

    async handle(taskCompleteEventDto) {
        const task = taskCompleteEventDto.task;
        const fileCount = Array.isArray(taskCompleteEventDto.fileList) ? taskCompleteEventDto.fileList.length : 0;
        logTaskEvent(`事件接收: taskComplete | taskId=${task?.id} | resource=${task?.resourceName || '未知'} | fileCount=${fileCount}`);
        if (taskCompleteEventDto.fileList.length === 0) {
            logTaskEvent(`事件跳过: taskComplete | taskId=${task?.id} | reason=fileList=0`);
            return;
        }
        let refreshContext = null;
        logTaskEvent(` ${task.resourceName} 触发事件:`);
        try {
            await this._handleAutoRename(taskCompleteEventDto);
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`自动重命名失败: ${error.message}`);
        }
        try {
            await this._handleLocalStrmGenerate(taskCompleteEventDto);
        } catch (error) {
            logger.error('本地 STRM 生成失败', { error: error.message, stack: error.stack });
            logTaskEvent(`本地 STRM 生成失败: ${error.message}`);
        }
        try {
            await this._handleNfoGenerate(taskCompleteEventDto);
        } catch (error) {
            logger.error('NFO 刮削失败', { error: error.message, stack: error.stack });
            logTaskEvent(`NFO 刮削失败（不阻断后续流程）: ${error.message}`);
        }
        try {
            // 优先使用原生驱动路径刷新 OpenList 缓存，降级使用 STRM 路径；失败不阻断 Emby 通知
            refreshContext = await this._handleCloudCacheRefresh(taskCompleteEventDto);
        } catch (error) {
            logger.error('OpenList 缓存刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`OpenList 缓存刷新失败（不阻断 Emby 通知）: ${error.message}`);
        }
        try {
            const notifyResult = await this._handleEmbyNotify(taskCompleteEventDto, refreshContext);
            if (notifyResult?.status === 'success') {
                logTaskEvent(
                    `Emby通知完成 | firstExecution=${!!notifyResult.firstExecution} | refreshMode=${notifyResult.refreshMode || 'unknown'}`
                );
            } else if (notifyResult?.status === 'skipped') {
                logTaskEvent(`Emby通知跳过: ${notifyResult.reason || 'unknown'}`);
            }
        } catch (error) {
            logger.error('Emby 通知失败', { error: error.message, stack: error.stack });
            logTaskEvent(`Emby 通知失败: ${error.message}`);
        }
        logTaskEvent(`================事件处理完成================`);
    }

    async _handleAutoRename(taskCompleteEventDto) {
        try {
            const newFiles = await taskCompleteEventDto.taskService.autoRename(taskCompleteEventDto.task);
            if (newFiles.length > 0) {
                taskCompleteEventDto.fileList = newFiles;
            }
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`自动重命名失败: ${error.message}`);
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
        const task = dto.task;
        const localStrmPrefix = ConfigService.getConfigValue('strm.localStrmPrefix') || task.account?.localStrmPrefix || '';
        if (!localStrmPrefix) {
            logTaskEvent(`strm.localStrmPrefix 未配置，跳过本地 STRM 生成 | taskId=${task.id}`);
            return;
        }
        const files = Array.isArray(dto.fileList) ? dto.fileList : [];
        if (files.length === 0) {
            logTaskEvent(`fileList 为空，跳过本地 STRM 生成 | taskId=${task.id}`);
            return;
        }
        const strmService = new StrmService();
        logTaskEvent(`开始本地 STRM 生成 | taskId=${task.id} | fileCount=${files.length}`);
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
        logTaskEvent(`开始 NFO 刮削 | taskId=${task.id} | dir=${targetDir}`);
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

        const task = dto.task;
        const account = task.account || {};
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
                logTaskEvent(`STRM 虚拟路径自动推算: ${strmMountPath} + ${alistNativePath} → ${strmBasePath}`);
            } else {
                logTaskEvent(`STRM 挂载路径未配置，跳过 STRM 虚拟路径自动推算`);
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
                    logTaskEvent(`首次执行，预热原生父目录缓存: ${parentPath}`);
                    await alistService.refreshSingleDirectory(parentPath).catch(e =>
                        logTaskEvent(`原生父目录预热失败(忽略): ${e.message}`)
                    );
                }
            }

            logTaskEvent(`触发 OpenList 原生路径缓存刷新: ${nativeRefreshPath}`);
            try {
                nativeRefreshResult = await alistService.refreshSingleDirectory(nativeRefreshPath);
                logTaskEvent(`OpenList 原生路径刷新完成: ${nativeRefreshPath} | count=${nativeRefreshResult.contentCount}`);
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
                    logTaskEvent(`首次执行，预热 STRM 父目录缓存: ${parentPath}`);
                    await alistService.refreshSingleDirectory(parentPath).catch(e =>
                        logTaskEvent(`STRM 父目录预热失败(忽略): ${e.message}`)
                    );
                }
            }

            logTaskEvent(`触发 OpenList STRM 路径缓存刷新: ${strmRefreshPath}`);
            try {
                strmRefreshResult = await alistService.refreshSingleDirectory(strmRefreshPath);
                logTaskEvent(`OpenList STRM 路径刷新完成: ${strmRefreshPath} | count=${strmRefreshResult.contentCount}`);
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
                        logTaskEvent(`STRM 内容验证未通过，等待 3s 后重试: found=${verifyResult.foundCount}, missing=${verifyResult.missingCount}`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        verifyResult = await alistService.verifyStrmContent(strmRefreshPath, expectedFileNames);
                    }
                    logTaskEvent(`STRM 内容验证: verified=${verifyResult.verified}, found=${verifyResult.foundCount}, missing=${verifyResult.missingCount}`);
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
            ? (strmBasePath ? 'dual-path' : 'native-only')
            : 'strm-only';

        logTaskEvent(`OpenList 缓存刷新完成 | mode=${refreshMode} | native=${nativeRefreshPath || '无'} | strm=${strmRefreshPath || '无'}`);
        return {
            taskSubfolder,
            refreshPath,
            refreshMode,
        };
    }

    /**
     * 通知 Emby 刷新对应媒体库。
     * 在 STRM 文件全部生成后调用，确保 Emby 能扫描到新文件。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleEmbyNotify(dto, refreshContext = null) {
        // EmbyService 构造时读取 emby.enable，未启用时内部会短路返回
        const embyService = new EmbyService(null);
        if (!embyService.enable) {
            const serverExists = !!ConfigService.getConfigValue('emby.serverUrl');
            const apiKeyExists = !!ConfigService.getConfigValue('emby.apiKey');
            logTaskEvent(`Emby 未启用，跳过通知 | enable=false | serverUrl=${serverExists} | apiKey=${apiKeyExists}`);
            return { status: 'skipped', reason: 'disabled' };
        }
        const task = dto.task;
        const account = task.account || {};

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

        const debounceMs = Number(ConfigService.getConfigValue('emby.notifyDebounceMs')) || 2000;
        // 若未配置原生挂载路径，则回退到原任务路径，避免影响仅 Emby 通知场景。
        const fallbackRawPath = String(task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');
        const fullCloudPath = normalizedBasePath
            ? (taskSubfolder
                ? `${normalizedBasePath}/${taskSubfolder}`.replace(/\/+/g, '/').replace(/\/+$/g, '')
                : normalizedBasePath)
            : fallbackRawPath;
        const debounceKey = `${task.accountId || 'unknown'}:${fullCloudPath}`;
        const now = Date.now();
        const lastAt = this._embyNotifyAt.get(debounceKey) || 0;
        if (lastAt > 0 && now - lastAt < debounceMs) {
            logTaskEvent(`Emby 通知防抖命中，跳过重复通知: key=${debounceKey}, interval=${now - lastAt}ms`);
            return { status: 'skipped', reason: 'debounced' };
        }
        this._embyNotifyAt.set(debounceKey, now);
        logTaskEvent(`Emby 通知准备执行: taskId=${task.id} | path=${fullCloudPath} | debounceMs=${debounceMs}`);

        const taskForEmby = {
            ...task,
            realFolderName: fullCloudPath,
        };

        const result = await embyService.notify(taskForEmby, {
            firstExecution: !!dto.firstExecution,
            directoryPath: fullCloudPath,
        });
        return result || { status: 'skipped', reason: 'empty-result' };
    }

}

module.exports = { TaskEventHandler };

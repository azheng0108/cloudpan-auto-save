const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const { EmbyService } = require('./emby');
const alistService = require('./alistService');
const ConfigService = require('./ConfigService');

/**
 * 任务完成事件处理器
 * 按顺序执行：自动重命名 → OpenList 原生挂载点缓存刷新 → Emby 通知
 * 缓存刷新完成后才通知 Emby，确保 Emby 扫库时路径对应的目录缓存已更新
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
        if (taskCompleteEventDto.fileList.length === 0) {
            return;
        }
        const task = taskCompleteEventDto.task;
        let refreshContext = null;
        logTaskEvent(` ${task.resourceName} 触发事件:`);
        try {
            await this._handleAutoRename(taskCompleteEventDto);
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`自动重命名失败: ${error.message}`);
        }
        try {
            // 先刷新 OpenList 原生挂载点目录缓存，再通知 Emby
            refreshContext = await this._handleCloudCacheRefresh(taskCompleteEventDto);
        } catch (error) {
            logger.error('OpenList 原生挂载点缓存刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`OpenList 原生挂载点缓存刷新失败: ${error.message}`);
            logTaskEvent('OpenList 刷新失败，阻断 Emby 通知');
            logTaskEvent(`================事件处理完成================`);
            return;
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
            const newFiles = await taskCompleteEventDto.taskService.autoRename(taskCompleteEventDto.cloud189, taskCompleteEventDto.task);
            if (newFiles.length > 0) {
                taskCompleteEventDto.fileList = newFiles;
            }
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`自动重命名失败: ${error.message}`);
        }
    }

    /**
     * 单层刷新 OpenList 原生网盘挂载点目录缓存。
     * 只发送一次 fs/list(refresh=true)，不做递归，避免触发 STRM 驱动副作用和性能放大。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleCloudCacheRefresh(dto) {
        if (!alistService.Enable()) {
            logTaskEvent('Alist 未启用，跳过 OpenList 原生挂载点缓存刷新');
            return;
        }

        const task = dto.task;
        const account = task.account || {};
        // 使用账号级原生挂载路径，确保刷新命中真实网盘驱动而非 STRM 驱动
        const alistNativePath = account.alistNativePath?.trim();

        if (!alistNativePath) {
            logTaskEvent(`alistNativePath 未配置，跳过 OpenList 原生挂载点缓存刷新 | realFolderName=${task.realFolderName}`);
            return;
        }

        const normalizedBasePath = String(alistNativePath)
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');

        const { taskSubfolder } = await this._buildNormalizedTaskSubfolder(task, account, normalizedBasePath);

        if (!taskSubfolder) {
            logTaskEvent(`task.realFolderName 为空，刷新将仅作用于根路径: ${normalizedBasePath}`);
        }

        const refreshPath = taskSubfolder
            ? `${normalizedBasePath}/${taskSubfolder}`
            : normalizedBasePath;
        await new Promise(resolve => setTimeout(resolve, 5000));
        logTaskEvent(`触发 OpenList 缓存刷新: ${refreshPath}`);
        const refreshResult = await alistService.refreshSingleDirectory(refreshPath);
        if (!refreshResult?.success) {
            throw new Error(`OpenList 单层刷新失败: ${refreshPath}`);
        }

        logTaskEvent(`OpenList 缓存刷新完成: ${refreshPath}`);
        return {
            taskSubfolder,
            refreshPath,
            refreshMode: 'single-directory-native-cache',
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

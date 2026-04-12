const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const { EmbyService } = require('./emby');
const alistService = require('./alistService');
const ConfigService = require('./ConfigService');

/**
 * 任务完成事件处理器
 * 按顺序执行：自动重命名 → OpenList STRM 刷新 → Emby 通知
 * STRM 刷新完成后才通知 Emby，确保 Emby 扫库时文件已就绪
 */
class TaskEventHandler {
    constructor(messageUtil) {
        this.messageUtil = messageUtil;
        this._embyNotifyAt = new Map();
        this._openListRootIdCache = new Map();
    }

    async _resolveOpenListRootId(account, alistStrmPath) {
        const cacheKey = `${account?.id || 'unknown'}:${String(alistStrmPath || '').trim()}`;
        if (this._openListRootIdCache.has(cacheKey)) {
            return this._openListRootIdCache.get(cacheKey);
        }

        const autoResolved = await alistService.resolveRootFolderIdByPath(alistStrmPath);
        if (autoResolved) {
            logTaskEvent(`自动识别 OpenList 挂载根目录 ID 成功: ${autoResolved}`);
        }
        this._openListRootIdCache.set(cacheKey, autoResolved || '');
        return autoResolved || '';
    }

    async _buildNormalizedTaskSubfolder(task, account, normalizedBasePath) {
        const cloudParentId = String(task.parentFileId || '').trim();
        let taskSubfolder = String(task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\/+|\/+$/g, '');

        let openListRootId = '';
        if (normalizedBasePath) {
            openListRootId = await this._resolveOpenListRootId(account, normalizedBasePath);
            if (!openListRootId) {
                logTaskEvent('自动识别 rootFolderId 失败，将按默认挂载策略保留完整路径');
            }
        }

        if (openListRootId && !cloudParentId) {
            logTaskEvent(`自动识别到 rootFolderId 但任务缺少 parentFileId，跳过偏移裁剪: taskId=${task.id}`);
        }

        if (openListRootId && cloudParentId && openListRootId === cloudParentId) {
            const pathParts = taskSubfolder.split('/').filter(Boolean);
            if (pathParts.length > 1) {
                logTaskEvent(`检测到挂载偏移，剔除首层目录: ${pathParts[0]}`);
                pathParts.shift();
                taskSubfolder = pathParts.join('/');
            }
        }

        return {
            taskSubfolder,
            openListRootId,
            cloudParentId,
        };
    }

    async handle(taskCompleteEventDto) {
        if (taskCompleteEventDto.fileList.length === 0) {
            return;
        }
        const task = taskCompleteEventDto.task;
        logTaskEvent(` ${task.resourceName} 触发事件:`);
        try {
            await this._handleAutoRename(taskCompleteEventDto);
        } catch (error) {
            logger.error('自动重命名失败', { error: error.message, stack: error.stack });
            logTaskEvent(`自动重命名失败: ${error.message}`);
        }
        try {
            // 先递归触发 OpenList STRM 驱动写文件，完成后再通知 Emby
            await this._handleOpenListStrmRefresh(taskCompleteEventDto);
        } catch (error) {
            logger.error('OpenList STRM 刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`OpenList STRM 刷新失败: ${error.message}`);
            logTaskEvent('OpenList 刷新失败，阻断 Emby 通知');
            logTaskEvent(`================事件处理完成================`);
            return;
        }
        try {
            await this._handleEmbyNotify(taskCompleteEventDto);
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
     * 递归调用 OpenList STRM 驱动路径，触发 .strm 文件同步生成。
     * 原理：OpenList STRM 驱动在 /api/fs/list 被调用时同步写入当前目录的 .strm 文件，
     * 递归完成即代表任务目录下所有 .strm 文件已落盘。
     *
     * 刷新路径 = alistStrmPath（账号级 OpenList 根路径） + 完整 realFolderName
     * alistStrmPath 与 cloudStrmPrefix 解耦：前者用于刷新，后者用于 .strm URL 生成。
     * 支持任意目标目录（tv / 临时存放 / 电影…）和任意账号挂载结构。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleOpenListStrmRefresh(dto) {
        if (!alistService.Enable()) {
            logTaskEvent('Alist 未启用，跳过 OpenList STRM 刷新');
            return;
        }

        const task = dto.task;
        const account = task.account || {};
        // 使用账号专用的 alistStrmPath 字段，与 cloudStrmPrefix 解耦
        const alistStrmPath = account.alistStrmPath?.trim();

        if (!alistStrmPath) {
            logTaskEvent(`alistStrmPath 未配置，跳过 STRM 刷新 | realFolderName=${task.realFolderName} | cloudStrmPrefix=${task.account?.cloudStrmPrefix}`);
            return;
        }

        const normalizedBasePath = String(alistStrmPath)
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

        logTaskEvent(`触发 OpenList STRM 刷新 | alistStrmPath=${alistStrmPath} | realFolderName=${task.realFolderName} | refreshPath=${refreshPath}`);
        const refreshResult = await alistService.recursiveRefresh(refreshPath);
        if (refreshResult.visitedCount === 0) {
            throw new Error(`OpenList 刷新未触达任何目录: ${refreshPath}`);
        }
        if (refreshResult.failedCount > 0) {
            const preview = refreshResult.failedPaths
                .slice(0, 3)
                .map(item => `${item.path}(${item.error})`)
                .join('; ');
            throw new Error(`OpenList 刷新存在失败目录: ${refreshResult.failedCount}/${refreshResult.visitedCount}; ${preview}`);
        }
        logTaskEvent(`OpenList STRM 刷新完成: ${refreshPath} | 目录数=${refreshResult.visitedCount} | 失败数=0`);
    }

    /**
     * 通知 Emby 刷新对应媒体库。
     * 在 STRM 文件全部生成后调用，确保 Emby 能扫描到新文件。
     * @param {TaskCompleteEventDto} dto
     */
    async _handleEmbyNotify(dto) {
        // EmbyService 构造时读取 emby.enable，未启用时内部会短路返回
        const embyService = new EmbyService(null);
        if (!embyService.enable) {
            logTaskEvent('Emby 通知未启用，跳过');
            return;
        }
        const task = dto.task;
        const account = task.account || {};

        const normalizedBasePath = String(account.alistStrmPath || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '');
        const { taskSubfolder } = await this._buildNormalizedTaskSubfolder(task, account, normalizedBasePath);

        const debounceMs = Number(ConfigService.getConfigValue('emby.notifyDebounceMs')) || 2000;
        const debounceKey = `${task.accountId || 'unknown'}:${taskSubfolder}`;
        const now = Date.now();
        const lastAt = this._embyNotifyAt.get(debounceKey) || 0;
        if (lastAt > 0 && now - lastAt < debounceMs) {
            logTaskEvent(`Emby 通知防抖命中，跳过重复通知: key=${debounceKey}, interval=${now - lastAt}ms`);
            return;
        }
        this._embyNotifyAt.set(debounceKey, now);

        const taskForEmby = {
            ...task,
            realFolderName: taskSubfolder,
        };

        await embyService.notify(taskForEmby, {
            firstExecution: !!dto.firstExecution,
            directoryPath: taskSubfolder,
        });
    }

}

module.exports = { TaskEventHandler };

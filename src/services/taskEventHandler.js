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
            const dropped = rawSegments.slice(0, matchedIndex).join('/');
            taskSubfolder = rawSegments.slice(matchedIndex).join('/');
            logTaskEvent(`OpenList 路径锚点命中: ${matchedAnchor}，剔除前缀: ${dropped}，结果: ${taskSubfolder}`);
        } else if (matchedIndex === 0) {
            logTaskEvent(`OpenList 路径锚点命中: ${matchedAnchor}，无需剔除前缀`);
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
            // 先递归触发 OpenList STRM 驱动写文件，完成后再通知 Emby
            refreshContext = await this._handleOpenListStrmRefresh(taskCompleteEventDto);
        } catch (error) {
            logger.error('OpenList STRM 刷新失败', { error: error.message, stack: error.stack });
            logTaskEvent(`OpenList STRM 刷新失败: ${error.message}`);
            logTaskEvent('OpenList 刷新失败，阻断 Emby 通知');
            logTaskEvent(`================事件处理完成================`);
            return;
        }
        try {
            await this._handleEmbyNotify(taskCompleteEventDto, refreshContext);
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
        if (refreshResult.visitedCount > 0 && refreshResult.failedCount === 0) {
            logTaskEvent(`OpenList STRM 刷新完成: ${refreshPath} | 目录数=${refreshResult.visitedCount} | 失败数=0`);
            return {
                taskSubfolder,
                refreshPath,
                refreshMode: 'strict-manual-root-id',
            };
        }

        const preview = refreshResult.failedPaths
            .slice(0, 3)
            .map(item => `${item.path}(${item.error})`)
            .join('; ');
        throw new Error(`OpenList 刷新失败: ${refreshPath} | visited=${refreshResult.visitedCount}, failed=${refreshResult.failedCount}${preview ? ` | ${preview}` : ''}`);
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
            logTaskEvent('Emby 通知未启用，跳过');
            return;
        }
        const task = dto.task;
        const account = task.account || {};

        const normalizedBasePath = String(account.alistStrmPath || '')
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

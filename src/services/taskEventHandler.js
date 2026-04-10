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
        // 使用账号专用的 alistStrmPath 字段，与 cloudStrmPrefix 解耦
        const alistStrmPath = task.account?.alistStrmPath?.trim();

        if (!alistStrmPath) {
            logTaskEvent(`alistStrmPath 未配置，跳过 STRM 刷新 | realFolderName=${task.realFolderName} | cloudStrmPrefix=${task.account?.cloudStrmPrefix}`);
            return;
        }

        // 使用完整 realFolderName（不裁剪任何段），normalize Windows 反斜杠
        // 修复：原逻辑裁掉第一段导致多目标目录时路径错误，且 Windows 下 path.join 产生 \ 会使 indexOf('/') 返回 -1
        const taskSubfolder = (task.realFolderName || '')
            .replace(/\\/g, '/')
            .replace(/^\/|\/$/g, '');

        const refreshPath = taskSubfolder
            ? `${alistStrmPath.replace(/\/$/, '')}/${taskSubfolder}`
            : alistStrmPath;

        logTaskEvent(`触发 OpenList STRM 刷新 | alistStrmPath=${alistStrmPath} | realFolderName=${task.realFolderName} | refreshPath=${refreshPath}`);
        await alistService.recursiveRefresh(refreshPath);
        logTaskEvent(`OpenList STRM 刷新完成: ${refreshPath}`);
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
        await embyService.notify(dto.task);
    }

}

module.exports = { TaskEventHandler };

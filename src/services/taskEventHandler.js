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
     * @param {TaskCompleteEventDto} dto
     */
    async _handleOpenListStrmRefresh(dto) {
        if (!alistService.Enable()) {
            logTaskEvent('Alist 未启用，跳过 OpenList STRM 刷新');
            return;
        }

        const task = dto.task;
        const alistBaseUrl = ConfigService.getConfigValue('alist.baseUrl');
        const cloudStrmPrefix = task.account?.cloudStrmPrefix;

        // cloudStrmPrefix 必须以 alist.baseUrl 开头，否则不是 OpenList STRM 驱动 URL
        if (!cloudStrmPrefix || !alistBaseUrl || !cloudStrmPrefix.startsWith(alistBaseUrl)) {
            logTaskEvent(`cloudStrmPrefix 未配置或不匹配 Alist 地址，跳过 STRM 刷新`);
            return;
        }

        // 从 cloudStrmPrefix 中提取 OpenList 内的 STRM 驱动挂载路径
        // 例：http://openlist:5244/d/strm_115  →  /strm_115
        const strmDriverPath = cloudStrmPrefix
            .replace(alistBaseUrl, '')
            .replace(/^\/d/, '');

        // 任务子目录：realFolderName 去掉账号根目录前缀（第一段）
        const taskSubfolder = task.realFolderName
            ?.substring(task.realFolderName.indexOf('/') + 1)
            ?.replace(/^\/|\/$/g, '');

        const refreshPath = taskSubfolder
            ? `${strmDriverPath}/${taskSubfolder}`
            : strmDriverPath;

        logTaskEvent(`触发 OpenList STRM 刷新: ${refreshPath}`);
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

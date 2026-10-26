const { RecognitionEngine } = require('../services/RecognitionEngine');

class CreateTaskDto {
    constructor(data) {
        this.accountId = data.accountId;
        this.shareLink = data.shareLink || data.shareUrl;
        this.targetFolderId = data.targetFolderId;
        this.totalEpisodes = data.totalEpisodes;
        this.accessCode = data.accessCode || data.shareCode;
        this.matchPattern = data.matchPattern;
        this.matchOperator = data.matchOperator;
        this.matchValue = data.matchValue;
        this.overwriteFolder = data.overwriteFolder;
        this.remark = data.remark;
        this.enableCron = data.enableCron;
        this.cronExpression = data.cronExpression;
        this.realRootFolderId = data.realRootFolderId;
        this.targetFolder = data.targetFolder;
        this.targetDetailPath = data?.targetDetailPath;
        this.selectedFolders = data?.selectedFolders; // 选中的分享目录
        this.tgbot = data?.tgbot;
        this.sourceRegex = data?.sourceRegex; // 源正则 (自动重命名)
        this.targetRegex = data?.targetRegex; // 目标正则 (自动重命名)
        this.movieRenameFormat = data?.movieRenameFormat || ''; // 电影 Jinja2 重命名格式（任务级覆盖）
        this.tvRenameFormat = data?.tvRenameFormat || ''; // 电视剧 Jinja2 重命名格式（任务级覆盖）
        const rawTitle = data?.resourceName || data?.taskName || '';
        this.resourceName = rawTitle ? (RecognitionEngine.sanitizeMediaTitle(rawTitle) || rawTitle) : '';
        this.taskName = this.resourceName || data?.taskName; // 保持 taskName 与清洗后的 resourceName 一致
        this.enableSystemProxy = data?.enableSystemProxy; // 启用系统代理
        this.isFolder = data?.isFolder; // 是否是文件夹
        this.disableRename = data?.disableRename ?? null; // 禁用自动命名（true=禁用，null/false=使用全局模板）
        this.tmdbId = data?.tmdbId || ''; // 绑定的 TMDB ID
        this.videoType = data?.videoType || 'tv'; // 影视分类：tv | movie
        this.enableTaskScraper = data?.enableTaskScraper ?? false; // 是否启用 TMDB 规范整理归档
        this.posterPath = data?.posterPath || '';
        this.tmdbContent = data?.tmdbContent || '';
    }

    validate() {
        if (!this.accountId) throw new Error('账号ID不能为空');
        if (!this.shareLink) throw new Error('分享链接不能为空');
        if (!this.tmdbId) throw new Error('追更任务必须关联 TMDB ID（tmdbId 不能为空）');
        if (!this.targetFolderId) throw new Error('目标目录不能为空');
        if (this.matchPattern && !this.matchValue) throw new Error('填了匹配模式, 那么匹配值就必须填');
        if (this.matchOperator && !['lt', 'eq', 'gt', 'contains', 'notContains'].includes(this.matchOperator)) {
            throw new Error('无效的匹配操作符');
        }
        // if (!this.tgbot && (!this.selectedFolders || this.selectedFolders.length === 0)) {
        //     throw new Error('分享目录最少选择一个');
        // }
    }
}

module.exports = { CreateTaskDto };
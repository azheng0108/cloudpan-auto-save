/**
 * P1-02: 任务错误记录服务
 * 
 * 用于记录和管理任务执行过程中的错误
 */

const { ErrorClassifier, ERROR_TYPES } = require('./errorClassifier');
const { logTaskEvent } = require('../utils/logUtils');

class TaskErrorService {
    static authFailNotifyCache = new Map();

    constructor(taskErrorRepo, options = {}) {
        this.taskErrorRepo = taskErrorRepo;
        this.messageUtil = options.messageUtil || null;
    }

    _buildAuthFailureNotifyKey(taskId, additionalContext = {}) {
        const accountId = additionalContext.accountId;
        if (accountId !== undefined && accountId !== null) {
            return `account:${accountId}`;
        }
        return `task:${taskId}`;
    }

    async _notifyAuthFailure(taskId, error, additionalContext = {}) {
        if (!this.messageUtil || typeof this.messageUtil.sendMessage !== 'function') {
            return;
        }

        const key = this._buildAuthFailureNotifyKey(taskId, additionalContext);
        const now = Date.now();
        const dedupeMs = 24 * 60 * 60 * 1000;
        const lastNotifyAt = TaskErrorService.authFailNotifyCache.get(key) || 0;
        if (now - lastNotifyAt < dedupeMs) {
            return;
        }

        TaskErrorService.authFailNotifyCache.set(key, now);
        const accountId = additionalContext.accountId ?? '未知';
        const resourceName = additionalContext.resourceName || '未命名任务';
        const code = error.apiCode || error.code || 'UNKNOWN';
        const message = [
            '【认证失效通知】',
            `任务: ${resourceName} (ID: ${taskId})`,
            `账号ID: ${accountId}`,
            `错误码: ${code}`,
            `原因: ${error.message || '认证失败'}`,
            '处理建议: 请在账号页面更新Cookie后重试。',
        ].join('\n');

        try {
            await this.messageUtil.sendMessage(message);
        } catch (notifyError) {
            logTaskEvent(`[错误记录] 发送认证失效通知失败: ${notifyError.message}`);
        }
    }

    /**
     * 记录任务错误
     * @param {number} taskId - 任务 ID
     * @param {Error} error - 错误对象
     * @param {Object} additionalContext - 额外上下文信息
     */
    async recordError(taskId, error, additionalContext = {}) {
        if (!this.taskErrorRepo) {
            logTaskEvent(`[错误记录] TaskError 仓库未初始化，跳过错误记录`);
            return;
        }

        try {
            // 分类错误
            const classification = ErrorClassifier.classify(error);
            const errorType = classification.type;

            // 创建错误记录
            const errorRecord = {
                taskId,
                errorType: errorType.code,
                errorCode: error.apiCode || error.code || null,
                errorMessage: error.message || errorType.description,
                stackTrace: error.stack || null,
                retryable: errorType.retryable,
                fatal: errorType.fatal,
                httpStatus: error.response?.statusCode || error.statusCode || null,
                apiCode: error.apiCode || null,
                context: JSON.stringify({
                    ...classification.context,
                    ...additionalContext
                })
            };

            await this.taskErrorRepo.save(errorRecord);

            logTaskEvent(`[错误记录] 任务 ${taskId} 错误已记录: ${errorType.name} (${errorType.code})`);

            if (errorType.code === 'AUTH_FAILED') {
                await this._notifyAuthFailure(taskId, error, additionalContext);
            }
        } catch (err) {
            logTaskEvent(`[错误记录] 记录失败: ${err.message}`);
            // 不抛出异常，错误记录失败不应影响主流程
        }
    }

    /**
     * 获取任务的错误历史
     * @param {number} taskId - 任务 ID
     * @param {Object} options - 查询选项
     * @returns {Promise<Array>} 错误记录列表
     */
    async getTaskErrors(taskId, options = {}) {
        if (!this.taskErrorRepo) {
            return [];
        }

        try {
            const where = { taskId };
            
            if (options.errorType) {
                where.errorType = options.errorType;
            }

            const errors = await this.taskErrorRepo.find({
                where,
                order: { createdAt: 'DESC' },
                take: options.limit || 50
            });

            return errors;
        } catch (err) {
            logTaskEvent(`[错误记录] 查询失败: ${err.message}`);
            return [];
        }
    }

    /**
     * 获取最近的错误
     * @param {number} taskId - 任务 ID
     * @returns {Promise<Object|null>} 最近的错误记录
     */
    async getLastError(taskId) {
        const errors = await this.getTaskErrors(taskId, { limit: 1 });
        return errors.length > 0 ? errors[0] : null;
    }

    /**
     * 统计任务错误类型分布
     * @param {number} taskId - 任务 ID
     * @returns {Promise<Object>} 错误类型统计
     */
    async getErrorStats(taskId) {
        if (!this.taskErrorRepo) {
            return {};
        }

        try {
            const errors = await this.getTaskErrors(taskId, { limit: 100 });
            
            const stats = {};
            errors.forEach(error => {
                const type = error.errorType || 'UNKNOWN';
                stats[type] = (stats[type] || 0) + 1;
            });

            return stats;
        } catch (err) {
            logTaskEvent(`[错误记录] 统计失败: ${err.message}`);
            return {};
        }
    }

    /**
     * 判断错误是否应该重试
     * @param {Object} error - 错误对象或错误记录
     * @returns {boolean} 是否应该重试
     */
    shouldRetry(error) {
        if (!error) return false;

        // 如果是错误记录对象
        if (error.retryable !== undefined) {
            return error.retryable && !error.fatal;
        }

        // 如果是 Error 对象，先分类
        const classification = ErrorClassifier.classify(error);
        return classification.type.retryable && !classification.type.fatal;
    }

    /**
     * 获取重试延迟时间（秒）
     * @param {Object} error - 错误对象或错误记录
     * @param {number} retryCount - 当前重试次数
     * @returns {number} 延迟时间（秒）
     */
    getRetryDelay(error, retryCount = 0) {
        let baseDelay = 300; // 默认5分钟

        if (error) {
            // 错误记录对象分支：优先根据 errorType 直接映射
            if (error.errorType && typeof error.errorType === 'string') {
                const mapped = ERROR_TYPES[error.errorType];
                if (mapped && mapped.retryDelay) {
                    baseDelay = mapped.retryDelay;
                } else if (typeof error.retryDelay === 'number' && error.retryDelay > 0) {
                    baseDelay = error.retryDelay;
                }
            } else {
                const classification = ErrorClassifier.classify(error);
                baseDelay = classification.type.retryDelay || 300;
            }
        }

        // 指数退避：baseDelay * 2^retryCount，最大不超过1小时
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), 3600);
        return delay;
    }
}

module.exports = TaskErrorService;

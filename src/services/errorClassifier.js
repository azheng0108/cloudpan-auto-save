/**
 * P1-02: 错误分类系统
 * 
 * 统一的错误类型定义和分类逻辑
 */

/**
 * 错误类型枚举
 */
const ERROR_TYPES = {
    // 链接相关错误（致命，不可恢复）
    LINK_INVALID: {
        code: 'LINK_INVALID',
        name: '链接失效',
        fatal: true,
        retryable: false,
        apiCodes: ['200000727'], // 外链不存在/被取消
        description: '分享链接已被删除或取消'
    },
    LINK_EXPIRED: {
        code: 'LINK_EXPIRED',
        name: '链接过期',
        fatal: true,
        retryable: false,
        apiCodes: ['200000401'],
        description: '分享链接已过期'
    },
    LINK_LIMIT_EXCEEDED: {
        code: 'LINK_LIMIT_EXCEEDED',
        name: '访问次数超限',
        fatal: true,
        retryable: false,
        apiCodes: ['200000402'],
        description: '分享链接已达到访问次数上限'
    },
    
    // 权限相关错误（致命）
    PERMISSION_DENIED: {
        code: 'PERMISSION_DENIED',
        name: '权限不足',
        fatal: true,
        retryable: false,
        httpStatus: [403],
        description: '账号无权访问该资源'
    },
    USER_INFO_QUERY_FAILED: {
        code: 'USER_INFO_QUERY_FAILED',
        name: '用户信息查询失败',
        fatal: true,
        retryable: false,
        apiCodes: ['05010003'],
        description: '分享者账号异常，无法查询用户信息'
    },
    
    // 存储相关错误（可恢复，需手动处理）
    QUOTA_EXCEEDED: {
        code: 'QUOTA_EXCEEDED',
        name: '空间已满',
        fatal: false,
        retryable: true,
        retryDelay: 3600, // 1小时后重试
        apiCodes: ['200000504', '200000505'], // 存储空间不足
        httpStatus: [507],
        description: '云盘存储空间已满，需要清理空间'
    },
    
    // 限流相关错误（可恢复，短时间重试）
    RATE_LIMITED: {
        code: 'RATE_LIMITED',
        name: '请求限流',
        fatal: false,
        retryable: true,
        retryDelay: 600, // 10分钟后重试
        httpStatus: [429],
        description: 'API 请求频率过高，已被限流'
    },
    
    // 网络相关错误（可恢复，短时间重试）
    NETWORK_ERROR: {
        code: 'NETWORK_ERROR',
        name: '网络错误',
        fatal: false,
        retryable: true,
        retryDelay: 300, // 5分钟后重试
        patterns: ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'],
        description: '网络连接失败或超时'
    },
    
    // 服务器错误（可恢复，短时间重试）
    SERVER_ERROR: {
        code: 'SERVER_ERROR',
        name: '服务器错误',
        fatal: false,
        retryable: true,
        retryDelay: 300,
        httpStatus: [500, 502, 503, 504],
        description: '云盘服务器错误'
    },
    
    // 未知错误（可恢复，保守重试）
    UNKNOWN_ERROR: {
        code: 'UNKNOWN_ERROR',
        name: '未知错误',
        fatal: false,
        retryable: true,
        retryDelay: 600,
        description: '未分类的错误'
    }
};

/**
 * 错误分类器
 */
class ErrorClassifier {
    /**
     * 分类错误
     * @param {Error} error - 原始错误对象
     * @returns {Object} 分类结果
     */
    static classify(error) {
        if (!error) {
            return {
                type: ERROR_TYPES.UNKNOWN_ERROR,
                originalError: error,
                context: {}
            };
        }

        // 1. 检查 API 错误码
        if (error.apiCode) {
            for (const [key, errorType] of Object.entries(ERROR_TYPES)) {
                if (errorType.apiCodes && errorType.apiCodes.includes(error.apiCode)) {
                    return {
                        type: errorType,
                        originalError: error,
                        context: {
                            apiCode: error.apiCode,
                            message: error.message
                        }
                    };
                }
            }
        }

        // 2. 检查 HTTP 状态码
        const httpStatus = error.response?.statusCode || error.statusCode;
        if (httpStatus) {
            for (const [key, errorType] of Object.entries(ERROR_TYPES)) {
                if (errorType.httpStatus && errorType.httpStatus.includes(httpStatus)) {
                    return {
                        type: errorType,
                        originalError: error,
                        context: {
                            httpStatus,
                            message: error.message
                        }
                    };
                }
            }
        }

        // 3. 检查错误消息模式
        const errorMessage = error.message || String(error);
        for (const [key, errorType] of Object.entries(ERROR_TYPES)) {
            if (errorType.patterns) {
                for (const pattern of errorType.patterns) {
                    if (errorMessage.includes(pattern)) {
                        return {
                            type: errorType,
                            originalError: error,
                            context: {
                                pattern,
                                message: errorMessage
                            }
                        };
                    }
                }
            }
        }

        // 4. 检查已有的 fatal 标记（向后兼容）
        if (error.fatal === true) {
            // 尝试根据 apiCode 匹配具体类型
            const apiCode = error.apiCode;
            if (apiCode === '200000727') return { type: ERROR_TYPES.LINK_INVALID, originalError: error, context: { apiCode } };
            if (apiCode === '200000401') return { type: ERROR_TYPES.LINK_EXPIRED, originalError: error, context: { apiCode } };
            if (apiCode === '200000402') return { type: ERROR_TYPES.LINK_LIMIT_EXCEEDED, originalError: error, context: { apiCode } };
            if (apiCode === '05010003') return { type: ERROR_TYPES.USER_INFO_QUERY_FAILED, originalError: error, context: { apiCode } };
            
            return {
                type: { ...ERROR_TYPES.UNKNOWN_ERROR, fatal: true },
                originalError: error,
                context: { legacyFatal: true }
            };
        }

        // 5. 默认未知错误
        return {
            type: ERROR_TYPES.UNKNOWN_ERROR,
            originalError: error,
            context: {
                message: errorMessage
            }
        };
    }

    /**
     * 增强错误对象
     * @param {Error} error - 原始错误
     * @returns {Error} 增强后的错误对象
     */
    static enhance(error) {
        const classification = this.classify(error);
        
        error.errorType = classification.type.code;
        error.errorTypeName = classification.type.name;
        error.fatal = classification.type.fatal;
        error.retryable = classification.type.retryable;
        error.retryDelay = classification.type.retryDelay || 300;
        error.classification = classification;

        return error;
    }

    /**
     * 创建分类后的错误对象
     * @param {Error} originalError - 原始错误
     * @param {Object} additionalContext - 额外上下文
     * @returns {Error} 新的错误对象
     */
    static createClassifiedError(originalError, additionalContext = {}) {
        const classification = this.classify(originalError);
        const error = new Error(originalError.message || classification.type.description);
        
        error.errorType = classification.type.code;
        error.errorTypeName = classification.type.name;
        error.fatal = classification.type.fatal;
        error.retryable = classification.type.retryable;
        error.retryDelay = classification.type.retryDelay || 300;
        error.apiCode = originalError.apiCode;
        error.statusCode = originalError.response?.statusCode || originalError.statusCode;
        error.stack = originalError.stack;
        error.originalError = originalError;
        error.context = { ...classification.context, ...additionalContext };

        return error;
    }
}

module.exports = {
    ERROR_TYPES,
    ErrorClassifier
};

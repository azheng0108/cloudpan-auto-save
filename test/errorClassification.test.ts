/**
 * P1-02: 错误分类系统测试
 * 
 * 测试错误分类器的准确性和错误记录服务
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { ErrorClassifier, ERROR_TYPES } from '../src/services/errorClassifier';
import TaskErrorService from '../src/services/taskErrorService';

describe('ErrorClassifier', () => {
    describe('classify', () => {
        test('应该识别链接失效错误', () => {
            const error = new Error('链接失效') as any;
            error.apiCode = '200000727';
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('LINK_INVALID');
            expect(classification.type.fatal).toBe(true);
            expect(classification.type.retryable).toBe(false);
        });

        test('应该识别链接过期错误', () => {
            const error = new Error('链接已过期') as any;
            error.apiCode = '200000401';
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('LINK_EXPIRED');
            expect(classification.type.fatal).toBe(true);
        });

        test('应该识别访问次数超限错误', () => {
            const error = new Error('访问次数超限') as any;
            error.apiCode = '200000402';

            const classification = ErrorClassifier.classify(error);

            expect(classification.type.code).toBe('LINK_LIMIT_EXCEEDED');
            expect(classification.type.fatal).toBe(true);
            expect(classification.type.retryable).toBe(false);
        });

        test('应该识别权限不足错误', () => {
            const error = new Error('权限不足') as any;
            error.statusCode = 403;

            const classification = ErrorClassifier.classify(error);

            expect(classification.type.code).toBe('PERMISSION_DENIED');
            expect(classification.type.fatal).toBe(true);
        });

        test('应该识别用户信息查询失败错误', () => {
            const error = new Error('用户信息查询失败') as any;
            error.apiCode = '05010003';

            const classification = ErrorClassifier.classify(error);

            expect(classification.type.code).toBe('USER_INFO_QUERY_FAILED');
            expect(classification.type.fatal).toBe(true);
            expect(classification.type.retryable).toBe(false);
        });

        test('应该识别空间已满错误', () => {
            const error = new Error('存储空间不足') as any;
            error.apiCode = '200000504';
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('QUOTA_EXCEEDED');
            expect(classification.type.fatal).toBe(false);
            expect(classification.type.retryable).toBe(true);
            expect(classification.type.retryDelay).toBe(3600);
        });

        test('应该根据 HTTP 状态码识别限流错误', () => {
            const error = new Error('Too Many Requests') as any;
            error.response = { statusCode: 429 };
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('RATE_LIMITED');
            expect(classification.type.retryable).toBe(true);
        });

        test('应该根据错误消息识别网络错误', () => {
            const error = new Error('ECONNREFUSED connection refused');
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('NETWORK_ERROR');
            expect(classification.type.retryable).toBe(true);
        });

        test('应该识别服务器错误', () => {
            const error = new Error('Internal Server Error') as any;
            error.response = { statusCode: 500 };
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('SERVER_ERROR');
        });

        test('应该将未知错误归类为 UNKNOWN_ERROR', () => {
            const error = new Error('一些未知错误');
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('UNKNOWN_ERROR');
            expect(classification.type.retryable).toBe(true);
        });

        test('应该兼容旧的 fatal 标记', () => {
            const error = new Error('Legacy error') as any;
            error.fatal = true;
            error.apiCode = '200000727';
            
            const classification = ErrorClassifier.classify(error);
            
            expect(classification.type.code).toBe('LINK_INVALID');
        });
    });

    describe('enhance', () => {
        test('应该增强错误对象', () => {
            const error = new Error('测试错误') as any;
            error.apiCode = '200000401';
            
            const enhanced = ErrorClassifier.enhance(error) as any;
            
            expect(enhanced.errorType).toBe('LINK_EXPIRED');
            expect(enhanced.fatal).toBe(true);
            expect(enhanced.retryable).toBe(false);
            expect(enhanced.classification).toBeTruthy();
        });
    });

    describe('createClassifiedError', () => {
        test('应该创建分类后的错误对象', () => {
            const originalError = new Error('原始错误') as any;
            originalError.apiCode = '200000504';
            
            const classifiedError = ErrorClassifier.createClassifiedError(
                originalError,
                { taskId: 123 }
            ) as any;
            
            expect(classifiedError.errorType).toBe('QUOTA_EXCEEDED');
            expect(classifiedError.context.taskId).toBe(123);
            expect(classifiedError.originalError).toBe(originalError);
        });
    });
});

describe('TaskErrorService', () => {
    let mockRepo: any;
    let service: any;

    beforeEach(() => {
        mockRepo = {
            save: jest.fn().mockResolvedValue({}),
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn().mockReturnValue({
                delete: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                execute: jest.fn().mockResolvedValue({ affected: 5 })
            })
        };
        service = new TaskErrorService(mockRepo);
    });

    describe('recordError', () => {
        test('应该记录错误到数据库', async () => {
            const error = new Error('测试错误') as any;
            error.apiCode = '200000727';
            
            await service.recordError(1, error, { extra: 'context' });
            
            expect(mockRepo.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 1,
                    errorType: 'LINK_INVALID',
                    errorCode: '200000727',
                    fatal: true,
                    retryable: false
                })
            );
        });

        test('应该包含上下文信息', async () => {
            const error = new Error('空间不足') as any;
            error.apiCode = '200000504';
            
            await service.recordError(2, error, {
                shareLink: 'https://example.com',
                accountId: 10
            });
            
            const savedRecord = mockRepo.save.mock.calls[0][0];
            const context = JSON.parse(savedRecord.context);
            
            expect(context.shareLink).toBe('https://example.com');
            expect(context.accountId).toBe(10);
        });
    });

    describe('getTaskErrors', () => {
        test('应该获取任务错误历史', async () => {
            mockRepo.find.mockResolvedValue([
                { id: 1, errorType: 'NETWORK_ERROR' },
                { id: 2, errorType: 'RATE_LIMITED' }
            ]);
            
            const errors = await service.getTaskErrors(1);
            
            expect(errors).toHaveLength(2);
            expect(mockRepo.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { taskId: 1 }
                })
            );
        });

        test('应该支持按错误类型过滤', async () => {
            await service.getTaskErrors(1, { errorType: 'QUOTA_EXCEEDED' });
            
            expect(mockRepo.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { taskId: 1, errorType: 'QUOTA_EXCEEDED' }
                })
            );
        });
    });

    describe('shouldRetry', () => {
        test('致命错误不应重试', () => {
            const error = new Error('链接失效') as any;
            error.apiCode = '200000727';
            
            expect(service.shouldRetry(error)).toBe(false);
        });

        test('可重试错误应该重试', () => {
            const error = new Error('网络错误') as any;
            error.message = 'ECONNREFUSED';
            
            expect(service.shouldRetry(error)).toBe(true);
        });
    });

    describe('getRetryDelay', () => {
        test('应该根据错误类型返回正确的延迟', () => {
            const quotaError = new Error('空间满') as any;
            quotaError.apiCode = '200000504';
            
            expect(service.getRetryDelay(quotaError, 0)).toBe(3600);
        });

        test('应该实现指数退避', () => {
            const networkError = new Error('ETIMEDOUT');
            
            const delay0 = service.getRetryDelay(networkError, 0);
            const delay1 = service.getRetryDelay(networkError, 1);
            const delay2 = service.getRetryDelay(networkError, 2);
            
            expect(delay1).toBe(delay0 * 2);
            expect(delay2).toBe(delay0 * 4);
        });

        test('延迟时间不应超过最大限制', () => {
            const error = new Error('Test');
            
            const delay10 = service.getRetryDelay(error, 10);
            
            expect(delay10).toBeLessThanOrEqual(3600);
        });
    });
});

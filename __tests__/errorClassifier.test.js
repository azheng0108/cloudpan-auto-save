const { ErrorClassifier, ERROR_TYPES } = require('../src/services/errorClassifier');

describe('ErrorClassifier', () => {
  test('classify: 空错误返回 UNKNOWN_ERROR', () => {
    const result = ErrorClassifier.classify(null);
    expect(result.type.code).toBe(ERROR_TYPES.UNKNOWN_ERROR.code);
  });

  test('classify: apiCode 匹配', () => {
    const result = ErrorClassifier.classify({ apiCode: '200000727', message: 'not found' });
    expect(result.type.code).toBe(ERROR_TYPES.LINK_INVALID.code);
  });

  test('classify: http status 匹配', () => {
    const result = ErrorClassifier.classify({ response: { statusCode: 429 }, message: 'too many' });
    expect(result.type.code).toBe(ERROR_TYPES.RATE_LIMITED.code);
  });

  test('classify: message pattern 匹配 NETWORK_ERROR', () => {
    const result = ErrorClassifier.classify(new Error('connect failed: ECONNREFUSED'));
    expect(result.type.code).toBe(ERROR_TYPES.NETWORK_ERROR.code);
  });

  test('classify: legacy fatal 兼容分支', () => {
    const specific = ErrorClassifier.classify({ fatal: true, apiCode: '200000401' });
    expect(specific.type.code).toBe(ERROR_TYPES.LINK_EXPIRED.code);

    const unknownFatal = ErrorClassifier.classify({ fatal: true, apiCode: 'x' });
    expect(unknownFatal.type.code).toBe(ERROR_TYPES.UNKNOWN_ERROR.code);
    expect(unknownFatal.type.fatal).toBe(true);
  });

  test('classify: 默认未知错误分支', () => {
    const result = ErrorClassifier.classify({ message: 'other error' });
    expect(result.type.code).toBe(ERROR_TYPES.UNKNOWN_ERROR.code);
  });

  test('enhance: 应写入增强字段', () => {
    const err = new Error('forbidden');
    err.statusCode = 403;

    const enhanced = ErrorClassifier.enhance(err);
    expect(enhanced.errorType).toBe(ERROR_TYPES.PERMISSION_DENIED.code);
    expect(enhanced.fatal).toBe(true);
    expect(enhanced.retryable).toBe(false);
    expect(enhanced.retryDelay).toBeGreaterThan(0);
  });

  test('createClassifiedError: 应继承关键字段并合并 context', () => {
    const original = new Error('quota full');
    original.apiCode = '200000504';
    original.response = { statusCode: 507 };

    const created = ErrorClassifier.createClassifiedError(original, { taskId: 10 });

    expect(created.errorType).toBe(ERROR_TYPES.QUOTA_EXCEEDED.code);
    expect(created.apiCode).toBe('200000504');
    expect(created.statusCode).toBe(507);
    expect(created.context.taskId).toBe(10);
    expect(created.originalError).toBe(original);
  });
});

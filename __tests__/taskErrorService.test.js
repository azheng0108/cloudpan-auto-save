jest.mock('../src/utils/logUtils', () => ({
  logTaskEvent: jest.fn(),
}));

const TaskErrorService = require('../src/services/taskErrorService');
const { ERROR_TYPES } = require('../src/services/errorClassifier');

describe('TaskErrorService', () => {
  test('recordError: 仓库不存在时直接返回', async () => {
    const service = new TaskErrorService(null);
    await expect(service.recordError(1, new Error('x'))).resolves.toBeUndefined();
  });

  test('recordError: 正常保存错误记录', async () => {
    const repo = { save: jest.fn().mockResolvedValue(undefined) };
    const service = new TaskErrorService(repo);
    const err = new Error('bad gateway');
    err.response = { statusCode: 502 };

    await service.recordError(2, err, { stage: 'save' });

    expect(repo.save).toHaveBeenCalledTimes(1);
    const payload = repo.save.mock.calls[0][0];
    expect(payload.taskId).toBe(2);
    expect(payload.errorType).toBe(ERROR_TYPES.SERVER_ERROR.code);
    expect(payload.retryable).toBe(true);
    expect(payload.fatal).toBe(false);
    expect(JSON.parse(payload.context).stage).toBe('save');
  });

  test('recordError: 保存失败时吞掉异常', async () => {
    const repo = { save: jest.fn().mockRejectedValue(new Error('db error')) };
    const service = new TaskErrorService(repo);

    await expect(service.recordError(3, new Error('x'))).resolves.toBeUndefined();
  });

  test('getTaskErrors: 仓库不存在返回空数组', async () => {
    const service = new TaskErrorService(null);
    await expect(service.getTaskErrors(1)).resolves.toEqual([]);
  });

  test('getTaskErrors: 带过滤条件查询', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([{ id: 1, errorType: 'NETWORK_ERROR' }]),
    };
    const service = new TaskErrorService(repo);

    const result = await service.getTaskErrors(1, { errorType: 'NETWORK_ERROR', limit: 10 });

    expect(result).toHaveLength(1);
    expect(repo.find).toHaveBeenCalledWith({
      where: { taskId: 1, errorType: 'NETWORK_ERROR' },
      order: { createdAt: 'DESC' },
      take: 10,
    });
  });

  test('getTaskErrors: 查询失败返回空数组', async () => {
    const repo = { find: jest.fn().mockRejectedValue(new Error('find error')) };
    const service = new TaskErrorService(repo);

    await expect(service.getTaskErrors(1)).resolves.toEqual([]);
  });

  test('getLastError: 无记录返回 null，有记录返回首项', async () => {
    const repo = { find: jest.fn().mockResolvedValue([]) };
    const service = new TaskErrorService(repo);
    await expect(service.getLastError(1)).resolves.toBeNull();

    repo.find.mockResolvedValueOnce([{ id: 5, errorType: 'UNKNOWN' }]);
    await expect(service.getLastError(1)).resolves.toEqual({ id: 5, errorType: 'UNKNOWN' });
  });

  test('getErrorStats: 正常统计与异常分支', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([
        { errorType: 'NETWORK_ERROR' },
        { errorType: 'NETWORK_ERROR' },
        { errorType: 'QUOTA_EXCEEDED' },
        {},
      ]),
    };
    const service = new TaskErrorService(repo);

    const stats = await service.getErrorStats(1);
    expect(stats).toEqual({ NETWORK_ERROR: 2, QUOTA_EXCEEDED: 1, UNKNOWN: 1 });

    repo.find.mockRejectedValueOnce(new Error('boom'));
    await expect(service.getErrorStats(1)).resolves.toEqual({});
  });

  test('shouldRetry: 支持记录对象与 Error 对象', () => {
    const service = new TaskErrorService({});

    expect(service.shouldRetry(null)).toBe(false);
    expect(service.shouldRetry({ retryable: true, fatal: false })).toBe(true);
    expect(service.shouldRetry({ retryable: true, fatal: true })).toBe(false);

    const err = new Error('ECONNRESET happened');
    expect(service.shouldRetry(err)).toBe(true);
  });

  test('getRetryDelay: 覆盖映射、回退与指数退避', () => {
    const service = new TaskErrorService({});

    expect(service.getRetryDelay(null, 1)).toBe(600);

    const mapped = service.getRetryDelay({ errorType: 'RATE_LIMITED' }, 1);
    expect(mapped).toBe(1200);

    const fallback = service.getRetryDelay({ errorType: 'NOT_FOUND', retryDelay: 200 }, 2);
    expect(fallback).toBe(800);

    const byClassify = service.getRetryDelay(new Error('ETIMEDOUT'), 10);
    expect(byClassify).toBe(3600);
  });
});

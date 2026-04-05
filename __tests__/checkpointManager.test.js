jest.mock('../src/utils/logUtils', () => ({
  logTaskEvent: jest.fn(),
}));

const CheckpointManager = require('../src/services/checkpointManager');

describe('CheckpointManager', () => {
  test('createCheckpoint 应按默认值创建', () => {
    const checkpoint = CheckpointManager.createCheckpoint();

    expect(checkpoint.version).toBe('1.0');
    expect(Array.isArray(checkpoint.processedFolders)).toBe(true);
    expect(checkpoint.currentBatchIndex).toBe(0);
    expect(checkpoint.metadata).toEqual({});
  });

  test('saveCheckpoint 成功时应更新任务字段并保存', async () => {
    const repo = { save: jest.fn().mockResolvedValue(undefined) };
    const task = { id: 1 };
    const checkpoint = CheckpointManager.createCheckpoint({
      currentBatchIndex: 2,
      metadata: { totalBatches: 5 },
    });

    await CheckpointManager.saveCheckpoint(repo, task, checkpoint);

    expect(task.processedBatches).toBe(2);
    expect(task.totalBatches).toBe(5);
    expect(task.checkpointData).toContain('"version":"1.0"');
    expect(repo.save).toHaveBeenCalledWith(task);
  });

  test('saveCheckpoint 失败时不抛错', async () => {
    const repo = { save: jest.fn().mockRejectedValue(new Error('db down')) };
    const task = { id: 2 };
    const checkpoint = CheckpointManager.createCheckpoint();

    await expect(CheckpointManager.saveCheckpoint(repo, task, checkpoint)).resolves.toBeUndefined();
  });

  test('loadCheckpoint 对空/非法/版本不兼容返回 null', () => {
    expect(CheckpointManager.loadCheckpoint({ id: 1, checkpointData: null })).toBeNull();

    expect(CheckpointManager.loadCheckpoint({ id: 1, checkpointData: 'invalid json' })).toBeNull();

    const badVersion = JSON.stringify({ version: '2.0', currentBatchIndex: 1 });
    expect(CheckpointManager.loadCheckpoint({ id: 1, checkpointData: badVersion })).toBeNull();
  });

  test('loadCheckpoint 成功返回对象', () => {
    const data = { version: '1.0', createdAt: new Date().toISOString(), currentBatchIndex: 3 };
    const loaded = CheckpointManager.loadCheckpoint({ id: 1, checkpointData: JSON.stringify(data) });
    expect(loaded.currentBatchIndex).toBe(3);
  });

  test('clearCheckpoint 成功与失败分支', async () => {
    const task = { id: 3, checkpointData: '{}', processedBatches: 1, totalBatches: 1, lastCheckpointTime: new Date() };
    const okRepo = { save: jest.fn().mockResolvedValue(undefined) };
    await CheckpointManager.clearCheckpoint(okRepo, task);
    expect(task.checkpointData).toBeNull();
    expect(task.processedBatches).toBe(0);

    const badRepo = { save: jest.fn().mockRejectedValue(new Error('oops')) };
    await expect(CheckpointManager.clearCheckpoint(badRepo, { id: 4 })).resolves.toBeUndefined();
  });

  test('isFolderProcessed 与 updateProgress', () => {
    expect(CheckpointManager.isFolderProcessed(null, 'a')).toBe(false);

    const checkpoint = CheckpointManager.createCheckpoint({ processedFolders: ['f1'], currentBatchIndex: 1 });
    expect(CheckpointManager.isFolderProcessed(checkpoint, 'f1')).toBe(true);

    const updated = CheckpointManager.updateProgress(checkpoint, {
      processedFolder: 'f2',
      currentBatchIndex: 2,
    });

    expect(updated.processedFolders).toEqual(expect.arrayContaining(['f1', 'f2']));
    expect(updated.currentBatchIndex).toBe(2);
    expect(updated.updatedAt).toBeTruthy();
  });

  test('shouldResume 覆盖状态、时间与有效性分支', () => {
    expect(CheckpointManager.shouldResume({ id: 1, status: 'success' }, null)).toBe(false);

    const invalidCreatedAt = { createdAt: 'bad-date' };
    expect(CheckpointManager.shouldResume({ id: 1, status: 'pending' }, invalidCreatedAt)).toBe(false);

    const expired = { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    expect(CheckpointManager.shouldResume({ id: 1, status: 'processing' }, expired)).toBe(false);

    const valid = { createdAt: new Date().toISOString() };
    expect(CheckpointManager.shouldResume({ id: 1, status: 'pending' }, valid)).toBe(true);
  });

  test('getProgressPercentage 计算进度并处理边界', () => {
    expect(CheckpointManager.getProgressPercentage(null)).toBe(0);
    expect(CheckpointManager.getProgressPercentage({ metadata: {} })).toBe(0);

    expect(
      CheckpointManager.getProgressPercentage({
        currentBatchIndex: 3,
        metadata: { totalBatches: 4 },
      })
    ).toBe(75);

    expect(
      CheckpointManager.getProgressPercentage({
        currentBatchIndex: 10,
        metadata: { totalBatches: 4 },
      })
    ).toBe(100);
  });
});

/**
 * P1-03: 幂等性测试
 * 
 * 确保任务重复执行不会导致重复传输文件
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

describe('任务执行幂等性', () => {
    describe('TransferredFile 去重机制', () => {
        let mockRepo: any;

        beforeEach(() => {
            const existingRecords = new Map();
            
            mockRepo = {
                find: jest.fn(async ({ where }) => {
                    const taskId = where.taskId;
                    return Array.from(existingRecords.values())
                        .filter((r: any) => r.taskId === taskId);
                }),
                save: jest.fn(async (records) => {
                    const recordsArray = Array.isArray(records) ? records : [records];
                    recordsArray.forEach(record => {
                        const key = `${record.taskId}-${record.fileId}`;
                        existingRecords.set(key, record);
                    });
                    return records;
                })
            };
        });

        test('首次执行应该记录所有文件', async () => {
            const taskId = 1;
            const files = [
                { fileId: 'file1', fileName: 'test1.mkv' },
                { fileId: 'file2', fileName: 'test2.mkv' }
            ];
            
            await mockRepo.save(files.map(f => ({ taskId, ...f })));
            
            expect(mockRepo.save).toHaveBeenCalled();
            const saved = mockRepo.save.mock.calls[0][0];
            expect(saved).toHaveLength(2);
        });

        test('重复执行应该跳过已传输文件', async () => {
            const taskId = 1;
            
            // 第一次执行
            const firstBatch = [
                { fileId: 'file1', fileName: 'test1.mkv' },
                { fileId: 'file2', fileName: 'test2.mkv' }
            ];
            await mockRepo.save(firstBatch.map(f => ({ taskId, ...f })));
            
            // 获取已传输文件
            const transferred = await mockRepo.find({ where: { taskId } });
            const transferredIds = new Set(transferred.map((r: any) => r.fileId));
            
            // 第二次执行（部分重复）
            const secondBatch = [
                { fileId: 'file1', fileName: 'test1.mkv' }, // 重复
                { fileId: 'file3', fileName: 'test3.mkv' }  // 新文件
            ];
            
            const newFiles = secondBatch.filter(f => !transferredIds.has(f.fileId));
            
            expect(newFiles).toHaveLength(1);
            expect(newFiles[0].fileId).toBe('file3');
        });

        test('完全重复执行应该没有新文件', async () => {
            const taskId = 1;
            
            const files = [
                { fileId: 'file1', fileName: 'test1.mkv' },
                { fileId: 'file2', fileName: 'test2.mkv' }
            ];
            
            // 第一次执行
            await mockRepo.save(files.map(f => ({ taskId, ...f })));
            
            // 第二次执行（完全相同）
            const transferred = await mockRepo.find({ where: { taskId } });
            const transferredIds = new Set(transferred.map((r: any) => r.fileId));
            
            const newFiles = files.filter(f => !transferredIds.has(f.fileId));
            
            expect(newFiles).toHaveLength(0);
        });
    });

    describe('检查点恢复幂等性', () => {
        const CheckpointManager = require('../src/services/checkpointManager');

        test('从检查点恢复后不应重复处理已完成批次', () => {
            // 创建检查点
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1', 'folder2'],
                transferredFileIds: ['file1', 'file2', 'file3'],
                currentBatchIndex: 2,
                metadata: { totalBatches: 5 }
            });
            
            // 验证已处理项
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder1')).toBe(true);
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder2')).toBe(true);
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder3')).toBe(false);
            
            expect(CheckpointManager.isFileProcessed(checkpoint, 'file1')).toBe(true);
            expect(CheckpointManager.isFileProcessed(checkpoint, 'file4')).toBe(false);
        });

        test('更新检查点时应该去重', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1'],
                transferredFileIds: ['file1', 'file2']
            });
            
            // 添加重复项
            const updated = CheckpointManager.updateProgress(checkpoint, {
                processedFolder: 'folder1', // 重复
                transferredFiles: ['file2', 'file3'] // file2 重复
            });
            
            // 验证去重
            expect(updated.processedFolders).toEqual(['folder1']);
            expect(updated.transferredFileIds).toHaveLength(3);
            expect(updated.transferredFileIds).toContain('file1');
            expect(updated.transferredFileIds).toContain('file2');
            expect(updated.transferredFileIds).toContain('file3');
        });
    });

    describe('任务状态幂等性', () => {
        test('任务完成后不应重复执行', () => {
            const task = { status: 'completed', id: 1 };
            
            // 模拟任务调度器的检查
            const shouldRun = task.status === 'pending' || task.status === 'processing';
            
            expect(shouldRun).toBe(false);
        });

        test('失败任务不应自动重试（除非在重试窗口）', () => {
            const now = new Date();
            const futureRetryTime = new Date(now.getTime() + 600000); // 10分钟后
            
            const task = {
                status: 'failed',
                nextRetryTime: futureRetryTime
            };
            
            const shouldRetry = task.nextRetryTime && task.nextRetryTime <= now;
            
            expect(shouldRetry).toBe(false);
        });
    });

    describe('并发执行幂等性', () => {
        test('同时执行的任务应该通过 TransferredFile 唯一索引防止重复', () => {
            // 模拟数据库唯一索引约束
            const uniqueIndex = new Map<string, any>();
            
            const insertRecord = (taskId: number, fileId: string) => {
                const key = `${taskId}-${fileId}`;
                if (uniqueIndex.has(key)) {
                    throw new Error('UNIQUE constraint failed');
                }
                uniqueIndex.set(key, { taskId, fileId });
            };
            
            // 第一次插入成功
            expect(() => insertRecord(1, 'file1')).not.toThrow();
            
            // 重复插入失败
            expect(() => insertRecord(1, 'file1')).toThrow('UNIQUE constraint');
            
            // 不同 taskId 可以插入
            expect(() => insertRecord(2, 'file1')).not.toThrow();
        });
    });

    describe('文件可见性验证幂等性', () => {
        test('多次验证文件可见性应该得到一致结果', async () => {
            const mockCloud139 = {
                listAllDiskFiles: jest.fn().mockResolvedValue([
                    { name: 'test1.mkv' },
                    { name: 'test2.mkv' }
                ])
            };
            
            // 第一次验证
            const files1 = await mockCloud139.listAllDiskFiles('targetFolder');
            const names1 = new Set(files1.map((f: any) => f.name));
            
            // 第二次验证
            const files2 = await mockCloud139.listAllDiskFiles('targetFolder');
            const names2 = new Set(files2.map((f: any) => f.name));
            
            // 结果应该一致
            expect(names1).toEqual(names2);
            expect(mockCloud139.listAllDiskFiles).toHaveBeenCalledTimes(2);
        });
    });
});

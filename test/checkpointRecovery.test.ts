/**
 * P1-01: 检查点恢复系统测试
 * 
 * 测试任务中断后的恢复能力
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import CheckpointManager from '../src/services/checkpointManager';

describe('CheckpointManager', () => {
    describe('createCheckpoint', () => {
        test('应该创建新的检查点', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1', 'folder2'],
                currentBatchIndex: 2,
                metadata: { totalBatches: 10 }
            });
            
            expect(checkpoint.version).toBe('1.0');
            expect(checkpoint.processedFolders).toEqual(['folder1', 'folder2']);
            expect(checkpoint.currentBatchIndex).toBe(2);
            expect(checkpoint.metadata.totalBatches).toBe(10);
            expect(checkpoint.createdAt).toBeTruthy();
        });

        test('应该使用默认值创建空检查点', () => {
            const checkpoint = CheckpointManager.createCheckpoint();
            
            expect(checkpoint.processedFolders).toEqual([]);
            expect(checkpoint.currentBatchIndex).toBe(0);
        });
    });

    describe('saveCheckpoint', () => {
        let mockTaskRepo: any;
        let mockTask: any;

        beforeEach(() => {
            mockTaskRepo = {
                save: jest.fn().mockResolvedValue({})
            };
            mockTask = {
                id: 1,
                checkpointData: null,
                processedBatches: 0,
                totalBatches: 0
            };
        });

        test('应该保存检查点到任务', async () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                currentBatchIndex: 3,
                metadata: { totalBatches: 10 }
            });
            
            await CheckpointManager.saveCheckpoint(mockTaskRepo, mockTask, checkpoint);
            
            expect(mockTask.checkpointData).toBeTruthy();
            expect(mockTask.processedBatches).toBe(3);
            expect(mockTask.totalBatches).toBe(10);
            expect(mockTask.lastCheckpointTime).toBeTruthy();
            expect(mockTaskRepo.save).toHaveBeenCalledWith(mockTask);
        });

        test('检查点数据应该是 JSON 格式', async () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['f1']
            });
            
            await CheckpointManager.saveCheckpoint(mockTaskRepo, mockTask, checkpoint);
            
            expect(() => JSON.parse(mockTask.checkpointData)).not.toThrow();
            const parsed = JSON.parse(mockTask.checkpointData);
            expect(parsed.processedFolders).toEqual(['f1']);
        });
    });

    describe('loadCheckpoint', () => {
        test('应该从任务加载检查点', () => {
            const originalCheckpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1'],
                currentBatchIndex: 5
            });
            
            const task = {
                checkpointData: JSON.stringify(originalCheckpoint)
            };
            
            const loaded = CheckpointManager.loadCheckpoint(task);
            
            expect(loaded).toBeTruthy();
            expect(loaded.processedFolders).toEqual(['folder1']);
            expect(loaded.currentBatchIndex).toBe(5);
        });

        test('任务没有检查点时应该返回 null', () => {
            const task = { checkpointData: null };
            
            const loaded = CheckpointManager.loadCheckpoint(task);
            
            expect(loaded).toBeNull();
        });

        test('检查点数据损坏时应该返回 null', () => {
            const task = { checkpointData: 'invalid json {{{' };
            
            const loaded = CheckpointManager.loadCheckpoint(task);
            
            expect(loaded).toBeNull();
        });

        test('版本不兼容时应该返回 null', () => {
            const task = {
                checkpointData: JSON.stringify({ version: '2.0', data: {} })
            };
            
            const loaded = CheckpointManager.loadCheckpoint(task);
            
            expect(loaded).toBeNull();
        });
    });

    describe('clearCheckpoint', () => {
        test('应该清除任务的检查点', async () => {
            const mockTaskRepo = {
                save: jest.fn().mockResolvedValue({})
            };
            const mockTask: any = {
                checkpointData: '{"version":"1.0"}',
                processedBatches: 5,
                totalBatches: 10
            };
            
            await CheckpointManager.clearCheckpoint(mockTaskRepo, mockTask);
            
            expect(mockTask.checkpointData).toBeNull();
            expect(mockTask.processedBatches).toBe(0);
            expect(mockTask.totalBatches).toBe(0);
            expect(mockTaskRepo.save).toHaveBeenCalled();
        });
    });

    describe('isFolderProcessed', () => {
        test('应该检查文件夹是否已处理', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1', 'folder2']
            });
            
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder1')).toBe(true);
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder3')).toBe(false);
        });
    });

    describe('updateProgress', () => {
        test('应该更新已处理的文件夹', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1']
            });
            
            const updated = CheckpointManager.updateProgress(checkpoint, {
                processedFolder: 'folder2'
            });
            
            expect(updated.processedFolders).toContain('folder1');
            expect(updated.processedFolders).toContain('folder2');
        });

        test('应该更新批次索引', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                currentBatchIndex: 0
            });
            
            const updated = CheckpointManager.updateProgress(checkpoint, {
                currentBatchIndex: 5
            });
            
            expect(updated.currentBatchIndex).toBe(5);
        });

        test('应该去重已处理项', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1']
            });
            
            const updated = CheckpointManager.updateProgress(checkpoint, {
                processedFolder: 'folder1'
            });
            
            expect(updated.processedFolders).toEqual(['folder1']);
        });
    });

    describe('shouldResume', () => {
        test('任务 pending 且有检查点时应该恢复', () => {
            const task = { status: 'pending' };
            const checkpoint = CheckpointManager.createCheckpoint();
            
            expect(CheckpointManager.shouldResume(task, checkpoint)).toBe(true);
        });

        test('任务 processing 且有检查点时应该恢复', () => {
            const task = { status: 'processing' };
            const checkpoint = CheckpointManager.createCheckpoint();
            
            expect(CheckpointManager.shouldResume(task, checkpoint)).toBe(true);
        });

        test('检查点过期时不应恢复', () => {
            const task = { status: 'pending' };
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 30); // 30天前
            
            const checkpoint = CheckpointManager.createCheckpoint();
            checkpoint.createdAt = oldDate.toISOString();
            
            expect(CheckpointManager.shouldResume(task, checkpoint)).toBe(false);
        });

        test('任务状态为 completed 时不应恢复', () => {
            const task = { status: 'completed' };
            const checkpoint = CheckpointManager.createCheckpoint();
            
            expect(CheckpointManager.shouldResume(task, checkpoint)).toBe(false);
        });

        test('没有检查点时不应恢复', () => {
            const task = { status: 'pending' };
            
            expect(CheckpointManager.shouldResume(task, null)).toBe(false);
        });
    });

    describe('getProgressPercentage', () => {
        test('应该计算进度百分比', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                currentBatchIndex: 3,
                metadata: { totalBatches: 10 }
            });
            
            const percentage = CheckpointManager.getProgressPercentage(checkpoint);
            
            expect(percentage).toBe(30);
        });

        test('完成时应该返回 100%', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                currentBatchIndex: 10,
                metadata: { totalBatches: 10 }
            });
            
            expect(CheckpointManager.getProgressPercentage(checkpoint)).toBe(100);
        });

        test('检查点无效时应该返回 0', () => {
            expect(CheckpointManager.getProgressPercentage(null)).toBe(0);
            
            const invalidCheckpoint = CheckpointManager.createCheckpoint();
            expect(CheckpointManager.getProgressPercentage(invalidCheckpoint)).toBe(0);
        });
    });
});

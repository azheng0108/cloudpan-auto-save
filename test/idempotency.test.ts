/**
 * P1-03: 幂等性测试
 * 
 * 确保任务重复执行不会导致重复传输文件
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

describe('任务执行幂等性', () => {
    describe('检查点恢复幂等性', () => {
        const CheckpointManager = require('../src/services/checkpointManager');

        test('从检查点恢复后不应重复处理已完成文件夹批次', () => {
            // 创建检查点
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1', 'folder2'],
                currentBatchIndex: 2,
                metadata: { totalBatches: 5 }
            });
            
            // 验证已处理项
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder1')).toBe(true);
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder2')).toBe(true);
            expect(CheckpointManager.isFolderProcessed(checkpoint, 'folder3')).toBe(false);
        });

        test('更新检查点时应该去重', () => {
            const checkpoint = CheckpointManager.createCheckpoint({
                processedFolders: ['folder1']
            });
            
            // 添加重复项
            const updated = CheckpointManager.updateProgress(checkpoint, {
                processedFolder: 'folder1' // 重复
            });
            
            // 验证去重
            expect(updated.processedFolders).toEqual(['folder1']);
        });
    });
});

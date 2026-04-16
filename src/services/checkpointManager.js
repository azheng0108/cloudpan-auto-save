/**
 * P1-01: 任务检查点管理器
 * 
 * 提供批次级别的检查点保存和恢复功能
 */

const { logTaskEvent } = require('../utils/logUtils');

class CheckpointManager {
    /**
     * 创建新的检查点数据
     * @param {Object} options - 检查点选项
     * @returns {Object} 检查点数据对象
     */
    static createCheckpoint(options = {}) {
        return {
            version: '1.0',
            createdAt: new Date().toISOString(),
            processedFolders: options.processedFolders || [],
            // 已提交过转存但尚未完成可见性确认的批次（用于重试时防重复转存）
            submittedFolders: options.submittedFolders || [],
            catalogMap: options.catalogMap || {},
            physicalFolderMap: options.physicalFolderMap || {},
            currentBatchIndex: options.currentBatchIndex || 0,
            metadata: options.metadata || {}
        };
    }

    /**
     * 保存检查点到任务
     * @param {Object} taskRepo - 任务仓库
     * @param {Object} task - 任务对象
     * @param {Object} checkpointData - 检查点数据
     */
    static async saveCheckpoint(taskRepo, task, checkpointData) {
        try {
            task.checkpointData = JSON.stringify(checkpointData);
            task.processedBatches = checkpointData.currentBatchIndex || 0;
            task.totalBatches = checkpointData.metadata?.totalBatches || 0;
            task.lastCheckpointTime = new Date();
            
            await taskRepo.save(task);
            
            logTaskEvent(`[检查点] 任务 ${task.id} 保存检查点: 批次 ${task.processedBatches}/${task.totalBatches}`);
        } catch (err) {
            logTaskEvent(`[检查点] 保存失败: ${err.message}`);
            // 不抛出异常，检查点保存失败不应影响主流程
        }
    }

    /**
     * 从任务加载检查点
     * @param {Object} task - 任务对象
     * @returns {Object|null} 检查点数据或 null
     */
    static loadCheckpoint(task) {
        if (!task.checkpointData) {
            return null;
        }

        try {
            const checkpoint = JSON.parse(task.checkpointData);
            
            // 验证检查点版本
            if (!checkpoint.version || checkpoint.version !== '1.0') {
                logTaskEvent(`[检查点] 任务 ${task.id} 检查点版本不兼容，忽略`);
                return null;
            }

            logTaskEvent(`[检查点] 任务 ${task.id} 加载检查点: 批次 ${checkpoint.currentBatchIndex}`);
            return checkpoint;
        } catch (err) {
            logTaskEvent(`[检查点] 任务 ${task.id} 检查点解析失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 清除检查点
     * @param {Object} taskRepo - 任务仓库
     * @param {Object} task - 任务对象
     */
    static async clearCheckpoint(taskRepo, task) {
        try {
            task.checkpointData = null;
            task.processedBatches = 0;
            task.totalBatches = 0;
            task.lastCheckpointTime = null;
            
            await taskRepo.save(task);
            
            logTaskEvent(`[检查点] 任务 ${task.id} 清除检查点`);
        } catch (err) {
            logTaskEvent(`[检查点] 清除失败: ${err.message}`);
        }
    }

    /**
     * 判断文件夹是否已处理（基于检查点）
     * @param {Object} checkpoint - 检查点数据
     * @param {string} folderId - 文件夹 ID
     * @returns {boolean} 是否已处理
     */
    static isFolderProcessed(checkpoint, folderId) {
        if (!checkpoint || !checkpoint.processedFolders) {
            return false;
        }
        return checkpoint.processedFolders.includes(folderId);
    }

    /**
     * 判断文件夹是否处于“已提交转存待确认”状态
     * @param {Object} checkpoint - 检查点数据
     * @param {string} folderId - 文件夹 ID
     * @returns {boolean}
     */
    static isFolderSubmitted(checkpoint, folderId) {
        if (!checkpoint || !checkpoint.submittedFolders) {
            return false;
        }
        return checkpoint.submittedFolders.includes(folderId);
    }

    /**
     * 更新检查点进度
     * @param {Object} checkpoint - 检查点数据
     * @param {Object} progress - 进度更新
     * @returns {Object} 更新后的检查点
     */
    static updateProgress(checkpoint, progress) {
        const updated = { ...checkpoint };
        updated.processedFolders = Array.isArray(updated.processedFolders) ? updated.processedFolders : [];
        updated.submittedFolders = Array.isArray(updated.submittedFolders) ? updated.submittedFolders : [];

        if (progress.processedFolder) {
            updated.processedFolders = [...new Set([...updated.processedFolders, progress.processedFolder])];
            // 批次确认完成后，从 submitted 列表中移除
            updated.submittedFolders = updated.submittedFolders.filter((id) => id !== progress.processedFolder);
        }

        if (progress.submittedFolder) {
            updated.submittedFolders = [...new Set([...updated.submittedFolders, progress.submittedFolder])];
        }

        if (progress.currentBatchIndex !== undefined) {
            updated.currentBatchIndex = progress.currentBatchIndex;
        }

        updated.updatedAt = new Date().toISOString();

        return updated;
    }

    /**
     * 判断是否应该从检查点恢复
     * @param {Object} task - 任务对象
     * @param {Object} checkpoint - 检查点数据
     * @returns {boolean} 是否应该恢复
     */
    static shouldResume(task, checkpoint) {
        if (!checkpoint) {
            return false;
        }

        const totalBatches = Number(checkpoint.metadata?.totalBatches || 0);
        const currentBatchIndex = Number(checkpoint.currentBatchIndex || 0);
        // 已达到总批次时视为完成态，避免出现“恢复进度100%仍继续执行”。
        if (totalBatches > 0 && currentBatchIndex >= totalBatches) {
            logTaskEvent(`[检查点] 任务 ${task.id} 检查点已完成（${currentBatchIndex}/${totalBatches}），跳过恢复`);
            return false;
        }

        // 如果任务状态是 pending 或 processing，且有检查点，则尝试恢复
        if (task.status === 'pending' || task.status === 'processing') {
            const createdAtMs = checkpoint.createdAt ? Date.parse(checkpoint.createdAt) : NaN;
            if (!Number.isFinite(createdAtMs)) {
                logTaskEvent(`[检查点] 任务 ${task.id} 检查点创建时间无效，忽略恢复`);
                return false;
            }

            // 检查检查点是否过期（超过24小时）
            const checkpointAge = Date.now() - createdAtMs;
            const MAX_CHECKPOINT_AGE = 24 * 60 * 60 * 1000; // 24小时

            if (checkpointAge > MAX_CHECKPOINT_AGE) {
                logTaskEvent(`[检查点] 任务 ${task.id} 检查点已过期（${Math.round(checkpointAge / 3600000)}小时），重新开始`);
                return false;
            }

            return true;
        }

        return false;
    }

    /**
     * 计算恢复进度百分比
     * @param {Object} checkpoint - 检查点数据
     * @returns {number} 进度百分比 (0-100)
     */
    static getProgressPercentage(checkpoint) {
        if (!checkpoint || !checkpoint.metadata || !checkpoint.metadata.totalBatches) {
            return 0;
        }

        const processed = checkpoint.currentBatchIndex || 0;
        const total = checkpoint.metadata.totalBatches;

        return Math.min(100, Math.round((processed / total) * 100));
    }
}

module.exports = CheckpointManager;

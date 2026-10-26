const logger = require('../utils/logger');
const { getMaintenanceJobRepository } = require('../database');

class MaintenanceJobService {
    /**
     * 创建一条新维护作业记录 (状态为 running)
     */
    static async createJob(params = {}) {
        try {
            const repo = getMaintenanceJobRepository();
            const job = repo.create({
                type: params.type || 'banned_scan',
                triggerType: params.triggerType || 'manual',
                title: params.title || '云盘巡检维护作业',
                status: 'running',
                summary: params.summary || '作业启动中...',
                folderPath: params.folderPath || '/',
                scannedFolders: 0,
                totalFiles: 0,
                bannedCount: 0,
                cleanedCount: 0,
                freedFormatted: '0 B',
                durationMs: 0
            });
            const saved = await repo.save(job);
            logger.info(`[维护作业审计] 新建作业 #${saved.id} (${saved.title}) [running]`);
            return saved;
        } catch (err) {
            logger.error(`[维护作业审计] 创建作业失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 标记作业顺利完成
     */
    static async completeJob(id, payload = {}) {
        if (!id) return null;
        try {
            const repo = getMaintenanceJobRepository();
            const job = await repo.findOne({ where: { id: parseInt(id) } });
            if (!job) return null;

            job.status = payload.status || (job.type === 'banned_clean' ? 'cleaned' : 'completed');
            if (payload.summary !== undefined) job.summary = payload.summary;
            if (payload.durationMs !== undefined) job.durationMs = payload.durationMs;
            if (payload.scannedFolders !== undefined) job.scannedFolders = payload.scannedFolders;
            if (payload.totalFiles !== undefined) job.totalFiles = payload.totalFiles;
            if (payload.bannedCount !== undefined) job.bannedCount = payload.bannedCount;
            if (payload.cleanedCount !== undefined) job.cleanedCount = payload.cleanedCount;
            if (payload.freedFormatted !== undefined) job.freedFormatted = payload.freedFormatted;

            if (payload.findings) {
                job.findingsJson = typeof payload.findings === 'string' ? payload.findings : JSON.stringify(payload.findings);
            }
            if (payload.cleanedDetails) {
                job.cleanedDetailsJson = typeof payload.cleanedDetails === 'string' ? payload.cleanedDetails : JSON.stringify(payload.cleanedDetails);
            }

            const updated = await repo.save(job);
            logger.info(`[维护作业审计] 作业 #${updated.id} (${updated.title}) [${updated.status}]: ${updated.summary}`);
            return updated;
        } catch (err) {
            logger.error(`[维护作业审计] 更新作业 #${id} 状态失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 标记作业执行失败
     */
    static async failJob(id, error, durationMs = 0) {
        if (!id) return null;
        try {
            const repo = getMaintenanceJobRepository();
            const job = await repo.findOne({ where: { id: parseInt(id) } });
            if (!job) return null;

            job.status = 'failed';
            job.error = error?.message || String(error);
            job.summary = `执行失败: ${job.error}`;
            if (durationMs > 0) job.durationMs = durationMs;

            const updated = await repo.save(job);
            logger.error(`[维护作业审计] 作业 #${updated.id} (${updated.title}) [failed]: ${job.error}`);
            return updated;
        } catch (err) {
            logger.error(`[维护作业审计] 记录作业 #${id} 失败异常: ${err.message}`);
            return null;
        }
    }

    /**
     * 查询历史作业列表 (分页，按时间倒序)
     */
    static async listJobs(options = {}) {
        try {
            const repo = getMaintenanceJobRepository();
            const limit = Math.min(Math.max(parseInt(options.limit) || 30, 1), 100);
            const offset = Math.max(parseInt(options.offset) || 0, 0);

            const qb = repo.createQueryBuilder('job')
                .orderBy('job.createdAt', 'DESC')
                .take(limit)
                .skip(offset);

            if (options.type) {
                qb.andWhere('job.type = :type', { type: options.type });
            }

            const [items, total] = await qb.getManyAndCount();

            // 为前端列表展示清洗格式（ findingsJson 在列表页不展开完整内容，只在详情中取，节省网络带宽）
            const formatted = items.map(j => {
                let parsedFindingsCount = 0;
                let unidentifiedShowsCount = 0;
                let missingShowsCount = j.bannedCount || 0;
                if (j.findingsJson) {
                    try {
                        const parsed = JSON.parse(j.findingsJson);
                        if (Array.isArray(parsed)) {
                            parsedFindingsCount = parsed.length;
                        } else if (parsed && typeof parsed === "object") {
                            parsedFindingsCount = Array.isArray(parsed.items) ? parsed.items.length : (parsed.totalMissingCount || 0);
                            unidentifiedShowsCount = parsed.unidentifiedShowsCount || (Array.isArray(parsed.shows) ? parsed.shows.filter(s => s.isUnidentified).length : 0);
                            if (parsed.missingShowsCount !== undefined) {
                                missingShowsCount = parsed.missingShowsCount;
                            }
                        }
                    } catch (_) {}
                }
                return {
                    id: j.id,
                    type: j.type,
                    triggerType: j.triggerType,
                    title: j.title,
                    status: j.status,
                    summary: j.summary,
                    durationMs: j.durationMs,
                    folderPath: j.folderPath,
                    scannedFolders: j.scannedFolders,
                    totalFiles: j.totalFiles,
                    bannedCount: j.bannedCount,
                    cleanedCount: j.cleanedCount,
                    freedFormatted: j.freedFormatted,
                    hasFindings: parsedFindingsCount > 0 || unidentifiedShowsCount > 0 || missingShowsCount > 0,
                    unidentifiedShowsCount,
                    missingShowsCount,
                    findingsCount: parsedFindingsCount,
                    error: j.error,
                    createdAt: j.createdAt,
                    timeFormatted: j.createdAt ? new Date(j.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''
                };
            });

            return { total, items: formatted };
        } catch (err) {
            logger.error(`[维护作业审计] 查询作业列表失败: ${err.message}`);
            return { total: 0, items: [] };
        }
    }

    /**
     * 获取单条作业详情（包含 findingsJson 与 cleanedDetailsJson 完整快照）
     */
    static async getJobById(id) {
        if (!id) return null;
        try {
            const repo = getMaintenanceJobRepository();
            const job = await repo.findOne({ where: { id: parseInt(id) } });
            if (!job) return null;

            let findings = [];
            let cleanedDetails = [];
            if (job.findingsJson) {
                try {
                    findings = JSON.parse(job.findingsJson);
                } catch (_) {}
            }
            if (job.cleanedDetailsJson) {
                try {
                    cleanedDetails = JSON.parse(job.cleanedDetailsJson);
                } catch (_) {}
            }

            return {
                id: job.id,
                type: job.type,
                triggerType: job.triggerType,
                title: job.title,
                status: job.status,
                summary: job.summary,
                durationMs: job.durationMs,
                folderPath: job.folderPath,
                scannedFolders: job.scannedFolders,
                totalFiles: job.totalFiles,
                bannedCount: job.bannedCount,
                cleanedCount: job.cleanedCount,
                freedFormatted: job.freedFormatted,
                findings,
                cleanedDetails,
                error: job.error,
                createdAt: job.createdAt,
                timeFormatted: job.createdAt ? new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''
            };
        } catch (err) {
            logger.error(`[维护作业审计] 查询作业 #${id} 详情失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 清空作业历史
     */
    static async clearJobs() {
        try {
            const repo = getMaintenanceJobRepository();
            await repo.clear();
            logger.info(`[维护作业审计] 已清空全部作业流水记录`);
            return true;
        } catch (err) {
            logger.error(`[维护作业审计] 清空作业失败: ${err.message}`);
            return false;
        }
    }

    /**
     * 删除单条作业记录
     */
    static async deleteJob(id) {
        if (!id) return false;
        try {
            const repo = getMaintenanceJobRepository();
            await repo.delete(parseInt(id));
            logger.info(`[维护作业审计] 已删除作业记录 #${id}`);
            return true;
        } catch (err) {
            logger.error(`[维护作业审计] 删除作业 #${id} 失败: ${err.message}`);
            return false;
        }
    }
}

module.exports = { MaintenanceJobService };

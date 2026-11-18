/**
 * ScrapeJournalService - 影视刮削预写操作日志 (WAL) 与原子逆向撤回引擎
 * 严格遵从事务与防损红线：
 * 1. 写前日志：在任何网盘跨目录移动与重命名发生前，必须先写入 ScrapeRecord
 * 2. LIFO 原子逆向撤回：从目标目录将文件搬回源目录原路径并恢复原文件名
 */

const { AppDataSource } = require('../database');
const { ScrapeBatch, ScrapeRecord, ScrapeBinding } = require('../entities');
const logger = require('../utils/logger');

class ScrapeJournalService {
    static get batchRepo() {
        return AppDataSource.isInitialized ? AppDataSource.getRepository(ScrapeBatch) : null;
    }

    static get recordRepo() {
        return AppDataSource.isInitialized ? AppDataSource.getRepository(ScrapeRecord) : null;
    }

    static get bindingRepo() {
        return AppDataSource.isInitialized ? AppDataSource.getRepository(ScrapeBinding) : null;
    }

    /**
     * 创建刮削执行批次
     */
    static async createBatch(params) {
        if (!this.batchRepo) throw new Error('数据库未初始化');
        const batch = this.batchRepo.create({
            driveType: params.driveType,
            accountId: Number(params.accountId || 0),
            rootRef: String(params.rootRef || ''),
            rootPath: params.rootPath || null,
            targetRootRef: params.targetRootRef ? String(params.targetRootRef) : null,
            targetRootPath: params.targetRootPath || null,
            trigger: params.trigger || 'manual',
            organize: Boolean(params.organize !== false),
            status: 'planned'
        });
        return await this.batchRepo.save(batch);
    }

    /**
     * 写前日志登记：在移动与重命名前记录计划
     * @param {number} batchId
     * @param {Array<object>} operations
     * @returns {Promise<Array<object>>}
     */
    static async recordOperations(batchId, operations) {
        if (!this.recordRepo) throw new Error('数据库未初始化');
        if (!operations || !operations.length) return [];

        const recordsToSave = [];
        const resultRecords = [];

        for (const op of operations) {
            if (op.status === 'protected') {
                // 防刷屏去重：检查数据库中该文件是否已有一条状态为 protected 的未处理记录
                try {
                    const query = {
                        driveType: op.driveType,
                        accountId: Number(op.accountId || 0),
                        oldName: String(op.oldName || ''),
                        status: 'protected'
                    };
                    if (op.fileRef) {
                        query.fileRef = String(op.fileRef);
                    }
                    const existing = await this.recordRepo.findOne({
                        where: query,
                        order: { id: 'DESC' }
                    });

                    if (existing) {
                        // 已有未解决的原地保护记录，复用该记录并更新原因与关联信息，绝不重复插入新行
                        existing.reason = op.reason || existing.reason;
                        existing.title = op.title || existing.title;
                        existing.tmdbId = op.tmdbId || existing.tmdbId;
                        existing.batchId = batchId;
                        await this.recordRepo.save(existing);
                        resultRecords.push(existing);
                        continue;
                    }
                } catch (findErr) {
                    logger.warn(`[ScrapeJournal] 检查已有保护记录异常: ${findErr.message}`);
                }
            }

            const rec = this.recordRepo.create({
                batchId,
                driveType: op.driveType || 'cloud139',
                accountId: Number(op.accountId || 0),
                kind: op.kind || 'video',
                mainRecordId: op.mainRecordId || null,
                groupKey: op.groupKey || null,
                fileRef: String(op.fileRef || ''),
                newRef: op.newRef ? String(op.newRef) : null,
                oldParentRef: String(op.oldParentRef || ''),
                oldParentPath: op.oldParentPath || null,
                oldName: String(op.oldName || ''),
                size: Number(op.size || 0),
                newParentRef: op.newParentRef ? String(op.newParentRef) : null,
                newParentPath: op.newParentPath || null,
                newName: op.newName ? String(op.newName) : null,
                mediaType: op.mediaType || 'movie',
                tmdbId: op.tmdbId ? String(op.tmdbId) : null,
                season: op.season !== undefined ? Number(op.season) : null,
                episode: op.episode !== undefined ? Number(op.episode) : null,
                title: op.title || null,
                year: op.year ? String(op.year) : null,
                confidence: Number(op.confidence || 0),
                evidence: op.evidence ? (typeof op.evidence === 'object' ? JSON.stringify(op.evidence) : String(op.evidence)) : ((op.posterPath || op.episodeTitle) ? JSON.stringify({ posterPath: op.posterPath || null, episodeTitle: op.episodeTitle || null }) : null),
                source: op.source || 'auto',
                status: op.status || 'applying',
                reason: op.reason || null
            });
            recordsToSave.push(rec);
            resultRecords.push(rec);
        }

        if (recordsToSave.length > 0) {
            await this.recordRepo.save(recordsToSave);
        }

        return resultRecords;
    }

    /**
     * 标记操作已应用
     */
    static async markApplied(recordIds, finalNewRefMap = {}) {
        if (!this.recordRepo || !recordIds || !recordIds.length) return;
        for (const id of recordIds) {
            const updateFields = {
                status: 'applied',
                appliedAt: new Date()
            };
            if (finalNewRefMap[id]) {
                updateFields.newRef = String(finalNewRefMap[id]);
            }
            await this.recordRepo.update(id, updateFields);
        }
    }

    /**
     * 标记操作执行失败
     */
    static async markFailed(recordId, errorMsg) {
        if (!this.recordRepo || !recordId) return;
        await this.recordRepo.update(recordId, {
            status: 'failed',
            error: String(errorMsg || '')
        });
    }

    /**
     * 单条记录逆向原子撤回 (LIFO Rollback)
     * 将文件移回 oldParentPath / oldParentRef，并恢复名称为 oldName
     * @param {number} recordId
     * @param {MediaDriveAdapter} adapter
     */
    static async revertRecord(recordId, adapter) {
        if (!this.recordRepo) throw new Error('数据库未初始化');
        const record = await this.recordRepo.findOne({ where: { id: recordId } });
        if (!record) throw new Error(`未找到刮削记录: id=${recordId}`);

        // 幂等防御：若记录此前已成功撤回，直接返回，避免重复撤回抛出 500
        if (record.status === 'reverted') {
            logger.info(`[刮削撤回] 记录 #${record.id} 当前已处于 [reverted] 撤回状态，幂等放行`);
            return record;
        }

        const activeRef = record.newRef || record.fileRef;
        if (!activeRef) {
            throw new Error(`记录 #${recordId} 缺少文件唯一引用 (fileRef)`);
        }

        logger.info(`[刮削撤回] 开始撤回记录 #${record.id}: 将 "${record.newName || record.oldName}" 搬回原位置 "${record.oldParentPath || record.oldParentRef || '/'}" 并还原为 "${record.oldName}"`);

        // 1. 若曾改名，先将名称恢复为原名
        if (record.oldName) {
            try {
                await adapter.rename(activeRef, record.oldName);
                logger.info(`[刮削撤回] 文件 #${activeRef} 已重命名恢复为 "${record.oldName}"`);
            } catch (renameErr) {
                logger.warn(`[刮削撤回] 重命名恢复原名提示 (非致命): ${renameErr.message}`);
            }
        }

        // 2. 将文件搬回源目录
        // 目标目录获取策略：优先通过 oldParentPath 保证目录存在性（若源空目录被清理则重新幂等创建）；若无则降级用 oldParentRef
        let targetFolderId = null;
        if (record.oldParentPath && typeof adapter.ensureDirPath === 'function') {
            try {
                targetFolderId = await adapter.ensureDirPath(record.oldParentPath);
            } catch (dirErr) {
                logger.warn(`[刮削撤回] 通过 oldParentPath 确保源目录失败: ${dirErr.message}，尝试使用 oldParentRef`);
            }
        }
        if (!targetFolderId && record.oldParentRef) {
            targetFolderId = record.oldParentRef;
        }

        if (targetFolderId) {
            try {
                await adapter.batchMove([activeRef], targetFolderId);
                logger.info(`[刮削撤回] 文件 #${activeRef} 已成功移回源目录 (${targetFolderId})`);
            } catch (moveErr) {
                if (moveErr.message && (
                    moveErr.message.includes('无法移动到自身') ||
                    moveErr.message.includes('自身所在目录') ||
                    moveErr.message.includes('同一目录')
                )) {
                    logger.info(`[刮削撤回] 文件已在源目录中，无需重复移动: ${moveErr.message}`);
                } else {
                    throw new Error(`移动回原目录失败: ${moveErr.message}`);
                }
            }
        } else {
            logger.warn(`[刮削撤回] 记录 #${record.id} 未提供有效源目录 (oldParentPath 或 oldParentRef 为空)，仅完成重命名`);
        }

        // 3. 回收站旧版救援：若该记录曾置换淘汰了旧版且记录了 replacedFileId，尝试从回收站找回
        if (record.replacedFileId && typeof adapter.restoreFromRecycleBin === 'function') {
            try {
                await adapter.restoreFromRecycleBin(record.replacedFileId);
                logger.info(`[刮削撤回] 已成功从回收站救回被淘汰的旧版文件 (${record.replacedFileId})`);
            } catch (resErr) {
                logger.warn(`[刮削撤回] 尝试从回收站救回旧版文件 (${record.replacedFileId}) 失败: ${resErr.message}`);
            }
        }

        // 4. 更新日志状态为 reverted
        record.status = 'reverted';
        record.revertedAt = new Date();
        record.reason = '已通过原路撤回恢复至原目录与原文件名';
        await this.recordRepo.save(record);
        logger.info(`[刮削撤回] 记录 #${record.id} 逆向撤回成功`);
        return record;
    }

    /**
     * 整批 LIFO 倒序安全撤回
     * @param {number} batchId
     * @param {MediaDriveAdapter} adapter
     */
    static async revertBatch(batchId, adapter) {
        if (!this.batchRepo || !this.recordRepo) throw new Error('数据库未初始化');
        const batch = await this.batchRepo.findOne({ where: { id: batchId } });
        if (!batch) throw new Error(`未找到刮削批次: id=${batchId}`);

        // 倒序拉取所有非 reverted 的记录进行回滚
        const records = await this.recordRepo.find({
            where: [
                { batchId, status: 'applied' },
                { batchId, status: 'MOVED' },
                { batchId, status: 'quarantined' },
                { batchId, status: 'fallback' }
            ],
            order: { id: 'DESC' }
        });

        const results = { total: records.length, reverted: 0, failed: 0, errors: [] };
        for (const rec of records) {
            try {
                await this.revertRecord(rec.id, adapter);
                results.reverted++;
            } catch (err) {
                results.failed++;
                results.errors.push({ recordId: rec.id, error: err.message });
                logger.error(`[批次撤回] 记录 #${rec.id} 撤回失败: ${err.message}`);
            }
        }

        batch.status = results.failed === 0 ? 'reverted' : 'partial';
        await this.batchRepo.save(batch);
        return results;
    }

    /**
     * 保存人工纠偏绑定关系 (ScrapeBinding) 终身自愈记忆
     */
    static async saveBinding(params) {
        if (!this.bindingRepo) throw new Error('数据库未初始化');
        const folderKey = String(params.folderKey || '').trim();
        const driveType = String(params.driveType || 'cloud139');
        const accountId = Number(params.accountId || 0);

        let binding = await this.bindingRepo.findOne({
            where: { driveType, accountId, folderKey }
        });

        if (!binding) {
            binding = this.bindingRepo.create({
                driveType,
                accountId,
                folderKey
            });
        }

        binding.tmdbId = String(params.tmdbId || '');
        binding.mediaType = params.mediaType || 'tv';
        binding.seasonOverride = params.seasonOverride !== undefined ? Number(params.seasonOverride) : null;
        binding.episodeOffset = Number(params.episodeOffset || 0);
        binding.action = params.action || 'bind';

        await this.bindingRepo.save(binding);
        logger.info(`[自愈记忆] 成功持久化目录绑定: folderKey=${folderKey} -> tmdbId=${binding.tmdbId}`);
        return binding;
    }

    /**
     * 查询纠偏绑定关系
     */
    static async findBinding(driveType, accountId, folderKey) {
        if (!this.bindingRepo) return null;
        return await this.bindingRepo.findOne({
            where: { driveType, accountId: Number(accountId || 0), folderKey: String(folderKey) }
        });
    }
}

module.exports = { ScrapeJournalService };

/**
 * OrganizeProtectionService
 * 影视整理未识别熔断与冷却保护服务
 * 
 * 核心目标：
 * 1. 彻底杜绝暂存区无法识别的文件在后台定时任务中无限死循环重复整理；
 * 2. 阶梯退避与最大重试限制（连续 3 次未识别后进入 24 小时冷却保护期）；
 * 3. 冷却期内自动整理直接快速短路跳过，0 TMDB API 消耗，0 媒体流探测，0 重复日志；
 * 4. 用户手动干预（WebUI 手动整理、绑定 TMDB、清空保护记录）时立即重置冷却。
 */

const logger = require('../utils/logger');
const ConfigService = require('./ConfigService');

class OrganizeProtectionService {
    constructor() {
        /**
         * 内存冷却与重试追踪表
         * Map<string, {
         *   key: string,
         *   fileId: string,
         *   name: string,
         *   size: number,
         *   failCount: number,
         *   firstFailedAt: number,
         *   lastFailedAt: number,
         *   cooldownUntil: number,
         *   reason: string
         * }>
         */
        this._cache = new Map();
    }

    /**
     * 生成条目唯一特征键
     * @param {object} file 
     * @returns {string}
     */
    static getFileKey(file) {
        if (!file) return '';
        const id = file.fileId || file.id || file.fileRef;
        if (id) return `id:${id}`;
        const name = file.name || file.oldName || '';
        const size = file.size || file.fileSize || 0;
        const parent = file.parentCatalogId || file.oldParentRef || '';
        return `file:${name}:${size}:${parent}`;
    }

    /**
     * 判断文件是否处于未识别冷却保护期
     * @param {object} file 
     * @param {object} [options] { force?: boolean }
     * @returns {{ inCooldown: boolean, failCount?: number, reason?: string, cooldownUntil?: number, remainingHours?: number }}
     */
    isUnderCooldown(file, options = {}) {
        if (options && options.force) {
            return { inCooldown: false };
        }

        const key = OrganizeProtectionService.getFileKey(file);
        if (!key || !this._cache.has(key)) {
            return { inCooldown: false };
        }

        const entry = this._cache.get(key);
        const maxRetries = ConfigService.getConfigValue('channelMonitor.maxUnrecognizedRetries', 3);
        const now = Date.now();

        // 尚未达到最大重试次数
        if (entry.failCount < maxRetries) {
            return { inCooldown: false };
        }

        // 达到重试次数，检查冷却是否到期
        if (now < entry.cooldownUntil) {
            const remainingHours = Math.max(1, Math.ceil((entry.cooldownUntil - now) / (3600 * 1000)));
            return {
                inCooldown: true,
                failCount: entry.failCount,
                reason: entry.reason,
                cooldownUntil: entry.cooldownUntil,
                remainingHours
            };
        }

        // 冷却已过期，放行一次重试机会（将 failCount 设为 maxRetries - 1）
        entry.failCount = maxRetries - 1;
        return { inCooldown: false };
    }

    /**
     * 登记一次未识别/原地保护事件
     * @param {object} file 
     * @param {string} reason 
     * @returns {object} entry
     */
    recordProtection(file, reason = '') {
        const key = OrganizeProtectionService.getFileKey(file);
        if (!key) return null;

        const maxRetries = ConfigService.getConfigValue('channelMonitor.maxUnrecognizedRetries', 3);
        const cooldownHours = ConfigService.getConfigValue('channelMonitor.unrecognizedCooldownHours', 24);
        const now = Date.now();

        let entry = this._cache.get(key);
        if (!entry) {
            entry = {
                key,
                fileId: file.fileId || file.id || file.fileRef || '',
                name: file.name || file.oldName || '',
                size: file.size || file.fileSize || 0,
                failCount: 0,
                firstFailedAt: now,
                lastFailedAt: now,
                cooldownUntil: 0,
                reason: reason || ''
            };
            this._cache.set(key, entry);
        }

        entry.failCount++;
        entry.lastFailedAt = now;
        entry.reason = reason || entry.reason;

        if (entry.failCount >= maxRetries) {
            entry.cooldownUntil = now + cooldownHours * 3600 * 1000;
            logger.info(`[整理保护熔断] 文件 "${entry.name}" 连续 ${entry.failCount} 次未识别/保护，已进入冷却熔断（${cooldownHours}h 内自动整理跳过）: ${entry.reason}`);
        } else {
            logger.info(`[整理未识别记录] 文件 "${entry.name}" 第 ${entry.failCount}/${maxRetries} 次未识别/保护: ${entry.reason}`);
        }

        return entry;
    }

    /**
     * 标记文件已成功归档（解除冷却追踪）
     * @param {string|object} fileOrKey 
     */
    markResolved(fileOrKey) {
        if (!fileOrKey) return;
        const key = typeof fileOrKey === 'string'
            ? (fileOrKey.startsWith('id:') || fileOrKey.startsWith('file:') ? fileOrKey : `id:${fileOrKey}`)
            : OrganizeProtectionService.getFileKey(fileOrKey);

        if (this._cache.has(key)) {
            const entry = this._cache.get(key);
            this._cache.delete(key);
            logger.info(`[整理保护解除] 文件 "${entry.name || key}" 已成功归档，清除未识别冷却记录`);
            return;
        }

        // 兜底按 name / fileId 逆向扫描匹配
        if (typeof fileOrKey === 'string') {
            for (const [k, entry] of this._cache.entries()) {
                if (entry.fileId === fileOrKey || entry.name === fileOrKey) {
                    this._cache.delete(k);
                    logger.info(`[整理保护解除] 文件 "${entry.name}" 已成功归档，清除未识别冷却记录`);
                    break;
                }
            }
        }
    }

    /**
     * 清空所有冷却追踪状态
     */
    clearAll() {
        const count = this._cache.size;
        this._cache.clear();
        logger.info(`[整理保护重置] 已清空全部 ${count} 条未识别冷却追踪记录`);
        return count;
    }

    /**
     * 获取所有当前处于冷却期的条目列表
     * @returns {Array<object>}
     */
    getCooldownList() {
        const now = Date.now();
        const list = [];
        for (const entry of this._cache.values()) {
            if (entry.cooldownUntil > now) {
                const remainingHours = Math.max(1, Math.ceil((entry.cooldownUntil - now) / (3600 * 1000)));
                list.push({
                    key: entry.key,
                    fileId: entry.fileId,
                    name: entry.name,
                    size: entry.size,
                    failCount: entry.failCount,
                    reason: entry.reason,
                    lastFailedAt: entry.lastFailedAt,
                    cooldownUntil: entry.cooldownUntil,
                    remainingHours
                });
            }
        }
        return list;
    }

    /**
     * 从 SQLite 中预热历史 protected 记录（服务重启自愈）
     * @param {object} dataSource 
     */
    async initFromDatabase(dataSource) {
        if (!dataSource || !dataSource.isInitialized) return;
        try {
            const { ScrapeRecord } = require('../entities');
            const repo = dataSource.getRepository(ScrapeRecord);
            const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000);

            // 查询过去 24 小时内的 protected 记录
            const recentProtected = await repo.find({
                where: { status: 'protected' },
                order: { id: 'DESC' },
                take: 200
            });

            const counts = new Map();
            for (const r of recentProtected) {
                const key = OrganizeProtectionService.getFileKey({
                    fileId: r.fileRef,
                    name: r.oldName,
                    size: r.size,
                    parentCatalogId: r.oldParentRef
                });
                if (!counts.has(key)) {
                    counts.set(key, { record: r, count: 0 });
                }
                counts.get(key).count++;
            }

            const maxRetries = ConfigService.getConfigValue('channelMonitor.maxUnrecognizedRetries', 3);
            const cooldownHours = ConfigService.getConfigValue('channelMonitor.unrecognizedCooldownHours', 24);
            const now = Date.now();

            for (const [key, { record, count }] of counts.entries()) {
                if (count >= maxRetries) {
                    this._cache.set(key, {
                        key,
                        fileId: record.fileRef || '',
                        name: record.oldName || '',
                        size: record.size || 0,
                        failCount: count,
                        firstFailedAt: record.createdAt ? new Date(record.createdAt).getTime() : now,
                        lastFailedAt: now,
                        cooldownUntil: now + cooldownHours * 3600 * 1000,
                        reason: record.reason || '历史多次未识别'
                    });
                }
            }

            if (this._cache.size > 0) {
                logger.info(`[整理保护自愈] 从数据库预热加载 ${this._cache.size} 条历史熔断冷却条目`);
            }
        } catch (err) {
            logger.warn(`[整理保护自愈] 数据库预热加载异常: ${err.message}`);
        }
    }
}

const instance = new OrganizeProtectionService();

module.exports = {
    OrganizeProtectionService: instance,
    OrganizeProtectionServiceClass: OrganizeProtectionService
};

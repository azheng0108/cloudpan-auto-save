const logger = require('../utils/logger');

/**
 * 全局目录级防并发互斥锁 (OrganizeMutex)
 * 
 * 核心目标：
 * 防止后台自动整理（StagingOrganize）与前端刮削工作台（ScrapeWorkbench）同时操作相同目录，
 * 杜绝并发跨目录移动、探针嗅探冲突与 139 网盘网关 404/409 报错。
 */
class OrganizeMutex {
    // 目录锁集合: folderId -> { lockedAt, owner, taskName }
    static _locks = new Map();

    /**
     * 申请目录独占锁
     * @param {string} folderId - 云盘目录 ID 或标准路径
     * @param {string} owner - 锁持有方 (如 'auto_staging', 'workbench_manual')
     * @param {string} taskName - 业务名称
     * @param {number} timeoutMs - 自动超时自愈时长，默认 10 分钟 (防止进程宕机永久死锁)
     * @returns {boolean} 是否获取成功
     */
    static acquire(folderId, owner = 'manual', taskName = '', timeoutMs = 600000) {
        if (!folderId) return true;
        const normKey = String(folderId).trim().toLowerCase();

        if (this._locks.has(normKey)) {
            const current = this._locks.get(normKey);
            // 检查是否超时自愈
            if (Date.now() - current.lockedAt > timeoutMs) {
                logger.warn(`[目录互斥锁] 目录 "${normKey}" 原有锁已超时 (${timeoutMs}ms)，由 [${owner}] 强制接管并释放老锁`);
                this._locks.delete(normKey);
            } else {
                logger.info(`[目录互斥锁] 目录 "${normKey}" 正被 [${current.owner}] 占用 (${current.taskName})，拒绝 [${owner}] 获取`);
                return false;
            }
        }

        this._locks.set(normKey, {
            lockedAt: Date.now(),
            owner,
            taskName
        });
        return true;
    }

    /**
     * 释放目录锁
     * @param {string} folderId
     */
    static release(folderId) {
        if (!folderId) return;
        const normKey = String(folderId).trim().toLowerCase();
        this._locks.delete(normKey);
    }

    /**
     * 检查某目录是否正处于锁定状态
     * @param {string} folderId
     * @returns {Object|null}
     */
    static isLocked(folderId) {
        if (!folderId) return null;
        const normKey = String(folderId).trim().toLowerCase();
        const info = this._locks.get(normKey);
        if (!info) return null;
        if (Date.now() - info.lockedAt > 600000) {
            this._locks.delete(normKey);
            return null;
        }
        return info;
    }
}

module.exports = { OrganizeMutex };

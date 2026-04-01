// 缓存管理类
class CacheManager {
    constructor(ttl = 600) {
        this.cache = new Map();
        this.ttl = ttl * 1000; // 转换为毫秒
        this.cleanupInterval = null;
        
        // 启动定期清理（默认每10分钟清理一次）
        this.startCleanup();
    }

    startCleanup() {
        // 避免重复启动
        if (this.cleanupInterval) {
            return;
        }
        
        const cleanupIntervalMs = Math.max(this.ttl / 2, 60000); // 至少1分钟
        this.cleanupInterval = setInterval(() => {
            const before = this.cache.size;
            this.cleanup();
            const after = this.cache.size;
            if (before > after) {
                console.log(`[CacheManager] 清理了 ${before - after} 个过期缓存项，剩余 ${after} 项`);
            }
        }, cleanupIntervalMs);
        
        // 防止定时器阻止进程退出
        this.cleanupInterval.unref();
    }

    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    set(key, value) {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const data = this.cache.get(key);
        if (!data) return null;
        
        // 检查是否过期
        if (Date.now() - data.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        
        return data.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, data] of this.cache.entries()) {
            if (now - data.timestamp > this.ttl) {
                this.cache.delete(key);
                cleaned++;
            }
        }
        return cleaned;
    }
    
    clearPrefix(prefix) {
        let cleared = 0;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
                cleared++;
            }
        }
        return cleared;
    }

    // 获取缓存统计信息
    getStats() {
        const now = Date.now();
        let valid = 0;
        let expired = 0;
        
        for (const [, data] of this.cache.entries()) {
            if (now - data.timestamp > this.ttl) {
                expired++;
            } else {
                valid++;
            }
        }
        
        return {
            total: this.cache.size,
            valid,
            expired,
            ttl: this.ttl / 1000
        };
    }

    // 清空所有缓存
    clear() {
        this.cache.clear();
    }
}

module.exports = { CacheManager };
const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const logger = require('../utils/logger');

/**
 * EmbyService: 专注于配合 OpenList 原生 STRM 或本地 STRM 的媒体库增量事件通知。
 * 遵循工程治理铁律 1（替换，绝不包裹）：彻底剔除老旧的递归向上爬树搜索、模糊片名猜测、
 * 全库死锁扫描以及数据库 embyId 缓存字段，统一采用 Emby 官方推荐的目录事件轻量通知端点 /emby/Library/Media/Updated。
 */
class EmbyService {
    constructor() {
        this.enable = ConfigService.getConfigValue('emby.enable');
        this.embyUrl = ConfigService.getConfigValue('emby.serverUrl');
        this.embyApiKey = ConfigService.getConfigValue('emby.apiKey');
    }

    /**
     * 规范化目录路径
     * @param {string} pathValue 
     * @returns {string}
     */
    _normalizeDirPath(pathValue) {
        const normalized = String(pathValue || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '')
            .trim();
        if (!normalized) return '';
        return normalized.startsWith('/') ? normalized : `/${normalized}`;
    }

    /**
     * 将 realFolderName 转换为 Emby 挂载对应的完整路径
     * @param {string} path 
     * @param {string} embyLibraryPath 
     * @returns {string}
     */
    _replacePath(path, embyLibraryPath) {
        path = String(path || '').replace(/\\/g, '/').trim();
        if (embyLibraryPath) {
            const libraryPath = String(embyLibraryPath).replace(/\\/g, '/').trim();
            const libraryTrimmed = libraryPath.replace(/^\/+|\/+$/g, '');
            const rel = path.replace(/^\/+/, '').replace(/\/+$/g, '');
            if (libraryTrimmed && (rel === libraryTrimmed || rel.startsWith(`${libraryTrimmed}/`))) {
                return ('/' + rel).replace(/\/+$/g, '');
            }
            const prefixed = `${libraryPath.replace(/\/+$/, '')}/${rel}`.replace(/\/+/g, '/');
            return prefixed.replace(/\/+$/g, '');
        }
        return this._normalizeDirPath(path);
    }

    /**
     * 向 Emby 发送目录局部更新事件，触发其内部目录监控器轻量刷新对应目录
     * @param {string[]} paths 
     * @returns {Promise<boolean>}
     */
    async refreshMediaByPaths(paths = []) {
        const normalizedPaths = [...new Set((paths || [])
            .map(p => this._normalizeDirPath(p))
            .filter(Boolean))];

        if (normalizedPaths.length === 0) {
            return false;
        }

        const url = `${this.embyUrl}/emby/Library/Media/Updated`;
        const headers = {
            'Authorization': 'MediaBrowser Token="' + this.embyApiKey + '"',
        };

        const primaryPayload = {
            Updates: normalizedPaths.map(path => ({
                Path: path,
                UpdateType: 'Created',
            })),
        };

        try {
            const response = await got(url, {
                method: 'POST',
                headers,
                json: primaryPayload,
                responseType: 'text',
                timeout: 5000,
                throwHttpErrors: false,
            });

            if (response.statusCode >= 200 && response.statusCode < 300) {
                return true;
            }

            // 备用兼容 payload
            const fallbackRes = await got(url, {
                method: 'POST',
                headers,
                json: { Paths: normalizedPaths },
                responseType: 'text',
                timeout: 5000,
                throwHttpErrors: false,
            });
            return fallbackRes.statusCode >= 200 && fallbackRes.statusCode < 300;
        } catch (error) {
            logTaskEvent(`[Emby] 目录事件局部刷新异常: ${error.message}`);
            return false;
        }
    }

    /**
     * 执行 Emby 媒体库直连通知
     * @param {object} task 
     * @param {object} options - { directoryPath }
     * @returns {Promise<{ status: string, reason?: string, refreshMode?: string, targetDirPath?: string }>}
     */
    async notify(task, options = {}) {
        if (!this.enable || !this.embyUrl || !this.embyApiKey) {
            return { status: 'skipped', reason: 'disabled' };
        }

        const taskName = task.resourceName || '';
        const embyLibraryPath = ConfigService.getConfigValue('emby.libraryPath') || '';
        const rawDirPath = options.directoryPath || task.realFolderName || '';
        const targetDirPath = this._replacePath(rawDirPath, embyLibraryPath);

        logTaskEvent(`[Emby] 执行媒体库直连增量刷新: task=${taskName}, targetPath=${targetDirPath}`);

        const ok = await this.refreshMediaByPaths([targetDirPath]);
        if (ok) {
            logTaskEvent(`[Emby] 目录增量更新事件已确认送达: ${targetDirPath}`);
            return {
                status: 'success',
                refreshMode: '目录增量事件',
                targetDirPath
            };
        } else {
            logTaskEvent(`[Emby] 目录增量更新事件发送失败: ${targetDirPath}`);
            return {
                status: 'failed',
                reason: 'request-failed',
                targetDirPath
            };
        }
    }
}

module.exports = { EmbyService };

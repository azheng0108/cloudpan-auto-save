const got = require('got');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

const alistService = {
    Enable() {
        return ConfigService.getConfigValue('alist.enable') && ConfigService.getConfigValue('alist.baseUrl') && ConfigService.getConfigValue('alist.apiKey');
    },
    /**
     * 获取目录列表
     * @param {string} path 目录路径
     * @returns {Promise<Object>} 返回目录列表数据
     */
    async listFiles(path) {
        const baseUrl = await this.getConfig('alist.baseUrl');
        const apiKey = await this.getConfig('alist.apiKey');

        if (!baseUrl) {
            throw new Error('AList baseUrl 未配置');
        }

        if (!apiKey) {
            throw new Error('AList apiKey 未配置');
        }

        try {
            const response = await got.post(`${baseUrl}/api/fs/list`, {
                json: {
                    path: path,
                    page: 1,
                    per_page: 0,
                    refresh: true
                },
                headers: {
                    'Authorization': apiKey
                }
            }).json();

            if (!response || typeof response !== 'object') {
                throw new Error('AList API 返回空响应');
            }

            const code = response.code;
            const message = String(response.message || '').toLowerCase();
            const successByCode = code === 200 || code === 0 || code === '200' || code === '0';
            const successByMessage = message === 'success' || message === 'ok';

            if (code !== undefined && !successByCode && !successByMessage) {
                throw new Error(`AList API 业务错误: code=${code}, message=${response.message || 'unknown'}`);
            }

            if (response.data === undefined || response.data === null) {
                throw new Error('AList API 响应缺少 data 字段');
            }

            return response;
        } catch (error) {
            if (error.response) {
                throw new Error(`AList API 错误: ${error.response.statusMessage}`);
            }
            throw error;
        }
    },

    /**
     * 获取某个 OpenList 路径下第一层目录名称列表。
     * @param {string} path
     * @returns {Promise<string[]>}
     */
    async getFirstLevelFolders(path) {
        const response = await this.listFiles(path);
        const content = Array.isArray(response?.data?.content) ? response.data.content : [];
        return content
            .filter(item => item?.is_dir && item?.name)
            .map(item => String(item.name).trim())
            .filter(Boolean);
    },

    /**
     * 对单个目录执行一次强制回源刷新。
     * 只发送一次 fs/list(refresh=true) 请求，不做递归，避免性能放大与网盘风控。
     * @param {string} path
     * @returns {Promise<{requestedPath:string, success:boolean, contentCount:number}>}
     */
    async refreshSingleDirectory(path) {
        const normalizedPath = this._normalizePath(path || '/');
        const response = await this.listFiles(normalizedPath);
        const content = Array.isArray(response?.data?.content) ? response.data.content : [];
        return {
            requestedPath: normalizedPath,
            success: true,
            contentCount: content.length,
        };
    },

    /**
     * 读取 STRM 目录内容（不触发刷新），验证期望文件名是否已存在。
     * 用于缓存刷新后确认 OpenList STRM 驱动已生成对应 .strm 文件。
     * @param {string} strmPath STRM 虚拟目录路径
     * @param {string[]} expectedFileNames 期望存在的文件名数组（形如 "episode.strm"）
     * @returns {Promise<{verified: boolean, foundCount: number, missingCount: number}>}
     */
    async verifyStrmContent(strmPath, expectedFileNames) {
        try {
            const normalizedPath = this._normalizePath(strmPath || '/');
            // 读取缓存，不触发二次刷新（refresh=true 已在 refreshSingleDirectory 中完成）
            const baseUrl = await this.getConfig('alist.baseUrl');
            const apiKey = await this.getConfig('alist.apiKey');
            const response = await got.post(`${baseUrl}/api/fs/list`, {
                json: { path: normalizedPath, page: 1, per_page: 0, refresh: false },
                headers: { 'Authorization': apiKey }
            }).json();
            const content = Array.isArray(response?.data?.content) ? response.data.content : [];
            const existingNames = new Set(content.map(item => String(item?.name || '').toLowerCase()));
            const expected = Array.isArray(expectedFileNames) ? expectedFileNames : [];
            let foundCount = 0;
            for (const name of expected) {
                if (existingNames.has(String(name).toLowerCase())) {
                    foundCount++;
                }
            }
            const missingCount = expected.length - foundCount;
            return { verified: foundCount > 0, foundCount, missingCount };
        } catch (e) {
            logTaskEvent(`verifyStrmContent 读取失败(忽略): ${e.message}`);
            return { verified: false, foundCount: 0, missingCount: (expectedFileNames || []).length };
        }
    },

    /**
     * 读取 OpenList 存储配置（需要具有管理权限的 token）。
     * @returns {Promise<Array<Object>>}
     */
    async listStorages() {
        const baseUrl = await this.getConfig('alist.baseUrl');
        const apiKey = await this.getConfig('alist.apiKey');

        if (!baseUrl) {
            throw new Error('AList baseUrl 未配置');
        }
        if (!apiKey) {
            throw new Error('AList apiKey 未配置');
        }

        const authCandidates = [apiKey, `Bearer ${apiKey}`];
        const endpoints = [
            { method: 'POST', path: '/api/admin/storage/list', json: { page: 1, per_page: 0 } },
            { method: 'GET', path: '/api/admin/storage/list', searchParams: { page: 1, per_page: 0 } },
            { method: 'POST', path: '/api/admin/storages/list', json: { page: 1, per_page: 0 } },
            { method: 'GET', path: '/api/admin/storages/list', searchParams: { page: 1, per_page: 0 } },
        ];

        let lastError = null;
        let response = null;
        for (const authHeader of authCandidates) {
            for (const endpoint of endpoints) {
                try {
                    response = await this._requestJson(`${baseUrl}${endpoint.path}`, {
                        method: endpoint.method,
                        headers: { 'Authorization': authHeader },
                        json: endpoint.json,
                        searchParams: endpoint.searchParams,
                    });
                    if (response && typeof response === 'object') {
                        break;
                    }
                } catch (error) {
                    lastError = error;
                }
            }
            if (response && typeof response === 'object') {
                break;
            }
        }

        if (!response || typeof response !== 'object') {
            throw new Error(`OpenList 存储接口不可用: ${lastError?.message || 'unknown error'}`);
        }

        if (!response || typeof response !== 'object') {
            throw new Error('OpenList 存储接口返回空响应');
        }

        const code = response.code;
        const message = String(response.message || '').toLowerCase();
        const successByCode = code === 200 || code === 0 || code === '200' || code === '0';
        const successByMessage = message === 'success' || message === 'ok';
        if (code !== undefined && !successByCode && !successByMessage) {
            throw new Error(`OpenList 存储接口业务错误: code=${code}, message=${response.message || 'unknown'}`);
        }

        const data = response.data;
        if (Array.isArray(data)) {
            return data;
        }
        if (Array.isArray(data?.content)) {
            return data.content;
        }

        throw new Error('OpenList 存储接口响应缺少 content');
    },

    async _requestJson(url, options) {
        const response = await got(url, {
            method: options.method,
            headers: options.headers,
            json: options.json,
            searchParams: options.searchParams,
            responseType: 'text',
            throwHttpErrors: false,
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`HTTP ${response.statusCode} ${url}`);
        }

        const bodyText = String(response.body || '').trim();
        if (!bodyText) {
            throw new Error(`空响应: ${url}`);
        }

        try {
            return JSON.parse(bodyText);
        } catch (_) {
            throw new Error(`返回非 JSON（可能被反代重写或权限不足）: ${url}`);
        }
    },

    /**
     * 基于 alistStrmPath 自动推断挂载根目录 ID。
     * 若 token 非管理员或驱动不暴露该字段，返回空字符串。
     * @param {string} alistPath
     * @returns {Promise<string>}
     */
    async resolveRootFolderIdByPath(alistPath) {
        const normalizedPath = this._normalizePath(alistPath);
        if (!normalizedPath) return '';

        let storages;
        try {
            storages = await this.listStorages();
        } catch (error) {
            logTaskEvent(`OpenList 自动识别 rootFolderId 失败（读取存储配置）: ${error.message}`);
            return '';
        }

        let bestMatch = null;
        for (const storage of storages) {
            const mountPath = this._normalizePath(storage?.mount_path || storage?.mountPath || storage?.mount || '');
            if (!mountPath) continue;
            if (normalizedPath !== mountPath && !normalizedPath.startsWith(`${mountPath}/`)) {
                continue;
            }
            if (!bestMatch || mountPath.length > bestMatch.mountPath.length) {
                bestMatch = { storage, mountPath };
            }
        }

        if (!bestMatch) {
            return '';
        }

        const resolved = this._extractRootFolderId(bestMatch.storage);
        return resolved ? String(resolved).trim() : '';
    },

    _normalizePath(value) {
        const normalized = String(value || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '')
            .trim();
        if (!normalized) return '';
        return normalized.startsWith('/') ? normalized : `/${normalized}`;
    },

    _extractRootFolderId(storage) {
        if (!storage || typeof storage !== 'object') {
            return '';
        }

        const directCandidates = [
            storage.rootFolderId,
            storage.root_folder_id,
            storage.rootFolder,
            storage.root_folder,
        ].filter(Boolean);
        if (directCandidates.length > 0) {
            return directCandidates[0];
        }

        const additionRaw = storage.addition || storage.additional || storage.config || null;
        let addition = additionRaw;
        if (typeof additionRaw === 'string') {
            try {
                addition = JSON.parse(additionRaw);
            } catch (_) {
                addition = null;
            }
        }

        if (!addition || typeof addition !== 'object') {
            return '';
        }

        const knownKeys = [
            'root_folder_id',
            'rootFolderId',
            'root_folder',
            'rootFolder',
            'catalog_id',
            'catalogId',
            'folder_id',
            'folderId',
        ];
        for (const key of knownKeys) {
            const value = addition[key];
            if (typeof value === 'string' || typeof value === 'number') {
                const normalized = String(value).trim();
                if (normalized) return normalized;
            }
        }

        const queue = [addition];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || typeof current !== 'object') continue;
            for (const [key, value] of Object.entries(current)) {
                if (value && typeof value === 'object') {
                    queue.push(value);
                    continue;
                }
                const keyName = String(key).toLowerCase();
                if ((typeof value === 'string' || typeof value === 'number') && keyName.includes('root') && keyName.includes('id')) {
                    const normalized = String(value).trim();
                    if (normalized) return normalized;
                }
            }
        }

        return '';
    },

    /**
     * 递归访问目录，触发 OpenList STRM 驱动为每个子目录同步生成 .strm 文件。
     * OpenList STRM 驱动在 /api/fs/list 被调用时同步写入当前目录的 .strm 文件，
     * 返回统计信息，供上层判断是否真的成功完成。
     * @param {string} dirPath - OpenList 内的目录路径（STRM 驱动挂载路径下）
     * @returns {Promise<{requestedPath:string, visitedCount:number, failedCount:number, failedPaths:Array<{path:string,error:string}>}>}
     */
    async recursiveRefresh(dirPath) {
        const normalizedRoot = String(dirPath || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        const state = {
            visitedCount: 0,
            failedPaths: [],
        };

        await this._recursiveRefreshInternal(normalizedRoot, state);

        return {
            requestedPath: normalizedRoot,
            visitedCount: state.visitedCount,
            failedCount: state.failedPaths.length,
            failedPaths: state.failedPaths,
        };
    },

    async _recursiveRefreshInternal(dirPath, state) {
        let response;
        try {
            response = await this.listFiles(dirPath);
            state.visitedCount += 1;
        } catch (error) {
            state.failedPaths.push({ path: dirPath, error: error.message });
            logTaskEvent(`OpenList 目录刷新失败: ${dirPath}, 错误: ${error.message}`);
            return;
        }

        const content = Array.isArray(response?.data?.content) ? response.data.content : [];
        const subDirs = content.filter(item => item?.is_dir && item?.name);
        for (const dir of subDirs) {
            const nextPath = `${dirPath.replace(/\/+$/, '')}/${String(dir.name).replace(/^\/+/, '')}`;
            await this._recursiveRefreshInternal(nextPath, state);
        }
    },

    /**
     * 从配置服务获取配置
     * @param {string} key 配置键名
     * @returns {Promise<string>} 配置值
     */
    async getConfig(key) {
        // 从本地存储获取配置
        return ConfigService.getConfigValue(key);
    }
};

module.exports = alistService;
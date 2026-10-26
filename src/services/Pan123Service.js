const got = require('got');
const ProxyUtil = require('../utils/ProxyUtil');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');

class Pan123Service {
    static LOGIN_URL = 'https://login.123pan.com/api/user/sign_in';
    static API_BASE = 'https://www.123pan.com/api';
    static RESOLVE_LIMIT_CODE = 5252;
    static DEFAULT_BATCH_SIZE = 5;

    /**
     * 123 网盘用户认证登录
     * @param {string} username - 手机号或邮箱
     * @param {string} password - 登录密码
     * @returns {Promise<{success: boolean, token?: string, user?: object, message?: string, code?: number}>}
     */
    static async login(username, password) {
        if (!username || !password) {
            return { success: false, message: '请提供 123 网盘账号与密码' };
        }

        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(username).trim());
        const body = isEmail
            ? { mail: String(username).trim(), password: String(password).trim(), type: 2 }
            : { passport: String(username).trim(), password: String(password).trim(), remember: true };

        const agent = ProxyUtil.getProxyAgent('pan123');

        try {
            logger.debug('[123网盘] 发起登录认证请求');
            const res = await got.post(this.LOGIN_URL, {
                json: body,
                headers: {
                    'origin': 'https://yun.123pan.com',
                    'referer': 'https://yun.123pan.com/',
                    'platform': 'web',
                    'app-version': '3',
                    'content-type': 'application/json',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                agent,
                timeout: { request: 12000 },
                responseType: 'json'
            });

            const json = res.body || {};
            const code = json.code;
            if ((code === 200 || code === 0) && json.data?.token) {
                logger.info('[123网盘] 账号登录鉴权成功');
                return {
                    success: true,
                    token: json.data.token,
                    user: json.data.user || json.data.userInfo || {}
                };
            }

            const errMsg = json.message || json.msg || `错误码: ${code}`;
            logger.warn(`[123网盘] 登录失败 code=${code}, msg=${errMsg}`);
            return {
                success: false,
                code,
                message: errMsg
            };
        } catch (error) {
            const errDetail = error.response?.body?.message || error.message || '网络连接超时';
            logger.error(`[123网盘] 登录请求异常: ${errDetail}`);
            return {
                success: false,
                message: `123 网盘登录失败: ${errDetail}`
            };
        }
    }

    /**
     * 发送已签名的 123 网盘 REST API 请求
     */
    static async request(method, apiPath, payload, token) {
        if (!token) {
            throw new Error('123 网盘 Token 缺失，请先登录');
        }

        const agent = ProxyUtil.getProxyAgent('pan123');
        const url = `${this.API_BASE}${apiPath.startsWith('/') ? apiPath : '/' + apiPath}`;

        const options = {
            method: method.toUpperCase(),
            headers: {
                'Authorization': `Bearer ${token}`,
                'platform': 'web',
                'app-version': '3',
                'origin': 'https://yun.123pan.com',
                'referer': 'https://yun.123pan.com/',
                'content-type': 'application/json',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent,
            timeout: { request: 15000 },
            responseType: 'json'
        };

        if (payload && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
            options.json = payload;
        }

        const res = await got(url, options);
        return res.body;
    }

    /**
     * 获取 123 网盘指定目录下的文件与文件夹列表
     */
    static async listFolder(parentId = 0, token) {
        const pId = String(parentId ?? 0);
        try {
            const qs = [
                'driveId=0',
                'limit=100',
                'next=0',
                'orderBy=update_time',
                'orderDirection=desc',
                `parentFileId=${encodeURIComponent(pId)}`,
                'trashed=false',
                'SearchData=',
                'Page=1',
                'OnlyLookAbnormalFile=0',
                'event=homeListFile',
                'operateType=1',
                'inDirectSpace=false',
                'fileCategory=0'
            ].join('&');

            const res = await this.request('GET', `/file/list?${qs}`, null, token);
            const list = res?.data?.InfoList || res?.data?.list || [];

            return list.map(item => ({
                id: item.FileId || item.fileId || item.id,
                name: item.FileName || item.fileName || item.name,
                type: (item.Type === 1 || item.type === 1) ? 'folder' : 'file',
                size: Number(item.Size || item.size || 0),
                updatedAt: item.UpdateTime || item.updateTime || item.updatedAt
            }));
        } catch (error) {
            logger.warn(`[123网盘] 列举目录 [${pId}] 异常: ${error.message}`);
            return [];
        }
    }

    /**
     * 在 123 网盘创建新目录（带幂等已存在复用检查）
     */
    static async createFolder(parentId, folderName, token) {
        const cleanName = String(folderName || '').trim();
        if (!cleanName) throw new Error('目录名称不能为空');
        const pId = String(parentId ?? 0);

        // 1. 先检查是否已存在同名目录，避免并发造成双胞胎重复目录
        const currentList = await this.listFolder(pId, token);
        const existing = currentList.find(f => f.type === 'folder' && f.name === cleanName);
        if (existing) {
            logger.debug(`[123网盘] 目标目录已存在，就地复用: ${cleanName} (ID: ${existing.id})`);
            return existing.id;
        }

        // 2. 调用 /file/upload_request 创建目录
        const res = await this.request('POST', '/file/upload_request', {
            driveId: 0,
            etag: '',
            fileName: cleanName,
            parentFileId: pId,
            size: 0,
            type: 1
        }, token);

        if (res && (res.code === 0 || res.code === 200) && res.data) {
            const newId = res.data?.Info?.FileId || res.data?.dirID || res.data?.fileId || res.data?.id;
            if (newId) return newId;
        }

        // 3. 回退再查一次以防已创建成功
        const retryList = await this.listFolder(pId, token);
        const retryHit = retryList.find(f => f.type === 'folder' && f.name === cleanName);
        if (retryHit) return retryHit.id;

        throw new Error(`创建 123 网盘目录失败: ${(res && res.message) || '未知异常'}`);
    }

    /**
     * 提交离线下载任务（支持 5252 自适应二分拆批）
     * @param {Array<{url: string, name?: string}>} items - 直链列表
     * @param {number|string} targetDirId - 123 网盘目标目录 ID
     * @param {string} token - 123 网盘 Bearer Token
     */
    static async pushOfflineBatch(items = [], targetDirId = 0, token) {
        const validItems = (Array.isArray(items) ? items : []).filter(i => i && i.url);
        if (validItems.length === 0) {
            return { success: true, count: 0, ok: [], fail: [] };
        }

        const out = { ok: [], fail: [] };
        const chunks = [];
        const step = this.DEFAULT_BATCH_SIZE;

        for (let i = 0; i < validItems.length; i += step) {
            chunks.push(validItems.slice(i, i + step));
        }

        for (const chunk of chunks) {
            const res = await this._submitChunkRecursive(chunk, targetDirId, token);
            out.ok.push(...res.ok);
            out.fail.push(...res.fail);
        }

        return {
            success: out.ok.length > 0,
            count: out.ok.length,
            ok: out.ok,
            fail: out.fail
        };
    }

    /**
     * 递归分批提交（遇 5252 自动二分重试）
     */
    static async _submitChunkRecursive(list, targetDirId, token, depth = 0) {
        const out = { ok: [], fail: [] };
        if (!list.length) return out;

        const failAll = (reason) => {
            list.forEach(item => out.fail.push({ item, reason }));
            return out;
        };

        try {
            const urls = list.map(i => i.url).join('\n');
            const resolveRes = await this.request('POST', '/v2/offline_download/task/resolve', { urls }, token);

            // 遇 5252（单次超限），二分拆分重试
            if (resolveRes && resolveRes.code === this.RESOLVE_LIMIT_CODE) {
                if (list.length === 1) {
                    return failAll('123 网盘拒绝单条提交 (code=5252)，可能是配额用尽或资源受限');
                }
                const half = Math.floor(list.length / 2);
                logger.warn(`[123离线] ${list.length} 个链接超限，二分拆分为 ${half} + ${list.length - half} 重试`);
                const left = await this._submitChunkRecursive(list.slice(0, half), targetDirId, token, depth + 1);
                const right = await this._submitChunkRecursive(list.slice(half), targetDirId, token, depth + 1);
                out.ok.push(...left.ok, ...right.ok);
                out.fail.push(...left.fail, ...right.fail);
                return out;
            }

            if (!resolveRes || resolveRes.code !== 0 || !Array.isArray(resolveRes.data?.list)) {
                return failAll(`资源解析被拒 code=${resolveRes?.code || '未知'}, msg=${resolveRes?.message || '未知'}`);
            }

            const rl = resolveRes.data.list;
            const resourceList = [];
            const accepted = [];

            list.forEach((it, idx) => {
                const info = rl[idx];
                if (!info) {
                    out.fail.push({ item: it, reason: '解析结果缺失（直链可能已失效）' });
                    return;
                }
                const fileIds = (info.files || []).map(f => f.id);
                if (!fileIds.length) {
                    out.fail.push({ item: it, reason: '解析结果中无可下载文件' });
                    return;
                }
                resourceList.push({
                    resource_id: info.id,
                    select_file_id: fileIds
                });
                accepted.push(it);
            });

            if (!resourceList.length) return out;

            const submitRes = await this.request('POST', '/v2/offline_download/task/submit', {
                resource_list: resourceList,
                upload_dir: parseInt(targetDirId, 10) || 0
            }, token);

            if (submitRes && submitRes.code === this.RESOLVE_LIMIT_CODE && accepted.length > 1) {
                const half = Math.floor(accepted.length / 2);
                const left = await this._submitChunkRecursive(accepted.slice(0, half), targetDirId, token, depth + 1);
                const right = await this._submitChunkRecursive(accepted.slice(half), targetDirId, token, depth + 1);
                out.ok.push(...left.ok, ...right.ok);
                out.fail.push(...left.fail, ...right.fail);
                return out;
            }

            if (!submitRes || submitRes.code !== 0) {
                const reason = `提交被拒 code=${submitRes?.code || '未知'}, msg=${submitRes?.message || '未知'}`;
                logger.error(`[123离线] ${reason}`);
                accepted.forEach(it => out.fail.push({ item: it, reason }));
                return out;
            }

            accepted.forEach(it => out.ok.push(it));
            return out;
        } catch (error) {
            return failAll(`请求异常: ${error.message}`);
        }
    }

    /**
     * 查询 123 网盘离线任务列表
     * @param {number} page
     * @param {number} pageSize
     * @param {string} token
     */
    static async listOfflineTasks(page = 1, pageSize = 50, token) {
        try {
            const res = await this.request('POST', '/offline_download/task/list', {
                current_page: Number(page) || 1,
                page_size: Number(pageSize) || 50,
                status_arr: [0, 1, 2, 4] // 0=下载中, 1=失败, 2=已完成, 4=排队等待中
            }, token);

            if (res && res.code === 0 && res.data) {
                return {
                    tasks: res.data.list || [],
                    total: res.data.total || 0,
                    page: Number(page) || 1
                };
            }
            return { tasks: [], total: 0, page: 1 };
        } catch (error) {
            logger.warn(`[123离线] 查询任务列表异常: ${error.message}`);
            return { tasks: [], total: 0, page: 1, error: error.message };
        }
    }

    /**
     * 删除指定的 123 离线任务
     */
    static async deleteOfflineTask(taskId, token) {
        const id = parseInt(taskId, 10);
        if (!id) return false;
        try {
            const res = await this.request('POST', '/offline_download/task/delete', {
                task_ids: [id],
                status_arr: []
            }, token);
            return Boolean(res && res.code === 0);
        } catch (error) {
            logger.warn(`[123离线] 删除任务 #${id} 失败: ${error.message}`);
            return false;
        }
    }
}

module.exports = { Pan123Service };

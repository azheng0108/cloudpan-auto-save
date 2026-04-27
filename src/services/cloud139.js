/**
 * Cloud139Service — 移动云盘（139网盘）API 封装
 * 与 Cloud189Service 结构对应，便于在任务系统中统一使用。
 *
 * 认证方式（二选一）：
 *   - account.authorization  完整的 "Basic xxxx" 头（从浏览器抓包获取）
 *   - account.cookie         浏览器 Cookie 字符串
 *   - account.phone          手机号（11位）
 *
 * 内部 API 基础地址：https://yun.139.com
 *
 * ⚠️ 带 [GUESSED] 注释的端点基于 URL 模式推断，首次使用请抓包验证。
 *    已确认仅: getDisk / getOutLink / delOutLink（来自 caiyun 脚本）
 */

'use strict';

const got = require('got');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { logTaskEvent } = require('../utils/logUtils');
const ProxyUtil = require('../utils/ProxyUtil');
const ConfigService = require('./ConfigService');
const logger = require('../utils/logger');

// ─── mcloud-sign 签名工具 ──────────────────────────────────────────────────────

const _SIGN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function _md5(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/**
 * 计算 mcloud-sign 头的哈希部分（getNewSign 算法）
 *
 * 签名过程（逆向自 app.5d1501ca.js 模块 "4f52" / getNewSign）：
 *   s = encodeURIComponent(JSON.stringify(body))
 *   s = s.split('').sort().join('')          ← 对URL编码后的所有字符排序
 *   r = md5(btoa_utf8(s))                   ← btoa_utf8 = Buffer.from(s).toString('base64')
 *   c = md5(datetime + ':' + randomStr)
 *   hash = md5(r + c).toUpperCase()
 *
 * ⚠️ 关键发现：sign 是用 **getDisk 格式** body 计算的，不是 hcy/file/list body：
 *   getDiskBody = { catalogID, sortDirection:1, startNumber:1, endNumber:100,
 *                   filterType:0, catalogSortType:0, contentSortType:0,
 *                   commonAccountInfo: { account: phone, accountType: 1 } }
 *
 * @param {object} body  - 用于签名的请求体（getDisk 格式）
 * @param {string} datetime  - 格式 "YYYY-MM-DD HH:MM:SS" (UTC+8)
 * @param {string} randomStr - 16位随机字母数字字符串
 * @returns {string}
 */
function _getNewSignHash(body, datetime, randomStr) {
    let s = '';
    if (body) {
        s = JSON.stringify(Object.assign({}, body));
        s = encodeURIComponent(s);
        s = s.split('').sort().join('');
    }
    const r = _md5(Buffer.from(s, 'utf8').toString('base64'));
    const c = _md5(datetime + ':' + randomStr);
    return _md5(r + c).toUpperCase();
}

/**
 * 格式化当前时间为 CST（UTC+8）字符串，格式 "YYYY-MM-DD HH:MM:SS"
 */
function _formatDatetimeCST() {
    const cst = new Date(Date.now() + 8 * 3600 * 1000);
    const iso = cst.toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}

/**
 * 生成 N 位随机字母数字串
 */
function _randomStr(n = 16) {
    let s = '';
    for (let i = 0; i < n; i++) s += _SIGN_CHARS[Math.floor(Math.random() * _SIGN_CHARS.length)];
    return s;
}

// ─── 端点常量 ─────────────────────────────────────────────────────────────────
const BASE_URL = 'https://yun.139.com';
const OUTLINK_V1 = `${BASE_URL}/orchestration/personalCloud-rebuild/outlink/v1.0`;
const CATALOG_V1 = `${BASE_URL}/orchestration/personalCloud/catalog/v1.0`;
const USER_NJS_URL = 'https://user-njs.yun.139.com';
const SHARE_KD_NJS_URL = 'https://share-kd-njs.yun.139.com';
const PERSONAL_KD_NJS_URL = 'https://personal-kd-njs.yun.139.com';

// 默认 headers（模拟 Web 端请求）
const DEFAULT_HEADERS = {
    'Content-Type': 'application/json',
    'x-yun-api-version': 'v1',
    'x-yun-app-channel': '10000034',
    'x-yun-channel-source': '10000034',
    'x-yun-client-info': '||9|7.14.4|edge||||linux unknow||zh-CN|||',
    'x-yun-module-type': '100',
    'x-yun-svc-type': '1',
    'mcloud-channel': '1000101',
    'mcloud-version': '7.14.4',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://yun.139.com',
    'Referer': 'https://yun.139.com/',
};

class Cloud139Service {
    static instances = new Map();
    static MAX_INSTANCES = 50; // 最大实例数
    static instanceAccess = new Map(); // 记录实例访问时间

    static _getCacheKey(account) {
        if (!account) return 'unknown';
        if (typeof account === 'number') return `id:${account}`;
        if (typeof account === 'string') {
            const text = account.trim();
            if (!text) return 'unknown';
            return text.startsWith('id:') ? text : `id:${text}`;
        }
        if (account.id !== undefined && account.id !== null) return `id:${account.id}`;
        if (account.phone) return `phone:${account.phone}`;
        if (account.username) return `user:${account.username}`;
        return 'unknown';
    }

    static _buildAuthSignature(account) {
        if (!account || typeof account !== 'object') return '';
        return [
            String(account.authorization || ''),
            String(account.cookie || ''),
            String(account.cookies || ''),
        ].join('|');
    }

    static isAuthFailure(error) {
        if (!error) return false;
        const apiCode = String(error.apiCode || '').toUpperCase();
        const statusCode = Number(error.statusCode || error.response?.statusCode || 0);
        const message = String(error.message || '').toLowerCase();
        if (apiCode === '04000005' || apiCode === '05050006' || apiCode === 'HTTP_401' || apiCode === 'HTTP_403') {
            return true;
        }
        if (statusCode === 401 || statusCode === 403) {
            return true;
        }
        return message.includes('认证失败') || message.includes('authorization') || message.includes('cookie') || message.includes('token 失效');
    }

    /**
     * 获取单例（按手机号缓存）
     * @param {object} account - DB 中的账号记录
     */
    static getInstance(account) {
        const key = this._getCacheKey(account);
        const authSignature = this._buildAuthSignature(account);
        
        // 更新访问时间
        this.instanceAccess.set(key, Date.now());
        
        if (!this.instances.has(key)) {
            // 检查实例数量，如果超过最大值，删除最旧的实例
            if (this.instances.size >= this.MAX_INSTANCES) {
                this._evictLRU();
            }
            this.instances.set(key, new Cloud139Service(account));
        } else {
            const cached = this.instances.get(key);
            if (cached && cached.authSignature !== authSignature) {
                this.instances.set(key, new Cloud139Service(account));
            }
        }
        return this.instances.get(key);
    }

    // LRU淘汰：删除最久未使用的实例
    static _evictLRU() {
        let oldestKey = null;
        let oldestTime = Infinity;
        
        for (const [key, time] of this.instanceAccess.entries()) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            logger.info(`[Cloud139Service] LRU淘汰实例: ${oldestKey}`);
            this.instances.delete(oldestKey);
            this.instanceAccess.delete(oldestKey);
        }
    }

    /**
     * 清除指定账号的实例缓存（用于 token 刷新后重建）
     */
    static clearInstance(accountOrKey) {
        if (accountOrKey === undefined || accountOrKey === null) return;
        const keys = new Set();
        const directKey = this._getCacheKey(accountOrKey);
        if (directKey) keys.add(directKey);

        if (typeof accountOrKey === 'object') {
            if (accountOrKey.username) keys.add(`user:${accountOrKey.username}`);
            if (accountOrKey.phone) keys.add(`phone:${accountOrKey.phone}`);
            if (accountOrKey.id !== undefined && accountOrKey.id !== null) keys.add(`id:${accountOrKey.id}`);
        }

        if (typeof accountOrKey === 'string') {
            const plain = accountOrKey.trim();
            if (plain) {
                keys.add(`user:${plain}`);
                keys.add(`phone:${plain}`);
            }
        }

        for (const key of keys) {
            this.instances.delete(key);
            this.instanceAccess.delete(key);
        }
    }

    // 清除所有实例
    static clearAllInstances() {
        const count = this.instances.size;
        this.instances.clear();
        this.instanceAccess.clear();
        logger.info(`[Cloud139Service] 清除了 ${count} 个实例`);
    }

    constructor(account) {
        this.phone = account.phone || account.username;
        this.authSignature = Cloud139Service._buildAuthSignature(account);

        // 构建认证头
        // 将 auth 字符串规范化为带 "Basic " 前缀的完整头值
        const _normalizeBasicAuth = (str) => /^Basic\s+/i.test(str.trim()) ? str.trim() : `Basic ${str.trim()}`;
        // 判断字符串是否为 Basic auth（带或不带 "Basic " 前缀的 base64，不含 "; " cookie 特征）
        const _isBasicAuthStr = (str) => /^Basic\s+/i.test(str.trim()) || /^[A-Za-z0-9+/]+=*$/.test(str.trim());

        const authHeaders = {};
        if (account.authorization) {
            // 兼容用户填写时不带 "Basic " 前缀的情况
            const authValue = _normalizeBasicAuth(account.authorization);
            authHeaders['Authorization'] = authValue;
            // 尝试从 Basic auth 提取手机号：Base64("pc:PHONE:token")
            if (!this.phone || this.phone.length < 11) {
                try {
                    const decoded = Buffer.from(authValue.replace(/^Basic\s+/i, ''), 'base64').toString();
                    const parts = decoded.split(':');
                    if (parts.length >= 2 && /^1\d{10}$/.test(parts[1])) this.phone = parts[1];
                } catch (_) {}
            }
        } else if (account.cookie) {
            authHeaders['Cookie'] = account.cookie;
        } else if (account.cookies) {
            // cookies 字段可能存储 "Basic xxxx" 或不带前缀的 base64 Authorization 值
            if (_isBasicAuthStr(account.cookies)) {
                const authValue = _normalizeBasicAuth(account.cookies);
                authHeaders['Authorization'] = authValue;
                // 尝试从 Basic auth 提取手机号：Base64("pc:PHONE:token")
                if (!this.phone || this.phone.length < 11) {
                    try {
                        const decoded = Buffer.from(authValue.replace(/^Basic\s+/i, ''), 'base64').toString();
                        const parts = decoded.split(':');
                        if (parts.length >= 2 && /^1\d{10}$/.test(parts[1])) this.phone = parts[1];
                    } catch (_) {}
                }
            } else {
                authHeaders['Cookie'] = account.cookies;
            }
        } else {
            throw new Error(`账号 ${this.phone} 缺少 authorization 或 cookie，请先抓包获取`);
        }

        // 创建 got 实例
        const proxyOptions = ProxyUtil.getProxy('cloud139') || {};
        this.http = got.extend({
            headers: { ...DEFAULT_HEADERS, ...authHeaders },
            timeout: 30000,
            retry: { limit: 1 },
            ...proxyOptions,
        });
        const concurrency = Number(ConfigService.getConfigValue('task.cloud139Concurrency', 3)) || 3;
        this.limit = pLimit(Math.max(1, concurrency));
    }

    /** 公共账号信息 */
    get _account() {
        return { account: this.phone, accountType: 1 };
    }

    /**
     * 调用 share-kd-njs.yun.139.com 接口（分享相关，无需 mcloud-sign）
     */
    async _shareKdNjsPost(path, body) {
        return this.limit(() => this._shareKdNjsPostImpl(path, body));
    }

    async _shareKdNjsPostImpl(path, body) {
        const SHARE_HEADERS = {
            'caller': 'web',
            'x-m4c-caller': 'PC',
            'mcloud-client': '10701',
            'mcloud-version': '7.17.2',
            'mcloud-channel': '1000101',
        };
        try {
            const res = await this.http.post(`${SHARE_KD_NJS_URL}${path}`, {
                json: body,
                headers: SHARE_HEADERS,
            }).json();
            if (res && res.code !== undefined && String(res.code) !== '0') {
                const err = new Error(`139 分享API 错误 [${res.code}]: ${res.desc || res.message || '未知错误'}`);
                err.apiCode = String(res.code);
                // 致命错误：外链不存在/被取消/用户信息查询失败等，无需重试
                const FATAL_CODES = new Set([
                    '200000727', // 外链不存在/外链被分享者取消
                    '200000401', // 外链已过期
                    '200000402', // 外链已达到访问次数上限
                    '05010003',  // 查询不到用户信息（分享者账号异常）
                    '04000005',  // 认证失败
                    '05050006',  // token失效
                ]);
                err.fatal = FATAL_CODES.has(err.apiCode);
                if (err.apiCode === '04000005' || err.apiCode === '05050006') {
                    err.statusCode = 401;
                }
                throw err;
            }
            return (res && res.data !== undefined) ? res.data : res;
        } catch (err) {
            if (err.apiCode !== undefined) throw err;
            if (err.name === 'HTTPError') {
                const statusCode = err.response?.statusCode;
                if (statusCode === 401 || statusCode === 403) {
                    const authErr = new Error(`139 分享接口认证失败: HTTP ${statusCode}`);
                    authErr.apiCode = statusCode === 401 ? 'HTTP_401' : 'HTTP_403';
                    authErr.statusCode = statusCode;
                    authErr.fatal = true;
                    throw authErr;
                }
            }
            logTaskEvent(`请求移动云盘 share-kd-njs 接口异常: ${err.message}`);
            return null;
        }
    }

    /**
     * 调用 user-njs.yun.139.com 接口（不同 host，需额外 mcloud 头）
     */
    async _userNjsPost(path, body) {
        return this.limit(() => this._userNjsPostImpl(path, body));
    }

    async _userNjsPostImpl(path, body) {
        const USER_NJS_HEADERS = {
            'caller': 'web',
            'x-m4c-caller': 'PC',
            'x-m4c-src': '10002',
            'x-inner-ntwk': '2',
            'mcloud-route': '001',
            'mcloud-version': '7.17.2',
            'mcloud-channel': '1000101',
            'mcloud-client': '10701',
            'INNER-HCY-ROUTER-HTTPS': '1',
        };
        try {
            const res = await this.http.post(`${USER_NJS_URL}${path}`, {
                json: body,
                headers: USER_NJS_HEADERS,
            }).json();
            if (res && res.code !== undefined && String(res.code) !== '0000' && String(res.code) !== '0') {
                const err = new Error(`[139] user-njs 接口错误 [${res.code}]: ${res.desc || res.message || '未知错误'}`);
                err.apiCode = String(res.code);
                if (err.apiCode === '04000005' || err.apiCode === '05050006') {
                    err.statusCode = 401;
                    err.fatal = true;
                }
                throw err;
            }
            return (res && res.data !== undefined) ? res.data : res;
        } catch (err) {
            if (err.apiCode !== undefined) throw err;
            if (err.name === 'HTTPError') {
                const statusCode = err.response?.statusCode;
                if (statusCode === 401 || statusCode === 403) {
                    const authErr = new Error(`139 user-njs 接口认证失败: HTTP ${statusCode}`);
                    authErr.apiCode = statusCode === 401 ? 'HTTP_401' : 'HTTP_403';
                    authErr.statusCode = statusCode;
                    authErr.fatal = true;
                    throw authErr;
                }
            }
            logTaskEvent(`请求移动云盘 user-njs 接口异常: ${err.message}`);
            return null;
        }
    }

    /**
     * 会员等级 → 名称映射
     * memberLevel 由 /user/getUser 接口的 auth.memberLevel 字段返回
     *   0 = 普通用户, 1 = 白金会员, 2 = 金牌会员, 3 = 钻石会员
     */
    static _memberLevelName(level) {
        const MAP = { 0: '普通', 1: '白银', 2: '黄金', 3: '钻石' };
        return MAP[level] ?? (level != null ? `会员${level}` : null);
    }

    /**
     * 获取账号容量信息（个人云盘）
     * 返回与 Cloud189 兼容的格式，供 index.js 统一展示
     * 同时附带会员信息 memberInfo: { memberName, memberLevel }
     * @returns {{ res_code: number, cloudCapacityInfo: {usedSize, totalSize}, familyCapacityInfo: {usedSize, totalSize}, memberInfo: object|null }|null}
     */
    async getUserSizeInfo() {
        try {
            // 1. 获取 userDomainId
            const userInfo = await this._userNjsPost('/user/getUser', {});
            if (!userInfo || !userInfo.userDomainId) return null;
            const { userDomainId } = userInfo;

            // 2. 获取个人磁盘信息（diskSize / freeDiskSize 单位: MB）
            const diskData = await this._userNjsPost('/user/disk/getPersonalDiskInfo', { userDomainId });
            if (!diskData) return null;

            const totalMB = parseInt(diskData.diskSize) || 0;
            const freeMB = parseInt(diskData.freeDiskSize) || 0;
            const usedMB = totalMB - freeMB;
            const MB = 1024 * 1024;

            // 3. 获取会员等级（来自 queryUserBenefits 接口）
            let memberInfo = null;
            try {
                const benefitData = await this._post(
                    `${BASE_URL}/orchestration/group-rebuild/member/v1.0/queryUserBenefits`,
                    { isNeedBenefit: 1, commonAccountInfo: { account: this.phone, accountType: 1 } }
                );
                const sub = benefitData?.userSubMemberList?.[0];
                if (sub && sub.memberLevel != null) {
                    memberInfo = {
                        memberLevel: sub.memberLevel,
                        memberName: Cloud139Service._memberLevelName(sub.memberLevel),
                    };
                }
            } catch (_) { /* 会员查询失败不影响容量显示 */ }

            return {
                res_code: 0,
                cloudCapacityInfo: {
                    usedSize: usedMB * MB,
                    totalSize: totalMB * MB,
                },
                familyCapacityInfo: { usedSize: 0, totalSize: 0 },
                memberInfo,
            };
        } catch (err) {
            logTaskEvent(`获取移动云盘容量失败: ${err.message}`);
            return null;
        }
    }


    async _post(url, body) {
        return this.limit(() => this._postImpl(url, body));
    }

    async _postImpl(url, body) {
        try {
            const res = await this.http.post(url, { json: body }).json();
            // 内部 API 通常在顶层返回 code 字段（可能是数字或字符串）
            if (res && res.code !== undefined && String(res.code) !== '0') {
                const err = new Error(`139 API 错误 [${res.code}]: ${res.message || '未知错误'}`);
                err.apiCode = String(res.code);
                if (err.apiCode === '04000005' || err.apiCode === '05050006') {
                    err.statusCode = 401;
                    err.fatal = true;
                }
                throw err;
            }
            // 实际数据可能包裹在 data 字段中
            return (res && res.data !== undefined) ? res.data : res;
        } catch (err) {
            if (err.apiCode !== undefined) throw err;
            if (err.name === 'HTTPError') {
                const statusCode = err.response?.statusCode;
                if (statusCode === 401 || statusCode === 403) {
                    const authErr = new Error(`139 接口认证失败: HTTP ${statusCode}`);
                    authErr.apiCode = statusCode === 401 ? 'HTTP_401' : 'HTTP_403';
                    authErr.statusCode = statusCode;
                    authErr.fatal = true;
                    throw authErr;
                }
                logTaskEvent(`请求移动云盘接口失败: HTTP ${err.response?.statusCode} ${url}`);
            } else if (err.name === 'TimeoutError') {
                logTaskEvent(`请求移动云盘接口超时: ${url}`);
            } else {
                logTaskEvent(`请求移动云盘接口异常: ${err.message}`);
            }
            return null;
        }
    }

    // ─── 外链（分享）相关 ────────────────────────────────────────────────────

    /**
     * 获取分享目录/文件列表
     * [GUESSED] 端点未经抓包验证
     *
     * @param {string} linkID - 外链 ID（如 "zy0DDGAkum96"）
     * @param {string} passwd - 外链密码（无密码传空字符串）
     * @param {string} [pCaID='root'] - 当前目录 ID，根目录传 'root'
     * @param {number} [startNum=1]
     * @param {number} [endNum=200]
     * @returns {Promise<{nodNum, caLst, coLst, lkName, expireTime, ...}|null>}
     */
    async getShareInfo(linkID, passwd = '', pCaID = 'root', startNum = 1, endNum = 200) {
        const res = await this._shareKdNjsPost('/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6', {
            getOutLinkInfoReq: {
                account: this.phone || '',
                linkID,
                passwd: passwd || '',
                pCaID,
                caSrt: 0,
                coSrt: 0,
                srtDr: 1,
                bNum: startNum,
                eNum: endNum,
            },
        });
        // V6 接口直接在 data 层返回 nodNum/caLst/coLst 等字段
        return res || null;
    }

    /**
     * 获取分享目录下的文件列表（分页）
     * 这是 listShareDir 的 139 等价物，返回结构与 cloud189 类似。
     *
     * @param {string} linkID
     * @param {string} passwd
     * @param {string} pCaID - 当前目录 ID
     * @returns {Promise<{fileList: object[], folderList: object[], total: number}|null>}
     */
    async listShareDir(linkID, passwd, pCaID = 'root') {
        const info = await this.getShareInfo(linkID, passwd, pCaID, 1, 200);
        if (!info) return null;
        return {
            fileList: info.coLst ?? [],
            folderList: info.caLst ?? [],
            total: info.nodNum ?? 0,
            linkName: info.lkName,
            expireTime: info.expireTime,
        };
    }

    /**
     * 递归列出分享中的所有文件（扁平化）
     *
     * @param {string} linkID
     * @param {string} passwd
     * @param {string} [pCaID='root']
     * @returns {Promise<Array<{contentID, contentName, contentSize, updateTime, pCaID}>>}
     */
    async listAllShareFiles(linkID, passwd, pCaID = 'root') {
        const all = [];
        const PAGE = 200;
        const fetchPage = async (dirID, start = 1) => {
            const info = await this.getShareInfo(linkID, passwd, dirID, start, start + PAGE - 1);
            if (!info) return;
            for (const f of (info.coLst ?? [])) all.push({ ...f, pCaID: dirID });
            for (const d of (info.caLst ?? [])) await fetchPage(d.catalogID ?? d.caID);
            const total = info.nodNum ?? 0;
            if (start + PAGE - 1 < total) await fetchPage(dirID, start + PAGE);
        };
        await fetchPage(pCaID);
        return all;
    }

    /**
     * 递归列出分享中的所有文件，同时返回目录层级映射（用于保留子目录结构）
     * @returns {Promise<{files: Array, catalogMap: Object}>}
     *   catalogMap: { caID: { name, parentCaID } }
     */
    async listAllShareFilesWithFolderMap(linkID, passwd, pCaID = 'root') {
        const all = [];
        const catalogMap = {};
        const PAGE = 200;
        const fetchPage = async (dirID, start = 1) => {
            const info = await this.getShareInfo(linkID, passwd, dirID, start, start + PAGE - 1);
            if (!info) return;
            for (const f of (info.coLst ?? [])) all.push({ ...f, pCaID: dirID });
            for (const d of (info.caLst ?? [])) {
                const id = String(d.catalogID ?? d.caID);
                catalogMap[id] = { name: d.catalogName ?? d.caName ?? id, parentCaID: String(dirID) };
                await fetchPage(id);
            }
            const total = info.nodNum ?? 0;
            if (start + PAGE - 1 < total) await fetchPage(dirID, start + PAGE);
        };
        await fetchPage(pCaID);
        return { files: all, catalogMap };
    }

    /**
     * 转存外链文件到目标目录（createOuterLinkBatchOprTask）
     * 通过 share-kd-njs 接口，无需 mcloud-sign！
     *
     * @param {string} linkID - 分享链接 ID
     * @param {string[]} coPathLst - 要转存的文件 path 列表（来自分享列表的 path 字段，格式：parentID/fileID）
     * @param {string[]} caPathLst - 要转存的目录 path 列表（来自分享列表的 path 字段）
     * @param {string} targetCatalogID - 目标目录 ID
     * @param {boolean} [needPassword=false] - 分享链接是否需要密码
     * @returns {Promise<{taskID, ...}|null>}
     */
    async saveShareFiles(linkID, coPathLst = [], caPathLst = [], targetCatalogID = '', needPassword = false) {
        const res = await this._shareKdNjsPost('/yun-share/richlifeApp/devapp/IBatchOprTask/createOuterLinkBatchOprTask', {
            createOuterLinkBatchOprTaskReq: {
                msisdn: this.phone || '',
                ownerAccount: '',
                taskType: 1,
                linkID,
                needPassword,
                taskInfo: {
                    linkID,
                    needPassword,
                    contentInfoList: coPathLst,
                    catalogInfoList: caPathLst,
                    newCatalogID: targetCatalogID,
                },
            },
        });
        return res || null;
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    _computeBackoffMs(baseMs, attempt) {
        const jitter = Math.floor(Math.random() * 150);
        return Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)) + jitter, 10000);
    }

    _isRetryableError(error) {
        if (!error) return true;
        if (error.fatal) return false;
        if (error.name === 'TimeoutError') return true;
        const statusCode = error.response?.statusCode;
        if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) return true;
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('timeout') || msg.includes('429') || msg.includes('network')) return true;
        return false;
    }

    async saveShareFilesWithRetry(linkID, coPathLst = [], caPathLst = [], targetCatalogID = '', needPassword = false, options = {}) {
        const maxAttempts = Number(options.maxAttempts || 3);
        const baseDelayMs = Number(options.baseDelayMs || 600);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await this.saveShareFiles(linkID, coPathLst, caPathLst, targetCatalogID, needPassword);
                if (res) {
                    if (attempt > 1) {
                        logTaskEvent(`[139] 转存任务重试成功: attempt=${attempt}, target=${targetCatalogID}`);
                    }
                    return res;
                }
                if (attempt === maxAttempts) {
                    throw new Error('转存接口返回空结果');
                }
                const waitMs = this._computeBackoffMs(baseDelayMs, attempt);
                logTaskEvent(`[139] 转存任务返回空，准备重试: attempt=${attempt}/${maxAttempts}, wait=${waitMs}ms`);
                await this._sleep(waitMs);
            } catch (error) {
                const retryable = this._isRetryableError(error);
                if (!retryable || attempt === maxAttempts) {
                    throw error;
                }
                const waitMs = this._computeBackoffMs(baseDelayMs, attempt);
                logTaskEvent(`[139] 转存任务失败，重试中: attempt=${attempt}/${maxAttempts}, reason=${error.message}, wait=${waitMs}ms`);
                await this._sleep(waitMs);
            }
        }

        return null;
    }

    async waitForFilesVisible(targetCatalogID, expectedFileNames = [], options = {}) {
        const normalized = [...new Set((expectedFileNames || []).filter(Boolean))];
        if (normalized.length === 0) {
            return { allVisible: true, visibleCount: 0, missing: [] };
        }

        const timeoutMs = Number(options.timeoutMs || 30000);
        const intervalMs = Number(options.intervalMs || 1500);
        const startedAt = Date.now();
        let lastNames = new Set();
        let pollCount = 0;

        while (Date.now() - startedAt <= timeoutMs) {
            pollCount += 1;
            const files = await this.listAllDiskFiles(targetCatalogID).catch(() => []);
            lastNames = new Set(files.map((f) => f.name));
            const missing = normalized.filter((name) => !lastNames.has(name));
            if (missing.length === 0) {
                logTaskEvent(`[139] 可见性校验通过: catalog=${targetCatalogID}, expected=${normalized.length}, polls=${pollCount}, elapsedMs=${Date.now() - startedAt}`);
                return { allVisible: true, visibleCount: normalized.length, missing: [] };
            }
            await this._sleep(intervalMs);
        }

        const missing = normalized.filter((name) => !lastNames.has(name));
        logTaskEvent(
            `[139] 可见性校验超时: catalog=${targetCatalogID}, expected=${normalized.length}, visible=${normalized.length - missing.length}, missing=${missing.length}, polls=${pollCount}, elapsedMs=${Date.now() - startedAt}, missingSample=${missing.slice(0, 5).join('|')}`
        );
        return {
            allVisible: false,
            visibleCount: normalized.length - missing.length,
            missing,
        };
    }

    // ─── 个人网盘 ─────────────────────────────────────────────────────────────

    /**
     * 获取个人网盘目录内容
     * [CONFIRMED URL from caiyun 脚本]
     *
     * @param {string} catalogID - 目录 ID
     * @param {number} [startNum=1]
     * @param {number} [endNum=100]
     * @returns {Promise<{catalogList, contentList, nodeCount}|null>}
     */
    async getDiskFiles(catalogID, startNum = 1, endNum = 100) {
        const res = await this._post(`${CATALOG_V1}/getDisk`, {
            commonAccountInfo: this._account,
            catalogID,
            catalogType: -1,
            sortDirection: 1,
            catalogSortType: 0,
            contentSortType: 0,
            filterType: 0,
            startNumber: startNum,
            endNumber: endNum,
        });
        return res ? (res.getDiskResult ?? null) : null;
    }

    /**
     * 移动文件/目录到目标目录（moveContentCatalog）
     * [GUESSED] 端点未经抓包验证
     *
     * @param {string[]} contentInfoList - 文件 ID 列表
     * @param {string[]} catalogInfoList - 目录 ID 列表
     * @param {string} newCatalogID - 目标目录 ID
     */
    async moveFiles(contentInfoList, catalogInfoList, newCatalogID) {
        const res = await this._post(`${CATALOG_V1}/moveContentCatalog`, {
            moveContentCatalogReq: {
                contentInfoList,
                catalogInfoList,
                newCatalogID,
                commonAccountInfo: this._account,
            },
        });
        return res ? (res.moveContentCatalogRes ?? null) : null;
    }

    /**
     * 创建目录（createCatalogExt）
     * [GUESSED] 端点未经抓包验证
     *
     * @param {string} catalogName
     * @param {string} parentCatalogID
     */
    async createFolder(catalogName, parentCatalogID) {
        const res = await this._post(`${CATALOG_V1}/createCatalogExt`, {
            createCatalogExtReq: {
                newCatalogName: catalogName,
                parentCatalogID,
                commonAccountInfo: this._account,
            },
        });
        // JSON API 直接在顶层返回 catalogInfo（XML 文档确认字段名）
        return res ? (res.catalogInfo ?? res.createCatalogExtRes ?? null) : null;
    }

    /**
     * 删除文件/目录（batchTrash to recyclebin）
     * 已通过抓包确认：POST /hcy/recyclebin/batchTrash
     * body: { fileIds: ["fileId1", "fileId2", ...] }
     * 返回 taskId，需轮询 /hcy/task/get 确认完成
     *
     * @param {string[]} fileIds - 文件或目录的 fileId 列表（统一格式，不区分文件/目录）
     * @returns {Promise<boolean>} 删除是否成功
     */
    async deleteFiles(fileIds = []) {
        if (!fileIds.length) return true;
        // 使用 HCY private API 路径，需要 mcloud-sign
        const res = await this._personalKdNjsPost('/hcy/recyclebin/batchTrash', { fileIds }, '/');
        if (!res) return false;
        const taskId = res.taskId ?? res.taskID;
        if (!taskId) {
            // 某些情况下直接成功，无需轮询
            return true;
        }
        // 轮询任务状态（最多等 10 秒）
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const taskRes = await this._personalKdNjsPost('/hcy/task/get', { taskId }, '/').catch(() => null);
            if (!taskRes) break;
            const status = taskRes.status ?? taskRes.taskStatus;
            if (status === 'success' || status === 2 || status === '2') return true;
            if (status === 'failed' || status === 3 || status === '3') {
                logTaskEvent(`[139] 删除任务失败: taskId=${taskId}`);
                return false;
            }
        }
        return true; // 超时也认为成功（已移入回收站）
    }

    // ─── 高级封装：完整转存流程 ───────────────────────────────────────────────

    /**
     * 一键将外链文件转存到用户指定目录（通过 createOuterLinkBatchOprTask 直接保存，无需沙箱）
     *
     * @param {object} opts
     * @param {string} opts.linkID
     * @param {string[]} opts.coPathLst - 文件 path 列表（caLst/coLst 中的 path 字段）
     * @param {string[]} opts.caPathLst - 目录 path 列表
     * @param {string} opts.targetCatalogID - 目标目录 ID
     * @param {boolean} [opts.needPassword=false]
     * @returns {Promise<{taskID: string, targetCatalogID: string}>}
     */
    async saveAndMove({ linkID, coPathLst = [], caPathLst = [], targetCatalogID, needPassword = false }) {
        const res = await this.saveShareFiles(linkID, coPathLst, caPathLst, targetCatalogID, needPassword);
        if (!res) {
            throw new Error('createOuterLinkBatchOprTask 返回空结果');
        }
        const taskID = res.taskID || res.createOuterLinkBatchOprTaskRes?.taskID;
        logTaskEvent(`[139] 转存任务已创建: taskID=${taskID}，目标目录: ${targetCatalogID}`);
        return { taskID, targetCatalogID };
    }

    // ─── 更新检测 ─────────────────────────────────────────────────────────────

    /**
     * 检测分享链接是否有新文件
     *
     * @param {string} linkID
     * @param {string} passwd
     * @param {object} lastState
     * @param {number} lastState.nodNum    上次 nodNum
     * @param {string[]} lastState.fileIDs 上次已知文件 ID 列表
     * @returns {Promise<{hasUpdate, newNodNum, newFiles, newFileIDs, linkInfo}>}
     */
    async detectUpdates(linkID, passwd, lastState = {}) {
        const { nodNum: lastNodNum = 0, fileIDs: lastFileIDs = [] } = lastState;
        const knownIDs = new Set(lastFileIDs);

        // 快速检测：只拉根目录的 nodNum
        const rootInfo = await this.getShareInfo(linkID, passwd, 'root', 1, 1);
        if (!rootInfo) {
            return { hasUpdate: false, newNodNum: lastNodNum, newFiles: [], newFileIDs: [], linkInfo: null };
        }
        const newNodNum = rootInfo.nodNum ?? 0;

        if (newNodNum <= lastNodNum && knownIDs.size > 0) {
            return { hasUpdate: false, newNodNum, newFiles: [], newFileIDs: [], linkInfo: rootInfo };
        }

        // 有变化：拉完整文件列表
        const allFiles = await this.listAllShareFiles(linkID, passwd);
        const newFiles = allFiles.filter(f => !knownIDs.has(f.contentID));

        return {
            hasUpdate: newFiles.length > 0 || newNodNum > lastNodNum,
            newNodNum,
            newFileIDs: newFiles.map(f => f.contentID),
            newFiles,
            linkInfo: rootInfo,
        };
    }

    /**
     * 用于测试：验证认证和分享链接是否有效
     *
     * @param {string} linkID
     * @param {string} passwd
     * @returns {Promise<{valid: boolean, lkName: string, nodNum: number, error?: string}>}
     */
    async testConnection(linkID, passwd = '') {
        try {
            const info = await this.getShareInfo(linkID, passwd, 'root', 1, 1);
            if (!info) return { valid: false, error: '无法获取分享信息，请检查 auth/cookie 和网络' };
            return { valid: true, lkName: info.lkName, nodNum: info.nodNum ?? 0 };
        } catch (e) {
            return { valid: false, error: e.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 分享订阅列表（需抓包验证）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 获取当前账号在 139 App 中「分享订阅」列表。
     *
     * ⚠️  端点 URL 尚未验证，需要抓包确认。
     *
     * 【抓包方法】：
     *   1. 打开 https://yun.139.com，登录账号
     *   2. F12 → Network → 筛选 Fetch/XHR
     *   3. 点击「最近」→「分享订阅」标签
     *   4. 观察发出的 POST 请求，找到包含 subscribe / focus 字样的接口
     *   5. 将真实 URL 末段（端点名）填入下方 ENDPOINT 常量
     *
     * 【候选端点名】（按可能性排序）：
     *   - getOutLinkSubscribeList
     *   - getUserSubscribeOutLink
     *   - querySubscribeOutLink
     *   - getMySubscribeOutLink
     *   - getFocusOutLinkList
     *
     * @param {number} [pageNum=1]
     * @param {number} [pageSize=100]
     * @returns {Promise<Array<{linkID, lkName, passwd, opName, lastUdTime, newFileCnt}>>}
     */
    async getSubscribeList(pageNum = 1, pageSize = 100) {
        // TODO: 抓包后将 'UNKNOWN_ENDPOINT' 替换为真实端点名
        const ENDPOINT = 'UNKNOWN_ENDPOINT';
        if (ENDPOINT === 'UNKNOWN_ENDPOINT') {
            throw new Error(
                '「分享订阅」列表接口尚未抓包确认。\n' +
                '请参考 README.md「抓包指引」章节或 getSubscribeList() 方法注释，\n' +
                '完成抓包后将真实端点名填入 ENDPOINT 常量。'
            );
        }

        const res = await this._post(`${OUTLINK_V1}/${ENDPOINT}`, {
            commonAccountInfo: this._account,
            pageNum,
            pageSize,
        });

        // 响应字段名需抓包后按实际情况调整
        return res?.subscribeList ?? res?.outLinkList ?? res?.linkList ?? [];
    }

    /**
     * 从「分享订阅」列表批量导入任务对象（可直接写入 taskStore）。
     *
     * @param {string} targetCatalogID - 默认保存目标目录 ID
     * @param {string} [cronExpr='0 *\/6 * * *'] - 默认轮询周期
     * @returns {Promise<Array<{linkID, passwd, linkName, targetCatalogID, cronExpr}>>}
     */
    async importSubscribeLinks(targetCatalogID, cronExpr = '0 */6 * * *') {
        const list = await this.getSubscribeList();
        return list.map(item => ({
            linkID: item.linkID ?? item.lkID ?? item.outLinkID,
            passwd: item.passwd ?? item.lkPasswd ?? '',
            linkName: item.lkName ?? item.linkName ?? '',
            targetCatalogID,
            cronExpr,
        }));
    }

    // ─── personal-kd-njs（HCY 新接口，需要 mcloud-sign）─────────────────────

    /**
     * 计算 mcloud-sign 头的完整值。
     *
     * 关键：sign 哈希使用的是「getDisk 格式」body 而非 hcy 格式 body
     * （逆向自浏览器 URL 重写拦截器：app 先用 getDisk body 计算 sign，
     *  再由拦截器将 URL + body 改写为 hcy 格式，sign 保持不变随新请求发出）
     *
     * @param {string} catalogID - 目标目录 ID（根目录传 "/"）
     * @returns {string}  "datetime,randomStr,hash"
     */
    _computeMcloudSign(catalogID) {
        const datetime = _formatDatetimeCST();
        const randomStr = _randomStr(16);
        const getDiskBody = {
            catalogID: catalogID || '/',
            sortDirection: 1,
            startNumber: 1,
            endNumber: 100,
            filterType: 0,
            catalogSortType: 0,
            contentSortType: 0,
            commonAccountInfo: this._account,
        };
        const hash = _getNewSignHash(getDiskBody, datetime, randomStr);
        return `${datetime},${randomStr},${hash}`;
    }

    /**
     * 向 personal-kd-njs.yun.139.com 发送带 mcloud-sign 的 POST 请求。
     *
     * @param {string} path  - 如 "/hcy/file/list"
     * @param {object} body  - hcy 格式请求体
     * @param {string} signCatalogID - 用于计算 sign 的目录 ID（getDisk body 的 catalogID）
     * @returns {Promise<object|null>}
     */
    async _personalKdNjsPost(path, body, signCatalogID) {
        return this.limit(() => this._personalKdNjsPostImpl(path, body, signCatalogID));
    }

    async _personalKdNjsPostImpl(path, body, signCatalogID) {
        const sign = this._computeMcloudSign(signCatalogID);
        const hcyHeaders = {
            'caller': 'web',
            'mcloud-version': '7.17.2',
            'mcloud-channel': '1000101',
            'mcloud-client': '10701',
            'mcloud-route': '001',
            'mcloud-sign': sign,
            'INNER-HCY-ROUTER-HTTPS': '1',
            'x-m4c-caller': 'PC',
            'x-m4c-src': '10002',
            'x-inner-ntwk': '2',
            'x-yun-channel-source': '10000034',
            'x-huawei-channelSrc': '10000034',
            'x-yun-svc-type': '1',
            'x-SvcType': '1',
            'x-yun-module-type': '100',
            'x-yun-app-channel': '10000034',
            'x-yun-api-version': 'v1',
            'x-yun-client-info': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
            'X-Deviceinfo': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
            'CMS-DEVICE': 'default',
        };
        try {
            const res = await this.http.post(`${PERSONAL_KD_NJS_URL}${path}`, {
                json: body,
                headers: hcyHeaders,
            }).json();
            if (!res.success && String(res.code) !== '0000' && String(res.code) !== '0') {
                const msg = `[139] personal-kd-njs 接口错误 [${res.code}]: ${res.desc || res.message || ''}`;
                logTaskEvent(msg);
                const apiError = new Error(msg);
                apiError.apiCode = String(res.code);
                if (apiError.apiCode === '04000005' || apiError.apiCode === '05050006') {
                    apiError.statusCode = 401;
                    apiError.fatal = true;
                }
                throw apiError;
            }
            return res.data ?? res;
        } catch (err) {
            if (err.name === 'HTTPError') {
                const statusCode = err.response?.statusCode;
                if (statusCode === 401 || statusCode === 403) {
                    const msg = `[139] 请求接口认证失败: HTTP ${statusCode} ${path}`;
                    logTaskEvent(msg);
                    const authErr = new Error(msg);
                    authErr.apiCode = statusCode === 401 ? 'HTTP_401' : 'HTTP_403';
                    authErr.statusCode = statusCode;
                    authErr.fatal = true;
                    throw authErr;
                }
                const responseBody = await err.response?.text?.().catch(() => '');
                const msg = `[139] 请求接口失败: HTTP ${statusCode} ${path} body=${responseBody?.slice(0, 200)}`;
                logTaskEvent(msg);
                throw new Error(msg);
            }
            throw err;
        }
    }

    /**
    /**
     * 在指定目录下创建文件夹（使用 HCY 私有接口，与 listDiskDir 同系 API）
     * @param {string} parentFileId - 父目录 fileId，根目录传 "/"
     * @param {string} folderName   - 新文件夹名称
     * @returns {Promise<{fileId: string, name: string}|null>}
     */
    async createFolderHcy(parentFileId, folderName) {
        const catalogID = parentFileId || '/';
        const body = { parentFileId: catalogID, name: folderName, type: 'folder' };
        const data = await this._personalKdNjsPost('/hcy/file/create', body, catalogID);
        if (!data) return null;
        return {
            fileId: data.fileId ?? data.id,
            name: data.fileName ?? data.name ?? folderName,
            parentFileId: data.parentFileId ?? catalogID,
        };
    }

    /**
     * 列出个人网盘目录内容（使用新版 hcy/file/list 接口）
     *
     * @param {string} parentFileId - 目录 ID，根目录传 "/" 或空字符串
     * @returns {Promise<{items: Array<{fileId, name, type, size, updatedAt}>, nextCursor}|null>}
     */
    async listDiskDir(parentFileId = '/') {
        const catalogID = parentFileId || '/';
        const hcyBody = {
            pageInfo: { pageSize: 100, pageCursor: null },
            orderBy: 'updated_at',
            orderDirection: 'DESC',
            parentFileId: catalogID,
            imageThumbnailStyleList: ['Small', 'Large'],
        };
        const data = await this._personalKdNjsPost('/hcy/file/list', hcyBody, catalogID);
        if (!data) throw new Error(`listDiskDir: API 返回空数据 (catalogID=${catalogID})`);

        // 响应结构: { items: [{fileId, name, fileExtension, size, category, parentFileId, type, ...}] }
        const items = data.items ?? data.fileList ?? [];
        return {
            items: items.map(f => ({
                fileId: f.fileId,
                name: f.name,
                parentFileId: f.parentFileId,
                // 仅凭 fileType/category 判断类型，不依赖 fileExtension
                // （压缩包等非媒体文件的 fileExtension 字段在 139 API 中可能为空）
                type: f.fileType === 'folder' || f.category === 'folder' ? 'folder' : 'file',
                extension: (f.fileExtension || '').toLowerCase(),
                size: f.size,
                updatedAt: f.updatedAt,
            })),
            // 139 API 的翻页游标在 data 根节点，pageInfo 作为兼容兜底
            nextCursor: data.nextPageCursor ?? data.pageInfo?.nextPageCursor ?? null,
        };
    }

    /**
     * 分页列出磁盘目录下的所有文件（扁平，不递归子目录）
     * @param {string} folderId
     * @returns {Promise<Array<{fileId, name}>>}
     */
    async listAllDiskFiles(folderId) {
        const allFiles = [];
        let cursor = null;
        let lastFirstId = null;
        let repeatedFirstPageCount = 0;
        let pageCount = 0;
        const seenCursor = new Set();
        const seenFileKeys = new Set();
        const catalogID = folderId || '/';
        const maxScanMs = Number(ConfigService.getConfigValue('task.cloud139ListMaxScanMs', 60000)) || 60000;
        const configuredRepeatThreshold = Number(ConfigService.getConfigValue('task.cloud139ListRepeatPageThreshold', 3));
        const maxRepeatedPages = Number.isFinite(configuredRepeatThreshold) && configuredRepeatThreshold > 0
            ? Math.floor(configuredRepeatThreshold)
            : 3;
        const scanStartAt = Date.now();
        let terminationReason = 'completed';
        do {
            if (Date.now() - scanStartAt > maxScanMs) {
                terminationReason = 'timeout';
                logTaskEvent(`[139] listAllDiskFiles 扫描超时，停止翻页: 目录=${catalogID}, 已耗时=${Date.now() - scanStartAt}ms`);
                break;
            }

            const cursorKey = String(cursor || '__FIRST_PAGE__');
            if (seenCursor.has(cursorKey)) {
                terminationReason = 'duplicate-cursor';
                logTaskEvent(`[139] listAllDiskFiles 检测到重复游标，停止翻页: ${cursorKey}`);
                break;
            }
            seenCursor.add(cursorKey);

            const body = {
                pageInfo: { pageSize: 100, pageCursor: cursor },
                orderBy: 'updated_at',
                orderDirection: 'DESC',
                parentFileId: catalogID,
            };
            const data = await this._personalKdNjsPost('/hcy/file/list', body, catalogID).catch(() => null);
            if (!data) {
                terminationReason = 'api-empty';
                break;
            }
            const items = data.items ?? data.fileList ?? [];
            if (!items.length) {
                terminationReason = 'no-items';
                break;
            }
            pageCount += 1;

            // 139 API 偶发游标异常导致重复页，允许少量重复后再断路。
            const currFirstId = items[0].fileId || items[0].id;
            if (lastFirstId === currFirstId) {
                repeatedFirstPageCount += 1;
                if (repeatedFirstPageCount >= maxRepeatedPages) {
                    terminationReason = 'repeated-page';
                    logTaskEvent(`[139] listAllDiskFiles 连续命中重复页(${repeatedFirstPageCount}/${maxRepeatedPages})，跳出翻页`);
                    break;
                }
            } else {
                repeatedFirstPageCount = 0;
            }
            lastFirstId = currFirstId;

            for (const f of items) {
                // 只收集文件，不含文件夹
                // 去除 && f.fileExtension 条件：压缩包等文件在 139 API 中 fileExtension 可能为空，
                // 若以此判断会导致磁盘已有压缩包无法计入去重名单，引发重复转存
                if (f.fileType !== 'folder' && f.category !== 'folder' && f.name) {
                    const fileKey = `${String(f.fileId || '').trim()}::${String(f.name || '').trim()}`;
                    if (!fileKey || seenFileKeys.has(fileKey)) continue;
                    seenFileKeys.add(fileKey);
                    allFiles.push({ fileId: f.fileId, name: f.name });
                }
            }

            // 139 API 实际把 nextPageCursor 放在 data 根节点，pageInfo 仅作兼容兜底
            cursor = data.nextPageCursor ?? data.pageInfo?.nextPageCursor ?? null;
        } while (cursor);
        logTaskEvent(`[139] listAllDiskFiles 扫描完成: 目录=${catalogID}, 页数=${pageCount}, 文件数=${allFiles.length}, 游标数=${seenCursor.size}, 终止原因=${terminationReason}`);
        return allFiles;
    }

    /**
     * 在指定目录下按名称查找文件夹，支持分页遍历（解决 listDiskDir 仅返回首页 100 条导致漏查的问题）。
     * 当目标目录子文件夹数量超过 100 时，原 listDiskDir 只检查首页，找不到已有同名目录，
     * 最终调 createFolderHcy 时 139 API 自动给文件夹追加时间戳+随机后缀，造成重复目录堆积。
     *
     * @param {string} parentFileId - 父目录 ID
     * @param {string} folderName   - 目标文件夹名称（精确匹配，忽略首尾空格）
     * @returns {Promise<string|null>} 找到则返回 fileId，否则返回 null
     */
    async findFolderByName(parentFileId, folderName) {
        let cursor = null;
        let lastFirstId = null; // 防死循环锁：避免分页游标失效导致无限循环
        const catalogID = parentFileId || '/';
        const targetName = (folderName || '').trim();
        do {
            const body = {
                pageInfo: { pageSize: 100, pageCursor: cursor },
                orderBy: 'updated_at',
                orderDirection: 'DESC',
                parentFileId: catalogID,
            };
            const data = await this._personalKdNjsPost('/hcy/file/list', body, catalogID).catch(() => null);
            if (!data) break;
            const items = data.items ?? data.fileList ?? [];
            if (!items.length) break;

            // 139 API 可能重复返回首页数据，命中后立即跳出避免死循环
            const currFirstId = items[0].fileId || items[0].id;
            if (lastFirstId === currFirstId) break;
            lastFirstId = currFirstId;

            for (const f of items) {
                // 仅匹配文件夹类型
                if ((f.fileType === 'folder' || f.category === 'folder') &&
                    (f.name || '').trim() === targetName) {
                    return f.fileId;
                }
            }

            // 139 API 实际把 nextPageCursor 放在 data 根节点，pageInfo 仅作兼容兜底
            cursor = data.nextPageCursor ?? data.pageInfo?.nextPageCursor ?? null;
        } while (cursor);
        return null;
    }

    /**
     * 重命名文件（HCY 新接口）
     */
    async renameFile(fileId, newName) {
        const body = { fileId, name: newName };
        const data = await this._personalKdNjsPost('/hcy/file/update', body, '/');
        return data ? { res_code: 0, res_msg: 'success', data } : { res_code: -1, res_msg: '重命名失败' };
    }
}

module.exports = { Cloud139Service };

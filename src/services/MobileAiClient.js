/**
 * MobileAiClient — 移动云盘自带 AI（灵犀）客户端
 *
 * 协议细节见 docs/MOBILE_AI_API.md，集成方案见 docs/MOBILE_AI_FALLBACK_PLAN.md
 * 核心能力：
 *   - addChat 对话（SSE 流式解析，累加 outContent）
 *   - enableForceLlm 固定开启（防 018 云盘检索技能路由）
 *   - 明文 userId 获取（复用 Cloud139Service 的 /user/getUser）
 *   - token 链式接力管理（被动刷新：01000003/HTTP 401/403 触发，单飞锁 + 失败重读 DB + 原子回写）
 *   - accredit 授权初始化（每账号幂等一次）
 *   - 熔断器（连续 3 次失败暂停 30 分钟）
 */
'use strict';

const got = require('got');
const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');

// ─── 协议常量（docs/MOBILE_AI_API.md） ────────────────────────────────────────

const AI_BASE = 'https://ai.yun.139.com';
const ADDCHAT_URL = `${AI_BASE}/api/outer/assistant/chat/v2/add`;
const ACCREDIT_URL = `${AI_BASE}/api/outer/assistant/accredit/submit`;
const REFRESH_URL = 'https://aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do';

const CLIENT_INFO = '1|127.0.0.1|1|12.0.1|Xiaomi|22041216C||02-00-00-00-00-00|android 14|1080X2360|zh||||032|0|';
const UA = 'Mozilla/5.0 (Linux; Android 14; 22041216C Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36';

// 熔断参数（方案 §6：连续 3 次失败暂停 30 分钟）
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;
// 主动续期周期（方案 §3.2：默认关，开启后 25 天周期自动接力）
const PROACTIVE_RENEW_INTERVAL_MS = 25 * 24 * 60 * 60 * 1000;

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 从账号 cookies 字段解析 PCM Basic 凭据
 * @param {string} cookiesVal 形如 "Basic {base64}" 或裸 base64
 * @returns {{ basic: string, phone: string, token: string }|null}
 */
function parseBasicCredential(cookiesVal) {
    if (!cookiesVal || typeof cookiesVal !== 'string') return null;
    const raw = cookiesVal.trim();
    // 非 Basic 形态（如浏览器 Cookie 串）无法用于灵犀接口
    if (!/^Basic\s+/i.test(raw) && !/^[A-Za-z0-9+/]+=*$/.test(raw)) return null;
    const basic = /^Basic\s+/i.test(raw) ? raw : `Basic ${raw}`;
    try {
        const decoded = Buffer.from(basic.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const m = decoded.match(/^pc:([^:]+):(.+)$/);
        if (m) return { basic, phone: m[1], token: m[2] };
        // 兼容 "手机号:token" 形态（APP_AUTH 响应格式）
        const m2 = decoded.match(/^(\d{11}):(.+)$/);
        if (m2) return { basic, phone: m2[1], token: m2[2] };
        return null;
    } catch (_) {
        return null;
    }
}

/** 组装新的 Basic 凭据（"pc:手机号:token" → base64） */
function buildBasic(phone, token) {
    const payload = Buffer.from(`pc:${phone}:${token}`, 'utf8').toString('base64');
    return `Basic ${payload}`;
}

/**
 * 解析 SSE 文本流，累加 outContent
 * @param {string} sseText 完整响应文本
 * @returns {{ content: string, reasoning: string, command: string, modelType: string, sessionId: string, code: string, success: boolean, frameCount: number }}
 */
function parseSseResponse(sseText) {
    const result = { content: '', reasoning: '', command: '', modelType: '', sessionId: '', code: '', success: false, frameCount: 0 };
    for (const line of String(sseText || '').split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
            const frame = JSON.parse(raw);
            if (!frame || !frame.data) continue;
            result.frameCount++;
            if (frame.code) result.code = String(frame.code);
            if (frame.success === true) result.success = true;
            const d = frame.data;
            if (d.sessionId) result.sessionId = String(d.sessionId);
            if (d.outputCommand && d.outputCommand.command !== undefined) {
                result.command = String(d.outputCommand.command);
            }
            const flow = d.flowResult;
            if (flow) {
                if (typeof flow.outContent === 'string') result.content += flow.outContent;
                if (typeof flow.reasoningContent === 'string') result.reasoning += flow.reasoningContent;
                if (flow.modelType) result.modelType = String(flow.modelType);
            }
        } catch (_) { /* 忽略无法解析的帧 */ }
    }
    return result;
}

// ─── 主类 ─────────────────────────────────────────────────────────────────────

class MobileAiClient {
    constructor() {
        // 熔断器
        this._breakerFailures = 0;
        this._breakerOpenUntil = 0;
        // 进程内缓存
        this._userIdCache = new Map();      // accountId → 明文 userId
        this._accreditDone = new Set();     // 已完成授权初始化的 accountId
        this._lastRenewAt = new Map();      // accountId → 上次主动续期时间戳
        // token 刷新单飞锁（持有进行中的刷新 Promise）
        this._refreshing = null;
    }

    /** 读取兜底配置（含默认值） */
    getFallbackConfig() {
        const cfg = ConfigService.getConfigValue('channelMonitor.ai.mobileFallback') || {};
        return {
            enable: cfg.enable !== undefined ? Boolean(cfg.enable) : true,
            networkSearch: cfg.networkSearch !== undefined ? Boolean(cfg.networkSearch) : true,
            proactiveRenew: Boolean(cfg.proactiveRenew),
            timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 60000
        };
    }

    /** 兜底通道是否可用（总开关 + 存在可用账号凭证） */
    async isEnabled() {
        if (!this.getFallbackConfig().enable) return false;
        try {
            const cred = await this._loadCredential(null);
            return Boolean(cred);
        } catch (_) {
            // DB/环境不可用时视为不可用（如测试环境未初始化 DataSource），不阻断调用链
            return false;
        }
    }

    /** 熔断器是否处于激活状态 */
    _isBreakerOpen() {
        return Date.now() < this._breakerOpenUntil;
    }

    _recordFailure() {
        this._breakerFailures++;
        if (this._breakerFailures >= BREAKER_THRESHOLD) {
            this._breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
            logTaskEvent(`[移动AI] 连续 ${this._breakerFailures} 次失败，熔断 30 分钟`);
        }
    }

    _recordSuccess() {
        this._breakerFailures = 0;
        this._breakerOpenUntil = 0;
    }

    /**
     * 从 DB 加载账号与 Basic 凭据
     * @param {number|null} accountId 指定账号 ID（如 monitor.accountId），null 则取第一个启用账号
     * @returns {Promise<{ account: object, basic: string, phone: string, token: string }|null>}
     */
    async _loadCredential(accountId) {
        const { getAccountRepository } = require('../database');
        const repo = getAccountRepository();
        const where = accountId !== null && accountId !== undefined
            ? { id: accountId }
            : { isActive: true };
        const account = await repo.findOne({ where, order: { id: 'ASC' } });
        if (!account) return null;
        const cred = parseBasicCredential(account.cookies);
        if (!cred) return null;
        // 手机号兜底：Basic 解码失败时使用账号 username（手机号）
        return { account, ...cred, phone: cred.phone || account.username };
    }

    /**
     * 获取明文 userId（docs/MOBILE_AI_API.md §1.2，复用 Cloud139Service 用户域请求）
     * @returns {Promise<string|null>}
     */
    async _getUserId(account) {
        const cached = this._userIdCache.get(account.id);
        if (cached) return cached;
        try {
            const Cloud139Service = require('./cloud139');
            const cloud139 = Cloud139Service.getInstance(account);
            const userInfo = await cloud139._userNjsPost('/user/getUser', {});
            const userId = userInfo && userInfo.userDomainId ? String(userInfo.userDomainId) : null;
            if (userId) {
                this._userIdCache.set(account.id, userId);
            }
            return userId;
        } catch (err) {
            logger.warn(`[移动AI] 获取 userId 失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 一次性授权初始化（幂等，docs/MOBILE_AI_API.md §1.3）
     * 不调用直接对话会报 01000002 鉴权失败
     */
    async _accredit(account, basic) {
        if (this._accreditDone.has(account.id)) return true;
        try {
            const res = await got.post(ACCREDIT_URL, {
                headers: this._buildAiHeaders(basic),
                json: { sourceBusiness: 1 },
                timeout: { request: 15000 },
                responseType: 'json'
            });
            const body = res.body;
            if (body && body.success === true && String(body.code) === '0000') {
                this._accreditDone.add(account.id);
                return true;
            }
            logger.warn(`[移动AI] accredit 授权未通过: code=${body && body.code}, msg=${body && body.message}`);
            return false;
        } catch (err) {
            logger.warn(`[移动AI] accredit 请求异常: ${err.message}`);
            return false;
        }
    }

    /** 灵犀 AI 域完整请求头集合（§2.1，实测缺一不可） */
    _buildAiHeaders(basic) {
        return {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'authorization': basic,
            'user-agent': UA,
            'x-requested-with': 'com.chinamobile.mcloud',
            'x-yun-client-info': CLIENT_INFO,
            'x-DeviceInfo': CLIENT_INFO,
            'x-NetType': '1',
            'x-yun-app-channel': '101',
            'x-yun-api-version': 'v1',
            'charset': 'utf-8'
        };
    }

    /**
     * 单次 addChat 调用（不做刷新重试）
     * @returns {Promise<{ ok: boolean, content?: string, modelType?: string, sessionId?: string, command?: string, code?: string, authFailed?: boolean, error?: string }>}
     */
    async _addChatOnce(basic, userId, dialogue, opts = {}) {
        const cfg = this.getFallbackConfig();
        const payload = {
            userId,
            sessionId: opts.sessionId || '',
            applicationType: 'chat',
            sourceChannel: '101',
            dialogueInput: {
                dialogue,
                prompt: '',
                inputTime: new Date().toISOString(),
                enableForceLlm: true,                       // D1：防 018 技能路由（写死）
                enableForceNetworkSearch: opts.networkSearch !== undefined ? Boolean(opts.networkSearch) : cfg.networkSearch, // D2
                enableModelThinking: false,
                enableAllNetworkSearch: false,
                enableKnowledgeAndNetworkSearch: false,
                enableRegenerate: false,
                versionInfo: { h5Version: '2.4.1' },
                extInfo: '{}',
                sortInfo: {},
                toolSetting: { imageToolSetting: { enableLlmDescribe: true } },
                attachment: {}
            }
        };
        try {
            const res = await got.post(ADDCHAT_URL, {
                headers: this._buildAiHeaders(basic),
                body: JSON.stringify(payload),
                timeout: { request: cfg.timeoutMs },
                responseType: 'text'
            });
            const parsed = parseSseResponse(res.body);
            // 令牌失效 → 由上层触发刷新重试
            if (parsed.code === '01000003') {
                return { ok: false, authFailed: true, code: '01000003', error: '令牌失效' };
            }
            // 技能路由（非 000 意味 outContent 为空，识别失败）
            if (parsed.command && parsed.command !== '000') {
                return { ok: false, command: parsed.command, code: parsed.code, error: `技能路由 command=${parsed.command}` };
            }
            if (!parsed.success && parsed.code && parsed.code !== '0000') {
                return { ok: false, code: parsed.code, authFailed: parsed.code === '01000002', error: `灵犀接口错误码 ${parsed.code}` };
            }
            if (!parsed.content || !parsed.content.trim()) {
                // 成功帧数为 1 且正文为空 → 大概率被技能路由或鉴权拦截（§2.3 解析规则 4）
                return { ok: false, code: parsed.code, error: `响应正文为空 (frames=${parsed.frameCount}, command=${parsed.command || '无'})` };
            }
            return { ok: true, content: parsed.content, modelType: parsed.modelType, sessionId: parsed.sessionId, command: parsed.command };
        } catch (err) {
            const statusCode = err.response ? err.response.statusCode : 0;
            if (statusCode === 401 || statusCode === 403) {
                return { ok: false, authFailed: true, code: `HTTP_${statusCode}`, error: `HTTP ${statusCode} 鉴权失败` };
            }
            return { ok: false, error: err.message };
        }
    }

    /**
     * token 链式刷新（单飞锁 + 失败重读 + 原子回写，docs/MOBILE_AI_API.md §3.1）
     * @returns {Promise<{ success: boolean, basic?: string, error?: string }>}
     */
    _refreshToken(accountId) {
        if (this._refreshing) return this._refreshing;
        this._refreshing = this._doRefreshToken(accountId);
        const clear = () => { this._refreshing = null; };
        this._refreshing.then(clear, clear);
        return this._refreshing;
    }

    async _doRefreshToken(accountId) {
        const { getAccountRepository } = require('../database');
        const repo = getAccountRepository();
        // 重读 DB：并发场景下棒次可能已被第一次刷新更新（4006 时取到别人刷新后的最新 token）
        const account = await repo.findOne({ where: { id: accountId } });
        if (!account) return { success: false, error: `账号不存在 (id=${accountId})` };
        const cred = parseBasicCredential(account.cookies);
        if (!cred) {
            return { success: false, error: '账号 cookies 中无可用 Basic 凭据，需手动抓包更新 139 凭证' };
        }
        const phone = cred.phone || account.username;
        const xml = `<?xml version="1.0" encoding="utf-8"?><root><token>${cred.token}</token><account>${phone}</account><clienttype>656</clienttype></root>`;
        try {
            // 实测用 JSON 头发 XML 体（§3.1）
            const res = await got.post(REFRESH_URL, {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Accept': '*/*'
                },
                body: xml,
                timeout: { request: 15000 },
                responseType: 'text'
            });
            const returnCode = (res.body.match(/<return>([^<]*)<\/return>/) || [])[1];
            const newToken = (res.body.match(/<token>([^<]*)<\/token>/) || [])[1];
            if (returnCode === '0' && newToken) {
                const newBasic = buildBasic(phone, newToken);
                // 原子回写 DB（旧 token 已作废，必须立即持久化棒次）
                account.cookies = newBasic;
                await repo.save(account);
                this._lastRenewAt.set(accountId, Date.now());
                // authSignature 变化 → Cloud139Service 自动重建实例，现有功能零改动生效
                logTaskEvent(`[移动AI] token 链式刷新成功并已回写 (账号 ${phone})`);
                return { success: true, basic: newBasic };
            }
            if (returnCode === '4006') {
                return { success: false, code: '4006', error: 'token 已被其他端轮换（接力棒被拿走），需手动更新 139 凭证' };
            }
            return { success: false, code: returnCode, error: `刷新接口返回 return=${returnCode}` };
        } catch (err) {
            return { success: false, error: `刷新请求异常: ${err.message}` };
        }
    }

    /**
     * 对话入口（熔断检查 → accredit → addChat → 令牌失效时刷新重试一次）
     * @param {string} dialogue 提问文本（人类化口语，由调用方拼装）
     * @param {object} [opts] { accountId, networkSearch }
     * @returns {Promise<{ success: boolean, data?: { content: string, modelType: string }, error?: string, code?: string }>}
     */
    async chat(dialogue, opts = {}) {
        if (!dialogue || !String(dialogue).trim()) {
            return { success: false, error: '提问文本为空' };
        }
        if (this._isBreakerOpen()) {
            const remainMin = Math.ceil((this._breakerOpenUntil - Date.now()) / 60000);
            return { success: false, code: 'CIRCUIT_OPEN', error: `移动 AI 熔断激活中，剩余 ${remainMin} 分钟` };
        }
        let loaded;
        try {
            loaded = await this._loadCredential(opts.accountId || null);
        } catch (dbErr) {
            // DB/环境不可用（如测试环境未初始化 DataSource）时按无凭证处理，不阻断调用链
            logger.debug(`[移动AI] 凭证加载失败: ${dbErr.message}`);
            loaded = null;
        }
        if (!loaded) {
            return { success: false, code: 'NO_CREDENTIAL', error: '未找到可用的 139 Basic 凭据（需在账号管理中抓包配置）' };
        }
        let { account, basic } = loaded;

        const userId = await this._getUserId(account);
        if (!userId) {
            this._recordFailure();
            return { success: false, code: 'NO_USERID', error: '获取明文 userId 失败' };
        }

        await this._accredit(account, basic);

        // 主动续期（默认关）：距上次接力超过 25 天时先刷新一次，摆脱对浏览器登录态的依赖
        const cfg = this.getFallbackConfig();
        if (cfg.proactiveRenew) {
            const last = this._lastRenewAt.get(account.id) || 0;
            if (last && Date.now() - last > PROACTIVE_RENEW_INTERVAL_MS) {
                const refreshed = await this._refreshToken(account.id);
                if (refreshed.success) {
                    basic = refreshed.basic;
                } else {
                    logger.warn(`[移动AI] 主动续期失败: ${refreshed.error}`);
                }
            }
        }

        let result = await this._addChatOnce(basic, userId, dialogue, opts);

        // 被动刷新：令牌失效（01000003 / HTTP 401/403）→ 刷新后重试一次（§3.2）
        if (!result.ok && result.authFailed) {
            const refreshed = await this._refreshToken(account.id);
            if (refreshed.success) {
                basic = refreshed.basic;
                // 刷新后重新过 accredit（新凭据首次使用）
                this._accreditDone.delete(account.id);
                await this._accredit(account, basic);
                result = await this._addChatOnce(basic, userId, dialogue, opts);
            } else {
                this._recordFailure();
                logTaskEvent(`[移动AI] token 刷新失败，本轮兜底降级跳过: ${refreshed.error}`);
                return { success: false, code: refreshed.code || 'REFRESH_FAILED', error: refreshed.error };
            }
        }

        if (result.ok) {
            this._recordSuccess();
            return { success: true, data: { content: result.content, modelType: result.modelType, sessionId: result.sessionId } };
        }
        this._recordFailure();
        return { success: false, code: result.code, error: result.error };
    }

    /**
     * 连通性测试（M3 /api/ai/test 移动模式：验证 userId + token 有效性）
     * @param {number|null} accountId
     * @returns {Promise<{ success: boolean, latencyMs?: number, modelType?: string, userId?: string, content?: string, error?: string }>}
     */
    async testConnection(accountId = null) {
        const start = Date.now();
        const loaded = await this._loadCredential(accountId);
        if (!loaded) {
            return { success: false, error: '未找到可用的 139 Basic 凭据' };
        }
        const userId = await this._getUserId(loaded.account);
        if (!userId) {
            return { success: false, latencyMs: Date.now() - start, error: 'userId 获取失败（凭证可能已失效）' };
        }
        const res = await this.chat('你好', { accountId });
        const latencyMs = Date.now() - start;
        if (res.success) {
            return { success: true, latencyMs, modelType: res.data.modelType, userId, content: (res.data.content || '').slice(0, 100) };
        }
        return { success: false, latencyMs, userId, error: res.error };
    }

    /** 重置熔断器（测试/手动恢复用） */
    resetBreaker() {
        this._breakerFailures = 0;
        this._breakerOpenUntil = 0;
    }
}

// ─── 导出（单例 + 纯函数供测试） ──────────────────────────────────────────────

const mobileAiClient = new MobileAiClient();

module.exports = mobileAiClient;
module.exports.MobileAiClient = MobileAiClient;
module.exports.parseBasicCredential = parseBasicCredential;
module.exports.buildBasic = buildBasic;
module.exports.parseSseResponse = parseSseResponse;
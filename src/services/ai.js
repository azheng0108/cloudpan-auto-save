const got = require('got');
const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const { CacheManager } = require('./CacheManager');
const ProxyUtil = require('../utils/ProxyUtil');
const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');

class AIService {
    constructor() {
        this.defaultConfig = {
            temperature: 0.1,
            max_tokens: 2000,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        this.cache = new CacheManager(600); // 10分钟缓存，避免重复开销
    }

    /**
     * 获取生效的 AI / OpenAI 配置
     * @param {object} [customConfig]
     * @returns {object}
     */
    getEffectiveConfig(customConfig = null) {
        const stored = ConfigService.getConfigValue('ai') || ConfigService.getConfigValue('openai') || ConfigService.getConfigValue('channelMonitor.ai') || {};
        const cfg = Object.assign({}, stored, customConfig || {});
        let rawBaseUrl = (customConfig && customConfig.baseUrl !== undefined) ? customConfig.baseUrl : (cfg.baseUrl || '');
        let baseUrl = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
        const provider = String(cfg.provider || '').trim();
        const effProvider = provider || 'mobile';
        const isMobile = effProvider === 'mobile';
        return {
            enable: Boolean(cfg.enable),
            provider: effProvider,
            providerName: String(cfg.providerName || (isMobile ? '移动灵犀' : '自定义')).trim(),
            apiKey: String(cfg.apiKey || '').trim(),
            baseUrl: isMobile ? 'https://ai.yun.139.com' : (baseUrl || 'https://api.openai.com/v1'),
            model: isMobile
                ? ((!cfg.model || cfg.model.includes('gemini') || cfg.model.includes('gpt')) ? '移动灵犀智能大模型' : String(cfg.model).trim())
                : String(cfg.model || 'gpt-4o-mini').trim(),
            temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.1,
            maxTokens: typeof cfg.maxTokens === 'number' ? cfg.maxTokens : (cfg.max_tokens || 2000),
            mode: cfg.mode || 'fallback'
        };
    }

    /**
     * 校验是否开启了 AI 服务
     */
    isEnabled(customConfig = null) {
        const cfg = this.getEffectiveConfig(customConfig);
        if (cfg.provider === 'mobile') {
            return Boolean(cfg.enable);
        }
        return Boolean(cfg.enable && cfg.apiKey && cfg.baseUrl && cfg.model);
    }

    /**
     * 核心 Chat 对话接口
     * @param {Array<object>} messages
     * @param {object} [config] 可覆盖参数或临时配置
     * @returns {Promise<{ success: boolean, data?: string, error?: string }>}
     */
    async chat(messages, config = {}) {
        const effConfig = this.getEffectiveConfig(config);
        if (!this.isEnabled(effConfig)) {
            return { success: false, error: 'AI 服务未配置或未启用' };
        }

        const proxy = ProxyUtil.getProxyAgent('ai') || ProxyUtil.getProxyAgent('openai');
        try {
            const response = await got.post(`${effConfig.baseUrl}/chat/completions`, {
                json: {
                    model: effConfig.model,
                    messages,
                    stream: false,
                    temperature: config.temperature !== undefined ? config.temperature : effConfig.temperature,
                    max_tokens: config.max_tokens !== undefined ? config.max_tokens : effConfig.maxTokens
                },
                headers: {
                    'Authorization': `Bearer ${effConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                agent: proxy,
                timeout: { connect: 5000, request: 20000 },
                responseType: 'json'
            });

            const content = response.body?.choices?.[0]?.message?.content || '';
            return {
                success: true,
                data: content
            };
        } catch (error) {
            let errorDetails = error.message;
            if (error.response?.body) {
                const b = error.response.body;
                errorDetails += ` (${typeof b === 'object' ? (b.error?.message || JSON.stringify(b)) : b})`;
            }
            if (effConfig.baseUrl && effConfig.baseUrl.includes('8045') && error.code === 'ECONNREFUSED') {
                logger.info(`[AI 服务] 本地 Agent2API (8045端口) 未监听，自动无缝穿透至免密移动 AI (灵犀大模型)`);
            } else {
                logger.warn(`[AI 服务] 请求异常: ${errorDetails}`);
            }
            // 通道降级（M2）：主通道请求异常且显式启用移动兜底时，转灵犀通道重试
            if (config.fallbackToMobile) {
                return this._chatViaMobile(messages);
            }
            return {
                success: false,
                error: errorDetails
            };
        }
    }

    /**
     * 通用对话的移动 AI 降级通道（取最后一条 user 消息作 dialogue）
     * @param {Array<object>} messages
     * @returns {Promise<{ success: boolean, data?: string, error?: string }>}
     */
    async _chatViaMobile(messages) {
        const MobileAiClient = require('./MobileAiClient');
        if (!MobileAiClient.getFallbackConfig().enable) {
            return { success: false, error: '移动 AI 兜底未启用' };
        }
        const lastUser = [...messages].reverse().find(m => m && m.role === 'user' && m.content);
        if (!lastUser) {
            return { success: false, error: '无可降级的用户消息' };
        }
        const res = await MobileAiClient.chat(String(lastUser.content));
        if (!res.success) {
            return { success: false, error: `[移动AI降级] ${res.error || '调用失败'}` };
        }
        return { success: true, data: res.data.content };
    }

    /**
     * 测试 AI 连接与密钥有效性
     * @param {object} [customConfig]
     * @returns {Promise<{ success: boolean, latencyMs?: number, model?: string, reply?: string, error?: string }>}
     */
    async testConnection(customConfig = null) {
        const eff = this.getEffectiveConfig(customConfig);
        if (!eff.apiKey) {
            return { success: false, error: 'API Key 不能为空' };
        }
        if (!eff.baseUrl) {
            return { success: false, error: 'API Base URL 不能为空' };
        }
        const start = Date.now();
        const testRes = await this.chat([
            { role: 'system', content: 'You are a test assistant. Answer with OK.' },
            { role: 'user', content: 'ping' }
        ], { ...eff, enable: true, max_tokens: 10, temperature: 0.1 });

        const latencyMs = Date.now() - start;
        if (testRes.success) {
            return {
                success: true,
                latencyMs,
                model: eff.model,
                reply: (testRes.data || '').trim()
            };
        }
        return {
            success: false,
            latencyMs,
            error: testRes.error || '连接超时或鉴权失败'
        };
    }
    /**
     * 动态拉取指定服务商的可用模型列表（兼容 OpenAI, DeepSeek, GLM, Gemini 等）
     * @param {object} [customConfig]
     * @returns {Promise<{ success: boolean, models?: string[], error?: string }>}
     */
    async fetchModels(customConfig = null) {
        const eff = this.getEffectiveConfig(customConfig);
        if (eff.provider === 'mobile') {
            return {
                success: true,
                models: ['移动灵犀智能大模型 (内置免配置)']
            };
        }
        if (!eff.apiKey) {
            return { success: false, error: '请先填写 API Key' };
        }
        if (!eff.baseUrl) {
            return { success: false, error: '请先填写服务地址 (Base URL)' };
        }
        const proxy = ProxyUtil.getProxyAgent('ai') || ProxyUtil.getProxyAgent('openai');
        try {
            let url = `${eff.baseUrl}/models`;
            const headers = {
                'Authorization': `Bearer ${eff.apiKey}`,
                'Content-Type': 'application/json'
            };
            if (eff.baseUrl.includes('googleapis.com') && !eff.baseUrl.includes('/openai')) {
                url = `${eff.baseUrl}/v1beta/models?key=${eff.apiKey}`;
                delete headers['Authorization'];
            }
            const res = await got.get(url, {
                headers,
                agent: proxy,
                timeout: { connect: 5000, request: 15000 },
                responseType: 'json'
            });
            const data = res.body?.data || res.body?.models || [];
            const models = (Array.isArray(data) ? data : [])
                .map(item => {
                    if (typeof item === 'string') return item;
                    return (item.id || item.name || '').replace(/^models\//, '');
                })
                .filter(Boolean);

            if (!models.length) {
                return { success: false, error: '服务商未返回任何可用模型，请手动输入模型名称' };
            }
            return { success: true, models };
        } catch (err) {
            let errorDetails = err.message;
            if (err.response?.body) {
                const b = err.response.body;
                errorDetails += ` (${typeof b === 'object' ? (b.error?.message || JSON.stringify(b)) : b})`;
            }
            return { success: false, error: `获取模型列表失败: ${errorDetails}` };
        }
    }


    /**
     * 自主感知并检索 TMDB 候选条目（RAG 上下文增强：消除 AI 幻觉与盲猜）
     * 交叉提取推文/文件名/目录名中的关键实体词，主动请求 TMDB 接口获取 Top 候选
     * @param {string} text 待解析文本
     * @param {object} context 上下文信息
     * @returns {Promise<{ candidates: Array<object>, tmdbInfo: object } | null>}
     */
    async _autoFetchTmdbCandidates(text, context = {}) {
        try {
            const { TMDBService } = require('./tmdb');
            const tmdb = new TMDBService();
            if (!tmdb.apiKey && !tmdb.credential) {
                return null;
            }

            // 1. 若外部已明确指定 tmdbId，直接拉取权威详情
            if (context.tmdbId) {
                const targetType = context.mediaType || 'tv';
                const detail = await tmdb.details(targetType, context.tmdbId) || await tmdb.details('movie', context.tmdbId);
                if (detail && detail.id) {
                    const info = {
                        id: detail.id,
                        title: detail.title || detail.name,
                        year: String(detail.year || (detail.first_air_date || detail.release_date || '').slice(0, 4) || ''),
                        seasons: detail.seasons || []
                    };
                    return { candidates: [detail], tmdbInfo: info };
                }
            }

            // 2. 候选关键词提取池
            const queries = [];

            // A. 从主文本提炼纯净影视名（剔除 URL、分享码、技术规格、剧集数字等）
            let clean = String(text || '')
                .replace(/https?:\/\/[^\s]+/g, '')
                .replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/gi, '')
                .replace(/【[^】]*】/g, ' ')
                .replace(/\[[^\]]*\]/g, ' ')
                .replace(/[（\(](?:19|20)\d{2}[）\)]/g, ' ')
                .replace(/更新至.*$/g, ' ')
                .replace(/\b(?:1080p|2160p|4k|720p|cr|web-dl|mkv|mp4|aac|h\.?26[45]|hevc|hdr|sdr|remux|bluray|x264|x265)\b/gi, ' ')
                .replace(/[丨|｜丶#]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (clean) {
                // 剔除末尾集数（如 "龙珠超 比鲁斯 06" -> "龙珠超 比鲁斯"）
                const withoutEp = clean.replace(/(?:第?\s*\d{1,4}\s*集|\b\d{1,4}\b)\s*$/g, '').trim();
                if (withoutEp) queries.push(withoutEp);
                queries.push(clean);
            }

            // B. 尝试从 TgChannelMonitorService 提取特征
            try {
                const { TgChannelMonitorService } = require('./channel/TgChannelMonitorService');
                if (TgChannelMonitorService?.extractMediaInfoFromPost) {
                    const pm = TgChannelMonitorService.extractMediaInfoFromPost(clean || text);
                    if (pm?.title && !queries.includes(pm.title)) {
                        queries.unshift(pm.title);
                    }
                }
            } catch (_) {}

            // C. 上下文目录名与分享标题
            if (Array.isArray(context.folderNames)) {
                for (const fn of context.folderNames) {
                    const cfn = String(fn || '').replace(/[（\(](?:19|20)\d{2}[）\)]/g, '').trim();
                    if (cfn && cfn !== '暂存区' && cfn !== 'root' && !/^\d+$/.test(cfn) && !queries.includes(cfn)) {
                        queries.push(cfn);
                    }
                }
            }
            if (context.linkName && !queries.includes(context.linkName)) {
                queries.push(context.linkName);
            }

            // 3. 逐个候选词检索 TMDB，聚合去重
            const candidateMap = new Map();
            for (const q of queries) {
                if (!q || q.length < 2) continue;
                try {
                    const list = await tmdb.searchCandidates(q, '', 'auto');
                    if (Array.isArray(list)) {
                        for (const item of list.slice(0, 4)) {
                            if (!candidateMap.has(item.id)) {
                                candidateMap.set(item.id, item);
                            }
                        }
                    }
                } catch (_) {}
                if (candidateMap.size >= 4) break;
            }

            if (candidateMap.size === 0) return null;

            // 4. 为 Top 3 候选加载完整详情（含分季与简介）
            const topList = Array.from(candidateMap.values()).slice(0, 3);
            const detailed = [];
            for (const item of topList) {
                try {
                    const mType = item.mediaType || (item.first_air_date ? 'tv' : 'movie');
                    const d = await tmdb.details(mType, item.id);
                    if (d && d.id) {
                        detailed.push(d);
                    } else {
                        detailed.push(item);
                    }
                } catch (_) {
                    detailed.push(item);
                }
            }

            const primary = detailed[0];
            return {
                candidates: detailed,
                tmdbInfo: {
                    id: primary.id,
                    title: primary.title || primary.name,
                    year: String(primary.year || (primary.first_air_date || primary.release_date || '').slice(0, 4) || ''),
                    seasons: primary.seasons || []
                }
            };
        } catch (err) {
            logger.debug(`[AI 服务] 自主探查 TMDB 候选失败: ${err.message}`);
            return null;
        }
    }

    /**
     * AI 深度解析影视元信息（支持处理混淆文件夹、Telegram 复杂推文、复杂文件名）
     * @param {string} text 待解析文本（推文正文、文件夹名、或文件名）
     * @param {object} [context] 上下文附加信息（如父目录名、文件大小）
     * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
     */
    /**
     * 单次 AI 结构化解析核心执行器（支持 OpenAI / 移动灵犀 降级穿透）
     */
    async _executeAiParse(text, context = {}, eff = null) {
        if (!eff) eff = this.getEffectiveConfig();

        // 选定移动灵犀免密通道 或 外部通道未就绪 → 直接走移动灵犀通道
        if (eff.provider === 'mobile' || !eff.apiKey || !this.isEnabled(eff)) {
            return this._parseViaMobile(text, context);
        }

        const systemPrompt = `你是一个专业的影视剧与动漫名称解析与元数据抽取专家。
你的核心任务是精准去除防封干扰字符（如丨、|、丶、#、拼音代码等）、发布组前缀/后缀、压制规格、集数、季数、年份，抽取出官方权威中文片名与结构化信息。

【严格返回格式】请直接返回一个标准的 JSON 对象，不要使用 markdown 代码块包裹，不要添加任何额外解释说明文字：
{
  "title": "纯净官方中文片名（例如：仙逆、无可替代、间谍过家家。绝不含年份/季/集/画质/防封符号）",
  "originalTitle": "原名或英文名（若推文或文件名中有提及，否则留空字符串）",
  "year": "4位数字上映年份（例如 '2023'，若无法确定留空字符串）",
  "mediaType": "tv", // "tv" 或 "movie"
  "season": 1, // 整数季号。特别篇为0，默认或第1季为1
  "episode": null, // 整数集号。例如 160，若是全季或电影则为 null
  "category": "国漫", // 二级分类："国漫"|"日番"|"国产剧"|"日韩剧"|"欧美剧"|"动漫"|"电影"|"动画电影"|"纪录片"|"综艺"
  "videoFormat": "4K", // "4K"|"1080p"|"720p"|""
  "videoCodec": "H.265", // "H.265"|"H.264"|"AV1"|""
  "dynamicRange": "SDR", // "DV"|"HDR10+"|"HDR"|"SDR"|""
  "confidence": 0.95
}`;

        let tmdbBlock = '';
        if (Array.isArray(context.tmdbCandidates) && context.tmdbCandidates.length > 0) {
            tmdbBlock = [
                '【TMDB 官方权威候选参考信息（系统实时检索）】:',
                ...context.tmdbCandidates.map((c, i) => {
                    const seasonsStr = Array.isArray(c.seasons)
                        ? c.seasons.map(s => `第${s.season_number}季:共${s.episode_count || 0}集`).join('; ')
                        : '';
                    return `候选${i + 1}: 《${c.title || c.name}》 (ID: ${c.id}, 年份: ${c.year || (c.first_air_date || c.release_date || '').slice(0, 4) || ''}) ${seasonsStr ? `[${seasonsStr}]` : ''}`;
                })
            ].join('\n');
        } else if (context.tmdbInfo) {
            tmdbBlock = [
                `【TMDB 官方权威分季参考信息】:`,
                `片名: ${context.tmdbInfo.title || ''} (ID: ${context.tmdbInfo.id || ''})`,
                Array.isArray(context.tmdbInfo.seasons) ? context.tmdbInfo.seasons.map(s => `第${s.season_number}季: 共${s.episode_count || 0}集${s.air_date ? ` (${s.air_date})` : ''}`).join('; ') : ''
            ].filter(Boolean).join('\n');
        }

        const userContent = [
            `【待分析内容】:`,
            text.trim(),
            context.parentFolder ? `【上下文目录】: ${context.parentFolder}` : '',
            context.fileSize ? `【文件大小】: ${context.fileSize}` : '',
            tmdbBlock
        ].filter(Boolean).join('\n');

        const chatRes = await this.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ], { ...eff, temperature: 0.1 });

        if (!chatRes.success) {
            // 通道降级（M2）：主通道请求失败 → 移动 AI 兜底（人类化提问 + 本地正则提取）
            const mobileRes = await this._parseViaMobile(text, context);
            if (mobileRes.success) return mobileRes;
            return {
                success: false,
                error: `${chatRes.error}；${mobileRes.error}`
            };
        }

        try {
            const raw = String(chatRes.data || '')
                .replace(/```(?:json)?\s*|\s*```/g, '')
                .replace(/^(?:json)?\s*/, '')
                .trim();
            const parsed = JSON.parse(raw);

            // 规范化字段
            if (parsed.title) {
                parsed.title = String(parsed.title).replace(/[丨|｜丶]/g, '').trim();
            }
            if (parsed.year) {
                parsed.year = String(parsed.year).match(/^(?:19|20)\d{2}$/)?.[0] || '';
            }
            if (parsed.season !== undefined && parsed.season !== null) {
                parsed.season = Number(parsed.season);
            }
            if (parsed.episode !== undefined && parsed.episode !== null) {
                parsed.episode = Number(parsed.episode);
            }

            return {
                success: true,
                data: parsed
            };
        } catch (parseErr) {
            logger.warn(`[AI 服务] 解析响应 JSON 失败: ${parseErr.message}`, { raw: chatRes.data });
            // 通道降级（M2）：主通道回复无法结构化 → 移动 AI 兜底重新识别
            const mobileRes = await this._parseViaMobile(text, context);
            if (mobileRes.success) return mobileRes;
            return {
                success: false,
                error: `AI 响应格式无法被正确解析为 JSON；${mobileRes.error}`
            };
        }
    }

    /**
     * 智能两阶段影视解析流水线（先 AI 语义提纯清洗 -> 再基于纯净片名检索 TMDB -> 结合真实候选精准消歧）
     * @param {string} text 待解析文本（推文正文、文件夹名、或文件名）
     * @param {object} [context] 上下文附加信息（如父目录名、文件大小）
     * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
     */
    async parseMediaInfo(text, context = {}, customConfig = null) {
        if (!text || typeof text !== 'string' || !text.trim()) {
            return { success: false, error: '解析文本为空' };
        }
        const eff = this.getEffectiveConfig(customConfig);

        // 总开关未开启且非强制测试调用时直接退出，不消耗 Token 与算力
        if (!eff.enable && !context.force) {
            return { success: false, error: 'AI 服务未配置或未启用' };
        }

        // 核心安全前置：剔除所有 URL 与网盘分享链接，防外部链接审查拒答
        const cleanText = String(text || '')
            .replace(/https?:\/\/[^\s]+/g, ' ')
            .replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleanText) {
            return { success: false, error: '解析文本去除链接后为空' };
        }

        // 缓存 key 加 context 哈希，防止同文本不同上下文误命中
        const contextHash = this._hashContext(context);
        const cacheKey = `ai:parse:${cleanText}${contextHash}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return { success: true, data: cached, fromCache: true };
        }

        // 若外部已显式指定了 tmdbCandidates 或 tmdbInfo（如人工指定候选列表进行消歧），直接单次执行消歧
        if (Array.isArray(context.tmdbCandidates) && context.tmdbCandidates.length > 0) {
            const directRes = await this._executeAiParse(cleanText, context, eff);
            if (directRes.success && directRes.data) {
                this.cache.set(cacheKey, directRes.data);
            }
            return directRes;
        }

        // ─── 核心两阶段管道架构 ──────────────────────────────────────────
        // 阶段一：纯文本 AI 语义提纯（AI 先行清洗文件名、去除画质/集数/发布组杂音，绝不盲带错误 TMDB 候选）
        const phase1Res = await this._executeAiParse(cleanText, {
            ...context,
            skipTmdb: true,
            tmdbCandidates: null,
            tmdbInfo: null
        }, eff);

        if (!phase1Res.success || !phase1Res.data || !phase1Res.data.title) {
            return phase1Res;
        }

        let aiData = { ...phase1Res.data };
        const aiTitle = String(aiData.title || '').trim();
        const aiYear = String(aiData.year || '').trim();
        const aiMediaType = aiData.mediaType || 'auto';

        const phase1DoneMsg = `[AI提纯-阶段1] 原始文本清洗完成: 提纯片名="《${aiTitle}》", 上映年份="${aiYear || '未知'}", 类别="${aiMediaType}"${aiData.season ? `, 第${aiData.season}季` : ''}${aiData.episode ? ` E${aiData.episode}` : ''}`;
        logTaskEvent(phase1DoneMsg);

        // 阶段二：使用 AI 清洗提纯出的纯净官方片名，精准检索 TMDB 权威数据库
        if (aiTitle && !context.skipTmdb) {
            try {
                const { TMDBService } = require('./tmdb');
                const tmdb = new TMDBService();
                if (tmdb.apiKey || tmdb.credential) {
                    const { RecognitionEngine } = require('./RecognitionEngine');
                    const normAiTitle = RecognitionEngine.normalizeTitleKey(aiTitle);

                    // 判断是否为连载/年番/高集数剧集（此类资源的年份往往是更新年份而非首播年份）
                    const isOngoingOrLargeEp = /(?:更新至|连载至|更新到|第\s*\d+\s*[集话期]|年番|连载|追更)/i.test(cleanText) ||
                        Boolean(aiData.episode && aiData.episode > 24) ||
                        Boolean(context?.isLaterSeasonOrOngoing) ||
                        Boolean(context?.isAnime);

                    let candidates = [];
                    // 1. 若非明确连载/高集数资源，且带有年份，先带年份精准检索
                    if (aiYear && !isOngoingOrLargeEp) {
                        const searchMsg = `[AI-TMDB比对-阶段2] 正在向 TMDB 权威库检索纯净片名《${aiTitle}》 (年份: ${aiYear})...`;
                        logTaskEvent(searchMsg);
                        candidates = await tmdb.searchCandidates(aiTitle, aiYear, aiMediaType);
                    }

                    // 检查已检索候选库中是否存在与 aiTitle 完全一致的条目
                    const hasExactInCandidates = Array.isArray(candidates) && candidates.some(c => {
                        const cTitle = c.title || c.name || '';
                        return cTitle === aiTitle || RecognitionEngine.normalizeTitleKey(cTitle) === normAiTitle;
                    });

                    // 2. 若未带年份、检索无结果，或带年份结果中无完全匹配项（可能被前传/番外占用了更新年），执行无年份全量检索
                    if (!candidates || candidates.length === 0 || !hasExactInCandidates) {
                        const noYearMsg = isOngoingOrLargeEp
                            ? `[AI-TMDB比对-阶段2] 识别为连载/多集剧集，向 TMDB 权威库检索纯净片名《${aiTitle}》 (解耦首播年份)...`
                            : (candidates && candidates.length > 0
                                ? `[AI-TMDB比对-阶段2] 年份 ${aiYear} 检索未命中《${aiTitle}》本体，切换全量首播库检索...`
                                : `[AI-TMDB比对-阶段2] 正在向 TMDB 权威库检索纯净片名《${aiTitle}》...`);
                        logTaskEvent(noYearMsg);
                        const noYearCandidates = await tmdb.searchCandidates(aiTitle, '', aiMediaType);
                        if (Array.isArray(noYearCandidates) && noYearCandidates.length > 0) {
                            candidates = noYearCandidates;
                        }
                    }

                    if (Array.isArray(candidates) && candidates.length > 0) {
                        const candSummary = candidates.slice(0, 4).map((c, i) => {
                            const cYear = c.year || (c.first_air_date || c.release_date || '').slice(0, 4) || '未知';
                            return `候选${i + 1}: 《${c.title || c.name}》 [ID: ${c.id}, 年份: ${cYear}, 类型: ${c.mediaType || (c.first_air_date ? 'tv' : 'movie')}]`;
                        }).join('； ');
                        const candLogMsg = `[AI-TMDB比对-阶段2] TMDB 检索返回 ${candidates.length} 个候选: ${candSummary}`;
                        logTaskEvent(candLogMsg);

                        // 优先在所有候选中寻找与 AI 提纯片名完全一致的权威条目
                        const exactCandidate = candidates.find(c => {
                            const cTitle = c.title || c.name || '';
                            return cTitle === aiTitle || RecognitionEngine.normalizeTitleKey(cTitle) === normAiTitle;
                        });

                        if (exactCandidate) {
                            // 权威候选完全匹配 AI 清洗片名，直接绑定权威详情与分季数据
                            const exactTitle = exactCandidate.title || exactCandidate.name || aiTitle;
                            const exactMsg = `[AI-TMDB比对-阶段3] 首选候选《${exactTitle}》与 AI 提纯片名完全一致，判定精准匹配，直联绑定 TMDB #${exactCandidate.id}`;
                            logTaskEvent(exactMsg);
                            try {
                                const mType = exactCandidate.mediaType || (exactCandidate.first_air_date ? 'tv' : 'movie');
                                const detail = await tmdb.details(mType, exactCandidate.id);
                                const finalObj = detail && detail.id ? detail : exactCandidate;
                                aiData.tmdbId = String(finalObj.id);
                                aiData.title = finalObj.title || finalObj.name || aiTitle;
                                if (finalObj.year || finalObj.first_air_date || finalObj.release_date) {
                                    aiData.year = String(finalObj.year || (finalObj.first_air_date || finalObj.release_date || '').slice(0, 4) || aiYear);
                                }
                                aiData.confidence = Math.max(aiData.confidence || 0.8, 0.95);
                                if (Array.isArray(finalObj.seasons)) {
                                    aiData.seasons = finalObj.seasons;
                                }

                                // 智能分季校准：若 TMDB 仅定义了第 1 季（如国漫年番全量归入第1季），校正季号为 1
                                if (Array.isArray(finalObj.seasons) && finalObj.seasons.length > 0) {
                                    const validSeasons = finalObj.seasons.filter(s => (s.season_number ?? s.seasonNumber) > 0);
                                    if (validSeasons.length === 1) {
                                        aiData.season = Number(validSeasons[0].season_number ?? validSeasons[0].seasonNumber);
                                    }
                                }

                                const boundMsg = `[AI-TMDB比对-阶段3] 绑定成功: 《${aiData.title}》 (${aiData.year || '未知年份'}) [TMDB #${aiData.tmdbId}], 置信度: ${Math.round((aiData.confidence || 0.95) * 100)}%`;
                                logTaskEvent(boundMsg);
                            } catch (_) {
                                aiData.tmdbId = String(exactCandidate.id);
                            }
                        } else {
                            // 衍生词与专有副标题过滤铁律：
                            // 若 AI 提纯片名未包含衍生词（如前传/番外/特别篇/剧场版），绝不可误匹配包含衍生词的候选
                            const derivativeKeywords = ['前传', '后传', '番外', '外传', '特别篇', '剧场版', '电影版', '网络版', 'sp', 'ova', 'oad'];
                            const aiHasDerivative = derivativeKeywords.some(k => aiTitle.toLowerCase().includes(k));

                            const relevant = candidates.filter(c => {
                                const cTitle = (c.title || c.name || '').toLowerCase();
                                const cNorm = RecognitionEngine.normalizeTitleKey(cTitle);
                                const matchesKeyword = (cNorm.length >= 2 && normAiTitle.length >= 2) && (cNorm.includes(normAiTitle) || normAiTitle.includes(cNorm));
                                if (!matchesKeyword) return false;

                                if (!aiHasDerivative && derivativeKeywords.some(k => cTitle.includes(k))) {
                                    return false;
                                }
                                return true;
                            }).slice(0, 3);

                            const filterMsg = `[AI-TMDB比对-阶段3] 候选消歧比对: 排除无关/拼音/误匹配衍生候选，筛选出 ${relevant.length} 个相关候选: [${relevant.map(r => '《' + (r.title || r.name) + '》 #' + r.id).join(', ') || '无相关候选'}]`;
                            logTaskEvent(filterMsg);

                            if (relevant.length > 1) {
                                // 存在多个衍生/篇章候选项（如《龙珠超》与《龙珠超：比鲁斯》），由 AI 结合候选进行二次精准消歧
                                const disambigStartMsg = `[AI-TMDB比对-阶段3] 存在多个衍生/篇章候选，调度 AI 进行二次精准消歧与专有条目比对...`;
                                logTaskEvent(disambigStartMsg);

                                const detailedList = [];
                                for (const item of relevant) {
                                    try {
                                        const mType = item.mediaType || (item.first_air_date ? 'tv' : 'movie');
                                        const d = await tmdb.details(mType, item.id);
                                        detailedList.push(d && d.id ? d : item);
                                    } catch (_) {
                                        detailedList.push(item);
                                    }
                                }
                                const disambigRes = await this._executeAiParse(cleanText, {
                                    ...context,
                                    tmdbCandidates: detailedList
                                }, eff);
                                if (disambigRes.success && disambigRes.data && disambigRes.data.title) {
                                    aiData = { ...aiData, ...disambigRes.data };
                                    const disambigDoneMsg = `[AI-TMDB比对-阶段3] AI 二次消歧完成，裁决最终归属: 《${aiData.title}》 [TMDB #${aiData.tmdbId || '无'}]，判定依据: ${aiData.reason || '专有条目匹配'}`;
                                    logTaskEvent(disambigDoneMsg);
                                }
                            } else if (relevant.length === 1) {
                                const single = relevant[0];
                                aiData.tmdbId = String(single.id);
                                aiData.title = single.title || single.name || aiTitle;
                                if (single.year || single.first_air_date || single.release_date) {
                                    aiData.year = String(single.year || (single.first_air_date || single.release_date || '').slice(0, 4) || aiYear);
                                }
                                try {
                                    const mType = single.mediaType || (single.first_air_date ? 'tv' : 'movie');
                                    const d = await tmdb.details(mType, single.id);
                                    if (d && Array.isArray(d.seasons)) {
                                        const validSeasons = d.seasons.filter(s => (s.season_number ?? s.seasonNumber) > 0);
                                        if (validSeasons.length === 1) {
                                            aiData.season = Number(validSeasons[0].season_number ?? validSeasons[0].seasonNumber);
                                        }
                                    }
                                } catch (_) {}
                                const singleDoneMsg = `[AI-TMDB比对-阶段3] 命中唯一强相关候选: 《${aiData.title}》 [TMDB #${aiData.tmdbId}] (${aiData.year || '未知年份'})`;
                                logTaskEvent(singleDoneMsg);
                            } else {
                                const retainMsg = `[AI-TMDB比对-阶段3] TMDB 候选均不匹配 AI 提纯片名《${aiTitle}》，安全保留 AI 提纯片名，防止被错误数据污染`;
                                logTaskEvent(retainMsg);
                            }
                        }
                    } else {
                        const noCandMsg = `[AI-TMDB比对-阶段2] TMDB 库未检索到《${aiTitle}》的候选记录，系统安全保留 AI 提纯片名《${aiTitle}》`;
                        logTaskEvent(noCandMsg);
                    }
                }
            } catch (tmdbErr) {
                const errLogMsg = `[AI-TMDB比对] TMDB 检索消歧异常: ${tmdbErr.message}`;
                logTaskEvent(errLogMsg);
            }
        }

        this.cache.set(cacheKey, aiData);
        return { success: true, data: aiData };
    }

    /**
     * context 指纹（剔除账号等与识别内容无关字段后哈希）
     * @param {object} context
     * @returns {string} 空串（无有效内容）或 "#hash10"
     */
    _hashContext(context) {
        if (!context || typeof context !== 'object') return '';
        const copy = { ...context };
        delete copy.accountId;
        if (Array.isArray(copy.tmdbCandidates)) {
            copy.tmdbCandidates = copy.tmdbCandidates.map(c => c.id || c.name || c.title);
        }
        const keys = Object.keys(copy).filter(k => {
            const v = copy[k];
            if (v === undefined || v === null || v === '') return false;
            if (Array.isArray(v) && v.length === 0) return false;
            return true;
        });
        if (!keys.length) return '';
        const stable = keys.sort().map(k => `${k}=${JSON.stringify(copy[k])}`).join('&');
        return `#${crypto.createHash('md5').update(stable, 'utf8').digest('hex').slice(0, 10)}`;
    }

    /**
     * 移动 AI（灵犀）兜底解析通道（方案 §2.2/§2.3）
     * 人类化提问 + 本地正则提取，结果结构与主通道一致
     * @param {string} text 推文正文
     * @param {object} context { folderNames, fileNames, linkName, accountId }
     * @returns {Promise<{ success: boolean, data?: object, error?: string, code?: string, fromCache?: boolean }>}
     */
    async _parseViaMobile(text, context = {}) {
        const MobileAiClient = require('./MobileAiClient');
        const cfg = MobileAiClient.getFallbackConfig();
        if (!cfg.enable) {
            return { success: false, error: 'AI 服务未配置且移动 AI 兜底未启用' };
        }

        const cacheKey = `ai:parse:m:${text.trim()}${this._hashContext(context)}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return { success: true, data: cached, fromCache: true };
        }

        const dialogue = buildHumanDialogue(text, context);
        const res = await MobileAiClient.chat(dialogue, {
            accountId: context.accountId || null,
            networkSearch: cfg.networkSearch
        });
        if (!res.success) {
            return { success: false, code: res.code, error: `[移动AI兜底] ${res.error || '调用失败'}` };
        }

        const extracted = extractMediaFromReply(res.data.content, context);
        if (!extracted || !extracted.title) {
            // 兜底失败时保留原始回复进日志供人工排查（方案 §2.3）
            logger.warn('[AI 服务] 移动 AI 回复本地提取失败', { reply: res.data.content });
            return { success: false, error: '移动 AI 回复无法提取出影视条目（原始回复已入日志）' };
        }
        let displayReply = '';
        const replyLines = String(res.data.content || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const structuredLines = replyLines.filter(l => /^(?:[1-5][.、\s]|【)/.test(l));
        if (structuredLines.length >= 3) {
            displayReply = structuredLines.join('\n');
        } else {
            // 模型输出了长篇自由文本时，强制提纯并格式化为标准 5 行精炼解读，彻底杜绝数千字的小说剧情背景与观看建议
            const isMovieExtracted = extracted.mediaType === 'movie' || (extracted.category && extracted.category.includes('电影'));
            const effReason = extracted.reason || (isMovieExtracted ? '剧场版独立电影，独立归入电影库' : (extracted.season ? `根据集号与首播时间判定归属第 ${extracted.season} 季` : '已精准提纯片名并联动 TMDB 标准库'));
            displayReply = [
                `1. 官方片名：《${extracted.title}》`,
                `2. 影视类别：${extracted.category || (isMovieExtracted ? '电影' : '国漫')}`,
                `3. 首播年份：${extracted.year || '未知'}`,
                `4. 当前归属：${isMovieExtracted ? '电影' : `第${extracted.season ?? 1}季`}`,
                `5. 判定依据：${effReason}`
            ].join('\n');
        }
        const data = { ...extracted, confidence: 0.6, source: 'mobile', replyText: displayReply };
        this.cache.set(cacheKey, data);
        return { success: true, data };
    }

    /**
     * 智能清洗片名
     * @param {string} rawTitle 
     * @returns {Promise<string>}
     */
    async cleanTitle(rawTitle) {
        if (!rawTitle || !this.isEnabled()) return rawTitle;
        const res = await this.parseMediaInfo(rawTitle);
        return (res.success && res.data?.title) ? res.data.title : rawTitle;
    }

    // 文件夹分析
    async folderAnalysis(resourcePath, dirs) {
        const messages = [
            {
                role: 'system',
                content: `你是一个专业的影视剧文件夹名称标准化助手。你的任务是将各种格式的季度文件夹名称转换为标准格式。

                输入信息说明：
                1. name 字段必须是纯净的影视剧名称，不能包含年份、季数等信息。**当资源路径中包含括号内的年份时（如 "请回答1994(2025)"），括号前的所有文本（包括数字 "1994" 和文字 "请回答"）都应合并作为 name 字段，即 "请回答1994"。**
                2. 资源路径：包含影视剧的主要信息，**如果资源路径中同时包含普通年份和括号内的年份（如 "请回答1994(2025)"），请优先提取括号内的年份作为最终年份。**
                3. 文件夹列表：需要标准化的文件夹信息

                文件夹命名规则：
                1. 常规季度：仅当文件夹名称明确表示季度时（如 "第一季", "第1季", "S1", "Season1" 等），统一使用 "Season XX" 格式，XX 必须是两位数字。
                2. 特别篇/OVA：仅当文件夹名称明确表示特别篇时（如 "特别篇", "SP", "OVA" 等），统一使用 "特别篇XX" 格式，XX 必须是两位数字。
                3. **保留原始名称：如果文件夹名称不符合上述任何一种可识别的季/特别篇格式（例如，像 '1-100', '合集', 'Extras' 这样的名称），则必须在返回结果中保留其原始名称，绝对不要将其转换为 "Season XX" 或 "特别篇XX"。**
                4. 其他格式转换示例（仅适用于明确表示季/特别篇的情况）：
                   - "第一季" -> "Season 01"
                   - "第1季" -> "Season 01"
                   - "S1" -> "Season 01"
                   - "Season1" -> "Season 01"
                   - "特别篇" -> "特别篇01"
                   - "SP" -> "特别篇01"
                   - "OVA" -> "特别篇01"

                返回格式必须是: {
                    name: string,  // 纯净的影视剧名称，不含年份
                    year: number,  // 年份信息
                    type: "tv" | "movie",  // 资源类型
                    folders: [{    // 标准化后的文件夹列表
                        id: string,
                        name: string  // 标准化后的文件夹名称 (或原始名称)
                    }]
                }
                注意事项：
                1. 不要使用代码块标记，直接返回 JSON 对象
                2. 文件夹名称必须严格按照此格式返回，不要添加任何额外说明文字
                3. 不要对文件名内容做任何主观评判，专注于格式解析
                `
            },
            {
                role: 'user',
                content: `资源路径：${resourcePath}\n文件夹列表：${JSON.stringify(dirs, null, 2)}`
            }
        ];
        const response = await this.chat(messages, {
            temperature: 0.1,
            max_tokens: 3000
        });

        if (response.success) {
            try {
                let cleanData = response.data
                    .replace(/```(?:json)?\s*|\s*```/g, '')
                    .replace(/^(?:json)?\s*/, '')
                    .trim();
                const result = JSON.parse(cleanData);
                if (!this._validateFolderResponse(result)) {
                    throw new Error('AI返回格式不符合要求');
                }
                return {
                    success: true,
                    data: result
                };
            } catch (error) {
                logger.warn('AI 解析结果格式错误', { response: response.data })
                return {
                    success: false,
                    error: '解析结果格式错误'
                };
            }
        }
        return response;
    }

    async simpleChatCompletion(resourcePath, files) {
        const CHUNK_SIZE = 40; // 每次处理的文件数量
        let allEpisodes = [];
        let baseResult = null;

        if (!this.isEnabled()) {
            return { success: false, error: 'AI服务未配置或未启用' };
        }

        try {
            for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                const chunk = files.slice(i, i + CHUNK_SIZE);
                let messages;

                if (i === 0) {
                    // 第一次调用，获取基础信息和第一批剧集
                    messages = [
                        {
                            role: 'system',
                            content: `你是一个专业的影视剧文件名解析助手。你的任务是客观地解析文件名和文件夹名，不要对内容做主观判断。
                            无论文件名的内容是什么，都要尽可能提取以下信息：
                            1. name 字段必须是纯净的影视剧名称，不能包含年份、季数等信息
                            2. 所有年份信息必须提取到 year 字段中
                            3. 如果无法确定年份，返回0, 如果无法确定季编号, 返回01
                            4. 如果无法判断类型，默认为 movie
                            5. 如果是单个文件，episode 数组只包含一个元素

                            返回格式必须是: {
                                name: string,  // 纯净的影视剧名称，不含年份
                                year: number,  // 提取的年份信息
                                type: "tv" | "movie",
                                season: string,  // 季编号，必须是纯数字字符串，如："01"
                                episode: [{ // 仅包含当前处理的 chunk 的剧集信息
                                    id: string,
                                    name: string, // 使用父级目录中提取到的纯净的影视剧名称，不含年份
                                    season: string,  // 季编号，必须是纯数字字符串，如："01"
                                    episode: string,  // 集编号，如果小于100使用两位数字（如："01"），大于等于100使用实际位数
                                    extension: string
                                }]
                            }

                            注意事项：
                            1. 季和剧集编号的格式规则：
                               - 如果编号小于100，使用两位数字格式（如：'01', '99'）
                               - 如果编号大于等于100，保持实际位数（如：'100', '1000'）
                               - 不要包含'S'或'E'前缀
                            2. 如果无法确定季编号, 返回01
                            3. 每个剧集必须包含名称：
                                 * 优先使用所在文件夹的纯净的影视剧名称，不能包含年份、季数等信息
                                 * 保留纯粹的剧集名称，确保与文件夹名称保持一致
                            2. 文件扩展名必须包含点号（如：'.mkv', '.mp4'）。
                            5. 年份必须是数字类型
                            6. 必须严格按照此格式返回，不要添加任何额外说明文字
                            7. 不要使用代码块标记，直接返回 JSON 对象
                            8. 不要对文件名内容做任何主观评判，专注于格式解析`
                        },
                        {
                            role: 'user',
                            content: `资源路径：${resourcePath}\n文件列表：${JSON.stringify(chunk, null, 2)}`
                        }
                    ];
                } else {
                    // 后续调用，只处理文件，使用第一次获取的基础信息
                    messages = [
                        {
                            role: 'system',
                            content: `你是一个专业的影视剧文件名解析助手。基于以下信息，请解析提供的文件列表：
                            影视剧名称: ${baseResult.name}
                            年份: ${baseResult.year}
                            类型: ${baseResult.type}
                            季编号: ${baseResult.season || 'N/A'} // 提供季编号上下文

                            返回格式必须是**严格的 JSON 对象**，包含一个 'episode' 键，其值为一个数组。数组中的每个对象代表一个剧集信息。**确保所有键（如 "id", "name", "season", "episode", "extension"）都用双引号括起来**：
                            {
                                "episode": [{ // 仅包含当前处理的 chunk 的剧集信息
                                    "id": "string",
                                    "name": "${baseResult.name}", // 使用上面提供的影视剧名称，不能包含年份
                                    "season": "${baseResult.season || ''}",  // 使用上面提供的季编号 (确保是字符串)
                                    "episode": "string",  // 集编号，如果小于100使用两位数字（如："01"），大于等于100使用实际位数
                                    "extension": "string"
                                }]
                            }

                            注意事项：
                            1. 集编号的格式规则：
                               - 如果编号小于100，使用两位数字格式（如：'01', '99'）
                               - 如果编号大于等于100，保持实际位数（如：'100', '1000'）
                            2. 文件扩展名必须包含点号（如：'.mkv', '.mp4'）。
                            3. **必须严格按照上述 JSON 格式返回，确保所有键和字符串值都使用双引号。**
                            4. 必须严格按照此格式返回，不要添加任何额外说明文字。
                            5. 不要使用代码块标记，直接返回 JSON 对象
                            6. 只需要返回 'episode' 字段。`
                        },
                        {
                            role: 'user',
                            content: `文件列表：${JSON.stringify(chunk, null, 2)}`
                        }
                    ];
                }

                const response = await this.chat(messages, {
                    temperature: 0.1,
                    max_tokens: 3000 // 保持足够空间处理块
                });

                if (!response.success) {
                    throw new Error(`AI 调用失败 (块 ${i / CHUNK_SIZE + 1}): ${response.error}`);
                }

                let cleanData = response.data
                    .replace(/```(?:json)?\s*|\s*```/g, '')
                    .replace(/^(?:json)?\s*/, '')
                    .trim();
                const resultChunk = JSON.parse(cleanData);

                if (i === 0) {
                    // 存储第一次的基础信息
                    baseResult = {
                        name: resultChunk.name,
                        year: resultChunk.year,
                        type: resultChunk.type,
                        season: resultChunk.season // 存储季编号
                    };
                    if (!resultChunk.episode || !Array.isArray(resultChunk.episode)) {
                        throw new Error(`AI 返回格式错误 (块 1): 缺少 'episode' 数组`);
                    }
                    allEpisodes.push(...resultChunk.episode);
                } else {
                    if (!resultChunk.episode || !Array.isArray(resultChunk.episode)) {
                        throw new Error(`AI 返回格式错误 (块 ${i / CHUNK_SIZE + 1}): 缺少 'episode' 数组`);
                    }
                    // 对于后续块，确保 episode 里的 name 和 season 与 baseResult 一致
                    const correctedEpisodes = resultChunk.episode.map(ep => ({
                        ...ep,
                        name: baseResult.name, // 强制使用基础名称
                        season: baseResult.season // 强制使用基础季编号
                    }));
                    allEpisodes.push(...correctedEpisodes);
                }
            }

            // 组合最终结果
            const finalResult = { ...baseResult, episode: allEpisodes };

            // 验证最终结果
            if (!this._validateResponse(finalResult)) {
                logger.warn('最终 AI 解析结果格式错误', { finalResult })
                throw new Error('最终 AI 返回格式不符合要求');
            }

            return {
                success: true,
                data: finalResult
            };

        } catch (error) {
            logger.error('AI simpleChatCompletion 处理出错', { error: error.message, stack: error.stack });
            return {
                success: false,
                error: error.message || '处理文件名解析时发生未知错误'
            };
        }
    }

    async filterMediaFiles(resourceName, files, filterDescription) {
        if (!this.isEnabled()) {
            return { success: false, error: 'AI服务未配置或未启用' };
        }
        if (!filterDescription) {
            logTaskEvent('AI过滤：无过滤描述，跳过AI调用');
            return { success: false, error: '缺少过滤描述' };
        }
        if (!files || files.length === 0) {
            logTaskEvent('AI过滤：文件列表为空，无需过滤');
            return { success: true, data: [] }; // 返回空数组
        }

        const CHUNK_SIZE = 50; // 定义每次处理的文件数量 (根据需要调整)
        let allKeptFileIds = []; // 用于收集所有需要保留的文件 ID

        try {
            logTaskEvent(`AI过滤：开始处理 ${files.length} 个文件，分块大小 ${CHUNK_SIZE}`);
            for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                const chunk = files.slice(i, i + CHUNK_SIZE);
                const chunkNumber = i / CHUNK_SIZE + 1;
                logTaskEvent(`AI过滤：处理块 ${chunkNumber}...`);

                const messages = [
                    {
                        role: 'system',
                        content: `你是一个智能文件筛选助手。你的任务是根据用户提供的中文自然语言描述，筛选一个影视剧文件列表，并只返回需要保留的文件的 ID。

                        输入:
                        1. resourceName: 媒体资源的名称 (例如：电影标题、剧集名称)。
                        2. files: 一个文件对象数组，每个对象包含 'id' 和 'name' 字段。
                        3. filterDescription: 一个中文字符串，描述了筛选规则。

                        **处理逻辑:**
                        1.  **理解规则:** 仔细分析 'filterDescription' 以确定筛选标准。规则可能涉及：
                            *   **文件名包含/不包含特定文本:** 例如 "包含 '特效'" 或 "不包含 '预告'"。
                            *   **剧集编号比较:** 例如 "剧集号大于 10", "集数小于等于 5"。
                        2.  **提取信息 (如果需要):**
                            *   对于涉及**剧集编号**的规则，你需要从每个文件的 'name' 字段中提取剧集编号。常见的剧集编号格式包括：
                                *   \`SxxExx\` (例如 \`S01E05\` -> 剧集号是 5)
                                *   \`第 xx 集\` (例如 \`第 12 集\` -> 剧集号是 12)
                                *   单独的数字，如果上下文清晰 (例如 \`Episode 03\` -> 剧集号是 3)
                            *   **优先识别 \`SxxExx\` 格式中的 \`Exx\` 部分。如果不存在，再尝试识别 \`第 xx 集\` 格式。** 提取出的剧集号应为**数字**。
                        3.  **应用规则:** 将提取的信息（或完整文件名）与 'filterDescription' 中的条件进行比较。
                            *   对于剧集编号比较，请进行**数值比较** (例如，判断 12 是否大于 3)。
                        4.  **筛选:** 保留所有满足 'filterDescription' 条件的文件。

                        输出:
                        返回一个 JSON 数组，其中只包含满足条件的原 'files' 数组中文件的 **ID 字符串**。

                        示例输入 1 (文本匹配):
                        resourceName: "我的剧集 第一季"
                        files: [
                          { "id": "file_1", "name": "我的剧集 S01E01.mkv" },
                          { "id": "file_2", "name": "我的剧集 S01E02.mkv" },
                          { "id": "file_3", "name": "我的剧集 S01E03.特效版.mkv" }
                        ]
                        filterDescription: "筛选出文件名不包含 '特效版' 的文件"
                        示例输出 1:
                        [
                          "file_1",
                          "file_2"
                        ]

                        示例输入 2 (剧集号比较):
                        resourceName: "君子无疾 (2025)"
                        files: [
                          { "id": "id_1", "name": "君子无疾 - S01E01 - 第 1 集.mp4" },
                          { "id": "id_2", "name": "君子无疾 - S01E02 - 第 2 集.mp4" },
                          { "id": "id_3", "name": "君子无疾 - S01E03 - 第 3 集.mp4" },
                          { "id": "id_4", "name": "君子无疾 - S01E04 - 第 4 集.mp4" }
                        ]
                        filterDescription: "筛选出 剧集 大于 2 的文件"
                        示例输出 2:
                        [
                          "id_3",
                          "id_4"
                        ]


                        指令:
                        - 严格遵循上述处理逻辑。
                        - 仅返回满足条件的文件的 **ID 字符串** 组成的 JSON 数组。
                        - 输出必须是有效的 JSON 数组格式，数组元素必须是字符串。
                        - 不要在输出中包含任何解释性文字或 Markdown 格式，只需返回纯粹的 JSON 数组。`
                    },
                    {
                        role: 'user',
                        content: `resourceName: "${resourceName}"\nfiles: ${JSON.stringify(chunk, null, 2)}\nfilterDescription: "${filterDescription}"`
                    }
                ];

                logTaskEvent(`AI过滤：调用AI处理块 ${chunkNumber}，描述: ${filterDescription}`);
                const response = await this.chat(messages, {
                    temperature: 0.1,
                    max_tokens: 2000 // 调整 max_tokens 以适应 ID 列表的输出
                });

                if (!response.success) {
                    logTaskEvent(`AI过滤：处理块 ${chunkNumber} 失败 - ${response.error}`);
                    throw new Error(`AI 调用失败 (块 ${chunkNumber}): ${response.error}`);
                }

                try {
                    let cleanData = response.data
                        .replace(/```(?:json)?\s*|\s*```/g, '')
                        .replace(/^(?:json)?\s*/, '')
                        .trim();
                    const resultChunk = JSON.parse(cleanData);

                    if (!Array.isArray(resultChunk) || !resultChunk.every(id => typeof id === 'string' || typeof id === 'number')) {
                        logTaskEvent(`AI过滤：块 ${chunkNumber} 返回格式错误，期望得到 ID 字符串或数字数组。原始数据: ${response.data}`);
                        throw new Error(`AI 返回格式错误 (块 ${chunkNumber}): 期望得到 ID 字符串或数字数组`);
                    }

                    logTaskEvent(`AI过滤：块 ${chunkNumber} 成功解析，得到 ${resultChunk.length} 个文件 ID。`);
                    allKeptFileIds.push(...resultChunk); // 合并当前块的结果

                } catch (error) {
                    logTaskEvent(`AI过滤：解析块 ${chunkNumber} 响应失败 - ${error.message}。原始数据: ${response.data}`);
                    logger.error('AI filterMediaFiles 解析块结果格式错误', { chunkNumber, error: error.message, response: response.data });
                    // 抛出错误中断整个过滤过程
                    throw new Error(`解析AI过滤结果格式错误 (块 ${chunkNumber}): ${error.message}`);
                }
            } // end for loop

            logTaskEvent(`AI过滤：所有块处理完成，总共保留 ${allKeptFileIds.length} 个文件 ID。`);
            // 注意：这里返回的是 ID 列表，而不是完整的文件对象列表
            // 在 task.js 中需要根据这个 ID 列表去过滤原始的 fileList
            return {
                success: true,
                data: allKeptFileIds
            };

        } catch (error) {
            // 捕获循环中或 chat 调用中的错误
            logTaskEvent(`AI过滤：处理过程中发生错误 - ${error.message}`);
            logger.error('AI filterMediaFiles 处理出错', { error: error.message, stack: error.stack });
            return {
                success: false,
                error: error.message || '处理文件过滤时发生未知错误'
            };
        }
    }



    async streamChat(message, onChunk) {
        try {
            const openaiConfig = ConfigService.getConfigValue('openai')
            if (!this.isEnabled(openaiConfig)) {
                throw new Error('AI服务未配置或未启用');
            }
            const apiKey = openaiConfig?.apiKey;
            const baseURL = openaiConfig?.baseUrl || 'https://api.openai.com/v1';
            const model = openaiConfig?.model || 'gpt-3.5-turbo';

            const response = await got.post(`${baseURL}/chat/completions`, {
                json: {
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: message
                        }
                    ],
                    stream: true,
                    ...this.defaultConfig
                },
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                responseType: 'text',
                isStream: true
            });

            // 处理流式响应
            for await (const chunk of response) {
                try {
                    const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                    for (const line of lines) {
                        if (line.includes('[DONE]')) continue;
                        if (line.startsWith('data: ')) {
                            const data = JSON.parse(line.slice(5));
                            if (data.choices[0].delta?.content) {
                                onChunk(data.choices[0].delta.content);
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('处理AI流响应块出错', { error: error.message, stack: error.stack });
                }
            }
            // 所有块处理完成后，发送结束标识
            onChunk('[END]');
        } catch (error) {
            logger.error('AI 流式服务调用失败', { error: error.message, stack: error.stack });
            throw error;
        }
    }


    _validateResponse(result) {
        // 基础验证
        const baseValid = result.name &&
            typeof result.year === 'number' &&
            ['tv', 'movie'].includes(result.type) &&
            Array.isArray(result.episode);
        // 如果基础验证失败，直接返回 false
        if (!baseValid) return false;
        // 根据类型验证剧集信息
        return result.episode.every(ep => {
            return ep.id &&
                ep.extension?.startsWith('.') &&
                (result.type !== 'tv' || ep.episode);  // 只在 tv 类型时验证 episode
        });
    }

    _validateFolderResponse(result) {
        // 基础验证
        const baseValid = result.name &&
            typeof result.year === 'number' &&
            ['tv', 'movie'].includes(result.type);

        if (!baseValid) return false;

        // 如果存在 folders 才进行文件夹验证
        if (result.folders) {
            return Array.isArray(result.folders) && result.folders.every(folder =>
                folder.id &&
                folder.name
            );
        }

        return true;
    }
}

const defaultInstance = new AIService();
defaultInstance.AIService = AIService;

// ─── 移动 AI 兜底：prompt 拼装与本地提取（纯函数，供 Jest 直接测试） ──────────

function cleanNoUrl(s) {
    if (!s) return '';
    return String(s)
        .replace(/https?:\/\/[^\s]+/g, ' ')
        .replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 人类化提问模板（优化定稿：精炼5点回答，严禁闲聊剧情，杜绝冗余长篇，保障秒级响应）
 * @param {string} text 待识别影视文本或目录名
 * @param {object} context { folderNames, fileNames, linkName }
 * @returns {string}
 */
function buildHumanDialogue(text, context = {}) {
    const cleanText = cleanNoUrl(text);
    const lines = [
        '你是一个专业的影视剧命名与信息提取专家。请对以下纯文本影视资源信息进行精准语义提纯与标准化归档：',
        '【极重要说明】本任务仅为纯文本语义分析，无需也严禁尝试访问任何外部网络链接或文件。'
    ];
    if (cleanText) {
        lines.push(`待识别影视文本：${cleanText}`);
    }
    const folders = (Array.isArray(context.folderNames) ? context.folderNames : [])
        .map(cleanNoUrl)
        .filter(Boolean)
        .slice(0, 3);
    if (folders.length) {
        lines.push(`所在目录：${folders.join(' / ')}`);
    }
    const rawFiles = context.fileNames || (context.fileName ? [context.fileName] : []) || (context.files ? context.files.map(f => f?.name || f?.fileName || f) : []) || [];
    const files = (Array.isArray(rawFiles) ? rawFiles : [rawFiles])
        .map(f => typeof f === 'string' ? f : (f?.name || f?.fileName || ''))
        .map(cleanNoUrl)
        .filter(Boolean)
        .slice(0, 4);
    if (files.length) {
        lines.push(`待识别文件名：${files.join('、')}`);
    }
    const cleanLink = cleanNoUrl(context.linkName);
    if (cleanLink) {
        lines.push(`分享标题：${cleanLink}`);
    }

    const hasCandidates = Array.isArray(context.tmdbCandidates) && context.tmdbCandidates.length > 0;
    const hasSingleTmdb = Boolean(context.tmdbInfo && !hasCandidates);

    if (hasCandidates) {
        lines.push('');
        lines.push('【TMDB 官方权威候选数据（系统实时检索）】');
        context.tmdbCandidates.forEach((c, idx) => {
            const title = c.title || c.name || '';
            const id = c.id || '';
            const year = c.year || (c.first_air_date || c.release_date || '').slice(0, 4) || '未知';
            const mType = c.mediaType || (c.first_air_date ? '日番/国漫/剧集' : '电影');
            lines.push(`候选 ${idx + 1}: 《${title}》 (TMDB ID: ${id}, 首播年份: ${year}, 类别: ${mType})`);
            if (c.overview) {
                const shortOverview = c.overview.length > 70 ? c.overview.slice(0, 68) + '...' : c.overview;
                lines.push(`  - 简介: ${shortOverview}`);
            }
            if (Array.isArray(c.seasons) && c.seasons.length > 0) {
                const seasonSummary = c.seasons
                    .filter(s => (s.season_number ?? s.seasonNumber) >= 0)
                    .map(s => `第 ${s.season_number ?? s.seasonNumber} 季 (${s.episode_count || 0}集${s.air_date ? `，首播: ${s.air_date}` : ''})`)
                    .join('；');
                if (seasonSummary) {
                    lines.push(`  - 官方分季: ${seasonSummary}`);
                }
            }
        });
    } else if (hasSingleTmdb) {
        const info = context.tmdbInfo;
        lines.push('');
        lines.push('【TMDB 官方权威分季参考数据（接口实时获取）】');
        if (info.title) lines.push(`- 官方标准片名：《${info.title}》${info.id ? ` (TMDB ID: ${info.id})` : ''}`);
        if (info.year) lines.push(`- 官方首播年份：${info.year}`);
        if (Array.isArray(info.seasons) && info.seasons.length > 0) {
            lines.push('- 官方各季列表：');
            for (const s of info.seasons) {
                const sNum = s.season_number;
                const epCount = s.episode_count ?? s.episodeCount ?? 0;
                const airDate = s.air_date ? `，首播: ${s.air_date}` : '';
                const sName = s.name ? ` [${s.name}]` : '';
                lines.push(`  * 第 ${sNum} 季${sName}：共 ${epCount} 集${airDate}`);
            }
        }
    }

    lines.push('');
    if (hasCandidates || hasSingleTmdb) {
        lines.push('【消歧比对与输出指令】请将上述待识别文本与 TMDB 官方候选进行精准消歧比对，直接且仅按如下5行格式输出核心结论，严禁输出任何小说剧情背景、人物身世、制作公司、播放量或观看建议：');
        lines.push('【候选不符豁免铁律】若待识别影视名称与上述 TMDB 候选完全不相符（如纯拼音或错误人名匹配），严禁强行挂靠错误条目，请直接以待识别文本的真实中文片名为准输出。');
        lines.push('【专有条目消歧匹配铁律】若待识别名称中明确包含某个候选条目的专属副标题、篇章名或限定词（例如“比鲁斯”），且上述 TMDB 候选库中存在完全对应的独立条目（例如《龙珠超：比鲁斯》），必须精准选择该专有独立条目，严禁擅自去除后缀退化降级为泛指主条目（如《龙珠超》）。');
        lines.push('1. 官方片名：《标准中文名》（若为专有独立条目必须保留官方完整片名，绝不要带年番、第X季、年份等后缀）');
        lines.push('2. 影视类别：国漫 / 日番 / 国产剧 / 日韩剧 / 欧美剧 / 电影 / 综艺 / 纪录片');
        lines.push('3. 首播年份：YYYY（所选 TMDB 候选条目的官方首播年份，4位纯数字）');
        lines.push('4. 当前归属：若为剧集请输出“第X季”（特别篇为第0季）；若为电影/剧场版/独立影片，当前归属必须输出“电影”，严禁归入第0季或剧集！');
        lines.push('5. 判定依据：一句话简要理由（不超过25字）');
    } else {
        lines.push('【语义提纯与输出指令】请根据待识别影视文本进行纯文本语义分析与规范命名，直接且仅按如下5行格式输出核心结论，严禁输出任何小说剧情背景、人物身世、制作公司、播放量或观看建议：');
        lines.push('1. 官方片名：《标准中文名》（只写标准中文片名，绝不要带年番、第X季、年份等后缀）');
        lines.push('2. 影视类别：国漫 / 日番 / 国产剧 / 日韩剧 / 欧美剧 / 电影 / 综艺 / 纪录片');
        lines.push('3. 首播年份：YYYY（该作品官方首播年份，4位纯数字）');
        lines.push('4. 当前归属：若为剧集请输出“第X季”（特别篇为第0季，无法确定默认为第1季）；若为电影/剧场版/独立影片，当前归属必须输出“电影”，严禁归入第0季或剧集！');
        lines.push('5. 判定依据：一句话简要理由（不超过25字）');
    }
    return lines.join('\n');
}

/** 中文季数词 → 数字（一~九十九内） */
function parseCnSeason(s) {
    if (s === undefined || s === null) return null;
    const str = String(s).trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (str === '十') return 10;
    if (/^十[一二三四五六七八九]$/.test(str)) return 10 + CN[str[1]];
    if (/^[一二三四五六七八九]十$/.test(str)) return CN[str[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(str)) return CN[str[0]] * 10 + CN[str[2]];
    if (CN[str] !== undefined) return CN[str];
    return null;
}

/**
 * 灵犀自然语言回复 → 结构化影视条目（本地正则提取，方案 §2.3）
 * - 片名：《》首个匹配，剥离"第X季"后缀
 * - 首播年："第一季/首播/播出"锚点 ±20~30 字符窗口内的 4 位年份
 * - 季数："第X季"词频统计取最高
 * @param {string} reply 灵犀回复全文
 * @returns {{ title: string, year: string, season: number|null, category: string, mediaType: string, reason?: string }|null}
 */
function extractMediaFromReply(reply, context = {}) {
    const text = String(reply || '').trim();
    if (!text) return null;

    // 1. 结构化行优先解析片名
    let title = '';
    const quoteTitle = text.match(/(?:(?:\*{1,2}|【)?\s*(?:官方片名|片名)\s*(?:\*{1,2}|】)?)[：:\s]*《([^》\r\n]+)》/i);
    if (quoteTitle && quoteTitle[1].trim()) {
        title = quoteTitle[1].replace(/^[】\]\s*]+/, '').replace(/[*#`_]/g, '').trim();
    } else {
        const lineTitle = text.match(/(?:(?:\*{1,2}|【)?\s*(?:官方片名|片名)\s*(?:\*{1,2}|】)?)[：:\s]*([^》\n\r]+)/i);
        if (lineTitle && lineTitle[1].trim()) {
            title = lineTitle[1].replace(/^[《】\]\s*]+/, '').replace(/[》\s*]+$/, '').replace(/[*#`_]/g, '').trim();
        } else {
            const tm = text.match(/《([^》]{1,40})》/);
            if (tm && tm[1]) {
                title = tm[1]
                    .replace(/第\s*[一二三四五六七八九十\d]{1,3}\s*季.*$/, '')
                    .replace(/\s*第\s*部.*$/, '')
                    .trim();
            }
        }
    }
    if (!title) return null;

    let year = '';
    let matchedCandidate = null;
    let tmdbId = null;

    // 优先匹配 TMDB 官方候选条目库，实现精准对齐与消歧
    if (Array.isArray(context.tmdbCandidates) && context.tmdbCandidates.length > 0) {
        const { RecognitionEngine } = require('./RecognitionEngine');
        const normTitle = RecognitionEngine.normalizeTitleKey(title);
        matchedCandidate = context.tmdbCandidates.find(c => {
            const cTitle = c.title || c.name || '';
            const normC = RecognitionEngine.normalizeTitleKey(cTitle);
            return normTitle === normC || cTitle === title;
        });
        if (!matchedCandidate) {
            matchedCandidate = context.tmdbCandidates.find(c => {
                const cTitle = c.title || c.name || '';
                const normC = RecognitionEngine.normalizeTitleKey(cTitle);
                return (normTitle.length >= 2 && normC.includes(normTitle)) || (normC.length >= 2 && normTitle.includes(normC));
            });
        }
        if (matchedCandidate) {
            title = (matchedCandidate.title || matchedCandidate.name || title).trim();
            if (matchedCandidate.year || matchedCandidate.first_air_date || matchedCandidate.release_date) {
                year = String(matchedCandidate.year || (matchedCandidate.first_air_date || matchedCandidate.release_date || '').slice(0, 4) || '');
            }
            tmdbId = String(matchedCandidate.id);
            if (Array.isArray(matchedCandidate.seasons) && matchedCandidate.seasons.length > 0) {
                context.tmdbInfo = {
                    id: matchedCandidate.id,
                    title: matchedCandidate.title || matchedCandidate.name,
                    year,
                    seasons: matchedCandidate.seasons
                };
            }
        }
    } else if (context.tmdbInfo?.id) {
        tmdbId = String(context.tmdbInfo.id);
    }

    // 2. 首播年：结构化行优先，回退邻近窗口（若尚未从 TMDB 候选获取）
    if (!year) {
        const lineYear = text.match(/(?:(?:\*{1,2}|【)?\s*(?:首播年份|首播年|首播时间|第一季播出时间)\s*(?:\*{1,2}|】)?)[：:\s]*((?:19|20)\d{2})/i);
        if (lineYear && lineYear[1]) {
            year = lineYear[1];
        } else {
            const anchorIdx = text.search(/第一季|首播|开播/);
            if (anchorIdx >= 0) {
                const win = text.slice(Math.max(0, anchorIdx - 20), anchorIdx + 30);
                const ym = win.match(/((?:19|20)\d{2})\s*年/) || win.match(/((?:19|20)\d{2})/);
                if (ym) year = ym[1];
            }
        }
    }

    // 3. 季数：结构化行优先，回退消歧与 TMDB 官方分季比对
    let season = null;
    const lineSeason = text.match(/(?:(?:\*{1,2}|【)?\s*(?:当前归属|归属季号|季数|所属季)\s*(?:\*{1,2}|】)?)[：:\s]*第?\s*([0-9零一二两三四五六七八九十]+)\s*季/i);
    if (lineSeason) {
        season = parseCnSeason(lineSeason[1]);
    }
    if (season === null) {
        const tmdbSeasonMatch = text.match(/(?:TMDB|对应|归属)[^，。；\n\r]*第\s*([0-9零一二两三四五六七八九十]+)\s*季/i);
        if (tmdbSeasonMatch) {
            season = parseCnSeason(tmdbSeasonMatch[1]);
        }
    }

    // 若存在 TMDB 官方分季元数据，优先通过官方数据驱动消歧（完全数据驱动，零片名硬编码）
    if (context.tmdbInfo && Array.isArray(context.tmdbInfo.seasons)) {
        const validSeasons = context.tmdbInfo.seasons.filter(s => (s.season_number ?? s.seasonNumber) > 0);
        // A. 若文本或上下文指向年番，且 TMDB 存在明确名为“年番”的官方季
        const isYearly = /(?:年番|每周更新)/.test(text) || /(?:年番)/.test(context.folderName || '');
        if (isYearly) {
            const yearSeason = validSeasons.find(s => (s.name && s.name.includes('年番')));
            if (yearSeason) {
                season = Number(yearSeason.season_number ?? yearSeason.seasonNumber);
            }
        }
        // B. 若 TMDB 官方仅有唯一定义的一季（例如长篇大动漫全量对应第1季）
        if (validSeasons.length === 1) {
            season = Number(validSeasons[0].season_number ?? validSeasons[0].seasonNumber);
        }
        // C. 若提取到文件大集数，根据 TMDB 各季 episode_count 自动判定归属季
        if (season === null && Array.isArray(context.fileNames) && context.fileNames.length > 0) {
            const epNums = context.fileNames.map(fn => {
                const m = String(fn).match(/(?:第\s*(\d{1,4})\s*集|\b(\d{2,4})\b)/);
                return m ? parseInt(m[1] || m[2], 10) : 0;
            }).filter(n => n > 0);
            const maxEp = epNums.length > 0 ? Math.max(...epNums) : 0;
            if (maxEp > 0) {
                const fitSeason = validSeasons.find(s => (s.episode_count || 0) >= maxEp);
                if (fitSeason) {
                    season = Number(fitSeason.season_number ?? fitSeason.seasonNumber);
                }
            }
        }
    }

    // 结构化与数据驱动未命中时，才使用正文词频统计作为兜底
    if (season === null) {
        const freq = new Map();
        // 排除历史介绍干扰，如“第一季首播”、“第一季于2017年”
        const cleanText = text.replace(/第\s*[一二三四五六七八九十\d]{1,3}\s*季(?:于|\s*首播|\s*播出|\s*开播|\s*起改由)/g, '');
        const seasonRe = /第\s*([一二三四五六七八九十]{1,3}|\d{1,3})\s*季/g;
        let sm;
        while ((sm = seasonRe.exec(cleanText)) !== null) {
            const n = parseCnSeason(sm[1]);
            if (n !== null && n >= 1 && n <= 30) {
                freq.set(n, (freq.get(n) || 0) + 1);
            }
        }
        let bestN = 0, bestC = 0;
        for (const [n, c] of freq) {
            if (c > bestC || (c === bestC && n > bestN)) {
                bestN = n;
                bestC = c;
            }
        }
        if (bestC > 0) season = bestN;
    }

    // 4. 分类解析
    let category = '';
    const catMatch = text.match(/(?:(?:\*{1,2}|【)?\s*(?:影视类别|分类|类别)\s*(?:\*{1,2}|】)?)[：:\s]*([^\n\r]+)/i);
    if (catMatch) {
        for (const valid of ['国漫', '日番', '国产剧', '欧美剧', '日韩剧', '动漫', '电影', '纪录片', '综艺', '儿童']) {
            if (catMatch[1].includes(valid)) {
                category = valid;
                break;
            }
        }
    }

    // 5. 判定依据提取
    let reason = '';
    const reasonMatch = text.match(/(?:(?:\*{1,2}|【)?\s*(?:判定依据|判定理由|依据|理由)\s*(?:\*{1,2}|】)?)[：:\s]*([^\n\r]+)/i);
    if (reasonMatch) {
        reason = reasonMatch[1].replace(/^[】\]0-9.、\s*]+/, '').replace(/[*#`_]/g, '').trim();
        if (reason.length > 50) reason = reason.slice(0, 48) + '...';
    }

    // 类型：默认 tv，若属于电影/剧场版则确立为 movie 并清空季号
    const lineSeasonText = (text.match(/(?:(?:\*{1,2}|【)?\s*(?:当前归属|归属季号|季数|所属季)\s*(?:\*{1,2}|】)?)[：:\s]*([^\n\r]+)/i)?.[1] || '').trim();
    const isMovieByLine = /(?:电影|剧场版|影片)/i.test(lineSeasonText) && !/第\s*\d+\s*季/i.test(lineSeasonText);
    const isMovie = isMovieByLine || category.includes('电影') || (/(?:电影|剧场版|影片)/i.test(text) && !/(?:电视剧|剧集|第\s*\d+\s*季|集|年番)/i.test(text));
    const finalSeason = isMovie ? null : season;
    return { title, year, season: finalSeason, category, mediaType: isMovie ? 'movie' : 'tv', reason, tmdbId };
}

module.exports = defaultInstance;
module.exports.buildHumanDialogue = buildHumanDialogue;
module.exports.extractMediaFromReply = extractMediaFromReply;
module.exports.parseCnSeason = parseCnSeason;


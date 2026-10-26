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
        const stored = ConfigService.getConfigValue('channelMonitor.ai') || ConfigService.getConfigValue('ai') || ConfigService.getConfigValue('openai') || {};
        const cfg = Object.assign({}, stored, customConfig || {});
        let rawBaseUrl = (customConfig && customConfig.baseUrl !== undefined) ? customConfig.baseUrl : (cfg.baseUrl || 'http://127.0.0.1:8045/v1');
        let baseUrl = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
        return {
            enable: Boolean(cfg.enable),
            apiKey: String(cfg.apiKey || '').trim(),
            baseUrl,
            model: String(cfg.model || 'gemini-3.8-flash-tiered').trim(),
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
            logger.warn(`[AI 服务] 请求异常: ${errorDetails}`);
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
     * AI 深度解析影视元信息（支持处理混淆文件夹、Telegram 复杂推文、复杂文件名）
     * @param {string} text 待解析文本（推文正文、文件夹名、或文件名）
     * @param {object} [context] 上下文附加信息（如父目录名、文件大小）
     * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
     */
    async parseMediaInfo(text, context = {}, customConfig = null) {
        if (!text || typeof text !== 'string' || !text.trim()) {
            return { success: false, error: '解析文本为空' };
        }
        const eff = this.getEffectiveConfig(customConfig);

        // 缓存 key 加 context 哈希，防止同文本不同上下文误命中（M2）
        const contextHash = this._hashContext(context);
        const cacheKey = `ai:parse:${text.trim()}${contextHash}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return { success: true, data: cached, fromCache: true };
        }

        // 主通道未配置/未启用 → 移动 AI 兜底通道（唯一识别源，方案 §5 路径 A）
        if (!this.isEnabled(eff)) {
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

        const userContent = [
            `【待分析内容】:`,
            text.trim(),
            context.parentFolder ? `【上下文目录】: ${context.parentFolder}` : '',
            context.fileSize ? `【文件大小】: ${context.fileSize}` : ''
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

            this.cache.set(cacheKey, parsed);
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
     * context 指纹（剔除账号等与识别内容无关字段后哈希）
     * @param {object} context
     * @returns {string} 空串（无有效内容）或 "#hash10"
     */
    _hashContext(context) {
        if (!context || typeof context !== 'object') return '';
        const copy = { ...context };
        delete copy.accountId;
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

        const extracted = extractMediaFromReply(res.data.content);
        if (!extracted || !extracted.title) {
            // 兜底失败时保留原始回复进日志供人工排查（方案 §2.3）
            logger.warn('[AI 服务] 移动 AI 回复本地提取失败', { reply: res.data.content });
            return { success: false, error: '移动 AI 回复无法提取出影视条目（原始回复已入日志）' };
        }
        const data = { ...extracted, confidence: 0.6, source: 'mobile' };
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

/**
 * 人类化提问模板（方案 §2.2，实测定稿风格：口语化求助，规避技能路由与风控）
 * @param {string} text 推文正文
 * @param {object} context { folderNames, fileNames, linkName }
 * @returns {string}
 */
function buildHumanDialogue(text, context = {}) {
    const lines = [`帮我认一下这是哪部剧：${String(text || '').trim()}`];
    const folders = Array.isArray(context.folderNames) ? context.folderNames.filter(Boolean).slice(0, 3) : [];
    if (folders.length) {
        lines.push(`列表里的目录名叫：${folders.join('、')}`);
    }
    const files = Array.isArray(context.fileNames) ? context.fileNames.filter(Boolean).slice(0, 2) : [];
    if (files.length) {
        lines.push(`里面的视频文件叫：${files.join('、')}`);
    }
    if (context.linkName) {
        lines.push(`分享的名字是：${String(context.linkName).trim()}`);
    }
    // D6：显式约束 year 为"第一季首播年"，与 TMDB 口径对齐
    lines.push('顺便说说片名、第一季哪年播出、这批更到第几季了');
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
 * @returns {{ title: string, year: string, season: number|null, mediaType: string }|null}
 */
function extractMediaFromReply(reply) {
    const text = String(reply || '');
    if (!text.trim()) return null;

    // 片名
    let title = '';
    const tm = text.match(/《([^》]{1,30})》/);
    if (tm && tm[1]) {
        title = tm[1]
            .replace(/第\s*[一二三四五六七八九十\d]{1,3}\s*季.*$/, '')
            .replace(/\s*第\s*部.*$/, '')
            .trim();
    }
    if (!title) return null;

    // 首播年：锚点邻近窗口
    let year = '';
    const anchorIdx = text.search(/第一季|首播|开播/);
    if (anchorIdx >= 0) {
        const win = text.slice(Math.max(0, anchorIdx - 20), anchorIdx + 30);
        const ym = win.match(/((?:19|20)\d{2})\s*年/) || win.match(/((?:19|20)\d{2})/);
        if (ym) year = ym[1];
    }

    // 季数：词频统计（"第三季"出现频次最高 → 3）
    let season = null;
    const freq = new Map();
    const seasonRe = /第\s*([一二三四五六七八九十]{1,3}|\d{1,3})\s*季/g;
    let sm;
    while ((sm = seasonRe.exec(text)) !== null) {
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

    // 类型：默认 tv（频道监控以剧集为主），明显电影特征且无剧集特征时 movie
    const isMovie = /电影|剧场版|影片/.test(text) && !/剧|季|集/.test(text);
    return { title, year, season, mediaType: isMovie ? 'movie' : 'tv' };
}

module.exports = defaultInstance;
module.exports.buildHumanDialogue = buildHumanDialogue;
module.exports.extractMediaFromReply = extractMediaFromReply;
module.exports.parseCnSeason = parseCnSeason;


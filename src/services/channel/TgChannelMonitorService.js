'use strict';

/**
 * TgChannelMonitorService — Telegram 频道流式监控转存与媒体库整理核心服务
 *
 * 核心能力：
 * 1. 频道免登录无感流式嗅探（基于 https://t.me/s/{channel} 抓取 HTML，支持代理 ProxyUtil）；
 * 2. 139 网盘链接/密码智能提取（支持正文文本及超链接 href）；
 * 3. 双重黑名单拦截：
 *    - 文本字面黑名单：推文含关键词直接前置拦截（0 网络请求 0 网盘占用）；
 *    - TMDB 二级分类黑名单：识别后若归属黑名单分类（如“国产剧”），立即分类熔断，移入回收站并修剪空目录；
 * 4. 两级自定义暂存区：全局默认 + 频道独立覆盖，支持任意网盘自定义目录；
 * 5. 139 云盘助手 2.8.x 核心引擎对齐：结构化块级点分渲染（buildStandardTargetName）与标准媒体目录树；
 * 6. 免下载 Range 二进制探针辨伪：唯有存在 UDF 2.50 BDMV 原盘结构才准标 BluRay，杜绝伪 ISO 虚高标；
 * 7. 广告与推广说明垃圾过滤：如「ISO文件如何使用.png」等自动移入 139 回收站；
 * 8. 暂存区 0 字节自底向上修剪（sweepEmptyFolders），保持暂存区干净整洁；
 * 9. 事件驱动与流水审计（ChannelMonitorHistory，taskComplete 事件派发）。
 */

const got = require('got');
const logger = require('../../utils/logger');
const ProxyUtil = require('../../utils/ProxyUtil');
const Cloud139Utils = require('../../utils/Cloud139Utils');
const ConfigService = require('../ConfigService');
const { Cloud139Service } = require('../cloud139');
const { IsoProbeService } = require('../IsoProbeService');
const { MediaProbeService } = require('../MediaProbeService');
const { OrganizeProtectionService } = require('../OrganizeProtectionService');
const { RecognitionEngine } = require('../RecognitionEngine');
const { TMDBService } = require('../tmdb');
const { TmdbOrganizeService } = require('../TmdbOrganizeService');
const { CloudMaintenanceService } = require('../CloudMaintenanceService');
const { EventService } = require('../eventService');
const { MessageUtil } = require('../message');
const { logTaskEvent } = require('../../utils/logUtils');
const {
    getChannelMonitorRepository,
    getChannelMonitorHistoryRepository,
    getAccountRepository
} = require('../../database/index');

class TgChannelMonitorService {
    constructor() {
        this._dirCache = new Map(); // 路径缓存，避免重复递归查找建树
        this._tmdbService = new TMDBService();
        this._messageUtil = new MessageUtil();
        this._isScanning = false;
        this._isOrganizing = false;
        this._activeScanningIds = new Set();
    }

    // 全局整理任务静态互斥锁，杜绝任何并发整理重入踩踏
    static _isOrganizingRunning = false;

    /**
     * 单例获取
     */
    static getInstance() {
        if (!TgChannelMonitorService._instance) {
            TgChannelMonitorService._instance = new TgChannelMonitorService();
        }
        return TgChannelMonitorService._instance;
    }

    /**
     * 规范化频道用户名或链接
     * @param {string} input 
     * @returns {string} 频道用户名（不带 @）
     */
    static normalizeChannelUsername(input) {
        if (!input || typeof input !== 'string') return '';
        let trimmed = input.trim();
        // 匹配 https://t.me/s/xxx 或 https://t.me/xxx
        const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([a-zA-Z0-9_]+)/i);
        if (urlMatch) return urlMatch[1];
        // 匹配 @channel_name
        if (trimmed.startsWith('@')) return trimmed.slice(1);
        return trimmed.replace(/^\/+|\/+$/g, '');
    }

    /**
     * 从 Telegram Web Preview 抓取频道最新消息
     * @param {string} channelUrlOrName 
     * @param {number} [limit=10]
     * @returns {Promise<Array<object>>}
     */
    async fetchChannelPosts(channelUrlOrName, limit = 10) {
        const username = TgChannelMonitorService.normalizeChannelUsername(channelUrlOrName);
        if (!username) {
            throw new Error(`无效的 Telegram 频道地址或名称: ${channelUrlOrName}`);
        }

        const url = `https://t.me/s/${username}`;
        const timeoutMs = ConfigService.getConfigValue('channelMonitor.requestTimeout', 10000);
        const proxyAgent = ProxyUtil.getProxyAgent('telegram');

        logger.info(`[频道监控] 正在抓取频道推文: ${url}`);
        let html = '';
        try {
            const res = await got(url, {
                agent: proxyAgent,
                timeout: { connect: 5000, request: timeoutMs },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                }
            });
            html = res.body;
        } catch (err) {
            logger.error(`[频道监控] 抓取频道推文失败 [${url}]: ${err.message}`);
            throw err;
        }

        return TgChannelMonitorService.parseTelegramHtml(html, username, limit);
    }

    /**
     * 解析 Telegram 网页版 HTML 提取推文列表
     * @param {string} html 
     * @param {string} username 
     * @param {number} limit 
     * @returns {Array<object>}
     */
    static parseTelegramHtml(html, username, limit = 10) {
        if (!html) return [];
        const posts = [];

        // 按 data-post 分割或查找消息卡片
        const postSplitRegex = /data-post="([^"/]+)\/(\d+)"/g;
        let match;
        const indices = [];

        while ((match = postSplitRegex.exec(html)) !== null) {
            indices.push({
                channel: match[1],
                messageId: parseInt(match[2], 10),
                startIndex: match.index
            });
        }

        for (let i = 0; i < indices.length; i++) {
            const curr = indices[i];
            const nextIndex = (i + 1 < indices.length) ? indices[i + 1].startIndex : html.length;
            const block = html.slice(curr.startIndex, nextIndex);

            // 提取正文文本内容
            let text = '';
            const links = [];
            const textMatch = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            if (textMatch) {
                const rawContent = textMatch[1];
                // 提取所有 a href 链接
                const hrefRegex = /href="([^"]+)"/gi;
                let hrefMatch;
                while ((hrefMatch = hrefRegex.exec(rawContent)) !== null) {
                    const h = hrefMatch[1];
                    if (h && !h.startsWith('tg://') && !h.startsWith('#')) {
                        links.push(h);
                    }
                }
                // 清洗 HTML 标签，换行符保留，清洗各类 HTML 实体与特殊空白
                text = Cloud139Utils.normalizeEntitiesAndSpaces(
                    rawContent
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                ).trim();
            }

            // 提取发布时间
            let dateStr = '';
            const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/i);
            if (timeMatch) dateStr = timeMatch[1];

            posts.push({
                channel: curr.channel || username,
                messageId: curr.messageId,
                postUrl: `https://t.me/${curr.channel || username}/${curr.messageId}`,
                text,
                links,
                date: dateStr ? new Date(dateStr) : new Date()
            });
        }

        // 按 messageId 从旧到新排序（保证顺序转存）
        posts.sort((a, b) => a.messageId - b.messageId);

        // 如果条目超出 limit，截取最新的 limit 条
        if (posts.length > limit) {
            return posts.slice(posts.length - limit);
        }
        return posts;
    }

    /**
     * 从文本或外链中嗅探 139 移动云盘分享链接
     * @param {string} text 
     * @param {Array<string>} [links=[]]
     * @returns {{ linkID: string, passwd: string, shareUrl: string }|null}
     */
    static sniff139Links(text = '', links = []) {
        const cleanText = Cloud139Utils.normalizeEntitiesAndSpaces(text);
        const extractPassword = (srcText) => {
            if (!srcText) return '';
            const pwdPatterns = [
                /(?:提取码|密码|访问码|pwd|code)[：:\s]+([a-zA-Z0-9]{4,8})/i,
                /[（(](?:提取码|密码|访问码|pwd|code)[：:\s]*([a-zA-Z0-9]{4,8})[）)]/i
            ];
            for (const pattern of pwdPatterns) {
                const m = srcText.match(pattern);
                if (m) return m[1];
            }
            return '';
        };

        // 1. 优先从 links 集合中探测
        for (const link of links) {
            try {
                if (link.includes('139.com')) {
                    const parsed = Cloud139Utils.parseShareLink(link);
                    if (parsed && parsed.linkID) {
                        // 尝试从 text 中补全提取码
                        let pwd = parsed.passwd || '';
                        if (!pwd && cleanText) {
                            pwd = extractPassword(cleanText);
                        }
                        return { linkID: parsed.linkID, passwd: pwd, shareUrl: link };
                    }
                }
            } catch (_) {
                // 忽略单条链接解析失败
            }
        }

        // 2. 从正文中提取完整分享链接
        if (cleanText) {
            const extracted = Cloud139Utils.extractFromShareText(cleanText);
            if (extracted && extracted.url) {
                try {
                    const parsed = Cloud139Utils.parseShareLink(extracted.url);
                    if (parsed && parsed.linkID) {
                        return {
                            linkID: parsed.linkID,
                            passwd: parsed.passwd || extracted.passwd || extractPassword(cleanText),
                            shareUrl: extracted.url
                        };
                    }
                } catch (_) {}
            }

            // 3. 正则搜索匹配 139 网址
            const rawMatch = cleanText.match(/https?:\/\/(?:yun|caiyun)\.139\.com\/[^\s<>"'`]+/i);
            if (rawMatch) {
                try {
                    const parsed = Cloud139Utils.parseShareLink(rawMatch[0]);
                    if (parsed && parsed.linkID) {
                        const pwd = parsed.passwd || extractPassword(cleanText);
                        return { linkID: parsed.linkID, passwd: pwd, shareUrl: rawMatch[0] };
                    }
                } catch (_) {}
            }

            // 4. 正则搜索匹配 /w/i/ 或 /m/i/ 格式短路径分享
            const pathMatch = cleanText.match(/(?:https?:\/\/(?:yun|caiyun)\.139\.com)?(?:\/#)?\/(?:w|m)\/[ir]\/([a-zA-Z0-9]{4,32})/i);
            if (pathMatch) {
                try {
                    const parsed = Cloud139Utils.parseShareLink(pathMatch[0]);
                    if (parsed && parsed.linkID) {
                        const pwd = parsed.passwd || extractPassword(cleanText);
                        return { linkID: parsed.linkID, passwd: pwd, shareUrl: pathMatch[0] };
                    }
                } catch (_) {}
            }
        }

        return null;
    }

    /**
     * 判断推文文本是否为有声书、广播剧、评书或纯音频内容
     * @param {string} text 
     * @returns {{ isAudioBook: boolean, reason?: string }}
     */
    static isAudioBookOrNonVideoText(text) {
        if (!text || typeof text !== 'string') return { isAudioBook: false };
        const clean = text.trim();

        // 1. 显式有声书/广播剧/听书/小说等核心关键词
        const AUDIOBOOK_KEYWORDS = [
            '有声书', '有声剧', '广播剧', '评书', '听书', '相声', '评话',
            '有声小说', '播客', '电子书', '音频书', '单口相声'
        ];
        for (const kw of AUDIOBOOK_KEYWORDS) {
            if (clean.includes(kw)) {
                return { isAudioBook: true, reason: `推文包含有声书特征关键词: [${kw}]` };
            }
        }

        // 2. 有声演播/主播/播音等角色特征 (如: "主播：张老道", "演播: 紫襟")
        const NARRATOR_REGEX = /(?:主播|演播|播音|播讲|朗读|演播者|播者|播主|录制者)[：:]\s*([^\s,，;；\n]+)/i;
        const narratorMatch = clean.match(NARRATOR_REGEX);
        if (narratorMatch) {
            return { isAudioBook: true, reason: `推文包含音频演播主播特征: [${narratorMatch[0]}]` };
        }

        // 3. 评书/相声大师与知名演播名录特异匹配
        const MASTERS_REGEX = /(?:单田芳|刘兰芳|袁阔成|田连元|连丽如|张老道|艾宝良|周建龙|原野|头陀渊|紫襟|幻樱空|大斌)/;
        if (MASTERS_REGEX.test(clean) && !/(?:电影|电视剧|4K|1080P|2160P|REMUX|BLURAY|WEB-DL|S\d+E\d+)/i.test(clean)) {
            const master = clean.match(MASTERS_REGEX)[0];
            return { isAudioBook: true, reason: `推文命中知名评书/有声演播者: [${master}]` };
        }

        // 4. 超长回数/集完且无任何视频画质标签 (如 "2788集完", "1500回完", "120回全")
        const LONG_EPISODES_REGEX = /(?:共\s*)?\d{3,5}\s*(?:集完|集全|回完|回全|讲完|讲全|章完|章全)/;
        if (LONG_EPISODES_REGEX.test(clean) && !/(?:4K|1080P|2160P|720P|REMUX|BLURAY|WEB-DL|HDR|DOLBY|杜比|MKV|MP4)/i.test(clean)) {
            const epMatch = clean.match(LONG_EPISODES_REGEX)[0];
            return { isAudioBook: true, reason: `推文呈现长篇音频书剧集模式 (${epMatch}) 且无任何视频画质标签` };
        }

        return { isAudioBook: false };
    }

    /**
     * 前置文本字面黑名单与关键词过滤（0 网盘网络开销）
     * @param {object} post 
     * @param {object} monitor 
     * @returns {{ pass: boolean, reason?: string }}
     */
    static filterPostText(post, monitor) {
        const text = post.text || '';
        const globalFilters = ConfigService.getConfigValue('channelMonitor.filterKeywords', '');
        const globalExcludes = ConfigService.getConfigValue('channelMonitor.excludeKeywords', '');
        const globalWhitelistRegex = ConfigService.getConfigValue('channelMonitor.whitelistRegex', '');
        const globalBlacklistKeywords = ConfigService.getConfigValue('channelMonitor.blacklistKeywords', []);
        const ignoreAudiobooks = ConfigService.getConfigValue('channelMonitor.ignoreAudiobooks', true);

        // 0.1 过滤有声书与纯音频资源（默认开启：0网络开销前置拦截）
        if (ignoreAudiobooks) {
            const audioCheck = TgChannelMonitorService.isAudioBookOrNonVideoText(text);
            if (audioCheck.isAudioBook) {
                return { pass: false, reason: audioCheck.reason };
            }
        }

        // 0.2 优先执行白名单编译大正则校验（若配置了 whitelistRegex，必须匹配通过）
        if (globalWhitelistRegex && String(globalWhitelistRegex).trim()) {
            try {
                const re = new RegExp(String(globalWhitelistRegex).trim(), 'i');
                if (!re.test(text)) {
                    return { pass: false, reason: '未命中白名单规则卡片编译正则' };
                }
            } catch (err) {
                logger.warn(`[频道规则] 白名单正则编译校验异常: ${err.message}`);
            }
        }

        // 1. 包含关键词过滤（若配置则必须命中至少一个）
        const includeKeywords = [
            ...(monitor?.filterKeywords || '').split(/[,，]/),
            ...(globalFilters || '').split(/[,，]/)
        ].map(k => k.trim()).filter(Boolean);

        if (includeKeywords.length > 0) {
            const hitInclude = includeKeywords.some(kw => text.includes(kw));
            if (!hitInclude) {
                return { pass: false, reason: `未包含指定包含关键词 (${includeKeywords.join(',')})` };
            }
        }

        // 2. 排除黑名单过滤（命中任意一个直接拦截）
        const excludeKeywords = [
            ...(monitor?.excludeKeywords || '').split(/[,，]/),
            ...(globalExcludes || '').split(/[,，]/),
            ...(Array.isArray(globalBlacklistKeywords) ? globalBlacklistKeywords : [])
        ].map(k => String(k).trim()).filter(Boolean);

        if (excludeKeywords.length > 0) {
            const hitExclude = excludeKeywords.find(kw => text.includes(kw));
            if (hitExclude) {
                return { pass: false, reason: `命中排除黑名单关键词: [${hitExclude}]` };
            }
        }

        return { pass: true };
    }

    /**
     * 二次分流路由引擎：根据推文文本/片名匹配关键词规则，分发至对应 139 目录 ID
     * @param {string} postText 推文完整文本或影视标题
     * @param {object} monitor 频道监控对象
     * @returns {{ folderId: string, folderName?: string, matchedKeyword?: string }}
     */
    resolveTargetFolder(postText, monitor) {
        const text = String(postText || '');

        // 1. 优先检查当前频道特定的 secondary_dispatch_rules
        let dispatchRules = [];
        if (monitor?.secondary_dispatch_rules) {
            try {
                dispatchRules = typeof monitor.secondary_dispatch_rules === 'string'
                    ? JSON.parse(monitor.secondary_dispatch_rules)
                    : monitor.secondary_dispatch_rules;
            } catch (_) {}
        }

        // 2. 如果频道未单独配置，继承全局集中配置 channelMonitor.dispatchRules
        if (!Array.isArray(dispatchRules) || dispatchRules.length === 0) {
            const globalRules = ConfigService.getConfigValue('channelMonitor.dispatchRules', []);
            if (Array.isArray(globalRules)) {
                dispatchRules = globalRules;
            }
        }

        // 3. 逐条评估分流规则（命中首个关键词规则即重定向目录）
        if (Array.isArray(dispatchRules) && dispatchRules.length > 0) {
            for (const rule of dispatchRules) {
                if (!rule || !rule.keyword || !rule.folderId) continue;
                const kw = String(rule.keyword).trim();
                if (kw && text.toLowerCase().includes(kw.toLowerCase())) {
                    logger.info(`[频道二次分流] 命中分流规则 [${kw}] -> 目标目录 [${rule.folderName || rule.folderId}]`);
                    return {
                        folderId: rule.folderId,
                        folderName: rule.folderName || '',
                        matchedKeyword: kw
                    };
                }
            }
        }

        // 4. 未命中分流规则，回退到默认目标目录
        const defaultFolderId = monitor?.targetFolderId || ConfigService.getConfigValue('channelMonitor.defaultTargetFolderId', '/');
        const defaultFolderName = monitor?.targetFolderName || ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName', '/');
        return {
            folderId: defaultFolderId,
            folderName: defaultFolderName
        };
    }

    /**
     * 清理防审查干扰字符（如「伟大的丨长征」->「伟大的长征」）
     * @param {string} str 
     * @returns {string}
     */
    static cleanInterferenceChars(str) {
        if (!str || typeof str !== 'string') return '';
        return str.replace(/[丨|｜丶]/g, '').trim();
    }

    /**
     * 构建 AI 解析上下文（多源信息拼接，方案 §2.2）
     * 信息源按防封混淆强度递减：目录名 > 视频文件名 > 分享名
     * @param {object} shareDir 分享根目录结构 { folderList, fileList, linkName }
     * @returns {{ folderNames: string[], fileNames: string[], linkName: string }}
     */
    static buildAiContext(shareDir) {
        const folderList = Array.isArray(shareDir?.folderList) ? shareDir.folderList : [];
        const fileList = Array.isArray(shareDir?.fileList) ? shareDir.fileList : [];
        const folderNames = folderList
            .map(f => f.catalogName || f.caName || f.name)
            .filter(Boolean)
            .slice(0, 3);
        // 视频文件名取容量最大的 1~2 个（含 SxxExx/集数信号最强）
        const fileNames = fileList
            .slice()
            .sort((a, b) => (Number(b.contentSize) || 0) - (Number(a.contentSize) || 0))
            .map(f => f.contentName || f.coName || f.name)
            .filter(Boolean)
            .slice(0, 2);
        const linkName = String(shareDir?.linkName || '').trim();
        // folderList/fileList 均为空时自动退化为"推文 + linkName"（buildHumanDialogue 内处理）
        return { folderNames, fileNames, linkName };
    }

    /**
     * 从 Telegram 推文正文中智能提取权威影视片名与年份
     * @param {string} rawText 
     * @returns {{ title: string, year: string, mediaType: string } | null}
     */
    static extractMediaInfoFromPost(rawText) {
        if (!rawText || typeof rawText !== 'string') return null;
        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return null;

        for (const line of lines.slice(0, 5)) {
            // 跳过纯标签行（如 "#电影 #科幻"）
            if (/^(?:#[\w\u4e00-\u9fa5]+\s*)+$/i.test(line)) continue;

            let candidateText = line;
            const prefixMatch = candidateText.match(/^(?:名称|片名|剧名|标题)[：:]\s*(.+)$/i);
            if (prefixMatch) candidateText = prefixMatch[1].trim();

            // 1. 优先提取年份 (支持 (2024) 或 （2024）)
            let year = '';
            const yearMatch = candidateText.match(/[（(]((?:19|20)\d{2})[)）]/) || rawText.match(/[（(]((?:19|20)\d{2})[)）]/);
            if (yearMatch) {
                year = yearMatch[1];
            }

            // 2. 优先匹配 《书名号》 括起来的片名
            const bookMatch = candidateText.match(/《([^》]+)》/);
            if (bookMatch) {
                candidateText = bookMatch[1].trim();
            }

            // 3. 清理干扰字符与前置分类方括号 (如【国产剧】)
            candidateText = TgChannelMonitorService.cleanInterferenceChars(candidateText)
                .replace(/^[【\[][^】\]]*[】\]]/, '').trim();

            // 4. 剥离年份标记（已提入 year 变量）
            candidateText = candidateText.replace(/[（(](?:19|20)\d{2}[)）]/g, ' ');

            // 4.5 提取季数 (如 "大理寺日志 第三季", "Season 3", "S03", "第3季", "第三季", "沧元图·年番3", "大王饶命3")
            let postSeason = null;
            let isNianfanSeason = false;
            const seasonRegex = /(?:第\s*([0-9零〇一二两兩三四五六七八九十百\d]+)\s*季)|(?:Season\s*(\d{1,3}))|\bS(\d{1,3})\b|(?:年番\s*([0-9零〇一二两兩三四五六七八九十百\d]+))/i;
            const sMatch = candidateText.match(seasonRegex) || line.match(seasonRegex) || rawText.match(seasonRegex);
            if (sMatch) {
                if (sMatch[4]) {
                    isNianfanSeason = true;
                    const rawNum = sMatch[4];
                    const parsedNum = RecognitionEngine.chineseInteger ? RecognitionEngine.chineseInteger(rawNum) : parseInt(rawNum, 10);
                    postSeason = Number(parsedNum) || parseInt(rawNum, 10) || null;
                } else if (sMatch[1]) {
                    const rawNum = sMatch[1];
                    const parsedNum = RecognitionEngine.chineseInteger ? RecognitionEngine.chineseInteger(rawNum) : parseInt(rawNum, 10);
                    postSeason = Number(parsedNum) || parseInt(rawNum, 10) || null;
                } else if (sMatch[2]) {
                    postSeason = parseInt(sMatch[2], 10) || null;
                } else if (sMatch[3]) {
                    postSeason = parseInt(sMatch[3], 10) || null;
                }
            }

            // 提取末尾纯数字作为集数候选 (如 "璀璨之城 11" 中的 11，避免被误当普通后缀丢弃)
            let trailingEpNum = null;
            const trailingNumMatch = candidateText.match(/\s+(\d{1,4})(?:\s+.*)?$/);
            if (trailingNumMatch) {
                const parsedTrailing = parseInt(trailingNumMatch[1], 10);
                if (parsedTrailing > 0 && parsedTrailing <= 1500 && parsedTrailing !== 2024 && parsedTrailing !== 2025 && parsedTrailing !== 2026 && parsedTrailing !== 2027) {
                    trailingEpNum = parsedTrailing;
                }
            }

            candidateText = candidateText
                .replace(/(?:更新至|连载至|更新到|更新)\s*(?:第\s*)?\d+(?:[-~至到]\d+)?\s*[集话期]?.*$/i, '')
                .replace(/(?:完结季|完结篇|终结篇|特别篇|第[一二三四五六七八九十\d]+季).*$/i, '')
                .replace(/(?:全\s*\d+\s*[集话期]|共\s*\d+\s*[集话期]|\d+集全|全集|完结).*$/i, '')
                .replace(/(?:第\s*\d+\s*[集话期]|\d+\s*[-~至到]\s*\d+\s*[集话期]).*$/i, '')
                .replace(/(?:S\d+\s*E\d+|E\d+(?:-E\d+)?).*$/i, '')
                .replace(/\b(?:4K|2160[pi]|1080[pi]|720[pi]|HDR|HDR10|DV|杜比|DOLBY|REMUX|WEB-DL|BLURAY|H\.?26[45]|HEVC|AVC|10bit|60fps|AMAZ|NF)\b.*$/i, '')
                .replace(/\s+\d{1,4}(?:\s+.*)?$/, '')
                .replace(/[（(].*?[)）]/g, '')
                .trim();

            // 5.5 识别中文剧名后直接附带的季数/续集数字 (如 "大王饶命3" => 剧名: "大王饶命", 季数: 3)
            if (!postSeason) {
                const trailingSeqMatch = candidateText.match(/(?:(?<=[\u4e00-\u9fa5]{2,})\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))$/i);
                if (trailingSeqMatch) {
                    postSeason = parseInt(trailingSeqMatch[1] || trailingSeqMatch[2], 10) || null;
                    candidateText = candidateText.replace(/(?:(?<=[\u4e00-\u9fa5]{2,})\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))$/i, '').trim();
                }
            } else {
                candidateText = candidateText.replace(/[·._\s]*(?:年番\s*\d*|第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*季|Season\s*\d+|S\d+)(?:[：:][\u4e00-\u9fa5\w\s]+)?/gi, '').trim();
            }

            // 5.6 连载集数与连载状态判定
            const epMatch = (line + ' ' + rawText).match(/(?:更新至|连载至|更新到|更新|第)\s*(\d+)\s*[集话期]/i);
            const currentEpisode = epMatch ? parseInt(epMatch[1], 10) : (trailingEpNum || null);
            const isLaterSeasonOrOngoing = (postSeason && postSeason > 1) || (currentEpisode && currentEpisode > 24) || /年番/i.test(line) || /年番/i.test(rawText);

            // 核心铁律：国漫“年番”代表年度企划/播出周期，而非 TV 分季！
            // 当集数明确为绝对大集数（如 196 集）时，代表全剧绝对总集数，绝不能被“年番4”篡改为 Season 4！
            // 否则在 TMDB/Emby 将造成致命刮削失败（TMDB 上凡人修仙传等国漫全剧统一建档于 Season 1）！
            if (isNianfanSeason && currentEpisode && currentEpisode > 120) {
                postSeason = null;
            }

            const parsed = RecognitionEngine.parseMediaFilename(candidateText);
            let cleanTitle = TgChannelMonitorService.cleanInterferenceChars((parsed.title || candidateText || '').replace(/^[#【\[]/, '').replace(/[】\]]$/, '')).trim();
            cleanTitle = cleanTitle.replace(/[（(].*?[)）]/g, '').trim();

            if (cleanTitle && !/^\d+$/.test(cleanTitle) && cleanTitle.length >= 2) {
                const specs = RecognitionEngine.inferTechnicalTags(rawText);
                return {
                    title: cleanTitle,
                    year: year || parsed.year || '',
                    broadcastYear: year || '',
                    season: postSeason || null,
                    currentEpisode,
                    isLaterSeasonOrOngoing,
                    mediaType: (line.includes('集') || line.includes('季') || parsed.season || postSeason || currentEpisode) ? 'tv' : 'auto',
                    specs
                };
            }
        }
        return null;
    }

    /**
     * 判断是否为广告或说明文件/垃圾
     * @param {string} name 
     * @param {string} ext 
     * @returns {boolean}
     */
    static isAdOrPromoFile(name = '', ext = '') {
        const lowerName = name.toLowerCase();
        const lowerExt = (ext || '').replace(/^\./, '').toLowerCase();

        // 常见广告推广/教程关键词
        const promoKeywords = [
            '如何使用', '使用说明', '教程', '关注公众号', '解压密码',
            '扫码', '防失联', '盘搜', '分享群', '禁止外传', '资源发布'
        ];

        if (promoKeywords.some(kw => lowerName.includes(kw))) {
            return true;
        }

        // 孤立图片/网址快捷方式/广告文本文件
        if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'url', 'html', 'htm'].includes(lowerExt)) {
            return true;
        }

        return false;
    }

    /**
     * 递归确保 139 网盘路径存在并返回其最终 fileId
     * @param {Cloud139Service} cloud139 
     * @param {string} folderPath 形如 "/媒体库/剧集/国产剧/xxx/Season 1"
     * @param {string} [baseFolderId='/'] 起始父目录 ID，默认为根目录 '/'
     * @returns {Promise<string>} 目标目录 fileId
     */
    async ensureFolderPath(cloud139, folderPath, baseFolderId = '/', targetFolderName = '') {
        const normalized = '/' + String(folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (normalized === '/' || normalized === '') return baseFolderId || '/';

        const cacheKey = `${baseFolderId || '/'}::${normalized}`;
        if (this._dirCache.has(cacheKey)) {
            return this._dirCache.get(cacheKey);
        }

        let segments = normalized.split('/').filter(Boolean);

        // 防御性护栏：若路径首段为 139 目录 ID（30位以上 Hash），禁止在根目录下创建该 Hash 文件夹，自动转为以该 ID 为父目录
        if (segments.length > 0 && /^[A-Za-z0-9_-]{30,}$/.test(segments[0])) {
            logger.warn(`[频道监控-建树拦截] 路径首段识别为网盘目录ID ("${segments[0]}")，自动规避根目录 Hash 命名并以其为父目录解析子路径`);
            let curr = segments[0];
            for (let i = 1; i < segments.length; i++) {
                curr = await this.ensureChildFolder(cloud139, curr, segments[i]);
            }
            this._dirCache.set(cacheKey, curr);
            return curr;
        }

        // 核心规范：当传入了有效的基准目录 baseFolderId（如目标媒体库目录 ID）且提供了 targetFolderName 时，
        // 若待建路径前缀包含目标基准目录自身，按相对路径剥除该前缀，避免在目标目录下重复嵌套自身（纯相对路径映射，严禁特例硬编码）
        if (baseFolderId && baseFolderId !== '/' && targetFolderName && segments.length > 0) {
            const targetNameClean = String(targetFolderName || '').replace(/^\/+|\/+$/g, '');
            const targetSegs = targetNameClean.split('/').filter(Boolean);
            if (targetSegs.length > 0 && segments.length >= targetSegs.length) {
                const prefixMatches = targetSegs.every((seg, idx) => seg.toLowerCase() === segments[idx].toLowerCase());
                if (prefixMatches) {
                    segments = segments.slice(targetSegs.length);
                }
            }
        }
        if (segments.length === 0) return baseFolderId || '/';

        let currentId = baseFolderId || '/';
        let currentPath = '';

        for (const seg of segments) {
            currentPath += '/' + seg;
            const segCacheKey = `${baseFolderId || '/'}::${currentPath}`;
            if (this._dirCache.has(segCacheKey)) {
                currentId = this._dirCache.get(segCacheKey);
                continue;
            }

            let foundId = await cloud139.findFolderByName(currentId, seg);
            if (!foundId) {
                logger.info(`[频道监控-建树] 创建目录节点: ${seg} (父ID: ${currentId})`);
                const created = await cloud139.createFolderHcy(currentId, seg);
                if (!created || !created.fileId) {
                    throw new Error(`创建网盘目录失败: ${seg} (父ID: ${currentId})`);
                }
                foundId = created.fileId;
            }
            this._dirCache.set(segCacheKey, foundId);
            currentId = foundId;
        }

        this._dirCache.set(cacheKey, currentId);
        return currentId;
    }

    /**
     * 在指定的父目录 fileId 下确保单级子目录存在并返回子目录 fileId
     * @param {Cloud139Service} cloud139 
     * @param {string} parentFolderId 父目录 fileId
     * @param {string} childFolderName 子目录名称（单级）
     * @returns {Promise<string>} 子目录 fileId
     */
    async ensureChildFolder(cloud139, parentFolderId, childFolderName) {
        const cleanName = String(childFolderName || '').trim().replace(/[\\/]/g, '_');
        if (!cleanName) return parentFolderId || '/';
        const effectiveParentId = parentFolderId || '/';

        const cacheKey = `child::${effectiveParentId}::${cleanName}`;
        if (this._dirCache.has(cacheKey)) {
            return this._dirCache.get(cacheKey);
        }

        let foundId = await cloud139.findFolderByName(effectiveParentId, cleanName);
        if (!foundId) {
            logger.info(`[频道监控-建树] 在父目录 (${effectiveParentId}) 下创建子目录: "${cleanName}"`);
            const created = await cloud139.createFolderHcy(effectiveParentId, cleanName);
            if (!created || !created.fileId) {
                throw new Error(`创建网盘子目录失败: ${cleanName} (父ID: ${effectiveParentId})`);
            }
            foundId = created.fileId;
        }
        this._dirCache.set(cacheKey, foundId);
        return foundId;
    }

    /**
     * 解析两级暂存区目录 ID（频道独立覆盖 > 全局默认 > 自动创建「/暂存区/频道转存」）
     * @param {Cloud139Service} cloud139 
     * @param {object} monitor 
     * @returns {Promise<{ stagingFolderId: string, stagingFolderName: string }>}
     */
    async resolveStagingFolder(cloud139, monitor) {
        // 1. 频道独立设置
        if (monitor.stagingFolderId && monitor.stagingFolderId.trim()) {
            return {
                stagingFolderId: monitor.stagingFolderId.trim(),
                stagingFolderName: monitor.stagingFolderName || '频道独立暂存区'
            };
        }

        // 2. 全局配置
        const globalStagingId = ConfigService.getConfigValue('channelMonitor.stagingFolderId', '');
        const globalStagingName = ConfigService.getConfigValue('channelMonitor.stagingFolderName', '/暂存区/频道转存');

        if (globalStagingId && globalStagingId.trim()) {
            return {
                stagingFolderId: globalStagingId.trim(),
                stagingFolderName: globalStagingName
            };
        }

        // 3. 默认自动在网盘创建并使用「/暂存区/频道转存」
        const folderId = await this.ensureFolderPath(cloud139, globalStagingName);
        return {
            stagingFolderId: folderId,
            stagingFolderName: globalStagingName
        };
    }

    /**
     * 判断扩展名是否属于视频文件
     * @param {string} extension
     * @returns {boolean}
     */
    isVideoFile(extension) {
        if (!extension) return false;
        const ext = String(extension).toLowerCase().replace(/^\./, '');
        const configExts = ConfigService.getConfigValue('channelMonitor.videoExtensions');
        if (Array.isArray(configExts) && configExts.length > 0) {
            return configExts.map(e => String(e).toLowerCase().replace(/^\./, '')).includes(ext);
        }
        // 自动复用全局设置中的媒体文件后缀白名单 (task.mediaSuffix)
        const globalMedia = ConfigService.getConfigValue('task.mediaSuffix');
        if (globalMedia && typeof globalMedia === 'string') {
            const list = globalMedia.split(';').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
            if (list.includes(ext)) return true;
        }
        return RecognitionEngine.VIDEO_EXTENSIONS.has(ext);
    }

    /**
     * 判断扩展名是否属于元数据/字幕文件
     * @param {string} extension
     * @returns {boolean}
     */
    isMetadataFile(extension) {
        if (!extension) return false;
        const ext = String(extension).toLowerCase().replace(/^\./, '');
        const configExts = ConfigService.getConfigValue('channelMonitor.metadataExtensions');
        if (Array.isArray(configExts) && configExts.length > 0) {
            return configExts.map(e => String(e).toLowerCase().replace(/^\./, '')).includes(ext);
        }
        const defaultExts = ['ass', 'srt', 'ssa', 'sub', 'vtt', 'nfo'];
        return defaultExts.includes(ext);
    }

    /**
     * 判断 139 分享目录内容是否为有声书、广播剧或纯音频资源（非影视视频）
     * @param {object} shareDir 
     * @returns {{ isAudioBook: boolean, reason?: string }}
     */
    isAudioBookOrNonVideoShare(shareDir) {
        if (!shareDir) return { isAudioBook: false };
        const folders = shareDir.folderList || [];
        const files = shareDir.fileList || [];

        // 1. 检查根目录及子文件夹名称是否命中有声书/演播特征
        for (const f of folders) {
            const folderName = f.catalogName || f.caName || f.name || '';
            const textCheck = TgChannelMonitorService.isAudioBookOrNonVideoText(folderName);
            if (textCheck.isAudioBook) {
                return { isAudioBook: true, reason: `分享子文件夹名命中: "${folderName}" (${textCheck.reason})` };
            }
        }

        // 2. 检查单层文件列表中的扩展名分布
        if (files.length > 0) {
            const AUDIO_EXTS = new Set(['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wma', 'ogg', 'ape', 'alac']);
            const EBOOK_EXTS = new Set(['txt', 'pdf', 'epub', 'mobi', 'azw3', 'azw', 'djvu']);

            let hasVideo = false;
            let audioCount = 0;
            let ebookCount = 0;

            for (const file of files) {
                const name = file.contentName || file.coName || file.name || '';
                const ext = (file.extension || name.split('.').pop() || '').toLowerCase();
                if (this.isVideoFile(ext)) {
                    hasVideo = true;
                    break;
                }
                if (AUDIO_EXTS.has(ext)) audioCount++;
                if (EBOOK_EXTS.has(ext)) ebookCount++;
            }

            // 若包含音频或电子书且没有任何一个视频文件，判定为纯音频/有声书
            if (!hasVideo && (audioCount > 0 || ebookCount > 0)) {
                return {
                    isAudioBook: true,
                    reason: `分享内容全为纯音频(${audioCount})或文档(${ebookCount})，无有效视频文件`
                };
            }
        }

        return { isAudioBook: false };
    }

    /**
     * 免转存轻量探针与三源特征 TMDB 准入门禁
     * 交叉研判：推文正文 (Post) -> 分享目录名 (Folder) -> 首层/深层具体文件名 (File)
     * 在物理转存前实施准入校验，阻断未识别的混淆/脏资源落盘
     * @param {object} cloud139 Cloud139Service 实例
     * @param {string} linkID 分享链接 ID
     * @param {string} passwd 访问码
     * @param {object} shareDir 分享根目录结构
     * @param {object} post 推文对象
     * @returns {Promise<{ matched: boolean, tmdbId?: string, title?: string, year?: string, mediaType?: string, posterPath?: string, source?: string, reason?: string }>}
     */
    async probeAndValidateTmdbPreFlight(cloud139, linkID, passwd, shareDir, post, accountId = null) {
        const tmdbService = this._tmdbService || new TMDBService();
        const aiService = require('../ai');
        const aiConfig = ConfigService.getConfigValue('channelMonitor.ai') || ConfigService.getConfigValue('ai') || {};
        const isAiEnabled = aiService.isEnabled(aiConfig);
        const aiMode = aiConfig.mode || 'fallback';
        // 移动 AI 兜底通道（灵犀）：总开关开启且存在可用 139 凭证时，主 AI 未配置也开箱即用（方案 §5）
        const MobileAiClient = require('../MobileAiClient');
        const mobileFallbackEnabled = await MobileAiClient.isEnabled();
        const anyAiEnabled = isAiEnabled || mobileFallbackEnabled;
        // 多源信息拼接上下文（M2b：三处 AI 调用共用，context 变化会重算缓存 key）
        const aiContext = { ...TgChannelMonitorService.buildAiContext(shareDir), accountId };

        if (!tmdbService.apiKey && !tmdbService.credential) {
            if (anyAiEnabled && post?.text) {
                try {
                    const aiRes = await aiService.parseMediaInfo(post.text, aiContext, aiConfig);
                    if (aiRes.success && aiRes.data && aiRes.data.title) {
                        const aiTitle = TgChannelMonitorService.cleanInterferenceChars(aiRes.data.title);
                        const aiYear = String(aiRes.data.year || '');
                        logTaskEvent(`[前置门禁-AI免TMDB] AI 成功结构化识别推文: 《${aiTitle}》 (${aiYear || '未知年份'})`);
                        return {
                            matched: true,
                            title: aiTitle,
                            year: aiYear,
                            mediaType: aiRes.data.mediaType || 'tv',
                            source: 'ai_direct_no_tmdb'
                        };
                    }
                } catch (aiErr) {
                    logger.warn(`[前置门禁] 未配 TMDB 时 AI 解析异常: ${aiErr.message}`);
                }
            }
            const postMedia = post?.text ? TgChannelMonitorService.extractMediaInfoFromPost(post.text) : null;
            const fallbackTitle = (postMedia?.title ? TgChannelMonitorService.cleanInterferenceChars(postMedia.title) : '') || shareDir.linkName || '未命名影视';
            return { matched: true, title: fallbackTitle, year: postMedia?.year || '', mediaType: 'tv', reason: '未配置 TMDB API 凭证，使用推文/分享名放行', source: 'bypass_no_key' };
        }

        let sampleFiles = Array.isArray(shareDir.fileList) ? [...shareDir.fileList] : [];
        const folderList = Array.isArray(shareDir.folderList) ? shareDir.folderList : [];
        const folderNames = folderList.map(f => f.catalogName || f.caName || f.name).filter(Boolean);
        const linkName = shareDir.linkName || '';

        // 若根层无文件且存在子目录，轻量下探一层读取首个子目录的文件列表，确保拿到实际媒体文件名
        if (sampleFiles.length === 0 && folderList.length > 0) {
            try {
                const firstFolder = folderList[0];
                const subId = firstFolder.catalogID || firstFolder.caID;
                if (subId) {
                    const subDir = await cloud139.listShareDir(linkID, passwd, subId);
                    if (subDir?.fileList?.length) {
                        sampleFiles = subDir.fileList;
                    }
                }
            } catch (_) {}
        }

        const fileNames = sampleFiles.map(f => f.contentName || f.coName || f.name).filter(Boolean);
        const allNames = [...fileNames, ...folderNames, linkName].filter(Boolean);

        // 1. 优先检查显式 {tmdb-XXXX} 标签 (最高权威)
        for (const name of allNames) {
            const m = name.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
            if (m && m[1]) {
                const tmdbId = m[1];
                try {
                    const detail = await tmdbService.details('tv', tmdbId) || await tmdbService.details('movie', tmdbId);
                    if (detail && detail.id) {
                        return {
                            matched: true,
                            tmdbId: String(detail.id),
                            title: detail.title || detail.name,
                            year: String(detail.year || (detail.first_air_date || detail.release_date || '').slice(0, 4) || ''),
                            mediaType: detail.media_type || (detail.first_air_date ? 'tv' : 'movie'),
                            posterPath: detail.poster_path || '',
                            source: 'tmdb_tag'
                        };
                    }
                } catch (_) {}
            }
        }

        // 2. 提取推文特征 (Source A)
        const postMedia = post?.text ? TgChannelMonitorService.extractMediaInfoFromPost(post.text) : null;
        const postTitle = postMedia?.title ? TgChannelMonitorService.cleanInterferenceChars(postMedia.title) : '';
        const postYear = postMedia?.year ? String(postMedia.year) : '';
        const isLaterSeasonOrOngoing = Boolean(postMedia?.isLaterSeasonOrOngoing);

        // 3. 提取目录名特征 (Source B)
        const cleanFolderNames = [linkName, ...folderNames]
            .map(n => TgChannelMonitorService.cleanInterferenceChars(RecognitionEngine.cleanMediaFolderName(n)))
            .filter(n => n && n !== '暂存区' && n !== 'root' && !/^\d+$/.test(n));
        let folderTitle = cleanFolderNames[0] || '';
        // 如果目录名以季数/续集数字结尾 (如 "大王饶命3")，剥离得到纯净标题
        const folderSeqMatch = folderTitle.match(/(?:(?<=[\u4e00-\u9fa5]{2,})\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))$/i);
        const folderTitlePure = folderSeqMatch ? folderTitle.replace(/(?:(?<=[\u4e00-\u9fa5]{2,})\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))$/i, '').trim() : folderTitle;
        const folderYear = cleanFolderNames.map(RecognitionEngine.extractYear).find(Boolean) || '';

        // 4. 提取文件名特征 (Source C)
        let fileTitle = '';
        let fileYear = '';
        const videoExtensions = ['.mp4', '.mkv', '.iso', '.ts', '.mov', '.avi'];
        const videoFileNames = fileNames.filter(n => videoExtensions.some(ext => n.toLowerCase().endsWith(ext)));

        for (const vf of videoFileNames) {
            const parsed = RecognitionEngine.parseMediaFilename(vf);
            if (parsed?.cleanName && !fileTitle) {
                fileTitle = TgChannelMonitorService.cleanInterferenceChars(parsed.cleanName);
            }
            if (parsed?.year && !fileYear) {
                fileYear = String(parsed.year);
            }
        }

        // 4.5 AI 智能推文辅助解析 (若配置模式为 always 则优先介入)

        // 5. 组合候选查询：根据剧集连载/续季特征，实施年份智能解耦
        const candidateQueries = [];

        if (post?.text && anyAiEnabled && aiMode === 'always') {
            try {
                logTaskEvent('[前置门禁-AI优先] 正在调度 AI 大模型解析推文文本...');
                const aiRes = await aiService.parseMediaInfo(post.text, aiContext, aiConfig);
                if (aiRes.success && aiRes.data && aiRes.data.title) {
                    const aiTitle = TgChannelMonitorService.cleanInterferenceChars(aiRes.data.title);
                    const aiYear = String(aiRes.data.year || '');
                    logTaskEvent(`[前置门禁-AI优先] AI 成功结构化识别推文: 《${aiTitle}》 (${aiYear || '未知年份'})`);
                    candidateQueries.push({ title: aiTitle, year: aiYear, source: 'ai_always' });
                    if (aiYear) {
                        candidateQueries.push({ title: aiTitle, year: '', source: 'ai_always_pure' });
                    }
                }
            } catch (aiErr) {
                logger.warn(`[前置门禁-AI优先] AI 辅助解析推文异常: ${aiErr.message}`);
            }
        }
        // 核心铁律：若为续季 (季号>1)、大集数(E25+)或连载追更，推文中的年份代表当季更新年，绝非 TMDB 首播年，首轮必须使用纯标题检索
        if (postTitle) {
            if (isLaterSeasonOrOngoing) {
                candidateQueries.push({ title: postTitle, year: '', source: 'post_pure_tv' });
                if (postYear) candidateQueries.push({ title: postTitle, year: postYear, source: 'post_with_year' });
            } else {
                if (postYear) candidateQueries.push({ title: postTitle, year: postYear, source: 'post_with_year' });
                candidateQueries.push({ title: postTitle, year: '', source: 'post_pure' });
            }
        }
        if (folderTitlePure) {
            candidateQueries.push({ title: folderTitlePure, year: isLaterSeasonOrOngoing ? '' : (folderYear || ''), source: 'folder_pure' });
        }
        if (folderTitle && folderTitle !== folderTitlePure) {
            candidateQueries.push({ title: folderTitle, year: folderYear || '', source: 'folder_raw' });
        }
        if (fileTitle) {
            candidateQueries.push({ title: fileTitle, year: isLaterSeasonOrOngoing ? '' : (fileYear || ''), source: 'file_pure' });
        }

        const seenQueries = new Set();
        const uniqueQueries = candidateQueries.filter(q => {
            const key = `${q.title}___${q.year}`;
            if (seenQueries.has(key)) return false;
            seenQueries.add(key);
            return true;
        });

        // 6. 执行 TMDB 检索与多维消歧裁决
        for (const cq of uniqueQueries) {
            try {
                const candidates = await tmdbService.searchCandidates(cq.title, cq.year, 'auto');
                if (candidates && candidates.length > 0) {
                    let best = candidates[0];
                    let bestScore = best.engineScore || 0;
                    if (candidates.length > 1) {
                        const isAnimeOrDonghua = /(?:#?(?:国漫|动漫|动画|国创|二次元|新番|年番)|[（(](?:国漫|动画|年番)[)）]|\b年番\b)/i.test(post?.text || '') || 
                                                 /国漫|动漫|年番/i.test(cq.title) || 
                                                 /国漫|动漫|年番/i.test(folderTitle);
                        const targetYear = cq.year || postYear || folderYear || fileYear;

                        const scored = candidates.map(c => {
                            let score = c.engineScore || 0;
                            const cTitle = (c.title || c.name || '').trim();
                            const normC = RecognitionEngine.normalizeTitleKey(cTitle);
                            const normQ = RecognitionEngine.normalizeTitleKey(cq.title);
                            const normPost = RecognitionEngine.normalizeTitleKey(postTitle);

                            // 1. 根标题完全一致赋予绝对优先权 (+200 分)，杜绝副标题/衍生剧因更新年碰巧相同而篡位
                            if (normC === normQ || normC === normPost) {
                                score += 200;
                            }

                            // 2. 动画/国漫与外语真人剧严格隔离
                            if (isAnimeOrDonghua) {
                                const isChinese = (Array.isArray(c.origin_country) && c.origin_country.some(ctry => ['CN', 'TW', 'HK'].includes(ctry))) ||
                                                  c.original_language === 'zh';
                                const isForeign = (Array.isArray(c.origin_country) && c.origin_country.some(ctry => ['JP', 'US', 'KR', 'GB'].includes(ctry))) ||
                                                  ['ja', 'en', 'ko'].includes(c.original_language);
                                
                                if (isChinese) {
                                    score += 100;
                                }
                                if (c.genre_ids?.includes(16)) {
                                    score += 150; // 动画题材加分，杜绝真人剧篡位
                                } else if (c.genre_ids && c.genre_ids.length > 0 && !c.genre_ids.includes(16)) {
                                    score -= 200; // 针对明确声明动漫/年番但候选非动画的真人剧/有声小说降权
                                }
                                if (isForeign && !c.genre_ids?.includes(16)) {
                                    // 彻底熔断外语真人剧 (如《时光代理人日剧版》)
                                    score -= 600;
                                }
                                if (/日剧|韩剧|美剧|真人版|电视剧版/i.test(cTitle)) {
                                    score -= 300;
                                }
                            }

                            // 3. 衍生剧/番外/前传降权 (如《沧元图前传：东宁府的夏天》)
                            const isCandDerivative = /(?:前传|番外|外传|特别篇|剧场版|日常篇)/i.test(cTitle);
                            const isQueryDerivative = /(?:前传|番外|外传|特别篇|剧场版|日常篇)/i.test(cq.title) || /(?:前传|番外|外传|特别篇|剧场版|日常篇)/i.test(postTitle);
                            if (isCandDerivative && !isQueryDerivative) {
                                score -= 200;
                            }

                            // 4. 年份仲裁
                            if (targetYear && c.year) {
                                const yTarget = parseInt(targetYear, 10);
                                const yCand = parseInt(c.year, 10);
                                if (Number.isInteger(yTarget) && Number.isInteger(yCand)) {
                                    if (yTarget === yCand) {
                                        // 仅当标题吻合或非衍生剧时享受年份红利
                                        if (normC === normQ || !isCandDerivative) {
                                            score += 60;
                                        }
                                    } else if (isLaterSeasonOrOngoing && yCand <= yTarget) {
                                        // 连载追更中，首播年在当季更新年前完全合法
                                        score += 30;
                                    }
                                }
                            }

                            return { candidate: c, score };
                        });

                        scored.sort((a, b) => b.score - a.score);
                        if (scored.length > 0) {
                            best = scored[0].candidate;
                            bestScore = scored[0].score;
                        }
                    }

                    // L2 熔断未命中（M2b 修正）：最高分 ≤ -200 时不再强制命中，继续触发后续 AI 兜底
                    if (bestScore <= -200) {
                        logger.debug(`[前置门禁-TMDB裁决] 候选 "${cq.title}" 全部熔断 (score=${bestScore})，视为未命中`);
                        continue;
                    }

                    // L3 低置信命中（M2b 新增）：最高分 < 60 且标题归一化不相等且年份不匹配 → AI 交叉验证
                    const bestTitleRaw = (best.title || best.name || '').trim();
                    const normBest = RecognitionEngine.normalizeTitleKey(bestTitleRaw);
                    const normQuery = RecognitionEngine.normalizeTitleKey(cq.title);
                    const yearMatch = Boolean(cq.year && best.year && String(cq.year) === String(best.year));
                    if (anyAiEnabled && post?.text && bestScore < 60 && normBest !== normQuery && !yearMatch) {
                        const cross = await this._aiCrossVerifyTmdbCandidate(tmdbService, aiService, aiConfig, aiContext, post, best);
                        if (cross.verdict === 'match') {
                            return cross.payload;
                        }
                        if (cross.verdict === 'reject') {
                            continue;
                        }
                        // verdict=keep（AI 不可用）→ 保留低置信候选，按原逻辑返回
                    }

                    return {
                        matched: true,
                        tmdbId: String(best.id),
                        title: best.title || best.name || cq.title,
                        year: String(best.year || cq.year || ''),
                        mediaType: best.mediaType || (best.first_air_date ? 'tv' : 'movie'),
                        posterPath: best.posterPath || '',
                        source: cq.source
                    };
                }
            } catch (err) {
                logger.debug(`[前置门禁-TMDB查询] 候选 "${cq.title}" (${cq.year}) 检索异常: ${err.message}`);
            }
        }

        // 7. AI 智能辅助识别兜底 (Fallback 模式：L1 搜空 / L2 全熔断 / L3 被推翻后的最后智能防线)
        if (post?.text && anyAiEnabled && aiMode !== 'always') {
            try {
                logTaskEvent('[前置门禁-AI兜底] 常规规则未能识别有效 TMDB 实体，正在调度 AI 大模型深度解析推文...');
                const aiRes = await aiService.parseMediaInfo(post.text, aiContext, aiConfig);
                if (aiRes.success && aiRes.data && aiRes.data.title) {
                    const aiTitle = TgChannelMonitorService.cleanInterferenceChars(aiRes.data.title);
                    const aiYear = String(aiRes.data.year || '');
                    const aiMediaType = aiRes.data.mediaType || 'auto';
                    logTaskEvent(`[前置门禁-AI兜底] AI 成功推导出影视标题: 《${aiTitle}》 (${aiYear || '无年份'}) [${aiMediaType}]`);

                    // 检索 TMDB 验证
                    const aiCandidates = await tmdbService.searchCandidates(aiTitle, aiYear, aiMediaType);
                    if (aiCandidates && aiCandidates.length > 0) {
                        const best = aiCandidates[0];
                        return {
                            matched: true,
                            tmdbId: String(best.id),
                            title: best.title || best.name || aiTitle,
                            year: String(best.year || aiYear || ''),
                            mediaType: best.mediaType || (best.first_air_date ? 'tv' : (best.release_date ? 'movie' : aiMediaType)),
                            posterPath: best.posterPath || '',
                            source: 'ai_fallback'
                        };
                    } else if (!tmdbService.apiKey && !tmdbService.credential) {
                        // 未配置 TMDB 时，直接信赖 AI 提取结果
                        return {
                            matched: true,
                            title: aiTitle,
                            year: aiYear,
                            mediaType: aiMediaType === 'auto' ? 'tv' : aiMediaType,
                            source: 'ai_direct_no_tmdb'
                        };
                    }
                }
            } catch (aiErr) {
                logger.warn(`[前置门禁-AI兜底] AI 辅助解析推文异常: ${aiErr.message}`);
            }
        }

        return {
            matched: false,
            reason: `未能识别合法 TMDB 影视实体 (推文: "${postTitle || '无'}", 目录: "${folderTitle || '无'}", 文件: "${fileTitle || '无'}")`
        };
    }

    /**
     * L3 低置信命中的 AI 交叉验证（方案 §4.2）
     * @returns {Promise<{ verdict: 'match'|'reject'|'keep', payload?: object }>}
     *   - match: AI 认可（或按 AI 结果重查命中），payload 为最终命中结果
     *   - reject: AI 给出不同片名且重查搜空，弃用该低置信候选
     *   - keep: AI 不可用/调用失败，保留原候选（现状行为）
     */
    async _aiCrossVerifyTmdbCandidate(tmdbService, aiService, aiConfig, aiContext, post, candidate) {
        try {
            const aiRes = await aiService.parseMediaInfo(post.text, aiContext, aiConfig);
            if (!aiRes.success || !aiRes.data || !aiRes.data.title) {
                return { verdict: 'keep' };
            }
            const aiTitle = TgChannelMonitorService.cleanInterferenceChars(aiRes.data.title);
            const aiYear = String(aiRes.data.year || '');
            const aiNorm = RecognitionEngine.normalizeTitleKey(aiTitle);
            const candNorm = RecognitionEngine.normalizeTitleKey(candidate.title || candidate.name || '');
            if (aiNorm && candNorm && aiNorm === candNorm) {
                logTaskEvent(`[前置门禁-AI交叉验证] AI 认可低置信候选 《${aiTitle}》`);
                return {
                    verdict: 'match',
                    payload: {
                        matched: true,
                        tmdbId: String(candidate.id),
                        title: candidate.title || candidate.name || aiTitle,
                        year: String(candidate.year || aiYear || ''),
                        mediaType: candidate.mediaType || (candidate.first_air_date ? 'tv' : 'movie'),
                        posterPath: candidate.posterPath || '',
                        source: 'tmdb_ai_verified'
                    }
                };
            }
            // AI 给出不同片名 → 按 AI 结果重查 TMDB
            const reCandidates = await tmdbService.searchCandidates(aiTitle, aiYear, aiRes.data.mediaType || 'auto');
            if (reCandidates && reCandidates.length > 0) {
                const reBest = reCandidates[0];
                logTaskEvent(`[前置门禁-AI交叉验证] AI 推翻低置信候选，重查命中 《${aiTitle}》`);
                return {
                    verdict: 'match',
                    payload: {
                        matched: true,
                        tmdbId: String(reBest.id),
                        title: reBest.title || reBest.name || aiTitle,
                        year: String(reBest.year || aiYear || ''),
                        mediaType: reBest.mediaType || (reBest.first_air_date ? 'tv' : 'movie'),
                        posterPath: reBest.posterPath || '',
                        source: 'ai_verified_requery'
                    }
                };
            }
            logger.debug(`[前置门禁-AI交叉验证] AI 片名 "${aiTitle}" 重查无果，弃用低置信候选`);
            return { verdict: 'reject' };
        } catch (aiErr) {
            logger.warn(`[前置门禁-AI交叉验证] 异常: ${aiErr.message}`);
            return { verdict: 'keep' };
        }
    }

    /**
     * 执行单条推文的转存与规范入库全流程
     * @param {object} monitor 
     * @param {object} post 
     * @param {object} linkInfo { linkID, passwd, shareUrl }
     * @returns {Promise<{ status: string, reason?: string, transferredCount: number, details: Array }>}
     */
    async executeChannelIngestion(monitor, post, linkInfo) {
        const accountRepo = getAccountRepository();
        const account = await accountRepo.findOne({ where: { id: monitor.accountId } });
        if (!account) {
            throw new Error(`关联的 139 账号不存在 (accountId=${monitor.accountId})`);
        }

        const cloud139 = Cloud139Service.getInstance(account);
        const { linkID, passwd } = linkInfo;

        // 1. 解析目标暂存区
        const { stagingFolderId, stagingFolderName } = await this.resolveStagingFolder(cloud139, monitor);
        const stageMsg = `[频道监控-暂存区] 转存目标暂存区: ${stagingFolderName} (${stagingFolderId})`;
        logger.info(stageMsg);
        logTaskEvent(stageMsg);

        // 2. 检查分享内容
        const shareDir = await cloud139.listShareDir(linkID, passwd, 'root');
        if (!shareDir || (shareDir.fileList.length === 0 && shareDir.folderList.length === 0)) {
            const failReason = '分享链接为空或已失效';
            logTaskEvent(`[频道监控-转存失败] ${failReason} (linkID=${linkID})`);
            return { status: 'failed', reason: failReason, transferredCount: 0, details: [] };
        }

        // 2.5 检查分享内容是否为有声书/纯音频/电子书资源（非影视视频前置阻断）
        const ignoreAudiobooks = ConfigService.getConfigValue('channelMonitor.ignoreAudiobooks', true);
        if (ignoreAudiobooks) {
            const audioShareCheck = this.isAudioBookOrNonVideoShare(shareDir);
            if (audioShareCheck.isAudioBook) {
                const blockMsg = `[频道监控-内容拦截] 分享外链识别为有声书/纯音频 (${audioShareCheck.reason})，取消转存`;
                logger.info(blockMsg);
                logTaskEvent(blockMsg);
                return {
                    status: 'skipped_filter',
                    reason: `内容拦截: ${audioShareCheck.reason}`,
                    transferredCount: 0,
                    details: []
                };
            }
        }

        // 2.8 免转存轻量探针与三源特征 TMDB 准入门禁
        // 交叉研判：推文正文 -> 分享目录名 -> 首层/深层文件名
        // 必须成功识别合法 TMDB 影视实体才放行转存，阻断脏资源/垃圾目录落盘污染
        const preFlight = await this.probeAndValidateTmdbPreFlight(cloud139, linkID, passwd, shareDir, post, monitor.accountId);
        if (!preFlight.matched) {
            const blockMsg = `[频道监控-前置门禁] 拦截未识别资源: 推文/目录/文件名均未通过 TMDB 影视实体验证 (${preFlight.reason})，取消转存以防污染网盘暂存区 (linkID=${linkID})`;
            logger.warn(blockMsg);
            logTaskEvent(blockMsg);
            return {
                status: 'skipped_unmatched_tmdb',
                reason: preFlight.reason,
                transferredCount: 0,
                details: []
            };
        }
        logTaskEvent(`[频道监控-前置门禁] TMDB 准入验证通过: 《${preFlight.title}》 (${preFlight.year || ''}) [TMDB #${preFlight.tmdbId} - ${preFlight.mediaType}] (来源: ${preFlight.source})`);

        // 3. 转存入规范的批次隔离目录（格式：/临时存放/{片名} ({年份}) {tmdb-{ID}}/）
        // 彻底杜绝往暂存根目录大杂烩灌入，确保元数据物理附着在目录名上且整理只针对本作品，绝不触发全盘盲扫！
        const canonicalBatchFolderName = `${preFlight.title || '影视资源'}${preFlight.year ? ` (${preFlight.year})` : ''}${preFlight.tmdbId ? ` {tmdb-${preFlight.tmdbId}}` : ''}`;
        let effectiveStagingFolderId = stagingFolderId;
        let effectiveStagingFolderName = stagingFolderName;
        let isBatchIsolated = false;

        try {
            const batchFolderId = await this.ensureChildFolder(cloud139, stagingFolderId, canonicalBatchFolderName);
            if (batchFolderId) {
                effectiveStagingFolderId = batchFolderId;
                effectiveStagingFolderName = `${stagingFolderName}/${canonicalBatchFolderName}`;
                isBatchIsolated = true;
                logTaskEvent(`[频道监控-隔离暂存] 已就绪批次隔离目录: ${canonicalBatchFolderName} (${batchFolderId})`);
            }
        } catch (batchErr) {
            logger.warn(`[频道监控-隔离暂存] 创建批次目录失败，平滑降级至暂存根目录: ${batchErr.message}`);
        }

        const caPathLst = (shareDir.folderList || []).map(f => f.path || f.catalogID || f.caID).filter(Boolean);
        const coPathLst = (shareDir.fileList || []).map(f => f.path || f.contentID || f.coID).filter(Boolean);

        const transferStartMsg = `[频道监控-转存] 开始转存外链文件入批次暂存区: linkID=${linkID}, 目录数=${caPathLst.length}, 文件数=${coPathLst.length}`;
        logger.info(transferStartMsg);
        logTaskEvent(transferStartMsg);
        const saveRes = await cloud139.saveShareFilesWithRetry(linkID, coPathLst, caPathLst, effectiveStagingFolderId, !!passwd);
        if (!saveRes) {
            throw new Error('139 转存接口返回空响应');
        }
        logTaskEvent(`[频道监控-转存成功] 外链文件已成功保存至批次暂存区: 《${preFlight.title}》 [TMDB #${preFlight.tmdbId}]`);

        // 4. 等待文件在批次暂存区可见
        const expectedNames = [
            ...(shareDir.fileList || []).map(f => f.contentName || f.coName || f.name),
            ...(shareDir.folderList || []).map(f => f.catalogName || f.caName || f.name)
        ].filter(Boolean);

        try {
            logTaskEvent(`[频道监控-可见性] 等待文件在批次暂存区刷新可见 (共 ${expectedNames.length} 个条目)...`);
            await cloud139.waitForFilesVisible(effectiveStagingFolderId, expectedNames, { timeoutMs: 30000, intervalMs: 2000 });
            logTaskEvent(`[频道监控-可见性] 文件已在批次暂存区确认就绪`);
        } catch (visErr) {
            logger.warn(`[频道监控] 等待文件在暂存区可见异常: ${visErr.message}`);
        }

        // 5. 生产者与消费者解耦：转存成功即完成该推文摄入；媒体库整理作为独立管道异步执行
        const totalTransferred = coPathLst.length + caPathLst.length;
        const targetResolved = this.resolveTargetFolder(post.text, monitor);

        // 若开启了 autoOrganize 且已明确配置有效的归档目标目录，在 process.nextTick 异步触发独立整理
        const cmConfig = ConfigService.getConfigValue('channelMonitor') || {};
        const isTargetValid = Boolean(targetResolved?.folderId && String(targetResolved.folderId).trim() && String(targetResolved.folderId).trim() !== '/' && String(targetResolved.folderId).trim() !== '0');
        if (cmConfig.autoOrganize !== false && isTargetValid) {
            process.nextTick(async () => {
                try {
                    await this.organizeStagingFolder({
                        accountId: monitor.accountId,
                        stagingFolderId: effectiveStagingFolderId,
                        stagingFolderName: effectiveStagingFolderName,
                        rootStagingFolderId: stagingFolderId,
                        isBatchIsolated,
                        targetFolderId: targetResolved.folderId,
                        targetFolderName: targetResolved.folderName,
                        post,
                        tmdbId: preFlight.tmdbId || undefined,
                        tmdbType: preFlight.mediaType || undefined,
                        skipChannelCheck: true,
                        silentIfEmpty: true
                    });
                } catch (orgErr) {
                    logger.warn(`[频道监控-异步整理] 后台整理异常: ${orgErr.message}`);
                }
            });
        } else if (cmConfig.autoOrganize !== false && !isTargetValid) {
            logger.warn(`[频道监控-整理跳过] 未选定独立的归档目标目录，转存文件保留在批次暂存区，跳过自动归档`);
        }

        return {
            status: 'success',
            reason: `转存至暂存区成功: 《${preFlight.title}》 [TMDB #${preFlight.tmdbId}]`,
            transferredCount: totalTransferred,
            details: expectedNames.map(name => ({ name, status: 'transferred_to_staging' }))
        };
    }

    /**
     * 伴随字幕同名匹配与归档
     */
    async _moveAssociatedSubtitles(cloud139, allEntries, videoEntry, videoFinalName, targetFolderId) {
        const videoBaseWithoutExt = videoFinalName.substring(0, videoFinalName.lastIndexOf('.'));
        const originalBase = videoEntry.name.substring(0, videoEntry.name.lastIndexOf('.'));

        for (const entry of allEntries) {
            const ext = (entry.extension || '').toLowerCase().replace(/^\./, '');
            if (this.isMetadataFile(ext) && entry.name.startsWith(originalBase)) {
                const subTargetName = `${videoBaseWithoutExt}.${ext}`;
                logger.info(`[频道监控-字幕伴随] 同步归档字幕: "${entry.name}" -> "${subTargetName}"`);
                try {
                    await cloud139.renameFile(entry.fileId, subTargetName);
                    await cloud139.batchMoveHcy([entry.fileId], targetFolderId);
                } catch (e) {
                    logger.warn(`[频道监控-字幕伴随] 字幕归档失败: ${e.message}`);
                }
            }
        }
    }

    /**
     * ISO 原盘二进制 Range 探针辨伪
     * @param {Cloud139Service} cloud139 
     * @param {string} fileId 
     * @param {number} size 
     * @param {string} fileName 
     * @returns {Promise<boolean>} 是否为真实 BluRay 原盘
     */
    async probeIsoIsRealBluRay(cloud139, fileId, size, fileName) {
        try {
            const MIN_BLURAY_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 物理蓝光 BD-25 最小有效门槛 (10GB)
            if (size < MIN_BLURAY_SIZE_BYTES) {
                const sizeGb = (size / (1024 * 1024 * 1024)).toFixed(2);
                logger.info(`[媒体探针-ISO] 文件容量仅 ${sizeGb}GB，远低于物理蓝光 BD-25 最小有效门槛(10GB)，判定为防封打包假原盘，严禁虚标 BluRay`);
                return false;
            }

            logger.info(`[媒体探针-ISO] 正在提取 139 直链进行 Range 免下载辨伪: ${fileName}`);
            const directUrl = await cloud139.getDownloadUrl(fileId);
            if (!directUrl) {
                logger.warn(`[媒体探针-ISO] 无法获取直链，跳过探针辨伪`);
                return false;
            }

            const reader = IsoProbeService.createHttpRangeReader(directUrl);
            const probeResult = await IsoProbeService.detectAndLocateMediaStream(reader, size, fileName);

            if (probeResult && probeResult.isBluRay === true) {
                logger.info(`[媒体探针-ISO] 探测确认：UDF 2.50 蓝光原盘主流 (${probeResult.name || 'm2ts'})，准许标注 BluRay`);
                return true;
            }

            if (probeResult && (probeResult.isFakeIso || probeResult.isFakeDisc)) {
                logger.info(`[媒体探针-ISO] 探测确认：假 ISO 或防封打包假原盘 (真实容器: ${probeResult.container || probeResult.realExt || 'Repack'})，严禁标 BluRay`);
                return false;
            }

            logger.info(`[媒体探针-ISO] 未检测到 UDF 2.50 蓝光原盘结构，严禁虚高标注 BluRay`);
            return false;
        } catch (err) {
            logger.warn(`[媒体探针-ISO] 探针执行异常: ${err.message}`);
            return false;
        }
    }

    /**
     * 递归收集暂存区目录下的全部文件与子文件夹，并精确保留各条目的父目录与顶级作品目录名称
     * @param {Cloud139Service} cloud139 
     * @param {string} rootCatalogId 
     * @returns {Promise<Array<object>>}
     */
    async _collectAllStagingEntries(cloud139, rootCatalogId, initialParentName = '暂存区根目录', initialTopId = '', initialTopName = '') {
        const results = [];
        const visitedDirs = new Set();

        const walk = async (folderId, parentFolderName = '', topFolderId = '', topFolderName = '', currentPath = '') => {
            if (visitedDirs.has(folderId)) return;
            visitedDirs.add(folderId);

            const items = await cloud139.listDiskDirAll(folderId).catch(() => []);
            for (const item of items) {
                const isDirectChild = (folderId === rootCatalogId);
                const curTopId = isDirectChild ? (topFolderId || (item.type === 'folder' ? item.fileId : '')) : topFolderId;
                const curTopName = isDirectChild ? (topFolderName || (item.type === 'folder' ? item.name : '')) : topFolderName;
                const relPath = currentPath ? `${currentPath}/${item.name}` : item.name;

                item.parentCatalogId = folderId;
                item.parentFolderName = parentFolderName;
                item.topCatalogId = curTopId;
                item.topFolderName = curTopName;
                item.relativePath = relPath;

                results.push(item);
                if (item.type === 'folder') {
                    await walk(item.fileId, item.name, curTopId, curTopName, relPath);
                }
            }
        };

        await walk(rootCatalogId, initialParentName, initialTopId, initialTopName, '');
        return results;
    }

    /**
     * 执行单个频道的轮询监控扫描
     * @param {number} monitorId 
     * @returns {Promise<object>}
     */
    async scanSingleMonitor(monitorId) {
        const monitorRepo = getChannelMonitorRepository();
        const historyRepo = getChannelMonitorHistoryRepository();

        const monitor = await monitorRepo.findOne({ where: { id: monitorId } });
        if (!monitor) throw new Error(`未找到 ID 为 ${monitorId} 的频道监控`);
        if (monitor.status === 'paused') {
            logger.info(`[频道监控] 监控已暂停，跳过执行: ${monitor.name}`);
            return { scanned: 0, transferred: 0, status: 'paused' };
        }

        const maxPosts = ConfigService.getConfigValue('channelMonitor.maxPostsPerCheck', 10);
        const checkMsg = `[频道监控] 开始执行监控检查: [${monitor.name}] (${monitor.channelUrl})`;
        logger.info(checkMsg);

        const posts = await this.fetchChannelPosts(monitor.channelUrl, maxPosts);
        let transferredCount = 0;
        let lastMsgId = monitor.lastMessageId || 0;

        for (const post of posts) {
            // 1. 防重检查：已处理过的历史消息跳过（成功、已过滤或已失败均跳过，禁止轮询死循环重试；重试由 WebUI 手动触发）
            const existingHistory = await historyRepo.findOne({
                where: { channelId: monitor.id, messageId: post.messageId }
            });
            if (existingHistory) {
                continue;
            }
            if (post.messageId <= lastMsgId) {
                continue;
            }

            // 2. 嗅探 139 网盘链接
            const linkInfo = TgChannelMonitorService.sniff139Links(post.text, post.links);
            if (!linkInfo) {
                // 推文不含 139 链接，静默跳过并写入流水
                await historyRepo.save({
                    ...(existingHistory ? { id: existingHistory.id } : {}),
                    channelId: monitor.id,
                    channelName: monitor.name,
                    messageId: post.messageId,
                    postUrl: post.postUrl,
                    postTitle: (post.text || '').split('\n')[0].slice(0, 50),
                    rawText: post.text,
                    status: 'skipped_no_link',
                    reason: '推文中未包含 139 移动云盘分享链接'
                });
                lastMsgId = Math.max(lastMsgId, post.messageId);
                continue;
            }

            // 3. 文本前置黑名单过滤
            const textFilter = TgChannelMonitorService.filterPostText(post, monitor);
            if (!textFilter.pass) {
                logger.info(`[频道监控] 推文命中文本黑名单拦截: ${post.postUrl} (${textFilter.reason})`);
                await historyRepo.save({
                    ...(existingHistory ? { id: existingHistory.id } : {}),
                    channelId: monitor.id,
                    channelName: monitor.name,
                    messageId: post.messageId,
                    postUrl: post.postUrl,
                    postTitle: (post.text || '').split('\n')[0].slice(0, 50),
                    rawText: post.text,
                    shareLink: linkInfo.shareUrl,
                    accessCode: linkInfo.passwd,
                    status: 'skipped_filter',
                    reason: textFilter.reason
                });
                lastMsgId = Math.max(lastMsgId, post.messageId);
                continue;
            }

            // 4. 执行转存与整理
            const postFirstLine = (post.text || '').split('\n')[0].trim();
            const postPreview = post.text ? post.text.slice(0, 300).replace(/\n+/g, ' | ') : '';
            const hitMsg = `[频道监控-命中推文] 频道: [${monitor.name}], 消息ID: ${post.messageId}, 链接: ${post.postUrl}\n[推文标题] "${postFirstLine}"\n[推文原文] ${postPreview}`;
            logger.info(hitMsg);
            logTaskEvent(hitMsg);
            try {
                const result = await this.executeChannelIngestion(monitor, post, linkInfo);
                await historyRepo.save({
                    ...(existingHistory ? { id: existingHistory.id } : {}),
                    channelId: monitor.id,
                    channelName: monitor.name,
                    messageId: post.messageId,
                    postUrl: post.postUrl,
                    postTitle: (post.text || '').split('\n')[0].slice(0, 50),
                    rawText: post.text,
                    shareLink: linkInfo.shareUrl,
                    accessCode: linkInfo.passwd,
                    status: result.status,
                    reason: result.reason || '转存并整理成功',
                    transferredCount: result.transferredCount,
                    transferredDetails: JSON.stringify(result.details || [])
                });

                if (result.status === 'success') {
                    transferredCount += result.transferredCount;
                }
            } catch (ingestErr) {
                const failMsg = `[频道监控] 转存处理失败: ${ingestErr.message}`;
                logger.error(failMsg);
                logTaskEvent(failMsg);
                await historyRepo.save({
                    ...(existingHistory ? { id: existingHistory.id } : {}),
                    channelId: monitor.id,
                    channelName: monitor.name,
                    messageId: post.messageId,
                    postUrl: post.postUrl,
                    postTitle: (post.text || '').split('\n')[0].slice(0, 50),
                    rawText: post.text,
                    shareLink: linkInfo.shareUrl,
                    accessCode: linkInfo.passwd,
                    status: 'failed',
                    reason: ingestErr.message
                });
            }

            lastMsgId = Math.max(lastMsgId, post.messageId);
        }

        // 更新监控进度
        monitor.lastMessageId = lastMsgId;
        monitor.lastCheckedAt = new Date();
        await monitorRepo.save(monitor);

        const doneMsg = `[频道监控] 检查完成: [${monitor.name}], 处理新消息: ${posts.length}, 成功入库: ${transferredCount}`;
        logger.info(doneMsg);
        return { scanned: posts.length, transferred: transferredCount, lastMessageId: lastMsgId };
    }

    /**
     * 重试单条监控历史记录（重新解析提取码与链接并执行转存入库）
     * @param {number} historyId
     * @returns {Promise<object>}
     */
    async retryHistoryItem(historyId) {
        const historyRepo = getChannelMonitorHistoryRepository();
        const monitorRepo = getChannelMonitorRepository();

        const history = await historyRepo.findOne({ where: { id: historyId } });
        if (!history) {
            throw new Error(`未找到历史记录 ID: ${historyId}`);
        }

        const monitor = await monitorRepo.findOne({ where: { id: history.channelId } });
        if (!monitor) {
            throw new Error(`未找到关联的频道监控项 (channelId=${history.channelId})`);
        }

        // 重新嗅探链接与提取码
        const linkInfo = TgChannelMonitorService.sniff139Links(history.rawText, history.shareLink ? [history.shareLink] : []);
        if (!linkInfo) {
            throw new Error('未能在推文或链接中识别到 139 网盘分享');
        }

        const post = {
            messageId: history.messageId,
            postUrl: history.postUrl,
            text: history.rawText,
            channel: monitor.name
        };

        const postFirstLine = (post.text || '').split('\n')[0].trim();
        const postPreview = post.text ? post.text.slice(0, 300).replace(/\n+/g, ' | ') : '';
        const reingestMsg = `[频道监控-重试推文] 频道: [${monitor.name}], 消息ID: ${post.messageId}\n[推文标题] "${postFirstLine}"\n[推文原文] ${postPreview}`;
        logger.info(reingestMsg);

        try {
            const result = await this.executeChannelIngestion(monitor, post, linkInfo);

            // 回填历史记录
            history.shareLink = linkInfo.shareUrl;
            history.accessCode = linkInfo.passwd;
            history.status = result.status;
            history.reason = result.reason || '重试转存成功';
            history.transferredCount = result.transferredCount || 0;
            history.transferredDetails = JSON.stringify(result.details || []);
            await historyRepo.save(history);

            return {
                historyId: history.id,
                status: history.status,
                accessCode: history.accessCode,
                reason: history.reason,
                transferredCount: history.transferredCount
            };
        } catch (err) {
            history.shareLink = linkInfo.shareUrl;
            history.accessCode = linkInfo.passwd;
            history.status = 'failed';
            history.reason = err.message;
            await historyRepo.save(history);
            throw err;
        }
    }

    /**
     * 批量执行所有激活频道的监控扫描（定时任务入口）
     */
    async scanAllMonitors() {
        if (!ConfigService.getConfigValue('channelMonitor.enabled', true)) {
            logger.debug('[频道监控] 全局监控开关未开启，跳过轮询');
            return;
        }

        const monitorRepo = getChannelMonitorRepository();
        const activeMonitors = await monitorRepo.find({ where: { status: 'active' } });
        if (!activeMonitors.length) {
            logger.debug('[频道监控] 暂无处于激活状态的频道监控任务');
            return;
        }

        const pollMsg = `[频道监控] 开始全量轮询，共 ${activeMonitors.length} 个活跃频道...`;
        logger.info(pollMsg);
        for (const monitor of activeMonitors) {
            try {
                await this.scanSingleMonitor(monitor.id);
            } catch (err) {
                const errMsg = `[频道监控] 轮询频道 [${monitor.name}] 发生异常: ${err.message}`;
                logger.error(errMsg);
            }
        }
    }

    /**
     * 校验整理功能的前置配置要求：
     * 必须同时满足：
     * 1. TMDB API 已经配置（tmdbApiKey / token 非空）
     * 2. 频道监控 基础配置已完成（enabled !== false，stagingFolderId 已选定绑定，且配置了监控频道）
     * @param {object} [options] 可选参数 { stagingFolderId }
     * @returns {Promise<{ ready: boolean, missing: string[], reason: string, details: object }>}
     */
    static async validateOrganizePrerequisites(options = {}) {
        const { StagingOrganizeService } = require('../StagingOrganizeService');
        return StagingOrganizeService.validateOrganizePrerequisites(options);
    }

    /**
     * 立即对 139 云盘暂存区现存的所有文件执行全量影视规范整理与归档入库
     * 独立于 Telegram 频道推文监控，直接针对暂存区进行清洗、TMDB匹配、洗版、点分规范命名并移动到媒体库
     * @param {object} [options] 可选参数 { accountId, stagingFolderId, targetFolderId }
     * @returns {Promise<{ scanned: number, organized: number, details: Array }>}
     */
    async organizeStagingFolder(options = {}) {
        const { StagingOrganizeService } = require('../StagingOrganizeService');
        return StagingOrganizeService.getInstance().organizeStagingFolder(options);
    }

}

module.exports = { TgChannelMonitorService };

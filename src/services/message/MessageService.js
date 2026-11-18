/**
 * 消息推送服务接口基类
 *
 * 同时承载 Telegram Bot 交互通道与消息推送通道共享的格式工具层：
 * - HTML 实体转义（escapeHtmlEntities）
 * - Telegram 消息长度保护（truncateForTelegram）
 * - 卡片类型/级别自动识别（resolveCardMeta + CARD_TYPE_PATTERNS）
 * - 级别徽章（buildLevelBadge）
 * - HTML 降级纯文本（stripHtmlTags）
 * - 统一 HTML 渲染管线（renderCardHtml）
 */

const LEVEL_BADGES = Object.freeze({
    info: 'ℹ️ 信息',
    success: '✅ 成功',
    warning: '⚠️ 警告',
    error: '❌ 错误',
});

const DEFAULT_TRUNCATE_GUIDE = '…\n查看完整清单请前往管理面板';

// 九类存量通知卡片：首行标题匹配模式 ↔ 卡片类型 ↔ 默认级别（识别单一事实来源）
const CARD_TYPE_PATTERNS = Object.freeze([
    Object.freeze({ cardType: '追更入库', pattern: /^\[追更通知\]/, level: 'success' }),
    Object.freeze({ cardType: '整理完成', pattern: /^\[139云盘整理\]/, level: 'success' }),
    Object.freeze({ cardType: '违规死链告警', pattern: /^【139网盘违规检测提醒】/, level: 'warning' }),
    Object.freeze({ cardType: '空目录清理报告', pattern: /^【139网盘清理报告】/, level: 'success' }),
    Object.freeze({ cardType: '资产去重报告', pattern: /^【139网盘资产去重报告】/, level: 'warning' }),
    Object.freeze({ cardType: '剧集缺更巡检报告', pattern: /^(?:📺)?【139网盘 剧集缺更巡检报告】/, level: 'warning' }),
    Object.freeze({ cardType: '认证失效告警', pattern: /^【认证失效通知】/, level: 'warning' }),
    Object.freeze({ cardType: '深度删除联动通知', pattern: /^【神医助手\/Emby 深度删除】/, level: 'success' }),
    Object.freeze({ cardType: '刮削媒体卡片', pattern: /^【影视刮削提醒】/, level: 'warning' }),
]);

// 入库记录偏差标注（业务侧追加的文案标记）：成功级卡片命中后升级为警告级
const RECORD_DEVIATION_PATTERN = /⚠️ \[入库偏差\]/;

class MessageService {
    constructor(config) {
        this.config = config;
        this.enabled = false;
    }

    /**
     * 初始化服务
     */
    initialize() {
        this.enabled = this.checkEnabled();
    }

    /**
     * 检查服务是否启用
     * @returns {boolean}
     */
    checkEnabled() {
        return false;
    }

    /**
     * 发送消息
     * @param {string} message - 要发送的消息内容
     * @param {object} [options] - 可选卡片元数据声明 { level?, cardType? }，缺省走自动识别
     * @returns {Promise<boolean>} - 发送结果
     */
    async sendMessage(message, options) {
        if (!this.enabled) {
            return false;
        }
        return await this._send(message, options);
    }

    /**
     * 发送刮削消息
     * @param {object} message - 要发送的消息内容
     * @param {object} [options] - 可选卡片元数据声明（当前渠道实现可忽略）
     * @returns {Promise<boolean>} - 发送结果
     */
    async sendScrapeMessage(message, options) {
        if (!this.enabled) {
            return false;
        }
        return await this._sendScrapeMessage(message, options);
    }
    /**
     * 实际发送消息的方法，需要被子类实现
     * @param {string} message - 要发送的消息内容
     * @param {object} [options] - 可选卡片元数据声明
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message, options) {
        throw new Error('_send method must be implemented by subclass');
    }

    /**
     * 实际发送刮削消息的方法，需要被子类实现
     * @param {object} message - 要发送的消息内容
     * @param {object} [options] - 可选卡片元数据声明
     * @returns {Promise<boolean>} - 发送结果
     */
    async _sendScrapeMessage(message, options) {
        throw new Error('_sendScrapeMessage method must be implemented by subclass');
    }

    /**
     * 转换消息为标准的markdown格式（仅供 Markdown 类渠道：Bark/WxPusher/PushPlus；
     * Telegram 通道已切换为 HTML 渲染管线 renderCardHtml，不再复用本方法输出）
     * @param {string} message - 要转换的消息内容
     * @returns {string} - 转换后的消息内容
     */
    async convertToMarkdown(message) {
        return message
                // 加粗标题：仅收敛到行首方括号标题行（如 "[追更通知] xxx更新N集"），
                // 避免命中 "最后更新时间：…" 等普通行产生意外加粗
                .replace(/^(\[[^\]\n]+\][^\n]*?)更新/gm, '🎉*$1*更新')
                // 移除 HTML 标签并转换为 Telegram 代码格式
                .replace(/<font color="warning">/g, '`')
                .replace(/<font color="info">/g, '`')
                .replace(/<\/font>/g, '`')
                // 替换引用格式为列表项：行首锚定（修复原 ">s*" 未锚定导致正文任意 ">" 被误改写）
                .replace(/^>\s*/gm, '   - ');
    }

    /**
     * HTML 实体转义：& < > 全实体化，输出恒为可安全嵌入 parse_mode: 'HTML' 报文的文本
     * @param {string} text
     * @returns {string}
     */
    static escapeHtmlEntities(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Telegram 消息长度保护：超长时保头截尾（优先保留标题与统计摘要区），
     * 截断处追加引导语（引导语长度计入 limit 预算）；未超长原样返回
     * @param {string} text
     * @param {number} [limit=4096] Telegram 文本上限（caption 场景传 1024）
     * @param {string} [guide] 截断引导语，传 null 关闭
     * @returns {string}
     */
    static truncateForTelegram(text, limit = 4096, guide = DEFAULT_TRUNCATE_GUIDE) {
        const source = String(text ?? '');
        const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 4096;
        if (source.length <= effectiveLimit) {
            return source;
        }
        const guideText = guide === undefined || guide === null ? DEFAULT_TRUNCATE_GUIDE : String(guide);
        const budget = effectiveLimit - guideText.length;
        const head = budget > 0 ? source.slice(0, budget) : '';
        return head + guideText;
    }

    /**
     * 卡片元数据解析：按首行标题模式匹配九类存量卡片，返回 { cardType, level, titleLine }；
     * options.level / options.cardType 显式声明优先于自动识别；
     * 含 "[入库偏差]" 标注的成功级卡片自动升级为警告级；
     * 未识别且无显式声明返回 null（调用方透传原文，保证存量消息零变化）
     * @param {string} message
     * @param {object} [options] { level?, cardType? }
     * @returns {{cardType: string, level: string, titleLine: string}|null}
     */
    static resolveCardMeta(message, options = {}) {
        const text = String(message ?? '');
        if (!text) {
            return null;
        }
        const firstLineEnd = text.indexOf('\n');
        const titleLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);

        let matched = null;
        for (const entry of MessageService.CARD_TYPE_PATTERNS) {
            if (entry.pattern.test(titleLine)) {
                matched = entry;
                break;
            }
        }

        const explicitLevel = options && typeof options.level === 'string' ? options.level : null;
        const explicitCardType = options && typeof options.cardType === 'string' ? options.cardType : null;
        let cardType = explicitCardType || (matched ? matched.cardType : null);
        let level = explicitLevel || (matched ? matched.level : null);

        if (!cardType && !level) {
            return null;
        }
        if (!cardType) {
            cardType = '未知卡片';
        }
        if (!level) {
            level = 'info';
        }
        if (level === 'success' && MessageService.RECORD_DEVIATION_PATTERN.test(text)) {
            level = 'warning';
        }
        return { cardType, level, titleLine };
    }

    /**
     * 级别徽章：统一图标与前缀文案
     * @param {string} level info|success|warning|error
     * @returns {string}
     */
    static buildLevelBadge(level) {
        return LEVEL_BADGES[level] || `ℹ️ ${level}`;
    }

    /**
     * 剥离 HTML 标签并还原常见实体，用于格式解析失败后的纯文本降级重发
     * @param {string} text
     * @returns {string}
     */
    static stripHtmlTags(text) {
        return String(text ?? '')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&');
    }

    /**
     * 统一 HTML 渲染管线（Telegram Bot 交互通道与推送通道共用）：
     * resolveCardMeta 识别 → 全文实体转义 → 命中卡片时注入级别徽章、首行 <b> 强化、
     * 树形明细行 <code> 化（未识别文本仅转义，保留原文结构）→ 4096 长度保护
     * @param {string} message 原始纯文本消息（不含 HTML 标签）
     * @param {object} [options] { level?, cardType? } 显式卡片元数据声明
     * @returns {string} 可直接以 parse_mode: 'HTML' 发送的文本
     */
    static renderCardHtml(message, options = {}) {
        const source = String(message ?? '');
        const meta = MessageService.resolveCardMeta(source, options);
        const rawLines = source.split('\n');
        const escapedLines = rawLines.map(line => MessageService.escapeHtmlEntities(line));
        if (meta) {
            const badge = MessageService.buildLevelBadge(meta.level);
            escapedLines[0] = `${badge} <b>${escapedLines[0]}</b>`;
            for (let i = 1; i < rawLines.length; i++) {
                if (/[├└]─|📁/.test(rawLines[i])) {
                    escapedLines[i] = `<code>${escapedLines[i]}</code>`;
                }
            }
        }
        return MessageService.truncateForTelegram(escapedLines.join('\n'));
    }
}

MessageService.CARD_TYPE_PATTERNS = CARD_TYPE_PATTERNS;
MessageService.LEVEL_BADGES = LEVEL_BADGES;
MessageService.RECORD_DEVIATION_PATTERN = RECORD_DEVIATION_PATTERN;

module.exports = MessageService;
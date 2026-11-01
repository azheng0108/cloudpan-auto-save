const got = require('got');
const MessageService = require('./MessageService');
const ProxyUtil = require('../../utils/ProxyUtil');
const logger = require('../../utils/logger');

class TelegramService extends MessageService {
    /**
     * 检查服务是否启用
     * @returns {boolean}
     */
    checkEnabled() {
        return !!(this.config.botToken && this.config.chatId);
    }
    /**
     * 配置代理信息
     */
    _proxy() {
        return ProxyUtil.getProxyAgent('telegram');
    }

    /**
     * 判定是否为 Telegram 4xx"无法解析"类格式错误（触发纯文本降级重发）；
     * 网络超时/5xx/429 限流不属格式问题，不触发降级，避免重试风暴
     * @param {Error} error
     * @returns {boolean}
     */
    _isParseError(error) {
        const statusCode = error && (error.response && error.response.statusCode) !== undefined
            ? error.response.statusCode
            : error && error.code;
        if (typeof statusCode !== 'number') {
            return false;
        }
        if (statusCode === 429) {
            return false;
        }
        return statusCode >= 400 && statusCode < 500;
    }

    /**
     * 实际发送消息（HTML 渲染管线 + 失败降级重发）
     * @param {string} message - 要发送的消息内容
     * @param {object} [options] - 可选卡片元数据声明 { level?, cardType? }
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message, options = {}) {
        let html = '';
        let rawContent = typeof message === 'string' ? message : (message?.text || message?.caption || String(message || ''));

        // 自动提取可能嵌入的海报图片 URL
        let image = (options && options.image) || (message && typeof message === 'object' && message.image);
        if (!image && typeof rawContent === 'string') {
            const posterMatch = rawContent.match(/<!--\s*poster:\s*(https?:\/\/[^\s>]+)\s*-->/i);
            if (posterMatch) {
                image = posterMatch[1];
            }
        }

        // 清理隐藏的海报注释标签
        if (typeof rawContent === 'string') {
            rawContent = rawContent.replace(/<!--\s*poster:\s*https?:\/\/[^\s>]+\s*-->/gi, '').trim();
        }

        // 如果正文已经包含结构化影视卡片 (📺 <b>)，将首行标记美化为标准状态头部
        if (/📺\s*<b>/i.test(rawContent)) {
            rawContent = rawContent.replace(/^\[追更通知\][^\n]*\n+/i, '✅ <b>139 移动云盘转存成功</b>\n\n');
            html = MessageService.truncateForTelegram(rawContent, image ? 1024 : 4096);
        } else if (/<[a-z][\s\S]*>/i.test(rawContent)) {
            html = MessageService.truncateForTelegram(rawContent, image ? 1024 : 4096);
        } else {
            html = MessageService.renderCardHtml(rawContent, options);
        }

        // 若存在高清海报，优先调用 Telegram 官方 sendPhoto 发送图文一体卡片 (Photo Caption)
        if (image && typeof image === 'string' && image.startsWith('http')) {
            try {
                const photoOptions = {
                    json: {
                        chat_id: this.config.chatId,
                        photo: image,
                        caption: MessageService.truncateForTelegram(html, 1024),
                        parse_mode: 'HTML'
                    },
                    timeout: {
                        request: 8000
                    },
                    agent: this._proxy()
                };

                let apiUrl = 'https://api.telegram.org';
                if (this.config.cfProxyDomain) {
                    photoOptions.proxy = false;
                    apiUrl = this.config.cfProxyDomain;
                }

                await got.post(`${apiUrl}/bot${this.config.botToken}/sendPhoto`, photoOptions).json();
                return true;
            } catch (photoError) {
                logger.warn(`[Telegram推送] 发送海报卡片失败，安全降级为普通消息: ${photoError.message}`);
            }
        }

        try {
            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    text: html,
                    parse_mode: 'HTML'
                },
                timeout: {
                    request: 5000
                },
                agent: this._proxy()
            };

            let apiUrl = 'https://api.telegram.org';
            if (this.config.cfProxyDomain) {
                requestOptions.proxy = false;
                apiUrl = this.config.cfProxyDomain;
            }

            await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
            return true;
        } catch (error) {
            if (this._isParseError(error)) {
                try {
                    const plain = MessageService.stripHtmlTags(html);
                    const retryOptions = {
                        json: {
                            chat_id: this.config.chatId,
                            text: MessageService.truncateForTelegram(plain)
                        },
                        timeout: {
                            request: 5000
                        },
                        agent: this._proxy()
                    };
                    let apiUrl = 'https://api.telegram.org';
                    if (this.config.cfProxyDomain) {
                        retryOptions.proxy = false;
                        apiUrl = this.config.cfProxyDomain;
                    }
                    await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, retryOptions).json();
                    logger.warn('Telegram消息HTML格式被拒，已降级为纯文本重发成功');
                    return true;
                } catch (retryError) {
                    logger.error('Telegram消息降级重发失败', { error: retryError.message, stack: retryError.stack });
                    return false;
                }
            }
            logger.error(this._formatError(error), { error: error.message, stack: error.stack });
            return false;
        }
    }

    _formatError(error) {
        let reason = '';
        const body = error.response?.body;
        if (body) {
            try {
                const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                if (parsed && parsed.description) {
                    reason = `Telegram官方返回: ${parsed.description}`;
                }
            } catch (_) {
                reason = `HTTP ${error.response?.statusCode}: ${String(body).slice(0, 150)}`;
            }
        }
        if (!reason && error.errors && Array.isArray(error.errors)) {
            reason = error.errors.map(e => e.message || e.code).filter(Boolean).join('; ');
        }
        if (!reason) {
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || (error.stack && error.stack.includes('ETIMEDOUT'))) {
                reason = '连接 Telegram API 超时或网络不可达（建议在系统设置中配置代理或 Cloudflare 反代域名）';
            } else {
                reason = error.message || error.code || '未知网络错误';
            }
        }
        return `[Telegram推送失败] 目标chatId: ${this.config.chatId} | 原因: ${reason}`;
    }

     // 发送刮削结果, {title: mediaDetails.title,image: mediaDetails.backdropPath,description: mediaDetails.overview,rating: mediaDetails.voteAverage}
     async _sendScrapeMessage(message) {
        logger.info('准备发送刮削结果')
        try {
            // 构建消息内容（HTML 化：标题转义加粗，简介转义并截断至 caption 上限）
            const typeLabel = message.type === 'tv' ? '电视剧' : '电影';
            const ratingPart = message.rating ? `评分：${message.rating}` : '';
            const descriptionPart = message.description
                ? `\n${MessageService.escapeHtmlEntities(message.description.split('\n').slice(0, 2).join('\n'))}${message.description.split('\n').length > 2 ? '...' : ''}`
                : '';
            const caption = MessageService.truncateForTelegram(
                `<b>${MessageService.escapeHtmlEntities(message.title)}</b>\n类型：${typeLabel} ${ratingPart}${descriptionPart}`,
                1024
            );

            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    photo: message.image,
                    caption: caption,
                    parse_mode: 'HTML'
                },
                timeout: {
                    request: 5000
                },
                agent: this._proxy()
            };

            let apiUrl = 'https://api.telegram.org';
            if (this.config.cfProxyDomain) {
                requestOptions.proxy = false;
                apiUrl = this.config.cfProxyDomain;
            }

            // 如果有图片则发送图片+描述，否则只发送文本
            if (message.image) {
                try {
                    await got.post(`${apiUrl}/bot${this.config.botToken}/sendPhoto`, requestOptions).json();
                } catch (photoError) {
                    if (!this._isParseError(photoError)) {
                        throw photoError;
                    }
                    // caption 格式被拒：保底降级为纯文本消息，禁止整体失败
                    requestOptions.json.text = MessageService.stripHtmlTags(caption);
                    delete requestOptions.json.photo;
                    delete requestOptions.json.caption;
                    delete requestOptions.json.parse_mode;
                    await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
                }
            } else {
                requestOptions.json.text = caption;
                delete requestOptions.json.photo;
                delete requestOptions.json.caption;
                await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
            }
            return true;
        } catch (error) {
            logger.error(this._formatError(error), { error: error.message, stack: error.stack });
            return false;
        }
    }
}

module.exports = TelegramService;
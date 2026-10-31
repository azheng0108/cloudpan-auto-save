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
    async _send(message, options) {
        let html = '';
        try {
            html = MessageService.renderCardHtml(message, options);
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
            logger.error('Telegram消息推送异常', { error: error.message, stack: error.stack });
            return false;
        }
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
            logger.error('Telegram消息推送异常', { error: error.message, stack: error.stack });
            return false;
        }
    }
}

module.exports = TelegramService;
const got = require('got');
const MessageService = require('./MessageService');
const ProxyUtil = require('../../utils/ProxyUtil');

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
     * 实际发送消息
     * @param {string} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message) {
        try {
            const msg = await this.convertToMarkdown(message)
            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    text: msg,
                    parse_mode: 'Markdown'
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
            console.error('Telegram消息推送异常:', error);
            return false;
        }
    }
     // 发送刮削结果, {title: mediaDetails.title,image: mediaDetails.backdropPath,description: mediaDetails.overview,rating: mediaDetails.voteAverage}
     async _sendScrapeMessage(message) {
        console.log("准备发送刮削结果")
        try {
            // 构建消息内容
            const caption = [
                `*${message.title}*`,
                `\n类型：${message.type === 'tv' ? '电视剧' : '电影'} ${message.rating ? `评分：${message.rating}` : ''}`,
                message.description ? `\n${message.description.split('\n').slice(0, 2).join('\n')}${message.description.split('\n').length > 2 ? '...' : ''}` : '',
            ].join('');

            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    photo: message.image,
                    caption: caption,
                    parse_mode: 'Markdown'
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
                await got.post(`${apiUrl}/bot${this.config.botToken}/sendPhoto`, requestOptions).json();
            } else {
                requestOptions.json.text = caption;
                delete requestOptions.json.photo;
                await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
            }
            return true;
        } catch (error) {
            console.error('Telegram消息推送异常:', error);
            return false;
        }
    }
}

module.exports = TelegramService;
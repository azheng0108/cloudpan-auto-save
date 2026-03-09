const got = require('got');
const MessageService = require('./MessageService');

class WxPusherService extends MessageService {
    /**
     * 检查服务是否启用
     * @returns {boolean}
     */
    checkEnabled() {
        return !!this.config.spt;
    }

    /**
     * 实际发送消息
     * @param {string} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message) {
        try {
            const url = "https://wxpusher.zjiecode.com/api/send/message/simple-push";
            const msg = await this.convertToMarkdown(message)
            const data = {
                // summary: "天翼云盘更新",
                content: msg,
                content_type: 3,
                spt: this.config.spt
            };
            const resp = await got.post(url, {
                json: data
            }).json();
            return true;
        } catch (error) {
            console.error('WxPusher消息推送异常:', error);
            return false;
        }
    }

    async _sendScrapeMessage(message) {
        try {
            const content = [
                `<h3>${message.title}</h3>`,
                `<p>类型：${message.type === 'tv' ? '电视剧' : '电影'} 评分：${message.rating || '暂无'}</p>`,
                message.description ? `<p>${message.description.split('\n').slice(0, 2).join('<br>')}${message.description.split('\n').length > 2 ? '...' : ''}</p>` : '',
                message.image ? `<img src="${message.image}" alt="封面">` : ''
            ].join('');

            await got.post('https://wxpusher.zjiecode.com/api/send/message/simple-push', {
                json: {
                    summary: message.title,
                    content: content,
                    content_type: 2, // HTML类型
                    spt: this.config.spt
                }
            }).json();
            return true;
        } catch (error) {
            console.error('WxPusher图片消息推送异常:', error);
            return false;
        }
    }
}

module.exports = WxPusherService;
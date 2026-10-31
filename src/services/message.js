const messageManager = require('./message/MessageManager');
const ConfigService = require('./ConfigService');


class MessageUtil {
    constructor() {
        this._init();
    }

    _init() {
        const settings = ConfigService.getConfig()
        // 初始化消息推送配置
        messageManager.initialize({
            wework: {
                enabled: settings.wecom?.enable || false,
                webhook: settings.wecom?.webhook || '',
            },
            telegram: {
                enabled: settings.telegram?.enable || false,
                botToken: settings.telegram?.botToken || '',
                chatId: settings.telegram?.chatId || '',
                proxy: {
                    type: "http",
                    host: settings.proxy?.host || '',
                    port: settings.proxy?.port || '',
                    username: settings.proxy?.username || '',
                    password: settings.proxy?.password || ''
                },
                cfProxyDomain: settings.telegram?.proxyDomain || ''
            },
            wxpusher: {
                enabled: settings.wxpusher?.enable || false,
                spt: settings.wxpusher?.spt || ''
            },
            bark:{
                enabled: settings.bark?.enable || false,
                serverUrl: settings.bark?.serverUrl || '',
                key: settings.bark?.key || '',
            },
            pushplus:{
                enabled: settings.pushplus?.enable || false,
                token: settings.pushplus?.token || '',
                topic: settings.pushplus?.topic || '',
                channel: settings.pushplus?.channel || '',
                webhook: settings.pushplus?.webhook || '',
                to: settings.pushplus?.to || '',
            },
            customPush: settings.customPush || []
        });
    }


    async updateConfig() {
        this._init();
    }

    // 发送消息
    // options: { level?: 'info'|'success'|'warning'|'error', cardType?: string } 显式声明卡片元数据，缺省走通道自动识别
    async sendMessage(message, options) {
        if (options !== undefined) {
            await messageManager.sendMessage(message, options);
        } else {
            await messageManager.sendMessage(message);
        }
    }
    // 发送刮削消息
    async sendScrapeMessage(message, options) {
        if (options !== undefined) {
            await messageManager.sendScrapeMessage(message, options);
        } else {
            await messageManager.sendScrapeMessage(message);
        }
    }
}

module.exports = { MessageUtil };
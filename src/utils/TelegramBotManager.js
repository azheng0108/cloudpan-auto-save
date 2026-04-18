const { logTaskEvent } = require('./logUtils');

class TelegramBotManager {
    static instance = null;
    static bot = null;
    static chatId = null;

    static getInstance() {
        if (!TelegramBotManager.instance) {
            TelegramBotManager.instance = new TelegramBotManager();
        }
        return TelegramBotManager.instance;
    }

    async handleBotStatus(botToken, chatId, enable) {
        // 懒加载：仅在首次需要 Telegram 功能时才 require，避免冷启动时加载 node-telegram-bot-api
        const { TelegramBotService } = require('../services/telegramBot');
        const shouldEnableBot = !!(enable && botToken && chatId);
        const botTokenChanged = TelegramBotManager.bot?.token !== botToken;
        const chatIdChanged = TelegramBotManager.bot?.chatId!== chatId;
        if (TelegramBotManager.bot && (!shouldEnableBot || botTokenChanged || chatIdChanged)) {
            await TelegramBotManager.bot.stop();
            TelegramBotManager.bot = null;
            logTaskEvent(`Telegram机器人已停用`);
        }

        if (shouldEnableBot && (!TelegramBotManager.bot || botTokenChanged || chatIdChanged)) {
            TelegramBotManager.bot = new TelegramBotService(botToken, chatId);
            TelegramBotManager.bot.start()
            .then(() => {
                logTaskEvent(`Telegram机器人已启动`);
            })
            .catch(error => {
                logTaskEvent(`Telegram机器人启动失败: ${error.message}`);
            });
        }
    }

    getBot() {
        return TelegramBotManager.bot;
    }
}

module.exports = TelegramBotManager;
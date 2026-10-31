const TelegramBot = require('node-telegram-bot-api');
const { AppDataSource } = require('../database');
const { Task, Account, CommonFolder, TransferredFile } = require('../entities');
const { TaskService } = require('./task');
const { Cloud139Service } = require('./cloud139');
const { TMDBService } = require('./tmdb');
const path = require('path');
const ProxyUtil = require('../utils/ProxyUtil');
const Cloud139Utils = require('../utils/Cloud139Utils');
const logger = require('../utils/logger');
const MessageService = require('./message/MessageService');

/**
 * 指令注册表：在役指令全集的单一事实来源。
 * 菜单注册（start→setMyCommands）、指令监听（initCommands→onText）、
 * 帮助文本（buildHelpText）三处均由本常量同源派生，消除清单漂移。
 */
const COMMANDS = Object.freeze([
    Object.freeze({ name: 'help', aliases: [], group: '基础命令', description: '显示帮助信息', pattern: /^\/help$/, handler: 'showHelp', registerMenu: true, requireAccount: false }),
    Object.freeze({ name: 'accounts', aliases: [], group: '基础命令', description: '账号列表与切换', pattern: /^\/accounts$/, handler: 'showAccounts', registerMenu: true, requireAccount: false }),
    Object.freeze({ name: 'tasks', aliases: [], group: '基础命令', description: '显示下载任务列表', pattern: /^\/tasks$/, handler: 'showTasks', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'fl', aliases: [], group: '基础命令', description: '常用目录列表', pattern: /^\/fl$/, handler: 'showCommonFolders', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'fs', aliases: [], group: '基础命令', description: '添加常用目录', pattern: /^\/fs$/, handler: 'showFolderTree', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'cancel', aliases: [], group: '基础命令', description: '取消当前操作', pattern: /^\/cancel$/, handler: 'cancelOperation', registerMenu: true, requireAccount: false }),
    Object.freeze({ name: 'execute', aliases: [], group: '任务操作', description: '执行指定任务', pattern: /^\/execute_(\d+)$/, paramHint: '[ID]', handler: 'executeTask', registerMenu: false, requireAccount: false }),
    Object.freeze({ name: 'execute_all', aliases: [], group: '任务操作', description: '执行所有任务', pattern: /^\/execute_all$/, handler: 'executeAllTasks', registerMenu: true, requireAccount: false }),
    Object.freeze({ name: 'dt', aliases: [], group: '任务操作', description: '删除指定任务', pattern: /^\/dt_(\d+)$/, paramHint: '[ID]', handler: 'deleteTaskPrompt', registerMenu: false, requireAccount: false }),
    Object.freeze({ name: 'scan_banned', aliases: [], group: '云盘运维', description: '违规死链全盘巡检', pattern: /^\/scan_banned$/, handler: 'handleScanBanned', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'clean_banned', aliases: [], group: '云盘运维', description: '一键清理违规死链', pattern: /^\/clean_banned$/, handler: 'handleCleanBanned', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'clean_empty', aliases: ['sweep_empty'], group: '云盘运维', description: '修剪空文件夹', pattern: /^\/(?:clean_empty|sweep_empty)$/, handler: 'handleSweepEmpty', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'dedup', aliases: ['dedup_scan'], group: '云盘运维', description: '多版本资产去重巡检', pattern: /^\/(?:dedup|dedup_scan)$/, handler: 'handleScanDedup', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'dedup_clean', aliases: [], group: '云盘运维', description: '一键清理冗余多版本', pattern: /^\/dedup_clean$/, handler: 'handleCleanDedup', registerMenu: true, requireAccount: true }),
    Object.freeze({ name: 'tmdb', aliases: [], group: '媒体查询', description: 'TMDB 影视信息查询', pattern: /^\/tmdb(?:\s+(.+))?$/, paramHint: '[片名] [年份]', handler: 'handleTmdb', registerMenu: true, requireAccount: false }),
]);

const COMMAND_GROUP_ORDER = ['基础命令', '任务操作', '云盘运维', '媒体查询'];
const COMMAND_GROUP_ICONS = { '基础命令': '📋', '任务操作': '📝', '云盘运维': '🛠', '媒体查询': '🎬' };

// 指令挂载时仅需要 chatId 的 handler（其第二参数为按钮回调场景专用，指令场景不传）
const CHAT_ONLY_HANDLERS = new Set(['showAccounts', 'showTasks', 'showCommonFolders', 'showFolderTree']);

/**
 * 由 COMMANDS 注册表按分组模板化生成帮助文本：条目全局连续编号，
 * 含参数格式说明，末尾保留"发送 139 分享链接创建任务"引导段
 * @returns {string}
 */
function buildHelpText() {
    let index = 0;
    const sections = COMMAND_GROUP_ORDER.map((group) => {
        const items = COMMANDS.filter(cmd => cmd.group === group).map((cmd) => {
            index += 1;
            const paramHint = cmd.paramHint ? ` ${cmd.paramHint}` : '';
            return `${index}. /${cmd.name}${paramHint} - ${cmd.description}`;
        });
        return `${COMMAND_GROUP_ICONS[group]} ${group}：\n${items.join('\n')}`;
    });
    return '🤖 云盘机器人使用指南\n\n' + sections.join('\n\n') +
        '\n\n📥 创建任务：\n直接发送移动云盘(139)分享链接即可创建任务\n格式：链接（支持访问码的链接）';
}

class TelegramBotService {
    constructor(token, chatId) {
        this.token = token;
        this.chatId = chatId
        this.bot = null;
        this.accountRepo = AppDataSource.getRepository(Account);
        this.commonFolderRepo = AppDataSource.getRepository(CommonFolder);
        this.taskRepo = AppDataSource.getRepository(Task);
        this.transferredFileRepo = AppDataSource.getRepository(TransferredFile);
        this.taskService = new TaskService(this.taskRepo, this.accountRepo, this.transferredFileRepo);
        this.currentAccountId = null;
        this.currentAccount = null;
        this.currentShareLink = null;
        this.currentAccessCode = null;
        this.lastButtonMessageId = null;  // 上次按钮消息
        this.currentFolderPath = '';  // 当前路径
        this.currentFolderId = '/';  // 当前文件夹ID
        this.folders = new Map();
        this.parentFolderIds = new Set();

        // 全局任务列表消息id
        this.globalTaskListMessageId = null;
        // 全局常用目录列表消息id
        this.globalCommonFolderListMessageId = null;
        // 巡检结果缓存（供对应清理指令复用，stop() 时清理）
        this._lastBannedFiles = null;
        this._lastDedupPlan = null;
        // 下线/未知指令引导的会话内节流时间戳（60 秒窗口）
        this._lastPlainGuideAt = 0;
        this.tmdbService = new TMDBService();
    }

    async start() {
        if (this.bot) {
            return;
        }
        // 从配置文件获取代理
        const proxy = ProxyUtil.getProxy('telegram');
        this.bot = new TelegramBot(this.token, { 
            polling: true, 
            request: {
                proxy: proxy,
                agentOptions: {
                    keepAlive: true,
                    family: 4,
                    timeout:  30000 // 10秒超时
                },
                timeout: 30000, // 请求超时时间
                forever: true, // 保持连接
                retries: 3 // 添加重试次数
            } 
        });

        // 添加错误处理
        this.bot.on('polling_error', (error) => {
            logger.error('Telegram Bot polling error', { error: error.message, stack: error.stack });
        });

        this.bot.on('error', (error) => {
            logger.error('Telegram Bot error', { error: error.message, stack: error.stack });
        });
        
        // 设置命令菜单：由 COMMANDS 注册表派生（registerMenu=true 的主指令子集）
        await this.bot.setMyCommands(
            COMMANDS.filter(cmd => cmd.registerMenu).map(cmd => ({
                command: cmd.name,
                description: cmd.description,
            }))
        );
        // 从数据库中加载默认的账号
        const account = await this.accountRepo.findOne({
            where: { tgBotActive: true }
        });
        this.currentAccount = account;
        this.currentAccountId = account?.id;
        this.initCommands();
        return true;
    }

    async stop() {
        if (!this.bot) {
            return;
        }
        try {
            // 发送机器人停止消息
            await this.bot.stopPolling();
            this.bot = null;
            // 清理状态（全量：含巡检缓存、引导节流与目录导航缓存，保证无感重建后全新状态）
            this.currentAccountId = null;
            this.currentAccount = null;
            this.currentShareLink = null;
            this.currentAccessCode = null;
            this.lastButtonMessageId = null;
            this.currentFolderPath = '';
            this.currentFolderId = '/';
            this.folders.clear();
            this.parentFolderIds.clear();
            this.globalTaskListMessageId = null;
            this.globalCommonFolderListMessageId = null;
            this._lastBannedFiles = null;
            this._lastDedupPlan = null;
            this._lastPlainGuideAt = 0;
            return true;
        } catch (error) {
            logger.error('停止机器人失败', { error: error.message, stack: error.stack });
            return false;
        }
    }

    initCommands() {
        // 指令注册表驱动挂载：主指令与别名经同一 pattern 命中同一 handler，行为完全等价
        for (const cmd of COMMANDS) {
            this.bot.onText(cmd.pattern, async (msg, match) => {
                const chatId = msg.chat.id;
                if (!this._checkChatId(chatId)) return;
                if (cmd.requireAccount && !this._checkUserId(chatId)) return;
                try {
                    if (CHAT_ONLY_HANDLERS.has(cmd.handler)) {
                        await this[cmd.handler](chatId);
                    } else {
                        await this[cmd.handler](chatId, match, msg);
                    }
                } catch (error) {
                    logger.error(`指令 /${cmd.name} 处理异常`, { error: error.message, stack: error.stack });
                    await this._safeSendMessage(chatId, `处理失败: ${error.message}`).catch(() => {});
                }
            });
        }

        // 139 移动云盘分享链接直接识别（消息任意位置含链接即触发）
        this.bot.onText(/(?:yun|caiyun)\.139\.com/i, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return;
            try {
                if (!this._checkUserId(chatId)) return;
                if (!await this._ensureAccountType(chatId, 'cloud139')) return;
                const extracted = Cloud139Utils.extractFromShareText(msg.text);
                const shareLink = extracted ? extracted.url : msg.text.trim();
                const accessCode = extracted?.passwd || '';
                await this.handleFolderSelection(chatId, shareLink, null, accessCode);
            } catch (error) {
                logger.error('处理139分享链接失败', { error: error.message, stack: error.stack });
                await this._safeSendMessage(chatId, `处理失败: ${error.message}`).catch(() => {});
            }
        });

        // 普通消息：旧"资源搜索"模式已下线，给出引导提示（60 秒节流防轰炸）；未知指令引导
        this.bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return;
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (!text) return;
            // 指令消息由注册表 onText 分发处理
            if (text.startsWith('/')) {
                if (this._isUnknownCommand(text)) {
                    this._throttledGuide(chatId, '未知指令，发送 /help 查看可用指令');
                }
                return;
            }
            // 含 139 分享链接的混合消息由链接识别分支处理，避免双重响应
            if (/(?:yun|caiyun)\.139\.com/i.test(text)) return;
            this._throttledGuide(chatId, '🔍 资源搜索功能已下线。\n发送 /help 查看可用指令，或直接发送 139 分享链接创建任务');
        });

        // 修改回调处理
        this.bot.on('callback_query', async (callbackQuery) => {
            const data = JSON.parse(callbackQuery.data);
            const chatId = callbackQuery.message.chat.id;
            const messageId = callbackQuery.message.message_id;

            try {
                switch (data.t) {
                    case 'f': // 文件夹选择
                        await this.createTask(chatId, data, messageId);
                        break;
                    case 'of': // 覆盖文件夹
                        if (!data.o) {
                            await this._safeEditMessageText(chatId, messageId, '已取消任务创建');
                            return;
                        }
                        await this.createTask(chatId, data, messageId);
                        break;
                    case 'sa': // 设置当前账号
                        await this.setCurrentAccount(chatId, data, messageId);
                        break;
                    case 'tp': // 任务分页
                        await this.showTasks(chatId, data.p, messageId);
                        break;
                    case 'dt': // 删除任务
                        if (!data.c) {
                            await this._safeEditMessageText(chatId, messageId, '已取消删除');
                            return;
                        }
                        await this.deleteTask(chatId, data, messageId);
                        break;
                    case 'fd': // 进入下一级目录
                        await this.showFolderTree(chatId, data, messageId);
                        break;
                    case 'fc': // 取消操作
                        await this.bot.deleteMessage(chatId, messageId).catch(() => {});
                        break;
                    case 'fs': // 保存当前目录
                        await this.saveFolderAsFavorite(chatId, data, messageId);
                        break;
                    case 'delf': // 删除常用目录
                        await this.commonFolderRepo.delete({
                            id: data.id,
                            accountId: this.currentAccountId
                        });
                        await this.showCommonFolders(chatId, messageId);
                        break;
                    case 'm_cb': // 一键清理违规文件
                        await this.handleCleanBanned(chatId);
                        break;
                    case 'm_dc': // 一键清理冗余多版本
                        await this.handleCleanDedup(chatId);
                        break;
                }
            } catch (error) {
                logger.error('回调处理异常', { error: error.message, stack: error.stack });
                await this._safeSendMessage(chatId, `处理失败: ${error.message}`).catch(() => {});
            }
        });
    }

    async showHelp(chatId) {
        await this._safeSendMessage(chatId, buildHelpText());
    }

    async cancelOperation(chatId) {
        // 清除缓存
        this.currentShareLink = null;
        this.currentAccessCode = null;
        try {
            if (this.lastButtonMessageId) {
                await this.bot.deleteMessage(chatId, this.lastButtonMessageId);
                this.lastButtonMessageId = null;
            }
        } catch (error) {
            logger.warn('删除消息失败', { error: error.message, stack: error.stack });
        }
        await this._safeSendMessage(chatId, '已取消当前操作');
    }

    async executeTask(chatId, match) {
        const taskId = match[1];
        const message = await this._safeSendMessage(chatId, '任务开始执行');
        if (!message) return;
        try {
            await this.taskService.processAllTasks(true, [taskId]);
            await this.bot.deleteMessage(chatId, message.message_id).catch(() => {});
            await this._safeSendMessage(chatId, '任务执行完成');
        } catch (e) {
            await this._safeEditMessageText(chatId, message.message_id, `任务执行失败: ${e.message}`);
        }
    }

    async executeAllTasks(chatId) {
        const message = await this._safeSendMessage(chatId, '开始执行所有任务...');
        if (!message) return;
        try {
            await this.taskService.processAllTasks(true);
            await this._safeEditMessageText(chatId, message.message_id, '所有任务执行完成');
        } catch (e) {
            await this._safeEditMessageText(chatId, message.message_id, `任务执行失败: ${e.message}`);
        }
    }

    async deleteTaskPrompt(chatId, match) {
        const taskId = match[1];
        const keyboard = [
            [
                { text: '是', callback_data: JSON.stringify({ t: 'dt', i: taskId, c: true, df: true }) },
                { text: '否', callback_data: JSON.stringify({ t: 'dt', i: taskId, c: true, df: false }) }
            ],
            [{ text: '取消', callback_data: JSON.stringify({ t: 'dt', c: false }) }]
        ];
        await this._safeSendMessage(chatId, '是否同步删除网盘文件？', {
            replyMarkup: { inline_keyboard: keyboard }
        });
    }

    // TMDB 影视信息查询：/tmdb [片名] [年份]
    async handleTmdb(chatId, match) {
        const input = match && match[1] ? String(match[1]).trim() : '';
        if (!input) {
            await this._safeSendMessage(chatId, '用法：/tmdb [片名] [年份]\n示例：/tmdb 星际穿越 2014');
            return;
        }
        let title, year;

        // 解析输入的标题和年份
        const yearMatch = input.match(/^(.+?)(?:\s+(\d{4}))?$/);
        if (yearMatch) {
            title = yearMatch[1].trim();
            year = yearMatch[2];
        }

        const placeholder = await this._safeSendMessage(chatId, '正在搜索...');
        try {
            const results = await this.tmdbService.search(title, year);
            let responseText = '';
            logger.info('搜索结束')
            // 先发送海报图片
            const firstPoster = results.movies[0]?.posterPath || results.tvShows[0]?.posterPath;

            if (results.movies.length > 0) {
                responseText += '📽 电影：\n\n';
                results.movies.forEach(movie => {
                    const shortOverview = movie.overview ? 
                        (movie.overview.length > 20 ? movie.overview.substring(0, 20) + '...' : movie.overview) : 
                        '暂无';
                    
                    responseText += `标题：${movie.title}\n` +
                        `原标题：${movie.originalTitle}\n` +
                        `上映日期：${movie.releaseDate}\n` +
                        `评分：${movie.voteAverage}\n` +
                        `简介：${shortOverview}\n\n`;
                });
            }

            if (results.tvShows.length > 0) {
                responseText += '📺 剧集：\n\n';
                results.tvShows.forEach(show => {
                    const shortOverview = show.overview ? 
                        (show.overview.length > 20 ? show.overview.substring(0, 20) + '...' : show.overview) : 
                        '暂无';

                    responseText += `标题：${show.title}\n` +
                        `原标题：${show.originalTitle}\n` +
                        `首播日期：${show.releaseDate}\n` +
                        `评分：${show.voteAverage}\n` +
                        `简介：${shortOverview}\n\n`;
                });
            }

            if (!results.movies.length && !results.tvShows.length) {
                responseText = '未找到相关影视信息';
            }
            logger.info('获取到的海报', { firstPoster })
            if (firstPoster) {
                // caption 独立上限 1024：转义 + 截断后以 HTML 模式发送图片卡片
                const caption = MessageService.truncateForTelegram(
                    MessageService.escapeHtmlEntities(responseText), 1024);
                try {
                    await this.bot.sendPhoto(chatId, firstPoster, {
                        caption: caption,
                        parse_mode: 'HTML'
                    });
                    await this.bot.deleteMessage(chatId, placeholder?.message_id).catch(() => {});
                } catch (photoError) {
                    // 海报发送失败（含格式被拒）：降级编辑占位消息为纯文本卡片，禁止整体失败
                    logger.warn('TMDB 海报发送失败，降级为文本卡片', { error: photoError.message });
                    await this._safeEditMessageText(chatId, placeholder?.message_id, responseText);
                }
            } else {
                // 无海报结果：编辑占位消息为纯文本卡片（禁止 sendPhoto(chatId, undefined)）
                await this._safeEditMessageText(chatId, placeholder?.message_id, responseText);
            }
        } catch (error) {
            // 异常分支：编辑未删除的占位消息为失败原因（而非先删后编导致二次失败）
            await this._safeEditMessageText(chatId, placeholder?.message_id, `搜索失败: ${error.message}`);
        }
    }

    async showAccounts(chatId, messageId = null) {
        if (!this._checkChatId(chatId)){
            return;
        }
        const accounts = await this.accountRepo.find();
        const keyboard = accounts.map(account => [{
            text: `${this._desensitizeUsername(account.username)} ${account.id === this.currentAccountId ? '✅' : ''}`.trim(),
            callback_data: JSON.stringify({ t: 'sa', i: account.id, a: this._desensitizeUsername(account.username) })
        }]);

        const message = '账号列表 (✅表示当前选中账号):';
        if (messageId) {
            await this._safeEditMessageText(chatId, messageId, message, {
                replyMarkup: { inline_keyboard: keyboard }
            });
        } else {
            await this._safeSendMessage(chatId, message, {
                replyMarkup: { inline_keyboard: keyboard }
            });
        }
    }

    async showTasks(chatId, page = 1, messageId = null) {
        const pageSize = 5;
        const skip = (page - 1) * pageSize;
        
        const [tasks, total] = await this.taskRepo.findAndCount({
            order: { updatedAt: 'DESC' },
            take: pageSize,
            skip: skip
        });

        const totalPages = Math.ceil(total / pageSize);
        
        const taskList = tasks.map(task => 
            `📺 ${task.resourceName}\n` +
            `⏱ 进度：${task.currentEpisodes}${task.totalEpisodes ? '/' + task.totalEpisodes : ''} 集\n` +
            `🔄 状态：${this.formatStatus(task.status)}\n` +
            `⌚️ 更新：${new Date(task.lastFileUpdateTime).toLocaleString('zh-CN')}\n` +
            `📁 执行: /execute_${task.id}\n` +
            `❌ 删除: /dt_${task.id}`
        ).join('\n\n');

        const keyboard = [];

        // 添加分页按钮
        if (totalPages > 1) {
            const pageButtons = [];
            if (page > 1) {
                pageButtons.push({
                    text: '⬅️',
                    callback_data: JSON.stringify({ t: 'tp', p: page - 1 })
                });
            }
            pageButtons.push({
                text: `${page}/${totalPages}`,
                callback_data: JSON.stringify({ t: 'tp', p: page })
            });
            if (page < totalPages) {
                pageButtons.push({
                    text: '➡️',
                    callback_data: JSON.stringify({ t: 'tp', p: page + 1 })
                });
            }
            keyboard.push(pageButtons);
        }

        const message = tasks.length > 0 ? 
            `📋 任务列表 (第${page}页):\n\n${taskList}` : 
            '📭 暂无任务';

        if (messageId) {
            await this._safeEditMessageText(chatId, messageId, message, {
                replyMarkup: { inline_keyboard: keyboard }
            });
        } else {
            // 先删除之前的消息
            if (this.globalTaskListMessageId) {
                await this.bot.deleteMessage(chatId, this.globalTaskListMessageId).catch(() => {});
            }
            const newMessage = await this._safeSendMessage(chatId, message, {
                replyMarkup: { inline_keyboard: keyboard }
            });
            this.globalTaskListMessageId = newMessage ? newMessage.message_id : null;
        }
    }

    formatStatus(status) {
        const statusMap = {
            'pending': '⏳ 等待执行',
            'processing': '🔄 追剧中',
            'completed': '✅ 已完结',
            'failed': '❌ 失败'
        };
        return statusMap[status] || status;
    }

    /**
     * 确保当前账号类型与链接类型匹配，否则自动切换到第一个匹配账号。
     * @returns {boolean} true=账号就绪，false=无可用账号（已发送错误提示）
     */
    async _ensureAccountType(chatId, requiredType) {
        if (this.currentAccount?.accountType === requiredType) return true;
        const accounts = await this.accountRepo.find({ where: { accountType: requiredType } });
        if (accounts.length === 0) {
            const label = '移动云盘(139)';
            await this._safeSendMessage(chatId, `当前没有可用的 ${label} 账号，请先在账号页面添加对应账号`);
            return false;
        }
        const account = accounts[0];
        this.currentAccountId = account.id;
        this.currentAccount = account;
        return true;
    }

    async setCurrentAccount(chatId, data, messageId) {
        try {
            const accountId = data.i;
            if (this.currentAccountId == accountId) {
                await this._safeSendMessage(chatId, `账号[${data.a}]已被选中`);
                await this.bot.deleteMessage(chatId, messageId).catch(() => {});
                return;
            } 
            this.currentAccountId = accountId;
            // 获取账号信息
            const account = await this.accountRepo.findOneBy({ id: accountId });
            if (!account) {
                await this._safeSendMessage(chatId, '未找到该账号');
            }
            this.currentAccount = account;
            account.tgBotActive = true;
            this.accountRepo.save(account);
            // 删除原消息
            await this.bot.deleteMessage(chatId, messageId).catch(() => {});
            await this._safeSendMessage(chatId, `已选择账号: ${this._getDesensitizedUserName()}`);

        } catch (error) {
            logger.error('设置当前账号失败', { error: error.message, stack: error.stack });
            await this._safeSendMessage(chatId, `设置当前账号失败: ${error.message}`).catch(() => {});
        }
    }

    async handleFolderSelection(chatId, shareLink, messageId = null,accessCode) {
        const folders = await this.commonFolderRepo.find({ where: { accountId: this.currentAccountId } });
        
        if (folders.length === 0) {
            const rootFolderId = this.currentAccount?.accountType === 'cloud139' ? '/' : '-11';
            const keyboard = [[{ 
                text: '📁 添加常用目录',
                callback_data: JSON.stringify({ t: 'fd', f: rootFolderId })
            }]];
            const message = `当前账号: ${this._getDesensitizedUserName()} \n 未找到常用目录，请添加常用目录`;
            if (messageId) {
                await this._safeEditMessageText(chatId, messageId, message, {
                    replyMarkup: { inline_keyboard: keyboard }
                });
                this.globalCommonFolderListMessageId = null
            } else {
                await this._safeSendMessage(chatId, message, {replyMarkup: { inline_keyboard: keyboard }});
            }
            return;
        }
        // 缓存当前分享信息
        this.currentShareLink = shareLink;
        this.currentAccessCode = accessCode;
        let taskName = ""
        // 解析链接
        try{
            const shareFolders = await this.taskService.parseShareFolderByShareLink(shareLink, this.currentAccountId, accessCode);
            taskName = shareFolders[0].name;
        }catch(e){
            await this._safeSendMessage(chatId, `解析分享链接失败: ${e.message}`);
            return;
        }
    
        const keyboard = folders.map(folder => [{
            text: folder.path.length > 30 ? 
                  '.../' + folder.path.split('/').slice(-2).join('/') : 
                  folder.path,
            callback_data: JSON.stringify({
                t: 'f',               // type
                f: folder.id,   // folderId
            })
        }]);

        const message = `当前账号: ${this._getDesensitizedUserName()} \n资源名称: ${taskName}\n请选择保存目录:`;
        if (messageId) {
            await this._safeEditMessageText(chatId, messageId, message, {
                replyMarkup: {
                    inline_keyboard: keyboard
                }
            });
            this.lastButtonMessageId = messageId;
        } else {
            const msg = await this._safeSendMessage(chatId, message, {
                replyMarkup: {
                    inline_keyboard: keyboard
                }
            });
            this.lastButtonMessageId = msg ? msg.message_id : null;
        }
    }

    async createTask(chatId, data, messageId) {
        try {
            const targetFolderId = data.f;
            // 根据targetFolderId查询出folderName
            const targetFolder = await this.commonFolderRepo.findOne({ where: { id: targetFolderId } });
            if (!targetFolder) {
                await this._safeSendMessage(chatId, '未找到该目录');
                return
            }
            // 发送任务创建中消息
            await this._safeEditMessageText(chatId, messageId, '任务创建中...');
            const taskDto = {
                accountId: this.currentAccountId,
                shareLink: this.currentShareLink,
                targetFolderId: targetFolderId,
                targetFolder: targetFolder.path,
                tgbot: true,
                overwriteFolder: data?.o,
                accessCode: this.currentAccessCode
            };
            const tasks = await this.taskService.createTask(taskDto);
            // 遍历获取task.id
            const taskIds = tasks.map(task => task.id);
            await this._safeEditMessageText(chatId, messageId, '任务创建成功, 执行中...');
            if(taskIds.length > 0) {
                await this.taskService.processAllTasks(true, taskIds)   
            }
            await this.bot.deleteMessage(chatId, messageId).catch(() => {});
            // 发送任务执行完成消息
            await this._safeSendMessage(chatId, '任务执行完成');
            // 清空缓存
            this.currentShareLink = null;
            this.currentAccessCode = null;
        } catch (error) {
            // 如果报错是 folder already exists 则提示用户是否需要覆盖
            if (error.message.includes('folder already exists')) {
                const keyboard = [
                    [{ text: '是', callback_data: JSON.stringify({ t: 'of', f: data.f, o: true }) }],
                    [{ text: '否', callback_data: JSON.stringify({ t: 'of', f: data.f, o: false }) }]
                ];
                await this._safeEditMessageText(chatId, messageId, '该目录下已有同名文件夹，是否覆盖？', {
                    replyMarkup: {
                        inline_keyboard: keyboard
                    }
                });
                return;
            }else{
                await this._safeEditMessageText(chatId, messageId, `任务创建失败: ${error.message}`);
                // 清空缓存
                this.currentShareLink = null;
                this.currentAccessCode = null;
                return;
            }
        }
    }

    async deleteTask(chatId,data,messageId) {
        try{
            // 判断data.i是否为数字
            if(isNaN(data.i)) {
                await this._safeEditMessageText(chatId, messageId, '任务ID无效');
                return;
            }
            // 发送任务删除中消息
            await this._safeEditMessageText(chatId, messageId, '任务删除中...');

            await this.taskService.deleteTask(parseInt(data.i), data.df);
            await this._safeEditMessageText(chatId, messageId, '任务删除成功');
            // 刷新任务列表
            setTimeout(() => this.showTasks(chatId, 1), 800);
        }catch(e) {
            await this._safeEditMessageText(chatId, messageId, `任务删除失败: ${e.message}`);
        }
    }

    async showCommonFolders(chatId, messageId = null) {
        const folders = await this.commonFolderRepo.find({ 
            where: { 
                accountId: this.currentAccountId 
            },
            order: {
                path: 'ASC'
            }
        });
        const rootFolderId = this.currentAccount?.accountType === 'cloud139' ? '/' : '-11';
        const keyboard = [[{ 
            text: '📁 添加常用目录',
            callback_data: JSON.stringify({ t: 'fd', f: rootFolderId })
        }]];
        if (folders.length === 0) {
            const message = `当前账号: ${this._getDesensitizedUserName()} \n 未找到常用目录，请先添加常用目录`;
            if (messageId) {
                await this._safeEditMessageText(chatId, messageId, message, {
                    replyMarkup: { inline_keyboard: keyboard }
                });
                this.globalCommonFolderListMessageId = null
            } else { 
                if (this.globalCommonFolderListMessageId) {
                    await this.bot.deleteMessage(chatId, this.globalCommonFolderListMessageId).catch(() => {});
                    this.globalCommonFolderListMessageId = null;
                }
                await this._safeSendMessage(chatId, message,{replyMarkup: { inline_keyboard: keyboard }});
            }
            return;
        }

        const folderList = folders.map(folder => `📁 ${folder.path}`).join('\n');

        // 每个常用目录添加一个删除按钮行
        folders.forEach(folder => {
            keyboard.push([{
                text: `❌ 删除 ${folder.path}`,
                callback_data: JSON.stringify({ t: 'delf', id: folder.id })
            }]);
        });

        const message = `当前账号: ${this._getDesensitizedUserName()} \n 常用目录列表:\n\n${folderList}`;
        if (messageId) {
            await this._safeEditMessageText(chatId, messageId, message, {
                replyMarkup: { inline_keyboard: keyboard }
            });
            this.globalCommonFolderListMessageId = null
        } else {
            if (this.globalCommonFolderListMessageId) {
                await this.bot.deleteMessage(chatId, this.globalCommonFolderListMessageId).catch(() => {});
            }
            const newMessage = await this._safeSendMessage(chatId, message, { replyMarkup: { inline_keyboard: keyboard } });
            this.globalCommonFolderListMessageId = newMessage ? newMessage.message_id : null;
        }
    }

    async showFolderTree(chatId, data, messageId = null) {
        try {
            if (!this.currentAccount) {
                await this._safeSendMessage(chatId, '未选择账号，请先使用 /accounts 选择账号');
                return;
            }
            const isCloud139 = this.currentAccount.accountType === 'cloud139';
            const ROOT_ID = isCloud139 ? '/' : '-11';
            let folderId = data?.f || ROOT_ID;
            if (!this._checkUserId(chatId)) return;
            if (data?.r) {
               // 返回上一级目录，从记录的父级ID中获取
               const parentId = Array.from(this.parentFolderIds).pop() || ROOT_ID;
                this.parentFolderIds.delete(parentId);
                const path = this.currentFolderPath.split('/').filter(Boolean);
                path.pop();
                path.pop();
                this.currentFolderPath = path.join('/');
                folderId = parentId;
            } else if (folderId !== ROOT_ID) {
                // 非根目录时记录父级ID
                const folder = this.folders.get(folderId);
                if (folder?.pId) {
                    this.parentFolderIds.add(folder.pId);
                }
            }

            let folders;
            if (isCloud139) {
                const cloud139 = Cloud139Service.getInstance(this.currentAccount);
                const result = await cloud139.listDiskDir(folderId === ROOT_ID ? '/' : folderId);
                folders = result.items
                    .filter(f => f.type === 'folder')
                    .map(f => ({ id: f.fileId, name: f.name, pId: folderId }));
            } else {
                throw new Error('仅支持移动云盘(139)目录浏览');
            }

            // 获取当前账号的所有常用目录
            const commonFolders = await this.commonFolderRepo.find({
                where: { accountId: this.currentAccountId }
            });
            const commonFolderIds = new Set(commonFolders.map(f => f.id));

            // 更新当前ID
            this.currentFolderId = folderId;

            // 处理路径更新
            if (folderId === ROOT_ID) {
                // 根目录
                this.currentFolderPath = '/';
            } else {
                this.currentFolderPath = path.join(this.currentFolderPath, this.folders.get(folderId)?.name || folderId);
            }

            const keyboard = [];
            
            // 添加文件夹按钮
            for (const folder of folders) {
                keyboard.push([{
                    text: `📁 ${folder.name}${commonFolderIds.has(folder.id) ? ' ✅' : ''}`,
                    callback_data: JSON.stringify({
                        t: 'fd',
                        f: folder.id
                    })
                }]);
                this.folders.set(folder.id, folder);
            }
            
            // 添加操作按钮
            keyboard.push([
                {
                    text: '❌ 关闭',
                    callback_data: JSON.stringify({ t: 'fc' })
                },
                ...(folderId !== ROOT_ID ? [{
                    text: '🔄 返回',
                    callback_data: JSON.stringify({
                        t: 'fd',
                        f: folders[0]?.pId || ROOT_ID,
                        r: true
                    })
                }] : []),
                {
                    text: '✅ 确认',
                    callback_data: JSON.stringify({ 
                        t: 'fs',
                        f: folderId
                    })
                },
            ]);

            const message = `当前账号: ${this._getDesensitizedUserName()} \n 当前路径: ${this.currentFolderPath}\n请选择要添加的目录:`;

            if (messageId) {
                await this._safeEditMessageText(chatId, messageId, message, {
                    replyMarkup: { inline_keyboard: keyboard }
                });
            } else {
                await this._safeSendMessage(chatId, message, {
                    replyMarkup: { inline_keyboard: keyboard }
                });
            }

        } catch (error) {
            logger.error('获取目录失败', { error: error.message, stack: error.stack });
            await this._safeSendMessage(chatId, `获取目录失败: ${error.message}`).catch(() => {});
        }
    }

    async saveFolderAsFavorite(chatId, data, messageId) {
        try {
            let currentPath = this.currentFolderPath|| '';

            // 校验目录是否已经是常用目录
            const existingFavorite = await this.commonFolderRepo.findOne({
                where: {
                    accountId: this.currentAccountId,
                    id: data.f
                }
            });
            if (existingFavorite) {
                await this._safeEditMessageText(chatId, messageId, `${data.p || '根目录'} 已经是常用目录`);
                this.globalCommonFolderListMessageId = null;
                return;
            }
            if (currentPath === '' || currentPath === '/') {
                currentPath = '/';
            }else{
                currentPath = currentPath.replace(/^\/|\/$/g, '');
            }
            const favorite = {
                accountId: this.currentAccountId,
                id: data.f,
                path: currentPath,
                name: currentPath.split('/').pop() || '根目录'
            };
            
            await this.commonFolderRepo.save(favorite);
            await this._safeEditMessageText(chatId, messageId, `已将 ${currentPath || '根目录'} 添加到常用目录`);
            
        } catch (error) {
            throw new Error(`保存常用目录失败: ${error.message}`);
        }
    }

    // 校验当前是否有用户id
    _checkUserId(chatId) {
        if(!this.currentAccountId) {
            Promise.resolve(this._safeSendMessage(chatId, '请先使用 /accounts 选择账号')).catch(() => {});
            return false;
        }
        return true;
    }
    // 校验是否是当前chatId
    _checkChatId(chatId) {
        if (chatId != this.chatId) return false;
        return true;
    }
    // 账号名脱敏：前 3 后 4 特征保留、中间掩码（短名仅保留首字符）
    _desensitizeUsername(username) {
        const name = String(username || '');
        if (!name) return name;
        if (name.length <= 7) {
            return name.slice(0, 1) + '****';
        }
        return name.replace(/(.{3}).*(.{4})/, '$1****$2');
    }
    // 获取当前已脱敏的用户名
    _getDesensitizedUserName() {
        return this._desensitizeUsername(this.currentAccount.username);
    }

    // 未命中任何在役指令注册表 pattern 的指令文本
    _isUnknownCommand(text) {
        return !COMMANDS.some((cmd) => cmd.pattern.test(text));
    }

    // 会话内 60 秒节流的引导回复（下线引导与未知指令引导共用）
    _throttledGuide(chatId, text) {
        const now = Date.now();
        if (now - (this._lastPlainGuideAt || 0) < 60 * 1000) {
            return;
        }
        this._lastPlainGuideAt = now;
        Promise.resolve(this._safeSendMessage(chatId, text)).catch(() => {});
    }

    // 判定是否为 Telegram 4xx"无法解析"类格式错误（触发纯文本降级重发）；
    // 网络超时/5xx/429 限流不属格式问题，不触发降级，避免重试风暴
    _isTelegramParseError(error) {
        const statusCode = error && typeof error.code === 'number'
            ? error.code
            : error && error.response && error.response.statusCode;
        if (typeof statusCode !== 'number') {
            return false;
        }
        if (statusCode === 429) {
            return false;
        }
        return statusCode >= 400 && statusCode < 500;
    }

    /**
     * 安全发送：渲染（卡片识别/徽章/标题强化，prebuilt 文本跳过）→ HTML 实体转义 →
     * 4096 截断 → sendMessage(parse_mode: 'HTML')；
     * 400 类格式错误 → 剥离标签纯文本重发一次 → 仍失败仅记日志返回 null
     * @param {number} chatId
     * @param {string} text
     * @param {object} [options] { replyMarkup?, cardMeta?, prebuilt? }
     */
    async _safeSendMessage(chatId, text, options = {}) {
        const rendered = options.prebuilt
            ? MessageService.truncateForTelegram(text)
            : MessageService.renderCardHtml(text, options.cardMeta || {});
        const sendOpts = { parse_mode: 'HTML' };
        if (options.replyMarkup) {
            sendOpts.reply_markup = options.replyMarkup;
        }
        try {
            return await this.bot.sendMessage(chatId, rendered, sendOpts);
        } catch (error) {
            if (!this._isTelegramParseError(error)) {
                logger.error('Telegram 消息发送失败', { error: error.message, stack: error.stack });
                return null;
            }
            try {
                const plainOpts = {};
                if (options.replyMarkup) {
                    plainOpts.reply_markup = options.replyMarkup;
                }
                return await this.bot.sendMessage(chatId, MessageService.stripHtmlTags(rendered), plainOpts);
            } catch (fallbackError) {
                logger.error('Telegram 消息降级发送失败', { error: fallbackError.message, stack: fallbackError.stack });
                return null;
            }
        }
    }

    /**
     * 安全编辑：与 _safeSendMessage 同策略应用于 editMessageText，
     * 作为巡检占位消息编辑为结果卡片的统一入口
     * @param {number} chatId
     * @param {number} messageId
     * @param {string} text
     * @param {object} [options] { replyMarkup?, cardMeta?, prebuilt? }
     */
    async _safeEditMessageText(chatId, messageId, text, options = {}) {
        if (!chatId || !messageId) {
            return false;
        }
        const rendered = options.prebuilt
            ? MessageService.truncateForTelegram(text)
            : MessageService.renderCardHtml(text, options.cardMeta || {});
        const editOpts = { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' };
        if (options.replyMarkup) {
            editOpts.reply_markup = options.replyMarkup;
        }
        try {
            return await this.bot.editMessageText(rendered, editOpts);
        } catch (error) {
            if (!this._isTelegramParseError(error)) {
                logger.error('Telegram 消息编辑失败', { error: error.message, stack: error.stack });
                return false;
            }
            try {
                const plainOpts = { chat_id: chatId, message_id: messageId };
                if (options.replyMarkup) {
                    plainOpts.reply_markup = options.replyMarkup;
                }
                return await this.bot.editMessageText(MessageService.stripHtmlTags(rendered), plainOpts);
            } catch (fallbackError) {
                logger.error('Telegram 消息降级编辑失败', { error: fallbackError.message, stack: fallbackError.stack });
                return false;
            }
        }
    }

    /**
     * 巡检/清理卡片渲染辅助（五区结构）：
     * 标题区（级别徽章+类型图标+类型名+系统名）→ 统计摘要区（固定有序字段）→
     * 抽样明细区（路径 <code> 化，超出以"等共 N 项"收尾）→ 行动引导区 → 按钮区（调用方 replyMarkup）
     * @param {object} spec { level, icon, cardName, stats, sampleLabel, samples, samplesTail, footer }
     * @returns {string} 预构建 HTML 文本（调用方以 prebuilt 方式发送）
     */
    _renderMaintenanceCard({ level, icon, cardName, stats = [], sampleLabel = '', samples = [], samplesTail = '', footer = '' }) {
        const parts = [];
        const badge = MessageService.buildLevelBadge(level);
        parts.push(`${badge} <b>${icon} 139云盘 · ${cardName}</b>`);
        if (stats.length > 0) {
            parts.push(stats.map(s => `• ${MessageService.escapeHtmlEntities(s)}`).join('\n'));
        }
        if (samples.length > 0) {
            const lines = samples.map(s => `<code>${MessageService.escapeHtmlEntities(s)}</code>`);
            if (samplesTail) {
                lines.push(samplesTail);
            }
            parts.push(`${sampleLabel}：\n${lines.join('\n')}`);
        }
        if (footer) {
            parts.push(footer);
        }
        return parts.join('\n\n');
    }

    async handleScanBanned(chatId) {
        if (!await this._ensureAccountType(chatId, 'cloud139')) return;
        const placeholder = await this._safeSendMessage(chatId, '🔍 正在启动 139 全局违规失效文件巡检，请稍候...');
        try {
            const { Cloud139Service } = require('./cloud139');
            const { CloudMaintenanceService } = require('./CloudMaintenanceService');
            const cloud139 = Cloud139Service.getInstance(this.currentAccount);
            const res = await CloudMaintenanceService.scanBannedFiles(cloud139, { rootCatalogId: '/' });
            
            const sizeMB = (res.totalBannedSize / (1024 * 1024)).toFixed(2);

            if (res.bannedFiles.length === 0) {
                const text = this._renderMaintenanceCard({
                    level: 'info',
                    icon: '🛡',
                    cardName: '违规死链巡检报告',
                    stats: [
                        `已扫描目录: ${res.scannedFolders} 个`,
                        `已检测文件: ${res.totalFiles} 个`,
                        `发现违规死链: 0 项`,
                    ],
                    footer: '🎉 当前网盘环境非常健康，未发现任何违规死链文件。',
                });
                await this._safeEditMessageText(chatId, placeholder?.message_id, text, { prebuilt: true });
            } else {
                this._lastBannedFiles = res.bannedFiles;
                const samples = res.bannedFiles.slice(0, 5).map((f) => `${f.path || f.name}（${f.reason || '违规'}）`);
                const samplesTail = res.bannedFiles.length > 5 ? `…等共 ${res.bannedFiles.length} 项，仅列前 5 项` : '';
                const text = this._renderMaintenanceCard({
                    level: 'warning',
                    icon: '🛡',
                    cardName: '违规死链巡检报告',
                    stats: [
                        `已扫描目录: ${res.scannedFolders} 个`,
                        `已检测文件: ${res.totalFiles} 个`,
                        `发现违规死链: ${res.bannedFiles.length} 项`,
                        `占用网盘空间: ${sizeMB} MB`,
                    ],
                    sampleLabel: '违规文件抽样',
                    samples,
                    samplesTail,
                    footer: '可点击下方按钮或发送 /clean_banned 立即一键清理违规文件。',
                });
                await this._safeEditMessageText(chatId, placeholder?.message_id, text, {
                    prebuilt: true,
                    replyMarkup: {
                        inline_keyboard: [[
                            { text: '🗑 立即清理违规文件', callback_data: JSON.stringify({ t: 'm_cb' }) }
                        ]]
                    }
                });
            }
        } catch (err) {
            logger.error('违规文件巡检失败', { error: err.message, stack: err.stack });
            await this._safeEditMessageText(chatId, placeholder?.message_id, `❌ 巡检失败: ${err.message}`);
        }
    }

    async handleCleanBanned(chatId) {
        if (!await this._ensureAccountType(chatId, 'cloud139')) return;
        const placeholder = await this._safeSendMessage(chatId, '🗑 正在准备清理违规文件...');
        try {
            const { Cloud139Service } = require('./cloud139');
            const { CloudMaintenanceService } = require('./CloudMaintenanceService');
            const cloud139 = Cloud139Service.getInstance(this.currentAccount);
            let targets = this._lastBannedFiles;
            if (!targets || targets.length === 0) {
                await this._safeEditMessageText(chatId, placeholder?.message_id, '🔍 正在重新扫描违规文件...');
                const scanRes = await CloudMaintenanceService.scanBannedFiles(cloud139, { rootCatalogId: '/' });
                targets = scanRes.bannedFiles;
            }
            if (targets.length === 0) {
                await this._safeEditMessageText(chatId, placeholder?.message_id, '✅ 当前没有需要清理的违规文件。');
                return;
            }
            const cleanRes = await CloudMaintenanceService.cleanBannedFiles(cloud139, targets);
            const freedMB = (cleanRes.freedBytes / (1024 * 1024)).toFixed(2);
            this._lastBannedFiles = null;
            const text = this._renderMaintenanceCard({
                level: 'success',
                icon: '🗑',
                cardName: '违规文件清理报告',
                stats: [
                    `成功移入回收站: ${cleanRes.successCount} 项`,
                    `残留未清: ${cleanRes.failedCount} 项`,
                    `释放存储空间: ${freedMB} MB`,
                ],
                footer: '🎉 违规文件清理完成，已全部移入回收站（可在回收站内找回）。',
            });
            await this._safeEditMessageText(chatId, placeholder?.message_id, text, { prebuilt: true });
        } catch (err) {
            logger.error('违规文件清理失败', { error: err.message, stack: err.stack });
            await this._safeEditMessageText(chatId, placeholder?.message_id, `❌ 清理失败: ${err.message}`);
        }
    }

    async handleSweepEmpty(chatId) {
        if (!await this._ensureAccountType(chatId, 'cloud139')) return;
        const placeholder = await this._safeSendMessage(chatId, '🧹 正在自底向上扫描并修剪空文件夹...');
        try {
            const { Cloud139Service } = require('./cloud139');
            const { CloudMaintenanceService } = require('./CloudMaintenanceService');
            const cloud139 = Cloud139Service.getInstance(this.currentAccount);
            const res = await CloudMaintenanceService.sweepEmptyFolders(cloud139, { rootCatalogId: '/' });
            const deletedDirs = res.deletedDirs || [];
            const samples = deletedDirs.slice(0, 5);
            const samplesTail = deletedDirs.length > 5 ? `…等共 ${deletedDirs.length} 个，仅列前 5 个` : '';
            const text = this._renderMaintenanceCard({
                level: 'success',
                icon: '🧹',
                cardName: '空目录清理报告',
                stats: [
                    `共修剪空目录: ${res.deletedFoldersCount} 个`,
                ],
                sampleLabel: '修剪路径抽样',
                samples,
                samplesTail,
                footer: '🎉 空文件夹自底向上修剪完成。',
            });
            await this._safeEditMessageText(chatId, placeholder?.message_id, text, { prebuilt: true });
        } catch (err) {
            logger.error('空目录修剪失败', { error: err.message, stack: err.stack });
            await this._safeEditMessageText(chatId, placeholder?.message_id, `❌ 修剪失败: ${err.message}`);
        }
    }

    async handleScanDedup(chatId) {
        if (!await this._ensureAccountType(chatId, 'cloud139')) return;
        const placeholder = await this._safeSendMessage(chatId, '🔍 正在启动 139 多版本影视资产去重巡检，请稍候...');
        try {
            const { Cloud139Service } = require('./cloud139');
            const { AssetDeduplicationService } = require('./AssetDeduplicationService');
            const ConfigService = require('./ConfigService');
            const cloud139 = Cloud139Service.getInstance(this.currentAccount);
            const files = await AssetDeduplicationService.scanCloudFiles(cloud139, { rootCatalogId: '/' });
            const policy = ConfigService.getConfigValue('policy') || {};
            const plan = AssetDeduplicationService.analyzeDuplicates(files, policy);
            this._lastDedupPlan = plan;

            if (plan.duplicateGroupsCount === 0) {
                const text = this._renderMaintenanceCard({
                    level: 'info',
                    icon: '🎬',
                    cardName: '多版本资产去重报告',
                    stats: [
                        `扫描媒体文件: ${plan.scannedFilesCount} 个`,
                        `发现多版本资产: 0 组`,
                        `冗余淘汰版本: 0 项`,
                    ],
                    footer: '🎉 当前媒体库井井有条，未发现多版本冗余文件。',
                });
                await this._safeEditMessageText(chatId, placeholder?.message_id, text, { prebuilt: true });
            } else {
                const samples = plan.groups.slice(0, 3).map((g) => {
                    const losers = (g.losers || []).map(l => l.name).join('、');
                    return `${g.title} (${g.season_episode || g.assetKey})｜保留 ${g.keeper?.name || '?'}｜淘汰 ${losers}`;
                });
                const samplesTail = plan.groups.length > 3 ? `…等共 ${plan.groups.length} 组冗余资产，仅列前 3 组` : '';
                const text = this._renderMaintenanceCard({
                    level: 'warning',
                    icon: '🎬',
                    cardName: '多版本资产去重报告',
                    stats: [
                        `扫描媒体文件: ${plan.scannedFilesCount} 个`,
                        `发现多版本资产: ${plan.duplicateGroupsCount} 组`,
                        `冗余淘汰版本: ${plan.redundantFilesCount} 项`,
                        `预估可释放空间: ${plan.totalFreedFormatted}`,
                    ],
                    sampleLabel: '去重方案抽样 (Keeper 优选保留)',
                    samples,
                    samplesTail,
                    footer: '点击下方按钮或发送 /dedup_clean 即可移入回收站安全清理。',
                });
                await this._safeEditMessageText(chatId, placeholder?.message_id, text, {
                    prebuilt: true,
                    replyMarkup: {
                        inline_keyboard: [[
                            { text: '🗑 立即清理冗余版本', callback_data: JSON.stringify({ t: 'm_dc' }) }
                        ]]
                    }
                });
            }
        } catch (err) {
            logger.error('多版本资产去重巡检失败', { error: err.message, stack: err.stack });
            await this._safeEditMessageText(chatId, placeholder?.message_id, `❌ 去重巡检失败: ${err.message}`);
        }
    }

    async handleCleanDedup(chatId) {
        if (!await this._ensureAccountType(chatId, 'cloud139')) return;
        const placeholder = await this._safeSendMessage(chatId, '🗑 正在准备执行多版本资产择优清理...');
        try {
            const { Cloud139Service } = require('./cloud139');
            const { AssetDeduplicationService } = require('./AssetDeduplicationService');
            const ConfigService = require('./ConfigService');
            const cloud139 = Cloud139Service.getInstance(this.currentAccount);
            let plan = this._lastDedupPlan;
            if (!plan || !plan.groups || plan.groups.length === 0) {
                await this._safeEditMessageText(chatId, placeholder?.message_id, '🔍 正在重新全盘扫描多版本资产...');
                const files = await AssetDeduplicationService.scanCloudFiles(cloud139, { rootCatalogId: '/' });
                const policy = ConfigService.getConfigValue('policy') || {};
                plan = AssetDeduplicationService.analyzeDuplicates(files, policy);
            }
            if (!plan || plan.groups.length === 0) {
                await this._safeEditMessageText(chatId, placeholder?.message_id, '✅ 当前没有需要清理的冗余多版本资产。');
                return;
            }
            const transferredFileRepo = this.transferredFileRepo || null;
            const res = await AssetDeduplicationService.executePrune(cloud139, plan, {
                dryRun: false,
                protectedPaths: ['/媒体库'],
                transferredFileRepo
            });
            this._lastDedupPlan = null;
            const text = this._renderMaintenanceCard({
                level: 'success',
                icon: '🎬',
                cardName: '多版本资产清理报告',
                stats: [
                    `成功移入回收站: ${res.successCount} 项`,
                    `失败未清: ${res.failedCount} 项`,
                    `释放存储空间: ${res.freedFormatted}`,
                ],
                footer: '🎉 多版本资产择优清理完成，淘汰版本已移入回收站。',
            });
            await this._safeEditMessageText(chatId, placeholder?.message_id, text, { prebuilt: true });
        } catch (err) {
            logger.error('多版本资产清理失败', { error: err.message, stack: err.stack });
            await this._safeEditMessageText(chatId, placeholder?.message_id, `❌ 清理失败: ${err.message}`);
        }
    }
}

module.exports = { TelegramBotService, COMMANDS, buildHelpText };

const TelegramBot = require('node-telegram-bot-api');
const { AppDataSource } = require('../database');
const { Task, Account, CommonFolder, TransferredFile } = require('../entities');
const { TaskService } = require('./task');
const { Cloud189Service } = require('../legacy189/services/cloud189');
const { Cloud139Service } = require('./cloud139');
const { TMDBService } = require('./tmdb');
const path = require('path');
const { default: cloudSaverSDK } = require('../sdk/cloudsaver/sdk');
const ProxyUtil = require('../utils/ProxyUtil');
const cloud189Utils = require('../legacy189/utils/Cloud189Utils');
const Cloud139Utils = require('../utils/Cloud139Utils');
const logger = require('../utils/logger');

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
        this.currentFolderId = '-11';  // 当前文件夹ID
        this.folders = new Map();
        this.parentFolderIds = new Set();

        // 全局任务列表消息id
        this.globalTaskListMessageId = null;
        // 全局常用目录列表消息id
        this.globalCommonFolderListMessageId = null;

        this.cloudSaverSdk = cloudSaverSDK;
        this.isSearchMode = false;
        this.searchModeTimeout = null;  // 搜索模式超时计时器

        this.cloudSaverSearchMap = new Map();

        this.tmdbService = new TMDBService();
    }

    _isLegacy189RuntimeEnabled() {
        return ConfigService.getConfigValue('legacy.enableCloud189Runtime') === true;
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
        
        // 设置命令菜单
        await this.bot.setMyCommands([
            { command: 'help', description: '帮助信息' },
            { command: 'search_cs', description: '搜索CloudSaver资源' },
            { command: 'accounts', description: '账号列表' },
            { command: 'tasks', description: '任务列表' },
            { command: 'execute_all', description: '执行所有任务' },
            { command: 'fl', description: '常用目录列表' },
            { command: 'fs', description: '添加常用目录' },
            { command: 'cancel', description: '取消当前操作' }
        ]);
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
            // 清理状态
            this.currentAccountId = null;
            this.currentAccount = null;
            this.currentShareLink = null;
            this.currentAccessCode = null;
            this.lastButtonMessageId = null;
            this.currentFolderPath = '';
            this.currentFolderId = '-11';
            this.folders.clear();
            this.parentFolderIds.clear();
            this.globalTaskListMessageId = null;
            this.globalCommonFolderListMessageId = null;
            return true;
        } catch (error) {
            logger.error('停止机器人失败', { error: error.message, stack: error.stack });
            return false;
        }
    }

    initCommands() {
        this.bot.onText(/\/help/, async (msg) => {
            const helpText = 
                '🤖 云盘机器人使用指南\n\n' +
                '📋 基础命令：\n' +
                '/help - 显示帮助信息\n' +
                '/accounts - 账号列表与切换\n' +
                '/tasks - 显示下载任务列表\n' +
                '/fl - 显示常用目录列表\n' +
                '/fs - 添加常用目录\n' +
                '/search_cs - 搜索CloudSaver资源\n' +
                '/cancel - 取消当前操作\n\n' +
                '📥 创建任务：\n' +
                '直接发送天翼云盘(189)或移动云盘(139)分享链接即可创建任务\n' +
                '格式：链接（支持访问码的链接）\n\n' +
                '📝 任务操作：\n' +
                '/execute_[ID] - 执行指定任务\n' +
                '/execute_all - 执行所有任务\n' +
                '/dt_[ID] - 删除指定任务\n' +

                '🔍 资源搜索：\n' +
                '1. 输入 /search_cs 进入搜索模式\n' +
                '2. 直接输入关键字搜索资源\n' +
                '3. 点击搜索结果中的链接可复制\n' +
                '4. 输入 /cancel 退出搜索模式';

            await this.bot.sendMessage(msg.chat.id, helpText);
        });


        this.bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)){
                return;
            }
            // 忽略命令消息
            if (msg.text?.startsWith('/')) return;
            // 搜索模式下处理消息
            if (this.isSearchMode) {
                const input = msg.text?.trim();
                // 判断是否为纯数字
                if (/^\d+$/.test(input)) {
                    const index = parseInt(input);
                    const cacheShareLink = this.cloudSaverSearchMap.get(index);
                    if (!cacheShareLink) {
                        this.bot.sendMessage(chatId, '无效的编号');
                        return;
                    }
                    try {
                        let shareLink, accessCode;
                        if (/(?:yun|caiyun)\.139\.com/i.test(cacheShareLink)) {
                            const extracted = Cloud139Utils.extractFromShareText(cacheShareLink);
                            shareLink = extracted ? extracted.url : cacheShareLink;
                            accessCode = extracted?.passwd || '';
                        } else if (/cloud\.189\.cn/i.test(cacheShareLink)) {
                            if (!this._isLegacy189RuntimeEnabled()) {
                                await this.bot.sendMessage(chatId, '当前默认运行链路已禁用 189，请使用 139 分享链接');
                                return;
                            }
                            const parsed = cloud189Utils.parseCloudShare(cacheShareLink);
                            shareLink = parsed?.url;
                            accessCode = parsed?.accessCode || '';
                        } else {
                            // 其他来源链接，直接发送给用户
                            await this.bot.sendMessage(chatId, `🔗 资源链接（非189/139云盘，请手动处理）:\n${cacheShareLink}`);
                            return;
                        }
                        // 处理分享链接
                        await this.handleFolderSelection(chatId, shareLink, null, accessCode);
                        return
                    }catch(e){
                        this.bot.sendMessage(chatId, `处理失败: ${e.message}`);
                        return;
                    }
                }
                this.cloudSaverSearch(chatId, msg)
            }
        });

        this.bot.onText(/cloud\.189\.cn/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)){
                return;
            }
            if (!this._isLegacy189RuntimeEnabled()) {
                await this.bot.sendMessage(chatId, '当前默认运行链路已禁用 189，请使用 139 分享链接');
                return;
            }
            // 如果处于搜索模式，则不处理
            if (this.isSearchMode) {
                return;
            }
            try {
                if (!this._checkUserId(chatId)) return;
                if (!await this._ensureAccountType(chatId, 'cloud189')) return;
                const { url: shareLink, accessCode } = cloud189Utils.parseCloudShare(msg.text);
                await this.handleFolderSelection(chatId, shareLink, null, accessCode);
            } catch (error) {
                logger.error('处理189分享链接失败', { error: error.message, stack: error.stack })
                this.bot.sendMessage(chatId, `处理失败: ${error.message}`);
            }
        });

        // 139 移动云盘分享链接直接识别
        this.bot.onText(/(?:yun|caiyun)\.139\.com/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return;
            // 如果处于搜索模式，则不处理
            if (this.isSearchMode) return;
            try {
                if (!this._checkUserId(chatId)) return;
                if (!await this._ensureAccountType(chatId, 'cloud139')) return;
                const extracted = Cloud139Utils.extractFromShareText(msg.text);
                const shareLink = extracted ? extracted.url : msg.text.trim();
                const accessCode = extracted?.passwd || '';
                await this.handleFolderSelection(chatId, shareLink, null, accessCode);
            } catch (error) {
                logger.error('处理139分享链接失败', { error: error.message, stack: error.stack });
                this.bot.sendMessage(chatId, `处理失败: ${error.message}`);
            }
        });


        // 添加账号列表命令
        this.bot.onText(/\/accounts/, async (msg) => {
            await this.showAccounts(msg.chat.id);
        });

        // 添加任务列表命令
        this.bot.onText(/\/tasks/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            if (!this._checkUserId(chatId)) return
            await this.showTasks(msg.chat.id);
        });

        // 添加常用目录查询命令
        this.bot.onText(/\/fl$/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            if (!this._checkUserId(chatId)) return
            await this.showCommonFolders(chatId);
        });

        this.bot.onText(/\/fs$/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            if (!this._checkUserId(chatId)) return
            await this.showFolderTree(chatId);
        });

        // 执行任务
        this.bot.onText(/^\/execute_(\d+)$/, async (msg, match) => {
            const chatId = msg.chat.id;
            const taskId = match[1];
            if (!this._checkChatId(chatId)) return
            if(!this._checkTaskId(taskId)) return;
            const message = await this.bot.sendMessage(chatId, `任务开始执行`);
            try{
                await this.taskService.processAllTasks(true, [taskId])   
                this.bot.deleteMessage(chatId, message.message_id);
                await this.bot.sendMessage(chatId, `任务执行完成`);
            }catch(e){
                await this.bot.editMessageText(`任务执行失败: ${e.message}`, {
                    chat_id: chatId,
                    message_id: message.message_id
                });
                return;
            }
        })

        // 执行所有任务
        this.bot.onText(/^\/execute_all$/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            const message = await this.bot.sendMessage(chatId, `开始执行所有任务...`);
            try {
                await this.taskService.processAllTasks(true);
                this.bot.editMessageText("所有任务执行完成", {
                    chat_id: chatId,
                    message_id: message.message_id
                });
            } catch(e) {
                await this.bot.editMessageText(`任务执行失败: ${e.message}`, {
                    chat_id: chatId,
                    message_id: message.message_id
                });
            }
        });

        // 添加删除任务命令
        this.bot.onText(/\/dt_(\d+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const taskId = match[1];
            if (!this._checkChatId(chatId)) return
            const keyboard = [
                [
                    { text: '是', callback_data: JSON.stringify({ t: 'dt', i: taskId, c: true, df: true }) },
                    { text: '否', callback_data: JSON.stringify({ t: 'dt', i: taskId, c: true, df: false }) }
                ],
                [{ text: '取消', callback_data: JSON.stringify({ t: 'dt', c: false }) }]
            ];
            await this.bot.sendMessage(chatId, '是否同步删除网盘文件？', {
                reply_markup: { inline_keyboard: keyboard }
            });
        });



        // 搜索CloudSaver命令
        this.bot.onText(/\/search_cs/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            if (this.isSearchMode) {
                await this.bot.sendMessage(chatId, '当前已处于搜索模式, 请直接输入关键字搜索资源\n输入 /cancel 退出搜索模式');
                return;
            } 
            if (!this._checkUserId(chatId)) return;
            // 判断用户是否开启了CloudSaver
            if (!this.cloudSaverSdk.enabled){
                await this.bot.sendMessage(chatId, '未开启CloudSaver, 请先在网页端配置CloudSaver');
                return;
            }
            this.isSearchMode = true;
            // 设置3分钟超时
            this._resetSearchModeTimeout(chatId);
            await this.bot.sendMessage(chatId, '已进入搜索模式，请输入关键字搜索资源\n输入 /cancel 退出搜索模式\n3分钟内未搜索将自动退出搜索模式');
        });

        this.bot.onText(/\/cancel/, async (msg) => {
            const chatId = msg.chat.id;
            if (!this._checkChatId(chatId)) return
            // 清除缓存
            this.currentShareLink = null;
            this.currentAccessCode = null;
            this.isSearchMode = false;  // 退出搜索模式
            try {
                if (this.lastButtonMessageId) {
                    await this.bot.deleteMessage(chatId, this.lastButtonMessageId);
                    this.lastButtonMessageId = null;
                }
            } catch (error) {
                logger.warn('删除消息失败', { error: error.message, stack: error.stack });
            }
            
            await this.bot.sendMessage(chatId, '已取消当前操作');
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
                            await this.bot.editMessageText("已取消任务创建",{
                                chat_id: chatId,
                                message_id: messageId
                            });
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
                            await this.bot.editMessageText("已取消删除",{
                                chat_id: chatId,
                                message_id: messageId
                            });
                            return;
                        }
                        await this.deleteTask(chatId, data, messageId);
                        break;
                    case 'fd': // 进入下一级目录
                        await this.showFolderTree(chatId, data, messageId);
                        break;
                    case 'fc': // 取消操作
                        await this.bot.deleteMessage(chatId, messageId);
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
                }
            } catch (error) {
                this.bot.sendMessage(chatId, `处理失败: ${error.message}`);
            }
        });



        // 添加TMDB搜索命令
        this.bot.onText(/\/tmdb (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const input = match[1];
            if (!this._checkChatId(chatId)) return
            let title, year;

            // 解析输入的标题和年份
            const yearMatch = input.match(/^(.+?)(?:\s+(\d{4}))?$/);
            if (yearMatch) {
                title = yearMatch[1].trim();
                year = yearMatch[2];
            }

            const message = await this.bot.sendMessage(chatId, '正在搜索...');
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
                this.bot.deleteMessage(chatId, message.message_id);
                this.bot.sendPhoto(chatId, firstPoster, {
                    caption: responseText,
                    parse_mode: 'HTML'
                });
            } catch (error) {
                await this.bot.editMessageText(`搜索失败: ${error.message}`, {
                    chat_id: chatId,
                    message_id: message.message_id
                });
            }
        });
    }

    async showAccounts(chatId, messageId = null) {
        if (!this._checkChatId(chatId)){
            return;
        }
        const accounts = await this.accountRepo.find();
        const keyboard = accounts.map(account => [{
            text: `${account.username.slice(0, 3)}***${account.username.slice(-3)} ${account.id === this.currentAccountId ? '✅' : ''}`,
            callback_data: JSON.stringify({ t: 'sa', i: account.id, a: `${account.username.slice(0, 3)}***${account.username.slice(-3)}` })
        }]);

        const message = '账号列表 (✅表示当前选中账号):';
        if (messageId) {
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            await this.bot.sendMessage(chatId, message, {
                reply_markup: { inline_keyboard: keyboard }
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
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            // 先删除之前的消息
            if (this.globalTaskListMessageId) {
                await this.bot.deleteMessage(chatId, this.globalTaskListMessageId);
            }
            const newMessage = await this.bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
            this.globalTaskListMessageId = newMessage.message_id;
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
        if (requiredType === 'cloud189' && !this._isLegacy189RuntimeEnabled()) {
            await this.bot.sendMessage(chatId, '当前默认运行链路已禁用 189，请切换到 139 账号');
            return false;
        }
        if (this.currentAccount?.accountType === requiredType) return true;
        const accounts = await this.accountRepo.find({ where: { accountType: requiredType } });
        if (accounts.length === 0) {
            const label = requiredType === 'cloud139' ? '移动云盘(139)' : '天翼云盘(189)';
            await this.bot.sendMessage(chatId, `当前没有可用的 ${label} 账号，请先在账号页面添加对应账号`);
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
                await this.bot.sendMessage(chatId, `账号[${data.a}]已被选中`);
                await this.bot.deleteMessage(chatId, messageId);
                return;
            } 
            this.currentAccountId = accountId;
            // 获取账号信息
            const account = await this.accountRepo.findOneBy({ id: accountId });
            if (!account) {
                await this.bot.sendMessage(chatId, '未找到该账号');
            }
            this.currentAccount = account;
            account.tgBotActive = true;
            this.accountRepo.save(account);
            // 删除原消息
            await this.bot.deleteMessage(chatId, messageId);
            await this.bot.sendMessage(chatId, `已选择账号: ${this._getDesensitizedUserName()}`);

        } catch (error) {
            this.bot.sendMessage(chatId, `设置当前账号失败: ${error.message}`);
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
                await this.bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: keyboard }
                });
                this.globalCommonFolderListMessageId = null
            } else {
                await this.bot.sendMessage(chatId, message, {reply_markup: { inline_keyboard: keyboard }});
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
            await this.bot.sendMessage(chatId, `解析分享链接失败: ${e.message}`);
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
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            this.lastButtonMessageId = messageId;
        } else {
            const msg = await this.bot.sendMessage(chatId, message, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            this.lastButtonMessageId = msg.message_id;
        }
    }

    async createTask(chatId, data, messageId) {
        try {
            const targetFolderId = data.f;
            // 根据targetFolderId查询出folderName
            const targetFolder = await this.commonFolderRepo.findOne({ where: { id: targetFolderId } });
            if (!targetFolder) {
                await this.bot.sendMessage(chatId, '未找到该目录');
                return
            }
            // 发送任务创建中消息
            const message = await this.bot.editMessageText('任务创建中...',{
                chat_id: chatId,
                message_id: messageId
            });
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
            this.bot.editMessageText('任务创建成功, 执行中...', {
                chat_id: chatId,
                message_id: message.message_id
            });
            if(taskIds.length > 0) {
                await this.taskService.processAllTasks(true, taskIds)   
            }
            this.bot.deleteMessage(chatId, message.message_id);
            // 发送任务执行完成消息
            this.bot.sendMessage(chatId, '任务执行完成');
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
                await this.bot.editMessageText('该目录下已有同名文件夹，是否覆盖？', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
                return;
            }else{
                await this.bot.editMessageText(`任务创建失败: ${error.message}`, {
                    chat_id: chatId,
                    message_id: messageId
                });
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
                await this.bot.editMessageText('任务ID无效', {
                    chat_id: chatId,
                    message_id: messageId
                });
                return;
            }
            // 发送任务删除中消息
            await this.bot.editMessageText('任务删除中...',{
                chat_id: chatId,
                message_id: messageId
            });

            await this.taskService.deleteTask(parseInt(data.i), data.df);
            await this.bot.editMessageText('任务删除成功', {
                chat_id: chatId,
                message_id: messageId
            });
            // 刷新任务列表
            setTimeout(() => this.showTasks(chatId, 1), 800);
        }catch(e) {
            this.bot.editMessageText(`任务删除失败: ${e.message}`, {
                chat_id: chatId,
                message_id: messageId
            });
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
                await this.bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: keyboard }
                });
                this.globalCommonFolderListMessageId = null
            } else { 
                if (this.globalCommonFolderListMessageId) {
                    await this.bot.deleteMessage(chatId, this.globalCommonFolderListMessageId);
                    this.globalCommonFolderListMessageId = null;
                }
                await this.bot.sendMessage(chatId, message,{reply_markup: { inline_keyboard: keyboard }});
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
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
            this.globalCommonFolderListMessageId = null
        } else {
            if (this.globalCommonFolderListMessageId) {
                await this.bot.deleteMessage(chatId, this.globalCommonFolderListMessageId);
            }
            const newMessage = await this.bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: keyboard } });
            this.globalCommonFolderListMessageId = newMessage.message_id;
        }
    }

    async showFolderTree(chatId, data, messageId = null) {
        try {
            if (!this.currentAccount) {
                await this.bot.sendMessage(chatId, '未选择账号，请先使用 /accounts 选择账号');
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
                if (!this._isLegacy189RuntimeEnabled()) {
                    throw new Error('当前默认运行链路已禁用 189 目录浏览');
                }
                const cloud189 = Cloud189Service.getInstance(this.currentAccount);
                folders = await cloud189.getFolderNodes(folderId);
                if (!folders) {
                    throw new Error('getFolderNodes 返回空');
                }
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
                await this.bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else {
                await this.bot.sendMessage(chatId, message, {
                    reply_markup: { inline_keyboard: keyboard }
                });
            }

        } catch (error) {
            logger.error('获取目录失败', { error: error.message, stack: error.stack });
            this.bot.sendMessage(chatId, `获取目录失败: ${error.message}`);
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
                await this.bot.editMessageText(`${data.p || '根目录'} 已经是常用目录`, {
                    chat_id: chatId,
                    message_id: messageId
                });
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
            await this.bot.editMessageText(`已将 ${currentPath || '根目录'} 添加到常用目录`, {
                chat_id: chatId,
                message_id: messageId
            });
            
        } catch (error) {
            throw new Error(`保存常用目录失败: ${error.message}`);
        }
    }

    async cloudSaverSearch(chatId, msg) {
        const keyword = msg.text?.trim();
        if (!keyword) return;
        // 重置超时时间
        this._resetSearchModeTimeout(chatId);
        try {
            const message = await this.bot.sendMessage(chatId, '正在搜索...');
            const result = await this.cloudSaverSdk.search(keyword);
            if (result.length <= 0) {
                await this.bot.editMessageText('未找到相关资源', {
                    chat_id: chatId,
                    message_id: message.message_id
                });
                return
            }
            // 分组：天翼189 和 移动139
            const cloud189Results = result.filter(item => item.cloudLinks[0].link.includes('cloud.189.cn'));
            const cloud139Results = result.filter(item => /(?:yun|caiyun)\.139\.com/.test(item.cloudLinks[0].link));

            // 保存结果到 cloudSaverSearchMap（按分组顺序编号）
            let globalIndex = 0;
            let groupText = '';
            if (cloud189Results.length > 0) {
                groupText += '☁️ <b>天翼云盘 (189)</b>\n';
                cloud189Results.forEach(item => {
                    globalIndex++;
                    this.cloudSaverSearchMap.set(globalIndex, item.cloudLinks[0].link);
                    groupText += `${globalIndex}. 🎬 <a href="${item.cloudLinks[0].link}">${item.title}</a>\n`;
                });
            }
            if (cloud139Results.length > 0) {
                if (groupText) groupText += '\n';
                groupText += '📱 <b>移动云盘 (139)</b>\n';
                cloud139Results.forEach(item => {
                    globalIndex++;
                    this.cloudSaverSearchMap.set(globalIndex, item.cloudLinks[0].link);
                    groupText += `${globalIndex}. 🎬 <a href="${item.cloudLinks[0].link}">${item.title}</a>\n`;
                });
            }
            const results = `💡 以下资源来自 CloudSaver\n` +
                `📝 共找到 ${result.length} 个结果，输入编号可转存\n\n` +
                groupText;
            await this.bot.editMessageText(`搜索结果：\n\n${results}`, {
                chat_id: chatId,
                message_id: message.message_id,
                parse_mode: 'HTML'
            });
        } catch (error) {
            await this.bot.sendMessage(chatId, `搜索失败: ${error.message}`);
        }
    }

    // 校验任务id
    _checkTaskId(taskId) {
        if(isNaN(taskId)) {
            this.bot.editMessageText('任务ID无效', {
                chat_id: chatId,
                message_id: messageId
            });
            return false;
        }
        return true;
    }
    // 校验当前是否有用户id
    _checkUserId(chatId) {
        if(!this.currentAccountId) {
            this.bot.sendMessage(chatId, '请先使用 /accounts 选择账号');
            return false;
        }
        return true;
    }
    // 校验是否是当前chatId
    _checkChatId(chatId) {
        if (chatId != this.chatId) return false;
        return true;
    }
    // 获取当前已脱敏的用户名
    _getDesensitizedUserName() {
       return this.currentAccount.username.replace(/(.{3}).*(.{4})/, '$1****$2');
    }

    // 在类的底部添加新的辅助方法
    _resetSearchModeTimeout(chatId) {
        // 清除现有的超时计时器
        if (this.searchModeTimeout) {
            clearTimeout(this.searchModeTimeout);
        }
        
        // 设置新的超时计时器
        this.searchModeTimeout = setTimeout(async () => {
            if (this.isSearchMode) {
                this.isSearchMode = false;
                this.cloudSaverSearchMap = new Map();
                await this.bot.sendMessage(chatId, '长时间未搜索，已自动退出搜索模式');
            }
        }, 3 * 60 * 1000);  // 3分钟
    }
}

module.exports = { TelegramBotService };

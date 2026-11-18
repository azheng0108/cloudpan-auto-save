const { Like, Not, IsNull, Or, In } = require('typeorm');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { Cloud139Service } = require('../services/cloud139');
const ConfigService = require('../services/ConfigService');
const { SchedulerService } = require('../services/scheduler');
const CustomPushService = require('../services/message/CustomPushService');
const { logTaskEvent } = require('../utils/logUtils');
const { AppDataSource, getChannelMonitorRepository, getChannelMonitorHistoryRepository, getAccountRepository } = require('../database');
const { Account } = require('../entities');
const logger = require('../utils/logger');
const { TgChannelMonitorService } = require('../services/channel/TgChannelMonitorService');
const { RecognitionEngine } = require('../services/RecognitionEngine');
const ProxyUtil = require('../utils/ProxyUtil');
const { registerAccountsRoutes } = require('./api/accounts');
const { ensureCloud139Account, maskUsername } = require('./api/shared');

const clearAllSessionFiles = async () => {
    const sessionsDir = path.resolve(process.cwd(), 'data/sessions');
    try {
        const files = await fs.readdir(sessionsDir);
        await Promise.all(files.map(async (file) => {
            const filePath = path.join(sessionsDir, file);
            const stat = await fs.stat(filePath);
            if (stat.isFile()) {
                await fs.unlink(filePath);
            }
        }));
        return true;
    } catch (error) {
        // 若目录不存在或权限问题，返回失败但不阻断设置保存。
        logTaskEvent(`[system] 清理会话文件失败: ${error.message}`);
        return false;
    }
};



const registerApiRoutes = (app, deps) => {
    const {
        accountRepo,
        taskRepo,
        commonFolderRepo,
        taskService,
        messageUtil,
        botManager,
        folderCache,
        currentVersion,
    } = deps;

    registerAccountsRoutes(app, deps);

    app.get('/api/tasks', async (req, res) => {
        const { status, search } = req.query;
        let whereClause = {};

        if (status && status !== 'all') {
            whereClause.status = status;
        }
        whereClause.enableSystemProxy = Or(IsNull(), false);

        if (search) {
            const searchConditions = [
                { realFolderName: Like(`%${search}%`) },
                { remark: Like(`%${search}%`) },
                { account: { username: Like(`%${search}%`) } },
            ];
            if (Object.keys(whereClause).length > 0) {
                whereClause = searchConditions.map((searchCond) => ({
                    ...whereClause,
                    ...searchCond,
                }));
            } else {
                whereClause = searchConditions;
            }
        }
        const tasks = await taskRepo.find({
            order: { id: 'DESC' },
            relations: { account: true },
            select: { account: { username: true } },
            where: whereClause,
        });
        tasks.forEach((task) => {
            if (task.account?.username) {
                task.account.username = maskUsername(task.account.username);
            }
            if (!task.posterPath && task.tmdbContent) {
                try {
                    const parsed = JSON.parse(task.tmdbContent);
                    if (parsed && (parsed.posterPath || parsed.poster_path)) {
                        task.posterPath = parsed.posterPath || parsed.poster_path;
                    }
                } catch (e) {}
            }
        });
        res.json({ success: true, data: tasks });
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const account = await accountRepo.findOneBy({ id: parseInt(req.body.accountId) });
            ensureCloud139Account(account, '任务创建');
            const task = await taskService.createTask(req.body);
            res.json({ success: true, data: task });
        } catch (error) {
            logger.error('任务创建失败', { error: error.message, stack: error.stack });
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tasks/batch', async (req, res) => {
        try {
            const taskIds = req.body.taskIds || req.body.ids;
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTasks(taskIds, deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tasks/files', async (req, res) => {
        try {
            const { taskId, files } = req.body;
            if (!files || files.length === 0) {
                throw new Error('未选择要删除的文件');
            }
            await taskService.deleteFiles(taskId, files);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tasks/:id', async (req, res) => {
        try {
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTask(parseInt(req.params.id), deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/tasks/:id', async (req, res) => {
        try {
            const taskId = parseInt(req.params.id);
            const updatedTask = await taskService.updateTask(taskId, req.body);
            res.json({ success: true, data: updatedTask });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/:id/execute', async (req, res) => {
        try {
            const task = await taskRepo.findOne({
                where: { id: parseInt(req.params.id) },
                relations: { account: true },
                select: { account: { username: true } },
            });
            if (!task) throw new Error('任务不存在');
            logTaskEvent('================================');
            const taskName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : task.resourceName || '未知';
            logTaskEvent(`任务[${taskName}]开始执行`);
            const result = await taskService.processTask(task);
            if (result) {
                messageUtil.sendMessage(result);
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    const handleFetchFolders = async (accountIdRaw, folderIdRaw, forceRefreshRaw, res) => {
        const accountId = parseInt(accountIdRaw);
        try {
            if (!accountId || isNaN(accountId)) {
                return res.json({
                    success: false,
                    code: 'AUTH_FAILED',
                    error: '请先在「云盘账号」页面绑定并登录 139 移动云盘账号'
                });
            }
            const folderId = folderIdRaw || '-11';
            const forceRefresh = forceRefreshRaw === 'true';
            const cacheKey = `folders_${accountId}_${folderId}`;
            if (forceRefresh) {
                folderCache.clearPrefix('folders_');
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            ensureCloud139Account(account, '目录读取', true);

            const cloud139 = Cloud139Service.getInstance(account);
            const catalogID = (folderId === '-11' || !folderId) ? '/' : folderId;
            const listResult = await cloud139.listDiskDir(catalogID);
            if (!listResult) throw new Error('获取目录失败，请检查账号认证是否有效');
            const mediaExts = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'ts', 'm2ts', 'rmvb', 'm4v', 'webm', 'mp3', 'flac', 'aac', 'm4a']);
            const folders = listResult.items
                .filter((f) => f.type === 'folder' || mediaExts.has(f.extension || ''))
                .map((f) => ({
                    id: f.fileId,
                    name: f.name,
                    isFolder: f.type === 'folder',
                    isFile: f.type !== 'folder',
                }));

            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            const isAuthFail = error.code === 'AUTH_FAILED' || Cloud139Service.isAuthFailure(error) || /04000005|05050006|认证失败|登录凭证已失效/.test(error.message);
            if (isAuthFail && accountId && !isNaN(accountId)) {
                try {
                    await accountRepo.update({ id: accountId }, { isActive: false });
                    Cloud139Service.clearInstance(accountId);
                } catch (_) {}
                return res.json({
                    success: false,
                    code: 'AUTH_FAILED',
                    error: '云盘账号登录凭证已失效，系统已自动标记离线，请前往【云盘账号】重新扫码登录'
                });
            }
            res.json({ success: false, code: error.code, error: error.message });
        }
    };

    app.get('/api/folders/:accountId', async (req, res) => {
        await handleFetchFolders(req.params.accountId, req.query.folderId || req.query.parentId, req.query.refresh, res);
    });

    app.get('/api/accounts/:id/files', async (req, res) => {
        await handleFetchFolders(req.params.id, req.query.folderId || req.query.parentId, req.query.refresh, res);
    });

    app.post('/api/folders/mkdir', async (req, res) => {
        const accountId = parseInt(req.body?.accountId);
        try {
            const { parentFileId, folderName } = req.body || {};
            if (!folderName || !folderName.trim()) throw new Error('文件夹名称不能为空');
            const account = await accountRepo.findOneBy({ id: accountId });
            ensureCloud139Account(account, '创建文件夹', true);
            const cloud139 = Cloud139Service.getInstance(account);
            const result = await cloud139.createFolderHcy(parentFileId || '/', folderName.trim());
            if (!result) throw new Error('创建文件夹失败');
            folderCache.clearPrefix(`folders_${accountId}_`);
            res.json({ success: true, data: result });
        } catch (error) {
            const isAuthFail = error.code === 'AUTH_FAILED' || Cloud139Service.isAuthFailure(error) || /04000005|05050006|认证失败|登录凭证已失效/.test(error.message);
            if (isAuthFail && accountId && !isNaN(accountId)) {
                try {
                    await accountRepo.update({ id: accountId }, { isActive: false });
                    Cloud139Service.clearInstance(accountId);
                } catch (_) {}
                return res.json({
                    success: false,
                    code: 'AUTH_FAILED',
                    error: '云盘账号登录凭证已失效，请前往【云盘账号】重新扫码登录'
                });
            }
            res.json({ success: false, code: error.code, error: error.message });
        }
    });

    app.get('/api/share/folders/:accountId', async (req, res) => {
        try {
            const taskId = parseInt(req.query.taskId);
            const folderId = req.query.folderId;
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `share_folders_${taskId}_${folderId}`;
            if (forceRefresh) {
                folderCache.clearPrefix('share_folders_');
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
            if (!task) {
                throw new Error('任务不存在');
            }
            const account = await accountRepo.findOneBy({ id: parseInt(req.params.accountId) });
            ensureCloud139Account(account, '分享目录读取');

            const cloud139 = Cloud139Service.getInstance(account);
            if (folderId == -11) {
                let rootId = (task.shareFolderId === 'root-files' || !task.shareFolderId) ? 'root' : task.shareFolderId;
                let rootName = task.shareFolderName || task.resourceName;
                if (rootId === 'root') {
                    try {
                        const rootDir = await cloud139.listShareDir(task.shareId, task.accessCode || '', 'root');
                        const rootFolders = rootDir?.folderList ?? [];
                        const rootFiles = rootDir?.fileList ?? [];
                        if (rootFolders.length === 1 && rootFiles.length === 0) {
                            rootId = String(rootFolders[0].catalogID ?? rootFolders[0].caID);
                            rootName = rootFolders[0].catalogName ?? rootFolders[0].caName ?? rootName;
                        }
                    } catch (_) {
                    }
                }
                return res.json({ success: true, data: [{ id: rootId, name: rootName }] });
            }
            const shareDir = await cloud139.listShareDir(task.shareId, task.accessCode || '', folderId);
            if (!shareDir) {
                return res.json({ success: true, data: [] });
            }
            const folders = (shareDir.folderList || []).map((f) => ({
                id: String(f.catalogID ?? f.caID),
                name: f.catalogName ?? f.caName ?? String(f.catalogID ?? f.caID),
            }));
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/folder/files', async (req, res) => {
        const { accountId, taskId } = req.query;
        const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
        const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }
        try {
            ensureCloud139Account(account, '目录文件读取');
            const cloud139 = Cloud139Service.getInstance(account);
            const listResult = await cloud139.listDiskDir(task.realFolderId || '/');
            if (!listResult) {
                return res.json({ success: true, data: [] });
            }
            const files = listResult.items
                .filter((f) => f.type !== 'folder')
                .map((f) => ({
                    id: f.fileId,
                    name: f.name,
                    size: f.size,
                    lastOpTime: f.updatedAt || '',
                }));
            return res.json({ success: true, data: files });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/files/rename', async (req, res) => {
        try {
            const { taskId, accountId, files, sourceRegex, targetRegex } = req.body;
            if (!files || files.length == 0) {
                return res.json({ success: false, error: '未获取到需要修改的文件' });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            ensureCloud139Account(account, '文件重命名');
            const task = await taskService.getTaskById(taskId);
            if (!task) {
                return res.json({ success: false, error: '任务不存在' });
            }
            const result = [];
            const successFiles = [];
            const cloud139 = Cloud139Service.getInstance(account);
            for (const file of files) {
                const renameResult = await cloud139.renameFile(file.fileId, file.destFileName);
                if (!renameResult || renameResult.res_code != 0) {
                    result.push(`文件${file.destFileName} 重命名失败${renameResult ? ': ' + renameResult.res_msg : ''}`);
                } else {
                    successFiles.push({ id: file.fileId, name: file.destFileName });
                }
            }
            if (sourceRegex && targetRegex) {
                task.sourceRegex = sourceRegex;
                task.targetRegex = targetRegex;
                taskRepo.save(task);
            }
            if (result.length > 0) {
                logTaskEvent(result.join('\n'));
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/jinja2/preview', async (req, res) => {
        const { movieTemplate, tvTemplate, filenames } = req.body;
        if (!filenames || filenames.length === 0) {
            return res.json({ success: true, data: [] });
        }
        const result = filenames.map((filename) => {
            const vars = taskService._parseMediaFileName(filename);
            const template = vars.season_episode ? (tvTemplate || '') : (movieTemplate || '');
            if (!template) return { oldName: filename, newName: filename };
            const rendered = taskService._renderJinjaTemplate(template, vars);
            if (!rendered) return { oldName: filename, newName: filename };
            const newName = rendered.split('/').pop();
            return { oldName: filename, newName };
        });
        res.json({ success: true, data: result });
    });

    app.post('/api/tasks/executeAll', async (req, res) => {
        try {
            // 后台异步触发，避免长任务阻塞 HTTP 请求导致超时。
            Promise.resolve()
                .then(() => taskService.processAllTasks(true))
                .catch((error) => {
                    logTaskEvent(`[api] executeAll 异步执行失败: ${error.message}`);
                });
            res.json({ success: true, data: { started: true } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/health', async (req, res) => {
        const startedAt = process.uptime();
        const dbConnected = AppDataSource.isInitialized;
        const basePayload = {
            success: true,
            status: dbConnected ? 'ok' : 'degraded',
            version: currentVersion,
            uptimeSeconds: Math.floor(startedAt),
            database: {
                connected: dbConnected,
            },
            timestamp: new Date().toISOString(),
        };

        if (!dbConnected) {
            return res.status(503).json(basePayload);
        }

        try {
            await AppDataSource.query('SELECT 1');
            return res.json(basePayload);
        } catch (error) {
            return res.status(503).json({
                ...basePayload,
                status: 'degraded',
                database: {
                    connected: false,
                    error: error.message,
                },
            });
        }
    });

    app.get('/api/settings', async (req, res) => {
        res.json({ success: true, data: ConfigService.getConfig() });
    });

    app.post('/api/settings', async (req, res) => {
        try {
            const settings = req.body;
            const oldPassword = ConfigService.getConfigValue('system.password');
            const newPassword = settings?.system?.password;
            const passwordChanged = typeof newPassword === 'string' && newPassword.length > 0 && newPassword !== oldPassword;
            if (settings?.system && (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length === 0)) {
                settings.system.password = oldPassword;
            }

            const normalizedTaskSchedules = SchedulerService.validateTaskScheduleSettings(settings?.task || {}, settings?.maintenance || {});
            settings.task = {
                ...(settings.task || {}),
                taskCheckCron: normalizedTaskSchedules.taskCheckCron,
                retryTaskCron: normalizedTaskSchedules.retryTaskCron,
                vacuumCron: normalizedTaskSchedules.vacuumCron,
            };
            if (settings.maintenance) {
                settings.maintenance.bannedScanCron = normalizedTaskSchedules.bannedScanCron;
                settings.maintenance.sweepEmptyCron = normalizedTaskSchedules.sweepEmptyCron;
                settings.maintenance.dedupCron = normalizedTaskSchedules.dedupCron;
            }

            if (settings.channelMonitor && settings.channelMonitor.pollInterval) {
                const interval = parseInt(settings.channelMonitor.pollInterval, 10);
                if (interval > 0) {
                    settings.channelMonitor.cron = `*/${interval} * * * *`;
                }
            }

            if (settings.tmdb) {
                settings.tmdb = {
                    ...(ConfigService.getConfigValue('tmdb') || {}),
                    ...settings.tmdb,
                    tmdbApiKey: typeof settings.tmdb.tmdbApiKey === 'string' ? settings.tmdb.tmdbApiKey.trim() : (settings.tmdb.tmdbApiKey || ''),
                    apiBaseUrl: typeof settings.tmdb.apiBaseUrl === 'string' && settings.tmdb.apiBaseUrl.trim() ? settings.tmdb.apiBaseUrl.trim() : 'https://api.themoviedb.org/3',
                    proxy: typeof settings.tmdb.proxy === 'string' ? settings.tmdb.proxy.trim() : ''
                };
            }

            if (settings.ai) {
                settings.ai = {
                    ...(ConfigService.getConfigValue('ai') || {}),
                    ...settings.ai,
                    enable: Boolean(settings.ai.enable),
                    baseUrl: typeof settings.ai.baseUrl === 'string' && settings.ai.baseUrl.trim()
                        ? settings.ai.baseUrl.trim().replace(/\/+$/, '')
                        : 'https://api.openai.com/v1',
                    apiKey: typeof settings.ai.apiKey === 'string' ? settings.ai.apiKey.trim() : (settings.ai.apiKey || ''),
                    model: typeof settings.ai.model === 'string' && settings.ai.model.trim() ? settings.ai.model.trim() : 'gpt-4o-mini',
                    mode: typeof settings.ai.mode === 'string' && settings.ai.mode.trim() ? settings.ai.mode.trim() : 'fallback'
                };
            }

            if (settings.pansou) {
                settings.pansou = {
                    ...(ConfigService.getConfigValue('pansou') || {}),
                    ...settings.pansou,
                    baseUrl: typeof settings.pansou.baseUrl === 'string' ? settings.pansou.baseUrl.trim().replace(/\/+$/, '') : '',
                    apiKey: typeof settings.pansou.apiKey === 'string' ? settings.pansou.apiKey.trim() : (settings.pansou.apiKey || ''),
                    timeout: Number(settings.pansou.timeout) || 10000
                };
            }

            SchedulerService.handleScheduleTasks(settings, taskService);
            ConfigService.setConfig(settings);
            Cloud139Service.clearAllInstances();
            await botManager.handleBotStatus(
                settings.telegram?.bot?.botToken,
                settings.telegram?.bot?.chatId,
                settings.telegram?.bot?.enable
            );
            messageUtil.updateConfig();

            if (passwordChanged) {
                await clearAllSessionFiles();
                if (req.session) {
                    req.session.authenticated = false;
                    req.session.destroy(() => {});
                }
                logTaskEvent('[system] 检测到系统密码变更，已清理会话并要求重新登录');
            }

            res.json({ success: true, data: { passwordChanged } });
        } catch (error) {
            logger.error('更新系统设置失败', { error: error.message, stack: error.stack });
            const isValidationError = typeof error?.message === 'string'
                && error.message.includes('Cron 无效');
            res.status(isValidationError ? 400 : 500).json({ success: false, error: error.message });
        }
    });

    // 网络代理与关键外部服务连通性诊断测试
    app.post('/api/settings/test-proxy', async (req, res) => {
        try {
            const { proxyUrl = '' } = req.body || {};
            const cleanProxyUrl = (typeof proxyUrl === 'string' ? proxyUrl.trim() : '');
            let agent = undefined;
            if (cleanProxyUrl) {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                agent = { https: new HttpsProxyAgent(cleanProxyUrl) };
            }

            const TEST_TARGETS = [
                { service: 'api.themoviedb.org', url: 'https://api.themoviedb.org/3/configuration' },
                { service: 'api.tmdb.org', url: 'https://api.tmdb.org' },
                { service: 'www.themoviedb.org', url: 'https://www.themoviedb.org' },
                { service: 'image.tmdb.org', url: 'https://image.tmdb.org' },
                { service: 'api.thetvdb.com', url: 'https://api.thetvdb.com' },
                { service: 'webservice.fanart.tv', url: 'https://webservice.fanart.tv' },
                { service: 'api.telegram.org', url: 'https://api.telegram.org' },
                { service: 'telegram.me', url: 'https://telegram.me' },
                { service: 'github.com', url: 'https://github.com' }
            ];

            const results = await Promise.all(TEST_TARGETS.map(async (target) => {
                const t0 = Date.now();
                try {
                    const got = require('got');
                    await got.get(target.url, {
                        timeout: { request: 5000 },
                        agent,
                        throwHttpErrors: false,
                        retry: 0
                    });
                    const latency = Date.now() - t0;
                    return {
                        service: target.service,
                        status: 'OK',
                        latency,
                        remark: '连通'
                    };
                } catch (err) {
                    const latency = Date.now() - t0;
                    return {
                        service: target.service,
                        status: 'FAIL',
                        latency,
                        remark: err.code === 'ETIMEDOUT' ? '超时' : (err.message || '连接失败')
                    };
                }
            }));

            const successful = results.filter(r => r.status === 'OK');
            const totalLatency = successful.reduce((sum, r) => sum + r.latency, 0);
            const avgLatency = successful.length > 0 ? Math.round(totalLatency / successful.length) : null;

            res.json({
                success: true,
                data: {
                    mode: cleanProxyUrl ? 'proxy' : 'direct',
                    proxyUrl: cleanProxyUrl || '直连模式',
                    source: 'request',
                    total: results.length,
                    successCount: successful.length,
                    avgLatency,
                    items: results
                }
            });
        } catch (error) {
            logger.error('测试代理连通性异常', { error: error.message });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 主机器人连通性与发送测试消息
    app.post('/api/settings/test-telegram', async (req, res) => {
        try {
            const { botToken = '', chatId = '', proxyUrl = '' } = req.body || {};
            const token = botToken || ConfigService.getConfigValue('telegram.bot.botToken') || ConfigService.getConfigValue('telegram.botToken');
            const chat = chatId || ConfigService.getConfigValue('telegram.bot.chatId') || ConfigService.getConfigValue('telegram.chatId');
            if (!token || !chat) {
                return res.status(400).json({ success: false, error: '请先填写 Bot Token 与 TG 用户 ID！' });
            }
            let agent = undefined;
            const pUrl = (typeof proxyUrl === 'string' && proxyUrl.trim()) ? proxyUrl.trim() : (ProxyUtil.getProxy('telegram'));
            if (pUrl) {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                agent = { https: new HttpsProxyAgent(pUrl) };
            }
            const got = require('got');
            await got.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                json: {
                    chat_id: chat,
                    text: '[系统通知] 139移动云盘自动追更系统：主机器人测试消息已成功送达！网络与机器人配置正常。',
                    parse_mode: 'Markdown'
                },
                timeout: { request: 8000 },
                agent
            }).json();
            res.json({ success: true, message: '测试消息发送成功！请检查你的 Telegram 聊天窗口。' });
        } catch (err) {
            logger.error('测试 Telegram 机器人失败', { error: err.message });
            res.status(500).json({ success: false, error: `发送测试消息失败: ${err.message}` });
        }
    });

    // TMDB API 与网络连通性测试
    app.post('/api/settings/test-tmdb', async (req, res) => {
        try {
            const { apiKey, apiBaseUrl, proxy } = req.body || {};
            const cred = (typeof apiKey === 'string' && apiKey.trim())
                ? apiKey.trim()
                : ConfigService.getConfigValue('tmdb.tmdbApiKey');
            if (!cred) {
                return res.status(400).json({ success: false, error: '请先填写 TMDB API Key 或 Read Access Token' });
            }
            const t0 = Date.now();
            const { TMDBService } = require('../services/tmdb');
            await TMDBService.testCredential(cred, { apiBaseUrl, proxy });
            const latency = Date.now() - t0;
            res.json({ success: true, latency, message: `TMDB 连通测试成功 (${latency}ms)` });
        } catch (error) {
            logger.warn(`[TMDB测试] 失败: ${error.message}`);
            res.status(400).json({ success: false, error: error.message || 'TMDB 连接失败' });
        }
    });

    app.post('/api/settings/media', async (req, res) => {
        const settings = req.body;
        logger.debug('收到媒体设置保存请求', {
            cloudSaver: settings?.cloudSaver ? {
                baseUrl: settings.cloudSaver.baseUrl || '',
                username: settings.cloudSaver.username || '',
                hasPassword: Boolean(settings.cloudSaver.password),
            } : undefined,
            alist: settings?.alist ? {
                enable: Boolean(settings.alist.enable),
                baseUrl: settings.alist.baseUrl || '',
                hasApiKey: Boolean(settings.alist.apiKey),
                strmMountPath: settings.alist.strmMountPath || '',
            } : undefined,
            emby: settings?.emby ? {
                enable: Boolean(settings.emby.enable),
                serverUrl: settings.emby.serverUrl || '',
                hasApiKey: Boolean(settings.emby.apiKey),
                libraryPath: settings.emby.libraryPath || '',
            } : undefined,
            webhook: settings?.webhook ? {
                outboundEnable: Boolean(settings.webhook.outboundEnable),
                outboundUrl: settings.webhook.outboundUrl || '',
                hasOutboundToken: Boolean(settings.webhook.outboundToken),
                inboundEnable: Boolean(settings.webhook.inboundEnable),
                hasInboundToken: Boolean(settings.webhook.inboundToken),
                embyMountPrefix: settings.webhook.embyMountPrefix || '',
            } : undefined,
            strm: settings?.strm,
            tmdb: settings?.tmdb ? {
                hasApiKey: Boolean(settings.tmdb.tmdbApiKey),
                movieRenameFormat: settings.tmdb.movieRenameFormat || '',
                tvRenameFormat: settings.tmdb.tvRenameFormat || '',
            } : undefined,
        });
        ConfigService.setConfig(settings);
        logger.debug('媒体设置保存完成');
        res.json({ success: true, data: null });
    });

    app.get('/api/version', (req, res) => {
        res.json({ version: currentVersion });
    });

    app.get('/api/system/version', (req, res) => {
        res.json({ 
            success: true,
            version: currentVersion,
            platform: '移动云盘 (139) 专用版',
            timestamp: new Date().toISOString()
        });
    });

    app.get('/api/system/capabilities', async (req, res) => {
        try {
            res.json({
                success: true,
                data: {
                    mode: 'cloud139',
                    features: {
                        recycle: false,
                        cloud139: true,
                        cloud189: false
                    },
                    platform: '移动云盘(139)'
                }
            });
        } catch (error) {
            res.json({ 
                success: false, 
                error: error.message 
            });
        }
    });
    
    app.get('/api/system/scheduler/status', async (req, res) => {
        try {
            const jobs = [];
            for (const [key, job] of SchedulerService.taskJobs.entries()) {
                const task = await taskRepo.findOne({ where: { id: key } });
                jobs.push({
                    id: key,
                    taskName: task ? `${task.resourceName}${task.shareFolderName ? '/' + task.shareFolderName : ''}` : '系统任务',
                    cronExpression: task ? task.cronExpression : '未知',
                    enableCron: task ? task.enableCron : true,
                    status: 'running'
                });
            }
            
            res.json({
                success: true,
                data: {
                    totalJobs: jobs.length,
                    jobs: jobs
                }
            });
        } catch (error) {
            res.json({
                success: false,
                error: error.message
            });
        }
    });

    app.post('/api/share/parse', async (req, res) => {
        try {
            const shareLink = req.body.shareLink;
            const accountId = req.body.accountId;
            const accessCode = req.body.accessCode;
            const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
            ensureCloud139Account(account, '分享链接解析');
            const shareFolders = await taskService.parseShareFolderByShareLink(shareLink, accountId, accessCode);
            res.json({ success: true, data: shareFolders });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/saveFavorites', async (req, res) => {
        try {
            const favorites = req.body.favorites;
            const accountId = req.body.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            await commonFolderRepo.delete({ accountId: accountId });
            const commonFolders = favorites.map((favorite) => ({
                accountId: accountId,
                name: favorite.name,
                path: favorite.path,
                id: favorite.id,
            }));
            if (commonFolders.length == 0) {
                res.json({ success: true, data: [] });
                return;
            }
            const result = await commonFolderRepo.save(commonFolders);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/favorites/:accountId', async (req, res) => {
        try {
            const accountId = parseInt(req.params.accountId);
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const favorites = await commonFolderRepo.find({
                where: { accountId: accountId },
                order: { id: 'ASC' },
            });
            res.json({ success: true, data: favorites });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/favorites/add', async (req, res) => {
        try {
            const { accountId, id, name, path } = req.body;
            if (!accountId || !id) throw new Error('参数不完整');
            const existing = await commonFolderRepo.findOne({ where: { accountId: parseInt(accountId), id } });
            if (existing) return res.json({ success: true, data: existing });
            const folder = await commonFolderRepo.save({ accountId: parseInt(accountId), id, name: name || id, path: path || id });
            res.json({ success: true, data: folder });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/favorites/:accountId/:folderId', async (req, res) => {
        try {
            const { accountId, folderId } = req.params;
            if (!accountId || !folderId) throw new Error('参数不完整');
            await commonFolderRepo.delete({ accountId: parseInt(accountId), id: folderId });
            res.json({ success: true });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/custom-push/test', async (req, res) => {
        try {
            const configTest = req.body;
            if (await new CustomPushService([]).testPush(configTest)) {
                res.json({ success: true, data: null });
            } else {
                res.json({ success: false, error: '推送测试失败' });
            }
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ─── 云盘存储维护与违规自愈接口 ───────────────────────────────────────────────
    app.post('/api/maintenance/banned/scan', async (req, res) => {
        const { MaintenanceJobService } = require('../services/MaintenanceJobService');
        const startTime = Date.now();
        let job = null;
        try {
            const { accountId, rootCatalogId, scope, customExtensions, excludePaths, ignoredIds } = req.body || {};
            job = await MaintenanceJobService.createJob({
                type: 'banned_scan',
                triggerType: 'manual',
                title: '手动违规死链巡检',
                folderPath: rootCatalogId || '/',
                summary: '正在深度排查网盘违规与失效死链...'
            });

            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '违规文件检测');
            const cloud139 = Cloud139Service.getInstance(account);
            const { CloudMaintenanceService } = require('../services/CloudMaintenanceService');
            const result = await CloudMaintenanceService.scanBannedFiles(cloud139, {
                rootCatalogId: rootCatalogId || '/',
                scope,
                customExtensions,
                excludePaths,
                ignoredIds
            });

            const summary = result.bannedCount === 0
                ? `排查 ${result.scannedFolders} 目录、${result.totalFiles} 文件，未发现违规死链 (耗时 ${(result.durationMs / 1000).toFixed(1)}s)`
                : `发现违规死链 ${result.bannedCount} 项 (${result.totalBannedSizeFormatted})，排查 ${result.scannedFolders} 目录 (耗时 ${(result.durationMs / 1000).toFixed(1)}s)`;

            if (job) {
                await MaintenanceJobService.completeJob(job.id, {
                    summary,
                    durationMs: result.durationMs,
                    scannedFolders: result.scannedFolders,
                    totalFiles: result.totalFiles,
                    bannedCount: result.bannedCount,
                    freedFormatted: result.totalBannedSizeFormatted,
                    findings: result.bannedFiles
                });
            }

            res.json({ success: true, data: { ...result, jobId: job?.id } });
        } catch (error) {
            if (job) {
                await MaintenanceJobService.failJob(job.id, error, Date.now() - startTime);
            }
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/banned/clean', async (req, res) => {
        const { MaintenanceJobService } = require('../services/MaintenanceJobService');
        const startTime = Date.now();
        let job = null;
        try {
            const { accountId, bannedFiles, action, quarantinePath, cascadeCompanion, notifyEmby, pruneEmptyParent, scanJobId } = req.body || {};
            const actionTitle = action === 'quarantine' ? '违规文件隔离暂存' : '违规文件移入回收站';
            job = await MaintenanceJobService.createJob({
                type: 'banned_clean',
                triggerType: 'manual',
                title: actionTitle,
                summary: `正在处置 ${bannedFiles?.length || 0} 个违规文件...`
            });

            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '违规文件处置');
            const cloud139 = Cloud139Service.getInstance(account);
            const { CloudMaintenanceService } = require('../services/CloudMaintenanceService');
            const result = await CloudMaintenanceService.cleanBannedFiles(cloud139, bannedFiles || [], {
                action,
                quarantinePath,
                cascadeCompanion,
                notifyEmby,
                pruneEmptyParent
            });

            const durationMs = result.durationMs || (Date.now() - startTime);
            const summary = `成功处置 ${result.cleanedCount} 个文件，释放空间 ${result.freedSizeFormatted} (耗时 ${(durationMs / 1000).toFixed(1)}s)`;
            if (job) {
                await MaintenanceJobService.completeJob(job.id, {
                    status: 'cleaned',
                    summary,
                    durationMs,
                    cleanedCount: result.cleanedCount,
                    freedFormatted: result.freedSizeFormatted,
                    cleanedDetails: result.details
                });
            }

            if (result.cleanedCount > 0) {
                const stillThereIds = new Set((result.stillThere || []).map(x => String(x.id)));
                const cleanedFileIds = (bannedFiles || [])
                    .map(f => String(f.id))
                    .filter(id => !stillThereIds.has(id));

                await MaintenanceJobService.recordBannedFilesCleaned({
                    cleanedIds: cleanedFileIds,
                    scanJobId,
                    action,
                    quarantinePath,
                    freedFormatted: result.freedSizeFormatted
                });
            }

            res.json({ success: true, data: { ...result, jobId: job?.id } });
        } catch (error) {
            if (job) {
                await MaintenanceJobService.failJob(job.id, error, Date.now() - startTime);
            }
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/empty/sweep', async (req, res) => {
        const { MaintenanceJobService } = require('../services/MaintenanceJobService');
        const startTime = Date.now();
        let job = null;
        try {
            const { accountId, rootCatalogId, protectedPaths, cleanJunk } = req.body || {};
            job = await MaintenanceJobService.createJob({
                type: 'empty_prune',
                triggerType: 'manual',
                title: '安全修剪空目录',
                folderPath: rootCatalogId || '/',
                summary: '正在自底向上递归扫描并修剪空目录...'
            });

            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '空目录修剪');
            const cloud139 = Cloud139Service.getInstance(account);
            const { CloudMaintenanceService } = require('../services/CloudMaintenanceService');
            const result = await CloudMaintenanceService.sweepEmptyFolders(cloud139, {
                rootCatalogId: rootCatalogId || '/',
                protectedPaths: protectedPaths || ['/媒体库'],
                cleanJunk: cleanJunk !== false
            });

            const summary = `安全修剪 ${result.sweptCount} 个纯空目录 (耗时 ${(result.durationMs / 1000).toFixed(1)}s)`;
            if (job) {
                await MaintenanceJobService.completeJob(job.id, {
                    summary,
                    durationMs: result.durationMs,
                    cleanedCount: result.sweptCount,
                    cleanedDetails: result.deletedDirs
                });
            }

            res.json({ success: true, data: { ...result, jobId: job?.id } });
        } catch (error) {
            if (job) {
                await MaintenanceJobService.failJob(job.id, error, Date.now() - startTime);
            }
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── 维护作业流水审计接口 (对齐图二：扫描一次记录一次) ───────────────────────────
    app.get('/api/maintenance/jobs', async (req, res) => {
        try {
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            const result = await MaintenanceJobService.listJobs(req.query);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/maintenance/jobs/:id', async (req, res) => {
        try {
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            const job = await MaintenanceJobService.getJobById(req.params.id);
            if (!job) {
                return res.status(404).json({ success: false, error: '作业记录不存在' });
            }
            res.json({ success: true, data: job });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/maintenance/jobs', async (req, res) => {
        try {
            const { type } = req.query || {};
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            if (type) {
                const { getMaintenanceJobRepository } = require('../database');
                const repo = getMaintenanceJobRepository();
                await repo.delete({ type });
            } else {
                await MaintenanceJobService.clearJobs();
            }
            res.json({ success: true, message: '已清空作业记录' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/maintenance/jobs/:id', async (req, res) => {
        try {
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            await MaintenanceJobService.deleteJob(req.params.id);
            res.json({ success: true, message: '已删除指定维护作业记录' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/maintenance/episodes/missing/cache', async (req, res) => {
        try {
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            EpisodeInspectionService.clearScanResults();
            res.json({ success: true, message: '已成功清空缺集巡检实时结果与缓存' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/maintenance/episodes/missing/status', async (req, res) => {
        try {
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const status = EpisodeInspectionService.getScanStatus();
            res.json({ success: true, data: status });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/scan', async (req, res) => {
        try {
            const { accountId, rootCatalogId, excludeUnreleased, ignoreSeasonZero, onlyEnded, sync } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '剧集缺集检测');
            const cloud139 = Cloud139Service.getInstance(account);
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            
            if (sync === true) {
                const result = await EpisodeInspectionService.inspectDirectory(cloud139, {
                    rootCatalogId: rootCatalogId || '/',
                    excludeUnreleased: excludeUnreleased !== false,
                    ignoreSeasonZero: ignoreSeasonZero !== false,
                    onlyEnded: onlyEnded === true,
                });
                return res.json({ success: true, data: result });
            }

            const jobStatus = EpisodeInspectionService.startAsyncScan(cloud139, {
                rootCatalogId: rootCatalogId || '/',
                excludeUnreleased: excludeUnreleased !== false,
                ignoreSeasonZero: ignoreSeasonZero !== false,
                onlyEnded: onlyEnded === true,
            });
            res.json({ success: true, data: jobStatus });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/search-tmdb', async (req, res) => {
        try {
            const { title, year, mediaType = 'tv' } = req.body || {};
            if (!title) {
                return res.status(400).json({ success: false, error: '请输入搜索标题' });
            }
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const cleanTitle = RecognitionEngine.sanitizeMediaTitle(title) || title;
            const extractedYear = year || RecognitionEngine.extractYear(title) || '';
            const candidates = await EpisodeInspectionService.tmdbService.searchCandidates(cleanTitle, {
                year: extractedYear,
                mediaType: mediaType || 'tv'
            });
            res.json({ success: true, data: candidates });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/match-tmdb', async (req, res) => {
        try {
            const { accountId, folderPath, folderId, tmdbId, season, applyToAllSeasons = true, excludeUnreleased, ignoreSeasonZero, onlyEnded } = req.body || {};
            if (!folderPath) {
                return res.status(400).json({ success: false, error: '未提供剧集文件夹路径' });
            }
            if (!tmdbId) {
                return res.status(400).json({ success: false, error: '请输入有效的 TMDB ID' });
            }
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '剧集TMDB修正');
            const cloud139 = Cloud139Service.getInstance(account);
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');

            // 默认应用至整部剧（更新所有季并在矩阵视图中整体聚合）
            if (applyToAllSeasons !== false) {
                const updatedShow = await EpisodeInspectionService.recheckShow(cloud139, {
                    folderPath,
                    folderId,
                    tmdbId: String(tmdbId).trim(),
                    excludeUnreleased: excludeUnreleased !== false,
                    ignoreSeasonZero: ignoreSeasonZero !== false,
                    onlyEnded: onlyEnded === true,
                });
                return res.json({ success: true, data: updatedShow, appliedToAll: true });
            }

            // 单季独立修正
            const result = await EpisodeInspectionService.inspectSingleShowWithTmdb(cloud139, {
                folderPath,
                tmdbId: String(tmdbId).trim(),
                season: Number(season || 1),
                excludeUnreleased: excludeUnreleased !== false,
                ignoreSeasonZero: ignoreSeasonZero !== false,
                onlyEnded: onlyEnded === true,
            });
            res.json({ success: true, data: result, appliedToAll: false });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/recheck', async (req, res) => {
        try {
            const { accountId, folderPath, tmdbId, excludeUnreleased, ignoreSeasonZero, onlyEnded } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '剧集单剧复检');
            const cloud139 = Cloud139Service.getInstance(account);
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const result = await EpisodeInspectionService.recheckShow(cloud139, {
                folderPath,
                tmdbId,
                excludeUnreleased: excludeUnreleased !== false,
                ignoreSeasonZero: ignoreSeasonZero !== false,
                onlyEnded: onlyEnded === true,
            });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/clear', async (req, res) => {
        try {
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            EpisodeInspectionService.clearScanResults();
            res.json({ success: true, message: '已清空缺集巡检结果与缓存' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/remove-show', async (req, res) => {
        try {
            const { showKey, folderPath, tmdbId } = req.body || {};
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const result = EpisodeInspectionService.removeShow({ showKey, folderPath, tmdbId });
            res.json(result);
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/delete-targets', async (req, res) => {
        try {
            const { accountId, targets } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '缺集目录清理');
            const cloud139 = Cloud139Service.getInstance(account);
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const result = await EpisodeInspectionService.deleteMissingTargets(cloud139, targets);
            res.json(result);
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/assets/dedup/scan', async (req, res) => {
        try {
            const { files, policy, accountId, rootCatalogId } = req.body || {};
            const { AssetDeduplicationService } = require('../services/AssetDeduplicationService');
            let targetFiles = files;
            if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
                let account;
                if (accountId) {
                    account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
                } else {
                    account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                              (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
                }
                ensureCloud139Account(account, '资产去重扫描');
                const cloud139 = Cloud139Service.getInstance(account);
                targetFiles = await AssetDeduplicationService.scanCloudFiles(cloud139, { rootCatalogId: rootCatalogId || '/' });
            }
            const userPolicy = policy || ConfigService.getConfigValue('policy') || {};
            const plan = AssetDeduplicationService.analyzeDuplicates(targetFiles || [], userPolicy);
            res.json({ success: true, data: plan });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/assets/dedup/prune', async (req, res) => {
        try {
            const { accountId, plan, dryRun, protectedPaths } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '资产去重清理');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetDeduplicationService } = require('../services/AssetDeduplicationService');
            const transferredFileRepo = AppDataSource.isInitialized ? AppDataSource.getRepository('TransferredFile') : null;
            const result = await AssetDeduplicationService.executePrune(cloud139, plan, {
                dryRun: dryRun === true,
                protectedPaths: protectedPaths || [],
                transferredFileRepo
            });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── 媒体服务器与 Webhook 联动接口 (支持神医助手与 Emby 官方 deep_delete 深度删除) ───
    app.post('/api/webhook/emby', async (req, res) => {
        try {
            const { webhookService } = require('../services/WebhookService');
            const result = await webhookService.handleInboundEmbyWebhook(req, {
                taskRepo,
                accountRepo,
                taskService
            });
            res.status(result.statusCode).json(result.body);
        } catch (error) {
            logger.error('处理 Emby / 神医助手 Webhook 路由异常', { error: error.message, stack: error.stack });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/webhook/test-outbound', async (req, res) => {
        try {
            const { webhookService } = require('../services/WebhookService');
            const { url, token, format } = req.body || {};
            const result = await webhookService.testOutbound({ url, token, format });
            res.json(result);
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── 影视刮削与规范整理接口 ──────────────────────────────────────────────────
    app.get('/api/scrape/rules', async (req, res) => {
        try {
            const scrapeConfig = ConfigService.getConfigValue('scrape') || {
                enabled: false,
                cron: '0 4 * * *',
                minScore: 280,
                rules: []
            };
            res.json({ success: true, data: scrapeConfig });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/rules', async (req, res) => {
        try {
            const { rules, enabled, cron, minScore } = req.body || {};

            if (Array.isArray(rules)) {
                for (const rule of rules) {
                    if (!rule.name) {
                        return res.status(400).json({ success: false, error: '规则名称不能为空' });
                    }
                    const sRef = String(rule.sourceDirRef || '').trim();
                    const tRef = String(rule.targetDirRef || '').trim();
                    if (sRef && tRef && sRef === tRef) {
                        return res.status(400).json({ success: false, error: `规则 [${rule.name}] 的源目录与目标目录不能相同` });
                    }
                    const sPath = String(rule.sourceDirPath || '').replace(/\/+$/, '').trim();
                    const tPath = String(rule.targetDirPath || '').replace(/\/+$/, '').trim();
                    if (sPath && tPath) {
                        if (sPath === tPath) {
                            return res.status(400).json({ success: false, error: `规则 [${rule.name}] 的源目录与目标目录路径不能相同` });
                        }
                        if (tPath.startsWith(sPath + '/')) {
                            return res.status(400).json({ success: false, error: `规则 [${rule.name}] 的目标目录不能位于源目录内部` });
                        }
                    }
                }
            }

            const current = ConfigService.getConfigValue('scrape') || {};
            const updated = {
                ...current,
                ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
                ...(cron !== undefined ? { cron: String(cron) } : {}),
                ...(minScore !== undefined ? { minScore: Number(minScore) } : {}),
                ...(rules !== undefined ? { rules } : {})
            };

            await ConfigService.setConfigValue('scrape', updated);
            res.json({ success: true, data: updated });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/plan', async (req, res) => {
        try {
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            let { rule, ruleId } = req.body || {};
            if (!rule && ruleId) {
                const rules = ConfigService.getConfigValue('scrape.rules') || [];
                rule = rules.find(r => r.id === ruleId);
            }
            if (!rule) {
                return res.status(400).json({ success: false, error: '未提供有效的刮削规则' });
            }
            const plan = await MediaScrapeService.planRule(rule);
            res.json({ success: true, data: plan });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/apply', async (req, res) => {
        try {
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const { plan } = req.body || {};
            if (!plan || !plan.rule || !plan.operations) {
                return res.status(400).json({ success: false, error: '整理计划对象无效' });
            }
            const result = await MediaScrapeService.executePlan(plan);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/scrape/journal', async (req, res) => {
        try {
            const { ScrapeBatch, ScrapeRecord } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库尚未初始化' });
            }
            const batchRepo = AppDataSource.getRepository(ScrapeBatch);
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            const { batchId, limit = 20 } = req.query;

            let batches = [];
            let records = [];

            if (batchId) {
                batches = await batchRepo.find({ where: { id: Number(batchId) } });
                records = await recordRepo.find({
                    where: { batchId: Number(batchId) },
                    order: { id: 'DESC' }
                });
            } else {
                batches = await batchRepo.find({
                    order: { id: 'DESC' },
                    take: Math.min(Number(limit) || 20, 100)
                });
                records = await recordRepo.find({
                    order: { id: 'DESC' },
                    take: 50
                });
            }

            res.json({ success: true, data: { batches, records } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/revert/:batchId', async (req, res) => {
        try {
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const batchId = Number(req.params.batchId);
            if (!batchId) {
                return res.status(400).json({ success: false, error: 'batchId 无效' });
            }
            const batch = await ScrapeJournalService.batchRepo.findOne({ where: { id: batchId } });
            if (!batch) {
                return res.status(404).json({ success: false, error: `未找到批次 #${batchId}` });
            }
            const adapter = await MediaScrapeService.getAdapter({
                driveType: batch.driveType,
                accountId: batch.accountId
            });
            const result = await ScrapeJournalService.revertBatch(batchId, adapter);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/record/revert/:recordId', async (req, res) => {
        try {
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const recordId = Number(req.params.recordId);
            if (!recordId) {
                return res.status(400).json({ success: false, error: 'recordId 无效' });
            }
            const record = await ScrapeJournalService.recordRepo.findOne({ where: { id: recordId } });
            if (!record) {
                return res.status(404).json({ success: false, error: `未找到记录 #${recordId}` });
            }
            const adapter = await MediaScrapeService.getAdapter({
                driveType: record.driveType,
                accountId: record.accountId
            });
            const result = await ScrapeJournalService.revertRecord(recordId, adapter);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/binding/resolve', async (req, res) => {
        try {
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { driveType, accountId, folderKey, tmdbId, mediaType, seasonOverride, episodeOffset, action } = req.body || {};
            if (!folderKey) {
                return res.status(400).json({ success: false, error: 'folderKey 不能为空' });
            }
            const binding = await ScrapeJournalService.saveBinding({
                driveType: driveType || 'cloud139',
                accountId: Number(accountId || 0),
                folderKey,
                tmdbId: String(tmdbId || ''),
                mediaType: mediaType || 'tv',
                seasonOverride: seasonOverride !== undefined ? Number(seasonOverride) : null,
                episodeOffset: Number(episodeOffset || 0),
                action: action || 'bind'
            });
            res.json({ success: true, data: binding });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/scrape/inbox', async (req, res) => {
        try {
            const { ScrapeRecord } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库尚未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            const pendingRecords = await recordRepo.find({
                where: { status: 'pending_review' },
                order: { id: 'DESC' },
                take: 100
            });
            res.json({ success: true, data: pendingRecords });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/search-candidates', async (req, res) => {
        try {
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const { title, year, mediaType } = req.body || {};
            if (!title) {
                return res.status(400).json({ success: false, error: '标题不能为空' });
            }
            const cleanTitle = RecognitionEngine.sanitizeMediaTitle(title) || title;
            const extractedYear = year || RecognitionEngine.extractYear(title) || '';
            const candidates = await MediaScrapeService.tmdbService.searchCandidates(
                cleanTitle,
                extractedYear,
                mediaType || 'multi'
            );
            res.json({ success: true, data: candidates });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/scrape/run-scheduled', async (req, res) => {
        try {
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            MediaScrapeService.runScheduledRules().catch(err => {
                logger.error(`[影视刮削] 手动立即巡检异常: ${err.message}`);
            });
            res.json({ success: true, message: '已触发后台全规则增量巡检' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 影视归档全景大盘数据接口
    app.get('/api/scrape/overview', async (req, res) => {
        try {
            const { ScrapeRecord, ScrapeBatch } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库尚未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            const batchRepo = AppDataSource.getRepository(ScrapeBatch);

            const appliedCount = await recordRepo.count({ where: { status: 'applied' } });
            const pendingCount = await recordRepo.count({ where: { status: 'pending_review' } });
            const revertedCount = await recordRepo.count({ where: { status: 'reverted' } });
            const totalBatches = await batchRepo.count();

            const recentRecords = await recordRepo.find({
                where: { status: 'applied' },
                order: { appliedAt: 'DESC', id: 'DESC' },
                take: 36
            });

            res.json({
                success: true,
                data: {
                    stats: {
                        appliedCount,
                        pendingCount,
                        revertedCount,
                        totalBatches
                    },
                    recentRecords
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==========================================
    // 工业级 TMDB 整理核心 API 组 (/api/tmdb-organize/*)
    // ==========================================

    // 1. 扫描源目录并聚类为影视分组
    app.post('/api/tmdb-organize/scan', async (req, res) => {
        try {
            const { folderId, accountId } = req.body || {};
            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });
            const cloud139 = Cloud139Service.getInstance(account);
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');
            const files = await TmdbOrganizeService.scanDirectory(folderId || '/', {
                modeConfig: { cloud139 }
            });
            const groups = TmdbOrganizeService.clusterFiles(files);
            res.json({ success: true, data: { groups, files, sourceFolders: files.sourceFolders || [] } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 2. 在线刮削与整理计划预演 (含熔断保护与自愈容错推演，0 物理写入)
    app.post('/api/tmdb-organize/preview', async (req, res) => {
        try {
            let { groups, settings } = req.body || {};
            if (!groups || !Array.isArray(groups)) {
                return res.status(400).json({ success: false, error: '缺少待整理的分组列表' });
            }
            const { TMDBService } = require('../services/tmdb');
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');

            // 健壮性自愈：若传入的是未经聚类的扁平文件列表，先聚类为结构化影视组
            if (groups.length > 0 && !Array.isArray(groups[0].files)) {
                groups = TmdbOrganizeService.clusterFiles(groups);
            }

            const tmdbClient = new TMDBService();
            if (tmdbClient.apiKey) {
                try {
                    await TmdbOrganizeService.scrapeGroups(groups, tmdbClient);
                } catch (scrapeErr) {
                    logger.warn(`[TMDB整理] 在线刮削部分组失败: ${scrapeErr.message}`);
                }
            }

            // 若开启了媒体硬元数据嗅探，对分组代表文件执行流探测
            if (settings?.enableMediaInfo !== false) {
                try {
                    const accountRepo = AppDataSource.getRepository(Account);
                    const account = (settings?.accountId ? await accountRepo.findOne({ where: { id: Number(settings.accountId), accountType: 'cloud139' } }) : null)
                        || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }));
                    if (account) {
                        const cloud139 = Cloud139Service.getInstance(account);
                        const { MediaProbeService } = require('../services/MediaProbeService');
                        for (const group of groups) {
                            try {
                                await MediaProbeService.probeGroupFiles(group, cloud139);
                            } catch (_) {}
                        }
                    }
                } catch (probeErr) {
                    logger.debug(`[TMDB整理] 预演媒体嗅探跳过: ${probeErr.message}`);
                }
            }

            const preview = TmdbOrganizeService.buildPreview(groups, settings || {});
            res.json({ success: true, data: preview });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 2.5 媒体硬元数据单文件/分组快速嗅探接口 (支持 FFprobe 与原生 Range 双引擎)
    app.post('/api/tmdb-organize/probe', async (req, res) => {
        try {
            const { file, fileId, accountId } = req.body || {};
            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }));
            if (!account) {
                return res.status(400).json({ success: false, error: '未找到有效的 139 账号' });
            }
            const cloud139 = Cloud139Service.getInstance(account);
            const { MediaProbeService } = require('../services/MediaProbeService');
            const targetFile = file || { fileId };
            const meta = await MediaProbeService.probeFile(targetFile, cloud139);
            res.json({ success: true, data: meta });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 3. 执行规范整理 (原子两阶段重命名、自底向上搬移、洗版置换与 SQLite 预写日志)
    app.post('/api/tmdb-organize/execute', async (req, res) => {
        try {
            const { snapshot, accountId, options } = req.body || {};
            if (!snapshot || !snapshot.tasks) {
                return res.status(400).json({ success: false, error: '缺少整理计划快照' });
            }
            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });
            const cloud139 = Cloud139Service.getInstance(account);
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');

            const result = await TmdbOrganizeService.execute(snapshot, {
                cloud139,
                accountId: account.id
            }, options || {});

            const movedTasks = (snapshot.tasks || []).filter(t => t.status === 'success').map(t => ({
                fileId: t.fileId,
                originalName: t.oldName,
                finalName: t.newName,
                targetFolderPath: t.targetFolderPath,
                size: t.fileSize,
                tmdbId: t.tmdbId
            }));

            if (movedTasks.length > 0) {
                const EventService = require('../services/eventService');
                EventService.getInstance().emit('taskComplete', {
                    taskId: 'manual-organize',
                    taskName: `手动整理 - 归档 ${movedTasks.length} 部`,
                    sourceMode: 'staging_organize',
                    fileList: movedTasks.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    items: movedTasks.map(f => ({ name: f.finalName, id: f.fileId, size: f.size, targetFolderPath: f.targetFolderPath })),
                    task: {
                        id: 'manual-organize',
                        account,
                        name: `手动整理 - 归档 ${movedTasks.length} 部`,
                        resourceName: '手动整理',
                        realFolderName: movedTasks[0]?.targetFolderPath || '',
                        disableRename: true
                    }
                });
            }

            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 4. 媒体整理历史记录流水看板 (对标 MoviePilot 图 1 流水视图)
    app.get('/api/tmdb-organize/history', async (req, res) => {
        try {
            const { ScrapeRecord, ScrapeBatch } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            const batchRepo = AppDataSource.getRepository(ScrapeBatch);

            const { page = 1, pageSize = 20, status, excludeStatus, search, tab } = req.query;
            const take = Math.min(Number(pageSize) || 20, 100);
            const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

            const qb = recordRepo.createQueryBuilder('r');

            if (tab === 'wash') {
                qb.andWhere('(r.status = :wSkipped OR r.status = :wProtected OR r.reason LIKE :wWash OR r.reason LIKE :wRepl OR r.reason LIKE :wQual OR r.reason LIKE :wElim OR r.reason LIKE :wExempt)', {
                    wSkipped: 'skipped',
                    wProtected: 'protected',
                    wWash: '%洗版%',
                    wRepl: '%置换%',
                    wQual: '%画质%',
                    wElim: '%淘汰%',
                    wExempt: '%豁免%'
                });
            } else {
                // 方案 A (彻底分开): 媒体整理流水专司资产规范入库，默认严格排除洗版淘汰旧版记录 (skipped 仅归属于洗版策略流水)
                qb.andWhere('r.status != :skippedStatus', { skippedStatus: 'skipped' });

                if (status === 'fallback') {
                    qb.andWhere('(r.status = :fbStatus OR r.reason LIKE :fbReason)', {
                        fbStatus: 'fallback',
                        fbReason: '%自愈%'
                    });
                } else if (status && status !== 'all') {
                    qb.andWhere('r.status = :status', { status });
                } else if (excludeStatus) {
                    qb.andWhere('r.status != :excludeStatus', { excludeStatus });
                }
            }

            if (search && String(search).trim()) {
                const s = `%${String(search).trim()}%`;
                qb.andWhere('(r.title LIKE :s OR r.oldName LIKE :s OR r.newName LIKE :s OR r.oldParentPath LIKE :s OR r.newParentPath LIKE :s OR r.tmdbId LIKE :s OR r.reason LIKE :s)', { s });
            }

            qb.orderBy('r.id', 'DESC').take(take).skip(skip);

            const [records, total] = await qb.getManyAndCount();

            const batches = await batchRepo.find({
                order: { id: 'DESC' },
                take: 20
            });

            const { TMDBService } = require('../services/tmdb');
            const tmdbService = new TMDBService();
            const tmdbPosterCache = new Map();

            const enrichedRecords = await Promise.all(records.map(async r => {
                let evidenceObj = null;
                if (r.evidence) {
                    try {
                        evidenceObj = typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence;
                    } catch (_) {}
                }
                let posterPath = evidenceObj?.posterPath || r.posterPath || null;
                if (!posterPath && r.tmdbId && tmdbService.credential) {
                    if (tmdbPosterCache.has(r.tmdbId)) {
                        posterPath = tmdbPosterCache.get(r.tmdbId);
                    } else {
                        try {
                            const details = (r.mediaType === 'movie')
                                ? await tmdbService.getMovieDetails(r.tmdbId)
                                : await tmdbService.getTVDetails(r.tmdbId);
                            posterPath = details?.posterPath || null;
                            tmdbPosterCache.set(r.tmdbId, posterPath);
                        } catch (_) {
                            tmdbPosterCache.set(r.tmdbId, null);
                        }
                    }
                }
                const oldParentPath = r.oldParentPath || evidenceObj?.originalFolder || evidenceObj?.sourcePath || null;
                const sourceText = evidenceObj?.postTitle || null;
                const washDetails = evidenceObj?.washDetails || null;
                return {
                    ...r,
                    oldParentPath,
                    sourceText,
                    washDetails,
                    posterPath,
                    episodeTitle: r.episodeTitle || evidenceObj?.episodeTitle || null
                };
            }));

            const { OrganizeProtectionService } = require('../services/OrganizeProtectionService');
            const cooldownList = (OrganizeProtectionService && typeof OrganizeProtectionService.getCooldownList === 'function')
                ? OrganizeProtectionService.getCooldownList()
                : [];

            res.json({ success: true, data: { records: enrichedRecords, total, batches, page: Number(page) || 1, pageSize: take, cooldownCount: cooldownList.length, cooldownList } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tmdb-organize/history/:id', async (req, res) => {
        try {
            const { ScrapeRecord } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            await recordRepo.delete(Number(req.params.id));
            res.json({ success: true });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/tmdb-organize/history/batch-delete', async (req, res) => {
        try {
            const { ids = [] } = req.body || {};
            const { ScrapeRecord } = require('../entities');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            if (Array.isArray(ids) && ids.length) {
                await recordRepo.delete(ids.map(Number));
            }
            res.json({ success: true });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 4.5 一键清理原地保护/熔断历史记录
    app.post('/api/tmdb-organize/history/clear-protected', async (req, res) => {
        try {
            const { ScrapeRecord } = require('../entities');
            const { OrganizeProtectionService } = require('../services/OrganizeProtectionService');
            if (!AppDataSource.isInitialized) {
                return res.status(500).json({ success: false, error: '数据库未初始化' });
            }
            const recordRepo = AppDataSource.getRepository(ScrapeRecord);
            const deleteRes = await recordRepo.delete({ status: 'protected' });

            // 同步清空内存未识别冷却追踪缓存
            OrganizeProtectionService.clearAll();

            res.json({ success: true, count: deleteRes.affected || 0, message: '已清空所有原地保护记录并重置熔断冷却状态' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 5. 批量/单项整理撤销（后悔药原路原子恢复）
    app.post('/api/tmdb-organize/rollback', async (req, res) => {
        try {
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');
            const { batchId, recordId, accountId } = req.body || {};

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            const adapter = await MediaScrapeService.getAdapter({ driveType: 'cloud139', accountId: account?.id });

            if (batchId) {
                const resData = await ScrapeJournalService.revertBatch(Number(batchId), adapter);
                return res.json({ success: true, data: resData });
            }
            if (recordId) {
                const resData = await ScrapeJournalService.revertRecord(Number(recordId), adapter);
                return res.json({ success: true, data: resData });
            }
            const cloud139 = Cloud139Service.getInstance(account);
            const resData = await TmdbOrganizeService.rollbackLastOrganize({ cloud139 });
            res.json({ success: true, data: resData });
        } catch (error) {
            logger.error(`[TMDB整理] 撤销异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

            // 6. 暂存区无法自动识别/待人工纠偏的文件清单接口（极速轻量化直出）
    app.get('/api/tmdb-organize/unrecognized', async (req, res) => {
        try {
            const { accountId } = req.query || {};
            let folderId = req.query.folderId;
            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const { QuarantineService } = require('../services/QuarantineService');
            const { OrganizeMutex } = require('../services/OrganizeMutex');
            const { ScrapeRecord } = require('../entities');
            const ConfigService = require('../services/ConfigService');

            let stagingFolderName = ConfigService.getConfigValue('channelMonitor.stagingFolderName', '/临时存放');
            if (!stagingFolderName || stagingFolderName === '/暂存区/频道转存') {
                stagingFolderName = '/临时存放';
            }
            let folderType = 'custom';
            const minFileSizeMb = Number(req.query.minFileSizeMb || ConfigService.getConfigValue('channelMonitor.minFileSizeMb', 0));

            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');

            // 1. 若显式传入路径格式（以 / 开头且不是单斜杠），先行解析为真实 catalogID
            if (typeof folderId === 'string' && folderId.startsWith('/') && folderId.length > 1) {
                const resolvedId = await EpisodeInspectionService.resolvePathToCatalogId(cloud139, folderId).catch(() => null);
                if (resolvedId && resolvedId !== '/') {
                    stagingFolderName = folderId;
                    folderId = resolvedId;
                } else {
                    logger.warn(`[TMDB整理] 传入路径 "${folderId}" 未在 139 网盘中找到，安全降级至默认暂存目录`);
                    folderId = null;
                }
            }

            // 2. 特殊标识 'quarantine' 与默认目录：智能解析真实 ID 并缓存，杜绝盲目全盘扫描
            if (folderId === 'quarantine') {
                folderType = 'quarantine';
                stagingFolderName = '/临时存放/__待人工整理__';
                let qId = ConfigService.getConfigValue('channelMonitor.quarantineFolderId', '');
                if (!qId) {
                    let stagingId = ConfigService.getConfigValue('channelMonitor.stagingFolderId', '');
                    if (!stagingId) {
                        stagingId = await EpisodeInspectionService.resolvePathToCatalogId(cloud139, '/临时存放').catch(() => null);
                        if (stagingId && stagingId !== '/') ConfigService.setConfigValue('channelMonitor.stagingFolderId', stagingId);
                    }
                    if (stagingId && stagingId !== '/') {
                        qId = await QuarantineService.ensureQuarantineRoot(cloud139, stagingId).catch(() => null);
                        if (qId) ConfigService.setConfigValue('channelMonitor.quarantineFolderId', qId);
                    }
                }
                folderId = qId || null;
            } else if (!folderId || folderId === 'default' || folderId === '/') {
                folderType = 'staging';
                let stagingId = ConfigService.getConfigValue('channelMonitor.stagingFolderId', '');
                if (!stagingId) {
                    stagingId = await EpisodeInspectionService.resolvePathToCatalogId(cloud139, stagingFolderName).catch(() => null);
                    if (!stagingId) {
                        stagingId = await EpisodeInspectionService.resolvePathToCatalogId(cloud139, '/临时存放').catch(() => null);
                        if (stagingId && stagingId !== '/') {
                            stagingFolderName = '/临时存放';
                        }
                    }
                    if (stagingId && stagingId !== '/') {
                        ConfigService.setConfigValue('channelMonitor.stagingFolderId', stagingId);
                    }
                }
                folderId = (stagingId && stagingId !== '/') ? stagingId : null;
            }

            // 工业级安全门禁：禁止针对网盘根目录 / 进行无节制深度递归全盘扫描！
            if (!folderId || folderId === '/') {
                return res.json({
                    success: true,
                    data: {
                        stagingFolderId: '',
                        stagingFolderName: '请点击上方「整理文件夹」选定待整理目录',
                        folderType: 'none',
                        isLocked: false,
                        lockOwner: '',
                        lockTask: '',
                        unrecognizedFiles: [],
                        allFiles: [],
                        residualFolders: [],
                        totalScanned: 0,
                        totalUnrecognized: 0
                    }
                });
            }

            // 检查当前目录是否正被后台自动整理锁定 (防撞档感知)
            const lockInfo = OrganizeMutex.isLocked(folderId);

            // 1. 扫描目标目录下媒体文件 (纯网盘目录读取，不发起外部在线刮削与AI，45s 安全熔断)
            let files = [];
            try {
                files = await TmdbOrganizeService.scanDirectory(folderId, {
                    modeConfig: { cloud139 },
                    maxDurationMs: 45000,
                    maxDirs: 200
                });
            } catch (scanErr) {
                if (scanErr.notFound || /不存在|已被清理|not found/i.test(scanErr.message)) {
                    logger.info(`[TMDB整理] 暂存目录不存在或已被清理: ${scanErr.message}，返回空文件列表`);
                    files = [];
                } else {
                    logger.warn(`[TMDB整理] 暂存目录扫描异常: ${scanErr.message}`);
                    files = [];
                }
            }

            // 2. 本地快速比对数据库已有的 protected 熔断保护记录
            const scrapeRepo = AppDataSource.getRepository(ScrapeRecord);
            const protectedRecords = await scrapeRepo.find({
                where: { status: 'protected' },
                select: ['fileRef', 'oldName', 'reason'],
                order: { id: 'DESC' },
                take: 1000
            });
            const protectedMap = new Map();
            for (const r of protectedRecords) {
                if (r.fileRef && !protectedMap.has(r.fileRef)) protectedMap.set(r.fileRef, r.reason);
                if (r.oldName && !protectedMap.has(r.oldName)) protectedMap.set(r.oldName, r.reason);
            }

            const mediaFiles = [];
            const allFiles = [];

            for (const f of files) {
                const isVideo = RecognitionEngine.isVideoFile(f.name);
                const isSidecar = RecognitionEngine.isSidecarFile(f.name);
                const isDiscard = RecognitionEngine.isDiscardFile(f.name);

                const parsedSe = RecognitionEngine.parseSeasonEpisode(f.name);
                const tech = RecognitionEngine.inferTechnicalTags(f.name, f.size);
                const isProtected = protectedMap.has(f.id) || protectedMap.has(f.fileId) || protectedMap.has(f.name);
                const protectedReason = protectedMap.get(f.id) || protectedMap.get(f.fileId) || protectedMap.get(f.name) || '';

                // 计算相对目录路径（剥除文件名本身）
                const rel = String(f.relativePath || f.name || '').replace(/\\/g, '/');
                const lastSlash = rel.lastIndexOf('/');
                const folderRelPath = lastSlash !== -1 ? rel.substring(0, lastSlash) : (f.parentFolderName || '');

                // 穿透提取最具代表性的上级影视主目录名称与年份
                let effectiveShowTitle = '';
                let effectiveShowYear = '';
                let pathTmdbId = '';
                const parts = rel.split('/').filter(Boolean);
                for (const seg of parts) {
                    const m = seg.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                    if (m) { pathTmdbId = m[1]; break; }
                }

                for (let p = parts.length - 2; p >= 0; p--) {
                    const seg = parts[p];
                    if (RecognitionEngine.isGenericFolder(seg)) continue;
                    const tmdbFolderMatch = seg.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                    if (tmdbFolderMatch) {
                        pathTmdbId = tmdbFolderMatch[1];
                        effectiveShowTitle = RecognitionEngine.cleanAnimeFolderName(seg);
                        effectiveShowYear = RecognitionEngine.extractYear(seg) || '';
                        break;
                    }

                    const isCollectionFolder = RecognitionEngine.isCollectionFolder(seg);
                    const folderSeasonVal = RecognitionEngine.targetSeasonFromFolder(seg);
                    const isSubSeason = RecognitionEngine.isSubSeasonFolder(seg) || (folderSeasonVal !== null) ||
                        /(?:Season|S|第)\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇]|OVA|OAD|SP|特别篇/i.test(seg) ||
                        /[篇章]\s*$/i.test(seg);

                    if (isSubSeason && !isCollectionFolder && p > 0 && !RecognitionEngine.isGenericFolder(parts[p - 1])) {
                        continue;
                    }

                    if (p > 0 && !RecognitionEngine.isGenericFolder(parts[p - 1])) {
                        const parentSeg = parts[p - 1];
                        const parentHasChinese = /[\u4e00-\u9fa5]/.test(parentSeg);
                        const currentHasChinese = /[\u4e00-\u9fa5]/.test(seg);
                        const parentHasYearOrTmdb = /[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/i.test(parentSeg) || /\b(19\d{2}|20\d{2})\b/.test(parentSeg);
                        const isTechnicalOrPinyinSlug = !currentHasChinese && (
                            /^(?:[a-zA-Z]{1,15}|\d{3,4}[pP]|4[kK]|bdrip|remux|web-?dl|bluray|iso|bdmv|h\.?26[45]|hevc|x26[45]|aac|dts|atmos|sdr|hdr\d*|dv)$/i.test(seg.trim()) ||
                            /^[A-Z0-9_\-\. ]{1,16}$/.test(seg.trim())
                        );

                        if ((!currentHasChinese && (parentHasChinese || parentHasYearOrTmdb)) || isTechnicalOrPinyinSlug) {
                            continue;
                        }
                    }

                    const cleanedSeg = RecognitionEngine.cleanAnimeFolderName(seg);
                    if (cleanedSeg && cleanedSeg.length >= 2 && !/^\d+$/.test(cleanedSeg) && !RecognitionEngine.isGenericFolder(cleanedSeg)) {
                        effectiveShowTitle = cleanedSeg;
                        effectiveShowYear = RecognitionEngine.extractYear(seg) || '';
                        break;
                    }
                }

                const fileCleanStem = RecognitionEngine.sanitizeMediaTitle(f.name) || f.name.replace(/\.[^/.]+$/, '');
                const finalInferredTitle = effectiveShowTitle || fileCleanStem;
                const finalYear = effectiveShowYear || RecognitionEngine.extractYear(f.name) || '';

                const hasExplicitTmdb = Boolean(pathTmdbId) || /\{tmdb-\d+\}/i.test(f.name) || /\{tmdb-\d+\}/i.test(f.relativePath || '');
                const hasExplicitTv = RecognitionEngine.hasExplicitSeasonEpisode(f.name) || /第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季集期话話]/i.test(f.name);
                const isSpecial = Boolean(parsedSe.isSpecial || parsedSe.season === 0 || RecognitionEngine.isSpecialEpisodeHint(f.name));
                const hasEpisode = Boolean(parsedSe.hasEpisode || isSpecial || hasExplicitTv);
                const effSeason = hasEpisode ? (isSpecial ? 0 : ((parsedSe.season !== undefined && parsedSe.season !== null && !isNaN(parsedSe.season)) ? Number(parsedSe.season) : 1)) : null;
                const effEpisode = hasEpisode ? ((parsedSe.episode !== null && parsedSe.episode !== undefined && parsedSe.episode > 0) ? parsedSe.episode : (isSpecial ? 0 : null)) : null;
                const isUnrecognized = !hasExplicitTmdb || isProtected || (hasEpisode && effEpisode === null);

                const item = {
                    id: f.id || f.fileId,
                    fileId: f.fileId || f.id,
                    name: f.name,
                    size: f.size || 0,
                    relativePath: f.relativePath || f.name,
                    folderPath: folderRelPath,
                    parentFolderId: f.parentFileId || '',
                    parentFolderName: f.parentFolderName || '',
                    tmdbId: pathTmdbId || '',
                    posterPath: '',
                    inferredTitle: finalInferredTitle,
                    cleanTitle: finalInferredTitle,
                    year: finalYear,
                    mediaType: (hasEpisode || isSpecial) ? 'tv' : 'movie',
                    season: effSeason,
                    episode: effEpisode,
                    isSpecial,
                    specialKind: parsedSe.specialKind || (isSpecial ? (RecognitionEngine.isSpecialEpisodeHint(f.name)?.label || '特别篇') : ''),
                    isSuspicious: false,
                    tmdbNotFound: !pathTmdbId,
                    isUnrecognized,
                    isProtected,
                    isVideo,
                    isSidecar,
                    issueType: isProtected ? 'protected_unmatched' : (!hasEpisode ? 'unknown_episode' : (!pathTmdbId ? 'unmatched_tmdb' : 'none')),
                    issueReason: protectedReason || (!pathTmdbId ? '未在 TMDB 中匹配到影视条目' : (!hasEpisode ? '剧集无法推导单集编号' : '')),
                    specs: {
                        resolution: tech.resolution || '',
                        dynamicRange: tech.dynamicRange || 'SDR',
                        videoCodec: tech.videoCodec || '',
                        resourceType: tech.resourceType || '',
                        frameRate: tech.frameRate || '',
                        colorDepth: tech.colorDepth || ''
                    }
                };
                allFiles.push(item);
                // 杂质小文件过滤 (单位 MB)
                const isSmallJunk = minFileSizeMb > 0 && isVideo && (f.size || 0) < (minFileSizeMb * 1024 * 1024);
                if ((isVideo || isSidecar) && !isSmallJunk) {
                    mediaFiles.push(item);
                }
            }

            // 识别暂存区残留废弃空目录（仅包含垃圾说明/广告或已完全无视频资产的文件夹）
            const sourceFolders = Array.isArray(files.sourceFolders) ? files.sourceFolders : [];
            const residualFolders = [];
            const stagingPathNorm = ('/' + String(stagingFolderName || '').replace(/^\/+|\/+$/g, '')).toLowerCase();

            for (const sf of sourceFolders) {
                if (!sf || !sf.id || sf.id === folderId) continue;
                const sfPath = ('/' + String(sf.path || '').replace(/^\/+|\/+$/g, '')).toLowerCase();
                const sfName = String(sf.path || '').split('/').filter(Boolean).pop() || '';
                const sfNameLower = sfName.toLowerCase();
                const rel = sfPath.startsWith(stagingPathNorm + '/') ? sfPath.slice(stagingPathNorm.length + 1) : sfPath.replace(/^\/+/, '');
                const depth = rel.split('/').filter(Boolean).length;
                if (sf.depth === 1 || depth === 1) {
                    const hasVideos = mediaFiles.some(m => {
                        if (m.parentFolderId && String(m.parentFolderId) === String(sf.id)) return true;
                        const mPath = ('/' + String(m.relativePath || m.folderPath || '')).toLowerCase();
                        return (sfNameLower && mPath.includes(sfNameLower)) || mPath.startsWith(sfPath + '/') || mPath === sfPath;
                    });
                    if (!hasVideos) {
                        const folderName = sfName || sf.id;
                        residualFolders.push({
                            id: sf.id,
                            name: folderName,
                            path: sf.path || ('/' + folderName)
                        });
                    }
                }
            }

            res.json({
                success: true,
                data: {
                    stagingFolderId: folderId,
                    stagingFolderName,
                    folderType,
                    isLocked: Boolean(lockInfo),
                    lockOwner: lockInfo?.owner || '',
                    lockTask: lockInfo?.taskName || '',
                    unrecognizedFiles: mediaFiles,
                    allFiles,
                    residualFolders,
                    totalScanned: files.length,
                    totalUnrecognized: mediaFiles.filter(f => f.isUnrecognized).length
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 6.1 清理暂存区残留废弃空目录（仅包含垃圾说明/广告或已完全无视频资产的文件夹）
    app.post('/api/tmdb-organize/clean-residual', async (req, res) => {
        try {
            const { accountId, folderIds } = req.body || {};
            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const targetIds = Array.isArray(folderIds) ? folderIds.filter(Boolean) : [];
            if (!targetIds.length) {
                return res.json({ success: true, message: '无需要清理的残留目录', deletedCount: 0 });
            }

            // 直接将残留目录移入 139 回收站（前置安全校验，确保目录内无视频文件）
            const safeToDeleteIds = [];
            for (const fid of targetIds) {
                try {
                    const list = await cloud139.listDiskDirAll(fid);
                    const hasVideos = (list || []).some(f => RecognitionEngine.isVideoFile(f.name));
                    if (hasVideos) {
                        logger.warn(`[TMDB整理] 目录 ${fid} 包含有效视频文件，已触发安全熔断拦截，放弃删除！`);
                        continue;
                    }
                    safeToDeleteIds.push(fid);
                } catch (e) {
                    logger.warn(`[TMDB整理] 检查目录 ${fid} 失败: ${e.message}`);
                }
            }

            if (safeToDeleteIds.length > 0) {
                await cloud139.deleteFiles(safeToDeleteIds);
                logger.info(`[TMDB整理] 用户手动触发清理暂存区残留目录: ${safeToDeleteIds.join(', ')}`);
            }
            res.json({ success: true, message: `已成功将 ${safeToDeleteIds.length} 个残留废弃目录移入回收站！`, deletedCount: safeToDeleteIds.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 6.2 高级手动整理即时预览接口（纯内存推导与缓存读取，耗时严格 < 200ms）
    app.post('/api/tmdb-organize/preview-manual', async (req, res) => {
        try {
            const {
                accountId,
                files = [],
                targetFolderId,
                targetFolderPath,
                mediaType = 'tv',
                mode = 'tmdb',
                tmdbId,
                customTitle,
                customYear,
                customSeason = 1,
                startEpisode = 1,
                episodeStep = 1,
                keepOriginalName = false,
                minFileSizeMb = 0
            } = req.body || {};

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');

            const isMovie = mediaType === 'movie';
            const effTitle = (customTitle || '').trim().replace(/[\\/:*?"<>|]/g, '');
            const effYear = String(customYear || '').trim();
            const effSeason = isMovie ? null : Number(customSeason || 1);
            let defaultTargetRoot = (targetFolderPath && targetFolderPath !== '/' && !targetFolderPath.includes('默认媒体库')) ? targetFolderPath.replace(/\/+$/, '') : '/媒体库';
            if (!defaultTargetRoot.startsWith('/')) defaultTargetRoot = '/' + defaultTargetRoot;

            const category = req.body.category || (isMovie ? '电影' : '国产剧');
            const typeFolder = isMovie ? '电影' : '剧集';
            let catSubPath = `${typeFolder}/${category}`.replace(/\/+/g, '/');
            if (category.startsWith('电影/') || category.startsWith('剧集/')) {
                catSubPath = category;
            }

            const tmdbTag = tmdbId ? ` {tmdb-${tmdbId}}` : '';

            const tasks = [];
            const skippedSmallFiles = [];
            let epCounter = Number(startEpisode || 1);

            for (const f of files) {
                const fSize = Number(f.size || 0);
                if (minFileSizeMb > 0 && fSize < (minFileSizeMb * 1024 * 1024)) {
                    skippedSmallFiles.push({ fileId: f.id || f.fileId, name: f.name, size: fSize });
                    continue;
                }

                const specs = f.specs || (f._probedMeta ? f._probedMeta : RecognitionEngine.inferTechnicalTags(f.name, fSize));
                const ext = (f.name.match(/\.[^/.]+$/) || ['.mkv'])[0];
                const parsedSe = isMovie ? { season: null, episode: null } : RecognitionEngine.parseSeasonEpisode(f.name, effSeason);
                const epNum = (f.episode !== undefined && f.episode !== null) ? Number(f.episode) : (parsedSe.episode || epCounter);

                let targetFileName = f.name;
                let targetDirectory = defaultTargetRoot;

                if (keepOriginalName) {
                    targetFileName = f.name;
                } else if (effTitle) {
                    const specsArr = [specs.resolution, specs.dynamicRange, specs.videoCodec, specs.audioCodec].filter(Boolean);
                    const specsStr = specsArr.length ? `.${specsArr.join('.')}` : '';
                    const yearStr = effYear ? `.${effYear}` : '';

                    if (isMovie) {
                        targetFileName = `${effTitle}${yearStr}${specsStr}${ext}`;
                    } else {
                        const sStr = `S${String(effSeason).padStart(2, '0')}`;
                        const eStr = `E${String(epNum).padStart(2, '0')}`;
                        targetFileName = `${effTitle}${yearStr}.${sStr}${eStr}${specsStr}${ext}`;
                        epCounter += Number(episodeStep || 1);
                    }
                }

                if (effTitle) {
                    const yearInDir = effYear ? ` (${effYear})` : '';
                    if (isMovie) {
                        targetDirectory = `${defaultTargetRoot}/${catSubPath}/${effTitle}${yearInDir}${tmdbTag}`.replace(/\/+/g, '/');
                    } else {
                        const sStr = `Season ${String(effSeason).padStart(2, '0')}`;
                        targetDirectory = `${defaultTargetRoot}/${catSubPath}/${effTitle}${yearInDir}${tmdbTag}/${sStr}`.replace(/\/+/g, '/');
                    }
                }

                tasks.push({
                    fileId: f.id || f.fileId,
                    name: f.name,
                    size: fSize,
                    sourceFileName: f.name,
                    sourcePath: f.relativePath || f.folderPath || f.name,
                    sourceDirectory: f.folderPath || (f.relativePath && f.relativePath.includes('/') ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : '') || '',
                    sourceParentFolderId: f.parentFolderId || '',
                    targetFileName,
                    targetDirectory,
                    targetPath: `${targetDirectory}/${targetFileName}`,
                    transferMode: 'move',
                    washDecision: 'new_asset',
                    mediaType,
                    tmdbId: tmdbId ? String(tmdbId) : null,
                    season: effSeason,
                    episode: isMovie ? null : epNum,
                    title: effTitle,
                    year: effYear
                });
            }

            // 针对未嗅探的文件在后台静默补全嗅探 (不阻塞本次预览响应)
            const unprobed = files.filter(f => !f._probedMeta && !f.specs?.videoFormat);
            if (unprobed.length > 0) {
                const cloud139 = Cloud139Service.getInstance(account);
                const { MediaProbeService } = require('../services/MediaProbeService');
                MediaProbeService.probeFiles(unprobed, cloud139).catch(() => {});
            }

            res.json({
                success: true,
                data: {
                    totalCount: files.length,
                    validCount: tasks.length,
                    skippedCount: skippedSmallFiles.length,
                    skippedSmallFiles,
                    tasks
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 6.3 高级手动整理正式执行接口 (Strict WAL 预写日志与逐项原子移动)
    app.post('/api/tmdb-organize/manual-organize', async (req, res) => {
        try {
            const {
                accountId,
                batchName = '人工工作台高级整理',
                tasks = [],
                options = {}
            } = req.body || {};

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { OrganizeMutex } = require('../services/OrganizeMutex');
            const { StagingOrganizeService } = require('../services/StagingOrganizeService');
            const stagingSvc = new StagingOrganizeService();

            if (!tasks || tasks.length === 0) {
                return res.status(400).json({ success: false, error: '没有需要执行整理的任务清单' });
            }

            // 1. 申请涉及目录的互斥锁
            const involvedDirs = new Set(tasks.map(t => t.targetDirectory).concat(tasks.map(t => t.sourceDirectory)).filter(Boolean));
            for (const d of involvedDirs) {
                OrganizeMutex.acquire(d, 'manual_organize', batchName);
            }

            // 2. Strict WAL: 创建批次并将所有任务以 status = 'PENDING' 预写入 SQLite
            const batch = await ScrapeJournalService.createBatch({
                driveType: 'cloud139',
                accountId: account.id,
                rootRef: '/',
                rootPath: '/',
                targetRootRef: '',
                targetRootPath: tasks[0]?.targetDirectory || '/媒体库',
                trigger: 'manual',
                organize: true
            });

            const operations = tasks.map(t => ({
                driveType: 'cloud139',
                accountId: account.id,
                kind: 'video',
                fileRef: String(t.fileId),
                oldName: t.sourceFileName || t.name,
                newName: t.targetFileName,
                oldParentRef: String(t.sourceParentFolderId || ''),
                oldParentPath: t.sourceDirectory || (t.sourcePath && t.sourcePath.includes('/') ? t.sourcePath.slice(0, t.sourcePath.lastIndexOf('/')) : '') || '',
                newParentRef: '',
                newParentPath: t.targetDirectory,
                newRef: String(t.fileId),
                size: t.size || 0,
                mediaType: t.mediaType || 'tv',
                tmdbId: t.tmdbId ? String(t.tmdbId) : null,
                season: t.season !== undefined && t.season !== null ? Number(t.season) : null,
                episode: t.episode !== undefined && t.episode !== null ? Number(t.episode) : null,
                title: t.title || t.targetFileName,
                year: t.year ? String(t.year) : null,
                status: 'PENDING',
                reason: 'WAL 预写事务就绪'
            }));

            const records = await ScrapeJournalService.recordOperations(batch.id, operations);
            const recordMap = new Map();
            for (let i = 0; i < tasks.length; i++) {
                recordMap.set(tasks[i].fileId, records[i]);
            }

            let succeededCount = 0;
            let failedCount = 0;
            const dirCache = new Map();

            // 3. 逐项流式执行移动与改名
            for (const t of tasks) {
                const rec = recordMap.get(t.fileId);
                try {
                    let targetFolderId = dirCache.get(t.targetDirectory);
                    if (!targetFolderId) {
                        targetFolderId = await stagingSvc.ensureFolderPath(cloud139, t.targetDirectory);
                        dirCache.set(t.targetDirectory, targetFolderId);
                    }

                    if (t.targetFileName && t.targetFileName !== t.sourceFileName) {
                        await cloud139.renameFile(t.fileId, t.targetFileName);
                    }

                    if (targetFolderId) {
                        try {
                            if (typeof cloud139.batchMoveHcy === 'function') {
                                await cloud139.batchMoveHcy([t.fileId], targetFolderId);
                            } else {
                                await cloud139.moveFiles([{ contentID: t.fileId }], [], targetFolderId);
                            }
                        } catch (moveErr) {
                            if (moveErr.message && (
                                moveErr.message.includes('无法移动到自身') ||
                                moveErr.message.includes('自身所在目录') ||
                                moveErr.message.includes('同一目录')
                            )) {
                                logger.info(`[手动整理-移动] 文件已位于目标目录中，无需重复移动: ${t.sourceFileName}`);
                            } else {
                                throw moveErr;
                            }
                        }
                    }

                    if (rec && ScrapeJournalService.recordRepo) {
                        await ScrapeJournalService.recordRepo.update(rec.id, {
                            status: 'MOVED',
                            newParentRef: String(targetFolderId),
                            newRef: String(t.fileId),
                            appliedAt: new Date()
                        });
                    }
                    succeededCount++;
                } catch (taskErr) {
                    failedCount++;
                    logger.error(`[手动整理] 文件 "${t.sourceFileName}" 移动失败: ${taskErr.message}`);
                    if (rec && ScrapeJournalService.recordRepo) {
                        await ScrapeJournalService.recordRepo.update(rec.id, {
                            status: 'failed',
                            reason: taskErr.message,
                            error: taskErr.message
                        });
                    }
                }
            }

            if (batch && ScrapeJournalService.batchRepo) {
                await ScrapeJournalService.batchRepo.update(batch.id, {
                    status: failedCount === 0 ? 'applied' : (succeededCount > 0 ? 'partial' : 'failed'),
                    error: failedCount > 0 ? `${failedCount} 个文件整理失败` : null,
                    updatedAt: new Date()
                });
            }

            for (const d of involvedDirs) {
                OrganizeMutex.release(d);
            }

            res.json({
                success: true,
                data: {
                    batchId: batch.id,
                    total: tasks.length,
                    succeededCount,
                    failedCount
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7. TMDB 即时影视检索（供人工纠偏工作台精准查片）
    app.post('/api/tmdb-organize/search-tmdb', async (req, res) => {
        try {
            const { query, mediaType, year } = req.body || {};
            if (!query) {
                return res.status(400).json({ success: false, error: '搜索关键词不能为空' });
            }
            const { TMDBService } = require('../services/tmdb');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const tmdb = new TMDBService();

            const normalizeCandidates = (arr) => {
                return (arr || []).map(c => {
                    let p = c.poster_path || c.posterPath || '';
                    if (p && p.startsWith('http')) {
                        const m = p.match(/\/t\/p\/(?:w\d+|original)(\/[^?#]+)/);
                        if (m) p = m[1];
                    }
                    return {
                        ...c,
                        poster_path: p,
                        posterPath: c.posterPath || (p ? `https://image.tmdb.org/t/p/w500${p}` : '')
                    };
                });
            };

            const parsed = TMDBService.parseTmdbLookupQuery(query);
            if (parsed && parsed.tmdbId) {
                const item = await tmdb.lookupById(parsed.tmdbId, mediaType || parsed.mediaType || 'auto');
                const list = item ? (Array.isArray(item) ? item : [item]) : [];
                return res.json({ success: true, data: normalizeCandidates(list) });
            }

            const cleanTitle = RecognitionEngine.sanitizeMediaTitle(query) || query;
            const extractedYear = year || RecognitionEngine.extractYear(query) || '';
            const candidates = await tmdb.searchCandidates(cleanTitle, extractedYear, mediaType || 'auto');
            res.json({ success: true, data: normalizeCandidates(candidates) });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7.1 直接获取 TMDB 剧集全量季列表概览
    app.get('/api/tmdb-organize/tv/:id/seasons', async (req, res) => {
        try {
            const tvId = String(req.params.id || '').trim();
            if (!tvId) {
                return res.status(400).json({ success: false, error: '缺少有效的 TMDB 剧集 ID' });
            }
            const { TMDBService } = require('../services/tmdb');
            const tmdb = new TMDBService();
            const details = await tmdb.getTVDetails(tvId);
            if (!details) {
                return res.status(404).json({ success: false, error: `未找到 ID 为 ${tvId} 的 TMDB 剧集` });
            }
            res.json({
                success: true,
                data: {
                    id: details.id,
                    title: details.title,
                    totalSeasons: details.totalSeasons || details.seasons?.length || 0,
                    seasons: details.seasons || []
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7.2 直接获取 TMDB 剧集指定季度的全量单集明细
    app.get('/api/tmdb-organize/tv/:id/season/:seasonNumber', async (req, res) => {
        try {
            const tvId = String(req.params.id || '').trim();
            const seasonNum = parseInt(req.params.seasonNumber, 10);
            if (!tvId || isNaN(seasonNum)) {
                return res.status(400).json({ success: false, error: '缺少有效的 TMDB 剧集 ID 或季号' });
            }
            const { TMDBService } = require('../services/tmdb');
            const tmdb = new TMDBService();
            const episodes = await tmdb.getSeasonDetails(tvId, seasonNum);
            res.json({
                success: true,
                data: {
                    tvId,
                    seasonNumber: seasonNum,
                    episodes: episodes || []
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7.5 AI 辅助识别与影视条目提纯接口
    app.post('/api/tmdb-organize/ai-identify', async (req, res) => {
        try {
            const { query, folderName, files, accountId, tmdbId, tmdbCandidate } = req.body || {};
            const textToAnalyze = query || folderName || '';
            if (!textToAnalyze) {
                return res.status(400).json({ success: false, error: '缺少待识别文本或目录名称' });
            }

            logger.info(`[AI辅助识别] 收到请求: query="${query || ''}", folder="${folderName || ''}", filesCount=${Array.isArray(files) ? files.length : 0}, tmdbId=${tmdbId || '无'}, accountId=${accountId || '默认'}`);

            const aiService = require('../services/ai');
            const { TMDBService } = require('../services/tmdb');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const tmdb = new TMDBService();

            // 1. 尝试先行获取或解析 TMDB ID 与官方分季元数据，为 AI 提供权威事实基准
            let effectiveTmdbId = tmdbId ? String(tmdbId).trim() : null;
            if (!effectiveTmdbId && tmdbCandidate && tmdbCandidate.id) {
                effectiveTmdbId = String(tmdbCandidate.id).trim();
            }
            if (!effectiveTmdbId) {
                const combinedText = `${folderName || ''} ${textToAnalyze}`;
                const m = combinedText.match(/\{tmdb-(\d+)\}|\[tmdb-(\d+)\]/i);
                if (m) effectiveTmdbId = m[1] || m[2];
            }

            let preliminaryCandidates = [];
            const isMovieHint = /(?:剧场版|劇場版|\b(?:The\s+)?Movie\b|电影)/i.test(textToAnalyze);
            if (!effectiveTmdbId && tmdb.apiKey) {
                try {
                    const preCleanTitle = RecognitionEngine.cleanAnimeFolderName(textToAnalyze) || textToAnalyze;
                    const preYear = RecognitionEngine.extractYear(textToAnalyze) || '';
                    const preSearchType = isMovieHint ? 'movie' : 'auto';
                    preliminaryCandidates = await tmdb.searchCandidates(preCleanTitle, preYear, preSearchType);
                    if (preliminaryCandidates && preliminaryCandidates.length > 0) {
                        effectiveTmdbId = String(preliminaryCandidates[0].id);
                    }
                } catch (e) {
                    logger.warn(`[AI辅助识别] 预先检索 TMDB 候选失败: ${e.message}`);
                }
            }

            let tmdbInfo = null;
            if (effectiveTmdbId && tmdb.apiKey) {
                try {
                    let tmdbDetail = null;
                    if (!isMovieHint) {
                        try { tmdbDetail = await tmdb.getTVDetails(effectiveTmdbId); } catch (_) {}
                    }
                    if (!tmdbDetail || !tmdbDetail.id) {
                        try { tmdbDetail = await tmdb.details('movie', effectiveTmdbId); } catch (_) {}
                    }
                    if (tmdbDetail && tmdbDetail.id) {
                        tmdbInfo = {
                            id: tmdbDetail.id,
                            title: tmdbDetail.title || tmdbDetail.name || '',
                            year: tmdbDetail.releaseDate ? tmdbDetail.releaseDate.slice(0, 4) : (tmdbDetail.first_air_date ? tmdbDetail.first_air_date.slice(0, 4) : (tmdbDetail.release_date ? tmdbDetail.release_date.slice(0, 4) : '')),
                            seasons: Array.isArray(tmdbDetail.seasons) ? tmdbDetail.seasons.map(s => ({
                                season_number: s.season_number,
                                name: s.name,
                                episode_count: s.episode_count,
                                air_date: s.air_date
                            })) : []
                        };
                        logger.info(`[AI辅助识别] 成功获取 TMDB 官方元数据: 《${tmdbInfo.title}》(${tmdbInfo.year || '无年份'})${tmdbInfo.seasons.length ? `，包含 ${tmdbInfo.seasons.length} 季` : ' [电影]'}`);
                    }
                } catch (e) {
                    logger.warn(`[AI辅助识别] 获取 TMDB 详情失败: ${e.message}`);
                }
            }

            // 2. 将【当前目录/文件】与【TMDB 官方元数据】一并交由 AI 分析与消歧
            let aiResult = null;
            try {
                const sampleFiles = Array.isArray(files) ? files.slice(0, 10).map(f => typeof f === 'string' ? f : (f.name || f.oldName || '')) : [];
                aiResult = await aiService.parseMediaInfo(textToAnalyze, {
                    force: true,
                    fileNames: sampleFiles,
                    folderNames: folderName ? [folderName] : [],
                    folderName,
                    files: sampleFiles,
                    accountId: accountId ? Number(accountId) : null,
                    tmdbInfo
                });
                logger.info(`[AI辅助识别] AI 解析结果:`, aiResult?.data || aiResult);
            } catch (aiErr) {
                logger.warn(`[AI辅助识别] AI 解析异常: ${aiErr.message}`);
            }

            const rawAiTitle = aiResult?.data?.title || aiResult?.title || '';
            const aiYear = aiResult?.data?.year || aiResult?.year || '';
            const aiType = aiResult?.data?.mediaType || aiResult?.mediaType || 'auto';
            const aiSeason = aiResult?.data?.season || aiResult?.season || null;
            const aiCategory = aiResult?.data?.category || aiResult?.category || '';

            const effectiveTitle = rawAiTitle || tmdbInfo?.title || RecognitionEngine.cleanAnimeFolderName(textToAnalyze) || textToAnalyze;
            const effectiveYear = aiYear || tmdbInfo?.year || RecognitionEngine.extractYear(textToAnalyze) || '';

            // 3. 联动 TMDB 检索候选列表
            let candidates = preliminaryCandidates;
            if ((!candidates || candidates.length === 0) && tmdb.apiKey) {
                try {
                    candidates = await tmdb.searchCandidates(effectiveTitle, effectiveYear, aiType);
                } catch (e) {
                    logger.warn(`[AI辅助识别] TMDB 联动搜索失败: ${e.message}`);
                }
            }

            const normalizeCandidates = (arr) => {
                return (arr || []).map(c => {
                    let p = c.poster_path || c.posterPath || '';
                    if (p && p.startsWith('http')) {
                        const m = p.match(/\/t\/p\/(?:w\d+|original)(\/[^?#]+)/);
                        if (m) p = m[1];
                    }
                    return {
                        ...c,
                        poster_path: p,
                        posterPath: c.posterPath || (p ? `https://image.tmdb.org/t/p/w500${p}` : '')
                    };
                });
            };

            res.json({
                success: true,
                data: {
                    aiTitle: effectiveTitle,
                    aiYear: effectiveYear,
                    aiType,
                    aiSeason,
                    aiCategory,
                    aiExplanation: aiResult?.data?.replyText || aiResult?.replyText || '',
                    rawAiResult: aiResult,
                    candidates: normalizeCandidates(candidates),
                    tmdbInfo
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7.6 TMDB 海报高速镜像代理接口 (解决国内无法直接加载 image.tmdb.org 导致海报缺失)
    app.get('/api/tmdb-organize/poster-proxy', async (req, res) => {
        try {
            const rawPath = req.query.path;
            if (!rawPath) return res.status(400).send('Path required');
            let clean = String(rawPath).trim();
            if (clean.startsWith('http')) {
                const m = clean.match(/\/t\/p\/(?:w\d+|original)(\/[^?#]+)/);
                clean = m ? m[1] : clean.replace(/^https?:\/\/[^/]+/, '');
            }
            if (!clean.startsWith('/')) clean = '/' + clean;

            const got = require('got');
            const ConfigService = require('../services/ConfigService');
            const proxyAgent = ProxyUtil.getProxyAgent('tmdb');
            const configuredImageDomain = (ConfigService.getConfigValue('tmdb.imageDomain') || 'https://image.tmdb.org').replace(/\/+$/, '');

            let imageBuffer = null;
            let contentType = 'image/webp';

            // 策略 1: 优先通过 wsrv.nl 镜像加速 (国内直连高速，自动 WebP 压缩)
            try {
                const mirrorUrl = `https://wsrv.nl/?url=image.tmdb.org/t/p/w300${clean}&output=webp`;
                const resp = await got(mirrorUrl, { timeout: { request: 5000 }, responseType: 'buffer' });
                if (resp.statusCode === 200 && resp.body && resp.body.length > 0) {
                    imageBuffer = resp.body;
                    contentType = resp.headers['content-type'] || 'image/webp';
                }
            } catch (_) {}

            // 策略 2: 若用户配置了自建镜像源/代理源，尝试从中拉取
            if (!imageBuffer && configuredImageDomain && !configuredImageDomain.includes('image.tmdb.org')) {
                try {
                    const customUrl = `${configuredImageDomain}/t/p/w300${clean}`;
                    const resp = await got(customUrl, { timeout: { request: 5000 }, responseType: 'buffer' });
                    if (resp.statusCode === 200 && resp.body && resp.body.length > 0) {
                        imageBuffer = resp.body;
                        contentType = resp.headers['content-type'] || 'image/jpeg';
                    }
                } catch (_) {}
            }

            // 策略 3: 直连官方 TMDB (带代理通道) 兜底
            if (!imageBuffer) {
                try {
                    const directUrl = `https://image.tmdb.org/t/p/w300${clean}`;
                    const resp = await got(directUrl, {
                        agent: proxyAgent,
                        timeout: { request: 8000 },
                        responseType: 'buffer'
                    });
                    if (resp.statusCode === 200 && resp.body && resp.body.length > 0) {
                        imageBuffer = resp.body;
                        contentType = resp.headers['content-type'] || 'image/jpeg';
                    }
                } catch (_) {}
            }

            if (imageBuffer) {
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                return res.send(imageBuffer);
            }

            return res.status(404).send('Poster not found');
        } catch (e) {
            res.status(500).send(e.message);
        }
    });

    // 7.1 物理流媒体规格嗅探接口 (基于 139 HTTP Range 与 WebAssembly MediaInfo 深度探测)
    app.post('/api/tmdb-organize/probe-group', async (req, res) => {
        try {
            const { accountId, items } = req.body || {};
            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.json({ success: true, data: {} });
            }

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const { MediaProbeService } = require('../services/MediaProbeService');
            const pLimit = require('p-limit');
            const limit = pLimit(3);
            const results = {};

            await Promise.all(items.map(it => limit(async () => {
                const fid = String(it.fileId || it.id || '');
                if (!fid) return;
                try {
                    const probed = await MediaProbeService.probeFile({
                        fileId: fid,
                        id: fid,
                        name: it.name || it.fileName || '',
                        size: it.size || it.fileSize || 0,
                        isVideo: true
                    }, cloud139, { forceNetworkProbe: false });
                    results[fid] = probed;
                } catch (err) {
                    logger.warn(`[API-嗅探] 探测文件 ${fid} 失败: ${err.message}`);
                    results[fid] = null;
                }
            })));

            res.json({ success: true, data: results });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7.2 媒体库洗版仲裁预检接口 (比对目标目录已有文件，预先判定洗版/淘汰/共存/新增)
    app.post('/api/tmdb-organize/wash-check', async (req, res) => {
        try {
            const {
                accountId,
                targetDirPath = '/媒体库',
                items
            } = req.body || {};

            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.json({ success: true, data: {} });
            }

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const { RecognitionEngine } = require('../services/RecognitionEngine');

            const channelCfg = ConfigService.getConfigValue('channelMonitor') || {};
            const washPriorityOrder = channelCfg.washPriorityOrder
                || ConfigService.getConfigValue('washPriorityOrder')
                || ['videoFormat', 'dynamicRange', 'videoCodec', 'resourceType', 'releaseGroup', 'colorDepth', 'audioCodec', 'frameRate', 'fileSize'];

            const washPolicy = {
                autoWash: channelCfg.autoWash !== false,
                keepDolbyMultiVersion: Boolean(channelCfg.keepDolbyMultiVersion),
                washPriorityOrder,
                enableReleaseGroupPriority: channelCfg.enableReleaseGroupPriority !== false,
                preferRemux: channelCfg.preferRemux !== false,
                preferHighResolution: channelCfg.preferHighResolution !== false,
                preferDolby: channelCfg.preferDolby !== false,
                conflictMode: channelCfg.conflictMode !== undefined ? channelCfg.conflictMode : 1
            };

            const targetRoot = (targetDirPath || '/媒体库').replace(/\/+$/, '');

            // 1. 按目标相对路径聚类
            const folderGroups = new Map();
            for (const it of items) {
                const fid = String(it.fileId || it.id || '');
                const tmdbId = String(it.targetTmdbId || it.tmdbId || '');
                const title = (it.targetTitle || it.title || '').trim();
                const year = it.targetYear || it.year || '';
                const mediaType = it.targetMediaType || it.mediaType || 'tv';
                const category = it.targetCategory || (mediaType === 'tv' ? '国产剧' : '电影');
                const season = mediaType === 'tv'
                    ? ((it.targetSeason !== undefined && it.targetSeason !== null && !isNaN(Number(it.targetSeason))) ? Number(it.targetSeason) : 1)
                    : null;

                let subDir = '';
                const tmdbTag = tmdbId ? ` {tmdb-${tmdbId}}` : '';
                const titleYear = year ? `${title} (${year})` : title;

                if (mediaType === 'tv') {
                    const sStr = String(season !== null ? season : 1).padStart(2, '0');
                    subDir = `剧集/${category}/${titleYear}${tmdbTag}/Season ${sStr}`.replace(/\/+/g, '/');
                } else {
                    subDir = `电影/${category}/${titleYear}${tmdbTag}`.replace(/\/+/g, '/');
                }

                const fullPath = `${targetRoot}/${subDir}`.replace(/\/+/g, '/');
                if (!folderGroups.has(fullPath)) folderGroups.set(fullPath, []);
                folderGroups.get(fullPath).push(it);
            }

            const washResults = {};

            // 2. 逐目录检索已有文件并比对洗版
            for (const [fullPath, groupItems] of folderGroups.entries()) {
                // 安全寻址目标目录 (纯只读探测，绝不新建幽灵目录)
                const segs = fullPath.split('/').filter(Boolean);
                let currentId = '/';
                let exists = true;
                for (const seg of segs) {
                    const found = await cloud139.findFolderByName(currentId, seg).catch(() => null);
                    const fId = typeof found === 'string' ? found : (found?.fileId || found?.id || null);
                    if (!fId) {
                        exists = false;
                        break;
                    }
                    currentId = String(fId);
                }

                let diskFiles = [];
                if (exists) {
                    try {
                        const itemsList = await cloud139.listDiskDirAll(currentId);
                        diskFiles = (itemsList || []).filter(f => !f.isDir && f.type !== 'folder' && f.fileType !== 1);
                    } catch (listErr) {
                        logger.warn(`[洗版预检] 列出目标目录文件失败: ${listErr.message}`);
                    }
                }

                for (const item of groupItems) {
                    const fid = String(item.fileId || item.id || '');
                    const mediaType = item.targetMediaType || item.mediaType || 'tv';
                    const targetSeason = mediaType === 'tv'
                        ? ((item.targetSeason !== undefined && item.targetSeason !== null && !isNaN(Number(item.targetSeason))) ? Number(item.targetSeason) : 1)
                        : null;
                    const targetEpisode = mediaType === 'tv'
                        ? ((item.targetEpisode !== undefined && item.targetEpisode !== null && !isNaN(Number(item.targetEpisode))) ? Number(item.targetEpisode) : 1)
                        : null;

                    // 检索匹配的已有文件
                    const matchedExisting = diskFiles.find(ef => {
                        if (String(ef.fileId || ef.id) === fid) return false;
                        if (mediaType === 'tv') {
                            const parsed = RecognitionEngine.parseSeasonEpisode(ef.name);
                            const efSeason = (parsed.season !== null && parsed.season !== undefined) ? parsed.season : 1;
                            const efEp = parsed.episode;
                            return efSeason === targetSeason && efEp === targetEpisode;
                        } else {
                            return RecognitionEngine.isVideoFile(ef.name);
                        }
                    });

                    if (!matchedExisting) {
                        washResults[fid] = {
                            washAction: 'new',
                            detail: exists ? '目标库暂无同集，将直接入库' : '目标目录将在入库时自动创建 (无需提前手动建目录)'
                        };
                        continue;
                    }

                    const incomingTags = RecognitionEngine.inferTechnicalTags(item.targetNewFileName || item.name, item.size || 0, item.probedMeta);
                    const existingTags = RecognitionEngine.inferTechnicalTags(matchedExisting.name, matchedExisting.size || 0);
                    const decisiveRes = RecognitionEngine.compareCandidatesDecisive(incomingTags, existingTags, washPolicy);
                    const cmp = decisiveRes.cmp;

                    if (cmp < 0) {
                        washResults[fid] = {
                            washAction: 'upgrade',
                            existingFile: { fileId: matchedExisting.fileId || matchedExisting.id, name: matchedExisting.name, size: matchedExisting.size, tags: existingTags },
                            incomingTags,
                            decisiveLabel: decisiveRes.decisiveLabel,
                            decisiveDetail: decisiveRes.decisiveDetail,
                            detail: `进场版本更优（在【${decisiveRes.decisiveLabel}】胜出: ${decisiveRes.decisiveDetail}），入库后将洗版置换旧版`
                        };
                    } else if (cmp > 0) {
                        washResults[fid] = {
                            washAction: 'inferior',
                            existingFile: { fileId: matchedExisting.fileId || matchedExisting.id, name: matchedExisting.name, size: matchedExisting.size, tags: existingTags },
                            incomingTags,
                            decisiveLabel: decisiveRes.decisiveLabel,
                            decisiveDetail: decisiveRes.decisiveDetail,
                            detail: `媒体库已有更优画质（在【${decisiveRes.decisiveLabel}】更优: ${decisiveRes.decisiveDetail}），建议排除避免劣质覆盖`
                        };
                    } else {
                        const isDvPair = washPolicy.keepDolbyMultiVersion && (
                            (incomingTags.dynamicRange === 'DV') !== (existingTags.dynamicRange === 'DV')
                        );
                        if (isDvPair) {
                            washResults[fid] = {
                                washAction: 'coexist',
                                existingFile: { fileId: matchedExisting.fileId || matchedExisting.id, name: matchedExisting.name, size: matchedExisting.size, tags: existingTags },
                                incomingTags,
                                detail: '杜比视界 (DV) 与 SDR 双版本，准许并存'
                            };
                        } else {
                            washResults[fid] = {
                                washAction: 'same',
                                existingFile: { fileId: matchedExisting.fileId || matchedExisting.id, name: matchedExisting.name, size: matchedExisting.size, tags: existingTags },
                                incomingTags,
                                detail: '画质规格与媒体库已有版本完全一致'
                            };
                        }
                    }
                }
            }

            res.json({ success: true, data: washResults });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 8. 人工纠偏并规范归档入库接口 (单项/批量精准解决未识别文件)
    app.post('/api/tmdb-organize/resolve-unrecognized', async (req, res) => {
        try {
            const {
                accountId,
                items,
                targetDirPath = '/媒体库',
                cleanEmptySourceDir = true,
                batchId = null
            } = req.body || {};

            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ success: false, error: '请提供待归档的文件项列表' });
            }

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) return res.json({ success: true, data: { files: [], allFiles: [], stagingFolderName: '', message: '请先绑定并选择 139 移动云盘账号' } });

            const cloud139 = Cloud139Service.getInstance(account);
            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const { RecognitionEngine } = require('../services/RecognitionEngine');
            const { MediaProbeService } = require('../services/MediaProbeService');
            const adapter = await MediaScrapeService.getAdapter({ driveType: 'cloud139', accountId: account?.id });

            const channelCfg = ConfigService.getConfigValue('channelMonitor') || {};
            const washPriorityOrder = channelCfg.washPriorityOrder
                || ConfigService.getConfigValue('washPriorityOrder')
                || ['videoFormat', 'dynamicRange', 'videoCodec', 'resourceType', 'releaseGroup', 'colorDepth', 'audioCodec', 'frameRate', 'fileSize'];

            const washPolicy = {
                autoWash: channelCfg.autoWash !== false,
                keepDolbyMultiVersion: Boolean(channelCfg.keepDolbyMultiVersion),
                washPriorityOrder,
                enableReleaseGroupPriority: channelCfg.enableReleaseGroupPriority !== false,
                preferRemux: channelCfg.preferRemux !== false,
                preferHighResolution: channelCfg.preferHighResolution !== false,
                preferDolby: channelCfg.preferDolby !== false,
                conflictMode: channelCfg.conflictMode !== undefined ? channelCfg.conflictMode : 1
            };

            let targetRoot = String(targetDirPath || '/媒体库').trim().replace(/\/+$/, '');
            if (!targetRoot || targetRoot === '/' || targetRoot === '默认媒体库' || targetRoot === '/默认媒体库' || targetRoot === '默认媒体库 (/)' || targetRoot.includes('默认媒体库')) {
                targetRoot = '/媒体库';
            }
            if (!targetRoot.startsWith('/')) {
                targetRoot = '/' + targetRoot;
            }
            const targetRootId = await adapter.ensureDirPath(targetRoot);

            let batch = null;
            if (batchId && ScrapeJournalService.batchRepo) {
                batch = await ScrapeJournalService.batchRepo.findOne({ where: { id: Number(batchId) } });
            }
            if (!batch) {
                batch = await ScrapeJournalService.createBatch({
                    driveType: 'cloud139',
                    accountId: Number(account.id),
                    rootRef: '/',
                    rootPath: '/',
                    targetRootRef: targetRootId,
                    targetRootPath: targetRoot,
                    trigger: 'manual_resolve',
                    organize: true
                });
            }

            const processed = [];
            const skipped = [];
            const failed = [];
            const sourceFoldersToClean = new Set();
            const targetDirFileCache = new Map();

            for (const item of items) {
                try {
                    const fileId = item.fileId || item.id;
                    const oldName = item.name || item.oldName;
                    const tmdbId = String(item.targetTmdbId || item.tmdbId || '');
                    const title = (item.targetTitle || item.title || '').trim();
                    const year = item.targetYear || item.year || '';
                    const mediaType = item.targetMediaType || item.mediaType || 'tv';
                    const category = item.targetCategory || (mediaType === 'tv' ? '国产剧' : '电影');
                    const season = mediaType === 'tv'
                        ? ((item.targetSeason !== undefined && item.targetSeason !== null && !isNaN(Number(item.targetSeason))) ? Number(item.targetSeason) : ((item.season !== undefined && item.season !== null && !isNaN(Number(item.season))) ? Number(item.season) : 1))
                        : null;
                    const episode = mediaType === 'tv'
                        ? ((item.targetEpisode !== undefined && item.targetEpisode !== null && !isNaN(Number(item.targetEpisode))) ? Number(item.targetEpisode) : ((item.episode !== undefined && item.episode !== null && !isNaN(Number(item.episode))) ? Number(item.episode) : 1))
                        : null;
                    const episodeTitle = item.targetEpisodeTitle || '';

                    // 1. 深度物理流嗅探：确保拿到真实的物理流媒体技术规格 (无盲目瞎猜)
                    let probedMeta = item.probedMeta;
                    if (!probedMeta || !probedMeta.videoFormat) {
                        try {
                            probedMeta = await MediaProbeService.probeFile({
                                fileId,
                                id: fileId,
                                name: oldName,
                                size: item.size || 0,
                                isVideo: true
                            }, cloud139, { forceNetworkProbe: false });
                        } catch (probeErr) {
                            logger.warn(`[人工归档-媒体探针] 探测单个文件 ${oldName} 失败: ${probeErr.message}`);
                        }
                    }

                    // 2. 推导目标相对子路径 (季号 0 规范归入 Season S00 / 特别篇，严禁强制变为 Season 01)
                    let subDir = '';
                    let tmdbTag = tmdbId ? ` {tmdb-${tmdbId}}` : '';
                    let titleYear = year ? `${title} (${year})` : title;

                    if (mediaType === 'tv') {
                        const sStr = String(season !== null ? season : 1).padStart(2, '0');
                        subDir = `剧集/${category}/${titleYear}${tmdbTag}/Season ${sStr}`.replace(/\/+/g, '/');
                    } else {
                        subDir = `电影/${category}/${titleYear}${tmdbTag}`.replace(/\/+/g, '/');
                    }

                    // 3. 推导规范化文件名 (整合真实探测规格，若前端微调了新文件名则直接采纳)
                    const extMatch = oldName.match(/\.([a-zA-Z0-9]+)$/);
                    const ext = extMatch ? `.${extMatch[1]}` : '.mp4';
                    const tech = RecognitionEngine.inferTechnicalTags(oldName, item.size || 0, probedMeta);
                    
                    const techParts = [];
                    if (tech.resolution) techParts.push(tech.resolution);

                    const isRemux = Boolean(
                        tech.isRemux ||
                        /REMUX/i.test(tech.resourceType || '') ||
                        /REMUX/i.test(oldName || '')
                    );
                    if (isRemux) {
                        const isBluRay = Boolean(
                            tech.isBluRay ||
                            /Blu[- .]?Ray|\bBD\b/i.test(tech.mediaSource || '') ||
                            /Blu[- .]?Ray|\bBD\b/i.test(oldName || '')
                        );
                        techParts.push(isBluRay ? 'BluRay.REMUX' : 'REMUX');
                    } else {
                        techParts.push('WEB-DL');
                    }

                    if (tech.dynamicRange && tech.dynamicRange !== 'SDR') techParts.push(tech.dynamicRange);
                    if (tech.colorDepth && tech.colorDepth !== '8bit') techParts.push(tech.colorDepth);
                    if (tech.videoCodec) techParts.push(tech.videoCodec);
                    if (tech.audioCodec) techParts.push(tech.audioCodec);
                    const techTagStr = techParts.length > 0 ? '.' + techParts.join('.') : '';

                    let newName = '';
                    if (item.targetNewFileName && typeof item.targetNewFileName === 'string' && item.targetNewFileName.trim()) {
                        newName = item.targetNewFileName.trim();
                    } else if (mediaType === 'tv') {
                        const sStr = String(season !== null ? season : 1).padStart(2, '0');
                        const eStr = String(episode || 1).padStart(2, '0');
                        const epTitleStr = episodeTitle ? `.${episodeTitle}` : '';
                        newName = `${title}.${year ? year + '.' : ''}S${sStr}E${eStr}${epTitleStr}${techTagStr}${ext}`;
                    } else {
                        newName = `${title}.${year ? year : ''}${techTagStr}${ext}`;
                    }
                    newName = newName.replace(/\.{2,}/g, '.');

                    // 4. 幂等创建目标目录
                    let currentParentRef = targetRootId;
                    const segs = subDir.split('/').filter(Boolean);
                    for (const seg of segs) {
                        currentParentRef = await adapter.ensureDir(currentParentRef, seg);
                    }

                    // 5. 目标媒体库洗版仲裁比对
                    if (!targetDirFileCache.has(currentParentRef)) {
                        try {
                            const diskFiles = await cloud139.listDiskDirAll(currentParentRef);
                            targetDirFileCache.set(currentParentRef, (diskFiles || []).filter(f => !f.isDir && f.type !== 'folder' && f.fileType !== 1));
                        } catch (err) {
                            logger.warn(`[人工归档] 读取目标目录文件列表失败: ${err.message}`);
                            targetDirFileCache.set(currentParentRef, []);
                        }
                    }
                    const existingDiskFiles = targetDirFileCache.get(currentParentRef) || [];

                    const matchedExisting = existingDiskFiles.find(ef => {
                        if (String(ef.fileId || ef.id) === String(fileId)) return false;
                        if (mediaType === 'tv') {
                            const parsed = RecognitionEngine.parseSeasonEpisode(ef.name);
                            const efSeason = (parsed.season !== null && parsed.season !== undefined) ? parsed.season : 1;
                            const efEp = parsed.episode;
                            return efSeason === (season || 1) && efEp === (episode || 1);
                        } else {
                            return RecognitionEngine.isVideoFile(ef.name);
                        }
                    });

                    let shouldMove = true;
                    let fileToRecycleAfterMove = null;
                    let washLogDetail = '';
                    let finalNewName = newName;

                    if (matchedExisting) {
                        const incomingTags = RecognitionEngine.inferTechnicalTags(newName, item.size || 0, probedMeta);
                        const existingTags = RecognitionEngine.inferTechnicalTags(matchedExisting.name, matchedExisting.size || 0);
                        const decisiveRes = RecognitionEngine.compareCandidatesDecisive(incomingTags, existingTags, washPolicy);
                        const cmp = decisiveRes.cmp;

                        if (cmp < 0 || (cmp === 0 && /(?:\s*-\s*(?:\d+(?:\.\d+)?(?:GB|MB|G|M)|4K|1080P|v\d+))\./i.test(matchedExisting.name))) {
                            // 进场新版本画质更优 -> 洗版置换：先安全入库，随后将旧版移入 139 回收站
                            fileToRecycleAfterMove = matchedExisting;
                            washLogDetail = `洗版置换旧版【${matchedExisting.name}】（在【${decisiveRes.decisiveLabel}】胜出: ${decisiveRes.decisiveDetail}）`;
                            logger.info(`[人工归档-洗版置换] ${oldName} 在【${decisiveRes.decisiveLabel}】胜出 (${decisiveRes.decisiveDetail})，将在新版入库后移入回收站旧版本: ${matchedExisting.name}`);
                        } else if (cmp > 0) {
                            // 目标库中已有更高画质版本 -> 洗版拦截：安全淘汰暂存副本，坚决避免污染高品质媒体库
                            shouldMove = false;
                            washLogDetail = `洗版拦截：目标媒体库已有更高画质版本【${matchedExisting.name}】（在【${decisiveRes.decisiveLabel}】更优: ${decisiveRes.decisiveDetail}），已拦截清理暂存副本`;
                            logger.info(`[人工归档-洗版拦截] 目标库已有更高画质版本 (${matchedExisting.name} > ${newName})，清理暂存区副本【${oldName}】移入回收站`);

                            try {
                                await cloud139.deleteFiles([fileId]);
                            } catch (delErr) {
                                logger.warn(`[人工归档-洗版拦截] 清理暂存区副本失败: ${delErr.message}`);
                            }

                            // 记录 WAL 为 discarded
                            const targetDisplayDir = `${targetRoot}/${subDir}`.replace(/\/+/g, '/');
                            await ScrapeJournalService.recordOperations(batch.id, [{
                                driveType: 'cloud139',
                                accountId: Number(account.id),
                                kind: 'video',
                                fileRef: fileId,
                                oldParentRef: item.parentFolderId || '/',
                                oldParentPath: item.oldPath || item.relativePath || '/',
                                oldName,
                                newName,
                                newParentPath: targetDisplayDir,
                                targetSubDir: subDir,
                                mediaType,
                                tmdbId: tmdbId || null,
                                season,
                                episode,
                                title,
                                year: year ? String(year) : null,
                                confidence: 500,
                                status: 'discarded',
                                source: 'manual_resolve_wash_intercept'
                            }]);

                            if (item.parentFolderId) {
                                sourceFoldersToClean.add(item.parentFolderId);
                            }

                            skipped.push({
                                fileId,
                                oldName,
                                washAction: 'inferior',
                                superiorFile: matchedExisting.name,
                                reason: washLogDetail
                            });
                            continue;
                        } else {
                            // 规格相同：判断杜比视界 (DV) 与 SDR 双版本共存
                            const isDvPair = washPolicy.keepDolbyMultiVersion && (
                                (incomingTags.dynamicRange === 'DV') !== (existingTags.dynamicRange === 'DV')
                            );
                            if (isDvPair) {
                                const tag = incomingTags.dynamicRange === 'DV' ? 'DV' : 'SDR';
                                const dot = newName.lastIndexOf('.');
                                const stem = dot > 0 ? newName.slice(0, dot) : newName;
                                const fileExt = dot > 0 ? newName.slice(dot) : '';
                                finalNewName = `${stem} - ${tag}${fileExt}`;
                                washLogDetail = `杜比双版本共存，自动追加 [${tag}] 标识`;
                            }
                        }
                    }

                    // 6. 记录 WAL
                    const targetDisplayDir = `${targetRoot}/${subDir}`.replace(/\/+/g, '/');
                    const [record] = await ScrapeJournalService.recordOperations(batch.id, [{
                        driveType: 'cloud139',
                        accountId: Number(account.id),
                        kind: 'video',
                        fileRef: fileId,
                        oldParentRef: item.parentFolderId || '/',
                        oldParentPath: item.oldPath || item.relativePath || '/',
                        oldName,
                        newName: finalNewName,
                        newParentRef: String(currentParentRef),
                        newParentPath: targetDisplayDir,
                        targetSubDir: subDir,
                        mediaType,
                        tmdbId: tmdbId || null,
                        season,
                        episode,
                        title,
                        year: year ? String(year) : null,
                        confidence: 500,
                        status: 'applying',
                        source: 'manual_resolve'
                    }]);

                    // 7. 规范重命名并跨目录安全入库（先在源端重命名，再移动入库；源端遇阻则移动入库后重试重命名）
                    let renameDone = false;
                    if (finalNewName !== oldName) {
                        try {
                            await adapter.rename(fileId, finalNewName);
                            renameDone = true;
                        } catch (rnErr) {
                            logger.warn(`[人工归档-重命名] 源端重命名 ${oldName} -> ${finalNewName} 遇阻 (${rnErr.message})，将在移动入库后重试`);
                        }
                    }
                    await adapter.batchMove([fileId], currentParentRef);
                    if (finalNewName !== oldName && !renameDone) {
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                await new Promise(r => setTimeout(r, 600 * attempt));
                                await adapter.rename(fileId, finalNewName);
                                renameDone = true;
                                logger.info(`[人工归档-重命名] 目标目录下重命名 ${oldName} -> ${finalNewName} 成功`);
                                break;
                            } catch (retryErr) {
                                logger.warn(`[人工归档-重命名] 目标目录下重试第 ${attempt} 次失败: ${retryErr.message}`);
                            }
                        }
                    }

                    // 8. 洗版置换旧版回收（延后淘汰安全机制：新版入库成功后，才将旧版移入 139 回收站）
                    if (fileToRecycleAfterMove) {
                        try {
                            const oldFileId = fileToRecycleAfterMove.fileId || fileToRecycleAfterMove.id;
                            await cloud139.deleteFiles([oldFileId]);
                            logger.info(`[人工归档-洗版置换] 旧版文件【${fileToRecycleAfterMove.name}】(${oldFileId}) 已安全移入 139 回收站`);
                        } catch (delOldErr) {
                            logger.warn(`[人工归档-洗版置换] 回收旧版文件失败: ${delOldErr.message}`);
                        }
                    }

                    await ScrapeJournalService.markApplied([record.id], { [record.id]: fileId });
                    if (ScrapeJournalService.recordRepo) {
                        await ScrapeJournalService.recordRepo.update(record.id, {
                            newParentRef: String(currentParentRef)
                        });
                    }

                    if (item.parentFolderId) {
                        sourceFoldersToClean.add(item.parentFolderId);
                    }

                    processed.push({
                        fileId,
                        oldName,
                        newName: finalNewName,
                        targetPath: `${targetDisplayDir}/${finalNewName}`,
                        size: item.size || 0,
                        washAction: fileToRecycleAfterMove ? 'upgrade' : (matchedExisting ? 'coexist' : 'new'),
                        replacedFile: fileToRecycleAfterMove ? fileToRecycleAfterMove.name : null,
                        washDetail: washLogDetail
                    });
                } catch (itemErr) {
                    logger.error(`[人工归档] 处理单个文件失败: ${itemErr.message}`);
                    failed.push({ fileId: item.fileId, name: item.name, error: itemErr.message });
                }
            }

            // 9. 清理源空目录（自底向上）
            if (cleanEmptySourceDir && sourceFoldersToClean.size > 0) {
                for (const fId of sourceFoldersToClean) {
                    try {
                        const subEntries = await adapter.listDir(fId).catch(() => []);
                        if (!subEntries || subEntries.length === 0) {
                            await adapter.deleteDir(fId).catch(() => {});
                        }
                    } catch (_) {}
                }
            }

            // 10. STRM 自动生成联动与 Emby 媒体库刷新通知
            if (processed.length > 0) {
                const isAutoGenerateStrm = ConfigService.getConfigValue('strm.autoGenerateOnOrganize', true)
                    && (ConfigService.getConfigValue('strm.enable', false) || ConfigService.getConfigValue('channelMonitor.linkStrm', false));
                if (isAutoGenerateStrm) {
                    try {
                        const { StrmService } = require('../services/strm');
                        const strmService = new StrmService();
                        const strmFiles = processed.map(f => ({
                            fileId: f.fileId,
                            id: f.fileId,
                            name: f.newName,
                            finalName: f.newName,
                            originalName: f.oldName,
                            targetFolderPath: f.targetPath ? f.targetPath.substring(0, f.targetPath.lastIndexOf('/')) : targetRoot,
                            size: f.size,
                            accountId: account?.id
                        }));
                        await strmService.generateForOrganizedFiles(strmFiles, {
                            cleanObsolete: false,
                            cleanEmptyDirs: ConfigService.getConfigValue('strm.cleanEmptyDirs', true),
                            accountId: account?.id
                        });
                        logger.info(`[人工归档-STRM] 已自动生成 ${strmFiles.length} 个 .strm 映射`);
                    } catch (strmErr) {
                        logger.warn(`[人工归档-STRM] 生成异常: ${strmErr.message}`);
                    }
                }

                try {
                    const EventService = require('../services/eventService');
                    EventService.getInstance().emit('taskComplete', {
                        taskId: `manual-resolve-${batch.id}`,
                        taskName: `人工纠偏归档 - 规范入库 ${processed.length} 部`,
                        sourceMode: 'manual_resolve',
                        fileList: processed.map(p => ({
                            name: p.newName,
                            id: p.fileId,
                            size: p.size,
                            targetFolderPath: p.targetFolder || (p.targetPath ? p.targetPath.substring(0, p.targetPath.lastIndexOf('/')) : targetRoot)
                        })),
                        items: processed.map(p => ({
                            name: p.newName,
                            id: p.fileId,
                            size: p.size,
                            targetFolderPath: p.targetFolder || (p.targetPath ? p.targetPath.substring(0, p.targetPath.lastIndexOf('/')) : targetRoot)
                        })),
                        task: {
                            id: `manual-resolve-${batch.id}`,
                            account,
                            name: `人工纠偏归档 - 规范入库 ${processed.length} 部`,
                            resourceName: '人工纠偏归档',
                            realFolderName: targetRoot,
                            disableRename: true
                        }
                    });
                } catch (evErr) {
                    logger.warn(`[人工归档-事件通知] 异常: ${evErr.message}`);
                }
            }

            res.json({
                success: true,
                data: {
                    batchId: batch.id,
                    total: items.length,
                    processedCount: processed.length,
                    skippedCount: skipped.length,
                    failedCount: failed.length,
                    processed,
                    skipped,
                    failed
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 8.5 服务端异步后台归档服务 (容器后台驻留执行，即使前端页面关闭也能平稳运行到底)
    app.post('/api/tmdb-organize/async-resolve', async (req, res) => {
        try {
            const { AsyncResolveService } = require('../services/AsyncResolveService');
            const data = await AsyncResolveService.startJob(req.body);
            res.json({ success: true, data });
        } catch (error) {
            logger.error(`[后台归档API] 启动失败: ${error.message}`, error);
            res.status(400).json({ success: false, error: error.message });
        }
    });

    app.get('/api/tmdb-organize/async-resolve/status', (req, res) => {
        try {
            const { AsyncResolveService } = require('../services/AsyncResolveService');
            const status = AsyncResolveService.getStatus();
            res.json({ success: true, data: status });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/tmdb-organize/async-resolve/abort', (req, res) => {
        try {
            const { AsyncResolveService } = require('../services/AsyncResolveService');
            const aborted = AsyncResolveService.abort();
            res.json({ success: true, data: { aborted } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // STRM 文件生成与 302 直链播放服务
    // ═════════════════════════════════════════════════════════════════════

    // 1. 原生 302 直链反代流播放接口 (支持 Emby / Jellyfin / Infuse / 播放器直连，零服务器中转带宽)
    app.get(['/api/strm/stream/:fileId/:filename?', '/api/strm/stream'], async (req, res) => {
        try {
            const fileId = req.params.fileId || req.query.fileId;
            const accountId = req.query.accountId;
            const fileName = req.params.filename || req.query.filename || fileId;
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '未知IP';

            if (!fileId) {
                logger.warn(`[STRM 302] 请求缺失 fileId 参数, 客户端: ${clientIp}`);
                return res.status(400).send('缺少必要的文件 ID (fileId)');
            }

            logger.info(`[STRM 302] 客户端请求媒体取流: ${fileName} (fileId: ${fileId}), 客户端: ${clientIp}`);

            const accountRepo = AppDataSource.getRepository(Account);
            const account = (accountId ? await accountRepo.findOne({ where: { id: Number(accountId), accountType: 'cloud139' } }) : null)
                || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            if (!account) {
                const noAccountMsg = `[STRM 302] 取流失败: 未找到可用的 139 网盘账号`;
                logger.error(noAccountMsg);
                logTaskEvent(noAccountMsg);
                return res.status(404).send('未找到可用的 139 网盘账号');
            }
            const cloud139 = Cloud139Service.getInstance(account);
            try {
                const directUrl = await cloud139.getDownloadUrl(fileId);
                if (!directUrl) {
                    const failDirectMsg = `[STRM 302] 获取 139 官方 CDN 直链为空: ${fileName} (fileId: ${fileId})`;
                    logger.error(failDirectMsg);
                    logTaskEvent(failDirectMsg);
                    return res.status(502).send('获取 139 官方 CDN 直链失败');
                }
                const cleanName = path.basename(String(fileName || 'video.mp4'));
                const safeAsciiName = encodeURIComponent(cleanName);

                // 若请求显式携带了 mode=302 或 redirect=true，则保留纯 302 重定向
                if (req.query.redirect === 'true' || req.query.mode === '302') {
                    logger.info(`[STRM 取流] 响应 302 重定向: ${fileName} (fileId: ${fileId})`);
                    res.setHeader('Content-Disposition', `inline; filename="${safeAsciiName}"; filename*=UTF-8''${safeAsciiName}`);
                    return res.redirect(302, directUrl);
                }

                // 默认高性能流式直推 (Stream Proxy Pipeline)
                // 彻底解决 139 预签名 S3 强制返回 Content-Disposition: attachment 导致浏览器强制弹下载和 UUID 乱码文件名的问题
                logger.info(`[STRM 流式推流] 启动流式直推: ${fileName} (fileId: ${fileId}), Range: ${req.headers.range || '全量'}`);
                
                const cdnHeaders = {};
                if (req.headers.range) {
                    cdnHeaders.range = req.headers.range;
                }

                const cdnReq = https.get(directUrl, { headers: cdnHeaders }, (cdnRes) => {
                    const statusCode = cdnRes.statusCode || 200;
                    const ext = path.extname(cleanName).toLowerCase();
                    const mimeType = ext === '.mp4' || ext === '.m4v' ? 'video/mp4'
                        : (ext === '.mkv' ? 'video/x-matroska'
                        : (ext === '.ts' ? 'video/mp2t'
                        : (ext === '.avi' ? 'video/x-msvideo'
                        : (ext === '.webm' ? 'video/webm' : (cdnRes.headers['content-type'] || 'video/mp4')))));

                    const outHeaders = {
                        'Content-Type': mimeType,
                        'Accept-Ranges': 'bytes',
                        'Content-Disposition': `inline; filename="${safeAsciiName}"; filename*=UTF-8''${safeAsciiName}`,
                        'Access-Control-Allow-Origin': '*'
                    };

                    if (cdnRes.headers['content-range']) outHeaders['Content-Range'] = cdnRes.headers['content-range'];
                    if (cdnRes.headers['content-length']) outHeaders['Content-Length'] = cdnRes.headers['content-length'];

                    res.writeHead(statusCode, outHeaders);
                    cdnRes.pipe(res);
                });

                cdnReq.on('error', (cdnErr) => {
                    logger.error(`[STRM 流式推流] CDN 请求错误: ${cdnErr.message}`);
                    if (!res.headersSent) {
                        res.status(502).send(`CDN 取流失败: ${cdnErr.message}`);
                    }
                });

                req.on('close', () => {
                    cdnReq.destroy();
                });
            } catch (err) {
                const errMsg = err.message || '';
                if (errMsg.includes('04000010') || errMsg.includes('资源不存在') || errMsg.includes('04000002') || errMsg.includes('00010002')) {
                    const deadLinkMsg = `[STRM 302] 播放失败 (404): 网盘文件已不存在或已被移动/删除: ${fileName} (ID: ${fileId})`;
                    logger.warn(deadLinkMsg);
                    logTaskEvent(deadLinkMsg);
                    return res.status(404).send(`网盘文件已不存在或已被移动/删除 (ID: ${fileId})，请在管理面板中为指定媒体目录重新生成 STRM 映射`);
                }
                const failMsg = `[STRM 302] 直链获取异常: ${fileName} (ID: ${fileId}), 错误: ${errMsg}`;
                logger.error(failMsg);
                logTaskEvent(failMsg);
                return res.status(500).send(`直链获取失败: ${err.message}`);
            }
        } catch (err) {
            const serverErrMsg = `[STRM 302] 直链服务异常: ${err.message}`;
            logger.error(serverErrMsg);
            logTaskEvent(serverErrMsg);
            return res.status(500).send(`直链获取失败: ${err.message}`);
        }
    });

    // 2. 媒体整理后手动/批量触发 STRM 生成接口（支持传入特定 files 或从用户指定网盘目录递归扫描）
    app.post('/api/strm/generate-organized', async (req, res) => {
        try {
            const body = req.body || {};
            const files = Array.isArray(body.files) ? body.files : [];
            const options = body.options || body || {};
            const accountId = body.accountId || options.accountId;
            const specifiedFolderId = body.folderId || options.folderId;
            const specifiedFolderName = body.folderPath || options.folderPath || body.folderName || options.folderName;
            const cleanObsolete = options.cleanObsolete !== false;

            const { StrmService } = require('../services/strm');
            const strmService = new StrmService();

            let targetFiles = [...files];

            // 多源目录支持：支持 sourceCatalogs 列表 [{ id, name }] 或单 folderId/folderPath
            const sourceCatalogs = Array.isArray(body.sourceCatalogs) && body.sourceCatalogs.length > 0
                ? body.sourceCatalogs
                : (Array.isArray(options.sourceCatalogs) && options.sourceCatalogs.length > 0
                    ? options.sourceCatalogs
                    : (specifiedFolderId ? [{ id: specifiedFolderId, name: specifiedFolderName || '指定目录' }] : []));

            const rawVideoSuffixes = body.videoSuffixes || options.videoSuffixes || ConfigService.getConfigValue('strm.videoSuffixes');
            const minSizeMB = Number(body.minSizeMB ?? options.minSizeMB ?? ConfigService.getConfigValue('strm.minSizeMB') ?? 0);
            const strmBaseUrl = (body.strmBaseUrl || options.strmBaseUrl || ConfigService.getConfigValue('strm.strmBaseUrl') || ConfigService.getConfigValue('system.baseUrl') || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const cleanEmptyDirs = body.cleanEmptyDirs ?? options.cleanEmptyDirs ?? ConfigService.getConfigValue('strm.cleanEmptyDirs') !== false;

            // 若传入了 strmBaseUrl 或 videoSuffixes，持久化保存至配置中
            if (body.strmBaseUrl || body.videoSuffixes || body.minSizeMB !== undefined) {
                const currentStrmCfg = ConfigService.getConfigValue('strm') || {};
                ConfigService.setConfigValue('strm', {
                    ...currentStrmCfg,
                    ...(body.strmBaseUrl ? { strmBaseUrl } : {}),
                    ...(body.videoSuffixes ? { videoSuffixes: body.videoSuffixes } : {}),
                    ...(body.minSizeMB !== undefined ? { minSizeMB } : {}),
                    ...(body.cleanEmptyDirs !== undefined ? { cleanEmptyDirs } : {}),
                    ...(sourceCatalogs.length > 0 ? { sourceCatalogs } : {})
                });
            }

            // 若未提供显式 files 列表，则按用户指定的源目录列表从 139 网盘实际并行/递归扫描
            if (targetFiles.length === 0) {
                const { AppDataSource } = require('../database');
                const { Account } = require('../entities');

                const videoSuffixList = (Array.isArray(rawVideoSuffixes)
                    ? rawVideoSuffixes
                    : (typeof rawVideoSuffixes === 'string' ? rawVideoSuffixes.split(/[;,]/) : StrmService.DEFAULT_VIDEO_EXTS)
                )
                    .map(s => String(s).trim().toLowerCase().replace(/^\./, ''))
                    .filter(Boolean)
                    .map(s => '.' + s);

                const accountRepo = AppDataSource && AppDataSource.isInitialized ? AppDataSource.getRepository(Account) : null;
                const account = accountRepo ? (
                    (accountId ? await accountRepo.findOne({ where: { id: Number(accountId) } }) : null)
                    || (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } }))
                    || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }))
                    || (await accountRepo.findOne({ where: { isActive: true } }))
                    || (await accountRepo.findOne())
                ) : null;

                if (!account) {
                    return res.status(400).json({ success: false, error: '未找到可用的 139 网盘账号' });
                }

                const { Cloud139Service } = require('../services/cloud139');
                const cloud139 = Cloud139Service.getInstance(account);

                // 解析目标待扫描目录列表
                let targetCatalogsToScan = [...sourceCatalogs];
                if (targetCatalogsToScan.length === 0) {
                    const defaultTargetFolderId = ConfigService.getConfigValue('channelMonitor.defaultTargetFolderId');
                    const defaultTargetFolderName = ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName') || '目标目录';
                    if (defaultTargetFolderId && defaultTargetFolderId !== '/' && defaultTargetFolderId !== '-11') {
                        targetCatalogsToScan.push({ id: defaultTargetFolderId, name: defaultTargetFolderName });
                    } else {
                        targetCatalogsToScan.push({ id: '/', name: '根目录' });
                    }
                }

                const scanSummaryMsg = `[STRM生成] 启动扫描 ${targetCatalogsToScan.length} 个源目录: [${targetCatalogsToScan.map(c => c.name || c.id).join(', ')}], 播放地址: ${strmBaseUrl}, 小视频阈值: ${minSizeMB}MB`;
                logger.info(scanSummaryMsg);
                logTaskEvent(scanSummaryMsg);

                const seenFileIds = new Set();
                let scannedDirCount = 0;

                for (const cat of targetCatalogsToScan) {
                    const catId = typeof cat === 'object' ? (cat.id || cat.catalogId) : cat;
                    const catName = typeof cat === 'object' ? (cat.name || catId) : catId;

                    const scanCatalog = async (currentCatalogId, relativePath = '') => {
                        scannedDirCount++;
                        const items = await cloud139.listDiskDirAll(currentCatalogId).catch(err => {
                            logger.error(`[STRM生成] 扫描目录 (${currentCatalogId}) 失败: ${err.message}`);
                            return [];
                        });

                        for (const item of items) {
                            const fileId = item.fileId || item.id;
                            if (!fileId || seenFileIds.has(String(fileId))) continue;

                            const name = item.name || item.fileName || '';
                            if (item.type === 'folder') {
                                const subRel = relativePath ? `${relativePath}/${name}` : name;
                                await scanCatalog(fileId, subRel);
                            } else {
                                const ext = path.extname(name).toLowerCase();
                                const size = Number(item.size || 0);

                                if (videoSuffixList.includes(ext)) {
                                    seenFileIds.add(String(fileId));
                                    targetFiles.push({
                                        fileId,
                                        id: fileId,
                                        name,
                                        finalName: name,
                                        originalName: name,
                                        targetFolderPath: relativePath,
                                        size,
                                        accountId: account.id
                                    });
                                }
                            }
                        }
                    };

                    await scanCatalog(catId, '');
                }

                const scanDoneMsg = `[STRM生成] 网盘源目录扫描完毕: 遍历 ${scannedDirCount} 个目录，发现 ${targetFiles.length} 个视频文件`;
                logger.info(scanDoneMsg);
                logTaskEvent(scanDoneMsg);
            }

            // 若仍无媒体文件，返回成功并带空统计与提示信息，杜绝抛出 400 报错
            if (targetFiles.length === 0) {
                const emptyMsg = `[STRM生成] 指定源目录中暂未检测到媒体文件，已终止生成`;
                logger.info(emptyMsg);
                logTaskEvent(emptyMsg);
                return res.json({
                    success: true,
                    data: {
                        total: 0,
                        totalFiles: 0,
                        successCount: 0,
                        generatedStrm: 0,
                        skippedCount: 0,
                        skipped: 0,
                        failedCount: 0,
                        errors: 0,
                        results: [],
                        outputDir: strmService.baseDir,
                        folderName: sourceCatalogs.map(c => c.name || c.id).join(', ') || '指定目录',
                        message: '指定源目录中暂未检测到匹配后缀的视频资产'
                    }
                });
            }

            const result = await strmService.generateForOrganizedFiles(targetFiles, {
                ...options,
                videoSuffixes: rawVideoSuffixes,
                minSizeMB,
                strmBaseUrl,
                cleanEmptyDirs,
                cleanObsolete,
                accountId
            });

            const firstSuccess = (result.results || []).find(r => r.content);
            const sampleRealUrl = firstSuccess ? firstSuccess.content : '';
            const sampleRealName = firstSuccess ? (firstSuccess.originalFile || firstSuccess.strmFile || '') : '';

            res.json({
                success: true,
                data: {
                    ...result,
                    totalFiles: result.total ?? targetFiles.length,
                    generatedStrm: result.successCount ?? 0,
                    skipped: result.skippedCount ?? 0,
                    errors: result.failedCount ?? 0,
                    outputDir: result.outputDir || strmService.baseDir,
                    cleanedObsoleteCount: result.cleanedObsoleteCount ?? 0,
                    metaSyncedCount: result.metaSyncedCount ?? 0,
                    folderName: sourceCatalogs.map(c => c.name || c.id).join(', ') || '多源目录',
                    sampleRealUrl,
                    sampleRealName
                }
            });
        } catch (error) {
            const apiErrMsg = `[STRM生成] 接口调用异常: ${error.message}`;
            logger.error(apiErrMsg, { error: error.message });
            logTaskEvent(apiErrMsg);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 双分栏手动整理沙箱：0 物理写入实时推演
    app.post('/api/scrape/sandbox-preview', async (req, res) => {
        try {
            const {
                fileName = '',
                targetDirPath = '/媒体库',
                tmdbId,
                mediaType,
                season,
                episode,
                episodeTitle,
                specsOverride = {}
            } = req.body || {};

            const sampleFile = String(fileName || '').trim();
            if (!sampleFile) {
                return res.status(400).json({ success: false, error: '原文件名不能为空' });
            }

            const ext = path.extname(sampleFile).replace(/^\./, '').toLowerCase();
            const parsed = RecognitionEngine.parseMediaFilename(sampleFile);

            let tmdbData = null;
            let candidateTitle = parsed.title;
            let candidateYear = parsed.year;
            let candidateType = mediaType || parsed.mediaType || 'movie';

            if (tmdbId) {
                const { TMDBService } = require('../services/tmdb');
                const tmdb = new TMDBService();
                try {
                    if (candidateType === 'tv') {
                        tmdbData = await tmdb.getTVDetails(tmdbId);
                        candidateTitle = tmdbData?.name || candidateTitle;
                        candidateYear = tmdbData?.first_air_date ? tmdbData.first_air_date.slice(0, 4) : candidateYear;
                    } else {
                        tmdbData = await tmdb.getMovieDetails(tmdbId);
                        candidateTitle = tmdbData?.title || candidateTitle;
                        candidateYear = tmdbData?.release_date ? tmdbData.release_date.slice(0, 4) : candidateYear;
                    }
                } catch (tmdbErr) {
                    logger.warn(`[沙箱推演] 获取 TMDB 详情失败: ${tmdbErr.message}`);
                }
            }

            const effSeason = season !== undefined && season !== '' ? Number(season) : (parsed.season || 1);
            const effEpisode = episode !== undefined && episode !== '' ? Number(episode) : (parsed.episode || 1);
            const isTv = candidateType === 'tv';

            const targetFields = {
                mediaType: candidateType,
                title: candidateTitle,
                chineseTitle: tmdbData?.title_zh || candidateTitle,
                year: candidateYear || '',
                id: tmdbId ? String(tmdbId) : '',
                tmdbId: tmdbId ? String(tmdbId) : '',
                seasonEpisode: isTv ? `S${String(effSeason).padStart(2, '0')}E${String(effEpisode).padStart(2, '0')}` : '',
                season: effSeason,
                episode: effEpisode,
                episodeTitle: episodeTitle || parsed.episodeTitle || '',
                resolution: specsOverride.resolution || parsed.resolution || '',
                mediaSource: specsOverride.mediaSource || parsed.mediaSource || '',
                resourceType: specsOverride.resourceType || parsed.resourceType || '',
                dynamicRange: specsOverride.dynamicRange || parsed.dynamicRange || '',
                videoCodec: specsOverride.videoCodec || parsed.videoCodec || '',
                audioCodec: specsOverride.audioCodec || parsed.audioCodec || '',
                releaseGroup: specsOverride.releaseGroup || parsed.releaseGroup || '',
                ext
            };

            const targetInfo = RecognitionEngine.buildStandardTargetName(targetFields, ext);
            const cleanTargetBase = targetDirPath.replace(/\/+$/, '') || '';
            const fullTargetPath = `${cleanTargetBase}/${targetInfo.fullRelativePath}`.replace(/\/+/g, '/');

            res.json({
                success: true,
                data: {
                    source: {
                        fileName: sampleFile,
                        parsed
                    },
                    target: {
                        fileName: targetInfo.filename,
                        folderName: targetInfo.folderName,
                        seasonFolder: targetInfo.seasonFolder,
                        fullRelativePath: targetInfo.fullRelativePath,
                        fullTargetPath
                    },
                    fields: targetFields,
                    tmdbData: tmdbData ? {
                        id: tmdbData.id,
                        title: tmdbData.title || tmdbData.name,
                        year: candidateYear,
                        poster_path: tmdbData.poster_path,
                        overview: tmdbData.overview
                    } : null
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 手动规范整理与物理归档执行接口 (带 WAL 与自愈记忆)
    app.post('/api/scrape/manual-organize', async (req, res) => {
        try {
            const {
                accountId,
                fileId,
                fileName,
                currentDirId,
                currentDirPath,
                targetDirId,
                targetDirPath,
                targetSubDir,
                organizedFileName,
                tmdbId,
                mediaType,
                season,
                episode,
                title,
                year,
                saveBinding,
                folderKey
            } = req.body || {};

            if (!fileId || !organizedFileName || !targetDirId) {
                return res.status(400).json({ success: false, error: '必填参数缺失' });
            }

            if (currentDirId && targetDirId && String(currentDirId) === String(targetDirId)) {
                return res.status(400).json({ success: false, error: '源目录与目标目录不能相同' });
            }

            const { MediaScrapeService } = require('../services/MediaScrapeService');
            const { ScrapeJournalService } = require('../services/ScrapeJournalService');
            const adapter = await MediaScrapeService.getAdapter({
                driveType: 'cloud139',
                accountId
            });

            // 1. 创建批次并登记写前日志 (WAL)
            const batch = await ScrapeJournalService.createBatch({
                driveType: 'cloud139',
                accountId: Number(accountId || 0),
                rootRef: currentDirId || '/',
                rootPath: currentDirPath || '/',
                targetRootRef: targetDirId,
                targetRootPath: targetDirPath,
                trigger: 'manual',
                organize: true
            });

            const op = {
                driveType: 'cloud139',
                accountId: Number(accountId || 0),
                kind: 'video',
                fileRef: fileId,
                oldParentRef: currentDirId || '/',
                oldParentPath: currentDirPath || '/',
                oldName: fileName,
                newName: organizedFileName,
                newParentPath: `${targetDirPath}/${targetSubDir}`.replace(/\/+/g, '/'),
                targetSubDir,
                mediaType: mediaType || 'movie',
                tmdbId: tmdbId ? String(tmdbId) : null,
                season: (mediaType === 'movie') ? null : (season !== undefined && season !== '' ? Number(season) : null),
                episode: (mediaType === 'movie') ? null : (episode !== undefined && episode !== '' ? Number(episode) : null),
                title: title || fileName,
                year: year ? String(year) : null,
                confidence: 300,
                status: 'applying',
                source: 'manual'
            };

            const [record] = await ScrapeJournalService.recordOperations(batch.id, [op]);

            try {
                // 2. 幂等创建目标目录树
                let currentParentRef = targetDirId;
                const pathSegments = (targetSubDir || '').split('/').filter(Boolean);
                for (const seg of pathSegments) {
                    currentParentRef = await adapter.ensureDir(currentParentRef, seg);
                }

                // 3. 跨目录移动
                await adapter.batchMove([fileId], currentParentRef);

                // 4. 重命名为 139 标准点分洗版物理名
                if (organizedFileName !== fileName) {
                    await adapter.rename(fileId, organizedFileName);
                }

                // 5. 更新 WAL 为 applied
                await ScrapeJournalService.markApplied([record.id], { [record.id]: fileId });
                if (ScrapeJournalService.recordRepo) {
                    await ScrapeJournalService.recordRepo.update(record.id, {
                        newParentRef: String(currentParentRef)
                    });
                }

                // 6. 持久化自愈记忆 (ScrapeBinding)
                if (saveBinding && tmdbId && folderKey) {
                    await ScrapeJournalService.saveBinding({
                        driveType: 'cloud139',
                        accountId: Number(accountId || 0),
                        folderKey,
                        tmdbId: String(tmdbId),
                        mediaType: mediaType || 'tv',
                        action: 'bind'
                    });
                }

                res.json({
                    success: true,
                    data: {
                        batchId: batch.id,
                        recordId: record.id,
                        organizedFileName,
                        targetPath: `${targetDirPath}/${targetSubDir}/${organizedFileName}`.replace(/\/+/g, '/')
                    }
                });
            } catch (execErr) {
                await ScrapeJournalService.markFailed(record.id, execErr.message);
                throw execErr;
            }
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 139 网盘文件穿梭浏览器：文件与文件夹全量列表 (携带媒体规格透传)
    app.get('/api/cloud139/files', async (req, res) => {
        try {
            const accountId = parseInt(req.query.accountId);
            const folderId = req.query.folderId || '/';
            const account = await accountRepo.findOneBy({ id: accountId });
            ensureCloud139Account(account, '文件列表读取');

            const cloud139 = Cloud139Service.getInstance(account);
            const catalogID = folderId === '-11' ? '/' : folderId;
            const listResult = await cloud139.listDiskDir(catalogID);
            if (!listResult) throw new Error('获取文件列表失败');

            const items = listResult.items.map(item => {
                let specs = null;
                if (item.type !== 'folder') {
                    const parsed = RecognitionEngine.parseMediaFilename(item.name);
                    specs = {
                        resolution: parsed.resolution || parsed.videoFormat || '',
                        videoFormat: parsed.videoFormat || '',
                        videoCodec: parsed.videoCodec || '',
                        audioCodec: parsed.audioCodec || '',
                        dynamicRange: parsed.dynamicRange || '',
                        releaseGroup: parsed.releaseGroup || '',
                        mediaType: parsed.mediaType || 'movie',
                        title: parsed.title || '',
                        year: parsed.year || ''
                    };
                }
                return {
                    fileId: item.fileId,
                    name: item.name,
                    type: item.type,
                    size: item.size,
                    updatedAt: item.updatedAt,
                    extension: item.extension,
                    specs
                };
            });

            res.json({
                success: true,
                data: {
                    folderId: catalogID,
                    items,
                    nextCursor: listResult.nextCursor
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 139 网盘文件重命名
    app.post('/api/cloud139/rename', async (req, res) => {
        try {
            const { accountId, fileId, newName } = req.body || {};
            if (!fileId || !newName || !String(newName).trim()) {
                return res.status(400).json({ success: false, error: '文件ID或新名称不能为空' });
            }
            const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
            ensureCloud139Account(account, '文件重命名');

            const cloud139 = Cloud139Service.getInstance(account);
            await cloud139.renameFile(fileId, String(newName).trim());
            folderCache.clearPrefix(`folders_${accountId}_`);

            res.json({ success: true, data: { fileId, newName: String(newName).trim() } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 139 网盘文件安全移入回收站 (batchTrash，绝不硬删除)
    app.post('/api/cloud139/trash', async (req, res) => {
        try {
            const { accountId, fileIds } = req.body || {};
            if (!Array.isArray(fileIds) || fileIds.length === 0) {
                return res.status(400).json({ success: false, error: 'fileIds 不能为空' });
            }
            const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
            ensureCloud139Account(account, '移入回收站');

            const cloud139 = Cloud139Service.getInstance(account);
            await cloud139.batchTrash(fileIds);
            folderCache.clearPrefix(`folders_${accountId}_`);

            res.json({ success: true, data: { trashedIds: fileIds } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });



    // ─── Telegram 频道流式监控管理接口 ──────────────────────────────────────────────

    // 获取所有频道监控配置
    app.get('/api/channel-monitors', async (req, res) => {
        try {
            const monitorRepo = getChannelMonitorRepository();
            const monitors = await monitorRepo.find({ order: { id: 'DESC' } });
            res.json({ success: true, data: monitors });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 创建新的频道监控配置
    app.post('/api/channel-monitors', async (req, res) => {
        try {
            const {
                name,
                channelUrl,
                accountId,
                targetFolderId = '/',
                targetFolderName = '媒体库根目录',
                stagingFolderId = '',
                stagingFolderName = '',
                filterKeywords = '',
                excludeKeywords = '',
                autoOrganize = true,
                autoWash = true,
                status = 'active',
                cronExpression = ''
            } = req.body;

            if (!name || !channelUrl || !accountId) {
                return res.status(400).json({ success: false, error: '名称、频道地址和关联账号不能为空' });
            }

            const monitorRepo = getChannelMonitorRepository();
            const monitor = monitorRepo.create({
                name: name.trim(),
                channelUrl: channelUrl.trim(),
                accountId: Number(accountId),
                targetFolderId: targetFolderId || '/',
                targetFolderName: targetFolderName || '媒体库根目录',
                stagingFolderId: (stagingFolderId || '').trim(),
                stagingFolderName: (stagingFolderName || '').trim(),
                filterKeywords: (filterKeywords || '').trim(),
                excludeKeywords: (excludeKeywords || '').trim(),
                autoOrganize: Boolean(autoOrganize),
                autoWash: Boolean(autoWash),
                status: status || 'active',
                cronExpression: (cronExpression || '').trim(),
                lastMessageId: 0
            });

            const saved = await monitorRepo.save(monitor);
            res.json({ success: true, data: saved });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新频道监控配置
    app.put('/api/channel-monitors/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const monitorRepo = getChannelMonitorRepository();
            const monitor = await monitorRepo.findOne({ where: { id } });
            if (!monitor) {
                return res.status(404).json({ success: false, error: '监控配置不存在' });
            }

            const {
                name,
                channelUrl,
                accountId,
                targetFolderId,
                targetFolderName,
                stagingFolderId,
                stagingFolderName,
                filterKeywords,
                excludeKeywords,
                autoOrganize,
                autoWash,
                status,
                cronExpression
            } = req.body;

            if (name !== undefined) monitor.name = name.trim();
            if (channelUrl !== undefined) monitor.channelUrl = channelUrl.trim();
            if (accountId !== undefined) monitor.accountId = Number(accountId);
            if (targetFolderId !== undefined) monitor.targetFolderId = targetFolderId;
            if (targetFolderName !== undefined) monitor.targetFolderName = targetFolderName;
            if (stagingFolderId !== undefined) monitor.stagingFolderId = (stagingFolderId || '').trim();
            if (stagingFolderName !== undefined) monitor.stagingFolderName = (stagingFolderName || '').trim();
            if (filterKeywords !== undefined) monitor.filterKeywords = (filterKeywords || '').trim();
            if (excludeKeywords !== undefined) monitor.excludeKeywords = (excludeKeywords || '').trim();
            if (autoOrganize !== undefined) monitor.autoOrganize = Boolean(autoOrganize);
            if (autoWash !== undefined) monitor.autoWash = Boolean(autoWash);
            if (status !== undefined) monitor.status = status;
            if (cronExpression !== undefined) monitor.cronExpression = (cronExpression || '').trim();

            const saved = await monitorRepo.save(monitor);
            res.json({ success: true, data: saved });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除频道监控配置
    app.delete('/api/channel-monitors/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const monitorRepo = getChannelMonitorRepository();
            const monitor = await monitorRepo.findOne({ where: { id } });
            if (!monitor) {
                return res.status(404).json({ success: false, error: '监控配置不存在' });
            }

            await monitorRepo.remove(monitor);
            res.json({ success: true, data: { id } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 立即执行频道扫描
    app.post('/api/channel-monitors/:id/scan', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const service = TgChannelMonitorService.getInstance();
            const result = await service.scanSingleMonitor(id);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 查询频道转存历史记录
    app.get('/api/channel-monitors/history', async (req, res) => {
        try {
            const historyRepo = getChannelMonitorHistoryRepository();
            const { channelId, status, page = 1, pageSize = 20 } = req.query;

            const where = {};
            if (channelId) where.channelId = Number(channelId);
            if (status) {
                if (status === 'success' || status === 'transferred') {
                    where.status = In(['success', 'transferred']);
                } else if (status === 'skipped') {
                    where.status = Like('skipped%');
                } else {
                    where.status = status;
                }
            }

            const [items, total] = await historyRepo.findAndCount({
                where,
                order: { id: 'DESC' },
                skip: (Number(page) - 1) * Number(pageSize),
                take: Number(pageSize)
            });

            // 健壮性自愈：针对历史记录中已归档但早期未记录 posterPath / tmdbId 的条目执行自愈补全
            try {
                const { TMDBService } = require('../services/tmdb');
                const tmdbService = new TMDBService();
                for (const item of items) {
                    if (item.transferredDetails) {
                        const details = typeof item.transferredDetails === 'string' ? JSON.parse(item.transferredDetails) : item.transferredDetails;
                        if (Array.isArray(details) && details.length > 0) {
                            let dirty = false;
                            for (const d of details) {
                                if (d.targetFolderPath && (!d.tmdbId || !d.posterPath || !d.mediaType)) {
                                    const m = d.targetFolderPath.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                                    if (m) {
                                        d.tmdbId = m[1];
                                        if (!d.mediaType) {
                                            d.mediaType = (d.targetFolderPath.includes('/剧集/') || /S\d+E\d+|Season\s*\d+/i.test(d.targetFolderPath + ' ' + (d.originalName || ''))) ? 'tv' : 'movie';
                                        }
                                        if (!d.posterPath && tmdbService.credential) {
                                            const matches = await tmdbService.lookupById(d.tmdbId, d.mediaType).catch(() => []);
                                            if (matches && matches[0]?.posterPath) {
                                                d.posterPath = matches[0].posterPath;
                                                dirty = true;
                                            }
                                        }
                                    }
                                }
                            }
                            if (dirty) {
                                item.transferredDetails = JSON.stringify(details);
                                historyRepo.update(item.id, { transferredDetails: item.transferredDetails }).catch(() => {});
                            }
                        }
                    }
                }
            } catch (_) {}

            res.json({
                success: true,
                data: {
                    items,
                    total,
                    page: Number(page),
                    pageSize: Number(pageSize)
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 重试单条频道监控历史转存
    app.post('/api/channel-monitors/history/:id/retry', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const service = TgChannelMonitorService.getInstance();
            const result = await service.retryHistoryItem(id);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 批量重试频道监控历史转存
    app.post('/api/channel-monitors/history/retry-batch', async (req, res) => {
        try {
            const { ids, accountId, allFailed, limit } = req.body || {};
            const service = TgChannelMonitorService.getInstance();
            const result = await service.retryBatchHistoryItems({ ids, accountId, allFailed, limit });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── Telegram 集中控制大盘接口 ──────────────────────────────────────────

    // 获取全局集中频道监控配置
    app.get('/api/channel/global-config', async (req, res) => {
        try {
            const config = ConfigService.getConfigValue('channelMonitor', {});
            res.json({
                success: true,
                data: {
                    enabled: config.enabled ?? true,
                    accountId: config.accountId || null,
                    channels: Array.isArray(config.channels) ? config.channels : [],
                    defaultTargetFolderId: config.defaultTargetFolderId || 'FtakjmnewOP2CFDarHL9I66zXFiUCsB19',
                    defaultTargetFolderName: (config.defaultTargetFolderName && config.defaultTargetFolderName !== '默认媒体库' && config.defaultTargetFolderName !== '默认媒体库 (/)') ? config.defaultTargetFolderName : '/媒体库',
                    dispatchRules: Array.isArray(config.dispatchRules) ? config.dispatchRules : [],
                    whitelistRegex: config.whitelistRegex || '',
                    blacklistKeywords: Array.isArray(config.blacklistKeywords) ? config.blacklistKeywords : [],
                    visualCards: Array.isArray(config.visualCards) ? config.visualCards : [],
                    stagingFolderId: config.stagingFolderId || '',
                    stagingFolderName: (config.stagingFolderName && config.stagingFolderName !== '/暂存区/频道转存') ? config.stagingFolderName : '/临时存放',
                    autoOrganize: config.autoOrganize ?? true,
                    autoWash: config.autoWash ?? true,
                    minFileSize: config.minFileSize ?? 50,
                    ignoreKeywords: config.ignoreKeywords || '',
                    ignoreAudiobooks: config.ignoreAudiobooks !== undefined ? Boolean(config.ignoreAudiobooks) : true,
                    classifyChildren: config.classifyChildren ?? false,
                    classifyConcerts: config.classifyConcerts ?? true,
                    classifyRegion: config.classifyRegion ?? true,
                    classifyYear: config.classifyYear ?? false,
                    washPriorityOrder: Array.isArray(config.washPriorityOrder) && config.washPriorityOrder.length ? config.washPriorityOrder : [
                        'videoFormat',
                        'dynamicRange',
                        'videoCodec',
                        'resourceType',
                        'releaseGroup',
                        'colorDepth',
                        'audioCodec',
                        'frameRate',
                        'fileSize'
                    ],
                    keepDolbyMultiVersion: config.keepDolbyMultiVersion ?? false,
                    notifyOnOrganize: config.notifyOnOrganize ?? true,
                    linkStrm: config.linkStrm ?? false,
                    notifyOnStrm: config.notifyOnStrm ?? false,
                    scanInterval: config.scanInterval ?? 5,
                    videoExtensions: Array.isArray(config.videoExtensions) && config.videoExtensions.length ? config.videoExtensions : ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'wmv', 'ts'],
                    metadataExtensions: Array.isArray(config.metadataExtensions) && config.metadataExtensions.length ? config.metadataExtensions : ['ass', 'srt', 'ssa', 'sub', 'vtt'],
                    enableRename: config.enableRename ?? true,
                    enableMediaInfo: config.enableMediaInfo ?? true,
                    includeEpisodeTitle: config.includeEpisodeTitle ?? true,
                    sweepEmptyFolders: config.sweepEmptyFolders ?? true,
                    ai: config.ai || {
                        enable: false,
                        provider: 'mobile',
                        providerName: '移动灵犀',
                        baseUrl: 'https://ai.yun.139.com',
                        apiKey: '',
                        model: '移动灵犀智能大模型',
                        mode: 'fallback'
                    }
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 保存全局集中频道监控配置
    app.post('/api/channel/global-config', async (req, res) => {
        try {
            const {
                accountId,
                enabled = true,
                channels = [],
                stagingFolderId = '',
                stagingFolderName = '/临时存放',
                defaultTargetFolderId = 'FtakjmnewOP2CFDarHL9I66zXFiUCsB19',
                defaultTargetFolderName = '/媒体库',
                dispatchRules = [],
                whitelistRegex = '',
                blacklistKeywords = [],
                visualCards = [],
                scanInterval,
                organizeInterval,
                organizeCron,
                videoExtensions,
                metadataExtensions,
                enableRename = true,
                enableMediaInfo = true,
                includeEpisodeTitle = true,
                sweepEmptyFolders = true,
                autoOrganize = true,
                autoWash = true,
                minFileSize = 50,
                ignoreKeywords = '',
                ignoreAudiobooks,
                classifyChildren = false,
                classifyConcerts = true,
                classifyRegion = true,
                classifyYear = false,
                washPriorityOrder,
                keepDolbyMultiVersion = false,
                notifyOnOrganize = true,
                linkStrm = false,
                notifyOnStrm = false,
                ai
            } = req.body || {};

            // 基础校验白名单正则语法（防 ReDoS 报错）
            if (whitelistRegex && String(whitelistRegex).trim()) {
                try {
                    new RegExp(String(whitelistRegex).trim());
                } catch (regexErr) {
                    return res.status(400).json({ success: false, error: `白名单正则表达式语法错误: ${regexErr.message}` });
                }
            }

            const current = ConfigService.getConfigValue('channelMonitor', {});

            // 互斥校验：源暂存目录与目标归档目录不能相同
            const cleanStagingId = stagingFolderId !== undefined ? String(stagingFolderId || '').trim() : (current.stagingFolderId || '');
            const cleanTargetId = defaultTargetFolderId !== undefined ? String(defaultTargetFolderId || '/').trim() : (current.defaultTargetFolderId || '/');
            if (cleanStagingId && cleanTargetId && cleanStagingId === cleanTargetId) {
                return res.status(400).json({
                    success: false,
                    error: '源暂存目录与目标归档目录不能相同，否则会导致重复扫描与死循环归档！'
                });
            }

            const safeScanInterval = scanInterval !== undefined ? Math.max(1, Number(scanInterval) || 5) : (current.scanInterval || 5);
            const safeOrganizeInterval = organizeInterval !== undefined ? Math.max(1, Number(organizeInterval) || 30) : (current.organizeInterval || 30);
            const updated = {
                ...current,
                accountId: accountId !== undefined ? (accountId ? (Number(accountId) || String(accountId)) : null) : current.accountId,
                enabled: enabled !== undefined ? Boolean(enabled) : (current.enabled !== undefined ? Boolean(current.enabled) : true),
                channels: channels !== undefined ? (Array.isArray(channels) ? channels.map(c => String(c).trim()).filter(Boolean) : []) : (current.channels || []),
                stagingFolderId: cleanStagingId,
                stagingFolderName: stagingFolderName !== undefined ? String(stagingFolderName || '/临时存放').trim() : (current.stagingFolderName || '/临时存放'),
                defaultTargetFolderId: cleanTargetId || 'FtakjmnewOP2CFDarHL9I66zXFiUCsB19',
                defaultTargetFolderName: defaultTargetFolderName !== undefined ? String(defaultTargetFolderName || '/媒体库').trim() : (current.defaultTargetFolderName || '/媒体库'),
                dispatchRules: dispatchRules !== undefined ? (Array.isArray(dispatchRules) ? dispatchRules.filter(r => r && r.keyword && r.folderId) : []) : (current.dispatchRules || []),
                whitelistRegex: whitelistRegex !== undefined ? String(whitelistRegex || '').trim() : (current.whitelistRegex || ''),
                blacklistKeywords: blacklistKeywords !== undefined ? (Array.isArray(blacklistKeywords) ? blacklistKeywords.map(k => String(k).trim()).filter(Boolean) : []) : (current.blacklistKeywords || []),
                visualCards: visualCards !== undefined ? (Array.isArray(visualCards) ? visualCards : []) : (current.visualCards || []),
                scanInterval: safeScanInterval,
                cron: `*/${safeScanInterval} * * * *`,
                organizeInterval: safeOrganizeInterval,
                organizeCron: organizeCron !== undefined ? (organizeCron ? String(organizeCron).trim() : `*/${safeOrganizeInterval} * * * *`) : (current.organizeCron || `*/${safeOrganizeInterval} * * * *`),
                videoExtensions: videoExtensions !== undefined ? (Array.isArray(videoExtensions) ? videoExtensions.map(e => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : []) : (current.videoExtensions || ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'wmv', 'ts']),
                metadataExtensions: metadataExtensions !== undefined ? (Array.isArray(metadataExtensions) ? metadataExtensions.map(e => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : []) : (current.metadataExtensions || ['ass', 'srt', 'ssa', 'sub', 'vtt']),
                enableRename: enableRename !== undefined ? Boolean(enableRename) : (current.enableRename !== undefined ? Boolean(current.enableRename) : true),
                enableMediaInfo: enableMediaInfo !== undefined ? Boolean(enableMediaInfo) : (current.enableMediaInfo !== undefined ? Boolean(current.enableMediaInfo) : true),
                includeEpisodeTitle: includeEpisodeTitle !== undefined ? Boolean(includeEpisodeTitle) : (current.includeEpisodeTitle !== undefined ? Boolean(current.includeEpisodeTitle) : true),
                sweepEmptyFolders: sweepEmptyFolders !== undefined ? Boolean(sweepEmptyFolders) : (current.sweepEmptyFolders !== undefined ? Boolean(current.sweepEmptyFolders) : true),
                autoOrganize: autoOrganize !== undefined ? Boolean(autoOrganize) : (current.autoOrganize !== undefined ? Boolean(current.autoOrganize) : true),
                autoWash: autoWash !== undefined ? Boolean(autoWash) : (current.autoWash !== undefined ? Boolean(current.autoWash) : true),
                minFileSize: minFileSize !== undefined ? Math.max(0, Number(minFileSize) || 0) : (current.minFileSize ?? 50),
                ignoreKeywords: ignoreKeywords !== undefined ? String(ignoreKeywords || '').trim() : (current.ignoreKeywords || ''),
                ignoreAudiobooks: ignoreAudiobooks !== undefined ? Boolean(ignoreAudiobooks) : (current.ignoreAudiobooks !== undefined ? Boolean(current.ignoreAudiobooks) : true),
                classifyChildren: classifyChildren !== undefined ? Boolean(classifyChildren) : (current.classifyChildren !== undefined ? Boolean(current.classifyChildren) : false),
                classifyConcerts: classifyConcerts !== undefined ? Boolean(classifyConcerts) : (current.classifyConcerts !== undefined ? Boolean(current.classifyConcerts) : true),
                classifyRegion: classifyRegion !== undefined ? Boolean(classifyRegion) : (current.classifyRegion !== undefined ? Boolean(current.classifyRegion) : true),
                classifyYear: classifyYear !== undefined ? Boolean(classifyYear) : (current.classifyYear !== undefined ? Boolean(current.classifyYear) : false),
                washPriorityOrder: Array.isArray(washPriorityOrder) && washPriorityOrder.length ? washPriorityOrder : (current.washPriorityOrder || [
                    'videoFormat',
                    'dynamicRange',
                    'videoCodec',
                    'resourceType',
                    'releaseGroup',
                    'colorDepth',
                    'audioCodec',
                    'frameRate',
                    'fileSize'
                ]),
                keepDolbyMultiVersion: keepDolbyMultiVersion !== undefined ? Boolean(keepDolbyMultiVersion) : (current.keepDolbyMultiVersion !== undefined ? Boolean(current.keepDolbyMultiVersion) : false),
                notifyOnOrganize: notifyOnOrganize !== undefined ? Boolean(notifyOnOrganize) : (current.notifyOnOrganize !== undefined ? Boolean(current.notifyOnOrganize) : true),
                linkStrm: linkStrm !== undefined ? Boolean(linkStrm) : (current.linkStrm !== undefined ? Boolean(current.linkStrm) : false),
                notifyOnStrm: notifyOnStrm !== undefined ? Boolean(notifyOnStrm) : (current.notifyOnStrm !== undefined ? Boolean(current.notifyOnStrm) : false),
                ai: ai ? {
                    enable: Boolean(ai.enable),
                    provider: String(ai.provider || 'mobile').trim(),
                    providerName: String(ai.providerName || (ai.provider === 'custom' ? '自定义' : '移动灵犀')).trim(),
                    baseUrl: String(ai.baseUrl || (ai.provider === 'custom' ? 'http://127.0.0.1:8045/v1' : 'https://ai.yun.139.com')).trim(),
                    apiKey: String(ai.apiKey || '').trim(),
                    model: String(ai.model || (ai.provider === 'custom' ? 'gemini-3.8-flash-tiered' : '移动灵犀智能大模型')).trim(),
                    mode: ai.mode === 'always' ? 'always' : 'fallback',
                    // 移动 AI 兜底配置（与主 AI 配置共存；未随请求提交时保留存量值）
                    mobileFallback: (ai.mobileFallback !== undefined) ? {
                        enable: ai.mobileFallback.enable !== undefined ? Boolean(ai.mobileFallback.enable) : true,
                        networkSearch: ai.mobileFallback.networkSearch !== undefined ? Boolean(ai.mobileFallback.networkSearch) : true,
                        proactiveRenew: Boolean(ai.mobileFallback.proactiveRenew),
                        timeoutMs: Number(ai.mobileFallback.timeoutMs) > 0 ? Number(ai.mobileFallback.timeoutMs) : 60000
                    } : ((current.ai && current.ai.mobileFallback) || { enable: true, networkSearch: true, proactiveRenew: false, timeoutMs: 60000 })
                } : (current.ai || {
                    enable: false,
                    provider: 'mobile',
                    providerName: '移动灵犀',
                    baseUrl: 'https://ai.yun.139.com',
                    apiKey: '',
                    model: '移动灵犀智能大模型',
                    mode: 'fallback'
                })
            };

            ConfigService.setConfigValue('channelMonitor', updated);

            // 动态触发系统调度器刷新频道轮询任务
            try {
                const taskSettings = ConfigService.getConfigValue('settings.task', {});
                const maintenanceSettings = ConfigService.getConfigValue('settings.maintenance', {});
                SchedulerService.applySystemJobs(null, taskSettings, maintenanceSettings);
            } catch (schedErr) {
                logger.warn(`[调度器更新] 刷新频道定时轮询失败: ${schedErr.message}`);
            }

            // 同步渠道池至 channel_monitors 数据库表以驱动执行器
            try {
                const monitorRepo = getChannelMonitorRepository();
                const accountRepo = getAccountRepository();
                const allAccounts = await accountRepo.find({ where: { accountType: 'cloud139', isActive: true } });
                const defaultAccount = allAccounts.find(a => a.isDefault) || allAccounts[0] || (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));

                if (defaultAccount) {
                    const existingMonitors = await monitorRepo.find();
                    const activeUsernames = new Set(
                        updated.channels
                            .map(url => TgChannelMonitorService.normalizeChannelUsername(url))
                            .filter(Boolean)
                    );

                    // 1. 同步已有频道的激活状态（不在列表中的历史频道置为 paused）
                    for (const m of existingMonitors) {
                        const mUser = TgChannelMonitorService.normalizeChannelUsername(m.channelUrl);
                        if (activeUsernames.has(mUser)) {
                            m.status = updated.enabled ? 'active' : 'paused';
                            m.targetFolderId = updated.defaultTargetFolderId;
                            m.targetFolderName = updated.defaultTargetFolderName;
                            await monitorRepo.save(m);
                        } else {
                            m.status = 'paused';
                            await monitorRepo.save(m);
                        }
                    }

                    // 2. 插入新添加的频道
                    for (const url of updated.channels) {
                        const username = TgChannelMonitorService.normalizeChannelUsername(url);
                        if (!username) continue;
                        const found = existingMonitors.find(m => TgChannelMonitorService.normalizeChannelUsername(m.channelUrl) === username);
                        if (!found) {
                            const newMonitor = monitorRepo.create({
                                name: username || '频道监控',
                                channelUrl: url,
                                accountId: defaultAccount.id,
                                targetFolderId: updated.defaultTargetFolderId,
                                targetFolderName: updated.defaultTargetFolderName,
                                status: updated.enabled ? 'active' : 'paused',
                                autoOrganize: true,
                                autoWash: true
                            });
                            await monitorRepo.save(newMonitor);
                        }
                    }
                }
            } catch (syncErr) {
                logger.warn(`[频道配置同步] 映射数据库执行器异常: ${syncErr.message}`);
            }

            res.json({ success: true, data: updated });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 立即对集中监控频道发起一键全量扫描
    app.post('/api/channel/sync-now', async (req, res) => {
        try {
            const service = TgChannelMonitorService.getInstance();
            // 异步后台触发，不阻断前端响应
            service.scanAllMonitors().catch(err => {
                logger.error(`[频道全量扫描] 后台任务异常: ${err.message}`);
            });
            res.json({ success: true, message: '已触发全量频道轮询扫描' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 查询云盘整理功能的前置配置校验状态
    app.get('/api/channel/organize-prerequisites', async (req, res) => {
        try {
            const prereq = await TgChannelMonitorService.validateOrganizePrerequisites({ skipChannelCheck: true, ...(req.query || {}) });
            res.json({ success: true, data: prereq });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 立即对 139 云盘暂存区发起全量影视规范整理与归档（需前置满足 TMDB API 与暂存/媒体库目录配置）
    app.post('/api/channel/organize-now', async (req, res) => {
        try {
            const { StagingOrganizeService } = require('../services/StagingOrganizeService');
            const prereq = await StagingOrganizeService.validateOrganizePrerequisites({ skipChannelCheck: true, ...(req.body || {}) });
            if (!prereq.ready) {
                return res.status(400).json({
                    success: false,
                    error: `无法触发整理功能：${prereq.reason}`,
                    missing: prereq.missing,
                    details: prereq.details
                });
            }

            const service = StagingOrganizeService.getInstance();
            // 异步后台触发，不阻断前端响应（手动触发默认启用 force: true 忽略冷却熔断）
            service.organizeStagingFolder({ force: true, ...(req.body || {}) }).catch(err => {
                logger.error(`[云盘全量整理] 后台任务异常: ${err.message}`);
            });
            res.json({ success: true, message: '已触发 139 云盘全量影视规范整理' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试 AI (OpenAI / DeepSeek / 豆包 / Ollama 等兼容接口) 连通性；mode=mobile 时测试移动 AI（灵犀）兜底通道
    app.post('/api/ai/test', async (req, res) => {
        try {
            const { mode, accountId } = req.body || {};
            if (mode === 'mobile') {
                const MobileAiClient = require('../services/MobileAiClient');
                const result = await MobileAiClient.testConnection(accountId || null);
                if (result.success) {
                    res.json({ success: true, data: result });
                } else {
                    res.status(400).json({ success: false, error: result.error, data: result });
                }
                return;
            }
            const aiService = require('../services/ai');
            const result = await aiService.testConnection(req.body);
            if (result.success) {
                res.json({ success: true, data: result });
            } else {
                res.status(400).json({ success: false, error: result.error, data: result });
            }
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });


    // 动态拉取指定服务商的可用模型列表（兼容 OpenAI, DeepSeek, GLM, Gemini 等）
    app.post('/api/ai/models', async (req, res) => {
        try {
            const aiService = require('../services/ai');
            const result = await aiService.fetchModels(req.body);
            if (result.success) {
                res.json({ success: true, data: result.models });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

        // AI 深度识别与元数据抽取在线测试
    app.post('/api/ai/parse', async (req, res) => {
        try {
            const { text, context, config } = req.body || {};
            if (!text || typeof text !== 'string') {
                return res.status(400).json({ success: false, error: 'text 字段不能为空' });
            }
            const aiService = require('../services/ai');
            let effectiveContext = { force: true, ...(context || {}) };
            if (!effectiveContext.tmdbInfo) {
                try {
                    const { TMDBService } = require('../services/tmdb');
                    const { RecognitionEngine } = require('../services/RecognitionEngine');
                    const tmdb = new TMDBService();
                    if (tmdb.apiKey) {
                        const cleanTitle = RecognitionEngine.cleanAnimeFolderName(text) || text;
                        const year = RecognitionEngine.extractYear(text) || '';
                        const candidates = await tmdb.searchCandidates(cleanTitle, year, 'tv');
                        if (candidates && candidates.length > 0) {
                            const tvDetails = await tmdb.getTVDetails(candidates[0].id);
                            if (tvDetails && tvDetails.id) {
                                effectiveContext.tmdbInfo = {
                                    id: tvDetails.id,
                                    title: tvDetails.title || tvDetails.name || '',
                                    year: tvDetails.releaseDate ? tvDetails.releaseDate.slice(0, 4) : '',
                                    seasons: (tvDetails.seasons || []).map(s => ({
                                        season_number: s.season_number,
                                        name: s.name,
                                        episode_count: s.episode_count,
                                        air_date: s.air_date
                                    }))
                                };
                            }
                        }
                    }
                } catch (_) {}
            }

            const result = await aiService.parseMediaInfo(text, effectiveContext, config || null);
            if (result.success) {
                res.json({
                    success: true,
                    data: {
                        ...result.data,
                        fromCache: Boolean(result.fromCache),
                        tmdbInfo: effectiveContext.tmdbInfo || null
                    },
                    fromCache: result.fromCache
                });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // 资产同步：139 移动云盘跨号转存与 123 网盘离线调度中枢 (/api/sync/*)
    // ═════════════════════════════════════════════════════════════════════

    // 1. 获取资产同步与 123 网盘配置
    app.get('/api/sync/config', async (req, res) => {
        try {
            const pan123 = ConfigService.getConfigValue('pan123') || {
                username: '',
                password: '',
                targetDirId: 0,
                targetDirPath: '/离线下载'
            };
            const sync = ConfigService.getConfigValue('sync') || {
                existSkip: true,
                preservePath: true,
                trashSource: false
            };
            res.json({
                success: true,
                data: {
                    pan123: {
                        username: pan123.username || '',
                        hasPassword: Boolean(pan123.password),
                        targetDirId: pan123.targetDirId ?? 0,
                        targetDirPath: pan123.targetDirPath || '/离线下载'
                    },
                    sync
                }
            });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 2. 保存资产同步与 123 网盘配置
    app.post('/api/sync/config', async (req, res) => {
        try {
            const { pan123, sync } = req.body || {};
            if (pan123) {
                const current = ConfigService.getConfigValue('pan123') || {};
                const updated = {
                    ...current,
                    username: pan123.username !== undefined ? String(pan123.username).trim() : current.username,
                    password: (pan123.password !== undefined && pan123.password !== '') ? String(pan123.password).trim() : current.password,
                    targetDirId: pan123.targetDirId !== undefined ? pan123.targetDirId : current.targetDirId,
                    targetDirPath: pan123.targetDirPath !== undefined ? String(pan123.targetDirPath).trim() : current.targetDirPath
                };
                await ConfigService.setConfigValue('pan123', updated);
            }
            if (sync) {
                const currentSync = ConfigService.getConfigValue('sync') || {};
                const updatedSync = {
                    ...currentSync,
                    existSkip: sync.existSkip !== false,
                    preservePath: sync.preservePath !== false,
                    trashSource: Boolean(sync.trashSource)
                };
                await ConfigService.setConfigValue('sync', updatedSync);
            }
            res.json({ success: true, message: '资产同步配置已保存' });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 3. 123 网盘连通性与账号凭据测试
    app.post('/api/sync/pan123/test', async (req, res) => {
        try {
            const { username, password } = req.body || {};
            const effUser = (typeof username === 'string' && username.trim()) ? username.trim() : ConfigService.getConfigValue('pan123.username');
            const effPass = (typeof password === 'string' && password.trim()) ? password.trim() : ConfigService.getConfigValue('pan123.password');
            if (!effUser || !effPass) {
                return res.status(400).json({ success: false, error: '请先填写 123 网盘用户名与密码' });
            }
            const { Pan123Service } = require('../services/Pan123Service');
            const result = await Pan123Service.login(effUser, effPass);
            if (result.success) {
                res.json({ success: true, message: '123 网盘连通性测试成功！凭据有效。', user: result.user });
            } else {
                res.status(400).json({ success: false, error: result.message || '123 网盘鉴权未通过' });
            }
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 4. 获取 123 网盘目录列表
    app.get('/api/sync/pan123/folders', async (req, res) => {
        try {
            const parentId = req.query.parentId || 0;
            const user = ConfigService.getConfigValue('pan123.username');
            const pass = ConfigService.getConfigValue('pan123.password');
            if (!user || !pass) {
                return res.status(400).json({ success: false, error: '尚未配置 123 网盘账号' });
            }
            const { Pan123Service } = require('../services/Pan123Service');
            const loginRes = await Pan123Service.login(user, pass);
            if (!loginRes.success) {
                return res.status(400).json({ success: false, error: loginRes.message || '123 登录失败' });
            }
            const items = await Pan123Service.listFolder(parentId, loginRes.token);
            const folders = items.filter(f => f.type === 'folder');
            res.json({ success: true, data: folders });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 5. 在 123 网盘创建新目录
    app.post('/api/sync/pan123/mkdir', async (req, res) => {
        try {
            const { parentId = 0, folderName } = req.body || {};
            if (!folderName) {
                return res.status(400).json({ success: false, error: '目录名称不能为空' });
            }
            const user = ConfigService.getConfigValue('pan123.username');
            const pass = ConfigService.getConfigValue('pan123.password');
            const { Pan123Service } = require('../services/Pan123Service');
            const loginRes = await Pan123Service.login(user, pass);
            if (!loginRes.success) {
                return res.status(400).json({ success: false, error: loginRes.message || '123 登录失败' });
            }
            const newId = await Pan123Service.createFolder(parentId, folderName, loginRes.token);
            res.json({ success: true, data: { id: newId, name: folderName } });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 6. 查询 123 网盘当前离线任务列表
    app.get('/api/sync/pan123/tasks', async (req, res) => {
        try {
            const page = Number(req.query.page) || 1;
            const pageSize = Number(req.query.pageSize) || 50;
            const user = ConfigService.getConfigValue('pan123.username');
            const pass = ConfigService.getConfigValue('pan123.password');
            if (!user || !pass) {
                return res.status(400).json({ success: false, error: '尚未配置 123 网盘账号' });
            }
            const { Pan123Service } = require('../services/Pan123Service');
            const loginRes = await Pan123Service.login(user, pass);
            if (!loginRes.success) {
                return res.status(400).json({ success: false, error: loginRes.message || '123 登录失败' });
            }
            const result = await Pan123Service.listOfflineTasks(page, pageSize, loginRes.token);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7. 删除 123 网盘指定离线任务
    app.post('/api/sync/pan123/tasks/delete', async (req, res) => {
        try {
            const { taskId } = req.body || {};
            if (!taskId) {
                return res.status(400).json({ success: false, error: 'taskId 不能为空' });
            }
            const user = ConfigService.getConfigValue('pan123.username');
            const pass = ConfigService.getConfigValue('pan123.password');
            const { Pan123Service } = require('../services/Pan123Service');
            const loginRes = await Pan123Service.login(user, pass);
            if (!loginRes.success) {
                return res.status(400).json({ success: false, error: loginRes.message || '123 登录失败' });
            }
            const ok = await Pan123Service.deleteOfflineTask(taskId, loginRes.token);
            res.json({ success: ok });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 8. 扫描 139 源目录待同步资产
    app.post('/api/sync/cross-account/scan', async (req, res) => {
        try {
            const { accountId, folderId, mediaOnly } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '跨号同步扫描');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.scanSourceFiles(cloud139, folderId || '/', { mediaOnly });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 9. 执行 139 账号间跨号转存
    app.post('/api/sync/cross-account/execute', async (req, res) => {
        try {
            const {
                sourceAccountId,
                targetAccountId,
                files,
                targetParentId = '/',
                existSkip = true,
                preservePath = true,
                trashSource = false
            } = req.body || {};

            if (!sourceAccountId || !targetAccountId) {
                return res.status(400).json({ success: false, error: '请选择源账号与目标账号' });
            }
            if (String(sourceAccountId) === String(targetAccountId)) {
                return res.status(400).json({ success: false, error: '源账号与目标账号不能相同' });
            }
            if (!Array.isArray(files) || files.length === 0) {
                return res.status(400).json({ success: false, error: '待同步文件列表不能为空' });
            }

            const srcAccount = await accountRepo.findOne({ where: { id: parseInt(sourceAccountId) } });
            const tgtAccount = await accountRepo.findOne({ where: { id: parseInt(targetAccountId) } });
            ensureCloud139Account(srcAccount, '跨号转存-源账号');
            ensureCloud139Account(tgtAccount, '跨号转存-目标账号');

            const srcCloud = Cloud139Service.getInstance(srcAccount);
            const tgtCloud = Cloud139Service.getInstance(tgtAccount);

            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.executeCrossAccountSync(srcCloud, tgtCloud, {
                files,
                targetParentId,
                existSkip: existSkip !== false,
                preservePath: preservePath !== false,
                trashSource: Boolean(trashSource)
            });

            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 10. 139 目录特征码清单导出
    app.post('/api/sync/rapid-links/export', async (req, res) => {
        try {
            const { accountId, folderId } = req.body || {};
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '特征码导出');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.exportRapidLinks(cloud139, folderId || '/');
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 11. 批量特征码导入并落盘 139 账号
    app.post('/api/sync/rapid-links/import', async (req, res) => {
        try {
            const { accountId, rawText, targetFolderId = '/' } = req.body || {};
            if (!rawText || !String(rawText).trim()) {
                return res.status(400).json({ success: false, error: '特征码文本不能为空' });
            }
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '特征码导入');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.importRapidLinks(cloud139, rawText, targetFolderId);
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 12. 139 文件一键推送至 123 网盘离线任务
    app.post('/api/sync/offline/push', async (req, res) => {
        try {
            const { accountId, files = [], pan123TargetDirId = 0 } = req.body || {};
            if (!Array.isArray(files) || files.length === 0) {
                return res.status(400).json({ success: false, error: '请选择待推送到离线的视频文件' });
            }
            const pan123Config = ConfigService.getConfigValue('pan123') || {};
            if (!pan123Config.username || !pan123Config.password) {
                return res.status(400).json({ success: false, error: '尚未在配置面板中填写 123 网盘的账号密码' });
            }
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '跨网盘离线');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.syncTo123Offline(cloud139, {
                files,
                pan123TargetDirId,
                pan123Config
            });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });
    // ─── 盘搜 (PanSou) 资源检索与服务健康检查 ──────────────────────────────────────
    app.post('/api/pansou/search', async (req, res) => {
        try {
            const { keyword, kw, baseUrl, apiKey, timeout, cloudTypes, refresh } = req.body || {};
            const searchKw = String(keyword || kw || req.query.keyword || req.query.kw || '').trim();
            if (!searchKw) {
                return res.status(400).json({ success: false, error: '搜索关键词不能为空', data: [] });
            }
            const { PansouService } = require('../services/pansouService');
            const result = await PansouService.searchDetailed(searchKw, {
                baseUrl,
                apiKey,
                timeout,
                cloudTypes,
                refresh
            });
            res.json(result);
        } catch (error) {
            logger.error(`[PanSou] 检索路由异常: ${error.message}`, { error: error.message });
            res.status(500).json({ success: false, error: error.message, data: [] });
        }
    });

    app.get('/api/pansou/health', async (req, res) => {
        try {
            const { baseUrl, apiKey, timeout } = req.query || {};
            const { PansouService } = require('../services/pansouService');
            const result = await PansouService.checkHealth({ baseUrl, apiKey, timeout });
            res.json({ success: true, data: result });
        } catch (error) {
            logger.error(`[TMDB整理] 获取待治理文件异常: ${error.message}`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });
};

module.exports = {
    registerApiRoutes,
};


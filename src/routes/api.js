const { Like, Not, IsNull, Or, In } = require('typeorm');
const fs = require('fs').promises;
const path = require('path');
const { Cloud139Service } = require('../services/cloud139');
const ConfigService = require('../services/ConfigService');
const { SchedulerService } = require('../services/scheduler');
const CustomPushService = require('../services/message/CustomPushService');
const { logTaskEvent } = require('../utils/logUtils');
const { clearCloudSaverToken } = require('../sdk/cloudsaver');
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
        try {
            const accountId = parseInt(accountIdRaw);
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
            ensureCloud139Account(account, '目录读取');

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
            res.json({ success: false, error: error.message });
        }
    };

    app.get('/api/folders/:accountId', async (req, res) => {
        await handleFetchFolders(req.params.accountId, req.query.folderId || req.query.parentId, req.query.refresh, res);
    });

    app.get('/api/accounts/:id/files', async (req, res) => {
        await handleFetchFolders(req.params.id, req.query.folderId || req.query.parentId, req.query.refresh, res);
    });

    app.post('/api/folders/mkdir', async (req, res) => {
        try {
            const { accountId, parentFileId, folderName } = req.body;
            if (!folderName || !folderName.trim()) throw new Error('文件夹名称不能为空');
            const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
            if (!account) throw new Error('账号不存在');
            if (account.accountType !== 'cloud139') throw new Error('仅支持移动云盘账号创建文件夹');
            const cloud139 = Cloud139Service.getInstance(account);
            const result = await cloud139.createFolderHcy(parentFileId || '/', folderName.trim());
            if (!result) throw new Error('创建文件夹失败');
            folderCache.clearPrefix(`folders_${accountId}_`);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
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

    // 网络代理与关键外部服务连通性诊断测试 (严格复刻 TgtoDrive / ttd 9大核心域名测速矩阵)
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

    // 主机器人连通性与发送测试消息 (参考 TgtoDrive / ttd)
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
        if (
            settings.cloudSaver?.baseUrl != ConfigService.getConfigValue('cloudSaver.baseUrl') ||
            settings.cloudSaver?.username != ConfigService.getConfigValue('cloudSaver.username') ||
            settings.cloudSaver?.password != ConfigService.getConfigValue('cloudSaver.password')
        ) {
            clearCloudSaverToken();
            logger.debug('检测到 CloudSaver 配置变化，已清理缓存令牌');
        }
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
            const { accountId, bannedFiles, action, quarantinePath, cascadeCompanion, notifyEmby, pruneEmptyParent } = req.body || {};
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

            const summary = `成功处置 ${result.cleanedCount} 个文件，释放空间 ${result.freedSizeFormatted} (耗时 ${(result.durationMs / 1000).toFixed(1)}s)`;
            if (job) {
                await MaintenanceJobService.completeJob(job.id, {
                    status: 'cleaned',
                    summary,
                    durationMs: result.durationMs,
                    cleanedCount: result.cleanedCount,
                    freedFormatted: result.freedSizeFormatted,
                    cleanedDetails: result.details
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/maintenance/jobs', async (req, res) => {
        try {
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            await MaintenanceJobService.clearJobs();
            res.json({ success: true, message: '已清空全部维护作业记录' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/maintenance/jobs/:id', async (req, res) => {
        try {
            const { MaintenanceJobService } = require('../services/MaintenanceJobService');
            await MaintenanceJobService.deleteJob(req.params.id);
            res.json({ success: true, message: '已删除指定维护作业记录' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/maintenance/episodes/missing/status', async (req, res) => {
        try {
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            const status = EpisodeInspectionService.getScanStatus();
            res.json({ success: true, data: status });
        } catch (error) {
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
            const candidates = await EpisodeInspectionService.tmdbService.searchCandidates(cleanTitle, {
                year: year || '',
                mediaType: mediaType || 'tv'
            });
            res.json({ success: true, data: candidates });
        } catch (error) {
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/maintenance/episodes/missing/clear', async (req, res) => {
        try {
            const { EpisodeInspectionService } = require('../services/EpisodeInspectionService');
            EpisodeInspectionService.clearScanResults();
            res.json({ success: true, message: '已清空缺集巡检结果与缓存' });
        } catch (error) {
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── 媒体服务器与 Webhook 联动接口 ─────────────────────────────────────────────
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
            logger.error('处理 Emby Webhook 路由异常', { error: error.message, stack: error.stack });
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
            const candidates = await MediaScrapeService.tmdbService.searchCandidates(
                cleanTitle,
                year,
                mediaType || 'multi'
            );
            res.json({ success: true, data: candidates });
        } catch (error) {
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
            if (!account) return res.status(400).json({ success: false, error: '未找到可用的 139 网盘账号' });
            const cloud139 = Cloud139Service.getInstance(account);
            const { TmdbOrganizeService } = require('../services/TmdbOrganizeService');
            const files = await TmdbOrganizeService.scanDirectory(folderId || '/', {
                modeConfig: { cloud139 }
            });
            const groups = TmdbOrganizeService.clusterFiles(files);
            res.json({ success: true, data: { groups, files, sourceFolders: files.sourceFolders || [] } });
        } catch (error) {
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
            if (!account) return res.status(400).json({ success: false, error: '未找到可用的 139 网盘账号' });
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
                if (status === 'fallback') {
                    qb.andWhere('(r.status = :fbStatus OR r.reason LIKE :fbReason)', {
                        fbStatus: 'fallback',
                        fbReason: '%自愈%'
                    });
                } else if (status) {
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // STRM 文件生成与 302 直链播放服务 (采用与 TgtoDrive / ttd 相同技术规范)
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
                // 302 重定向至 139 官方 CDN 高速直链（零服务器中转带宽，直连满速播放）
                logger.info(`[STRM 302] 成功获取 CDN 直链并响应 302 重定向: ${fileName} (fileId: ${fileId})`);
                return res.redirect(302, directUrl);
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

            // 若未提供显式 files 列表，则按用户指定目录从 139 网盘实际扫描
            if (targetFiles.length === 0) {
                const { AppDataSource } = require('../database');
                const { Account } = require('../entities');

                const mediaSuffixes = (ConfigService.getConfigValue('task.mediaSuffix') || '.mp4;.mkv;.avi;.mov;.ts;.flv;.wmv;.iso;.m4v;.rmvb;.strm')
                    .split(';')
                    .map(s => s.trim().toLowerCase())
                    .filter(Boolean);

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

                // 解析目标待扫描目录 ID 与展示名称
                let targetCatalogId = specifiedFolderId;
                let targetFolderName = specifiedFolderName || '';

                if (!targetCatalogId || targetCatalogId === '-11') {
                    // 若未显式传入 folderId，但传入了 folderName（如 /目标目录 或 目标目录）
                    if (targetFolderName && targetFolderName !== '/' && targetFolderName !== '根目录') {
                        const cleanName = targetFolderName.replace(/^\/+|\/+$/g, '').split('/')[0];
                        const found = await cloud139.findFolderByName('/', cleanName).catch(() => null);
                        if (found && (found.fileId || found.id)) {
                            targetCatalogId = found.fileId || found.id;
                        }
                    }
                }

                // 若仍未定位，从系统配置中回退至默认目标目录
                if (!targetCatalogId || targetCatalogId === '/' || targetCatalogId === '-11') {
                    const defaultTargetFolderId = ConfigService.getConfigValue('channelMonitor.defaultTargetFolderId');
                    const defaultTargetFolderName = ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName') || '目标目录';
                    if (defaultTargetFolderId && defaultTargetFolderId !== '/' && defaultTargetFolderId !== '-11') {
                        targetCatalogId = defaultTargetFolderId;
                        if (!targetFolderName) targetFolderName = defaultTargetFolderName;
                    } else if (defaultTargetFolderName) {
                        const cleanName = defaultTargetFolderName.replace(/^\/+|\/+$/g, '').split('/')[0];
                        const found = await cloud139.findFolderByName('/', cleanName).catch(() => null);
                        if (found && (found.fileId || found.id)) {
                            targetCatalogId = found.fileId || found.id;
                            if (!targetFolderName) targetFolderName = defaultTargetFolderName;
                        }
                    }
                }

                if (!targetCatalogId) targetCatalogId = '/';
                if (!targetFolderName) targetFolderName = targetCatalogId === '/' ? '根目录' : '指定目录';

                const startMsg = `[STRM生成] 启动扫描指定网盘目录: ${targetFolderName} (ID: ${targetCatalogId}), 清理失效映射: ${cleanObsolete ? '是' : '否'}`;
                logger.info(startMsg);
                logTaskEvent(startMsg);

                // 递归全量扫描指定网盘目录（使用 listDiskDirAll 分页获取真实文件）
                const seenIds = new Set();
                let scannedDirCount = 0;
                const scanCatalog = async (catalogId, relativePath = '') => {
                    scannedDirCount++;
                    if (relativePath) {
                        logger.info(`[STRM生成] 正在扫描网盘子目录: /${relativePath} (ID: ${catalogId})`);
                    }
                    const items = await cloud139.listDiskDirAll(catalogId).catch(err => {
                        const scanErrMsg = `[STRM生成] 扫描网盘子目录 (${catalogId}) 失败: ${err.message}`;
                        logger.error(scanErrMsg);
                        logTaskEvent(scanErrMsg);
                        return [];
                    });

                    for (const item of items) {
                        const fileId = item.fileId || item.id;
                        if (!fileId || seenIds.has(String(fileId))) continue;

                        const name = item.name || item.fileName || '';
                        if (item.type === 'folder') {
                            const subRel = relativePath ? `${relativePath}/${name}` : name;
                            await scanCatalog(fileId, subRel);
                        } else {
                            const ext = path.extname(name).toLowerCase();
                            if (mediaSuffixes.includes(ext)) {
                                seenIds.add(String(fileId));
                                targetFiles.push({
                                    fileId,
                                    id: fileId,
                                    name,
                                    finalName: name,
                                    originalName: name,
                                    targetFolderPath: relativePath,
                                    size: Number(item.size || 0),
                                    accountId: account.id
                                });
                            }
                        }
                    }
                };

                await scanCatalog(targetCatalogId, '');
                const scanDoneMsg = `[STRM生成] 网盘目录扫描完成: 遍历 ${scannedDirCount} 个目录，共发现 ${targetFiles.length} 个视频媒体资产`;
                logger.info(scanDoneMsg);
                logTaskEvent(scanDoneMsg);
            }

            // 若仍无媒体文件，返回成功并带空统计与提示信息，杜绝抛出 400 报错
            if (targetFiles.length === 0) {
                const emptyMsg = `[STRM生成] 指定网盘目录「${targetFolderName}」中暂未检测到媒体文件，已终止生成`;
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
                        folderName: targetFolderName,
                        message: '指定网盘目录中暂未检测到媒体文件，请确认该目录是否存在视频资产'
                    }
                });
            }

            const result = await strmService.generateForOrganizedFiles(targetFiles, {
                ...options,
                cleanObsolete,
                accountId
            });

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
                    folderName: targetFolderName,
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
                    channels: Array.isArray(config.channels) ? config.channels : [],
                    defaultTargetFolderId: config.defaultTargetFolderId || '/',
                    defaultTargetFolderName: config.defaultTargetFolderName || '默认媒体库',
                    dispatchRules: Array.isArray(config.dispatchRules) ? config.dispatchRules : [],
                    whitelistRegex: config.whitelistRegex || '',
                    blacklistKeywords: Array.isArray(config.blacklistKeywords) ? config.blacklistKeywords : [],
                    visualCards: Array.isArray(config.visualCards) ? config.visualCards : [],
                    stagingFolderId: config.stagingFolderId || '',
                    stagingFolderName: config.stagingFolderName || '/暂存区/频道转存',
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
                        'releaseGroup',
                        'resourceType',
                        'videoFormat',
                        'dynamicRange',
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
                        baseUrl: 'http://127.0.0.1:8045/v1',
                        apiKey: '',
                        model: 'gemini-3.8-flash-tiered',
                        mode: 'fallback'
                    }
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 保存全局集中频道监控配置
    app.post('/api/channel/global-config', async (req, res) => {
        try {
            const {
                enabled = true,
                channels = [],
                stagingFolderId = '',
                stagingFolderName = '/暂存区/频道转存',
                defaultTargetFolderId = '/',
                defaultTargetFolderName = '默认媒体库',
                dispatchRules = [],
                whitelistRegex = '',
                blacklistKeywords = [],
                visualCards = [],
                scanInterval = 5,
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

            // 互斥校验：源暂存目录与目标归档目录不能相同
            const cleanStagingId = String(stagingFolderId || '').trim();
            const cleanTargetId = String(defaultTargetFolderId || '/').trim();
            if (cleanStagingId && cleanTargetId && cleanStagingId === cleanTargetId) {
                return res.status(400).json({
                    success: false,
                    error: '源暂存目录与目标归档目录不能相同，否则会导致重复扫描与死循环归档！'
                });
            }

            const current = ConfigService.getConfigValue('channelMonitor', {});
            const safeScanInterval = Math.max(1, Number(scanInterval) || 5);
            const updated = {
                ...current,
                enabled: Boolean(enabled),
                channels: Array.isArray(channels) ? channels.map(c => String(c).trim()).filter(Boolean) : [],
                stagingFolderId: cleanStagingId,
                stagingFolderName: String(stagingFolderName || '/暂存区/频道转存').trim(),
                defaultTargetFolderId: cleanTargetId,
                defaultTargetFolderName: String(defaultTargetFolderName || '默认媒体库').trim(),
                dispatchRules: Array.isArray(dispatchRules) ? dispatchRules.filter(r => r && r.keyword && r.folderId) : [],
                whitelistRegex: String(whitelistRegex || '').trim(),
                blacklistKeywords: Array.isArray(blacklistKeywords) ? blacklistKeywords.map(k => String(k).trim()).filter(Boolean) : [],
                visualCards: Array.isArray(visualCards) ? visualCards : [],
                scanInterval: safeScanInterval,
                cron: `*/${safeScanInterval} * * * *`,
                videoExtensions: Array.isArray(videoExtensions) ? videoExtensions.map(e => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : (current.videoExtensions || ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'wmv', 'ts']),
                metadataExtensions: Array.isArray(metadataExtensions) ? metadataExtensions.map(e => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : (current.metadataExtensions || ['ass', 'srt', 'ssa', 'sub', 'vtt']),
                enableRename: Boolean(enableRename),
                enableMediaInfo: Boolean(enableMediaInfo),
                includeEpisodeTitle: Boolean(includeEpisodeTitle),
                sweepEmptyFolders: Boolean(sweepEmptyFolders),
                autoOrganize: Boolean(autoOrganize),
                autoWash: Boolean(autoWash),
                minFileSize: Math.max(0, Number(minFileSize) || 0),
                ignoreKeywords: String(ignoreKeywords || '').trim(),
                ignoreAudiobooks: ignoreAudiobooks !== undefined ? Boolean(ignoreAudiobooks) : (current.ignoreAudiobooks !== undefined ? Boolean(current.ignoreAudiobooks) : true),
                classifyChildren: Boolean(classifyChildren),
                classifyConcerts: Boolean(classifyConcerts),
                classifyRegion: Boolean(classifyRegion),
                classifyYear: Boolean(classifyYear),
                washPriorityOrder: Array.isArray(washPriorityOrder) && washPriorityOrder.length ? washPriorityOrder : (current.washPriorityOrder || [
                    'releaseGroup',
                    'resourceType',
                    'videoFormat',
                    'dynamicRange',
                    'colorDepth',
                    'audioCodec',
                    'frameRate',
                    'fileSize'
                ]),
                keepDolbyMultiVersion: Boolean(keepDolbyMultiVersion),
                notifyOnOrganize: Boolean(notifyOnOrganize),
                linkStrm: Boolean(linkStrm),
                notifyOnStrm: Boolean(notifyOnStrm),
                ai: ai ? {
                    enable: Boolean(ai.enable),
                    baseUrl: String(ai.baseUrl || 'http://127.0.0.1:8045/v1').trim(),
                    apiKey: String(ai.apiKey || '').trim(),
                    model: String(ai.model || 'gemini-3.8-flash-tiered').trim(),
                    mode: ai.mode === 'always' ? 'always' : 'fallback'
                } : (current.ai || {
                    enable: false,
                    baseUrl: 'http://127.0.0.1:8045/v1',
                    apiKey: '',
                    model: 'gemini-3.8-flash-tiered',
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 查询云盘整理功能的前置配置校验状态
    app.get('/api/channel/organize-prerequisites', async (req, res) => {
        try {
            const prereq = await TgChannelMonitorService.validateOrganizePrerequisites({ skipChannelCheck: true, ...(req.query || {}) });
            res.json({ success: true, data: prereq });
        } catch (error) {
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试 AI (OpenAI / DeepSeek / 豆包 / Ollama 等兼容接口) 连通性
    app.post('/api/ai/test', async (req, res) => {
        try {
            const aiService = require('../services/ai');
            const result = await aiService.testConnection(req.body);
            if (result.success) {
                res.json({ success: true, data: result });
            } else {
                res.status(400).json({ success: false, error: result.error, data: result });
            }
        } catch (error) {
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
            const result = await aiService.parseMediaInfo(text, context || {}, config || null);
            if (result.success) {
                res.json({ success: true, data: result.data, fromCache: result.fromCache });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // 资产同步：139 移动云盘跨号秒传与 123 网盘离线调度中枢 (/api/sync/*)
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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 9. 执行 139 账号间跨号秒传
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
            ensureCloud139Account(srcAccount, '跨号秒传-源账号');
            ensureCloud139Account(tgtAccount, '跨号秒传-目标账号');

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
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 10. 139 目录秒传特征码清单导出
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
            ensureCloud139Account(account, '秒传特征码导出');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.exportRapidLinks(cloud139, folderId || '/');
            res.json({ success: true, data: result });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 11. 批量秒传特征码导入并落盘 139 账号
    app.post('/api/sync/rapid-links/import', async (req, res) => {
        try {
            const { accountId, rawText, targetFolderId = '/' } = req.body || {};
            if (!rawText || !String(rawText).trim()) {
                return res.status(400).json({ success: false, error: '秒传特征码文本不能为空' });
            }
            let account;
            if (accountId) {
                account = await accountRepo.findOne({ where: { id: parseInt(accountId) } });
            } else {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: Not(false) } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            ensureCloud139Account(account, '秒传特征码导入');
            const cloud139 = Cloud139Service.getInstance(account);
            const { AssetSyncService } = require('../services/AssetSyncService');
            const result = await AssetSyncService.importRapidLinks(cloud139, rawText, targetFolderId);
            res.json({ success: true, data: result });
        } catch (error) {
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
            res.status(500).json({ success: false, error: error.message });
        }
    });
};

module.exports = {
    registerApiRoutes,
};

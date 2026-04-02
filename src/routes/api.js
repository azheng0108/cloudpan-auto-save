const { Like, Not, IsNull, Or } = require('typeorm');
const fs = require('fs').promises;
const path = require('path');
const { Cloud139Service } = require('../services/cloud139');
const ConfigService = require('../services/ConfigService');
const { SchedulerService } = require('../services/scheduler');
const CustomPushService = require('../services/message/CustomPushService');
const { logTaskEvent } = require('../utils/logUtils');
const { clearCloudSaverToken } = require('../sdk/cloudsaver');
const { AppDataSource } = require('../database');
const logger = require('../utils/logger');
const { Cloud189Service } = require('../legacy189/services/cloud189');

const ensureCloud139Account = (account, action) => {
    if (!account) {
        throw new Error('账号不存在');
    }
    if (account.accountType !== 'cloud139') {
        throw new Error(`R2阶段已停用天翼云盘（189）主流程，${action}仅支持移动云盘（139）账号`);
    }
};

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

const maskUsername = (username) => {
    const value = String(username || '');
    const len = value.length;
    if (len === 0) return '';
    if (len === 1) return '*';
    if (len <= 4) return `${value.slice(0, 1)}${'*'.repeat(len - 1)}`;

    const headLen = 3;
    const tailLen = len >= 8 ? 4 : 2;
    const maskLen = len - headLen - tailLen;
    if (maskLen <= 0) {
        return `${value.slice(0, 1)}${'*'.repeat(Math.max(1, len - 1))}`;
    }
    return `${value.slice(0, headLen)}${'*'.repeat(maskLen)}${value.slice(-tailLen)}`;
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

    app.get('/api/accounts', async (req, res) => {
        const accounts = await accountRepo.find();
        await Promise.all(accounts.map(async (account) => {
            account.capacity = {
                cloudCapacityInfo: { usedSize: 0, totalSize: 0 },
                familyCapacityInfo: { usedSize: 0, totalSize: 0 },
            };
            if (!account.username.startsWith('n_') && account.accountType === 'cloud139') {
                try {
                    const cloud139 = Cloud139Service.getInstance(account);
                    const capacity = await cloud139.getUserSizeInfo();
                    if (capacity && capacity.res_code === 0) {
                        account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                        account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                        account.memberInfo = capacity.memberInfo || null;
                    }
                } catch (e) {
                }
            }
            account.original_username = account.username;
            account.username = maskUsername(account.username);
        }));
        res.json({ success: true, data: accounts });
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const account = accountRepo.create(req.body);
            if (account.accountType !== 'cloud139') {
                return res.json({ success: false, error: 'R2阶段已停用天翼云盘（189）主流程，仅支持移动云盘（139）账号' });
            }
            if (!account.cookies) {
                res.json({ success: false, error: '移动云盘（139）只支持 Cookie 登录，请填写 Cookie' });
                return;
            }
            await accountRepo.save(account);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/accounts/recycle', async (req, res) => {
        try {
            taskService.clearRecycleBin(true, true);
            res.json({ success: true, data: 'ok' });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/accounts/:id', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');

            const taskCount = await taskRepo.count({ where: { accountId } });
            if (taskCount > 0) {
                return res.json({
                    success: false,
                    error: `该账号下仍有 ${taskCount} 个任务，请先删除/迁移任务后再删除账号`,
                });
            }

            const wasDefault = !!account.isDefault;
            await accountRepo.remove(account);
            if (wasDefault) {
                const next = await accountRepo.findOne({ where: { id: Not(accountId) } });
                if (next) {
                    await accountRepo.update({ id: next.id }, { isDefault: true });
                }
            }

            folderCache.clearPrefix('folders_');
            folderCache.clearPrefix('share_folders_');
            folderCache.clearPrefix('favorites_');
            logTaskEvent(`[system] 已删除账号 ${accountId}（并清理关联任务/目录缓存）`);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/accounts/:id/alias', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { alias } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            account.alias = alias;
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            await accountRepo.update({}, { isDefault: false });
            await accountRepo.update({ id: accountId }, { isDefault: true });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

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
            task.account.username = maskUsername(task.account.username);
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
            const taskIds = req.body.taskIds;
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

    app.get('/api/folders/:accountId', async (req, res) => {
        try {
            const accountId = parseInt(req.params.accountId);
            const folderId = req.query.folderId || '-11';
            const forceRefresh = req.query.refresh === 'true';
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
            const catalogID = folderId === '-11' ? '/' : folderId;
            const listResult = await cloud139.listDiskDir(catalogID);
            if (!listResult) throw new Error('获取目录失败，请检查账号认证是否有效');
            const mediaExts = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'ts', 'm2ts', 'rmvb', 'm4v', 'webm', 'mp3', 'flac', 'aac', 'm4a']);
            const folders = listResult.items
                .filter((f) => f.type === 'folder' || mediaExts.has(f.extension || ''))
                .map((f) => ({
                    id: f.fileId,
                    name: f.name,
                    isFile: f.type !== 'folder',
                }));

            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
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

            const normalizedTaskSchedules = SchedulerService.validateTaskScheduleSettings(settings?.task || {});
            settings.task = {
                ...(settings.task || {}),
                ...normalizedTaskSchedules,
            };

            SchedulerService.handleScheduleTasks(settings, taskService);
            ConfigService.setConfig(settings);
            Cloud139Service.clearAllInstances();
            Cloud189Service.clearAllInstances();
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

            res.json({ success: true, data: null });
        } catch (error) {
            logger.error('更新系统设置失败', { error: error.message, stack: error.stack });
            const isValidationError = typeof error?.message === 'string'
                && error.message.includes('Cron 无效');
            res.status(isValidationError ? 400 : 500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/settings/media', async (req, res) => {
        const settings = req.body;
        if (
            settings.cloudSaver?.baseUrl != ConfigService.getConfigValue('cloudSaver.baseUrl') ||
            settings.cloudSaver?.username != ConfigService.getConfigValue('cloudSaver.username') ||
            settings.cloudSaver?.password != ConfigService.getConfigValue('cloudSaver.password')
        ) {
            clearCloudSaverToken();
        }
        ConfigService.setConfig(settings);
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
};

module.exports = {
    registerApiRoutes,
};

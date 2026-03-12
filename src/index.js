require('dotenv').config();
const express = require('express');
const { AppDataSource } = require('./database');
const { Account, Task, CommonFolder, TransferredFile } = require('./entities');
const { TaskService } = require('./services/task');
const { Cloud189Service } = require('./services/cloud189');
const { Cloud139Service } = require('./services/cloud139');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager')
const ConfigService = require('./services/ConfigService');
const packageJson = require('../package.json');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { SchedulerService } = require('./services/scheduler');
const { logTaskEvent, initSSE } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const fs = require('fs').promises;
const path = require('path');
const { setupCloudSaverRoutes, clearCloudSaverToken } = require('./sdk/cloudsaver');
const { Like, Not, IsNull, In, Or } = require('typeorm');
const cors = require('cors'); 
const CustomPushService = require('./services/message/CustomPushService');

const app = express();
app.use(cors({
    origin: '*', // 允许所有来源
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
    credentials: true
}));
app.use(express.json());

app.use(session({
    store: new FileStore({
        path: './data/sessions',  // session文件存储路径
        ttl: 30 * 24 * 60 * 60,  // session过期时间，单位秒
        reapInterval: 3600,       // 清理过期session间隔，单位秒
        retries: 0,           // 设置重试次数为0
        logFn: () => {},      // 禁用内部日志
        reapAsync: true,      // 异步清理过期session
    }),
    secret: 'LhX2IyUcMAz2',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000 * 30 // 30天
    }
}));


// 验证会话的中间件
const authenticateSession = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const configApiKey = ConfigService.getConfigValue('system.apiKey');
    if (apiKey && configApiKey && apiKey === configApiKey) {
        return next();
    }
    if (req.session.authenticated) {
        next();
    } else {
        // API 请求返回 401，页面请求重定向到登录页
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ success: false, error: '未登录' });
        } else {
            res.redirect('/login');
        }
    }
};

// 添加根路径处理
app.get('/', (req, res) => {
    if (!req.session.authenticated) {
        res.redirect('/login');
    } else {
        res.sendFile(__dirname + '/public/index.html');
    }
});


// 登录页面
app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// 登录接口
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ConfigService.getConfigValue('system.username') && 
        password === ConfigService.getConfigValue('system.password')) {
        req.session.authenticated = true;
        req.session.username = username;
        res.json({ success: true });
    } else {
        res.json({ success: false, error: '用户名或密码错误' });
    }
});
app.use(express.static(path.join(__dirname,'public')));
// 为所有路由添加认证（除了登录页和登录接口）
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/login' 
        || req.path === '/api/auth/login' 
        || req.path === '/api/auth/login' 
        || req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico)$/)) {
        return next();
    }
    authenticateSession(req, res, next);
});
// 初始化数据库连接
AppDataSource.initialize().then(async () => {
    // 当前版本:
    const currentVersion = packageJson.version;
    console.log(`当前系统版本: ${currentVersion}`);
    console.log('数据库连接成功');

    const accountRepo = AppDataSource.getRepository(Account);
    const taskRepo = AppDataSource.getRepository(Task);
    const commonFolderRepo = AppDataSource.getRepository(CommonFolder);
    const transferredFileRepo = AppDataSource.getRepository(TransferredFile);
    const taskService = new TaskService(taskRepo, accountRepo, transferredFileRepo);
    const messageUtil = new MessageUtil();
    // 机器人管理
    const botManager = TelegramBotManager.getInstance();
    // 初始化机器人
    await botManager.handleBotStatus(
        ConfigService.getConfigValue('telegram.bot.botToken'),
        ConfigService.getConfigValue('telegram.bot.chatId'),
        ConfigService.getConfigValue('telegram.bot.enable')
    );
    // 初始化缓存管理器
    const folderCache = new CacheManager(parseInt(600));
    // 初始化任务定时器
    await SchedulerService.initTaskJobs(taskRepo, taskService);
    
    // 账号相关API
    app.get('/api/accounts', async (req, res) => {
        const accounts = await accountRepo.find();
        // 获取容量
        for (const account of accounts) {
            
            account.capacity = {
                cloudCapacityInfo: {usedSize:0,totalSize:0},
                familyCapacityInfo: {usedSize:0,totalSize:0}
            }
            // 如果账号名是s打头 则不获取容量
            if (!account.username.startsWith('n_') && account.accountType !== 'cloud139') {
                const cloud189 = Cloud189Service.getInstance(account);
                const capacity = await cloud189.getUserSizeInfo()
                if (capacity && capacity.res_code == 0) {
                    account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                    account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                }
            } else if (!account.username.startsWith('n_') && account.accountType === 'cloud139') {
                try {
                    const cloud139 = Cloud139Service.getInstance(account);
                    const capacity = await cloud139.getUserSizeInfo();
                    if (capacity && capacity.res_code === 0) {
                        account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                        account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                        account.memberInfo = capacity.memberInfo || null;
                    }
                } catch (e) {
                    // 容量获取失败不影响账号列表展示
                }
            }
            account.original_username = account.username;
            // username脱敏
            account.username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
        }
        res.json({ success: true, data: accounts });
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const account = accountRepo.create(req.body);
            // 139云盘只支持 Cookie 登录，不做密码登录
            if (account.accountType === 'cloud139') {
                if (!account.cookies) {
                    res.json({ success: false, error: '移动云盘（139）只支持 Cookie 登录，请填写 Cookie' });
                    return;
                }
            } else if (!account.username.startsWith('n_') && account.password) {
                // 天翼云盘尝试密码登录, 登录成功写入store, 如果需要验证码则返回验证码图片
                const cloud189 = Cloud189Service.getInstance(account);
                const loginResult = await cloud189.login(account.username, account.password, req.body.validateCode);
                if (!loginResult.success) {
                    if (loginResult.code == "NEED_CAPTCHA") {
                        res.json({
                            success: false,
                            code: "NEED_CAPTCHA",
                            data: {
                                captchaUrl: loginResult.data
                            }
                        });
                        return;
                    }
                    res.json({ success: false, error: loginResult.message });
                    return;
                }
            }
            await accountRepo.save(account);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

     // 清空回收站
     app.delete('/api/accounts/recycle', async (req, res) => {
        try {
            taskService.clearRecycleBin(true, true);
            res.json({ success: true, data: "ok" });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.delete('/api/accounts/:id', async (req, res) => {
        try {
            const account = await accountRepo.findOneBy({ id: parseInt(req.params.id) });
            if (!account) throw new Error('账号不存在');
            await accountRepo.remove(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // 修改别名
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
    })
    app.put('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            // 清除所有账号的默认状态
            await accountRepo.update({}, { isDefault: false });
            // 设置指定账号为默认
            await accountRepo.update({ id: accountId }, { isDefault: true });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    // 任务相关API
    app.get('/api/tasks', async (req, res) => {
        const { status, search } = req.query;
        let whereClause = { }; // 用于构建最终的 where 条件

        // 基础条件（AND）
        if (status && status !== 'all') {
            whereClause.status = status;
        }
        whereClause.enableSystemProxy = Or(IsNull(), false);

        // 添加搜索过滤
        if (search) {
            const searchConditions = [
                { realFolderName: Like(`%${search}%`) },
                { remark: Like(`%${search}%`) },
                { account: { username: Like(`%${search}%`) } }
            ];
            if (Object.keys(whereClause).length > 0) {
                whereClause = searchConditions.map(searchCond => ({
                    ...whereClause, // 包含基础条件 (如 status)
                    ...searchCond   // 包含一个搜索条件
                }));
            }else{
                whereClause = searchConditions;
            }
        }
        const tasks = await taskRepo.find({
            order: { id: 'DESC' },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true
                }
            },
            where: whereClause
        });
        // username脱敏
        tasks.forEach(task => {
            task.account.username = task.account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
        });
        res.json({ success: true, data: tasks });
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const task = await taskService.createTask(req.body);
            res.json({ success: true, data: task });
        } catch (error) {
            console.log(error)
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

    // 删除任务文件
    app.delete('/api/tasks/files', async (req, res) => {
        try{
            const { taskId, files } = req.body;
            if (!files || files.length === 0) {
                throw new Error('未选择要删除的文件');
            }
            await taskService.deleteFiles(taskId, files);
            res.json({ success: true, data: null });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

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
                relations: {
                    account: true
                },
                select: {
                    account: {
                        username: true
                    }
                }
            });
            if (!task) throw new Error('任务不存在');
            logTaskEvent(`================================`);
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始执行`);
            const result = await taskService.processTask(task);
            if (result) {
                messageUtil.sendMessage(result)
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
     // 获取目录树（支持天翼云盘和移动云盘）
     app.get('/api/folders/:accountId', async (req, res) => {
        try {
            const accountId = parseInt(req.params.accountId);
            const folderId = req.query.folderId || '-11';
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `folders_${accountId}_${folderId}`;
            // forceRefresh 为true 则清空所有folders_开头的缓存
            if (forceRefresh) {
                folderCache.clearPrefix("folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }

            let folders;
            if (account.accountType === 'cloud139') {
                // 移动云盘：使用 hcy/file/list 接口获取子目录列表（旧 getDiskFiles 已废弃）
                // '-11' 是天翼云盘根目录占位符，对于移动云盘根目录传 '/'
                const cloud139 = Cloud139Service.getInstance(account);
                const catalogID = (folderId === '-11') ? '/' : folderId;
                const listResult = await cloud139.listDiskDir(catalogID);
                if (!listResult) throw new Error('获取目录失败，请检查账号认证是否有效');
                const mediaExts = new Set(['mp4','mkv','avi','mov','flv','wmv','ts','m2ts','rmvb','m4v','webm','mp3','flac','aac','m4a']);
                folders = listResult.items
                    .filter(f => f.type === 'folder' || mediaExts.has(f.extension || ''))
                    .map(f => ({
                        id: f.fileId,
                        name: f.name,
                        isFile: f.type !== 'folder',
                    }));
            } else {
                const cloud189 = Cloud189Service.getInstance(account);
                folders = await cloud189.getFolderNodes(folderId);
                if (!folders) throw new Error('获取目录失败');
            }

            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 新建文件夹
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
            // 清除该目录缓存
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
                folderCache.clearPrefix("share_folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
            if (!task) {
                throw new Error('任务不存在');
            }
            const account = await accountRepo.findOneBy({ id: parseInt(req.params.accountId) });
            if (!account) {
                throw new Error('账号不存在');
            }

            // cloud139：使用移动云盘分享 API
            if (account.accountType === 'cloud139') {
                const cloud139 = Cloud139Service.getInstance(account);
                if (folderId == -11) {
                    // 返回任务当前选中的分享目录作为根节点
                    const rootId = task.shareFolderId || 'root';
                    const rootName = task.shareFolderName || task.resourceName;
                    return res.json({ success: true, data: [{ id: rootId, name: rootName }] });
                }
                // 列出指定分享子目录内的文件夹
                const shareDir = await cloud139.listShareDir(task.shareId, task.accessCode || '', folderId);
                if (!shareDir) {
                    return res.json({ success: true, data: [] });
                }
                const folders = (shareDir.folderList || []).map(f => ({
                    id: String(f.catalogID ?? f.caID),
                    name: f.catalogName ?? f.caName ?? String(f.catalogID ?? f.caID),
                }));
                folderCache.set(cacheKey, folders);
                return res.json({ success: true, data: folders });
            }

            // cloud189：原有逻辑
            if (folderId == -11) {
                // 返回顶级目录
                res.json({success: true, data: [{id: task.shareFileId, name: task.resourceName}]});
                return;
            }
            const cloud189 = Cloud189Service.getInstance(account);
            // 查询分享目录
            const shareDir = await cloud189.listShareDir(task.shareId, req.query.folderId, task.shareMode);
            if (!shareDir || !shareDir.fileListAO) {
                return res.json({ success: true, data: [] });
            }
            const folders = shareDir.fileListAO.folderList;
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

     // 获取目录下的文件
     app.get('/api/folder/files', async (req, res) => {
        const { accountId, taskId } = req.query;
        const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
        if (!account) {
            return res.status(404).json({ success: false, error: '账号不存在' });
        }
        const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }
        try {
            if (account.accountType === 'cloud139') {
                // 移动云盘：使用 hcy/file/list 接口获取目录下的文件
                const cloud139 = Cloud139Service.getInstance(account);
                const listResult = await cloud139.listDiskDir(task.realFolderId || '/');
                if (!listResult) {
                    return res.json({ success: true, data: [] });
                }
                const files = listResult.items
                    .filter(f => f.type !== 'folder')
                    .map(f => ({
                        id: f.fileId,
                        name: f.name,
                        size: f.size,
                        lastOpTime: f.updatedAt || '',
                    }));
                return res.json({ success: true, data: files });
            }
            // cloud189
            const cloud189 = Cloud189Service.getInstance(account);
            const fileList = await taskService.getAllFolderFiles(cloud189, task);
            res.json({ success: true, data: fileList });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/files/rename', async (req, res) => {
        try {
            const {taskId, accountId, files, sourceRegex, targetRegex } = req.body;
            if (!files || files.length == 0) {
                return res.json({ success: false, error: '未获取到需要修改的文件' });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                return res.json({ success: false, error: '账号不存在' });
            }
            const task = await taskService.getTaskById(taskId);
            if (!task) {
                return res.json({ success: false, error: '任务不存在' });
            }
            const result = []
            const successFiles = []
            if (account.accountType === 'cloud139') {
                const cloud139 = Cloud139Service.getInstance(account);
                for (const file of files) {
                    const renameResult = await cloud139.renameFile(file.fileId, file.destFileName);
                    if (!renameResult || renameResult.res_code != 0) {
                        result.push(`文件${file.destFileName} 重命名失败${renameResult ? ': ' + renameResult.res_msg : ''}`);
                    } else {
                        successFiles.push({ id: file.fileId, name: file.destFileName });
                    }
                }
            } else {
                const cloud189 = Cloud189Service.getInstance(account);
                for (const file of files) {
                    const renameResult = await cloud189.renameFile(file.fileId, file.destFileName);
                    if (!renameResult) {
                        result.push(`文件${file.destFileName} 重命名失败`);
                        continue;
                    }
                    if (renameResult.res_code != 0) {
                        result.push(`文件${file.destFileName} ${renameResult.res_msg}`);
                    } else {
                        successFiles.push({ id: file.fileId, name: file.destFileName });
                    }
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
        const result = filenames.map(filename => {
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
        taskService.processAllTasks(true);
        res.json({ success: true, data: null });
    });

    // 系统设置
    app.get('/api/settings', async (req, res) => {
        res.json({success: true, data: ConfigService.getConfig()})
    })

    app.post('/api/settings', async (req, res) => {
        const settings = req.body;
        SchedulerService.handleScheduleTasks(settings,taskService);
        ConfigService.setConfig(settings)
        await botManager.handleBotStatus(
            settings.telegram?.bot?.botToken,
            settings.telegram?.bot?.chatId,
            settings.telegram?.bot?.enable
        );
        // 修改配置, 重新实例化消息推送
        messageUtil.updateConfig()
        Cloud189Service.setProxy()
        res.json({success: true, data: null})
    })


    // 保存媒体配置
    app.post('/api/settings/media', async (req, res) => {
        const settings = req.body;
        // 如果cloudSaver的配置变更 就清空cstoken.json
        if (settings.cloudSaver?.baseUrl != ConfigService.getConfigValue('cloudSaver.baseUrl')
        || settings.cloudSaver?.username != ConfigService.getConfigValue('cloudSaver.username')
        || settings.cloudSaver?.password != ConfigService.getConfigValue('cloudSaver.password')
    ) {
            clearCloudSaverToken();
        }
        ConfigService.setConfig(settings)
        res.json({success: true, data: null})
    })

    app.get('/api/version', (req, res) => {
        res.json({ version: currentVersion });
    });

    // 解析分享链接
    app.post('/api/share/parse', async (req, res) => {
        try{
            const shareLink = req.body.shareLink;
            const accountId = req.body.accountId;
            const accessCode = req.body.accessCode;
            const shareFolders = await taskService.parseShareFolderByShareLink(shareLink, accountId, accessCode);
            res.json({success: true, data: shareFolders})
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 保存常用目录
    app.post('/api/saveFavorites', async (req, res) => {
        try{
            const favorites = req.body.favorites;
            const accountId = req.body.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            // 先删除该账号下的所有常用目录
            await commonFolderRepo.delete({ accountId: accountId });
            // 构建新的常用目录数据
            const commonFolders = favorites.map(favorite => ({
                accountId: accountId,
                name: favorite.name,
                path: favorite.path,
                id: favorite.id
            }));
            if (commonFolders.length == 0) {
                res.json({ success: true, data: [] });
                return;
            }
            // 批量保存新的常用目录
            const result = await commonFolderRepo.save(commonFolders);
            res.json({ success: true, data: result });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 获取常用目录
    app.get('/api/favorites/:accountId', async (req, res) => {
        try{
            const accountId = parseInt(req.params.accountId);
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const favorites = await commonFolderRepo.find({
                where: { accountId: accountId },
                order: { id: 'ASC' }
            });
            res.json({ success: true, data: favorites });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 单条添加常用目录
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
    })
    // 单条删除常用目录
    app.delete('/api/favorites/:accountId/:folderId', async (req, res) => {
        try {
            const { accountId, folderId } = req.params;
            if (!accountId || !folderId) throw new Error('参数不完整');
            await commonFolderRepo.delete({ accountId: parseInt(accountId), id: folderId });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    
    app.post('/api/custom-push/test', async (req, res) => {
        try{
            const configTest = req.body
            if (await new CustomPushService([]).testPush(configTest)){
                res.json({ success: true, data: null });
            }else{
                res.json({ success: false, error: '推送测试失败' });
            }

        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    
    // 全局错误处理中间件
    app.use((err, req, res, next) => {
        console.error('捕获到全局异常:', err.message);
        res.status(500).json({ success: false, error: err.message });
    });


    initSSE(app)

    // 初始化cloudsaver
    setupCloudSaverRoutes(app);
    // 启动服务器
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`服务器运行在 http://localhost:${port}`);
    });
}).catch(error => {
    console.error('数据库连接失败:', error);
});

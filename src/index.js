require('dotenv').config();
const express = require('express');
const { AppDataSource } = require('./database');
const { Account, Task, CommonFolder, TransferredFile } = require('./entities');
const { TaskService } = require('./services/task');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager')
const ConfigService = require('./services/ConfigService');
const packageJson = require('../package.json');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { SchedulerService } = require('./services/scheduler');
const { initSSE } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const { registerRoutes } = require('./routes');
const path = require('path');
const { setupCloudSaverRoutes } = require('./sdk/cloudsaver');
const cors = require('cors'); 

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

    registerRoutes(app, {
        publicDir: path.join(__dirname, 'public'),
        currentVersion,
        accountRepo,
        taskRepo,
        commonFolderRepo,
        transferredFileRepo,
        taskService,
        messageUtil,
        botManager,
        folderCache,
    });
    
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

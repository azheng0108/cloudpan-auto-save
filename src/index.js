require('dotenv').config();
require('express-async-errors');
const express = require('express');
const { AppDataSource } = require('./database');
const { Account, Task, CommonFolder, TransferredFile, TaskError } = require('./entities');
const { TaskService } = require('./services/task');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager')
const ConfigService = require('./services/ConfigService');
const packageJson = require('../package.json');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { SchedulerService } = require('./services/scheduler');
const { initSSE, cleanupSSEConnections } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const { registerRoutes } = require('./routes');
const path = require('path');
const { setupCloudSaverRoutes } = require('./sdk/cloudsaver');
const cors = require('cors');
const logger = require('./utils/logger');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];

const corsOptionsDelegate = (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) {
        return callback(null, { origin: true, credentials: true });
    }

    const requestHostRaw = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const allowedSet = new Set(allowedOrigins.map(item => item.toLowerCase()));
    const allowAll = allowedSet.has('*');

    let originHost = '';
    try {
        originHost = new URL(origin).host.toLowerCase();
    } catch (_) {
        const error = new Error('CORS来源格式无效');
        error.status = 403;
        error.statusCode = 403;
        return callback(error);
    }

    const isSameHost = requestHostRaw && originHost === requestHostRaw;
    const isInAllowList = allowedSet.has(origin.toLowerCase());

    if (allowAll || isSameHost || isInAllowList) {
        return callback(null, {
            origin: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
            credentials: true,
        });
    }

    const error = new Error('CORS策略禁止此来源');
    error.status = 403;
    error.statusCode = 403;
    return callback(error);
};

app.use(cors(corsOptionsDelegate));
app.use(express.json());

const sessionSecret = ConfigService.getOrCreateSessionSecret();
app.use(session({
    store: new FileStore({
        path: './data/sessions',  // session文件存储路径
        ttl: 30 * 24 * 60 * 60,  // session过期时间，单位秒
        reapInterval: 3600,       // 清理过期session间隔，单位秒
        retries: 0,           // 设置重试次数为0
        logFn: () => {},      // 禁用内部日志
        reapAsync: true,      // 异步清理过期session
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 * 30, // 30天
    },
}));

let server = null;
let isShuttingDown = false;

const gracefulShutdown = async (signal, botManager) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`收到退出信号 ${signal}，开始优雅停机...`);

    try {
        if (server) {
            await new Promise((resolve) => {
                server.close(() => {
                    logger.info('HTTP服务器已关闭');
                    resolve();
                });
                setTimeout(resolve, 10000);
            });
        }

        cleanupSSEConnections();
        SchedulerService.stopAllJobs();

        if (botManager) {
            await botManager.handleBotStatus('', '', false);
        }

        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
            logger.info('数据库连接已关闭');
        }

        process.exit(0);
    } catch (error) {
        logger.error('优雅停机失败', { error: error.message, stack: error.stack });
        process.exit(1);
    }
};

// 初始化数据库连接
AppDataSource.initialize().then(async () => {
    // 当前版本:
    const currentVersion = packageJson.version;
    logger.info(`当前系统版本: ${currentVersion}`);
    logger.info('数据库连接成功');

    const accountRepo = AppDataSource.getRepository(Account);
    const taskRepo = AppDataSource.getRepository(Task);
    const commonFolderRepo = AppDataSource.getRepository(CommonFolder);
    const transferredFileRepo = AppDataSource.getRepository(TransferredFile);
    const taskErrorRepo = AppDataSource.getRepository(TaskError);
    const taskService = new TaskService(taskRepo, accountRepo, transferredFileRepo, taskErrorRepo);
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
        taskErrorRepo,
        taskService,
        messageUtil,
        botManager,
        folderCache,
    });
    initSSE(app)

    // 初始化cloudsaver
    setupCloudSaverRoutes(app);

    // 全局错误处理中间件（必须在路由之后）
    app.use((err, req, res, next) => {
        if (err.status === 403 || err.statusCode === 403) {
            logger.warn(`访问被拒绝: ${err.message}`, {
                url: req.url,
                method: req.method,
            });
        } else {
            logger.error('捕获到全局异常', {
                error: err.message,
                stack: err.stack,
                url: req.url,
                method: req.method,
            });
        }
        res.status(err.status || 500).json({
            success: false,
            error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
        });
    });

    // 启动服务器
    const port = process.env.PORT || 3000;
    server = app.listen(port, () => {
        logger.info(`服务器运行在 http://localhost:${port}`);
    });

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', botManager));
    process.on('SIGINT', () => gracefulShutdown('SIGINT', botManager));
}).catch(error => {
    logger.error('数据库连接失败', { error: error.message, stack: error.stack });
});

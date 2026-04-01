require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const cors = require('cors');
const path = require('path');
const packageJson = require('../package.json');
const { AppDataSource } = require('./database');
const { Account, Task, CommonFolder, TransferredFile } = require('./entities');
const { TaskService } = require('./services/task');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager');
const ConfigService = require('./services/ConfigService');
const { SchedulerService } = require('./services/scheduler');
const { initSSE } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const { setupCloudSaverRoutes } = require('./sdk/cloudsaver');
const { registerRoutes } = require('./routes');

const getSessionSecret = () => {
    const envSecret = process.env.SESSION_SECRET;
    if (envSecret && envSecret.length >= 32) {
        return envSecret;
    }

    const randomSecret = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  警告：SESSION_SECRET 环境变量未设置或长度不足（需要至少32字符）');
    console.warn('⚠️  已生成临时随机密钥，重启后会话将失效');
    console.warn('⚠️  请在环境变量中设置 SESSION_SECRET，例如：');
    console.warn(`⚠️  SESSION_SECRET="${randomSecret}"`);
    return randomSecret;
};

const getCorsOptions = () => {
    const corsOrigin = process.env.CORS_ORIGIN;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!corsOrigin) {
        if (isProduction) {
            throw new Error('生产环境必须设置 CORS_ORIGIN，禁止使用通配符回退');
        }
        console.warn('⚠️  未设置 CORS_ORIGIN，开发环境仅允许 localhost 源访问');
        const devWhitelist = ['http://localhost:3000', 'http://127.0.0.1:3000'];
        return {
            origin: (origin, callback) => {
                if (!origin || devWhitelist.includes(origin)) {
                    return callback(null, true);
                }
                callback(new Error(`来源 ${origin} 不在开发白名单中`));
            },
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
            credentials: true,
        };
    }

    if (corsOrigin === '*') {
        throw new Error('禁止使用 CORS_ORIGIN="*"，请配置明确的来源白名单');
    }

    const whitelist = corsOrigin.split(',').map((origin) => origin.trim());
    return {
        origin: (origin, callback) => {
            if (!origin || whitelist.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`来源 ${origin} 不在CORS白名单中`));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
        credentials: true,
    };
};

const app = express();
app.use(cors(getCorsOptions()));

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

app.use(express.json());

app.use(session({
    store: new FileStore({
        path: './data/sessions',
        ttl: 30 * 24 * 60 * 60,
        reapInterval: 3600,
        retries: 0,
        logFn: () => {},
        reapAsync: true,
    }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 * 30,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' && process.env.USE_HTTPS === 'true',
        sameSite: 'lax',
    },
}));

AppDataSource.initialize().then(async () => {
    const currentVersion = packageJson.version;
    console.log(`当前系统版本: ${currentVersion}`);
    console.log('数据库连接成功');

    const accountRepo = AppDataSource.getRepository(Account);
    const taskRepo = AppDataSource.getRepository(Task);
    const commonFolderRepo = AppDataSource.getRepository(CommonFolder);
    const transferredFileRepo = AppDataSource.getRepository(TransferredFile);
    const taskService = new TaskService(taskRepo, accountRepo, transferredFileRepo);
    const messageUtil = new MessageUtil();
    const botManager = TelegramBotManager.getInstance();

    await botManager.handleBotStatus(
        ConfigService.getConfigValue('telegram.bot.botToken'),
        ConfigService.getConfigValue('telegram.bot.chatId'),
        ConfigService.getConfigValue('telegram.bot.enable')
    );

    const folderCache = new CacheManager(parseInt(600));
    await SchedulerService.initTaskJobs(taskRepo, taskService);

    registerRoutes(app, {
        accountRepo,
        taskRepo,
        commonFolderRepo,
        taskService,
        messageUtil,
        botManager,
        folderCache,
        currentVersion,
        publicDir: path.join(__dirname, 'public'),
    });

    app.use((err, req, res, next) => {
        console.error('捕获到全局异常:', err.message);
        res.status(500).json({ success: false, error: err.message });
    });

    initSSE(app);
    setupCloudSaverRoutes(app);

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
        console.log(`服务器运行在 http://localhost:${port}`);
    });

    let isShuttingDown = false;
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) {
            console.log('已经在关闭中，忽略重复信号');
            return;
        }
        isShuttingDown = true;
        console.log(`\n收到 ${signal} 信号，开始优雅停机...`);

        const forceExitTimer = setTimeout(() => {
            console.error('优雅停机超时（30秒），强制退出');
            process.exit(1);
        }, 30000);

        try {
            console.log('1/5 停止接受新连接...');
            server.close(() => {
                console.log('HTTP服务器已关闭');
            });

            console.log('2/5 停止定时任务...');
            const schedulerService = SchedulerService.getInstance();
            if (schedulerService && schedulerService.stopAll) {
                schedulerService.stopAll();
            }

            console.log('3/5 关闭SSE连接...');
            const { closeAllSSEClients } = require('./utils/logUtils');
            if (closeAllSSEClients) {
                closeAllSSEClients();
            }

            console.log('4/5 停止Telegram机器人...');
            const telegramManager = TelegramBotManager.getInstance();
            if (telegramManager && telegramManager.stop) {
                await telegramManager.stop();
            }

            console.log('5/5 关闭数据库连接...');
            if (AppDataSource.isInitialized) {
                await AppDataSource.destroy();
                console.log('数据库连接已关闭');
            }

            clearTimeout(forceExitTimer);
            console.log('优雅停机完成，进程退出');
            process.exit(0);
        } catch (error) {
            console.error('优雅停机过程中出错:', error);
            clearTimeout(forceExitTimer);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
        console.error('未捕获的异常:', error);
        if (error.fatal) {
            gracefulShutdown('UNCAUGHT_EXCEPTION');
        }
    });

    process.on('unhandledRejection', (reason) => {
        console.error('未处理的Promise拒绝:', reason);
    });
}).catch((error) => {
    console.error('数据库连接失败:', error);
    process.exit(1);
});

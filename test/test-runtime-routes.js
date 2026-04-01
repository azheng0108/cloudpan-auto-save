/**
 * 运行时路由回归检查：健康检查响应与改密会话失效链路
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const distApiPath = path.join(__dirname, '..', 'dist', 'routes', 'api.js');
if (!fs.existsSync(distApiPath)) {
    throw new Error('未找到 dist/routes/api.js，请先执行 npm run build');
}

const { registerApiRoutes } = require(distApiPath);
const { AppDataSource } = require(path.join(__dirname, '..', 'dist', 'database', 'index.js'));
const ConfigService = require(path.join(__dirname, '..', 'dist', 'services', 'ConfigService.js'));
const { SchedulerService } = require(path.join(__dirname, '..', 'dist', 'services', 'scheduler.js'));
const { Cloud139Service } = require(path.join(__dirname, '..', 'dist', 'services', 'cloud139.js'));
const { Cloud189Service } = require(path.join(__dirname, '..', 'dist', 'services', 'cloud189.js'));

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function createMockApp() {
    const routes = { get: [], post: [], put: [], delete: [], use: [] };
    return {
        routes,
        get(route, handler) { routes.get.push({ route, handler }); },
        post(route, handler) { routes.post.push({ route, handler }); },
        put(route, handler) { routes.put.push({ route, handler }); },
        delete(route, handler) { routes.delete.push({ route, handler }); },
        use(handler) { routes.use.push({ handler }); },
    };
}

function findHandler(app, method, route) {
    const list = app.routes[method] || [];
    const found = list.find((item) => item.route === route);
    if (!found) {
        throw new Error(`未找到路由处理器: ${method.toUpperCase()} ${route}`);
    }
    return found.handler;
}

function createMockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
    };
}

async function run() {
    const app = createMockApp();

    const deps = {
        accountRepo: {},
        taskRepo: {},
        commonFolderRepo: {},
        taskService: {
            processAllTasks: async () => {},
            clearRecycleBin: async () => {},
        },
        messageUtil: {
            updateConfig: () => {},
        },
        botManager: {
            handleBotStatus: async () => {},
        },
        folderCache: {
            clearPrefix: () => {},
            has: () => false,
            get: () => null,
            set: () => {},
        },
        currentVersion: 'test-version',
    };

    registerApiRoutes(app, deps);

    const healthHandler = findHandler(app, 'get', '/api/health');
    const settingsHandler = findHandler(app, 'post', '/api/settings');

    const originalQuery = AppDataSource.query;
    const originalInitState = AppDataSource.isInitialized;
    const originalGetConfigValue = ConfigService.getConfigValue;
    const originalSetConfig = ConfigService.setConfig;
    const originalHandleScheduleTasks = SchedulerService.handleScheduleTasks;
    const originalClear139Instances = Cloud139Service.clearAllInstances;
    const originalClear189Instances = Cloud189Service.clearAllInstances;
    const originalReaddir = fsPromises.readdir;
    const originalStat = fsPromises.stat;
    const originalUnlink = fsPromises.unlink;

    const unlinkedFiles = [];
    let botUpdated = false;
    let messageUpdated = false;
    let scheduleHandled = false;
    let savedConfig = null;
    let cloud139Cleared = false;
    let cloud189Cleared = false;

    try {
        // 健康检查：模拟数据库可用
        AppDataSource.isInitialized = true;
        AppDataSource.query = async () => [{ ok: 1 }];

        const healthRes = createMockRes();
        await healthHandler({}, healthRes);
        assert(healthRes.statusCode === 200, '/api/health 应返回 200');
        assert(healthRes.body && healthRes.body.status === 'ok', '/api/health 返回状态应为 ok');
        assert(healthRes.body.version === 'test-version', '/api/health 版本号不正确');

        // 改密链路：模拟配置读写、调度、bot更新、会话文件清理
        ConfigService.getConfigValue = (key) => {
            if (key === 'system.password') return 'old-password';
            return null;
        };
        ConfigService.setConfig = (cfg) => {
            savedConfig = cfg;
        };
        SchedulerService.handleScheduleTasks = () => {
            scheduleHandled = true;
        };
        Cloud139Service.clearAllInstances = () => {
            cloud139Cleared = true;
        };
        Cloud189Service.clearAllInstances = () => {
            cloud189Cleared = true;
        };
        deps.botManager.handleBotStatus = async () => {
            botUpdated = true;
        };
        deps.messageUtil.updateConfig = () => {
            messageUpdated = true;
        };

        fsPromises.readdir = async () => ['tmp-session.json'];
        fsPromises.stat = async () => ({ isFile: () => true });
        fsPromises.unlink = async (filePath) => {
            unlinkedFiles.push(path.basename(filePath));
        };

        let destroyed = false;
        const req = {
            body: {
                system: { password: 'new-password' },
                task: {
                    taskCheckCron: '0 19-23 * * *',
                    retryTaskCron: '*/1 * * * *',
                    cleanRecycleCron: '0 */8 * * *',
                    enableAutoClearRecycle: false,
                    enableAutoClearFamilyRecycle: false,
                },
                telegram: {
                    bot: {
                        botToken: 'token',
                        chatId: 'chat',
                        enable: true,
                    },
                },
            },
            session: {
                authenticated: true,
                destroy: () => {
                    destroyed = true;
                },
            },
        };
        const settingsRes = createMockRes();
        await settingsHandler(req, settingsRes);

        assert(settingsRes.statusCode === 200, '/api/settings 应返回 200');
        assert(settingsRes.body && settingsRes.body.success === true, '/api/settings 返回应为 success=true');
        assert(scheduleHandled, '/api/settings 未触发调度任务处理');
        assert(savedConfig !== null, '/api/settings 未触发配置写入');
        assert(savedConfig.task.retryTaskCron === '*/1 * * * *', '/api/settings 未正确保存 retryTaskCron');
        assert(cloud139Cleared, '/api/settings 未清理 Cloud139Service 实例缓存');
        assert(cloud189Cleared, '/api/settings 未清理 Cloud189Service 实例缓存');
        assert(botUpdated, '/api/settings 未触发 bot 配置更新');
        assert(messageUpdated, '/api/settings 未触发消息配置更新');
        assert(req.session.authenticated === false, '改密后当前会话未标记失效');
        assert(destroyed, '改密后当前会话未销毁');
        assert(unlinkedFiles.includes('tmp-session.json'), '改密后未触发会话文件清理');

        // Cron 非法应返回 400 且不写配置
        savedConfig = null;
        const invalidReq = {
            body: {
                system: { password: 'old-password' },
                task: {
                    taskCheckCron: 'invalid-cron',
                    retryTaskCron: '*/1 * * * *',
                    cleanRecycleCron: '0 */8 * * *',
                    enableAutoClearRecycle: false,
                    enableAutoClearFamilyRecycle: false,
                },
            },
            session: null,
        };
        const invalidRes = createMockRes();
        await settingsHandler(invalidReq, invalidRes);
        assert(invalidRes.statusCode === 400, 'Cron 非法时 /api/settings 应返回 400');
        assert(invalidRes.body && invalidRes.body.success === false, 'Cron 非法时应返回 success=false');
        assert(savedConfig === null, 'Cron 非法时不应写入配置');

        console.log('✅ Runtime route checks passed');
    } finally {
        AppDataSource.query = originalQuery;
        AppDataSource.isInitialized = originalInitState;
        ConfigService.getConfigValue = originalGetConfigValue;
        ConfigService.setConfig = originalSetConfig;
        SchedulerService.handleScheduleTasks = originalHandleScheduleTasks;
        Cloud139Service.clearAllInstances = originalClear139Instances;
        Cloud189Service.clearAllInstances = originalClear189Instances;
        fsPromises.readdir = originalReaddir;
        fsPromises.stat = originalStat;
        fsPromises.unlink = originalUnlink;
    }
}

run().catch((error) => {
    console.error(`❌ Runtime route checks failed: ${error.message}`);
    process.exit(1);
});

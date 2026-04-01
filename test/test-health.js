/**
 * D1 回归检查：健康检查、会话踢出、容器启动链路与路由注册
 */

const fs = require('fs');
const path = require('path');
const { registerAuthRoutes } = require('../src/routes/auth');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function read(relPath) {
    return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
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

function run() {
    const apiJs = read('src/routes/api.js');
    const authJs = read('src/routes/auth.js');
    const indexJs = read('src/index.js');
    const dockerfile = read('Dockerfile');
    const packageJson = JSON.parse(read('package.json'));

    const app = createMockApp();
    registerAuthRoutes(app, path.join(__dirname, '..', 'src/public'), 'test');

    assert(apiJs.includes("app.get('/api/health'"), '缺少 /api/health 路由定义');
    assert(apiJs.includes('clearAllSessionFiles'), '缺少会话清理函数');
    assert(apiJs.includes('req.session.destroy'), '缺少当前会话销毁逻辑');

    assert(authJs.includes("req.path === '/api/health'"), '健康检查未加入免登录白名单');
    assert(authJs.includes('index: false'), '静态资源服务未禁用 index，存在直接访问 HTML 风险');
    assert(indexJs.includes('registerRoutes(app,'), '入口未接入 routes 模块注册');

    assert(dockerfile.includes('HEALTHCHECK'), 'Dockerfile 缺少 HEALTHCHECK');
    assert(dockerfile.includes('USER node'), 'Dockerfile 缺少 USER node');
    assert(dockerfile.includes('CMD ["npm", "run", "start:prod"]'), 'Dockerfile 未使用 start:prod 启动链路');

    assert(packageJson.scripts['start:prod'], '缺少 start:prod 脚本');
    assert(packageJson.scripts['migration:run:prod'], '缺少 migration:run:prod 脚本');

    console.log('✅ D1 health/session/docker checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ D1 checks failed: ${error.message}`);
    process.exit(1);
}

/**
 * D1 静态回归检查：健康检查、会话踢出、容器启动链路
 */

const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function read(relPath) {
    return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function run() {
    const apiJs = read('src/routes/api.js');
    const authJs = read('src/routes/auth.js');
    const dockerfile = read('Dockerfile');
    const packageJson = JSON.parse(read('package.json'));

    assert(apiJs.includes("app.get('/api/health'"), '缺少 /api/health 路由');
    assert(apiJs.includes('clearAllSessionFiles'), '缺少会话清理函数');
    assert(apiJs.includes('req.session.destroy'), '缺少当前会话销毁逻辑');

    assert(authJs.includes("req.path === '/api/health'"), '健康检查未加入免登录白名单');

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

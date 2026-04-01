/**
 * CR 回归检查：并行账号查询、非阻塞 executeAll、用户名脱敏
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
    const authJs = read('src/routes/auth.js');
    const apiJs = read('src/routes/api.js');

    assert(authJs.includes("path.join(publicDir, 'index.html')"), 'auth.js 未使用跨平台 path.join 处理 index 页面路径');
    assert(authJs.includes("path.join(publicDir, 'login.html')"), 'auth.js 未使用跨平台 path.join 处理 login 页面路径');

    assert(apiJs.includes('const maskUsername = (username)'), 'api.js 缺少统一用户名脱敏函数');
    assert(apiJs.includes('await Promise.all(accounts.map(async (account) => {'), 'api.js 未将账号容量查询并行化');

    assert(apiJs.includes('Promise.resolve()'), 'executeAll 未改为后台异步触发');
    assert(!apiJs.includes('await taskService.processAllTasks(true);'), 'executeAll 仍在请求中等待全量执行完成');

    assert(apiJs.includes('task.account.username = maskUsername(task.account.username);'), '任务列表接口未使用统一脱敏函数');
    assert(apiJs.includes('account.username = maskUsername(account.username);'), '账号列表接口未使用统一脱敏函数');

    console.log('✅ CR review fixes checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ CR checks failed: ${error.message}`);
    process.exit(1);
}

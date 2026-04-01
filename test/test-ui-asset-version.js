/**
 * D3 静态回归检查：前端静态资源版本参数与模态打开行为
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
    const indexHtml = read('src/public/index.html');
    const loginHtml = read('src/public/login.html');
    const tasksJs = read('src/public/js/tasks.js');
    const editJs = read('src/public/js/edit-task.js');
    const folderSelectorJs = read('src/public/js/folderSelector.js');
    const accountsJs = read('src/public/js/accounts.js');

    assert(authJs.includes('__ASSET_VERSION__'), 'auth 路由未注入资源版本占位符');

    assert(indexHtml.includes('?v=__ASSET_VERSION__'), 'index.html 缺少静态资源版本参数');
    assert(loginHtml.includes('?v=__ASSET_VERSION__'), 'login.html 缺少静态资源版本参数');

    assert(tasksJs.includes("createTaskModal').style.display = 'flex'"), '创建任务弹窗未使用 flex 打开');
    assert(editJs.includes("editTaskModal').style.display = 'flex'"), '编辑任务弹窗未使用 flex 打开');
    assert(folderSelectorJs.includes("this.modal.style.display = 'flex'"), '目录选择弹层未使用 flex 打开');
    assert(accountsJs.includes("modal.style.display = 'flex';"), '账号弹窗未使用 flex 打开');

    console.log('✅ D3 asset-version/modal checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ D3 checks failed: ${error.message}`);
    process.exit(1);
}

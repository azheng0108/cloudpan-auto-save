/**
 * D2 静态回归检查：legacy189 默认运行链路隔离
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
    const configJs = read('src/services/ConfigService.js');
    const telegramJs = read('src/services/telegramBot.js');
    const embyJs = read('src/services/emby.js');

    assert(configJs.includes('enableCloud189Runtime: false'), 'ConfigService 缺少 legacy.enableCloud189Runtime 默认关闭');

    assert(telegramJs.includes('_isLegacy189RuntimeEnabled()'), 'telegramBot 缺少 legacy 开关判断函数');
    assert(telegramJs.includes('已禁用 189'), 'telegramBot 缺少 189 默认禁用提示');

    assert(embyJs.includes('_isLegacy189RuntimeEnabled()'), 'emby 缺少 legacy 开关判断函数');
    assert(embyJs.includes('跳过 legacy189 文件删除逻辑'), 'emby 缺少 legacy189 默认禁用保护分支');

    console.log('✅ D2 legacy isolation checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ D2 checks failed: ${error.message}`);
    process.exit(1);
}

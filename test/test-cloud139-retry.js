/**
 * D2 静态回归检查：Cloud139 重试/轮询能力与处理器接入
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
    const cloud139Js = read('src/services/cloud139.js');
    const processorJs = read('src/services/cloud139TaskProcessor.js');

    assert(cloud139Js.includes('saveShareFilesWithRetry('), 'cloud139.js 缺少 saveShareFilesWithRetry');
    assert(cloud139Js.includes('waitForFilesVisible('), 'cloud139.js 缺少 waitForFilesVisible');
    assert(cloud139Js.includes('_computeBackoffMs('), 'cloud139.js 缺少退避计算函数');
    assert(cloud139Js.includes('_isRetryableError('), 'cloud139.js 缺少可重试错误判断');

    assert(processorJs.includes('saveShareBatchWithRetryAndVerify('), 'taskProcessor 缺少重试+校验封装');
    assert(processorJs.includes('saveShareFilesWithRetry('), 'taskProcessor 未接入 saveShareFilesWithRetry');
    assert(processorJs.includes('waitForFilesVisible('), 'taskProcessor 未接入可见性轮询');

    console.log('✅ D2 cloud139 retry/polling checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ D2 checks failed: ${error.message}`);
    process.exit(1);
}

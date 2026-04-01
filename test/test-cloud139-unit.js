/**
 * Phase E: cloud139 单元检查（重试/轮询/错误分类）
 */

const { Cloud139Service } = require('../src/services/cloud139');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function testRetryableErrorClassification() {
    const svc = Object.create(Cloud139Service.prototype);

    assert(svc._isRetryableError(null) === true, 'null 错误应视为可重试');
    assert(svc._isRetryableError({ fatal: true }) === false, 'fatal 错误不应重试');
    assert(svc._isRetryableError({ name: 'TimeoutError' }) === true, 'TimeoutError 应重试');
    assert(svc._isRetryableError({ response: { statusCode: 429 } }) === true, '429 应重试');
    assert(svc._isRetryableError({ response: { statusCode: 503 } }) === true, '5xx 应重试');
    assert(svc._isRetryableError({ message: 'network disconnected' }) === true, 'network 关键字应重试');
    assert(svc._isRetryableError({ message: 'bad request' }) === false, '普通错误不应重试');
}

async function testSaveShareFilesWithRetryOnNullResult() {
    const svc = Object.create(Cloud139Service.prototype);
    let attempts = 0;

    svc.saveShareFiles = async () => {
        attempts += 1;
        if (attempts < 2) return null;
        return { taskID: 'ok' };
    };
    svc._sleep = async () => {};
    svc._computeBackoffMs = () => 1;

    const res = await svc.saveShareFilesWithRetry('lk', ['a/b'], [], 'target', false, {
        maxAttempts: 3,
        baseDelayMs: 1,
    });

    assert(res && res.taskID === 'ok', '第二次成功时应返回结果');
    assert(attempts === 2, '空结果后应重试一次');
}

async function testSaveShareFilesWithRetryFatalError() {
    const svc = Object.create(Cloud139Service.prototype);
    let attempts = 0;

    svc.saveShareFiles = async () => {
        attempts += 1;
        const err = new Error('fatal');
        err.fatal = true;
        throw err;
    };
    svc._sleep = async () => {};
    svc._computeBackoffMs = () => 1;

    let gotError = null;
    try {
        await svc.saveShareFilesWithRetry('lk', ['a/b'], [], 'target', false, {
            maxAttempts: 3,
            baseDelayMs: 1,
        });
    } catch (error) {
        gotError = error;
    }

    assert(gotError, 'fatal 错误应抛出');
    assert(attempts === 1, 'fatal 错误不应重试');
}

async function testWaitForFilesVisibleSuccess() {
    const svc = Object.create(Cloud139Service.prototype);
    let poll = 0;

    svc.listAllDiskFiles = async () => {
        poll += 1;
        if (poll < 2) return [{ name: 'ep01.mkv' }];
        return [{ name: 'ep01.mkv' }, { name: 'ep02.mkv' }];
    };
    svc._sleep = async () => {};

    const res = await svc.waitForFilesVisible('target', ['ep01.mkv', 'ep02.mkv'], {
        timeoutMs: 50,
        intervalMs: 1,
    });

    assert(res.allVisible === true, '文件最终可见应返回 allVisible=true');
    assert(res.visibleCount === 2, '可见计数应正确');
}

async function testWaitForFilesVisibleTimeout() {
    const svc = Object.create(Cloud139Service.prototype);

    svc.listAllDiskFiles = async () => [{ name: 'ep01.mkv' }];
    svc._sleep = async () => {};

    const res = await svc.waitForFilesVisible('target', ['ep01.mkv', 'ep02.mkv'], {
        timeoutMs: 1,
        intervalMs: 1,
    });

    assert(res.allVisible === false, '超时应返回 allVisible=false');
    assert(Array.isArray(res.missing) && res.missing.includes('ep02.mkv'), '应包含缺失文件');
}

async function run() {
    await testRetryableErrorClassification();
    await testSaveShareFilesWithRetryOnNullResult();
    await testSaveShareFilesWithRetryFatalError();
    await testWaitForFilesVisibleSuccess();
    await testWaitForFilesVisibleTimeout();

    console.log('✅ cloud139 unit checks passed');
}

run().catch((error) => {
    console.error(`❌ cloud139 unit checks failed: ${error.message}`);
    process.exit(1);
});

const fs = require('fs').promises;
const logger = require('./logger');

// 存储所有的 SSE 客户端
const clients = new Set();
const LOG_FILE = 'data/logs/app.log';
const MAX_LOG_SIZE = 1024 * 100;   // 100KB：历史日志读取窗口 / 轮转后保留量
const MAX_LOG_FILE_SIZE = 512 * 1024; // 512KB：触发自动轮转的阈值

// 日志轮转锁，避免并发重写
let _rotating = false;

/**
 * 当日志文件超过 MAX_LOG_FILE_SIZE 时，只保留最后 MAX_LOG_SIZE 的内容。
 * 轮转时丢弃第一行残缺行，确保每行都是完整记录。
 */
async function rotateLogs() {
    if (_rotating) return;
    _rotating = true;
    try {
        const stat = await fs.stat(LOG_FILE);
        if (stat.size <= MAX_LOG_FILE_SIZE) return;
        const start = stat.size - MAX_LOG_SIZE;
        const fileHandle = await fs.open(LOG_FILE, 'r');
        const buffer = Buffer.alloc(MAX_LOG_SIZE);
        await fileHandle.read(buffer, 0, MAX_LOG_SIZE, start);
        await fileHandle.close();
        let content = buffer.toString('utf8');
        // 跳过起始的残缺行，保证每行都完整
        const firstNewline = content.indexOf('\n');
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
        await fs.writeFile(LOG_FILE, content);
    } catch (e) {
        logger.error('日志轮转失败', { error: e.message });
    } finally {
        _rotating = false;
    }
}

// 初始化 SSE
const initSSE = (app) => {
    app.get('/api/logs/events', async (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // 先把历史日志发完，再加入实时推送集合。
        // 若顺序颠倒，新日志会在历史之前到达客户端，
        // 前端 history 事件会覆盖 logLines 导致新日志丢失。
        await sendHistoryLogs(res);

        // 客户端可能在 history 读取期间已断开
        if (res.writableEnded) return;

        clients.add(res);
        req.on('close', () => {
            clients.delete(res);
        });
    });
};

const cleanupSSEConnections = () => {
    clients.forEach((client) => {
        try {
            client.end();
        } catch (_) {
            // ignore client close errors
        }
    });
    clients.clear();
};

// 发送历史日志
const sendHistoryLogs = async (res) => {
    try {
        const stat = await fs.stat(LOG_FILE);
        const start = stat.size > MAX_LOG_SIZE ? stat.size - MAX_LOG_SIZE : 0;

        const fileHandle = await fs.open(LOG_FILE, 'r');
        const buffer = Buffer.alloc(stat.size - start);
        await fileHandle.read(buffer, 0, buffer.length, start);
        await fileHandle.close();

        let logs = buffer.toString('utf8');
        // 从文件中间开始读取时，第一行可能是残缺行，跳过它
        if (start > 0) {
            const firstNewline = logs.indexOf('\n');
            if (firstNewline >= 0) logs = logs.slice(firstNewline + 1);
        }
        res.write(`data: ${JSON.stringify({type: 'history', logs: logs.split('\n').filter(Boolean)})}\n\n`);
    } catch (error) {
        // 文件不存在时静默，返回空历史
        if (error.code !== 'ENOENT') {
            logger.error('读取历史日志失败', { error: error.message, stack: error.stack });
        }
        res.write(`data: ${JSON.stringify({type: 'history', logs: []})}\n\n`);
    }
};
 // 记录任务日志
 const logTaskEvent = async (message = null) => {
    if (!message) {
        return;
    }
    // 获取当前时间
    const currentTime = new Date();
    // 构建日志消息
    let logMessage = `[${currentTime.toLocaleString()}] ${message}`;
    logger.info(logMessage);

    try {
        await fs.appendFile(LOG_FILE, logMessage + '\n');

        // 写入后异步检查是否需要轮转，不阻塞当前调用
        rotateLogs().catch(e => logger.error('rotateLogs error', { error: e.message }));

        // 向所有连接的客户端发送日志
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({type: 'log', message: logMessage})}\n\n`);
        });
    } catch (error) {
        logger.error('写入日志失败', { error: error.message, stack: error.stack });
    }
}

// 添加发送AI消息的函数
const sendAIMessage = (message) => {
    clients.forEach(client => {
        client.write(`data: ${JSON.stringify({type: 'aimessage', message})}\n\n`);
    });
};


module.exports = {
    logTaskEvent,
    initSSE,
    sendAIMessage,
    cleanupSSEConnections
}

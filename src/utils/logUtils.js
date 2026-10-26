const fs = require('fs').promises;
const logger = require('./logger');

// 存储所有的 SSE 客户端
const clients = new Set();
const LOG_FILE = 'data/logs/app.log';
const MAX_LOG_SIZE = 500 * 1024;   // 500KB：历史日志读取窗口 / 轮转后保留量 (~5000行)
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB：触发自动轮转的阈值

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
        // 轮转降级保护
    } finally {
        _rotating = false;
    }
}

/**
 * 统一接收来自 Winston 记录器的所有日志事件（覆盖所有模块、所有级别的全局日志）
 * 写入本地 app.log 并实时通过 SSE 推送给前端全局系统日志面板
 */
function broadcastWinstonLog(info) {
    if (!info) return;
    if (process.env.NODE_ENV === 'test') return;

    try {
        const { level, message, stack, timestamp, ...meta } = info;
        let logText = typeof message === 'object' ? JSON.stringify(message) : String(message || '');
        if (stack) {
            logText += `\n${stack}`;
        }
        const metaKeys = Object.keys(meta);
        if (metaKeys.length > 0) {
            try {
                logText += ` ${JSON.stringify(meta)}`;
            } catch (_) {}
        }

        const upperLevel = String(level || 'info').toUpperCase();
        if (upperLevel === 'DEBUG' && !logText.includes('[DEBUG]')) {
            logText = `[DEBUG] ${logText}`;
        } else if (upperLevel === 'WARN' && !logText.includes('[WARN]')) {
            logText = `[WARN] ${logText}`;
        } else if (upperLevel === 'ERROR' && !logText.includes('[ERROR]')) {
            logText = `[ERROR] ${logText}`;
        }

        if (!/^\[\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(logText)) {
            const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
            logText = `[${timeStr}] ${logText}`;
        }

        // 异步追加写入本地 app.log 文件
        fs.appendFile(LOG_FILE, logText + '\n').catch(() => {});

        // 异步检查并执行日志轮转
        rotateLogs().catch(() => {});

        // 实时推送给 SSE 客户端
        const payload = `data: ${JSON.stringify({ type: 'log', message: logText })}\n\n`;
        clients.forEach(client => {
            try {
                client.write(payload);
            } catch (_) {}
        });
    } catch (_) {
        // 静默保护
    }
}

global._onWinstonLog = broadcastWinstonLog;

// 初始化 SSE 与日志下载
const initSSE = (app) => {
    app.get('/api/logs/download', async (req, res) => {
        try {
            const content = await fs.readFile(LOG_FILE);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="cloudpan-app-${Date.now()}.log"`);
            res.send(content);
        } catch (error) {
            res.status(404).send('暂无可用系统日志');
        }
    });

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
// 兼容既有 logTaskEvent 调用，无缝转为 logger.info 并经由全局广播通道推送
const logTaskEvent = async (message = null) => {
    if (!message) {
        return;
    }
    logger.info(message);
};

// 添加发送AI消息的函数
const sendAIMessage = (message) => {
    if (process.env.NODE_ENV === 'test') {
        return;
    }
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

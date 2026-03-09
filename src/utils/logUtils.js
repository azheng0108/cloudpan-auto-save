const fs = require('fs').promises;

// 存储所有的 SSE 客户端
const clients = new Set();
const LOG_FILE = '/tmp/cloud189-app.log';
const MAX_LOG_SIZE = 1024 * 100; // 100kb
// 初始化 SSE
const initSSE = (app) => {
    app.get('/api/logs/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // 发送历史日志
        sendHistoryLogs(res);

        // 将客户端添加到集合中
        clients.add(res);

        // 客户端断开连接时清理
        req.on('close', () => {
            clients.delete(res);
        });
    });
};

// 发送历史日志
const sendHistoryLogs = async (res) => {
    try {
        const stat = await fs.stat(LOG_FILE);
        // 如果文件大于 1MB，只读取最后 1MB 的内容
        const start = stat.size > MAX_LOG_SIZE ? stat.size - MAX_LOG_SIZE : 0;

        const fileHandle = await fs.open(LOG_FILE, 'r');
        const buffer = Buffer.alloc(stat.size - start);
        await fileHandle.read(buffer, 0, buffer.length, start);
        await fileHandle.close();
        
        const logs = buffer.toString('utf8');
        res.write(`data: ${JSON.stringify({type: 'history', logs: logs.split('\n').filter(Boolean)})}\n\n`);
    } catch (error) {
        console.error('读取历史日志失败:', error);
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
    console.log(logMessage);

    try {
        await fs.appendFile(LOG_FILE, logMessage + '\n');
        
        // 向所有连接的客户端发送日志
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({type: 'log', message: logMessage})}\n\n`);
        });
    } catch (error) {
        console.error('写入日志失败:', error);
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
    sendAIMessage
}
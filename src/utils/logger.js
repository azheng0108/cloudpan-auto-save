const fs = require('fs');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logDir = path.join(process.cwd(), 'data', 'logs');
let logDirAvailable = true;
try {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
} catch (error) {
    logDirAvailable = false;
    console.error(`日志目录初始化失败，已降级为仅控制台日志: ${error.message}`);
}

/**
 * 递归解包并提取错误真实诱因（支持 AggregateError / HTTPError / 响应体解析）
 * @param {any} err 
 * @returns {string}
 */
function unpackErrorReason(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err !== 'object') return String(err);

    let reason = err.message || '';

    // 针对 AggregateError（如 Happy Eyeballs 双栈网络连接超时，其主 message 往往为空）
    if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
        const subMessages = err.errors.map(e => unpackErrorReason(e)).filter(Boolean);
        if (subMessages.length > 0) {
            reason = subMessages.join('; ');
        }
    }

    // 提取 HTTP 响应体内部的官方报错（如 Telegram description 或 TMDB status_message）
    const body = err.response?.body;
    if (body) {
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            if (parsed && typeof parsed === 'object') {
                const subDetail = parsed.description || parsed.status_message || parsed.desc || parsed.message;
                if (subDetail) {
                    reason += ` (服务端响应: ${subDetail})`;
                }
            }
        } catch (_) {
            if (typeof body === 'string' && body.trim() && !body.includes('<html')) {
                reason += ` (响应体: ${body.slice(0, 150).trim()})`;
            }
        }
    }

    // 网络底层故障自动给出诊断指引
    const code = err.code || (err.response?.statusCode ? `HTTP_${err.response.statusCode}` : '');
    if (code === 'ECONNREFUSED') {
        reason += ' [网络拒绝: 目标端口未开启或在Docker容器中误填了127.0.0.1导致无法连通宿主机代理]';
    } else if (code === 'ETIMEDOUT' || (err.stack && err.stack.includes('ETIMEDOUT'))) {
        reason += ' [连接超时: 目标服务网络不可达或超时，请检查外网连通性或代理配置]';
    } else if (code === 'ENOTFOUND') {
        reason += ' [DNS解析失败: 无法解析域名]';
    }

    return reason || String(err);
}

class BroadcastTransport extends winston.Transport {
    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });
        if (typeof global._onWinstonLog === 'function') {
            try {
                global._onWinstonLog(info);
            } catch (_) {
                // ignore errors in broadcast hook
            }
        }
        callback();
    }
}

// 自动深度增强 error 字段信息的自定义 Winston 格式化插件
const enrichErrorFormat = winston.format((info) => {
    if (info.error) {
        info.error = unpackErrorReason(info.error);
    }
    return info;
});

const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
            const {
                timestamp, level, message, stack, error, ...meta
            } = info;
            let displayMsg = stack || message;
            // 控制台输出时，若有明确解包出来的真实原因且未在主文案中，自动拼接展示
            if (error && typeof error === 'string' && error.trim() && !displayMsg.includes(error)) {
                displayMsg = `${displayMsg} -> 真实原因: ${error}`;
            }
            const base = `${timestamp} ${level}: ${displayMsg}`;
            const metaKeys = Object.keys(meta);
            if (metaKeys.length === 0) {
                return base;
            }
            return `${base} ${JSON.stringify(meta)}`;
        })
    ),
});

const transports = [consoleTransport, new BroadcastTransport()];
if (logDirAvailable && process.env.NODE_ENV !== 'test') {
    transports.push(new DailyRotateFile({
        filename: path.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        auditFile: path.join(logDir, '.audit.json'),
    }));
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        enrichErrorFormat(),
        winston.format.json()
    ),
    transports,
});

module.exports = logger;

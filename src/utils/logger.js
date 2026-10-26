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

const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
            const {
                timestamp, level, message, stack, ...meta
            } = info;
            const base = `${timestamp} ${level}: ${stack || message}`;
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
        winston.format.json()
    ),
    transports,
});

module.exports = logger;

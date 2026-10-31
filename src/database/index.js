const { DataSource } = require('typeorm');
const { Account, Task, CommonFolder, TransferredFile, TaskError, ScrapeBatch, ScrapeRecord, ScrapeBinding, ChannelMonitor, ChannelMonitorHistory, MaintenanceJob } = require('../entities');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('../utils/logger');

const fs = require('fs');

dotenv.config();

const dbPath = path.join(__dirname, '../../data/database.sqlite');
const dbDir = path.dirname(dbPath);

// 数据目录存在性与可写性防御自检
try {
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    fs.accessSync(dbDir, fs.constants.W_OK);
} catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
        const uidInfo = process.getuid ? `UID: ${process.getuid()}` : '未知';
        console.error('================================================================');
        console.error(`[权限致命错误] 数据目录不可写: ${dbDir}`);
        console.error(`当前运行进程身份: ${uidInfo}`);
        console.error('排查解决指引:');
        console.error(' 1. 宿主机修改所有权: sudo chown -R 1000:1000 <宿主机挂载的数据目录>');
        console.error(' 2. 或在 Docker 启动命令中添加: --user root');
        console.error('================================================================');
    }
}

const AppDataSource = new DataSource({
    type: (() => {
        try {
            const Database = require('better-sqlite3');
            const testDb = new Database(':memory:');
            testDb.close();
            return 'better-sqlite3';
        } catch (e) {
            logger.warn(`[Database] better-sqlite3 原生模块未就绪 (${e.message})，自适应切换至 sqlite3 驱动`);
            return 'sqlite';
        }
    })(),
    database: dbPath,
    synchronize: false,  // 禁止自动同步，使用migration管理schema变更
    logging: false,
    // better-sqlite3 通过 prepareDatabase 钩子设置 PRAGMA
    prepareDatabase: (db) => {
        db.pragma('journal_mode = WAL');   // WAL 模式提升并发读性能
        db.pragma('busy_timeout = 3000');  // 等锁超时 3 秒
    },
    entities: [Account, Task, CommonFolder, TransferredFile, TaskError, ScrapeBatch, ScrapeRecord, ScrapeBinding, ChannelMonitor, ChannelMonitorHistory, MaintenanceJob],
    subscribers: [],
    migrations: [path.join(__dirname, 'migrations/*.js')],
    timezone: '+08:00',  // 添加时区设置
    dateStrings: true,   // 将日期作为字符串返回
});

const initDatabase = async () => {
    try {
        await AppDataSource.initialize();
        logger.info('数据库连接成功');
    } catch (error) {
        logger.error('数据库连接失败', { error: error.message, stack: error.stack });
        process.exit(1);
    }
};

const getAccountRepository = () => AppDataSource.getRepository(Account);
const getTaskRepository = () => AppDataSource.getRepository(Task);
const getCommonFolderRepository = () => AppDataSource.getRepository(CommonFolder);
const getTransferredFileRepository = () => AppDataSource.getRepository(TransferredFile);
const getTaskErrorRepository = () => AppDataSource.getRepository(TaskError);
const getChannelMonitorRepository = () => AppDataSource.getRepository(ChannelMonitor);
const getChannelMonitorHistoryRepository = () => AppDataSource.getRepository(ChannelMonitorHistory);
const getMaintenanceJobRepository = () => AppDataSource.getRepository(MaintenanceJob);

module.exports = {
    AppDataSource,
    initDatabase,
    getAccountRepository,
    getTaskRepository,
    getCommonFolderRepository,
    getTransferredFileRepository,
    getTaskErrorRepository,
    getChannelMonitorRepository,
    getChannelMonitorHistoryRepository,
    getMaintenanceJobRepository
};


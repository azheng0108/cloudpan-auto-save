const { DataSource } = require('typeorm');
const { Account, Task, CommonFolder, TransferredFile, TaskError } = require('../entities');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('../utils/logger');

dotenv.config();

const AppDataSource = new DataSource({
    type: 'better-sqlite3',
    database: path.join(__dirname, '../../data/database.sqlite'),
    synchronize: false,  // 禁止自动同步，使用migration管理schema变更
    logging: false,
    // better-sqlite3 通过 prepareDatabase 钩子设置 PRAGMA
    prepareDatabase: (db) => {
        db.pragma('journal_mode = WAL');   // WAL 模式提升并发读性能
        db.pragma('busy_timeout = 3000');  // 等锁超时 3 秒
    },
    entities: [Account, Task, CommonFolder, TransferredFile, TaskError],
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

module.exports = {
    AppDataSource,
    initDatabase,
    getAccountRepository,
    getTaskRepository,
    getCommonFolderRepository,
    getTransferredFileRepository,
    getTaskErrorRepository
};

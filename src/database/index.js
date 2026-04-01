const { DataSource } = require('typeorm');
const { Account, Task, CommonFolder, TransferredFile } = require('../entities');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// 判断是否为生产环境
const isProduction = process.env.NODE_ENV === 'production';

const AppDataSource = new DataSource({
    type: 'sqlite',
    database: path.join(__dirname, '../../data/database.sqlite'),
    synchronize: !isProduction, // 生产环境禁用自动同步
    logging: process.env.DB_LOGGING === 'true',
    maxQueryExecutionTime: 1000, // 查询超时设置
    enableWAL: true,   // 启用 WAL 模式提升性能
    busyTimeout: 3000, // 设置超时时间
    entities: [Account, Task, CommonFolder, TransferredFile],
    subscribers: [],
    migrations: [path.join(__dirname, '../migrations/*.js')],
    timezone: '+08:00',  // 添加时区设置
    dateStrings: true,   // 将日期作为字符串返回
    poolSize: 10,
    queryTimeout: 30000,
    // 添加自定义日期处理
    extra: {
        dateStrings: true,
        typeCast: function (field, next) {
            if (field.type === 'DATETIME') {
                return new Date(`${field.string()}+08:00`);
            }
            return next();
        }
    }
});

const initDatabase = async () => {
    try {
        await AppDataSource.initialize();
        console.log('数据库连接成功');
        
        if (!isProduction) {
            console.log('⚠️  开发模式：synchronize已启用（自动同步schema）');
        } else {
            console.log('✓ 生产模式：synchronize已禁用，使用migrations管理schema');
        }
    } catch (error) {
        console.error('数据库连接失败:', error);
        process.exit(1);
    }
};

const getAccountRepository = () => AppDataSource.getRepository(Account);
const getTaskRepository = () => AppDataSource.getRepository(Task);
const getCommonFolderRepository = () => AppDataSource.getRepository(CommonFolder);
const getTransferredFileRepository = () => AppDataSource.getRepository(TransferredFile);

module.exports = {
    AppDataSource,
    initDatabase,
    getAccountRepository,
    getTaskRepository,
    getCommonFolderRepository,
    getTransferredFileRepository
};
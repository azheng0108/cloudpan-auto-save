import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';

@Entity()
export class Account {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    username!: string;

    @Column('text', { nullable: true})
    password!: string;

    @Column('text', { nullable: true})
    cookies!: string;

    @Column('boolean', { default: true })
    isActive!: boolean;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;

    @Column('boolean', { nullable: true, default: false })
    clearRecycle!: boolean;

    @Column('text', { nullable: true, default: ''  })
    localStrmPrefix!: string;
    @Column('text', { nullable: true, default: '' })
    cloudStrmPrefix!: string;
    @Column('text', { nullable: true, default: '' })
    embyPathReplace!:string;

    @Column('boolean', { nullable: true, default: false })
    tgBotActive!: boolean;

    @Column('text', { nullable: true, default: '' })
    alias!: string;

    // 账号类型: cloud189 | cloud139
    @Column('text', { nullable: true, default: 'cloud189' })
    accountType!: string;

    // 默认账号
    @Column('boolean', { nullable: true, default: false })
    isDefault!: boolean;
}

@Entity()
export class Task {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    accountId!: number;

    @ManyToOne(() => Account, { nullable: true })
    @JoinColumn({ name: 'accountId' })
    account!: Account;

    @Column('text')
    shareLink!: string;

    @Column('text')
    targetFolderId!: string;

    @Column('text', { nullable: true })
    videoType!: string;

    @Column('text', { default: 'pending' })
    status!: string;

    @Column('text', { nullable: true })
    lastError!: string;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastCheckTime!: Date;

    @Column('datetime', { nullable: true})
    lastFileUpdateTime!: Date;

    @Column('text', { nullable: true })
    resourceName!: string;

    @Column('integer', { default: 0 })
    totalEpisodes!: number;

    @Column('integer', { default: 0 })
    currentEpisodes!: number;

    @Column('text', { nullable: true })
    realFolderId!: string;

    @Column('text', { nullable: true })
    realFolderName!: string;

    @Column('text', { nullable: true })
    shareFileId!: string;

    @Column('text', { nullable: true })
    shareFolderId!: string;

    @Column('text', { nullable: true })
    shareFolderName!: string;

    @Column('text', { nullable: true })
    shareId!: string;
    
    @Column('text', { nullable: true })
    shareMode!: string;

    @Column('text', { nullable: true })
    pathType!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;

    @Column('text', { nullable: true })
    accessCode!: string;

    @Column('text', { nullable: true })
    sourceRegex!: string;
    
    @Column('text', { nullable: true })
    targetRegex!: string;

    @Column('text', { nullable: true, default: '' })
    movieRenameFormat!: string;

    @Column('text', { nullable: true, default: '' })
    tvRenameFormat!: string;

    @Column('text', { nullable: true })
    matchPattern!: string;
    @Column('text', { nullable: true })
    matchOperator!: string;
    @Column('text', { nullable: true })
    matchValue!: string;

    @Column('integer', { nullable: true })
    retryCount!: number;
    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    nextRetryTime!: Date;

    @Column('text', { nullable: true })
    remark!: string;

    @Column({ nullable: true })
    cronExpression!: string;

    @Column({ default: false })
    enableCron!: boolean;

    @Column({ nullable: true })
    realRootFolderId!: string;

    @Column({ nullable: true })
    embyId!: string;

    @Column({ nullable: true })
    tmdbId!: string; // tmdbId, 用于匹配tmdb和emby的电影
    
    @Column({ nullable: true })
    enableTaskScraper!: boolean; // 是否启用刮削

    @Column({ nullable: true })
    enableSystemProxy!: boolean; // 是否启用系统代理
    // tmdb内容 json格式
    @Column('text', { nullable: true })
    tmdbContent!: string;

    // 是否是文件夹
    @Column('boolean', { nullable: true, default: true })
    isFolder!: boolean;

    // P1-01: 断点恢复字段
    /** 检查点数据（JSON格式，存储恢复所需的上下文） */
    @Column('text', { nullable: true })
    checkpointData!: string;

    /** 已处理批次数 */
    @Column('integer', { nullable: true, default: 0 })
    processedBatches!: number;

    /** 总批次数 */
    @Column('integer', { nullable: true, default: 0 })
    totalBatches!: number;

    /** 最后检查点时间 */
    @Column('datetime', { nullable: true })
    lastCheckpointTime!: Date;
}

// 常用目录表
@Entity()
export class CommonFolder {
    @Column('text', { primary: true })
    id!: string;
    @Column('integer')
    accountId!: number;
    @Column('text')
    path!: string;
    @Column('text')
    name!: string;
}

// 已转存文件记录（统一漏斗防重表）
@Entity()
@Index(['taskId', 'fileId'], { unique: true })
export class TransferredFile {
    @PrimaryGeneratedColumn()
    id!: number;

    /** 所属任务 ID */
    @Column('integer')
    taskId!: number;

    /** 源文件 ID（cloud189: fileId, cloud139: contentID） */
    @Column('text')
    fileId!: string;

    @Column('text', { nullable: true })
    fileName!: string;

    @Column('text', { nullable: true })
    md5!: string;

    @CreateDateColumn()
    createdAt!: Date;
}

// P1-02: 任务错误记录表
@Entity()
@Index(['taskId'])
@Index(['errorType'])
@Index(['createdAt'])
export class TaskError {
    @PrimaryGeneratedColumn()
    id!: number;

    /** 所属任务 ID */
    @Column('integer')
    taskId!: number;

    /** 错误类型（LINK_INVALID, QUOTA_EXCEEDED, RATE_LIMITED, etc.） */
    @Column('text')
    errorType!: string;

    /** 错误代码（API返回的错误码） */
    @Column('text', { nullable: true })
    errorCode!: string;

    /** 错误消息 */
    @Column('text')
    errorMessage!: string;

    /** 堆栈跟踪 */
    @Column('text', { nullable: true })
    stackTrace!: string;

    /** 是否可重试 */
    @Column('boolean', { default: true })
    retryable!: boolean;

    /** 是否致命错误（不可恢复） */
    @Column('boolean', { default: false })
    fatal!: boolean;

    /** HTTP 状态码 */
    @Column('integer', { nullable: true })
    httpStatus!: number;

    /** API 错误码 */
    @Column('text', { nullable: true })
    apiCode!: string;

    /** 上下文信息（JSON格式） */
    @Column('text', { nullable: true })
    context!: string;

    @CreateDateColumn()
    createdAt!: Date;
}

export default { Account, Task, CommonFolder, TransferredFile, TaskError };

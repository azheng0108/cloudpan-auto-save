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
    /** OpenList STRM 刷新根路径（与 cloudStrmPrefix 解耦，仅用于追更后触发 OpenList 缓存刷新）
     *  填写 OpenList 中该账号 STRM 文件所在的根路径，不含主机地址
     *  例：/strm/移动云盘/159  或  /strm_139
     */
    @Column('text', { nullable: true, default: '' })
    alistStrmPath!: string;
    /** OpenList 原生网盘挂载路径（仅用于刷新云盘目录缓存，不触发 STRM 驱动）
     *  例：/CloudDrive139
     */
    @Column('text', { nullable: true, default: '' })
    alistNativePath!: string;
    /** OpenList 实际挂载根目录 ID（用于路径偏移裁剪） */
    @Column('text', { nullable: true, default: '' })
    rootFolderId!: string;
    @Column('text', { nullable: true, default: '' })
    embyPathReplace!:string;

    @Column('text', { nullable: true, default: '' })
    embyLibraryPath!: string;

    @Column('boolean', { nullable: true, default: false })
    tgBotActive!: boolean;

    @Column('text', { nullable: true, default: '' })
    alias!: string;

    // 账号类型: cloud139
    @Column('text', { nullable: true, default: 'cloud139' })
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

    /** 任务物理目录的参考父目录 ID（用于 OpenList 挂载偏移判断） */
    @Column('text', { nullable: true })
    parentFileId!: string;

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

    /** 是否禁用自动命名（true = 彻底跳过，null/false = 沿用全局模板） */
    @Column('boolean', { nullable: true })
    disableRename!: boolean;

    /** 链接失效自动搜盘自愈累计次数 */
    @Column('integer', { nullable: true, default: 0 })
    healCount!: number;

    /** 任务数据来源模式：'channel'（频道监控首选） | 'manual'（手动备选） */
    @Column('text', { nullable: true, default: 'manual' })
    sourceMode!: string;
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

// 影视刮削：批次（撤回的最大单位）
@Entity()
@Index(['driveType', 'accountId'])
export class ScrapeBatch {
    @PrimaryGeneratedColumn()
    id!: number;

    /** 驱动类型：cloud139 | openlist */
    @Column('text')
    driveType!: string;

    /** 账号 ID（OpenList 等无账号概念的驱动固定为 0） */
    @Column('integer', { default: 0 })
    accountId!: number;

    @Column('text')
    rootRef!: string;

    @Column('text', { nullable: true })
    rootPath!: string;

    /** 触发方式：manual | schedule | task */
    @Column('text', { default: 'manual' })
    trigger!: string;

    /** 是否整理到独立目录（false=仅原目录内改名） */
    @Column('boolean', { default: false })
    organize!: boolean;

    @Column('text', { nullable: true })
    targetRootRef!: string;

    @Column('text', { nullable: true })
    targetRootPath!: string;

    /** planned | running | done | partial | reverted */
    @Column('text', { default: 'planned' })
    status!: string;

    @Column('text', { nullable: true })
    error!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

// 影视刮削：操作日志（每个文件一行，撤回依据）
@Entity()
@Index(['batchId'])
@Index(['driveType', 'accountId', 'fileRef'])
@Index(['status'])
export class ScrapeRecord {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    batchId!: number;

    @Column('text')
    driveType!: string;

    @Column('integer', { default: 0 })
    accountId!: number;

    /** video | sidecar（字幕等随视频同步改名的旁挂文件） */
    @Column('text', { default: 'video' })
    kind!: string;

    @Column('integer', { nullable: true })
    mainRecordId!: number;

    @Column('text', { nullable: true })
    groupKey!: string;

    /** 整理前的条目引用（139 为 fileId，OpenList 为完整路径） */
    @Column('text')
    fileRef!: string;

    /** 整理后的条目引用 */
    @Column('text', { nullable: true })
    newRef!: string;

    @Column('text')
    oldParentRef!: string;

    @Column('text', { nullable: true })
    oldParentPath!: string;

    @Column('text')
    oldName!: string;

    @Column('integer', { nullable: true })
    size!: number;

    @Column('text', { nullable: true })
    newParentRef!: string;

    @Column('text', { nullable: true })
    newParentPath!: string;

    @Column('text', { nullable: true })
    newName!: string;

    @Column('text', { nullable: true })
    mediaType!: string;

    @Column('text', { nullable: true })
    tmdbId!: string;

    @Column('integer', { nullable: true })
    season!: number;

    @Column('integer', { nullable: true })
    episode!: number;

    @Column('text', { nullable: true })
    title!: string;

    @Column('text', { nullable: true })
    year!: string;

    @Column('integer', { nullable: true })
    confidence!: number;

    /** 证据 JSON：命中规则、候选 Top3、解析结果、目标目录分段等 */
    @Column('text', { nullable: true })
    evidence!: string;

    /** auto | tag | binding | manual */
    @Column('text', { default: 'auto' })
    source!: string;

    /**
     * planned | unrecognized | pending_review | ignored | applying | applied | failed
     * | reverting | reverted | revert_failed
     */
    @Column('text', { default: 'planned' })
    status!: string;

    @Column('text', { nullable: true })
    reason!: string;

    @Column('text', { nullable: true })
    error!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @Column('datetime', { nullable: true })
    appliedAt!: Date;

    @Column('datetime', { nullable: true })
    revertedAt!: Date;
}

// 影视刮削：手动绑定 / 忽略（记住用户的人工决定）
@Entity()
@Index(['driveType', 'accountId', 'folderKey'], { unique: true })
export class ScrapeBinding {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    driveType!: string;

    @Column('integer', { default: 0 })
    accountId!: number;

    /** 分组键（电视剧为剧集目录引用，电影为文件引用） */
    @Column('text')
    folderKey!: string;

    /** bind | ignore */
    @Column('text', { default: 'bind' })
    action!: string;

    @Column('text', { nullable: true })
    tmdbId!: string;

    @Column('text', { nullable: true })
    mediaType!: string;

    @Column('integer', { nullable: true })
    seasonOverride!: number;

    @Column('integer', { default: 0 })
    episodeOffset!: number;

    @CreateDateColumn()
    createdAt!: Date;
}

// Telegram 频道监控配置表
@Entity('channel_monitors')
export class ChannelMonitor {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    name!: string;

    @Column('text')
    channelUrl!: string;

    @Column('integer')
    accountId!: number;

    @Column('text', { default: '/' })
    targetFolderId!: string;

    @Column('text', { nullable: true })
    targetFolderName!: string;

    @Column('text', { nullable: true, default: '' })
    stagingFolderId!: string; // 频道独立暂存区目录ID，为空则继承全局默认暂存区

    @Column('text', { nullable: true, default: '' })
    stagingFolderName!: string; // 频道独立暂存区目录名称

    @Column('text', { nullable: true, default: '' })
    filterKeywords!: string;

    @Column('text', { nullable: true, default: '' })
    excludeKeywords!: string;

    @Column('boolean', { default: true })
    autoOrganize!: boolean;

    @Column('boolean', { default: true })
    autoWash!: boolean;

    @Column('text', { default: 'active' })
    status!: string; // 'active' | 'paused'

    @Column('text', { nullable: true, default: '' })
    cronExpression!: string; // 可选独立调度频率，为空则继承全局设置

    @Column('text', { nullable: true, default: '' })
    secondary_dispatch_rules!: string; // 二次分流规则组（JSON 字符串）

    @Column('integer', { nullable: true, default: 0 })
    lastMessageId!: number;

    @Column('datetime', { nullable: true })
    lastCheckedAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

// 频道监控推文抓取与防重历史表
@Entity('channel_monitor_history')
export class ChannelMonitorHistory {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    @Index()
    channelId!: number;

    @Column('text', { nullable: true })
    channelName!: string;

    @Column('integer')
    @Index()
    messageId!: number;

    @Column('text', { nullable: true })
    postUrl!: string;

    @Column('text', { nullable: true })
    postTitle!: string;

    @Column('text', { nullable: true })
    rawText!: string;

    @Column('text', { nullable: true })
    shareLink!: string;

    @Column('text', { nullable: true })
    accessCode!: string;

    @Column('text', { default: 'pending' })
    @Index()
    status!: string; // 'success' | 'skipped_filter' | 'skipped_duplicate' | 'failed'

    @Column('text', { nullable: true })
    reason!: string;

    @Column('integer', { default: 0 })
    transferredCount!: number;

    @Column('text', { nullable: true })
    transferredDetails!: string; // JSON

    @CreateDateColumn()
    createdAt!: Date;
}

// 云盘维护与巡检作业流水表 (Banned inspection, empty prune, cleanup)
@Entity('maintenance_jobs')
export class MaintenanceJob {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    type!: string; // 'banned_scan' | 'banned_clean' | 'empty_prune' | 'missing_scan'

    @Column('text', { default: 'manual' })
    triggerType!: string; // 'manual' | 'cron'

    @Column('text')
    title!: string; // "手动违规死链巡检" | "定时自动巡检" | "违规死链安全处置" | "安全空目录修剪"

    @Column('text', { default: 'running' })
    @Index()
    status!: string; // 'running' | 'completed' | 'cleaned' | 'failed'

    @Column('text', { default: '' })
    summary!: string;

    @Column('integer', { default: 0 })
    durationMs!: number;

    @Column('text', { nullable: true, default: '' })
    folderPath!: string;

    @Column('integer', { default: 0 })
    scannedFolders!: number;

    @Column('integer', { default: 0 })
    totalFiles!: number;

    @Column('integer', { default: 0 })
    bannedCount!: number;

    @Column('integer', { default: 0 })
    cleanedCount!: number;

    @Column('text', { nullable: true, default: '0 B' })
    freedFormatted!: string;

    @Column('text', { nullable: true })
    findingsJson!: string; // JSON: 违规文件清单快照

    @Column('text', { nullable: true })
    cleanedDetailsJson!: string; // JSON: 处置明细清单

    @Column('text', { nullable: true })
    error!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    @Index()
    createdAt!: Date;
}

export default {
    Account,
    Task,
    CommonFolder,
    TransferredFile,
    TaskError,
    ScrapeBatch,
    ScrapeRecord,
    ScrapeBinding,
    ChannelMonitor,
    ChannelMonitorHistory,
    MaintenanceJob
};

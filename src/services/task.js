const { LessThan, In, IsNull } = require('typeorm');
const { Cloud189Service } = require('./cloud189');
const { Cloud139Service } = require('./cloud139');
const { MessageUtil } = require('./message');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { CreateTaskDto } = require('../dto/TaskDto');
const { BatchTaskDto } = require('../dto/BatchTaskDto');
const { TaskCompleteEventDto } = require('../dto/TaskCompleteEventDto');
const { SchedulerService } = require('./scheduler');

const path = require('path');
const { EventService } = require('./eventService');
const { TaskEventHandler } = require('./taskEventHandler');
const harmonizedFilter = require('../utils/BloomFilter');
const { processCloud139Task } = require('./cloud139TaskProcessor');
const { TaskNamingService } = require('./taskNamingService');
const { TaskParserService } = require('./taskParserService');

class TaskService {
    constructor(taskRepo, accountRepo, transferredFileRepo) {
        this.taskRepo = taskRepo;
        this.accountRepo = accountRepo;
        this.transferredFileRepo = transferredFileRepo || null;
        this.messageUtil = new MessageUtil();
        this.eventService = EventService.getInstance();
        this.taskNamingService = new TaskNamingService();
        this.taskParserService = new TaskParserService();
        // 如果还没有taskComplete事件的监听器，则添加
        if (!this.eventService.hasListeners('taskComplete')) {
            const taskEventHandler = new TaskEventHandler(this.messageUtil);
            this.eventService.on('taskComplete', async (eventDto) => {
                eventDto.taskService = this;
                eventDto.taskRepo = this.taskRepo;
                taskEventHandler.handle(eventDto);
            });
        }
    }

    // 解析分享链接
    async getShareInfo(cloud189, shareCode) {
         const shareInfo = await cloud189.getShareInfo(shareCode);
         if (!shareInfo) throw new Error('获取分享信息失败');
         if(shareInfo.res_code == "ShareAuditWaiting") {
            throw new Error('分享链接审核中, 请稍后再试');
         }
         return shareInfo;
    }

    // 创建任务的基础配置
    _createTaskConfig(taskDto, shareInfo, realFolder, resourceName, currentEpisodes = 0, shareFolderId = null, shareFolderName = "") {
        return {
            accountId: taskDto.accountId,
            shareLink: taskDto.shareLink,
            targetFolderId: taskDto.targetFolderId,
            realFolderId:realFolder.id,
            realFolderName:realFolder.name,
            status: 'pending',
            totalEpisodes: taskDto.totalEpisodes,
            resourceName,
            currentEpisodes,
            shareFileId: shareInfo.fileId,
            shareFolderId: shareFolderId || shareInfo.fileId,
            shareFolderName,
            shareId: shareInfo.shareId,
            shareMode: shareInfo.shareMode,
            accessCode: taskDto.accessCode,
            matchPattern: taskDto.matchPattern,
            matchOperator: taskDto.matchOperator,
            matchValue: taskDto.matchValue,
            remark: taskDto.remark,
            realRootFolderId: taskDto.realRootFolderId,
            enableCron: taskDto.enableCron,
            cronExpression: taskDto.cronExpression,
            sourceRegex: taskDto.sourceRegex,
            targetRegex: taskDto.targetRegex,
            movieRenameFormat: taskDto.movieRenameFormat || '',
            tvRenameFormat: taskDto.tvRenameFormat || '',
            isFolder: taskDto.isFolder
        };
    }

     // 验证并创建目标目录
     async _validateAndCreateTargetFolder(cloud189, taskDto, shareInfo) {
        if (!this.checkFolderInList(taskDto, '-1')) {
            return {id: taskDto.targetFolderId, name: '', oldFolder: true}
        }
        // 检查目标文件夹是否存在
        await this.checkFolderExists(cloud189, taskDto.targetFolderId, shareInfo.fileName, taskDto.overwriteFolder);
        const targetFolder = await cloud189.createFolder(shareInfo.fileName, taskDto.targetFolderId);
        if (!targetFolder || !targetFolder.id) throw new Error('创建目录失败');
        return targetFolder;
    }

    // 处理文件夹分享
    async _handleFolderShare(cloud189, shareInfo, taskDto, rootFolder, tasks) {
        const result = await cloud189.listShareDir(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, taskDto.accessCode);
        if (!result?.fileListAO) return;
        const { fileList: rootFiles = [], folderList: subFolders = [] } = result.fileListAO;
        // 处理根目录文件 如果用户选择了根目录, 则生成根目录任务
        if (rootFiles.length > 0 && !rootFolder?.oldFolder) {
            const enableOnlySaveMedia = ConfigService.getConfigValue('task.enableOnlySaveMedia');
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            // 校验文件是否一个满足条件的都没有, 如果都没有 直接跳过
            let shouldContinue = false;
            if (enableOnlySaveMedia && !rootFiles.some(file => this._checkFileSuffix(file, true, mediaSuffixs))) {
                shouldContinue = true
            }
            if (!shouldContinue) {
                taskDto.realRootFolderId = rootFolder.id;
                const rootTask = this.taskRepo.create(
                    this._createTaskConfig(
                        taskDto,
                        shareInfo, rootFolder, `${shareInfo.fileName}(根)`, 0
                    )
                );
                tasks.push(await this.taskRepo.save(rootTask));
            }
        }
        if (subFolders.length > 0) {
            taskDto.realRootFolderId = rootFolder.id;
             // 处理子文件夹
            for (const folder of subFolders) {
                // 检查用户是否选择了该文件夹
                if (!this.checkFolderInList(taskDto, folder.id)) {
                    continue;
                }
                const subFolderContent = await cloud189.listShareDir(shareInfo.shareId, folder.id, shareInfo.shareMode, taskDto.accessCode);
                const hasFiles = subFolderContent?.fileListAO?.fileList?.length > 0;
                if (!hasFiles) {
                    logTaskEvent(`子文件夹 "${folder.name}" (ID: ${folder.id}) 为空，跳过目录。`);
                    continue; // 跳到下一个子文件夹
                }
                let realFolder;
                // 检查目标文件夹是否存在
                await this.checkFolderExists(cloud189, rootFolder.id, folder.fileName, taskDto.overwriteFolder);
                realFolder = await cloud189.createFolder(folder.name, rootFolder.id);
                if (!realFolder?.id) throw new Error('创建目录失败');
                rootFolder?.oldFolder && (taskDto.realRootFolderId = realFolder.id);
                realFolder.name = path.join(rootFolder.name, realFolder.name);
                const subTask = this.taskRepo.create(
                    this._createTaskConfig(
                        taskDto,
                        shareInfo, realFolder, shareInfo.fileName, 0, folder.id, folder.name
                    )
                );
                tasks.push(await this.taskRepo.save(subTask));
            }
        }
    }

    // 处理单文件分享
    async _handleSingleShare(cloud189, shareInfo, taskDto, rootFolder, tasks) {
        const shareFiles = await cloud189.getShareFiles(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, taskDto.accessCode, false);
        if (!shareFiles?.length) throw new Error('获取文件列表失败');
        taskDto.realRootFolderId = rootFolder.id;
        const task = this.taskRepo.create(
            this._createTaskConfig(
                taskDto,
                shareInfo, rootFolder, shareInfo.fileName, 0
            )
        );
        tasks.push(await this.taskRepo.save(task));
    }

    // 创建新任务
    async createTask(params) {
        const taskDto = new CreateTaskDto(params);
        taskDto.validate();
        // 获取分享信息
        const account = await this.accountRepo.findOneBy({ id: taskDto.accountId });
        if (!account) throw new Error('账号不存在');

        // Cloud139 分支 — 先从分享文本中提取纯 URL 和访问码
        if (account.accountType === 'cloud139') {
            const parsed = this.taskParserService.extractCloud139ShareText(taskDto.shareLink);
            if (parsed) {
                taskDto.shareLink = parsed.url;
                if (parsed.passwd && !taskDto.accessCode) taskDto.accessCode = parsed.passwd;
            }
            return await this._createCloud139Tasks(params, account, taskDto);
        }

        const cloud189Parsed = this.taskParserService.parseCloud189ShareInput(taskDto.shareLink);
        if (cloud189Parsed.parsedAccessCode) {
            taskDto.accessCode = cloud189Parsed.parsedAccessCode;
        }
        taskDto.shareLink = cloud189Parsed.normalizedUrl;
        const cloud189 = Cloud189Service.getInstance(account);
        const { shareCode } = cloud189Parsed;
        const shareInfo = await this.getShareInfo(cloud189, shareCode);
        // 如果分享链接是加密链接, 且没有提供访问码, 则抛出错误
        if (shareInfo.shareMode == 1 ) {
            if (!taskDto.accessCode) {
                throw new Error('分享链接为加密链接, 请提供访问码');
            }
            // 校验访问码是否有效
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, taskDto.accessCode);
            if (!accessCodeResponse) {
                throw new Error('校验访问码失败');
            }
            if (!accessCodeResponse.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        if (!shareInfo.shareId) {
            throw new Error('获取分享信息失败');
        }
        // 如果任务名称存在 且和shareInfo的name不一致
        if (taskDto.taskName && taskDto.taskName != shareInfo.fileName) {
            shareInfo.fileName = taskDto.taskName;
        }
        taskDto.isFolder = true
        await this.increaseShareFileAccessCount(cloud189, shareInfo.shareId)
        // 检查并创建目标目录
        const rootFolder = await this._validateAndCreateTargetFolder(cloud189, taskDto, shareInfo);
        const tasks = [];
        rootFolder.name = path.join(taskDto.targetFolder, rootFolder.name)
        if (shareInfo.isFolder) {
            await this._handleFolderShare(cloud189, shareInfo, taskDto, rootFolder, tasks);
        }

         // 处理单文件
         if (!shareInfo.isFolder) {
            taskDto.isFolder = false
            await this._handleSingleShare(cloud189, shareInfo, taskDto, rootFolder, tasks);
        }
        if (taskDto.enableCron) {
            for(const task of tasks) {
                SchedulerService.saveTaskJob(task, this)   
            }
        }
        return tasks;
    }
    async increaseShareFileAccessCount(cloud189, shareId ) {
        await cloud189.increaseShareFileAccessCount(shareId)
    }
    // 删除任务
    async deleteTask(taskId, deleteCloud) {
        const task = await this.getTaskById(taskId);
        if (!task) throw new Error('任务不存在');
        const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        if (!task.enableSystemProxy && deleteCloud) {
            const account = await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) throw new Error('账号不存在');
            if (account.accountType === 'cloud139') {
                const cloud139 = Cloud139Service.getInstance(account);
                await this.deleteCloudFile139(cloud139, await this.getRootFolder(task), 1);
            } else {
                const cloud189 = Cloud189Service.getInstance(account);
                await this.deleteCloudFile(cloud189, await this.getRootFolder(task), 1);
            }
        }
        if (task.enableSystemProxy) {
            // enableSystemProxy已移除
        }
        // 删除定时任务
        if (task.enableCron) {
            SchedulerService.removeTaskJob(task.id)
        }
        // 删除已转存文件记录（统一漏斗）
        if (this.transferredFileRepo) {
            await this.transferredFileRepo.delete({ taskId: task.id });
        }
        await this.taskRepo.remove(task);
    }

    // 批量删除
    async deleteTasks(taskIds, deleteCloud) {
        for(const taskId of taskIds) {
            try{
                await this.deleteTask(taskId, deleteCloud)
            }catch (error){

            }
        }
    }

    // 获取文件夹下的所有文件
    async getAllFolderFiles(cloud189, task) {
        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        }
        const folderId = task.realFolderId
        const folderInfo = await cloud189.listFiles(folderId);
        // 如果folderInfo.res_code == FileNotFound 需要重新创建目录
        if (folderInfo.res_code == "FileNotFound") {
            logTaskEvent('文件夹不存在!')
            if (!task) {
                throw new Error('文件夹不存在!');
            }
            logTaskEvent('正在重新创建目录');
            const enableAutoCreateFolder = ConfigService.getConfigValue('task.enableAutoCreateFolder');
            if (enableAutoCreateFolder) {
                await this._autoCreateFolder(cloud189, task);
                return await this.getAllFolderFiles(cloud189, task);
            }
        }
        if (!folderInfo || !folderInfo.fileListAO) {
            return [];
        }

        let allFiles = [...(folderInfo.fileListAO.fileList || [])];
        return allFiles;
    }

    // cloud139 自动重建目标目录
    async _autoCreateFolder139(cloud139, task) {
        // 检查 targetFolderId 是否存在
        const targetCheck = await cloud139.listDiskDir(task.targetFolderId).catch(() => null);
        if (!targetCheck) {
            throw new Error('保存目录不存在，无法自动创建目录');
        }

        // 重建 realRootFolderId（如果不存在）
        const rootCheck = await cloud139.listDiskDir(task.realRootFolderId).catch(() => null);
        if (!rootCheck) {
            const rootFolderName = task.resourceName;
            logTaskEvent(`[139] 正在创建根目录: ${rootFolderName}`);
            const created = await cloud139.createFolderHcy(task.targetFolderId, rootFolderName);
            if (!created?.fileId) throw new Error('创建根目录失败');
            task.realRootFolderId = created.fileId;
            logTaskEvent(`[139] 根目录创建成功: ${rootFolderName} (${task.realRootFolderId})`);
        }

        // 重建 realFolderId（子目录任务）
        // root-files 任务的 realFolderId 应始终等于 realRootFolderId（不需要子目录）。
        // 旧版任务可能将 realFolderId 错误地指向 'root-files' 子目录，此处统一修正。
        if (task.shareFolderId === 'root-files') {
            task.realFolderId = task.realRootFolderId;
        } else if (task.realFolderId !== task.realRootFolderId) {
            logTaskEvent(`[139] 正在创建子目录: ${task.shareFolderName}`);
            const created = await cloud139.createFolderHcy(task.realRootFolderId, task.shareFolderName);
            if (!created?.fileId) throw new Error('创建子目录失败');
            task.realFolderId = created.fileId;
            logTaskEvent(`[139] 子目录创建成功: ${task.shareFolderName} (${task.realFolderId})`);
        } else {
            task.realFolderId = task.realRootFolderId;
        }

        await this.taskRepo.save(task);
        logTaskEvent('[139] 目录重建完成');
    }

    // 自动创建目录
    async _autoCreateFolder(cloud189, task) {
         // 检查 targetFolderId 是否存在
         const targetFolderInfo = await cloud189.listFiles(task.targetFolderId);
         if (targetFolderInfo.res_code === "FileNotFound") {
             throw new Error('保存目录不存在，无法自动创建目录');
         }

        // 如果 realRootFolderId 存在，先检查是否可用
        if (task.realRootFolderId) {
            const rootFolderInfo = await cloud189.listFiles(task.realRootFolderId);
            if (rootFolderInfo.res_code === "FileNotFound") {
                // realRootFolderId 不存在或不可用，需要创建
                const rootFolderName = task.resourceName.replace('(根)', '').trim();
                logTaskEvent(`正在创建根目录: ${rootFolderName}`);
                const rootFolder = await cloud189.createFolder(rootFolderName, task.targetFolderId);
                if (!rootFolder?.id) throw new Error('创建根目录失败');
                task.realRootFolderId = rootFolder.id;
                logTaskEvent(`根目录创建成功: ${rootFolderName}`);
            }
        }

        // 如果是子文件夹任务，在 realRootFolderId 下创建子文件夹
        if (task.realRootFolderId !== task.realFolderId) {
            logTaskEvent(`正在创建子目录: ${task.shareFolderName}`);
            const subFolder = await cloud189.createFolder(task.shareFolderName, task.realRootFolderId);
            if (!subFolder?.id) throw new Error('创建子目录失败');
            task.realFolderId = subFolder.id;
            logTaskEvent(`子目录创建成功: ${task.shareFolderName}`);
        } else {
            // 如果是根目录任务，则 realFolderId 等于 realRootFolderId
            task.realFolderId = task.realRootFolderId;
        }

        await this.taskRepo.save(task);
        logTaskEvent('目录创建完成');
    }

    // 处理新文件
    async _handleNewFiles(task, newFiles, cloud189, mediaSuffixs) {
        const taskInfoList = [];
        const fileNameList = [];
        let fileCount = 0;

        for (const file of newFiles) {
            if (task.enableSystemProxy) {
                throw new Error('系统代理模式已移除');
            } else {
                // 普通模式：添加到转存任务
                taskInfoList.push({
                    fileId: file.id,
                    fileName: file.name,
                    isFolder: 0,
                    md5: file.md5,
                });
            }
            fileNameList.push(`├─ ${file.name}`);
            if (this._checkFileSuffix(file, true, mediaSuffixs)) fileCount++;
        }
        // 如果有多个文件，最后一个文件使用└─
        if (fileNameList.length > 0) {
            const lastItem = fileNameList.pop();
            fileNameList.push(lastItem.replace('├─', '└─'));
        }
        if (taskInfoList.length > 0) {
            if (!task.enableSystemProxy) {
                const batchTaskDto = new BatchTaskDto({
                    taskInfos: JSON.stringify(taskInfoList),
                    type: 'SHARE_SAVE',
                    targetFolderId: task.realFolderId,
                    shareId: task.shareId
                });
                await this.createBatchTask(cloud189, batchTaskDto);
                // 转存成功后将源文件 ID 写入统一漏斗表
                await this._recordTransferredFiles(task.id, taskInfoList);
            }else{
                throw new Error('系统代理模式已移除');
            }
        }
        // 修改省略号的显示格式
        if (fileNameList.length > 20) {
            fileNameList.splice(5, fileNameList.length - 10, '├─ ...');
        }

        return { fileNameList, fileCount };
    }

    /**
     * 将成功转存的文件 ID 写入统一漏斗表，防止重复转存。
     * 使用 INSERT OR IGNORE ，唯一约束冲突时静默跳过。
     */
    async _recordTransferredFiles(taskId, taskInfoList) {
        if (!this.transferredFileRepo || !taskInfoList.length) return;
        try {
            const records = taskInfoList.map(info => this.transferredFileRepo.create({
                taskId,
                fileId: String(info.fileId),
                fileName: info.fileName || null,
                md5: info.md5 || null,
            }));
            await this.transferredFileRepo.manager
                .createQueryBuilder()
                .insert()
                .into(this.transferredFileRepo.target)
                .values(records)
                .orIgnore()
                .execute();
        } catch (e) {
            logTaskEvent(`记录已转存文件时出错（可忽略）: ${e.message}`);
        }
    }

    // 执行任务
    async processTask(task) {
        let saveResults = [];
        try {
            const account = await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) {
                logTaskEvent(`账号不存在，accountId: ${task.accountId}`);
                throw new Error('账号不存在');
            }
            task.account = account;
            // Cloud139 分支
            if (account.accountType === 'cloud139') {
                const result = await this._processCloud139Task(task, account);
                saveResults.push(result);
                return saveResults.filter(Boolean).join('\n');
            }
            const cloud189 = Cloud189Service.getInstance(account);
             // 获取分享文件列表并进行增量转存
             const shareDir = await cloud189.listShareDir(task.shareId, task.shareFolderId, task.shareMode,task.accessCode, task.isFolder);
             if(shareDir.res_code == "ShareAuditWaiting") {
                logTaskEvent("分享链接审核中, 等待下次执行")
                return ''
             }
             if (!shareDir?.fileListAO?.fileList) {
                logTaskEvent("获取文件列表失败: " + JSON.stringify(shareDir));
                throw new Error('获取文件列表失败');
            }
            let shareFiles = [...shareDir.fileListAO.fileList];            
            const folderFiles = await this.getAllFolderFiles(cloud189, task);
            const enableOnlySaveMedia = ConfigService.getConfigValue('task.enableOnlySaveMedia');
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            const { existingFiles, existingFileNames, existingMediaCount } = folderFiles.reduce((acc, file) => {
                if (!file.isFolder) {
                    acc.existingFiles.add(file.md5);
                    acc.existingFileNames.add(file.name);
                    if ((task.totalEpisodes == null || task.totalEpisodes <= 0) || this._checkFileSuffix(file, true, mediaSuffixs)) {
                        acc.existingMediaCount++;
                    }
                }
                return acc;
            }, { 
                existingFiles: new Set(), 
                existingFileNames: new Set(), 
                existingMediaCount: 0 
            });
            // 统一漏斗：从数据库加载该任务已成功转存的文件 ID 集合，杜绝重复转存
            const transferredIds = this.transferredFileRepo
                ? new Set((await this.transferredFileRepo.find({ where: { taskId: task.id } })).map(r => r.fileId))
                : new Set();
            
            const newFiles = shareFiles
                .filter(file => 
                    !file.isFolder && !existingFiles.has(file.md5) 
                   && !existingFileNames.has(file.name)
                   && !transferredIds.has(String(file.id))
                   && this._checkFileSuffix(file, enableOnlySaveMedia, mediaSuffixs)
                   && this._handleMatchMode(task, file)
                   && !this.isHarmonized(file)
                );

            // 处理新文件并保存到数据库和云盘
            if (newFiles.length > 0) {
                const { fileNameList, fileCount } = await this._handleNewFiles(task, newFiles, cloud189, mediaSuffixs);
                const resourceName = task.shareFolderName? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;
                saveResults.push(`${resourceName}追更${fileCount}集: \n${fileNameList.join('\n')}`);
                const firstExecution = !task.lastFileUpdateTime;
                task.status = 'processing';
                task.lastFileUpdateTime = new Date();
                task.currentEpisodes = existingMediaCount + fileCount;
                task.retryCount = 0;
                process.nextTick(() => {
                    this.eventService.emit('taskComplete', new TaskCompleteEventDto({
                        task,
                        cloud189,
                        fileList: newFiles,
                        overwriteStrm: false,
                        firstExecution: firstExecution
                    }));
                })
            } else if (task.lastFileUpdateTime) {
                // 检查是否超过3天没有新文件
                const now = new Date();
                const lastUpdate = new Date(task.lastFileUpdateTime);
                const daysDiff = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
                if (daysDiff >= ConfigService.getConfigValue('task.taskExpireDays')) {
                    task.status = 'completed';
                }
                task.currentEpisodes = existingMediaCount;
                logTaskEvent(`${task.resourceName} 没有增量剧集`)
            }
            // 检查是否达到总数
            if (task.totalEpisodes && task.currentEpisodes >= task.totalEpisodes) {
                task.status = 'completed';
                logTaskEvent(`${task.resourceName} 已完结`)
            }

            task.lastCheckTime = new Date();
            await this.taskRepo.save(task);
            return saveResults.join('\n');
        } catch (error) {
            return await this._handleTaskFailure(task, error);
        }
    }

    // 获取所有任务
    async getTasks() {
        return await this.taskRepo.find({
            order: {
                id: 'DESC'
            }
        });
    }

    // 获取待处理任务
    async getPendingTasks(ignore = false, taskIds = []) {
        const conditions = [
            {
                status: 'pending',
                nextRetryTime: null,
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            },
            {
                status: 'processing',
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            }
        ];
        return await this.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
            where: [
                ...(taskIds.length > 0 
                    ? [{ id: In(taskIds) }] 
                    : conditions)
            ]
        });
    }

    // 更新任务
    async updateTask(taskId, updates) {
        const task = await this.taskRepo.findOne({
            where: { id: taskId },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            }
        });
        if (!task) throw new Error('任务不存在');

        // 只允许更新特定字段
        const allowedFields = ['resourceName', 'realFolderId', 'currentEpisodes', 'totalEpisodes', 'status','realFolderName', 'shareFolderName', 'shareFolderId', 'matchPattern','matchOperator','matchValue','remark', 'enableCron', 'cronExpression', 'sourceRegex', 'targetRegex', 'movieRenameFormat', 'tvRenameFormat'];
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                task[field] = updates[field];
            }
        }
        // 如果currentEpisodes和totalEpisodes为null 则设置为0
        if (task.currentEpisodes === null) {
            task.currentEpisodes = 0;
        }
        if (task.totalEpisodes === null) {
            task.totalEpisodes = 0;
        }
        
        // 验证状态值
        const validStatuses = ['pending', 'processing', 'completed', 'failed'];
        if (!validStatuses.includes(task.status)) {
            throw new Error('无效的状态值');
        }

        // 验证数值字段
        if (task.currentEpisodes !== null && task.currentEpisodes < 0) {
            throw new Error('更新数不能为负数');
        }
        if (task.totalEpisodes !== null && task.totalEpisodes < 0) {
            throw new Error('总数不能为负数');
        }
        if (task.matchPattern && !task.matchValue) {
            throw new Error('匹配模式需要提供匹配值');
        }
        const newTask = await this.taskRepo.save(task)
        SchedulerService.removeTaskJob(task.id)
        if (task.enableCron && task.cronExpression) {
            SchedulerService.saveTaskJob(newTask, this)
        }
        return newTask;
    }

    /**
     * 从文件名中自动解析影视元数据，用于 Jinja2 模板渲染
     * 支持变量: title, year, season, episode, season_episode, part,
     *           videoFormat, videoSource, videoCodec, audioCodec, fileExt
     */
    _parseMediaFileName(filename) {
        return this.taskNamingService.parseMediaFileName(filename);
    }

    /**
     * 使用 nunjucks 渲染 Jinja2 模板
     */
    _renderJinjaTemplate(template, vars) {
        return this.taskNamingService.renderJinjaTemplate(template, vars);
    }

    /**
     * Jinja2 模板重命名：自动解析文件名元数据，套模板后取最后一段作为新文件名
     */
    async _processJinjaRename(cloud189, task, files, message, newFiles, movieFmt, tvFmt) {
        for (const file of files) {
            try {
                const vars = this._parseMediaFileName(file.name);
                const isTV = !!vars.season_episode;
                const template = isTV ? tvFmt : movieFmt;
                if (!template) {
                    newFiles.push(file);
                    continue;
                }
                const rendered = this._renderJinjaTemplate(template, vars);
                if (!rendered) {
                    newFiles.push(file);
                    continue;
                }
                // 取路径最后一段作为文件名（去掉模板里的目录部分）
                const newName = rendered.split('/').pop().trim();
                if (!newName || newName === file.name) {
                    newFiles.push(file);
                    continue;
                }
                await this._renameFile(cloud189, task, file, newName, message, newFiles);
            } catch (error) {
                logTaskEvent(`${file.name} Jinja2 重命名失败: ${error.message}`);
                newFiles.push(file);
            }
        }
    }

    // 自动重命名（优先级：Jinja2 模板 > 正则）
    async autoRename(cloud189, task) {
        if (!cloud189 || typeof cloud189.listFiles !== 'function') return [];

        // 获取 Jinja2 格式（任务级优先，其次全局配置）
        const movieFmt = task.movieRenameFormat || ConfigService.getConfigValue('tmdb.movieRenameFormat') || '';
        const tvFmt = task.tvRenameFormat || ConfigService.getConfigValue('tmdb.tvRenameFormat') || '';
        const hasJinjaFormat = !!(movieFmt || tvFmt);

        if (!hasJinjaFormat && (!task.sourceRegex || !task.targetRegex)) return [];
        let message = [];
        let newFiles = [];
        let files = [];

        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        } else {
            const folderInfo = await cloud189.listFiles(task.realFolderId);
            if (!folderInfo || !folderInfo.fileListAO) return [];
            files = folderInfo.fileListAO.fileList;
        }
        if (!files || files.length === 0) return [];

        // 过滤掉文件夹
        files = files.filter(file => !file.isFolder);

        if (hasJinjaFormat) {
            // ① Jinja2 模板自动重命名
            logTaskEvent(`${task.resourceName} 开始使用 Jinja2 模板自动重命名`);
            await this._processJinjaRename(cloud189, task, files, message, newFiles, movieFmt, tvFmt);
        } else {
            // ② 正则重命名
            logTaskEvent(` ${task.resourceName} 开始使用正则表达式重命名`);
            await this._processRegexRename(cloud189, task, files, message, newFiles);
        }

        // 处理消息和保存结果
        await this._handleRenameResults(task, message, newFiles);
        return newFiles;
    }


    // 处理重命名结果
    async _handleRenameResults(task, message, newFiles) {
        if (message.length > 0) {
            const lastMessage = message[message.length - 1];
            message[message.length - 1] = lastMessage.replace('├─', '└─');
        }
        if (task.enableSystemProxy && newFiles.length > 0) {
            throw new Error('系统代理模式已移除');
        }
        // 修改省略号的显示格式
        if (message.length > 20) {
            message.splice(5, message.length - 10, '├─ ...');
        }
        message.length > 0 && logTaskEvent(`${task.resourceName}自动重命名完成: \n${message.join('\n')}`)
        message.length > 0 && this.messageUtil.sendMessage(`${task.resourceName}自动重命名: \n${message.join('\n')}`);
    }

    // 根据AI分析结果生成新文件名
    _generateFileName(file, aiFile, resourceInfo, template) {
        return this.taskNamingService.generateFileName(file, aiFile, resourceInfo, template);
    }
    // 处理重命名过程
    async _processRename(cloud189, task, files, resourceInfo, message, newFiles) {
        const newNames = resourceInfo.episode;
        // 处理aiFilename, 文件命名通过配置文件的占位符获取
        // 获取用户配置的文件名模板，如果没有配置则使用默认模板
        const template = resourceInfo.type === 'movie' 
        ? ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}'  // 电影模板
        : ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}';  // 剧集模板
        for (const file of files) {
            try {
                const aiFile = newNames.find(f => f.id === file.id);
                if (!aiFile) {
                    newFiles.push(file);
                    continue;
                }
                const newName = this._generateFileName(file, aiFile, resourceInfo, template);
                // 判断文件名是否已存在
                if (file.name === newName) {
                    newFiles.push(file);
                    continue;   
                }
                await this._renameFile(cloud189, task, file, newName, message, newFiles);
            } catch (error) {
                logTaskEvent(`${file.name}重命名失败: ${error.message}`);
                newFiles.push(file);
            }
        }
    }

    // 清理文件名中的非法字符
    _sanitizeFileName(fileName) {
        return this.taskNamingService.sanitizeFileName(fileName);
    }
    // 处理正则表达式重命名
    async _processRegexRename(cloud189, task, files, message, newFiles) {
        if (!task.sourceRegex || !task.targetRegex) return [];
        for (const file of files) {
            try {
                const destFileName = file.name.replace(new RegExp(task.sourceRegex), task.targetRegex);
                if (destFileName === file.name) {
                    newFiles.push(file);
                    continue;
                }
                await this._renameFile(cloud189, task, file, destFileName, message, newFiles);
            } catch (error) {
                logTaskEvent(`${file.name}重命名失败: ${error.message}`);
                newFiles.push(file);
            }
        }
    }

    // 执行单个文件重命名
    async _renameFile(cloud189, task, file, newName, message, newFiles) {
        let renameResult;
        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        } else {
            renameResult = await cloud189.renameFile(file.id, newName);
        }

        if (!task.enableSystemProxy && (!renameResult || renameResult.res_code != 0)) {
            // message.push(`├─ ${file.name} → ${newName}失败, 原因:${newName}${renameResult?.res_msg}`);
            newFiles.push(file);
        } else {
            message.push(`├─ ${file.name} → ${newName}`);
            newFiles.push({
                ...file,
                name: newName
            });
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 检查任务状态
    async checkTaskStatus(cloud189, taskId, count = 0, batchTaskDto) {
        if (count > 5) {
             return false;
        }
        let type = batchTaskDto.type || 'SHARE_SAVE';
        // 轮询任务状态
        const task = await cloud189.checkTaskStatus(taskId, batchTaskDto)
        if (!task) {
            return false;
        }
        logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}`)
        if (task.taskStatus == 3 || task.taskStatus == 1) {
            // 暂停200毫秒
            await new Promise(resolve => setTimeout(resolve, 200));
            return await this.checkTaskStatus(cloud189,taskId, count++, batchTaskDto)
        }
        if (task.taskStatus == 4) {
            // 如果failedCount > 0 说明有失败或者被和谐的文件, 需要查一次文件列表
            if (task.failedCount > 0 && type == 'SHARE_SAVE') {
                const targetFolderId = batchTaskDto.targetFolderId;
                const fileList = await this.getAllFolderFiles(cloud189, {
                    enableSystemProxy: false,
                    realFolderId: targetFolderId
                });
                //  当前转存的文件列表为taskInfos 需反序列化
                const taskInfos = JSON.parse(batchTaskDto.taskInfos);
                // fileList和taskInfos进行对比 拿到不在fileList中的文件
                const conflictFiles = taskInfos.filter(taskInfo => {
                    return !fileList.some(file => file.md5 === taskInfo.md5);
                });
                if (conflictFiles.length > 0) {
                    // 打印日志
                    logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}, 有${conflictFiles.length}个文件冲突, 已忽略: ${conflictFiles.map(file => file.fileName).join(',')}`);
                    // 加入和谐文件中
                    harmonizedFilter.addHarmonizedList(conflictFiles.map(file => file.md5))
                }
            }
            return true;
        }
        // 如果status == 2 说明有冲突
        if (task.taskStatus == 2) {
            const conflictTaskInfo = await cloud189.getConflictTaskInfo(taskId);
            if (!conflictTaskInfo) {
                return false
            }
            // 忽略冲突
            const taskInfos = conflictTaskInfo.taskInfos;
            for (const taskInfo of taskInfos) {
                taskInfo.dealWay = 1;
            }
            await cloud189.manageBatchTask(taskId, conflictTaskInfo.targetFolderId, taskInfos);
            await new Promise(resolve => setTimeout(resolve, 200));
            return await this.checkTaskStatus(cloud189, taskId, count++, batchTaskDto)
        }
        return false;
    }

    // 执行所有任务
    async processAllTasks(ignore = false, taskIds = []) {
        const tasks = await this.getPendingTasks(ignore, taskIds);
        if (tasks.length === 0) {
            logTaskEvent('没有待处理的任务');
            return;
        }
        let saveResults = []
        logTaskEvent(`================================`);
        for (const task of tasks) {
            // root-files 任务显示为 "[散文件]" 标签，避免拼出 "test/root-files" 误导日志
            const taskName = (task.shareFolderId === 'root-files')
                ? `${task.resourceName || '未知'} [散文件]`
                : task.shareFolderName
                    ? (task.resourceName + '/' + task.shareFolderName)
                    : task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始执行`);
            try {
                const result = await this.processTask(task);
            if (result) {
                saveResults.push(result)
            }
            } catch (error) {
                logTaskEvent(`任务${task.id}执行失败: ${error.message}`);
            }finally {
                logTaskEvent(`任务[${taskName}]执行完成`);
            }
            // 暂停500ms
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (saveResults.length > 0) {
            this.messageUtil.sendMessage(saveResults.join("\n\n"))
        }
        logTaskEvent(`================================`);
        return saveResults
    }
    // 处理匹配模式
    _handleMatchMode(task, file) {
        if (!task.matchPattern || !task.matchValue) {
            return true;
        } 
        const matchPattern = task.matchPattern;
        const matchOperator = task.matchOperator; // lt eq gt
        const matchValue = task.matchValue;
        const regex = new RegExp(matchPattern);
        // 根据正则表达式提取文件名中匹配上的值 然后根据matchOperator判断是否匹配
        const match = file.name.match(regex);
        if (match) {
            const matchResult = match[0];
            const values = this._handleMatchValue(matchOperator, matchResult, matchValue);
            if (matchOperator === 'lt' && values[0] < values[1]) {
                return true;
            }
            if (matchOperator === 'eq' && values[0] === values[1]) {
                return true;
            }
            if (matchOperator === 'gt' && values[0] > values[1]) {
                return true;
            }
            if (matchOperator === 'contains' && matchResult.includes(matchValue)) {
                return true;
            }
            if (matchOperator === 'notContains' && !matchResult.includes(matchValue)) {
                return true;
            }
        }
        return false;
    }

    // 根据matchOperator判断值是否要转换为数字
    _handleMatchValue(matchOperator, matchResult, matchValue) {    
        if (matchOperator === 'lt' || matchOperator === 'gt') {
            return [parseFloat(matchResult), parseFloat(matchValue)];
        }
        return [matchResult, matchValue];
    }

    // 任务失败处理逻辑
    async _handleTaskFailure(task, error) {
        logTaskEvent(error);
        const maxRetries = ConfigService.getConfigValue('task.maxRetries');
        const retryInterval = ConfigService.getConfigValue('task.retryInterval');
        // 初始化重试次数
        if (!task.retryCount) {
            task.retryCount = 0;
        }
        
        if (task.retryCount < maxRetries) {
            task.retryCount++;
            task.status = 'pending';
            task.lastError = `${error.message} (重试 ${task.retryCount}/${maxRetries})`;
            // 设置下次重试时间
            task.nextRetryTime = new Date(Date.now() + retryInterval * 1000);
            logTaskEvent(`任务将在 ${retryInterval} 秒后重试 (${task.retryCount}/${maxRetries})`);
        } else {
            task.status = 'failed';
            task.lastError = `${error.message} (已达到最大重试次数 ${maxRetries})`;
            logTaskEvent(`任务达到最大重试次数 ${maxRetries}，标记为失败`);
        }
        
        await this.taskRepo.save(task);
        return '';
    }

     // 获取需要重试的任务
     async getRetryTasks() {
        const now = new Date();
        return await this.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
            where: {
                status: 'pending',
                nextRetryTime: LessThan(now),
                retryCount: LessThan(ConfigService.getConfigValue('task.maxRetries')),
                enableSystemProxy: IsNull()
            }
        });
    }

    // 处理重试任务
    async processRetryTasks() {
        const retryTasks = await this.getRetryTasks();
        if (retryTasks.length === 0) {
            return [];
        }
        let saveResults = [];
        logTaskEvent(`================================`);
        for (const task of retryTasks) {
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始重试`);
            try {
                const result = await this.processTask(task);
                if (result) {
                    saveResults.push(result);
                }
            } catch (error) {
                console.error(`重试任务${task.name}执行失败:`, error);
            }finally {
                logTaskEvent(`任务[${taskName}]重试完成`);
            }
            // 任务间隔
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (saveResults.length > 0) {
            this.messageUtil.sendMessage(saveResults.join("\n\n"));
        }
        logTaskEvent(`================================`);
        return saveResults;
    }
    // 创建批量任务
    async createBatchTask(cloud189, batchTaskDto) {
        const resp = await cloud189.createBatchTask(batchTaskDto);
        if (!resp) {
            throw new Error('批量任务处理失败');
        }
        if (resp.res_code != 0) {
            throw new Error(resp.res_msg);
        }
        logTaskEvent(`批量任务处理中: ${JSON.stringify(resp)}`)
        if (!await this.checkTaskStatus(cloud189,resp.taskId, 0 , batchTaskDto)) {
            throw new Error('检查批量任务状态: 批量任务处理失败');
        }
        logTaskEvent(`批量任务处理完成`)
    }
    // 定时清空回收站
    async clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const accounts = await this.accountRepo.find()
        if (accounts) {
            for (const account of accounts) {
                // 移动云盘（cloud139）没有回收站功能，跳过
                if (account.accountType === 'cloud139') continue;
                let username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                try {
                    const cloud189 = Cloud189Service.getInstance(account); 
                    await this._clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle)
                } catch (error) {
                    logTaskEvent(`定时[${username}]清空回收站任务执行失败:${error.message}`);
                }
            }
        }
    }

    // 执行清空回收站
    async _clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const params = {
            taskInfos: '[]',
            type: 'EMPTY_RECYCLE',
        }   
        const batchTaskDto = new BatchTaskDto(params);
        if (enableAutoClearRecycle) {
            logTaskEvent(`开始清空[${username}]个人回收站`)
            await this.createBatchTask(cloud189, batchTaskDto)
            logTaskEvent(`清空[${username}]个人回收站完成`)
            // 延迟10秒
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        if (enableAutoClearFamilyRecycle) {
            // 获取家庭id
            const familyInfo = await cloud189.getFamilyInfo()
            if (familyInfo == null) {
                logTaskEvent(`用户${username}没有家庭主账号, 跳过`)
                return
            }
            logTaskEvent(`开始清空[${username}]家庭回收站`)
            batchTaskDto.familyId = familyInfo.familyId
            await this.createBatchTask(cloud189, batchTaskDto)
            logTaskEvent(`清空[${username}]家庭回收站完成`)
        }
    }
    // 校验文件后缀
    _checkFileSuffix(file,enableOnlySaveMedia, mediaSuffixs) {
        // 获取文件后缀
        const fileExt = '.' + file.name.split('.').pop().toLowerCase();
        const isMedia = mediaSuffixs.includes(fileExt)
        // 如果启用了只保存媒体文件, 则检查文件后缀是否在配置中
        if (enableOnlySaveMedia && !isMedia) {
            return false
        }
        return true
    }
    // 根据realRootFolderId获取根目录
    async getRootFolder(task) {
        if (task.realRootFolderId) {
            // 判断realRootFolderId下是否还有其他目录, 通过任务查询 查询realRootFolderId是否有多个任务, 如果存在多个 则使用realFolderId
            const tasks = await this.taskRepo.find({
                where: {
                    realRootFolderId: task.realRootFolderId
                }
            })
            if (tasks.length > 1) {
                return {id: task.realFolderId, name: task.realFolderName}    
            }
            return {id: task.realRootFolderId, name: task.shareFolderName}
        }
        logTaskEvent(`任务[${task.resourceName}]为老版本系统创建, 无法删除网盘内容, 跳过`)
        return null
    }
    // 删除网盘文件
    async deleteCloudFile(cloud189, file, isFolder) {
        if (!file) return;
        const taskInfos = []
        // 如果file是数组, 则遍历删除
        if (Array.isArray(file)) {
            for (const f of file) {
                taskInfos.push({
                    fileId: f.id,
                    fileName: f.name,
                    isFolder: isFolder
                })
            }
        }else{
            taskInfos.push({
                fileId: file.id,
                fileName: file.name,
                isFolder: isFolder
            })
        }
        console.log(taskInfos)
        
        const batchTaskDto = new BatchTaskDto({
            taskInfos: JSON.stringify(taskInfos),
            type: 'DELETE',
            targetFolderId: ''
        });
        await this.createBatchTask(cloud189, batchTaskDto)
    }

    // 根据accountId获取账号
    async _getAccountById(accountId) {
        return await this.accountRepo.findOne({
            where: {
                id: accountId
            }
        })
    }

    /**
     * 处理移动云盘（cloud139）任务转存
     * 调用 share-kd-njs 接口，无需 mcloud-sign
     */
    async _processCloud139Task(task, account) {
        return processCloud139Task(this, task, account);
    }

    /**
     * 创建移动云盘（cloud139）转存任务
     */
    /**
     * 在 139 云盘指定目录下按名称查找子目录，返回匹配的 catalogID；未找到返回 null。
     * @param {Cloud139Service} cloud139
     * @param {string} parentCatalogID - 父目录 ID
     * @param {string} folderName - 要查找的目录名
     * @returns {Promise<string|null>}
     */
    /**
     * 在 parentCatalogID 目录下按名称查找子文件夹，返回其 fileId，找不到返回 null。
     *
     * 原实现使用 listDiskDir（每页仅 100 条、无分页），当目录下子文件夹数量超过 100 时
     * 无法找到已有同名目录，最终调 createFolderHcy，139 API 会自动给新建目录追加时间戳
     * 和随机后缀（如 _20260313_000440_1795），导致同名目录不断堆积。
     *
     * 现改用 cloud139.findFolderByName 分页遍历所有子目录，彻底解决此问题。
     */
    async _findMatchingFolder139(cloud139, parentCatalogID, folderName) {
        if (!parentCatalogID || parentCatalogID === '-1' || parentCatalogID === 'root') return null;
        try {
            const fileId = await cloud139.findFolderByName(parentCatalogID, folderName);
            if (fileId) {
                logTaskEvent(`[139] 在目标目录下找到匹配子目录: "${folderName}" (${fileId})`);
                return fileId;
            }
        } catch (e) {
            logTaskEvent(`[139] 搜索子目录失败: ${e.message}`);
        }
        logTaskEvent(`[139] 目标目录下未找到 "${folderName}"，将新建`);
        return null;
    }

    /**
     * 通过路径字符串从根目录逐层查找目录，返回最终目录的 HCY fileId。
     * 不创建目录，仅查找。若任意一层不存在则抛出错误。
     * @param {object} cloud139
     * @param {string} folderPath - 如 "media/Downloads" 或 "123"
     * @returns {Promise<string>} HCY fileId
     */
    async _resolveCloud139FolderByPath(cloud139, folderPath) {
        const segments = (folderPath || '').replace(/^[\/]|[\/]$/g, '').split(/[\/]/).filter(Boolean);
        if (segments.length === 0) return '/';
        let currentId = '/';
        for (const seg of segments) {
            const result = await cloud139.listDiskDir(currentId).catch(() => null);
            if (!result) throw new Error(`无法列出目录 "${currentId}"`);
            const match = result.items.find(f => f.type === 'folder' && f.name.trim() === seg.trim());
            if (!match) throw new Error(`路径 "${folderPath}" 中的目录 "${seg}" 不存在`);
            currentId = match.fileId;
        }
        return currentId;
    }

    /** 根据 catalogMap 计算 caID 相对于根目录的路径片段，如 ['G'] 表示 root/G */
    _getCatalogPathSegments(caID, rootCaID, catalogMap) {
        const rootStr = String(rootCaID);
        const segments = [];
        let current = String(caID);
        while (current !== rootStr && current !== 'root') {
            const entry = catalogMap[current];
            if (!entry) break;
            segments.unshift(entry.name);
            current = entry.parentCaID;
        }
        return segments;
    }

    /** 沿 pathSegments 逐层查找或创建子目录，返回最终目录 ID */
    async _ensureCloud139FolderPath(cloud139, baseFolderId, pathSegments) {
        let currentId = baseFolderId;
        for (const seg of pathSegments) {
            const found = await this._findMatchingFolder139(cloud139, currentId, seg);
            if (found) {
                currentId = found;
            } else {
                const created = await cloud139.createFolderHcy(currentId, seg);
                if (!created?.fileId) throw new Error(`创建子目录 "${seg}" 失败`);
                currentId = created.fileId;
            }
        }
        return currentId;
    }

    async _createCloud139Tasks(params, account, taskDto) {
        const cloud139 = Cloud139Service.getInstance(account);
        const { linkID, passwd } = this.taskParserService.parseCloud139ShareLink(taskDto.shareLink);
        const effectivePasswd = taskDto.accessCode || passwd;

        // 获取分享根目录信息
        const rootInfo = await cloud139.listShareDir(linkID, effectivePasswd, 'root');
        if (!rootInfo) throw new Error('获取分享信息失败');

        // 若 root 只有一个文件夹且无文件，实际内容在该文件夹内；
        // 用该文件夹名作为 linkName，并从其子目录列表查找 selectedFolders
        let folderListForLookup = rootInfo.folderList ?? [];
        {
            const rootFiles = rootInfo.fileList ?? [];
            if (folderListForLookup.length === 1 && rootFiles.length === 0) {
                const singleFolderID = folderListForLookup[0].catalogID ?? folderListForLookup[0].caID;
                const childInfo = await cloud139.listShareDir(linkID, effectivePasswd, singleFolderID);
                folderListForLookup = childInfo?.folderList ?? [];
            }
        }

        const linkName = rootInfo.linkName || linkID;
        const taskName = taskDto.taskName || linkName;
        const tasks = [];
        const selectedFolders = taskDto.selectedFolders || [];

        // 验证目标目录是否可访问；若 fileId 已失效（可能是旧格式 ID），则通过路径重新解析
        let effectiveTargetFolderId = taskDto.targetFolderId;
        const targetFolderCheck = await cloud139.listDiskDir(effectiveTargetFolderId).catch(() => null);
        if (!targetFolderCheck) {
            const folderPath = taskDto.targetFolder || '';
            logTaskEvent(`[139] 目标目录 fileId(${effectiveTargetFolderId}) 无效，尝试通过路径 "${folderPath}" 重新解析`);
            try {
                effectiveTargetFolderId = await this._resolveCloud139FolderByPath(cloud139, folderPath);
                logTaskEvent(`[139] 路径解析成功，新 fileId: ${effectiveTargetFolderId}`);
            } catch (resolveErr) {
                throw new Error(`目标目录不存在或已失效，请重新在账号页面设置常用目录（路径: ${folderPath}）`);
            }
        }

        // 在目标目录下查找或创建同名根文件夹（与 cloud189 逻辑一致）
        const matchedRootId = await this._findMatchingFolder139(cloud139, effectiveTargetFolderId, taskName);
        let realRootFolderId;
        if (matchedRootId) {
            realRootFolderId = matchedRootId;
            logTaskEvent(`[139] 使用已有目录: "${taskName}" (${matchedRootId})`);
        } else {
            // 目标目录下无同名文件夹，自动创建
            logTaskEvent(`[139] 目标目录下无 "${taskName}"，自动创建`);
            const created = await cloud139.createFolderHcy(effectiveTargetFolderId, taskName);
            if (!created?.fileId) throw new Error(`创建目录 "${taskName}" 失败`);
            realRootFolderId = created.fileId;
            logTaskEvent(`[139] 已创建根目录: "${taskName}" (${realRootFolderId})`);
        }

        // 根目录任务（id = -1 或未选择特定子目录）
        const wantsRoot = !selectedFolders.length ||
            selectedFolders.includes('-1') ||
            selectedFolders.includes(-1) ||
            (typeof selectedFolders[0] === 'number' && selectedFolders[0] === -1);

        if (wantsRoot) {
            const task = this.taskRepo.create({
                accountId: taskDto.accountId,
                shareLink: taskDto.shareLink,
                shareId: linkID,
                shareFolderId: 'root',
                shareFolderName: '',
                shareMode: 0,
                targetFolderId: effectiveTargetFolderId,
                realFolderId: realRootFolderId,
                realFolderName: path.join(taskDto.targetFolder || '', taskName),
                realRootFolderId: realRootFolderId,
                resourceName: taskName,
                status: 'pending',
                totalEpisodes: taskDto.totalEpisodes,
                currentEpisodes: 0,
                accessCode: effectivePasswd,
                matchPattern: taskDto.matchPattern,
                matchOperator: taskDto.matchOperator,
                matchValue: taskDto.matchValue,
                remark: taskDto.remark,
                enableCron: taskDto.enableCron,
                cronExpression: taskDto.cronExpression,
                sourceRegex: taskDto.sourceRegex,
                targetRegex: taskDto.targetRegex,
                movieRenameFormat: taskDto.movieRenameFormat || '',
                tvRenameFormat: taskDto.tvRenameFormat || '',
                isFolder: true,
            });
            tasks.push(await this.taskRepo.save(task));
        }

        // 子目录任务（针对每个选中的 caID）
        // 若已选根目录，根任务会递归获取所有文件，无需再创建子目录任务（否则会重复转存）
        if (wantsRoot) {
            if (tasks.length === 0) {
                throw new Error('未选择任何目录，请至少选择一个目录');
            }
            if (taskDto.enableCron) {
                for (const task of tasks) {
                    SchedulerService.saveTaskJob(task, this);
                }
            }
            return tasks;
        }

        // 根目录文件任务：用户在「选择子目录」模式下勾选了「根目录文件」选项
        // shareFolderId='root-files' 标记此任务只同步根层直属文件，不递归子目录
        if (selectedFolders.map(String).includes('root-files')) {
            const rootFilesTask = this.taskRepo.create({
                accountId: taskDto.accountId,
                shareLink: taskDto.shareLink,
                shareId: linkID,
                shareFolderId: 'root-files',
                // 空字符串：让卡片只显示 resourceName（taskName），不拼子目录路径
                shareFolderName: '',
                shareMode: 0,
                targetFolderId: effectiveTargetFolderId,
                realFolderId: realRootFolderId,
                realFolderName: path.join(taskDto.targetFolder || '', taskName),
                realRootFolderId: realRootFolderId,
                resourceName: taskName,
                status: 'pending',
                totalEpisodes: taskDto.totalEpisodes,
                currentEpisodes: 0,
                accessCode: effectivePasswd,
                matchPattern: taskDto.matchPattern,
                matchOperator: taskDto.matchOperator,
                matchValue: taskDto.matchValue,
                remark: taskDto.remark,
                enableCron: taskDto.enableCron,
                cronExpression: taskDto.cronExpression,
                sourceRegex: taskDto.sourceRegex,
                targetRegex: taskDto.targetRegex,
                movieRenameFormat: taskDto.movieRenameFormat || '',
                tvRenameFormat: taskDto.tvRenameFormat || '',
                isFolder: true,
            });
            tasks.push(await this.taskRepo.save(rootFilesTask));
            logTaskEvent(`[139] 已创建根目录文件任务（仅同步直属文件，不递归子目录）`);
        }

        // 子目录任务循环：排除 '-1' 和 'root-files' 两个特殊标记
        for (const caID of selectedFolders.filter(id => String(id) !== '-1' && String(id) !== 'root-files')) {
            const folder = folderListForLookup.find(f => {
                const id = f.catalogID || f.caID;
                return String(id) === String(caID);
            });
            const folderName = folder ? (folder.catalogName || folder.caName || String(caID)) : String(caID);

            // 在 realRootFolderId 下查找或创建子目录（与 cloud189 逻辑一致）
            const matchedSubId = await this._findMatchingFolder139(cloud139, realRootFolderId, folderName);
            let realFolderId;
            if (matchedSubId) {
                realFolderId = matchedSubId;
                logTaskEvent(`[139] 使用已有子目录: "${folderName}" (${matchedSubId})`);
            } else {
                logTaskEvent(`[139] 创建子目录: "${folderName}" 在 (${realRootFolderId})`);
                const createdSub = await cloud139.createFolderHcy(realRootFolderId, folderName);
                if (!createdSub?.fileId) throw new Error(`创建子目录 "${folderName}" 失败`);
                realFolderId = createdSub.fileId;
                logTaskEvent(`[139] 已创建子目录: "${folderName}" (${realFolderId})`);
            }

            const task = this.taskRepo.create({
                accountId: taskDto.accountId,
                shareLink: taskDto.shareLink,
                shareId: linkID,
                shareFolderId: String(caID),
                shareFolderName: folderName,
                shareMode: 0,
                targetFolderId: effectiveTargetFolderId,
                realFolderId: realFolderId,
                realFolderName: path.join(taskDto.targetFolder || '', taskName, folderName),
                realRootFolderId: realRootFolderId,
                resourceName: taskName,
                status: 'pending',
                totalEpisodes: taskDto.totalEpisodes,
                currentEpisodes: 0,
                accessCode: effectivePasswd,
                matchPattern: taskDto.matchPattern,
                matchOperator: taskDto.matchOperator,
                matchValue: taskDto.matchValue,
                remark: taskDto.remark,
                enableCron: taskDto.enableCron,
                cronExpression: taskDto.cronExpression,
                sourceRegex: taskDto.sourceRegex,
                targetRegex: taskDto.targetRegex,
                movieRenameFormat: taskDto.movieRenameFormat || '',
                tvRenameFormat: taskDto.tvRenameFormat || '',
                isFolder: true,
            });
            tasks.push(await this.taskRepo.save(task));
        }

        if (tasks.length === 0) {
            throw new Error('未选择任何目录，请至少选择一个目录');
        }

        if (taskDto.enableCron) {
            for (const task of tasks) {
                SchedulerService.saveTaskJob(task, this);
            }
        }
        return tasks;
    }

    // 根据分享链接获取文件目录组合 资源名 资源名/子目录1 资源名/子目录2
    async parseShareFolderByShareLink(shareLink, accountId, accessCode) {
        const account = await this._getAccountById(accountId)
        if (!account) {
            throw new Error('账号不存在')
        }

        // Cloud139 分支
        if (account.accountType === 'cloud139') {
            const cloud139 = Cloud139Service.getInstance(account);
            return this.taskParserService.buildCloud139ShareFolders(cloud139, shareLink, accessCode);
        }

        const cloud189 = Cloud189Service.getInstance(account);
        return this.taskParserService.buildCloud189ShareFolders(
            cloud189,
            shareLink,
            accessCode,
            this.getShareInfo.bind(this)
        );
    }

    // 校验目录是否在目录列表中
    checkFolderInList(taskDto, folderId) {
        return (!taskDto.selectedFolders || taskDto.selectedFolders.length === 0) || taskDto.tgbot || (taskDto.selectedFolders?.includes(folderId) || false);
    }

    // 校验云盘中是否存在同名目录
    async checkFolderExists(cloud189, targetFolderId, folderName, overwriteFolder = false) {
        const folderInfo = await cloud189.listFiles(targetFolderId);
        if (!folderInfo) {
            throw new Error('获取文件列表失败');
        }

        // 检查目标文件夹是否存在
        const { folderList = [] } = folderInfo.fileListAO;
        const existFolder = folderList.find(folder => folder.name === folderName);
        if (existFolder) {
            if (!overwriteFolder) {
                throw new Error('folder already exists');
            }
            // 如果用户需要覆盖, 则删除目标目录
            await this.deleteCloudFile(cloud189, existFolder, 1)
        }
    }

    // 根据id获取任务
    async getTaskById(id) {
        return await this.taskRepo.findOne({
            where: { id: parseInt(id) },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            }
        });
    }
    // 根据布隆过滤器判断是否被和谐
    isHarmonized(file) {
        // 检查资源是否被和谐
        if (harmonizedFilter.isHarmonized(file.md5)) {
            logTaskEvent(`文件 ${file.name} 被和谐`);
            return true;
        }    
        return false
    }

    // 根据文件id批量删除文件
    async deleteFiles(taskId, files) {
        const task = await this.getTaskById(taskId)
        if (!task) {
            throw new Error('任务不存在')
        }
        if (!task.enableSystemProxy) {
            if (task.account?.accountType === 'cloud139') {
                const cloud139 = Cloud139Service.getInstance(task.account);
                await this.deleteCloudFile139(cloud139, files, 0);
            } else {
                const cloud189 = Cloud189Service.getInstance(task.account);
                await this.deleteCloudFile(cloud189, files, 0);
            }
        }
    }

    // 删除移动云盘（cloud139）文件/目录
    async deleteCloudFile139(cloud139, file, isFolder) {
        if (!file) return;
        const fileIds = [];

        if (Array.isArray(file)) {
            for (const f of file) {
                if (f.id) fileIds.push(f.id);
            }
        } else {
            if (file.id) fileIds.push(file.id);
        }

        if (!fileIds.length) {
            logTaskEvent('[139] 无有效 fileId，跳过删除');
            return;
        }
        logTaskEvent(`[139] 删除网盘内容: fileIds=${JSON.stringify(fileIds)}`);
        const result = await cloud139.deleteFiles(fileIds);
        if (!result) {
            logTaskEvent('[139] 删除网盘内容失败，请检查文件ID是否正确');
        } else {
            logTaskEvent('[139] 删除网盘内容成功');
        }
    }
}

module.exports = { TaskService };

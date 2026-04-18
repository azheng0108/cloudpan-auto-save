const { In, IsNull } = require('typeorm');
const { Cloud139Service } = require('./cloud139');
const { MessageUtil } = require('./message');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { CreateTaskDto } = require('../dto/TaskDto');
const { TaskCompleteEventDto } = require('../dto/TaskCompleteEventDto');
const { SchedulerService } = require('./scheduler');

const path = require('path');
const { EventService } = require('./eventService');
const { TaskEventHandler } = require('./taskEventHandler');
const harmonizedFilter = require('../utils/BloomFilter');
const { processCloud139Task } = require('./cloud139TaskProcessor');
const { TaskNamingService } = require('./taskNamingService');
const { TaskParserService } = require('./taskParserService');
const { TaskRetryService } = require('./taskRetryService');
const { TaskRecycleService } = require('./taskRecycleService');
const { TaskStorageService } = require('./taskStorageService');
const TaskErrorService = require('./taskErrorService');

class TaskService {
    constructor(taskRepo, accountRepo, transferredFileRepo, taskErrorRepo) {
        this.taskRepo = taskRepo;
        this.accountRepo = accountRepo;
        this.transferredFileRepo = transferredFileRepo || null;
        this.taskErrorRepo = taskErrorRepo || null;
        this.messageUtil = new MessageUtil();
        this.eventService = EventService.getInstance();
        this.taskNamingService = new TaskNamingService();
        this.taskParserService = new TaskParserService();
        this.taskRetryService = new TaskRetryService(this);
        this.taskRecycleService = new TaskRecycleService(this);
        this.taskStorageService = new TaskStorageService(this);
        this.taskErrorService = taskErrorRepo ? new TaskErrorService(taskErrorRepo) : null;
        /** @type {Set<number|string>} 记录当前进程内正在执行的任务，避免并发回写状态 */
        this.runningTaskIds = new Set();
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

    // 创建新任务
    async createTask(params) {
        const taskDto = new CreateTaskDto(params);
        taskDto.validate();
        // 获取分享信息
        const account = await this.accountRepo.findOneBy({ id: taskDto.accountId });
        if (!account) throw new Error('账号不存在');

        // Cloud139 分支 — 先从分享文本中提取纯 URL 和访问码
        const parsed = this.taskParserService.extractCloud139ShareText(taskDto.shareLink);
        if (parsed) {
            taskDto.shareLink = parsed.url;
            if (parsed.passwd && !taskDto.accessCode) taskDto.accessCode = parsed.passwd;
        }
        return await this._createCloud139Tasks(params, account, taskDto);
    }
    async increaseShareFileAccessCount(cloud139, shareId) {
        // no-op for cloud139
    }
    // 删除任务
    async deleteTask(taskId, deleteCloud) {
        return this.taskStorageService.deleteTask(taskId, deleteCloud);
    }

    // 批量删除
    async deleteTasks(taskIds, deleteCloud) {
        return this.taskStorageService.deleteTasks(taskIds, deleteCloud);
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
        const normalizedShareFolderName = String(task.shareFolderName || '').trim();
        const isRootLikeTask = !task.shareFolderId || task.shareFolderId === 'root' || task.shareFolderId === '-1' || task.shareFolderId === -1 || task.shareFolderId === 'root-files';
        if (task.shareFolderId === 'root-files' || isRootLikeTask || !normalizedShareFolderName) {
            // 根任务/散文件任务或目录名为空时，不应创建子目录，直接复用根目录避免 139 报“文件名称不符合标准”。
            if (!normalizedShareFolderName && !isRootLikeTask) {
                logTaskEvent('[139] 子目录名为空，跳过子目录创建并复用根目录');
            }
            task.realFolderId = task.realRootFolderId;
        } else if (task.realFolderId !== task.realRootFolderId) {
            logTaskEvent(`[139] 正在创建子目录: ${normalizedShareFolderName}`);
            const created = await cloud139.createFolderHcy(task.realRootFolderId, normalizedShareFolderName);
            if (!created?.fileId) throw new Error('创建子目录失败');
            task.realFolderId = created.fileId;
            logTaskEvent(`[139] 子目录创建成功: ${normalizedShareFolderName} (${task.realFolderId})`);
        } else {
            task.realFolderId = task.realRootFolderId;
        }

        await this.taskRepo.save(task);
        logTaskEvent('[139] 目录重建完成');
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
            if (this.isTaskRunning(task.id)) {
                logTaskEvent(`任务[${task.id}]正在执行中，跳过重复触发`);
                return '';
            }
            this.markTaskRunning(task.id);
            const account = await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) {
                logTaskEvent(`账号不存在，accountId: ${task.accountId}`);
                throw new Error('账号不存在');
            }
            task.account = account;
            // Cloud139 处理
            const result = await this._processCloud139Task(task, account);
            saveResults.push(result);
            return saveResults.filter(Boolean).join('\n');
        } catch (error) {
            return await this.taskRetryService.handleTaskFailure(task, error);
        } finally {
            this.markTaskFinished(task.id);
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
    async getPendingTasks(ignore = false, taskIds = [], includeProcessing = false) {
        const conditions = [
            {
                status: 'pending',
                nextRetryTime: null,
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            }
        ];
        if (includeProcessing) {
            conditions.push({
                status: 'processing',
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            });
        }
        return await this.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    alistStrmPath: true,
                    alistNativePath: true,
                    rootFolderId: true,
                    embyLibraryPath: true,
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
                    alistStrmPath: true,
                    alistNativePath: true,
                    rootFolderId: true,
                    embyLibraryPath: true,
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

    // 清理文件名中的非法字符
    _sanitizeFileName(fileName) {
        return this.taskNamingService.sanitizeFileName(fileName);
    }

    // 自动重命名（cloud139）
    // 优先级：Jinja2 模板 > 正则替换。仅处理本次增量 fileList。
    async autoRename(task, fileList = []) {
        const files = Array.isArray(fileList) ? fileList : [];
        if (files.length === 0) {
            logTaskEvent(`自动重命名跳过: taskId=${task?.id} | reason=fileList=0`);
            return [];
        }

        const taskMovieTemplate = String(task?.movieRenameFormat || '').trim();
        const taskTvTemplate = String(task?.tvRenameFormat || '').trim();
        const globalMovieTemplate = String(ConfigService.getConfigValue('tmdb.movieRenameFormat') || '').trim();
        const globalTvTemplate = String(ConfigService.getConfigValue('tmdb.tvRenameFormat') || '').trim();
        const movieTemplate = taskMovieTemplate || globalMovieTemplate;
        const tvTemplate = taskTvTemplate || globalTvTemplate;

        const sourceRegex = String(task?.sourceRegex || '').trim();
        const targetRegex = String(task?.targetRegex || '');
        const useTemplate = !!(movieTemplate || tvTemplate);
        const useRegex = !!(sourceRegex && targetRegex !== undefined);

        if (!useTemplate && !useRegex) {
            logTaskEvent(`自动重命名跳过: taskId=${task?.id} | reason=no-rules`);
            return files;
        }

        const account = task.account || await this._getAccountById(task.accountId);
        if (!account) {
            logTaskEvent(`自动重命名跳过: taskId=${task?.id} | reason=account-not-found`);
            return files;
        }

        const cloud139 = Cloud139Service.getInstance(account);
        const updatedFiles = [];
        let renamedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let regex = null;

        if (!useTemplate && useRegex) {
            try {
                regex = new RegExp(sourceRegex);
            } catch (error) {
                logTaskEvent(`自动重命名跳过: taskId=${task?.id} | reason=invalid-regex | error=${error.message}`);
                return files;
            }
        }

        for (const file of files) {
            const oldName = String(file?.name || '').trim();
            const fileId = file?.id;
            if (!oldName || !fileId) {
                skippedCount += 1;
                updatedFiles.push(file);
                continue;
            }

            let newName = oldName;

            if (useTemplate) {
                const vars = this._parseMediaFileName(oldName);
                const pickedTemplate = vars.season_episode ? tvTemplate : movieTemplate;
                if (!pickedTemplate) {
                    skippedCount += 1;
                    updatedFiles.push(file);
                    continue;
                }
                const rendered = this._renderJinjaTemplate(pickedTemplate, vars);
                if (!rendered) {
                    failedCount += 1;
                    updatedFiles.push(file);
                    continue;
                }
                newName = String(rendered).split('/').pop();
            } else if (regex) {
                newName = oldName.replace(regex, targetRegex);
            }

            newName = this._sanitizeFileName(newName || '');
            if (!newName || newName === oldName) {
                skippedCount += 1;
                updatedFiles.push(file);
                continue;
            }

            try {
                const renameResult = await cloud139.renameFile(fileId, newName);
                if (renameResult && renameResult.res_code === 0) {
                    renamedCount += 1;
                    updatedFiles.push({ ...file, name: newName });
                } else {
                    failedCount += 1;
                    updatedFiles.push(file);
                }
            } catch (error) {
                failedCount += 1;
                logTaskEvent(`自动重命名单文件失败: taskId=${task?.id} | fileId=${fileId} | error=${error.message}`);
                updatedFiles.push(file);
            }
        }

        logTaskEvent(
            `自动重命名完成: taskId=${task?.id} | mode=${useTemplate ? 'template' : 'regex'} | renamed=${renamedCount} | skipped=${skippedCount} | failed=${failedCount}`
        );
        return updatedFiles;
    }

    // 执行所有任务
    async processAllTasks(ignore = false, taskIds = []) {
        const tasks = await this.getPendingTasks(ignore, taskIds, false);
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

    async processRetryTasks() {
        return this.taskRetryService.processRetryTasks();
    }
    // 定时清空回收站
    async clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        return this.taskRecycleService.clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle);
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
        return this.taskStorageService.getRootFolder(task);
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

    _normalizeSegment(value) {
        return String(value || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
    }

    _normalizeDetailPath(value) {
        return String(value || '')
            .replace(/\\/g, '/')
            .split('/')
            .map(part => part.trim())
            .filter(Boolean)
            .join('/');
    }

    _getPathTail(folderPath) {
        const normalized = String(folderPath || '').trim().replace(/[\\/]+$/g, '');
        if (!normalized) return '';
        const parts = normalized.split(/[\\/]/).filter(Boolean);
        return parts.length ? parts[parts.length - 1].trim() : '';
    }

    _shouldReuseTargetFolder(targetFolderPath, folderName) {
        const baseTail = this._normalizeSegment(this._getPathTail(targetFolderPath));
        const folder = this._normalizeSegment(folderName);
        return !!baseTail && !!folder && baseTail === folder;
    }

    _joinFolderPath(basePath, folderName) {
        const base = String(basePath || '').trim();
        const name = String(folderName || '').trim();
        if (!base) return name;
        if (!name) return base;
        if (this._shouldReuseTargetFolder(base, name)) {
            return base;
        }
        return path.join(base, name);
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
        const normalizedTargetDetailPath = this._normalizeDetailPath(taskDto.targetDetailPath);
        const composedTargetFolderPath = this._joinFolderPath(taskDto.targetFolder || '', normalizedTargetDetailPath);

        // 验证目标目录是否可访问；若 fileId 已失效（可能是旧格式 ID），则通过路径重新解析
        let effectiveTargetFolderId = taskDto.targetFolderId;
        const targetFolderCheck = await cloud139.listDiskDir(effectiveTargetFolderId).catch(() => null);
        if (!targetFolderCheck) {
            const folderPath = composedTargetFolderPath || taskDto.targetFolder || '';
            logTaskEvent(`[139] 目标目录 fileId(${effectiveTargetFolderId}) 无效，尝试通过路径 "${folderPath}" 重新解析`);
            try {
                effectiveTargetFolderId = await this._resolveCloud139FolderByPath(cloud139, folderPath);
                logTaskEvent(`[139] 路径解析成功，新 fileId: ${effectiveTargetFolderId}`);
            } catch (resolveErr) {
                if (normalizedTargetDetailPath && taskDto.targetFolder) {
                    const baseFolderPath = taskDto.targetFolder || '';
                    logTaskEvent(`[139] 详细路径未能直接解析，回退基础目录重试: ${baseFolderPath}`);
                    try {
                        effectiveTargetFolderId = await this._resolveCloud139FolderByPath(cloud139, baseFolderPath);
                        logTaskEvent(`[139] 基础目录解析成功，新 fileId: ${effectiveTargetFolderId}`);
                    } catch (baseResolveErr) {
                        throw new Error(`目标目录不存在或已失效，请重新在账号页面设置常用目录（路径: ${folderPath}）`);
                    }
                } else {
                    throw new Error(`目标目录不存在或已失效，请重新在账号页面设置常用目录（路径: ${folderPath}）`);
                }
            }
        }

        if (normalizedTargetDetailPath) {
            const detailSegments = normalizedTargetDetailPath.split('/').filter(Boolean);
            effectiveTargetFolderId = await this._ensureCloud139FolderPath(cloud139, effectiveTargetFolderId, detailSegments);
            logTaskEvent(`[139] 已定位详细路径: ${composedTargetFolderPath} (${effectiveTargetFolderId})`);
        }

        let realRootFolderId;
        const reuseTargetAsRoot = this._shouldReuseTargetFolder(composedTargetFolderPath, taskName);

        // 在目标目录下查找或创建同名根文件夹（与 cloud189 逻辑一致）
        if (reuseTargetAsRoot) {
            realRootFolderId = effectiveTargetFolderId;
            logTaskEvent(`[139] 目标目录末级与任务目录同名，复用目标目录: "${composedTargetFolderPath}" (${realRootFolderId})`);
        } else {
            const matchedRootId = await this._findMatchingFolder139(cloud139, effectiveTargetFolderId, taskName);
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
        }
        const rootRealFolderName = this._joinFolderPath(composedTargetFolderPath, taskName);

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
                realFolderName: rootRealFolderName,
                realRootFolderId: realRootFolderId,
                parentFileId: effectiveTargetFolderId,
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
                realFolderName: rootRealFolderName,
                realRootFolderId: realRootFolderId,
                parentFileId: effectiveTargetFolderId,
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
                realFolderName: this._joinFolderPath(rootRealFolderName, folderName),
                realRootFolderId: realRootFolderId,
                parentFileId: effectiveTargetFolderId,
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

    // 根据分享链接获取文件目录组合
    async parseShareFolderByShareLink(shareLink, accountId, accessCode) {
        const account = await this._getAccountById(accountId)
        if (!account) {
            throw new Error('账号不存在')
        }
        const cloud139 = Cloud139Service.getInstance(account);
        return this.taskParserService.buildCloud139ShareFolders(cloud139, shareLink, accessCode);
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
                    alistStrmPath: true,
                    alistNativePath: true,
                    embyLibraryPath: true,
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
        return this.taskStorageService.deleteFiles(taskId, files);
    }

    // 删除移动云盘（cloud139）文件/目录
    async deleteCloudFile139(cloud139, file) {
        return this.taskStorageService.deleteCloudFile139(cloud139, file);
    }

    /**
     * 判断任务是否正在执行。
     * @param {number|string} taskId
     * @returns {boolean}
     */
    isTaskRunning(taskId) {
        return this.runningTaskIds.has(taskId);
    }

    /**
     * 标记任务进入执行态，防止同任务并发写入。
     * @param {number|string} taskId
     */
    markTaskRunning(taskId) {
        this.runningTaskIds.add(taskId);
    }

    /**
     * 清理任务执行态标记。
     * @param {number|string} taskId
     */
    markTaskFinished(taskId) {
        this.runningTaskIds.delete(taskId);
    }
}

module.exports = { TaskService };

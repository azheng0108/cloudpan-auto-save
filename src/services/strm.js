const fs = require('fs').promises;
const path = require('path');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const CryptoUtils = require('../utils/cryptoUtils');
const { MessageUtil } = require('./message');
const logger = require('../utils/logger');

class StrmService {
    constructor() {
        this.enable = ConfigService.getConfigValue('strm.enable');
        const configuredDir = ConfigService.getConfigValue('strm.outputDir');
        this.baseDir = configuredDir ? path.resolve(configuredDir) : path.resolve(process.cwd(), 'strm');
        // 从环境变量获取 PUID 和 PGID，默认值设为 0
        this.puid = process.env.PUID || 0;
        this.pgid = process.env.PGID || 0;
        this.messageUtil = new MessageUtil();
    }

    // 确保目录存在并设置权限和组，递归创建的所有目录都设置为 777 权限
    async _ensureDirectoryExists(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            if (process.getuid && process.getuid() === 0) {
                try {
                    await fs.chown(dirPath, parseInt(this.puid), parseInt(this.pgid));
                } catch (_) {}
            }
            if (process.platform !== 'win32') {
                try {
                    await fs.chmod(dirPath, 0o777);
                } catch (_) {}
            }
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw new Error(`创建目录失败: ${error.message}`);
            }
        }
    }

    /**
     * 生成 STRM 文件
     * @param {Array} files - 文件列表，每个文件对象需包含 name 属性
     * @param {boolean} overwrite - 是否覆盖已存在的文件
     * @param {boolean} compare - 是否比较文件名 默认比较
     * @returns {Promise<Array>} - 返回生成的文件列表
     */
    async generate(task, files, overwrite = false, compare = true) {
        if (!this.enable){
            logTaskEvent(`STRM生成未启用, 请启用后执行`);
            return;
        }

        // 若传入的文件自带 targetFolderPath（如 TMDB 规范整理归档文件），无缝分流至工业级整理多目录生成
        if (Array.isArray(files) && files.some(f => Boolean(f.targetFolderPath))) {
            return this.generateForOrganizedFiles(files, {
                overwrite,
                accountId: task?.accountId || task?.account?.id,
                defaultTargetFolderName: task?.realFolderName || ''
            });
        }
        logTaskEvent(`${task.resourceName} 开始生成STRM文件, 总文件数: ${files.length}`);
        const results = [];
        let success = 0;
        let failed = 0;
        let skipped = 0;
        try {
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            // 使用完整 realFolderName（不裁剪目标目录前缀），normalize Windows 反斜杠
            // 修复：原来会裁掉第一段（目标目录），导致多目标目录时路径错误
            let taskName = (task.realFolderName || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
            // 全局 STRM 配置（账号级别已废弃，统一从 ConfigService 读取）
            const localStrmPrefix = ConfigService.getConfigValue('strm.localStrmPrefix') || task.account?.localStrmPrefix || '';
            const cloudStrmPrefix = ConfigService.getConfigValue('strm.cloudStrmPrefix') || task.account?.cloudStrmPrefix || '';
            // 构建完整的目标目录路径
            const targetDir = path.join(this.baseDir, localStrmPrefix, taskName);
            if (compare) {
                // 查询出所有目录下的.strm文件
                const strmFiles = await this.listStrmFiles(path.join(localStrmPrefix, taskName));
                // 将不在strmFiles中的文件删除
                for (const file of strmFiles) {
                    if (!files.some(f => path.parse(f.name).name === path.parse(file.name).name)) {
                        await this.delete(file.path);
                    }
                }
            }
            overwrite && await this._deleteDirAllStrm(targetDir)
            await this._ensureDirectoryExists(targetDir);
            for (const file of files) {
                // 检查文件是否是媒体文件
                if (!this._checkFileSuffix(file, mediaSuffixs)) {
                    // logTaskEvent(`文件不是媒体文件，跳过: ${file.name}`);
                    skipped++
                    continue;
                }
                
                try {
                    const fileName = file.name;
                    const parsedPath = path.parse(fileName);
                    const fileNameWithoutExt = parsedPath.name;
                    const strmPath = path.join(targetDir, `${fileNameWithoutExt}.strm`);

                    // 检查文件是否存在
                    try {
                        await fs.access(strmPath);
                        if (!overwrite) {
                            // logTaskEvent(`STRM文件已存在，跳过: ${strmPath}`);
                            skipped++
                            continue;
                        }
                    } catch (err) {
                        // 文件不存在，继续处理
                    }

                    // 生成STRM文件内容
                    let content;
                    content = this._joinUrl(this._joinUrl(cloudStrmPrefix, taskName), fileName);
                    await fs.writeFile(strmPath, content, 'utf8');
                    // 设置文件权限
                    if (process.getuid && process.getuid() === 0) {
                        await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                    }
                    await fs.chmod(strmPath, 0o777);
                    results.push({
                        originalFile: fileName,
                        strmFile: `${fileNameWithoutExt}.strm`,
                        path: strmPath
                    });
                    logTaskEvent(`生成STRM文件成功: ${strmPath}`);
                    success++
                } catch (error) {
                    logTaskEvent(`生成STRM文件失败: ${file.name}, 错误: ${error.message}`);
                    failed++
                }
            }
        } catch (error) {
            logger.error('生成STRM文件异常详情', { error: error.message, stack: error.stack })
            logTaskEvent(`生成STRM文件失败: ${error.message}`);
            failed++
        }
        // 记录文件总数, 成功数, 失败数, 跳过数
        const message = `[STRM] ${task.resourceName} 生成STRM文件完成, 总文件数: ${files.length}, 成功数: ${success}, 失败数: ${failed}, 跳过数: ${skipped}`
        logTaskEvent(message);
        return message;
    }

    /**
     * 批量生成STRM文件 根据Alist目录
     * @param {string} startPath - 起始目录路径
     * @returns {Promise<object>} - 返回处理结果统计
     */
    async generateAll(accounts, overwrite = false) {
        if (!alistService.Enable()) {
            throw new Error('Alist功能未启用');
        }
        const messages = [];
        for(const account of accounts) {
            try {
                let startPath = account.cloudStrmPrefix.includes('/d/') 
                ? account.cloudStrmPrefix.split('/d/')[1] 
                : path.basename(account.cloudStrmPrefix);
                // 初始化统计信息
                const stats = {
                    success: 0,
                    failed: 0,
                    skipped: 0,
                    totalFiles: 0,
                    processedDirs: new Set()
                };
                // 获取媒体文件后缀列表
                const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase());
                 // 如果覆盖 则直接删除currentPath
                if (overwrite) {
                    this.deleteDir(path.join(account.localStrmPrefix, startPath), true)
                }
                await this._processDirectory(startPath, account, stats, mediaSuffixs, overwrite);
                const userrname = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                // 生成最终统计信息
                const message = `[STRM] 账号: ${userrname}生成STRM文件完成\n` +
                              `处理目录数: ${stats.processedDirs.size}\n` +
                              `总文件数: ${stats.totalFiles}\n` +
                              `成功数: ${stats.success}\n` +
                              `失败数: ${stats.failed}\n` +
                              `跳过数: ${stats.skipped}`;
                logTaskEvent(message);
                messages.push(message);
            } catch (error) {
                const message = `生成STRM文件失败: ${error.message}`;
                logTaskEvent(message);
            }
        }
        if (messages.length > 0) {
            this.messageUtil.sendMessage(messages.join('\n\n'));
        }   
    }

    /**
     * 处理单个目录
     * @param {string} dirPath - 目录路径
     * @param {object} stats - 统计信息
     * @param {array} mediaSuffixs - 媒体文件后缀列表
     * @private
     */
    async _processDirectory(dirPath, account, stats, mediaSuffixs, overwrite) {
        // 获取alist文件列表
        const alistResponse = await alistService.listFiles(dirPath);
        if (!alistResponse || !alistResponse.data) {
            throw new Error(`获取Alist文件列表失败: ${dirPath}`);
        }
        if (!alistResponse.data.content) {
            return;
        }

        const files = alistResponse.data.content;
        logTaskEvent(`开始处理目录 ${dirPath}, 文件数量: ${files.length}`);

        for (const file of files) {
            try {
                if (file.is_dir) {
                    // 递归处理子目录
                    await this._processDirectory(path.join(dirPath, file.name), account, stats, mediaSuffixs, overwrite);
                } else {
                    stats.totalFiles++;
                    // 检查是否为媒体文件
                    if (!this._checkFileSuffix(file, mediaSuffixs)) {
                        // console.log(`文件不是媒体文件，跳过: ${file.name}`);
                        stats.skipped++;
                        continue;
                    }

                    // 构建STRM文件路径
                    const relativePath = dirPath.substring(dirPath.indexOf('/') + 1).replace(/^\/+|\/+$/g, '')
                    const targetDir = path.join(this.baseDir, account.localStrmPrefix, relativePath);
                    const parsedPath = path.parse(file.name);
                    const strmPath = path.join(targetDir, `${parsedPath.name}.strm`);
                    // overwrite && await this._deleteDirAllStrm(targetDir)
                    // 检查文件是否存在
                    try {
                        await fs.access(strmPath);
                        if (!overwrite) {
                            // console.log(`STRM文件已存在，跳过: ${strmPath}`);
                            stats.skipped++
                            continue;
                        }
                    } catch (err) {
                        // 文件不存在，继续处理
                    }

                    await this._ensureDirectoryExists(targetDir);

                    // 生成STRM文件内容
                    const content = this._joinUrl(account.cloudStrmPrefix, path.join(relativePath.replace(/^\/+|\/+$/g, ''), file.name));
                    // 写入STRM文件
                    await fs.writeFile(strmPath, content, 'utf8');
                    if (process.getuid && process.getuid() === 0) {
                        await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                    }
                    await fs.chmod(strmPath, 0o777);

                    stats.success++;
                    logTaskEvent(`生成STRM文件成功: ${strmPath}`);
                }
            } catch (error) {
                stats.failed++;
                logTaskEvent(`处理文件失败: ${file.name}, 错误: ${error.message}`);
            }
        }
    }

    async listStrmFiles(dirPath = '') {
        try {
            const targetPath = path.join(this.baseDir, dirPath);
            const results = [];
            
            // 检查目录是否存在
            try {
                await fs.access(targetPath);
            } catch (err) {
                return results;
            }
            // 读取目录内容
            const items = await fs.readdir(targetPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(targetPath, item.name);
                const relativePath = path.relative(this.baseDir, fullPath);
                if (item.isFile() && !item.name.startsWith('.') && path.extname(item.name) === '.strm') {
                    // 读取STRM文件内容
                    results.push({
                        id: item.name,
                        name: item.name,
                        path: relativePath
                    });
                }
            }
            
            return results;
        } catch (error) {
            throw new Error(`列出STRM文件失败: ${error.message}`);
        }
    }

    /**
     * 递归列出 baseDir 下全部已生成的 .strm 文件绝对路径
     * @param {string} dirPath
     * @returns {Promise<string[]>}
     */
    async listAllStrmFilesRecursive(dirPath = this.baseDir) {
        const results = [];
        const scan = async (targetDir) => {
            try {
                const items = await fs.readdir(targetDir, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(targetDir, item.name);
                    if (item.isDirectory()) {
                        await scan(fullPath);
                    } else if (item.isFile() && path.extname(item.name).toLowerCase() === '.strm') {
                        results.push(fullPath);
                    }
                }
            } catch (_) {}
        };
        await scan(dirPath);
        return results;
    }

    /**
     * 递归修剪 STRM 根目录下的空目录
     * @param {string} dirPath
     */
    async cleanEmptyDirs(dirPath = this.baseDir) {
        try {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            for (const item of items) {
                if (item.isDirectory()) {
                    const sub = path.join(dirPath, item.name);
                    await this.cleanEmptyDirs(sub);
                }
            }
            if (dirPath !== this.baseDir) {
                const remaining = await fs.readdir(dirPath);
                if (remaining.length === 0) {
                    await fs.rmdir(dirPath).catch(() => {});
                }
            }
        } catch (_) {}
    }

    /**
     * 删除STRM文件
     * @param {string} fileName - 原始文件名
     * @returns {Promise<void>}
     */
    async delete(fileName) {
        const parsedPath = path.parse(fileName);
        const dirPath = parsedPath.dir;
        const fileNameWithoutExt = parsedPath.name;
        const strmPath = path.join(this.baseDir, dirPath, `${fileNameWithoutExt}.strm`);
        const nfoPath = path.join(this.baseDir, dirPath, `${fileNameWithoutExt}.nfo`);
        const thumbPath = path.join(this.baseDir, dirPath, `${fileNameWithoutExt}-thumb.jpg`);
        try {
           // 删除 .strm 文件
           try {
                await fs.access(strmPath);
                await fs.unlink(strmPath);
                logTaskEvent(`删除STRM文件成功: ${strmPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除STRM文件失败: ${strmPath}, 错误: ${err.message}`);
                }
            }

            // 删除 .nfo 文件
            try {
                await fs.access(nfoPath);
                await fs.unlink(nfoPath);
                logTaskEvent(`删除NFO文件成功: ${nfoPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除NFO文件失败: ${nfoPath}, 错误: ${err.message}`);
                }
            }

            // 删除 -thumb.jpg 图片
            try {
                await fs.access(thumbPath);
                await fs.unlink(thumbPath);
                logTaskEvent(`删除Thumb图片成功: ${thumbPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除Thumb图片失败: ${thumbPath}, 错误: ${err.message}`);
                }
            }
            
            // 尝试删除空目录
            const targetDir = path.join(this.baseDir, dirPath);
            const files = await fs.readdir(targetDir);
            if (files.length === 0) {
                await fs.rmdir(targetDir);
                logTaskEvent(`删除空目录: ${targetDir}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`删除STRM文件失败: ${error.message}`);
            }
        }
    }
    // 删除目录
    async deleteDir(dirPath) {
        try {
            const targetDir = path.join(this.baseDir, dirPath);
             // 检查目录是否存在
             try {
                await fs.access(targetDir);
            } catch (err) {
                // 目录不存在，直接返回
                // logTaskEvent(`STRM目录不存在，跳过删除: ${targetDir}`);
                return;
            }
            await fs.rm(targetDir, { recursive: true });
            logTaskEvent(`删除STRM目录成功: ${targetDir}`);

            // 检查并删除空的父目录
            const parentDir = path.dirname(targetDir);
            try {
                const files = await fs.readdir(parentDir);
                if (files.length === 0) {
                    await fs.rm(parentDir, { recursive: true });
                    logTaskEvent(`删除空目录: ${parentDir}`);
                }
            } catch (err) {
                
            }
        } catch (error) {
            logTaskEvent(`删除STRM目录失败: ${error.message}`);
        }
    }
    // 删除目录下的所有.strm文件
    async  _deleteDirAllStrm(dirPath) {
        // 检查目录是否存在
        try {
            await fs.access(dirPath);
        } catch (err) {
            // 目录不存在，直接返回
            logTaskEvent(`STRM目录不存在，跳过删除: ${dirPath}`);
            return;
        }
        const files = await fs.readdir(dirPath);
        await Promise.all(files.map(async file => {
            const filePath = path.join(dirPath, file);
            if (path.extname(filePath) === '.strm') {
                try {
                    await fs.unlink(filePath);
                    logTaskEvent(`删除文件成功: ${filePath}`);
                } catch (err) {
                    logTaskEvent(`删除文件失败: ${err.message}`);
                }
            }
        }));
    }
    //检查文件是否是媒体文件
    _checkFileSuffix(file, mediaSuffixs) {
         // 获取文件后缀
         const fileExt = '.' + file.name.split('.').pop().toLowerCase();
         return mediaSuffixs.includes(fileExt)
    }

    _joinUrl(base, path) {
        // 移除 base 末尾的斜杠（如果有）
        base = base.replace(/\/$/, '');
        // 移除 path 开头的斜杠（如果有）
        path = path.replace(/^\//, '');
        return `${base}/${path}`;
    }

    // 根据文件名获取STRM文件路径
    getStrmPath(task) {
        // 使用完整 realFolderName（不裁剪目标目录前缀），normalize Windows 反斜杠
        let taskName = (task.realFolderName || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
        const localStrmPrefix = ConfigService.getConfigValue('strm.localStrmPrefix') || task.account?.localStrmPrefix || '';
        const cloudStrmPrefix = ConfigService.getConfigValue('strm.cloudStrmPrefix') || task.account?.cloudStrmPrefix || '';
        if (!this.enable){
            // 如果cloudStrmPrefix存在 且不是url地址
            if (cloudStrmPrefix && !cloudStrmPrefix.startsWith('http')) {
                return path.join(cloudStrmPrefix, taskName);
            }
        } else {
            return path.join(this.baseDir, localStrmPrefix, taskName);
        }
        return '';
    }

    /**
     * 为 TMDB 规范整理归档后的文件列表批量生成本地 .strm 文件
     * 采用一致性直链封装技术：
     * 1. 物理目录结构 100% 镜像媒体库层级（如：剧集/国漫/片名 (年份) {tmdb-id}/Season 01/）
     * 2. 播放流支持两种模式：
     *    - direct302 (默认推荐): 139 官方 CDN 302 原生直链（免中间件，零宿主机带宽消耗）
     *    - custom: AList / OpenList / WebDAV 挂载前缀 URL
     * 
     * @param {Array<object>} files - 归档文件列表 [{ fileId, originalName, finalName, targetFolderPath, size, tmdbId, ... }]
     * @param {object} [options] - 选项 { overwrite, accountId, defaultTargetFolderName }
     * @returns {Promise<{ success: boolean, total: number, successCount: number, skippedCount: number, failedCount: number, results: Array }>}
     */
    async generateForOrganizedFiles(files, options = {}) {
        if (!Array.isArray(files) || files.length === 0) {
            return { success: true, total: 0, successCount: 0, skippedCount: 0, failedCount: 0, results: [] };
        }

        const overwrite = options.overwrite ?? options.forceAll ?? false;
        const mediaSuffixes = (ConfigService.getConfigValue('task.mediaSuffix') || '.mp4;.mkv;.avi;.mov;.ts;.flv;.wmv;.iso;.m4v;.rmvb;.strm')
            .split(';')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        const localStrmPrefix = ConfigService.getConfigValue('strm.localStrmPrefix') || '';
        const cloudStrmPrefix = ConfigService.getConfigValue('strm.cloudStrmPrefix') || '';
        const streamMode = ConfigService.getConfigValue('strm.streamMode') || 'direct302';
        const stripRootTargetDir = ConfigService.getConfigValue('strm.stripRootTargetDir') !== false;
        const defaultTargetFolderName = (options.defaultTargetFolderName || ConfigService.getConfigValue('channelMonitor.defaultTargetFolderName') || '目标目录')
            .replace(/^\/+|\/+$/g, '');

        const systemBaseUrl = ConfigService.getConfigValue('system.baseUrl') || 'http://127.0.0.1:3000';
        const accountId = options.accountId || '';

        let successCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        const results = [];

        const fullOutputDir = path.join(this.baseDir, localStrmPrefix);
        const startWriteMsg = `[STRM生成] 开始为 ${files.length} 个媒体文件写入本地 STRM (保存路径: ${fullOutputDir}, 直链模式: 139 CDN 302)`;
        logTaskEvent(startWriteMsg);
        logger.info(startWriteMsg);

        let cleanedObsoleteCount = 0;
        if (options.cleanObsolete) {
            try {
                logTaskEvent(`[STRM生成] 启动失效旧映射比对 (本地路径: ${this.baseDir})...`);
                const existingStrmFiles = await this.listAllStrmFilesRecursive(this.baseDir);
                const currentExpectedStrmNames = new Set(files.map(f => {
                    const n = f.finalName || f.name || f.originalName || '';
                    return path.parse(n).name.toLowerCase();
                }));
                for (const existingFile of existingStrmFiles) {
                    const parsed = path.parse(existingFile);
                    if (!currentExpectedStrmNames.has(parsed.name.toLowerCase())) {
                        await fs.unlink(existingFile).catch(() => {});
                        cleanedObsoleteCount++;
                        logger.info(`[STRM生成] 清理失效旧映射文件: ${existingFile}`);
                    }
                }
                await this.cleanEmptyDirs(this.baseDir);
                if (cleanedObsoleteCount > 0) {
                    const cleanDoneMsg = `[STRM生成] 失效旧映射清理完成: 共清理 ${cleanedObsoleteCount} 个失效 STRM 文件及残留空目录`;
                    logTaskEvent(cleanDoneMsg);
                    logger.info(cleanDoneMsg);
                } else {
                    const cleanNoneMsg = `[STRM生成] 本地旧映射比对完毕: 未发现失效 STRM 文件 (共比对本地 ${existingStrmFiles.length} 项)`;
                    logTaskEvent(cleanNoneMsg);
                    logger.info(cleanNoneMsg);
                }
            } catch (pruneErr) {
                const pruneErrMsg = `[STRM生成] 清理失效映射失败: ${pruneErr.message}`;
                logger.error(pruneErrMsg);
                logTaskEvent(pruneErrMsg);
            }
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.finalName || file.name || file.originalName;
            if (!fileName) continue;

            const parsedPath = path.parse(fileName);
            const ext = parsedPath.ext.toLowerCase();

            // 仅对视频媒体文件生成 .strm
            if (!mediaSuffixes.includes(ext)) {
                skippedCount++;
                continue;
            }

            try {
                // 计算相对归档路径 (例如: 目标目录/剧集/国漫/片名 (2026) {tmdb-123}/Season 01)
                let rawTargetFolder = (file.targetFolderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                
                // 若开启了顶层目标目录剥离（且路径以默认目标目录开头），将其剥离，使根目录直接为 剧集/ 或 电影/
                let relativePath = rawTargetFolder;
                if (stripRootTargetDir && defaultTargetFolderName && (relativePath === defaultTargetFolderName || relativePath.startsWith(defaultTargetFolderName + '/'))) {
                    relativePath = relativePath.slice(defaultTargetFolderName.length).replace(/^\/+/, '');
                }

                // 目标在宿主机上的 STRM 目录
                const fileTargetDir = path.join(this.baseDir, localStrmPrefix, relativePath);
                await this._ensureDirectoryExists(fileTargetDir);

                const fileNameWithoutExt = parsedPath.name;
                const strmFilePath = path.join(fileTargetDir, `${fileNameWithoutExt}.strm`);

                // 检查是否已存在
                let fileExists = false;
                try {
                    await fs.access(strmFilePath);
                    fileExists = true;
                } catch (_) {}

                if (fileExists && !overwrite) {
                    skippedCount++;
                    results.push({
                        originalFile: fileName,
                        strmFile: `${fileNameWithoutExt}.strm`,
                        path: strmFilePath,
                        status: 'skipped'
                    });
                    continue;
                }

                // 生成 STRM 内容（单行 URL）
                let content = '';
                const fileId = file.fileId || file.id;

                if (streamMode === 'direct302' || !cloudStrmPrefix) {
                    // 原生 302 直链模式 (免 AList，零宿主机流量)
                    const queryParams = [];
                    if (accountId) queryParams.push(`accountId=${accountId}`);
                    const queryStr = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';
                    content = `${systemBaseUrl.replace(/\/+$/, '')}/api/strm/stream/${fileId || ''}/${encodeURIComponent(fileName)}${queryStr}`;
                } else {
                    // 自定义 AList / WebDAV 挂载前缀模式
                    const joinFolder = cloudStrmPrefix.endsWith(defaultTargetFolderName) ? relativePath : rawTargetFolder;
                    content = this._joinUrl(this._joinUrl(cloudStrmPrefix, joinFolder), fileName);
                }

                await fs.writeFile(strmFilePath, content, 'utf8');

                if (process.getuid && process.getuid() === 0) {
                    try {
                        await fs.chown(strmFilePath, parseInt(this.puid), parseInt(this.pgid));
                    } catch (_) {}
                }
                if (process.platform !== 'win32') {
                    try {
                        await fs.chmod(strmFilePath, 0o777);
                    } catch (_) {}
                }

                successCount++;
                results.push({
                    originalFile: fileName,
                    strmFile: `${fileNameWithoutExt}.strm`,
                    path: strmFilePath,
                    content,
                    status: 'success'
                });
                logger.info(`[STRM生成] 写入成功: ${strmFilePath} -> ${content}`);

                // 每 50 个或第一项、最后一项在任务日志中广播进度
                const processedSoFar = successCount + skippedCount + failedCount;
                if (processedSoFar === 1 || processedSoFar % 50 === 0 || processedSoFar === files.length) {
                    logTaskEvent(`[STRM生成] 正在写入 STRM: 进度 ${processedSoFar}/${files.length} (${fileNameWithoutExt}.strm)`);
                }
            } catch (err) {
                failedCount++;
                logger.error(`[STRM生成] 写入失败: ${fileName}`, { error: err.message });
                logTaskEvent(`[STRM生成] 写入失败: ${fileName}, 错误: ${err.message}`);
                results.push({
                    originalFile: fileName,
                    error: err.message,
                    status: 'failed'
                });
            }
        }

        const summary = `[STRM生成] 文件写入完成: 成功 ${successCount} 个, 跳过 ${skippedCount} 个, 失败 ${failedCount} 个 (总数: ${files.length})，保存路径: ${fullOutputDir}`;
        logTaskEvent(summary);
        logger.info(summary);

        return {
            success: failedCount === 0,
            total: files.length,
            totalFiles: files.length,
            successCount,
            generatedStrm: successCount,
            skippedCount,
            skipped: skippedCount,
            failedCount,
            errors: failedCount,
            outputDir: fullOutputDir,
            cleanedObsoleteCount,
            results
        };
    }
}

module.exports = { StrmService };
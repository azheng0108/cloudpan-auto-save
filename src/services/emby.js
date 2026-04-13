const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database'); 
const { Task, Account } = require('../entities'); 
const { Cloud189Service } = require('../legacy189/services/cloud189');
const path = require('path');
const { StrmService } = require('./strm');
const logger = require('../utils/logger');

const { Not, IsNull, Like } = require('typeorm'); 

// emby接口
class EmbyService {
    constructor(taskService) {
        // 使用 emby.enable 布尔字段，避免整个对象存在时永远 truthy 的问题
        this.enable = ConfigService.getConfigValue('emby.enable');
        this.embyUrl = ConfigService.getConfigValue('emby.serverUrl');
        this.embyApiKey = ConfigService.getConfigValue('emby.apiKey');
        this.embyPathReplace = ''
        this.messageUtil = new MessageUtil();

        this._taskRepo = AppDataSource.getRepository(Task);
        this._accountRepo = AppDataSource.getRepository(Account);
        this._taskService = taskService;
        this._strmService = new StrmService();
    }

    _isLegacy189RuntimeEnabled() {
        return ConfigService.getConfigValue('legacy.enableCloud189Runtime') === true;
    }


    async notify(task, options = {}) {
        if (!this.enable){
            logTaskEvent(`Emby通知未启用, 请启用后执行`);
            return;
        }
        const taskName = task.resourceName
        logTaskEvent(`执行Emby通知: ${taskName}`);
        // 读取路径相关字段：优先使用 embyLibraryPath 精准拼接，fallback 到旧 embyPathReplace 替换模式
        this.embyLibraryPath = task.account.embyLibraryPath?.trim() || '';
        this.embyPathReplace  = task.account.embyPathReplace;
        const rawPath = task.realFolderName;
        const convertedPath = this._replacePath(rawPath);
        logTaskEvent('Emby 路径转换完成，开始检索媒体项');
        const item = await this.searchItemsByPathRecursive(convertedPath);
        logTaskEvent(`Emby搜索结果: ${JSON.stringify(item)}`);
        let refreshMode = '';
        if (item) {
            await this.refreshItemById(item.Id);
            refreshMode = '路径命中';
        } else {
            // 目录事件刷新与搜索路径保持同一转换逻辑，避免出现前缀被裁剪的问题。
            const rawDirPath = options.directoryPath || task.realFolderName || convertedPath;
            const convertedDirPath = this._replacePath(rawDirPath);
            const targetDirPath = this._normalizeDirPath(convertedDirPath);
            if (targetDirPath) {
                logTaskEvent(`Emby未命中媒体项，尝试目录事件局部刷新: ${targetDirPath}`);
                const updated = await this.refreshMediaByPaths([targetDirPath]);
                if (updated) {
                    refreshMode = '目录路径事件';
                }
            }

            if (!refreshMode) {
                logTaskEvent(`目录事件局部刷新失败，降级执行全库扫描: ${taskName}`);
                await this.refreshAllLibraries();
                refreshMode = '全库刷新';
            }
        }
        logTaskEvent(`Emby通知完成 | firstExecution=${!!options.firstExecution} | refreshMode=${refreshMode}`);
        return item ? item.Id : null;
    }

    // 1. /emby/Items 根据名称搜索
    async searchItemsByName(name) {
        name = this._cleanMediaName(name);
        const url = `${this.embyUrl}/emby/Items`;
        const params = {
            SearchTerm: name,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: "Name",
        }
        const response = await this.request(url, {
            method: 'GET',
            searchParams: params,
        })
        return response;
    }

    // 2. /emby/Items/{ID}/Refresh 刷新指定ID的剧集/电影
    async refreshItemById(id) {
        const url = `${this.embyUrl}/emby/Items/${id}/Refresh`;
        await this.request(url, {
            method: 'POST',
        })
        return true;
    }

    // 3. 刷新所有库
    async refreshAllLibraries() {
        const url = `${this.embyUrl}/emby/Library/Refresh`;
        await this.request(url, {
            method: 'POST',
        })
        return true;
    }

    /**
     * 使用 Emby 目录路径事件触发局部刷新，避免首次资源直接全库扫描。
     * 兼容不同实现的 payload 形态，主 payload 失败时尝试 fallback。
     * @param {string[]} paths
     * @returns {Promise<boolean>}
     */
    async refreshMediaByPaths(paths = []) {
        const normalizedPaths = [...new Set((paths || [])
            .map(p => this._normalizeDirPath(p))
            .filter(Boolean))];

        if (normalizedPaths.length === 0) {
            return false;
        }

        const url = `${this.embyUrl}/emby/Library/Media/Updated`;
        const primaryPayload = {
            Updates: normalizedPaths.map(path => ({
                Path: path,
                UpdateType: 'Created',
            })),
        };

        const primaryOk = await this._postNoBody(url, primaryPayload);
        if (primaryOk) {
            return true;
        }

        const fallbackPayload = {
            Paths: normalizedPaths,
        };
        return await this._postNoBody(url, fallbackPayload);
    }

    _normalizeDirPath(pathValue) {
        const normalized = String(pathValue || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/g, '')
            .trim();
        if (!normalized) return '';
        return normalized.startsWith('/') ? normalized : `/${normalized}`;
    }

    async _postNoBody(url, json) {
        try {
            const headers = {
                'Authorization': 'MediaBrowser Token="' + this.embyApiKey + '"',
            };
            const response = await got(url, {
                method: 'POST',
                headers,
                json,
                responseType: 'text',
                throwHttpErrors: false,
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                logTaskEvent(`Emby目录事件刷新失败: status=${response.statusCode}, url=${url}`);
                return false;
            }
            return true;
        } catch (error) {
            logTaskEvent(`Emby目录事件刷新异常: ${error.message}`);
            return false;
        }
    }
    // 4. 根据路径搜索 /emby/Items（使用与其他方法统一的 /emby/ 前缀）
    async searchItemsByPath(path) {
        const url = `${this.embyUrl}/emby/Items`;
        const params = {
            Path: path,
            Recursive: true,
        }
        const response = await this.request(url, {
            method: 'GET',
            searchParams: params,
        })
        return response;
    }

    // 传入path, 调用searchItemsByPath, 如果返回结果为空, 则递归调用searchItemsByPath, 直到返回结果不为空
    async searchItemsByPathRecursive(path) {
        try {
            // 防止空路径
            if (!path) return null;
            // 移除路径末尾的斜杠
            const normalizedPath = path.replace(/\/+$/, '');
            // 搜索当前路径
            const result = await this.searchItemsByPath(normalizedPath);
            if (result?.Items?.[0]) {
                logTaskEvent(`在路径 ${normalizedPath} 找到媒体项`);
                return result.Items[0];
            }
            // 获取父路径
            const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
            if (!parentPath) {
                logTaskEvent('已搜索到根路径，未找到媒体项');
                return null;
            }
            // 递归搜索父路径
            logTaskEvent(`在路径 ${parentPath} 继续搜索`);
            return await this.searchItemsByPathRecursive(parentPath);
        } catch (error) {
            logTaskEvent(`路径搜索出错: ${error.message}`);
            return null;
        }
    }

    // 统一请求接口
    async request(url, options) {
        try {
            const headers = {
                'Authorization': 'MediaBrowser Token="' + this.embyApiKey + '"',
            }
            const response = await got(url, {
                method: options.method,
                headers: headers,
                responseType: 'json',
                searchParams: options?.searchParams,
                form: options?.form,
                json: options?.json,
                throwHttpErrors: false // 禁用自动抛出HTTP错误
            });

            if (response.statusCode === 401) {
                logTaskEvent(`Emby认证失败: API Key无效`);
                return null;
            } else if (response.statusCode < 200 || response.statusCode >= 300) {
                logTaskEvent(`Emby接口请求失败: 状态码 ${response.statusCode}`);
                return null;
            }
            return response.body;
        } catch (error) {
            logTaskEvent(`Emby接口请求异常: ${error.message}`);
            return null;
        }
    }

    // 处理媒体名称，去除年份、清晰度等信息
    _cleanMediaName(name) {
        return name
            // 移除括号内的年份，如：沙尘暴 (2025)
            .replace(/\s*[\(\[【］\[]?\d{4}[\)\]】］\]]?\s*/g, '')
            // 移除清晰度标识，如：4K、1080P、720P等
            .replace(/\s*[0-9]+[Kk](?![a-zA-Z])/g, '')
            .replace(/\s*[0-9]+[Pp](?![a-zA-Z])/g, '')
            // 移除其他常见标识，如：HDR、HEVC等
            .replace(/\s*(HDR|HEVC|H265|H264|X265|X264|REMUX)\s*/gi, '')
            // 移除额外的空格
            .trim();
    }
    /**
     * 将 realFolderName 转换为 Emby 可搜索的完整路径
     * 精准模式（推荐）：embyLibraryPath + '/' + realFolderName
     *   适用于 OpenList STRM 和本地 STRM 两种场景，只需填写 Emby 内该账号内容的根路径
     * 兼容模式（旧）：对路径应用 embyPathReplace 替换规则
     *   适用于路径结构差异复杂的边缘场景
     */
    _replacePath(path) {
        path = String(path || '').replace(/\\/g, '/').trim();
        if (this.embyLibraryPath) {
            // 精准模式：若 realFolderName 已包含 embyLibraryPath 前缀（忽略前导斜杠），则不重复拼接
            const libraryPath = String(this.embyLibraryPath).replace(/\\/g, '/').trim();
            const libraryTrimmed = libraryPath.replace(/^\/+|\/+$/g, '');
            const rel = path.replace(/^\/+/, '').replace(/\/+$/g, '');
            if (libraryTrimmed && (rel === libraryTrimmed || rel.startsWith(`${libraryTrimmed}/`))) {
                return ('/' + rel).replace(/\/+$/g, '');
            }
            const prefixed = `${libraryPath.replace(/\/+$/, '')}/${rel}`.replace(/\/+/g, '/');
            return prefixed.replace(/\/+$/g, '');
        }
        // 兼容旧模式：embyPathReplace 规则替换
        if (!path.startsWith('/')) {
            path = '/' + path;
        }
        if (this.embyPathReplace) {
            const pathReplaceArr = this.embyPathReplace.split(';');
            for (let i = 0; i < pathReplaceArr.length; i++) {
                const pathReplace = pathReplaceArr[i].split(':');
                path = path.replace(pathReplace[0], pathReplace[1]);
            }
        }
        // 如果结尾有斜杠, 则移除
        path = path.replace(/\/+$/, '');
        return path;
    }


    /**
     * 处理来自 Emby 的 Webhook 通知
     * @param {object} payload - Webhook 的 JSON 数据
     */
    async handleWebhookNotification(payload) {
        logTaskEvent(`收到 Emby Webhook 通知: ${payload.Event}`);

        // 我们只关心删除事件
        // Emby 原生删除事件: library.deleted library.new(新剧集入库)
        const supportedEvents = ['library.deleted'];

        if (!supportedEvents.includes(payload.Event?.toLowerCase())) {
            // logTaskEvent(`忽略不相关的 Emby 事件: ${payload.Event}`);
            return;
        }

        let itemPath = payload.Item?.Path;
        if (!itemPath) {
            logTaskEvent('Webhook 通知中缺少有效的 Item.Path');
            return;
        }
        const isFolder = payload.Item?.IsFolder;
        const type = payload.Item?.Type;

        logTaskEvent(`检测到删除事件，路径: ${itemPath}, 类型: ${type}, 是否文件夹: ${isFolder}`);

        try {
            // 根据path获取对应的task
            // 1. 首先获取所有embyPathReplacex不为空的account
            const accounts = await this._accountRepo.find({
                where: [
                    { embyPathReplace: Not(IsNull()) }
                ]
            })
            // 2. 遍历accounts, 检查path是否包含embyPathReplace(本地路径) embyPathReplace的内容为: xx(网盘路径):xxx(本地路径)
            const tasks = [];
            for (const account of accounts) {
                let embyPathReplace = account.embyPathReplace.split(':');
                let embyPath = ""
                let cloudPath = embyPathReplace[0]
                if (embyPathReplace.length === 2) {
                    embyPath = embyPathReplace[1]
                }
                // 检查itemPath是否是embyPath开头
                if (itemPath.startsWith(embyPath)) {
                    // 将itemPath中的embyPath替换为cloudPath 并且去掉首尾的/
                    itemPath = itemPath.replace(embyPath, cloudPath).replace(/^\/+|\/+$/g, '');
                    if (!isFolder) {
                        // 剧集, 需要去掉文件名
                        itemPath = path.dirname(itemPath);
                    }
                    const task = await this._taskRepo.findOne({
                        where: {
                            accountId: account.id,
                            realFolderName: Like(`%${itemPath}%`)
                        },
                        relations: {
                            account: true
                        },
                        select: {
                            account: {
                                username: true,
                                password: true,
                                cookies: true,
                                localStrmPrefix: true,
                                cloudStrmPrefix: true,
                                embyPathReplace: true
                            }
                        }
                    })
                    if (task) {
                        tasks.push(task);
                    }   
                }
            }
            if (tasks.length === 0) {
                logTaskEvent(`未找到对应的任务, 路径: ${itemPath}`);
                return;
            }
            logTaskEvent(`找到对应的任务, 任务数量: ${tasks.length}, 任务名称: ${tasks.map(task => task.resourceName).join(', ')}`);
            // 4. 遍历tasks, 删除本地strm, 删除任务和网盘
            for (const task of tasks) {
                if (!isFolder) {
                    // 如果是剧集文件，只删除对应的单个文件
                    logTaskEvent(`删除单个剧集文件, 任务id: ${task.id}, 文件路径: ${itemPath}`);
                    if (!this._isLegacy189RuntimeEnabled()) {
                        logTaskEvent('当前默认运行链路已禁用 189，跳过 legacy189 文件删除逻辑');
                        continue;
                    }
                    const cloud189 = Cloud189Service.getInstance(task.account);
                    const folderInfo = await cloud189.listFiles(task.realFolderId);
                    if (!folderInfo || !folderInfo.fileListAO) {
                        logTaskEvent(`未找到对应的网盘文件列表: 跳过删除`);
                        continue;
                    }
                    const fileList = [...(folderInfo.fileListAO.fileList || [])];
                    const fileName = path.basename(itemPath);
                    const fileNameWithoutExt = path.parse(fileName).name;
                    const targetFile = fileList.find(file => path.parse(file.name).name === fileNameWithoutExt);
                    if (targetFile) {
                        await this._taskService.deleteCloudFile(cloud189, {
                            id: targetFile.id,
                            name: targetFile.name
                        }, false)
                        logTaskEvent(`成功删除文件: ${fileName}`);
                    } else {
                        logTaskEvent(`未找到对应的网盘文件: ${fileName}`);
                    }
                }else{
                    logTaskEvent(`删除任务和网盘, 任务id: ${task.id}`);
                    // 删掉任务并且删掉网盘
                    this._taskService.deleteTasks(tasks.map(task => task.id), true)
                }
            }


        } catch (error) {
            logTaskEvent(`处理 Emby Webhook 时发生错误: ${error.message}`);
            logger.error('处理 Emby Webhook 异常', { error: error.message, stack: error.stack });
        }
    }

}
module.exports = { EmbyService };

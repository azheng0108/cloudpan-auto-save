const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database'); 
const { Task, Account } = require('../entities'); 
const path = require('path');
const logger = require('../utils/logger');

const { Like } = require('typeorm'); 

// emby接口
class EmbyService {
    constructor(taskService) {
        // 使用 emby.enable 布尔字段，避免整个对象存在时永远 truthy 的问题
        this.enable = ConfigService.getConfigValue('emby.enable');
        this.embyUrl = ConfigService.getConfigValue('emby.serverUrl');
        this.embyApiKey = ConfigService.getConfigValue('emby.apiKey');
        this.embyLibraryPath = '';
        this.messageUtil = new MessageUtil();

        this._taskRepo = AppDataSource.getRepository(Task);
        this._accountRepo = AppDataSource.getRepository(Account);
        this._taskService = taskService;
    }

    async notify(task, options = {}) {
        if (!this.enable){
            logTaskEvent(`Emby通知未启用, 请启用后执行`);
            return { status: 'skipped', reason: 'disabled' };
        }
        const taskName = task.resourceName;
        logTaskEvent(`执行Emby通知: ${taskName}`);
        // 单方案：统一使用全局 embyLibraryPath 精准拼接
        this.embyLibraryPath = ConfigService.getConfigValue('emby.libraryPath') || '';

        let item = null;
        let refreshMode = '';

        // 改进3：优先使用缓存的 embyId 直接刷新，跳过搜索
        if (task.embyId) {
            logTaskEvent(`使用缓存 embyId 直接刷新: ${task.embyId}`);
            const cacheRefreshOk = await this.refreshItemById(task.embyId);
            if (cacheRefreshOk) {
                return {
                    status: 'success',
                    itemId: task.embyId,
                    refreshMode: '缓存命中',
                    firstExecution: !!options.firstExecution,
                };
            }
            logTaskEvent(`缓存 embyId 刷新失败，回退到路径/名称搜索: ${task.embyId}`);
        }

        // 路径搜索
        const rawPath = task.realFolderName;
        const convertedPath = this._replacePath(rawPath);
        logTaskEvent('Emby 路径转换完成，开始路径检索媒体项');
        item = await this.searchItemsByPathRecursive(convertedPath);
        logTaskEvent(`Emby路径搜索结果: ${item ? item.Id : '未命中'}`);

        if (item) {
            const refreshed = await this.refreshItemById(item.Id);
            if (refreshed) {
                refreshMode = '路径命中';
            }
            // 改进3：缓存 embyId 到任务记录
            if (task.id) {
                await this._taskRepo.update(task.id, { embyId: String(item.Id) }).catch(e =>
                    logTaskEvent(`缓存 embyId 失败(忽略): ${e.message}`)
                );
            }
        } else {
            // 改进2：名称搜索 fallback（路径搜索失败时，用资源名尝试匹配）
            logTaskEvent(`路径未命中，尝试名称搜索: ${taskName}`);
            const nameSearchResult = await this.searchItemsByName(taskName);
            const nameItem = nameSearchResult?.Items?.find(i => i.IsFolder);
            if (nameItem) {
                logTaskEvent(`名称搜索命中: ${nameItem.Name} (ID: ${nameItem.Id})`);
                const refreshed = await this.refreshItemById(nameItem.Id);
                if (refreshed) {
                    refreshMode = '名称命中';
                }
                item = nameItem;
                // 改进3：缓存 embyId 到任务记录
                if (task.id) {
                    await this._taskRepo.update(task.id, { embyId: String(nameItem.Id) }).catch(e =>
                        logTaskEvent(`缓存 embyId 失败(忽略): ${e.message}`)
                    );
                }
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
                    const fullRefreshOk = await this.refreshAllLibraries();
                    if (fullRefreshOk) {
                        refreshMode = '全库刷新';
                    }
                }
            }
        }
        if (!refreshMode) {
            return {
                status: 'skipped',
                reason: 'refresh-request-failed',
                itemId: item ? item.Id : null,
                firstExecution: !!options.firstExecution,
            };
        }
        return {
            status: 'success',
            itemId: item ? item.Id : null,
            refreshMode,
            firstExecution: !!options.firstExecution,
        };
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
        const ok = await this._postWithQuery(url, {
            Recursive: 'true',
            MetadataRefreshMode: 'FullRefresh',
            ImageRefreshMode: 'FullRefresh',
            ReplaceAllMetadata: 'false',
            ReplaceAllImages: 'false',
        }, `Emby单项刷新请求`);
        if (!ok) {
            logTaskEvent(`Emby单项刷新失败: itemId=${id}`);
            return false;
        }
        logTaskEvent(`Emby单项刷新已提交: itemId=${id}`);
        return true;
    }

    // 3. 刷新所有库
    async refreshAllLibraries() {
        const url = `${this.embyUrl}/emby/Library/Refresh`;
        const ok = await this._postWithQuery(url, {}, 'Emby全库刷新请求');
        if (!ok) {
            logTaskEvent('Emby全库刷新失败');
            return false;
        }
        logTaskEvent('Emby全库刷新已提交');
        return true;
    }

    async _postWithQuery(url, searchParams = {}, logPrefix = 'Emby请求') {
        try {
            const headers = {
                'Authorization': 'MediaBrowser Token="' + this.embyApiKey + '"',
            };
            const response = await got(url, {
            method: 'POST',
                headers,
                searchParams,
                responseType: 'text',
                throwHttpErrors: false,
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                logTaskEvent(`${logPrefix}失败: status=${response.statusCode}, url=${url}`);
                return false;
            }
            return true;
        } catch (error) {
            logTaskEvent(`${logPrefix}异常: ${error.message}`);
            return false;
        }
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
     * 单方案：embyLibraryPath + '/' + realFolderName
     * 适用于 OpenList STRM 和本地 STRM，两种场景都只需填写 Emby 内账号根路径
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
        // 未配置库根路径时，保持原路径，仅做标准化
        return this._normalizeDirPath(path);
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
            // 根据 embyLibraryPath 将 Emby 本地路径映射为任务 realFolderName 的相对路径
            const normalizedItemPath = String(itemPath).replace(/\\/g, '/');
            const accounts = await this._accountRepo.find();
            const tasks = [];
            for (const account of accounts) {
                const libraryPath = String(account.embyLibraryPath || '').replace(/\\/g, '/').replace(/\/+$/g, '').trim();
                if (!libraryPath) {
                    continue;
                }
                const normalizedLibraryPath = libraryPath.startsWith('/') ? libraryPath : `/${libraryPath}`;
                if (!normalizedItemPath.startsWith(normalizedLibraryPath)) {
                    continue;
                }

                let relativePath = normalizedItemPath.substring(normalizedLibraryPath.length).replace(/^\/+|\/+$/g, '');
                if (!relativePath) {
                    continue;
                }
                if (!isFolder) {
                    relativePath = path.dirname(relativePath).replace(/^\/+|\/+$/g, '');
                }
                if (!relativePath || relativePath === '.') {
                    continue;
                }

                const task = await this._taskRepo.findOne({
                    where: {
                        accountId: account.id,
                        realFolderName: Like(`%${relativePath}%`)
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
                            embyLibraryPath: true
                        }
                    }
                });
                if (task) {
                    tasks.push(task);
                }
            }
            if (tasks.length === 0) {
                logTaskEvent(`未找到对应的任务, 路径: ${normalizedItemPath}`);
                return;
            }
            logTaskEvent(`找到对应的任务, 任务数量: ${tasks.length}, 任务名称: ${tasks.map(task => task.resourceName).join(', ')}`);
            // 4. 遍历tasks, 删除本地strm, 删除任务和网盘
            for (const task of tasks) {
                if (!isFolder) {
                    logTaskEvent(`删除单个剧集文件, 任务id: ${task.id}, 文件路径: ${normalizedItemPath}`);
                    // 移动云盘(139)暂不支持单个文件删除，跳过
                    continue;
                } else {
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

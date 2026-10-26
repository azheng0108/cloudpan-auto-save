const got = require('got');
const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const { MessageUtil } = require('./message');
const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');
const { AppDataSource } = require('../database');
const { Task, Account } = require('../entities');
const { Like } = require('typeorm');

class WebhookService {
    constructor() {
        this._outboundNotifyAt = new Map(); // 防抖记录: debounceKey -> timestamp
        this.messageUtil = new MessageUtil();
    }

    /**
     * 生成安全随机 16 字节 Hex Token
     * @returns {string}
     */
    static generateToken() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * 安全校验 Token
     * @param {string} reqToken 
     * @param {string} expectedToken 
     * @returns {boolean}
     */
    static verifyToken(reqToken, expectedToken) {
        if (!expectedToken) return true; // 未设期望值视为无需校验
        if (!reqToken) return false;
        return String(reqToken).trim() === String(expectedToken).trim();
    }

    /**
     * 将 Emby 媒体路径逆向映射为云盘相对路径，并剥离 .strm 后缀
     * @param {string} embyPath 
     * @param {string} mountPrefix 
     * @returns {string} 云盘相对路径
     */
    static mapEmbyPathToCloudPath(embyPath, mountPrefix) {
        if (!embyPath) return '';
        let p = String(embyPath).replace(/\\/g, '/').replace(/\/+/g, '/').trim();
        // 绝对拦截目录穿越漏洞
        if (/(?:^|\/)\.\.(?:\/|$)/.test(p)) {
            return '';
        }
        let mp = String(mountPrefix || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim();

        if (mp) {
            mp = mp.replace(/\/+$/, '');
            if (p.toLowerCase().startsWith(mp.toLowerCase())) {
                p = p.substring(mp.length);
            }
        }
        p = p.replace(/^\/+|\/+$/g, '');
        // 若为 .strm 扩展名，剥离后缀以便匹配真实文件名/目录
        p = p.replace(/\.strm$/i, '');
        return p;
    }

    /**
     * 检查是否命中绝对安全白名单（根目录、受保护系统目录）
     * @param {string} cloudRelPath 
     * @param {string[]} protectedPaths 
     * @returns {boolean}
     */
    static isProtectedPath(cloudRelPath, protectedPaths = ['/', '/媒体库', '/media', '/strm', '/公共目录']) {
        if (!cloudRelPath || cloudRelPath === '.' || cloudRelPath === '/') return true;
        // 绝对拦截目录穿越
        if (/(?:^|\/)\.\.(?:\/|$)/.test(cloudRelPath)) return true;
        const normalized = '/' + cloudRelPath.replace(/^\/+|\/+$/g, '').toLowerCase();
        if (normalized === '/' || normalized === '/.') return true;
        return protectedPaths.some(prot => {
            const normProt = '/' + String(prot).replace(/^\/+|\/+$/g, '').toLowerCase();
            if (normProt === '/') return false;
            return normalized === normProt;
        });
    }

    /**
     * 解析 Emby Webhook 请求体（自适应标准 JSON 与 Multipart 表单内 data 字符串）
     * @param {object|string} body 
     * @returns {object|null}
     */
    static parseEmbyPayload(body) {
        if (!body) return null;
        if (typeof body === 'string') {
            try { return JSON.parse(body); } catch (_) { return null; }
        }
        if (typeof body.data === 'string') {
            try { return JSON.parse(body.data); } catch (_) { return null; }
        }
        return body;
    }

    /**
     * 正向出站 Webhook：转存任务完成后向 SmartStrm / 媒体服派发通知
     * @param {object} task - 任务实体
     * @param {object} options - { savePath, subfolder, files }
     * @returns {Promise<{ status: string, reason?: string, error?: string }>}
     */
    async notifyTransferComplete(task, options = {}) {
        const webhookConfig = ConfigService.getConfigValue('webhook') || {};
        const outboundEnable = webhookConfig.outboundEnable;
        const outboundUrl = webhookConfig.outboundUrl;

        if (!outboundEnable || !outboundUrl) {
            return { status: 'skipped', reason: 'disabled' };
        }

        const savePath = options.savePath || task.realFolderName || '';
        const subfolder = options.subfolder || '';
        const files = Array.isArray(options.files) ? options.files : [];

        // 1. 防抖检查
        const debounceMs = Number(webhookConfig.outboundDebounceMs) || 2000;
        const debounceKey = `${task.accountId || 0}:${savePath}`;
        const now = Date.now();
        const lastAt = this._outboundNotifyAt.get(debounceKey) || 0;
        if (lastAt > 0 && now - lastAt < debounceMs) {
            logTaskEvent(`[Webhook] 出站通知防抖命中，跳过重复通知: key=${debounceKey}, interval=${now - lastAt}ms`);
            return { status: 'skipped', reason: 'debounced' };
        }
        this._outboundNotifyAt.set(debounceKey, now);

        // 2. 根据格式构建 Payload
        const format = webhookConfig.outboundFormat || 'smartstrm';
        let payload;

        if (format === 'universal') {
            payload = {
                event: 'transfer.completed',
                timestamp: now,
                task: {
                    id: task.id,
                    resourceName: task.resourceName || '',
                    savePath,
                    subfolder,
                    accountId: task.accountId,
                },
                fileCount: files.length,
                files: files.map(f => ({
                    name: f.name || f.contentName || '',
                    path: f.path || `${savePath}/${f.name || f.contentName || ''}`.replace(/\/+/g, '/'),
                    size: f.size || f.contentSize || 0,
                    fileId: f.fileId || f.contentId || f.contentID || '',
                }))
            };
        } else {
            // SmartStrm 格式 (默认 cs_strm)
            payload = {
                event: 'cs_strm',
                strmtask: 'auto',
                savepath: savePath,
                taskName: task.resourceName || '',
                taskId: task.id,
                accountId: task.accountId,
                subfolder,
                fileCount: files.length,
                files: files.map(f => ({
                    name: f.name || f.contentName || '',
                    path: f.path || `${savePath}/${f.name || f.contentName || ''}`.replace(/\/+/g, '/'),
                    size: f.size || f.contentSize || 0,
                    fileId: f.fileId || f.contentId || f.contentID || '',
                })),
                timestamp: now
            };
        }

        // 3. 构建 Headers
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Cloud139-AutoSave/2.3.2'
        };
        if (webhookConfig.outboundToken) {
            headers['X-Webhook-Token'] = webhookConfig.outboundToken;
            headers['Authorization'] = `Bearer ${webhookConfig.outboundToken}`;
        }

        // 4. 发送 HTTP POST 请求
        logTaskEvent(`[Webhook] 派发出站通知: URL=${outboundUrl}, task=${task.resourceName}, format=${format}, files=${files.length}`);
        try {
            const response = await got.post(outboundUrl, {
                headers,
                json: payload,
                timeout: 5000,
                responseType: 'text',
                throwHttpErrors: false
            });

            if (response.statusCode >= 200 && response.statusCode < 300) {
                logTaskEvent(`[Webhook] 出站通知成功响应 (HTTP ${response.statusCode})`);
                return { status: 'success', statusCode: response.statusCode };
            } else {
                logTaskEvent(`[Webhook] 出站通知响应非 2xx (HTTP ${response.statusCode})`);
                return { status: 'failed', statusCode: response.statusCode };
            }
        } catch (err) {
            logTaskEvent(`[Webhook] 出站通知请求异常: ${err.message}`);
            logger.warn('[Webhook] 出站通知失败', { error: err.message, url: outboundUrl });
            return { status: 'failed', error: err.message };
        }
    }

    /**
     * 测试出站 Webhook 连通性
     * @param {object} params - { url, token, format }
     * @returns {Promise<{ success: boolean, statusCode?: number, body?: string, error?: string }>}
     */
    async testOutbound({ url, token, format = 'smartstrm' }) {
        if (!url) {
            return { success: false, error: '目标 URL 不能为空' };
        }
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Cloud139-AutoSave/2.3.2'
        };
        if (token) {
            headers['X-Webhook-Token'] = token;
            headers['Authorization'] = `Bearer ${token}`;
        }

        const payload = {
            event: format === 'universal' ? 'test.notification' : 'cs_strm_test',
            message: '139-Auto-Save Webhook 连通性测试',
            timestamp: Date.now()
        };

        try {
            const response = await got.post(url, {
                headers,
                json: payload,
                timeout: 6000,
                responseType: 'text',
                throwHttpErrors: false
            });
            const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
            return {
                success: isSuccess,
                statusCode: response.statusCode,
                body: response.body ? String(response.body).slice(0, 300) : ''
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 反向入站 Webhook：接收 Emby 删除或测试事件，并触发网盘同步清理
     * @param {object} req - Express 请求对象 { query, headers, body }
     * @param {object} deps - { taskService, taskRepo, accountRepo }
     * @returns {Promise<{ statusCode: number, body: object }>}
     */
    async handleInboundEmbyWebhook(req, deps = {}) {
        const webhookConfig = ConfigService.getConfigValue('webhook') || {};
        if (!webhookConfig.inboundEnable) {
            return {
                statusCode: 403,
                body: { success: false, error: '入站 Webhook 未启用' }
            };
        }

        // 1. Token 安全鉴权门禁
        const reqToken = req.query?.token ||
                         req.headers?.['x-emby-token'] ||
                         (req.headers?.authorization?.startsWith('Bearer ')
                             ? req.headers.authorization.slice(7).trim()
                             : null);
        const expectedToken = webhookConfig.inboundToken;

        if (!WebhookService.verifyToken(reqToken, expectedToken)) {
            logger.warn(`[Webhook] 入站请求 Token 鉴权失败: reqToken=${reqToken ? '***' : 'none'}`);
            return {
                statusCode: 401,
                body: { success: false, error: 'Token 鉴权失败' }
            };
        }

        // 2. 解析 Payload
        const payload = WebhookService.parseEmbyPayload(req.body);
        if (!payload || typeof payload !== 'object') {
            return {
                statusCode: 400,
                body: { success: false, error: '无效的 JSON 或数据体' }
            };
        }

        const event = String(payload.Event || payload.event || '').toLowerCase();
        logTaskEvent(`[Webhook] 收到 Emby 入站事件: ${payload.Event || payload.event}`);

        // 3. 处理连通性测试事件
        if (event === 'system.notificationtest') {
            logTaskEvent('[Webhook] 收到来自 Emby 的连通性测试成功通知');
            return {
                statusCode: 200,
                body: {
                    success: true,
                    message: '139-Auto-Save Webhook 连通性测试成功！',
                    receivedEvent: payload.Event
                }
            };
        }

        // 4. 处理媒体删除事件 (library.deleted 或 item.delete)
        const deleteEvents = ['library.deleted', 'item.delete'];
        if (deleteEvents.includes(event)) {
            return await this._handleDeleteSync(payload, webhookConfig, deps);
        }

        // 其他非关注事件忽略
        return {
            statusCode: 200,
            body: { success: true, message: `已忽略未监听事件: ${payload.Event || payload.event}` }
        };
    }

    /**
     * 执行媒体删除同步网盘
     * @private
     */
    async _handleDeleteSync(payload, webhookConfig, deps) {
        const itemPath = payload.Item?.Path;
        if (!itemPath) {
            logTaskEvent('[Webhook] 媒体删除事件中缺少有效的 Item.Path');
            return {
                statusCode: 400,
                body: { success: false, error: '缺少有效的 Item.Path' }
            };
        }

        const isFolder = Boolean(payload.Item?.IsFolder);
        const itemType = payload.Item?.Type || 'Unknown';
        const mountPrefix = webhookConfig.embyMountPrefix || '';
        const cloudRelPath = WebhookService.mapEmbyPathToCloudPath(itemPath, mountPrefix);

        if (!cloudRelPath) {
            logTaskEvent('[Webhook] 媒体删除路径解析后为空或包含危险穿越，拒绝删除');
            return {
                statusCode: 400,
                body: { success: false, error: '无效或受限制的媒体路径' }
            };
        }

        logTaskEvent(`[Webhook] 检测到媒体删除事件: 原始路径=${itemPath}, 逆向相对路径=${cloudRelPath}, 是否目录=${isFolder}, 类型=${itemType}`);

        // 红线安全拦截：保护路径与根目录拦截
        const protectedPaths = webhookConfig.protectedPaths || ['/', '/媒体库', '/media', '/strm', '/公共目录'];
        if (WebhookService.isProtectedPath(cloudRelPath, protectedPaths)) {
            logger.error(`[Webhook-安全熔断] 删除目标命中了受保护白名单，强制拦截: ${cloudRelPath}`);
            logTaskEvent(`[Webhook-安全熔断] 删除目标命中受保护白名单，拒绝删除: ${cloudRelPath}`);
            return {
                statusCode: 403,
                body: { success: false, error: `命中受保护路径白名单，拒绝删除: ${cloudRelPath}` }
            };
        }

        const { taskRepo, accountRepo, taskService } = deps;
        const TaskRepository = taskRepo || AppDataSource.getRepository(Task);
        const AccountRepository = accountRepo || AppDataSource.getRepository(Account);

        try {
            // 搜索关联的任务
            // 使用路径中段或全名匹配任务 realFolderName
            const searchKeyword = isFolder ? cloudRelPath : (cloudRelPath.includes('/') ? cloudRelPath.slice(0, cloudRelPath.lastIndexOf('/')) : cloudRelPath);
            if (!searchKeyword || searchKeyword.trim().length < 2) {
                logTaskEvent(`[Webhook] 搜索关键词过短或无效，避免模糊误删: "${searchKeyword}"`);
                return {
                    statusCode: 200,
                    body: {
                        success: true,
                        message: '搜索关键词过短，跳过任务匹配',
                        path: cloudRelPath,
                        matchedTasks: 0
                    }
                };
            }

            const matchedTasks = await TaskRepository.find({
                where: {
                    realFolderName: Like(`%${searchKeyword}%`)
                },
                relations: {
                    account: true
                }
            });

            logTaskEvent(`[Webhook] 匹配到相关任务数: ${matchedTasks.length}`);

            const syncDeleteCloud = webhookConfig.syncDeleteCloud !== false;
            const syncDeleteTask = webhookConfig.syncDeleteTask !== false;

            if (matchedTasks.length > 0) {
                for (const task of matchedTasks) {
                    if (isFolder) {
                        // 目录删除：整部剧或整部电影删除
                        logTaskEvent(`[Webhook] 同步处理目录删除: taskId=${task.id}, resourceName=${task.resourceName}`);
                        if (taskService) {
                            try {
                                await taskService.deleteTasks([task.id], syncDeleteCloud);
                                logTaskEvent(`[Webhook] 任务已成功删除: taskId=${task.id}, syncDeleteCloud=${syncDeleteCloud}`);
                            } catch (e) {
                                logTaskEvent(`[Webhook] 删除任务异常: ${e.message}`);
                            }
                        }
                    } else {
                        // 单集文件删除
                        logTaskEvent(`[Webhook] 同步处理单集文件删除: taskId=${task.id}, file=${cloudRelPath}`);
                        if (syncDeleteCloud && taskService?.transferredFileRepo) {
                            const fileName = cloudRelPath.includes('/') ? cloudRelPath.split('/').pop() : cloudRelPath;
                            const records = await taskService.transferredFileRepo.find({
                                where: { taskId: task.id }
                            });
                            const matchedRecord = records.find(r => r.fileName && (
                                r.fileName === fileName ||
                                r.fileName.includes(fileName) ||
                                (fileName && fileName.includes(r.fileName))
                            ));
                            if (matchedRecord && matchedRecord.fileId) {
                                const { Cloud139Service } = require('./cloud139');
                                const account = task.account || (await AccountRepository.findOneBy({ id: task.accountId }));
                                if (account) {
                                    const cloud139 = Cloud139Service.getInstance(account);
                                    await cloud139.deleteFiles([matchedRecord.fileId]);
                                    logTaskEvent(`[Webhook] 单集文件已移入 139 回收站: fileId=${matchedRecord.fileId}, name=${matchedRecord.fileName}`);
                                    await taskService.transferredFileRepo.delete({ id: matchedRecord.id });
                                }
                            } else {
                                logTaskEvent(`[Webhook] 未在转存记录中找到该单集 fileId，跳过删除: ${fileName}`);
                            }
                        }
                    }
                }
            } else {
                logTaskEvent(`[Webhook] 未匹配到对应任务记录: path=${cloudRelPath}`);
            }

            // 发送系统通知
            const deleteSummary = `【Emby Webhook 联动】已成功同步删除网盘媒体:\n` +
                                  `• 路径: ${cloudRelPath}\n` +
                                  `• 类型: ${itemType} (${isFolder ? '目录' : '单文件'})\n` +
                                  `• 网盘操作: ${syncDeleteCloud ? '移入 139 网盘回收站' : '保留网盘资产'}\n` +
                                  `• 任务同步: ${syncDeleteTask ? '已同步清除' : '未清除'}`;
            await this.messageUtil.sendMessage(deleteSummary).catch(err => {
                logger.warn(`[Webhook] 推送删除通知失败: ${err.message}`);
            });

            return {
                statusCode: 200,
                body: {
                    success: true,
                    message: '媒体删除同步处理完成',
                    path: cloudRelPath,
                    matchedTasks: matchedTasks.length
                }
            };
        } catch (error) {
            logger.error(`[Webhook] 处理删除同步异常: ${error.message}`, { stack: error.stack });
            logTaskEvent(`[Webhook] 处理删除同步异常: ${error.message}`);
            return {
                statusCode: 500,
                body: { success: false, error: error.message }
            };
        }
    }
}

const webhookServiceInstance = new WebhookService();

module.exports = {
    WebhookService,
    webhookService: webhookServiceInstance
};

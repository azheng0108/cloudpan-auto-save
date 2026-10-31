/**
 * PansouService - 对接 fish2018/pansou 官方高性能网盘搜索 API
 * 
 * 遵从高内聚低耦合 (铁律6) 设计，专注于 HTTP 通信、数据契约校验与 139 移动云盘链接提取
 */

const got = require('got');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const logger = require('../utils/logger');

function cleanTitle(raw) {
    if (!raw || typeof raw !== 'string') return '139移动云盘资源';
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '139移动云盘资源';
    for (const line of lines) {
        if (/^[📜📁🏷🎬📌💡ℹ️\s]*(?:介绍|大小|标签|类型|主演|导演|描述|简介|链接|发布|频道)[：:]/i.test(line)) {
            continue;
        }
        return line.replace(/^[📜📁🏷🎬📌💡ℹ️\s]+/, '').trim();
    }
    return lines[0].replace(/^[📜📁🏷🎬📌💡ℹ️\s]+/, '').trim();
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1024 * 1024 * 1024) {
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    if (bytes >= 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    if (bytes >= 1024) {
        return (bytes / 1024).toFixed(0) + ' KB';
    }
    return bytes + ' B';
}

class PansouService {
    /**
     * 从 PanSou 官方响应数据结构中提取移动云盘候选
     * 支持 'results' 数组与 'merged_by_type' 字典双形态解析
     * 
     * @param {Object} data - PanSou API 返回的 JSON 对象
     * @returns {Array<Object>} 提取出的规范化候选列表
     */
    static extractMobileLinks(data) {
        if (!data || typeof data !== 'object') return [];
        const root = data.data && typeof data.data === 'object' ? data.data : data;
        const candidates = [];

        const isMobileUrl = (u) => {
            if (!u || typeof u !== 'string') return false;
            return /(?:caiyun|yun).139.com/i.test(u) || /139.com/i.test(u);
        };

        // 1. 解析 merged_by_type.mobile (res = 'merge' 或 'all')
        if (root.merged_by_type?.mobile && Array.isArray(root.merged_by_type.mobile)) {
            for (const item of root.merged_by_type.mobile) {
                const url = item.url || item.link;
                if (url && (isMobileUrl(url) || item.type === 'mobile')) {
                    const sizeNum = Number(item.size || 0);
                    candidates.push({
                        title: cleanTitle(item.work_title || item.note || item.title || '139移动云盘资源'),
                        link: url.trim(),
                        url: url.trim(),
                        password: String(item.password || item.pwd || '').trim(),
                        size: sizeNum,
                        sizeFormatted: formatBytes(sizeNum),
                        source: item.source || item.channel || '',
                        datetime: item.datetime || ''
                    });
                }
            }
        }

        // 2. 解析 results[].links[] (res = 'results' 或 'all')
        const resultsList = Array.isArray(root.results) ? root.results : (Array.isArray(root) ? root : []);
        if (resultsList.length > 0) {
            for (const resItem of resultsList) {
                const resTitle = resItem.title || resItem.content || resItem.note || '';
                if (Array.isArray(resItem.links)) {
                    for (const linkObj of resItem.links) {
                        const url = linkObj.url || linkObj.link;
                        const isMobile = linkObj.type === 'mobile' || isMobileUrl(url || '');
                        if (url && isMobile) {
                            const sizeNum = Number(linkObj.size || resItem.size || 0);
                            candidates.push({
                                title: cleanTitle(linkObj.work_title || resTitle || '139移动云盘资源'),
                                link: url.trim(),
                                url: url.trim(),
                                password: String(linkObj.password || linkObj.pwd || resItem.password || '').trim(),
                                size: sizeNum,
                                sizeFormatted: formatBytes(sizeNum),
                                source: resItem.channel || resItem.source || '',
                                datetime: linkObj.datetime || resItem.datetime || ''
                            });
                        }
                    }
                } else if (resItem.url || resItem.link) {
                    const url = resItem.url || resItem.link;
                    if (isMobileUrl(url) || resItem.type === 'mobile') {
                        const sizeNum = Number(resItem.size || 0);
                        candidates.push({
                            title: cleanTitle(resItem.work_title || resTitle || '139移动云盘资源'),
                            link: url.trim(),
                            url: url.trim(),
                            password: String(resItem.password || resItem.pwd || '').trim(),
                            size: sizeNum,
                            sizeFormatted: formatBytes(sizeNum),
                            source: resItem.channel || resItem.source || '',
                            datetime: resItem.datetime || ''
                        });
                    }
                }
            }
        }

        // 链接去重
        const seen = new Set();
        return candidates.filter(item => {
            if (!item.link || seen.has(item.link)) return false;
            seen.add(item.link);
            return true;
        });
    }

    /**
     * 详细检索方法：返回包含状态与错误详情的结构化对象
     * 
     * @param {string} keyword - 搜索关键词
     * @param {Object} [options] - 可选参数 { baseUrl, apiKey, timeout, cloudTypes, refresh }
     * @returns {Promise<{ success: boolean, data: Array<Object>, total: number, baseUrl: string, error?: string }>}
     */
    static async searchDetailed(keyword, options = {}) {
        const rawBaseUrl = options.baseUrl || ConfigService.getConfigValue('pansou.baseUrl') || 'http://127.0.0.1:8888';
        const baseUrl = rawBaseUrl.replace(/\/+$/, '');
        const apiKey = options.apiKey !== undefined ? options.apiKey : (ConfigService.getConfigValue('pansou.apiKey') || '');
        const timeoutMs = Number(options.timeout || ConfigService.getConfigValue('pansou.timeout') || 10000);

        try {
            logTaskEvent(`[PanSou] 发起移动云盘定向检索: "${keyword}" -> ${baseUrl}/api/search`);

            const headers = {
                'Content-Type': 'application/json'
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await got.post(`${baseUrl}/api/search`, {
                json: {
                    kw: keyword,
                    cloud_types: options.cloudTypes || ['mobile'],
                    filter: options.filter || {
                        exclude: ['预告', '花絮', '短剧']
                    },
                    res: options.res || 'results',
                    refresh: Boolean(options.refresh)
                },
                headers,
                responseType: 'json',
                timeout: timeoutMs,
                retry: 1
            });

            const results = this.extractMobileLinks(response.body);
            logTaskEvent(`[PanSou] 检索完成，成功召回 ${results.length} 个移动云盘有效链接`);
            return {
                success: true,
                data: results,
                total: results.length,
                baseUrl
            };
        } catch (error) {
            logTaskEvent(`[PanSou] 搜索接口请求失败: ${error.message}`);
            logger.warn(`[PanSou] 搜索异常: ${error.message}`);
            return {
                success: false,
                data: [],
                total: 0,
                baseUrl,
                error: error.message
            };
        }
    }

    /**
     * 向 PanSou 发起 139 移动云盘资源检索（兼容旧接口签名，失败返回空数组）
     * 
     * @param {string} keyword - 搜索关键词
     * @param {Object} [options] - 可选参数
     * @returns {Promise<Array<Object>>}
     */
    static async search139Resources(keyword, options = {}) {
        const res = await this.searchDetailed(keyword, options);
        return res.data;
    }

    /**
     * 检测盘搜服务连通性
     * 优先采用轻量探针 GET /api/health，若为旧版 PanSou (404) 则优雅降级至 POST /api/search
     * 
     * @param {Object} [options]
     * @returns {Promise<{ connected: boolean, latency: number, message: string }>}
     */
    static async checkHealth(options = {}) {
        const rawBaseUrl = options.baseUrl || ConfigService.getConfigValue('pansou.baseUrl') || 'http://127.0.0.1:8888';
        const baseUrl = rawBaseUrl.replace(/\/+$/, '');
        const apiKey = options.apiKey !== undefined ? options.apiKey : (ConfigService.getConfigValue('pansou.apiKey') || '');
        const timeoutMs = Number(options.timeout || ConfigService.getConfigValue('pansou.timeout') || 10000);
        const startTime = Date.now();

        try {
            const headers = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            // 1. 优先使用官方轻量探针 GET /api/health (耗时百毫秒级，不触发多源检索)
            try {
                const response = await got.get(`${baseUrl}/api/health`, {
                    headers,
                    responseType: 'json',
                    timeout: timeoutMs,
                    retry: 0
                });
                const latency = Date.now() - startTime;
                const body = response.body || {};
                let detail = '';
                if (body.channels_count !== undefined || body.plugin_count !== undefined) {
                    const cCount = body.channels_count ?? (Array.isArray(body.channels) ? body.channels.length : 0);
                    const pCount = body.plugin_count ?? (Array.isArray(body.plugins) ? body.plugins.length : 0);
                    detail = ` (在线频道: ${cCount}, 插件: ${pCount})`;
                }
                return {
                    connected: true,
                    latency,
                    message: `连接成功${detail}，耗时 ${latency}ms`
                };
            } catch (healthErr) {
                // 如果 /api/health 返回 404 (老版本 PanSou 未提供 health 探针)，优雅降级使用 POST /api/search
                if (healthErr.response && healthErr.response.statusCode === 404) {
                    await got.post(`${baseUrl}/api/search`, {
                        json: { kw: 'test', cloud_types: ['mobile'], res: 'results' },
                        headers,
                        responseType: 'json',
                        timeout: timeoutMs,
                        retry: 0
                    });
                    const latency = Date.now() - startTime;
                    return { connected: true, latency, message: `连接成功 (耗时 ${latency}ms)` };
                }
                throw healthErr;
            }
        } catch (error) {
            if (error.response && error.response.statusCode < 500) {
                const latency = Date.now() - startTime;
                return { connected: true, latency, message: `服务在线 (状态码 ${error.response.statusCode}, 耗时 ${latency}ms)` };
            }
            return { connected: false, latency: 0, message: `连接失败: ${error.message}` };
        }
    }
}

module.exports = { PansouService };

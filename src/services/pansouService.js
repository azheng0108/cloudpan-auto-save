/**
 * PansouService - 对接 fish2018/pansou 官方高性能网盘搜索 API
 * 
 * 遵从高内聚低耦合 (铁律6) 设计，专注于 HTTP 通信、数据契约校验与 139 移动云盘链接提取
 */

const got = require('got');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

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
        const candidates = [];

        // 1. 解析 merged_by_type.mobile (res = 'merge' 或 'all')
        if (data.merged_by_type?.mobile && Array.isArray(data.merged_by_type.mobile)) {
            for (const item of data.merged_by_type.mobile) {
                const url = item.url || item.link;
                if (url && (/caiyun\.139\.com/i.test(url) || item.type === 'mobile')) {
                    candidates.push({
                        title: item.note || item.title || item.work_title || '未知资源',
                        link: url.trim(),
                        url: url.trim(),
                        password: String(item.password || item.pwd || '').trim(),
                        size: Number(item.size || 0),
                        source: item.source || '',
                        datetime: item.datetime || ''
                    });
                }
            }
        }

        // 2. 解析 results[].links[] (res = 'results' 或 'all')
        if (data.results && Array.isArray(data.results)) {
            for (const resItem of data.results) {
                const resTitle = resItem.title || resItem.content || '';
                if (Array.isArray(resItem.links)) {
                    for (const linkObj of resItem.links) {
                        const url = linkObj.url || linkObj.link;
                        const isMobile = linkObj.type === 'mobile' || /caiyun\.139\.com/i.test(url || '');
                        if (url && isMobile) {
                            candidates.push({
                                title: linkObj.work_title || resTitle || '未知资源',
                                link: url.trim(),
                                url: url.trim(),
                                password: String(linkObj.password || linkObj.pwd || '').trim(),
                                size: Number(linkObj.size || 0),
                                source: resItem.channel || '',
                                datetime: linkObj.datetime || resItem.datetime || ''
                            });
                        }
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
     * 向 PanSou 发起 139 移动云盘资源检索
     * 
     * @param {string} keyword - 搜索关键词
     * @param {Object} options - 可选参数
     * @returns {Promise<Array<Object>>}
     */
    static async search139Resources(keyword, options = {}) {
        const baseUrl = (ConfigService.getConfigValue('pansou.baseUrl') || 'http://127.0.0.1:8888').replace(/\/+$/, '');
        const apiKey = ConfigService.getConfigValue('pansou.apiKey') || '';
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
                    cloud_types: ['mobile'],
                    filter: {
                        exclude: ['预告', '花絮', '短剧']
                    },
                    res: 'results', // 优先返回包含 work_title 与原始 title 的结构
                    refresh: false
                },
                headers,
                responseType: 'json',
                timeout: timeoutMs,
                retry: 1
            });

            const results = this.extractMobileLinks(response.body);
            logTaskEvent(`[PanSou] 检索完成，成功召回 ${results.length} 个移动云盘有效链接`);
            return results;
        } catch (error) {
            logTaskEvent(`[PanSou] 搜索接口请求失败: ${error.message}`);
            return [];
        }
    }
}

module.exports = { PansouService };

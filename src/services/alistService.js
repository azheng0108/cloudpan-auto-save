const got = require('got');
const ConfigService = require('./ConfigService');

const alistService = {
    Enable() {
        return ConfigService.getConfigValue('alist.enable') && ConfigService.getConfigValue('alist.baseUrl') && ConfigService.getConfigValue('alist.apiKey');
    },
    /**
     * 获取目录列表
     * @param {string} path 目录路径
     * @returns {Promise<Object>} 返回目录列表数据
     */
    async listFiles(path) {
        const baseUrl = await this.getConfig('alist.baseUrl');
        const apiKey = await this.getConfig('alist.apiKey');

        if (!baseUrl) {
            throw new Error('AList baseUrl 未配置');
        }

        if (!apiKey) {
            throw new Error('AList apiKey 未配置');
        }

        try {
            const response = await got.post(`${baseUrl}/api/fs/list`, {
                json: {
                    path: path,
                    page: 1,
                    per_page: 0,
                    refresh: true
                },
                headers: {
                    'Authorization': apiKey
                }
            }).json();

            return response;
        } catch (error) {
            if (error.response) {
                throw new Error(`AList API 错误: ${error.response.statusMessage}`);
            }
            throw error;
        }
    },

    /**
     * 递归访问目录，触发 OpenList STRM 驱动为每个子目录同步生成 .strm 文件。
     * OpenList STRM 驱动在 /api/fs/list 被调用时同步写入当前目录的 .strm 文件，
     * 因此递归完成即代表所有文件已落盘，后续可安全通知 Emby。
     * @param {string} dirPath - OpenList 内的目录路径（STRM 驱动挂载路径下）
     * @returns {Promise<void>}
     */
    async recursiveRefresh(dirPath) {
        try {
            const response = await this.listFiles(dirPath);
            if (!response?.data?.content) return;
            // 仅递归处理子目录，文件已在 listFiles 调用时由 STRM 驱动处理
            const subDirs = response.data.content.filter(f => f.is_dir);
            for (const dir of subDirs) {
                await this.recursiveRefresh(`${dirPath}/${dir.name}`);
            }
        } catch (error) {
            // 单个目录失败不阻断整体流程，记录后继续
            const { logTaskEvent } = require('../utils/logUtils');
            logTaskEvent(`OpenList 目录刷新失败: ${dirPath}, 错误: ${error.message}`);
        }
    },

    /**
     * 从配置服务获取配置
     * @param {string} key 配置键名
     * @returns {Promise<string>} 配置值
     */
    async getConfig(key) {
        // 从本地存储获取配置
        return ConfigService.getConfigValue(key);
    }
};

module.exports = alistService;
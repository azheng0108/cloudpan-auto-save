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
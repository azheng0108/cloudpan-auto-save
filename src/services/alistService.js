const got = require('got');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

const alistService = {
    Enable() {
        return ConfigService.getConfigValue('alist.enable') && ConfigService.getConfigValue('alist.baseUrl') && ConfigService.getConfigValue('alist.apiKey');
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

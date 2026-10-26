const ConfigService = require('../services/ConfigService');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const logger = require('./logger');

class ProxyUtil {
    static createProxyAgent(proxyUrl) {
        if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
            return {};
        }
        const cleanUrl = proxyUrl.trim();
        return {
            http: new HttpProxyAgent(cleanUrl),
            https: new HttpsProxyAgent(cleanUrl)
        };
    }

    static getProxy(service) {
        // TMDB 专属代理优先
        if (service === 'tmdb') {
            const tmdbProxy = ConfigService.getConfigValue('tmdb.proxy');
            if (tmdbProxy && typeof tmdbProxy === 'string' && tmdbProxy.trim()) {
                return tmdbProxy.trim();
            }
        }

        let proxy = null;
        if (!this._checkServiceEnabled(service)) {
            return proxy;
        }
        const proxyConfig = ConfigService.getConfigValue('proxy') || {};
        const { type = 'http', host, port, username, password } = proxyConfig;
        if (host && port) {
            let proxyUrl = `${type}://${host}:${port}`;
            if (username && password) {
                proxyUrl = `${type}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
            }
            proxy = proxyUrl;
        }
        return proxy;
    }
    static getProxyAgent(service) {
        const proxy = this.getProxy(service);
        return !proxy ? {} : this.createProxyAgent(proxy);
    }
    static _checkServiceEnabled(service) {
        const services = ['tmdb', 'cloud139', 'telegram', 'customPush', 'pan123', 'offline', 'ai', 'openai'];
        if (!services.includes(service)) {
            logger.warn(`[ProxyUtil] 未知的服务: ${service}`);
            return false;
        }
        if (service === 'ai' || service === 'openai') {
            return Boolean(ConfigService.getConfigValue('proxy.services.ai') || ConfigService.getConfigValue('proxy.services.openai'));
        }
        return ConfigService.getConfigValue(`proxy.services.${service}`);
    }
}

module.exports = ProxyUtil;
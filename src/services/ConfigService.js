const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
class ConfigService {
  constructor() {
    // 配置文件路径
    this._configPath = path.join(__dirname, '../../data');
    this._configFile = this._configPath + '/config.json';
    this._config = {
      configVersion: 3, // 配置版本号：用于未来迁移管理
        task: {
          taskExpireDays: 3,
          taskCheckCron: '0 19-23 * * *',
          retryTaskCron: '*/10 * * * *',
        cloud139Concurrency: 3,
        maxRetries: 3,        // 最大重试次数
        retryInterval: 300,   // 重试间隔（秒）
        // 媒体文件后缀：视频格式 + 常见压缩包格式（rar/zip/tar/7z 等资源分发时常用压缩包）
        mediaSuffix: '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov;.rar;.zip;.7z;.tar;.gz;.tar.gz;.tar.bz2;.tar.xz',
        enableOnlySaveMedia: false, // 只保存媒体文件
        // 文件夹不存在时重新创建
        enableAutoCreateFolder: false,
      },
      wecom: {
        enable: false,
        webhook: ''
      },
      telegram: {
        enable: false,
        proxyDomain: '',
        botToken: '',
        chatId: '',
        bot: {
          enable: false,
          botToken: '',
          chatId: ''
        }
      },
      wxpusher: {
        enable: false,
        spt: ''
      },
      proxy: {
        host: '',
        port: 0,
        username: '',
        password: '',
        services: {
          telegram: true,
          cloud139: false
        }
      },
      bark: {
        enable: false,
        serverUrl: '', 
        key: ''
      },
      pushplus: {
        enable: false,           // 是否启用推送
        token: '',              // PushPlus token
        topic: '',              // 群组编码，不填仅发送给自己
        channel: 'wechat',      // 发送渠道：wechat/webhook/cp/sms/mail
        webhook: '',            // webhook编码，仅在channel为webhook时需要
        to: ''                  // 好友令牌，用于指定接收消息的用户
    },
      system: {
        username: 'admin',
        password: 'admin',
        baseUrl: '',
        apiKey: '',
        sessionSecret: ''
      },
      cloudSaver: {
        baseUrl: '',
        username: '',
        password: ''
      },
      // Alist/OpenList 连接配置，供 StrmService.generateAll 和追更 STRM 刷新使用
      alist: {
        enable: false,
        baseUrl: '',
        apiKey: '',
        strmMountPath: ''  // OpenList STRM 驱动的虚拟目录挂载前缀（留空表示不启用 STRM 虚拟路径）
      },
      // Emby 媒体库通知配置
      emby: {
        enable: false,
        serverUrl: '',
        apiKey: ''
      },
      // 本地 STRM 文件生成配置
      strm: {
        enable: false,
        localStrmPrefix: '',
        cloudStrmPrefix: ''
      },
      // TMDB 刮削 / NFO 生成配置
      tmdb: {
        tmdbApiKey: '',
        movieRenameFormat: '',
        tvRenameFormat: ''
      },
      customPush: [] // 自定义推送
    };
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(this._configPath)) {
        fs.mkdirSync(this._configPath, { recursive: true });
      }
      if (fs.existsSync(this._configFile)) {
        const data = fs.readFileSync(this._configFile, 'utf8');
        const fileConfig = JSON.parse(data);
        this._config = this._deepMerge(this._config, fileConfig);
        
        // 配置迁移逻辑
        let needSave = false;
        
        // v1 -> v2: 代理配置键名迁移 cloud189 -> cloud139
        if (this._config.proxy?.services?.cloud189 !== undefined) {
          this._config.proxy.services.cloud139 = this._config.proxy.services.cloud189;
          delete this._config.proxy.services.cloud189;
          logger.info('配置迁移：proxy.services.cloud189 已自动迁移为 cloud139');
          needSave = true;
        }
        
        // v2 -> v3: 清理已移除的回收站配置字段
        if (this._config.task?.cleanRecycleCron !== undefined) {
          delete this._config.task.cleanRecycleCron;
          needSave = true;
        }
        if (this._config.task?.enableAutoClearRecycle !== undefined) {
          delete this._config.task.enableAutoClearRecycle;
          needSave = true;
        }
        if (this._config.task?.enableAutoClearFamilyRecycle !== undefined) {
          delete this._config.task.enableAutoClearFamilyRecycle;
          needSave = true;
        }

        // 更新配置版本号
        if (!this._config.configVersion || this._config.configVersion < 3) {
          this._config.configVersion = 3;
          needSave = true;
        }
        
        if (needSave) {
          this._saveConfig();
          logger.info(`配置已升级到 v${this._config.configVersion}`);
        }
      }else {
        this._saveConfig();
      }
    } catch (error) {
      logger.error('系统配置初始化失败', { error: error.message, stack: error.stack });
    }
  }

  // 添加深度合并方法
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }


  _saveConfig() {
    try {
      fs.writeFileSync(this._configFile, JSON.stringify(this._config, null, 2));
    } catch (error) {
      logger.error('系统配置保存失败', { error: error.message, stack: error.stack });
    }
  }

  getOrCreateSessionSecret() {
    const existingSecret = this.getConfigValue('system.sessionSecret');
    if (existingSecret) {
      return existingSecret;
    }
    const sessionSecret = crypto.randomUUID();
    this.setConfigValue('system.sessionSecret', sessionSecret);
    return sessionSecret;
  }

  getConfig() {
    return this._config;
  }

  setConfig(config) {
    this._config = { ...this._config, ...config };
    this._saveConfig();
  }

  getConfigValue(key, defaultValue = null) {
    const keys = key.split('.');
    let value = this._config;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) break;
    }
    return value ?? defaultValue;
  }

  setConfigValue(key, value) {
    const keys = key.split('.');
    let current = this._config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    this._saveConfig();
  }
}

// 导出单例实例
module.exports = new ConfigService();

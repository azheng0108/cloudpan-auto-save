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
          taskExpireDays: 10,
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
          cloud139: false,
          pan123: false,
          ai: false
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
      // Alist/OpenList 连接配置，供 StrmService.generateAll 和追更 STRM 刷新使用
      alist: {
        enable: false,
        baseUrl: '',
        apiKey: '',
        strmMountPath: ''  // OpenList STRM 驱动的虚拟目录挂载前缀（留空表示不启用 STRM 虚拟路径）
      },
      // Emby 媒体库直连通知配置 (配合 OpenList 原生 STRM 或本地 STRM)
      emby: {
        enable: false,
        serverUrl: '',
        apiKey: '',
        libraryPath: '',
        notifyDebounceMs: 2000
      },
      // 媒体服务器与 Webhook 联动配置 (SmartStrm / Emby / 通用)
      webhook: {
        outboundEnable: false,
        outboundUrl: '',
        outboundToken: '',
        outboundFormat: 'smartstrm', // 'smartstrm' | 'universal'
        outboundDebounceMs: 2000,
        inboundEnable: false,
        inboundToken: '', // 若为空，初始化时自动生成 16 字节随机 hex
        embyMountPrefix: '',
        syncDeleteCloud: true,
        syncDeleteTask: true,
        protectedPaths: ['/', '/媒体库', '/media', '/strm', '/公共目录']
      },
      strm: {
        enable: false,
        autoGenerateOnOrganize: true, // 媒体整理入库后自动生成对应的 .strm 文件
        outputDir: '',
        strmBaseUrl: '', // 139 官方 CDN 原生 302 服务根地址
        sourceCatalogs: [],
        videoSuffixes: ['.mp4', '.mkv', '.avi', '.ts', '.iso', '.flv', '.mov', '.wmv', '.rmvb', '.m4v', '.strm', '.mpg', '.mpeg', '.vob', '.m2ts', '.webm', '.3gp'],
        minSizeMB: 0,
        cleanEmptyDirs: true,
        localStrmPrefix: '',
        cloudStrmPrefix: '',
        stripRootTargetDir: true
      },
      // TMDB 刮削 / NFO 生成配置
      tmdb: {
        tmdbApiKey: '',
        apiBaseUrl: 'https://api.themoviedb.org/3',
        proxy: '',
        movieRenameFormat: '',
        tvRenameFormat: ''
      },
      // 云盘影视刮削（识别 + 规范整理）配置：默认全部保守
      scrape: {
        enabled: false,          // 是否开启定时自动整理巡检
        cron: '0 4 * * *',       // 默认每天凌晨4点 (0 4 * * *)
        autoApply: false,        // false=仅生成计划待确认；true=扫描后自动应用高置信条目
        minScore: 280,           // 严格择优的最低得分
        maxOpsPerBatch: 200,     // 单批变更超过该值时必须显式 confirmLarge 才能应用
        includeTaskDirs: false,  // 是否允许刮削追更任务所在目录
        maxDepth: 6,             // 递归扫描的最大目录深度
        rules: []                // 用户配置的源目录与目标目录整理规则
      },
      // 存储维护与违规自愈配置
      maintenance: {
        enableBannedScanCron: false,
        bannedScanCron: '0 3 * * 0',
        autoCleanBanned: false,
        enableSweepEmptyCron: false,
        sweepEmptyCron: '0 4 * * 0',
        enableDedupCron: false,
        dedupCron: '0 5 * * 0',
        autoPruneDedup: false,
        notifyOnMaintenance: true,
      },
      // 盘搜集成配置 (PanSou 官方 API)
      pansou: {
        baseUrl: 'http://127.0.0.1:8888',
        apiKey: '',
        timeout: 10000
      },
      // 资源覆盖与择优策略
      policy: {
        enableReleaseGroupPriority: true,
        releaseGroups: ['HiveWeb', 'ADWeb', 'HHWEB'],
        preferRemux: true,
        preferHighResolution: true,
        preferDolby: true,
        conflictMode: 1
      },
      // Telegram 频道自动监控转存与整理配置 (全局集中控制中心)
      channelMonitor: {
        enabled: true,
        cron: '*/5 * * * *',           // 默认每5分钟轮询一次频道
        channels: [],                  // 集中监控频道池列表 ['https://t.me/xxx', ...]
        defaultTargetFolderId: '/',    // 默认保存目录ID
        defaultTargetFolderName: '/',  // 默认保存目录名称
        dispatchRules: [],             // 二次分流规则组 [{ keyword: '4K', folderId: 'xxx', folderName: '/4K' }]
        whitelistRegex: '',            // 聚合白名单大正则
        blacklistKeywords: [],         // 黑名单标签列表 ['国产剧', '短剧']
        visualCards: [],               // TMDB 可视化监控卡片列表
        stagingFolderId: '',           // 全局默认暂存区ID，为空则自动创建「/暂存区/频道转存」
        stagingFolderName: '/暂存区/频道转存', // 全局默认暂存区名称
        autoOrganize: true,            // 默认转存后自动整理入库
        autoWash: true,                // 默认开启洗版
        minFileSize: 50,               // 小文件过滤阈值 (MB)，低于此大小的文件被跳过并清理
        ignoreKeywords: '',            // 忽略关键词（逗号分隔，如 sample, trailer, 广告）
        ignoreAudiobooks: true,        // 过滤有声书与纯音频（自动拦截广播剧、评书、听书、相声等非影视资源）
        classifyChildren: false,       // 分类策略：添加儿童节目分类
        classifyConcerts: true,        // 分类策略：添加演唱会分类
        classifyRegion: true,          // 分类策略：按地区二次分类 (华语/欧美/日韩)
        classifyYear: false,           // 分类策略：按年份三次分类
        washPriorityOrder: [           // 洗版策略：8 项自定义优先级序列 (分辨率与动态范围绝对优先)
          'videoFormat',
          'dynamicRange',
          'resourceType',
          'releaseGroup',
          'frameRate',
          'colorDepth',
          'audioCodec',
          'fileSize'
        ],
        keepDolbyMultiVersion: false,  // 多版本策略：保留杜比视界+非杜比多版本并存
        notifyOnOrganize: true,        // 整理入库通知
        enableRename: true,            // 启用 TMDB 结构化点分规范重命名
        enableMediaInfo: true,         // 启用媒体流物理探针完善命名
        includeEpisodeTitle: true,     // 启用剧集/分集官方标题注入（关闭时仅保留季集编号如 S01E08）
        linkStrm: false,               // 联动生成 STRM
        notifyOnStrm: false,           // STRM 明细通知
        sweepEmptyFolders: true,       // 整理完成后自底向上修剪暂存区空目录
        excludeNonVideo: false,           // 排除策略：排除非视频文件
        excludeNoChineseSubtitle: false,  // 排除策略：外语片排除无中文字幕文件
        excludeTrailersAndSamples: false, // 排除策略：排除预告片与样品文件
        filterKeywords: '',            // 全局包含关键词（逗号分隔）
        excludeKeywords: '',           // 全局排除关键词（逗号分隔，如：国产剧,韩剧）
        maxPostsPerCheck: 10,          // 每次轮询抓取单频道最新消息数量
        requestTimeout: 10000,         // 抓取请求超时时间(ms)
        maxUnrecognizedRetries: 3,     // 未识别/无法匹配条目最大重试次数，达到后进入冷却
        unrecognizedCooldownHours: 24  // 达到未识别重试上限后的保护冷却时间 (小时)，冷却期内自动整理跳过
      },
      // AI 智能辅助识别与处理配置 (兼容 OpenAI / DeepSeek / 豆包 / Ollama 等标准接口)
      ai: {
        enable: false,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.1,
        maxTokens: 2000,
        mode: 'fallback'               // 'fallback' (智能兜底) | 'always' (全量复核)
      },
      // 媒体硬元数据嗅探探针配置 (139 网盘直链原生 Range 探针引擎)
      mediaProbe: {
        enable: true,
        timeoutMs: 15000,
        maxWindows: 3
      },
      // 入库后处理全局总开关 (包含自动重命名/STRM/NFO/OpenList/Emby/Webhook，默认关闭)
      postProcess: {
        enable: false
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

        // v3 -> v4: 初始化 Webhook 入站随机密钥
        if (!this._config.webhook?.inboundToken) {
          if (!this._config.webhook) this._config.webhook = {};
          this._config.webhook.inboundToken = require('crypto').randomBytes(16).toString('hex');
          needSave = true;
        }

        // v4 -> v5: 清理已废弃的 AList 与 WebDAV 挂载配置
        if (this._config.strm) {
          const obsoleteKeys = ['streamMode', 'alistBaseUrl', 'alistMountPath', 'alistToken', 'webdavBaseUrl', 'webdavUsername', 'webdavPassword'];
          for (const k of obsoleteKeys) {
            if (this._config.strm[k] !== undefined) {
              delete this._config.strm[k];
              needSave = true;
            }
          }
        }

        // 更新配置版本号
        if (!this._config.configVersion || this._config.configVersion < 5) {
          this._config.configVersion = 5;
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
    if (process.env.NODE_ENV === 'test') {
      return;
    }
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
    logger.debug('写入系统配置', {
      sections: Object.keys(config || {}),
      cloudSaver: config?.cloudSaver ? {
        baseUrl: config.cloudSaver.baseUrl || '',
        username: config.cloudSaver.username || '',
        hasPassword: Boolean(config.cloudSaver.password)
      } : undefined,
      alist: config?.alist ? {
        enable: Boolean(config.alist.enable),
        baseUrl: config.alist.baseUrl || '',
        hasApiKey: Boolean(config.alist.apiKey),
        strmMountPath: config.alist.strmMountPath || ''
      } : undefined,
      emby: config?.emby ? {
        enable: Boolean(config.emby.enable),
        serverUrl: config.emby.serverUrl || '',
        hasApiKey: Boolean(config.emby.apiKey),
        libraryPath: config.emby.libraryPath || ''
      } : undefined,
      pansou: config?.pansou ? {
        baseUrl: config.pansou.baseUrl || '',
        hasApiKey: Boolean(config.pansou.apiKey),
        timeout: config.pansou.timeout || 10000
      } : undefined,
    });
    this._config = this._deepMerge(this._config, config);
    this._saveConfig();
  }

  getConfigValue(key, defaultValue = null) {
    let lookupKey = key;
    if (lookupKey === 'openai' && !this._config.openai && this._config.ai) {
      return this._config.ai;
    }
    if (lookupKey === 'ai' && (!this._config.ai || !this._config.ai.enable) && this._config.openai?.enable) {
      return this._config.openai;
    }
    if (lookupKey.startsWith('openai.') && !this._config.openai && this._config.ai) {
      lookupKey = 'ai.' + lookupKey.slice(7);
    } else if (lookupKey.startsWith('ai.') && (!this._config.ai || !this._config.ai.enable) && this._config.openai?.enable) {
      lookupKey = 'openai.' + lookupKey.slice(3);
    }
    const keys = lookupKey.split('.');
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

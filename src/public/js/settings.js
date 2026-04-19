let customPushConfigs = []
let systemCapabilities = null; // 存储系统能力信息
const DEFAULT_MOVIE_FORMAT = `{{title}}{% if year %} ({{year}}){% endif %}/{{title}}{% if year %} ({{year}}){% endif %}{% if part %}-{{part}}{% endif %}{% if videoFormat %} - {{videoFormat}}{% endif %}{% if videoSource %} {{videoSource}}{% endif %}{% if videoCodec %} {{videoCodec}}{% endif %}{% if audioCodec %} {{audioCodec}}{% endif %}{{fileExt}}`;
const DEFAULT_TV_FORMAT = `{{title}}{% if year %} ({{year}}){% endif %}/Season {{season}}/{% if title and title != season_episode %}{{title}} - {% endif %}{{season_episode}}{% if part %}-{{part}}{% endif %}{% if episode %} - 第 {{episode}} 集{% endif %}{{fileExt}}`;

function syncRenameTemplateDefaults(movieValue, tvValue) {
    window._renameFormats = {
        movie: (movieValue || '').trim() || DEFAULT_MOVIE_FORMAT,
        tv: (tvValue || '').trim() || DEFAULT_TV_FORMAT,
    };
}

// 加载系统能力信息
async function loadSystemCapabilities() {
    try {
        const response = await fetch('/api/system/capabilities');
        const data = await response.json();
        if (data.success) {
            systemCapabilities = data.data;
            return systemCapabilities;
        }
    } catch (error) {
        console.error('获取系统能力信息失败:', error);
    }
    return null;
}

// 加载版本信息
async function loadVersionInfo() {
    try {
        const response = await fetch('/api/system/version');
        const data = await response.json();
        if (data.success) {
            document.getElementById('systemVersion').textContent = `v${data.version}`;
        } else {
            document.getElementById('systemVersion').textContent = 'unknown';
        }
    } catch (error) {
        console.error('获取版本信息失败:', error);
        document.getElementById('systemVersion').textContent = 'unknown';
    }
}

async function loadSettings() {
    const alistStrmMountPathInput = document.getElementById('alistStrmMountPath');
    if (alistStrmMountPathInput) {
        // 先清空，避免浏览器自动填充旧值（如 /strm）在接口异常时残留
        alistStrmMountPathInput.value = '';
    }

    // 加载系统能力信息
    await loadSystemCapabilities();
    
    // 加载版本信息
    await loadVersionInfo();
    
    // 清除可能存在的旧加载失败提示
    const existingBanner = document.getElementById('settingsLoadErrorBanner');
    if (existingBanner) existingBanner.remove();

    try {
        const response = await fetch('/api/settings');
        const data = await response.json();
        if (data.success) {
            const settings = data.data;
            // 系统apiKey
            document.getElementById('systemApiKey').value = settings.system?.apiKey || '';
            // 任务设置
            document.getElementById('taskExpireDays').value = settings.task?.taskExpireDays || 3;
            document.getElementById('taskCheckCron').value = settings.task?.taskCheckCron || '0 19-23 * * *';
            document.getElementById('retryTaskCron').value = settings.task?.retryTaskCron || '*/1 * * * *';
            document.getElementById('vacuumCron').value = settings.task?.vacuumCron || '0 4 * * 0';
            document.getElementById('taskMaxRetries').value = settings.task?.maxRetries || 3;
            document.getElementById('taskRetryInterval').value = settings.task?.retryInterval || 300;
            document.getElementById('cloud139Concurrency').value = settings.task?.cloud139Concurrency || 3;
            document.getElementById('mediaSuffix').value = settings.task?.mediaSuffix || '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov';
            document.getElementById('enableOnlySaveMedia').checked = settings.task?.enableOnlySaveMedia || false;
            document.getElementById('enableAutoCreateFolder').checked = settings.task?.enableAutoCreateFolder || false;

            // 企业微信设置
            document.getElementById('enableWecom').checked = settings.wecom?.enable || false;
            document.getElementById('wecomWebhook').value = settings.wecom?.webhook || '';
            
            // Telegram 设置
            document.getElementById('enableTelegram').checked = settings.telegram?.enable || false;
            document.getElementById('proxyDomain').value = settings.telegram?.proxyDomain || '';
            document.getElementById('telegramBotToken').value = settings.telegram?.botToken || '';
            document.getElementById('telegramChatId').value = settings.telegram?.chatId || '';
            
            // WXPusher 设置
            document.getElementById('enableWXPusher').checked = settings.wxpusher?.enable || false;
            document.getElementById('wXPusherSPT').value = settings.wxpusher?.spt || '';
            
            // 代理设置
            document.getElementById('proxyHost').value = settings.proxy?.host || '';
            document.getElementById('proxyPort').value = settings.proxy?.port || '';
            document.getElementById('proxyUsername').value = settings.proxy?.username || '';
            document.getElementById('proxyPassword').value = settings.proxy?.password || '';
            document.getElementById('proxyTelegram').checked = settings.proxy?.services?.telegram || false;
            document.getElementById('proxyCloud139').checked = settings.proxy?.services?.cloud139 || false;
            document.getElementById('proxyCustomPush').checked = settings.proxy?.services?.customPush || false;
            // Bark 设置
            document.getElementById('enableBark').checked = settings.bark?.enable || false;
            document.getElementById('barkServerUrl').value = settings.bark?.serverUrl || '';
            document.getElementById('barkKey').value = settings.bark?.key || '';

            // 账号密码设置
            document.getElementById('systemUserName').value = settings.system?.username || '';
            document.getElementById('systemPassword').value = settings.system?.password || '';
            
            // tg机器人设置
            document.getElementById('enableTgBot').checked = settings.telegram?.bot?.enable || false;
            document.getElementById('tgBotToken').value = settings.telegram?.bot?.botToken || '';
            document.getElementById('tgBotChatId').value = settings.telegram?.bot?.chatId || '';
            // cloudSaver设置
            document.getElementById('cloudSaverUrl').value = settings.cloudSaver?.baseUrl || '';
            document.getElementById('cloudSaverUsername').value = settings.cloudSaver?.username || '';
            document.getElementById('cloudSaverPassword').value = settings.cloudSaver?.password || '';

            // Alist / OpenList 设置
            document.getElementById('alistEnable').checked = settings.alist?.enable || false;
            document.getElementById('alistBaseUrl').value = settings.alist?.baseUrl || '';
            document.getElementById('alistApiKey').value = settings.alist?.apiKey || '';
            document.getElementById('alistStrmMountPath').value = (settings.alist?.strmMountPath || '').trim();

            // Emby 通知设置
            document.getElementById('embyEnable').checked = settings.emby?.enable || false;
            document.getElementById('embyServerUrl').value = settings.emby?.serverUrl || '';
            document.getElementById('embyApiKey').value = settings.emby?.apiKey || '';

            // 本地 STRM 生成
            document.getElementById('strmEnable').checked = settings.strm?.enable || false;
            document.getElementById('strmLocalPrefix').value = settings.strm?.localStrmPrefix || '';
            document.getElementById('strmCloudPrefix').value = settings.strm?.cloudStrmPrefix || '';

            // TMDB / NFO 刮削
            document.getElementById('tmdbApiKey').value = settings.tmdb?.tmdbApiKey || '';
            document.getElementById('tmdbMovieFormat').value = (settings.tmdb?.movieRenameFormat || '').trim() || DEFAULT_MOVIE_FORMAT;
            document.getElementById('tmdbTvFormat').value = (settings.tmdb?.tvRenameFormat || '').trim() || DEFAULT_TV_FORMAT;
            syncRenameTemplateDefaults(
                document.getElementById('tmdbMovieFormat').value,
                document.getElementById('tmdbTvFormat').value
            );

            // pushplus
            document.getElementById('enablePushPlus').checked = settings.pushplus?.enable || false;
            document.getElementById('pushplusToken').value = settings.pushplus?.token || '';
            document.getElementById('pushplusTopic').value = settings.pushplus?.topic || '';
            document.getElementById('pushplusChannel').value = settings.pushplus?.channel || '';
            document.getElementById('pushplusWebhook').value = settings.pushplus?.webhook || '';
            document.getElementById('pushplusTo').value = settings.pushplus?.to || '';

            customPushConfigs = settings.customPush || [];
        } else {
            _showSettingsLoadError('服务器返回错误，设置可能未正确加载');
        }
    } catch (error) {
        console.error('加载设置失败:', error);
        _showSettingsLoadError('设置加载失败，当前显示的值可能不是已保存的配置，请刷新页面重试');
    }
}

function _showSettingsLoadError(msg) {
    const settingsForm = document.getElementById('settingsForm');
    if (!settingsForm) return;
    const banner = document.createElement('div');
    banner.id = 'settingsLoadErrorBanner';
    banner.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;color:#856404;padding:10px 16px;border-radius:6px;margin-bottom:16px;font-size:13px;';
    banner.innerHTML = `⚠️ ${msg}`;
    settingsForm.prepend(banner);
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    saveSettings()
});

async function saveSettings() {
    const alistStrmMountPathInput = document.getElementById('alistStrmMountPath');
    const alistStrmMountPath = (alistStrmMountPathInput.value || '').trim();
    alistStrmMountPathInput.value = alistStrmMountPath;

    const settings = {
        task: {
            taskExpireDays: parseInt(document.getElementById('taskExpireDays').value) || 3,
            taskCheckCron: document.getElementById('taskCheckCron').value || '0 19-23 * * *',
            retryTaskCron: document.getElementById('retryTaskCron').value || '*/1 * * * *',
            vacuumCron: document.getElementById('vacuumCron').value || '0 4 * * 0',
            maxRetries: parseInt(document.getElementById('taskMaxRetries').value) || 3,
            retryInterval: parseInt(document.getElementById('taskRetryInterval').value) || 300,
            cloud139Concurrency: parseInt(document.getElementById('cloud139Concurrency').value) || 3,
            mediaSuffix: document.getElementById('mediaSuffix').value,
            enableOnlySaveMedia: document.getElementById('enableOnlySaveMedia').checked,
            enableAutoCreateFolder: document.getElementById('enableAutoCreateFolder').checked,
        },
        wecom: {
            enable: document.getElementById('enableWecom').checked,
            webhook: document.getElementById('wecomWebhook').value
        },
        telegram: {
            enable: document.getElementById('enableTelegram').checked,
            proxyDomain: document.getElementById('proxyDomain').value,
            botToken: document.getElementById('telegramBotToken').value,
            chatId: document.getElementById('telegramChatId').value,
            bot: {
                enable: document.getElementById('enableTgBot').checked,
                botToken: document.getElementById('tgBotToken').value,
                chatId: document.getElementById('tgBotChatId').value
            }
        },
        wxpusher: {
            enable: document.getElementById('enableWXPusher').checked,
            spt: document.getElementById('wXPusherSPT').value
        },
        proxy: {
            host: document.getElementById('proxyHost').value,
            port: parseInt(document.getElementById('proxyPort').value) || 0,
            username: document.getElementById('proxyUsername').value,
            password: document.getElementById('proxyPassword').value,
            services:{
                telegram: document.getElementById('proxyTelegram').checked,
                cloud139: document.getElementById('proxyCloud139').checked,
                customPush: document.getElementById('proxyCustomPush').checked
            }
        },
        bark: {
            enable: document.getElementById('enableBark').checked,
            serverUrl: document.getElementById('barkServerUrl').value,
            key: document.getElementById('barkKey').value
        },
        system: {
            username: document.getElementById('systemUserName').value,
            password: document.getElementById('systemPassword').value,
            apiKey: document.getElementById('systemApiKey').value
        },
        cloudSaver: {
            baseUrl: document.getElementById('cloudSaverUrl').value,
            username: document.getElementById('cloudSaverUsername').value,
            password: document.getElementById('cloudSaverPassword').value
        },
        alist: {
            enable: document.getElementById('alistEnable').checked,
            baseUrl: document.getElementById('alistBaseUrl').value,
            apiKey: document.getElementById('alistApiKey').value,
            strmMountPath: alistStrmMountPath
        },
        emby: {
            enable: document.getElementById('embyEnable').checked,
            serverUrl: document.getElementById('embyServerUrl').value,
            apiKey: document.getElementById('embyApiKey').value
        },
        strm: {
            enable: document.getElementById('strmEnable').checked,
            localStrmPrefix: document.getElementById('strmLocalPrefix').value,
            cloudStrmPrefix: document.getElementById('strmCloudPrefix').value
        },
        tmdb: {
            tmdbApiKey: document.getElementById('tmdbApiKey').value,
            movieRenameFormat: document.getElementById('tmdbMovieFormat').value,
            tvRenameFormat: document.getElementById('tmdbTvFormat').value
        },
        pushplus: {
            enable: document.getElementById('enablePushPlus').checked,
            token: document.getElementById('pushplusToken').value,
            topic: document.getElementById('pushplusTopic').value,
            channel: document.getElementById('pushplusChannel').value,
            webhook: document.getElementById('pushplusWebhook').value,
            to: document.getElementById('pushplusTo').value
        },
        customPush: customPushConfigs
    };
    // retryInterval不能少于60秒
    if (settings.task.retryInterval < 60) {
        message.warning("任务重试间隔不能小于60秒")
        return 
    }
    if (settings.task.cloud139Concurrency < 1) {
        message.warning('并发上限必须大于等于1');
        return;
    }

    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        if (data.success) {
            syncRenameTemplateDefaults(
                document.getElementById('tmdbMovieFormat').value,
                document.getElementById('tmdbTvFormat').value
            );
            if (data.data?.passwordChanged) {
                message.success('密码已修改，即将退出登录...');
                setTimeout(() => {
                    window.location.href = '/login';
                }, 2000);
            } else {
                message.success('保存成功');
            }
        } else {
            message.warning('保存失败: ' + data.error);
        }
    } catch (error) {
        message.warning('保存失败: ' + error.message);
    }
}

// 在页面加载时初始化设置
document.addEventListener('DOMContentLoaded', loadSettings);

function generateApiKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let apiKey = '';
    for (let i = 0; i < 32; i++) {
        apiKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    document.getElementById('systemApiKey').value = apiKey;
}

/**
 * 保存媒体 Tab 中的服务配置（CloudSaver / Alist / Emby）
 * 复用 POST /api/settings/media 端点，仅提交媒体服务相关字段
 */
async function saveMediaSettings() {
    const alistStrmMountPathInput = document.getElementById('alistStrmMountPath');
    const alistStrmMountPath = (alistStrmMountPathInput.value || '').trim();
    alistStrmMountPathInput.value = alistStrmMountPath;

    const settings = {
        cloudSaver: {
            baseUrl: document.getElementById('cloudSaverUrl').value,
            username: document.getElementById('cloudSaverUsername').value,
            password: document.getElementById('cloudSaverPassword').value
        },
        alist: {
            enable: document.getElementById('alistEnable').checked,
            baseUrl: document.getElementById('alistBaseUrl').value,
            apiKey: document.getElementById('alistApiKey').value,
            strmMountPath: alistStrmMountPath
        },
        emby: {
            enable: document.getElementById('embyEnable').checked,
            serverUrl: document.getElementById('embyServerUrl').value,
            apiKey: document.getElementById('embyApiKey').value
        },
        strm: {
            enable: document.getElementById('strmEnable').checked,
            localStrmPrefix: document.getElementById('strmLocalPrefix').value,
            cloudStrmPrefix: document.getElementById('strmCloudPrefix').value
        },
        tmdb: {
            tmdbApiKey: document.getElementById('tmdbApiKey').value,
            movieRenameFormat: document.getElementById('tmdbMovieFormat').value,
            tvRenameFormat: document.getElementById('tmdbTvFormat').value
        }
    };
    try {
        const response = await fetch('/api/settings/media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        if (data.success) {
            message.success('保存成功');
        } else {
            message.warning('保存失败: ' + data.error);
        }
    } catch (error) {
        message.warning('保存失败: ' + error.message);
    }
}

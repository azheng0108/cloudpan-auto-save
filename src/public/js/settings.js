let customPushConfigs = []
let systemCapabilities = null; // 存储系统能力信息

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

// 更新运行模式显示
function updatePlatformDisplay(capabilities) {
    const platformElement = document.getElementById('systemPlatform');
    if (platformElement && capabilities) {
        platformElement.textContent = capabilities.platform || '移动云盘(139)';
    }
}

// 根据能力控制功能可见性
function applyCapabilityGating(capabilities) {
    if (!capabilities) return;
    
    // 控制回收站设置可见性
    const recycleGroup = document.getElementById('recycleSettingsGroup');
    if (recycleGroup) {
        if (capabilities.features.recycle) {
            recycleGroup.style.display = '';
        } else {
            recycleGroup.style.display = 'none';
        }
    }
}

async function loadSettings() {
    // 加载系统能力信息
    const capabilities = await loadSystemCapabilities();
    
    // 加载版本信息
    await loadVersionInfo();
    
    // 更新运行模式显示
    updatePlatformDisplay(capabilities);
    
    // 应用能力控制
    applyCapabilityGating(capabilities);
    
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
            document.getElementById('cleanRecycleCron').value = settings.task?.cleanRecycleCron || '0 */8 * * *';
            document.getElementById('vacuumCron').value = settings.task?.vacuumCron || '0 4 * * 0';
            document.getElementById('taskMaxRetries').value = settings.task?.maxRetries || 3;
            document.getElementById('taskRetryInterval').value = settings.task?.retryInterval || 300;
            document.getElementById('cloud139Concurrency').value = settings.task?.cloud139Concurrency || 3;
            document.getElementById('mediaSuffix').value = settings.task?.mediaSuffix || '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov';
            document.getElementById('enableOnlySaveMedia').checked = settings.task?.enableOnlySaveMedia || false;
            document.getElementById('enableAutoCreateFolder').checked = settings.task?.enableAutoCreateFolder || false;
            document.getElementById('enableAutoClearRecycle').checked = settings.task?.enableAutoClearRecycle || false;
            document.getElementById('enableAutoClearFamilyRecycle').checked = settings.task?.enableAutoClearFamilyRecycle || false;

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

            // pushplus
            document.getElementById('enablePushPlus').checked = settings.pushplus?.enable || false;
            document.getElementById('pushplusToken').value = settings.pushplus?.token || '';
            document.getElementById('pushplusTopic').value = settings.pushplus?.topic || '';
            document.getElementById('pushplusChannel').value = settings.pushplus?.channel || '';
            document.getElementById('pushplusWebhook').value = settings.pushplus?.webhook || '';
            document.getElementById('pushplusTo').value = settings.pushplus?.to || '';

            customPushConfigs = settings.customPush || [];
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    saveSettings()
});

async function saveSettings() {
    const settings = {
        task: {
            taskExpireDays: parseInt(document.getElementById('taskExpireDays').value) || 3,
            taskCheckCron: document.getElementById('taskCheckCron').value || '0 19-23 * * *',
            retryTaskCron: document.getElementById('retryTaskCron').value || '*/1 * * * *',
            cleanRecycleCron: document.getElementById('cleanRecycleCron').value || '0 */8 * * *',
            vacuumCron: document.getElementById('vacuumCron').value || '0 4 * * 0',
            maxRetries: parseInt(document.getElementById('taskMaxRetries').value) || 3,
            retryInterval: parseInt(document.getElementById('taskRetryInterval').value) || 300,
            cloud139Concurrency: parseInt(document.getElementById('cloud139Concurrency').value) || 3,
            mediaSuffix: document.getElementById('mediaSuffix').value,
            enableOnlySaveMedia: document.getElementById('enableOnlySaveMedia').checked,
            enableAutoCreateFolder: document.getElementById('enableAutoCreateFolder').checked,
            enableAutoClearRecycle: document.getElementById('enableAutoClearRecycle').checked,
            enableAutoClearFamilyRecycle: document.getElementById('enableAutoClearFamilyRecycle').checked
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
            message.success('保存成功');
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

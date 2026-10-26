<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import {
  Globe,
  Bot,
  Send,
  Radio,
  Clock,
  ShieldCheck,
  KeyRound,
  Save,
  Network,
  RefreshCw,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
  Film,
  Info,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import { settingsApi } from '../api/settings';

// 页面加载与状态管理
const isLoading = ref(true);
const isSaving = ref(false);
const isTestingProxy = ref(false);
const isSendingTestMsg = ref(false);
const showBotToken = ref(false);
const isCopiedApiKey = ref(false);
const showProxyDetail = ref(false);
const isTestingTmdb = ref(false);
const tmdbTestResult = ref<{ success: boolean; latency?: number; message?: string } | null>(null);
const showTmdbKey = ref(false);
const showAdvancedTask = ref(false);

// 当前选中的外部推送渠道 Tab ('wecom' | 'bark' | 'wxpusher' | 'pushplus')
const activePushChannel = ref<'wecom' | 'bark' | 'wxpusher' | 'pushplus'>('wecom');

// 原始配置对象（确保不丢失任何其他模块原有数据）
let rawConfig: Record<string, any> = {};

// 代理单地址输入模式（如 http://localhost:7890 或 127.0.0.1:7890）
const proxyQuickUrl = ref('');

// 代理测速结果对象
interface ProxyTestItem {
  service: string;
  status: 'OK' | 'FAIL';
  latency: number;
  remark: string;
}

interface ProxyTestReport {
  mode: 'proxy' | 'direct';
  proxyUrl: string;
  source: string;
  total: number;
  successCount: number;
  avgLatency: number;
  items: ProxyTestItem[];
}

const proxyReport = ref<ProxyTestReport | null>(null);

// 表单响应式状态
const form = reactive({
  // 网络代理
  proxy: {
    type: 'http',
    host: '',
    port: 7890,
    username: '',
    password: '',
    services: {
      telegram: true,
      cloud139: false, // 139 移动云盘为国内服务，始终直连，严禁走海外代理触发风控
      customPush: true,
      tmdb: true,
    },
  },
  // TMDB API 与影视刮削配置
  tmdb: {
    tmdbApiKey: '',
    apiBaseUrl: 'https://api.themoviedb.org/3',
    proxy: '',
  },
  // 主机器人配置
  bot: {
    botToken: '',
    chatId: '',
    enable: true,
  },
  // 频道监控轮询节奏（分钟）
  channelMonitor: {
    pollInterval: 5,
    enabled: true,
  },
  // 任务策略
  task: {
    taskExpireDays: 10,
    cloud139Concurrency: 3,
    maxRetries: 3,
    retryInterval: 300,
    enableAutoCreateFolder: false,
    taskCheckCron: '0 19-23 * * *',
    retryTaskCron: '*/10 * * * *',
    vacuumCron: '0 4 * * 0',
    mediaSuffix: '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov;.rar;.zip;.7z;.tar;.gz;.tar.gz;.tar.bz2;.tar.xz',
    enableOnlySaveMedia: false,
  },
  // 外部推送渠道
  wecom: {
    enable: false,
    webhook: '',
  },
  wxpusher: {
    enable: false,
    spt: '',
  },
  bark: {
    enable: false,
    serverUrl: '',
    key: '',
  },
  pushplus: {
    enable: false,
    token: '',
    topic: '',
    channel: 'wechat',
    webhook: '',
    to: '',
  },
  // 控制台与系统凭据
  system: {
    username: '',
    password: '',
    apiKey: '',
  },
});

// 加载全局配置
async function loadSettings() {
  isLoading.value = true;
  try {
    const data = await settingsApi.getSettings();
    rawConfig = JSON.parse(JSON.stringify(data || {}));

    // 1. 代理回填
    if (data.proxy) {
      form.proxy.type = data.proxy.type || 'http';
      form.proxy.host = data.proxy.host || '';
      form.proxy.port = data.proxy.port || 7890;
      form.proxy.username = data.proxy.username || '';
      form.proxy.password = data.proxy.password || '';

      if (data.proxy.host && data.proxy.port) {
        const proto = data.proxy.type ? `${data.proxy.type}://` : 'http://';
        if (data.proxy.username && data.proxy.password) {
          proxyQuickUrl.value = `${proto}${data.proxy.username}:${data.proxy.password}@${data.proxy.host}:${data.proxy.port}`;
        } else {
          proxyQuickUrl.value = `${proto}${data.proxy.host}:${data.proxy.port}`;
        }
      } else {
        proxyQuickUrl.value = '';
      }

      if (data.proxy.services) {
        form.proxy.services.telegram = data.proxy.services.telegram !== false;
        form.proxy.services.cloud139 = false; // 139 移动云盘为国内运营商服务，保持直连，不走代理
        form.proxy.services.customPush = data.proxy.services.customPush !== false;
        form.proxy.services.tmdb = data.proxy.services.tmdb !== false;
      }
    }

    // 2. Telegram 主机器人回填
    const tg = data.telegram || {};
    const bot = tg.bot || {};
    form.bot.botToken = bot.botToken || tg.botToken || '';
    form.bot.chatId = bot.chatId || tg.chatId || '';
    form.bot.enable = Boolean(form.bot.botToken && form.bot.chatId);

    // 3. 频道监控轮询节奏
    const cm = data.channelMonitor || {};
    form.channelMonitor.pollInterval = cm.pollInterval || 5;
    form.channelMonitor.enabled = cm.enabled !== false;

    // 4. 任务策略
    if (data.task) {
      form.task.taskExpireDays = data.task.taskExpireDays ?? 10;
      form.task.cloud139Concurrency = data.task.cloud139Concurrency ?? 3;
      form.task.maxRetries = data.task.maxRetries ?? 3;
      form.task.retryInterval = data.task.retryInterval ?? 300;
      form.task.enableAutoCreateFolder = Boolean(data.task.enableAutoCreateFolder);
      form.task.taskCheckCron = data.task.taskCheckCron || '0 19-23 * * *';
      form.task.retryTaskCron = data.task.retryTaskCron || '*/10 * * * *';
      form.task.vacuumCron = data.task.vacuumCron || '0 4 * * 0';
      form.task.mediaSuffix = data.task.mediaSuffix || form.task.mediaSuffix;
      form.task.enableOnlySaveMedia = Boolean(data.task.enableOnlySaveMedia);
    }

    // 5. 多渠道推送
    if (data.wecom) {
      form.wecom.webhook = data.wecom.webhook || '';
      form.wecom.enable = Boolean(form.wecom.webhook);
    }
    if (data.wxpusher) {
      form.wxpusher.spt = data.wxpusher.spt || '';
      form.wxpusher.enable = Boolean(form.wxpusher.spt);
    }
    if (data.bark) {
      form.bark.serverUrl = data.bark.serverUrl || '';
      form.bark.key = data.bark.key || '';
      form.bark.enable = Boolean(form.bark.key);
    }
    if (data.pushplus) {
      form.pushplus.token = data.pushplus.token || '';
      form.pushplus.topic = data.pushplus.topic || '';
      form.pushplus.channel = data.pushplus.channel || 'wechat';
      form.pushplus.webhook = data.pushplus.webhook || '';
      form.pushplus.to = data.pushplus.to || '';
      form.pushplus.enable = Boolean(form.pushplus.token);
    }

    // 6. TMDB API 回填
    const tmdbData = data.tmdb || {};
    form.tmdb.tmdbApiKey = tmdbData.tmdbApiKey || '';
    form.tmdb.apiBaseUrl = tmdbData.apiBaseUrl || 'https://api.themoviedb.org/3';
    form.tmdb.proxy = tmdbData.proxy || '';

    // 7. STRM 回填
    // 7. 系统安全与 API
    if (data.system) {
      form.system.username = data.system.username || '';
      form.system.apiKey = data.system.apiKey || '';
      form.system.password = '';
    }
  } catch (err: any) {
    ElMessage.error('加载全局配置失败: ' + (err.message || '网络异常'));
  } finally {
    isLoading.value = false;
  }
}

// 快速输入代理地址时同步分解为主机和端口
function handleQuickProxyInput(val: string) {
  const text = (val || '').trim();
  if (!text) {
    form.proxy.type = 'http';
    form.proxy.host = '';
    form.proxy.port = 7890;
    form.proxy.username = '';
    form.proxy.password = '';
    return;
  }

  try {
    let parseUrl = text;
    if (!parseUrl.startsWith('http://') && !parseUrl.startsWith('https://') && !parseUrl.startsWith('socks5://')) {
      parseUrl = 'http://' + parseUrl;
    }
    const u = new URL(parseUrl);
    form.proxy.type = (u.protocol.replace(':', '') || 'http') as string;
    form.proxy.host = u.hostname || '';
    form.proxy.port = u.port ? Number(u.port) : 7890;
    form.proxy.username = decodeURIComponent(u.username || '');
    form.proxy.password = decodeURIComponent(u.password || '');
  } catch (e) {
    const parts = text.replace(/^(http:\/\/|https:\/\/|socks5:\/\/)/, '').split(':');
    if (parts.length >= 1) form.proxy.host = parts[0];
    if (parts.length >= 2) form.proxy.port = Number(parts[1]) || 7890;
  }
}

// 规范化代理地址（离开焦点时如果只写了 127.0.0.1:7890 则自动加上 http://）
function normalizeQuickProxyUrl() {
  const text = proxyQuickUrl.value.trim();
  if (text && !text.startsWith('http://') && !text.startsWith('https://') && !text.startsWith('socks5://')) {
    proxyQuickUrl.value = `http://${text}`;
  }
}

// 执行测试代理
async function testProxy() {
  isTestingProxy.value = true;
  proxyReport.value = null;
  normalizeQuickProxyUrl();

  try {
    const res = await settingsApi.testProxy(proxyQuickUrl.value);
    if (res && res.items) {
      proxyReport.value = res;
      const isProxy = res.mode === 'proxy';
      const modeText = isProxy ? '代理模式' : '直连模式';

      if (res.successCount === res.total) {
        ElMessage.success(`测试成功（${modeText}）：全部 ${res.total} 项海外服务连通正常，平均延迟 ${res.avgLatency || 0}ms`);
      } else if (res.successCount > 0) {
        showProxyDetail.value = true;
        ElMessage.warning(`部分服务受限（${modeText}）：成功 ${res.successCount}/${res.total}，平均延迟 ${res.avgLatency || 0}ms，部分服务连接超时或失败`);
      } else {
        showProxyDetail.value = true;
        ElMessage.error(`测试失败（${modeText}）：全部 ${res.total} 项海外服务均无法连通 (0/${res.total})，请检查代理地址或端口是否正常运行`);
      }
    } else {
      ElMessage.error('测试代理异常: 后端未返回有效的连通性数据');
    }
  } catch (err: any) {
    ElMessage.error('测试代理异常: ' + (err.message || '连接失败'));
  } finally {
    isTestingProxy.value = false;
  }
}

// 发送 Telegram 测试消息
async function sendTestMessage() {
  if (!form.bot.botToken || !form.bot.chatId) {
    ElMessage.warning('请先填写主机器人 Bot Token 与 TG 用户 ID！');
    return;
  }
  isSendingTestMsg.value = true;
  try {
    normalizeQuickProxyUrl();
    await settingsApi.testTelegram({
      botToken: form.bot.botToken.trim(),
      chatId: form.bot.chatId.trim(),
      proxyUrl: proxyQuickUrl.value.trim(),
    });
    ElMessage.success('测试消息已成功发送至 Telegram！');
  } catch (err: any) {
    ElMessage.error('发送测试消息失败: ' + (err.message || '网络超时或凭据错误'));
  } finally {
    isSendingTestMsg.value = false;
  }
}

// 测试 TMDB 连通性
async function testTmdb() {
  if (!form.tmdb.tmdbApiKey && !form.tmdb.apiBaseUrl) {
    ElMessage.warning('请先输入 TMDB API Key / Token');
    return;
  }
  isTestingTmdb.value = true;
  tmdbTestResult.value = null;
  try {
    const res = await settingsApi.testTmdb({
      apiKey: form.tmdb.tmdbApiKey.trim(),
      apiBaseUrl: form.tmdb.apiBaseUrl.trim(),
      proxy: form.tmdb.proxy.trim(),
    });
    tmdbTestResult.value = {
      success: true,
      latency: res.latency,
      message: res.message || 'TMDB 验证成功',
    };
    ElMessage.success(`TMDB 连通测试成功 (${res.latency || 0}ms)`);
  } catch (err: any) {
    tmdbTestResult.value = {
      success: false,
      message: err.message || '连接失败',
    };
    ElMessage.error(`TMDB 测试失败: ${err.message || '连接失败'}`);
  } finally {
    isTestingTmdb.value = false;
  }
}

// 重新生成 32 位随机 API Key
function generateApiKey() {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  form.system.apiKey = result;
  ElMessage.info('已重新生成 API Key，请点击保存设置以生效！');
}

// 复制 API Key
async function copyApiKey() {
  if (!form.system.apiKey) return;
  try {
    await navigator.clipboard.writeText(form.system.apiKey);
    isCopiedApiKey.value = true;
    ElMessage.success('API Key 已复制到剪贴板！');
    setTimeout(() => {
      isCopiedApiKey.value = false;
    }, 2000);
  } catch (_) {
    ElMessage.warning('复制失败，请手动选取复制');
  }
}

// 保存全局设置
async function handleSave() {
  if (form.task.retryInterval < 60) {
    ElMessage.warning('任务重试间隔不能小于 60 秒！');
    return;
  }
  if (form.task.cloud139Concurrency < 1) {
    ElMessage.warning('139 并发上限必须大于等于 1！');
    return;
  }

  isSaving.value = true;
  normalizeQuickProxyUrl();

  try {
    const payload = {
      ...rawConfig,
      proxy: {
        ...(rawConfig.proxy || {}),
        type: form.proxy.type || 'http',
        host: form.proxy.host.trim(),
        port: form.proxy.host.trim() ? (Number(form.proxy.port) || 0) : 0,
        username: form.proxy.username.trim(),
        password: form.proxy.password.trim(),
        services: {
          telegram: form.proxy.services.telegram !== false,
          cloud139: false, // 139 移动云盘必须直连，不走代理
          customPush: form.proxy.services.customPush !== false,
          tmdb: form.proxy.services.tmdb !== false,
        },
      },
      tmdb: {
        ...(rawConfig.tmdb || {}),
        tmdbApiKey: form.tmdb.tmdbApiKey.trim(),
        apiBaseUrl: form.tmdb.apiBaseUrl.trim() || 'https://api.themoviedb.org/3',
        proxy: form.tmdb.proxy.trim(),
      },
      strm: rawConfig.strm || {},
      emby: rawConfig.emby || {},
      webhook: rawConfig.webhook || {},
      telegram: {
        ...(rawConfig.telegram || {}),
        botToken: form.bot.botToken.trim(),
        chatId: form.bot.chatId.trim(),
        enable: Boolean(form.bot.botToken.trim() && form.bot.chatId.trim()),
        bot: {
          botToken: form.bot.botToken.trim(),
          chatId: form.bot.chatId.trim(),
          enable: Boolean(form.bot.botToken.trim() && form.bot.chatId.trim()),
        },
      },
      channelMonitor: rawConfig.channelMonitor || {},
      task: {
        ...(rawConfig.task || {}),
        taskExpireDays: Number(form.task.taskExpireDays) || 10,
        cloud139Concurrency: Number(form.task.cloud139Concurrency) || 3,
        maxRetries: Number(form.task.maxRetries) || 3,
        retryInterval: Number(form.task.retryInterval) || 300,
        enableAutoCreateFolder: form.task.enableAutoCreateFolder,
        taskCheckCron: form.task.taskCheckCron?.trim() || rawConfig.task?.taskCheckCron || '0 19-23 * * *',
        retryTaskCron: form.task.retryTaskCron?.trim() || rawConfig.task?.retryTaskCron || '*/10 * * * *',
        vacuumCron: form.task.vacuumCron?.trim() || rawConfig.task?.vacuumCron || '0 4 * * 0',
        mediaSuffix: form.task.mediaSuffix.trim(),
        enableOnlySaveMedia: form.task.enableOnlySaveMedia,
      },
      wecom: {
        enable: Boolean(form.wecom.webhook.trim()),
        webhook: form.wecom.webhook.trim(),
      },
      wxpusher: {
        enable: Boolean(form.wxpusher.spt.trim()),
        spt: form.wxpusher.spt.trim(),
      },
      bark: {
        enable: Boolean(form.bark.key.trim()),
        serverUrl: form.bark.serverUrl.trim(),
        key: form.bark.key.trim(),
      },
      pushplus: {
        enable: Boolean(form.pushplus.token.trim()),
        token: form.pushplus.token.trim(),
        topic: form.pushplus.topic.trim(),
        channel: form.pushplus.channel,
        webhook: form.pushplus.webhook.trim(),
        to: form.pushplus.to.trim(),
      },
      system: {
        ...(rawConfig.system || {}),
        username: form.system.username.trim(),
        password: form.system.password.trim(),
        apiKey: form.system.apiKey.trim(),
      },
    };

    const res: any = await settingsApi.saveSettings(payload);
    rawConfig = payload;

    if (res?.passwordChanged) {
      ElMessage.success('管理员密码已变更，系统会话已注销，即将跳转至登录页面...');
      setTimeout(() => {
        window.location.href = '/login';
      }, 1500);
    } else {
      ElMessage.success('全局设置保存成功，已即时生效！');
    }
  } catch (err: any) {
    ElMessage.error('保存全局设置失败: ' + (err.message || '未知异常'));
  } finally {
    isSaving.value = false;
  }
}

// 监听 Header 顶部保存按钮
function onHeaderSaveClick() {
  handleSave();
}

onMounted(() => {
  loadSettings();
  window.addEventListener('header-save-click', onHeaderSaveClick);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSaveClick);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- ================= 模块 1: 网络与代理设置 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
          <Globe class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">网络与代理</h3>
        </div>
      </div>

      <!-- 模块 1 统一文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span>网络与代理说明</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>适用范围</strong>：仅用于加速海外网络请求，包括 Telegram 机器人通知推送、TG 频道消息轮询监听以及 TMDB 影视海报信息刮削。</li>
          <li>• <strong>小白填写建议</strong>：
            <span class="text-slate-800 dark:text-slate-200 font-medium">海外服务器或 VPS 直接留空即可直连</span>；若在境内家庭 NAS 或本地电脑无法连接海外，请填入本地代理地址（如 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">http://127.0.0.1:7890</code> 或 socks5 代理），填好后可点击下方“测试连通性”验证。
          </li>
        </ul>
      </div>

      <!-- 单地址快捷输入 -->
      <div class="space-y-3">
        <div>
          <label for="proxyQuickUrl" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            代理服务器地址
          </label>
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="proxyQuickUrl"
              v-model="proxyQuickUrl"
              type="text"
              placeholder="例如: http://127.0.0.1:7890 或留空直连"
              class="input-base font-mono text-xs flex-1 w-full"
              @input="handleQuickProxyInput(($event.target as HTMLInputElement).value)"
              @blur="normalizeQuickProxyUrl"
            />
            <button
              type="button"
              class="btn-default text-xs h-[38px] px-4 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
              :disabled="isTestingProxy"
              @click="testProxy"
            >
              <RefreshCw v-if="isTestingProxy" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 animate-spin" />
              <Network v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>{{ isTestingProxy ? '测试中...' : '测试连通性' }}</span>
            </button>
          </div>
        </div>

        <!-- 连通性测试报告横条 -->
        <div
          v-if="proxyReport"
          class="p-3 rounded-xl border text-xs space-y-2 transition-colors"
          :class="{
            'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20': proxyReport.successCount === proxyReport.total,
            'border-amber-200 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20': proxyReport.successCount > 0 && proxyReport.successCount < proxyReport.total,
            'border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/20': proxyReport.successCount === 0
          }"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full"
                :class="{
                  'bg-emerald-500': proxyReport.successCount === proxyReport.total,
                  'bg-amber-500': proxyReport.successCount > 0 && proxyReport.successCount < proxyReport.total,
                  'bg-red-500 animate-pulse': proxyReport.successCount === 0
                }"
              />
              <span
                class="font-semibold"
                :class="{
                  'text-emerald-700 dark:text-emerald-400': proxyReport.successCount === proxyReport.total,
                  'text-amber-700 dark:text-amber-400': proxyReport.successCount > 0 && proxyReport.successCount < proxyReport.total,
                  'text-red-700 dark:text-red-400': proxyReport.successCount === 0
                }"
              >
                {{
                  proxyReport.successCount === proxyReport.total
                    ? (proxyReport.mode === 'proxy' ? '代理连通正常 (已生效)' : '直连访问正常')
                    : proxyReport.successCount > 0
                      ? (proxyReport.mode === 'proxy' ? '代理部分连通' : '直连部分连通')
                      : (proxyReport.mode === 'proxy' ? '代理连接失败 (无法连通)' : '直连失败 (无法访问海外服务)')
                }}
              </span>
              <span class="text-gray-400">|</span>
              <span class="text-gray-600 dark:text-gray-300 font-mono">
                <template v-if="proxyReport.successCount === 0">
                  通过 0/{{ proxyReport.total }}，所有目标均不可达
                </template>
                <template v-else>
                  通过 {{ proxyReport.successCount }}/{{ proxyReport.total }}，平均延迟 {{ proxyReport.avgLatency || '-' }}ms
                </template>
              </span>
            </div>
            <button
              type="button"
              class="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 text-xs font-medium cursor-pointer"
              @click="showProxyDetail = !showProxyDetail"
            >
              {{ showProxyDetail ? '收起测速详情' : '展开测速明细' }}
            </button>
          </div>

          <!-- 9大服务测速明细折叠表格 -->
          <div v-if="showProxyDetail" class="pt-2 border-t border-gray-200/80 dark:border-gray-700 overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="text-gray-400 font-medium border-b border-gray-200/60 dark:border-gray-700">
                  <th class="py-1 px-2">服务域名</th>
                  <th class="py-1 px-2">状态</th>
                  <th class="py-1 px-2">响应延迟</th>
                  <th class="py-1 px-2">备注</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800 font-mono">
                <tr v-for="item in proxyReport.items" :key="item.service" class="hover:bg-white/60 dark:hover:bg-gray-700/50">
                  <td class="py-1.5 px-2 font-sans text-gray-800 dark:text-gray-200">{{ item.service }}</td>
                  <td class="py-1.5 px-2">
                    <span :class="item.status === 'OK' ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-red-500 dark:text-red-400 font-semibold'">
                      {{ item.status }}
                    </span>
                  </td>
                  <td class="py-1.5 px-2 text-gray-600 dark:text-gray-300">{{ item.latency }}ms</td>
                  <td class="py-1.5 px-2 font-sans" :class="item.status === 'OK' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
                    {{ item.remark }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 模块 2: TMDB API 与影视刮削 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
          <Film class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">TMDB API 与影视刮削</h3>
        </div>
      </div>

      <!-- 文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
          <span>TMDB API 刮削与代理说明</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>影视整理门禁要求</strong>：系统执行「自动定时整理」或「立即执行整理」前，必须先在此完成 TMDB API 配置，保障影视作品规范识别与准确归档。</li>
          <li>• <strong>凭证支持</strong>：支持 TMDB v3 32 位 API Key 以及 v4 Read Access Token (以 eyJhbGciOi 开头的长 Token)。</li>
          <li>• <strong>自定义反代与独立代理</strong>：支持自定义 API 域名（如自建 Cloudflare Worker 反代加速），并支持为 TMDB 单独指定代理地址，亦可直接复用上方全局网络代理。</li>
        </ul>
      </div>

      <!-- 表单字段 -->
      <div class="space-y-4">
        <!-- TMDB API Key -->
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            TMDB API 密钥 (API Key / Read Access Token) <span class="text-red-500">*</span>
          </label>
          <div class="relative">
            <input
              v-model="form.tmdb.tmdbApiKey"
              :type="showTmdbKey ? 'text' : 'password'"
              placeholder="例如: 32位 API Key 或 eyJhbGciOi... Read Access Token"
              class="input-base font-mono text-xs pr-10 w-full"
            />
            <button
              type="button"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              @click="showTmdbKey = !showTmdbKey"
            >
              <EyeOff v-if="showTmdbKey" class="w-4 h-4" />
              <Eye v-else class="w-4 h-4" />
            </button>
          </div>
          <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
            可在 <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" class="text-purple-600 dark:text-purple-400 underline">themoviedb.org</a> 免费申请 API Key 或 Token
          </p>
        </div>

        <!-- 自定义 API 反代地址 -->
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            自定义 TMDB API 反代地址 (可选)
          </label>
          <input
            v-model="form.tmdb.apiBaseUrl"
            type="text"
            placeholder="默认: https://api.themoviedb.org/3 （国内加速反代可填如: https://api.tmdb.org/3 或自建反代域名）"
            class="input-base font-mono text-xs w-full"
          />
          <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
            国内直连受限时可填写自建反代或镜像 API 端点（默认 <code class="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">https://api.themoviedb.org/3</code>）
          </p>
        </div>

        <!-- TMDB 专属代理 -->
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            TMDB 独立网络代理 (可选，留空则继承全局代理)
          </label>
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              v-model="form.tmdb.proxy"
              type="text"
              placeholder="例如: http://127.0.0.1:7890 （留空则跟随全局代理）"
              class="input-base font-mono text-xs flex-1 w-full"
            />
            <button
              type="button"
              class="btn-default text-xs h-[38px] px-4 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
              :disabled="isTestingTmdb"
              @click="testTmdb"
            >
              <RefreshCw v-if="isTestingTmdb" class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 animate-spin" />
              <Film v-else class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
              <span>{{ isTestingTmdb ? '测试中...' : '测试 TMDB 连通性' }}</span>
            </button>
          </div>
          <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
            如需为 TMDB 单独设置代理可填此处；留空且上方全局网络代理开启时将自动走全局代理
          </p>
        </div>

        <!-- 测试结果提示条 -->
        <div
          v-if="tmdbTestResult"
          class="p-2.5 rounded-lg border text-xs flex items-center gap-2"
          :class="tmdbTestResult.success ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300' : 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 text-red-700 dark:text-red-300'"
        >
          <CheckCircle2 v-if="tmdbTestResult.success" class="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <XCircle v-else class="w-4 h-4 shrink-0 text-red-600 dark:text-red-400" />
          <span>{{ tmdbTestResult.message }}</span>
        </div>
      </div>
    </div>

    <!-- ================= 模块 2: Telegram 机器人 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
          <Bot class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">Telegram 机器人</h3>
        </div>
      </div>

      <!-- 模块 2 统一文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <span>Telegram 配置与使用指引</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>Bot Token 获取方法</strong>：在 Telegram 中搜索并私聊 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">@BotFather</code>，发送 <code class="bg-white dark:bg-slate-900 px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">/newbot</code> 根据提示设置名称后，即可获取形如 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">123456789:ABCdef...</code> 的 Token 字符串。</li>
          <li>• <strong>管理员 Chat ID 获取方法</strong>：在 Telegram 中搜索并私聊 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">@userinfobot</code>，发送任意消息，它会回复你的专属数字 ID（如 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">987654321</code>），请将纯数字填入右侧输入框。</li>
          <li>• <strong>连通性验证</strong>：两项填好后，点击右侧“发送测试”，若您的 Telegram 账号收到测试消息即表示配置成功。</li>
        </ul>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Bot Token -->
        <div>
          <label for="botToken" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            Bot Token
          </label>
          <div class="relative">
            <input
              id="botToken"
              v-model="form.bot.botToken"
              :type="showBotToken ? 'text' : 'password'"
              placeholder="由 @BotFather 生成的 Token，留空则关闭"
              class="input-base text-xs font-mono pr-10"
            />
            <button
              type="button"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer p-1"
              @click="showBotToken = !showBotToken"
            >
              <EyeOff v-if="showBotToken" class="w-4 h-4" />
              <Eye v-else class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- 管理员 Chat ID -->
        <div>
          <label for="chatId" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            管理员 Chat ID (纯数字)
          </label>
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="chatId"
              v-model="form.bot.chatId"
              type="text"
              placeholder="向 @userinfobot 获取的纯数字 ID"
              class="input-base text-xs font-mono flex-1 w-full"
            />
            <button
              type="button"
              class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
              :disabled="isSendingTestMsg || !form.bot.botToken || !form.bot.chatId"
              @click="sendTestMessage"
            >
              <RefreshCw v-if="isSendingTestMsg" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 animate-spin" />
              <Send v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>{{ isSendingTestMsg ? '发送中...' : '发送测试' }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 模块 3: 高级转存策略（并发与容灾，默认折叠） ================= -->
    <div class="settings-card">
      <div
        class="flex items-start sm:items-center justify-between gap-3 cursor-pointer select-none"
        @click="showAdvancedTask = !showAdvancedTask"
      >
        <div class="flex items-start sm:items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 mt-0.5 sm:mt-0">
            <SlidersHorizontal class="w-5 h-5" />
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">高级转存策略（并发与容灾）</h3>
              <span class="px-2 py-0.5 text-[11px] rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                默认推荐参数
              </span>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2 sm:line-clamp-none">
              并发上限 {{ form.task.cloud139Concurrency }} 线程 · 失败重试 {{ form.task.maxRetries }} 次 · 冷却 {{ form.task.retryInterval }} 秒 · 过期 {{ form.task.taskExpireDays }} 天 · 容灾自动重建{{ form.task.enableAutoCreateFolder ? '开启' : '关闭' }}
            </p>
          </div>
        </div>
        <button
          type="button"
          class="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer shrink-0 pt-1 sm:pt-0"
        >
          <span class="hidden xs:inline sm:inline">{{ showAdvancedTask ? '收起配置' : '展开微调' }}</span>
          <ChevronUp v-if="showAdvancedTask" class="w-4 h-4" />
          <ChevronDown v-else class="w-4 h-4" />
        </button>
      </div>

      <div v-show="showAdvancedTask" class="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800 space-y-4">
        <!-- 统一文字说明区 -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>转存任务策略说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>任务过期天数（默认 10 天）</strong>：当追更任务连续指定天数未检测到新资源更新时，自动标记为“已完成”，停止轮询（适配周更剧集）。</li>
            <li>• <strong>最大重试次数（默认 3 次）与冷却间隔（默认 300 秒）</strong>：网络抖动或临时异常时等待冷却后自动重试。</li>
            <li>• <strong>139 并发上限（推荐 3）</strong>：控制同时向移动云盘发起转存和校验的最大请求线程数，切勿调高以防触发移动云盘账号风控。</li>
            <li>• <strong>目标目录容灾自动重建</strong>：如果在转存过程中检测到云端目标文件夹被意外手动删除，自动补建同名目录。</li>
          </ul>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label for="taskExpireDays" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              任务过期天数 (天，默认 10 天)
            </label>
            <input
              id="taskExpireDays"
              v-model.number="form.task.taskExpireDays"
              type="number"
              min="1"
              placeholder="默认 10 天"
              class="input-base text-xs font-mono"
            />
          </div>

          <div>
            <label for="maxRetries" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              最大重试次数 (次，默认 3 次)
            </label>
            <input
              id="maxRetries"
              v-model.number="form.task.maxRetries"
              type="number"
              min="0"
              placeholder="默认 3 次"
              class="input-base text-xs font-mono"
            />
          </div>

          <div>
            <label for="retryInterval" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              重试冷却间隔 (秒，默认 300 秒)
            </label>
            <input
              id="retryInterval"
              v-model.number="form.task.retryInterval"
              type="number"
              min="60"
              placeholder="默认 300 秒"
              class="input-base text-xs font-mono"
            />
          </div>

          <div>
            <label for="cloud139Concurrency" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              139 并发上限 (线程数，推荐 3)
            </label>
            <input
              id="cloud139Concurrency"
              v-model.number="form.task.cloud139Concurrency"
              type="number"
              min="1"
              placeholder="推荐 3"
              class="input-base text-xs font-mono"
            />
          </div>
        </div>

        <!-- 目录容灾策略开关 -->
        <div class="pt-2 border-t border-gray-100 dark:border-gray-800">
          <div class="flex items-center justify-between p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50">
            <div>
              <span class="text-xs font-bold text-gray-800 dark:text-gray-100">目标目录容灾自动重建</span>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                云端目标文件夹被意外手动删除时自动补建，保障转存流程不中断（新建任务默认均会自动创建对应目录）
              </p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="form.task.enableAutoCreateFolder"
              class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
              :class="form.task.enableAutoCreateFolder ? 'bg-amber-600' : 'bg-gray-300 dark:bg-gray-600'"
              @click="form.task.enableAutoCreateFolder = !form.task.enableAutoCreateFolder"
            >
              <span
                class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out"
                :class="form.task.enableAutoCreateFolder ? 'translate-x-5' : 'translate-x-0'"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 模块 5: 媒体筛选 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
          <Film class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">媒体筛选</h3>
        </div>
      </div>

      <!-- 模块 5 统一文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
          <span>媒体过滤与白名单规则</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>媒体文件后缀白名单</strong>：填写允许自动转存的文件扩展名，多个后缀之间用英文半角分号 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">;</code> 分隔。默认已预设主流视频格式（.mkv/.mp4/.ts/.iso 等）及常用分卷压缩包格式（.rar/.zip/.7z 等）。</li>
          <li>• <strong>仅转存匹配后缀的媒体文件</strong>：<br />
            - <strong>开启时（强烈推荐）</strong>：系统会自动过滤并丢弃分享链接中夹带的宣传 txt 广告、说明 nfo、缩略图等无关杂项文件，仅转存正片视频，避免云盘被垃圾文件占满。<br />
            - <strong>关闭时</strong>：分享链接内的所有文件将无差别全量转存到您的网盘目录。
          </li>
        </ul>
      </div>

      <div class="space-y-4">
        <div>
          <label for="mediaSuffix" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            媒体文件后缀白名单 (英文半角分号 ; 分隔)
          </label>
          <input
            id="mediaSuffix"
            v-model="form.task.mediaSuffix"
            type="text"
            placeholder="例如: .mkv;.iso;.mp4;.ts"
            class="input-base text-xs font-mono"
          />
        </div>

        <!-- 仅转存媒体文件过滤规则 -->
        <div class="pt-2 border-t border-gray-100 dark:border-gray-800">
          <div class="flex items-center justify-between p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50">
            <div>
              <span class="text-xs font-bold text-gray-800 dark:text-gray-100">仅转存匹配后缀的媒体文件</span>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                开启后自动过滤 txt 广告、nfo 文本等无关文件；关闭则全量转存分享中的所有文件
              </p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="form.task.enableOnlySaveMedia"
              class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
              :class="form.task.enableOnlySaveMedia ? 'bg-teal-600' : 'bg-gray-300 dark:bg-gray-600'"
              @click="form.task.enableOnlySaveMedia = !form.task.enableOnlySaveMedia"
            >
              <span
                class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out"
                :class="form.task.enableOnlySaveMedia ? 'translate-x-5' : 'translate-x-0'"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 模块 6: 外部推送渠道 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
          <Send class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">外部推送渠道</h3>
        </div>
      </div>

      <!-- 模块 6 统一文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
          <span>外部推送配置与获取指引</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>多渠道并行与免开关设计</strong>：除 Telegram 之外，本系统还支持将任务完成与告警信息同步推送到企业微信、iOS Bark、WXPusher 或 PushPlus。<strong>填入对应渠道的凭据并保存即代表启用该渠道；留空保存即代表停用</strong>，无需繁琐开关。</li>
          <li>• <strong>企业微信群机器人</strong>：在企业微信电脑端群聊窗口右上角，点击「添加群机器人」，将生成的完整 Webhook 链接直接粘贴填入即可。</li>
          <li>• <strong>Bark (iOS 推送)</strong>：在 iPhone 上安装 Bark App，打开首页复制专属的 Device Key 填入即可；若使用的是官方公开推送服务，Server URL 直接留空。</li>
          <li>• <strong>WXPusher (微信服务号通知)</strong>：微信关注「Wp推送」或登录 wxpusher.zjiecode.com 开放平台，获取专属 SPT 凭据码填入即可。</li>
          <li>• <strong>PushPlus (微信消息推送)</strong>：访问 pushplus.plus 官网或微信小程序，在个人中心复制个人 Token 填入；Topic 群组编码留空即为默认一对一推送。</li>
        </ul>
      </div>

      <!-- 切换标签栏 -->
      <div class="flex flex-wrap gap-1.5 sm:gap-2 mb-4 border-b border-gray-100 dark:border-gray-800 pb-2">
        <button
          type="button"
          class="px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
          :class="activePushChannel === 'wecom' ? 'bg-blue-50 dark:bg-blue-950/70 text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'"
          @click="activePushChannel === 'wecom'"
        >
          <span>企业微信机器人</span>
          <span v-if="form.wecom.webhook" class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
        </button>
        <button
          type="button"
          class="px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
          :class="activePushChannel === 'bark' ? 'bg-blue-50 dark:bg-blue-950/70 text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'"
          @click="activePushChannel = 'bark'"
        >
          <span>Bark (iOS)</span>
          <span v-if="form.bark.key" class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
        </button>
        <button
          type="button"
          class="px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
          :class="activePushChannel === 'wxpusher' ? 'bg-blue-50 dark:bg-blue-950/70 text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'"
          @click="activePushChannel = 'wxpusher'"
        >
          <span>WXPusher</span>
          <span v-if="form.wxpusher.spt" class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
        </button>
        <button
          type="button"
          class="px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
          :class="activePushChannel === 'pushplus' ? 'bg-blue-50 dark:bg-blue-950/70 text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'"
          @click="activePushChannel = 'pushplus'"
        >
          <span>PushPlus</span>
          <span v-if="form.pushplus.token" class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
        </button>
      </div>

      <!-- 企业微信 -->
      <div v-show="activePushChannel === 'wecom'">
        <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">群机器人 Webhook 地址</label>
        <input
          v-model="form.wecom.webhook"
          type="text"
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
          class="input-base text-xs font-mono"
        />
      </div>

      <!-- Bark -->
      <div v-show="activePushChannel === 'bark'" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">Server URL (可选，官方服务留空)</label>
          <input
            v-model="form.bark.serverUrl"
            type="text"
            placeholder="官方服务直接留空即可"
            class="input-base text-xs"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">Device Key (必填)</label>
          <input
            v-model="form.bark.key"
            type="text"
            placeholder="Bark 设备 Key"
            class="input-base text-xs font-mono"
          />
        </div>
      </div>

      <!-- WXPusher -->
      <div v-show="activePushChannel === 'wxpusher'">
        <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">SPT 凭据码 (Simple Push Token)</label>
        <input
          v-model="form.wxpusher.spt"
          type="text"
          placeholder="spt_xxxxxxxxxxxxxxxxxxxx"
          class="input-base text-xs font-mono"
        />
      </div>

      <!-- PushPlus -->
      <div v-show="activePushChannel === 'pushplus'" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">PushPlus Token (必填)</label>
          <input
            v-model="form.pushplus.token"
            type="text"
            placeholder="PushPlus 个人 Token"
            class="input-base text-xs font-mono"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">Topic 群组编码 (可选，留空为一对一)</label>
          <input
            v-model="form.pushplus.topic"
            type="text"
            placeholder="群组编码，留空即默认一对一"
            class="input-base text-xs"
          />
        </div>
      </div>
    </div>

    <!-- ================= 模块 7: 系统安全与凭据 ================= -->
    <div class="settings-card">
      <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center shrink-0">
          <ShieldCheck class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">系统安全与 OpenAPI</h3>
        </div>
      </div>

      <!-- 模块 7 统一文字说明区 -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
          <span>管理员认证与 API 密钥说明</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>• <strong>Web 控制台管理员账户</strong>：用于保护管理面板不被未经授权的人员访问。<strong>家庭局域网 NAS 用户如需免密访问，将用户名留空保存即可</strong>。</li>
          <li>• <strong>安全密码修改策略</strong>：保存设置时，<strong>密码输入框留空代表保持原密码不变</strong>，系统绝对不会意外清空既有密码；只有需要修改新密码时才需在框内填入新密码。</li>
          <li>• <strong>OpenAPI 鉴权密钥 (API Key)</strong>：用于外部脚本、家庭自动化平台或第三方程序直接调用本系统接口。调用时在 HTTP 请求头中携带 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">Authorization: Bearer &lt;API_KEY&gt;</code> 即可免登录调用。</li>
        </ul>
      </div>

      <div class="space-y-4">
        <!-- 控制台访问账号与密码 -->
        <div class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/40 space-y-3">
          <h4 class="text-xs font-bold text-gray-800 dark:text-gray-100">Web 控制台登录认证</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">管理员用户名</label>
              <input v-model="form.system.username" type="text" placeholder="留空即免密直接访问" class="input-base text-xs bg-white dark:bg-gray-900" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">重置登录密码</label>
              <input v-model="form.system.password" type="password" placeholder="留空保持原密码不变" class="input-base text-xs bg-white dark:bg-gray-900" />
            </div>
          </div>
        </div>

        <!-- OpenAPI 鉴权密钥 -->
        <div class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/40 space-y-3">
          <h4 class="text-xs font-bold text-gray-800 dark:text-gray-100">OpenAPI 鉴权密钥 (API Key)</h4>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              v-model="form.system.apiKey"
              type="text"
              placeholder="尚未生成 API Key"
              readonly
              class="input-base text-xs font-mono flex-1 w-full bg-white dark:bg-gray-900"
            />
            <div class="flex items-center gap-2 shrink-0">
              <button type="button" class="btn-default text-xs h-[38px] px-3.5 flex-1 sm:flex-none justify-center cursor-pointer font-medium" @click="generateApiKey">
                重新生成
              </button>
              <button type="button" class="btn-default text-xs h-[38px] px-3.5 flex-1 sm:flex-none justify-center cursor-pointer font-medium flex items-center gap-1" @click="copyApiKey">
                <Check v-if="isCopiedApiKey" class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <Copy v-else class="w-3.5 h-3.5" />
                <span>{{ isCopiedApiKey ? '已复制' : '复制' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

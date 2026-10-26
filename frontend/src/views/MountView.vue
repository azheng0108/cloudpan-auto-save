<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  FolderSymlink,
  FileVideo,
  Tv,
  Info,
  Check,
  Copy,
  RefreshCw,
  Eye,
  EyeOff,
  Save,
  Play,
  CheckCircle2,
  XCircle,
  HardDrive,
  Layers,
  ChevronRight,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import { settingsApi } from '../api/settings';
import { accountApi } from '../api/account';
import FolderTreeSelector from '../components/FolderTreeSelector.vue';
const route = useRoute();
const router = useRouter();

// 当前激活的配置选项卡 ('strm' | 'emby' | 'alist')
const activeTab = ref<'strm' | 'emby' | 'alist'>('strm');

function syncTabFromRoute() {
  const t = route.query.tab as string;
  if (t === 'strm' || t === 'emby' || t === 'alist') {
    activeTab.value = t;
  }
}

function switchTab(t: 'strm' | 'emby' | 'alist') {
  activeTab.value = t;
  router.replace({
    path: '/mount',
    query: t !== 'strm' ? { tab: t } : undefined,
  });
}

watch(
  () => route.query.tab,
  () => {
    syncTabFromRoute();
  }
);


// 页面加载与状态管理
const isLoading = ref(true);
const isSaving = ref(false);
const isGeneratingStrm = ref(false);
const activeAccountId = ref<number | string>('');
const strmSourceFolderId = ref<string>('');
const strmSourceFolderName = ref<string>('/目标目录');
const isFolderPickerVisible = ref(false);
const cleanObsoleteStrm = ref(true);
const generateStrmResult = ref<{
  totalFiles: number;
  generatedStrm: number;
  skipped: number;
  errors: number;
  outputDir?: string;
  cleanedCount?: number;
  folderName?: string;
} | null>(null);

const showEmbyApiKey = ref(false);
const showAlistApiKey = ref(false);
const isCopiedWebhookUrl = ref(false);
const isCopiedToken = ref(false);

// 原始配置对象（确保不丢失其他模块任何配置）
let rawConfig: Record<string, any> = {};

// 表单响应式数据
const form = reactive({
  // 本地 STRM 与直链播放配置
  strm: {
    enable: false,
    streamMode: 'direct302', // 'direct302' | 'custom'
    outputDir: '',
    localStrmPrefix: '',
    cloudStrmPrefix: '',
    stripRootTargetDir: true,
  },
  // Emby 媒体服务器增量通知配置
  emby: {
    enable: false,
    serverUrl: '',
    apiKey: '',
    libraryPath: '',
  },
  // 反向入站 Webhook：接收 Emby 删除事件并同步移入 139 回收站
  webhook: {
    inboundEnable: false,
    inboundToken: '',
    embyMountPrefix: '',
    syncDeleteCloud: true,
    syncDeleteTask: true,
  },
  // AList / OpenList 外部挂载配置
  alist: {
    enable: false,
    baseUrl: '',
    apiKey: '',
    strmMountPath: '',
  },
});

// 计算完整 Webhook 回调接收地址
const fullWebhookUrl = computed(() => {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  const token = form.webhook.inboundToken.trim();
  return `${origin}/api/webhook/emby${token ? '?token=' + encodeURIComponent(token) : ''}`;
});

// 生成全新随机 16 字节 Hex Token
function generateNewWebhookToken() {
  const randomBytes = new Uint8Array(16);
  window.crypto.getRandomValues(randomBytes);
  form.webhook.inboundToken = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  ElMessage.info('已生成全新随机密钥 Token，请记得点击保存！');
}

// 复制完整 Webhook 回调地址
async function copyWebhookUrl() {
  try {
    await navigator.clipboard.writeText(fullWebhookUrl.value);
    isCopiedWebhookUrl.value = true;
    ElMessage.success('Emby Webhook 完整接收地址已成功复制到剪贴板！');
    setTimeout(() => {
      isCopiedWebhookUrl.value = false;
    }, 2000);
  } catch {
    ElMessage.error('复制失败，请手动选中输入框复制');
  }
}

// 复制 Token
async function copyToken() {
  try {
    await navigator.clipboard.writeText(form.webhook.inboundToken);
    isCopiedToken.value = true;
    ElMessage.success('安全 Token 已复制！');
    setTimeout(() => {
      isCopiedToken.value = false;
    }, 2000);
  } catch {
    ElMessage.error('复制失败');
  }
}

// 加载配置
async function loadConfig() {
  isLoading.value = true;
  try {
    const data = await settingsApi.getSettings();
    rawConfig = JSON.parse(JSON.stringify(data || {}));

    // 1. STRM 回填
    if (data.strm) {
      form.strm.enable = Boolean(data.strm.enable);
      form.strm.streamMode = 'direct302';
      form.strm.outputDir = data.strm.outputDir || '';
      form.strm.localStrmPrefix = data.strm.localStrmPrefix || '';
      form.strm.cloudStrmPrefix = data.strm.cloudStrmPrefix || '';
      form.strm.stripRootTargetDir = data.strm.stripRootTargetDir !== false;
    }

    const defaultFolderName = rawConfig?.channelMonitor?.defaultTargetFolderName || '/目标目录';
    const defaultFolderId = rawConfig?.channelMonitor?.defaultTargetFolderId || '';
    strmSourceFolderName.value = defaultFolderName.startsWith('/') ? defaultFolderName : `/${defaultFolderName}`;
    strmSourceFolderId.value = defaultFolderId;

    try {
      const accs = await accountApi.getAccounts();
      const cloud139 = (accs || []).find((a: any) => a.accountType === 'cloud139' && a.isActive) || (accs || []).find((a: any) => a.accountType === 'cloud139');
      if (cloud139) {
        activeAccountId.value = cloud139.id;
      }
    } catch (_) {}

    // 2. Emby 回填
    if (data.emby) {
      form.emby.enable = Boolean(data.emby.enable);
      form.emby.serverUrl = data.emby.serverUrl || '';
      form.emby.apiKey = data.emby.apiKey || '';
      form.emby.libraryPath = data.emby.libraryPath || '';
    }

    // 3. Webhook 回填
    if (data.webhook) {
      form.webhook.inboundEnable = Boolean(data.webhook.inboundEnable);
      form.webhook.inboundToken = data.webhook.inboundToken || '';
      form.webhook.embyMountPrefix = data.webhook.embyMountPrefix || '';
      form.webhook.syncDeleteCloud = data.webhook.syncDeleteCloud !== false;
      form.webhook.syncDeleteTask = data.webhook.syncDeleteTask !== false;
    }
    if (!form.webhook.inboundToken) {
      const randomBytes = new Uint8Array(16);
      window.crypto.getRandomValues(randomBytes);
      form.webhook.inboundToken = Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    // 4. AList 回填
    if (data.alist) {
      form.alist.enable = Boolean(data.alist.enable);
      form.alist.baseUrl = data.alist.baseUrl || '';
      form.alist.apiKey = data.alist.apiKey || '';
      form.alist.strmMountPath = data.alist.strmMountPath || '';
    }
  } catch (err: any) {
    ElMessage.error('加载挂载与 STRM 配置失败: ' + (err.message || '网络异常'));
  } finally {
    isLoading.value = false;
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true;
  try {
    const payload = {
      ...rawConfig,
      strm: {
        ...(rawConfig.strm || {}),
        enable: Boolean(form.strm.enable),
        streamMode: 'direct302',
        outputDir: form.strm.outputDir.trim(),
        localStrmPrefix: (form.strm.localStrmPrefix || '').trim(),
        cloudStrmPrefix: (form.strm.cloudStrmPrefix || '').trim(),
        stripRootTargetDir: form.strm.stripRootTargetDir !== false,
      },
      emby: {
        ...(rawConfig.emby || {}),
        enable: Boolean(form.emby.enable),
        serverUrl: form.emby.serverUrl.trim(),
        apiKey: form.emby.apiKey.trim(),
        libraryPath: form.emby.libraryPath.trim(),
      },
      webhook: {
        ...(rawConfig.webhook || {}),
        inboundEnable: Boolean(form.webhook.inboundEnable),
        inboundToken: form.webhook.inboundToken.trim(),
        embyMountPrefix: form.webhook.embyMountPrefix.trim(),
        syncDeleteCloud: Boolean(form.webhook.syncDeleteCloud),
        syncDeleteTask: Boolean(form.webhook.syncDeleteTask),
      },
      alist: {
        ...(rawConfig.alist || {}),
        enable: Boolean(form.alist.enable),
        baseUrl: form.alist.baseUrl.trim(),
        apiKey: form.alist.apiKey.trim(),
        strmMountPath: form.alist.strmMountPath.trim(),
      },
    };

    await settingsApi.saveSettings(payload);
    rawConfig = payload;
    ElMessage.success('媒体挂载与 STRM 直链配置已保存并即时生效！');
  } catch (err: any) {
    ElMessage.error('保存挂载配置失败: ' + (err.message || '未知异常'));
  } finally {
    isSaving.value = false;
  }
}

// 打开云盘目录树选择弹窗
function openFolderPicker() {
  if (!activeAccountId.value) {
    ElMessage.warning('请先在账号管理中添加或激活 139 网盘账号');
    return;
  }
  isFolderPickerVisible.value = true;
}

// 选中目录回调
function onFolderSelected(folder: { id: string; name: string }) {
  strmSourceFolderId.value = folder.id === '-11' ? '/' : folder.id;
  const rawName = folder.name || '';
  strmSourceFolderName.value = folder.id === '-11' ? '根目录 (/)' : (rawName.startsWith('/') ? rawName : `/${rawName}`);
  ElMessage.success(`已指定待扫描网盘目录: ${strmSourceFolderName.value}`);
}

// 为指定网盘目录生成 STRM 文件
async function triggerGenerateStrm() {
  isGeneratingStrm.value = true;
  generateStrmResult.value = null;
  try {
    const res = await settingsApi.generateOrganizedStrm({
      folderId: strmSourceFolderId.value,
      folderPath: strmSourceFolderName.value,
      forceAll: true,
      cleanObsolete: cleanObsoleteStrm.value,
      accountId: activeAccountId.value,
    });
    if (res?.success) {
      const data = res.data || {};
      generateStrmResult.value = {
        totalFiles: data.totalFiles ?? data.total ?? 0,
        generatedStrm: data.generatedStrm ?? data.successCount ?? 0,
        skipped: data.skipped ?? data.skippedCount ?? 0,
        errors: data.errors ?? data.failedCount ?? 0,
        outputDir: data.outputDir || form.strm.outputDir,
        cleanedCount: data.cleanedObsoleteCount ?? 0,
        folderName: data.folderName || strmSourceFolderName.value,
      };
      if (generateStrmResult.value.totalFiles === 0) {
        ElMessage.info(data.message || `网盘目录「${strmSourceFolderName.value}」中暂未检测到媒体文件`);
      } else {
        ElMessage.success(`STRM 生成完成！目录「${strmSourceFolderName.value}」共处理 ${generateStrmResult.value.totalFiles} 个媒体文件，成功生成 ${generateStrmResult.value.generatedStrm} 项。`);
      }
    } else {
      ElMessage.warning(res?.error || res?.message || '生成未能全部完成');
    }
  } catch (err: any) {
    ElMessage.error('触发 STRM 生成失败: ' + (err.message || '网络异常'));
  } finally {
    isGeneratingStrm.value = false;
  }
}

// 监听顶部 Header 保存事件
function onHeaderSaveClick() {
  saveConfig();
}

onMounted(() => {
  syncTabFromRoute();
  loadConfig();
  window.addEventListener('header-save-click', onHeaderSaveClick);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSaveClick);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- 顶层主视口切换：统一对齐系统标准胶囊选项卡规范（加载期间选项卡常显，spec 5.4.1.3） -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <!-- 胶囊选项卡群组 -->
        <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
          <button
            type="button"
            @click="switchTab('strm')"
            :class="activeTab === 'strm' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
          >
            <FileVideo class="w-3.5 h-3.5" />
            <span>本地 STRM 直链映射</span>
          </button>

          <button
            type="button"
            @click="switchTab('emby')"
            :class="activeTab === 'emby' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
          >
            <Tv class="w-3.5 h-3.5" />
            <span>Emby 媒体服务联动</span>
          </button>

          <button
            type="button"
            @click="switchTab('alist')"
            :class="activeTab === 'alist' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
          >
            <HardDrive class="w-3.5 h-3.5" />
            <span>AList 外部存储挂载</span>
          </button>
        </div>

        <!-- 右侧快速操作区 -->
        <div class="flex items-center gap-2">
          <template v-if="activeTab === 'strm'">
            <button
              type="button"
              class="btn-default text-xs h-8 px-3 flex items-center gap-1.5 cursor-pointer font-medium text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
              :disabled="isGeneratingStrm"
              @click="triggerGenerateStrm"
            >
              <RefreshCw v-if="isGeneratingStrm" class="w-3.5 h-3.5 animate-spin text-emerald-600" />
              <Play v-else class="w-3.5 h-3.5 text-emerald-600" />
              <span>{{ isGeneratingStrm ? '正在生成...' : '立即生成 STRM' }}</span>
            </button>
          </template>
        </div>
      </div>

      <!-- 内容区统一加载占位（非整页遮罩，加载期间公共头部与选项卡可见，spec 5.4.1.3） -->
      <div v-if="isLoading" class="p-16 text-center text-gray-500">
        <RefreshCw class="w-8 h-8 mx-auto animate-spin text-blue-500 mb-2" />
        <span class="text-xs">正在加载媒体挂载与直链配置...</span>
      </div>

      <template v-else>
      <!-- ================= Tab 1: 本地 STRM 与 302 直链播放配置 ================= -->
      <div v-if="activeTab === 'strm'" class="space-y-6">
      <!-- ================= 模块 1: 本地 STRM 与 302 直链播放配置 ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <FileVideo class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">本地 STRM 与直链播放配置</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              直接生成轻量 .strm 媒体映射文件，直连 139 CDN 满速拉流，零服务器中转带宽消耗
            </p>
          </div>
        </div>

        <!-- 文字说明区 -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>STRM 文件与直链播放架构说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>原生 302 直链生成</strong>：媒体归档入库后，自动在本地保存与网盘媒体库一致的目录树（如 <code>剧集/国漫/片名 (年份) {tmdb-id}/Season 01/</code>），生成同名 <code>.strm</code> 文件供 Emby、Jellyfin、Infuse 等媒体服务器瞬间扫库。</li>
            <li>• <strong>139 官方 CDN 原生 302 直链</strong>：播放时由本系统实时向 139 换取官方 CDN 高速直链并 302 重定向至播放端，零本地中转流量消耗，告别复杂中间件。</li>
            <li>• <strong>为什么不需要 Emby 302 反代？</strong>：STRM 内部直接写入了 302 直链 URL，播放器在播放时直接向 139 官方 CDN 获取音视频切片，<strong>无需在 Emby 前面部署额外的 Nginx / emby2Alist 等反代组件</strong>。</li>
          </ul>
        </div>

        <!-- 表单字段 -->
        <div class="space-y-5">
          <!-- 3 大关键选项 (独立成行，一行一个) -->
          <div class="space-y-3">
            <!-- 启用本地 STRM 生成开关（switch-row 统一规格，对齐频道监控规范 ChannelView:959-967） -->
            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">启用本地 STRM 生成</label>
                <p class="switch-row__desc">追更归档后自动在本地写入 .strm</p>
              </div>
              <el-switch v-model="form.strm.enable" />
            </div>

            <!-- 剥离顶层目标目录开关 -->
            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">自动剥离顶层目标目录名</label>
                <p class="switch-row__desc">存为「剧集/...」，便于 Emby 挂载</p>
              </div>
              <el-switch v-model="form.strm.stripRootTargetDir" />
            </div>

            <!-- 清理失效旧映射开关 -->
            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">生成前清理失效旧映射</label>
                <p class="switch-row__desc">自动移除网盘已删除的旧 .strm</p>
              </div>
              <el-switch v-model="cleanObsoleteStrm" />
            </div>
          </div>

          <!-- 路径输入配置 (独立分行) -->
          <div class="space-y-4">
            <!-- 本地 STRM 输出目录 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                本地 STRM 保存根目录
              </label>
              <input
                v-model="form.strm.outputDir"
                type="text"
                placeholder="留空默认写入项目下 ./strm 目录（Docker 环境通常映射为 /strm）"
                class="input-base font-mono text-xs w-full"
              />
              <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                STRM 文件在本地磁盘或 Docker 容器内的输出根目录（如 <code>./strm</code> 或 <code>/strm</code>）
              </p>
            </div>

            <!-- 云盘待扫描媒体目录 (指定文件夹生成) -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                网盘媒体源目录 (生成 STRM 的云盘文件夹)
              </label>
              <div class="flex flex-col sm:flex-row gap-2">
                <input
                  v-model="strmSourceFolderName"
                  type="text"
                  placeholder="例如: /目标目录 或 /媒体库"
                  class="input-base text-xs font-mono flex-1 w-full bg-white dark:bg-gray-900"
                />
                <button
                  type="button"
                  class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
                  @click="openFolderPicker"
                >
                  <FolderSymlink class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  <span>选择网盘目录</span>
                </button>
              </div>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                系统将递归扫描该网盘文件夹内的所有真实视频文件并生成本地 STRM 映射，杜绝空挂或失效死链
              </p>
            </div>
          </div>

          <!-- 快捷操作：为指定网盘目录生成 STRM -->
          <div class="p-3.5 rounded-xl border border-emerald-200/80 dark:border-emerald-800/60 bg-emerald-50/30 dark:bg-emerald-950/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Play class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>为指定网盘目录生成 STRM 映射</span>
              </div>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                当前扫描目录: <code class="font-mono font-semibold text-emerald-700 dark:text-emerald-400">{{ strmSourceFolderName || '/目标目录' }}</code>
              </p>
            </div>
            <button
              type="button"
              class="btn-default text-xs h-8 px-3.5 shrink-0 flex items-center gap-1.5 cursor-pointer font-medium text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700"
              :disabled="isGeneratingStrm"
              @click="triggerGenerateStrm"
            >
              <RefreshCw v-if="isGeneratingStrm" class="w-3.5 h-3.5 animate-spin text-emerald-600" />
              <FileVideo v-else class="w-3.5 h-3.5 text-emerald-600" />
              <span>{{ isGeneratingStrm ? '正在生成...' : '立即生成 STRM' }}</span>
            </button>
          </div>

          <!-- 全量生成结果面板 -->
          <div
            v-if="generateStrmResult"
            class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs space-y-2.5"
          >
            <div class="flex items-center justify-between">
              <div class="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                <CheckCircle2 class="w-4 h-4 text-emerald-500" />
                <span>STRM 任务执行完成</span>
              </div>
              <router-link
                to="/system"
                class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
              >
                <span>前往系统日志查看实时写入明细</span>
                <ChevronRight class="w-3.5 h-3.5" />
              </router-link>
            </div>

            <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
              <div>网盘源目录: <code class="font-mono font-semibold text-gray-800 dark:text-gray-200">{{ generateStrmResult.folderName || strmSourceFolderName }}</code></div>
              <div>本地保存根目录: <code class="font-mono font-semibold text-emerald-700 dark:text-emerald-400">{{ generateStrmResult.outputDir || form.strm.outputDir }}</code></div>
            </div>

            <!-- STRM 统计胶囊语义色（对齐状态语义色规范 spec 6.2.6：neutral/success/warning/warning/danger） -->
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-0.5 font-mono text-[11px]">
              <div class="p-2 rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                扫描媒体总数: <strong class="text-gray-900 dark:text-white">{{ generateStrmResult.totalFiles }}</strong>
              </div>
              <div class="p-2 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
                成功生成: <strong>{{ generateStrmResult.generatedStrm }}</strong>
              </div>
              <div class="p-2 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
                跳过重复: <strong>{{ generateStrmResult.skipped }}</strong>
              </div>
              <div class="p-2 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
                清理失效旧映射: <strong>{{ generateStrmResult.cleanedCount ?? 0 }}</strong>
              </div>
              <div class="p-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
                失败异常: <strong>{{ generateStrmResult.errors }}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>

      </div>

      <!-- ================= Tab 2: Emby 媒体服务双向联动 ================= -->
      <div v-if="activeTab === 'emby'" class="space-y-6">
      <!-- ================= 模块 2: Emby 媒体服务器增量通知 ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
            <Tv class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">Emby 媒体库刷新通知 (出站通知)</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              影视整理入库或生成 STRM 后，向 Emby 派发目录增量更新事件，无需全库死锁扫描
            </p>
          </div>
        </div>

        <div class="space-y-4">
          <div class="switch-row">
            <div>
              <label class="switch-row__title">启用 Emby 增量媒体库更新通知</label>
              <p class="switch-row__desc">调用 /emby/Library/Media/Updated 官方端点轻量增量刷新</p>
            </div>
            <el-switch v-model="form.emby.enable" />
          </div>

          <div v-if="form.emby.enable" class="space-y-3 pt-2">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby 服务器地址</label>
                <input
                  v-model="form.emby.serverUrl"
                  type="text"
                  placeholder="例如: http://192.168.1.100:8096"
                  class="input-base font-mono text-xs w-full"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby API 密钥 (API Key)</label>
                <div class="relative">
                  <input
                    v-model="form.emby.apiKey"
                    :type="showEmbyApiKey ? 'text' : 'password'"
                    placeholder="从 Emby 后台 -> API 密钥 中获取"
                    class="input-base font-mono text-xs pr-10 w-full"
                  />
                  <button
                    type="button"
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                    @click="showEmbyApiKey = !showEmbyApiKey"
                  >
                    <EyeOff v-if="showEmbyApiKey" class="w-4 h-4" />
                    <Eye v-else class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby 媒体库根路径映射 (选填)</label>
              <input
                v-model="form.emby.libraryPath"
                type="text"
                placeholder="例如: /media 或 /strm，与 Emby 容器内部添加的媒体库路径一致"
                class="input-base font-mono text-xs w-full"
              />
              <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                当 Emby 内部映射路径与宿主机不一致时填写（如 Emby 里添加的是 <code>/media/剧集</code>，此处填写 <code>/media</code>）
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= 模块 3: Emby 媒体删除双向联动 (入站 Webhook) ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
            <Tv class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">Emby 媒体删除双向联动 (入站 Webhook)</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              在 Emby 客户端中删除剧集或电影时，自动将 139 网盘对应视频软删除移入回收站
            </p>
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            <span>双向删除安全机制说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>STRM 自动逆向匹配</strong>：当 Emby 发出媒体删除事件时，系统自动剥离 <code>.strm</code> 扩展名并映射为 139 网盘中的真实视频文件。</li>
            <li>• <strong>移入网盘回收站（0 物理硬删）</strong>：调用 139 官方 <code>batchTrash</code> 接口移入网盘官方回收站，误删随时可在网盘 App/网页找回。</li>
            <li>• <strong>安全白名单熔断保护</strong>：绝对拦截 <code>/</code>、<code>/媒体库</code>、<code>/strm</code> 等根目录误删，杜绝目录穿越。</li>
          </ul>
        </div>

        <div class="space-y-4">
          <div class="switch-row">
            <div>
              <label class="switch-row__title">启用 Emby 媒体删除联动网盘</label>
              <p class="switch-row__desc">开启后接收 Emby item.delete / library.deleted 事件并同步网盘回收站</p>
            </div>
            <el-switch v-model="form.webhook.inboundEnable" />
          </div>

          <div v-if="form.webhook.inboundEnable" class="space-y-3 pt-2">
            <!-- 完整 Webhook 回调地址 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Emby Webhook 完整接收 URL (复制填入 Emby 后台 Webhook 插件)
              </label>
              <div class="flex gap-2">
                <input
                  :value="fullWebhookUrl"
                  readonly
                  class="input-base font-mono text-xs flex-1 bg-gray-100 dark:bg-gray-800 select-all"
                />
                <button
                  type="button"
                  @click="copyWebhookUrl"
                  class="btn-default text-xs h-[38px] px-3.5 shrink-0 flex items-center gap-1.5 cursor-pointer font-medium"
                >
                  <Check v-if="isCopiedWebhookUrl" class="w-3.5 h-3.5 text-emerald-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ isCopiedWebhookUrl ? '已复制' : '复制完整地址' }}</span>
                </button>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">安全校验 Token</label>
                <div class="flex gap-2">
                  <input
                    v-model="form.webhook.inboundToken"
                    type="text"
                    placeholder="16 字节安全密钥"
                    class="input-base font-mono text-xs flex-1"
                  />
                  <button
                    type="button"
                    @click="generateNewWebhookToken"
                    class="btn-default text-xs h-[38px] px-2.5 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                    title="重新生成随机密钥 Token"
                  >
                    <RefreshCw class="w-3.5 h-3.5" />
                    <span>随机</span>
                  </button>
                  <button
                    type="button"
                    @click="copyToken"
                    class="btn-default text-xs h-[38px] px-2.5 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <Check v-if="isCopiedToken" class="w-3.5 h-3.5 text-emerald-500" />
                    <Copy v-else class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby 挂载前缀映射 (选填)</label>
                <input
                  v-model="form.webhook.embyMountPrefix"
                  type="text"
                  placeholder="例如: /strm 或 /media"
                  class="input-base font-mono text-xs w-full"
                />
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                  收到 Emby 删除事件时，系统自动剥离此路径前缀以匹配网盘相对路径
                </p>
              </div>
            </div>

            <!-- 同步删除策略 (独立成行，一行一个) -->
            <div class="space-y-3 pt-1">
              <div class="switch-row">
                <div>
                  <div class="switch-row__title">同步移入 139 回收站</div>
                  <div class="switch-row__desc">绝对零物理硬删，支持随时在网盘撤回</div>
                </div>
                <el-switch v-model="form.webhook.syncDeleteCloud" />
              </div>
              <div class="switch-row">
                <div>
                  <div class="switch-row__title">同步清除系统任务记录</div>
                  <div class="switch-row__desc">同步清理数据库中对应转存与追更记录</div>
                </div>
                <el-switch v-model="form.webhook.syncDeleteTask" />
              </div>
            </div>
          </div>
        </div>
      </div>

      </div>

      <!-- ================= Tab 3: AList / OpenList 外部挂载管理 ================= -->
      <div v-if="activeTab === 'alist'" class="space-y-6">
      <!-- ================= 模块 4: AList / OpenList 外部挂载管理 ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <HardDrive class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">AList / OpenList 外部挂载管理 (可选)</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              用于连接外部 AList 服务或 OpenList 原生 STRM 存储目录
            </p>
          </div>
        </div>

        <div class="space-y-4">
          <div class="switch-row">
            <div>
              <label class="switch-row__title">启用 AList 服务联动</label>
              <p class="switch-row__desc">与外部 AList 挂载点保持连通</p>
            </div>
            <el-switch v-model="form.alist.enable" />
          </div>

          <div v-if="form.alist.enable" class="space-y-3 pt-2">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">AList 服务地址</label>
                <input
                  v-model="form.alist.baseUrl"
                  type="text"
                  placeholder="例如: http://192.168.1.100:5244"
                  class="input-base font-mono text-xs w-full"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">AList 访问令牌 (Token)</label>
                <div class="relative">
                  <input
                    v-model="form.alist.apiKey"
                    :type="showAlistApiKey ? 'text' : 'password'"
                    placeholder="从 AList 管理后台 -> 设置 -> 令牌 中获取"
                    class="input-base font-mono text-xs pr-10 w-full"
                  />
                  <button
                    type="button"
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                    @click="showAlistApiKey = !showAlistApiKey"
                  >
                    <EyeOff v-if="showAlistApiKey" class="w-4 h-4" />
                    <Eye v-else class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">AList 挂载根路径</label>
              <input
                v-model="form.alist.strmMountPath"
                type="text"
                placeholder="例如: /139云盘 或 /媒体库"
                class="input-base font-mono text-xs w-full"
              />
            </div>
          </div>
        </div>
      </div>

      </div>
    </template>

    <!-- 目录树选择弹窗 (FolderTreeSelector) -->
    <FolderTreeSelector
      v-model="isFolderPickerVisible"
      :account-id="activeAccountId"
      title="选择生成 STRM 的网盘媒体目录"
      @select="onFolderSelected"
    />
  </div>
</template>

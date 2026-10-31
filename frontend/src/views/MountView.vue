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
  ChevronRight,
  Plus,
  Trash2,
  RotateCcw,
  AlertTriangle,
  FolderCheck,
  Download,
  ShieldAlert,
  SlidersHorizontal,
  ChevronDown,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import { settingsApi } from '../api/settings';
import { accountApi } from '../api/account';
import FolderTreeSelector from '../components/FolderTreeSelector.vue';

// 系统推荐的默认格式列表
const DEFAULT_VIDEO_EXTS = [
  '.mp4', '.mkv', '.avi', '.ts', '.iso', '.flv', '.mov', '.wmv',
  '.rmvb', '.m4v', '.strm', '.mpg', '.mpeg', '.vob', '.m2ts', '.webm', '.3gp'
];

// 页面加载与状态管理
const isLoading = ref(true);
const isSaving = ref(false);
const isGeneratingStrm = ref(false);
const activeAccountId = ref<number | string>('');

// 多目录选择控制
const isFolderPickerVisible = ref(false);
const currentCatalogSelectIndex = ref<number>(-1); // -1 表示单选旧兼容，>=0 表示当前正在挑选的行

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
const isCopiedWebhookUrl = ref(false);
const isCopiedDeepDeleteUrl = ref(false);
const isCopiedToken = ref(false);

// 新增扩展名输入框绑定值
const newVideoExtInput = ref('');

// 原始配置对象（确保不丢失其他模块任何配置）
let rawConfig: Record<string, any> = {};

// 表单响应式数据
const form = reactive({
  // 本地 STRM 与 139 官方 CDN 原生直链播放配置
  strm: {
    enable: false,
    autoGenerateOnOrganize: true, // 媒体整理入库后自动生成对应的 .strm 文件
    outputDir: '',
    strmBaseUrl: '', // 139 官方 CDN 302 服务根地址
    sourceCatalogs: [] as Array<{ id: string; name: string }>, // 多源目录
    videoSuffixes: [...DEFAULT_VIDEO_EXTS], // 视频扩展名 Chip 标签池
    minSizeMB: 0, // 小视频跳过阈值 MB
    cleanEmptyDirs: true, // 清理无效空目录独立开关
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
});

// 真实媒体样本直链（从批量生成返回结果动态提取）
const realSampleUrl = ref('');
const realSampleName = ref('');

// 计算 STRM 预览直链 URL (有真实生成媒体时展示真实链接，无时展示清晰的标准结构模板)
const sampleStrmUrl = computed(() => {
  if (realSampleUrl.value) return realSampleUrl.value;
  const base = (form.strm.strmBaseUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://192.168.1.100:3000')).replace(/\/+$/, '');
  return `${base}/api/strm/stream/{网盘文件ID}/{视频文件名.mp4}`;
});

const isCopiedSampleUrl = ref(false);
async function copySampleUrl() {
  try {
    await navigator.clipboard.writeText(sampleStrmUrl.value);
    isCopiedSampleUrl.value = true;
    ElMessage.success(realSampleUrl.value ? '真实媒体播放地址已复制！可直接在 PotPlayer / VLC (Ctrl+U) 播放测试' : 'STRM 结构示例地址已复制到剪贴板！');
    setTimeout(() => {
      isCopiedSampleUrl.value = false;
    }, 2000);
  } catch {
    ElMessage.error('复制失败');
  }
}

// 计算通用 Emby Webhook 回调地址
const fullWebhookUrl = computed(() => {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  const token = form.webhook.inboundToken.trim();
  return `${origin}/api/webhook/emby${token ? '?token=' + encodeURIComponent(token) : ''}`;
});

// 计算神医助手 / 深度删除专享 Webhook 回调地址
const deepDeleteWebhookUrl = computed(() => {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  const token = form.webhook.inboundToken.trim();
  return `${origin}/api/emby/webhook/deep_delete${token ? '?token=' + encodeURIComponent(token) : ''}`;
});

// 生成全新随机 16 字节 Hex Token
function generateNewWebhookToken() {
  const randomBytes = new Uint8Array(16);
  window.crypto.getRandomValues(randomBytes);
  form.webhook.inboundToken = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  ElMessage.info('已生成全新随机密钥 Token，请记得点击右上角保存！');
}

// 复制通用 Webhook 回调地址
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

// 复制神医助手深度删除专用地址
async function copyDeepDeleteUrl() {
  try {
    await navigator.clipboard.writeText(deepDeleteWebhookUrl.value);
    isCopiedDeepDeleteUrl.value = true;
    ElMessage.success('神医助手 / Emby 深度删除接收地址已成功复制到剪贴板！');
    setTimeout(() => {
      isCopiedDeepDeleteUrl.value = false;
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

// 源目录列表动态增删
function addSourceCatalogRow() {
  form.strm.sourceCatalogs.push({ id: '', name: '' });
}

function removeSourceCatalogRow(idx: number) {
  if (form.strm.sourceCatalogs.length <= 1) {
    form.strm.sourceCatalogs[0] = { id: '', name: '' };
    return;
  }
  form.strm.sourceCatalogs.splice(idx, 1);
}

// 打开特定行的目录挑选弹窗
function openCatalogFolderPicker(idx: number) {
  if (!activeAccountId.value) {
    ElMessage.warning('请先在账号管理中添加或激活 139 网盘账号');
    return;
  }
  currentCatalogSelectIndex.value = idx;
  isFolderPickerVisible.value = true;
}

// 选中目录回调
function onFolderSelected(folder: { id: string; name: string }) {
  const normId = folder.id === '-11' ? '/' : folder.id;
  const rawName = folder.name || '';
  const normName = folder.id === '-11' ? '根目录 (/)' : (rawName.startsWith('/') ? rawName : `/${rawName}`);

  if (currentCatalogSelectIndex.value >= 0 && currentCatalogSelectIndex.value < form.strm.sourceCatalogs.length) {
    form.strm.sourceCatalogs[currentCatalogSelectIndex.value] = {
      id: normId,
      name: normName,
    };
    ElMessage.success(`第 ${currentCatalogSelectIndex.value + 1} 项源目录已设为: ${normName} (${normId})`);
  } else {
    // 兜底追加或填充首行
    if (form.strm.sourceCatalogs.length === 0 || !form.strm.sourceCatalogs[0].id) {
      form.strm.sourceCatalogs[0] = { id: normId, name: normName };
    } else {
      form.strm.sourceCatalogs.push({ id: normId, name: normName });
    }
    ElMessage.success(`已指定网盘源目录: ${normName}`);
  }
}

// 视频扩展名 Chip 标签池操作
function addVideoExtChip() {
  const val = newVideoExtInput.value.trim().toLowerCase();
  if (!val) return;
  const formatted = val.startsWith('.') ? val : `.${val}`;
  if (!form.strm.videoSuffixes.includes(formatted)) {
    form.strm.videoSuffixes.push(formatted);
  }
  newVideoExtInput.value = '';
}

function removeVideoExtChip(ext: string) {
  form.strm.videoSuffixes = form.strm.videoSuffixes.filter((e) => e !== ext);
}

function resetVideoExtChips() {
  form.strm.videoSuffixes = [...DEFAULT_VIDEO_EXTS];
  ElMessage.success('视频扩展名已重置为系统推荐列表');
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
      form.strm.outputDir = data.strm.outputDir || '';
      form.strm.strmBaseUrl = data.strm.strmBaseUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3000');
      form.strm.localStrmPrefix = data.strm.localStrmPrefix || '';
      form.strm.cloudStrmPrefix = data.strm.cloudStrmPrefix || '';
      form.strm.stripRootTargetDir = data.strm.stripRootTargetDir !== false;
      form.strm.minSizeMB = Number(data.strm.minSizeMB ?? 0);
      form.strm.cleanEmptyDirs = data.strm.cleanEmptyDirs !== false;

      // 视频扩展名池
      if (Array.isArray(data.strm.videoSuffixes) && data.strm.videoSuffixes.length > 0) {
        form.strm.videoSuffixes = [...data.strm.videoSuffixes];
      } else {
        form.strm.videoSuffixes = [...DEFAULT_VIDEO_EXTS];
      }

      // 源目录列表回填
      if (Array.isArray(data.strm.sourceCatalogs) && data.strm.sourceCatalogs.length > 0) {
        form.strm.sourceCatalogs = data.strm.sourceCatalogs.map((c: any) => ({
          id: String(c.id || ''),
          name: String(c.name || ''),
        }));
      }
    }

    // 默认源目录初始化兜底
    if (!form.strm.sourceCatalogs || form.strm.sourceCatalogs.length === 0) {
      const defaultFolderName = rawConfig?.channelMonitor?.defaultTargetFolderName || '/目标目录';
      const defaultFolderId = rawConfig?.channelMonitor?.defaultTargetFolderId || '';
      form.strm.sourceCatalogs = [
        {
          id: defaultFolderId,
          name: defaultFolderName.startsWith('/') ? defaultFolderName : `/${defaultFolderName}`,
        },
      ];
    }

    if (!form.strm.strmBaseUrl && typeof window !== 'undefined') {
      form.strm.strmBaseUrl = window.location.origin;
    }

    // 获取可用 139 账号
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
        autoGenerateOnOrganize: Boolean(form.strm.autoGenerateOnOrganize),
        outputDir: form.strm.outputDir.trim(),
        strmBaseUrl: (form.strm.strmBaseUrl || '').trim(),
        sourceCatalogs: form.strm.sourceCatalogs.filter((c) => c.id || c.name),
        videoSuffixes: form.strm.videoSuffixes,
        minSizeMB: Number(form.strm.minSizeMB || 0),
        cleanEmptyDirs: Boolean(form.strm.cleanEmptyDirs),
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

// 批量为所有源目录执行 STRM 生成
async function triggerGenerateStrm() {
  const validCatalogs = form.strm.sourceCatalogs.filter((c) => c.id && c.id.trim().length > 0);
  if (validCatalogs.length === 0) {
    ElMessage.warning('请至少指定一个有效的【网盘源目录 ID】');
    return;
  }

  isGeneratingStrm.value = true;
  generateStrmResult.value = null;
  try {
    const res = await settingsApi.generateOrganizedStrm({
      sourceCatalogs: validCatalogs,
      videoSuffixes: form.strm.videoSuffixes,
      minSizeMB: Number(form.strm.minSizeMB || 0),
      strmBaseUrl: form.strm.strmBaseUrl,
      cleanEmptyDirs: form.strm.cleanEmptyDirs,
      cleanObsolete: cleanObsoleteStrm.value,
      accountId: activeAccountId.value,
    });
    if (res?.success) {
      const data = res.data || {};
      if (data.sampleRealUrl) {
        realSampleUrl.value = data.sampleRealUrl;
        realSampleName.value = data.sampleRealName || '';
      }
      generateStrmResult.value = {
        totalFiles: data.totalFiles ?? data.total ?? 0,
        generatedStrm: data.generatedStrm ?? data.successCount ?? 0,
        skipped: data.skipped ?? data.skippedCount ?? 0,
        errors: data.errors ?? data.failedCount ?? 0,
        outputDir: data.outputDir || form.strm.outputDir,
        cleanedCount: data.cleanedObsoleteCount ?? 0,
        folderName: validCatalogs.map((c) => c.name || c.id).join('，'),
      };
      if (generateStrmResult.value.totalFiles === 0) {
        ElMessage.info(data.message || `所选网盘目录中暂未检测到匹配后缀的媒体文件`);
      } else {
        ElMessage.success(`STRM 生成完成！共处理 ${generateStrmResult.value.totalFiles} 个媒体文件，成功生成 ${generateStrmResult.value.generatedStrm} 项。`);
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
  loadConfig();
  window.addEventListener('header-save-click', onHeaderSaveClick);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSaveClick);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- 内容区统一加载占位 -->
    <div v-if="isLoading" class="p-16 text-center text-gray-500">
      <RefreshCw class="w-8 h-8 mx-auto animate-spin text-blue-500 mb-2" />
      <span class="text-xs">正在加载媒体挂载与直链配置...</span>
    </div>

    <template v-else>
      <div class="space-y-6">
        <!-- 模块 1: STRM 文件自动生成主体卡片 -->
        <div class="settings-card">
          <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <FileVideo class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">STRM 文件自动生成</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                媒体整理入库后自动生成对应的 .strm 文件，支持 139 官方 CDN 原生 302 高速直链播放
              </p>
            </div>
          </div>

          <!-- 文字说明区 -->
          <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
            <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Info class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>STRM 139 官方 CDN 原生直链架构说明</span>
            </div>
            <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
              <li>• <strong>媒体整理自动入库生成</strong>：云盘影视全量整理、暂存区归档或频道监控入库媒体后，全自动在本地保存与网盘媒体库一致的目录树，生成同名 <code>.strm</code> 媒体映射文件，媒体服务器可瞬间毫秒级扫库。</li>
              <li>• <strong>139 官方 CDN 原生 302 直链</strong>：免除任何外部中间件，播放时由本系统实时向移动云盘换取官方 CDN 高速直链并 302 重定向至客户端，零服务器流量消耗，直连满速拉流。</li>
            </ul>
          </div>

          <!-- 核心开关设置 (自动化入库与清理联动) -->
          <div class="space-y-3 mb-6">
            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">启用 STRM 文件生成</label>
                <p class="switch-row__desc">基础功能总开关：开启后方可执行本地 STRM 生成与直链服务</p>
              </div>
              <el-switch v-model="form.strm.enable" />
            </div>

            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">媒体整理入库后自动生成 .strm 文件</label>
                <p class="switch-row__desc">影视全量整理、暂存区归档或频道监控入库媒体后，全自动无感在本地写入对应的 .strm 映射文件</p>
              </div>
              <el-switch v-model="form.strm.autoGenerateOnOrganize" />
            </div>

            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">自动剥离顶层目标目录名</label>
                <p class="switch-row__desc">存为「剧集/...」或「电影/...」，便于媒体服务器挂载对齐</p>
              </div>
              <el-switch v-model="form.strm.stripRootTargetDir" />
            </div>

            <div class="switch-row">
              <div class="pr-2">
                <label class="switch-row__title">生成前清理失效旧映射</label>
                <p class="switch-row__desc">自动扫描并移除网盘已不存在的旧 .strm 孤儿文件</p>
              </div>
              <el-switch v-model="cleanObsoleteStrm" />
            </div>
          </div>

          <!-- STRM 播放服务与直链配置卡片 -->
          <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 space-y-4 mb-6">
            <div class="font-bold text-xs text-gray-900 dark:text-white flex items-center gap-1.5">
              <HardDrive class="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>139 官方 CDN 原生 302 直链播放配置</span>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                STRM 播放服务地址 (前缀 Host)
              </label>
              <input
                v-model="form.strm.strmBaseUrl"
                type="text"
                placeholder="例如: http://192.168.1.100:3000 (切勿填 127.0.0.1)"
                class="input-base font-mono text-xs w-full bg-white dark:bg-gray-900"
              />
              <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1 leading-normal">
                写入每个 .strm 内部的 302 重定向服务地址。电视端/移动端 Emby 访问时必须能连通该 IP，<strong>Docker 环境下请务必填写宿主机局域网 IP 与端口</strong>。
              </p>
            </div>

            <!-- STRM 直链生成规则与效果预览 -->
            <div class="p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                  <FileVideo class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span v-if="realSampleUrl">库内真实媒体测试直链 ({{ realSampleName || '已生成媒体' }})：</span>
                  <span v-else>STRM 文件写入的 URL 规范结构（模板示例）：</span>
                </span>
                <button
                  type="button"
                  class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                  :title="realSampleUrl ? '复制真实文件的播放直链，可在 PotPlayer/VLC 中测试播放' : '复制规范示例'"
                  @click="copySampleUrl"
                >
                  <Check v-if="isCopiedSampleUrl" class="w-3 h-3 text-emerald-500" />
                  <Copy v-else class="w-3 h-3" />
                  <span>{{ isCopiedSampleUrl ? '已复制' : (realSampleUrl ? '复制测试直链' : '复制格式示例') }}</span>
                </button>
              </div>
              <div class="p-2 rounded bg-gray-50 dark:bg-gray-950 font-mono text-[11px] text-gray-800 dark:text-gray-200 break-all select-all border border-gray-200/50 dark:border-gray-800">
                {{ sampleStrmUrl }}
              </div>
              <p class="text-[10px] text-gray-500 dark:text-gray-400">
                {{ realSampleUrl ? '提示：此为库内真实媒体直链，可在 PotPlayer / VLC 中按快捷键 Ctrl+U 粘贴进行流媒体播放测试；请勿直接在浏览器当普通文件下载。' : '说明：此为写入每个本地 .strm 文件的单行直链模板；实际执行批量生成时，系统会自动替换为 139 网盘内扫描到的真实文件 ID 与原文件名。' }}
              </p>
            </div>

            <!-- 本地 STRM 输出保存目录 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                本地 STRM 保存根目录 (输出路径)
              </label>
              <input
                v-model="form.strm.outputDir"
                type="text"
                placeholder="留空默认写入项目下 ./strm 目录（Docker 环境通常映射为 /app/strm 或 /strm）"
                class="input-base font-mono text-xs w-full bg-white dark:bg-gray-900"
              />
              <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                STRM 映射文件在本地物理磁盘或 Docker 容器内的持久化存储路径
              </p>
            </div>

            <!-- 动态多源目录 ID 配置列表 (专业自适应网格布局) -->
            <div class="space-y-3">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div class="flex items-center gap-2">
                    <label class="text-xs font-bold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                      <FolderSymlink class="w-4 h-4 text-blue-600 dark:text-blue-400" />
                      <span>网盘媒体源目录列表</span>
                    </label>
                    <span class="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-900/40">
                      已配置 {{ form.strm.sourceCatalogs.length }} 个目录
                    </span>
                  </div>
                  <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    支持添加多个源目录并行递归扫描；首行若留空则默认扫描全部归档媒体
                  </p>
                </div>
                <button
                  type="button"
                  class="btn-default text-xs h-8 px-3 shrink-0 self-start sm:self-auto flex items-center gap-1.5 cursor-pointer font-semibold text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-900 hover:bg-blue-50 dark:hover:bg-blue-950/30 shadow-2xs transition-colors"
                  @click="addSourceCatalogRow"
                >
                  <Plus class="w-3.5 h-3.5" />
                  <span>添加源目录</span>
                </button>
              </div>

              <!-- 目录列表项容器 -->
              <div class="space-y-2">
                <div
                  v-for="(cat, idx) in form.strm.sourceCatalogs"
                  :key="idx"
                  class="p-2.5 rounded-xl bg-white dark:bg-gray-850 border border-gray-200/90 dark:border-gray-750 hover:border-blue-300 dark:hover:border-blue-700/80 shadow-2xs transition-all"
                >
                  <div class="flex flex-col lg:flex-row items-stretch lg:items-center gap-2.5">
                    <!-- 序号胶囊徽标 -->
                    <div class="hidden lg:flex items-center justify-center w-7 h-7 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-mono text-xs font-bold shrink-0">
                      {{ (idx + 1).toString().padStart(2, '0') }}
                    </div>

                    <!-- 目录 ID 与路径输入区 (占据核心宽度) -->
                    <div class="flex-1 min-w-0">
                      <div class="relative flex items-center">
                        <span class="lg:hidden px-2 text-xs font-mono font-bold text-gray-400 shrink-0">#{{ idx + 1 }}</span>
                        <input
                          v-model="cat.id"
                          type="text"
                          placeholder="网盘目录 ID (留空表示扫描全部媒体，如 00000000000000000000 或 /)"
                          class="input-base text-xs font-mono w-full bg-gray-50/60 dark:bg-gray-900 focus:bg-white dark:focus:bg-gray-900"
                        />
                      </div>
                    </div>

                    <!-- 目录显示备注 (固定适中宽度) -->
                    <div class="w-full lg:w-48 shrink-0">
                      <input
                        v-model="cat.name"
                        type="text"
                        placeholder="目录备注 (如 /剧集 或 /电影)"
                        class="input-base text-xs w-full bg-gray-50/60 dark:bg-gray-900 focus:bg-white dark:focus:bg-gray-900 text-gray-700 dark:text-gray-200"
                      />
                    </div>

                    <!-- 动作按钮组 (紧凑横排，绝不折行与截断) -->
                    <div class="flex items-center justify-end gap-2 shrink-0">
                      <button
                        type="button"
                        class="btn-default text-xs h-[38px] px-3.5 flex items-center gap-1.5 cursor-pointer font-semibold text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/60 whitespace-nowrap"
                        title="从 139 网盘目录树可视化浏览点选"
                        @click="openCatalogFolderPicker(idx)"
                      >
                        <FolderSymlink class="w-3.5 h-3.5 text-blue-500" />
                        <span>选目录</span>
                      </button>

                      <button
                        v-if="form.strm.sourceCatalogs.length > 1"
                        type="button"
                        class="btn-default text-xs h-[38px] px-3 flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 border-rose-200 dark:border-rose-900/80 cursor-pointer font-medium whitespace-nowrap"
                        title="删除该源目录"
                        @click="removeSourceCatalogRow(idx)"
                      >
                        <Trash2 class="w-3.5 h-3.5 text-rose-500" />
                        <span>删除</span>
                      </button>

                      <button
                        v-else
                        type="button"
                        class="btn-default text-xs h-[38px] px-3 flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 border-gray-200 dark:border-gray-700 cursor-pointer font-medium whitespace-nowrap"
                        title="清空当前行输入"
                        @click="removeSourceCatalogRow(idx)"
                      >
                        <RotateCcw class="w-3.5 h-3.5" />
                        <span>清空</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 底部温馨提示条 -->
              <div class="flex items-start gap-1.5 px-1 text-[11px] text-gray-500 dark:text-gray-400">
                <Info class="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                <span>点击「选目录」直接从移动云盘文件夹树可视化点选填入；若无需限定特定子文件夹，可直接留空首行以全量递归归档目录。</span>
              </div>
            </div>
          </div>

          <!-- 生成文件范围与视频扩展名 Chip 池 -->
          <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 space-y-4 mb-6">
            <div class="flex items-center justify-between">
              <div class="font-bold text-xs text-gray-900 dark:text-white flex items-center gap-1.5">
                <FileVideo class="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>生成文件范围与扩展名过滤</span>
              </div>
              <button
                type="button"
                class="text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-1 cursor-pointer"
                @click="resetVideoExtChips"
              >
                <RotateCcw class="w-3 h-3" />
                <span>重置为推荐默认</span>
              </button>
            </div>

            <!-- 视频扩展名 Chip 标签池 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                STRM 视频扩展名池 (包含以下扩展名的文件才生成 STRM 映射)
              </label>
              <div class="p-2.5 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 flex flex-wrap gap-1.5 items-center">
                <span
                  v-for="ext in form.strm.videoSuffixes"
                  :key="ext"
                  class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                >
                  {{ ext }}
                  <button
                    type="button"
                    class="hover:text-rose-600 cursor-pointer ml-0.5 inline-flex items-center justify-center"
                    @click="removeVideoExtChip(ext)"
                  >
                    ×
                  </button>
                </span>

                <!-- 动态添加新扩展名内联输入 -->
                <div class="inline-flex items-center gap-1 ml-1">
                  <input
                    v-model="newVideoExtInput"
                    type="text"
                    placeholder="+ 扩展名 (回车)"
                    class="h-7 w-28 px-2 text-xs font-mono border border-dashed border-gray-300 dark:border-gray-600 rounded bg-transparent focus:outline-none focus:border-emerald-500"
                    @keydown.enter.prevent="addVideoExtChip"
                  />
                  <button
                    type="button"
                    class="btn-default h-7 px-2 text-xs text-emerald-600 dark:text-emerald-400 cursor-pointer"
                    @click="addVideoExtChip"
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>

            <!-- 小视频跳过阈值 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                小视频大小过滤阈值 (MB)
              </label>
              <div class="flex items-center gap-2 max-w-xs">
                <input
                  v-model.number="form.strm.minSizeMB"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="0"
                  class="input-base text-xs font-mono w-full bg-white dark:bg-gray-900"
                />
                <span class="text-xs text-gray-500 shrink-0 font-medium">MB</span>
              </div>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                设置为 0 表示不限制；若设置为 30，则小于 30MB 的视频（片头预告、宣传花絮、小样片）将自动跳过，不生成 STRM。
              </p>
            </div>
          </div>

          <!-- 清理无效目录 (对标截图: 启用时清理无效 .strm 和空目录；关闭时只清理无效 .strm 文件) -->
          <div class="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-850 p-4 space-y-3 mb-6">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">清理无效目录</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                无效目录清理：启用时 STRM 同步完成后会清理无效 .strm 和空目录；关闭时只清理无效 .strm 文件
              </p>
            </div>
            <div class="rounded-lg bg-gray-50/80 dark:bg-gray-800/60 p-2.5 px-3 flex items-center justify-between border border-gray-100 dark:border-gray-750">
              <span class="text-xs font-medium" :class="form.strm.cleanEmptyDirs ? 'text-gray-900 dark:text-white' : 'text-gray-400'">
                {{ form.strm.cleanEmptyDirs ? '已启用' : '未启用' }}
              </span>
              <el-switch v-model="form.strm.cleanEmptyDirs" />
            </div>
          </div>

          <!-- 批量执行生成按钮卡片 -->
          <div class="p-3.5 rounded-xl border border-emerald-200/80 dark:border-emerald-800/60 bg-emerald-50/30 dark:bg-emerald-950/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Play class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>批量为所有指定源目录执行 STRM 生成</span>
              </div>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                将按上述扩展名池、阈值与多源目录并行递归扫描网盘，极速输出到本地
              </p>
            </div>
            <button
              type="button"
              class="btn-default text-xs h-8 px-4 shrink-0 flex items-center gap-1.5 cursor-pointer font-medium text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 bg-white dark:bg-gray-900 shadow-sm"
              :disabled="isGeneratingStrm"
              @click="triggerGenerateStrm"
            >
              <RefreshCw v-if="isGeneratingStrm" class="w-3.5 h-3.5 animate-spin text-emerald-600" />
              <FileVideo v-else class="w-3.5 h-3.5 text-emerald-600" />
              <span>{{ isGeneratingStrm ? '正在生成 STRM...' : '立即执行批量扫描生成' }}</span>
            </button>
          </div>

          <!-- 全量生成结果面板 -->
          <div
            v-if="generateStrmResult"
            class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs space-y-2.5 mt-4"
          >
            <div class="flex items-center justify-between">
              <div class="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                <CheckCircle2 class="w-4 h-4 text-emerald-500" />
                <span>STRM 批量生成执行完成</span>
              </div>
              <router-link
                to="/system"
                class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
              >
                <span>查看系统日志明细</span>
                <ChevronRight class="w-3.5 h-3.5" />
              </router-link>
            </div>

            <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
              <div>源目录列表: <code class="font-mono font-semibold text-gray-800 dark:text-gray-200">{{ generateStrmResult.folderName }}</code></div>
              <div>本地保存根目录: <code class="font-mono font-semibold text-emerald-700 dark:text-emerald-400">{{ generateStrmResult.outputDir || form.strm.outputDir }}</code></div>
            </div>

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
                清理失效旧项: <strong>{{ generateStrmResult.cleanedCount ?? 0 }}</strong>
              </div>
              <div class="p-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
                失败异常: <strong>{{ generateStrmResult.errors }}</strong>
              </div>
            </div>
          </div>

        </div>

        <!-- 模块 2: 联动 Emby 媒体删除 (同步删除) 主体卡片 (核心反向联动) -->
        <div class="settings-card border-rose-200/80 dark:border-rose-900/50">
          <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0 shadow-xs">
                <Trash2 class="w-5 h-5" />
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
                    联动 Emby 媒体删除 (同步删除)
                  </h3>
                  <span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300">
                    核心反向联动
                  </span>
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  在 Emby 中删除影片时，神医助手通过 Webhook 通知本系统，直接读取本地 .strm 提取真实 fileId 并将 139 网盘源文件移入回收站
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-semibold" :class="form.webhook.inboundEnable ? 'text-rose-600 dark:text-rose-400' : 'text-gray-400'">
                {{ form.webhook.inboundEnable ? '已开启同步删除' : '未开启同步删除' }}
              </span>
              <el-switch v-model="form.webhook.inboundEnable" />
            </div>
          </div>

          <!-- 醒目黄色警告提示框 -->
          <div class="p-3.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 font-medium space-y-1 mb-4">
            <div class="flex items-center gap-1.5 font-bold">
              <AlertTriangle class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>安全提示：只有本系统生成的 STRM 才能被逆向识别并执行 139 网盘同步删除</span>
            </div>
            <p class="leading-relaxed font-normal text-[11.5px]">
              系统通过读取本地 <code>.strm</code> 文件正则提取网盘 <code>fileId</code>，并调用 139 官方安全回收站软删除，绝对零物理硬删，误删随时可在网盘官方 App 撤回。
            </p>
          </div>

          <!-- 同步删除核心配置（常驻展示，避免折叠让用户看不到） -->
          <div class="space-y-4">
            <!-- 神医助手专享 URL 复制框 -->
            <div class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30 space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-bold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <ShieldAlert class="w-4 h-4 text-rose-500" />
                  <span>神医助手 / Emby Webhook 同步删除通知地址</span>
                </label>
                <span class="text-[11px] text-gray-500 font-mono">POST application/json</span>
              </div>
              <div class="flex gap-2">
                <input
                  :value="deepDeleteWebhookUrl"
                  readonly
                  class="input-base font-mono text-xs flex-1 bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 select-all font-semibold text-rose-900 dark:text-rose-200"
                />
                <button
                  type="button"
                  @click="copyDeepDeleteUrl"
                  class="btn-default text-xs h-[38px] px-3.5 shrink-0 flex items-center gap-1.5 cursor-pointer font-bold text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-900 bg-rose-50/80 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 shadow-xs"
                >
                  <Check v-if="isCopiedDeepDeleteUrl" class="w-3.5 h-3.5 text-emerald-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ isCopiedDeepDeleteUrl ? '已复制' : '复制同步删除地址' }}</span>
                </button>
              </div>
              <p class="text-[11px] text-gray-500 dark:text-gray-400">
                将此完整带 Token 链接填入神医助手的「通知增强」或 Emby「Webhook」设置中，勾选「媒体已删除」事件。
              </p>
            </div>

            <!-- 同步删除细项开关 (网盘源文件 + 追更任务) -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="flex items-center justify-between p-3.5 rounded-xl bg-gray-50/80 dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80">
                <div>
                  <div class="text-xs font-bold text-gray-800 dark:text-gray-200">同步删除 139 网盘源文件</div>
                  <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">将网盘源文件安全移入 139 云盘回收站</div>
                </div>
                <el-switch v-model="form.webhook.syncDeleteCloud" />
              </div>

              <div class="flex items-center justify-between p-3.5 rounded-xl bg-gray-50/80 dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80">
                <div>
                  <div class="text-xs font-bold text-gray-800 dark:text-gray-200">同步注销关联追更任务</div>
                  <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">清理本地数据库中对应频道监控追更任务记录</div>
                </div>
                <el-switch v-model="form.webhook.syncDeleteTask" />
              </div>
            </div>

            <!-- 密钥与容器路径映射 -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Webhook 安全密钥 Token</label>
                <div class="flex gap-2">
                  <input
                    v-model="form.webhook.inboundToken"
                    type="text"
                    placeholder="16 字节安全密钥"
                    class="input-base font-mono text-xs flex-1 bg-white dark:bg-gray-900"
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
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby 容器内挂载前缀映射 (选填)</label>
                <input
                  v-model="form.webhook.embyMountPrefix"
                  type="text"
                  placeholder="例如: /media 或 /strm"
                  class="input-base font-mono text-xs w-full bg-white dark:bg-gray-900"
                />
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                  若 Emby 容器内挂载点为 <code>/media/strm</code>，填入此前缀以精准定位本地文件
                </p>
              </div>
            </div>

            <!-- 神医助手与 Emby 3 步接入指南 -->
            <div class="p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-slate-50 dark:bg-slate-800/50 text-xs space-y-2">
              <div class="font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                <CheckCircle2 class="w-4 h-4 text-emerald-500" />
                <span>Emby / 神医助手同步删除 3 步接入指南</span>
              </div>
              <ol class="space-y-1.5 pl-3.5 list-decimal text-slate-600 dark:text-slate-300 leading-relaxed text-[11.5px]">
                <li>在 Emby 管理后台中打开<strong>「插件」</strong>，安装<strong>「神医助手」</strong>或 Emby 官方<strong>「Webhook」</strong>插件。</li>
                <li>添加 Webhook 配置，在<strong>「Webhook Url」</strong>处粘贴上方复制的同步删除地址。</li>
                <li>在事件勾选项中勾选<strong>「媒体已删除 (Item Deleted / library.deleted)」</strong>事件，点击保存即可享受无感同步删除！</li>
              </ol>
            </div>
          </div>
        </div>

        <!-- 模块 2: 联动 Emby 媒体入库 (同时入库通知) -->
        <div class="settings-card">
          <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0 shadow-xs">
              <Tv class="w-5 h-5" />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
                  联动 Emby 媒体入库 (同时入库通知)
                </h3>
                <span class="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300">
                  出站轻量刷新
                </span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                影视整理入库或生成 STRM 后，自动调用 Emby 官方端点通知媒体库增量刷新入库，无需全库死锁扫描
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

            <div class="space-y-3 pt-2">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby 服务器访问地址</label>
                  <input
                    v-model="form.emby.serverUrl"
                    type="text"
                    placeholder="例如: http://192.168.1.100:8096"
                    class="input-base font-mono text-xs w-full bg-white dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Emby API 密钥 (API Key)</label>
                  <div class="relative">
                    <input
                      v-model="form.emby.apiKey"
                      :type="showEmbyApiKey ? 'text' : 'password'"
                      placeholder="从 Emby 后台 -> API 密钥 中获取"
                      class="input-base font-mono text-xs pr-10 w-full bg-white dark:bg-gray-900"
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
                  class="input-base font-mono text-xs w-full bg-white dark:bg-gray-900"
                />
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                  当 Emby 内部映射路径与宿主机不一致时填写（如 Emby 里添加的是 <code>/media/剧集</code>，此处填写 <code>/media</code>）
                </p>
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

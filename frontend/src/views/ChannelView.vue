<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  channelApi,
  compileCardsToRegex,
  type ChannelGlobalConfig,

  type VisualCardItem,
  type TmdbCandidateItem,
  type ChannelHistoryItem,
  type ChannelAiConfig,
  type MobileFallbackConfig,
  type AiTestResult,
  type AiParsedMediaInfo,

} from '../api/channel';
import { accountApi } from '../api/account';
import { ElMessage } from 'element-plus';
import {
  Radio,
  Clock,
  Filter,
  Info,
  Folder,
  Plus,
  Trash2,
  RotateCw,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Search,
  Film,
  Code,
  Clapperboard,

  Edit3,
  Check,
  X,
  ExternalLink,
  Send,
  Sliders,
  SlidersHorizontal,
  Tv,
  FolderOpen,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Layers,
  ShieldCheck,
  Copy,
} from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();

// ================= 全局配置状态 =================
const loading = ref(false);
const saving = ref(false);
const syncing = ref(false);

// AI 智能识别默认配置（与后端 src/services/ai.js:28-37 归一化默认值严格对齐）
const AI_DEFAULTS: ChannelAiConfig = {
  enable: false,
  baseUrl: 'http://127.0.0.1:8045/v1',
  apiKey: '',
  model: 'gemini-3.8-flash-tiered',
  mode: 'fallback',
  mobileFallback: { enable: true, networkSearch: true, proactiveRenew: false, timeoutMs: 60000 },
};

// 模板绑定代理：运行时 config.ai 由初始值与归一化合并保证存在，此处兜底仅满足 TS 严格模式
const aiForm = computed<ChannelAiConfig>(() => config.value.ai ?? AI_DEFAULTS);

const config = ref<ChannelGlobalConfig>({
  enabled: true,
  channels: ['https://t.me/yunpan139'],
  stagingFolderId: '',
  stagingFolderName: '/暂存区/频道转存',
  defaultTargetFolderId: '/',
  defaultTargetFolderName: '默认媒体库 (/)',
  dispatchRules: [],
  whitelistRegex: '',
  blacklistKeywords: [],
  visualCards: [],
  scanInterval: 5,
  videoExtensions: ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'wmv', 'ts'],
  metadataExtensions: ['ass', 'srt', 'ssa', 'sub', 'vtt'],
  enableRename: true,
  enableMediaInfo: true,
  sweepEmptyFolders: true,
  autoOrganize: true,
  autoWash: true,
  minFileSize: 50,
  ignoreKeywords: '',
  ignoreAudiobooks: true,
  classifyChildren: false,
  classifyConcerts: true,
  classifyRegion: true,
  classifyYear: false,
  washPriorityOrder: [
    'releaseGroup',
    'resourceType',
    'videoFormat',
    'dynamicRange',
    'colorDepth',
    'audioCodec',
    'frameRate',
    'fileSize'
  ],
  keepDolbyMultiVersion: false,
  notifyOnOrganize: true,
  ai: { ...AI_DEFAULTS, mobileFallback: { ...(AI_DEFAULTS.mobileFallback!) } },
});

// 云盘账号 ID (用于驱动 FolderTreeSelector 目录选择器)
const defaultAccountId = ref<number | string>('');


// ================= 监控频道卡片管理（对齐 AccountsView 卡片网格与零弹窗规范） =================
const showAddChannelCard = ref(false);
const newChannelInput = ref('');
const editingChannelIndex = ref<number | null>(null);
const inlineEditChannelValue = ref('');
const deletingChannelIndex = ref<number | null>(null);

function openAddChannel() {
  newChannelInput.value = '';
  showAddChannelCard.value = true;
}

function confirmAddChannel() {
  const url = newChannelInput.value.trim();
  if (!url) {
    ElMessage.warning('请输入有效的 Telegram 频道链接或用户名');
    return;
  }
  if (!config.value.channels) {
    config.value.channels = [];
  }
  if (config.value.channels.includes(url)) {
    ElMessage.warning('该频道已在监控列表中');
    return;
  }
  config.value.channels.push(url);
  newChannelInput.value = '';
  showAddChannelCard.value = false;
  ElMessage.success('已成功添加监控频道！记得点击右上角保存配置');
}

function startEditChannel(index: number) {
  editingChannelIndex.value = index;
  inlineEditChannelValue.value = config.value.channels[index];
}

function saveEditChannel(index: number) {
  const val = inlineEditChannelValue.value.trim();
  if (!val) {
    ElMessage.warning('频道地址不能为空');
    return;
  }
  config.value.channels[index] = val;
  editingChannelIndex.value = null;
  ElMessage.success('已更新频道地址');
}

function cancelEditChannel() {
  editingChannelIndex.value = null;
  inlineEditChannelValue.value = '';
}

function confirmRemoveChannel(index: number) {
  config.value.channels.splice(index, 1);
  deletingChannelIndex.value = null;
  ElMessage.success('已移除该监控频道');
}


// ================= 黑名单关键词增删 =================
const newBlacklistInput = ref('');

function addBlacklistKeyword() {
  const text = newBlacklistInput.value.trim();
  if (!text) return;
  const items = text.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean);
  items.forEach((item) => {
    if (!config.value.blacklistKeywords.includes(item)) {
      config.value.blacklistKeywords.push(item);
    }
  });
  newBlacklistInput.value = '';
}

function removeBlacklistKeyword(kw: string) {
  config.value.blacklistKeywords = config.value.blacklistKeywords.filter((k) => k !== kw);
}

// ================= TMDB 影视规则卡片与自定义正则（零弹窗内联展开） =================
const inlineTmdbSearchOpen = ref(false);
const tmdbSearchTitle = ref('');
const tmdbSearchYear = ref('');
const tmdbSearching = ref(false);
const tmdbCandidates = ref<TmdbCandidateItem[]>([]);

const inlineCustomRegexOpen = ref(false);
const customRegexName = ref('');
const customRegexPattern = ref('');

async function handleSearchTmdb() {
  const title = tmdbSearchTitle.value.trim();
  if (!title) {
    ElMessage.warning('请输入搜索片名');
    return;
  }
  tmdbSearching.value = true;
  try {
    const list = await channelApi.searchCandidates({
      title,
      year: tmdbSearchYear.value.trim() || undefined,
    });
    tmdbCandidates.value = list || [];
    if (tmdbCandidates.value.length === 0) {
      ElMessage.info('未检索到 TMDB 匹配条目，可尝试简化片名或只保留中文');
    }
  } catch (err: any) {
    ElMessage.error(`TMDB 检索失败: ${err.message || '网络异常'}`);
  } finally {
    tmdbSearching.value = false;
  }
}

function handleAddTmdbCard(item: TmdbCandidateItem) {
  const title = item.chineseTitle || item.name || item.title || '未知影视';
  const newCard: VisualCardItem = {
    id: `tmdb_${item.id || Date.now()}`,
    type: 'tmdb',
    tmdbId: item.id,
    title,
    originalTitle: item.originalTitle,
    year: item.year,
    posterPath: item.posterPath,
    aliases: item.translations || [],
    limitations: [],
  };

  if (!Array.isArray(config.value.visualCards)) {
    config.value.visualCards = [];
  }

  const existingIdx = config.value.visualCards.findIndex((c) => c.tmdbId === item.id);
  if (existingIdx >= 0) {
    ElMessage.warning(`卡片【${title}】已存在`);
    return;
  }

  config.value.visualCards.push(newCard);
  inlineTmdbSearchOpen.value = false;
  tmdbCandidates.value = [];
  tmdbSearchTitle.value = '';
  ElMessage.success(`已添加【${title}】监控规则卡片`);
}

function handleAddCustomRegexCard() {
  const name = customRegexName.value.trim();
  const pattern = customRegexPattern.value.trim();
  if (!name || !pattern) {
    ElMessage.warning('请填写规则名称与正则表达式');
    return;
  }
  try {
    new RegExp(pattern);
  } catch (e: any) {
    ElMessage.error(`正则表达式格式错误: ${e.message}`);
    return;
  }

  const newCard: VisualCardItem = {
    id: `custom_${Date.now()}`,
    type: 'custom',
    name,
    title: name,
    pattern,
  };

  if (!Array.isArray(config.value.visualCards)) {
    config.value.visualCards = [];
  }
  config.value.visualCards.push(newCard);
  inlineCustomRegexOpen.value = false;
  customRegexName.value = '';
  customRegexPattern.value = '';
  ElMessage.success(`已添加自定义正则卡片【${name}】`);
}

function removeVisualCard(cardId: string) {
  if (!config.value.visualCards) return;
  config.value.visualCards = config.value.visualCards.filter((c) => c.id !== cardId);
}

function toggleCardLimitation(cardId: string, limit: '4K' | '完整剧集') {
  const card = config.value.visualCards?.find((c) => c.id === cardId);
  if (!card) return;
  if (!Array.isArray(card.limitations)) card.limitations = [];
  const idx = card.limitations.indexOf(limit);
  if (idx >= 0) {
    card.limitations.splice(idx, 1);
  } else {
    card.limitations.push(limit);
  }
}

// AST 规则编译并同步到白名单
function handleCompileCardsToRegex() {
  const cards = config.value.visualCards || [];
  if (cards.length === 0) {
    ElMessage.warning('当前无任何规则卡片，请先添加 TMDB 影视或自定义规则');
    return;
  }
  const compiled = compileCardsToRegex(cards);
  config.value.whitelistRegex = compiled;
  ElMessage.success('已依据当前规则卡片完成编译，并成功回填至白名单大正则！');
}

const clearingCardsConfirm = ref(false);
function handleClearAllCards() {
  if (!clearingCardsConfirm.value) {
    clearingCardsConfirm.value = true;
    return;
  }
  config.value.visualCards = [];
  clearingCardsConfirm.value = false;
  ElMessage.success('已清空规则卡片');
}


// ================= AI 智能识别：体验状态与试算链路（试算与线上转存零副作用隔离） =================
// 连接测试状态（结果随表单值变更不自动失效，保留最近一次结果避免编辑即闪烁）
const aiTestLoading = ref<boolean>(false);
const aiTestResult = ref<AiTestResult | null>(null);

// 内置智能通道连通性测试状态
const mobileAiTestLoading = ref<boolean>(false);
const mobileAiTestResult = ref<AiTestResult | null>(null);

// 内置智能通道配置响应式代理（loadInitialData 归一化后对象恒存在，模板直写生效）
const mobileFallbackForm = computed<MobileFallbackConfig>(() => {
  const ai = config.value.ai as any;
  if (ai.mobileFallback) return ai.mobileFallback;
  ai.mobileFallback = { ...(AI_DEFAULTS.mobileFallback!) };
  return ai.mobileFallback;
});

// 推文识别试算内联面板状态（复刻 inlineTmdbSearchOpen 范式：收起时不清空输入与结果）
const aiTrialOpen = ref<boolean>(false);
const aiTrialText = ref<string>('');
const aiTrialLoading = ref<boolean>(false);
const aiTrialResult = ref<AiParsedMediaInfo | null>(null);
const aiTrialError = ref<string>('');

// AI 表单清洗纯函数：读取当前表单值统一清洗，供测试/试算/保存三处调用
// （三重防御第三层：config.ai 异常时回退 AI_DEFAULTS，杜绝 undefined 崩溃）
function buildAiFormPayload(): ChannelAiConfig {
  const raw = config.value.ai || {} as Partial<ChannelAiConfig>;
  const rawMobile = (raw as any).mobileFallback || (AI_DEFAULTS.mobileFallback as MobileFallbackConfig);
  return {
    enable: typeof raw.enable === 'boolean' ? raw.enable : AI_DEFAULTS.enable,
    baseUrl: String(raw.baseUrl ?? AI_DEFAULTS.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(raw.apiKey ?? '').trim(),
    model: String(raw.model ?? AI_DEFAULTS.model).trim(),
    mode: raw.mode === 'always' ? 'always' : 'fallback',
    mobileFallback: {
      enable: typeof rawMobile.enable === 'boolean' ? rawMobile.enable : true,
      networkSearch: typeof rawMobile.networkSearch === 'boolean' ? rawMobile.networkSearch : true,
      proactiveRenew: typeof rawMobile.proactiveRenew === 'boolean' ? rawMobile.proactiveRenew : false,
      timeoutMs: Number(rawMobile.timeoutMs) > 0 ? Number(rawMobile.timeoutMs) : 60000,
    },
  };
}

// AI 连接测试：以表单当前值即时生效（未保存未开启亦可测，后端 testConnection 内部强制 enable）
async function handleTestAiConnection(): Promise<void> {
  const formValue = buildAiFormPayload();
  if (!formValue.baseUrl || !formValue.apiKey) {
    ElMessage.warning('请先填写 AI 服务地址与 API Key');
    return;
  }
  aiTestLoading.value = true;
  try {
    const res = await channelApi.testAi(formValue);
    aiTestResult.value = {
      success: Boolean(res?.success),
      latencyMs: res?.latencyMs,
      model: res?.model || '内置免密引擎',
      reply: res?.reply,
    };
  } catch (err: any) {
    aiTestResult.value = { success: false, error: err?.message || '连接测试失败' };
  } finally {
    aiTestLoading.value = false;
  }
}

// 内置智能通道连通性测试：验证免密通行凭证与会话链路
async function handleTestMobileAiConnection(): Promise<void> {
  mobileAiTestLoading.value = true;
  try {
    const res = await channelApi.testMobileAi();
    mobileAiTestResult.value = {
      success: Boolean(res?.success),
      latencyMs: res?.latencyMs,
      model: res?.model,
      reply: res?.reply || (res as any)?.content,
    };
  } catch (err: any) {
    mobileAiTestResult.value = { success: false, error: err?.message || '内置通道连接测试失败' };
  } finally {
    mobileAiTestLoading.value = false;
  }
}

// 试算面板开合切换：收起时保留输入与结果，重展开可见上次内容
function toggleAiTrialPanel(): void {
  aiTrialOpen.value = !aiTrialOpen.value;
}

// AI 推文识别试算：三级校验链（空文本 → 识别通道可用性 → 主通道要素校验）
// 试算隔离铁律：函数体内禁止任何对 config.value / whitelistRegex / visualCards 的写操作
async function handleParseTweet(): Promise<void> {
  const text = aiTrialText.value.trim();
  if (!text) {
    ElMessage.warning('请输入待识别的推文文本');
    return;
  }
  const formValue = buildAiFormPayload();
  const mainAiReady = Boolean(config.value.ai?.enable);
  const mobileReady = Boolean(formValue.mobileFallback?.enable);
  if (!mainAiReady && !mobileReady) {
    ElMessage.warning('请先开启 AI 识别开关或内置智能通道兜底开关');
    return;
  }
  // 主通道启用时才校验三要素；纯移动兜底模式下无需主通道配置
  if (mainAiReady) {
    const missing: string[] = [];
    if (!formValue.baseUrl) missing.push('服务地址');
    if (!formValue.apiKey) missing.push('API Key');
    if (!formValue.model) missing.push('模型名称');
    if (missing.length > 0) {
      ElMessage.warning(`请先补全 AI 配置: ${missing.join('、')}`);
      return;
    }
  }

  aiTrialLoading.value = true;
  aiTrialError.value = '';
  try {
    const res = await channelApi.parseTweet({ text, config: formValue });
    aiTrialResult.value = res || null;
  } catch (err: any) {
    aiTrialResult.value = null;
    aiTrialError.value = err?.message || '识别失败';
  } finally {
    aiTrialLoading.value = false;
  }
}

// 展示辅助：媒体类型中文化与置信度百分比化（不可用字段以 '—' 占位）
function formatAiMediaType(v?: string): string {
  if (v === 'tv') return '剧集';
  if (v === 'movie') return '电影';
  return '—';
}

function formatAiConfidence(v?: number): string {
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0) return '—';
  return `${Math.round(v * 100)}%`;
}

// AI 生效态徽标：复刻后端 ai.js:44-47 isEnabled 四要素判定语义，保证界面说明与后端判定一致
const aiEffectiveBadge = computed<{ active: boolean; label: string }>(() => {
  const ai = config.value.ai;
  const mobileEnabled = Boolean((ai as any)?.mobileFallback?.enable);
  if (!ai?.enable) {
    if (mobileEnabled) {
      return { active: true, label: '内置智能通道生效' };
    }
    return { active: false, label: '未生效（开关未开启）' };
  }
  const missing: string[] = [];
  if (!ai.baseUrl?.trim()) missing.push('服务地址');
  if (!ai.apiKey?.trim()) missing.push('API Key');
  if (!ai.model?.trim()) missing.push('模型名称');
  if (missing.length > 0) {
    if (mobileEnabled) {
      return { active: true, label: '内置智能通道生效' };
    }
    return { active: false, label: `未生效（缺失 ${missing.join('、')}）` };
  }
  return { active: true, label: mobileEnabled ? '自定义 AI + 内置兜底生效' : '自定义 AI 就绪' };
});


// ================= 保存配置 =================
async function handleSaveConfig() {
  saving.value = true;
  try {
    const cleanedChannels = config.value.channels.map((c) => c.trim()).filter(Boolean);

    const payload: Partial<ChannelGlobalConfig> = {
      ...config.value,
      channels: cleanedChannels,
      dispatchRules: [],
      visualCards: config.value.visualCards || [],
      ai: buildAiFormPayload(),
    };

    const res = await channelApi.saveGlobalConfig(payload);
    if (res) {
      config.value.channels = res.channels || cleanedChannels;
      config.value.dispatchRules = [];
      if (res.stagingFolderId !== undefined) config.value.stagingFolderId = res.stagingFolderId;
      if (res.stagingFolderName !== undefined) config.value.stagingFolderName = res.stagingFolderName;
      if (res.defaultTargetFolderId !== undefined) config.value.defaultTargetFolderId = res.defaultTargetFolderId;
      if (res.defaultTargetFolderName !== undefined) config.value.defaultTargetFolderName = res.defaultTargetFolderName;
      if (res.visualCards) config.value.visualCards = res.visualCards;
      // AI 节以后端归一化结果为准字段级合并（如 mode 非法值被后端纠正后消除界面与落盘值不一致）
      if (res.ai) config.value.ai = { ...config.value.ai, ...res.ai };
    }
    ElMessage.success('频道监控配置已成功保存！');
  } catch (err: any) {
    ElMessage.error(`保存失败: ${err.message || '网络异常'}`);
  } finally {
    saving.value = false;
  }
}

// ================= 手动扫描推文 =================
async function handleSyncNow() {
  syncing.value = true;
  try {
    const res = await channelApi.syncNow();
    ElMessage.success(res.message || '已触发频道推文即时抓取轮询');
  } catch (err: any) {
    ElMessage.error(`扫描推文异常: ${err.message || '网络错误'}`);
  } finally {
    syncing.value = false;
  }
}

// ================= 加载初始配置 =================
async function loadInitialData() {
  loading.value = true;
  try {
    // 1. 获取账号信息
    const accounts = await accountApi.getAccounts();
    const cloud139Accs = (accounts || []).filter((a: any) => a.accountType === 'cloud139');
    if (cloud139Accs.length > 0) {
      const active = cloud139Accs.find((a: any) => a.isActive) || cloud139Accs[0];
      defaultAccountId.value = active.id;
    }

    // 2. 加载频道监控集中配置
    const res = await channelApi.getGlobalConfig();
    if (res) {
      config.value = {
        ...config.value,
        ...res,
        channels: Array.isArray(res.channels) && res.channels.length ? res.channels : ['https://t.me/yunpan139'],
        stagingFolderId: res.stagingFolderId || '',
        stagingFolderName: res.stagingFolderName || '/暂存区/频道转存',
        defaultTargetFolderId: res.defaultTargetFolderId || '/',
        defaultTargetFolderName: res.defaultTargetFolderName || '默认媒体库 (/)',
        whitelistRegex: res.whitelistRegex || '',
        blacklistKeywords: Array.isArray(res.blacklistKeywords) ? res.blacklistKeywords : [],
        visualCards: Array.isArray(res.visualCards) ? res.visualCards : [],
        scanInterval: res.scanInterval ?? 5,
        washPriorityOrder: Array.isArray(res.washPriorityOrder) && res.washPriorityOrder.length ? res.washPriorityOrder : config.value.washPriorityOrder,
        ai: {
          ...AI_DEFAULTS,
          ...(res.ai || {}),
          // 移动 AI 兜底配置归一化：确保对象恒存在且键齐全，供 el-switch v-model 直写
          mobileFallback: {
            enable: (res.ai as any)?.mobileFallback?.enable !== undefined ? Boolean((res.ai as any).mobileFallback.enable) : true,
            networkSearch: (res.ai as any)?.mobileFallback?.networkSearch !== undefined ? Boolean((res.ai as any).mobileFallback.networkSearch) : true,
            proactiveRenew: Boolean((res.ai as any)?.mobileFallback?.proactiveRenew),
            timeoutMs: Number((res.ai as any)?.mobileFallback?.timeoutMs) > 0 ? Number((res.ai as any).mobileFallback.timeoutMs) : 60000,
          },
        },
      };
    }
  } catch (err: any) {
    ElMessage.error(`加载配置失败: ${err.message || '未知错误'}`);
  } finally {
    loading.value = false;
  }
}

// 监听 MainLayout 的头部保存按钮事件
function onHeaderSave() {
  handleSaveConfig();
}

// ================= 主视口 Tab 切换 (频道监控 vs 抓取历史) =================
const activeMainTab = ref<'config' | 'history'>('config');

function switchMainTab(tab: 'config' | 'history') {
  activeMainTab.value = tab;
  router.replace({ query: { ...route.query, tab } });
  if (tab === 'history') {
    loadChannelHistory(1);
  }
}

const historyLoading = ref(false);
const historyList = ref<ChannelHistoryItem[]>([]);
const channelHistoryTotal = ref(0);
const channelHistoryPage = ref(1);
const channelHistoryPageSize = ref(20);
const historyStatusFilter = ref<'' | 'success' | 'transferred' | 'skipped' | 'failed'>('');
const historySearchQuery = ref('');
const expandedRawTextIds = ref<Set<number>>(new Set());

function toggleExpandRawText(id: number) {
  if (expandedRawTextIds.value.has(id)) {
    expandedRawTextIds.value.delete(id);
  } else {
    expandedRawTextIds.value.add(id);
  }
}

async function copyText(text: string, label = '内容') {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已复制 ${label} 到剪贴板`);
  } catch (_) {
    ElMessage.info(`复制失败，请手动选择复制`);
  }
}

const failedPosters = ref<Record<string | number, boolean>>({});

function formatPosterUrl(path?: string) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `https://image.tmdb.org/t/p/w200${path.startsWith('/') ? '' : '/'}${path}`;
}

function formatSize(bytes?: number) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function formatHistoryTime(dateStr?: string | Date) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 辅助解析推文中的影视标题、季集、类型与规格标签 (高密度标准结构化解析)
function parsePostDetails(item: any) {
  const raw = item.postTitle || item.rawText || '';
  let title = item.postTitle || '';
  const nameMatch = raw.match(/名称[：:]\s*([^\n\r]+)/);
  if (nameMatch && nameMatch[1]) {
    title = nameMatch[1].trim();
  }

  // 1. 提取年份 (支持 (2024) 或 （2024） 或 独立4位年份)
  let year = '';
  const yearMatch = `${title} ${raw}`.match(/[（(]((?:19|20)\d{2})[)）]/) || `${title} ${raw}`.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    year = yearMatch[1];
  }

  // 2. 提取分集与季集规范代码 (如 S01E25, S02, E189)
  let seasonEpisode = '';
  let hasSeasonEpInTitle = false;
  const sMatch = `${title} ${raw}`.match(/\bS(\d{1,2})\s*E(\d{1,4})\b/i);
  if (sMatch) {
    seasonEpisode = `S${String(sMatch[1]).padStart(2, '0')}E${String(sMatch[2]).padStart(2, '0')}`;
    hasSeasonEpInTitle = true;
  } else {
    const cnSeMatch = `${title} ${raw}`.match(/第\s*([0-9一二三四五六七八九十]+)\s*季.*?(?:更新至\s*)?第?\s*([0-9]+)\s*[集话期]/i);
    if (cnSeMatch) {
      const sNum = /^\d+$/.test(cnSeMatch[1]) ? Number(cnSeMatch[1]) : 1;
      seasonEpisode = `S${String(sNum).padStart(2, '0')}E${String(cnSeMatch[2]).padStart(2, '0')}`;
      hasSeasonEpInTitle = true;
    } else {
      const epOnlyMatch = `${title} ${raw}`.match(/(?:\bE|\bEP|第)\s*(\d{1,4})\s*(?:[集话期]|\b)/i);
      if (epOnlyMatch) {
        seasonEpisode = `E${epOnlyMatch[1]}`;
        hasSeasonEpInTitle = true;
      } else {
        const sOnlyMatch = `${title} ${raw}`.match(/(?:\bS(\d{1,2})\b|第\s*([0-9一二三四五六七八九十]+)\s*季)/i);
        if (sOnlyMatch) {
          const sNum = sOnlyMatch[1] ? Number(sOnlyMatch[1]) : 1;
          seasonEpisode = `S${String(sNum).padStart(2, '0')}`;
          hasSeasonEpInTitle = true;
        }
      }
    }
  }

  // 3. 提取分集或进度原始徽章
  let progress = '';
  const epMatch = `${title} ${raw}`.match(/(?:更新至\s*(?:第\s*)?\d+(?:[-~至到]\d+)?\s*[集话期]?|连载至\s*(?:第\s*)?\d+\s*[集话期]?|全\s*\d+\s*[集话期]|共\s*\d+\s*[集话期]|\d+集全|完结季|完结|E\d+(?:-E\d+)?|\b\d+\s*[-~至到]\s*\d+\s*集)/i);
  if (epMatch) {
    progress = epMatch[0].trim();
  }

  // 4. 提取技术规格
  const specs: string[] = [];
  if (seasonEpisode) specs.push(seasonEpisode);
  else if (progress) specs.push(progress);

  const textToScan = `${title} ${raw}`;
  if (/4K|2160p/i.test(textToScan)) specs.push('2160p');
  else if (/1080p/i.test(textToScan)) specs.push('1080p');
  else if (/720p/i.test(textToScan)) specs.push('720p');

  if (/杜比视界|Dolby\s*Vision|\bDV\b/i.test(textToScan)) specs.push('杜比视界');
  if (/HDR10\+|HDR/i.test(textToScan)) specs.push('HDR');
  if (/10bit/i.test(textToScan)) specs.push('10bit');
  if (/60(?:fps|帧)/i.test(textToScan)) specs.push('60FPS');
  if (/50(?:fps|帧)/i.test(textToScan)) specs.push('50FPS');
  if (/H\.?265|HEVC/i.test(textToScan)) specs.push('H.265');
  else if (/H\.?264|AVC/i.test(textToScan)) specs.push('H.264');
  if (/WEB-DL/i.test(textToScan)) specs.push('WEB-DL');
  if (/Remux/i.test(textToScan)) specs.push('Remux');

  // 5. 清理纯净片名
  let cleanTitle = title
    .replace(/[丨|｜丶]/g, '')
    .replace(/^[【\[][^】\]]*[】\]]/, '')
    .replace(/[（(](?:19|20)\d{2}[)）]/g, ' ')
    .replace(/(?:更新至|连载至|更新到|更新)\s*(?:第\s*)?\d+(?:[-~至到]\d+)?\s*[集话期]?.*$/i, '')
    .replace(/(?:完结季|完结篇|终结篇|特别篇|第[一二三四五六七八九十\d]+季).*$/i, '')
    .replace(/(?:全\s*\d+\s*[集话期]|共\s*\d+\s*[集话期]|\d+集全|全集|完结).*$/i, '')
    .replace(/(?:第\s*\d+\s*[集话期]|\d+\s*[-~至到]\s*\d+\s*[集话期]).*$/i, '')
    .replace(/(?:S\d+\s*E\d+|E\d+(?:-E\d+)?).*$/i, '')
    .replace(/\b(?:4K|2160[pi]|1080[pi]|720[pi]|HDR|HDR10|DV|杜比|DOLBY|REMUX|WEB-DL|BLURAY|H\.?26[45]|HEVC|AVC|10bit|60fps|AMAZ|NF)\b.*$/i, '')
    .replace(/\s+\d{1,4}(?:\s+.*)?$/, '')
    .replace(/[（(].*?[)）]/g, '')
    .trim();

  const bookMatch = cleanTitle.match(/《([^》]+)》/);
  if (bookMatch) {
    cleanTitle = bookMatch[1].trim();
  }

  // 6. 提取分类 (优先推文显式标注: 类型: 日番 / 分类: [有声书])
  let category = '';
  const typeMatch = raw.match(/(?:类型|分类|题材)[：:\s]*\[?([^\]\s,，|·#]+)\]?/i);
  if (typeMatch && typeMatch[1]) {
    category = typeMatch[1].trim();
  } else {
    const tagMatch = raw.match(/#?(日番|国漫|动漫|国产剧|韩剧|美剧|电影|纪录片|综艺|有声书)/i);
    if (tagMatch && tagMatch[1]) {
      category = tagMatch[1].trim();
    }
  }

  let mediaTypeLabel = category || '剧集';
  let isTv = true;
  if (/电影|movie|theatrical/i.test(`${raw} ${title}`) && !seasonEpisode) {
    if (!category) category = '电影';
    mediaTypeLabel = '电影';
    isTv = false;
  } else if (/国漫|国产动画/i.test(`${raw} ${title}`)) {
    if (!category) category = '国漫';
    mediaTypeLabel = '国漫';
    isTv = true;
  } else if (/动漫|日番|番剧/i.test(`${raw} ${title}`)) {
    if (!category) category = '日番';
    mediaTypeLabel = '日番';
    isTv = true;
  } else if (/纪录片/i.test(`${raw} ${title}`)) {
    if (!category) category = '纪录片';
    mediaTypeLabel = '纪录片';
    isTv = false;
  } else if (/综艺/i.test(`${raw} ${title}`)) {
    if (!category) category = '综艺';
    mediaTypeLabel = '综艺';
    isTv = true;
  } else if (seasonEpisode || progress || /剧|季|集/i.test(`${raw} ${title}`)) {
    if (!category) category = '剧集';
    mediaTypeLabel = '剧集';
    isTv = true;
  } else {
    // 既无季集号，也无电影/动漫明确关键词（例如仅有短标题+网盘链接且未入库刮削）
    // 工业规范：禁止在无事实依据时武断脑补为“电影”，保持为“待识别”
    if (!category) category = '待识别';
    mediaTypeLabel = category;
    isTv = true;
  }

  // 组装 分类 / 年份 胶囊副文本 (如: 日番 / 2023, 电影 / 2026, 剧集, 待识别)
  let categoryYearLabel = category;
  if (category && year) {
    categoryYearLabel = `${category} / ${year}`;
  } else if (year) {
    categoryYearLabel = `${mediaTypeLabel} / ${year}`;
  }

  // 6.5 提取转存详情与海报路径
  let tmdbId = '';
  let posterPath = '';
  let targetPath = '';
  let stagingLocation = config.value.stagingFolderName || '/暂存区/频道转存';
  let sampleFilename = '';
  let fileSize = 0;
  let episodeTitle = '';
  if (item.transferredDetails) {
    try {
      const details = typeof item.transferredDetails === 'string' ? JSON.parse(item.transferredDetails) : item.transferredDetails;
      if (Array.isArray(details) && details.length > 0) {
        const found = details.find((d: any) => d && (d.tmdbId || d.tmdb_id));
        if (found) tmdbId = String(found.tmdbId || found.tmdb_id);
        const pFound = details.find((d: any) => d && (d.posterPath || d.poster_path));
        if (pFound) posterPath = pFound.posterPath || pFound.poster_path;
        const epFound = details.find((d: any) => d && d.episodeTitle);
        if (epFound) {
          episodeTitle = epFound.seasonEpisode ? `${epFound.seasonEpisode} · ${epFound.episodeTitle}` : epFound.episodeTitle;
        }

        const first = details[0];
        if (first) {
          if (first.stagingFolderPath) {
            stagingLocation = first.stagingFolderPath;
          }
          if (first.originalName) {
            sampleFilename = first.originalName;
          } else if (first.finalName) {
            sampleFilename = first.finalName;
          }
          if (first.targetFolderPath) {
            targetPath = `${first.targetFolderPath}/${first.finalName || ''}`;
          } else if (first.finalName) {
            targetPath = first.finalName;
          }
          if (first.size) {
            fileSize = Number(first.size) || 0;
          }
          if (!tmdbId && first.targetFolderPath) {
            const m = String(first.targetFolderPath).match(/\{tmdb-(\d+)\}/i);
            if (m) tmdbId = m[1];
          }

          // ★ 核心校准：从权威转存/入库结果深度反哺剧集模态、规范分集与画质规格
          const allDetailText = details.map((d: any) => `${d.originalName || ''} ${d.finalName || ''} ${d.targetFolderPath || ''}`).join(' ');
          const isDetailTv = first.mediaType === 'tv'
            || /目标目录\/剧集|Season\s*\d+|\bS\d{1,2}\s*E\d{1,4}\b|第\s*\d+\s*[季集话期]/i.test(allDetailText);

          if (isDetailTv) {
            isTv = true;
            if (first.category) {
              category = first.category;
              mediaTypeLabel = first.category;
            } else if (allDetailText.includes('/国漫/')) {
              category = '国漫';
              mediaTypeLabel = '国漫';
            } else if (allDetailText.includes('/日番/') || allDetailText.includes('/日漫/')) {
              category = '日番';
              mediaTypeLabel = '日番';
            } else if (allDetailText.includes('/欧美剧/')) {
              category = '美剧';
              mediaTypeLabel = '美剧';
            } else if (allDetailText.includes('/国产剧/')) {
              category = '国产剧';
              mediaTypeLabel = '国产剧';
            } else {
              category = '剧集';
              mediaTypeLabel = '剧集';
            }
          }

          if (!year) {
            const yrMatch = allDetailText.match(/[\(\[\{（【]\s*(19\d\d|20\d\d)\s*[\)\]\}）】]|\b(19\d\d|20\d\d)\b/);
            if (yrMatch) year = yrMatch[1] || yrMatch[2];
          }

          if (!seasonEpisode) {
            const seMatch = allDetailText.match(/\bS(\d{1,2})\s*E(\d{1,4})\b/i);
            if (seMatch) {
              seasonEpisode = `S${String(seMatch[1]).padStart(2, '0')}E${String(seMatch[2]).padStart(2, '0')}`;
              hasSeasonEpInTitle = true;
              if (!specs.includes(seasonEpisode)) specs.unshift(seasonEpisode);
            }
          }

          if (!specs.some(s => /2160p|4K/i.test(s)) && /4K|2160p/i.test(allDetailText)) specs.push('2160p');
          if (!specs.some(s => /杜比视界|DV/i.test(s)) && /杜比视界|Dolby\s*Vision|\bDV\b|\bDoVi\b/i.test(allDetailText)) specs.push('杜比视界');
          if (!specs.some(s => /HDR/i.test(s)) && /HDR10\+|HDR/i.test(allDetailText)) specs.push('HDR');
          if (!specs.some(s => /WEB-DL/i.test(s)) && /WEB-DL/i.test(allDetailText)) specs.push('WEB-DL');

          if (category && year) {
            categoryYearLabel = `${category} / ${year}`;
          } else if (year) {
            categoryYearLabel = `${mediaTypeLabel} / ${year}`;
          } else {
            categoryYearLabel = category || mediaTypeLabel;
          }
        }
      }
    } catch {}
  }

  // 7. 单行推文原文摘要 (清除换行与多余空格)
  const tweetSnippet = (item.rawText || item.postTitle || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // 8. 管道流第二步: 监控历史定位为「转存位置」，严谨区别于「整理入库」
  let pipelineStep2Label = '转存位置';
  const displayLocation = sampleFilename ? `${stagingLocation}/${sampleFilename}` : stagingLocation;
  let pipelineStep2Content = displayLocation;
  let pipelineStep2Tooltip = `转存位置: ${displayLocation}`;

  if (isSuccess(item)) {
    pipelineStep2Label = '转存位置';
    pipelineStep2Content = displayLocation;
    pipelineStep2Tooltip = `转存位置: ${displayLocation}` + (targetPath ? `\n(已就绪，后续流转媒体整理: ${targetPath})` : '');
  } else if (isFailed(item)) {
    pipelineStep2Label = '转存失败';
    pipelineStep2Content = item.reason || '网络超时或外链已失效';
    pipelineStep2Tooltip = `转存失败: ${pipelineStep2Content}`;
  } else if (isSkipped(item)) {
    pipelineStep2Label = '规则跳过';
    pipelineStep2Content = item.reason || '未命中白名单放行规则';
    pipelineStep2Tooltip = `规则跳过: ${pipelineStep2Content}`;
  } else {
    pipelineStep2Label = '转存中';
    pipelineStep2Content = '正在抓取推文并转存外链文件...';
    pipelineStep2Tooltip = '正在抓取转存中...';
  }

  // 9. 容量与时间
  let fileSizeText = '0 文件';
  if (isSuccess(item)) {
    if (fileSize > 0) {
      fileSizeText = formatSize(fileSize);
    } else if (item.transferredCount > 0) {
      fileSizeText = `+${item.transferredCount} 个文件`;
    }
  }

  const timeText = formatHistoryTime(item.createdAt);
  const pureName = cleanTitle || title || 'Telegram 推文';

  return {
    cleanTitle: pureName,
    category,
    categoryYearLabel,
    year,
    seasonEpisode,
    episodeTitle,
    hasSeasonEpInTitle,
    specs: Array.from(new Set(specs)),
    progress,
    isTv,
    mediaTypeLabel,
    tmdbId,
    posterPath,
    targetPath,
    stagingLocation,
    displayLocation,
    tweetSnippet,
    pipelineStep2Label,
    pipelineStep2Content,
    pipelineStep2Tooltip,
    fileSizeText,
    timeText,
  };
}

function getSpecBadgeClass(spec: string) {
  if (/^S\d+/i.test(spec) || /^E\d+/i.test(spec)) return 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200/80 dark:border-purple-800 font-semibold';
  if (spec === '4K' || spec === '2160p') return 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300 dark:border-amber-800 font-bold';
  if (spec === '1080p') return 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-semibold';
  if (spec === '杜比视界' || spec === 'HDR') return 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold';
  if (spec === '60FPS' || spec === '120FPS') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-semibold';
  if (spec === 'WEB-DL' || spec === 'Remux') return 'bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800';
  return 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-slate-700';
}

function getTypeBadgeClass(label: string) {
  if (label === '国漫' || label === '动漫' || label === '日番') return 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300 border border-orange-200 dark:border-orange-800';
  if (label === '电影') return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800';
  return 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800';
}

function isSuccess(item: any): boolean {
  return item && (item.status === 'success' || item.status === 'transferred');
}

function isSkipped(item: any): boolean {
  return typeof item?.status === 'string' && item.status.startsWith('skipped');
}

function isFailed(item: any): boolean {
  return item?.status === 'failed';
}

function isPending(item: any): boolean {
  return !item || !item.status || item.status === 'pending';
}

function formatDecisionReason(item: any) {
  if (isSuccess(item)) {
    return `准予放行 · 转存入暂存区${item.transferredCount ? ` (+${item.transferredCount} 个文件)` : ''}`;
  }
  if (isSkipped(item)) {
    return `规则跳过 · ${item.reason || '未命中白名单放行规则'}`;
  }
  if (isFailed(item)) {
    return `转存失败 · ${item.reason || '网络超时或外链已失效'}`;
  }
  return '正在转存处理中...';
}

// 通配符与搜索过滤
const filteredHistoryList = computed(() => {
  let list = historyList.value;
  const query = historySearchQuery.value.trim().toLowerCase();
  if (!query) return list;

  const regexPattern = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(regexPattern, 'i');

  return list.filter((item) => {
    return (
      regex.test(item.postTitle || '') ||
      regex.test(item.channelName || '') ||
      regex.test(item.rawText || '') ||
      regex.test(item.shareLink || '') ||
      regex.test(item.reason || '')
    );
  });
});

const totalHistoryPages = computed(() => Math.ceil(channelHistoryTotal.value / channelHistoryPageSize.value) || 1);

async function loadChannelHistory(page = 1) {
  channelHistoryPage.value = page;
  historyLoading.value = true;
  try {
    const res = await channelApi.getHistory({
      page,
      pageSize: channelHistoryPageSize.value,
      status: historyStatusFilter.value || undefined,
    });
    if (Array.isArray(res)) {
      historyList.value = res;
      channelHistoryTotal.value = res.length;
    } else if (res && typeof res === 'object') {
      historyList.value = res.items || res.list || [];
      channelHistoryTotal.value = res.total || historyList.value.length;
    }
  } catch (err: any) {
    ElMessage.error(err.message || '加载监控历史异常');
  } finally {
    historyLoading.value = false;
  }
}

onMounted(() => {
  if (route.query.tab === 'organize') {
    router.replace('/scrape');
    return;
  }
  if (route.query.tab === 'history') {
    activeMainTab.value = 'history';
    loadChannelHistory(1);
  }
  loadInitialData();
  window.addEventListener('header-save-click', onHeaderSave);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSave);
});
</script>

<template>
  <div class="channel-container space-y-6 w-full pb-16 text-slate-800 dark:text-slate-100">
    <!-- 顶层主视口切换：统一对齐系统标准胶囊选项卡规范 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <!-- 胶囊选项卡群组 (对齐系统 UI 规范: Telegram 频道监控 / 监控抓取历史 / 媒体整理与洗版) -->
      <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium max-w-full overflow-x-auto no-scrollbar">
        <button
          type="button"
          @click="switchMainTab('config')"
          :class="activeMainTab === 'config' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
        >
          <Radio class="w-3.5 h-3.5" />
          <span>Telegram 频道监控</span>
        </button>

        <button
          type="button"
          @click="switchMainTab('history')"
          :class="activeMainTab === 'history' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
        >
          <Clock class="w-3.5 h-3.5" />
          <span>监控抓取历史</span>
          <span v-if="channelHistoryTotal > 0" class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-700 dark:bg-slate-700 dark:text-blue-300 font-mono">
            {{ channelHistoryTotal }}
          </span>
        </button>
      </div>

      <!-- 右侧快速操作区 -->
      <div class="flex items-center gap-2">
        <button
          v-if="activeMainTab === 'config'"
          type="button"
          :disabled="syncing"
          @click="handleSyncNow"
          class="btn-default text-xs h-8 px-3 flex items-center gap-1.5 cursor-pointer font-medium text-blue-600 dark:text-blue-400"
          title="立即向 Telegram 频道拉取最新推文并转存"
        >
          <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': syncing }" />
          <span>{{ syncing ? '正在扫描...' : '扫描最新推文' }}</span>
        </button>
      </div>
    </div>

    <!-- ================= 配置面板视口 ================= -->
    <template v-if="activeMainTab === 'config'">
      <!-- ================= 模块 1: 监控总控与统一暂存区 ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Radio class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">频道监听与调度配置</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              监听 Telegram 公开频道推文并按统一规则自动转存
            </p>
          </div>
        </div>

        <!-- 监控总开关 -->
        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between mb-4">
          <div>
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">Telegram 频道监控总开关</h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              开启后系统按预设周期自动轮询频道并转存资源；关闭则停止所有频道抓取
            </p>
          </div>
          <el-switch v-model="config.enabled" />
        </div>

        <!-- 轮询周期 -->
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            频道推文轮询频率 (分钟)
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model.number="config.scanInterval"
              type="number"
              min="1"
              max="1440"
              placeholder="5"
              class="input-base font-mono text-xs w-28 sm:w-32"
            />
            <div class="flex flex-wrap items-center gap-1 text-xs">
              <button
                v-for="min in [3, 5, 10, 15, 30]"
                :key="min"
                type="button"
                class="px-2 py-1 rounded-md border text-xs font-mono cursor-pointer transition-colors"
                :class="config.scanInterval === min ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-300'"
                @click="config.scanInterval = min"
              >
                {{ min }}分
              </button>
            </div>
          </div>
          <span class="form-text">
            后台自动巡检 Telegram 频道的周期，发现新分享链接即刻自动免登转存
          </span>
        </div>
      </div>

      <!-- ================= 模块 2: 监控频道列表（卡片网格对齐 AccountsView.vue） ================= -->
      <div class="settings-card">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
              <Send class="w-5 h-5" />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">监控频道列表</h3>
                <span class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                  {{ config.channels?.length || 0 }} 个频道
                </span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                支持配置多个 Telegram 频道，多路频道并发轮询转存
              </p>
            </div>
          </div>

          <button
            v-if="!showAddChannelCard"
            type="button"
            class="btn-primary text-xs h-8 px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium shadow-xs"
            @click="openAddChannel"
          >
            <Plus class="w-3.5 h-3.5" />
            <span>添加监控频道</span>
          </button>
        </div>

        <!-- 页面内联添加频道表单（零弹窗：直接在页面流中展开与编辑） -->
        <div
          v-if="showAddChannelCard"
          class="p-4 rounded-xl border-2 border-sky-400/50 bg-sky-50/30 dark:bg-sky-950/20 mb-4 transition-all space-y-3"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Plus class="w-4 h-4 text-sky-600 dark:text-sky-400" />
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">录入新 Telegram 监控频道</h4>
            </div>
            <button
              type="button"
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              @click="showAddChannelCard = false"
            >
              <X class="w-4 h-4" />
            </button>
          </div>

          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
              频道地址或公开用户名
            </label>
            <div class="flex gap-2">
              <input
                v-model="newChannelInput"
                type="text"
                placeholder="例如: https://t.me/yunpan139 或 @yunpan139"
                class="input-base text-xs font-mono flex-1"
                @keyup.enter="confirmAddChannel"
              />
              <button
                type="button"
                class="btn-primary text-xs h-[38px] px-4 font-semibold cursor-pointer shrink-0"
                @click="confirmAddChannel"
              >
                确认添加
              </button>
              <button
                type="button"
                class="btn-default text-xs h-[38px] px-3 cursor-pointer shrink-0"
                @click="showAddChannelCard = false"
              >
                取消
              </button>
            </div>
            <p class="text-[11px] text-gray-500 dark:text-gray-400">
              支持直接粘贴以 https://t.me/ 开头的链接，或者以 @ 开头的公开频道名称（如 @yunpan139）
            </p>
          </div>
        </div>

        <!-- 频道列表卡片网格展示 (对齐 AccountsView.vue) -->
        <div v-if="!config.channels || !config.channels.length" class="text-center py-12 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl">
          <Send class="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
          <p class="text-xs text-gray-400">暂无监控频道，点击上方「添加监控频道」开始自动追更</p>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div
            v-for="(channel, idx) in config.channels"
            :key="idx"
            class="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#111827] flex flex-col justify-between hover:shadow-sm hover:border-gray-300 dark:hover:border-gray-700 transition-all relative overflow-hidden group"
          >
            <div>
              <!-- 卡片头部：状态指示与图标 -->
              <div class="flex items-start justify-between gap-2 mb-3">
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                  <!-- Telegram 图标与运行指示灯 -->
                  <div class="relative shrink-0">
                    <div class="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-950/60 border border-sky-100 dark:border-sky-800 p-2 flex items-center justify-center text-sky-500">
                      <Send class="w-5 h-5" />
                    </div>
                    <span
                      class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-[#111827]"
                      :class="config.enabled ? 'bg-emerald-500' : 'bg-gray-400'"
                      :title="config.enabled ? '实时监听中' : '监控已暂停'"
                    />
                  </div>

                  <!-- 频道名称与原位内联修改 -->
                  <div class="min-w-0 flex-1">
                    <!-- 原位编辑态 -->
                    <div v-if="editingChannelIndex === idx" class="flex items-center gap-1">
                      <input
                        v-model="inlineEditChannelValue"
                        type="text"
                        class="input-base !h-7 !text-xs !py-0 !px-2 flex-1 font-mono"
                        @keyup.enter="saveEditChannel(idx)"
                      />
                      <button
                        type="button"
                        class="p-1 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 cursor-pointer"
                        title="保存修改"
                        @click="saveEditChannel(idx)"
                      >
                        <Check class="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        class="p-1 rounded text-gray-400 hover:text-gray-600 cursor-pointer"
                        title="取消"
                        @click="cancelEditChannel"
                      >
                        <X class="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <!-- 正常展示态 -->
                    <div v-else class="flex items-center gap-1.5">
                      <h4 class="text-xs font-bold text-gray-900 dark:text-white truncate" :title="channel">
                        {{ channel.replace('https://t.me/', '@') }}
                      </h4>
                      <button
                        type="button"
                        class="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                        title="编辑地址"
                        @click="startEditChannel(idx)"
                      >
                        <Edit3 class="w-3 h-3" />
                      </button>
                    </div>

                    <div class="text-[11px] text-gray-400 truncate mt-0.5 font-mono">
                      {{ channel }}
                    </div>
                  </div>
                </div>

                <!-- 频道外链小按钮 -->
                <a
                  :href="channel.startsWith('http') ? channel : `https://t.me/${channel.replace('@', '')}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-gray-400 hover:text-sky-500 cursor-pointer p-1"
                  title="在 Telegram 中打开"
                >
                  <ExternalLink class="w-3.5 h-3.5" />
                </a>
              </div>

                <!-- 运行状态指示条 -->
                <div class="flex items-center gap-2 pt-1 text-[11px]">
                  <span
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium text-[10.5px]"
                    :class="config.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'"
                  >
                    <span class="w-1.5 h-1.5 rounded-full" :class="config.enabled ? 'bg-emerald-500' : 'bg-gray-400'" />
                    <span>{{ config.enabled ? '实时监听中' : '监控已暂停' }}</span>
                  </span>
                  <span class="text-gray-400 font-mono text-[10.5px]">每 {{ config.scanInterval || 5 }} 分钟轮询</span>
                </div>
              </div>

              <!-- 卡片底栏操作区 -->
              <div class="pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-2 mt-2">
                <span class="text-[10px] text-gray-400 font-mono">频道 #{{ idx + 1 }}</span>

                <!-- 原位删除确认胶囊 (零弹窗规范) -->
                <div v-if="deletingChannelIndex === idx" class="flex items-center gap-1">
                  <span class="text-[11px] text-red-500 font-medium">确认删除?</span>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[11px] bg-red-600 text-white font-medium cursor-pointer hover:bg-red-700"
                    @click="confirmRemoveChannel(idx)"
                  >
                    是
                  </button>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer hover:bg-gray-200"
                    @click="deletingChannelIndex = null"
                  >
                    否
                  </button>
                </div>

              <button
                v-else
                type="button"
                class="text-gray-400 hover:text-red-500 cursor-pointer p-1"
                title="删除频道"
                @click="deletingChannelIndex = idx"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= 模块 3: 关键词过滤与规则策略 ================= -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
            <Filter class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">推文放行规则与过滤策略</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              白名单正则、黑名单一票否决与 TMDB 影视监控规则卡片
            </p>
          </div>
        </div>

        <!-- 统一文字说明区 -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
            <span>推文过滤放行裁决机制</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>双重过滤机制</strong>：白名单规则优先匹配放行（留空代表全量放行）；黑名单关键词一票否决拦截（如广告、特定标签）。</li>
            <li>• <strong>指定追剧卡片</strong>：点击下方「+ 检索 TMDB 影视」按片名直接生成带有海报与规格限制的智能卡片，并可一键转换为白名单过滤规则。</li>

          </ul>
        </div>

        <!-- 白名单大正则 -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
              白名单放行正则表达式
            </label>
            <button
              type="button"
              class="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-700 font-semibold flex items-center gap-1 cursor-pointer"
              @click="handleCompileCardsToRegex"
            >
              <Sparkles class="w-3.5 h-3.5" />
              <span>从卡片重新编译回填</span>
            </button>
          </div>
          <textarea
            v-model="config.whitelistRegex"
            rows="2"
            placeholder="留空代表不设白名单限制（例如: (?:(?=.*(?:4K|2160p)).*(?:庆余年))|(?:三体)）"
            class="input-base !h-auto py-2 font-mono text-xs leading-relaxed"
          />
        </div>

        <!-- 黑名单关键词 -->
        <div class="mb-5">
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            黑名单关键词 (命中任意一项立即阻断转存)
          </label>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <span
              v-for="kw in config.blacklistKeywords"
              :key="kw"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              <span>{{ kw }}</span>
              <button
                type="button"
                class="text-slate-400 hover:text-red-500 font-bold ml-0.5 cursor-pointer leading-none"
                title="删除关键词"
                @click="removeBlacklistKeyword(kw)"
              >
                &times;
              </button>
            </span>
          </div>
          <div class="flex gap-2 max-w-sm">
            <input
              v-model="newBlacklistInput"
              type="text"
              placeholder="输入过滤词并回车添加"
              class="input-base text-xs"
              @keyup.enter="addBlacklistKeyword"
            />
            <button
              type="button"
              class="btn-default text-xs h-[38px] px-3.5 shrink-0 cursor-pointer font-medium"
              @click="addBlacklistKeyword"
            >
              添加
            </button>
          </div>
        </div>

        <!-- TMDB 规则卡片工作台 -->
        <div class="mb-5">
          <div class="flex items-center justify-between mb-2">
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
              TMDB 监控规则卡片 ({{ config.visualCards?.length || 0 }} 张)
            </label>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="btn-default text-xs h-8 px-3 flex items-center gap-1 cursor-pointer font-medium text-purple-600 dark:text-purple-400"
                @click="inlineTmdbSearchOpen = !inlineTmdbSearchOpen; inlineCustomRegexOpen = false"
              >
                <Clapperboard class="w-3.5 h-3.5" />
                <span>{{ inlineTmdbSearchOpen ? '收起检索' : '+ 检索 TMDB 影视' }}</span>
              </button>
              <button
                type="button"
                class="btn-default text-xs h-8 px-3 flex items-center gap-1 cursor-pointer font-medium"
                @click="inlineCustomRegexOpen = !inlineCustomRegexOpen; inlineTmdbSearchOpen = false"
              >
                <Code class="w-3.5 h-3.5 text-blue-500" />
                <span>{{ inlineCustomRegexOpen ? '收起' : '+ 自定义正则' }}</span>
              </button>

              <!-- 原位清空卡片确认 (零弹窗规范) -->
              <div v-if="clearingCardsConfirm" class="flex items-center gap-1">
                <span class="text-[11px] text-red-500">确认清空?</span>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded text-[11px] bg-red-600 text-white cursor-pointer"
                  @click="handleClearAllCards"
                >
                  确定
                </button>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
                  @click="clearingCardsConfirm = false"
                >
                  取消
                </button>
              </div>
              <button
                v-else-if="config.visualCards && config.visualCards.length"
                type="button"
                class="btn-default text-xs h-8 px-2.5 text-gray-400 hover:text-red-500 cursor-pointer"
                title="清空卡片"
                @click="handleClearAllCards"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- 零弹窗内联展开：TMDB 影视检索与选用 -->
          <div
            v-if="inlineTmdbSearchOpen"
            class="p-4 rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/20 mb-3 space-y-3"
          >
            <div class="flex items-center gap-2">
              <input
                v-model="tmdbSearchTitle"
                type="text"
                placeholder="输入电影或电视剧片名 (如: 庆余年, 繁花, 三体)"
                class="input-base text-xs flex-1 min-w-0 !h-9 text-gray-800 dark:text-gray-100"
                @keyup.enter="handleSearchTmdb"
              />
              <input
                v-model="tmdbSearchYear"
                type="text"
                placeholder="年份(可选)"
                class="input-base text-xs !w-24 shrink-0 !h-9 text-gray-800 dark:text-gray-100 font-mono"
                @keyup.enter="handleSearchTmdb"
              />
              <button
                type="button"
                class="btn-primary text-xs h-9 px-4 flex items-center gap-1.5 cursor-pointer font-medium shrink-0"
                :disabled="tmdbSearching"
                @click="handleSearchTmdb"
              >
                <Search class="w-3.5 h-3.5" />
                <span>{{ tmdbSearching ? '检索中...' : '搜索' }}</span>
              </button>
            </div>

            <!-- 候选列表 -->
            <div v-if="tmdbCandidates.length" class="space-y-2 max-h-64 overflow-y-auto pr-1">
              <div
                v-for="item in tmdbCandidates"
                :key="item.id"
                class="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-white dark:bg-gray-900 border border-purple-100 dark:border-purple-900/50"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="w-10 h-14 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden shrink-0">
                    <img
                      v-if="item.posterPath"
                      :src="item.posterPath.startsWith('http') ? item.posterPath : `https://image.tmdb.org/t/p/w200${item.posterPath}`"
                      class="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <Film v-else class="w-4 h-4 text-gray-400 m-auto mt-5" />
                  </div>
                  <div class="min-w-0">
                    <h5 class="text-xs font-bold text-gray-900 dark:text-white truncate">
                      {{ item.chineseTitle || item.name || item.title }}
                    </h5>
                    <p class="text-[10px] text-gray-400 font-mono">
                      {{ item.year || '年份未知' }} · ID: {{ item.id }}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  class="btn-primary text-xs h-7 px-3 shrink-0 cursor-pointer"
                  @click="handleAddTmdbCard(item)"
                >
                  添加为卡片
                </button>
              </div>
            </div>
          </div>

          <!-- 零弹窗内联展开：自定义正则卡片 -->
          <div
            v-if="inlineCustomRegexOpen"
            class="p-4 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20 mb-3 space-y-3"
          >
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">规则名称</label>
                <input
                  v-model="customRegexName"
                  type="text"
                  placeholder="例如: 4K 原盘极清"
                  class="input-base text-xs !h-8"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">匹配正则表达式</label>
                <input
                  v-model="customRegexPattern"
                  type="text"
                  placeholder="例如: (?:4K|2160p|Remux)"
                  class="input-base text-xs font-mono !h-8"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="btn-default text-xs h-7 px-3 cursor-pointer"
                @click="inlineCustomRegexOpen = false"
              >
                取消
              </button>
              <button
                type="button"
                class="btn-primary text-xs h-7 px-3 cursor-pointer font-medium"
                @click="handleAddCustomRegexCard"
              >
                确认添加
              </button>
            </div>
          </div>

          <!-- 卡片展示网格 -->
          <div v-if="!config.visualCards || !config.visualCards.length" class="text-center py-8 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl text-xs text-gray-400">
            暂无影视监控卡片。点击上方「+ 检索 TMDB 影视」按剧名自动生成带有海报与规格限制的智能卡片。
          </div>
          <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div
              v-for="card in config.visualCards"
              :key="card.id"
              class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between"
            >
              <!-- 自定义正则卡片 -->
              <div v-if="card.type === 'custom'" class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                    自定义正则
                  </span>
                  <button
                    type="button"
                    class="text-gray-400 hover:text-red-500 cursor-pointer text-xs font-bold leading-none"
                    @click="removeVisualCard(card.id)"
                  >
                    &times;
                  </button>
                </div>
                <h4 class="text-xs font-bold text-gray-900 dark:text-white">{{ card.name }}</h4>
                <p class="text-[11px] font-mono text-gray-600 dark:text-gray-300 break-all bg-white dark:bg-slate-900 p-1.5 rounded border border-gray-100 dark:border-gray-800">
                  {{ card.pattern }}
                </p>
              </div>

              <!-- TMDB 影视卡片 -->
              <div v-else class="space-y-2">
                <div class="flex gap-2.5">
                  <div class="w-12 h-16 bg-gray-200 dark:bg-gray-800 rounded-lg overflow-hidden shrink-0 border border-gray-200 dark:border-gray-700 flex items-center justify-center">
                    <img
                      v-if="card.posterPath"
                      :src="card.posterPath.startsWith('http') ? card.posterPath : `https://image.tmdb.org/t/p/w200${card.posterPath}`"
                      :alt="card.title"
                      class="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <Film v-else class="w-5 h-5 text-gray-400" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-1">
                      <h4 class="text-xs font-bold text-gray-900 dark:text-white truncate" :title="card.title">
                        {{ card.title }}
                      </h4>
                      <button
                        type="button"
                        class="text-gray-400 hover:text-red-500 cursor-pointer text-xs font-bold leading-none shrink-0"
                        @click="removeVisualCard(card.id)"
                      >
                        &times;
                      </button>
                    </div>
                    <p class="text-[10px] text-gray-400 truncate mt-0.5">{{ card.originalTitle || '-' }}</p>
                    <div class="flex items-center gap-1.5 mt-1 font-mono text-[10px] text-gray-500 dark:text-gray-400">
                      <span>{{ card.year || '年份未知' }}</span>
                      <span>·</span>
                      <span>ID: {{ card.tmdbId }}</span>
                    </div>
                  </div>
                </div>

                <!-- 规格限定胶囊 -->
                <div class="flex items-center gap-1.5 pt-1.5 border-t border-gray-200/60 dark:border-gray-700/60">
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer border"
                    :class="card.limitations?.includes('4K') ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-400'"
                    @click="toggleCardLimitation(card.id, '4K')"
                  >
                    {{ card.limitations?.includes('4K') ? '✓ 4K' : '+ 4K' }}
                  </button>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer border"
                    :class="card.limitations?.includes('完整剧集') ? 'bg-purple-600 text-white border-purple-600' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-purple-400'"
                    @click="toggleCardLimitation(card.id, '完整剧集')"
                  >
                    {{ card.limitations?.includes('完整剧集') ? '✓ 完结' : '+ 完结' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= 模块 4: AI 智能识别配置 ================= -->
      <div class="settings-card">
        <!-- 卡片头：图标 + 标题 + 生效态徽标 -->
        <div class="flex items-center justify-between gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="module-icon-badge module-icon-badge--indigo">
              <Sparkles class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">AI 智能识别配置</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                大模型自然语言处理（NLP）深度清洗推文与暗号，无缝联动 TMDB 官方接口完成准入归档
              </p>
            </div>
          </div>
          <span
            class="status-pill"
            :class="aiEffectiveBadge.active ? 'status-pill--success' : 'status-pill--neutral'"
            :title="aiEffectiveBadge.label"
          >
            {{ aiEffectiveBadge.label }}
          </span>
        </div>

        <!-- 链路关系说明区：白名单管放行、AI 管识别归档，二者互不替代 -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>白名单过滤与 AI 识别的链路关系</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>过滤在前</strong>：白名单正则、黑名单关键词与规则卡片先裁决推文是否放行进入转存（白名单留空代表全量放行）。</li>
            <li>• <strong>AI 与 TMDB 在后</strong>：放行进入整理的推文由 AI 清洗提纯片名，再由 TMDB 校验锁定标准 ID 与分季归档，二者分工明确。</li>
          </ul>
        </div>

        <!-- 启用开关行 -->
        <div class="switch-row mb-4">
          <div class="space-y-0.5 pr-3">
            <span class="switch-row__title">启用 AI 智能识别</span>
            <p class="switch-row__desc">
              开启后按所选模式介入影视识别链路（连接测试与试算不受此开关限制）
            </p>
          </div>
          <el-switch v-model="aiForm.enable" />
        </div>

        <!-- 识别介入模式（二选一） + 模式差异说明 -->
        <div class="mb-4">
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">识别介入模式（二选一）</label>
          <div class="tab-pill-group mb-2">
            <button
              type="button"
              class="tab-pill"
              :class="{ 'tab-pill--active': aiForm.mode === 'fallback' }"
              @click="aiForm.mode = 'fallback'"
            >
              兜底增强（fallback）
            </button>
            <button
              type="button"
              class="tab-pill"
              :class="{ 'tab-pill--active': aiForm.mode === 'always' }"
              @click="aiForm.mode = 'always'"
            >
              AI 优先（always）
            </button>
          </div>
          <div class="p-2.5 rounded-lg bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200/60 dark:border-blue-900/40 text-[11px] text-blue-800 dark:text-blue-300 leading-relaxed">
            <span class="font-medium">{{ aiForm.mode === 'always' ? '★ AI 优先模式：' : '★ 兜底增强模式：' }}</span>
            {{ aiForm.mode === 'always'
              ? '所有推文均先由 AI 深度提纯出纯净中文片名与年份，再请求 TMDB 官方接口锁定权威 tmdbId。攻克表情符号与防封暗号，TMDB 联动绝对保留。'
              : '常规规则与 TMDB 先直接匹配，未命中或存在干扰时才由 AI 兜底判定；兼顾极速处理与 Token 节省。'
            }}
          </div>
        </div>

        <!-- AI 模型服务双引擎配置 (自定义 AI + 内置免密通道) -->
        <div class="space-y-3.5 mb-5">
          <!-- 1. 自定义 AI 服务 (OpenAI 协议兼容) -->
          <div class="p-3.5 rounded-xl bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                自定义 AI 服务 (OpenAI 协议兼容)
              </span>
              <span class="text-[11px] text-gray-400">支持 OpenAI / Gemini / DeepSeek / 本地 Ollama 等</span>
            </div>

            <!-- 服务参数三输入项 -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">服务地址 (Base URL)</label>
                <input
                  v-model="aiForm.baseUrl"
                  type="text"
                  placeholder="例如: http://127.0.0.1:8045/v1"
                  class="input-base font-mono text-xs w-full"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">API Key</label>
                <input
                  v-model="aiForm.apiKey"
                  type="password"
                  autocomplete="off"
                  placeholder="sk-...（已配置时以掩码呈现）"
                  class="input-base font-mono text-xs w-full"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">模型名称</label>
                <input
                  v-model="aiForm.model"
                  type="text"
                  placeholder="例如: gemini-3.8-flash-tiered"
                  class="input-base font-mono text-xs w-full"
                />
              </div>
            </div>

            <!-- 自定义 AI 测试连接按钮与反馈 -->
            <div class="flex flex-col sm:flex-row sm:items-center gap-3 pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
              <button
                type="button"
                class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium shrink-0"
                :disabled="aiTestLoading"
                @click="handleTestAiConnection"
              >
                <RotateCw v-if="aiTestLoading" class="w-3.5 h-3.5 animate-spin" />
                <Send v-else class="w-3.5 h-3.5" />
                <span>{{ aiTestLoading ? '测试中...' : '测试自定义 AI 连通' }}</span>
              </button>

              <div v-if="aiTestResult" class="flex items-center gap-2 min-w-0 flex-wrap">
                <span v-if="aiTestResult.success" class="status-pill status-pill--success">
                  连接成功 · 延迟 {{ aiTestResult.latencyMs ?? '—' }}ms · 模型 {{ aiTestResult.model || '—' }}
                </span>
                <span v-else class="status-pill status-pill--danger">连接失败</span>
                <span
                  v-if="aiTestResult.success && aiTestResult.reply"
                  class="text-[11px] text-gray-500 dark:text-gray-400 truncate max-w-xs"
                  :title="aiTestResult.reply"
                >
                  {{ aiTestResult.reply }}
                </span>
                <span
                  v-else-if="!aiTestResult.success && aiTestResult.error"
                  class="text-[11px] text-rose-600 dark:text-rose-400 truncate max-w-xs"
                  :title="aiTestResult.error"
                >
                  {{ aiTestResult.error }}
                </span>
              </div>
            </div>
          </div>

          <!-- 2. 内置免密智能通道 (自动兜底) -->
          <div class="p-3.5 rounded-xl bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60">
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="space-y-0.5 pr-3">
                <span class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                  内置免密智能通道（自动兜底）
                </span>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  无需配置额外 API Key；当自定义 AI 未配置或接口不可用时，自动调度系统内置通道完成语义解析与联网校准
                </p>
              </div>
              <el-switch v-model="mobileFallbackForm.enable" />
            </div>

            <template v-if="mobileFallbackForm.enable">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-2.5 border-t border-slate-200/60 dark:border-slate-700/50">
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0">
                    <span class="text-xs font-medium text-gray-700 dark:text-gray-300">联网搜索核实</span>
                    <p class="text-[10px] text-gray-500 dark:text-gray-400 truncate">识别影视时联网核实首播年份与官方正式译名</p>
                  </div>
                  <el-switch v-model="mobileFallbackForm.networkSearch" size="small" />
                </div>
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0">
                    <span class="text-xs font-medium text-gray-700 dark:text-gray-300">凭证主动续期</span>
                    <p class="text-[10px] text-gray-500 dark:text-gray-400 truncate">后台自动接力刷新免密凭据，长期稳定免维护</p>
                  </div>
                  <el-switch v-model="mobileFallbackForm.proactiveRenew" size="small" />
                </div>
              </div>

              <!-- 内置通道连通性测试 -->
              <div class="flex flex-col sm:flex-row sm:items-center gap-2.5 mt-3 pt-2 border-t border-slate-200/50 dark:border-slate-700/50">
                <button
                  type="button"
                  class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium shrink-0"
                  :disabled="mobileAiTestLoading"
                  @click="handleTestMobileAiConnection"
                >
                  <RotateCw v-if="mobileAiTestLoading" class="w-3.5 h-3.5 animate-spin" />
                  <Send v-else class="w-3.5 h-3.5" />
                  <span>{{ mobileAiTestLoading ? '测试中...' : '测试内置通道连通' }}</span>
                </button>
                <div v-if="mobileAiTestResult" class="flex items-center gap-2 min-w-0 flex-wrap">
                  <span v-if="mobileAiTestResult.success" class="status-pill status-pill--success">
                    内置通道正常 · 延迟 {{ mobileAiTestResult.latencyMs ?? '—' }}ms
                  </span>
                  <span v-else class="status-pill status-pill--danger">内置通道不可达</span>
                  <span
                    v-if="!mobileAiTestResult.success && mobileAiTestResult.error"
                    class="text-[11px] text-rose-600 dark:text-rose-400 truncate max-w-xs"
                    :title="mobileAiTestResult.error"
                  >
                    {{ mobileAiTestResult.error }}
                  </span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- AI 试算推文识别入口 -->
        <div class="flex items-center justify-between gap-2 mb-3">
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
            AI 推文识别试算（仅本地体验，不影响线上转存与任何规则配置）
          </label>
          <button
            type="button"
            class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium shrink-0"
            @click="toggleAiTrialPanel"
          >
            <Sparkles class="w-3.5 h-3.5 text-indigo-500" />
            <span>{{ aiTrialOpen ? '收起试算' : 'AI 试算推文识别' }}</span>
          </button>
        </div>

        <!-- 试算内联面板（零弹窗，收起时保留输入与结果） -->
        <div v-if="aiTrialOpen" class="inline-panel inline-panel--indigo space-y-3">
          <div class="flex items-center gap-2">
            <textarea
              v-model="aiTrialText"
              rows="4"
              placeholder="粘贴含防封干扰字符的 Telegram 推文原文，AI 将提取片名、季集与规格信息..."
              class="input-base !h-auto py-2 text-xs leading-relaxed flex-1 font-mono"
              :disabled="aiTrialLoading"
            />
          </div>

          <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] text-gray-500 dark:text-gray-400">
              试算结果仅用于预览识别质量，与线上转存链路完全隔离
            </p>
            <button
              type="button"
              class="btn-primary text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium shrink-0"
              :disabled="aiTrialLoading"
              @click="handleParseTweet"
            >
              <RotateCw v-if="aiTrialLoading" class="w-3.5 h-3.5 animate-spin" />
              <Search v-else class="w-3.5 h-3.5" />
              <span>{{ aiTrialLoading ? '识别中...' : '开始识别' }}</span>
            </button>
          </div>

          <!-- 失败错误条（输入内容保留） -->
          <div v-if="aiTrialError" class="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded-xl text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
            识别失败: {{ aiTrialError }}
          </div>

          <!-- 结构化结果网格：缓存命中徽标 + 11 字段 -->
          <div v-if="aiTrialResult" class="space-y-2">
            <div v-if="aiTrialResult.fromCache" class="flex items-center gap-2">
              <span class="status-pill status-pill--info">缓存命中（10 分钟内相同文本）</span>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">片名</div>
                <div class="font-bold text-gray-900 dark:text-white break-all">{{ aiTrialResult.title || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">原名</div>
                <div class="font-medium text-gray-800 dark:text-gray-200 break-all">{{ aiTrialResult.originalTitle || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">年份</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.year || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">媒体类型</div>
                <div class="font-medium text-gray-800 dark:text-gray-200">{{ formatAiMediaType(aiTrialResult.mediaType) }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">季号</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.season ?? '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">集号</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.episode ?? '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">二级分类</div>
                <div class="font-medium text-gray-800 dark:text-gray-200">{{ aiTrialResult.category || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">视频格式</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.videoFormat || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">视频编码</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.videoCodec || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">动态范围</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ aiTrialResult.dynamicRange || '—' }}</div>
              </div>
              <div class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-800">
                <div class="text-[10px] text-gray-400 mb-0.5">置信度</div>
                <div class="font-mono text-gray-800 dark:text-gray-200">{{ formatAiConfidence(aiTrialResult.confidence) }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>



    <!-- ================= 监控抓取历史视口 (统一对齐媒体整理 UI 规范) ================= -->
    <template v-else-if="activeMainTab === 'history'">
      <div class="space-y-4">
        <!-- 顶栏工具栏 (去冗余标题，保留搜索与状态胶囊规范) -->
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <!-- 左侧搜索与流水统计 -->
          <div class="flex items-center gap-3 flex-1 max-w-md">
            <div class="relative flex-1">
              <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                v-model="historySearchQuery"
                placeholder="搜索片名 / 推文 / 139外链 (支持 * ? 通配符)"
                class="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-blue-500"
              />
              <button
                v-if="historySearchQuery"
                @click="historySearchQuery = ''"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
            <span class="text-xs text-slate-400 dark:text-slate-500 font-mono shrink-0">
              共 {{ channelHistoryTotal }} 条流水 · {{ totalHistoryPages }} 页
            </span>
          </div>

          <!-- 右侧状态快捷过滤胶囊与刷新按钮 -->
          <div class="flex items-center gap-2">
            <div class="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
              <button
                type="button"
                @click="historyStatusFilter = ''; loadChannelHistory(1)"
                :class="historyStatusFilter === '' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
                class="px-3 py-1 rounded-lg transition-all cursor-pointer"
              >
                全部
              </button>
              <button
                type="button"
                @click="historyStatusFilter = 'success'; loadChannelHistory(1)"
                :class="historyStatusFilter === 'success' || historyStatusFilter === 'transferred' ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
                class="px-3 py-1 rounded-lg transition-all cursor-pointer"
              >
                成功
              </button>
              <button
                type="button"
                @click="historyStatusFilter = 'skipped'; loadChannelHistory(1)"
                :class="historyStatusFilter === 'skipped' ? 'bg-white dark:bg-slate-700 text-amber-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
                class="px-3 py-1 rounded-lg transition-all cursor-pointer"
              >
                跳过
              </button>
              <button
                type="button"
                @click="historyStatusFilter = 'failed'; loadChannelHistory(1)"
                :class="historyStatusFilter === 'failed' ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
                class="px-3 py-1 rounded-lg transition-all cursor-pointer"
              >
                失败
              </button>
            </div>

            <!-- 刷新按钮 -->
            <button
              type="button"
              @click="loadChannelHistory(channelHistoryPage)"
              class="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
              title="刷新列表"
            >
              <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': historyLoading }" />
            </button>
          </div>
        </div>

        <!-- 历史流水列表卡片 (与媒体整理保持 100% 结构化排版规范) -->
        <div class="settings-card !p-0 overflow-hidden">
          <div v-if="historyLoading && historyList.length === 0" class="p-16 text-center text-slate-400 text-xs">
            <RotateCw class="w-7 h-7 animate-spin mx-auto mb-2 text-blue-500" />
            正在加载监控抓取历史流水...
          </div>
          <div v-else-if="filteredHistoryList.length === 0" class="p-16 text-center text-slate-400 text-xs">
            暂无符合条件的 Telegram 推文抓取记录
          </div>
          <div v-else class="p-4 space-y-2.5">
            <div
              v-for="item in filteredHistoryList"
              :key="item.id"
              class="p-3.5 md:p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs transition-all flex flex-col gap-2.5"
            >
              <!-- 第一行: 媒体标题与状态控制行 (横向通栏) -->
              <div class="flex items-center justify-between gap-3 flex-wrap lg:flex-nowrap">
                <!-- 左侧: (海报/图标) + 片名 + 分类/年份 + 官方单集标题 + 规格徽章 -->
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                  <!-- 海报微缩图或图标 (有海报显示紧凑海报 w-7 h-9.5，无海报则显示精致媒体图标 w-7 h-7，不再占位大灰框) -->
                  <div
                    v-if="parsePostDetails(item).posterPath && !failedPosters[item.id]"
                    class="w-7 h-9.5 rounded overflow-hidden shrink-0 border border-slate-200/80 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-800 shadow-2xs group/poster relative"
                  >
                    <img
                      :src="formatPosterUrl(parsePostDetails(item).posterPath)"
                      :alt="parsePostDetails(item).cleanTitle"
                      class="w-full h-full object-cover transition-transform duration-300 group-hover/poster:scale-110"
                      loading="lazy"
                      @error="failedPosters[item.id] = true"
                    />
                  </div>
                  <div
                    v-else
                    class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 border border-slate-200/60 dark:border-slate-700/60"
                    :class="{
                      'text-blue-500': isSuccess(item),
                      'text-amber-500': isFailed(item),
                      'text-indigo-500': isSkipped(item),
                      'text-slate-400': isPending(item)
                    }"
                  >
                    <Tv v-if="parsePostDetails(item).isTv" class="w-4 h-4" />
                    <Film v-else class="w-4 h-4" />
                  </div>

                  <!-- 片名、分类与标签 -->
                  <div class="flex items-center gap-2 min-w-0 flex-wrap">
                    <h4
                      class="text-sm font-bold text-slate-900 dark:text-white leading-snug truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      :title="`点击复制片名: ${parsePostDetails(item).cleanTitle}`"
                      @click="copyText(parsePostDetails(item).cleanTitle, '片名')"
                    >
                      {{ parsePostDetails(item).cleanTitle }}
                    </h4>

                    <span class="text-xs text-slate-400 dark:text-slate-500 font-medium shrink-0">
                      {{ parsePostDetails(item).categoryYearLabel }}
                    </span>

                    <span
                      v-if="parsePostDetails(item).episodeTitle"
                      class="text-xs text-indigo-600 dark:text-indigo-400 font-medium truncate flex items-center gap-1 shrink-0"
                      :title="parsePostDetails(item).episodeTitle"
                    >
                      <span class="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0"></span>
                      {{ parsePostDetails(item).episodeTitle }}
                    </span>

                    <!-- 规格徽章 -->
                    <div v-if="parsePostDetails(item).specs.length > 0" class="flex items-center gap-1 shrink-0">
                      <span
                        v-for="spec in parsePostDetails(item).specs.slice(0, 4)"
                        :key="spec"
                        class="px-1.5 py-0.2 rounded text-[10.5px] font-mono font-medium"
                        :class="getSpecBadgeClass(spec)"
                      >
                        {{ spec }}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- 右侧: 来源频道、推文链接、网盘链接、状态与时间 -->
                <div class="flex items-center gap-2.5 sm:gap-3 shrink-0 text-xs">
                  <span class="text-slate-400 dark:text-slate-500 font-mono">
                    {{ item.channelName ? `@${item.channelName.replace('@', '')}` : 'TG 频道' }}
                  </span>

                  <a
                    v-if="item.postUrl"
                    :href="item.postUrl"
                    target="_blank"
                    class="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5 font-medium"
                    title="打开原始 Telegram 推文"
                  >
                    <span>推文 #{{ item.messageId || '查看' }}</span>
                    <ExternalLink class="w-2.5 h-2.5 shrink-0" />
                  </a>

                  <!-- 139 网盘链接 -->
                  <div class="flex items-center gap-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"></span>
                    <span class="text-slate-500 dark:text-slate-400 font-medium">139云盘</span>
                    <template v-if="item.shareLink">
                      <button
                        type="button"
                        class="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer ml-0.5"
                        title="复制链接与提取码"
                        @click="copyText(item.accessCode ? `${item.shareLink} 提取码: ${item.accessCode}` : item.shareLink, '139 链接与提取码')"
                      >
                        复制
                      </button>
                      <a
                        :href="item.shareLink"
                        target="_blank"
                        class="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5 ml-1"
                        title="在浏览器中直接打开 139 分享"
                      >
                        <span>打开</span>
                        <ExternalLink class="w-2.5 h-2.5 shrink-0" />
                      </a>
                    </template>
                  </div>

                  <!-- 状态单行胶囊标签 -->
                  <span
                    class="px-2 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0"
                    :class="{
                      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800': isSuccess(item),
                      'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800': isFailed(item),
                      'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700': isSkipped(item),
                      'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800': isPending(item)
                    }"
                  >
                    {{ isSuccess(item) ? '成功入库' : (isSkipped(item) ? '规则跳过' : (isFailed(item) ? '转存异常' : '转存处理中')) }}
                  </span>

                  <!-- 容量与时间 -->
                  <div class="text-right font-mono text-[11.5px] text-slate-500 dark:text-slate-400">
                    <span>{{ parsePostDetails(item).fileSizeText }}</span>
                    <span class="mx-1 opacity-40">·</span>
                    <span>{{ parsePostDetails(item).timeText }}</span>
                  </div>
                </div>
              </div>

              <!-- 第二行: 执行流水线全宽区域（不再缩进，充分利用整行空间展示推文原文与入库路径/跳过理由） -->
              <div class="bg-slate-50/70 dark:bg-slate-800/40 rounded-lg px-3 py-2 border border-slate-100 dark:border-slate-800/80 flex items-stretch gap-2.5">
                <!-- 贯穿线节点 -->
                <div class="flex flex-col items-center justify-between py-0.5 shrink-0">
                  <span class="w-2 h-2 rounded-full border-2 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"></span>
                  <span class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-0.5"></span>
                  <span
                    class="w-2 h-2 rounded-full shrink-0"
                    :class="{
                      'bg-emerald-500': isSuccess(item),
                      'bg-rose-500': isFailed(item),
                      'bg-amber-400': isSkipped(item),
                      'bg-blue-400 animate-pulse': isPending(item)
                    }"
                  ></span>
                </div>

                <!-- 双行全宽路径与推文 -->
                <div class="flex-1 min-w-0 flex flex-col justify-between gap-1 text-xs">
                  <!-- 行 1: 推文原文摘要 -->
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-[11px] text-slate-400 font-medium shrink-0">推文</span>
                    <span class="text-slate-600 dark:text-slate-300 truncate font-sans select-all hover:text-clip" :title="item.rawText || item.postTitle">
                      {{ parsePostDetails(item).tweetSnippet }}
                    </span>
                  </div>

                  <!-- 行 2: 入库路径 或 裁决/跳过理由 -->
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="text-[11px] font-medium shrink-0"
                      :class="{
                        'text-emerald-600 dark:text-emerald-400': isSuccess(item),
                        'text-rose-600 dark:text-rose-400': isFailed(item),
                        'text-amber-600 dark:text-amber-400': isSkipped(item),
                        'text-blue-600 dark:text-blue-400': isPending(item)
                      }"
                    >
                      {{ parsePostDetails(item).pipelineStep2Label }}
                    </span>
                    <span
                      class="truncate select-all hover:text-clip"
                      :class="{
                        'text-emerald-700 dark:text-emerald-300 font-mono': isSuccess(item),
                        'text-rose-600 dark:text-rose-400 font-medium': isFailed(item),
                        'text-amber-700 dark:text-amber-400': isSkipped(item),
                        'text-blue-600 dark:text-blue-400': isPending(item)
                      }"
                      :title="parsePostDetails(item).pipelineStep2Tooltip"
                    >
                      {{ parsePostDetails(item).pipelineStep2Content }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 分页栏 (对齐媒体整理) -->
          <div v-if="channelHistoryTotal > channelHistoryPageSize" class="p-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
            <div>第 {{ channelHistoryPage }} 页 / 共 {{ totalHistoryPages }} 页</div>
            <div class="flex gap-2">
              <button
                type="button"
                :disabled="channelHistoryPage <= 1"
                @click="loadChannelHistory(channelHistoryPage - 1)"
                class="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                上一页
              </button>
              <button
                type="button"
                :disabled="channelHistoryPage >= totalHistoryPages"
                @click="loadChannelHistory(channelHistoryPage + 1)"
                class="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

  </div>
</template>

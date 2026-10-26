<script setup lang="ts">
import { ref, computed, onMounted, reactive, nextTick, watch } from 'vue';
import { taskApi, type TaskItem } from '../api/task';
import { accountApi, type AccountItem } from '../api/account';
import { channelApi, type TmdbCandidateItem } from '../api/channel';
import { ElMessage } from 'element-plus';
import {
  Film,
  Tv,
  Plus,
  Play,
  RotateCcw,
  Trash2,
  Edit3,
  Search,
  ExternalLink,
  Layers,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HardDrive,
  Copy,
  Check,
  X,
  ShieldCheck,
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp,
  Inbox,
  ArrowRight
} from 'lucide-vue-next';

// ================= 基础状态 =================
const loading = ref(false);
const tasks = ref<TaskItem[]>([]);
const accounts = ref<AccountItem[]>([]);
const filterStatus = ref<'all' | 'pending' | 'completed' | 'failed'>('all');
const searchQuery = ref('');
const executingMap = ref<Record<number, boolean>>({});

// 全局暂存区配置（统一入口）
const stagingFolderId = ref('');
const stagingFolderName = ref('临时存放');

// ================= 页面内联表单控制（零弹窗：直接在页面流中展开与编辑） =================
const showForm = ref(false);
const isEditing = ref(false);
const submitting = ref(false);
const formContainerRef = ref<HTMLElement | null>(null);

// 原位删除与重置确认状态（零弹窗：卡片就地确认）
const deletingTaskId = ref<number | null>(null);
const deleteCloudFiles = ref(false);
const resettingTaskId = ref<number | null>(null);

// 表单响应式数据
const form = reactive({
  id: 0,
  accountId: '' as number | string,
  shareLink: '',
  accessCode: '',
  resourceName: '',
  realFolderId: '',
  realFolderName: '',
  totalEpisodes: 0,
  currentEpisodes: 0,
  status: 'pending' as 'pending' | 'processing' | 'completed' | 'failed',
  enableCron: true,
  cronPreset: '2h',
  cronExpression: '0 */2 * * *',
  tmdbId: '',
  videoType: 'tv' as 'tv' | 'movie',
  enableTaskScraper: true,
  posterPath: '',
  remark: '',
});

// TMDB 智能检索状态
const tmdbSearching = ref(false);
const tmdbCandidates = ref<TmdbCandidateItem[]>([]);
const selectedCandidate = ref<TmdbCandidateItem | null>(null);

const showCustomCron = ref(false);

// ================= 统计指标 =================
const stats = computed(() => {
  const total = tasks.value.length;
  const running = tasks.value.filter(
    (t) => t.status === 'pending' || t.status === 'processing' || (t.status as string) === 'running'
  ).length;
  const completed = tasks.value.filter((t) => t.status === 'completed').length;
  const failed = tasks.value.filter((t) => t.status === 'failed' || (t.lastError && t.lastError.trim().length > 0)).length;
  return { total, running, completed, failed };
});

// ================= 过滤后的列表 =================
const filteredTasks = computed(() => {
  return tasks.value.filter((task) => {
    // 状态过滤
    if (filterStatus.value === 'pending') {
      if (task.status !== 'pending' && task.status !== 'processing' && (task.status as string) !== 'running') {
        return false;
      }
    } else if (filterStatus.value === 'completed') {
      if (task.status !== 'completed') return false;
    } else if (filterStatus.value === 'failed') {
      if (task.status !== 'failed' && (!task.lastError || !task.lastError.trim())) return false;
    }

    // 关键词搜索
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.trim().toLowerCase();
      const matchName = (task.resourceName || '').toLowerCase().includes(q);
      const matchRemark = (task.remark || '').toLowerCase().includes(q);
      const matchFolder = (task.realFolderName || '').toLowerCase().includes(q);
      const matchAccount = (task.account?.username || '').toLowerCase().includes(q);
      const matchTmdb = String(task.tmdbId || '').toLowerCase().includes(q);
      if (!matchName && !matchRemark && !matchFolder && !matchAccount && !matchTmdb) {
        return false;
      }
    }

    return true;
  });
});

// ================= 数据加载 =================
async function loadAccounts() {
  try {
    const list = await accountApi.getAccounts();
    accounts.value = list || [];
    if (accounts.value.length > 0 && !form.accountId) {
      form.accountId = accounts.value[0].id;
    }
  } catch (err: any) {
    ElMessage.error(`加载账号列表失败: ${err.message || '网络错误'}`);
  }
}

async function loadTasks() {
  loading.value = true;
  try {
    const list = await taskApi.getTasks();
    tasks.value = list || [];
  } catch (err: any) {
    ElMessage.error(`获取追更任务列表失败: ${err.message || '网络错误'}`);
  } finally {
    loading.value = false;
  }
}

async function loadGlobalConfig() {
  try {
    const res = await channelApi.getGlobalConfig();
    if (res) {
      if (res.stagingFolderId) stagingFolderId.value = res.stagingFolderId;
      if (res.stagingFolderName) stagingFolderName.value = res.stagingFolderName;
    }
  } catch (err: any) {
    console.warn('获取全局暂存区配置失败，回退默认值:', err.message);
  }
}

onMounted(async () => {
  await Promise.all([loadAccounts(), loadTasks(), loadGlobalConfig()]);
});

// ================= 智能链接解析 =================
function handleShareLinkInput(val: string) {
  if (!val) return;
  // 智能识别 139 分享链接与提取码（兼容完整分享文案）
  const urlMatch = val.match(/(https?:\/\/(?:caiyun|yun)\.139\.com\/\S+)/i);
  const codeMatch = val.match(/(?:提取码|访问码|密码|提取|pwd|code)[:：\s]*([a-zA-Z0-9]{4,8})/i);

  if (urlMatch) {
    form.shareLink = urlMatch[1].replace(/[，,。！\s]+$/, '');
  }
  if (codeMatch && !form.accessCode) {
    form.accessCode = codeMatch[1].trim();
    ElMessage.success(`已自动解析提取码: ${form.accessCode}`);
  }
}

async function handlePasteShareLink() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      handleShareLinkInput(text);
      ElMessage.success('已从剪贴板读取分享文案');
    }
  } catch {
    ElMessage.warning('未能读取剪贴板，请手动粘贴');
  }
}

// ================= TMDB 检索与绑定 =================
async function searchTmdbCandidates() {
  const query = form.resourceName.trim();
  if (!query) {
    ElMessage.warning('请输入要检索的影视剧名称');
    return;
  }

  tmdbSearching.value = true;
  try {
    const list = await channelApi.searchCandidates({
      title: query,
      mediaType: 'multi',
    });
    tmdbCandidates.value = Array.isArray(list) ? list : [];
    if (tmdbCandidates.value.length === 0) {
      ElMessage.info('未在 TMDB 找到相关作品，可精简片名或用英文原名检索');
    }
  } catch (err: any) {
    ElMessage.error(`TMDB 检索失败: ${err.message || '网络异常'}`);
  } finally {
    tmdbSearching.value = false;
  }
}

function selectCandidate(item: TmdbCandidateItem) {
  selectedCandidate.value = item;
  form.tmdbId = String(item.tmdbId || item.id || '');
  form.videoType = item.mediaType === 'movie' ? 'movie' : 'tv';
  const cleanTitle = item.chineseTitle || item.name || item.title || form.resourceName;
  form.resourceName = cleanTitle;
  form.posterPath = item.posterPath || '';
  form.enableTaskScraper = true;
  const yearText = item.year ? ` (${item.year})` : '';
  ElMessage.success(`已锁定 TMDB 权威信息: 《${cleanTitle}》${yearText} (ID: ${form.tmdbId})`);
}

function clearCandidate() {
  selectedCandidate.value = null;
  form.tmdbId = '';
  form.posterPath = '';
}

function handleResourceNameInput() {
  if (selectedCandidate.value) {
    const bound = (selectedCandidate.value.chineseTitle || selectedCandidate.value.title || '').trim();
    if (form.resourceName.trim() !== bound) {
      clearCandidate();
    }
  } else if (form.tmdbId) {
    clearCandidate();
  }
  // 片名变更时重置陈旧候选结果，杜绝显示跨作品陈旧候选列表
  if (tmdbCandidates.value.length > 0) {
    tmdbCandidates.value = [];
  }
}

// ================= Cron 调度联动 =================
function handleCronPresetChange(preset: string) {
  form.cronPreset = preset;
  switch (preset) {
    case '30m':
      form.cronExpression = '*/30 * * * *';
      break;
    case '2h':
      form.cronExpression = '0 */2 * * *';
      break;
    case '6h':
      form.cronExpression = '0 */6 * * *';
      break;
    case '1d':
      form.cronExpression = '0 3 * * *';
      break;
    default:
      break;
  }
}

function formatCron(cron?: string): string {
  if (!cron) return '未启用定时';
  if (cron === '*/30 * * * *') return '每 30 分钟轮询';
  if (cron === '0 */2 * * *') return '每 2 小时轮询';
  if (cron === '0 */6 * * *') return '每 6 小时轮询';
  if (cron === '0 3 * * *') return '每天 03:00 轮询';
  if (cron === '*/15 * * * *') return '每 15 分钟轮询';
  if (cron === '0 * * * *') return '每 1 小时轮询';
  return cron;
}


// ================= 打开与折叠内联表单 =================
function openInlineAddForm() {
  isEditing.value = false;
  selectedCandidate.value = null;
  tmdbCandidates.value = [];
  showCustomCron.value = false;

  Object.assign(form, {
    id: 0,
    accountId: accounts.value.length > 0 ? accounts.value[0].id : '',
    shareLink: '',
    accessCode: '',
    resourceName: '',
    realFolderId: stagingFolderId.value || '/',
    realFolderName: stagingFolderName.value || '临时存放',
    totalEpisodes: 0,
    currentEpisodes: 0,
    status: 'pending',
    enableCron: true,
    cronPreset: '2h',
    cronExpression: '0 */2 * * *',
    tmdbId: '',
    videoType: 'tv',
    enableTaskScraper: true,
    posterPath: '',
    remark: '',
  });

  showForm.value = true;
  nextTick(() => {
    formContainerRef.value?.scrollIntoView({ behavior: 'smooth' });
  });
}

function openInlineEditForm(task: TaskItem) {
  isEditing.value = true;
  tmdbCandidates.value = [];

  let poster = task.posterPath || '';
  if (!poster && task.tmdbContent) {
    try {
      const parsed = JSON.parse(task.tmdbContent);
      poster = parsed.posterPath || parsed.poster_path || '';
    } catch {}
  }

  const exp = task.cronExpression || '0 */2 * * *';
  let detectedPreset = 'custom';
  if (exp === '*/30 * * * *') detectedPreset = '30m';
  else if (exp === '0 */2 * * *') detectedPreset = '2h';
  else if (exp === '0 */6 * * *') detectedPreset = '6h';
  else if (exp === '0 3 * * *') detectedPreset = '1d';
  else if (exp === '*/15 * * * *') detectedPreset = '15m';
  else if (exp === '0 * * * *') detectedPreset = '1h';

  showCustomCron.value = detectedPreset === 'custom';

  Object.assign(form, {
    id: task.id,
    accountId: task.accountId,
    shareLink: task.shareLink || task.shareUrl || '',
    accessCode: task.accessCode || task.shareCode || '',
    resourceName: task.resourceName || '',
    realFolderId: task.realFolderId || '/',
    realFolderName: task.realFolderName || '根目录 (/)',
    totalEpisodes: task.totalEpisodes || 0,
    currentEpisodes: task.currentEpisodes || 0,
    status: task.status || 'pending',
    enableCron: !!task.enableCron,
    cronPreset: detectedPreset,
    cronExpression: exp,
    tmdbId: task.tmdbId || '',
    videoType: (task.videoType as any) || 'tv',
    enableTaskScraper: task.enableTaskScraper ?? true,
    posterPath: poster,
    remark: task.remark || '',
  });

  if (task.tmdbId) {
    let parsedContent: any = {};
    if (task.tmdbContent) {
      try {
        parsedContent = JSON.parse(task.tmdbContent);
      } catch {}
    }
    selectedCandidate.value = {
      id: Number(task.tmdbId) || 0,
      tmdbId: Number(task.tmdbId) || 0,
      title: task.resourceName,
      chineseTitle: task.resourceName,
      mediaType: task.videoType || 'tv',
      posterPath: poster,
      year: parsedContent.year || '',
      isAnime: parsedContent.isAnime,
      category: parsedContent.category,
      secondaryCategory: parsedContent.secondaryCategory,
      genreIds: parsedContent.genreIds || parsedContent.genre_ids,
    };
  } else {
    selectedCandidate.value = null;
  }

  showForm.value = true;
  nextTick(() => {
    formContainerRef.value?.scrollIntoView({ behavior: 'smooth' });
  });
}

function closeInlineForm() {
  showForm.value = false;
  isEditing.value = false;
  deletingTaskId.value = null;
  resettingTaskId.value = null;
}

// ================= 表单提交 =================
async function handleSubmit() {
  if (!form.accountId) {
    ElMessage.warning('请选择 139 网盘账号');
    return;
  }
  if (!form.shareLink.trim()) {
    ElMessage.warning('请输入 139 云盘分享链接');
    return;
  }
  if (!form.resourceName.trim()) {
    ElMessage.warning('请输入剧集/任务名称，或通过 TMDB 检索选定');
    return;
  }
  if (!form.tmdbId) {
    ElMessage.warning('追更任务必须关联 TMDB，请点击“智能匹配”检索并选择对应影视作品');
    return;
  }

  const effectiveFolderId = form.realFolderId || '/';
  const effectiveFolderName = form.realFolderName || '根目录 (/)';

  submitting.value = true;
  try {
    const tmdbPayloadObj = (form.posterPath || form.tmdbId) ? {
      id: Number(form.tmdbId) || form.tmdbId,
      tmdbId: Number(form.tmdbId) || form.tmdbId,
      title: form.resourceName.trim(),
      year: selectedCandidate.value?.year || '',
      posterPath: form.posterPath || '',
      mediaType: form.videoType || 'tv',
      isAnime: selectedCandidate.value?.isAnime,
      category: selectedCandidate.value?.category,
      secondaryCategory: selectedCandidate.value?.secondaryCategory,
      genreIds: selectedCandidate.value?.genreIds,
    } : null;

    const payload: any = {
      accountId: Number(form.accountId),
      shareLink: form.shareLink.trim(),
      accessCode: form.accessCode.trim(),
      targetFolderId: effectiveFolderId,
      realFolderId: effectiveFolderId,
      realFolderName: effectiveFolderName,
      resourceName: form.resourceName.trim(),
      totalEpisodes: Number(form.totalEpisodes) || 0,
      currentEpisodes: Number(form.currentEpisodes) || 0,
      status: form.status,
      enableCron: form.enableCron,
      cronExpression: form.enableCron ? form.cronExpression : '',
      tmdbId: form.tmdbId || '',
      videoType: form.videoType,
      enableTaskScraper: form.enableTaskScraper,
      posterPath: form.posterPath || '',
      tmdbContent: tmdbPayloadObj ? JSON.stringify(tmdbPayloadObj) : '',
      remark: form.remark.trim(),
    };

    if (!isEditing.value) {
      await taskApi.createTask(payload);
      ElMessage.success('追更任务创建成功');
    } else {
      await taskApi.updateTask(form.id, payload);
      ElMessage.success('追更任务配置已更新');
    }

    closeInlineForm();
    await loadTasks();
  } catch (err: any) {
    ElMessage.error(`保存失败: ${err.message || '未知错误'}`);
  } finally {
    submitting.value = false;
  }
}

// ================= 原位触发执行 =================
async function handleExecuteTask(task: TaskItem) {
  executingMap.value[task.id] = true;
  try {
    await taskApi.executeTask(task.id);
    ElMessage.success(`任务《${task.resourceName}》已触发执行转存`);
    await loadTasks();
  } catch (err: any) {
    ElMessage.error(`执行失败: ${err.message || '未知错误'}`);
  } finally {
    executingMap.value[task.id] = false;
  }
}

// ================= 原位确认：重置进度 =================
function startResetProgress(task: TaskItem) {
  resettingTaskId.value = task.id;
  deletingTaskId.value = null;
}

function cancelResetProgress() {
  resettingTaskId.value = null;
}

async function confirmResetProgress(task: TaskItem) {
  try {
    await taskApi.updateTask(task.id, {
      currentEpisodes: 0,
      status: 'pending',
    });
    ElMessage.success(`《${task.resourceName}》追更进度已重置为 0`);
    resettingTaskId.value = null;
    await loadTasks();
  } catch (err: any) {
    ElMessage.error(`重置失败: ${err.message || '未知错误'}`);
  }
}

// ================= 原位确认：删除任务 =================
function startDeleteTask(taskId: number) {
  deletingTaskId.value = taskId;
  deleteCloudFiles.value = false;
  resettingTaskId.value = null;
}

function cancelDeleteTask() {
  deletingTaskId.value = null;
  deleteCloudFiles.value = false;
}

async function confirmDeleteTask(taskId: number) {
  try {
    await taskApi.deleteTask(taskId, deleteCloudFiles.value);
    ElMessage.success('追更任务已成功删除');
    deletingTaskId.value = null;
    await loadTasks();
  } catch (err: any) {
    ElMessage.error(`删除失败: ${err.message || '未知错误'}`);
  }
}

// ================= 辅助函数 =================
function getTaskYear(task: TaskItem): string {
  if (task.tmdbContent) {
    try {
      const p = JSON.parse(task.tmdbContent);
      if (p.year) return String(p.year);
    } catch {}
  }
  const match = (task.resourceName || '').match(/\b(19\d\d|20\d\d)\b/);
  return match ? match[1] : '';
}

function isTaskInStaging(task: TaskItem): boolean {
  if (!stagingFolderId.value && !stagingFolderName.value) return false;
  return Boolean(
    (stagingFolderId.value && task.realFolderId === stagingFolderId.value) ||
    (stagingFolderName.value && task.realFolderName === stagingFolderName.value)
  );
}

async function copyTaskLink(task: TaskItem) {
  const link = task.shareLink || task.shareUrl;
  if (!link) return;
  const fullText = task.accessCode ? `${link} 提取码: ${task.accessCode}` : link;
  try {
    await navigator.clipboard.writeText(fullText);
    ElMessage.success('已复制分享链接');
  } catch {
    ElMessage.info(fullText);
  }
}

function formatPosterUrl(path?: string) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `https://image.tmdb.org/t/p/w200${path.startsWith('/') ? '' : '/'}${path}`;
}

function formatDateTime(str?: string) {
  if (!str) return '-';
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return str;
  }
}

function formatCandidateCategory(item?: TmdbCandidateItem | null): string {
  if (!item) return '电视剧';
  if (item.secondaryCategory) return item.secondaryCategory;
  const gIds = item.genreIds || [];
  if (Array.isArray(gIds) && (gIds.includes(16) || gIds.includes('16' as any))) {
    return item.mediaType === 'movie' ? '动画电影' : '国漫';
  }
  if (item.isAnime) return item.mediaType === 'movie' ? '动画电影' : '动漫';
  return item.mediaType === 'movie' ? '电影' : '电视剧';
}

function getTaskCategoryBadge(task: TaskItem): string {
  if (task.tmdbContent) {
    try {
      const parsed = JSON.parse(task.tmdbContent);
      if (parsed.secondaryCategory) return parsed.secondaryCategory;
      const gIds = parsed.genreIds || parsed.genre_ids || [];
      if (Array.isArray(gIds) && (gIds.includes(16) || gIds.includes('16'))) {
        return task.videoType === 'movie' ? '动画电影' : '国漫';
      }
      if (parsed.isAnime) return task.videoType === 'movie' ? '动画电影' : '动漫';
    } catch {}
  }
  return task.videoType === 'movie' ? '电影' : '剧集';
}

function getErrorTier(errText?: string) {
  if (!errText) return null;
  const match = errText.match(/^\[([^\]]+)\]/);
  const typeName = match ? match[1] : '';
  const fatalTypes = ['链接失效', '链接过期', '访问次数超限', '权限不足', '用户信息查询失败'];
  if (fatalTypes.includes(typeName)) {
    return { type: 'fatal', label: `致命: ${typeName}` };
  }
  return { type: 'retry', label: typeName ? `异常: ${typeName}` : '运行异常' };
}
</script>

<template>
  <div class="tasks-container space-y-6 w-full pb-16 text-slate-800 dark:text-slate-100">
    <!-- ================= 顶部统计概览 ================= -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="settings-card !p-5 flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">追更任务总量</p>
          <h3 class="text-2xl font-bold text-slate-900 dark:text-white">{{ stats.total }}</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
          <Layers class="w-6 h-6" />
        </div>
      </div>

      <div class="settings-card !p-5 flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-1">活跃追更中</p>
          <h3 class="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{{ stats.running }}</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0">
          <Play class="w-6 h-6 fill-current" />
        </div>
      </div>

      <div class="settings-card !p-5 flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold text-indigo-500 uppercase tracking-wider mb-1">已完结归档</p>
          <h3 class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{{ stats.completed }}</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
          <CheckCircle2 class="w-6 h-6" />
        </div>
      </div>

      <div class="settings-card !p-5 flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold text-rose-500 uppercase tracking-wider mb-1">异常待排查</p>
          <h3 class="text-2xl font-bold text-rose-600 dark:text-rose-400">{{ stats.failed }}</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
          <AlertTriangle class="w-6 h-6" />
        </div>
      </div>
    </div>

    <!-- ================= 过滤与操作工具栏 ================= -->
    <div class="settings-card !p-4 flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <!-- 状态胶囊选项卡 -->
        <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg transition-all cursor-pointer"
            :class="filterStatus === 'all' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            @click="filterStatus = 'all'"
          >
            全部 ({{ stats.total }})
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg transition-all cursor-pointer"
            :class="filterStatus === 'pending' ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            @click="filterStatus = 'pending'"
          >
            追更中 ({{ stats.running }})
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg transition-all cursor-pointer"
            :class="filterStatus === 'completed' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            @click="filterStatus = 'completed'"
          >
            已完结 ({{ stats.completed }})
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg transition-all cursor-pointer"
            :class="filterStatus === 'failed' ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            @click="filterStatus = 'failed'"
          >
            异常 ({{ stats.failed }})
          </button>
        </div>

        <!-- 搜索输入框 -->
        <div class="relative w-64">
          <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索剧名 / 备注 / TMDB..."
            class="input-base !h-8.5 !pl-9 !text-xs w-full"
          />
        </div>
      </div>

      <div class="flex items-center gap-2.5">
        <button
          type="button"
          class="btn-default text-xs h-8.5 px-3 flex items-center gap-1.5 cursor-pointer"
          :disabled="loading"
          @click="loadTasks"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
          <span>刷新</span>
        </button>

        <!-- 新建任务按钮（切换展开内联表单） -->
        <button
          type="button"
          class="btn-primary text-xs h-8.5 px-4 font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer"
          @click="showForm ? closeInlineForm() : openInlineAddForm()"
        >
          <Plus v-if="!showForm" class="w-4 h-4" />
          <X v-else class="w-4 h-4" />
          <span>{{ showForm ? '收起表单' : '新建追更任务' }}</span>
        </button>
      </div>
    </div>

    <!-- ================= 内联表单卡片 (零弹窗：页面内直接平滑展开) ================= -->
    <div
      v-if="showForm"
      ref="formContainerRef"
      class="settings-card !p-5 border-2 border-blue-500/20 dark:border-blue-400/20 shadow-md relative animate-fadeIn"
    >
      <!-- 表单头部 -->
      <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Film class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
              {{ isEditing ? `编辑追更任务：《${form.resourceName || '未命名'}》` : '新建追更任务' }}
            </h3>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              添加 139 移动云盘分享链接并自动执行更新检测与入库
            </p>
          </div>
        </div>
        <button
          type="button"
          class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
          title="关闭表单"
          @click="closeInlineForm"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- 表单主体网格 -->
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 139 账号选择 -->
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              139 移动云盘账号 <span class="text-red-500">*</span>
            </label>
            <select
              v-model="form.accountId"
              class="input-base text-xs w-full bg-white dark:bg-slate-900"
              required
            >
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                {{ acc.alias || acc.username }} (ID: {{ acc.id }})
              </option>
            </select>
          </div>

          <!-- 分享链接输入 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                139 云盘分享链接 <span class="text-red-500">*</span>
              </label>
              <button
                type="button"
                class="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer flex items-center gap-1 text-[11px]"
                @click="handlePasteShareLink"
              >
                <Copy class="w-3 h-3" />
                <span>从剪贴板粘贴并解析</span>
              </button>
            </div>
            <input
              v-model="form.shareLink"
              type="text"
              placeholder="https://yun.139.com/shareweb/#/w/i/..."
              class="input-base text-xs font-mono w-full"
              required
              @input="handleShareLinkInput(form.shareLink)"
            />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 提取码 -->
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              访问提取码 (可选)
            </label>
            <input
              v-model="form.accessCode"
              type="text"
              placeholder="无密码则留空"
              class="input-base text-xs font-mono w-full"
            />
          </div>

          <!-- 影视剧集名称与智能匹配 -->
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              影视名称与 TMDB 匹配 <span class="text-red-500">*</span>
            </label>
            <div class="flex items-center gap-2">
              <input
                v-model="form.resourceName"
                type="text"
                placeholder="例如: 凡人修仙传 / 仙逆"
                class="input-base text-xs flex-1"
                required
                @input="handleResourceNameInput"
              />
              <button
                type="button"
                class="btn-default text-xs h-9 px-3 shrink-0 flex items-center gap-1 cursor-pointer"
                :disabled="tmdbSearching"
                @click="searchTmdbCandidates"
              >
                <RefreshCw v-if="tmdbSearching" class="w-3.5 h-3.5 animate-spin" />
                <Search v-else class="w-3.5 h-3.5 text-blue-500" />
                <span>{{ tmdbSearching ? '检索中...' : '智能匹配' }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- TMDB 已绑定条目卡片 -->
        <div
          v-if="form.tmdbId"
          class="p-4 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60 flex items-center justify-between"
        >
          <div class="flex items-center gap-3.5">
            <div class="w-12 h-16 rounded-lg bg-emerald-100 dark:bg-emerald-900/60 overflow-hidden shrink-0 border border-emerald-300 dark:border-emerald-700 flex items-center justify-center shadow-xs">
              <img
                v-if="form.posterPath"
                :src="formatPosterUrl(form.posterPath)"
                :alt="form.resourceName"
                class="w-full h-full object-cover"
              />
              <ShieldCheck v-else class="w-6 h-6 text-emerald-500" />
            </div>
            <div>
              <div class="flex items-center gap-2 mb-1">
                <h4 class="font-bold text-slate-900 dark:text-white text-sm">
                  《{{ selectedCandidate?.chineseTitle || selectedCandidate?.title || form.resourceName }}》
                  <span v-if="selectedCandidate?.year" class="text-xs font-normal text-slate-500 ml-1">
                    ({{ selectedCandidate.year }})
                  </span>
                </h4>
                <span class="px-2 py-0.5 text-[11px] font-semibold bg-emerald-500 text-white rounded-md">
                  TMDB: {{ form.tmdbId }}
                </span>
                <span class="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                  {{ formatCandidateCategory(selectedCandidate) }}
                </span>
              </div>
              <p class="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
                <CheckCircle2 class="w-3.5 h-3.5" />
                已锁定 TMDB 官方权威条目，整理引擎将依据该作品元数据进行规范化归档！
              </p>
            </div>
          </div>
          <button
            type="button"
            class="text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
            @click="clearCandidate"
          >
            解除绑定
          </button>
        </div>

        <!-- TMDB 候选卡片列表 -->
        <div v-if="tmdbCandidates.length > 0 && !form.tmdbId" class="space-y-2">
          <p class="text-xs font-semibold text-slate-500">
            检索到 {{ tmdbCandidates.length }} 条候选作品，请点击选定匹配条目：
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-56 overflow-y-auto pr-1">
            <div
              v-for="item in tmdbCandidates"
              :key="item.tmdbId || item.id"
              class="p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-500 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 cursor-pointer transition-all flex items-start gap-2.5 group"
              @click="selectCandidate(item)"
            >
              <div class="w-10 h-14 rounded bg-slate-100 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
                <img
                  v-if="item.posterPath"
                  :src="formatPosterUrl(item.posterPath)"
                  class="w-full h-full object-cover"
                />
                <Film v-else class="w-4 h-4 text-slate-400" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-bold text-xs text-slate-900 dark:text-white truncate group-hover:text-emerald-600">
                  {{ item.chineseTitle || item.name || item.title }}
                </div>
                <div class="text-[11px] text-slate-400 truncate flex items-center gap-1">
                  <span v-if="item.year">{{ item.year }} 年 · </span>
                  <span class="text-slate-500 dark:text-slate-400 font-medium">
                    {{ formatCandidateCategory(item) }}
                  </span>
                  <span> · ID: {{ item.tmdbId || item.id }}</span>
                </div>
                <p v-if="item.overview" class="text-[10px] text-slate-400 line-clamp-1 mt-0.5">
                  {{ item.overview }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <!-- 追更轮询频率 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                追更轮询周期
              </label>
              <button
                type="button"
                class="text-[11px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer select-none"
                @click="showCustomCron = !showCustomCron"
              >
                {{ showCustomCron ? '收起自定义' : '自定义 Cron' }}
              </button>
            </div>
            <div class="grid grid-cols-2 gap-1.5 mb-1.5">
              <button
                v-for="p in [
                  { id: '30m', label: '30分钟 (急速)' },
                  { id: '2h', label: '2小时 (推荐)' },
                  { id: '6h', label: '6小时 (平缓)' },
                  { id: '1d', label: '每天一次 (凌晨3点)' },
                ]"
                :key="p.id"
                type="button"
                class="px-2 py-1.5 text-[11px] rounded border transition-all cursor-pointer text-center"
                :class="form.cronPreset === p.id ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-500 text-blue-600 dark:text-blue-400 font-bold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'"
                @click="handleCronPresetChange(p.id)"
              >
                {{ p.label }}
              </button>
            </div>
            <input
              v-show="showCustomCron"
              v-model="form.cronExpression"
              type="text"
              placeholder="Cron 表达式，如: 0 */2 * * *"
              class="input-base text-xs font-mono w-full"
            />
          </div>

          <!-- 追更总集数 -->
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              总集数目标 (0 为不限)
            </label>
            <input
              v-model.number="form.totalEpisodes"
              type="number"
              min="0"
              placeholder="0 表示连载不限集数"
              class="input-base text-xs font-mono w-full"
            />
          </div>

          <!-- 任务备注 -->
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              任务备注 (选填)
            </label>
            <input
              v-model="form.remark"
              type="text"
              placeholder="例如: 某论坛更新、朋友分享"
              class="input-base text-xs w-full"
            />
          </div>
        </div>

        <!-- 表单操作按钮栏 -->
        <div class="pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-2.5">
          <button
            type="button"
            class="btn-default text-xs h-9 px-4 cursor-pointer"
            @click="closeInlineForm"
          >
            取消
          </button>
          <button
            type="submit"
            class="btn-primary text-xs h-9 px-5 font-semibold flex items-center gap-1.5 shadow-sm cursor-pointer"
            :disabled="submitting"
          >
            <RefreshCw v-if="submitting" class="w-3.5 h-3.5 animate-spin" />
            <span>{{ submitting ? '保存中...' : (isEditing ? '保存修改并更新追更配置' : '立即创建追更任务') }}</span>
          </button>
        </div>
      </form>
    </div>

    <!-- ================= 任务列表为空状态 ================= -->
    <div
      v-if="!loading && filteredTasks.length === 0"
      class="settings-card !py-16 text-center text-slate-400 dark:text-slate-500"
    >
      <Inbox class="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
      <h4 class="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
        暂无符合条件的追更任务
      </h4>
      <p class="text-xs text-slate-400 max-w-sm mx-auto mb-4">
        可点击上方「新建追更任务」，粘贴 139 移动云盘外链，系统将定时自动转存至指定暂存区并协同整理归档
      </p>
      <button
        type="button"
        class="btn-primary text-xs h-8.5 px-4 font-semibold inline-flex items-center gap-1.5 cursor-pointer"
        @click="openInlineAddForm"
      >
        <Plus class="w-4 h-4" />
        <span>添加首个追更任务</span>
      </button>
    </div>

    <!-- ================= 任务卡片网格列表 (与账号页面 100% 对齐的卡片式架构) ================= -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4.5">
      <div
        v-for="task in filteredTasks"
        :key="task.id"
        class="settings-card !p-4 flex flex-col justify-between transition-all hover:shadow-md relative overflow-hidden group border border-slate-200/80 dark:border-slate-800"
        :class="{
          'border-rose-300 dark:border-rose-900/60': task.status === 'failed' || (task.lastError && task.lastError.trim().length > 0),
          'border-emerald-300 dark:border-emerald-800/60': task.status === 'completed',
        }"
      >
        <div>
          <!-- 卡片上部：海报 + 作品权威档案 + 状态 -->
          <div class="flex items-start gap-3.5 mb-3.5">
            <!-- 影视海报封面（增强质感与清晰度） -->
            <div class="w-16 h-23 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 shrink-0 overflow-hidden flex items-center justify-center shadow-xs relative group/poster">
              <img
                v-if="task.posterPath"
                :src="formatPosterUrl(task.posterPath)"
                :alt="task.resourceName"
                class="w-full h-full object-cover"
                loading="lazy"
              />
              <Tv v-else-if="task.videoType === 'tv'" class="w-7 h-7 text-slate-400" />
              <Film v-else class="w-7 h-7 text-slate-400" />

              <!-- 角标：影视分类与年份 -->
              <span
                class="absolute bottom-1 right-1 px-1.5 py-0.5 text-[9px] font-bold backdrop-blur rounded bg-black/70 text-white"
              >
                {{ getTaskCategoryBadge(task) }}
              </span>
            </div>

            <!-- 作品核心属性 -->
            <div class="min-w-0 flex-1 flex flex-col justify-between h-23 py-0.5">
              <div>
                <div class="flex items-center justify-between gap-1.5 mb-1.5">
                  <h3 class="text-base font-bold text-slate-900 dark:text-white truncate" :title="task.resourceName">
                    《{{ task.resourceName }}》
                  </h3>

                  <!-- 运行状态指示点与文案 -->
                  <span
                    class="px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 shrink-0"
                    :class="{
                      'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800': task.status === 'pending' || task.status === 'processing' || (task.status as string) === 'running',
                      'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-800': task.status === 'completed',
                      'bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200/80 dark:border-rose-800': task.status === 'failed',
                    }"
                  >
                    <span
                      class="w-1.5 h-1.5 rounded-full"
                      :class="{
                        'bg-emerald-500 animate-pulse': task.status === 'pending' || task.status === 'processing' || (task.status as string) === 'running',
                        'bg-indigo-500': task.status === 'completed',
                        'bg-rose-500': task.status === 'failed',
                      }"
                    />
                    <span>{{ task.status === 'completed' ? '已完结' : (task.status === 'failed' ? '异常' : '追更中') }}</span>
                  </span>
                </div>

                <!-- 权威元数据胶囊行：年份 + TMDB 认证 + 账号 -->
                <div class="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span
                    v-if="getTaskYear(task)"
                    class="px-1.5 py-0.5 font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded"
                  >
                    {{ getTaskYear(task) }} 年
                  </span>
                  <span
                    v-if="task.tmdbId"
                    class="px-1.5 py-0.5 font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60 rounded flex items-center gap-0.5"
                  >
                    <ShieldCheck class="w-3 h-3" />
                    <span>TMDB: {{ task.tmdbId }}</span>
                  </span>
                  <span class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded">
                    账号: {{ task.account?.username || '默认' }}
                  </span>
                  <span
                    v-if="isTaskInStaging(task)"
                    class="px-1.5 py-0.5 font-semibold bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 rounded"
                  >
                    暂存区
                  </span>
                </div>
              </div>

              <!-- 分享源紧凑收纳（消灭丑陋的长 URL 噪音） -->
              <div class="flex items-center gap-2 text-[11px] text-slate-400 pt-1">
                <a
                  :href="task.shareLink || task.shareUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                  title="在新窗口打开 139 分享页面"
                >
                  <ExternalLink class="w-3 h-3 shrink-0" />
                  <span>139 分享源</span>
                </a>
                <span v-if="task.accessCode" class="text-[10px] text-slate-400 font-mono">
                  码: {{ task.accessCode }}
                </span>
                <button
                  type="button"
                  class="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  title="复制分享链接"
                  @click="copyTaskLink(task)"
                >
                  <Copy class="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>

          <!-- 卡片中部：核心指标看板 (Hero Metrics Block，重点一目了然！) -->
          <div class="space-y-2.5 p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/70 dark:border-slate-700/60 text-xs">
            <!-- 核心焦点：追更集数大指标 -->
            <div class="flex items-baseline justify-between">
              <div class="flex items-baseline gap-2">
                <span class="text-[11px] font-semibold text-slate-500">已转存进度</span>
                <span class="text-xl font-extrabold font-mono text-slate-900 dark:text-white tracking-tight">
                  第 {{ task.currentEpisodes || 0 }} 集
                </span>
              </div>
              <div class="text-xs font-mono">
                <span v-if="task.totalEpisodes && task.totalEpisodes > 0" class="text-slate-500 dark:text-slate-400 font-medium">
                  共 {{ task.totalEpisodes }} 集 ({{ Math.min(100, Math.round(((task.currentEpisodes || 0) / task.totalEpisodes) * 100)) }}%)
                </span>
                <span v-else class="text-emerald-600 dark:text-emerald-400 font-semibold text-[11px]">
                  连载追更中
                </span>
              </div>
            </div>

            <!-- 进度条（有总集数时渲染） -->
            <div
              v-if="task.totalEpisodes && task.totalEpisodes > 0"
              class="w-full bg-slate-200/80 dark:bg-slate-700/80 h-1.5 rounded-full overflow-hidden"
            >
              <div
                class="bg-gradient-to-r from-blue-500 to-indigo-500 h-full rounded-full transition-all"
                :style="{
                  width: `${Math.min(100, Math.round(((task.currentEpisodes || 0) / task.totalEpisodes) * 100))}%`,
                }"
              />
            </div>

            <!-- 调度频率与上次更新 -->
            <div class="flex items-center justify-between text-[11px] text-slate-400 pt-1.5 border-t border-slate-200/50 dark:border-slate-700/40">
              <span class="flex items-center gap-1">
                <Clock class="w-3 h-3 text-slate-400 shrink-0" />
                <span>{{ formatCron(task.cronExpression) }}</span>
              </span>
              <span>上次: {{ formatDateTime(task.lastCheckTime) }}</span>
            </div>

            <!-- 异常气泡提示 -->
            <div
              v-if="task.lastError && task.lastError.trim()"
              class="p-2 rounded bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/80 text-[11px] text-rose-600 dark:text-rose-400 flex items-start gap-1.5"
            >
              <AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span class="truncate flex-1" :title="task.lastError">{{ task.lastError }}</span>
            </div>
          </div>
        </div>

        <!-- 卡片底部：原位操作栏与零弹窗确认胶囊 -->
        <div class="pt-3 mt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
          <!-- 原位删除确认胶囊 (零弹窗体验) -->
          <div
            v-if="deletingTaskId === task.id"
            class="w-full flex items-center justify-between p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800"
          >
            <div class="flex items-center gap-1.5 text-xs text-rose-700 dark:text-rose-300 pl-1">
              <span class="font-bold">确认删除此追更任务？</span>
              <label class="flex items-center gap-1 cursor-pointer text-[10px] text-slate-500">
                <input v-model="deleteCloudFiles" type="checkbox" class="rounded text-rose-600" />
                <span>连带删除网盘文件</span>
              </label>
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="px-2 py-0.5 rounded text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 cursor-pointer"
                @click="cancelDeleteTask"
              >
                取消
              </button>
              <button
                type="button"
                class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                @click="confirmDeleteTask(task.id)"
              >
                确认删除
              </button>
            </div>
          </div>

          <!-- 原位重置进度确认胶囊 (零弹窗体验) -->
          <div
            v-else-if="resettingTaskId === task.id"
            class="w-full flex items-center justify-between p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800"
          >
            <span class="text-xs text-amber-800 dark:text-amber-300 font-bold pl-1">
              重置当前进度为 0 集并重新追更？
            </span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="px-2 py-0.5 rounded text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 cursor-pointer"
                @click="cancelResetProgress"
              >
                取消
              </button>
              <button
                type="button"
                class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                @click="confirmResetProgress(task)"
              >
                确认重置
              </button>
            </div>
          </div>

          <!-- 常态操作工具栏 -->
          <template v-else>
            <div class="flex items-center gap-1.5">
              <!-- 立即转存按钮 -->
              <button
                type="button"
                class="btn-default text-xs h-8 px-2.5 flex items-center gap-1 cursor-pointer"
                :disabled="executingMap[task.id]"
                title="立即发起一次云盘转存"
                @click="handleExecuteTask(task)"
              >
                <RefreshCw v-if="executingMap[task.id]" class="w-3.5 h-3.5 animate-spin text-blue-500" />
                <Play v-else class="w-3.5 h-3.5 text-blue-500 fill-current" />
                <span>{{ executingMap[task.id] ? '执行中...' : '立即转存' }}</span>
              </button>

              <!-- 重置进度按钮 -->
              <button
                type="button"
                class="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="重置追更进度"
                @click="startResetProgress(task)"
              >
                <RotateCcw class="w-3.5 h-3.5" />
              </button>
            </div>

            <div class="flex items-center gap-1">
              <!-- 编辑任务按钮 -->
              <button
                type="button"
                class="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="编辑追更配置"
                @click="openInlineEditForm(task)"
              >
                <Edit3 class="w-3.5 h-3.5" />
              </button>

              <!-- 删除任务按钮 -->
              <button
                type="button"
                class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                title="删除任务"
                @click="startDeleteTask(task.id)"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-fadeIn {
  animation: fadeIn 0.25s ease-out forwards;
}
</style>

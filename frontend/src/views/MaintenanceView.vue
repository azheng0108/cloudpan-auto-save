<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ShieldCheck,
  Trash2,
  FolderTree,
  FolderX,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Play,
  Save,
  Check,
  Info,
  Clock,
  HardDrive,
  FileQuestion,
  Sparkles,
  Search,
  Filter,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ShieldAlert,
  Tv,
  Copy,
  ListVideo,
  FileText,
  History,
  RotateCcw,
  Database,
  EyeOff,
  Shield,
  Terminal,
  Layers,
  FileCheck,
  ExternalLink,
  Film,
  X,
  Plus,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import { accountApi } from '../api/account';
import { settingsApi } from '../api/settings';
import { useLogStore } from '../stores/log';
import AccountSwitcher from '../components/AccountSwitcher.vue';
import type { AccountSwitcherItem } from '../components/accountSwitcher';
import {
  maintenanceApi,
  type BannedFileItem,
  type BannedScanResult,
  type BannedCleanResult,
  type MissingSeasonResult,
  type MissingShowGroup,
  type LocalEpisodeFileItem,
  type EpisodeInspectionResult,
  type MissingScanJobStatus,
  type BannedTombstone,
  type MaintenanceJobItem,
  type MaintenanceJobDetail,
} from '../api/maintenance';
import FolderTreeSelector from '../components/FolderTreeSelector.vue';

export interface MissingScanBatch {
  id: string | number;
  jobId?: number;
  title: string;
  folderPath: string;
  timeFormatted: string;
  timestamp: number;
  durationMs: number;
  totalShows: number;
  missingShowsCount: number;
  completeShowsCount: number;
  unidentifiedShowsCount: number;
  totalMissingCount: number;
  totalFiles: number;
  isExpanded: boolean;
  isLoadingDetail?: boolean;
  result?: EpisodeInspectionResult;
  tabFilter: 'missing' | 'all' | 'unidentified';
  selectedShowKeys: Set<string>;
  expandedCompareKeys: Set<string>;
  activeSeasonMap: Record<string, number>;
  currentPage?: number;
  pageSize?: number;
}

export interface CleanRecordItem {
  id: string;
  timestamp: number;
  timeFormatted: string;
  type: 'banned' | 'empty';
  typeName: string;
  folderPath: string;
  successCount: number;
  failedCount: number;
  freedBytes: number;
  freedFormatted: string;
  durationMs: number;
  details: string[];
}

const route = useRoute();
const router = useRouter();

// 区分「网盘清理与违规排查 (/maintenance)」与「TMDB 剧集缺集检测 (/missing)」独立视图模式
const isMissingRoute = computed(() => {
  return route.path === '/missing' || route.path === '/episodes' || route.path.includes('/missing') || route.query.tab === 'missing';
});

// 当前激活 Tab ('banned' | 'missing' | 'records' | 'schedule')
const activeTab = ref<'banned' | 'missing' | 'records' | 'schedule'>(isMissingRoute.value ? 'missing' : 'banned');

watch(
  () => [route.path, route.query.tab],
  ([path, tab]) => {
    if (tab === 'records') {
      activeTab.value = 'records';
      return;
    }
    if (tab === 'schedule') {
      activeTab.value = 'schedule';
      return;
    }
    if (path === '/missing' || path === '/episodes' || tab === 'missing') {
      if (activeTab.value === 'banned') {
        activeTab.value = 'missing';
      }
    } else if (path === '/maintenance') {
      if (activeTab.value === 'missing') {
        activeTab.value = 'banned';
      }
    }
  },
  { immediate: true }
);

// 账号选择（单一状态源保留在父组件：v-model 驱动 AccountSwitcher，11 处下游引用零改动）
const accounts = ref<AccountSwitcherItem[]>([]);
const activeAccountId = ref<number | string>('');

// 当前选中的云盘账号与容量信息（运行时携带 capacity 等后端字段，超出子组件展示契约）
const currentAccount = computed<(AccountSwitcherItem & { capacity?: any }) | null>(() => {
  return accounts.value.find((a) => a.id === activeAccountId.value) || accounts.value[0] || null;
});

// 账号切换（由 AccountSwitcher select 事件触发：父组件更新状态源并统一提示，子组件无副作用）
function handleAccountSwitch(acc: AccountSwitcherItem) {
  activeAccountId.value = acc.id;
  const name = acc.accountName || acc.username || acc.phone || acc.id;
  ElMessage.success(`已切换 139 移动云盘操作用户: ${name}`);
}

const currentCapacity = computed(() => {
  const cap = currentAccount.value?.capacity?.cloudCapacityInfo || currentAccount.value?.capacity?.totalCapacityInfo;
  if (!cap || !cap.totalSize) return null;
  const used = Number(cap.usedSize || 0);
  const total = Number(cap.totalSize || 0);
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const format = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TB';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / 1024).toFixed(2) + ' KB';
  };
  return {
    usedFormatted: format(used),
    totalFormatted: format(total),
    freeFormatted: format(Math.max(0, total - used)),
    percent,
  };
});

// 各模块独立的指定文件夹状态 (各自手动设置指定文件夹，不再共用)
const TARGET_FOLDERS_KEY = 'cloudpan_maintenance_folders_v1';
const bannedFolderId = ref<string>('/');
const bannedFolderName = ref<string>('');

const missingFolderId = ref<string>('/');
const missingFolderName = ref<string>('');

type TargetModule = 'banned' | 'missing' | 'schedule_banned';
const pickerTargetModule = ref<TargetModule>('banned');
const isFolderPickerVisible = ref(false);

// 清理与巡检历史流水记录状态 (SQLite 持久化)
const CLEAN_RECORDS_KEY = 'cloudpan_clean_records_v1';
const cleanRecords = ref<CleanRecordItem[]>([]);
const expandedRecordIds = ref<Set<string>>(new Set());

const maintenanceJobs = ref<MaintenanceJobItem[]>([]);
const isLoadingJobs = ref(false);
const expandedJobId = ref<number | null>(null);
const expandedJobDetail = ref<MaintenanceJobDetail | null>(null);
const isLoadingJobDetail = ref(false);

const totalCleanedBannedCount = computed(() => {
  const fromJobs = maintenanceJobs.value
    .filter((j) => j.type === 'banned_clean')
    .reduce((acc, cur) => acc + (cur.cleanedCount || 0), 0);
  const fromLegacy = cleanRecords.value
    .filter((r) => r.type === 'banned')
    .reduce((acc, cur) => acc + (cur.successCount || 0), 0);
  return Math.max(fromJobs, fromLegacy);
});

const totalCleanedEmptyCount = computed(() => {
  const fromJobs = maintenanceJobs.value
    .filter((j) => j.type === 'empty_prune')
    .reduce((acc, cur) => acc + (cur.cleanedCount || 0), 0);
  const fromLegacy = cleanRecords.value
    .filter((r) => r.type === 'empty')
    .reduce((acc, cur) => acc + (cur.successCount || 0), 0);
  return Math.max(fromJobs, fromLegacy);
});

const totalMissingShowsCount = computed(() => {
  return maintenanceJobs.value
    .filter((j) => j.type === 'missing_scan')
    .reduce((acc, cur) => acc + (cur.bannedCount || 0), 0);
});

const missingJobsCount = computed(() => {
  return maintenanceJobs.value.filter((j) => j.type === 'missing_scan').length;
});

const bannedJobsCount = computed(() => {
  return maintenanceJobs.value.filter((j) => j.type !== 'missing_scan').length;
});

const totalMissingEpisodesSum = computed(() => {
  return maintenanceJobs.value
    .filter((j) => j.type === 'missing_scan')
    .reduce((acc, cur) => acc + (cur.cleanedCount || 0), 0);
});

// 巡检与清理记录过滤 ('all' | 'banned_scan' | 'banned_clean' | 'missing_scan' | 'empty_prune' | 'cron' | 'manual')
const activeRecordsFilter = ref<'all' | 'banned_scan' | 'banned_clean' | 'missing_scan' | 'empty_prune' | 'cron' | 'manual'>('all');

const filteredMaintenanceJobs = computed(() => {
  if (isMissingRoute.value) {
    const list = maintenanceJobs.value.filter((j) => j.type === 'missing_scan');
    if (activeRecordsFilter.value === 'cron') {
      return list.filter((j) => j.triggerType === 'cron');
    }
    if (activeRecordsFilter.value === 'manual') {
      return list.filter((j) => j.triggerType !== 'cron');
    }
    return list;
  }

  // maintenance 模式: 过滤仅保留违规清理、空目录修剪，排除 missing_scan
  const list = maintenanceJobs.value.filter((j) => j.type !== 'missing_scan');
  if (activeRecordsFilter.value === 'all') return list;
  if (activeRecordsFilter.value === 'cron') return list.filter((j) => j.triggerType === 'cron');
  return list.filter((j) => j.type === activeRecordsFilter.value);
});

// ─────────────────────────────────────────────────────────────
// 模块 1: 违规死链巡检与清理状态
// ─────────────────────────────────────────────────────────────
const isBannedScanning = ref(false);
const isBannedCleaning = ref(false);
const bannedScanResult = ref<BannedScanResult | null>(null);
const bannedCleanResult = ref<BannedCleanResult | null>(null);
const selectedBannedIds = ref<Set<string>>(new Set());

// 处置配置（内联面板开关见内联确认状态契约区）
const cleanAction = ref<'trash' | 'quarantine'>('quarantine');
const quarantinePath = ref<string>('');
const cascadeCompanion = ref(true);
const notifyEmby = ref(true);
const pruneEmptyParent = ref(true);
const CLEAN_PREF_KEY = 'cloudpan_clean_pref_v1';

// 违规扫描媒体范围控制 ('video' | 'all')
const bannedScanScope = ref<'video' | 'all'>('video');

// 默认天然视频格式列表
const DEFAULT_VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.iso', '.rmvb', '.webm', '.mpg', '.mpeg', '.vob'];

// 自定义手动追加排查格式
const customExtensions = ref<string[]>([]);
const newExtInput = ref<string>('');

// 和谐检测内嵌审计与清理记录折叠/展开状态
const isAuditHistoryExpanded = ref<boolean>(false);

function addCustomExtension() {
  const raw = newExtInput.value.trim().toLowerCase();
  if (!raw) return;
  // 支持逗号、顿号、分号或空格批量输入
  const parts = raw.split(/[,，、;\s]+/).filter(Boolean);
  let addedCount = 0;
  for (const part of parts) {
    const normalized = part.startsWith('.') ? part : `.${part}`;
    if (DEFAULT_VIDEO_EXTS.includes(normalized)) {
      ElMessage.info(`格式 ${normalized} 已为系统默认内置的视频格式，无需额外添加`);
    } else if (customExtensions.value.includes(normalized)) {
      ElMessage.info(`格式 ${normalized} 已在排查格式列表中`);
    } else {
      customExtensions.value.push(normalized);
      addedCount++;
    }
  }
  if (addedCount > 0) {
    saveCleanPref();
    ElMessage.success(`已添加追加排查格式 (${addedCount} 个)`);
  }
  newExtInput.value = '';
}

function removeCustomExtension(ext: string) {
  customExtensions.value = customExtensions.value.filter((e) => e !== ext);
  saveCleanPref();
}

// 自定义排除扫描目录（留空自动排除隔离区，支持用户自由配置多个）
const bannedExcludePathsStr = ref<string>('');

// 永久忽略白名单状态 (防特定误报，本地持久化)
export interface IgnoredBannedItem {
  id: string;
  name: string;
  path: string;
  reason: string;
  sizeFormatted: string;
  timestamp: number;
  timeFormatted: string;
}

const IGNORE_LIST_KEY = 'cloudpan_banned_ignore_list_v1';
const ignoredBannedItems = ref<IgnoredBannedItem[]>([]);
const ignoredBannedIds = computed(() => new Set(ignoredBannedItems.value.map((i) => i.id)));

function loadIgnoreList() {
  try {
    const raw = localStorage.getItem(IGNORE_LIST_KEY);
    if (raw) {
      ignoredBannedItems.value = JSON.parse(raw);
    }
  } catch (_) {
    ignoredBannedItems.value = [];
  }
}

function saveIgnoreList() {
  try {
    localStorage.setItem(IGNORE_LIST_KEY, JSON.stringify(ignoredBannedItems.value));
  } catch (_) {}
}

function addToIgnoreList(item: BannedFileItem) {
  if (!item || !item.id) return;
  if (ignoredBannedIds.value.has(item.id)) {
    ElMessage.info('该文件已在白名单中');
    return;
  }
  const now = new Date();
  const timeFormatted = now.toLocaleString('zh-CN', { hour12: false });
  ignoredBannedItems.value.unshift({
    id: item.id,
    name: item.name,
    path: item.path,
    reason: item.reason,
    sizeFormatted: item.sizeFormatted,
    timestamp: Date.now(),
    timeFormatted,
  });
  saveIgnoreList();

  // 从当前扫描列表中移除
  if (bannedScanResult.value?.bannedFiles) {
    bannedScanResult.value.bannedFiles = bannedScanResult.value.bannedFiles.filter((f) => f.id !== item.id);
    bannedScanResult.value.bannedCount = bannedScanResult.value.bannedFiles.length;
  }
  selectedBannedIds.value.delete(item.id);
  ElMessage.success(`已将《${item.name}》加入永久忽略白名单，后续扫描将自动跳过`);
}

function removeFromIgnoreList(id: string) {
  ignoredBannedItems.value = ignoredBannedItems.value.filter((i) => i.id !== id);
  saveIgnoreList();
  ElMessage.success('已从永久白名单移出，下次扫描将恢复检测');
}

function clearAllIgnoreList() {
  ignoredBannedItems.value = [];
  try {
    localStorage.removeItem(IGNORE_LIST_KEY);
  } catch (_) {}
  ElMessage.success('已清空全部忽略白名单');
}

const selectedBannedSizeFormatted = computed(() => {
  if (!bannedScanResult.value?.bannedFiles) return '0 B';
  const size = bannedScanResult.value.bannedFiles
    .filter((f) => selectedBannedIds.value.has(f.id))
    .reduce((sum, f) => sum + (f.size || 0), 0);
  if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
  if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
  return size + ' B';
});

// ─────────────────────────────────────────────────────────────
// 网盘和谐与死链结果分类过滤 ('all' | 'harmonized' | 'deadlink')
// ─────────────────────────────────────────────────────────────
const activeBannedFilter = ref<'all' | 'harmonized' | 'deadlink'>('all');

function isHarmonizedItem(item: BannedFileItem): boolean {
  if (!item) return false;
  const r = (item.reason || '').toLowerCase();
  return r.includes('审核') || r.includes('审查') || r.includes('封禁') || r.includes('黑名单') || r.includes('拦截');
}

function isDeadLinkItem(item: BannedFileItem): boolean {
  if (!item) return false;
  const r = (item.reason || '').toLowerCase();
  return r.includes('0字节') || r.includes('死链') || r.includes('空文件') || r.includes('损坏');
}

const filteredBannedFiles = computed(() => {
  const files = bannedScanResult.value?.bannedFiles || [];
  if (activeBannedFilter.value === 'harmonized') {
    return files.filter(isHarmonizedItem);
  }
  if (activeBannedFilter.value === 'deadlink') {
    return files.filter(isDeadLinkItem);
  }
  return files;
});

const bannedHarmonizedCount = computed(() => {
  return (bannedScanResult.value?.bannedFiles || []).filter(isHarmonizedItem).length;
});

const bannedDeadLinkCount = computed(() => {
  return (bannedScanResult.value?.bannedFiles || []).filter(isDeadLinkItem).length;
});

const isAllFilteredBannedSelected = computed(() => {
  const list = filteredBannedFiles.value;
  if (!list.length) return false;
  return list.every((f) => selectedBannedIds.value.has(f.id));
});

// ─────────────────────────────────────────────────────────────
// 和谐墓碑档案库状态 (记录被网盘封禁并清理/隔离的剧集信息)
// ─────────────────────────────────────────────────────────────
const TOMBSTONES_KEY = 'cloudpan_banned_tombstones_v1';
const tombstones = ref<BannedTombstone[]>([]);

function loadTombstones() {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    if (raw) {
      tombstones.value = JSON.parse(raw);
    }
  } catch (_) {
    tombstones.value = [];
  }
}

function saveTombstones() {
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones.value));
  } catch (_) {}
}

function addTombstones(newItems: BannedTombstone[]) {
  if (!newItems || !newItems.length) return;
  const now = new Date();
  const timeFormatted = now.toLocaleString('zh-CN', { hour12: false });
  const enriched = newItems.map((item) => ({
    ...item,
    timeFormatted: item.timeFormatted || timeFormatted,
  }));
  tombstones.value.unshift(...enriched);
  if (tombstones.value.length > 500) {
    tombstones.value = tombstones.value.slice(0, 500);
  }
  saveTombstones();
}

function clearAllTombstones() {
  tombstones.value = [];
  try {
    localStorage.removeItem(TOMBSTONES_KEY);
  } catch (_) {}
  ElMessage.success('已清空全部和谐历史档案');
}

function getTombstone(showTitle: string, season: number, episode: number | string | undefined): BannedTombstone | undefined {
  if (!episode) return undefined;
  const epNum = Number(episode);
  if (isNaN(epNum)) return undefined;
  const normTitle = (showTitle || '').trim().toLowerCase();
  return tombstones.value.find((t) => {
    const tTitle = (t.showTitle || '').trim().toLowerCase();
    const tSeason = Number(t.season || 1);
    const tEpisode = Number(t.episode);
    return (normTitle.includes(tTitle) || tTitle.includes(normTitle)) && tSeason === season && tEpisode === epNum;
  });
}

function getShowTombstoneCount(showTitle: string, season: number, missingEpisodes: any[]): number {
  if (!missingEpisodes || !missingEpisodes.length) return 0;
  return missingEpisodes.filter((ep) => {
    const epNum = ep.episode_number || parseInt(String(ep.tag || '').replace(/\D/g, '') || '0', 10);
    return Boolean(getTombstone(showTitle, season, epNum));
  }).length;
}

function jumpToEpisodeInspection(dir: string) {
  activeTab.value = 'missing';
  missingFolderName.value = dir;
  missingFolderId.value = dir;
  saveTargetFolders();
  ElMessage.success(`已切换至缺集检测，目标目录: ${dir}`);
}

// ─────────────────────────────────────────────────────────────
// 模块 2: 剧集缺集检测与断集巡检状态
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 巡检批次流管理 (扫描一次算一次，每个批次独立折叠展开)
// ─────────────────────────────────────────────────────────────
const scanBatches = ref<MissingScanBatch[]>([]);
const activeScanBatchId = ref<string | null>(null);
const activeDeleteBatch = ref<MissingScanBatch | null>(null);

function setBatchActiveSeason(batch: MissingScanBatch, showKey: string, seasonNum: number) {
  batch.activeSeasonMap[showKey] = seasonNum;
}

function buildShowGroupsFallback(items: any[]): MissingShowGroup[] {
  const map = new Map<string, MissingShowGroup>();
  for (const item of items) {
    if (!item) continue;
    let seriesFolder = (item.folderPath || '').replace(/\\/g, '/');
    if (/(?:[\\/](?:Season\s*\d+|S\d+|第\s*\d+\s*季|SP))$/i.test(seriesFolder)) {
      seriesFolder = seriesFolder.substring(0, seriesFolder.lastIndexOf('/'));
    }
    const key = seriesFolder ? `dir:${seriesFolder}` : (item.tmdbId ? `tmdb:${item.tmdbId}` : `title:${(item.title || '').trim().toLowerCase()}`);
    if (!map.has(key)) {
      map.set(key, {
        showKey: key,
        title: item.title,
        folderPath: seriesFolder || item.folderPath,
        folderId: item.folderId,
        tmdbId: item.tmdbId,
        posterPath: item.posterPath,
        firstAirYear: item.firstAirYear,
        airStatus: item.airStatus,
        isEnded: item.isEnded,
        isUnidentified: Boolean(!item.tmdbId || item.isUnidentified || item.status === 'unidentified'),
        unidentifiedReason: item.unidentifiedReason || '',
        sampleFiles: item.sampleFiles || [],
        suggestedCandidate: item.suggestedCandidate || null,
        seasons: [],
        totalMissingCount: 0,
        totalLocalCount: 0,
        totalTmdbCount: 0,
        hasMissing: false,
      });
    }
    const show = map.get(key)!;
    show.seasons.push(item);
    show.totalMissingCount += (item.missingCount || 0);
    show.totalLocalCount += (item.localCount || 0);
    show.totalTmdbCount += (item.tmdbCount || (item.localCount + item.missingCount) || 0);
    if (show.seasons.some(s => s.missingCount > 0)) {
      show.hasMissing = true;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalMissingCount - a.totalMissingCount);
}

function syncCurrentResultToBatches(res: EpisodeInspectionResult, folderPath = missingFolderName.value || '/tv') {
  if (!res || (!res.shows?.length && !res.items?.length && res.scannedShowsCount === 0)) return;

  const unidentifiedCount = res.shows?.filter(s => s.isUnidentified || !s.tmdbId).length || res.unidentifiedShowsCount || 0;
  const missingCount = res.shows?.filter(s => !s.isUnidentified && (s.hasMissing || s.totalMissingCount > 0)).length || res.missingShowsCount || 0;
  const completeCount = res.shows?.filter(s => !s.isUnidentified && !s.hasMissing && s.totalMissingCount === 0).length || res.completeShowsCount || 0;

  const targetBatchId = activeScanBatchId.value;
  const existingIdx = targetBatchId
    ? scanBatches.value.findIndex(b => b.id === targetBatchId)
    : scanBatches.value.findIndex(b => b.id === 'current' || (Date.now() - b.timestamp < 180000 && b.folderPath === folderPath));
  const batchItem: MissingScanBatch = {
    id: existingIdx !== -1 ? scanBatches.value[existingIdx].id : (targetBatchId || `batch-${Date.now()}`),
    title: `缺更巡检 · ${folderPath}`,
    folderPath,
    timeFormatted: new Date().toLocaleString('zh-CN', { hour12: false }),
    timestamp: Date.now(),
    durationMs: res.durationMs || 0,
    totalShows: res.shows?.length || res.scannedShowsCount || 0,
    missingShowsCount: missingCount,
    completeShowsCount: completeCount,
    unidentifiedShowsCount: unidentifiedCount,
    totalMissingCount: res.totalMissingCount || 0,
    totalFiles: res.scannedFilesCount || 0,
    isExpanded: true,
    tabFilter: unidentifiedCount > 0 && missingCount === 0 ? 'unidentified' : 'missing',
    selectedShowKeys: new Set(),
    expandedCompareKeys: new Set(),
    activeSeasonMap: {},
    currentPage: 1,
    pageSize: 15,
    result: res,
  };

  if (existingIdx !== -1) {
    batchItem.isExpanded = scanBatches.value[existingIdx].isExpanded;
    batchItem.tabFilter = scanBatches.value[existingIdx].tabFilter;
    batchItem.selectedShowKeys = scanBatches.value[existingIdx].selectedShowKeys;
    batchItem.expandedCompareKeys = scanBatches.value[existingIdx].expandedCompareKeys;
    scanBatches.value[existingIdx] = batchItem;
  } else {
    scanBatches.value.unshift(batchItem);
  }
}

function syncHistoricalJobsToBatches(jobs: MaintenanceJobItem[]) {
  const missingJobs = jobs.filter(j => j.type === 'missing_scan' && j.status === 'completed');
  missingJobs.forEach(j => {
    const exists = scanBatches.value.some(b => b.jobId === j.id || (Math.abs(b.timestamp - (j.timestamp ?? 0)) < 5000));
    if (!exists) {
      const uCount = (j as any).unidentifiedShowsCount || 0;
      const mCount = (j as any).missingShowsCount !== undefined ? (j as any).missingShowsCount : (j.bannedCount || 0);
      scanBatches.value.push({
        id: `job-${j.id}`,
        jobId: j.id,
        title: j.title || `缺更巡检 · ${j.folderPath}`,
        folderPath: j.folderPath || '/tv',
        timeFormatted: j.timeFormatted || new Date(j.createdAt || j.timestamp || 0).toLocaleString('zh-CN', { hour12: false }),
        timestamp: j.createdAt ? new Date(j.createdAt).getTime() : (j.timestamp ?? 0),
        durationMs: j.durationMs,
        totalShows: j.scannedFolders || 0,
        missingShowsCount: mCount,
        completeShowsCount: Math.max(0, (j.scannedFolders || 0) - mCount - uCount),
        unidentifiedShowsCount: uCount,
        totalMissingCount: j.cleanedCount || 0,
        totalFiles: j.totalFiles || 0,
        isExpanded: false,
        tabFilter: uCount > 0 && mCount === 0 ? 'unidentified' : 'missing',
        selectedShowKeys: new Set(),
        expandedCompareKeys: new Set(),
        activeSeasonMap: {},
        currentPage: 1,
        pageSize: 15,
      });
    }
  });
}

async function toggleBatchExpand(batch: MissingScanBatch) {
  batch.isExpanded = !batch.isExpanded;
  if (batch.isExpanded && !batch.result && batch.jobId) {
    batch.isLoadingDetail = true;
    try {
      const jobDetail = await maintenanceApi.getJobDetail(batch.jobId);
      if (jobDetail && jobDetail.findings) {
        const findings = jobDetail.findings as any;
        if (findings.shows && Array.isArray(findings.shows)) {
          batch.result = findings;
          batch.unidentifiedShowsCount = findings.unidentifiedShowsCount || findings.shows.filter((s: any) => s.isUnidentified).length;
          batch.missingShowsCount = findings.missingShowsCount || findings.shows.filter((s: any) => !s.isUnidentified && s.hasMissing).length;
        } else if (Array.isArray(findings)) {
          const shows = buildShowGroupsFallback(findings);
          batch.result = {
            scannedFilesCount: jobDetail.totalFiles || 0,
            scannedShowsCount: jobDetail.scannedFolders || shows.length,
            missingShowsCount: jobDetail.bannedCount || shows.filter(s => s.hasMissing).length,
            completeShowsCount: Math.max(0, (jobDetail.scannedFolders || shows.length) - (jobDetail.bannedCount || 0)),
            totalMissingCount: jobDetail.cleanedCount || 0,
            durationMs: jobDetail.durationMs,
            items: findings,
            shows,
          };
          batch.unidentifiedShowsCount = shows.filter(s => s.isUnidentified).length;
        }
      }
    } catch (err: any) {
      ElMessage.error(`加载巡检快照失败: ${err.message || '网络异常'}`);
    } finally {
      batch.isLoadingDetail = false;
    }
  }
}

function getBatchShows(batch: MissingScanBatch): MissingShowGroup[] {
  if (batch.result?.shows && Array.isArray(batch.result.shows)) {
    return batch.result.shows;
  }
  if (batch.result?.items && Array.isArray(batch.result.items)) {
    return buildShowGroupsFallback(batch.result.items);
  }
  return [];
}

function getBatchMissingShows(batch: MissingScanBatch): MissingShowGroup[] {
  return getBatchShows(batch).filter(s => !s.isUnidentified && (s.hasMissing || s.totalMissingCount > 0));
}

function getBatchAllShows(batch: MissingScanBatch): MissingShowGroup[] {
  return getBatchShows(batch).filter(s => !s.isUnidentified);
}

function getBatchUnidentifiedShows(batch: MissingScanBatch): MissingShowGroup[] {
  return getBatchShows(batch).filter(s => s.isUnidentified || !s.tmdbId);
}

function getBatchDisplayedShows(batch: MissingScanBatch): MissingShowGroup[] {
  if (batch.tabFilter === 'missing') {
    return getBatchMissingShows(batch);
  }
  if (batch.tabFilter === 'unidentified') {
    return getBatchUnidentifiedShows(batch);
  }
  return getBatchAllShows(batch);
}

function toggleBatchCompareRow(batch: MissingScanBatch, show: MissingShowGroup, seasonNum?: number) {
  if (seasonNum !== undefined) {
    batch.activeSeasonMap[show.showKey] = seasonNum;
  }
  if (batch.expandedCompareKeys.has(show.showKey)) {
    batch.expandedCompareKeys.delete(show.showKey);
  } else {
    batch.expandedCompareKeys.add(show.showKey);
  }
}

function getBatchActiveSeason(batch: MissingScanBatch, show: MissingShowGroup): MissingSeasonResult {
  const targetSeason = batch.activeSeasonMap[show.showKey];
  if (targetSeason !== undefined) {
    const found = show.seasons.find(s => Number(s.season) === Number(targetSeason));
    if (found) return found;
  }
  const firstMissing = show.seasons.find(s => s.missingCount > 0);
  if (firstMissing) return firstMissing;
  return show.seasons[0] || (show as any);
}

async function handleAdoptCandidate(batch: MissingScanBatch, show: MissingShowGroup, candidate: any) {
  if (!candidate?.id) return;
  try {
    const res = await maintenanceApi.matchTmdb({
      accountId: activeAccountId.value,
      folderPath: show.folderPath,
      folderId: show.folderId,
      tmdbId: String(candidate.id),
      applyToAllSeasons: true,
      excludeUnreleased: missingOptions.excludeUnreleased,
      ignoreSeasonZero: missingOptions.ignoreSeasonZero,
      onlyEnded: missingOptions.onlyEnded,
    });
    if (res) {
      applyUpdatedShowToResult(res);
      ElMessage.success(`已采纳《${candidate.title || show.title}》并重新复检！`);
    }
  } catch (err: any) {
    ElMessage.error(`采纳失败: ${err.message || '网络异常'}`);
  }
}

async function handleIgnoreUnidentifiedShow(batch: MissingScanBatch, show: MissingShowGroup) {
  try {
    await maintenanceApi.removeShow({
      folderPath: show.folderPath,
      showKey: show.showKey,
      tmdbId: show.tmdbId || undefined
    });
    if (batch.result?.shows) {
      batch.result.shows = batch.result.shows.filter(s => s.showKey !== show.showKey);
      batch.unidentifiedShowsCount = batch.result.shows.filter(s => s.isUnidentified).length;
    }
    ElMessage.success(`已忽略《${show.title || show.originalFolder}》`);
  } catch (err: any) {
    ElMessage.error(`操作失败: ${err.message || '网络异常'}`);
  }
}

function copyBatchMissing(batch: MissingScanBatch) {
  const missingShows = getBatchMissingShows(batch);
  if (!missingShows.length) {
    ElMessage.info('当前批次无缺集剧集');
    return;
  }
  const lines = missingShows.map(s => {
    const seasonsStr = s.seasons.filter(sea => sea.missingCount > 0).map(sea => `${sea.seasonLabel} 缺${sea.missingCount}集 [${sea.missingRangesStr}]`).join('; ');
    return `《${s.title}》: ${seasonsStr} (路径: ${s.folderPath})`;
  });
  navigator.clipboard.writeText(lines.join('\n'));
  ElMessage.success(`已复制 ${missingShows.length} 部剧集的缺更清单到剪贴板`);
}

function expandAllBatches() {
  scanBatches.value.forEach(b => {
    b.isExpanded = true;
    if (!b.result && b.jobId) {
      toggleBatchExpand(b);
    }
  });
}

function collapseAllBatches() {
  scanBatches.value.forEach(b => {
    b.isExpanded = false;
  });
}

function clearAllBatches() {
  scanBatches.value = [];
  ElMessage.success('已清空巡检批次列表');
}

async function deleteBatch(batch: MissingScanBatch, index: number) {
  scanBatches.value.splice(index, 1);
  if (batch.jobId) {
    try {
      await maintenanceApi.deleteJob(batch.jobId);
    } catch (_) {}
  }
  ElMessage.success('已删除该批次记录');
}

function getBatchCurrentPage(batch: MissingScanBatch): number {
  if (!batch.currentPage) batch.currentPage = 1;
  return batch.currentPage;
}

function getBatchPageSize(batch: MissingScanBatch): number {
  if (!batch.pageSize) batch.pageSize = 15;
  return batch.pageSize;
}

function getBatchPaginatedShows(batch: MissingScanBatch): MissingShowGroup[] {
  const all = getBatchDisplayedShows(batch);
  const page = getBatchCurrentPage(batch);
  const size = getBatchPageSize(batch);
  const start = (page - 1) * size;
  return all.slice(start, start + size);
}

function isAllBatchDisplayedShowsSelected(batch: MissingScanBatch): boolean {
  const displayed = getBatchPaginatedShows(batch);
  if (!displayed.length) return false;
  return displayed.every(s => batch.selectedShowKeys.has(s.showKey));
}

function toggleSelectAllBatchDisplayedShows(batch: MissingScanBatch) {
  const displayed = getBatchPaginatedShows(batch);
  const allSelected = isAllBatchDisplayedShowsSelected(batch);
  if (allSelected) {
    displayed.forEach(s => batch.selectedShowKeys.delete(s.showKey));
  } else {
    displayed.forEach(s => batch.selectedShowKeys.add(s.showKey));
  }
}

function toggleSelectBatchShow(batch: MissingScanBatch, showKey: string) {
  if (batch.selectedShowKeys.has(showKey)) {
    batch.selectedShowKeys.delete(showKey);
  } else {
    batch.selectedShowKeys.add(showKey);
  }
}

function clearBatchSelectedShows(batch: MissingScanBatch) {
  batch.selectedShowKeys.clear();
}

function handleBatchCopySelectedShows(batch: MissingScanBatch) {
  const selectedShows = getBatchShows(batch).filter(s => batch.selectedShowKeys.has(s.showKey));
  if (!selectedShows.length) {
    ElMessage.info('未勾选任何剧集');
    return;
  }
  const lines = selectedShows.map(s => {
    const seasonsStr = s.seasons.filter(sea => sea.missingCount > 0).map(sea => `${sea.seasonLabel} 缺${sea.missingCount}集 [${sea.missingRangesStr}]`).join('; ') || '全剧完整';
    return `《${s.title}》: ${seasonsStr} (路径: ${s.folderPath})`;
  });
  navigator.clipboard.writeText(lines.join('\n'));
  ElMessage.success(`已复制已选 ${selectedShows.length} 部剧集的清单到剪贴板`);
}

function openBatchDeleteModalForBatch(batch: MissingScanBatch) {
  activeDeleteBatch.value = batch;
  const selectedShows = getBatchShows(batch).filter(s => batch.selectedShowKeys.has(s.showKey));
  if (selectedShows.length === 0) {
    const missingShows = getBatchMissingShows(batch);
    if (missingShows.length === 0) {
      ElMessage.info('当前批次中无缺集剧集可清理');
      return;
    }
    selectedShows.push(...missingShows);
  }
  selectedMissingShowKeys.value = new Set(selectedShows.map(s => s.showKey));
  openBatchDeleteModal();
}

async function handleRecheckShowForBatch(batch: MissingScanBatch, show: MissingShowGroup) {
  const key = show.showKey || show.folderPath || show.title;
  isRecheckingShow.value[key] = true;
  try {
    const res = await maintenanceApi.recheckShow({
      accountId: activeAccountId.value,
      folderPath: show.folderPath,
      folderId: show.folderId,
      tmdbId: show.tmdbId || undefined,
      excludeUnreleased: missingOptions.excludeUnreleased,
      ignoreSeasonZero: missingOptions.ignoreSeasonZero,
      onlyEnded: missingOptions.onlyEnded,
    });
    const updatedShow: MissingShowGroup = (((res as any)?.show || res) as MissingShowGroup);
    applyUpdatedShowToResult(updatedShow);
    ElMessage.success(`《${updatedShow.title}》复检完成: 本地 ${updatedShow.totalLocalCount} 集，缺失 ${updatedShow.totalMissingCount} 集`);
  } catch (err: any) {
    ElMessage.error(`复检失败: ${err.message || "网络异常"}`);
  } finally {
    isRecheckingShow.value[key] = false;
  }
}

function reRunBatchScan(batch: MissingScanBatch) {
  missingFolderName.value = batch.folderPath;
  missingFolderId.value = batch.folderPath;
  saveTargetFolders();
  handleScanMissingEpisodes();
}

const isMissingScanning = ref(false);
const missingInspectionResult = ref<EpisodeInspectionResult | null>(null);
const missingJobStatus = ref<MissingScanJobStatus | null>(null);
let missingPollTimer: any = null;

const logStore = useLogStore();

// 过滤缺集巡检专属实时日志
const missingScanLogs = computed(() => {
  return logStore.logLines
    .filter((l) => l.includes('[缺集巡检]'))
    .slice(-30);
});

// 最新一条日志提炼展示（后端作业优先，平滑容错实时日志流）
const latestMissingScanLog = computed(() => {
  if (missingJobStatus.value?.status === 'running' && missingJobStatus.value.lastMessage) {
    return missingJobStatus.value.lastMessage;
  }
  const logs = missingScanLogs.value;
  if (!logs.length) return '正在连接云盘目录并准备扫描...';
  const last = logs[logs.length - 1];
  let cleaned = last
    .replace(/^\[\d{4}\/\d{2}\/\d{2}\s+[^\]]+\]\s*/, '')
    .replace(/^\[缺集巡检[^\]]*\]\s*/, '')
    .trim();
  cleaned = cleaned.replace(/^\[\d\/\d\s+[^\]]+\]\s*/, '');
  return cleaned || '正在深度分析中...';
});

// 当前阶段识别 (1: 结构定界, 2: 逐剧穿透核验, 3: 巡检结项)
const missingScanPhase = computed(() => {
  if (missingJobStatus.value?.status === 'completed') return 3;
  if (missingJobStatus.value?.status === 'running') {
    return (missingJobStatus.value.current > 0 || missingJobStatus.value.percent >= 10) ? 2 : 1;
  }
  const logs = missingScanLogs.value;
  if (!logs.length) return 1;
  const last = logs[logs.length - 1];
  if (last.includes('缺集巡检结项报告') || last.includes('巡检完成') || last.includes('巡检全部完成')) return 3;
  if (/\(\d+\/\d+\)/.test(last) || last.includes('逐剧全量穿透') || last.includes('全收录') || last.includes('缺失')) return 2;
  return 1;
});

// 丝滑进度百分比计算 (10% ~ 100%)
const scanProgressPercent = computed(() => {
  if (missingJobStatus.value?.status === 'running' && missingJobStatus.value.percent > 0) {
    return missingJobStatus.value.percent;
  }
  if (missingJobStatus.value?.status === 'completed') return 100;
  const logs = missingScanLogs.value;
  if (!logs.length) return 8;
  const last = logs[logs.length - 1];
  if (last.includes('缺集巡检结项报告') || last.includes('巡检完成') || last.includes('巡检全部完成')) return 100;

  // 逐剧穿透与核验进度 (cur/total)
  const showMatch = last.match(/\((\d+)\/(\d+)\)/);
  if (showMatch) {
    const cur = parseInt(showMatch[1], 10);
    const total = parseInt(showMatch[2], 10);
    if (total > 0) {
      return Math.min(95, Math.round(15 + (cur / total) * 80));
    }
  }
  if (last.includes('逐剧全量穿透')) return 15;
  if (last.includes('结构定界') || last.includes('启动剧集缺集检测')) return 10;

  return 12;
});


// 3 项规则开关（本地持久化记忆）
const MISSING_PREF_KEY = 'cloudpan_missing_pref_v1';
const missingOptions = reactive({
  excludeUnreleased: true,
  ignoreSeasonZero: true,
  onlyEnded: false,
});

function loadMissingPref() {
  try {
    const raw = localStorage.getItem(MISSING_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.excludeUnreleased !== undefined) missingOptions.excludeUnreleased = p.excludeUnreleased;
      if (p.ignoreSeasonZero !== undefined) missingOptions.ignoreSeasonZero = p.ignoreSeasonZero;
      if (p.onlyEnded !== undefined) missingOptions.onlyEnded = p.onlyEnded;
    }
  } catch (_) {}
}

function saveMissingPref() {
  try {
    localStorage.setItem(MISSING_PREF_KEY, JSON.stringify(missingOptions));
  } catch (_) {}
}

// 折叠/展开缺失明细状态 (按 showKey 记忆，默认折叠，告别50行直铺拖半天)
const expandedShowKeys = ref<Set<string>>(new Set());

// 当前卡片与表格行选中的季 Tab (showKey -> seasonNumber)
const activeSeasonTab = ref<Record<string, number>>({});

function getActiveSeason(show: MissingShowGroup): MissingSeasonResult {
  if (!show.seasons || show.seasons.length === 0) {
    return {
      groupKey: show.showKey,
      title: show.title,
      folderPath: show.folderPath,
      tmdbId: show.tmdbId,
      season: 1,
      seasonLabel: '第 1 季',
      localCount: show.totalLocalCount,
      coveredCount: show.totalLocalCount,
      tmdbCount: show.totalTmdbCount,
      missingCount: show.totalMissingCount,
      missingEpisodes: [],
      missingRangesStr: '',
      shortRangesStr: '',
      detailedList: [],
      tooltipTitle: '',
      status: show.hasMissing ? 'missing' : 'complete',
      isMatch: true,
      isExtra: false,
    };
  }
  const visible = getVisibleSeasons(show);
  if (!visible.length) {
    return {
      groupKey: show.showKey,
      title: show.title,
      folderPath: show.folderPath,
      tmdbId: show.tmdbId,
      season: 1,
      seasonLabel: '第 1 季',
      localCount: show.totalLocalCount,
      coveredCount: show.totalLocalCount,
      tmdbCount: show.totalTmdbCount,
      missingCount: show.totalMissingCount,
      missingEpisodes: [],
      missingRangesStr: '',
      shortRangesStr: '',
      detailedList: [],
      tooltipTitle: '',
      status: show.hasMissing ? 'missing' : 'complete',
      isMatch: true,
      isExtra: false,
    };
  }
  const selectedNum = activeSeasonTab.value[show.showKey];
  if (selectedNum !== undefined) {
    const found = visible.find((s) => s.season === selectedNum);
    if (found) return found;
  }
  // 默认选中：优先选择有缺集的季，若全齐则默认选第 1 季
  const firstMissing = visible.find((s) => s.missingCount > 0);
  return firstMissing || visible[0];
}

function isSeasonEndedItem(s: any): boolean {
  if (!s) return false;
  return Boolean(s.isEnded || s.airStatus === '已完结' || s.airStatus === '本季完结');
}

function isSeasonOngoing(s: any): boolean {
  if (!s) return false;
  if (s.airStatus === '连载中') return true;
  if (s.isEnded === false && s.airStatus !== '已完结' && s.airStatus !== '本季完结') return true;
  return false;
}

function isShowOngoing(s: MissingShowGroup): boolean {
  if (!s) return false;
  if (s.airStatus === '连载中') return true;
  if (s.isEnded === false && s.airStatus !== '已完结' && s.airStatus !== '本季完结') return true;
  if (Array.isArray(s.seasons) && s.seasons.some(sn => isSeasonOngoing(sn))) return true;
  return false;
}

function isShowEndedItem(s: MissingShowGroup): boolean {
  if (!s) return false;
  if (s.isEnded || s.airStatus === '已完结' || s.airStatus === '本季完结') return true;
  // 若包含已完结的老季，也视同完结（多季老季与已收官综艺视同完结）
  return Array.isArray(s.seasons) && s.seasons.some(sn => isSeasonEndedItem(sn));
}

function getVisibleSeasons(show: MissingShowGroup) {
  if (!show || !show.seasons) return [];
  let seasons = show.seasons;
  // 若开启「只检查完结剧」开关：自动跳过当季连载中分季
  if (missingOptions.onlyEnded) {
    const ended = seasons.filter(s => isSeasonEndedItem(s));
    seasons = ended;
  }
  // 彻底不展示不缺集的分季，只返回存在缺更的分季
  return seasons.filter((s) => s.missingCount > 0);
}

function setActiveSeason(showKey: string, seasonNumber: number) {
  activeSeasonTab.value[showKey] = seasonNumber;
}

// 单剧即时复检中状态 (showKey -> boolean)
const isRecheckingShow = ref<Record<string, boolean>>({});

// 本地文件与官方分集下拉展开状态 (按 show.showKey 记录展开项，下拉内联呈现，杜绝右拉抽屉遮挡)
const expandedCompareKeys = ref<Set<string>>(new Set());

function toggleCompareRow(key: string) {
  if (expandedCompareKeys.value.has(key)) {
    expandedCompareKeys.value.delete(key);
  } else {
    expandedCompareKeys.value.add(key);
  }
}

// 仅展示有缺集的剧集季项（兼容基础视图）
const missingOnlyItems = computed(() => {
  if (!missingInspectionResult.value?.items) return [];
  return missingInspectionResult.value.items.filter((i) => i.missingCount > 0);
});

// 全部已巡检的电视剧卡片列表 (包含完整收录与缺更剧集，支持「只检查完结剧」即时响应)
const allScannedShows = computed<MissingShowGroup[]>(() => {
  let list: MissingShowGroup[] = [];
  if (missingInspectionResult.value?.shows && Array.isArray(missingInspectionResult.value.shows)) {
    list = missingInspectionResult.value.shows;
  } else if (missingInspectionResult.value?.items?.length) {
    // 降级聚合
    const map = new Map<string, MissingShowGroup>();
    for (const item of missingInspectionResult.value.items) {
      const key = item.tmdbId ? `tmdb:${item.tmdbId}` : `title:${(item.title || '').trim().toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, {
          showKey: key,
          title: item.title,
          folderPath: item.folderPath,
          tmdbId: item.tmdbId,
          posterPath: item.posterPath,
          airStatus: item.airStatus,
          firstAirYear: item.firstAirYear,
          totalMissingCount: 0,
          totalLocalCount: 0,
          totalTmdbCount: 0,
          hasMissing: false,
          seasons: [],
        });
      }
      const group = map.get(key)!;
      group.totalMissingCount += item.missingCount;
      group.totalLocalCount += item.localCount;
      group.totalTmdbCount += (item.tmdbCount || (item.localCount + item.missingCount));
      if (item.missingCount > 0) group.hasMissing = true;
      group.seasons.push(item);
    }
    list = Array.from(map.values());
  }

  // ★ 核心体验：若开启「只检查完结剧」，当季连载中剧集（如《幻视任务》）即时自动过滤屏蔽！
  if (missingOptions.onlyEnded) {
    list = list.filter((s) => isShowEndedItem(s));
  }

  return list;
});

// 仅展示有缺集的同剧聚合卡片（用于统计与展示）
const missingOnlyShows = computed<MissingShowGroup[]>(() => {
  return allScannedShows.value.filter((s) => {
    const visible = getVisibleSeasons(s);
    return visible.some(sn => sn.missingCount > 0);
  });
});

// ─────────────────────────────────────────────────────────────
// 剧集缺集列表分类过滤 ('missing' | 'harmonized' | 'all')
// ─────────────────────────────────────────────────────────────
const missingShowTabFilter = ref<'missing' | 'harmonized' | 'all'>('missing');

function showHasHarmonizedEpisode(show: MissingShowGroup): boolean {
  return (show.seasons || []).some((season: any) => {
    return (season.missingEpisodes || []).some((m: any) => {
      return Boolean(getTombstone(season.title, season.season, m.episode));
    });
  });
}

const filteredMissingShows = computed<MissingShowGroup[]>(() => {
  if (missingShowTabFilter.value === 'harmonized') {
    return missingOnlyShows.value.filter(showHasHarmonizedEpisode);
  }
  if (missingShowTabFilter.value === 'all') {
    return allScannedShows.value;
  }
  return missingOnlyShows.value;
});

const harmonizedShowsCount = computed(() => {
  return missingOnlyShows.value.filter(showHasHarmonizedEpisode).length;
});

function getSeasonHarmonizedCount(season: any): number {
  if (!season || !season.missingEpisodes) return 0;
  return season.missingEpisodes.filter((m: any) => {
    return Boolean(getTombstone(season.title, season.season, m.episode));
  }).length;
}

// 缺集列表分页状态 (支持 10/20/50/100 条分页展示)
const missingCurrentPage = ref(1);
const missingPageSize = ref(10);

const totalMissingShows = computed(() => filteredMissingShows.value.length);
const totalMissingPages = computed(() => Math.ceil(totalMissingShows.value / missingPageSize.value) || 1);

watch([filteredMissingShows, missingPageSize], () => {
  if (missingCurrentPage.value > totalMissingPages.value) {
    missingCurrentPage.value = Math.max(1, totalMissingPages.value);
  }
});

// 当前展示的电视剧列表（分页切片展示，杜绝一次性全量长列表）
const displayedShows = computed<MissingShowGroup[]>(() => {
  const start = (missingCurrentPage.value - 1) * missingPageSize.value;
  const end = start + missingPageSize.value;
  return filteredMissingShows.value.slice(start, end);
});

// 缺集列表多选集合 (showKey -> Set<string>)
const selectedMissingShowKeys = ref<Set<string>>(new Set());

function toggleSelectMissingShow(showKey: string) {
  if (selectedMissingShowKeys.value.has(showKey)) {
    selectedMissingShowKeys.value.delete(showKey);
  } else {
    selectedMissingShowKeys.value.add(showKey);
  }
}

// 当前页是否全选
const isAllDisplayedShowsSelected = computed(() => {
  if (displayedShows.value.length === 0) return false;
  return displayedShows.value.every(s => selectedMissingShowKeys.value.has(s.showKey));
});

// 当前页是否有部分选中 (半选状态)
const isSomeDisplayedShowsSelected = computed(() => {
  if (isAllDisplayedShowsSelected.value) return false;
  return displayedShows.value.some(s => selectedMissingShowKeys.value.has(s.showKey));
});

function toggleSelectAllDisplayedShows() {
  if (isAllDisplayedShowsSelected.value) {
    for (const s of displayedShows.value) {
      selectedMissingShowKeys.value.delete(s.showKey);
    }
  } else {
    for (const s of displayedShows.value) {
      selectedMissingShowKeys.value.add(s.showKey);
    }
  }
}

function selectAllMissingShows() {
  selectedMissingShowKeys.value = new Set(missingOnlyShows.value.map(s => s.showKey));
}

function clearSelectedMissingShows() {
  selectedMissingShowKeys.value.clear();
}

function handleLegacyBatchCopySelectedShows() {
  const selected = missingOnlyShows.value.filter(s => selectedMissingShowKeys.value.has(s.showKey));
  if (selected.length === 0) {
    ElMessage.info('请先选择要复制的剧集');
    return;
  }
  const lines: string[] = [];
  lines.push(`【TMDB 剧集缺更清单 (已选 ${selected.length} 部)】`);
  for (const show of selected) {
    const seasons = getVisibleSeasons(show);
    const seasonStrs = seasons.map(s => `${s.seasonLabel} (缺${s.missingCount}集${s.missingRangesStr ? ': ' + s.missingRangesStr : ''})`).join('; ');
    lines.push(`- 《${show.title}》: ${seasonStrs} [${show.folderPath}]`);
  }
  const content = lines.join('\n');
  navigator.clipboard.writeText(content).then(() => {
    ElMessage.success(`已复制 ${selected.length} 部选中剧集的缺更清单至剪贴板`);
  }).catch(() => {
    ElMessage.warning('复制失败，请检查浏览器剪贴板权限');
  });
}

function handleBatchRemoveSelectedShows() {
  const count = selectedMissingShowKeys.value.size;
  if (count === 0) return;
  if (missingInspectionResult.value?.shows) {
    missingInspectionResult.value.shows = missingInspectionResult.value.shows.filter(
      s => !selectedMissingShowKeys.value.has(s.showKey)
    );
  }
  if (missingInspectionResult.value?.items) {
    missingInspectionResult.value.items = missingInspectionResult.value.items.filter(
      item => {
        const key = item.tmdbId ? `tmdb:${item.tmdbId}` : `title:${(item.title || '').trim().toLowerCase()}`;
        return !selectedMissingShowKeys.value.has(key);
      }
    );
  }
  selectedMissingShowKeys.value.clear();
  ElMessage.success(`已从本次巡检列表中移除 ${count} 部剧集展示`);
}

// 当前生效的累计缺失分集总数 (精确适配「只检查完结剧」过滤)
const effectiveTotalMissingCount = computed(() => {
  return missingOnlyShows.value.reduce((acc, show) => {
    const visible = getVisibleSeasons(show);
    return acc + visible.reduce((sAcc, s) => sAcc + (s.missingCount || 0), 0);
  }, 0);
});

// 对照面板内分集快速过滤状态 (groupKey -> 'all' | 'missing' | 'harmonized' | 'collected')
const compareEpisodeFilter = ref<Record<string, 'all' | 'missing' | 'harmonized' | 'collected'>>({});

// 核心体验提升：展开对照时，若当前季存在缺集，默认优先展示「仅缺集」，直达缺更详情；若已收全则默认展示「全部」
function getCompareFilter(season: any): 'all' | 'missing' | 'harmonized' | 'collected' {
  if (!season) return 'all';
  if (compareEpisodeFilter.value[season.groupKey]) {
    return compareEpisodeFilter.value[season.groupKey];
  }
  return (season.missingCount > 0) ? 'missing' : 'all';
}

interface MergedEpisodeItem {
  epNum: number;
  tag: string;
  name: string;
  airDate?: string;
  isMissing: boolean;
  tombstone?: any;
  matchedFiles: Array<{ name: string; sizeFormatted: string; fileId?: string }>;
}

function getSeasonMergedEpisodes(season: any, filterMode: 'all' | 'missing' | 'harmonized' | 'collected' = 'all'): MergedEpisodeItem[] {
  if (!season) return [];
  const total = Number(season.totalEpisodes || season.tmdbCount || (season.localCount + season.missingCount) || 0);
  const items: MergedEpisodeItem[] = [];
  const localFiles = season.localFiles || [];

  for (let ep = 1; ep <= total; ep++) {
    const missingInfo = season.missingEpisodes?.find((m: any) => Number(m.episode) === ep);
    const isMissing = Boolean(missingInfo);
    const tombstone = getTombstone(season.title, season.season, ep);
    const matchedFiles = localFiles.filter((f: any) => Number(f.parsedEpisode) === ep);

    const name = missingInfo?.name || `第 ${ep} 集`;
    const airDate = missingInfo?.airDate || '';

    if (filterMode === 'missing' && !isMissing) continue;
    if (filterMode === 'harmonized' && (!isMissing || !tombstone)) continue;
    if (filterMode === 'collected' && isMissing) continue;

    items.push({
      epNum: ep,
      tag: `E${String(ep).padStart(2, '0')}`,
      name,
      airDate,
      isMissing,
      tombstone,
      matchedFiles,
    });
  }

  return items;
}

function getUnmatchedFiles(season: any) {
  if (!season || !season.localFiles) return [];
  const total = Number(season.totalEpisodes || season.tmdbCount || (season.localCount + season.missingCount) || 0);
  return season.localFiles.filter((f: any) => {
    const ep = Number(f.parsedEpisode);
    return !ep || ep < 1 || ep > total || f.matchStatus !== 'matched';
  });
}

// 智能化修正识别与 TMDB 匹配内联面板状态（原位展开于目标剧集卡片，替代 el-dialog）
const matchTmdbLoading = ref(false);
const matchTmdbSearching = ref(false);
const matchTmdbCandidates = ref<any[]>([]);
const matchTmdbForm = reactive({
  folderPath: '',
  folderId: '',
  showTitle: '',
  seasonsCount: 1,
  activeSeason: 1,
  currentTmdbId: '',
  searchQuery: '',
  searchYear: '',
  searchMediaType: 'tv',
  selectedTmdbId: '',
  applyToAllSeasons: true,
});

// ─────────────────────────────────────────────────────────────
// 模块 3: 定时维护计划配置状态
// ─────────────────────────────────────────────────────────────
const isSavingSchedule = ref(false);
const scheduleForm = reactive({
  enableBannedScanCron: false,
  bannedScanCron: '0 3 * * 0',
  autoCleanBanned: false,
  enableMissingScanCron: false,
  missingScanCron: '0 6 * * *',
  notifyOnMaintenance: true,
});

let rawFullConfig: Record<string, any> = {};

// 加载清理历史与本地文件夹设置
function loadCleanRecords() {
  try {
    const raw = localStorage.getItem(CLEAN_RECORDS_KEY);
    if (raw) {
      cleanRecords.value = JSON.parse(raw);
    }
  } catch (_) {
    cleanRecords.value = [];
  }
}

function addCleanRecord(record: Omit<CleanRecordItem, 'id' | 'timestamp' | 'timeFormatted'>) {
  const now = new Date();
  const timeFormatted = now.toLocaleString('zh-CN', { hour12: false });
  const item: CleanRecordItem = {
    ...record,
    id: `clean_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
    timeFormatted,
  };
  cleanRecords.value.unshift(item);
  if (cleanRecords.value.length > 100) {
    cleanRecords.value = cleanRecords.value.slice(0, 100);
  }
  try {
    localStorage.setItem(CLEAN_RECORDS_KEY, JSON.stringify(cleanRecords.value));
  } catch (_) {}
}

function clearAllCleanRecords() {
  cleanRecords.value = [];
  try {
    localStorage.removeItem(CLEAN_RECORDS_KEY);
  } catch (_) {}
  ElMessage.success('已清空全部本地清理记录');
}

function toggleExpandRecord(id: string) {
  if (expandedRecordIds.value.has(id)) {
    expandedRecordIds.value.delete(id);
  } else {
    expandedRecordIds.value.add(id);
  }
}

async function loadMaintenanceJobs() {
  isLoadingJobs.value = true;
  try {
    const res = await maintenanceApi.getJobs({ limit: 50 });
    maintenanceJobs.value = res.items || [];
    syncHistoricalJobsToBatches(maintenanceJobs.value);
    if (scanBatches.value.length > 0 && !scanBatches.value.some(b => b.isExpanded)) {
      toggleBatchExpand(scanBatches.value[0]);
    }
  } catch (err: any) {
    console.error('Failed to load maintenance jobs:', err);
  } finally {
    isLoadingJobs.value = false;
  }
}

async function toggleViewJobDetail(job: MaintenanceJobItem) {
  if (expandedJobId.value === job.id) {
    expandedJobId.value = null;
    expandedJobDetail.value = null;
    return;
  }
  expandedJobId.value = job.id;
  isLoadingJobDetail.value = true;
  expandedJobDetail.value = null;
  try {
    const detail = await maintenanceApi.getJobDetail(job.id);
    expandedJobDetail.value = detail;
  } catch (err: any) {
    ElMessage.error(`获取记录详情失败: ${err.message || '网络异常'}`);
    expandedJobId.value = null;
  } finally {
    isLoadingJobDetail.value = false;
  }
}

// ================= 内联确认状态契约（P2：模态转原位/内联，对齐频道监控零弹窗规范 ChannelView:1192-1218） =================
// 两段式确认：首次点击展开确认、二次点击执行（对齐 ChannelView clearingCardsConfirm 模式）
const clearRecordsConfirm = ref(false);
const clearMissingConfirm = ref(false);

// 定位类原位确认：使用业务唯一键（showKey / showKey:season）定位被操作对象，避免列表重排错位
const removeShowConfirmKey = ref<string | null>(null);
const deleteSeasonConfirmKey = ref<string | null>(null);
const deleteShowConfirmKey = ref<string | null>(null);
const removeIgnoreConfirmKey = ref<string | number | null>(null);

// 连载剧强制删除原位剧名校验（discriminated union：整剧 / 分季）
interface OngoingVerifyTarget {
  show: MissingShowGroup;
  showKey: string;
  title: string;
  localCount: number;
  targetLabel: string;
  mode: 'season' | 'entire';
  season?: MissingSeasonResult | null;
}
const ongoingVerifyTarget = ref<OngoingVerifyTarget | null>(null);
const ongoingVerifyInput = ref('');
const ongoingVerifyError = ref(false);

// 内联展开面板开关（替代 el-dialog）
const cleanSettingPanelOpen = ref(false);
const batchDeletePanelOpen = ref(false);
const singleDeletePanelKey = ref<string | null>(null);
const matchTmdbPanelKey = ref<string | null>(null);

// 批量清理总确认（内联面板 footer 原位确认胶囊）
const batchExecuteConfirm = ref(false);

// 熔断保护内联提示（替代 ElMessageBox.alert，呈现于批量清理入口下方）
const batchBreakerNotice = ref('');

async function handleClearAllMaintenanceJobs() {
  if (!clearRecordsConfirm.value) {
    clearRecordsConfirm.value = true;
    return;
  }
  clearRecordsConfirm.value = false;
  try {
    await maintenanceApi.clearJobs();
    clearAllCleanRecords();
    maintenanceJobs.value = [];
    expandedJobId.value = null;
    expandedJobDetail.value = null;
    ElMessage.success('已成功清空全部维护流水记录');
  } catch (e: any) {
    ElMessage.error(`清空流水失败: ${e.message || '未知异常'}`);
  }
}

function loadJobFindingsIntoInspection(jobDetail: MaintenanceJobDetail) {
  if (!jobDetail.findings || jobDetail.findings.length === 0) {
    ElMessage.info('该次巡检快照未包含违规文件记录');
    return;
  }
  bannedScanResult.value = {
    scannedFolders: jobDetail.scannedFolders || 0,
    totalFiles: jobDetail.totalFiles || 0,
    bannedCount: jobDetail.findings.length,
    bannedFiles: jobDetail.findings,
    totalBannedSize: 0,
    totalBannedSizeFormatted: jobDetail.freedFormatted || '',
    durationMs: jobDetail.durationMs,
  };
  selectedBannedIds.value = new Set(jobDetail.findings.map((f) => f.id));
  if (isMissingRoute.value) {
    router.push('/maintenance');
  }
  activeTab.value = 'banned';
  ElMessage.success(`已成功载入 ${jobDetail.findings.length} 项违规快照至待处置区，已为您默认全选！`);
  window.scrollTo({ top: 300, behavior: 'smooth' });
}

function loadMissingJobFindingsIntoInspection(jobDetail: MaintenanceJobDetail) {
  if (!jobDetail.findings || jobDetail.findings.length === 0) {
    ElMessage.info('该次缺更巡检快照未包含缺集记录');
    return;
  }
  const missingItems = jobDetail.findings;
  missingInspectionResult.value = {
    scannedFilesCount: jobDetail.totalFiles || 0,
    scannedShowsCount: jobDetail.scannedFolders || missingItems.length,
    missingShowsCount: jobDetail.bannedCount || missingItems.length,
    completeShowsCount: Math.max(0, (jobDetail.scannedFolders || missingItems.length) - (jobDetail.bannedCount || 0)),
    totalMissingCount: jobDetail.cleanedCount || missingItems.reduce((acc: number, cur: any) => acc + (cur.missingCount || 0), 0),
    durationMs: jobDetail.durationMs,
    items: missingItems as any,
  };
  if (jobDetail.folderPath) {
    missingFolderName.value = (jobDetail.folderPath === '/' || jobDetail.folderPath === '根目录 (/)') ? '' : jobDetail.folderPath;
    missingFolderId.value = jobDetail.folderPath;
  }
  if (!isMissingRoute.value) {
    router.push('/missing');
  }
  activeTab.value = 'missing';
  ElMessage.success(`已成功载入该次巡检快照（共 ${missingItems.length} 个缺更季度），已切换至剧集缺集检测视图！`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadTargetFolders() {
  try {
    const raw = localStorage.getItem(TARGET_FOLDERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.banned) {
        bannedFolderId.value = parsed.banned.id || '/';
        const rawName = parsed.banned.name || '';
        bannedFolderName.value = (rawName === '根目录 (/)' || rawName === '/') ? '' : rawName;
      }
      if (parsed.missing) {
        missingFolderId.value = parsed.missing.id || '/';
        const rawName = parsed.missing.name || '';
        missingFolderName.value = (rawName === '根目录 (/)' || rawName === '/' || rawName === '/媒体库') ? '' : rawName;
      }
    }
  } catch (_) {}
}

function saveTargetFolders() {
  try {
    const data = {
      banned: { id: bannedFolderId.value, name: bannedFolderName.value },
      missing: { id: missingFolderId.value, name: missingFolderName.value },
    };
    localStorage.setItem(TARGET_FOLDERS_KEY, JSON.stringify(data));
  } catch (_) {}
}

function loadCleanPref() {
  try {
    const raw = localStorage.getItem(CLEAN_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.action) cleanAction.value = p.action;
      if (p.quarantinePath && p.quarantinePath !== '/.quarantine') quarantinePath.value = p.quarantinePath;
      if (p.bannedExcludePathsStr && p.bannedExcludePathsStr !== '/.quarantine') bannedExcludePathsStr.value = p.bannedExcludePathsStr;
      if (p.bannedScanScope) bannedScanScope.value = p.bannedScanScope;
      if (Array.isArray(p.customExtensions)) customExtensions.value = p.customExtensions;
      if (p.isAuditHistoryExpanded !== undefined) isAuditHistoryExpanded.value = p.isAuditHistoryExpanded;
      if (p.cascadeCompanion !== undefined) cascadeCompanion.value = p.cascadeCompanion;
      if (p.notifyEmby !== undefined) notifyEmby.value = p.notifyEmby;
      if (p.pruneEmptyParent !== undefined) pruneEmptyParent.value = p.pruneEmptyParent;
    }
  } catch (_) {}
}

function saveCleanPref() {
  try {
    localStorage.setItem(CLEAN_PREF_KEY, JSON.stringify({
      action: cleanAction.value,
      quarantinePath: quarantinePath.value,
      bannedExcludePathsStr: bannedExcludePathsStr.value,
      bannedScanScope: bannedScanScope.value,
      customExtensions: customExtensions.value,
      isAuditHistoryExpanded: isAuditHistoryExpanded.value,
      cascadeCompanion: cascadeCompanion.value,
      notifyEmby: notifyEmby.value,
      pruneEmptyParent: pruneEmptyParent.value,
    }));
  } catch (_) {}
}

function onQuarantinePathChange() {
  saveCleanPref();
}

// 独立的目录选择弹窗触发
function openFolderPickerFor(module: TargetModule) {
  if (!activeAccountId.value) {
    ElMessage.warning('请先选择有效的 139 网盘账号');
    return;
  }
  pickerTargetModule.value = module;
  isFolderPickerVisible.value = true;
}

function onFolderSelected(folder: { id: string; name: string }) {
  const isRoot = folder.id === '-11' || folder.id === '/' || !folder.name || folder.name === '/' || folder.name === '根目录 (/)';
  const normId = isRoot ? '/' : folder.id;
  const rawName = folder.name || '';
  const normName = isRoot ? '' : (rawName.startsWith('/') ? rawName : `/${rawName}`);

  if (pickerTargetModule.value === 'banned') {
    bannedFolderId.value = normId;
    bannedFolderName.value = normName;
  } else if (pickerTargetModule.value === 'missing') {
    missingFolderId.value = normId;
    missingFolderName.value = normName;
  }
  saveTargetFolders();
  ElMessage.success(`已设置目标目录: ${normName || '全盘根目录'}`);
}

function onManualPathChange(module: 'banned' | 'missing') {
  if (module === 'banned') {
    if (!bannedFolderName.value.trim() || bannedFolderName.value.trim() === '/' || bannedFolderName.value.trim() === '根目录 (/)') {
      bannedFolderId.value = '/';
      bannedFolderName.value = '';
    } else {
      bannedFolderId.value = bannedFolderName.value.trim();
    }
  } else if (module === 'missing') {
    if (!missingFolderName.value.trim() || missingFolderName.value.trim() === '/' || missingFolderName.value.trim() === '根目录 (/)') {
      missingFolderId.value = '/';
      missingFolderName.value = '';
    } else {
      missingFolderId.value = missingFolderName.value.trim();
    }
  }
  saveTargetFolders();
  ElMessage.info('已保存手动指定的路径');
}

// 加载账号与基础配置
async function initData() {
  loadCleanRecords();
  loadMaintenanceJobs();
  loadCleanPref();
  loadTombstones();
  loadIgnoreList();
  loadTargetFolders();
  loadMissingPref();
  try {
    const accList = await accountApi.getAccounts();
    accounts.value = (accList || []).filter((a: any) => a.accountType === 'cloud139');
    const activeOne = accounts.value.find((a: any) => a.isActive) || accounts.value[0];
    if (activeOne) {
      activeAccountId.value = activeOne.id;
    }

    const cfg = await settingsApi.getSettings();
    rawFullConfig = JSON.parse(JSON.stringify(cfg || {}));
    if (rawFullConfig.maintenance) {
      scheduleForm.enableBannedScanCron = Boolean(rawFullConfig.maintenance.enableBannedScanCron);
      scheduleForm.bannedScanCron = rawFullConfig.maintenance.bannedScanCron || '0 3 * * 0';
      scheduleForm.autoCleanBanned = Boolean(rawFullConfig.maintenance.autoCleanBanned);
      scheduleForm.enableMissingScanCron = Boolean(rawFullConfig.maintenance.enableMissingScanCron);
      scheduleForm.missingScanCron = rawFullConfig.maintenance.missingScanCron || '0 6 * * *';
      scheduleForm.notifyOnMaintenance = rawFullConfig.maintenance.notifyOnMaintenance !== false;
    }
  } catch (err: any) {
    ElMessage.error(`初始化数据失败: ${err.message || '网络异常'}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 模块 1: 违规死链巡检与清理方法
// ─────────────────────────────────────────────────────────────
async function handleScanBanned() {
  isBannedScanning.value = true;
  bannedScanResult.value = null;
  bannedCleanResult.value = null;
  selectedBannedIds.value.clear();

  try {
    const parsedExcludes = Array.from(new Set(
      (bannedExcludePathsStr.value || '')
        .split(/[,，\n]/)
        .map((p) => p.trim())
        .filter(Boolean)
    ));

    const res = await maintenanceApi.scanBanned({
      accountId: activeAccountId.value,
      rootCatalogId: bannedFolderId.value,
      scope: bannedScanScope.value,
      customExtensions: customExtensions.value,
      excludePaths: parsedExcludes,
      ignoredIds: Array.from(ignoredBannedIds.value),
    });
    bannedScanResult.value = res;
    // 默认全选所有检测到的违规死链
    (res.bannedFiles || []).forEach((f) => {
      if (f.id) selectedBannedIds.value.add(f.id);
    });
    const ignoredTip = res.ignoredCount ? `，白名单已跳过 ${res.ignoredCount} 项` : '';
    const targetTip = res.scannedTargetFiles !== undefined ? ` (检测 ${res.scannedTargetFiles} 项)` : '';
    if (res.bannedCount === 0) {
      ElMessage.success(`巡检完成: 共扫描 ${res.scannedFolders} 个目录、${res.totalFiles} 个文件${targetTip}${ignoredTip}，未发现违规死链。`);
    } else {
      ElMessage.warning(`巡检完成: 发现 ${res.bannedCount} 项违规死链文件${ignoredTip}，共占用 ${res.totalBannedSizeFormatted}。`);
    }
  } catch (err: any) {
    ElMessage.error(`巡检违规文件失败: ${err.message || '执行异常'}`);
  } finally {
    isBannedScanning.value = false;
    loadMaintenanceJobs();
  }
}

function toggleSelectAllBanned() {
  const currentList = filteredBannedFiles.value;
  if (!currentList.length) return;
  const allSelected = currentList.every((f) => selectedBannedIds.value.has(f.id));
  if (allSelected) {
    for (const f of currentList) {
      selectedBannedIds.value.delete(f.id);
    }
  } else {
    for (const f of currentList) {
      selectedBannedIds.value.add(f.id);
    }
  }
}

function toggleSelectBanned(id: string) {
  if (selectedBannedIds.value.has(id)) {
    selectedBannedIds.value.delete(id);
  } else {
    selectedBannedIds.value.add(id);
  }
}

function handleCleanBanned() {
  if (!bannedScanResult.value || selectedBannedIds.value.size === 0) {
    ElMessage.warning('请至少选择一个待处置的违规文件');
    return;
  }
  // 内联展开处置设置面板（替代 el-dialog；处置方式与联动开关为持久偏好，收起不重置）
  cleanSettingPanelOpen.value = !cleanSettingPanelOpen.value;
}

async function executeCleanBanned() {
  saveCleanPref();
  cleanSettingPanelOpen.value = false;
  const targets = bannedScanResult.value?.bannedFiles.filter((f) => selectedBannedIds.value.has(f.id)) || [];
  if (!targets.length) return;

  const cleanStartTime = Date.now();
  isBannedCleaning.value = true;
  try {
    const res = await maintenanceApi.cleanBanned({
      accountId: activeAccountId.value,
      bannedFiles: targets,
      action: cleanAction.value,
      quarantinePath: quarantinePath.value.trim() || '/.quarantine',
      cascadeCompanion: cascadeCompanion.value,
      notifyEmby: notifyEmby.value,
      pruneEmptyParent: pruneEmptyParent.value,
    });
    const cleanDurationMs = Date.now() - cleanStartTime;
    bannedCleanResult.value = res;

    const actionText = res.action === 'quarantine' ? '安全隔离' : '移入回收站';
    ElMessage.success(`处置完成: 成功${actionText} ${res.successCount} 项 (视频 ${res.processedVideos || targets.length} + 伴生 ${res.processedCompanions || 0})，涉及空间 ${res.freedSizeFormatted}`);

    // 记录到本地清理审计历史
    if (res.successCount > 0) {
      addCleanRecord({
        type: 'banned',
        typeName: res.action === 'quarantine' ? `违规隔离 (移动至 ${res.quarantinePath || '默认隔离区'})` : '违规死链清理 (安全移入回收站)',
        folderPath: bannedFolderName.value || '全盘',
        successCount: res.successCount,
        failedCount: res.failedCount,
        freedBytes: res.freedBytes,
        freedFormatted: res.freedSizeFormatted,
        durationMs: cleanDurationMs,
        details: [
          `处置模式: ${actionText}`,
          res.action === 'quarantine' ? `隔离目标: ${res.quarantinePath || '/.quarantine'}` : null,
          `伴生文件级联: ${cascadeCompanion.value ? `已处置 ${res.processedCompanions || 0} 个伴生文件` : '未开启'}`,
          `Emby 刷新状态: ${res.embyResult?.notified ? `已刷新 ${res.embyResult.updatedDirsCount} 个目录` : (res.embyResult?.reason || '跳过')}`,
          res.prunedEmptyDirsCount ? `衍生清理: 已修剪 ${res.prunedEmptyDirsCount} 个空目录` : null,
          ...targets.slice(0, 10).map((f) => `${f.name} (${f.sizeFormatted}) [${f.path || ''}] - ${f.reason}`),
        ].filter(Boolean) as string[],
      });
    }

    // 记录和谐墓碑档案库
    if (res.tombstones && res.tombstones.length > 0) {
      addTombstones(res.tombstones);
    }

    // 从当前扫描列表中移除已清理项
    if (res.successCount > 0 && bannedScanResult.value) {
      const stillPresentSet = new Set((res.stillThere || []).map((x: any) => x.id));
      bannedScanResult.value.bannedFiles = bannedScanResult.value.bannedFiles.filter((f) => stillPresentSet.has(f.id));
      bannedScanResult.value.bannedCount = bannedScanResult.value.bannedFiles.length;
      selectedBannedIds.value.clear();
    }
  } catch (err: any) {
    ElMessage.error(`处置违规文件失败: ${err.message || '执行异常'}`);
  } finally {
    isBannedCleaning.value = false;
    loadMaintenanceJobs();
  }
}

// ─────────────────────────────────────────────────────────────
// 模块 2: 剧集缺集检测与断集巡检方法
// ─────────────────────────────────────────────────────────────
async function checkMissingJobStatus(silent = false) {
  try {
    const status = await maintenanceApi.getMissingScanStatus();
    missingJobStatus.value = status;
    if (status.status === 'running') {
      isMissingScanning.value = true;
      // 实时接收流式结果快照，扫一部展示一部
      if (status.result && (Array.isArray(status.result.items) || Array.isArray(status.result.shows))) {
        missingInspectionResult.value = status.result;
        syncCurrentResultToBatches(status.result, status.targetPath || missingFolderName.value || '/tv');
      }
      if (!missingPollTimer) {
        missingPollTimer = setInterval(() => checkMissingJobStatus(true), 1200);
      }
    } else if (status.status === 'completed') {
      const wasScanning = isMissingScanning.value;
      isMissingScanning.value = false;
      if (missingPollTimer) {
        clearInterval(missingPollTimer);
        missingPollTimer = null;
      }
      if (status.result) {
        missingInspectionResult.value = status.result;
        syncCurrentResultToBatches(status.result, status.targetPath || missingFolderName.value || '/tv');
        if (activeScanBatchId.value) {
          const currentB = scanBatches.value.find(b => b.id === activeScanBatchId.value);
          if (currentB && (status.jobId || (status as any).id)) {
            currentB.jobId = status.jobId || (status as any).id;
          }
          activeScanBatchId.value = null;
        }
        if (wasScanning) {
          loadMaintenanceJobs();
          if (!silent) {
            if (status.result.scannedFilesCount === 0) {
              ElMessage.info('巡检完成: 在指定目录未发现任何视频文件，请核对目录路径。');
            } else if (status.result.missingShowsCount === 0) {
              ElMessage.success(`缺集巡检完成: 共分析 ${status.result.scannedShowsCount} 个剧集季组，全部完整收录无缺失。`);
            } else {
              ElMessage.warning(`缺集巡检完成: 发现 ${status.result.missingShowsCount} 部剧集缺更，累计缺失 ${status.result.totalMissingCount} 集。`);
            }
          }
        }
      }
    } else if (status.status === 'error') {
      activeScanBatchId.value = null;
      if (isMissingScanning.value) {
        ElMessage.error(`缺集巡检异常中断: ${status.error || '未知错误'}`);
        loadMaintenanceJobs();
      }
      isMissingScanning.value = false;
      if (missingPollTimer) {
        clearInterval(missingPollTimer);
        missingPollTimer = null;
      }
    }
  } catch (err: any) {
    if (!silent) {
      console.warn('获取巡检状态失败:', err);
    }
  }
}

async function handleScanMissingEpisodes() {
  const targetPathOrId = (missingFolderName.value && missingFolderName.value.trim()) || missingFolderId.value || '/';
  const newBatchId = `batch-${Date.now()}`;
  activeScanBatchId.value = newBatchId;

  const initBatch: MissingScanBatch = {
    id: newBatchId,
    title: `缺更巡检 · ${targetPathOrId}`,
    folderPath: targetPathOrId,
    timeFormatted: new Date().toLocaleString('zh-CN', { hour12: false }),
    timestamp: Date.now(),
    durationMs: 0,
    totalShows: 0,
    missingShowsCount: 0,
    completeShowsCount: 0,
    unidentifiedShowsCount: 0,
    totalMissingCount: 0,
    totalFiles: 0,
    isExpanded: true,
    tabFilter: 'missing',
    selectedShowKeys: new Set(),
    expandedCompareKeys: new Set(),
    activeSeasonMap: {},
    currentPage: 1,
    pageSize: 15,
  };
  scanBatches.value.unshift(initBatch);

  isMissingScanning.value = true;
  selectedMissingShowKeys.value.clear();
  missingInspectionResult.value = {
    scannedFilesCount: 0,
    scannedShowsCount: 0,
    missingShowsCount: 0,
    completeShowsCount: 0,
    totalMissingCount: 0,
    durationMs: 0,
    items: [],
    shows: [],
  };

  try {
    const job = await maintenanceApi.scanMissingEpisodes({
      accountId: activeAccountId.value,
      rootCatalogId: targetPathOrId,
      excludeUnreleased: missingOptions.excludeUnreleased,
      ignoreSeasonZero: missingOptions.ignoreSeasonZero,
      onlyEnded: missingOptions.onlyEnded,
    });
    missingJobStatus.value = job;
    if (job.status === 'completed' && job.result) {
      missingInspectionResult.value = job.result;
      isMissingScanning.value = false;
      return;
    }
    // 立即启动快速状态轮询器 (1.2s 间隔，即时流式呈现)
    if (missingPollTimer) clearInterval(missingPollTimer);
    missingPollTimer = setInterval(() => checkMissingJobStatus(true), 1200);
  } catch (err: any) {
    ElMessage.error(`启动缺集巡检失败: ${err.message || '网络异常'}`);
    isMissingScanning.value = false;
  }
}

function extractSearchKeyword(folderPath: string, currentTitle: string) {
  const base = folderPath ? folderPath.split('/').filter(Boolean).pop() || '' : '';
  const text = base || currentTitle || '';
  const yearMatch = text.match(/(?:19|20)\d{2}/);
  const year = yearMatch ? yearMatch[0] : '';
  let clean = text
    .replace(/(?:19|20)\d{2}/g, '')
    .replace(/[()\[\]（）{}【】]/g, ' ')
    .replace(/\{tmdb-\d+\}/ig, '')
    .replace(/\[tmdbid-\d+\]/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    query: clean || currentTitle || '',
    year: year || '',
  };
}

// 收起 TMDB 修正面板：重置检索词、候选列表与手动 ID 输入临时状态（对齐 el-dialog destroy-on-close 语义）
function closeMatchTmdbPanel() {
  matchTmdbPanelKey.value = null;
  matchTmdbCandidates.value = [];
  matchTmdbSearching.value = false;
  matchTmdbForm.searchQuery = '';
  matchTmdbForm.searchYear = '';
  matchTmdbForm.selectedTmdbId = '';
}

async function openMatchTmdbModal(showOrItem: any, targetSeason?: any) {  // 兼顾传入 MissingShowGroup 或 MissingSeasonResult
  const isShow = Boolean(showOrItem?.seasons);
  const show: MissingShowGroup = isShow ? showOrItem : {
    showKey: showOrItem.groupKey,
    title: showOrItem.title,
    folderPath: showOrItem.folderPath,
    folderId: showOrItem.folderId,
    tmdbId: showOrItem.tmdbId,
    totalMissingCount: showOrItem.missingCount,
    totalLocalCount: showOrItem.localCount,
    totalTmdbCount: showOrItem.tmdbCount,
    hasMissing: showOrItem.missingCount > 0,
    seasons: [showOrItem],
  };

  const activeS = targetSeason || (isShow ? getActiveSeason(show) : showOrItem);
  const kw = extractSearchKeyword(show.folderPath, show.title);

  matchTmdbForm.folderPath = show.folderPath;
  matchTmdbForm.folderId = show.folderId || '';
  matchTmdbForm.showTitle = show.title;
  matchTmdbForm.seasonsCount = show.seasons?.length || 1;
  matchTmdbForm.activeSeason = activeS?.season || 1;
  matchTmdbForm.currentTmdbId = String(show.tmdbId || activeS?.tmdbId || '');
  matchTmdbForm.searchQuery = kw.query;
  matchTmdbForm.searchYear = kw.year;
  matchTmdbForm.searchMediaType = 'tv';
  matchTmdbForm.selectedTmdbId = matchTmdbForm.currentTmdbId;
  matchTmdbForm.applyToAllSeasons = true;
  matchTmdbCandidates.value = [];
  matchTmdbPanelKey.value = show.showKey;

  // 自动触发一次搜剧，省去用户繁琐的手动输入与外站翻找
  if (matchTmdbForm.searchQuery.trim()) {
    await handleSearchTmdb();
  }
}

async function handleSearchTmdb() {
  if (!matchTmdbForm.searchQuery.trim()) {
    ElMessage.warning('请输入搜索剧名关键词');
    return;
  }
  matchTmdbSearching.value = true;
  try {
    const list = await maintenanceApi.searchTmdbCandidates({
      title: matchTmdbForm.searchQuery.trim(),
      year: matchTmdbForm.searchYear.trim() || undefined,
      mediaType: matchTmdbForm.searchMediaType,
    });
    matchTmdbCandidates.value = Array.isArray(list) ? list : [];
    if (matchTmdbCandidates.value.length === 0) {
      ElMessage.info('未检索到匹配结果，可尝试精简剧名或剥离年份重搜');
    }
  } catch (err: any) {
    ElMessage.error(`TMDB 搜索失败: ${err.message || '网络异常'}`);
    matchTmdbCandidates.value = [];
  } finally {
    matchTmdbSearching.value = false;
  }
}

async function handleSelectCandidate(candidate: any) {
  if (!candidate || !candidate.id) return;
  matchTmdbForm.selectedTmdbId = String(candidate.id);
  await handleSaveMatchTmdb(candidate.title || candidate.name);
}

function normalizeFolderPath(p?: string) {
  if (!p || typeof p !== 'string') return '';
  let clean = p.replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();
  clean = clean.replace(/(?:\/(?:season\s*\d+|s\d+|第\s*\d+\s*季|sp))$/i, '');
  return clean;
}

function applyUpdatedShowToResult(updatedShow: MissingShowGroup) {
  if (!missingInspectionResult.value || !updatedShow) return;
  if (!Array.isArray(missingInspectionResult.value.shows)) {
    missingInspectionResult.value.shows = [];
  }
  const normTarget = normalizeFolderPath(updatedShow.folderPath);

  // 1. 彻底过滤掉匹配该目录或相同 showKey 的旧剧集（防止《宇宙兄弟》等旧条目残留）
  missingInspectionResult.value.shows = missingInspectionResult.value.shows.filter(s => {
    const sNorm = normalizeFolderPath(s.folderPath);
    const isSame = (normTarget && sNorm === normTarget) ||
                   (updatedShow.folderId && s.folderId && s.folderId === updatedShow.folderId) ||
                   s.showKey === updatedShow.showKey;
    return !isSame;
  });

  // 2. 插入新剧集实体
  missingInspectionResult.value.shows.unshift(updatedShow);

  // 3. 过滤并同步 items 列表
  if (Array.isArray(missingInspectionResult.value.items)) {
    missingInspectionResult.value.items = missingInspectionResult.value.items.filter(i => {
      const iNorm = normalizeFolderPath(i.folderPath);
      const isSame = (normTarget && iNorm === normTarget) ||
                     (updatedShow.folderId && i.folderId && i.folderId === updatedShow.folderId);
      return !isSame;
    });
    if (Array.isArray(updatedShow.seasons)) {
      missingInspectionResult.value.items.push(...updatedShow.seasons);
    }
  }

  // 4. 同步更新各项统计指标
  const missingShows = missingInspectionResult.value.shows.filter(s => s.hasMissing || s.totalMissingCount > 0);
  const completeShows = missingInspectionResult.value.shows.filter(s => !s.hasMissing && s.totalMissingCount === 0);
  missingInspectionResult.value.scannedShowsCount = missingInspectionResult.value.shows.length;
  missingInspectionResult.value.missingShowsCount = missingShows.length;
  missingInspectionResult.value.completeShowsCount = completeShows.length;
  missingInspectionResult.value.totalMissingCount = missingInspectionResult.value.shows.reduce((acc, s) => acc + (s.isUnidentified ? 0 : s.totalMissingCount), 0);

  // 同步热更新所有巡检批次中的该剧集
  scanBatches.value.forEach(b => {
    if (b.result && Array.isArray(b.result.shows)) {
      const exists = b.result.shows.some(s => {
        const sNorm = normalizeFolderPath(s.folderPath);
        return (normTarget && sNorm === normTarget) || (updatedShow.folderId && s.folderId && s.folderId === updatedShow.folderId) || s.showKey === updatedShow.showKey;
      });
      if (exists) {
        b.result.shows = b.result.shows.filter(s => {
          const sNorm = normalizeFolderPath(s.folderPath);
          return !((normTarget && sNorm === normTarget) || (updatedShow.folderId && s.folderId && s.folderId === updatedShow.folderId) || s.showKey === updatedShow.showKey);
        });
        b.result.shows.unshift(updatedShow);
        const unident = b.result.shows.filter(s => s.isUnidentified || !s.tmdbId);
        const ident = b.result.shows.filter(s => !s.isUnidentified && s.tmdbId);
        b.unidentifiedShowsCount = unident.length;
        b.missingShowsCount = ident.filter(s => s.hasMissing || s.totalMissingCount > 0).length;
        b.completeShowsCount = ident.filter(s => !s.hasMissing && s.totalMissingCount === 0).length;
        b.totalShows = b.result.shows.length;
        b.totalMissingCount = ident.reduce((acc, s) => acc + s.totalMissingCount, 0);
      }
    }
  });
}

function refreshShowsFromItems() {
  if (!missingInspectionResult.value?.items) return;
  const map = new Map<string, MissingShowGroup>();
  for (const item of missingInspectionResult.value.items) {
    let seriesFolder = (item.folderPath || '').replace(/\\/g, '/');
    if (/(?:[\\/](?:Season\s*\d+|S\d+|第\s*\d+\s*季|SP))$/i.test(seriesFolder)) {
      seriesFolder = seriesFolder.replace(/(?:[\\/](?:Season\s*\d+|S\d+|第\s*\d+\s*季|SP))$/i, '');
    }
    const showKey = seriesFolder ? `dir:${seriesFolder}` : (item.tmdbId ? `tmdb:${item.tmdbId}` : `title:${(item.title || '').trim().toLowerCase()}`);
    if (!map.has(showKey)) {
      map.set(showKey, {
        showKey,
        title: item.title,
        folderPath: seriesFolder || item.folderPath,
        tmdbId: item.tmdbId,
        posterPath: item.posterPath,
        airStatus: item.airStatus,
        firstAirYear: item.firstAirYear,
        totalMissingCount: 0,
        totalLocalCount: 0,
        totalTmdbCount: 0,
        hasMissing: false,
        seasons: [],
      });
    }
    const group = map.get(showKey)!;
    group.totalMissingCount += item.missingCount;
    group.totalLocalCount += item.localCount;
    group.totalTmdbCount += (item.tmdbCount || (item.localCount + item.missingCount) || 0);
    if (item.missingCount > 0) group.hasMissing = true;
    group.seasons.push(item);
  }
  missingInspectionResult.value.shows = Array.from(map.values());
  const missingShows = missingInspectionResult.value.shows.filter(s => s.hasMissing || s.totalMissingCount > 0);
  const completeShows = missingInspectionResult.value.shows.filter(s => !s.hasMissing && s.totalMissingCount === 0);
  missingInspectionResult.value.scannedShowsCount = missingInspectionResult.value.shows.length;
  missingInspectionResult.value.missingShowsCount = missingShows.length;
  missingInspectionResult.value.completeShowsCount = completeShows.length;
  missingInspectionResult.value.totalMissingCount = missingInspectionResult.value.shows.reduce((acc, s) => acc + s.totalMissingCount, 0);
}

async function handleSaveMatchTmdb(customTargetTitle?: string) {
  const tmdbId = String(matchTmdbForm.selectedTmdbId || '').trim();
  if (!tmdbId || !/^\d+$/.test(tmdbId)) {
    ElMessage.warning('请输入或选用有效的 TMDB 纯数字 ID');
    return;
  }
  matchTmdbLoading.value = true;
  try {
    const res = await maintenanceApi.matchTmdb({
      accountId: activeAccountId.value,
      folderPath: matchTmdbForm.folderPath,
      folderId: matchTmdbForm.folderId,
      tmdbId: tmdbId,
      season: matchTmdbForm.activeSeason,
      applyToAllSeasons: matchTmdbForm.applyToAllSeasons,
      excludeUnreleased: missingOptions.excludeUnreleased,
      ignoreSeasonZero: missingOptions.ignoreSeasonZero,
      onlyEnded: missingOptions.onlyEnded,
    });

    if (matchTmdbForm.applyToAllSeasons) {
      if (res) {
        applyUpdatedShowToResult(res);
      }
    } else {
      if (res && missingInspectionResult.value?.items) {
        const idx = missingInspectionResult.value.items.findIndex(
          (i) => i.folderPath === matchTmdbForm.folderPath && Number(i.season) === Number(matchTmdbForm.activeSeason)
        );
        if (idx !== -1) {
          missingInspectionResult.value.items[idx] = res;
        } else {
          missingInspectionResult.value.items.unshift(res);
        }
        refreshShowsFromItems();
      }
    }

    const titleMsg = customTargetTitle ? `《${customTargetTitle}》` : '';
    ElMessage.success(`已成功将《${matchTmdbForm.showTitle}》校准为 TMDB: ${tmdbId} ${titleMsg}，缺集已重新比对！`);
    closeMatchTmdbPanel();
  } catch (err: any) {
    ElMessage.error(`TMDB 修正匹配失败: ${err.message || '网络异常'}`);
  } finally {
    matchTmdbLoading.value = false;
  }
}

// 原位确认胶囊驱动：首次点击展开确认、二次点击执行（等价原 ElMessageBox Promise 语义）
async function handleRemoveShow(show: MissingShowGroup) {
  if (!show) return;
  if (removeShowConfirmKey.value !== show.showKey) {
    removeShowConfirmKey.value = show.showKey;
    return;
  }
  removeShowConfirmKey.value = null;
  await executeRemoveShow(show);
}

async function executeRemoveShow(show: MissingShowGroup) {
  try {
    const res = await maintenanceApi.removeShow({
      showKey: show.showKey,
      folderPath: show.folderPath,
      tmdbId: show.tmdbId || undefined,
    });

    if (res?.result) {
      missingInspectionResult.value = res.result;
    }
    const normTargetRemove = normalizeFolderPath(show.folderPath);
    scanBatches.value.forEach(b => {
      if (b.result && Array.isArray(b.result.shows)) {
        b.result.shows = b.result.shows.filter(
          s => s.showKey !== show.showKey && normalizeFolderPath(s.folderPath) !== normTargetRemove
        );
        const unident = b.result.shows.filter(s => s.isUnidentified || !s.tmdbId);
        const ident = b.result.shows.filter(s => !s.isUnidentified && s.tmdbId);
        b.unidentifiedShowsCount = unident.length;
        b.missingShowsCount = ident.filter(s => s.hasMissing || s.totalMissingCount > 0).length;
        b.completeShowsCount = ident.filter(s => !s.hasMissing && s.totalMissingCount === 0).length;
        b.totalShows = b.result.shows.length;
        b.totalMissingCount = ident.reduce((acc, s) => acc + s.totalMissingCount, 0);
      }
    });
    if (!res?.result) {
      // 本地兜底即时移除
      const normTarget = normalizeFolderPath(show.folderPath);
      if (Array.isArray(missingInspectionResult.value?.shows)) {
        missingInspectionResult.value.shows = missingInspectionResult.value.shows.filter(
          s => s.showKey !== show.showKey && normalizeFolderPath(s.folderPath) !== normTarget
        );
      }
      if (Array.isArray(missingInspectionResult.value?.items)) {
        missingInspectionResult.value.items = missingInspectionResult.value.items.filter(
          i => normalizeFolderPath(i.folderPath) !== normTarget && i.groupKey !== show.showKey
        );
      }
      refreshShowsFromItems();
    }

    ElMessage.success(`已从巡检结果列表中移除《${show.title}》`);
  } catch (err: any) {
    ElMessage.error(`移除剧集失败: ${err.message || '网络异常'}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 缺集文件夹 / 缺集季删除能力 (移入 139 回收站)
// ─────────────────────────────────────────────────────────────
const batchDeleteMode = ref<'season' | 'entire'>('season');
const batchDeleteSelectedKeys = ref<Set<string>>(new Set());
const isBatchDeleting = ref(false);

const singleDeleteTargetShow = ref<MissingShowGroup | null>(null);
const singleDeleteMode = ref<'season' | 'entire'>('season');
const isSingleDeleting = ref(false);

interface BatchDeleteCandidate {
  key: string;
  showTitle: string;
  seasonLabel?: string;
  missingCount: number;
  missingRangesStr: string;
  folderPath: string;
  folderId?: string;
  season?: number;
  deleteEntireShow: boolean;
  showKey: string;
  tmdbId?: string | number | null;
}

const batchCandidates = computed<BatchDeleteCandidate[]>(() => {
  const result: BatchDeleteCandidate[] = [];
  let baseShows: MissingShowGroup[] = [];
  if (activeDeleteBatch.value) {
    baseShows = getBatchMissingShows(activeDeleteBatch.value);
  } else {
    baseShows = missingOnlyShows.value;
  }
  // 核心安全熔断保护：批量清理彻底排除连载中剧集，仅允许清理已确认完结的残缺剧集
  let shows = baseShows.filter(show => !isShowOngoing(show));

  // 若用户在表格中勾选了指定剧集，则优先针对用户所选剧集生成清理目标
  if (selectedMissingShowKeys.value.size > 0) {
    shows = shows.filter(show => selectedMissingShowKeys.value.has(show.showKey));
  }

  if (batchDeleteMode.value === 'season') {
    for (const show of shows) {
      for (const s of getVisibleSeasons(show)) {
        // 分季维度也双重拦截：严禁包含任何连载中分季
        if (s.missingCount > 0 && !isSeasonOngoing(s)) {
          result.push({
            key: `${show.showKey}:S${s.season}`,
            showTitle: show.title,
            seasonLabel: s.seasonLabel,
            missingCount: s.missingCount,
            missingRangesStr: s.missingRangesStr,
            folderPath: show.folderPath,
            folderId: show.folderId,
            season: s.season,
            deleteEntireShow: false,
            showKey: show.showKey,
            tmdbId: show.tmdbId,
          });
        }
      }
    }
  } else {
    for (const show of shows) {
      result.push({
        key: show.showKey,
        showTitle: show.title,
        seasonLabel: `全剧 (${getVisibleSeasons(show).length} 季)`,
        missingCount: show.totalMissingCount,
        missingRangesStr: `${show.totalMissingCount} 集缺失`,
        folderPath: show.folderPath,
        folderId: show.folderId,
        deleteEntireShow: true,
        showKey: show.showKey,
        tmdbId: show.tmdbId,
      });
    }
  }
  return result;
});

function openBatchDeleteModal() {
  if (missingOnlyShows.value.length === 0) {
    ElMessage.info('当前没有检测到缺集的剧集');
    return;
  }
  if (batchCandidates.value.length === 0) {
    // 熔断提示转内联提示卡（呈现于批量清理入口下方，文案原文保留）
    batchBreakerNotice.value =
      '当前检测到的缺集剧集均为【连载中】剧集，当前缺更属于正常追更等待状态。🛡️ 安全熔断保护已生效：系统已自动彻底排除全部连载中剧集，防止追更文件被误删！';
    batchDeletePanelOpen.value = false;
    return;
  }
  batchBreakerNotice.value = '';
  batchExecuteConfirm.value = false;
  batchDeleteMode.value = 'season';
  batchDeleteSelectedKeys.value = new Set(batchCandidates.value.map(c => c.key));
  batchDeletePanelOpen.value = true;
}

// 收起批量清理面板：重置勾选与总确认临时状态（对齐 el-dialog 收起语义）
function closeBatchDeletePanel() {
  batchDeletePanelOpen.value = false;
  batchExecuteConfirm.value = false;
  batchDeleteSelectedKeys.value = new Set();
}

function handleBatchModeChange(mode: 'season' | 'entire') {
  batchDeleteMode.value = mode;
  batchDeleteSelectedKeys.value = new Set(batchCandidates.value.map(c => c.key));
}

function toggleSelectAllBatch() {
  if (batchDeleteSelectedKeys.value.size === batchCandidates.value.length) {
    batchDeleteSelectedKeys.value.clear();
  } else {
    batchDeleteSelectedKeys.value = new Set(batchCandidates.value.map(c => c.key));
  }
}

async function executeDeleteTargets(
  targets: Array<{
    folderPath: string;
    folderId?: string;
    season?: number;
    deleteEntireShow?: boolean;
    showKey?: string;
    tmdbId?: string | number | null;
    title?: string;
  }>,
  successMsgPrefix = '删除'
) {
  const res = await maintenanceApi.deleteMissingTargets({
    accountId: activeAccountId.value || undefined,
    targets,
  });

  if (res?.result) {
    missingInspectionResult.value = res.result;
  }
  for (const t of targets) {
    const normTarget = normalizeFolderPath(t.folderPath);
    scanBatches.value.forEach(b => {
      if (b.result && Array.isArray(b.result.shows)) {
        if (t.deleteEntireShow || t.season === undefined) {
          b.result.shows = b.result.shows.filter(
            s => s.showKey !== t.showKey && normalizeFolderPath(s.folderPath) !== normTarget
          );
        } else {
          const show = b.result.shows.find(s => s.showKey === t.showKey || normalizeFolderPath(s.folderPath) === normTarget);
          if (show && Array.isArray(show.seasons)) {
            show.seasons = show.seasons.filter(s => Number(s.season) !== Number(t.season));
            show.totalMissingCount = show.seasons.reduce((acc, s) => acc + (s.missingCount || 0), 0);
            show.totalLocalCount = show.seasons.reduce((acc, s) => acc + (s.localCount || 0), 0);
            show.hasMissing = show.seasons.some(s => s.missingCount > 0);
          }
        }
        const unident = b.result.shows.filter(s => s.isUnidentified || !s.tmdbId);
        const ident = b.result.shows.filter(s => !s.isUnidentified && s.tmdbId);
        b.unidentifiedShowsCount = unident.length;
        b.missingShowsCount = ident.filter(s => s.hasMissing || s.totalMissingCount > 0).length;
        b.completeShowsCount = ident.filter(s => !s.hasMissing && s.totalMissingCount === 0).length;
        b.totalShows = b.result.shows.length;
        b.totalMissingCount = ident.reduce((acc, s) => acc + s.totalMissingCount, 0);
      }
    });
  }
  activeDeleteBatch.value = null;
  if (!res?.result) {
    for (const t of targets) {
      if (t.deleteEntireShow || t.season === undefined) {
        if (Array.isArray(missingInspectionResult.value?.shows)) {
          missingInspectionResult.value.shows = missingInspectionResult.value.shows.filter(
            s => s.showKey !== t.showKey && s.folderPath !== t.folderPath
          );
        }
        if (Array.isArray(missingInspectionResult.value?.items)) {
          const normTarget = (t.folderPath || '').replace(/[\/\\]+$/, '');
          missingInspectionResult.value.items = missingInspectionResult.value.items.filter(
            i => (i.folderPath || '').replace(/[\/\\]+$/, '') !== normTarget && i.groupKey !== t.showKey
          );
        }
      } else {
        if (Array.isArray(missingInspectionResult.value?.items)) {
          missingInspectionResult.value.items = missingInspectionResult.value.items.filter(
            i => !(i.folderPath === t.folderPath && Number(i.season) === Number(t.season))
          );
        }
      }
    }
    refreshShowsFromItems();
  }

  ElMessage.success(res?.message || `${successMsgPrefix}成功，已移入 139 回收站`);
}

// 内联面板总确认：首次点击展开原位确认胶囊、二次点击执行（等价原 ElMessageBox 二段确认语义）
async function confirmBatchDelete() {
  const selectedTargets = batchCandidates.value.filter(c => batchDeleteSelectedKeys.value.has(c.key));
  if (selectedTargets.length === 0) {
    ElMessage.warning('请至少勾选一项要清理的缺集目标');
    return;
  }
  if (!batchExecuteConfirm.value) {
    batchExecuteConfirm.value = true;
    return;
  }
  batchExecuteConfirm.value = false;

  try {
    isBatchDeleting.value = true;
    await executeDeleteTargets(
      selectedTargets.map(t => ({
        folderPath: t.folderPath,
        folderId: t.folderId,
        season: t.season,
        deleteEntireShow: t.deleteEntireShow,
        showKey: t.showKey,
        tmdbId: t.tmdbId,
        title: t.showTitle,
      })),
      '一键清理'
    );
    selectedMissingShowKeys.value.clear();
    activeDeleteBatch.value = null;
    closeBatchDeletePanel();
  } catch (err: any) {
    ElMessage.error(`批量删除失败: ${err.message || '网络异常'}`);
  } finally {
    isBatchDeleting.value = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 连载剧强制删除：原位剧名校验区块（替代 ElMessageBox.prompt，spec 5.2.1.3）
// 展开时携带 pendingVerifyTarget，提交执行 trim 全等校验（逐字符复刻原 inputValidator）
// ─────────────────────────────────────────────────────────────
function requestOngoingVerify(show: MissingShowGroup, mode: 'season' | 'entire', season?: MissingSeasonResult | null) {
  const isOngoing = isShowOngoing(show) || (season ? isSeasonOngoing(season) : false);
  if (!isOngoing) return false;
  const localCount = season ? season.localCount : show.totalLocalCount;
  const targetLabel = season ? `《${show.title}》${season.seasonLabel}` : `《${show.title}》`;
  ongoingVerifyTarget.value = {
    show,
    showKey: show.showKey,
    title: show.title,
    localCount,
    targetLabel,
    mode,
    season: season ?? null,
  };
  ongoingVerifyInput.value = '';
  ongoingVerifyError.value = false;
  return true;
}

function cancelOngoingVerify() {
  ongoingVerifyTarget.value = null;
  ongoingVerifyInput.value = '';
  ongoingVerifyError.value = false;
}

// 原位提交：trim 全等校验，通过才放行删除（错误提示文案与原 prompt validator 一致）
function submitOngoingVerify() {
  const t = ongoingVerifyTarget.value;
  if (!t) return;
  const input = ongoingVerifyInput.value;
  if (!input || input.trim() !== t.title.trim()) {
    ongoingVerifyError.value = true;
    return;
  }
  cancelOngoingVerify();
  // 校验通过，续接原删除流程（单季→原位确认；多季→原位展开面板）
  openSingleDeleteFlow(t.show);
}

// 删除入口统一分流（替代 handlePromptDeleteShow 的模态校验链）
function handlePromptDeleteShow(show: MissingShowGroup) {
  if (!show) return;
  if (requestOngoingVerify(show, 'entire')) return;
  openSingleDeleteFlow(show);
}

function openSingleDeleteFlow(show: MissingShowGroup) {
  const visibleSeasons = getVisibleSeasons(show);
  if (visibleSeasons.length <= 1) {
    // 单季剧：原位确认胶囊（等价原 handleDeleteEntireShow 的 confirm 模态）
    if (deleteShowConfirmKey.value === show.showKey) {
      deleteShowConfirmKey.value = null;
      void executeDeleteEntireShow(show);
    } else {
      deleteShowConfirmKey.value = show.showKey;
    }
    return;
  }
  // 多季剧：原位展开删除范围选择面板（替代 el-dialog）
  singleDeleteTargetShow.value = show;
  singleDeleteMode.value = 'season';
  singleDeletePanelKey.value = show.showKey;
}

// 收起单剧删除面板：重置季选择临时状态（对齐 el-dialog 收起语义）
function closeSingleDeletePanel() {
  singleDeletePanelKey.value = null;
  singleDeleteTargetShow.value = null;
  singleDeleteMode.value = 'season';
}

async function confirmSingleDelete() {
  const show = singleDeleteTargetShow.value;
  if (!show) return;
  const activeSeason = getActiveSeason(show);

  try {
    isSingleDeleting.value = true;
    if (singleDeleteMode.value === 'season') {
      await executeDeleteTargets([
        {
          folderPath: show.folderPath,
          folderId: show.folderId,
          season: activeSeason.season,
          deleteEntireShow: false,
          showKey: show.showKey,
          tmdbId: show.tmdbId,
          title: show.title,
        },
      ]);
    } else {
      await executeDeleteTargets([
        {
          folderPath: show.folderPath,
          folderId: show.folderId,
          deleteEntireShow: true,
          showKey: show.showKey,
          tmdbId: show.tmdbId,
          title: show.title,
        },
      ]);
    }
    closeSingleDeletePanel();
  } catch (err: any) {
    ElMessage.error(`删除失败: ${err.message || '网络异常'}`);
  } finally {
    isSingleDeleting.value = false;
  }
}

// 删除缺集季（原位确认胶囊，等价原 confirm 模态链）
async function handleDeleteSeason(show: MissingShowGroup, season: MissingSeasonResult) {
  if (!show || !season) return;
  if (requestOngoingVerify(show, 'season', season)) return;
  const key = `${show.showKey}:S${season.season}`;
  if (deleteSeasonConfirmKey.value === key) {
    deleteSeasonConfirmKey.value = null;
    try {
      await executeDeleteTargets([
        {
          folderPath: show.folderPath,
          folderId: show.folderId,
          season: season.season,
          deleteEntireShow: false,
          showKey: show.showKey,
          tmdbId: show.tmdbId,
          title: show.title,
        },
      ]);
    } catch (err: any) {
      ElMessage.error(`删除季失败: ${err.message || '网络异常'}`);
    }
  } else {
    deleteSeasonConfirmKey.value = key;
  }
}

// 删除整剧（原位确认胶囊，等价原 confirm 模态链）
async function handleDeleteEntireShow(show: MissingShowGroup, alreadyVerified = false) {
  if (!show) return;
  if (!alreadyVerified && requestOngoingVerify(show, 'entire')) return;
  if (deleteShowConfirmKey.value === show.showKey) {
    deleteShowConfirmKey.value = null;
    await executeDeleteEntireShow(show);
  } else {
    deleteShowConfirmKey.value = show.showKey;
  }
}

async function executeDeleteEntireShow(show: MissingShowGroup) {
  try {
    await executeDeleteTargets([
      {
        folderPath: show.folderPath,
        folderId: show.folderId,
        deleteEntireShow: true,
        showKey: show.showKey,
        tmdbId: show.tmdbId,
        title: show.title,
      },
    ]);
  } catch (err: any) {
    ElMessage.error(`删除整剧失败: ${err.message || '网络异常'}`);
  }
}

function getShowMissingSeasons(show: MissingShowGroup): MissingSeasonResult[] {
  if (!show || !show.seasons) return [];
  return getVisibleSeasons(show).filter((s) => s.missingCount > 0);
}

async function copyShowDetailedReport(show: MissingShowGroup) {
  if (!show) return;
  const visibleSeasons = getVisibleSeasons(show);
  const missingSeasons = visibleSeasons.filter((s) => s.missingCount > 0);

  const lines: string[] = [];
  lines.push(`【剧集缺集巡检与源文件比对报告】《${show.title}》`);
  lines.push(`📁 网盘目录: ${show.folderPath}`);
  lines.push(`📊 收录总览: 本地已收录 ${show.totalLocalCount} 集 / 官方共 ${show.totalTmdbCount || (show.totalLocalCount + show.totalMissingCount)} 集 | 累计缺失 ${show.totalMissingCount} 集 (共 ${visibleSeasons.length} 季)`);
  lines.push('');

  // 1. 缺失分集一览 (一目了然看清缺哪几集)
  if (missingSeasons.length > 0) {
    lines.push(`❌ 缺集分布清单 (共 ${missingSeasons.length} 季存在缺更):`);
    for (const s of missingSeasons) {
      lines.push(`  • ${s.seasonLabel}: 缺失 ${s.missingCount} 集 [${s.missingRangesStr}]`);
      if (s.detailedList && s.detailedList.length) {
        for (const d of s.detailedList) {
          lines.push(`    ${d}`);
        }
      } else if (s.missingEpisodes && s.missingEpisodes.length) {
        for (const ep of s.missingEpisodes) {
          lines.push(`    - ${ep.tag || `E${ep.episode}`}: ${ep.name || `第 ${ep.episode} 集`} (${ep.airDate || '官方已播'})`);
        }
      }
    }
  } else {
    lines.push('✔️ 状态良好: 全剧所有季度均已收全，无缺失分集。');
  }
  lines.push('');

  // 2. 源文件名与分集识别对照 (核对源文件与识别结果是否一致正确)
  lines.push('📄 网盘真实源文件与识别对照 (用于核对识别准确性):');
  for (const s of visibleSeasons) {
    const localFiles = s.localFiles || [];
    const unmatched = getUnmatchedFiles(s);
    lines.push(`[${s.seasonLabel}] (本地 ${s.localCount} 集 / 官方 ${s.tmdbCount || (s.localCount + s.missingCount)} 集):`);

    if (localFiles.length === 0) {
      lines.push('  (网盘此季目录下暂无有效视频文件)');
    } else {
      for (const f of localFiles) {
        if (f.parsedEpisode) {
          lines.push(`  ✓ E${String(f.parsedEpisode).padStart(2, '0')} | 源文件: ${f.name} -> 识别匹配: 第 ${f.parsedEpisode} 集 [一致正确]`);
        } else {
          lines.push(`  ⚠️ 存疑 | 源文件: ${f.name} -> 未能匹配集号 [待核对]`);
        }
      }
    }

    if (unmatched.length > 0) {
      lines.push(`  ⚠️ 存疑/未识别文件 (${unmatched.length} 个):`);
      for (const uf of unmatched) {
        lines.push(`    - ${uf.name} (${uf.sizeFormatted || ''})`);
      }
    }
    lines.push('');
  }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已复制《${show.title}》全剧各季缺集与源文件比对清单！`);
  } catch {
    ElMessage.info('复制失败，请手动选取文本');
  }
}

async function copyMissingEpisodes(item: MissingSeasonResult) {
  if (!item) return;
  const lines = [
    `【${item.title} ${item.seasonLabel}】缺失分集清单 (共 ${item.missingCount} 集):`,
    ...(item.detailedList && item.detailedList.length
      ? item.detailedList
      : (item.missingEpisodes || []).map((ep) => `• ${ep.tag}: ${ep.name || '第 ' + ep.episode + ' 集'} (${ep.airDate || '待定'})`)),
  ];
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已复制《${item.title}》缺失分集清单`);
  } catch {
    ElMessage.info('复制失败，请手动选取文本');
  }
}

async function copyAllMissing() {
  if (!missingInspectionResult.value || !missingInspectionResult.value.items.length) return;
  const missingItems = missingInspectionResult.value.items.filter((i) => i.missingCount > 0);
  if (!missingItems.length) {
    ElMessage.info('当前没有缺集的剧集');
    return;
  }
  const chunks: string[] = [
    `【全盘剧集缺集巡检总报告】(共 ${missingOnlyShows.value.length} 部剧集存在缺更，累计缺失 ${effectiveTotalMissingCount.value} 集)\n`,
  ];
  missingOnlyShows.value.forEach((show, idx) => {
    chunks.push(`${idx + 1}. 《${show.title}》 (网盘: ${show.folderPath}) - 累计缺 ${show.totalMissingCount} 集`);
    const mSeasons = getShowMissingSeasons(show);
    mSeasons.forEach((s) => {
      chunks.push(`   • ${s.seasonLabel}: 缺 ${s.missingCount} 集 [${s.missingRangesStr}]`);
      if (s.detailedList && s.detailedList.length) {
        chunks.push('     ' + s.detailedList.join('\n     '));
      }
    });
    // 增加源文件核对提示
    const allUnmatched = getVisibleSeasons(show).flatMap((s) => getUnmatchedFiles(s));
    if (allUnmatched.length > 0) {
      chunks.push(`   ⚠️ 该剧存在 ${allUnmatched.length} 个未匹配集号的源文件:`);
      allUnmatched.forEach((uf) => {
        chunks.push(`     - ${uf.name}`);
      });
    }
    chunks.push('');
  });
  const text = chunks.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已复制全盘 ${missingOnlyShows.value.length} 部缺失剧集及源文件对照清单！`);
  } catch {
    ElMessage.info('复制失败，请手动选取');
  }
}

// 两段式原位确认（对齐 ChannelView clearingCardsConfirm 模式；供清空巡检结果入口挂载）
async function handleClearMissingResults() {
  if (!clearMissingConfirm.value) {
    clearMissingConfirm.value = true;
    return;
  }
  clearMissingConfirm.value = false;

  try {
    await maintenanceApi.clearMissingScanResults();
    missingInspectionResult.value = null;
    missingJobStatus.value = null;
    scanBatches.value = [];
    expandedShowKeys.value.clear();
    selectedMissingShowKeys.value.clear();
    activeSeasonTab.value = {};
    ElMessage.success('已成功清空全部缺集巡检结果与缓存');
  } catch (err: any) {
    ElMessage.error(`清空失败: ${err.message || '网络异常'}`);
  }
}

function toggleExpandShow(showKey: string) {
  if (expandedShowKeys.value.has(showKey)) {
    expandedShowKeys.value.delete(showKey);
  } else {
    expandedShowKeys.value.add(showKey);
  }
}


async function copyShowMissing(show: MissingShowGroup) {
  const lines: string[] = [
    `【《${show.title}》全剧缺失分集汇总】(累计缺失 ${show.totalMissingCount} 集, 现存 ${show.totalLocalCount} 集):`,
  ];
  for (const s of show.seasons) {
    if (s.missingCount > 0) {
      lines.push(`\n▶ ${s.seasonLabel} (缺 ${s.missingCount} 集: ${s.shortRangesStr || s.missingRangesStr})`);
      if (s.detailedList && s.detailedList.length) {
        lines.push('  ' + s.detailedList.join('\n  '));
      } else {
        (s.missingEpisodes || []).forEach((ep) => {
          lines.push(`  • ${ep.tag}: ${ep.name || '第 ' + ep.episode + ' 集'} (${ep.airDate || '待定'})`);
        });
      }
    }
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已复制《${show.title}》全剧缺失清单`);
  } catch {
    ElMessage.info('复制失败，请手动选取');
  }
}

async function handleRecheckShow(show: MissingShowGroup) {
  const key = show.showKey || show.folderPath || show.title;
  isRecheckingShow.value[key] = true;
  try {
    const res = await maintenanceApi.recheckShow({
      accountId: activeAccountId.value,
      folderPath: show.folderPath,
      folderId: show.folderId,
      tmdbId: show.tmdbId || undefined,
      excludeUnreleased: missingOptions.excludeUnreleased,
      ignoreSeasonZero: missingOptions.ignoreSeasonZero,
      onlyEnded: missingOptions.onlyEnded,
    });

    const updatedShow: MissingShowGroup = (((res as any)?.show || res) as MissingShowGroup);

    if (updatedShow && updatedShow.title) {
      if (missingInspectionResult.value) {
        if (!missingInspectionResult.value.shows) {
          missingInspectionResult.value.shows = [];
        }
        const sIdx = missingInspectionResult.value.shows.findIndex(
          (s: MissingShowGroup) => s.showKey === updatedShow.showKey || s.folderPath === updatedShow.folderPath
        );
        if (sIdx !== -1) {
          missingInspectionResult.value.shows[sIdx] = updatedShow;
        } else {
          missingInspectionResult.value.shows.unshift(updatedShow);
        }

        // 同步替换 items
        const remainingItems = (missingInspectionResult.value.items || []).filter(
          (i: MissingSeasonResult) => i.folderPath !== updatedShow.folderPath && !updatedShow.seasons.some((rs: MissingSeasonResult) => rs.groupKey === i.groupKey)
        );
        missingInspectionResult.value.items = [...remainingItems, ...updatedShow.seasons];

        // 重新统计总数
        const activeShows = missingInspectionResult.value.shows.filter((s: MissingShowGroup) => s.hasMissing || s.totalMissingCount > 0);
        missingInspectionResult.value.missingShowsCount = activeShows.length;
        missingInspectionResult.value.totalMissingCount = activeShows.reduce((sum: number, s: MissingShowGroup) => sum + s.totalMissingCount, 0);
      }

      // 自动自愈和谐墓碑：如果补齐了曾经被封禁的集数，从本地墓碑库中移除
      if (tombstones.value.length > 0) {
        const normTitle = (updatedShow.title || '').trim().toLowerCase();
        const missingKeySet = new Set<string>();
        for (const s of updatedShow.seasons) {
          for (const ep of s.missingEpisodes || []) {
            missingKeySet.add(`${s.season}_${ep.episode}`);
          }
        }
        const initialCount = tombstones.value.length;
        tombstones.value = tombstones.value.filter((t) => {
          const tTitle = (t.showTitle || '').trim().toLowerCase();
          if (tTitle.includes(normTitle) || normTitle.includes(tTitle)) {
            const epKey = `${t.season || 1}_${t.episode}`;
            if (!missingKeySet.has(epKey)) {
              return false; // 移除已补充的墓碑
            }
          }
          return true;
        });
        if (tombstones.value.length !== initialCount) {
          saveTombstones();
          ElMessage.success(`检测到已补充缺失集，已自动自愈并清除 ${initialCount - tombstones.value.length} 条对应和谐历史墓碑！`);
        }
      }

      if (updatedShow.totalMissingCount === 0) {
        ElMessage.success(`《${updatedShow.title}》复检完成: 所有分集已完整补齐，无缺失！`);
      } else {
        ElMessage.success(`《${updatedShow.title}》复检完成: 现存 ${updatedShow.totalLocalCount} 集，缺失 ${updatedShow.totalMissingCount} 集`);
      }
    } else {
      ElMessage.info(`《${show.title}》复检完成`);
    }
  } catch (err: any) {
    ElMessage.error(`复检失败: ${err.message || '网络异常'}`);
  } finally {
    isRecheckingShow.value[key] = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 模块 3: 定时维护计划保存
// ─────────────────────────────────────────────────────────────
async function handleSaveSchedule() {
  isSavingSchedule.value = true;
  try {
    const payload = {
      ...rawFullConfig,
      maintenance: {
        ...(rawFullConfig.maintenance || {}),
        enableBannedScanCron: scheduleForm.enableBannedScanCron,
        bannedScanCron: scheduleForm.bannedScanCron,
        autoCleanBanned: scheduleForm.autoCleanBanned,
        enableMissingScanCron: scheduleForm.enableMissingScanCron,
        missingScanCron: scheduleForm.missingScanCron,
        enableSweepEmptyCron: false,
        sweepEmptyCron: '0 4 * * 0',
        enableDedupCron: false,
        autoPruneDedup: false,
        notifyOnMaintenance: scheduleForm.notifyOnMaintenance,
      },
    };

    await settingsApi.saveSettings(payload);
    rawFullConfig = payload;
    ElMessage.success('定时存储维护计划配置已成功保存！');
  } catch (err: any) {
    ElMessage.error(`保存计划失败: ${err.message || '保存异常'}`);
  } finally {
    isSavingSchedule.value = false;
  }
}

onMounted(() => {
  logStore.connectSSE();
  initData();
  checkMissingJobStatus(true);
});

onUnmounted(() => {
  if (missingPollTimer) {
    clearInterval(missingPollTimer);
    missingPollTimer = null;
  }
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- 顶层主视口切换：统一对齐频道监控标准胶囊选项卡规范（对齐频道监控规范 ChannelView:899-940）
         页面标题唯一来源收敛为 MainLayout 公共头部 route.meta 渲染，视图内容区直接从选项卡开始 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <!-- 模式 A: 剧集缺集独立视图 (/missing) 的专属选项卡组（双模式解耦：与模式 B 互斥渲染） -->
      <div v-if="isMissingRoute" class="tab-pill-group">
        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'missing' }"
          @click="activeTab = 'missing'"
        >
          <Tv class="w-3.5 h-3.5" />
          <span>剧集缺集检测</span>
          <span v-if="missingInspectionResult?.totalMissingCount" class="tab-pill__badge">
            {{ missingInspectionResult.totalMissingCount }} 缺
          </span>
        </button>

        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'records' }"
          @click="activeTab = 'records'"
        >
          <History class="w-3.5 h-3.5" />
          <span>缺更排查记录</span>
          <span v-if="missingJobsCount" class="tab-pill__badge">
            {{ missingJobsCount }}
          </span>
        </button>

        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'schedule' }"
          @click="activeTab = 'schedule'"
        >
          <Clock class="w-3.5 h-3.5" />
          <span>缺更定时计划</span>
        </button>
      </div>

      <!-- 模式 B: 网盘清理与违规治理独立视图 (/maintenance) 的专属选项卡组 -->
      <div v-else class="tab-pill-group">
        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'banned' }"
          @click="activeTab = 'banned'"
        >
          <ShieldAlert class="w-3.5 h-3.5" />
          <span>违规死链巡检</span>
          <span v-if="bannedScanResult?.bannedCount" class="tab-pill__badge">
            {{ bannedScanResult.bannedCount }}
          </span>
        </button>

        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'records' }"
          @click="activeTab = 'records'"
        >
          <History class="w-3.5 h-3.5" />
          <span>清理与隔离记录</span>
          <span v-if="bannedJobsCount" class="tab-pill__badge">
            {{ bannedJobsCount }}
          </span>
        </button>

        <button
          type="button"
          class="tab-pill"
          :class="{ 'tab-pill--active': activeTab === 'schedule' }"
          @click="activeTab = 'schedule'"
        >
          <Clock class="w-3.5 h-3.5" />
          <span>自动维护计划</span>
        </button>
      </div>

      <!-- 右侧快速操作区（布局骨架对齐频道监控规范 ChannelView:927-939；各模式主操作按钮保留在各自扫描卡片头） -->
      <div class="flex items-center gap-2"></div>
    </div>

    <!-- ─────────────────────────────────────────────────────────────
         Tab 1: 违规死链巡检与清理
         ───────────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'banned'" class="space-y-6">
      <div class="settings-card">
        <!-- 卡片头部 (参照缺集检测规范: 左侧标题说明 + 右侧操作按钮) -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white">网盘和谐与违规检测</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              排查网盘审核拦截、特征封禁与损坏死链，支持资产柔性隔离与 Emby 联动下架
            </p>
          </div>

          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class="btn-primary flex items-center gap-2 text-xs py-2 px-4 cursor-pointer"
              :disabled="isBannedScanning"
              @click="handleScanBanned"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isBannedScanning }" />
              <span>{{ isBannedScanning ? '深度巡检中...' : '开始巡检' }}</span>
            </button>

            <button
              v-if="bannedScanResult && bannedScanResult.bannedCount > 0"
              type="button"
              class="bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs py-2 px-4 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
              :disabled="isBannedCleaning || selectedBannedIds.size === 0"
              @click="handleCleanBanned"
            >
              <Trash2 class="w-3.5 h-3.5" />
              <span>{{ cleanSettingPanelOpen ? '收起处置设置' : '处置违规文件' }} ({{ selectedBannedIds.size }})</span>
            </button>
          </div>
        </div>

        <!-- 违规处置确认与联动设置内联展开面板（替代 el-dialog，对齐频道监控规范 ChannelView:1034-1083 内联表单形态） -->
        <div v-if="cleanSettingPanelOpen" class="inline-panel inline-panel--rose space-y-4 my-4">
          <div class="flex items-center justify-between">
            <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
              <Trash2 class="w-3.5 h-3.5 text-rose-500" />
              <span>违规失效文件处置确认与联动</span>
            </div>
            <button
              type="button"
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              title="收起"
              @click="cleanSettingPanelOpen = false"
            >
              <X class="w-4 h-4" />
            </button>
          </div>

          <!-- 影响预估概览卡片 -->
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between">
            <div>
              <div class="font-bold text-gray-900 dark:text-white text-xs">本次选中待处置</div>
              <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                共 <span class="font-bold text-rose-600 dark:text-rose-400">{{ selectedBannedIds.size }}</span> 个违规文件
              </div>
            </div>
            <div class="text-right">
              <div class="text-xs font-mono font-bold text-gray-800 dark:text-gray-200">{{ selectedBannedSizeFormatted }}</div>
              <div class="text-[10px] text-gray-400">总占用空间</div>
            </div>
          </div>

          <!-- 处置方式单选二选一 -->
          <div class="space-y-2">
            <div class="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
              <span>处置去向（单选二选一）:</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <!-- 选项 A：回收站 -->
              <label
                class="p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between"
                :class="cleanAction === 'trash' ? 'border-rose-500 bg-rose-50/40 dark:bg-rose-950/20 ring-1 ring-rose-500' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'"
              >
                <div class="flex items-start gap-2">
                  <input type="radio" v-model="cleanAction" value="trash" class="mt-0.5 text-rose-600" />
                  <div>
                    <div class="font-bold text-gray-900 dark:text-white text-xs">移入网盘回收站</div>
                    <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                      彻底移入 139 回收站释放存储空间（保留 30 天后悔期，可找回）。
                    </div>
                  </div>
                </div>
              </label>

              <!-- 选项 B：隔离区 -->
              <label
                class="p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between"
                :class="cleanAction === 'quarantine' ? 'border-purple-500 bg-purple-50/40 dark:bg-purple-950/20 ring-1 ring-purple-500' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'"
              >
                <div class="flex items-start gap-2">
                  <input type="radio" v-model="cleanAction" value="quarantine" class="mt-0.5 text-purple-600" />
                  <div>
                    <div class="font-bold text-gray-900 dark:text-white text-xs">移动到隔离目录</div>
                    <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                      保留原始资产，移出影视库刮削路径，方便后期重命名或重新上传。
                    </div>
                  </div>
                </div>
              </label>
            </div>
          </div>

          <!-- 隔离目录输入 (仅在 quarantine 时显示) -->
          <div v-if="cleanAction === 'quarantine'" class="p-3 rounded-xl bg-purple-50/30 dark:bg-purple-950/20 border border-purple-200/80 dark:border-purple-900/60 space-y-1.5">
            <div class="flex items-center justify-between text-[11px]">
              <span class="font-medium text-purple-950 dark:text-purple-200">隔离目标路径 (目录不存在时将自动创建):</span>
            </div>
            <input
              v-model="quarantinePath"
              type="text"
              class="w-full px-3 py-1.5 bg-white dark:bg-slate-900 border border-purple-200 dark:border-purple-800 rounded-lg text-xs font-mono outline-none focus:border-purple-500 transition-colors"
              placeholder="/.quarantine 或 /隔离区"
            />
          </div>

          <!-- 高级联动选项 -->
          <div class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div class="font-semibold text-gray-800 dark:text-gray-200">高级联动与自愈选项:</div>

            <!-- 级联伴生清理 -->
            <label class="flex items-start gap-2.5 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer">
              <input type="checkbox" v-model="cascadeCompanion" class="mt-0.5 rounded text-blue-600" />
              <div class="space-y-0.5">
                <span class="font-medium text-gray-800 dark:text-gray-200 text-xs">级联清理同基名伴生文件 (.nfo / 外挂字幕 / .strm)</span>
                <p class="text-[11px] text-gray-400 leading-relaxed">
                  自动探查同目录下相同片名开头的外挂字幕和元数据，随视频一同处置，避免原目录残留死尸。
                </p>
              </div>
            </label>

            <!-- Emby 通知刷新 -->
            <label class="flex items-start gap-2.5 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer">
              <input type="checkbox" v-model="notifyEmby" class="mt-0.5 rounded text-blue-600" />
              <div class="space-y-0.5">
                <span class="font-medium text-gray-800 dark:text-gray-200 text-xs">直连通知 Emby 增量刷新对应剧集目录</span>
                <p class="text-[11px] text-gray-400 leading-relaxed">
                  处置完成后通过 Emby API 增量推送受影响目录，播放器立即下架幽灵剧集，杜绝 404 播放错误。
                </p>
              </div>
            </label>

            <!-- 衍生空目录修剪 -->
            <label class="flex items-start gap-2.5 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer">
              <input type="checkbox" v-model="pruneEmptyParent" class="mt-0.5 rounded text-blue-600" />
              <div class="space-y-0.5">
                <span class="font-medium text-gray-800 dark:text-gray-200 text-xs">若处置后父目录变为空文件夹，顺手清理</span>
                <p class="text-[11px] text-gray-400 leading-relaxed">
                  若原季目录或剧集目录在移走后已无其他文件，同步修剪该空目录保持目录树整洁。
                </p>
              </div>
            </label>
          </div>

          <!-- 面板 footer：执行与取消 -->
          <div class="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              class="btn-default text-xs h-8 px-4 cursor-pointer"
              @click="cleanSettingPanelOpen = false"
            >
              取消
            </button>
            <button
              type="button"
              class="px-4 py-1.5 text-xs rounded-lg font-medium text-white transition-colors flex items-center gap-1.5 cursor-pointer"
              :class="cleanAction === 'quarantine' ? 'bg-purple-600 hover:bg-purple-700' : 'bg-rose-600 hover:bg-rose-700'"
              :disabled="isBannedCleaning"
              @click="executeCleanBanned"
            >
              <span v-if="isBannedCleaning" class="animate-spin mr-1">⏳</span>
              <span>确认执行{{ cleanAction === 'quarantine' ? '隔离' : '移入回收站' }}</span>
            </button>
          </div>
        </div>

        <!-- 专属巡检目录与跳过设置（单栏纯净，参照缺集检测） -->
        <div class="p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/80 my-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
            <span class="text-slate-600 dark:text-slate-400 whitespace-nowrap font-medium shrink-0">巡检目录:</span>
            <div class="flex items-center gap-2 flex-1">
              <input
                v-model="bannedFolderName"
                type="text"
                class="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-mono outline-none focus:border-blue-500 transition-colors"
                placeholder="留空巡检全盘，或如 /媒体库"
                @change="onManualPathChange('banned')"
                @keyup.enter="onManualPathChange('banned')"
              />
              <button
                type="button"
                class="px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0"
                @click="openFolderPickerFor('banned')"
              >
                <FolderTree class="w-3.5 h-3.5 text-blue-500" />
                <span>选择目录</span>
              </button>

              <!-- 账号切换选择器（并置目录选择框旁边：先选账号 → 再选目录 → 再巡检，spec 5.5.1.1） -->
              <AccountSwitcher v-model="activeAccountId" :accounts="accounts" @select="handleAccountSwitch" />
            </div>
          </div>
          <div class="flex items-center gap-2 flex-1 md:max-w-xs">
            <span class="text-slate-600 dark:text-slate-400 whitespace-nowrap font-medium">排除跳过:</span>
            <input
              v-model="bannedExcludePathsStr"
              type="text"
              class="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-mono outline-none focus:border-blue-500 transition-colors"
              placeholder="已默认排除隔离区，可逗号分隔"
              @change="saveCleanPref"
            />
            <span v-if="ignoredBannedItems.length > 0" class="text-[11px] text-amber-600 dark:text-amber-400 whitespace-nowrap flex items-center gap-1 font-normal">
              <EyeOff class="w-3 h-3" />
              <span>白名单 {{ ignoredBannedItems.length }}</span>
            </span>
          </div>
        </div>

        <!-- 业务开关选项列表 (一行一个，清爽纯净规范) -->
        <div class="space-y-3 my-4">
          <!-- 开关 1: 全类型文件深度排查 -->
          <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="space-y-0.5 pr-3">
                <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">全类型文件深度排查</span>
                <p class="text-[11px] text-slate-500 dark:text-slate-400">
                  开启后遍历排查所有格式（含文档、压缩包等）；关闭则仅快速巡检视频媒体文件 (默认推荐)
                </p>
              </div>
              <el-switch
                :model-value="bannedScanScope === 'all'"
                @update:model-value="bannedScanScope = $event ? 'all' : 'video'; saveCleanPref()"
              />
            </div>

            <!-- 当未开启全类型排查时，清晰展示内置视频清单并提供自由扩展 -->
            <div v-if="bannedScanScope !== 'all'" class="pt-2.5 border-t border-slate-200/80 dark:border-slate-700/60 space-y-2 text-xs">
              <!-- 清晰罗列 14 种默认内置视频格式，消除不确定性 -->
              <div class="flex flex-wrap items-baseline gap-1.5 text-[11px] leading-relaxed">
                <span class="text-slate-600 dark:text-slate-300 font-medium shrink-0">默认内置视频格式 (14种):</span>
                <span class="font-mono text-slate-700 dark:text-slate-300 bg-white/80 dark:bg-slate-900/60 px-2 py-0.5 rounded border border-slate-200/80 dark:border-slate-700/80">
                  .mp4, .mkv, .avi, .mov, .wmv, .flv, .ts, .m2ts, .iso, .rmvb, .webm, .mpg, .mpeg, .vob
                </span>
              </div>

              <!-- 补充其他格式操作区 -->
              <div class="flex flex-wrap items-center gap-2 pt-0.5">
                <span class="text-slate-600 dark:text-slate-300 font-medium text-[11px] shrink-0">手动补充其他格式:</span>
                <span
                  v-for="ext in customExtensions"
                  :key="ext"
                  class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-mono text-[11px] flex items-center gap-1"
                >
                  <span>{{ ext }}</span>
                  <X
                    class="w-3 h-3 cursor-pointer hover:text-red-500 transition-colors"
                    title="移除此格式"
                    @click="removeCustomExtension(ext)"
                  />
                </span>

                <div class="flex items-center gap-1.5">
                  <input
                    v-model="newExtInput"
                    type="text"
                    placeholder="如 strm 或 .zip"
                    class="w-28 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-xs font-mono outline-none focus:border-blue-500"
                    @keyup.enter="addCustomExtension"
                  />
                  <button
                    type="button"
                    class="px-2.5 py-1 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded text-xs font-medium cursor-pointer transition-colors"
                    @click="addCustomExtension"
                  >
                    添加
                  </button>
                </div>

                <span class="text-[11px] text-slate-400">
                  (若有未内置的特殊视频如 .strm/.m3u8 或压缩包/文档等，输入后回车添加，支持逗号批量输入)
                </span>
              </div>
            </div>
          </div>

          <!-- 开关 2: 隔离区柔性暂存模式 -->
          <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="space-y-0.5 pr-3">
                <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">隔离区柔性暂存模式</span>
                <p class="text-[11px] text-slate-500 dark:text-slate-400">
                  开启后将违规死链移动到隔离目录（保留实体供救回，防 Emby 404）；关闭则直接移入云盘回收站释放空间
                </p>
              </div>
              <el-switch
                :model-value="cleanAction === 'quarantine'"
                @update:model-value="cleanAction = $event ? 'quarantine' : 'trash'; saveCleanPref()"
              />
            </div>
            <!-- 当开启隔离模式时，展示自定义隔离路径配置 -->
            <div v-if="cleanAction === 'quarantine'" class="pt-2 border-t border-slate-200/80 dark:border-slate-700/60 flex items-center gap-2">
              <span class="text-[11px] text-slate-600 dark:text-slate-400 shrink-0 font-medium">隔离路径:</span>
              <input
                v-model="quarantinePath"
                type="text"
                placeholder="留空使用默认隔离区"
                class="flex-1 max-w-md px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-xs font-mono outline-none focus:border-blue-500"
                @change="onQuarantinePathChange"
              />
            </div>
          </div>

          <!-- 开关 3: 级联清理伴生文件 -->
          <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 flex items-center justify-between">
            <div class="space-y-0.5 pr-3">
              <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">级联清理伴生文件</span>
              <p class="text-[11px] text-slate-500 dark:text-slate-400">
                处置违规视频时连带清理同名伴生文件（如 .nfo 刮削元数据、.strm 与外挂字幕）
              </p>
            </div>
            <el-switch v-model="cascadeCompanion" @change="saveCleanPref" />
          </div>

          <!-- 开关 4: Emby 增量刷新下架通知 -->
          <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 flex items-center justify-between">
            <div class="space-y-0.5 pr-3">
              <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Emby 增量刷新下架通知</span>
              <p class="text-[11px] text-slate-500 dark:text-slate-400">
                处置完成后自动精准通知 Emby 刷新受影响剧集目录，消除幽灵剧集杜绝 404 报错
              </p>
            </div>
            <el-switch v-model="notifyEmby" @change="saveCleanPref" />
          </div>

          <!-- 开关 5: 自动修剪父级空目录 -->
          <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 flex items-center justify-between">
            <div class="space-y-0.5 pr-3">
              <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">自动修剪父级空目录</span>
              <p class="text-[11px] text-slate-500 dark:text-slate-400">
                违规文件移出或清理后，若父级文件夹变空，自动向上递归安全修剪清理
              </p>
            </div>
            <el-switch v-model="pruneEmptyParent" @change="saveCleanPref" />
          </div>
        </div>

        <!-- 实时穿透扫描中：流式进度状态栏 (参照缺集检测风格) -->
        <div
          v-if="isBannedScanning"
          class="p-4 rounded-xl bg-gradient-to-r from-rose-50/90 via-pink-50/60 to-purple-50/90 dark:from-rose-950/40 dark:via-pink-950/30 dark:to-purple-950/40 border border-rose-200/80 dark:border-rose-800/60 space-y-2.5 my-4 shadow-xs backdrop-blur-xs"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-xl bg-rose-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                <RefreshCw class="w-4 h-4 animate-spin" />
              </div>
              <div class="space-y-0.5 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                    <span>云盘违规与死链深度巡检中</span>
                    <span class="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300 font-bold animate-pulse">
                      ⚡ 正在穿透遍历
                    </span>
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  正在多维排查审核拦截码、特征黑名单与损坏死链，请耐心等待...
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- 统计面板 -->
        <div v-if="bannedScanResult" class="grid grid-cols-2 md:grid-cols-4 gap-3 my-4">
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">已遍历目录</span>
            <div class="text-lg font-bold text-gray-800 dark:text-gray-100 mt-1">{{ bannedScanResult.scannedFolders }}</div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">已排查文件</span>
            <div class="text-lg font-bold text-gray-800 dark:text-gray-100 mt-1">
              {{ bannedScanResult.scannedTargetFiles !== undefined ? bannedScanResult.scannedTargetFiles : bannedScanResult.totalFiles }}
              <span v-if="bannedScanResult.ignoredCount" class="text-xs font-normal text-amber-600 dark:text-amber-400 ml-1">
                (已忽略 {{ bannedScanResult.ignoredCount }})
              </span>
            </div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">发现违规死链</span>
            <div class="text-lg font-bold" :class="bannedScanResult.bannedCount > 0 ? 'text-red-500' : 'text-emerald-500'">
              {{ bannedScanResult.bannedCount }}
            </div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">可释放存储空间</span>
            <div class="text-lg font-bold text-gray-800 dark:text-gray-100 mt-1">{{ bannedScanResult.totalBannedSizeFormatted }}</div>
          </div>
        </div>

        <!-- 违规处置结果反馈卡片 -->
        <div v-if="bannedCleanResult" class="p-4 rounded-xl border border-blue-200/80 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-950/30 my-4 space-y-2">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <CheckCircle2 class="w-4 h-4 text-emerald-500 shrink-0" />
              <span class="text-xs font-bold text-gray-900 dark:text-gray-100">
                违规文件处置完成
              </span>
              <span
                class="px-2 py-0.5 rounded text-[11px] font-semibold"
                :class="bannedCleanResult.action === 'quarantine' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'"
              >
                {{ bannedCleanResult.action === 'quarantine' ? `已隔离至 ${bannedCleanResult.quarantinePath || '/.quarantine'}` : '已移入回收站' }}
              </span>
            </div>
            <span class="text-[11px] font-mono text-gray-500 dark:text-gray-400">
              涉及存储空间: {{ bannedCleanResult.freedSizeFormatted }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300 pt-1 border-t border-blue-100/60 dark:border-blue-900/40">
            <span>成功处置: <strong class="text-gray-900 dark:text-white">{{ bannedCleanResult.processedVideos || bannedCleanResult.successCount }}</strong> 项视频</span>
            <span v-if="bannedCleanResult.processedCompanions">
              伴生文件: <strong class="text-gray-900 dark:text-white">{{ bannedCleanResult.processedCompanions }}</strong> 项 (已随同清理)
            </span>
            <span v-if="bannedCleanResult.embyResult">
              Emby 刷新:
              <strong :class="bannedCleanResult.embyResult.notified ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'">
                {{ bannedCleanResult.embyResult.notified ? `已刷新 ${bannedCleanResult.embyResult.updatedDirsCount} 个目录 (下架幽灵剧集)` : (bannedCleanResult.embyResult.reason || '已跳过') }}
              </strong>
            </span>
            <span v-if="bannedCleanResult.prunedEmptyDirsCount">
              衍生清理: <strong class="text-blue-600 dark:text-blue-400">已清理 {{ bannedCleanResult.prunedEmptyDirsCount }} 个空目录</strong>
            </span>
          </div>

          <!-- 受影响剧集目录（已随同处置） -->
          <div
            v-if="bannedCleanResult.affectedDirectories && bannedCleanResult.affectedDirectories.length > 0"
            class="pt-2 border-t border-blue-100/60 dark:border-blue-900/40 flex items-center gap-2 flex-wrap"
          >
            <span class="text-[11px] text-gray-500 dark:text-gray-400 font-medium shrink-0">
              受影响剧集目录 (已同步处置):
            </span>
            <span
              v-for="dir in bannedCleanResult.affectedDirectories"
              :key="dir"
              class="px-2 py-0.5 rounded text-[11px] font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            >
              {{ dir }}
            </span>
          </div>
        </div>

        <!-- 违规列表表格与分类胶囊 -->
        <div v-if="bannedScanResult && bannedScanResult.bannedCount > 0" class="space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-gray-500 px-1">
            <div class="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                class="hover:text-blue-600 flex items-center gap-1 cursor-pointer font-medium"
                @click="toggleSelectAllBanned"
              >
                <CheckSquare v-if="isAllFilteredBannedSelected" class="w-3.5 h-3.5 text-blue-600" />
                <Square v-else class="w-3.5 h-3.5" />
                <span>全选当前</span>
              </button>
              <span>(已选中 {{ selectedBannedIds.size }} / {{ bannedScanResult.bannedFiles.length }} 项)</span>

              <div class="flex items-center gap-1 bg-slate-200/60 dark:bg-slate-800 p-0.5 rounded-lg text-[11px] ml-2">
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
                  :class="activeBannedFilter === 'all' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 font-bold shadow-2xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                  @click="activeBannedFilter = 'all'"
                >
                  全部违规 ({{ bannedScanResult.bannedCount }})
                </button>
                <button
                  v-if="bannedHarmonizedCount > 0"
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
                  :class="activeBannedFilter === 'harmonized' ? 'bg-white dark:bg-slate-700 text-purple-600 dark:text-purple-400 font-bold shadow-2xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                  @click="activeBannedFilter = 'harmonized'"
                >
                  审核封禁 ({{ bannedHarmonizedCount }})
                </button>
                <button
                  v-if="bannedDeadLinkCount > 0"
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
                  :class="activeBannedFilter === 'deadlink' ? 'bg-white dark:bg-slate-700 text-amber-600 dark:text-amber-400 font-bold shadow-2xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                  @click="activeBannedFilter = 'deadlink'"
                >
                  损坏死链 ({{ bannedDeadLinkCount }})
                </button>
              </div>
            </div>
            <span>安全保护：删除操作统一移入回收站，严禁硬删除</span>
          </div>

          <!-- 违规文件行卡片列表（对齐频道监控规范 ChannelView:1659-1663 历史行卡片形态；整卡点击切换勾选等价原行点击） -->
          <div class="space-y-2.5">
            <div
              v-for="item in filteredBannedFiles"
              :key="item.id"
              class="p-3.5 rounded-xl border bg-white dark:bg-slate-900 hover:shadow-xs transition-all cursor-pointer"
              :class="selectedBannedIds.has(item.id)
                ? 'border-blue-400 dark:border-blue-600 ring-1 ring-blue-400/40'
                : 'border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'"
              @click="toggleSelectBanned(item.id)"
            >
              <!-- 首行：勾选 + 文件名 + 命中原因状态胶囊 + 大小与操作 -->
              <div class="flex items-center gap-2.5 flex-wrap">
                <input
                  type="checkbox"
                  :checked="selectedBannedIds.has(item.id)"
                  class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                  @click.stop
                  @change="toggleSelectBanned(item.id)"
                />
                <span class="text-xs font-bold text-gray-900 dark:text-white break-all flex-1 min-w-0">
                  {{ item.name }}
                </span>
                <span
                  class="status-pill"
                  :class="isHarmonizedItem(item) ? 'status-pill--info' : isDeadLinkItem(item) ? 'status-pill--warning' : 'status-pill--danger'"
                >
                  {{ item.reason }}
                </span>
                <span class="text-xs text-gray-700 dark:text-gray-300 font-mono whitespace-nowrap shrink-0">
                  {{ item.sizeFormatted }}
                </span>
                <button
                  type="button"
                  class="px-2 py-1 rounded text-[11px] font-medium text-slate-500 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 border border-slate-200 dark:border-slate-700 inline-flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                  title="非违规或需特意保留？加入白名单后后续扫描将自动跳过"
                  @click.stop="addToIgnoreList(item)"
                >
                  <EyeOff class="w-3 h-3 text-amber-500" />
                  <span>忽略</span>
                </button>
              </div>
              <!-- 次行：路径（mono 截断 + 悬停全文） -->
              <div class="text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate mt-1.5" :title="item.path">
                {{ item.path }}
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态提示 -->
        <div v-else-if="bannedScanResult && bannedScanResult.bannedCount === 0" class="p-12 text-center text-gray-500">
          <CheckCircle2 class="w-12 h-12 mx-auto text-emerald-500 mb-3" />
          <h4 class="text-sm font-semibold text-gray-800 dark:text-gray-200">云盘资产状态健康</h4>
          <p class="text-xs text-gray-400 mt-1">在指定范围内未检索到任何违规占位或失效死链文件</p>
        </div>

        <!-- 和谐封禁留痕档案库 (和谐墓碑) 专区 -->
        <div class="mt-8 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <ShieldAlert class="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">已留痕网盘封禁剧集档案库 (共 {{ tombstones.length }} 集)</h4>
              <span class="text-[11px] text-gray-400">记录因网盘审查拦截、特征封禁处置而隔离或清理的剧集，全流程闭环可溯</span>
            </div>
            <button
              v-if="tombstones.length > 0"
              type="button"
              class="text-[11px] text-slate-500 hover:text-red-600 dark:hover:text-red-400 flex items-center gap-1 cursor-pointer"
              @click="clearAllTombstones"
            >
              <Trash2 class="w-3 h-3" />
              <span>清空和谐档案</span>
            </button>
          </div>

          <!-- 档案清单：紧凑行卡片（对齐频道监控规范 ChannelView:1488 折叠区行卡片形态，字段完整保留） -->
          <div v-if="tombstones.length > 0" class="space-y-2">
            <div
              v-for="t in tombstones"
              :key="t.id"
              class="p-3 rounded-xl border border-purple-200/60 dark:border-purple-900/40 bg-purple-50/20 dark:bg-purple-950/10 hover:shadow-xs transition-all"
            >
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs font-bold text-gray-900 dark:text-white">
                  《{{ t.showTitle }}》
                </span>
                <span class="px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-mono font-bold">
                  S{{ String(t.season).padStart(2, '0') }}{{ t.episode ? 'E' + String(t.episode).padStart(2, '0') : '' }}
                </span>
                <span
                  class="status-pill"
                  :class="t.action === 'quarantine' ? 'status-pill--info' : 'status-pill--danger'"
                >
                  {{ t.action === 'quarantine' ? ('隔离 (' + (t.quarantinePath || '/.quarantine') + ')') : '移入回收站' }}
                </span>
                <span class="text-[11px] text-gray-400 font-mono ml-auto shrink-0">
                  {{ t.timeFormatted }}
                </span>
              </div>
              <div class="text-[11px] font-mono text-gray-600 dark:text-gray-300 truncate mt-1" :title="t.fileName">
                {{ t.fileName }}
              </div>
            </div>
          </div>

          <div v-else class="p-4 text-center text-gray-400 text-xs bg-slate-50/50 dark:bg-slate-900/20 rounded-xl border border-dashed border-gray-200 dark:border-gray-800">
            暂无被封禁剧集的留痕记录。在违规处置时将自动归档被和谐的剧集信息。
          </div>
        </div>
      </div>
    </div>

    <!-- ─────────────────────────────────────────────────────────────
         Tab 2: 剧集缺集检测与断集巡检
         ───────────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'missing'" class="space-y-6">
      <div class="settings-card">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white">TMDB 剧集缺集检测与断集巡检</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              比对 TMDB 官方分集目录，秒级定位缺更、断集与遗漏分集
            </p>
          </div>

          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class="btn-primary flex items-center gap-2 text-xs py-2 px-4 cursor-pointer"
              :disabled="isMissingScanning"
              @click="handleScanMissingEpisodes"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isMissingScanning }" />
              <span>{{ isMissingScanning ? '剧集分析比对中...' : '开始扫描缺集' }}</span>
            </button>
          </div>
        </div>

        <!-- 专属剧集目录设置（单栏纯净） -->
        <div class="p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/80 my-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
            <span class="text-slate-600 dark:text-slate-400 whitespace-nowrap font-medium shrink-0">剧集目录:</span>
            <div class="flex items-center gap-2 flex-1">
              <input
                v-model="missingFolderName"
                type="text"
                class="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-mono outline-none focus:border-blue-500 transition-colors"
                placeholder="输入网盘路径，如 / 或 /媒体库/剧集"
                @change="onManualPathChange('missing')"
                @keyup.enter="onManualPathChange('missing')"
              />
              <button
                type="button"
                class="px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0"
                @click="openFolderPickerFor('missing')"
              >
                <FolderTree class="w-3.5 h-3.5 text-indigo-500" />
                <span>选择目录</span>
              </button>

              <!-- 账号切换选择器（并置目录选择框旁边：与网盘清理模式相对位置完全一致，spec 5.5.1.1 验收条件 c） -->
              <AccountSwitcher v-model="activeAccountId" :accounts="accounts" @select="handleAccountSwitch" />
            </div>
          </div>
          <span class="text-[11px] text-gray-400 shrink-0">
            比对 TMDB 官方季播列表，精准定位断集漏更，独立记忆
          </span>
        </div>

        <!-- 3 个实用检测规则开关（switch-row 统一规格，对齐频道监控规范 ChannelView:959-967） -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 my-4">
          <div class="switch-row">
            <div class="space-y-0.5 pr-3">
              <span class="switch-row__title">排除未播出分集</span>
              <p class="switch-row__desc">
                比对官方首播日期，连载中待播集数不计入缺集告警（默认推荐）
              </p>
            </div>
            <el-switch v-model="missingOptions.excludeUnreleased" @change="saveMissingPref" />
          </div>

          <div class="switch-row">
            <div class="space-y-0.5 pr-3">
              <span class="switch-row__title">忽略第 0 季特别篇 (SP)</span>
              <p class="switch-row__desc">
                仅严格检测正片季，自动过滤预告、采访、特典等花絮分集
              </p>
            </div>
            <el-switch v-model="missingOptions.ignoreSeasonZero" @change="saveMissingPref" />
          </div>

          <div class="switch-row">
            <div class="space-y-0.5 pr-3">
              <span class="switch-row__title">只检查完结剧</span>
              <p class="switch-row__desc">
                多季老季与已收官综艺视同完结，自动跳过当季连载中剧集
              </p>
            </div>
            <el-switch v-model="missingOptions.onlyEnded" @change="saveMissingPref" />
          </div>
        </div>

        <!-- 实时穿透扫描中：顶部流式进度状态栏 (非阻塞，下方即时呈现已扫结果) -->
        <div
          v-if="isMissingScanning"
          class="p-4 rounded-xl bg-gradient-to-r from-blue-50/90 via-indigo-50/60 to-purple-50/90 dark:from-blue-950/40 dark:via-indigo-950/30 dark:to-purple-950/40 border border-blue-200/80 dark:border-blue-800/60 space-y-2.5 my-4 shadow-xs backdrop-blur-xs"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                <RefreshCw class="w-4 h-4 animate-spin" />
              </div>
              <div class="space-y-0.5 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                    <span>全库剧集缺更巡检中</span>
                    <span class="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 font-bold animate-pulse">
                      ⚡ 实时流式呈现
                    </span>
                  </span>
                  <span v-if="missingJobStatus?.currentShow" class="text-xs font-semibold text-blue-600 dark:text-blue-400 truncate max-w-xs">
                    正在核验《{{ missingJobStatus.currentShow }}》
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {{ latestMissingScanLog }}
                </p>
              </div>
            </div>

            <!-- 右侧：进度百分比与计数 -->
            <div class="flex items-center gap-3 shrink-0 self-end sm:self-auto text-xs">
              <span class="text-slate-500 font-mono">
                已核验 <strong class="text-blue-600 dark:text-blue-400 font-bold">{{ missingJobStatus?.current || 0 }}</strong> / {{ missingJobStatus?.total || '?' }} 部
              </span>
              <span class="px-2 py-0.5 rounded-md font-mono font-bold bg-blue-600 text-white text-xs">
                {{ scanProgressPercent }}%
              </span>
            </div>
          </div>

          <!-- 进度条 -->
          <div class="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
            <div
              class="bg-gradient-to-r from-blue-600 to-indigo-500 h-full rounded-full transition-all duration-300"
              :style="{ width: `${scanProgressPercent}%` }"
            ></div>
          </div>
        </div>

                <!-- 批次流全局管理工具栏 (当存在批次时展示) -->
        <div v-if="scanBatches.length > 0" class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 pb-2 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div class="flex items-center gap-2 text-slate-600 dark:text-slate-400 font-medium">
            <History class="w-4 h-4 text-indigo-500" />
            <span>
              已记录 <strong class="text-slate-900 dark:text-white font-bold">{{ scanBatches.length }}</strong> 次独立巡检批次
            </span>
            <span class="text-[11px] text-slate-400">（扫描一次算一次，各批次独立折叠展开核验）</span>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 transition-colors cursor-pointer flex items-center gap-1"
              @click="expandAllBatches"
            >
              <ChevronDown class="w-3.5 h-3.5" />
              <span>全部展开</span>
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-750 transition-colors cursor-pointer flex items-center gap-1"
              @click="collapseAllBatches"
            >
              <ChevronUp class="w-3.5 h-3.5" />
              <span>全部折叠</span>
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 bg-slate-100 hover:bg-rose-50 dark:bg-slate-800 dark:hover:bg-rose-950/30 transition-colors cursor-pointer flex items-center gap-1"
              @click="clearAllBatches"
            >
              <Trash2 class="w-3.5 h-3.5 text-slate-400 hover:text-rose-500" />
              <span>清空所有批次</span>
            </button>
          </div>
        </div>

        <!-- 独立巡检批次卡片流 (Batch Cards Stream) -->
        <div v-if="scanBatches.length > 0" class="space-y-4 my-4">
          <div
            v-for="(batch, bIdx) in scanBatches"
            :key="batch.id"
            class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden transition-all duration-200"
            :class="{ 'ring-1 ring-indigo-500/30': batch.isExpanded }"
          >
            <!-- 批次头部 (Card Header) -->
            <div
              class="p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer bg-slate-50/70 hover:bg-slate-100/60 dark:bg-slate-850 dark:hover:bg-slate-800/80 transition-colors select-none"
              @click="toggleBatchExpand(batch)"
            >
              <!-- 左侧：展开折叠指示器 + 批次基本信息 -->
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                  <component :is="batch.isExpanded ? ChevronDown : ChevronRight" class="w-4 h-4 transition-transform" />
                </div>
                <div class="space-y-0.5 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-xs text-slate-900 dark:text-white truncate">
                      {{ batch.title || `缺更巡检 · ${batch.folderPath}` }}
                    </span>
                    <span class="text-[11px] font-mono text-slate-400">
                      {{ batch.timeFormatted }}
                    </span>
                    <span v-if="batch.durationMs > 0" class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      {{ (batch.durationMs / 1000).toFixed(1) }}s
                    </span>
                  </div>
                  <div class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 truncate">
                    <span>目标路径: <code class="font-mono">{{ batch.folderPath }}</code></span>
                    <span v-if="batch.totalFiles > 0">· 共检阅 {{ batch.totalFiles }} 个视频</span>
                  </div>
                </div>
              </div>

              <!-- 右侧：统计胶囊徽标 + 操作按钮组 -->
              <div class="flex items-center gap-2.5 flex-wrap self-end md:self-auto shrink-0" @click.stop>
                <!-- 统计徽标组 -->
                <div class="flex items-center gap-1.5 text-xs">
                  <span class="px-2 py-0.5 rounded-md font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    共 {{ batch.totalShows }} 部
                  </span>

                  <!-- 缺更徽标 -->
                  <span
                    v-if="batch.missingShowsCount > 0"
                    class="px-2 py-0.5 rounded-md font-bold bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 border border-rose-200/60 dark:border-rose-800/60"
                  >
                    缺更 {{ batch.missingShowsCount }} 部
                    <span v-if="batch.totalMissingCount > 0" class="font-normal font-mono">({{ batch.totalMissingCount }}集)</span>
                  </span>
                  <span
                    v-else
                    class="px-2 py-0.5 rounded-md font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/60"
                  >
                    全部完备
                  </span>

                  <!-- 未识别待核查徽标 (高亮重点突出，防误判人工核查入口) -->
                  <span
                    v-if="batch.unidentifiedShowsCount > 0"
                    class="px-2 py-0.5 rounded-md font-bold bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800 animate-pulse flex items-center gap-1"
                    title="存在未能高置信锁定 TMDB 的剧集，系统已主动触发防误判保护，待人工核查"
                  >
                    <AlertTriangle class="w-3 h-3 text-amber-500" />
                    <span>未识别 {{ batch.unidentifiedShowsCount }} 部待核查</span>
                  </span>
                </div>

                <!-- 批次快捷操作按钮 -->
                <div class="flex items-center gap-1 border-l border-slate-200 dark:border-slate-700 pl-2">
                  <button
                    type="button"
                    class="p-1 rounded text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-300 hover:bg-slate-200/70 dark:hover:bg-slate-750 transition-colors cursor-pointer"
                    title="以此批次的目录再次执行巡检"
                    @click="reRunBatchScan(batch)"
                  >
                    <RefreshCw class="w-3.5 h-3.5" />
                  </button>
                  <button
                    v-if="batch.missingShowsCount > 0"
                    type="button"
                    class="p-1 rounded text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-750 transition-colors cursor-pointer"
                    title="复制此批次的缺更清单"
                    @click="copyBatchMissing(batch)"
                  >
                    <Copy class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    class="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                    title="删除此批次记录"
                    @click="deleteBatch(batch, bIdx)"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <!-- 批次主体内容 (展开时呈现) -->
            <div v-if="batch.isExpanded" class="p-4 border-t border-slate-200 dark:border-slate-800 space-y-4 bg-white dark:bg-slate-900">
              <!-- 批次详情异步加载中 -->
              <div v-if="batch.isLoadingDetail" class="p-8 text-center text-slate-400 space-y-2">
                <RefreshCw class="w-5 h-5 animate-spin mx-auto text-indigo-500" />
                <p class="text-xs">正在加载批次巡检快照明细...</p>
              </div>

              <template v-else>
                <!-- 批次内分类切换与批量操作工具栏 -->
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <!-- 左侧：三态过滤胶囊 (缺更 / 未识别待核查 / 全部) -->
                  <div class="flex items-center gap-1 bg-slate-200/60 dark:bg-slate-800 p-0.5 rounded-lg text-[11px] self-start sm:self-auto">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
                      :class="batch.tabFilter === 'missing'
                        ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-rose-400 font-bold shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                      @click="batch.tabFilter = 'missing'; batch.currentPage = 1"
                    >
                      仅看缺更 ({{ batch.missingShowsCount }})
                    </button>

                    <!-- 未识别待核查 Tab (重点突出) -->
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer flex items-center gap-1"
                      :class="batch.tabFilter === 'unidentified'
                        ? 'bg-white dark:bg-slate-700 text-amber-600 dark:text-amber-400 font-bold shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                      @click="batch.tabFilter = 'unidentified'; batch.currentPage = 1"
                    >
                      <span>未识别待核查</span>
                      <span
                        v-if="batch.unidentifiedShowsCount > 0"
                        class="px-1.5 py-0.1 text-[10px] rounded-full font-bold"
                        :class="batch.tabFilter === 'unidentified' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300' : 'bg-amber-50 text-amber-600 border border-amber-200'"
                      >
                        {{ batch.unidentifiedShowsCount }}
                      </span>
                      <span v-else class="text-[10px] text-slate-400">(0)</span>
                    </button>

                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer"
                      :class="batch.tabFilter === 'all'
                        ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 font-bold shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
                      @click="batch.tabFilter = 'all'; batch.currentPage = 1"
                    >
                      全部剧集 ({{ batch.totalShows }})
                    </button>
                  </div>

                  <!-- 右侧：批次操作按钮组 -->
                  <div class="flex items-center gap-2 self-end sm:self-auto flex-wrap">
                    <template v-if="batch.selectedShowKeys.size > 0">
                      <span class="text-indigo-600 dark:text-indigo-400 font-semibold text-xs">
                        已选 {{ batch.selectedShowKeys.size }} 部
                      </span>
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-md text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50/50 cursor-pointer flex items-center gap-1 shadow-2xs"
                        @click="handleBatchCopySelectedShows(batch)"
                      >
                        <Copy class="w-3.5 h-3.5 text-indigo-500" />
                        <span>复制选中</span>
                      </button>
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-md text-xs font-medium text-rose-600 dark:text-rose-400 bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-50 cursor-pointer flex items-center gap-1 shadow-2xs"
                        @click="openBatchDeleteModalForBatch(batch)"
                      >
                        <FolderX class="w-3.5 h-3.5 text-rose-500" />
                        <span>删除选中</span>
                      </button>
                      <button
                        type="button"
                        class="text-xs text-slate-500 hover:underline cursor-pointer"
                        @click="clearBatchSelectedShows(batch)"
                      >
                        取消
                      </button>
                    </template>
                    <template v-else>
                      <button
                        v-if="batch.missingShowsCount > 0"
                        type="button"
                        class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                        @click="copyBatchMissing(batch)"
                      >
                        <Copy class="w-3.5 h-3.5 text-slate-400" />
                        <span>复制全部缺更</span>
                      </button>
                      <button
                        v-if="batch.missingShowsCount > 0"
                        type="button"
                        class="px-2.5 py-1 rounded-md text-xs font-medium text-rose-600 dark:text-rose-400 bg-white dark:bg-slate-800 hover:bg-rose-50/60 border border-rose-200 dark:border-rose-900/60 flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                        @click="openBatchDeleteModalForBatch(batch)"
                      >
                        <FolderX class="w-3.5 h-3.5 text-rose-500" />
                        <span>一键清理缺集</span>
                      </button>
                    </template>
                  </div>
                </div>

                <!-- 熔断保护内联提示卡（替代 ElMessageBox.alert，呈现于批量清理入口下方，spec 5.2.1.3） -->
                <div v-if="batchBreakerNotice" class="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-xl flex items-start gap-2.5 mb-3">
                  <ShieldCheck class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div class="text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed flex-1">
                    {{ batchBreakerNotice }}
                  </div>
                  <button
                    type="button"
                    class="text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-200 cursor-pointer shrink-0"
                    title="知道了"
                    @click="batchBreakerNotice = ''"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>

                <!-- 一键清理缺集内联展开面板（替代 el-dialog，含连载剧熔断提示与已完结弃剧默认全选） -->
                <div v-if="batchDeletePanelOpen" class="inline-panel inline-panel--rose space-y-4 mb-3">
                  <div class="flex items-center justify-between">
                    <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                      <FolderX class="w-3.5 h-3.5 text-rose-500" />
                      <span>一键清理缺集资产（移入网盘回收站）</span>
                    </div>
                    <button
                      type="button"
                      class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                      title="收起"
                      @click="closeBatchDeletePanel"
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>

                  <!-- 安全提示 -->
                  <div class="space-y-2">
                    <div class="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-xl flex items-start gap-2.5">
                      <ShieldCheck class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <div class="text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">
                        <strong>🛡️ 连载剧安全熔断保护已生效：</strong>系统已自动彻底排除全部【连载中】剧集（连载缺更属于正常追更等待状态）。本次清理仅包含已完结但文件残缺的弃剧目标，确保在追剧集 100% 安全。
                      </div>
                    </div>

                    <div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-xl flex items-start gap-2.5">
                      <AlertTriangle class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                      <div class="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                        <strong>安全防护声明：</strong>所有选中的资产将被安全移入 <strong>139 移动云盘回收站</strong>，绝不物理粉碎。若后续需要找回，可随时登录 139 移动云盘在回收站中一键还原。
                      </div>
                    </div>
                  </div>

                  <!-- 清理模式选择 -->
                  <div class="space-y-2">
                    <label class="text-xs font-semibold text-slate-700 dark:text-slate-200">清理范围模式：</label>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div
                        class="p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5"
                        :class="batchDeleteMode === 'season'
                          ? 'border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20 ring-1 ring-indigo-500'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'"
                        @click="handleBatchModeChange('season')"
                      >
                        <input type="radio" :checked="batchDeleteMode === 'season'" class="mt-0.5" />
                        <div>
                          <div class="text-xs font-bold text-gray-900 dark:text-white">仅删除缺集季（推荐）</div>
                          <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            保留同剧其他已收全的完整季度，仅将存在缺更的季度目录移入回收站
                          </div>
                        </div>
                      </div>

                      <div
                        class="p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5"
                        :class="batchDeleteMode === 'entire'
                          ? 'border-rose-500 bg-rose-50/40 dark:bg-rose-950/20 ring-1 ring-rose-500'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'"
                        @click="handleBatchModeChange('entire')"
                      >
                        <input type="radio" :checked="batchDeleteMode === 'entire'" class="mt-0.5" />
                        <div>
                          <div class="text-xs font-bold text-gray-900 dark:text-white">删除整剧文件夹</div>
                          <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            将检测到缺集的所有剧集整部文件夹（包含该剧全部季度与文件）移入回收站
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 候选清单 -->
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="hover:underline text-indigo-600 dark:text-indigo-400 cursor-pointer font-medium"
                          @click="toggleSelectAllBatch"
                        >
                          {{ batchDeleteSelectedKeys.size === batchCandidates.length ? '取消全选' : '全选所有' }}
                        </button>
                        <span class="text-slate-400">|</span>
                        <span>待清理候选：已选 <strong class="text-rose-600 dark:text-rose-400 font-bold">{{ batchDeleteSelectedKeys.size }}</strong> / {{ batchCandidates.length }} 项</span>
                      </div>
                    </div>

                    <div class="max-h-60 overflow-y-auto space-y-1.5 pr-1 border border-slate-200 dark:border-slate-800 rounded-xl p-2 bg-slate-50/50 dark:bg-slate-900/50 custom-scrollbar">
                      <div
                        v-for="cand in batchCandidates"
                        :key="cand.key"
                        class="flex items-center justify-between p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-xs hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                      >
                        <label class="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <input
                            type="checkbox"
                            :checked="batchDeleteSelectedKeys.has(cand.key)"
                            class="rounded text-indigo-600"
                            @change="batchDeleteSelectedKeys.has(cand.key) ? batchDeleteSelectedKeys.delete(cand.key) : batchDeleteSelectedKeys.add(cand.key)"
                          />
                          <div class="min-w-0">
                            <div class="font-medium text-slate-800 dark:text-slate-200 truncate flex items-center gap-1.5">
                              <span>《{{ cand.showTitle }}》</span>
                              <span class="text-slate-400">{{ cand.seasonLabel }}</span>
                            </div>
                            <div class="text-[10px] text-slate-400 truncate max-w-sm">{{ cand.folderPath }}</div>
                          </div>
                        </label>
                        <span class="text-[11px] font-mono px-2 py-0.5 rounded bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400 shrink-0 ml-2">
                          {{ cand.missingRangesStr }}
                        </span>
                      </div>

                      <div v-if="batchCandidates.length === 0" class="p-6 text-center text-slate-400 text-xs">
                        🛡️ 系统已自动安全排除全部连载中剧集，当前暂无已完结的残缺剧集可清理
                      </div>
                    </div>
                  </div>

                  <!-- 面板 footer：原位总确认胶囊（替代 ElMessageBox.confirm 二段确认） -->
                  <div class="flex items-center justify-between gap-2.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                    <div class="text-[11px] text-slate-400">
                      移入回收站后即刻更新当前巡检统计（绝不物理粉碎，可随时还原）
                    </div>
                    <div class="flex items-center gap-2">
                      <div v-if="batchExecuteConfirm" class="confirm-pill-group">
                        <span class="confirm-pill__text">确认移入回收站 {{ batchDeleteSelectedKeys.size }} 项?</span>
                        <button type="button" class="confirm-pill__yes" @click="confirmBatchDelete">
                          确认
                        </button>
                        <button type="button" class="confirm-pill__no" @click="batchExecuteConfirm = false">
                          取消
                        </button>
                      </div>
                      <button
                        v-else
                        type="button"
                        class="px-4 py-1.5 text-xs rounded-lg font-medium text-white bg-rose-600 hover:bg-rose-700 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                        :disabled="isBatchDeleting || batchDeleteSelectedKeys.size === 0"
                        @click="confirmBatchDelete"
                      >
                        <RefreshCw v-if="isBatchDeleting" class="w-3.5 h-3.5 animate-spin" />
                        <FolderX v-else class="w-3.5 h-3.5" />
                        <span>{{ isBatchDeleting ? '正在移入回收站...' : `移入回收站 (${batchDeleteSelectedKeys.size})` }}</span>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- ─────────────────────────────────────────────────────────
                     状态 1: 未识别展示区 (防误判保护展示区，人工核查流)
                     ───────────────────────────────────────────────────────── -->
                <div v-if="batch.tabFilter === 'unidentified'" class="space-y-3">
                  <!-- 保护机制提示横幅 -->
                  <div class="p-3 rounded-xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/60 flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
                    <ShieldAlert class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div class="space-y-0.5">
                      <div class="font-bold flex items-center gap-1">
                        <span>🛡️ 智能防误判保护机制已生效</span>
                        <span class="text-[11px] font-normal text-amber-700 dark:text-amber-300">(坚决杜绝低置信度下的强行胡乱绑定与误判)</span>
                      </div>
                      <p class="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                        以下目录因片名置信度未达到自动绑定门槛（>=88分）或存在明确年份冲突（年份差>1年），系统已自动拦截并归入本区，未作强制推断。请进行人工核查或一键采纳推荐候选。
                      </p>
                    </div>
                  </div>

                  <!-- 未识别列表 -->
                  <div v-if="getBatchDisplayedShows(batch).length > 0" class="space-y-3">
                    <div
                      v-for="show in getBatchPaginatedShows(batch)"
                      :key="show.showKey"
                      class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-850/60 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all hover:border-amber-300 dark:hover:border-amber-800 shadow-2xs"
                    >
                      <!-- 左侧：原始目录信息、样本文件与拦截原因 -->
                      <div class="space-y-2 flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300 shrink-0">
                            待核查
                          </span>
                          <span class="font-bold text-sm text-slate-900 dark:text-white truncate">
                            {{ show.originalFolder || show.title }}
                          </span>
                        </div>

                        <div class="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                          📁 路径: {{ show.folderPath }}
                        </div>

                        <!-- 样本文件名展示 (帮用户秒懂真实内容) -->
                        <div v-if="show.sampleFiles && show.sampleFiles.length > 0" class="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-[11px] space-y-1">
                          <span class="text-slate-400 font-semibold flex items-center gap-1">
                            <ListVideo class="w-3.5 h-3.5 text-indigo-500" />
                            <span>目录内样本视频文件 (共 {{ show.totalLocalCount }} 个):</span>
                          </span>
                          <div class="font-mono text-slate-600 dark:text-slate-300 space-y-0.5 pl-2">
                            <div v-for="sf in show.sampleFiles.slice(0, 3)" :key="sf" class="truncate">
                              • {{ sf }}
                            </div>
                          </div>
                        </div>

                        <!-- 触发拦截原因说明 -->
                        <div v-if="show.unidentifiedReason" class="text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                          <AlertTriangle class="w-3 h-3 text-amber-500 shrink-0" />
                          <span>{{ show.unidentifiedReason }}</span>
                        </div>
                      </div>

                      <!-- 中间：推荐的 TMDB 候选 (如果有推荐候选) -->
                      <div v-if="show.suggestedCandidate" class="p-3 rounded-xl bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-950/60 flex items-center gap-3 w-full md:w-72 shrink-0 shadow-2xs">
                        <div class="w-12 h-16 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden shrink-0 flex items-center justify-center">
                          <img
                            v-if="show.suggestedCandidate.posterPath"
                            :src="`https://image.tmdb.org/t/p/w92${show.suggestedCandidate.posterPath}`"
                            class="w-full h-full object-cover"
                            alt="poster"
                          />
                          <Film v-else class="w-6 h-6 text-slate-400" />
                        </div>
                        <div class="space-y-1 min-w-0 flex-1">
                          <div class="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold uppercase">
                            AI 候选推荐 (得分: {{ (show.suggestedCandidate.score || 0).toFixed(0) }})
                          </div>
                          <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                            《{{ show.suggestedCandidate.title }}》
                          </div>
                          <div class="text-[11px] text-slate-400 font-mono">
                            首播: {{ show.suggestedCandidate.year || '未知' }}
                          </div>
                          <button
                            type="button"
                            class="mt-1 px-2 py-0.8 rounded text-[11px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors cursor-pointer flex items-center gap-1"
                            @click="handleAdoptCandidate(batch, show, show.suggestedCandidate)"
                          >
                            <Check class="w-3 h-3" />
                            <span>采纳此候选并复检</span>
                          </button>
                        </div>
                      </div>

                      <!-- 右侧：人工操作按钮组 -->
                      <div class="flex md:flex-col items-center justify-center gap-2 shrink-0">
                        <button
                          type="button"
                          class="px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors cursor-pointer flex items-center gap-1.5 shadow-2xs"
                          @click="openMatchTmdbModal(show)"
                        >
                          <Search class="w-3.5 h-3.5 text-indigo-500" />
                          <span>手动搜索 TMDB</span>
                        </button>
                        <button
                          type="button"
                          class="px-3 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                          @click="handleIgnoreUnidentifiedShow(batch, show)"
                        >
                          <EyeOff class="w-3 h-3 text-slate-400" />
                          <span>忽略此目录</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <!-- 未识别列表为空 -->
                  <div v-else class="p-8 text-center text-slate-400 space-y-2">
                    <CheckCircle2 class="w-8 h-8 mx-auto text-emerald-500" />
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium">该批次中所有剧集均已高置信锁定 TMDB，无待人工核查项！</p>
                  </div>
                </div>

                <!-- ─────────────────────────────────────────────────────────
                     状态 2: 缺更剧集 / 全部剧集表格展示
                     ───────────────────────────────────────────────────────── -->
                <div v-else class="space-y-3">
                  <div v-if="getBatchDisplayedShows(batch).length > 0" class="space-y-3">
                    <!-- 全选与勾选统计工具行（保留原表格 thead 全选能力） -->
                    <div class="flex items-center justify-between gap-2 px-1 text-xs text-slate-500 dark:text-slate-400">
                      <label class="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          class="rounded border-gray-300 text-indigo-600 cursor-pointer"
                          :checked="isAllBatchDisplayedShowsSelected(batch)"
                          @change="toggleSelectAllBatchDisplayedShows(batch)"
                        />
                        <span>全选本页剧集</span>
                      </label>
                      <span class="font-mono">已选 {{ batch.selectedShowKeys.size }} 部</span>
                    </div>

                    <!-- 剧集卡片网格（窄屏 1 列/中屏 2 列/宽屏 3 列，对齐频道监控规范 ChannelView:1091 card-grid） -->
                    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      <template v-for="show in getBatchPaginatedShows(batch)" :key="show.showKey">
                        <div class="flex flex-col gap-3">
                          <!-- 剧集卡片：勾选选中态高亮，整卡视觉对齐频道监控卡片规范 -->
                          <div
                            class="p-4 rounded-xl border bg-white dark:bg-slate-900 flex flex-col justify-between hover:shadow-sm transition-all"
                            :class="batch.selectedShowKeys.has(show.showKey)
                              ? 'border-indigo-400 dark:border-indigo-600 ring-1 ring-indigo-400/40'
                              : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'"
                          >
                            <!-- 卡片头部：勾选 + 海报 + 剧名 + 完结/连载状态胶囊 -->
                            <div class="flex items-start gap-2.5">
                              <input
                                type="checkbox"
                                class="rounded border-gray-300 text-indigo-600 cursor-pointer shrink-0 mt-1"
                                :checked="batch.selectedShowKeys.has(show.showKey)"
                                @change="toggleSelectBatchShow(batch, show.showKey)"
                              />
                              <div class="w-8 h-12 rounded bg-slate-100 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
                                <img
                                  v-if="show.posterPath"
                                  :src="`https://image.tmdb.org/t/p/w92${show.posterPath}`"
                                  class="w-full h-full object-cover"
                                  alt="poster"
                                />
                                <Tv v-else class="w-4 h-4 text-slate-400" />
                              </div>
                              <div class="space-y-0.5 min-w-0 flex-1">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                  <span class="font-bold text-xs text-slate-900 dark:text-white truncate">
                                    《{{ show.title }}》
                                  </span>
                                  <span v-if="show.isEnded" class="status-pill status-pill--success">
                                    已完结
                                  </span>
                                  <span v-else-if="isShowOngoing(show)" class="status-pill status-pill--info">
                                    连载中
                                  </span>
                                </div>
                                <div class="text-[11px] text-slate-400 font-mono flex items-center gap-1 flex-wrap">
                                  <span v-if="show.firstAirYear">{{ show.firstAirYear }}</span>
                                  <a
                                    v-if="show.tmdbId"
                                    :href="`https://www.themoviedb.org/tv/${show.tmdbId}`"
                                    target="_blank"
                                    class="text-indigo-500 hover:underline inline-flex items-center gap-0.5"
                                    @click.stop
                                  >
                                    tmdb:{{ show.tmdbId }}
                                    <ExternalLink class="w-2.5 h-2.5" />
                                  </a>
                                </div>
                              </div>
                            </div>

                            <!-- 网盘所在目录（mono 截断 + 悬停全文） -->
                            <div class="text-[11px] text-slate-600 dark:text-slate-300 font-mono select-all truncate mt-2.5" :title="show.folderPath">
                              {{ show.folderPath }}
                            </div>

                            <!-- 全剧收录进度 -->
                            <div class="space-y-1 mt-2.5">
                              <div class="flex items-center justify-between text-xs font-mono">
                                <span class="text-slate-700 dark:text-slate-200">
                                  {{ show.totalLocalCount }} / {{ show.totalTmdbCount }} 集
                                </span>
                                <span class="text-slate-400 font-bold">
                                  {{ show.totalTmdbCount > 0 ? Math.round((show.totalLocalCount / show.totalTmdbCount) * 100) : 0 }}%
                                </span>
                              </div>
                              <div class="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                                <div
                                  class="bg-blue-600 h-full rounded-full transition-all"
                                  :style="{ width: `${show.totalTmdbCount > 0 ? Math.min(100, Math.round((show.totalLocalCount / show.totalTmdbCount) * 100)) : 0}%` }"
                                ></div>
                              </div>
                            </div>

                            <!-- 缺集详情：分季缺集分布（完整保留原表格列信息） -->
                            <div class="space-y-1 mt-2.5">
                              <template v-for="s in getShowMissingSeasons(show)" :key="s.groupKey">
                                <div v-if="s.missingCount > 0" class="flex items-center gap-1.5 text-xs flex-wrap">
                                  <span class="text-slate-500 shrink-0 font-medium">{{ s.seasonLabel }}</span>
                                  <span class="font-bold text-rose-600 dark:text-rose-400 shrink-0">缺 {{ s.missingCount }} 集</span>
                                  <span class="font-mono text-[11px] text-slate-400 truncate" :title="s.missingRangesStr">
                                    [{{ s.shortRangesStr || s.missingRangesStr }}]
                                  </span>
                                </div>
                              </template>
                              <div v-if="getShowMissingSeasons(show).length === 0" class="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                <Check class="w-3.5 h-3.5" />
                                <span>全剧收录完整</span>
                              </div>
                            </div>
                            <!-- 卡片底栏操作区 -->
                            <div class="pt-2.5 mt-2.5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-2 flex-wrap">
                              <div class="flex items-center gap-1 flex-wrap">
                                  <button
                                    type="button"
                                    class="px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 shadow-2xs"
                                    :class="batch.expandedCompareKeys.has(show.showKey)
                                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold'
                                      : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50'"
                                    @click="toggleBatchCompareRow(batch, show)"
                                  >
                                    <component :is="batch.expandedCompareKeys.has(show.showKey) ? ChevronUp : ChevronDown" class="w-3 h-3 text-current" />
                                    <span>{{ batch.expandedCompareKeys.has(show.showKey) ? '收起' : '对照' }}</span>
                                  </button>
                                  <button
                                    type="button"
                                    class="px-2 py-0.5 rounded text-[11px] font-medium bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 cursor-pointer flex items-center gap-1 shadow-2xs"
                                    title="复制整部剧各季缺集清单与源文件核对信息"
                                    @click="copyShowDetailedReport(show)"
                                  >
                                    <Copy class="w-3 h-3 text-slate-400" />
                                    <span>复制</span>
                                  </button>
                                  <button
                                    type="button"
                                    class="px-2 py-0.5 rounded text-[11px] font-medium bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 cursor-pointer flex items-center gap-1 shadow-2xs"
                                    title="修正识别与 TMDB 匹配"
                                    @click="openMatchTmdbModal(show)"
                                  >
                                    <Sparkles class="w-3 h-3 text-slate-400" />
                                    <span>修正</span>
                                  </button>
                                </div>
                                <div class="flex items-center justify-center gap-1">
                                  <!-- 删除：原位确认胶囊（对齐频道监控规范 ChannelView:1192-1218 deletingChannelIndex 模式） -->
                                  <div v-if="!isShowOngoing(show) && deleteShowConfirmKey === show.showKey" class="confirm-pill-group">
                                    <span class="confirm-pill__text">确认删除整剧?</span>
                                    <button type="button" class="confirm-pill__yes" @click="handlePromptDeleteShow(show)">
                                      是
                                    </button>
                                    <button type="button" class="confirm-pill__no" @click="deleteShowConfirmKey = null">
                                      否
                                    </button>
                                  </div>
                                  <button
                                    v-else-if="!isShowOngoing(show)"
                                    type="button"
                                    class="px-2 py-0.5 rounded text-[11px] font-medium bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:text-rose-600 hover:bg-rose-50 cursor-pointer flex items-center gap-1 shadow-2xs"
                                    title="删除本缺集季或整剧文件夹 (移入139回收站)"
                                    @click="handlePromptDeleteShow(show)"
                                  >
                                    <FolderX class="w-3 h-3 text-slate-400 hover:text-rose-500" />
                                    <span>删除</span>
                                  </button>
                                  <!-- 移除：原位确认胶囊（仅从巡检清单移除，不影响网盘文件） -->
                                  <div v-if="removeShowConfirmKey === show.showKey" class="confirm-pill-group">
                                    <span class="confirm-pill__text">确认移除?</span>
                                    <button type="button" class="confirm-pill__yes" @click="handleRemoveShow(show)">
                                      是
                                    </button>
                                    <button type="button" class="confirm-pill__no" @click="removeShowConfirmKey = null">
                                      否
                                    </button>
                                  </div>
                                  <button
                                    v-else
                                    type="button"
                                    class="px-2 py-0.5 rounded text-[11px] font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded flex items-center gap-1 cursor-pointer"
                                    title="从本次巡检列表中移除此剧（不影响网盘文件）"
                                    @click="handleRemoveShow(show)"
                                  >
                                    <Trash2 class="w-3 h-3 text-slate-400" />
                                    <span>移除</span>
                                  </button>
                                </div>
                              </div>
                            </div>


                          <!-- 原位剧名校验区块：连载剧强制删除高危熔断（替代 ElMessageBox.prompt，spec 5.2.1.3） -->
                          <div v-if="ongoingVerifyTarget && ongoingVerifyTarget.showKey === show.showKey" class="p-3 sm:p-4 bg-rose-50/30 dark:bg-rose-950/10 rounded-xl border border-slate-200/80 dark:border-slate-800">
                              <div class="inline-panel inline-panel--danger space-y-3">
                                <div class="flex items-start gap-2.5">
                                  <AlertTriangle class="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                                  <div class="text-xs text-rose-800 dark:text-rose-200 leading-relaxed space-y-1">
                                    <div class="font-bold">
                                      ⚠️ 高危熔断拦截：连载中剧集保护
                                    </div>
                                    <div>
                                      {{ ongoingVerifyTarget.targetLabel }} 为【连载中】剧集，当前缺集属于正常追更等待状态！确认删除将导致已收录的
                                      {{ ongoingVerifyTarget.localCount }} 个分集文件移入网盘回收站，追更丢失！
                                    </div>
                                  </div>
                                </div>
                                <div class="space-y-1.5">
                                  <label class="block text-xs font-semibold text-rose-900 dark:text-rose-200">
                                    如您确认执意删除，请输入剧名「{{ ongoingVerifyTarget.title }}」确认：
                                  </label>
                                  <div class="flex gap-2">
                                    <input
                                      v-model="ongoingVerifyInput"
                                      type="text"
                                      class="input-base text-xs font-mono flex-1"
                                      :placeholder="`请输入完整剧名: ${ongoingVerifyTarget.title}`"
                                      @keyup.enter="submitOngoingVerify"
                                    />
                                    <button
                                      type="button"
                                      class="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 transition-colors cursor-pointer shrink-0"
                                      @click="submitOngoingVerify"
                                    >
                                      确认强制移入回收站
                                    </button>
                                    <button
                                      type="button"
                                      class="btn-default text-xs h-[34px] px-3 cursor-pointer shrink-0"
                                      @click="cancelOngoingVerify"
                                    >
                                      取消
                                    </button>
                                  </div>
                                  <p v-if="ongoingVerifyError" class="text-[11px] text-rose-600 dark:text-rose-400">
                                    输入的剧名不一致，请输入完整剧名「{{ ongoingVerifyTarget.title }}」以确认
                                  </p>
                                </div>
                              </div>
                          </div>

                          <!-- 原位 TMDB 修正检索面板（替代 el-dialog，对齐频道监控规范 ChannelView:1369-1435 inlineTmdbSearchOpen 模式） -->
                          <div v-if="matchTmdbPanelKey === show.showKey" class="p-3 sm:p-4 bg-slate-50/50 dark:bg-slate-900/40 rounded-xl border border-slate-200/80 dark:border-slate-800">
                              <div class="inline-panel inline-panel--indigo space-y-3">
                                <div class="flex items-center justify-between">
                                  <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-xs text-slate-400">当前识别：</span>
                                    <span class="font-bold text-gray-900 dark:text-white text-xs">《{{ matchTmdbForm.showTitle }}》</span>
                                    <span v-if="matchTmdbForm.currentTmdbId" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold">
                                      TMDB: {{ matchTmdbForm.currentTmdbId }}
                                    </span>
                                    <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400 font-medium">未关联</span>
                                    <span class="inline-block px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 font-medium text-[11px]">
                                      包含 {{ matchTmdbForm.seasonsCount }} 个季
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                                    title="收起修正面板"
                                    @click="closeMatchTmdbPanel"
                                  >
                                    <X class="w-4 h-4" />
                                  </button>
                                </div>

                                <div class="text-[11px] text-gray-400 font-mono truncate" :title="matchTmdbForm.folderPath">
                                  物理目录: {{ matchTmdbForm.folderPath }}
                                </div>

                                <!-- 搜剧快速匹配 -->
                                <div class="space-y-2">
                                  <label class="block text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                                    <Search class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                                    <span>搜剧快速匹配 (推荐)</span>
                                  </label>
                                  <div class="flex items-center gap-2">
                                    <input
                                      v-model="matchTmdbForm.searchQuery"
                                      type="text"
                                      class="input-base text-xs flex-1 min-w-0"
                                      placeholder="输入正确剧名，如：宇宙、三体、权力的游戏..."
                                      @keyup.enter="handleSearchTmdb"
                                    />
                                    <input
                                      v-model="matchTmdbForm.searchYear"
                                      type="text"
                                      class="input-base text-xs !w-20 shrink-0 font-mono text-center"
                                      placeholder="年份"
                                      title="首播年份（可选，如 2007）"
                                      @keyup.enter="handleSearchTmdb"
                                    />
                                    <button
                                      type="button"
                                      class="btn-primary text-xs h-[38px] px-4 font-medium cursor-pointer shrink-0 flex items-center gap-1.5"
                                      :disabled="matchTmdbSearching || !matchTmdbForm.searchQuery.trim()"
                                      @click="handleSearchTmdb"
                                    >
                                      <RefreshCw v-if="matchTmdbSearching" class="w-3.5 h-3.5 animate-spin" />
                                      <Search v-else class="w-3.5 h-3.5" />
                                      <span>{{ matchTmdbSearching ? '搜索中...' : '搜索' }}</span>
                                    </button>
                                  </div>

                                  <div v-if="matchTmdbSearching" class="py-6 text-center text-slate-400 text-xs bg-slate-50/50 dark:bg-slate-800/30 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                                    <RefreshCw class="w-4 h-4 animate-spin text-indigo-500 mx-auto mb-1.5" />
                                    正在连接 TMDB 影视官方数据库检索候选...
                                  </div>

                                  <div v-else-if="matchTmdbCandidates.length > 0" class="max-h-56 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                                    <div
                                      v-for="cand in matchTmdbCandidates"
                                      :key="cand.id"
                                      class="p-2.5 rounded-xl border transition-all flex items-start gap-3 bg-white dark:bg-slate-900 hover:border-indigo-400 dark:hover:border-indigo-600"
                                      :class="String(cand.id) === String(matchTmdbForm.selectedTmdbId)
                                        ? 'border-indigo-500 ring-1 ring-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20'
                                        : 'border-slate-200 dark:border-slate-800'"
                                    >
                                      <div class="w-12 h-16 rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
                                        <img
                                          v-if="cand.posterPath"
                                          :src="cand.posterPath"
                                          :alt="cand.title || cand.name"
                                          class="w-full h-full object-cover"
                                          loading="lazy"
                                        />
                                        <Film v-else class="w-5 h-5 text-slate-400" />
                                      </div>
                                      <div class="flex-1 min-w-0 space-y-1">
                                        <div class="flex items-center gap-1.5 flex-wrap">
                                          <span class="font-bold text-xs text-gray-900 dark:text-white">
                                            {{ cand.title || cand.name || cand.chineseTitle }}
                                          </span>
                                          <span v-if="cand.year" class="text-[10px] font-mono px-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                            {{ cand.year }}
                                          </span>
                                          <span class="text-[10px] px-1 rounded font-mono bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                                            ID: {{ cand.id }}
                                          </span>
                                        </div>
                                        <div class="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
                                          {{ cand.overview || '暂无官方剧情简介' }}
                                        </div>
                                      </div>
                                      <div class="shrink-0 flex items-center pt-1">
                                        <button
                                          type="button"
                                          class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50 shadow-xs"
                                          :disabled="matchTmdbLoading"
                                          @click="handleSelectCandidate(cand)"
                                        >
                                          <Check class="w-3.5 h-3.5" />
                                          <span>选用此剧</span>
                                        </button>
                                      </div>
                                    </div>
                                  </div>

                                  <div v-else class="py-4 text-center text-slate-400 text-xs border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                                    暂无候选结果，可尝试简化片名，或使用下方手动录入 TMDB ID
                                  </div>
                                </div>

                                <!-- 手动指定 TMDB ID -->
                                <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 space-y-2">
                                  <div class="flex items-center justify-between">
                                    <span class="text-xs font-medium text-slate-700 dark:text-slate-300">或者手动指定 TMDB ID：</span>
                                    <a
                                      href="https://www.themoviedb.org"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      class="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5"
                                    >
                                      <span>前往 themoviedb.org 查剧</span>
                                      <ExternalLink class="w-3 h-3" />
                                    </a>
                                  </div>
                                  <div class="flex items-center gap-2">
                                    <input
                                      v-model="matchTmdbForm.selectedTmdbId"
                                      type="text"
                                      class="input-base text-xs font-mono flex-1"
                                      placeholder="例如: 4454 (宇宙) 或 1399 (权力的游戏)"
                                      @keyup.enter="handleSaveMatchTmdb()"
                                    />
                                    <button
                                      type="button"
                                      class="btn-default text-xs h-[38px] px-3 cursor-pointer shrink-0"
                                      :disabled="matchTmdbLoading || !matchTmdbForm.selectedTmdbId"
                                      @click="handleSaveMatchTmdb()"
                                    >
                                      确认此 ID
                                    </button>
                                  </div>
                                </div>

                                <!-- 生效范围开关 -->
                                <div class="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
                                  <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-700 dark:text-slate-300">
                                    <input
                                      v-model="matchTmdbForm.applyToAllSeasons"
                                      type="checkbox"
                                      class="rounded text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                                    />
                                    <span class="font-medium">应用至该目录下的所有季度 (共 {{ matchTmdbForm.seasonsCount }} 季，推荐)</span>
                                  </label>
                                  <span v-if="!matchTmdbForm.applyToAllSeasons" class="text-[11px] text-amber-600">
                                    当前仅修正 第 {{ matchTmdbForm.activeSeason }} 季
                                  </span>
                                </div>

                                <div class="flex items-center justify-between gap-2.5 pt-1">
                                  <div class="text-[11px] text-slate-400">
                                    保存后系统将自动重新校验并刷新缺集列表
                                  </div>
                                  <button
                                    type="button"
                                    class="btn-primary text-xs h-8 px-3.5 font-medium cursor-pointer flex items-center gap-1.5"
                                    :disabled="matchTmdbLoading || !matchTmdbForm.selectedTmdbId"
                                    @click="handleSaveMatchTmdb()"
                                  >
                                    <RefreshCw v-if="matchTmdbLoading" class="w-3.5 h-3.5 animate-spin" />
                                    <span>{{ matchTmdbLoading ? '正在重新比对...' : '确认保存并重新比对' }}</span>
                                  </button>
                                </div>
                              </div>
                          </div>

                          <!-- 原位多季剧删除范围选择面板（替代 el-dialog） -->
                          <div v-if="singleDeletePanelKey === show.showKey && singleDeleteTargetShow" class="p-3 sm:p-4 bg-slate-50/50 dark:bg-slate-900/40 rounded-xl border border-slate-200/80 dark:border-slate-800">
                              <div class="inline-panel inline-panel--rose space-y-3">
                                <div class="flex items-center justify-between">
                                  <div class="text-xs font-bold text-gray-900 dark:text-white">
                                    删除剧集资产: 《{{ singleDeleteTargetShow.title }}》
                                  </div>
                                  <button
                                    type="button"
                                    class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                                    title="收起"
                                    @click="closeSingleDeletePanel"
                                  >
                                    <X class="w-4 h-4" />
                                  </button>
                                </div>

                                <div v-if="isShowOngoing(singleDeleteTargetShow)" class="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-xl flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200 leading-relaxed font-medium">
                                  <AlertTriangle class="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                                  <div>
                                    <strong>⚠️ 高危连载剧警示：</strong>《{{ singleDeleteTargetShow.title }}》为【连载中】剧集，当前缺更属于正常追更等待状态。若确认删除，网盘内已收录的 {{ singleDeleteTargetShow.totalLocalCount }} 个分集文件将被移入回收站导致追更丢失！
                                  </div>
                                </div>

                                <div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-xl text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                                  该剧在网盘中包含 <strong>{{ getVisibleSeasons(singleDeleteTargetShow).length }}</strong> 个季度，请选择本次删除的范围（将安全移入 139 网盘回收站）：
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                  <div
                                    class="p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5"
                                    :class="singleDeleteMode === 'season'
                                      ? 'border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20 ring-1 ring-indigo-500'
                                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'"
                                    @click="singleDeleteMode = 'season'"
                                  >
                                    <input type="radio" :checked="singleDeleteMode === 'season'" class="mt-0.5" />
                                    <div>
                                      <div class="text-xs font-bold text-gray-900 dark:text-white">
                                        仅删除当前季（{{ getActiveSeason(singleDeleteTargetShow).seasonLabel }}）
                                      </div>
                                      <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                        仅将当前季目录移入回收站，保留该剧的其他季度
                                      </div>
                                    </div>
                                  </div>

                                  <div
                                    class="p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5"
                                    :class="singleDeleteMode === 'entire'
                                      ? 'border-rose-500 bg-rose-50/40 dark:bg-rose-950/20 ring-1 ring-rose-500'
                                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'"
                                    @click="singleDeleteMode = 'entire'"
                                  >
                                    <input type="radio" :checked="singleDeleteMode === 'entire'" class="mt-0.5" />
                                    <div>
                                      <div class="text-xs font-bold text-gray-900 dark:text-white">
                                        删除整部剧文件夹
                                      </div>
                                      <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                        将整部剧的根目录（含全部季度与文件）整体移入回收站
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div class="flex items-center justify-between gap-2.5">
                                  <div class="text-[11px] text-slate-400">
                                    📁 网盘路径：{{ singleDeleteTargetShow.folderPath }}
                                  </div>
                                  <button
                                    type="button"
                                    class="px-4 py-1.5 text-xs rounded-lg font-medium text-white bg-rose-600 hover:bg-rose-700 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                                    :disabled="isSingleDeleting"
                                    @click="confirmSingleDelete"
                                  >
                                    <RefreshCw v-if="isSingleDeleting" class="w-3.5 h-3.5 animate-spin" />
                                    <FolderX v-else class="w-3.5 h-3.5" />
                                    <span>{{ isSingleDeleting ? '正在移入回收站...' : '确认移入回收站' }}</span>
                                  </button>
                                </div>
                              </div>
                          </div>

                          <!-- 分季分集明细对照抽屉 (Inline Drawer) -->
                          <div v-if="batch.expandedCompareKeys.has(show.showKey)" class="p-3 sm:p-4 bg-slate-50/50 dark:bg-slate-900/40 rounded-xl border border-slate-200/80 dark:border-slate-800">
                              <div class="space-y-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 sm:p-4 shadow-xs">
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-100 dark:border-slate-800">
                                  <div class="flex items-center gap-2 flex-wrap min-w-0">
                                    <span class="font-bold text-xs text-slate-900 dark:text-white">
                                      《{{ show.title }}》 {{ getBatchActiveSeason(batch, show).seasonLabel }}
                                    </span>
                                    <span v-if="show.firstAirYear" class="text-[11px] text-slate-400">({{ show.firstAirYear }})</span>
                                    <div v-if="getVisibleSeasons(show).length > 1" class="flex items-center gap-1 ml-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/60 dark:border-slate-700/60">
                                      <button
                                        v-for="s in getVisibleSeasons(show)"
                                        :key="s.groupKey"
                                        type="button"
                                        class="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all cursor-pointer"
                                        :class="getBatchActiveSeason(batch, show).groupKey === s.groupKey
                                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-bold shadow-2xs'
                                          : 'text-slate-500 hover:text-slate-800'"
                                        @click="setBatchActiveSeason(batch, show.showKey, s.season)"
                                      >
                                        {{ s.seasonLabel }}
                                        <span v-if="s.missingCount > 0" class="text-rose-600 dark:text-rose-400 font-semibold ml-0.5">({{ s.missingCount }}缺)</span>
                                      </button>
                                    </div>
                                  </div>

                                  <div class="flex items-center gap-2 flex-wrap justify-between sm:justify-end">
                                    <div class="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg text-[11px] border border-slate-200/80 dark:border-slate-700">
                                      <button
                                        type="button"
                                        class="px-2.5 py-0.5 rounded-md font-medium transition-all cursor-pointer"
                                        :class="getCompareFilter(getBatchActiveSeason(batch, show)) === 'all'
                                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-bold shadow-2xs'
                                          : 'text-slate-500 hover:text-slate-800'"
                                        @click="compareEpisodeFilter[getBatchActiveSeason(batch, show).groupKey] = 'all'"
                                      >
                                        全部 ({{ getBatchActiveSeason(batch, show).tmdbCount || (getBatchActiveSeason(batch, show).localCount + getBatchActiveSeason(batch, show).missingCount) }})
                                      </button>
                                      <button
                                        type="button"
                                        class="px-2.5 py-0.5 rounded-md font-medium transition-all cursor-pointer"
                                        :class="getCompareFilter(getBatchActiveSeason(batch, show)) === 'missing'
                                          ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-rose-400 font-bold shadow-2xs'
                                          : 'text-slate-500 hover:text-slate-800'"
                                        @click="compareEpisodeFilter[getBatchActiveSeason(batch, show).groupKey] = 'missing'"
                                      >
                                        仅缺集 ({{ getBatchActiveSeason(batch, show).missingCount }})
                                      </button>
                                      <button
                                        v-if="getSeasonHarmonizedCount(getBatchActiveSeason(batch, show)) > 0"
                                        type="button"
                                        class="px-2.5 py-0.5 rounded-md font-medium transition-all cursor-pointer"
                                        :class="getCompareFilter(getBatchActiveSeason(batch, show)) === 'harmonized'
                                          ? 'bg-white dark:bg-slate-700 text-purple-600 dark:text-purple-400 font-bold shadow-2xs'
                                          : 'text-slate-500 hover:text-slate-800'"
                                        @click="compareEpisodeFilter[getBatchActiveSeason(batch, show).groupKey] = 'harmonized'"
                                      >
                                        曾被和谐 ({{ getSeasonHarmonizedCount(getBatchActiveSeason(batch, show)) }})
                                      </button>
                                      <button
                                        type="button"
                                        class="px-2.5 py-0.5 rounded-md font-medium transition-all cursor-pointer"
                                        :class="getCompareFilter(getBatchActiveSeason(batch, show)) === 'collected'
                                          ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-emerald-400 font-bold shadow-2xs'
                                          : 'text-slate-500 hover:text-slate-800'"
                                        @click="compareEpisodeFilter[getBatchActiveSeason(batch, show).groupKey] = 'collected'"
                                      >
                                        已收齐 ({{ getBatchActiveSeason(batch, show).localCount }})
                                      </button>
                                    </div>

                                    <button
                                      type="button"
                                      class="px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
                                      :disabled="Boolean(isRecheckingShow[show.showKey || show.folderPath || show.title])"
                                      title="重新核验该剧集网盘视频文件并即时刷新状态"
                                      @click="handleRecheckShowForBatch(batch, show)"
                                    >
                                      <RefreshCw
                                        class="w-3.5 h-3.5 text-slate-500"
                                        :class="{ 'animate-spin': isRecheckingShow[show.showKey || show.folderPath || show.title] }"
                                      />
                                      <span>{{ isRecheckingShow[show.showKey || show.folderPath || show.title] ? '复检中' : '复检' }}</span>
                                    </button>

                                    <button
                                      type="button"
                                      class="px-2 py-1 rounded-lg text-xs text-slate-500 hover:text-slate-800 transition-colors cursor-pointer flex items-center gap-0.5"
                                      title="收起对照面板"
                                      @click="toggleBatchCompareRow(batch, show)"
                                    >
                                      <ChevronUp class="w-3.5 h-3.5" />
                                      <span>收起</span>
                                    </button>
                                  </div>
                                </div>

                                <!-- 未匹配源文件告警提示 -->
                                <div
                                  v-if="getUnmatchedFiles(getBatchActiveSeason(batch, show)).length > 0"
                                  class="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300"
                                >
                                  <AlertTriangle class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                  <div class="space-y-1 min-w-0">
                                    <div class="font-bold">⚠️ 发现 {{ getUnmatchedFiles(getBatchActiveSeason(batch, show)).length }} 个未匹配到集号的源文件（请核对命名）：</div>
                                    <div class="font-mono text-[11px] space-y-0.5">
                                      <div v-for="uf in getUnmatchedFiles(getBatchActiveSeason(batch, show))" :key="uf.fileId || uf.name" class="truncate">
                                        • {{ uf.name }} ({{ uf.sizeFormatted }})
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <!-- 极简扁平化分集对齐列表 -->
                                <div class="space-y-1 max-h-[380px] overflow-y-auto pr-1 custom-scrollbar">
                                  <div
                                    v-for="item in getSeasonMergedEpisodes(getBatchActiveSeason(batch, show), getCompareFilter(getBatchActiveSeason(batch, show)))"
                                    :key="item.epNum"
                                    class="py-1.5 px-2.5 rounded-lg transition-colors flex items-center justify-between gap-2 text-xs"
                                    :class="item.isMissing
                                      ? 'bg-rose-50/40 dark:bg-rose-950/20 text-slate-700 dark:text-slate-300'
                                      : 'bg-slate-50/40 dark:bg-slate-800/30 text-slate-700 dark:text-slate-300 hover:bg-slate-100/60 dark:hover:bg-slate-800/60'"
                                  >
                                    <div class="flex items-center gap-2 min-w-0">
                                      <span
                                        class="font-mono text-xs font-bold px-1.5 py-0.5 rounded shrink-0"
                                        :class="item.isMissing ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300' : 'bg-slate-200/80 text-slate-700 dark:bg-slate-700 dark:text-slate-300'"
                                      >
                                        {{ item.tag }}
                                      </span>
                                      <span class="font-medium truncate text-slate-800 dark:text-slate-200">
                                        {{ item.name }}
                                      </span>
                                      <span v-if="item.airDate" class="text-[10px] text-slate-400 font-mono shrink-0 hidden sm:inline">
                                        {{ item.airDate }}
                                      </span>
                                    </div>

                                    <div class="flex items-center gap-2 shrink-0">
                                      <template v-if="!item.isMissing && item.matchedFiles.length > 0">
                                        <span
                                          class="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[200px] sm:max-w-xs md:max-w-md hidden md:inline"
                                          :title="item.matchedFiles[0].name"
                                        >
                                          {{ item.matchedFiles[0].name }}
                                        </span>
                                        <span class="text-[10px] font-mono text-slate-400 shrink-0 hidden sm:inline">
                                          {{ item.matchedFiles[0].sizeFormatted }}
                                        </span>
                                        <span v-if="item.matchedFiles.length > 1" class="text-[10px] font-mono text-blue-600 bg-blue-50 px-1 rounded shrink-0">
                                          +{{ item.matchedFiles.length - 1 }}副本
                                        </span>
                                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60 shrink-0">
                                          已收录
                                        </span>
                                      </template>

                                      <template v-else-if="!item.isMissing">
                                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60 shrink-0">
                                          已收录
                                        </span>
                                      </template>

                                      <template v-else>
                                        <span
                                          v-if="item.tombstone"
                                          class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border border-purple-200/60 dark:border-purple-800/60 shrink-0"
                                        >
                                          曾被和谐
                                        </span>
                                        <span
                                          v-else
                                          class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200/60 dark:border-rose-800/60 shrink-0"
                                        >
                                          缺失
                                        </span>
                                      </template>
                                    </div>
                                  </div>
                                </div>
                              </div>
                          </div>
                        </div>
                      </template>
                    </div>

                    <!-- 分页控制栏 (Pagination Toolbar for Batch) -->
                    <div
                      v-if="getBatchDisplayedShows(batch).length > 0"
                      class="p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-gray-800 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs"
                    >
                      <div class="text-slate-500 dark:text-slate-400">
                        显示第 <strong class="text-slate-800 dark:text-slate-100 font-semibold">{{ ((batch.currentPage || 1) - 1) * (batch.pageSize || 15) + 1 }}</strong> 至 <strong class="text-slate-800 dark:text-slate-100 font-semibold">{{ Math.min((batch.currentPage || 1) * (batch.pageSize || 15), getBatchDisplayedShows(batch).length) }}</strong> 部，共 <strong class="text-slate-800 dark:text-slate-100 font-semibold">{{ getBatchDisplayedShows(batch).length }}</strong> 部剧集
                      </div>

                      <div class="flex items-center gap-2">
                        <el-pagination
                          v-model:current-page="batch.currentPage"
                          v-model:page-size="batch.pageSize"
                          :page-sizes="[10, 15, 30, 50]"
                          :total="getBatchDisplayedShows(batch).length"
                          layout="sizes, prev, pager, next"
                          size="small"
                          background
                        />
                      </div>
                    </div>
                  </div>

                  <!-- 空状态：该分类下无剧集 -->
                  <div v-else class="p-8 text-center text-slate-400 space-y-2">
                    <CheckCircle2 class="w-8 h-8 mx-auto text-emerald-500" />
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium">太棒了！该批次在此分类下未发现任何缺更剧集。</p>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- 初始空状态：暂无巡检批次 -->
        <div
          v-else-if="!isMissingScanning"
          class="p-12 text-center text-slate-400 space-y-3 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl my-4"
        >
          <Tv class="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <h4 class="text-sm font-bold text-gray-800 dark:text-gray-200">
            暂无剧集缺集巡检批次记录
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            在上方确认剧集目录后，点击「开始扫描缺集」启动断集巡检。系统将采用置信度阶梯判定，扫描一次记录一次，结果支持独立展开核验。
          </p>
        </div>
      </div>
    </div>


    <!-- ─────────────────────────────────────────────────────────────
         Tab 3: 巡检与清理记录 (统一流水与审计中心)
         ───────────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'records'" class="space-y-6">
      <div class="settings-card">
        <!-- 头部标题说明与刷新清空按钮 -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white">云盘巡检维护流水与审计记录</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              统一持久化汇总违规死链巡检、剧集缺更检测、安全隔离处置与空目录修剪的执行快照与历史流水
            </p>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium text-xs py-2 px-3 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
              :disabled="isLoadingJobs"
              @click="loadMaintenanceJobs"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoadingJobs }" />
              <span>刷新流水</span>
            </button>
            <!-- 清空流水：两段式原位确认（对齐频道监控规范 ChannelView:1338-1355 clearingCardsConfirm 模式） -->
            <div v-if="maintenanceJobs.length > 0" class="flex items-center gap-1.5">
              <div v-if="clearRecordsConfirm" class="confirm-pill-group">
                <span class="confirm-pill__text">确认清空全部流水? 此操作无法撤销</span>
                <button type="button" class="confirm-pill__yes" @click="handleClearAllMaintenanceJobs">
                  确定清空
                </button>
                <button type="button" class="confirm-pill__no" @click="clearRecordsConfirm = false">
                  取消
                </button>
              </div>
              <button
                v-else
                type="button"
                class="bg-slate-100 dark:bg-slate-800 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 text-slate-600 dark:text-slate-300 font-medium text-xs py-2 px-3 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                @click="handleClearAllMaintenanceJobs"
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>清空流水</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 顶部 4 维统计看板 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 my-4">
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">累计执行维护任务</span>
            <div class="text-lg font-bold text-gray-800 dark:text-gray-100 mt-1">{{ maintenanceJobs.length }} 次</div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">已处置违规文件</span>
            <div class="text-lg font-bold text-red-500 mt-1">{{ totalCleanedBannedCount }} 项</div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">已安全修剪空目录</span>
            <div class="text-lg font-bold text-emerald-500 mt-1">{{ totalCleanedEmptyCount }} 个</div>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <span class="text-[11px] text-gray-500 dark:text-gray-400">累计检出缺更剧集</span>
            <div class="text-lg font-bold text-indigo-500 mt-1">{{ totalMissingShowsCount }} 部</div>
          </div>
        </div>

        <!-- 快速过滤标签胶囊栏（实心彩色激活改为白色凸起胶囊，对齐频道监控规范 ChannelView:1603-1636 过滤胶囊组） -->
        <div class="list-toolbar__filters">
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'all' }"
            @click="activeRecordsFilter = 'all'"
          >
            全部流水 ({{ maintenanceJobs.length }})
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'banned_scan' }"
            @click="activeRecordsFilter = 'banned_scan'"
          >
            违规巡检
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'banned_clean' }"
            @click="activeRecordsFilter = 'banned_clean'"
          >
            违规处置
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'missing_scan' }"
            @click="activeRecordsFilter = 'missing_scan'"
          >
            剧集缺更
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'empty_prune' }"
            @click="activeRecordsFilter = 'empty_prune'"
          >
            空目录修剪
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ 'tab-pill--active': activeRecordsFilter === 'cron' }"
            @click="activeRecordsFilter = 'cron'"
          >
            仅定时任务
          </button>
        </div>

        <!-- 任务卡片流 (对照图二设计：一任务一卡片，含标题、定时/手动徽章、时间、状态徽章、摘要、查看详情展开) -->
        <div v-if="filteredMaintenanceJobs.length > 0" class="space-y-3 mt-4">
          <div
            v-for="job in filteredMaintenanceJobs"
            :key="job.id"
            class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 space-y-3 shadow-xs hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
          >
            <!-- 头部：标题、触发方式、执行时间、状态徽章、操作按钮 -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-100 dark:border-slate-800">
              <div class="flex items-center gap-2 flex-wrap">
                <!-- 触发方式徽章 -->
                <span
                  class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider"
                  :class="job.triggerType === 'cron' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'"
                >
                  {{ job.triggerType === 'cron' ? '定时任务' : '手动触发' }}
                </span>

                <!-- 任务类型小徽章 -->
                <span
                  class="px-2 py-0.5 rounded text-[10px] font-semibold"
                  :class="{
                    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300': job.type === 'banned_scan' || job.type === 'banned_clean',
                    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300': job.type === 'missing_scan',
                    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300': job.type === 'empty_prune'
                  }"
                >
                  {{
                    job.type === 'banned_scan' ? '违规巡检'
                    : job.type === 'banned_clean' ? '违规处置'
                    : job.type === 'missing_scan' ? '缺更巡检'
                    : '空目录修剪'
                  }}
                </span>

                <!-- 任务标题 -->
                <span class="text-xs font-bold text-gray-900 dark:text-white">
                  {{ job.title }}
                </span>

                <!-- 执行时间 -->
                <span class="text-[11px] text-gray-400 font-mono">
                  {{ job.timeFormatted }}
                </span>
              </div>

              <div class="flex items-center gap-3">
                <!-- 状态徽章 -->
                <span
                  class="px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1"
                  :class="{
                    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300': job.status === 'completed',
                    'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300': job.status === 'cleaned',
                    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': job.status === 'running',
                    'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300': job.status === 'failed',
                  }"
                >
                  <span v-if="job.status === 'running'" class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                  <span>
                    {{
                      job.status === 'completed'
                        ? '已完成'
                        : job.status === 'cleaned'
                        ? '已处置'
                        : job.status === 'running'
                        ? '执行中'
                        : '失败'
                    }}
                  </span>
                </span>

                <!-- 查看详情按钮 -->
                <button
                  type="button"
                  class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium flex items-center gap-1 cursor-pointer"
                  @click="toggleViewJobDetail(job)"
                >
                  <component :is="expandedJobId === job.id ? ChevronDown : ChevronRight" class="w-3.5 h-3.5" />
                  <span>{{ expandedJobId === job.id ? '收起详情' : '查看详情' }}</span>
                </button>
              </div>
            </div>

            <!-- 中部：执行摘要与目标目录 -->
            <div class="text-xs text-gray-600 dark:text-gray-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span>{{ job.summary }}</span>
                <span class="text-gray-400 text-[11px] font-mono">耗时 {{ job.durationMs }}ms</span>
              </div>

              <div v-if="job.folderPath" class="flex items-center gap-1 text-[11px] font-mono text-gray-400 shrink-0">
                <FolderTree class="w-3 h-3 text-slate-400" />
                <span>目标: {{ job.folderPath }}</span>
              </div>
            </div>

            <!-- 展开详情面板 -->
            <div
              v-if="expandedJobId === job.id"
              class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3"
            >
              <div v-if="isLoadingJobDetail" class="py-4 text-center text-xs text-gray-400 flex items-center justify-center gap-2">
                <RefreshCw class="w-3.5 h-3.5 animate-spin" />
                <span>正在读取记录详情与快照数据...</span>
              </div>

              <div v-else-if="expandedJobDetail" class="space-y-3">
                <!-- 1. 违规巡检检出清单快照 -->
                <div v-if="job.type === 'banned_scan' && expandedJobDetail.findings && expandedJobDetail.findings.length > 0" class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
                      <AlertTriangle class="w-3.5 h-3.5" />
                      <span>检出违规文件快照 (共 {{ expandedJobDetail.findings.length }} 项)</span>
                    </div>

                    <!-- 一键载入至违规待处置区 -->
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                      @click="loadJobFindingsIntoInspection(expandedJobDetail)"
                    >
                      <Play class="w-3 h-3" />
                      <span>载入至违规待处置区</span>
                    </button>
                  </div>

                  <!-- 快照紧凑行卡片（对齐频道监控规范 ChannelView:1488 行卡片形态；rose 主题浅底保留，字段完整） -->
                  <div class="max-h-60 overflow-y-auto space-y-1.5 p-2 border border-rose-200/60 dark:border-rose-900/40 rounded-lg bg-rose-50/20 dark:bg-rose-950/10">
                    <div
                      v-for="f in expandedJobDetail.findings"
                      :key="f.id"
                      class="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-rose-100/60 dark:border-rose-900/30 hover:bg-rose-50/40 dark:hover:bg-rose-900/20 transition-colors font-mono text-[11px]"
                    >
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium text-gray-900 dark:text-white break-all max-w-xs">{{ f.name }}</span>
                        <span class="text-rose-600 dark:text-rose-400 whitespace-nowrap">{{ f.reason }}</span>
                        <span class="ml-auto whitespace-nowrap text-gray-600 dark:text-gray-300">{{ f.sizeFormatted }}</span>
                      </div>
                      <div class="text-gray-500 dark:text-gray-400 break-all mt-0.5 max-w-sm">
                        {{ f.path || '/' }}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 2. 剧集缺更检出清单快照 -->
                <div v-if="job.type === 'missing_scan' && expandedJobDetail.findings && expandedJobDetail.findings.length > 0" class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                      <Tv class="w-3.5 h-3.5" />
                      <span>检出缺更剧集快照 (共 {{ expandedJobDetail.findings.length }} 个季度)</span>
                    </div>

                    <!-- 一键载入至剧集缺更主视图 -->
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                      @click="loadMissingJobFindingsIntoInspection(expandedJobDetail)"
                    >
                      <Play class="w-3 h-3" />
                      <span>载入至缺更主视图</span>
                    </button>
                  </div>

                  <!-- 缺更紧凑行卡片（对齐频道监控规范 ChannelView:1488 行卡片形态；indigo 主题浅底保留，字段完整） -->
                  <div class="max-h-60 overflow-y-auto space-y-1.5 p-2 border border-indigo-200/60 dark:border-indigo-900/40 rounded-lg bg-indigo-50/20 dark:bg-indigo-950/10">
                    <div
                      v-for="(m, idx) in expandedJobDetail.findings"
                      :key="idx"
                      class="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-indigo-100/60 dark:border-indigo-900/30 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/20 transition-colors font-mono text-[11px]"
                    >
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium text-gray-900 dark:text-white break-all max-w-xs">《{{ m.title }}》</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 font-bold">
                          {{ m.seasonLabel || `第 ${m.season} 季` }}
                        </span>
                        <span class="whitespace-nowrap text-gray-600 dark:text-gray-300">{{ m.localCount }} / {{ m.tmdbCount || (m.localCount + m.missingCount) }} 集</span>
                        <span class="ml-auto whitespace-nowrap text-rose-600 dark:text-rose-400 font-bold">
                          {{ m.missingCount > 0 ? `缺 ${m.missingCount} 集 (${m.missingRangesStr})` : '已收齐' }}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 3. 违规清理或修剪详情日志 -->
                <div v-if="expandedJobDetail.cleanedDetails && expandedJobDetail.cleanedDetails.length > 0" class="space-y-1.5">
                  <div class="text-xs font-semibold text-gray-700 dark:text-gray-300">处置明细项清单 (共 {{ expandedJobDetail.cleanedDetails.length }} 条)</div>
                  <div class="max-h-56 overflow-y-auto p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg space-y-1 font-mono text-[11px] text-gray-600 dark:text-gray-400">
                    <div
                      v-for="(item, idx) in expandedJobDetail.cleanedDetails"
                      :key="idx"
                      class="flex items-start gap-1.5 break-all py-0.5 border-b border-slate-100 dark:border-slate-800 last:border-b-0"
                    >
                      <span class="text-gray-400 select-none shrink-0">#{{ idx + 1 }}</span>
                      <span>{{ item }}</span>
                    </div>
                  </div>
                </div>

                <!-- 错误信息 -->
                <div v-if="expandedJobDetail.error" class="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 rounded-lg text-xs text-rose-700 dark:text-rose-300 font-mono break-all">
                  异常详情: {{ expandedJobDetail.error }}
                </div>

                <!-- 扫描巡检无异常（健康状态） -->
                <div v-if="(job.type === 'banned_scan' || job.type === 'missing_scan') && (!expandedJobDetail.findings || expandedJobDetail.findings.length === 0)" class="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-lg text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 class="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{{ job.type === 'banned_scan' ? '此轮巡检未发现任何违规占位或死链文件，状态完全健康。' : '此轮剧集巡检全部完整收齐，未发现任何缺更分集。' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="p-12 text-center text-gray-400">
          <History class="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <h4 class="text-sm font-semibold text-gray-800 dark:text-gray-200">暂无维护流水记录</h4>
          <p class="text-xs text-gray-400 mt-1">
            在违规死链巡检、剧集缺集检测中发起扫描，或系统定时 Cron 触发后，所有执行进度与快照均将自动持久化保存在此
          </p>
        </div>



        <!-- 底部归档：永久忽略白名单档案库区域 (仅网盘清理模式下显示) -->
        <div v-if="!isMissingRoute" class="mt-6 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <EyeOff class="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">永久忽略白名单档案库 (共 {{ ignoredBannedItems.length }} 项)</h4>
              <span class="text-[11px] text-gray-400">加入白名单的文件在后续巡检中将自动跳过检测，防误报</span>
            </div>
            <button
              v-if="ignoredBannedItems.length > 0"
              type="button"
              class="text-[11px] text-slate-500 hover:text-red-600 dark:hover:text-red-400 flex items-center gap-1 cursor-pointer"
              @click="clearAllIgnoreList"
            >
              <Trash2 class="w-3 h-3" />
              <span>清空白名单</span>
            </button>
          </div>

          <!-- 白名单行卡片列表（amber 主题 + 底栏移除操作 + 原位确认，对齐频道监控规范 ChannelView:1488 行卡片形态） -->
          <div v-if="ignoredBannedItems.length > 0" class="space-y-2">
            <div
              v-for="item in ignoredBannedItems"
              :key="item.id"
              class="p-3 rounded-xl border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/20 dark:bg-amber-950/10 hover:shadow-xs transition-all"
            >
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs font-bold text-gray-900 dark:text-white break-all max-w-xs flex-1 min-w-0">
                  {{ item.name }}
                </span>
                <span class="status-pill status-pill--danger">
                  {{ item.reason }}
                </span>
                <span class="text-[11px] text-gray-400 font-mono whitespace-nowrap shrink-0">
                  {{ item.timeFormatted }}
                </span>
              </div>
              <div class="flex items-center justify-between gap-2 mt-1.5">
                <div class="text-[11px] text-gray-500 dark:text-gray-400 break-all max-w-sm font-mono">
                  {{ item.path }}
                </div>
                <!-- 原位移除确认胶囊 -->
                <div v-if="removeIgnoreConfirmKey === item.id" class="confirm-pill-group shrink-0">
                  <span class="confirm-pill__text">确认移出白名单?</span>
                  <button type="button" class="confirm-pill__yes" @click="removeFromIgnoreList(item.id)">
                    是
                  </button>
                  <button type="button" class="confirm-pill__no" @click="removeIgnoreConfirmKey = null">
                    否
                  </button>
                </div>
                <button
                  v-else
                  type="button"
                  class="px-2 py-0.5 rounded text-[11px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 hover:underline cursor-pointer shrink-0"
                  @click="removeIgnoreConfirmKey = item.id"
                >
                  移出白名单
                </button>
              </div>
            </div>
          </div>

          <div v-else class="p-4 text-center text-gray-400 text-xs bg-slate-50/50 dark:bg-slate-900/20 rounded-xl border border-dashed border-gray-200 dark:border-gray-800">
            暂无白名单记录。若扫描结果中有被误判为违规的特殊媒体或保留文件，可在扫描列表中点击「忽略」加入白名单。
          </div>
        </div>
      </div>
    </div>

    <!-- ─────────────────────────────────────────────────────────────
         Tab 4: 自动维护与计划调度
         ───────────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'schedule'" class="space-y-6">
      <div class="settings-card">
        <div class="flex items-center justify-between pb-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white">
              {{ isMissingRoute ? 'TMDB 剧集缺更自动化巡检调度' : '139 云盘违规清理与维护调度' }}
            </h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {{ isMissingRoute
                ? '为媒体库剧集缺更排查设定自动化 Cron 定时轮询，自动定位断集并通过通知渠道即时提醒'
                : '为违规死链巡检与空目录修剪设定自动化 Cron 定时轮询与柔性隔离处置'
              }}
            </p>
          </div>

          <button
            type="button"
            class="btn-primary flex items-center gap-2 text-xs py-2 px-4"
            :disabled="isSavingSchedule"
            @click="handleSaveSchedule"
          >
            <Save class="w-3.5 h-3.5" />
            <span>{{ isSavingSchedule ? '保存中...' : (isMissingRoute ? '保存缺更计划' : '保存维护计划') }}</span>
          </button>
        </div>

        <div class="space-y-6 pt-4">
          <!-- 1. 违规文件定时巡检 (仅在网盘清理模式下显示) -->
          <div v-if="!isMissingRoute" class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-slate-50/50 dark:bg-slate-900/40 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <ShieldAlert class="w-4 h-4 text-red-500" />
                <span class="text-xs font-bold text-gray-900 dark:text-white">违规失效死链定时巡检</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input v-model="scheduleForm.enableBannedScanCron" type="checkbox" class="sr-only peer" />
                <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div v-if="scheduleForm.enableBannedScanCron" class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div class="space-y-1">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">Cron 调度表达式</label>
                <input
                  v-model="scheduleForm.bannedScanCron"
                  type="text"
                  class="w-full px-3 py-1.5 bg-white dark:bg-slate-900 border border-gray-300 dark:border-gray-700 rounded-lg text-xs font-mono"
                  placeholder="0 3 * * 0"
                />
                <span class="text-[11px] text-gray-400">默认每周日凌晨 03:00 自动执行一次</span>
              </div>

              <div class="space-y-1 flex flex-col justify-center">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">巡检后自动移入回收站</label>
                <label class="flex items-center gap-2 cursor-pointer mt-1">
                  <input
                    v-model="scheduleForm.autoCleanBanned"
                    type="checkbox"
                    class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span class="text-xs text-gray-600 dark:text-gray-400">发现违规死链后自动移入回收站，无需人工二次确认</span>
                </label>
              </div>
            </div>
          </div>

          <!-- 2. 剧集缺更定时安全巡检 (仅在缺更检测模式下显示) -->
          <div v-if="isMissingRoute" class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-slate-50/50 dark:bg-slate-900/40 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Tv class="w-4 h-4 text-indigo-500" />
                <span class="text-xs font-bold text-gray-900 dark:text-white">剧集缺更定时巡检</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input v-model="scheduleForm.enableMissingScanCron" type="checkbox" class="sr-only peer" />
                <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div v-if="scheduleForm.enableMissingScanCron" class="space-y-2 pt-2">
              <div class="space-y-1">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">Cron 调度表达式</label>
                <input
                  v-model="scheduleForm.missingScanCron"
                  type="text"
                  class="w-full sm:w-80 px-3 py-1.5 bg-white dark:bg-slate-900 border border-gray-300 dark:border-gray-700 rounded-lg text-xs font-mono"
                  placeholder="0 6 * * *"
                />
                <span class="text-[11px] text-gray-400 block">默认每天早上 06:00 自动执行一次；若发现剧集缺更将自动通过多渠道推送提醒</span>
              </div>
            </div>
          </div>

          <!-- 3. 通知推送开关 -->
          <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
            <div class="space-y-0.5">
              <span class="text-xs font-bold text-gray-900 dark:text-white">
                {{ isMissingRoute ? '缺更巡检完成推送提醒' : '巡检与维护完成推送提醒' }}
              </span>
              <p class="text-[11px] text-gray-500 dark:text-gray-400">
                {{ isMissingRoute
                  ? '定时任务执行完毕并发现缺更剧集或断集时，通过系统配置的 Telegram、企业微信、Bark 等渠道推送详细报告'
                  : '定时任务执行完毕并产生清理或发现异常时，通过系统配置的 Telegram、企业微信、Bark 等渠道推送详细报告'
                }}
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input v-model="scheduleForm.notifyOnMaintenance" type="checkbox" class="sr-only peer" />
              <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>
    </div>
    <!-- 目录树懒加载选择弹窗 -->
    <!-- 目录树懒加载选择弹窗 -->
    <FolderTreeSelector
      v-model="isFolderPickerVisible"
      :account-id="activeAccountId"
      title="选择网盘扫描与维护范围"
      @select="onFolderSelected"
    />
  </div>
</template>

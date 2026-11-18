<script setup lang="ts">
import axios from 'axios';
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useOrganizeStore } from '../stores/organize';
import {
  tmdbOrganizeApi,
  type OrganizeGroup,
  type OrganizeTask,
  type OrganizeSummary,
  type OrganizeHistoryRecord
} from '../api/tmdbOrganize';
import {
  channelApi,
  type ChannelGlobalConfig,
} from '../api/channel';
import { accountApi, type AccountItem } from '../api/account';
import FolderTreeSelector from '../components/FolderTreeSelector.vue';
import AccountSwitcher from '../components/AccountSwitcher.vue';
import type { AccountSwitcherItem } from '../components/accountSwitcher';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Sparkles,
  RotateCw,
  RotateCcw,
  Activity,
  Undo2,
  Film,
  Tv,
  CheckCircle2,
  AlertTriangle,
  Folder,
  FolderSearch,
  FolderCheck,
  HardDrive,
  Trash2,
  Search,
  Eye,
  Database,
  Filter,
  Check,
  X,
  Layers,
  Clock,
  Play,
  Plus,
  SlidersHorizontal,
  ArrowRight,
  FolderOpen,
  HelpCircle,
  Sliders,
  FileCode,
  Bell,
  ArrowUp,
  ArrowDown,
  Info,
  AlertCircle,
  Tag,
  Radio,
  Clapperboard,
  ShieldCheck,
  Shield,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  ExternalLink,
  Copy,
  FileVideo,
  Hash,
  Calendar,
  Bot,
  ChevronUp,
  Pencil,
} from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();

// ================= 主视口 Tab 切换 (媒体整理配置 vs 手动整理沙箱 vs 整理流水看板 vs 洗版策略 vs 洗版历史) =================
const activeMainTab = ref<'organize' | 'manual' | 'wash' | 'wash_history' | 'history'>('organize');
const isWashRoute = computed(() => route.path === '/wash');

// ================= 基础状态 =================
const loading = ref(false);
const savingStrategy = ref(false);
const organizingNow = ref(false);
const accounts = ref<AccountItem[]>([]);
const selectedAccountId = ref<number | string>('');
const accountSwitcherItems = computed<AccountSwitcherItem[]>(() => {
  return accounts.value.map((a: AccountItem) => ({
    id: a.id,
    accountName: a.alias || a.username,
    username: a.username,
    phone: a.username,
    isDefault: a.isDefault,
    isActive: a.isActive !== false && a.memberStatus !== 'auth_failed'
  }));
});

const currentSelectedAccount = computed(() => {
  return accounts.value.find((a: AccountItem) => String(a.id) === String(selectedAccountId.value)) || null;
});

function handleAccountSwitch(acc: AccountSwitcherItem) {
  selectedAccountId.value = acc.id;
  strategyConfig.value.accountId = acc.id;
  try {
    localStorage.setItem('cloudpan_preferred_account_id_v1', String(acc.id));
  } catch (_) {}
  ElMessage.success({
    message: `已切换当前操作账号为: [${acc.accountName || acc.username || acc.id}]`,
    grouping: true
  });
}
const accountsLoaded = ref(false);
const hasActiveAccount = computed(() => accounts.value.some((a: AccountItem) => a.isActive !== false && a.memberStatus !== 'auth_failed' && a.memberStatusText !== '认证失效'));

function checkAccountGuard(actionName = '此操作'): boolean {
  // 检查是否存在已正常在线授权的有效账号
  if (!hasActiveAccount.value) {
    const hasAnyAccount = accounts.value.length > 0;
    const alertMsg = hasAnyAccount
      ? `当前 139 移动云盘账号凭证已失效，执行「${actionName}」已被安全拦截。是否立即前往重新扫码登录？`
      : `执行「${actionName}」需要已正常登录的 139 移动云盘账号。当前尚未绑定任何账号，是否立即前往扫码绑定？`;

    ElMessageBox.confirm(
      alertMsg,
      hasAnyAccount ? '云盘登录授权已失效' : '需要云盘登录凭证',
      {
        confirmButtonText: '前往扫码登录',
        cancelButtonText: '暂不前往',
        type: 'warning',
      }
    ).then(() => {
      router.push('/accounts');
    }).catch(() => {});
    return false;
  }
  return true;
}

// ================= 1. 媒体整理与洗版全局策略状态 =================
const strategyConfig = ref<ChannelGlobalConfig>({
  enabled: true,
  channels: [],
  stagingFolderId: '',
  stagingFolderName: '',
  defaultTargetFolderId: '',
  defaultTargetFolderName: '',
  dispatchRules: [],
  whitelistRegex: '',
  blacklistKeywords: [],
  visualCards: [],
  scanInterval: 5,
  organizeInterval: 30,
  organizeCron: '*/30 * * * *',
  videoExtensions: ['mp4', 'mkv', 'avi', 'mov', 'rmvb', 'wmv', 'ts'],
  metadataExtensions: ['ass', 'srt', 'ssa', 'sub', 'vtt'],
  enableRename: true,
  enableMediaInfo: true,
  includeEpisodeTitle: true,
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
    'videoFormat',
    'dynamicRange',
    'resourceType',
    'releaseGroup',
    'colorDepth',
    'audioCodec',
    'frameRate',
    'fileSize'
  ],
  keepDolbyMultiVersion: false,
  notifyOnOrganize: true,
  linkStrm: false,
  notifyOnStrm: false,
  excludeNonVideo: false,
  excludeNoChineseSubtitle: false,
  excludeTrailersAndSamples: false,
});

const excludeStrategyExpanded = ref(false);

// 洗版优先级项元数据
const washPriorityMeta: Record<string, { label: string; desc: string }> = {
  releaseGroup: { label: '发布组优先级', desc: '优先保留指定压制发布组（如 HiveWeb, ADWeb 等）' },
  resourceType: { label: '资源类型规格', desc: 'Remux > BluRay > BDRip > WEB-DL > WEBRip > HDTV > DVD' },
  videoFormat: { label: '分辨率画质', desc: '8K > 4K (2160p) > 2K (1440p) > 1080p > 720p > 480p' },
  dynamicRange: { label: '动态范围规格', desc: 'DV+HDR > DV (杜比视界) > HDR10+ > HDR10/HDR > HLG > SDR' },
  colorDepth: { label: '色彩深度', desc: '12bit > 10bit > 8bit' },
  audioCodec: { label: '音频编码规格', desc: 'TrueHD Atmos > DTS:X > TrueHD > DDP Atmos > DTS-HD MA > LPCM > FLAC > DDP > AAC' },
  frameRate: { label: '帧率等级', desc: '120fps > 60fps > 50fps > 30fps > 25fps > 24fps' },
  fileSize: { label: '文件体积大小', desc: '同等技术规格下大文件优先（码率更高/画质更佳）' },
};

async function moveWashPriority(index: number, direction: 'up' | 'down') {
  if (!strategyConfig.value.washPriorityOrder) return;
  const list = [...strategyConfig.value.washPriorityOrder];
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= list.length) return;
  const temp = list[index];
  list[index] = list[targetIndex];
  list[targetIndex] = temp;
  strategyConfig.value.washPriorityOrder = list;
  try {
    await channelApi.saveGlobalConfig({
      washPriorityOrder: list
    });
    ElMessage.success({
      message: `已生效并保存洗版优先级: 【${washPriorityMeta[temp]?.label || temp}】${direction === 'up' ? '上移' : '下移'}至第 ${targetIndex + 1} 位`,
      grouping: true
    });
  } catch (err: any) {
    ElMessage.error(`保存洗版优先级失败: ${err.message || '网络异常'}`);
  }
}

async function resetWashPriorityDefault() {
  const defaultOrder = [
    'videoFormat',
    'dynamicRange',
    'resourceType',
    'releaseGroup',
    'colorDepth',
    'audioCodec',
    'frameRate',
    'fileSize'
  ];
  strategyConfig.value.washPriorityOrder = [...defaultOrder];
  try {
    await channelApi.saveGlobalConfig({
      washPriorityOrder: defaultOrder
    });
    ElMessage.success({
      message: '已恢复默认推荐画质优先级序列并保存',
      grouping: true
    });
  } catch (err: any) {
    ElMessage.error(`恢复默认序列失败: ${err.message || '网络异常'}`);
  }
}

// ================= 洗版流水记录状态与计算属性 (Wash History) =================
const washActiveFilter = ref<'all' | 'upgrade' | 'protect' | 'exempt' | 'reverted' | 'skipped'>('all');
const washSearchQuery = ref('');
const washSelectedIds = ref<Set<number>>(new Set());

// 识别是否属于洗版相关记录
function isWashRecord(record: any): boolean {
  if (!record) return false;
  const reason = (record.reason || '').toLowerCase();
  const oldName = (record.oldName || '').toLowerCase();
  const newName = (record.newName || '').toLowerCase();
  let evidenceStr = '';
  if (record.evidence) {
    evidenceStr = (typeof record.evidence === 'string' ? record.evidence : JSON.stringify(record.evidence)).toLowerCase();
  }
  const fullText = `${reason} ${oldName} ${newName} ${evidenceStr}`;

  // 职责隔离铁律：若仅仅是未匹配到 TMDB 的原地保护，严禁归入洗版流水！
  if (reason.includes('未匹配到') || reason.includes('未匹配') || (record.status === 'protected' && !reason.includes('画质') && !reason.includes('更优') && !reason.includes('降级'))) {
    return false;
  }

  return (
    fullText.includes('洗版') ||
    fullText.includes('置换') ||
    (fullText.includes('画质') && (fullText.includes('更优') || fullText.includes('已有更高') || fullText.includes('比对'))) ||
    fullText.includes('劣汰') ||
    fullText.includes('淘汰') ||
    (fullText.includes('豁免') && fullText.includes('杜比')) ||
    fullText.includes('多版本洗版') ||
    fullText.includes('同名清理') ||
    fullText.includes('已有更高画质') ||
    fullText.includes('逆向降级保护') ||
    fullText.includes('washaction')
  );
}

// 解析洗版动作判定与详细说明
function parseWashAction(record: any) {
  const reason = record.reason || '';
  let evidenceObj: any = null;
  if (record.evidence) {
    try {
      evidenceObj = typeof record.evidence === 'string' ? JSON.parse(record.evidence) : record.evidence;
    } catch (_) {}
  }
  const washAction = evidenceObj?.washAction || record.washAction || '';
  const isUpgrade = record.status === 'applied' && (reason.includes('洗版') || reason.includes('置换') || reason.includes('回收站') || reason.includes('更优') || washAction.includes('洗版'));
  const isProtect = (reason.includes('更高画质') || reason.includes('降级') || reason.includes('逆向')) && !reason.includes('未匹配到');
  const isExempt = reason.includes('杜比') && (reason.includes('豁免') || reason.includes('并存') || reason.includes('双版本'));
  const isReverted = record.status === 'reverted';
  const isSkipped = record.status === 'skipped' || reason.includes('淘汰') || reason.includes('同名清理');
  const isFailed = record.status === 'failed';

  let type: 'upgrade' | 'protect' | 'exempt' | 'reverted' | 'skipped' | 'failed' = 'upgrade';
  let badgeTop = '洗版';
  let badgeBottom = '置换';
  let badgeClass = 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300';
  let actionTitle = '【洗版置换】新版本画质更优，旧版本移入 139 回收站';
  let nodeClass = 'bg-emerald-500';

  if (isReverted) {
    type = 'reverted';
    badgeTop = '已撤销';
    badgeBottom = '回滚';
    badgeClass = 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400';
    actionTitle = record.reason || '【已撤销】已通过原路撤回恢复至原路径';
    nodeClass = 'bg-slate-400';
  } else if (isSkipped) {
    type = 'skipped';
    badgeTop = '洗版';
    badgeBottom = '淘汰';
    badgeClass = 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300';
    actionTitle = record.reason || '【洗版淘汰】同批次已保留最佳画质版本，次选版本淘汰移入回收站';
    nodeClass = 'bg-rose-400';
  } else if (isFailed) {
    type = 'failed';
    badgeTop = '失败';
    badgeBottom = '异常';
    badgeClass = 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300';
    actionTitle = record.error || record.reason || '【执行失败】网盘接口或文件处理异常';
    nodeClass = 'bg-red-500';
  } else if (isExempt) {
    type = 'exempt';
    badgeTop = '杜比';
    badgeBottom = '豁免';
    badgeClass = 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300';
    actionTitle = '【多版本豁免】检测到杜比视界版本与非杜比版本，豁免淘汰，双版本在媒体库并存！';
    nodeClass = 'bg-purple-500';
  } else if (isProtect) {
    type = 'protect';
    badgeTop = '降级';
    badgeBottom = '保护';
    badgeClass = 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300';
    actionTitle = reason || '【逆向降级保护】媒体库已有更高画质版本，新入库版本跳过并保护现有资产！';
    nodeClass = 'bg-blue-500';
  } else if (washAction) {
    actionTitle = washAction;
  } else if (reason) {
    actionTitle = reason;
  }

  return {
    type,
    badgeTop,
    badgeBottom,
    badgeClass,
    actionTitle,
    nodeClass
  };
}

// 提取媒体文件名与推文上下文中的权威技术规格标签
function extractTechnicalSpecs(filename: string, fileSize: number = 0, fullContext: string = '') {
  const clean = (String(filename || '') + ' ' + String(fullContext || '')).toUpperCase();
  const specs = {
    resolution: '',
    resRank: 0,
    dynamicRange: '',
    drRank: 0,
    frameRate: '',
    fpsRank: 0,
    colorDepth: '',
    cdRank: 0,
    resourceType: '',
    resTypeRank: 0,
    videoCodec: '',
    audioCodec: '',
    audioRank: 0,
    size: Number(fileSize || 0)
  };

  // 1. 分辨率 (8K > 4K/2160p > 2K/1440p > 1080p > 720p > 576p > 480p)
  if (/4320P|(?:^|[^a-zA-Z0-9])8K(?:$|[^a-zA-Z0-9])/i.test(clean)) { specs.resolution = '8K'; specs.resRank = 7; }
  else if (/2160[PI]|(?:^|[^a-zA-Z0-9])4K(?:$|[^a-zA-Z0-9])|UHD|3840s*[X*×]s*2160/i.test(clean)) { specs.resolution = '2160p'; specs.resRank = 6; }
  else if (/1440[PI]|(?:^|[^a-zA-Z0-9])2K(?:$|[^a-zA-Z0-9])/i.test(clean)) { specs.resolution = '1440p'; specs.resRank = 5; }
  else if (/1080[PI]|FHD|1920s*[X*×]s*1080/i.test(clean)) { specs.resolution = '1080p'; specs.resRank = 4; }
  else if (/720[PI]|1280s*[X*×]s*720/i.test(clean)) { specs.resolution = '720p'; specs.resRank = 3; }
  else if (/576[PI]/i.test(clean)) { specs.resolution = '576p'; specs.resRank = 2; }
  else if (/480[PI]|SD/i.test(clean)) { specs.resolution = '480p'; specs.resRank = 1; }

  // 2. 动态范围与杜比 (DV+HDR > DV > HDR10+ > HDR > HLG > SDR)
  if (/(?:DV|DOVI)|DOLBY[s._-]?VISION/i.test(clean) && /HDR10+|HDR/i.test(clean)) { specs.dynamicRange = '杜比视界+HDR'; specs.drRank = 6; }
  else if (/(?:DV|DOVI)|DOLBY[s._-]?VISION/i.test(clean)) { specs.dynamicRange = '杜比视界'; specs.drRank = 5; }
  else if (/HDR10+/i.test(clean)) { specs.dynamicRange = 'HDR10+'; specs.drRank = 4; }
  else if (/HDR10|HDR/i.test(clean)) { specs.dynamicRange = 'HDR'; specs.drRank = 3; }
  else if (/HLG/i.test(clean)) { specs.dynamicRange = 'HLG'; specs.drRank = 2; }
  else if (/SDR/i.test(clean)) { specs.dynamicRange = 'SDR'; specs.drRank = 1; }

  // 3. 帧率 (120fps > 60fps > 50fps > 30fps > 25fps > 24fps)
  const fpsMatch = clean.match(/\b(120|60|59\.94|50|30|25|24)[\s._-]?(?:FPS|帧)\b/i) || clean.match(/\b(120|60|50|30|25|24)FPS\b/i);
  if (fpsMatch) {
    const num = parseFloat(fpsMatch[1]);
    if (num >= 119) { specs.frameRate = '120fps'; specs.fpsRank = 6; }
    else if (num >= 59) { specs.frameRate = '60fps'; specs.fpsRank = 5; }
    else if (num >= 49) { specs.frameRate = '50fps'; specs.fpsRank = 4; }
    else if (num >= 29) { specs.frameRate = '30fps'; specs.fpsRank = 3; }
    else if (num >= 24.5) { specs.frameRate = '25fps'; specs.fpsRank = 2; }
    else if (num >= 23) { specs.frameRate = '24fps'; specs.fpsRank = 1; }
  }

  // 4. 色彩位深 (12bit > 10bit > 8bit)
  if (/12[\s._-]?BIT/i.test(clean)) { specs.colorDepth = '12bit'; specs.cdRank = 3; }
  else if (/10[\s._-]?BIT/i.test(clean)) { specs.colorDepth = '10bit'; specs.cdRank = 2; }
  else if (/8[\s._-]?BIT/i.test(clean)) { specs.colorDepth = '8bit'; specs.cdRank = 1; }

  // 5. 压制介质与来源 (REMUX > BluRay > BDRip > WEB-DL > WEBRip > HDTV > DVD)
  if (/REMUX/i.test(clean)) { specs.resourceType = 'REMUX'; specs.resTypeRank = 7; }
  else if (/BLU[- .]?RAY|\bBD\b|原盘/i.test(clean)) { specs.resourceType = 'BluRay'; specs.resTypeRank = 6; }
  else if (/BDRIP/i.test(clean)) { specs.resourceType = 'BDRip'; specs.resTypeRank = 5; }
  else if (/WEB[- .]?DL/i.test(clean)) { specs.resourceType = 'WEB-DL'; specs.resTypeRank = 4; }
  else if (/WEBRIP/i.test(clean)) { specs.resourceType = 'WEBRip'; specs.resTypeRank = 3; }
  else if (/HDTV/i.test(clean)) { specs.resourceType = 'HDTV'; specs.resTypeRank = 2; }
  else if (/DVD/i.test(clean)) { specs.resourceType = 'DVD'; specs.resTypeRank = 1; }

  // 6. 视频编码
  if (/HEVC|H\.?265|X265/i.test(clean)) specs.videoCodec = 'H.265';
  else if (/AVC|H\.?264|X264/i.test(clean)) specs.videoCodec = 'H.264';
  else if (/AV1/i.test(clean)) specs.videoCodec = 'AV1';
  else if (/VC-?1/i.test(clean)) specs.videoCodec = 'VC-1';
  else if (/MPEG-?2/i.test(clean)) specs.videoCodec = 'MPEG-2';

  // 7. 音频规格
  const hasAtmos = /\bATMOS\b/i.test(clean);
  const audioChannel = clean.match(/(?:MA|DTS|PCM|TRUEHD|DDP|EAC3|AAC|\b)(7\.1|5\.1|5\.0|2\.0)\b/)?.[1] || '';
  if (/TRUEHD/i.test(clean)) {
    specs.audioCodec = hasAtmos ? (audioChannel ? 'TrueHD Atmos ' + audioChannel : 'TrueHD Atmos') : 'TrueHD';
    specs.audioRank = hasAtmos ? 11 : 9;
  } else if (/DTS[\s._-]?(?:X\b|:X)/i.test(clean)) {
    specs.audioCodec = audioChannel ? 'DTS:X ' + audioChannel : 'DTS:X';
    specs.audioRank = 10;
  } else if (/DDP|EAC3|E-AC-3|DD\+/i.test(clean)) {
    specs.audioCodec = hasAtmos ? (audioChannel ? 'DDP Atmos ' + audioChannel : 'DDP Atmos') : (audioChannel ? 'DDP ' + audioChannel : 'DDP 5.1');
    specs.audioRank = hasAtmos ? 8 : 4;
  } else if (/DTS-HD/i.test(clean)) {
    specs.audioCodec = audioChannel ? 'DTS-HD MA ' + audioChannel : 'DTS-HD MA';
    specs.audioRank = 7;
  } else if (/LPCM|PCM|FLAC/i.test(clean)) {
    specs.audioCodec = audioChannel ? '无损音频 ' + audioChannel : '无损音频';
    specs.audioRank = 6;
  } else if (/DTS/i.test(clean)) {
    specs.audioCodec = audioChannel ? 'DTS ' + audioChannel : 'DTS 5.1';
    specs.audioRank = 3;
  } else if (/DD[\s._-]?5\.1|AC3/i.test(clean)) {
    specs.audioCodec = 'DD 5.1';
    specs.audioRank = 2;
  } else if (/AAC/i.test(clean)) {
    specs.audioCodec = audioChannel ? 'AAC ' + audioChannel : 'AAC 2.0';
    specs.audioRank = 1;
  }

  return specs;
}

// 深度解析洗版对比详情 (进场新版 vs 媒体库旧版规格矩阵对比看板)
function normalizeWashSpecs(raw: any, fallbackName: string = '', fallbackSize: number = 0, fullContext: string = '') {
  const fallback: any = (fallbackName ? extractTechnicalSpecs(fallbackName, fallbackSize, fullContext) : null) || {};
  const base = raw || fallback;
  const resolution = base.resolution || base.videoFormat || fallback.resolution || '';
  const resRank = Number(base.resRank || base.resolutionRank || fallback.resRank || 0);
  const dynamicRange = base.dynamicRange || base.hdr || fallback.dynamicRange || 'SDR';
  const getDrRank = (dr: string) => {
    const clean = String(dr || '').toUpperCase();
    if (clean.includes('DV+HDR') || clean.includes('DOVI+HDR')) return 6;
    if (clean.includes('DV') || clean.includes('DOVI') || clean.includes('DOLBY')) return 5;
    if (clean.includes('HDR10+')) return 4;
    if (clean.includes('HDR10') || clean.includes('HDR')) return 3;
    if (clean.includes('HLG')) return 2;
    return 1;
  };
  const drRank = Number(base.drRank || getDrRank(dynamicRange));
  const frameRate = base.frameRate || fallback.frameRate || '';
  const fpsRank = Number(base.fpsRank || base.frameRateRank || fallback.fpsRank || 0);
  const colorDepth = base.colorDepth || fallback.colorDepth || '';
  const cdRank = Number(base.cdRank || (colorDepth.includes('12') ? 3 : (colorDepth.includes('10') ? 2 : (colorDepth.includes('8') ? 1 : 0))));
  const resourceType = base.resourceType || base.mediaSource || fallback.resourceType || '';
  const resTypeRank = Number(base.resTypeRank || (base.isRemux ? 7 : (base.isBluRay ? 6 : (resourceType === 'WEB-DL' ? 4 : 3))));
  const videoCodec = base.videoCodec || base.codec || fallback.videoCodec || '';
  const getVcRank = (vc: string) => {
    const clean = String(vc || '').toUpperCase();
    if (clean.includes('AV1')) return 4;
    if (clean.includes('H.265') || clean.includes('H265') || clean.includes('HEVC') || clean.includes('X265')) return 3;
    if (clean.includes('H.264') || clean.includes('H264') || clean.includes('AVC') || clean.includes('X264')) return 2;
    if (clean.includes('VC-1') || clean.includes('VC1')) return 2;
    if (clean.includes('MPEG')) return 1;
    return 0;
  };
  const vcRank = Number(base.vcRank || getVcRank(videoCodec));
  const audioCodec = base.audioCodec || fallback.audioCodec || '';
  const audioRank = Number(base.audioRank || fallback.audioRank || 0);
  const size = Number(base.size || fallbackSize || 0);

  return {
    resolution,
    resRank,
    dynamicRange,
    drRank,
    frameRate,
    fpsRank,
    colorDepth,
    cdRank,
    resourceType,
    resTypeRank,
    videoCodec,
    vcRank,
    audioCodec,
    audioRank,
    size
  };
}

function parseWashComparison(record: any) {
  const reason = record.reason || '';
  let evidenceObj: any = null;
  if (record.evidence) {
    try {
      evidenceObj = typeof record.evidence === 'string' ? JSON.parse(record.evidence) : record.evidence;
    } catch (_) {}
  }
  const washDetails = record.washDetails || evidenceObj?.washDetails || null;

  const isUpgrade = record.status === 'applied' && (reason.includes('洗版') || reason.includes('置换') || reason.includes('更优') || washDetails?.type === 'upgrade');
  const isExempt = reason.includes('杜比') && (reason.includes('豁免') || reason.includes('并存') || reason.includes('双版本') || washDetails?.type === 'exempt');
  const isDuplicate = reason.includes('同名') && (reason.includes('清理') || reason.includes('重复') || washDetails?.type === 'duplicate');
  const isSkipped = record.status === 'skipped' || reason.includes('淘汰') || reason.includes('次级') || reason.includes('已有更高') || washDetails?.type === 'skipped';
  const isProtect = (reason.includes('保护') || reason.includes('拦截') || reason.includes('降级')) && !reason.includes('未匹配');

  let actionType: 'upgrade' | 'skipped' | 'protect' | 'exempt' | 'duplicate' | 'normal' = 'normal';
  if (isUpgrade) actionType = 'upgrade';
  else if (isExempt) actionType = 'exempt';
  else if (isDuplicate) actionType = 'duplicate';
  else if (isSkipped) actionType = 'skipped';
  else if (isProtect) actionType = 'protect';

  let existingName = washDetails?.existingName || '';
  if (!existingName && reason) {
    const patterns = [
      /已有更高画质版本[【\[](.+?)[】\]]/,
      /旧版本[【\[](.+?)[】\]]/,
      /已保留最佳画质版本[【\[](.+?)[】\]]/,
      /已存在完全同名文件[【\[](.+?)[】\]]/,
      /同批次存在更优画质版本[【\[](.+?)[】\]]/,
      /已有更高质量版本[【\[](.+?)[】\]]/,
      /媒体库已有更高画质版本[【\[](.+?)[】\]]/
    ];
    for (const p of patterns) {
      const m = reason.match(p);
      if (m && m[1]) {
        existingName = m[1].trim();
        break;
      }
    }
    if (!existingName) {
      const allMatches = Array.from(reason.matchAll(/[【\[](.+?)[】\]]/g)) as RegExpMatchArray[];
      if (allMatches.length > 0) {
        const candidate = allMatches.find(m => /\.(?:iso|mkv|mp4|ts|avi)|2160p|1080p|720p|hdr|dv|fps|bit|h\.?26[45]/i.test(m[1]));
        existingName = (candidate ? candidate[1] : allMatches[0][1]).trim();
      }
    }
  }

  const incomingName = washDetails?.incomingName || record.newName || record.oldName || '进场文件';
  const incomingSize = washDetails?.incomingSize || record.size || 0;
  const existingSize = washDetails?.existingSize || 0;

  const incomingSpecs = normalizeWashSpecs(washDetails?.incomingTags, incomingName, incomingSize, `${record.oldName} ${record.oldParentPath || ''}`);
  const existingSpecs = normalizeWashSpecs(washDetails?.existingTags, existingName, existingSize);

  // 权威单步决胜推导：根据洗版策略严格进行单步判断，命中首个差异维度即决胜短路退出，绝不罗列无关或平局维度
  let decisiveItem: { key: string; label: string; winner: 'incoming' | 'existing'; detail: string } | null = null;

  if (washDetails?.decisiveLabel && washDetails?.decisiveDetail) {
    // 优先采用后端精准记录的决胜信息
    const w = washDetails.winner === 'incoming' ? 'incoming' : (washDetails.winner === 'existing' ? 'existing' : (actionType === 'upgrade' ? 'incoming' : 'existing'));
    decisiveItem = {
      key: washDetails.decisiveCriterion || 'spec',
      label: washDetails.decisiveLabel,
      winner: w,
      detail: washDetails.decisiveDetail
    };
  } else if (existingSpecs) {
    // 兼容老记录：前端按用户配置洗版优先级逐级单步比对，找到首个非平局维度立即决胜退出！
    const order = strategyConfig.value?.washPriorityOrder?.length ? strategyConfig.value.washPriorityOrder : [
      'videoFormat',
      'dynamicRange',
      'videoCodec',
      'resourceType',
      'releaseGroup',
      'colorDepth',
      'audioCodec',
      'frameRate',
      'fileSize'
    ];

    for (const crit of order) {
      if (crit === 'videoFormat' || crit === 'resolution') {
        if (incomingSpecs.resRank !== existingSpecs.resRank && (incomingSpecs.resRank > 0 || existingSpecs.resRank > 0)) {
          const w = incomingSpecs.resRank > existingSpecs.resRank ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.resolution : existingSpecs.resolution;
          const worse = w === 'incoming' ? (existingSpecs.resolution || '标清') : (incomingSpecs.resolution || '标清');
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'res', label: '分辨率', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'dynamicRange') {
        if (incomingSpecs.drRank !== existingSpecs.drRank) {
          const w = incomingSpecs.drRank > existingSpecs.drRank ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.dynamicRange : existingSpecs.dynamicRange;
          const worse = w === 'incoming' ? existingSpecs.dynamicRange : incomingSpecs.dynamicRange;
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'dr', label: '动态范围', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'videoCodec') {
        const inVc = incomingSpecs.vcRank || 0;
        const exVc = existingSpecs.vcRank || 0;
        if (inVc !== exVc && (inVc > 0 || exVc > 0)) {
          const w = inVc > exVc ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.videoCodec : existingSpecs.videoCodec;
          const worse = w === 'incoming' ? existingSpecs.videoCodec : incomingSpecs.videoCodec;
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'vc', label: '视频编码', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'resourceType') {
        if (incomingSpecs.resTypeRank !== existingSpecs.resTypeRank && (incomingSpecs.resTypeRank > 0 || existingSpecs.resTypeRank > 0)) {
          const w = incomingSpecs.resTypeRank > existingSpecs.resTypeRank ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.resourceType : existingSpecs.resourceType;
          const worse = w === 'incoming' ? existingSpecs.resourceType : incomingSpecs.resourceType;
          // 严禁同名！只有两边名称确实不同且非空才决胜
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'type', label: '资源介质', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'frameRate') {
        if (incomingSpecs.fpsRank !== existingSpecs.fpsRank && (incomingSpecs.fpsRank > 0 || existingSpecs.fpsRank > 0)) {
          const w = incomingSpecs.fpsRank > existingSpecs.fpsRank ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.frameRate : existingSpecs.frameRate;
          const worse = w === 'incoming' ? existingSpecs.frameRate : incomingSpecs.frameRate;
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'fps', label: '帧率', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'colorDepth') {
        const inCd = incomingSpecs.cdRank || 0;
        const exCd = existingSpecs.cdRank || 0;
        if (inCd !== exCd && (inCd > 0 || exCd > 0)) {
          const w = inCd > exCd ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.colorDepth : existingSpecs.colorDepth;
          const worse = w === 'incoming' ? existingSpecs.colorDepth : incomingSpecs.colorDepth;
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'cd', label: '色彩位深', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'audioCodec') {
        if (incomingSpecs.audioRank !== existingSpecs.audioRank) {
          const w = incomingSpecs.audioRank > existingSpecs.audioRank ? 'incoming' : 'existing';
          const better = w === 'incoming' ? incomingSpecs.audioCodec : existingSpecs.audioCodec;
          const worse = w === 'incoming' ? existingSpecs.audioCodec : incomingSpecs.audioCodec;
          if (better && worse && better !== worse) {
            decisiveItem = { key: 'audio', label: '音频规格', winner: w, detail: `${better} 优于 ${worse}` };
            break;
          }
        }
      } else if (crit === 'fileSize') {
        if (incomingSpecs.size > 0 && existingSpecs.size > 0 && incomingSpecs.size !== existingSpecs.size) {
          const w = incomingSpecs.size > existingSpecs.size ? 'incoming' : 'existing';
          const incGb = (incomingSpecs.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
          const exGb = (existingSpecs.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
          decisiveItem = {
            key: 'size',
            label: '文件大小',
            winner: w,
            detail: w === 'incoming' ? `${incGb} 优于 ${exGb}` : `${exGb} 优于 ${incGb}`
          };
          break;
        }
      }
    }
  }

  const diffItems = decisiveItem ? [decisiveItem] : [];

  function buildBadges(specs: any, opposingSpecs: any, isInc: boolean) {
    if (!specs) return [];
    const badges: Array<{ key: string; label: string; isWinner: boolean; badgeClass: string }> = [];
    const opp = opposingSpecs || {};

    if (specs.resolution) {
      const isWin = decisiveItem?.key === 'res' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      badges.push({
        key: 'res',
        label: specs.resolution,
        isWinner: isWin,
        badgeClass: isWin
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200 font-bold border border-amber-300 dark:border-amber-700'
          : 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200/60 dark:border-amber-800/60'
      });
    }

    if (specs.dynamicRange) {
      const isWin = decisiveItem?.key === 'dr' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      const isDv = specs.dynamicRange.includes('杜比') || specs.dynamicRange.includes('DV');
      badges.push({
        key: 'dr',
        label: specs.dynamicRange,
        isWinner: isWin,
        badgeClass: isWin
          ? (isDv ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200 font-bold border border-purple-300 dark:border-purple-700' : 'bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200 font-bold border border-rose-300 dark:border-rose-700')
          : (isDv ? 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border border-purple-200/60 dark:border-purple-800/60' : 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/60')
      });
    }

    if (specs.frameRate) {
      const isWin = decisiveItem?.key === 'fps' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      badges.push({
        key: 'fps',
        label: specs.frameRate,
        isWinner: isWin,
        badgeClass: isWin
          ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/60 dark:text-cyan-200 font-bold border border-cyan-300 dark:border-cyan-700'
          : 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 border border-cyan-200/60 dark:border-cyan-800/60'
      });
    }

    if (specs.colorDepth) {
      const isWin = decisiveItem?.key === 'cd' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      badges.push({
        key: 'cd',
        label: specs.colorDepth,
        isWinner: isWin,
        badgeClass: isWin
          ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/60 dark:text-cyan-200 font-bold border border-cyan-300 dark:border-cyan-700'
          : 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 border border-cyan-200/60 dark:border-cyan-800/60'
      });
    }

    if (specs.resourceType) {
      const isWin = decisiveItem?.key === 'type' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      badges.push({
        key: 'type',
        label: specs.resourceType,
        isWinner: isWin,
        badgeClass: isWin
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200 font-bold border border-blue-300 dark:border-blue-700'
          : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60'
      });
    }

    if (specs.videoCodec) {
      badges.push({
        key: 'vc',
        label: specs.videoCodec,
        isWinner: false,
        badgeClass: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
      });
    }

    if (specs.audioCodec) {
      const isWin = decisiveItem?.key === 'audio' && decisiveItem.winner === (isInc ? 'incoming' : 'existing');
      badges.push({
        key: 'ac',
        label: specs.audioCodec,
        isWinner: isWin,
        badgeClass: isWin
          ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200 font-bold border border-indigo-300 dark:border-indigo-700'
          : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60'
      });
    }

    return badges;
  }

  const incomingBadges = buildBadges(incomingSpecs, existingSpecs, true);
  const existingBadges = buildBadges(existingSpecs, incomingSpecs, false);

  let headline = '洗版裁决';
  let badgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
  let verdictSummary = '';
  let headerPill: { text: string; class: string } | null = null;

  if (actionType === 'skipped') {
    headline = '洗版拦截 · 保护媒体库高规格版本';
    badgeClass = 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300';
    if (decisiveItem) {
      verdictSummary = `媒体库已有版本在【${decisiveItem.label}】规格上更优（${decisiveItem.detail}），进场次选版本移入回收站，避免媒体库高画质资产被降级覆盖。`;
      headerPill = {
        text: `库内胜出: ${decisiveItem.label}`,
        class: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
      };
    } else {
      verdictSummary = '目标媒体库中已有相同规格版本，清理暂存区重复副本并移入 139 回收站。';
      headerPill = {
        text: '同规格同名',
        class: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
      };
    }
  } else if (actionType === 'upgrade') {
    headline = '洗版置换 · 新版本规格更优';
    badgeClass = 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300';
    if (decisiveItem) {
      verdictSummary = `新进场资源在【${decisiveItem.label}】规格上胜出（${decisiveItem.detail}），已洗版置换入库，媒体库旧版本延后移入回收站。`;
      headerPill = {
        text: `洗版升级: ${decisiveItem.label}`,
        class: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
      };
    } else {
      verdictSummary = '新版本画质更优，已洗版置换入库，媒体库旧版移入回收站。';
      headerPill = {
        text: '画质升级',
        class: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
      };
    }
  } else if (actionType === 'exempt') {
    headline = '多版本豁免 · 杜比视界双版并存';
    badgeClass = 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300';
    verdictSummary = '检测到杜比视界 (DV) 版本与非杜比标准版本，触发双版本豁免规则，媒体库中双版本均予保留。';
    headerPill = {
      text: '杜比双版豁免',
      class: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800'
    };
  } else if (actionType === 'duplicate') {
    headline = '同名清理 · 剔除暂存区重复副本';
    badgeClass = 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300';
    verdictSummary = '目标媒体库中已存在完全同名同规格资源，暂存区重复副本已清理移入 139 回收站。';
    headerPill = {
      text: '同名清理',
      class: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    };
  } else if (actionType === 'protect') {
    headline = '逆向拦截 · 保护媒体库已有资产';
    badgeClass = 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300';
    verdictSummary = reason || '媒体库已有更佳或同等规格版本，拦截本次覆盖以保护已有资产。';
    headerPill = {
      text: '原地保护',
      class: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
    };
  }

  let mainBadge = {
    text: '整理入库',
    class: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800'
  };

  if (record.status === 'reverted') {
    mainBadge = {
      text: '↩ 已原路撤回',
      class: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    };
  } else if (actionType === 'upgrade') {
    mainBadge = {
      text: '洗版升级 (新版入库)',
      class: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
    };
  } else if (actionType === 'skipped') {
    mainBadge = {
      text: '保留旧版 (次选淘汰)',
      class: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
    };
  } else if (actionType === 'protect') {
    mainBadge = {
      text: '逆向降级拦截',
      class: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
    };
  } else if (actionType === 'exempt') {
    mainBadge = {
      text: '杜比双版豁免',
      class: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800'
    };
  } else if (actionType === 'duplicate') {
    mainBadge = {
      text: '同名清理',
      class: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    };
  }

  const comparisonRows: Array<{
    role: 'winner' | 'loser' | 'coexist';
    badgeText: string;
    badgeClass: string;
    sourceLabel: string;
    name: string;
    sizeFormatted: string;
    badges: Array<{ key: string; label: string; isWinner: boolean; badgeClass: string }>;
    isDeletedOrTrash?: boolean;
  }> = [];

  if (existingName) {
    if (actionType === 'upgrade') {
      comparisonRows.push({
        role: 'winner',
        badgeText: '最终保留',
        badgeClass: 'bg-emerald-600 text-white shadow-2xs',
        sourceLabel: '新进场胜出入库',
        name: incomingName,
        sizeFormatted: formatSize(incomingSize),
        badges: incomingBadges
      });
      comparisonRows.push({
        role: 'loser',
        badgeText: '淘汰置换',
        badgeClass: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800',
        sourceLabel: '媒体库旧版 · 已移至回收站',
        name: existingName,
        sizeFormatted: existingSize ? formatSize(existingSize) : '',
        badges: existingBadges,
        isDeletedOrTrash: true
      });
    } else if (actionType === 'skipped' || actionType === 'protect') {
      comparisonRows.push({
        role: 'winner',
        badgeText: '最终保留',
        badgeClass: 'bg-emerald-600 text-white shadow-2xs',
        sourceLabel: '媒体库高画质原版 · 原地留存',
        name: existingName,
        sizeFormatted: existingSize ? formatSize(existingSize) : '',
        badges: existingBadges
      });
      comparisonRows.push({
        role: 'loser',
        badgeText: '淘汰拦截',
        badgeClass: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800',
        sourceLabel: '进场次选版本 · 已移至回收站',
        name: incomingName,
        sizeFormatted: formatSize(incomingSize),
        badges: incomingBadges,
        isDeletedOrTrash: true
      });
    } else if (actionType === 'exempt') {
      comparisonRows.push({
        role: 'coexist',
        badgeText: '双版并存',
        badgeClass: 'bg-purple-600 text-white shadow-2xs',
        sourceLabel: '新进场版本 (杜比视界)',
        name: incomingName,
        sizeFormatted: formatSize(incomingSize),
        badges: incomingBadges
      });
      comparisonRows.push({
        role: 'coexist',
        badgeText: '双版并存',
        badgeClass: 'bg-purple-600 text-white shadow-2xs',
        sourceLabel: '媒体库原版本 (非杜比标准版)',
        name: existingName,
        sizeFormatted: existingSize ? formatSize(existingSize) : '',
        badges: existingBadges
      });
    } else {
      comparisonRows.push({
        role: 'winner',
        badgeText: '媒体库已有',
        badgeClass: 'bg-slate-600 text-white shadow-2xs',
        sourceLabel: '媒体库留存资产',
        name: existingName,
        sizeFormatted: existingSize ? formatSize(existingSize) : '',
        badges: existingBadges
      });
      comparisonRows.push({
        role: 'loser',
        badgeText: '重复清理',
        badgeClass: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700',
        sourceLabel: '暂存区重复副本 · 已清理移入回收站',
        name: incomingName,
        sizeFormatted: formatSize(incomingSize),
        badges: incomingBadges,
        isDeletedOrTrash: true
      });
    }
  } else {
    comparisonRows.push({
      role: 'winner',
      badgeText: '整理入库',
      badgeClass: 'bg-blue-600 text-white shadow-2xs',
      sourceLabel: '入库目标文件',
      name: incomingName,
      sizeFormatted: formatSize(incomingSize),
      badges: incomingBadges
    });
  }

  return {
    actionType,
    headline,
    badgeClass,
    headerPill,
    mainBadge,
    comparisonRows,
    verdictSummary,
    incoming: {
      name: incomingName,
      sizeFormatted: formatSize(incomingSize),
      statusBadge: actionType === 'skipped'
        ? { text: '次选淘汰', class: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200 dark:border-rose-800' }
        : (actionType === 'upgrade'
          ? { text: '画质胜出', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800' }
          : { text: '进场版本', class: 'bg-slate-100 text-slate-600 border-slate-200' }),
      badges: incomingBadges,
      specs: incomingSpecs
    },
    existing: existingName ? {
      name: existingName,
      sizeFormatted: existingSize ? formatSize(existingSize) : '',
      statusBadge: actionType === 'skipped' || actionType === 'protect'
        ? { text: '高画质留存', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800' }
        : { text: '已淘汰置换', class: 'bg-slate-100 text-slate-500 border-slate-200' },
      badges: existingBadges,
      specs: existingSpecs
    } : {
      name: '',
      sizeFormatted: '',
      statusBadge: { text: '', class: '' },
      badges: [] as { key: string; label: string; badgeClass: string; isWinner?: boolean }[],
      specs: [] as string[],
    },
    diffItems
  };
}

// 洗版记录列表与过滤计算属性
const washHistoryList = computed(() => {
  return historyRecords.value.filter(isWashRecord);
});

const filteredWashRecords = computed(() => {
  let list = washHistoryList.value;
  if (washActiveFilter.value !== 'all') {
    list = list.filter(r => {
      const action = parseWashAction(r);
      return action.type === washActiveFilter.value;
    });
  }
  const query = washSearchQuery.value.trim().toLowerCase();
  if (!query) return list;
  const regexPattern = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(regexPattern, 'i');
  return list.filter(r => {
    return (
      regex.test(r.title || '') ||
      regex.test(r.oldName || '') ||
      regex.test(r.newName || '') ||
      regex.test(r.reason || '') ||
      regex.test(r.oldParentPath || '') ||
      regex.test(r.newParentPath || '') ||
      regex.test(String(r.tmdbId || ''))
    );
  });
});

// 洗版记录批量勾选与操作
function toggleWashSelect(id: number) {
  if (washSelectedIds.value.has(id)) {
    washSelectedIds.value.delete(id);
  } else {
    washSelectedIds.value.add(id);
  }
}

function toggleWashSelectAll() {
  if (washSelectedIds.value.size === filteredWashRecords.value.length) {
    washSelectedIds.value.clear();
  } else {
    washSelectedIds.value = new Set(filteredWashRecords.value.map(r => r.id));
  }
}

const washBatchRollbackConfirm = ref(false);
async function handleWashBatchRollback() {
  if (washSelectedIds.value.size === 0) return;
  if (!washBatchRollbackConfirm.value) {
    washBatchRollbackConfirm.value = true;
    return;
  }
  washBatchRollbackConfirm.value = false;
  const ids = Array.from(washSelectedIds.value);
  loading.value = true;
  let successCount = 0;
  for (const id of ids) {
    try {
      await tmdbOrganizeApi.rollback({ recordId: id, accountId: selectedAccountId.value });
      successCount++;
    } catch (_) {}
  }
  ElMessage.success(`批量撤回完成，成功恢复 ${successCount} 项！`);
  await loadHistory();
}

const washBatchDeleteConfirm = ref(false);
async function handleWashBatchDelete() {
  if (washSelectedIds.value.size === 0) return;
  if (!washBatchDeleteConfirm.value) {
    washBatchDeleteConfirm.value = true;
    return;
  }
  washBatchDeleteConfirm.value = false;
  const ids = Array.from(washSelectedIds.value);
  try {
    await tmdbOrganizeApi.batchDeleteRecords(ids);
    ElMessage.success(`已删除 ${ids.length} 条洗版记录`);
    await loadHistory();
  } catch (err: any) {
    ElMessage.error(`删除失败: ${err.message}`);
  }
}

// 目录选择器控制
const folderPickerVisible = ref(false);
const folderPickerType = ref<'staging' | 'target' | 'manual-source' | 'manual-target'>('target');

function openFolderPicker(type: 'staging' | 'target' | 'manual-source' | 'manual-target') {
  if (!checkAccountGuard('选择云盘目录')) {
    return;
  }
  folderPickerType.value = type;
  folderPickerVisible.value = true;
}

function handleFolderSelected(folder: { id: string; name: string }) {
  const normId = folder.id === '-11' ? '/' : (folder.id || '');
  const normName = folder.id === '-11' ? '根目录 (/)' : (folder.name || '');

  if (folderPickerType.value === 'manual-source') {
    manualOrganizeConfig.value.sourceDirId = normId;
    manualOrganizeConfig.value.sourceDirPath = normName;
    unrecognizedStagingFolderId.value = normId;
    unrecognizedStagingPath.value = normName;
    try {
      localStorage.setItem(WORKBENCH_LAST_FOLDER_KEY, JSON.stringify({ id: normId, name: normName }));
    } catch (_) {}
    ElMessage.success(`已切换整理文件夹: ${normName}`);
    loadUnrecognizedFiles(normId, true);
  } else if (folderPickerType.value === 'manual-target') {
    manualOrganizeConfig.value.targetDirPath = normName;
    ElMessage.success(`已选定媒体库归档目录: ${normName}`);
  } else if (folderPickerType.value === 'staging') {
    if (normId && normId === strategyConfig.value.defaultTargetFolderId) {
      ElMessage.error('源暂存目录不能与目标归档目录相同！');
      return;
    }
    // 工业级安全防护：禁止将已规范归档的影视媒体目录（包含 {tmdb-xxx} 或 Season xx）选为源暂存区
    if (/\{tmdb-\d+\}/i.test(normName) || /^Season\s*\d+/i.test(normName)) {
      ElMessage.error(`不能选择已归档的影视媒体目录【${normName}】作为源暂存区！请选择独立的暂存目录。`);
      return;
    }
    strategyConfig.value.stagingFolderId = normId;
    strategyConfig.value.stagingFolderName = normName || '/暂存区/频道转存';
    ElMessage.success(`已锁定源暂存区: ${strategyConfig.value.stagingFolderName}`);
  } else {
    if (normId && normId === strategyConfig.value.stagingFolderId) {
      ElMessage.error('目标归档目录不能与源暂存目录相同！');
      return;
    }
    try {
      localStorage.removeItem(WORKBENCH_TARGET_CLEARED_KEY);
    } catch (_) {}
    strategyConfig.value.defaultTargetFolderId = normId;
    strategyConfig.value.defaultTargetFolderName = normName;
    manualModalForm.value.targetFolderPath = normName;
    manualModalForm.value.targetFolderId = normId;
    ElMessage.success(`已指定媒体库归档目录: ${normName}`);
    handleSaveStrategy();
  }
  folderPickerVisible.value = false;
}

// 保存策略配置 (媒体整理配置 / 洗版配置)
async function handleSaveStrategy() {
  if (savingStrategy.value) return;

  // 洗版专属页面 (/wash) 仅保存洗版策略，无需强制校验源暂存目录与归档目录必须选择非根目录
  if (!isWashRoute.value) {
    // 1. 严格校验源暂存目录 (必须已选择真实有效目录)
    const stagingId = strategyConfig.value.stagingFolderId?.trim();
    const stagingName = strategyConfig.value.stagingFolderName?.trim();
    if (!stagingId || stagingId === '/' || !stagingName || stagingName === '临时存放') {
      ElMessage.warning({
        message: '请先点击【选择暂存目录】，指定待整理的网盘源暂存目录！',
        grouping: true,
      });
      return;
    }

    // 2. 严格校验目标归档目录 (必须已选择真实有效媒体库目录)
    const targetId = strategyConfig.value.defaultTargetFolderId?.trim();
    const targetName = strategyConfig.value.defaultTargetFolderName?.trim();
    if (!targetId || targetId === '/' || !targetName || targetName === '默认媒体库' || targetName === '默认媒体库 (/)') {
      ElMessage.warning({
        message: '请先点击【选择归档目录】，指定影视整理入库的目标媒体库目录！',
        grouping: true,
      });
      return;
    }

    // 3. 严格校验互斥防环保护
    if (stagingId === targetId) {
      ElMessage.error({
        message: '源暂存目录与目标归档目录不能相同，否则会导致循环归档死锁！',
        grouping: true,
      });
      return;
    }
  }

  savingStrategy.value = true;
  strategyConfig.value.accountId = selectedAccountId.value;
  try {
    const res = await channelApi.saveGlobalConfig(strategyConfig.value);
    if (res) {
      strategyConfig.value = { ...strategyConfig.value, ...res };
    }
    const tip = isWashRoute.value ? '洗版策略配置已成功保存！' : '媒体整理策略配置已成功保存！';
    ElMessage.success({
      message: tip,
      grouping: true,
    });
  } catch (err: any) {
    ElMessage.error({
      message: `保存策略失败: ${err.message || '网络异常'}`,
      grouping: true,
    });
  } finally {
    savingStrategy.value = false;
  }
}

// 立即触发整理 139 云盘暂存区
async function handleOrganizeNow() {
  if (!checkAccountGuard('立即整理 139 云盘')) {
    return;
  }
  organizingNow.value = true;
  try {
    const res = await channelApi.organizeNow({
      accountId: selectedAccountId.value || undefined,
      stagingFolderId: strategyConfig.value.stagingFolderId || undefined,
      defaultTargetFolderId: strategyConfig.value.defaultTargetFolderId || undefined,
    });
    ElMessage.success(res.message || '已成功触发 139 云盘待整理目录扫描整理任务！');
    await loadHistory();
  } catch (err: any) {
    ElMessage.error(`触发整理失败: ${err.message || '网络异常'}`);
  } finally {
    organizingNow.value = false;
  }
}

// ================= 2. 整理流水与沙箱看板状态 =================
const historyRecords = ref<OrganizeHistoryRecord[]>([]);
const totalHistory = ref(0);
const currentPage = ref(1);
const pageSize = ref(20); // 方案 A 高密度浏览默认 20 条/页 (对齐 MoviePilot v3)
const activeFilter = ref<'all' | 'applied' | 'fallback' | 'protected' | 'reverted'>('all');
const searchQuery = ref('');

// 选中的记录 ID 集合 (用于批量操作)
const selectedIds = ref<Set<number>>(new Set());

// 手动整理双栏沙箱面板 (零弹窗：页面内联展开)
const inlineOrganizePanelOpen = ref(false);
const scanning = ref(false);
const previewing = ref(false);
const executing = ref(false);
const previewDone = ref(false);

const manualOrganizeConfig = ref({
  sourceDirId: '/',
  sourceDirPath: '/',
  targetStorage: 'auto' as 'auto' | 'cloud139' | 'local',
  organizeLocation: 'target' as 'target' | 'inPlace',
  targetDirPath: '/媒体库',
  mediaType: 'auto' as 'auto' | 'tv' | 'movie',
  dataSource: 'auto' as 'auto' | 'tmdb' | 'douban',
  unmatchedSeasonPolicy: 'fallbackCleanSeason' as 'fallbackCleanSeason' | 'protectInPlace',
  classifyRegion: true,
  classifyYear: false,
  minFileSizeMb: 0,
  cleanEmptySources: true,
  includeEpisodeTitle: true,
  enableCue: true,
  customPart: ''
});

// ================= 2. 暂存区未识别媒体分组治理与人工纠偏工作台状态 =================
interface MediaFileItem {
  id: string;
  fileId: string;
  name: string;
  size: number;
  relativePath: string;
  folderPath: string;
  parentFolderId: string;
  parentFolderName: string;
  inferredTitle: string;
  cleanTitle: string;
  year: string;
  season?: number;
  episode?: number | null;
  episodeTitle?: string;
  isSpecial?: boolean;
  specs?: any;
  tech?: any;
  issueType?: string;
  issueReason?: string;
  mediaType?: string;
  tmdbId?: string | number;
  isVideo?: boolean;
  isSidecar?: boolean;
}

interface MediaGroupItem {
  id: string; // 分组唯一 ID (通常为顶层实质性剧集目录名)
  folderName: string; // 所在目录名，如 "走马上任 (2026)" 或 "后会友期"
  folderPath: string;
  rawTitle: string; // 提取的纯净片名
  customTitle?: string; // 用户手动直接指定的官方片名 (无需 TMDB ID 也可入库)
  year: string;
  customYear?: string; // 用户手动指定的首播年份
  files: MediaFileItem[];
  // TMDB 匹配结果
  tmdbCandidate: any | null;
  tmdbId?: string | number;
  customTmdbId?: string;
  mediaType: 'tv' | 'movie';
  targetCategory: string; // '国产剧' | '日韩剧' | '欧美剧' | '动漫' | '电影' | '纪录片' | '综艺'
  targetSeason?: number | null;
  aiExplanation?: string;
  startEpisode: number;
  episodeOffset: number;
  episodeOverrides: Record<string, number>;
  episodeTitleOverrides: Record<string, string>;
  seasonOverrides: Record<string, number>;
  customNameOverrides: Record<string, string>;
  excludedFileIds: Set<string>;
  transferType?: 'move' | 'copy';
  // 折叠状态
  isTuningCollapsed: boolean;
  isFilesCollapsed: boolean;
}

const loadingUnrecognized = ref(false);
const scanProgressPercent = ref(0);
const scanElapsedSeconds = ref(0);
const scanStageText = ref('正在检索目录结构...');
let scanProgressTimer: any = null;

function startScanProgress() {
  scanProgressPercent.value = 5;
  scanElapsedSeconds.value = 0;
  scanStageText.value = '正在检索 139 网盘目录结构...';
  if (scanProgressTimer) clearInterval(scanProgressTimer);
  scanProgressTimer = setInterval(() => {
    scanElapsedSeconds.value++;
    if (scanElapsedSeconds.value < 3) {
      scanStageText.value = '正在检索 139 网盘目录结构...';
      scanProgressPercent.value = Math.min(30, scanProgressPercent.value + 8);
    } else if (scanElapsedSeconds.value < 8) {
      scanStageText.value = '正在穿透子目录并递归发现视频资产...';
      scanProgressPercent.value = Math.min(65, scanProgressPercent.value + 5);
    } else if (scanElapsedSeconds.value < 16) {
      scanStageText.value = '正在解析媒体指纹与防封混淆标签...';
      scanProgressPercent.value = Math.min(88, scanProgressPercent.value + 3);
    } else {
      scanStageText.value = '正在进行本地元数据比对与自愈归集...';
      scanProgressPercent.value = Math.min(96, scanProgressPercent.value + 1);
    }
  }, 1000);
}

function stopScanProgress() {
  if (scanProgressTimer) {
    clearInterval(scanProgressTimer);
    scanProgressTimer = null;
  }
  scanProgressPercent.value = 100;
}
const unrecognizedStagingPath = ref('');
const unrecognizedStagingFolderId = ref('');
const unrecognizedFiles = ref<MediaFileItem[]>([]);
const allScannedFiles = ref<any[]>([]);
const residualFolders = ref<{ id: string; name: string; path: string }[]>([]);
const cleaningResidual = ref(false);

// 媒体分组体系
const mediaGroups = ref<MediaGroupItem[]>([]);
const activeGroupId = ref<string>('');
const groupSearchQuery = ref('');
const groupFilterStatus = ref<'all' | 'unmatched' | 'matched'>('all');

// TMDB 检索状态
const tmdbSearchQuery = ref('');
const tmdbSearchMediaType = ref<'tv' | 'movie' | ''>('');
const isSearchingTmdb = ref(false);
const tmdbCandidates = ref<any[]>([]);

// 提取当前选中的活跃媒体分组
const activeGroup = computed<MediaGroupItem | null>(() => {
  if (!mediaGroups.value || mediaGroups.value.length === 0) return null;
  const found = mediaGroups.value.find(g => g.id === activeGroupId.value);
  return found || mediaGroups.value[0];
});

// 全局纠偏归档参数与媒体分类
const tvCategories = ['国漫', '日番', '国产剧', '欧美剧', '日韩剧', '动漫', '纪录片', '综艺', '儿童', '演唱会', '未分类'];
const movieCategories = ['动画电影', '华语电影', '欧美电影', '日韩电影', '外语电影', '电影', '纪录片', '演唱会', '未分类'];

// 统一权威判定当前分组是否属于电影 (覆盖分类、TMDB候选、模态标记与单文件无分集规则)
function isGroupMovie(g: MediaGroupItem | null | undefined): boolean {
  if (!g) return false;
  if (g.mediaType === 'movie') return true;
  const cat = g.targetCategory || '';
  if (cat && (cat.includes('电影') || movieCategories.includes(cat))) return true;
  if (g.tmdbCandidate) {
    const c = g.tmdbCandidate;
    if (c.media_type === 'movie' || c.mediaType === 'movie' || c.category === '电影') return true;
    if (c.secondaryCategory && (c.secondaryCategory.includes('电影') || movieCategories.includes(c.secondaryCategory))) return true;
    if (c.title && !c.name) return true;
  }
  const hasTv = Array.isArray(g.files) && g.files.some(f =>
    /\b(?:S\d{1,2}[\s._-]*E\d{1,4}|EP\d{1,4}|第\s*\d+\s*[集话期])\b/i.test(f.name) ||
    /\b(?:Season[\s._-]*\d{1,2}|S\d{1,2})\b/i.test(f.name) ||
    /第\s*[0-9零一二两三四五六七八九十]+\s*季/i.test(f.name)
  );
  if (!hasTv && Array.isArray(g.files) && g.files.length === 1 && !/(?:剧集|电视剧|国漫|日番|美剧|韩剧|日剧)/i.test(cat)) {
    if (cat.includes('剧') || cat === '国漫' || cat === '日番') return false;
    return true;
  }
  return false;
}

const availableCategories = computed(() => {
  const isMovie = isGroupMovie(activeGroup.value);
  const list = isMovie ? [...movieCategories] : [...tvCategories];
  const cur = activeGroup.value?.targetCategory;
  if (cur && !list.includes(cur)) {
    list.unshift(cur);
  }
  return list;
});

function onTargetCategoryChanged() {
  const g = activeGroup.value;
  if (!g) return;
  if (isGroupMovie(g)) {
    g.mediaType = 'movie';
    g.targetSeason = null;
  } else {
    g.mediaType = 'tv';
    if (g.targetSeason === null || g.targetSeason === undefined) {
      g.targetSeason = 1;
    }
  }
  saveWorkspaceDraft();
}

// 全局 Pinia 归档状态 (组件卸载或路由切换时进度持续流转，并在顶部 Header 保持透传)
const organizeStore = useOrganizeStore();
const { organizeProgress, resolvingNow, batchResolvingNow } = storeToRefs(organizeStore);

const cleanEmptySourceDirOnResolve = ref(true);
const keepOriginalFilename = ref(false);
const minFileSizeFilterMb = ref(30);
const activeGroupTransferType = ref<'move' | 'copy'>('move');

// 自动根据小文件大小阈值批量标记排除广告宣传短片
function applyMinFileSizeFilter() {
  const g = activeGroup.value;
  if (!g) return;
  const limitBytes = (minFileSizeFilterMb.value || 0) * 1024 * 1024;
  if (limitBytes <= 0) return;
  let excludedCount = 0;
  g.files.forEach(f => {
    if (f.size > 0 && f.size < limitBytes) {
      if (!g.excludedFileIds.has(String(f.id))) {
        g.excludedFileIds.add(String(f.id));
        excludedCount++;
      }
    }
  });
  saveWorkspaceDraft();
  if (excludedCount > 0) {
    ElMessage.info(`已根据过滤规则自动排除 ${excludedCount} 个小于 ${minFileSizeFilterMb.value}MB 的文件`);
  }
}

// MoviePilot 级「手动整理与高级刮削控制」弹窗状态
const showManualModal = ref(false);
const manualModalLoading = ref(false);
const manualModalExecuting = ref(false);
const modalSearchingTmdb = ref(false);
const modalTmdbCandidates = ref<any[]>([]);
const modalSelectedCandidate = ref<any | null>(null);
const modalTvSeasons = ref<any[]>([]);
const modalLoadingSeasons = ref(false);
const modalSearchQuery = ref('');

const manualModalForm = ref({
  targetAccountId: '' as string | number,
  transferType: 'move' as 'move' | 'copy',
  targetFolderId: '',
  targetFolderPath: '/媒体库',
  mediaType: 'tv' as string,
  category: '国产剧' as string,
  metadataSource: 'tmdb' as 'tmdb' | 'custom',
  minFileSizeMb: 30,
  keepOriginalName: false,
  cleanResidualFolders: true,
  keepDolbyMultiVersion: false,
  startSeason: 1,
  startEpisode: 1,
  episodeStep: 1,
  customTitle: '',
  customYear: '',
  tmdbId: '' as string | number
});
const manualPreviewTasks = ref<any[]>([]);
const showManualPreviewTable = ref(false);

const modalTargetLivePath = computed(() => {
  const root = (manualModalForm.value.targetFolderPath && !manualModalForm.value.targetFolderPath.includes('默认媒体库')) ? manualModalForm.value.targetFolderPath.replace(/\/+$/, '') : '/媒体库';
  const title = manualModalForm.value.customTitle || activeGroup.value?.rawTitle || '未知影视';
  const year = manualModalForm.value.customYear ? ` (${manualModalForm.value.customYear})` : '';
  const tmdb = manualModalForm.value.tmdbId ? ` {tmdb-${manualModalForm.value.tmdbId}}` : '';
  const isMovie = manualModalForm.value.mediaType === 'movie';
  const cat = manualModalForm.value.category || (isMovie ? '电影' : '国产剧');
  const typeFolder = isMovie ? '电影' : '剧集';
  let catSub = `${typeFolder}/${cat}`.replace(/\/+/g, '/');
  if (cat.startsWith('电影/') || cat.startsWith('剧集/')) catSub = cat;

  if (isMovie) {
    return `${root}/${catSub}/${title}${year}${tmdb}`.replace(/\/+/g, '/');
  } else {
    const sStr = `Season ${String(manualModalForm.value.startSeason ?? 1).padStart(2, '0')}`;
    return `${root}/${catSub}/${title}${year}${tmdb}/${sStr}`.replace(/\/+/g, '/');
  }
});

// 刮削工作台状态控制
const isFolderLocked = ref(false);
const folderLockInfo = ref<{ owner: string; task: string }>({ owner: '', task: '' });

// 刮削工作台持久化键名
const WORKBENCH_LAST_FOLDER_KEY = 'scrape_workbench_last_selected_folder_v1';
const WORKBENCH_TARGET_CLEARED_KEY = 'scrape_workbench_target_cleared_v1';

// 是否已主动选定待整理的网盘文件夹
const hasUserSelectedSourceFolder = computed(() => {
  return Boolean(unrecognizedStagingFolderId.value || unrecognizedStagingPath.value);
});

// 刮削工作台当前选中的整理文件夹显示路径
const currentWorkbenchDisplayPath = computed(() => {
  return unrecognizedStagingPath.value || '未选择 (点击选择网盘文件夹)';
});

// 是否已主动选定目标归档媒体库
const hasUserSelectedTargetFolder = computed(() => {
  const custom = strategyConfig.value.defaultTargetFolderName;
  return Boolean(
    strategyConfig.value.defaultTargetFolderId &&
    custom &&
    custom !== '未选择' &&
    custom !== '/' &&
    !custom.includes('默认媒体库')
  );
});

// 当前生效的目标媒体库根目录
const currentTargetDisplayPath = computed(() => {
  const custom = strategyConfig.value.defaultTargetFolderName;
  if (custom && custom !== '/' && !custom.includes('默认媒体库') && custom !== '未选择') return custom;
  return '未选择 (点击选择目标媒体库)';
});

// 清空当前选定源文件夹，返回选择引导界面
function clearWorkbenchFolder() {
  unrecognizedStagingFolderId.value = '';
  unrecognizedStagingPath.value = '';
  try {
    localStorage.removeItem(WORKBENCH_LAST_FOLDER_KEY);
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch (_) {}
  unrecognizedFiles.value = [];
  allScannedFiles.value = [];
  mediaGroups.value = [];
  activeGroupId.value = '';
}

// 清空当前归档目标媒体库选择，返回未选择状态
function clearWorkbenchTargetFolder() {
  strategyConfig.value.defaultTargetFolderId = '';
  strategyConfig.value.defaultTargetFolderName = '';
  manualModalForm.value.targetFolderId = '';
  manualModalForm.value.targetFolderPath = '';
  try {
    localStorage.setItem(WORKBENCH_TARGET_CLEARED_KEY, 'true');
  } catch (_) {}
  ElMessage.info('已取消选择归档媒体库');
}

// 分组拆分与勾选状态
const selectedFileIdsForSplit = ref<Set<string>>(new Set());

// 过滤后的媒体分组清单
const filteredGroups = computed(() => {
  let list = mediaGroups.value;
  if (groupFilterStatus.value === 'matched') {
    list = list.filter(g => Boolean(g.tmdbCandidate));
  } else if (groupFilterStatus.value === 'unmatched') {
    list = list.filter(g => !g.tmdbCandidate);
  }
  const q = groupSearchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(g =>
    g.folderName.toLowerCase().includes(q) ||
    g.rawTitle.toLowerCase().includes(q) ||
    (g.tmdbCandidate && (g.tmdbCandidate.title || g.tmdbCandidate.name || '').toLowerCase().includes(q))
  );
});

// 全局待处理统计
const totalUnrecognizedCount = computed(() => {
  return mediaGroups.value.reduce((acc, g) => acc + g.files.length, 0);
});

const matchedGroupCount = computed(() => {
  return mediaGroups.value.filter(g => Boolean(g.tmdbCandidate)).length;
});

const matchedFilesCount = computed(() => {
  return mediaGroups.value
    .filter(g => Boolean(g.tmdbCandidate))
    .reduce((acc, g) => acc + g.files.filter(f => !g.excludedFileIds.has(String(f.id))).length, 0);
});

// 特殊集数关键词侦测规则 (加更、抢鲜、先导、花絮、番外、彩蛋、特别篇)
const SPECIAL_HINT_PATTERNS = [
  { label: '加更', regex: /(?:加更|加料|独家加更|还有加更|Plus|Extra)/i },
  { label: '抢鲜', regex: /(?:抢鲜|抢先|尝鲜|先行)/i },
  { label: '先导', regex: /(?:先导|导赏|导览|序篇|序章|预热|预告|片花|Trailer|Teaser|Preview|Sneak\s*Peek|Promo|PV)/i },
  { label: '花絮', regex: /(?:花絮|幕后|探班|制作特辑|制作花絮|采访|访谈|特辑|Behind\s*the\s*Scenes|Making\s*of|BTS|Featurette)/i },
  { label: '彩蛋', regex: /(?:彩蛋|片段|小剧场|特别企划|Easter\s*Egg|Clip)/i },
  { label: '番外', regex: /(?:番外|衍生|Side\s*Story|Spin\s*Off|Spinoff)/i },
  { label: '特别篇', regex: /(?:特别篇|特别企划|\bSP\b|Special|OVA|OAD)/i }
];

function detectSpecialEpisode(filename: string): { isSpecial: boolean; label: string } {
  if (!filename) return { isSpecial: false, label: '' };
  if (/\bS0+E\d+/i.test(filename)) {
    return { isSpecial: true, label: '特别篇' };
  }
  for (const item of SPECIAL_HINT_PATTERNS) {
    if (item.regex.test(filename)) {
      return { isSpecial: true, label: item.label };
    }
  }
  return { isSpecial: false, label: '' };
}

// 供单集微调选择的目标季号列表 (0=特别篇/加更, 1=第1季...)
const seasonSelectOptions = computed(() => {
  const seasons = [0, 1, 2, 3, 4, 5, 6, 7];
  const curTarget = activeGroup.value?.targetSeason;
  if (curTarget !== undefined && curTarget !== null && !seasons.includes(Number(curTarget))) {
    seasons.push(Number(curTarget));
    seasons.sort((a, b) => a - b);
  }
  return seasons;
});

// 单集文件名行内微调状态
const editingFileId = ref<string | null>(null);
const editingFileNameValue = ref('');

function startEditFileName(fileId: string, currentName: string) {
  editingFileId.value = fileId;
  editingFileNameValue.value = currentName;
}

function saveEditFileName(fileId: string) {
  const g = activeGroup.value;
  if (!g) return;
  if (!g.customNameOverrides) g.customNameOverrides = {};
  if (editingFileNameValue.value.trim()) {
    g.customNameOverrides[fileId] = editingFileNameValue.value.trim();
  } else {
    delete g.customNameOverrides[fileId];
  }
  editingFileId.value = null;
  saveWorkspaceDraft();
}

function cancelEditFileName() {
  editingFileId.value = null;
  editingFileNameValue.value = '';
}

function resetEditFileName(fileId: string) {
  const g = activeGroup.value;
  if (!g || !g.customNameOverrides) return;
  delete g.customNameOverrides[fileId];
  saveWorkspaceDraft();
  ElMessage.success('已恢复系统标准自动命名');
}

function updateFileSeason(fileId: string, seasonVal: number) {
  const g = activeGroup.value;
  if (!g) return;
  if (!g.seasonOverrides) g.seasonOverrides = {};
  g.seasonOverrides[fileId] = Number(seasonVal);
  saveWorkspaceDraft();
  checkActiveGroupWashDebounced();
}

function updateFileEpisode(fileId: string, epVal: number) {
  const g = activeGroup.value;
  if (!g) return;
  if (!g.episodeOverrides) g.episodeOverrides = {};
  g.episodeOverrides[fileId] = Number(epVal);
  saveWorkspaceDraft();
  checkActiveGroupWashDebounced();
}

// 仅当原始文件夹名与 TMDB 标题实质不同时透出别名凭证，杜绝类似 "斗破苍穹 (斗破苍穹 (2022))" 的冗余套娃
const displayFolderAlias = computed(() => {
  const g = activeGroup.value;
  if (!g || !g.tmdbCandidate) return '';
  const candTitle = (g.tmdbCandidate.title || g.tmdbCandidate.name || '').trim().toLowerCase();
  const folder = (g.folderName || '').trim();
  if (!candTitle || !folder) return '';
  const cleanFolder = folder
    .replace(/\s*[\(\（]\s*(?:19|20)\d{2}\s*[\)\）]/g, '')
    .replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/i, '')
    .replace(/[\._\-]/g, ' ')
    .trim().toLowerCase();
  if (cleanFolder === candTitle || cleanFolder.replace(/\s+/g, '') === candTitle.replace(/\s+/g, '')) {
    return '';
  }
  return g.folderName;
});

// 当前活跃分组的重命名与入库推演列表
const previewOrganizedList = computed(() => {
  const g = activeGroup.value;
  if (!g) return [];

  const cand = g.tmdbCandidate;
  const isMovie = isGroupMovie(g);
  const effectiveTitle = (g.customTitle || cand?.title || cand?.name || g.rawTitle || g.folderName).trim();
  const effectiveYear = g.customYear || (cand?.release_date ? cand.release_date.substring(0, 4) : (cand?.first_air_date ? cand.first_air_date.substring(0, 4) : g.year));
  const effectiveTmdbId = cand?.id ? String(cand.id) : (g.customTmdbId || '');

  const defaultSeason = (g.targetSeason !== undefined && g.targetSeason !== null) ? Number(g.targetSeason) : 1;
  const tmdbTag = effectiveTmdbId ? ` {tmdb-${effectiveTmdbId}}` : '';
  const titleYear = effectiveYear ? `${effectiveTitle} (${effectiveYear})` : effectiveTitle;

  return g.files.map((f: MediaFileItem, idx: number) => {
    const ext = f.name.includes('.') ? f.name.substring(f.name.lastIndexOf('.')) : '.mp4';
    const fid = String(f.id);
    const isExcluded = g.excludedFileIds.has(fid);

    const specialInfo = detectSpecialEpisode(f.name);
    const isSpecialHint = Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial);
    const specialBadge = specialInfo.label || (isSpecialHint ? '特别篇' : '');

    // 单集季度：优先采用用户在单行微调的 seasonOverrides，否则特别篇默认为 0，正片默认为 defaultSeason
    const fileSeason = g.seasonOverrides?.[fid] !== undefined
      ? Number(g.seasonOverrides[fid])
      : (isSpecialHint ? 0 : defaultSeason);

    const sStr = `S${String(fileSeason).padStart(2, '0')}`;
    const epNum = g.episodeOverrides?.[fid] ?? f.episode ?? (idx + (g.startEpisode || 1));
    const eStr = `E${String(epNum).padStart(2, '0')}`;
    const seasonEpisodeStr = isMovie ? '正片' : `${sStr}${eStr}`;
    const epTitle = g.episodeTitleOverrides?.[fid] ?? f.episodeTitle ?? '';
    const meta: any = (f as any)._probedMeta || f.specs || f.tech || {};
    const techParts: string[] = [];
    const resolution = meta.videoFormat || meta.resolution;
    if (resolution) techParts.push(resolution === '4K' ? '2160p' : resolution);

    // 来源/介质规格：非 REMUX 视频一律标上全大写 WEB-DL 规范技术标签
    const isRemux = Boolean(
      meta.isRemux ||
      /REMUX/i.test(meta.resourceType || '') ||
      /REMUX/i.test(meta.mediaSource || '') ||
      /REMUX/i.test(f.name || '')
    );
    const isBluRay = Boolean(
      meta.isBluRay ||
      /Blu[- .]?Ray|\bBD\b/i.test(meta.mediaSource || '') ||
      /Blu[- .]?Ray|\bBD\b/i.test(f.name || '')
    );
    if (isRemux) {
      if (isBluRay) {
        techParts.push('BluRay.REMUX');
      } else {
        techParts.push('REMUX');
      }
    } else {
      techParts.push('WEB-DL');
    }

    if (meta.dynamicRange && meta.dynamicRange !== 'SDR') techParts.push(meta.dynamicRange);
    if (meta.colorDepth && meta.colorDepth !== '8bit') techParts.push(meta.colorDepth);
    if (meta.videoCodec) techParts.push(meta.videoCodec);
    if (meta.audioCodec) techParts.push(meta.audioCodec);
    const techTagStr = techParts.length > 0 ? '.' + techParts.join('.') : '';
    const epTitlePart = epTitle ? `.${epTitle}` : '';

    let newFileName = '';
    let targetPath = '';

    const seasonFolder = fileSeason === 0 ? 'Season 00' : `Season ${String(fileSeason).padStart(2, '0')}`;

    const targetRoot = hasUserSelectedTargetFolder.value ? currentTargetDisplayPath.value : '【未指定目标库】';
    if (g.customNameOverrides?.[fid]) {
      newFileName = g.customNameOverrides[fid].trim();
      if (isMovie) {
        targetPath = `${targetRoot}/电影/${g.targetCategory}/${titleYear}${tmdbTag}/${newFileName}`.replace(/\/+/g, '/');
      } else {
        targetPath = `${targetRoot}/剧集/${g.targetCategory}/${titleYear}${tmdbTag}/${seasonFolder}/${newFileName}`.replace(/\/+/g, '/');
      }
    } else if (keepOriginalFilename.value) {
      newFileName = f.name;
      if (isMovie) {
        targetPath = `${targetRoot}/电影/${g.targetCategory}/${titleYear}${tmdbTag}/${newFileName}`.replace(/\/+/g, '/');
      } else {
        targetPath = `${targetRoot}/剧集/${g.targetCategory}/${titleYear}${tmdbTag}/${seasonFolder}/${newFileName}`.replace(/\/+/g, '/');
      }
    } else if (isMovie) {
      const yearPart = effectiveYear ? `.${effectiveYear}` : '';
      newFileName = `${effectiveTitle}${yearPart}${techTagStr}${ext}`;
      targetPath = `${targetRoot}/电影/${g.targetCategory}/${titleYear}${tmdbTag}/${newFileName}`.replace(/\/+/g, '/');
    } else {
      newFileName = `${effectiveTitle}.${effectiveYear ? effectiveYear + '.' : ''}${sStr}${eStr}${epTitlePart}${techTagStr}${ext}`;
      targetPath = `${targetRoot}/剧集/${g.targetCategory}/${titleYear}${tmdbTag}/${seasonFolder}/${newFileName}`.replace(/\/+/g, '/');
    }

    newFileName = newFileName.replace(/\.{2,}/g, '.');
    if (newFileName.includes('.')) {
      const parts = newFileName.split('.');
      const deduped: string[] = [];
      for (const p of parts) {
        if (deduped.length > 0 && p && p.toLowerCase() === deduped[deduped.length - 1].toLowerCase()) {
          continue;
        }
        deduped.push(p);
      }
      newFileName = deduped.join('.');
    }

    return {
      fileId: fid,
      originalName: f.name,
      newFileName,
      targetPath,
      seasonNum: isMovie ? null : fileSeason,
      episodeNum: isMovie ? null : epNum,
      seasonEpisodeStr: isMovie ? '正片' : seasonEpisodeStr,
      episodeTitle: epTitle,
      size: f.size,
      specs: {
        ...meta,
        isRemux,
        isBluRay,
        resourceType: isRemux ? 'REMUX' : '',
        mediaSource: isRemux ? (isBluRay ? 'BluRay' : 'REMUX') : 'WEB-DL'
      },
      probed: Boolean(meta.probed),
      isExcluded,
      isSpecial: fileSeason === 0,
      specialBadge,
      isCustomName: Boolean(g.customNameOverrides?.[fid]),
      washStatus: groupWashStatus.value[fid] || null
    };
  });
});

// 归档目标目录（单处统一预览展示，无需逐行重复完整路径）
const targetDirectoryPreview = computed(() => {
  const g = activeGroup.value;
  if (!g) return '';
  const cand = g.tmdbCandidate;
  const isMovie = isGroupMovie(g);
  const effectiveTitle = (g.customTitle || cand?.title || cand?.name || g.rawTitle || g.folderName).trim();
  const effectiveYear = g.customYear || (cand?.release_date ? cand.release_date.substring(0, 4) : (cand?.first_air_date ? cand.first_air_date.substring(0, 4) : g.year));
  const effectiveTmdbId = cand?.id ? String(cand.id) : (g.customTmdbId || '');
  const tmdbTag = effectiveTmdbId ? ` {tmdb-${effectiveTmdbId}}` : '';
  const titleYear = effectiveYear ? `${effectiveTitle} (${effectiveYear})` : effectiveTitle;
  const defaultSeason = (g.targetSeason !== undefined && g.targetSeason !== null) ? Number(g.targetSeason) : 1;
  const seasonFolder = defaultSeason === 0 ? 'Season 00' : `Season ${String(defaultSeason).padStart(2, '0')}`;

  const targetRoot = hasUserSelectedTargetFolder.value ? currentTargetDisplayPath.value : '【请在上方指定归档媒体库】';
  if (isMovie) {
    return `${targetRoot}/电影/${g.targetCategory}/${titleYear}${tmdbTag}`.replace(/\/+/g, '/');
  }
  return `${targetRoot}/剧集/${g.targetCategory}/${titleYear}${tmdbTag}/${seasonFolder}`.replace(/\/+/g, '/');
});

// 当前选中有效入库的文件总容量
const selectedFilesSize = computed(() => {
  return previewOrganizedList.value
    .filter(it => !it.isExcluded)
    .reduce((sum, it) => sum + (Number(it.size) || 0), 0);
});

// ================= 集数清单检索、分段与分页机制 (针对 50~100+ 巨量集数下拉过长优化) =================
const episodeSearchQuery = ref('');
const episodeCurrentPage = ref(1);
const episodePageSize = ref(25); // 默认每页 25 条，支持 25, 50, 全部(-1)

// 1. 过滤后的集数列表 (支持根据集号如 88、E88、S03E88 或关键词即时过滤)
const filteredPreviewList = computed(() => {
  const query = episodeSearchQuery.value.trim().toLowerCase();
  const list = previewOrganizedList.value;
  if (!query) return list;

  return list.filter((item) => {
    const matchNum = query.match(/\d+/);
    if (matchNum && Number(matchNum[0]) === item.episodeNum) {
      return true;
    }
    if (item.seasonEpisodeStr.toLowerCase().includes(query)) return true;
    if (item.newFileName.toLowerCase().includes(query)) return true;
    if (item.originalName.toLowerCase().includes(query)) return true;
    if (item.episodeTitle && item.episodeTitle.toLowerCase().includes(query)) return true;
    return false;
  });
});

// 2. 总页数
const episodeTotalPages = computed(() => {
  if (episodePageSize.value <= 0) return 1;
  return Math.ceil(filteredPreviewList.value.length / episodePageSize.value) || 1;
});

// 3. 动态集数分段选项卡 (当总数 > 25 时按 25 集一段自动分切)
interface EpisodeSegmentTab {
  page: number;
  label: string;
  start: number;
  end: number;
  count: number;
}

const episodeSegments = computed<EpisodeSegmentTab[]>(() => {
  const total = filteredPreviewList.value.length;
  if (total <= 25) return [];

  const size = 25;
  const count = Math.ceil(total / size);
  const segments: EpisodeSegmentTab[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * size + 1;
    const end = Math.min((i + 1) * size, total);
    segments.push({
      page: i + 1,
      label: `${start}-${end}`,
      start,
      end,
      count: end - start + 1
    });
  }
  return segments;
});

// 4. 当前页实际渲染的文件清单切片
const displayedPreviewList = computed(() => {
  const list = filteredPreviewList.value;
  if (episodePageSize.value <= 0) {
    return list;
  }
  const start = (episodeCurrentPage.value - 1) * episodePageSize.value;
  return list.slice(start, start + episodePageSize.value);
});

// 5. 当前分页区间提示文案
const displayedRangeLabel = computed(() => {
  const total = filteredPreviewList.value.length;
  if (total === 0) return '0 / 0';
  if (episodePageSize.value <= 0) return `1-${total} (全部)`;
  const start = (episodeCurrentPage.value - 1) * episodePageSize.value + 1;
  const end = Math.min(episodeCurrentPage.value * episodePageSize.value, total);
  return `${start}-${end}`;
});

function selectEpisodePage(page: number) {
  if (page < 1) page = 1;
  if (page > episodeTotalPages.value) page = episodeTotalPages.value;
  episodeCurrentPage.value = page;
}

function selectEpisodeSegment(seg: EpisodeSegmentTab) {
  episodePageSize.value = 25;
  episodeCurrentPage.value = seg.page;
}

function showAllEpisodes() {
  episodePageSize.value = -1;
  episodeCurrentPage.value = 1;
}

// 监听检索或页面切换越界校准
watch([filteredPreviewList, episodePageSize], () => {
  const maxPage = episodeTotalPages.value;
  if (episodeCurrentPage.value > maxPage) {
    episodeCurrentPage.value = maxPage || 1;
  }
  if (episodeCurrentPage.value < 1) {
    episodeCurrentPage.value = 1;
  }
});

// 从单文件推导归属媒体分组目录名
function getFileGroupName(f: MediaFileItem): string {
  const isTheatricalFile = /(?:剧场版|劇場版|\b(?:The\s+)?Movie\b)/i.test(f.name || '');
  if (isTheatricalFile) {
    return String(f.name || '').replace(/\.[^/.]+$/, '').trim();
  }
  const rawPath = String(f.folderPath || f.relativePath || f.parentFolderName || '').replace(/\\/g, '/');
  const pathParts = rawPath.split('/').filter(Boolean);
  const cleanParts = pathParts.filter(p => !/^(?:临时存放|暂存区|频道转存|root)$/i.test(p));
  if (cleanParts.length > 0) {
    const theatricalPart = cleanParts.slice().reverse().find(p => /(?:剧场版|劇場版|\b(?:The\s+)?Movie\b)/i.test(p));
    if (theatricalPart) {
      return theatricalPart;
    }
    let cand = cleanParts[0];
    for (let i = 0; i < cleanParts.length; i++) {
      const seg = cleanParts[i];
      if (!/^(?:Season\s*\d+|S\d+|HD|4K|1080p|2160p)$/i.test(seg)) {
        cand = seg;
        break;
      }
    }
    return cand;
  }
  return f.parentFolderName || '未分类目录';
}

// 智能推导影视分类（对齐后端 RecognitionEngine 二级分类规范）
function inferCategoryFromCandidate(cand: any, isMovieFallback: boolean = false): string {
  if (!cand) return isMovieFallback ? '电影' : '国产剧';
  const isMovie = cand.media_type === 'movie' || (!cand.media_type && cand.title && !cand.name);
  if (cand.secondaryCategory) return cand.secondaryCategory;

  const gIds: number[] = (cand.genre_ids || cand.genreIds || []).map((id: any) => Number(id));
  const genresStr = JSON.stringify(cand.genres || '');
  const isAnime = gIds.includes(16) || cand.isAnime === true || cand.category === '动漫' || /(?:动画|动漫|Animation)/i.test(genresStr);
  const isDoc = gIds.includes(99) || cand.category === '纪录片' || /(?:纪录片|Documentary)/i.test(genresStr);
  const isVariety = gIds.includes(10764) || gIds.includes(10767) || cand.category === '综艺' || /(?:综艺|真人秀|Talk|Variety)/i.test(genresStr);
  const isKids = gIds.includes(10762) || /(?:儿童|少儿|Kids)/i.test(genresStr);
  const isMusic = gIds.includes(10402) || /(?:音乐|演唱会|Music)/i.test(genresStr);

  const rawCountries = cand.origin_country || cand.originCountry || cand.countries || cand.production_countries || [];
  const countries: string[] = (Array.isArray(rawCountries) ? rawCountries.map((c: any) => typeof c === 'object' ? (c.iso_3166_1 || c.name) : c) : [rawCountries]).map((c: any) => String(c || '').toUpperCase().trim()).filter(Boolean);
  const origLang = String(cand.original_language || cand.originalLanguage || '').toLowerCase().trim();
  const title = cand.title || cand.name || '';
  const hasChineseTitle = /[\u4e00-\u9fa5]/.test(title);

  if (isMovie) {
    if (isAnime) return '动画电影';
    if (isDoc) return '纪录片';
    if (isMusic) return '演唱会';
    if (['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || (!origLang && !countries.length && hasChineseTitle)) {
      return '华语电影';
    }
    const westernCountries = ['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL', 'PT', 'RU', 'UK', 'CA', 'AU', 'IE', 'SE', 'NO', 'DK', 'FI', 'PL', 'BE', 'AT', 'CH'];
    const westernLangs = ['en', 'fr', 'de', 'es', 'it', 'ru', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl'];
    if (countries.some(c => westernCountries.includes(c)) || westernLangs.includes(origLang)) {
      return '欧美电影';
    }
    if (countries.some(c => ['JP', 'KP', 'KR', 'TH', 'IN', 'SG'].includes(c)) || ['ja', 'ko', 'th'].includes(origLang)) {
      return '日韩电影';
    }
    return '电影';
  } else {
    if (isAnime) {
      if (countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || ['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || (!origLang && !countries.length && hasChineseTitle)) {
        return '国漫';
      }
      if (countries.some(c => ['JP'].includes(c)) || origLang === 'ja' || /[\u3040-\u309f\u30a0-\u30ff]/.test(title)) {
        return '日番';
      }
      return '动漫';
    }
    if (isVariety) return '综艺';
    if (isDoc) return '纪录片';
    if (isKids) return '儿童';
    if (isMusic) return '演唱会';
    if (['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || (!origLang && !countries.length && hasChineseTitle)) {
      return '国产剧';
    }
    const westernCountries = ['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL', 'PT', 'RU', 'UK', 'CA', 'AU', 'IE', 'SE', 'NO', 'DK', 'FI', 'PL', 'BE', 'AT', 'CH'];
    const westernLangs = ['en', 'fr', 'de', 'es', 'it', 'ru', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl'];
    if (countries.some(c => westernCountries.includes(c)) || westernLangs.includes(origLang)) {
      return '欧美剧';
    }
    if (countries.some(c => ['JP', 'KP', 'KR', 'TH', 'IN', 'SG'].includes(c)) || ['ja', 'ko', 'th'].includes(origLang)) {
      return '日韩剧';
    }
    return '国产剧';
  }
}

// 从文件名智能提取集数（支持纯数字、E215、第215集、215 4K.mkv 等各种命名范式）
function parseEpisodeNum(fileName: string): number | null {
  if (!fileName) return null;
  const name = String(fileName).trim();
  // 1. S01E215 / E215
  const m1 = name.match(/\b(?:S\d{1,2})?E(\d{1,4})\b/i);
  if (m1) return parseInt(m1[1], 10);
  // 2. 第215集 / 第215期 / EP215 / E215
  const m2 = name.match(/(?:第|\bEP|\bE)\s*(\d{1,4})\s*(?:集|话|期)?/i);
  if (m2) return parseInt(m2[1], 10);
  // 3. 215 4K.mkv / 215.mp4 / 215_xxx.mkv
  const m3 = name.match(/(?:^|[^\d])(\d{1,4})(?:\s*(?:4[kK]|1080[pP]|720[pP]|2160[pP]|HDR|SDR|H\.?26[45]|HEVC|AVC|AAC)|\.[a-zA-Z0-9]+$|\s*[-_])/i);
  if (m3) {
    const num = parseInt(m3[1], 10);
    if (num >= 1900 && num <= 2099 && /^(?:19|20)\d{2}$/.test(m3[1])) {
      const rest = name.slice(name.indexOf(m3[1]) + 4);
      const mSub = parseEpisodeNum(rest);
      if (mSub !== null) return mSub;
    } else {
      return num;
    }
  }
  // 4. 纯数字文件名 如 "01.mp4", "12.mkv"
  const m4 = name.match(/^(\d{1,4})\.[a-zA-Z0-9]+$/);
  if (m4) return parseInt(m4[1], 10);
  return null;
}

// 智能季号推导：结合 TMDB 官方季播列表、目录年份与集号范围自动定季
async function applySmartSeasonInference(g: MediaGroupItem, cand: any) {
  if (!cand || g.mediaType === 'movie') return;

  let seasons = Array.isArray(cand.seasons) ? cand.seasons : [];
  if (seasons.length === 0 && cand.id) {
    try {
      const res = await tmdbOrganizeApi.getTvSeasons(cand.id);
      if (res && Array.isArray(res.seasons)) {
        seasons = res.seasons;
        cand.seasons = seasons;
      }
    } catch {
      try {
        const res = await tmdbOrganizeApi.searchTmdb({ query: String(cand.id), mediaType: 'tv' });
        const detail = Array.isArray(res) ? res[0] : (res as any)?.results?.[0];
        if (detail && Array.isArray(detail.seasons)) {
          seasons = detail.seasons;
          cand.seasons = seasons;
        }
      } catch {}
    }
  }

  if (seasons.length > 0) {
    const validSeasons = seasons.filter((s: any) => s.season_number > 0);
    // 提取组内所有视频集数
    const fileEps = g.files.map((f: any) => {
      const fid = String(f.id);
      return Number(g.episodeOverrides?.[fid] || f.episode || parseEpisodeNum(f.name) || 0);
    }).filter((n: number) => n > 0);

    const maxEp = fileEps.length > 0 ? Math.max(...fileEps) : 0;
    const minEp = fileEps.length > 0 ? Math.min(...fileEps) : 1;

    let targetSeasonInferred: number | null = null;

    // 1. 根据最大集号寻找能够容纳该集的唯一季（例如斗破苍穹年番 215-219集 -> Season 5 容纳 219 集）
    if (maxEp > 0) {
      const candidates = validSeasons.filter((s: any) => (s.episode_count || 0) >= maxEp);
      if (candidates.length === 1) {
        targetSeasonInferred = candidates[0].season_number;
      }
    }

    // 2. 年番标识识别 (例如腾讯年番，斗破苍穹/完美世界)
    if (!targetSeasonInferred) {
      const isYearly = /(?:年番|连续播)/i.test(g.folderName || '') || /(?:年番|连续播)/i.test(cand.title || cand.name || '');
      if (isYearly) {
        const yearSeason = validSeasons.find((s: any) => /(?:年番)/i.test(s.name || ''));
        if (yearSeason) {
          targetSeasonInferred = yearSeason.season_number;
        }
      }
    }

    // 3. 根据原始目录/文件中的年份匹配对应季的首播年份
    if (!targetSeasonInferred) {
      const fileYear = g.files.map((f: any) => (f.name.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '')).find(Boolean);
      const y = g.year || (g.folderName.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '') || fileYear;
      if (y) {
        const yearMatch = validSeasons.find((s: any) => (s.air_date || '').substring(0, 4) === y);
        if (yearMatch) {
          targetSeasonInferred = yearMatch.season_number;
        }
      }
    }

    // 4. 若 TMDB 官方仅有单一常规季（例如仅有第1季），任何推断季均强制归一到该季
    if (!targetSeasonInferred && validSeasons.length === 1) {
      targetSeasonInferred = validSeasons[0].season_number;
    }

    if (targetSeasonInferred !== null && targetSeasonInferred > 0) {
      g.targetSeason = targetSeasonInferred;
      if (minEp > 1) {
        g.startEpisode = minEp;
      }
      // 同步更新所有正片文件的 seasonOverrides
      if (!g.seasonOverrides) g.seasonOverrides = {};
      for (const f of g.files) {
        const fid = String(f.id);
        const specialInfo = detectSpecialEpisode(f.name);
        const isSpecial = Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial || g.seasonOverrides[fid] === 0);
        if (!isSpecial) {
          g.seasonOverrides[fid] = targetSeasonInferred;
        }
      }
      saveWorkspaceDraft();
      return;
    }
  }
}

// 剧集微调：用户手动修改季度后，快速全组同步所有正片文件的季号
function onTargetSeasonChanged() {
  const g = activeGroup.value;
  if (!g) return;
  const newSeason = Number(g.targetSeason || 1);
  if (!g.seasonOverrides) g.seasonOverrides = {};
  for (const f of g.files) {
    const fid = String(f.id);
    const specialInfo = detectSpecialEpisode(f.name);
    const isSpecial = Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial || g.seasonOverrides[fid] === 0);
    if (!isSpecial) {
      g.seasonOverrides[fid] = newSeason;
    }
  }
  saveWorkspaceDraft();
  checkActiveGroupWashDebounced();
}

// 剧集微调：修改起始集号后自动重编
function onStartEpisodeChanged() {
  const g = activeGroup.value;
  if (!g) return;
  reorderActiveGroupEpisodes();
}

function parseCnSeason(s: string): number | null {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const CN: Record<string, number> = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  if (CN[str] !== undefined) return CN[str];
  if (str.startsWith('十') && CN[str[1]]) return 10 + CN[str[1]];
  if (str.endsWith('十') && CN[str[0]]) return CN[str[0]] * 10;
  return null;
}

function detectSeasonFromPathAndFile(f: MediaFileItem, topFolder: string): number | null {
  if (f.mediaType === 'movie') return null;
  const fullPath = String(f.folderPath || f.relativePath || '').replace(/\\/g, '/');
  const parts = fullPath.split('/').filter(Boolean);
  // 从后向前优先检测具体的 Season 03 / 第3季 / S03
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    const m0 = seg.match(/\bS(\d{1,2})\b/i);
    if (m0) return parseInt(m0[1], 10);
    const m1 = seg.match(/\b(?:Season[\s._-]*|S)(\d{1,2})\b/i);
    if (m1) return parseInt(m1[1], 10);
    const m2 = seg.match(/第\s*([0-9零一二两三四五六七八九十]+)\s*季/i);
    if (m2) {
      const p = parseCnSeason(m2[1]);
      if (p !== null) return p;
    }
  }

  // 检查文件名
  const fn = String(f.name || '');
  const fm0 = fn.match(/\bS(\d{1,2})E\d+/i);
  if (fm0) return parseInt(fm0[1], 10);
  const fm1 = fn.match(/\b(?:Season[\s._-]*|S)(\d{1,2})\b/i);
  if (fm1) return parseInt(fm1[1], 10);
  const fm2 = fn.match(/第\s*([0-9零一二两三四五六七八九十]+)\s*季/i);
  if (fm2) {
    const p = parseCnSeason(fm2[1]);
    if (p !== null) return p;
  }

  // 检查顶级文件夹 topFolder
  const tm0 = topFolder.match(/\bS(\d{1,2})\b/i);
  if (tm0) return parseInt(tm0[1], 10);
  const tm1 = topFolder.match(/\b(?:Season[\s._-]*|S)(\d{1,2})\b/i);
  if (tm1) return parseInt(tm1[1], 10);
  const tm2 = topFolder.match(/第\s*([0-9零一二两三四五六七八九十]+)\s*季/i);
  if (tm2) {
    const p = parseCnSeason(tm2[1]);
    if (p !== null) return p;
  }

  return (f.season !== undefined && f.season !== null && !isNaN(Number(f.season))) ? Number(f.season) : null;
}

// 针对国内网盘防封与推文引流特征的影视标题纯函数深度清洗
function sanitizeMediaTitle(raw: string): string {
  if (!raw) return '';
  let s = String(raw).trim().replace(/\.(?:mkv|mp4|iso|avi|rmvb|flv|ts|webm|m4v)$/i, '').trim();

  // 0. 先行剥离 {tmdb-xxxx} / [tmdbid-xxxx] 标签与残留花括号 (防止污染片名，如 "八仙！ {tmdb-1633056")
  s = s.replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]?/gi, ' ');
  s = s.replace(/[\{\}]/g, ' ');

  // 0.5. 优先提取书名号《...》中的真实片名
  const bookMatch = s.match(/《([^》]+)》/);
  if (bookMatch && bookMatch[1].trim()) {
    s = bookMatch[1].trim();
  }

  // 1. 如果整体被外层括号包裹，如【遮天】，先解构
  s = s.replace(/^[【\[（\(《]([^【】\[\]（）()《》]+)[】\]）\)》]$/, '$1').trim();

  // 2. 剥离前缀宣传标签，如【4K国漫】、【最新更新】、[1080P]、[国漫] 等
  while (/^[【\[（\(《][^】\]）\)》]+[】\]）\)》]\s*/.test(s)) {
    const next = s.replace(/^[【\[（\(《][^】\]）\)》]+[】\]）\)》]\s*/, '').trim();
    if (next) s = next;
    else break;
  }

  // 3. 剥离季号副标题，如 "：第01季", ": 第1季", " 第01季", " Season 1"
  s = s.replace(/[:：]\s*(?:第\s*\d+\s*[季部]|Season\s*\d+)/gi, ' ');
  s = s.replace(/(?:第\s*\d+\s*[季部]|Season\s*\d+)/gi, ' ');

  // 4. 剥离文件大小标签，如 "11.6G", "10.4GB", "500MB"
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:GB|MB|KB|G|M|K)\b/gi, ' ');

  // 5. 剥离括号包裹的年份 (如 "(2023)", "（2023）", "[2024]")
  s = s.replace(/[\(\[（【《]\s*(?:19\d\d|20[0-3]\d)\s*[\)\]）】》]/g, ' ');

  // 6. 剥离更新状态、集数后缀与引流宣传 (如 "100集", "更新到166集", "更至18集", "全36集", "完结", "持续更新", "139网盘" 等)
  s = s.replace(/\b\d+\s*[集话期]\b/g, ' ');
  s = s.replace(/(?:[._\-\s/]+)?(?:更新[到至中]|更[到至]|连载[到至中]|完结|已完结|全\s*\d+\s*[集话期全]|第\s*\d+\s*[集话期全]|每周[一二三四五六日天周]?\s*更[新]?|持续更新|139网盘|移动云盘|夸克网盘|夸克|百度网盘|百度云|阿里网盘|阿里云盘|天翼云盘|迅雷网盘|关注[^\s._\-]+|防封[^\s._\-]*|未删减[^\s._\-]*|内封字幕|官方原盘|4K超清|HDR版本).*/i, '');

  // 7. 剥离技术规格词与画质
  s = s.replace(/\b(?:4K|2160[pi]?|1080[pi]?|720[pi]?|480[pi]?|HD|BD|UHD|HDR\d*|DV|WEB-?DL|WEBRip|BDRip|Remux|HEVC|H\.?26[45]|x26[45]|60fps|120fps|60帧|120帧|高码率|无损|自压|S\d+(?:E\d+)?|EP?\d+)\b/gi, ' ');
  s = s.replace(/(?:[._\-\s]+)?(?:4K超清|超清4K|1080P超清|蓝光|高码率|60帧|120帧|国漫|动漫|连续剧|电影)[\s._\-]*/gi, ' ');

  // 8. 提取并清理点号/空格分隔的年份 (如 "白夜破晓.2024" -> "白夜破晓", 但保留纯片名如 "1917")
  s = s.replace(/(?<=[\u4e00-\u9fffA-Za-z])[._\-\s]+(19\d\d|20[0-3]\d)(?=[._\-\s]|$)/g, ' ');

  // 9. 剥离末尾残留的括号标签，如 [1080P/60帧], （1080P）
  s = s.replace(/[\(\[（【《][^）\]）】》]*[）\]）】》]$/g, ' ');

  // 10. 汉字间防封混淆字符处理
  s = s.replace(/([\u4e00-\u9fff])\s*[丨|｜/\\丿丶•·~～]\s*([\u4e00-\u9fff])/g, '$1$2');
  s = s.replace(/([\u4e00-\u9fff])\s*[丨|｜/\\丿丶•·~～]\s*([\u4e00-\u9fff])/g, '$1$2');
  s = s.replace(/[丨|｜丶]/g, '');

  // 11. 首尾符号清理与空格压缩
  s = s.replace(/^[《【\[（\(]+|[》】\]）\)]+$/g, ' ');
  s = s.replace(/^[^a-zA-Z0-9\u4e00-\u9fff]+|[^a-zA-Z0-9\u4e00-\u9fff]+$/g, '').replace(/\s+/g, ' ').trim();

  // 12. 停用词校验
  if (/^(?:4k|1080p|720p|hd|bd|web-?dl|hdr|全集|合集|短剧|电影|动漫|国漫|原盘|自压|修复|重制|精选|典藏|无损|更新|连载|高清|超清|标清|蓝光|原画|高码|高码率|抢先版|国语|粤语|台配|英语|日语|中字|中文字幕|双语字幕|简繁双字)+$/i.test(s)) {
    return '';
  }

  return s;
}

// 构建媒体分组结构并注入已有草稿
function buildMediaGroups(files: MediaFileItem[], draftMap: Record<string, any> = {}): MediaGroupItem[] {
  const groupsMap = new Map<string, MediaGroupItem>();

  for (const f of files) {
    const topFolder = getFileGroupName(f);
    if (!groupsMap.has(topFolder)) {
      const yearMatch = topFolder.match(/\b(19\d{2}|20\d{2})\b/);
      const extractedYear = yearMatch ? yearMatch[1] : (f.year || '');
      const cleanTop = sanitizeMediaTitle(topFolder);
      const rawTitle = cleanTop || f.cleanTitle || f.inferredTitle || topFolder;

      const isAnime = /(?:动漫|动画|日漫|国漫|Anime|日番|JOJO|DOUPO|斗破|沧元图|完美世界|仙逆|吞噬星空|大主宰|剑来|遮天|凡人修仙|大理寺|眷思量|师兄啊师兄|百炼成神|神印王座|一人之下|狐妖小红娘|灵笼)/i.test(topFolder) || /[\u3040-\u309f\u30a0-\u30ff]/.test(rawTitle);
      const isJp = /[\u3040-\u309f\u30a0-\u30ff]/.test(rawTitle) || /(?:日番|日漫|JOJO)/i.test(topFolder);
      const isTheatrical = /(?:剧场版|劇場版|\b(?:The\s+)?Movie\b)/i.test(topFolder) || /(?:剧场版|劇場版|\b(?:The\s+)?Movie\b)/i.test(f.name);
      const groupFiles = files.filter(file => getFileGroupName(file) === topFolder);
      const hasAnyTvMarker = groupFiles.some(file =>
        /\b(?:S\d{1,2}[\s._-]*E\d{1,4}|EP\d{1,4}|第\s*\d+\s*[集话期])\b/i.test(file.name) ||
        /\b(?:Season[\s._-]*\d{1,2}|S\d{1,2})\b/i.test(file.name) ||
        /第\s*[0-9零一二两三四五六七八九十]+\s*季/i.test(file.name)
      );
      const draft = draftMap[topFolder] || {};
      const isMovie = Boolean(
        draft.mediaType === 'movie' ||
        f.mediaType === 'movie' ||
        isTheatrical ||
        (!hasAnyTvMarker && groupFiles.length === 1) ||
        (f.season === null && f.episode === null) ||
        (!f.season && !f.episode)
      );
      const defaultCat = isMovie ? (isAnime ? '动画电影' : '电影') : (isAnime ? (isJp ? '日番' : '国漫') : '国产剧');

      let initialCandidate = draft.tmdbCandidate || null;
      if (!initialCandidate && f.tmdbId) {
        initialCandidate = {
          id: Number(f.tmdbId) || 0,
          tmdbId: Number(f.tmdbId) || 0,
          title: rawTitle,
          chineseTitle: rawTitle,
          year: draft.year || extractedYear,
          mediaType: isMovie ? 'movie' : 'tv'
        };
      }
      const savedCat = draft.targetCategory;
      const initialCat = initialCandidate
        ? inferCategoryFromCandidate(initialCandidate, isMovie)
        : ((savedCat && (!isAnime || savedCat === '国漫' || savedCat === '日番' || savedCat === '动漫')) ? savedCat : defaultCat);

      const finalIsMovie = Boolean(
        isMovie ||
        draft.mediaType === 'movie' ||
        (initialCat && initialCat.includes('电影')) ||
        (initialCandidate && (initialCandidate.media_type === 'movie' || initialCandidate.mediaType === 'movie' || initialCandidate.category === '电影' || (initialCandidate.secondaryCategory && initialCandidate.secondaryCategory.includes('电影'))))
      );

      const detectedSeason = finalIsMovie ? null : (detectSeasonFromPathAndFile(f, topFolder) || 1);

      groupsMap.set(topFolder, {
        id: topFolder,
        folderName: topFolder,
        folderPath: f.folderPath || ('/' + topFolder),
        rawTitle,
        year: draft.year || extractedYear,
        files: [],
        tmdbCandidate: initialCandidate,
        mediaType: finalIsMovie ? 'movie' : (draft.mediaType || 'tv'),
        targetCategory: initialCat,
        targetSeason: finalIsMovie ? null : (draft.targetSeason || detectedSeason),
        startEpisode: draft.startEpisode || 1,
        episodeOffset: draft.episodeOffset || 0,
        episodeOverrides: draft.episodeOverrides || {},
        episodeTitleOverrides: draft.episodeTitleOverrides || {},
        seasonOverrides: draft.seasonOverrides || {},
        customNameOverrides: draft.customNameOverrides || {},
        excludedFileIds: new Set(draft.excludedFileIds || []),
        isTuningCollapsed: draft.isTuningCollapsed !== undefined ? draft.isTuningCollapsed : true,
        isFilesCollapsed: false
      });
    }

    groupsMap.get(topFolder)!.files.push(f);
  }

  for (const group of groupsMap.values()) {
    group.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // 预解析所有文件的集数
    group.files.forEach((file) => {
      if (file.episode === undefined || file.episode === null) {
        const parsed = parseEpisodeNum(file.name);
        if (parsed !== null) file.episode = parsed;
      }
    });

    const parsedEps = group.files.map(f => f.episode).filter((n): n is number => n !== undefined && n !== null && n > 0);
    const minParsedEp = parsedEps.length > 0 ? Math.min(...parsedEps) : 1;
    if (group.startEpisode === 1 && minParsedEp > 1) {
      group.startEpisode = minParsedEp;
    }

    let regularCounter = group.startEpisode || 1;
    let specialCounter = 1;

    group.files.forEach((file) => {
      const fid = String(file.id);
      const specialInfo = detectSpecialEpisode(file.name);
      const isFileSpecial = Boolean(file.isSpecial || file.season === 0 || specialInfo.isSpecial);

      // 如果文件路径含有明确的 Season 03 / 第三季，且组 targetSeason 仍为默认 1，自动对齐为该季
      const fileDetectedSeason = detectSeasonFromPathAndFile(file, group.folderName);
      if (fileDetectedSeason !== null && fileDetectedSeason > 0 && group.targetSeason === 1 && !isGroupMovie(group)) {
        group.targetSeason = fileDetectedSeason;
      }

      if (group.seasonOverrides[fid] === undefined) {
        if (isFileSpecial) {
          group.seasonOverrides[fid] = 0;
        } else if (fileDetectedSeason !== null && fileDetectedSeason > 0 && !isGroupMovie(group)) {
          group.seasonOverrides[fid] = fileDetectedSeason;
        }
      }

      const effSeason = group.seasonOverrides[fid] !== undefined
        ? group.seasonOverrides[fid]
        : (isFileSpecial ? 0 : (isGroupMovie(group) ? null : group.targetSeason));

      if (group.episodeOverrides[fid] === undefined) {
        if (effSeason === 0) {
          group.episodeOverrides[fid] = file.episode || specialCounter++;
        } else if (effSeason !== null) {
          group.episodeOverrides[fid] = file.episode || regularCounter++;
        }
      }
    });
  }

  return Array.from(groupsMap.values());
}

// 本地草稿与记忆持久化 (Requirement 3)
const DRAFT_STORAGE_KEY = 'cloudpan_unrecognized_workspace_v2';

function saveWorkspaceDraft() {
  try {
    const draftGroups: Record<string, any> = {};
    for (const g of mediaGroups.value) {
      draftGroups[g.id] = {
        tmdbCandidate: g.tmdbCandidate,
        mediaType: g.mediaType,
        targetCategory: g.targetCategory,
        targetSeason: g.targetSeason,
        startEpisode: g.startEpisode,
        episodeOffset: g.episodeOffset,
        episodeOverrides: g.episodeOverrides,
        episodeTitleOverrides: g.episodeTitleOverrides,
        seasonOverrides: g.seasonOverrides || {},
        customNameOverrides: g.customNameOverrides || {},
        excludedFileIds: Array.from(g.excludedFileIds),
        isTuningCollapsed: g.isTuningCollapsed
      };
    }
    const payload = {
      accountId: selectedAccountId.value,
      stagingFolderId: unrecognizedStagingFolderId.value,
      stagingFolderName: unrecognizedStagingPath.value,
      activeGroupId: activeGroupId.value,
      timestamp: Date.now(),
      draftGroups,
      scannedFiles: unrecognizedFiles.value
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadWorkspaceDraft(): { draftGroups: Record<string, any>, scannedFiles: MediaFileItem[], activeGroupId?: string } | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.scannedFiles) && parsed.scannedFiles.length > 0) {
      if (!selectedAccountId.value || String(parsed.accountId) === String(selectedAccountId.value)) {
        return {
          draftGroups: parsed.draftGroups || {},
          scannedFiles: parsed.scannedFiles,
          activeGroupId: parsed.activeGroupId
        };
      }
    }
  } catch (_) {}
  return null;
}

// 整理推演结果 (0 物理写入沙箱)
const previewGroups = ref<OrganizeGroup[]>([]);
const previewTasks = ref<OrganizeTask[]>([]);
const previewSummary = ref<OrganizeSummary>({
  total: 0,
  ready: 0,
  fallbackCount: 0,
  protectedCount: 0,
  suspiciousCount: 0,
  unmatchedCount: 0,
  discardCount: 0
});

// 提取推演主剧集元信息卡片
const primaryGroup = computed(() => {
  if (previewGroups.value.length > 0) {
    return previewGroups.value[0];
  }
  if (previewTasks.value.length > 0) {
    const t = previewTasks.value[0];
    return {
      title: t.title || t.newName || '影视剧集',
      mediaType: (t.season || t.episode) ? 'tv' : 'movie',
      year: '',
      season: t.season || 1,
      totalEpisodes: previewTasks.value.length
    } as any;
  }
  return null;
});

// 加载账号与历史
async function loadAccounts() {
  try {
    const list = await accountApi.getAccounts();
    accounts.value = (list || []).filter((a: AccountItem) => a.accountType === 'cloud139');
    let savedAccountId: string | null = null;
    try {
      savedAccountId = localStorage.getItem('cloudpan_preferred_account_id_v1');
    } catch (_) {}
    const targetId = strategyConfig.value.accountId || savedAccountId || selectedAccountId.value;
    const exists = accounts.value.find((a: AccountItem) => String(a.id) === String(targetId));
    if (exists) {
      selectedAccountId.value = exists.id;
    } else {
      const active = accounts.value.find((a: AccountItem) => a.isActive && a.memberStatus !== 'auth_failed');
      const defaultAcc = accounts.value.find((a: AccountItem) => a.isDefault);
      selectedAccountId.value = (active || defaultAcc || accounts.value[0])?.id || '';
    }
  } catch (err: any) {
    ElMessage.error(`加载网盘账号失败: ${err.message}`);
  } finally {
    accountsLoaded.value = true;
  }
}

async function loadStrategyConfig() {
  try {
    const res = await channelApi.getGlobalConfig();
    if (res) {
      const isTargetCleared = (() => {
        try {
          return localStorage.getItem(WORKBENCH_TARGET_CLEARED_KEY) === 'true';
        } catch (_) {
          return false;
        }
      })();
      const targetFolderId = isTargetCleared ? '' : (res.defaultTargetFolderId || '');
      const targetFolderName = isTargetCleared ? '' : ((res.defaultTargetFolderName && res.defaultTargetFolderName !== '默认媒体库' && res.defaultTargetFolderName !== '默认媒体库 (/)') ? res.defaultTargetFolderName : '');

      strategyConfig.value = {
        ...strategyConfig.value,
        ...res,
        stagingFolderId: res.stagingFolderId || '',
        stagingFolderName: (res.stagingFolderName && res.stagingFolderName !== '/暂存区/频道转存') ? res.stagingFolderName : '/临时存放',
        defaultTargetFolderId: targetFolderId,
        accountId: res.accountId || strategyConfig.value.accountId || '',
        defaultTargetFolderName: targetFolderName,
        scanInterval: res.scanInterval ?? 5,
        organizeInterval: res.organizeInterval ?? 30,
        organizeCron: res.organizeCron || '*/30 * * * *',
        minFileSize: res.minFileSize ?? 50,
        linkStrm: Boolean(res.linkStrm),
        notifyOnStrm: Boolean(res.notifyOnStrm),
        washPriorityOrder: Array.isArray(res.washPriorityOrder) && res.washPriorityOrder.length ? res.washPriorityOrder : [
          'videoFormat',
          'dynamicRange',
          'videoCodec',
          'resourceType',
          'releaseGroup',
          'colorDepth',
          'audioCodec',
          'frameRate',
          'fileSize'
        ],
      };
      // 同步给手工沙箱预设
      if (res.stagingFolderId) manualOrganizeConfig.value.sourceDirId = res.stagingFolderId;
      if (res.stagingFolderName) manualOrganizeConfig.value.sourceDirPath = (res.stagingFolderName !== '/暂存区/频道转存' ? res.stagingFolderName : '/临时存放');
      const safeTargetDir = (res.defaultTargetFolderName && res.defaultTargetFolderName !== '默认媒体库' && res.defaultTargetFolderName !== '默认媒体库 (/)') ? res.defaultTargetFolderName : '/媒体库';
      manualOrganizeConfig.value.targetDirPath = safeTargetDir;
      if (res.includeEpisodeTitle !== undefined) manualOrganizeConfig.value.includeEpisodeTitle = res.includeEpisodeTitle;
    }
  } catch (err: any) {
    ElMessage.error(`加载整理策略异常: ${err.message}`);
  }
}

let searchTimer: any = null;
function onSearchChange() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    loadHistory();
  }, 350);
}

function handleSearch() {
  clearTimeout(searchTimer);
  currentPage.value = 1;
  loadHistory();
}

async function loadHistory() {
  loading.value = true;
  try {
    const isWash = isWashRoute.value || activeMainTab.value === 'wash_history';
    const filterStatus = activeFilter.value === 'all' ? undefined : activeFilter.value;
    const res = await tmdbOrganizeApi.getHistory({
      page: isWash ? 1 : currentPage.value,
      pageSize: isWash ? 100 : pageSize.value,
      tab: isWash ? 'wash' : undefined,
      status: isWash ? undefined : filterStatus,
      excludeStatus: (!isWash && !filterStatus) ? 'skipped' : undefined,
      search: (!isWash && searchQuery.value.trim()) ? searchQuery.value.trim() : undefined
    });
    historyRecords.value = res.records || [];
    totalHistory.value = res.total || 0;
    selectedIds.value.clear();
    washSelectedIds.value.clear();
  } catch (err: any) {
    ElMessage.error(`获取整理历史失败: ${err.message}`);
  } finally {
    loading.value = false;
  }
}

// 整理流水记录显示数据 (已由后端 SQL 高性能分页并隔离 skipped 记录，保证每页数量严格稳定，无随意跳跃)
const filteredRecords = computed(() => {
  return historyRecords.value;
});

const totalPages = computed(() => Math.ceil(totalHistory.value / pageSize.value) || 1);

// 批量勾选与操作
function toggleSelect(id: number) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
}

function toggleSelectAll() {
  if (selectedIds.value.size === filteredRecords.value.length) {
    selectedIds.value.clear();
  } else {
    selectedIds.value = new Set(filteredRecords.value.map(r => r.id));
  }
}

// 原位胶囊确认状态 (零弹窗规范)
const batchRollbackConfirm = ref(false);
async function handleBatchRollback() {
  if (selectedIds.value.size === 0) return;
  if (!batchRollbackConfirm.value) {
    batchRollbackConfirm.value = true;
    return;
  }
  batchRollbackConfirm.value = false;
  const ids = Array.from(selectedIds.value);
  loading.value = true;
  let successCount = 0;
  for (const id of ids) {
    try {
      await tmdbOrganizeApi.rollback({ recordId: id, accountId: selectedAccountId.value });
      successCount++;
    } catch (_) {}
  }
  ElMessage.success(`批量撤回完成，成功恢复 ${successCount} 项！`);
  await loadHistory();
}

const batchDeleteConfirm = ref(false);
async function handleBatchDelete() {
  if (selectedIds.value.size === 0) return;
  if (!batchDeleteConfirm.value) {
    batchDeleteConfirm.value = true;
    return;
  }
  batchDeleteConfirm.value = false;
  const ids = Array.from(selectedIds.value);
  try {
    await tmdbOrganizeApi.batchDeleteRecords(ids);
    ElMessage.success(`已删除 ${ids.length} 条整理记录`);
    await loadHistory();
  } catch (err: any) {
    ElMessage.error(`删除失败: ${err.message}`);
  }
}

const clearProtectedConfirm = ref(false);
async function handleClearProtected() {
  if (!clearProtectedConfirm.value) {
    clearProtectedConfirm.value = true;
    return;
  }
  clearProtectedConfirm.value = false;
  try {
    const res = await tmdbOrganizeApi.clearProtectedRecords();
    ElMessage.success(`已清空 ${res.count || 0} 条原地保护记录`);
    await loadHistory();
  } catch (err: any) {
    ElMessage.error(`清空失败: ${err.message}`);
  }
}

// 手动整理双栏沙箱交互 (零弹窗：专有一级 Tab)
function openManualOrganize(presetPath?: string) {
  if (presetPath) {
    manualOrganizeConfig.value.sourceDirPath = presetPath;
    manualOrganizeConfig.value.sourceDirId = presetPath;
  }
  switchTab('manual');
  loadUnrecognizedFiles(presetPath);
}

// ================= 未识别媒体分组治理与人工纠偏核心业务逻辑 =================
async function loadUnrecognizedFiles(customFolderId?: string, forceRefresh = false) {
  if (!selectedAccountId.value) {
    if (!accountsLoaded.value) {
      await loadAccounts();
    }
    if (!selectedAccountId.value && accounts.value.length > 0) {
      const active = accounts.value.find((a: AccountItem) => a.isActive && a.memberStatus !== 'auth_failed');
      const defaultAcc = accounts.value.find((a: AccountItem) => a.isDefault);
      selectedAccountId.value = (active || defaultAcc || accounts.value[0])?.id || '';
    }
    if (!selectedAccountId.value) {
      ElMessage.warning('请先绑定并选择 139 移动云盘账号');
      return;
    }
  }

  // 1. 若非强制刷新，优先从本地表单草稿与扫描快照进行秒级呈现 (SWR 模式：先展示、后异步校准)
  if (!forceRefresh) {
    const cached = loadWorkspaceDraft();
    if (cached && Array.isArray(cached.scannedFiles) && cached.scannedFiles.length > 0) {
      unrecognizedFiles.value = cached.scannedFiles;
      mediaGroups.value = buildMediaGroups(cached.scannedFiles, cached.draftGroups);
      // 智能复核与校验已关联候选的季号对齐
      for (const g of mediaGroups.value) {
        if (g.tmdbCandidate && g.mediaType !== 'movie') {
          applySmartSeasonInference(g, g.tmdbCandidate);
        }
      }
      if (cached.activeGroupId && mediaGroups.value.some(g => g.id === cached.activeGroupId)) {
        activeGroupId.value = cached.activeGroupId;
      } else if (mediaGroups.value.length > 0) {
        activeGroupId.value = mediaGroups.value[0].id;
      }
      syncSearchFromActiveGroup();
      // 注意：不中断流程，继续异步发起云盘权威扫描，消除文件已被物理移除但残留幽灵缓存的弊端
    }
  }

  // 2. 向 139 网盘发起真实轻量扫描
  loadingUnrecognized.value = true;
  startScanProgress();
  try {
    let targetFolderId = customFolderId || unrecognizedStagingFolderId.value;
    if (!targetFolderId) {
      try {
        const saved = JSON.parse(localStorage.getItem(WORKBENCH_LAST_FOLDER_KEY) || '{}');
        if (saved && (saved.id || saved.name)) {
          targetFolderId = saved.id || saved.name;
          unrecognizedStagingFolderId.value = saved.id || '';
          unrecognizedStagingPath.value = saved.name || '';
        }
      } catch (_) {}
    }

    if (!targetFolderId) {
      // 用户尚未选择待整理网盘文件夹，直接停留在引导视图，坚决不盲目私自扫描临时存放目录
      loadingUnrecognized.value = false;
      stopScanProgress();
      return;
    }

    // 增加 45 秒超时竞态（网盘递归深层扫描安全阈值），杜绝网络或网盘接口偶发挂起导致前端永久转圈
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('云盘响应超时(45s)，已为您呈现本地快照资产')), 45000)
    );

    const res: any = await Promise.race([
      tmdbOrganizeApi.getUnrecognizedFiles({
        folderId: targetFolderId,
        accountId: selectedAccountId.value,
        minFileSizeMb: minFileSizeFilterMb.value
      }),
      timeoutPromise
    ]);

    isFolderLocked.value = Boolean(res?.isLocked);
    folderLockInfo.value = { owner: res?.lockOwner || '', task: res?.lockTask || '' };
    if (res.stagingFolderName) {
      unrecognizedStagingPath.value = res.stagingFolderName;
    }
    if (res.stagingFolderId) {
      unrecognizedStagingFolderId.value = res.stagingFolderId;
    }
    if (unrecognizedStagingFolderId.value && unrecognizedStagingPath.value) {
      try {
        localStorage.setItem(WORKBENCH_LAST_FOLDER_KEY, JSON.stringify({
          id: unrecognizedStagingFolderId.value,
          name: unrecognizedStagingPath.value
        }));
      } catch (_) {}
    }

    let serverFiles = res.unrecognizedFiles || [];
    if (Array.isArray(res.allFiles) && res.allFiles.length > 0) {
      serverFiles = res.allFiles.filter((f: any) => f.isVideo || f.isSidecar);
    }
    unrecognizedFiles.value = serverFiles;
    allScannedFiles.value = res.allFiles || [];
    residualFolders.value = res.residualFolders || [];

    // 若云盘源暂存区已无有效媒体文件，立即清理幽灵缓存与分组
    if (serverFiles.length === 0) {
      mediaGroups.value = [];
      activeGroupId.value = '';
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }

    // 合并现有草稿，确保未归档影视剧历史配置不丢失 (Requirement 3)
    const cached = loadWorkspaceDraft();
    const draftMap = cached?.draftGroups || {};
    mediaGroups.value = buildMediaGroups(unrecognizedFiles.value, draftMap);
    for (const g of mediaGroups.value) {
      if (g.tmdbCandidate && !isGroupMovie(g)) {
        applySmartSeasonInference(g, g.tmdbCandidate);
      }
      // 对具备显式 tmdbId 的组，若尚未拉取到真实海报与分类，发起快速回填
      if (g.tmdbCandidate && (!g.tmdbCandidate.poster_path || g.tmdbCandidate.title === g.rawTitle)) {
        const tid = g.tmdbCandidate.id || g.tmdbCandidate.tmdbId;
        if (tid) {
          tmdbOrganizeApi.searchTmdb({ query: String(tid) }).then((idRes: any) => {
            const list = Array.isArray(idRes) ? idRes : (idRes?.results || []);
            if (list.length > 0) {
              const fullCand = list[0];
              g.tmdbCandidate = fullCand;
              const isMovie = fullCand.media_type === 'movie' || fullCand.mediaType === 'movie' || fullCand.category === '电影' || (!fullCand.media_type && fullCand.title && !fullCand.name) || (fullCand.secondaryCategory && fullCand.secondaryCategory.includes('电影')) || isGroupMovie(g);
              g.mediaType = isMovie ? 'movie' : 'tv';
              if (isMovie) g.targetSeason = null;
              g.targetCategory = inferCategoryFromCandidate(fullCand, isMovie);
            }
          }).catch(() => {});
        }
      }
    }

    if (activeGroupId.value && mediaGroups.value.some(g => g.id === activeGroupId.value)) {
      // 保持当前选中的分组
    } else if (mediaGroups.value.length > 0) {
      activeGroupId.value = mediaGroups.value[0].id;
    } else {
      activeGroupId.value = '';
    }

    syncSearchFromActiveGroup();
    saveWorkspaceDraft();
    silentProbeAndWashActiveGroup();
  } catch (err: any) {
    ElMessage.error(`加载待整理媒体文件失败: ${err.message}`);
  } finally {
    loadingUnrecognized.value = false;
    stopScanProgress();
  }
}

// 一键清空任务按钮功能
async function clearAllTasks() {
  try {
    await ElMessageBox.confirm(
      '确定要清空刮削工作台当前显示的所有待治理任务与分组吗？这不会删除云盘中的任何文件，仅重置工作台任务展示列表并清空本地暂存草稿。',
      '一键清空待治理任务',
      {
        confirmButtonText: '确定清空',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );
    mediaGroups.value = [];
    unrecognizedFiles.value = [];
    allScannedFiles.value = [];
    activeGroupId.value = '';
    selectedFileIdsForSplit.value.clear();
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch (_) {}
    ElMessage.success('已清空当前工作台所有待治理任务列表');
  } catch (_) {
    // 用户取消无需处理
  }
}

// 清空本地工作区草稿缓存并强制全量重新检索云盘
function clearWorkspaceDraftAndReload() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    unrecognizedFiles.value = [];
    allScannedFiles.value = [];
    mediaGroups.value = [];
    activeGroupId.value = '';
  } catch (_) {}
  loadUnrecognizedFiles(unrecognizedStagingFolderId.value, true);
  ElMessage.success('已清空本地工作区缓存，正在穿透扫描云盘目录');
}

// 唤出云盘目录选择树挑选希望整理的文件夹
function pickWorkbenchFolder() {
  openFolderPicker('manual-source');
}

// 拆分当前分组中勾选的文件到新独立分组
function splitSelectedFilesToNewGroup() {
  if (!activeGroup.value) return;
  const selected = Array.from(selectedFileIdsForSplit.value);
  if (selected.length === 0) {
    ElMessage.warning('请先在文件列表中勾选需要拆分的文件');
    return;
  }
  if (selected.length >= activeGroup.value.files.length) {
    ElMessage.warning('不能拆分全部分组文件，请至少保留一个文件在原分组');
    return;
  }
  const movingFiles = activeGroup.value.files.filter(f => selected.includes(String(f.id)));
  activeGroup.value.files = activeGroup.value.files.filter(f => !selected.includes(String(f.id)));

  const newGroupId = `${activeGroup.value.folderName}_拆分组_${String(Date.now()).slice(-4)}`;
  const newGroup: MediaGroupItem = {
    ...JSON.parse(JSON.stringify(activeGroup.value)),
    id: newGroupId,
    folderName: newGroupId,
    rawTitle: `${activeGroup.value.rawTitle} (分季)`,
    files: movingFiles,
    targetSeason: Number((activeGroup.value.targetSeason || 1) + 1),
    excludedFileIds: new Set()
  };
  mediaGroups.value.push(newGroup);
  activeGroupId.value = newGroupId;
  selectedFileIdsForSplit.value.clear();
  ElMessage.success(`成功拆分出新媒体分组: 《${newGroupId}》(${movingFiles.length} 个文件)`);
}

// 一键清理暂存区中残留的废弃空目录与广告说明文件
async function handleCleanResidualFolders() {
  if (cleaningResidual.value || residualFolders.value.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `检测到暂存区中存在 ${residualFolders.value.length} 个已无视频资产的残留空目录/废弃广告说明文件夹：\n` +
      residualFolders.value.map(f => `• ${f.name}`).join('\n') +
      `\n\n是否立即将其安全移入 139 云盘回收站？`,
      '清理暂存区残留废弃目录',
      { confirmButtonText: '立即清理移入回收站', cancelButtonText: '取消', type: 'warning' }
    );
  } catch (_) {
    return;
  }

  cleaningResidual.value = true;
  try {
    const res = await tmdbOrganizeApi.cleanResidualFolders({
      folderIds: residualFolders.value.map(f => f.id),
      accountId: selectedAccountId.value
    });
    ElMessage.success(res.message || '已成功清理暂存区残留目录！');
    residualFolders.value = [];
    await loadUnrecognizedFiles(undefined, true);
  } catch (err: any) {
    ElMessage.error(`清理失败: ${err.message || '网络异常'}`);
  } finally {
    cleaningResidual.value = false;
  }
}

// 切换选中的媒体分组
function selectActiveGroup(groupId: string) {
  activeGroupId.value = groupId;
  episodeSearchQuery.value = '';
  episodeCurrentPage.value = 1;
  aiDialogueExplanation.value = activeGroup.value?.aiExplanation || '';
  syncSearchFromActiveGroup();
  saveWorkspaceDraft();
  silentProbeAndWashActiveGroup();
}

// TMDB 候选卡片收缩/展开状态（选定后自动缩回，支持手动展开切换）
const isCandidatesCollapsed = ref(true);
const isAiIdentifying = ref(false);
const aiDialogueExplanation = ref('');

// 联动活跃分组的搜索框与候选状态 (Requirement 2)
function syncSearchFromActiveGroup() {
  aiDialogueExplanation.value = '';
  const g = activeGroup.value;
  if (!g) {
    tmdbSearchQuery.value = '';
    tmdbCandidates.value = [];
    isCandidatesCollapsed.value = true;
    return;
  }
  tmdbSearchQuery.value = g.tmdbCandidate ? (g.tmdbCandidate.title || g.tmdbCandidate.name) : g.rawTitle;
  tmdbSearchMediaType.value = g.mediaType || 'tv';
  if (g.tmdbCandidate) {
    tmdbCandidates.value = [g.tmdbCandidate];
    isCandidatesCollapsed.value = true;
  } else {
    tmdbCandidates.value = [];
    isCandidatesCollapsed.value = false;
  }
}

// 针对当前活跃分组发起 TMDB 搜索 (支持片名与 TMDB ID 混合搜索，Requirement 2)
async function doSearchTmdb() {
  const q = tmdbSearchQuery.value.trim();
  if (!q) {
    ElMessage.warning('请输入搜索片名或 TMDB ID');
    return;
  }
  isSearchingTmdb.value = true;
  try {
    const results = await tmdbOrganizeApi.searchTmdb({
      query: q,
      mediaType: tmdbSearchMediaType.value || undefined
    });
    tmdbCandidates.value = results || [];
    isCandidatesCollapsed.value = false;
    if (tmdbCandidates.value.length === 0) {
      ElMessage.info('未在 TMDB 中搜索到匹配结果，您可尝试精简关键词或使用【AI 辅助识别】');
    }
  } catch (err: any) {
    ElMessage.error(`TMDB 搜索失败: ${err.message}`);
  } finally {
    isSearchingTmdb.value = false;
  }
}

// AI 智能辅助识别与影视条目提纯
async function doAiIdentify() {
  const g = activeGroup.value;
  if (!g) return;
  isAiIdentifying.value = true;
  try {
    const res = await tmdbOrganizeApi.aiIdentify({
      query: tmdbSearchQuery.value || g.rawTitle || g.folderName,
      folderName: g.folderName,
      files: g.files,
      accountId: selectedAccountId.value,
      tmdbId: g.tmdbCandidate?.id || g.tmdbId,
      tmdbCandidate: g.tmdbCandidate
    });
    if (res) {
      if (res.aiTitle) {
        tmdbSearchQuery.value = res.aiTitle;
      }
      aiDialogueExplanation.value = res.aiExplanation || res.rawAiResult?.data?.replyText || '';
      tmdbCandidates.value = res.candidates || [];
      isCandidatesCollapsed.value = false;

      // 智能采纳 AI 提纯的模态、季度与类别
      const isAiMovie = res.aiType === 'movie' || res.rawAiResult?.data?.mediaType === 'movie' || (res.aiCategory && res.aiCategory.includes('电影'));
      if (isAiMovie) {
        g.mediaType = 'movie';
        g.targetSeason = null;
        onTargetSeasonChanged();
      } else if (res.aiSeason !== undefined && res.aiSeason !== null && g.mediaType !== 'movie') {
        g.targetSeason = Number(res.aiSeason);
        onTargetSeasonChanged();
      }
      if (res.aiCategory) {
        g.targetCategory = res.aiCategory;
      }

      // 若当前组未绑定 TMDB 且 AI 返回了匹配候选，自动首选第一条候选
      if (!g.tmdbCandidate && res.candidates && res.candidates.length > 0) {
        selectTmdbCandidate(res.candidates[0]);
      } else {
        silentProbeAndWashActiveGroup();
      }

      const srcText = res.rawAiResult?.data?.source === 'mobile' ? '中国移动灵犀 AI' : 'AI 智能';
      if (res.candidates && res.candidates.length > 0) {
        ElMessage.success(`${srcText}分析提纯为: 《${res.aiTitle}》 (${res.aiYear || '无年份'})，已匹配 ${res.candidates.length} 条 TMDB 候选！`);
      } else {
        ElMessage.info(`${srcText}提纯片名为: 《${res.aiTitle}》，TMDB 检索候选中，您可尝试进一步微调关键词`);
      }
    }
  } catch (err: any) {
    ElMessage.error(`AI 辅助识别失败: ${err.message}`);
  } finally {
    isAiIdentifying.value = false;
  }
}

// 选定 TMDB 候选条目
function selectTmdbCandidate(cand: any) {
  const g = activeGroup.value;
  if (!g) return;

  g.tmdbCandidate = cand;
  // 点击完卡片后立即自动缩回折叠，保持工作台紧凑！
  isCandidatesCollapsed.value = true;
  const isMovie = cand.media_type === 'movie' || cand.mediaType === 'movie' || cand.category === '电影' || (!cand.media_type && cand.title && !cand.name) || (cand.secondaryCategory && cand.secondaryCategory.includes('电影')) || isGroupMovie(g);
  g.mediaType = isMovie ? 'movie' : 'tv';
  if (isMovie) {
    g.targetSeason = null;
  }

  g.targetCategory = inferCategoryFromCandidate(cand, isMovie);

  // 智能微调季度推导 (Season)
  if (!isMovie) {
    applySmartSeasonInference(g, cand);
  }

  saveWorkspaceDraft();
  ElMessage.success(`已为《${g.folderName}》关联 TMDB: 《${cand.title || cand.name}》[${g.targetCategory}]`);
  silentProbeAndWashActiveGroup();
}

// 物理流媒体规格嗅探 (基于 139 直链 HTTP Range 与 WASM MediaInfo) 与 媒体库洗版预检
const probingCurrentGroup = ref(false);
const groupWashStatus = ref<Record<string, any>>({});
const checkingWash = ref(false);
let washCheckTimer: any = null;

function checkActiveGroupWashDebounced() {
  if (washCheckTimer) clearTimeout(washCheckTimer);
  washCheckTimer = setTimeout(() => {
    checkActiveGroupWash();
  }, 300);
}

// 目标媒体库洗版仲裁预检 (比对媒体库已有同集画质)
async function checkActiveGroupWash() {
  const g = activeGroup.value;
  if (!g || !g.tmdbCandidate) return;
  checkingWash.value = true;
  try {
    const effectiveTitle = (g.tmdbCandidate?.title || g.tmdbCandidate?.name || g.rawTitle).trim();
    const effectiveYear = g.tmdbCandidate?.release_date ? g.tmdbCandidate.release_date.substring(0, 4) : (g.tmdbCandidate?.first_air_date ? g.tmdbCandidate.first_air_date.substring(0, 4) : g.year);
    const effectiveTmdbId = g.tmdbCandidate?.id ? String(g.tmdbCandidate.id) : '';

    const itemsPayload = previewOrganizedList.value.map((item: any) => {
      const originalFile = g.files.find((f: any) => String(f.id) === item.fileId);
      return {
        fileId: item.fileId,
        name: item.originalName,
        size: item.size,
        targetTmdbId: effectiveTmdbId,
        targetTitle: effectiveTitle,
        targetYear: effectiveYear,
        targetMediaType: isGroupMovie(g) ? 'movie' : g.mediaType,
        targetCategory: g.targetCategory,
        targetSeason: isGroupMovie(g) ? undefined : item.seasonNum,
        targetEpisode: isGroupMovie(g) ? undefined : item.episodeNum,
        targetNewFileName: item.newFileName,
        probedMeta: (originalFile as any)?._probedMeta || originalFile?.specs
      };
    });

    const res = await tmdbOrganizeApi.washCheck({
      accountId: selectedAccountId.value,
      targetDirPath: currentTargetDisplayPath.value || '/媒体库',
      items: itemsPayload
    });
    if (res && typeof res === 'object') {
      groupWashStatus.value = Object.assign({}, groupWashStatus.value, res);
    }
  } catch (err: any) {
    console.warn('静默洗版预检异常:', err);
  } finally {
    checkingWash.value = false;
  }
}

// 静默嗅探与洗版预检：自动无感知执行，无需手动点击按钮
async function silentProbeAndWashActiveGroup(forceProbe = false) {
  const g = activeGroup.value;
  if (!g || !Array.isArray(g.files) || g.files.length === 0) return;

  const unprobedFiles = g.files.filter((f: any) => {
    if (forceProbe) return true;
    return !((f as any)._probedMeta || f.specs);
  });

  if (unprobedFiles.length > 0) {
    probingCurrentGroup.value = true;
    try {
      const items = unprobedFiles.map((f: any) => ({
        fileId: String(f.id),
        name: f.name,
        size: f.size,
        isVideo: true
      }));
      const probedMap = await tmdbOrganizeApi.probeGroup({
        accountId: selectedAccountId.value,
        items
      });
      if (probedMap && typeof probedMap === 'object') {
        for (const f of g.files) {
          const fid = String(f.id);
          if (probedMap[fid]) {
            (f as any)._probedMeta = probedMap[fid];
            f.specs = probedMap[fid];
          }
        }
        saveWorkspaceDraft();
      }
    } catch (err: any) {
      console.warn('静默嗅探规格轻微异常 (自动回退至文件名推导):', err);
    } finally {
      probingCurrentGroup.value = false;
    }
  }

  // 嗅探完成后，若已选定 TMDB 候选条目，立即静默触发洗版预检
  if (g.tmdbCandidate) {
    checkActiveGroupWash();
  }
}

// 兼容外部方法调用
function probeActiveGroupSpecs() {
  return silentProbeAndWashActiveGroup(true);
}

// 自动识别元数据：从当前分组原始文件夹名重算清洗
function autoIdentifyMetadata() {
  const g = activeGroup.value;
  if (!g) return;
  tmdbSearchQuery.value = g.rawTitle;
  tmdbSearchMediaType.value = g.mediaType;
  doSearchTmdb();
}

// 一键智能匹配所有待匹配的分组 (结合 TMDB 官方权威指纹与中国移动 139 灵犀 AI 大模型)
const autoMatchingAll = ref(false);
const autoMatchProgressText = ref('正在批量匹配...');

async function autoMatchAllGroups() {
  const unmatched = mediaGroups.value.filter(g => !g.tmdbCandidate);
  if (unmatched.length === 0) {
    ElMessage.info('所有媒体分组均已匹配 TMDB 条目');
    return;
  }
  autoMatchingAll.value = true;
  let successCount = 0;

  for (let idx = 0; idx < unmatched.length; idx++) {
    const group = unmatched[idx];
    const cleanTitle = (group.rawTitle || group.folderName).trim();
    autoMatchProgressText.value = `智能匹配 [${idx + 1}/${unmatched.length}] 《${cleanTitle.slice(0, 8)}》`;

    try {
      // 阶段 1: 检查是否存在显式 {tmdb-xxxx} 标签或 f.tmdbId 权威指纹
      const explicitTmdbMatch = group.folderName.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i)
        || group.files.map((f: any) => (f.name || '').match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i)).find(Boolean);
      const explicitId = explicitTmdbMatch ? explicitTmdbMatch[1] : (group.tmdbCandidate?.id ? String(group.tmdbCandidate.id) : '');

      let matchedCandidate: any = null;

      if (explicitId) {
        const idResults: any = await tmdbOrganizeApi.searchTmdb({ query: explicitId }).catch(() => []);
        const idList = Array.isArray(idResults) ? idResults : (idResults?.results || []);
        if (idList.length > 0) {
          matchedCandidate = idList[0];
        }
      }

      // 阶段 2: 若无显式 ID，发起宽模态 TMDB 检索 (不强制限定为 tv)
      if (!matchedCandidate) {
        const queryTitle = sanitizeMediaTitle(group.rawTitle || group.folderName);
        const searchRes: any = await tmdbOrganizeApi.searchTmdb({
          query: queryTitle,
          mediaType: group.mediaType === 'movie' ? 'movie' : undefined
        }).catch(() => []);
        const candidates = Array.isArray(searchRes) ? searchRes : (searchRes?.results || []);
        if (candidates.length > 0) {
          matchedCandidate = candidates[0];
        }
      }

      // 阶段 3: 灵犀 AI 终极消歧与深度提纯 (当常规匹配未命中时)
      if (!matchedCandidate) {
        try {
          const aiRes = await tmdbOrganizeApi.aiIdentify({
            query: group.rawTitle || group.folderName,
            folderName: group.folderName,
            files: group.files,
            accountId: selectedAccountId.value,
            tmdbId: group.tmdbCandidate?.id || group.tmdbId
          });
          if (aiRes) {
            if (aiRes.candidates && aiRes.candidates.length > 0) {
              matchedCandidate = aiRes.candidates[0];
            }
            if (aiRes.aiTitle) {
              group.customTitle = aiRes.aiTitle;
            }
            const isAiMovie = aiRes.aiType === 'movie' || aiRes.rawAiResult?.data?.mediaType === 'movie' || (aiRes.aiCategory && aiRes.aiCategory.includes('电影'));
            if (isAiMovie) {
              group.mediaType = 'movie';
              group.targetSeason = null;
            } else if (aiRes.aiSeason !== undefined && aiRes.aiSeason !== null) {
              group.targetSeason = Number(aiRes.aiSeason);
            }
            if (aiRes.aiCategory) {
              group.targetCategory = aiRes.aiCategory;
            }
            if (aiRes.aiExplanation) {
              group.aiExplanation = aiRes.aiExplanation;
            }
            if (activeGroupId.value === group.id && aiRes.aiExplanation) {
              aiDialogueExplanation.value = aiRes.aiExplanation;
            }
          }
        } catch (_) {}
      }

      // 阶段 4: 采纳候选条目
      if (matchedCandidate) {
        group.tmdbCandidate = matchedCandidate;
        const isMovie = matchedCandidate.media_type === 'movie' || matchedCandidate.mediaType === 'movie' || matchedCandidate.category === '电影' || (!matchedCandidate.media_type && matchedCandidate.title && !matchedCandidate.name) || (matchedCandidate.secondaryCategory && matchedCandidate.secondaryCategory.includes('电影')) || isGroupMovie(group);
        group.mediaType = isMovie ? 'movie' : 'tv';
        if (isMovie) {
          group.targetSeason = null;
        }
        group.targetCategory = inferCategoryFromCandidate(matchedCandidate, isMovie);
        if (!isMovie) {
          applySmartSeasonInference(group, matchedCandidate);
        }
        successCount++;
      }
    } catch {
      // 容错单组失败
    }
  }
  saveWorkspaceDraft();
  autoMatchingAll.value = false;
  autoMatchProgressText.value = '正在批量匹配...';
  ElMessage.success(`智能批量匹配完成：结合 TMDB 与灵犀 AI 成功关联 ${successCount} 个媒体分组！`);
}

// 剧集微调：按文件名自然顺序为当前分组重编集号 (E01~EXX) (参考图二)
function reorderActiveGroupEpisodes() {
  const g = activeGroup.value;
  if (!g) return;
  const included = g.files.filter(f => !g.excludedFileIds.has(String(f.id)));

  let regularIdx = 0;
  let specialIdx = 0;

  included.forEach((f) => {
    const fid = String(f.id);
    const specialInfo = detectSpecialEpisode(f.name);
    const isSpecial = g.seasonOverrides?.[fid] !== undefined
      ? g.seasonOverrides[fid] === 0
      : Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial);

    if (isSpecial) {
      if (!g.seasonOverrides) g.seasonOverrides = {};
      g.seasonOverrides[fid] = 0;
      if (!g.episodeOverrides) g.episodeOverrides = {};
      g.episodeOverrides[fid] = ++specialIdx;
    } else {
      if (!g.episodeOverrides) g.episodeOverrides = {};
      g.episodeOverrides[fid] = (g.startEpisode || 1) + regularIdx++;
    }
  });

  saveWorkspaceDraft();
  ElMessage.success(`已为《${g.folderName}》顺序编排正片 ${regularIdx} 集、特别篇 ${specialIdx} 集`);
  checkActiveGroupWashDebounced();
}

// 手动整理与微调：重置所有修改恢复默认推导
function resetActiveGroupEpisodes() {
  const g = activeGroup.value;
  if (!g) return;
  episodeSearchQuery.value = '';
  episodeCurrentPage.value = 1;
  g.customTitle = '';
  g.customYear = '';
  g.customTmdbId = '';
  g.episodeOffset = 0;
  g.episodeOverrides = {};
  g.seasonOverrides = {};
  g.customNameOverrides = {};

  let regularCounter = g.startEpisode || 1;
  let specialCounter = 1;

  g.files.forEach((f) => {
    const fid = String(f.id);
    const specialInfo = detectSpecialEpisode(f.name);
    const isSpecial = Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial);
    if (isSpecial) {
      g.seasonOverrides[fid] = 0;
      g.episodeOverrides[fid] = f.episode || specialCounter++;
    } else {
      g.episodeOverrides[fid] = f.episode || regularCounter++;
    }
  });

  saveWorkspaceDraft();
  ElMessage.success(`已重置《${g.folderName}》的分集与季度微调`);
  checkActiveGroupWashDebounced();
}

// 剧集微调：应用集号偏移量
function applyEpisodeOffset() {
  const g = activeGroup.value;
  if (!g || !g.episodeOffset) return;
  const offset = Number(g.episodeOffset);
  const included = g.files.filter(f => !g.excludedFileIds.has(String(f.id)));
  included.forEach(f => {
    const fid = String(f.id);
    const cur = g.episodeOverrides[fid] ?? f.episode ?? 1;
    g.episodeOverrides[fid] = Math.max(1, cur + offset);
  });
  g.episodeOffset = 0;
  saveWorkspaceDraft();
  ElMessage.success(`已为《${g.folderName}》单集应用偏移量`);
  checkActiveGroupWashDebounced();
}

// 排除/恢复单个文件不参与归档
function toggleExcludeFile(fileId: string) {
  const g = activeGroup.value;
  if (!g) return;
  if (g.excludedFileIds.has(fileId)) {
    g.excludedFileIds.delete(fileId);
  } else {
    g.excludedFileIds.add(fileId);
  }
  saveWorkspaceDraft();
  checkActiveGroupWashDebounced();
}

// 全选/取消全选当前分组文件
function toggleSelectAllInGroup() {
  const g = activeGroup.value;
  if (!g) return;
  if (g.excludedFileIds.size > 0) {
    g.excludedFileIds.clear();
  } else {
    g.files.forEach(f => g.excludedFileIds.add(String(f.id)));
  }
  saveWorkspaceDraft();
}

// 取消当前媒体分组的 TMDB 关联，恢复为未匹配状态
function unmatchActiveGroup() {
  const g = activeGroup.value;
  if (!g) return;
  g.tmdbCandidate = null;
  g.tmdbId = undefined;
  g.customTmdbId = '';
  g.customTitle = '';
  g.customYear = '';
  g.aiExplanation = undefined;
  aiDialogueExplanation.value = '';
  saveWorkspaceDraft();
  ElMessage.info(`已取消《${g.folderName}》的 TMDB 匹配条目`);
}

// 一键规范归档当前媒体分组 (Requirement 4: 增量更新与核销 + 实时进度与分片流式归档)
async function executeResolveCurrentGroup() {
  const g = activeGroup.value;
  if (!g) return;

  if (!hasUserSelectedTargetFolder.value) {
    ElMessage.warning('请先点击上方【归档媒体库】指定影视归档的目标目录！');
    openFolderPicker('target');
    return;
  }

  if (!g.tmdbCandidate && !g.customTitle && !g.rawTitle) {
    ElMessage.warning('请先在搜索栏检索 TMDB，或在手动整理栏输入片名！');
    return;
  }

  const itemsToResolve = previewOrganizedList.value.filter(item => !item.isExcluded);
  if (itemsToResolve.length === 0) {
    ElMessage.warning('当前分组没有勾选任何待归档的视频文件！');
    return;
  }

  const effectiveTitle = (g.customTitle || g.tmdbCandidate?.title || g.tmdbCandidate?.name || g.rawTitle || g.folderName).trim();
  const effectiveYear = g.customYear || (g.tmdbCandidate?.release_date ? g.tmdbCandidate.release_date.substring(0, 4) : (g.tmdbCandidate?.first_air_date ? g.tmdbCandidate.first_air_date.substring(0, 4) : g.year));
  const effectiveTmdbId = g.tmdbCandidate?.id ? String(g.tmdbCandidate.id) : (g.customTmdbId || '');

  const itemsPayload = itemsToResolve.map((item: any) => {
    const originalFile = g.files.find((f: any) => String(f.id) === item.fileId);
    return {
      fileId: item.fileId,
      name: item.originalName,
      targetTmdbId: effectiveTmdbId,
      targetTitle: effectiveTitle,
      targetYear: effectiveYear,
      targetMediaType: isGroupMovie(g) ? 'movie' : g.mediaType,
      targetCategory: g.targetCategory,
      targetSeason: isGroupMovie(g) ? undefined : item.seasonNum,
      targetEpisode: isGroupMovie(g) ? undefined : item.episodeNum,
      targetEpisodeTitle: isGroupMovie(g) ? undefined : item.episodeTitle,
      targetNewFileName: item.newFileName,
      targetPath: item.targetPath,
      probedMeta: (() => {
        const raw: any = (originalFile as any)?._probedMeta || originalFile?.specs || originalFile?.tech || {};
        return {
          videoFormat: raw.videoFormat || raw.resolution || '',
          dynamicRange: raw.dynamicRange || '',
          videoCodec: raw.videoCodec || '',
          audioCodec: raw.audioCodec || '',
          colorDepth: raw.colorDepth || '',
          frameRate: raw.frameRate || ''
        };
      })(),
      oldPath: originalFile?.folderPath || originalFile?.name,
      parentFolderId: originalFile?.parentFolderId,
      size: item.size
    };
  });

  try {
    const res = await organizeStore.startServerAsyncResolve({
      accountId: selectedAccountId.value,
      mode: 'single',
      groups: [{
        groupId: g.id,
        groupTitle: effectiveTitle,
        title: effectiveTitle,
        targetTmdbId: effectiveTmdbId,
        targetTitle: effectiveTitle,
        targetYear: effectiveYear,
        targetMediaType: isGroupMovie(g) ? 'movie' : g.mediaType,
        targetCategory: g.targetCategory,
        targetSeason: isGroupMovie(g) ? undefined : g.targetSeason,
        items: itemsPayload
      }],
      targetDirPath: currentTargetDisplayPath.value || '/媒体库',
      cleanEmptySourceDir: cleanEmptySourceDirOnResolve.value
    });
    if (res && res.success) {
      ElMessage.info(`后台归档已由服务端接管：《${effectiveTitle}》，即使关闭网页后台也将继续执行到底`);
    }
  } catch (err: any) {
    ElMessage.error(`启动后台归档失败: ${err.message}`);
  }
}

// 批量归档所有已匹配组 (服务端后台驻留执行，关闭网页不影响)
async function executeBatchResolveAllMatched() {
  if (!hasUserSelectedTargetFolder.value) {
    ElMessage.warning('请先点击上方【归档媒体库】指定影视归档的目标目录！');
    openFolderPicker('target');
    return;
  }

  const readyGroups = mediaGroups.value.filter(g => Boolean(g.tmdbCandidate));
  if (readyGroups.length === 0) {
    ElMessage.warning('当前没有已匹配 TMDB 的媒体分组！');
    return;
  }

  let grandTotalFiles = 0;
  readyGroups.forEach(g => {
    grandTotalFiles += g.files.filter(f => !g.excludedFileIds.has(String(f.id))).length;
  });

  if (grandTotalFiles === 0) {
    ElMessage.warning('已匹配的媒体组中没有勾选可归档的视频文件');
    return;
  }

  const batchGroups = readyGroups.map(g => {
    const isMovie = isGroupMovie(g);
    const effectiveTitle = (g.tmdbCandidate?.title || g.tmdbCandidate?.name || g.rawTitle).trim();
    const effectiveYear = g.tmdbCandidate?.release_date ? g.tmdbCandidate.release_date.substring(0, 4) : (g.tmdbCandidate?.first_air_date ? g.tmdbCandidate.first_air_date.substring(0, 4) : g.year);
    const effectiveTmdbId = g.tmdbCandidate?.id ? String(g.tmdbCandidate.id) : '';
    const defaultSeason = (g.targetSeason !== undefined && g.targetSeason !== null) ? Number(g.targetSeason) : 1;

    const includedFiles = g.files.filter(f => !g.excludedFileIds.has(String(f.id)));
    const groupPayload: any[] = includedFiles.map((f, idx) => {
      const fid = String(f.id);
      const specialInfo = detectSpecialEpisode(f.name);
      const isSpecialHint = Boolean(f.isSpecial || f.season === 0 || specialInfo.isSpecial);
      const fileSeason = g.seasonOverrides?.[fid] !== undefined
        ? Number(g.seasonOverrides[fid])
        : (isSpecialHint ? 0 : defaultSeason);
      const epNum = g.episodeOverrides?.[fid] ?? f.episode ?? (idx + (g.startEpisode || 1));
      const epTitle = g.episodeTitleOverrides?.[fid] ?? f.episodeTitle ?? '';
      const customName = g.customNameOverrides?.[fid];

      return {
        fileId: fid,
        name: f.name,
        targetSeason: isMovie ? undefined : fileSeason,
        targetEpisode: isMovie ? undefined : epNum,
        targetEpisodeTitle: isMovie ? undefined : (epTitle || undefined),
        targetNewFileName: keepOriginalFilename.value ? f.name : (customName || undefined),
        probedMeta: (() => {
          const raw: any = (f as any)._probedMeta || f.specs || f.tech;
          if (!raw) return undefined;
          const meta: any = {};
          if (raw.videoFormat || raw.resolution) meta.videoFormat = raw.videoFormat || raw.resolution;
          if (raw.dynamicRange) meta.dynamicRange = raw.dynamicRange;
          if (raw.videoCodec) meta.videoCodec = raw.videoCodec;
          if (raw.audioCodec) meta.audioCodec = raw.audioCodec;
          if (raw.colorDepth) meta.colorDepth = raw.colorDepth;
          if (raw.frameRate) meta.frameRate = raw.frameRate;
          return Object.keys(meta).length > 0 ? meta : undefined;
        })(),
        oldPath: f.folderPath || f.name,
        parentFolderId: f.parentFolderId,
        size: f.size
      };
    });

    return {
      groupId: g.id,
      groupTitle: effectiveTitle,
      title: effectiveTitle,
      targetTmdbId: effectiveTmdbId,
      targetTitle: effectiveTitle,
      targetYear: effectiveYear,
      targetMediaType: isMovie ? 'movie' : g.mediaType,
      targetCategory: g.targetCategory,
      targetSeason: isMovie ? undefined : defaultSeason,
      items: groupPayload
    };
  });

  try {
    const res = await organizeStore.startServerAsyncResolve({
      accountId: selectedAccountId.value,
      mode: 'batch',
      groups: batchGroups,
      targetDirPath: currentTargetDisplayPath.value || '/媒体库',
      cleanEmptySourceDir: cleanEmptySourceDirOnResolve.value
    });
    if (res && res.success) {
      ElMessage.info(`已成功启动批量后台归档任务（共 ${readyGroups.length} 组），由 Docker 容器全权接管，关闭网页不受影响`);
    }
  } catch (err: any) {
    ElMessage.error(`启动批量归档失败: ${err.message}`);
  }
}

// 监听服务端后台归档任务的实时核销反馈 (即使刷新页面或从后台切回，也能自动核销移除已入库项)
watch(
  () => [organizeStore.completedGroupIds.size, organizeStore.resolvedFileIds.size],
  () => {
    if (organizeStore.completedGroupIds.size > 0) {
      mediaGroups.value = mediaGroups.value.filter(item => !organizeStore.completedGroupIds.has(item.id));
      if (mediaGroups.value.length > 0 && !mediaGroups.value.some(g => g.id === activeGroupId.value)) {
        activeGroupId.value = mediaGroups.value[0].id;
        syncSearchFromActiveGroup();
      } else if (mediaGroups.value.length === 0) {
        activeGroupId.value = '';
      }
    }
    if (organizeStore.resolvedFileIds.size > 0) {
      unrecognizedFiles.value = unrecognizedFiles.value.filter(f => !organizeStore.resolvedFileIds.has(String(f.id)));
      allScannedFiles.value = allScannedFiles.value.filter(f => !organizeStore.resolvedFileIds.has(String(f.id)));
    }
  }
);

watch(
  () => organizeStore.organizeProgress.active,
  (isActive, wasActive) => {
    if (wasActive && !isActive) {
      const p = organizeStore.organizeProgress;
      if (p.status === 'completed') {
        ElMessage.success(`后台归档完成！成功规范入库 ${p.processedCount || p.total} 个文件${p.skippedCount ? `，洗版拦截 ${p.skippedCount} 个` : ''}`);
        saveWorkspaceDraft();
        loadHistory();
      } else if (p.status === 'failed') {
        ElMessage.error(`后台归档任务执行异常，请查看系统日志`);
      }
    }
  }
);

// ================= MoviePilot 级「手动整理与高级刮削控制」交互逻辑 =================
function openManualModalForActiveGroup() {
  const g = activeGroup.value;
  if (!g) {
    ElMessage.warning('请先在左侧选择需要手动整理的媒体分组');
    return;
  }
  const cleanTitle = sanitizeMediaTitle(g.rawTitle || g.folderName);
  manualModalForm.value = {
    targetAccountId: selectedAccountId.value || (accounts.value[0]?.id ?? ''),
    transferType: 'move',
    targetFolderId: strategyConfig.value.defaultTargetFolderId || '',
    targetFolderPath: (strategyConfig.value.defaultTargetFolderName && !strategyConfig.value.defaultTargetFolderName.includes('默认媒体库')) ? strategyConfig.value.defaultTargetFolderName : '/媒体库',
    mediaType: g.mediaType || 'tv',
    category: g.targetCategory || (g.mediaType === 'movie' ? '电影' : '国产剧'),
    metadataSource: 'tmdb',
    minFileSizeMb: 30,
    keepOriginalName: keepOriginalFilename.value,
    cleanResidualFolders: cleanEmptySourceDirOnResolve.value,
    keepDolbyMultiVersion: false,
    startSeason: (g.targetSeason !== undefined && g.targetSeason !== null) ? Number(g.targetSeason) : 1,
    startEpisode: g.startEpisode || 1,
    episodeStep: 1,
    customTitle: g.tmdbCandidate ? (g.tmdbCandidate.title || g.tmdbCandidate.name) : cleanTitle,
    customYear: g.tmdbCandidate?.year || (g.tmdbCandidate?.release_date ? g.tmdbCandidate.release_date.slice(0, 4) : (g.tmdbCandidate?.first_air_date ? g.tmdbCandidate.first_air_date.slice(0, 4) : g.year)),
    tmdbId: g.tmdbCandidate?.id ? String(g.tmdbCandidate.id) : (g.tmdbId ? String(g.tmdbId) : '')
  };
  modalSearchQuery.value = manualModalForm.value.customTitle;
  modalSelectedCandidate.value = g.tmdbCandidate || null;
  modalTmdbCandidates.value = g.tmdbCandidate ? [g.tmdbCandidate] : [];
  manualPreviewTasks.value = [];
  showManualPreviewTable.value = false;
  showManualModal.value = true;

  if (modalSelectedCandidate.value && modalSelectedCandidate.value.id && manualModalForm.value.mediaType !== 'movie') {
    fetchModalTvSeasons(modalSelectedCandidate.value.id);
  }
}

async function searchModalTmdb() {
  const q = modalSearchQuery.value.trim();
  if (!q) {
    ElMessage.warning('请输入搜索片名或 TMDB ID');
    return;
  }
  modalSearchingTmdb.value = true;
  try {
    const results = await tmdbOrganizeApi.searchTmdb({
      query: q,
      mediaType: manualModalForm.value.mediaType === 'movie' ? 'movie' : (manualModalForm.value.mediaType === 'tv' ? 'tv' : undefined)
    });
    modalTmdbCandidates.value = results || [];
    if (modalTmdbCandidates.value.length === 0) {
      ElMessage.info(`未在 TMDB 中搜索到「${q}」，可尝试精简片名关键词`);
    } else {
      ElMessage.success(`找到 ${modalTmdbCandidates.value.length} 条 TMDB 候选结果`);
    }
  } catch (err: any) {
    ElMessage.error(`TMDB 搜索失败: ${err.message}`);
  } finally {
    modalSearchingTmdb.value = false;
  }
}

function selectModalCandidate(cand: any) {
  modalSelectedCandidate.value = cand;
  const isMovie = cand.media_type === 'movie' || cand.mediaType === 'movie' || (!cand.media_type && cand.title && !cand.name);
  manualModalForm.value.mediaType = isMovie ? 'movie' : 'tv';
  manualModalForm.value.customTitle = (cand.title || cand.name || '').trim();
  manualModalForm.value.customYear = cand.year || (cand.release_date ? cand.release_date.slice(0, 4) : (cand.first_air_date ? cand.first_air_date.slice(0, 4) : ''));
  manualModalForm.value.tmdbId = cand.id;
  manualModalForm.value.category = inferCategoryFromCandidate(cand, isMovie);

  if (!isMovie) {
    fetchModalTvSeasons(cand.id);
  } else {
    manualModalForm.value.startSeason = 1;
    modalTvSeasons.value = [];
  }
  ElMessage.success(`已选定 TMDB: 《${manualModalForm.value.customTitle}》 (ID: ${cand.id})`);
}

async function fetchModalTvSeasons(tvId: number | string) {
  modalLoadingSeasons.value = true;
  try {
    const res: any = await axios.get(`/api/tmdb-organize/tv/${tvId}/seasons`);
    if (res?.data?.success && Array.isArray(res.data.data?.seasons)) {
      modalTvSeasons.value = res.data.data.seasons;
      const hasSeason = modalTvSeasons.value.some((s: any) => s.season_number === manualModalForm.value.startSeason);
      if (!hasSeason && modalTvSeasons.value.length > 0) {
        const firstValidSeason = modalTvSeasons.value.find((s: any) => s.season_number > 0) || modalTvSeasons.value[0];
        manualModalForm.value.startSeason = firstValidSeason.season_number;
      }
    }
  } catch (err: any) {
    console.warn('获取 TMDB 季列表失败:', err.message);
  } finally {
    modalLoadingSeasons.value = false;
  }
}

async function executeManualPreview() {
  const g = activeGroup.value;
  if (!g) return;
  manualModalLoading.value = true;
  try {
    const filesToPreview = g.files.filter(f => !g.excludedFileIds.has(String(f.id)));
    const res = await tmdbOrganizeApi.previewManual({
      accountId: manualModalForm.value.targetAccountId || selectedAccountId.value,
      files: filesToPreview,
      targetFolderPath: manualModalForm.value.targetFolderPath,
      mediaType: manualModalForm.value.mediaType,
      category: manualModalForm.value.category,
      tmdbId: manualModalForm.value.tmdbId,
      customTitle: manualModalForm.value.customTitle,
      customYear: manualModalForm.value.customYear,
      customSeason: manualModalForm.value.startSeason,
      startEpisode: manualModalForm.value.startEpisode,
      episodeStep: manualModalForm.value.episodeStep,
      keepOriginalName: manualModalForm.value.keepOriginalName,
      minFileSizeMb: manualModalForm.value.minFileSizeMb
    });

    manualPreviewTasks.value = res.tasks || [];
    showManualPreviewTable.value = true;
    ElMessage.success(`预览就绪，共 ${manualPreviewTasks.value.length} 个规范重命名入库任务`);
  } catch (err: any) {
    ElMessage.error(`预览推导失败: ${err.message}`);
  } finally {
    manualModalLoading.value = false;
  }
}

async function executeManualOrganizeSubmit() {
  if (manualPreviewTasks.value.length === 0) {
    await executeManualPreview();
    if (manualPreviewTasks.value.length === 0) return;
  }
  const g = activeGroup.value;
  if (!g) return;

  manualModalExecuting.value = true;
  try {
    if (modalSelectedCandidate.value) {
      g.tmdbCandidate = modalSelectedCandidate.value;
    }
    g.rawTitle = manualModalForm.value.customTitle;
    g.year = manualModalForm.value.customYear;
    g.targetSeason = manualModalForm.value.startSeason;
    g.mediaType = manualModalForm.value.mediaType as any;
    g.targetCategory = manualModalForm.value.category;

    const res = await tmdbOrganizeApi.manualOrganize({
      accountId: manualModalForm.value.targetAccountId || selectedAccountId.value,
      batchName: `手动整理: 《${manualModalForm.value.customTitle}》`,
      tasks: manualPreviewTasks.value,
      options: {
        cleanResidual: manualModalForm.value.cleanResidualFolders
      }
    });

    const curId = g.id;
    mediaGroups.value = mediaGroups.value.filter(item => item.id !== curId);
    if (mediaGroups.value.length > 0) {
      activeGroupId.value = mediaGroups.value[0].id;
      syncSearchFromActiveGroup();
    } else {
      activeGroupId.value = '';
    }

    showManualModal.value = false;
    saveWorkspaceDraft();
    ElMessage.success(`手动整理成功！共规范归档入库 ${res.succeededCount} 个文件 (批次 #${res.batchId})`);
  } catch (err: any) {
    ElMessage.error(`手动整理执行失败: ${err.message}`);
  } finally {
    manualModalExecuting.value = false;
  }
}

// 快捷填入默认路径
function fillDefaultStagingDir() {
  if (strategyConfig.value.stagingFolderName) {
    manualOrganizeConfig.value.sourceDirPath = strategyConfig.value.stagingFolderName;
    manualOrganizeConfig.value.sourceDirId = strategyConfig.value.stagingFolderId || '/';
    ElMessage.success(`已填入默认暂存目录: ${strategyConfig.value.stagingFolderName}`);
  } else {
    ElMessage.info('尚未设置默认暂存目录');
  }
}

function fillDefaultTargetDir() {
  if (strategyConfig.value.defaultTargetFolderName) {
    manualOrganizeConfig.value.targetDirPath = strategyConfig.value.defaultTargetFolderName;
    ElMessage.success(`已填入默认媒体库路径: ${strategyConfig.value.defaultTargetFolderName}`);
  } else {
    ElMessage.info('尚未设置默认媒体库路径');
  }
}

// 触发沙箱预览推演 (0 物理写入)
async function triggerPreview() {
  if (!selectedAccountId.value) {
    if (!accountsLoaded.value) {
      await loadAccounts();
    }
    if (!selectedAccountId.value && accounts.value.length > 0) {
      const active = accounts.value.find((a: AccountItem) => a.isActive && a.memberStatus !== 'auth_failed');
      const defaultAcc = accounts.value.find((a: AccountItem) => a.isDefault);
      selectedAccountId.value = (active || defaultAcc || accounts.value[0])?.id || '';
    }
    if (!selectedAccountId.value) {
      ElMessage.warning('请先绑定并选择 139 移动云盘账号');
      return;
    }
  }
  if (!manualOrganizeConfig.value.sourceDirPath || manualOrganizeConfig.value.sourceDirPath === '/') {
    ElMessage.warning('请指定具体的待整理源目录');
    return;
  }

  scanning.value = true;
  previewDone.value = false;
  try {
    const scanData = await tmdbOrganizeApi.scanDirectory(
      manualOrganizeConfig.value.sourceDirId,
      selectedAccountId.value
    );
    const groups: OrganizeGroup[] = scanData.groups || [];

    if (groups.length === 0) {
      ElMessage.warning('所选源目录下未发现任何可整理的视频或影视媒体！');
      scanning.value = false;
      return;
    }

    scanning.value = false;
    previewing.value = true;

    const previewRes = await tmdbOrganizeApi.previewOrganize(groups, {
      targetDirPath: manualOrganizeConfig.value.targetDirPath,
      organizeLocation: manualOrganizeConfig.value.organizeLocation,
      unmatchedSeasonPolicy: manualOrganizeConfig.value.unmatchedSeasonPolicy,
      classifyRegion: manualOrganizeConfig.value.classifyRegion,
      classifyYear: manualOrganizeConfig.value.classifyYear,
      includeEpisodeTitle: manualOrganizeConfig.value.includeEpisodeTitle
    });

    previewGroups.value = previewRes.groups || [];
    previewTasks.value = previewRes.tasks || [];
    previewSummary.value = previewRes.summary || {
      total: previewTasks.value.length,
      ready: 0,
      fallbackCount: 0,
      protectedCount: 0,
      suspiciousCount: 0,
      unmatchedCount: 0,
      discardCount: 0
    };
    previewDone.value = true;
  } catch (err: any) {
    ElMessage.error(`预演推演失败: ${err.message}`);
  } finally {
    scanning.value = false;
    previewing.value = false;
  }
}

// 原位确认执行整理 (零弹窗规范)
const executeOrganizeConfirm = ref(false);
async function executeOrganize() {
  if (previewTasks.value.length === 0) {
    ElMessage.warning('请先点击「预览」生成整理入库计划！');
    return;
  }
  if (!executeOrganizeConfirm.value) {
    executeOrganizeConfirm.value = true;
    return;
  }
  executeOrganizeConfirm.value = false;

  executing.value = true;
  try {
    const res = await tmdbOrganizeApi.executeOrganize(
      { tasks: previewTasks.value, settings: manualOrganizeConfig.value },
      selectedAccountId.value,
      { cleanEmptySources: manualOrganizeConfig.value.cleanEmptySources }
    );

    ElMessage.success(
      `整理完成！成功入库 ${res.successCount} 项，原地保护 ${res.protectedCount} 项，清理废弃 ${res.discardedCount} 项！`
    );
    inlineOrganizePanelOpen.value = false;
    await loadHistory();
    switchTab('history');
  } catch (err: any) {
    ElMessage.error(`执行整理失败: ${err.message}`);
  } finally {
    executing.value = false;
  }
}

// 单项操作与胶囊确认
const singleRollbackId = ref<number | null>(null);
async function confirmSingleRollback(record: OrganizeHistoryRecord) {
  try {
    const res = await tmdbOrganizeApi.rollback({ recordId: record.id, accountId: selectedAccountId.value });
    if (res.success) {
      ElMessage.success(`文件已成功原路恢复至源位置！`);
      singleRollbackId.value = null;
      await loadHistory();
    }
  } catch (err: any) {
    ElMessage.error(`撤销失败: ${err.message}`);
  }
}

const singleDeleteId = ref<number | null>(null);
async function confirmSingleDelete(record: OrganizeHistoryRecord) {
  try {
    await tmdbOrganizeApi.deleteRecord(record.id);
    ElMessage.success('已删除该条记录');
    singleDeleteId.value = null;
    await loadHistory();
  } catch (err: any) {
    ElMessage.error(`删除失败: ${err.message}`);
  }
}

// 从历史记录唤起 MoviePilot 风格手动重新整理
function reOrganizeFromHistory(record: OrganizeHistoryRecord) {
  const details = parseRecordDetails(record);
  const fileName = record.newName || record.oldName;
  const parentPath = record.newParentPath || record.oldParentPath || '/';
  const currentSeason = record.season || (details.seasonEpisode ? parseInt(details.seasonEpisode.match(/S(\d+)/i)?.[1] || '1', 10) : 1);
  const currentEpisode = record.episode || (details.seasonEpisode ? parseInt(details.seasonEpisode.match(/E(\d+)/i)?.[1] || '1', 10) : null);
  const tempFile: MediaFileItem = {
    id: record.fileRef || String(record.id),
    fileId: record.fileRef || String(record.id),
    name: fileName,
    size: record.size || 0,
    relativePath: fileName,
    folderPath: parentPath,
    parentFolderId: record.newParentRef || record.oldParentRef || '',
    parentFolderName: parentPath.split('/').filter(Boolean).pop() || '',
    inferredTitle: details.cleanTitle || fileName,
    cleanTitle: details.cleanTitle || fileName,
    year: details.year || '',
    season: currentSeason,
    episode: currentEpisode,
    episodeTitle: record.episodeTitle || ''
  };

  const tempGroup: MediaGroupItem = {
    id: `reorganize_${record.id}`,
    folderName: parentPath.split('/').filter(Boolean).pop() || '',
    folderPath: parentPath,
    rawTitle: details.cleanTitle || fileName,
    year: details.year || '',
    mediaType: ((record.mediaType === 'movie' || record.mediaType === 'tv') ? record.mediaType : (details.isTv ? 'tv' : 'movie')) as 'tv' | 'movie',
    targetCategory: details.isTv ? '电视剧' : '电影',
    targetSeason: currentSeason,
    startEpisode: currentEpisode || 1,
    episodeOffset: 0,
    episodeOverrides: {},
    episodeTitleOverrides: {},
    seasonOverrides: {},
    customNameOverrides: {},
    excludedFileIds: new Set<string>(),
    isTuningCollapsed: false,
    isFilesCollapsed: false,
    files: [tempFile],
    tmdbCandidate: record.tmdbId ? {
      id: Number(record.tmdbId),
      name: details.cleanTitle,
      title: details.cleanTitle,
      poster_path: details.posterUrl ? details.posterUrl.replace('https://image.tmdb.org/t/p/w200', '') : undefined,
      first_air_date: details.year ? `${details.year}-01-01` : undefined,
      release_date: details.year ? `${details.year}-01-01` : undefined
    } : undefined
  };
  const existingIdx = mediaGroups.value.findIndex(g => g.id === tempGroup.id);
  if (existingIdx >= 0) {
    mediaGroups.value[existingIdx] = tempGroup;
  } else {
    mediaGroups.value.unshift(tempGroup);
  }
  activeGroupId.value = tempGroup.id;
  activeMainTab.value = 'manual';
  syncSearchFromActiveGroup();
  ElMessage.info(`已载入历史资产《${details.cleanTitle || fileName}》至刮削工作台`);
}

const rollbackLastConfirm = ref(false);
async function handleRollbackLast() {
  if (!rollbackLastConfirm.value) {
    rollbackLastConfirm.value = true;
    return;
  }
  rollbackLastConfirm.value = false;
  loading.value = true;
  try {
    const res = await tmdbOrganizeApi.rollback({ accountId: selectedAccountId.value });
    if (res.success) {
      ElMessage.success(`成功撤回上次整理！恢复 ${res.restoredCount || 0} 个文件`);
      await loadHistory();
    } else {
      ElMessage.warning(res.message || '撤销未完成');
    }
  } catch (err: any) {
    ElMessage.error(`撤销操作异常: ${err.message}`);
  } finally {
    loading.value = false;
  }
}

function formatSize(bytes?: number) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function formatTime(dateStr?: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return '昨天';
  }
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const failedPosters = ref<Record<number, boolean>>({});

function formatPosterUrl(path?: string) {
  if (!path) return '';
  let clean = String(path).trim();
  if (clean.startsWith('http')) {
    const m = clean.match(/\/t\/p\/(?:w\d+|original)(\/[^?#]+)/);
    clean = m ? m[1] : clean;
  }
  if (!clean.startsWith('http')) {
    if (!clean.startsWith('/')) clean = '/' + clean;
    return `/api/tmdb-organize/poster-proxy?path=${encodeURIComponent(clean)}`;
  }
  return clean;
}

function handlePosterError(e: Event) {
  const target = e.target as HTMLImageElement;
  if (!target) return;
  if (!target.dataset.triedFallback) {
    target.dataset.triedFallback = 'true';
    const src = target.src || '';
    const m = src.match(/path=([^&]+)/);
    if (m) {
      const decoded = decodeURIComponent(m[1]);
      const clean = decoded.startsWith('/') ? decoded : '/' + decoded;
      target.src = `https://wsrv.nl/?url=image.tmdb.org/t/p/w200${clean}&output=webp`;
      return;
    }
  }
  target.style.display = 'none';
}

function copyText(text: string, label: string = '内容') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success(`已复制${label}: ${text}`);
  }).catch(() => {
    ElMessage.error('复制失败');
  });
}

function getSpecBadgeClass(spec: string) {
  if (/2160p|4k/i.test(spec)) return 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200/60 dark:border-amber-800/60';
  if (/1080p/i.test(spec)) return 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60';
  if (/杜比|dv|dolby/i.test(spec)) return 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border border-purple-200/60 dark:border-purple-800/60';
  if (/hdr/i.test(spec)) return 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/60';
  if (/10bit|60fps|remux/i.test(spec)) return 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 border border-cyan-200/60 dark:border-cyan-800/60';
  if (/s\d+e\d+/i.test(spec)) return 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60';
  return 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200/60 dark:border-slate-700/60';
}

function parseRecordDetails(record: any) {
  const newName = record.newName || '';
  const oldName = record.oldName || '';
  const path = record.newParentPath || '';
  const fullText = `${newName} ${oldName} ${path}`;

  // 1. 纯净主片名 (优先使用 record.title，次从路径或新文件名中提取)
  let cleanTitle = record.title || '';
  if (!cleanTitle) {
    if (path) {
      const pathMatch = path.match(/(?:剧集|电影|国漫|日番|纪录片|综艺|华语电影|外语电影|国产剧|欧美剧|日韩剧|动漫)\/([^/{]+)/i);
      if (pathMatch && pathMatch[1]) {
        cleanTitle = pathMatch[1].replace(/[（(]\d{4}[)）]/g, '').trim();
      }
    }
    if (!cleanTitle && newName) {
      cleanTitle = newName
        .split('.')[0]
        .replace(/^[【\[][^】\]]*[】\]]/, '')
        .trim();
    }
    if (!cleanTitle && oldName) {
      cleanTitle = oldName.split('.')[0].trim();
    }
  }

  // 2. 年份提取
  let year = record.year || '';
  if (!year) {
    const yMatch = fullText.match(/[（(]((?:19|20)\d{2})[)）]/) || fullText.match(/\b((?:19|20)\d{2})\b/);
    if (yMatch) year = yMatch[1];
  }

  // 3. 模态与分类提取 (与频道监控视图统一体系)
  let category = '';
  if (path.includes('/国漫/')) category = '国漫';
  else if (path.includes('/日番/') || path.includes('/日漫/')) category = '日番';
  else if (path.includes('/国产剧/')) category = '国产剧';
  else if (path.includes('/欧美剧/')) category = '欧美剧';
  else if (path.includes('/日韩剧/')) category = '日韩剧';
  else if (path.includes('/剧集/')) category = '剧集';
  else if (path.includes('/华语电影/')) category = '华语电影';
  else if (path.includes('/外语电影/')) category = '外语电影';
  else if (path.includes('/电影/')) category = '电影';
  else if (path.includes('/纪录片/')) category = '纪录片';
  else if (path.includes('/综艺/')) category = '综艺';
  else if (path.includes('/动漫/')) category = '动漫';

  const isMovie = record.mediaType === 'movie'
    || category === '电影'
    || category === '华语电影'
    || category === '外语电影'
    || path.includes('/电影/');

  const isTv = !isMovie && (
    record.mediaType === 'tv'
    || Boolean(record.season)
    || Boolean(record.episode)
    || /Season\s*\d+|\bS\d{1,2}\s*E\d{1,4}\b|第\s*\d+\s*[季集话期]/i.test(fullText)
  );

  if (!category) {
    category = isTv ? '剧集' : (isMovie ? '电影' : '影视');
  }

  const categoryYearLabel = year ? `${category} / ${year}` : category;

  // 4. 季集编号与官方单集标题
  let seasonEpisode = '';
  if (!isMovie) {
    if (record.season !== null && record.season !== undefined && record.episode !== null && record.episode !== undefined) {
      seasonEpisode = `S${String(record.season).padStart(2, '0')}E${String(record.episode).padStart(2, '0')}`;
    } else {
      const seMatch = fullText.match(/\bS(\d{1,2})\s*E(\d{1,4})\b/i);
      if (seMatch) {
        seasonEpisode = `S${String(seMatch[1]).padStart(2, '0')}E${String(seMatch[2]).padStart(2, '0')}`;
      }
    }
  }

  let episodeTitle = record.episodeTitle || '';
  if (!episodeTitle && newName) {
    const epMatch = newName.match(/S\d{1,2}E\d{1,4}\.([^.]+?)\.(?:2160p|1080p|720p|4k|web-dl|h\.?26[45]|hevc|sdr|hdr|dv|10bit|remux)/i);
    if (epMatch && epMatch[1]) {
      const candidate = epMatch[1].trim();
      if (!/^(?:20\d\d|19\d\d|2160p|1080p|720p|576p|480p|4k|2k|8k|web-?dl|web-?rip|hd-?tv|bluray|bdr-?ip|remux|h\.?26[45]|x26[45]|hevc|avc|av1|sdr|hdr(?:10\+?)?|dv|dovi|10bit|8bit|aac|ddp|atmos)$/i.test(candidate)) {
        episodeTitle = candidate;
      }
    }
  }
  const displayEpTitle = episodeTitle ? (seasonEpisode ? `${seasonEpisode} · ${episodeTitle}` : episodeTitle) : '';

  // 5. 关键技术规格标签提取 (4K/2160p, DV, HDR, 10bit, H.265, DDP 5.1 等)
  const specs: string[] = [];
  if (seasonEpisode) specs.push(seasonEpisode);
  if (/4K|2160p/i.test(fullText)) specs.push('2160p');
  else if (/1080p/i.test(fullText)) specs.push('1080p');
  else if (/720p/i.test(fullText)) specs.push('720p');

  if (/杜比视界|Dolby\s*Vision|\bDV\b/i.test(fullText)) specs.push('杜比视界');
  if (/HDR10\+|HDR/i.test(fullText)) specs.push('HDR');
  if (/10bit/i.test(fullText)) specs.push('10bit');
  if (/60(?:fps|帧)/i.test(fullText)) specs.push('60FPS');
  if (/50(?:fps|帧)/i.test(fullText)) specs.push('50FPS');
  if (/25(?:fps|帧)/i.test(fullText)) specs.push('25FPS');
  if (/H\.?265|HEVC/i.test(fullText)) specs.push('H.265');
  else if (/H\.?264|AVC/i.test(fullText)) specs.push('H.264');
  if (/DDP|E-?AC-?3/i.test(fullText)) specs.push('DDP 5.1');
  if (/Atmos/i.test(fullText)) specs.push('Atmos');
  if (/WEB-DL/i.test(fullText)) specs.push('WEB-DL');
  if (/Remux/i.test(fullText)) specs.push('Remux');

  // 6. 整理目标与路径
  let targetDisplayPath = '';
  if (record.status === 'protected') {
    targetDisplayPath = `[保护] ${record.reason || '未达洗版质量或未匹配'}`;
  } else if (record.status === 'skipped') {
    targetDisplayPath = `[淘汰] ${record.reason || '同批次已保留更佳版本，次选版本移入回收站'}`;
  } else if (record.status === 'reverted') {
    targetDisplayPath = `[已撤回] ${record.reason || '已原路恢复至原目录与原文件名'}`;
  } else if (record.status === 'failed') {
    targetDisplayPath = `[失败] ${record.error || record.reason || '执行异常'}`;
  } else if (path && newName) {
    targetDisplayPath = `${path}/${newName}`;
  } else if (newName) {
    targetDisplayPath = newName;
  } else {
    targetDisplayPath = record.reason || '-';
  }

  // 7. 海报 URL
  let posterUrl = '';
  if (record.posterPath) {
    posterUrl = formatPosterUrl(record.posterPath);
  }

  return {
    cleanTitle: cleanTitle || newName || oldName,
    category,
    year,
    categoryYearLabel,
    isTv,
    seasonEpisode,
    episodeTitle: displayEpTitle,
    specs,
    targetDisplayPath,
    posterUrl
  };
}

// 监听 MainLayout 顶栏保存按钮
function onHeaderSave() {
  if (route.path !== '/organize' && route.path !== '/scrape' && route.path !== '/wash') {
    return;
  }
  handleSaveStrategy();
}

function syncTabFromRoute() {
  const path = route.path;
  const tab = (route.query.tab as string) || '';
  if (path === '/wash') {
    if (tab === 'history' || tab === 'wash_history') {
      activeMainTab.value = 'wash_history';
    } else {
      activeMainTab.value = 'wash';
    }
  } else if (path === '/workbench' || path === '/scrape' || tab === 'manual') {
    activeMainTab.value = 'manual';
  } else if (path === '/history' || tab === 'history') {
    activeMainTab.value = 'history';
  } else if (path === '/organize') {
    activeMainTab.value = 'organize';
  }
}

function switchTab(tab: 'organize' | 'manual' | 'history' | 'wash' | 'wash_history') {
  activeMainTab.value = tab;
  if (tab === 'manual' && unrecognizedFiles.value.length === 0 && !loadingUnrecognized.value) {
    loadUnrecognizedFiles();
  }
  if (tab === 'wash' || tab === 'wash_history') {
    router.push({ path: '/wash', query: tab === 'wash_history' ? { tab: 'history' } : undefined });
  } else if (tab === 'manual') {
    router.push({ path: '/workbench' });
  } else if (tab === 'history') {
    router.push({ path: '/history' });
  } else {
    router.push({ path: '/organize' });
  }
}

watch(
  () => [route.path, route.query.tab],
  () => {
    // 仅当当前路由属于媒体模块相关路径时才执行同步与刷新，避免切换至其他外层页面时意外重置工作台选项卡
    const validPaths = ['/organize', '/workbench', '/scrape', '/history', '/wash'];
    if (!validPaths.includes(route.path)) {
      return;
    }
    syncTabFromRoute();
    if (activeMainTab.value === 'history' || activeMainTab.value === 'wash_history') {
      currentPage.value = 1;
      loadHistory();
    } else if (activeMainTab.value === 'manual' && unrecognizedFiles.value.length === 0 && !loadingUnrecognized.value) {
      loadUnrecognizedFiles();
    }
  },
  { immediate: true }
);

onMounted(async () => {
  await loadAccounts();
  await loadStrategyConfig();
  if (activeMainTab.value === 'manual') {
    await loadUnrecognizedFiles();
  }
  if (activeMainTab.value !== 'history' && activeMainTab.value !== 'wash_history') {
    await loadHistory();
  }
  window.removeEventListener('header-save-click', onHeaderSave);
  window.addEventListener('header-save-click', onHeaderSave);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSave);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16 text-slate-800 dark:text-slate-100">
    <!-- 洗版策略主视口切换 (仅在 /wash 路由下呈现策略与流水切换) -->
    <div v-if="isWashRoute" class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium max-w-full overflow-x-auto no-scrollbar">
        <button
          type="button"
          @click="switchTab('wash')"
          :class="activeMainTab === 'wash' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
        >
          <SlidersHorizontal class="w-3.5 h-3.5" />
          <span>洗版策略配置</span>
        </button>

        <button
          type="button"
          @click="switchTab('wash_history')"
          :class="activeMainTab === 'wash_history' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
        >
          <Clock class="w-3.5 h-3.5" />
          <span>洗版记录</span>
          <span v-if="washHistoryList.length > 0" class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-700 dark:bg-slate-700 dark:text-blue-300 font-mono">
            {{ washHistoryList.length }}
          </span>
        </button>
      </div>
    </div>

    <!-- 全局未登录 / 凭证失效防空防护提示条 -->
    <div v-if="accountsLoaded && !hasActiveAccount" class="mb-5 p-3.5 bg-amber-500/10 dark:bg-amber-950/20 border border-amber-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-amber-700 dark:text-amber-300">
      <div class="flex items-center gap-2.5 text-xs">
        <AlertTriangle class="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span><strong>云盘未登录安全保护机制生效中</strong>：当前未检测到正常在线的 139 移动云盘账号，目录选择与整理功能已进入受保护防空状态。</span>
      </div>
      <button
        type="button"
        @click="router.push('/accounts')"
        class="shrink-0 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer self-start sm:self-auto"
      >
        前往扫码登录
      </button>
    </div>

    <!-- ================= 视口 1: 媒体整理配置 (0 到 1 规范化归档入库) ================= -->
    <template v-if="activeMainTab === 'organize'">
      <!-- 模块 1: 两级落盘目录中枢 -->
      <div class="settings-card">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-4 border-b border-slate-100 dark:border-slate-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <Folder class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-slate-900 dark:text-white leading-snug">全站统一路径中枢</h3>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                全系统唯一的路径配置中枢：中转目录（追更与监控汇聚）与媒体库（规范归档入库）
              </p>
            </div>
          </div>

          <!-- 账号切换选择器 (紧凑贴合，切换按钮动线一体化) -->
          <div class="flex items-center gap-2 shrink-0">
            <AccountSwitcher
              v-model="selectedAccountId"
              :accounts="accountSwitcherItems"
              @select="handleAccountSwitch"
            />
          </div>
        </div>

        <!-- 说明信息（柔和科技蓝与中性灰，彻底根除突兀紫色） -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>全系统路径中枢与协同机制说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>全站唯一事实源</strong>：此处为全站唯一修改云盘路径的地方。修改后，频道监控转存、追更任务、自动定时归档、手动双栏整理及 STRM 扫描全部自动共用此配置。</li>
            <li>• <strong>源中转目录</strong>：单链追更与 Telegram 频道监控转存的初始汇聚点。待整理影视在此中转等待整理归档。</li>
            <li>• <strong>目标媒体库目录</strong>：经 TMDB 识别比对与结构化点分规范重命名后，最终分类归档入库的媒体库根路径。</li>
            <li>• <strong>互斥防环保护</strong>：源目录与目标归档目录<strong>绝对禁止配置为同一路径</strong>，系统内嵌门禁拦截，杜绝循环归档死锁。</li>
          </ul>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <!-- 1. 源中转目录 (彻底清除暂存区字样) -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                源目录（待整理中转）
              </label>
              <span class="text-[11px] text-amber-600 dark:text-amber-400 font-medium">转存资源汇流</span>
            </div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                :value="strategyConfig.stagingFolderName || ''"
                type="text"
                readonly
                placeholder="请点击右侧按钮选择网盘源中转目录 (必填)"
                class="input-base font-mono text-xs flex-1 w-full cursor-default bg-slate-50 dark:bg-slate-800/50"
                :class="{ 'border-amber-400 dark:border-amber-600': !strategyConfig.stagingFolderId }"
              />
              <button
                type="button"
                class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
                @click="openFolderPicker('staging')"
              >
                <Folder class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>选择源目录</span>
              </button>
            </div>
            <div class="flex items-center justify-between mt-1">
              <span class="form-text">
                待整理影视所在的源目录，整理完成后该目录内的空文件夹将被自动修剪
              </span>
              <span v-if="!strategyConfig.stagingFolderId" class="text-[11px] text-amber-600 dark:text-amber-400 font-semibold shrink-0">
                待配置
              </span>
            </div>
          </div>

          <!-- 2. 目标媒体库 (全部使用蓝色与灰色调) -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                目标目录（媒体库归档根目录）
              </label>
              <span class="text-[11px] text-blue-600 dark:text-blue-400 font-medium">最终规范归档</span>
            </div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                :value="strategyConfig.defaultTargetFolderName || ''"
                type="text"
                readonly
                placeholder="请点击右侧按钮选择影视归档目标目录 (必填)"
                class="input-base font-mono text-xs flex-1 w-full cursor-default bg-slate-50 dark:bg-slate-800/50"
                :class="{ 'border-rose-400 dark:border-rose-600': !strategyConfig.defaultTargetFolderId || strategyConfig.defaultTargetFolderId === '/' }"
              />
              <button
                type="button"
                class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
                @click="openFolderPicker('target')"
              >
                <Folder class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>选择归档目录</span>
              </button>
            </div>
            <div class="flex items-center justify-between mt-1">
              <span class="form-text">
                经 TMDB 识别和结构化点分重命名后，影视最终分类归档入库的根目录
              </span>
              <span v-if="!strategyConfig.defaultTargetFolderId || strategyConfig.defaultTargetFolderId === '/'" class="text-[11px] text-rose-500 font-semibold shrink-0">
                待配置
              </span>
            </div>
          </div>
        </div>

        <!-- 冲突互斥报警 -->
        <div
          v-if="strategyConfig.stagingFolderId && strategyConfig.defaultTargetFolderId && strategyConfig.stagingFolderId === strategyConfig.defaultTargetFolderId"
          class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400 flex items-center gap-2"
        >
          <AlertCircle class="w-4 h-4 shrink-0" />
          <span>安全警告：源目录与目标归档目录不能相同，否则会导致重复扫描与死循环归档！</span>
        </div>
      </div>

      <!-- 模块 2: 整理执行与定时调度 -->
      <div class="settings-card">
        <!-- 顶栏标题与立即整理操作 -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Clock class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">影视自动整理与归档</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                新转存的影视会自动识别并规范改名入库；您也可以随时点击右侧按钮立即扫描整理
              </p>
            </div>
          </div>

          <button
            type="button"
            :disabled="organizingNow"
            @click="handleOrganizeNow"
            class="btn-default text-xs h-8 px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-semibold text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors shadow-xs"
            title="立即扫描待整理目录中的视频文件并执行识别入库"
          >
            <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': organizingNow }" />
            <span>{{ organizingNow ? '正在扫描整理中...' : '立即扫描整理 139 云盘' }}</span>
          </button>
        </div>

        <!-- 待整理目录实时扫描整理状态条 -->
        <div
          v-if="organizingNow"
          class="p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 flex items-center justify-between gap-3 animate-pulse mb-4"
        >
          <div class="flex items-center gap-2.5 text-xs text-amber-700 dark:text-amber-300">
            <RotateCw class="w-4 h-4 animate-spin shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <span class="font-bold">待整理目录扫描整理中</span>
              <span class="ml-2 text-[11px] opacity-80">正在穿透检索中转视频并执行 TMDB 识别与点分归档...</span>
            </div>
          </div>
        </div>

        <!-- 核心开关 1: 后台定时自动整理 (对齐 ChannelView 规范) -->
        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between mb-4">
          <div class="space-y-0.5 pr-3">
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">
              后台定时自动整理
            </h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
              开启后按设定频率定时扫描源中转目录并规范入库；关闭则停止自动整理，仅保留手动触发
            </p>
          </div>
          <el-switch v-model="strategyConfig.autoOrganize" />
        </div>

        <!-- 整理轮询周期（对齐 ChannelView 规范：常驻展示，杜绝开关关闭导致配置项丢失） -->
        <div class="mb-4">
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            待整理目录扫描整理频率 (分钟)
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model.number="strategyConfig.organizeInterval"
              type="number"
              min="1"
              max="1440"
              placeholder="30"
              class="input-base font-mono text-xs w-28 sm:w-32"
            />
            <div class="flex flex-wrap items-center gap-1 text-xs">
              <button
                v-for="min in [5, 10, 15, 30, 60, 120]"
                :key="min"
                type="button"
                class="px-2 py-1 rounded-md border text-xs font-mono cursor-pointer transition-colors"
                :class="strategyConfig.organizeInterval === min ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-300'"
                @click="strategyConfig.organizeInterval = min"
              >
                {{ min }}分
              </button>
            </div>
          </div>
          <span class="form-text">
            后台自动巡检待整理中转目录的周期，发现待处理影视即刻自动识别并规范整理归档（建议 15~60 分钟）
          </span>
        </div>

        <!-- 核心开关 2: 整理后自动清理空文件夹 (对齐 ChannelView 规范) -->
        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
          <div class="space-y-0.5 pr-3">
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">
              整理后自动删除空文件夹
            </h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
              当视频分类改名搬移到媒体库后，自动清理源目录中搬空的无用空文件夹，保持网盘整洁清爽
            </p>
          </div>
          <el-switch v-model="strategyConfig.sweepEmptyFolders" />
        </div>
      </div>

      <!-- 模块 3: 分类策略与多级归档路径 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
            <Layers class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">分类策略</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              按影视类型、独立一级分类、地区与年份多级归档
            </p>
          </div>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">添加儿童节目分类</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                将包含儿童动画/节目的内容单独分类到指定独立目录
              </p>
            </div>
            <el-switch v-model="strategyConfig.classifyChildren" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">添加演唱会分类</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                将演唱会/音乐会内容单独分类到指定独立目录
              </p>
            </div>
            <el-switch v-model="strategyConfig.classifyConcerts" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">按地区二次分类</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                在类型目录下，按华语、欧美、日韩等地区进一步细分子目录
              </p>
            </div>
            <el-switch v-model="strategyConfig.classifyRegion" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">按年份三次分类</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                在分类目录下，按影视年份创建子目录归档（如 /剧集/华语/2024/庆余年）
              </p>
            </div>
            <el-switch v-model="strategyConfig.classifyYear" />
          </div>
        </div>
      </div>

      <!-- 模块 4: 资源过滤与排除策略 (全站排除规则集中化收拢，彻底消除重复与分散) -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-slate-100 dark:border-slate-800">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Shield class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white leading-snug">资源过滤与排除策略</h3>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              集中设置哪些杂乱或非目标文件不被整理入库（支持按文件体积、敏感关键词、非视频及有声书精准过滤）
            </p>
          </div>
        </div>

        <!-- 基础体积与敏感词过滤 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              小文件过滤 (MB)
            </label>
            <input
              v-model.number="strategyConfig.minFileSize"
              type="number"
              min="0"
              step="5"
              placeholder="50"
              class="input-base text-xs font-mono"
            />
            <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">小于此大小的文件将被跳过整理 (默认 50MB，自动拦截宣传短片/样片)</p>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              忽略关键词
            </label>
            <input
              v-model="strategyConfig.ignoreKeywords"
              type="text"
              placeholder="广告, 样片, 预告, sample"
              class="input-base text-xs"
            />
            <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">包含关键词的文件将被跳过整理，支持多个关键词逗号分隔</p>
          </div>
        </div>

        <!-- 智能类型与内容排除开关组 -->
        <div class="space-y-3">
          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div class="pr-2">
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">跳过非视频与说明文件</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                遇到 txt 文本、图片、网页链接等非视频文件时自动忽略，不移入媒体库
              </p>
            </div>
            <el-switch v-model="strategyConfig.excludeNonVideo" />
          </div>

          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div class="pr-2">
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">过滤有声书与纯音频</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                自动识别并拦截有声书、广播剧、评书、相声及纯音频小说资源，仅聚焦影视媒体
              </p>
            </div>
            <el-switch v-model="strategyConfig.ignoreAudiobooks" />
          </div>

          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div class="pr-2">
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">跳过预告片与宣传短片</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                自动过滤文件名含有 sample、trailer、preview 等预告片段或广告宣传小文件
              </p>
            </div>
            <el-switch v-model="strategyConfig.excludeTrailersAndSamples" />
          </div>

          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div class="pr-2">
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">跳过无中文字幕的外语影视</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                仅针对外国影视：若文件名及所在文件夹中没有中文字幕标识（如中字、双语、CHS 等），则自动跳过不入库
              </p>
            </div>
            <el-switch v-model="strategyConfig.excludeNoChineseSubtitle" />
          </div>
        </div>
      </div>

      <!-- 模块 5: TMDB 规范重命名 (纯粹聚焦于命名规则) -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-slate-100 dark:border-slate-800">
          <div class="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
            <FileCode class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white leading-snug">TMDB 规范重命名</h3>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              结构化点分规范命名、官方单集小标题注入与真实画质规格提取
            </p>
          </div>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">TMDB 规范重命名</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                启用时按 TMDB 识别结果改为结构化点分规范命名；关闭时保留原盘文件名
              </p>
            </div>
            <el-switch v-model="strategyConfig.enableRename" />
          </div>

          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">显示官方单集标题</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                启用时在剧集文件名中注入 TMDB 官方单集小标题（如 S01E08.萧龙女李信法庭对决.2160p）；关闭时仅保留季集编号（如 S01E08.2160p）
              </p>
            </div>
            <el-switch v-model="strategyConfig.includeEpisodeTitle" />
          </div>

          <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">媒体信息提取完善命名</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                启用时通过二进制探针提取真实流属性（分辨率、HDR、音频编码等）完善文件名
              </p>
            </div>
            <el-switch v-model="strategyConfig.enableMediaInfo" />
          </div>
        </div>
      </div>

      <!-- 模块 5: 通知策略 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Bell class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">整理入库通知</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              整理入库完成后即时向 Telegram 推送结果汇报卡片
            </p>
          </div>
        </div>

        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
          <div>
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">整理入库通知开关</h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              开启后，每次自动或手动整理入库完成后发送 Telegram 推送
            </p>
          </div>
          <el-switch v-model="strategyConfig.notifyOnOrganize" />
        </div>
      </div>

      <!-- 模块 6: STRM 生成联动 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <FileVideo class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">STRM 文件自动生成</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              媒体整理入库后自动生成对应的 .strm 文件，支持 139 官方 CDN 原生 302 直链播放与 AList / WebDAV 挂载
            </p>
          </div>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">整理入库后自动生成 STRM 文件</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                无论是 Telegram 频道监控自动整理还是手动双栏整理，视频归档成功后自动在本地生成同结构 .strm
              </p>
            </div>
            <el-switch v-model="strategyConfig.linkStrm" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">STRM 生成统计明细推送通知</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                STRM 批量写入完成后，向 Telegram 发送成功/跳过/失败的明细卡片
              </p>
            </div>
            <el-switch v-model="strategyConfig.notifyOnStrm" />
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 视口: 暂存区未识别媒体分组治理与人工纠偏工作台 (参考图二) ================= -->
    <template v-else-if="activeMainTab === 'manual'">
      <!-- 刮削工作台精简高效顶部工具栏 (选源一体化，心智极简) -->
      <div class="settings-card flex flex-col lg:flex-row lg:items-center justify-between gap-3 !py-2.5 !mb-3 shrink-0">
        <!-- 左侧: 标题 + 整理文件夹选择器 + 状态统计 -->
        <div class="flex items-center gap-3 flex-wrap sm:flex-nowrap min-w-0">
          <div class="flex items-center gap-2 shrink-0">
            <div class="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <Sparkles class="w-4 h-4" />
            </div>
            <span class="text-sm font-bold text-slate-900 dark:text-white shrink-0">刮削工作台</span>
          </div>

          <!-- 整理文件夹选择器 (直觉明了，任何目录一键选择更换) -->
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              @click="pickWorkbenchFolder"
              class="flex items-center gap-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-700/80 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer transition-all text-xs group shrink-0"
              title="点击选择希望整理的云盘文件夹"
            >
              <Folder class="w-4 h-4 text-indigo-500 dark:text-indigo-400 shrink-0 group-hover:scale-105 transition-transform" />
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-slate-500 dark:text-slate-400 font-medium shrink-0">整理文件夹:</span>
                <span class="font-semibold text-slate-800 dark:text-slate-100 truncate max-w-[160px] sm:max-w-[240px] font-mono">
                  {{ currentWorkbenchDisplayPath }}
                </span>
              </div>
              <ChevronDown class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 shrink-0 ml-0.5" />
            </button>
            <button
              v-if="hasUserSelectedSourceFolder"
              type="button"
              @click="clearWorkbenchFolder"
              class="p-1.5 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors shrink-0"
              title="清空当前整理文件夹，返回选择引导"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- 归档目标库选择器 (一目了然，源与目标双轨呈现) -->
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              @click="openFolderPicker('target')"
              class="flex items-center gap-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-700/80 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer transition-all text-xs group shrink-0"
              title="点击更换整理后的目标归档媒体库目录"
            >
              <FolderCheck class="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0 group-hover:scale-105 transition-transform" />
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-slate-500 dark:text-slate-400 font-medium shrink-0">归档媒体库:</span>
                <span class="font-semibold text-slate-800 dark:text-slate-100 truncate max-w-[140px] sm:max-w-[200px] font-mono">
                  {{ currentTargetDisplayPath }}
                </span>
              </div>
              <ChevronDown class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 shrink-0 ml-0.5" />
            </button>
            <button
              v-if="hasUserSelectedTargetFolder"
              type="button"
              @click="clearWorkbenchTargetFolder"
              class="p-1.5 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors shrink-0"
              title="清空当前归档目标目录，返回未选择状态"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- 状态徽章 (紧随其后) -->
          <span v-if="loadingUnrecognized" class="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 shrink-0 flex items-center gap-1.5 border border-indigo-200/60 dark:border-indigo-800/60">
            <RotateCw class="w-3 h-3 animate-spin text-indigo-600" />
            <span>{{ scanStageText }} ({{ scanElapsedSeconds }}s · {{ scanProgressPercent }}%)</span>
          </span>
          <span v-else-if="mediaGroups.length > 0" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 shrink-0">
            {{ mediaGroups.length }} 组 · {{ totalUnrecognizedCount }} 项待治理
          </span>
          <span v-else class="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 shrink-0">
            已全部归档
          </span>
        </div>

        <!-- 右侧: 清空与刷新 -->
        <div class="flex items-center gap-2 shrink-0 justify-end">
          <!-- 一键清空任务按钮 -->
          <button
            v-if="mediaGroups.length > 0 || unrecognizedFiles.length > 0"
            type="button"
            :disabled="loadingUnrecognized || batchResolvingNow"
            @click="clearAllTasks"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1 cursor-pointer text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border-rose-200 dark:border-rose-900/60 shrink-0 font-medium"
            title="清空当前工作台展示的任务列表并清除草稿"
          >
            <Trash2 class="w-3.5 h-3.5" />
            <span>一键清空任务</span>
          </button>

          <!-- 刷新按钮 -->
          <button
            type="button"
            :disabled="loadingUnrecognized"
            @click="clearWorkspaceDraftAndReload"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1 cursor-pointer text-slate-700 dark:text-slate-300 shrink-0"
            title="重新扫描当前选中的文件夹"
          >
            <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loadingUnrecognized }" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <!-- 防撞档互斥锁提示横幅 -->
      <div
        v-if="isFolderLocked"
        class="p-3.5 rounded-xl border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-200"
      >
        <div class="flex items-center gap-2">
          <AlertTriangle class="w-4 h-4 text-amber-600 shrink-0" />
          <span>
            <strong>防撞档安全保护生效中：</strong>
            当前目录正被后台任务 [{{ folderLockInfo.owner || 'auto_staging' }}] 占用运行中 ({{ folderLockInfo.task || '自动整理' }})，已自动挂起写入权限，避免并发跨目录移动与探针冲突。
          </span>
        </div>
      </div>

      <!-- 用户未选定待整理文件夹时的全景新手引导卡片 -->
      <div v-if="!hasUserSelectedSourceFolder" class="settings-card flex flex-col items-center justify-center py-16 px-6 text-center">
        <div class="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 ring-8 ring-indigo-50/50 dark:ring-indigo-950/20">
          <FolderSearch class="w-8 h-8" />
        </div>
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">
          请选择需要整理的网盘文件夹
        </h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 max-w-md leading-relaxed mb-6">
          刮削工作台支持对 139 移动云盘中任意目录进行智能整理与规范归档。请点击下方按钮选择包含待整理影视视频的文件夹（如转存目录、下载目录或特定剧集文件夹）。
        </p>

        <div class="flex items-center gap-3">
          <button
            type="button"
            @click="pickWorkbenchFolder"
            class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-medium text-xs rounded-xl shadow-sm hover:shadow transition-all flex items-center gap-2 cursor-pointer"
          >
            <Folder class="w-4 h-4" />
            <span>浏览选择网盘文件夹</span>
          </button>
        </div>
      </div>

      <!-- 双分栏工作台 (仅在已选择文件夹时展现，固定视口自适应高度) -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5 items-stretch lg:h-[calc(100vh-175px)] lg:max-h-[calc(100vh-175px)] min-h-[520px]">
        <!-- 左分栏：媒体文件夹/剧集分组列表 (占 4 格) -->
        <div class="lg:col-span-4 flex flex-col h-full min-h-0 overflow-hidden">
          <div class="settings-card flex flex-col h-full !mb-0 overflow-hidden space-y-3 !p-3.5">
            <!-- 工具栏与筛选 -->
            <div class="flex items-center justify-between pb-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <div class="flex items-center gap-2">
                <Layers class="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <h4 class="text-xs font-bold text-gray-900 dark:text-white">媒体分组</h4>
              </div>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200/60 dark:border-amber-900 font-mono">
                共 {{ mediaGroups.length }} 组
              </span>
            </div>

            <!-- 本地搜索与快速过滤胶囊 -->
            <div class="space-y-2 shrink-0">
              <div class="relative">
                <Search class="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  v-model="groupSearchQuery"
                  class="input-base text-xs pl-8 !h-8 !py-1 w-full bg-slate-50 dark:bg-slate-800/60 rounded-lg"
                  placeholder="过滤媒体文件夹名称..."
                />
              </div>

              <div class="flex items-center gap-1.5 text-[11px]">
                <button
                  type="button"
                  @click="groupFilterStatus = 'all'"
                  :class="groupFilterStatus === 'all' ? 'bg-indigo-600 text-white font-medium shadow-2xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'"
                  class="px-2 py-0.5 rounded cursor-pointer transition-colors"
                >
                  全部 ({{ mediaGroups.length }})
                </button>
                <button
                  type="button"
                  @click="groupFilterStatus = 'unmatched'"
                  :class="groupFilterStatus === 'unmatched' ? 'bg-indigo-600 text-white font-medium shadow-2xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'"
                  class="px-2 py-0.5 rounded cursor-pointer transition-colors"
                >
                  待匹配 ({{ mediaGroups.length - matchedGroupCount }})
                </button>
                <button
                  type="button"
                  @click="groupFilterStatus = 'matched'"
                  :class="groupFilterStatus === 'matched' ? 'bg-indigo-600 text-white font-medium shadow-2xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'"
                  class="px-2 py-0.5 rounded cursor-pointer transition-colors"
                >
                  已匹配 ({{ matchedGroupCount }})
                </button>
              </div>

              <!-- 一键批量智能匹配 TMDB -->
              <div v-if="mediaGroups.length > 0 && (mediaGroups.length - matchedGroupCount) > 0" class="pt-0.5">
                <button
                  type="button"
                  :disabled="autoMatchingAll || loadingUnrecognized"
                  @click="autoMatchAllGroups"
                  class="w-full h-7 px-2.5 text-[11px] font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                  title="自动为所有待匹配的分组根据文件夹片名发起 TMDB 智能检索"
                >
                  <RotateCw v-if="autoMatchingAll" class="w-3 h-3 animate-spin text-indigo-600" />
                  <Sparkles v-else class="w-3 h-3 text-indigo-600 dark:text-indigo-400" />
                  <span>{{ autoMatchingAll ? autoMatchProgressText : `一键智能匹配全部 (${mediaGroups.length - matchedGroupCount} 组)` }}</span>
                </button>
              </div>

              <!-- 拆分选中文件工具条 -->
              <div v-if="selectedFileIdsForSplit.size > 0" class="pt-0.5">
                <button
                  type="button"
                  @click="splitSelectedFilesToNewGroup"
                  class="w-full h-7 px-2.5 text-[11px] font-semibold rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                  :title="`将右侧勾选的 ${selectedFileIdsForSplit.size} 个文件拆分出独立新分组`"
                >
                  <Layers class="w-3 h-3 text-amber-600" />
                  <span>拆分所选文件到新组 ({{ selectedFileIdsForSplit.size }} 项)</span>
                </button>
              </div>
            </div>

            <!-- 媒体分组卡片流 (可滚动) -->
            <div v-if="loadingUnrecognized && filteredGroups.length === 0" class="p-8 text-center space-y-4 flex-1 flex flex-col justify-center items-center">
              <div class="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center ring-4 ring-indigo-50/50">
                <RotateCw class="w-6 h-6 animate-spin" />
              </div>
              <div class="space-y-1.5 max-w-xs w-full">
                <div class="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 font-medium">
                  <span>{{ scanStageText }}</span>
                  <span class="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">{{ scanProgressPercent }}%</span>
                </div>
                <!-- 进度条 -->
                <div class="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2 overflow-hidden shadow-inner">
                  <div
                    class="bg-indigo-600 dark:bg-indigo-500 h-2 rounded-full transition-all duration-300 ease-out"
                    :style="{ width: `${scanProgressPercent}%` }"
                  ></div>
                </div>
                <div class="text-[11px] text-slate-400 flex items-center justify-between pt-0.5">
                  <span>深度扫描网盘目录中</span>
                  <span class="font-mono">已耗时 {{ scanElapsedSeconds }}s</span>
                </div>
              </div>
            </div>

            <div v-else-if="filteredGroups.length === 0" class="p-10 text-center border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl space-y-2 flex-1 flex flex-col justify-center items-center">
              <CheckCircle2 class="w-8 h-8 mx-auto text-emerald-500 opacity-80" />
              <h5 class="text-xs font-bold text-slate-700 dark:text-slate-300">
                {{ groupSearchQuery ? '未找到符合条件的媒体分组' : '所选文件夹中暂无待治理的分组' }}
              </h5>
              <p class="text-[11px] text-slate-400 max-w-xs mx-auto">
                {{ groupSearchQuery ? '请尝试修改搜索词' : '当前文件夹内暂无媒体视频，请点击上方更换文件夹' }}
              </p>
            </div>

            <div v-else class="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1">
              <!-- 后台静默校验提示微条 -->
              <div v-if="loadingUnrecognized" class="p-2 mb-2 rounded-lg bg-indigo-50/90 dark:bg-indigo-950/40 text-[11px] text-indigo-700 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-900/40 space-y-1.5">
                <div class="flex items-center justify-between font-medium">
                  <span class="flex items-center gap-1.5">
                    <RotateCw class="w-3 h-3 animate-spin text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span>{{ scanStageText }}</span>
                  </span>
                  <span class="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">{{ scanElapsedSeconds }}s · {{ scanProgressPercent }}%</span>
                </div>
                <div class="w-full bg-indigo-100 dark:bg-indigo-900/60 rounded-full h-1 overflow-hidden">
                  <div
                    class="bg-indigo-600 h-1 rounded-full transition-all duration-300 ease-out"
                    :style="{ width: `${scanProgressPercent}%` }"
                  ></div>
                </div>
              </div>
              <div
                v-for="group in filteredGroups"
                :key="group.id"
                @click="selectActiveGroup(group.id)"
                class="p-2.5 rounded-lg border transition-all cursor-pointer flex items-center gap-2.5"
                :class="[
                  group.tmdbCandidate ? 'border-l-[3px] border-l-emerald-500' : 'border-l-[3px] border-l-amber-400',
                  activeGroupId === group.id
                    ? 'bg-blue-50/70 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 shadow-2xs'
                    : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                ]"
              >
                <!-- 海报小图 (36px, aspect 2/3) -->
                <div class="w-9 h-[54px] rounded bg-slate-100 dark:bg-slate-800 shrink-0 overflow-hidden border border-slate-200/80 dark:border-slate-700 flex items-center justify-center">
                  <img
                    v-if="group.tmdbCandidate?.poster_path || group.tmdbCandidate?.posterPath"
                    :src="formatPosterUrl(group.tmdbCandidate.poster_path || group.tmdbCandidate.posterPath)"
                    @error="handlePosterError"
                    :alt="group.folderName"
                    class="w-full h-full object-cover"
                    loading="lazy"
                  />
                  <Tv v-else-if="group.mediaType === 'tv'" class="w-4 h-4 text-slate-400" />
                  <Film v-else class="w-4 h-4 text-slate-400" />
                </div>

                <!-- 文本信息 -->
                <div class="min-w-0 flex-1 space-y-0.5">
                  <h5 class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate" :title="group.folderName">
                    {{ group.folderName }}
                  </h5>

                  <div class="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                    <span v-if="!isGroupMovie(group) && typeof group.targetSeason === 'number' && !isNaN(group.targetSeason)">
                      第 {{ group.targetSeason }} 季 ·
                    </span>
                    <span v-else-if="isGroupMovie(group)">电影 · </span>
                    <span>{{ group.files.length }} 个文件</span>
                  </div>

                  <!-- 状态简明标记 (对齐 139 脚本) -->
                  <div class="text-[11px] truncate flex items-center gap-1.5">
                    <span
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :class="group.tmdbCandidate ? 'bg-emerald-500' : 'bg-amber-400'"
                    ></span>
                    <span v-if="group.tmdbCandidate" class="text-emerald-700 dark:text-emerald-400 font-medium truncate" :title="group.tmdbCandidate.title || group.tmdbCandidate.name">
                      已匹配: 《{{ group.tmdbCandidate.title || group.tmdbCandidate.name }}》
                    </span>
                    <span v-else class="text-amber-600 dark:text-amber-400 font-medium">
                      待检索匹配
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右分栏：当前媒体分组精准微调与归档工作台 (占 8 格，参考图二) -->
        <div class="lg:col-span-8 flex flex-col h-full min-h-0 overflow-hidden">
          <!-- 状态 1: 未选中任何分组 -->
          <div v-if="!activeGroup" class="settings-card p-16 text-center border-2 border-dashed border-slate-200 dark:border-slate-800 space-y-3 flex-1 flex flex-col justify-center items-center h-full">
            <Sparkles class="w-10 h-10 mx-auto text-amber-500/70" />
            <h4 class="text-sm font-bold text-slate-800 dark:text-slate-200">
              请在左侧选择需要人工治理的媒体分组
            </h4>
            <p class="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
              选定剧集文件夹后，可在右侧针对该媒体分组精准检索 TMDB、调整季集并一键规范归档入库。
            </p>
          </div>

          <!-- 状态 2: 已选中具体分组 (极简、克制、专业文件工作台排版) -->
          <div v-else class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden flex flex-col h-full min-h-0">
            <!-- 模块 A: 影视信息与检索一体化工作头 (清爽无色药丸，素雅专业) -->
            <div class="p-3.5 space-y-2.5 bg-slate-50/70 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <!-- 头信息排面 -->
              <div class="flex items-center gap-3">
                <div class="w-12 h-18 rounded bg-slate-100 dark:bg-slate-800 shrink-0 overflow-hidden border border-slate-200 dark:border-slate-700 flex items-center justify-center shadow-2xs">
                  <img
                    v-if="activeGroup.tmdbCandidate?.poster_path || activeGroup.tmdbCandidate?.posterPath"
                    :src="formatPosterUrl(activeGroup.tmdbCandidate.poster_path || activeGroup.tmdbCandidate.posterPath)"
                    @error="handlePosterError"
                    :alt="activeGroup.folderName"
                    class="w-full h-full object-cover"
                  />
                  <Tv v-else-if="activeGroup.mediaType === 'tv'" class="w-5 h-5 text-slate-400" />
                  <Film v-else class="w-5 h-5 text-slate-400" />
                </div>

                <div class="min-w-0 flex-1 space-y-1">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-baseline gap-2 truncate">
                      <h4 class="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                        {{ activeGroup.tmdbCandidate?.title || activeGroup.tmdbCandidate?.name || activeGroup.folderName }}
                      </h4>
                      <span v-if="activeGroup.tmdbCandidate?.release_date || activeGroup.tmdbCandidate?.first_air_date || activeGroup.year" class="text-xs font-mono text-slate-400 shrink-0">
                        ({{ (activeGroup.tmdbCandidate?.release_date || activeGroup.tmdbCandidate?.first_air_date || '').substring(0, 4) || activeGroup.year }})
                      </span>
                      <span v-if="displayFolderAlias" class="text-[11px] text-slate-500 bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5 rounded truncate shrink-0" :title="activeGroup.folderName">
                        原名: {{ displayFolderAlias }}
                      </span>
                    </div>

                    <div class="flex items-center gap-2 shrink-0">
                      <button
                        v-if="activeGroup.tmdbCandidate"
                        type="button"
                        @click="unmatchActiveGroup"
                        class="text-xs text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors cursor-pointer font-medium"
                        title="取消当前组的 TMDB 匹配条目，恢复待匹配状态"
                      >
                        取消匹配
                      </button>
                      <button
                        type="button"
                        @click="resetActiveGroupEpisodes"
                        class="text-xs text-slate-400 hover:text-rose-600 transition-colors cursor-pointer font-medium"
                        title="重置当前组的分集映射与修改"
                      >
                        重置修改
                      </button>
                    </div>
                  </div>

                  <!-- 优雅单行元数据标签 -->
                  <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                    <span class="inline-flex items-center gap-1 font-medium" :class="activeGroup.tmdbCandidate ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'">
                      <span class="w-1.5 h-1.5 rounded-full" :class="activeGroup.tmdbCandidate ? 'bg-emerald-500' : 'bg-amber-400'"></span>
                      <span>{{ activeGroup.tmdbCandidate ? '已匹配' : '待匹配' }}</span>
                    </span>
                    <template v-if="!isGroupMovie(activeGroup) && typeof activeGroup.targetSeason === 'number' && !isNaN(activeGroup.targetSeason)">
                      <span>·</span>
                      <span class="px-1.5 py-0.2 rounded bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 font-medium text-[11px]">
                        第 {{ activeGroup.targetSeason }} 季
                      </span>
                    </template>
                    <span>·</span>
                    <span class="px-1.5 py-0.2 rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-medium text-[11px]">
                      {{ activeGroup.targetCategory }}
                    </span>
                    <span>·</span>
                    <span class="text-slate-400 font-mono text-[11px]">共 {{ activeGroup.files.length }} 个文件</span>
                    <template v-if="activeGroup.tmdbCandidate?.id">
                      <span>·</span>
                      <span class="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-mono font-medium text-[11px]">
                        TMDB: {{ activeGroup.tmdbCandidate.id }}
                      </span>
                    </template>
                    <template v-if="probingCurrentGroup || checkingWash">
                      <span>·</span>
                      <span class="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300 font-medium text-[11px] animate-pulse">
                        <RotateCw class="w-2.5 h-2.5 animate-spin" />
                        <span>{{ probingCurrentGroup ? '正在静默嗅探规格...' : '正在静默洗版预检...' }}</span>
                      </span>
                    </template>
                    <template v-else-if="activeGroup.tmdbCandidate">
                      <span>·</span>
                      <span class="px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 text-[11px]">
                        规格与洗版预检就绪
                      </span>
                    </template>
                  </div>
                </div>
              </div>

              <!-- 搜索与识别控制栏 -->
              <div class="flex items-center gap-2 w-full pt-1 flex-wrap sm:flex-nowrap">
                <div class="relative flex-1 min-w-[160px]">
                  <Search class="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    v-model="tmdbSearchQuery"
                    @keyup.enter="doSearchTmdb"
                    type="text"
                    class="w-full h-8 pl-8 pr-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="输入影视名或 TMDB ID 回车检索..."
                  />
                </div>

                <select
                  v-model="tmdbSearchMediaType"
                  class="w-18 shrink-0 h-8 px-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="tv">剧集</option>
                  <option value="movie">电影</option>
                  <option value="">自动</option>
                </select>

                <button
                  type="button"
                  :disabled="isSearchingTmdb"
                  @click="doSearchTmdb"
                  class="h-8 px-3.5 shrink-0 flex items-center gap-1.5 cursor-pointer font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition-colors text-xs"
                >
                  <RotateCw v-if="isSearchingTmdb" class="w-3 h-3 animate-spin" />
                  <Search v-else class="w-3 h-3" />
                  <span>{{ isSearchingTmdb ? '检索中...' : '搜索' }}</span>
                </button>

                <button
                  type="button"
                  @click="autoIdentifyMetadata"
                  class="h-8 px-2.5 shrink-0 flex items-center gap-1 cursor-pointer rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs transition-colors"
                  title="重置检索词为原始目录片名"
                >
                  <RotateCcw class="w-3 h-3 text-slate-400" />
                  <span>重置检索</span>
                </button>
              </div>

              <!-- 灵犀 AI 对话解析反馈 (直观透出移动 AI 问答结果，消除黑盒感) -->
              <div v-if="aiDialogueExplanation" class="p-2.5 rounded-lg bg-purple-50/80 dark:bg-purple-950/30 border border-purple-200/70 dark:border-purple-800/60 text-xs flex items-start justify-between gap-2 shadow-2xs">
                <div class="flex items-start gap-2">
                  <Bot class="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
                  <div class="space-y-1">
                    <div class="font-semibold text-purple-800 dark:text-purple-300 flex items-center gap-1.5">
                      <span>灵犀 AI 识别与解读</span>
                      <span class="px-1.5 py-0.2 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200 text-[10px] font-normal">精炼元数据</span>
                    </div>
                    <p class="text-purple-900/90 dark:text-purple-200 leading-relaxed font-sans whitespace-pre-line text-[11px]">{{ aiDialogueExplanation }}</p>
                  </div>
                </div>
                <button
                  type="button"
                  @click="aiDialogueExplanation = ''"
                  class="text-purple-400 hover:text-purple-700 dark:hover:text-purple-200 text-xs cursor-pointer shrink-0"
                >
                  关闭
                </button>
              </div>

              <!-- TMDB 候选结果列表 -->
              <div v-if="tmdbCandidates.length > 0" class="pt-0.5">
                <!-- 状态 A: 折叠时，若有多项候选，仅展示简洁轻巧的切换链接 -->
                <div v-if="isCandidatesCollapsed && tmdbCandidates.length > 1" class="flex items-center justify-end text-xs pt-0.5">
                  <button
                    type="button"
                    @click="isCandidatesCollapsed = false"
                    class="text-[11px] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline cursor-pointer flex items-center gap-1 font-medium"
                  >
                    <span>切换其他候选 (共 {{ tmdbCandidates.length }} 条)</span>
                    <ChevronDown class="w-3 h-3" />
                  </button>
                </div>

                <!-- 状态 B: 展开候选卡片流 -->
                <div v-else-if="!isCandidatesCollapsed" class="space-y-2 pt-1">
                  <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
                    <span>TMDB 候选影视 (点击选定):</span>
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-[10px]">共找到 {{ tmdbCandidates.length }} 条候选</span>
                      <button
                        type="button"
                        @click="isCandidatesCollapsed = true"
                        class="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer flex items-center gap-0.5"
                      >
                        <span>收起候选</span>
                        <ChevronUp class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[180px] overflow-y-auto pr-1">
                    <div
                      v-for="cand in tmdbCandidates"
                      :key="cand.id"
                      class="p-2 rounded-lg border flex items-center gap-2.5 transition-all cursor-pointer"
                      :class="activeGroup.tmdbCandidate?.id === cand.id ? 'bg-slate-50 dark:bg-slate-800 border-indigo-500 shadow-2xs' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300'"
                      @click="selectTmdbCandidate(cand)"
                    >
                      <div class="w-8 h-11 rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
                        <img
                          v-if="cand.poster_path || cand.posterPath"
                          :src="formatPosterUrl(cand.poster_path || cand.posterPath)"
                          @error="handlePosterError"
                          :alt="cand.title || cand.name"
                          class="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <Tv v-else-if="cand.media_type === 'tv'" class="w-4 h-4 text-slate-400" />
                        <Film v-else class="w-4 h-4 text-slate-400" />
                      </div>

                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5">
                          <h5 class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                            {{ cand.title || cand.name }}
                          </h5>
                          <span class="text-[10px] text-slate-400 font-sans shrink-0">
                            {{ cand.media_type === 'movie' ? '电影' : '剧集' }}
                          </span>
                        </div>
                        <p class="text-[10px] text-slate-400 font-mono mt-0.5">
                          {{ cand.release_date || cand.first_air_date || '未知年份' }} · TMDB: {{ cand.id }}
                        </p>
                      </div>

                      <div v-if="activeGroup.tmdbCandidate?.id === cand.id" class="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center shrink-0">
                        <Check class="w-2.5 h-2.5 stroke-3" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 模块 B: 手动整理与分集控制 (内嵌全量手动整理参数，无需多余弹窗) -->
            <div class="px-3.5 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <div
                class="flex items-center justify-between cursor-pointer select-none text-xs"
                @click="activeGroup.isTuningCollapsed = !activeGroup.isTuningCollapsed; saveWorkspaceDraft()"
              >
                <div class="flex items-center gap-2">
                  <SlidersHorizontal class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span class="font-bold text-slate-800 dark:text-slate-200">手动整理与分集控制</span>
                  <span class="text-slate-400 font-mono text-[11px] ml-1">
                    《{{ activeGroup.customTitle || (activeGroup.tmdbCandidate ? (activeGroup.tmdbCandidate.title || activeGroup.tmdbCandidate.name) : activeGroup.rawTitle) }}》
                    <template v-if="!isGroupMovie(activeGroup)">
                      <span v-if="typeof activeGroup.targetSeason === 'number' && !isNaN(activeGroup.targetSeason)"> · 第 {{ activeGroup.targetSeason }} 季</span>
                      <span> · 起始 E{{ String(activeGroup.startEpisode || 1).padStart(2, '0') }}</span>
                    </template>
                    · {{ activeGroup.targetCategory }}
                  </span>
                </div>
                <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                  <ChevronDown class="w-3.5 h-3.5 transition-transform" :class="{ '-rotate-180': !activeGroup.isTuningCollapsed }" />
                </button>
              </div>

              <!-- 平铺排布手动整理与微调栏 -->
              <div v-show="!activeGroup.isTuningCollapsed" class="space-y-2.5 pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                <!-- 第一行：核心元数据直编 (片名、首播年份、分类、目标季号、起始集号) -->
                <div class="flex items-center gap-2.5 flex-wrap">
                  <div class="flex items-center gap-1.5">
                    <span class="text-slate-500 text-[11px] font-medium shrink-0">片名:</span>
                    <input
                      v-model="activeGroup.customTitle"
                      :placeholder="activeGroup.tmdbCandidate ? (activeGroup.tmdbCandidate.title || activeGroup.tmdbCandidate.name) : activeGroup.rawTitle"
                      @input="saveWorkspaceDraft"
                      type="text"
                      class="h-7 px-2 text-xs w-40 sm:w-48 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500 font-medium transition-colors"
                      title="直接修改片名，无需 TMDB ID 也可规范归档入库"
                    />
                  </div>

                  <div class="flex items-center gap-1.5">
                    <span class="text-slate-500 text-[11px] font-medium shrink-0">年份:</span>
                    <input
                      v-model="activeGroup.customYear"
                      :placeholder="(activeGroup.tmdbCandidate?.release_date || activeGroup.tmdbCandidate?.first_air_date || '').slice(0, 4) || activeGroup.year"
                      @input="saveWorkspaceDraft"
                      type="text"
                      class="w-16 h-7 px-1 text-center font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500"
                      title="影视首播年份"
                    />
                  </div>

                  <div class="flex items-center gap-1.5">
                    <span class="text-slate-500 text-[11px] font-medium shrink-0">分类:</span>
                    <select
                      v-model="activeGroup.targetCategory"
                      @change="onTargetCategoryChanged"
                      class="h-7 px-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500 cursor-pointer"
                    >
                      <option v-for="cat in availableCategories" :key="cat" :value="cat">{{ cat }}</option>
                    </select>
                  </div>

                  <div v-if="!isGroupMovie(activeGroup)" class="flex items-center gap-1.5">
                    <span class="text-slate-500 text-[11px] font-medium shrink-0">季度:</span>
                    <input
                      v-model.number="activeGroup.targetSeason"
                      @change="onTargetSeasonChanged"
                      type="number"
                      min="0"
                      max="99"
                      class="w-12 h-7 px-1 text-center font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500 font-bold"
                      title="目标季号，0 为特别篇 Season 00"
                    />
                  </div>

                  <div v-if="!isGroupMovie(activeGroup)" class="flex items-center gap-1.5">
                    <span class="text-slate-500 text-[11px] font-medium shrink-0">起始集:</span>
                    <input
                      v-model.number="activeGroup.startEpisode"
                      @change="onStartEpisodeChanged"
                      type="number"
                      min="1"
                      max="999"
                      class="w-14 h-7 px-1 text-center font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500 font-bold"
                      title="本组首个文件的起始集号"
                    />
                  </div>
                </div>

                <!-- 第二行：分集偏移、整理方式、小文件过滤与快捷工具 -->
                <div class="flex items-center gap-2.5 flex-wrap pt-1.5 border-t border-slate-50 dark:border-slate-800/60">
                  <div v-if="!isGroupMovie(activeGroup)" class="flex items-center gap-1">
                    <span class="text-slate-500 text-[11px]">集号偏移:</span>
                    <div class="inline-flex items-center">
                      <input
                        v-model.number="activeGroup.episodeOffset"
                        type="number"
                        min="-99"
                        max="99"
                        placeholder="0"
                        class="w-11 h-7 px-1 text-center font-mono text-xs rounded-l border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        @click="applyEpisodeOffset"
                        class="h-7 px-2 text-[11px] border border-l-0 border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-r cursor-pointer font-medium"
                      >
                        应用
                      </button>
                    </div>
                  </div>

                  <button
                    v-if="!isGroupMovie(activeGroup)"
                    type="button"
                    @click="reorderActiveGroupEpisodes"
                    class="btn-default text-xs h-7 px-2.5 cursor-pointer flex items-center gap-1 text-slate-700 dark:text-slate-300 font-medium rounded"
                    title="按文件名顺序依次赋值 E01, E02, ..."
                  >
                    <Hash class="w-3 h-3 text-slate-400" />
                    <span>顺序编号</span>
                  </button>

                  <!-- 整理方式：移动 / 复制 -->
                  <div class="flex items-center gap-1.5 ml-1">
                    <span class="text-slate-500 text-[11px]">整理方式:</span>
                    <select
                      v-model="activeGroupTransferType"
                      class="h-7 px-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="move">移动 (释放源目录空间，推荐)</option>
                      <option value="copy">复制 (保留源文件保底)</option>
                    </select>
                  </div>

                  <!-- 最小文件过滤 -->
                  <div class="flex items-center gap-1.5 ml-1">
                    <span class="text-slate-500 text-[11px]" title="过滤小于此体积的文件，自动排除广告宣传短片">小文件过滤:</span>
                    <div class="inline-flex items-center gap-1">
                      <input
                        v-model.number="minFileSizeFilterMb"
                        @change="applyMinFileSizeFilter"
                        type="number"
                        min="0"
                        class="w-12 h-7 px-1 text-center font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-500"
                      />
                      <span class="text-[11px] text-slate-400">MB</span>
                    </div>
                  </div>

                  <div class="flex items-center gap-1.5 ml-auto">
                    <button
                      type="button"
                      @click="resetActiveGroupEpisodes"
                      class="btn-default text-xs h-7 px-2.5 cursor-pointer flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:text-slate-400 font-medium rounded"
                      title="重置所有分集、季号与片名微调"
                    >
                      <RotateCcw class="w-3 h-3 text-slate-400" />
                      <span>重置微调</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 模块 C: 文件与目标路径映射 (整洁专业的列表式排版) -->
            <div class="p-3.5 space-y-2.5 bg-white dark:bg-slate-900 flex-1 flex flex-col min-h-0">
              <!-- 归档目标路径预览 (精简去重，与顶栏目标库无缝衔接) -->
              <div class="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between gap-2 text-xs shrink-0">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <span class="text-slate-500 dark:text-slate-400 font-medium shrink-0 flex items-center gap-1">
                    <FolderCheck class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    完整归档路径:
                  </span>
                  <span class="font-mono text-slate-700 dark:text-slate-300 truncate font-semibold select-all" :title="targetDirectoryPreview">
                    {{ targetDirectoryPreview }}
                  </span>
                </div>
                <div class="flex items-center gap-2 shrink-0 ml-2">
                  <span v-if="activeGroup.mediaType !== 'movie' && previewOrganizedList.some(it => it.seasonNum === 0)" class="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 px-2 py-0.5 rounded">
                    特别篇存入 Season 00
                  </span>
                </div>
              </div>

              <!-- 清单工具栏与快速集号定位 -->
              <div class="flex items-center justify-between pt-1 pb-1 text-xs text-slate-500 shrink-0 gap-3">
                <div class="flex items-center gap-2 shrink-0">
                  <span class="font-bold text-slate-800 dark:text-slate-200">文件清单</span>
                  <span class="text-[11px] text-slate-400 font-mono">
                    有效入库 {{ previewOrganizedList.filter(it => !it.isExcluded).length }} / {{ previewOrganizedList.length }}
                  </span>
                </div>

                <!-- 快速定位集号或名称 -->
                <div class="flex items-center gap-1.5 flex-1 max-w-[220px]">
                  <div class="relative w-full">
                    <Search class="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      v-model="episodeSearchQuery"
                      type="text"
                      class="w-full h-6 pl-6 pr-5 text-[11px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                      placeholder="定位集号/名称 (如 88)..."
                    />
                    <button
                      v-if="episodeSearchQuery"
                      type="button"
                      @click="episodeSearchQuery = ''"
                      class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                      title="清除搜索"
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div class="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    @click="toggleSelectAllInGroup"
                    class="text-xs text-slate-500 hover:text-indigo-600 cursor-pointer"
                  >
                    {{ activeGroup.excludedFileIds.size > 0 ? '全部包含' : '全部排除' }}
                  </button>
                  <button
                    type="button"
                    @click="activeGroup.isFilesCollapsed = !activeGroup.isFilesCollapsed; saveWorkspaceDraft()"
                    class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer flex items-center gap-0.5"
                  >
                    <span>{{ activeGroup.isFilesCollapsed ? '展开' : '收起' }}</span>
                    <ChevronDown class="w-3 h-3 transition-transform" :class="{ '-rotate-180': !activeGroup.isFilesCollapsed }" />
                  </button>
                </div>
              </div>

              <!-- 集数分段快捷导航选项卡 (当总集数 > 25 且非电影时展示) -->
              <div
                v-if="!activeGroup.isFilesCollapsed && activeGroup.mediaType !== 'movie' && episodeSegments.length > 0"
                class="flex items-center gap-1.5 py-1 px-0.5 overflow-x-auto text-[11px] border-t border-slate-100 dark:border-slate-800 shrink-0"
              >
                <span class="text-slate-400 shrink-0 text-[10px] font-mono">分段:</span>
                <button
                  type="button"
                  @click="showAllEpisodes"
                  class="px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-colors shrink-0"
                  :class="episodePageSize <= 0
                    ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'"
                >
                  全部 ({{ filteredPreviewList.length }})
                </button>
                <button
                  v-for="seg in episodeSegments"
                  :key="seg.page"
                  type="button"
                  @click="selectEpisodeSegment(seg)"
                  class="px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-colors shrink-0"
                  :class="(episodePageSize > 0 && episodeCurrentPage === seg.page)
                    ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'"
                >
                  {{ seg.label }}
                </button>
              </div>

              <!-- 文件列表：平整素雅的 List 列表结构，自适应父级高度并开启顺滑内滚 -->
              <div v-show="!activeGroup.isFilesCollapsed" class="divide-y divide-slate-100 dark:divide-slate-800 border-t border-b border-slate-100 dark:border-slate-800 flex-1 min-h-0 overflow-y-auto">
                <!-- 搜索未命中空状态提示 -->
                <div v-if="displayedPreviewList.length === 0" class="py-12 text-center text-xs text-slate-400 space-y-2">
                  <Search class="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600" />
                  <p>未找到匹配 "{{ episodeSearchQuery }}" 的分集文件</p>
                  <button
                    type="button"
                    @click="episodeSearchQuery = ''"
                    class="text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    清除过滤条件
                  </button>
                </div>

                <div
                  v-for="item in displayedPreviewList"
                  :key="item.fileId"
                  class="py-2 px-1 hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors space-y-0.5"
                  :class="{ 'opacity-40': item.isExcluded }"
                >
                  <!-- 第一行：目标规范文件名 + 季集/规格 + 微调控件 -->
                  <div class="flex items-center justify-between gap-3 text-xs">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        :checked="!item.isExcluded"
                        @change="toggleExcludeFile(item.fileId)"
                        class="rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0"
                      />

                      <!-- 季集标签：剧集为清晰深蓝，电影为醒目琥珀金 -->
                      <span
                        class="shrink-0 font-mono font-bold text-xs px-1.5 py-0.5 rounded border"
                        :class="isGroupMovie(activeGroup) ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800' : 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-800'"
                      >
                        {{ isGroupMovie(activeGroup) ? '正片' : item.seasonEpisodeStr }}
                      </span>

                      <!-- 目标文件名展示与行内编辑 -->
                      <div class="min-w-0 flex-1">
                        <!-- 行内编辑模式 -->
                        <div v-if="editingFileId === item.fileId" class="flex items-center gap-1.5">
                          <input
                            v-model="editingFileNameValue"
                            @keydown.enter.prevent="saveEditFileName(item.fileId)"
                            @keydown.esc.prevent="cancelEditFileName"
                            type="text"
                            class="flex-1 h-6 px-1.5 text-xs font-mono bg-white dark:bg-slate-900 border border-indigo-500 rounded text-slate-900 dark:text-white focus:outline-none"
                            autofocus
                          />
                          <button
                            type="button"
                            @click="saveEditFileName(item.fileId)"
                            class="px-2 h-6 text-[11px] font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 cursor-pointer"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            @click="cancelEditFileName"
                            class="px-2 h-6 text-[11px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded hover:bg-slate-300 cursor-pointer"
                          >
                            取消
                          </button>
                        </div>

                        <!-- 正常展示模式 -->
                        <div v-else class="flex items-center gap-1.5 group cursor-pointer" @click="startEditFileName(item.fileId, item.newFileName)">
                          <span
                            class="font-mono text-xs truncate"
                            :class="item.isExcluded ? 'text-slate-400 line-through' : (item.isCustomName ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-800 dark:text-slate-200 font-medium')"
                            :title="item.newFileName"
                          >
                            {{ item.newFileName }}
                          </span>

                          <!-- 辅助规格角标 (素雅灰色，不杂乱) -->
                          <span v-if="item.isCustomName" class="shrink-0 px-1 py-0.2 rounded text-[10px] bg-slate-100 text-slate-500 dark:bg-slate-800">
                            微调
                          </span>
                          <span v-if="item.isSpecial || item.specialBadge" class="shrink-0 px-1 py-0.2 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800">
                            {{ item.specialBadge || '特别篇' }}
                          </span>
                          <span v-if="item.specs?.videoFormat || item.specs?.resolution" class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono text-slate-500 bg-slate-100 dark:bg-slate-800">
                            {{ item.specs?.videoFormat || item.specs?.resolution }}
                          </span>
                          <span v-if="item.specs?.isRemux || /REMUX/i.test(item.specs?.resourceType || '') || /REMUX/i.test(item.originalName)" class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40">
                            REMUX
                          </span>
                          <span v-else class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono text-slate-500 bg-slate-100 dark:bg-slate-800">
                            WEB-DL
                          </span>
                          <span v-if="item.specs?.dynamicRange && item.specs.dynamicRange !== 'SDR'" class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40">
                            {{ item.specs.dynamicRange }}
                          </span>
                          <span v-if="item.specs?.colorDepth && item.specs.colorDepth !== '8bit'" class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono text-slate-500 bg-slate-100 dark:bg-slate-800">
                            {{ item.specs.colorDepth }}
                          </span>
                          <span v-if="item.specs?.videoCodec" class="shrink-0 px-1 py-0.2 rounded text-[10px] font-mono text-slate-500 bg-slate-100 dark:bg-slate-800">
                            {{ item.specs.videoCodec }}
                          </span>

                          <!-- 洗版预检状态角标 -->
                          <span
                            v-if="item.washStatus && item.washStatus.washAction === 'upgrade'"
                            class="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60"
                            :title="item.washStatus.detail"
                          >
                            洗版置换
                          </span>
                          <span
                            v-else-if="item.washStatus && item.washStatus.washAction === 'inferior'"
                            class="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60"
                            :title="item.washStatus.detail"
                          >
                            已有更优
                          </span>
                          <span
                            v-else-if="item.washStatus && item.washStatus.washAction === 'coexist'"
                            class="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                            :title="item.washStatus.detail"
                          >
                            双版并存
                          </span>
                          <span
                            v-else-if="item.washStatus && item.washStatus.washAction === 'same'"
                            class="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-800"
                            :title="item.washStatus.detail"
                          >
                            规格相同
                          </span>

                          <Pencil class="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-600 transition-opacity shrink-0" title="点击微调" />
                        </div>
                      </div>
                    </div>

                    <!-- 右侧微调控件 (对齐 139 脚本：放宽集号输入框，彻底消除 3 位数截断) -->
                    <div class="flex items-center gap-2.5 shrink-0 text-slate-500">
                      <div v-if="activeGroup.mediaType !== 'movie'" class="flex items-center gap-1.5">
                        <select
                          :value="item.seasonNum"
                          @change="(e: any) => updateFileSeason(item.fileId, Number(e.target.value))"
                          :disabled="item.isExcluded"
                          class="h-6 px-1.5 text-xs font-mono bg-white dark:bg-slate-900 rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
                        >
                          <option v-for="s in seasonSelectOptions" :key="s" :value="s">
                            {{ s === 0 ? 'S00 (特别篇)' : `S${String(s).padStart(2, '0')}` }}
                          </option>
                        </select>

                        <div class="flex items-center gap-1">
                          <span class="text-[10px] text-slate-400 font-mono">集:</span>
                          <input
                            :value="item.episodeNum"
                            @input="(e: any) => updateFileEpisode(item.fileId, Number(e.target.value))"
                            type="number"
                            min="1"
                            max="999"
                            :disabled="item.isExcluded"
                            class="w-16 min-w-[62px] h-6 px-1 text-center font-mono text-xs font-bold bg-white dark:bg-slate-900 rounded border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>

                      <span class="text-[11px] text-slate-400 font-mono w-14 text-right">
                        {{ formatSize(item.size) }}
                      </span>

                      <button
                        type="button"
                        @click="toggleExcludeFile(item.fileId)"
                        class="text-xs transition-colors cursor-pointer px-1.5 py-0.5 rounded font-medium"
                        :class="item.isExcluded ? 'text-blue-600 hover:bg-blue-50' : 'text-slate-400 hover:text-rose-600 hover:bg-rose-50'"
                      >
                        {{ item.isExcluded ? '恢复' : '排除' }}
                      </button>
                    </div>
                  </div>

                  <!-- 第二行：原始文件源名 + 洗版决策详情 (灰色缩进淡雅展示) -->
                  <div class="pl-6 flex items-center justify-between gap-2 text-[11px] text-slate-400 font-mono">
                    <span class="truncate" :title="item.originalName">原: {{ item.originalName }}</span>
                    <span v-if="item.washStatus?.detail" class="shrink-0 text-[10px] text-slate-500 truncate" :title="item.washStatus.detail">
                      {{ item.washStatus.detail }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 分页工具栏 (当总集数 > 25 或处于搜索过滤状态时展现) -->
              <div
                v-if="!activeGroup.isFilesCollapsed && (filteredPreviewList.length > 25 || episodeSearchQuery)"
                class="flex items-center justify-between py-1.5 px-2 bg-slate-50/60 dark:bg-slate-800/30 border-b border-slate-100 dark:border-slate-800 text-xs text-slate-500 shrink-0"
              >
                <div class="flex items-center gap-1.5 text-[11px] font-mono text-slate-500">
                  <span>显示范围:</span>
                  <span class="font-bold text-slate-700 dark:text-slate-300">{{ displayedRangeLabel }}</span>
                  <span class="text-slate-400">/ 共 {{ filteredPreviewList.length }} 集</span>
                </div>

                <div class="flex items-center gap-2">
                  <!-- 每页容量选项 -->
                  <div class="flex items-center gap-1 text-[11px]">
                    <span class="text-slate-400 text-[10px]">每页:</span>
                    <button
                      type="button"
                      @click="episodePageSize = 25; episodeCurrentPage = 1"
                      class="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                      :class="episodePageSize === 25 ? 'bg-indigo-100 dark:bg-indigo-950/60 font-bold text-indigo-700 dark:text-indigo-300' : 'text-slate-400 hover:text-slate-600'"
                    >
                      25
                    </button>
                    <button
                      type="button"
                      @click="episodePageSize = 50; episodeCurrentPage = 1"
                      class="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                      :class="episodePageSize === 50 ? 'bg-indigo-100 dark:bg-indigo-950/60 font-bold text-indigo-700 dark:text-indigo-300' : 'text-slate-400 hover:text-slate-600'"
                    >
                      50
                    </button>
                    <button
                      type="button"
                      @click="showAllEpisodes"
                      class="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                      :class="episodePageSize <= 0 ? 'bg-indigo-100 dark:bg-indigo-950/60 font-bold text-indigo-700 dark:text-indigo-300' : 'text-slate-400 hover:text-slate-600'"
                    >
                      全部
                    </button>
                  </div>

                  <!-- 翻页控制 -->
                  <div v-if="episodePageSize > 0 && episodeTotalPages > 1" class="flex items-center gap-1 ml-2">
                    <button
                      type="button"
                      :disabled="episodeCurrentPage <= 1"
                      @click="selectEpisodePage(episodeCurrentPage - 1)"
                      class="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none cursor-pointer text-[11px] font-medium"
                    >
                      上一页
                    </button>
                    <span class="font-mono text-[11px] text-slate-600 dark:text-slate-300 px-1">
                      {{ episodeCurrentPage }} / {{ episodeTotalPages }}
                    </span>
                    <button
                      type="button"
                      :disabled="episodeCurrentPage >= episodeTotalPages"
                      @click="selectEpisodePage(episodeCurrentPage + 1)"
                      class="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none cursor-pointer text-[11px] font-medium"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 模块 D: 底部固化执行底栏 (克制干练) -->
            <div class="p-3 bg-slate-50/70 dark:bg-slate-800/40 border-t border-slate-200/80 dark:border-slate-800 flex flex-col gap-2.5 text-xs shrink-0">
              <!-- 实时归档进度横幅 (消除未知心理与焦虑) -->
              <div
                v-if="organizeProgress.active"
                class="p-2.5 rounded-lg border border-indigo-200 dark:border-indigo-800/80 bg-indigo-50/90 dark:bg-indigo-950/50 space-y-1.5"
              >
                <div class="flex items-center justify-between text-xs">
                  <div class="flex items-center gap-2 font-medium text-indigo-900 dark:text-indigo-200">
                    <RotateCw class="w-3.5 h-3.5 animate-spin text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span v-if="organizeProgress.mode === 'batch'">
                      正在批量归档 [{{ organizeProgress.currentGroupIndex }}/{{ organizeProgress.totalGroups }} 组]:
                      <span class="font-bold">《{{ organizeProgress.groupTitle }}》</span>
                    </span>
                    <span v-else>
                      正在归档: <span class="font-bold">《{{ organizeProgress.groupTitle }}》</span>
                    </span>
                  </div>
                  <div class="font-mono text-xs font-bold text-indigo-700 dark:text-indigo-300">
                    {{ organizeProgress.percent }}% ({{ organizeProgress.current }}/{{ organizeProgress.total }})
                  </div>
                </div>

                <!-- 进度条轨道 -->
                <div class="w-full h-2 bg-indigo-100 dark:bg-indigo-900/60 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-linear-to-r from-indigo-500 to-blue-600 rounded-full transition-all duration-300 ease-out"
                    :style="{ width: `${organizeProgress.percent}%` }"
                  ></div>
                </div>

                <!-- 当前正在处理的文件名 -->
                <div v-if="organizeProgress.currentFileName" class="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">
                  当前处理: {{ organizeProgress.currentFileName }}
                </div>
              </div>

              <!-- 操作行与开关 -->
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <label class="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer">
                    <el-switch v-model="cleanEmptySourceDirOnResolve" size="small" />
                    <span>清理空源目录</span>
                  </label>
                  <label class="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer ml-1">
                    <el-switch v-model="keepOriginalFilename" size="small" />
                    <span>保持原始文件名</span>
                  </label>
                  <span class="text-slate-400 font-mono ml-1">
                    已选 {{ previewOrganizedList.filter(it => !it.isExcluded).length }} / {{ previewOrganizedList.length }} 项 · 共 {{ formatSize(selectedFilesSize) }}
                  </span>
                </div>

                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    :disabled="batchResolvingNow || matchedGroupCount === 0"
                    @click="executeBatchResolveAllMatched"
                    class="btn-default text-xs h-8 px-3 cursor-pointer text-slate-700 dark:text-slate-300 font-medium rounded-lg disabled:opacity-40"
                    :title="`批量归档当前所有已匹配组 (共 ${matchedGroupCount} 组)`"
                  >
                    <RotateCw v-if="batchResolvingNow" class="w-3.5 h-3.5 animate-spin text-indigo-600" />
                    <span>
                      {{ batchResolvingNow && organizeProgress.mode === 'batch'
                        ? `批量归档中 [${organizeProgress.currentGroupIndex}/${organizeProgress.totalGroups}] ${organizeProgress.percent}%`
                        : `批量归档已匹配 (${matchedGroupCount})`
                      }}
                    </span>
                  </button>

                  <button
                    type="button"
                    :disabled="resolvingNow || previewOrganizedList.filter(it => !it.isExcluded).length === 0"
                    @click="executeResolveCurrentGroup"
                    class="btn-primary text-xs h-8 px-4 cursor-pointer font-medium rounded-lg shadow-2xs"
                  >
                    <RotateCw v-if="resolvingNow" class="w-4 h-4 animate-spin" />
                    <CheckCircle2 v-else class="w-4 h-4" />
                    <span>
                      {{ resolvingNow && organizeProgress.mode === 'single'
                        ? `归档中 ${organizeProgress.percent}% (${organizeProgress.current}/${organizeProgress.total})`
                        : `一键归档当前组 (${previewOrganizedList.filter(it => !it.isExcluded).length})`
                      }}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 视口 2: 洗版策略配置 (1 到 N 画质优胜劣汰与版本更迭) ================= -->
    <template v-else-if="activeMainTab === 'wash'">
      <!-- 模块 1: 覆盖策略与洗版总控 (对齐 ChannelView 视觉规范) -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <SlidersHorizontal class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">覆盖策略与洗版总控</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              优胜劣汰覆盖同名文件，劣汰旧版移入 139 回收站绝不碎粉
            </p>
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>优胜劣汰自动置换与安全机制说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>优胜劣汰自动置换</strong>：开启后，同名影视文件按照下方 8 项优先级序列逐级打分裁决；优胜版本入库，劣汰版本安全移至 139 回收站。</li>
            <li>• <strong>自定义优先级序列</strong>：可点击【上移】/【下移】定制裁决权重（如画质优先、体积优先、压制组优先）。</li>
            <li>• <strong>杜比视界豁免并存</strong>：开启后，杜比视界版本与普通 HDR/SDR 版本豁免淘汰，两者在媒体库共存。</li>
          </ul>
        </div>

        <!-- 开关组 -->
        <div class="space-y-3">
          <div class="rounded-xl border border-slate-200/80 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 p-3.5 flex items-center justify-between hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">允许洗版 (覆盖同名文件)</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                开启后，新旧文件同名时将按照清晰度、编码等条件对比，优胜劣汰自动覆盖；关闭后新文件将不进行覆盖，绝对保护现有资产
              </p>
            </div>
            <el-switch v-model="strategyConfig.autoWash" />
          </div>

          <div class="rounded-xl border border-slate-200/80 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 p-3.5 flex items-center justify-between hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">保留杜比视界多版本 (多版本策略)</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                当已存在杜比视界版本且新入库为非杜比版本时，不淘汰旧版本，两者在媒体库并存
              </p>
            </div>
            <el-switch v-model="strategyConfig.keepDolbyMultiVersion" />
          </div>
        </div>
      </div>

      <!-- 模块 2: 画质洗版优先级序列调整列表 -->
      <div class="settings-card">
        <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <Sliders class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
                {{ strategyConfig.washPriorityOrder?.length || 9 }} 项画质元数据权重裁决序列
              </h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                从高到低依次裁决，首个分出胜负的项即刻决定洗版动作
              </p>
            </div>
          </div>

          <button
            type="button"
            @click="resetWashPriorityDefault"
            class="btn-default text-xs h-8 px-3 flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 font-medium"
            title="恢复默认推荐优先级序列"
          >
            <RotateCcw class="w-3.5 h-3.5" />
            <span>恢复默认序列</span>
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-for="(key, idx) in strategyConfig.washPriorityOrder"
            :key="key"
            class="flex items-center justify-between p-3 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/70 text-xs transition-all hover:border-blue-300 dark:hover:border-blue-700/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/40 shadow-2xs"
          >
            <div class="flex items-center gap-3">
              <span
                v-if="idx === 0"
                class="w-7 h-7 rounded-lg bg-blue-600 text-white font-mono font-bold text-xs flex items-center justify-center shadow-xs border border-blue-600 shrink-0"
              >
                01
              </span>
              <span
                v-else-if="idx === 1"
                class="w-7 h-7 rounded-lg bg-sky-500 text-white font-mono font-bold text-xs flex items-center justify-center shadow-xs border border-sky-500 shrink-0"
              >
                02
              </span>
              <span
                v-else-if="idx === 2"
                class="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 font-mono font-bold text-xs flex items-center justify-center border border-indigo-200/80 dark:border-indigo-800/60 shrink-0"
              >
                03
              </span>
              <span
                v-else
                class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono font-semibold text-xs flex items-center justify-center border border-slate-200/80 dark:border-slate-700 shrink-0"
              >
                {{ String(idx + 1).padStart(2, '0') }}
              </span>
              <div>
                <div class="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <span>{{ washPriorityMeta[key]?.label || key }}</span>
                  <span
                    v-if="idx === 0"
                    class="px-1.5 py-0.2 rounded text-[10px] bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 font-medium"
                  >
                    最高裁决权重
                  </span>
                  <span
                    v-else-if="idx === 1"
                    class="px-1.5 py-0.2 rounded text-[10px] bg-sky-50 dark:bg-sky-900/40 text-sky-600 dark:text-sky-300 font-medium"
                  >
                    次级优先
                  </span>
                </div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                  {{ washPriorityMeta[key]?.desc || '' }}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="h-7 w-7 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex items-center justify-center cursor-pointer disabled:opacity-20 disabled:pointer-events-none"
                :disabled="idx === 0"
                title="上移此优先级"
                @click="moveWashPriority(idx, 'up')"
              >
                <ArrowUp class="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                class="h-7 w-7 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex items-center justify-center cursor-pointer disabled:opacity-20 disabled:pointer-events-none"
                :disabled="idx === (strategyConfig.washPriorityOrder?.length || 0) - 1"
                title="下移此优先级"
                @click="moveWashPriority(idx, 'down')"
              >
                <ArrowDown class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 模块 3: 资产安全保障与回收站防误删机制 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <ShieldCheck class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
              资产安全保障与回收站防误删机制
            </h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              139 网盘回收站软删除、逆向降级防护与脏后缀自愈
            </p>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3.5 text-xs">
          <div class="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 space-y-2 hover:shadow-xs hover:border-emerald-300 dark:hover:border-emerald-800/60 transition-all">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Trash2 class="w-4 h-4" />
              </div>
              <h4 class="font-bold text-gray-900 dark:text-white">回收站软删除保障</h4>
            </div>
            <p class="text-gray-500 dark:text-gray-400 text-[11px] leading-relaxed">
              洗版被劣汰的版本一律使用 139 移动云盘 <code class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">batchTrash</code> 移入回收站，绝不物理碎粉，可在网盘网页端随时一键还原。
            </p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 space-y-2 hover:shadow-xs hover:border-blue-300 dark:hover:border-blue-800/60 transition-all">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <ShieldCheck class="w-4 h-4" />
              </div>
              <h4 class="font-bold text-gray-900 dark:text-white">逆向降级拦截保护</h4>
            </div>
            <p class="text-gray-500 dark:text-gray-400 text-[11px] leading-relaxed">
              媒体库中如果已经存在更高画质版本（如 4K Remux），新入库的较低版本（如 1080p）会被自动拦截跳过，拒绝任何低质覆盖高质的逆向损坏。
            </p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 space-y-2 hover:shadow-xs hover:border-purple-300 dark:hover:border-purple-800/60 transition-all">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Sparkles class="w-4 h-4" />
              </div>
              <h4 class="font-bold text-gray-900 dark:text-white">历史脏后缀自愈置换</h4>
            </div>
            <p class="text-gray-500 dark:text-gray-400 text-[11px] leading-relaxed">
              针对旧版本中带有 <code class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-[10px] text-purple-700 dark:text-purple-400">- 4K</code>、<code class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-[10px] text-purple-700 dark:text-purple-400">- 2.5GB</code> 等历史消歧脏后缀的文件，新版本入库时将自动优先洗版置换，清洗媒体库纯净度。
            </p>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 视口: 洗版流水记录 (与频道监控及整理流水 100% 统一规范) ================= -->
    <template v-else-if="activeMainTab === 'wash_history'">
      <!-- 顶栏工具栏 (去冗余标题，保留搜索与状态胶囊规范) -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
        <!-- 左侧搜索与流水统计 -->
        <div class="flex items-center gap-3 flex-1 max-w-md">
          <div class="relative flex-1">
            <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              v-model="washSearchQuery"
              placeholder="搜索片名 / 文件名 / 洗版说明"
              class="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-blue-500"
            />
            <button
              v-if="washSearchQuery"
              @click="washSearchQuery = ''"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
          <span class="text-xs text-slate-400 dark:text-slate-500 font-mono shrink-0">
            共 {{ washHistoryList.length }} 条记录
            <template v-if="washSearchQuery || washActiveFilter !== 'all'">
              · 已筛选 {{ filteredWashRecords.length }} 条
            </template>
          </span>
        </div>

        <!-- 右侧状态快捷过滤胶囊与刷新按钮 -->
        <div class="flex items-center gap-2">
          <div class="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
            <button
              type="button"
              @click="washActiveFilter = 'all'"
              :class="washActiveFilter === 'all' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              全部
            </button>
            <button
              type="button"
              @click="washActiveFilter = 'upgrade'"
              :class="washActiveFilter === 'upgrade' ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              置换
            </button>
            <button
              type="button"
              @click="washActiveFilter = 'protect'"
              :class="washActiveFilter === 'protect' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              拦截
            </button>
            <button
              type="button"
              @click="washActiveFilter = 'exempt'"
              :class="washActiveFilter === 'exempt' ? 'bg-white dark:bg-slate-700 text-purple-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              豁免
            </button>
            <button
              type="button"
              @click="washActiveFilter = 'skipped'"
              :class="washActiveFilter === 'skipped' ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              淘汰
            </button>
            <button
              type="button"
              @click="washActiveFilter = 'reverted'"
              :class="washActiveFilter === 'reverted' ? 'bg-white dark:bg-slate-700 text-slate-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              class="px-3 py-1 rounded-lg transition-all cursor-pointer"
            >
              已撤销
            </button>
          </div>

          <!-- 刷新按钮 -->
          <button
            type="button"
            @click="loadHistory()"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1.5 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer font-medium"
            title="刷新洗版记录"
          >
            <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <!-- 批量操作栏 (有勾选时显示，零弹窗内联确认) -->
      <div
        v-if="washSelectedIds.size > 0"
        class="flex items-center justify-between p-3 rounded-xl bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-900/60 text-xs text-blue-900 dark:text-blue-200"
      >
        <div class="flex items-center gap-3">
          <span class="font-semibold">已选中 {{ washSelectedIds.size }} 项洗版记录</span>
          <button
            @click="toggleWashSelectAll"
            class="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            {{ washSelectedIds.size === filteredWashRecords.length ? '取消全选' : '全选当前页' }}
          </button>
        </div>

        <div class="flex items-center gap-2">
          <!-- 批量撤回确认胶囊 -->
          <div v-if="washBatchRollbackConfirm" class="flex items-center gap-1">
            <span class="text-[11px] text-blue-700 dark:text-blue-300 font-medium">确认对 {{ washSelectedIds.size }} 项执行原路撤销？</span>
            <button
              @click="handleWashBatchRollback"
              class="px-2.5 py-1 rounded bg-blue-600 text-white font-bold cursor-pointer hover:bg-blue-700"
            >
              确定撤销
            </button>
            <button
              @click="washBatchRollbackConfirm = false"
              class="px-2 py-1 rounded bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100"
            >
              取消
            </button>
          </div>
          <button
            v-else
            @click="washBatchRollbackConfirm = true"
            class="btn-default text-xs h-7 px-2.5 text-blue-700 dark:text-blue-300 cursor-pointer flex items-center gap-1 font-medium"
          >
            <Undo2 class="w-3.5 h-3.5" />
            <span>批量原路撤销</span>
          </button>

          <!-- 批量删除确认胶囊 -->
          <div v-if="washBatchDeleteConfirm" class="flex items-center gap-1">
            <span class="text-[11px] text-red-600 font-medium">确认删除 {{ washSelectedIds.size }} 条记录？</span>
            <button
              @click="handleWashBatchDelete"
              class="px-2.5 py-1 rounded bg-red-600 text-white font-bold cursor-pointer hover:bg-red-700"
            >
              确定删除
            </button>
            <button
              @click="washBatchDeleteConfirm = false"
              class="px-2 py-1 rounded bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100"
            >
              取消
            </button>
          </div>
          <button
            v-else
            @click="washBatchDeleteConfirm = true"
            class="btn-default text-xs h-7 px-2.5 text-red-600 hover:border-red-300 cursor-pointer"
          >
            <span>批量删除</span>
          </button>
        </div>
      </div>

      <!-- 洗版历史记录卡片列表 (与频道监控历史保持统一的 7 栏管道时间线规范) -->
      <div class="settings-card !p-0 overflow-hidden">
        <div v-if="loading && washHistoryList.length === 0" class="p-16 text-center text-slate-400 text-xs">
          <RotateCw class="w-7 h-7 animate-spin mx-auto mb-2 text-blue-500" />
          正在加载洗版记录...
        </div>
        <div v-else-if="filteredWashRecords.length === 0" class="p-16 text-center text-slate-400 text-xs space-y-1">
          <div class="font-medium text-slate-600 dark:text-slate-300 text-sm">暂无符合条件的洗版记录</div>
          <div class="text-[11px] text-slate-400">当媒体库触发画质洗版、劣汰置换、杜比豁免或逆向降级拦截保护时，记录将在此统一展示</div>
        </div>
        <div v-else class="p-4 space-y-2.5">
          <div
            v-for="record in filteredWashRecords"
            :key="record.id"
            class="p-3.5 md:p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs transition-all flex flex-col gap-2.5"
          >
            <!-- 第一行: 元数据与状态控制栏 (顶栏横向通栏，标题/徽章/操作) -->
            <div class="flex items-center justify-between gap-3 flex-wrap lg:flex-nowrap">
              <!-- 左侧: 勾选框 + 海报/图标 + 片名 + 分类/年份 + 官方分集标题 + 规格徽章 -->
              <div class="flex items-center gap-2.5 min-w-0 flex-1">
                <!-- 勾选框 -->
                <input
                  type="checkbox"
                  :checked="washSelectedIds.has(record.id)"
                  @change="toggleWashSelect(record.id)"
                  class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                />

                <!-- 海报微缩图或图标 (有海报显示紧凑海报 w-7 h-9.5，无海报则显示精致媒体图标 w-7 h-7，不再占位大灰框) -->
                <div
                  v-if="parseRecordDetails(record).posterUrl && !failedPosters[record.id]"
                  class="w-7 h-9.5 rounded overflow-hidden shrink-0 border border-slate-200/80 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-800 shadow-2xs group/poster relative"
                >
                  <img
                    :src="parseRecordDetails(record).posterUrl"
                    :alt="parseRecordDetails(record).cleanTitle"
                    class="w-full h-full object-cover transition-transform duration-300 group-hover/poster:scale-110"
                    loading="lazy"
                    @error="failedPosters[record.id] = true"
                  />
                </div>
                <div
                  v-else
                  class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 border border-slate-200/60 dark:border-slate-700/60"
                  :class="{
                    'text-emerald-500': parseWashAction(record).type === 'upgrade',
                    'text-amber-500': parseWashAction(record).type === 'protect',
                    'text-purple-500': parseWashAction(record).type === 'exempt',
                    'text-slate-400': parseWashAction(record).type === 'reverted'
                  }"
                >
                  <Tv v-if="parseRecordDetails(record).isTv" class="w-4 h-4" />
                  <Film v-else class="w-4 h-4" />
                </div>

                <!-- 片名、分类与标签 -->
                <div class="flex items-center gap-2 min-w-0 flex-wrap">
                  <h4
                    class="text-sm font-bold text-slate-900 dark:text-white leading-snug truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    :title="`点击复制片名: ${parseRecordDetails(record).cleanTitle}`"
                    @click="copyText(parseRecordDetails(record).cleanTitle, '片名')"
                  >
                    {{ parseRecordDetails(record).cleanTitle }}
                  </h4>

                  <span class="text-xs text-slate-400 dark:text-slate-500 font-medium shrink-0">
                    {{ parseRecordDetails(record).categoryYearLabel }}
                  </span>

                  <span
                    v-if="parseRecordDetails(record).seasonEpisode"
                    class="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60 shrink-0"
                  >
                    {{ parseRecordDetails(record).seasonEpisode }}
                  </span>

                  <span
                    v-if="parseRecordDetails(record).episodeTitle && parseRecordDetails(record).episodeTitle !== parseRecordDetails(record).seasonEpisode"
                    class="text-xs text-slate-500 dark:text-slate-400 truncate shrink-0"
                  >
                    {{ parseRecordDetails(record).episodeTitle }}
                  </span>
                </div>
              </div>

              <!-- 右侧: 时间、TMDB、云盘/体积、洗版状态标签与操作按钮 -->
              <div class="flex items-center gap-2.5 sm:gap-3 shrink-0 text-xs">
                <span class="text-slate-400 dark:text-slate-500 font-mono">
                  {{ formatTime(record.appliedAt || record.createdAt) }}
                </span>

                <a
                  v-if="record.tmdbId"
                  :href="`https://www.themoviedb.org/${parseRecordDetails(record).isTv ? 'tv' : 'movie'}/${record.tmdbId}`"
                  target="_blank"
                  class="text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-0.5 font-mono font-medium"
                  title="在 TMDB 查看"
                >
                  <span>TMDB #{{ record.tmdbId }}</span>
                  <ExternalLink class="w-2.5 h-2.5 shrink-0" />
                </a>

                <span class="text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"></span>
                  <span>{{ record.driveType === 'cloud139' || !record.driveType ? '139云盘' : record.driveType }} · {{ formatSize(record.size) }}</span>
                </span>

                <!-- 唯一高辨识度主状态勋章 -->
                <span
                  class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0 shadow-2xs"
                  :class="parseWashComparison(record).mainBadge.class"
                  :title="parseWashComparison(record).verdictSummary"
                >
                  {{ parseWashComparison(record).mainBadge.text }}
                </span>

                <!-- 单项操作按键 -->
                <div class="flex items-center gap-1 shrink-0">
                  <!-- 单项撤回 -->
                  <div v-if="singleRollbackId === record.id" class="flex items-center gap-1">
                    <span class="text-[11px] text-blue-600 font-medium">撤销?</span>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-blue-600 text-white font-medium cursor-pointer hover:bg-blue-700"
                      @click="confirmSingleRollback(record)"
                    >
                      是
                    </button>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
                      @click="singleRollbackId = null"
                    >
                      否
                    </button>
                  </div>
                  <button
                    v-else-if="record.status === 'applied' || record.status === 'fallback'"
                    type="button"
                    class="btn-default text-xs h-7 px-2 flex items-center gap-1 text-slate-600 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-400 transition-colors cursor-pointer font-medium"
                    title="原路撤销：将此文件移回原目录并恢复旧版本"
                    @click="singleRollbackId = record.id"
                  >
                    <Undo2 class="w-3.5 h-3.5" />
                    <span>原路撤回</span>
                  </button>

                  <!-- 单项删除 -->
                  <div v-if="singleDeleteId === record.id" class="flex items-center gap-1">
                    <span class="text-[11px] text-red-600 font-medium">删除?</span>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-red-600 text-white font-medium cursor-pointer hover:bg-red-700"
                      @click="confirmSingleDelete(record)"
                    >
                      是
                    </button>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
                      @click="singleDeleteId = null"
                    >
                      否
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/40 text-slate-400 hover:text-red-500 dark:text-slate-400 transition-colors cursor-pointer"
                    title="删除此记录"
                    @click="singleDeleteId = record.id"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <!-- 第二行: 洗版画质规格比对面板 (垂直上下流对比，彻底消灭左右分栏与东一块西一块) -->
            <div class="rounded-xl border border-slate-200/80 dark:border-slate-800/80 p-3 sm:p-3.5 space-y-2.5 bg-slate-50/60 dark:bg-slate-900/40">
              <!-- 源文件路径行 (纯净单行，左对齐，去除右侧漂浮胶囊) -->
              <div class="flex items-center gap-2 min-w-0 text-xs">
                <span class="text-[11px] text-slate-400 dark:text-slate-500 font-semibold shrink-0">源文件:</span>
                <span
                  class="text-slate-600 dark:text-slate-300 font-mono select-all truncate cursor-pointer hover:text-blue-600"
                  :title="'点击复制源文件路径: ' + (record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName"
                  @click="copyText((record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName, '源文件路径')"
                >
                  <span v-if="record.oldParentPath && record.oldParentPath !== '/'" class="text-slate-400 dark:text-slate-500">{{ record.oldParentPath }}/</span>{{ record.oldName }}
                </span>
                <span v-if="record.sourceText" class="text-[10px] bg-slate-200/60 dark:bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded shrink-0 max-w-[200px] truncate" :title="'来源推文: ' + record.sourceText">
                  {{ record.sourceText }}
                </span>
              </div>

              <!-- 垂直上下对比序列 (上面保留胜出，下面淘汰移出，自然顺畅) -->
              <div class="space-y-2">
                <div
                  v-for="row in parseWashComparison(record).comparisonRows"
                  :key="row.role + row.name"
                  class="p-2.5 sm:p-3 rounded-lg border transition-colors flex flex-col gap-1.5"
                  :class="row.role === 'winner'
                    ? 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200/80 dark:border-emerald-800/60'
                    : (row.role === 'coexist'
                      ? 'bg-purple-50/40 dark:bg-purple-950/20 border-purple-200/80 dark:border-purple-800/60'
                      : 'bg-white dark:bg-slate-800/60 border-slate-200/70 dark:border-slate-700/60')"
                >
                  <!-- 头部：标志 + 角色说明 + 文件大小 -->
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="px-2 py-0.5 rounded text-[11px] font-bold" :class="row.badgeClass">
                        {{ row.badgeText }}
                      </span>
                      <span
                        class="text-xs font-semibold"
                        :class="row.role === 'winner'
                          ? 'text-emerald-800 dark:text-emerald-300'
                          : (row.role === 'coexist' ? 'text-purple-800 dark:text-purple-300' : 'text-slate-600 dark:text-slate-400')"
                      >
                        {{ row.sourceLabel }}
                      </span>
                    </div>
                    <span v-if="row.sizeFormatted" class="text-xs font-mono font-medium text-slate-500 dark:text-slate-400 shrink-0">
                      {{ row.sizeFormatted }}
                    </span>
                  </div>

                  <!-- 文件名（全宽单行舒展，可点击复制） -->
                  <div
                    class="text-xs font-mono select-all break-all cursor-pointer hover:text-blue-600 transition-colors py-0.5"
                    :class="row.role === 'winner' || row.role === 'coexist'
                      ? 'font-medium text-slate-800 dark:text-slate-200'
                      : 'text-slate-500 dark:text-slate-400'"
                    :title="`点击复制文件名: ${row.name}`"
                    @click="copyText(row.name, '文件名')"
                  >
                    {{ row.name }}
                  </div>

                  <!-- 规格胶囊序列 -->
                  <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 dark:border-slate-700/50">
                    <span class="text-[10px] text-slate-400 font-medium shrink-0">
                      {{ row.role === 'winner' ? '保留规格:' : (row.role === 'coexist' ? '版本规格:' : '淘汰规格:') }}
                    </span>
                    <span
                      v-for="badge in row.badges"
                      :key="badge.key"
                      class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium flex items-center gap-0.5 shadow-2xs"
                      :class="badge.badgeClass"
                    >
                      <span>{{ badge.label }}</span>
                      <span v-if="badge.isWinner" class="text-amber-500 font-bold text-xs leading-none">[优选]</span>
                    </span>
                    <span v-if="row.badges.length === 0" class="text-[10.5px] text-slate-400">
                      未标注特殊规格
                    </span>
                  </div>
                </div>
              </div>

              <!-- 差异决胜判定栏 (单行自左向右自然阅读，彻底消除割裂) -->
              <div class="pt-2 border-t border-slate-200/70 dark:border-slate-800 flex items-center gap-2 flex-wrap text-xs">
                <div class="flex items-center gap-1 font-bold shrink-0 text-slate-700 dark:text-slate-300">
                  <Sliders class="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span>决胜裁决:</span>
                </div>
                <!-- 关键差异胜负项胶囊 -->
                <span
                  v-for="diff in parseWashComparison(record).diffItems"
                  :key="diff.key"
                  class="px-2 py-0.5 rounded text-[11px] font-semibold border flex items-center gap-1 shrink-0"
                  :class="diff.winner === 'existing'
                    ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                    : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'"
                >
                  <span>{{ diff.label }}:</span>
                  <span class="font-mono">{{ diff.detail }}</span>
                </span>
                <span v-if="parseWashComparison(record).diffItems.length === 0" class="text-[11px] text-slate-400 italic shrink-0">
                  核心画质技术规格相当
                </span>

                <!-- 仲裁说明文本紧随其后，自左向右自然阅读 -->
                <span
                  class="text-[11px] leading-relaxed font-medium"
                  :class="{
                    'text-rose-700 dark:text-rose-300': parseWashComparison(record).actionType === 'skipped',
                    'text-emerald-700 dark:text-emerald-300': parseWashComparison(record).actionType === 'upgrade',
                    'text-purple-700 dark:text-purple-300': parseWashComparison(record).actionType === 'exempt',
                    'text-blue-700 dark:text-blue-300': parseWashComparison(record).actionType === 'protect',
                    'text-slate-600 dark:text-slate-400': parseWashComparison(record).actionType === 'duplicate' || parseWashComparison(record).actionType === 'normal'
                  }"
                >
                  — {{ parseWashComparison(record).verdictSummary }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 视口: 整理流水记录 ================= -->
    <template v-else-if="activeMainTab === 'history'">
      <!-- 流水看板工具栏 -->
      <div class="settings-card flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <!-- 左侧标题与条数 -->
        <div class="flex items-center gap-3 shrink-0">
          <h3 class="text-sm font-bold text-gray-900 dark:text-white">媒体整理记录</h3>
          <span class="text-xs text-gray-400 font-mono">
            共 {{ totalHistory }} 条记录
          </span>
        </div>

        <!-- 右侧搜索、状态筛选、撤销上次与刷新按钮 -->
        <div class="flex flex-wrap items-center gap-2.5">
          <!-- 搜索框 -->
          <div class="relative w-52 sm:w-60">
            <Search class="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              v-model="searchQuery"
              @input="onSearchChange"
              @keyup.enter="handleSearch"
              placeholder="搜索片名 / 文件名 / 路径"
              class="w-full pl-8 pr-7 py-1 text-xs rounded-lg bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-indigo-500"
            />
            <button
              v-if="searchQuery"
              @click="searchQuery = ''; handleSearch()"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- 状态筛选胶囊 -->
          <div class="flex items-center p-0.5 rounded-lg bg-gray-100 dark:bg-slate-800 text-xs font-medium">
            <button
              @click="activeFilter = 'all'; currentPage = 1; loadHistory()"
              :class="activeFilter === 'all' ? 'bg-white dark:bg-indigo-600 text-gray-900 dark:text-white font-medium shadow-xs' : 'text-gray-500 dark:text-slate-400'"
              class="px-2.5 py-1 rounded transition-colors cursor-pointer"
            >
              全部
            </button>
            <button
              @click="activeFilter = 'applied'; currentPage = 1; loadHistory()"
              :class="activeFilter === 'applied' ? 'bg-white dark:bg-indigo-600 text-gray-900 dark:text-white font-medium shadow-xs' : 'text-gray-500 dark:text-slate-400'"
              class="px-2.5 py-1 rounded transition-colors cursor-pointer"
            >
              成功
            </button>
            <button
              @click="activeFilter = 'fallback'; currentPage = 1; loadHistory()"
              :class="activeFilter === 'fallback' ? 'bg-white dark:bg-indigo-600 text-gray-900 dark:text-white font-medium shadow-xs' : 'text-gray-500 dark:text-slate-400'"
              class="px-2.5 py-1 rounded transition-colors cursor-pointer"
            >
              自愈
            </button>
            <button
              @click="activeFilter = 'protected'; currentPage = 1; loadHistory()"
              :class="activeFilter === 'protected' ? 'bg-white dark:bg-indigo-600 text-gray-900 dark:text-white font-medium shadow-xs' : 'text-gray-500 dark:text-slate-400'"
              class="px-2.5 py-1 rounded transition-colors cursor-pointer"
            >
              保护
            </button>
            <button
              @click="activeFilter = 'reverted'; currentPage = 1; loadHistory()"
              :class="activeFilter === 'reverted' ? 'bg-white dark:bg-indigo-600 text-gray-900 dark:text-white font-medium shadow-xs' : 'text-gray-500 dark:text-slate-400'"
              class="px-2.5 py-1 rounded transition-colors cursor-pointer"
            >
              已撤销
            </button>
          </div>

          <!-- 撤销上次整理确认胶囊 (零弹窗规范) -->
          <div v-if="rollbackLastConfirm" class="flex items-center gap-1 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 px-2 py-0.5 rounded-lg">
            <span class="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">确认原路撤销上次整理?</span>
            <button
              type="button"
              class="px-2 py-0.5 rounded text-[11px] bg-amber-600 text-white cursor-pointer hover:bg-amber-700 font-semibold"
              @click="handleRollbackLast"
            >
              确定
            </button>
            <button
              type="button"
              class="px-2 py-0.5 rounded text-[11px] bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
              @click="rollbackLastConfirm = false"
            >
              取消
            </button>
          </div>
          <button
            v-else
            type="button"
            @click="rollbackLastConfirm = true"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 cursor-pointer font-medium"
            title="一键撤销最近一次批量整理，将文件原路移回原路径并恢复原文件名"
          >
            <Undo2 class="w-3.5 h-3.5" />
            <span>撤销上次</span>
          </button>

          <!-- 刷新按钮 (带文字说明与旋转动画) -->
          <button
            type="button"
            @click="loadHistory()"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer font-medium"
            title="刷新整理记录"
          >
            <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <!-- 批量操作栏 (有勾选时显示，零弹窗内联确认) -->
      <div
        v-if="selectedIds.size > 0"
        class="flex items-center justify-between p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/60 text-xs text-indigo-900 dark:text-indigo-200"
      >
        <div class="flex items-center gap-3">
          <span class="font-semibold">已选中 {{ selectedIds.size }} 项记录</span>
          <button
            @click="toggleSelectAll"
            class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
          >
            {{ selectedIds.size === filteredRecords.length ? '取消全选' : '全选当前页' }}
          </button>
        </div>

        <div class="flex items-center gap-2">
          <!-- 批量撤回确认胶囊 -->
          <div v-if="batchRollbackConfirm" class="flex items-center gap-1">
            <span class="text-[11px] text-amber-700 dark:text-amber-300 font-medium">确认对 {{ selectedIds.size }} 项执行原路撤销？</span>
            <button
              @click="handleBatchRollback"
              class="px-2.5 py-1 rounded bg-amber-600 text-white font-bold cursor-pointer hover:bg-amber-700"
            >
              确定撤销
            </button>
            <button
              @click="batchRollbackConfirm = false"
              class="px-2 py-1 rounded bg-gray-100 text-gray-700 cursor-pointer hover:bg-gray-200"
            >
              取消
            </button>
          </div>
          <button
            v-else
            @click="batchRollbackConfirm = true"
            class="btn-default text-xs h-7 px-2.5 text-amber-700 dark:text-amber-300 cursor-pointer flex items-center gap-1 font-medium"
          >
            <Undo2 class="w-3.5 h-3.5" />
            <span>批量原路撤销</span>
          </button>

          <!-- 批量删除确认胶囊 -->
          <div v-if="batchDeleteConfirm" class="flex items-center gap-1">
            <span class="text-[11px] text-red-600 font-medium">确认删除 {{ selectedIds.size }} 条记录？</span>
            <button
              @click="handleBatchDelete"
              class="px-2.5 py-1 rounded bg-red-600 text-white font-bold cursor-pointer hover:bg-red-700"
            >
              确定删除
            </button>
            <button
              @click="batchDeleteConfirm = false"
              class="px-2 py-1 rounded bg-gray-100 text-gray-700 cursor-pointer hover:bg-gray-200"
            >
              取消
            </button>
          </div>
          <button
            v-else
            @click="batchDeleteConfirm = true"
            class="btn-default text-xs h-7 px-2.5 text-red-600 hover:border-red-300 cursor-pointer"
          >
            <span>批量删除</span>
          </button>

          <!-- 一键清空保护记录确认胶囊 -->
          <div v-if="clearProtectedConfirm" class="flex items-center gap-1">
            <span class="text-[11px] text-amber-600 font-medium">清空全部原地保护记录？</span>
            <button
              @click="handleClearProtected"
              class="px-2.5 py-1 rounded bg-amber-600 text-white font-bold cursor-pointer hover:bg-amber-700"
            >
              确定清空
            </button>
            <button
              @click="clearProtectedConfirm = false"
              class="px-2 py-1 rounded bg-gray-100 text-gray-700 cursor-pointer hover:bg-gray-200"
            >
              取消
            </button>
          </div>
          <button
            v-else
            @click="clearProtectedConfirm = true"
            class="btn-default text-xs h-7 px-2.5 text-amber-600 hover:border-amber-300 cursor-pointer"
            title="一键清空所有历史原地保护记录，清理历史列表"
          >
            <span>清空保护记录</span>
          </button>
        </div>
      </div>

      <!-- 历史记录卡片列表 (与频道监控历史保持统一的结构化排版规范) -->
      <div class="settings-card !p-0 overflow-hidden">
        <div v-if="loading && historyRecords.length === 0" class="p-16 text-center text-slate-400 text-xs">
          <RotateCw class="w-7 h-7 animate-spin mx-auto mb-2 text-indigo-500" />
          正在加载整理记录...
        </div>
        <div v-else-if="filteredRecords.length === 0" class="p-16 text-center text-slate-400 text-xs">
          暂无符合条件的整理历史记录
        </div>
        <div v-else class="p-4 space-y-2.5">
          <div
            v-for="record in filteredRecords"
            :key="record.id"
            class="group p-3.5 sm:p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs transition-all flex flex-col gap-2.5"
          >
            <!-- 主行: 三栏流线型卡片 (左:封面与标题 / 中:路径映射 / 右:状态与操作) -->
            <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 min-w-0">
              <!-- 左栏: 勾选框 + 封面海报 + 标题/季集/分类年份 (固定基准宽度) -->
              <div class="flex items-center gap-3 shrink-0 lg:w-[280px] min-w-0">
                <input
                  type="checkbox"
                  :checked="selectedIds.has(record.id)"
                  @change="toggleSelect(record.id)"
                  class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0"
                />

                <!-- 海报缩略图 (w-10 h-14，带悬浮微光) -->
                <div
                  v-if="parseRecordDetails(record).posterUrl && !failedPosters[record.id]"
                  class="w-10 h-14 rounded-lg overflow-hidden shrink-0 border border-slate-200/80 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-800 shadow-2xs group-hover:scale-105 transition-transform"
                >
                  <img
                    :src="parseRecordDetails(record).posterUrl"
                    :alt="parseRecordDetails(record).cleanTitle"
                    class="w-full h-full object-cover"
                    loading="lazy"
                    @error="failedPosters[record.id] = true"
                  />
                </div>
                <div
                  v-else
                  class="w-10 h-14 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 border border-slate-200/60 dark:border-slate-700/60 text-slate-400"
                >
                  <Tv v-if="parseRecordDetails(record).isTv" class="w-5 h-5" />
                  <Film v-else class="w-5 h-5" />
                </div>

                <!-- 标题与次级信息 -->
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <h4
                      class="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      :title="`点击复制片名: ${parseRecordDetails(record).cleanTitle}`"
                      @click="copyText(parseRecordDetails(record).cleanTitle, '片名')"
                    >
                      {{ parseRecordDetails(record).cleanTitle }}
                    </h4>
                    <span
                      v-if="parseRecordDetails(record).seasonEpisode"
                      class="px-1.5 py-0.2 rounded text-[11px] font-mono font-bold bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60 shrink-0"
                    >
                      {{ parseRecordDetails(record).seasonEpisode }}
                    </span>
                  </div>
                  <div class="flex items-center gap-2 mt-1 text-[11px] text-slate-400 dark:text-slate-500 truncate">
                    <span>{{ parseRecordDetails(record).categoryYearLabel || (parseRecordDetails(record).isTv ? '剧集' : '电影') }}</span>
                    <a
                      v-if="record.tmdbId"
                      :href="`https://www.themoviedb.org/${parseRecordDetails(record).isTv ? 'tv' : 'movie'}/${record.tmdbId}`"
                      target="_blank"
                      class="text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-0.5 font-mono"
                      title="在 TMDB 查看"
                    >
                      <span>#{{ record.tmdbId }}</span>
                      <ExternalLink class="w-2.5 h-2.5 shrink-0" />
                    </a>
                  </div>
                </div>
              </div>

              <!-- 中栏: 双轨路径映射 (对齐图 1: ○ 来源 vs ● 目标) -->
              <div class="flex-1 min-w-0 flex flex-col justify-center gap-1.5 py-0.5 lg:px-4 border-t lg:border-t-0 lg:border-l lg:border-r border-slate-100 dark:border-slate-800/80">
                <!-- 来源轨 (空心圆 ○) -->
                <div class="flex items-center gap-2 min-w-0 text-xs text-slate-500 dark:text-slate-400">
                  <span class="w-2.5 h-2.5 rounded-full border-2 border-slate-400 shrink-0 inline-block"></span>
                  <span class="text-[10px] px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800 font-medium shrink-0">
                    {{ record.driveType === 'cloud139' || !record.driveType ? '139云盘' : record.driveType }}
                  </span>
                  <span
                    class="font-mono text-[11px] truncate select-all cursor-pointer hover:text-blue-600 transition-colors"
                    :title="(record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName"
                    @click="copyText((record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName, '源文件路径')"
                  >
                    <span v-if="record.oldParentPath && record.oldParentPath !== '/'" class="text-slate-400 dark:text-slate-500">{{ record.oldParentPath }}/</span>{{ record.oldName }}
                  </span>
                  <span v-if="record.sourceText" class="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-1 py-0.2 rounded shrink-0 max-w-[160px] truncate" :title="'来源推文: ' + record.sourceText">
                    {{ record.sourceText }}
                  </span>
                </div>

                <!-- 目标轨 (实心深蓝圆 ●) -->
                <div class="flex items-center gap-2 min-w-0 text-xs">
                  <span class="w-2.5 h-2.5 rounded-full bg-indigo-600 shrink-0 inline-block"></span>
                  <span class="text-[10px] px-1 py-0.2 rounded bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 font-medium shrink-0">
                    媒体库
                  </span>
                  <span
                    class="font-mono text-[11px] truncate select-all cursor-pointer transition-colors"
                    :class="record.status === 'applied' ? 'text-indigo-600 dark:text-indigo-400 hover:text-indigo-700' : (record.status === 'protected' ? 'text-amber-600' : 'text-slate-700 dark:text-slate-300')"
                    :title="parseRecordDetails(record).targetDisplayPath"
                    @click="copyText(parseRecordDetails(record).targetDisplayPath, '目标文件路径')"
                  >
                    {{ parseRecordDetails(record).targetDisplayPath }}
                  </span>
                </div>
              </div>

              <!-- 右栏: 状态、体积/时间与操作按钮 (对齐图 1) -->
              <div class="flex items-center justify-between lg:justify-end gap-3 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-100 dark:border-slate-800">
                <!-- 状态与体积/时间 -->
                <div class="flex flex-col items-start lg:items-end gap-0.5 text-xs">
                  <div class="flex items-center gap-1.5">
                    <span
                      class="px-2 py-0.2 rounded text-[11px] font-semibold border select-none shrink-0"
                      :class="{
                        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800': record.status === 'applied' && !isWashRecord(record),
                        'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-800': record.status === 'applied' && isWashRecord(record),
                        'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800': record.status === 'fallback',
                        'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800': record.status === 'protected',
                        'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800': record.status === 'quarantined',
                        'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700': record.status === 'reverted',
                        'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800': record.status === 'failed'
                      }"
                      :title="isWashRecord(record) ? ('洗版决胜入库: ' + parseWashComparison(record).verdictSummary) : undefined"
                    >
                      {{ (record.status === 'applied' && isWashRecord(record)) ? '洗版入库' : (record.status === 'applied' ? '成功' : (record.status === 'fallback' ? '自愈' : (record.status === 'protected' ? '保护' : (record.status === 'quarantined' ? '已隔离' : (record.status === 'reverted' ? '已撤回' : (record.status === 'failed' ? '失败' : record.status)))))) }}
                    </span>
                    <span class="text-[10px] text-slate-400 font-mono">移动</span>
                  </div>
                  <div class="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                    <span>{{ formatSize(record.size) }}</span>
                    <span>·</span>
                    <span>{{ formatTime(record.appliedAt || record.createdAt) }}</span>
                  </div>
                </div>

                <!-- 操作按钮群 -->
                <div class="flex items-center gap-1 shrink-0">
                  <!-- 重新整理按钮 (载入刮削工作台就地治理) -->
                  <button
                    type="button"
                    @click="reOrganizeFromHistory(record)"
                    class="btn-default text-xs h-7 px-2 flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 cursor-pointer font-medium"
                    title="重新整理此媒体文件 (载入刮削工作台重新选定路径或 TMDB)"
                  >
                    <RotateCw class="w-3.5 h-3.5" />
                    <span>重新整理</span>
                  </button>

                  <!-- 原路撤回确认胶囊 -->
                  <div v-if="singleRollbackId === record.id" class="flex items-center gap-1 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 px-2 py-0.5 rounded-lg">
                    <span class="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">确认原路撤回?</span>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-amber-600 text-white font-semibold cursor-pointer hover:bg-amber-700"
                      @click="confirmSingleRollback(record)"
                    >
                      确定
                    </button>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                      @click="singleRollbackId = null"
                    >
                      取消
                    </button>
                  </div>
                  <button
                    v-else-if="record.status === 'applied' || record.status === 'fallback' || record.status === 'quarantined'"
                    type="button"
                    class="btn-default text-xs h-7 px-2 flex items-center gap-1 text-slate-600 hover:text-amber-600 dark:text-slate-300 dark:hover:text-amber-400 transition-colors cursor-pointer font-medium"
                    title="原路撤回：将此文件移回原路径并恢复原始文件名"
                    @click="singleRollbackId = record.id"
                  >
                    <Undo2 class="w-3.5 h-3.5" />
                    <span>原路撤回</span>
                  </button>

                  <!-- 单项删除记录 -->
                  <div v-if="singleDeleteId === record.id" class="flex items-center gap-1 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-2 py-0.5 rounded-lg">
                    <span class="text-[11px] text-rose-700 dark:text-rose-300 font-semibold">删除记录?</span>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-rose-600 text-white font-semibold cursor-pointer hover:bg-rose-700"
                      @click="confirmSingleDelete(record)"
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded text-[11px] bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                      @click="singleDeleteId = null"
                    >
                      取消
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer"
                    title="仅删除本条记录（不移动或删除网盘文件）"
                    @click="singleDeleteId = record.id"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 分页栏 (方案 A: 支持高密度 20/50/100 自由切换) -->
        <div v-if="totalHistory > 0" class="p-3 sm:p-3.5 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-2.5 text-xs text-slate-500">
          <div class="flex items-center gap-2">
            <span>第 {{ currentPage }} 页 / 共 {{ totalPages }} 页 (共 {{ totalHistory }} 条规范记录)</span>
            <span class="text-slate-300 dark:text-slate-700">|</span>
            <div class="inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px]">
              <button
                type="button"
                v-for="size in [20, 50, 100]"
                :key="size"
                @click="pageSize = size; currentPage = 1; loadHistory()"
                :class="pageSize === size ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 font-bold shadow-2xs' : 'text-slate-500 hover:text-slate-800'"
                class="px-2 py-0.5 rounded cursor-pointer transition-colors"
              >
                {{ size }} 条/页
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              :disabled="currentPage <= 1"
              @click="currentPage--; loadHistory()"
              class="px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              上一页
            </button>
            <button
              type="button"
              :disabled="currentPage >= totalPages"
              @click="currentPage++; loadHistory()"
              class="px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 目录树选择弹窗 (FolderTreeSelector) -->
    <FolderTreeSelector
      v-model="folderPickerVisible"
      v-model:account-id="selectedAccountId"
      :accounts="accountSwitcherItems"
      :title="folderPickerType === 'staging' ? '选择源暂存目录 (必须独立中转目录)' : (folderPickerType === 'manual-source' ? '选择希望整理的文件夹' : '选择媒体库归档目标目录')"
      @select="handleFolderSelected"
    />
  </div>
</template>

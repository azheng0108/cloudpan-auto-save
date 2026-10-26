<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
import { ElMessage } from 'element-plus';
import {
  Sparkles,
  RotateCw,
  RotateCcw,
  Undo2,
  Film,
  Tv,
  CheckCircle2,
  AlertTriangle,
  Folder,
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
  CheckCircle,
  ExternalLink,
  Copy,
  FileVideo,
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

// ================= 1. 媒体整理与洗版全局策略状态 =================
const strategyConfig = ref<ChannelGlobalConfig>({
  enabled: true,
  channels: [],
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
  linkStrm: false,
  notifyOnStrm: false,
});

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

function moveWashPriority(index: number, direction: 'up' | 'down') {
  if (!strategyConfig.value.washPriorityOrder) return;
  const list = [...strategyConfig.value.washPriorityOrder];
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= list.length) return;
  const temp = list[index];
  list[index] = list[targetIndex];
  list[targetIndex] = temp;
  strategyConfig.value.washPriorityOrder = list;
}

function resetWashPriorityDefault() {
  strategyConfig.value.washPriorityOrder = [
    'releaseGroup',
    'resourceType',
    'videoFormat',
    'dynamicRange',
    'colorDepth',
    'audioCodec',
    'frameRate',
    'fileSize'
  ];
  ElMessage.success('已恢复默认洗版优先级序列');
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
    actionTitle = record.reason || '【已撤销】已通过后悔药原路恢复至原路径';
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

  const incomingSpecs = washDetails?.incomingTags || extractTechnicalSpecs(incomingName, incomingSize, `${record.oldName} ${record.oldParentPath || ''}`);
  const existingSpecs = washDetails?.existingTags || (existingName ? extractTechnicalSpecs(existingName, existingSize) : null);

  const diffItems: Array<{ key: string; label: string; winner: 'incoming' | 'existing' | 'equal'; detail: string }> = [];

  if (existingSpecs) {
    // 1. 分辨率
    if (incomingSpecs.resRank !== existingSpecs.resRank && (incomingSpecs.resRank > 0 || existingSpecs.resRank > 0)) {
      const winner = incomingSpecs.resRank > existingSpecs.resRank ? 'incoming' : 'existing';
      diffItems.push({
        key: 'res',
        label: '分辨率',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.resolution} 优于 ${existingSpecs.resolution || '常规'}`
          : `${existingSpecs.resolution} 优于 ${incomingSpecs.resolution || '常规'}`
      });
    }

    // 2. 动态范围
    if (incomingSpecs.drRank !== existingSpecs.drRank && (incomingSpecs.drRank > 0 || existingSpecs.drRank > 0)) {
      const winner = incomingSpecs.drRank > existingSpecs.drRank ? 'incoming' : 'existing';
      diffItems.push({
        key: 'dr',
        label: '动态范围',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.dynamicRange || '常规'} 优于 ${existingSpecs.dynamicRange || 'SDR'}`
          : `${existingSpecs.dynamicRange || '常规'} 优于 ${incomingSpecs.dynamicRange || 'SDR'}`
      });
    }

    // 3. 帧率
    const effectiveInFps = incomingSpecs.fpsRank || (existingSpecs.fpsRank > 2 ? 2 : 0);
    const effectiveExFps = existingSpecs.fpsRank || (incomingSpecs.fpsRank > 2 ? 2 : 0);
    if (effectiveInFps !== effectiveExFps) {
      const winner = effectiveInFps > effectiveExFps ? 'incoming' : 'existing';
      diffItems.push({
        key: 'fps',
        label: '帧率',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.frameRate} 优于 ${existingSpecs.frameRate || '25fps标准'}`
          : `${existingSpecs.frameRate} 优于 ${incomingSpecs.frameRate || '25fps标准'}`
      });
    }

    // 4. 色彩位深
    const effectiveInCd = incomingSpecs.cdRank || (existingSpecs.cdRank > 1 ? 1 : 0);
    const effectiveExCd = existingSpecs.cdRank || (incomingSpecs.cdRank > 1 ? 1 : 0);
    if (effectiveInCd !== effectiveExCd) {
      const winner = effectiveInCd > effectiveExCd ? 'incoming' : 'existing';
      diffItems.push({
        key: 'cd',
        label: '色深',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.colorDepth} 优于 ${existingSpecs.colorDepth || '8bit标准'}`
          : `${existingSpecs.colorDepth} 优于 ${incomingSpecs.colorDepth || '8bit标准'}`
      });
    }

    // 5. 介质
    if (incomingSpecs.resTypeRank !== existingSpecs.resTypeRank && (incomingSpecs.resTypeRank > 0 || existingSpecs.resTypeRank > 0)) {
      const winner = incomingSpecs.resTypeRank > existingSpecs.resTypeRank ? 'incoming' : 'existing';
      diffItems.push({
        key: 'type',
        label: '介质',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.resourceType} 优于 ${existingSpecs.resourceType || 'WEB-DL'}`
          : `${existingSpecs.resourceType} 优于 ${incomingSpecs.resourceType || 'WEB-DL'}`
      });
    }

    // 6. 音效
    if (incomingSpecs.audioRank !== existingSpecs.audioRank && Math.max(incomingSpecs.audioRank, existingSpecs.audioRank) >= 3) {
      const winner = incomingSpecs.audioRank > existingSpecs.audioRank ? 'incoming' : 'existing';
      diffItems.push({
        key: 'audio',
        label: '音效',
        winner,
        detail: winner === 'incoming'
          ? `${incomingSpecs.audioCodec} 优于 ${existingSpecs.audioCodec || 'AAC立体声'}`
          : `${existingSpecs.audioCodec} 优于 ${incomingSpecs.audioCodec || 'AAC立体声'}`
      });
    }
  }

  function buildBadges(specs: any, opposingSpecs: any, isInc: boolean) {
    if (!specs) return [];
    const badges: Array<{ key: string; label: string; isWinner: boolean; badgeClass: string }> = [];
    const opp = opposingSpecs || {};

    if (specs.resolution) {
      const isWin = isInc ? (specs.resRank > (opp.resRank || 0)) : (specs.resRank > (opp.resRank || 0));
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
      const isWin = isInc ? (specs.drRank > (opp.drRank || 0)) : (specs.drRank > (opp.drRank || 0));
      const isDv = specs.dynamicRange.includes('杜比');
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
      const isWin = specs.fpsRank > (opp.fpsRank || 0);
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
      const isWin = specs.cdRank > (opp.cdRank || 0);
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
      const isWin = specs.resTypeRank > (opp.resTypeRank || 0);
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
      const isWin = specs.audioRank > (opp.audioRank || 0);
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
    headline = '洗版淘汰 · 保护媒体库高规格版本';
    badgeClass = 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300';
    const winningDiffs = diffItems.filter(d => d.winner === 'existing');
    if (winningDiffs.length > 0) {
      verdictSummary = `媒体库已有更高规格版本（${winningDiffs.map(d => d.detail).join('、')}），进场次选版本移入回收站，避免媒体库高画质资产被降级覆盖。`;
      headerPill = {
        text: `库内胜出: ${winningDiffs.map(d => d.label).join(' · ')}`,
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
    const winningDiffs = diffItems.filter(d => d.winner === 'incoming');
    if (winningDiffs.length > 0) {
      verdictSummary = `新进场资源在画质规格上全面胜出（${winningDiffs.map(d => d.detail).join('、')}），已洗版置换入库，媒体库旧版本延后移入回收站。`;
      headerPill = {
        text: `洗版升级: ${winningDiffs.map(d => d.label).join(' · ')}`,
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

  return {
    actionType,
    headline,
    badgeClass,
    headerPill,
    verdictSummary,
    incoming: {
      name: incomingName,
      sizeFormatted: formatSize(incomingSize),
      statusBadge: actionType === 'skipped'
        ? { text: '次选淘汰 ✘', class: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200 dark:border-rose-800' }
        : (actionType === 'upgrade'
          ? { text: '画质胜出 ✔', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800' }
          : { text: '进场版本', class: 'bg-slate-100 text-slate-600 border-slate-200' }),
      badges: incomingBadges,
      specs: incomingSpecs
    },
    existing: existingName ? {
      name: existingName,
      sizeFormatted: existingSize ? formatSize(existingSize) : '',
      statusBadge: actionType === 'skipped' || actionType === 'protect'
        ? { text: '高画质留存 ★', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800' }
        : { text: '已淘汰置换 🗑️', class: 'bg-slate-100 text-slate-500 border-slate-200' },
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
  if (!selectedAccountId.value) {
    ElMessage.warning('请先在「云盘账号」页面绑定至少一个 139 移动云盘账号');
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
    ElMessage.success(`已选定待整理源目录: ${normName}`);
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
    strategyConfig.value.defaultTargetFolderId = normId || '/';
    strategyConfig.value.defaultTargetFolderName = normName || '默认媒体库 (/)';
    ElMessage.success(`已指定媒体库归档目录: ${strategyConfig.value.defaultTargetFolderName}`);
  }
  folderPickerVisible.value = false;
}

// 保存策略配置 (媒体整理配置 / 洗版配置)
async function handleSaveStrategy() {
  if (
    strategyConfig.value.stagingFolderId &&
    strategyConfig.value.defaultTargetFolderId &&
    strategyConfig.value.stagingFolderId === strategyConfig.value.defaultTargetFolderId
  ) {
    ElMessage.error('源暂存目录与目标归档目录不能相同，请重新选择！');
    return;
  }

  savingStrategy.value = true;
  try {
    const res = await channelApi.saveGlobalConfig(strategyConfig.value);
    if (res) {
      strategyConfig.value = { ...strategyConfig.value, ...res };
    }
    const tip = isWashRoute.value ? '洗版策略配置已成功保存！' : '媒体整理策略配置已成功保存！';
    ElMessage.success(tip);
  } catch (err: any) {
    ElMessage.error(`保存策略失败: ${err.message || '网络异常'}`);
  } finally {
    savingStrategy.value = false;
  }
}

// 立即触发整理 139 云盘暂存区
async function handleOrganizeNow() {
  organizingNow.value = true;
  try {
    const res = await channelApi.organizeNow({
      accountId: selectedAccountId.value || undefined,
      stagingFolderId: strategyConfig.value.stagingFolderId || undefined,
      defaultTargetFolderId: strategyConfig.value.defaultTargetFolderId || undefined,
    });
    ElMessage.success(res.message || '已成功触发 139 云盘暂存区整理归档任务！');
    // 切换到流水 Tab
    activeMainTab.value = 'history';
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
const pageSize = ref(15);
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
    if (accounts.value.length > 0) {
      const active = accounts.value.find((a: AccountItem) => a.isActive);
      selectedAccountId.value = active ? active.id : accounts.value[0].id;
    }
  } catch (err: any) {
    ElMessage.error(`加载网盘账号失败: ${err.message}`);
  }
}

async function loadStrategyConfig() {
  try {
    const res = await channelApi.getGlobalConfig();
    if (res) {
      strategyConfig.value = {
        ...strategyConfig.value,
        ...res,
        stagingFolderId: res.stagingFolderId || '',
        stagingFolderName: res.stagingFolderName || '/暂存区/频道转存',
        defaultTargetFolderId: res.defaultTargetFolderId || '/',
        defaultTargetFolderName: res.defaultTargetFolderName || '默认媒体库 (/)',
        scanInterval: res.scanInterval ?? 5,
        minFileSize: res.minFileSize ?? 50,
        linkStrm: Boolean(res.linkStrm),
        notifyOnStrm: Boolean(res.notifyOnStrm),
        washPriorityOrder: Array.isArray(res.washPriorityOrder) && res.washPriorityOrder.length ? res.washPriorityOrder : [
          'releaseGroup',
          'resourceType',
          'videoFormat',
          'dynamicRange',
          'colorDepth',
          'audioCodec',
          'frameRate',
          'fileSize'
        ],
      };
      // 同步给手工沙箱预设
      if (res.stagingFolderId) manualOrganizeConfig.value.sourceDirId = res.stagingFolderId;
      if (res.stagingFolderName) manualOrganizeConfig.value.sourceDirPath = res.stagingFolderName;
      if (res.defaultTargetFolderName) manualOrganizeConfig.value.targetDirPath = res.defaultTargetFolderName;
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
  } else if (!manualOrganizeConfig.value.sourceDirPath || manualOrganizeConfig.value.sourceDirPath === '/') {
    if (strategyConfig.value.stagingFolderName) {
      manualOrganizeConfig.value.sourceDirPath = strategyConfig.value.stagingFolderName;
      manualOrganizeConfig.value.sourceDirId = strategyConfig.value.stagingFolderId || '/';
    }
    if (strategyConfig.value.defaultTargetFolderName) {
      manualOrganizeConfig.value.targetDirPath = strategyConfig.value.defaultTargetFolderName;
    }
  }
  previewDone.value = false;
  previewTasks.value = [];
  previewGroups.value = [];
  inlineOrganizePanelOpen.value = true;
  switchTab('manual');
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
    ElMessage.warning('请先绑定并选择 139 移动云盘账号');
    return;
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
      ElMessage.success(`✓ 文件已成功恢复至原路径！`);
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
  if (path.startsWith('http')) return path;
  return `https://image.tmdb.org/t/p/w200${path.startsWith('/') ? '' : '/'}${path}`;
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
    if (epMatch && epMatch[1] && !/^(?:20\d\d|19\d\d)$/.test(epMatch[1])) {
      episodeTitle = epMatch[1].trim();
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
  } else {
    if (tab === 'history') {
      activeMainTab.value = 'history';
    } else if (tab === 'manual') {
      activeMainTab.value = 'manual';
    } else {
      activeMainTab.value = 'organize';
    }
  }
}

function switchTab(tab: 'organize' | 'manual' | 'history' | 'wash' | 'wash_history') {
  activeMainTab.value = tab;
  if (tab === 'wash' || tab === 'wash_history') {
    router.push({ path: '/wash', query: tab === 'wash_history' ? { tab: 'history' } : undefined });
  } else {
    router.push({ path: '/organize', query: (tab === 'history' || tab === 'manual') ? { tab } : undefined });
  }
}

watch(
  () => [route.path, route.query.tab],
  () => {
    syncTabFromRoute();
    if (activeMainTab.value === 'history' || activeMainTab.value === 'wash_history') {
      currentPage.value = 1;
      loadHistory();
    }
  },
  { immediate: true }
);

onMounted(async () => {
  await loadAccounts();
  await loadStrategyConfig();
  if (activeMainTab.value !== 'history' && activeMainTab.value !== 'wash_history') {
    await loadHistory();
  }
  window.addEventListener('header-save-click', onHeaderSave);
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSave);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16 text-slate-800 dark:text-slate-100">
    <!-- 顶层主视口切换：统一对齐系统标准胶囊选项卡规范 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <!-- 胶囊选项卡群组 (对齐系统 UI 规范: 媒体整理配置 / 手动双栏整理 / 整理流水记录) -->
      <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium max-w-full overflow-x-auto no-scrollbar">
        <!-- 模式 A: 洗版策略模式 (/wash) -->
        <template v-if="isWashRoute">
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
            <span>洗版流水记录</span>
            <span v-if="washHistoryList.length > 0" class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-700 dark:bg-slate-700 dark:text-blue-300 font-mono">
              {{ washHistoryList.length }}
            </span>
          </button>
        </template>

        <!-- 模式 B: 媒体整理模式 (/organize 或 /scrape) -->
        <template v-else>
          <button
            type="button"
            @click="switchTab('organize')"
            :class="activeMainTab === 'organize' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
          >
            <Clapperboard class="w-3.5 h-3.5" />
            <span>媒体整理配置</span>
          </button>

          <button
            type="button"
            @click="switchTab('manual')"
            :class="activeMainTab === 'manual' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
          >
            <Sparkles class="w-3.5 h-3.5" />
            <span>手动整理入库</span>
          </button>

          <button
            type="button"
            @click="switchTab('history')"
            :class="activeMainTab === 'history' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
            class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
          >
            <Clock class="w-3.5 h-3.5" />
            <span>整理流水记录</span>
            <span v-if="totalHistory > 0" class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-700 dark:bg-slate-700 dark:text-blue-300 font-mono">
              {{ totalHistory }}
            </span>
          </button>
        </template>
      </div>


    </div>

    <!-- ================= 视口 1: 媒体整理配置 (0 到 1 规范化归档入库) ================= -->
    <template v-if="activeMainTab === 'organize'">
      <!-- 模块 1: 两级落盘目录中枢 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Folder class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">全站统一路径中枢（两级落盘目录）</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              全系统唯一的路径配置中枢：暂存区（所有追更/监控汇总中转）与媒体库（TMDB 规范归档）
            </p>
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
          <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Info class="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>全系统路径中枢与协同机制说明</span>
          </div>
          <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
            <li>• <strong>全站唯一事实源</strong>：此处为全站唯一修改云盘路径的地方。修改后，频道监控转存、追更任务、自动定时归档、手动双栏整理及 STRM 扫描全部自动共用此配置。</li>
            <li>• <strong>源暂存目录</strong>：单链追更与 Telegram 频道监控转存的初始汇聚点。未识别影视在此暂存等待整理归档。</li>
            <li>• <strong>目标媒体库目录</strong>：经 TMDB 识别比对与结构化点分规范重命名后，最终分类归档入库的媒体库根路径。</li>
            <li>• <strong>互斥防环保护</strong>：源暂存目录与目标归档目录<strong>绝对禁止配置为同一路径</strong>，系统内嵌门禁拦截，杜绝循环归档死锁。</li>
          </ul>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <!-- 1. 源暂存区 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                源目录（待整理暂存区）
              </label>
              <span class="text-[11px] text-amber-600 dark:text-amber-400 font-medium">转存资源汇流</span>
            </div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                :value="strategyConfig.stagingFolderName || '/暂存区/频道转存'"
                type="text"
                readonly
                class="input-base font-mono text-xs flex-1 w-full cursor-default bg-slate-50 dark:bg-slate-800/50"
              />
              <button
                type="button"
                class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
                @click="openFolderPicker('staging')"
              >
                <Folder class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>选择暂存目录</span>
              </button>
            </div>
            <span class="form-text">
              待整理影视所在的源目录，整理完成后该目录内的空文件夹将被自动修剪
            </span>
          </div>

          <!-- 2. 目标媒体库 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                目标目录（媒体库归档根目录）
              </label>
              <span class="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">最终规范归档</span>
            </div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                :value="strategyConfig.defaultTargetFolderName || '默认媒体库 (/)'"
                type="text"
                readonly
                class="input-base font-mono text-xs flex-1 w-full cursor-default bg-slate-50 dark:bg-slate-800/50"
              />
              <button
                type="button"
                class="btn-default text-xs h-[38px] px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium"
                @click="openFolderPicker('target')"
              >
                <Folder class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>选择归档目录</span>
              </button>
            </div>
            <span class="form-text">
              经 TMDB 识别和结构化点分重命名后，影视最终分类归档入库的根目录
            </span>
          </div>
        </div>

        <!-- 冲突互斥报警 -->
        <div
          v-if="strategyConfig.stagingFolderId && strategyConfig.defaultTargetFolderId && strategyConfig.stagingFolderId === strategyConfig.defaultTargetFolderId"
          class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400 flex items-center gap-2"
        >
          <AlertCircle class="w-4 h-4 shrink-0" />
          <span>安全警告：源暂存目录与目标归档目录不能相同，否则会导致重复扫描与死循环归档！</span>
        </div>
      </div>

      <!-- 模块 2: 整理执行与定时调度 -->
      <div class="settings-card">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Clock class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">整理执行与暂存区巡检</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                频道转存自动即时整理入库；可手动触发立即扫描暂存区并识别归档
              </p>
            </div>
          </div>

          <button
            type="button"
            :disabled="organizingNow"
            @click="handleOrganizeNow"
            class="btn-default text-xs h-8 px-3.5 w-full sm:w-auto shrink-0 flex items-center justify-center gap-1.5 cursor-pointer font-medium text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors shadow-xs"
            title="立即扫描暂存区影视并执行识别归档"
          >
            <RotateCw class="w-3.5 h-3.5" :class="{ 'animate-spin': organizingNow }" />
            <span>{{ organizingNow ? '正在整理中...' : '立即整理 139 云盘' }}</span>
          </button>
        </div>

        <!-- 自动定时整理开关 -->
        <div class="mb-4 p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 flex items-center justify-between">
          <div>
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">暂存区自动兜底整理</h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              频道转存落盘时已自动触发即时整理；开启本开关将在后台定期巡检暂存区，自动补齐手动放入或遗留的待整理资源
            </p>
          </div>
          <el-switch v-model="strategyConfig.autoOrganize" />
        </div>

        <!-- 调度周期 -->
        <div v-if="strategyConfig.autoOrganize" class="mb-4">
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
            暂存区兜底巡检周期 (分钟，建议 15~60 分钟避免频繁空转)
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model.number="strategyConfig.scanInterval"
              type="number"
              min="1"
              max="1440"
              placeholder="30"
              class="input-base font-mono text-xs w-36"
            />
            <div class="flex items-center gap-1.5 text-xs">
              <button
                v-for="min in [10, 15, 30, 60, 120]"
                :key="min"
                type="button"
                class="px-2.5 py-1 rounded-md border text-xs font-mono cursor-pointer transition-colors"
                :class="strategyConfig.scanInterval === min ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-300'"
                @click="strategyConfig.scanInterval = min"
              >
                {{ min }}分
              </button>
            </div>
          </div>
        </div>

        <!-- 清理空文件夹 -->
        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
          <div>
            <h4 class="text-xs font-bold text-gray-900 dark:text-white">清理空文件夹</h4>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              整理完成后，自动清理暂存区中残留的空文件夹，避免云盘层级碎片化
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

      <!-- 模块 4: 整理规则与重命名 -->
      <div class="settings-card">
        <div class="flex items-center gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
            <FileCode class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">整理规则与重命名</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              小文件过滤、有声书拦截与点分规范重命名
            </p>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">小于此大小的文件将被跳过整理 (默认 50MB)</p>
          </div>

          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              忽略关键词
            </label>
            <input
              v-model="strategyConfig.ignoreKeywords"
              type="text"
              placeholder="广告, 样片, 预告, sample"
              class="input-base text-xs"
            />
            <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">包含关键词的文件将被跳过整理，支持多个关键词逗号分隔</p>
          </div>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">过滤有声书与纯音频</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                自动识别并拦截有声书、广播剧、评书、听书、相声及纯音频小说资源，仅聚焦影视媒体
              </p>
            </div>
            <el-switch v-model="strategyConfig.ignoreAudiobooks" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">TMDB 规范重命名</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                启用时按 TMDB 识别结果改为结构化点分规范命名；关闭时保留原盘文件名
              </p>
            </div>
            <el-switch v-model="strategyConfig.enableRename" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">显示官方单集标题</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                启用时在剧集文件名中注入 TMDB 官方单集小标题（如 S01E08.萧龙女李信法庭对决.2160p）；关闭时仅保留季集编号（如 S01E08.2160p）
              </p>
            </div>
            <el-switch v-model="strategyConfig.includeEpisodeTitle" />
          </div>

          <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-3.5 flex items-center justify-between">
            <div>
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">媒体信息提取完善命名</h4>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
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

    <!-- ================= 视口: 手动双栏整理 (0 物理写入实时推演与确认入库) ================= -->
    <template v-else-if="activeMainTab === 'manual'">
      <!-- 顶部引导卡片 -->
      <div class="settings-card flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-cyan-400 flex items-center justify-center shrink-0">
            <Sparkles class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
              手动整理入库
            </h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              安全预览模式：先预览影视识别与点分规范重命名效果，核对无误后再一键确认入库（零误操作风险）
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <!-- 账号状态 -->
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>生效网盘: {{ accounts.find(a => a.id === selectedAccountId)?.alias || accounts.find(a => a.id === selectedAccountId)?.username || '默认 139 网盘' }}</span>
          </span>
        </div>
      </div>

      <!-- 三步操作指引 -->
      <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div class="flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 font-bold flex items-center justify-center text-[11px]">1</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">选定待整理源目录与目标媒体库</span>
        </div>
        <ArrowRight class="w-3.5 h-3.5 text-slate-400 hidden sm:block shrink-0" />
        <div class="flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 font-bold flex items-center justify-center text-[11px]">2</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">点击「扫描并预览效果」</span>
        </div>
        <ArrowRight class="w-3.5 h-3.5 text-slate-400 hidden sm:block shrink-0" />
        <div class="flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 font-bold flex items-center justify-center text-[11px]">3</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">检查清单并点击「确认执行入库」</span>
        </div>
      </div>

      <!-- 双分栏网格 -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <!-- 左分栏：控制参数 (占 5 格) -->
        <div class="lg:col-span-5 space-y-4">
          <div class="settings-card space-y-3.5">
            <div class="flex items-center gap-2 pb-2.5 border-b border-gray-100 dark:border-gray-800">
              <SlidersHorizontal class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h4 class="text-xs font-bold text-gray-900 dark:text-white">整理参数设置</h4>
            </div>

            <!-- 待整理源目录 -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-xs font-semibold text-gray-700 dark:text-slate-300">待整理源目录</label>
                <button type="button" @click="fillDefaultStagingDir" class="text-[11px] text-amber-600 hover:text-amber-700 dark:text-amber-400 font-medium cursor-pointer transition-colors" title="快速填入配置中的默认暂存目录">⚡ 填入默认暂存区</button>
              </div>
              <div class="flex gap-2">
                <input
                  v-model="manualOrganizeConfig.sourceDirPath"
                  class="input-base text-xs font-mono flex-1 bg-slate-50 dark:bg-slate-800/50"
                  placeholder="如 /暂存区/频道转存"
                />
                <button
                  type="button"
                  @click="openFolderPicker('manual-source')"
                  class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer"
                  title="从网盘目录树选取"
                >
                  <Folder class="w-3.5 h-3.5 text-amber-500" />
                  <span>选择</span>
                </button>
              </div>
            </div>

            <!-- 媒体库目的路径 -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-xs font-semibold text-gray-700 dark:text-slate-300">媒体库目的路径</label>
                <button type="button" @click="fillDefaultTargetDir" class="text-[11px] text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium cursor-pointer transition-colors" title="快速填入配置中的默认媒体库路径">⚡ 填入默认媒体库</button>
              </div>
              <div class="flex gap-2">
                <input
                  v-model="manualOrganizeConfig.targetDirPath"
                  class="input-base text-xs font-mono flex-1 bg-slate-50 dark:bg-slate-800/50"
                  placeholder="如 /媒体库"
                />
                <button
                  type="button"
                  @click="openFolderPicker('manual-target')"
                  class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer"
                  title="从网盘目录树选取"
                >
                  <Folder class="w-3.5 h-3.5 text-indigo-500" />
                  <span>选择</span>
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-slate-300 mb-1">媒体类型</label>
                <select
                  v-model="manualOrganizeConfig.mediaType"
                  class="input-base text-xs w-full"
                >
                  <option value="auto">自动识别</option>
                  <option value="tv">电视剧</option>
                  <option value="movie">电影</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-slate-300 mb-1">数据源</label>
                <select
                  v-model="manualOrganizeConfig.dataSource"
                  class="input-base text-xs w-full"
                >
                  <option value="auto">自动 (TMDB)</option>
                  <option value="tmdb">TheMovieDb</option>
                  <option value="douban">豆瓣</option>
                </select>
              </div>
            </div>

            <!-- 未匹配季集策略 -->
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-slate-300 mb-1">未匹配季集策略</label>
              <select
                v-model="manualOrganizeConfig.unmatchedSeasonPolicy"
                class="input-base text-xs w-full"
              >
                <option value="fallbackCleanSeason">自动自愈（降级平铺到规范目录）</option>
                <option value="protectInPlace">严格保护（原地不动跳过写入）</option>
              </select>
            </div>

            <!-- 显示官方单集标题开关 -->
            <div class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-2.5 flex items-center justify-between">
              <div>
                <h4 class="text-xs font-semibold text-gray-800 dark:text-slate-200">显示官方单集标题</h4>
                <p class="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                  注入 TMDB 官方分集小标题 (S01E08.标题.2160p)
                </p>
              </div>
              <el-switch v-model="manualOrganizeConfig.includeEpisodeTitle" size="small" />
            </div>

            <!-- 清理源空文件夹开关 -->
            <div class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50 p-2.5 flex items-center justify-between">
              <div>
                <h4 class="text-xs font-semibold text-gray-800 dark:text-slate-200">清理源空文件夹</h4>
                <p class="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                  整理完成后自动删除源暂存路径下的残留空目录
                </p>
              </div>
              <el-switch v-model="manualOrganizeConfig.cleanEmptySources" size="small" />
            </div>

            <!-- 操作按钮组 -->
            <div class="pt-2 flex items-center justify-between">
              <button
                type="button"
                :disabled="scanning || previewing"
                @click="triggerPreview"
                class="btn-default text-xs h-9 px-4 flex items-center gap-1.5 cursor-pointer font-semibold text-blue-600 dark:text-cyan-300 border-blue-200 dark:border-blue-800/60"
              >
                <RotateCw v-if="scanning || previewing" class="w-3.5 h-3.5 animate-spin" />
                <Eye v-else class="w-3.5 h-3.5" />
                <span>{{ scanning ? '扫描中...' : (previewing ? '正在识别与比对...' : '扫描并预览效果') }}</span>
              </button>

              <!-- 原位执行确认胶囊 (零弹窗规范) -->
              <div v-if="executeOrganizeConfirm" class="flex items-center gap-1">
                <span class="text-[11px] text-emerald-600 font-semibold">确认执行入库?</span>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded text-[11px] bg-emerald-600 text-white font-semibold cursor-pointer hover:bg-emerald-700"
                  @click="executeOrganize"
                >
                  确认执行
                </button>
                <button
                  type="button"
                  class="px-2 py-1 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
                  @click="executeOrganizeConfirm = false"
                >
                  取消
                </button>
              </div>
              <button
                v-else
                type="button"
                :disabled="executing || (!previewDone && previewTasks.length === 0)"
                @click="executeOrganize"
                class="btn-primary text-xs h-9 px-4 flex items-center gap-1.5 cursor-pointer font-semibold shadow-xs"
              >
                <RotateCw v-if="executing" class="w-3.5 h-3.5 animate-spin" />
                <Play v-else class="w-3.5 h-3.5" />
                <span>确认执行入库</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 右分栏：推演预览看板 (占 7 格) -->
        <div class="lg:col-span-7 space-y-4">
          <div class="settings-card space-y-3">
            <div class="flex items-center justify-between pb-2.5 border-b border-gray-100 dark:border-gray-800">
              <span class="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Sparkles class="w-3.5 h-3.5 text-indigo-500" />
                <span>整理预览清单</span>
              </span>
              <div v-if="previewDone" class="flex items-center gap-1 text-[10px] font-mono font-semibold">
                <span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">总数: {{ previewSummary.total }}</span>
                <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">就绪: {{ previewSummary.ready }}</span>
                <span v-if="previewSummary.protectedCount > 0" class="px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">保护: {{ previewSummary.protectedCount }}</span>
                <span v-if="previewSummary.fallbackCount > 0" class="px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">自愈: {{ previewSummary.fallbackCount }}</span>
              </div>
            </div>

            <!-- 影视刮削主卡片 (若解析出主要影视组) -->
            <div
              v-if="primaryGroup && previewDone"
              class="p-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/50 flex items-center gap-3.5"
            >
              <div class="w-12 h-16 rounded-lg bg-slate-200 dark:bg-slate-700 shrink-0 overflow-hidden flex items-center justify-center border border-indigo-200/50 dark:border-indigo-800/50 shadow-2xs">
                <img
                  v-if="primaryGroup.posterPath"
                  :src="formatPosterUrl(primaryGroup.posterPath)"
                  :alt="primaryGroup.title"
                  class="w-full h-full object-cover"
                  loading="lazy"
                />
                <Tv v-else-if="primaryGroup.mediaType === 'tv'" class="w-5 h-5 text-indigo-400" />
                <Film v-else class="w-5 h-5 text-indigo-400" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h4 class="text-xs font-bold text-gray-900 dark:text-white truncate">
                    {{ primaryGroup.title }}
                  </h4>
                  <span
                    class="px-1.5 py-0.2 rounded text-[10px] font-semibold"
                    :class="primaryGroup.mediaType === 'tv' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'"
                  >
                    {{ primaryGroup.mediaType === 'tv' ? '电视剧' : '电影' }}
                  </span>
                  <span v-if="primaryGroup.year" class="text-[10px] text-gray-400 font-mono">({{ primaryGroup.year }})</span>
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-1">
                  {{ primaryGroup.overview || '已精准匹配 TMDB 官方影视元数据' }}
                </p>
                <div class="mt-1 flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                  <span>发现剧集项: {{ previewTasks.length }} 集</span>
                </div>
              </div>
            </div>

            <!-- 空态引导 -->
            <div v-if="!previewDone && !scanning && !previewing" class="p-16 text-center border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-xl">
              <Sparkles class="w-10 h-10 mx-auto mb-3 text-indigo-400 opacity-60 animate-bounce" />
              <h4 class="text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">尚未开始预览</h4>
              <p class="text-xs text-gray-400 max-w-sm mx-auto">
                👈 请在左侧选定待整理目录与目标媒体库，点击「扫描并预览效果」，系统将在安全预览状态下提前生成识别与重命名清单
              </p>
            </div>

            <!-- 加载态 -->
            <div v-else-if="scanning || previewing" class="p-16 text-center border border-gray-200 dark:border-gray-800 rounded-xl space-y-3">
              <RotateCw class="w-8 h-8 animate-spin mx-auto text-indigo-500" />
              <div class="space-y-1">
                <h4 class="text-xs font-bold text-gray-800 dark:text-gray-200">
                  {{ scanning ? '正在扫描 139 网盘源目录...' : '正在联机 TMDB 刮削并规范点分重命名...' }}
                </h4>
                <p class="text-[11px] text-gray-400">
                  安全预览阶段仅在内存中分析与匹配，绝对不会改动云盘中的任何文件
                </p>
              </div>
            </div>

            <!-- 比对列表 (高容量滚动视图) -->
            <div v-else class="space-y-2.5 max-h-[580px] overflow-y-auto pr-1">
              <div
                v-for="task in previewTasks"
                :key="task.fileId"
                class="p-3 rounded-xl border text-[11px] font-mono transition-all space-y-1.5"
                :class="task.status === 'ready' ? 'bg-white dark:bg-slate-900 border-gray-200/90 dark:border-slate-800 shadow-2xs' : 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'"
              >
                <!-- 原名与状态 -->
                <div class="flex items-center justify-between gap-2 text-gray-500">
                  <div class="flex items-center gap-1.5 truncate">
                    <span class="text-gray-400">原:</span>
                    <span class="truncate font-medium text-gray-600 dark:text-gray-400" :title="task.oldName">{{ task.oldName }}</span>
                  </div>
                  <span
                    class="px-2 py-0.5 rounded text-[10px] shrink-0 font-sans font-bold"
                    :class="task.status === 'ready' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/60' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/60'"
                  >
                    {{ task.status === 'ready' ? '✓ 就绪' : '⛊ 原地保护' }}
                  </span>
                </div>

                <!-- 规范新名称 -->
                <div class="flex items-center gap-1.5">
                  <span class="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">新:</span>
                  <span class="font-bold text-emerald-600 dark:text-emerald-400 truncate" :title="task.newName">
                    {{ task.newName }}
                  </span>
                </div>

                <!-- 目标路径与元数据徽章 -->
                <div class="flex items-center justify-between gap-2 pt-1 border-t border-gray-100 dark:border-gray-800/60 text-[10px]">
                  <div class="flex items-center gap-1.5 flex-wrap truncate">
                    <!-- 分集小标题标签 -->
                    <span v-if="task.episodeTitle" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-sans font-medium bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60">
                      <span class="opacity-75 font-mono mr-1">{{ task.seasonEpisode || `S${String(task.season || 1).padStart(2, '0')}E${String(task.episode || 1).padStart(2, '0')}` }}</span> {{ task.episodeTitle }}
                    </span>
                    <span v-else-if="task.seasonEpisode" class="px-1.5 py-0.5 rounded font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                      {{ task.seasonEpisode }}
                    </span>
                    <span v-if="task.targetFolderPath" class="text-slate-400 truncate" :title="task.targetFolderPath">
                      目标: {{ task.targetFolderPath }}
                    </span>
                  </div>

                  <span v-if="task.fileSize" class="text-slate-400 font-mono shrink-0">
                    {{ formatSize(task.fileSize) }}
                  </span>
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

      <!-- 模块 2: 8 项洗版优先级序列调整列表 -->
      <div class="settings-card">
        <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <Sliders class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">
                8 项画质元数据权重裁决序列
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
            title="刷新流水记录"
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

      <!-- 洗版历史流水卡片列表 (与频道监控历史保持统一的 7 栏管道时间线规范) -->
      <div class="settings-card !p-0 overflow-hidden">
        <div v-if="loading && washHistoryList.length === 0" class="p-16 text-center text-slate-400 text-xs">
          <RotateCw class="w-7 h-7 animate-spin mx-auto mb-2 text-blue-500" />
          正在加载洗版流水...
        </div>
        <div v-else-if="filteredWashRecords.length === 0" class="p-16 text-center text-slate-400 text-xs space-y-1">
          <div class="font-medium text-slate-600 dark:text-slate-300 text-sm">暂无符合条件的洗版流水记录</div>
          <div class="text-[11px] text-slate-400">当媒体库触发画质洗版、劣汰置换、杜比豁免或逆向降级拦截保护时，流水将在此统一展示</div>
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
                    v-if="parseRecordDetails(record).episodeTitle"
                    class="text-xs text-indigo-600 dark:text-indigo-400 font-medium truncate flex items-center gap-1 shrink-0"
                    :title="parseRecordDetails(record).episodeTitle"
                  >
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0"></span>
                    {{ parseRecordDetails(record).episodeTitle }}
                  </span>

                  <!-- 规格徽章 -->
                  <div v-if="parseRecordDetails(record).specs.length > 0" class="flex items-center gap-1 shrink-0">
                    <span
                      v-for="spec in parseRecordDetails(record).specs.slice(0, 4)"
                      :key="spec"
                      class="px-1.5 py-0.2 rounded text-[10.5px] font-mono font-medium"
                      :class="getSpecBadgeClass(spec)"
                    >
                      {{ spec }}
                    </span>
                  </div>

                  <!-- 决胜关键差异胶囊 -->
                  <span
                    v-if="parseWashComparison(record).headerPill"
                    class="px-2 py-0.5 rounded text-[11px] font-semibold border select-none shrink-0"
                    :class="parseWashComparison(record).headerPill?.class"
                    :title="parseWashComparison(record).verdictSummary"
                  >
                    {{ parseWashComparison(record).headerPill?.text }}
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

                <!-- 状态单行标签 (紧凑横排胶囊) -->
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0"
                  :class="parseWashAction(record).badgeClass"
                  :title="parseWashAction(record).actionTitle"
                >
                  {{ parseWashAction(record).badgeTop }} · {{ parseWashAction(record).badgeBottom }}
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

                        <!-- 第二行: 洗版画质规格比对面板 (双版本规格对比矩阵、胜负决胜项突出、防截断全宽舒展) -->
            <div class="rounded-xl border border-slate-200/80 dark:border-slate-800/80 p-3 sm:p-3.5 space-y-2.5 bg-slate-50/60 dark:bg-slate-900/40">
              <!-- 顶栏: 源文件路径与裁决结果 -->
              <div class="flex items-center justify-between gap-2 flex-wrap text-xs">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <span class="text-[11px] text-slate-400 dark:text-slate-500 font-semibold shrink-0">源文件</span>
                  <span class="text-slate-600 dark:text-slate-300 font-mono select-all truncate" :title="(record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName">
                    <span v-if="record.oldParentPath && record.oldParentPath !== '/'" class="text-slate-400 dark:text-slate-500">{{ record.oldParentPath }}/</span>{{ record.oldName }}
                  </span>
                  <span v-if="record.sourceText" class="text-[10px] bg-slate-200/60 dark:bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded shrink-0 max-w-[200px] truncate" :title="'来源推文: ' + record.sourceText">
                    {{ record.sourceText }}
                  </span>
                </div>
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0"
                  :class="parseWashComparison(record).badgeClass"
                >
                  {{ parseWashComparison(record).headline }}
                </span>
              </div>

              <!-- 核心对比网格: 左右分栏 (当有旧版比对目标时) -->
              <div v-if="parseWashComparison(record).existing" class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <!-- 左栏: 📥 进场新版本 (新监控整理) -->
                <div
                  class="p-2.5 rounded-lg border flex flex-col justify-between gap-2 transition-colors"
                  :class="parseWashComparison(record).actionType === 'upgrade'
                    ? 'bg-emerald-50/30 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-800/50'
                    : 'bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60'"
                >
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-1.5">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-slate-800 dark:text-slate-200">📥 进场新版</span>
                        <span class="text-[10.5px] px-1.5 py-0.2 rounded font-medium border" :class="parseWashComparison(record).incoming.statusBadge.class">
                          {{ parseWashComparison(record).incoming.statusBadge.text }}
                        </span>
                      </div>
                      <span class="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {{ parseWashComparison(record).incoming.sizeFormatted }}
                      </span>
                    </div>
                    <div
                      class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all leading-snug cursor-pointer hover:text-blue-600 transition-colors"
                      :title="`点击复制进场文件名: ${parseWashComparison(record).incoming.name}`"
                      @click="copyText(parseWashComparison(record).incoming.name, '进场文件名')"
                    >
                      {{ parseWashComparison(record).incoming.name }}
                    </div>
                  </div>

                  <!-- 规格胶囊序列 -->
                  <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 dark:border-slate-700/50">
                    <span class="text-[10px] text-slate-400 font-medium shrink-0">进场规格:</span>
                    <span
                      v-for="badge in parseWashComparison(record).incoming.badges"
                      :key="badge.key"
                      class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium flex items-center gap-0.5 shadow-2xs"
                      :class="badge.badgeClass"
                    >
                      <span>{{ badge.label }}</span>
                      <span v-if="badge.isWinner" class="text-amber-500 font-black text-xs leading-none">★</span>
                    </span>
                    <span v-if="parseWashComparison(record).incoming.badges.length === 0" class="text-[10.5px] text-slate-400">
                      未标注特殊规格
                    </span>
                  </div>
                </div>

                <!-- 右栏: 🏛️ 媒体库旧版本 (已有留存资产) -->
                <div
                  class="p-2.5 rounded-lg border flex flex-col justify-between gap-2 transition-colors"
                  :class="parseWashComparison(record).actionType === 'skipped' || parseWashComparison(record).actionType === 'protect'
                    ? 'bg-rose-50/30 dark:bg-rose-950/20 border-rose-200/60 dark:border-rose-800/50'
                    : 'bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60'"
                >
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-1.5">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-slate-800 dark:text-slate-200">🏛️ 媒体库旧版</span>
                        <span class="text-[10.5px] px-1.5 py-0.2 rounded font-medium border" :class="parseWashComparison(record).existing.statusBadge.class">
                          {{ parseWashComparison(record).existing.statusBadge.text }}
                        </span>
                      </div>
                      <span v-if="parseWashComparison(record).existing.sizeFormatted" class="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {{ parseWashComparison(record).existing.sizeFormatted }}
                      </span>
                    </div>
                    <div
                      class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all leading-snug cursor-pointer hover:text-blue-600 transition-colors"
                      :title="`点击复制媒体库旧版文件名: ${parseWashComparison(record).existing.name}`"
                      @click="copyText(parseWashComparison(record).existing.name, '旧版文件名')"
                    >
                      {{ parseWashComparison(record).existing.name }}
                    </div>
                  </div>

                  <!-- 规格胶囊序列 (胜出项包含 ★ 高亮) -->
                  <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 dark:border-slate-700/50">
                    <span class="text-[10px] text-slate-400 font-medium shrink-0">旧版规格:</span>
                    <span
                      v-for="badge in parseWashComparison(record).existing.badges"
                      :key="badge.key"
                      class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium flex items-center gap-0.5 shadow-2xs"
                      :class="badge.badgeClass"
                    >
                      <span>{{ badge.label }}</span>
                      <span v-if="badge.isWinner" class="text-amber-500 font-black text-xs leading-none">★</span>
                    </span>
                    <span v-if="parseWashComparison(record).existing.badges.length === 0" class="text-[10.5px] text-slate-400">
                      未标注特殊规格
                    </span>
                  </div>
                </div>
              </div>

              <!-- 单版回退展示 (极少数无对比目标记录) -->
              <div v-else class="p-2.5 rounded-lg border bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60">
                <div class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all">
                  {{ parseWashComparison(record).incoming.name }}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap pt-1.5 mt-1 border-t border-slate-100 dark:border-slate-700/50">
                  <span
                    v-for="badge in parseWashComparison(record).incoming.badges"
                    :key="badge.key"
                    class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium"
                    :class="badge.badgeClass"
                  >
                    {{ badge.label }}
                  </span>
                </div>
              </div>

              <!-- 差异决胜判定栏 (Diff Verdict Banner) -->
              <div class="pt-2 border-t border-slate-200/70 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <!-- 关键差异胜负项胶囊 -->
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-[11px] text-slate-500 dark:text-slate-400 font-semibold shrink-0">决胜关键:</span>
                  <span
                    v-for="diff in parseWashComparison(record).diffItems"
                    :key="diff.key"
                    class="px-2 py-0.5 rounded-md text-[11px] font-semibold border flex items-center gap-1"
                    :class="diff.winner === 'existing'
                      ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'"
                  >
                    <span>{{ diff.label }}:</span>
                    <span class="font-mono">{{ diff.detail }}</span>
                  </span>
                  <span v-if="parseWashComparison(record).diffItems.length === 0" class="text-[11px] text-slate-400 italic">
                    核心画质技术规格相当（同规格同名或同分辨率）
                  </span>
                </div>

                <!-- 仲裁说明文本 (全宽舒展，绝不截断) -->
                <div
                  class="text-[11px] leading-relaxed font-medium"
                  :class="{
                    'text-rose-700 dark:text-rose-300': parseWashComparison(record).actionType === 'skipped',
                    'text-emerald-700 dark:text-emerald-300': parseWashComparison(record).actionType === 'upgrade',
                    'text-purple-700 dark:text-purple-300': parseWashComparison(record).actionType === 'exempt',
                    'text-blue-700 dark:text-blue-300': parseWashComparison(record).actionType === 'protect',
                    'text-slate-600 dark:text-slate-400': parseWashComparison(record).actionType === 'duplicate' || parseWashComparison(record).actionType === 'normal'
                  }"
                >
                  {{ parseWashComparison(record).verdictSummary }}
                </div>
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
          <h3 class="text-sm font-bold text-gray-900 dark:text-white">媒体整理流水记录</h3>
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
            title="刷新流水记录"
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
            title="一键清空所有历史原地保护记录，清理流水列表"
          >
            <span>清空保护记录</span>
          </button>
        </div>
      </div>

      <!-- 历史流水卡片列表 (与频道监控历史保持统一的结构化排版规范) -->
      <div class="settings-card !p-0 overflow-hidden">
        <div v-if="loading && historyRecords.length === 0" class="p-16 text-center text-slate-400 text-xs">
          <RotateCw class="w-7 h-7 animate-spin mx-auto mb-2 text-indigo-500" />
          正在加载整理流水...
        </div>
        <div v-else-if="filteredRecords.length === 0" class="p-16 text-center text-slate-400 text-xs">
          暂无符合条件的整理历史记录
        </div>
        <div v-else class="p-4 space-y-2.5">
          <div
            v-for="record in filteredRecords"
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
                  :checked="selectedIds.has(record.id)"
                  @change="toggleSelect(record.id)"
                  class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0"
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
                    'text-emerald-500': record.status === 'applied',
                    'text-cyan-500': record.status === 'fallback',
                    'text-amber-500': record.status === 'protected',
                    'text-slate-400': record.status === 'reverted'
                  }"
                >
                  <Tv v-if="parseRecordDetails(record).isTv" class="w-4 h-4" />
                  <Film v-else class="w-4 h-4" />
                </div>

                <!-- 片名、分类与标签 -->
                <div class="flex items-center gap-2 min-w-0 flex-wrap">
                  <h4
                    class="text-sm font-bold text-slate-900 dark:text-white leading-snug truncate cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                    :title="`点击复制片名: ${parseRecordDetails(record).cleanTitle}`"
                    @click="copyText(parseRecordDetails(record).cleanTitle, '片名')"
                  >
                    {{ parseRecordDetails(record).cleanTitle }}
                  </h4>

                  <span class="text-xs text-slate-400 dark:text-slate-500 font-medium shrink-0">
                    {{ parseRecordDetails(record).categoryYearLabel }}
                  </span>

                  <span
                    v-if="parseRecordDetails(record).episodeTitle"
                    class="text-xs text-indigo-600 dark:text-indigo-400 font-medium truncate flex items-center gap-1 shrink-0"
                    :title="parseRecordDetails(record).episodeTitle"
                  >
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0"></span>
                    {{ parseRecordDetails(record).episodeTitle }}
                  </span>

                  <!-- 规格徽章 -->
                  <div v-if="parseRecordDetails(record).specs.length > 0" class="flex items-center gap-1 shrink-0">
                    <span
                      v-for="spec in parseRecordDetails(record).specs.slice(0, 4)"
                      :key="spec"
                      class="px-1.5 py-0.2 rounded text-[10.5px] font-mono font-medium"
                      :class="getSpecBadgeClass(spec)"
                    >
                      {{ spec }}
                    </span>
                  </div>

                  <!-- 决胜关键差异胶囊 (若是洗版记录) -->
                  <span
                    v-if="isWashRecord(record) && parseWashComparison(record).headerPill"
                    class="px-2 py-0.5 rounded text-[11px] font-semibold border select-none shrink-0"
                    :class="parseWashComparison(record).headerPill?.class"
                    :title="parseWashComparison(record).verdictSummary"
                  >
                    {{ parseWashComparison(record).headerPill?.text }}
                  </span>
                </div>
              </div>

              <!-- 右侧: 时间、TMDB、云盘/体积、状态标签与操作按钮 -->
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

                <!-- 状态单行标签 (紧凑横排胶囊) -->
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0"
                  :class="{
                    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800': record.status === 'applied',
                    'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800': record.status === 'fallback',
                    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800': record.status === 'protected',
                    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800': record.status === 'skipped',
                    'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700': record.status === 'reverted',
                    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800': record.status === 'failed'
                  }"
                >
                  {{ record.status === 'applied' ? '归档成功' : (record.status === 'fallback' ? '缺季自愈' : (record.status === 'protected' ? '原地保护' : (record.status === 'skipped' ? '洗版淘汰' : (record.status === 'reverted' ? '已撤销' : (record.status === 'failed' ? '执行失败' : record.status))))) }}
                </span>

                <!-- 单项操作按键 -->
                <div class="flex items-center gap-1 shrink-0">
                  <!-- 单项原路撤回 -->
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
                    v-else-if="record.status === 'applied' || record.status === 'fallback'"
                    type="button"
                    class="btn-default text-xs h-7 px-2 flex items-center gap-1 text-slate-600 hover:text-amber-600 dark:text-slate-300 dark:hover:text-amber-400 transition-colors cursor-pointer font-medium"
                    title="原路撤销：将此文件移回暂存区并恢复原始文件名"
                    @click="singleRollbackId = record.id"
                  >
                    <Undo2 class="w-3.5 h-3.5" />
                    <span>原路撤回</span>
                  </button>

                  <!-- 单项删除流水记录 -->
                  <div v-if="singleDeleteId === record.id" class="flex items-center gap-1 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-2 py-0.5 rounded-lg">
                    <span class="text-[11px] text-rose-700 dark:text-rose-300 font-semibold">删除流水记录?</span>
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
                    title="仅删除本条流水记录（不移动或删除网盘文件）"
                    @click="singleDeleteId = record.id"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

                        <!-- 第二行: 若是洗版相关记录，渲染洗版规格比对面板；否则渲染标准入库流水管线 -->
            <template v-if="isWashRecord(record)">
            <!-- 第二行: 洗版画质规格比对面板 (双版本规格对比矩阵、胜负决胜项突出、防截断全宽舒展) -->
            <div class="rounded-xl border border-slate-200/80 dark:border-slate-800/80 p-3 sm:p-3.5 space-y-2.5 bg-slate-50/60 dark:bg-slate-900/40">
              <!-- 顶栏: 源文件路径与裁决结果 -->
              <div class="flex items-center justify-between gap-2 flex-wrap text-xs">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <span class="text-[11px] text-slate-400 dark:text-slate-500 font-semibold shrink-0">源文件</span>
                  <span class="text-slate-600 dark:text-slate-300 font-mono select-all truncate" :title="(record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName">
                    <span v-if="record.oldParentPath && record.oldParentPath !== '/'" class="text-slate-400 dark:text-slate-500">{{ record.oldParentPath }}/</span>{{ record.oldName }}
                  </span>
                  <span v-if="record.sourceText" class="text-[10px] bg-slate-200/60 dark:bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded shrink-0 max-w-[200px] truncate" :title="'来源推文: ' + record.sourceText">
                    {{ record.sourceText }}
                  </span>
                </div>
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold border select-none shrink-0"
                  :class="parseWashComparison(record).badgeClass"
                >
                  {{ parseWashComparison(record).headline }}
                </span>
              </div>

              <!-- 核心对比网格: 左右分栏 (当有旧版比对目标时) -->
              <div v-if="parseWashComparison(record).existing" class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <!-- 左栏: 📥 进场新版本 (新监控整理) -->
                <div
                  class="p-2.5 rounded-lg border flex flex-col justify-between gap-2 transition-colors"
                  :class="parseWashComparison(record).actionType === 'upgrade'
                    ? 'bg-emerald-50/30 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-800/50'
                    : 'bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60'"
                >
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-1.5">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-slate-800 dark:text-slate-200">📥 进场新版</span>
                        <span class="text-[10.5px] px-1.5 py-0.2 rounded font-medium border" :class="parseWashComparison(record).incoming.statusBadge.class">
                          {{ parseWashComparison(record).incoming.statusBadge.text }}
                        </span>
                      </div>
                      <span class="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {{ parseWashComparison(record).incoming.sizeFormatted }}
                      </span>
                    </div>
                    <div
                      class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all leading-snug cursor-pointer hover:text-blue-600 transition-colors"
                      :title="`点击复制进场文件名: ${parseWashComparison(record).incoming.name}`"
                      @click="copyText(parseWashComparison(record).incoming.name, '进场文件名')"
                    >
                      {{ parseWashComparison(record).incoming.name }}
                    </div>
                  </div>

                  <!-- 规格胶囊序列 -->
                  <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 dark:border-slate-700/50">
                    <span class="text-[10px] text-slate-400 font-medium shrink-0">进场规格:</span>
                    <span
                      v-for="badge in parseWashComparison(record).incoming.badges"
                      :key="badge.key"
                      class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium flex items-center gap-0.5 shadow-2xs"
                      :class="badge.badgeClass"
                    >
                      <span>{{ badge.label }}</span>
                      <span v-if="badge.isWinner" class="text-amber-500 font-black text-xs leading-none">★</span>
                    </span>
                    <span v-if="parseWashComparison(record).incoming.badges.length === 0" class="text-[10.5px] text-slate-400">
                      未标注特殊规格
                    </span>
                  </div>
                </div>

                <!-- 右栏: 🏛️ 媒体库旧版本 (已有留存资产) -->
                <div
                  class="p-2.5 rounded-lg border flex flex-col justify-between gap-2 transition-colors"
                  :class="parseWashComparison(record).actionType === 'skipped' || parseWashComparison(record).actionType === 'protect'
                    ? 'bg-rose-50/30 dark:bg-rose-950/20 border-rose-200/60 dark:border-rose-800/50'
                    : 'bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60'"
                >
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-1.5">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-slate-800 dark:text-slate-200">🏛️ 媒体库旧版</span>
                        <span class="text-[10.5px] px-1.5 py-0.2 rounded font-medium border" :class="parseWashComparison(record).existing.statusBadge.class">
                          {{ parseWashComparison(record).existing.statusBadge.text }}
                        </span>
                      </div>
                      <span v-if="parseWashComparison(record).existing.sizeFormatted" class="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {{ parseWashComparison(record).existing.sizeFormatted }}
                      </span>
                    </div>
                    <div
                      class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all leading-snug cursor-pointer hover:text-blue-600 transition-colors"
                      :title="`点击复制媒体库旧版文件名: ${parseWashComparison(record).existing.name}`"
                      @click="copyText(parseWashComparison(record).existing.name, '旧版文件名')"
                    >
                      {{ parseWashComparison(record).existing.name }}
                    </div>
                  </div>

                  <!-- 规格胶囊序列 (胜出项包含 ★ 高亮) -->
                  <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 dark:border-slate-700/50">
                    <span class="text-[10px] text-slate-400 font-medium shrink-0">旧版规格:</span>
                    <span
                      v-for="badge in parseWashComparison(record).existing.badges"
                      :key="badge.key"
                      class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium flex items-center gap-0.5 shadow-2xs"
                      :class="badge.badgeClass"
                    >
                      <span>{{ badge.label }}</span>
                      <span v-if="badge.isWinner" class="text-amber-500 font-black text-xs leading-none">★</span>
                    </span>
                    <span v-if="parseWashComparison(record).existing.badges.length === 0" class="text-[10.5px] text-slate-400">
                      未标注特殊规格
                    </span>
                  </div>
                </div>
              </div>

              <!-- 单版回退展示 (极少数无对比目标记录) -->
              <div v-else class="p-2.5 rounded-lg border bg-white dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60">
                <div class="text-xs font-mono text-slate-700 dark:text-slate-300 break-all select-all">
                  {{ parseWashComparison(record).incoming.name }}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap pt-1.5 mt-1 border-t border-slate-100 dark:border-slate-700/50">
                  <span
                    v-for="badge in parseWashComparison(record).incoming.badges"
                    :key="badge.key"
                    class="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium"
                    :class="badge.badgeClass"
                  >
                    {{ badge.label }}
                  </span>
                </div>
              </div>

              <!-- 差异决胜判定栏 (Diff Verdict Banner) -->
              <div class="pt-2 border-t border-slate-200/70 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <!-- 关键差异胜负项胶囊 -->
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-[11px] text-slate-500 dark:text-slate-400 font-semibold shrink-0">决胜关键:</span>
                  <span
                    v-for="diff in parseWashComparison(record).diffItems"
                    :key="diff.key"
                    class="px-2 py-0.5 rounded-md text-[11px] font-semibold border flex items-center gap-1"
                    :class="diff.winner === 'existing'
                      ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'"
                  >
                    <span>{{ diff.label }}:</span>
                    <span class="font-mono">{{ diff.detail }}</span>
                  </span>
                  <span v-if="parseWashComparison(record).diffItems.length === 0" class="text-[11px] text-slate-400 italic">
                    核心画质技术规格相当（同规格同名或同分辨率）
                  </span>
                </div>

                <!-- 仲裁说明文本 (全宽舒展，绝不截断) -->
                <div
                  class="text-[11px] leading-relaxed font-medium"
                  :class="{
                    'text-rose-700 dark:text-rose-300': parseWashComparison(record).actionType === 'skipped',
                    'text-emerald-700 dark:text-emerald-300': parseWashComparison(record).actionType === 'upgrade',
                    'text-purple-700 dark:text-purple-300': parseWashComparison(record).actionType === 'exempt',
                    'text-blue-700 dark:text-blue-300': parseWashComparison(record).actionType === 'protect',
                    'text-slate-600 dark:text-slate-400': parseWashComparison(record).actionType === 'duplicate' || parseWashComparison(record).actionType === 'normal'
                  }"
                >
                  {{ parseWashComparison(record).verdictSummary }}
                </div>
              </div>
            </div>
            </template>
            <template v-else>
            <div class="bg-slate-50/70 dark:bg-slate-800/40 rounded-lg px-3 py-2 border border-slate-100 dark:border-slate-800/80 flex items-stretch gap-2.5">
              <!-- 贯穿线节点 -->
              <div class="flex flex-col items-center justify-between py-0.5 shrink-0">
                <span class="w-2 h-2 rounded-full border-2 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"></span>
                <span class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-0.5"></span>
                <span
                  class="w-2 h-2 rounded-full shrink-0"
                  :class="{
                    'bg-emerald-500': record.status === 'applied',
                    'bg-cyan-500': record.status === 'fallback',
                    'bg-amber-400': record.status === 'protected',
                    'bg-slate-400': record.status === 'reverted'
                  }"
                ></span>
              </div>

              <!-- 双行全宽路径 -->
              <div class="flex-1 min-w-0 flex flex-col justify-between gap-1 text-xs">
                <!-- 行 1: 原始源文件名 -->
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-[11px] text-slate-400 font-medium shrink-0">源文件</span>
                  <span class="text-slate-600 dark:text-slate-300 font-mono select-all truncate hover:text-clip" :title="(record.oldParentPath && record.oldParentPath !== '/' ? record.oldParentPath + '/' : '') + record.oldName">
                    <span v-if="record.oldParentPath && record.oldParentPath !== '/'" class="text-slate-400 dark:text-slate-500">{{ record.oldParentPath }}/</span>{{ record.oldName }}
                  </span>
                  <span v-if="record.sourceText" class="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded shrink-0 max-w-[220px] truncate" :title="'来源推文: ' + record.sourceText">
                    {{ record.sourceText }}
                  </span>
                </div>

                <!-- 行 2: 入库规范目标路径 / 保护说明 / 淘汰说明 / 撤销说明 -->
                <div class="flex items-center gap-2 min-w-0">
                  <span
                    class="text-[11px] font-medium shrink-0"
                    :class="{
                      'text-emerald-600 dark:text-emerald-400': record.status === 'applied',
                      'text-cyan-600 dark:text-cyan-400': record.status === 'fallback',
                      'text-amber-600 dark:text-amber-400': record.status === 'protected',
                      'text-rose-600 dark:text-rose-400': record.status === 'skipped',
                      'text-slate-500 dark:text-slate-400': record.status === 'reverted',
                      'text-red-600 dark:text-red-400': record.status === 'failed'
                    }"
                  >
                    {{ record.status === 'applied' ? '入库目标' : (record.status === 'fallback' ? '自愈目标' : (record.status === 'protected' ? '保护说明' : (record.status === 'skipped' ? '淘汰说明' : (record.status === 'reverted' ? '撤销说明' : (record.status === 'failed' ? '失败原因' : '状态说明'))))) }}
                  </span>
                  <span
                    class="font-mono select-all truncate hover:text-clip"
                    :class="{
                      'text-emerald-700 dark:text-emerald-300': record.status === 'applied',
                      'text-cyan-700 dark:text-cyan-300': record.status === 'fallback',
                      'text-amber-700 dark:text-amber-400': record.status === 'protected',
                      'text-rose-700 dark:text-rose-400': record.status === 'skipped',
                      'text-slate-500 dark:text-slate-400': record.status === 'reverted',
                      'text-red-700 dark:text-red-400': record.status === 'failed'
                    }"
                    :title="parseRecordDetails(record).targetDisplayPath"
                  >
                    {{ parseRecordDetails(record).targetDisplayPath }}
                  </span>
                </div>
              </div>
            </div>
            </template>
          </div>
        </div>

        <!-- 分页栏 -->
        <div v-if="totalHistory > pageSize" class="p-3.5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-xs text-gray-500">
          <div>第 {{ currentPage }} 页 / 共 {{ totalPages }} 页</div>
          <div class="flex gap-2">
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
      :account-id="selectedAccountId"
      :title="folderPickerType === 'staging' ? '选择源暂存目录 (必须独立中转目录)' : (folderPickerType === 'manual-source' ? '选择待整理源目录' : '选择媒体库归档目标目录')"
      @select="handleFolderSelected"
    />
  </div>
</template>

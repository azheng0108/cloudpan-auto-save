<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useLogStore } from '../stores/log';
import { systemApi, type SystemHealthData } from '../api/system';
import { ElMessage } from 'element-plus';
import {
  Activity,
  Tag,
  Clock,
  Database,
  RefreshCw,
  Terminal,
  Pause,
  Play,
  Download,
  Copy,
  Trash2,
  ArrowDown,
  Search,
} from 'lucide-vue-next';

const logStore = useLogStore();

// ================= 系统健康状态 =================
const healthLoading = ref(false);
const healthData = ref<SystemHealthData | null>(null);

async function fetchSystemStatus() {
  healthLoading.value = true;
  try {
    const healthRes = await systemApi.getHealth();
    if (healthRes) {
      healthData.value = healthRes;
    }
  } catch (err: any) {
    ElMessage.error(`获取系统状态失败: ${err.message || '未知错误'}`);
  } finally {
    healthLoading.value = false;
  }
}

// 格式化持续运行时间
const formattedUptime = computed(() => {
  if (!healthData.value?.uptimeSeconds) return '刚刚启动';
  const sec = Math.floor(healthData.value.uptimeSeconds);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);
  return parts.join(' ');
});

// ================= 日志过滤与检索体系 =================
type TagType = 'ALL' | 'ERROR' | 'WARN' | 'DEBUG' | 'CHANNEL' | 'SCRAPE' | 'WAL' | '139';
const activeTag = ref<TagType>('ALL');
const searchKeyword = ref('');
const logsContainerRef = ref<HTMLDivElement | null>(null);

const tagOptions: { key: TagType; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'ERROR', label: '错误 (ERROR)' },
  { key: 'WARN', label: '警告 (WARN)' },
  { key: 'DEBUG', label: '调试 (DEBUG)' },
  { key: 'CHANNEL', label: '频道监控' },
  { key: 'SCRAPE', label: 'TMDB整理' },
  { key: 'WAL', label: 'WAL洗版' },
  { key: '139', label: '139 网盘' },
];

function matchesFilter(line: string): boolean {
  if (!line) return false;
  const str = String(line);

  // 1. 分词胶囊过滤
  if (activeTag.value === 'ERROR') {
    if (!/error|err|failed|失败|异常/i.test(str)) return false;
  } else if (activeTag.value === 'WARN') {
    if (!/warn|warning|警告/i.test(str)) return false;
  } else if (activeTag.value === 'DEBUG') {
    if (!/debug|调试/i.test(str)) return false;
  } else if (activeTag.value === 'CHANNEL') {
    if (!/频道|channel|推文|telegram|tg/i.test(str)) return false;
  } else if (activeTag.value === 'SCRAPE') {
    if (!/媒体刮削|刮削|云盘整理|整理|归档|scrape|tmdb/i.test(str)) return false;
  } else if (activeTag.value === 'WAL') {
    if (!/wal|洗版|journal|置换|淘汰|重命名|撤回|去重/i.test(str)) return false;
  } else if (activeTag.value === '139') {
    if (!/139|cloud139|转存|网盘|云盘/i.test(str)) return false;
  }

  // 2. 关键词模糊检索
  if (searchKeyword.value.trim()) {
    if (!str.toLowerCase().includes(searchKeyword.value.trim().toLowerCase())) {
      return false;
    }
  }

  return true;
}

const filteredLogs = computed(() => {
  return logStore.logLines.filter(matchesFilter);
});

// 结构化日志行
interface ParsedLogItem {
  time: string;
  tag: string;
  tagClass: string;
  level: string;
  levelClass: string;
  message: string;
  messageClass: string;
}

function parseLogItem(line: string): ParsedLogItem {
  let time = '';
  let rest = line;

  // 1. 匹配开头的方括号时间戳 [2026/10/11 15:17:46]
  const timeMatch = rest.match(/^\[?(\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\]?\s*/);
  if (timeMatch) {
    const fullTime = timeMatch[1];
    time = fullTime.includes(' ') ? fullTime.split(' ')[1] : fullTime;
    rest = rest.slice(timeMatch[0].length).trim();
  }

  // 2. 提取显式日志等级前缀 [DEBUG] / [WARN] / [ERROR] / [INFO]
  let level = '';
  let levelClass = '';
  const levelPrefixMatch = rest.match(/^\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]\s*/i);
  if (levelPrefixMatch) {
    const matchedLevel = levelPrefixMatch[1].toUpperCase();
    if (matchedLevel === 'DEBUG') {
      level = 'DEBUG';
      levelClass = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-300 dark:border-slate-700';
    } else if (matchedLevel === 'WARN' || matchedLevel === 'WARNING') {
      level = 'WARN';
      levelClass = 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800';
    } else if (matchedLevel === 'ERROR' || matchedLevel === 'FATAL') {
      level = 'FAIL';
      levelClass = 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800';
    }
    rest = rest.slice(levelPrefixMatch[0].length).trim();
  }

  // 3. 匹配业务模块标签 [链接自愈], [检查点], [PanSou], [TMDB整理], etc.
  let tag = '';
  let tagClass = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
  const tagMatch = rest.match(/^\[([^\]]+)\]\s*/);
  if (tagMatch) {
    tag = tagMatch[1];
    rest = rest.slice(tagMatch[0].length).trim();

    if (/自愈|修复/i.test(tag)) {
      tagClass = 'bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300 border-blue-200 dark:border-blue-800';
    } else if (/检查点|断点/i.test(tag)) {
      tagClass = 'bg-violet-50 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300 border-violet-200 dark:border-violet-800';
    } else if (/pansou|盘搜/i.test(tag)) {
      tagClass = 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800';
    } else if (/定时/i.test(tag)) {
      tagClass = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
    } else if (/去重|wal|洗版/i.test(tag)) {
      tagClass = 'bg-amber-50 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300 border-amber-200 dark:border-amber-800';
    } else if (/刮削|tmdb|媒体|整理|归档/i.test(tag)) {
      tagClass = 'bg-purple-50 text-purple-700 dark:bg-purple-950/70 dark:text-purple-300 border-purple-200 dark:border-purple-800';
    } else if (/频道|telegram/i.test(tag)) {
      tagClass = 'bg-sky-50 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300 border-sky-200 dark:border-sky-800';
    } else if (/139|转存|网盘|云盘/i.test(tag)) {
      tagClass = 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/70 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800';
    }
  }

  // 4. 判断状态指示与正文高亮（如未在前序匹配到显式 level）
  let messageClass = 'text-gray-800 dark:text-gray-100';

  if (!level) {
    if (/error|err|failed|失败|异常/i.test(line)) {
      level = 'FAIL';
      levelClass = 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800';
    } else if (/warn|warning|警告/i.test(line)) {
      level = 'WARN';
      levelClass = 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800';
    } else if (/debug|调试/i.test(line)) {
      level = 'DEBUG';
      levelClass = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-300 dark:border-slate-700';
    } else if (/成功|优选|完成/i.test(line)) {
      level = 'OK';
      levelClass = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
    }
  }

  if (level === 'FAIL') {
    messageClass = 'text-rose-600 dark:text-rose-400 font-semibold';
  } else if (level === 'WARN') {
    messageClass = 'text-amber-700 dark:text-amber-400 font-medium';
  } else if (level === 'DEBUG') {
    messageClass = 'text-slate-600 dark:text-slate-300 font-mono text-xs';
  } else if (level === 'OK') {
    messageClass = 'text-emerald-700 dark:text-emerald-400';
  }

  return {
    time: time || '--:--:--',
    tag,
    tagClass,
    level,
    levelClass,
    message: rest || line,
    messageClass,
  };
}

const parsedFilteredLogs = computed(() => {
  return filteredLogs.value.map(parseLogItem);
});

// 自动滚动控制
function scrollToBottom() {
  nextTick(() => {
    if (logsContainerRef.value) {
      logsContainerRef.value.scrollTop = logsContainerRef.value.scrollHeight;
    }
  });
}

// 监听日志追加，未暂停时自动贴底
watch(
  () => filteredLogs.value.length,
  () => {
    if (!logStore.isPaused) {
      scrollToBottom();
    }
  }
);

// 切换暂停状态
function togglePause() {
  logStore.togglePause();
  if (logStore.isPaused) {
    ElMessage.info('日志滚动已暂停，方便排查');
  } else {
    ElMessage.success('已恢复实时滚动');
    scrollToBottom();
  }
}

// 导出/下载系统日志
function handleDownloadLogs() {
  try {
    const link = document.createElement('a');
    link.href = '/api/logs/download';
    link.download = `cloudpan-logs-${Date.now()}.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    ElMessage.success('已开始下载服务器完整日志');
  } catch {
    if (filteredLogs.value.length === 0) {
      ElMessage.warning('当前暂无可导出的日志');
      return;
    }
    const blob = new Blob([filteredLogs.value.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloudpan-logs-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    ElMessage.success('已导出当前可见日志快照');
  }
}

// 复制日志
async function handleCopyLogs() {
  if (filteredLogs.value.length === 0) {
    ElMessage.warning('当前暂无可复制的日志内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(filteredLogs.value.join('\n'));
    ElMessage.success(`已复制 ${filteredLogs.value.length} 条日志到剪贴板`);
  } catch {
    ElMessage.error('复制失败，请手动选取');
  }
}

// 清空当前视图日志
function handleClearLogs() {
  logStore.clearLogs();
  ElMessage.info('已清空当前日志面板');
}

onMounted(() => {
  fetchSystemStatus();
  logStore.connectSSE();
  scrollToBottom();
});

onUnmounted(() => {
  logStore.disconnectSSE();
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- ================= 模块 1: 系统运行概览与健康指标 ================= -->
    <div class="settings-card !mb-0">
      <!-- 头部标题栏与刷新操作 -->
      <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Activity class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">系统运行概览</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">实时系统健康度、服务内核与持久化存储状态</p>
          </div>
        </div>
        <button
          type="button"
          class="btn-default text-xs h-8 px-3 flex items-center gap-1.5 cursor-pointer font-medium"
          :disabled="healthLoading"
          @click="fetchSystemStatus"
        >
          <RefreshCw class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" :class="{ 'animate-spin': healthLoading }" />
          <span>刷新状态</span>
        </button>
      </div>

      <!-- 统一的 4 列指标条 (纯白整洁卡片，规整统一) -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <!-- 1. 服务状态 -->
        <div class="p-3.5 rounded-xl bg-white dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80 flex flex-col justify-between shadow-xs">
          <div class="flex items-center justify-between">
            <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">服务状态</span>
            <Activity class="w-3.5 h-3.5 text-emerald-500" />
          </div>
          <div class="mt-2 flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span class="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">
              {{ healthData?.status === 'ok' ? '正常运行' : '检查中...' }}
            </span>
          </div>
          <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-1 font-mono">HEALTHY</span>
        </div>

        <!-- 2. 系统内核版本 -->
        <div class="p-3.5 rounded-xl bg-white dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80 flex flex-col justify-between shadow-xs">
          <div class="flex items-center justify-between">
            <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">系统内核版本</span>
            <Tag class="w-3.5 h-3.5 text-blue-500" />
          </div>
          <div class="mt-2 flex items-center gap-2">
            <span class="text-sm font-bold text-gray-800 dark:text-gray-100 font-mono">
              v{{ healthData?.version || '2.4.0' }}
            </span>
          </div>
          <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-1 truncate">139 移动云盘专用版</span>
        </div>

        <!-- 3. 持续运行时间 -->
        <div class="p-3.5 rounded-xl bg-white dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80 flex flex-col justify-between shadow-xs">
          <div class="flex items-center justify-between">
            <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">持续运行时间</span>
            <Clock class="w-3.5 h-3.5 text-amber-500" />
          </div>
          <div class="mt-2 flex items-center gap-2">
            <span class="text-sm font-bold text-gray-800 dark:text-gray-100 font-mono">
              {{ formattedUptime }}
            </span>
          </div>
          <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">进程未中断</span>
        </div>

        <!-- 4. 数据库引擎 -->
        <div class="p-3.5 rounded-xl bg-white dark:bg-gray-800/60 border border-gray-200/80 dark:border-gray-700/80 flex flex-col justify-between shadow-xs">
          <div class="flex items-center justify-between">
            <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">持久化数据库</span>
            <Database class="w-3.5 h-3.5 text-purple-500" />
          </div>
          <div class="mt-2 flex items-center gap-2">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="healthData?.database?.connected ? 'bg-emerald-500' : 'bg-rose-500'"
            />
            <span class="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">
              {{ healthData?.database?.connected ? '已连接 (WAL)' : '未连接' }}
            </span>
          </div>
          <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-1 font-mono">better-sqlite3</span>
        </div>
      </div>
    </div>

    <!-- ================= 模块 2: 系统实时运维日志大盘 ================= -->
    <div class="settings-card !mb-0">
      <!-- 头部控制栏 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Terminal class="w-5 h-5" />
          </div>
          <div>
            <div class="flex items-center gap-2.5">
              <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">系统实时日志</h3>
              <!-- 实时推送状态徽标 -->
              <span
                v-if="logStore.isPaused"
                class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-50 dark:bg-amber-950/70 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/80"
              >
                PAUSED · 滚动已暂停
              </span>
              <span
                v-else-if="logStore.isConnected"
                class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/80 flex items-center gap-1"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                LIVE · 实时流推送
              </span>
              <span
                v-else
                class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-gray-100 dark:bg-gray-800 text-gray-500 border border-gray-200 dark:border-gray-700"
              >
                连接中...
              </span>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              SSE 流式长连接实时推送 · 毫秒级任务事件与异常回溯
            </p>
          </div>
        </div>

        <!-- 工具按钮组 (纯白底、整洁、紧凑) -->
        <div class="flex flex-wrap items-center gap-2">
          <!-- 暂停/恢复滚动 -->
          <button
            type="button"
            class="btn-default text-xs h-8 px-3 flex items-center gap-1.5 cursor-pointer font-medium"
            :class="logStore.isPaused ? '!border-amber-500 !text-amber-600' : ''"
            @click="togglePause"
          >
            <Play v-if="logStore.isPaused" class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <Pause v-else class="w-3.5 h-3.5 text-amber-500" />
            <span>{{ logStore.isPaused ? '恢复滚动' : '暂停滚动' }}</span>
          </button>

          <!-- 复制日志 -->
          <button
            type="button"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1.5 cursor-pointer font-medium"
            title="复制当前过滤内容"
            @click="handleCopyLogs"
          >
            <Copy class="w-3.5 h-3.5 text-gray-500" />
            <span>复制</span>
          </button>

          <!-- 清空视图 -->
          <button
            type="button"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1.5 cursor-pointer font-medium"
            title="清空当前日志视图"
            @click="handleClearLogs"
          >
            <Trash2 class="w-3.5 h-3.5 text-gray-400" />
            <span>清空</span>
          </button>

          <!-- 导出日志 -->
          <button
            type="button"
            class="btn-default text-xs h-8 px-2.5 flex items-center gap-1.5 cursor-pointer font-medium"
            title="下载服务器完整日志文件"
            @click="handleDownloadLogs"
          >
            <Download class="w-3.5 h-3.5 text-blue-500" />
            <span>导出</span>
          </button>

          <!-- 滚至底部 -->
          <button
            type="button"
            class="btn-default text-xs h-8 px-2 flex items-center gap-1 cursor-pointer font-medium"
            title="滚动到日志最底部"
            @click="scrollToBottom"
          >
            <ArrowDown class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- 纯白高对比度筛选条与搜索框 (去除灰色外壳，直接以卡片形式排布) -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3.5">
        <!-- 标签组 -->
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="opt in tagOptions"
            :key="opt.key"
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg border transition-all cursor-pointer font-medium"
            :class="[
              activeTag === opt.key
                ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-500 hover:text-blue-600 dark:hover:border-blue-400'
            ]"
            @click="activeTag = opt.key"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- 搜索与条数计数 -->
        <div class="flex items-center gap-3 w-full sm:w-auto">
          <span class="text-xs text-gray-500 font-mono shrink-0">
            已显示 <strong class="text-gray-800 dark:text-gray-200">{{ filteredLogs.length }}</strong> / {{ logStore.logLines.length }} 条
          </span>
          <div class="relative w-full sm:w-60">
            <input
              v-model="searchKeyword"
              type="text"
              placeholder="搜索日志关键词..."
              class="input-base text-xs py-1.5 pl-8 pr-3 !h-9 w-full bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-400 rounded-lg focus:border-blue-500"
            />
            <Search class="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5 pointer-events-none" />
          </div>
        </div>
      </div>

      <!-- 结构化高清晰度日志列表 (纯白底色、清晰行分割、高对比度彩色标签) -->
      <div class="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#111827] shadow-xs overflow-hidden">
        <!-- 顶栏状态 -->
        <div class="flex items-center justify-between px-4 py-2 bg-white dark:bg-[#111827] border-b border-gray-100 dark:border-gray-800 text-xs">
          <div class="flex items-center gap-2 text-gray-600 dark:text-gray-400 font-medium">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>实时日志流 (SSE Live)</span>
            <span class="text-gray-300 dark:text-gray-700">|</span>
            <span class="text-gray-400 dark:text-gray-500 font-mono text-[11px]">按行结构化解析</span>
          </div>
          <span class="text-gray-400 text-[11px]">支持直接框选文字复制</span>
        </div>

        <!-- 日志内容列表 -->
        <div
          ref="logsContainerRef"
          class="h-[540px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800/60 scrollbar-thin select-text bg-white dark:bg-[#0f172a]"
        >
          <div v-if="filteredLogs.length === 0" class="text-gray-400 text-center py-28 select-none text-xs">
            {{ searchKeyword || activeTag !== 'ALL' ? '没有匹配当前过滤条件的日志记录' : '等待系统服务事件实时推送...' }}
          </div>
          <div
            v-for="(item, index) in parsedFilteredLogs"
            :key="index"
            class="flex items-start gap-2.5 py-1.5 px-3.5 hover:bg-blue-50/40 dark:hover:bg-slate-800/50 transition-colors text-xs leading-relaxed"
          >
            <!-- 时间戳 -->
            <span class="font-mono text-[11px] text-gray-400 dark:text-gray-500 shrink-0 select-none pt-0.5">
              {{ item.time }}
            </span>

            <!-- 模块标签徽标 -->
            <span
              v-if="item.tag"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 border"
              :class="item.tagClass"
            >
              {{ item.tag }}
            </span>

            <!-- 状态等级指示 -->
            <span
              v-if="item.level"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 font-mono border"
              :class="item.levelClass"
            >
              {{ item.level }}
            </span>

            <!-- 消息正文 (高对比度深色文字) -->
            <span class="flex-1 break-all" :class="item.messageClass">
              {{ item.message }}
            </span>
          </div>
        </div>
      </div>

      <small class="form-text mt-2 block">
        提示：当前视图内存最多保留最近 2000 条，完整系统历史可点击右上角【下载日志】。支持点击顶部标签进行各模块/DEBUG过滤，点击【暂停滚动】可冻结视野并排查错误。
      </small>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-thin::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(203, 213, 225, 0.7);
  border-radius: 3px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.9);
}
:global(.dark) .scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(51, 65, 85, 0.7);
}
:global(.dark) .scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: rgba(71, 85, 105, 0.9);
}
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import {
  Sparkles,
  ShieldAlert,
  AlertTriangle,
  Clapperboard,
  Tv,
  FolderSymlink,
  Radio,
  X,
  FileCheck,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Compass,
  CheckCircle2,
  RefreshCw,
  SlidersHorizontal,
  KeyRound,
  DownloadCloud,
  History,
  Check,
  Bot,
  Terminal,
  FileCode2,
} from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    forceAcknowledge?: boolean;
    initialTab?: 'changelog' | 'guide' | 'disclaimer';
  }>(),
  {
    modelValue: false,
    forceAcknowledge: false,
    initialTab: 'changelog',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void;
  (e: 'acknowledged'): void;
}>();

import { ElMessage } from 'element-plus';
import { settingsApi } from '../api/settings';

const CURRENT_APP_VERSION = '2.4.16';
const ACK_KEY = `cloudpan_v${CURRENT_APP_VERSION}_notice_ack`;

const agreed = ref(false);
const activeTab = ref<'changelog' | 'guide' | 'disclaimer'>('changelog');

const isForced = computed(() => {
  if (props.forceAcknowledge) return true;
  try {
    const stored = localStorage.getItem(ACK_KEY);
    return stored !== 'true';
  } catch (e) {
    return true;
  }
});

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      if (props.initialTab) {
        activeTab.value = props.initialTab;
      }
      const stored = localStorage.getItem(ACK_KEY);
      agreed.value = stored === 'true';
    }
  }
);

onMounted(() => {
  if (props.initialTab) {
    activeTab.value = props.initialTab;
  }
  const stored = localStorage.getItem(ACK_KEY);
  agreed.value = stored === 'true';
});

function handleClose() {
  if (isForced.value) {
    ElMessage.warning('首次升级请先阅读并确认当前版本更新说明');
    return;
  }
  emit('update:modelValue', false);
}

function handleConfirm() {
  if (!agreed.value) {
    ElMessage.warning('请先勾选我已仔细阅读并了解更新说明与规范');
    return;
  }
  try {
    localStorage.setItem(ACK_KEY, 'true');
    localStorage.setItem('cloudpan_notice_ack', 'true');
    localStorage.setItem('cloudpan_notice_dismissed', 'true');
    sessionStorage.setItem('cloudpan_notice_dismissed_session', 'true');
    document.cookie = `${ACK_KEY}=true; path=/; max-age=315360000; SameSite=Lax`;
  } catch (e) {}

  try {
    settingsApi.getSettings().then(cfg => {
      if (cfg) {
        cfg.system = cfg.system || {};
        cfg.system.noticeAck = true;
        cfg.system.lastNoticeVersion = CURRENT_APP_VERSION;
        settingsApi.saveSettings(cfg).catch(() => {});
      }
    }).catch(() => {});
  } catch (e) {}

  ElMessage.success('已确认更新日志与规范须知');
  emit('acknowledged');
  emit('update:modelValue', false);
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="modelValue"
      class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-fade-in"
    >
      <div
        class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transition-all transform scale-100"
        @click.stop
      >
        <!-- 弹窗顶栏 -->
        <div class="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gradient-to-r from-blue-50/60 to-indigo-50/40 dark:from-gray-800/60 dark:to-gray-800/40 shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-blue-600/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <Sparkles class="w-5 h-5" />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-base font-bold text-gray-900 dark:text-white leading-tight">
                  系统版本与全流程使用指引
                </h3>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-600 text-white tracking-wide">
                  v2.4.16
                </span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                AI 影视识别增强 · 内置官方 AI 开箱即用 · 规范命名 · 日志与交互体验优化
              </p>
            </div>
          </div>
          <button
            v-if="!isForced"
            type="button"
            class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
            @click="handleClose"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- 3 步走独立 Tab 切换 (更新日志 ➔ 新手使用说明 ➔ 风险免责) -->
        <div class="flex border-b border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/40 px-3 sm:px-5 pt-2 shrink-0 overflow-x-auto no-scrollbar">
          <button
            type="button"
            class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
            :class="
              activeTab === 'changelog'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400 font-bold'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'changelog'"
          >
            <History class="w-3.5 h-3.5" />
            <span>1. 更新日志 (v2.4.16)</span>
            <span class="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse ml-0.5" />
          </button>
          <button
            type="button"
            class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
            :class="
              activeTab === 'guide'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-bold'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'guide'"
          >
            <BookOpen class="w-3.5 h-3.5" />
            <span>2. 新手使用指南</span>
          </button>
          <button
            type="button"
            class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
            :class="
              activeTab === 'disclaimer'
                ? 'border-amber-600 text-amber-600 dark:text-amber-400 dark:border-amber-400 font-bold'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'disclaimer'"
          >
            <ShieldAlert class="w-3.5 h-3.5" />
            <span>3. 安全规范与免责</span>
          </button>
        </div>

        <!-- 弹窗正文内容 (随 Tab 独立展示，杜绝杂糅) -->
        <div class="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs text-gray-600 dark:text-gray-300 leading-relaxed flex-1">
          <!-- 标签页 1：更新日志 (v2.4.16 & v2.4.15 全栈架构重构合并) -->
          <div v-if="activeTab === 'changelog'" class="space-y-4">
            <!-- v2.4.16 当前最新版本 -->
            <div class="p-3.5 rounded-xl border border-blue-200/80 dark:border-blue-900/60 bg-blue-50/30 dark:bg-blue-950/20 space-y-3">
              <div class="flex items-center justify-between pb-2 border-b border-blue-100 dark:border-blue-900/40">
                <div class="flex items-center gap-2">
                  <span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-blue-600 text-white">
                    v2.4.16
                  </span>
                  <span class="font-bold text-gray-900 dark:text-white">功能改进与问题修复</span>
                </div>
                <span class="text-[11px] text-gray-400 font-mono">2026-11-18</span>
              </div>

              <!-- 统一单列排版：一行一个区域 -->
              <div class="space-y-2.5 text-[11px]">
                <!-- 1. AI 影视识别优化 -->
                <div class="p-2.5 rounded-lg border border-blue-100/80 dark:border-blue-900/40 bg-white dark:bg-gray-800/60 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Bot class="w-3.5 h-3.5 text-blue-600 shrink-0" />
                    <span>AI 影视识别更准确、不再拒答</span>
                  </div>
                  <ul class="list-disc list-inside space-y-0.5 text-gray-600 dark:text-gray-300 leading-normal pl-0.5">
                    <li><strong>自动附带真实文件名</strong>：不再只凭推文文本盲猜，系统发起对话时会自动带上下探到的真实视频文件名（如 S01E01、第1集），AI 提纯片名与集数更精准。</li>
                    <li><strong>去除网络链接，杜绝拒答</strong>：剥离推文中的网络链接并明确要求纯文本提取，彻底解决此前大模型因尝试访问外部链接而报错拒答的问题。</li>
                    <li><strong>长篇年番年份解耦</strong>：针对《沧元图》《一念永恒》等上百集连载动漫，自动解除推文带当季年份（如 2026）的干扰，优先以正确首播年份检索 TMDB，不再搜错剧集。</li>
                    <li><strong>番外与特别篇自动识别</strong>：全面识别云盘文件夹中的特别篇（SP）、番外篇、点映礼与加更篇，自动归入对应分季或特别篇，不再遗漏或乱放。</li>
                  </ul>
                </div>

                <!-- 2. 内置官方 AI 通道 -->
                <div class="p-2.5 rounded-lg border border-blue-100/80 dark:border-blue-900/40 bg-white dark:bg-gray-800/60 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Radio class="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                    <span>内置官方 AI 服务默认开箱即用</span>
                  </div>
                  <ul class="list-disc list-inside space-y-0.5 text-gray-600 dark:text-gray-300 leading-normal pl-0.5">
                    <li><strong>开箱即用直连</strong>：系统默认优先启用内置官方大模型通道，直接利用当前登录的云盘账号发起会话，无需自建大模型、无需填写第三方 API Key、无需探测本地 8045 端口。</li>
                    <li><strong>协议与稳定性优化</strong>：优化底层会话请求协议，修复偶尔出现的 406 (Not Acceptable) 鉴权报错，保证后台长期自动化稳定运行。</li>
                  </ul>
                </div>

                <!-- 3. 文件探测与重命名规范 -->
                <div class="p-2.5 rounded-lg border border-blue-100/80 dark:border-blue-900/40 bg-white dark:bg-gray-800/60 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <FileCode2 class="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <span>影视文件重命名更规范</span>
                  </div>
                  <p class="text-gray-600 dark:text-gray-300 leading-normal pl-0.5">
                    探测并重命名非 REMUX 原盘文件（普通网络压制或流媒体视频）时，自动补齐大写的 <strong>WEB-DL</strong> 标签，方便 Emby / Jellyfin / Plex 准确区分原盘与网络压制版本。
                  </p>
                </div>

                <!-- 4. 日志更清爽透明 -->
                <div class="p-2.5 rounded-lg border border-blue-100/80 dark:border-blue-900/40 bg-white dark:bg-gray-800/60 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Terminal class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>日志更清爽、排查问题一目了然</span>
                  </div>
                  <ul class="list-disc list-inside space-y-0.5 text-gray-600 dark:text-gray-300 leading-normal pl-0.5">
                    <li><strong>解决“失败 0 个”乱报红</strong>：修复了批处理任务统计汇报（如“写入完成：失败 0 个”、“执行完毕：失败: 0”）因包含“失败”二字被误标为红色 FAIL 错误日志的缺陷，现在全部正常显示为绿色成功（OK）。</li>
                    <li><strong>消除重复日志刷屏</strong>：修复了实时日志偶发连续出现两条一模一样记录的问题。</li>
                    <li><strong>AI 与 TMDB 比对全过程透明</strong>：实时日志新增 AI 提取片名、TMDB 搜索候选以及最终匹配理由的详细日志，为什么命中这部剧清清楚楚。</li>
                  </ul>
                </div>

                <!-- 5. 弹窗与交互细节 -->
                <div class="p-2.5 rounded-lg border border-blue-100/80 dark:border-blue-900/40 bg-white dark:bg-gray-800/60 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <History class="w-3.5 h-3.5 text-violet-600 shrink-0" />
                    <span>更新弹窗与操作体验优化</span>
                  </div>
                  <ul class="list-disc list-inside space-y-0.5 text-gray-600 dark:text-gray-300 leading-normal pl-0.5">
                    <li><strong>更新后自动弹出提醒</strong>：更新系统版本后，首次登录进入控制台会自动弹出本次更新说明与使用指南，无需到处寻找入口。</li>
                    <li><strong>修复弹窗内容重叠 Bug</strong>：彻底解决此前弹窗中更新日志与免责声明混在一起叠加显示的 Bug。</li>
                    <li><strong>统一单列排版</strong>：界面更新卡片全部统一为单列全宽布局，结构规范清晰。</li>
                  </ul>
                </div>
              </div>
            </div>

            <!-- v2.4.15 历史版本归档 (合并原核心架构特性，无需单独列出) -->
            <div class="p-3.5 rounded-xl border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-850 space-y-3">
              <div class="flex items-center justify-between pb-2 border-b border-gray-200/60 dark:border-gray-800">
                <div class="flex items-center gap-2">
                  <span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                    v2.4.15
                  </span>
                  <span class="font-bold text-gray-900 dark:text-white">全栈架构重构与核心能力</span>
                </div>
                <span class="text-[11px] text-gray-400 font-mono">2026-10-27</span>
              </div>

              <!-- 统一单列排版：一行一个区域 -->
              <div class="space-y-2.5 text-[11px]">
                <div class="p-2.5 rounded-lg border border-gray-200/60 dark:border-gray-800 bg-white dark:bg-gray-800/40 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Tv class="w-3.5 h-3.5 text-blue-600" />
                    <span>Vue 3 现代响应式前端</span>
                  </div>
                  <p class="text-gray-500 dark:text-gray-400 leading-normal">
                    彻底移除传统多页面 HTML 架构，采用 Vue 3 + Vite + Pinia 单页应用，实现秒级响应与丝滑交互。
                  </p>
                </div>

                <div class="p-2.5 rounded-lg border border-gray-200/60 dark:border-gray-800 bg-white dark:bg-gray-800/40 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Clapperboard class="w-3.5 h-3.5 text-indigo-600" />
                    <span>TMDB 智能影视整理</span>
                  </div>
                  <p class="text-gray-500 dark:text-gray-400 leading-normal">
                    影视剧集自动识别、多级模糊容错、季集指纹抽取并自动归档落盘，支持在线快速检索修正。
                  </p>
                </div>

                <div class="p-2.5 rounded-lg border border-gray-200/60 dark:border-gray-800 bg-white dark:bg-gray-800/40 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <FolderSymlink class="w-3.5 h-3.5 text-emerald-600" />
                    <span>139 官方 302 直链播放</span>
                  </div>
                  <p class="text-gray-500 dark:text-gray-400 leading-normal">
                    内置直链生成引擎，本地镜像生成 STRM 文件，Emby/Jellyfin 直连官方 CDN 高速串流，0 宿主机带宽占用。
                  </p>
                </div>

                <div class="p-2.5 rounded-lg border border-gray-200/60 dark:border-gray-800 bg-white dark:bg-gray-800/40 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <ShieldAlert class="w-3.5 h-3.5 text-amber-600" />
                    <span>网盘资产清理与去重中心</span>
                  </div>
                  <p class="text-gray-500 dark:text-gray-400 leading-normal">
                    6 层深度违规死链巡检、自底向上空目录修剪，以及纯算法 0 刮削多版本画质智能裁决去重。
                  </p>
                </div>

                <div class="p-2.5 rounded-lg border border-gray-200/60 dark:border-gray-800 bg-white dark:bg-gray-800/40 space-y-1">
                  <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white text-xs">
                    <Radio class="w-3.5 h-3.5 text-violet-600" />
                    <span>跨网盘离线 (首批 123) 与 TG 频道流式监控</span>
                  </div>
                  <p class="text-gray-500 dark:text-gray-400 leading-normal">
                    直链一键下发 123 网盘云端高速离线下载；支持免 API Key 公开频道推文嗅探与自动转存路由。
                  </p>
                </div>
              </div>
            </div>

            <!-- 向下翻页引导 -->
            <div class="pt-2 flex justify-end">
              <button
                type="button"
                class="px-4 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/80 text-indigo-700 dark:text-indigo-300 font-medium text-xs flex items-center gap-1.5 transition-all shadow-2xs cursor-pointer"
                @click="activeTab = 'guide'"
              >
                <span>下一步：查看新手快速使用指南</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- 标签页 2：新手使用指南 -->
          <div v-else-if="activeTab === 'guide'" class="space-y-4">
            <div class="p-3 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50 rounded-xl flex items-start gap-2.5">
              <Compass class="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
              <div class="space-y-0.5">
                <p class="font-bold text-indigo-900 dark:text-indigo-200">
                  从 0 到 1 自动化追更与影视直链全流程
                </p>
                <p class="text-[11px] text-indigo-700/90 dark:text-indigo-300/80 leading-normal">
                  系统采用「凭据绑定 ➔ 资源转存 ➔ 影视智能整理 ➔ STRM 直链生成 ➔ 资产健康巡检」五位一体的标准流水线。
                </p>
              </div>
            </div>

            <!-- 核心 4 步走标准链路 -->
            <div class="space-y-2.5">
              <!-- 第 1 步 -->
              <div class="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-850 shadow-2xs space-y-1">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-[11px]">1</span>
                    <span class="font-bold text-xs text-slate-900 dark:text-white">绑定 139 移动云盘账号</span>
                  </div>
                  <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300 border border-blue-200/50 dark:border-blue-900/50">
                    导航 ➔ 139 移动云盘 ➔ 云盘账号
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-normal pl-7">
                  支持多账号统一托管、扫码快捷登录与 Token 自动保活；设为主力的账号将作为默认转存与整理归档的落盘主体。
                </p>
              </div>

              <!-- 第 2 步 -->
              <div class="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-850 shadow-2xs space-y-1">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[11px]">2</span>
                    <span class="font-bold text-xs text-slate-900 dark:text-white">配置订阅获取（频道监控 / 单链追更）</span>
                  </div>
                  <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 border border-indigo-200/50 dark:border-indigo-900/50">
                    导航 ➔ 频道监控 / 单链追更
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-normal pl-7">
                  <b>频道监控</b>：流式监听 Telegram 资源频道推文，免登极速转存至暂存目录；<br>
                  <b>单链追更</b>：针对单个 139 分享链接设定轮询时间表，自动保存最新更新集数。
                </p>
              </div>

              <!-- 第 3 步 -->
              <div class="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-850 shadow-2xs space-y-1">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-violet-600 text-white flex items-center justify-center font-bold text-[11px]">3</span>
                    <span class="font-bold text-xs text-slate-900 dark:text-white">智能影视整理与洗版淘汰</span>
                  </div>
                  <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-300 border border-violet-200/50 dark:border-violet-900/50">
                    导航 ➔ 影视中心 ➔ 媒体整理 / 洗版策略
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-normal pl-7">
                  <b>媒体整理</b>：自动调用 TMDB API 识别影视剧集，提取标准季集号与点分命名，自动创建分季目录归档落盘；<br>
                  <b>洗版策略</b>：8 项画质权重比对，当同剧集出现更高清版本（如 4K HDR 替换 1080p）时自动淘汰低画质。
                </p>
              </div>

              <!-- 第 4 步 -->
              <div class="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-850 shadow-2xs space-y-1">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-[11px]">4</span>
                    <span class="font-bold text-xs text-slate-900 dark:text-white">STRM 原生直链生成与 Emby 串流</span>
                  </div>
                  <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-900/50">
                    导航 ➔ 影视中心 ➔ STRM 生成
                  </span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-normal pl-7">
                  一键为入库目录生成 <code>.strm</code> 文件提供给 Emby/Jellyfin，播放时直连 139 移动云盘官方 CDN 302 串流，零宿主机带宽开销，无损高速秒开。
                </p>
              </div>

              <!-- 进阶资产治理 -->
              <div class="p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/60 text-[11px] space-y-1.5">
                <div class="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <ShieldAlert class="w-3.5 h-3.5 text-amber-500" />
                  进阶巡检与资产治理（日常维护与健康保障）
                </div>
                <div class="text-slate-500 dark:text-slate-400 grid grid-cols-1 sm:grid-cols-3 gap-2 pt-0.5">
                  <div>• <b>资产同步</b>：139 多账号秒级互转 / 123 网盘离线调度</div>
                  <div>• <b>缺集检测</b>：TMDB 官方目录实时对账断集漏集</div>
                  <div>• <b>网盘清理</b>：隔离被拦截和谐死链与安全空目录修剪</div>
                </div>
              </div>
            </div>

            <!-- 下一步 / 上一步按钮导航 -->
            <div class="pt-2 flex items-center justify-between">
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 font-medium text-xs flex items-center gap-1 transition-colors cursor-pointer"
                @click="activeTab = 'changelog'"
              >
                <ArrowLeft class="w-3.5 h-3.5" />
                <span>返回更新日志</span>
              </button>
              <button
                type="button"
                class="px-4 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/60 dark:hover:bg-amber-900/80 text-amber-700 dark:text-amber-300 font-medium text-xs flex items-center gap-1.5 transition-all shadow-2xs cursor-pointer"
                @click="activeTab = 'disclaimer'"
              >
                <span>下一步：阅读安全风险规范</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- 标签页 3：风险与免责声明 (明确 v-else-if，杜绝混排串台) -->
          <div v-else-if="activeTab === 'disclaimer'" class="space-y-3.5">
            <div class="p-3 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/60 rounded-xl flex items-start gap-2.5">
              <AlertTriangle class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div class="space-y-1">
                <div class="font-bold text-amber-900 dark:text-amber-200">
                  使用风险提示与合规须知
                </div>
                <p class="text-[11px] text-amber-800/90 dark:text-amber-300/80 leading-normal">
                  使用本系统各项转存、定时调度及网盘文件清理功能前，请务必详细阅读并理解以下安全事项。
                </p>
              </div>
            </div>

            <div class="space-y-2.5">
              <div class="p-2.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/30">
                <div class="font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
                  1. 账号频率与风控防范
                </div>
                <p class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  本系统通过模拟官方接口实现自动化转存与查询。请合理设置监控轮询间隔（推荐不低于 5-10 分钟），严禁用于高频暴力转存或并发抓取，避免引起网盘服务端风控限制或账号封禁。
                </p>
              </div>

              <div class="p-2.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/30">
                <div class="font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
                  2. 资产安全与防误删原则
                </div>
                <p class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  系统在「网盘清理」及「多版本去重」中严格遵循「0 物理硬删」的安全红线，默认全部移入 139 网盘回收站（可随时手动还原）。请务必不要随意关闭保护机制，建议初次使用时先开启「试运行 (Dry Run)」对比结果。
                </p>
              </div>

              <div class="p-2.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/30">
                <div class="font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-red-600"></span>
                  3. 开源研究与法律免责声明
                </div>
                <p class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  本开源项目仅供个人技术研究、网络学习及私人数据备份交流使用。系统所转存、抓取或处理的文件均来自第三方互联网公开分享链接，请自觉遵守当地相关法律法规，严禁用于任何商业侵权行为，因违规使用造成的一切法律与版权后果均由使用者自行承担。
                </p>
              </div>
            </div>

            <!-- 返回上一页按钮 -->
            <div class="pt-2 flex justify-start">
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 font-medium text-xs flex items-center gap-1 transition-colors cursor-pointer"
                @click="activeTab = 'guide'"
              >
                <ArrowLeft class="w-3.5 h-3.5" />
                <span>返回新手使用指南</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 弹窗底栏 -->
        <div class="px-5 py-3.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-850 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              v-model="agreed"
              type="checkbox"
              class="rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
            />
            <span class="text-xs font-medium text-gray-700 dark:text-gray-300">
              我已仔细阅读并了解上述更新说明、使用流程与风险规范
            </span>
          </label>

          <div class="flex items-center justify-end gap-2">
            <!-- 仅在非强制观看（已确认过该版本、后续主动翻阅）时才提供关闭退出按钮；强制观看时绝不展示任何取消/跳过按钮 -->
            <button
              v-if="!isForced"
              type="button"
              class="px-3.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors cursor-pointer"
              @click="handleClose"
            >
              关闭
            </button>
            <button
              type="button"
              :disabled="!agreed"
              :class="!agreed ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'"
              class="btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5 shadow-sm transition-all"
              @click="handleConfirm"
            >
              <FileCheck class="w-3.5 h-3.5" />
              <span>同意并进入控制台</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
.animate-fade-in {
  animation: fadeIn 0.15s ease-out;
}
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
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
} from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    forceAcknowledge?: boolean;
  }>(),
  {
    modelValue: false,
    forceAcknowledge: false,
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void;
  (e: 'acknowledged'): void;
}>();

import { ElMessage } from 'element-plus';
import { settingsApi } from '../api/settings';

const agreed = ref(true);
const activeTab = ref<'updates' | 'guide' | 'disclaimer'>('updates');

const ACK_KEY = 'cloudpan_v2415_notice_ack';

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      const stored = localStorage.getItem(ACK_KEY);
      agreed.value = stored !== null ? stored === 'true' : true;
    }
  }
);

onMounted(() => {
  const stored = localStorage.getItem(ACK_KEY);
  agreed.value = stored !== null ? stored === 'true' : true;
});

function handleClose() {
  if (props.forceAcknowledge && !agreed.value) {
    return;
  }
  try {
    sessionStorage.setItem('cloudpan_notice_dismissed_session', 'true');
    localStorage.setItem('cloudpan_notice_dismissed', 'true');
  } catch (e) {}
  emit('update:modelValue', false);
}

function handleConfirm() {
  agreed.value = true;
  try {
    localStorage.setItem(ACK_KEY, 'true');
    localStorage.setItem('cloudpan_notice_ack', 'true');
    localStorage.setItem('cloudpan_notice_dismissed', 'true');
    sessionStorage.setItem('cloudpan_notice_dismissed_session', 'true');
    document.cookie = 'cloudpan_notice_ack=true; path=/; max-age=315360000; SameSite=Lax';
  } catch (e) {}

  try {
    settingsApi.getSettings().then(cfg => {
      if (cfg) {
        cfg.system = cfg.system || {};
        cfg.system.noticeAck = true;
        settingsApi.saveSettings(cfg).catch(() => {});
      }
    }).catch(() => {});
  } catch (e) {}

  ElMessage.success('已确认规范须知，后续将不再弹出');
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
                  v2.4.15
                </span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                全栈架构重大重构 · 影视智能整理 · 媒体资产治理
              </p>
            </div>
          </div>
          <button
            v-if="!forceAcknowledge"
            type="button"
            class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
            @click="handleClose"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- 3 步走独立 Tab 切换 (版本概览 ➔ 新手使用说明 ➔ 风险免责) -->
        <div class="flex border-b border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/40 px-3 sm:px-5 pt-2 shrink-0 overflow-x-auto no-scrollbar">
          <button
            type="button"
            class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
            :class="
              activeTab === 'updates'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'updates'"
          >
            <Sparkles class="w-3.5 h-3.5" />
            <span>1. 重构版本概览</span>
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
            <span class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse ml-0.5" />
          </button>
          <button
            type="button"
            class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
            :class="
              activeTab === 'disclaimer'
                ? 'border-amber-600 text-amber-600 dark:text-amber-400 dark:border-amber-400'
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
          <!-- 标签页 1：更新亮点概览 (重构版本) -->
          <div v-if="activeTab === 'updates'" class="space-y-3.5">
            <div class="p-3 bg-blue-50/70 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl">
              <p class="font-medium text-blue-900 dark:text-blue-300">
                🎉 本次版本对系统架构与用户交互进行了彻底重构，全面迈入现代化全屏响应式标准。
              </p>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 space-y-1">
                <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white">
                  <Tv class="w-4 h-4 text-blue-600" />
                  Vue 3 现代响应式前端
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-normal">
                  彻底移除传统多页面 HTML 架构，采用 Vue 3 + Vite + Pinia 单页应用，实现秒级响应与丝滑交互。
                </p>
              </div>

              <div class="p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 space-y-1">
                <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white">
                  <Clapperboard class="w-4 h-4 text-indigo-600" />
                  TMDB 智能影视整理
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-normal">
                  影视剧集自动识别、多级模糊容错、季集指纹抽取并自动归档落盘，支持在线快速检索修正。
                </p>
              </div>

              <div class="p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 space-y-1">
                <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white">
                  <FolderSymlink class="w-4 h-4 text-emerald-600" />
                  139 官方 302 直链播放
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-normal">
                  内置直链生成引擎，本地镜像生成 STRM 文件，Emby/Jellyfin 直连 139 官方 CDN 高速串流，0 宿主机带宽占用。
                </p>
              </div>

              <div class="p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 space-y-1">
                <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white">
                  <ShieldAlert class="w-4 h-4 text-amber-600" />
                  网盘资产清理与去重中心
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-normal">
                  6 层深度违规死链巡检、自底向上空目录修剪，以及纯算法 0 刮削多版本画质智能裁决去重。
                </p>
              </div>

              <div class="p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 space-y-1 sm:col-span-2">
                <div class="flex items-center gap-1.5 font-bold text-gray-900 dark:text-white">
                  <Radio class="w-4 h-4 text-violet-600" />
                  跨网盘离线 (首批 123) 与 TG 频道流式监控
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-normal">
                  139 直链一键下发 123 网盘云端高速离线下载；支持免 API Key 公开频道推文嗅探与自动转存路由。
                </p>
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

          <!-- 标签页 2：新手使用指南 (独立下一页，避免与更新重构杂糅) -->
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
                  支持多账号统一托管、扫码免密登录与 Token 自动保活；设为主力的账号将作为默认转存与整理归档的落盘主体。
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
                @click="activeTab = 'updates'"
              >
                <ArrowLeft class="w-3.5 h-3.5" />
                <span>返回版本概览</span>
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

          <!-- 标签页 3：风险与免责声明 -->
          <div v-else class="space-y-3.5">
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
            <button
              v-if="!forceAcknowledge"
              type="button"
              class="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors cursor-pointer"
              @click="handleClose"
            >
              稍后再看
            </button>
            <button
              type="button"
              class="btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
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

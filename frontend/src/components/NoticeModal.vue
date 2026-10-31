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
const activeTab = ref<'updates' | 'disclaimer'>('updates');

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
                  系统升级与风险规范须知
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

        <!-- Tab 切换 -->
        <div class="flex border-b border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/40 px-5 pt-2 shrink-0">
          <button
            type="button"
            class="px-4 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5"
            :class="
              activeTab === 'updates'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'updates'"
          >
            <Sparkles class="w-3.5 h-3.5" />
            更新亮点概览
          </button>
          <button
            type="button"
            class="px-4 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5"
            :class="
              activeTab === 'disclaimer'
                ? 'border-amber-600 text-amber-600 dark:text-amber-400 dark:border-amber-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            "
            @click="activeTab = 'disclaimer'"
          >
            <ShieldAlert class="w-3.5 h-3.5" />
            使用风险与免责声明
          </button>
        </div>

        <!-- 弹窗正文内容 -->
        <div class="p-5 overflow-y-auto space-y-4 text-xs text-gray-600 dark:text-gray-300 leading-relaxed flex-1">
          <!-- 标签页 1：更新亮点 -->
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
          </div>

          <!-- 标签页 2：风险与免责声明 -->
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
              我已仔细阅读并了解上述更新说明与使用风险
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
</style>
<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '../api/request';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Users,
  Radio,
  ListTodo,
  ShieldAlert,
  Clapperboard,
  FolderSymlink,
  RefreshCw,
  SlidersHorizontal,
  Activity,
  ChevronDown,
  LogOut,
  Menu,
  X,
  Save,
  Sun,
  Moon,
  Tv,
} from 'lucide-vue-next';
import { isDark, toggleTheme, initTheme } from '../composables/useTheme';
import NoticeModal from '../components/NoticeModal.vue';
import { HelpCircle } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();

// 移动端侧边栏展开状态
const sidebarOpen = ref(false);
const showNoticeModal = ref(false);

// 手风琴折叠状态 (使用 reactive 保证双向绑定与持久化)
const groupCollapsed = reactive({
  system: false,
  cloud139: false,
  media: false,
});

function toggleGroup(groupId: 'system' | 'cloud139' | 'media') {
  groupCollapsed[groupId] = !groupCollapsed[groupId];
  try {
    localStorage.setItem(`sidebar_group_${groupId}`, groupCollapsed[groupId] ? 'collapsed' : 'expanded');
  } catch (err) {}
}

onMounted(() => {
  // 初始化暗黑/亮色主题
  initTheme();

  // 登录进入控制台后，若尚未确认过 v2.4.15 更新规范则自动弹出须知弹窗
  try {
    if (localStorage.getItem('cloudpan_v2415_notice_ack') !== 'true') {
      showNoticeModal.value = true;
    }
  } catch (err) {}

  // 恢复本地存储的手风琴折叠偏好
  (['system', 'cloud139', 'media'] as const).forEach((gid) => {
    try {
      const saved = localStorage.getItem(`sidebar_group_${gid}`);
      if (saved === 'collapsed') {
        groupCollapsed[gid] = true;
      }
    } catch (err) {}
  });
});

// 退出登录
async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定要退出当前控制台会话吗？', '退出确认', {
      type: 'warning',
      confirmButtonText: '确认退出',
      cancelButtonText: '取消',
    });
    await http.post('/api/auth/logout');
    ElMessage.success('已安全退出会话');
    router.push('/login');
  } catch (err) {}
}

// 当前路由的元信息（标题、徽标、副标题）
const currentTitle = computed(() => (route.meta.title as string) || '云盘自动追更');
const currentBadge = computed(() => (route.meta.badge as string) || '实时监控');
const currentDesc = computed(() => (route.meta.desc as string) || '管理移动云盘订阅更新与自动转存任务');
const showHeaderSave = computed(() => Boolean(route.meta.showSaveBtn));
const saveBtnText = computed(() => (route.meta.saveBtnText as string) || '保存配置');

function handleHeaderSaveClick() {
  window.dispatchEvent(new CustomEvent('header-save-click'));
}
</script>

<template>
  <div class="flex min-h-screen w-full bg-[#f8fafc] dark:bg-[#0b1120] text-gray-900 dark:text-gray-100 transition-colors duration-200">
    <!-- 移动端侧边栏遮罩 -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40 md:hidden transition-opacity duration-300"
      @click="sidebarOpen = false"
    />

    <!-- ================= 左侧导航边栏 ================= -->
    <aside
      class="fixed md:sticky top-0 left-0 h-screen w-64 bg-white dark:bg-[#111827] border-r border-gray-200 dark:border-gray-800 flex flex-col z-50 transition-transform duration-300 flex-shrink-0"
      :class="sidebarOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full md:translate-x-0 shadow-none'"
    >
      <!-- 品牌与 Logo 区域 -->
      <div class="h-16 px-5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
        <div class="flex items-center gap-3">
          <img src="/logo.svg" alt="139 Auto Save Logo" class="w-9 h-9 rounded-xl shadow-md shadow-blue-500/20 flex-shrink-0 object-contain" />
          <div>
            <h1 class="text-base font-bold text-gray-900 dark:text-white leading-tight tracking-tight flex items-center gap-1.5">
              云盘自动追更
            </h1>
            <p class="text-[11px] text-gray-400 dark:text-gray-500 font-mono">139 Auto Save</p>
          </div>
        </div>
        <!-- 移动端收起侧边栏按钮 -->
        <button
          type="button"
          class="md:hidden p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
          @click="sidebarOpen = false"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- 分组导航菜单 -->
      <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3 custom-scrollbar sidebar-tabs">
        <!-- 分组 1: 基础与全局设置 (置顶以保障网络代理与初始环境优先就绪) -->
        <div class="sidebar-accordion-group">
          <button
            type="button"
            class="sidebar-group-btn"
            :class="{ collapsed: groupCollapsed.system }"
            @click="toggleGroup('system')"
          >
            <span class="flex items-center gap-2 pointer-events-none select-none">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>基础与全局设置</span>
            </span>
            <span class="sidebar-chevron-pill pointer-events-none select-none">
              <ChevronDown class="sidebar-group-chevron" />
            </span>
          </button>
          <div
            v-show="!groupCollapsed.system"
            :class="{ hidden: groupCollapsed.system }"
            class="sidebar-group-items space-y-0.5 mt-1"
          >
            <router-link
              to="/settings"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/settings' }"
              @click="sidebarOpen = false"
            >
              <SlidersHorizontal class="w-4 h-4" />
              <span>全局设置</span>
            </router-link>
            <router-link
              to="/system"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/system' }"
              @click="sidebarOpen = false"
            >
              <Activity class="w-4 h-4" />
              <span>系统监控</span>
            </router-link>
          </div>
        </div>

        <!-- 分组 2: 139 移动云盘 -->
        <div class="sidebar-accordion-group">
          <button
            type="button"
            class="sidebar-group-btn"
            :class="{ collapsed: groupCollapsed.cloud139 }"
            @click="toggleGroup('cloud139')"
          >
            <span class="flex items-center gap-2 pointer-events-none select-none">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <span>139 移动云盘</span>
            </span>
            <span class="sidebar-chevron-pill pointer-events-none select-none">
              <ChevronDown class="sidebar-group-chevron" />
            </span>
          </button>
          <div
            v-show="!groupCollapsed.cloud139"
            :class="{ hidden: groupCollapsed.cloud139 }"
            class="sidebar-group-items space-y-0.5 mt-1"
          >
            <router-link
              to="/accounts"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/accounts' }"
              @click="sidebarOpen = false"
            >
              <Users class="w-4 h-4" />
              <span>云盘账号</span>
            </router-link>
            <router-link
              to="/channel"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/channel' }"
              @click="sidebarOpen = false"
            >
              <Radio class="w-4 h-4" />
              <span>频道监控</span>
            </router-link>
            <router-link
              to="/tasks"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/tasks' }"
              @click="sidebarOpen = false"
            >
              <ListTodo class="w-4 h-4" />
              <span>单链追更</span>
            </router-link>
            <router-link
              to="/maintenance"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/maintenance' }"
              @click="sidebarOpen = false"
            >
              <ShieldAlert class="w-4 h-4" />
              <span>网盘清理</span>
            </router-link>
          </div>
        </div>

        <!-- 分组 3: 影视与媒体中心 -->
        <div class="sidebar-accordion-group">
          <button
            type="button"
            class="sidebar-group-btn"
            :class="{ collapsed: groupCollapsed.media }"
            @click="toggleGroup('media')"
          >
            <span class="flex items-center gap-2 pointer-events-none select-none">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <span>影视与媒体中心</span>
            </span>
            <span class="sidebar-chevron-pill pointer-events-none select-none">
              <ChevronDown class="sidebar-group-chevron" />
            </span>
          </button>
          <div
            v-show="!groupCollapsed.media"
            :class="{ hidden: groupCollapsed.media }"
            class="sidebar-group-items space-y-0.5 mt-1"
          >
            <router-link
              to="/organize"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/organize' || (route.path === '/scrape' && (!route.query.tab || route.query.tab === 'organize')) }"
              @click="sidebarOpen = false"
            >
              <Clapperboard class="w-4 h-4" />
              <span>媒体整理</span>
            </router-link>
            <router-link
              to="/wash"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/wash' || (route.path === '/scrape' && route.query.tab === 'wash') }"
              @click="sidebarOpen = false"
            >
              <SlidersHorizontal class="w-4 h-4" />
              <span>洗版策略</span>
            </router-link>
            <router-link
              to="/missing"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/missing' || route.path === '/episodes' }"
              @click="sidebarOpen = false"
            >
              <Tv class="w-4 h-4" />
              <span>缺集检测</span>
            </router-link>
            <router-link
              to="/mount"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/mount' }"
              @click="sidebarOpen = false"
            >
              <FolderSymlink class="w-4 h-4" />
              <span>媒体挂载</span>
            </router-link>
            <router-link
              to="/sync"
              class="sidebar-nav-item"
              :class="{ active: route.path === '/sync' }"
              @click="sidebarOpen = false"
            >
              <RefreshCw class="w-4 h-4" />
              <span>资产同步</span>
            </router-link>
          </div>
        </div>
      </div>

      <!-- 侧边栏底部：退出登录与主题/版本状态 -->
      <div class="p-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-900/60 flex-shrink-0 space-y-2">
        <button
          type="button"
          class="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-900 text-xs font-medium text-gray-700 dark:text-gray-300 transition-colors shadow-sm cursor-pointer"
          title="退出当前控制台会话"
          @click="handleLogout"
        >
          <LogOut class="w-3.5 h-3.5 text-red-500" />
          <span>退出登录</span>
        </button>

        <!-- 版本状态指示条 -->
        <div class="flex items-center justify-between px-1.5 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500 font-mono">
          <div class="flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>v2.4.0</span>
          </div>
          <span class="text-[10px] text-gray-400 dark:text-gray-500">Node.js</span>
        </div>
      </div>
    </aside>

    <!-- ================= 右侧主工作视口 (Main Viewport) ================= -->
    <div class="flex-1 flex flex-col min-w-0 min-h-screen">
      <!-- 顶部应用栏 Top Header -->
      <header class="h-16 px-3 sm:px-4 md:px-8 border-b border-gray-200/80 dark:border-gray-800 bg-white/90 dark:bg-[#111827]/90 backdrop-blur sticky top-0 z-30 flex items-center justify-between flex-shrink-0 transition-colors">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="md:hidden p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
            title="展开菜单"
            @click="sidebarOpen = true"
          >
            <Menu class="w-5 h-5" />
          </button>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-base md:text-lg font-bold text-gray-900 dark:text-white leading-tight">
                {{ currentTitle }}
              </h2>
              <span class="hidden sm:inline-flex px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80">
                {{ currentBadge }}
              </span>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 hidden sm:block mt-0.5">
              {{ currentDesc }}
            </p>
          </div>
        </div>

        <!-- 顶部右侧：主题切换与保存按钮 -->
        <div class="flex items-center gap-2 sm:gap-3">
          <!-- 暗黑/亮色切换按钮 -->
          <button
            type="button"
            class="h-8 w-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer flex items-center justify-center shadow-xs"
            :title="isDark ? '切换至亮色模式' : '切换至暗黑模式'"
            @click="toggleTheme"
          >
            <Sun v-if="isDark" class="w-4 h-4 text-amber-400" />
            <Moon v-else class="w-4 h-4 text-slate-600" />
          </button>

          <!-- 一步到位保存按钮 -->
          <button
            v-if="showHeaderSave"
            type="button"
            class="btn-primary text-xs h-8 px-2.5 sm:px-3.5 flex items-center gap-1.5 shadow-sm transition-all shrink-0"
            @click="handleHeaderSaveClick"
          >
            <Save class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">{{ saveBtnText }}</span>
            <span class="sm:hidden">保存</span>
          </button>
        </div>
      </header>

      <!-- 主内容滚动区 -->
      <main class="flex-1 p-3 sm:p-4 md:p-6 lg:p-8 overflow-y-auto">
        <div class="app-viewport-container w-full">
          <router-view />
        </div>
      </main>
    </div>
  </div>
    <NoticeModal v-model="showNoticeModal" />
  </template>

<style scoped>
</style>

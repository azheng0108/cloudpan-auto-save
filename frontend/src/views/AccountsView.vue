<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { accountApi, type AccountItem } from '../api/account';
import { ElMessage } from 'element-plus';
import logo139 from '../assets/139-logo.png';
import {
  HardDrive,
  Cloud,
  Plus,
  RefreshCw,
  Trash2,
  Star,
  Edit3,
  Info,
  CheckCircle2,
  AlertTriangle,
  Crown,
  Database,
  Users,
  Copy,
  ExternalLink,
  Check,
  X,
  ChevronUp,
} from 'lucide-vue-next';

// 账号列表数据与加载状态
const loading = ref(false);
const accounts = ref<AccountItem[]>([]);
const isRefreshing = ref(false);

// 页面内联表单控制（零弹窗：直接在页面流中展开与编辑）
const showForm = ref(false);
const isEditing = ref(false);
const submitting = ref(false);
const formContainerRef = ref<HTMLElement | null>(null);

// 表单数据
const form = ref({
  id: 0,
  username: '',
  alias: '',
  cookies: '',
  accountType: 'cloud139' as const,
});

// 图形验证码状态（内联渲染）
const captchaVisible = ref(false);
const captchaUrl = ref('');
const validateCode = ref('');

// 卡片原位别名修改状态（零弹窗：点击铅笔直接在卡片原位变成输入框）
const editingAliasAccountId = ref<number | string | null>(null);
const inlineAliasValue = ref('');
const savingAlias = ref(false);

// 卡片原位删除确认状态（零弹窗：点击垃圾桶直接在卡片原位展示确认胶囊）
const deletingAccountId = ref<number | string | null>(null);

// 统计总容量与账号数
const stats = computed(() => {
  let totalPersonalBytes = 0;
  let usedPersonalBytes = 0;
  let totalFamilyBytes = 0;
  let usedFamilyBytes = 0;
  let activeCount = 0;

  accounts.value.forEach((acc) => {
    if (acc.isActive !== false && acc.memberStatus !== 'auth_failed') {
      activeCount++;
    }
    const c = acc.capacity?.cloudCapacityInfo;
    if (c) {
      totalPersonalBytes += c.totalSize || 0;
      usedPersonalBytes += c.usedSize || 0;
    }
    const f = acc.capacity?.familyCapacityInfo;
    if (f) {
      totalFamilyBytes += f.totalSize || 0;
      usedFamilyBytes += f.usedSize || 0;
    }
  });

  const totalAllBytes = totalPersonalBytes + totalFamilyBytes;
  const usedAllBytes = usedPersonalBytes + usedFamilyBytes;

  return {
    totalAccounts: accounts.value.length,
    activeAccounts: activeCount,
    totalPersonalBytes,
    usedPersonalBytes,
    totalPersonalFormatted: formatBytes(totalPersonalBytes),
    usedPersonalFormatted: formatBytes(usedPersonalBytes),
    totalFamilyBytes,
    usedFamilyBytes,
    totalFamilyFormatted: formatBytes(totalFamilyBytes),
    usedFamilyFormatted: formatBytes(usedFamilyBytes),
    totalAllBytes,
    usedAllBytes,
    totalAllFormatted: formatBytes(totalAllBytes),
    usedAllFormatted: formatBytes(usedAllBytes),
    percent: totalAllBytes > 0 ? Math.min(100, Math.round((usedAllBytes / totalAllBytes) * 100)) : 0,
  };
});

// 格式化容量大小 (B -> KB / MB / GB / TB)
function formatBytes(bytes: number | undefined): string {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const base = 1024;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
  const value = bytes / Math.pow(base, exponent);
  return `${value.toFixed(exponent >= 3 ? 2 : 1)} ${units[exponent]}`;
}

// 获取账号列表
async function loadAccounts(silent = false) {
  if (!silent) loading.value = true;
  try {
    const list = await accountApi.getAccounts();
    accounts.value = list || [];
    // 当账号列表为空时，自动在页面内展开添加表单，避免用户面对空框还要点按钮
    if (accounts.value.length === 0) {
      openInlineAddForm(false);
    }
  } catch (err: any) {
    ElMessage.error(`获取账号列表失败: ${err.message || '网络连接异常'}`);
  } finally {
    loading.value = false;
    isRefreshing.value = false;
  }
}

// 刷新全部账号容量与状态
async function handleRefreshAll() {
  isRefreshing.value = true;
  await loadAccounts(false);
  ElMessage.success('已刷新全部云盘账号容量与保活状态');
}

// 展开内联添加表单
function openInlineAddForm(shouldScroll = true) {
  isEditing.value = false;
  captchaVisible.value = false;
  captchaUrl.value = '';
  validateCode.value = '';
  form.value = {
    id: 0,
    username: '',
    alias: '',
    cookies: '',
    accountType: 'cloud139',
  };
  showForm.value = true;
  if (shouldScroll) {
    nextTick(() => {
      formContainerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

// 展开内联编辑表单
function openInlineEditForm(account: AccountItem) {
  isEditing.value = true;
  captchaVisible.value = false;
  captchaUrl.value = '';
  validateCode.value = '';
  form.value = {
    id: Number(account.id),
    username: account.original_username || account.username,
    alias: account.alias || '',
    cookies: '',
    accountType: 'cloud139',
  };
  showForm.value = true;
  nextTick(() => {
    formContainerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// 关闭内联表单
function closeInlineForm() {
  if (accounts.value.length === 0) {
    ElMessage.info('当前尚未绑定任何账号，请先完成绑定');
    return;
  }
  showForm.value = false;
  isEditing.value = false;
}

// 提交内联表单
async function handleSubmitAccount() {
  if (!form.value.username.trim()) {
    ElMessage.warning('请输入 139 移动云盘手机号或用户名');
    return;
  }
  if (!form.value.cookies.trim()) {
    ElMessage.warning('移动云盘（139）必须填入 Cookie 凭据才能鉴权');
    return;
  }

  submitting.value = true;
  try {
    const payload: any = {
      username: form.value.username.trim(),
      cookies: form.value.cookies.trim(),
      accountType: 'cloud139',
      alias: form.value.alias.trim(),
    };

    if (isEditing.value && form.value.id) {
      payload.id = form.value.id;
    }
    if (captchaVisible.value && validateCode.value) {
      payload.validateCode = validateCode.value.trim();
    }

    const res: any = await accountApi.addAccount(payload);
    if (res && res.code === 'NEED_CAPTCHA') {
      captchaVisible.value = true;
      captchaUrl.value = res.data?.captchaUrl || '';
      ElMessage.warning('当前需要输入验证码，请根据图片填写后重新点击提交');
      return;
    }

    ElMessage.success(isEditing.value ? '账号凭据与配置已更新' : '成功绑定移动云盘账号！');
    showForm.value = false;
    await loadAccounts(false);
  } catch (err: any) {
    ElMessage.error(`操作失败: ${err.message || '凭证校验错误'}`);
  } finally {
    submitting.value = false;
  }
}

// 设为默认账号
async function handleSetDefault(account: AccountItem) {
  if (account.isDefault) return;
  try {
    await accountApi.setDefault(account.id);
    ElMessage.success(`已将账号【${account.alias || account.username}】设为全局默认账号`);
    await loadAccounts(false);
  } catch (err: any) {
    ElMessage.error(`设置默认账号失败: ${err.message || '服务异常'}`);
  }
}

// 取消默认账号
async function handleCancelDefault(account: AccountItem) {
  try {
    await accountApi.cancelDefault(account.id);
    account.isDefault = false;
    ElMessage.success(`已取消账号【${account.alias || account.username}】的默认状态`);
    await loadAccounts(false);
  } catch (err: any) {
    ElMessage.error(`取消默认账号失败: ${err.message || '服务异常'}`);
  }
}

// 开始原位修改别名
function startInlineEditAlias(account: AccountItem) {
  editingAliasAccountId.value = account.id;
  inlineAliasValue.value = account.alias || '';
}

// 确认原位保存别名
async function saveInlineAlias(account: AccountItem) {
  savingAlias.value = true;
  try {
    await accountApi.setAlias(account.id, inlineAliasValue.value.trim());
    account.alias = inlineAliasValue.value.trim();
    editingAliasAccountId.value = null;
    ElMessage.success('备注别名已更新');
  } catch (err: any) {
    ElMessage.error(`修改别名失败: ${err.message || '服务异常'}`);
  } finally {
    savingAlias.value = false;
  }
}

// 取消原位修改别名
function cancelInlineAlias() {
  editingAliasAccountId.value = null;
}

// 原位触发删除确认
function promptInlineDelete(account: AccountItem) {
  deletingAccountId.value = account.id;
}

// 确认原位删除
async function confirmInlineDelete(account: AccountItem) {
  try {
    await accountApi.deleteAccount(account.id);
    ElMessage.success(`账号【${account.alias || account.username}】已删除`);
    deletingAccountId.value = null;
    await loadAccounts(false);
  } catch (err: any) {
    ElMessage.error(`删除账号失败: ${err.message || '操作异常'}`);
  }
}

// 一键清理失效账号
async function handleRecycleAccounts() {
  try {
    await accountApi.recycleAccounts();
    ElMessage.success('失效账号已清理完成');
    await loadAccounts(false);
  } catch (err: any) {
    ElMessage.error(`清理账号失败: ${err.message || '操作异常'}`);
  }
}

// 快速剪贴板粘贴 Cookie
async function handlePasteCookie() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      form.value.cookies = text.trim();
      ElMessage.success('已从剪贴板粘贴 Cookie');
    } else {
      ElMessage.info('剪贴板中无内容');
    }
  } catch {
    ElMessage.warning('未能读取系统剪贴板，请手动使用快捷键 Ctrl+V 粘贴');
  }
}

onMounted(() => {
  loadAccounts();
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- ================= 顶部概览与操作栏 ================= -->
    <div class="settings-card !p-5">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <!-- 左侧标题与概览指标 -->
        <div class="flex items-center gap-3.5">
          <div class="w-11 h-11 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 shadow-xs">
            <HardDrive class="w-6 h-6" />
          </div>
          <div>
            <div class="flex items-center gap-2.5">
              <h2 class="text-base font-bold text-gray-900 dark:text-white leading-tight">
                139 移动云盘账号
              </h2>
              <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-50 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80">
                已绑定 {{ stats.totalAccounts }} 个账号
              </span>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              管理多号 Cookie 鉴权、主备轮询与容量健康度
            </p>
          </div>
        </div>

        <!-- 右侧全局操作按钮组 -->
        <div class="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            class="btn-default text-xs h-9 px-3.5 font-medium flex items-center gap-1.5"
            :disabled="isRefreshing"
            @click="handleRefreshAll"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isRefreshing }" />
            <span>{{ isRefreshing ? '刷新中...' : '刷新容量与保活' }}</span>
          </button>

          <button
            v-if="accounts.some((a) => a.isActive === false || a.memberStatus === 'auth_failed')"
            type="button"
            class="btn-default text-xs h-9 px-3.5 font-medium text-amber-600 dark:text-amber-400 hover:text-red-600 border-amber-200 dark:border-amber-800/60 flex items-center gap-1.5"
            @click="handleRecycleAccounts"
          >
            <Trash2 class="w-3.5 h-3.5" />
            <span>清理失效账号</span>
          </button>

          <button
            v-if="!showForm"
            type="button"
            class="btn-primary text-xs h-9 px-4 font-semibold flex items-center gap-1.5 shadow-sm"
            @click="openInlineAddForm(true)"
          >
            <Plus class="w-4 h-4" />
            <span>绑定新账号</span>
          </button>
        </div>
      </div>

      <!-- 容量全局汇总统计指标条 -->
      <div v-if="stats.totalAccounts > 0" class="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="p-2.5 rounded-lg bg-gray-50/70 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/80">
          <div class="text-gray-400 dark:text-gray-500 text-[11px]">正常在线账号</div>
          <div class="text-sm font-bold text-gray-800 dark:text-gray-100 mt-0.5 flex items-center gap-1.5 font-mono">
            <span class="w-2 h-2 rounded-full bg-emerald-500" />
            <span>{{ stats.activeAccounts }} / {{ stats.totalAccounts }}</span>
          </div>
        </div>

        <div class="p-2.5 rounded-lg bg-gray-50/70 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/80">
          <div class="text-gray-400 dark:text-gray-500 text-[11px]">云空间总配额</div>
          <div class="text-sm font-bold text-gray-800 dark:text-gray-100 mt-0.5 font-mono">
            {{ stats.totalAllFormatted }}
          </div>
        </div>

        <div class="p-2.5 rounded-lg bg-gray-50/70 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/80">
          <div class="text-gray-400 dark:text-gray-500 text-[11px]">已占用容量</div>
          <div class="text-sm font-bold text-blue-600 dark:text-blue-400 mt-0.5 font-mono">
            {{ stats.usedAllFormatted }}
          </div>
        </div>

        <div class="p-2.5 rounded-lg bg-gray-50/70 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/80">
          <div class="text-gray-400 dark:text-gray-500 text-[11px]">整体利用率</div>
          <div class="text-sm font-bold text-gray-800 dark:text-gray-100 mt-0.5 font-mono flex items-center gap-2">
            <span>{{ stats.percent }}%</span>
            <div class="flex-1 bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
              <div
                class="bg-blue-600 dark:bg-blue-500 h-full rounded-full transition-all duration-300"
                :style="{ width: `${stats.percent}%` }"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 页面内联添加 / 编辑账号表单 (按规范包含统一说明区) ================= -->
    <div
      v-if="showForm"
      ref="formContainerRef"
      class="settings-card !p-5 border-2 border-blue-500/40 dark:border-blue-500/50 shadow-md bg-white dark:bg-[#111827] transition-all"
    >
      <!-- 表单头部 -->
      <div class="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <Edit3 v-if="isEditing" class="w-4 h-4" />
            <Plus v-else class="w-4 h-4" />
          </div>
          <h3 class="text-sm font-bold text-gray-900 dark:text-white">
            {{ isEditing ? `修改账号【${form.alias || form.username}】` : '绑定新 139 移动云盘账号' }}
          </h3>
        </div>

        <button
          v-if="accounts.length > 0"
          type="button"
          class="btn-default !h-8 !px-3 !text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-1 cursor-pointer"
          @click="closeInlineForm"
        >
          <ChevronUp class="w-3.5 h-3.5" />
          <span>收起表单</span>
        </button>
      </div>

      <!-- 统一集中说明区 (按设计规范第 4.2 节：紧邻卡片头部下方、表单输入项上方，全卡片仅此一处) -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs text-slate-600 dark:text-slate-300 space-y-2 mb-4">
        <div class="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <Info class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span>139 移动云盘多号绑定与 Cookie 获取指引</span>
        </div>
        <ul class="space-y-1.5 pl-1 leading-relaxed text-slate-600 dark:text-slate-300">
          <li>
            • <strong>适用场景与多号轮询</strong>：系统转存追更影视时优先使用<strong class="text-slate-800 dark:text-slate-100">默认账号（带金星标记）</strong>；当默认账号容量耗尽时支持智能切换备选账号，实现平滑多号分流转存。
          </li>
          <li>
            • <strong>Cookie 获取方法（电脑端快捷操作）</strong>：在电脑浏览器打开 <a href="https://yun.139.com" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5">yun.139.com <ExternalLink class="w-3 h-3 inline" /></a> 并扫码登录，按键盘 <code class="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">F12</code> 打开开发者工具，切换至“网络 (Network)”面板，刷新网页后点击任意请求，在右侧“标头 (Headers)”中完整复制包含 <code class="bg-white dark:bg-slate-900 px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200">authorization=</code> 的完整 Cookie 字符串即可。
          </li>
          <li>
            • <strong>保活与失效处理</strong>：本系统已内置全天候自动心跳保活；若遇运营商强制下线导致状态显示为 <span class="text-red-500 font-semibold">“认证失效”</span>，点击【更新凭据】粘贴新 Cookie 保存即可恢复，无需重新建任务。
          </li>
        </ul>
      </div>

      <!-- 表单主体 -->
      <form class="space-y-4 text-xs" @submit.prevent="handleSubmitAccount">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 手机号/用户名 -->
          <div>
            <label for="accUsername" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              139 移动云盘手机号 / 用户名 <span class="text-red-500">*</span>
            </label>
            <input
              id="accUsername"
              v-model="form.username"
              type="text"
              placeholder="例如: 13800138000"
              :readonly="isEditing"
              class="input-base text-xs font-mono"
              :class="{ '!bg-gray-50 dark:!bg-gray-800/80 !cursor-not-allowed': isEditing }"
            />
          </div>

          <!-- 账号备注别名 -->
          <div>
            <label for="accAlias" class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              账号备注别名 (选填)
            </label>
            <input
              id="accAlias"
              v-model="form.alias"
              type="text"
              placeholder="例如: 主力追更大号、备用影视库号"
              class="input-base text-xs"
            />
          </div>
        </div>

        <!-- Cookie 凭证输入区 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label for="accCookies" class="block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Cookie 凭据字符串 <span class="text-red-500">*</span>
            </label>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer flex items-center gap-1 text-[11px]"
                @click="handlePasteCookie"
              >
                <Copy class="w-3 h-3" />
                <span>从剪贴板粘贴</span>
              </button>
              <button
                type="button"
                class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer text-[11px]"
                @click="form.cookies = ''"
              >
                清空
              </button>
            </div>
          </div>
          <textarea
            id="accCookies"
            v-model="form.cookies"
            rows="3"
            placeholder="请在此粘贴从 yun.139.com 复制的 Cookie 完整内容（包含 authorization= 标识）"
            class="w-full p-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 text-xs font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <!-- 图形验证码 (仅当后端返回 NEED_CAPTCHA 时展示) -->
        <div v-if="captchaVisible" class="p-3 rounded-lg border border-amber-200 dark:border-amber-800/80 bg-amber-50/60 dark:bg-amber-950/30 space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-300">
            <AlertTriangle class="w-4 h-4 text-amber-600 shrink-0" />
            <span>检测到需要安全图片验证码</span>
          </div>
          <div class="flex items-center gap-3">
            <img
              v-if="captchaUrl"
              :src="captchaUrl"
              alt="验证码"
              class="h-9 rounded border border-gray-300 dark:border-gray-600 shrink-0 cursor-pointer"
              title="点击可刷新"
            />
            <input
              v-model="validateCode"
              type="text"
              placeholder="请输入图片中的验证码字符"
              class="input-base text-xs font-mono flex-1"
            />
          </div>
        </div>

        <!-- 底部提交操作栏 -->
        <div class="pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-2.5">
          <button
            v-if="accounts.length > 0"
            type="button"
            class="btn-default text-xs h-9 px-4"
            @click="closeInlineForm"
          >
            取消
          </button>
          <button
            type="submit"
            class="btn-primary text-xs h-9 px-5 font-semibold flex items-center gap-1.5 shadow-sm"
            :disabled="submitting"
          >
            <RefreshCw v-if="submitting" class="w-3.5 h-3.5 animate-spin" />
            <span>{{ submitting ? '验证保存中...' : (isEditing ? '保存修改并更新凭证' : '立即保存并绑定账号') }}</span>
          </button>
        </div>
      </form>
    </div>

    <!-- ================= 账号卡片网格列表 ================= -->
    <div v-if="loading && accounts.length === 0" class="py-16 text-center text-gray-400 dark:text-gray-500 text-xs">
      <RefreshCw class="w-7 h-7 mx-auto mb-2 animate-spin text-blue-500" />
      <span>正在加载移动云盘账号信息...</span>
    </div>

    <!-- 账号网格列表 (当已有账号时呈现) -->
    <div v-else-if="accounts.length > 0" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div
        v-for="account in accounts"
        :key="account.id"
        class="settings-card !p-4 flex flex-col justify-between transition-all hover:shadow-md relative overflow-hidden"
        :class="{
          'ring-2 ring-blue-500/30 dark:ring-blue-400/20 !border-blue-300 dark:!border-blue-700': account.isDefault,
          'opacity-80 !border-red-300 dark:!border-red-900/60': account.memberStatus === 'auth_failed' || account.isActive === false,
        }"
      >
        <!-- 默认账号金标饰条（支持点击取消） -->
        <button
          v-if="account.isDefault"
          type="button"
          class="absolute top-0 right-0 bg-gradient-to-l from-amber-500 to-amber-400 hover:from-amber-600 hover:to-amber-500 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-bl-lg shadow-xs flex items-center gap-1 cursor-pointer transition-all"
          title="点击取消默认账号"
          @click="handleCancelDefault(account)"
        >
          <Star class="w-3 h-3 fill-white" />
          <span>默认账号</span>
        </button>

        <div>
          <!-- 卡片头部信息 -->
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <!-- 在线/失效状态点 -->
              <div class="relative shrink-0">
                <div class="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700/60 p-1 flex items-center justify-center overflow-hidden shadow-2xs">
                  <img
                    :src="logo139"
                    alt="139 移动云盘"
                    class="w-full h-full object-contain"
                  />
                </div>
                <span
                  class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-[#111827]"
                  :class="account.memberStatus === 'auth_failed' || account.isActive === false ? 'bg-red-500' : 'bg-emerald-500'"
                  :title="account.memberStatus === 'auth_failed' ? '认证失效' : '在线正常'"
                />
              </div>

              <!-- 账号名称与原位内联修改别名 -->
              <div class="min-w-0 flex-1">
                <!-- 原位别名编辑态 -->
                <div v-if="editingAliasAccountId === account.id" class="flex items-center gap-1">
                  <input
                    v-model="inlineAliasValue"
                    type="text"
                    placeholder="输入新备注"
                    class="input-base !h-7 !text-xs !py-0 !px-2 flex-1"
                    @keyup.enter="saveInlineAlias(account)"
                  />
                  <button
                    type="button"
                    class="p-1 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-400 cursor-pointer"
                    title="保存"
                    :disabled="savingAlias"
                    @click="saveInlineAlias(account)"
                  >
                    <Check class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    class="p-1 rounded text-gray-400 hover:text-gray-600 cursor-pointer"
                    title="取消"
                    @click="cancelInlineAlias"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>

                <!-- 正常展示态 -->
                <div v-else class="flex items-center gap-1.5">
                  <span class="text-sm font-bold text-gray-900 dark:text-white truncate">
                    {{ account.alias || account.username }}
                  </span>
                  <button
                    type="button"
                    class="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
                    title="点击修改备注别名"
                    @click="startInlineEditAlias(account)"
                  >
                    <Edit3 class="w-3 h-3" />
                  </button>
                </div>

                <div class="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 font-mono">
                  <span v-if="account.alias">{{ account.username }}</span>
                  <span v-else class="text-gray-400 font-sans">139 移动云盘</span>
                </div>
              </div>
            </div>

            <!-- 会员等级标识徽章 -->
            <div v-if="!account.isDefault" class="shrink-0">
              <span
                class="px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1"
                :class="{
                  'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800': account.memberStatusText?.includes('钻石') || account.memberStatusText?.includes('白金'),
                  'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800': account.memberStatusText?.includes('黄金') || account.memberStatusText?.includes('VIP'),
                  'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700': !account.memberStatusText || account.memberStatusText === '普通' || account.memberStatusText === '-',
                  'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800': account.memberStatus === 'auth_failed',
                }"
              >
                <Crown v-if="account.memberStatusText && account.memberStatusText !== '普通' && account.memberStatusText !== '认证失效'" class="w-3 h-3" />
                <span>{{ account.memberStatusText || '普通' }}</span>
              </span>
            </div>
          </div>

          <!-- 容量监控进度条（139 移动云盘综合云空间与细分） -->
          <div class="space-y-3 py-2 border-t border-b border-gray-100 dark:border-gray-800 my-2">
            <!-- 综合云空间总计 (当存在家庭云时，优先展示对齐官方的“云空间”总计) -->
            <div v-if="account.capacity?.familyCapacityInfo && account.capacity.familyCapacityInfo.totalSize > 0">
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-gray-700 dark:text-gray-300 font-semibold flex items-center gap-1">
                  <Cloud class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  <span>云空间 (综合总计)</span>
                </span>
                <span class="font-mono text-gray-900 dark:text-gray-100 font-bold">
                  {{ formatBytes((account.capacity.cloudCapacityInfo?.usedSize || 0) + account.capacity.familyCapacityInfo.usedSize) }} / {{ formatBytes((account.capacity.cloudCapacityInfo?.totalSize || 0) + account.capacity.familyCapacityInfo.totalSize) }}
                </span>
              </div>
              <div class="w-full bg-gray-100 dark:bg-gray-800 h-2.5 rounded-full overflow-hidden">
                <div
                  class="bg-blue-600 dark:bg-blue-500 h-full rounded-full transition-all duration-300"
                  :style="{
                    width: `${Math.min(100, Math.round((((account.capacity.cloudCapacityInfo?.usedSize || 0) + account.capacity.familyCapacityInfo.usedSize) / Math.max(1, (account.capacity.cloudCapacityInfo?.totalSize || 0) + account.capacity.familyCapacityInfo.totalSize)) * 100))}%`,
                  }"
                />
              </div>
            </div>

            <!-- 个人云空间 -->
            <div>
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                  <Database class="w-3.5 h-3.5 text-blue-500" />
                  <span>{{ account.capacity?.familyCapacityInfo && account.capacity.familyCapacityInfo.totalSize > 0 ? '个人云细分' : '个人云空间' }}</span>
                </span>
                <span class="font-mono text-gray-800 dark:text-gray-200 font-medium">
                  <template v-if="account.memberStatus === 'auth_failed'">
                    <span class="text-red-500">Cookie 失效</span>
                  </template>
                  <template v-else-if="account.capacity?.cloudCapacityInfo">
                    {{ formatBytes(account.capacity.cloudCapacityInfo.usedSize) }} / {{ formatBytes(account.capacity.cloudCapacityInfo.totalSize) }}
                  </template>
                  <template v-else>
                    <span class="text-gray-400">未知容量</span>
                  </template>
                </span>
              </div>

              <!-- 个人云进度条 -->
              <div class="w-full bg-gray-100 dark:bg-gray-800 h-2 rounded-full overflow-hidden">
                <div
                  v-if="account.capacity?.cloudCapacityInfo && account.capacity.cloudCapacityInfo.totalSize > 0"
                  class="h-full rounded-full transition-all duration-300"
                  :class="{
                    'bg-blue-600 dark:bg-blue-500': (account.capacity.cloudCapacityInfo.usedSize / account.capacity.cloudCapacityInfo.totalSize) < 0.85,
                    'bg-amber-500': (account.capacity.cloudCapacityInfo.usedSize / account.capacity.cloudCapacityInfo.totalSize) >= 0.85 && (account.capacity.cloudCapacityInfo.usedSize / account.capacity.cloudCapacityInfo.totalSize) < 0.95,
                    'bg-red-500': (account.capacity.cloudCapacityInfo.usedSize / account.capacity.cloudCapacityInfo.totalSize) >= 0.95,
                  }"
                  :style="{
                    width: `${Math.min(100, Math.round((account.capacity.cloudCapacityInfo.usedSize / account.capacity.cloudCapacityInfo.totalSize) * 100))}%`,
                  }"
                />
              </div>
            </div>

            <!-- 家庭云空间 (若存在家庭云配额) -->
            <div v-if="account.capacity?.familyCapacityInfo && account.capacity.familyCapacityInfo.totalSize > 0">
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                  <Users class="w-3.5 h-3.5 text-indigo-500" />
                  <span>家庭云细分</span>
                </span>
                <span class="font-mono text-gray-800 dark:text-gray-200 font-medium">
                  {{ formatBytes(account.capacity.familyCapacityInfo.usedSize) }} / {{ formatBytes(account.capacity.familyCapacityInfo.totalSize) }}
                </span>
              </div>
              <div class="w-full bg-gray-100 dark:bg-gray-800 h-1.5 rounded-full overflow-hidden">
                <div
                  class="bg-indigo-500 h-full rounded-full transition-all duration-300"
                  :style="{
                    width: `${Math.min(100, Math.round((account.capacity.familyCapacityInfo.usedSize / account.capacity.familyCapacityInfo.totalSize) * 100))}%`,
                  }"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片底部操作栏（原位无弹窗） -->
        <div class="pt-2 flex items-center justify-between gap-2 text-xs">
          <div>
            <!-- 设为默认 / 取消默认操作 -->
            <button
              v-if="!account.isDefault"
              type="button"
              class="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 font-medium flex items-center gap-1 cursor-pointer transition-colors"
              title="将此账号设为默认转存账号"
              @click="handleSetDefault(account)"
            >
              <Star class="w-3.5 h-3.5" />
              <span>设为默认</span>
            </button>
            <button
              v-else
              type="button"
              class="text-amber-600 dark:text-amber-400 hover:text-red-500 dark:hover:text-red-400 font-semibold flex items-center gap-1 cursor-pointer transition-colors group"
              title="点击取消默认账号"
              @click="handleCancelDefault(account)"
            >
              <CheckCircle2 class="w-3.5 h-3.5" />
              <span>当前默认</span>
              <span class="text-[10px] text-gray-400 dark:text-gray-500 group-hover:text-red-500 dark:group-hover:text-red-400 font-normal underline ml-0.5">点击取消</span>
            </button>
          </div>

          <!-- 原位操作或删除确认胶囊 -->
          <div class="flex items-center gap-1.5">
            <!-- 原位删除确认胶囊 (零弹窗) -->
            <div v-if="deletingAccountId === account.id" class="flex items-center gap-1 p-0.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900">
              <span class="text-[11px] text-red-600 dark:text-red-400 px-1 font-medium">确认删除?</span>
              <button
                type="button"
                class="px-2 py-0.5 rounded bg-red-600 text-white text-[11px] font-bold hover:bg-red-700 cursor-pointer"
                @click="confirmInlineDelete(account)"
              >
                确定
              </button>
              <button
                type="button"
                class="px-1.5 py-0.5 text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer"
                @click="deletingAccountId = null"
              >
                取消
              </button>
            </div>

            <!-- 正常操作按钮 -->
            <template v-else>
              <button
                type="button"
                class="btn-default !h-7 !px-2.5 !text-xs font-medium"
                @click="openInlineEditForm(account)"
              >
                <Edit3 class="w-3 h-3" />
                <span>{{ account.memberStatus === 'auth_failed' ? '更新凭据' : '配置' }}</span>
              </button>

              <button
                type="button"
                class="p-1.5 rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                title="删除此账号"
                @click="promptInlineDelete(account)"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>

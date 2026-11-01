<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { accountApi } from '../api/account';
import { ElMessage } from 'element-plus';
import { Folder, Key, WarningFilled, User } from '@element-plus/icons-vue';
import type { AccountSwitcherItem } from './accountSwitcher';

interface FolderNode {
  id: string;
  name: string;
  isLeaf?: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  accountId: number | string;
  title?: string;
  accounts?: AccountSwitcherItem[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'update:accountId', value: number | string): void;
  (e: 'select', folder: { id: string; name: string }): void;
}>();

const router = useRouter();
const visible = ref(props.modelValue);
const activeAccountId = ref<number | string>(props.accountId || '');
const selectedNode = ref<FolderNode | null>(null);
const selectedFullPath = ref<string>('/');
const authFailed = ref(false);
const authErrorMessage = ref('');
const treeKey = ref(0);

watch(
  () => props.modelValue,
  (val) => {
    visible.value = val;
    if (val) {
      selectedNode.value = null;
      selectedFullPath.value = '/';
      activeAccountId.value = props.accountId || '';
      if (!activeAccountId.value) {
        authFailed.value = true;
        authErrorMessage.value = '未检测到已登录的 139 移动云盘账号，请先完成扫码绑定。';
      } else {
        authFailed.value = false;
        authErrorMessage.value = '';
        treeKey.value++;
      }
    }
  }
);

watch(
  () => props.accountId,
  (val) => {
    activeAccountId.value = val || '';
    if (!val) {
      authFailed.value = true;
      authErrorMessage.value = '未检测到已登录的 139 移动云盘账号，请先完成扫码绑定。';
    } else {
      authFailed.value = false;
      authErrorMessage.value = '';
      treeKey.value++;
    }
  }
);

watch(visible, (val) => {
  emit('update:modelValue', val);
});

function getAccountDisplayName(acc: AccountSwitcherItem): string {
  if (!acc) return '未命名账号';
  return acc.accountName || acc.username || acc.phone || `账号 ${acc.id}`;
}

function handleAccountChange(newId: number | string) {
  activeAccountId.value = newId;
  emit('update:accountId', newId);
  selectedNode.value = null;
  selectedFullPath.value = '/';
  authFailed.value = false;
  authErrorMessage.value = '';
  treeKey.value++;
}

function isAuthFailure(err: any): boolean {
  if (!err) return false;
  if (err.code === 'AUTH_FAILED') return true;
  const msg = String(err.message || err.error || '').toLowerCase();
  return /04000005|05050006|认证失败|登录凭证已失效|未登录|未找到有效/.test(msg);
}

async function loadNode(node: any, resolve: (data: FolderNode[]) => void) {
  const currentId = activeAccountId.value;
  if (!currentId) {
    authFailed.value = true;
    authErrorMessage.value = '未检测到已登录的 139 移动云盘账号，请先完成扫码绑定。';
    resolve([]);
    return;
  }

  // 顶层直接呈现虚拟根节点
  if (node.level === 0) {
    resolve([
      {
        id: '-11',
        name: '根目录 (/)',
        isLeaf: false,
      },
    ]);
    return;
  }

  const parentId = node.data?.id === '-11' ? '-11' : (node.data?.id || '-11');
  try {
    const files = await accountApi.getFolders(currentId, parentId);
    const folders = (files || [])
      .filter((item: any) => item.isFolder !== false && !item.isFile)
      .map((item: any) => ({
        id: String(item.id || item.fileId || item.catalogID || item.folderID),
        name: item.name || item.catalogName || item.folderName || '未命名文件夹',
        isLeaf: false,
      }));

    authFailed.value = false;
    authErrorMessage.value = '';
    resolve(folders);
  } catch (err: any) {
    if (isAuthFailure(err)) {
      authFailed.value = true;
      authErrorMessage.value = err.message || '云盘登录凭证已失效，请重新扫码登录。';
    } else {
      ElMessage.error(`加载目录失败: ${err.message || '未知错误'}`);
    }
    resolve([]);
  }
}

function getFullPath(node: any): string {
  if (!node || node.data?.id === '-11') return '/';
  const parts: string[] = [];
  let curr = node;
  while (curr && curr.level > 0) {
    if (curr.data?.id !== '-11' && curr.data?.name && curr.data.name !== '根目录 (/)') {
      parts.unshift(curr.data.name);
    }
    curr = curr.parent;
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

function handleNodeClick(data: FolderNode, node: any) {
  selectedNode.value = data;
  selectedFullPath.value = getFullPath(node);
}

function handleConfirm() {
  if (authFailed.value) {
    ElMessage.warning('当前云盘登录凭证失效，无法选择目录');
    return;
  }
  if (!selectedNode.value) {
    ElMessage.warning('请选择一个目录');
    return;
  }
  emit('select', { id: selectedNode.value.id, name: selectedFullPath.value });
  visible.value = false;
}

function handleGoToAccounts() {
  visible.value = false;
  router.push('/accounts');
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title || '选择云盘目标目录'"
    width="540px"
    destroy-on-close
    append-to-body
  >
    <!-- 多账号切换条 (仅当存在多个 139 账号时呈现) -->
    <div v-if="props.accounts && props.accounts.length > 1" class="folder-account-bar">
      <div class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 font-medium shrink-0">
        <el-icon class="text-indigo-600 dark:text-indigo-400"><User /></el-icon>
        <span>选择云盘账号:</span>
      </div>
      <el-select
        v-model="activeAccountId"
        size="small"
        class="folder-account-select flex-1"
        placeholder="请选择云盘账号"
        @change="handleAccountChange"
      >
        <el-option
          v-for="acc in props.accounts"
          :key="acc.id"
          :label="getAccountDisplayName(acc)"
          :value="acc.id"
        >
          <div class="flex items-center justify-between w-full text-xs">
            <span class="font-medium text-slate-800 dark:text-slate-200">{{ getAccountDisplayName(acc) }}</span>
            <div class="flex items-center gap-1">
              <span v-if="acc.isDefault" class="px-1.5 py-0.5 rounded text-[10px] bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">默认</span>
              <span v-if="acc.isActive === false" class="px-1.5 py-0.5 rounded text-[10px] bg-rose-50 text-rose-600 border border-rose-200">未激活</span>
            </div>
          </div>
        </el-option>
      </el-select>
    </div>

    <div class="tree-container">
      <!-- 凭证失效 / 未登录全流程友好引导卡片 -->
      <div v-if="authFailed" class="auth-guard-panel">
        <div class="auth-icon-box">
          <el-icon class="auth-icon"><Key /></el-icon>
        </div>
        <div class="auth-guard-title">云盘登录凭据未就绪或已失效</div>
        <p class="auth-guard-desc">
          {{ authErrorMessage || '当前 139 移动云盘账号尚未完成登录或凭据已过期，系统已开启防空拦截保护。' }}
        </p>
        <div class="auth-action-wrap">
          <el-button type="primary" size="default" class="auth-login-btn" @click="handleGoToAccounts">
            前往【云盘账号】重新扫码登录
          </el-button>
        </div>
      </div>

      <!-- 正常目录树展示 -->
      <el-tree
        v-else
        :key="treeKey"
        lazy
        :load="loadNode"
        :props="{ label: 'name', isLeaf: 'isLeaf' }"
        node-key="id"
        highlight-current
        @node-click="handleNodeClick"
      >
        <template #default="{ node }">
          <span class="custom-tree-node">
            <el-icon><Folder /></el-icon>
            <span class="node-label">{{ node.label }}</span>
          </span>
        </template>
      </el-tree>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <span v-if="!authFailed && selectedNode" class="selected-text">
          已选: <strong>{{ selectedFullPath }}</strong>
        </span>
        <span v-else-if="authFailed" class="auth-alert-text">
          <el-icon class="mr-1 text-amber-500"><WarningFilled /></el-icon>
          未登录状态不可选
        </span>
        <span v-else class="text-xs text-gray-400">点击目录项进行选取</span>
        <div class="footer-btns">
          <el-button @click="visible = false">取消</el-button>
          <el-button
            type="primary"
            :disabled="authFailed || !selectedNode"
            @click="handleConfirm"
          >
            确定
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.folder-account-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background-color: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
}

.tree-container {
  min-height: 240px;
  max-height: 380px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background-color: var(--el-fill-color-blank);
}

.auth-guard-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 20px;
  text-align: center;
}

.auth-icon-box {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: rgba(234, 88, 12, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}

.auth-icon {
  font-size: 26px;
  color: #ea580c;
}

.auth-guard-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
}

.auth-guard-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  max-width: 380px;
  margin: 0 auto 20px auto;
}

.auth-action-wrap {
  display: flex;
  gap: 12px;
}

.auth-login-btn {
  font-weight: 500;
  border-radius: 6px;
}

.custom-tree-node {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.node-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.selected-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.auth-alert-text {
  font-size: 12px;
  color: #d97706;
  display: inline-flex;
  align-items: center;
}

.footer-btns {
  display: flex;
  gap: 8px;
}
</style>

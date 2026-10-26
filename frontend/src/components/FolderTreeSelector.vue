<script setup lang="ts">
import { ref, watch } from 'vue';
import { accountApi } from '../api/account';
import { ElMessage } from 'element-plus';
import { Folder } from '@element-plus/icons-vue';

interface FolderNode {
  id: string;
  name: string;
  isLeaf?: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  accountId: number | string;
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'select', folder: { id: string; name: string }): void;
}>();

const visible = ref(props.modelValue);
const selectedNode = ref<FolderNode | null>(null);

watch(
  () => props.modelValue,
  (val) => {
    visible.value = val;
  }
);

watch(visible, (val) => {
  emit('update:modelValue', val);
});

async function loadNode(node: any, resolve: (data: FolderNode[]) => void) {
  if (!props.accountId) {
    resolve([]);
    return;
  }

  // 顶层直接呈现虚拟根节点，展开根节点时再懒加载实际子目录
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
    const files = await accountApi.getFolders(props.accountId, parentId);
    const folders = (files || [])
      .filter((item: any) => item.isFolder !== false && !item.isFile)
      .map((item: any) => ({
        id: String(item.id || item.fileId || item.catalogID || item.folderID),
        name: item.name || item.catalogName || item.folderName || '未命名文件夹',
        isLeaf: false,
      }));

    resolve(folders);
  } catch (err: any) {
    ElMessage.error(`加载目录失败: ${err.message || '未知错误'}`);
    resolve([]);
  }
}

const selectedFullPath = ref<string>('/');

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
  if (!selectedNode.value) {
    ElMessage.warning('请选择一个目录');
    return;
  }
  emit('select', { id: selectedNode.value.id, name: selectedFullPath.value });
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title || '选择云盘目标目录'"
    width="520px"
    destroy-on-close
    append-to-body
  >
    <div class="tree-container">
      <el-tree
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
        <span v-if="selectedNode" class="selected-text">
          已选: <strong>{{ selectedFullPath }}</strong>
        </span>
        <div>
          <el-button @click="visible = false">取消</el-button>
          <el-button type="primary" :disabled="!selectedNode" @click="handleConfirm">
            确定
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.tree-container {
  max-height: 380px;
  overflow-y: auto;
  padding: 8px 0;
  border: 1px solid var(--el-border-color-lighter);
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
</style>

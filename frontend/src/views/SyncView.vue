
<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  RefreshCw,
  ArrowRightLeft,
  ArrowRight,
  FileCode2,
  Share2,
  Copy,
  Download,
  CloudDownload,
  Upload,
  Folder,
  FolderPlus,
  FolderTree,
  SlidersHorizontal,
  CheckCircle2,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Check,
  Play,
  Trash2,
  Eye,
  EyeOff,
  Search,
  ShieldCheck,
  Layers,
  Save,
  FileVideo,
  Tv,
  Info,
  ExternalLink,
  HardDrive,
} from 'lucide-vue-next';
import { accountApi, type AccountItem } from '../api/account';
import {
  syncApi,
  type SyncConfigData,
  type SyncScanFileItem,
  type SyncScanResult,
  type SyncExecuteResult,
  type RapidExportResult,
  type RapidImportResult,
  type Pan123FolderItem,
  type Pan123OfflineTask,
  type OfflinePushResult,
} from '../api/sync';
import FolderTreeSelector from '../components/FolderTreeSelector.vue';

const route = useRoute();
const router = useRouter();

// ================= 主选项卡切换 =================
const activeTab = ref<'cross' | 'rapid' | 'offline' | 'settings'>('cross');

function syncTabFromRoute() {
  const t = route.query.tab as string;
  if (t === 'cross' || t === 'rapid' || t === 'offline' || t === 'settings') {
    activeTab.value = t;
  }
}

function switchTab(t: 'cross' | 'rapid' | 'offline' | 'settings') {
  activeTab.value = t;
  router.replace({
    path: '/sync',
    query: t !== 'cross' ? { tab: t } : undefined,
  });
}

watch(
  () => route.query.tab,
  () => syncTabFromRoute()
);

// ================= 全局状态与账号 =================
const isLoading = ref(true);
const isSaving = ref(false);
const accounts = ref<AccountItem[]>([]);

// 全局配置响应式数据
const form = reactive<SyncConfigData>({
  pan123: {
    username: '',
    password: '',
    hasPassword: false,
    targetDirId: 0,
    targetDirPath: '/离线下载',
  },
  sync: {
    existSkip: true,
    preservePath: true,
    trashSource: false,
  },
});

// 加载账号与系统配置
async function loadAccounts() {
  try {
    const list = await accountApi.getAccounts();
    accounts.value = (list || []).filter((a) => a.accountType === 'cloud139');
    if (accounts.value.length > 0) {
      if (!crossSourceAccountId.value) crossSourceAccountId.value = accounts.value[0].id;
      if (!crossTargetAccountId.value) {
        crossTargetAccountId.value = accounts.value.length > 1 ? accounts.value[1].id : accounts.value[0].id;
      }
      if (!rapidExportAccountId.value) rapidExportAccountId.value = accounts.value[0].id;
      if (!rapidImportAccountId.value) rapidImportAccountId.value = accounts.value[0].id;
      if (!offlineSourceAccountId.value) offlineSourceAccountId.value = accounts.value[0].id;
    }
  } catch (err: any) {
    ElMessage.error(err.message || '加载云盘账号失败');
  }
}

async function loadConfig() {
  try {
    isLoading.value = true;
    const res = await syncApi.getConfig();
    if (res) {
      if (res.pan123) {
        form.pan123.username = res.pan123.username || '';
        form.pan123.hasPassword = Boolean(res.pan123.hasPassword);
        form.pan123.targetDirId = res.pan123.targetDirId ?? 0;
        form.pan123.targetDirPath = res.pan123.targetDirPath || '/离线下载';
      }
      if (res.sync) {
        form.sync.existSkip = res.sync.existSkip !== false;
        form.sync.preservePath = res.sync.preservePath !== false;
        form.sync.trashSource = Boolean(res.sync.trashSource);
        crossExistSkip.value = form.sync.existSkip;
        crossPreservePath.value = form.sync.preservePath;
        crossTrashSource.value = form.sync.trashSource;
      }
    }
  } catch (err: any) {
    ElMessage.error(err.message || '加载资产同步配置失败');
  } finally {
    isLoading.value = false;
  }
}

async function handleSaveConfig() {
  if (isSaving.value) return;
  try {
    isSaving.value = true;
    const payload: any = {
      sync: {
        existSkip: form.sync.existSkip,
        preservePath: form.sync.preservePath,
        trashSource: form.sync.trashSource,
      },
      pan123: {
        username: form.pan123.username.trim(),
        targetDirId: form.pan123.targetDirId,
        targetDirPath: form.pan123.targetDirPath.trim(),
      },
    };
    if (form.pan123.password && form.pan123.password.trim()) {
      payload.pan123.password = form.pan123.password.trim();
    }
    const res = await syncApi.saveConfig(payload);
    ElMessage.success(res?.message || '资产同步配置已保存');
    if (payload.pan123.password) {
      form.pan123.hasPassword = true;
      form.pan123.password = '';
    }
  } catch (err: any) {
    ElMessage.error(err.message || '保存配置失败');
  } finally {
    isSaving.value = false;
  }
}

// 顶部 Header 保存按钮事件监听
function onHeaderSaveClick() {
  handleSaveConfig();
}

// ================= Tab 1: 139 账号间跨号秒传 =================
const crossSourceAccountId = ref<number | string>('');
const crossSourceFolderId = ref<string>('/');
const crossSourceFolderName = ref<string>('根目录');

const crossTargetAccountId = ref<number | string>('');
const crossTargetFolderId = ref<string>('/');
const crossTargetFolderName = ref<string>('根目录');

const crossExistSkip = ref(true);
const crossPreservePath = ref(true);
const crossTrashSource = ref(false);
const crossMediaOnly = ref(true);

const isScanning = ref(false);
const scanResult = ref<SyncScanResult | null>(null);
const selectedFileIds = ref<Set<string>>(new Set());
const searchKeyword = ref('');

const isExecuting = ref(false);
const executeResult = ref<SyncExecuteResult | null>(null);
const executeFilter = ref<'all' | 'success' | 'exist' | 'failed'>('all');

const filteredScannedFiles = computed(() => {
  if (!scanResult.value?.files) return [];
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return scanResult.value.files;
  return scanResult.value.files.filter((f) =>
    f.name.toLowerCase().includes(kw) ||
    f.relativePath.toLowerCase().includes(kw) ||
    f.contentHash.toLowerCase().includes(kw)
  );
});

const isAllSelected = computed(() => {
  const list = filteredScannedFiles.value;
  if (list.length === 0) return false;
  return list.every((f) => selectedFileIds.value.has(f.fileId));
});

function toggleSelectAll() {
  const list = filteredScannedFiles.value;
  if (isAllSelected.value) {
    list.forEach((f) => selectedFileIds.value.delete(f.fileId));
  } else {
    list.forEach((f) => selectedFileIds.value.add(f.fileId));
  }
}

function toggleFileSelect(fileId: string) {
  if (selectedFileIds.value.has(fileId)) {
    selectedFileIds.value.delete(fileId);
  } else {
    selectedFileIds.value.add(fileId);
  }
}

async function handleScanSource() {
  if (!crossSourceAccountId.value) {
    ElMessage.warning('请先选择源 139 云盘账号');
    return;
  }
  try {
    isScanning.value = true;
    scanResult.value = null;
    selectedFileIds.value.clear();
    executeResult.value = null;

    const res = await syncApi.scanCrossAccount({
      accountId: crossSourceAccountId.value,
      folderId: crossSourceFolderId.value,
      mediaOnly: crossMediaOnly.value,
    });
    scanResult.value = res;
    // 默认全选扫描出的文件
    (res.files || []).forEach((f) => selectedFileIds.value.add(f.fileId));
    ElMessage.success(`扫描完成，发现 ${res.totalFiles} 个待同步文件（共 ${res.totalSizeFormatted}）`);
  } catch (err: any) {
    ElMessage.error(err.message || '扫描源目录失败');
  } finally {
    isScanning.value = false;
  }
}

async function handleExecuteSync() {
  if (!crossSourceAccountId.value || !crossTargetAccountId.value) {
    ElMessage.warning('请选择源账号与目标账号');
    return;
  }
  if (crossSourceAccountId.value === crossTargetAccountId.value && crossSourceFolderId.value === crossTargetFolderId.value) {
    ElMessage.warning('源账号与目标账号同账号同目录，无需秒传转存');
    return;
  }
  if (!scanResult.value || scanResult.value.files.length === 0) {
    ElMessage.warning('请先扫描源目录获取待同步资产清单');
    return;
  }
  const chosenFiles = scanResult.value.files.filter((f) => selectedFileIds.value.has(f.fileId));
  if (chosenFiles.length === 0) {
    ElMessage.warning('请至少勾选一个待同步文件');
    return;
  }

  if (crossTrashSource.value) {
    try {
      await ElMessageBox.confirm(
        '您已开启「秒传成功后安全移入源账号回收站」，已成功秒传的文件将被移入源账号 139 回收站（0 物理硬删）。确定执行吗？',
        '安全风险提示',
        {
          confirmButtonText: '确定执行',
          cancelButtonText: '取消',
          type: 'warning',
        }
      );
    } catch {
      return;
    }
  }

  try {
    isExecuting.value = true;
    executeResult.value = null;

    const res = await syncApi.executeCrossAccount({
      sourceAccountId: crossSourceAccountId.value,
      targetAccountId: crossTargetAccountId.value,
      files: chosenFiles.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        size: f.size,
        contentHash: f.contentHash,
        relativePath: f.relativePath,
      })),
      targetParentId: crossTargetFolderId.value,
      existSkip: crossExistSkip.value,
      preservePath: crossPreservePath.value,
      trashSource: crossTrashSource.value,
    });

    executeResult.value = res;
    ElMessage.success(`跨号秒传完成！成功: ${res.successCount}，已存在跳过: ${res.existCount}，失败: ${res.failCount}`);
  } catch (err: any) {
    ElMessage.error(err.message || '执行跨号秒传失败');
  } finally {
    isExecuting.value = false;
  }
}

const filteredExecuteDetails = computed(() => {
  if (!executeResult.value?.details) return [];
  if (executeFilter.value === 'all') return executeResult.value.details;
  return executeResult.value.details.filter((d) => d.status === executeFilter.value);
});

// ================= Tab 2: 秒传特征码互转 =================
const rapidTab = ref<'export' | 'import'>('export');

// 导出
const rapidExportAccountId = ref<number | string>('');
const rapidExportFolderId = ref<string>('/');
const rapidExportFolderName = ref<string>('根目录');
const isExporting = ref(false);
const exportResult = ref<RapidExportResult | null>(null);
const isCopied = ref(false);

async function handleExportLinks() {
  if (!rapidExportAccountId.value) {
    ElMessage.warning('请选择 139 云盘账号');
    return;
  }
  try {
    isExporting.value = true;
    exportResult.value = null;
    const res = await syncApi.exportRapidLinks({
      accountId: rapidExportAccountId.value,
      folderId: rapidExportFolderId.value,
    });
    exportResult.value = res;
    ElMessage.success(`秒传码生成成功！共提取 ${res.validLinkCount} 条有效秒传特征码`);
  } catch (err: any) {
    ElMessage.error(err.message || '生成秒传特征码失败');
  } finally {
    isExporting.value = false;
  }
}

function copyExportText() {
  if (!exportResult.value?.text) return;
  navigator.clipboard.writeText(exportResult.value.text).then(() => {
    isCopied.value = true;
    ElMessage.success('已将全部秒传码复制至剪贴板');
    setTimeout(() => {
      isCopied.value = false;
    }, 2000);
  });
}

function downloadExportText() {
  if (!exportResult.value?.text) return;
  const blob = new Blob([exportResult.value.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `139_rapid_links_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 导入
const rapidImportAccountId = ref<number | string>('');
const rapidImportFolderId = ref<string>('/');
const rapidImportFolderName = ref<string>('根目录');
const importRawText = ref('');
const isImporting = ref(false);
const importResult = ref<RapidImportResult | null>(null);

function fillImportExample() {
  importRawText.value =
`流浪地球2.2023.2160p.WEB-DL.H265.DDP5.1.mkv#15829182390#3c5a6b8e1f0d4c2b9a8e7f6d5c4b3a2e1f0d4c2b9a8e7f6d5c4b3a2e1f0d4c2b
奥本海默.Oppenheimer.2023.1080p.BluRay.x264.mkv#8429182310#a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
星际穿越.Interstellar.2014.2160p.UHD.Remux.mkv#52182910239#9f8e7d6c5b4a3a2b1c0d1e2f3a4b5c6d7e8f901a2b3c4d5e6f7a8b9c0d1e2f3a`;
  ElMessage.info('已填入标准「文件名#大小#SHA256」测试示例');
}

async function handleImportLinks() {
  if (!rapidImportAccountId.value) {
    ElMessage.warning('请选择落地 139 云盘账号');
    return;
  }
  if (!importRawText.value.trim()) {
    ElMessage.warning('请输入待秒传的特征码清单');
    return;
  }

  try {
    isImporting.value = true;
    importResult.value = null;
    const res = await syncApi.importRapidLinks({
      accountId: rapidImportAccountId.value,
      rawText: importRawText.value.trim(),
      targetFolderId: rapidImportFolderId.value,
    });
    importResult.value = res;
    ElMessage.success(`秒传导入完成！成功: ${res.successCount}，已存在: ${res.existCount}，失败: ${res.failCount}`);
  } catch (err: any) {
    ElMessage.error(err.message || '秒传特征码导入失败');
  } finally {
    isImporting.value = false;
  }
}

// ================= Tab 3: 123 网盘离线中枢 =================
const offlineSourceAccountId = ref<number | string>('');
const offlineSourceFolderId = ref<string>('/');
const offlineSourceFolderName = ref<string>('根目录');
const offlineScanResult = ref<SyncScanResult | null>(null);
const isScanningOffline = ref(false);
const selectedOfflineFileIds = ref<Set<string>>(new Set());

const pan123Folders = ref<Pan123FolderItem[]>([]);
const selectedPan123DirId = ref<number | string>(0);
const selectedPan123DirName = ref<string>('/ (根目录)');
const isLoading123Folders = ref(false);

const isPushingOffline = ref(false);
const pushOfflineResult = ref<OfflinePushResult | null>(null);

const pan123Tasks = ref<Pan123OfflineTask[]>([]);
const pan123TasksTotal = ref(0);
const isLoadingTasks = ref(false);
const taskFilter = ref<'all' | 'downloading' | 'completed' | 'failed' | 'waiting'>('all');

async function handleScanOfflineSource() {
  if (!offlineSourceAccountId.value) {
    ElMessage.warning('请选择源 139 云盘账号');
    return;
  }
  try {
    isScanningOffline.value = true;
    offlineScanResult.value = null;
    selectedOfflineFileIds.value.clear();
    pushOfflineResult.value = null;

    const res = await syncApi.scanCrossAccount({
      accountId: offlineSourceAccountId.value,
      folderId: offlineSourceFolderId.value,
      mediaOnly: true,
    });
    offlineScanResult.value = res;
    (res.files || []).forEach((f) => selectedOfflineFileIds.value.add(f.fileId));
    ElMessage.success(`已扫描出 ${res.totalFiles} 个媒体文件（共 ${res.totalSizeFormatted}）`);
  } catch (err: any) {
    ElMessage.error(err.message || '扫描 139 媒体文件失败');
  } finally {
    isScanningOffline.value = false;
  }
}

function toggleOfflineFileSelect(fileId: string) {
  if (selectedOfflineFileIds.value.has(fileId)) {
    selectedOfflineFileIds.value.delete(fileId);
  } else {
    selectedOfflineFileIds.value.add(fileId);
  }
}

const isAllOfflineSelected = computed(() => {
  const list = offlineScanResult.value?.files || [];
  if (list.length === 0) return false;
  return list.every((f) => selectedOfflineFileIds.value.has(f.fileId));
});

function toggleSelectAllOffline() {
  const list = offlineScanResult.value?.files || [];
  if (isAllOfflineSelected.value) {
    list.forEach((f) => selectedOfflineFileIds.value.delete(f.fileId));
  } else {
    list.forEach((f) => selectedOfflineFileIds.value.add(f.fileId));
  }
}

async function loadPan123Folders() {
  try {
    isLoading123Folders.value = true;
    const list = await syncApi.getPan123Folders(0);
    pan123Folders.value = list || [];
  } catch (err: any) {
    ElMessage.warning(`获取 123 目录失败: ${err.message || '请先配置 123 网盘账号'}`);
  } finally {
    isLoading123Folders.value = false;
  }
}

async function handleCreatePan123Folder() {
  try {
    const { value: folderName } = await ElMessageBox.prompt('请输入要在 123 网盘创建的文件夹名称：', '新建 123 目录', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /^\S+$/,
      inputErrorMessage: '目录名称不能为空',
    });
    if (!folderName) return;

    const res = await syncApi.createPan123Folder({
      parentId: selectedPan123DirId.value,
      folderName: folderName.trim(),
    });
    ElMessage.success(`目录「${res.name}」创建成功！`);
    await loadPan123Folders();
    selectedPan123DirId.value = res.id;
    selectedPan123DirName.value = res.name;
  } catch (err: any) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '创建 123 目录失败');
    }
  }
}

async function handlePushOffline() {
  if (!offlineSourceAccountId.value) {
    ElMessage.warning('请选择源 139 账号');
    return;
  }
  if (!offlineScanResult.value || offlineScanResult.value.files.length === 0) {
    ElMessage.warning('请先扫描 139 媒体目录');
    return;
  }
  const chosenFiles = offlineScanResult.value.files.filter((f) => selectedOfflineFileIds.value.has(f.fileId));
  if (chosenFiles.length === 0) {
    ElMessage.warning('请至少勾选一个待离线下载的媒体文件');
    return;
  }

  try {
    isPushingOffline.value = true;
    pushOfflineResult.value = null;

    const res = await syncApi.pushTo123Offline({
      accountId: offlineSourceAccountId.value,
      files: chosenFiles.map((f) => ({ fileId: f.fileId, name: f.name })),
      pan123TargetDirId: selectedPan123DirId.value,
    });

    pushOfflineResult.value = res;
    ElMessage.success(`成功将 ${res.submittedCount} 个任务提交至 123 网盘离线队列！`);
    // 自动刷新离线任务列表
    loadPan123Tasks();
  } catch (err: any) {
    ElMessage.error(err.message || '推送到 123 离线下载失败');
  } finally {
    isPushingOffline.value = false;
  }
}

async function loadPan123Tasks() {
  try {
    isLoadingTasks.value = true;
    const res = await syncApi.getPan123Tasks({ page: 1, pageSize: 50 });
    pan123Tasks.value = res.tasks || [];
    pan123TasksTotal.value = res.total || 0;
  } catch (err: any) {
    ElMessage.warning(`查询 123 离线任务失败: ${err.message || '请先配置 123 网盘账号'}`);
  } finally {
    isLoadingTasks.value = false;
  }
}

async function handleDeletePan123Task(taskId: number | string, taskName: string) {
  try {
    await ElMessageBox.confirm(`确定要删除 123 离线任务「${taskName}」吗？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await syncApi.deletePan123Task(taskId);
    ElMessage.success('离线任务已删除');
    loadPan123Tasks();
  } catch (err: any) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '删除离线任务失败');
    }
  }
}

const filteredPan123Tasks = computed(() => {
  if (taskFilter.value === 'all') return pan123Tasks.value;
  if (taskFilter.value === 'downloading') return pan123Tasks.value.filter((t) => t.status === 0);
  if (taskFilter.value === 'completed') return pan123Tasks.value.filter((t) => t.status === 2);
  if (taskFilter.value === 'failed') return pan123Tasks.value.filter((t) => t.status === 1);
  if (taskFilter.value === 'waiting') return pan123Tasks.value.filter((t) => t.status === 4);
  return pan123Tasks.value;
});

// ================= Tab 4: 同步与离线配置 =================
const showPan123Password = ref(false);
const isTestingPan123 = ref(false);
const testPan123Success = ref<boolean | null>(null);

async function handleTestPan123() {
  if (!form.pan123.username.trim()) {
    ElMessage.warning('请先输入 123 网盘用户名/手机号');
    return;
  }
  if (!form.pan123.password && !form.pan123.hasPassword) {
    ElMessage.warning('请先输入 123 网盘登录密码');
    return;
  }
  try {
    isTestingPan123.value = true;
    testPan123Success.value = null;
    const res = await syncApi.testPan123({
      username: form.pan123.username.trim(),
      password: form.pan123.password?.trim() || undefined,
    });
    testPan123Success.value = true;
    ElMessage.success(res?.message || '123 网盘连通性测试通过！凭据有效');
    // 测试通过顺便刷新目录
    loadPan123Folders();
  } catch (err: any) {
    testPan123Success.value = false;
    ElMessage.error(err.message || '123 网盘连通性测试失败');
  } finally {
    isTestingPan123.value = false;
  }
}

// ================= 统一目录选择器弹窗 =================
const isFolderPickerOpen = ref(false);
const folderPickerTarget = ref<'crossSource' | 'crossTarget' | 'rapidExport' | 'rapidImport' | 'offlineSource'>('crossSource');

const folderPickerAccountId = computed(() => {
  switch (folderPickerTarget.value) {
    case 'crossSource':
      return crossSourceAccountId.value;
    case 'crossTarget':
      return crossTargetAccountId.value;
    case 'rapidExport':
      return rapidExportAccountId.value;
    case 'rapidImport':
      return rapidImportAccountId.value;
    case 'offlineSource':
      return offlineSourceAccountId.value;
    default:
      return accounts.value[0]?.id || '';
  }
});

const folderPickerTitle = computed(() => {
  switch (folderPickerTarget.value) {
    case 'crossSource':
      return '选择 139 待同步源目录';
    case 'crossTarget':
      return '选择 139 目标落盘目录';
    case 'rapidExport':
      return '选择 139 待导出秒传码目录';
    case 'rapidImport':
      return '选择 139 秒传导入落盘目录';
    case 'offlineSource':
      return '选择 139 离线推送媒体源目录';
    default:
      return '选择网盘目录';
  }
});

function openFolderPicker(target: 'crossSource' | 'crossTarget' | 'rapidExport' | 'rapidImport' | 'offlineSource') {
  folderPickerTarget.value = target;
  isFolderPickerOpen.value = true;
}

function handleFolderSelected(folder: { id: string; name: string }) {
  const displayName = folder.id === '/' || folder.id === '-11' ? '根目录' : folder.name;
  switch (folderPickerTarget.value) {
    case 'crossSource':
      crossSourceFolderId.value = folder.id;
      crossSourceFolderName.value = displayName;
      break;
    case 'crossTarget':
      crossTargetFolderId.value = folder.id;
      crossTargetFolderName.value = displayName;
      break;
    case 'rapidExport':
      rapidExportFolderId.value = folder.id;
      rapidExportFolderName.value = displayName;
      break;
    case 'rapidImport':
      rapidImportFolderId.value = folder.id;
      rapidImportFolderName.value = displayName;
      break;
    case 'offlineSource':
      offlineSourceFolderId.value = folder.id;
      offlineSourceFolderName.value = displayName;
      break;
  }
  isFolderPickerOpen.value = false;
}

// 格式化字节辅助
function formatBytes(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

onMounted(async () => {
  syncTabFromRoute();
  await loadAccounts();
  await loadConfig();
  window.addEventListener('header-save-click', onHeaderSaveClick);
  // 若已配置 123 账号，预载 123 目录与任务
  if (form.pan123.username) {
    loadPan123Folders();
    loadPan123Tasks();
  }
});

onUnmounted(() => {
  window.removeEventListener('header-save-click', onHeaderSaveClick);
});
</script>

<template>
  <div class="space-y-6 w-full pb-16">
    <!-- 顶层主视口切换：统一对齐系统标准胶囊选项卡规范 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <!-- 胶囊选项卡群组 -->
      <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
        <button
          type="button"
          @click="switchTab('cross')"
          :class="activeTab === 'cross' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
        >
          <ArrowRightLeft class="w-3.5 h-3.5" />
          <span>139 跨号秒传</span>
        </button>

        <button
          type="button"
          @click="switchTab('rapid')"
          :class="activeTab === 'rapid' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
        >
          <FileCode2 class="w-3.5 h-3.5" />
          <span>秒传特征码互转</span>
        </button>

        <button
          type="button"
          @click="switchTab('offline')"
          :class="activeTab === 'offline' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
        >
          <CloudDownload class="w-3.5 h-3.5" />
          <span>123 网盘离线</span>
        </button>

        <button
          type="button"
          @click="switchTab('settings')"
          :class="activeTab === 'settings' ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
          class="px-3.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
        >
          <SlidersHorizontal class="w-3.5 h-3.5" />
          <span>同步与离线配置</span>
        </button>
      </div>

      <!-- 右侧辅助徽章提示 -->
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span v-if="activeTab === 'cross'" class="inline-flex items-center gap-1">
          <ShieldCheck class="w-3.5 h-3.5 text-blue-500" />
          PC 纯协议秒传 (3 线程并发)
        </span>
        <span v-else-if="activeTab === 'rapid'" class="inline-flex items-center gap-1">
          <Share2 class="w-3.5 h-3.5 text-indigo-500" />
          文件名#大小#SHA256 标准格式
        </span>
        <span v-else-if="activeTab === 'offline'" class="inline-flex items-center gap-1">
          <HardDrive class="w-3.5 h-3.5 text-emerald-500" />
          139 直链免流离线到 123
        </span>
      </div>
    </div>

    <!-- 加载中遮罩 -->
    <div v-if="isLoading" class="p-16 text-center text-gray-500">
      <RefreshCw class="w-8 h-8 mx-auto animate-spin text-blue-500 mb-2" />
      <span class="text-xs">正在载入资产同步配置与云盘数据...</span>
    </div>

    <div v-else class="space-y-6">

      <!-- ═════════════════════════════════════════════════════════════ -->
      <!-- TAB 1: 139 账号间跨号秒传 (纯协议秒级建树)                   -->
      <!-- ═════════════════════════════════════════════════════════════ -->
      <div v-if="activeTab === 'cross'" class="space-y-6">
        <!-- 账号与目录映射配置卡片 -->
        <div class="settings-card">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <ArrowRightLeft class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white">139 移动云盘账号间跨号秒传</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  基于 139 官方 PC 纯协议与 64 位 SHA256 特征码，免流量快速在多账号间转存与同名建树
                </p>
              </div>
            </div>

            <!-- 操作按钮组 -->
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="handleScanSource"
                :disabled="isScanning || isExecuting"
                class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
              >
                <RefreshCw :class="isScanning ? 'animate-spin' : ''" class="w-3.5 h-3.5 text-blue-500" />
                <span>{{ isScanning ? '正在扫描...' : '扫描源目录资产' }}</span>
              </button>

              <button
                type="button"
                @click="handleExecuteSync"
                :disabled="isExecuting || isScanning || !scanResult || selectedFileIds.size === 0"
                class="btn-primary text-xs h-8 px-4 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
              >
                <Play v-if="!isExecuting" class="w-3.5 h-3.5" />
                <RefreshCw v-else class="w-3.5 h-3.5 animate-spin" />
                <span>{{ isExecuting ? '秒传转存中...' : '开始跨号秒传' }}</span>
              </button>
            </div>
          </div>

          <!-- 双账号映射网格 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
            <!-- 源账号与源目录 -->
            <div class="p-4 rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/50 dark:bg-gray-800/30 space-y-4">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-blue-500"></span>
                  源账号 (提取资产)
                </span>
                <span class="text-[11px] text-gray-400 font-mono">SOURCE</span>
              </div>

              <div>
                <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">选择源 139 账号</label>
                <select v-model="crossSourceAccountId" class="input-base text-xs bg-white dark:bg-gray-900">
                  <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                    {{ acc.alias || acc.username }} ({{ acc.accountType === 'cloud139' ? '139 移动云盘' : acc.accountType }})
                  </option>
                </select>
              </div>

              <div>
                <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">待同步源目录</label>
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    :value="crossSourceFolderName"
                    readonly
                    class="input-base text-xs font-mono flex-1 bg-white dark:bg-gray-900 cursor-not-allowed"
                  />
                  <button
                    type="button"
                    @click="openFolderPicker('crossSource')"
                    class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <FolderTree class="w-3.5 h-3.5 text-blue-500" />
                    <span>选择目录</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 目标账号与目标落盘目录 -->
            <div class="p-4 rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/50 dark:bg-gray-800/30 space-y-4">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                  目标账号 (秒传落地)
                </span>
                <span class="text-[11px] text-gray-400 font-mono">TARGET</span>
              </div>

              <div>
                <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">选择目标 139 账号</label>
                <select v-model="crossTargetAccountId" class="input-base text-xs bg-white dark:bg-gray-900">
                  <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                    {{ acc.alias || acc.username }} ({{ acc.accountType === 'cloud139' ? '139 移动云盘' : acc.accountType }})
                  </option>
                </select>
              </div>

              <div>
                <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">目标落盘根目录</label>
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    :value="crossTargetFolderName"
                    readonly
                    class="input-base text-xs font-mono flex-1 bg-white dark:bg-gray-900 cursor-not-allowed"
                  />
                  <button
                    type="button"
                    @click="openFolderPicker('crossTarget')"
                    class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <FolderTree class="w-3.5 h-3.5 text-emerald-500" />
                    <span>选择目录</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 跨号同步策略开关 -->
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5 pt-4 border-t border-gray-100 dark:border-gray-800">
            <!-- 开关 1: 已存在跳过 -->
            <div class="flex items-center justify-between p-3 rounded-lg border border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-900">
              <div class="pr-2">
                <label class="text-xs font-medium text-gray-800 dark:text-gray-200">目标已存在自动跳过</label>
                <p class="text-[11px] text-gray-400 mt-0.5">命中同名或特征码跳过</p>
              </div>
              <el-switch v-model="crossExistSkip" />
            </div>

            <!-- 开关 2: 保持目录结构 -->
            <div class="flex items-center justify-between p-3 rounded-lg border border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-900">
              <div class="pr-2">
                <label class="text-xs font-medium text-gray-800 dark:text-gray-200">保持子目录层级结构</label>
                <p class="text-[11px] text-gray-400 mt-0.5">目标端同名建树归档</p>
              </div>
              <el-switch v-model="crossPreservePath" />
            </div>

            <!-- 开关 3: 移入源回收站 -->
            <div class="flex items-center justify-between p-3 rounded-lg border border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-900">
              <div class="pr-2">
                <label class="text-xs font-medium text-gray-800 dark:text-gray-200">成功后软删源文件</label>
                <p class="text-[11px] text-gray-400 mt-0.5">移入源回收站 (0硬删)</p>
              </div>
              <el-switch v-model="crossTrashSource" />
            </div>

            <!-- 开关 4: 仅媒体文件 -->
            <div class="flex items-center justify-between p-3 rounded-lg border border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-900">
              <div class="pr-2">
                <label class="text-xs font-medium text-gray-800 dark:text-gray-200">仅扫描影视媒体文件</label>
                <p class="text-[11px] text-gray-400 mt-0.5">过滤视频/字幕/nfo</p>
              </div>
              <el-switch v-model="crossMediaOnly" />
            </div>
          </div>
        </div>

        <!-- 扫描资产文件列表卡片 (若已扫描) -->
        <div v-if="scanResult" class="settings-card">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <span>待同步资产清单</span>
                <span class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80">
                  共 {{ scanResult.totalFiles }} 项 ({{ scanResult.totalSizeFormatted }})
                </span>
              </h4>
              <span class="text-xs text-gray-400">已勾选 {{ selectedFileIds.size }} 项</span>
            </div>

            <div class="flex items-center gap-2">
              <div class="relative w-48 sm:w-60">
                <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  v-model="searchKeyword"
                  type="text"
                  placeholder="搜索文件名 / 相对路径..."
                  class="input-base text-xs pl-8 h-8 w-full"
                />
              </div>

              <button
                type="button"
                @click="toggleSelectAll"
                class="btn-default text-xs h-8 px-3 shrink-0 cursor-pointer"
              >
                {{ isAllSelected ? '取消全选' : '全选全部' }}
              </button>
            </div>
          </div>

          <div class="overflow-x-auto max-h-96 overflow-y-auto mt-3 border border-gray-100 dark:border-gray-800 rounded-lg">
            <table class="w-full text-left text-xs">
              <thead class="sticky top-0 bg-gray-50 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 z-10">
                <tr>
                  <th class="p-3 w-10 text-center">
                    <input
                      type="checkbox"
                      :checked="isAllSelected"
                      @change="toggleSelectAll"
                      class="rounded text-blue-600 cursor-pointer"
                    />
                  </th>
                  <th class="p-3">文件名</th>
                  <th class="p-3">相对路径</th>
                  <th class="p-3 w-24">文件大小</th>
                  <th class="p-3 w-40">64 位 SHA256 特征码</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800 font-mono">
                <tr
                  v-for="file in filteredScannedFiles"
                  :key="file.fileId"
                  @click="toggleFileSelect(file.fileId)"
                  :class="selectedFileIds.has(file.fileId) ? 'bg-blue-50/40 dark:bg-blue-950/20' : 'hover:bg-gray-50/60 dark:hover:bg-gray-800/40'"
                  class="cursor-pointer transition-colors"
                >
                  <td class="p-3 text-center" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selectedFileIds.has(file.fileId)"
                      @change="toggleFileSelect(file.fileId)"
                      class="rounded text-blue-600 cursor-pointer"
                    />
                  </td>
                  <td class="p-3 font-sans font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                    <FileVideo class="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span class="truncate max-w-xs sm:max-w-md" :title="file.name">{{ file.name }}</span>
                  </td>
                  <td class="p-3 text-gray-500 dark:text-gray-400 truncate max-w-xs" :title="file.relativePath || '/'">
                    {{ file.relativePath || '/' }}
                  </td>
                  <td class="p-3 text-gray-600 dark:text-gray-300">{{ file.sizeFormatted }}</td>
                  <td class="p-3 text-gray-400 text-[11px]" :title="file.contentHash">
                    {{ file.contentHash ? file.contentHash.substring(0, 16) + '...' : '未提供' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 秒传执行结果卡片 (若已执行) -->
        <div v-if="executeResult" class="settings-card">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div>
              <h4 class="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <CheckCircle2 class="w-4 h-4 text-emerald-500" />
                <span>跨号秒传执行审计报告</span>
              </h4>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                共调度 {{ executeResult.total }} 项任务，成功完成秒传建树
              </p>
            </div>

            <div class="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg text-[11px]">
              <button
                type="button"
                @click="executeFilter = 'all'"
                :class="executeFilter === 'all' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-gray-500'"
                class="px-2 py-0.5 rounded cursor-pointer"
              >
                全部 ({{ executeResult.details?.length || 0 }})
              </button>
              <button
                type="button"
                @click="executeFilter = 'success'"
                :class="executeFilter === 'success' ? 'bg-white dark:bg-gray-700 text-emerald-600 dark:text-emerald-400 shadow-xs font-semibold' : 'text-gray-500'"
                class="px-2 py-0.5 rounded cursor-pointer"
              >
                成功 ({{ executeResult.successCount }})
              </button>
              <button
                type="button"
                @click="executeFilter = 'exist'"
                :class="executeFilter === 'exist' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-xs font-semibold' : 'text-gray-500'"
                class="px-2 py-0.5 rounded cursor-pointer"
              >
                已跳过 ({{ executeResult.existCount }})
              </button>
              <button
                type="button"
                @click="executeFilter = 'failed'"
                :class="executeFilter === 'failed' ? 'bg-white dark:bg-gray-700 text-red-600 dark:text-red-400 shadow-xs font-semibold' : 'text-gray-500'"
                class="px-2 py-0.5 rounded cursor-pointer"
              >
                失败 ({{ executeResult.failCount }})
              </button>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <div class="p-3 rounded-xl border border-emerald-200/80 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 text-center">
              <span class="text-xs text-emerald-600 dark:text-emerald-400">秒传成功</span>
              <p class="text-xl font-bold font-mono text-emerald-700 dark:text-emerald-300 mt-1">{{ executeResult.successCount }}</p>
            </div>
            <div class="p-3 rounded-xl border border-blue-200/80 dark:border-blue-800/60 bg-blue-50/50 dark:bg-blue-950/20 text-center">
              <span class="text-xs text-blue-600 dark:text-blue-400">已存在自动跳过</span>
              <p class="text-xl font-bold font-mono text-blue-700 dark:text-blue-300 mt-1">{{ executeResult.existCount }}</p>
            </div>
            <div class="p-3 rounded-xl border border-red-200/80 dark:border-red-800/60 bg-red-50/50 dark:bg-red-950/20 text-center">
              <span class="text-xs text-red-600 dark:text-red-400">失败 / 未命中</span>
              <p class="text-xl font-bold font-mono text-red-700 dark:text-red-300 mt-1">{{ executeResult.failCount }}</p>
            </div>
            <div class="p-3 rounded-xl border border-amber-200/80 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 text-center">
              <span class="text-xs text-amber-600 dark:text-amber-400">源文件移入回收站</span>
              <p class="text-xl font-bold font-mono text-amber-700 dark:text-amber-300 mt-1">{{ executeResult.trashedSourceCount }}</p>
            </div>
          </div>

          <div class="overflow-x-auto max-h-72 overflow-y-auto mt-4 border border-gray-100 dark:border-gray-800 rounded-lg">
            <table class="w-full text-left text-xs">
              <thead class="sticky top-0 bg-gray-50 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th class="p-2.5">文件名称</th>
                  <th class="p-2.5 w-24">处置状态</th>
                  <th class="p-2.5">反馈原因 / 说明</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                <tr v-for="(item, idx) in filteredExecuteDetails" :key="idx" class="hover:bg-gray-50/60 dark:hover:bg-gray-800/40">
                  <td class="p-2.5 font-medium text-gray-800 dark:text-gray-200 truncate max-w-md" :title="item.name">
                    {{ item.name }}
                  </td>
                  <td class="p-2.5">
                    <span
                      v-if="item.status === 'success'"
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                    >
                      秒传成功
                    </span>
                    <span
                      v-else-if="item.status === 'exist'"
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                    >
                      已存在跳过
                    </span>
                    <span
                      v-else
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-800"
                    >
                      失败
                    </span>
                  </td>
                  <td class="p-2.5 text-gray-500 dark:text-gray-400">
                    {{ item.reason || item.message || '-' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ═════════════════════════════════════════════════════════════ -->
      <!-- TAB 2: 秒传特征码互转 (文件名#大小#SHA256 导入导出)           -->
      <!-- ═════════════════════════════════════════════════════════════ -->
      <div v-if="activeTab === 'rapid'" class="space-y-6">
        <!-- 内部子选项卡 -->
        <div class="flex items-center gap-2 border-b border-gray-200 dark:border-gray-800 pb-3">
          <button
            type="button"
            @click="rapidTab = 'export'"
            :class="rapidTab === 'export' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 font-bold' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            class="px-3 py-1.5 text-xs cursor-pointer flex items-center gap-1.5 transition-colors"
          >
            <Share2 class="w-3.5 h-3.5" />
            <span>从 139 目录导出秒传特征码清单</span>
          </button>
          <button
            type="button"
            @click="rapidTab = 'import'"
            :class="rapidTab === 'import' ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 font-bold' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            class="px-3 py-1.5 text-xs cursor-pointer flex items-center gap-1.5 transition-colors"
          >
            <Upload class="w-3.5 h-3.5" />
            <span>批量秒传特征码导入并落地 139</span>
          </button>
        </div>

        <!-- 子视图 A: 导出秒传特征码 -->
        <div v-if="rapidTab === 'export'" class="settings-card space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Share2 class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white">139 目录秒传特征码清单导出</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  递归全量提取指定 139 目录中所有文件的 64 位 SHA256 特征码，生成标准秒传码清单（文件名#大小#SHA256）
                </p>
              </div>
            </div>

            <button
              type="button"
              @click="handleExportLinks"
              :disabled="isExporting"
              class="btn-primary text-xs h-8 px-4 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
            >
              <RefreshCw v-if="isExporting" class="w-3.5 h-3.5 animate-spin" />
              <FileCode2 v-else class="w-3.5 h-3.5" />
              <span>{{ isExporting ? '提取特征码中...' : '一键提取秒传特征码' }}</span>
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">选择源 139 账号</label>
              <select v-model="rapidExportAccountId" class="input-base text-xs bg-white dark:bg-gray-900">
                <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                  {{ acc.alias || acc.username }} ({{ acc.accountType === 'cloud139' ? '139 移动云盘' : acc.accountType }})
                </option>
              </select>
            </div>

            <div>
              <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">待提取目录</label>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  :value="rapidExportFolderName"
                  readonly
                  class="input-base text-xs font-mono flex-1 bg-white dark:bg-gray-900 cursor-not-allowed"
                />
                <button
                  type="button"
                  @click="openFolderPicker('rapidExport')"
                  class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                >
                  <FolderTree class="w-3.5 h-3.5 text-indigo-500" />
                  <span>选择目录</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 导出结果展示 -->
          <div v-if="exportResult" class="space-y-4 pt-4 border-t border-gray-100 dark:border-gray-800">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-xs">
                <span class="font-bold text-gray-800 dark:text-gray-200">提取完成：</span>
                <span class="text-gray-500 dark:text-gray-400">
                  共扫描 {{ exportResult.totalFiles }} 个文件，生成
                  <strong class="text-indigo-600 dark:text-indigo-400">{{ exportResult.validLinkCount }}</strong>
                  条标准秒传码 (共 {{ exportResult.totalSizeFormatted }})
                </span>
              </div>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  @click="copyExportText"
                  class="btn-default text-xs h-7 px-2.5 flex items-center gap-1 cursor-pointer font-medium"
                >
                  <Check v-if="isCopied" class="w-3.5 h-3.5 text-emerald-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ isCopied ? '已复制' : '复制全部' }}</span>
                </button>
                <button
                  type="button"
                  @click="downloadExportText"
                  class="btn-default text-xs h-7 px-2.5 flex items-center gap-1 cursor-pointer font-medium"
                >
                  <Download class="w-3.5 h-3.5 text-blue-500" />
                  <span>下载 .txt</span>
                </button>
              </div>
            </div>

            <textarea
              :value="exportResult.text"
              readonly
              rows="10"
              class="input-base font-mono text-xs w-full h-48 select-all p-3 bg-gray-50/60 dark:bg-gray-900/60 leading-relaxed"
            ></textarea>
          </div>
        </div>

        <!-- 子视图 B: 导入秒传特征码并落盘 -->
        <div v-if="rapidTab === 'import'" class="settings-card space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Upload class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white">批量秒传特征码导入并落地 139</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  输入秒传文本清单，系统将调用 139 PC 官方接口在目标账号指定目录下免流量秒传建盘落盘
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="fillImportExample"
                class="btn-default text-xs h-8 px-3 flex items-center gap-1 cursor-pointer font-medium"
              >
                <span>填入示例</span>
              </button>
              <button
                type="button"
                @click="handleImportLinks"
                :disabled="isImporting || !importRawText.trim()"
                class="btn-primary text-xs h-8 px-4 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
              >
                <RefreshCw v-if="isImporting" class="w-3.5 h-3.5 animate-spin" />
                <Play v-else class="w-3.5 h-3.5" />
                <span>{{ isImporting ? '正在秒传落盘...' : '解析并批量秒传落盘' }}</span>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">选择落地 139 账号</label>
              <select v-model="rapidImportAccountId" class="input-base text-xs bg-white dark:bg-gray-900">
                <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                  {{ acc.alias || acc.username }} ({{ acc.accountType === 'cloud139' ? '139 移动云盘' : acc.accountType }})
                </option>
              </select>
            </div>

            <div>
              <label class="block text-xs text-gray-600 dark:text-gray-400 mb-1">落盘目标目录</label>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  :value="rapidImportFolderName"
                  readonly
                  class="input-base text-xs font-mono flex-1 bg-white dark:bg-gray-900 cursor-not-allowed"
                />
                <button
                  type="button"
                  @click="openFolderPicker('rapidImport')"
                  class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                >
                  <FolderTree class="w-3.5 h-3.5 text-emerald-500" />
                  <span>选择目录</span>
                </button>
              </div>
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="text-xs font-semibold text-gray-700 dark:text-gray-300">
                秒传特征码清单 (支持 文件名#大小#SHA256、文件名|大小|SHA256 或 139:// 前缀)
              </label>
              <span class="text-[11px] text-gray-400 font-mono">每行一项，支持多行批量</span>
            </div>
            <textarea
              v-model="importRawText"
              placeholder="例如:&#10;流浪地球2.2023.2160p.mkv#15829182390#3c5a6b8e1f0d4c2b9a8e7f6d5c4b3a2e1f0d4c2b9a8e7f6d5c4b3a2e1f0d4c2b&#10;星际穿越.2014.1080p.mkv#8429182310#a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
              rows="6"
              class="input-base font-mono text-xs w-full h-36 p-3 leading-relaxed"
            ></textarea>
          </div>

          <!-- 导入结果展示 -->
          <div v-if="importResult" class="space-y-4 pt-4 border-t border-gray-100 dark:border-gray-800">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-center">
                <span class="text-xs text-gray-500">解析有效条目</span>
                <p class="text-lg font-bold font-mono text-gray-800 dark:text-gray-200 mt-1">{{ importResult.total }}</p>
              </div>
              <div class="p-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-center">
                <span class="text-xs text-emerald-600">秒传成功落盘</span>
                <p class="text-lg font-bold font-mono text-emerald-600 mt-1">{{ importResult.successCount }}</p>
              </div>
              <div class="p-3 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 text-center">
                <span class="text-xs text-blue-600">已存在跳过</span>
                <p class="text-lg font-bold font-mono text-blue-600 mt-1">{{ importResult.existCount }}</p>
              </div>
              <div class="p-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 text-center">
                <span class="text-xs text-red-600">未命中 / 失败</span>
                <p class="text-lg font-bold font-mono text-red-600 mt-1">{{ importResult.failCount }}</p>
              </div>
            </div>

            <!-- 明细表格 -->
            <div class="overflow-x-auto max-h-60 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-lg">
              <table class="w-full text-left text-xs">
                <thead class="sticky top-0 bg-gray-50 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th class="p-2.5">文件名</th>
                    <th class="p-2.5 w-24">大小</th>
                    <th class="p-2.5 w-24">状态</th>
                    <th class="p-2.5">反馈说明</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                  <tr v-for="(item, idx) in importResult.results" :key="idx" class="hover:bg-gray-50/60 dark:hover:bg-gray-800/40">
                    <td class="p-2.5 font-medium text-gray-800 dark:text-gray-200 truncate max-w-xs" :title="item.name">
                      {{ item.name }}
                    </td>
                    <td class="p-2.5 font-mono text-gray-500">{{ formatBytes(item.size) }}</td>
                    <td class="p-2.5">
                      <span
                        v-if="item.status === 'success'"
                        class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-300"
                      >
                        秒传成功
                      </span>
                      <span
                        v-else
                        class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-300"
                      >
                        失败
                      </span>
                    </td>
                    <td class="p-2.5 text-gray-500">{{ item.reason || item.message || '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- ═════════════════════════════════════════════════════════════ -->
      <!-- TAB 3: 123 网盘离线调度中枢 (139 直链免流离线)                 -->
      <!-- ═════════════════════════════════════════════════════════════ -->
      <div v-if="activeTab === 'offline'" class="space-y-6">
        <!-- 模块 A: 139 媒体选定并推送到 123 离线 -->
        <div class="settings-card space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <CloudDownload class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white">139 视频直链免流推送到 123 网盘离线</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  从 139 官方 CDN 获取高速免流直链，云端调用 123 OpenAPI 提交离线任务（具备 5252 二分自适应拆批）
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="handleScanOfflineSource"
                :disabled="isScanningOffline || isPushingOffline"
                class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
              >
                <RefreshCw :class="isScanningOffline ? 'animate-spin' : ''" class="w-3.5 h-3.5 text-blue-500" />
                <span>{{ isScanningOffline ? '正在扫描媒体...' : '扫描 139 媒体文件' }}</span>
              </button>

              <button
                type="button"
                @click="handlePushOffline"
                :disabled="isPushingOffline || isScanningOffline || !offlineScanResult || selectedOfflineFileIds.size === 0"
                class="btn-primary text-xs h-8 px-4 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
              >
                <CloudDownload v-if="!isPushingOffline" class="w-3.5 h-3.5" />
                <RefreshCw v-else class="w-3.5 h-3.5 animate-spin" />
                <span>{{ isPushingOffline ? '正在提交离线...' : '推送到 123 离线下载' }}</span>
              </button>
            </div>
          </div>

          <!-- 选择源 139 目录与 123 目标目录 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- 139 源目录 -->
            <div class="space-y-4">
              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">源 139 云盘账号</label>
                <select v-model="offlineSourceAccountId" class="input-base text-xs bg-white dark:bg-gray-900">
                  <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                    {{ acc.alias || acc.username }}
                  </option>
                </select>
              </div>

              <div>
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">源媒体目录</label>
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    :value="offlineSourceFolderName"
                    readonly
                    class="input-base text-xs font-mono flex-1 bg-white dark:bg-gray-900 cursor-not-allowed"
                  />
                  <button
                    type="button"
                    @click="openFolderPicker('offlineSource')"
                    class="btn-default text-xs h-[38px] px-3 shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <FolderTree class="w-3.5 h-3.5 text-blue-500" />
                    <span>选择目录</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 123 目标目录 -->
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">123 网盘离线目标目录</label>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    @click="loadPan123Folders"
                    :disabled="isLoading123Folders"
                    class="text-[11px] text-blue-600 hover:underline flex items-center gap-0.5 cursor-pointer"
                  >
                    <RefreshCw :class="isLoading123Folders ? 'animate-spin' : ''" class="w-3 h-3" />
                    <span>刷新目录</span>
                  </button>
                  <button
                    type="button"
                    @click="handleCreatePan123Folder"
                    class="text-[11px] text-emerald-600 hover:underline flex items-center gap-0.5 cursor-pointer"
                  >
                    <FolderPlus class="w-3 h-3" />
                    <span>新建子目录</span>
                  </button>
                </div>
              </div>

              <div>
                <select v-model="selectedPan123DirId" class="input-base text-xs bg-white dark:bg-gray-900 font-mono">
                  <option :value="0">/ (123 网盘根目录)</option>
                  <option v-for="folder in pan123Folders" :key="folder.id" :value="folder.id">
                    📁 {{ folder.name }} (ID: {{ folder.id }})
                  </option>
                </select>
                <p class="text-[11px] text-gray-400 mt-1">离线任务下载完成后将自动存放于该 123 目录中</p>
              </div>
            </div>
          </div>

          <!-- 待推送媒体勾选列表 (若已扫描) -->
          <div v-if="offlineScanResult" class="pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-xs">
                <span class="font-bold text-gray-800 dark:text-gray-200">待离线视频列表：</span>
                <span class="text-gray-500">
                  发现 {{ offlineScanResult.totalFiles }} 个视频（共 {{ offlineScanResult.totalSizeFormatted }}），已选
                  <strong class="text-emerald-600">{{ selectedOfflineFileIds.size }}</strong> 项
                </span>
              </div>

              <button
                type="button"
                @click="toggleSelectAllOffline"
                class="btn-default text-xs h-7 px-2.5 cursor-pointer"
              >
                {{ isAllOfflineSelected ? '取消全选' : '全选视频' }}
              </button>
            </div>

            <div class="overflow-x-auto max-h-60 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-lg">
              <table class="w-full text-left text-xs font-mono">
                <thead class="sticky top-0 bg-gray-50 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th class="p-2.5 w-10 text-center">
                      <input
                        type="checkbox"
                        :checked="isAllOfflineSelected"
                        @change="toggleSelectAllOffline"
                        class="rounded text-emerald-600 cursor-pointer"
                      />
                    </th>
                    <th class="p-2.5 font-sans">文件名称</th>
                    <th class="p-2.5 w-28">大小</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                  <tr
                    v-for="file in offlineScanResult.files"
                    :key="file.fileId"
                    @click="toggleOfflineFileSelect(file.fileId)"
                    :class="selectedOfflineFileIds.has(file.fileId) ? 'bg-emerald-50/40 dark:bg-emerald-950/20' : 'hover:bg-gray-50/60 dark:hover:bg-gray-800/40'"
                    class="cursor-pointer transition-colors"
                  >
                    <td class="p-2.5 text-center" @click.stop>
                      <input
                        type="checkbox"
                        :checked="selectedOfflineFileIds.has(file.fileId)"
                        @change="toggleOfflineFileSelect(file.fileId)"
                        class="rounded text-emerald-600 cursor-pointer"
                      />
                    </td>
                    <td class="p-2.5 font-sans font-medium text-gray-800 dark:text-gray-200 truncate max-w-md">
                      {{ file.name }}
                    </td>
                    <td class="p-2.5 text-gray-500">{{ file.sizeFormatted }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 模块 B: 123 网盘离线任务看板 -->
        <div class="settings-card space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <HardDrive class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <span>123 网盘离线任务看板</span>
                  <span v-if="pan123TasksTotal" class="px-2 py-0.5 rounded-full text-[11px] font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-300">
                    {{ pan123TasksTotal }} 个任务
                  </span>
                </h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  实时展示 123 网盘离线任务下载进度、耗时与执行状态
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <div class="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg text-[11px]">
                <button
                  type="button"
                  @click="taskFilter = 'all'"
                  :class="taskFilter === 'all' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-gray-500'"
                  class="px-2 py-0.5 rounded cursor-pointer"
                >
                  全部
                </button>
                <button
                  type="button"
                  @click="taskFilter = 'downloading'"
                  :class="taskFilter === 'downloading' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-white shadow-xs font-semibold' : 'text-gray-500'"
                  class="px-2 py-0.5 rounded cursor-pointer"
                >
                  下载中
                </button>
                <button
                  type="button"
                  @click="taskFilter = 'completed'"
                  :class="taskFilter === 'completed' ? 'bg-white dark:bg-gray-700 text-emerald-600 dark:text-white shadow-xs font-semibold' : 'text-gray-500'"
                  class="px-2 py-0.5 rounded cursor-pointer"
                >
                  已完成
                </button>
                <button
                  type="button"
                  @click="taskFilter = 'failed'"
                  :class="taskFilter === 'failed' ? 'bg-white dark:bg-gray-700 text-red-600 dark:text-white shadow-xs font-semibold' : 'text-gray-500'"
                  class="px-2 py-0.5 rounded cursor-pointer"
                >
                  失败
                </button>
              </div>

              <button
                type="button"
                @click="loadPan123Tasks"
                :disabled="isLoadingTasks"
                class="btn-default text-xs h-8 px-3 flex items-center gap-1 cursor-pointer font-medium disabled:opacity-50"
              >
                <RefreshCw :class="isLoadingTasks ? 'animate-spin' : ''" class="w-3.5 h-3.5 text-blue-500" />
                <span>刷新任务</span>
              </button>
            </div>
          </div>

          <div v-if="filteredPan123Tasks.length > 0" class="overflow-x-auto max-h-80 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-lg">
            <table class="w-full text-left text-xs">
              <thead class="sticky top-0 bg-gray-50 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th class="p-3">任务名称</th>
                  <th class="p-3 w-28">状态</th>
                  <th class="p-3 w-44">下载进度</th>
                  <th class="p-3 w-32">创建时间</th>
                  <th class="p-3 w-16 text-center">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800 font-mono">
                <tr v-for="task in filteredPan123Tasks" :key="task.task_id" class="hover:bg-gray-50/60 dark:hover:bg-gray-800/40">
                  <td class="p-3 font-sans font-medium text-gray-800 dark:text-gray-200 truncate max-w-xs sm:max-w-md" :title="task.name">
                    {{ task.name }}
                  </td>
                  <td class="p-3">
                    <span
                      v-if="task.status === 0"
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800 animate-pulse"
                    >
                      下载中
                    </span>
                    <span
                      v-else-if="task.status === 2"
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                    >
                      已完成
                    </span>
                    <span
                      v-else-if="task.status === 1"
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-800"
                    >
                      失败
                    </span>
                    <span
                      v-else
                      class="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
                    >
                      排队中
                    </span>
                  </td>
                  <td class="p-3">
                    <div class="flex items-center gap-2">
                      <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                        <div
                          class="bg-blue-600 h-2 rounded-full transition-all"
                          :style="{ width: `${Math.min(100, Math.max(0, task.progress || 0))}%` }"
                        ></div>
                      </div>
                      <span class="text-[11px] text-gray-500 w-9 text-right">{{ task.progress || 0 }}%</span>
                    </div>
                  </td>
                  <td class="p-3 text-gray-500 text-[11px]">{{ task.created_at || '-' }}</td>
                  <td class="p-3 text-center">
                    <button
                      type="button"
                      @click="handleDeletePan123Task(task.task_id, task.name)"
                      class="text-gray-400 hover:text-red-600 transition-colors cursor-pointer"
                      title="删除离线任务"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else class="py-12 text-center text-gray-400 text-xs">
            <HardDrive class="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
            <p>暂无 123 网盘离线任务</p>
            <p class="text-[11px] text-gray-400 mt-0.5">请先在上方勾选 139 媒体文件并提交离线下载</p>
          </div>
        </div>
      </div>

      <!-- ═════════════════════════════════════════════════════════════ -->
      <!-- TAB 4: 同步与离线配置 (123 OpenAPI 凭据与默认策略)           -->
      <!-- ═════════════════════════════════════════════════════════════ -->
      <div v-if="activeTab === 'settings'" class="space-y-6">
        <!-- 123 网盘账号与 OpenAPI 凭据 -->
        <div class="settings-card space-y-5">
          <div class="flex items-center justify-between pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <HardDrive class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white">123 网盘 OpenAPI 凭据配置</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  用于驱动 139 官方高速直链自动推送到 123 网盘进行离线下载
                </p>
              </div>
            </div>

            <!-- 凭据连通性测试按钮 -->
            <button
              type="button"
              @click="handleTestPan123"
              :disabled="isTestingPan123"
              class="btn-default text-xs h-8 px-3.5 flex items-center gap-1.5 cursor-pointer font-medium disabled:opacity-50"
            >
              <RefreshCw v-if="isTestingPan123" class="w-3.5 h-3.5 animate-spin text-blue-500" />
              <CheckCircle2 v-else-if="testPan123Success === true" class="w-3.5 h-3.5 text-emerald-500" />
              <XCircle v-else-if="testPan123Success === false" class="w-3.5 h-3.5 text-red-500" />
              <SlidersHorizontal v-else class="w-3.5 h-3.5 text-gray-500" />
              <span>{{ isTestingPan123 ? '测试中...' : '测试 123 凭据连通性' }}</span>
            </button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                123 网盘账号 (手机号或注册邮箱)
              </label>
              <input
                v-model="form.pan123.username"
                type="text"
                placeholder="例如: 13800138000 或 user@example.com"
                class="input-base text-xs font-mono w-full"
              />
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                123 网盘登录密码
              </label>
              <div class="relative">
                <input
                  v-model="form.pan123.password"
                  :type="showPan123Password ? 'text' : 'password'"
                  :placeholder="form.pan123.hasPassword ? '●●●●●●●● (已安全保存，留空保持不变)' : '请输入 123 网盘登录密码'"
                  class="input-base text-xs font-mono pr-10 w-full"
                />
                <button
                  type="button"
                  @click="showPan123Password = !showPan123Password"
                  class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                >
                  <Eye v-if="!showPan123Password" class="w-3.5 h-3.5" />
                  <EyeOff v-else class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                默认离线落盘目录 ID (0 为根目录)
              </label>
              <input
                v-model.number="form.pan123.targetDirId"
                type="number"
                placeholder="0"
                class="input-base text-xs font-mono w-full"
              />
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                默认离线落盘展示路径
              </label>
              <input
                v-model="form.pan123.targetDirPath"
                type="text"
                placeholder="/离线下载"
                class="input-base text-xs font-mono w-full"
              />
            </div>
          </div>
        </div>

        <!-- 资产同步默认策略 -->
        <div class="settings-card space-y-4">
          <div class="flex items-center gap-3 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <ShieldCheck class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-gray-900 dark:text-white">跨号秒传与同步默认策略</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                控制跨账号秒传时的重复防碰撞、同名建树与源文件软删除回收站安全防护
              </p>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50">
              <div class="pr-2">
                <label class="text-xs font-semibold text-gray-800 dark:text-gray-200">目标已存在同特征文件自动跳过</label>
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
                  秒传前比对目标目录下同名或同 64 位 SHA256 哈希，避免重复创建冗余副本
                </p>
              </div>
              <el-switch v-model="form.sync.existSkip" />
            </div>

            <div class="flex items-center justify-between p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50">
              <div class="pr-2">
                <label class="text-xs font-semibold text-gray-800 dark:text-gray-200">保持源目录相对子层级结构</label>
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
                  自动在目标网盘递归幂等创建多层子目录树（如 <code>剧集/庆余年/Season 1</code>）
                </p>
              </div>
              <el-switch v-model="form.sync.preservePath" />
            </div>

            <div class="flex items-center justify-between p-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/50">
              <div class="pr-2">
                <label class="text-xs font-semibold text-gray-800 dark:text-gray-200">秒传成功后安全移入源账号回收站</label>
                <p class="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
                  秒传落盘成功后，仅通过 139 官方 <code>batchTrash</code> 移入回收站，杜绝物理硬删，保护原始资产
                </p>
              </div>
              <el-switch v-model="form.sync.trashSource" />
            </div>
          </div>
        </div>

        <!-- 底部主保存按钮卡片 -->
        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            @click="handleSaveConfig"
            :disabled="isSaving"
            class="btn-primary text-xs h-9 px-6 flex items-center gap-1.5 shadow-sm font-medium cursor-pointer disabled:opacity-50"
          >
            <RefreshCw v-if="isSaving" class="w-3.5 h-3.5 animate-spin" />
            <Save v-else class="w-3.5 h-3.5" />
            <span>{{ isSaving ? '正在保存...' : '保存同步与离线配置' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 统一网盘目录选择弹窗 (FolderTreeSelector) -->
    <FolderTreeSelector
      v-model="isFolderPickerOpen"
      :account-id="folderPickerAccountId"
      :title="folderPickerTitle"
      @select="handleFolderSelected"
    />
  </div>
</template>

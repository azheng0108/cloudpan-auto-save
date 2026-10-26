import { http } from './request';

export interface Pan123Config {
  username: string;
  hasPassword?: boolean;
  password?: string;
  targetDirId: number | string;
  targetDirPath: string;
}

export interface SyncStrategyConfig {
  existSkip: boolean;
  preservePath: boolean;
  trashSource: boolean;
}

export interface SyncConfigData {
  pan123: Pan123Config;
  sync: SyncStrategyConfig;
}

export interface Pan123FolderItem {
  id: number | string;
  name: string;
  parentId?: number | string;
  type?: string;
}

export interface Pan123OfflineTask {
  task_id: number | string;
  name: string;
  status: number; // 0=下载中, 1=失败, 2=已完成, 4=排队等待中
  progress: number;
  rate?: number;
  size?: number;
  created_at?: string;
  error_msg?: string;
  url?: string;
}

export interface Pan123TaskListResult {
  tasks: Pan123OfflineTask[];
  total: number;
  page: number;
  error?: string;
}

export interface SyncScanFileItem {
  fileId: string;
  name: string;
  size: number;
  sizeFormatted: string;
  contentHash: string;
  relativePath: string;
  updatedAt?: string;
}

export interface SyncScanResult {
  totalFiles: number;
  totalSize: number;
  totalSizeFormatted: string;
  files: SyncScanFileItem[];
  folderName: string;
}

export interface SyncExecuteDetail {
  fileId?: string;
  name: string;
  targetFileId?: string;
  status: 'success' | 'exist' | 'failed';
  reason?: string;
  message?: string;
}

export interface SyncExecuteResult {
  total: number;
  successCount: number;
  existCount: number;
  failCount: number;
  trashedSourceCount: number;
  details: SyncExecuteDetail[];
}

export interface RapidExportItem {
  name: string;
  size: number;
  hash: string;
  line: string;
}

export interface RapidExportResult {
  text: string;
  totalFiles: number;
  validLinkCount: number;
  totalSizeFormatted: string;
  items: RapidExportItem[];
}

export interface RapidImportResultItem {
  name: string;
  size: number;
  hash: string;
  fileId?: string;
  status: 'success' | 'failed' | 'exist';
  reason?: string;
  message?: string;
}

export interface RapidImportResult {
  total: number;
  successCount: number;
  existCount: number;
  failCount: number;
  message?: string;
  results: RapidImportResultItem[];
}

export interface OfflinePushResult {
  total: number;
  submittedCount: number;
  failedCount: number;
  ok: any[];
  fail: any[];
  message?: string;
}

export const syncApi = {
  // 获取资产同步与 123 网盘配置
  getConfig(): Promise<SyncConfigData> {
    return http.get('/api/sync/config');
  },

  // 保存资产同步与 123 网盘配置
  saveConfig(data: { pan123?: Partial<Pan123Config>; sync?: Partial<SyncStrategyConfig> }): Promise<{ success: boolean; message: string }> {
    return http.post('/api/sync/config', data);
  },

  // 123 网盘凭据连通性测试
  testPan123(data?: { username?: string; password?: string }): Promise<{ success: boolean; message: string; user?: any }> {
    return http.post('/api/sync/pan123/test', data || {});
  },

  // 123 网盘目录列表
  getPan123Folders(parentId: number | string = 0): Promise<Pan123FolderItem[]> {
    return http.get('/api/sync/pan123/folders', { params: { parentId } });
  },

  // 123 网盘新建目录
  createPan123Folder(data: { parentId?: number | string; folderName: string }): Promise<{ id: number | string; name: string }> {
    return http.post('/api/sync/pan123/mkdir', data);
  },

  // 123 网盘离线任务列表
  getPan123Tasks(params?: { page?: number; pageSize?: number }): Promise<Pan123TaskListResult> {
    return http.get('/api/sync/pan123/tasks', { params });
  },

  // 删除 123 网盘离线任务
  deletePan123Task(taskId: number | string): Promise<{ success: boolean }> {
    return http.post('/api/sync/pan123/tasks/delete', { taskId });
  },

  // 扫描 139 源目录待同步资产
  scanCrossAccount(data: { accountId?: number | string; folderId?: string; mediaOnly?: boolean }): Promise<SyncScanResult> {
    return http.post('/api/sync/cross-account/scan', data);
  },

  // 执行 139 账号间跨号秒传
  executeCrossAccount(data: {
    sourceAccountId: number | string;
    targetAccountId: number | string;
    files: Array<{ fileId: string; name: string; contentHash: string; size: number; relativePath?: string }>;
    targetParentId?: string;
    existSkip?: boolean;
    preservePath?: boolean;
    trashSource?: boolean;
  }): Promise<SyncExecuteResult> {
    return http.post('/api/sync/cross-account/execute', data);
  },

  // 139 目录秒传特征码清单导出
  exportRapidLinks(data: { accountId?: number | string; folderId?: string }): Promise<RapidExportResult> {
    return http.post('/api/sync/rapid-links/export', data);
  },

  // 批量秒传特征码导入并落盘 139 账号
  importRapidLinks(data: { accountId?: number | string; rawText: string; targetFolderId?: string }): Promise<RapidImportResult> {
    return http.post('/api/sync/rapid-links/import', data);
  },

  // 139 文件一键推送至 123 网盘离线任务
  pushTo123Offline(data: { accountId?: number | string; files: any[]; pan123TargetDirId?: number | string }): Promise<OfflinePushResult> {
    return http.post('/api/sync/offline/push', data);
  },
};

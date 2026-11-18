import axios from 'axios';

export interface OrganizeFile {
  id: string;
  fileId?: string;
  name: string;
  size?: number;
  relativePath?: string;
  parentFolderName?: string;
  parentFileId?: string;
}

export interface OrganizeGroup {
  id?: string;
  key?: string;
  title: string;
  englishTitle?: string;
  year?: string;
  tmdbId?: string;
  mediaType: 'movie' | 'tv';
  category?: string;
  secondaryCategory?: string;
  posterPath?: string;
  backdropPath?: string;
  rating?: string;
  overview?: string;
  isSuspicious?: boolean;
  suspiciousReason?: string;
  isConcert?: boolean;
  seasons?: Array<{ season_number: number; episode_count?: number; name?: string }>;
  files: OrganizeFile[];
}

export interface OrganizeTask {
  fileId: string;
  oldName: string;
  newName: string;
  sourcePath: string;
  targetFolderPath: string;
  targetPath: string;
  seasonEpisode?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  fileSize?: number;
  isSidecar?: boolean;
  discard?: boolean;
  conflictDiscard?: boolean;
  conflictAction?: string;
  isProtected?: boolean;
  skipOrganize?: boolean;
  isFallbackSeason?: boolean;
  status: 'ready' | 'fallback' | 'protected' | 'pending_review' | 'unmatched' | 'suspicious' | 'discard' | 'success' | 'failed';
  decisionReason?: string;
  title?: string;
  tmdbId?: string;
  posterPath?: string;
}

export interface OrganizeSummary {
  total: number;
  ready: number;
  fallbackCount: number;
  protectedCount: number;
  suspiciousCount: number;
  unmatchedCount: number;
  discardCount: number;
}

export interface OrganizePreviewResult {
  groups: OrganizeGroup[];
  tasks: OrganizeTask[];
  summary: OrganizeSummary;
  settings: Record<string, any>;
}

export interface OrganizeHistoryRecord {
  id: number;
  batchId: number;
  driveType: string;
  accountId: number;
  kind: string;
  fileRef: string;
  oldParentRef?: string;
  oldParentPath?: string;
  oldName: string;
  size: number;
  newParentRef?: string;
  newParentPath?: string;
  newName?: string;
  mediaType: string;
  tmdbId?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  title?: string;
  year?: string;
  status: string;
  appliedAt?: string;
  createdAt?: string;
  posterPath?: string;
  reason?: string;
  sourceText?: string;
  evidence?: string | Record<string, any>;
  washAction?: string;
}

export interface OrganizeHistoryResponse {
  records: OrganizeHistoryRecord[];
  total: number;
  batches: any[];
  page: number;
  pageSize: number;
}

export const tmdbOrganizeApi = {
  // 扫描源目录并聚类分组
  async scanDirectory(folderId: string = '/', accountId?: number | string) {
    const res = await axios.post('/api/tmdb-organize/scan', { folderId, accountId });
    return res.data.data;
  },

  // 在线刮削与整理推演 (0 物理写入)
  async previewOrganize(groups: OrganizeGroup[], settings: Record<string, any> = {}) {
    const res = await axios.post('/api/tmdb-organize/preview', { groups, settings });
    return res.data.data as OrganizePreviewResult;
  },

  // 正式执行整理
  async executeOrganize(snapshot: { tasks: OrganizeTask[]; settings?: any }, accountId?: number | string, options: any = {}) {
    const res = await axios.post('/api/tmdb-organize/execute', { snapshot, accountId, options });
    return res.data.data;
  },

  // 获取历史整理记录
  async getHistory(params: { page?: number; pageSize?: number; status?: string; excludeStatus?: string; search?: string; tab?: string } = {}) {
    const res = await axios.get('/api/tmdb-organize/history', { params });
    return res.data.data as OrganizeHistoryResponse;
  },

  // 撤销整理 (支持单项撤回或整批撤销)
  async rollback(params: { batchId?: number; recordId?: number; accountId?: number | string } = {}) {
    const res = await axios.post('/api/tmdb-organize/rollback', params);
    return res.data.data;
  },

  // 删除单条整理历史记录
  async deleteRecord(recordId: number) {
    const res = await axios.delete(`/api/tmdb-organize/history/${recordId}`);
    return res.data.data;
  },

  // 批量删除整理历史记录
  async batchDeleteRecords(ids: number[]) {
    const res = await axios.post('/api/tmdb-organize/history/batch-delete', { ids });
    return res.data.data;
  },

  // 一键清理所有原地保护/熔断历史记录
  async clearProtectedRecords() {
    const res = await axios.post('/api/tmdb-organize/history/clear-protected');
    return res.data;
  },

  // 获取暂存区/隔离区/自定义目录的媒体文件清单
  async getUnrecognizedFiles(params: {
    folderId?: string;
    accountId?: number | string;
    mode?: 'all' | 'unrecognized_only';
    minFileSizeMb?: number;
  } = {}) {
    const res = await axios.get('/api/tmdb-organize/unrecognized', { params });
    return res.data.data;
  },

  // 高级手动整理即时双轨预览 (耗时严格 < 200ms)
  async previewManual(payload: {
    accountId?: number | string;
    files: any[];
    targetFolderId?: string;
    targetFolderPath?: string;
    mediaType?: string;
    category?: string;
    mode?: 'tmdb' | 'custom';
    tmdbId?: number | string;
    customTitle?: string;
    customYear?: string;
    customSeason?: number;
    startEpisode?: number;
    episodeStep?: number;
    keepOriginalName?: boolean;
    minFileSizeMb?: number;
  }) {
    const res = await axios.post('/api/tmdb-organize/preview-manual', payload);
    return res.data.data;
  },

  // 高级手动整理正式执行 (Strict WAL 预写日志与逐项原子移动)
  async manualOrganize(payload: {
    accountId?: number | string;
    batchName?: string;
    tasks: any[];
    options?: Record<string, any>;
  }) {
    const res = await axios.post('/api/tmdb-organize/manual-organize', payload);
    return res.data.data;
  },

  // 清理暂存区已搬空残留空目录与广告说明文件
  async cleanResidualFolders(params: { folderIds: string[]; accountId?: number | string }) {
    const res = await axios.post('/api/tmdb-organize/clean-residual', params);
    return res.data;
  },

  // TMDB 即时影视搜索
  async searchTmdb(params: { query: string; mediaType?: string; year?: string }) {
    const res = await axios.post('/api/tmdb-organize/search-tmdb', params);
    return res.data.data;
  },

  // 直接获取 TMDB 剧集全量季列表概览
  async getTvSeasons(tvId: string | number) {
    const res = await axios.get(`/api/tmdb-organize/tv/${tvId}/seasons`);
    return res.data.data;
  },

  // 直接获取 TMDB 剧集指定季度的全量单集明细
  async getSeasonEpisodes(tvId: string | number, seasonNumber: number | string) {
    const res = await axios.get(`/api/tmdb-organize/tv/${tvId}/season/${seasonNumber}`);
    return res.data.data;
  },

  // AI 智能辅助识别与影视条目提纯
  async aiIdentify(payload: { query: string; folderName?: string; files?: any[]; accountId?: number | string; tmdbId?: number | string; tmdbCandidate?: any }) {
    const res = await axios.post('/api/tmdb-organize/ai-identify', payload);
    return res.data.data;
  },

  // 物理流媒体规格嗅探 (基于 139 直链 Range 与 WASM MediaInfo)
  async probeGroup(payload: {
    accountId?: number | string;
    items: Array<{ fileId: string; name?: string; size?: number; isVideo?: boolean }>;
  }) {
    const res = await axios.post('/api/tmdb-organize/probe-group', payload);
    return res.data.data;
  },

  // 媒体库洗版仲裁预检 (比对已有文件画质规格)
  async washCheck(payload: {
    accountId?: number | string;
    targetDirPath?: string;
    items: Array<any>;
  }) {
    const res = await axios.post('/api/tmdb-organize/wash-check', payload);
    return res.data.data;
  },

  // 人工纠偏并规范归档入库
  async resolveUnrecognized(payload: {
    accountId?: number | string;
    items: Array<{
      fileId: string;
      name: string;
      targetTmdbId: string;
      targetTitle: string;
      targetYear?: string;
      targetMediaType?: 'tv' | 'movie';
      targetCategory?: string;
      targetSeason?: number;
      targetEpisode?: number;
      targetEpisodeTitle?: string;
      targetNewFileName?: string;
      probedMeta?: any;
      oldPath?: string;
      parentFolderId?: string;
      size?: number;
    }>;
    targetDirPath?: string;
    cleanEmptySourceDir?: boolean;
    batchId?: number | null;
  }) {
    const res = await axios.post('/api/tmdb-organize/resolve-unrecognized', payload);
    return res.data.data;
  },

  // 服务端异步后台归档服务 (容器后台驻留执行，即使前端页面关闭也能平稳运行到底)
  async startAsyncResolve(payload: {
    accountId?: number | string;
    mode: 'single' | 'batch';
    groups: Array<{
      groupId?: string;
      groupTitle?: string;
      title?: string;
      items: any[];
    }>;
    targetDirPath?: string;
    cleanEmptySourceDir?: boolean;
  }) {
    const res = await axios.post('/api/tmdb-organize/async-resolve', payload);
    return res.data;
  },

  async getAsyncResolveStatus() {
    const res = await axios.get('/api/tmdb-organize/async-resolve/status');
    return res.data.data;
  },

  async abortAsyncResolve() {
    const res = await axios.post('/api/tmdb-organize/async-resolve/abort');
    return res.data;
  }
};

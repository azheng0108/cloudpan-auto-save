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
  oldParentPath?: string;
  oldName: string;
  size: number;
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

  // 获取暂存区无法自动识别/待人工纠偏的文件清单
  async getUnrecognizedFiles(params: { folderId?: string; accountId?: number | string } = {}) {
    const res = await axios.get('/api/tmdb-organize/unrecognized', { params });
    return res.data.data;
  },

  // TMDB 即时影视搜索
  async searchTmdb(params: { query: string; mediaType?: string; year?: string }) {
    const res = await axios.post('/api/tmdb-organize/search-tmdb', params);
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
      oldPath?: string;
      parentFolderId?: string;
      size?: number;
    }>;
    targetDirPath?: string;
    cleanEmptySourceDir?: boolean;
  }) {
    const res = await axios.post('/api/tmdb-organize/resolve-unrecognized', payload);
    return res.data.data;
  }
};

import { http } from './request';

export interface BannedFileItem {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  size: number;
  sizeFormatted: string;
  reason: string;
  contentHash?: string;
}

export interface BannedScanResult {
  bannedFiles: BannedFileItem[];
  scannedFolders: number;
  totalScannedDirs?: number;
  totalFiles: number;
  totalScannedFiles?: number;
  scannedTargetFiles?: number;
  ignoredCount?: number;
  scope?: 'video' | 'all';
  bannedCount: number;
  totalBannedSize: number;
  totalBannedSizeFormatted: string;
  durationMs: number;
}

export interface BannedTombstone {
  id: string;
  fileId?: string;
  fileName: string;
  showTitle: string;
  season: number;
  episode: number | null;
  action: 'trash' | 'quarantine';
  quarantinePath?: string | null;
  originalPath?: string;
  size: number;
  sizeFormatted: string;
  timestamp: number;
  timeFormatted?: string;
}

export interface BannedCleanResult {
  action?: 'trash' | 'quarantine';
  quarantinePath?: string | null;
  successCount: number;
  cleanedCount?: number;
  failedCount: number;
  freedBytes: number;
  freedSizeFormatted: string;
  processedVideos?: number;
  processedCompanions?: number;
  affectedDirectories?: string[];
  embyResult?: {
    notified: boolean;
    updatedDirsCount?: number;
    targetPaths?: string[];
    reason?: string;
  };
  prunedEmptyDirsCount?: number;
  tombstones?: BannedTombstone[];
  stillThere: any[];
}

export interface EmptySweepResult {
  deletedFoldersCount: number;
  sweptCount?: number;
  deletedDirs: string[];
  durationMs: number;
}

export interface DedupGroupItem {
  id: string;
  name: string;
  size: number;
  path: string;
  videoFormat?: string;
  dynamicRange?: string;
  releaseGroup?: string;
  isRemux?: boolean;
  isBluRay?: boolean;
}

export interface DedupGroup {
  assetKey: string;
  mediaType: string;
  title: string;
  season_episode?: string;
  keeper: DedupGroupItem;
  losers: DedupGroupItem[];
  freedBytes: number;
  freedFormatted: string;
}

export interface DedupPlanResult {
  scannedFilesCount: number;
  duplicateGroupsCount: number;
  redundantFilesCount: number;
  totalFreedBytes: number;
  totalFreedFormatted: string;
  groups: DedupGroup[];
}

export interface DedupPruneResult {
  dryRun: boolean;
  successCount: number;
  failedCount: number;
  freedBytes: number;
  freedFormatted: string;
  skippedProtected: any[];
}

export interface LocalEpisodeFileItem {
  fileId: string;
  name: string;
  size: number;
  sizeFormatted: string;
  parsedEpisode?: number | null;
  path?: string;
  matchStatus?: 'matched' | 'unrecognized';
}

export interface MissingEpisodeItem {
  season: number;
  episode: number;
  tag: string;
  name: string;
  airDate: string;
}

export interface MissingSeasonResult {
  groupKey: string;
  title: string;
  tmdbId?: string | null;
  season: number;
  seasonLabel: string;
  folderPath: string;
  folderId?: string;
  posterPath?: string | null;
  airStatus?: string | null;
  isEnded?: boolean;
  firstAirYear?: string | null;
  localCount: number;
  coveredCount: number;
  tmdbCount: number;
  totalEpisodes?: number;
  localEpisodes?: number[];
  localFiles?: LocalEpisodeFileItem[];
  missingCount: number;
  missingEpisodes: MissingEpisodeItem[];
  missingRangesStr: string;
  shortRangesStr: string;
  detailedList: string[];
  tooltipTitle: string;
  status: 'missing' | 'complete' | 'extra' | 'unknown';
  isMatch: boolean;
  isExtra: boolean;
}

export interface MissingShowGroup {
  showKey: string;
  title: string;
  originalFolder?: string;
  tmdbId?: string | null;
  folderPath: string;
  folderId?: string;
  category?: string;
  posterPath?: string | null;
  firstAirYear?: string | null;
  airStatus?: string | null;
  isEnded?: boolean;
  totalMissingCount: number;
  totalLocalCount: number;
  totalTmdbCount: number;
  hasMissing: boolean;
  seasons: MissingSeasonResult[];
  isUnidentified?: boolean;
  unidentifiedReason?: string;
  sampleFiles?: string[];
  suggestedCandidate?: {
    id: string;
    title: string;
    year?: string;
    posterPath?: string | null;
    score?: number;
    reason?: string;
  } | null;
}

export interface EpisodeInspectionResult {
  scannedFilesCount: number;
  scannedShowsCount: number;
  missingShowsCount: number;
  completeShowsCount: number;
  unidentifiedShowsCount?: number;
  totalMissingCount: number;
  durationMs: number;
  items: MissingSeasonResult[];
  shows?: MissingShowGroup[];
}

export interface MissingScanJobStatus {
  status: 'idle' | 'running' | 'completed' | 'error';
  jobId?: string | number;
  targetPath?: string;
  current: number;
  total: number;
  percent: number;
  currentShow: string;
  lastMessage: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  durationMs?: number;
  result?: EpisodeInspectionResult | null;
  error?: string | null;
  alreadyRunning?: boolean;
}

export const maintenanceApi = {
  scanBanned(data?: {
    accountId?: number | string;
    rootCatalogId?: string;
    scope?: 'video' | 'all';
    customExtensions?: string[];
    excludePaths?: string[];
    ignoredIds?: string[];
  }): Promise<BannedScanResult> {
    return http.post('/api/maintenance/banned/scan', data || {});
  },

  cleanBanned(data: {
    accountId?: number | string;
    bannedFiles: any[];
    action?: 'trash' | 'quarantine';
    quarantinePath?: string;
    cascadeCompanion?: boolean;
    notifyEmby?: boolean;
    pruneEmptyParent?: boolean;
  }): Promise<BannedCleanResult> {
    return http.post('/api/maintenance/banned/clean', data);
  },

  sweepEmpty(data?: {
    accountId?: number | string;
    rootCatalogId?: string;
    protectedPaths?: string[];
    cleanJunk?: boolean;
  }): Promise<EmptySweepResult> {
    return http.post('/api/maintenance/empty/sweep', data || {});
  },

  getMissingScanStatus(): Promise<MissingScanJobStatus> {
    return http.get('/api/maintenance/episodes/missing/status');
  },

  scanMissingEpisodes(data?: {
    accountId?: number | string;
    rootCatalogId?: string;
    excludeUnreleased?: boolean;
    ignoreSeasonZero?: boolean;
    onlyEnded?: boolean;
    sync?: boolean;
  }): Promise<MissingScanJobStatus> {
    return http.post('/api/maintenance/episodes/missing/scan', data || {});
  },

  clearMissingScanResults(): Promise<{ success: boolean; message: string }> {
    return http.post('/api/maintenance/episodes/missing/clear');
  },

  removeShow(data: {
    showKey?: string;
    folderPath?: string;
    tmdbId?: string | number;
  }): Promise<{ success: boolean; message: string; result?: EpisodeInspectionResult }> {
    return http.post('/api/maintenance/episodes/missing/remove-show', data);
  },

  deleteMissingTargets(data: {
    accountId?: number | string;
    targets: Array<{
      folderPath: string;
      folderId?: string;
      season?: number;
      deleteEntireShow?: boolean;
      showKey?: string;
      tmdbId?: string | number | null;
      title?: string;
    }>;
  }): Promise<{ success: boolean; deletedCount: number; failedCount: number; message: string; result?: EpisodeInspectionResult }> {
    return http.post('/api/maintenance/episodes/missing/delete-targets', data, { timeout: 120000 });
  },

  searchTmdbCandidates(data: {
    title: string;
    year?: string;
    mediaType?: string;
  }): Promise<any[]> {
    return http.post('/api/maintenance/episodes/missing/search-tmdb', data);
  },

  matchTmdb(data: {
    accountId?: number | string;
    folderPath: string;
    folderId?: string;
    tmdbId: string | number;
    season?: number;
    applyToAllSeasons?: boolean;
    excludeUnreleased?: boolean;
    ignoreSeasonZero?: boolean;
    onlyEnded?: boolean;
  }): Promise<any> {
    return http.post('/api/maintenance/episodes/missing/match-tmdb', data, { timeout: 60000 });
  },

  recheckShow(data: {
    accountId?: number | string;
    folderPath: string;
    folderId?: string;
    tmdbId?: string | number;
    excludeUnreleased?: boolean;
    ignoreSeasonZero?: boolean;
    onlyEnded?: boolean;
  }): Promise<MissingShowGroup> {
    return http.post('/api/maintenance/episodes/missing/recheck', data, { timeout: 60000 });
  },

  scanDedup(data?: {
    accountId?: number | string;
    rootCatalogId?: string;
    files?: any[];
    policy?: any;
  }): Promise<DedupPlanResult> {
    return http.post('/api/maintenance/assets/dedup/scan', data || {});
  },

  pruneDedup(data: {
    accountId?: number | string;
    plan: any;
    dryRun?: boolean;
    protectedPaths?: string[];
  }): Promise<DedupPruneResult> {
    return http.post('/api/maintenance/assets/dedup/prune', data);
  },

  getJobs(params?: { limit?: number; offset?: number; type?: string }): Promise<{ total: number; items: MaintenanceJobItem[] }> {
    return http.get('/api/maintenance/jobs', { params });
  },

  getJobDetail(id: number | string): Promise<MaintenanceJobDetail> {
    return http.get(`/api/maintenance/jobs/${id}`);
  },

  clearJobs(type?: string): Promise<{ success: boolean; message: string }> {
    return http.delete('/api/maintenance/jobs', { params: type ? { type } : undefined });
  },

  deleteJob(id: number | string): Promise<{ success: boolean; message: string }> {
    return http.delete(`/api/maintenance/jobs/${id}`);
  },

  clearMissingCache(): Promise<{ success: boolean; message: string }> {
    return http.delete('/api/maintenance/episodes/missing/cache');
  },
};

export interface MaintenanceJobItem {
  id: number;
  type: 'banned_scan' | 'banned_clean' | 'empty_prune' | 'missing_scan';
  triggerType: 'manual' | 'cron';
  title: string;
  status: 'running' | 'completed' | 'cleaned' | 'failed';
  summary: string;
  durationMs: number;
  folderPath?: string;
  scannedFolders?: number;
  totalFiles?: number;
  bannedCount?: number;
  cleanedCount?: number;
  freedFormatted?: string;
  hasFindings?: boolean;
  findingsCount?: number;
  unidentifiedShowsCount?: number;
  missingShowsCount?: number;
  error?: string;
  createdAt: string;
  timeFormatted: string;
  timestamp?: number;
}

export interface MaintenanceJobDetail extends MaintenanceJobItem {
  findings?: any[];
  cleanedDetails?: string[];
}


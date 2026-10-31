import { http } from './request';

export interface DispatchRuleItem {
  keyword: string;
  folderId: string;
  folderName: string;
}

export interface VisualCardItem {
  id: string;
  type: 'tmdb' | 'custom';
  tmdbId?: number;
  title: string;
  originalTitle?: string;
  year?: string;
  posterPath?: string;
  aliases?: string[];
  limitations?: ('4K' | '完整剧集')[];
  pattern?: string;
  name?: string;
}

export interface TmdbCandidateItem {
  id: number;
  tmdbId?: number;
  chineseTitle?: string;
  name?: string;
  title?: string;
  originalTitle?: string;
  year?: string;
  posterPath?: string;
  overview?: string;
  mediaType?: string;
  translations?: string[];
  isAnime?: boolean;
  category?: string;
  secondaryCategory?: string;
  genreIds?: number[];
}

export interface MobileFallbackConfig {
  enable: boolean;
  networkSearch: boolean;
  proactiveRenew: boolean;
  timeoutMs?: number;
}

export interface ChannelAiConfig {
  enable: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: 'fallback' | 'always';
  mobileFallback?: MobileFallbackConfig;
}

export interface AiTestResult {
  success: boolean;
  latencyMs?: number;
  model?: string;
  reply?: string;
  error?: string;
}

export interface AiParsedMediaInfo {
  title: string;
  originalTitle?: string;
  year?: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  category?: string;
  videoFormat?: string;
  videoCodec?: string;
  dynamicRange?: string;
  confidence?: number;
  fromCache?: boolean;
}

export interface ChannelGlobalConfig {
  enabled: boolean;
  channels: string[];
  defaultTargetFolderId: string;
  defaultTargetFolderName: string;
  dispatchRules: DispatchRuleItem[];
  whitelistRegex: string;
  blacklistKeywords: string[];
  visualCards?: VisualCardItem[];
  stagingFolderId?: string;
  stagingFolderName?: string;
  autoOrganize?: boolean;
  autoWash?: boolean;
  minFileSize?: number;
  ignoreKeywords?: string;
  ignoreAudiobooks?: boolean;
  classifyChildren?: boolean;
  classifyConcerts?: boolean;
  classifyRegion?: boolean;
  classifyYear?: boolean;
  washPriorityOrder?: string[];
  keepDolbyMultiVersion?: boolean;
  notifyOnOrganize?: boolean;
  linkStrm?: boolean;
  notifyOnStrm?: boolean;
  scanInterval?: number;
  videoExtensions?: string[];
  metadataExtensions?: string[];
  enableRename?: boolean;
  enableMediaInfo?: boolean;
  includeEpisodeTitle?: boolean;
  sweepEmptyFolders?: boolean;
  excludeNonVideo?: boolean;
  excludeNoChineseSubtitle?: boolean;
  excludeTrailersAndSamples?: boolean;
  ai?: ChannelAiConfig;
}


export interface ChannelHistoryItem {
  id: number;
  channelId?: number;
  channelName?: string;
  channelTitle?: string;
  messageId?: number;
  postUrl?: string;
  postTitle?: string;
  rawText?: string;
  shareLink?: string;
  accessCode?: string;
  status: 'success' | 'transferred' | 'skipped' | 'failed' | string;
  reason?: string;
  transferredCount?: number;
  transferredDetails?: string;
  targetFolder?: string;
  details?: string;
  createdAt: string;
}

export interface ChannelMonitorItem {
  id: number;
  name: string;
  channelUrl: string;
  accountId: number | string;
  stagingFolderId?: string;
  stagingFolderName?: string;
  targetFolderId?: string;
  targetFolderName?: string;
  filterKeywords?: string;
  excludeKeywords?: string;
  autoOrganize?: boolean;
  autoWash?: boolean;
  status: 'active' | 'disabled' | 'paused';
  cronExpression?: string;
}

export const channelApi = {
  getGlobalConfig(): Promise<ChannelGlobalConfig> {
    return http.get('/api/channel/global-config');
  },
  saveGlobalConfig(data: Partial<ChannelGlobalConfig>): Promise<ChannelGlobalConfig> {
    return http.post('/api/channel/global-config', data);
  },
  syncNow(): Promise<{ message: string }> {
    return http.post('/api/channel/sync-now');
  },
  organizeNow(data?: { accountId?: number | string; stagingFolderId?: string; defaultTargetFolderId?: string }): Promise<{ message: string }> {
    return http.post('/api/channel/organize-now', data);
  },
  checkOrganizePrerequisites(params?: { stagingFolderId?: string }): Promise<{
    ready: boolean;
    missing: string[];
    reason: string;
    details?: {
      tmdbConfigured: boolean;
      channelMonitorConfigured: boolean;
      stagingConfigured: boolean;
      hasChannels: boolean;
      channelEnabled: boolean;
    };
  }> {
    return http.get('/api/channel/organize-prerequisites', { params });
  },
  getHistory(params?: { channelId?: number; status?: string; page?: number; pageSize?: number }): Promise<{
    items?: ChannelHistoryItem[];
    list?: ChannelHistoryItem[];
    total: number;
  } | ChannelHistoryItem[]> {
    return http.get('/api/channel-monitors/history', { params });
  },
  getMonitors(): Promise<ChannelMonitorItem[]> {
    return http.get('/api/channel-monitors');
  },
  deleteMonitor(id: number): Promise<any> {
    return http.delete(`/api/channel-monitors/${id}`);
  },
  scanMonitor(id: number): Promise<{ scanned: number; transferred: number }> {
    return http.post(`/api/channel-monitors/${id}/scan`);
  },
  searchCandidates(data: { title: string; year?: string; mediaType?: string }): Promise<TmdbCandidateItem[]> {
    return http.post('/api/scrape/search-candidates', data);
  },
  testAi(config: Partial<ChannelAiConfig>): Promise<AiTestResult> {
    return http.post('/api/ai/test', config);
  },
  testMobileAi(accountId?: number | null): Promise<AiTestResult> {
    return http.post('/api/ai/test', { mode: 'mobile', accountId: accountId ?? null });
  },
  parseTweet(data: { text: string; config?: Partial<ChannelAiConfig> }): Promise<AiParsedMediaInfo> {
    return http.post('/api/ai/parse', data);
  },
};

function escapeRegex(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileCardsToRegex(cards: VisualCardItem[]): string {
  if (!cards || cards.length === 0) return '';
  const parts: string[] = [];
  for (const c of cards) {
    if (c.type === 'custom') {
      if (c.pattern) parts.push(`(?:${c.pattern})`);
      continue;
    }
    if (c.type === 'tmdb') {
      const names = [c.title, ...(c.aliases || [])].filter(Boolean).map(escapeRegex);
      if (names.length === 0) continue;
      const cardPattern = `(?:${names.join('|')})`;
      const lookaheads: string[] = [];
      if (c.year) {
        lookaheads.push(`(?=.*${c.year})`);
      }
      if (Array.isArray(c.limitations)) {
        if (c.limitations.includes('4K')) {
          lookaheads.push('(?=.*(?:4K|2160p|UHD))');
        }
        if (c.limitations.includes('完整剧集')) {
          lookaheads.push('(?=.*(?:全集|完结|全\\d+集|S01|Season))');
        }
      }
      if (lookaheads.length > 0) {
        parts.push(`${lookaheads.join('')}.*${cardPattern}`);
      } else {
        parts.push(cardPattern);
      }
    }
  }
  return parts.join('|');
}

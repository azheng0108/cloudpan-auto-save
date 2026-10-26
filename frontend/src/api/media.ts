import { http } from './request';

export interface ScrapeRuleItem {
  id: number;
  name: string;
  accountId: number | string;
  sourceFolderId: string;
  sourceFolderName: string;
  targetFolderId: string;
  targetFolderName: string;
  mediaType: 'movie' | 'tv' | 'auto';
  autoExecute: boolean;
  cronExpression?: string;
  status: 'active' | 'disabled';
}

export interface JournalItem {
  id: number;
  batchId: string;
  ruleId?: number;
  operationType: string;
  sourcePath: string;
  targetPath: string;
  tmdbId?: string;
  status: 'applied' | 'reverted';
  createdAt: string;
}

export const mediaApi = {
  getRules(): Promise<ScrapeRuleItem[]> {
    return http.get('/api/scrape/rules');
  },
  createRule(data: Partial<ScrapeRuleItem>): Promise<ScrapeRuleItem> {
    return http.post('/api/scrape/rules', data);
  },
  updateRule(id: number, data: Partial<ScrapeRuleItem>): Promise<ScrapeRuleItem> {
    return http.put(`/api/scrape/rules/${id}`, data);
  },
  deleteRule(id: number): Promise<any> {
    return http.delete(`/api/scrape/rules/${id}`);
  },
  runRule(id: number): Promise<any> {
    return http.post(`/api/scrape/rules/${id}/run`);
  },
  runSandbox(data: { accountId: number | string; sourceFolderId: string; targetFolderId: string }): Promise<any> {
    return http.post('/api/scrape/sandbox', data);
  },
  getInbox(): Promise<any[]> {
    return http.get('/api/scrape/inbox');
  },
  adoptInbox(id: number, data?: any): Promise<any> {
    return http.post('/api/scrape/inbox/adopt', { id, ...data });
  },
  ignoreInbox(id: number): Promise<any> {
    return http.post('/api/scrape/inbox/ignore', { id });
  },
  getJournal(batchId?: string): Promise<JournalItem[]> {
    return http.get('/api/scrape/journal', { params: { batchId } });
  },
  revertJournal(recordId?: number, batchId?: string): Promise<any> {
    return http.post('/api/scrape/journal/revert', { recordId, batchId });
  },
  scanDedup(data?: any): Promise<any> {
    return http.post('/api/dedup/scan', data);
  },
  cleanDedup(data?: any): Promise<any> {
    return http.post('/api/dedup/clean', data);
  },
};

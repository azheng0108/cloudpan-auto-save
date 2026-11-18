import { http } from './request';

export interface TaskItem {
  id: number;
  accountId: number | string;
  account?: {
    username?: string;
  };
  shareLink?: string;
  shareUrl?: string;
  accessCode?: string;
  shareCode?: string;
  resourceName: string;
  realFolderId?: string;
  realFolderName: string;
  targetFolderId?: string;
  targetFolder?: string;
  shareFolderId?: string;
  shareFolderName?: string;
  cronExpression?: string;
  enableCron?: boolean;
  status: 'pending' | 'processing' | 'running' | 'completed' | 'failed';
  totalEpisodes?: number;
  currentEpisodes?: number;
  lastCheckTime?: string;
  lastRunTime?: string;
  nextRetryTime?: string;
  retryCount?: number;
  lastError?: string;
  movieRenameFormat?: string;
  tvRenameFormat?: string;
  disableRename?: boolean | null;
  enableTaskScraper?: boolean;
  tmdbId?: string;
  videoType?: 'tv' | 'movie';
  posterPath?: string;
  tmdbContent?: string;
  remark?: string;
  matchPattern?: string;
  matchOperator?: string;
  matchValue?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const taskApi = {
  getTasks(params?: { status?: string; search?: string }): Promise<TaskItem[]> {
    return http.get('/api/tasks', { params });
  },
  createTask(data: Partial<TaskItem> & Record<string, any>): Promise<TaskItem> {
    return http.post('/api/tasks', data);
  },
  updateTask(id: number, data: Partial<TaskItem> & Record<string, any>): Promise<TaskItem> {
    return http.put(`/api/tasks/${id}`, data);
  },
  deleteTask(id: number, deleteCloud?: boolean): Promise<any> {
    return http.delete(`/api/tasks/${id}`, { data: { deleteCloud } });
  },
  deleteTasksBatch(ids: number[], deleteCloud?: boolean): Promise<any> {
    return http.delete('/api/tasks/batch', { data: { taskIds: ids, deleteCloud } });
  },
  executeTask(id: number): Promise<any> {
    return http.post(`/api/tasks/${id}/execute`);
  },
  executeAllTasks(): Promise<any> {
    return http.post('/api/tasks/executeAll');
  },
  parseShare(data: { shareLink: string; accountId: number | string; accessCode?: string }): Promise<any> {
    return http.post('/api/share/parse', data);
  },
};


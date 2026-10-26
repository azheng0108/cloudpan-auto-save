import { http } from './request';

export const settingsApi = {
  getSettings(): Promise<Record<string, any>> {
    return http.get('/api/settings');
  },
  saveSettings(data: Record<string, any>): Promise<any> {
    return http.post('/api/settings', data);
  },
  saveMediaSettings(data: Record<string, any>): Promise<any> {
    return http.post('/api/settings/media', data);
  },
  testCustomPush(data: any): Promise<any> {
    return http.post('/api/custom-push/test', data);
  },
  testProxy(proxyUrl?: string): Promise<any> {
    return http.post('/api/settings/test-proxy', { proxyUrl });
  },
  testTelegram(data: { botToken?: string; chatId?: string; proxyUrl?: string }): Promise<any> {
    return http.post('/api/settings/test-telegram', data);
  },
  testTmdb(data: { apiKey?: string; apiBaseUrl?: string; proxy?: string }): Promise<any> {
    return http.post('/api/settings/test-tmdb', data);
  },
  generateOrganizedStrm(options?: any): Promise<any> {
    return http.post('/api/strm/generate-organized', options || {});
  },
};

export const systemApi = {
  getVersion(): Promise<{ version: string }> {
    return http.get('/api/system/version');
  },
  getHealth(): Promise<any> {
    return http.get('/api/health');
  },
  getSchedulerStatus(): Promise<any> {
    return http.get('/api/system/scheduler/status');
  },
  scanBanned(): Promise<any> {
    return http.post('/api/maintenance/banned/scan');
  },
  cleanBanned(): Promise<any> {
    return http.post('/api/maintenance/banned/clean');
  },
  sweepEmptyFolders(): Promise<any> {
    return http.post('/api/maintenance/empty/sweep');
  },
};

import { http } from './request';

export interface PansouResourceItem {
  title: string;
  link: string;
  url: string;
  password?: string;
  size?: number;
  sizeFormatted?: string;
  source?: string;
  datetime?: string;
}

export interface PansouSearchResponse {
  success: boolean;
  data: PansouResourceItem[];
  total: number;
  baseUrl: string;
  error?: string;
}

export interface PansouHealthResponse {
  connected: boolean;
  latency: number;
  message: string;
}

export const pansouApi = {
  /**
   * 向盘搜服务发起 139 移动云盘定向检索
   */
  async search(
    keyword: string,
    options: { baseUrl?: string; apiKey?: string; refresh?: boolean; timeout?: number } = {}
  ): Promise<PansouResourceItem[]> {
    const res = await http.post('/api/pansou/search', {
      keyword,
      ...options
    });
    if (Array.isArray(res)) {
      return res;
    }
    if (res && Array.isArray((res as any).data)) {
      return (res as any).data;
    }
    return [];
  },

  /**
   * 检测盘搜服务连通性
   */
  async checkHealth(
    options: { baseUrl?: string; apiKey?: string; timeout?: number } = {}
  ): Promise<PansouHealthResponse> {
    const res = await http.get('/api/pansou/health', {
      params: options
    });
    return res as unknown as PansouHealthResponse;
  }
};

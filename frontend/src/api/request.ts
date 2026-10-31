import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { ElMessage } from 'element-plus';

// 严格遵循 docs/API.md 规范的统一响应结构
export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: string;
  code?: string;
}

const service = axios.create({
  baseURL: '',
  timeout: 30000,
  withCredentials: true,
});

// 请求拦截器
service.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
service.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const res = response.data;
    // 如果返回的不是规范的 ApiResponse 结构（如文件下载、原生重定向响应等），直接返回
    if (res && typeof res.success === 'boolean') {
      if (!res.success) {
        const errorMsg = res.error || '操作失败';
        return Promise.reject(new Error(errorMsg));
      }
      return res.data !== undefined ? res.data : res;
    }
    return res;
  },
  (error) => {
    let friendlyMessage = error.message;

    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        ElMessage.warning('会话已过期，请重新登录');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
        return Promise.reject(new Error('会话已过期，请重新登录'));
      } else if (error.response.data?.error) {
        friendlyMessage = error.response.data.error;
      } else if (status === 502 || status === 504) {
        friendlyMessage = `后端服务未启动或连接断开 (${status})`;
      } else if (status === 404) {
        friendlyMessage = `请求的资源不存在 (${status})`;
      } else if (status === 500) {
        friendlyMessage = error.response.data?.message || '后端服务内部异常 (500)';
      }
    } else if (error.code === 'ECONNABORTED') {
      friendlyMessage = '网络请求超时，请检查后端服务';
    } else if (typeof window !== 'undefined' && !window.navigator.onLine) {
      friendlyMessage = '本地网络连接已断开';
    } else {
      friendlyMessage = error.message || '网络连接失败';
    }

    // 格式化错误对象的 message，供业务组件统一呈现具有上下文的明确提示，杜绝全局与局部双重弹窗
    error.message = friendlyMessage;
    return Promise.reject(error);
  }
);

export const http = {
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return service.get(url, config) as Promise<T>;
  },
  post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    return service.post(url, data, config) as Promise<T>;
  },
  put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    return service.put(url, data, config) as Promise<T>;
  },
  delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return service.delete(url, config) as Promise<T>;
  },
};

export default service;

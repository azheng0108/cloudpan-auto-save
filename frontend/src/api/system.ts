import { http } from './request';

export interface SystemHealthData {
  status: string;
  version: string;
  uptimeSeconds: number;
  database: {
    connected: boolean;
  };
  timestamp: string;
}

export interface SchedulerJobItem {
  id: number | string;
  taskName: string;
  cronExpression: string;
  enableCron: boolean;
  status: string;
}

export interface SchedulerStatusData {
  totalJobs: number;
  jobs: SchedulerJobItem[];
}

export const systemApi = {
  getHealth(): Promise<SystemHealthData> {
    return http.get('/api/health');
  },
  getVersion(): Promise<any> {
    return http.get('/api/system/version');
  },
  getSchedulerStatus(): Promise<SchedulerStatusData> {
    return http.get('/api/system/scheduler/status');
  },
};

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { tmdbOrganizeApi } from '../api/tmdbOrganize';

export interface OrganizeProgressState {
  active: boolean;
  mode: 'single' | 'batch';
  status?: string;
  current: number;
  total: number;
  percent: number;
  currentGroupIndex?: number;
  totalGroups?: number;
  groupTitle?: string;
  currentFileName: string;
  processedCount?: number;
  skippedCount?: number;
  failedCount?: number;
}

export const useOrganizeStore = defineStore('organize', () => {
  const organizeProgress = ref<OrganizeProgressState>({
    active: false,
    mode: 'single',
    status: 'idle',
    current: 0,
    total: 0,
    percent: 0,
    currentFileName: ''
  });

  const resolvingNow = ref(false);
  const batchResolvingNow = ref(false);
  const resolvedFileIds = ref<Set<string>>(new Set());
  const completedGroupIds = ref<Set<string>>(new Set());

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function resetProgress() {
    organizeProgress.value = {
      active: false,
      mode: 'single',
      status: 'idle',
      current: 0,
      total: 0,
      percent: 0,
      currentFileName: ''
    };
    resolvingNow.value = false;
    batchResolvingNow.value = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setProgress(data: Partial<OrganizeProgressState>) {
    organizeProgress.value = {
      ...organizeProgress.value,
      ...data
    };
  }

  // 轮询服务端真实异步进度 (即使用户关闭页面后重新打开，依然能无缝恢复进度条与状态)
  async function syncServerStatus() {
    try {
      const status = await tmdbOrganizeApi.getAsyncResolveStatus();
      if (!status) return;

      if (Array.isArray(status.resolvedIds)) {
        status.resolvedIds.forEach((id: string) => resolvedFileIds.value.add(String(id)));
      }
      if (Array.isArray(status.completedGroupIds)) {
        status.completedGroupIds.forEach((gid: string) => completedGroupIds.value.add(String(gid)));
      }

      if (status.active) {
        organizeProgress.value = {
          active: true,
          mode: status.mode || 'single',
          status: status.status || 'running',
          current: status.current || 0,
          total: status.total || 0,
          percent: status.percent || 0,
          currentGroupIndex: status.currentGroupIndex,
          totalGroups: status.totalGroups,
          groupTitle: status.groupTitle,
          currentFileName: status.currentFileName || '',
          processedCount: status.processedCount || 0,
          skippedCount: status.skippedCount || 0,
          failedCount: status.failedCount || 0
        };
        resolvingNow.value = (status.mode === 'single');
        batchResolvingNow.value = (status.mode === 'batch');

        if (!pollTimer) {
          pollTimer = setInterval(syncServerStatus, 1000);
        }
      } else {
        const wasActive = organizeProgress.value.active;
        if (wasActive) {
          // 刚从运行态变为结束态
          organizeProgress.value.active = false;
          organizeProgress.value.status = status.status || 'completed';
          organizeProgress.value.percent = 100;
          resolvingNow.value = false;
          batchResolvingNow.value = false;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
      return status;
    } catch (_) {
      // 网络偶发波动静默重试
    }
  }

  // 发起服务端驻留异步归档 (核心：由服务端 Node.js / Docker 容器全权接管，即使关闭浏览器也持续执行到底)
  async function startServerAsyncResolve(payload: {
    accountId?: number | string;
    mode: 'single' | 'batch';
    groups: any[];
    targetDirPath?: string;
    cleanEmptySourceDir?: boolean;
  }) {
    resolvedFileIds.value.clear();
    completedGroupIds.value.clear();

    const res = await tmdbOrganizeApi.startAsyncResolve(payload);
    if (res && res.success) {
      organizeProgress.value.active = true;
      organizeProgress.value.mode = payload.mode;
      organizeProgress.value.status = 'running';
      resolvingNow.value = (payload.mode === 'single');
      batchResolvingNow.value = (payload.mode === 'batch');

      if (!pollTimer) {
        pollTimer = setInterval(syncServerStatus, 1000);
      }
      // 立即触发一次拉取
      await syncServerStatus();
    }
    return res;
  }

  async function abortServerAsyncResolve() {
    return await tmdbOrganizeApi.abortAsyncResolve();
  }

  // 初始化时主动检查一次服务端是否有正在进行的任务
  syncServerStatus();

  return {
    organizeProgress,
    resolvingNow,
    batchResolvingNow,
    resolvedFileIds,
    completedGroupIds,
    resetProgress,
    setProgress,
    syncServerStatus,
    startServerAsyncResolve,
    abortServerAsyncResolve
  };
});

import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useLogStore = defineStore('log', () => {
  const logLines = ref<string[]>([]);
  const isConnected = ref(false);
  const isPaused = ref(false);
  const maxLogs = 2000; // 环形缓冲容量上限（扩容至2000行）

  let eventSource: EventSource | null = null;

  function connectSSE() {
    if (eventSource) return;

    eventSource = new EventSource('/api/logs/events');

    eventSource.onopen = () => {
      isConnected.value = true;
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'history') {
          const historyLogs = Array.isArray(data.logs) ? data.logs.slice(-maxLogs) : [];
          logLines.value = historyLogs;
        } else if (data.type === 'log') {
          const message = String(data.message || '');
          if (message) {
            logLines.value.push(message);
            if (logLines.value.length > maxLogs) {
              logLines.value.splice(0, logLines.value.length - maxLogs);
            }
          }
        }
      } catch {
        if (event.data) {
          logLines.value.push(String(event.data));
          if (logLines.value.length > maxLogs) {
            logLines.value.shift();
          }
        }
      }
    };

    eventSource.onerror = () => {
      isConnected.value = false;
      // 浏览器 EventSource 在连接断开时会自动重连
    };
  }

  function disconnectSSE() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      isConnected.value = false;
    }
  }

  function clearLogs() {
    logLines.value = [];
  }

  function togglePause() {
    isPaused.value = !isPaused.value;
  }

  return {
    logLines,
    isConnected,
    isPaused,
    connectSSE,
    disconnectSSE,
    clearLogs,
    togglePause,
  };
});

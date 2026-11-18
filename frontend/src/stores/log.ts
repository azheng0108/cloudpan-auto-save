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

    const normalizeMsg = (s: string) => {
      if (!s) return '';
      let str = s.replace(/^\[\d{4}[/-]\d{1,2}[/-]\d{1,2}[^\]]*\]\s*/, '');
      str = str.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, '');
      return str.trim();
    };

    const isRecentDuplicate = (clean: string) => {
      if (!clean) return true;
      const checkCount = Math.min(logLines.value.length, 5);
      for (let i = logLines.value.length - 1; i >= logLines.value.length - checkCount; i--) {
        if (normalizeMsg(logLines.value[i]) === clean) {
          return true;
        }
      }
      return false;
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'history') {
          const raw = Array.isArray(data.logs) ? data.logs : [];
          const deduped: string[] = [];
          const recentClean: string[] = [];
          for (const line of raw) {
            const clean = normalizeMsg(line);
            if (!clean || recentClean.includes(clean)) continue;
            recentClean.push(clean);
            if (recentClean.length > 5) recentClean.shift();
            deduped.push(line);
          }
          logLines.value = deduped.slice(-maxLogs);
        } else if (data.type === 'log') {
          const message = String(data.message || '');
          if (message) {
            const clean = normalizeMsg(message);
            if (!isRecentDuplicate(clean)) {
              logLines.value.push(message);
              if (logLines.value.length > maxLogs) {
                logLines.value.splice(0, logLines.value.length - maxLogs);
              }
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

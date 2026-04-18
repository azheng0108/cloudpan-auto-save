function initLogs() {
    const logsContainer = document.getElementById('logsContainer');
    const logsContainerModal = document.getElementById('logsContainerModal');
    const logsContainers = [logsContainer, logsContainerModal].filter(Boolean);
    const logsModal = document.getElementById('logsModal');
    if (logsContainers.length === 0) {
        return;
    }
    
    let eventSource = null;
    const MAX_VISIBLE_ITEMS = 200; // 增加到200条日志
    let logLines = [];

    function scrollToBottom() {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                logsContainers.forEach((container) => {
                    container.scrollTop = container.scrollHeight;
                });
            });
        });
    }

    function renderLogs() {
        const text = logLines.join('\n');
        logsContainers.forEach((container) => {
            container.textContent = text;
        });
        scrollToBottom();
    }
    
    function connectSSE() {
        eventSource = new EventSource('/api/logs/events');

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // 分发事件
            const customEvent = new CustomEvent('sseMessage', { detail: data });
            document.dispatchEvent(customEvent);

            if (data.type === 'history') {
                logLines = Array.isArray(data.logs) ? data.logs.slice(-MAX_VISIBLE_ITEMS) : [];
                renderLogs();
            } else if (data.type === 'log') {
                const message = String(data.message || '');
                if (message) {
                    logLines.push(message);
                    if (logLines.length > MAX_VISIBLE_ITEMS) {
                        logLines = logLines.slice(-MAX_VISIBLE_ITEMS);
                    }
                    renderLogs();
                }
            }
        };

        eventSource.onerror = () => {
            eventSource.close();
            setTimeout(connectSSE, 1000);
        };
    }

    // 如果弹窗存在，添加关闭功能（向后兼容）
    if (logsModal) {
        const closeBtn = logsModal.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.onclick = () => {
                logsModal.style.display = 'none';
            };
        }
        
        logsModal.onclick = (e) => {
            if (e.target === logsModal) {
                logsModal.style.display = 'none';
            }
        };
    }

    // 页面关闭时才断开连接
    window.addEventListener('beforeunload', () => {
        if (eventSource) {
            eventSource.close();
        }
    });

    // 当日志容器从不可见变为可见时（切换 Tab 或打开弹窗），自动滚到底部显示最新内容
    if (typeof IntersectionObserver !== 'undefined') {
        const visibilityObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) scrollToBottom();
            });
        }, { threshold: 0 });
        logsContainers.forEach(c => visibilityObserver.observe(c));
    }

    // 页面加载时自动连接
    connectSSE();
}

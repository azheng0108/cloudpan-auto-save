function initLogs() {
    const logsContainer = document.getElementById('logsContainer');
    const logsModal = document.getElementById('logsModal');
    
    let eventSource = null;
    const MAX_VISIBLE_ITEMS = 200; // 增加到200条日志
    
    function connectSSE() {
        eventSource = new EventSource('/api/logs/events');

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // 分发事件
            const customEvent = new CustomEvent('sseMessage', { detail: data });
            document.dispatchEvent(customEvent);

            if (data.type === 'history') {
                const logs = data.logs.join('\n');
                logsContainer.textContent = logs;
                logsContainer.scrollTop = logsContainer.scrollHeight;
            } else if (data.type === 'log') {
                // 添加新日志
                logsContainer.textContent += '\n' + data.message;
                
                // 如果日志行数超过限制，移除最旧的日志
                const lines = logsContainer.textContent.split('\n');
                if (lines.length > MAX_VISIBLE_ITEMS) {
                    logsContainer.textContent = lines.slice(-MAX_VISIBLE_ITEMS).join('\n');
                }
                
                // 自动滚动到底部
                logsContainer.scrollTop = logsContainer.scrollHeight;
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
    
    // 页面加载时自动连接
    connectSSE();
}

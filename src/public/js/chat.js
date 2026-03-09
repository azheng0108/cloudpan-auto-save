function showAIChat() {
    document.getElementById('aiChatModal').style.display = 'block';
    scrollToBottom();
}

function closeAIChat() {
    document.getElementById('aiChatModal').style.display = 'none';
}

function scrollToBottom() {
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addMessage(content, isUser = false) {
    const messagesDiv = document.getElementById('chatMessages');
    
    if (isUser) {
        // 用户消息直接显示
        const messageDiv = document.createElement('div');
        messageDiv.className = 'user-message';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'user-message-content';
        contentDiv.textContent = content;
        
        messageDiv.appendChild(contentDiv);
        messagesDiv.appendChild(messageDiv);
    } else {
        // 检查是否是结束标识
        if (content === '[END]') {
            return; // 不显示结束标识
        }
        
        // 检查是否已经存在AI的最后一条消息
        const lastMessage = messagesDiv.lastElementChild;
        if (lastMessage && lastMessage.classList.contains('ai-message')) {
            // 如果存在，就在最后一条消息的内容后追加
            const contentDiv = lastMessage.querySelector('.ai-message-content');
            contentDiv.textContent += content;
        } else {
            // 如果不存在，创建新的消息div
            const messageDiv = document.createElement('div');
            messageDiv.className = 'ai-message';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'ai-message-content';
            contentDiv.textContent = content;
            
            messageDiv.appendChild(contentDiv);
            messagesDiv.appendChild(messageDiv);
        }
    }
    scrollToBottom();
}

// 等待DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 处理用户输入
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', async function(e) {
            if (e.key === 'Enter' && this.value.trim()) {
                const message = this.value.trim();
                this.value = '';
                
                // 添加用户消息
                addMessage(message, true);
                
                // 发送消息到后端
                try {
                    const response = await fetch('/api/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ message })
                    });
                    
                    if (!response.ok) {
                        throw new Error('请求失败');
                    }
                } catch (error) {
                    console.error('发送消息失败:', error);
                    addMessage('发送消息失败，请重试', false);
                }
            }
        });
    }

    // 改用事件监听
    document.addEventListener('sseMessage', function(e) {
        const data = e.detail;
        if (data.type === 'aimessage') {
            // 处理AI消息
            addMessage(data.message, false);
        }
    });
});

// 点击其他地方关闭聊天窗口
window.onclick = function(event) {
    const modal = document.getElementById('aiChatModal');
    if (event.target === modal) {
        closeAIChat();
    }
}
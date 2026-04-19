// 选项卡切换
function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab + 'Tab').classList.add('active');
            // 切换到设置页时重新加载，确保展示最新保存值
            if (tab.dataset.tab === 'settings' && typeof loadSettings === 'function') {
                loadSettings();
            }
        });
    });
}
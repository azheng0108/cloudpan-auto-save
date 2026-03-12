let searchResults = [];
let selectedIndex = -1;

async function searchResources() {
    const keyword = document.getElementById('searchInput').value.trim();
    if (!keyword) {
        message.warning('请输入搜索关键字');
        return;
    }
    try {
        loading.show();
        const response = await fetch(`/api/cloudsaver/search?keyword=${keyword}`);
        const data = await response.json();
        if (data.success) {
            searchResults = data.data;
            renderResults();
        } else {
            message.error(data.error); 
        }
    } catch (error) {
        console.error('搜索失败:', error);
        message.error('搜索失败');
    } finally {
        loading.hide();
    }
}

function getCloudSource(link) {
    if (link.includes('cloud.189.cn')) return { label: '天翼云盘', type: 'cloud189' };
    if (link.includes('yun.139.com') || link.includes('caiyun.139.com')) return { label: '移动云盘', type: 'cloud139' };
    return { label: '其他', type: 'other' };
}

function renderResults() {
    const resultsDiv = document.querySelector('.cloudsaver-results-list');
    if (searchResults.length === 0) {
        resultsDiv.innerHTML = `<div class="cloudsaver-empty">未搜索到任何资源</div>`;
    } else {
        // 按来源分组
        const groups = {};
        searchResults.forEach((item, index) => {
            const link = item.cloudLinks[0].link;
            const source = getCloudSource(link);
            if (!groups[source.type]) {
                groups[source.type] = { label: source.label, type: source.type, items: [] };
            }
            groups[source.type].items.push({ item, index });
        });

        // 固定分组顺序
        const ORDER = ['cloud139', 'cloud189', 'other'];
        let html = `<div class="cloudsaver-credit">以下资源来自 <a href="https://github.com/jiangrui1994/cloudsaver" target="_blank">CloudSaver</a></div>`;

        ORDER.forEach(type => {
            const group = groups[type];
            if (!group) return;
            html += `
                <div class="cloudsaver-group" data-type="${group.type}">
                    <div class="cloudsaver-group-header" onclick="toggleGroup('${group.type}')">
                        <span class="cloudsaver-collapse-arrow">&#9660;</span>
                        <span class="cloudsaver-source-badge cloudsaver-source-${group.type}">${group.label}</span>
                        <span class="cloudsaver-group-count">${group.items.length} 个结果</span>
                    </div>
                    <div class="cloudsaver-group-body">
                        ${group.items.map(({ item, index }) => `
                            <div class="cloudsaver-result-item" data-index="${index}">
                                <span class="cloudsaver-item-title" title="${item.title}">${item.title}</span>
                                <div class="cloudsaver-row-actions">
                                    <button class="cloudsaver-row-btn" onclick="handleResourceAction(${index}, 'open')">打开</button>
                                    <button class="cloudsaver-row-btn cloudsaver-row-btn-primary" onclick="handleResourceAction(${index}, 'create')">转存</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });

        resultsDiv.innerHTML = html;
    }
    document.getElementById('searchResults').style.display = 'block';
}

function toggleGroup(type) {
    const groupEl = document.querySelector(`.cloudsaver-group[data-type="${type}"]`);
    if (groupEl) groupEl.classList.toggle('collapsed');
}

function closeCloudsaver() {
    document.getElementById('searchResults').style.display = 'none';
    document.querySelector('.cloudsaver-results-list').innerHTML = '';
    searchResults = [];
}

function handleResourceAction(index, action) {
    const resource = searchResults[index];
    if (action === 'open') {
        window.open(resource.cloudLinks[0].link, '_blank');
    } else if (action === 'create') {
        const link = resource.cloudLinks[0].link;
        const cloudType = getCloudSource(link).type;

        // 检查是否有匹配该云盘类型的账号
        const matchingAccount = (accountsList || []).find(a => a.accountType === cloudType);
        if (!matchingAccount) {
            const label = getCloudSource(link).label;
            message.error(`当前没有可用的 ${label} 账号，请先在"账号"页面添加对应账号`);
            return;
        }

        // 1. 先切换到任务 Tab，确保 createTaskModal 的父容器可见
        const taskTab = document.querySelector('.tab[data-tab="task"]');
        if (taskTab) taskTab.click();
        // 2. 打开弹窗
        openCreateTaskModal();
        // 3. 自动选中匹配云盘类型的账号
        const accountSelect = document.getElementById('accountId');
        if (accountSelect) {
            accountSelect.value = String(matchingAccount.id);
        }
        // 4. 填入分享链接
        const shareLinkInput = document.getElementById('shareLink');
        shareLinkInput.value = link;
        // 5. 触发解析（给 modal 渲染留一帧）
        setTimeout(() => {
            shareLinkInput.dispatchEvent(new Event('blur'));
        }, 50);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                searchResources();
            }
        });
    }
});
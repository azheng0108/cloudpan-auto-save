async function loadVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        const versionElement = document.getElementById('version');
        if (versionElement) {
            versionElement.innerText = `v${data.version}`;
        }
    } catch (error) {
        console.error('Failed to load version:', error);
    }
}

// 设置页版本显示兜底：即使 settings.js 未执行，也保证不长期停留在 loading...
async function loadSystemVersionFallback() {
    const versionElement = document.getElementById('systemVersion');
    if (!versionElement) return;

    try {
        const response = await fetch('/api/system/version');
        const data = await response.json();
        if (data?.success && data?.version) {
            versionElement.textContent = `v${data.version}`;
            return;
        }
    } catch (_) {
        // ignore and fallback to /api/version
    }

    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        if (data?.version) {
            versionElement.textContent = `v${data.version}`;
            return;
        }
    } catch (_) {
        // ignore
    }

    versionElement.textContent = 'unknown';
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function closeModalWithCleanup(modal) {
    if (!modal) return;

    const closeHandlers = {
        addAccountModal: typeof closeAddAccountModal === 'function' ? closeAddAccountModal : null,
        createTaskModal: typeof closeCreateTaskModal === 'function' ? closeCreateTaskModal : null,
        editTaskModal: typeof closeEditTaskModal === 'function' ? closeEditTaskModal : null,
        customPushManagementModal: typeof closeCustomPushManagementModal === 'function' ? closeCustomPushManagementModal : null,
        addEditCustomPushModal: typeof closeAddEditCustomPushModal === 'function' ? closeAddEditCustomPushModal : null,
        strmModal: typeof closeStrmModal === 'function' ? closeStrmModal : null
    };

    const handler = modal.id ? closeHandlers[modal.id] : null;
    if (typeof handler === 'function') {
        handler();
        return;
    }

    if (modal.classList.contains('files-list-modal') && typeof closeFileListModal === 'function') {
        closeFileListModal();
        return;
    }
    if (modal.classList.contains('rename-options-modal') && typeof closeRenameOptionsModal === 'function') {
        closeRenameOptionsModal();
        return;
    }
    if (modal.classList.contains('preview-rename-modal') && typeof closeRenamePreviewModal === 'function') {
        closeRenamePreviewModal();
        return;
    }

    modal.style.display = 'none';
}

function initGlobalModalInteractions() {
    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains('modal')) return;
        closeModalWithCleanup(target);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const openedModals = Array.from(document.querySelectorAll('.modal'))
            .filter((modal) => window.getComputedStyle(modal).display !== 'none');
        if (openedModals.length === 0) return;
        closeModalWithCleanup(openedModals[openedModals.length - 1]);
    });
}

// 主入口文件
document.addEventListener('DOMContentLoaded', () => {
     // 初始化macos样式
    const appTitle = document.getElementById('appTitle');
    if (appTitle) {
        if(localStorage.getItem('_currentTheme') === 'macos') {
            // 插入新的css
            const newCss = document.createElement('link');
            newCss.rel = 'stylesheet';
            newCss.href = '/css/macos.css';
            document.head.appendChild(newCss);
        }
        appTitle.addEventListener('click', (e) => {
            e.preventDefault();
           const currentTheme = localStorage.getItem('_currentTheme')
           if(currentTheme === 'macos') {
            localStorage.setItem('_currentTheme', '')
            // 移除macos样式
            const macosCss = document.querySelector('link[href="/css/macos.css"]');
            if (macosCss) {
                document.head.removeChild(macosCss);
            }
           } else {
            localStorage.setItem('_currentTheme', 'macos')
            // 插入新的css
           const newCss = document.createElement('link');
           newCss.rel = 'stylesheet';
           newCss.href = '/css/macos.css';
           document.head.appendChild(newCss);
           }
        });
    }
    // 加载版本号
    loadVersion();
    loadSystemVersionFallback();
    // 初始化所有功能
    initTabs();
    initAccountForm();
    initTaskForm();
    initEditTaskForm();
    // 初始化日志
    initLogs()
    // 统一弹窗交互（遮罩点击与 Esc 关闭）
    initGlobalModalInteractions();

    // 初始化目录选择器
    const folderSelector = new FolderSelector({
        enableFavorites: true,
        favoritesKey: 'createTaskFavorites',
        onSelect: ({ id, name, path }) => {
            document.getElementById('targetFolder').value = path;
            document.getElementById('targetFolderId').value = id;
        }
    });

    // 修改目录选择触发方式
    document.getElementById('targetFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('accountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        folderSelector.show(accountId);
    });

    // 添加常用目录按钮点击事件
    document.getElementById('favoriteFolderBtn').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('accountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        folderSelector.showFavorites(accountId);
    });

    // 初始化数据
    fetchAccounts(true);
    fetchTasks();

    // 定时刷新数据
    // setInterval(() => {
    //     fetchTasks();
    // }, 30000);
});


// 从缓存获取数据
function getFromCache(key) {
    // 拼接用户 ID
    const userId = document.getElementById('accountId').value;
    return localStorage.getItem(key + '_' + userId);
}
// 保存数据到缓存
function saveToCache(key, value) {
    const userId = document.getElementById('accountId').value;
    localStorage.setItem(key + '_' + userId, value);
}

document.addEventListener('DOMContentLoaded', function() {
    const tooltip = document.getElementById('regexTooltip');
    if (!tooltip) return;

    function isTooltipVisible() {
        return !tooltip.classList.contains('is-hidden');
    }

    function showRegexTooltip(anchorEl = null) {
        tooltip.classList.remove('is-hidden');
        tooltip.style.display = 'block';
        tooltip.style.zIndex = '3000';

        // 默认居中显示，避免被任意 modal 裁剪或遮挡
        tooltip.style.left = '50%';
        tooltip.style.top = '50%';
        tooltip.style.transform = 'translate(-50%, -50%)';
        tooltip.style.maxWidth = '90vw';
        tooltip.style.maxHeight = '80vh';
        tooltip.style.overflow = 'auto';

        tooltip._currentIcon = anchorEl || null;
    }

    function hideRegexTooltip() {
        tooltip.classList.add('is-hidden');
        tooltip.style.display = 'none';
    }

    window.openRegexTooltip = function(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        showRegexTooltip(event?.currentTarget || null);
    };

    window.closeRegexTooltip = function(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        hideRegexTooltip();
    };

    // 使用事件委托，监听整个文档的点击事件
    document.addEventListener('click', function(e) {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;

        // 检查点击的是否是帮助图标
        if (target.classList.contains('help-icon')) {
            e.stopPropagation();
            const helpIcon = target;
            const rect = helpIcon.getBoundingClientRect();
            const isVisible = isTooltipVisible();
            
            // 关闭弹窗
            if (isVisible && tooltip._currentIcon === helpIcon) {
                hideRegexTooltip();
                return;
            }

            // 显示弹窗
            showRegexTooltip(helpIcon);
            
            // 计算位置
            const viewportWidth = window.innerWidth;
            const tooltipWidth = tooltip.offsetWidth;
            
            // 移动端适配
            if (viewportWidth <= 768) {
                tooltip.style.left = '50%';
                tooltip.style.top = '50%';
                tooltip.style.transform = 'translate(-50%, -50%)';
                tooltip.style.maxWidth = '90vw';
                tooltip.style.maxHeight = '80vh';
                tooltip.style.overflow = 'auto';
            } else {
                let left = rect.left;
                if (left + tooltipWidth > viewportWidth) {
                    left = viewportWidth - tooltipWidth - 10;
                }
                tooltip.style.top = `${rect.bottom + 5}px`;
                tooltip.style.left = `${left}px`;
                tooltip.style.transform = 'none';
            }
        } else if (!tooltip.contains(target)) {
            // 点击其他地方关闭弹窗
            hideRegexTooltip();
        }
    });

    // 添加 ESC 键关闭
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            hideRegexTooltip();
        }
    });
});


function toggleHelpText(button) {
    if (!button) return;
    const helpText = button.nextElementSibling || button.parentElement?.querySelector('.form-text, .help-text');
    if (!helpText) return;

    // 与 .is-hidden { display:none !important } 保持一致，避免 inline style 被覆盖。
    helpText.classList.toggle('is-hidden');
    button.textContent = helpText.classList.contains('is-hidden') ? '显示帮助' : '隐藏帮助';
}
/**
 * FolderSelector — 统一目录选择器组件
 *
 * 内部使用 Shoelace <sl-tree> / <sl-tree-item> 渲染，解决多层嵌套排版与滚动穿透问题。
 * 外部 API（构造参数、show / showFavorites / close / setAccountId）保持不变，
 * main.js 和 edit-task.js 中的 3 个实例无需任何修改即可获得新体验。
 *
 * 依赖（由 index.html 全局引入）：
 *   - Lucide (lucide.createIcons)
 *   - Shoelace sl-tree + sl-tree-item (CDN ES module)
 */
class FolderSelector {
    constructor(options = {}) {
        this.title = options.title || '选择目录';
        this.onSelect = options.onSelect || (() => {});
        this.accountId = options.accountId || '';
        this.selectedNode = null;
        /** 当前选中的 <sl-tree-item> DOM 元素，供 promptCreateFolder 定位父目录 */
        this._selectedEl = null;
        this.modalId = 'folderModal_' + Math.random().toString(36).substr(2, 9);
        this.treeId  = 'folderTree_'  + Math.random().toString(36).substr(2, 9);
        this.enableFavorites = options.enableFavorites || false;
        this.favoritesKey    = options.favoritesKey    || 'defaultFavoriteDirectories';
        this.isShowingFavorites = false;
        this.currentPath = [];
        this.favorites   = [];

        // API 配置（外部可通过 options 覆盖，与原版完全兼容）
        this.apiConfig = {
            url:             options.apiUrl       || '/api/folders',
            buildParams:     options.buildParams  || ((accountId, folderId) => `${accountId}?folderId=${folderId}`),
            parseResponse:   options.parseResponse   || ((data) => data.data),
            validateResponse: options.validateResponse || ((data) => data.success)
        };

        this.buttons = options.buttons || [
            { text: '确定', class: 'btn-primary', action: 'confirm' },
            { text: '取消', class: 'btn-default', action: 'cancel'  }
        ];

        this.buttonCallbacks = {
            confirm: options.onConfirm || this.defaultConfirm.bind(this),
            cancel:  options.onCancel  || this.defaultCancel.bind(this),
            ...options.buttonCallbacks
        };

        this.initModal();
    }

    // ─── 常用目录（收藏夹）API ──────────────────────────────────────────────

    /** 从服务端获取当前账号的常用目录列表 */
    async getFavorites() {
        try {
            const response = await fetch(`/api/favorites/${this.accountId}`);
            const data = await response.json();
            if (!data.success) throw new Error(data.error || '获取常用目录失败');
            return data.data || [];
        } catch (error) {
            console.error('获取常用目录失败:', error);
            message.error('获取常用目录失败');
            return [];
        }
    }

    /** 将目录添加到收藏夹 */
    async addToFavorites(id, name, path) {
        if (this.favorites.find(f => f.id === id)) return;
        const finalPath = path || name;
        try {
            const res = await fetch('/api/favorites/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId: this.accountId, id, name, path: finalPath })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            this.favorites.push({ id, name, path: finalPath });
        } catch (error) {
            console.error('添加常用目录失败:', error);
            message.error('添加常用目录失败');
        }
    }

    /** 从收藏夹移除目录 */
    async removeFromFavorites(id) {
        try {
            const res = await fetch(`/api/favorites/${this.accountId}/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            const index = this.favorites.findIndex(f => f.id === id);
            if (index !== -1) this.favorites.splice(index, 1);
        } catch (error) {
            console.error('移除常用目录失败:', error);
            message.error('移除常用目录失败');
        }
    }

    // ─── 弹窗初始化 ─────────────────────────────────────────────────────────

    /**
     * 构建弹窗 HTML 并绑定基础事件。
     * 树容器改为 <sl-tree>，并通过 expand-icon / collapse-icon slot
     * 注入 Lucide chevron-right 图标，与全局 icon 风格保持一致。
     */
    initModal() {
        const modalHtml = `
            <div id="${this.modalId}" class="modal">
                <div class="modal-wrapper">
                    <div class="modal-content folder-modal-content">
                        <div class="modal-header">
                            <h3 class="modal-title">${this.title}</h3>
                            <div style="display:flex;gap:12px;align-items:center">
                                <a href="javascript:;" class="mkdir-link" data-action="mkdir" title="在当前选中目录下新建文件夹"
                                   style="display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--primary-color);text-decoration:none;">
                                    <i data-lucide="folder-plus" class="w-4 h-4"></i> 新建
                                </a>
                                <a href="javascript:;" class="refresh-link" data-action="refresh"
                                   style="display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--primary-color);text-decoration:none;">
                                    <i data-lucide="refresh-cw" class="w-4 h-4"></i> 刷新
                                </a>
                            </div>
                        </div>
                        <div class="form-body">
                            <!-- sl-tree 替代手写嵌套 div 树；expand/collapse 图标使用 Shoelace 内置样式，
                                 不注入 slot，避免 light DOM 渲染时出现多余可见箭头 -->
                            <sl-tree id="${this.treeId}"></sl-tree>
                        </div>
                        <div class="form-actions">
                        ${this.buttons.map(btn => `
                            <button class="${btn.class}" data-action="${btn.action}">${btn.text}</button>
                        `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;

        if (!document.getElementById(this.modalId)) {
            document.body.insertAdjacentHTML('beforeend', modalHtml);
        }

        this.modal      = document.getElementById(this.modalId);
        this.folderTree = document.getElementById(this.treeId);
        this.currentPath = [];

        // 遮罩点击关闭（与主页面 Modal 行为一致）
        const wrapper = this.modal.querySelector('.modal-wrapper');
        if (wrapper) {
            wrapper.addEventListener('click', (e) => {
                if (e.target === wrapper) this.close();
            });
        }

        // 全局选中事件：sl-tree 统一触发，替代原来每个 item 的 click 处理
        this.folderTree.addEventListener('sl-selection-change', (e) => {
            const selected = e.detail.selection[0];
            if (!selected) return;
            this._selectedEl  = selected;
            this.selectedNode = { id: selected.dataset.id, name: selected.dataset.name };
            this.currentPath  = (selected.dataset.path || '').split('/').filter(Boolean);
        });

        this.modal.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refreshTree());
        this.modal.querySelector('[data-action="mkdir"]').addEventListener('click',   () => this.promptCreateFolder());

        this.buttons.forEach(btn => {
            const button = this.modal.querySelector(`[data-action="${btn.action}"]`);
            if (button && this.buttonCallbacks[btn.action]) {
                button.addEventListener('click', () => this.buttonCallbacks[btn.action]());
            }
        });

        // 渲染 header 中的 Lucide 图标（全量调用兼容旧版 CDN）
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    // ─── 树操作 ─────────────────────────────────────────────────────────────

    /** 刷新目录树（保留原有行为：重新从根或收藏夹加载） */
    async refreshTree() {
        const refreshLink = this.modal.querySelector('.refresh-link');
        refreshLink.classList.add('loading');
        this.currentPath = [];
        try {
            if (this.isShowingFavorites) {
                this.favorites = await this.getFavorites();
                this.renderFolderNodes(this.favorites, this.folderTree, '');
            } else {
                await this.loadFolderNodes('-11', this.folderTree, true, '');
            }
        } finally {
            refreshLink.classList.remove('loading');
        }
    }

    /**
     * 移除 <sl-tree> 或 <sl-tree-item> 的直接子 sl-tree-item（保留 slot 注入的图标元素）。
     * 替代原有的 parentElement.innerHTML = ''，避免清除 expand/collapse icon slot。
     * @param {Element} el - sl-tree 或 sl-tree-item 元素
     */
    _clearTreeItems(el) {
        Array.from(el.querySelectorAll(':scope > sl-tree-item')).forEach(c => c.remove());
    }

    /**
     * 创建单个 <sl-tree-item> 节点，包含：
     * - 橙色 Lucide folder/file 图标（.sl-folder-icon，light DOM，CSS 直接控制颜色）
     * - 文件名 span（.sl-folder-name，超长截断）
     * - 收藏星星（.favorite-icon，enableFavorites 时才有，margin-left:auto 推到最右）
     * - 目录节点标记 lazy 属性，展开时触发 sl-lazy-load 异步加载子目录
     *
     * @param {object} node       - { id, name, isFile? }
     * @param {string} nodePath   - 完整相对路径（用于 dataset.path 和 currentPath）
     * @param {boolean} isFavorite - 是否已收藏（控制星星 active 状态）
     * @returns {HTMLElement} sl-tree-item 元素
     */
    _makeSlTreeItem(node, nodePath, isFavorite) {
        const item = document.createElement('sl-tree-item');
        item.dataset.id   = node.id;
        item.dataset.name = node.name;
        item.dataset.path = nodePath;

        // 橙色文件夹/文件图标（light DOM，folder-tree.css 直接通过 .sl-folder-icon 控制颜色）
        const iconWrap = document.createElement('span');
        iconWrap.className = 'sl-folder-icon';
        iconWrap.innerHTML = `<i data-lucide="${node.isFile ? 'file' : 'folder'}" class="w-4 h-4"></i>`;
        item.appendChild(iconWrap);

        // 文件名（收藏视图显示完整路径，树形视图显示单级名称）
        const nameSpan = document.createElement('span');
        nameSpan.className = 'sl-folder-name';
        nameSpan.textContent = this.isShowingFavorites ? nodePath : node.name;
        item.appendChild(nameSpan);

        // 收藏星星（enableFavorites 开启且不是文件时才渲染）
        if (this.enableFavorites && !node.isFile) {
            const star = document.createElement('span');
            star.className   = `favorite-icon${isFavorite ? ' active' : ''}`;
            star.dataset.id  = node.id;
            star.dataset.name = node.name;
            star.innerHTML   = '<i data-lucide="star" class="w-4 h-4"></i>';
            // 阻止冒泡，避免触发 sl-tree 的选中事件
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                const { id, name } = star.dataset;
                const isFav = this.favorites.some(f => f.id === id);
                if (!isFav) {
                    this.addToFavorites(id, name, nodePath);
                    star.classList.add('active');
                } else {
                    this.removeFromFavorites(id);
                    if (this.isShowingFavorites) {
                        item.remove(); // 收藏视图中移除后直接消失
                    } else {
                        star.classList.remove('active');
                    }
                }
            });
            item.appendChild(star);
        }

        // 目录节点：标记 lazy，sl-tree 展开时触发 sl-lazy-load 异步加载子目录
        if (!this.isShowingFavorites && !node.isFile) {
            item.setAttribute('lazy', '');
            item.addEventListener('sl-lazy-load', async () => {
                await this.loadFolderNodes(node.id, item, false, nodePath);
                // 加载完成后移除 lazy，下次展开直接显示已加载的子项
                item.removeAttribute('lazy');
            });
        }

        return item;
    }

    /**
     * 渲染目录/收藏夹节点列表到 parentElement。
     * parentElement 可以是 <sl-tree>（根级）或 <sl-tree-item>（子级懒加载时）。
     */
    async renderFolderNodes(nodes, parentElement = this.folderTree, parentPath = '') {
        // 清空已有 sl-tree-item（保留 sl-tree 的 slot 图标）
        this._clearTreeItems(parentElement);

        for (const node of nodes) {
            // 计算完整路径：收藏视图取 DB 存的 path，树形视图逐层累积
            const nodePath = this.isShowingFavorites
                ? (node.path && node.path !== node.id ? node.path : (node.name || node.id))
                : (parentPath ? `${parentPath}/${node.name}` : node.name);

            const isFavorite = this.favorites.some(f => f.id === node.id);
            const item = this._makeSlTreeItem(node, nodePath, isFavorite);
            parentElement.appendChild(item);
        }

        // 渲染所有新插入节点中的 Lucide 图标
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    /**
     * 从 API 异步加载目录子项并渲染。
     * 收藏视图模式下直接读取本地 favorites 列表。
     * @param {string}  folderId      - 要加载的目录 ID
     * @param {Element} parentElement - 注入子项的 sl-tree 或 sl-tree-item 元素
     * @param {boolean} refresh       - 是否强制刷新（追加 &refresh=true 参数）
     * @param {string}  parentPath    - 父目录的完整路径前缀
     */
    async loadFolderNodes(folderId, parentElement = this.folderTree, refresh = false, parentPath = '') {
        try {
            let nodes;
            if (this.isShowingFavorites) {
                nodes = await this.getFavorites();
            } else {
                const params = this.apiConfig.buildParams(this.accountId, folderId, this);
                const response = await fetch(`${this.apiConfig.url}/${params}${refresh ? '&refresh=true' : ''}`);
                const data = await response.json();
                if (!this.apiConfig.validateResponse(data)) {
                    throw new Error('获取目录失败: ' + (data.error || '未知错误'));
                }
                nodes = this.apiConfig.parseResponse(data);
            }
            await this.renderFolderNodes(nodes, parentElement, parentPath);
        } catch (error) {
            console.error('加载目录失败:', error);
            message.warning('加载目录失败');
        }
    }

    // ─── 新建文件夹 ──────────────────────────────────────────────────────────

    /**
     * 在当前选中目录（或根目录）弹出内联输入行，创建新文件夹。
     * 输入行以临时 <sl-tree-item> 包裹，保持缩进层级与整体样式一致。
     */
    async promptCreateFolder() {
        const selectedId      = this.selectedNode?.id;
        const hasRealSelection = selectedId && selectedId !== '-11';

        let parentFileId  = hasRealSelection ? selectedId : '/';
        let parentElement = this.folderTree;    // 默认插入根级
        let insertBefore  = this.folderTree.querySelector(':scope > sl-tree-item'); // 插到最前

        if (hasRealSelection && this._selectedEl) {
            if (this.isShowingFavorites) {
                // 收藏视图：插入到选中项后方（同级）
                parentElement = this._selectedEl.parentElement || this.folderTree;
                insertBefore  = this._selectedEl.nextElementSibling;
            } else {
                // 树形视图：确保选中项已展开，插入到其子项最前
                if (!this._selectedEl.expanded) {
                    await this.loadFolderNodes(selectedId, this._selectedEl, false,
                        this._selectedEl.dataset.path || '');
                    this._selectedEl.expanded = true;
                }
                parentElement = this._selectedEl;
                insertBefore  = this._selectedEl.querySelector(':scope > sl-tree-item');
            }
        }

        // 防止重复创建输入行
        if (parentElement.querySelector('.mkdir-input-row')) {
            parentElement.querySelector('.mkdir-input')?.focus();
            return;
        }

        // 用临时 sl-tree-item 包裹输入行，保持缩进层级
        const inputItem = document.createElement('sl-tree-item');
        inputItem.className = 'mkdir-input-row';
        inputItem.innerHTML = `
            <span class="sl-folder-icon"><i data-lucide="folder" class="w-4 h-4"></i></span>
            <input type="text" class="mkdir-input" placeholder="新文件夹名称" />
            <span class="mkdir-confirm" title="确定（Enter）">✓</span>
            <span class="mkdir-cancel"  title="取消（Esc）">✗</span>
        `;
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
        parentElement.insertBefore(inputItem, insertBefore);

        const input = inputItem.querySelector('.mkdir-input');
        // 等待 Web Component 升级后 focus（sl-tree-item 有 shadow DOM 渲染延迟）
        setTimeout(() => input?.focus(), 50);

        const doCreate = async () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            inputItem.remove();
            try {
                const res = await fetch('/api/folders/mkdir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId: this.accountId, parentFileId, folderName: name })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error || '创建失败');
                const newNode = { id: data.data.fileId, name: data.data.name };
                this._insertNewFolderItem(newNode, parentElement, insertBefore);
                message.success('文件夹创建成功');
            } catch (e) {
                message.error('创建失败：' + e.message);
            }
        };

        const doCancel = () => inputItem.remove();
        inputItem.querySelector('.mkdir-confirm').addEventListener('click', doCreate);
        inputItem.querySelector('.mkdir-cancel').addEventListener('click',  doCancel);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  doCreate();
            if (e.key === 'Escape') doCancel();
        });
        // 阻止点击输入行触发 sl-tree 选中事件
        inputItem.addEventListener('click', (e) => e.stopPropagation());
    }

    /**
     * 创建 API 成功后，直接插入新的 sl-tree-item 节点（不刷新整棵树）。
     * 与 promptCreateFolder 配套使用。
     */
    _insertNewFolderItem(newNode, parentElement, insertBefore = null) {
        // 父目录路径来自选中项（树形视图）或根（根级新建）
        const parentPath = this._selectedEl?.dataset?.path || '';
        const nodePath   = parentPath ? `${parentPath}/${newNode.name}` : newNode.name;

        const isFavorite = this.favorites.some(f => f.id === newNode.id);
        const item = this._makeSlTreeItem(newNode, nodePath, isFavorite);
        parentElement.insertBefore(item, insertBefore);

        // 新建完成后自动选中该节点
        item.selected    = true;
        this._selectedEl  = item;
        this.selectedNode = { id: newNode.id, name: newNode.name };
        this.currentPath  = nodePath.split('/').filter(Boolean);

        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    // ─── 选中状态 ────────────────────────────────────────────────────────────

    /**
     * 以编程方式选中某个 sl-tree-item，并同步内部状态。
     * 收藏夹视图单击后通过此方法触发，树形视图由 sl-selection-change 全局处理。
     * @param {object}  node    - { id, name }
     * @param {Element} element - 对应的 sl-tree-item 元素
     */
    selectFolder(node, element) {
        element.selected  = true;  // sl-tree 会自动清除其他项的选中状态
        this._selectedEl  = element;
        this.selectedNode = node;
        const fullPath    = element.dataset.path || node.name || '';
        this.currentPath  = fullPath ? fullPath.split('/').filter(Boolean) : [];
    }

    // ─── 公共方法（外部调用 API）────────────────────────────────────────────

    /** 打开弹窗，展示普通目录树 */
    async show(accountId = '') {
        if (accountId) this.accountId = accountId;
        if (!this.accountId) { message.warning('请先选择账号'); return; }

        this.modal.style.display = 'flex';
        this.modal.style.zIndex  = 1001;
        this.selectedNode        = null;
        this._selectedEl         = null;
        this.isShowingFavorites  = false;
        this.favorites = await this.getFavorites();
        this.modal.querySelector('.modal-title').textContent = this.title;
        await this.loadFolderNodes('-11', this.folderTree, false, '');
    }

    /** 打开弹窗，展示常用目录（收藏夹）列表 */
    async showFavorites(accountId = '') {
        if (accountId) this.accountId = accountId;
        if (!this.accountId) { message.warning('请先选择账号'); return; }

        this.modal.style.display = 'flex';
        this.modal.style.zIndex  = 1001;
        this.selectedNode        = null;
        this._selectedEl         = null;
        this.isShowingFavorites  = true;
        this.favorites = await this.getFavorites();
        this.modal.querySelector('.modal-title').textContent = '常用目录';
        // 收藏视图中隐藏新建按钮
        const mkdirLink = this.modal.querySelector('.mkdir-link');
        if (mkdirLink) mkdirLink.style.display = 'none';
        await this.renderFolderNodes(this.favorites, this.folderTree, '');
    }

    /** 关闭弹窗并重置 DOM（重新 initModal 保证下次打开状态干净） */
    close() {
        this.modal.style.display = 'none';
        const mkdirLink = this.modal.querySelector('.mkdir-link');
        if (mkdirLink) mkdirLink.style.display = '';
        this.modal.remove();
        this.initModal();
    }

    /** 更新当前账号 ID */
    setAccountId(accountId) {
        this.accountId = accountId;
    }

    /** 确定按钮默认行为：将选中节点回调给 onSelect，然后关闭弹窗 */
    defaultConfirm() {
        if (this.selectedNode) {
            this.onSelect({
                id:   this.selectedNode.id,
                name: this.selectedNode.name,
                path: this.currentPath.join('/')
            });
            this.close();
        } else {
            message.warning('请选择一个目录');
        }
    }

    /** 取消按钮默认行为 */
    defaultCancel() {
        this.close();
    }
}

// 导出到全局，main.js 和 edit-task.js 通过 window.FolderSelector 访问
window.FolderSelector = FolderSelector;

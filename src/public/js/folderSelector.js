/**
 * FolderSelector — 统一目录选择器组件
 *
 * 使用纯原生 HTML/CSS 实现树形视图，零外部依赖（无 Shoelace、无 Lucide）。
 * 图标以内联 SVG 常量实现，彻底消除 CDN 加载时序问题。
 *
 * 外部 API（构造参数、show / showFavorites / close / setAccountId）保持不变，
 * main.js 和 edit-task.js 中的实例无需任何修改。
 *
 * 树 DOM 结构：
 *   div.ft-tree
 *     div.ft-item[data-id][data-name][data-path]
 *       div.ft-row
 *         span.ft-chevron   ← SVG chevron，叶节点加 data-leaf 隐藏
 *         span.ft-icon      ← SVG folder/file，选中时变蓝
 *         span.ft-name      ← 文件夹名，超长截断
 *         span.ft-star      ← SVG star，enableFavorites 时才有
 *       div.ft-children     ← 子节点容器，展开时 display:block
 */

// ── 内联 SVG 图标常量（不依赖 Lucide）────────────────────────────────────────

/** chevron-right：展开箭头，由 CSS rotate(90deg) 实现展开态 */
const SVG_CHEVRON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="9 18 15 12 9 6"/>
</svg>`;

/** folder：橙色文件夹图标 */
const SVG_FOLDER = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
</svg>`;

/** file：文件图标（isFile 节点使用） */
const SVG_FILE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
  <polyline points="13 2 13 9 20 9"/>
</svg>`;

/** star：收藏星标，active 时 fill 实心 */
const SVG_STAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
</svg>`;

/** folder-plus：新建文件夹图标（header 用，保留 Lucide 兼容） */
const SVG_FOLDER_PLUS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
</svg>`;

/** refresh-cw：刷新图标（header 用） */
const SVG_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="23 4 23 10 17 10"/>
  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
</svg>`;

// ── FolderSelector 类 ────────────────────────────────────────────────────────

class FolderSelector {
    constructor(options = {}) {
        this.title    = options.title    || '选择目录';
        this.onSelect = options.onSelect || (() => {});
        this.accountId = options.accountId || '';

        /** 当前选中的 .ft-item 元素 */
        this._selectedEl  = null;
        this.selectedNode = null;
        this.currentPath  = [];

        this.modalId = 'folderModal_' + Math.random().toString(36).substr(2, 9);
        this.treeId  = 'folderTree_'  + Math.random().toString(36).substr(2, 9);

        this.enableFavorites = options.enableFavorites || false;
        this.isShowingFavorites = false;
        this.favorites = [];

        // API 配置（保持与原版兼容）
        this.apiConfig = {
            url:              options.apiUrl          || '/api/folders',
            buildParams:      options.buildParams     || ((accountId, folderId) => `${accountId}?folderId=${folderId}`),
            parseResponse:    options.parseResponse   || ((data) => data.data),
            validateResponse: options.validateResponse || ((data) => data.success),
        };

        this.buttons = options.buttons || [
            { text: '确定', class: 'btn-primary', action: 'confirm' },
            { text: '取消', class: 'btn-default', action: 'cancel'  },
        ];

        this.buttonCallbacks = {
            confirm: options.onConfirm || this.defaultConfirm.bind(this),
            cancel:  options.onCancel  || this.defaultCancel.bind(this),
            ...options.buttonCallbacks,
        };

        this.initModal();
    }

    // ── 收藏夹 API ────────────────────────────────────────────────────────────

    async getFavorites() {
        try {
            const res  = await fetch(`/api/favorites/${this.accountId}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '获取常用目录失败');
            return data.data || [];
        } catch (err) {
            console.error('获取常用目录失败:', err);
            message.error('获取常用目录失败');
            return [];
        }
    }

    async addToFavorites(id, name, nodePath) {
        if (this.favorites.find(f => f.id === id)) return;
        const finalPath = nodePath || name;
        try {
            const res  = await fetch('/api/favorites/add', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ accountId: this.accountId, id, name, path: finalPath }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            this.favorites.push({ id, name, path: finalPath });
        } catch (err) {
            console.error('添加常用目录失败:', err);
            message.error('添加常用目录失败');
        }
    }

    async removeFromFavorites(id) {
        try {
            const res  = await fetch(`/api/favorites/${this.accountId}/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            const idx = this.favorites.findIndex(f => f.id === id);
            if (idx !== -1) this.favorites.splice(idx, 1);
        } catch (err) {
            console.error('移除常用目录失败:', err);
            message.error('移除常用目录失败');
        }
    }

    // ── 弹窗初始化 ────────────────────────────────────────────────────────────

    /**
     * 构建弹窗 HTML（使用原生 div.ft-tree，无需任何 Web Components 库）并绑定事件。
     */
    initModal() {
        const modalHtml = `
            <div id="${this.modalId}" class="modal">
                <div class="modal-wrapper">
                    <div class="modal-content folder-modal-content">
                        <div class="modal-header">
                            <h3 class="modal-title">${this.title}</h3>
                            <div style="display:flex;gap:12px;align-items:center">
                                <a href="javascript:;" class="mkdir-link" data-action="mkdir"
                                   title="在当前选中目录下新建文件夹"
                                   style="display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--primary-color);text-decoration:none;">
                                    ${SVG_FOLDER_PLUS} 新建
                                </a>
                                <a href="javascript:;" class="refresh-link" data-action="refresh"
                                   style="display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--primary-color);text-decoration:none;">
                                    ${SVG_REFRESH} 刷新
                                </a>
                            </div>
                        </div>
                        <div class="form-body">
                            <div class="ft-tree" id="${this.treeId}"></div>
                        </div>
                        <div class="form-actions">
                            ${this.buttons.map(btn =>
                                `<button class="${btn.class}" data-action="${btn.action}">${btn.text}</button>`
                            ).join('')}
                        </div>
                    </div>
                </div>
            </div>`;

        if (!document.getElementById(this.modalId)) {
            document.body.insertAdjacentHTML('beforeend', modalHtml);
        }

        this.modal      = document.getElementById(this.modalId);
        this.folderTree = document.getElementById(this.treeId);
        this.currentPath = [];

        // 遮罩点击关闭
        const wrapper = this.modal.querySelector('.modal-wrapper');
        if (wrapper) {
            wrapper.addEventListener('click', (e) => {
                if (e.target === wrapper) this.close();
            });
        }

        this.modal.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refreshTree());
        this.modal.querySelector('[data-action="mkdir"]').addEventListener('click',   () => this.promptCreateFolder());

        this.buttons.forEach(btn => {
            const el = this.modal.querySelector(`[data-action="${btn.action}"]`);
            if (el && this.buttonCallbacks[btn.action]) {
                el.addEventListener('click', () => this.buttonCallbacks[btn.action]());
            }
        });
    }

    // ── 树操作 ────────────────────────────────────────────────────────────────

    /** 刷新目录树 */
    async refreshTree() {
        const link = this.modal.querySelector('.refresh-link');
        link.classList.add('loading');
        this.currentPath = [];
        try {
            if (this.isShowingFavorites) {
                this.favorites = await this.getFavorites();
                await this.renderFolderNodes(this.favorites, this.folderTree, '');
            } else {
                await this.loadFolderNodes('-11', this.folderTree, true, '');
            }
        } finally {
            link.classList.remove('loading');
        }
    }

    /**
     * 清空容器内的直接子 .ft-item 元素（保留 .mkdir-input-row）。
     * @param {Element} el — .ft-tree 或 .ft-children 容器
     */
    _clearTreeItems(el) {
        Array.from(el.querySelectorAll(':scope > .ft-item')).forEach(c => c.remove());
    }

    /**
     * 创建单个原生 .ft-item 节点。
     * - chevron 展开箭头（叶节点加 data-leaf，CSS 隐藏但保留占位）
     * - ft-icon   文件夹/文件 SVG 图标
     * - ft-name   目录名（超长截断）
     * - ft-star   收藏星星（enableFavorites && !isFile 时才渲染）
     * - ft-children 子节点容器（懒加载，展开时填充）
     *
     * @param {object}  node       — { id, name, isFile? }
     * @param {string}  nodePath   — 完整相对路径
     * @param {boolean} isFavorite — 是否已收藏
     * @returns {HTMLElement}
     */
    _makeTreeItem(node, nodePath, isFavorite) {
        const item = document.createElement('div');
        item.className    = 'ft-item';
        item.dataset.id   = node.id;
        item.dataset.name = node.name;
        item.dataset.path = nodePath;

        // ── 行（可点击区域）───────────────────────────────────────────
        const row = document.createElement('div');
        row.className = 'ft-row';

        // 展开箭头
        const chevron = document.createElement('span');
        chevron.className   = 'ft-chevron';
        chevron.innerHTML   = SVG_CHEVRON;
        if (node.isFile) item.dataset.leaf = '';   // 叶节点：CSS visibility:hidden
        row.appendChild(chevron);

        // 文件夹/文件图标
        const icon = document.createElement('span');
        icon.className = 'ft-icon';
        icon.innerHTML = node.isFile ? SVG_FILE : SVG_FOLDER;
        row.appendChild(icon);

        // 目录名（收藏视图显示完整路径）
        const nameEl = document.createElement('span');
        nameEl.className   = 'ft-name';
        nameEl.textContent = this.isShowingFavorites ? nodePath : node.name;
        row.appendChild(nameEl);

        // 收藏星星
        if (this.enableFavorites && !node.isFile) {
            const star = document.createElement('span');
            star.className = 'ft-star' + (isFavorite ? ' active' : '');
            star.innerHTML = SVG_STAR;
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                const isFav = this.favorites.some(f => f.id === node.id);
                if (!isFav) {
                    this.addToFavorites(node.id, node.name, nodePath);
                    star.classList.add('active');
                } else {
                    this.removeFromFavorites(node.id);
                    if (this.isShowingFavorites) {
                        item.remove();
                    } else {
                        star.classList.remove('active');
                    }
                }
            });
            row.appendChild(star);
        }

        item.appendChild(row);

        // ── 子节点容器 ─────────────────────────────────────────────────
        const children = document.createElement('div');
        children.className = 'ft-children';
        item.appendChild(children);

        // ── 点击行：选中 + 展开/折叠（含懒加载）──────────────────────
        row.addEventListener('click', async (e) => {
            if (e.target.closest('.ft-star')) return; // 星星自行处理

            this._selectItem(item);

            if (node.isFile) return; // 文件节点不展开

            if ('expanded' in item.dataset) {
                // 已展开 → 折叠
                delete item.dataset.expanded;
            } else {
                // 未展开 → 懒加载（只在第一次展开时请求 API）
                if (!('loaded' in item.dataset)) {
                    chevron.classList.add('ft-loading');
                    await this.loadFolderNodes(node.id, children, false, nodePath);
                    chevron.classList.remove('ft-loading');
                    item.dataset.loaded = '';
                }
                item.dataset.expanded = '';
            }
        });

        return item;
    }

    /**
     * 将 .ft-item 设为选中态，清除旧选中，同步内部状态。
     * @param {HTMLElement} item
     */
    _selectItem(item) {
        if (this._selectedEl) delete this._selectedEl.dataset.selected;
        item.dataset.selected = '';
        this._selectedEl  = item;
        this.selectedNode = { id: item.dataset.id, name: item.dataset.name };
        this.currentPath  = (item.dataset.path || '').split('/').filter(Boolean);
    }

    /**
     * 渲染目录/收藏夹节点列表到 parentElement。
     * @param {Array}   nodes
     * @param {Element} parentElement — .ft-tree 或 .ft-children
     * @param {string}  parentPath
     */
    async renderFolderNodes(nodes, parentElement = this.folderTree, parentPath = '') {
        this._clearTreeItems(parentElement);

        for (const node of nodes) {
            const nodePath = this.isShowingFavorites
                ? (node.path && node.path !== node.id ? node.path : (node.name || node.id))
                : (parentPath ? `${parentPath}/${node.name}` : node.name);

            const isFavorite = this.favorites.some(f => f.id === node.id);
            parentElement.appendChild(this._makeTreeItem(node, nodePath, isFavorite));
        }
    }

    /**
     * 从 API 异步加载目录子项并渲染。
     * @param {string}  folderId
     * @param {Element} parentElement
     * @param {boolean} refresh
     * @param {string}  parentPath
     */
    async loadFolderNodes(folderId, parentElement = this.folderTree, refresh = false, parentPath = '') {
        try {
            let nodes;
            if (this.isShowingFavorites) {
                nodes = await this.getFavorites();
            } else {
                const params   = this.apiConfig.buildParams(this.accountId, folderId, this);
                const response = await fetch(`${this.apiConfig.url}/${params}${refresh ? '&refresh=true' : ''}`);
                const data     = await response.json();
                if (!this.apiConfig.validateResponse(data)) {
                    throw new Error('获取目录失败: ' + (data.error || '未知错误'));
                }
                nodes = this.apiConfig.parseResponse(data);
            }
            await this.renderFolderNodes(nodes, parentElement, parentPath);
        } catch (err) {
            console.error('加载目录失败:', err);
            message.warning('加载目录失败');
        }
    }

    // ── 新建文件夹 ────────────────────────────────────────────────────────────

    /**
     * 在当前选中目录（或根目录）插入内联输入行，创建新文件夹。
     */
    async promptCreateFolder() {
        const selectedId       = this.selectedNode?.id;
        const hasRealSelection = selectedId && selectedId !== '-11';

        let parentFileId  = hasRealSelection ? selectedId : '/';
        let parentElement = this.folderTree;
        let insertBefore  = this.folderTree.querySelector(':scope > .ft-item');

        if (hasRealSelection && this._selectedEl) {
            if (this.isShowingFavorites) {
                parentElement = this._selectedEl.parentElement || this.folderTree;
                insertBefore  = this._selectedEl.nextElementSibling;
            } else {
                const childContainer = this._selectedEl.querySelector('.ft-children');
                // 确保选中项已展开（需要先加载子项）
                if (!('expanded' in this._selectedEl.dataset)) {
                    if (!('loaded' in this._selectedEl.dataset)) {
                        await this.loadFolderNodes(selectedId, childContainer, false,
                            this._selectedEl.dataset.path || '');
                        this._selectedEl.dataset.loaded = '';
                    }
                    this._selectedEl.dataset.expanded = '';
                }
                parentElement = childContainer;
                insertBefore  = childContainer.querySelector(':scope > .ft-item');
            }
        }

        // 防止重复插入输入行
        if (parentElement.querySelector('.mkdir-input-row')) {
            parentElement.querySelector('.mkdir-input')?.focus();
            return;
        }

        // 内联输入行（样式由 folder-tree.css 的 .mkdir-input-row 控制）
        const inputRow = document.createElement('div');
        inputRow.className = 'ft-item mkdir-input-row';
        inputRow.innerHTML = `
            <div class="ft-row" style="padding-left:0">
                <span class="ft-chevron" style="visibility:hidden">${SVG_CHEVRON}</span>
                <span class="ft-icon">${SVG_FOLDER}</span>
                <input type="text" class="mkdir-input" placeholder="新文件夹名称" />
                <span class="mkdir-confirm" title="确定（Enter）">✓</span>
                <span class="mkdir-cancel"  title="取消（Esc）">✗</span>
            </div>`;

        parentElement.insertBefore(inputRow, insertBefore);

        const input = inputRow.querySelector('.mkdir-input');
        setTimeout(() => input?.focus(), 20);

        const doCreate = async () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            inputRow.remove();
            try {
                const res  = await fetch('/api/folders/mkdir', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ accountId: this.accountId, parentFileId, folderName: name }),
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

        const doCancel = () => inputRow.remove();
        inputRow.querySelector('.mkdir-confirm').addEventListener('click', doCreate);
        inputRow.querySelector('.mkdir-cancel').addEventListener('click',  doCancel);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  doCreate();
            if (e.key === 'Escape') doCancel();
        });
        // 阻止点击输入行触发父容器事件
        inputRow.addEventListener('click', (e) => e.stopPropagation());
    }

    /**
     * API 创建成功后直接插入新的 .ft-item，不刷新整棵树。
     */
    _insertNewFolderItem(newNode, parentElement, insertBefore = null) {
        const parentPath = this._selectedEl?.dataset?.path || '';
        const nodePath   = parentPath ? `${parentPath}/${newNode.name}` : newNode.name;
        const isFavorite = this.favorites.some(f => f.id === newNode.id);
        const item       = this._makeTreeItem(newNode, nodePath, isFavorite);
        parentElement.insertBefore(item, insertBefore);
        this._selectItem(item);
    }

    // ── 选中状态（外部调用兼容接口）─────────────────────────────────────────

    /**
     * 以编程方式选中某个 .ft-item。
     * @param {object}  node    — { id, name }
     * @param {Element} element — 对应的 .ft-item 元素
     */
    selectFolder(node, element) {
        this._selectItem(element);
    }

    // ── 公共方法 ──────────────────────────────────────────────────────────────

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

    /** 打开弹窗，展示常用目录（收藏夹） */
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
        const mkdirLink = this.modal.querySelector('.mkdir-link');
        if (mkdirLink) mkdirLink.style.display = 'none';
        await this.renderFolderNodes(this.favorites, this.folderTree, '');
    }

    /** 关闭弹窗并重置 DOM */
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

    /** 确定按钮默认行为 */
    defaultConfirm() {
        if (this.selectedNode) {
            this.onSelect({
                id:   this.selectedNode.id,
                name: this.selectedNode.name,
                path: this.currentPath.join('/'),
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

class FolderSelector {
    constructor(options = {}) {
        this.title = options.title || '选择目录';
        this.onSelect = options.onSelect || (() => {});
        this.accountId = options.accountId || '';
        this.selectedNode = null;
        this.modalId = 'folderModal_' + Math.random().toString(36).substr(2, 9);
        this.treeId = 'folderTree_' + Math.random().toString(36).substr(2, 9);
        this.enableFavorites = options.enableFavorites || false; // 是否启用常用目录功能
        this.favoritesKey = options.favoritesKey || 'defaultFavoriteDirectories'; // 常用目录缓存key
        this.isShowingFavorites = false;
        this.currentPath = []; 
        this.favorites = []
        // API配置
        this.apiConfig = {
            url: options.apiUrl || '/api/folders', // 默认API地址
            buildParams: options.buildParams || ((accountId, folderId) => `${accountId}?folderId=${folderId}`), // 构建请求参数
            parseResponse: options.parseResponse || ((data) => data.data), // 解析响应数据
            validateResponse: options.validateResponse || ((data) => data.success) // 验证响应数据
        };


        this.buttons = options.buttons || [
            {
                text: '确定',
                class: 'btn-primary',
                action: 'confirm'
            },
            {
                text: '取消',
                class: 'btn-default',
                action: 'cancel'
            }
        ];

        // 新增按钮回调函数配置
        this.buttonCallbacks = {
            confirm: options.onConfirm || this.defaultConfirm.bind(this),
            cancel: options.onCancel || this.defaultCancel.bind(this),
            ...options.buttonCallbacks
        };
        
        this.initModal();
    }

    // 获取常用目录
    async getFavorites() {
        try {
            const response = await fetch(`/api/favorites/${this.accountId}`);
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || '获取常用目录失败');
            }
            return data.data || [];
        } catch (error) {
            console.error('获取常用目录失败:', error);
            message.error('获取常用目录失败');
            return [];
        }
    }

    // 保存常用目录
    saveFavorites(favorites) {
        localStorage.setItem(this.favoritesKey, JSON.stringify(favorites));
        // 调用接口存储常用目录
        fetch('/api/saveFavorites', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({favorites, accountId:this.accountId}),
        })
    }
    // 添加到常用目录
    async addToFavorites(id, name, element) {
        const favorites = await this.getFavorites();
        if (!favorites.find(f => f.id === id)) {
            // 获取当前选中节点的完整路径
            const path = this.getNodePath(element);
            favorites.push({ id, name, path });
            this.saveFavorites(favorites);
        }
    }

    // 从常用目录移除
    async removeFromFavorites(id) {
        const favorites = await this.getFavorites();
        const index = favorites.findIndex(f => f.id === id);
        if (index !== -1) {
            favorites.splice(index, 1);
            this.saveFavorites(favorites);
        }
    }

    getNodePath(element) {
        const path = [];
        let current = element;
        
        while (current && !current.classList.contains('folder-tree')) {
            if (current.classList.contains('folder-tree-item')) {
                const nameElement = current.querySelector('.folder-name');
                if (nameElement) {
                    // 如果是在常用目录视图中，需要处理完整路径显示
                    const displayName = nameElement.textContent;
                    if (!this.isShowingFavorites) {
                        path.unshift(displayName);
                    }
                }
            }
            current = current.parentElement;
        }
        return path.join('/');
    }

    initModal() {
        // 创建模态框HTML
        const modalHtml = `
            <div id="${this.modalId}" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 class="modal-title">${this.title}</h3>
                        <div style="display:flex;gap:12px;align-items:center">
                            <a href="javascript:;" class="mkdir-link" data-action="mkdir" title="在当前选中目录下新建文件夹">
                                <span>📁+</span> 新建
                            </a>
                            <a href="javascript:;" class="refresh-link" data-action="refresh">
                                <span class="refresh-icon">🔄</span> 刷新
                            </a>
                        </div>
                    </div>
                    <div class="form-body">
                        <div id="${this.treeId}" class="folder-tree"></div>
                    </div>
                    <div class="form-actions">
                    ${this.buttons.map(btn => `
                        <button class="${btn.class}" data-action="${btn.action}">${btn.text}</button>
                    `).join('')}
                    </div>
                </div>
            </div>
        `;

        // 添加到文档中
        if (!document.getElementById(this.modalId)) {
            document.body.insertAdjacentHTML('beforeend', modalHtml);
        }

        this.modal = document.getElementById(this.modalId);
        this.folderTree = document.getElementById(this.treeId);
        this.currentPath = []
        // 绑定事件
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });
        // 添加刷新事件监听
        this.modal.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refreshTree());
        // 新建文件夹按钮
        this.modal.querySelector('[data-action="mkdir"]').addEventListener('click', () => this.promptCreateFolder());
        this.buttons.forEach(btn => {
            const button = this.modal.querySelector(`[data-action="${btn.action}"]`);
            if (button && this.buttonCallbacks[btn.action]) {
                button.addEventListener('click', () => this.buttonCallbacks[btn.action]());
            }
        });
    }

    // 添加刷新方法
    async refreshTree() {
        const refreshLink = this.modal.querySelector('.refresh-link');
        refreshLink.classList.add('loading');
        this.currentPath = []; 
        try {
            if (this.isShowingFavorites) {
                await this.loadFolderNodes(null, this.folderTree, false);
            } else {
                await this.loadFolderNodes('-11', this.folderTree, true);
            }
        } finally {
            refreshLink.classList.remove('loading');
        }
    }

    async promptCreateFolder() {
        // 确定父目录：选中节点或根目录
        const selectedId = this.selectedNode?.id;
        const hasRealSelection = selectedId && selectedId !== '-11';

        let parentFileId = hasRealSelection ? selectedId : '/';
        let parentElement = null;
        let insertBefore = null; // null = append / child = insert before

        if (hasRealSelection) {
            const parentItem = this.modal.querySelector('.folder-tree-item.selected');
            if (parentItem) {
                const childrenEl = parentItem.querySelector('.folder-children');
                if (childrenEl) {
                    // 普通树形视图：展开后插入到子目录顶部
                    if (!parentItem.classList.contains('expanded')) {
                        await this.loadFolderNodes(selectedId, childrenEl);
                        parentItem.classList.add('expanded');
                    }
                    parentElement = childrenEl;
                    insertBefore = childrenEl.firstChild;
                } else {
                    // 收藏夹视图：无 .folder-children，插入到选中项后方
                    parentElement = parentItem.parentElement;
                    insertBefore = parentItem.nextSibling;
                }
            }
        }
        if (!parentElement) {
            parentElement = this.folderTree;
            insertBefore = this.folderTree.firstChild;
        }

        // 防止重复创建输入行
        if (parentElement.querySelector('.mkdir-input-row')) {
            parentElement.querySelector('.mkdir-input').focus();
            return;
        }

        // 创建内联输入行
        const inputRow = document.createElement('div');
        inputRow.className = 'folder-tree-item mkdir-input-row';
        inputRow.innerHTML = `
            <span class="folder-icon">📁</span>
            <input type="text" class="mkdir-input" placeholder="新文件夹名称" />
            <span class="mkdir-confirm" title="确定（Enter）">✓</span>
            <span class="mkdir-cancel" title="取消（Esc）">✗</span>
        `;
        parentElement.insertBefore(inputRow, insertBefore);
        const input = inputRow.querySelector('.mkdir-input');
        input.focus();

        const doCreate = async () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            inputRow.remove();
            try {
                const res = await fetch('/api/folders/mkdir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId: this.accountId, parentFileId, folderName: name })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error || '创建失败');
                // 直接插入新节点，不刷新整棵树
                const newNode = { id: data.data.fileId, name: data.data.name };
                this._insertNewFolderItem(newNode, parentElement, insertBefore);
                message.success('文件夹创建成功');
            } catch (e) {
                message.error('创建失败：' + e.message);
            }
        };

        const doCancel = () => inputRow.remove();
        inputRow.querySelector('.mkdir-confirm').addEventListener('click', doCreate);
        inputRow.querySelector('.mkdir-cancel').addEventListener('click', doCancel);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doCreate();
            if (e.key === 'Escape') doCancel();
        });
        inputRow.addEventListener('click', (e) => e.stopPropagation());
    }

    _insertNewFolderItem(newNode, parentElement, insertBefore = null) {
        const isFavorite = this.favorites.some(f => f.id === newNode.id);
        const favoriteIcon = this.enableFavorites ? `
            <span class="favorite-icon ${isFavorite ? 'active' : ''}" data-id="${newNode.id}" data-name="${newNode.name}">
                <img src="/icons/star.svg" alt="star" width="16" height="16">
            </span>
        ` : '';
        const newItem = document.createElement('div');
        newItem.className = 'folder-tree-item';
        newItem.innerHTML = `
            ${favoriteIcon}
            <span class="folder-icon">📁</span>
            <span class="folder-name">${newNode.name}</span>
            <span class="expand-icon">▶</span>
        `;
        const children = document.createElement('div');
        children.className = 'folder-children';
        newItem.appendChild(children);
        newItem.addEventListener('click', async (e) => {
            e.stopPropagation();
            this.selectFolder(newNode, newItem);
            if (!newItem.classList.contains('expanded')) {
                await this.loadFolderNodes(newNode.id, children);
            }
            newItem.classList.toggle('expanded');
        });
        if (this.enableFavorites) {
            const favoriteBtn = newItem.querySelector('.favorite-icon');
            if (favoriteBtn) {
                favoriteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const { id, name } = e.currentTarget.dataset;
                    const isFav = this.favorites.some(f => f.id === id);
                    if (!isFav) {
                        this.addToFavorites(id, name, newItem);
                        e.currentTarget.classList.add('active');
                    } else {
                        this.removeFromFavorites(id);
                        e.currentTarget.classList.remove('active');
                    }
                });
            }
        }
        parentElement.insertBefore(newItem, insertBefore);
        this.selectFolder(newNode, newItem);
    }

    async show(accountId = '') {
        if (accountId) {
            this.accountId = accountId;
        }

        if (!this.accountId) {
            message.warning('请先选择账号');
            return;
        }

        this.modal.style.display = 'block';
        // 设置z-index
        this.modal.style.zIndex = 1001;
        this.selectedNode = null;
        this.isShowingFavorites = false;
        this.favorites =  await this.getFavorites()
        this.modal.querySelector('.modal-title').textContent = this.title;
        await this.loadFolderNodes('-11');
    }

    close() {
        this.modal.style.display = 'none';
        // 移除DOM节点
        this.modal.remove();
        this.initModal();
    }

    setAccountId(accountId) {
        this.accountId = accountId;
    }

    defaultConfirm() {
        if (this.selectedNode) {
            this.onSelect({
                id: this.selectedNode.id,
                name: this.selectedNode.name,
                path: this.currentPath.join('/') 
            });
            this.close();
        } else {
            message.warning('请选择一个目录');
        }
    }

    // 默认取消按钮回调
    defaultCancel() {
        this.close();
    }

    async loadFolderNodes(folderId, parentElement = this.folderTree, refresh = false) {
        try {
            let nodes;
            if (this.isShowingFavorites) {
                // 从缓存加载常用目录数据
                nodes = await this.getFavorites();
            }else{
                const params = this.apiConfig.buildParams(this.accountId, folderId, this);
                const response = await fetch(`${this.apiConfig.url}/${params}${refresh ? '&refresh=true' : ''}`);
                const data = await response.json();
                if (!this.apiConfig.validateResponse(data)) {
                    throw new Error('获取目录失败: ' + (data.error || '未知错误'));
                }
                nodes = this.apiConfig.parseResponse(data);
            }
            this.renderFolderNodes(nodes, parentElement);
        } catch (error) {
            console.error('加载目录失败:', error);
            message.warning('加载目录失败');
        }
    }

    async renderFolderNodes(nodes, parentElement = this.folderTree) {
        parentElement.innerHTML = '';
        let favorites = this.favorites
        nodes.forEach(node => {
            const item = document.createElement('div');
            item.className = 'folder-tree-item';
            // 常用目录视图不显示展开图标和复选框 是否允许点击
            const expandIcon = (this.isShowingFavorites || node.isFile) ? '' : '<span class="expand-icon">▶</span>';
            const isFavorite = favorites.some(f => f.id === node.id);
            const favoriteIcon = this.enableFavorites ? `
                <span class="favorite-icon ${isFavorite ? 'active' : ''}" data-id="${node.id}" data-name="${node.name}">
                    <img src="/icons/star.svg" alt="star" width="16" height="16">
                </span>
            ` : '';

            // 如果是常用目录视图，显示完整路径
            const displayName = this.isShowingFavorites && node.path ? 
                `${node.path}` : 
                node.name;

            item.innerHTML = `
                ${favoriteIcon}
                <span class="folder-icon">${node.isFile?'📃':'📁'}</span>
                <span class="folder-name">${displayName}</span>
                ${expandIcon}
            `;

            const children = document.createElement('div');
            if (!this.isShowingFavorites) {
                children.className = 'folder-children';
                item.appendChild(children);
            }

            if (this.enableFavorites) {
                const favoriteBtn = item.querySelector('.favorite-icon');
                favoriteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const { id, name } = e.currentTarget.dataset;
                    const isFavorite = favorites.some(f => f.id === id);
                    if (!isFavorite) {
                        // 传入当前项的DOM元素
                        this.addToFavorites(id, name, item);
                        e.currentTarget.classList.add('active');
                    } else {
                        this.removeFromFavorites(id);
                        e.currentTarget.classList.remove('active');
                    }
                });
            }
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.selectFolder(node, item);
                if (this.isShowingFavorites || node.isFile) {
                    return;
                }
                if (!item.classList.contains('expanded')) {
                    await this.loadFolderNodes(node.id, children);
                }
                item.classList.toggle('expanded');
            });
            parentElement.appendChild(item);
        });
    }

    selectFolder(node, element) {
        if (this.selectedNode) {
            const prevSelected = this.modal.querySelector('.folder-tree-item.selected');
            if (prevSelected) {
                prevSelected.classList.remove('selected');
            }
        }
        this.selectedNode = node;
        element.classList.add('selected');

        // 更新当前路径
        this.updatePath(element);
    }

    updatePath(element) {
        this.currentPath = [];
        let current = element;
        
        // 向上遍历DOM树获取完整路径
        while (current && !current.classList.contains('folder-tree')) {
            if (current.classList.contains('folder-tree-item')) {
                const nameElement = current.querySelector('.folder-name');
                if (nameElement) {
                    this.currentPath.unshift(nameElement.textContent);
                }
            }
            current = current.parentElement;
        }
    }


    showFavorites(accountId = '') {
        if (accountId) {
            this.accountId = accountId;
        }
        if (!this.accountId) {
            message.warning('请先选择账号');
            return;
        }
        this.modal.style.display = 'block';
        this.modal.style.zIndex = 1001;
        this.selectedNode = null;
        this.isShowingFavorites = true;
        this.modal.querySelector('.modal-title').textContent = '常用目录';
        this.loadFolderNodes(null, this.folderTree, false, true);
    }
}

// 导出FolderSelector类
window.FolderSelector = FolderSelector;
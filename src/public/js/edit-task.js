// 修改任务相关功能
let shareFolderSelector = new FolderSelector({
    apiUrl: "/api/share/folders",
    onSelect: ({ id, name, path }) => {
        document.getElementById('shareFolder').value = path;
        document.getElementById('shareFolderId').value = id;
    },
    buildParams: (accountId, folderId) => {
        const taskId = document.getElementById('editTaskId').value;
        return `${accountId}?folderId=${folderId}&taskId=${taskId}`;
    }
});

let editFolderSelector = new FolderSelector({
    enableFavorites: true,
    favoritesKey: 'createTaskFavorites',
    onSelect: ({ id, name, path }) => {
        document.getElementById('editRealFolder').value = path;
        document.getElementById('editRealFolderId').value = id;
    }
});

function showEditTaskModal(id) {
    const task = getTaskById(id)
    document.getElementById('editTaskId').value = id;
    document.getElementById('editResourceName').value = task.resourceName;
    document.getElementById('editRealFolder').value = task.realFolderName?task.realFolderName:task.realFolderId;
    document.getElementById('editRealFolderId').value = task.realFolderId;
    document.getElementById('editCurrentEpisodes').value = task.currentEpisodes;
    document.getElementById('editTotalEpisodes').value = task.totalEpisodes;
    document.getElementById('editStatus').value = task.status;
    document.getElementById('shareLink').value = task.shareLink;
    document.getElementById('shareFolder').value = task.shareFolderName;
    document.getElementById('shareFolderId').value = task.shareFolderId;
    document.getElementById('editMatchPattern').value = task.matchPattern;
    document.getElementById('editMatchOperator').value = task.matchOperator;
    document.getElementById('editMatchValue').value = task.matchValue;
    document.getElementById('editRemark').value = task.remark;
    document.getElementById('editMovieRenameFormat').value = task.movieRenameFormat || '';
    document.getElementById('editTvRenameFormat').value = task.tvRenameFormat || '';
    const editDisableRename = document.getElementById('editDisableRename');
    if (editDisableRename) editDisableRename.checked = !!task.disableRename;
    document.getElementById('editTaskModal').style.display = 'flex';
    document.getElementById('editEnableCron').checked = task.enableCron;
    document.getElementById('editCronExpression').value = task.cronExpression;
    document.getElementById('editAccountId').value = task.accountId;

    document.getElementsByClassName('cronExpression-box')[1].style.display = task.enableCron?'block':'none';
    applyEditCronPresetFromExpression(task.cronExpression);
}

function closeEditTaskModal() {
    document.getElementById('editTaskModal').style.display = 'none';
}

function initEditTaskForm() {
    document.getElementById('shareFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('editAccountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        shareFolderSelector.show(accountId);
    });

    // 更新目录也改为点击触发
    document.getElementById('editRealFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('editAccountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        editFolderSelector.show(accountId);
    });

    const editFavoriteFolderBtn = document.getElementById('editFavoriteFolderBtn');
    if (editFavoriteFolderBtn) {
        editFavoriteFolderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const accountId = document.getElementById('editAccountId').value;
            if (!accountId) {
                message.warning('请先选择账号');
                return;
            }
            editFolderSelector.showFavorites(accountId);
        });
    }

    document.getElementById('editTaskForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editTaskId').value;
        const resourceName = document.getElementById('editResourceName').value;
        const realFolderId = document.getElementById('editRealFolderId').value;
        const realFolderName = document.getElementById('editRealFolder').value;
        const currentEpisodes = document.getElementById('editCurrentEpisodes').value;
        const totalEpisodes = document.getElementById('editTotalEpisodes').value;
        const shareFolderName = document.getElementById('shareFolder').value;
        const shareFolderId = document.getElementById('shareFolderId').value;
        const status = document.getElementById('editStatus').value;

        const matchPattern = document.getElementById('editMatchPattern').value
        const matchOperator = document.getElementById('editMatchOperator').value
        const matchValue = document.getElementById('editMatchValue').value
        const remark = document.getElementById('editRemark').value

        const enableCron = document.getElementById('editEnableCron').checked;
        const cronExpression = enableCron ? buildEditCronExpression() : document.getElementById('editCronExpression').value;
        const movieRenameFormat = document.getElementById('editMovieRenameFormat').value;
        const tvRenameFormat = document.getElementById('editTvRenameFormat').value;
        const editDisableRenameEl = document.getElementById('editDisableRename');
        const disableRename = editDisableRenameEl ? editDisableRenameEl.checked : undefined;

        try {
            loading.show()
            const response = await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    resourceName,
                    realFolderId,
                    currentEpisodes: currentEpisodes?parseInt(currentEpisodes):0,
                    totalEpisodes: totalEpisodes?parseInt(totalEpisodes):0,
                    status,
                    shareFolderName,
                    shareFolderId,
                    realFolderName,
                    matchPattern,
                    matchOperator,
                    matchValue,
                    remark,
                    enableCron,
                    cronExpression,
                    movieRenameFormat,
                    tvRenameFormat,
                    ...(disableRename !== undefined ? { disableRename } : {}),
                })
            });
            loading.hide()
            if (response.ok) {
                closeEditTaskModal();
                await fetchTasks();
            } else {
                const error = await response.json();
                message.warning(error.message || '修改任务失败');
            }
        } catch (error) {
            message.warning('修改任务失败：' + error.message);
        }
    });

    document.getElementById('editEnableCron').addEventListener('change', function() {
        const cronInput = document.getElementsByClassName('cronExpression-box')[1];
        cronInput.style.display = this.checked ? 'block' : 'none';
        if (this.checked) {
            const value = buildEditCronExpression();
            if (value) {
                document.getElementById('editCronExpression').value = value;
            }
        }
    });

    document.getElementById('editCronPresetType').addEventListener('change', () => {
        updateEditCronBuilderUI();
        const value = buildEditCronExpression();
        if (value) {
            document.getElementById('editCronExpression').value = value;
        }
    });

    document.getElementById('editCronPresetTime').addEventListener('change', () => {
        const value = buildEditCronExpression();
        if (value) {
            document.getElementById('editCronExpression').value = value;
        }
    });

    document.querySelectorAll('input[name="editCronMonthDay"]').forEach((el) => {
        el.addEventListener('change', () => {
            const value = buildEditCronExpression();
            if (value) {
                document.getElementById('editCronExpression').value = value;
            }
        });
    });

    document.querySelectorAll('input[name="editCronWeekday"]').forEach((el) => {
        el.addEventListener('change', () => {
            const value = buildEditCronExpression();
            if (value) {
                document.getElementById('editCronExpression').value = value;
            }
        });
    });
}

function updateEditCronBuilderUI() {
    const type = document.getElementById('editCronPresetType').value;
    const weeklyRow = document.getElementById('editCronWeeklyRow');
    const monthlyRow = document.getElementById('editCronMonthlyRow');
    if (weeklyRow) {
        weeklyRow.classList.toggle('is-hidden', type !== 'weekly');
    }
    if (monthlyRow) {
        monthlyRow.classList.toggle('is-hidden', type !== 'monthly');
    }
}

function buildEditCronExpression() {
    const type = document.getElementById('editCronPresetType').value;
    if (type === 'custom') {
        return document.getElementById('editCronExpression').value.trim();
    }

    const time = document.getElementById('editCronPresetTime').value || '02:00';
    const [hourRaw, minuteRaw] = time.split(':');
    const hour = Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : 2;
    const minute = Number.isFinite(Number(minuteRaw)) ? Number(minuteRaw) : 0;

    if (type === 'daily') {
        return `0 ${minute} ${hour} * * *`;
    }

    if (type === 'weekly') {
        const weekdays = Array.from(document.querySelectorAll('input[name="editCronWeekday"]:checked')).map((cb) => cb.value);
        const normalizedWeekdays = weekdays.length > 0 ? weekdays.join(',') : '1';
        return `0 ${minute} ${hour} * * ${normalizedWeekdays}`;
    }

    if (type === 'monthly') {
        const monthDays = Array.from(document.querySelectorAll('input[name="editCronMonthDay"]:checked')).map((cb) => cb.value);
        const normalizedDays = monthDays.length > 0 ? monthDays.join(',') : '1';
        return `0 ${minute} ${hour} ${normalizedDays} * *`;
    }

    return document.getElementById('editCronExpression').value.trim();
}

function applyEditCronPresetFromExpression(expression) {
    const cronExpression = String(expression || '').trim();
    const parts = cronExpression.split(/\s+/);
    // 默认回到自定义
    document.getElementById('editCronPresetType').value = 'custom';
    updateEditCronBuilderUI();

    if (parts.length !== 6) {
        return;
    }

    const minute = parseInt(parts[1], 10);
    const hour = parseInt(parts[2], 10);
    if (!Number.isFinite(minute) || !Number.isFinite(hour)) {
        return;
    }

    document.getElementById('editCronPresetTime').value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    if (parts[3] === '*' && parts[4] === '*' && parts[5] === '*') {
        document.getElementById('editCronPresetType').value = 'daily';
        updateEditCronBuilderUI();
        return;
    }

    if (parts[3] === '*' && parts[4] === '*' && parts[5] !== '*') {
        document.getElementById('editCronPresetType').value = 'weekly';
        updateEditCronBuilderUI();
        const selected = new Set(parts[5].split(','));
        document.querySelectorAll('input[name="editCronWeekday"]').forEach((cb) => {
            cb.checked = selected.has(cb.value);
        });
        return;
    }

    if (parts[4] === '*' && parts[5] === '*') {
        document.getElementById('editCronPresetType').value = 'monthly';
        updateEditCronBuilderUI();
        const selected = new Set(parts[3].split(','));
        document.querySelectorAll('input[name="editCronMonthDay"]').forEach((cb) => {
            cb.checked = selected.has(cb.value);
        });
    }
}
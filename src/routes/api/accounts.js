const { Not } = require('typeorm');
const { Cloud139Service } = require('../../services/cloud139');
const { logTaskEvent } = require('../../utils/logUtils');
const { maskUsername } = require('./shared');

const createEmptyCapacity = () => ({
    cloudCapacityInfo: { usedSize: 0, totalSize: 0 },
    familyCapacityInfo: { usedSize: 0, totalSize: 0 },
    totalCapacityInfo: { usedSize: 0, totalSize: 0 },
});

const registerAccountsRoutes = (app, deps) => {
    const {
        accountRepo,
        taskRepo,
        folderCache,
    } = deps;

    app.get('/api/accounts', async (req, res) => {
        const accounts = await accountRepo.find();
        await Promise.all(accounts.map(async (account) => {
            account.capacity = createEmptyCapacity();
            account.memberInfo = null;
            account.memberStatus = account.isActive === false ? 'auth_failed' : 'unknown';
            account.memberStatusText = account.isActive === false ? '认证失效' : '-';
            if (!account.username.startsWith('n_') && account.accountType === 'cloud139') {
                if (account.isActive === false) {
                    account.original_username = account.username;
                    account.username = maskUsername(account.username);
                    return;
                }
                try {
                    const cloud139 = Cloud139Service.getInstance(account);
                    const capacity = await cloud139.getUserSizeInfo();
                    if (capacity && capacity.res_code === 0) {
                        account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                        account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                        account.capacity.totalCapacityInfo = capacity.totalCapacityInfo || {
                            usedSize: (capacity.cloudCapacityInfo?.usedSize || 0) + (capacity.familyCapacityInfo?.usedSize || 0),
                            totalSize: (capacity.cloudCapacityInfo?.totalSize || 0) + (capacity.familyCapacityInfo?.totalSize || 0),
                        };
                        account.memberInfo = capacity.memberInfo || null;
                        account.memberStatus = 'ok';
                        account.memberStatusText = account.memberInfo?.memberName || '普通';
                    } else {
                        account.memberStatus = 'unavailable';
                        account.memberStatusText = '获取失败';
                    }
                } catch (e) {
                    if (Cloud139Service.isAuthFailure(e)) {
                        account.memberStatus = 'auth_failed';
                        account.memberStatusText = '认证失效';
                        if (account.isActive !== false) {
                            try {
                                account.isActive = false;
                                await accountRepo.save(account);
                                Cloud139Service.clearInstance(account);
                            } catch (saveError) {
                                logTaskEvent(`[账号状态] 标记认证失效失败: accountId=${account.id}, error=${saveError.message}`);
                            }
                        }
                    } else {
                        account.memberStatus = 'unavailable';
                        account.memberStatusText = '获取失败';
                        logTaskEvent(`[账号信息] 拉取容量失败: accountId=${account.id}, error=${e.message}`);
                    }
                }
            }
            account.original_username = account.username;
            account.username = maskUsername(account.username);
        }));
        res.json({ success: true, data: accounts });
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const payload = { ...req.body };
            const accountId = Number(payload.id || 0);
            ['alistStrmPath', 'alistNativePath', 'rootFolderId', 'localStrmPrefix', 'cloudStrmPrefix', 'embyLibraryPath', 'embyPathReplace']
                .forEach((field) => {
                    if (typeof payload[field] === 'string') {
                        payload[field] = payload[field].trim();
                    }
                });

            let account;
            if (accountId > 0) {
                account = await accountRepo.findOneBy({ id: accountId });
                if (!account) {
                    return res.json({ success: false, error: '账号不存在' });
                }
                Object.assign(account, payload);
            } else {
                account = accountRepo.create(payload);
            }

            if (account.accountType !== 'cloud139') {
                return res.json({ success: false, error: '仅支持移动云盘（139）账号' });
            }
            if (!account.cookies) {
                res.json({ success: false, error: '移动云盘（139）只支持 Cookie 登录，请填写 Cookie' });
                return;
            }

            await accountRepo.save(account);
            Cloud139Service.clearInstance(account);

            let runtimeCapacity = createEmptyCapacity();
            let memberInfo = null;
            let memberStatus = 'unavailable';
            let memberStatusText = '获取失败';
            let authError = null;

            try {
                const cloud139 = Cloud139Service.getInstance(account);
                const capacity = await cloud139.getUserSizeInfo();
                if (capacity && capacity.res_code === 0) {
                    runtimeCapacity = {
                        cloudCapacityInfo: capacity.cloudCapacityInfo,
                        familyCapacityInfo: capacity.familyCapacityInfo,
                        totalCapacityInfo: capacity.totalCapacityInfo || {
                            usedSize: (capacity.cloudCapacityInfo?.usedSize || 0) + (capacity.familyCapacityInfo?.usedSize || 0),
                            totalSize: (capacity.cloudCapacityInfo?.totalSize || 0) + (capacity.familyCapacityInfo?.totalSize || 0),
                        },
                    };
                    memberInfo = capacity.memberInfo || null;
                    memberStatus = 'ok';
                    memberStatusText = memberInfo?.memberName || '普通';
                }
            } catch (error) {
                if (Cloud139Service.isAuthFailure(error)) {
                    memberStatus = 'auth_failed';
                    memberStatusText = '认证失效';
                    authError = error.message;
                } else {
                    logTaskEvent(`[账号信息] 更新后验证失败: accountId=${account.id}, error=${error.message}`);
                }
            }

            account.isActive = memberStatus !== 'auth_failed';
            await accountRepo.save(account);
            Cloud139Service.clearInstance(account);

            const result = {
                accountId: account.id,
                memberInfo,
                capacity: runtimeCapacity,
                memberStatus,
                memberStatusText,
                isActive: account.isActive,
            };

            if (memberStatus === 'auth_failed') {
                return res.json({
                    success: false,
                    code: 'AUTH_FAILED',
                    error: authError || 'Cookie 认证失效，请重新填写。',
                    data: result,
                });
            }

            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/accounts/recycle', async (req, res) => {
        res.json({ success: false, error: '回收站清理功能不可用，移动云盘(139)不支持此功能' });
    });

    app.delete('/api/accounts/:id', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');

            const taskCount = await taskRepo.count({ where: { accountId } });
            if (taskCount > 0) {
                return res.json({
                    success: false,
                    error: `该账号下仍有 ${taskCount} 个任务，请先删除/迁移任务后再删除账号`,
                });
            }

            const wasDefault = !!account.isDefault;
            await accountRepo.remove(account);
            if (wasDefault) {
                const next = await accountRepo.findOne({ where: { id: Not(accountId) } });
                if (next) {
                    await accountRepo.update({ id: next.id }, { isDefault: true });
                }
            }

            folderCache.clearPrefix('folders_');
            folderCache.clearPrefix('share_folders_');
            folderCache.clearPrefix('favorites_');
            logTaskEvent(`[system] 已删除账号 ${accountId}（并清理关联任务/目录缓存）`);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/accounts/:id/alias', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { alias } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            account.alias = alias;
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const isDefault = req.body?.isDefault !== false;
            await accountRepo.update({}, { isDefault: false });
            if (isDefault) {
                await accountRepo.update({ id: accountId }, { isDefault: true });
            }
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            await accountRepo.update({ id: accountId }, { isDefault: false });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
};

module.exports = {
    registerAccountsRoutes,
};
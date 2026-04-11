let accountsList = []
let chooseAccount = null
// 账号相关功能
async function fetchAccounts(updateSelect = false) {
    const response = await fetch('/api/accounts');
    const data = await response.json();
    // 如果http状态码为401, 则跳转到登录页面
    if (response.status === 401) {
        window.location.href = '/login';
        return;
    }
    
    if (data.success) {
        const tbody = document.querySelector('#accountTable tbody');
        const select = document.querySelector('#accountId');
        tbody.innerHTML = '';
        if (updateSelect) {
            select.innerHTML = '' 
        }
        accountsList = data.data
        data.data.forEach(account => {
            const displayUsername = account.original_username || account.username;
            tbody.innerHTML += `
                <tr>
                    <td>
                        <div class="table-row-actions account-row-actions">
                            <button class="action-icon-btn default-star-btn ${account.isDefault ? 'is-default' : ''}" onclick="setDefaultAccount(${account.id})" title="设为默认账号" aria-label="设为默认账号">
                                ${account.isDefault ? '★' : '☆'}
                            </button>
                            <button class="action-btn action-btn-primary" onclick="editAccount(${account.id})">修改</button>
                            <button class="action-btn action-btn-danger" onclick="deleteAccount(${account.id})">删除</button>
                        </div>
                    </td>
                    <td data-label='账户名'>${displayUsername}</td>
                    <td data-label='会员状态'>${account.memberInfo ? account.memberInfo.memberName : '-'}</td>
                    <td data-label='容量'>${formatBytes(account.capacity.cloudCapacityInfo.usedSize) + '/' + formatBytes(account.capacity.cloudCapacityInfo.totalSize)}</td>

                </tr>
            `;
            if (updateSelect) {
                // n_打头的账号不显示在下拉列表中
                if (!displayUsername.startsWith('n_')) {
                    select.innerHTML += `
                    <option value="${account.id}" ${account.isDefault?"selected":''}>${displayUsername}</option>
                `;
                }
            }
        });
        // 账号列表刷新后同步更新 STRM 配置提示（使用默认选中的账号）
        if (updateSelect) {
            onTaskAccountChange(null);
        }
    }
}

async function deleteAccount(id) {
    if (!confirm('确定要删除这个账号吗？')) return;
    loading.show()
    const response = await fetch(`/api/accounts/${id}`, {
        method: 'DELETE'
    });
    loading.hide()
    const data = await response.json();
    if (data.success) {
        message.success('账号删除成功');
        // updateSelect=true：同步刷新创建任务弹窗中的账号下拉框
        fetchAccounts(true);
    } else {
        message.warning('账号删除失败: ' + data.error);
    }
}

// 添加账号表单处理
function initAccountForm() {
    document.getElementById('accountForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await createAccount();
    });
}

function openAddAccountModal() {
    chooseAccount = null
    const modal = document.getElementById('addAccountModal');
    document.getElementById('accountType').value = 'cloud139';
    onAccountTypeChange('cloud139');
    modal.style.display = 'flex';
}

function closeAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    modal.style.display = 'none';
    const modalTitle = modal.querySelector('h3');
    modalTitle.textContent = '添加账号';
    const submitBtn = modal.querySelector('button[type="submit"]');
    submitBtn.textContent = '添加';
    document.getElementById('username').removeAttribute('readonly')
    // 重置账号类型
    document.getElementById('accountType').value = 'cloud139';
    onAccountTypeChange('cloud139');
    // 清空表单
    document.getElementById('accountForm').reset();
    // 移除可能存在的验证码容器
    const captchaContainer = document.querySelector('.captcha-container');
    if (captchaContainer) {
        captchaContainer.remove();
    }
    chooseAccount = null
}

async function editAccount(id) {
    // 获取账号信息
    chooseAccount = accountsList.find(acc => acc.id === id);
    if (!chooseAccount) {
        message.warning('账号不存在');
        return;
    }

    // 打开模态框
    const modal = document.getElementById('addAccountModal');
    modal.style.display = 'flex';

    // 修改标题
    const modalTitle = modal.querySelector('h3');
    modalTitle.textContent = '修改账号';

    // 填充表单数据
    const accountType = chooseAccount.accountType || 'cloud139';
    document.getElementById('accountType').value = accountType;
    onAccountTypeChange(accountType);
    document.getElementById('username').value = chooseAccount.original_username || chooseAccount.username;
    document.getElementById('password').value = '';
    document.getElementById('cookie').value = chooseAccount.cookies || '';
    // 媒体服务配置字段
    document.getElementById('localStrmPrefix').value = chooseAccount.localStrmPrefix || '';
    document.getElementById('cloudStrmPrefix').value = chooseAccount.cloudStrmPrefix || '';
    document.getElementById('alistStrmPath').value = chooseAccount.alistStrmPath || '';
    document.getElementById('embyPathReplace').value = chooseAccount.embyPathReplace || '';
    // 账号不允许修改
    document.getElementById('username').setAttribute('readonly', true )
    // 修改提交按钮文本
    const submitBtn = modal.querySelector('button[type="submit"]');
    submitBtn.textContent = '修改';
}

function onAccountTypeChange(type) {
    const passwordGroup = document.getElementById('passwordGroup');
    const loginHint = document.getElementById('loginHint');
    if (type === 'cloud139') {
        passwordGroup.style.display = 'none';
        if (loginHint) loginHint.textContent = '移动云盘（139）只支持 Cookie 登录，请填写 Cookie';
    } else {
        passwordGroup.style.display = '';
        if (loginHint) loginHint.textContent = '密码和Cookie至少填写一个, 如果都填写, 则只有账号密码生效';
    }
}

async function createAccount() {
    let username = document.getElementById('username').value;
    const accountType = document.getElementById('accountType').value;
    const password = document.getElementById('password').value;
    const cookies  = document.getElementById('cookie').value;
    const validateCodeDom = document.getElementById('validateCode')
    let validateCode = "";
    if (validateCodeDom) {
        validateCode = validateCodeDom.value;
    }
    if (!username ) {
        message.warning('用户名不能为空');
        return;
    }
    if (accountType === 'cloud139') {
        if (!cookies) {
            message.warning('移动云盘（139）只支持 Cookie 登录，Cookie 不能为空');
            return;
        }
    } else if (!password && !cookies) {
        message.warning('密码和Cookie不能同时为空');
        return;
    }
    if (chooseAccount?.id) {
        username = chooseAccount.original_username
    }
    const localStrmPrefix = document.getElementById('localStrmPrefix').value;
    const cloudStrmPrefix = document.getElementById('cloudStrmPrefix').value;
    const alistStrmPath = document.getElementById('alistStrmPath').value;
    const embyPathReplace = document.getElementById('embyPathReplace').value;
    loading.show()
    const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chooseAccount?.id, username, accountType, password, cookies, validateCode, localStrmPrefix, cloudStrmPrefix, alistStrmPath, embyPathReplace })
    });
    const data = await response.json();
    if (data.success) {
        loading.hide()
        message.success('成功');
        document.getElementById('accountForm').reset();
        if (validateCodeDom) {
            // 移除验证码容器
            document.getElementById('account-captcha').style.display = 'none';
            validateCodeDom.value = ''
        }
        closeAddAccountModal();
        // updateSelect=true：同步刷新创建任务弹窗中的账号下拉框
        fetchAccounts(true);
    } else {
        loading.hide()
        // 如果返回的code是NEED_CAPTCHA, 则展示二维码和输入框, 允许用户输入验证码后重新提交
        if (data.code === 'NEED_CAPTCHA') {
            // 展示二维码
            document.getElementById('account-captcha').style.display = 'block';
            document.getElementById('captchaImage').src = data.data.captchaUrl;
            message.warning('请输入验证码后重新提交');
        }else{
            message.warning('账号添加失败: ' + data.error);
        }
    }
}
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0B';
    if (bytes < 0) return '-' + formatBytes(-bytes);
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const base = 1024;
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
    const value = bytes / Math.pow(base, exponent);
    
    return value.toFixed(exponent > 0 ? 2 : 0) + units[exponent];
}
/**
 * 任务表单账号切换时，检查所选账号是否配置了 alistStrmPath，
 * 动态显示/隐藏 STRM 刷新路径未配置的警告提示。
 * @param {HTMLSelectElement|null} selectEl - 账号下拉框元素（为 null 时自动查找）
 */
function onTaskAccountChange(selectEl) {
    const el = selectEl || document.getElementById('accountId');
    const hint = document.getElementById('strmConfigHint');
    if (!hint || !el) return;
    const selectedId = parseInt(el.value, 10);
    const account = accountsList.find(a => a.id === selectedId);
    // alistStrmPath 未填写时显示提示
    const missing = !account || !account.alistStrmPath?.trim();
    hint.style.display = missing ? '' : 'none';
}

/**
 * 打开当前任务表单所选账号的编辑弹窗，方便用户快速填写媒体路径配置。
 */
function editCurrentTaskAccount() {
    const el = document.getElementById('accountId');
    if (!el || !el.value) {
        message.warning('请先选择账号');
        return;
    }
    editAccount(parseInt(el.value, 10));
}

async function setDefaultAccount(id) {
    try {
        const response = await fetch(`/api/accounts/${id}/default`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (data.success) {
            message.success('设置默认账号成功');
            fetchAccounts(true);  // 更新账号列表和下拉框
        } else {
            message.warning('设置默认账号失败: ' + data.error);
        }
    } catch (error) {
        message.warning('操作失败: ' + error.message);
    }
}

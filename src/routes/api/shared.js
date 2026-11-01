const ensureCloud139Account = (account, action, requireActive = true) => {
    if (!account) {
        const err = new Error('请先在「云盘账号」页面绑定并登录 139 移动云盘账号');
        err.code = 'AUTH_FAILED';
        throw err;
    }
    if (account.accountType !== 'cloud139') {
        const err = new Error(`${action}仅支持移动云盘（139）账号`);
        err.code = 'INVALID_ACCOUNT_TYPE';
        throw err;
    }
    if (requireActive && account.isActive === false) {
        const err = new Error('云盘账号登录凭证已失效，请前往【云盘账号】重新扫码登录');
        err.code = 'AUTH_FAILED';
        throw err;
    }
};

const maskUsername = (username) => {
    const value = String(username || '').trim();
    if (/^1\d{10}$/.test(value)) {
        return `${value.slice(0, 3)}****${value.slice(7)}`;
    }
    return value;
};

module.exports = {
    ensureCloud139Account,
    maskUsername,
};

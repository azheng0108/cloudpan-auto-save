const ensureCloud139Account = (account, action) => {
    if (!account) {
        throw new Error('账号不存在');
    }
    if (account.accountType !== 'cloud139') {
        throw new Error(`${action}仅支持移动云盘（139）账号`);
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
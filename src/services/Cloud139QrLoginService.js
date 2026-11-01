const crypto = require('crypto');
const got = require('got');
const { createQrDataUrl } = require('../utils/qrcode');
const { Cloud139Service } = require('./cloud139');
const logger = require('../utils/logger');
const ProxyUtil = require('../utils/ProxyUtil');

const CAIYUN_DECRYPT_KEY = 'qPqDw263XgFgL3u8';
const QR_EXPIRE_SECONDS = 120; // 官方二维码 2 分钟有效

class Cloud139QrLoginService {
    constructor() {
        // 存储活跃二维码会话: sID -> { sID, dID, createdAt, expireAt, status, accountInfo }
        this.sessions = new Map();
        // 启动定时会话回收器 (每分钟清理一次过期条目)
        this.cleanupTimer = setInterval(() => this._cleanupExpiredSessions(), 60 * 1000);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    _cleanupExpiredSessions() {
        const now = Date.now();
        for (const [sID, session] of this.sessions.entries()) {
            if (now > session.expireAt + 60 * 1000) {
                this.sessions.delete(sID);
            }
        }
    }

    /**
     * 生成随机字母与数字混合字符串
     * @param {number} length 
     * @returns {string}
     */
    _generateRandomString(length) {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let res = '';
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return res;
    }

    /**
     * 创建全新的二维码会话
     * @returns {{ sID: string, dID: string, qrUrl: string, qrDataUrl: string, expiresIn: number }}
     */
    createQrSession() {
        const sID = this._generateRandomString(16);
        const dID = crypto.createHash('md5').update(`device_${Date.now()}_${Math.random()}`).digest('hex');
        const qrUrl = `https://yun.139.com/w/#/qrcLogin?sID=${sID}&dID=${dID}&cType=9`;
        
        let qrDataUrl = '';
        try {
            qrDataUrl = createQrDataUrl(qrUrl, 5, 8);
        } catch (err) {
            logger.warn(`生成二维码 DataURL 异常: ${err.message}`);
        }

        const now = Date.now();
        const session = {
            sID,
            dID,
            qrUrl,
            createdAt: now,
            expireAt: now + QR_EXPIRE_SECONDS * 1000,
            status: 'waiting', // 'waiting' | 'confirmed' | 'expired'
            accountInfo: null
        };

        this.sessions.set(sID, session);
        return {
            sID,
            dID,
            qrUrl,
            qrDataUrl,
            expiresIn: QR_EXPIRE_SECONDS
        };
    }

    /**
     * AES-128-ECB 解密官方返回的加密认证报文
     * @param {string} encryptedBase64 
     * @param {string} key 
     * @returns {any}
     */
    _decryptCaiyunData(encryptedBase64, key = CAIYUN_DECRYPT_KEY) {
        try {
            const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
            decipher.setAutoPadding(true);
            let decrypted = decipher.update(encryptedBase64, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return JSON.parse(decrypted);
        } catch (err) {
            logger.error(`解密彩云登录报文异常: ${err.message}`);
            return null;
        }
    }

    /**
     * 轮询二维码扫码状态
     * @param {string} sID 
     * @param {{ accountRepo: any, folderCache?: any }} deps
     * @returns {Promise<{ status: string, account?: string, message: string }>}
     */
    async pollQrStatus(sID, deps = {}) {
        if (!sID || typeof sID !== 'string') {
            return { status: 'expired', message: '缺少有效的二维码会话标识 (sID)' };
        }

        const session = this.sessions.get(sID);
        const now = Date.now();

        // 会话不存在或已超出本地超时倒计时
        if (!session || now > session.expireAt) {
            if (session) session.status = 'expired';
            return { status: 'expired', message: '二维码已失效，请点击刷新重新获取' };
        }

        // 若之前已完成绑定，直接返回成功状态
        if (session.status === 'confirmed' && session.accountInfo) {
            return {
                status: 'confirmed',
                account: session.accountInfo.account,
                message: '扫码登录成功！'
            };
        }

        // 构造向移动云盘官方 thirdlogin 轮询的参数
        const secinfo = crypto.createHash('sha1').update(`fetion.com.cn:${sID}`).digest('hex').toUpperCase();
        const payload = {
            msisdn: '',
            random: '',
            dycpwd: sID,
            cpid: 292,
            clienttype: 670,
            version: 'mCloud_4.3.0_536',
            pintype: 21,
            secinfo: secinfo,
            loginMode: '0',
            extInfo: { ifOpenAccount: false }
        };

        const proxy = ProxyUtil.getProxy('cloud139');
        let agent = undefined;
        if (proxy && proxy.https) {
            agent = { https: proxy.https };
        }

        try {
            const resp = await got.post('https://user-njs.yun.139.com/user/thirdlogin', {
                json: payload,
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://yun.139.com',
                    'Referer': 'https://yun.139.com/',
                    'x-NationCode': '+86'
                },
                responseType: 'json',
                timeout: { request: 5000 },
                agent
            });

            const body = resp.body || {};
            // 扫码成功
            if (body.success && body.data) {
                let authData = body.data;
                if (typeof authData === 'string') {
                    authData = this._decryptCaiyunData(authData);
                }

                if (!authData || !authData.token) {
                    logger.warn('扫码响应成功但未提取到有效 token', { data: body.data });
                    return { status: 'waiting', message: '手机端已扫码，等待确认授权中...' };
                }

                const accountPhone = String(authData.account || '').trim();
                const authToken = String(authData.token || '').trim();
                const authorization = `Basic ${Buffer.from(`pc:${accountPhone}:${authToken}`).toString('base64')}`;

                // 自动保存绑定至数据库
                const { accountRepo, folderCache } = deps;
                if (accountRepo) {
                    let acc = await accountRepo.findOne({ where: { username: accountPhone } });
                    if (acc) {
                        acc.authorization = authorization;
                        acc.cookies = authorization;
                        acc.isActive = true;
                        await accountRepo.save(acc);
                        Cloud139Service.clearInstance(acc);
                        logger.info(`扫码登录：已成功刷新已有账号凭证 [${accountPhone}]`);
                    } else {
                        const totalAccounts = await accountRepo.count();
                        acc = accountRepo.create({
                            username: accountPhone,
                            alias: `139-${accountPhone.slice(-4)}`,
                            accountType: 'cloud139',
                            authorization: authorization,
                            cookies: authorization,
                            isActive: true,
                            isDefault: totalAccounts === 0
                        });
                        await accountRepo.save(acc);
                        logger.info(`扫码登录：已成功自动录入全新账号 [${accountPhone}]`);
                    }

                    if (folderCache) {
                        folderCache.clearPrefix('folders_');
                    }
                }

                session.status = 'confirmed';
                session.accountInfo = { account: accountPhone, authorization };

                return {
                    status: 'confirmed',
                    account: accountPhone,
                    message: `扫码登录成功！账号 [${accountPhone}] 已就绪。`
                };
            }

            // 官方特定失效错误码判断
            const code = String(body.code || '');
            if (['200059543', '200059545', '200059546', '200059547', '102103'].includes(code)) {
                session.status = 'expired';
                return { status: 'expired', message: '二维码已在官方端失效，请点击刷新' };
            }

            // 等待扫码中
            return {
                status: 'waiting',
                message: '请打开中国移动云盘 App 或微信扫一扫'
            };

        } catch (netErr) {
            logger.warn(`轮询移动云盘二维码状态网络抖动: ${netErr.message}`);
            return { status: 'waiting', message: '正在同步手机扫码状态...' };
        }
    }
}

const qrLoginService = new Cloud139QrLoginService();
module.exports = {
    Cloud139QrLoginService,
    qrLoginService
};

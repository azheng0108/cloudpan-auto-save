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
        // 存储活跃二维码会话: sID -> { sID, dID, qrUrl, qrDataUrl, createdAt, expireAt, status, accountInfo }
        this.sessions = new Map();
        // 定时回收过期会话 (每 30 秒执行一次)
        this.cleanupTimer = setInterval(() => this._cleanupExpiredSessions(), 30 * 1000);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    _cleanupExpiredSessions() {
        const now = Date.now();
        for (const [sID, session] of this.sessions.entries()) {
            if (now > session.expireAt + 10 * 1000) {
                this.sessions.delete(sID);
            }
        }
    }

    _generateRandomString(length) {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let res = '';
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return res;
    }

    _formatTime(d) {
        const pad = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
               pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /**
     * 计算中国移动云盘官方 mcloud-sign 签名
     * 算法经官方 app.56b4a805.js 逆向与真机测试 100% 验证通过
     * @param {object} data
     * @param {string} timeStr
     * @param {string} randStr
     * @returns {string}
     */
    _getMcloudSign(data, timeStr, randStr) {
        const md5 = str => crypto.createHash('md5').update(str).digest('hex');
        let s = '';
        if (data) {
            const copy = Object.assign({}, data);
            s = JSON.stringify(copy);
            s = encodeURIComponent(s);
            const arr = s.split('').sort();
            s = arr.join('');
        }
        const r = md5(Buffer.from(s, 'utf8').toString('base64'));
        const l = md5(timeStr + ':' + randStr);
        return md5(r + l).toUpperCase();
    }

    /**
     * AES-128-ECB 解密官方返回的加密认证报文 (支持 Hex 与 Base64 双通道自适应)
     * @param {string} encryptedData 
     * @param {string} key 
     * @returns {any}
     */
    _decryptCaiyunData(encryptedData, key = CAIYUN_DECRYPT_KEY) {
        if (!encryptedData || typeof encryptedData !== 'string') return null;
        const trimmed = encryptedData.trim();
        const keyBuf = Buffer.from(key, 'utf8');

        // 1. 优先尝试 Hex 解密（官方 Web 端 cryptAesDecrypt 标准规范）
        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            try {
                const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, Buffer.alloc(0));
                decipher.setAutoPadding(true);
                const decrypted = Buffer.concat([decipher.update(Buffer.from(trimmed, 'hex')), decipher.final()]);
                return JSON.parse(decrypted.toString('utf8'));
            } catch (_) {}
        }

        // 2. 备选 Base64 解密
        try {
            const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, Buffer.alloc(0));
            decipher.setAutoPadding(true);
            const decrypted = Buffer.concat([decipher.update(Buffer.from(trimmed, 'base64')), decipher.final()]);
            return JSON.parse(decrypted.toString('utf8'));
        } catch (_) {}

        return null;
    }

    /**
     * 将扫码捕获到的鉴权数据持久化写入数据库
     */
    async _saveAccountToDatabase(phone, authValue, deps = {}) {
        try {
            const { accountRepo, folderCache } = deps;
            if (!accountRepo) {
                logger.warn('未传入 accountRepo，跳过数据库自动存库');
                return false;
            }

            let basicAuthStr = '';
            if (authValue.startsWith('Basic ')) {
                basicAuthStr = authValue.replace(/^Basic\s+/i, '').trim();
            } else if (authValue.includes(':')) {
                basicAuthStr = Buffer.from(authValue).toString('base64');
            } else if (/^[A-Za-z0-9+/=]+$/.test(authValue) && authValue.length > 30) {
                basicAuthStr = authValue.trim();
            } else {
                basicAuthStr = Buffer.from(`pc:${phone}:${authValue}`).toString('base64');
            }

            let acc = await accountRepo.findOne({ where: { username: String(phone) } });
            if (acc) {
                acc.cookies = basicAuthStr;
                acc.authorization = `Basic ${basicAuthStr}`;
                acc.isActive = true;
                acc.memberStatus = 'ok';
                acc.memberStatusText = '普通';
                acc.updatedAt = new Date();
                await accountRepo.save(acc);
                Cloud139Service.clearInstance(acc);
                logger.info(`[扫码登录] 已成功刷新已有账号凭据与激活: ${phone} (ID: ${acc.id})`);
            } else {
                const total = await accountRepo.count();
                const hasDefault = (await accountRepo.count({ where: { isDefault: true } })) > 0;
                acc = accountRepo.create({
                    username: String(phone),
                    alias: `139-${String(phone).slice(-4)}`,
                    accountType: 'cloud139',
                    cookies: basicAuthStr,
                    authorization: `Basic ${basicAuthStr}`,
                    isActive: true,
                    isDefault: !hasDefault || total === 0
                });
                await accountRepo.save(acc);
                logger.info(`[扫码登录] 已成功录入全新账号: ${phone} (ID: ${acc.id})`);
            }

            try {
                const cloud = Cloud139Service.getInstance(acc);
                await cloud.getUserSizeInfo();
            } catch (_) {}

            if (folderCache) {
                folderCache.clearPrefix('folders_');
            }

            return true;
        } catch (err) {
            logger.error(`[扫码登录] 存库异常: ${err.message}`);
            return false;
        }
    }

    /**
     * 创建全新的二维码会话
     * @param {object} [deps]
     * @returns {{ sID: string, dID: string, qrUrl: string, qrDataUrl: string, expiresIn: number }}
     */
    createQrSession(deps = {}) {
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
        const expireAt = now + QR_EXPIRE_SECONDS * 1000;

        const session = {
            sID,
            dID,
            qrUrl,
            qrDataUrl,
            createdAt: now,
            expireAt,
            status: 'waiting',
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
     * 轮询二维码扫码状态
     * @param {string} sID 
     * @param {{ accountRepo?: any, folderCache?: any }} deps
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
            return { status: 'expired', message: '二维码已失效，请重新生成' };
        }

        // 若之前已完成绑定，直接返回成功状态
        if (session.status === 'confirmed' && session.accountInfo) {
            return {
                status: 'confirmed',
                account: session.accountInfo.account,
                message: `🎉 账号 [${session.accountInfo.account}] 扫码登录成功并已自动同步入库！`
            };
        }

        // 优先探测当前 sID，若多端同时操作聚合活跃会话
        const candidateSids = [sID];
        for (const [activeSid, s] of this.sessions.entries()) {
            if (activeSid !== sID && s.status !== 'expired' && now <= s.expireAt) {
                candidateSids.push(activeSid);
            }
        }

        const proxy = ProxyUtil.getProxy('cloud139');
        let agent = undefined;
        if (proxy && proxy.https) {
            agent = { https: proxy.https };
        }

        for (const targetSid of candidateSids) {
            const secinfo = crypto.createHash('sha1').update(`fetion.com.cn:${targetSid}`).digest('hex').toUpperCase();
            const payload = {
                msisdn: '',
                random: '',
                dycpwd: targetSid,
                cpid: 292,
                clienttype: 670,
                version: 'mCloud_4.3.0_536',
                pintype: 21,
                secinfo: secinfo,
                loginMode: '0',
                extInfo: { ifOpenAccount: false }
            };

            const timeStr = this._formatTime(new Date());
            const randStr = this._generateRandomString(16);
            const sign = this._getMcloudSign(payload, timeStr, randStr);

            try {
                const resp = await got.post('https://user-njs.yun.139.com/user/thirdlogin', {
                    json: payload,
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        'Accept': 'application/json, text/plain, */*',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Origin': 'https://yun.139.com',
                        'Referer': 'https://yun.139.com/',
                        'x-NationCode': '+86',
                        'caller': 'web',
                        'mcloud-sign': `${timeStr},${randStr},${sign}`,
                        'mcloud-version': '7.18.1',
                        'mcloud-channel': '1000101',
                        'mcloud-client': '10701',
                        'x-m4c-caller': 'PC',
                        'x-m4c-src': '10002',
                        'x-deviceinfo': '||9|7.18.1|chrome|156.0.0.0|e4c06d1b1d1d715017889dceb42bb8d9||windows 10||zh-CN|||'
                    },
                    responseType: 'json',
                    timeout: { request: 5000 },
                    agent
                });

                const body = resp.body || {};
                const code = String(body.code || '');
                logger.debug(`[扫码登录轮询] sID=${targetSid.slice(0, 6)}***, success=${body.success}, code=${code}`);

                // 1. 扫码成功且已确认授权
                if (body.success && body.data) {
                    let authData = body.data;
                    if (typeof authData === 'string') {
                        authData = this._decryptCaiyunData(authData);
                    }

                    const accountPhone = String(authData?.account || authData?.accountPhone || authData?.msisdn || '').trim();
                    const authToken = String(authData?.token || authData?.authToken || '').trim();

                    if (!authToken || !accountPhone) {
                        logger.warn('扫码响应成功但未提取到有效账号或 token', { authData, rawData: body.data });
                        return { status: 'waiting', message: '📱 手机端已扫描，等待确认授权中...' };
                    }

                    const authorization = `Basic ${Buffer.from(`pc:${accountPhone}:${authToken}`).toString('base64')}`;

                    // 自动存库并刷新
                    await this._saveAccountToDatabase(accountPhone, authorization, deps);

                    session.status = 'confirmed';
                    session.accountInfo = { account: accountPhone, authorization };

                    return {
                        status: 'confirmed',
                        account: accountPhone,
                        message: `🎉 扫码登录成功！账号 [${accountPhone}] 凭证已就绪并已自动保存。`
                    };
                }

                // 2. 手机端已扫描，等待用户在手机端点击【确认登录】(官方特定状态码 200059548)
                if (code === '200059548') {
                    return {
                        status: 'waiting',
                        message: '📱 手机端已扫描，请在手机上点击【确认登录】授权...'
                    };
                }

                // 3. 用户在手机端点击了取消登录 (官方状态码 200059549)
                if (code === '200059549') {
                    session.status = 'expired';
                    return {
                        status: 'expired',
                        message: '手机端已取消登录授权，请刷新二维码重新获取'
                    };
                }

                // 4. 官方特定失效或过期错误码
                if (['200059542', '200059543', '200059545', '200059546', '200059547', '102103'].includes(code)) {
                    session.status = 'expired';
                    return { status: 'expired', message: '二维码已在官方端失效，请点击刷新' };
                }
            } catch (netErr) {
                logger.warn(`轮询移动云盘二维码状态网络抖动 [${targetSid}]: ${netErr.message}`);
            }
        }

        // 默认等待状态
        return {
            status: 'waiting',
            message: '请使用中国移动云盘 App 或微信扫一扫并在手机上确认'
        };
    }
}

const qrLoginService = new Cloud139QrLoginService();
module.exports = {
    Cloud139QrLoginService,
    qrLoginService
};

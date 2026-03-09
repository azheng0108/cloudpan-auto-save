'use strict';

/**
 * Cloud139Utils — 移动云盘（139网盘）工具类
 *
 * 对应 Cloud189Utils，提供：
 *  - 分享链接解析（linkID + passwd 提取）
 *  - Authorization 头解析
 *  - 文件 ID 集合对比（更新检测辅助）
 */

class Cloud139Utils {
    /**
     * 解析 139 网盘分享链接，提取 linkID 和 passwd
     *
     * 支持格式：
     *   https://yun.139.com/w/r?linkID=zy0DDGAkum96&passwd=XD7G
     *   https://yun.139.com/k/note?linkID=zy0DDGAkum96
     *   https://yun.139.com/shareweb/#/w/i/zy0DDGAkum96
     *   http://caiyun.139.com/front/#/detail?linkID=1A5Cvuwm30xlB
     *   https://caiyun.139.com/m/i?1A5CvaomUVFKk
     *   yun.139.com/w/r?linkID=zy0DDGAkum96
     *   zy0DDGAkum96                               （纯 linkID）
     *
     * @param {string} input
     * @returns {{ linkID: string, passwd: string }}
     */
    static parseShareLink(input) {
        if (!input || typeof input !== 'string') {
            throw new Error('无效的分享链接');
        }

        const trimmed = input.trim();

        // 纯 linkID（无 "/" 且只含字母数字）
        if (/^[a-zA-Z0-9_-]{4,32}$/.test(trimmed) && !trimmed.includes('/')) {
            return { linkID: trimmed, passwd: '' };
        }

        // 补全协议
        const urlStr = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

        let url;
        try {
            url = new URL(urlStr);
        } catch {
            throw new Error(`无法解析链接: ${trimmed}`);
        }

        if (!url.hostname.endsWith('139.com')) {
            throw new Error(`不是有效的 139 网盘链接（域名不匹配）: ${url.hostname}`);
        }

        // 1. 常规 query 参数：?linkID=xxx 或 ?linkId=xxx
        let linkID = url.searchParams.get('linkID') || url.searchParams.get('linkId');

        // 2. caiyun.139.com/m/i?{linkID} —— linkID 作为 query string 的键（无值）
        if (!linkID && url.search && url.search.length > 1) {
            const bare = url.search.slice(1); // 去掉 '?'
            if (/^[a-zA-Z0-9_-]{4,32}$/.test(bare)) {
                linkID = bare;
            }
        }

        // 3. Hash 路径格式：#/w/i/{linkID} 或 #/w/r/{linkID}
        if (!linkID && url.hash) {
            // 先尝试 hash 中的 query 参数：#/detail?linkID=xxx
            const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?')) : '';
            if (hashQuery) {
                const hParams = new URLSearchParams(hashQuery);
                linkID = hParams.get('linkID') || hParams.get('linkId');
            }
            // 再尝试 hash 路径末段：#/w/i/{linkID}
            if (!linkID) {
                const hashParts = url.hash.split(/[/?]/);
                const candidate = hashParts[hashParts.length - 1];
                if (candidate && /^[a-zA-Z0-9_-]{4,32}$/.test(candidate)) {
                    linkID = candidate;
                }
            }
        }

        if (!linkID) {
            throw new Error(`链接中未找到 linkID 参数: ${trimmed}`);
        }

        const passwd = url.searchParams.get('passwd') || url.searchParams.get('pwd') || '';
        return { linkID, passwd };
    }

    /**
     * 从分享文本（可能含多余说明文字）中提取纯 URL 和提取码
     * 支持移动云盘 APP 分享文本格式：
     *   "我用中国移动云盘给你分享的文件："xxx" 链接: https://yun.139.com/... 提取码: xxxx /*xxx:/ ..."
     *
     * @param {string} text
     * @returns {{ url: string, passwd: string } | null}
     */
    static extractFromShareText(text) {
        if (!text || typeof text !== 'string') return null;
        // 已经是纯 URL 则直接返回
        if (/^https?:\/\/(?:yun|caiyun)\.139\.com\//i.test(text.trim())) {
            return { url: text.trim(), passwd: '' };
        }
        // 从文本中提取 yun.139.com / caiyun.139.com URL
        const urlMatch = text.match(/https?:\/\/(?:yun|caiyun)\.139\.com[^\s]*/i);
        if (!urlMatch) return null;
        const url = urlMatch[0];
        // 提取提取码（/*xxx:/ 不是提取码，忽略它；只匹配"提取码"关键字后的4~8位字母数字）
        let passwd = '';
        const pwdMatch = text.match(/提取码[：:]\s*([a-zA-Z0-9]{4,8})/);
        if (pwdMatch) passwd = pwdMatch[1];
        return { url, passwd };
    }

    /**
     * 从包含分享链接的文本中提取链接（含密码）
     *
     * 支持格式如：
     *   "分享给你 https://yun.139.com/w/r?linkID=xxx&passwd=XD7G 快来保存"
     *   "链接: yun.139.com/w/r?linkID=xxx （密码: XD7G）"
     *
     * @param {string} text
     * @returns {{ linkID: string, passwd: string } | null}
     */
    static parseCloudShare(text) {
        if (!text) return null;

        // 无空格版本
        const cleaned = text.replace(/\s/g, '');

        // 提取 linkID
        const linkIDMatch = cleaned.match(/linkID=([a-zA-Z0-9_-]{4,32})/i);
        if (!linkIDMatch) return null;

        const linkID = linkIDMatch[1];

        // 提取密码（多种格式）
        const passwdPatterns = [
            /passwd=([a-zA-Z0-9]{4,8})/i,
            /pwd=([a-zA-Z0-9]{4,8})/i,
            /[（(]密码[：:]\s*([a-zA-Z0-9]{4,8})[）)]/,
            /[（(]提取码[：:]\s*([a-zA-Z0-9]{4,8})[）)]/,
            /密码[：:]\s*([a-zA-Z0-9]{4,8})/,
            /提取码[：:]\s*([a-zA-Z0-9]{4,8})/,
        ];

        let passwd = '';
        for (const pattern of passwdPatterns) {
            const m = cleaned.match(pattern);
            if (m) { passwd = m[1]; break; }
        }

        return { linkID, passwd };
    }

    /**
     * 解析 Authorization 头，提取手机号和 token 信息
     *
     * 格式：Basic base64(platform:phone:token|...|expire)
     *
     * @param {string} authStr - "Basic xxxx" 或 raw base64
     * @returns {{ platform, phone, token, expire, auth }}
     */
    static parseAuth(authStr) {
        if (!authStr) throw new Error('authStr 不能为空');
        const raw = authStr.replace(/^Basic\s+/i, '');
        const padded = raw.length % 4 === 0 ? raw : raw + '='.repeat(4 - raw.length % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        const [platform, phone, token] = decoded.split(':');
        if (!phone) throw new Error('Authorization 格式不正确，无法解析手机号');
        const expire = Number((token || '').split('|')[3] || 0);
        return { platform, phone, token, expire, auth: `Basic ${raw}` };
    }

    /**
     * 验证 linkID 格式
     * @param {string} linkID
     * @returns {boolean}
     */
    static isValidLinkID(linkID) {
        return typeof linkID === 'string' && /^[a-zA-Z0-9_-]{4,32}$/.test(linkID);
    }

    /**
     * 对比新旧文件 ID 集合，返回新增的文件 ID 列表
     *
     * @param {string[] | Set<string>} oldIDs
     * @param {string[]} newIDs
     * @returns {string[]}
     */
    static diffFileIDs(oldIDs, newIDs) {
        const old = new Set(Array.isArray(oldIDs) ? oldIDs : [...oldIDs]);
        return newIDs.filter(id => !old.has(id));
    }

    /**
     * 从 getOutLinkInfo 返回的 coLst（文件列表）中提取简洁信息
     *
     * @param {object[]} coLst
     * @returns {Array<{contentID, contentName, contentSize, updateTime, suffix}>}
     */
    static extractFileInfo(coLst = []) {
        return coLst.map(f => ({
            contentID: f.contentID,
            contentName: f.contentName,
            contentSize: f.contentSize,
            updateTime: f.updateTime,
            suffix: f.contentSuffix || '',
        }));
    }
}

module.exports = Cloud139Utils;

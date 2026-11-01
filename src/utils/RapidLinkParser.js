/**
 * RapidLinkParser - 统一快链、秒传特征码与 CAS 归档解析器
 * 
 * 核心原则：
 * 【移动云盘 139 仅接受 64 位 SHA256 算法的秒传特征码】
 * 
 * 支持识别与转换格式：
 * 1. Base64 CAS 格式（.cas 文件内容、cas:// 前缀、CAS$ 前缀或纯 base64 字符串）
 *    - 包含: name, size, sha256 (64位), md5, sliceMd5, create_time
 * 2. JSON 数组或单对象（如 [{ name, size, sha256 }, ...]）
 * 3. 139 移动云盘专用快链格式:
 *    - 139FSLinkV2$<sha256>#<size>#<filename>
 *    - 139FSLink$<sha256>#<size>#<filename>
 *    - 139://<filename>#<size>#<sha256>
 *    - <filename>#<size>#<sha256> 或 <filename>|<size>|<sha256>
 *    - <sha256>#<size>#<filename>
 * 4. 123 网盘快链格式 (123FSLinkV2$<md5>#<size>#<filename>):
 *    - 提取后明确标注仅含 32 位 MD5，供离线调度或防呆拦截
 */

class RapidLinkParser {
    /**
     * 格式化字节大小为易读形式
     */
    static formatBytes(bytes) {
        const num = parseInt(bytes, 10);
        if (isNaN(num) || num <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const base = 1024;
        const exp = Math.min(Math.floor(Math.log(num) / Math.log(base)), units.length - 1);
        const val = num / Math.pow(base, exp);
        return `${val.toFixed(exp >= 3 ? 2 : 1)} ${units[exp]}`;
    }

    /**
     * 清理文件名，去除开头的虚拟绝对路径（如 /media/临时存放/）
     */
    static sanitizeFileName(rawName) {
        if (!rawName) return '';
        let clean = String(rawName).trim();
        if (clean.includes('/') || clean.includes('\\')) {
            const parts = clean.split(/[/\\]+/).filter(Boolean);
            if (parts.length > 0) {
                clean = parts[parts.length - 1];
            }
        }
        return clean.trim();
    }

    /**
     * 解析输入内容（文本字符串或 Buffer）
     */
    static parse(input) {
        if (!input) {
            return { success: false, count: 0, valid139Count: 0, totalSize: 0, totalSizeFormatted: '0 B', items: [] };
        }

        const text = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input)).trim();
        if (!text) {
            return { success: false, count: 0, valid139Count: 0, totalSize: 0, totalSizeFormatted: '0 B', items: [] };
        }

        const items = [];

        // 1. 尝试作为 JSON
        if (text.startsWith('[') || text.startsWith('{')) {
            try {
                const parsed = JSON.parse(text);
                const list = Array.isArray(parsed) ? parsed : [parsed];
                for (const obj of list) {
                    if (obj && typeof obj === 'object') {
                        const hash = String(obj.sha256 || obj.contentHash || obj.hash || obj.md5 || '').trim().toLowerCase();
                        const size = parseInt(obj.size, 10) || 0;
                        const name = this.sanitizeFileName(obj.name || obj.fileName || obj.filename);
                        if (name && (hash || size > 0)) {
                            const isSha256 = hash.length === 64;
                            items.push({
                                name,
                                size,
                                sha256: isSha256 ? hash : (obj.sha256 || ''),
                                md5: hash.length === 32 ? hash : (obj.md5 || ''),
                                validFor139: isSha256,
                                sizeReadable: this.formatBytes(size),
                                raw: JSON.stringify(obj)
                            });
                        }
                    }
                }
                if (items.length > 0) {
                    return this._buildResult(items);
                }
            } catch (_) {}
        }

        // 2. 逐行解析
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        for (const line of lines) {
            // A. Base64 CAS 格式
            let casCandidate = line.replace(/^cas:\/\//i, '').replace(/^CAS\$/i, '').trim();
            if (/^[A-Za-z0-9+/=]{40,}$/.test(casCandidate)) {
                try {
                    const decodedStr = Buffer.from(casCandidate, 'base64').toString('utf8');
                    if (decodedStr.startsWith('{') || decodedStr.startsWith('[')) {
                        const casObj = JSON.parse(decodedStr);
                        const casList = Array.isArray(casObj) ? casObj : [casObj];
                        for (const it of casList) {
                            const hash = String(it.sha256 || it.contentHash || it.hash || it.md5 || '').trim().toLowerCase();
                            const size = parseInt(it.size, 10) || 0;
                            const name = this.sanitizeFileName(it.name || it.filename || it.fileName);
                            if (name && (hash || size > 0)) {
                                const isSha256 = hash.length === 64;
                                items.push({
                                    name,
                                    size,
                                    sha256: isSha256 ? hash : (it.sha256 || ''),
                                    md5: hash.length === 32 ? hash : (it.md5 || ''),
                                    validFor139: isSha256,
                                    sizeReadable: this.formatBytes(size),
                                    raw: line
                                });
                            }
                        }
                        continue;
                    }
                } catch (_) {}
            }

            // B. 139FSLink 专用格式: 139FSLinkV2$<sha256>#<size>#<filename>
            const match139FS = line.match(/^139FSLink(?:V\d+)?\$([a-fA-F0-9]{64})#(\d+)#(.+)$/i);
            if (match139FS) {
                const hash = match139FS[1].trim().toLowerCase();
                const size = parseInt(match139FS[2].trim(), 10) || 0;
                const name = this.sanitizeFileName(match139FS[3].trim());
                if (name) {
                    items.push({
                        name,
                        size,
                        sha256: hash,
                        validFor139: true,
                        sizeReadable: this.formatBytes(size),
                        raw: line
                    });
                    continue;
                }
            }

            // C. 123FSLink 格式: 123FSLinkV2$<md5/hash>#<size>#<filename>
            const match123 = line.match(/^123FSLink(?:V\d+)?\$([a-fA-F0-9]{32,64})#(\d+)#(.+)$/i);
            if (match123) {
                const hash = match123[1].trim().toLowerCase();
                const size = parseInt(match123[2].trim(), 10) || 0;
                const name = this.sanitizeFileName(match123[3].trim());
                if (name) {
                    const isSha256 = hash.length === 64;
                    items.push({
                        name,
                        size,
                        sha256: isSha256 ? hash : '',
                        md5: hash.length === 32 ? hash : '',
                        sourceType: '123pan',
                        validFor139: isSha256, // 移动 139 仅接受 SHA256
                        sizeReadable: this.formatBytes(size),
                        raw: line
                    });
                    continue;
                }
            }

            // D. 经典 139 格式: 文件名#大小#SHA256 或 139:// 前缀
            const cleanLine = line.replace(/^139:\/\//i, '').trim();
            let parts = cleanLine.split('#');
            if (parts.length < 3) parts = cleanLine.split('|');

            if (parts.length >= 3) {
                const p0 = parts[0].trim();
                const p1 = parts[1].trim();
                const p2 = parts[2].trim();

                let name = '';
                let size = 0;
                let hash = '';

                if (/^[a-fA-F0-9]{32,64}$/.test(p0) && /^\d+$/.test(p1)) {
                    hash = p0.toLowerCase();
                    size = parseInt(p1, 10) || 0;
                    name = this.sanitizeFileName(parts.slice(2).join('#'));
                } else if (/^\d+$/.test(p1) && /^[a-fA-F0-9]{32,64}$/.test(p2)) {
                    name = this.sanitizeFileName(p0);
                    size = parseInt(p1, 10) || 0;
                    hash = p2.toLowerCase();
                }

                if (name && hash) {
                    const isSha256 = hash.length === 64;
                    items.push({
                        name,
                        size,
                        sha256: isSha256 ? hash : '',
                        md5: hash.length === 32 ? hash : '',
                        validFor139: isSha256,
                        sizeReadable: this.formatBytes(size),
                        raw: line
                    });
                    continue;
                }
            }
        }

        return this._buildResult(items);
    }

    static _buildResult(items) {
        const valid139Items = items.filter(i => i.validFor139);
        const totalSize = valid139Items.reduce((sum, it) => sum + (it.size || 0), 0);
        return {
            success: items.length > 0,
            count: items.length,
            valid139Count: valid139Items.length,
            totalSize,
            totalSizeFormatted: this.formatBytes(totalSize),
            items
        };
    }
}

module.exports = { RapidLinkParser };

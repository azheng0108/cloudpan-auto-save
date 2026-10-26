const pLimit = require('p-limit');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');
const { Pan123Service } = require('./Pan123Service');

class AssetSyncService {
    /**
     * 递归扫描 139 源网盘目录下的全部媒体与数据文件
     * @param {object} cloud139 - 源账号 Cloud139Service 实例
     * @param {string} folderId - 待扫描目录 ID (根目录为 "/" 或 "-11")
     * @param {object} [options]
     * @returns {Promise<{totalFiles: number, totalSize: number, totalSizeFormatted: string, files: Array, folderName: string}>}
     */
    static async scanSourceFiles(cloud139, folderId = '/', options = {}) {
        const rootId = (!folderId || folderId === '-11') ? '/' : folderId;
        const seenIds = new Set();
        const files = [];
        let totalSize = 0;

        const mediaOnly = Boolean(options.mediaOnly);
        const mediaExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.ts', '.flv', '.wmv', '.iso', '.m4v', '.rmvb', '.strm', '.nfo', '.srt', '.ass', '.vtt'];

        const scanRecursive = async (catalogId, relativePath = '') => {
            const items = await cloud139.listDiskDirAll(catalogId).catch(err => {
                logger.warn(`[资产同步] 扫描子目录 [${catalogId}] 异常: ${err.message}`);
                return [];
            });

            for (const item of items) {
                const fileId = item.fileId || item.id;
                if (!fileId || seenIds.has(String(fileId))) continue;

                const name = item.name || item.fileName || '';
                const isFolder = item.type === 'folder' || item.fileType === 'folder';

                if (isFolder) {
                    const subRel = relativePath ? `${relativePath}/${name}` : name;
                    await scanRecursive(fileId, subRel);
                } else {
                    seenIds.add(String(fileId));
                    const ext = (item.extension || '').toLowerCase();
                    if (mediaOnly && ext && !mediaExtensions.includes(ext.startsWith('.') ? ext : '.' + ext)) {
                        continue;
                    }

                    const size = Number(item.size || 0);
                    totalSize += size;

                    files.push({
                        fileId,
                        name,
                        size,
                        sizeFormatted: this.formatBytes(size),
                        contentHash: String(item.contentHash || item.sha256 || '').toLowerCase().trim(),
                        relativePath,
                        updatedAt: item.updatedAt
                    });
                }
            }
        };

        await scanRecursive(rootId, '');

        return {
            totalFiles: files.length,
            totalSize,
            totalSizeFormatted: this.formatBytes(totalSize),
            files,
            folderName: rootId === '/' ? '根目录' : `目录 (ID: ${rootId})`
        };
    }

    /**
     * 139 账号间跨号秒传（基于 139 PC 官方 /hcy/file/create 纯协议）
     * @param {object} sourceCloud139 - 源 139 账号实例
     * @param {object} targetCloud139 - 目标 139 账号实例
     * @param {object} params
     * @param {Array} params.files - 待同步文件清单 [{fileId, name, contentHash, size, relativePath}]
     * @param {string} [params.targetParentId='/'] - 目标落盘根目录 ID
     * @param {boolean} [params.existSkip=true] - 目标已存在同特征文件自动跳过
     * @param {boolean} [params.preservePath=true] - 保持源目录子层级结构
     * @param {boolean} [params.trashSource=false] - 秒传成功后将源账号文件移入源回收站 (0 物理硬删)
     * @returns {Promise<{total: number, successCount: number, existCount: number, failCount: number, trashedSourceCount: number, details: Array}>}
     */
    static async executeCrossAccountSync(sourceCloud139, targetCloud139, params = {}) {
        const {
            files = [],
            targetParentId = '/',
            existSkip = true,
            preservePath = true,
            trashSource = false
        } = params;

        const details = [];
        let successCount = 0;
        let existCount = 0;
        let failCount = 0;
        let trashedSourceCount = 0;

        const sourceTrashQueue = [];
        const targetDirCache = new Map(); // relativePath -> targetFolderId
        targetDirCache.set('', targetParentId || '/');

        // 目录幂等建树辅助函数
        const resolveTargetDir = async (relPath) => {
            if (!preservePath || !relPath) return targetParentId || '/';
            if (targetDirCache.has(relPath)) return targetDirCache.get(relPath);

            const segments = relPath.split('/').filter(Boolean);
            let currentId = targetParentId || '/';
            let currentPath = '';

            for (const seg of segments) {
                currentPath = currentPath ? `${currentPath}/${seg}` : seg;
                if (targetDirCache.has(currentPath)) {
                    currentId = targetDirCache.get(currentPath);
                } else {
                    const foundId = await targetCloud139.findFolderByName(currentId, seg);
                    if (foundId) {
                        currentId = foundId;
                    } else {
                        const created = await targetCloud139.createFolderHcy(currentId, seg);
                        currentId = created?.fileId || currentId;
                    }
                    targetDirCache.set(currentPath, currentId);
                }
            }
            return currentId;
        };

        const limit = pLimit(3); // 3 线程并发秒传，稳定防频控

        const syncTasks = files.map((file) => limit(async () => {
            const cleanHash = String(file.contentHash || '').trim().toLowerCase();
            const pureSize = Number(file.size || 0);
            const fileName = String(file.name || '').trim();

            if (!cleanHash || cleanHash.length !== 64) {
                failCount++;
                details.push({
                    fileId: file.fileId,
                    name: fileName,
                    status: 'failed',
                    reason: '缺少 64 位 SHA256 特征码，无法执行秒传'
                });
                return;
            }

            try {
                // 1. 定位目标父目录
                const finalParentId = await resolveTargetDir(file.relativePath);

                // 2. 目标已存在预检（若勾选 existSkip）
                if (existSkip) {
                    const targetItems = await targetCloud139.listDiskDir(finalParentId).catch(() => ({ items: [] }));
                    const hit = (targetItems?.items || []).find(it => {
                        const itHash = String(it.contentHash || it.sha256 || '').toLowerCase().trim();
                        return (itHash && itHash === cleanHash) || (it.name === fileName && Number(it.size || 0) === pureSize);
                    });

                    if (hit) {
                        existCount++;
                        details.push({
                            fileId: file.fileId,
                            name: fileName,
                            targetFileId: hit.fileId,
                            status: 'exist',
                            reason: '目标目录已存在同名/同特征文件 (自动跳过)'
                        });
                        return;
                    }
                }

                // 3. 目标账号调用 /hcy/file/create 执行秒传
                const uploadRes = await targetCloud139.createManualUploadFile({
                    name: fileName,
                    contentHash: cleanHash,
                    size: pureSize,
                    parentFileId: finalParentId
                });

                const createdId = uploadRes?.fileId || uploadRes?.id;
                if (uploadRes?.exist || uploadRes?.rapidUpload || createdId) {
                    successCount++;
                    details.push({
                        fileId: file.fileId,
                        name: fileName,
                        targetFileId: createdId,
                        status: 'success',
                        message: '秒传创建成功'
                    });

                    // 若需安全清理源文件，推入回收站队列
                    if (trashSource && file.fileId) {
                        sourceTrashQueue.push(file.fileId);
                    }
                } else {
                    failCount++;
                    details.push({
                        fileId: file.fileId,
                        name: fileName,
                        status: 'failed',
                        reason: '服务端未命中该特征码 (可能文件未在 139 云端就绪)'
                    });
                }
            } catch (err) {
                failCount++;
                details.push({
                    fileId: file.fileId,
                    name: fileName,
                    status: 'failed',
                    reason: err.message || '跨号秒传异常'
                });
            }
        }));

        await Promise.all(syncTasks);

        // 4. 执行源账号批量软删除 (batchTrash，绝不硬删除)
        if (trashSource && sourceTrashQueue.length > 0) {
            try {
                await sourceCloud139.batchTrash(sourceTrashQueue);
                trashedSourceCount = sourceTrashQueue.length;
                logger.info(`[资产同步] 已将源账号 ${trashedSourceCount} 个已成功秒传的文件安全移入 139 回收站`);
            } catch (trashErr) {
                logger.warn(`[资产同步] 源文件移入回收站异常: ${trashErr.message}`);
            }
        }

        return {
            total: files.length,
            successCount,
            existCount,
            failCount,
            trashedSourceCount,
            details
        };
    }

    /**
     * 将 139 目录中的文件提取并导出为标准秒传码清单 (格式: 文件名#大小#SHA256)
     */
    static async exportRapidLinks(cloud139, folderId = '/') {
        const scanResult = await this.scanSourceFiles(cloud139, folderId);
        const lines = [];
        const items = [];

        for (const f of scanResult.files) {
            if (f.contentHash && f.contentHash.length === 64) {
                const line = `${f.name}#${f.size}#${f.contentHash}`;
                lines.push(line);
                items.push({
                    name: f.name,
                    size: f.size,
                    hash: f.contentHash,
                    line
                });
            }
        }

        return {
            text: lines.join('\n'),
            totalFiles: scanResult.totalFiles,
            validLinkCount: lines.length,
            totalSizeFormatted: scanResult.totalSizeFormatted,
            items
        };
    }

    /**
     * 解析多行秒传文本，并在目标 139 账号中批量秒传落地
     */
    static async importRapidLinks(targetCloud139, rawText = '', targetFolderId = '/') {
        const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const parsedEntries = [];

        for (const line of lines) {
            // 支持格式 1: 文件名#大小#SHA256
            // 支持格式 2: 文件名|大小|SHA256
            // 支持格式 3: 139://文件名|大小|SHA256
            const cleanLine = line.replace(/^139:\/\//i, '');
            let parts = cleanLine.split('#');
            if (parts.length < 3) parts = cleanLine.split('|');

            if (parts.length >= 3) {
                const name = parts[0].trim();
                const size = parseInt(parts[1].trim(), 10) || 0;
                const hash = parts[2].trim().toLowerCase();

                if (name && hash.length === 64) {
                    parsedEntries.push({ name, size, hash });
                }
            }
        }

        if (parsedEntries.length === 0) {
            return {
                total: 0,
                successCount: 0,
                existCount: 0,
                failCount: 0,
                results: [],
                message: '未能识别出有效的秒传特征码行，请使用「文件名#大小#64位SHA256」格式'
            };
        }

        const limit = pLimit(3);
        let successCount = 0;
        let existCount = 0;
        let failCount = 0;
        const results = [];

        const importTasks = parsedEntries.map(entry => limit(async () => {
            try {
                const uploadRes = await targetCloud139.createManualUploadFile({
                    name: entry.name,
                    contentHash: entry.hash,
                    size: entry.size,
                    parentFileId: targetFolderId || '/'
                });

                const createdId = uploadRes?.fileId || uploadRes?.id;
                if (uploadRes?.exist || uploadRes?.rapidUpload || createdId) {
                    successCount++;
                    results.push({
                        name: entry.name,
                        size: entry.size,
                        hash: entry.hash,
                        fileId: createdId,
                        status: 'success',
                        message: '秒传成功'
                    });
                } else {
                    failCount++;
                    results.push({
                        name: entry.name,
                        size: entry.size,
                        hash: entry.hash,
                        status: 'failed',
                        reason: '服务端未命中该特征码'
                    });
                }
            } catch (err) {
                failCount++;
                results.push({
                    name: entry.name,
                    size: entry.size,
                    hash: entry.hash,
                    status: 'failed',
                    reason: err.message || '秒传创建异常'
                });
            }
        }));

        await Promise.all(importTasks);

        return {
            total: parsedEntries.length,
            successCount,
            existCount,
            failCount,
            results
        };
    }

    /**
     * 跨网盘直链离线下载：从 139 获取官方 CDN 高速下载直链并推送到 123 网盘
     */
    static async syncTo123Offline(cloud139, params = {}) {
        const {
            files = [],
            pan123TargetDirId = 0,
            pan123Config = {}
        } = params;

        const { username, password } = pan123Config;
        if (!username || !password) {
            throw new Error('未配置 123 网盘账号密码');
        }

        // 1. 获取 123 网盘鉴权 Token
        const loginRes = await Pan123Service.login(username, password);
        if (!loginRes.success || !loginRes.token) {
            throw new Error(`123 网盘登录失败: ${loginRes.message || '未知错误'}`);
        }
        const token = loginRes.token;

        // 2. 逐一向 139 换取官方 CDN 高速下载直链
        const itemsWithLinks = [];
        const linkFailures = [];

        for (const file of files) {
            try {
                const directUrl = await cloud139.getDownloadUrl(file.fileId);
                if (directUrl) {
                    itemsWithLinks.push({
                        fileId: file.fileId,
                        name: file.name,
                        url: directUrl
                    });
                } else {
                    linkFailures.push({ fileId: file.fileId, name: file.name, reason: '139 返回直链为空' });
                }
            } catch (linkErr) {
                linkFailures.push({ fileId: file.fileId, name: file.name, reason: linkErr.message });
            }
        }

        if (itemsWithLinks.length === 0) {
            return {
                total: files.length,
                submittedCount: 0,
                failedCount: files.length,
                linkFailures,
                message: '无法获取任何有效的 139 官方下载直链'
            };
        }

        // 3. 提交至 123 网盘离线下载队列
        const pushResult = await Pan123Service.pushOfflineBatch(itemsWithLinks, pan123TargetDirId || 0, token);

        return {
            total: files.length,
            submittedCount: pushResult.ok.length,
            failedCount: pushResult.fail.length + linkFailures.length,
            ok: pushResult.ok,
            fail: [...pushResult.fail, ...linkFailures]
        };
    }

    static formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

module.exports = { AssetSyncService };

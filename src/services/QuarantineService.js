const logger = require('../utils/logger');
const ConfigService = require('./ConfigService');
const { AppDataSource } = require('../database');
const { ScrapeRecord } = require('../entities');

/**
 * 异常与未识别媒体资产隔离沉降服务 (QuarantineService)
 * 
 * 核心职责：
 * 1. 将 StagingOrganize 自动整理未能识别（TMDB 查无此片 / 缺少集数 / 触发保护）的作品组，
 *    以组为单位安全沉降到 /临时存放/__待人工整理__/${groupTitle}/ 中；
 * 2. 严格保留作品名父目录上下文，严禁将散装文件平铺打散导致同名覆盖；
 * 3. 沉降完成后写入 ScrapeRecord (status: 'quarantined')，供刮削工作台快速挂载。
 */
class QuarantineService {
    static _quarantineDirCache = new Map();

    /**
     * 确保 /临时存放/__待人工整理__/ 根目录存在并返回其 fileId
     * @param {Object} cloud139 - 139 网盘实例
     * @param {string} stagingFolderId - 暂存区根目录 ID
     */
    static async ensureQuarantineRoot(cloud139, stagingFolderId) {
        if (!stagingFolderId) throw new Error('ensureQuarantineRoot: stagingFolderId 不能为空');
        
        const configuredName = ConfigService.getConfigValue('channelMonitor.quarantineFolderName', '__待人工整理__').replace(/^\/+|\/+$/g, '');
        const configuredId = ConfigService.getConfigValue('channelMonitor.quarantineFolderId', '');

        // 优先验证已保存的 quarantineFolderId 是否有效
        if (configuredId) {
            try {
                const list = await cloud139.listDiskDir(configuredId);
                if (list) return configuredId;
            } catch (_) {
                logger.warn(`[隔离沉降] 缓存的隔离目录 ID (${configuredId}) 已失效，重新在暂存区检索或创建...`);
            }
        }

        const cacheKey = `${stagingFolderId}::${configuredName}`;
        if (this._quarantineDirCache.has(cacheKey)) {
            return this._quarantineDirCache.get(cacheKey);
        }

        // 先查重
        let foundId = null;
        if (typeof cloud139.findFolderByName === 'function') {
            foundId = await cloud139.findFolderByName(stagingFolderId, configuredName).catch(() => null);
        }

        if (!foundId) {
            const listRes = await cloud139.listDiskDir(stagingFolderId).catch(() => ({ items: [] }));
            const matched = (listRes.items || []).find(it => it.type === 'folder' && it.name === configuredName);
            if (matched) foundId = matched.fileId || matched.id;
        }

        if (foundId) {
            this._quarantineDirCache.set(cacheKey, foundId);
            ConfigService.setConfigValue('channelMonitor.quarantineFolderId', foundId);
            return foundId;
        }

        // 不存在则创建
        let createdId = null;
        if (typeof cloud139.createFolderHcy === 'function') {
            const res = await cloud139.createFolderHcy(stagingFolderId, configuredName).catch(err => {
                logger.error(`[隔离沉降] 创建隔离目录 "${configuredName}" 失败: ${err.message}`);
                return null;
            });
            createdId = res?.fileId || null;
        }

        if (!createdId) {
            // 回退到老接口
            const res = await cloud139.createFolder(configuredName, stagingFolderId).catch(err => {
                logger.error(`[隔离沉降] createFolder 创建隔离目录失败: ${err.message}`);
                return null;
            });
            createdId = res?.catalogID || res?.fileId || null;
        }

        if (!createdId) {
            throw new Error(`无法在暂存区创建隔离沉降目录 "${configuredName}"`);
        }

        this._quarantineDirCache.set(cacheKey, createdId);
        ConfigService.setConfigValue('channelMonitor.quarantineFolderId', createdId);
        logger.info(`[隔离沉降] 成功初始化暂存区隔离沉降目录: /临时存放/${configuredName} (${createdId})`);
        return createdId;
    }

    /**
     * 将异常/未识别作品组整体原子沉降至隔离区
     * 严格保留父目录剧名层级上下文，杜绝散装同名覆盖
     * @param {Object} clusterGroup - 作品聚类组 (必须包含 files 数组)
     * @param {Object} cloud139 - 139 网盘实例
     * @param {string} stagingFolderId - 暂存区 ID
     * @param {Object} options - { reason: string, accountId: number }
     */
    static async sink(clusterGroup, cloud139, stagingFolderId, options = {}) {
        if (!clusterGroup || !Array.isArray(clusterGroup.files) || clusterGroup.files.length === 0) {
            return { movedCount: 0, status: 'empty' };
        }

        const quarantineRootId = await this.ensureQuarantineRoot(cloud139, stagingFolderId);
        const reason = options.reason || clusterGroup.issueReason || '未能在 TMDB 中精确匹配影视元数据或分季有歧义';

        // 提取最具代表性的作品目录名（保留上下文）
        let targetSubDirName = (clusterGroup.rawTitle || clusterGroup.title || '').trim();
        if (!targetSubDirName) {
            const firstFile = clusterGroup.files[0];
            targetSubDirName = firstFile.parentFolderName || '未识别散装资源';
        }
        targetSubDirName = targetSubDirName.replace(/[\\/:*?"<>|]/g, '_').trim();

        // 查重并防止隔离区内同名覆盖：若已存在同名目录，追加时间戳后 4 位
        let finalDirName = targetSubDirName;
        const rootContent = await cloud139.listDiskDir(quarantineRootId).catch(() => ({ items: [] }));
        const exists = (rootContent.items || []).some(it => it.type === 'folder' && it.name.toLowerCase() === finalDirName.toLowerCase());
        if (exists) {
            const suffix = String(Date.now()).slice(-4);
            finalDirName = `${targetSubDirName}_${suffix}`;
            logger.info(`[隔离沉降] 隔离区已存在子目录 "${targetSubDirName}"，采用防冲突子目录: "${finalDirName}"`);
        }

        // 创建专属子目录
        let subFolderId = null;
        if (typeof cloud139.createFolderHcy === 'function') {
            const res = await cloud139.createFolderHcy(quarantineRootId, finalDirName).catch(err => {
                logger.error(`[隔离沉降] 创建作品子目录 "${finalDirName}" 失败: ${err.message}`);
                return null;
            });
            subFolderId = res?.fileId;
        }
        if (!subFolderId) {
            const res = await cloud139.createFolder(finalDirName, quarantineRootId).catch(err => {
                logger.error(`[隔离沉降] createFolder 创建子目录 "${finalDirName}" 失败: ${err.message}`);
                return null;
            });
            subFolderId = res?.catalogID || res?.fileId;
        }

        if (!subFolderId) {
            throw new Error(`无法在隔离区创建作品专属目录 "${finalDirName}"`);
        }

        // 提取待移动文件 ID 清单
        const fileIds = clusterGroup.files.map(f => f.fileId || f.id).filter(Boolean);
        if (fileIds.length === 0) {
            return { movedCount: 0, status: 'no_files' };
        }

        // 调用 139 批量移动接口
        let moveSuccess = false;
        if (typeof cloud139.batchMoveHcy === 'function') {
            try {
                await cloud139.batchMoveHcy(fileIds, subFolderId);
                moveSuccess = true;
            } catch (moveErr) {
                logger.warn(`[隔离沉降] batchMoveHcy 移动失败: ${moveErr.message}，尝试逐项移动...`);
            }
        }

        if (!moveSuccess && typeof cloud139.moveFiles === 'function') {
            const contentList = fileIds.map(id => ({ contentID: id }));
            await cloud139.moveFiles(contentList, [], subFolderId).catch(err => {
                throw new Error(`移入隔离区失败: ${err.message}`);
            });
            moveSuccess = true;
        }

        const sinkPath = `/临时存放/__待人工整理__/${finalDirName}`;
        logger.info(`[隔离沉降] 成功将作品《${targetSubDirName}》共 ${fileIds.length} 个文件移入隔离区: ${sinkPath}`);

        // 写入 ScrapeRecord (status: 'quarantined')
        try {
            const scrapeRepo = AppDataSource.getRepository(ScrapeRecord);
            for (const file of clusterGroup.files) {
                const rec = scrapeRepo.create({
                    fileRef: String(file.fileId || file.id),
                    oldName: file.name,
                    newName: file.name,
                    oldParentRef: String(file.parentCatalogId || stagingFolderId),
                    oldParentPath: file.folderPath || file.relativePath || '',
                    newParentRef: String(subFolderId),
                    newRef: String(file.fileId || file.id),
                    status: 'quarantined',
                    reason: `已自动沉降至隔离区待人工治理: ${reason}`,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                await scrapeRepo.save(rec);
            }
        } catch (dbErr) {
            logger.warn(`[隔离沉降] 写入 ScrapeRecord 隔离记录异常 (不影响文件移动): ${dbErr.message}`);
        }

        return {
            quarantineFolderId: subFolderId,
            quarantinePath: sinkPath,
            movedCount: fileIds.length,
            status: 'quarantined'
        };
    }
}

module.exports = { QuarantineService };

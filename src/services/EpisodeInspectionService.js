const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const logger = require('../utils/logger');
const { logTaskEvent } = require('../utils/logUtils');
const { RecognitionEngine } = require('./RecognitionEngine');
const { TmdbOrganizeService } = require('./TmdbOrganizeService');
const { TMDBService } = require('./tmdb');

const resolveDataFile = (filename) => {
    const fromDir = path.resolve(__dirname, '../../data', filename);
    if (fs.existsSync(fromDir)) return fromDir;
    return path.resolve(process.cwd(), 'data', filename);
};

const CACHE_FILE = resolveDataFile('missing_episodes_cache.json');
const TMDB_OVERRIDES_FILE = resolveDataFile('episode_tmdb_overrides.json');

/**
 * 规范化目录路径键（剥除反斜杠、末尾斜杠、季子目录后缀，转小写），作为全局绝对目录唯一索引
 * @param {string} p
 * @returns {string}
 */
function normalizePathKey(p) {
    if (!p || typeof p !== 'string') return '';
    let clean = p.replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();
    clean = clean.replace(/(?:\/(?:season\s*\d+|s\d+|第\s*\d+\s*季|sp))$/i, '');
    return clean;
}

class EpisodeInspectionService {
    static tmdbService = new TMDBService();

    static tmdbOverrides = { byPath: {}, byId: {} };
    static _overridesLoaded = false;
    static _activeScanContext = null;

    static loadTmdbOverrides() {
        try {
            if (fs.existsSync(TMDB_OVERRIDES_FILE)) {
                const raw = fs.readFileSync(TMDB_OVERRIDES_FILE, 'utf-8');
                const parsed = JSON.parse(raw);
                this.tmdbOverrides = {
                    byPath: parsed?.byPath || {},
                    byId: parsed?.byId || {},
                };
            } else {
                this.tmdbOverrides = { byPath: {}, byId: {} };
            }
        } catch (e) {
            logger.warn(`[缺集巡检] 读取 TMDB 手动校准记录失败: ${e.message}`);
            this.tmdbOverrides = { byPath: {}, byId: {} };
        }
        this._overridesLoaded = true;
    }

    static saveTmdbOverride({ folderPath, folderId, tmdbId, title, year } = {}) {
        if (!this._overridesLoaded) this.loadTmdbOverrides();
        if (!tmdbId) return;

        const record = {
            tmdbId: String(tmdbId).trim(),
            title: title || '',
            year: year || '',
            folderPath: folderPath || '',
            folderId: folderId || '',
            updatedAt: Date.now(),
        };

        const normPath = normalizePathKey(folderPath);
        if (normPath) {
            this.tmdbOverrides.byPath[normPath] = record;
        }
        if (folderId && typeof folderId === 'string' && !folderId.startsWith('/')) {
            this.tmdbOverrides.byId[folderId] = record;
        }

        try {
            const dataDir = path.dirname(TMDB_OVERRIDES_FILE);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(TMDB_OVERRIDES_FILE, JSON.stringify(this.tmdbOverrides, null, 2), 'utf-8');
            logger.info(`[缺集巡检] 已成功持久化保存 TMDB 手动校准: 路径="${folderPath}" => TMDB: ${tmdbId} (${title || '无标题'})`);
        } catch (e) {
            logger.warn(`[缺集巡检] 保存 TMDB 校准记录失败: ${e.message}`);
        }
    }

    static getTmdbOverride({ folderPath, folderId } = {}) {
        if (!this._overridesLoaded) this.loadTmdbOverrides();
        if (folderId && this.tmdbOverrides.byId && this.tmdbOverrides.byId[folderId]) {
            return this.tmdbOverrides.byId[folderId];
        }
        const normPath = normalizePathKey(folderPath);
        if (normPath && this.tmdbOverrides.byPath && this.tmdbOverrides.byPath[normPath]) {
            return this.tmdbOverrides.byPath[normPath];
        }
        return null;
    }

    static removeTmdbOverride({ folderPath, folderId } = {}) {
        if (!this._overridesLoaded) this.loadTmdbOverrides();
        let changed = false;
        const normPath = normalizePathKey(folderPath);
        if (normPath && this.tmdbOverrides.byPath && this.tmdbOverrides.byPath[normPath]) {
            delete this.tmdbOverrides.byPath[normPath];
            changed = true;
        }
        if (folderId && this.tmdbOverrides.byId && this.tmdbOverrides.byId[folderId]) {
            delete this.tmdbOverrides.byId[folderId];
            changed = true;
        }
        if (changed) {
            try {
                fs.writeFileSync(TMDB_OVERRIDES_FILE, JSON.stringify(this.tmdbOverrides, null, 2), 'utf-8');
            } catch (_) {}
        }
    }

    static scanJob = {
        status: 'idle', // 'idle' | 'running' | 'completed' | 'error'
        targetPath: '',
        current: 0,
        total: 0,
        percent: 0,
        currentShow: '',
        lastMessage: '',
        startedAt: null,
        finishedAt: null,
        durationMs: 0,
        result: null,
        error: null,
    };

    static loadCache() {
        try {
            this.initEventListener();
            if (!this._overridesLoaded) {
                this.loadTmdbOverrides();
            }
            if (fs.existsSync(CACHE_FILE)) {
                const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed && parsed.result) {
                    if (Array.isArray(parsed.result.items)) {
                        parsed.result.items.forEach(item => {
                            if (item && item.isEnded === undefined) {
                                item.isEnded = Boolean(item.airStatus === '已完结' || item.airStatus === '本季完结');
                            }
                        });
                        if (!parsed.result.shows || !parsed.result.shows.length) {
                            parsed.result.shows = this.buildShowGroups(parsed.result.items);
                        }
                    }
                    this.scanJob.result = parsed.result;
                    this.scanJob.targetPath = parsed.targetPath || '';
                    this.scanJob.finishedAt = parsed.finishedAt || null;
                    this.scanJob.durationMs = parsed.durationMs || 0;
                    if (this.scanJob.status === 'idle') {
                        this.scanJob.status = 'completed';
                        this.scanJob.percent = 100;
                        const dateStr = parsed.finishedAt ? new Date(parsed.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '';
                        this.scanJob.lastMessage = `已载入历史巡检结果 (${dateStr})`;
                    }
                }
            }
        } catch (e) {
            logger.warn(`[缺集巡检] 读取缓存历史失败: ${e.message}`);
        }
    }

    static saveCache(result, targetPath = '', durationMs = 0) {
        try {
            const dataDir = path.dirname(CACHE_FILE);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const payload = {
                targetPath,
                finishedAt: Date.now(),
                durationMs,
                result,
            };
            fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
        } catch (e) {
            logger.warn(`[缺集巡检] 保存巡检缓存失败: ${e.message}`);
        }
    }

    static clearScanResults() {
        this.scanJob = {
            status: 'idle',
            targetPath: '',
            current: 0,
            total: 0,
            percent: 0,
            currentShow: '',
            lastMessage: '',
            startedAt: null,
            finishedAt: null,
            durationMs: 0,
            result: null,
            error: null,
        };
        try {
            if (fs.existsSync(CACHE_FILE)) {
                fs.unlinkSync(CACHE_FILE);
            }
            logger.info('[缺集巡检] 已成功清空全部缺集巡检结果与缓存文件');
        } catch (e) {
            logger.warn(`[缺集巡检] 清除缓存文件失败: ${e.message}`);
        }
        return { success: true };
    }

    /**
     * 从当前巡检结果中移除指定的单部剧集并更新持久化缓存
     * @param {object} params - { showKey, folderPath, tmdbId }
     * @returns {object}
     */
    static removeShow({ showKey = '', folderPath = '', tmdbId = '' } = {}) {
        if (!this.scanJob.result) {
            this.loadCache();
        }
        if (!this.scanJob.result) {
            return { success: false, message: '当前没有巡检结果' };
        }

        const normTarget = normalizePathKey(folderPath);
        const targetShowKey = showKey || (normTarget ? `dir:${normTarget}` : '');

        // 0. 若后台有扫描流水线正在进行，同步过滤流水线中的条目
        if (this._activeScanContext && Array.isArray(this._activeScanContext.allItems)) {
            this._activeScanContext.allItems = this._activeScanContext.allItems.filter(item => {
                const itemNorm = normalizePathKey(item.folderPath);
                if (normTarget && (itemNorm === normTarget || itemNorm.startsWith(normTarget + '/'))) return false;
                if (showKey && item.showKey === showKey) return false;
                if (targetShowKey && item.showKey === targetShowKey) return false;
                if (!normTarget && tmdbId && String(item.tmdbId) === String(tmdbId)) return false;
                return true;
            });
        }

        // 1. 从 items 中过滤掉该剧的所有季
        if (Array.isArray(this.scanJob.result.items)) {
            this.scanJob.result.items = this.scanJob.result.items.filter(item => {
                const itemNorm = normalizePathKey(item.folderPath);
                if (normTarget && (itemNorm === normTarget || itemNorm.startsWith(normTarget + '/'))) return false;
                if (showKey && item.showKey === showKey) return false;
                if (targetShowKey && item.showKey === targetShowKey) return false;
                if (!normTarget && tmdbId && String(item.tmdbId) === String(tmdbId)) return false;
                return true;
            });
        }

        // 2. 从 shows 中过滤掉该剧
        if (Array.isArray(this.scanJob.result.shows)) {
            this.scanJob.result.shows = this.scanJob.result.shows.filter(show => {
                const showNorm = normalizePathKey(show.folderPath);
                if (normTarget && (showNorm === normTarget || showNorm.startsWith(normTarget + '/'))) return false;
                if (showKey && show.showKey === showKey) return false;
                if (targetShowKey && show.showKey === targetShowKey) return false;
                if (!normTarget && tmdbId && String(show.tmdbId) === String(tmdbId)) return false;
                return true;
            });
        } else {
            this.scanJob.result.shows = this.buildShowGroups(this.scanJob.result.items || []);
        }

        // 3. 重新计算统计数值
        const unidentifiedShows = this.scanJob.result.shows.filter(s => s.isUnidentified || !s.tmdbId);
        const identifiedShows = this.scanJob.result.shows.filter(s => !s.isUnidentified && s.tmdbId);
        const missingShows = identifiedShows.filter(s => s.hasMissing || s.totalMissingCount > 0);
        const completeShows = identifiedShows.filter(s => !s.hasMissing && s.totalMissingCount === 0);
        this.scanJob.result.scannedShowsCount = this.scanJob.result.shows.length;
        this.scanJob.result.unidentifiedShowsCount = unidentifiedShows.length;
        this.scanJob.result.missingShowsCount = missingShows.length;
        this.scanJob.result.completeShowsCount = completeShows.length;
        this.scanJob.result.totalMissingCount = identifiedShows.reduce((acc, s) => acc + s.totalMissingCount, 0);

        // 4. 保存持久化缓存
        this.saveCache(this.scanJob.result, this.scanJob.targetPath, this.scanJob.durationMs);
        // 5. 同步修剪 SQLite 历史作业中的快照数据，防止刷新页面后死灰复燃
        this.pruneHistoricalJobsForShow({ showKey, folderPath, tmdbId }).catch(() => {});
        logger.info(`[缺集巡检] 已成功从当前巡检清单中移除剧集: showKey="${showKey}", folderPath="${folderPath}"`);

        return {
            success: true,
            message: '已成功移除该剧集',
            result: this.scanJob.result
        };
    }

    /**
     * 同步修剪数据库 maintenance_jobs 中所有 missing_scan 类型的历史作业快照
     */
    static async pruneHistoricalJobsForShow({ showKey = '', folderPath = '', tmdbId = '' } = {}) {
        try {
            const { getMaintenanceJobRepository } = require('../database');
            const repo = getMaintenanceJobRepository();
            if (!repo) return;
            const normTarget = normalizePathKey(folderPath);
            const targetShowKey = showKey || (normTarget ? `dir:${normTarget}` : '');

            const jobs = await repo.find({ where: { type: 'missing_scan' } });
            for (const job of jobs) {
                if (!job.findingsJson) continue;
                let findings;
                try {
                    findings = JSON.parse(job.findingsJson);
                } catch (_) {
                    continue;
                }
                if (!findings) continue;

                let modified = false;
                if (Array.isArray(findings.shows)) {
                    const prevLen = findings.shows.length;
                    findings.shows = findings.shows.filter(show => {
                        const showNorm = normalizePathKey(show.folderPath);
                        if (normTarget && (showNorm === normTarget || showNorm.startsWith(normTarget + '/'))) return false;
                        if (showKey && show.showKey === showKey) return false;
                        if (targetShowKey && show.showKey === targetShowKey) return false;
                        if (!normTarget && tmdbId && String(show.tmdbId) === String(tmdbId)) return false;
                        return true;
                    });
                    if (findings.shows.length !== prevLen) {
                        modified = true;
                    }
                }

                if (Array.isArray(findings.items)) {
                    const prevLen = findings.items.length;
                    findings.items = findings.items.filter(item => {
                        const itemNorm = normalizePathKey(item.folderPath);
                        if (normTarget && (itemNorm === normTarget || itemNorm.startsWith(normTarget + '/'))) return false;
                        if (showKey && item.showKey === showKey) return false;
                        if (targetShowKey && item.showKey === targetShowKey) return false;
                        if (!normTarget && tmdbId && String(item.tmdbId) === String(tmdbId)) return false;
                        return true;
                    });
                    if (findings.items.length !== prevLen) {
                        modified = true;
                    }
                }

                if (modified) {
                    const unidentifiedShows = (findings.shows || []).filter(s => s.isUnidentified || !s.tmdbId);
                    const identifiedShows = (findings.shows || []).filter(s => !s.isUnidentified && s.tmdbId);
                    const missingShows = identifiedShows.filter(s => s.hasMissing || s.totalMissingCount > 0);
                    const completeShows = identifiedShows.filter(s => !s.hasMissing && s.totalMissingCount === 0);

                    findings.scannedShowsCount = (findings.shows || []).length;
                    findings.unidentifiedShowsCount = unidentifiedShows.length;
                    findings.missingShowsCount = missingShows.length;
                    findings.completeShowsCount = completeShows.length;
                    findings.totalMissingCount = identifiedShows.reduce((acc, s) => acc + (s.totalMissingCount || 0), 0);

                    job.findingsJson = JSON.stringify(findings);
                    job.scannedFolders = findings.scannedShowsCount;
                    job.bannedCount = findings.missingShowsCount;
                    job.cleanedCount = findings.totalMissingCount;
                    job.freedFormatted = `${findings.totalMissingCount} 集`;
                    job.summary = `分析 ${findings.scannedShowsCount} 部剧集 · 缺更 ${findings.missingShowsCount} 部 · 未识别 ${findings.unidentifiedShowsCount} 部 (累计缺 ${findings.totalMissingCount} 集)`;
                    await repo.save(job);
                    logger.info(`[缺集巡检] 同步修剪历史作业 #${job.id} 剔除已删除/移除剧集: ${folderPath || showKey}`);
                }
            }
        } catch (e) {
            logger.warn(`[缺集巡检] 同步修剪历史作业快照失败: ${e.message}`);
        }
    }

    /**
     * 查找剧集目录下与指定季号匹配的子目录
     * @param {object} cloud139
     * @param {string} seriesFolderId
     * @param {number} seasonNumber
     * @returns {Promise<{ id: string, name: string } | null>}
     */
    static async findSeasonCatalog(cloud139, seriesFolderId, seasonNumber) {
        try {
            const items = await cloud139.listDiskDirAll(seriesFolderId);
            for (const item of items) {
                if (item.type === 'folder' || item.isFolder || item.fileType === 1) {
                    const sNum = RecognitionEngine.parseSeasonFromFolderName(item.name);
                    if (sNum !== null && Number(sNum) === Number(seasonNumber)) {
                        return {
                            id: item.fileId || item.id,
                            name: item.name
                        };
                    }
                }
            }
        } catch (err) {
            logger.warn(`[缺集巡检] 查找第 ${seasonNumber} 季目录失败: ${err.message}`);
        }
        return null;
    }

    /**
     * 批量或单项删除缺集文件夹/删除缺集季（安全移入 139 回收站）
     * @param {object} cloud139
     * @param {Array<object>} targets - [{ folderPath, folderId, season, deleteEntireShow, showKey, tmdbId, title }]
     * @returns {Promise<{ success: boolean, deletedCount: number, failedCount: number, message: string, result: object }>}
     */
    static async deleteMissingTargets(cloud139, targets = []) {
        if (!Array.isArray(targets) || targets.length === 0) {
            return { success: false, deletedCount: 0, failedCount: 0, message: '未指定要删除的缺集目标', result: this.scanJob.result };
        }

        let deletedCount = 0;
        let failedCount = 0;

        for (const target of targets) {
            try {
                const {
                    folderPath,
                    season,
                    deleteEntireShow = false,
                    showKey = '',
                    tmdbId = '',
                    title = ''
                } = target;

                let folderId = target.folderId;
                if (!folderId && folderPath) {
                    folderId = await this.resolvePathToCatalogId(cloud139, folderPath);
                }

                if (!folderId) {
                    logger.warn(`[缺集清理] 无法定位网盘目录 ID: ${folderPath}`);
                    failedCount++;
                    continue;
                }

                // 模式 1: 删除整剧文件夹 (整部剧直接移入回收站)
                if (deleteEntireShow || season === undefined || season === null) {
                    const ok = await cloud139.deleteFiles([folderId]);
                    if (ok) {
                        deletedCount++;
                        await logTaskEvent(`[缺集清理] 🗑️ 已将剧集《${title || path.basename(folderPath)}》文件夹移入 139 回收站 [${folderPath}]`);
                        this.removeShow({ showKey, folderPath, tmdbId });
                    } else {
                        failedCount++;
                        logger.error(`[缺集清理] 剧集文件夹移入回收站失败: ${folderPath}`);
                    }
                    continue;
                }

                // 模式 2: 仅删除指定缺集季 (子目录或分集文件)
                const seasonNumber = Number(season);
                const seasonCatalog = await this.findSeasonCatalog(cloud139, folderId, seasonNumber);

                if (seasonCatalog && seasonCatalog.id) {
                    const ok = await cloud139.deleteFiles([seasonCatalog.id]);
                    if (ok) {
                        deletedCount++;
                        await logTaskEvent(`[缺集清理] 🗑️ 已将剧集《${title || path.basename(folderPath)}》${seasonCatalog.name} 目录移入 139 回收站`);
                    } else {
                        failedCount++;
                    }
                } else {
                    // 没有独立季目录，为平铺文件，查找属于该季的文件并删除
                    const subFiles = await cloud139.listDiskDirAll(folderId);
                    const seasonFileIds = [];
                    for (const f of subFiles) {
                        if (f.type !== 'folder' && !f.isFolder && f.fileType !== 1) {
                            const se = RecognitionEngine.parseSeasonEpisode(f.name, 1);
                            if (Number(se.season) === seasonNumber) {
                                seasonFileIds.push(f.fileId || f.id);
                            }
                        }
                    }
                    if (seasonFileIds.length > 0) {
                        const ok = await cloud139.deleteFiles(seasonFileIds);
                        if (ok) {
                            deletedCount++;
                            await logTaskEvent(`[缺集清理] 🗑️ 已将剧集《${title || path.basename(folderPath)}》第 ${seasonNumber} 季 (${seasonFileIds.length} 个文件) 移入 139 回收站`);
                        } else {
                            failedCount++;
                        }
                    } else {
                        logger.warn(`[缺集清理] 未在 ${folderPath} 下找到第 ${seasonNumber} 季相关文件`);
                    }
                }

                // 内存与持久化缓存更新：移除该季
                if (this.scanJob.result && Array.isArray(this.scanJob.result.items)) {
                    this.scanJob.result.items = this.scanJob.result.items.filter(item => {
                        const sameFolder = (item.folderPath === folderPath || item.folderId === folderId);
                        const sameSeason = Number(item.season) === seasonNumber;
                        return !(sameFolder && sameSeason);
                    });

                    // 检查此剧是否还有其他季
                    const remainingForShow = this.scanJob.result.items.filter(
                        item => (item.folderPath === folderPath || item.folderId === folderId)
                    );

                    if (remainingForShow.length === 0) {
                        // 尝试检查原目录是否已空，若已空也移入回收站
                        try {
                            const remainingDirItems = await cloud139.listDiskDirAll(folderId);
                            if (!remainingDirItems || remainingDirItems.length === 0) {
                                await cloud139.deleteFiles([folderId]);
                                logger.info(`[缺集清理] 剧集目录 ${folderPath} 已变为空目录，已同步移入回收站`);
                            }
                        } catch (_) {}
                        this.removeShow({ showKey, folderPath, tmdbId });
                    } else {
                        this.scanJob.result.shows = this.buildShowGroups(this.scanJob.result.items);
                        const missingShows = this.scanJob.result.shows.filter(s => s.hasMissing || s.totalMissingCount > 0);
                        const completeShows = this.scanJob.result.shows.filter(s => !s.hasMissing && s.totalMissingCount === 0);
                        this.scanJob.result.scannedShowsCount = this.scanJob.result.shows.length;
                        this.scanJob.result.missingShowsCount = missingShows.length;
                        this.scanJob.result.completeShowsCount = completeShows.length;
                        this.scanJob.result.totalMissingCount = this.scanJob.result.shows.reduce((acc, s) => acc + s.totalMissingCount, 0);
                        this.saveCache(this.scanJob.result, this.scanJob.targetPath, this.scanJob.durationMs);
                    }
                }
            } catch (err) {
                failedCount++;
                logger.error(`[缺集清理] 执行删除异常 [${target?.folderPath}]: ${err.message}`);
            }
        }

        return {
            success: deletedCount > 0 || failedCount === 0,
            deletedCount,
            failedCount,
            message: `已成功将 ${deletedCount} 项移入 139 网盘回收站${failedCount > 0 ? `，${failedCount} 项失败` : ''}`,
            result: this.scanJob.result
        };
    }

    static getScanStatus() {
        if (!this.scanJob.result && this.scanJob.status === 'idle') {
            this.loadCache();
        }
        return {
            status: this.scanJob.status,
            targetPath: this.scanJob.targetPath,
            current: this.scanJob.current,
            total: this.scanJob.total,
            percent: this.scanJob.percent,
            currentShow: this.scanJob.currentShow,
            lastMessage: this.scanJob.lastMessage,
            startedAt: this.scanJob.startedAt,
            finishedAt: this.scanJob.finishedAt,
            durationMs: this.scanJob.durationMs,
            result: this.scanJob.result,
            error: this.scanJob.error,
        };
    }

    static startAsyncScan(cloud139, options = {}) {
        if (this.scanJob.status === 'running') {
            return {
                alreadyRunning: true,
                ...this.getScanStatus()
            };
        }

        const rootPath = options.rootCatalogId || '/';
        this.scanJob.status = 'running';
        this.scanJob.targetPath = rootPath;
        this.scanJob.current = 0;
        this.scanJob.total = 0;
        this.scanJob.percent = 5;
        this.scanJob.currentShow = '';
        this.scanJob.lastMessage = `正在定界剧集目录: ${rootPath}...`;
        this.scanJob.startedAt = Date.now();
        this.scanJob.finishedAt = null;
        this.scanJob.durationMs = 0;
        this.scanJob.error = null;
        this.scanJob.result = {
            scannedFilesCount: 0,
            scannedShowsCount: 0,
            missingShowsCount: 0,
            completeShowsCount: 0,
            totalMissingCount: 0,
            durationMs: 0,
            items: [],
            shows: [],
            isScanning: true,
        };

        // 异步后台运行，永不超时
        (async () => {
            let maintenanceJob = null;
            try {
                const { MaintenanceJobService } = require('./MaintenanceJobService');
                maintenanceJob = await MaintenanceJobService.createJob({
                    type: 'missing_scan',
                    triggerType: options.triggerType || 'manual',
                    title: 'TMDB 剧集缺更巡检',
                    folderPath: rootPath,
                    summary: `正在巡检剧集目录: ${rootPath}...`,
                });
            } catch (jobErr) {
                logger.warn(`[缺集巡检] 初始化作业审计记录失败: ${jobErr.message}`);
            }

            try {
                const result = await this.inspectDirectory(cloud139, {
                    ...options,
                    onProgress: (prog) => {
                        if (prog.total !== undefined) this.scanJob.total = prog.total;
                        if (prog.current !== undefined) this.scanJob.current = prog.current;
                        if (prog.percent !== undefined) this.scanJob.percent = prog.percent;
                        if (prog.currentShow) this.scanJob.currentShow = prog.currentShow;
                        if (prog.message) this.scanJob.lastMessage = prog.message;
                        if (prog.snapshot) this.scanJob.result = prog.snapshot;
                    }
                });
                this.scanJob.status = 'completed';
                this.scanJob.percent = 100;
                this.scanJob.finishedAt = Date.now();
                this.scanJob.durationMs = this.scanJob.finishedAt - this.scanJob.startedAt;
                this.scanJob.result = { ...result, isScanning: false, jobId: maintenanceJob ? maintenanceJob.id : undefined };
                this.scanJob.lastMessage = `巡检完成，共耗时 ${(this.scanJob.durationMs / 1000).toFixed(1)} 秒`;
                this.saveCache(result, rootPath, this.scanJob.durationMs);

                if (maintenanceJob) {
                    try {
                        const { MaintenanceJobService } = require('./MaintenanceJobService');
                        const missingSeasons = (result.items || []).filter(i => i.missingCount > 0);
                        await MaintenanceJobService.completeJob(maintenanceJob.id, {
                            status: 'completed',
                            summary: `分析 ${result.scannedShowsCount} 部剧集 · 缺更 ${result.missingShowsCount} 部 · 未识别 ${result.unidentifiedShowsCount || 0} 部 (累计缺 ${result.totalMissingCount} 集)`,
                            durationMs: this.scanJob.durationMs,
                            scannedFolders: result.scannedShowsCount,
                            totalFiles: result.scannedFilesCount,
                            bannedCount: result.missingShowsCount,
                            cleanedCount: result.totalMissingCount,
                            freedFormatted: `${result.totalMissingCount} 集`,
                            findings: {
                                shows: result.shows || [],
                                items: result.items || [],
                                unidentifiedShowsCount: result.unidentifiedShowsCount || 0,
                                missingShowsCount: result.missingShowsCount || 0,
                                completeShowsCount: result.completeShowsCount || 0,
                                scannedShowsCount: result.scannedShowsCount || 0,
                                scannedFilesCount: result.scannedFilesCount || 0,
                                totalMissingCount: result.totalMissingCount || 0,
                                durationMs: this.scanJob.durationMs,
                                folderPath: rootPath,
                            },
                        });
                    } catch (mErr) {
                        logger.warn(`[缺集巡检] 结项作业审计记录失败: ${mErr.message}`);
                    }
                }
            } catch (err) {
                logger.error(`[缺集巡检] 异步巡检任务异常: ${err.message}`);
                this.scanJob.status = 'error';
                this.scanJob.error = err.message;
                this.scanJob.lastMessage = `巡检中断: ${err.message}`;
                if (maintenanceJob) {
                    try {
                        const { MaintenanceJobService } = require('./MaintenanceJobService');
                        await MaintenanceJobService.failJob(maintenanceJob.id, err, Date.now() - this.scanJob.startedAt);
                    } catch (_) {}
                }
            }
        })();

        return {
            alreadyRunning: false,
            ...this.getScanStatus()
        };
    }


    /**
     * 将目录绝对路径（如 /剧集/国产剧 或 /tv）逐级解析为 139 网盘 catalogId
     * @param {object} cloud139
     * @param {string} pathOrId
     * @returns {Promise<string|null>}
     */
    static async resolvePathToCatalogId(cloud139, pathOrId) {
        if (!pathOrId || pathOrId === '/' || pathOrId === '-11') {
            return '/';
        }
        const str = String(pathOrId).trim();
        if (!str.startsWith('/')) {
            return str;
        }
        const parts = str.split('/').filter(Boolean);
        if (!parts.length) return '/';

        let currentId = '/';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (typeof cloud139.findFolderByName !== 'function') {
                return currentId;
            }
            let found = await cloud139.findFolderByName(currentId, part);
            // 智能容错：若首层目录未在根目录下直接找到，探查常见媒体主目录 (/media, /媒体库, /目标目录) 下是否存在
            if (!found && i === 0 && currentId === '/') {
                for (const container of ['media', '媒体库', '目标目录']) {
                    const containerId = await cloud139.findFolderByName('/', container);
                    if (containerId) {
                        const candidate = await cloud139.findFolderByName(containerId, part);
                        if (candidate) {
                            logger.info(`[缺集巡检-路径解析] 手动路径 "${str}" 自动校正至现存目录: "/${container}/${part}"`);
                            found = candidate;
                            break;
                        }
                    }
                }
            }
            if (!found) {
                logger.warn(`[缺集巡检-路径解析] 目录路径 "${str}" 中的子层级 "${part}" 未在网盘中找到`);
                return null;
            }
            currentId = found;
        }
        return currentId;
    }

    /**
     * 递归遍历指定网盘目录收集视频文件（并发提速）
     * @param {object} cloud139
     * @param {string} rootCatalogId
     * @returns {Promise<Array<object>>}
     */
    static async scanVideoFiles(cloud139, rootCatalogId = '/') {
        let rootId = rootCatalogId || '/';
        const scanStart = Date.now();
        if (typeof rootId === 'string' && rootId.startsWith('/') && rootId !== '/') {
            const resolved = await this.resolvePathToCatalogId(cloud139, rootId);
            if (!resolved) {
                logger.warn(`[缺集巡检] 指定的剧集目录不存在或未找到: ${rootId}`);
                await logTaskEvent(`[缺集巡检] ⚠️ 目标目录未找到: ${rootId}，请检查路径输入`);
                return [];
            }
            rootId = resolved;
        }
        await logTaskEvent(`[缺集巡检] [1/3 目录扫描] 开始递归扫描云盘视频目录...`);
        const limit = pLimit(5);
        let queue = [{ id: rootId, path: '' }];
        const videoFiles = [];
        let scannedDirs = 0;
        let lastReportedDirs = 0;

        while (queue.length > 0) {
            const batch = queue.splice(0, 10);
            const results = await Promise.all(batch.map(current => limit(async () => {
                scannedDirs++;
                try {
                    let items = [];
                    if (typeof cloud139.listDiskDirAll === 'function') {
                        items = await cloud139.listDiskDirAll(current.id);
                    } else if (typeof cloud139.listDiskDir === 'function') {
                        const dirRes = await cloud139.listDiskDir(current.id);
                        items = dirRes?.items || [];
                        if (!items.length && (dirRes?.catalogList || dirRes?.fileList)) {
                            for (const cat of (dirRes.catalogList || [])) {
                                items.push({ fileId: cat.catalogID, name: cat.catalogName, type: 'folder' });
                            }
                            for (const f of (dirRes.fileList || [])) {
                                items.push({ fileId: f.contentID || f.fileId, name: f.contentName || f.name, type: 'file', size: f.contentSize || f.size });
                            }
                        }
                    }

                    const subFolders = [];
                    const subVideos = [];

                    for (const item of (items || [])) {
                        const subPath = current.path ? `${current.path}/${item.name}` : `/${item.name}`;
                        if (item.type === 'folder' || item.isFolder || item.fileType === 1) {
                            subFolders.push({ id: item.fileId || item.id, path: subPath });
                        } else {
                            const extMatch = (item.name || '').match(/\.([a-zA-Z0-9]{2,10})$/);
                            const ext = extMatch ? extMatch[1].toLowerCase() : '';
                            if (ext && RecognitionEngine.VIDEO_EXTENSIONS && RecognitionEngine.VIDEO_EXTENSIONS.has(ext)) {
                                subVideos.push({
                                    id: String(item.fileId || item.id),
                                    name: item.name,
                                    path: subPath,
                                    parentId: current.id,
                                    parentPath: current.path || '/',
                                    size: parseInt(item.size || '0', 10) || 0,
                                });
                            }
                        }
                    }
                    return { subFolders, subVideos };
                } catch (err) {
                    logger.warn(`[缺集巡检] 遍历目录 ${current.path || '/'} 发生异常: ${err.message}`);
                    return { subFolders: [], subVideos: [] };
                }
            })));

            for (const r of results) {
                if (r.subVideos.length) videoFiles.push(...r.subVideos);
                if (r.subFolders.length) queue.push(...r.subFolders);
            }

            if (scannedDirs - lastReportedDirs >= 40 || queue.length === 0) {
                lastReportedDirs = scannedDirs;
                await logTaskEvent(`[缺集巡检] [1/3 目录扫描] 扫描中: 已遍历 ${scannedDirs} 个目录，捕获 ${videoFiles.length} 个视频文件...`);
            }
        }

        const scanDuration = ((Date.now() - scanStart) / 1000).toFixed(1);
        logger.info(`[缺集巡检] 扫描完成: 遍历 ${scannedDirs} 个目录，共找到 ${videoFiles.length} 个视频文件`);
        await logTaskEvent(`[缺集巡检] [1/3 目录扫描] 目录遍历完成: 共扫描 ${scannedDirs} 个目录，捕获 ${videoFiles.length} 个视频文件，耗时 ${scanDuration} 秒`);
        return videoFiles;
    }

    /**
     * 将视频文件按电视剧与季进行聚类聚合
     * @param {Array<object>} files
     * @returns {Array<object>} groups
     */
    static clusterTvSeasonGroups(files = []) {
        const groupMap = new Map();

        for (const file of files) {
            const fileName = file.name || '';
            const parentPath = file.parentPath || '';
            const pathSegments = parentPath.split('/').filter(Boolean);

            // ① 从自身或路径父目录提取显式 {tmdb-xxx} 指纹
            let tmdbId = RecognitionEngine.extractTmdbIdTag(fileName);
            if (!tmdbId) {
                for (let i = pathSegments.length - 1; i >= 0; i--) {
                    const idFromSeg = RecognitionEngine.extractTmdbIdTag(pathSegments[i]);
                    if (idFromSeg) {
                        tmdbId = idFromSeg;
                        break;
                    }
                }
            }

            // ② 解析季号：优先看父目录名称（如 Season 01, S02），其次看文件名
            let season = 1;
            let foundSeasonInPath = false;
            for (let i = pathSegments.length - 1; i >= 0; i--) {
                const seg = pathSegments[i];
                const sMatch = seg.match(/(?:Season|S)\s*(\d{1,2})/i) || seg.match(/第\s*(\d{1,2})\s*季/);
                if (sMatch) {
                    season = parseInt(sMatch[1], 10);
                    foundSeasonInPath = true;
                    break;
                }
            }

            const parsed = RecognitionEngine.parseMediaFilename(fileName);
            if (!foundSeasonInPath && parsed && parsed.season !== undefined && parsed.season !== null) {
                season = Number(parsed.season);
            }

            // 仅对剧集（含明确季集标识或父目录标为季目录）或含有 tmdbId 的非纯单电影进行缺集聚合
            const isTvHint = foundSeasonInPath || (parsed && (parsed.season || parsed.episode)) || /S\d+/i.test(fileName) || /E\d+/i.test(fileName) || /第\d+集/.test(fileName);
            if (!isTvHint) {
                continue;
            }

            // 确定剧集主标题
            let showTitle = parsed?.title || '';
            // 如果解析出的标题是纯数字（如 "160"、"01"）或纯集数标签（如 "EP01"、"E160"），说明文件名只有集号没有片名，必须回退从父级主目录提取
            const isInvalidTitle = !showTitle || /^\d+$/.test(showTitle.trim()) || /^(?:EP?|S\d+E?)\d+$/i.test(showTitle.trim());
            if (isInvalidTitle) {
                // 自底向上倒序寻找：跳过季目录后，第一个非通用分类目录为真实的剧集主目录
                const reversedSegs = pathSegments.slice().reverse();
                let showFolder = '';
                for (const seg of reversedSegs) {
                    const isSeasonDir = /(?:Season|S)\s*\d+/i.test(seg) || /第\s*\d+\s*季/.test(seg) || /^SP$/i.test(seg);
                    if (isSeasonDir) continue;
                    const isGenericCategory = /^(?:媒体库|媒体|media|strm|公共目录|剧集|电视剧|国剧|国产剧|韩剧|日剧|美剧|英剧|泰剧|动漫|动画|国漫|日漫|纪录片|综艺|电影)$/i.test(seg.trim());
                    if (isGenericCategory) continue;
                    showFolder = seg;
                    break;
                }
                if (!showFolder) {
                    showFolder = reversedSegs.find(s => !/(?:Season|S)\s*\d+/i.test(s) && !/第\s*\d+\s*季/.test(s)) || pathSegments[0] || '未知剧集';
                }
                showTitle = showFolder.replace(/\{tmdb-\d+\}/ig, '').replace(/\s*[\(\[（【]\s*(?:19\d{2}|20\d{2})\s*[\)\]）】]/g, '').trim();
            }

            const groupKey = tmdbId ? `tmdb:${tmdbId}:S${season}` : `title:${RecognitionEngine.normalizeTitleKey(showTitle)}:S${season}`;

            if (!groupMap.has(groupKey)) {
                groupMap.set(groupKey, {
                    groupKey,
                    title: showTitle,
                    tmdbId: tmdbId ? String(tmdbId) : null,
                    mediaType: 'tv',
                    season: season,
                    targetSeason: season,
                    folderPath: parentPath,
                    files: [],
                    seasons: [],
                    seasonEpisodesMap: {},
                });
            }

            groupMap.get(groupKey).files.push({
                ...file,
                _folderSeason: season,
            });
        }

        const groups = Array.from(groupMap.values());
        const withTmdbCount = groups.filter(g => g.tmdbId).length;
        logTaskEvent(`[缺集巡检] [2/3 剧集聚类] 聚类归纳完毕: 归类为 ${groups.length} 个剧集季组 (其中 ${withTmdbCount} 组带有 TMDB 指纹)`).catch(() => {});
        return groups;
    }

    /**
     * 针对所有剧集季组并行/串行比对 TMDB 官方季集数据
     * @param {Array<object>} groups
     * @param {object} options - { excludeUnreleased, ignoreSeasonZero }
     * @returns {Promise<Array<object>>}
     */
    static async inspectGroupsWithTmdb(groups = [], options = {}) {
        const tmdbStart = Date.now();
        const tmdbGroups = groups.filter(g => g.tmdbId && this.tmdbService.credential);
        if (!options.silent) {
            await logTaskEvent(`[缺集巡检] [3/3 TMDB比对] 开始联动 TMDB 官方季播数据比对 (共 ${tmdbGroups.length} 组待核验)...`);
        }

        const nowStr = new Date().toISOString().slice(0, 10);
        const tmdbLimit = pLimit(8);
        let processedTmdb = 0;

        const analyzed = await Promise.all(groups.map(group => tmdbLimit(async () => {
            try {
                // 忽略第 0 季特别篇
                if (options.ignoreSeasonZero !== false && Number(group.season) === 0) {
                    return null;
                }

                let airStatus = null;
                let firstAirYear = null;

                // 如果已提取到 TMDB ID，且配置了 TMDB API Key，则拉取 TMDB 官方季与集数据（双接口并发）
                if (group.tmdbId && this.tmdbService.credential) {
                    try {
                        const [seasonDetails, tvDetails] = await Promise.all([
                            this.tmdbService.getSeasonDetails(group.tmdbId, group.season).catch(() => []),
                            this.tmdbService.getTVDetails(group.tmdbId).catch(() => null)
                        ]);

                        if (Array.isArray(seasonDetails) && seasonDetails.length > 0) {
                            if (!group.seasonEpisodesMap) group.seasonEpisodesMap = {};
                            group.seasonEpisodesMap[group.season] = seasonDetails;
                        }

                        let isEnded = false;
                        if (tvDetails) {
                            group.title = tvDetails.title || group.title;
                            group.posterPath = tvDetails.posterPath || null;
                            if (tvDetails.firstAirDate) {
                                firstAirYear = String(tvDetails.firstAirDate).slice(0, 4);
                            }
                            group.seasons = Array.from({ length: tvDetails.totalSeasons || 1 }, (_, i) => ({
                                season_number: i + 1,
                                episode_count: i + 1 === group.season ? (seasonDetails?.length || 0) : 0,
                            }));

                            // ── 科学完结判定模型 (深度兼顾单季剧、多季长篇与常青综艺) ──
                            const isShowEnded = (tvDetails.status === 'Ended' || tvDetails.status === 'Canceled');
                            const currentSeasonNum = Number(group.season);
                            const totalSeasons = Number(tvDetails.totalSeasons || 1);

                            // 检查整剧开播日期：若首播日期晚于今天，整剧未播，绝非完结
                            const firstAir = tvDetails.first_air_date || tvDetails.firstAirDate;
                            const isFuturePremiere = firstAir && String(firstAir).slice(0, 10) > nowStr;

                            if (isShowEnded) {
                                isEnded = true;
                                airStatus = '已完结';
                            } else if (isFuturePremiere) {
                                isEnded = false;
                                airStatus = '未开播';
                            } else {
                                // ② 多季长篇剧集与常青综艺节目（TMDB整剧常年保持 Returning Series）
                                if (currentSeasonNum < totalSeasons) {
                                    isEnded = true;
                                    airStatus = '本季完结';
                                } else {
                                    // 最新季或综艺季：检查本季所有分集是否已全部播毕
                                    const seasonEps = Array.isArray(seasonDetails) ? seasonDetails : [];
                                    if (seasonEps.length > 0) {
                                        const airedEpisodes = seasonEps.filter(ep => ep.air_date && String(ep.air_date).slice(0, 10) <= nowStr);
                                        const hasFutureEpisodes = seasonEps.some(ep => ep.air_date && String(ep.air_date).slice(0, 10) > nowStr);
                                        const nextAir = tvDetails.nextEpisodeToAir;
                                        const nextInThisSeason = nextAir && Number(nextAir.season_number) === currentSeasonNum;

                                        // 严谨判定：必须至少有已播分集，且无未来排期集、无下一集待播，才认定当季完结
                                        if (airedEpisodes.length > 0 && !hasFutureEpisodes && !nextInThisSeason) {
                                            isEnded = true;
                                            airStatus = '本季完结';
                                        } else {
                                            isEnded = false;
                                            airStatus = airedEpisodes.length === 0 ? '待播/未定档' : '连载中';
                                        }
                                    } else {
                                        isEnded = false;
                                        airStatus = '连载中';
                                    }
                                }
                            }
                        }

                        group._isEnded = isEnded;
                        group._airStatus = airStatus;
                    } catch (err) {
                        logger.warn(`[缺集巡检] TMDB 拉取剧集数据失败 [${group.title}] (ID: ${group.tmdbId}): ${err.message}`);
                    }
                    processedTmdb++;
                    if (!options.silent && (processedTmdb % 5 === 0 || processedTmdb === tmdbGroups.length)) {
                        await logTaskEvent(`[缺集巡检] [3/3 TMDB比对] 正在核验官方分集 (${processedTmdb}/${tmdbGroups.length}): 当前处理《${group.title}》...`);
                    }
                }

                // 规则过滤：若开启「只检查完结剧」，非完结季直接跳过
                if (options.onlyEnded && !group._isEnded) {
                    return null;
                }

                // 核心算法：100% 复用 TmdbOrganizeService / 139助手油猴脚本的缺集计算
                const analysis = TmdbOrganizeService.analyzeMissingEpisodes(group, group.season);

                // 提取本地已收录的具体集号列表
                const localEpSet = new Set();
                (group.files || []).forEach(vf => {
                    let ep = null;
                    if (vf._lockedEpisode) {
                        const m = String(vf._lockedEpisode).match(/S(\d+)E(\d+)/i) || String(vf._lockedEpisode).match(/E(\d+)/i);
                        if (m) {
                            ep = m.length === 3 ? Number(m[2]) : Number(m[1]);
                        }
                    }
                    if (ep === null) {
                        const se = RecognitionEngine.parseSeasonEpisode(vf.name, group.season);
                        if ((se.season === undefined || se.season === null || Number(se.season) === Number(group.season)) && se.episode) {
                            ep = Number(se.episode);
                        }
                    }
                    if (ep !== null && !isNaN(ep) && ep > 0) {
                        localEpSet.add(ep);
                    }
                });
                const localEpisodes = Array.from(localEpSet).sort((a, b) => a - b);

                const seasonEpsList = (group.seasonEpisodesMap && Array.isArray(group.seasonEpisodesMap[group.season]))
                    ? group.seasonEpisodesMap[group.season]
                    : [];
                const hasAnyAirDate = seasonEpsList.some(ep => Boolean(ep.air_date));

                // 根据选项排除未播出的剧集
                let missingEpisodes = analysis.missingEpisodes || [];
                if (options.excludeUnreleased !== false) {
                    missingEpisodes = missingEpisodes.filter(ep => {
                        if (!ep.airDate) {
                            // 无明确首播日期的分集一律视为未定档占位，绝不计算为缺更
                            return false;
                        }
                        return String(ep.airDate).slice(0, 10) <= nowStr;
                    });
                }

                const missingCount = missingEpisodes.length;
                const missingEpNumbers = missingEpisodes.map(m => m.episode);
                const missingRangesStr = TmdbOrganizeService.formatEpisodeRanges(missingEpNumbers, 'E');

                let shortRangesStr = missingRangesStr;
                if (missingRangesStr.length > 18) {
                    const parts = missingRangesStr.split(', ');
                    if (parts.length > 2) {
                        shortRangesStr = `${parts.slice(0, 2).join(', ')} 等`;
                    }
                }

                const detailedList = missingEpisodes.map(ep => {
                    let line = `• ${ep.tag}`;
                    if (ep.name) line += `: ${ep.name}`;
                    if (ep.airDate) line += ` (${ep.airDate})`;
                    return line;
                });

                let maxOfficialAired = 0;
                if (seasonEpsList.length > 0) {
                    const airedList = options.excludeUnreleased !== false
                        ? seasonEpsList.filter(ep => {
                            if (!ep.air_date) return !hasAnyAirDate;
                            return String(ep.air_date).slice(0, 10) <= nowStr;
                        })
                        : seasonEpsList;
                    maxOfficialAired = airedList.length ? Math.max(...airedList.map(e => Number(e.episode_number) || 0)) : 0;
                }

                const rawTmdbTotal = Number(analysis.tmdbCount || 0);
                const effectiveTmdbTotal = (options.excludeUnreleased !== false && maxOfficialAired > 0)
                    ? maxOfficialAired
                    : rawTmdbTotal;
                const maxLocal = localEpisodes.length ? Math.max(...localEpisodes) : 0;
                const maxMissing = missingEpNumbers.length ? Math.max(...missingEpNumbers) : 0;
                const totalEpisodes = Math.max(effectiveTmdbTotal, maxLocal, maxMissing);

                const formatBytes = (bytes) => {
                    if (!bytes) return '0 B';
                    const n = Number(bytes);
                    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
                    return (n / 1024).toFixed(0) + ' KB';
                };

                const localFiles = (group.files || []).map(vf => {
                    let ep = null;
                    if (vf._lockedEpisode) {
                        const m = String(vf._lockedEpisode).match(/S(\d+)E(\d+)/i) || String(vf._lockedEpisode).match(/E(\d+)/i);
                        if (m) ep = m.length === 3 ? Number(m[2]) : Number(m[1]);
                    }
                    if (ep === null) {
                        const se = RecognitionEngine.parseSeasonEpisode(vf.name, group.season);
                        if ((se.season === undefined || se.season === null || Number(se.season) === Number(group.season)) && se.episode) {
                            ep = Number(se.episode);
                        }
                    }
                    const rawSize = parseInt(vf.size || vf.contentSize || '0', 10) || 0;
                    return {
                        fileId: String(vf.id || vf.fileId || vf.contentID || ''),
                        name: vf.name || vf.contentName || '',
                        size: rawSize,
                        sizeFormatted: formatBytes(rawSize),
                        parsedEpisode: ep,
                        matchStatus: ep !== null ? 'matched' : 'unrecognized',
                        path: vf.path || (vf.parentPath ? `${vf.parentPath}/${vf.name}` : vf.name)
                    };
                }).sort((a, b) => (a.parsedEpisode || 9999) - (b.parsedEpisode || 9999) || a.name.localeCompare(b.name));

                const status = missingCount > 0
                    ? 'missing'
                    : (analysis.isMatch && effectiveTmdbTotal > 0 ? 'complete' : (analysis.isExtra ? 'extra' : 'unknown'));

                return {
                    groupKey: group.groupKey,
                    title: group.title,
                    tmdbId: group.tmdbId,
                    season: group.season,
                    seasonLabel: analysis.seasonLabel || `第 ${group.season} 季`,
                    folderPath: group.folderPath,
                    posterPath: group.posterPath || null,
                    airStatus,
                    isEnded: Boolean(group._isEnded || airStatus === '已完结' || airStatus === '本季完结'),
                    firstAirYear,
                    localCount: analysis.localCount,
                    coveredCount: analysis.coveredCount,
                    tmdbCount: effectiveTmdbTotal,
                    totalEpisodes,
                    localEpisodes,
                    localFiles,
                    missingCount,
                    missingEpisodes,
                    missingRangesStr,
                    shortRangesStr,
                    detailedList,
                    tooltipTitle: analysis.tooltipTitle || '',
                    status,
                    isMatch: analysis.isMatch,
                    isExtra: analysis.isExtra,
                };
            } catch (e) {
                logger.error(`[缺集巡检] 剧集季组分析异常 [${group.title}]: ${e.message}`);
                return null;
            }
        })));

        const results = analyzed.filter(Boolean);

        // 排序：有缺集的排在最前（按缺集数降序），随后按剧集标题排序
        results.sort((a, b) => {
            if (a.missingCount !== b.missingCount) {
                return b.missingCount - a.missingCount;
            }
            return (a.title || '').localeCompare(b.title || '');
        });

        const tmdbDuration = ((Date.now() - tmdbStart) / 1000).toFixed(1);
        if (!options.silent) {
            await logTaskEvent(`[缺集巡检] [3/3 TMDB比对] TMDB 官方分集比对核验完成，耗时 ${tmdbDuration} 秒`);
        }

        return results;
    }

    /**
     * 智能定界：探查网盘目录结构，精准识别所有独立的剧集主目录（忽略季子目录/花絮）
     * 采用迭代式广度优先队列 (BFS)，根治并发递归嵌套导致的 Promise 死锁 (pLimit Deadlock)。
     * @param {object} cloud139
     * @param {string} rootPathOrId
     * @param {Function} [onProgress]
     * @returns {Promise<Array<{ fileId: string, name: string, category: string, path: string }>>}
     */
    static async discoverSeriesDirectories(cloud139, rootPathOrId = '/', onProgress = null) {
        let rootId = rootPathOrId || '/';
        let rootPath = typeof rootPathOrId === 'string' && rootPathOrId.startsWith('/') ? rootPathOrId : '';

        if (typeof rootId === 'string' && rootId.startsWith('/') && rootId !== '/') {
            const resolved = await this.resolvePathToCatalogId(cloud139, rootId);
            if (!resolved) {
                logger.warn(`[缺集巡检] 目标目录未找到: ${rootId}`);
                await logTaskEvent(`[缺集巡检] ⚠️ 目标目录未找到: ${rootId}，请检查路径输入`);
                return [];
            }
            rootId = resolved;
        }

        const limit = pLimit(8);
        const discovered = [];
        const queue = [{ id: rootId, path: rootPath, category: '', depth: 0 }];
        let exploredCount = 0;

        while (queue.length > 0) {
            const batch = queue.splice(0, 10);
            await Promise.all(batch.map(current => limit(async () => {
                exploredCount++;
                if (typeof onProgress === 'function' && exploredCount % 15 === 0) {
                    onProgress({
                        percent: Math.min(8, Math.round((exploredCount / 40) * 8)),
                        message: `正在穿透定界目录结构 (已探查 ${exploredCount} 个目录，已发现 ${discovered.length} 部剧)...`
                    });
                }
                if (current.depth > 6) return;
                let items = [];
                try {
                    items = await cloud139.listDiskDirAll(current.id);
                } catch (err) {
                    logger.warn(`[缺集巡检] 读取目录 ${current.path || current.id} 失败: ${err.message}`);
                    return;
                }

                const subFolders = items.filter(i => i.type === 'folder' || i.isFolder || i.fileType === 1);
                const subVideos = items.filter(i => {
                    const extMatch = (i.name || '').match(/\.([a-zA-Z0-9]{2,10})$/);
                    return extMatch && RecognitionEngine.VIDEO_EXTENSIONS && RecognitionEngine.VIDEO_EXTENSIONS.has(extMatch[1].toLowerCase());
                });

                // 判定当前目录是否本身就是剧集主目录：
                // 1. 包含 Season 01/S01/特别篇 等季子目录
                // 2. 或者自身直接包含视频文件
                const hasSeasonSubfolders = subFolders.some(f => /^Season\s*\d+/i.test(f.name) || /^S\d+/i.test(f.name) || /^第.+季/i.test(f.name) || /^SP$/i.test(f.name));
                const isSeries = hasSeasonSubfolders || subVideos.length > 0;

                if (isSeries && current.depth > 0) {
                    discovered.push({
                        fileId: current.id,
                        name: current.path ? current.path.split('/').filter(Boolean).pop() : '当前剧集',
                        path: current.path || '/',
                        category: current.category || ''
                    });
                    return;
                }

                if (current.depth === 0 && isSeries) {
                    // 根目录本身就是一部剧
                    discovered.push({
                        fileId: current.id,
                        name: (rootPath ? rootPath.split('/').filter(Boolean).pop() : '') || '当前剧集',
                        path: rootPath || '/',
                        category: ''
                    });
                    return;
                }

                // 否则是容器/分类目录，向下继续穿透
                for (const child of subFolders) {
                    const childId = child.fileId || child.id || child.catalogID;
                    const childName = child.name || child.catalogName;
                    const childPath = current.path ? `${current.path}/${childName}` : `/${childName}`;
                    const nextCat = current.category || (current.depth === 0 ? childName : '');
                    queue.push({
                        id: childId,
                        path: childPath,
                        category: nextCat,
                        depth: current.depth + 1
                    });
                }
            })));
        }

        // 排序：按分类、片名自然排序
        discovered.sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
        return discovered;
    }

    /**
     * 单剧全量穿透：收集指定剧集目录下的全部视频文件（100% 覆盖）
     * @param {object} cloud139
     * @param {string} seriesFolderId
     * @param {string} seriesPath
     * @returns {Promise<Array<object>>}
     */
    static async scanSeriesVideoFiles(cloud139, seriesFolderId, seriesPath = '') {
        const queue = [{ id: seriesFolderId, path: seriesPath }];
        const videoFiles = [];

        while (queue.length > 0) {
            const cur = queue.shift();
            try {
                const items = await cloud139.listDiskDirAll(cur.id);
                for (const item of items) {
                    const subPath = cur.path ? `${cur.path}/${item.name}` : `/${item.name}`;
                    if (item.type === 'folder' || item.isFolder || item.fileType === 1) {
                        queue.push({ id: item.fileId || item.id, path: subPath });
                    } else {
                        const extMatch = (item.name || '').match(/\.([a-zA-Z0-9]{2,10})$/);
                        const ext = extMatch ? extMatch[1].toLowerCase() : '';
                        if (ext && RecognitionEngine.VIDEO_EXTENSIONS && RecognitionEngine.VIDEO_EXTENSIONS.has(ext)) {
                            // 智能推断所属 Season
                            let folderSeason = 1;
                            const seasonMatch = cur.path.match(/Season\s*(\d+)/i) || cur.path.match(/S(\d+)/i) || cur.path.match(/第\s*(\d+)\s*季/i);
                            if (seasonMatch) {
                                folderSeason = Number(seasonMatch[1]);
                            } else if (/SP|特别篇|花絮/i.test(cur.path)) {
                                folderSeason = 0;
                            }
                            videoFiles.push({
                                id: String(item.fileId || item.id),
                                name: item.name,
                                path: subPath,
                                parentId: cur.id,
                                parentPath: cur.path || '/',
                                size: parseInt(item.size || '0', 10) || 0,
                                _folderSeason: folderSeason,
                            });
                        }
                    }
                }
            } catch (err) {
                logger.warn(`[缺集巡检] 遍历剧集子目录 ${cur.path} 异常: ${err.message}`);
            }
        }
        return videoFiles;
    }

    /**
     * 行业标准流水线：针对单部剧集执行完整的全量穿透、TMDB 绑定与季播差集核验
     * @param {object} cloud139
     * @param {object} series - { fileId, name, category, path }
     * @param {object} options - { excludeUnreleased, ignoreSeasonZero, overrideTmdbId, overrideSeason }
     * @param {number} index
     * @param {number} total
     * @returns {Promise<Array<object>>}
     */
    static async inspectSingleSeries(cloud139, series, options = {}, index = 1, total = 1) {
        const catTag = series.category ? `[${series.category}] ` : '';

        // 1. 全量收集该剧自身的所有视频文件
        const videoFiles = await this.scanSeriesVideoFiles(cloud139, series.fileId, series.path);

        if (!videoFiles.length) {
            await logTaskEvent(`[缺集巡检] (${index}/${total}) ⚠️ ${catTag}《${series.name}》: 目录中未找到任何有效视频文件，已跳过`);
            return [];
        }

        // 复用 RecognitionEngine 提取纯净影视片名与年份（剥除压制组、分辨率、季度等干扰）
        const cleanFolder = RecognitionEngine.cleanAnimeFolderName(series.name);
        const inferredTitle = RecognitionEngine.inferTitle(cleanFolder) || cleanFolder || series.name;
        let showTitle = inferredTitle
            .replace(/\{tmdb-\d+\}/ig, '')
            .replace(/\[tmdbid-\d+\]/ig, '')
            .replace(/\s*[\(\[（【]\s*(?:19\d{2}|20\d{2})\s*[\)\]）】]/g, '')
            .trim();

        const year = RecognitionEngine.extractYear(series.name) || RecognitionEngine.extractYear(series.path) || '';

        // 2. 身份解析与 TMDB 锁定
        let tmdbId = options.overrideTmdbId ? String(options.overrideTmdbId).trim() : null;

        // 2.1 检查用户手动持久化校准的 TMDB 绑定（最高优先级，永久生效）
        if (!tmdbId) {
            const manualOverride = this.getTmdbOverride({ folderPath: series.path, folderId: series.fileId });
            if (manualOverride && manualOverride.tmdbId) {
                tmdbId = String(manualOverride.tmdbId).trim();
                if (manualOverride.title) {
                    showTitle = manualOverride.title;
                }
                logger.info(`[缺集巡检] 命中用户永久锁定的 TMDB 规则: 路径="${series.path}" => TMDB: ${tmdbId} (${showTitle})`);
            }
        }

        // 2.2 优先在路径或目录名中提取显式 TMDB ID（如 {tmdb-281233} 或 [tmdbid-281233]）
        if (!tmdbId) {
            const tmdbMatch = series.name.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i) || (series.path || '').match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
            if (tmdbMatch) {
                tmdbId = tmdbMatch[1];
            }
        }

        let suggestedCandidate = null;
        // 若无显式 {tmdb-id} 标签，复用项目成熟的 searchCandidates 智能打分引擎（精准锁定 /search/tv + 评分裁决）
        if (!tmdbId && this.tmdbService && this.tmdbService.credential) {
            try {
                const candidates = await this.tmdbService.searchCandidates(showTitle, { year, mediaType: 'tv' });
                if (Array.isArray(candidates) && candidates.length > 0) {
                    const best = candidates[0];
                    const normShow = showTitle.trim().toLowerCase();
                    const normBest = (best.title || '').trim().toLowerCase();
                    const normOrig = (best.originalTitle || "").trim().toLowerCase();
                    const isExactTitle = (normBest === normShow) || (normOrig === normShow);
                    const hasYearMatch = Boolean(year && best.year && String(best.year) === String(year));
                    const isYearConflict = Boolean(year && best.year && Math.abs(Number(best.year) - Number(year)) > 1);

                    // 科学置信度阶梯判定与防误判门禁：
                    // 1. 若提取到明确年份，且与候选年份相差超过1年 => 坚决触发防误判保护，绝不自动锁定！
                    // 2. 片名完全一致且年份匹配 => 得分 >= 75 即采纳
                    // 3. 片名完全一致 (无年份冲突) => 得分 >= 82 即采纳
                    // 4. 模糊匹配 => 必须得分 >= 88 且片名长度 >= 2 且无年份冲突 才能自动锁定
                    const isConfident = !isYearConflict && (
                        (isExactTitle && (hasYearMatch || best.engineScore >= 82)) ||
                        (best.engineScore >= 88 && showTitle.length >= 2)
                    );

                    if (best && best.id && isConfident) {
                        tmdbId = String(best.id);
                        showTitle = best.title || showTitle;
                        logger.info(`[缺集巡检] 智能检索高置信锁定: 《${series.name}》=> TMDB: ${tmdbId} (${showTitle}, 得分: ${best.engineScore?.toFixed(1) || "N/A"})`);
                    } else if (best && best.id) {
                        const conflictReason = isYearConflict
                            ? `年份冲突(目录标注 ${year}，TMDB候选首播 ${best.year})`
                            : `评分(${(best.engineScore || 0).toFixed(0)})未达自动绑定门槛(需>=88)`;
                        suggestedCandidate = {
                            id: String(best.id),
                            title: best.title || showTitle,
                            year: best.year || "",
                            posterPath: best.posterPath || null,
                            score: best.engineScore || 0,
                            reason: conflictReason,
                        };
                        logger.info(`[缺集巡检] 《${series.name}》候选 TMDB《${best.title}》(得分: ${best.engineScore?.toFixed(1) || "N/A"}) ${conflictReason}，防误判保护：归入「未识别待人工核查」`);
                    }
                }
            } catch (err) {
                logger.warn(`[缺集巡检] TMDB 自动检索失败 [${showTitle}]: ${err.message}`);
            }
        }

        // 若依然无法匹配 TMDB ID，登记为未识别状态并进入未识别展示区，绝不强制识别或静默吞掉
        if (!tmdbId) {
            await logTaskEvent(`[缺集巡检] (${index}/${total}) ⚠️ ${catTag}《${showTitle}》: 未能高置信锁定 TMDB，已归入「未识别待核查区」待人工核查`);
            const sampleFiles = videoFiles.slice(0, 3).map(f => f.name);
            return [{
                groupKey: `unmatched:${series.fileId || normalizePathKey(series.path)}`,
                title: showTitle,
                originalFolder: series.name,
                tmdbId: null,
                season: 1,
                seasonLabel: '待核查',
                folderPath: series.path,
                folderId: series.fileId,
                category: series.category || '',
                posterPath: suggestedCandidate?.posterPath || null,
                airStatus: '未识别',
                firstAirYear: year || suggestedCandidate?.year || null,
                localCount: videoFiles.length,
                coveredCount: 0,
                tmdbCount: 0,
                totalEpisodes: videoFiles.length,
                localEpisodes: [],
                missingCount: 0,
                missingEpisodes: [],
                missingRangesStr: '未关联TMDB',
                shortRangesStr: '未关联TMDB',
                detailedList: ['• 提示：未获取到官方季播数据，请点击「核查」绑定 TMDB'],
                tooltipTitle: '未关联 TMDB',
                status: 'unidentified',
                isMatch: false,
                isExtra: false,
                isUnidentified: true,
                sampleFiles,
                suggestedCandidate,
                unidentifiedReason: suggestedCandidate
                    ? `候选推荐《${suggestedCandidate.title}》得分 ${(suggestedCandidate.score || 0).toFixed(0)}，低于自动绑定阈值，已触发防误判保护`
                    : '未能自动检索到匹配的官方剧集元数据',
            }];
        }

        // 3. 季播分组与官方比对
        const seasonGroupMap = new Map();

        videoFiles.forEach(file => {
            let season = file._folderSeason !== undefined ? file._folderSeason : 1;
            const se = RecognitionEngine.parseSeasonEpisode(file.name, season);
            if (se.season !== undefined && se.season !== null && !isNaN(se.season)) {
                season = Number(se.season);
            }
            if (options.overrideSeason) {
                season = Number(options.overrideSeason);
            }

            // 忽略特别篇 SP (第 0 季)
            if (options.ignoreSeasonZero !== false && season === 0) {
                return;
            }

            const groupKey = `tmdb:${tmdbId}:S${season}`;
            if (!seasonGroupMap.has(groupKey)) {
                seasonGroupMap.set(groupKey, {
                    groupKey,
                    title: showTitle,
                    tmdbId: String(tmdbId),
                    mediaType: 'tv',
                    season: season,
                    targetSeason: season,
                    folderPath: series.path,
                    folderId: series.fileId,
                    category: series.category || '',
                    files: [],
                    seasons: [],
                    seasonEpisodesMap: {},
                });
            }
            seasonGroupMap.get(groupKey).files.push(file);
        });

        if (seasonGroupMap.size === 0) {
            return [];
        }

        const groups = Array.from(seasonGroupMap.values());
        const results = await this.inspectGroupsWithTmdb(groups, { ...options, silent: true });

        // 4. 逐季输出业务级明确日志（缺更 vs 收全）
        for (const res of results) {
            if (!res) continue;
            res.category = series.category || '';
            res.folderId = series.fileId;
            res.folderPath = series.path;

            if (res.missingCount > 0) {
                await logTaskEvent(`[缺集巡检] (${index}/${total}) ❌ ${catTag}《${res.title}》${res.seasonLabel}: 本地收录 ${res.localCount} 集 / 官方 ${res.tmdbCount || (res.localCount + res.missingCount)} 集 | 缺失 ${res.missingCount} 集 [${res.missingRangesStr}]`);
            } else if (res.status === 'complete') {
                await logTaskEvent(`[缺集巡检] (${index}/${total}) ✔️ ${catTag}《${res.title}》${res.seasonLabel}: 全部 ${res.localCount} 集已收齐 (官方共 ${res.tmdbCount} 集)`);
            }
        }

        if (options.onlyEnded && results.length === 0 && groups.length > 0) {
            await logTaskEvent(`[缺集巡检] (${index}/${total}) ⏭️ ${catTag}《${showTitle}》: 当前为连载中剧集，已按「只检查完结剧」规则自动跳过`);
        }

        return results;
    }

    /**
     * 单剧手动修正 TMDB ID 并即时重新分析
     * @param {object} cloud139
     * @param {object} options - { folderPath, tmdbId, season, excludeUnreleased, ignoreSeasonZero }
     * @returns {Promise<object>}
     */
    static async inspectSingleShowWithTmdb(cloud139, { folderPath, tmdbId, season = 1, excludeUnreleased = true, ignoreSeasonZero = true, onlyEnded = false } = {}) {
        if (!folderPath) {
            throw new Error('未提供剧集文件夹路径');
        }
        await logTaskEvent(`[缺集巡检-单剧] 手动校准 TMDB: 路径="${folderPath}", TMDB ID=${tmdbId}, 第 ${season} 季`);

        let folderId = folderPath;
        if (typeof folderPath === 'string' && folderPath.startsWith('/')) {
            folderId = await this.resolvePathToCatalogId(cloud139, folderPath);
            if (!folderId) {
                throw new Error(`目录 "${folderPath}" 未能在网盘中找到`);
            }
        }

        const seriesObj = {
            fileId: folderId,
            name: path.basename(folderPath),
            path: folderPath,
            category: ''
        };

        const results = await this.inspectSingleSeries(cloud139, seriesObj, {
            excludeUnreleased,
            ignoreSeasonZero,
            overrideTmdbId: tmdbId,
            overrideSeason: season,
            onlyEnded: onlyEnded === true,
        }, 1, 1);

        const target = results.find(r => Number(r.season) === Number(season)) || results[0] || null;
        if (target) {
            await logTaskEvent(`[缺集巡检-单剧] 《${target.title}》校准分析完成: 本地 ${target.localCount} 集，缺失 ${target.missingCount} 集`);
            
            // 1. 持久化记录用户手动校准的 TMDB 绑定，确保后续全量扫描与定时任务永不失效
            this.saveTmdbOverride({
                folderPath,
                folderId,
                tmdbId: String(tmdbId).trim(),
                title: target.title,
            });

            // 2. 若后台有并发扫描流水线在进行，实时同步更新流水线中的 allItems，杜绝后续快照反向覆盖
            if (this._activeScanContext && Array.isArray(this._activeScanContext.allItems)) {
                const normPath = normalizePathKey(folderPath);
                const activeIdx = this._activeScanContext.allItems.findIndex(
                    i => (normalizePathKey(i.folderPath) === normPath || (folderId && i.folderId === folderId)) && Number(i.season) === Number(season)
                );
                if (activeIdx !== -1) {
                    this._activeScanContext.allItems[activeIdx] = target;
                } else {
                    this._activeScanContext.allItems.push(target);
                }
            }

            // 3. 同步热更新内存与磁盘持久化缓存
            if (!this.scanJob.result) {
                this.loadCache();
            }
            if (this.scanJob.result && Array.isArray(this.scanJob.result.items)) {
                const normPath = normalizePathKey(folderPath);
                const idx = this.scanJob.result.items.findIndex(
                    i => (normalizePathKey(i.folderPath) === normPath || (folderId && i.folderId === folderId)) && Number(i.season) === Number(season)
                );
                if (idx !== -1) {
                    this.scanJob.result.items[idx] = target;
                } else {
                    this.scanJob.result.items.unshift(target);
                }
                // 重建 shows 并更新统计
                this.scanJob.result.shows = this.buildShowGroups(this.scanJob.result.items);
                const missingShows = this.scanJob.result.shows.filter(s => s.hasMissing);
                const completeShows = this.scanJob.result.shows.filter(s => !s.hasMissing);
                this.scanJob.result.scannedShowsCount = this.scanJob.result.shows.length;
                this.scanJob.result.missingShowsCount = missingShows.length;
                this.scanJob.result.completeShowsCount = completeShows.length;
                this.scanJob.result.totalMissingCount = this.scanJob.result.shows.reduce((acc, s) => acc + s.totalMissingCount, 0);
                this.saveCache(this.scanJob.result, this.scanJob.targetPath, this.scanJob.durationMs);
            }
        }
        return target;
    }

    /**
     * 对外主入口：扫描并返回云盘剧集缺集巡检报告（行业标准逐剧流水线）
     * @param {object} cloud139
     * @param {object} options - { rootCatalogId, excludeUnreleased, ignoreSeasonZero, onProgress }
     * @returns {Promise<object>}
     */
    static async inspectDirectory(cloud139, options = {}) {
        const rootPathOrId = options.rootCatalogId || '/';
        const startTime = Date.now();
        await logTaskEvent(`[缺集巡检] 启动剧集缺集检测: 目标路径="${rootPathOrId}" (排除未播=${options.excludeUnreleased !== false}, 忽略SP=${options.ignoreSeasonZero !== false}, 只查完结=${options.onlyEnded === true})`);

        try {
            // 阶段 1: 结构定界，枚举所有剧集主目录
            const seriesList = await this.discoverSeriesDirectories(cloud139, rootPathOrId, options.onProgress);

            if (!seriesList.length) {
                await logTaskEvent(`[缺集巡检] ⚠️ 未在指定路径定界到任何有效剧集目录，巡检终止`);
                const emptyResult = {
                    scannedFilesCount: 0,
                    scannedShowsCount: 0,
                    missingShowsCount: 0,
                    completeShowsCount: 0,
                    totalMissingCount: 0,
                    durationMs: Date.now() - startTime,
                    items: [],
                };
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        total: 0,
                        current: 0,
                        percent: 100,
                        message: '未发现任何剧集目录',
                    });
                }
                return emptyResult;
            }

            if (typeof options.onProgress === 'function') {
                options.onProgress({
                    total: seriesList.length,
                    current: 0,
                    percent: 8,
                    message: `定界完成: 发现 ${seriesList.length} 部电视剧待体检，即将开始逐剧全量穿透...`,
                });
            }

            await logTaskEvent(`[缺集巡检] [1/2 结构定界] 目录 "${rootPathOrId}" 定界完成: 共发现 ${seriesList.length} 部电视剧待体检，即将开始逐剧全量穿透...`);

            // 阶段 2: 逐剧独立流水线推进 (并发度为 5，兼顾速度与稳定性)
            const limit = pLimit(5);
            let totalScannedFiles = 0;
            const allItems = [];
            let finishedCount = 0;

            // 注册全局活跃全量巡检上下文，支持单剧修正热注入穿透，防止异步流水线反向覆盖
            this._activeScanContext = {
                allItems,
                seriesList,
                options,
            };

            await Promise.all(seriesList.map((series, idx) => limit(async () => {
                const seasonResults = await this.inspectSingleSeries(cloud139, series, options, idx + 1, seriesList.length);
                finishedCount++;
                if (Array.isArray(seasonResults) && seasonResults.length > 0) {
                    for (const item of seasonResults) {
                        if (item) {
                            allItems.push(item);
                            totalScannedFiles += (item.localCount || 0);
                        }
                    }
                }

                if (typeof options.onProgress === 'function') {
                    const pct = Math.min(98, Math.round(10 + (finishedCount / seriesList.length) * 88));
                    // 实时排序列出已完成项并构建 ShowGroup 结构
                    const currentItemsSorted = [...allItems].sort((a, b) => {
                        if (a.missingCount !== b.missingCount) {
                            return b.missingCount - a.missingCount;
                        }
                        return (a.title || '').localeCompare(b.title || '');
                    });
                    const liveShows = this.buildShowGroups(currentItemsSorted);
                    const unidentifiedShows = liveShows.filter(s => s.isUnidentified || !s.tmdbId);
                    const identifiedShows = liveShows.filter(s => !s.isUnidentified && s.tmdbId);
                    const missingShows = identifiedShows.filter(s => s.hasMissing);
                    const completeShows = identifiedShows.filter(s => !s.hasMissing);
                    const liveSnapshot = {
                        scannedFilesCount: totalScannedFiles,
                        scannedShowsCount: liveShows.length,
                        missingShowsCount: missingShows.length,
                        completeShowsCount: completeShows.length,
                        unidentifiedShowsCount: unidentifiedShows.length,
                        totalMissingCount: currentItemsSorted.filter(i => i.missingCount > 0).reduce((acc, cur) => acc + cur.missingCount, 0),
                        durationMs: Date.now() - startTime,
                        items: currentItemsSorted,
                        shows: liveShows,
                        isScanning: true,
                    };

                    options.onProgress({
                        total: seriesList.length,
                        current: finishedCount,
                        percent: pct,
                        currentShow: series.name,
                        message: `(${finishedCount}/${seriesList.length}) 已核验《${series.name}》`,
                        snapshot: liveSnapshot,
                    });
                }
                return seasonResults || [];
            })));

            // 最终排序：有缺集的排在最前（按缺集数降序），随后按标题排序
            allItems.sort((a, b) => {
                if (a.missingCount !== b.missingCount) {
                    return b.missingCount - a.missingCount;
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            const durationMs = Date.now() - startTime;
            const missingItems = allItems.filter(i => i.missingCount > 0);
            const completeItems = allItems.filter(i => i.status === 'complete');
            const totalMissingCount = missingItems.reduce((acc, cur) => acc + cur.missingCount, 0);

            // 结构化结项看板
            const summaryLog = `[缺集巡检] ================= 缺集巡检结项报告 =================\n` +
                `• 巡检电视剧: ${seriesList.length} 部 (缺更季组: ${missingItems.length} 个，全收录: ${completeItems.length} 个)\n` +
                `• 累计缺更集数: ${totalMissingCount} 集 (全量检阅视频文件: ${totalScannedFiles} 个)\n` +
                `• 总巡检耗时: ${(durationMs / 1000).toFixed(1)} 秒\n` +
                `=============================================================`;
            logger.info(summaryLog);
            await logTaskEvent(summaryLog);

            const allShows = this.buildShowGroups(allItems);
            const unidentifiedShows = allShows.filter(s => s.isUnidentified || !s.tmdbId);
            const identifiedShows = allShows.filter(s => !s.isUnidentified && s.tmdbId);
            const missingShows = identifiedShows.filter(s => s.hasMissing);
            const completeShows = identifiedShows.filter(s => !s.hasMissing);

            const finalReport = {
                scannedFilesCount: totalScannedFiles,
                scannedShowsCount: allShows.length,
                missingShowsCount: missingShows.length,
                completeShowsCount: completeShows.length,
                unidentifiedShowsCount: unidentifiedShows.length,
                totalMissingCount,
                durationMs,
                items: allItems,
                shows: allShows,
            };

            if (typeof options.onProgress === 'function') {
                options.onProgress({
                    total: seriesList.length,
                    current: seriesList.length,
                    percent: 100,
                    message: `巡检完成: 发现 ${missingItems.length} 季缺更，累计缺失 ${totalMissingCount} 集`,
                });
            }

            return finalReport;
        } catch (err) {
            await logTaskEvent(`[缺集巡检] 巡检执行发生异常: ${err.message}`);
            throw err;
        } finally {
            this._activeScanContext = null;
        }
    }

    /**
     * 将季级别结果（Season Results）按电视剧主实体（Show Entity）聚类合并
     * 确保同一部电视剧的所有季聚合在唯一的一个 ShowGroup 卡片下
     * @param {Array<object>} seasonResults
     * @returns {Array<object>} showGroups
     */
    static buildShowGroups(seasonResults = []) {
        const showMap = new Map();

        for (const item of seasonResults) {
            if (!item) continue;
            // 提取电视剧主目录根路径（剥除子季目录，如 /Season 1、/S01、/第 1 季）
            let seriesFolder = (item.folderPath || '').replace(/\\/g, '/');
            if (/(?:[\\/](?:Season\s*\d+|S\d+|第\s*\d+\s*季|SP))$/i.test(seriesFolder)) {
                seriesFolder = path.dirname(seriesFolder).replace(/\\/g, '/');
            }
            const normTitle = RecognitionEngine.normalizeTitleKey(item.title);
            // 聚合 Key 优先绑定物理剧集根目录，杜绝不同物理目录的剧集因模糊命中同一 TMDB ID 而被强行揉成一个卡片
            const showKey = seriesFolder ? `dir:${seriesFolder}` : (item.tmdbId ? `tmdb:${item.tmdbId}` : `title:${normTitle}`);

            if (!showMap.has(showKey)) {
                showMap.set(showKey, {
                    showKey,
                    title: item.title,
                    originalFolder: item.originalFolder || item.title,
                    tmdbId: item.tmdbId || null,
                    folderId: item.folderId || '',
                    folderPath: seriesFolder || item.folderPath || '',
                    category: item.category || '',
                    posterPath: item.posterPath || null,
                    firstAirYear: item.firstAirYear || null,
                    airStatus: item.airStatus || null,
                    isEnded: item.isEnded,
                    isUnidentified: Boolean(!item.tmdbId || item.isUnidentified || item.status === 'unidentified'),
                    unidentifiedReason: item.unidentifiedReason || '',
                    sampleFiles: item.sampleFiles || [],
                    suggestedCandidate: item.suggestedCandidate || null,
                    seasons: [],
                    totalMissingCount: 0,
                    totalLocalCount: 0,
                    totalTmdbCount: 0,
                    hasMissing: false,
                });
            }

            const show = showMap.get(showKey);
            if (!show.posterPath && item.posterPath) show.posterPath = item.posterPath;
            if (!show.firstAirYear && item.firstAirYear) show.firstAirYear = item.firstAirYear;
            if (!show.airStatus && item.airStatus) show.airStatus = item.airStatus;

            // 严防同一电视剧下出现两个相同的季（如两个「第 1 季」）
            const existingIdx = show.seasons.findIndex(s => Number(s.season) === Number(item.season));
            if (existingIdx !== -1) {
                const existing = show.seasons[existingIdx];
                // 保留本地收录更多的一项
                if ((item.localCount || 0) > (existing.localCount || 0)) {
                    show.totalMissingCount -= (existing.missingCount || 0);
                    show.totalLocalCount -= (existing.localCount || 0);
                    show.totalTmdbCount -= (existing.tmdbCount || 0);
                    show.seasons[existingIdx] = item;
                    show.totalMissingCount += (item.missingCount || 0);
                    show.totalLocalCount += (item.localCount || 0);
                    show.totalTmdbCount += (item.tmdbCount || (item.localCount + item.missingCount) || 0);
                }
            } else {
                show.seasons.push(item);
                show.totalMissingCount += (item.missingCount || 0);
                show.totalLocalCount += (item.localCount || 0);
                show.totalTmdbCount += (item.tmdbCount || (item.localCount + item.missingCount) || 0);
            }

            if (show.seasons.some(s => s.missingCount > 0)) {
                show.hasMissing = true;
            } else {
                show.hasMissing = false;
            }
        }

        const showGroups = Array.from(showMap.values());
        for (const show of showGroups) {
            show.seasons.sort((a, b) => Number(a.season) - Number(b.season));
            show.isEnded = show.seasons.every(s => s.isEnded);
        }

        showGroups.sort((a, b) => {
            if (a.totalMissingCount !== b.totalMissingCount) {
                return b.totalMissingCount - a.totalMissingCount;
            }
            return (a.title || '').localeCompare(b.title || '');
        });

        return showGroups;
    }

    /**
     * 单剧即时复检：针对单部剧集目录进行秒级快速重新核验并热更新缓存
     * @param {object} cloud139
     * @param {object} options - { folderPath, tmdbId, excludeUnreleased, ignoreSeasonZero, onlyEnded }
     * @returns {Promise<object>} updatedShowGroup
     */
    static async recheckShow(cloud139, { folderPath, folderId = '', tmdbId = '', excludeUnreleased = true, ignoreSeasonZero = true, onlyEnded = false } = {}) {
        if (!folderPath) {
            throw new Error('未提供剧集文件夹路径');
        }
        await logTaskEvent(`[缺集复检-单剧] 开始快速复检: 路径="${folderPath}"`);

        if (!this.scanJob.result) {
            this.loadCache();
        }

        const normTarget = normalizePathKey(folderPath);
        let existingFiles = [];
        let cachedFolderId = folderId;

        // ★ 核心提速 1：若内存巡检结果中已存在该剧的视频文件，直接复用已有文件，无需重复全量递归网盘目录！
        if (this.scanJob?.result) {
            const matchedItems = (this.scanJob.result.items || []).filter(
                i => normalizePathKey(i.folderPath) === normTarget || (folderId && i.folderId === folderId)
            );
            if (matchedItems.length > 0) {
                if (!cachedFolderId) cachedFolderId = matchedItems[0].folderId;
                for (const item of matchedItems) {
                    if (Array.isArray(item.localFiles) && item.localFiles.length > 0) {
                        for (const lf of item.localFiles) {
                            existingFiles.push({
                                id: lf.fileId,
                                name: lf.name,
                                path: lf.path,
                                size: lf.size,
                                _folderSeason: item.season,
                            });
                        }
                    }
                }
            }
        }

        let seasonResults = [];

        if (existingFiles.length > 0 && tmdbId) {
            // 直接复用已扫描的视频文件，纯粹重新根据新 TMDB ID 比对分集，0 次网盘目录网络往返！
            const targetTmdbId = String(tmdbId).trim();
            const seasonGroupMap = new Map();
            for (const file of existingFiles) {
                let season = file._folderSeason !== undefined ? file._folderSeason : 1;
                const se = RecognitionEngine.parseSeasonEpisode(file.name, season);
                if (se.season !== undefined && se.season !== null && !isNaN(se.season)) {
                    season = Number(se.season);
                }
                if (ignoreSeasonZero !== false && season === 0) continue;

                const groupKey = `tmdb:${targetTmdbId}:S${season}`;
                if (!seasonGroupMap.has(groupKey)) {
                    seasonGroupMap.set(groupKey, {
                        groupKey,
                        title: path.basename(folderPath),
                        tmdbId: targetTmdbId,
                        mediaType: 'tv',
                        season,
                        targetSeason: season,
                        folderPath,
                        folderId: cachedFolderId,
                        category: '',
                        files: [],
                        seasons: [],
                        seasonEpisodesMap: {},
                    });
                }
                seasonGroupMap.get(groupKey).files.push(file);
            }

            if (seasonGroupMap.size > 0) {
                seasonResults = await this.inspectGroupsWithTmdb(Array.from(seasonGroupMap.values()), {
                    excludeUnreleased,
                    ignoreSeasonZero,
                    onlyEnded: onlyEnded === true,
                    silent: true,
                });
                for (const res of seasonResults) {
                    if (!res) continue;
                    res.folderId = cachedFolderId;
                    res.folderPath = folderPath;
                }
            }
        }

        // 若缓存中无文件（冷启动）或上述快速比对未生成结果，则穿透扫描网盘真实目录
        if (!seasonResults.length) {
            let finalFolderId = cachedFolderId;
            if (!finalFolderId && typeof folderPath === 'string' && folderPath.startsWith('/')) {
                finalFolderId = await this.resolvePathToCatalogId(cloud139, folderPath);
                if (!finalFolderId) {
                    throw new Error(`目录 "${folderPath}" 未能在网盘中找到`);
                }
            }

            const seriesObj = {
                fileId: finalFolderId || folderPath,
                name: path.basename(folderPath),
                path: folderPath,
                category: ''
            };

            seasonResults = await this.inspectSingleSeries(cloud139, seriesObj, {
                excludeUnreleased,
                ignoreSeasonZero,
                overrideTmdbId: tmdbId || undefined,
                onlyEnded: onlyEnded === true,
            }, 1, 1);
        }

        const showGroups = this.buildShowGroups(seasonResults);
        const updatedShow = showGroups[0] || null;

        // 1. 持久化记录用户手动校准的 TMDB 绑定，确保后续全量扫描与定时任务永不失效
        if (tmdbId) {
            this.saveTmdbOverride({
                folderPath,
                folderId: cachedFolderId,
                tmdbId: String(tmdbId).trim(),
                title: updatedShow?.title || path.basename(folderPath),
            });
        }

        // 2. 若后台有并发扫描流水线在进行，实时同步更新流水线中的 allItems，杜绝后续快照反向覆盖
        if (this._activeScanContext && Array.isArray(this._activeScanContext.allItems)) {
            this._activeScanContext.allItems = this._activeScanContext.allItems.filter(i => {
                const itemNorm = normalizePathKey(i.folderPath);
                const isSame = (normTarget && itemNorm === normTarget) ||
                               (cachedFolderId && i.folderId && i.folderId === cachedFolderId);
                return !isSame;
            });
            this._activeScanContext.allItems.push(...seasonResults);
        }

        // 3. 同步热更新内存与磁盘持久化缓存
        if (!this.scanJob.result) {
            this.loadCache();
        }
        if (this.scanJob.result) {
            if (!Array.isArray(this.scanJob.result.items)) {
                this.scanJob.result.items = [];
            }
            // 从 items 中过滤掉该剧原有的所有季
            this.scanJob.result.items = this.scanJob.result.items.filter(i => {
                const itemNorm = normalizePathKey(i.folderPath);
                const isSame = (normTarget && itemNorm === normTarget) ||
                               (cachedFolderId && i.folderId && i.folderId === cachedFolderId);
                return !isSame;
            });
            // 插入新季结果
            this.scanJob.result.items.push(...seasonResults);

            // 重新计算 shows 实体列表
            this.scanJob.result.shows = this.buildShowGroups(this.scanJob.result.items);

            const unidentifiedShows = this.scanJob.result.shows.filter(s => s.isUnidentified || !s.tmdbId);
            const identifiedShows = this.scanJob.result.shows.filter(s => !s.isUnidentified && s.tmdbId);
            const missingShows = identifiedShows.filter(s => s.hasMissing);
            const completeShows = identifiedShows.filter(s => !s.hasMissing);
            this.scanJob.result.scannedShowsCount = this.scanJob.result.shows.length;
            this.scanJob.result.unidentifiedShowsCount = unidentifiedShows.length;
            this.scanJob.result.missingShowsCount = missingShows.length;
            this.scanJob.result.completeShowsCount = completeShows.length;
            this.scanJob.result.totalMissingCount = identifiedShows.reduce((acc, s) => acc + s.totalMissingCount, 0);

            this.saveCache(this.scanJob.result, this.scanJob.targetPath, this.scanJob.durationMs);
        }

        if (updatedShow) {
            await logTaskEvent(`[缺集复检-单剧] 《${updatedShow.title}》复检完成: 本地共 ${updatedShow.totalLocalCount} 集，缺失 ${updatedShow.totalMissingCount} 集`);
        }
        return updatedShow;
    }

    static initEventListener() {
        if (this._hasInitEvent) return;
        this._hasInitEvent = true;
        try {
            const EventService = require('./eventService');
            EventService.getInstance().on('taskComplete', (data) => {
                try {
                    const fileList = data?.fileList || data?.items || [];
                    if (!fileList.length || !this.scanJob.result) return;
                    logger.info(`[缺集巡检-事件驱动] 监测到资产归档入库 (${fileList.length} 项)，标记缺集缓存待联动`);
                } catch (_) {}
            });
        } catch (_) {}
    }
}

module.exports = { EpisodeInspectionService };

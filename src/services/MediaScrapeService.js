/**
 * MediaScrapeService - 云盘影视自动刮削与规范整理领域核心编排服务
 * 
 * 核心目标：后台全自动无人值守。
 * 铁律护栏：
 * 1. 源目录与目标目录物理隔离，绝对互斥；
 * 2. 宁可漏，绝不错：存疑或冲突条目坚决在源目录原地不动，沉淀至待处理箱；
 * 3. 写前操作日志 (WAL) 先行，支持一键无损逆向撤回；
 * 4. 人工纠偏后自动持久化 ScrapeBinding，终身自愈免干预。
 */

const { Cloud139DriveAdapter, OpenListDriveAdapter } = require('./MediaDriveAdapter');
const { Cloud139Service } = require('./cloud139');
const alistService = require('./alistService');
const { TMDBService } = require('./tmdb');
const { RecognitionEngine } = require('./RecognitionEngine');
const { ScrapeJournalService } = require('./ScrapeJournalService');
const ConfigService = require('./ConfigService');
const { EventService } = require('./eventService');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database');
const { Account } = require('../entities');
const logger = require('../utils/logger');
const path = require('path');

class MediaScrapeService {
    static tmdbService = new TMDBService();
    static messageUtil = new MessageUtil();

    /**
     * 根据规则获取对应的底层网盘驱动适配器
     * @param {object} rule
     * @returns {Promise<MediaDriveAdapter>}
     */
    static async getAdapter(rule) {
        if (!rule) throw new Error('缺少规则配置');
        const driveType = rule.driveType || 'cloud139';

        if (driveType === 'cloud139') {
            if (!AppDataSource.isInitialized) throw new Error('数据库尚未初始化');
            const accountRepo = AppDataSource.getRepository(Account);
            let account = null;
            if (rule.accountId) {
                account = await accountRepo.findOne({ where: { id: Number(rule.accountId), accountType: 'cloud139' } });
            }
            if (!account) {
                account = (await accountRepo.findOne({ where: { accountType: 'cloud139', isActive: true } })) ||
                          (await accountRepo.findOne({ where: { accountType: 'cloud139' } }));
            }
            if (!account) throw new Error('未找到可用的 139 网盘账号');
            const cloud139Instance = Cloud139Service.getInstance(account);
            return new Cloud139DriveAdapter(cloud139Instance);
        } else if (driveType === 'openlist') {
            return new OpenListDriveAdapter(alistService);
        } else {
            throw new Error(`暂不支持的驱动类型: ${driveType}`);
        }
    }

    /**
     * 规划整理计划 (预演与严格识别，绝不产生物理写入)
     * @param {object} rule
     * @returns {Promise<object>}
     */
    static async planRule(rule) {
        const adapter = await this.getAdapter(rule);
        const sourceRef = rule.sourceDirRef || rule.sourceDirPath;
        const targetRef = rule.targetDirRef || rule.targetDirPath;

        // 1. 严格目录合法性与互斥隔离校验
        const dirCheck = adapter.validateDirs(sourceRef, targetRef, rule.sourceDirPath, rule.targetDirPath);
        if (!dirCheck.valid) {
            throw new Error(`目录校验失败: ${dirCheck.reason}`);
        }

        logger.info(`[影视刮削] 开始扫描源目录: ${rule.sourceDirPath || sourceRef}`);
        const allItems = await adapter.listAll(sourceRef);
        const videoFiles = allItems.filter(item => {
            if (item.isDir) return false;
            const ext = path.extname(item.name).replace(/^\./, '').toLowerCase();
            return RecognitionEngine.VIDEO_EXTENSIONS.has(ext);
        });

        logger.info(`[影视刮削] 源目录下共发现 ${videoFiles.length} 个视频文件`);
        const operations = [];

        for (const file of videoFiles) {
            const ext = path.extname(file.name).replace(/^\./, '').toLowerCase();
            const parsed = RecognitionEngine.parseMediaFilename(file.name);
            const parentName = file.parentRef || '';

            // ① Tier A 优先：检查显式 {tmdb-xxx} 标签或历史自愈绑定
            let matchedTmdbId = RecognitionEngine.extractTmdbIdTag(file.name) ||
                                RecognitionEngine.extractTmdbIdTag(parentName);
            let matchedMediaType = parsed.mediaType || rule.mediaType || 'movie';

            if (!matchedTmdbId) {
                const binding = await ScrapeJournalService.findBinding(rule.driveType, rule.accountId, parsed.title || file.name);
                if (binding && binding.tmdbId) {
                    matchedTmdbId = binding.tmdbId;
                    matchedMediaType = binding.mediaType || matchedMediaType;
                }
            }

            let candidate = null;
            let decisionReason = '';
            let regionalTranslations = {};
            let translationsDisplay = '';

            if (matchedTmdbId) {
                // Tier A 命中：直接拉取详情
                candidate = { id: matchedTmdbId, mediaType: matchedMediaType };
                decisionReason = 'tier_a_explicit_hit';
                try {
                    const trans = await this.tmdbService.getTranslations(matchedTmdbId, matchedMediaType);
                    regionalTranslations = trans.regional || {};
                    translationsDisplay = trans.display || '';
                } catch (_) {}
            } else {
                // Tier B: 严格算法多模态检索与全区域 Translations 证据链比对
                const candidates = await this.tmdbService.searchCandidates(
                    parsed.title,
                    parsed.year,
                    rule.mediaType && rule.mediaType !== 'auto' ? rule.mediaType : parsed.mediaType
                );

                const decision = await RecognitionEngine.chooseTmdbCandidate(candidates, parsed, {
                    tmdbClient: this.tmdbService,
                    minScore: ConfigService.getConfigValue('scrape.minScore') || 280
                });

                if (decision && decision.candidate) {
                    candidate = decision.candidate;
                    decisionReason = decision.reason || 'exact_title';
                    regionalTranslations = decision.regionalTranslations || {};
                    translationsDisplay = decision.translationsDisplay || '';
                } else {
                    decisionReason = decision?.reason || 'no_exact_match';
                }
            }

            // ② 判定是否放行自动整理
            if (candidate && candidate.id) {
                const finalTitle = candidate.title || parsed.title;
                const finalYear = candidate.year || parsed.year || '';
                const isTv = (candidate.mediaType === 'tv' || parsed.mediaType === 'tv');

                const targetFields = {
                    mediaType: isTv ? 'tv' : 'movie',
                    title: finalTitle,
                    chineseTitle: candidate.title_zh || candidate.title || finalTitle,
                    year: finalYear,
                    tmdbId: String(candidate.id),
                    id: String(candidate.id),
                    seasonEpisode: isTv ? `S${String(parsed.season || 1).padStart(2, '0')}E${String(parsed.episode || 1).padStart(2, '0')}` : '',
                    season: parsed.season || 1,
                    episode: parsed.episode || 1,
                    episodeTitle: parsed.episodeTitle || '',
                    ...parsed,
                    ext
                };

                const stdTarget = RecognitionEngine.buildStandardTargetName(targetFields, ext);
                const targetSubDir = isTv && stdTarget.seasonFolder ? `${stdTarget.folderName}/${stdTarget.seasonFolder}` : stdTarget.folderName;
                const newFileName = stdTarget.filename;

                operations.push({
                    driveType: rule.driveType,
                    accountId: rule.accountId,
                    kind: 'video',
                    fileRef: file.ref,
                    oldParentRef: file.parentRef,
                    oldParentPath: rule.sourceDirPath,
                    oldName: file.name,
                    size: file.size,
                    newParentPath: `${rule.targetDirPath || ''}/${targetSubDir}`.replace(/\/+/g, '/'),
                    targetSubDir,
                    newName: newFileName,
                    mediaType: isTv ? 'tv' : 'movie',
                    tmdbId: String(candidate.id),
                    season: parsed.season,
                    episode: parsed.episode,
                    title: finalTitle,
                    year: finalYear,
                    confidence: 300,
                    status: 'ready',
                    reason: decisionReason,
                    regionalTranslations,
                    translationsDisplay
                });
            } else {
                // 存疑条目：坚决在源目录原地不动！
                operations.push({
                    driveType: rule.driveType,
                    accountId: rule.accountId,
                    kind: 'video',
                    fileRef: file.ref,
                    oldParentRef: file.parentRef,
                    oldParentPath: rule.sourceDirPath,
                    oldName: file.name,
                    size: file.size,
                    status: 'pending_review',
                    reason: decisionReason,
                    title: parsed.title,
                    year: parsed.year,
                    season: parsed.season,
                    episode: parsed.episode
                });
            }
        }

        // ③ 同批次同集冲突洗版仲裁：保留最佳画质版本，次选标记 conflict_discard 淘汰
        const episodeOpsMap = new Map();
        for (const op of operations) {
            if (op.status !== 'ready') continue;
            const epKey = `${op.newParentPath || ''}#${op.mediaType === 'tv' ? `S${op.season}E${op.episode}` : op.title}`;
            if (!episodeOpsMap.has(epKey)) episodeOpsMap.set(epKey, []);
            episodeOpsMap.get(epKey).push(op);
        }

        for (const [, ops] of episodeOpsMap.entries()) {
            if (ops.length <= 1) continue;
            ops.sort((a, b) => {
                const tagsA = RecognitionEngine.inferTechnicalTags(a.newName || a.oldName, a.size);
                const tagsB = RecognitionEngine.inferTechnicalTags(b.newName || b.oldName, b.size);
                const cmp = RecognitionEngine.compareCandidates(tagsA, tagsB, { autoWash: true });
                if (cmp !== 0) return cmp;
                return Number(b.size || 0) - Number(a.size || 0);
            });
            for (let i = 1; i < ops.length; i++) {
                ops[i].status = 'conflict_discard';
                ops[i].reason = `多版本洗版淘汰：同批次存在更优画质版本【${ops[0].oldName}】`;
            }
        }

        const readyCount = operations.filter(o => o.status === 'ready').length;
        const pendingCount = operations.filter(o => o.status === 'pending_review').length;

        return {
            rule,
            operations,
            readyCount,
            pendingCount,
            totalFiles: videoFiles.length
        };
    }

    /**
     * 正式执行整理计划 (写前日志 -> 跨目录创建与搬移 -> 标记成功 -> 广播)
     * @param {object} plan
     * @returns {Promise<object>}
     */
    static async executePlan(plan) {
        if (!plan || !plan.operations) throw new Error('计划对象无效');
        const rule = plan.rule;
        const readyOps = plan.operations.filter(o => o.status === 'ready');
        if (!readyOps.length) {
            logger.info('[影视刮削] 没有可自动放行整理的条目');
            return { successCount: 0, failedCount: 0 };
        }

        const adapter = await this.getAdapter(rule);
        const batch = await ScrapeJournalService.createBatch({
            driveType: rule.driveType,
            accountId: rule.accountId,
            rootRef: rule.sourceDirRef || rule.sourceDirPath,
            rootPath: rule.sourceDirPath,
            targetRootRef: rule.targetDirRef || rule.targetDirPath,
            targetRootPath: rule.targetDirPath,
            trigger: 'manual',
            organize: true
        });

        // 1. 写前日志先行 (WAL)
        const recordedOps = await ScrapeJournalService.recordOperations(batch.id, readyOps);
        const pendingOps = plan.operations.filter(o => o.status === 'pending_review');
        if (pendingOps.length) {
            await ScrapeJournalService.recordOperations(batch.id, pendingOps);
        }
        const results = { successCount: 0, failedCount: 0, appliedRecordIds: [] };

        for (let i = 0; i < readyOps.length; i++) {
            const op = readyOps[i];
            const record = recordedOps[i];
            try {
                // 2. 在目标目录下幂等创建层级
                let currentParentRef = rule.targetDirRef || rule.targetDirPath;
                const pathSegments = op.targetSubDir.split('/').filter(Boolean);
                for (const seg of pathSegments) {
                    currentParentRef = await adapter.ensureDir(currentParentRef, seg);
                }

                // 3. 跨目录移动文件
                await adapter.batchMove([op.fileRef], currentParentRef);

                // 4. 若名称改变，执行规范命名
                if (op.newName && op.newName !== op.oldName) {
                    await adapter.rename(op.fileRef, op.newName);
                }

                results.successCount++;
                if (record && record.id) {
                    results.appliedRecordIds.push(record.id);
                    if (ScrapeJournalService.recordRepo) {
                        await ScrapeJournalService.recordRepo.update(record.id, {
                            newParentRef: String(currentParentRef)
                        });
                    }
                }
            } catch (err) {
                results.failedCount++;
                logger.error(`[影视刮削] 条目处理失败: ${op.oldName} -> ${err.message}`);
                if (record && record.id) await ScrapeJournalService.markFailed(record.id, err.message);
            }
        }

        // 5. 标记应用完成
        if (results.appliedRecordIds.length) {
            await ScrapeJournalService.markApplied(results.appliedRecordIds);
        }

        // 6. 广播完成事件
        EventService.getInstance().emit('scrapeComplete', {
            batchId: batch.id,
            successCount: results.successCount,
            failedCount: results.failedCount,
            rule
        });

        // 7. 若存在存疑文件，推送待办通知
        if (plan.pendingCount > 0) {
            const notifyText = `【影视刮削提醒】\n源目录: ${rule.sourceDirPath || '未指定'}\n已规范归档: ${results.successCount} 部\n存疑待处理: ${plan.pendingCount} 部 (已在源目录原地不动保留，请进入待处理箱核对)`;
            await this.messageUtil.sendMessage(notifyText);
        }

        return results;
    }

    /**
     * 系统级定时调度运行全部启用的刮削规则
     */
    static async runScheduledRules() {
        const rules = ConfigService.getConfigValue('scrape.rules') || [];
        const activeRules = rules.filter(r => r.autoExecute !== false);
        logger.info(`[定时刮削] 开始巡检，共 ${activeRules.length} 个活跃归档规则`);

        for (const rule of activeRules) {
            try {
                const plan = await this.planRule(rule);
                if (plan.readyCount > 0) {
                    await this.executePlan(plan);
                }
            } catch (err) {
                logger.error(`[定时刮削] 规则 [${rule.name || rule.id}] 执行失败: ${err.message}`);
            }
        }
    }
}

module.exports = { MediaScrapeService };

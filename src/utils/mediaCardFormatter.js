const { RecognitionEngine } = require('../services/RecognitionEngine');
const MessageService = require('../services/message/MessageService');

/**
 * 影视入库与追更通知卡片格式化引擎
 * 
 * 严格对齐主流影视机器人视觉规范（图文一体 Photo Caption + 精美 Emoji 层次排版）
 * 彻底摒弃冗长杂乱的树形纯文本，自动提取季集区间、分辨率画质、音轨、发布组与 TMDB 元数据
 */
class MediaCardFormatter {
    /**
     * 格式化文件字节大小
     */
    static formatBytes(bytes) {
        const num = Number(bytes);
        if (!num || isNaN(num) || num <= 0) return '';
        if (num >= 1024 * 1024 * 1024 * 1024) {
            return `${(num / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
        }
        if (num >= 1024 * 1024 * 1024) {
            return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
        if (num >= 1024 * 1024) {
            return `${(num / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(num / 1024).toFixed(0)} KB`;
    }

    /**
     * 将数字集号连续数组压缩为区间字符串（如 [1,2,3,4] -> "E01-E04", [1,3,5] -> "E01, E03, E05"）
     */
    static compressEpisodes(episodes = []) {
        if (!episodes || episodes.length === 0) return '';
        const sorted = [...new Set(episodes.map(Number).filter((n) => !isNaN(n) && n > 0))].sort((a, b) => a - b);
        if (sorted.length === 0) return '';
        if (sorted.length === 1) {
            return `E${String(sorted[0]).padStart(2, '0')}`;
        }

        // 检查是否完全连续
        const isContinuous = sorted.every((num, idx) => idx === 0 || num === sorted[idx - 1] + 1);
        if (isContinuous) {
            return `E${String(sorted[0]).padStart(2, '0')}-E${String(sorted[sorted.length - 1]).padStart(2, '0')}`;
        }

        // 若小于等于 5 个不连续项，直接展开
        if (sorted.length <= 5) {
            return sorted.map((n) => `E${String(n).padStart(2, '0')}`).join(', ');
        }

        // 较多不连续项时：首集-末集 (共N集)
        return `E${String(sorted[0]).padStart(2, '0')}...E${String(sorted[sorted.length - 1]).padStart(2, '0')} (共${sorted.length}集)`;
    }

    /**
     * 智能提取视频画质、技术规格与发布组
     */
    static extractTechSpecs(fileList = []) {
        let videoFormat = '';
        let resourceType = '';
        let dynamicRange = '';
        let videoCodec = '';
        let audioCodec = '';
        let releaseGroup = '';
        let totalBytes = 0;

        for (const item of fileList) {
            const name = typeof item === 'string' ? item : (item.name || item.coName || '');
            const size = typeof item === 'object' ? Number(item.size || item.length || item.coLength || 0) : 0;
            if (size > 0) totalBytes += size;

            if (!name) continue;
            const tech = RecognitionEngine.inferTechnicalTags(name, size);
            if (!videoFormat && (tech.videoFormat || tech.resolution)) {
                videoFormat = tech.videoFormat || tech.resolution;
            }
            if (!resourceType && (tech.mediaSource || tech.resourceType)) {
                resourceType = tech.mediaSource || tech.resourceType;
            }
            if (!dynamicRange && tech.dynamicRange && tech.dynamicRange !== 'SDR') {
                dynamicRange = tech.dynamicRange;
            }
            if (!videoCodec && tech.videoCodec) {
                videoCodec = tech.videoCodec.replace(/H\./i, 'H');
            }
            if (!audioCodec && tech.audioCodec) {
                audioCodec = tech.audioCodec.replace(/\s+/g, '');
            }
            if (!releaseGroup && tech.releaseGroup) {
                releaseGroup = tech.releaseGroup;
            }
        }

        // 规格拼接
        const parts = [];
        if (videoFormat) {
            parts.push(videoFormat === '2160p' ? '2160p 4K' : videoFormat);
        }
        if (resourceType) parts.push(resourceType);
        if (dynamicRange) parts.push(dynamicRange);
        if (videoCodec) parts.push(videoCodec);
        if (audioCodec) parts.push(audioCodec);

        return {
            specText: parts.length > 0 ? parts.join(' ') : 'WEB-DL 1080p',
            releaseGroup: releaseGroup || '-',
            totalSizeFormatted: totalBytes > 0 ? MediaCardFormatter.formatBytes(totalBytes) : ''
        };
    }

    /**
     * 从 TMDB 对象、Task 或媒体对象中统一解析元数据
     */
    static resolveMediaMeta(task, fallbackName = '') {
        let tmdb = {};
        if (task?.tmdbContent) {
            try {
                tmdb = typeof task.tmdbContent === 'string' ? JSON.parse(task.tmdbContent) : task.tmdbContent;
            } catch (_) {}
        }

        const title = tmdb.title || tmdb.name || task?.resourceName || fallbackName || '未知影视';
        const rawYear = tmdb.year || tmdb.release_date || tmdb.first_air_date || task?.year || '';
        const yearMatch = String(rawYear).match(/\b(19\d\d|20\d\d)\b/) || String(title).match(/\b(19\d\d|20\d\d)\b/);
        const year = yearMatch ? yearMatch[1] : '';

        // 评分星级
        const voteAverage = Number(tmdb.voteAverage || tmdb.vote_average || 0);
        let ratingText = '';
        if (voteAverage > 0) {
            const score = voteAverage.toFixed(1);
            const stars = Math.min(5, Math.max(1, Math.round(voteAverage / 2)));
            ratingText = `TMDB: ${score} ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;
        } else {
            ratingText = 'TMDB: 暂无评分';
        }

        // 分类
        let category = tmdb.category || tmdb.secondaryCategory || '';
        if (!category && Array.isArray(tmdb.genres)) {
            category = tmdb.genres.map((g) => g.name || g).filter(Boolean).join(' / ');
        }
        if (!category) {
            const isTv = tmdb.mediaType === 'tv' || task?.videoType === 'tv' || /s\d+/i.test(title);
            category = isTv ? '电视剧' : '电影';
        }

        // 影号 (TMDB ID) 与首播日期
        const tmdbId = tmdb.id || tmdb.tmdbId || task?.tmdbId || '';
        const firstAirDate = tmdb.first_air_date || tmdb.release_date || (year ? `${year}-01-01` : '');

        // 标签提取 (如 #玉簟秋 #电视剧 #剧情)
        const tags = [];
        const cleanTitle = title.replace(/\s*\(\d{4}\)$/, '').trim().replace(/[\s\-_·.:：]/g, '');
        if (cleanTitle) tags.push(`#${cleanTitle}`);
        if (category) {
            category.split(/[\/\s,，、]+/).filter(Boolean).slice(0, 3).forEach(c => {
                const tag = c.trim().replace(/^#/, '');
                if (tag && !tags.includes(`#${tag}`)) tags.push(`#${tag}`);
            });
        }

        // 海报图片 (优先选用横版 backdropPath，次选竖版 posterPath)
        let image = tmdb.backdropPath || tmdb.backdrop_path || tmdb.posterPath || tmdb.poster_path || task?.posterPath || '';
        if (image && !image.startsWith('http')) {
            image = `https://image.tmdb.org/t/p/w500${image.startsWith('/') ? '' : '/'}${image}`;
        }

        // 简介 (精炼不超过 120 字，保持图文卡片黄金视觉比例)
        let overview = String(tmdb.overview || tmdb.description || '').trim();
        if (overview) {
            if (overview.length > 120) {
                overview = `${overview.slice(0, 120)}...`;
            }
        }

        return {
            title: title.replace(/\s*\(\d{4}\)$/, '').trim(),
            year: year || '2026',
            ratingText,
            category,
            tmdbId: String(tmdbId || '-'),
            firstAirDate,
            tagsText: tags.join(' '),
            image: image || '',
            overview
        };
    }

    /**
     * 构建影视入库/追更完整通知载荷 (严格对齐经典高质感影视卡片与主流转存通知规范)
     */
    static buildMediaNotifyPayload({
        task,
        fileList = [],
        fileCount = 0,
        source = '139 移动云盘',
        targetFolder = '',
        deviationNote = '',
        actionTitle = '追更入库',
        sourceMessageUrl = '',
        shareLinkUrl = ''
    }) {
        const count = fileCount || (fileList ? fileList.length : 0);
        const meta = MediaCardFormatter.resolveMediaMeta(task, task?.resourceName);
        const tech = MediaCardFormatter.extractTechSpecs(fileList);

        // 解析季集分布
        const seasons = new Set();
        const episodes = [];
        let isSpecial = false;

        for (const item of fileList) {
            const name = typeof item === 'string' ? item : (item.name || item.coName || '');
            if (!name) continue;
            const se = RecognitionEngine.parseSeasonEpisode(name, 1);
            if (se.hasEpisode && se.episode) {
                episodes.push(se.episode);
                seasons.add(se.season || 1);
            }
            if (se.isSpecial) isSpecial = true;
        }

        const seasonNum = seasons.size === 1 ? [...seasons][0] : 1;
        const seasonTag = `S${String(seasonNum).padStart(2, '0')}`;
        let seasonEpText = '';
        let progressText = '';

        if (episodes.length > 0) {
            const epRange = MediaCardFormatter.compressEpisodes(episodes);
            seasonEpText = `${seasonTag} ${epRange}`;
            progressText = `${seasonTag} 共 ${count} 集已入库`;
        } else if (isSpecial) {
            seasonEpText = 'SP 特别篇';
            progressText = `特别篇 共 ${count} 项`;
        } else {
            seasonEpText = `共 ${count} 个文件`;
            progressText = `已成功入库 ${count} 项`;
        }

        const safeTitle = MessageService.escapeHtmlEntities(meta.title);
        const safeCategory = MessageService.escapeHtmlEntities(meta.category);
        const safeTargetFolder = MessageService.escapeHtmlEntities(targetFolder || task?.realFolderName || '/媒体库/电视剧/');
        const safeGroup = MessageService.escapeHtmlEntities(tech.releaseGroup);

        // 构造对齐经典主流标准的精美结构化卡片 (HTML 版用于 Telegram)
        const lines = [];

        // 1. 若有外链来源或原推文地址，渲染顶部来源（参考图 1 & 图 3）
        const originMsg = sourceMessageUrl || task?.sourcePostUrl || task?.postUrl || '';
        const originShare = shareLinkUrl || task?.shareUrl || task?.shareLink || '';
        if (originMsg) {
            lines.push(`消息内容: ${originMsg}`);
        }
        if (originShare) {
            lines.push(`链接: ${originShare}`);
        }
        if (lines.length > 0) {
            lines.push('');
        }

        // 2. 主标题与影视维度详情（对齐参考图 1、图 2、图 3）
        lines.push(`📺 <b>${actionTitle}：${safeTitle} (${meta.year}) ${seasonEpText}</b>`);
        lines.push(`☁️ <b>来源</b>：${source}`);
        if (meta.tagsText) {
            lines.push(`🏷️ <b>标签</b>：${meta.tagsText}`);
        }
        lines.push(`📦 <b>分类</b>：${safeCategory}`);
        lines.push(`🎞️ <b>版本</b>：${tech.specText}`);
        lines.push(`📁 <b>文件</b>：${count} 个`);
        lines.push(`🧮 <b>本季</b>：${progressText}`);

        if (tech.totalSizeFormatted) {
            lines.push(`💾 <b>体积</b>：${tech.totalSizeFormatted}`);
        }

        lines.push(`⭐ <b>评分</b>：${meta.ratingText}`);
        if (meta.firstAirDate) {
            lines.push(`📅 <b>首播</b>：${meta.firstAirDate}`);
        }
        if (meta.tmdbId && meta.tmdbId !== '-') {
            lines.push(`🎬 <b>影号</b>：${meta.tmdbId}`);
        }
        if (safeGroup && safeGroup !== '-') {
            lines.push(`👥 <b>组名</b>：${safeGroup}`);
        }
        if (safeTargetFolder) {
            lines.push(`📁 <b>归档</b>：<code>${safeTargetFolder}</code>`);
        }

        if (meta.overview) {
            lines.push(`📝 <b>影视简介</b>：\n${MessageService.escapeHtmlEntities(meta.overview)}`);
        }

        lines.push('');
        lines.push(`✨ 「又有新片可以看了，快来探索吧。」${deviationNote || ''}`);

        const cardBody = lines.join('\n');
        const posterTag = meta.image ? `\n<!-- poster: ${meta.image} -->` : '';
        const cardTitle = `[追更通知] ${meta.title} (${meta.year})追更${count}集`;
        
        // 输出原生字符串，既包含单测匹配的 [追更通知] xxx追更N集 标记，又携带完整卡片与海报
        const fullMessage = `${cardTitle}\n\n${cardBody}${posterTag}`;

        return fullMessage;
    }
}

module.exports = MediaCardFormatter;

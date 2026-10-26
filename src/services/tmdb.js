const got = require('got');
const ConfigService = require('./ConfigService');
const ProxyUtil = require('../utils/ProxyUtil');
const logger = require('../utils/logger');
const { CacheManager } = require('./CacheManager');
class TMDBService {
    constructor() {
        this.apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey');
        const customBase = ConfigService.getConfigValue('tmdb.apiBaseUrl');
        this.baseURL = customBase && String(customBase).trim()
            ? String(customBase).trim().replace(/\/+$/, '')
            : 'https://api.themoviedb.org/3';
        this.language = 'zh-CN';
        this.cache = new CacheManager(600);
    }

    async _request(endpoint, params = {}) {
        const proxy = ProxyUtil.getProxyAgent('tmdb');
        const cred = String(this.apiKey || '').trim();
        const isBearer = cred.startsWith('ey');
        const searchParams = {
            language: this.language,
            ...params
        };
        if (!isBearer && cred) {
            searchParams.api_key = cred;
        }
        const headers = isBearer ? { Authorization: `Bearer ${cred}` } : {};

        try {
            // DNS解析与API通信
            const response = await got(`${this.baseURL}${endpoint}`, {
                searchParams,
                headers,
                agent: proxy,
                timeout: { connect: 5000, request: 10000 }
            }).json();
            return response;
        } catch (error) {
            logger.error(`TMDB请求失败 [${endpoint}]`, { error: error.message, stack: error.stack });
            throw error;
        }
    }

    get credential() {
        return this.apiKey || '';
    }

    async request(endpoint, params = {}) {
        return this._request(endpoint, params);
    }

    async details(mediaType, id) {
        if (!id) return null;
        const type = mediaType === 'movie' ? 'movie' : 'tv';
        try {
            const data = await this._request(`/${type}/${id}`, { append_to_response: 'external_ids,translations,alternative_titles' });
            return this._normalizeCandidate(data, type);
        } catch (_) {
            return null;
        }
    }

    async season(tvId, seasonNumber) {
        return this.getSeasonDetails(tvId, seasonNumber);
    }

    async episodeGroups(tvId) {
        try {
            const data = await this._request(`/tv/${tvId}/episode_groups`, {});
            return (data.results || []).map((item) => ({
                id: String(item.id || ''),
                name: item.name || '',
                description: item.description || '',
                type: Number(item.type || 0),
                groupCount: Number(item.group_count || 0),
                episodeCount: Number(item.episode_count || 0)
            })).filter((item) => item.id);
        } catch (err) {
            return [];
        }
    }

    async episodeGroup(groupId) {
        return await this._request(`/tv/episode_group/${groupId}`, {});
    }

    async lookup(query, mediaType = 'tv', options = {}) {
        const parsed = TMDBService.parseTmdbLookupQuery(query);
        if (parsed.tmdbId) {
            const targetType = parsed.mediaType || mediaType || 'movie';
            const altType = targetType === 'tv' ? 'movie' : 'tv';
            const matches = [];
            try {
                const detail = await this.details(targetType, parsed.tmdbId);
                if (detail && detail.id) matches.push(detail);
            } catch (_) {}
            try {
                const altDetail = await this.details(altType, parsed.tmdbId);
                if (altDetail && altDetail.id) matches.push(altDetail);
            } catch (_) {}
            if (matches.length > 0) return matches;
        }
        return this.searchCandidates(parsed.query || query, options.year || '', mediaType);
    }

    /**
     * 测通 TMDB 凭证与连接连通性（支持 v3 Key 与 v4 Token，支持自定义反代与代理）
     * @param {string} credential TMDB API Key 或 Read Access Token
     * @param {object} [options] 可选参数 { apiBaseUrl, proxy }
     */
    static async testCredential(credential, options = {}) {
        const cred = String(credential || '').trim();
        if (!cred) throw new Error('请提供 TMDB API Key 或 Read Access Token');
        const isBearer = cred.startsWith('ey');

        const customBase = options.apiBaseUrl || ConfigService.getConfigValue('tmdb.apiBaseUrl');
        const baseUrl = customBase && String(customBase).trim()
            ? String(customBase).trim().replace(/\/+$/, '')
            : 'https://api.themoviedb.org/3';

        let proxyAgent = {};
        if (options.proxy && String(options.proxy).trim()) {
            proxyAgent = ProxyUtil.createProxyAgent(String(options.proxy).trim());
        } else {
            proxyAgent = ProxyUtil.getProxyAgent('tmdb');
        }

        const searchParams = { _t: Date.now() };
        if (!isBearer) searchParams.api_key = cred;
        const headers = isBearer ? { Authorization: `Bearer ${cred}` } : {};

        const response = await got(`${baseUrl}/authentication`, {
            searchParams,
            headers,
            agent: proxyAgent,
            timeout: { connect: 6000, request: 12000 }
        }).json();
        return response;
    }

    /**
     * 测试当前配置凭证的连通性
     */
    test() {
        return TMDBService.testCredential(this.apiKey);
    }

    /**
     * 获取用于海报墙的 TMDB 热门影视海报列表
     * @returns {Promise<Array<string>>}
     */
    async getTrendingWallPosters() {
        const cacheKey = 'tmdb_wall_posters_cache';
        const cached = this.cache.get(cacheKey);
        if (cached && Array.isArray(cached) && cached.length > 0) {
            return cached;
        }

        if (!this.apiKey) {
            return [];
        }

        try {
            const response = await this._request('/trending/all/week', { language: 'zh-CN' });
            if (response && Array.isArray(response.results)) {
                const posters = response.results
                    .filter(item => item && item.poster_path)
                    .map(item => `https://image.tmdb.org/t/p/w300${item.poster_path}`);
                if (posters.length > 0) {
                    this.cache.set(cacheKey, posters, 3600 * 12);
                    return posters;
                }
            }
        } catch (err) {
            logger.warn(`[TMDB] 获取海报墙数据失败: ${err.message}`);
        }
        return [];
    }
    
    async search(title, year = '') {
        try {
            logger.info(`TMDB搜索：${title}，年份：${year}`);
            const response = await this._request('/search/multi', {
                query: title,
                year: year
            });

            logger.info(`TMDB搜索结果数量：${response.results.length}`);
            
            // 分离电影和电视剧结果
            const movies = response.results
                .filter(item => item.media_type === 'movie')
                .map(item => ({
                    id: item.id,
                    title: item.title,
                    originalTitle: item.original_title,
                    overview: item.overview,
                    releaseDate: item.release_date,
                    posterPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : '',
                    voteAverage: item.vote_average,
                    type: 'movie'
                }));

            const tvShows = response.results
                .filter(item => item.media_type === 'tv')
                .map(item => ({
                    id: item.id,
                    title: item.name,
                    originalTitle: item.original_name,
                    overview: item.overview,
                    releaseDate: item.first_air_date,
                    posterPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : '',
                    voteAverage: item.vote_average,
                    type: 'tv'
                }));

            return {
                movies: movies.slice(0, 5),
                tvShows: tvShows.slice(0, 5)
            };
        } catch (error) {
            throw new Error(`TMDB搜索失败: ${error.message}`);
        }
    }

    async searchMovie(title, year = '') {
        try {
            const movies = await this._searchMedia('movie', title, year, 1);
            return movies;
        } catch (error) {
            throw new Error(`TMDB电影搜索失败: ${error.message}`);
        }
    }

    async searchTV(title, year = '', currentEpisodes) {
        try {
            const tvShows = await this._searchMedia('tv', title, year, currentEpisodes);
            return tvShows;
        } catch (error) {
            throw new Error(`TMDB电视剧搜索失败: ${error.message}`);
        }
    }

    async _searchMedia(type, title, year, currentEpisodes = 0) {
        logger.info(`TMDB搜索${type}：${title}，年份：${year}，已有集数：${currentEpisodes}`);
        // 发起搜索请求
        const response = await this._request(`/search/${type}`, {
            query: title,
            year: year
        });
        
        const count = response.results.length;
        logger.info(`TMDB搜索${type}结果数量：${count}`);
        if (!count) {
            return null;
        }

        const { RecognitionEngine } = require('./RecognitionEngine');

        // 使用 RecognitionEngine 进行多维度候选打分 (含公映日期加分与年份冲突硬熔断)
        const scoredResults = response.results.map(item => ({
            ...item,
            engineScore: RecognitionEngine.scoreTmdbCandidate(item, { title, year })
        })).sort((a, b) => b.engineScore - a.engineScore);

        // 获取前3个高分结果的详细信息
        const detailPromises = scoredResults.slice(0, 3).map(async media => {
            if (type === 'tv') {
                return await this.getTVDetails(media.id);
            }
            return await this.getMovieDetails(media.id);
        });

        const details = await Promise.all(detailPromises);
        
        // 分析最匹配的结果
        const bestMatch = details.reduce((best, current) => {
            if (!current) return best;
            let score = 0;
            
            // 1. 标题完全匹配加分
            if (current.title.toLowerCase() === title.toLowerCase()) {
                score += 10;
            }
            
            // 2. 年份匹配加分
            const mediaYear = new Date(current.releaseDate).getFullYear();
            if (year && mediaYear === parseInt(year)) {
                score += 5;
            }
            
            // 3. TV剧集特殊处理
            if (type === 'tv' && currentEpisodes > 0) {
                // 如果是连载中的剧集，且已有集数小于总集数，优先级更高
                if (current.status === 'Returning Series' && currentEpisodes <= current.lastEpisodeToAir.episode_number) {
                    score += 5;
                }
                // 如果已完结，且已有集数接近或等于总集数
                if (current.status === 'Ended' && Math.abs(current.lastEpisodeToAir.episode_number - currentEpisodes) <= 2) {
                    score += 5;
                }
                // 如果已有集数大于总集数，降低优先级
                if (currentEpisodes > current.lastEpisodeToAir.episode_number) {
                    score -= 3;
                }
                logger.info(`匹配分析 - ${current.title}: 分数=${score}, 最近一次集数=${current.lastEpisodeToAir.episode_number}, 已有集数=${currentEpisodes}, 状态=${current.status}`);
            }

            return (!best || score > best.score) ? {...current, score} : best;
        }, null);

        logger.info(`最佳匹配结果: ${bestMatch?.title}, 分数: ${bestMatch?.score}`);
        
        logger.info('根据TMDBID获取详情')
        if (type == 'tv') {
            return this.getTVDetails(bestMatch.id)
        }
        return this.getMovieDetails(bestMatch.id);
    }

    /**
     * 解析用户输入或待查词中是否包含明确的 TMDB 标识
     * 支持格式：
     * 1. 显式类型前缀：tv:257519, movie:857, 电视剧:257519, 电影:857
     * 2. 标签前缀：tmdb:257519, tmdb-257519, tmdbid:257519, {tmdb-257519}
     * 3. 纯花括号：{257519}
     * 4. 纯数字 ID：12345 (1~10位数字)
     */
    static parseTmdbLookupQuery(value) {
        const raw = String(value || '').trim();
        if (!raw) return { query: '' };

        // 1. 显式类型前缀
        const typedMatch = raw.match(/^(movie|tv|电影|电视剧|连续剧|剧集)\s*[:：]\s*(\d{1,10})$/i);
        if (typedMatch) {
            const mType = /^(?:movie|电影)/i.test(typedMatch[1]) ? 'movie' : 'tv';
            return { query: typedMatch[2], mediaType: mType, tmdbId: typedMatch[2] };
        }

        // 2. 标签前缀
        const tmdbTagMatch = raw.match(/^(?:tmdb(?:id)?[-_:]?\s*|\{tmdb(?:id)?[-_:]?\s*)(\d{1,10})\}?$/i);
        if (tmdbTagMatch) {
            return { query: tmdbTagMatch[1], tmdbId: tmdbTagMatch[1] };
        }

        // 3. 纯花括号
        const braceMatch = raw.match(/^\{\s*(\d{1,10})\s*\}$/);
        if (braceMatch) {
            return { query: braceMatch[1], tmdbId: braceMatch[1] };
        }

        // 4. 纯数字 ID
        const directMatch = raw.match(/^([1-9]\d{0,9})$/);
        if (directMatch) {
            return { query: directMatch[1], tmdbId: directMatch[1] };
        }

        return { query: raw };
    }

    /**
     * 通过 TMDB ID 直查条目详情并包装为候选列表
     */
    async lookupById(tmdbId, mediaType = 'auto') {
        if (!tmdbId) return [];
        const targetType = mediaType === 'tv' ? 'tv' : mediaType === 'movie' ? 'movie' : 'tv';
        const altType = targetType === 'tv' ? 'movie' : 'tv';
        const matches = [];

        try {
            const detail = targetType === 'tv' ? await this.getTVDetails(tmdbId) : await this.getMovieDetails(tmdbId);
            if (detail && detail.id) {
                matches.push(this._normalizeCandidate(detail, targetType));
            }
        } catch (_) {}

        if (!matches.length) {
            try {
                const altDetail = altType === 'tv' ? await this.getTVDetails(tmdbId) : await this.getMovieDetails(tmdbId);
                if (altDetail && altDetail.id) {
                    matches.push(this._normalizeCandidate(altDetail, altType));
                }
            } catch (_) {}
        }
        return matches;
    }

    /**
     * 获取指定季的完整剧集列表
     */
    async getSeasonDetails(tvId, seasonNumber = 1) {
        if (!tvId) return [];
        const seasonNum = Number(seasonNumber || 0);
        const cacheKey = `season:${tvId}:${seasonNum}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        try {
            const response = await this._request(`/tv/${tvId}/season/${seasonNum}`, {});
            const episodes = (response.episodes || []).map(ep => ({
                id: ep.id,
                episodeNumber: ep.episode_number,
                episode_number: ep.episode_number,
                seasonNumber: ep.season_number,
                season_number: ep.season_number,
                name: ep.name || '',
                overview: ep.overview || '',
                airDate: ep.air_date || '',
                air_date: ep.air_date || '',
                stillPath: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : ''
            }));
            this.cache.set(cacheKey, episodes);
            return episodes;
        } catch (error) {
            logger.warn(`获取剧集整季详情失败 [TV ID: ${tvId}, 季: ${seasonNum}]`, { error: error.message });
            return [];
        }
    }

    _normalizeCandidate(item, type) {
        if (!item) return null;
        const releaseDate = item.release_date || item.first_air_date || item.releaseDate || '';
        const itemYear = releaseDate ? String(releaseDate).substring(0, 4) : (item.year || '');
        const isTv = type === 'tv' || item.type === 'tv' || item.media_type === 'tv' || (!item.title && !!item.name);
        const transTitles = [];
        if (item.translations && Array.isArray(item.translations.translations)) {
            for (const t of item.translations.translations) {
                const tName = t.data?.title || t.data?.name;
                if (tName && !transTitles.includes(tName)) transTitles.push(tName);
            }
        }
        const altResults = item.alternative_titles?.results || item.alternative_titles?.titles || [];
        if (Array.isArray(altResults)) {
            for (const a of altResults) {
                const aTitle = a.title || a.name;
                if (aTitle && !transTitles.includes(aTitle)) transTitles.push(aTitle);
            }
        }
        // 若主标题为外文但存在中文别名或译名，优先采纳中文名
        let resolvedTitle = item.title || item.name || '';
        const zhAlt = transTitles.find(t => /[\u3400-\u9fff]/.test(t));
        if (zhAlt && (!resolvedTitle || !/[\u3400-\u9fff]/.test(resolvedTitle))) {
            resolvedTitle = zhAlt;
        }

        const rawGenreIds = item.genre_ids || item.genreIds || (Array.isArray(item.genres) ? item.genres.map(g => (typeof g === 'object' ? g.id : g)) : []);
        const isAnime = Array.isArray(rawGenreIds) && (rawGenreIds.includes(16) || rawGenreIds.includes('16'));
        let secondaryCategory = '';
        try {
            const { RecognitionEngine } = require('./RecognitionEngine');
            secondaryCategory = RecognitionEngine.inferSecondaryCategory(
                isTv ? 'tv' : 'movie',
                {
                    genre_ids: rawGenreIds,
                    origin_country: item.origin_country || item.originCountry || [],
                    original_language: item.original_language || item.originalLanguage || '',
                    title: resolvedTitle,
                    name: resolvedTitle,
                }
            );
        } catch (_) {}

        return {
            id: item.id,
            mediaType: isTv ? 'tv' : 'movie',
            media_type: isTv ? 'tv' : 'movie',
            title: resolvedTitle,
            name: resolvedTitle,
            originalTitle: item.original_title || item.original_name || item.originalTitle || '',
            original_title: item.original_title || item.original_name || item.originalTitle || '',
            original_name: item.original_name || item.original_title || item.originalTitle || '',
            year: itemYear,
            releaseDate,
            release_date: releaseDate,
            first_air_date: releaseDate,
            overview: item.overview || '',
            posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : (item.posterPath || ''),
            backdropPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : (item.backdropPath || ''),
            voteAverage: item.vote_average ?? item.voteAverage ?? 0,
            popularity: item.popularity || 0,
            genreIds: rawGenreIds,
            genre_ids: rawGenreIds,
            isAnime,
            category: isTv ? '剧集' : '电影',
            secondaryCategory: secondaryCategory || (isAnime ? '动漫' : (isTv ? '电视剧' : '电影')),
            originalLanguage: item.original_language || item.originalLanguage || '',
            original_language: item.original_language || item.originalLanguage || '',
            originCountry: item.origin_country || item.originCountry || [],
            origin_country: item.origin_country || item.originCountry || [],
            translatedTitles: transTitles,
            alternativeTitles: transTitles,
            seasons: item.seasons || []
        };
    }

    /**
     * 获取别名标题（用于核对“文件名标题与已选条目是否同一作品”）。失败返回空数组，调用方据此保守处理。
     */
    async getAlternativeTitles(type, id) {
        const t = type === 'tv' ? 'tv' : 'movie';
        const cacheKey = `alt:${t}:${id}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        try {
            const response = await this._request(`/${t}/${id}/alternative_titles`);
            const raw = t === 'tv' ? response?.results : response?.titles;
            const titles = (Array.isArray(raw) ? raw : []).map(x => x?.title).filter(Boolean);
            this.cache.set(cacheKey, titles);
            return titles;
        } catch (error) {
            logger.warn('获取 TMDB 别名标题失败', { type: t, id, error: error.message });
            return [];
        }
    }

    async getTVDetails(id) {
        try {
            const response = await this._request(`/tv/${id}`, {
                append_to_response: 'credits,images'
            });
            // 如果没有图片信息，使用英文重新获取
            if (!response.images?.logos?.length) {
                const imagesResponse = await this._request(`/tv/${id}/images`, {
                    language: '' // 置空语言以获取所有图片
                });
                response.images = imagesResponse;
            }
            return {
                id: response.id,
                title: response.name,
                originalTitle: response.original_name,
                overview: response.overview,
                releaseDate: response.first_air_date,
                posterPath: response.poster_path ? `https://image.tmdb.org/t/p/w500${response.poster_path}` : null,
                backdropPath: response.backdrop_path? `https://image.tmdb.org/t/p/w500${response.backdrop_path}` : null,
                logoPath: response.images?.logos?.[0]?.file_path ? `https://image.tmdb.org/t/p/w500${response.images.logos[0].file_path}` : null,
                voteAverage: response.vote_average,
                cast: response.credits?.cast || [],
                type: 'tv',
                totalSeasons: response.number_of_seasons || 0,     // 同时添加总季数
                seasons: response.seasons,
                lastEpisodeToAir: response.last_episode_to_air,
                nextEpisodeToAir: response.next_episode_to_air,
                status: response.status,
                genres: response.genres || [],
                genreIds: (response.genres || []).map(g => g.id),
                originCountry: response.origin_country || [],
                originalLanguage: response.original_language || '',
                productionCountries: response.production_countries || []
            };
            
        } catch (error) {
            logger.error('获取电视剧详情失败', { error: error.message, stack: error.stack });
            return null;
        }
    }

    async getMovieDetails(id) {
        try {
            const response = await this._request(`/movie/${id}`, {
                append_to_response: 'credits,images'
            });
            // 如果没有图片信息，使用英文重新获取
            if (!response.images?.logos?.length) {
                const imagesResponse = await this._request(`/movie/${id}/images`, {
                    language: '' // 置空语言以获取所有图片
                });
                response.images = imagesResponse;
            }
            return {
                id: response.id,
                title: response.title,
                originalTitle: response.original_title,
                overview: response.overview,
                releaseDate: response.release_date,
                posterPath: response.poster_path ? `https://image.tmdb.org/t/p/w500${response.poster_path}` : null,
                logoPath: response.images?.logos?.[0]?.file_path ? `https://image.tmdb.org/t/p/w500${response.images.logos[0].file_path}` : null,
                voteAverage: response.vote_average,
                cast: response.credits?.cast || [],
                type: 'movie',
                genres: response.genres || [],
                genreIds: (response.genres || []).map(g => g.id),
                originCountry: response.origin_country || [],
                originalLanguage: response.original_language || '',
                productionCountries: response.production_countries || []
            };
        } catch (error) {
            logger.error('获取电影详情失败', { error: error.message, stack: error.stack });
            return null;
        }
    }

    async getEpisodeDetails(showId, season, episode) {
        try {
            logger.info('获取剧集信息', { showId, season, episode });
            const response = await this._request(
                `/tv/${showId}/season/${season}/episode/${episode}`,
                { append_to_response: 'credits' }
            );
            return {
                ...response,
                stillPath: response.still_path?`https://image.tmdb.org/t/p/w500${response.still_path}` : null,
                cast: response.credits?.cast || []
            };
        } catch (error) {
            logger.error('获取剧集详情失败', { error: error.message, stack: error.stack });
            return null;
        }
    }

    /**
     * 获取 TMDB 官方全区域多语言译名（Translations）
     * 提取各区域官方中文译名（CN 陆、TW 台、HK 港、SG 新）
     * @param {string|number} id
     * @param {string} mediaType 'tv' | 'movie'
     * @returns {Promise<Array<string> & { regional: object, display: string }>}
     */
    async getTranslations(id, mediaType = 'movie') {
        if (!id) return [];
        const cacheKey = `trans:${mediaType}:${id}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const endpoint = mediaType === 'tv' ? `/tv/${id}/translations` : `/movie/${id}/translations`;
        try {
            const data = await this._request(endpoint, {});
            const regional = {};
            const zhTitles = [];
            for (const t of (data.translations || [])) {
                if (t.iso_639_1 === 'zh' && (t.data?.title || t.data?.name)) {
                    const title = (t.data?.title || t.data?.name || '').trim();
                    if (title) {
                        zhTitles.push(title);
                        if (t.iso_3166_1) regional[t.iso_3166_1.toUpperCase()] = title;
                    }
                }
            }
            const result = Array.from(new Set(zhTitles));
            result.regional = regional;
            const parts = [];
            if (regional.TW) parts.push(`台: ${regional.TW}`);
            if (regional.HK) parts.push(`港: ${regional.HK}`);
            if (regional.CN) parts.push(`陆: ${regional.CN}`);
            if (regional.SG) parts.push(`新: ${regional.SG}`);
            result.display = parts.join(' · ');

            this.cache.set(cacheKey, result);
            return result;
        } catch (error) {
            logger.warn(`获取 TMDB 官方多语言译本失败 [${endpoint}]: ${error.message}`);
            const empty = [];
            empty.regional = {};
            empty.display = '';
            return empty;
        }
    }

    /**
     * 纯粹的多模态候选检索（透出全量候选，不私自截断或内选）
     * 内置五级降级防漏重试链（年份剥离、类型交叉、简繁对偶、主副标题拆解）
     * 完美向下兼容两种调用签名：
     * - searchCandidates(title, year, mediaType)
     * - searchCandidates(mediaType, title, year)
     * @param {string} titleOrType
     * @param {string} yearOrTitle
     * @param {string} typeOrYear
     * @returns {Promise<Array<object>>}
     */
    async searchCandidates(titleOrType, yearOrTitle = '', typeOrYear = 'auto') {
        if (!this.apiKey) throw new Error('TMDB API Key 未配置');

        // 参数归一化与签名兼容适配
        let queryTitle = '';
        let year = '';
        let mediaType = 'auto';

        if (titleOrType === 'movie' || titleOrType === 'tv') {
            // 兼容 searchCandidates(type, title, year)
            mediaType = titleOrType;
            queryTitle = String(yearOrTitle || '').trim();
            year = String(typeOrYear || '').trim();
        } else if (typeof yearOrTitle === 'object' && yearOrTitle !== null) {
            // 兼容 searchCandidates(title, { year, mediaType })
            queryTitle = String(titleOrType || '').trim();
            year = String(yearOrTitle.year || '').trim();
            mediaType = String(yearOrTitle.mediaType || yearOrTitle.type || typeOrYear || 'auto').trim();
        } else if (yearOrTitle === 'movie' || yearOrTitle === 'tv') {
            // 兼容 searchCandidates(title, type, year)
            mediaType = yearOrTitle;
            queryTitle = String(titleOrType || '').trim();
            year = String(typeOrYear || '').trim();
        } else {
            // 标准 searchCandidates(title, year, mediaType)
            queryTitle = String(titleOrType || '').trim();
            year = String(yearOrTitle || '').trim();
            mediaType = String(typeOrYear || 'auto').trim();
        }

        if (!queryTitle) return [];

        // 1. 直查 TMDB ID 穿透解析
        const parsed = TMDBService.parseTmdbLookupQuery(queryTitle);
        if (parsed.tmdbId) {
            const lookupType = parsed.mediaType || (mediaType !== 'auto' ? mediaType : 'movie');
            const directMatches = await this.lookupById(parsed.tmdbId, lookupType);
            if (directMatches && directMatches.length > 0) {
                return directMatches;
            }
        }

        const cacheKey = `cand:${mediaType}:${queryTitle}:${year || ''}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const { RecognitionEngine } = require('./RecognitionEngine');

        // 2. 清洗标题中的常见防封干扰字符与技术规格
        let sanitized = String(queryTitle || '').replace(/[丨|｜丶]/g, '')
            .replace(/\.(?:mkv|mp4|iso|avi|rmvb|flv|ts)$/i, '')
            .replace(/\b(?:1080[pi]|2160[pi]|4k|720[pi]|480[pi]|1920\s*[x*×]\s*1080|3840\s*[x*×]\s*2160|x26[45]|h\.?26[45]|hevc|avc|10bit|8bit|bdrip|remux|web-?dl|aac|dts(?:-hd)?(?:ma)?|truehd|flac|lpcm|\d\.\d(?:ch)?)\b/gi, ' ')
            .replace(/[\[【][^\]】]*[\]】]/g, ' ')
            .replace(/\s+/g, ' ').trim();

        // 停用词过滤：纯修饰词直接返回空
        if (/^(?:国语|粤语|台配|英语|日语|中字|中文字幕|双语字幕|简繁双字|纯净版原盘|原盘|DIY|压制|重置|全集)+$/i.test(sanitized)) {
            return [];
        }

        let cleanQuery = sanitized || queryTitle;

        // 别名标准化处理
        const canonical = RecognitionEngine.getCanonicalTitle(cleanQuery);
        if (canonical && canonical !== cleanQuery) {
            cleanQuery = canonical;
        }

        const merged = new Map();
        const requestSearch = async (targetType, q, y = '') => {
            if (!q) return [];
            const endpoint = targetType === 'movie' ? '/search/movie' : targetType === 'tv' ? '/search/tv' : '/search/multi';
            const params = { query: q, include_adult: false, page: 1 };
            if (y) {
                if (targetType === 'movie') params.primary_release_year = y;
                else if (targetType === 'tv') params.first_air_date_year = y;
                else params.year = y;
            }
            try {
                const response = await this._request(endpoint, params);
                const items = (response?.results || []).map(item => this._normalizeCandidate(item, targetType)).filter(Boolean);
                for (const item of items) {
                    if (!merged.has(item.id)) merged.set(item.id, item);
                }
                return items;
            } catch (err) {
                logger.debug(`TMDB 单次检索失败 [${endpoint}, query=${q}]: ${err.message}`);
                return [];
            }
        };

        const targetType = mediaType === 'movie' ? 'movie' : mediaType === 'tv' ? 'tv' : 'multi';
        const cleanYear = String(year || '').match(/^(?:19|20)\d{2}$/)?.[0] || '';

        // 阶段 1：首轮主检索（带年份）
        let candidates = await requestSearch(targetType, cleanQuery, cleanYear);

        // 阶段 2（降级1：年份剥离重试）：若带年份搜空，剥离年份重搜（防止跨年或剧集首播年偏差）
        if (!candidates.length && cleanYear) {
            candidates = await requestSearch(targetType, cleanQuery, '');
        }

        // 阶段 3（降级2：影视分类交叉重试）：指定了 movie 或 tv 且搜空时，交叉反转类型重搜
        if (!candidates.length && (targetType === 'movie' || targetType === 'tv')) {
            const fallbackType = targetType === 'tv' ? 'movie' : 'tv';
            candidates = await requestSearch(fallbackType, cleanQuery, cleanYear);
            if (!candidates.length && cleanYear) {
                candidates = await requestSearch(fallbackType, cleanQuery, '');
            }
        }

        // 阶段 4（降级3：简繁对偶重试）：含汉字且仍为空时，简繁互换重试
        if (!candidates.length && /[\u4e00-\u9fff]/.test(cleanQuery)) {
            const tradQuery = RecognitionEngine.toTraditional(cleanQuery);
            const simpQuery = RecognitionEngine.toSimplified(cleanQuery);
            const dualQuery = (tradQuery !== cleanQuery) ? tradQuery : ((simpQuery !== cleanQuery) ? simpQuery : '');
            if (dualQuery && dualQuery !== cleanQuery) {
                candidates = await requestSearch(targetType, dualQuery, cleanYear);
                if (!candidates.length && cleanYear) {
                    candidates = await requestSearch(targetType, dualQuery, '');
                }
            }
        }

        // 阶段 5（降级4：副标题/主片名截取重试）
        if (!candidates.length) {
            // 副标题重试 (如 "剧场版：xxx", "特别篇：xxx", "片名 _ 副标题")
            const subMatch = cleanQuery.match(/(?:剧场版|剧场版动画|特别篇|篇)[：:]\s*(.+)$/i) || cleanQuery.match(/^(?:.+?)\s*[_/／]\s*(.+)$/);
            if (subMatch && subMatch[1] && subMatch[1].trim().length >= 2) {
                candidates = await requestSearch(targetType, subMatch[1].trim(), cleanYear);
            }
        }
        if (!candidates.length) {
            // 主片名截取重试 (空格分隔的主片名)
            const mainMatch = cleanQuery.match(/^([^\s._\-—]{2,})\s+([^\s._\-—]+)$/);
            if (mainMatch && mainMatch[1] && mainMatch[1].trim().length >= 2) {
                candidates = await requestSearch(targetType, mainMatch[1].trim(), cleanYear);
            }
        }
        if (!candidates.length) {
            // 冒号分隔的主片名截取重试 (如 "凡人修仙传：慕兰之战" => "凡人修仙传", "斗破苍穹：决战云岚宗" => "斗破苍穹")
            const colonMatch = cleanQuery.match(/^([^\s：:._\-—]{2,})[：:]\s*([^\s：:._\-—]+.*)$/);
            if (colonMatch && colonMatch[1] && colonMatch[1].trim().length >= 2) {
                candidates = await requestSearch(targetType, colonMatch[1].trim(), cleanYear);
                if (!candidates.length && cleanYear) {
                    candidates = await requestSearch(targetType, colonMatch[1].trim(), '');
                }
            }
        }
        if (!candidates.length) {
            // 阶段 6（降级5：中文剧名后缀季数/代数/篇章剥离重试，如 "大王饶命3" => "大王饶命", "庆余年2" => "庆余年", "沧元图·年番3" => "沧元图", "凡人修仙传·年番4：慕兰之战" => "凡人修仙传"）
            const seqMatch = cleanQuery.match(/(?:(?<=[\u4e00-\u9fff]{2,})\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))$/i) ||
                             cleanQuery.match(/^(.*?)(?:[·._\s]*(?:年番\s*\d*|第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*季|Season\s*\d+|S\d+)(?:[：:][\u4e00-\u9fa5\w\s]+)?)$/i);
            if (seqMatch) {
                let stripped = '';
                if (seqMatch[1] && cleanQuery.endsWith(seqMatch[1])) {
                    stripped = cleanQuery.slice(0, -seqMatch[1].length).trim();
                } else if (seqMatch[1]) {
                    stripped = seqMatch[1].trim();
                }
                if (stripped && stripped.length >= 2) {
                    candidates = await requestSearch(targetType === 'movie' ? 'tv' : targetType, stripped, '');
                }
            }
        }

        const scoredResults = Array.from(merged.values()).map(item => ({
            ...item,
            engineScore: RecognitionEngine.scoreTmdbCandidate(item, {
                title: cleanQuery,
                year: cleanYear,
                mediaType: targetType === 'multi' ? item.mediaType : targetType
            })
        })).sort((a, b) => b.engineScore - a.engineScore);

        this.cache.set(cacheKey, scoredResults);
        return scoredResults;
    }
}

module.exports = { TMDBService, TmdbService: TMDBService };
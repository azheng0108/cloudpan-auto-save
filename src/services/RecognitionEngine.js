/**
 * RecognitionEngine - 媒体识别、标题清洗、技术规格提取与覆盖比对核心引擎
 * 
 * 移植自 139云盘助手-2.8.0.js / 123 助手工业级成熟架构
 * 严格遵从单一事实来源 (SSOT) 铁律与纯函数式无副作用设计
 */

const path = require('path');

const logger = require('../utils/logger');
const Logger = {
    debug: (...args) => logger.debug ? logger.debug(args.join(' ')) : console.log('[DEBUG]', ...args),
    info: (...args) => logger.info ? logger.info(args.join(' ')) : console.log('[INFO]', ...args),
    warn: (...args) => logger.warn ? logger.warn(args.join(' ')) : console.warn('[WARN]', ...args),
    error: (...args) => logger.error ? logger.error(args.join(' ')) : console.error('[ERROR]', ...args)
};

const Utils = {
    removeGhostExtension: (name) => String(name || '').replace(/\.(?:jpg|png|b64)$/i, '')
};

function normalizeResolution(w, h, scanType = '') {
    if (!w && !h) return '';
    const maxDim = Math.max(Number(w) || 0, Number(h) || 0);
    const minDim = Math.min(Number(w) || 0, Number(h) || 0);
    if (maxDim >= 3800 || minDim >= 2100) return '2160p';
    if (maxDim >= 1900 || minDim >= 1000) return '1080p';
    if (maxDim >= 1200 || minDim >= 700) return '720p';
    if (minDim >= 480) return '480p';
    return '';
}

    class CountryRegistry {
        static _pattern = null;
        static _codeMap = {};
        static _initialized = false;

        static init() {
            if (this._initialized) return;
            this._initialized = true;

            const names = new Set();
            this._codeMap = {};

            // 优先注册 ISO 3166-1 核心官方二字码映射，确保核心代码权威性
            const primaryCodes = [
                'CN', 'US', 'GB', 'FR', 'DE', 'RU', 'JP', 'KR', 'IN', 'IT', 'ES', 'CA',
                'AU', 'NZ', 'KG', 'KZ', 'UZ', 'TJ', 'TM', 'BR', 'MX', 'AR', 'TH', 'VN',
                'PL', 'CZ', 'DK', 'SE', 'NO', 'NL', 'BE', 'IE', 'CH', 'AT', 'FI', 'HU',
                'RO', 'PT', 'LT', 'UA', 'EG', 'IS', 'TR', 'IR', 'GR', 'ZA', 'SG', 'MY', 'PH'
            ];

            let regionNames = null;
            try {
                if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
                    regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
                }
            } catch (_) {}

            if (regionNames) {
                primaryCodes.forEach(code => {
                    try {
                        const name = regionNames.of(code);
                        if (name) {
                            names.add(name);
                            this._codeMap[name] = code;
                        }
                    } catch (_) {}
                });

                // 动态遍历 ISO 3166-1 空间，全量收录全球 260+ 国家与地区官方中文译名
                for (let i = 65; i <= 90; i++) {
                    for (let j = 65; j <= 90; j++) {
                        const code = String.fromCharCode(i, j);
                        try {
                            const name = regionNames.of(code);
                            if (name && name !== code && !/^[A-Z]{2}$/.test(name)) {
                                names.add(name);
                                if (!this._codeMap[name]) this._codeMap[name] = code;
                                // 兼容去除国家政体修饰后缀的通用简称 (如 "特别行政区/共和国/王国/联邦/大公国")
                                const short = name.replace(/特别行政区|共和国|王国|联邦|合众国|大公国|公国/g, '').trim();
                                if (short && short.length >= 2) {
                                    names.add(short);
                                    if (!this._codeMap[short]) this._codeMap[short] = code;
                                }
                            }
                        } catch (_) {}
                    }
                }
            } else {
                primaryCodes.forEach(code => { this._codeMap[code] = code; });
            }

            // 补全历史与常用民间区域简称
            const aliases = [
                ['香港', 'HK'], ['澳门', 'MO'], ['台湾', 'TW'],
                ['中国香港', 'HK'], ['中国台湾', 'TW'], ['中国澳门', 'MO'],
                ['大陆', 'CN'], ['内地', 'CN'], ['苏联', 'SU']
            ];
            aliases.forEach(([alias, code]) => {
                names.add(alias);
                if (!this._codeMap[alias]) this._codeMap[alias] = code;
            });

            // 依长度降序排序 (贪婪匹配原则，防止短词破坏长词)
            const sorted = Array.from(names).sort((a, b) => b.length - a.length);
            if (sorted.length > 0) {
                this._pattern = new RegExp(`(?:[\\s._\\-–—]|[（(\\[【])(${sorted.join('|')})(?:[）)\\]】])?$`, 'i');
            }
        }

        static extractAndStrip(title) {
            if (!title) return { title: '', country: '', countryCode: '' };
            this.init();
            const raw = String(title).trim();
            if (!this._pattern) return { title: raw, country: '', countryCode: '' };

            const match = raw.match(this._pattern);
            if (match && match.index >= 2) {
                const prefix = raw.slice(0, match.index).trim();
                if (prefix.length >= 2 && !/^\d+$/.test(prefix)) {
                    const countryName = match[1];
                    return {
                        title: prefix,
                        country: countryName,
                        countryCode: this._codeMap[countryName] || ''
                    };
                }
            }
            return { title: raw, country: '', countryCode: '' };
        }

        // ★ 获取国家二字码对应的标准中文展示名
        static getCountryDisplayName(codeOrName) {
            if (!codeOrName) return '';
            const clean = String(codeOrName).trim();
            if (/^[A-Z]{2}$/i.test(clean)) {
                const code = clean.toUpperCase();
                if (code === 'CN') return '中国';
                if (code === 'HK') return '中国香港';
                if (code === 'TW') return '中国台湾';
                if (code === 'MO') return '中国澳门';
                try {
                    if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
                        const dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
                        const n = dn.of(code);
                        if (n) return n.replace(/特别行政区|共和国|王国|联邦|合众国|大公国/g, '').trim();
                    }
                } catch (_) {}
            }
            return clean;
        }

        // ★ 智能聚合影视分组的出品国家/地区
        static formatGroupCountry(group) {
            if (!group) return '';
            const rawCountries = (Array.isArray(group.origin_country) && group.origin_country.length > 0)
                ? group.origin_country
                : ((Array.isArray(group.production_countries) && group.production_countries.length > 0)
                    ? group.production_countries
                    : (group.country ? [group.country] : (group.countryCode ? [group.countryCode] : [])));
            const codes = (Array.isArray(rawCountries) ? rawCountries : [rawCountries])
                .map(c => typeof c === 'object' ? (c.iso_3166_1 || c.name || '') : c)
                .map(c => String(c || '').trim())
                .filter(Boolean);
            
            if (codes.length > 0) {
                const names = codes.slice(0, 2).map(c => this.getCountryDisplayName(c)).filter(Boolean);
                if (names.length > 0) return names.join(' / ');
            }

            // 语种兜底推导国家/地区
            const lang = String(group.original_language || group.originalLanguage || '').toLowerCase().trim();
            const langMap = {
                'ko': '韩国', 'ja': '日本', 'zh': '中国', 'cmn': '中国', 'yue': '中国香港',
                'fr': '法国', 'de': '德国', 'es': '西班牙', 'it': '意大利', 'th': '泰国',
                'ru': '俄罗斯', 'hi': '印度'
            };
            return langMap[lang] || '';
        }
    }

class RecognitionEngine {
    static CountryRegistry = CountryRegistry;
    static SIDECAR_EXTENSIONS = new Set(['ass', 'srt', 'ssa', 'sub', 'vtt']);
    static IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'tif', 'tiff']);
    static DISCARD_EXTENSIONS = new Set(['nfo', 'txt', 'url', 'exe', 'torrent', 'jpg', 'jpeg', 'png', 'webp', 'gif']);
    static GENERIC_FOLDERS = /^(?:Transfer|Downloads?|Media|Videos?|Movies?|TV|Series|Anime|Bangumi|Default|Root|新建文件夹|待整理|未分类|夸克|阿里云盘|百度网盘|115网盘|123云盘|139云盘|移动云盘|天翼云盘|迅雷云盘|暂存区|临时存放|Share|Download)$/i;
    static DEFAULT_SPECIAL_KEYWORD_MAPPINGS = [
        ['special', '特别篇', ['特别篇', 'Special', 'SP', '特典', '花絮', '预热', '先行', '番外']],
        ['ova', 'OVA', ['OVA', 'OAD', 'ONA']],
        ['preview', '预告', ['预告', 'Trailer', 'Teaser', '先导']],
        ['opening', '片头曲', ['NCED', 'NCOP', 'OP', 'ED']],
        ['movie', '剧场版', ['剧场版', '劇場版', 'Movie']]
    ];

        static normalizeChineseNumeral(s) {
            const numMap = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
            return String(s || '').replace(/第([一二两兩三四五六七八九十\d]+)([季部期])/g, (_, n, unit) => {
                if (/^\d+$/.test(n)) return `第${n}${unit}`;
                let val = 0;
                if (n === '十') val = 10;
                else if (n.startsWith('十')) val = 10 + (numMap[n[1]] || 0);
                else if (n.endsWith('十')) val = (numMap[n[0]] || 1) * 10;
                else if (n.includes('十')) {
                    const parts = n.split('十');
                    val = (numMap[parts[0]] || 1) * 10 + (numMap[parts[1]] || 0);
                } else {
                    val = numMap[n] || n;
                }
                return `第${val}${unit}`;
            });
        }

        // 全局统一归一化比较方法 (单一事实来源 SSOT)

        static normalizeCompare(s) {
            return this.toSimplified(String(s || ''))
                .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
                .toLowerCase()
                .replace(/第[一二两兩三四五六七八九十\d]+[季部期]/g, (m) => this.normalizeChineseNumeral(m))
                .replace(/[\s·・•:：\-—_.,，、'"“”‘’()（）\[\]【】!！《》〈〉「」『』?？/\\|｜]/g, '')
                .replace(/ii/g, '2').replace(/iii/g, '3').replace(/iv/g, '4').replace(/[Ⅱ]/g, '2').replace(/[Ⅲ]/g, '3');
        }


        static extractYear(text) {
            if (!text) return '';
            const s = String(text);
            const matches = [...s.matchAll(/(?<!\d)(18\d\d|19\d\d|20[0-3]\d)(?!\d)/g)];
            for (const m of matches) {
                const year = m[1];
                const idx = m.index;
                const after = s.slice(idx + 4, idx + 10);
                if (/^\s*[xX]\s*\d{3,4}/.test(after)) continue;
                const before = s.slice(Math.max(0, idx - 6), idx);
                if (/\d{3,4}\s*[xX]\s*$/.test(before)) continue;
                if (/^(?:p|i|fps|k)\b/i.test(after)) continue;
                return year;
            }
            return '';
        }


        static chineseInteger(value) {
            const text = String(value || '').trim();
            if (/^\d+$/.test(text)) return Number(text);
            const digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '壹': 1, '贰': 2, '貳': 2, '叁': 3, '參': 3, '肆': 4, '伍': 5, '陆': 6, '陸': 6, '柒': 7, '捌': 8, '玖': 9 };
            const smallUnits = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };
            const directUnits = { '廿': 20, '卅': 30, '卌': 40 };
            let section = 0, total = 0, current = 0;
            for (const char of text) {
                if (digits[char] !== undefined) current = digits[char];
                else if (directUnits[char]) { section += directUnits[char]; current = 0; }
                else if (smallUnits[char]) { section += (current || 1) * smallUnits[char]; current = 0; }
                else if (char === '万' || char === '萬') { total += (section + current || 1) * 1e4; section = 0; current = 0; }
                else return null;
            }
            return total + section + current;
        }

        // MoviePilot 二级分类推导算法

        static isAnimeIdentifier(folder, name) {
            const combined = `${folder || ''} ${name || ''}`;
            if (/[\u3040-\u30ff]/.test(combined)) return true; // 包含日文平假名/片假名
            if (/[[\[【]\s*(?:新番|动画|アニメ|ANIME|中日双语|双语字幕|简日|繁日|Baha|巴哈|B-Global|无字片源|合集)\s*[\]】]/i.test(combined)) return true;
            if (this.getAliases(folder).length > 0 || this.getAliases(name).length > 0) return true;
            return false;
        }


        static isCollectionFolder(name) {
            if (!name) return false;
            const clean = String(name).trim();
            // 普适多片合集/全集/系列/精选/作品集/大系通用容器 (如 "电影频道合集56 CCTV6.Collection.Vol.56", "周星驰经典电影合辑", "【电影合集】电影频道3300部", "漫威电影宇宙系列")
            return Boolean(
                /(?:(?:剧场版|电影)?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*部(?:合集|全集|曲)|(?:剧场版|电影)?\s*(?:合集|全集)|合集|全集|合辑|作品集|典藏|精选[辑集]?|大系)/i.test(clean) ||
                /(?:电影频道|CCTV\d*)\s*(?:合集|全集|Collection)?/i.test(clean) ||
                /\b(?:Collections?|Anthology|Boxset)\b/i.test(clean) ||
                /\bVol(?:ume)?\.?\s*\d+\b/i.test(clean)
            );
        }


        static isSubSeasonFolder(name) {
            if (!name) return false;
            const clean = String(name).trim();
            if (/^(?:HD[-_ ]?)?S(?:eason)?\s*\d{1,3}(?:.*)?$/i.test(clean)) return true;
            if (/^(?:Season\s*\d{1,3}|Seasons\s*\d{1,3}|S\d{1,3})(?:.*)?$/i.test(clean)) return true;
            if (/^(?:第\s*[\(\[（【]?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[\)\]）】]?\s*[季期部卷篇]?)(?:.*)?$/i.test(clean)) return true;
            if (/^(?:Specials?|SP\d*|Extras?|Bonus|Featurettes?|Behind the Scenes|番外|特别篇)$/i.test(clean)) return true;
            if (/^(?:cd\s*\d+|disc\s*\d+|part\s*\d+|subs?|subtitles?)$/i.test(clean)) return true;
            return false;
        }

        // ★【跨号秒传/还原清单专属】智能识别剧集作品与任务范围全名 (穿透 Season 1，对齐导出特征命名)

        static stripReleaseGroup(title) {
            if (!title) return '';
            let s = String(title).trim();
            // 语法规则：主干末尾由连字符/破折号/下划线引导的西文代号 (排除分卷part/cd/disc、分辨率4k/1080p、年份19xx/20xx等通用技术保留词)
            s = s.replace(/[\s._]*[-–—_]\s*([A-Za-z0-9_@]+(?:\s+[A-Za-z0-9_@]+)?)$/, (match, candidate) => {
                const isTechnicalOrPart = /^(?:part\d*|cd\d*|disc\d*|vol\d*|ep?\d+|s\d+e\d+|4k|8k|2160[pi]|1080[pi]|720p|480p|19\d\d|20\d\d)$/i.test(candidate.trim());
                if (!isTechnicalOrPart) {
                    return '';
                }
                return match;
            });
            // 剥离尾部残留的悬空标点 (破折号、连字符、减号、下划线、波浪号、空格、点号)
            s = s.replace(/[\s._\-–—~]+$/, '').trim();
            return s;
        }

        // ★【独立制片国家/地区标签智能剥离】
        // 依托 CountryRegistry (Unicode CLDR / ISO 3166-1 权威标准库引擎) 驱动
        // 普适自然语法：仅当存在显式语法分隔符 (空格/点/下划线/连字符/括号) 且前置片名长度 >= 2 时才剥离
        // 坚决保护无分隔符自然词汇 (如《中国机长》《法国中尉的女人》《印度暴徒》《俄罗斯方舟》《英国病人》)

        static extractAndStripCountryTag(title) {
            return CountryRegistry.extractAndStrip(title);
        }


        static stripCountryTag(title) {
            return this.extractAndStripCountryTag(title).title;
        }


        static splitBilingualTitle(str) {
            if (!str) return { title: str || '', englishTitle: '' };
            let s = String(str).trim().replace(/\.[a-zA-Z0-9]+$/i, '').trim();

            const hasCn = /[\u4e00-\u9fff]/.test(s);
            const hasEn = /[a-zA-Z]{2,}/.test(s);
            if (!hasCn || !hasEn) {
                return { title: s, englishTitle: '' };
            }

            // 核心保护：若片名是以西文代号/数字紧随冒号与中文标题（如 "SPEC: 结 前篇", "007：大战皇家赌场", "Gundam: 闪光的哈萨维"）
            // 整体属于作品不可分割的统一片名，绝不能拆散为英文别名而导致主标题残缺
            if (/^[a-zA-Z0-9\s._\-–—]+[:：]\s*[\u4e00-\u9fff]/.test(s)) {
                return { title: s, englishTitle: '' };
            }

            // Pattern 1: 点号分隔 (如 Chinese.The.English.Title.2014)
            if (s.includes('.')) {
                const dotParts = s.split('.');
                const cnParts = [];
                const enParts = [];
                for (const p of dotParts) {
                    if (/[\u4e00-\u9fff]/.test(p)) cnParts.push(p);
                    else if (/[a-zA-Z]/.test(p)) enParts.push(p);
                }
                if (cnParts.length > 0 && enParts.length > 0) {
                    const enClean = this.cleanCandidateEnglishTitle(enParts.join(' '));
                    if (enClean.length >= 2 && !/[\u4e00-\u9fff]/.test(enClean)) {
                        return {
                            title: cnParts.join(' ').trim(),
                            englishTitle: enClean
                        };
                    }
                }
            }

            // Pattern 2: 尾部英文副标题 (如 左麟右李 2009东亚运动会 红磡演唱会 Alan and Hacken Concert 2009)
            // 或 极端乐队：Metal Meltdown演唱会 Extreme-Pornograffitti Live 25 2016
            // 或 间谍过家家 SPY×FAMILY
            const mTailEn = s.match(/^(.*?[\u4e00-\u9fff][^\u4e00-\u9fff]*?)\s+([a-zA-Z].*)$/);
            if (mTailEn && /[\u4e00-\u9fff]/.test(mTailEn[1]) && /[a-zA-Z]{2,}/.test(mTailEn[2])) {
                const headPart = mTailEn[1].trim();
                // 铁律防御：若前置中文段以连字符/破折号/下划线结尾 (如 "新来的李老师 -")，表明尾部西文实为连字符连接的发布组/参数，绝非双语副标题
                if (/[\-_–—]$/.test(headPart)) {
                    return { title: s.replace(/[\s._\-–—~]+$/, '').trim(), englishTitle: '' };
                }
                const enClean = this.cleanCandidateEnglishTitle(mTailEn[2]);
                // 语法防御：无空格的 2~5 位纯大写无元音缩写代号 (如 PCG, MHG, NGB, CHD)，实为压缩代号，绝非自然语言英文片名
                const isConsonantCode = /^[A-Z0-9]{2,5}$/.test(enClean) && !/[AEIOUaeiou]/.test(enClean);
                if (enClean.length >= 2 && !/[\u4e00-\u9fff]/.test(enClean) && !isConsonantCode) {
                    return {
                        title: headPart,
                        englishTitle: enClean
                    };
                }
            }

            // Pattern 3: 头部英文副标题 (如 Yuki Kajiura LIVE Vol.9 梶浦由记渋公Special演唱会 2012)
            // 严格约束前缀为纯西文串，严禁跨越中文字符抓取尾部单字
            const mHeadEn = s.match(/^([a-zA-Z][a-zA-Z0-9\s._\-–—'&!]+?)\s+([\u4e00-\u9fff].*)$/);
            if (mHeadEn && !/[\u4e00-\u9fff]/.test(mHeadEn[1]) && /[a-zA-Z]{2,}/.test(mHeadEn[1]) && /[\u4e00-\u9fff]/.test(mHeadEn[2])) {
                const enClean = this.cleanCandidateEnglishTitle(mHeadEn[1]);
                if (enClean.length >= 2 && !/[\u4e00-\u9fff]/.test(enClean)) {
                    return {
                        title: mHeadEn[2].trim(),
                        englishTitle: enClean
                    };
                }
            }

            return { title: s, englishTitle: '' };
        }


        static parseAnimeFilename(filename) {
            const raw = String(filename || '').replace(/\.[^.]+$/, '');
            const pureNumLangMatch = raw.match(/^(\d{1,4})\s*(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|生肉|熟肉)$/i);
            if (pureNumLangMatch) {
                return {
                    releaseGroup: '',
                    title: '',
                    episode: parseInt(pureNumLangMatch[1], 10),
                    tmdbId: ''
                };
            }
            const tokens = [];
            const bracketRegex = /[\[【]([^\]】]+)[\]】]/g;
            let m;
            let lastIndex = 0;
            const textSegments = [];

            while ((m = bracketRegex.exec(raw)) !== null) {
                if (m.index > lastIndex) {
                    const between = raw.slice(lastIndex, m.index).trim();
                    if (between) textSegments.push(between);
                }
                tokens.push(m[1].trim());
                lastIndex = bracketRegex.lastIndex;
            }
            if (lastIndex < raw.length) {
                const trailing = raw.slice(lastIndex).trim();
                if (trailing) textSegments.push(trailing);
            }

            // 通用规格词判定算法：音视频、字幕、原盘、容量、压制参数等绝对不是片名
            const isSpecToken = (t) => {
                const s = t.trim();
                if (/^(?:tmdb(?:id)?[-_:]?\d+|\{tmdb(?:id)?[-_:]?\d+\})$/i.test(s) || /\btmdbid\b/i.test(s)) return false;
                const hasSpecKw = /(?:DIY|原盘|日版|美版|港版|台版|简繁|简体|繁体|字幕|特效|双语|双字|中日双字|无字|内嵌|内封|外挂|多音轨|音轨|国语|粤语|台语|英语|日语|国台日粤语|LPCM|DTS(?:-HD)?(?:MA)?|TrueHD|Atmos|DD[ .+-]?\d*(?:\.\d+)?|FLAC|AAC|REMUX|BDRip|WEB-?DL|1080[pi]|2160[pi]|4k|720[pi]|x26[45]|hevc|avc|10bit|8bit|\b\d+(?:\.\d+)?(?:G|GB|M|MB)\b|MP4|MKV|ISO)/i.test(s);
                const hasTitleFeature = /(?:剧场版|动画|电影|篇|季|Season|Episode|话|集|Fin|END)/i.test(s);
                if (hasSpecKw && !hasTitleFeature) {
                    const stripped = s.replace(/(?:DIY|原盘|日版|美版|港版|台版|简繁|简体|繁体|字幕|特效|双语|双字|中日双字|内嵌|内封|外挂|无字|多音轨|音轨|国语|粤语|台语|英语|日语|国台日粤语|LPCM|DTS(?:-HD)?(?:MA)?|TrueHD|Atmos|DD[ .+-]?\d*(?:\.\d+)?|FLAC|AAC|REMUX|BDRip|WEB-?DL|1080[pi]|2160[pi]|4k|720[pi]|x26[45]|hevc|avc|10bit|8bit|\d+(?:\.\d+)?(?:G|GB|M|MB)|MP4|MKV|ISO|[\d\s._+~:：\-\[\]\(\)\/、])/gi, '');
                    if (stripped.length <= 2) return true;
                }
                return false;
            };

            const isMetaToken = (t) => {
                const s = t.trim();
                if (/^(?:tmdb(?:id)?[-_:]?\d+|\{tmdb(?:id)?[-_:]?\d+\})$/i.test(s) || /\btmdbid\b/i.test(s)) return { type: 'tmdb', val: s };
                if (isSpecToken(s)) return { type: 'spec', val: s };
                if (/^(?:4320p|2160p|1080p|720p|480p|4k|8k|fhd|uhd)$/i.test(s)) return { type: 'videoFormat', val: s.toLowerCase() };
                if (/^(?:hevc|avc|h\.?26[45]|x26[45]|av1|10bit|8bit|avc_aac)$/i.test(s)) return { type: 'videoCodec', val: s };
                if (/^(?:aac|flac|mp3|opus|dts|truehd|ac3|ddp|dd\+|lpcm)$/i.test(s)) return { type: 'audioCodec', val: s };
                if (/^(?:web-?dl|webrip|bdrip|bluray|baha|b-global|bilibili|cr|crunchyroll|tvrip|hdtv|remux)$/i.test(s)) return { type: 'mediaSource', val: s };
                if (/^(?:gb|big5|chs|cht|tc|sc|jap?|eng?|gb_jp|jp_gb|简日|繁日|简繁|简中|繁中|双语|国日|中日双语.*|简日双语|繁日双语|简繁内封.*|简繁外挂.*|中文字幕|字幕)$/i.test(s)) return { type: 'lang', val: s };
                if (/^(?:mp4|mkv|avi|iso)$/i.test(s)) return { type: 'ext', val: s };
                if (/^(?:合集|新番|\d{1,2}月新番|完结|最终版)$/i.test(s)) return { type: 'misc', val: s };
                const epM = s.match(/^(?:ep|e|第)?\s*(\d{1,4})\s*(?:集|话|話|end|fin|完|v\d+)?$/i);
                if (epM) {
                    const val = parseInt(epM[1], 10);
                    if (val <= 2000 && val !== 1080 && val !== 720 && val !== 2160 && val !== 480 && !(val >= 1970 && val <= 2030)) {
                        return { type: 'episode', val };
                    }
                }
                return null;
            };

            let releaseGroup = '';
            let title = '';
            let episode = null;
            let parsedTmdbId = '';
            const candidateTokens = [];

            tokens.forEach((token) => {
                const meta = isMetaToken(token);
                if (meta) {
                    if (meta.type === 'episode' && episode === null) episode = meta.val;
                    if (meta.type === 'tmdb') {
                        const mId = token.match(/\d+/);
                        if (mId) parsedTmdbId = mId[0];
                    }
                } else {
                    candidateTokens.push(token);
                }
            });

            // 括号外存在文本片段时（如 [BDRip] 片名 [1080p] 或 [VCB-Studio] 某动画 01 或 守护甜心01）
            if (textSegments.length > 0) {
                const hasAnimeHint = tokens.length > 0 || /[\u3040-\u309f\u30a0-\u30ff]/.test(raw);
                const epPrefix = hasAnimeHint ? '(?:E|EP|Episode|第|-)?' : '(?:E|EP|Episode|第)';
                const epPatternRegex = new RegExp('(?:^|[ ._-])' + epPrefix + '\\s*(\\d{1,4})\\s*(?:集|话|話|END|Fin|完)?(?=$|[ ._-])', 'i');

                for (const rawSeg of textSegments) {
                    const seg = rawSeg.replace(/\b(?:[xXhH]\.?26[45]|hevc|avc|\d{1,2}bit|\d{2,3}fps|[1257]\.[012]|aac\d*|ac3|dts(?:-hd)?|flac)\b/gi, ' ');
                    const epM = seg.match(epPatternRegex)
                        || (hasAnimeHint ? seg.match(/(?:[\u3400-\u9fffA-Za-z]+)(\d{2,4})$/) : null);
                    if (epM && episode === null) {
                        const epVal = parseInt(epM[1], 10);
                        if (epVal <= 2000 && epVal !== 1080 && epVal !== 720 && epVal !== 480 && epVal !== 2160 && epVal !== 264 && epVal !== 265 && !(epVal >= 1970 && epVal <= 2030)) {
                            episode = epVal;
                        }
                    }
                    const cleanSeg = rawSeg.replace(epPatternRegex, '')
                        .replace(/(?<=[\u3400-\u9fffA-Za-z])\d{2,4}$/, '')
                        .trim();
                    if (cleanSeg && !title) title = cleanSeg;
                }
                if (candidateTokens.length > 0 && !releaseGroup) {
                    // 若括号外已有片名，首个候选括号通常为制作组
                    const first = candidateTokens[0];
                    if (!/^(?:19\d\d|20\d\d)$/.test(first) && !/(?:剧场版|动画|电影)/.test(first)) {
                        releaseGroup = first;
                    }
                }
            } else {
                // 全括号排布（如 [银魂...][DIY...][DTS...] 或 [危险调查员][日版原盘...][blucook][274G]）
                if (candidateTokens.length === 1) {
                    title = candidateTokens[0];
                } else if (candidateTokens.length >= 2) {
                    title = candidateTokens[0];
                    const last = candidateTokens[candidateTokens.length - 1];
                    // 最后一个候选若符合发布组特征（非纯年份、非影视长句词）则作为发布组
                    if (!/^(?:19\d\d|20\d\d)$/.test(last) && !/(?:剧场版|动画|电影|篇)/.test(last) && last.length <= 25) {
                        releaseGroup = last;
                    }
                }
            }

            // 清理标题末尾附带的技术/年份噪音
            if (title) {
                title = title.replace(/\b(?:19\d\d|20\d\d)\b.*$/i, '').trim() || title;
            }

            return {
                releaseGroup,
                title: title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
                episode,
                tmdbId: parsedTmdbId
            };
        }


        static cleanMediaFolderName(folderName) {
            return this.cleanAnimeFolderName(folderName);
        }


        static getBaseFileName(pathOrName) {
            const s = String(pathOrName || '').trim();
            const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
            return idx >= 0 ? s.slice(idx + 1) : s;
        }


        static splitExtension(name) {
            const value = this.getBaseFileName(name);
            const index = value.lastIndexOf(".");
            if (index <= 0 || index === value.length - 1) return [value, ""];
            return [value.slice(0, index), value.slice(index)];
        }


        static getFileExt(name) {
            const clean = Utils.removeGhostExtension ? Utils.removeGhostExtension(name) : String(name || '').replace(/\.(?:jpg|png|b64)$/i, '');
            const idx = clean.lastIndexOf('.');
            return idx >= 0 ? clean.slice(idx + 1).toLowerCase() : '';
        }


        static isVideoFile(name) {
            return this.VIDEO_EXTENSIONS.has(this.getFileExt(name));
        }


        static isSidecarFile(name) {
            return this.SIDECAR_EXTENSIONS.has(this.getFileExt(name));
        }


        static isImageFile(name) {
            return this.IMAGE_EXTENSIONS.has(this.getFileExt(name));
        }


        static isDiscardFile(name) {
            return this.DISCARD_EXTENSIONS.has(this.getFileExt(name));
        }


        static targetSeasonFromFolder(folderName) {
            const clean = String(folderName || '').trim();
            if (!clean) return null;
            if (/^\d+\s*(?:G|GB|T|TB)/i.test(clean) || /\b\d{3,4}[pi]\b/i.test(clean) || /(?:演唱会|音乐会|Concert|Live)/i.test(clean)) return null;
            // 普适通用分类容器（如 "iso动漫", "4K动漫", "电影", "剧集" 等）直接跳过，严禁提取季数
            if (/^(?:iso|4k|8k|bd|dvd|remux|web-?dl|hdr|1080[pi]|720p)?[_\-\s.]*(?:欧美|日韩|华语|港台|大陆|海外|英美|国产|日|美|台|国配)?(?:电影|剧集|电视剧|连续剧|动漫|动画|新番|纪录片|综艺|演唱会|影视|视频|资源|原盘)$/i.test(clean) || this.GENERIC_FOLDERS.test(clean)) return null;
            // 识别 第(2), 第2季, 第2部, 第2期, 第2, [2], (2), S2, Season 2, 食戟之靈3叁之皿, 钻石王牌02, 灵能百分百2
            const cnMatch = clean.match(/(?:第\s*[\(\[（【]?\s*([0-9零〇一二两兩三四五六七八九十百\d]+)\s*[\)\]）】]?\s*[季期部卷篇皿]?)|(?:Season\s*(\d{1,3}))|\bS(\d{1,3})\b/i);
            if (cnMatch) {
                if (cnMatch[1]) return String(this.chineseInteger(cnMatch[1]) || 1);
                if (cnMatch[2]) return String(parseInt(cnMatch[2], 10));
                if (cnMatch[3]) return String(parseInt(cnMatch[3], 10));
            }

            // 先行剥离合法的 4 位公历年份 (19xx, 20xx) 及其外围包裹括号，杜绝年份及空括号残留导致季号匹配失效 (如 "[交响诗篇 2005]" -> 误判为 5, "大王饶命3（2026）" -> 需剥离（2026）后准确识别 3)
            const cleanWithoutYear = clean
                .replace(/[\(\[（【]\s*(?:19|20)\d{2}\s*[\)\]）】]/g, ' ')
                .replace(/\b(?:19|20)\d{2}\b/g, ' ')
                .replace(/(?:19|20)\d{2}/g, ' ')
                .replace(/[\(\[（【]\s*[\)\]）】]/g, ' ');

            // 剥离末尾技术标签与分辨率 (如 "诛仙3 4K", "诛仙 Ⅲ 4K SDR", "庆余年2 2160p")
            const cleanWithoutTags = cleanWithoutYear.replace(/\b(?:4k|8k|2160[pi]?|1080[pi]?|720p?|hevc|avc|h\.?26[45]|x26[45]|remux|web-?dl|hdr10\+?|hdr|dv|sdr|60fps|50fps|10bit|8bit|aac|flac|mp4|mkv|iso)\b/gi, ' ').trim();

            // 罗马数字季度识别 (如 "诛仙 Ⅲ", "斗罗大陆Ⅱ", "一拳超人 II", "大理寺日志 II")
            const romanMatch = cleanWithoutTags.match(/(?:^|[\s._\-\(\[（【])([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|\b(?:II|III|IV|VI|VII|VIII|IX|X)\b)(?=$|[\s._\-\)\]）】])/i);
            if (romanMatch) {
                const ROMAN_MAP = {
                    'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9, 'Ⅹ': 10,
                    'II': 2, 'III': 3, 'IV': 4, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
                };
                const rKey = romanMatch[1].toUpperCase();
                if (ROMAN_MAP[rKey]) return String(ROMAN_MAP[rKey]);
            }

            // 国漫常见“年番”季度识别 (如 "沧元图·年番3", "斗破苍穹 年番2")
            const nianfanMatch = cleanWithoutTags.match(/年番\s*([0-9零〇一二两兩三四五六七八九十\d]+)/);
            if (nianfanMatch) {
                const nVal = this.chineseInteger(nianfanMatch[1]) || parseInt(nianfanMatch[1], 10);
                if (nVal >= 1 && nVal <= 20) return String(nVal);
            }

            // 识别纯括号数字或结尾数字 (如 "[七大罪2]", "钻石王牌02", "灵能百分百2", "守护甜心2", "四驱兄弟 3", "诛仙3", "大王饶命3")
            const bracketNum = cleanWithoutTags.match(/\[.*?(\d{1,2})\]|\(.*?\b(\d{1,2})\b\)/);
            if (bracketNum) {
                return String(parseInt(bracketNum[1] || bracketNum[2], 10));
            }
            const trailingNum = cleanWithoutTags.match(/(?:^|[^\d])(\d{1,2})$/);
            if (trailingNum) {
                const num = parseInt(trailingNum[1], 10);
                if (num >= 1 && num <= 30) return String(num);
            }
            if (/最终季|Final\s*Season/i.test(clean)) return 'final';
            if (/(?:特别篇|Special|OVA|OAD|\bSP\b|番外|花絮|特典|预热|先行|序篇|序章|预兆|预告|先导)/i.test(clean)) return '0';
            return null;
        }

        // 剥离剧集标题末尾的集号尾巴（对齐 123 助手 stripLooseEpisodeTail）

        static stripLooseEpisodeTail(title) {
            let value = String(title || '').trim();
            const tailPatterns = [
                /[\s._·-]*第\s*(?:[0-9零〇一二两兩三四五六七八九十百千万萬壹贰貳叁參肆伍陆陸柒捌玖拾佰仟\d]+\s*)[期集話话](?:[\s._·-]*[上中下])?$/i,
                /[\s._·-]*第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*部分$/i,
                /[\s._·-]*(?:Part|Pt)[ ._-]*\d{1,3}$/i,
                /[\s._·-]*(?:EP?|ep)\s*\d{1,5}(?:[\s._·-]*[上中下])?$/i,
                /[\s._·-]*\d{1,4}(?:[\s._·-]*[上中下])?$/
            ];
            for (const pattern of tailPatterns) {
                const stripped = value.replace(pattern, '').trim();
                if (stripped && stripped !== value) return stripped;
            }
            return value;
        }

        // 主标题衍生短后缀识别（对齐 123 助手 looseVariantRemainder）

        static looseVariantRemainder(title, baseTitle) {
            const value = String(title || '').trim();
            const base = String(baseTitle || '').trim();
            if (!base || !value.toLowerCase().startsWith(base.toLowerCase()) || value.length <= base.length) return '';
            const rest = value.slice(base.length).replace(/^[\s._·-]+/, '').trim();
            if (!rest || rest.length > 12) return '';
            if (/(?:19|20)\d{2}|S\d{1,3}(?:E\d{1,5})?(?=$|[^A-Za-z0-9])/i.test(rest)) return '';
            return rest;
        }

        // 特殊集数关键词侦测 (先导片、预告、番外、加更、彩蛋、会员版、OVA、剧场版、特别篇)

        static isSpecialEpisodeHint(filename) {
            const clean = String(filename || '');
            if (/\bS0+E\d+/i.test(clean)) return { label: '特别篇', kind: 'special' };
            for (const [kind, label, aliases] of this.DEFAULT_SPECIAL_KEYWORD_MAPPINGS) {
                for (const alias of aliases) {
                    const escaped = String(alias || '').trim().replace(/[*+?^|]/g, '\\$&').replace(/\s+/g, '[ ._-]*');
                    // 允许关键词后直接紧随集数 (如 SP01, OVA1, OAD02, 剧场版01, 剧场版14)
                    const reg = new RegExp(`(?:^|[^A-Za-z0-9])(?:${escaped})(?:\\s*\\d{1,3})?(?=$|[^A-Za-z0-9])`, 'i');
                    if (reg.test(clean)) return { label, kind };
                }
            }
            return null;
        }

        // 显式季集标记判定 (S01E01, 第2季 等)

        static hasExplicitSeasonEpisode(filename) {
            const clean = String(filename || '');
            return Boolean(clean.match(/\bS\d{1,3}(?:[\s._-]*E\d{1,4})?\b/i) || clean.match(/第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*季/));
        }

        // 综艺/纪录片/周播节目的日期型集数解析 (YYYY.MM.DD / YYYY-MM-DD / YYYYMMDD)

        static detectPilotEpisodeOffset(files, episodes = []) {
            if (!files || !files.length || !episodes.length) return 0;
            const firstFile = files[0];
            const hasPilot = Boolean(this.isSpecialEpisodeHint(firstFile.name));
            if (hasPilot && files.length > episodes.length) {
                Logger.debug('[分集检测] 发现先导片独立成集且文件数超过正集数，触发首集位移补偿');
                return 1;
            }
            return 0;
        }

        // 防死锁临时命名生成器

        static temporaryName(targetName) {
            const [stem, ext] = this.splitExtension(targetName);
            return `${stem}.__organize_tmp__${Math.random().toString(36).slice(2, 6)}${ext}`;
        }


        static extractSubtitleTag(filename) {
            const clean = String(filename || '').replace(/\.[^.]+$/, '');
            const patterns = [
                /(?:[\._\-\[\(\s]|^)(zh[\-_](?:cn|tw|hk|hans|hant)|zh|chs&cht|cht&chs|chs|cht|sc|tc|chi|zho|cmn|yue|en[\-_](?:us|gb)|eng?|jap?|kor?)(?=[ \._\-\]\)]|$)/i,
                /(?:[\._\-\[\(\s]|^)(简繁双语|简英双语|繁英双语|双语特效|简日双语|双语|简繁中字|简繁|简中|繁中|简体|繁体|国粤多音轨|国粤双语|国粤|国配|国语|粤语|特效|中英|英中|普通话|中文|中字)(?=[ \._\-\]\)]|$)/,
                /(?:[\._\-\[\(\s]|^)(forced|default|commentary|sdh)(?=[ \._\-\]\)]|$)/i,
                /(?:[\._\-\[\(\s]|^)(sub\d*|track\d+|cd\d+|pt\d+|part\d+)(?=[ \._\-\]\)]|$)/i
            ];
            for (const pat of patterns) {
                const m = clean.match(pat);
                if (m) return m[1];
            }
            return '';
        }


        static extractMediaVariantTag(filename, isTv = false) {
            const name = String(filename || '');
            const stem = name.replace(/\.[a-zA-Z0-9]+$/i, '').trim();

            // 1. 显式 Disc / CD / Part / Pt / Disk 标记 (最高优先级，对齐 123 助手)
            // 剧集保护防线：若为剧集且包含显式季集标识 (SxxExx 或 Exx)
            if (isTv && (/\bS\d{1,3}[\s._-]*E\d{1,4}\b|\bE\d{1,4}\b/i.test(stem))) {
                // 仅当 Part/CD 紧邻在季集记号之后且中间无其他词汇时 (如 S01E01.Part1.1080p 或 S01E01.CD1)，才作为物理切片
                const adjacentPart = stem.match(/\bS\d{1,3}[\s._-]*E\d{1,4}[ ._\-]*(?:Part|Pt|CD|DISC|DISK)[ ._\-]*([0-9]+|[A-H])\b/i);
                if (adjacentPart) {
                    const raw = adjacentPart[1];
                    const val = /^\d+$/.test(raw) ? String(Number(raw)).padStart(2, '0') : raw.toUpperCase();
                    return `Part${val}`;
                }
                // 若季集与 Part 之间隔着其他英文词汇 (如 S03E19.Crossroads.Part.1)，属于分集故事标题，绝不提取为分卷切片标签！
            } else {
                // 电影或无显式单集标识的文件：保留常规 Disc / CD / Part / Pt 提取
                const partNum = stem.match(/(?:Part|Pt|CD|DISC|DISK)[ ._\-]*([0-9]+|[A-H])\b/i);
                if (partNum) {
                    const raw = partNum[1];
                    const val = /^\d+$/.test(raw) ? String(Number(raw)).padStart(2, '0') : raw.toUpperCase();
                    return `Part${val}`;
                }
            }

            // 2. 中文显式分卷 (如 第1部分, 第2碟, 第3卷)
            const cnExplicitPart = stem.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:部分|部|卷|碟)/);
            if (cnExplicitPart) {
                const numMap = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
                const raw = cnExplicitPart[1];
                const num = /^\d+$/.test(raw) ? Number(raw) : (numMap[raw] || 1);
                return `Part${String(num).padStart(2, '0')}`;
            }

            // 3. 中文上下半部分卷 (如 上集, 下集, 上篇, 下篇, 上半部, [上], [下])
            const cnPart = stem.match(/(?:^|[\s._\-\[【(（])([上中下])(?:集|期|篇|半|部)?(?=$|[\s._\-\]】)）])/);
            if (cnPart) return cnPart[1];

            // 4. 版本/修订单 (导剪版, 加长版, 加更版, 会员版, 纯享版, 公映版, 重制版, Directors Cut, Extended, Theatrical, Unrated, IMAX)
            const editionMatch = stem.match(/(?:Directors?\.Cut|Theatrical|Extended|Remastered|Unrated|IMAX|导剪版|加长版|公映版|重制版|加更版|纯享版|会员版|花絮)/i);
            if (editionMatch) {
                let tag = editionMatch[0].trim();
                if (/directors?[\s.']*cut/i.test(tag)) tag = "Directors.Cut";
                else {
                    tag = tag.replace(/\./g, ' ').trim();
                    if (/extended/i.test(tag)) tag = "Extended";
                    else if (/theatrical/i.test(tag)) tag = "Theatrical";
                    else if (/remastered/i.test(tag)) tag = "Remastered";
                    else if (/unrated/i.test(tag)) tag = "Unrated";
                    else if (/imax/i.test(tag)) tag = "IMAX";
                }
                return tag;
            }

            return '';
        }


        static injectVariantTag(filename, tag) {
            if (!filename || !tag) return filename;
            const [stem, ext] = this.splitExtension(filename);
            if (stem.toLowerCase().includes(tag.toLowerCase())) return filename;
            // 变体（Part01/加更版/Director's Cut）插在季集记号之后、分辨率等技术参数之前，与发布组命名习惯一致
            const anchor = stem.match(/^.*?\bS\d{1,3}(?:[\s._-]*E\d{1,5}(?:\s*-\s*(?:S\d{1,3}\s*)?E?\d{1,5})?)?(?=$|[^A-Za-z0-9])/i);
            if (anchor) {
                return `${stem.slice(0, anchor[0].length)}.${tag}${stem.slice(anchor[0].length)}${ext}`;
            }
            return `${stem}.${tag}${ext}`;
        }


        static inferTitle(value) {
            const rawStem0 = String(value || "");
            // 优先：若包含中文书名号《...》，书名号内即为主剧名
            const bookMatch = rawStem0.match(/《([^》]+)》/);
            if (bookMatch) {
                let bookTitle = bookMatch[1].trim();
                bookTitle = bookTitle.replace(/(?:国语版?|粤语版?|台配|国配|日语|双语|高清|超清|完整版)/gi, ' ').trim();
                const cleanBook = this.cleanAnimeFolderName(bookTitle);
                if (cleanBook && cleanBook.length >= 2) return cleanBook;
            }

            // 若为典型中括号/双中括号动漫文件名，优先调用动漫专用解析提取片名，杜绝被暴力清空
            if (/^[\[【]/.test(rawStem0.trim()) || rawStem0.includes('][') || rawStem0.includes('】【')) {
                const anime = this.parseAnimeFilename(rawStem0);
                if (anime && anime.title && anime.title.length >= 2) {
                    return anime.title;
                }
            }
            const [rawStem] = this.splitExtension(rawStem0);
            let stem = rawStem.replace(/(?:tmdbid|tmdb)[=\-_: ]?\d{2,10}/gi, " ");
            stem = this.stripReleaseGroup(stem);
            stem = stem.replace(/[_.]+/g, " ");

            // 剥离网络抓取广告噪音与爬虫后缀
            stem = stem.replace(/(?:手机在线免费观看|在线免费观看|免费在线观看|在线观看|手机在线|免费观看|9亿国语|9亿|关注微信|电影网|最新发布)/gi, ' ');
            stem = stem.replace(/_\d{6,15}$/, ' ');

            // 剥离文件名开头的音轨/集数序号 (如 "01 幻想魔傳·最遊記-01" -> "幻想魔傳·最遊記-01")
            // 铁律：必须以 0 开头的前导零序号 (如 01, 001)，且后面紧随有效标题字符，绝不可误伤《300 (2006)》等纯数字电影名
            stem = stem.replace(/^0\d{1,2}[\s._\-–—]+(?=[\u3400-\u9fffA-Za-z])/, ' ');
            // 剥离文件名开头的 4 位独立年份 (如 "2015顾嘉辉大师荣休盛典" -> "顾嘉辉大师荣休盛典")
            stem = stem.replace(/^(?:19\d\d|20\d\d)年?\s*(?=[\u3400-\u9fff]{2,})/i, '');

            // 智能截断尾部年份及其后干扰字符 (若年份后紧随中文标题词如 "2009东亚运动会", "2010演唱会", "2015年维也纳", 则属于作品标题不可截断)
            const yearMatches = [...stem.matchAll(/\b(19\d\d|20\d\d)\b/g)];
            for (const ym of yearMatches) {
                if (ym.index >= 2) {
                    const afterYear = stem.slice(ym.index + 4).trim();
                    const isTitleWordAfter = /^(?:年|东亚|香港|台北|红磡|世界|全国|大师|巡回|巡演|经典|精选|现场|盛典|出发|终点站|演唱会|音乐会|歌会|Concert|Live)/i.test(afterYear);
                    if (!isTitleWordAfter) {
                        stem = stem.slice(0, ym.index);
                        break;
                    }
                }
            }

            // 剥离多碟/分卷标记 (如 Disc1, Disc 2, CD1, Part 1) 以便同场演出的多碟文件具有相同标题聚合
            stem = stem.replace(/\b(?:DISC\s*\d+|CD\s*\d+|PART\s*\d+|DISC\d+|CD\d+|PART\d+)\b/gi, ' ');

            // 剥离压制组、规格、音轨噪音
            const technicalRegex = /\b(?:S\d{1,3}(?:E\d{1,5})?|Season\s*\d+|EP?\d{1,5}|Complete|8K|4K|2K|4320p|2160p|1440p|1080p|1080i|720p|576p|480p|WEB[- ]?DL|WEBRip|Blu[- ]?Ray|\bBD\b|\bBDMV\b|\bBDBOX\b|\bDVD\b|REMUX|HDTV|BDRip|HDRip|DVDRip|H[ .]?26[45]|HEVC|AVC|x264|x265|DDP?|AAC\d?|FLAC|TrueHD|Atmos|DTS(?:-HD)?|HDR10\+?|DoVi|DV|60FPS|GP|Remastered|2Audio|3Audio|MNHD|FRDS|PandaQT|DSNP|NF|CR)\b/i;
            const token = stem.match(technicalRegex);
            if (token && token.index >= 2) {
                stem = stem.slice(0, token.index);
            }
            stem = this.stripReleaseGroup(stem);

            // 核心：若前段为中文，且其后紧跟英文外文名（例如 "黑侠 Black Mask"），优先抽取领头中文
            const chineseLead = stem.match(/^([\u3400-\u9fff][\u3400-\u9fff\s·0-9]{0,70}?)(?=\s+[A-Za-z])/);
            if (chineseLead && chineseLead[1].trim().length >= 1) {
                if (!/(?:Concert|Live|Tour|Music|Orchestra)/i.test(stem)) {
                    stem = chineseLead[1];
                }
            }

            // 清洗各种括号、杂项修饰
            stem = stem.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ");
            stem = stem.replace(/(?:美版蓝光剪辑完整版|剪辑完整版|完整版|国粤双语|双语|简繁中字|简繁|中字|国语|粤语|蓝光)/g, " ");
            stem = stem.replace(/^[)\]}）】]+|[)\]}）】]+$/g, " ");
            stem = stem.replace(/^[(\[{（【《]+|[(\[{（【》]+$/g, " ");
            stem = stem.replace(/[\s([{【._-]+$/g, " ");

            // 清理末尾紧跟在中文或字母后的非分隔符集数数字 (如 "守护甜心01" -> "守护甜心", "犬夜叉002" -> "犬夜叉", 排除年份与分辨率)
            const trailingNum = stem.match(/(?<=[\u3400-\u9fffA-Za-z])(\d{2,4})$/);
            if (trailingNum) {
                const epVal = parseInt(trailingNum[1], 10);
                const isResolution = epVal === 480 || epVal === 720 || epVal === 1080 || epVal === 2160;
                const isYear = epVal >= 1970 && epVal <= 2030 && trailingNum[1].length === 4;
                if (!isResolution && !isYear) {
                    stem = stem.slice(0, -trailingNum[1].length).trim();
                }
            }

            let cleaned = this.cleanAnimeFolderName(stem);
            cleaned = this.stripReleaseGroup(cleaned);
            cleaned = this.stripCountryTag(cleaned);
            cleaned = cleaned.replace(/[\s._\-–—~]+$/, '').trim();
            return cleaned;
        }

        /**
         * 针对国内网盘防封与推文引流特征的影视标题纯函数深度清洗
         * 1. 剥离夹杂在汉字之间的防封混淆符号（如 "仙丨逆" -> "仙逆", "完/美/世/界" -> "完美世界"）
         * 2. 剥离常见引流广告词、社群宣传、格式水印与更新状态
         * 3. 剥离无意义的外层方括号与前后缀
         * @param {string} raw 原始标题或推文片段
         * @returns {string} 纯净中文影视片名
         */
        static sanitizeMediaTitle(raw) {
            if (!raw) return '';
            let s = String(raw).trim();
            // 1. 去除无意义的外层括号与引流前缀 (如 【4K国漫】、【最新更新】、[4K修复] 等)
            s = s.replace(/^[\[【（\(](?:4k|1080p|国漫|国漫4k|动漫|连续剧|美剧|韩剧|日剧|短剧|电影|高清|首发|独家|合集|全集|最新|更新|超清)[\]】）\)]\s*/i, '');
            // 2. 剥离常见网盘宣传与广告后缀 (如 "每周日更新", "139网盘", "夸克网盘", "关注防封", "未删减", "更新至xx集", "持续更新", "全集打包")
            s = s.replace(/(?:[._\-\s])?(?:每周[一二三四五六日天]?更[新]?|139网盘|移动云盘|夸克网盘|百度网盘|阿里网盘|关注[^\s._\-]+|防封[^\s._\-]*|未删减[^\s._\-]*|持续更新|更新至\s*\d+\s*[集话]?|全\s*\d+\s*[集话]|全集(?:打包)?|官方原盘|内封字幕|4K超清|HDR版本).*/i, '');
            // 3. 核心防封字符剥离：汉字之间夹带的竖线、全角竖线、斜线、反斜线、点号、顿号、音符等防封干扰符
            s = s.replace(/([\u4e00-\u9fff])\s*[丨|｜/\\丿丶•·~～]\s*([\u4e00-\u9fff])/g, '$1$2');
            s = s.replace(/([\u4e00-\u9fff])\s*[丨|｜/\\丿丶•·~～]\s*([\u4e00-\u9fff])/g, '$1$2');
            s = s.replace(/[丨|｜丶]/g, '');
            // 4. 清洗普通标点与多余空白
            s = s.replace(/^[._\-\s]+|[._\-\s]+$/g, '').trim();
            return s;
        }

        static tmdbSearchQueries(title, rawName = '', englishTitle = '') {
            const sanitizedTitle = this.sanitizeMediaTitle(title);
            const normalized = String(sanitizedTitle || title || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
            const output = [];
            const isStopWord = (s) => {
                if (!s) return true;
                const clean = s.trim().toLowerCase().replace(/[\s:：·・•_.,\-—]+/g, '');
                // 核心修复：中文单字具有独立完整语义，放宽至 minLen = 1；西文保持 minLen = 2
                const minLen = /[\u4e00-\u9fff]/.test(clean) ? 1 : 2;
                if (clean.length < minLen || /^\d+$/.test(clean)) return true;
                return /^(?:演唱会|音乐会|歌会|音乐节|独唱会|演奏会|作品|合集|全集|精选|典藏|现场|双碟|套装|特别篇|剧场版|电影|动画|纪录片|concerts?|live|tour|worldtour|livehouse|special|music|band|bluray|remux|1080[pi]|720[pi]|2160[pi]|4k|iso|mkv)$/i.test(clean);
            };
            const add = (val) => {
                let q = String(val || "").replace(/^[)\]}）】]+|[)\]}）】]+$/g, "").replace(/^[(\[{（【《]+|[(\[{（【》]+$/g, "").replace(/\s+/g, " ").trim();
                if (!q || /^(?:mkv|mp4|avi|ts|iso|flv|wmv|rmvb|mov|vob)$/i.test(q)) return;
                if (isStopWord(q)) return;
                const minLen = /[\u4e00-\u9fff]/.test(q) ? 1 : 2;
                if (q.length >= minLen && !output.some(item => item.toLocaleLowerCase() === q.toLocaleLowerCase())) {
                    output.push(q);
                }
            };
            const addIfValid = (candidate) => {
                if (!candidate) return;
                const minLen = /[\u4e00-\u9fff]/.test(candidate) ? 1 : 2;
                if (candidate.length >= minLen) add(candidate);
            };

            // 智能适配：若第2个参数形如英文副标题而非文件名
            if (typeof rawName === 'string' && !englishTitle && /[a-zA-Z]{2,}/.test(rawName) && !rawName.includes('.')) {
                if (!/^[\-_–—]/.test(rawName.trim())) englishTitle = rawName;
            }

            // 0. 优先保留包含年份/数字的纯净原名 (如 "警察故事2013"、"花田喜事2010")
            if (rawName) {
                const cleanRawStem = this.cleanAnimeFolderName(this.splitExtension(rawName)[0]);
                if (cleanRawStem && cleanRawStem.length >= 2 && !this.isGenericFolder(cleanRawStem)) {
                    addIfValid(cleanRawStem);
                }
            }

            // 普适简繁对偶检索变体扩充 (支持大陆搜港台繁体条目，以及港台原版搜大陆简体条目)
            if (/[\u4e00-\u9fff]/.test(normalized)) {
                const simp = this.toSimplified(normalized);
                if (simp && simp !== normalized) addIfValid(simp);
                const trad = this.toTraditional(normalized);
                if (trad && trad !== normalized) addIfValid(trad);
            }

            // 1. 【中文主标题绝对最高优先级】
            const inferred = this.inferTitle(normalized);
            addIfValid(inferred);

            // 智能剥离独立国别标签后的纯净主词优先检索
            const strippedCountry = this.stripCountryTag(inferred || normalized);
            if (strippedCountry && strippedCountry !== inferred && strippedCountry !== normalized) {
                addIfValid(strippedCountry);
            }

            addIfValid(normalized);

            // 2. 双语拆分解耦
            const bi = this.splitBilingualTitle(normalized);
            if (bi.title && bi.title !== normalized) {
                addIfValid(bi.title);
            }

            // 3. 英文副标题多级降级检索 (作为次级备用候补，严禁主客颠倒)
            if (englishTitle) {
                add(englishTitle);
                const degEn = englishTitle.replace(/\b(?:Concerts?|Live\s*\d*|World\s*Tour|Tour|Special|Livehouse)\b/gi, '').replace(/[-_:]+/g, ' ').trim();
                if (degEn && degEn.length >= 2) add(degEn);
            }
            if (bi.englishTitle) {
                add(bi.englishTitle);
                const degBiEn = bi.englishTitle.replace(/\b(?:Concerts?|Live\s*\d*|World\s*Tour|Tour|Special|Livehouse)\b/gi, '').replace(/[-_:]+/g, ' ').trim();
                if (degBiEn && degBiEn.length >= 2) add(degBiEn);
            }

            // 剥离尾部光盘介质修饰词 (如 "Mayn Special Concert BD" -> "Mayn Special Concert")
            const noDiscMedia = normalized.replace(/\b(?:BD|BDMV|BDBOX|DVD|Blu[- ]?Ray|REMUX)\b/gi, ' ').replace(/\s+/g, ' ').trim();
            if (noDiscMedia && noDiscMedia !== normalized) {
                addIfValid(noDiscMedia);
            }

            // 西文人名缩写别名自动扩充 (如 Mayn -> May'n)
            if (/\bMayn\b/i.test(normalized)) {
                add(normalized.replace(/\bMayn\b/gi, "May'n"));
                if (noDiscMedia) add(noDiscMedia.replace(/\bMayn\b/gi, "May'n"));
            }

            // 针对演唱会公演日期自动扩充带日期的检索词 (如 "Animelo Summer Live 2008 8.30", "Animelo Summer Live 2010 8.28")
            const concertDate = this.extractConcertDate(rawName) || this.extractConcertDate(normalized);
            if (concertDate) {
                add(`${normalized} ${concertDate}`);
                if (noDiscMedia && noDiscMedia !== normalized) add(`${noDiscMedia} ${concertDate}`);
            }

            // 3. 中文多级降级：场馆、赛事、荣休等杂质剥离与核心主语提取
            const primaryCn = bi.title || normalized;
            if (primaryCn && /[\u4e00-\u9fff]/.test(primaryCn)) {
                add(primaryCn);

                // 针对演唱会/音乐会：若标题未显式包含“演唱会”，自动扩充 "[片名]演唱会" 检索词
                if (/演唱会|音乐会|歌会|Live|Concert/i.test(normalized + ' ' + rawName)) {
                    const cleanForConcert = primaryCn.replace(/(?:演唱会|音乐会|歌会)/g, '').trim();
                    if (cleanForConcert && cleanForConcert.length >= 2) {
                        add(`${cleanForConcert}演唱会`);
                    }
                }
                const concertFluffRegex = /(?:\d{4}年?|\d+东亚运动会|东亚运动会|奥运会|新年音乐会|荣休盛典|双碟套装|作品集|世界巡回|全球巡回|巡回|巡演|红磡|红馆|台北小巨蛋|小巨蛋|梅赛德斯奔驰文化中心|体育馆|香港体育馆|体育场|大剧院|文化中心|音乐厅|武道馆|东京巨蛋|皇家阿尔伯特|工体|大舞台|哥本哈根|维也纳)/gi;
                const strippedFluff = primaryCn.replace(concertFluffRegex, ' ').replace(/\s+/g, ' ').trim();
                addIfValid(strippedFluff);
                const strippedConcert = strippedFluff.replace(/(?:演唱会|音乐会|歌会|音乐节|独唱会|演奏会)/g, ' ').replace(/\s+/g, ' ').trim();
                addIfValid(strippedConcert);
                const subParts = primaryCn.split(/[：:\-_—\/／]/);
                if (subParts.length > 1) {
                    subParts.forEach(p => {
                        const cleanP = p.trim().replace(/(?:演唱会|音乐会)/g, '').trim();
                        addIfValid(cleanP);
                    });
                }
            }

            // 影视主副标题结构助词「之」与空格双向等价扩充 (如 "热血上海滩 末路计中计" 扩充 "热血上海滩之末路计中计")
            if (normalized.includes(' ') && /[\u4e00-\u9fff]{2,}\s+[\u4e00-\u9fff]{2,}/.test(normalized)) {
                const zhiVariant = normalized.replace(/\s+/g, '之');
                addIfValid(zhiVariant);
            }
            if (normalized.includes('之') && /[\u4e00-\u9fff]{2,}之[\u4e00-\u9fff]{2,}/.test(normalized)) {
                const spaceVariant = normalized.replace(/之/g, ' ');
                addIfValid(spaceVariant);
            }

            // 若传入了原文件名且包含更完整片名 (如文件名含有《我们这一家》而目录名为简写'我们这家')
            if (rawName && rawName !== englishTitle) {
                const bm = rawName.match(/《([^》]+)》/);
                if (bm) {
                    const btitle = bm[1].replace(/(?:国语版?|粤语版?|台配|国配|日语|双语|高清|超清|完整版)/gi, ' ').trim();
                    const cleanB = this.cleanAnimeFolderName(btitle);
                    addIfValid(cleanB);
                }
                const fnInferred = this.inferTitle(rawName);
                addIfValid(fnInferred);
            }

            // 去除前缀高/告噪音 (如 告-、高-)
            if (/^[告高]/.test(normalized) && normalized.length >= 3) {
                const stripped = normalized.replace(/^[告高]/, '').trim();
                addIfValid(stripped);
            }

            // 联动通用动漫别名库：自动扩充全部已知译名（中、英、别名互通）
            const aliases = this.getAliases(normalized).concat(this.getAliases(englishTitle));
            aliases.forEach(alias => add(alias));

            // 纯中文
            const cnOnly = (normalized.match(/[\u4e00-\u9fff]+/g) || []).join(" ");
            if (cnOnly) add(cnOnly);

            // 去除点号/标点变体 (如 "西游·伏妖篇" -> "西游伏妖篇", "西游·降魔篇" -> "西游降魔篇")
            if (/[·・•:：\-—_.,，'"“”‘’()（）\[\]【】]/.test(normalized)) {
                const cleanPunct = normalized.replace(/[·・•:：\-—_.,，'"“”‘’()（）\[\]【】\s]+/g, "");
                addIfValid(cleanPunct);
                const spacePunct = normalized.replace(/[·・•:：\-—_.,，'"“”‘’()（）\[\]【】]+/g, " ").trim();
                if (spacePunct && spacePunct !== cleanPunct) add(spacePunct);
            }

            // 罗马数字转换 (如 "鹿鼎记II" -> "鹿鼎记2", "逃学威龙III" -> "逃学威龙3")
            if (/\b(?:II|III|IV|V)\b/i.test(normalized) || /[ⅡⅢⅣⅤ]/.test(normalized)) {
                const converted = normalized
                    .replace(/\bIV\b|[Ⅳ]/gi, "4")
                    .replace(/\bIII\b|[Ⅲ]/gi, "3")
                    .replace(/\bII\b|[Ⅱ]/gi, "2")
                    .replace(/\bV\b|[Ⅴ]/gi, "5");
                add(converted);
                add(converted.replace(/[\s:：\-—]+/g, ""));
            }

            // 通用主副标题解耦与变体提取 (仅支持明确的标点符号如 "主标题：副标题", "主标题 - 副标题"，严禁拆解汉字自然词汇如《候鸟之恋》)
            if (/[:：\-–—]/.test(normalized)) {
                const subParts = normalized.split(/[:：\-–—]/).map(p => p.trim()).filter(Boolean);
                if (subParts.length >= 2) {
                    const leadTitle = subParts[0];
                    if (leadTitle.length >= 3) addIfValid(leadTitle);
                }
            }
            const noChapter = normalized.replace(/(?:第[零一二三四五六七八九十百\d]+[回部集话話期]|大结局)/g, "").replace(/\s+/g, " ").trim();
            if (noChapter && noChapter !== normalized) {
                addIfValid(noChapter);
            }

            // 纯英文外文名提取 (剥离扩展名及音视频压制标签，严禁使用技术词与残渣检索)
            const rawWithoutExt = String(rawName || "").replace(/\.[^.]+$/, "");
            const hasExplicitChinese = /[\u4e00-\u9fff]/.test(rawWithoutExt);
            const isTechParam = (w) => {
                return /^(?:mkv|mp4|avi|ts|iso|flv|wmv|mov|rmvb|vob|sdr|hdr\d*|dovi|dv|bluray|bdrip|brrip|remux|web[-_]?dl|webrip|hdtv|dvd|uhd|ac3|eac3|ddp\d*|dd\b|truehd|atmos|dts(?:[-_]?hd)?(?:[-_]?ma)?|flac|aac\d*|mp[23]|lpcm|pcm|opus|ogg|h[\s._-]*26[45]|x26[45]|avc|hevc|vc[-_]?1|mpeg[-_]?\d*|vp9|av1|fps|\d+fps|\d+[pi]|4k|2k|8k|10bit|8bit|12bit|5\.1|7\.1|2\.0|1\.0|\d+ch|2audio|3audio|mnhd|frds|dsnp|pandaqt|flux|wiki|chd|hds)$/i.test(w);
            };
            const enCandidateTokens = (rawWithoutExt.match(/[A-Za-z][A-Za-z0-9'’:-]*/g) || [])
                .filter(w => !isTechParam(w) && w.length >= 2);
            if (enCandidateTokens.length > 0) {
                const enCandidate = enCandidateTokens.join(" ");
                // 中文为主的文件需至少2个连续合法西文单词且总长>=5才视为有效双语副标题；纯外文文件>=3字符放行
                if (hasExplicitChinese ? (enCandidateTokens.length >= 2 && enCandidate.length >= 5) : enCandidate.length >= 3) {
                    add(enCandidate);
                }
            }

            return output;
        }

        // ★ 通用分部标记提取器 (支持 先导片上/下、第1期上/下、Part 1/2、Pt.1/2、上集/下集、前篇/后篇、S01E01A/B、EP01-1/2)

        static extractPartIndicator(text) {
            if (!text) return null;
            const str = String(text);

            // 1. 中文常见分部标记
            // A. 显式结构词：如“上集/下集”、“上篇/下篇”、“前篇/后篇”、“上半场/下半场”、“上部/下部”
            const explicitPart = str.match(/(?:[\[(（【_.\-\s]|^|\b)(上|下|中)(?:[集篇期段场次部]|半场)(?=[\])）】_.\-\s\d]|$)/i)
                || str.match(/(?:[\[(（【_.\-\s]|^|\b)(前|后)篇(?=[\])）】_.\-\s\d]|$)/i);
            if (explicitPart) {
                const val = explicitPart[1];
                if (val === '上' || val === '前') return { raw: val, canonical: '上', index: 1 };
                if (val === '下' || val === '后') return { raw: val, canonical: '下', index: 2 };
                if (val === '中') return { raw: val, canonical: '中', index: 3 };
            }

            // B. 期号/集号后直接紧随 上/下/中：如“第1期上”、“第12集下”
            const periodPart = str.match(/第\s*\d{1,3}\s*[期集话話]\s*(上|下|中)(?=[^\u4e00-\u9fa5\w]|$)/i);
            if (periodPart) {
                const val = periodPart[1];
                return { raw: val, canonical: val, index: val === '上' ? 1 : (val === '下' ? 2 : 3) };
            }

            // C. 括号/分隔符独立包裹的 上/下/中：如“(上)”、“[下]”、“【中】”、“·上·”、“_下_”、“ - 上 - ”
            const bracketPart = str.match(/[\[(（【<]\s*(上|下|中)\s*[\])）】>]/i)
                || str.match(/(?:^|[. _\-\s])(上|下|中)(?=[. _\-\s]|$)/i);
            if (bracketPart) {
                const val = bracketPart[1];
                return { raw: val, canonical: val, index: val === '上' ? 1 : (val === '下' ? 2 : 3) };
            }

            // D. 影视特殊关键词后置或结尾锚定：如“先导片下”、“特辑上”、“名场面特辑下”、“加更上”
            // 仅当前置为数字、集数、期数、或特定影视部类尾字（期、集、片、辑、更、享、絮、外、蛋、顾、编、划、版、场、客）
            const tailPart = str.match(/(?<=[0-9期集话話片辑更享絮外蛋顾编划版场客])\s*(上|下|中)(?=[. _\-[\]()（）】]|\.[a-zA-Z0-9]+$|$)/i);
            if (tailPart) {
                const val = tailPart[1];
                return { raw: val, canonical: val, index: val === '上' ? 1 : (val === '下' ? 2 : 3) };
            }

            // 2. 英文常见分部标记: Part 1 / Part 2 / Pt.1 / Pt 2 / Part A / Part B / EP01-1 / EP01-2
            // 严格限制：E\d+ 必须有显式连接符 (E01-1, E01_1) 或字母变体 (E01A, E01B)，绝不误伤普通的 E01/E02
            const enPartMatch = str.match(/\b(?:Part|Pt)[ ._\-]*([0-9]+|[A-Za-z])\b/i)
                || str.match(/\b(?:S\d{1,3})?(?:EP?|Episode)\d{1,4}[ ._\-]+([123AB])\b/i)
                || str.match(/\b(?:S\d{1,3})?(?:EP?|Episode)\d{1,4}([AB])\b/i)
                || str.match(/\b(?:CD|Disc|Disk)\s*([0-9]+|[A-Za-z])\b/i);

            if (enPartMatch) {
                const raw = enPartMatch[1];
                const num = parseInt(raw, 10);
                if (!isNaN(num)) {
                    const canonical = num === 1 ? '上' : (num === 2 ? '下' : (num === 3 ? '中' : String(num)));
                    return { raw, canonical, index: num };
                }
                const upper = raw.toUpperCase();
                if (upper === 'A') return { raw, canonical: '上', index: 1 };
                if (upper === 'B') return { raw, canonical: '下', index: 2 };
                if (upper === 'C') return { raw, canonical: '中', index: 3 };
            }

            return null;
        }

        // 增强版 parseSeasonEpisode：完全移植 123 助手的季集解析与连集判定

        static parseSeasonEpisode(filename, defaultSeason = 1) {
            // ★ 预处理彻底清洗 \d{3,4}x\d{3,4} 分辨率规格 (如 3840x1608, 1920x1080)，杜绝宽银幕高度被误抓为集数
            const clean = String(filename || '').replace(/\.[^.]+$/, '').replace(/\b\d{3,4}\s*[xX*×]\s*\d{3,4}\b/g, ' ');
            const partIndicator = this.extractPartIndicator(clean) || this.extractPartIndicator(filename);

            // ★ 1. 日期型集数解析优先 (综艺 2024.05.01)
            // 必须先于特殊篇检测，防止日期中的月份 (01) 被 isSpecialEpisodeHint 的 /\b(\d{1,3})\b/ 误抓为特殊篇集数
            // 注意：parseEpisodeAirDate 内部自行 strip 扩展名，此处传原始 filename 避免双重 strip 破坏日期 (如 2026.01.03 → 2026.01)
            const airDate = this.parseEpisodeAirDate(filename);

            // ★ 1.5 核心硬证据优先：显式正片季集标记 (如 S01E01, S05E06) 属于一级不可动摇之硬证据！
            // 唯有当文件名未携带显式正片季号（或显式声明为 S00）时，副标题中的描述性词汇（特典/花絮/番外/OVA）才允许作为特别篇辅助证据
            const explicitSeasonMatch = clean.match(/\bS(\d{1,3})[ ._-]*E(\d{1,5})(?:[ ._-]*(?:E|-E?)(\d{1,5}))?/i);
            if (explicitSeasonMatch) {
                const season = Number(explicitSeasonMatch[1]);
                const episode = Number(explicitSeasonMatch[2]);
                const endEpisode = Number(explicitSeasonMatch[3] || 0);
                return { season, episode, endEpisode, disc: 0, isSpecial: season === 0, hasEpisode: true };
            }

            // ★ 2. 特殊集数侦测 (先导片、花絮、番外、OVA、OAD、SP、特辑、剧场版 -> Season 0 / 特别篇)
            const specialHint = this.isSpecialEpisodeHint(clean);
            if (specialHint) {
                const periodMatch = clean.match(/第\s*(\d{1,3})\s*期\s*(上|下|中)?/i);
                const periodNum = periodMatch ? parseInt(periodMatch[1], 10) : undefined;
                const periodPart = (periodMatch && periodMatch[2]) ? periodMatch[2] : (partIndicator ? partIndicator.canonical : undefined);

                const taggedMatch = clean.match(/(?:OVA|OAD|ONA|SP|特别篇|番外|加更|彩蛋|剧场版|EP?)\s*(\d{1,4})/i)
                    || clean.match(/[\[【(]\s*(\d{1,3})\s*[\]】)]/);
                let ep = 0;
                if (taggedMatch) {
                    ep = parseInt(taggedMatch[1], 10);
                } else if (!airDate) {
                    const epNumMatch = clean.match(/\b(\d{1,3})\b/);
                    if (epNumMatch) {
                        const v = parseInt(epNumMatch[1], 10);
                        if (v > 0 && v !== 480 && v !== 720 && v !== 1080 && v !== 2160) ep = v;
                    }
                }

                if (airDate) {
                    return {
                        season: 0,
                        episode: ep,
                        endEpisode: 0,
                        airDate,
                        isDate: true,
                        isSpecial: true,
                        specialKind: specialHint.label,
                        hasEpisode: Boolean(ep),
                        periodNum,
                        periodPart
                    };
                }
                return { season: 0, episode: ep || 1, endEpisode: 0, isSpecial: true, specialKind: specialHint.label, hasEpisode: Boolean(ep), periodNum, periodPart };
            }

            // ★ 3. 纯日期型（非特殊篇）：同时提取综艺期号上下期信息（第X期 上/下）
            if (airDate) {
                const periodMatch = clean.match(/第\s*(\d{1,3})\s*期\s*(上|下|中)/i);
                if (periodMatch) {
                    const periodNum = parseInt(periodMatch[1], 10);
                    const periodPart = periodMatch[2];
                    const episode = (periodNum - 1) * 2 + (periodPart === '下' ? 2 : (periodPart === '中' ? 2 : 1));
                    return { season: defaultSeason, episode, endEpisode: 0, airDate, isDate: true, isSpecial: false, hasEpisode: true, periodNum, periodPart, partIndicator };
                }
                const effPart = partIndicator ? partIndicator.canonical : undefined;
                return { season: defaultSeason, episode: 1, endEpisode: 0, airDate, isDate: true, isSpecial: false, hasEpisode: true, periodPart: effPart, partIndicator };
            }

            // 3. 原盘/光盘分卷解析 (如 S01.D01, Disc 1, D01, Disc2)
            const discM = clean.match(/(?:^|[ ._\-[\]【】])(?:(?:S|Season)\s*(\d{1,3})[ ._\-]*)?(?:Disc|Disk|D)\s*(\d{1,2})(?=$|[ ._\-[\]【】])/i);
            let discNum = 0;
            let discSeason = 0;
            if (discM) {
                if (discM[1]) discSeason = Number(discM[1]);
                discNum = Number(discM[2]);
            }

            // 4. 123 助手原版规则 1: S01E01[-E02]
            let match = clean.match(/\bS(\d{1,3})[ ._-]*E(\d{1,5})(?:[ ._-]*(?:E|-E?)(\d{1,5}))?/i);
            if (match) {
                const season = Number(match[1]);
                const episode = Number(match[2]);
                const endEpisode = Number(match[3] || 0);
                return { season, episode, endEpisode, disc: discNum, isSpecial: season === 0, hasEpisode: true };
            }

            // 5. 123 助手原版规则 2: 1x05
            match = clean.match(/(?:^|[ ._\-[\[【])(\d{1,3})x(\d{1,5})(?=$|[ ._\-\]】])/i);
            if (match) {
                const season = Number(match[1]);
                const episode = Number(match[2]);
                return { season, episode, endEpisode: 0, disc: discNum, isSpecial: season === 0, hasEpisode: true };
            }

            // 6. 123 助手原版规则 3: EP01-EP02 / E01-02
            match = clean.match(/(?:^|[ ._\-[\[【])(?:E|EP|Episode)\s*(\d{1,5})\s*[-~到至]\s*(?:E|EP|Episode)?\s*(\d{1,5})(?=$|[ ._\-\]】])/i);
            if (match) {
                const season = Number(discSeason || defaultSeason || 1);
                const episode = Number(match[1]);
                const endEpisode = Number(match[2] || 0);
                return { season, episode, endEpisode, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 7. 123 助手原版规则 4: 中文跨集 第1-2集
            match = clean.match(/第\s*([0-9零〇一二两兩三四五六七八九十百]+)\s*(?:[期集话話])?\s*[-~到至]\s*(?:第\s*)?([0-9零〇一二两兩三四五六七八九十百]+)\s*[期集话話]/i);
            if (match) {
                const season = Number(discSeason || defaultSeason || 1);
                const episode = this.chineseInteger(match[1]);
                const endEpisode = this.chineseInteger(match[2]);
                if (episode > 0 && endEpisode > 0) return { season, episode, endEpisode, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 8. 123 助手原版规则 5: 第2季第5集
            match = clean.match(/(?:第\s*)?([0-9零〇一二两兩三四五六七八九十百]+)\s*季[^\d\u3400-\u9fffA-Za-z]{0,8}第\s*([0-9零〇一二两兩三四五六七八九十百]+)\s*[期集话話]/i);
            if (match) {
                const season = this.chineseInteger(match[1]);
                const episode = this.chineseInteger(match[2]);
                if (season >= 0 && episode > 0) return { season, episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 9. 123 助手原版规则 6: Season 1 Episode 5
            match = clean.match(/(?:Season|第)\s*(\d{1,3})\s*(?:季)?[^\d]{0,8}(?:Episode|Ep|E|第)\s*(\d{1,5})/i);
            if (match) {
                const season = Number(match[1]);
                const episode = Number(match[2]);
                return { season, episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 9.5 综艺周播期号上/下期 (第1期上, 第8期下, 第3期中 -> 用于综艺双播分集对齐)
            // 保留期号与上下卷信息，由 buildPreview 多维打分引擎二次比对 TMDB 官方分集
            match = clean.match(/第\s*(\d{1,3})\s*期\s*(上|下|中)/i);
            if (match) {
                const season = Number(discSeason || defaultSeason || 1);
                const periodNum = parseInt(match[1], 10);
                const part = match[2]; // '上' or '下' or '中'
                // 期号近似映射：第1期上≈E1, 第1期下≈E2, 第2期上≈E3... (精确对齐由 buildPreview 多维打分完成)
                const episode = (periodNum - 1) * 2 + (part === '下' ? 2 : (part === '中' ? 2 : 1));
                return { season, episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true, periodNum, periodPart: part };
            }

            // 10. 123 助手原版规则 7: 第5集
            match = clean.match(/第\s*([0-9零〇一二两兩三四五六七八九十百]+)\s*[期集话話]/i);
            if (match) {
                const season = Number(discSeason || defaultSeason || 1);
                const episode = this.chineseInteger(match[1]);
                if (episode > 0) return { season, episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 11. 123 助手原版规则 8: EP05 / E05
            match = clean.match(/(?:^|[ ._\-[\[【])(EP?|第)\s*(\d{1,5})(?:\s*[集期])?(?=$|[ ._\-\]】])/i);
            if (match) {
                const season = Number(discSeason || defaultSeason || 1);
                const episode = Number(match[2]);
                return { season, episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            // 11.1 Windows 批量/重复序号与圆括号集数 (如 "1 (8)", "1 (2)", "(08)", "宝石之国 (03)")
            const parenMatch = clean.match(/^(?:(?:\d+|[^\d]+)\s+)?[（(](\d{1,4})[)）](?:\s.*)?$/);
            if (parenMatch) {
                const ep = parseInt(parenMatch[1], 10);
                if (ep > 0 && ep <= 2000 && !(ep >= 1970 && ep <= 2030)) {
                    return { season: Number(discSeason || defaultSeason || 1), episode: ep, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
                }
            }

            // 11.2 首部前导零集数序号 (如 "01 进击的巨人", "01.进击的巨人", "08 薄樱鬼")
            // 普适语法铁律：作为前置集数序号，必须以 0 开头 (01~099) 且后面必须具备显式语法分隔符 (空格/点号/下划线/破折号)！
            // 凡是无分隔符紧密连写的词汇 (如 72小时, 749局, 300勇士, 12怒汉, 28天后, 21座桥, 8佰, 007大战皇家赌场) 在词法上全部属于不可分割的作品原名，绝不截断误判为集数！
            if (!/^007(?:[\s._·:：\-–—]|$)/i.test(clean)) {
                const leadingMatch = clean.match(/^0(\d{1,3})[\s._\-–—]+(?=[\u3400-\u9fffA-Za-z])/);
                if (leadingMatch) {
                    const ep = parseInt(leadingMatch[1], 10);
                    if (ep > 0 && ep <= 2000 && ep !== 480 && ep !== 720 && ep !== 1080 && ep !== 2160 && !(ep >= 1970 && ep <= 2030)) {
                        return { season: Number(discSeason || defaultSeason || 1), episode: ep, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
                    }
                }
            }

            // 11.3 中文或英文字母直接紧跟纯数字集数 (如 "守护甜心01", "守护甜心02", "犬夜叉002", "海贼王1088", "柯南01")
            // 排除技术参数 (如 x264, x265, h264, h265, 10bit, 60fps, 23.976fps 等)
            const trailingClean = clean
                .replace(/\b\d{3,4}\s*[xX*×]\s*\d{3,4}\b/g, ' ')
                .replace(/\b\d+(?:\.\d+)+\s*(?:fps)?\b/gi, ' ')
                .replace(/\b(?:[xXhH]\.?26[45]|hevc|avc|\d{1,2}bit|\d{2,3}(?:\.\d+)?\s*fps|[57]\.1|aac\d*|ac3|dts(?:-hd)?|flac)\b/gi, ' ');
            const trailingMatch = trailingClean.match(/(?:[\u3400-\u9fffA-Za-z]+?)(\d{1,4})(?:[ ._\-[\]【】()（）]|$)/);
            if (trailingMatch) {
                const rawDigits = trailingMatch[1];
                const ep = parseInt(rawDigits, 10);
                const isResolution = ep === 480 || ep === 720 || ep === 1080 || ep === 2160;
                const isYear = ep >= 1970 && ep <= 2030 && rawDigits.length === 4;
                const isSingleDigitWithoutZero = rawDigits.length === 1 && ep >= 1 && ep <= 9;
                const isTechNumber = ep === 264 || ep === 265 || ep === 10 || ep === 8 || ep === 12;
                if (!isResolution && !isYear && !isTechNumber && (!isSingleDigitWithoutZero || rawDigits.startsWith('0')) && ep > 0 && ep <= 2000) {
                    return { season: Number(discSeason || defaultSeason || 1), episode: ep, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
                }
            }

            // 12. 动漫方括号集数解析 (如 [03], [18 END], [001], [01v2])
            // 彻底清洗音频声道、浮点小数(如 23.976fps)与技术参数 (杜绝 DTS-HD MA 5.1 / TrueHD 7.1 / 23.976fps 的 23 或 5 被误抓为集数)
            const cleanWithoutTech = clean
                .replace(/\b\d{3,4}\s*[xX*×]\s*\d{3,4}\b/g, ' ')
                .replace(/\b(?:MA|DTS(?:-HD)?|TRUEHD|DDP?|AC3|AAC|LPCM|PCM|FLAC|DD)?\s*[1257]\.[012]\b/gi, ' ')
                .replace(/\b\d+(?:\.\d+)+\s*(?:fps)?\b/gi, ' ')
                .replace(/\b(?:[xXhH]\.?26[45]|hevc|avc|\d{1,2}bit|\d{2,3}(?:\.\d+)?\s*fps)\b/gi, ' ');

            const animeParsed = this.parseAnimeFilename(cleanWithoutTech);
            if (animeParsed.episode !== null && animeParsed.episode > 0) {
                return { season: Number(discSeason || defaultSeason || 1), episode: animeParsed.episode, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
            }

            const epPattern = /(?:^|[ ._\-[\[【])(?:EP?|第)?\s*(\d{1,4})\s*(?:v\d+|END|Fin|完|话|話|集)?(?:\s*\(\d+\))?(?=$|[ _\-\]】]|\.(?!\d))/i.exec(cleanWithoutTech);
            if (epPattern) {
                const epVal = parseInt(epPattern[1], 10);
                const isAudioChannelNumber = (epVal === 5 || epVal === 7 || epVal === 2 || epVal === 1) && /(?:5\.1|7\.1|2\.0|5\.0|2\.1|1\.0)/.test(clean);
                const isResHeight = [480, 536, 576, 720, 800, 804, 960, 1040, 1080, 1440, 1600, 1608, 1800, 2160].includes(epVal);
                if (!isAudioChannelNumber && !isResHeight && epVal > 0 && epVal <= 2000 && epVal !== 264 && epVal !== 265 && !(epVal >= 1970 && epVal <= 2030)) {
                    return { season: Number(discSeason || defaultSeason || 1), episode: epVal, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: true };
                }
            }

            // 13. 若仅识别出光盘分卷 (D01 / Disc 1)，返回 disc 标识
            if (discNum > 0) {
                return { season: Number(discSeason || defaultSeason || 1), episode: 1, endEpisode: 0, disc: discNum, isSpecial: false, hasEpisode: false };
            }

            return { season: defaultSeason, episode: 1, endEpisode: 0, isSpecial: false, hasEpisode: false };
        }


        static checkCandidateConflict(fileItem, candidate, group = null) {
            if (!candidate || !fileItem || !fileItem.name) return false;

            // ★ 核心豁免 1: 联动 Translations 官方全区域译名证据链验证
            // 若 TMDB 官方 Translations 列表中已经完全精准命中了原文件名或待整理分组标题（经 normalizeCompare 一致），
            // 证明该候选条目即为官方认可的同作品多地区公映译本（如《铁雨2》港台官方公映译名《鋼鐵雨：深潛行動》），
            // 地区代数/别名差异为官方合法命名，直接豁免放行，坚决杜绝误判为冲突熔断！
            const targetNormTitle = this.normalizeCompare(group?.title || '');
            const targetNormFileName = this.normalizeCompare(fileItem?.name || '');
            const transList = Array.isArray(candidate.translatedTitles)
                ? candidate.translatedTitles
                : (Array.isArray(candidate.translatedTitles?.titles) ? candidate.translatedTitles.titles : []);
            if (transList.length > 0) {
                const hasOfficialTranslationHit = transList.some(t => {
                    const nt = this.normalizeCompare(t);
                    return nt && (nt === targetNormTitle || nt === targetNormFileName ||
                        (nt.length >= 4 && (targetNormTitle.includes(nt) || nt.includes(targetNormTitle) || targetNormFileName.includes(nt) || nt.includes(targetNormFileName))));
                });
                if (hasOfficialTranslationHit) {
                    return false; // 官方译名确凿命中，绝无冲突！
                }
            }

            // 年份严重冲突检测：若原文件或待整理分组具备明确年份，而候选条目年份与目标年份相差超过 1 年，一票熔断拒绝采纳！
            const targetYear = group?.year || RecognitionEngine.extractYear(fileItem?.name) || RecognitionEngine.extractYear(group?.title);
            const candYear = candidate?.year ? String(candidate.year) : '';
            if (targetYear && candYear) {
                const diff = Math.abs(parseInt(targetYear, 10) - parseInt(candYear, 10));
                if (diff > 1) {
                    return true; // 跨年份严重冲突，直接熔断！
                }
            }

            // 续集编号严重冲突检测：若原文件名或分组存在续集代数 (如《神偷奶爸3》)，而候选代数不符，一票熔断！
            const targetSeq = RecognitionEngine.extractSequelNum(group?.title) || RecognitionEngine.extractSequelNum(fileItem?.name);
            const candSeq = RecognitionEngine.extractSequelNum(candidate?.title) || RecognitionEngine.extractSequelNum(candidate?.originalTitle);
            if (targetSeq || candSeq) {
                if (!targetSeq || !candSeq || targetSeq !== candSeq) {
                    return true; // 续集代数冲突，熔断保护！
                }
            }

            // 演出日期冲突检测：若原文件有明确日期，候选条目有不同日期，直接熔断
            const fileDate = RecognitionEngine.extractConcertDate(fileItem.name) || RecognitionEngine.extractConcertDate(group?.title);
            const candDate = RecognitionEngine.extractConcertDate(candidate.title) || RecognitionEngine.extractConcertDate(candidate.originalTitle);
            if (fileDate && candDate && fileDate !== candDate) {
                return true;
            }

            // 国别严重冲突检测：若原文件明确指定国别 (如 "如父如子 意大利")，而候选完全属于完全互斥的其它国家且无年份强绑定，直接熔断防串
            const groupCountryCode = group?.countryCode || '';
            if (groupCountryCode && !group?.year) {
                const candCountries = (Array.isArray(candidate.origin_country) ? candidate.origin_country : [])
                    .concat((candidate.production_countries || []).map(p => p.iso_3166_1 || p.name))
                    .filter(Boolean).map(c => String(c).toUpperCase());
                if (candCountries.length > 0 && !candCountries.includes(groupCountryCode.toUpperCase()) && !candCountries.some(c => c.includes(groupCountryCode.toUpperCase()))) {
                    return true;
                }
            }

            const candTitle = String(candidate.title || candidate.name || '').toLowerCase();
            const candOrig = String(candidate.originalTitle || candidate.originalName || '').toLowerCase();
            const groupTitle = String(group?.title || '').toLowerCase();
            const folderName = String(fileItem.parentFolderName || '').toLowerCase();

            // 1. 检查是否属于同一个通用动漫别名家族 (如 神奇宝贝 / 宝可梦 / Pokemon / Pocket Monsters)
            const candAliases = this.getAliases(candTitle).concat(this.getAliases(candOrig));
            const fileAliases = this.getAliases(groupTitle).concat(this.getAliases(folderName)).concat(this.getAliases(fileItem.name));

            const sharesAlias = candAliases.some(ca => fileAliases.includes(ca)) ||
                candAliases.some(ca => fileItem.name.toLowerCase().includes(ca.toLowerCase()) || folderName.includes(ca.toLowerCase()) || groupTitle.includes(ca.toLowerCase())) ||
                fileAliases.some(fa => candTitle.includes(fa.toLowerCase()) || candOrig.includes(fa.toLowerCase()));
            if (sharesAlias) {
                return false; // 候选与待整理文件同属一个别名体系，绝无冲突
            }

            // 2. 来源目录或分组标题与候选片名直接重合 (如父目录已明确识别片名)
            const normalize = (s) => String(s || '').replace(/[\s._\-–—()[\]【】:：·・!！]/g, '').toLowerCase();
            const normCand = normalize(candTitle);
            const normGroup = normalize(groupTitle);
            const normFolder = normalize(folderName);

            if (normGroup.length >= 2 && (normCand.includes(normGroup) || normGroup.includes(normCand) ||
                (normGroup.length >= 4 && normCand.replace(/之/g, '') === normGroup.replace(/之/g, '')))) {
                return false;
            }
            if (normFolder.length >= 2 && (normCand.includes(normFolder) || normFolder.includes(normCand))) {
                return false;
            }

            // 3. 检查原文件名有效字词
            const fileNameStem = fileItem.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
            const filePure = fileNameStem
                .replace(/\b(?:s\d+e\d+|s\d+|e\d+|ep\d+|2160p|1080p|720p|4k|remux|web-?dl|hdr\d*|dov[i]?|hevc|h\.?26[45]|x26[45]|ddp\d*\.?\d*|atmos|truehd|aac|dts)\b/gi, ' ')
                .replace(/第\s*[0-9零〇一二两兩三四五六七八九十百]+\s*[季集期话話]/g, ' ')
                .replace(/[\s._\-–—()[\]【】]/g, ' ')
                .trim();

            const fileCn = (filePure.match(/[\u3400-\u9fff]+/g) || []).join('');
            const knownGroups = /^(?:pmfan|fysub|colortv|frds|mnhd|wiki|chd|hds|cmct|pikanet128|beansub|flsnow|dymy|kamigami|lilith-raws|sweetsub|nc-raws|lolihouse|sakurato|the|and|for|with|part|disc|season|episode|webrip)$/i;
            const fileEnWords = (filePure.match(/[a-zA-Z]{3,}/g) || []).filter(w => !knownGroups.test(w));

            // 4. 检查英文关键词交集 (在中英文双语文件名如 Eric Clapton 中极其常见)
            const isLatinOrig = /^[a-zA-Z0-9\s:,'._\-!?]+$/.test(candidate.originalTitle || '');
            const matchingEnCount = fileEnWords.filter(w => candTitle.includes(w) || candOrig.includes(w)).length;
            if (fileEnWords.length >= 2 && matchingEnCount >= 2) {
                return false; // 英文关键词强吻合，绝无冲突
            }

            // 5. 若文件名有中文，检查中文片名重合 (统一繁简与 Translations 官方译本验证)
            if (fileCn.length >= 2) {
                const normFileCn = this.normalizeCompare(fileCn);
                const normCandSimp = this.normalizeCompare(candTitle);
                const normOrigSimp = this.normalizeCompare(candOrig);
                let hasCnHit = (normCandSimp && (normCandSimp.includes(normFileCn) || normFileCn.includes(normCandSimp))) ||
                    (normOrigSimp && (normOrigSimp.includes(normFileCn) || normFileCn.includes(normOrigSimp))) ||
                    candTitle.includes(fileCn) || candOrig.includes(fileCn) ||
                    (candidate.translatedTitles && candidate.translatedTitles.some(t => {
                        const nt = this.normalizeCompare(t);
                        return nt && (nt.includes(normFileCn) || normFileCn.includes(nt));
                    }));

                // 检查子串重合 (如 "埃里克·克莱普顿" 匹配 "布鲁斯音乐大师-埃里克·克莱普顿演唱会")
                if (!hasCnHit) {
                    for (let len = Math.min(normCand.length, 6); len >= 3; len--) {
                        for (let i = 0; i <= normCand.length - len; i++) {
                            const sub = normCand.substr(i, len);
                            if (normFileCn.includes(sub)) {
                                hasCnHit = true;
                                break;
                            }
                        }
                        if (hasCnHit) break;
                    }
                }

                if (!hasCnHit && matchingEnCount < 2) {
                    return true;
                }
            }

            // 6. 若文件名纯英文且不含中文：
            if (fileEnWords.length >= 2 && fileCn.length === 0 && isLatinOrig) {
                const hasEnHit = fileEnWords.some(w => candTitle.includes(w) || candOrig.includes(w));
                if (!hasEnHit) {
                    return true;
                }
            }

            return false;
        }


        static clusterFiles(files) {
            const groupsMap = new Map();

            // 统计各目录下视频数量，用于区分单片合集与分集
            const dirVideoCounts = new Map();
            for (const f of files) {
                if (RecognitionEngine.isVideoFile(f.name)) {
                    const p = f.relativePath ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : (f.parentFolderName || 'root');
                    dirVideoCounts.set(p, (dirVideoCounts.get(p) || 0) + 1);
                }
            }

            // 第一轮：严格以主视频文件（含 .iso）作为锚点创建影视分组
            for (const file of files) {
                const isVideo = RecognitionEngine.isVideoFile(file.name);
                if (!isVideo) continue;

                // 路径智能解耦：自底向上寻找真正的媒体专属目录 (跳过 Season 1 等子目录) 并嗅探 {tmdb-xxxx} 或 [tmdbid-xxxx]
                let pathTmdbId = '';
                let effectiveFolderName = '';
                let effectiveFolderPath = '';

                if (file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);

                    for (let p = parts.length - 2; p >= 0; p--) {
                        const seg = parts[p];
                        if (RecognitionEngine.isGenericFolder(seg)) continue;

                        // ★ 核心强锚点：
                        // 若当前目录包含 {tmdb-xxxx} 或 {tmdbid-xxxx}，此为最权威的影视主目录，绝对锁定并立即停止向上越界攀爬
                        const tmdbFolderMatch = seg.match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                        if (tmdbFolderMatch) {
                            pathTmdbId = tmdbFolderMatch[1];
                            effectiveFolderName = seg;
                            effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                            break;
                        }

                        // ★ 核心防越界门禁 (阻断跨剧污染至顶级分类目录)：
                        // 1. 先用 cleanAnimeFolderName(seg) 检查当前目录是否具备独立有效影视剧名
                        const cleanedSeg = RecognitionEngine.cleanAnimeFolderName(seg);
                        const hasSubstantialTitle = Boolean(
                            cleanedSeg &&
                            cleanedSeg.length >= 2 &&
                            !/^\d+$/.test(cleanedSeg) &&
                            !/^(?:Season\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇])$/i.test(cleanedSeg) &&
                            !RecognitionEngine.isGenericFolder(cleanedSeg)
                        );

                        // 若当前目录具备独立剧名（如 "[路人女主的养成方法 第一季][DIY中字]"、"[变形金刚：领袖之证 第一季]"、"真救世主传说_北斗神拳剧场版五部合集"），
                        // 确立该目录本身即为影视主目录，坚决锁定并立即终止向上攀爬，严禁越界污染到父级通用分类目录
                        if (hasSubstantialTitle) {
                            effectiveFolderName = seg;
                            effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                            break;
                        }

                        // 2. 唯有自身无独立片名的纯分季/分卷/特别篇子目录（如 "Season 1", "S02", "第1季", "特别篇", "SP", "BDMV" 等），
                        //    且父级存在有效非通用目录时，才允许向上溯源至父级剧集目录
                        const isCollectionFolder = RecognitionEngine.isCollectionFolder(seg);
                        const folderSeasonVal = RecognitionEngine.targetSeasonFromFolder(seg);
                        const isSubSeasonFolder = folderSeasonVal !== null ||
                            /(?:Season|S|第)\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇]|OVA|OAD|SP|特别篇|剧场版|劇場版/i.test(seg) ||
                            /[篇章]\s*$/i.test(seg);

                        if (isSubSeasonFolder && !isCollectionFolder && p > 0 && !RecognitionEngine.isGenericFolder(parts[p - 1])) {
                            continue;
                        }

                        effectiveFolderName = seg;
                        effectiveFolderPath = '/' + parts.slice(0, p + 1).join('/');
                        break;
                    }
                }

                // 若未在目录树上命中 tmdbId，再检查直接文件名
                if (!pathTmdbId) {
                    const fileTmdbMatch = (file.name || '').match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
                    if (fileTmdbMatch) pathTmdbId = fileTmdbMatch[1];
                }
                if (!effectiveFolderName && file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName)) {
                    effectiveFolderName = file.parentFolderName;
                }
                if (!file.parentFolderName && effectiveFolderName) {
                    file.parentFolderName = effectiveFolderName;
                }
                const parentId = file.parentFileId || (file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : 'root');

                // 检查媒体目录名是否为有效影视主文件夹
                const isGenericFolder = RecognitionEngine.isGenericFolder(effectiveFolderName);
                const cleanFolder = !isGenericFolder ? RecognitionEngine.cleanAnimeFolderName(effectiveFolderName) : '';
                const folderYear = !isGenericFolder && effectiveFolderName ? RecognitionEngine.extractYear(effectiveFolderName) : '';

                const pureFileName = RecognitionEngine.getBaseFileName(file.name);
                const animeFile = RecognitionEngine.parseAnimeFilename(pureFileName);
                // 优先采用 inferTitle 提取纯净影视片名 (杜绝将 .S01E07.夏祭之夜.1080p 等连带作为片名)
                const inferredFromEngine = RecognitionEngine.inferTitle(pureFileName);
                const fileTitle = inferredFromEngine || animeFile.title;
                const fileYear = RecognitionEngine.extractYear(pureFileName);

                const isWeakFileTitle = !fileTitle || fileTitle.length < 2 ||
                    /^(?:cd\d*|disc\d*|part\d*|sample|video|movie|feature|remux|web-?dl|bdrip|hdrip|1080p|2160p|4k|720p|hevc|x26[45]|h\.?26[45]|aac|ac3|dts|atmos|ep?\d+|第?\s*\d+\s*[集话話期]|s\d+e\d+)$/i.test(fileTitle) ||
                    /^\d+$/.test(fileTitle) ||
                    /^\d{1,4}\s*(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|生肉|熟肉)?$/i.test(fileTitle);
                const hasStrongFolderTitle = Boolean(cleanFolder && cleanFolder.length >= 2 && !isGenericFolder);

                // 季推导：优先检查直接父目录，再检查整条路径中的季标记，最后回退到 effectiveFolderName (严禁从通用容器目录提取季度)
                let folderSeason = (!RecognitionEngine.isGenericFolder(file.parentFolderName)) ? RecognitionEngine.targetSeasonFromFolder(file.parentFolderName) : null;
                if (!folderSeason && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    for (let p = parts.length - 2; p >= 0; p--) {
                        if (RecognitionEngine.isGenericFolder(parts[p])) continue;
                        const s = RecognitionEngine.targetSeasonFromFolder(parts[p]);
                        if (s !== null) { folderSeason = s; break; }
                    }
                }
                if (!folderSeason && effectiveFolderName && !RecognitionEngine.isGenericFolder(effectiveFolderName)) {
                    folderSeason = RecognitionEngine.targetSeasonFromFolder(effectiveFolderName);
                }
                file._folderSeason = folderSeason !== null && folderSeason !== undefined ? String(folderSeason) : '';

                const hasEpisodeRangeInFolder = Boolean(
                    file.parentFolderName && !RecognitionEngine.isGenericFolder(file.parentFolderName) && (
                        file.parentFolderName.match(/\[\s*\d{1,4}\s*[-~到至]\s*\d{1,4}\s*\]/) ||
                        file.parentFolderName.match(/\[\s*全\s*\d{1,4}\s*[集话話期]\s*\]/)
                    )
                );

                const se = RecognitionEngine.parseSeasonEpisode(pureFileName, Number(folderSeason || 1));

                // 通用演唱会 / 音乐会判定：演唱会属于 Movie，分类属于演唱会
                const isConcert = Boolean(
                    pureFileName.match(/(?:演唱会|音乐会|歌会|音乐节|独唱会|演奏会|Concert|Live\b|Livehouse|Symphony|交响乐|Philharmonic|歌剧|舞剧)/i) ||
                    file.relativePath?.match(/(?:演唱会|音乐会|Concerts?|音乐节)/i)
                );

                // 通用动漫判定：真实日文假名、真实动画别名库或明确动漫目录；演唱会直接排除
                const isAnime = !isConcert && Boolean(
                    RecognitionEngine.isAnimeIdentifier(file.parentFolderName || '', pureFileName) ||
                    /[\u3040-\u309f\u30a0-\u30ff]/.test(pureFileName) ||
                    /(?:台配动漫|国配动漫|日漫|美漫|动漫|动画|Anime)/i.test(file.relativePath || '')
                );

                // 通用 TV 判定：严禁将演唱会的 Live 25, 40th, Special Live, Top 50 误判为 TV
                const hasDiscIndicator = /(?:^|[ ._\-[\]【】])(?:Disc|Disk|D)\s*\d{1,2}(?=$|[ ._\-[\]【】])/i.test(pureFileName);
                const hasExplicitTvEp = Boolean(
                    pureFileName.match(/\bS\d{1,3}(?:[\s._-]*E\d{1,4})?\b/i) ||
                    pureFileName.match(/第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷篇集话話]/) ||
                    pureFileName.match(/\bEP\d{1,4}\b/i) ||
                    hasDiscIndicator
                );

                // 具备硬性剧集证据 (显式SxxExx/第X集/季目录/集数范围/Disc光盘分卷) 时 100% 确立为 TV
                const hasHardTvEvidence = Boolean(hasExplicitTvEp || folderSeason || hasEpisodeRangeInFolder);
                // 弱剧集判定：当单文件带有明确单片独立上映年份且无显式剧集标记时，坚决保护为电影，杜绝篡改
                const hasWeakTvEvidence = (!/\.iso$/i.test(pureFileName) || hasDiscIndicator) && (
                    se.isSpecial ||
                    se.isDate ||
                    se.hasEpisode ||
                    (animeFile.episode !== null && animeFile.episode > 0)
                );

                const isTv = !isConcert && (hasHardTvEvidence || (hasWeakTvEvidence && !fileYear));

                // ★ 电影合集独立单片判定：同一目录下有多个电影视频，且无 CD/Part 分卷标记时，判定为独立电影单片合集
                const dirPath = file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : (file.parentFolderName || 'root');
                const dirVideoCount = dirVideoCounts.get(dirPath) || 1;
                const variantTag = RecognitionEngine.extractMediaVariantTag(file.name, isTv);
                const isMultiVideoCollection = !isTv && dirVideoCount > 1 && !variantTag;

                let inferredTitle = '';
                let year = fileYear || folderYear;

                if (isMultiVideoCollection) {
                    const fileStem = pureFileName.replace(/\.[a-z0-9]+$/i, '').trim();
                    const cleanStem = RecognitionEngine.inferTitle(fileStem) || fileStem.replace(/[\[【][^\]】]*[\]】]/g, ' ').replace(/\s+/g, ' ').trim();
                    const isFolderCategorical = isGenericFolder || RecognitionEngine.isGenericFolder(cleanFolder) || RecognitionEngine.isCollectionFolder(cleanFolder) || RecognitionEngine.isCollectionFolder(effectiveFolderName);
                    // 核心治理：若父目录属于合集/分类容器，或子文件自身已具备实质独立片名（非依附性弱序号标题），
                    // 坚决直接采纳 cleanStem 作为独立标题，绝对禁止强行拼装 `${cleanFolder} ${cleanStem}`
                    const fileIsIndependent = Boolean(
                        cleanStem && cleanStem.length >= 2 &&
                        !/^\d+$/.test(cleanStem) &&
                        !/^(?:cd\d*|disc\d*|part\d*|ep?\d+|第?\s*\d+\s*[集话話期]|s\d+e\d+|上[集部]?|下[集部]?)$/i.test(cleanStem)
                    );
                    if (cleanFolder && !isFolderCategorical && !fileIsIndependent && !cleanStem.includes(cleanFolder)) {
                        inferredTitle = `${cleanFolder} ${cleanStem}`;
                    } else {
                        inferredTitle = cleanStem;
                    }
                } else {
                    inferredTitle = (hasStrongFolderTitle ? cleanFolder : fileTitle);
                    if (!inferredTitle || /^\d+$/.test(inferredTitle) || (isWeakFileTitle && !hasStrongFolderTitle)) {
                        if (file.relativePath) {
                            const parts = file.relativePath.split('/').filter(Boolean);
                            for (let p = parts.length - 2; p >= 0; p--) {
                                const seg = parts[p];
                                if (!RecognitionEngine.isGenericFolder(seg) && !/^\d+$/.test(seg)) {
                                    const cleaned = RecognitionEngine.cleanAnimeFolderName(seg);
                                    if (cleaned && !/^\d+$/.test(cleaned) && !RecognitionEngine.isGenericFolder(cleaned)) {
                                        inferredTitle = cleaned;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!inferredTitle) inferredTitle = cleanFolder || '待识别影视';
                    }
                }

                inferredTitle = RecognitionEngine.getCanonicalTitle(inferredTitle);

                // 通用中英文双语标题拆分：若同时含有中文与英文副标题，自动解耦
                let englishTitle = '';
                const bilingual = RecognitionEngine.splitBilingualTitle(inferredTitle);
                if (bilingual.englishTitle) {
                    inferredTitle = bilingual.title;
                    englishTitle = bilingual.englishTitle;
                }

                // 英文副标题提取：必须为纯西文字符，严禁将未清洗的中文杂质填入别名
                if (!englishTitle && animeFile.title && animeFile.title !== inferredTitle && /[a-zA-Z]{2,}/.test(animeFile.title) && !/[\u3400-\u9fff]/.test(animeFile.title)) {
                    englishTitle = animeFile.title;
                }

                // 核心优化：影视分组聚合键设计
                // 1. 剧集解绑年份，跨目录合并同一剧集的多个分季与特别篇 (tv:规范标题)
                // 2. 电影合集多单片：每个电影分配专属独立组键，杜绝折叠为同一电影与 .part 命名
                // 3. 单部电影按片名与年份聚合
                // 演唱会公演日期智能识别：若包含明确演出日期 (如 8.30, 8.31, 2010.08.28, 2009.08.22)，将日期独立入键以防多日公演串组
                const concertDate = isConcert ? (RecognitionEngine.extractConcertDate(file.name) || RecognitionEngine.extractConcertDate(file.relativePath)) : null;

                // 季号精确推导：严禁使用 0 || 1 导致 OVA / 特别篇 (季 0) 被误转为季 1
                // 单一事实来源 (SSOT)：若文件名自身含有显式季集标记 (如 S01E01, 第1季第1集)，以文件自身硬证据为准，严禁被父级模糊数字篡改
                const hasExplicitSeasonInFile = RecognitionEngine.hasExplicitSeasonEpisode(file.name);
                const effInitialSeason = (hasExplicitSeasonInFile && se.season !== undefined && se.season !== null)
                    ? String(se.season)
                    : ((folderSeason !== null && folderSeason !== undefined && folderSeason !== '')
                        ? String(folderSeason)
                        : (se.season !== undefined && se.season !== null ? String(se.season) : '1'));

                let groupKey;
                const cleanBaseTitle = isTv ? RecognitionEngine.stripLooseEpisodeTail(inferredTitle || cleanFolder || '') : (inferredTitle || cleanFolder || '');
                const normTitle = (cleanBaseTitle || inferredTitle || cleanFolder || '').toLowerCase().replace(/\s+/g, '');
                const dateSuffix = (isConcert && concertDate) ? (':' + concertDate) : '';
                if (isTv) {
                    // 剧集按季独立分组（对齐 123 助手 looseGroupKeyTitle 规范）：
                    // 无论文件处于独立媒体目录还是平铺目录，不同季度（S01, S02, S03... 特别篇/OVA S00）一律按季独立建组
                    // 确保每季独立校准、独立显示、集号不串组、下拉候选精准匹配
                    groupKey = `tv:${normTitle}:s${effInitialSeason || '1'}`;
                } else if (isMultiVideoCollection) {
                    groupKey = `movie:${normTitle}${year ? ':' + year : ''}${dateSuffix}`;
                } else if (hasStrongFolderTitle || (inferredTitle && !isWeakFileTitle && normTitle.length >= 2 && !RecognitionEngine.isGenericFolder(inferredTitle))) {
                    groupKey = `movie:${normTitle}${year ? ':' + year : ''}${dateSuffix}`;
                } else {
                    groupKey = (hasStrongFolderTitle && effectiveFolderPath) ? `folder:${effectiveFolderPath}${dateSuffix}` : ((inferredTitle || parentId) + dateSuffix);
                }

                const fileCountryInfo = RecognitionEngine.extractAndStripCountryTag(file.name.replace(/\.[a-z0-9]+$/i, ''));
                if (!groupsMap.has(groupKey)) {
                    const fallbackTitle = (!RecognitionEngine.isGenericFolder(file.parentFolderName) ? file.parentFolderName : '') || '待识别影视';
                    let safeTitle = isTv ? (cleanBaseTitle || inferredTitle || cleanFolder || fallbackTitle) : (inferredTitle || cleanFolder || fallbackTitle);
                    if (RecognitionEngine.isGenericFolder(safeTitle) || /^(?:Season\s*\d+|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷])$/i.test(safeTitle)) {
                        safeTitle = '待识别影视';
                    }
                    const isSuspicious = safeTitle === '待识别影视' || safeTitle === '未命名媒体';
                    groupsMap.set(groupKey, {
                        key: groupKey,
                        id: `group-${groupsMap.size + 1}`,
                        title: safeTitle,
                        englishTitle,
                        year,
                        country: fileCountryInfo.country || '',
                        countryCode: fileCountryInfo.countryCode || '',
                        tmdbId: pathTmdbId || animeFile.tmdbId || '',
                        mediaType: isTv ? 'tv' : 'movie',
                        category: isConcert ? '演唱会' : (isAnime ? '动漫' : (isTv ? '剧集' : '电影')),
                        season: effInitialSeason || '1',
                        targetSeason: (se.isSpecial || se.season === 0 || effInitialSeason === '0') ? '0' : (effInitialSeason || '1'),
                        startEp: '',
                        seasonOffset: 0,
                        epOffset: 0,
                        rating: '0.0',
                        overview: '',
                        posterPath: '',
                        videoFormat: '',
                        mediaSource: '',
                        resourceType: '',
                        colorDepth: '',
                        videoCodec: '',
                        dynamicRange: '',
                        audioCodec: '',
                        releaseGroup: animeFile.releaseGroup || '',
                        mediaFolderOverride: '',
                        concertDate: concertDate || '',
                        isConcert: Boolean(isConcert),
                        files: [],
                        candidateList: [],
                        officialEpisodes: [],
                        metadataProbed: false
                    });
                }

                const group = groupsMap.get(groupKey);
                if (isConcert) group.isConcert = true;
                group.files.push(file);
                // 多季合并自适应：若已有其它季文件并入本组，自动将 targetSeason 置空，转为按每文件各自季号自动分季
                if (group.targetSeason && file._folderSeason && String(group.targetSeason) !== String(file._folderSeason)) {
                    group.targetSeason = '';
                }

                const fileTags = RecognitionEngine.inferTechnicalTags(file.name);
                let folderTags = null;
                if (file.parentFolderName) {
                    folderTags = RecognitionEngine.inferTechnicalTags(file.parentFolderName);
                }
                if ((!folderTags || (!folderTags.mediaSource && !folderTags.releaseGroup)) && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    for (let i = parts.length - 2; i >= 0; i--) {
                        const seg = parts[i];
                        if (seg) {
                            const pTags = RecognitionEngine.inferTechnicalTags(seg);
                            if (pTags.mediaSource || pTags.releaseGroup || pTags.videoFormat || pTags.videoCodec) {
                                folderTags = Object.assign({}, pTags, folderTags || {});
                                break;
                            }
                        }
                    }
                }
                const getTag = (key) => fileTags[key] || folderTags?.[key] || '';

                if (!group.videoFormat && getTag('videoFormat')) group.videoFormat = getTag('videoFormat');
                if (!group.mediaSource && getTag('mediaSource')) group.mediaSource = getTag('mediaSource');
                if (!group.resourceType && getTag('resourceType')) group.resourceType = getTag('resourceType');
                if (!group.videoCodec && getTag('videoCodec')) group.videoCodec = getTag('videoCodec');
                if (!group.colorDepth && getTag('colorDepth')) group.colorDepth = getTag('colorDepth');
                if (!group.dynamicRange && getTag('dynamicRange')) group.dynamicRange = getTag('dynamicRange');
                if (!group.audioCodec && getTag('audioCodec')) group.audioCodec = getTag('audioCodec');
                if (!group.originalEdition && getTag('originalEdition')) group.originalEdition = getTag('originalEdition');
                if (!group.releaseGroup && getTag('releaseGroup')) group.releaseGroup = getTag('releaseGroup');
                if (!group.releaseGroup) {
                    const anime = RecognitionEngine.parseAnimeFilename(file.name);
                    if (anime && anime.releaseGroup) group.releaseGroup = anime.releaseGroup;
                    const tags = RecognitionEngine.inferTechnicalTags(file.name);
                    if (tags.releaseGroup) group.releaseGroup = tags.releaseGroup;
                    if (!group.releaseGroup && folderTags?.releaseGroup) {
                        group.releaseGroup = folderTags.releaseGroup;
                    }
                }
            }

            // 第二轮：字幕文件 (ass, srt, ssa, sub, vtt) 归并到主视频分组
            // 核心修复：四级精准归属决策树，彻底废黜 inDirGroups[0] 无脑兜底，严格隔离未匹配孤儿字幕
            for (const file of files) {
                if (RecognitionEngine.isVideoFile(file.name)) continue;
                if (!RecognitionEngine.isSidecarFile(file.name) && !RecognitionEngine.isDiscardFile(file.name)) continue;

                if (!file.parentFolderName && file.relativePath) {
                    const parts = file.relativePath.split('/').filter(Boolean);
                    if (parts.length >= 2) file.parentFolderName = parts[parts.length - 2];
                }
                const parentId = file.parentFileId || (file.relativePath ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : 'root');
                const pureFileName = RecognitionEngine.getBaseFileName(file.name);
                const [fileStem] = RecognitionEngine.splitExtension(pureFileName);
                const fileStemLower = fileStem.toLowerCase();
                const inferredTitle = RecognitionEngine.inferTitle(pureFileName);
                const normSubTitle = inferredTitle ? inferredTitle.toLowerCase().replace(/\s+/g, '') : '';
                const subSe = RecognitionEngine.parseSeasonEpisode(pureFileName, 1);
                const subHasSeason = Boolean((subSe.hasEpisode || subSe.isSpecial || subSe.isDate) && subSe.season !== null && subSe.season !== undefined);
                const subYear = RecognitionEngine.extractYear(pureFileName);

                let matchedGroup = null;

                // 收集同目录下的视频组
                const inDirGroups = (parentId !== 'root') ? Array.from(groupsMap.values()).filter(g =>
                    g.files.some(f => (f.parentFileId || (f.relativePath ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : 'root')) === parentId)
                ) : [];

                // ★ Level 1: 同目录同视频主干前缀匹配 / 同季集精准映射 (最高精确度，如 恶魔之浴 / 俄罗斯方块 / S04E07)
                if (inDirGroups.length > 0) {
                    for (const g of inDirGroups) {
                        const videoFiles = g.files.filter(f => RecognitionEngine.isVideoFile(f.name));
                        const matchedVid = videoFiles.find(v => {
                            const [vStem] = RecognitionEngine.splitExtension(v.name);
                            const vStemLower = vStem.toLowerCase();
                            if (fileStemLower === vStemLower ||
                                fileStemLower.startsWith(vStemLower + '.') ||
                                fileStemLower.startsWith(vStemLower + '-') ||
                                fileStemLower.startsWith(vStemLower + '_') ||
                                fileStemLower.startsWith(vStemLower + ' ') ||
                                vStemLower.startsWith(fileStemLower + '.') ||
                                vStemLower.startsWith(fileStemLower + ' ')) {
                                return true;
                            }
                            // 若剥离语言后缀后主干一致 (如 .chs, .cht, .zh-CN 等)
                            const cleanSubStem = fileStemLower.replace(/\.(?:zh[\-_](?:cn|tw|hk|hans|hant)|zh|chs&cht|cht&chs|chs|cht|sc|tc|chi|zho|cmn|yue|en[\-_](?:us|gb)|eng?|jap?|kor?|forced|default|commentary|sdh|简繁双语|简繁|双语|中字|中文|简体|繁体)$/i, '');
                            if (vStemLower.startsWith(cleanSubStem) || cleanSubStem.startsWith(vStemLower)) {
                                return true;
                            }
                            // 同季集号同目录匹配
                            if (subHasSeason && subSe.episode) {
                                const vSe = RecognitionEngine.parseSeasonEpisode(v.name, g.season || 1);
                                if (vSe.season === subSe.season && vSe.episode === subSe.episode) {
                                    return true;
                                }
                            }
                            return false;
                        });
                        if (matchedVid) {
                            matchedGroup = g;
                            break;
                        }
                    }
                }

                // ★ Level 2: 片名 + 年份/季号精准匹配
                if (!matchedGroup && normSubTitle && normSubTitle.length >= 2) {
                    if (subHasSeason) {
                        // 剧集：优先同目录同季，再跨目录同季
                        matchedGroup = inDirGroups.find(g => g.mediaType === 'tv' && String(g.season) === String(subSe.season) && (g.title.toLowerCase().replace(/\s+/g, '') === normSubTitle || normSubTitle.includes(g.title.toLowerCase().replace(/\s+/g, ''))))
                            || groupsMap.get(`tv:${normSubTitle}:s${subSe.season}`)
                            || Array.from(groupsMap.values()).find(g => g.mediaType === 'tv' && String(g.season) === String(subSe.season) && (g.title.toLowerCase().replace(/\s+/g, '') === normSubTitle || normSubTitle.includes(g.title.toLowerCase().replace(/\s+/g, ''))));
                    } else {
                        // 电影：匹配归一化标题高度一致，且年份匹配（若双方均有年份则必须相等）
                        const findMovieMatch = (candidateGroups) => candidateGroups.find(g => {
                            if (g.mediaType === 'tv') return false;
                            const normGTitle = (g.title || '').toLowerCase().replace(/\s+/g, '');
                            if (!normGTitle || !normSubTitle) return false;
                            const isExact = normGTitle === normSubTitle;
                            const isVeryClose = !isExact && (normGTitle.includes(normSubTitle) || normSubTitle.includes(normGTitle)) &&
                                Math.abs(normGTitle.length - normSubTitle.length) <= 2;
                            if (!isExact && !isVeryClose) return false;
                            if (subYear && g.year && subYear !== g.year) return false;
                            return true;
                        });
                        matchedGroup = findMovieMatch(inDirGroups) || findMovieMatch(Array.from(groupsMap.values()));
                    }
                }

                // ★ Level 3: 专属单一影视文件夹继承 (同目录下所有组属于同一作品，或仅单一专属组)
                if (!matchedGroup && inDirGroups.length >= 1 && parentId !== 'root') {
                    const firstGroup = inDirGroups[0];
                    const isAllSameShow = inDirGroups.every(g => (g.title || '').toLowerCase().replace(/\s+/g, '') === (firstGroup.title || '').toLowerCase().replace(/\s+/g, ''));
                    if (isAllSameShow) {
                        let folderName = file.parentFolderName || '';
                        if (!folderName && file.relativePath && file.relativePath.includes('/')) {
                            const parts = file.relativePath.split('/').filter(Boolean);
                            if (parts.length > 1) folderName = parts[parts.length - 2];
                        }
                        const isCategorical = !folderName || RecognitionEngine.isGenericFolder(folderName);
                        if (!isCategorical) {
                            const isDiscard = RecognitionEngine.isDiscardFile(file.name);
                            const isCommonAsset = /^(?:poster|fanart|backdrop|logo|clearart|banner|thumb|landscape|folder|disc|clearlogo|character|tvshow|season\d*(?:-poster|-fanart)?)(?:[._-].*)?$/i.test(fileStem);
                            const normSoleTitle = (firstGroup.title || '').toLowerCase().replace(/\s+/g, '');
                            // 废弃文件/常见海报元数据不具备相斥片名属性，直接继承并随组处理/清障
                            const hasConflictTitle = !isDiscard && !isCommonAsset && normSubTitle && normSubTitle.length >= 2 && normSoleTitle && !normSoleTitle.includes(normSubTitle) && !normSubTitle.includes(normSoleTitle);
                            if (!hasConflictTitle) {
                                matchedGroup = firstGroup;
                            }
                        }
                    }
                }

                // ★ Level 4: 孤立未匹配字幕隔离：若均未命中，判定为孤儿字幕，严禁强塞给任何不相关的影视组
                if (matchedGroup) {
                    matchedGroup.files.push(file);
                }
            }

            // ★ 文件自然排序：先视频后字幕/附属文件，组内文件名自然数字排序 (避免接口返回次序导致集数错位)
            for (const group of groupsMap.values()) {
                group.files.sort((a, b) => {
                    const aVid = RecognitionEngine.isVideoFile(a.name) ? 0 : 1;
                    const bVid = RecognitionEngine.isVideoFile(b.name) ? 0 : 1;
                    if (aVid !== bVid) return aVid - bVid;
                    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
                });
            }

            return Array.from(groupsMap.values());
        }

    // 通用动漫官方规范名映射字典
    static CANONICAL_TITLE_MAP = {
        '高大罪': '七大罪',
        '大罪': '七大罪',
        '戒律的复活': '七大罪',
        '诸神的逆鳞': '七大罪',
        '愤怒的审判': '七大罪',
        '圣战的预兆': '七大罪',
        '英雄降临': '我的英雄学院',
        '一拳超人': '一拳超人',
        '巨人': '进击的巨人',
        '鬼灭': '鬼灭之刃',
        '咒术': '咒术回战',
        '电锯人': '链锯人',
        '死神': 'BLEACH 境·界',
        '境界': 'BLEACH 境·界',
        '境·界': 'BLEACH 境·界',
        '火影': '火影忍者',
        '海贼': '航海王',
        '海贼王': '航海王'
    };

    static VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov', 'rmvb', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'm2ts', 'mts', 'iso']);

    // 通用经典与热门动漫别名矩阵库 (涵盖大陆、港台、官方中译、英文、日文罗马音互通)
    static ANIME_ALIAS_GROUPS = [
        ['宝可梦', '精灵宝可梦', '神奇宝贝', '宠物小精灵', 'Pocket Monsters', 'Pokemon', 'Pokémon'],
        ['名侦探柯南', '柯南', 'Detective Conan', 'Case Closed'],
        ['航海王', '海贼王', 'One Piece'],
        ['进击的巨人', 'Attack on Titan', 'Shingeki no Kyojin'],
        ['鬼灭之刃', '灭鬼之刃', 'Demon Slayer', 'Kimetsu no Yaiba'],
        ['咒术回战', 'Jujutsu Kaisen'],
        ['间谍过家家', '间谍家家酒', 'SPY×FAMILY', 'Spy x Family', 'Spy Family'],
        ['新世纪福音战士', '福音战士', 'EVA', 'Neon Genesis Evangelion'],
        ['哆啦A梦', '机器猫', '小叮当', 'Doraemon'],
        ['钢之炼金术师', '钢炼', 'Fullmetal Alchemist'],
        ['银魂', 'Gintama'],
        ['火影忍者', '火影', 'Naruto'],
        ['死神', '境·界', '境界', 'Bleach'],
        ['刀剑神域', 'Sword Art Online', 'SAO'],
        ['命运石之门', 'Steins;Gate', 'Steins Gate'],
        ['灌篮高手', '男儿当入樽', 'Slam Dunk'],
        ['圣斗士星矢', 'Saint Seiya'],
        ['蜡笔小新', 'Crayon Shin-chan'],
        ['龙珠', '七龙珠', 'Dragon Ball'],
        ['全职猎人', '猎人', 'Hunter x Hunter', 'HUNTER×HUNTER'],
        ['排球少年', '排球少年!!', 'Haikyuu!!', 'Haikyuu'],
        ['黑子的篮球', 'Kuroko no Basket'],
        ['约会大作战', 'Date A Live'],
        ['我的英雄学院', 'My Hero Academia', 'Boku no Hero Academia'],
        ['葬送的芙莉莲', 'Sousou no Frieren', 'Frieren'],
        ['无职转生', 'Mushoku Tensei'],
        ['孤独摇滚', '孤独摇滚！', 'Bocchi the Rock!'],
        ['我推的孩子', '【推しの子】', 'Oshi no Ko'],
        ['链锯人', '电锯人', 'Chainsaw Man'],
        ['赛马娘', 'Pretty Derby', 'Uma Musume'],
        ['魔法少女小圆', 'Puella Magi Madoka Magica', 'Madoka Magica'],
        ['夏目友人帐', 'Natsume Yuujinchou'],
        ['文豪野犬', 'Bungou Stray Dogs'],
        ['JOJO的奇妙冒险', "JoJo's Bizarre Adventure"],
        ['一拳超人', 'One Punch Man'],
        ['辉夜大小姐想让我告白', '辉夜姬想让人告白', 'Kaguya-sama'],
        ['七大罪', '大罪', '高大罪', 'The Seven Deadly Sins', 'Nanatsu no Taizai', '七つの大罪', '七大罪 圣战的预兆', '圣战的预兆', '戒律的复活', '诸神的逆鳞', '愤懑的审判'],
        ['灼眼的夏娜', '夏娜', 'Shakugan no Shana'],
        ['樱桃小丸子', '小丸子', 'Chibi Maruko-chan'],
        ['关于我转生变成史莱姆这档事', '转生史莱姆', '史莱姆', 'That Time I Got Reincarnated as a Slime', 'Tensura'],
        ['不死者之王', 'Overlord', 'OVERLORD', '骨王'],
        ['想要成为影之实力者', '影之实力者', 'The Eminence in Shadow', '暗影大人'],
        ['某科学的超电磁炮', '超电磁炮', '超炮', 'Toaru Kagaku no Railgun', 'Railgun'],
        ['魔法禁书目录', '魔禁', 'Toaru Majutsu no Index', 'Index'],
        ['化物语', '物语系列', 'Monogatari Series', 'Bakemonogatari'],
        ['齐木楠雄的灾难', '齐木楠雄', 'The Disastrous Life of Saiki K.'],
        ['Re：从零开始的异世界生活', '从零开始的异世界生活', 'Re:0', 'Re0', 'Re:Zero'],
        ['暗杀教室', 'Assassination Classroom'],
        ['家庭教师', '家庭教师Hitman Reborn!', 'Katekyo Hitman Reborn!']
    ];

    /**
     * 根据片名检索关联的通用别名家族矩阵
     * @param {string} title
     * @returns {string[]}
     */
    static getAliases(title) {
        const clean = String(title || '').toLowerCase().replace(/[\s._\-–—()[\]【】:：·・!！'’"“”]/g, '');
        if (!clean || clean.length < 2) return [];
        for (const group of this.ANIME_ALIAS_GROUPS) {
            for (const item of group) {
                const normItem = item.toLowerCase().replace(/[\s._\-–—()[\]【】:：·・!！'’"“”]/g, '');
                if (normItem === clean || (normItem.length >= 2 && clean.includes(normItem)) || (clean.length >= 4 && normItem.includes(clean))) {
                    return group;
                }
            }
        }
        return [];
    }

    /**
     * 提取文件名或路径中的 {tmdb-xxx} 或 [tmdbid-xxx] 权威标签
     * @param {string} text
     * @returns {string|null}
     */
    static extractTmdbIdTag(text) {
        if (!text) return null;
        const m = String(text).match(/[\{\[](?:tmdb|tmdbid)[-:= ]?(\d+)[\}\]]/i);
        return m ? m[1] : null;
    }

    /**
     * 续集部数与代数精准提取器 (防《神偷奶爸3》匹配《神偷奶爸》第1部)
     * @param {string} input
     * @returns {string|null}
     */
    static extractSequelNum(input) {
        if (!input) return null;
        let s = String(input).trim();
        if (!s) return null;

        s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
        s = s.replace(/[\s._]*[-–—_]\s*[A-Za-z0-9_@]+$/i, '');
        s = s.replace(/\b(?:4320p|2160p|1080[pi]|720p|480p|4k|8k|web-?dl|bluray|remux|hdtv|h[ .]?26[45]|x26[45]|hevc|avc|ddp\d*|dts|truehd|atmos|10bit|8bit)\b/gi, ' ');
        s = s.replace(/(?<!\d)(?:18|19|20)\d{2}(?!\d)/g, ' ');

        const cleanDigits = s.replace(/[\s._-]+/g, '');
        if (/^\d{3,}$/.test(cleanDigits)) return null;

        const map = {
            '一': '1', '二': '2', '两': '2', '兩': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
            'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10',
            'ⅱ': '2', 'ⅲ': '3', 'ⅳ': '4', 'ⅴ': '5', 'ⅵ': '6', 'ⅶ': '7', 'ⅷ': '8', 'ⅸ': '9', 'ⅹ': '10',
            'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5'
        };

        const pExplicit = /(?:第\s*([0-9零〇一二两兩三四五六七八九十]+)\s*[部季期篇卷]|(?:Part|Pt|Vol)\.?\s*([0-9]+|[ivx]+|[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+))/i;
        const mExp = s.match(pExplicit);
        if (mExp) {
            const raw = (mExp[1] || mExp[2] || '').toLowerCase();
            return map[raw] || raw;
        }

        const pRoman = /(?<=[^\w]|^)([ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|\b[IVX]{2,4}\b)(?=[^\w]|$)/i;
        const mRoman = s.match(pRoman);
        if (mRoman) {
            const raw = mRoman[1].toLowerCase();
            if (map[raw]) return map[raw];
        }

        const pInlineNum = /(?:(?<=[\u3400-\u9fff])\s*([2-9]|10)|(?<=[a-z]{2,})\s+([2-9]|10))(?=[\s:：·・•_.,\-—(（\[【]|$|(?=[\u3400-\u9fff]{2,}))/i;
        const mInline = s.match(pInlineNum);
        if (mInline) {
            return mInline[1] || mInline[2];
        }

        return null;
    }

    /**
     * 演唱会/演出公演日期提取 (如 8.28, 8.30)
     * @param {string} str
     * @returns {string|null}
     */
    static extractConcertDate(str) {
        const s = String(str || '');
        const fullM = s.match(/(?:\b|_)(?:19\d\d|20\d\d|\d{2,4})[.\-_年](0?[1-9]|1[0-2])[.\-_月](0?[1-9]|[12]\d|3[01])(?:日)?(?!\d)/);
        if (fullM) {
            return parseInt(fullM[1], 10) + '.' + parseInt(fullM[2], 10);
        }
        const shortM = s.match(/(?<![\d\w])(0?[1-9]|1[0-2])[.\-_月](0?[1-9]|[12]\d|3[01])(?:日)?(?!\d)/);
        if (shortM) {
            const mon = parseInt(shortM[1], 10);
            const day = parseInt(shortM[2], 10);
            if ((mon === 5 || mon === 7 || mon === 2) && (day === 0 || day === 1)) {
                return null;
            }
            return mon + '.' + day;
        }
        return null;
    }

    static TRADITIONAL_TO_SIMPLIFIED = {
        '俠': '侠', '獅': '狮', '雄': '雄', '當': '当', '強': '强', '龍': '龙',
        '囍': '喜', '長': '长', '號': '号', '義': '义', '膽': '胆', '漫畫': '漫画',
        '闖': '闯', '運': '运', '條': '条', '狀': '状', '元': '元', '蘇': '苏',
        '乞': '乞', '兒': '儿', '敵': '敌', '學': '学', '審': '审', '鹿': '鹿',
        '鹿': '鹿', '記': '记', '神': '神', '敎': '教', '教': '教', '風': '风',
        '雨': '雨', '賭': '赌', '內': '内', '發': '发', '遊': '游', '西遊': '西游',
        '傳': '传', '聖': '圣', '產': '产', '話': '话', '護': '护', '後': '后', '個': '个', '佬': '佬', '樓': '楼', '鳳': '凤',
        '畫': '画', '漫': '漫', '壞': '坏', '機': '机', '戰': '战', '獄': '狱', '殺': '杀', '雲': '云', '隊': '队', '體': '体',
        '壹': '一', '佰': '百', '零': '零', '回': '回', '寶': '宝', '盒': '盒',
        '結': '结', '局': '局', '仙': '仙', '履': '履', '奇': '奇', '緣': '缘',
        '霸': '霸', '變': '变', '星': '星', '君': '君', '門': '门', '點': '点',
        '秋': '秋', '香': '香', '豪': '豪', '宴': '宴', '劇': '剧', '漢': '汉',
        '愛': '爱', '國': '国', '粵': '粤', '語': '语', '藍': '蓝',
        '光': '光', '頭': '头', '無': '无', '間': '间', '導': '导', '線': '线',
        '慶': '庆', '餘': '余', '華': '华'
    };

    /**
     * 统一数字解析纯函数（支持 0~999 阿拉伯与中文数字，无网络 I/O，无副作用）
     * @param {string|number} raw
     * @returns {number|null}
     */
    static parseChineseNumber(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const text = String(raw).trim();
        if (!text) return null;
        if (/^\d+$/.test(text)) return parseInt(text, 10);

        const normalized = text
            .replace(/[两兩]/g, '二')
            .replace(/[〇零]/g, '零')
            .replace(/壹/g, '一')
            .replace(/[贰貳]/g, '二')
            .replace(/[叁叄]/g, '三')
            .replace(/肆/g, '四')
            .replace(/伍/g, '五')
            .replace(/[陆陸]/g, '六')
            .replace(/柒/g, '七')
            .replace(/捌/g, '八')
            .replace(/玖/g, '九')
            .replace(/拾/g, '十')
            .replace(/佰/g, '百');

        const map = {
            零: 0,
            一: 1,
            二: 2,
            三: 3,
            四: 4,
            五: 5,
            六: 6,
            七: 7,
            八: 8,
            九: 9,
        };

        if (normalized === '百' || normalized === '一百') return 100;

        const hundredIdx = normalized.indexOf('百');
        if (hundredIdx >= 0) {
            const left = normalized.slice(0, hundredIdx);
            const right = normalized.slice(hundredIdx + 1);
            const hundreds = left ? map[left] : 1;
            if (!Number.isInteger(hundreds)) return null;

            if (!right) return hundreds * 100;

            const strippedRight = right.replace(/^零+/, '');
            if (!strippedRight) return hundreds * 100;

            const rest = this.parseChineseNumber(strippedRight);
            if (Number.isInteger(rest)) {
                return hundreds * 100 + rest;
            }
            return null;
        }

        if (normalized === '十') return 10;
        const tenIndex = normalized.indexOf('十');
        if (tenIndex >= 0) {
            const left = normalized.slice(0, tenIndex);
            const right = normalized.slice(tenIndex + 1);
            const tens = left ? map[left] : 1;
            const ones = right ? map[right] : 0;
            if (Number.isInteger(tens) && Number.isInteger(ones)) {
                return tens * 10 + ones;
            }
            return null;
        }

        if (normalized.length === 1 && Number.isInteger(map[normalized])) {
            return map[normalized];
        }

        return null;
    }

    /**
     * 繁体转简体标准化
     */
    static toSimplified(text) {
        let str = String(text || '');
        str = str.replace(/西遊/g, '西游').replace(/大話/g, '大话').replace(/仙履奇緣/g, '仙履奇缘').replace(/月光寶盒/g, '月光宝盒');
        return str.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, char => this.TRADITIONAL_TO_SIMPLIFIED[char] || char);
    }

    /**
     * 简体转繁体（用于对偶降级检索）
     */
    static toTraditional(text) {
        if (!text || typeof text !== 'string') return '';
        if (!this.SIMPLIFIED_TO_TRADITIONAL) {
            this.SIMPLIFIED_TO_TRADITIONAL = {};
            for (const [tCh, sCh] of Object.entries(this.TRADITIONAL_TO_SIMPLIFIED)) {
                if (!this.SIMPLIFIED_TO_TRADITIONAL[sCh]) {
                    this.SIMPLIFIED_TO_TRADITIONAL[sCh] = tCh;
                }
            }
        }
        return text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, char => this.SIMPLIFIED_TO_TRADITIONAL[char] || char);
    }

    /**
     * 防和谐幽灵伪装后缀剥离 (.mkv.jpg -> .mkv, .mp4.png -> .mp4)
     */
    static removeGhostExtension(filename) {
        if (!filename) return filename;
        const s = String(filename);
        const ghostMatch = s.match(/^(.*\.([a-zA-Z0-9]{2,10}))\.(?:jpg|png|jpeg|b64|gif|bmp)$/i);
        if (ghostMatch && this.VIDEO_EXTENSIONS.has(ghostMatch[2].toLowerCase())) {
            return ghostMatch[1];
        }
        return s;
    }

    /**
     * 截断乱码与 URL 编码安全容错自愈解码
     */
    static safeDecodeName(name) {
        let s = String(name || '');
        if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
        try { return decodeURIComponent(s); } catch (_) {}
        const peeled = s.replace(/%[0-9A-Fa-f]?$/, '');
        try { return decodeURIComponent(peeled) + s.slice(peeled.length); } catch (_) {}
        let temp = peeled;
        for (let i = 0; i < 3; i++) {
            temp = temp.replace(/%[0-9A-Fa-f]{2}$/, '');
            try { return decodeURIComponent(temp) + s.slice(temp.length); } catch (_) {}
        }
        return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, seg => {
            let out = '';
            let buf = '';
            for (let i = 0; i < seg.length; i += 3) {
                buf += seg.slice(i, i + 3);
                try {
                    out += decodeURIComponent(buf);
                    buf = '';
                } catch (_) {}
            }
            return out + buf;
        });
    }

    /**
     * 文件名非法字符全角化与安全清洗
     * @param {string} value
     * @param {object} [options] - { stripIllegal: boolean }
     */
    static cleanName(value, options = {}) {
        if (options.stripIllegal) {
            return String(value || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        }
        return String(value || '')
            .replace(/[:：]/g, '：')
            .replace(/[\/／]/g, '／')
            .replace(/[\\＼]/g, '＼')
            .replace(/[\?？]/g, '？')
            .replace(/[\*＊]/g, '＊')
            .replace(/["“”]/g, '”')
            .replace(/[<＜]/g, '＜')
            .replace(/[>＞]/g, '＞')
            .replace(/[|｜]/g, '｜')
            .replace(/\s*：\s*/g, '：')
            .replace(/\s*／\s*/g, '／')
            .replace(/\s*＼\s*/g, '＼')
            .replace(/\s+/g, ' ')
            .replace(/\.{2,}/g, '.')
            .trim()
            .replace(/^[.\s]+|[.\s]+$/g, '')
            .slice(0, 255);
    }

    /**
     * 渲染后文件名终态安全去噪
     */
    static cleanRenderedName(value, extension = '') {
        const sanitized = String(value || '').replace(/(?:[._\-\s])?原盘(?:[._\-\s])?/g, '.');
        let output = this.cleanName(
            sanitized
                .replace(/\s*\.\s*/g, '.')
                .replace(/\.{2,}/g, '.')
                .replace(/\s+([._-])/g, '$1')
                .replace(/([._-])\s+/g, '$1')
        );
        // ★ 核心防腐：点分技术规格块相邻重复自动去重 (彻底杜绝 WEB-DL.WEB-DL 等冗余拼接)
        if (output && output.includes('.')) {
            const parts = output.split('.');
            const deduped = [];
            for (const p of parts) {
                if (deduped.length > 0 && p && p.toLowerCase() === deduped[deduped.length - 1].toLowerCase()) {
                    continue;
                }
                deduped.push(p);
            }
            output = deduped.join('.');
        }
        if (extension && output && !output.toLowerCase().endsWith(extension.toLowerCase())) {
            output += extension;
        }
        return output;
    }

    /**
     * 综艺/新闻/纪录片放送日期提取 (YYYY-MM-DD)
     */
    static parseEpisodeAirDate(filename) {
        const text = String(filename || '').replace(/\.[^.]+$/, '');
        const dateMatch = text.match(/(?<!\d)((?:19|20)\d{2})[.\-_\年](\d{1,2})[.\-_\月](\d{1,2})(?:\日)?(?!\d)/)
            || text.match(/(?<!\d)((?:19|20)\d{2})([01]\d)([0-3]\d)(?!\d)/);
        if (dateMatch) {
            const y = parseInt(dateMatch[1], 10);
            const m = parseInt(dateMatch[2], 10);
            const d = parseInt(dateMatch[3], 10);
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
        }
        return null;
    }

    /**
     * 获取动漫规范中文名
     */
    static getCanonicalTitle(title) {
        if (!title) return '';
        const raw = String(title).trim();
        if (this.CANONICAL_TITLE_MAP[raw]) return this.CANONICAL_TITLE_MAP[raw];
        for (const [key, val] of Object.entries(this.CANONICAL_TITLE_MAP)) {
            if (raw.includes(key)) return val;
        }
        for (const group of this.ANIME_ALIAS_GROUPS) {
            if (group.some(alias => raw.toLowerCase().includes(alias.toLowerCase()))) {
                return group[0];
            }
        }
        return raw;
    }

    /**
     * 判断是否是常见通用文件夹名（不代表影视标题）
     */
    static isGenericFolder(name) {
        if (!name) return true;
        const s = String(name).trim();
        const GENERIC_FOLDERS = new Set([
            'root', 'home', 'download', 'downloads', 'movie', 'movies', 'tv', 'tvs', 'series', 'anime',
            'video', 'videos', 'film', 'films', 'media', 'share', 'shares', 'pan', 'disk', 'cloud',
            '新建文件夹', '未命名', '电影', '电视剧', '剧集', '动漫', '动画', '欧美剧', '日韩剧', '国产剧',
            '华语剧', '新番', '外语电影', '华语电影', '综艺', '纪录片', '儿童', '演唱会'
        ]);
        if (GENERIC_FOLDERS.has(s.toLowerCase())) return true;
        if (/^(?:Season\s*\d{1,3}|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷])$/i.test(s)) return true;
        return false;
    }

    /**
     * 清洗动漫/影视文件夹名称 (完全对齐 139 助手 2.8.x 核心引擎)
     */
    static cleanAnimeFolderName(folderName) {
        if (!folderName) return '';
        let s = String(folderName).replace(/[丨|｜丶]/g, '').trim();
        // 剥离 {tmdb-xxxx} 或 {tmdbid-xxxx} 或 [tmdbid-xxxx]
        s = s.replace(/[\{\[](?:tmdb|tmdbid)[-:= ]?\d+[\}\]]/gi, ' ');
        // 剥离 139 云盘转存/克隆自动追加的时间戳后缀 (如 _20261014_100005, _20260609_130122, _20260523_084403)
        s = s.replace(/_\d{8}_\d{6}(?:\b|$)/g, ' ').trim();
        s = s.replace(/_\d{8}_\d{4}(?:\b|$)/g, ' ').trim();
        s = s.replace(/_\d{14}(?:\b|$)/g, ' ').trim();
        // 剥离开头的质量前缀或上传者前缀 (高-, 告-, 高清-, 全-, [全], 1., 2.)
        s = s.replace(/^(?:高清|超清|标清|普清|4K|1080[pP]|720[pP]|全集?|告)[-_]?\s*/i, '');
        s = s.replace(/^高[-_]\s*/i, '');
        s = s.replace(/^全[-_]\[/i, '[');
        s = s.replace(/^\d{1,2}\.\s*/, '');
        // 剥离 (2014) 或 [2014] 或 年份
        s = s.replace(/[\(\[\{（【]\s*(?:18\d\d|19\d\d|20\d\d)\s*[\)\]\}）】]/gi, ' ');
        // 剥离评分 (如 7.8, 8.4, 9.5) 与大小/集数备注 (如 (21g), (少11), (少7集), 缺集)
        s = s.replace(/\b\d\.\d\b/g, ' ');
        s = s.replace(/[\(（]\s*(?:\d+g|少\d+集?|缺\d*集?|外挂字幕|中配|诸神版|诸神字幕组|全\d+集)\s*[\)）]/gi, ' ');
        s = s.replace(/(?:缺集?|少\d+集?|等多个文件)$/g, '');
        // 剥离合集/集数区间 [01-18], [01-24+SP], 01+24, 001-030, 001～050, 201-250
        const rangeSep = '[-~～－—–_+＋到至一]';
        s = s.replace(new RegExp('\\b\\d{1,4}\\s*' + rangeSep + '\\s*\\d{1,4}\\b', 'g'), ' ');
        s = s.replace(new RegExp('\\[\\s*\\d{1,4}\\s*' + rangeSep + '\\s*\\d{1,4}(?:\\+[^x\\]]+)?\\s*\\]', 'gi'), ' ');
        s = s.replace(/\[\s*全\s*\d{1,4}\s*[集话話期]\s*\]/gi, ' ');
        s = s.replace(new RegExp('【\\s*\\d{1,4}\\s*' + rangeSep + '\\s*\\d{1,4}(?:\\+[^】]+)?\\s*】', 'gi'), ' ');
        s = s.replace(/【\s*全\s*\d{1,4}\s*[集话話期]\s*】/gi, ' ');
        s = s.replace(/[\[【]\s*(?:end|fin|完结?|全)\s*[\]】]/gi, ' ');
        // 剥离技术/语言/格式标签
        s = s.replace(/[\[【]\s*(?:最终版|合集|完结|新番|\d{1,2}月新番|简体|繁体|简繁|双语|国日|简日|繁日|中日双语字幕|中日双语|无字片源|国英日多音轨\+简繁英字幕|国英日.*|720p|1080p|2160p|4k|mp4|mkv|web-?dl|webrip|hevc|avc|h\.?26[45]|x26[45]|10bit|baha|b-global)\s*[\]】]/gi, ' ');
        // 剥离压制组后缀 (如 -ColorTV, -Pikanet128)
        s = s.replace(/-(?:ColorTV|Pikanet128|FRDS|MNHD|ADWeb|HiveWeb|HHWEB|[A-Za-z0-9_]+)$/i, ' ');
        // 剥离年份及规格 (如 .2023.1080p.NF.WEB-DL.DDP5.1.H264)
        s = s.replace(/(?<=[\u3400-\u9fffA-Za-z0-9]{2,}[\s._-])(?:19\d\d|20\d\d)(?![年\u3400-\u9fff])\b.*$/i, ' ');
        // 截断季数及之后的一切规格 (支持紧随在中文后，如 秀逗魔导士第1季国语，或 .S01. 或 第二季)
        const seasonIdx = s.search(/(?:[.\s_]|(?<=[\u3400-\u9fff]))(?:第\s*[0-9零〇一二两兩三四五六七八九十百\d]*\s*季|Season\s*\d+|S\d{1,3})/i);
        if (seasonIdx > 0) s = s.slice(0, seasonIdx);
        // 截断技术规格及之后 (如 1080p, 2160p, WEB-DL, BluRay)
        const techIdx = s.search(/\b(?:4320p|2160p|1080p|1080i|720p|480p|4k|8k|web-?dl|webrip|bluray|\bbd\b|\bbdmv\b|\bbdbox\b|\bdvd\b|remux|hdtv|hevc|avc|h\.?26[45]|x26[45])\b/i);
        if (techIdx > 0) s = s.slice(0, techIdx);
        s = s.replace(/[\s._\-–—]+(?:BD|BDMV|BDBOX|DVD|Blu[- ]?Ray)\s*$/i, '');

        // 智能剥离前置发布组：仅当括号后仍有有效片名文本时才剥离发布组；若括号内即为片名，则完整保留
        const leadingBracket = s.match(/^[\[【]([^\]】]+)[\]】]\s*(.*)$/);
        if (leadingBracket) {
            const inside = leadingBracket[1].trim();
            const after = leadingBracket[2].trim();
            const isKnownGroup = /(?:字幕[组社]|制作组|发布组|Fansub|Sub|Raws|Studio|Rip|PMFAN|FYSub|ColorTV|诸神|极影|幻樱|枫雪|澄空|雪飘|动新|喵萌|悠哈|轻之国度|HiveWeb|ADWeb|HHWEB)/i.test(inside);
            if (isKnownGroup && after.length >= 2) {
                s = after;
            } else if (after.length >= 2 && !/[\u3400-\u9fff]/.test(inside) && /[\u3400-\u9fff]/.test(after)) {
                s = after;
            } else {
                s = inside + ' ' + after;
            }
        }

        // 剥离语言/音轨标签 (含全半角括号，含简繁)
        s = s.replace(/[\(（【\[]\s*(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|国英日|国日|简日|繁日|中日|英语|韩语|法语|德语|西语|国|粤|台|日|生肉|熟肉)\s*[\)）】\]]/gi, ' ');
        s = s.replace(/(?:^|\s|[.\-_])(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|国英日|国日|简日|繁日|中日|英语|韩语|法语|德语|西语|生肉|熟肉)(?=\s|[.\-_]|$)/gi, ' ');
        s = s.replace(/(?:国语|粤语|中配|日配|台配|國語|日語|粵語|雙語|國配|台語|国配|日语|双语|多语|国英日|国日|简日|繁日|中日|英语|韩语|法语|德语|西语|生肉|熟肉)$/gi, ' ').trim();

        // 剥离尾部合集与剧场版合集标注 (如 剧场版五部合集、电影合集、8部合集、全集)
        s = s.replace(/[.\s_\-[\]【】()（）]*(?:(?:剧场版|电影)?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*部(?:合集|全集|曲)?|(?:剧场版|电影)\s*(?:合集|全集)|合集|全集)\s*$/i, ' ').trim();
        // 剥离残留的尾部季/期/部/卷/集标记与OVA/特别篇修饰词
        s = s.replace(/[.\s_\-[\]【】()（）]*(?:第\s*[0-9零〇一二两兩三四五六七八九十百\d]*\s*[季期部卷集篇]|Season\s*\d+|S\d{1,3}|[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷集篇]|全\d*季|两季全|[上下]\s*[部篇卷]|部曲|OVA|OAD|\bSP\b|特别篇|剧场版|劇場版)\s*$/i, '').trim();
        s = s.replace(/第季\+?$/i, '').trim();

        // 若点号分割的各段中，第一段已包含中文，第二段是英文别名，提取第一段
        const dotParts = s.split('.');
        if (dotParts.length >= 2 && /[\u3400-\u9fff]/.test(dotParts[0])) {
            s = dotParts[0];
        }

        let finalTitle = s.replace(/[\[\]()（）【】《》]/g, ' ').replace(/\./g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        finalTitle = this.stripReleaseGroup(finalTitle);
        finalTitle = this.stripCountryTag(finalTitle);
        finalTitle = finalTitle.replace(/[\s._\-–—~]+$/, '').trim();

        const isSmallNum = /^(?:0?\d{1,2})$/.test(finalTitle);
        const isSeasonOrEpFolder = /^(?:Season\s*\d{1,3}|第?\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季期部卷])$/i.test(finalTitle);
        const isPureGeneric = this.isGenericFolder(finalTitle);
        if (isSmallNum || isSeasonOrEpFolder || isPureGeneric) return '';

        return this.getCanonicalTitle(finalTitle);
    }

    /**
     * 英文候选标题去噪清洗 (剥除 S01E01, 1080p, WEB-DL 等)
     */
    static cleanCandidateEnglishTitle(raw) {
        if (!raw) return '';
        let s = String(raw).trim();
        // 剔除年份 (19xx, 20xx)
        s = s.replace(/\b(19\d\d|20\d\d)\b/g, ' ');
        // 剔除季集标识 (S01E06, S01, E06, EP06, Season 1 等)
        s = s.replace(/\bS\d{1,3}(?:[\s._-]*E\d{1,4})?\b/gi, ' ');
        s = s.replace(/\b(?:EP?|Part|Season)\s*\d{1,4}\b/gi, ' ');
        // 剔除分辨率与画质
        s = s.replace(/\b(?:4320|2160|1080|720|576|480)[pi]\b/gi, ' ');
        s = s.replace(/\b(?:4K|8K|2K|FHD|UHD|HD|SD)\b/gi, ' ');
        // 4. 剔除片源、流媒体平台与压制介质标签
        s = s.replace(/\b(?:WEB[-_ ]?DL|WEB[-_ ]?Rip|Blu[-_ ]?Ray|\bBD\b|BDRip|HDRip|DVDRip|REMUX|DIY|HDTV|DVD)\b/gi, ' ');
        s = s.replace(/\b(?:AMZN|NF|Netflix|DSNP|Disney\+?|CR|Crunchyroll|HULU|ATVP|iT|MAX|HBO|Bilibili|IQ|YOUKU|MGTV|WeTV)\b/gi, ' ');
        // 5. 剔除音视频编码与动态范围
        s = s.replace(/\b(?:H\.?26[45]|X26[45]|HEVC|AVC|AV1|VC-?1|MPEG-?2)\b/gi, ' ');
        s = s.replace(/\b\d{1,2}[\s._-]?bits?\b/gi, ' ');
        s = s.replace(/\b(?:HDR10\+|HDR10|HDR|DV|Dolby[\s._-]?Vision|HLG|SDR)\b/gi, ' ');
        s = s.replace(/\b(?:DTS[-_ ]?HD(?:[-_ ]?MA)?|TrueHD(?:\s*Atmos)?|DDP(?:\s*Atmos)?|EAC3|AC3|AAC(?:\s*\d(?:\.\d)?)?|FLAC|LPCM|PCM|DTS|DD[\s._-]?\d\.\d)\b/gi, ' ');
        s = s.replace(/\b(?:7\.1|5\.1|5\.0|2\.0)\b/g, ' ');
        // 清理符号与多余空格
        return s.replace(/[._\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * 单文件独立物理技术规格推断 (Per-File Independent Inference)
     */
    static inferTechnicalTags(filename, fileSize = 0, streamMeta = null) {
        const clean = String(filename || '').toUpperCase();
        const tags = {
            videoFormat: '',
            videoCodec: '',
            colorDepth: '',
            resourceType: '',
            mediaSource: '',
            dynamicRange: '',
            audioCodec: '',
            releaseGroup: '',
            frameRate: '',
            highQuality: '',
            effect: '',
            resolutionRank: 0,
            frameRateRank: 0,
            isRemux: false,
            isBluRay: false,
            isDolby: false,
            isImax: false,
            size: Number(fileSize || 0)
        };

        // 1. 分辨率 (使用严格非字母数字边界，彻底解决 4K_V2 下划线词界失效导致的误判)
        if (/4320P|(?:^|[^a-zA-Z0-9])8K(?:$|[^a-zA-Z0-9])/i.test(clean)) { tags.videoFormat = '8K'; tags.resolutionRank = 7; }
        else if (/2160[PI]|(?:^|[^a-zA-Z0-9])4K(?:$|[^a-zA-Z0-9])|\bUHD\b|3840\s*[X*×]\s*2160/i.test(clean)) { tags.videoFormat = '2160p'; tags.resolutionRank = 6; }
        else if (/1440[PI]|(?:^|[^a-zA-Z0-9])2K(?:$|[^a-zA-Z0-9])/i.test(clean)) { tags.videoFormat = '1440p'; tags.resolutionRank = 5; }
        else if (/1080[PI]|FHD|1920\s*[X*×]\s*1080/i.test(clean)) { tags.videoFormat = /1080I/i.test(clean) ? '1080i' : '1080p'; tags.resolutionRank = 4; }
        else if (/720[PI]|1280\s*[X*×]\s*720|(?<!TRUE|DTS-)HD\b/i.test(clean)) { tags.videoFormat = /720I/i.test(clean) ? '720i' : '720p'; tags.resolutionRank = 3; }
        else if (/576[PI]/i.test(clean)) { tags.videoFormat = '576p'; tags.resolutionRank = 2; }
        else if (/480[PI]|SD\b/i.test(clean)) { tags.videoFormat = '480p'; tags.resolutionRank = 1; }

        // 高码率 / HQ 特性
        if (/高码(?:率)?|\bHQ\b/i.test(clean)) {
            tags.highQuality = 'HQ';
        }

        // 2. 视频编码
        const vcMatch = filename.match(/(?:^|[^a-zA-Z0-9])(x264|x265|H\.?264|H\.?265|HEVC|AVC|XviD|MPEG-?2|VP9|AV1)(?:$|[^a-zA-Z0-9])/i);
        if (vcMatch) {
            const raw = vcMatch[1];
            if (/^H\.?264$/i.test(raw)) tags.videoCodec = 'H.264';
            else if (/^H\.?265$/i.test(raw)) tags.videoCodec = 'H.265';
            else tags.videoCodec = raw;
        }
        else if (/HEVC|H\.?265|X265/.test(clean)) tags.videoCodec = 'H.265';
        else if (/AVC|H\.?264|X264|MPEG-?4(?:\s*AVC)?/.test(clean)) tags.videoCodec = 'H.264';
        else if (/AV1/.test(clean)) tags.videoCodec = 'AV1';
        else if (/VC-?1/.test(clean)) tags.videoCodec = 'VC-1';
        else if (/MPEG-?2/.test(clean)) tags.videoCodec = 'MPEG-2';

        // 3. 色深
        if (/12[\s._-]?BIT/i.test(clean)) tags.colorDepth = '12bit';
        else if (/10[\s._-]?BIT/i.test(clean)) tags.colorDepth = '10bit';
        else if (/8[\s._-]?BIT/i.test(clean)) tags.colorDepth = '8bit';

        // 4. 压制与介质
        if (/REMUX/i.test(clean)) {
            tags.resourceType = 'REMUX';
            tags.isRemux = true;
        } else if (/DIY/i.test(clean)) {
            tags.resourceType = 'DIY';
        } else if (/BDRIP/i.test(clean)) {
            tags.resourceType = 'BDRip';
        } else if (/WEBRIP/i.test(clean)) {
            tags.resourceType = 'WEBRip';
        }

        if (/BLU[- .]?RAY|\bBD\b|原盘/.test(clean)) {
            tags.mediaSource = 'BluRay';
            tags.isBluRay = true;
        } else if (/WEB[- .]?DL/.test(clean)) tags.mediaSource = 'WEB-DL';
        else if (/WEBRIP/.test(clean)) tags.mediaSource = 'WEBRip';
        else if (/HDTV/.test(clean)) tags.mediaSource = 'HDTV';
        else if (/DVD/.test(clean)) tags.mediaSource = 'DVD';

        // 5. 动态范围与杜比 / IMAX
        if (/\bIMAX\b|IMAX[\s._-]?(?:ENHANCED)?/i.test(clean)) {
            tags.isImax = true;
        }
        if (/\b(?:DV|DOVI)\b|DOLBY[\s._-]?VISION/i.test(clean)) {
            tags.dynamicRange = 'DV';
            tags.isDolby = true;
        } else if (/HDR10\+/.test(clean)) tags.dynamicRange = 'HDR10+';
        else if (/HDR10|HDR/.test(clean)) tags.dynamicRange = 'HDR10';
        else if (/\bHLG\b/i.test(clean)) tags.dynamicRange = 'HLG';
        else if (/\bSDR\b/i.test(clean)) tags.dynamicRange = 'SDR';

        // 6. 帧率提取
        const fpsMatch = clean.match(/\b(120|60|59\.94|50|30|29\.97|25|24|23\.976)[\s._-]?(?:FPS|帧)\b/i) ||
            clean.match(/\b(120|60|50|30|25|24)FPS\b/i);
        if (fpsMatch) {
            const num = parseFloat(fpsMatch[1]);
            if (num >= 119) { tags.frameRate = '120fps'; tags.frameRateRank = 6; }
            else if (num >= 59) { tags.frameRate = '60fps'; tags.frameRateRank = 5; }
            else if (num >= 49) { tags.frameRate = '50fps'; tags.frameRateRank = 4; }
            else if (num >= 29) { tags.frameRate = '30fps'; tags.frameRateRank = 3; }
            else if (num >= 24.5) { tags.frameRate = '25fps'; tags.frameRateRank = 2; }
            else if (num >= 23) { tags.frameRate = '24fps'; tags.frameRateRank = 1; }
        }

        // 7. 音频编码 (严格对齐 139 助手 2.8.x 标准：绝不丢弃声道 5.1/7.1，规范格式保持 DDP Atmos 5.1 / TrueHD Atmos 7.1)
        const audioChannel = clean.match(/(?:MA|DTS|PCM|TRUEHD|DDP|EAC3|AAC|\b)(7\.1|5\.1|5\.0|2\.0)\b/)?.[1] || '';
        const hasAtmos = /\bATMOS\b/i.test(clean);

        if (hasAtmos || /TRUEHD|DDP|EAC3|DD\+|DOLBY/i.test(clean)) {
            tags.isDolby = true;
        }

        if (/TRUEHD/.test(clean)) {
            const base = hasAtmos ? 'TrueHD Atmos' : 'TrueHD';
            tags.audioCodec = audioChannel ? `${base} ${audioChannel}` : base;
        } else if (/DDP|EAC3|DD\+/.test(clean)) {
            const base = hasAtmos ? 'DDP Atmos' : 'DDP';
            tags.audioCodec = audioChannel ? `${base} ${audioChannel}` : (hasAtmos ? 'DDP Atmos' : 'DDP 5.1');
        } else if (/DTS-HD[\s._-]?(?:MASTER[\s._-]?)?(?:MA|AUDIO)?|DTS-HDMA/.test(clean)) {
            tags.audioCodec = audioChannel ? ('DTS-HD MA ' + audioChannel) : 'DTS-HD MA';
        } else if (/DTS[\s._-]?(?:X\b|:X)/i.test(clean)) {
            tags.audioCodec = audioChannel ? ('DTS:X ' + audioChannel) : 'DTS:X';
        } else if (/DTS/.test(clean)) {
            tags.audioCodec = audioChannel ? ('DTS ' + audioChannel) : (audioChannel === '5.1' ? 'DTS 5.1' : 'DTS');
        } else if (/LPCM|PCM/.test(clean)) {
            tags.audioCodec = audioChannel ? ('LPCM ' + audioChannel) : 'LPCM';
        } else if (/FLAC/.test(clean)) {
            tags.audioCodec = audioChannel ? ('FLAC ' + audioChannel) : 'FLAC';
        } else if (/\bOPUS\b/i.test(clean)) {
            tags.audioCodec = audioChannel ? ('Opus ' + audioChannel) : 'Opus';
        } else if (/DD[\s._-]?2\.0|DD2\.0/.test(clean)) {
            tags.audioCodec = 'DD 2.0';
        } else if (/DD[\s._-]?5\.1|DD5\.1|AC3/.test(clean)) {
            tags.audioCodec = 'DD 5.1';
        } else if (/AAC/.test(clean)) {
            tags.audioCodec = audioChannel ? ('AAC ' + audioChannel) : 'AAC';
        } else if (hasAtmos) {
            tags.audioCodec = audioChannel ? `Atmos ${audioChannel}` : 'Atmos';
        }

        // 8. 发布组提取
        const stemForGroup = filename.replace(/\.[a-z0-9]+$/i, '');
        const groupMatch = stemForGroup.match(/-([A-Za-z0-9_@]+)$/i) ||
            filename.match(/^[\[【]([^\]】]+)[\]】]/) ||
            filename.match(/\b(HiveWeb|ADWeb|HHWEB|FRDS|MNHD|NoxiaAl|Mo Cuishle|CHD|HDS|WiKi|CMCT|ColorTV|Pikanet128)\b/i);
        if (groupMatch && groupMatch[1]) {
            const gCandidate = groupMatch[1].trim();
            const isInvalidGroup = /^\d+$/.test(gCandidate)
                || gCandidate.length < 2
                || /^(?:4k|8k|2160p|1080p|720p|480p|hevc|avc|h264|h265|x264|x265|hdr|hdr10|dovi|remux|web-?dl|webrip|aac|ddp|atmos|truehd|lpcm)$/i.test(gCandidate)
                || /^(?:tmdb(?:id)?[-_:]?\d+|\{tmdb(?:id)?[-_:]?\d+\})$/i.test(gCandidate)
                || /^(?:\d+(?:\.\d+)?(?:gb|mb|g|m)|v\d+)$/i.test(gCandidate);
            if (!isInvalidGroup) {
                tags.releaseGroup = gCandidate;
            }
        }

        // 9. 融合 MediaProbeService / IsoProbeService 媒体流探针硬探测结果 (streamMeta / probeResult)
        if (streamMeta && typeof streamMeta === 'object') {
            if (streamMeta.isFakeIso) {
                tags.isFakeIso = true;
                tags.realExt = streamMeta.realExt || '';
                tags.container = streamMeta.container || '';
            }
            if (streamMeta.isBluRay) {
                tags.isBluRay = true;
                tags.mediaSource = 'BluRay';
                tags.container = tags.container || 'M2TS';
            }
            if (streamMeta.isDvd) {
                tags.isDvd = true;
                tags.mediaSource = 'DVD';
                tags.container = tags.container || 'VOB';
                if (!tags.videoFormat) {
                    tags.videoFormat = '480p';
                    tags.resolutionRank = Math.max(tags.resolutionRank, 1);
                }
            }
            if (streamMeta.container) {
                tags.container = streamMeta.container;
            }
            if (streamMeta.videoFormat) {
                const normVf = streamMeta.videoFormat === '4K' ? '2160p' : streamMeta.videoFormat;
                tags.videoFormat = normVf;
                const vfRanks = { '8K': 7, '2160p': 6, '4K': 6, '2K': 5, '1080p': 4, '1080i': 4, '720p': 3, '540p': 2, '480p': 1 };
                tags.resolutionRank = vfRanks[normVf] || tags.resolutionRank;
            }
            if (streamMeta.videoCodec) {
                tags.videoCodec = streamMeta.videoCodec;
            }
            if (streamMeta.dynamicRange) {
                tags.dynamicRange = streamMeta.dynamicRange;
            }
            if (streamMeta.colorDepth) {
                tags.colorDepth = streamMeta.colorDepth;
            }
            if (streamMeta.audioCodec) {
                tags.audioCodec = streamMeta.audioCodec;
            }
            if (streamMeta.frameRate) {
                tags.frameRate = streamMeta.frameRate;
            }
            if (streamMeta.isDolby) {
                tags.isDolby = true;
                tags.dynamicRange = 'DV';
            }
            if (streamMeta.mediaSource && !tags.mediaSource) {
                tags.mediaSource = streamMeta.mediaSource;
            }
        }

        // 10. 当分辨率仍为空时，基于视频物理体积与码率基线推导 (防止裸名遗漏规格)
        if (!tags.videoFormat && tags.size > 0) {
            if (tags.size >= 3.0 * 1024 * 1024 * 1024) {
                tags.videoFormat = '2160p';
                tags.resolutionRank = Math.max(tags.resolutionRank, 6);
            } else if (tags.size >= 900 * 1024 * 1024) {
                tags.videoFormat = '1080p';
                tags.resolutionRank = Math.max(tags.resolutionRank, 4);
            } else if (tags.size >= 250 * 1024 * 1024) {
                tags.videoFormat = '720p';
                tags.resolutionRank = Math.max(tags.resolutionRank, 3);
            }
        }
        if (!tags.dynamicRange) {
            tags.dynamicRange = 'SDR';
        }

        // 统一前后端与画质仲裁对齐兼容字段
        tags.resolution = tags.videoFormat;
        tags.resRank = tags.resolutionRank;
        tags.hdr = tags.dynamicRange;
        tags.drRank = (function(dr) {
            const s = String(dr || '').toUpperCase();
            if (s.includes('DV+HDR') || s.includes('DOVI+HDR')) return 6;
            if (s.includes('DV') || s.includes('DOVI') || s.includes('DOLBY')) return 5;
            if (s.includes('HDR10+')) return 4;
            if (s.includes('HDR10') || s.includes('HDR')) return 3;
            if (s.includes('HLG')) return 2;
            return 1;
        })(tags.dynamicRange);
        tags.fpsRank = tags.frameRateRank;

        return tags;
    }

    /**
     * DDSRem / MoviePilot 标准二级细分分类推导
     */
    static inferLibraryCategory(fields, tmdbData = {}) {
        const isMovie = fields?.mediaType === 'movie';
        const rawLang = String(tmdbData.original_language || fields?.originalLanguage || '').toLowerCase();
        const countries = (tmdbData.production_countries || tmdbData.origin_country || fields?.productionCountries || []).map(c => typeof c === 'string' ? c.toUpperCase() : (c?.iso_3166_1 || '').toUpperCase());
        const genreIds = new Set((tmdbData.genres || tmdbData.genre_ids || tmdbData.genreIds || fields?.genre_ids || fields?.genres || []).map(g => Number(g.id || g)));
        const genreNames = new Set((tmdbData.genres || []).map(g => String(g.name || '')));

        const isDoc = genreIds.has(99) || genreNames.has('纪录') || genreNames.has('纪录片');
        const isAnime = genreIds.has(16) || genreNames.has('动画');

        if (isMovie) {
            if (isDoc) return '纪录片';
            if (isAnime) return '动画电影';
            if (genreIds.has(10402) || genreNames.has('音乐')) return '演唱会';
            if (['zh', 'cmn', 'yue', 'cn'].includes(rawLang) || countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) {
                return '华语电影';
            }
            if (['en'].includes(rawLang) || ['US', 'GB', 'UK', 'CA', 'AU', 'FR', 'DE', 'IT', 'ES'].some(c => countries.includes(c))) {
                return '欧美电影';
            }
            if (['ja', 'ko'].includes(rawLang) || countries.includes('JP') || countries.includes('KR')) {
                return '日韩电影';
            }
            return '外语电影';
        } else {
            // TV 剧集
            if (isDoc) return '纪录片';
            if (genreIds.has(10764) || genreIds.has(10767) || genreNames.has('真人秀') || genreNames.has('脱口秀') || genreNames.has('综艺')) {
                return '综艺';
            }
            if (genreIds.has(10762) || genreNames.has('儿童')) return '儿童';
            if (isAnime) {
                if (['zh', 'cmn', 'cn'].includes(rawLang) || countries.includes('CN')) return '国漫';
                if (['ja'].includes(rawLang) || countries.includes('JP')) return '日番';
                return '动漫';
            }
            if (['zh', 'cmn', 'yue', 'cn'].includes(rawLang) || countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) {
                return '国产剧';
            }
            if (['en'].includes(rawLang) || ['US', 'GB', 'UK', 'CA', 'AU'].some(c => countries.includes(c))) {
                return '欧美剧';
            }
            if (['ja', 'ko'].includes(rawLang) || countries.includes('JP') || countries.includes('KR')) {
                return '日韩剧';
            }
            return '未分类';
        }
    }

    /**
     * 标题比对键：繁转简 + 小写 + 仅保留字母数字(含中日韩文字)。用于“精确命中”判定，
     * 标点/空格/大小写差异不影响命中，但任何多余或缺失的词都会导致不命中。
     */
    static normalizeTitleKey(value) {
        return this.toSimplified(String(value || '')).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    }

    /** 中文数字(一~九十九)/阿拉伯数字转整数，无法识别返回 null */
    static _cnNumToInt(text) {
        return this.parseChineseNumber(text);
    }

    /**
     * 从目录名提取显式季号：Season 02 / S02 / 第二季 / Specials(=0)。无显式季标识返回 null。
     */
    static parseSeasonFromFolderName(name) {
        const s = String(name || '').trim();
        if (!s) return null;
        if (/^(?:specials?|特别篇|特典|番外)$/i.test(s)) return 0;
        let m = s.match(/(?:^|[\s._\-\[(（【])Season[\s._-]*0*(\d{1,3})(?!\d)/i);
        if (m) return parseInt(m[1], 10);
        m = s.match(/第\s*([0-9零〇一二两兩三四五六七八九十]{1,4})\s*季/);
        if (m) {
            const n = this._cnNumToInt(m[1]);
            if (n !== null) return n;
        }
        m = s.match(/(?:^|[\s._\-\[(（【])S0*(\d{1,2})(?=$|[\s._\-\])）】])/i);
        if (m) return parseInt(m[1], 10);
        return null;
    }

    /**
     * 季号证据裁决：显式季号(文件名) > 目录季号 > TMDB 仅有一个正式季。
     * 文件名与目录季号冲突、或无法确定季号时拒绝(ok=false)，绝不猜测。
     */
    static resolveEpisodeSeason({ season, seasonInferred = false, folderSeason = null, tmdbSeasons = [] } = {}) {
        const parsed = (season !== '' && season !== null && season !== undefined) ? parseInt(season, 10) : NaN;
        const explicit = (!seasonInferred && Number.isInteger(parsed)) ? parsed : null;
        if (explicit !== null) {
            if (folderSeason !== null && folderSeason !== undefined && folderSeason !== explicit) {
                return { ok: false, reason: 'season_conflict' };
            }
            return { ok: true, season: explicit, source: 'filename' };
        }
        if (folderSeason !== null && folderSeason !== undefined) {
            return { ok: true, season: folderSeason, source: 'folder' };
        }
        const regular = (Array.isArray(tmdbSeasons) ? tmdbSeasons : []).filter(s => Number(s.season_number) > 0);
        if (regular.length === 1) {
            return { ok: true, season: Number(regular[0].season_number), source: 'single_season' };
        }
        return { ok: false, reason: 'season_ambiguous' };
    }

    /**
     * 集数校验：TMDB 必须存在该季，且集号在 [1, episode_count] 内；集数未知同样拒绝。
     */
    static validateEpisodeInSeasons(tmdbSeasons, season, episode) {
        const entry = (Array.isArray(tmdbSeasons) ? tmdbSeasons : []).find(s => Number(s.season_number) === Number(season));
        if (!entry) return { ok: false, reason: 'season_not_found' };
        const ep = Number(episode);
        if (!Number.isInteger(ep) || ep < 1) return { ok: false, reason: 'episode_invalid' };
        const count = Number(entry.episode_count || 0);
        if (count <= 0) return { ok: false, reason: 'episode_count_unknown' };
        if (ep > count) return { ok: false, reason: 'episode_out_of_range' };
        return { ok: true };
    }

    /**
     * 提取 Emby/Jellyfin 风格 TMDB 标签：{tmdb-123} / [tmdbid-123] / tmdbid=123。无则返回 null。
     */
    static extractTmdbIdTag(text) {
        const s = String(text || '');
        const m = s.match(/[\{\[]\s*(?:tmdb|tmdbid)[-:=_ ]?(\d{1,10})\s*[\}\]]/i) || s.match(/\btmdbid[-=_](\d{1,10})\b/i);
        return m ? m[1] : null;
    }

    /** 剥离文本中的 TMDB 标签，便于后续标题解析 */
    static stripTmdbIdTag(text) {
        return String(text || '')
            .replace(/[\{\[]\s*(?:tmdb|tmdbid)[-:=_ ]?\d{1,10}\s*[\}\]]/gi, ' ')
            .replace(/\btmdbid[-=_]\d{1,10}\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * TMDB 候选条目多维度打分器 (供内部打分与 tmdb.js 调用)
     * @param {object} candidate
     * @param {object} fields
     * @returns {number}
     */
    static scoreTmdbCandidate(candidate, fields = {}) {
        if (!candidate) return -1;
        let score = 0;

        const targetTitle = String(fields.title || '').trim();
        const candTitle = String(candidate.title || candidate.name || '').trim();
        const candOrig = String(candidate.originalTitle || candidate.originalName || '').trim();
        const normTarget = this.normalizeTitleKey(targetTitle);
        const normCand = this.normalizeTitleKey(candTitle);
        const normOrig = this.normalizeTitleKey(candOrig);

        if (!normTarget || /^(?:season\d+|s\d+|第[0-9零〇一二两兩三四五六七八九十]+[季集话])$/.test(normTarget) || targetTitle === '待识别影视') {
            return -500;
        }

        // 纯数字放行铁律：放行《2012》《1917》《300》纯数字电影，仅当完全一致时放行
        if (/^\d+$/.test(normTarget)) {
            if (normCand !== normTarget && normOrig !== normTarget) {
                return -500;
            }
        }

        // 演唱会日期检查
        const targetDate = fields.concertDate || this.extractConcertDate(fields.title);
        const candDate = this.extractConcertDate(candidate.title) || this.extractConcertDate(candidate.originalTitle);
        if (targetDate && candDate) {
            if (targetDate === candDate) score += 250;
            else return -500;
        }

        // 别名矩阵
        const aliases = this.getAliases(fields.title).concat(this.getAliases(fields.englishTitle));
        const hasAliasHit = aliases.some(a => {
            const na = this.normalizeTitleKey(a);
            return na && (normCand === na || normOrig === na || (na.length >= 2 && (normCand.includes(na) || normOrig.includes(na))));
        });

        // 标题完全匹配或别名命中
        const hasExactHit = (normTarget && (normCand === normTarget || normOrig === normTarget));
        const hasTransHit = Boolean(candidate.translatedTitles && (Array.isArray(candidate.translatedTitles) ? candidate.translatedTitles : []).some(t => {
            const nt = this.normalizeTitleKey(t);
            return nt && (nt === normTarget || (normTarget.length >= 2 && nt.includes(normTarget)));
        }));

        if (hasExactHit || hasAliasHit || hasTransHit) {
            score += 220;
        } else if (normTarget.length >= 2 && (normCand.includes(normTarget) || normTarget.includes(normCand) || normOrig.includes(normTarget))) {
            score += 180;
        } else {
            return -500; // 无直接关联一票否决
        }

        // 年份打分与冲突熔断
        const candYearStr = candidate.year || (candidate.release_date || candidate.first_air_date || '').substring(0, 4);
        const isTvSeries = candidate.mediaType === 'tv' || fields.mediaType === 'tv' || Boolean(candidate.first_air_date) || Boolean(fields.season);
        if (fields.year && candYearStr) {
            const yTarget = parseInt(fields.year, 10);
            const yCand = parseInt(candYearStr, 10);
            if (Number.isInteger(yTarget) && Number.isInteger(yCand)) {
                const diff = Math.abs(yTarget - yCand);
                if (diff === 0) {
                    score += 140;
                } else if (diff === 1) {
                    score += 40;
                } else if (isTvSeries && yCand <= yTarget) {
                    // 核心铁律：电视剧/动漫连载剧在 TMDB 上的年份严格代表整部剧的【首播年】！
                    // 发布组标明的 (2026) 代表当季播出/更新年（如第2/3季在2026年播出，首播年在2021/2023年）。
                    // 首播年在更新年之前完全正常，绝对不能熔断判死！
                    score += Math.max(10, 40 - (yTarget - yCand) * 2);
                } else {
                    return -500; // 电影或剧集首播年严重晚于目标年，跨年份严重冲突熔断
                }
            }
        }

        // 续集代数冲突熔断 (防《神偷奶爸3》匹配第1部，但 TV 剧集在 TMDB 上通常无独立代数条目)
        const targetSeq = this.extractSequelNum(fields.title);
        const candSeq = this.extractSequelNum(candidate.title) || this.extractSequelNum(candidate.originalTitle);
        if (targetSeq || candSeq) {
            if (targetSeq && candSeq) {
                if (targetSeq === candSeq) score += 150;
                else return -500;
            } else if (isTvSeries && targetSeq && !candSeq) {
                // TV 剧集在 TMDB 上条目名为纯剧名（如《大王饶命》），目标带代数（如《大王饶命3》）代表季播（第3季），允许匹配主剧！
                score += 30;
            } else {
                return -500; // 电影单侧缺失代数一票否决
            }
        }

        // 衍生剧/前传/番外降权：当目标片名未声明前传/番外，而候选为衍生作品时，大幅扣分避免喧宾夺主
        const isCandSpinoff = /(?:前传|番外|外传|特别篇|剧场版|日常篇|日剧版|美剧版|韩剧版|真人版|电视剧版)/i.test(candTitle) || /(?:前传|番外|外传|特别篇|剧场版|日常篇|日剧版|美剧版|韩剧版|真人版|电视剧版)/i.test(candOrig);
        const isTargetSpinoff = /(?:前传|番外|外传|特别篇|剧场版|日常篇|日剧版|美剧版|韩剧版|真人版|电视剧版)/i.test(targetTitle);
        if (isCandSpinoff && !isTargetSpinoff) {
            score -= 150;
        }

        // 媒体类型
        if (fields.mediaType && candidate.mediaType) {
            if (fields.mediaType === candidate.mediaType) score += 80;
            else score -= 160;
        }

        score += Math.min(Number(candidate.popularity || 0), 100) / 20;
        return score;
    }

    /**
     * 严格择优（准确率优先，支持全区域 Translations 官方多语言译名证据链）
     * 候选须为规范化结构 { id, mediaType, title, originalTitle, year }。
     * @param {Array<object>} candidates
     * @param {object} fields
     * @param {object} options 选项或 tmdbClient / tmdbService 实例
     * @returns {Promise<object>} { candidate, score, reason, evidence, regionalTranslations, translationsDisplay }
     */
    static async chooseTmdbCandidate(candidates, fields = {}, options = {}) {
        const client = options.tmdbClient || options.tmdbService || (options.getTranslations ? options : null);
        const minScore = Number(options.minScore ?? 280);
        const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
        const brief = (c, score) => ({ id: String(c.id), title: c.title || '', year: c.year || '', mediaType: c.mediaType || '', score });
        const fail = (reason, extra = {}) => ({
            candidate: null,
            score: 0,
            reason,
            evidence: { rule: 'strict_title', reason, candidates: list.slice(0, 3).map(c => brief(c, 0)), ...extra },
            regionalTranslations: {},
            translationsDisplay: ''
        });

        const normTitle = this.normalizeTitleKey(fields.title);
        if (!normTitle) return fail('empty_title');
        if (/^(?:season\d+|s\d+|第[0-9零〇一二两兩三四五六七八九十]+[季集话])$/.test(normTitle)) {
            return fail('title_is_marker');
        }
        if (!list.length) return fail('no_candidates');

        // 自动注入通用动漫别名库
        const aliasList = this.getAliases(fields.title).concat(this.getAliases(fields.englishTitle));
        const combinedAliases = Array.from(new Set([...(Array.isArray(fields.aliases) ? fields.aliases : []), ...aliasList]));
        const targets = new Set(
            [fields.title, fields.englishTitle, ...combinedAliases]
                .map(t => this.normalizeTitleKey(t))
                .filter(Boolean)
        );

        const targetYear = parseInt(fields.year, 10);
        const hasYear = Number.isInteger(targetYear);
        const typed = list.filter(c => !fields.mediaType || !c.mediaType || c.mediaType === fields.mediaType);

        // 打分
        let scored = typed.map(c => ({
            c,
            score: this.scoreTmdbCandidate(c, { ...fields, aliases: combinedAliases })
        })).filter(item => item.score > 0);

        scored.sort((a, b) => b.score - a.score);
        let top = scored[0];

        // 联动 Translations 官方全区域译名证据链验证（支持港/台/陆/新跨地区公映异名）
        if ((!top || top.score < minScore) && client && typed.length > 0) {
            const prime = top?.c || typed[0];
            const candYear = parseInt(prime.year, 10);
            const yearMatch = !hasYear || (Number.isInteger(candYear) && Math.abs(candYear - targetYear) <= 1);
            if (yearMatch) {
                try {
                    const trans = await client.getTranslations(prime.id, prime.mediaType);
                    prime.translatedTitles = trans;
                    const transHit = (Array.isArray(trans) ? trans : []).some(t => {
                        const nt = this.normalizeTitleKey(t);
                        return nt && targets.has(nt);
                    });
                    if (transHit) {
                        prime.regionalTranslations = trans.regional || {};
                        prime.translationsDisplay = trans.display || '';
                        top = { c: prime, score: 320 };
                    }
                } catch (_) {}
            }
        }

        if (!top || top.score < minScore) {
            return fail('no_exact_match');
        }

        // 续集代数冲突二次安全门禁 (TV 剧集在 TMDB 上通常无独立代数条目，允许匹配主剧)
        const isTvSeries = top.c.mediaType === 'tv' || fields.mediaType === 'tv' || Boolean(fields.season);
        const targetSeq = this.extractSequelNum(fields.title);
        const candSeq = this.extractSequelNum(top.c.title) || this.extractSequelNum(top.c.originalTitle);
        if ((targetSeq || candSeq) && (!targetSeq || !candSeq || targetSeq !== candSeq)) {
            if (!(isTvSeries && targetSeq && !candSeq)) {
                return fail('sequel_conflict', { targetSeq, candSeq });
            }
        }

        // 年份冲突二次安全门禁 (连载剧首播年在当季更新年之前完全正常)
        if (hasYear && top.c.year) {
            const candY = parseInt(top.c.year, 10);
            const diff = Math.abs(candY - targetYear);
            if (diff > 1) {
                if (!(isTvSeries && candY <= targetYear)) {
                    return fail('year_conflict', { targetYear, candYear: top.c.year });
                }
            }
        }

        // 无年份同名多年份作品歧义防误判
        if (!hasYear) {
            const normCand = this.normalizeTitleKey(top.c.title);
            const ambiguousOthers = typed.filter(o => {
                if (String(o.id) === String(top.c.id)) return false;
                const oNorm = this.normalizeTitleKey(o.title);
                return (oNorm === normTitle || oNorm === normCand) && o.year && top.c.year && String(o.year) !== String(top.c.year);
            });
            if (ambiguousOthers.length > 0) {
                return fail('ambiguous_same_title', { ambiguousYears: [top.c.year, ...ambiguousOthers.map(x => x.year)] });
            }
        }

        const ranked = scored.slice(0, 3).map(e => brief(e.c, e.score));
        return {
            candidate: top.c,
            score: top.score,
            reason: 'exact_title',
            evidence: { rule: 'strict_title', score: top.score, candidates: ranked },
            regionalTranslations: top.c.regionalTranslations || top.c.translatedTitles?.regional || {},
            translationsDisplay: top.c.translationsDisplay || top.c.translatedTitles?.display || ''
        };
    }

    /**
     * 判断是否满足杜比视界多版本共存豁免条件
     * 开启后，杜比视界 (DV) 与非杜比视界 (SDR/HDR) 视为不同版本，互不覆盖淘汰，准予共存
     */
    static shouldCoexistDolby(a, b, policy = {}) {
        if (!policy || !policy.keepDolbyMultiVersion) return false;
        const aIsDV = Boolean(a?.isDolby || /DV|DOLBY/i.test(a?.dynamicRange || ''));
        const bIsDV = Boolean(b?.isDolby || /DV|DOLBY/i.test(b?.dynamicRange || ''));
        return (aIsDV && !bIsDV) || (!aIsDV && bIsDV);
    }

    /**
     * 8 级可配置洗版覆盖策略加权比对排序
     * 支持用户自定义 8 级优先级序列 (washPriorityOrder)
     * ① 发布组 (releaseGroup)
     * ② 资源类型 (resourceType): Remux > BluRay > BDRip > WEB-DL > WEBRip > HDTV > DVD
     * ③ 分辨率 (videoFormat): 8K > 4K > 2K > 1080p > 720p > 576p > 480p
     * ④ 动态范围 (dynamicRange): DV+HDR > DV > HDR10+ > HDR10/HDR > HLG > SDR
     * ⑤ 色深 (colorDepth): 12bit > 10bit > 8bit
     * ⑥ 音频规格 (audioCodec): TrueHD Atmos > DTS:X > TrueHD > DDP Atmos > DTS-HD MA > LPCM > FLAC > DDP > DTS > DD 5.1 > AAC
     * ⑦ 帧率 (frameRate): 120fps > 60fps > 50fps > 30fps > 25fps > 24fps
     * ⑧ 文件大小 (fileSize): 大文件优先 / 小文件优先
     */
    /**
     * 单步权威决胜制洗版画质仲裁
     * 严格按照用户配置的优先级顺序（默认分辨率绝对优先）自上而下比对：
     * 一旦在高优先级维度分出胜负，立即短路决胜并返回决胜原因与细节，后续低级维度一概不比；
     * 只有在当前维度完全相等时，才继续比对下一个维度。
     * 严禁出现同值比优。
     */
    static compareCandidatesDecisive(a, b, policy = {}) {
        let storedOrder = [];
        try {
            const ConfigService = require('./ConfigService');
            storedOrder = ConfigService.getConfigValue('channelMonitor.washPriorityOrder')
                || ConfigService.getConfigValue('washPriorityOrder')
                || [];
        } catch (_) {}

        // 权威画质基石排序：分辨率与动态范围绝对优先于常规介质标注
        const defaultOrder = [
            'videoFormat',
            'dynamicRange',
            'resourceType',
            'releaseGroup',
            'frameRate',
            'colorDepth',
            'audioCodec',
            'fileSize'
        ];
        const rawOrder = Array.isArray(policy.washPriorityOrder) && policy.washPriorityOrder.length > 0
            ? policy.washPriorityOrder
            : (Array.isArray(storedOrder) && storedOrder.length > 0 ? storedOrder : defaultOrder);

        const priorityOrder = Array.from(new Set([...rawOrder, ...defaultOrder]));

        // 辅助映射与可读文本提取
        const getResourceTypeInfo = (cand) => {
            if (cand.isRemux || /REMUX/i.test(cand.resourceType || '')) return { score: 7, label: 'Remux' };
            if (cand.isBluRay || /BLU[- .]?RAY|原盘/i.test(cand.resourceType || cand.mediaSource || '')) return { score: 6, label: 'Blu-ray' };
            if (/BDRIP/i.test(cand.resourceType || '')) return { score: 5, label: 'BDRip' };
            if (/WEB[- .]?DL/i.test(cand.resourceType || cand.mediaSource || '')) return { score: 4, label: 'WEB-DL' };
            if (/WEBRIP/i.test(cand.resourceType || cand.mediaSource || '')) return { score: 3, label: 'WEBRip' };
            if (/HDTV/i.test(cand.resourceType || cand.mediaSource || '')) return { score: 2, label: 'HDTV' };
            if (/DVD/i.test(cand.resourceType || cand.mediaSource || '')) return { score: 1, label: 'DVD' };
            return { score: 3, label: 'WEB-DL' };
        };

        const getDynamicRangeInfo = (cand) => {
            const dr = String(cand.dynamicRange || '').toUpperCase();
            if (dr.includes('DV+HDR') || (cand.isDolby && /HDR/.test(dr))) return { score: 6, label: 'DV+HDR' };
            if (cand.isDolby || dr.includes('DV')) return { score: 5, label: 'Dolby Vision' };
            if (dr.includes('HDR10+')) return { score: 4, label: 'HDR10+' };
            if (dr.includes('HDR10') || dr.includes('HDR')) return { score: 3, label: 'HDR10' };
            if (dr.includes('HLG')) return { score: 2, label: 'HLG' };
            if (dr.includes('SDR')) return { score: 1, label: 'SDR' };
            return { score: 1, label: 'SDR' };
        };

        const getColorDepthInfo = (cand) => {
            const cd = String(cand.colorDepth || '').toLowerCase();
            if (cd.includes('12')) return { score: 3, label: '12bit' };
            if (cd.includes('10')) return { score: 2, label: '10bit' };
            if (cd.includes('8')) return { score: 1, label: '8bit' };
            return { score: 1, label: '8bit' };
        };

        const getAudioCodecInfo = (cand) => {
            const ac = String(cand.audioCodec || '').toUpperCase();
            if (ac.includes('TRUEHD') && ac.includes('ATMOS')) return { score: 11, label: 'TrueHD Atmos' };
            if (ac.includes('DTS:X') || ac.includes('DTS-X')) return { score: 10, label: 'DTS:X' };
            if (ac.includes('TRUEHD')) return { score: 9, label: 'TrueHD' };
            if ((ac.includes('DDP') || ac.includes('EAC3')) && ac.includes('ATMOS')) return { score: 8, label: 'DDP Atmos' };
            if (ac.includes('DTS-HD') || ac.includes('DTS-HDMA')) return { score: 7, label: 'DTS-HD MA' };
            if (ac.includes('LPCM') || ac.includes('PCM')) return { score: 6, label: 'LPCM' };
            if (ac.includes('FLAC')) return { score: 5, label: 'FLAC' };
            if (ac.includes('DDP') || ac.includes('EAC3') || ac.includes('DD+')) return { score: 4, label: 'DDP 5.1' };
            if (ac.includes('DTS')) return { score: 3, label: 'DTS 5.1' };
            if (ac.includes('DD') || ac.includes('AC3')) return { score: 2, label: 'DD 5.1' };
            if (ac.includes('AAC')) return { score: 1, label: 'AAC' };
            return { score: 1, label: 'AAC' };
        };

        for (const criterion of priorityOrder) {
            switch (criterion) {
                case 'videoFormat': {
                    if (policy.preferHighResolution !== false) {
                        const rankA = Number(a.resolutionRank || 0);
                        const rankB = Number(b.resolutionRank || 0);
                        if (rankA !== rankB) {
                            const aBetter = rankA > rankB;
                            const resA = a.videoFormat || a.resolution || `${rankA}级分辨率`;
                            const resB = b.videoFormat || b.resolution || `${rankB}级分辨率`;
                            return {
                                cmp: aBetter ? -1 : 1,
                                winner: aBetter ? 'a' : 'b',
                                decisiveCriterion: 'videoFormat',
                                decisiveLabel: '分辨率',
                                decisiveDetail: aBetter ? `${resA} 优于 ${resB}` : `${resB} 优于 ${resA}`
                            };
                        }
                    }
                    break;
                }
                case 'dynamicRange': {
                    if (policy.preferDolby !== false) {
                        const infoA = getDynamicRangeInfo(a);
                        const infoB = getDynamicRangeInfo(b);
                        if (infoA.score !== infoB.score) {
                            const aBetter = infoA.score > infoB.score;
                            return {
                                cmp: aBetter ? -1 : 1,
                                winner: aBetter ? 'a' : 'b',
                                decisiveCriterion: 'dynamicRange',
                                decisiveLabel: '动态范围',
                                decisiveDetail: aBetter ? `${infoA.label} 优于 ${infoB.label}` : `${infoB.label} 优于 ${infoA.label}`
                            };
                        }
                    }
                    break;
                }
                case 'resourceType': {
                    if (policy.preferRemux !== false) {
                        const infoA = getResourceTypeInfo(a);
                        const infoB = getResourceTypeInfo(b);
                        if (infoA.score !== infoB.score) {
                            const aBetter = infoA.score > infoB.score;
                            return {
                                cmp: aBetter ? -1 : 1,
                                winner: aBetter ? 'a' : 'b',
                                decisiveCriterion: 'resourceType',
                                decisiveLabel: '资源介质',
                                decisiveDetail: aBetter ? `${infoA.label} 优于 ${infoB.label}` : `${infoB.label} 优于 ${infoA.label}`
                            };
                        }
                    }
                    break;
                }
                case 'releaseGroup': {
                    if (policy.enableReleaseGroupPriority !== false && policy.releaseGroups?.length) {
                        const getGroupRank = (grp) => {
                            if (!grp) return 999;
                            const idx = policy.releaseGroups.findIndex(g => String(grp).toLowerCase().includes(String(g).toLowerCase()));
                            return idx === -1 ? 999 : idx;
                        };
                        const rankA = getGroupRank(a.releaseGroup);
                        const rankB = getGroupRank(b.releaseGroup);
                        if (rankA !== rankB) {
                            const aBetter = rankA < rankB; // 越小优先级越高
                            const grpA = a.releaseGroup || '未知组';
                            const grpB = b.releaseGroup || '未知组';
                            return {
                                cmp: aBetter ? -1 : 1,
                                winner: aBetter ? 'a' : 'b',
                                decisiveCriterion: 'releaseGroup',
                                decisiveLabel: '发布组',
                                decisiveDetail: aBetter ? `优先发布组【${grpA}】优于【${grpB}】` : `优先发布组【${grpB}】优于【${grpA}】`
                            };
                        }
                    }
                    break;
                }
                case 'frameRate': {
                    const rankA = Number(a.frameRateRank || 0);
                    const rankB = Number(b.frameRateRank || 0);
                    if (rankA !== rankB && (rankA > 0 || rankB > 0)) {
                        const aBetter = rankA > rankB;
                        const fpsA = a.frameRate || '标准帧率';
                        const fpsB = b.frameRate || '标准帧率';
                        return {
                            cmp: aBetter ? -1 : 1,
                            winner: aBetter ? 'a' : 'b',
                            decisiveCriterion: 'frameRate',
                            decisiveLabel: '高帧率',
                            decisiveDetail: aBetter ? `${fpsA} 优于 ${fpsB}` : `${fpsB} 优于 ${fpsA}`
                        };
                    }
                    break;
                }
                case 'colorDepth': {
                    const infoA = getColorDepthInfo(a);
                    const infoB = getColorDepthInfo(b);
                    if (infoA.score !== infoB.score) {
                        const aBetter = infoA.score > infoB.score;
                        return {
                            cmp: aBetter ? -1 : 1,
                            winner: aBetter ? 'a' : 'b',
                            decisiveCriterion: 'colorDepth',
                            decisiveLabel: '色彩位深',
                            decisiveDetail: aBetter ? `${infoA.label} 优于 ${infoB.label}` : `${infoB.label} 优于 ${infoA.label}`
                        };
                    }
                    break;
                }
                case 'audioCodec': {
                    const infoA = getAudioCodecInfo(a);
                    const infoB = getAudioCodecInfo(b);
                    if (Math.max(infoA.score, infoB.score) >= 3 && infoA.score !== infoB.score) {
                        const aBetter = infoA.score > infoB.score;
                        return {
                            cmp: aBetter ? -1 : 1,
                            winner: aBetter ? 'a' : 'b',
                            decisiveCriterion: 'audioCodec',
                            decisiveLabel: '音频规格',
                            decisiveDetail: aBetter ? `${infoA.label} 优于 ${infoB.label}` : `${infoB.label} 优于 ${infoA.label}`
                        };
                    }
                    break;
                }
                case 'fileSize': {
                    const sizeA = Number(a.size || 0);
                    const sizeB = Number(b.size || 0);
                    if (sizeA > 0 && sizeB > 0 && Math.abs(sizeA - sizeB) > 50 * 1024 * 1024) {
                        const aBetter = policy.conflictMode === 0 ? sizeA < sizeB : sizeA > sizeB;
                        const sizeStrA = (sizeA / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                        const sizeStrB = (sizeB / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                        return {
                            cmp: aBetter ? -1 : 1,
                            winner: aBetter ? 'a' : 'b',
                            decisiveCriterion: 'fileSize',
                            decisiveLabel: '文件大小',
                            decisiveDetail: aBetter ? `${sizeStrA} 优于 ${sizeStrB}` : `${sizeStrB} 优于 ${sizeStrA}`
                        };
                    }
                    break;
                }
            }
        }

        return {
            cmp: 0,
            winner: 'equal',
            decisiveCriterion: 'equal',
            decisiveLabel: '画质规格',
            decisiveDetail: '画质规格一致'
        };
    }

    static compareCandidates(a, b, policy = {}) {
        return this.compareCandidatesDecisive(a, b, policy).cmp;
    }

    /**
     * 解析媒体文件名结构
     */
    static parseMediaFilename(filename) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        const tags = this.inferTechnicalTags(filename);
        
        let title = '';
        let season = '';
        let episode = '';
        let season_episode = '';
        let isTv = false;
        let _seasonInferred = false;
        let part = '';

        const partMatch = base.match(/\bPart\.?\s*(\d+|[IVX]+)\b/i);
        if (partMatch) {
            part = `Part${partMatch[1]}`;
        }

        // 1. 优先匹配标准一体化季集标记：S01E02 或 1x02
        const seMatch = base.match(/[._\s-]*[Ss](\d{1,3})[._\s-]?[Ee](\d{1,3})/);
        const xMatch = !seMatch ? base.match(/(?:^|[._\s-])(\d{1,2})[xX](\d{1,3})(?:$|[._\s-])/) : null;

        if (seMatch) {
            season = String(parseInt(seMatch[1], 10));
            episode = String(parseInt(seMatch[2], 10));
            season_episode = `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
            isTv = true;
            _seasonInferred = false;
        } else if (xMatch) {
            season = String(parseInt(xMatch[1], 10));
            episode = String(parseInt(xMatch[2], 10));
            season_episode = `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
            isTv = true;
            _seasonInferred = false;
        } else {
            // 2. 分离复合模式：分别探测显式季号与集号
            let foundSeason = null;
            const seasonEnMatch = base.match(/(?:^|[._\s-])Season[\s._-]*(\d{1,3})\b/i);
            const seasonSMatch = !seasonEnMatch ? base.match(/(?:^|[._\s-])S0*(\d{1,2})\b(?!\s*[Ee]\d)/i) : null;
            const seasonCnMatch = !seasonEnMatch && !seasonSMatch ? base.match(/(?:^|[._\s-]|(?<=[\u3400-\u9fff]))第\s*([0-9零〇一二两兩三四五六七八九十百\d]+)\s*[季部]/i) : null;

            if (seasonEnMatch) {
                foundSeason = parseInt(seasonEnMatch[1], 10);
            } else if (seasonSMatch) {
                foundSeason = parseInt(seasonSMatch[1], 10);
            } else if (seasonCnMatch) {
                foundSeason = this.parseChineseNumber(seasonCnMatch[1]);
            }

            let foundEpisode = null;
            const epEnMatch = base.match(/(?:^|[._\s-])(?:Episode|EP)[\s._-]*(\d{1,4})\b/i);
            const epSingleMatch = !epEnMatch ? base.match(/(?:^|[._\s-])E0*(\d{1,4})\b/i) : null;
            const epCnMatch = !epEnMatch && !epSingleMatch ? base.match(/(?:^|[._\s-]|(?<=[\u3400-\u9fff]))第\s*(\d{1,4})\s*[集话期]/) : null;
            const epLegacyMatch = !epEnMatch && !epSingleMatch && !epCnMatch ? base.match(/\b[Ee][Pp]?(\d{2,3})\b/) : null;

            if (epEnMatch) {
                foundEpisode = parseInt(epEnMatch[1], 10);
            } else if (epSingleMatch) {
                foundEpisode = parseInt(epSingleMatch[1], 10);
            } else if (epCnMatch) {
                foundEpisode = parseInt(epCnMatch[1], 10);
            } else if (epLegacyMatch) {
                foundEpisode = parseInt(epLegacyMatch[1], 10);
            }

            if (foundEpisode !== null && Number.isInteger(foundEpisode)) {
                isTv = true;
                episode = String(foundEpisode);
                if (foundSeason !== null && Number.isInteger(foundSeason)) {
                    season = String(foundSeason);
                    season_episode = `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
                    _seasonInferred = false;
                } else {
                    season = '1';
                    season_episode = `S01E${episode.padStart(2, '0')}`;
                    _seasonInferred = true;
                }
            } else if (foundSeason !== null && Number.isInteger(foundSeason)) {
                season = String(foundSeason);
                isTv = true;
                _seasonInferred = false;
            }
        }

        const yearMatch = base.match(/\b((?:19|20)\d{2})\b/);
        const year = yearMatch ? yearMatch[1] : '';

        // 提取标题：截除季集标识与技术规格
        const titleEndPatterns = [
            /[._\s-]+[Ss]\d{1,3}[._\s-]?[Ee]\d{1,3}/i,
            /[._\s-]+\d{1,2}[xX]\d{1,3}\b/,
            /[._\s-]+(?:Season[\s._-]*\d{1,3}|S\d{1,3})\b/i,
            /(?:[._\s-]+|(?<=[\u3400-\u9fff]))第\s*[0-9零〇一二两兩三四五六七八九十百\d]+\s*[季部]/i,
            /[._\s-]+(?:Episode|EP)[\s._-]*\d{1,4}\b/i,
            /[._\s-]+[Ee][Pp]?\d{2,4}\b/i,
            /(?:[._\s-]+|(?<=[\u3400-\u9fff]))第\s*\d{1,4}\s*[集话期]/,
            /[._\s-]*\((?:19|20)\d{2}\)/,
            /[._\s-]+(?:19|20)\d{2}[._\s-]/,
            /[._\s-]+(?:2160p|1440p|1080p|720p|480p|4k|uhd)\b/i,
            /[._\s-]+(?:WEB-DL|WEBRip|BluRay|Blu-Ray|BDRemux|BDRip|HDTV|DVDRip|REMUX)\b/i,
        ];
        let titleEnd = base.length;
        for (const pattern of titleEndPatterns) {
            const matchPos = base.search(pattern);
            if (matchPos > 0 && matchPos < titleEnd) titleEnd = matchPos;
        }
        let rawTitle = base.substring(0, titleEnd);
        rawTitle = rawTitle.replace(/[._]/g, ' ').replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
        title = rawTitle || base;

        return {
            title,
            year,
            season,
            episode,
            season_episode,
            part,
            _seasonInferred,
            mediaType: isTv ? 'tv' : 'movie',
            extension: ext.toLowerCase(),
            ...tags
        };
    }

    static DEFAULT_TEMPLATES = (() => {
        const field = (key, prefix = "", suffix = "") => ({ type: "field", key, prefix, suffix });
        const separator = (value) => ({ type: "separator", value });
        const text = (value) => ({ type: "text", value });
        const specFields = ["videoFormat", "mediaSource", "resourceType", "effect", "highQuality", "dolbyVision", "dynamicRange", "frameRate", "colorDepth", "originalEdition", "videoCodec", "audioCodec"];
        const dottedFields = (keys) => keys.flatMap((key, idx) => idx === 0 ? [field(key)] : [separator("."), field(key)]);
        const spacedFields = (keys) => keys.flatMap((key, idx) => idx === 0 ? [field(key)] : [separator(" "), field(key)]);
        return {
            movie: [...dottedFields(["title", "year", ...specFields]), separator("-"), field("releaseGroup")],
            tv: [...dottedFields(["title", "year", "seasonEpisode", "episodeTitle", ...specFields]), separator("-"), field("releaseGroup")],
            mediaFolder: [field("chineseTitle"), separator(" "), field("year", "(", ")"), separator(" "), field("tmdbId", "{tmdb-", "}")],
            seasonFolder: [text("Season "), field("season")],
            inPlaceSeasonFolder: [text("Season "), field("season")],
            specSeasonFolder: [text("Season "), ...spacedFields(["season", "videoFormat", "highQuality", "dolbyVision", "mediaSource", "resourceType", "effect", "dynamicRange", "frameRate", "colorDepth", "originalEdition", "videoCodec", "audioCodec"])]
        };
    })();

    static renderTemplate(blocks, values, options = {}) {
        const rendered = (blocks || []).map((block) => {
            if (block.type === "field") {
                const val = String(values?.[block.key] ?? "").trim();
                return { type: "content", text: val ? `${block.prefix || ""}${val}${block.suffix || ""}` : "" };
            }
            if (block.type === "text") return { type: "content", text: String(block.value || "") };
            return { type: "separator", text: String(block.value || "") };
        });

        const output = [];
        let previousContent = -1;
        for (let index = 0; index < rendered.length; index += 1) {
            const item = rendered[index];
            if (item.type !== "content" || !item.text) continue;
            if (previousContent >= 0) {
                const sep = rendered.slice(previousContent + 1, index).filter((candidate) => candidate.type === "separator" && candidate.text).at(-1);
                if (sep) output.push(sep);
            }
            output.push(item);
            previousContent = index;
        }
        const value = output.map((item) => item.text).join("");
        return options.path ? this.cleanName(value) : value.trim();
    }

    static formatTemplateValues(fields, blocks = []) {
        const sanitizeSpec = (v) => String(v || '').trim().replace(/\s+/g, '.');

        const represented = new Set(
            [fields.highQuality, fields.dolbyVision, fields.dynamicRange]
                .map(v => String(v || '').replace(/[\s._-]+/g, '').toUpperCase())
                .filter(Boolean)
        );
        const effectVal = String(fields.effect || '').split(/[\s/]+/).filter(token => {
            const key = token.replace(/[\s._-]+/g, '').toUpperCase();
            if (represented.has(key)) return false;
            if (key === 'HDR' && ['HDR10', 'HDR10+', 'HDRVIVID'].some(k => represented.has(k))) return false;
            return !(key === 'HDR10' && represented.has('HDR10+'));
        }).join('.');

        let cleanEpTitle = '';
        if (fields.episodeTitle) {
            cleanEpTitle = this.cleanName(String(fields.episodeTitle))
                .replace(/[:：]/g, '：')
                .replace(/[/／]/g, '／')
                .replace(/[\\＼]/g, '＼')
                .replace(/[?？]/g, '？')
                .replace(/[|｜]/g, '｜')
                .replace(/^[._\- ]+|[._\- ]+$/g, '');
        }

        let cleanRType = (fields.resourceType && fields.resourceType !== '原盘') ? sanitizeSpec(fields.resourceType) : '';
        let cleanOEdition = sanitizeSpec(fields.originalEdition);
        let cleanMSource = (fields.mediaSource && fields.mediaSource !== '原盘') ? sanitizeSpec(fields.mediaSource) : '';

        // ★ 当 resourceType 与 mediaSource 重合时（如均为 WEB-DL、WEBRip 或 BluRay），抑制 resourceType 防止双重输出
        if (cleanRType && cleanMSource) {
            const normR = cleanRType.replace(/[\s._-]+/g, '').toUpperCase();
            const normM = cleanMSource.replace(/[\s._-]+/g, '').toUpperCase();
            if (normR === normM || normM.includes(normR)) {
                cleanRType = '';
            }
        }

        if (cleanRType && cleanOEdition) {
            const normR = cleanRType.replace(/[\s._-]+/g, '').toUpperCase();
            const normO = cleanOEdition.replace(/[\s._-]+/g, '').toUpperCase();
            if (normR === normO || normO.includes(normR)) {
                cleanRType = '';
            }
        }

        const seasonNum = fields.season ? parseInt(String(fields.season), 10) : 1;
        const seasonStr = String(isNaN(seasonNum) ? 1 : seasonNum).padStart(2, '0');
        const epNum = fields.episode ? parseInt(String(fields.episode), 10) : 1;
        const epStr = String(isNaN(epNum) ? 1 : epNum).padStart(2, '0');

        return {
            ...fields,
            chineseTitle: fields.chineseTitle || fields.title,
            title: fields.title,
            season: seasonStr,
            seasonEpisode: fields.seasonEpisode || `S${seasonStr}E${epStr}`,
            episodeTitle: cleanEpTitle ? cleanEpTitle.replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')') : '',
            videoFormat: sanitizeSpec(fields.videoFormat) === '4K' ? '2160p' : sanitizeSpec(fields.videoFormat),
            mediaSource: (fields.mediaSource && fields.mediaSource !== '原盘') ? sanitizeSpec(fields.mediaSource) : '',
            resourceType: cleanRType,
            effect: effectVal,
            highQuality: sanitizeSpec(fields.highQuality),
            dolbyVision: sanitizeSpec(fields.dolbyVision),
            videoCodec: sanitizeSpec(fields.videoCodec),
            dynamicRange: sanitizeSpec(fields.dynamicRange),
            frameRate: sanitizeSpec(fields.frameRate),
            colorDepth: sanitizeSpec(fields.colorDepth),
            originalEdition: cleanOEdition,
            audioCodec: sanitizeSpec(fields.audioCodec),
            releaseGroup: sanitizeSpec(fields.releaseGroup)
        };
    }

    static buildSeasonFolder(fields, template = null) {
        if (fields.mediaType !== 'tv') return '';
        const tpl = template || this.DEFAULT_TEMPLATES.seasonFolder;
        const values = this.formatTemplateValues(fields, tpl);
        return this.cleanRenderedName(this.renderTemplate(tpl, values, { path: true }));
    }

    static normalizeResolution(width, height, scanType = '') {
        const w = Number(width || 0);
        const h = Number(height || 0);
        if (!w && !h) return '';
        if (w >= 3800 || h >= 2100) return '2160p';
        if (w >= 1900 || h >= 1000) return scanType === 'i' ? '1080i' : '1080p';
        if (w >= 1200 || h >= 700) return '720p';
        if (w >= 700 || h >= 460) return scanType === 'i' ? '480i' : '480p';
        if (w >= 500 || h >= 340) return '360p';
        return '';
    }

    static buildStandardTargetName(fields, ext = '', inPlace = false, seasonFolderOverride = null) {
        const effFields = fields?.rawSpecs ? { ...fields.rawSpecs, ...fields } : { ...fields };
        const effExt = (ext || effFields.ext || '').trim();
        const isTv = effFields.mediaType === 'tv';
        const blocks = isTv ? this.DEFAULT_TEMPLATES.tv : this.DEFAULT_TEMPLATES.movie;
        const values = this.formatTemplateValues(effFields, blocks);

        const filename = this.cleanRenderedName(this.renderTemplate(blocks, values, { path: true }), effExt.startsWith('.') ? effExt : (effExt ? '.' + effExt : ''));

        const folderName = effFields.mediaFolderOverride
            ? this.cleanName(effFields.mediaFolderOverride)
            : this.cleanRenderedName(this.renderTemplate(this.DEFAULT_TEMPLATES.mediaFolder, values, { path: true }));

        let seasonFolder = '';
        if (isTv) {
            if (seasonFolderOverride !== null && seasonFolderOverride !== undefined) {
                seasonFolder = seasonFolderOverride;
            } else {
                const sTemplate = inPlace ? this.DEFAULT_TEMPLATES.inPlaceSeasonFolder : this.DEFAULT_TEMPLATES.seasonFolder;
                seasonFolder = this.cleanRenderedName(this.renderTemplate(sTemplate, values, { path: true }));
            }
        }

        return {
            filename,
            folderName,
            seasonFolder,
            fullRelativePath: (isTv && seasonFolder ? `${folderName}/${seasonFolder}/${filename}` : `${folderName}/${filename}`).replace(/\/+/g, '/')
        };
    }

    static inferSecondaryCategory(mediaTypeOrTmdbData, tmdbDataOrMediaType = {}, options = {}) {
        let mediaType = 'tv';
        let tmdbData = {};
        if (typeof mediaTypeOrTmdbData === 'string') {
            mediaType = mediaTypeOrTmdbData;
            tmdbData = tmdbDataOrMediaType || {};
        } else if (typeof tmdbDataOrMediaType === 'string') {
            mediaType = tmdbDataOrMediaType;
            tmdbData = mediaTypeOrTmdbData || {};
        } else {
            tmdbData = mediaTypeOrTmdbData || {};
            mediaType = tmdbData.media_type || (tmdbData.title ? 'movie' : 'tv');
        }

        const effOpt = options || {};
        const classifyChildren = Boolean(effOpt.classifyChildren);
        const classifyConcerts = Boolean(effOpt.classifyConcerts !== undefined ? effOpt.classifyConcerts : true);
        const classifyRegion = Boolean(effOpt.classifyRegion !== undefined ? effOpt.classifyRegion : true);

        const isMovie = mediaType === 'movie';
        const rawGenres = (Array.isArray(tmdbData.genre_ids) && tmdbData.genre_ids.length > 0)
            ? tmdbData.genre_ids
            : ((Array.isArray(tmdbData.genreIds) && tmdbData.genreIds.length > 0)
                ? tmdbData.genreIds
                : (Array.isArray(tmdbData.genres) ? tmdbData.genres : []));
        const genres = Array.isArray(rawGenres) ? rawGenres.map(g => (typeof g === 'object' ? g?.id : g)).filter(Boolean) : [];
        const gIds = genres.map(Number);
        const origLang = String(tmdbData.original_language || tmdbData.originalLanguage || '').toLowerCase().trim();
        const rawCountries = (Array.isArray(tmdbData.origin_country) && tmdbData.origin_country.length > 0)
            ? tmdbData.origin_country
            : ((Array.isArray(tmdbData.originCountry) && tmdbData.originCountry.length > 0)
                ? tmdbData.originCountry
                : ((Array.isArray(tmdbData.production_countries) && tmdbData.production_countries.length > 0)
                    ? tmdbData.production_countries
                    : (Array.isArray(tmdbData.countries) ? tmdbData.countries : [tmdbData.origin_country || tmdbData.originCountry || tmdbData.countries || tmdbData.production_countries || ''])));
        const countries = (Array.isArray(rawCountries) ? rawCountries.map(c => typeof c === 'object' ? (c.iso_3166_1 || c.name) : c) : [rawCountries]).map(c => String(c || '').toUpperCase().trim()).filter(Boolean);
        const hasChineseTitle = /[\u4e00-\u9fa5]/.test(String(tmdbData.title || tmdbData.name || ''));

        const isAnime = gIds.includes(16) || 
            tmdbData.category === '动漫' || 
            tmdbData.isAnime === true ||
            (Array.isArray(tmdbData.genres) && tmdbData.genres.some(g => typeof g === 'object' ? /动画|Animation/i.test(g?.name || '') : /动画|Animation/i.test(String(g))));

        if (classifyConcerts && gIds.includes(10402)) {
            return '演唱会';
        }

        if (gIds.includes(99) || tmdbData.category === '纪录片' || /(?:纪录片|紀錄片|Documentary)/i.test(String(tmdbData.title || '') + ' ' + String(tmdbData.name || ''))) {
            return '纪录片';
        }

        if (classifyChildren && (gIds.includes(10762) || /(?:儿童|少儿|Kids)/i.test(String(tmdbData.title || '') + ' ' + String(tmdbData.name || '')))) {
            return '儿童';
        }

        if (!classifyRegion) {
            if (isMovie) {
                if (isAnime) return '动画电影';
                return '电影';
            } else {
                if (isAnime) return '动漫';
                if (gIds.includes(10764) || gIds.includes(10767)) return '综艺';
                return '剧集';
            }
        }

        if (isMovie) {
            if (isAnime) return '动画电影';
            if (['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || (!origLang && !countries.length && hasChineseTitle)) {
                return '华语电影';
            }
            const westernCountries = ['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL', 'PT', 'RU', 'UK', 'CA', 'AU', 'IE', 'SE', 'NO', 'DK', 'FI', 'PL', 'BE', 'AT', 'CH'];
            const westernLangs = ['en', 'fr', 'de', 'es', 'it', 'ru', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl'];
            if (countries.some(c => westernCountries.includes(c)) || westernLangs.includes(origLang)) {
                return '欧美电影';
            }
            if (countries.some(c => ['JP', 'KP', 'KR', 'TH', 'IN', 'SG'].includes(c)) || ['ja', 'ko', 'th'].includes(origLang)) {
                return '日韩电影';
            }
            return '外语电影';
        } else {
            if (isAnime) {
                if (countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || ['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || (!origLang && !countries.length && hasChineseTitle)) return '国漫';
                if (countries.some(c => ['JP'].includes(c)) || origLang === 'ja') return '日番';
                return '动漫';
            }
            if (gIds.includes(10764) || gIds.includes(10767)) return '综艺';
            if (['zh', 'cn', 'bo', 'za', 'cmn', 'yue'].includes(origLang) || countries.some(c => ['CN', 'TW', 'HK'].includes(c)) || (!origLang && !countries.length && hasChineseTitle)) {
                return '国产剧';
            }
            const westernCountries = ['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL', 'PT', 'RU', 'UK', 'CA', 'AU', 'IE', 'SE', 'NO', 'DK', 'FI', 'PL', 'BE', 'AT', 'CH'];
            const westernLangs = ['en', 'fr', 'de', 'es', 'it', 'ru', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl'];
            if (countries.some(c => westernCountries.includes(c)) || westernLangs.includes(origLang)) {
                return '欧美剧';
            }
            if (countries.some(c => ['JP', 'KP', 'KR', 'TH', 'IN', 'SG'].includes(c)) || ['ja', 'ko', 'th'].includes(origLang)) {
                return '日韩剧';
            }
            return '未分类';
        }
    }
}

module.exports = { RecognitionEngine };

const path = require('path');
const { logTaskEvent } = require('../utils/logUtils');

class TaskNamingService {
    parseMediaFileName(filename) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        const vars = {
            fileExt: ext.toLowerCase(),
            title: '',
            year: '',
            season: '',
            episode: '',
            season_episode: '',
            part: '',
            videoFormat: '',
            videoSource: '',
            videoCodec: '',
            audioCodec: '',
        };

        const resMap = {
            '4k': '4K',
            'uhd': '4K',
            '2160p': '2160p',
            '1440p': '1440p',
            '1080p': '1080p',
            '720p': '720p',
            '480p': '480p',
            '1080i': '1080i',
            '576p': '576p',
        };
        const resMatch = base.match(/\b(4k|uhd|2160p|1440p|1080p|720p|480p|1080i|576p)\b/i);
        if (resMatch) vars.videoFormat = resMap[resMatch[1].toLowerCase()] || resMatch[1];

        const srcMatch = base.match(/\b(WEB-DL|WEBRip|BluRay|Blu-Ray|BDRemux|BDRip|BRRip|HDTV|DVDRip|DVD|AMZN|NF|HULU|DSNP|ATVP|iT|REMUX)\b/i);
        if (srcMatch) vars.videoSource = srcMatch[1];

        const vcMatch = base.match(/\b(x264|x265|H\.?264|H\.?265|HEVC|AVC|XviD|MPEG-?2|VP9|AV1)\b/i);
        if (vcMatch) vars.videoCodec = vcMatch[1];

        const acMatch = base.match(/\b(DTS-HD|DTS|TrueHD|Atmos|E-?AC-?3|EAC3|AC-?3|AAC|FLAC|DD5\.1|DD7\.1|DDP5\.1|MP3|LPCM)\b/i);
        if (acMatch) vars.audioCodec = acMatch[1];

        const partMatch = base.match(/\bPart\.?\s*(\d+|[IVX]+)\b/i);
        if (partMatch) vars.part = `Part${partMatch[1]}`;

        const seMatch = base.match(/[._\s-]*[Ss](\d{1,3})[._\s-]?[Ee](\d{1,3})/);
        if (seMatch) {
            vars.season = String(parseInt(seMatch[1]));
            vars.episode = String(parseInt(seMatch[2]));
            vars.season_episode = `S${seMatch[1].padStart(2, '0')}E${seMatch[2].padStart(2, '0')}`;
        } else {
            const epMatch = base.match(/\b[Ee][Pp]?(\d{2,3})\b/);
            if (epMatch) {
                vars.season = '1';
                vars.episode = String(parseInt(epMatch[1]));
                vars.season_episode = `S01E${epMatch[1].padStart(2, '0')}`;
            }
        }

        const yearMatch = base.match(/\b((?:19|20)\d{2})\b/);
        if (yearMatch) vars.year = yearMatch[1];

        const titleEndPatterns = [
            /[._\s-]+[Ss]\d{1,3}[._\s-]?[Ee]\d{1,3}/,
            /[._\s-]+[Ee][Pp]?\d{2,3}\b/,
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
        let title = base.substring(0, titleEnd);
        title = title.replace(/[._]/g, ' ').replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
        vars.title = title || path.basename(filename, ext);
        return vars;
    }

    renderJinjaTemplate(template, vars) {
        const nunjucks = require('nunjucks');
        const env = new nunjucks.Environment(null, { autoescape: false });
        try {
            return env.renderString(template, vars);
        } catch (error) {
            logTaskEvent(`Jinja2 模板渲染失败: ${error.message}`);
            return null;
        }
    }

    sanitizeFileName(fileName) {
        return fileName.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    }

    generateFileName(file, aiFile, resourceInfo, template) {
        if (!aiFile) return file.name;
        const replaceMap = {
            '{name}': aiFile.name || resourceInfo.name,
            '{year}': resourceInfo.year || '',
            '{s}': aiFile.season?.padStart(2, '0') || '01',
            '{e}': aiFile.episode?.padStart(2, '0') || '01',
            '{sn}': parseInt(aiFile.season) || '1',
            '{en}': parseInt(aiFile.episode) || '1',
            '{ext}': aiFile.extension || path.extname(file.name),
            '{se}': `S${aiFile.season?.padStart(2, '0') || '01'}E${aiFile.episode?.padStart(2, '0') || '01'}`,
        };
        let newName = template;
        for (const [key, value] of Object.entries(replaceMap)) {
            const replacement = value == null ? '' : String(value);
            if (typeof newName.replaceAll === 'function') {
                newName = newName.replaceAll(key, replacement);
            } else {
                newName = newName.split(key).join(replacement);
            }
        }
        return this.sanitizeFileName(newName);
    }
}

module.exports = { TaskNamingService };

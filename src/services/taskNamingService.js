const path = require('path');
const { logTaskEvent } = require('../utils/logUtils');

const { RecognitionEngine } = require('./RecognitionEngine');

class TaskNamingService {
    parseMediaFileName(filename) {
        const parsed = RecognitionEngine.parseMediaFilename(filename);
        const ext = parsed.extension || path.extname(filename).toLowerCase();

        return {
            fileExt: ext,
            title: parsed.title,
            year: parsed.year,
            season: parsed.season,
            episode: parsed.episode,
            season_episode: parsed.season_episode,
            part: parsed.part || '',
            videoFormat: parsed.videoFormat || '',
            videoSource: parsed.mediaSource || '',
            videoCodec: parsed.videoCodec || '',
            audioCodec: parsed.audioCodec || '',
            releaseGroup: parsed.releaseGroup || '',
            dynamicRange: parsed.dynamicRange || '',
            airDate: parsed.airDate || '',
            date: parsed.airDate || '',
            isImax: Boolean(parsed.isImax),
            _seasonInferred: Boolean(parsed._seasonInferred),
        };
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
        return RecognitionEngine.cleanName(fileName, { stripIllegal: true });
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
            '{airDate}': aiFile.airDate || '',
            '{date}': aiFile.airDate || '',
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

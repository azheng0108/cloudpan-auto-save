const { TaskNamingService } = require('../src/services/taskNamingService');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function run() {
    const service = new TaskNamingService();

    const parsed = service.parseMediaFileName('The.Show.S01E02.1080p.WEB-DL.x265.AAC.mkv');
    assert(parsed.title === 'The Show', '标题解析失败');
    assert(parsed.season_episode === 'S01E02', '剧集解析失败');
    assert(parsed.videoFormat === '1080p', '分辨率解析失败');
    assert(parsed.videoSource === 'WEB-DL', '来源解析失败');

    const rendered = service.renderJinjaTemplate('{{ title }} - {{ season_episode }}{{ fileExt }}', parsed);
    assert(rendered === 'The Show - S01E02.mkv', '模板渲染失败');

    const generated = service.generateFileName(
        { name: 'old.mkv' },
        { name: '新剧', season: '1', episode: '3', extension: '.mkv' },
        { name: '新剧', year: '2024' },
        '{name} - {se}{ext}'
    );
    assert(generated === '新剧 - S01E03.mkv', '文件名生成失败');

    const sanitized = service.sanitizeFileName('A<>:"/\\|?*B   C.mkv');
    assert(sanitized === 'AB C.mkv', '文件名清理失败');

    console.log('✅ task naming service checks passed');
}

try {
    run();
} catch (error) {
    console.error(`❌ task naming service checks failed: ${error.message}`);
    process.exit(1);
}

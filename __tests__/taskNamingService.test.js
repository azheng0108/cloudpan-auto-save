jest.mock('../src/utils/logUtils', () => ({
  logTaskEvent: jest.fn(),
}));

const { TaskNamingService } = require('../src/services/taskNamingService');

describe('TaskNamingService', () => {
  const service = new TaskNamingService();

  test('parseMediaFileName 应提取剧集与媒体信息', () => {
    const parsed = service.parseMediaFileName('The.Show.S01E02.1080p.WEB-DL.x265.AAC.mkv');

    expect(parsed.title).toBe('The Show');
    expect(parsed.season_episode).toBe('S01E02');
    expect(parsed.videoFormat).toBe('1080p');
    expect(parsed.videoSource).toBe('WEB-DL');
    expect(parsed.videoCodec).toBe('x265');
    expect(parsed.audioCodec).toBe('AAC');
    expect(parsed.fileExt).toBe('.mkv');
  });

  test('renderJinjaTemplate 成功与失败分支', () => {
    const rendered = service.renderJinjaTemplate('{{ title }} - {{ season_episode }}{{ fileExt }}', {
      title: 'The Show',
      season_episode: 'S01E02',
      fileExt: '.mkv',
    });
    expect(rendered).toBe('The Show - S01E02.mkv');

    const bad = service.renderJinjaTemplate('{{ title ', { title: 'A' });
    expect(bad).toBeNull();
  });

  test('sanitizeFileName 与 generateFileName', () => {
    expect(service.sanitizeFileName('A<>:"/\\|?*B   C.mkv')).toBe('AB C.mkv');

    const generated = service.generateFileName(
      { name: 'old.mkv' },
      { name: '新剧', season: '1', episode: '3', extension: '.mkv' },
      { name: '新剧', year: '2024' },
      '{name} - {se}{ext}'
    );
    expect(generated).toBe('新剧 - S01E03.mkv');

    expect(service.generateFileName({ name: 'origin.mkv' }, null, {}, '{name}')).toBe('origin.mkv');
  });
});

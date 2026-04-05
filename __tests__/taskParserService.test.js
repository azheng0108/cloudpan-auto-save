const path = require('path');

jest.mock('../src/legacy189/utils/Cloud189Utils', () => ({
  parseCloudShare: jest.fn(),
  parseShareCode: jest.fn(),
}));

jest.mock('../src/utils/Cloud139Utils', () => ({
  extractFromShareText: jest.fn(),
  parseShareLink: jest.fn(),
}));

const cloud189Utils = require('../src/legacy189/utils/Cloud189Utils');
const Cloud139Utils = require('../src/utils/Cloud139Utils');
const { TaskParserService } = require('../src/services/taskParserService');

describe('TaskParserService', () => {
  const parser = new TaskParserService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('extractCloud139ShareText / parseCloud139ShareLink 代理方法', () => {
    Cloud139Utils.extractFromShareText.mockReturnValue({ url: 'u', passwd: 'p' });
    Cloud139Utils.parseShareLink.mockReturnValue({ linkID: 'id1', passwd: 'x' });

    expect(parser.extractCloud139ShareText('text')).toEqual({ url: 'u', passwd: 'p' });
    expect(parser.parseCloud139ShareLink('url')).toEqual({ linkID: 'id1', passwd: 'x' });
  });

  test('parseCloud189ShareInput 应输出标准字段', () => {
    cloud189Utils.parseCloudShare.mockReturnValue({ url: 'https://cloud.189.cn/t/AbCdEf12', accessCode: '1a2B' });
    cloud189Utils.parseShareCode.mockReturnValue('AbCdEf12');

    const parsed = parser.parseCloud189ShareInput('raw-input');
    expect(parsed).toEqual({
      normalizedUrl: 'https://cloud.189.cn/t/AbCdEf12',
      parsedAccessCode: '1a2B',
      shareCode: 'AbCdEf12',
    });
  });

  test('buildCloud139ShareFolders: 空结果应报错', async () => {
    Cloud139Utils.extractFromShareText.mockReturnValue(null);
    Cloud139Utils.parseShareLink.mockReturnValue({ linkID: 'abc' });

    const cloud139 = { listShareDir: jest.fn().mockResolvedValue(null) };
    await expect(parser.buildCloud139ShareFolders(cloud139, 'link', '')).rejects.toThrow('获取分享信息失败');
  });

  test('buildCloud139ShareFolders: 单子目录提升与普通目录', async () => {
    Cloud139Utils.extractFromShareText.mockReturnValue({ url: 'https://yun.139.com/x', passwd: 'P1' });
    Cloud139Utils.parseShareLink.mockReturnValue({ linkID: 'link-1' });

    const cloud139 = {
      listShareDir: jest
        .fn()
        .mockResolvedValueOnce({
          linkName: '资源A',
          fileList: [],
          folderList: [{ catalogID: 'c1', catalogName: 'Season1' }],
        })
        .mockResolvedValueOnce({
          fileList: [{ id: 'f1' }],
          folderList: [{ catalogID: 'c2', catalogName: 'Ep' }],
        }),
    };

    const folders = await parser.buildCloud139ShareFolders(cloud139, 'link', '');
    expect(folders[0]).toEqual({ id: -1, name: 'Season1', level: 0, hasRootFiles: true });
    expect(folders[1]).toEqual({ id: 'c2', name: path.join('Season1', 'Ep'), level: 1 });
  });

  test('buildCloud189ShareFolders: 非目录、私密链接和目录分支', async () => {
    cloud189Utils.parseCloudShare.mockReturnValue({ url: 'https://cloud.189.cn/t/AbCdEf12', accessCode: '' });
    cloud189Utils.parseShareCode.mockReturnValue('AbCdEf12');

    const cloud189 = {
      checkAccessCode: jest.fn().mockResolvedValue({ shareId: 'sid1' }),
      listShareDir: jest.fn().mockResolvedValue({
        fileListAO: { folderList: [{ id: 'f1', name: '子目录' }] },
      }),
    };

    const getShareInfoFile = jest.fn().mockResolvedValue({
      shareMode: 0,
      fileName: '资源B',
      isFolder: false,
      shareId: 'sid-file',
      fileId: 'root',
    });
    const onlyRoot = await parser.buildCloud189ShareFolders(cloud189, 'link', '', getShareInfoFile);
    expect(onlyRoot).toEqual([{ id: -1, name: '资源B' }]);

    const getShareInfoPrivate = jest.fn().mockResolvedValue({
      shareMode: 1,
      fileName: '资源C',
      isFolder: true,
      shareId: 'sid2',
      fileId: 'root',
    });

    await expect(parser.buildCloud189ShareFolders(cloud189, 'link', '', getShareInfoPrivate)).rejects.toThrow(
      '分享链接为私密链接, 请输入提取码'
    );

    cloud189.checkAccessCode.mockResolvedValueOnce({});
    await expect(parser.buildCloud189ShareFolders(cloud189, 'link', 'abcd', getShareInfoPrivate)).rejects.toThrow('访问码无效');

    cloud189.checkAccessCode.mockResolvedValueOnce({ shareId: 'sid-ok' });
    const withFolders = await parser.buildCloud189ShareFolders(cloud189, 'link', 'abcd', getShareInfoPrivate);
    expect(withFolders).toEqual([
      { id: -1, name: '资源C' },
      { id: 'f1', name: path.join('资源C', '子目录') },
    ]);
  });
});

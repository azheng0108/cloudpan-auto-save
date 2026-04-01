const { TaskParserService } = require('../src/services/taskParserService');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function run() {
    const parser = new TaskParserService();

    const extracted = parser.extractCloud139ShareText('链接: https://yun.139.com/w/r?linkID=abc123 提取码: XY12');
    assert(extracted && extracted.url.includes('linkID=abc123'), '139 分享文本提取失败');

    const parsed139 = parser.parseCloud139ShareLink('https://yun.139.com/w/r?linkID=zy0DDGAkum96&passwd=XD7G');
    assert(parsed139.linkID === 'zy0DDGAkum96', '139 linkID 解析失败');
    assert(parsed139.passwd === 'XD7G', '139 提取码解析失败');

    const parsed189 = parser.parseCloud189ShareInput('https://cloud.189.cn/t/AbCdEf12（访问码：1a2B）');
    assert(parsed189.normalizedUrl.includes('/t/AbCdEf12'), '189 URL 标准化失败');
    assert(parsed189.parsedAccessCode === '1a2B', '189 访问码解析失败');
    assert(parsed189.shareCode === 'AbCdEf12', '189 分享码解析失败');

    const mockCloud139 = {
        async listShareDir(linkID, passwd, folderId) {
            if (!folderId || folderId === 'root') {
                return {
                    linkName: '资源A',
                    fileList: [],
                    folderList: [{ catalogID: 'c1', catalogName: 'Season1' }],
                };
            }
            return {
                fileList: [{ contentID: 'f1' }],
                folderList: [{ catalogID: 'c2', catalogName: 'Ep' }],
            };
        },
    };
    const folders139 = await parser.buildCloud139ShareFolders(
        mockCloud139,
        'https://yun.139.com/w/r?linkID=zy0DDGAkum96',
        ''
    );
    assert(folders139.length >= 1, '139 目录构建失败');

    const mockCloud189 = {
        async checkAccessCode() {
            return { shareId: 'sid1' };
        },
        async listShareDir() {
            return { fileListAO: { folderList: [{ id: 'f1', name: '子目录' }] } };
        },
    };
    const folders189 = await parser.buildCloud189ShareFolders(
        mockCloud189,
        'https://cloud.189.cn/t/AbCdEf12',
        '',
        async () => ({ shareMode: 0, fileName: '资源B', isFolder: true, shareId: 'sid1', fileId: 'root' })
    );
    assert(folders189.length === 2, '189 目录构建失败');

    console.log('✅ task parser service checks passed');
}

run().catch((error) => {
    console.error(`❌ task parser service checks failed: ${error.message}`);
    process.exit(1);
});

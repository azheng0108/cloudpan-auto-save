/**
 * Phase E: cloud139TaskProcessor 集成检查（root-files 与分组路径）
 */

const { processCloud139Task } = require('../src/services/cloud139TaskProcessor');
const { Cloud139Service } = require('../src/services/cloud139');
const ConfigService = require('../src/services/ConfigService');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function makeTaskService() {
    const saves = [];
    const records = [];

    return {
        saves,
        records,
        transferredFileRepo: {
            find: async () => [],
        },
        taskRepo: {
            save: async (task) => {
                saves.push({ ...task });
                return task;
            },
        },
        eventService: {
            emit: () => {},
        },
        _handleMatchMode: () => true,
        _autoCreateFolder139: async () => {},
        _recordTransferredFiles: async (taskId, list) => {
            records.push({ taskId, list });
        },
        _getCatalogPathSegments: (caID, rootCaID, catalogMap) => {
            const root = String(rootCaID);
            const segments = [];
            let current = String(caID);
            while (current !== root && current !== 'root') {
                const entry = catalogMap[current];
                if (!entry) break;
                segments.unshift(entry.name);
                current = String(entry.parentCaID);
            }
            return segments;
        },
        _ensureCloud139FolderPath: async (_cloud139, _baseId, segments) => {
            return segments.join('/') || 'ROOT';
        },
        _handleTaskFailure: async () => 'FAILED',
    };
}

async function testRootFilesPath() {
    const originalGetInstance = Cloud139Service.getInstance;
    const originalGetConfig = ConfigService.getConfigValue;

    const calls = {
        saveWithRetry: [],
        visibleCheck: [],
    };

    const cloud139Stub = {
        listShareDir: async (_linkID, _passwd, dir) => {
            if (dir === 'root') {
                return {
                    folderList: [],
                    fileList: [
                        { coID: '1', coName: 'EP01.mkv', path: 'p/1' },
                        { coID: '2', coName: 'EP02.mkv', path: 'p/2' },
                    ],
                };
            }
            return { folderList: [], fileList: [] };
        },
        listDiskDir: async () => ({ ok: true }),
        listAllDiskFiles: async () => [],
        saveShareFilesWithRetry: async (...args) => {
            calls.saveWithRetry.push(args);
            return { taskID: 'ok' };
        },
        waitForFilesVisible: async (...args) => {
            calls.visibleCheck.push(args);
            return { allVisible: true, visibleCount: 2, missing: [] };
        },
    };

    Cloud139Service.getInstance = () => cloud139Stub;
    ConfigService.getConfigValue = (key) => {
        if (key === 'task.mediaSuffix') return '.mkv;.mp4';
        if (key === 'task.enableOnlySaveMedia') return false;
        if (key === 'task.enableAutoCreateFolder') return false;
        if (key === 'task.taskExpireDays') return 3;
        return null;
    };

    const taskService = makeTaskService();
    const task = {
        id: 10,
        shareId: 'lk',
        accessCode: '',
        shareFolderId: 'root-files',
        realFolderId: 'TARGET',
        resourceName: '资源A',
        currentEpisodes: 0,
    };

    try {
        const result = await processCloud139Task(taskService, task, { username: 'u1' });
        assert(result.includes('新增2个'), 'root-files 路径应返回新增信息');
        assert(calls.saveWithRetry.length === 1, 'root-files 应触发一次重试转存');
        assert(calls.visibleCheck.length === 1, 'root-files 应触发一次可见性轮询');
        assert(taskService.records.length === 1, 'root-files 应记录转存文件');
    } finally {
        Cloud139Service.getInstance = originalGetInstance;
        ConfigService.getConfigValue = originalGetConfig;
    }
}

async function testGroupedPath() {
    const originalGetInstance = Cloud139Service.getInstance;
    const originalGetConfig = ConfigService.getConfigValue;

    const calls = {
        saveWithRetry: [],
        visibleCheck: [],
    };

    const cloud139Stub = {
        listShareDir: async () => ({ folderList: [], fileList: [] }),
        listAllShareFilesWithFolderMap: async () => ({
            files: [
                { coID: '101', coName: 'S01E01.mkv', path: 'g/101', pCaID: 'caA' },
                { coID: '102', coName: 'S01E02.mkv', path: 'g/102', pCaID: 'caA' },
                { coID: '201', coName: 'S02E01.mkv', path: 'g/201', pCaID: 'caB' },
            ],
            catalogMap: {
                caA: { name: 'Season1', parentCaID: 'root' },
                caB: { name: 'Season2', parentCaID: 'root' },
            },
        }),
        listDiskDir: async () => ({ ok: true }),
        listAllDiskFiles: async () => [],
        saveShareFilesWithRetry: async (...args) => {
            calls.saveWithRetry.push(args);
            return { taskID: 'ok' };
        },
        waitForFilesVisible: async (...args) => {
            calls.visibleCheck.push(args);
            return { allVisible: true, visibleCount: 1, missing: [] };
        },
    };

    Cloud139Service.getInstance = () => cloud139Stub;
    ConfigService.getConfigValue = (key) => {
        if (key === 'task.mediaSuffix') return '.mkv;.mp4';
        if (key === 'task.enableOnlySaveMedia') return false;
        if (key === 'task.enableAutoCreateFolder') return false;
        if (key === 'task.taskExpireDays') return 3;
        return null;
    };

    const taskService = makeTaskService();
    const task = {
        id: 20,
        shareId: 'lk',
        accessCode: '',
        shareFolderId: 'root',
        shareFolderName: '',
        realFolderId: 'ROOT',
        resourceName: '资源B',
        currentEpisodes: 0,
    };

    try {
        const result = await processCloud139Task(taskService, task, { username: 'u2' });
        assert(result.includes('追更3集'), '分组路径应返回追更汇总');
        assert(calls.saveWithRetry.length === 2, '应按分组触发两次转存重试');
        assert(calls.visibleCheck.length === 2, '应按分组触发两次可见性轮询');
        assert(taskService.records.length === 1, '应统一记录一次转存列表');
    } finally {
        Cloud139Service.getInstance = originalGetInstance;
        ConfigService.getConfigValue = originalGetConfig;
    }
}

async function run() {
    await testRootFilesPath();
    await testGroupedPath();

    console.log('✅ cloud139 task processor checks passed');
}

run().catch((error) => {
    console.error(`❌ cloud139 task processor checks failed: ${error.message}`);
    process.exit(1);
});

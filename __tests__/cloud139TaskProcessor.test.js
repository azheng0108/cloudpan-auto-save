const CheckpointManager = require('../src/services/checkpointManager');

jest.mock('../src/services/cloud139', () => ({
    Cloud139Service: {
        getInstance: jest.fn(),
    },
}));

jest.mock('../src/utils/logUtils', () => ({
    logTaskEvent: jest.fn(),
}));

const { Cloud139Service } = require('../src/services/cloud139');
const ConfigService = require('../src/services/ConfigService');
const { processCloud139Task } = require('../src/services/cloud139TaskProcessor');

describe('cloud139TaskProcessor regression', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        jest.spyOn(ConfigService, 'getConfigValue').mockImplementation((key) => {
            if (key === 'task.mediaSuffix') return '.mp4;.mkv';
            if (key === 'task.enableOnlySaveMedia') return false;
            if (key === 'task.enableAutoCreateFolder') return false;
            if (key === 'task.taskExpireDays') return 30;
            return null;
        });
    });

    test('catalogMap 为普通对象时不应触发 object is not iterable', async () => {
        const cloud139 = {
            listShareDir: jest.fn().mockResolvedValue({ folderList: [], fileList: [] }),
            listAllShareFilesWithFolderMap: jest.fn().mockResolvedValue({
                files: [
                    {
                        coID: 'f-1',
                        coName: 'EP01.mp4',
                        path: 'root/f-1',
                        pCaID: 'sub-1',
                    },
                ],
                catalogMap: {
                    'sub-1': { name: 'Season 1', parentCaID: 'root' },
                },
            }),
            listDiskDir: jest.fn().mockResolvedValue({ ok: true }),
            listAllDiskFiles: jest.fn().mockResolvedValue([]),
            saveShareFilesWithRetry: jest.fn().mockResolvedValue({ taskID: 'save-1' }),
            waitForFilesVisible: jest.fn().mockResolvedValue({ allVisible: true, missing: [] }),
        };
        Cloud139Service.getInstance.mockReturnValue(cloud139);

        const task = {
            id: 2,
            shareId: 'link-1',
            shareFolderId: 'root',
            shareFolderName: '',
            accessCode: '',
            realFolderId: 'target-root',
            resourceName: '牧神记（2024）',
            currentEpisodes: 0,
            status: 'pending',
            lastFileUpdateTime: null,
            retryCount: 0,
        };

        const taskService = {
            _handleMatchMode: jest.fn().mockReturnValue(true),
            _getCatalogPathSegments: jest.fn().mockReturnValue(['Season 1']),
            _ensureCloud139FolderPath: jest.fn().mockResolvedValue('physical-1'),
            _recordTransferredFiles: jest.fn().mockResolvedValue(undefined),
            taskRepo: {
                save: jest.fn().mockResolvedValue(undefined),
            },
            transferredFileRepo: null,
            eventService: {
                emit: jest.fn(),
            },
            taskErrorService: null,
            taskRetryService: {
                handleTaskFailure: jest.fn().mockResolvedValue(''),
            },
        };

        const createCheckpointSpy = jest.spyOn(CheckpointManager, 'createCheckpoint');

        const result = await processCloud139Task(taskService, task, { account: 'a1' });

        expect(createCheckpointSpy).toHaveBeenCalledTimes(1);
        expect(createCheckpointSpy.mock.calls[0][0].catalogMap).toEqual({
            'sub-1': { name: 'Season 1', parentCaID: 'root' },
        });
        expect(createCheckpointSpy.mock.calls[0][0].physicalFolderMap).toEqual({
            'sub-1': 'physical-1',
        });

        expect(result).toContain('追更1集');
        expect(taskService.taskRetryService.handleTaskFailure).not.toHaveBeenCalled();
    });
});

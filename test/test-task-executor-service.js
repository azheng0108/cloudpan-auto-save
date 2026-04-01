const { TaskExecutorService } = require('../src/services/taskExecutorService');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function run() {
    const taskService = {
        async getAllFolderFiles() {
            return [];
        },
    };
    const executor = new TaskExecutorService(taskService);

    const cloud189Success = {
        async createBatchTask() {
            return { res_code: 0, taskId: 't1' };
        },
        async checkTaskStatus() {
            return { taskId: 't1', taskStatus: 4, failedCount: 0 };
        },
    };

    await executor.createBatchTask(cloud189Success, { type: 'SHARE_SAVE', taskInfos: '[]', targetFolderId: 'f1' });

    const cloud189Fail = {
        async createBatchTask() {
            return { res_code: -1, res_msg: 'fail' };
        },
    };
    let failed = false;
    try {
        await executor.createBatchTask(cloud189Fail, { type: 'SHARE_SAVE', taskInfos: '[]', targetFolderId: 'f1' });
    } catch (error) {
        failed = true;
        assert(error.message === 'fail', '失败消息不正确');
    }
    assert(failed, '应当抛出批量任务失败');

    console.log('✅ task executor service checks passed');
}

run().catch((error) => {
    console.error(`❌ task executor service checks failed: ${error.message}`);
    process.exit(1);
});

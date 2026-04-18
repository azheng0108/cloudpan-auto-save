const { logTaskEvent } = require('../utils/logUtils');

class TaskRecycleService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        // 回收站清理功能仅天翼云盘189账号支持，当前系统已移除189支持
        logTaskEvent('回收站清理功能仅天翼云盘(189)账号支持，当前系统已移除189支持，跳过');
    }
}

module.exports = { TaskRecycleService };


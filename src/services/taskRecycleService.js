const { Cloud189Service } = require('../legacy189/services/cloud189');
const { BatchTaskDto } = require('../dto/BatchTaskDto');
const { logTaskEvent } = require('../utils/logUtils');

class TaskRecycleService {
    constructor(taskService) {
        this.taskService = taskService;
    }

    async clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const accounts = await this.taskService.accountRepo.find();
        if (accounts) {
            for (const account of accounts) {
                if (account.accountType === 'cloud139') continue;
                const username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                try {
                    const cloud189 = Cloud189Service.getInstance(account);
                    await this._clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle);
                } catch (error) {
                    logTaskEvent(`定时[${username}]清空回收站任务执行失败:${error.message}`);
                }
            }
        }
    }

    async _clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const params = {
            taskInfos: '[]',
            type: 'EMPTY_RECYCLE',
        };
        const batchTaskDto = new BatchTaskDto(params);
        if (enableAutoClearRecycle) {
            logTaskEvent(`开始清空[${username}]个人回收站`);
            await this.taskService.createBatchTask(cloud189, batchTaskDto);
            logTaskEvent(`清空[${username}]个人回收站完成`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        if (enableAutoClearFamilyRecycle) {
            const familyInfo = await cloud189.getFamilyInfo();
            if (familyInfo == null) {
                logTaskEvent(`用户${username}没有家庭主账号, 跳过`);
                return;
            }
            logTaskEvent(`开始清空[${username}]家庭回收站`);
            batchTaskDto.familyId = familyInfo.familyId;
            await this.taskService.createBatchTask(cloud189, batchTaskDto);
            logTaskEvent(`清空[${username}]家庭回收站完成`);
        }
    }
}

module.exports = { TaskRecycleService };


class TaskCompleteEventDto  {
    constructor(data) {
        this.cloud189 = data?.cloud189;
        this.task = data?.task;
        this.fileList = data?.fileList;
        this.overwriteStrm = data?.overwriteStrm;
        this.taskService = data?.taskService;
        this.taskRepo = data?.taskRepo;
        this.firstExecution = data?.firstExecution;
    }
}

module.exports = { TaskCompleteEventDto };
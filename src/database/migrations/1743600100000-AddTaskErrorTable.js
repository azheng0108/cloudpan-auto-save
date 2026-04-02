const { MigrationInterface, QueryRunner } = require('typeorm');

/**
 * P1-02: 创建 TaskError 表用于详细错误跟踪
 * 
 * 目标：
 * - 记录任务执行过程中的所有错误
 * - 支持错误分类（空间满、限流、权限、链接失效等）
 * - 提供错误趋势分析数据
 */
module.exports = class AddTaskErrorTable1743600100000 {
    name = 'AddTaskErrorTable1743600100000';

    async up(queryRunner) {
        // 创建 task_error 表
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "task_error" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "taskId" integer NOT NULL,
                "errorType" text NOT NULL,
                "errorCode" text,
                "errorMessage" text NOT NULL,
                "stackTrace" text,
                "retryable" boolean NOT NULL DEFAULT (1),
                "fatal" boolean NOT NULL DEFAULT (0),
                "httpStatus" integer,
                "apiCode" text,
                "context" text,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                CONSTRAINT "FK_task_error_task" FOREIGN KEY ("taskId") REFERENCES "task" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);

        // 创建索引：按任务 ID 查询错误历史
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_task_error_taskId" 
            ON "task_error" ("taskId")
        `);

        // 创建索引：按错误类型统计
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_task_error_errorType" 
            ON "task_error" ("errorType")
        `);

        // 创建索引：按创建时间（用于清理历史错误）
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_task_error_createdAt" 
            ON "task_error" ("createdAt")
        `);
    }

    async down(queryRunner) {
        // 回滚：删除索引和表
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_error_createdAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_error_errorType"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_error_taskId"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "task_error"`);
    }
};

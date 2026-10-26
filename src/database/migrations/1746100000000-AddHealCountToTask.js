/**
 * Migration: AddHealCountToTask
 * 为 task 表新增 healCount 字段（整数，默认 0，用于记录失效链接自动搜盘自愈次数）
 */
module.exports = class AddHealCountToTask1746100000000 {
    name = 'AddHealCountToTask1746100000000';

    async up(queryRunner) {
        const taskTable = await queryRunner.getTable('task');
        const hasColumn = taskTable?.columns?.some(c => c.name === 'healCount');
        if (!hasColumn) {
            await queryRunner.query(`ALTER TABLE "task" ADD COLUMN "healCount" integer DEFAULT 0`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN
    }
};

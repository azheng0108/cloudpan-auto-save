/**
 * Migration: AddDisableRename
 * 为 task 表新增 disableRename 字段（布尔值，null = 使用全局模板，true = 彻底禁用自动命名）
 */
module.exports = class AddDisableRename1745600000000 {
    name = 'AddDisableRename1745600000000';

    async up(queryRunner) {
        const taskTable = await queryRunner.getTable('task');
        const hasColumn = taskTable?.columns?.some(c => c.name === 'disableRename');
        if (!hasColumn) {
            await queryRunner.query(`ALTER TABLE "task" ADD COLUMN "disableRename" boolean DEFAULT (NULL)`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN
    }
};

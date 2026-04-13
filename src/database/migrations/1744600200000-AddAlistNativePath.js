/**
 * Migration: AddAlistNativePath
 * 为 account 表新增 alistNativePath 字段。
 * 该字段用于配置 OpenList 原生网盘挂载路径，触发单层 refresh=true 回源刷新。
 */
module.exports = class AddAlistNativePath1744600200000 {
    name = 'AddAlistNativePath1744600200000';

    async up(queryRunner) {
        // 检查列是否已存在，避免重复迁移报错。
        const table = await queryRunner.getTable('account');
        const hasColumn = table?.columns?.some(c => c.name === 'alistNativePath');
        if (!hasColumn) {
            await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "alistNativePath" text DEFAULT ('')`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN，此处仅作标记。
        // await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "alistNativePath"`);
    }
};

/**
 * Migration: AddAlistStrmPath
 * 为 account 表新增 alistStrmPath 字段。
 * 该字段用于配置 OpenList STRM 刷新根路径，与 cloudStrmPrefix（生成 .strm URL 用）解耦。
 * 例：/strm/移动云盘/159 或 /strm_159
 */
module.exports = class AddAlistStrmPath1743600200000 {
    name = 'AddAlistStrmPath1743600200000';

    async up(queryRunner) {
        // 检查列是否已存在，避免重复迁移报错
        const table = await queryRunner.getTable('account');
        const hasColumn = table?.columns?.some(c => c.name === 'alistStrmPath');
        if (!hasColumn) {
            await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "alistStrmPath" text DEFAULT ('')`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN，此处仅作标记
        // await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "alistStrmPath"`);
    }
};

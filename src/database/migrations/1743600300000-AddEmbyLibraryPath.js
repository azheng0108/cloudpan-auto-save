/**
 * Migration: AddEmbyLibraryPath
 * 为 account 表新增 embyLibraryPath 字段。
 * 该字段存储该账号内容在 Emby 容器内的挂载根路径，用于精准构造 Emby 搜索路径。
 * OpenList STRM 用户: 如 /media/移动云盘/130
 * 本地 STRM 用户: 如 /tv_strm
 */
module.exports = class AddEmbyLibraryPath1743600300000 {
    name = 'AddEmbyLibraryPath1743600300000';

    async up(queryRunner) {
        // 检查列是否已存在，避免重复迁移报错
        const table = await queryRunner.getTable('account');
        const hasColumn = table?.columns?.some(c => c.name === 'embyLibraryPath');
        if (!hasColumn) {
            await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "embyLibraryPath" text DEFAULT ('')`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN，此处仅作标记
        // await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "embyLibraryPath"`);
    }
};

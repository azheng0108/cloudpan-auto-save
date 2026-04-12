/**
 * Migration: AddRootFolderIdAndParentFileId
 * 1) 为 account 表新增 rootFolderId（OpenList 挂载根目录 ID）
 * 2) 为 task 表新增 parentFileId（任务目录参考父目录 ID）
 */
module.exports = class AddRootFolderIdAndParentFileId1744600000000 {
    name = 'AddRootFolderIdAndParentFileId1744600000000';

    async up(queryRunner) {
        const accountTable = await queryRunner.getTable('account');
        const hasRootFolderId = accountTable?.columns?.some(c => c.name === 'rootFolderId');
        if (!hasRootFolderId) {
            await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "rootFolderId" text DEFAULT ('')`);
        }

        const taskTable = await queryRunner.getTable('task');
        const hasParentFileId = taskTable?.columns?.some(c => c.name === 'parentFileId');
        if (!hasParentFileId) {
            await queryRunner.query(`ALTER TABLE "task" ADD COLUMN "parentFileId" text`);
        }
    }

    async down(queryRunner) {
        // SQLite 不支持 DROP COLUMN，此处仅作标记
        // await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "rootFolderId"`);
        // await queryRunner.query(`ALTER TABLE "task" DROP COLUMN "parentFileId"`);
    }
};

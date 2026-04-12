/**
 * Migration: BackfillTaskParentFileId
 * 为历史任务回填 parentFileId，避免运行时回退猜测导致路径裁剪误判。
 */
module.exports = class BackfillTaskParentFileId1744600100000 {
    name = 'BackfillTaskParentFileId1744600100000';

    async up(queryRunner) {
        const taskTable = await queryRunner.getTable('task');
        const hasParentFileId = taskTable?.columns?.some(c => c.name === 'parentFileId');
        const hasTargetFolderId = taskTable?.columns?.some(c => c.name === 'targetFolderId');

        if (!hasParentFileId || !hasTargetFolderId) {
            return;
        }

        await queryRunner.query(`
            UPDATE "task"
            SET "parentFileId" = "targetFolderId"
            WHERE ("parentFileId" IS NULL OR TRIM("parentFileId") = '')
              AND "targetFolderId" IS NOT NULL
              AND TRIM("targetFolderId") <> ''
        `);
    }

    async down(queryRunner) {
        // 数据回填迁移不做反向清理，避免误清空用户后续写入值。
    }
};

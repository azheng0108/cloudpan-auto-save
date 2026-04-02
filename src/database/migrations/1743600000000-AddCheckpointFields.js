const { MigrationInterface, QueryRunner } = require('typeorm');

/**
 * P1-01: 添加任务断点恢复字段
 * 
 * 新增字段：
 * - checkpointData (JSON): 存储恢复点数据（已处理的文件夹批次、文件列表等）
 * - processedBatches (integer): 已处理批次数
 * - totalBatches (integer): 总批次数
 */
module.exports = class AddCheckpointFields1743600000000 {
    name = 'AddCheckpointFields1743600000000';

    async up(queryRunner) {
        // 添加检查点数据字段（JSON格式，存储恢复所需的上下文）
        await queryRunner.query(`
            ALTER TABLE "task" ADD COLUMN "checkpointData" text DEFAULT NULL
        `);

        // 添加已处理批次数（用于前端进度展示）
        await queryRunner.query(`
            ALTER TABLE "task" ADD COLUMN "processedBatches" integer DEFAULT 0
        `);

        // 添加总批次数（用于计算进度百分比）
        await queryRunner.query(`
            ALTER TABLE "task" ADD COLUMN "totalBatches" integer DEFAULT 0
        `);

        // 添加最后检查点时间（用于监控恢复点更新频率）
        await queryRunner.query(`
            ALTER TABLE "task" ADD COLUMN "lastCheckpointTime" datetime DEFAULT NULL
        `);
    }

    async down(queryRunner) {
        // 回滚：删除新增字段
        await queryRunner.query(`
            ALTER TABLE "task" DROP COLUMN "lastCheckpointTime"
        `);
        await queryRunner.query(`
            ALTER TABLE "task" DROP COLUMN "totalBatches"
        `);
        await queryRunner.query(`
            ALTER TABLE "task" DROP COLUMN "processedBatches"
        `);
        await queryRunner.query(`
            ALTER TABLE "task" DROP COLUMN "checkpointData"
        `);
    }
};

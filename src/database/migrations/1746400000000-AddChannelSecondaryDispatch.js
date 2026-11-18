/**
 * Migration: AddChannelSecondaryDispatch
 * 频道集中控制与二次分流路由增强：
 * 1. 在 channel_monitors 表中追加 secondary_dispatch_rules 可选字段 (JSON 文本)
 * 2. 在 scrape_journals 表上追加状态与时间复合索引，提升归档大盘检索性能
 * 遵循严格幂等性 (IF NOT EXISTS + hasTable + findColumnByName)
 */
module.exports = class AddChannelSecondaryDispatch1746400000000 {
    name = 'AddChannelSecondaryDispatch1746400000000';

    async up(queryRunner) {
        // 1. 在 channel_monitors 中追加 secondary_dispatch_rules
        if (await queryRunner.hasTable('channel_monitors')) {
            const cmTable = await queryRunner.getTable('channel_monitors');
            if (!cmTable.findColumnByName('secondary_dispatch_rules')) {
                await queryRunner.query(`ALTER TABLE "channel_monitors" ADD COLUMN "secondary_dispatch_rules" text DEFAULT ('')`);
            }
        }

        // 2. 优化 scrape_journals 归档大盘分页索引
        if (await queryRunner.hasTable('scrape_journals')) {
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_journal_status_time" ON "scrape_journals" ("status", "created_at" DESC)`);
        }
    }

    async down(queryRunner) {
        // SQLite 降级说明：表结构安全保留，不执行 DROP COLUMN
    }
};

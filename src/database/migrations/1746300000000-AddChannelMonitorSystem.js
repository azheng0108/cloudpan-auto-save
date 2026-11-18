/**
 * Migration: AddChannelMonitorSystem
 * 频道监控首选体系：
 * 1. 新增 channel_monitors 表 (监控频道配置)
 * 2. 新增 channel_monitor_history 表 (推文抓取历史与防重表)
 * 3. 在 task 表中追加 sourceMode 可选字段
 * 遵循严格幂等性 (IF NOT EXISTS + hasTable + hasColumn)
 */
module.exports = class AddChannelMonitorSystem1746300000000 {
    name = 'AddChannelMonitorSystem1746300000000';

    async up(queryRunner) {
        // 1. channel_monitors 监控频道配置表
        if (!(await queryRunner.hasTable('channel_monitors'))) {
            await queryRunner.query(`
                CREATE TABLE "channel_monitors" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "name" text NOT NULL,
                    "channelUrl" text NOT NULL,
                    "accountId" integer NOT NULL,
                    "targetFolderId" text NOT NULL DEFAULT ('/'),
                    "targetFolderName" text,
                    "stagingFolderId" text DEFAULT (''),
                    "stagingFolderName" text DEFAULT (''),
                    "filterKeywords" text DEFAULT (''),
                    "excludeKeywords" text DEFAULT (''),
                    "autoOrganize" integer NOT NULL DEFAULT (1),
                    "autoWash" integer NOT NULL DEFAULT (1),
                    "status" text NOT NULL DEFAULT ('active'),
                    "cronExpression" text DEFAULT (''),
                    "lastMessageId" integer DEFAULT (0),
                    "lastCheckedAt" datetime,
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                    "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
                )
            `);
        } else {
            const cmTable = await queryRunner.getTable('channel_monitors');
            if (!cmTable.findColumnByName('stagingFolderId')) {
                await queryRunner.query(`ALTER TABLE "channel_monitors" ADD COLUMN "stagingFolderId" text DEFAULT ('')`);
            }
            if (!cmTable.findColumnByName('stagingFolderName')) {
                await queryRunner.query(`ALTER TABLE "channel_monitors" ADD COLUMN "stagingFolderName" text DEFAULT ('')`);
            }
            if (!cmTable.findColumnByName('cronExpression')) {
                await queryRunner.query(`ALTER TABLE "channel_monitors" ADD COLUMN "cronExpression" text DEFAULT ('')`);
            }
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_channel_monitors_status" ON "channel_monitors" ("status")`);

        // 2. channel_monitor_history 抓取与防重历史表
        if (!(await queryRunner.hasTable('channel_monitor_history'))) {
            await queryRunner.query(`
                CREATE TABLE "channel_monitor_history" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "channelId" integer NOT NULL,
                    "channelName" text,
                    "messageId" integer NOT NULL,
                    "postUrl" text,
                    "postTitle" text,
                    "rawText" text,
                    "shareLink" text,
                    "accessCode" text,
                    "status" text NOT NULL DEFAULT ('pending'),
                    "reason" text,
                    "transferredCount" integer NOT NULL DEFAULT (0),
                    "transferredDetails" text,
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
                )
            `);
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_channel_history_channel_msg" ON "channel_monitor_history" ("channelId", "messageId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_channel_history_status" ON "channel_monitor_history" ("status")`);

        // 3. 在 task 表中追加 sourceMode
        if (await queryRunner.hasTable('task')) {
            const table = await queryRunner.getTable('task');
            const hasSourceMode = table.findColumnByName('sourceMode');
            if (!hasSourceMode) {
                await queryRunner.query(`ALTER TABLE "task" ADD COLUMN "sourceMode" text DEFAULT ('manual')`);
            }
        }
    }

    async down(queryRunner) {
        // SQLite 降级说明：表结构安全保留，不执行 DROP TABLE
    }
};

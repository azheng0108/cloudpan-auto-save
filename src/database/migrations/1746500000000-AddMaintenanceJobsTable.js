/**
 * Migration: AddMaintenanceJobsTable
 * 云盘维护与巡检作业流水审计表：
 * 记录违规死链巡检、违规资产处置、空目录修剪等手动与定时作业的完整流水
 * 包含扫描指标、耗时及命中违规文件清单 JSON 快照
 */
module.exports = class AddMaintenanceJobsTable1746500000000 {
    name = 'AddMaintenanceJobsTable1746500000000';

    async up(queryRunner) {
        if (!await queryRunner.hasTable('maintenance_jobs')) {
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "maintenance_jobs" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "type" text NOT NULL,
                    "triggerType" text DEFAULT ('manual'),
                    "title" text NOT NULL,
                    "status" text DEFAULT ('running'),
                    "summary" text DEFAULT (''),
                    "durationMs" integer DEFAULT (0),
                    "folderPath" text DEFAULT (''),
                    "scannedFolders" integer DEFAULT (0),
                    "totalFiles" integer DEFAULT (0),
                    "bannedCount" integer DEFAULT (0),
                    "cleanedCount" integer DEFAULT (0),
                    "freedFormatted" text DEFAULT ('0 B'),
                    "findingsJson" text,
                    "cleanedDetailsJson" text,
                    "error" text,
                    "createdAt" datetime DEFAULT (datetime('now', '+8 hours'))
                )
            `);
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_jobs_status" ON "maintenance_jobs" ("status")`);
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_jobs_created_at" ON "maintenance_jobs" ("createdAt" DESC)`);
        }
    }

    async down(queryRunner) {
        // SQLite 降级策略：保留表结构，避免生产数据丢失
    }
};

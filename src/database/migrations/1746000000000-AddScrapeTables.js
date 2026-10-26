/**
 * Migration: AddScrapeTables
 * 影视刮削：新增 scrape_batch / scrape_record / scrape_binding 三张表。
 * 全部使用 IF NOT EXISTS，保证幂等。
 */
module.exports = class AddScrapeTables1746000000000 {
    name = 'AddScrapeTables1746000000000';

    async up(queryRunner) {
        if (!(await queryRunner.hasTable('scrape_batch'))) {
            await queryRunner.query(`
                CREATE TABLE "scrape_batch" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "driveType" text NOT NULL,
                    "accountId" integer NOT NULL DEFAULT (0),
                    "rootRef" text NOT NULL,
                    "rootPath" text,
                    "trigger" text NOT NULL DEFAULT ('manual'),
                    "organize" boolean NOT NULL DEFAULT (0),
                    "targetRootRef" text,
                    "targetRootPath" text,
                    "status" text NOT NULL DEFAULT ('planned'),
                    "error" text,
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                    "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
                )
            `);
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_scrape_batch_drive_account" ON "scrape_batch" ("driveType", "accountId")`);

        if (!(await queryRunner.hasTable('scrape_record'))) {
            await queryRunner.query(`
                CREATE TABLE "scrape_record" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "batchId" integer NOT NULL,
                    "driveType" text NOT NULL,
                    "accountId" integer NOT NULL DEFAULT (0),
                    "kind" text NOT NULL DEFAULT ('video'),
                    "mainRecordId" integer,
                    "groupKey" text,
                    "fileRef" text NOT NULL,
                    "newRef" text,
                    "oldParentRef" text NOT NULL,
                    "oldParentPath" text,
                    "oldName" text NOT NULL,
                    "size" integer,
                    "newParentRef" text,
                    "newParentPath" text,
                    "newName" text,
                    "mediaType" text,
                    "tmdbId" text,
                    "season" integer,
                    "episode" integer,
                    "title" text,
                    "year" text,
                    "confidence" integer,
                    "evidence" text,
                    "source" text NOT NULL DEFAULT ('auto'),
                    "status" text NOT NULL DEFAULT ('planned'),
                    "reason" text,
                    "error" text,
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                    "appliedAt" datetime,
                    "revertedAt" datetime
                )
            `);
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_scrape_record_batchId" ON "scrape_record" ("batchId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_scrape_record_file" ON "scrape_record" ("driveType", "accountId", "fileRef")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_scrape_record_status" ON "scrape_record" ("status")`);

        if (!(await queryRunner.hasTable('scrape_binding'))) {
            await queryRunner.query(`
                CREATE TABLE "scrape_binding" (
                    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "driveType" text NOT NULL,
                    "accountId" integer NOT NULL DEFAULT (0),
                    "folderKey" text NOT NULL,
                    "action" text NOT NULL DEFAULT ('bind'),
                    "tmdbId" text,
                    "mediaType" text,
                    "seasonOverride" integer,
                    "episodeOffset" integer NOT NULL DEFAULT (0),
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
                )
            `);
        }
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_scrape_binding_key" ON "scrape_binding" ("driveType", "accountId", "folderKey")`);
    }

    async down(queryRunner) {
        // 刮削日志是撤回依据，回滚迁移不主动删除用户数据。
    }
};

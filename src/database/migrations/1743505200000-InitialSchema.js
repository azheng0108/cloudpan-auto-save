const { MigrationInterface, QueryRunner } = require('typeorm');

module.exports = class InitialSchema1743505200000 {
    name = 'InitialSchema1743505200000';

    async up(queryRunner) {
        // 创建 account 表
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "account" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "username" text NOT NULL,
                "password" text,
                "cookies" text,
                "isActive" boolean NOT NULL DEFAULT (1),
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
                "clearRecycle" boolean DEFAULT (0),
                "localStrmPrefix" text DEFAULT (''),
                "cloudStrmPrefix" text DEFAULT (''),
                "embyPathReplace" text DEFAULT (''),
                "tgBotActive" boolean DEFAULT (0),
                "alias" text DEFAULT (''),
                "accountType" text DEFAULT ('cloud189'),
                "isDefault" boolean DEFAULT (0)
            )
        `);

        // 创建 task 表
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "task" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "accountId" integer NOT NULL,
                "shareLink" text NOT NULL,
                "targetFolderId" text NOT NULL,
                "videoType" text,
                "status" text NOT NULL DEFAULT ('pending'),
                "lastError" text,
                "lastCheckTime" datetime,
                "lastFileUpdateTime" datetime,
                "resourceName" text,
                "totalEpisodes" integer NOT NULL DEFAULT (0),
                "currentEpisodes" integer NOT NULL DEFAULT (0),
                "realFolderId" text,
                "realFolderName" text,
                "shareFileId" text,
                "shareFolderId" text,
                "shareFolderName" text,
                "shareId" text,
                "shareMode" text,
                "pathType" text,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
                "accessCode" text,
                "sourceRegex" text,
                "targetRegex" text,
                "movieRenameFormat" text DEFAULT (''),
                "tvRenameFormat" text DEFAULT (''),
                "matchPattern" text,
                "matchOperator" text,
                "matchValue" text,
                "retryCount" integer,
                "nextRetryTime" datetime,
                "remark" text,
                "cronExpression" text,
                "enableCron" boolean NOT NULL DEFAULT (0),
                "realRootFolderId" text,
                "embyId" text,
                "tmdbId" text,
                "enableTaskScraper" boolean,
                "enableSystemProxy" boolean,
                "tmdbContent" text,
                "isFolder" boolean DEFAULT (1),
                CONSTRAINT "FK_task_account" FOREIGN KEY ("accountId") REFERENCES "account" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
            )
        `);

        // 创建 common_folder 表
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "common_folder" (
                "id" text PRIMARY KEY NOT NULL,
                "accountId" integer NOT NULL,
                "path" text NOT NULL,
                "name" text NOT NULL
            )
        `);

        // 创建 transferred_file 表
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "transferred_file" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "taskId" integer NOT NULL,
                "fileId" text NOT NULL,
                "fileName" text,
                "md5" text,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);

        // 创建 transferred_file 的唯一索引
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_transferred_file_taskId_fileId" 
            ON "transferred_file" ("taskId", "fileId")
        `);
    }

    async down(queryRunner) {
        // 回滚：删除索引和表
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_transferred_file_taskId_fileId"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "transferred_file"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "common_folder"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "task"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "account"`);
    }
};

#!/usr/bin/env node

/**
 * 检查 TransferredFile 表的状态
 * 用于诊断重复转存问题
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 数据库连接失败:', err.message);
        process.exit(1);
    }
    console.log('✓ 数据库连接成功\n');
});

// 检查表是否存在
console.log('【1】检查 TransferredFile 表...\n');
db.all(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='transferred_file'
`, (err, rows) => {
    if (err) {
        console.error('❌ 表查询失败:', err.message);
        return;
    }
    
    if (rows && rows.length > 0) {
        console.log('✓ TransferredFile 表存在\n');
        checkTableStructure();
    } else {
        console.log('⚠️  TransferredFile 表不存在（可能迁移未执行）\n');
        db.close();
        process.exit(1);
    }
});

// 检查表结构
function checkTableStructure() {
    console.log('【2】检查表结构...\n');
    db.all(`PRAGMA table_info(transferred_file)`, (err, rows) => {
        if (err) {
            console.error('❌ 结构查询失败:', err.message);
            return;
        }
        
        if (rows && rows.length > 0) {
            console.log('表结构：');
            rows.forEach(col => {
                console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' (NOT NULL)' : ''}`);
            });
            console.log('');
            checkTableData();
        } else {
            console.log('⚠️  表结构查询为空\n');
            db.close();
        }
    });
}

// 检查表数据
function checkTableData() {
    console.log('【3】检查表数据...\n');
    db.get(`SELECT COUNT(*) as total FROM transferred_file`, (err, row) => {
        if (err) {
            console.error('❌ 数据统计失败:', err.message);
            return;
        }
        
        const count = row.total;
        console.log(`总记录数: ${count}\n`);
        
        if (count > 0) {
            console.log('【4】按任务统计已转存文件...\n');
            db.all(`
                SELECT taskId, COUNT(*) as count 
                FROM transferred_file 
                GROUP BY taskId 
                ORDER BY taskId
            `, (err, rows) => {
                if (err) {
                    console.error('❌ 任务统计失败:', err.message);
                    return;
                }
                
                if (rows && rows.length > 0) {
                    console.log('任务转存统计：');
                    rows.forEach(row => {
                        console.log(`  任务 ${row.taskId}: ${row.count} 个文件`);
                    });
                    console.log('');
                }
                
                console.log('【5】显示最近 10 条记录...\n');
                db.all(`
                    SELECT id, taskId, fileId, fileName, createdAt 
                    FROM transferred_file 
                    ORDER BY createdAt DESC 
                    LIMIT 10
                `, (err, rows) => {
                    if (err) {
                        console.error('❌ 最近记录查询失败:', err.message);
                        return;
                    }
                    
                    if (rows && rows.length > 0) {
                        console.log('最近转存的文件：');
                        rows.forEach((row, idx) => {
                            console.log(`  ${idx + 1}. [任务${row.taskId}] ${row.fileName || row.fileId}`);
                            console.log(`     时间: ${row.createdAt}`);
                        });
                    } else {
                        console.log('(无记录)');
                    }
                    console.log('');
                    
                    db.close(() => {
                        console.log('✓ 检查完成');
                    });
                });
            });
        } else {
            console.log('⚠️  表中无数据（可能尚未有任何转存操作）\n');
            db.close();
        }
    });
}

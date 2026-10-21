#!/usr/bin/env node

/**
 * 检查转存相关的日志，追踪 _recordTransferredFiles 是否被调用
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const logFile = path.join(__dirname, 'data', 'logs', 'app.log');

if (!fs.existsSync(logFile)) {
    console.log('❌ 日志文件不存在:', logFile);
    process.exit(1);
}

console.log('📋 检查最近的转存相关日志...\n');

const fileStream = fs.createReadStream(logFile);
const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
});

const logs = [];
const keywordPatterns = [
    /\[已转存DB\]/,
    /扫描完成/,
    /转存去重/,
    /触发后处理/,
    /自动重命名/,
    /重命名结果/,
    /重复|duplicate/i
];

rl.on('line', (line) => {
    try {
        if (keywordPatterns.some(pattern => pattern.test(line))) {
            const logEntry = JSON.parse(line);
            logs.push({
                timestamp: logEntry.timestamp,
                message: logEntry.message,
                level: logEntry.level
            });
        }
    } catch (e) {
        // 非 JSON 格式的日志行，忽略
    }
});

rl.on('close', () => {
    if (logs.length === 0) {
        console.log('❌ 未找到相关日志（可能尚未运行转存任务）\n');
        console.log('请运行一次转存任务，然后再次检查日志。\n');
        process.exit(1);
    }

    // 取最后 50 条相关日志
    const recentLogs = logs.slice(-50);

    console.log(`找到 ${recentLogs.length} 条相关日志（最近50条）:\n`);
    
    recentLogs.forEach((log, idx) => {
        const time = new Date(log.timestamp).toLocaleString('zh-CN');
        const icon = log.level === 'error' ? '❌' : (log.level === 'warn' ? '⚠️' : '✓');
        console.log(`${idx + 1}. [${time}] ${icon}\n   ${log.message}\n`);
    });

    // 分析数据库记录是否被调用
    const dbSaveLogs = logs.filter(log => log.message.includes('[已转存DB]'));
    const dbLoadLogs = logs.filter(log => log.message.includes('[已转存DB]'));

    console.log('\n【分析结果】\n');
    if (dbSaveLogs.length === 0) {
        console.log('⚠️  未发现 "[已转存DB] 正在保存" 日志');
        console.log('   - 可能 _recordTransferredFiles 没有被调用');
        console.log('   - 或者转存操作没有执行');
        console.log('   - 或者日志级别设置未捕获该日志\n');
    } else {
        console.log(`✓ 发现 ${dbSaveLogs.length} 条保存日志`);
        console.log(`✓ 发现 ${dbLoadLogs.length} 条加载日志\n`);
    }

    // 检查是否有重复转存的迹象
    const duplicateLogs = logs.filter(log => log.message.includes('重复'));
    if (duplicateLogs.length > 0) {
        console.log(`⚠️  发现 ${duplicateLogs.length} 条关于重复的日志`);
    }
});

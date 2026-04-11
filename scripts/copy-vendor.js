/**
 * copy-vendor.js
 *
 * 将第三方前端库的预构建文件复制到 src/public/vendor/，
 * 由 npm run build 和 Docker builder 阶段自动调用。
 *
 * 目的：避免在生产环境依赖外部 CDN（jsdelivr、unpkg 等在某些网络环境不可用），
 * 所有静态资源由本项目 Express 服务器自行托管。
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM   = path.join(ROOT, 'node_modules');
const DEST = path.join(ROOT, 'src', 'public', 'vendor');

/**
 * 需要复制的库列表。
 * - isFile: true  → src 为单个文件，直接复制到 dest 路径
 * - isFile: false → src 为目录，递归复制整个目录
 */
const VENDORS = [
    {
        // Lucide 图标库 UMD bundle（约 200KB），替代 unpkg CDN
        src:    path.join(NM, 'lucide', 'dist', 'umd', 'lucide.js'),
        dest:   path.join(DEST, 'lucide', 'lucide.js'),
        isFile: true,
    },
];

for (const { src, dest, isFile } of VENDORS) {
    if (!fs.existsSync(src)) {
        console.error(`[copy-vendor] 源路径不存在: ${src}`);
        console.error('[copy-vendor] 请先运行: npm install');
        process.exit(1);
    }

    // 确保目标目录存在
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (isFile) {
        // 目标已存在时先删除，保证版本干净
        if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
        fs.copyFileSync(src, dest);
        const size = Math.round(fs.statSync(dest).size / 1024);
        console.log(`[copy-vendor] ✓ ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)} (${size} KB)`);
    } else {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
        const count = fs.readdirSync(dest, { recursive: true }).length;
        console.log(`[copy-vendor] ✓ ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)} (${count} 个文件)`);
    }
}

console.log('[copy-vendor] 完成');

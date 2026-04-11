/**
 * copy-vendor.js
 *
 * 将第三方前端组件库的预构建文件复制到 src/public/vendor/，
 * 由 npm run build 和 Docker builder 阶段自动调用。
 *
 * 目的：避免在生产环境依赖外部 CDN（jsdelivr、unpkg 等在某些网络环境不可用），
 * 所有静态资源由本项目 Express 服务器自行托管。
 */

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const NM      = path.join(ROOT, 'node_modules');
const DEST    = path.join(ROOT, 'src', 'public', 'vendor');

/** 需要复制的库列表，每项 { src: node_modules 内路径, dest: vendor/ 内目录名 } */
const VENDORS = [
    {
        // Shoelace Web Components — tree 组件 CDN 包（含 chunks 和主题 CSS）
        src:  path.join(NM, '@shoelace-style', 'shoelace', 'cdn'),
        dest: path.join(DEST, 'shoelace'),
    },
];

for (const { src, dest } of VENDORS) {
    if (!fs.existsSync(src)) {
        console.error(`[copy-vendor] 源目录不存在: ${src}`);
        console.error('[copy-vendor] 请先运行: npm install');
        process.exit(1);
    }

    // 目标已存在时先删除，保证版本干净
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });

    fs.cpSync(src, dest, { recursive: true });
    const count = fs.readdirSync(dest, { recursive: true }).length;
    console.log(`[copy-vendor] ✓ ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)} (${count} 个文件)`);
}

console.log('[copy-vendor] 完成');

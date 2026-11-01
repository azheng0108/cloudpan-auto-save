/**
 * 零外部依赖纯 JS 二维码生成模块
 * 基于 Reed-Solomon 纠错与标准 QRCode 规范 (qrcode-generator 1.4.4)
 */

// 嵌入轻量自包含核心
let qrcodeLib;
try {
    const fs = require('fs');
    const path = require('path');
    const minCode = fs.readFileSync(path.join(__dirname, 'qrcode-core.min.js'), 'utf8');
    const fn = new Function('module', 'exports', minCode + '\nreturn qrcode;');
    qrcodeLib = fn({}, {});
} catch (_) {
    // 容灾兜底
    qrcodeLib = null;
}

/**
 * 生成二维码 DataURL (GIF 格式)
 * @param {string} text 目标链接或文本
 * @param {number} cellSize 单个模块像素大小 (默认 5)
 * @param {number} margin 边距 (默认 8)
 * @returns {string} DataURL 字符串
 */
function createQrDataUrl(text, cellSize = 5, margin = 8) {
    if (!qrcodeLib) {
        throw new Error('QR Code generator core not available');
    }
    const qr = qrcodeLib(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(cellSize, margin);
}

/**
 * 生成二维码 SVG 字符串
 * @param {string} text 目标链接或文本
 * @param {number} cellSize 模块大小 (默认 5)
 * @param {number} margin 边距 (默认 10)
 * @returns {string} SVG 标签字符串
 */
function createQrSvg(text, cellSize = 5, margin = 10) {
    if (!qrcodeLib) {
        throw new Error('QR Code generator core not available');
    }
    const qr = qrcodeLib(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag(cellSize, margin);
}

module.exports = {
    createQrDataUrl,
    createQrSvg,
};

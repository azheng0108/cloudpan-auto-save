// 验证 mcloud-sign 算法
// 已知量:
// datetime = "2026-03-09 09:01:39"
// appId    = "SWJG9ndYI1p2Ia5S"
// auth     = "Basic YOUR_AUTH_TOKEN_HERE"
// expected = "8641555959C869E4AEC79E1D4009C2FD"

const crypto = require('crypto');
const datetime = '2026-03-09 09:01:39';
const appId = 'SWJG9ndYI1p2Ia5S';
const auth = 'Basic YOUR_AUTH_TOKEN_HERE';
const expectedHash = '8641555959C869E4AEC79E1D4009C2FD';

// 解码 token
const base64 = auth.replace(/^Basic\s+/i, '');
const decoded = Buffer.from(base64, 'base64').toString();
console.log('decoded prefix:', decoded.substring(0, 30));
const colonIdx2 = decoded.indexOf(':', decoded.indexOf(':') + 1);
const token = decoded.substring(colonIdx2 + 1);
console.log('token prefix:', token.substring(0, 20));

// 试各种算法
const tests = [
  { label: 'datetime,appId:token', input: `${datetime},${appId}:${token}` },
  { label: 'datetime appId token', input: `${datetime}${appId}${token}` },
  { label: 'appId:token', input: `${appId}:${token}` },
  { label: 'datetime,appId,token', input: `${datetime},${appId},${token}` },
];
for (const t of tests) {
  const h = crypto.createHash('md5').update(t.input, 'utf8').digest('hex').toUpperCase();
  console.log(t.label, '=', h, h === expectedHash ? '✅ MATCH!' : '');
}

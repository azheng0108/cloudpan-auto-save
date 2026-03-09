/**
 * 测试 /hcy/file/* 中找到正确的 mkdir 端点
 * 使用 INNER-HCY-ROUTER-HTTPS 头以绕过域名限制
 */
import crypto from 'crypto';

const SIGN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function md5(str) { return crypto.createHash('md5').update(str, 'utf8').digest('hex'); }
function formatDatetimeCST() {
    const cst = new Date(Date.now() + 8 * 3600 * 1000);
    const iso = cst.toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}
function randomStr(n = 16) {
    let s = '';
    for (let i = 0; i < n; i++) s += SIGN_CHARS[Math.floor(Math.random() * SIGN_CHARS.length)];
    return s;
}
function getNewSignHash(body, datetime, rand) {
    let s = '';
    if (body) {
        s = JSON.stringify(Object.assign({}, body));
        s = encodeURIComponent(s);
        s = s.split('').sort().join('');
    }
    const r = md5(Buffer.from(s, 'utf8').toString('base64'));
    const c = md5(datetime + ':' + rand);
    return md5(r + c).toUpperCase();
}

const AUTH = 'Basic YOUR_AUTH_TOKEN_HERE';
const PHONE = 'YOUR_PHONE_NUMBER';
const PARENT_FILE_ID = 'FizQdsh4TFhfSul3tz1BL65hYo51SExqX';

const { default: got } = await import('got');

const candidates = [
    ['/hcy/file/mkdir',           { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
    ['/hcy/file/createFolder',    { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
    ['/hcy/folder/create',        { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
    ['/hcy/file/create',          { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__', type: 'folder' }],
    ['/hcy/catalog/create',       { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
    ['/hcy/file/folder/create',   { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
    ['/hcy/personal/mkdir',       { parentFileId: PARENT_FILE_ID, name: '__test_mkdir__' }],
];

for (const [path, body] of candidates) {
    const datetime = formatDatetimeCST();
    const rand = randomStr(16);
    const hash = getNewSignHash(body, datetime, rand);
    const sign = `${datetime},${rand},${hash}`;

    const headers = {
        'caller': 'web',
        'mcloud-version': '7.17.2',
        'mcloud-channel': '1000101',
        'mcloud-client': '10701',
        'mcloud-route': '001',
        'mcloud-sign': sign,
        'INNER-HCY-ROUTER-HTTPS': '1',
        'x-m4c-caller': 'PC',
        'x-m4c-src': '10002',
        'x-inner-ntwk': '2',
        'x-yun-channel-source': '10000034',
        'x-huawei-channelSrc': '10000034',
        'x-yun-svc-type': '1',
        'x-SvcType': '1',
        'x-yun-module-type': '100',
        'x-yun-app-channel': '10000034',
        'x-yun-api-version': 'v1',
        'x-yun-client-info': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
        'X-Deviceinfo': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
        'CMS-DEVICE': 'default',
        'Authorization': AUTH,
        'Content-Type': 'application/json',
    };

    try {
        const res = await got.post(`https://personal-kd-njs.yun.139.com${path}`, {
            json: body,
            headers,
            throwHttpErrors: false,
        }).json();
        const status = res.success ? '✅' : res.code === '0' ? '✅' : `❌[${res.code}]`;
        console.log(`${status} ${path} → code=${res.code} msg=${res.desc ?? res.message ?? ''}`);
        if (res.success || String(res.code) === '0') {
            console.log('   成功! data=', JSON.stringify(res.data ?? res).slice(0, 200));
            break;
        }
    } catch (e) {
        if (e.response?.statusCode === 404) {
            console.log(`❓ ${path} → 404 Not Found`);
        } else {
            console.log(`❓ ${path} → ${e.message}`);
        }
    }
}

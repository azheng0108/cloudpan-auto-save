import crypto from 'crypto';
import got from 'got';

const SIGN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const md5 = str => crypto.createHash('md5').update(str, 'utf8').digest('hex');

function getNewSignHash(body, datetime, randomStr) {
    let s = JSON.stringify(Object.assign({}, body));
    s = encodeURIComponent(s);
    s = s.split('').sort().join('');
    const r = md5(Buffer.from(s, 'utf8').toString('base64'));
    const c = md5(datetime + ':' + randomStr);
    return md5(r + c).toUpperCase();
}

function formatDatetimeCST() {
    const cst = new Date(Date.now() + 8 * 3600 * 1000);
    const iso = cst.toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}

function randStr(n=16) {
    let s = '';
    for (let i = 0; i < n; i++) s += SIGN_CHARS[Math.floor(Math.random() * SIGN_CHARS.length)];
    return s;
}

const AUTH = 'Basic YOUR_AUTH_TOKEN_HERE';
const PHONE = 'YOUR_PHONE_NUMBER';

async function listDir(parentFileId) {
    const catalogID = parentFileId || '/';
    const dt = formatDatetimeCST(), rnd = randStr();
    const signBody = {
        catalogID, sortDirection: 1, startNumber: 1, endNumber: 100,
        filterType: 0, catalogSortType: 0, contentSortType: 0,
        commonAccountInfo: { account: PHONE, accountType: 1 }
    };
    const hash = getNewSignHash(signBody, dt, rnd);
    const sign = `${dt},${rnd},${hash}`;
    console.log('  sign:', sign);
    const res = await got.post('https://personal-kd-njs.yun.139.com/hcy/file/list', {
        json: {
            pageInfo: { pageSize: 100, pageCursor: null },
            orderBy: 'updated_at', orderDirection: 'DESC',
            parentFileId: catalogID,
            imageThumbnailStyleList: ['Small', 'Large']
        },
        headers: {
            'caller': 'web', 'mcloud-version': '7.17.2', 'mcloud-channel': '1000101',
            'mcloud-client': '10701', 'mcloud-route': '001', 'mcloud-sign': sign,
            'INNER-HCY-ROUTER-HTTPS': '1', 'x-m4c-caller': 'PC', 'x-m4c-src': '10002',
            'x-inner-ntwk': '2', 'x-yun-channel-source': '10000034', 'x-huawei-channelSrc': '10000034',
            'x-yun-svc-type': '1', 'x-SvcType': '1', 'x-yun-module-type': '100',
            'x-yun-app-channel': '10000034', 'x-yun-api-version': 'v1',
            'x-yun-client-info': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
            'X-Deviceinfo': '||9|7.17.2|chrome|143.0.0.0|ff559f01db65afce55f3b4e5d75be4cb||windows 10||zh-CN|||',
            'CMS-DEVICE': 'default',
            'Authorization': AUTH,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    }).json();
    return res;
}

console.log('\n=== listDiskDir 端到端测试 ===');
const parentId = 'FizQdsh4TFhfSul3tz1BL65hYo51SExqX'; // /media/
console.log(`\n📂 列出 /media/ (${parentId})...`);
try {
    const r = await listDir(parentId);
    console.log('API返回 success:', r.success, ' code:', r.code, ' message:', r.message);
    const items = (r.data ? r.data.items : null) ?? r.items ?? [];
    console.log(`共 ${items.length} 个文件/目录`);
    items.forEach(f => {
        const isDir = !f.fileExtension || f.fileExtension === '';
        console.log(` ${isDir ? '📁' : '📄'} ${f.name} [${f.fileId}] ext=${JSON.stringify(f.fileExtension)} fileType=${f.fileType}`);
    });
    if (items.length === 0) {
        console.log('(无内容，原始响应:)', JSON.stringify(r).slice(0, 500));
    }
} catch (e) {
    console.error('调用失败:', e.message);
    if (e.response) console.error('HTTP状态:', e.response.statusCode, '\n', e.response.body?.slice?.(0,500));
}

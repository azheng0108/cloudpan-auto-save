const got = require('got');
(async () => {
  const l = await got.post('http://localhost:3000/api/auth/login', {
    json: { username: 'admin', password: 'admin' },
    followRedirect: false, throwHttpErrors: false,
  });
  const cookies = (l.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');

  // API 直接返回 folders
  const r = await got.get('http://localhost:3000/api/folders/2', {
    headers: { Cookie: cookies }, throwHttpErrors: false,
  }).json();
  console.log('resp:', JSON.stringify(r).substring(0, 1000));
})().catch(e => console.error('ERR:', e.message));

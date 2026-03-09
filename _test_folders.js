const got = require('got');
(async () => {
  const l = await got.post('http://localhost:3000/api/auth/login', {
    json: { username: 'admin', password: 'admin' },
    followRedirect: false, throwHttpErrors: false,
  });
  const cookies = (l.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  console.log('cookie:', cookies ? 'OK' : 'FAIL');

  // 根目录列表
  const root = await got.get('http://localhost:3000/api/folders/2', {
    headers: { Cookie: cookies }, throwHttpErrors: false,
  }).json();
  console.log('根目录:', JSON.stringify(root.data?.slice(0, 10)));

  // 找 media 或 电影
  const mediaItem = (root.data || []).find(f => f.name === 'media' || f.name === '电影');
  console.log('media/电影:', mediaItem);

  if (mediaItem) {
    // 列出 media 子目录
    const sub = await got.get(`http://localhost:3000/api/folders/2?folderId=${mediaItem.id}`, {
      headers: { Cookie: cookies }, throwHttpErrors: false,
    }).json();
    console.log('子目录:', JSON.stringify(sub.data?.slice(0, 15)));

    // 找 电影
    const dianying = (sub.data || []).find(f => f.name === '电影');
    console.log('电影:', dianying);
    if (dianying) {
      // 列出电影子目录
      const sub2 = await got.get(`http://localhost:3000/api/folders/2?folderId=${dianying.id}`, {
        headers: { Cookie: cookies }, throwHttpErrors: false,
      }).json();
      console.log('电影子目录:', JSON.stringify(sub2.data?.slice(0, 15)));
    }
  }
})().catch(e => console.error('ERR:', e.message, e.stack));

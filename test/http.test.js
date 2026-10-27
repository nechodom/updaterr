const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const http = require('node:http');
const zlib = require('node:zlib');
const { send, publicCand } = require('../src/http');

test('kandidát pro web nemá odkazy ke stažení (API klíč Prowlarru) ani interní data Radarru', () => {
  const c = publicCand({ guid: 'g', title: 'T', downloadUrl: 'http://prowlarr/1/download?apikey=SECRET', magnetUrl: 'magnet:?xt=x', arr: { q: 1 }, arrRejections: ['x'], infoUrl: 'https://t/1' });
  assert.ok(!JSON.stringify(c).includes('SECRET'));
  assert.strictEqual(c.magnetUrl, undefined);
  assert.strictEqual(c.arr, undefined);
  assert.strictEqual(c.infoUrl, 'https://t/1');
  assert.strictEqual(publicCand(null), null);
});

test('JSON: gzip pro velké odpovědi, ETag a 304 pro nezměněná data', async () => {
  const data = { list: Array.from({ length: 500 }, (_, i) => ({ i, title: `Film ${i}` })) };
  const server = http.createServer((req, res) => send(res, 200, data));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const get = (headers) => new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    const a = await get({ 'Accept-Encoding': 'gzip' });
    assert.strictEqual(a.res.statusCode, 200);
    assert.strictEqual(a.res.headers['content-encoding'], 'gzip');
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(a.body)), data);
    const etag = a.res.headers.etag;
    assert.ok(etag);
    const b = await get({ 'If-None-Match': etag });
    assert.strictEqual(b.res.statusCode, 304);
    assert.strictEqual(b.body.length, 0);
    const c = await get({});
    assert.strictEqual(c.res.headers['content-encoding'], undefined);
    assert.deepStrictEqual(JSON.parse(c.body), data);
  } finally { server.close(); }
});

test('CSRF: změny z cizí stránky se odmítnou, ntfy tlačítka (bez Originu) a webhooky projdou', () => {
  const { csrfBlocked } = require('../src/http');
  const req = (method, headers = {}) => ({ method, headers: { host: '10.96.0.2:5290', ...headers } });
  const p = '/api/proposals/abc/grab/123';
  assert.strictEqual(csrfBlocked(req('POST', { origin: 'http://10.96.0.2:5290', 'sec-fetch-site': 'same-origin' }), p), false, 'vlastní web');
  assert.strictEqual(csrfBlocked(req('POST'), p), false, 'ntfy tlačítko / curl bez Originu');
  assert.strictEqual(csrfBlocked(req('POST', { origin: 'https://zla.stranka.pri' }), p), true);
  assert.strictEqual(csrfBlocked(req('POST', { 'sec-fetch-site': 'cross-site' }), p), true, 'formulář z cizí stránky bez Originu');
  assert.strictEqual(csrfBlocked(req('PUT', { origin: 'http://10.96.0.2:9999', 'sec-fetch-site': 'same-site' }), '/api/settings'), true, 'jiný port = jiný web');
  assert.strictEqual(csrfBlocked(req('DELETE', { origin: 'null' }), '/api/bad-donors/x'), true);
  assert.strictEqual(csrfBlocked(req('GET', { origin: 'https://zla.stranka.pri', 'sec-fetch-site': 'cross-site' }), '/api/overview'), false, 'čtení se neblokuje');
  assert.strictEqual(csrfBlocked(req('POST', { origin: 'https://radarr.example', 'sec-fetch-site': 'cross-site' }), '/api/webhook/radarr'), false);
  assert.strictEqual(csrfBlocked(req('POST', { origin: 'https://updaterr.example', 'x-forwarded-host': 'updaterr.example' }), p), false, 'za reverzní proxy');
});

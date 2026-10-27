const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { plan } = require('../src/cleanup');

const tor = (hash, extra = {}) => ({ hash: hash.toLowerCase(), progress: 1, ...extra });

test('hotové stahování: smaže torrenty, které v qBittorrentu jsou (hash bez ohledu na velikost písmen)', () => {
  const d = { state: 'done', parts: [{ downloadId: 'AA' }, { downloadId: 'BB' }, { downloadId: 'CC' }] };
  const out = plan([d], [tor('aa'), tor('cc'), tor('zz')], new Set());
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].hashes, ['aa', 'cc']);
});

test('nehotová, už uklizená a jiná stahování se nechají být', () => {
  const list = [
    { state: 'downloading', active: true, parts: [{ downloadId: 'AA' }] },
    { state: 'failed', parts: [{ downloadId: 'BB' }] },
    { state: 'done', torrentsRemoved: 1, parts: [{ downloadId: 'CC' }] },
  ];
  assert.deepStrictEqual(plan(list, [tor('aa'), tor('bb'), tor('cc')], new Set()), []);
});

test('torrent používaný běžící úlohou se nesmaže', () => {
  const d = { state: 'done', parts: [{ downloadId: 'AA' }] };
  assert.deepStrictEqual(plan([d], [tor('aa')], new Set(['aa'])), []);
});

test('starý záznam bez parts a záznam, jehož torrent už zmizel', () => {
  const old = { state: 'done', downloadId: 'AA' };
  const gone = { state: 'done', parts: [{ downloadId: 'BB' }, { downloadId: null }] };
  const out = plan([old, gone], [tor('aa')], new Set());
  assert.deepStrictEqual(out.map((x) => x.hashes), [['aa'], []]);
});

test('nedostažený torrent nebo torrent přidaný až po dokončení úlohy se nesmaže', () => {
  const d = { state: 'done', finishedAt: 1000e3, parts: [{ downloadId: 'AA' }] };
  assert.deepStrictEqual(plan([d], [tor('aa', { progress: 0.5 })], new Set()), []);
  assert.deepStrictEqual(plan([d], [tor('aa', { added_on: 2000 })], new Set()), []);
  assert.deepStrictEqual(plan([d], [tor('aa', { added_on: 900 })], new Set())[0].hashes, ['aa']);
});

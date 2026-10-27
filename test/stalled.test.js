const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { plan, TAG } = require('../src/stalled');

const S = { enabled: true, stallMin: 30, retryMin: 120 };
const MIN = 60e3;
const tor = (state, extra = {}) => ({ hash: 'h1', name: 'Film', state, progress: 0.1, dlspeed: 0, tags: '', ...extra });

test('zaseknutý torrent se zastaví až po stallMin a dostane štítek', () => {
  const recs = {};
  let p = plan([tor('stalledDL')], recs, S, 0);
  assert.deepStrictEqual(p.stop, []);
  p = plan([tor('stalledDL')], recs, S, 29 * MIN);
  assert.deepStrictEqual(p.stop, []);
  p = plan([tor('stalledDL')], recs, S, 30 * MIN);
  assert.strictEqual(p.stop.length, 1);
  assert.strictEqual(recs.h1.stoppedAt, 30 * MIN);
  assert.match(p.events[0], /zastaveno/);
});

test('rozjetí mezitím vynuluje odpočet', () => {
  const recs = {};
  plan([tor('stalledDL')], recs, S, 0);
  plan([tor('downloading', { dlspeed: 1000 })], recs, S, 20 * MIN);
  const p = plan([tor('stalledDL')], recs, S, 40 * MIN);
  assert.deepStrictEqual(p.stop, []);
  assert.deepStrictEqual(plan([tor('stalledDL')], recs, S, 70 * MIN).stop.length, 1);
});

test('zastavený se po retryMin znovu spustí; když zase stojí, znovu se zastaví', () => {
  const recs = { h1: { name: 'Film', stoppedAt: 0, tries: 1 } };
  const stopped = tor('stoppedDL', { tags: TAG });
  assert.deepStrictEqual(plan([stopped], recs, S, 119 * MIN).start, []);
  assert.strictEqual(plan([stopped], recs, S, 120 * MIN).start.length, 1);
  // Po spuštění čeká ve frontě – to se za zaseknutí nepočítá
  assert.deepStrictEqual(plan([tor('queuedDL', { tags: TAG })], recs, S, 125 * MIN).stop, []);
  plan([tor('stalledDL', { tags: TAG })], recs, S, 130 * MIN);
  const p = plan([tor('stalledDL', { tags: TAG })], recs, S, 160 * MIN);
  assert.strictEqual(p.stop.length, 1);
  assert.match(p.events[0], /2×/);
});

test('po opětovném spuštění se rozjel → štítek pryč, záznam smazán', () => {
  const recs = { h1: { name: 'Film', retriedAt: 0, tries: 1 } };
  const p = plan([tor('downloading', { tags: TAG, dlspeed: 5e5 })], recs, S, MIN);
  assert.strictEqual(p.untag.length, 1);
  assert.deepStrictEqual(recs, {});
  assert.match(p.events[0], /rozjel/);
});

test('ručně zastavené, vynucené a staré záznamy se nechávají být', () => {
  const recs = { gone: { name: 'Smazaný', stoppedAt: 0, tries: 1 } };
  const p = plan([tor('stoppedDL'), tor('forcedDL', { hash: 'h2' }), tor('forcedMetaDL', { hash: 'h3' })], recs, S, 500 * MIN);
  assert.deepStrictEqual([p.stop, p.start, p.untag], [[], [], []]);
  assert.deepStrictEqual(recs, {});
});

test('vypnutí vrátí zastavené torrenty do běhu a sundá štítek', () => {
  const recs = { h1: { name: 'Film', stoppedAt: 0, tries: 1 } };
  const p = plan([tor('stoppedDL', { tags: `radarr, ${TAG}` })], recs, { ...S, enabled: false }, MIN);
  assert.strictEqual(p.start.length, 1);
  assert.strictEqual(p.untag.length, 1);
  assert.deepStrictEqual(recs, {});
});

test('qBittorrent 4: pausedDL se bere jako zastavený', () => {
  const recs = { h1: { name: 'Film', stoppedAt: 0, tries: 1 } };
  assert.strictEqual(plan([tor('pausedDL', { tags: TAG })], recs, S, 120 * MIN).start.length, 1);
});

test('stahování Updaterru se nezastavuje (má vlastní pravidlo pro mrtvé torrenty), zastavené se pustí', () => {
  const recs = {};
  const skip = new Set(['h1']);
  plan([tor('stalledDL', { hash: 'H1' })], recs, { ...S, skip }, 0);
  assert.deepStrictEqual(plan([tor('stalledDL', { hash: 'H1' })], recs, { ...S, skip }, 60 * MIN).stop, []);
  const p = plan([tor('stoppedDL', { hash: 'H1', tags: TAG })], recs, { ...S, skip }, 61 * MIN);
  assert.strictEqual(p.start.length, 1);
  assert.strictEqual(p.untag.length, 1);
});

test('když spuštění v qBittorrentu selže a torrent pořád stojí, zkusí se znovu', () => {
  const recs = {};
  const o = { enabled: true, stallMin: 30, retryMin: 60 };
  const t = { hash: 'h', name: 'x', state: 'stalledDL', tags: 'updaterr-stalled', progress: 0 };
  plan([t], recs, o, 0);
  plan([t], recs, o, 31 * 60e3);
  const s = { ...t, state: 'stoppedDL' };
  assert.strictEqual(plan([s], recs, o, 92 * 60e3).start.length, 1);
  assert.strictEqual(plan([s], recs, o, 100 * 60e3).start.length, 0, 'ne hned znovu');
  assert.strictEqual(plan([s], recs, o, 153 * 60e3).start.length, 1, 'po retryMin od pokusu znovu');
});

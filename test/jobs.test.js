const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { attachJobs } = require('../src/jobs');
const { Downloads } = require('../src/downloads');
const { candId } = require('../src/search');
const { DEFAULT_SETTINGS } = require('../src/store');

function setup() {
  const store = {
    settings: { ...DEFAULT_SETTINGS },
    s: { items: {}, proposals: {}, downloads: {}, merges: {}, ignoredGuids: {} },
    save() {},
    log() {},
    countSearch() {},
  };
  const item = { key: 'radarr:1', app: 'radarr', arrId: 1, title: 'Film', year: 2020, current: { tier: 1, audio: 'eng', quality: 'WEBDL-1080p', fileIds: [5] } };
  store.s.items[item.key] = item;
  const cand = { guid: 'https://tracker/x?id=abc', indexerId: 4, title: 'Film (2020)(CZ/EN)[1080p]', size: 1, seeders: 50, tier: 3, kind: 'language', warnings: [], searchedAt: Date.now() };
  const p = { id: 'p1', itemKey: item.key, status: 'pending', searchedAt: Date.now(), candidates: [cand] };
  store.s.proposals.p1 = p;
  const grabs = [];
  let release;
  const radarr = { grab: async (guid) => { grabs.push(guid); await new Promise((r) => { release = r; }); } };
  const ctx = { store, radarr, notify: { download: async () => {} }, searcher: { enqueue() {} }, merger: { active: () => [] } };
  ctx.downloads = new Downloads(ctx);
  attachJobs(ctx);
  return { ctx, store, cand, grabs, release: () => release?.() };
}

test('schválení návrhu neblokuje samo sebe („už jedno stahování běží“)', async () => {
  const { ctx, store, cand, grabs, release } = setup();
  const pending = ctx.grab('p1', candId(cand));
  await new Promise((r) => setImmediate(r));
  release();
  const d = await pending;
  assert.strictEqual(grabs.length, 1);
  assert.strictEqual(d.state, 'grabbed');
  assert.strictEqual(store.s.proposals.p1.status, 'grabbed');
  assert.strictEqual(store.s.proposals.p1.grabbedGuid, cand.guid);
});

test('dvojí schválení téhož návrhu najednou stáhne jen jednou', async () => {
  const { ctx, cand, grabs, release } = setup();
  const first = ctx.grab('p1', candId(cand));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(ctx.grab('p1', candId(cand)), /už zpracovává/);
  release();
  await first;
  assert.strictEqual(grabs.length, 1);
});

test('během schvalování je položka pro ostatní zaneprázdněná', async () => {
  const { ctx, cand, release } = setup();
  const first = ctx.grab('p1', candId(cand));
  await new Promise((r) => setImmediate(r));
  assert.ok(ctx.busyKeys().has('radarr:1'));
  assert.ok(!ctx.busyKeys({ except: 'p1' }).has('radarr:1'));
  release();
  await first;
  assert.ok(ctx.busyKeys().has('radarr:1'), 'po odeslání běží stahování');
});

test('během schvalování je známý schvalovaný kandidát (web pak nenabízí znovu „Stáhnout“)', async () => {
  const { ctx, cand, release } = setup();
  const first = ctx.grab('p1', candId(cand));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(ctx.inflight.get('p1'), cand.guid);
  release();
  await first;
  assert.ok(!ctx.inflight.has('p1'));
});

test('neznámé ID kandidáta → srozumitelná chyba', async () => {
  const { ctx } = setup();
  await assert.rejects(ctx.grab('p1', 'neexistuje'), /už v návrhu není/);
});

test('stejný release jako výměna i sloučení má různá ID – tlačítko spustí správnou akci', () => {
  const { resolveCandidate } = require('../src/search');
  const guid = 'https://tracker/x?id=same';
  const p = { candidates: [{ guid, kind: 'merge' }, { guid, kind: 'language' }] };
  assert.notStrictEqual(candId(p.candidates[0]), candId(p.candidates[1]));
  assert.strictEqual(resolveCandidate(p, candId(p.candidates[0])), 0);
  assert.strictEqual(resolveCandidate(p, candId(p.candidates[1])), 1);
  // Starší tlačítko sloučení (ID jen z GUID) se přijme, jen když je release v návrhu jednou
  const legacy = require('node:crypto').createHash('sha1').update(guid).digest('hex').slice(0, 10);
  assert.strictEqual(resolveCandidate({ candidates: [{ guid, kind: 'merge' }] }, legacy), 0);
  assert.strictEqual(resolveCandidate(p, legacy), 1); // = ID výměny (nezměněné)
  assert.strictEqual(resolveCandidate(p, 'neexistuje'), -1);
});

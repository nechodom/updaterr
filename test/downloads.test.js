const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { Downloads } = require('../src/downloads');
const { DEFAULT_SETTINGS } = require('../src/store');

const H = 3600e3;
const GB = 1024 ** 3;

function setup() {
  const removed = [];
  const store = {
    settings: { ...DEFAULT_SETTINGS, stallHours: 3, retryOnStall: false },
    s: { items: {}, proposals: {}, downloads: {}, merges: {}, ignoredGuids: {} },
    save() {}, log() {},
  };
  const radarr = { removeFromQueue: async (id) => removed.push(id) };
  const ctx = { store, radarr, sonarr: {}, notify: { download: async () => {} }, searcher: { enqueue() {} }, merger: { active: () => [] } };
  const dl = new Downloads(ctx);
  const d = {
    id: 'd1', app: 'radarr', arrId: 7, itemKey: 'radarr:7', label: 'Film (2020)', guid: 'g1', title: 'Film.2020.CZ.1080p',
    grabbedAt: 0, active: true, state: 'grabbed', attempt: 1, prevFileIds: [1], candidate: { tier: 3 },
    parts: [{ guid: 'g1', title: 'Film.2020.CZ.1080p', downloadId: 'ABC', state: 'grabbed', progress: 0 }],
  };
  store.s.downloads.d1 = d;
  const rec = (extra) => [{ id: 11, movieId: 7, downloadId: 'ABC', title: 'Film.2020.CZ.1080p', status: 'downloading', trackedDownloadState: 'downloading', ...extra }];
  return { dl, d, removed, rec };
}

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}

test('magnet bez metadat (velikost 0) není "stažený" a po příchodu metadat se pokrok měří od nuly', async () => {
  const { dl, d, removed, rec } = setup();
  await at(0, () => dl.check(d, rec({ size: 0, sizeleft: 0 })));
  assert.strictEqual(d.parts[0].state, 'downloading', 'bez metadat se nesmí čekat na import');
  // metadata dorazila po 1 h, pak se pomalu stahuje (1 GB/h)
  await at(1 * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 10 * GB })));
  await at(2 * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 9 * GB })));
  await at(3.5 * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 8 * GB })));
  await at(4.5 * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 7 * GB })));
  assert.strictEqual(d.active, true, 'stahující torrent se nesmí prohlásit za mrtvý');
  assert.deepStrictEqual(removed, []);
});

test('magnet, který metadata nikdy nedostane, po stallHours selže (nevisí věčně)', async () => {
  const { dl, d, rec } = setup();
  await at(0, () => dl.check(d, rec({ size: 0, sizeleft: 0 })));
  await at(2 * H, () => dl.check(d, rec({ size: 0, sizeleft: 0 })));
  assert.strictEqual(d.active, true);
  await at(3.1 * H, () => dl.check(d, rec({ size: 0, sizeleft: 0 })));
  assert.strictEqual(d.active, false);
  assert.strictEqual(d.state, 'failed');
});

test('čekání ve frontě qBittorrentu se do limitu bez pokroku nepočítá, skutečné zaseknutí ano', async () => {
  const { dl, d, rec } = setup();
  for (const h of [0, 1, 2, 3, 4, 5]) await at(h * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 10 * GB, status: 'queued' })));
  assert.strictEqual(d.active, true, 've frontě klienta torrent stát smí');
  for (const h of [5.5, 7, 8.6]) await at(h * H, () => dl.check(d, rec({ size: 10 * GB, sizeleft: 10 * GB, status: 'warning' })));
  assert.strictEqual(d.state, 'failed');
});

test('cizí stažení téhož filmu se nepřevezme: známý hash, který ve frontě není, se neodhaduje', async () => {
  const { dl, d } = setup();
  const foreign = [{ id: 22, movieId: 7, downloadId: 'RADARR', title: 'Film.2020.EN.2160p', status: 'downloading', size: 10 * GB, sizeleft: 5 * GB }];
  assert.strictEqual(dl.findInQueue(d, d.parts[0], foreign), null);
  // Bez hashe se odhad použije, ale hash cizího záznamu se nepřevezme (úklid by ho smazal)
  delete d.parts[0].downloadId;
  await at(0, () => dl.check(d, foreign));
  assert.strictEqual(d.parts[0].guessed, true);
  assert.strictEqual(d.parts[0].downloadId, undefined);
});

test('hash vlastního torrentu se doplní z historie Radarru (název ve frontě bývá jiný)', async () => {
  const { dl, d, rec } = setup();
  delete d.parts[0].downloadId;
  dl.ctx.firstGrab = { identify: async (x) => { x.parts[0].downloadId = 'ABC'; } };
  await at(0, () => dl.check(d, rec({ title: 'jiny-nazev-souboru', size: 10 * GB, sizeleft: 5 * GB })));
  assert.strictEqual(d.parts[0].downloadId, 'ABC');
  assert.strictEqual(d.parts[0].queueId, 11);
  assert.strictEqual(d.parts[0].guessed, undefined);
});

test('vynucený import, který ještě běží, se nepustí z fronty (úklid by smazal nenaimportované soubory)', async () => {
  const { dl } = setup();
  let status = 'started';
  dl.ctx.radarr.get = async (p) => { assert.strictEqual(p, '/command/42'); return { status }; };
  const d = { app: 'radarr' };
  assert.strictEqual(await dl.importRunning(d, { forceImportCmd: 42 }), true);
  status = 'completed';
  assert.strictEqual(await dl.importRunning(d, { forceImportCmd: 42 }), false);
  assert.strictEqual(await dl.importRunning(d, {}), false);
  dl.ctx.radarr.get = async () => { throw new Error('404'); };
  assert.strictEqual(await dl.importRunning(d, { forceImportCmd: 42 }), false);
});

test('výpadek qBittorrentu přes 30 min neoznačí stahování za ztracené – nejdřív se ptá qBittorrentu', async () => {
  const hash = 'ab'.repeat(20);
  const { dl, d, rec } = setup();
  d.parts[0].downloadId = hash.toUpperCase();
  let qbit = 'down';
  const asked = [];
  dl.ctx.qbit = {
    enabled: true,
    version: async () => 'v5',
    byHashes: async (h) => {
      asked.push(h);
      if (qbit === 'down') throw new Error('fetch failed');
      return qbit === 'has' ? [{ hash }] : [];
    },
  };
  await at(0.1 * H, () => dl.check(d, rec({ downloadId: hash.toUpperCase(), size: 10 * GB, sizeleft: 5 * GB })));
  // qBittorrent spadl → fronta Radarru je prázdná
  await at(0.7 * H, () => dl.check(d, []));
  assert.strictEqual(d.active, true);
  assert.match(d.message, /qBittorrent neodpovídá/);
  assert.deepStrictEqual(asked[0], [hash]);
  await at(10 * H, () => dl.check(d, []));
  assert.strictEqual(d.active, true, 'dokud qBittorrent neodpovídá, nic se neodepisuje');
  // qBittorrent běží a torrent v něm je, jen ho Radarr nevidí → chvíli počkat
  qbit = 'has';
  await at(1 * H, () => dl.check(d, []));
  assert.strictEqual(d.active, true);
  await at(6.2 * H, () => dl.check(d, []));
  assert.strictEqual(d.state, 'lost', 'po 6 h už ano');

  // qBittorrent odpovídá a torrent v něm není → ztraceno hned po 30 min
  const s2 = setup();
  s2.dl.ctx.qbit = { enabled: true, version: async () => 'v5', byHashes: async () => [] };
  s2.d.parts[0].downloadId = hash;
  await at(0.1 * H, () => s2.dl.check(s2.d, s2.rec({ downloadId: hash, size: 10 * GB, sizeleft: 5 * GB })));
  await at(0.7 * H, () => s2.dl.check(s2.d, []));
  assert.strictEqual(s2.d.state, 'lost');
});

test('qBittorrent nedostupný: torrent, který se ještě neobjevil ve frontě, se po 15 min neodepíše', async () => {
  const { dl, d } = setup();
  dl.ctx.qbit = { enabled: true, version: async () => { throw new Error('ECONNREFUSED'); }, byHashes: async () => { throw new Error('ECONNREFUSED'); } };
  await at(0.5 * H, () => dl.check(d, []));
  assert.strictEqual(d.active, true);
  dl.ctx.qbit = { enabled: true, version: async () => 'v5', byHashes: async () => [] };
  await at(0.6 * H, () => dl.check(d, []));
  assert.strictEqual(d.state, 'failed');
});

test('první stažení: náhrada za selhaný balík vrátí série, které nepokrývá', async () => {
  const { dl } = setup();
  const given = [];
  dl.ctx.firstGrab = { giveUp: async (job, why) => given.push({ keys: job.itemKeys, proposalId: job.proposalId, why }) };
  const d = { id: 'd9', first: true, proposalId: 'p9', itemKey: 'sonarr:3:1', itemKeys: ['sonarr:3:1', 'sonarr:3:2', 'sonarr:3:3'] };
  const rest = await dl.returnUncovered(d, { id: 'd10', itemKey: 'sonarr:3:1', itemKeys: ['sonarr:3:1'] }, 'mrtvý torrent');
  assert.deepStrictEqual(rest, ['sonarr:3:2', 'sonarr:3:3']);
  assert.deepStrictEqual(given[0].keys, ['sonarr:3:2', 'sonarr:3:3']);
  assert.strictEqual(given[0].proposalId, null, 'návrh náhrady se nesmí zavřít');
  assert.match(given[0].why, /mrtvý torrent/);
  given.length = 0;
  await dl.returnUncovered(d, { id: 'd11', itemKeys: d.itemKeys }, 'x');
  assert.deepStrictEqual(given, [], 'náhrada pokrývá všechno');
});

test('rychlé stažení naimportované mezi dvěma koly se neprohlásí za „neobjevil se v klientovi“', async () => {
  const { dl, d } = setup();
  const store = dl.ctx.store;
  store.s.items['radarr:7'] = { key: 'radarr:7', app: 'radarr', arrId: 7, current: { fileIds: [1] } };
  dl.changedTargets = async () => ({ 'radarr:7': { fileIds: [2], tier: 3, audio: 'cze/eng', quality: 'WEBDL-1080p', mediaInfoKnown: false } });
  await at(16 * 60e3, () => dl.check(d, []));
  assert.strictEqual(d.active, true, 'čeká na MediaInfo');
  assert.deepStrictEqual(store.s.ignoredGuids, {});
});

test('torrent, který je v qBittorrentu, ale Radarr ho ve frontě nevidí, se hned neblokuje', async () => {
  const { dl, d } = setup();
  dl.changedTargets = async () => ({});
  dl.clientState = async () => ({ present: true, message: 'v qBittorrentu' });
  await at(16 * 60e3, () => dl.check(d, []));
  assert.strictEqual(d.active, true);
  assert.deepStrictEqual(dl.ctx.store.s.ignoredGuids, {});
});

test('zrušené stahování se kontrolou neoživí ani nezablokuje', async () => {
  const { dl, d, rec } = setup();
  d.active = false;
  d.state = 'cancelled';
  await at(10 * H, () => dl.check(d, rec({ status: 'failed', trackedDownloadState: 'failed' })));
  assert.strictEqual(d.state, 'cancelled');
  assert.deepStrictEqual(dl.ctx.store.s.ignoredGuids, {});
});

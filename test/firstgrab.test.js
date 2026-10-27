const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { FirstGrab, missingMovies, missingSeasons, detectNew, evaluateFirst } = require('../src/firstgrab');
const { attachJobs } = require('../src/jobs');
const { Downloads } = require('../src/downloads');
const { DEFAULT_SETTINGS } = require('../src/store');
const W = require('../src/watch');

const q = (res) => ({ quality: { quality: { name: `WEBDL-${res}p`, resolution: res, source: 'web' } } });
const rel = (guid, title, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 50, leechers: 0, size: 4e9, protocol: 'torrent', ...q(1080), rejections: [], languages: [], ...extra });
const movie = (id, extra = {}) => ({ id, title: `Film ${id}`, year: 2026, monitored: true, hasFile: false, isAvailable: true, images: [], originalLanguage: { name: 'English' }, added: '2026-10-19T10:00:00Z', ...extra });

function storeOf(settings = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, firstGrab: true, ...settings },
    s: { items: {}, proposals: {}, downloads: {}, merges: {}, ignoredGuids: {}, watchSeries: {}, firstGrab: { known: {}, primed: {}, queue: [] } },
    save() {},
    log() {},
    countSearch() {},
  };
}

test('chybějící: jen monitorované, vydané a bez souboru; u seriálu série bez jediného souboru', () => {
  const m = missingMovies([movie(1), movie(2, { hasFile: true }), movie(3, { monitored: false }), movie(4, { isAvailable: false })]);
  assert.deepStrictEqual([...m.keys()], ['radarr:1']);
  const season = (n, files, aired, monitored = true) => ({ seasonNumber: n, monitored, statistics: { episodeFileCount: files, episodeCount: aired, totalEpisodeCount: 10 } });
  const s = missingSeasons([{ id: 7, title: 'Seriál', monitored: true, images: [], seasons: [season(0, 0, 3), season(1, 10, 10), season(2, 0, 10), season(3, 0, 0), season(4, 0, 5, false)] }]);
  assert.deepStrictEqual([...s.keys()], ['sonarr:7:2']);
  assert.strictEqual(s.get('sonarr:7:2').episodeCount, 10);
});

test('první průchod si jen zapamatuje, co chybí; nové až potom', () => {
  const fg = { known: {}, primed: {} };
  const items = {};
  assert.deepStrictEqual(detectNew(fg, 'radarr', missingMovies([movie(1)]), items), []);
  const fresh = detectNew(fg, 'radarr', missingMovies([movie(1), movie(2)]), items);
  assert.deepStrictEqual(fresh.map((x) => x.key), ['radarr:2']);
  // Pořád chybí → podruhé už ne
  assert.deepStrictEqual(detectNew(fg, 'radarr', missingMovies([movie(1), movie(2)]), items), []);
  // Stažený zmizí z paměti; když zase chybí (smazaný soubor) a v knihovně byl, nestahuje se
  detectNew(fg, 'radarr', missingMovies([movie(1)]), items);
  assert.ok(!fg.known['radarr:2']);
  items['radarr:2'] = { key: 'radarr:2', current: { tier: 3 } };
  assert.deepStrictEqual(detectNew(fg, 'radarr', missingMovies([movie(1), movie(2)]), items), []);
});

test('výběr: CZ + EN před EN 1080p, mrtvé a příliš velké pryč, „už ve frontě“ nevadí', () => {
  const store = storeOf();
  const item = { key: 'radarr:1', app: 'radarr', arrId: 1, origLang: 'en', missing: true, current: {} };
  const { candidates, stats } = evaluateFirst(item, [
    rel('en', 'Film.2026.1080p.WEB-DL.x264'),
    rel('czen', 'Film (2026)(CZ/EN)[720p]', { ...q(720), rejections: ['Release in queue already meets cutoff'] }),
    rel('dead', 'Film (2026)(CZ/EN)[1080p]', { seeders: 1 }),
    rel('big', 'Film (2026)(CZ/EN)[1080p] REMUX', { size: 80e9 }),
  ], { store });
  assert.deepStrictEqual(candidates.map((c) => c.guid), ['czen', 'en']);
  assert.strictEqual(candidates[0].kind, 'first');
  assert.strictEqual(stats.dead, 1);
  assert.strictEqual(stats.size, 1);
});

test('seriál: balík více sérií pokryje jen série, které se stahují poprvé', () => {
  const store = storeOf();
  const mk = (season) => ({ key: `sonarr:7:${season}`, app: 'sonarr', arrId: 7, season, origLang: 'en', missing: true, episodeCount: 8, current: {} });
  const item = mk(1);
  const { candidates } = evaluateFirst(item, [
    rel('pack', 'Seriál S01-S03 (CZ/EN)', { fullSeason: true, seasonNumber: 1, size: 20e9 }),
    rel('s1', 'Seriál S01 (CZ)', { fullSeason: true, seasonNumber: 1 }),
    rel('ep', 'Seriál S01E01 (CZ/EN)', { fullSeason: false, seasonNumber: 1 }),
  ], { store }, { siblings: { 2: mk(2) } });
  assert.deepStrictEqual(candidates.map((c) => c.guid), ['pack', 's1']);
  assert.deepStrictEqual(candidates[0].targetSeasons, [1, 2]);
  assert.deepStrictEqual(candidates[0].itemKeys, ['sonarr:7:1', 'sonarr:7:2']);
});

function setup({ history = [], queue = [], settings } = {}) {
  const store = storeOf(settings);
  const removed = [];
  const commands = [];
  const radarr = {
    enabled: true,
    get: async (path) => {
      if (path === '/history/movie') return history;
      if (path === '/movie/1') return { id: 1, hasFile: false };
      throw new Error(`neočekávané ${path}`);
    },
    grab: async () => { history.unshift({ downloadId: 'OURS', sourceTitle: 'Film (2026)(CZ/EN)[1080p]', date: new Date().toISOString() }); },
    queue: async () => queue,
    removeFromQueue: async (id, opts) => {
      removed.push({ id, ...opts });
      const i = queue.findIndex((r) => r.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    searchReleases: async () => [rel('czen', 'Film (2026)(CZ/EN)[1080p]'), rel('en', 'Film.2026.1080p.WEB-DL')],
    command: async (c) => { commands.push(c); },
  };
  const ctx = { store, radarr, sonarr: { enabled: false }, notify: { download: async () => {} }, searcher: { enqueue() {} }, merger: { active: () => [] } };
  ctx.downloads = new Downloads(ctx);
  attachJobs(ctx);
  ctx.firstGrab = new FirstGrab(ctx);
  ctx.firstGrab.add(missingMovies([movie(1)]).get('radarr:1'));
  return { ctx, store, removed, commands, queue };
}

test('nový film: Updaterr stáhne svůj výběr a zruší, co mezitím stáhl Radarr', async () => {
  const since = new Date().toISOString();
  const { ctx, store, removed, queue } = setup({
    history: [{ downloadId: 'RADARR', sourceTitle: 'Film.2026.1080p.WEB-DL', date: since }],
    queue: [{ id: 10, movieId: 1, downloadId: 'RADARR', title: 'Film.2026.1080p.WEB-DL', size: 4e9, sizeleft: 3e9 }],
  });
  await ctx.firstGrab.tick();
  const d = Object.values(store.s.downloads)[0];
  assert.ok(d?.first);
  assert.strictEqual(d.title, 'Film (2026)(CZ/EN)[1080p]');
  assert.strictEqual(d.parts[0].downloadId, 'OURS', 'vlastní torrent poznaný podle historie');
  assert.deepStrictEqual(removed, [{ id: 10, blocklist: false, removeFromClient: true }]);
  assert.deepStrictEqual(d.cancelledForeign, ['Film.2026.1080p.WEB-DL']);
  // Vlastní stažení ve frontě se nikdy neruší
  assert.strictEqual(queue.length, 0, 'cizí stažení je z fronty pryč');
  queue.push({ id: 11, movieId: 1, downloadId: 'OURS', title: 'jiny nazev torrentu', size: 4e9, sizeleft: 4e9 });
  const left = await ctx.firstGrab.cancelForeign(d, queue);
  assert.deepStrictEqual(left.map((r) => r.id), [11]);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(store.s.firstGrab.queue.length, 0);
});

test('Radarr už stahuje stejný release → nechá se mu, nic se nestahuje dvakrát', async () => {
  const { ctx, store, removed } = setup({
    history: [{ downloadId: 'RADARR', sourceTitle: 'Film (2026)(CZ/EN)[1080p]', date: new Date().toISOString() }],
    queue: [{ id: 10, movieId: 1, downloadId: 'RADARR', title: 'Film', size: 4e9, sizeleft: 3e9 }],
  });
  await ctx.firstGrab.tick();
  assert.strictEqual(Object.keys(store.s.downloads).length, 0);
  assert.strictEqual(removed.length, 0);
  assert.ok(!store.s.items['radarr:1'], 'chybějící položka uvolněna');
});

test('nic vhodného → hledání v Radarru (když sám nic nestahuje)', async () => {
  const { ctx, store, commands } = setup();
  ctx.radarr.searchReleases = async () => [rel('dead', 'Film (2026)(CZ/EN)[1080p]', { seeders: 0 })];
  await ctx.firstGrab.tick();
  assert.deepStrictEqual(commands, [{ name: 'MoviesSearch', movieIds: [1] }]);
  assert.ok(!store.s.items['radarr:1']);
});

test('vypnuté zrušení: cizí stažení zůstane', async () => {
  const { ctx, store, removed } = setup({
    settings: { firstGrabCancelArr: false },
    history: [{ downloadId: 'RADARR', sourceTitle: 'Film.2026.1080p.WEB-DL', date: new Date().toISOString() }],
    queue: [{ id: 10, movieId: 1, downloadId: 'RADARR', title: 'x', size: 4e9, sizeleft: 3e9 }],
  });
  await ctx.firstGrab.tick();
  assert.strictEqual(Object.values(store.s.downloads).length, 1);
  assert.strictEqual(removed.length, 0);
});

test('hotové první stažení zapne hlídání podle autoWatchNew', () => {
  const store = storeOf({ autoWatchNew: 'auto' });
  const film = { key: 'radarr:1', app: 'radarr', arrId: 1, current: { tier: 1 } };
  const s2 = { key: 'sonarr:7:2', app: 'sonarr', arrId: 7, season: 2, current: { tier: 1 } };
  store.s.items = { [film.key]: film, [s2.key]: s2, 'sonarr:7:1': { key: 'sonarr:7:1', app: 'sonarr', arrId: 7, season: 1, current: { tier: 3 } } };
  assert.deepStrictEqual(W.watchFirst(store, [film, s2]).map((x) => x.key), ['radarr:1'], 'nová série známého seriálu ne');
  assert.strictEqual(film.watch.origin, 'new');
});

test('mrtvý torrent prvního stažení → další kandidát, nakonec hledání v Radarru', async () => {
  const { ctx, store, commands, queue } = setup({ settings: { maxRetries: 2 } });
  await ctx.firstGrab.tick();
  const d1 = Object.values(store.s.downloads)[0];
  queue.push({ id: 20, movieId: 1, downloadId: 'OURS', title: 'x', size: 4e9, sizeleft: 4e9, status: 'failed' });
  await ctx.downloads.tick();
  const d2 = Object.values(store.s.downloads).find((x) => x.retryOf === d1.id);
  assert.ok(d2?.first, 'náhrada je taky první stažení');
  assert.strictEqual(d2.title, 'Film.2026.1080p.WEB-DL');
  assert.ok(store.s.items['radarr:1']?.missing);
  // Druhý pokus taky selže → limit pokusů → Radarr převezme
  queue.splice(0, queue.length, { id: 21, movieId: 1, downloadId: 'OURS', title: 'x', size: 4e9, sizeleft: 4e9, status: 'failed' });
  d2.parts[0].downloadId = 'OURS';
  await ctx.downloads.tick();
  assert.strictEqual(d2.state, 'failed');
  assert.ok(!store.s.items['radarr:1'], 'položka uvolněna');
  assert.deepStrictEqual(commands, [{ name: 'MoviesSearch', movieIds: [1] }]);
});

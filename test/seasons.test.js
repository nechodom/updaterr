const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const S = require('../src/seasons');
const { evaluateReleases, evaluateEpisodeSet, rejectProposal, expireStaleProposals } = require('../src/search');
const { Downloads } = require('../src/downloads');
const { DEFAULT_SETTINGS } = require('../src/store');

test('rozsahy sérií v názvu', () => {
  const cases = [
    ['Mr. Robot S01-S04 (CZ/EN)[1080p][WebRip]', [1, 2, 3, 4]],
    ['Peaky Blinders S01-S02 (CZ) / S03-S06 (EN)', [1, 2, 3, 4, 5, 6]],
    ['Mr.Robot.S01-4.S01-04.COMPLETE.1080p.BluRay.WEB.10bit.DD5.1', [1, 2, 3, 4]],
    ['Mr. Robot (S01 - S04)(2015 - 2019)(EN, GE, PL, FR, CZ)', [1, 2, 3, 4]],
    ['Mr Robot S01 S04 1080p BluRay REMUX', [1, 2, 3, 4]],             // pomlčku indexer zahodil
    ['Mr.Robot.S01.S02.S03.Complete.1080p.AMZN.WEB-DL', [1, 2, 3]],
    ['Mr Robot All Seasons S01 S02 S03 S04', [1, 2, 3, 4]],
    ['Mr.Robot.S01.S01.COMPLETE.1080p.10bit.BluRay', [1]],             // duplicitní zápis jedné série
    ['Mr. Robot SEASON 1 4 S01 S04 COMPLETE 720p 10bit', [1, 2, 3, 4]],
    ['The Office Seasons 1 to 9 720p', [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['Comeback 1.-2. série (2008) CZ', [1, 2]],
    ['Most! 1. série 1080p', [1]],
    ['Mr. Robot (2015) Season 01 S01 (1080p Bluray x265 HEVC 10bit)', [1]],
    ['Show Season 2 10bit 1080p', [2]],                                // "10bit" není série
    ['Show.S01-1080p.WEB', [1]],                                       // "-1080p" není rozsah
    ['Mr.Robot S01E01 (2015)(CZ/EN)[720pHD]', [1]],
    ['Pelíšky (1999)[1080p]', []],
  ];
  for (const [t, exp] of cases) assert.deepStrictEqual(S.parseSeasons(t), exp, t);
});

test('části názvu s vlastním jazykem', () => {
  assert.deepStrictEqual(S.seasonSegments('Peaky Blinders S01-S02 (CZ) / S03-S06 (EN)'), [
    { text: 'Peaky Blinders S01-S02 (CZ)', seasons: [1, 2] },
    { text: 'S03-S06 (EN)', seasons: [3, 4, 5, 6] },
  ]);
  // "(CZ/EN)" se nedělí
  assert.deepStrictEqual(S.seasonCoverage('Mr. Robot S01-S04 (CZ/EN)[1080p]').segments, []);
  assert.deepStrictEqual(S.seasonCoverage('Dark S01-S03 (CZ/EN) + Extras').segments, []);
  assert.strictEqual(S.formatSeasons([1, 2, 3]), '01.–03.');
  assert.strictEqual(S.formatSeasons([1, 3]), '01., 03.');
  assert.strictEqual(S.formatSeasons([2]), '02.');
});

// --- vyhodnocení ----------------------------------------------------------------------

const season = (n, tier, extra = {}) => ({
  key: `sonarr:10:${n}`, app: 'sonarr', arrId: 10, season: n, title: 'Mr. Robot', origLang: 'en', episodeCount: 10,
  current: { tier, res: 1080, qrank: 32, audio: tier === 3 ? 'eng/cze' : 'eng', audioSource: 'mediainfo', quality: 'HDTV-1080p', files: 10, fileIds: [n * 100 + 1, n * 100 + 2] },
  ...extra,
});
const rel = (guid, title, extra = {}) => ({
  guid, indexerId: 4, indexer: 'SkTorrent (Prowlarr)', title, seeders: 30, leechers: 1, size: 30e9, protocol: 'torrent',
  quality: { quality: { name: 'WEBRip-1080p', resolution: 1080, source: 'webRip' } }, languages: [{ id: 25, name: 'Czech' }],
  fullSeason: true, seasonNumber: 1, rejections: ['Multi-season releases are not supported', 'Existing file meets cutoff: HDTV-1080p'], ...extra,
});
const mkCtx = (settings = {}) => ({ store: { settings: { ...DEFAULT_SETTINGS, ...settings }, s: { ignoredGuids: {}, groupSnooze: {}, items: {}, proposals: {}, downloads: {} } } });

test('balík více sérií → jeden kandidát pro všechny lepší série', () => {
  const ctx = mkCtx();
  const s1 = season(1, 1);
  const siblings = { 2: season(2, 1), 3: season(3, 2), 4: season(4, 3) };
  const releases = [
    rel('multi', 'Mr. Robot S01-S04 (CZ/EN)[1080p][WebRip]'),
    rel('single', 'Mr. Robot S01 (CZ)[1080p]', { rejections: [] }),
    rel('unparsed', 'Mr. Robot S01-S04 (CZ/EN)', { rejections: ['Unable to parse release'] }),
    rel('nos1', 'Mr. Robot S02-S04 (CZ/EN)[1080p]', { seasonNumber: 2 }),
  ];
  const { candidates, multi } = evaluateReleases(s1, releases, ctx, { siblings });
  assert.deepStrictEqual(candidates.map((c) => c.guid), ['single']);
  assert.deepStrictEqual(multi.map((c) => c.guid), ['multi']);
  const m = multi[0];
  assert.deepStrictEqual(m.seasons, [1, 2, 3, 4]);
  assert.deepStrictEqual(m.targetSeasons, [1, 2, 3], 'S04 už CZ+EN má');
  assert.deepStrictEqual(m.itemKeys, ['sonarr:10:1', 'sonarr:10:2', 'sonarr:10:3']);
  assert.strictEqual(m.tier, 3);
  assert.ok(m.arr.quality && m.arr.languages, 'pro override je potřeba kvalita a jazyky');

  // vypnuto v nastavení → nic
  assert.strictEqual(evaluateReleases(s1, releases, mkCtx({ multiSeasonPacks: false }), { siblings }).multi.length, 0);
});

test('různý jazyk pro různé série v jednom balíku', () => {
  const ctx = mkCtx();
  const s1 = { ...season(1, 1), title: 'Peaky Blinders' };
  const siblings = Object.fromEntries([2, 3, 4, 5, 6].map((n) => [n, season(n, 1)]));
  const r = rel('pb', 'Peaky Blinders S01-S02 (CZ) / S03-S06 (EN)', { size: 50e9 });
  const { multi } = evaluateReleases(s1, [r], ctx, { siblings });
  assert.strictEqual(multi.length, 1);
  assert.deepStrictEqual(multi[0].targetSeasons, [1, 2], 'S03–S06 jsou EN jako teď');
  assert.deepStrictEqual(multi[0].seasonTiers, { 1: 2, 2: 2, 3: 1, 4: 1, 5: 1, 6: 1 });
  assert.strictEqual(multi[0].tier, 2);

  // hledaná série v balíku nezlepší → kandidát patří jiné sérii
  const s4 = { ...season(4, 1), title: 'Peaky Blinders' };
  const sib4 = Object.fromEntries([1, 2, 3, 5, 6].map((n) => [n, season(n, 1)]));
  assert.strictEqual(evaluateReleases(s4, [r], ctx, { siblings: sib4 }).multi.length, 0);
});

test('velikost balíku se počítá na epizody všech sérií', () => {
  const ctx = mkCtx({ maxEpisodeSizeGB: 2 });
  const s1 = season(1, 1);
  const siblings = { 2: season(2, 1), 3: season(3, 1), 4: season(4, 1) };
  const ok = rel('ok', 'Mr. Robot S01-S04 (CZ/EN)[1080p]', { size: 40 * 1024 ** 3 });   // 1 GB/epizodu
  const big = rel('big', 'Mr. Robot S01-S04 (CZ/EN)[1080p] REMUX', { size: 400 * 1024 ** 3 });
  assert.deepStrictEqual(evaluateReleases(s1, [ok, big], ctx, { siblings }).multi.map((c) => c.guid), ['ok']);
});

test('sada epizod, když balík není', () => {
  const ctx = mkCtx();
  const item = season(1, 1);
  const file = (id, audio) => ({ id, mediaInfo: { audioLanguages: audio }, quality: { quality: { name: 'HDTV-1080p', resolution: 1080, source: 'television' } } });
  const files = { 1: file(1, 'eng'), 2: file(2, 'eng'), 3: file(3, 'eng/cze') };
  const episodes = [
    { id: 588, seasonNumber: 1, episodeNumber: 1, hasFile: true, episodeFileId: 1 },
    { id: 589, seasonNumber: 1, episodeNumber: 2, hasFile: true, episodeFileId: 2 },
    { id: 590, seasonNumber: 1, episodeNumber: 3, hasFile: true, episodeFileId: 3 },
    { id: 591, seasonNumber: 1, episodeNumber: 4, hasFile: false, episodeFileId: 0 },
  ];
  const ep = (guid, n, title, extra = {}) => rel(guid, title, {
    fullSeason: false, size: 2e9, rejections: ['Existing file meets cutoff: HDTV-1080p'],
    quality: { quality: { name: 'Unknown', resolution: 0, source: 'unknown' } },
    mappedSeasonNumber: 1, mappedEpisodeInfo: [].concat(n).map((x) => ({ id: 587 + x, seasonNumber: 1, episodeNumber: x })), ...extra,
  });
  const releases = [
    ep('e1', 1, 'Mr.Robot S01E01 (2015)(CZ/EN)[1080p]'),
    ep('e1b', 1, 'Mr.Robot S01E01 (2015)(CZ/EN)[1080p] dead', { seeders: 0 }),
    ep('e2', 2, 'Mr.Robot S01E02 (2015)(CZ/EN)[720pHD]'),
  ];
  const set = evaluateEpisodeSet(item, releases, ctx, { episodes, files });
  assert.ok(set, 'E01 a E02 mají živý CZ+EN release, E03 už CZ+EN má');
  assert.strictEqual(set.set, true);
  assert.strictEqual(set.tier, 3);
  assert.deepStrictEqual(set.parts.map((p) => p.guid), ['e1', 'e2']);
  assert.deepStrictEqual(set.parts.map((p) => p.episodeIds), [[588], [589]]);
  assert.strictEqual(set.res, 720, 'rozlišení z názvu, když ho Sonarr nezná');
  assert.ok(set.warnings.some((w) => w.includes('nižší')));

  // E02 bez lepšího releasu → žádná sada
  assert.strictEqual(evaluateEpisodeSet(item, releases.slice(0, 2), ctx, { episodes, files }), null);
  // jeden release pro dvě epizody (S01E01-02)
  const both = evaluateEpisodeSet(item, [ep('e12', [1, 2], 'Mr.Robot S01E01-02 (CZ/EN)[1080p]')], ctx, { episodes, files });
  assert.deepStrictEqual(both.parts.map((p) => p.episodeIds), [[588, 589]]);
});

// --- stažení ------------------------------------------------------------------------

function fakeCtx() {
  const calls = [];
  const items = Object.fromEntries([1, 2, 3, 4].map((n) => { const s = season(n, n === 4 ? 3 : 1); return [s.key, s]; }));
  const store = {
    settings: { ...DEFAULT_SETTINGS }, s: { items, proposals: {}, downloads: {}, ignoredGuids: {}, groupSnooze: {} },
    log: () => {}, save: () => {}, countSearch: () => {},
  };
  const sonarr = {
    get: async (path, q) => {
      calls.push(['GET', path, q]);
      if (path === '/episode') return [1, 2, 3, 4].flatMap((s) => [1, 2].map((e) => ({ id: s * 1000 + e, seasonNumber: s, episodeNumber: e })));
      throw new Error('unexpected ' + path);
    },
    grab: async (guid, indexerId) => calls.push(['grab', guid, indexerId]),
    grabOverride: async (body) => calls.push(['override', body]),
    manualImportList: async () => [
      { path: '/d/S01E01.mkv', series: { id: 10 }, episodes: [{ id: 1001, seasonNumber: 1 }], rejections: [{ reason: 'Not an upgrade for existing episode file(s)' }], quality: {}, languages: [] },
      { path: '/d/S04E01.mkv', series: { id: 10 }, episodes: [{ id: 4001, seasonNumber: 4 }], rejections: [{ reason: 'Not an upgrade for existing episode file(s)' }], quality: {}, languages: [] },
      { path: '/d/sample.mkv', series: { id: 10 }, episodes: [{ id: 1002, seasonNumber: 1 }], rejections: [{ reason: 'Sample' }], quality: {}, languages: [] },
    ],
    command: async (body) => calls.push(['command', body]),
  };
  const ctx = { store, sonarr, radarr: {}, notify: { download: async () => {}, proposal: async () => {} }, searcher: { enqueue: () => {} } };
  ctx.downloads = new Downloads(ctx);
  ctx.busyKeys = () => new Set(ctx.downloads.active().flatMap((d) => d.itemKeys || [d.itemKey]));
  ctx.grab = (...a) => ctx.downloads.grab(...a);
  return { ctx, calls, store };
}

test('stažení balíku více sérií přes Sonarr override a import jen nahrazovaných sérií', async () => {
  const { ctx, calls, store } = fakeCtx();
  const cand = {
    guid: 'g1', indexerId: 4, indexer: 'SkTorrent', title: 'Mr. Robot S01-S04 (CZ/EN)[1080p][WebRip]', size: 4e10, seeders: 30, tier: 3,
    seasons: [1, 2, 3, 4], targetSeasons: [1, 2, 3], itemKeys: ['sonarr:10:1', 'sonarr:10:2', 'sonarr:10:3'], searchSeason: 1,
    arr: { quality: { quality: { id: 15, name: 'WEBRip-1080p' } }, languages: [{ id: 25, name: 'Czech' }] }, searchedAt: Date.now(),
  };
  const single = { id: 'p0', itemKey: 'sonarr:10:2', status: 'pending', candidates: [] };
  const p = { id: 'p1', groupKey: 'sonarr:10:multi', itemKey: 'sonarr:10:1', itemKeys: cand.itemKeys, status: 'pending', label: 'x', candidates: [cand] };
  store.s.proposals = { p0: single, p1: p };

  const d = await ctx.downloads.grab('p1', 0);
  const ov = calls.find((c) => c[0] === 'override')[1];
  assert.strictEqual(ov.seriesId, 10);
  assert.deepStrictEqual(ov.episodeIds, [1001, 1002, 2001, 2002, 3001, 3002], 'jen epizody S01–S03');
  assert.deepStrictEqual(ov.quality, cand.arr.quality);
  assert.deepStrictEqual(d.itemKeys, cand.itemKeys);
  assert.deepStrictEqual(d.seasons, [1, 2, 3]);
  assert.strictEqual(d.label, 'Mr. Robot – 01.–03. série');
  assert.strictEqual(single.status, 'expired', 'samostatný návrh S02 nahradil balík');
  assert.strictEqual(p.status, 'grabbed');
  await assert.rejects(() => { store.s.proposals.p2 = { id: 'p2', itemKey: 'sonarr:10:3', status: 'pending', candidates: [{ guid: 'z', searchedAt: Date.now() }] }; return ctx.downloads.grab('p2', 0); }, /už jedno stahování běží/);

  // Sonarr import zablokoval → vynucený import jen souborů ze S01–S03
  d.parts[0].downloadId = 'HASH';
  await ctx.downloads.forceImport(d, d.parts[0]);
  const cmd = calls.find((c) => c[0] === 'command')[1];
  assert.strictEqual(cmd.name, 'ManualImport');
  assert.deepStrictEqual(cmd.files.map((f) => f.path), ['/d/S01E01.mkv']);
  assert.deepStrictEqual(cmd.files[0].episodeIds, [1001]);
});

test('odmítnutí balíku více sérií neignoruje samotné série', () => {
  const ctx = mkCtx();
  ctx.store.save = () => {};
  ctx.store.s.items['sonarr:10:1'] = season(1, 1);
  const p = { id: 'p', groupKey: 'sonarr:10:multi', itemKey: 'sonarr:10:1', status: 'pending', candidates: [] };
  rejectProposal(ctx, p, 30);
  assert.strictEqual(p.status, 'rejected');
  assert.ok(ctx.store.s.groupSnooze['sonarr:10:multi']);
  assert.strictEqual(ctx.store.s.items['sonarr:10:1'].ignoredUntil, undefined);
});

test('sada epizod – jen hledané jazyky', () => {
  const ctx = mkCtx();
  ctx.store.s.wantLangs = { 'sonarr:1': ['pri'] };
  const item = { ...season(1, 1), arrId: 1 };
  const file = (id, audio) => ({ id, mediaInfo: { audioLanguages: audio }, quality: { quality: { name: 'HDTV-1080p', resolution: 1080, source: 'television' } } });
  const files = { 1: file(1, 'eng'), 2: file(2, 'cze') };
  const episodes = [
    { id: 588, seasonNumber: 1, episodeNumber: 1, hasFile: true, episodeFileId: 1 },
    { id: 589, seasonNumber: 1, episodeNumber: 2, hasFile: true, episodeFileId: 2 },
  ];
  const ep = (guid, n, title) => rel(guid, title, {
    fullSeason: false, size: 2e9, rejections: [], mappedSeasonNumber: 1, mappedEpisodeInfo: [{ id: 587 + n, seasonNumber: 1, episodeNumber: n }],
  });
  const set = evaluateEpisodeSet(item, [ep('e1', 1, 'Show S01E01 (CZ)[1080p]'), ep('e2', 2, 'Show S01E02 (CZ/EN)[1080p]')], ctx, { episodes, files });
  assert.deepStrictEqual(set.parts.map((p) => p.guid), ['e1'], 'E02 už CZ má, CZ + EN nepotřebuje');
  assert.strictEqual(set.tier, 2);
  assert.strictEqual(set.notes[0], 'epizody E01 · E02 už CZ má');
});

test('sada epizod ve vycházející sérii: poznámka, kolik epizod v knihovně je', () => {
  const ctx = mkCtx();
  const item = { ...season(4, 1), episodeCount: 10 };
  const files = { 1: { id: 1, mediaInfo: { audioLanguages: 'eng' }, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080, source: 'web' } } } };
  const episodes = [
    { id: 9760, seasonNumber: 4, episodeNumber: 1, hasFile: true, episodeFileId: 1 },
    { id: 9761, seasonNumber: 4, episodeNumber: 2, hasFile: false, episodeFileId: 0 },
  ];
  const r = rel('e1', 'Tulsa King S04E01 (CZ/EN)[1080p][WEB-DL][HEVC]', {
    fullSeason: false, size: 1.5e9, rejections: [], seasonNumber: 4, mappedSeasonNumber: 4, mappedEpisodeInfo: [{ id: 9760, seasonNumber: 4, episodeNumber: 1 }],
  });
  const set = evaluateEpisodeSet(item, [r], ctx, { episodes, files });
  assert.deepStrictEqual(set.notes, ['epizody E01', 'v knihovně 1 z 10 epizod série – ostatní sada neřeší']);
});

test('změna souborů v knihovně zneplatní čekající návrh a spustí nové hledání', () => {
  const ctx = mkCtx();
  const queued = [];
  Object.assign(ctx, { searcher: { enqueue: (k) => queued.push(k) }, busyKeys: () => new Set() });
  ctx.store.log = () => {};
  const s4 = season(4, 1);
  const s5 = season(5, 1);
  ctx.store.s.items = { [s4.key]: s4, [s5.key]: s5 };
  const pend = (id, extra) => ({ id, status: 'pending', label: id, candidates: [], ...extra });
  ctx.store.s.proposals = {
    same: pend('same', { itemKey: s5.key, current: { ...s5.current } }),
    set: pend('set', { itemKey: s4.key, current: { ...s4.current, fileIds: [401] } }),
    first: pend('first', { first: true, itemKey: s4.key, current: { fileIds: [] } }),
  };
  assert.strictEqual(expireStaleProposals(ctx), 1);
  assert.strictEqual(ctx.store.s.proposals.set.status, 'expired', 'přibyla epizoda 402');
  assert.strictEqual(ctx.store.s.proposals.same.status, 'pending');
  assert.strictEqual(ctx.store.s.proposals.first.status, 'pending', 'první stažení řeší firstgrab');
  assert.deepStrictEqual(queued, [s4.key]);

  // balík více sérií: změna v kterékoli z nich
  ctx.store.s.proposals = { multi: pend('multi', { groupKey: 'sonarr:10:multi', itemKey: s4.key, itemKeys: [s4.key, s5.key], current: { fileIds: [...s4.current.fileIds, ...s5.current.fileIds] } }) };
  assert.strictEqual(expireStaleProposals(ctx), 0);
  s5.current = { ...s5.current, fileIds: [501, 503] };
  assert.strictEqual(expireStaleProposals(ctx), 1);
});

test('vynucený import filmu s nerozparsovatelným názvem – kvalita a jazyky z release', async () => {
  const calls = [];
  const quality = { quality: { id: 9, name: 'HDTV-1080p' }, revision: { version: 1 } };
  const languages = [{ id: 25, name: 'Czech' }, { id: 1, name: 'English' }];
  const radarr = {
    manualImportList: async () => [
      { path: '/d/Barbie (20023) [1080p].mkv', size: 8e9, movie: { id: 534 }, rejections: [{ reason: 'Unable to parse file', type: 'permanent' }] },
      { path: '/d/sample (20023).mkv', size: 5e7, movie: { id: 534 }, rejections: [{ reason: 'Unable to parse file', type: 'permanent' }] },
      { path: '/d/Barbie (20023).nfo', size: 1e3, movie: { id: 534 }, rejections: [{ reason: 'Unable to parse file', type: 'permanent' }] },
    ],
    command: async (body) => calls.push(body),
  };
  const ctx = { store: { settings: { ...DEFAULT_SETTINGS }, s: { items: {} }, log: () => {} }, radarr, sonarr: {}, notify: { download: async () => {} } };
  const dl = new Downloads(ctx);
  const d = { app: 'radarr', arrId: 534, label: 'Barbie (2023)', itemKey: 'radarr:534', candidate: { arr: { quality, languages } } };
  const part = { downloadId: 'HASH' };
  await dl.forceImport(d, part);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].files.map((f) => f.path), ['/d/Barbie (20023) [1080p].mkv'], 'jen hlavní video, ne sample/nfo');
  assert.deepStrictEqual(calls[0].files[0].quality, quality);
  assert.deepStrictEqual(calls[0].files[0].languages, languages);
  assert.strictEqual(calls[0].files[0].movieId, 534);

  // jiný film → nic se nevynutí
  calls.length = 0;
  await dl.forceImport({ ...d, arrId: 1 }, { downloadId: 'HASH' });
  assert.strictEqual(calls.length, 0);
});

test('dvouciferné číslo série není rozsah ("Season 14" ≠ 1–4), kanály zvuku ani rok nejsou série', () => {
  const cases = {
    'South Park Season 14 (CZ/EN)': [14],
    'The Simpsons Season 28': [28],
    'The Grand Tour Season 03 1080p': [3],
    'Season 02': [2],
    'The Four Seasons 2025 S01': [1],
    'Show Season 1 5.1 1080p': [1],
    'Season 1-4': [1, 2, 3, 4],
    'Season.1.4': [1, 2, 3, 4],
    'Seasons 1 to 4': [1, 2, 3, 4],
  };
  for (const [t, want] of Object.entries(cases)) assert.deepStrictEqual(S.parseSeasons(t), want, t);
});

test('"řada" s háčkem na začátku slova a anglické "Series N"', () => {
  assert.deepStrictEqual(S.parseSeasons('Přátelé řada 2'), [2]);
  assert.deepStrictEqual(S.parseSeasons('Řada 1-3'), [1, 2, 3]);
  assert.deepStrictEqual(S.parseSeasons('Show Series 3 1080p'), [3]);
});

test('počet epizod za číslem série není rozsah ("Season 1 25 Episodes")', () => {
  assert.deepStrictEqual(S.parseSeasons('Seinfeld Season 1 25 Episodes 1080p'), [1]);
  assert.deepStrictEqual(S.parseSeasons('Série 1 10 dílů'), [1]);
  assert.deepStrictEqual(S.parseSeasons('Season 1-4'), [1, 2, 3, 4]);
  assert.deepStrictEqual(S.parseSeasons('Season.1.4.'), [1, 2, 3, 4]);
});

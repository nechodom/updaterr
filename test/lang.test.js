const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const L = require('../src/lang');
const { evaluateReleases } = require('../src/search');
const { DEFAULT_SETTINGS } = require('../src/store');

const tier = (title, opts) => L.tierOf(L.evaluateRelease(title, opts), opts?.origLang);

test('názvy releasů → jazyk', () => {
  const cases = [
    ['Moana (2026)(CZ/EN)[1080p]', 3],
    ['Toy Story 5: Příběh hraček (2026)(CZ/SK/EN)[1080p]', 3],
    ['Moana.2026.Hybrid.2160p.UHD.Blu-ray.Remux.DV.HDR10+.HEVC.DDP.7.1.CZ.SK.TrueHD.Atmos.7.1.EN-JOsHUA', 3],
    ['Avengers Infinity War 2018 2160p BluRay x265 10bit HDR Cz Eng DTS-HD MA TrueHD 7.1 Atmos-Angels', 3],
    ['Avengers.Endgame.2019.IMAX.2160p.WEB-DL.DoVi.MultiDub.CZ-LiNuXSuCkS', 3],
    ['Avengers: Infinity War (2018)(CZ)[1080p]', 2],
    ['The End of Oak Street (2026)(CZ/SK)[1080p]', 2],
    ['Avengers.Endgame.2019.720p.BluRay.DD5.1.x264-LoRD.CZ-FTU', 2],
    ['Duna 2021 CZ dabing 1080p', 2],
    ['Avengers.Endgame.2019.2160p.UHD.BluRay.x265-TERMiNAL + CZtitulky', 1],
    ['Duna 2021 1080p CZ titulky', 1],
    ['Duna.2021.1080p.BluRay.titulky.CZ.EN', 1],
    ['Napoleon (2023)(EN)[WEBrip][1080p]', 1],
    ['Avengers.Endgame.2019.1080p.BluRay.x264-SPARKS', 1],
    ['Napoleon Director s Cut 2023 1080p H265 ITA ENG AC3 5 1 SUB ITA ENG UBi', 1],
  ];
  for (const [t, exp] of cases) assert.strictEqual(tier(t, { origLang: 'en' }), exp, t);
});

test('česká a cizojazyčná díla', () => {
  assert.strictEqual(tier('Pelíšky (1999)[1080p]', { origLang: 'cs' }), 3, 'český originál bez značky = CZ = cíl');
  assert.strictEqual(tier('Parasite.2019.1080p.BluRay', { origLang: 'other' }), 0);
  assert.strictEqual(tier('Parasite (2019)(CZ)[1080p]', { origLang: 'other' }), 2);
});

test('mediainfo', () => {
  assert.strictEqual(L.tierOf(L.audioFromMediaInfo('cze/eng')), 3);
  assert.strictEqual(L.tierOf(L.audioFromMediaInfo('Slovak/Czech')), 2);
  assert.strictEqual(L.tierOf(L.audioFromMediaInfo('eng/spa')), 1);
  assert.strictEqual(L.audioFromMediaInfo('und').known, false);
});

test('vyhodnocení kandidátů', () => {
  const ctx = { store: { settings: { ...DEFAULT_SETTINGS }, s: { ignoredGuids: { dead: 1 } } } };
  const item = { app: 'radarr', origLang: 'en', current: { tier: 1, res: 1080, qrank: 34, audioSource: 'mediainfo' } };
  const q = (res, source = 'webdl') => ({ quality: { name: `X-${res}p`, resolution: res, source } });
  const rel = (guid, title, seeders, res = 1080, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders, leechers: 0, size: 4e9, protocol: 'torrent', ...q(res), rejections: [], languages: [], ...extra });
  const releases = [
    rel('a', 'Film (2020)(CZ/EN)[1080p]', 50),
    rel('b', 'Film (2020)(CZ)[1080p]', 200),
    rel('c', 'Film (2020)(CZ/EN)[1080p]', 1),                       // mrtvý
    rel('d', 'Film (2020)(CZ/EN)[1080p][CAM]', 99),                 // CAM
    rel('e', 'Film.2020.1080p.WEB-DL', 500),                         // stejný jazyk, stejná kvalita
    rel('f', 'Film (2020)(CZ/EN)[2160p]', 80, 2160),                 // nad max. rozlišení
    rel('dead', 'Film (2020)(CZ/EN)[720p]', 80, 720),                // ignorovaný guid
    rel('g', 'Film (2020)(CZ/EN)[720p]', 80, 720),                   // nižší rozlišení – s varováním
    rel('h', 'Jiny Film (2020)(CZ/EN)[1080p]', 80, 1080, { rejections: ['Unknown Movie. Unable to match to correct movie using release title.'] }),
  ];
  const { candidates } = evaluateReleases(item, releases, ctx);
  assert.deepStrictEqual(candidates.map((c) => c.guid), ['a', 'g', 'b']);
  assert.ok(candidates[1].warnings.some((w) => w.includes('nižší')));
});

test('varování „odhadnutý z názvu“ jen u odhadu, ne u ověření poslechem', () => {
  const ctx = { store: { settings: { ...DEFAULT_SETTINGS }, s: { ignoredGuids: {} } } };
  const rel = { guid: 'a', indexerId: 1, indexer: 'SkTorrent', title: 'Film (2020)(CZ)[WEB-DL][1080p]', seeders: 119, leechers: 0, size: 4e9, protocol: 'torrent', quality: { quality: { name: 'WEBDL-1080p', resolution: 1080, source: 'webdl' } }, rejections: [], languages: [] };
  const warned = (audioSource) => {
    const item = { app: 'radarr', origLang: 'en', current: { tier: 1, res: 1080, qrank: 33, audioSource } };
    const { candidates } = evaluateReleases(item, [rel], ctx);
    assert.strictEqual(candidates.length, 1);
    return candidates[0].warnings.some((w) => w.includes('odhadnutý z názvu'));
  };
  assert.strictEqual(warned('nazev'), true);
  assert.strictEqual(warned('poslech'), false);
  assert.strictEqual(warned('mediainfo'), false);
});

test('hledané jazyky – úroveň z pohledu vybraných jazyků', () => {
  assert.strictEqual(L.normWant(['pri', 'sec']), null, 'oba = výchozí');
  assert.strictEqual(L.normWant([]), null);
  assert.deepStrictEqual(L.normWant(['sec', 'xx', 'pri', 'pri']), null);
  assert.deepStrictEqual(L.normWant(['pri']), ['pri']);
  assert.strictEqual(L.wantScore(2, null), 2);
  assert.deepStrictEqual([0, 1, 2, 3].map((t) => L.wantScore(t, ['pri'])), [0, 0, 3, 3]);
  assert.deepStrictEqual([0, 1, 2, 3].map((t) => L.wantScore(t, ['sec'])), [0, 3, 0, 3]);
  assert.strictEqual(L.wantScore(3, ['sec'], 'cs'), 0, 'u českého originálu tier 3 = jen CZ');
});

test('hledané jazyky – jen CZ: EN se nenabízí, CZ ano, CZ + EN není lepší než CZ', () => {
  const { itemNeeds } = require('../src/search');
  const { neededLang } = require('../src/merge');
  const ctx = { store: { settings: { ...DEFAULT_SETTINGS }, s: { ignoredGuids: {}, wantLangs: { 'sonarr:35': ['pri'] } } } };
  const item = { app: 'sonarr', arrId: 35, season: 1, key: 'sonarr:35:1', origLang: 'other', episodeCount: 8, current: { tier: 0, res: 1080, qrank: 33, audioSource: 'mediainfo' } };
  const rel = (guid, title, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 50, leechers: 0, size: 8e9, protocol: 'torrent', fullSeason: true, seasonNumber: 1, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080, source: 'web' } }, rejections: [], languages: [], ...extra });
  const releases = [
    rel('cz', 'Berlín – S01 (CZ/SPA) [WEB-DL][1080p]'),
    rel('en', 'Berlin.2023.S01.1080p.NF.WEBRip.Spa.Eng'),
  ];
  assert.deepStrictEqual(evaluateReleases(item, releases, ctx).candidates.map((c) => c.guid), ['cz']);
  // bez omezení se nabízí obojí
  const free = { store: { ...ctx.store, s: { ignoredGuids: {} } } };
  assert.deepStrictEqual(evaluateReleases(item, releases, free).candidates.map((c) => c.guid).sort(), ['cz', 'en']);

  const czItem = { ...item, origLang: 'en', current: { ...item.current, tier: 2 } };
  assert.strictEqual(evaluateReleases(czItem, [rel('dual', 'Show S01 (CZ/EN)[1080p]')], ctx).candidates.length, 0);
  assert.strictEqual(itemNeeds(czItem, DEFAULT_SETTINGS, ['pri']).lang, false);
  assert.strictEqual(itemNeeds(czItem, DEFAULT_SETTINGS, null).lang, true);
  assert.strictEqual(neededLang(czItem, ['pri']), null, 'EN stopu nepřidávat');
  assert.strictEqual(neededLang({ ...czItem, current: { tier: 1 } }, ['pri']), 'cs');

  // EN 720p → EN 1080p není u "Jen CZ" upgrade kvality (ani balík více sérií); bez omezení ano
  const enItem = { ...item, origLang: 'en', current: { ...item.current, tier: 1, res: 720, qrank: 20 } };
  const enRel = rel('en1080', 'Show S01 1080p BluRay x265');
  assert.strictEqual(evaluateReleases(enItem, [enRel], ctx).candidates.length, 0);
  assert.deepStrictEqual(evaluateReleases(enItem, [enRel], free).candidates.map((c) => c.guid), ['en1080']);
  const sib = { ...enItem, season: 2, key: 'sonarr:35:2' };
  const pack = rel('pack', 'Show S01-S02 1080p BluRay x265');
  assert.strictEqual(evaluateReleases(enItem, [pack], ctx, { siblings: { 2: sib } }).multi.length, 0);
  assert.strictEqual(evaluateReleases(enItem, [pack], free, { siblings: { 2: sib } }).multi.length, 1);
});

test('skupiny v názvu: řetěz jazyků nepřetéká přes závorky a "+"', () => {
  assert.strictEqual(tier('Duna (2021)[1080p](CZ/EN)(CZ titulky)', { origLang: 'en' }), 3);
  assert.strictEqual(tier('Duna (2021)(CZ) + EN titulky', { origLang: 'en' }), 2);
  const p = L.parseReleaseTitle('Duna (2021)(CZ) + EN titulky');
  assert.deepStrictEqual([...p.audio], ['cs']);
  assert.deepStrictEqual([...p.subs], ['en']);
  assert.ok(!p.tokens.includes('|'), 'hranice skupin nejsou mezi slovy');
  // uvnitř jedné skupiny řetěz dál platí
  assert.strictEqual(tier('Duna (2021)[1080p](CZ, EN titulky)', { origLang: 'en' }), 1);
});

test('jazykové zkratky v názvu díla nejsou jazyk releasu', () => {
  assert.strictEqual(tier('En.man.som.heter.Ove.2015.1080p.BluRay.x264', { origLang: 'other' }), 0, 'švédský film, ne EN');
  assert.strictEqual(tier('En.man.som.heter.Ove.2015.1080p.BluRay.CZ.dabing', { origLang: 'other' }), 2);
  // samostatná zkratka před rokem pořád platí
  assert.strictEqual(tier('[CZ] Avatar (2009) 1080p', { origLang: 'en' }), 2);
  assert.strictEqual(tier('Avatar CZ 2009 1080p', { origLang: 'en' }), 2);
  assert.strictEqual(tier('CZ - Avatar (2009) 1080p', { origLang: 'en' }), 2);
});

test('DUAL/MULTI u českého originálu = čeština je mezi stopami', () => {
  assert.strictEqual(tier('Pelisky.1999.1080p.DUAL', { origLang: 'cs' }), 3);
  assert.strictEqual(tier('Pelisky.1999.1080p.BluRay.MultiDub.x264', { origLang: 'cs' }), 3);
});

test('MULTI z CZ trackeru s CZ titulky neznamená CZ dabing', () => {
  const opts = { origLang: 'en', localIndexer: true };
  assert.strictEqual(tier('Film.2020.1080p.WEB-DL.MULTI + CZ titulky', opts), 1);
  assert.strictEqual(L.evaluateRelease('Film.2020.1080p.WEB-DL.MULTI + CZ titulky', opts).subsPri, true);
  assert.strictEqual(tier('Film.2020.1080p.WEB-DL.MULTI', opts), 3, 'bez titulků pořád odhad CZ');
});

test('série se smíšenými epizodami: balík, který část epizod zhorší, se nabídne s varováním a nestáhne sám', () => {
  const { judge, worsenedEpisodes } = require('../src/search');
  const { autoAllowed } = require('../src/watch');
  const st = { ...DEFAULT_SETTINGS, autoGrab: 'any' };
  // 9 epizod CZ + EN, jedna jen EN → série je "EN" (nejhorší epizoda)
  const cur = { tier: 1, res: 1080, tierCounts: [0, 1, 0, 9] };
  assert.strictEqual(worsenedEpisodes(cur, 2), 9);
  assert.strictEqual(worsenedEpisodes(cur, 3), 0);
  const v = judge(cur, 2, 1080, st);
  assert.strictEqual(v.kind, 'language');
  assert.strictEqual(v.worse, 9);
  assert.ok(v.warnings.some((w) => w.startsWith('zhorší 9 epizod')), v.warnings.join());
  assert.deepStrictEqual(judge(cur, 3, 1080, st).warnings, [], 'CZ + EN balík nic nezhorší');
  assert.match(judge({ tier: 1, res: 1080, tierCounts: [0, 1, 0, 3] }, 2, 1080, st).warnings[0], /zhorší 3 epizody/);
  assert.match(judge({ tier: 1, res: 1080, tierCounts: [0, 1, 0, 1] }, 2, 1080, st).warnings[0], /zhorší 1 epizodu/);

  // celý průchod: kandidát nese počet a automatika ho nevezme
  const ctx = { store: { settings: st, s: { ignoredGuids: {}, watchSeries: {} } } };
  const item = { app: 'sonarr', arrId: 5, season: 1, key: 'sonarr:5:1', origLang: 'en', episodeCount: 10, current: { ...cur, qrank: 34, audioSource: 'mediainfo' } };
  const rel = { guid: 'p', indexerId: 1, indexer: 'SkTorrent', title: 'Show S01 (CZ)[1080p]', seeders: 200, leechers: 0, size: 8e9, protocol: 'torrent', fullSeason: true, seasonNumber: 1, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080, source: 'web' } }, rejections: [], languages: [] };
  const [c] = evaluateReleases(item, [rel], ctx).candidates;
  assert.strictEqual(c.worsens, 9);
  assert.strictEqual(autoAllowed(ctx.store, item, c), false);
  assert.strictEqual(autoAllowed(ctx.store, item, { ...c, worsens: undefined, warnings: [] }), true, 'bez zhoršení by šel');
});

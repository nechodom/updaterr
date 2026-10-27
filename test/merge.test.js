const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mergeCandidates, neededLang, parseEpisode, speechLangs, Merger } = require('../src/merge');
const { watchOf, setWatch, autoWatchNew, recheckMs, autoAllowed } = require('../src/watch');
const { DEFAULT_SETTINGS, stagingFor } = require('../src/store');

const helpers = {
  HARD_REJECT: /unknown (movie|series)/i,
  rejectionsOf: (r) => r.rejections || [],
  isLocalIndexer: (n) => /sktorrent/i.test(n),
};

function mkStore(extra = {}) {
  return { settings: { ...DEFAULT_SETTINGS, stagingDir: '/tmp/updaterr-test', ...extra }, s: { ignoredGuids: {}, items: {}, watchSeries: {} }, save() {} };
}

test('parseEpisode', () => {
  assert.deepStrictEqual(parseEpisode('Show.S02E05.1080p.mkv'), { s: 2, e: 5 });
  assert.deepStrictEqual(parseEpisode('dir/Show 2x07 - Name.mkv'), { s: 2, e: 7 });
  assert.deepStrictEqual(parseEpisode('Show - Ep 12 (CZ).avi'), { s: null, e: 12 });
  assert.strictEqual(parseEpisode('Movie.2019.1080p.mkv'), null);
});

test('neededLang', () => {
  assert.strictEqual(neededLang({ current: { tier: 1 }, origLang: 'en' }), 'cs');
  assert.strictEqual(neededLang({ current: { tier: 2 }, origLang: 'en' }), 'en');
  assert.strictEqual(neededLang({ current: { tier: 2 }, origLang: 'cs' }), null);
  assert.strictEqual(neededLang({ current: { tier: 3 }, origLang: 'en' }), null);
  assert.strictEqual(neededLang({ current: { tier: 0 }, origLang: 'en' }), null);
});

test('mergeCandidates – jen releasy s chybějícím jazykem, dual napřed', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = { app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-2160p', res: 2160, qrank: 45 } };
  const rel = (guid, title, seeders, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders, size: 3e9, protocol: 'torrent', quality: { quality: { name: 'WEBRip-720p', resolution: 720, source: 'webrip' } }, languages: [], rejections: [], ...extra });
  const list = mergeCandidates(item, [
    rel('cz', 'Film (2020)(CZ)[720p]', 50),
    rel('dual', 'Film (2020)(CZ/EN)[1080p]', 10),
    rel('en', 'Film.2020.1080p.WEB-DL', 500),
    rel('dead', 'Film (2020)(CZ)[1080p]', 1),
    rel('cam', 'Film (2020)(CZ)[CAM]', 90),
    rel('sub', 'Film 2020 1080p CZ titulky', 90),
  ], ctx, helpers);
  assert.deepStrictEqual(list.map((c) => c.guid), ['dual', 'cz']);
  assert.ok(list.every((c) => c.kind === 'merge' && c.mergeLang === 'cs' && c.quality === 'Bluray-2160p'));
});

test('mergeCandidates – nejmenší donor se nabídne vždy, se Šetřit data vyhraje', () => {
  const item = { app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, qrank: 40 } };
  const rel = (guid, title, seeders, gb) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders, size: gb * 1024 ** 3, protocol: 'torrent', quality: { quality: { name: 'Bluray-1080p', resolution: 1080, source: 'bluray' } }, languages: [], rejections: [] });
  const releases = [
    rel('big', 'Film (2020)(CZ/EN)[1080p]', 60, 18.4),
    rel('mid', 'Film (2020)(CZ/EN)[720p]', 40, 8),
    rel('small', 'Film (2020)(CZ)[720p]', 20, 2.1),
    rel('small2', 'Film (2020)(CZ)[720p] x265', 20, 2.15),
  ];
  const off = mergeCandidates(item, releases, { store: mkStore(), qbit: { enabled: true } }, helpers);
  assert.deepStrictEqual(off.map((c) => [c.guid, Boolean(c.smallest)]), [['mid', false], ['big', false], ['small', true]]);

  const on = mergeCandidates(item, releases, { store: mkStore({ mergeSaveData: true }), qbit: { enabled: true } }, helpers);
  assert.deepStrictEqual(on.map((c) => [c.guid, Boolean(c.smallest)]), [['small', false], ['small2', false]]);

  // Se Šetřit data je nejmenší napřed; podobně velké donory se neoznačí
  const same = mergeCandidates(item, releases.slice(2), { store: mkStore(), qbit: { enabled: true } }, helpers);
  assert.ok(same.every((c) => !c.smallest));
});

test('mergeCandidates – bez qBittorrentu nebo bez ověřeného jazyka nic', () => {
  const item = { app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo' } };
  const r = [{ guid: 'a', title: 'Film (2020)(CZ)[720p]', seeders: 50, protocol: 'torrent', size: 1e9, quality: {}, rejections: [] }];
  assert.strictEqual(mergeCandidates(item, r, { store: mkStore(), qbit: { enabled: false } }, helpers).length, 0);
  assert.strictEqual(mergeCandidates({ ...item, current: { ...item.current, audioSource: 'nazev' } }, r, { store: mkStore(), qbit: { enabled: true } }, helpers).length, 0);
});

test('stagingFor – vlastní složka aplikace, jinak společná', () => {
  const st = { stagingDir: '/shared', stagingDirRadarr: '/movies/staging', stagingDirSonarr: '' };
  assert.strictEqual(stagingFor(st, 'radarr'), '/movies/staging');
  assert.strictEqual(stagingFor(st, 'sonarr'), '/shared');
  assert.strictEqual(stagingFor({ ...st, stagingDir: '' }, 'sonarr'), '');
});

test('mergeCandidates – staging jen pro druhou aplikaci nestačí', () => {
  const item = { app: 'sonarr', season: 1, origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', files: 10 } };
  const r = [{ guid: 'a', title: 'Serial S01 (CZ)[720p]', seeders: 50, protocol: 'torrent', size: 1e9, fullSeason: true, seasonNumber: 1, quality: {}, rejections: [] }];
  const only = (extra) => mergeCandidates(item, r, { store: mkStore({ stagingDir: '', ...extra }), qbit: { enabled: true } }, helpers);
  assert.strictEqual(only({ stagingDirRadarr: '/movies/staging' }).length, 0);
  assert.strictEqual(only({ stagingDirSonarr: '/tv/staging' }).length, 1);
});

test('Merger.start – bez stagingu pro aplikaci položky odmítne (návrh starší než změna nastavení)', async () => {
  const store = mkStore({ stagingDir: '', stagingDirRadarr: '/movies/staging' });
  store.s.items['sonarr:7:1'] = { key: 'sonarr:7:1', app: 'sonarr', arrId: 7, season: 1, current: {} };
  store.s.proposals = { p1: { status: 'pending', itemKey: 'sonarr:7:1', candidates: [{ kind: 'merge' }] } };
  store.s.merges = {};
  const m = new Merger({ store, qbit: { enabled: true }, downloads: { active: () => [] } });
  await assert.rejects(() => m.start('p1', 0), /pracovní složka/);
});

test('mergeCandidates – jazyk ověřený poslechem stačí', () => {
  const item = { app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'poslech', quality: 'WEBRip-1080p', res: 1080, qrank: 33 } };
  const r = [{ guid: 'a', indexer: 'SkTorrent', title: 'Film (2020)(CZ)[WEB-DL][1080p]', seeders: 119, protocol: 'torrent', size: 4.8e9, quality: {}, languages: [], rejections: [] }];
  const list = mergeCandidates(item, r, { store: mkStore(), qbit: { enabled: true } }, helpers);
  assert.deepStrictEqual(list.map((c) => [c.guid, c.mergeLang]), [['a', 'cs']]);
});

test('speechLangs – jazyk stávajících stop podle poslechu', () => {
  const tr = (index, tag, used) => ({ index, tag, used });
  const audio = [{ index: 1, lang: null }, { index: 2, lang: 'cs' }];
  const lc = { files: [{ id: 5, tracks: [tr(1, null, 'en'), tr(2, 'cs', 'en')] }] };
  // ověřený soubor: podle indexu streamu
  assert.deepStrictEqual(speechLangs(lc, 5, audio), ['en', 'en']);
  assert.deepStrictEqual(speechLangs(lc, 5, [{ index: 1, lang: null }, { index: 7, lang: null }]), ['en', null]);
  // neověřená epizoda se stejnými stopami → stejný výsledek
  assert.deepStrictEqual(speechLangs(lc, 6, audio), ['en', 'en']);
  // jiné stopy nebo neshoda mezi ověřenými epizodami → nevíme
  assert.deepStrictEqual(speechLangs(lc, 6, [{ index: 1, lang: 'en' }, { index: 2, lang: 'cs' }]), [null, null]);
  const two = { files: [lc.files[0], { id: 7, tracks: [tr(1, null, 'en'), tr(2, 'cs', 'cs')] }] };
  assert.deepStrictEqual(speechLangs(two, 6, audio), ['en', null]);
  // bez ověření nebo s chybou
  assert.deepStrictEqual(speechLangs(null, 5, audio), [null, null]);
  assert.deepStrictEqual(speechLangs({ ...lc, error: 'x' }, 5, audio), [null, null]);
});

test('targets – u jazyka ověřeného poslechem nevěří značkám v MediaInfo', async () => {
  const store = mkStore();
  store.s.merges = {};
  store.s.items['radarr:1'] = { current: { audioSource: 'mediainfo' } };
  const movieFile = { id: 9, path: '/x/Film.mkv', mediaInfo: { audioLanguages: 'Czech' } }; // značka CZ, ve skutečnosti EN
  const m = new Merger({ store, radarr: { get: async () => ({ movieFile }) } });
  const j = { itemKey: 'radarr:1', app: 'radarr', arrId: 1, need: 'cs' };
  assert.strictEqual((await m.targets(j)).length, 0);
  store.s.items['radarr:1'].current.audioSource = 'poslech';
  assert.deepStrictEqual((await m.targets(j)).map((t) => t.fileId), [9]);
});

test('hlídání – seriál jako celek, interval a automatika', () => {
  const store = mkStore({ autoGrab: 'off', autoMinSeeders: 10, watchIntervalDays: 2, recheckDays: 14 });
  const s1 = { key: 'sonarr:7:1', app: 'sonarr', arrId: 7, season: 1, lastSearchedAt: 'x' };
  const s2 = { key: 'sonarr:7:2', app: 'sonarr', arrId: 7, season: 2 };
  store.s.items = { [s1.key]: s1, [s2.key]: s2 };
  setWatch(store, s1, { enabled: true });
  assert.ok(watchOf(store, s2), 'platí pro všechny série');
  assert.strictEqual(s1.lastSearchedAt, null, 'zapnutí vynutí brzkou kontrolu');
  assert.strictEqual(recheckMs(store, s2), 2 * 86400e3);

  const good = { tier: 3, confidence: 'likely', seeders: 20, warnings: [] };
  assert.ok(autoAllowed(store, s2, good));
  assert.ok(!autoAllowed(store, s2, { ...good, seeders: 3 }));
  assert.ok(!autoAllowed(store, s2, { ...good, confidence: 'guess' }));
  assert.ok(!autoAllowed(store, s2, { ...good, warnings: ['nižší rozlišení než současné'] }));
  assert.ok(autoAllowed(store, s2, { ...good, kind: 'merge', warnings: ['nižší rozlišení'] }));

  setWatch(store, s2, { enabled: false });
  assert.strictEqual(watchOf(store, s1), null);
  assert.ok(!autoAllowed(store, s1, good), 'bez hlídání a s autoGrab=off se ptá');
});

test('hlídání nových titulů (autoWatchNew)', () => {
  const store = mkStore({ autoWatchNew: 'auto' });
  const mk = (key, extra) => ({ key, app: key.split(':')[0], arrId: Number(key.split(':')[1]), current: { tier: 1 }, ...extra });
  const items = [mk('radarr:1'), mk('radarr:2'), mk('sonarr:7:1'), mk('sonarr:7:2'), mk('sonarr:8:1'), mk('sonarr:8:2')];
  store.s.items = Object.fromEntries(items.map((it) => [it.key, it]));
  const keys = (...k) => new Set(k);

  // První načtení (dřív nic) → nehlídat celou knihovnu
  assert.deepStrictEqual(autoWatchNew(store, 'radarr', keys(), keys('radarr:1', 'radarr:2')), []);
  // Nový film
  const w = autoWatchNew(store, 'radarr', keys('radarr:1'), keys('radarr:1', 'radarr:2'));
  assert.deepStrictEqual(w.map((x) => x.key), ['radarr:2']);
  assert.deepStrictEqual([watchOf(store, store.s.items['radarr:1']), watchOf(store, store.s.items['radarr:2'])?.auto], [null, true]);
  assert.strictEqual(watchOf(store, store.s.items['radarr:2']).origin, 'new');
  // Nový seriál → celý seriál, nová série známého seriálu ne
  const ws = autoWatchNew(store, 'sonarr', keys('sonarr:7:1'), keys('sonarr:7:1', 'sonarr:7:2', 'sonarr:8:1', 'sonarr:8:2'));
  assert.deepStrictEqual(ws.map((x) => x.key), ['sonarr:8:1'], 'jeden záznam za seriál');
  assert.ok(watchOf(store, store.s.items['sonarr:8:2']));
  assert.strictEqual(watchOf(store, store.s.items['sonarr:7:2']), null);
  // Ručně nastavené hlídání se nepřepisuje
  setWatch(store, store.s.items['radarr:2'], { enabled: true, auto: false });
  delete store.s.items['radarr:2'].watch.origin;
  autoWatchNew(store, 'radarr', keys('radarr:1'), keys('radarr:1', 'radarr:2'));
  assert.strictEqual(watchOf(store, store.s.items['radarr:2']).auto, false);
  // ask = hlídat bez automatického stažení, off = nic
  store.settings.autoWatchNew = 'ask';
  store.s.items['radarr:3'] = mk('radarr:3');
  autoWatchNew(store, 'radarr', keys('radarr:1'), keys('radarr:1', 'radarr:3'));
  assert.strictEqual(watchOf(store, store.s.items['radarr:3']).auto, false);
  store.settings.autoWatchNew = 'off';
  store.s.items['radarr:4'] = mk('radarr:4');
  assert.deepStrictEqual(autoWatchNew(store, 'radarr', keys('radarr:1'), keys('radarr:1', 'radarr:4')), []);
});

function hasTool(t) {
  try { execFileSync(t, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('fpsFromPts: snímková frekvence z časových značek (i přeházených a zaokrouhlených na ms)', () => {
  const A = require('../src/audio');
  const pts = Array.from({ length: 1439 }, (_, i) => Math.round((i * 1001) / 24) / 1000);
  for (let i = 0; i + 3 < pts.length; i += 4) [pts[i + 1], pts[i + 3]] = [pts[i + 3], pts[i + 1]]; // B-snímky
  assert.ok(Math.abs(A.fpsFromPts(pts) - 23.976) < 0.002);
  assert.strictEqual(A.fpsFromPts([0, 0.04]), 0, 'málo snímků → neznámo');
  assert.strictEqual(A.fpsFromPts([]), 0);
});

test('measureFps: změří skutečnou frekvenci souboru', { skip: !hasTool('ffmpeg') && 'chybí ffmpeg' }, async () => {
  const A = require('../src/audio');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-fps-'));
  const mkv = path.join(dir, 'v.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25:duration=20', '-c:v', 'mpeg4', mkv]);
  const fps = await A.measureFps({ file: mkv, duration: 20 });
  assert.ok(Math.abs(fps - 25) < 0.01, `naměřeno ${fps}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefixBytes: souvislý stažený začátek souboru', () => {
  const { prefixBytes } = require('../src/merge');
  assert.strictEqual(prefixBytes([2, 2, 2, 0, 2], [0, 4], 4), 12);
  assert.strictEqual(prefixBytes([0, 2, 2, 1, 2], [1, 4], 4), 8, 'soubor začíná až druhým kusem');
  assert.strictEqual(prefixBytes([2, 0], [1, 1], 4), 0);
  assert.strictEqual(prefixBytes(null, [0, 3], 4), 0);
});

test('fpsClearlyDiffers: odmítá jen jasný rozdíl (hlavička bývá zaokrouhlená na ms)', () => {
  const { fpsClearlyDiffers } = require('../src/merge');
  assert.ok(fpsClearlyDiffers(23.976, [25, 25]), 'PAL 25 vs 23,976');
  assert.ok(fpsClearlyDiffers(23.976, [25, 0]), 'stačí hlavička, když změřit nejde');
  assert.ok(!fpsClearlyDiffers(23.976, [23.81, 0]), 'hlavička zaokrouhlená na 42 ms');
  assert.ok(!fpsClearlyDiffers(23.976, [24, 24]), 'malý rozdíl rozhodne až úplná kontrola');
  assert.ok(!fpsClearlyDiffers(23.976, [25, 23.976]), 'změřená hodnota sedí → neodmítat');
  assert.ok(!fpsClearlyDiffers(23.976, [0, 0]), 'neznámé fps donoru');
  assert.ok(!fpsClearlyDiffers(0, [25, 25]), 'neznámé fps cíle');
});

// Merger s falešným qBittorrentem a Radarrem; donor leží v save_path jako nedokončený soubor (.!qB)
function earlyFpsSetup(dir, { donorRate }) {
  const { Merger } = require('../src/merge');
  const target = path.join(dir, 'target.mkv');
  const savePath = path.join(dir, 'donor');
  fs.mkdirSync(savePath, { recursive: true });
  const mk = (rate, out) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=64x64:rate=${rate}:duration=20`, '-c:v', 'mpeg4', '-f', 'matroska', out]);
  mk('24000/1001', target);
  // Donor stažený jen zčásti: začátek, zbytek předalokovaný nulami
  const donor = path.join(savePath, 'Film.CZ.mkv.!qB');
  mk(donorRate, donor);
  const buf = fs.readFileSync(donor);
  buf.fill(0, Math.floor(buf.length * 0.4));
  fs.writeFileSync(donor, buf);
  const calls = [];
  const torrent = { hash: 'h1', save_path: savePath, download_path: '', seq_dl: false, f_l_piece_prio: false, amount_left: 3e9, size: 4e9, progress: 0.01, eta: 600, num_seeds: 5, dlspeed: 1e6, state: 'downloading' };
  const files = [
    { index: 0, name: 'Film.CZ.mkv', size: 4e9, priority: 1, piece_range: [0, 999] },
    { index: 1, name: 'Sample/sample.mkv', size: 5e7, priority: 1, piece_range: [999, 1010] },
  ];
  const qbit = {
    enabled: true,
    byTag: async () => torrent,
    files: async () => files,
    setFilePriority: async (h, ids, p) => { calls.push(['prio', ids, p]); for (const f of files) if (ids.includes(f.index)) f.priority = p; },
    prioritizeStart: async (t, on) => { calls.push(['start', on]); torrent.seq_dl = torrent.f_l_piece_prio = on; },
    pieceStates: async () => Array.from({ length: 1011 }, (_, i) => (i < 20 ? 2 : 0)),
    properties: async () => ({ piece_size: 4 * 1024 ** 2 }),
    delete: async (h) => calls.push(['delete', h]),
  };
  const store = { ...mkStore({ retryOnStall: false }), log() {} };
  Object.assign(store.s, { merges: {}, proposals: {} });
  const radarr = { get: async () => ({ movieFile: { id: 1, path: target, mediaInfo: { audioLanguages: 'English' } } }) };
  const m = new Merger({ store, qbit, radarr, notify: { download: async () => {} } });
  const j = { id: 'j1', label: 'Film', app: 'radarr', arrId: 1, need: 'cs', guid: 'g1', dir: path.join(dir, 'job'), state: 'downloading', active: true, grabbedAt: Date.now(), lastProgressAt: Date.now(), attempt: 1 };
  store.s.merges.j1 = j;
  return { m, j, calls, store };
}

test('předběžná kontrola fps: PAL donor se odmítne už ze začátku souboru', { skip: !hasTool('ffmpeg') && 'chybí ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'updaterr-early-'));
  try {
    const { m, j, calls, store } = earlyFpsSetup(dir, { donorRate: 25 });
    await m.checkDownload(j);
    assert.ok(j.filesSelected);
    assert.deepStrictEqual(calls.slice(0, 2), [['prio', [1], 0], ['start', true]], 'vzorek vypnut, začátek napřed');
    assert.strictEqual(j.fpsCheck.state, 'pending');
    await m.checkDownload(j);
    assert.strictEqual(j.state, 'failed');
    assert.match(j.message, /jiná snímková frekvence \(23\.97\d vs 25\.000 fps, zjištěno ze začátku donoru\)/);
    assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 'h1'), 'torrent smazán');
    assert.ok(store.s.ignoredGuids.g1, 'donor se už nenabídne');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('předběžná kontrola fps: stejná fps → stahuje dál normálně', { skip: !hasTool('ffmpeg') && 'chybí ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'updaterr-early-'));
  try {
    const { m, j, calls } = earlyFpsSetup(dir, { donorRate: '24000/1001' });
    await m.checkDownload(j);
    await m.checkDownload(j);
    assert.strictEqual(j.state, 'downloading');
    assert.strictEqual(j.fpsCheck.state, 'ok');
    assert.ok(Math.abs(j.fpsCheck.target - 23.976) < 0.01);
    assert.deepStrictEqual(calls.at(-1), ['start', false], 'sekvenční stahování zase vypnuto');
    assert.ok(!calls.some((c) => c[0] === 'delete'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

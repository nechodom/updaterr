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

test('Store – STAGING_DIR* z prostředí přebije hodnotu uloženou ve state.json', () => {
  const { Store } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'updaterr-store-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { stagingDir: '/old', stagingDirRadarr: '', stagingDirSonarr: '/tv/saved' } }));
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { STAGING_DIR: '/shared', STAGING_DIR_RADARR: '/movies/staging' });
    delete process.env.STAGING_DIR_SONARR;
    const st = new Store(dir).settings;
    assert.strictEqual(st.stagingDir, '/shared');
    assert.strictEqual(st.stagingDirRadarr, '/movies/staging');
    assert.strictEqual(st.stagingDirSonarr, '/tv/saved', 'bez proměnné zůstane uložená hodnota');
  } finally {
    for (const k of ['STAGING_DIR', 'STAGING_DIR_RADARR', 'STAGING_DIR_SONARR']) if (k in keep) process.env[k] = keep[k]; else delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// --- Donor s jinou rychlostí (PAL 25 fps vs 23,976 fps) -------------------------------------------------
const PAL = 25 / (24000 / 1001);

test('rychlost donoru: jiná fps jen s délkou zrychlené verze → napřed přepočet, telecine beze změny', () => {
  const A = require('../src/audio');
  assert.ok(Math.abs(A.snapSpeed(25 / 23.976) - PAL) < 1e-6);
  assert.strictEqual(A.snapSpeed(25 / 23.81), null, 'hlavička zaokrouhlená na ms není standardní poměr');
  const film = 7200;
  // PAL release: 25 fps a o 4,3 % kratší
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 23.976, donorFps: 25, targetDur: film, donorDur: film / PAL }), [A.snapSpeed(PAL), 1]);
  // 25 fps se stejnou délkou (video převedené s duplikací snímků) → napřed beze změny
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 23.976, donorFps: 25, targetDur: film, donorDur: film + 20 }), [1, A.snapSpeed(PAL)]);
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 23.976, donorFps: 23.976, targetDur: film, donorDur: film - 30 }), [1]);
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 23.976, donorFps: 29.97, targetDur: film, donorDur: film }), [1], 'telecine – poměr mimo rozsah');
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 0, donorFps: 25, targetDur: film, donorDur: film }), [1], 'neznámá fps');
  // Stejná fps, ale délka přesně zrychlené verze → zkusit i přepočet (až jako druhé)
  assert.deepStrictEqual(A.speedCandidates({ targetFps: 23.976, donorFps: 23.976, targetDur: film, donorDur: film / PAL }), [1, A.snapSpeed(PAL)]);
});

test('rychlost donoru z rovnoměrně narůstajícího posunu (24 vs 23,976 fps)', () => {
  const A = require('../src/audio');
  const s = 24 / (24000 / 1001);
  const anchors = [600, 1500, 2400, 3300, 4200, 5100, 6000].map((at, i) => ({ at, offsetMs: Math.round(at * (1 - 1 / s) * 1000) + (i % 2 ? 8 : -8) + 120, z: 12 }));
  assert.ok(Math.abs(A.driftSpeed(anchors) - s) < 1e-6);
  assert.strictEqual(A.driftSpeed(anchors.map((a) => ({ ...a, offsetMs: 120 }))), null, 'stálý posun');
  assert.strictEqual(A.driftSpeed(anchors.map((a, i) => ({ ...a, offsetMs: i === 3 ? a.offsetMs + 3000 : a.offsetMs }))), null, 'skok (jiný střih) na přímce neleží');
  assert.strictEqual(A.driftSpeed(anchors.slice(0, 3)), null, 'málo míst');
});

test('kodek přepočtené stopy', () => {
  const A = require('../src/audio');
  assert.deepStrictEqual(A.retimeCodec({ codec: 'ac3', channels: 6, bitRate: 384000 }), { codec: 'eac3', channels: 6, kbps: 448 });
  assert.deepStrictEqual(A.retimeCodec({ codec: 'dts', channels: 8, bitRate: 1536000 }), { codec: 'eac3', channels: 6, kbps: 1024 });
  assert.deepStrictEqual(A.retimeCodec({ codec: 'aac', channels: 2, bitRate: 128000 }), { codec: 'aac', channels: 2, kbps: 160 });
});

test('výška zvuku: spektrum posunuté o PAL zrychlení se pozná', () => {
  const A = require('../src/audio');
  // „Hudba“: akordy, které se mění každých 0,4 s; donor stejný, ale o 4,3 % výš
  const tone = (mult) => {
    const x = new Float32Array(8000 * 6);
    const chords = [[220, 277, 330], [247, 311, 370], [196, 247, 294], [262, 330, 392]];
    for (let i = 0; i < x.length; i++) {
      const t = i / 8000;
      for (const f of chords[Math.floor(t / 0.4) % 4]) for (let h = 1; h <= 4; h++) x[i] += Math.sin(2 * Math.PI * f * h * mult * t) / (h * 6);
    }
    return x;
  };
  const R = A.spectra(tone(1)), raised = A.spectra(tone(PAL)), same = A.spectra(tone(1));
  const avg = (D, f) => R.reduce((s, r, i) => s + A.specCorr(r, D[i], f), 0) / R.length;
  assert.ok(avg(raised, PAL) - avg(raised, 1) > 0.3, `zvýšený: ${avg(raised, PAL)} vs ${avg(raised, 1)}`);
  assert.ok(avg(same, 1) - avg(same, PAL) > 0.3, `stejný: ${avg(same, 1)} vs ${avg(same, PAL)}`);
});

test('přepočet tempa: PAL zvuk se zpomalí na délku stávajícího souboru (ffmpeg)', { skip: !hasTool('ffmpeg') && 'chybí ffmpeg' }, async () => {
  const A = require('../src/audio');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-retime-'));
  try {
    const src = path.join(dir, 'pal.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=${(60 / PAL).toFixed(4)}:r=48000`, '-ac', '2', '-c:a', 'ac3', '-b:a', '192k', src]);
    const p = await A.probe(src);
    for (const pitch of ['keep', 'restore']) {
      const out = path.join(dir, `${pitch}.mka`);
      const enc = await A.retime({ file: src, audio: p.audio[0] }, A.snapSpeed(PAL), out, { pitch, lang: 'cze' });
      const o = await A.probe(out);
      assert.strictEqual(enc.codec, 'eac3');
      assert.strictEqual(o.audio[0].codec, 'eac3');
      assert.strictEqual(o.audio[0].lang, 'cs');
      assert.ok(Math.abs(o.duration - 60) < 0.2, `${pitch}: délka ${o.duration}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// mergeOne s podvrženým A (ffprobe, měření, přepočet) – donor má 25 fps a je o 4,3 % kratší
async function retimeMerge({ syncAt = () => true, raised = false, fps = 25 } = {}) { // syncAt(název souboru donoru) → sedí?
  const A = require('../src/audio');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mpal-'));
  const real = { ...A };
  const calls = [];
  try {
    const target = path.join(dir, 'Film.mkv');
    const donor = path.join(dir, 'Film.CZ.mkv');
    const probe = (file, lang, codec, duration, vfps) => ({ file, duration, startTime: 0, video: vfps ? { fps: vfps } : null,
      audio: [{ index: 1, audioIndex: 0, lang, from: 'tag', codec, channels: 6, default: true, sampleRate: 48000 }] });
    A.probe = async (f) => (f === target ? probe(target, 'en', 'eac3', 6000, 23.976)
      : f === donor ? probe(donor, 'cs', 'ac3', fps === 25 ? 6000 / PAL : 6000, fps)
        : f.endsWith('.mka') ? probe(f, 'cs', 'eac3', 6000, null)
          : { ...probe(f, 'en', 'eac3', 6000, 23.976), audio: [probe(f, 'en', 'eac3').audio[0], { ...probe(f, 'cs', 'eac3').audio[0], index: 2, audioIndex: 1 }] });
    A.measureFps = async (p) => p.video?.fps || 0;
    A.retime = async (src, speed, out, opts) => { calls.push(['retime', path.basename(src.file), speed.toFixed(4), opts.pitch]); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'mka'); return { codec: 'eac3' }; };
    A.checkSync = async (ref, d) => {
      const ok = syncAt(path.basename(d.file));
      calls.push(['sync', path.basename(d.file), ok]);
      return ok ? { ok: true, offsetMs: d.file.includes(`${path.sep}out${path.sep}`) ? 3 : 120, matched: '8/8', anchors: [{ at: 500, offsetMs: 120, z: 12 }] } : { ok: false, reason: 'stopy si neodpovídají (shoda jen v 0/8 místech) – jiná verze/střih?', anchors: [] };
    };
    A.pitchCheck = async () => ({ raised, same: raised ? 0 : 0.4, shifted: raised ? 0.4 : 0 });
    A.run = async (cmd, args) => {
      if (args[0] === '-J') return JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio', codec: /\.CZ\./.test(args[1]) ? 'AC-3' : 'E-AC-3', properties: { language: /\.mka$|\.CZ\./.test(args[1]) ? 'cze' : 'eng', audio_channels: 6 } }] });
      calls.push(['mkvmerge', path.basename(args.at(-1)), args[args.indexOf('--sync') + 1]]);
      fs.writeFileSync(args[1], 'out');
      return '';
    };
    const store = { ...mkStore(), log() {} };
    Object.assign(store.s, { merges: {}, proposals: {} });
    store.s.items['radarr:1'] = {};
    const m = new Merger({ store, qbit: { enabled: true }, radarr: { languageObjs: async (codes) => codes.map((c) => ({ id: 0, name: c })) } });
    const j = { id: 'mp', itemKey: 'radarr:1', app: 'radarr', need: 'cs', dir: path.join(dir, 'job') };
    const res = await m.mergeOne(j, { path: target, fileId: 1 }, donor).then((r) => r, (e) => e);
    return { res, calls, j, work: fs.existsSync(path.join(dir, 'job', 'work')) ? fs.readdirSync(path.join(dir, 'job', 'work')) : [] };
  } finally {
    Object.assign(A, real);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sloučení s PAL donorem: zvuk se přepočítá, sloučí se přepočtená stopa', async () => {
  // Přímo stopy nesedí (0/8), po přepočtu ano (i ve výsledném souboru)
  const { res, calls, j } = await retimeMerge({ syncAt: (f) => f !== 'Film.CZ.mkv' });
  assert.ok(!(res instanceof Error), res.message);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'retime'), [['retime', 'Film.CZ.mkv', '1.0427', 'keep']]);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'mkvmerge'), ['mkvmerge', '1-keep.mka', '1:120'], 'do souboru jde přepočtená stopa');
  assert.match(res.langNote, /zvuk donoru přepočítán na tempo stávajícího souboru \(25\.000 → 23\.976 fps, výška hlasů beze změny\)/);
  assert.deepStrictEqual(res.retimed.pitch, 'keep');
  assert.match(j.message, /přepočítávám CZ zvuk donoru/);
  assert.strictEqual(calls.filter((c) => c[0] === 'sync' && c[1] === 'Film.CZ.mkv').length, 0, 'délka odpovídá PAL → napřed přepočet, beze změny se nezkouší');
});

test('sloučení s PAL donorem bez korekce výšky: přepočítá se i výška', async () => {
  const { res, calls } = await retimeMerge({ syncAt: (f) => f !== 'Film.CZ.mkv', raised: true });
  assert.ok(!(res instanceof Error), res.message);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'retime').map((c) => c[3]), ['keep', 'restore']);
  assert.strictEqual(calls.find((c) => c[0] === 'mkvmerge')[1], '1-restore.mka');
  assert.match(res.langNote, /vrácena i výška hlasů/);
});

test('sloučení s PAL donorem: když nesedí ani po přepočtu, je to nesoulad (ne vadný release)', async () => {
  const { res } = await retimeMerge({ syncAt: () => false });
  assert.ok(res instanceof Error);
  assert.match(res.message, /^nesedí synchronizace – po přepočtu 25\.000 → 23\.976 fps: stopy si neodpovídají.*; beze změny tempa: stopy si neodpovídají/);
  assert.ok(res.donor && res.mismatch);
});

test('sloučení: stejná fps → žádný přepočet', async () => {
  const { res, calls } = await retimeMerge({ syncAt: () => true, fps: 23.976 });
  assert.ok(!(res instanceof Error), res.message);
  assert.ok(!calls.some((c) => c[0] === 'retime'));
  assert.strictEqual(res.retimed, undefined);
  assert.strictEqual(calls.find((c) => c[0] === 'mkvmerge')[1], 'Film.CZ.mkv');
});

test('jednorázově: donory odmítnuté kvůli fps se znovu nabídnou k přidání zvuku', () => {
  const { unblockRetimableDonors, badDonorOf } = require('../src/merge');
  const store = mkStore();
  store.s.ignoredGuids = { gOld: 1, gSync: 1 };
  store.s.badDonors = {
    a: { itemKey: 'radarr:257', guids: ['gPal'], hashes: [], reason: 'jiná snímková frekvence (23.976 vs 25.000 fps, zjištěno ze začátku donoru) – zvuk by se rozjížděl' },
    b: { itemKey: 'radarr:1', guids: ['gOld'], hashes: [], reason: 'Nic nešlo sloučit: nesedí synchronizace – posun se v průběhu filmu mění o 6000 ms (posun postupně narůstá – jiná rychlost/fps)' },
    c: { itemKey: 'radarr:2', guids: ['gSync'], hashes: [], reason: 'Nic nešlo sloučit: nesedí synchronizace – stopy si neodpovídají (shoda jen v 4/8 místech) – jiná verze/střih?' },
  };
  assert.deepStrictEqual(unblockRetimableDonors(store), ['radarr:257', 'radarr:1']);
  assert.deepStrictEqual(Object.keys(store.s.badDonors), ['c']);
  assert.deepStrictEqual(Object.keys(store.s.ignoredGuids), ['gSync']);
  assert.strictEqual(badDonorOf(store, 'radarr:257', { guid: 'gPal', title: 'x' }), null);
  assert.deepStrictEqual(unblockRetimableDonors(store), [], 'jen jednou');
});

test('nevhodné donory – pozná stejný torrent pod jiným GUID, hashem i názvem', () => {
  const { releaseHash, badDonorOf, rememberBadDonor, mergeCandidates: mc } = require('../src/merge');
  const H = '1b3a35d8364d62d8cb0e61cd943cf1510400f2f4';
  assert.strictEqual(releaseHash({ magnetUrl: `magnet:?xt=urn:btih:${H.toUpperCase()}&dn=x` }), H);
  assert.strictEqual(releaseHash({ guid: `https://sktorrent.eu/torrent/download.php?id=${H}&f=Film` }), H);
  assert.strictEqual(releaseHash({ guid: 'https://1337x.to/torrent/6410110/Film/' }), null);

  const store = mkStore();
  const j = { id: 'j1', itemKey: 'sonarr:5:2', label: 'Show – 02. série', title: 'The.Last.of.Us.S02.1080p.ITA ENG.MULTI.WEBRip.x265.AAC-V3SP4EV3R',
    guid: 'https://1337x.to/torrent/6410110/x/', hash: H.toUpperCase(), candidate: {} };
  rememberBadDonor(store, j, 'nesedí synchronizace');
  // magnet z jiného indexeru (jiný GUID, jiná interpunkce v názvu)
  assert.ok(badDonorOf(store, 'sonarr:5:2', { guid: 'magnet:x', magnetUrl: `magnet:?xt=urn:btih:${H}`, title: 'whatever' }));
  assert.ok(badDonorOf(store, 'sonarr:5:2', { guid: 'other', title: 'The.Last.of.Us.S02.1080p.ITA-ENG.MULTI.WEBRip.x265.AAC-V3SP4EV3R' }));
  // stejný název u jiné položky neplatí, jiný release taky ne
  assert.strictEqual(badDonorOf(store, 'sonarr:5:3', { guid: 'other', title: j.title }), null);
  assert.strictEqual(badDonorOf(store, 'sonarr:5:2', { guid: 'other', title: 'The.Last.of.Us.S02.2160p' }), null);
  // opakovaný pokus se stejným záznamem se počítá jednou za úlohu
  rememberBadDonor(store, j, 'nesedí synchronizace');
  rememberBadDonor(store, { ...j, id: 'j2' }, 'nesedí synchronizace');
  assert.deepStrictEqual(Object.values(store.s.badDonors).map((b) => b.jobs), [['j1', 'j2']]);

  const item = { key: 'radarr:1', app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, qrank: 40 } };
  rememberBadDonor(store, { id: 'j3', itemKey: 'radarr:1', title: 'Film (2020)(CZ)[1080p]', guid: 'g-old' }, 'jiná snímková frekvence');
  const rel = (guid, title) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 50, size: 3e9, protocol: 'torrent', quality: { quality: { name: 'Bluray-1080p', resolution: 1080, source: 'bluray' } }, languages: [], rejections: [] });
  const list = mc(item, [rel('g-new', 'Film (2020)(CZ/EN)[1080p]'), rel('g-dup', 'Film (2020) (CZ) [1080p]')], { store, qbit: { enabled: true } }, helpers);
  assert.deepStrictEqual(list.map((c) => c.guid), ['g-new']);
});

test('nevhodné donory – doplnění z historie (i částečně sloučená série) a pročištění návrhů', () => {
  const { backfillBadDonors, pruneBadDonorCandidates } = require('../src/merge');
  const store = mkStore();
  store.s.ignoredGuids = { gA: 1, gB: 1 };
  store.s.merges = {
    a: { id: 'a', state: 'failed', itemKey: 'radarr:1', title: 'Film (CZ)', guid: 'gA', finishedAt: 1, message: 'Nic nešlo sloučit: nesedí synchronizace · žádný další vhodný donor' },
    b: { id: 'b', state: 'failed', itemKey: 'radarr:1', title: 'Film (CZ/EN)', guid: 'gX', finishedAt: 2, message: 'Málo místa na disku' }, // ne vina torrentu
    c: { id: 'c', state: 'done', itemKey: 'sonarr:2:35', title: 'Show S35 CZ', guid: 'gC', finishedAt: 3,
      results: [{ ok: true }, { ok: false, reason: 'nesedí synchronizace' }, { ok: false, reason: 'nesedí synchronizace' }] },
    d: { id: 'd', state: 'done', itemKey: 'radarr:3', title: 'Other', guid: 'gD', finishedAt: 4, results: [{ ok: true }] },
  };
  store.s.proposals = {
    p: { status: 'pending', itemKey: 'sonarr:2:35', candidates: [{ kind: 'merge', guid: 'magnet', title: 'Show.S35.CZ' }, { kind: 'replace', guid: 'gC', title: 'Show S35 CZ' }] },
  };
  assert.strictEqual(backfillBadDonors(store), 2);
  assert.strictEqual(backfillBadDonors(store), 0); // jen jednou (odblokované se nevrací)
  const reasons = Object.values(store.s.badDonors).map((b) => b.reason).sort();
  assert.deepStrictEqual(reasons, ['Nic nešlo sloučit: nesedí synchronizace', 'neprošlo 2 z 3 epizod: nesedí synchronizace']);
  assert.strictEqual(pruneBadDonorCandidates(store), 1);
  assert.deepStrictEqual(store.s.proposals.p.candidates.map((c) => c.kind), ['replace']); // celá výměna souboru zůstává
});

test('import sloučení: stav "importing" a dlouhá záloha už před odesláním – timeout nic nesmaže, odmítnutí ano vrátí', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mimp-'));
  try {
    const lib = path.join(dir, 'lib.mkv');
    fs.writeFileSync(lib, 'x');
    const out = path.join(dir, 'out.mkv');
    fs.writeFileSync(out, 'y');
    const run = async (commandErr) => {
      const store = { ...mkStore({ stagingDir: dir, keepBackupDays: 7 }), log() {} };
      Object.assign(store.s, { merges: {}, proposals: {} });
      const radarr = { command: async () => { throw commandErr; } };
      const qbit = { enabled: true, files: async () => [{ name: 'donor.mkv', size: 5, priority: 1 }] };
      const m = new Merger({ store, qbit, radarr, notify: { download: async () => {} } });
      m.targets = async () => [{ path: lib, episodeNumbers: [] }];
      m.mergeOne = async () => ({ path: lib, out, fileId: 1, quality: {}, languages: [] });
      const j = { id: 'mj', label: 'Film', app: 'radarr', arrId: 1, need: 'cs', guid: 'g', savePath: dir, state: 'ready', active: true, prev: {}, attempt: 1 };
      store.s.merges.mj = j;
      let thrown = null;
      await m.process(j).catch((e) => { thrown = e; });
      return { j, thrown };
    };
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    let { j, thrown } = await run(timeout);
    assert.strictEqual(thrown, null);
    assert.strictEqual(j.state, 'importing', 'import možná proběhl – hlídat, ne opakovat ani mazat');
    assert.ok(j.backupUntil - Date.now() > 29 * 86400e3);
    ({ j, thrown } = await run(Object.assign(new Error('Bad request'), { status: 400 })));
    assert.ok(thrown);
    assert.strictEqual(j.state, 'processing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mkvAudioId: stopa z ffprobe se v mkvmerge hledá podle jazyka, kanálů a kodeku, ne jen podle pořadí', () => {
  const { mkvAudioId } = require('../src/merge');
  const mkv = (tracks) => ({ tracks: [{ id: 0, type: 'video', codec: 'HEVC' }, ...tracks] });
  const a = (audioIndex, lang, channels, codec) => ({ audioIndex, lang, from: lang ? 'tag' : null, channels, codec });
  const same = mkv([
    { id: 1, type: 'audio', codec: 'E-AC-3', properties: { language: 'eng', audio_channels: 6 } },
    { id: 2, type: 'audio', codec: 'AC-3', properties: { language: 'cze', audio_channels: 2 } },
  ]);
  assert.strictEqual(mkvAudioId(same, a(1, 'cs', 2, 'ac3')), 2);
  assert.strictEqual(mkvAudioId(same, a(0, 'en', 6, 'eac3')), 1);
  // mkvmerge má stopy v jiném pořadí → najde se ta správná
  const swapped = mkv([
    { id: 1, type: 'audio', codec: 'AC-3', properties: { language: 'cze', audio_channels: 2 } },
    { id: 2, type: 'audio', codec: 'DTS-HD Master Audio', properties: { language: 'eng', audio_channels: 6 } },
  ]);
  assert.strictEqual(mkvAudioId(swapped, a(1, 'cs', 2, 'ac3')), 1);
  assert.strictEqual(mkvAudioId(swapped, a(0, 'en', 6, 'dts')), 2);
  // nejednoznačné (dvě stejné stopy bez značek a pořadí nesedí) → raději nic
  const twins = mkv([
    { id: 1, type: 'audio', codec: 'AAC', properties: { language: 'und', audio_channels: 6 } },
    { id: 2, type: 'audio', codec: 'AAC', properties: { language: 'und', audio_channels: 2 } },
    { id: 3, type: 'audio', codec: 'AAC', properties: { language: 'und', audio_channels: 2 } },
  ]);
  assert.strictEqual(mkvAudioId(twins, a(0, null, 2, 'aac')), null);
  assert.strictEqual(mkvAudioId(twins, a(1, null, 2, 'aac')), 2, 'pořadí sedí');
  assert.strictEqual(mkvAudioId(twins, a(5, null, 6, 'aac')), 1, 'jediná šestikanálová');
});

// Merger.process s falešným sloučením: které chyby zablokují donor
async function processWith(errors, { okToo = false } = {}) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mfail-'));
  try {
    const store = { ...mkStore({ stagingDir: dir, retryOnStall: false }), log() {} };
    Object.assign(store.s, { merges: {}, proposals: {}, badDonors: {} });
    const qbit = { enabled: true, files: async () => errors.map((_, i) => ({ name: `Show.S01E0${i + 1}.CZ.mkv`, size: 5, priority: 1 })), delete: async () => {}, deleteTags: async () => {} };
    const sonarr = { command: async () => ({ id: 1 }) };
    const m = new Merger({ store, qbit, sonarr, notify: { download: async () => {} } });
    const targets = errors.map((_, i) => ({ path: path.join(dir, `lib${i}.mkv`), episodeNumbers: [i + 1], fileId: i + 1 }));
    if (okToo) targets.push({ path: path.join(dir, 'libok.mkv'), episodeNumbers: [9], fileId: 9 });
    for (const t of targets) fs.writeFileSync(t.path, 'x');
    m.targets = async () => targets;
    let n = 0;
    m.mergeOne = async (j, t) => {
      if (t.fileId === 9) return { path: t.path, out: t.path + '.out', fileId: 9 };
      throw errors[n++];
    };
    if (okToo) qbit.files = async () => [...errors.map((_, i) => ({ name: `Show.S01E0${i + 1}.CZ.mkv`, size: 5, priority: 1 })), { name: 'Show.S01E09.CZ.mkv', size: 5, priority: 1 }];
    const j = { id: 'mj', label: 'Show', title: 'Show S01 CZ', itemKey: 'sonarr:1:1', app: 'sonarr', arrId: 1, season: 1, need: 'cs', guid: 'g', savePath: dir, dir: path.join(dir, 'job'), state: 'ready', active: true, prev: {}, attempt: 1 };
    store.s.merges.mj = j;
    await m.process(j);
    return { j, store };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('sloučení: místní chyba (timeout ffmpeg, plný disk) donor nezablokuje, chyba donoru ano', async () => {
  const donorErr = (msg) => Object.assign(new Error(msg), { donor: true });
  let { j, store } = await processWith([new Error('ffmpeg selhal: timeout'), new Error('mkvmerge selhal: ENOSPC: no space left on device')]);
  assert.strictEqual(j.state, 'failed');
  assert.deepStrictEqual(Object.keys(store.s.badDonors), [], 'místní chyba → donor není nevhodný');
  assert.strictEqual(store.s.ignoredGuids.g, undefined);

  ({ j, store } = await processWith([donorErr('nesedí synchronizace – málo shod'), donorErr('jiná snímková frekvence (23.976 vs 25.000 fps)')]));
  assert.strictEqual(j.state, 'failed');
  assert.strictEqual(Object.keys(store.s.badDonors).length, 1);
  assert.ok(store.s.ignoredGuids.g);

  // smíšené: jedna chyba místní → donor nevylučovat
  ({ store } = await processWith([donorErr('nesedí synchronizace'), new Error('ffmpeg selhal: timeout')]));
  assert.deepStrictEqual(Object.keys(store.s.badDonors), []);

  // částečně sloučeno: zapamatuje se jen kvůli epizodám, za které může donor
  ({ j, store } = await processWith([new Error('ffmpeg selhal: timeout')], { okToo: true }));
  assert.strictEqual(j.state, 'importing');
  assert.deepStrictEqual(Object.keys(store.s.badDonors), []);
  ({ store } = await processWith([donorErr('donor nemá CZ stopu')], { okToo: true }));
  assert.match(Object.values(store.s.badDonors)[0].reason, /donor nemá CZ stopu/);
});

test('sloučení: nepovedený výstup se z out/ smaže, chyba výsledku není chyba donoru', async () => {
  const A = require('../src/audio');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mout-'));
  const real = { probe: A.probe, run: A.run, checkSync: A.checkSync };
  try {
    const target = path.join(dir, 'Film.mkv');
    const donor = path.join(dir, 'Film.CZ.mkv');
    const probe = (file, lang, codec) => ({ file, duration: 6000, startTime: 0, video: { fps: 23.976 }, audio: [{ index: 1, audioIndex: 0, lang, from: 'tag', codec, channels: 6, default: true }] });
    A.probe = async (f) => (f === target ? probe(target, 'en', 'eac3') : f === donor ? probe(donor, 'cs', 'ac3') : { file: f, duration: 6000, video: null, audio: [] });
    A.checkSync = async () => ({ ok: true, offsetMs: 40, matched: 8 });
    A.run = async (cmd, args) => {
      if (args[0] === '-J') return JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio', codec: args[1] === target ? 'E-AC-3' : 'AC-3', properties: { language: args[1] === target ? 'eng' : 'cze', audio_channels: 6 } }] });
      fs.writeFileSync(args[1], 'polovičatý výstup'); // mkvmerge -o <out>
      return '';
    };
    const store = { ...mkStore(), log() {} };
    Object.assign(store.s, { merges: {}, proposals: {} });
    store.s.items['radarr:1'] = {};
    const m = new Merger({ store, qbit: { enabled: true }, radarr: { languageObjs: async (codes) => codes.map((c) => ({ id: 0, name: c })) } });
    const j = { id: 'mo', itemKey: 'radarr:1', app: 'radarr', need: 'cs', dir: path.join(dir, 'job') };
    const err = await m.mergeOne(j, { path: target, fileId: 1 }, donor).then(() => null, (e) => e);
    assert.match(err.message, /výsledek nemá video/);
    assert.ok(!err.donor, 'za vadný výsledek nemůže donor');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'job', 'out')), [], 'výstup smazán');

    // mkvmerge vidí jiné stopy než ffprobe → nic nepřidávat
    A.run = async (cmd, args) => JSON.stringify({ tracks: [{ id: 1, type: 'audio', codec: 'AAC', properties: { language: 'eng', audio_channels: 2 } }] });
    const err2 = await m.mergeOne(j, { path: target, fileId: 1 }, donor).then(() => null, (e) => e);
    assert.match(err2.message, /nejde spárovat/);
  } finally {
    Object.assign(A, real);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jiná verze filmu: release se blokuje jen pro přidání zvuku a nabídne se výměna celého souboru', async () => {
  const os = require('node:os');
  const search = require('../src/search');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mcut-'));
  const realSearch = search.searchItem;
  try {
    const store = { ...mkStore({ stagingDir: dir, retryOnStall: true, maxRetries: 3, notifyProposals: true }), log() {} };
    Object.assign(store.s, { merges: {}, proposals: {}, badDonors: {} });
    const item = { key: 'radarr:141', app: 'radarr', arrId: 141, origLang: 'en',
      current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, sceneName: 'Film.2013.Extended.Edition.1080p.BluRay.x264-RiPPY' } };
    store.s.items[item.key] = item;
    store.s.proposals.old = { id: 'old', itemKey: item.key, status: 'grabbed', downloadId: 'mj', candidates: [{ kind: 'merge', guid: 'g', title: 'Film.2013.720p.BluRay.x264.CZ-FTU' }] };
    const fresh = { id: 'new', itemKey: item.key, status: 'pending', candidates: [
      { kind: 'merge', guid: 'g2', mergeLang: 'cs', title: 'Film.2013.BDRip.CZ', otherCut: true },
      { kind: 'language', guid: 'g', title: 'Film.2013.720p.BluRay.x264.CZ-FTU', tier: 2, quality: 'Bluray-720p' },
    ] };
    search.searchItem = async (ctx, it, opts) => { store.s.proposals.new = fresh; return { proposal: fresh }; };
    const sent = [];
    const qbit = { enabled: true, files: async () => [{ name: 'Film.CZ.mkv', size: 5, priority: 1 }], delete: async () => {}, deleteTags: async () => {} };
    const m = new Merger({ store, qbit, notify: { download: async (j, k) => sent.push(k), proposal: async (p) => sent.push(`proposal:${p.id}`) } });
    let started = 0;
    m.start = async () => { started++; return { id: 'x' }; };
    const target = path.join(dir, 'lib.mkv');
    fs.writeFileSync(target, 'x');
    m.targets = async () => [{ path: target, fileId: 42 }];
    m.mergeOne = async () => { throw Object.assign(new Error('délka se liší o 25 min – jiná verze filmu'), { donor: true, mismatch: true }); };
    const j = { id: 'mj', label: 'Film', title: 'Film.2013.720p.BluRay.x264.CZ-FTU', itemKey: item.key, app: 'radarr', arrId: 141, need: 'cs', guid: 'g',
      proposalId: 'old', savePath: dir, dir: path.join(dir, 'job'), state: 'ready', active: true, prev: {}, attempt: 1 };
    store.s.merges.mj = j;
    await m.process(j);
    assert.strictEqual(j.state, 'failed');
    assert.strictEqual(store.s.ignoredGuids.g, undefined, 'release se jako výměna souboru dál nabízí');
    assert.strictEqual(Object.keys(store.s.badDonors).length, 1, 'k přidání zvuku už ne');
    assert.strictEqual(started, 0, 'donor, který je podle názvu zase jiná verze, se sám nezkouší');
    assert.match(j.message, /žádný další vhodný donor · v Návrzích je výměna celého souboru za „Film\.2013\.720p\.BluRay\.x264\.CZ-FTU“ \(CZ Bluray-720p\)/);
    assert.strictEqual(j.offerProposalId, 'new');
    assert.strictEqual(store.s.proposals.old.status, 'expired', 'starý návrh nahradil nový');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(sent, ['failed', 'proposal:new']);

    // Vadný torrent (chybí stopa) se dál blokuje úplně
    store.s.merges.mj2 = { ...j, id: 'mj2', guid: 'gB', title: 'Jiny', state: 'ready', active: true, message: '' };
    m.mergeOne = async () => { throw Object.assign(new Error('donor nemá CZ stopu'), { donor: true }); };
    await m.process(store.s.merges.mj2);
    assert.ok(store.s.ignoredGuids.gB);
  } finally {
    search.searchItem = realSearch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jiná verze filmu: jednorázové odblokování dřív zablokovaných releasů', () => {
  const { unblockMismatchedDonors } = require('../src/merge');
  const store = mkStore();
  store.s.ignoredGuids = { gCut: 1, gDead: 1, gFps: 1 };
  store.s.badDonors = {
    a: { itemKey: 'radarr:1', guids: ['gCut'], reason: 'Nic nešlo sloučit: délka se liší o 25 min – jiná verze filmu' },
    b: { itemKey: 'radarr:2', guids: ['gDead'], reason: 'Žádný pokrok 3 h – torrent je nejspíš mrtvý' },
    c: { itemKey: 'radarr:3', guids: ['gFps'], reason: 'jiná snímková frekvence (23.976 vs 25.000 fps, zjištěno ze začátku donoru) – zvuk by se rozjížděl' },
  };
  assert.deepStrictEqual(unblockMismatchedDonors(store), ['radarr:1', 'radarr:3']);
  assert.deepStrictEqual(Object.keys(store.s.ignoredGuids), ['gDead']);
  store.s.ignoredGuids.gCut = 1;
  assert.deepStrictEqual(unblockMismatchedDonors(store), [], 'jen jednou');
});

test('jiná verze filmu: podle názvu – donor stejné verze napřed, výměna s varováním a bez automatiky', () => {
  const L = require('../src/lang');
  assert.strictEqual(L.editionOf('The.Hobbit.2013.Extended.Edition.1080p').key, 'extended');
  assert.strictEqual(L.editionOf('Hobit: Šmakova dračí poušť - Prodloužená verze (2013)(CZ)').key, 'extended');
  assert.strictEqual(L.editionOf('Aliens.1986.Directors.Cut.1080p').key, 'directors');
  assert.strictEqual(L.editionOf('Film.2013.720p.BluRay.x264.CZ-FTU').key, 'theatrical');
  assert.strictEqual(L.editionWarning('Film.Extended.1080p', 'Film EXTENDED (CZ)'), null);
  assert.match(L.editionWarning('Film.Extended.1080p', 'Film.720p.CZ'), /teď prodloužená verze \(Extended\), release nejspíš kino verze/);

  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = { key: 'radarr:1', app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, qrank: 35, sceneName: 'Film.2013.Extended.Edition.1080p.BluRay.x264-RiPPY' } };
  const rel = (guid, title, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 40, size: 3e9, protocol: 'torrent', quality: { quality: { name: 'Bluray-1080p', resolution: 1080, source: 'bluray' } }, languages: [], rejections: [], ...extra });
  const list = mergeCandidates(item, [rel('kino', 'Film (2013)(CZ/EN)[1080p]'), rel('ext', 'Film - Extended Edition (2013)(CZ)', { seeders: 5 })], ctx, helpers);
  assert.deepStrictEqual(list.map((c) => c.guid), ['ext', 'kino'], 'stejná verze napřed, i s méně seedy a bez EN');
  assert.match(list[1].warnings[0], /jiná verze filmu.*délka nejspíš nebude sedět/);

  const { evaluateReleases } = require('../src/search');
  const { candidates } = evaluateReleases(item, [rel('kino', 'Film (2013)(CZ/EN)[1080p]')], ctx);
  assert.match(candidates[0].warnings[0], /podle názvu jiná verze filmu/);
  require('../src/merge').rememberBadDonor(ctx.store, { id: 'j', itemKey: 'radarr:1', title: 'Film (2013)(CZ/EN)[1080p]', guid: 'kino' }, 'Nic nešlo sloučit: délka se liší o 25 min – jiná verze filmu');
  const again = evaluateReleases(item, [rel('kino', 'Film (2013)(CZ/EN)[1080p]')], ctx).candidates[0];
  assert.strictEqual(again.warnings[0], 'jiná verze filmu než stávající (délka se liší o 25 min)');
  ctx.store.settings.autoGrab = 'any';
  assert.strictEqual(autoAllowed(ctx.store, item, { ...again, confidence: 'sure', seeders: 40 }), false, 'jiný střih jen po schválení');
  assert.strictEqual(autoAllowed(ctx.store, item, { ...again, warnings: [], otherEdition: false, confidence: 'sure', seeders: 40 }), true);
});

test('neúspěšné sloučení: náhrada celým souborem říká, proč chybí "Přidat zvuk"', () => {
  const { evaluateReleases } = require('../src/search');
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = { key: 'radarr:2', app: 'radarr', origLang: 'en', current: { tier: 1, audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, qrank: 35, sceneName: 'Film.2015.1080p.BluRay.x264' } };
  const rel = { guid: 'hdtv', indexerId: 1, indexer: 'SkTorrent', title: 'Film (2015)(CZ)[1080p]', seeders: 40, size: 2.4e9, protocol: 'torrent', quality: { quality: { name: 'HDTV-1080p', resolution: 1080, source: 'television' } }, languages: [], rejections: [] };
  assert.ok(!evaluateReleases(item, [rel], ctx).candidates[0].notes.some((n) => /přidat zvuk nejde/.test(n)));
  require('../src/merge').rememberBadDonor(ctx.store, { id: 'j', itemKey: item.key, title: rel.title, guid: 'hdtv' }, 'Nic nešlo sloučit: nesedí synchronizace – stopy si neodpovídají (shoda jen v 4/8 místech) – jiná verze/střih?');
  const { candidates, merges } = evaluateReleases(item, [rel], ctx);
  assert.strictEqual(merges.length, 0);
  assert.strictEqual(candidates[0].notes[0], 'přidat zvuk nejde, sloučení neprošlo: nesedí synchronizace – stopy si neodpovídají (shoda jen v 4/8 místech) – jiná verze/střih? → jen výměna celého souboru');
  assert.strictEqual(candidates[0].badDonorId, Object.keys(ctx.store.s.badDonors)[0], 'z návrhu jde donor odblokovat a zkusit znovu');
  const queued = [];
  Object.assign(ctx.store.s, { merges: {}, proposals: {} });
  const m = new Merger({ store: { ...ctx.store, log() {} }, searcher: { enqueue: (k, o) => queued.push([k, o.reason]) } });
  ctx.store.s.items[item.key] = item;
  m.forgetBadDonor(candidates[0].badDonorId, { retry: true });
  assert.deepStrictEqual(queued, [[item.key, 'zkusit přidat zvuk']]);
  assert.strictEqual(evaluateReleases(item, [rel], ctx).merges.length, 1, 'přidání zvuku se nabídne znovu');
});

// --- Přidání zvuku ze sady torrentů jednotlivých epizod ------------------------------------------------
function setFixture({ heard = false } = {}) {
  const item = { key: 'sonarr:3:3', app: 'sonarr', arrId: 3, season: 3, origLang: 'en',
    current: { tier: 1, audioSource: heard ? 'poslech' : 'mediainfo', quality: 'WEBDL-1080p', res: 1080, qrank: 34, files: 3 } };
  const episodes = [1, 2, 3].map((n) => ({ id: 100 + n, seasonNumber: 3, episodeNumber: n, hasFile: true, episodeFileId: 200 + n }));
  // E03 už CZ má (značka v MediaInfo)
  const files = Object.fromEntries([1, 2, 3].map((n) => [200 + n, { id: 200 + n, mediaInfo: { audioLanguages: n === 3 ? 'English/Czech' : 'English' } }]));
  const rel = (guid, n, title, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 9, size: 1.5e9, protocol: 'torrent',
    fullSeason: false, seasonNumber: 3, mappedSeasonNumber: 3, mappedEpisodeInfo: [{ id: 100 + n, seasonNumber: 3, episodeNumber: n }],
    quality: { quality: { name: 'WEBDL-1080p', resolution: 1080, source: 'web' } }, languages: [], rejections: [], downloadUrl: `http://x/${guid}`, ...extra });
  return { item, episodes, files, rel };
}

test('sada epizod jako donor: každá epizoda bez CZ má vlastní torrent → jeden kandidát na přidání zvuku', () => {
  const { evaluateMergeSet } = require('../src/search');
  const { item, episodes, files, rel } = setFixture();
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const releases = [
    rel('e1', 1, 'The Grand Tour S03E01 - Motown Funk (2019)(CZ)[WEB-DL][1080p]'),
    rel('e1en', 1, 'The.Grand.Tour.S03E01.1080p.WEB.H264', { seeders: 200 }),
    rel('e2', 2, 'The Grand Tour S03E02 - Cesta do Kolumbie (2019)(CZ)[WEB-DL][720p]', { quality: { quality: { name: 'WEBDL-720p', resolution: 720 } } }),
    rel('e2guess', 2, 'The Grand Tour S03E02 1080p', { seeders: 300 }),
  ];
  const c = evaluateMergeSet(item, releases, ctx, { episodes, files });
  assert.ok(c);
  assert.strictEqual(c.kind, 'merge');
  assert.ok(c.set && c.guid.startsWith('mset:'));
  assert.strictEqual(c.mergeLang, 'cs');
  assert.strictEqual(c.quality, 'WEBDL-1080p', 'video zůstává stávající, 720p donor nevadí');
  assert.deepStrictEqual(c.parts.map((x) => [x.guid, x.episodes]), [['e1', [1]], ['e2', [2]]], 'E03 CZ už má – pro ni se nic nestahuje');
  assert.ok(c.parts.every((x) => x.downloadUrl), 'odkazy na torrenty pro qBittorrent');
  assert.strictEqual(c.size, 3e9);

  // Epizoda bez donoru → sada nejde
  assert.strictEqual(evaluateMergeSet(item, releases.filter((r) => r.guid !== 'e2'), ctx, { episodes, files }), null);
  // Neověřený jazyk stávajících souborů, nebo vypnuté slučování → nic
  assert.strictEqual(evaluateMergeSet({ ...item, current: { ...item.current, audioSource: 'nazev' } }, releases, ctx, { episodes, files }), null);
  assert.strictEqual(evaluateMergeSet(item, releases, { store: mkStore({ mergeEnabled: false }), qbit: { enabled: true } }, { episodes, files }), null);
  // Torrent, který už jako donor neprošel, se nevybere
  const store = mkStore();
  require('../src/merge').rememberBadDonor(store, { id: 'old', itemKey: item.key, title: releases[0].title, guid: 'e1' }, 'nesedí synchronizace');
  assert.strictEqual(evaluateMergeSet(item, releases, { store, qbit: { enabled: true } }, { episodes, files }), null);
  // Po poslechu značkám nevěřit – potřeba jsou donory pro všechny epizody
  const h = setFixture({ heard: true });
  assert.strictEqual(evaluateMergeSet(h.item, releases, ctx, { episodes, files }), null);
  assert.deepStrictEqual(evaluateMergeSet(h.item, [...releases, rel('e3', 3, 'The Grand Tour S03E03 (2019)(CZ)[1080p]')], ctx, { episodes, files }).parts.map((x) => x.guid), ['e1', 'e2', 'e3']);
});

test('sada epizod jako donor: víc torrentů v jedné úloze, epizoda podle torrentu, vadný torrent se zablokuje sám', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-mset-'));
  try {
    const store = { ...mkStore({ stagingDir: dir, retryOnStall: false }), log() {} };
    Object.assign(store.s, { merges: {}, proposals: {}, badDonors: {} });
    const item = { key: 'sonarr:3:3', app: 'sonarr', arrId: 3, season: 3, origLang: 'en', current: { tier: 1, audio: 'eng', quality: 'WEBDL-1080p', fileIds: [201, 202] } };
    store.s.items[item.key] = item;
    const part = (n) => ({ guid: `e${n}`, indexerId: 1, title: `The Grand Tour S03E0${n} (CZ)`, size: 5, seeders: 9, episodes: [n], episodeIds: [100 + n], downloadUrl: `http://x/e${n}` });
    const cand = { kind: 'merge', set: true, guid: 'mset:abc', title: 'Sada 2 epizod', indexer: 'SkTorrent', seeders: 9, mergeLang: 'cs', parts: [part(1), part(2)] };
    store.s.proposals.p = { id: 'p', itemKey: item.key, label: 'GT – 03. série', status: 'pending', searchedAt: Date.now(), candidates: [cand] };

    const torrents = {};
    const calls = [];
    const qbit = {
      enabled: true,
      ensureCategory: async () => {},
      add: async ({ tags, savepath }) => {
        const tag = tags.split(',').at(-1);
        const n = Number(tag.split('-').at(-1));
        // soubor v torrentu se jmenuje jinak než epizoda (bez SxxExx) – epizodu určí torrent
        torrents[tag] = { hash: `h${n}`, save_path: savepath, progress: 0, amount_left: 10, size: 10, num_seeds: 5, dlspeed: 0, state: 'downloading',
          files: [{ index: 0, name: `Motown Funk ${n}.mkv`, size: 5, priority: 1 }, { index: 1, name: 'info.nfo', size: 1, priority: 1 }] };
      },
      byTag: async (tag) => torrents[tag] || null,
      files: async (h) => Object.values(torrents).find((t) => t.hash === h).files,
      setFilePriority: async (h, ids, prio) => calls.push(['prio', h, ids, prio]),
      prioritizeStart: async () => {},
      delete: async (h) => calls.push(['delete', h]),
    };
    const sonarr = { command: async () => ({ id: 1 }) };
    const m = new Merger({ store, qbit, sonarr, busyKeys: () => new Set(), notify: { download: async () => {} } });
    const targets = [1, 2].map((n) => ({ path: path.join(dir, `lib${n}.mkv`), episodeNumbers: [n], episodeIds: [100 + n], fileId: 200 + n }));
    for (const t of targets) fs.writeFileSync(t.path, 'x');
    m.targets = async () => targets;

    const j = await m.start('p', 0);
    assert.strictEqual(j.parts.length, 2);
    assert.deepStrictEqual(Object.keys(torrents).sort(), [`ujob-${j.id}-1`, `ujob-${j.id}-2`]);
    assert.strictEqual(store.s.proposals.p.status, 'grabbed');

    await m.checkDownload(j); // výběr souborů v obou torrentech
    assert.ok(j.parts.every((x) => x.filesSelected));
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'prio').map((c) => c[2]), [[1], [1]], 'nfo vypnuto, video ne');
    for (const t of Object.values(torrents)) Object.assign(t, { progress: 1, amount_left: 0 });
    torrents[`ujob-${j.id}-2`].progress = 0.5;
    torrents[`ujob-${j.id}-2`].amount_left = 5;
    await m.checkDownload(j);
    assert.strictEqual(j.state, 'downloading', 'čeká na všechny torrenty');
    assert.strictEqual(j.progress, 0.75);
    Object.assign(torrents[`ujob-${j.id}-2`], { progress: 1, amount_left: 0 });
    await m.checkDownload(j);
    assert.strictEqual(j.state, 'ready');

    // E01 projde, E02 nesedí synchronizace → importuje se E01, zablokuje se jen torrent E02
    const used = [];
    m.mergeOne = async (jj, t, donorPath, p) => {
      used.push([t.fileId, path.basename(donorPath), p.guid]);
      if (t.fileId === 202) throw Object.assign(new Error('nesedí synchronizace – málo shod'), { donor: true, mismatch: true });
      return { path: t.path, out: t.path + '.out', fileId: t.fileId, episodeIds: t.episodeIds, languages: [] };
    };
    await m.process(j);
    assert.deepStrictEqual(used, [[201, 'Motown Funk 1.mkv', 'e1'], [202, 'Motown Funk 2.mkv', 'e2']]);
    assert.strictEqual(j.state, 'importing');
    const bad = Object.values(store.s.badDonors);
    assert.deepStrictEqual(bad.map((b) => b.guids), [['e2']]);
    assert.strictEqual(store.s.ignoredGuids.e2, undefined, 'jen nesedí – jako výměna epizody se nabízet smí');

    // Pročištění návrhů: sada s vadným torrentem se už nenabídne
    const { pruneBadDonorCandidates } = require('../src/merge');
    store.s.proposals.q = { status: 'pending', itemKey: item.key, candidates: [{ ...cand, guid: 'mset:other' }, { kind: 'language', guid: 'x' }] };
    assert.strictEqual(pruneBadDonorCandidates(store), 1);

    // Mrtvý torrent sady → selže celá úloha, ale zablokuje se jen ten torrent a smažou se všechny
    const j2 = { ...j, id: 'j2', state: 'downloading', active: true, parts: j.parts.map((x) => ({ ...x })), finishedAt: null };
    store.s.merges.j2 = j2;
    calls.length = 0;
    await m.fail(j2, 'Žádný pokrok', { retry: true, part: j2.parts[0] });
    assert.strictEqual(j2.state, 'failed');
    assert.ok(store.s.ignoredGuids.e1);
    assert.strictEqual(store.s.ignoredGuids['mset:abc'], undefined);
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'delete').map((c) => c[1]), ['h1', 'h2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup smaže z qBittorrentu i ujob tagy (jinak v něm zůstanou po smazaném torrentu)', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-ctags-'));
  try {
    const calls = [];
    const qbit = { enabled: true, byTag: async () => null, delete: async (h) => calls.push(['delete', h]), deleteTags: async (t) => calls.push(['deleteTags', t]) };
    const store = { ...mkStore(), log() {} };
    store.s.merges = {};
    const m = new Merger({ store, qbit });
    await m.cleanup({ id: 'abc', hash: 'h0', dir: path.join(dir, 'a') }, { deleteTorrent: true });
    await m.cleanup({ id: 'set', dir: path.join(dir, 'b'), parts: [{ hash: 'h1', tag: 'ujob-set-1' }, { tag: 'ujob-set-2' }] }, { deleteTorrent: true });
    await m.cleanup({ id: 'keep', hash: 'h9', dir: path.join(dir, 'c') }, { deleteTorrent: false });
    assert.deepStrictEqual(calls, [
      ['delete', 'h0'], ['deleteTags', 'ujob-abc'],
      ['delete', 'h1'], ['deleteTags', 'ujob-set,ujob-set-1,ujob-set-2'],
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

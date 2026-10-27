const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('../src/audio');
const { DubSync, pickTracks, syncSummary, syncable, uncheckedIds, describeOffset } = require('../src/dubsync');
const { DEFAULT_SETTINGS } = require('../src/store');

const anchor = (at, offsetMs, z = 20) => ({ at, offsetMs, z });

test('spreadOrder – první místa pokryjí celý film, žádné se neopakuje', () => {
  assert.deepStrictEqual(A.spreadOrder(8), [0, 7, 4, 2, 5, 1, 3, 6]);
  for (const n of [1, 2, 3, 5, 6, 8, 12]) assert.deepStrictEqual([...A.spreadOrder(n)].sort((a, b) => a - b), [...Array(n).keys()]);
});

test('syncVerdict – shoda, jiný střih, málo platných míst', () => {
  const ok = A.syncVerdict([anchor(1, -315), anchor(2, -317), anchor(3, -350), anchor(4, -319), anchor(5, -350), anchor(6, -348), anchor(7, -380), anchor(8, -319, 3)]);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.matched, '7/8');
  assert.ok(Math.abs(ok.offsetMs + 340) <= 5, `${ok.offsetMs}`);

  const cut = A.syncVerdict([anchor(1, 0), anchor(2, 0), anchor(3, 0), anchor(4, 1200), anchor(5, 1200), anchor(6, 1200), anchor(7, 2500), anchor(8, 2500)]);
  assert.strictEqual(cut.ok, false);
  assert.match(cut.reason, /mění o 2500 ms/);

  const weak = A.syncVerdict([anchor(1, 0, 3), anchor(2, 0, 2), anchor(3, 0), anchor(4, 0), anchor(5, 0, 1)]);
  assert.strictEqual(weak.ok, false);
  assert.match(weak.reason, /shoda jen v 2/);
});

test('canStopEarly – skončí, až když je výsledek jistý', () => {
  const o = { anchors: 8, minValid: 5, toleranceMs: 60, minZ: 7 };
  assert.strictEqual(A.canStopEarly([anchor(1, -340), anchor(2, -330), anchor(3, -350), anchor(4, -320)], o), false, '4 shody nestačí');
  assert.strictEqual(A.canStopEarly([anchor(1, -340), anchor(2, -330), anchor(3, -350), anchor(4, -320), anchor(5, -335)], o), true);
  assert.strictEqual(A.canStopEarly([anchor(1, -340), anchor(2, -330), anchor(3, -350), anchor(4, -320), anchor(5, 400)], o), false, 'odlehlé místo → měřit dál');
  assert.strictEqual(A.canStopEarly([anchor(1, 0, 2), anchor(2, 0, 3), anchor(3, 0, 1), anchor(4, 0, 4)], o), true, 'už nemůže vyjít');
  // Bez nadpoloviční většiny by zbylá místa mohla posunout medián → nikdy předčasně „ok“
  assert.strictEqual(A.canStopEarly([anchor(1, 0), anchor(2, 0), anchor(3, 0), anchor(4, 0)], { ...o, minValid: 4 }), false);
});

test('pickTracks – EN podle značky, CZ výchozí napřed, bez komentářů', () => {
  const a = (audioIndex, lang, extra = {}) => ({ index: audioIndex + 1, audioIndex, lang, from: 'tag', default: false, title: '', ...extra });
  const t = pickTracks([
    a(0, 'en', { title: 'Commentary', default: true }),
    a(1, 'en', { from: 'title' }),
    a(2, 'en'),
    a(3, 'cs', { title: 'CZ 2.0' }),
    a(4, 'cs', { title: 'CZ 5.1', default: true }),
    a(5, 'cs', { title: 'Komentář režiséra' }),
  ]);
  assert.strictEqual(t.ref.audioIndex, 2);
  assert.strictEqual(t.primary.audioIndex, 4);
  assert.deepStrictEqual(t.dubs.map((d) => d.audioIndex), [4, 3]);
  assert.strictEqual(pickTracks([a(0, 'cs'), a(1, 'sk')]), null);
});

test('syncSummary – film a seriál (nejhorší epizoda), staré soubory se nepočítají', () => {
  assert.strictEqual(syncSummary({ current: { fileIds: [1] } }), null);
  const movie = { current: { fileIds: [7] }, syncCheck: { files: { 7: { at: '2026-10-15T08:00:00.000Z', ok: true, offsetMs: -340, matched: '5/6', name: 'IM2.mkv' }, 3: { ok: true, offsetMs: 900 } } } };
  const m = syncSummary(movie, 80);
  assert.deepStrictEqual({ offsetMs: m.offsetMs, matched: m.matched, warn: m.warn, bad: m.bad, total: m.total }, { offsetMs: -340, matched: '5/6', warn: true, bad: 1, total: 1 });
  assert.strictEqual(syncSummary(movie, 400).warn, false, 'práh z nastavení');

  const season = { current: { fileIds: [1, 2, 3, 4] }, syncCheck: { files: {
    1: { at: '2026-10-14T10:00:00.000Z', ok: true, offsetMs: 10, matched: '5/5' },
    2: { at: '2026-10-15T10:00:00.000Z', ok: true, offsetMs: 120, matched: '5/6', name: 'S01E02.mkv' },
    3: { at: '2026-10-13T10:00:00.000Z', ok: true, offsetMs: -200, matched: '6/7', name: 'S01E03.mkv' },
  } } };
  const s = syncSummary(season, 80);
  assert.strictEqual(s.offsetMs, -200);
  assert.strictEqual(s.bad, 2);
  assert.strictEqual(s.checked, 3);
  assert.strictEqual(s.at, '2026-10-15T10:00:00.000Z');
  assert.deepStrictEqual(s.badFiles.map((f) => f.fileId), [2, 3]);

  const failed = syncSummary({ current: { fileIds: [5] }, syncCheck: { files: { 5: { at: 'x', ok: false, reason: 'jiný střih' } } } });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.warn, false);
  assert.strictEqual(failed.reason, 'jiný střih');
});

test('syncable – jen CZ i EN ověřené ze stop; české dílo jen s CZ se neměří', () => {
  const it = (audio, extra = {}) => ({ current: { tier: 3, audioSource: 'mediainfo', audio, ...extra } });
  assert.strictEqual(syncable(it('cze/eng')), true);
  assert.strictEqual(syncable(it('eng/cze | cze/eng/slo')), true);
  assert.strictEqual(syncable(it('cze')), false, 'origLang cz → tier 3 i bez EN');
  assert.strictEqual(syncable(it('cze/eng', { audioSource: 'nazev' })), false);
  assert.strictEqual(syncable(it('cze/eng', { tier: 2 })), false);
  // Epizoda bez EN v jinak dvojjazyčné sérii se do souhrnu nepočítá
  const s = syncSummary({ current: { fileIds: [1, 2] }, syncCheck: { files: { 1: { at: 'a', ok: true, offsetMs: 20, matched: '5/5' }, 2: { at: 'b', ok: false, skipped: true } } } });
  assert.deepStrictEqual([s.ok, s.checked, s.total, s.warn], [true, 1, 1, false]);
});

test('uncheckedIds – nezměřené a chyby starší než den', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const item = { current: { fileIds: [1, 2, 3, 4] }, syncCheck: { files: {
    1: { at: '2026-10-15T11:00:00Z', ok: true, offsetMs: 0 },
    2: { at: '2026-10-15T11:00:00Z', ok: false, error: 'ffmpeg: …' },
    3: { at: '2026-10-14T11:00:00Z', ok: false, error: 'ffmpeg: …' },
  } } };
  assert.deepStrictEqual(uncheckedIds(item, undefined, now), [3, 4]);
});

test('describeOffset – záporná korekce = dabing se zpožďuje', () => {
  assert.strictEqual(describeOffset(-340), '340 ms (zpožďuje se)');
  assert.strictEqual(describeOffset(120), '120 ms (předbíhá)');
});

// --- DubSync s podvrženým Radarrem a nástroji (bez skutečných souborů v knihovně) -------------------

function mkCtx(dir, { movieFile, settings = {} } = {}) {
  const logs = [];
  const commands = [];
  const store = {
    settings: { ...DEFAULT_SETTINGS, stagingDir: path.join(dir, 'staging'), keepBackupDays: 7, ...settings },
    s: { items: {}, syncFixes: {}, merges: {}, downloads: {} },
    save() {},
    log(level, msg) { logs.push({ level, msg }); },
  };
  const radarr = {
    movieFile,
    async get(p) {
      assert.match(p, /^\/movie\/45$/);
      return { id: 45, movieFile: this.movieFile };
    },
    async command(body) { commands.push(body); return { id: 1 }; },
  };
  const ctx = {
    store, radarr, sonarr: null,
    merger: { active: () => [] },
    notify: { download: async () => {} },
    busyKeys: () => new Set(Object.values(store.s.syncFixes).filter((j) => j.active).map((j) => j.itemKey)),
  };
  return { ctx, logs, commands };
}

function withAudioMocks(mocks, fn) {
  const orig = { probe: A.probe, checkSync: A.checkSync, run: A.run };
  Object.assign(A, mocks);
  return Promise.resolve().then(fn).finally(() => Object.assign(A, orig));
}

const probeOf = (file, { duration = 7400, audio } = {}) => ({
  file, duration, startTime: 0, size: 1, video: { codec: 'hevc', width: 3840, height: 1600, fps: 23.976 },
  audio: audio || [
    { index: 1, audioIndex: 0, lang: 'cs', from: 'tag', default: true, title: 'CZ 5,1 DD', codec: 'eac3', channels: 6 },
    { index: 2, audioIndex: 1, lang: 'en', from: 'tag', default: false, title: 'EN 5.1 DD', codec: 'eac3', channels: 6 },
  ],
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-sync-'));
  const lib = path.join(dir, 'movies', 'Iron Man 2 (2010)');
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, 'Iron Man 2 (2010) WEBDL-2160p.mkv');
  fs.writeFileSync(file, 'original');
  const movieFile = {
    id: 899, path: file, size: 8, quality: { quality: { id: 18, name: 'WEBDL-2160p' } }, languages: [{ id: 25, name: 'Czech' }, { id: 1, name: 'English' }],
    releaseGroup: 'XYZ', mediaInfo: { audioLanguages: 'cze/eng' },
  };
  const { ctx, logs, commands } = mkCtx(dir, { movieFile });
  const item = {
    key: 'radarr:45', app: 'radarr', arrId: 45, season: null, title: 'Iron Man 2', year: 2010, origLang: 'en',
    current: { tier: 3, audio: 'cze/eng', audioSource: 'mediainfo', quality: 'WEBDL-2160p', fileIds: [899], files: 1 },
  };
  ctx.store.s.items[item.key] = item;
  return { dir, file, movieFile, ctx, logs, commands, item };
}

test('kontrola na pozadí – uloží syncCheck k položce, varuje a dodrží pauzu', async () => {
  const { dir, file, ctx, logs, item } = setup();
  const sync = new DubSync(ctx);
  const calls = [];
  await withAudioMocks({
    probe: async (f) => probeOf(f),
    checkSync: async (ref, donor, opts) => {
      calls.push({ ref: ref.stream, donor: donor.stream, opts });
      return { ok: true, offsetMs: -337, matched: '5/6', anchors: [] };
    },
  }, async () => {
    await sync.tick();
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual([calls[0].ref, calls[0].donor], [2, 1], 'EN proti CZ ze stejného souboru');
    assert.ok(calls[0].opts.earlyStop && calls[0].opts.lowPriority && calls[0].opts.maxOffsetSec <= 10, 'šetrné měření');
    assert.strictEqual(item.syncCheck.offsetMs, -337);
    assert.strictEqual(item.syncCheck.matched, '5/6');
    assert.ok(Date.parse(item.syncCheck.at) > 0);
    assert.strictEqual(item.syncCheck.files[899].track, 'CZ 5,1 DD');
    assert.ok(logs.some((l) => l.level === 'warn' && /CZ dabing posunutý o 337 ms \(zpožďuje se\)/.test(l.msg)));
    assert.strictEqual(sync.summary(item).warn, true);

    // Hotovo → další tick nic neměří; „Změřit znovu“ změří hned i přes pauzu a vypnutou kontrolu
    ctx.store.settings.syncCheckEnabled = false;
    await sync.tick();
    assert.strictEqual(calls.length, 1);
    await new Promise((r) => setTimeout(r, 5));
    sync.enqueue(item.key);
    assert.strictEqual(sync.queued(item.key), true);
    await sync.tick();
    assert.strictEqual(calls.length, 2);
    await sync.tick();
    assert.strictEqual(sync.queued(item.key), false, 'po přeměření pryč z fronty');
    assert.strictEqual(calls.length, 2);
  });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kontrola na pozadí – během slučování se disk nechá na pokoji', async () => {
  const { dir, ctx, item } = setup();
  ctx.merger = { active: () => [{ state: 'processing', itemKey: 'radarr:1' }] };
  const sync = new DubSync(ctx);
  let n = 0;
  await withAudioMocks({ probe: async (f) => probeOf(f), checkSync: async () => { n++; return { ok: true, offsetMs: 0, matched: '5/5' }; } }, async () => {
    await sync.tick();
  });
  assert.strictEqual(n, 0);
  assert.strictEqual(item.syncCheck, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – změří, posune CZ přes mkvmerge --sync, ověří, zazálohuje (hardlink) a naimportuje', async () => {
  const { dir, file, movieFile, ctx, commands, item } = setup();
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: -337, matched: '5/6', name: path.basename(file) } } };
  const sync = new DubSync(ctx);
  const mkv = [];
  let fixed = false;
  await withAudioMocks({
    probe: async (f) => probeOf(f),
    checkSync: async (ref, donor, opts) => {
      if (ref.file === file) {
        assert.ok(!opts.earlyStop, 'před opravou všech 8 míst');
        return { ok: true, offsetMs: -340, matched: '7/8' };
      }
      return { ok: true, offsetMs: fixed ? 3 : -340, matched: '6/6' };
    },
    run: async (cmd, args) => {
      assert.strictEqual(cmd, 'mkvmerge');
      if (args[0] === '-J') return JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'audio' }, { id: 3, type: 'subtitles' }] });
      mkv.push(args);
      fs.writeFileSync(args[1], 'fixed');
      fixed = true;
      return '';
    },
  }, async () => {
    const j = sync.start(item.key);
    assert.throws(() => sync.start(item.key), /právě běží/);
    await sync.tick();
    assert.strictEqual(j.state, 'importing', j.message);
    assert.deepStrictEqual(mkv[0].slice(2), ['--enable-legacy-font-mime-types', '--sync', '1:-340', file], 'posune se jen CZ stopa (TID 1)');
    const r = j.results[0];
    assert.deepStrictEqual([r.offsetMs, r.verifyMs, r.verifyMatched], [-340, 3, '6/6']);

    // Záloha = hardlink originálu ve stagingDir/backup/<id>
    const backup = path.join(ctx.store.settings.stagingDir, 'backup', j.id, path.basename(file));
    assert.strictEqual(fs.statSync(backup).ino, fs.statSync(file).ino);
    // Import přes Radarr ManualImport, knihovní soubor zatím netknutý
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].name, 'ManualImport');
    assert.strictEqual(commands[0].importMode, 'move');
    assert.deepStrictEqual(commands[0].files[0].movieId, 45);
    assert.strictEqual(commands[0].files[0].path, r.out);
    assert.strictEqual(commands[0].files[0].quality.quality.name, 'WEBDL-2160p');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');

    // Radarr soubor vyměnil → hotovo, k novému souboru se uloží ověřené měření
    fs.unlinkSync(file);
    fs.renameSync(r.out, file);
    ctx.radarr.movieFile = { ...movieFile, id: 950 };
    await sync.tick();
    assert.strictEqual(j.state, 'done', j.message);
    assert.deepStrictEqual(item.current.fileIds, [950]);
    assert.strictEqual(item.syncCheck.offsetMs, 3);
    assert.strictEqual(item.syncCheck.files[950].fixedFrom, -340);
    assert.strictEqual(item.syncCheck.files[899], undefined);
    assert.strictEqual(sync.summary(item).warn, false);
    assert.ok(!fs.existsSync(j.dir), 'pracovní adresář uklizen');
    assert.ok(fs.existsSync(backup), 'záloha zůstává');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – když výsledek nesedí, nic se neimportuje a knihovna zůstane beze změny', async () => {
  const { dir, file, ctx, commands, item } = setup();
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: -337, matched: '5/6' } } };
  const sync = new DubSync(ctx);
  await withAudioMocks({
    probe: async (f) => probeOf(f),
    checkSync: async (ref) => (ref.file === file ? { ok: true, offsetMs: -340, matched: '7/8' } : { ok: true, offsetMs: -180, matched: '6/6' }),
    run: async (cmd, args) => {
      if (args[0] === '-J') return JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'audio' }] });
      fs.writeFileSync(args[1], 'fixed');
      return '';
    },
  }, async () => {
    const j = sync.start(item.key);
    await sync.tick();
    assert.strictEqual(j.state, 'failed');
    assert.match(j.message, /pořád nesedí \(-180 ms\)/);
    assert.match(j.message, /knihovna zůstala beze změny/);
    assert.strictEqual(commands.length, 0);
    assert.ok(!fs.existsSync(j.dir));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – výsledek se ověřuje v místech, kde měření před opravou vyšlo spolehlivě', async () => {
  const { dir, file, ctx, item } = setup();
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: 154, matched: '6/8' } } };
  const sync = new DubSync(ctx);
  let verifyOpts = null;
  const before = [anchor(589, 171, 5.2), anchor(1472, 168, 8.1), anchor(2356, 161), anchor(3239, 160, 5.7), anchor(4123, 151), anchor(5006, 150), anchor(5890, 142), anchor(6773, 140)];
  await withAudioMocks({
    probe: async (f) => probeOf(f),
    checkSync: async (ref, donor, opts) => {
      if (ref.file === file) return { ok: true, offsetMs: 152, matched: '6/8', anchors: before };
      verifyOpts = opts;
      return { ok: true, offsetMs: -2, matched: '5/6' };
    },
    run: async (cmd, args) => {
      if (args[0] === '-J') return JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'audio' }] });
      fs.writeFileSync(args[1], 'fixed');
      return '';
    },
  }, async () => {
    const j = sync.start(item.key);
    await sync.tick();
    assert.strictEqual(j.state, 'importing', j.message);
    assert.deepStrictEqual(verifyOpts.times, [1472, 2356, 4123, 5006, 5890, 6773], 'jen místa se z >= 7');
    assert.strictEqual(verifyOpts.minValid, 4);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – do složky knihovny nejde zapisovat → nic se nevyrábí ani neimportuje', { skip: process.getuid?.() === 0 && 'root může zapisovat všude' }, async () => {
  const { dir, file, ctx, commands, item } = setup();
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: 220, matched: '8/8' } } };
  const sync = new DubSync(ctx);
  let mkvmerge = 0;
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    await withAudioMocks({
      probe: async (f) => probeOf(f),
      checkSync: async () => ({ ok: true, offsetMs: 220, matched: '8/8' }),
      run: async () => { mkvmerge++; return '{}'; },
    }, async () => {
      const j = sync.start(item.key);
      await sync.tick();
      assert.strictEqual(j.state, 'failed');
      assert.match(j.message, /nejde zapisovat/);
      assert.strictEqual(mkvmerge, 0);
      assert.strictEqual(commands.length, 0);
    });
  } finally {
    fs.chmodSync(path.dirname(file), 0o755);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – po přesném změření sedí → nic se nemění', async () => {
  const { dir, file, ctx, commands, item } = setup();
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: -95, matched: '5/6' } } };
  const sync = new DubSync(ctx);
  let mkvmerge = 0;
  await withAudioMocks({
    probe: async (f) => probeOf(f),
    checkSync: async () => ({ ok: true, offsetMs: -30, matched: '8/8' }),
    run: async () => { mkvmerge++; return '{}'; },
  }, async () => {
    const j = sync.start(item.key);
    await sync.tick();
    assert.strictEqual(j.state, 'done');
    assert.strictEqual(mkvmerge, 0);
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(item.syncCheck.offsetMs, -30);
    assert.strictEqual(sync.summary(item).warn, false);
  });
  assert.throws(() => sync.start(item.key), /dabing sedí/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oprava – bez stagingu pro aplikaci položky se nezaloží (relativní složka)', () => {
  const { dir, ctx, item } = setup();
  Object.assign(ctx.store.settings, { stagingDir: '', stagingDirSonarr: path.join(dir, 'tv-staging') });
  item.syncCheck = { files: { 899: { at: new Date().toISOString(), ok: true, offsetMs: -337, matched: '5/6' } } };
  const sync = new DubSync(ctx);
  assert.throws(() => sync.start(item.key), /pracovní složka/);
  assert.deepStrictEqual(Object.keys(ctx.store.s.syncFixes), []);
  ctx.store.settings.stagingDirRadarr = path.join(dir, 'movie-staging');
  const j = sync.start(item.key);
  assert.strictEqual(path.dirname(j.dir), path.join(dir, 'movie-staging'));
  delete ctx.store.s.syncFixes[j.id]; // úlohu nespouštět
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hromadná oprava – založí jen posunuté a volné položky, ostatní přeskočí', async () => {
  const { dir, ctx, item } = setup();
  const now = new Date().toISOString();
  item.syncCheck = { files: { 899: { at: now, ok: true, offsetMs: -337, matched: '5/6' } } };
  const mk = (key, offsetMs) => {
    const it = { ...item, key, arrId: Number(key.split(':')[1]), current: { ...item.current, fileIds: [1] }, syncCheck: { files: { 1: { at: now, ok: true, offsetMs, matched: '6/6' } } } };
    ctx.store.s.items[key] = it;
    return it;
  };
  mk('radarr:46', -20);  // sedí
  mk('radarr:47', 150);  // posunutý, ale už se opravuje
  mk('radarr:48', 210);  // posunutý, nepatří do výběru
  ctx.store.s.syncFixes.x = { id: 'x', active: true, state: 'importing', itemKey: 'radarr:47' };
  const sync = new DubSync(ctx);
  sync.tick = async () => {}; // zpracování se tu netestuje
  const r = sync.startAll(['radarr:45', 'radarr:46', 'radarr:47', 'radarr:nic']);
  assert.deepStrictEqual(r.started.map((j) => j.itemKey), ['radarr:45']);
  assert.deepStrictEqual(r.skipped.map((s) => s.key), ['radarr:47']);
  const all = sync.startAll();
  assert.deepStrictEqual(all.started.map((j) => j.itemKey), ['radarr:48'], 'bez výběru všechny posunuté; 45 už běží');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Skutečné měření přes ffmpeg na syntetickém souboru (posun známý předem) -------------------------

function hasTool(t) {
  try { execFileSync(t, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function wav(file, samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  fs.writeFileSync(file, b);
}

test('checkSync – CZ stopa zpožděná o 250 ms ve stejném souboru (ffmpeg)', { skip: !hasTool('ffmpeg') && 'chybí ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-sync-'));
  const rate = 8000;
  const secs = 240;
  // „Ruchy“: náhodné krátké zvuky (deterministický generátor), dabing = totéž o 250 ms později
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const en = new Float32Array(rate * secs);
  for (let t = 0.2; t < secs - 1; t += 0.15 + rnd() * 0.6) {
    const at = Math.floor(t * rate);
    const len = Math.floor((0.03 + rnd() * 0.15) * rate);
    const amp = 0.2 + rnd() * 0.6;
    for (let i = 0; i < len; i++) en[at + i] += amp * (rnd() * 2 - 1) * Math.exp((-4 * i) / len);
  }
  const shift = Math.round(0.25 * rate);
  const cz = new Float32Array(en.length);
  cz.set(en.subarray(0, en.length - shift), shift);
  wav(path.join(dir, 'en.wav'), en, rate);
  wav(path.join(dir, 'cz.wav'), cz, rate);
  const mkv = path.join(dir, 'film.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'cz.wav'), '-i', path.join(dir, 'en.wav'), '-map', '0:a', '-map', '1:a',
    '-c:a', 'flac', '-metadata:s:a:0', 'language=cze', '-metadata:s:a:1', 'language=eng', mkv]);

  const p = await A.probe(mkv);
  const tr = pickTracks(p.audio);
  assert.deepStrictEqual([tr.primary.lang, tr.ref.lang], ['cs', 'en']);
  const T = (a) => ({ file: p.file, duration: p.duration, startTime: p.startTime, stream: a.index });
  const r = await A.checkSync(T(tr.ref), T(tr.primary), { maxOffsetSec: 10, segmentSec: 20, earlyStop: true, lowPriority: true });
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(Math.abs(r.offsetMs + 250) <= 10, `naměřeno ${r.offsetMs} ms`);
  assert.ok(r.anchors.length < 8, 'předčasné ukončení ušetřilo čtení');
  // Stejné stopy proti sobě → nula
  const z = await A.checkSync(T(tr.ref), T(tr.ref), { maxOffsetSec: 10, segmentSec: 20 });
  assert.strictEqual(z.offsetMs, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('streamLang – „SK dabing“ je slovenský, „dabing“ a „Čeština“ český', () => {
  const lang = (title) => A.streamLang({ tags: { title } }).lang;
  assert.strictEqual(lang('SK dabing'), 'sk');
  assert.strictEqual(lang('Slovak dabing DD5.1'), 'sk');
  assert.strictEqual(lang('CZ dabing'), 'cs');
  assert.strictEqual(lang('dabing'), 'cs');
  assert.strictEqual(lang('Čeština DTS'), 'cs');
  assert.strictEqual(lang('česky'), 'cs');
  assert.strictEqual(lang('English'), 'en');
});

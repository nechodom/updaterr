const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backups, plan, expiryAt, addedAudio, fileIssues } = require('../src/backups');

const DAY = 86400e3;
const GB = 1024 ** 3;
const NOW = 100 * DAY;
const bk = (id, extra = {}) => ({ id, keep: 'auto', state: 'done', active: false, finishedAt: NOW - 3 * DAY, createdAt: NOW - 3 * DAY, expiresAt: NOW + 4 * DAY, exclusive: 5 * GB, ...extra });

test('retence podle dní: hotové od dokončení, nepovedený import aspoň 30 dní', () => {
  assert.strictEqual(expiryAt(bk('a'), 7), NOW + 4 * DAY);
  assert.strictEqual(expiryAt(bk('a'), 2), NOW - DAY);
  assert.strictEqual(expiryAt(bk('b', { state: 'blocked' }), 2), NOW + 27 * DAY);
  assert.deepStrictEqual(plan([bk('a'), bk('b', { state: 'blocked' })], { days: 2 }, NOW), [{ id: 'a', why: 'age' }]);
});

test('vlastní termín, natrvalo a záloha bez úlohy se podle dní nemažou', () => {
  const list = [
    bk('c', { keep: 'custom', expiresAt: NOW + 50 * DAY }),
    bk('f', { keep: 'forever', expiresAt: null }),
    bk('o', { keep: 'orphan', expiresAt: null }),
    bk('r', { active: true, state: 'importing' }),
  ];
  assert.deepStrictEqual(plan(list, { days: 0 }, NOW), []);
  assert.deepStrictEqual(plan([bk('c', { keep: 'custom', expiresAt: NOW - 1 })], { days: 365 }, NOW), [{ id: 'c', why: 'age' }]);
});

test('limit velikosti maže od nejstarších a počítá jen místo, které zálohy opravdu zabírají', () => {
  const list = [
    bk('new', { createdAt: NOW - DAY }),
    bk('old', { createdAt: NOW - 5 * DAY }),
    bk('mid', { createdAt: NOW - 3 * DAY }),
    bk('linked', { createdAt: NOW - 9 * DAY, exclusive: 0 }), // hardlink s knihovnou – smazáním nic neuvolní
    bk('pinned', { createdAt: NOW - 10 * DAY, keep: 'forever', expiresAt: null }),
    bk('blocked', { createdAt: NOW - 10 * DAY, state: 'blocked' }),
  ];
  // celkem 25 GB, limit 12 → old, mid a new (zbydou pinned + blocked = 10 GB); linked by nic neuvolnila
  assert.deepStrictEqual(plan(list, { days: 30, maxBytes: 12 * GB }, NOW), [{ id: 'old', why: 'size' }, { id: 'mid', why: 'size' }, { id: 'new', why: 'size' }]);
  assert.deepStrictEqual(plan(list, { days: 30, maxBytes: 20 * GB }, NOW), [{ id: 'old', why: 'size' }]);
  assert.deepStrictEqual(plan(list, { days: 30, maxBytes: 0 }, NOW), []);
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-bk-'));
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib);
  const mk = (id, name, size, linked) => {
    const dir = path.join(root, 'backup', id);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(lib, name);
    fs.writeFileSync(src, Buffer.alloc(size));
    fs.linkSync(src, path.join(dir, name));
    if (!linked) fs.rmSync(src); // jako po importu: originál z knihovny pryč
  };
  mk('aaa', 'Film A.mkv', 3000, false);
  mk('bbb', 'Film B.mkv', 2000, true);
  mk('ccc', 'Neznámý.mkv', 1000, false);
  const logs = [];
  const now = Date.now();
  const s = {
    settings: { stagingDir: root, keepBackupDays: 7, maxBackupGB: 0 },
    merges: {
      aaa: { id: 'aaa', type: 'merge', label: 'Film A', state: 'done', finishedAt: now - 10 * DAY, importAt: now - 10 * DAY, backupDir: path.join(root, 'backup', 'aaa'), backupUntil: now + DAY },
    },
    syncFixes: {
      bbb: { id: 'bbb', type: 'syncfix', label: 'Film B', state: 'done', finishedAt: now - DAY, importAt: now - DAY, backupDir: path.join(root, 'backup', 'bbb'), backupUntil: now + 6 * DAY },
    },
  };
  const ctx = { store: { s, settings: s.settings, save() {}, log: (lvl, msg) => logs.push(msg) } };
  return { root, ctx, b: new Backups(ctx), logs };
}

test('přehled: velikost, sdílené hardlinky a zálohy bez úlohy', () => {
  const { root, b } = setup();
  try {
    const o = b.overview();
    assert.strictEqual(o.backups.length, 3);
    assert.strictEqual(o.size, 6000);
    assert.strictEqual(o.exclusive, 4000);
    const byId = Object.fromEntries(o.backups.map((x) => [x.id, x]));
    assert.strictEqual(byId.bbb.files[0].shared, true);
    assert.strictEqual(byId.bbb.exclusive, 0);
    assert.strictEqual(byId.ccc.keep, 'orphan');
    assert.strictEqual(byId.ccc.expiresAt, null);
    assert.strictEqual(byId.aaa.type, 'merge');
    // aaa ještě není ověřená → drží se aspoň 30 dní od dokončení, přehled ukazuje skutečný termín (ne backupUntil)
    assert.strictEqual(byId.aaa.expiresAt, byId.aaa.finishedAt + 30 * DAY);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nová retence platí i pro stávající zálohy, vlastní termín ji přebije', () => {
  const { root, ctx, b } = setup();
  try {
    for (const j of [ctx.store.s.merges.aaa, ctx.store.s.syncFixes.bbb]) j.backupCheck = { status: 'ok' }; // ověřené
    b.keep('aaa', { days: 30 });
    assert.deepStrictEqual(b.retention({ days: 7, maxGB: 0 }), []); // aaa by jinak (10 dní) šla pryč
    b.keep('aaa', { reset: true });
    assert.deepStrictEqual(b.retention({ days: 7, maxGB: 0 }).map((x) => x.id), ['aaa']);
    assert.ok(fs.existsSync(path.join(root, 'backup', 'aaa')), 'náhled nic nemaže');
    const removed = b.retention({ days: 7, maxGB: 0 }, { apply: true });
    assert.deepStrictEqual(removed.map((x) => x.id), ['aaa']);
    assert.ok(!fs.existsSync(path.join(root, 'backup', 'aaa')));
    assert.strictEqual(ctx.store.s.merges.aaa.backupRemoved, true);
    // bbb: dokončeno před 1 dnem → s retencí 3 dny vyprší za 2 dny
    assert.ok(Math.abs(ctx.store.s.syncFixes.bbb.backupUntil - (ctx.store.s.syncFixes.bbb.finishedAt + 7 * DAY)) < 1000);
    b.retention({ days: 3, maxGB: 0 }, { apply: true });
    assert.ok(Math.abs(ctx.store.s.syncFixes.bbb.backupUntil - (ctx.store.s.syncFixes.bbb.finishedAt + 3 * DAY)) < 1000);
    assert.ok(fs.existsSync(path.join(root, 'backup', 'ccc')), 'zálohu bez úlohy maže jen člověk');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('natrvalo a ruční smazání', () => {
  const { root, ctx, b, logs } = setup();
  try {
    for (const j of [ctx.store.s.merges.aaa, ctx.store.s.syncFixes.bbb]) j.backupCheck = { status: 'ok' }; // ověřené
    b.keep('aaa', { forever: true });
    assert.deepStrictEqual(b.retention({ days: 0, maxGB: 0 }).map((x) => x.id), ['bbb']);
    b.remove('ccc', 'ručně');
    assert.ok(!fs.existsSync(path.join(root, 'backup', 'ccc')));
    assert.match(logs.at(-1), /Neznámý|ccc/);
    assert.throws(() => b.remove('../lib', 'ručně'), /neexistuje/);
    assert.throws(() => b.keep('ccc', { days: 5 }), /záznam/);
    ctx.store.s.merges.aaa.active = true;
    assert.throws(() => b.remove('aaa', 'ručně'), /běží/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ověřené sloučení se s deleteVerified maže hned, ke kontrole a vlastní termín ne', () => {
  const list = [
    bk('ok', { check: { status: 'ok' } }),
    bk('rev', { check: { status: 'review' } }),
    bk('pend', { check: { status: 'pending' } }),
    bk('cust', { keep: 'custom', expiresAt: NOW + 50 * DAY, check: { status: 'ok' } }),
  ];
  assert.deepStrictEqual(plan(list, { days: 30 }, NOW), []);
  assert.deepStrictEqual(plan(list, { days: 30, deleteVerified: true }, NOW), [{ id: 'ok', why: 'verified' }]);
});

test('kontrola souboru v knihovně proti záloze', () => {
  const j = { type: 'merge', need: 'cs' };
  const r = { fileId: 1, offsetMs: 113, verifyMs: 0, via: 'CZ stopa přímo proti EN', outSize: 500 };
  const bak = { video: {}, duration: 6000, audio: [{ lang: 'en' }] };
  const good = { video: {}, duration: 6000.5, audio: [{ lang: 'en' }, { lang: 'cs' }] };
  const lib = { fileId: 2, size: 500 };
  assert.deepStrictEqual(fileIssues(j, r, { lib, libProbe: good, bakProbe: bak }), []);
  assert.match(fileIssues(j, r, { lib: { fileId: 1 }, libProbe: good, bakProbe: bak })[0], /původní soubor/);
  assert.match(fileIssues(j, r, { lib: null })[0], /není žádný soubor/);
  assert.match(fileIssues(j, r, { lib, libProbe: { ...good, audio: [{ lang: 'en' }] }, bakProbe: bak }).join(), /chybí přidaná CZ/);
  assert.match(fileIssues(j, r, { lib, libProbe: { ...good, duration: 5900 }, bakProbe: bak }).join(), /kratší/);
  assert.match(fileIssues(j, r, { lib: { fileId: 2, size: 999 }, libProbe: good, bakProbe: bak }).join(), /změnil/);
  assert.match(fileIssues(j, { ...r, offsetMs: 28149 }, { lib, libProbe: good, bakProbe: bak }).join(), /28\.1 s/);
  assert.match(fileIssues(j, { ...r, verifyMs: -62 }, { lib, libProbe: good, bakProbe: bak }).join(), /62 ms/);
  assert.match(fileIssues(j, r, { lib, libProbe: good, bakProbe: bak, meas: { ok: true, offsetMs: 300 } }).join(), /300 ms/);
  assert.match(fileIssues(j, r, { lib, libProbe: good, bakProbe: null }).join(), /záloha/);
  // Oprava synchronizace: stejný počet stop, zbytkový posun z ověření
  const sf = { type: 'syncfix' };
  const sr = { fileId: 1, offsetMs: 400, applied: [{ verifyMs: 3 }] };
  assert.deepStrictEqual(fileIssues(sf, sr, { lib, libProbe: { ...good }, bakProbe: { ...bak, audio: good.audio } }), []);
  assert.match(fileIssues(sf, sr, { lib, libProbe: good, bakProbe: bak }).join(), /originál jich měl 1/);
});

test('ověření úloh: v pořádku se smaže (je-li zapnuto), odchylka zůstane a upozorní', async () => {
  const { root, ctx, b, logs } = setup();
  try {
    const now = Date.now();
    Object.assign(ctx.store.s.merges.aaa, { app: 'radarr', itemKey: 'radarr:1', need: 'cs', finishedAt: now - DAY, backupUntil: now + 6 * DAY,
      results: [{ ok: true, target: 'Film A.mkv', path: '/lib/Film A.mkv', fileId: 10, offsetMs: 100, verifyMs: 0, via: 'CZ stopa přímo proti EN' }] });
    Object.assign(ctx.store.s.syncFixes.bbb, { app: 'sonarr', itemKey: 'sonarr:5:1',
      results: [{ ok: true, target: 'B E01.mkv', path: '/lib/Film B.mkv', fileId: 20, episodeIds: [7], offsetMs: 300, applied: [{ verifyMs: 70 }] }] });
    ctx.store.s.items = { 'radarr:1': { app: 'radarr' }, 'sonarr:5:1': { app: 'sonarr' } };
    ctx.dubsync = { files: async (it) => (it.app === 'radarr' ? [{ fileId: 11, path: '/lib/new A.mkv' }] : [{ fileId: 21, path: '/lib/new B.mkv', episodeIds: [7] }]) };
    const sent = [];
    ctx.notify = { backupReview: async (j) => sent.push(j.id) };
    b.probe = async (p) => (p.includes('backup') ? { video: {}, duration: 100, audio: [{ lang: 'en' }] }
      : p.includes('new A') ? { video: {}, duration: 100, audio: [{ lang: 'en' }, { lang: 'cs' }] }
      : { video: {}, duration: 100, audio: [{ lang: 'en' }] });
    assert.strictEqual(b.list().find((x) => x.id === 'aaa').check.status, 'pending');
    await b.verify();
    const byId = Object.fromEntries(b.list().map((x) => [x.id, x]));
    assert.strictEqual(byId.aaa.check.status, 'ok');
    assert.strictEqual(byId.bbb.check.status, 'review');
    assert.match(byId.bbb.check.issues[0].msg, /70 ms/);
    assert.strictEqual(byId.ccc.check.status, 'unknown');
    assert.deepStrictEqual(sent, ['bbb']);
    assert.ok(fs.existsSync(path.join(root, 'backup', 'aaa')), 'bez nastavení se ověřená záloha nemaže');
    // Zapnout mazání po ověření: ověřená jde pryč, ke kontrole zůstává; další ověření už neupozorňuje znovu
    ctx.store.settings.backupDeleteVerified = true;
    await b.verify();
    assert.ok(!fs.existsSync(path.join(root, 'backup', 'aaa')));
    assert.match(logs.find((l) => /smazána/.test(l)), /sloučení ověřeno/);
    assert.ok(fs.existsSync(path.join(root, 'backup', 'bbb')));
    assert.deepStrictEqual(sent, ['bbb']);
    // Ruční „ověřit znovu“ se stejným výsledkem znovu neupozorní
    await b.verify('bbb');
    assert.deepStrictEqual(sent, ['bbb']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Radarr/Sonarr neodpovídá → zůstane čekat na ověření, nic se nemaže', async () => {
  const { root, ctx, b } = setup();
  try {
    ctx.store.settings.backupDeleteVerified = true;
    ctx.store.s.merges.aaa.itemKey = 'radarr:1';
    ctx.store.s.merges.aaa.results = [{ ok: true, path: '/x/Film A.mkv', fileId: 1 }];
    ctx.store.s.merges.aaa.finishedAt = Date.now() - DAY; // retence (7 dní) ji ještě nesmaže
    ctx.store.s.items = { 'radarr:1': { app: 'radarr' } };
    ctx.dubsync = { files: async () => { throw new Error('fetch failed'); } };
    ctx.notify = { backupReview: async () => assert.fail('nemá upozorňovat') };
    await b.verify();
    assert.strictEqual(b.list().find((x) => x.id === 'aaa').check.status, 'pending');
    assert.ok(fs.existsSync(path.join(root, 'backup', 'aaa')));
    await assert.rejects(b.verify('aaa'), /fetch failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('přidaný zvuk: jazyk, kodek a rozsah posunu ze sloučených souborů', () => {
  const r = (offsetMs, added, ok = true) => ({ ok, offsetMs, added });
  const ac3 = { lang: 'cs', codec: 'ac3', channels: 6 };
  assert.deepStrictEqual(addedAudio({ type: 'merge', need: 'cs', results: [r(980, ac3)] }),
    { lang: 'cs', tracks: [{ codec: 'ac3', channels: 6 }], offsetMs: [980, 980] });
  // Starší úloha bez kodeku, nepovedený soubor se nepočítá
  assert.deepStrictEqual(addedAudio({ type: 'merge', need: 'en', results: [r(-110), r(0), r(5000, null, false)] }),
    { lang: 'en', tracks: [], offsetMs: [-110, 0] });
  assert.strictEqual(addedAudio({ type: 'merge', need: 'cs', results: [r(0, ac3, false)] }), null);
  assert.strictEqual(addedAudio({ type: 'syncfix', results: [r(0)] }), null);
});

test('záloha ke kontrole nebo ještě neověřená se po retenci ani kvůli místu nemaže (drží se aspoň 30 dní)', () => {
  const old = NOW - 10 * DAY;
  const list = [
    bk('ok', { finishedAt: old, createdAt: 1, check: { status: 'ok' } }),
    bk('rev', { finishedAt: old, createdAt: 2, check: { status: 'review' } }),
    bk('pend', { finishedAt: old, createdAt: 3, check: { status: 'pending' } }),
  ];
  assert.deepStrictEqual(plan(list, { days: 7 }, NOW), [{ id: 'ok', why: 'age' }]);
  assert.deepStrictEqual(plan(list, { days: 0 }, NOW).map((x) => x.id), ['ok']);
  assert.deepStrictEqual(plan(list, { days: 365, maxBytes: 1 }, NOW).map((x) => x.id), ['ok']);
  assert.strictEqual(expiryAt(list[1], 7), old + 30 * DAY);
  assert.deepStrictEqual(plan(list, { days: 7 }, old + 31 * DAY).map((x) => x.id), ['ok', 'rev', 'pend']);
});

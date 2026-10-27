const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { rememberBadDonor } = require('../src/merge');
const { evaluateReleases, withCutMatch, candId } = require('../src/search');
const { Downloads } = require('../src/downloads');
const { autoAllowed } = require('../src/watch');
const { DEFAULT_SETTINGS } = require('../src/store');

function mkStore(extra = {}) {
  return { settings: { ...DEFAULT_SETTINGS, verifySpeech: false, stagingDir: '/staging', ...extra }, s: { ignoredGuids: {}, items: {}, watchSeries: {}, badDonors: {}, proposals: {}, downloads: {}, merges: {} }, save() {}, log() {}, countSearch() {} };
}
const GB = 1024 ** 3;
const rel = (guid, title, res = 1080, extra = {}) => ({ guid, indexerId: 1, indexer: '1337x', title, seeders: 40, size: 8 * GB, protocol: 'torrent',
  quality: { quality: { name: `Bluray-${res}p`, resolution: res, source: 'bluray' } }, languages: [], rejections: [], ...extra });

// Hobit: Šmakova dračí poušť – soubor Extended jen EN, CZ dabing existuje jen ke kino verzi (720p)
const smaug = () => ({
  key: 'radarr:141', app: 'radarr', arrId: 141, title: 'The Hobbit: The Desolation of Smaug', year: 2013, origLang: 'en',
  current: { tier: 1, audio: 'eng', audioSource: 'mediainfo', quality: 'Bluray-1080p', res: 1080, qrank: 35, fileIds: [42],
    sceneName: 'The.Hobbit.The.Desolation.of.Smaug.2013.Extended.Edition.1080p.BluRay.x264-RiPPY', truncated: null },
});
const FTU = 'The.Hobbit.The.Desolation.of.Smaug.2013.720p.BluRay.x264.CZ-FTU';
const smaugReleases = () => [
  rel('ftu', FTU, 720, { seeders: 3, size: 9.2 * GB, indexer: 'SkTorrent' }),
  rel('kino', 'The.Hobbit.The.Desolation.of.Smaug.2013.1080p.BluRay.x264-SPARKS', 1080, { seeders: 30 }),
  rel('kino720', 'The.Hobbit.The.Desolation.of.Smaug.2013.720p.BluRay.x264-SPARKS', 720, { seeders: 90 }),
  rel('ext', 'The.Hobbit.The.Desolation.of.Smaug.2013.Extended.1080p.BluRay.x264-ROVERS', 1080, { seeders: 50 }),
];

test('verze k dabingu: CZ jen ke kino verzi → kino verze v 1080p + CZ zvuk, před výměnou za 720p', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = smaug();
  rememberBadDonor(ctx.store, { id: 'j', itemKey: item.key, title: FTU, guid: 'ftu' }, 'Nic nešlo sloučit: délka se liší o 25 min – jiná verze filmu');
  const { candidates, merges, combos } = evaluateReleases(item, smaugReleases(), ctx);
  assert.strictEqual(merges.length, 0, 'k Extended se kino dabing přidat nedá');
  assert.strictEqual(combos.length, 1);
  const c = combos[0];
  assert.strictEqual(c.kind, 'cutmatch');
  assert.strictEqual(c.guid, 'kino', 'obraz kino verze v plném rozlišení, ne Extended ani 720p');
  assert.strictEqual(c.donor.guid, 'ftu');
  assert.strictEqual(c.donor.mergeLang, 'cs');
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.baseTier, 1);
  assert.strictEqual(c.res, 1080);
  assert.strictEqual(c.seeders, 3, 'slabší z obou torrentů');
  assert.ok(Math.abs(c.size - 17.2 * GB) < 1e6, 'stáhne se obojí');
  assert.match(c.notes[0], /kino verze, Bluray-1080p \(EN\) – po importu se do něj přidá CZ zvuk z „The\.Hobbit.*CZ-FTU“/);
  assert.match(c.warnings[0], /jiná verze filmu: teď prodloužená verze \(Extended\), stáhne se kino verze/);
  assert.notStrictEqual(candId(c), candId({ kind: 'language', guid: 'kino' }));

  const top = withCutMatch(candidates, combos);
  assert.deepStrictEqual(top.map((x) => x.guid), ['kino', 'ftu'], 'před výměnou za 720p s jinou verzí');

  const store = mkStore({ autoGrab: 'any' });
  assert.strictEqual(autoAllowed(store, item, { ...c, warnings: [], confidence: 'sure', seeders: 100 }), false, 'jen po schválení');
});

test('verze k dabingu: nenabízí se, když dabing sedí ke stávající verzi nebo chybí obraz stejné verze', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = smaug();
  // CZ Extended existuje → normální přidání zvuku, žádná výměna verze
  const ext = [...smaugReleases(), rel('czext', 'The Hobbit: The Desolation of Smaug - Extended Edition (2013)(CZ)', 1080, { indexer: 'SkTorrent' })];
  const withExt = evaluateReleases(item, ext, ctx);
  assert.ok(withExt.merges.some((m) => m.guid === 'czext' && !m.otherCut));
  assert.strictEqual(withExt.combos.length, 0, 'dabing ke stávající verzi má přednost');
  // Kino verze jen v nižším rozlišení než soubor → obraz by se zhoršil
  const low = smaugReleases().filter((r) => r.guid !== 'kino');
  assert.strictEqual(evaluateReleases(item, low, ctx).combos.length, 0);
  // Bez qBittorrentu se přidat zvuk nedá
  assert.strictEqual(evaluateReleases(item, smaugReleases(), { store: mkStore(), qbit: { enabled: false } }).combos.length, 0);
  // Donor stejného jména jako soubor, který jen nesedí délkou – verzi z názvu nepoznáme, není co nabídnout
  const same = { ...item, current: { ...item.current, sceneName: 'The.Hobbit.The.Desolation.of.Smaug.2013.1080p.BluRay.x264-RiPPY' } };
  rememberBadDonor(ctx.store, { id: 'j', itemKey: item.key, title: FTU, guid: 'ftu' }, 'Nic nešlo sloučit: délka se liší o 25 min – jiná verze filmu');
  assert.strictEqual(evaluateReleases(same, smaugReleases(), ctx).combos.length, 0);
});

test('verze k dabingu: useknutý soubor – obraz stejné verze jako CZ dabing, ne Extended', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = { key: 'radarr:142', app: 'radarr', arrId: 142, title: 'The Hobbit: The Battle of the Five Armies', year: 2014, origLang: 'en',
    current: { tier: 1, audio: 'eng', audioSource: 'mediainfo', quality: 'Remux-1080p', res: 1080, qrank: 50, fileIds: [44],
      sceneName: 'The Hobbit The Battle of the Five Armies (2014) Remux-1080p.mkv', truncated: { fileMin: 20, runtimeMin: 144 } } };
  const cz = rel('cz', 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.720p.BluRay.DTS.x264.CZ-TreZzoR', 720, { seeders: 3, indexer: 'SkTorrent' });
  const ext = rel('ext', 'The Hobbit The Battle of the Five Armies 2014 Extended 1080p BluRay x264 Dual Audio Hindi English AC3 5.1-MeGUiL', 1080, { seeders: 18 });
  assert.strictEqual(evaluateReleases(item, [cz, ext], ctx).combos.length, 0, 'jen Extended – k němu kino dabing nesedí');
  const kino = rel('kino', 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.1080p.BluRay.x264-SPARKS', 1080, { seeders: 25 });
  const { candidates, combos } = evaluateReleases(item, [cz, ext, kino], ctx);
  assert.strictEqual(combos.length, 1);
  assert.strictEqual(combos[0].guid, 'kino');
  assert.strictEqual(combos[0].donor.guid, 'cz');
  assert.match(combos[0].warnings[0], /useknutý/);
  assert.strictEqual(withCutMatch(candidates, combos)[0].guid, 'kino', 'před 720p CZ i před EN náhradou');
});

test('verze k dabingu: po importu nového souboru se rovnou přidá zvuk z donoru', async () => {
  const store = mkStore();
  const item = smaug();
  store.s.items[item.key] = item;
  rememberBadDonor(store, { id: 'j', itemKey: item.key, title: FTU, guid: 'ftu' }, 'Nic nešlo sloučit: délka se liší o 25 min – jiná verze filmu');
  const grabs = [];
  const ctx = {
    store, qbit: { enabled: true }, radarr: { searchReleases: async () => smaugReleases() },
    notify: { download: async () => {} }, searcher: { enqueue() {} }, merger: { active: () => [] }, busyKeys: () => new Set(),
    grab: async (pid, idx) => { grabs.push(store.s.proposals[pid].candidates[idx]); return { id: 'm1' }; },
  };
  const dl = new Downloads(ctx);
  const c = evaluateReleases(item, smaugReleases(), { store, qbit: { enabled: true } }).combos[0];
  // Radarr naimportoval kino verzi
  item.current = { ...item.current, fileIds: [99], sceneName: 'The.Hobbit.The.Desolation.of.Smaug.2013.1080p.BluRay.x264-SPARKS' };
  const d = { id: 'd1', itemKey: item.key, label: 'The Hobbit: The Desolation of Smaug (2013)', candidate: c };
  await dl.chainMerge(d);
  assert.strictEqual(grabs.length, 1);
  assert.strictEqual(grabs[0].kind, 'merge');
  assert.strictEqual(grabs[0].guid, 'ftu', 'donor ze schváleného návrhu');
  assert.ok(!grabs[0].otherCut, 'k nové verzi sedí');
  assert.strictEqual(d.chainedMergeId, 'm1');
  assert.deepStrictEqual(store.s.badDonors, {}, 'blokace kvůli délce ke starému souboru zapomenutá');

  // Donor zmizel a jiný není → varování u stažení, nic se nespustí
  const d2 = { id: 'd2', itemKey: item.key, label: d.label, candidate: c };
  ctx.radarr.searchReleases = async () => smaugReleases().filter((r) => r.guid !== 'ftu');
  await dl.chainMerge(d2);
  assert.strictEqual(grabs.length, 1);
  assert.match(d2.warning, /CZ zvuk se nepřidal: zdroj zvuku už není k mání/);
});

const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { parseRunTime, truncationOf, syncLibrary } = require('../src/library');
const { mergeCandidates, rememberBadDonor } = require('../src/merge');
const { evaluateReleases, itemNeeds } = require('../src/search');
const { autoAllowed, setWatch } = require('../src/watch');
const { DEFAULT_SETTINGS } = require('../src/store');

const helpers = {
  HARD_REJECT: /unknown (movie|series)/i,
  rejectionsOf: (r) => r.rejections || [],
  isLocalIndexer: (n) => /sktorrent/i.test(n),
};

function mkStore(extra = {}) {
  return { settings: { ...DEFAULT_SETTINGS, stagingDir: '/staging', ...extra }, s: { ignoredGuids: {}, items: {}, watchSeries: {}, badDonors: {} }, save() {}, log() {} };
}

// Hobit: Bitva pěti armád v Radarru – film 144 min, soubor (Remux-1080p, 1,7 GB) jen 19:59
const hobbit = (runTime = '19:59', runtime = 144) => ({
  id: 142, title: 'The Hobbit: The Battle of the Five Armies', year: 2014, runtime, hasFile: true, monitored: true,
  originalLanguage: { id: 1, name: 'English' }, images: [],
  movieFile: { id: 900, size: 1.7e9, sceneName: 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.1080p.BluRay.REMUX.AVC.DTS-HD.MA.7.1-FGT',
    quality: { quality: { name: 'Remux-1080p', resolution: 1080, source: 'bluray' } },
    mediaInfo: { audioLanguages: 'eng', videoCodec: 'AVC', runTime }, dateAdded: '2026-01-01T00:00:00Z' },
});

test('parseRunTime: H:MM:SS i MM:SS, neznámá délka → null', () => {
  assert.strictEqual(parseRunTime('19:59'), 1199);
  assert.strictEqual(parseRunTime('2:24:05'), 8645);
  assert.strictEqual(parseRunTime('02:24:05'), 8645);
  assert.strictEqual(parseRunTime('1:02:03.456'), 3723);
  assert.strictEqual(parseRunTime(' 45:00 '), 2700);
  for (const v of ['', null, undefined, '0:00', '00:00:00', 'abc', '1:2', '12']) assert.strictEqual(parseRunTime(v), null, String(v));
});

test('truncationOf: soubor pod 60 % délky filmu, jinak (i neznámá délka) nic', () => {
  assert.deepStrictEqual(truncationOf(hobbit()), { fileMin: 20, runtimeMin: 144 });
  assert.strictEqual(truncationOf(hobbit('2:24:05')), null);
  assert.strictEqual(truncationOf(hobbit('2:00:00')), null, 'kino verze místo Extended není poškozený soubor');
  assert.strictEqual(truncationOf(hobbit('1:00:00', 100)), null, 'přesně 60 % ještě ne');
  assert.deepStrictEqual(truncationOf(hobbit('59:59', 100)), { fileMin: 60, runtimeMin: 100 });
  assert.strictEqual(truncationOf(hobbit('19:59', 0)), null, 'Radarr délku filmu nezná');
  assert.strictEqual(truncationOf(hobbit('')), null, 'MediaInfo délku souboru nezná');
  assert.strictEqual(truncationOf({ runtime: 144, movieFile: { mediaInfo: {} } }), null);
  assert.strictEqual(truncationOf(null), null);
});

test('syncLibrary: Radarr film s useknutým souborem má current.truncated', async () => {
  const store = mkStore({ autoWatchNew: 'off' });
  const ok = { ...hobbit('2:24:05'), id: 143 };
  const ctx = { store, radarr: { enabled: true, get: async () => [hobbit(), ok] }, sonarr: { enabled: false } };
  await syncLibrary(ctx);
  assert.deepStrictEqual(store.s.items['radarr:142'].current.truncated, { fileMin: 20, runtimeMin: 144 });
  assert.strictEqual(store.s.items['radarr:143'].current.truncated, null);
});

const truncItem = (tier = 1) => ({
  key: 'radarr:142', app: 'radarr', arrId: 142, origLang: 'en',
  current: { tier, audioSource: 'mediainfo', audio: 'eng', quality: 'Remux-1080p', res: 1080, qrank: 50, vcodec: null,
    sceneName: 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.1080p.BluRay.REMUX.AVC.DTS-HD.MA.7.1-FGT',
    truncated: { fileMin: 20, runtimeMin: 144 } },
});
const rel = (guid, title, res = 1080, extra = {}) => ({ guid, indexerId: 1, indexer: 'SkTorrent', title, seeders: 60, size: 8e9, protocol: 'torrent',
  quality: { quality: { name: `Bluray-${res}p`, resolution: res, source: 'bluray' } }, languages: [], rejections: [], ...extra });

test('useknutý soubor: žádné přidání zvuku', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const releases = [rel('cz', 'Hobit Bitva peti armad (2014)(CZ)[1080p]')];
  const item = truncItem();
  assert.strictEqual(mergeCandidates(item, releases, ctx, helpers).length, 0);
  const whole = { ...item, current: { ...item.current, truncated: null } };
  assert.strictEqual(mergeCandidates(whole, releases, ctx, helpers).length, 1, 'celý soubor by sloučit šel');
  assert.strictEqual(evaluateReleases(item, releases, ctx).merges.length, 0);
});

test('useknutý soubor: náhrada celým souborem i se stejným jazykem, s varováním', () => {
  const ctx = { store: mkStore(), qbit: { enabled: true } };
  const item = truncItem();
  const releases = [
    rel('en', 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.1080p.BluRay.x264-SPARKS', 1080, { languages: [{ name: 'English' }] }),
    rel('en720', 'The.Hobbit.The.Battle.of.the.Five.Armies.2014.720p.BluRay.x264-SPARKS', 720, { languages: [{ name: 'English' }] }),
    rel('cz', 'Hobit Bitva peti armad (2014)(CZ)[1080p]'),
  ];
  // Release, který dřív neprošel sloučením kvůli délce, není jiná verze – délka useknutého souboru o verzi nic neříká
  rememberBadDonor(ctx.store, { id: 'j', itemKey: item.key, title: releases[0].title, guid: 'en' }, 'Nic nešlo sloučit: délka se liší o 124 min – jiná verze filmu');
  const { candidates } = evaluateReleases(item, releases, ctx);
  const by = Object.fromEntries(candidates.map((c) => [c.guid, c]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['cz', 'en', 'en720']);
  assert.strictEqual(by.en.kind, 'repair');
  assert.strictEqual(by.en720.kind, 'repair');
  assert.strictEqual(by.cz.kind, 'language');
  for (const c of candidates) {
    assert.match(c.warnings[0], /současný soubor je useknutý\/poškozený \(20 z 144 min\) – nahradí se celý/);
    assert.ok(!c.warnings.some((w) => w.includes('jiná verze filmu')), c.guid);
  }
  assert.ok(by.en720.warnings.some((w) => w.includes('nižší rozlišení')));

  // Bez useknutí se stejný jazyk ve stejném rozlišení nenabízí
  const whole = { ...item, current: { ...item.current, truncated: null } };
  assert.deepStrictEqual(evaluateReleases(whole, releases, ctx).candidates.map((c) => c.guid), ['cz']);
});

test('useknutý soubor: hledá se i při splněném jazyku, nikdy se nestáhne sám', () => {
  const st = { ...DEFAULT_SETTINGS, qualityUpgrades: false };
  assert.deepStrictEqual(itemNeeds(truncItem(3), st), { lang: false, quality: false, codec: false, broken: true, any: true });
  assert.strictEqual(itemNeeds({ ...truncItem(3), current: { ...truncItem(3).current, truncated: null } }, st).any, false);

  const store = mkStore({ autoGrab: 'any' });
  const item = truncItem();
  store.s.items[item.key] = item;
  setWatch(store, item, { enabled: true, auto: true });
  const cand = { kind: 'language', tier: 3, confidence: 'sure', seeders: 100, warnings: [] };
  assert.strictEqual(autoAllowed(store, item, cand), false);
  assert.strictEqual(autoAllowed(store, item, { ...cand, kind: 'repair', tier: 1 }), false);
  item.current.truncated = null;
  assert.strictEqual(autoAllowed(store, item, cand), true, 'celý soubor stejným kandidátem klidně');
});

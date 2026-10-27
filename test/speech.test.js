const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { parseWhisper, vote, reconcile } = require('../src/speech');
const { applyLangCheck, prune } = require('../src/langcheck');
const { DEFAULT_SETTINGS } = require('../src/store');

test('parseWhisper – jazyk a délka řeči', () => {
  assert.deepStrictEqual(
    parseWhisper('vad: total duration of speech segments: 26.30 seconds\nwhisper_full_with_state: auto-detected language: de (p = 0.981904)'),
    { lang: 'de', p: 0.981904, speechSec: 26.3 });
  assert.strictEqual(parseWhisper('vad_segments_from_probs: Final speech segments after filtering: 0\n').speechSec, 0);
});

test('vote – úseky bez řeči se nepočítají', () => {
  const v = vote([
    { lang: 'en', p: 0.9, speechSec: 0 },        // vzdechy → "en", ignorovat
    { lang: 'de', p: 0.98, speechSec: 26 },
    { lang: 'de', p: 0.97, speechSec: 22 },
    { lang: 'en', p: 0.55, speechSec: 5 },
  ]);
  assert.strictEqual(v.lang, 'de');
  assert.strictEqual(v.agree, 2);
  assert.strictEqual(v.samples, 3);
});

test('reconcile – kdy věřit poslechu', () => {
  const sure = (lang) => ({ lang, confidence: 0.9, agree: 3, samples: 4 });
  // YouTube webm: česká stopa označená jako eng
  assert.deepStrictEqual(reconcile('en', sure('cs')), { lang: 'cs', corrected: true });
  // značka sedí
  assert.deepStrictEqual(reconcile('cs', sure('cs')), { lang: 'cs', corrected: false });
  // čeština × slovenština – Whisper se plete, platí značka
  assert.deepStrictEqual(reconcile('sk', sure('cs')), { lang: 'sk', corrected: false });
  assert.deepStrictEqual(reconcile('sk', sure('cs'), 'en'), { lang: 'sk', corrected: false });
  // český film se stopou "slo" a českou řečí (slovenští herci) → čeština
  assert.deepStrictEqual(reconcile('sk', sure('cs'), 'cs'), { lang: 'cs', corrected: true });
  // značka "cze" u českého filmu zůstává, i když Whisper slyší slovenštinu
  assert.deepStrictEqual(reconcile('cs', sure('sk'), 'cs'), { lang: 'cs', corrected: false });
  // nejisté → pořád značka
  assert.deepStrictEqual(reconcile('sk', { lang: 'cs', confidence: 0.9, agree: 1, samples: 1 }, 'cs'), { lang: 'sk', corrected: false });
  // bez značky → podle poslechu
  assert.deepStrictEqual(reconcile(null, sure('en')), { lang: 'en', corrected: true });
  // nejisté (jen jeden úsek s řečí) → značka
  assert.deepStrictEqual(reconcile('en', { lang: 'cs', confidence: 1, agree: 1, samples: 1 }), { lang: 'en', corrected: false });
  // bez řeči → značka
  assert.deepStrictEqual(reconcile('en', { lang: null, confidence: 0, samples: 0 }), { lang: 'en', corrected: false });
});

test('applyLangCheck – oprava platí jen pro ověřené soubory', () => {
  const lc = { fileIds: [7], corrected: true, tier: 3, audio: 'cze' };
  const item = { origLang: 'cs', langCheck: lc, current: { tier: 1, audio: 'eng', fileIds: [7], audioSource: 'mediainfo' } };
  applyLangCheck(item);
  assert.strictEqual(item.current.tier, 3);
  assert.strictEqual(item.current.audioSource, 'poslech');
  assert.strictEqual(item.current.tagAudio, 'eng');

  const replaced = { langCheck: lc, current: { tier: 1, audio: 'eng', fileIds: [8] } };
  applyLangCheck(replaced);
  assert.strictEqual(replaced.current.tier, 1);
  assert.strictEqual(replaced.langCheck, undefined, 'nový soubor → staré ověření pryč');
});

test('prune – po ověření zmizí kandidáti, kteří už nejsou lepší', () => {
  const ctx = { store: { settings: { ...DEFAULT_SETTINGS } } };
  const item = { origLang: 'cs', current: { tier: 3, res: 1080, audio: 'cze' } };
  const p = { status: 'pending', candidates: [{ kind: 'language', tier: 3, res: 1080 }, { kind: 'merge', mergeLang: 'cs', tier: 3 }] };
  prune(ctx, p, item);
  assert.strictEqual(p.status, 'expired');
  assert.match(p.note, /Ověřeno poslechem/);

  const item2 = { origLang: 'en', current: { tier: 2, res: 1080, audio: 'cze' } };
  const p2 = { status: 'pending', candidates: [{ kind: 'language', tier: 3, res: 1080 }, { kind: 'language', tier: 2, res: 720 }, { kind: 'merge', mergeLang: 'cs', tier: 3 }] };
  prune(ctx, p2, item2);
  assert.strictEqual(p2.status, 'pending');
  assert.deepStrictEqual(p2.candidates.map((c) => c.tier), [3]);
});

test('reconcile – "eng" se slovenštinou z poslechu není jistá oprava (Whisper plete CZ a SK)', () => {
  const sure = (lang) => ({ lang, confidence: 0.95, agree: 4, samples: 4 });
  assert.deepStrictEqual(reconcile('en', sure('sk')), { lang: 'en', corrected: false, doubtful: true });
  assert.deepStrictEqual(reconcile('en', sure('sk'), 'cs'), { lang: 'en', corrected: false, doubtful: true });
  assert.deepStrictEqual(reconcile('other', sure('sk')), { lang: 'other', corrected: false, doubtful: true });
  // čeština z poslechu u "eng" je pořád jistá oprava (YouTube)
  assert.deepStrictEqual(reconcile('en', sure('cs')), { lang: 'cs', corrected: true });
});

test('LangChecker – hromadný poslech knihovny: fronta, přeskočení ověřených, souhrn', async () => {
  const speech = require('../src/speech');
  const { LangChecker } = require('../src/langcheck');
  const was = speech.available;
  speech.available = () => true;
  try {
    const logs = [];
    const inbox = [];
    const items = {
      a: { key: 'a', app: 'radarr', title: 'A', year: 2001, current: { tier: 3, fileIds: [1] } },
      b: { key: 'b', app: 'radarr', title: 'B', year: 2002, current: { tier: 3, fileIds: [2] }, langCheck: { fileIds: [2] } },
      c: { key: 'c', app: 'radarr', title: 'C', year: 2003, current: { tier: 1, fileIds: [3] } },
      d: { key: 'd', app: 'radarr', title: 'D', year: 2004, current: { tier: 1, fileIds: [4] } },
    };
    const store = { s: { items, proposals: {} }, settings: { ...DEFAULT_SETTINGS }, save() {}, log: (lvl, msg) => logs.push([lvl, msg]) };
    const busy = new Set(['d']);
    const ctx = { store, searcher: { busy: false }, busyKeys: () => busy, inbox: { add: (n) => inbox.push(n) } };
    const lc = new LangChecker(ctx);
    const heard = [];
    lc.verify = async (_ctx, item) => {
      heard.push(item.key);
      item.langCheck = { fileIds: item.current.fileIds, corrected: item.key === 'a' };
      // "a": značka cze/eng, ve skutečnosti jen EN → horší, hledat znovu
      return item.key === 'a' ? { changed: true, before: 3, after: 1, langCheck: item.langCheck } : { changed: false, langCheck: item.langCheck };
    };
    items.a.lastSearchedAt = '2026-10-01T00:00:00Z';

    assert.strictEqual(lc.enqueueAll(['a', 'b', 'c', 'd']), 4);
    assert.strictEqual(lc.enqueueAll(['a']), 0, 'dvakrát se nezařazuje');
    await lc.tick();
    await lc.tick();
    assert.deepStrictEqual(heard, ['a', 'c'], 'ověřené (b) se přeskočí, stahované (d) počká');
    assert.strictEqual(items.a.lastSearchedAt, null, 'horší jazyk než podle značek → hledat hned');
    assert.deepStrictEqual(lc.status(), { queued: 1, total: 4, done: 3, corrected: 1, failed: 0, current: null });

    busy.clear();
    await lc.tick();
    assert.deepStrictEqual(heard, ['a', 'c', 'd']);
    assert.strictEqual(lc.status().total, 0, 'po doběhnutí se fronta vyprázdní');
    assert.strictEqual(inbox.length, 1);
    assert.match(inbox[0].text, /4 položky, chybně označené stopy u 1/);

    // znovu vše (force) – i už ověřené; zrušení zahodí zbytek
    assert.strictEqual(lc.enqueueAll(['a', 'b'], { force: true }), 2);
    await lc.tick();
    assert.deepStrictEqual(heard.slice(3), ['a']);
    assert.strictEqual(lc.cancel(), 1);
    await lc.tick();
    assert.deepStrictEqual(heard.slice(3), ['a']);
  } finally {
    speech.available = was;
  }
});

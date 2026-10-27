const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/lang');
const { applyLangCheck } = require('../src/langcheck');

// Položka ověřená poslechem (stopa "eng", slyšet čeština) při hledané češtině
const heardItem = () => ({
  key: 'radarr:1', origLang: 'cs',
  current: { tier: 1, audio: 'eng', fileIds: [7] },
  langCheck: { fileIds: [7], corrected: true, tier: 3, audio: 'cze', files: [{ id: 7, tier: 3, tracks: [{ tag: 'en', used: 'cs', corrected: true }] }] },
});

test('poslech: úroveň se počítá podle aktuálních jazyků, ne podle uložené z doby ověření', () => {
  try {
    L.configure({ primary: 'cs', secondary: 'en' });
    assert.strictEqual(applyLangCheck(heardItem()).current.tier, 3, 'český film s českou řečí = cíl');
    // Po změně hledaného jazyka na němčinu je to soubor bez hledaných jazyků
    L.configure({ primary: 'de', secondary: 'en' });
    const it = applyLangCheck(heardItem());
    assert.strictEqual(it.current.tier, 0);
    assert.strictEqual(it.current.audioSource, 'poslech');
    // Starý záznam bez stop – zůstane uložená úroveň
    const old = heardItem();
    delete old.langCheck.files;
    assert.strictEqual(applyLangCheck(old).current.tier, 3);
  } finally {
    L.configure({ primary: 'cs', secondary: 'en' });
  }
});

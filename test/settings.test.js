const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { DEFAULT_SETTINGS, validateSettings } = require('../src/store');

test('výchozí nastavení projde kontrolou', () => {
  assert.deepStrictEqual(validateSettings(DEFAULT_SETTINGS, DEFAULT_SETTINGS).errors, []);
});

test('nebezpečné nebo nesmyslné hodnoty se odmítnou a neuloží se nic', () => {
  const bad = (body) => validateSettings(body, DEFAULT_SETTINGS).errors;
  assert.match(bad({ stallHours: 0 })[0], /stallHours/);       // každé stahování by bylo hned "mrtvé"
  assert.match(bad({ qbitStallMin: 0 })[0], /qbitStallMin/);
  assert.match(bad({ searchIntervalSec: null })[0], /není číslo/); // Number(null) by bylo 0
  assert.match(bad({ recheckDays: '' })[0], /není číslo/);
  assert.match(bad({ candidatesPerProposal: 50 })[0], /1–20/);
  assert.match(bad({ retryOnStall: 'false' })[0], /true\/false/); // Boolean('false') by bylo true
  assert.match(bad({ autoGrab: 'all' })[0], /off \/ target \/ any/);
  assert.match(bad({ stagingDir: null })[0], /stagingDir/);
  assert.match(bad({ stagingDir: 'relativni/cesta' })[0], /absolutní/);
  assert.match(bad({ minResolution: 2160 })[0], /vyšší než maxResolution/);
  const r = validateSettings({ stallHours: 4, recheckDays: 0, foo: 1 }, DEFAULT_SETTINGS);
  assert.strictEqual(r.errors.length, 1);
});

test('platné změny projdou (čísla i jako text z formuláře)', () => {
  const r = validateSettings({ stallHours: '6', keepBackupDays: 0, maxBackupGB: 0, retryOnStall: false, autoWatchNew: 'ask', localIndexers: '', stagingDir: ' /data/x ' }, DEFAULT_SETTINGS);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.values, { stallHours: 6, keepBackupDays: 0, maxBackupGB: 0, retryOnStall: false, autoWatchNew: 'ask', localIndexers: '', stagingDir: '/data/x' });
});

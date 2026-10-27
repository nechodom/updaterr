const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Jellyseerr } = require('../src/jellyseerr');

test('bez Jellyseerru se nic neukazuje', async () => {
  const js = new Jellyseerr({});
  assert.strictEqual(js.enabled, false);
  assert.strictEqual(await js.status(), null);
});

test('settings.json: u kterého serveru je zapnuté automatické hledání', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    radarr: [{ name: 'radarr', preventSearch: true }, { name: 'Radarr 4K', is4k: true, preventSearch: false }],
    sonarr: [{ name: 'Sonarr', preventSearch: false }],
  }));
  const st = await new Jellyseerr({ JELLYSEERR_CONFIG: file, JELLYSEERR_URL: 'http://js:5055/' }).status();
  assert.strictEqual(st.url, 'http://js:5055');
  assert.deepStrictEqual(st.radarr.map((s) => s.search), [false, true]);
  assert.deepStrictEqual(st.sonarr, [{ name: 'Sonarr', is4k: false, search: true }]);
});

test('nečitelné nastavení → chyba ve stavu, ne výjimka', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'settings.json');
  fs.writeFileSync(file, '{rozbité');
  const st = await new Jellyseerr({ JELLYSEERR_CONFIG: file }).status();
  assert.ok(st.error);
});

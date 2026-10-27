const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const path = require('node:path');
const { fold, textCompare, compareValues, copyText } = require('../public/lib');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('Knihovna: hledání bez diakritiky a české řazení', () => {
  assert.strictEqual(fold('Pelíšky – Šakalí léta'), 'pelisky – sakali leta');
  assert.ok(fold('Příběh hraček').includes(fold('pribeh')));
  assert.strictEqual(fold(null), '');
  const names = ['Žralok', 'Chobotnice', 'Hrad', 'Čaroděj', 'cesta', 'Zámek', 'Film 10', 'Film 9'];
  assert.deepStrictEqual(names.sort((a, b) => textCompare(a, b, 'cs')), ['cesta', 'Čaroděj', 'Film 9', 'Film 10', 'Hrad', 'Chobotnice', 'Zámek', 'Žralok']);
  assert.strictEqual(compareValues(3, 1), 1);
  assert.strictEqual(compareValues('', '2026-10-19'), -1);
});

// Falešný dokument pro náhradní kopírování přes textarea
function fakeDoc({ copyOk = true } = {}) {
  const doc = {
    copied: null, added: 0, removed: 0,
    body: { appendChild: () => { doc.added++; } },
    createElement: () => {
      const ta = { style: {}, setAttribute() {}, select() { doc.selected = ta.value; }, remove() { doc.removed++; } };
      return ta;
    },
    execCommand: (cmd) => { if (cmd === 'copy' && copyOk) doc.copied = doc.selected; return copyOk; },
  };
  return doc;
}

test('kopírování: bez navigator.clipboard (web po http) se použije textarea', async () => {
  const doc = fakeDoc();
  assert.strictEqual(await copyText('http://updaterr:8080/api/webhook/radarr', { nav: {}, doc }), true);
  assert.strictEqual(doc.copied, 'http://updaterr:8080/api/webhook/radarr');
  assert.strictEqual(doc.removed, 1, 'textarea po sobě uklidí');
  // Clipboard API odmítne (chybí oprávnění) → taky náhradní cesta
  const doc2 = fakeDoc();
  const nav = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  assert.strictEqual(await copyText('x', { nav, doc: doc2 }), true);
  assert.strictEqual(doc2.copied, 'x');
  // Clipboard API funguje → textarea se nepoužije
  const doc3 = fakeDoc();
  let got = null;
  assert.strictEqual(await copyText('y', { nav: { clipboard: { writeText: async (t) => { got = t; } } }, doc: doc3 }), true);
  assert.strictEqual(got, 'y');
  assert.strictEqual(doc3.added, 0);
  assert.strictEqual(await copyText('z', { nav: {}, doc: fakeDoc({ copyOk: false }) }), false);
});

test('web: záložky mají jméno i bez textu, přepínače se na mobilu zalamují, notifikace otevře návrh s filtrem Vše', () => {
  const html = pub('index.html');
  const tabs = html.match(/<button data-tab="[^"]+"[^>]*>/g);
  assert.strictEqual(tabs.length, 6);
  for (const b of tabs) assert.match(b, /aria-label="[^"]+"/, b);
  assert.ok(html.includes('src="lib.js"'), 'lib.js se načítá (app.js načte i18n.js až po překladech)');

  const css = pub('style.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /\.segmented \{[^}]*flex-wrap: wrap/);

  const app = pub('app.js');
  const open = app.slice(app.indexOf('function openProposal'), app.indexOf('function showTab'));
  assert.match(open, /S\.propFilter = 'all'/);
  assert.match(pub('notifications.js'), /openProposal\(l\.proposal\)/);
  assert.match(app, /openProposal\(m\[1\], false\)/, 'odkaz #p=… taky');
  assert.ok(!/navigator\.clipboard/.test(app), 'kopírování jen přes copyText');
  assert.match(app, /fold\(i\.label\)\.includes\(q\)/);
});

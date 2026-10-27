const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const { Notifier } = require('../src/notify');

function notifier() {
  const ctx = { store: { settings: { notifyDownloads: true }, save() {}, log() {} } };
  const n = new Notifier(ctx, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', NTFY_URL: 'https://ntfy.example/updaterr' });
  const sent = [];
  n.tg = async () => { sent.push('tg'); throw new Error('Telegram HTTP 502'); };
  n.ntfySend = async () => { sent.push('ntfy'); };
  return { n, sent };
}

test('notifikace: chyba Telegramu nezastaví ntfy (a chyba se pořád ohlásí)', async () => {
  const { n, sent } = notifier();
  await assert.rejects(n.send('<b>Ahoj</b>'), /Telegram: Telegram HTTP 502/);
  assert.deepStrictEqual(sent.sort(), ['ntfy', 'tg']);

  sent.length = 0;
  await assert.rejects(n.test(), /Telegram/);
  assert.ok(sent.includes('ntfy'));

  sent.length = 0;
  const p = { id: 'p1', label: 'Film (2020)', itemKey: 'radarr:1', current: { tier: 1, quality: 'WEBDL-1080p' }, candidates: [{ guid: 'g', kind: 'language', tier: 3, quality: 'WEBDL-1080p', seeders: 10, size: 4e9, title: 'Film CZ' }] };
  n.proposalText = () => 'text';
  await assert.rejects(n.proposal(p, {}), /Telegram/);
  assert.ok(sent.includes('ntfy'), 'návrh došel aspoň přes ntfy');
});

test('notifikace: chyba ntfy nezastaví Telegram', async () => {
  const { n, sent } = notifier();
  n.tg = async () => { sent.push('tg'); return { message_id: 1 }; };
  n.ntfySend = async () => { sent.push('ntfy'); throw new Error('ntfy HTTP 500'); };
  await assert.rejects(n.send('x'), /^Error: ntfy: ntfy HTTP 500$/);
  assert.deepStrictEqual(sent.sort(), ['ntfy', 'tg']);
});

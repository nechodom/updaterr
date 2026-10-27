const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, compactProposal } = require('../src/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-store-'));
const quiet = (fn) => { const real = console.log; console.log = () => {}; try { return fn(); } finally { console.log = real; } };

test('state.json: zápis nechá předchozí verzi jako .bak, poškozený soubor se obnoví ze zálohy', () => {
  const dir = tmpDir();
  try {
    const a = new Store(dir);
    a.s.items.x = { key: 'x', title: 'První' };
    a.flush();
    assert.ok(!fs.existsSync(path.join(dir, 'state.json.bak')), 'první zápis nemá co zálohovat');
    a.s.items.x.title = 'Druhý';
    a.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).items.x.title, 'První');
    assert.ok(!fs.existsSync(path.join(dir, 'state.json.tmp')));

    // Výpadek proudu: state.json useknutý
    fs.writeFileSync(path.join(dir, 'state.json'), '{"items":{"x":');
    const b = quiet(() => new Store(dir));
    assert.strictEqual(b.s.items.x.title, 'První', 'obnoveno ze zálohy');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.broken-')), 'poškozený soubor zůstane k prozkoumání');
    assert.match(b.s.log.at(-1).msg, /obnoveno ze zálohy/);

    // Přerušeno mezi přejmenováními: state.json chybí, záloha je
    fs.rmSync(path.join(dir, 'state.json'), { force: true });
    fs.writeFileSync(path.join(dir, 'state.json.bak'), JSON.stringify({ items: { y: { key: 'y' } } }));
    assert.ok(quiet(() => new Store(dir)).s.items.y);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state.json: poškozený soubor i záloha → prázdný stav, nic nespadne', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), 'x');
    fs.writeFileSync(path.join(dir, 'state.json.bak'), '');
    const st = quiet(() => new Store(dir));
    assert.deepStrictEqual(st.s.items, {});
    assert.match(st.s.log.at(-1).msg, /ani záloha/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('úklid: vyřízené návrhy se zmenší na vybraného kandidáta, staré záznamy a blokace pryč', () => {
  const dir = tmpDir();
  try {
    const st = new Store(dir);
    const now = Date.parse('2026-10-19T12:00:00Z');
    const day = 86400e3;
    const iso = (ms) => new Date(ms).toISOString();
    const cand = (guid, kind = 'language') => ({ guid, kind, title: guid, downloadUrl: `http://prowlarr/dl?apikey=SECRET&g=${guid}`, magnetUrl: 'magnet:?x', infoUrl: 'https://t/1', arr: { quality: {} }, arrRejections: ['x'] });
    Object.assign(st.s, {
      proposals: {
        done: { id: 'done', status: 'grabbed', updatedAt: iso(now - day), downloadId: 'd1', grabbedGuid: 'b', grabbedKind: 'merge', candidates: [cand('a'), cand('b'), cand('b', 'merge')] },
        running: { id: 'running', status: 'grabbed', updatedAt: iso(now - day), downloadId: 'd2', grabbedIdx: 1, candidates: [cand('a'), cand('b')] },
        exp: { id: 'exp', status: 'expired', updatedAt: iso(now - day), candidates: [cand('a'), cand('b')] },
        old: { id: 'old', status: 'rejected', updatedAt: iso(now - 61 * day), candidates: [cand('a')] },
        open: { id: 'open', status: 'pending', updatedAt: iso(now - 100 * day), candidates: [cand('a'), cand('b')] },
      },
      downloads: { d1: { id: 'd1', active: false, finishedAt: now - day }, d2: { id: 'd2', active: true, grabbedAt: now - day }, d0: { id: 'd0', active: false, finishedAt: now - 70 * day } },
      merges: {}, syncFixes: {},
      ignoredGuids: { fresh: now - 10 * day, stale: now - 91 * day, legacy: 'nesmysl' },
    });
    st.prune(now);
    const P = st.s.proposals;
    assert.deepStrictEqual(Object.keys(P).sort(), ['done', 'exp', 'open', 'running']);
    assert.strictEqual(P.done.candidates.length, 1);
    assert.strictEqual(P.done.candidates[0].kind, 'merge', 'zůstane ten, který se stáhl');
    assert.strictEqual(P.done.grabbedIdx, 0);
    assert.ok(!JSON.stringify(P.done).includes('SECRET'));
    assert.strictEqual(P.done.candidates[0].infoUrl, undefined);
    assert.strictEqual(P.done.candidates[0].arr, undefined);
    assert.strictEqual(P.running.candidates.length, 2, 'běžící stahování může návrh znovu otevřít');
    assert.deepStrictEqual(P.exp.candidates.map((c) => c.guid), ['a']);
    assert.strictEqual(P.open.candidates.length, 2, 'čekající návrhy se nemění');
    assert.deepStrictEqual(Object.keys(st.s.downloads).sort(), ['d1', 'd2']);
    assert.deepStrictEqual(Object.keys(st.s.ignoredGuids).sort(), ['fresh', 'legacy']);
    assert.strictEqual(st.s.ignoredGuids.legacy, now, 'neznámé datum se začne počítat od teď');
    assert.strictEqual(compactProposal(P.exp), false, 'podruhé už nic');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

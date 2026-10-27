// Updaterr – hledá v Radarru/Sonarru lepší verze (dabing v hledaném jazyce + originál > jen dabing > jen originál,
// pak kvalita) a nabízí je ke stažení.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ArrClient } = require('./arr');
const { Store, DEFAULT_SETTINGS, validateSettings } = require('./store');
const { syncLibrary } = require('./library');
const { Searcher, itemNeeds, itemLabel, rejectProposal, proposalKeys, candId } = require('./search');
const { Downloads } = require('./downloads');
const { Merger } = require('./merge');
const { DubSync, syncable } = require('./dubsync');
const { Backups } = require('./backups');
const LC = require('./langcheck');
const speech = require('./speech');
const gpu = require('./gpu');
const { QbitClient } = require('./qbit');
const { StallGuard } = require('./stalled');
const { TorrentCleanup } = require('./cleanup');
const { Notifier } = require('./notify');
const { Inbox } = require('./inbox');
const { attachJobs } = require('./jobs');
const { send, publicCand, csrfBlocked } = require('./http');
const { FirstGrab } = require('./firstgrab');
const { Jellyseerr } = require('./jellyseerr');
const W = require('./watch');
const L = require('./lang');
const LANGS = require('./languages');
const I18N = require('./i18n');
const C = require('./codec');

const env = process.env;
const PORT = Number(env.PORT) || 8080;
// Náhled / demo: jen čte knihovnu z Radarru/Sonarru, nic nestahuje, neimportuje, nemaže ani neposílá notifikace
const READ_ONLY = /^(1|true|yes)$/i.test(env.READ_ONLY || '');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// API klíč z proměnné, nebo z namountovaného config.xml Radarru/Sonarru
function apiKey(name) {
  if (env[`${name}_API_KEY`]) return env[`${name}_API_KEY`];
  const file = env[`${name}_CONFIG`];
  if (file && fs.existsSync(file)) return (fs.readFileSync(file, 'utf8').match(/<ApiKey>([^<]+)<\/ApiKey>/) || [])[1] || '';
  return '';
}

const store = new Store(env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Jazyky a jazyk textů podle nastavení (po načtení a po každém uložení nastavení)
function applyLanguages() {
  L.configure({ primary: store.settings.language, secondary: store.settings.secondLanguage });
  I18N.setLocale(I18N.resolveLocale(store.settings.uiLanguage, L.primary()));
}
applyLanguages();
const ctx = {
  store,
  radarr: new ArrClient('radarr', env.RADARR_URL, apiKey('RADARR')),
  sonarr: new ArrClient('sonarr', env.SONARR_URL, apiKey('SONARR')),
};
ctx.qbit = new QbitClient({ url: env.QBIT_URL, username: env.QBIT_USERNAME || 'admin', password: env.QBIT_PASSWORD });
ctx.notify = new Notifier(ctx, env);
ctx.inbox = new Inbox(store);
store.onLog = (entry) => ctx.inbox.fromLog(entry);
ctx.searcher = new Searcher(ctx);
ctx.downloads = new Downloads(ctx);
ctx.merger = new Merger(ctx);
ctx.dubsync = new DubSync(ctx);
ctx.langChecker = new LC.LangChecker(ctx);
ctx.stallGuard = new StallGuard(ctx);
ctx.torrentCleanup = new TorrentCleanup(ctx);
ctx.backups = new Backups(ctx);
ctx.firstGrab = new FirstGrab(ctx);
ctx.jellyseerr = new Jellyseerr(env);

attachJobs(ctx);
ctx.versions = {};
const allJobs = () => [...Object.values(store.s.downloads), ...Object.values(store.s.merges), ...Object.values(store.s.syncFixes)];

// --- HTTP ----------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw Object.assign(new Error(I18N.t('server.err.tooLarge')), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function authorized(req) {
  if (!env.AUTH_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === env.AUTH_PASSWORD;
}

function itemView(it) {
  const st = store.settings;
  const want = W.wantOf(store, it);
  const codec = W.codecOf(store, it);
  const needs = itemNeeds(it, st, want, codec);
  const proposal = Object.values(store.s.proposals).find((p) => p.status === 'pending' && proposalKeys(p).includes(it.key));
  const dl = allJobs().find((d) => d.active && (d.itemKeys || [d.itemKey]).includes(it.key));
  let status = 'ok';
  if (dl) status = dl.type === 'syncfix' ? 'fixing' : 'downloading';
  else if (ctx.searcher.current === it.key) status = 'searching';
  else if (proposal) status = 'proposal';
  else if (it.ignoredUntil && Date.parse(it.ignoredUntil) > Date.now()) status = 'ignored';
  else if (needs.any) status = it.lastSearchedAt ? 'waiting' : 'unchecked';
  return {
    key: it.key, app: it.app, title: it.title, year: it.year, season: it.season, label: itemLabel(it), poster: it.poster,
    originalLanguage: it.originalLanguage, origLang: it.origLang, monitored: it.monitored,
    current: { ...it.current, fileIds: undefined }, needs, status,
    lastSearchedAt: it.lastSearchedAt, lastResult: it.lastResult, ignoredUntil: it.ignoredUntil,
    proposalId: proposal?.id || null, downloadId: dl?.id || null, watch: W.watchOf(store, it), want, codec,
    sync: ctx.dubsync.summary(it), syncable: syncable(it), syncQueued: ctx.dubsync.queued(it.key),
    langCheck: it.langCheck ? { ...it.langCheck, fileIds: undefined } : null, langChecking: ctx.langChecker.current === it.key,
    badDonors: ctx.merger.badDonorsOf(it.key),
  };
}

// Chybějící položky (první stažení, firstgrab.js) nemají soubor – do Knihovny ani statistik nepatří
const libraryItems = () => Object.values(store.s.items).filter((i) => !i.missing);

function overview() {
  const items = libraryItems();
  const tiers = [0, 0, 0, 0];
  items.forEach((i) => tiers[i.current.tier]++);
  return {
    version: require('../package.json').version,
    radarr: ctx.radarr.enabled, sonarr: ctx.sonarr.enabled,
    notify: { telegram: ctx.notify.telegram, ntfy: ctx.notify.ntfy },
    qbit: ctx.qbit.enabled,
    speech: speech.available(),
    gpu: { ...gpu.summary(store.settings.useGpu), checking: gpuChecking, lastCheck: store.s.gpuCheck },
    versions: ctx.versions,
    scannerEnabled: store.settings.scannerEnabled,
    maxSearchesPerDay: store.settings.maxSearchesPerDay,
    watched: items.filter((i) => W.watchOf(store, i)).length,
    lastSync: store.s.lastSync,
    items: items.length,
    tiers,
    pending: Object.values(store.s.proposals).filter((p) => p.status === 'pending').length,
    downloading: ctx.downloads.active().length + ctx.merger.active().length + ctx.dubsync.active().length,
    syncCheck: ctx.dubsync.status(),
    langQueue: ctx.langChecker.status(),
    stalls: ctx.stallGuard.summary(),
    firstGrab: ctx.firstGrab.summary(),
    jellyseerr: ctx.jellyseerr.summary(),
    queue: ctx.searcher.eligible().length,
    searchingNow: ctx.searcher.current ? itemLabel(store.s.items[ctx.searcher.current] || { title: ctx.searcher.current }) : null,
    manualQueue: ctx.searcher.manual.length,
    searchesToday: store.s.searchCounter.day === new Date().toISOString().slice(0, 10) ? store.s.searchCounter.count : 0,
    tierLabels: L.tierLabels(),
    languages: languagesInfo(),
    locale: I18N.locale(),
    setupNeeded: !L.primary(),
    readOnly: READ_ONLY,
  };
}

function languagesInfo() {
  const info = (code) => (code ? { code, label: L.label(code), name: LANGS.get(code)?.name, flag: LANGS.flagOf(code) } : null);
  return { primary: info(L.primary()), secondary: info(L.secondary()) };
}

// Ostatní série téhož seriálu, kterých se návrh netýká – ať je jasné, že návrh platí jen pro tuhle sérii
function otherSeasons(p) {
  const it = store.s.items[p.itemKey];
  if (it?.app !== 'sonarr') return [];
  const keys = new Set(proposalKeys(p));
  const all = libraryItems().filter((x) => x.app === 'sonarr' && x.arrId === it.arrId);
  const have = new Set(all.map((x) => x.season));
  // série bez souborů mezi staženými (položky vznikají jen ze souborů) – ať v přehledu není díra
  const missing = Array.from({ length: Math.max(...have) }, (_, i) => i + 1).filter((n) => !have.has(n))
    .map((season) => ({ season, tier: null }));
  return [...all.filter((x) => !keys.has(x.key)).map((x) => ({ season: x.season, tier: x.current.tier })), ...missing]
    .sort((a, b) => a.season - b.season);
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/overview', () => overview());
route('GET', '/api/items', () => libraryItems().map(itemView));
// Návrhy prvního stažení se schvalují samy – ukazuje se jen stahování v Aktivitě
route('GET', '/api/proposals', () => Object.values(store.s.proposals)
  .filter((p) => !p.first && (p.status === 'pending' || Date.now() - Date.parse(p.updatedAt) < 14 * 86400e3))
  .map((p) => ({
    ...p,
    candidates: (p.candidates || []).map((c) => ({ ...publicCand(c), cid: candId(c) })),
    item: store.s.items[p.itemKey] ? itemView(store.s.items[p.itemKey]) : null,
    otherSeasons: otherSeasons(p),
    approving: ctx.inflight.get(p.id) || null, // guid kandidáta, který se právě schvaluje
  }))
  .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.updatedAt).localeCompare(String(a.updatedAt))));
route('GET', '/api/downloads', () => allJobs().sort((a, b) => (b.active - a.active) || b.grabbedAt - a.grabbedAt).slice(0, 200)
  .map((j) => ({ ...j, candidate: publicCand(j.candidate), offerPending: store.s.proposals[j.offerProposalId]?.status === 'pending' })));
route('GET', '/api/log', () => store.s.log.slice(-400).reverse());
route('GET', '/api/settings', () => ({ settings: store.settings, defaults: DEFAULT_SETTINGS }));
// Jazyky, které jde vybrat (názvy si UI přeloží samo přes Intl.DisplayNames), a jazyky textů UI
route('GET', '/api/languages', () => ({
  languages: LANGS.LANGUAGES.map((l) => ({ code: l.code, label: l.label, name: l.name, flag: LANGS.flagOf(l.code), indexers: l.indexers })),
  locales: I18N.LOCALES,
}));

route('PUT', '/api/settings', async (req) => {
  const body = await readBody(req);
  const retentionKeys = () => [store.settings.keepBackupDays, store.settings.maxBackupGB, store.settings.backupDeleteVerified].join();
  const backupRetention = retentionKeys();
  const langsBefore = [store.settings.language, store.settings.secondLanguage].join();
  const pri = 'language' in body ? String(body.language || '') : store.settings.language;
  const sec = 'secondLanguage' in body ? String(body.secondLanguage || '') : store.settings.secondLanguage;
  if (pri && !LANGS.get(pri)) throw new Error(I18N.t('settings.err.unknownLanguage', { code: pri }));
  if (sec && !LANGS.get(sec)) throw new Error(I18N.t('settings.err.unknownLanguage', { code: sec }));
  if (pri && pri === sec) throw new Error(I18N.t('settings.err.sameLanguages'));
  const firstGrabWas = [store.settings.firstGrab, store.settings.firstGrabMovies, store.settings.firstGrabSeries].join();
  const { values, errors } = validateSettings(body, store.settings, { uiLanguage: ['auto', ...I18N.LOCALES] });
  if (errors.length) throw Object.assign(new Error(I18N.t('settings.err.invalid', { errors: errors.join('; ') })), { status: 400 });
  Object.assign(store.settings, values);
  applyLanguages();
  const langsChanged = [store.settings.language, store.settings.secondLanguage].join() !== langsBefore;
  if (langsChanged) resetForLanguages();
  store.save();
  store.log('info', I18N.t('server.settingsSaved'));
  // Nová retence záloh platí hned, i pro stávající zálohy
  if (retentionKeys() !== backupRetention) ctx.backups.tick();
  // Zapnuté první stažení: hned si zapamatovat, co teď chybí (to se Updaterru netýká)
  if (!READ_ONLY && [store.settings.firstGrab, store.settings.firstGrabMovies, store.settings.firstGrabSeries].join() !== firstGrabWas) {
    if (store.settings.firstGrab) ctx.firstGrab.poke(0); else ctx.firstGrab.poll().catch(() => {});
  }
  return { settings: store.settings };
});

// Jiné jazyky = jiné úrovně i návrhy: čekající návrhy zrušit, změřenou synchronizaci zahodit, vše zkontrolovat znovu
function resetForLanguages() {
  const now = new Date().toISOString();
  for (const p of Object.values(store.s.proposals)) {
    if (p.status === 'pending') Object.assign(p, { status: 'expired', note: I18N.t('settings.languagesChanged'), updatedAt: now });
  }
  for (const it of Object.values(store.s.items)) {
    it.lastSearchedAt = null;
    delete it.syncCheck;
  }
  store.log('info', I18N.t('settings.languagesLog', { langs: L.tierLabel(3) }));
  syncLibrary(ctx).catch((e) => store.log('error', e.message));
}

route('POST', '/api/sync', async () => { await syncLibrary(ctx); return overview(); });

route('POST', '/api/items/:key/check', (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  it.ignoredUntil = null;
  ctx.searcher.enqueue(it.key, { reason: I18N.t('search.reason.manual') });
  return { queued: true };
});

route('POST', '/api/items/:key/ignore', async (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  const { days = 3650 } = await readBody(req);
  if (Object.values(store.s.proposals).some((p) => ctx.inflight.has(p.id) && proposalKeys(p).includes(it.key))) {
    throw new Error(I18N.t('server.err.approvingItem'));
  }
  it.ignoredUntil = Number(days) > 0 ? new Date(Date.now() + Number(days) * 86400e3).toISOString() : null;
  for (const p of Object.values(store.s.proposals)) if (p.itemKey === it.key && !p.groupKey && p.status === 'pending') p.status = 'rejected';
  store.save();
  return itemView(it);
});

// Hromadně: znovu zkontrolovat (vynulovat "naposledy hledáno") – filtr podle úrovně
// Hlídání: kontrolovat častěji a upgrade stáhnout bez ptaní. U seriálu platí pro celý seriál.
route('POST', '/api/items/:key/watch', async (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  const { enabled = true, auto = true } = await readBody(req);
  W.setWatch(store, it, { enabled: Boolean(enabled), auto: Boolean(auto) });
  const what = it.app === 'sonarr' ? it.title : itemLabel(it);
  store.log('info', I18N.t(enabled ? (auto ? 'server.watchOnAuto' : 'server.watchOn') : 'server.watchOff', { what }));
  if (enabled) {
    for (const x of Object.values(store.s.items)) {
      if (x.key === it.key || (it.app === 'sonarr' && x.app === 'sonarr' && x.arrId === it.arrId)) {
        if (itemNeeds(x, store.settings, W.wantOf(store, x), W.codecOf(store, x)).any) ctx.searcher.enqueue(x.key, { reason: I18N.t('server.reason.watchOn') });
      }
    }
  }
  return itemView(it);
});

// Hledané jazyky (sloty): { langs: ['pri'] | ['sec'] | ['pri', 'sec'] }. U seriálu platí pro celý seriál.
route('POST', '/api/items/:key/languages', async (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  const { langs } = await readBody(req);
  if (!Array.isArray(langs) || !langs.some((l) => L.WANT_LANGS.includes(l))) throw new Error(I18N.t('server.err.pickLanguage'));
  const want = W.setWant(store, it, langs);
  const affected = Object.values(store.s.items).filter((x) => x.key === it.key || (it.app === 'sonarr' && x.app === 'sonarr' && x.arrId === it.arrId));
  const keys = new Set(affected.map((x) => x.key));
  const note = I18N.t('server.note.wantChanged', { langs: L.wantLabel(want) });
  for (const p of Object.values(store.s.proposals)) {
    if (p.status !== 'pending' || !proposalKeys(p).some((k) => keys.has(k))) continue;
    // Balík více sérií se při dalším hledání najde znovu podle nových jazyků
    if (p.groupKey) Object.assign(p, { status: 'expired', note, updatedAt: new Date().toISOString() });
    else LC.prune(ctx, p, store.s.items[p.itemKey], { note: I18N.t('server.note.wantNothing', { note }) });
  }
  // Při dalším průchodu zkontrolovat znovu (podle nových jazyků)
  for (const x of affected) x.lastSearchedAt = null;
  store.save();
  store.log('info', I18N.t(want ? 'server.wantLangs' : 'server.wantLangsDefault', { what: it.app === 'sonarr' ? it.title : itemLabel(it), langs: L.wantLabel(want) }));
  return itemView(it);
});

// Hledaný formát videa: { codec: null | 'hevc' | 'av1' }. U seriálu platí pro celý seriál.
route('POST', '/api/items/:key/codec', async (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  const { codec = null } = await readBody(req);
  if (codec != null && !C.normWantCodec(codec)) throw new Error(I18N.t('server.err.unknownCodec'));
  const want = W.setCodec(store, it, codec);
  const affected = Object.values(store.s.items).filter((x) => x.key === it.key || (it.app === 'sonarr' && x.app === 'sonarr' && x.arrId === it.arrId));
  const keys = new Set(affected.map((x) => x.key));
  const note = want ? I18N.t('server.note.codecChanged', { codec: C.wantCodecLabel(want) }) : I18N.t('server.note.codecOff');
  for (const p of Object.values(store.s.proposals)) {
    if (p.status !== 'pending' || !proposalKeys(p).some((k) => keys.has(k))) continue;
    if (p.groupKey) Object.assign(p, { status: 'expired', note, updatedAt: new Date().toISOString() });
    else LC.prune(ctx, p, store.s.items[p.itemKey], { note: I18N.t('server.note.wantNothing', { note }) });
  }
  for (const x of affected) x.lastSearchedAt = null;
  store.save();
  store.log('info', I18N.t('server.wantCodec', { what: it.app === 'sonarr' ? it.title : itemLabel(it), codec: C.wantCodecLabel(want) }));
  // Otevřenou položku hledat hned, ostatní série se zkontrolují při dalším průchodu
  if (want && itemNeeds(it, store.settings, W.wantOf(store, it), want).codec && !ctx.busyKeys().has(it.key)) ctx.searcher.enqueue(it.key, { reason: I18N.t('server.reason.wantCodec') });
  return itemView(it);
});

// Synchronizace dabingu: změřit znovu (hned, bez pauzy) / opravit (nový soubor s posunutou CZ stopou → import)
route('POST', '/api/items/:key/synccheck', (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  if (!syncable(it)) throw new Error(I18N.t('server.err.notSyncable', { p: L.label(L.primary()), s: L.label(L.secondary()) }));
  ctx.dubsync.enqueue(it.key);
  return itemView(it);
});

route('POST', '/api/items/:key/syncfix', (req, { params }) => {
  const j = ctx.dubsync.start(params.key);
  return { download: { id: j.id, type: j.type, title: j.title } };
});

// Hromadná oprava synchronizace: `keys` = položky zobrazené ve filtru (bez nich všechny posunuté)
route('POST', '/api/syncfix-all', async (req) => {
  const { keys } = await readBody(req);
  const { started, skipped } = ctx.dubsync.startAll(Array.isArray(keys) ? keys : null);
  return { started: started.length, skipped: skipped.length };
});

// Ověřit jazyk stop poslechem (whisper) – trvá desítky sekund, u série se ověřují 3 epizody
route('POST', '/api/items/:key/verify-language', async (req, { params }) => {
  const it = store.s.items[params.key];
  if (!it) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
  if (!speech.available()) throw new Error(I18N.t('server.err.noSpeech'));
  if (ctx.langChecker.running || ctx.langChecker.current) throw new Error(I18N.t('server.err.langCheckBusy'));
  ctx.langChecker.current = it.key;
  try {
    const r = await LC.verify(ctx, it, { reason: I18N.t('search.reason.manual') });
    if (r.changed) {
      for (const p of Object.values(store.s.proposals)) if (p.status === 'pending' && !p.groupKey && p.itemKey === it.key) LC.prune(ctx, p, store.s.items[it.key]);
    }
    return itemView(store.s.items[it.key]);
  } finally {
    ctx.langChecker.current = null;
  }
});

// Hromadný poslech: ověřit jazyk stop u všech (neověřených) položek – postupně na pozadí, hledání má přednost
route('POST', '/api/verify-all', async (req) => {
  const { app, force = false } = await readBody(req);
  if (!speech.available()) throw new Error(I18N.t('server.err.noSpeech'));
  const scope = libraryItems().filter((it) => !app || it.app === app);
  // neověřené, a znovu i ty, u kterých poslech dřív selhal (force = poslechnout i ověřené)
  const failed = (it) => !LC.unverified(it) && it.langCheck?.error;
  const n = ctx.langChecker.enqueueAll(scope.filter((it) => !force && LC.unverified(it)).map((it) => it.key))
    + ctx.langChecker.enqueueAll(scope.filter((it) => force || failed(it)).map((it) => it.key), { force: true });
  store.log('info', I18N.t(force ? 'server.verifyAllForce' : 'server.verifyAll', { count: n }));
  ctx.langChecker.tick().catch((e) => store.log('error', e.message));
  return { queued: n, ...ctx.langChecker.status() };
});

route('DELETE', '/api/verify-all', () => {
  const left = ctx.langChecker.cancel();
  if (left) store.log('info', I18N.t('server.verifyAllCancelled', { count: left }));
  return { cancelled: left };
});

route('POST', '/api/check-all', async (req) => {
  const { maxTier = 2, app } = await readBody(req);
  let n = 0;
  for (const it of Object.values(store.s.items)) {
    if (app && it.app !== app) continue;
    if (it.current.tier > Number(maxTier)) continue;
    it.lastSearchedAt = null;
    n++;
  }
  store.save();
  store.log('info', I18N.t('server.checkAll', { count: n, sec: store.settings.searchIntervalSec }));
  return { reset: n };
});

route('POST', '/api/proposals/:id/grab/:ref', async (req, { params }) => {
  const d = await ctx.grab(params.id, params.ref);
  return { download: { id: d.id, type: d.type || 'download', title: d.title } };
});

route('POST', '/api/proposals/:id/reject', async (req, { params }) => {
  const p = store.s.proposals[params.id];
  if (!p) throw Object.assign(new Error(I18N.t('err.proposalNotFound')), { status: 404 });
  const { days = 3650, guid } = await readBody(req);
  if (p.status === 'grabbed') throw new Error(I18N.t('err.proposalDownloading'));
  if (ctx.inflight.has(p.id)) throw new Error(I18N.t('server.err.approving'));
  if (guid) {
    // jen jeden kandidát
    store.s.ignoredGuids[guid] = Date.now();
    p.candidates = p.candidates.filter((c) => c.guid !== guid);
    if (!p.candidates.length) p.status = 'rejected';
  } else {
    rejectProposal(ctx, p, days);
  }
  p.updatedAt = new Date().toISOString();
  store.save();
  return p;
});

// Nevhodný donor (sloučení s ním neprošlo) zase povolit
route('DELETE', '/api/bad-donors/:id', (req, { params }) => { ctx.merger.forgetBadDonor(params.id); return { ok: true }; });
route('POST', '/api/bad-donors/:id/retry', (req, { params }) => { ctx.merger.forgetBadDonor(params.id, { retry: true }); return { ok: true }; });

route('POST', '/api/downloads/:id/cancel', async (req, { params }) => {
  if (store.s.syncFixes[params.id]) await ctx.dubsync.cancel(params.id);
  else await (store.s.merges[params.id] ? ctx.merger.cancel(params.id) : ctx.downloads.cancel(params.id));
  return { ok: true };
});
// Zálohy původních souborů (slučování stop, opravy synchronizace)
route('GET', '/api/backups', () => ctx.backups.overview());
// Retence: { keepBackupDays, maxBackupGB, deleteVerified?, dryRun } – s dryRun jen vrátí, co by se smazalo
route('POST', '/api/backups/retention', async (req) => {
  const { keepBackupDays, maxBackupGB, deleteVerified: dv, dryRun } = await readBody(req);
  const days = Number(keepBackupDays);
  const maxGB = Number(maxBackupGB);
  const deleteVerified = dv == null ? store.settings.backupDeleteVerified : Boolean(dv);
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(maxGB) || maxGB < 0) throw new Error(I18N.t('server.err.nonNegative'));
  if (dryRun) return { removed: ctx.backups.retention({ days, maxGB, deleteVerified }) };
  store.settings.keepBackupDays = days;
  store.settings.maxBackupGB = maxGB;
  store.settings.backupDeleteVerified = deleteVerified;
  store.save();
  store.log('info', I18N.t('server.retention', { count: days, max: (maxGB ? I18N.t('server.retentionMax', { gb: maxGB }) : '') + (deleteVerified ? I18N.t('server.retentionVerified') : '') }));
  return { removed: ctx.backups.tick(), settings: store.settings };
});
route('POST', '/api/backups/:id/verify', async (req, { params }) => {
  const removed = await ctx.backups.verify(params.id);
  return { check: ctx.backups.list().find((b) => b.id === params.id)?.check || null, removed };
});
route('POST', '/api/backups/:id/delete', (req, { params }) => ctx.backups.remove(params.id, I18N.t('backup.reason.manual')));
route('POST', '/api/backups/:id/keep', async (req, { params }) => ctx.backups.keep(params.id, await readBody(req)));

// Grafická karta: ověří zařízení, oprávnění, Vulkan a výpočet na testovací nahrávce (porovná s procesorem)
let gpuChecking = false;
async function checkGpu(reason) {
  if (gpuChecking) throw new Error(I18N.t('server.err.gpuBusy'));
  if (!speech.available()) throw new Error(I18N.t('server.err.noSpeech'));
  gpuChecking = true;
  try {
    const r = await gpu.check({ model: speech.modelPath(store.settings.speechModel) });
    store.s.gpuCheck = r;
    const bad = r.steps.find((x) => !x.ok);
    store.log(r.ok ? 'info' : 'warn', r.ok
      ? I18N.t('server.gpuOk', { device: r.device, gpu: r.gpu.encodeMs ?? r.gpu.ms, cpu: r.cpu.encodeMs ?? r.cpu.ms, reason })
      : I18N.t('server.gpuBad', { step: bad.label, detail: bad.detail, reason }));
    return r;
  } finally {
    gpuChecking = false;
  }
}
route('POST', '/api/gpu/check', () => checkGpu(I18N.t('search.reason.manual')));

route('POST', '/api/notify/test', async () => { await ctx.notify.test(); return { ok: true }; });

// Notifikační centrum (inbox.js) – nejnovější první; u návrhů i to, jestli ještě čekají na rozhodnutí
route('GET', '/api/notifications', () => ({
  unread: ctx.inbox.unread(),
  list: ctx.inbox.list.slice().reverse().map((n) => {
    const p = n.link?.proposal ? store.s.proposals[n.link.proposal] : null;
    return n.link?.proposal ? { ...n, open: p?.status === 'pending' } : n;
  }),
}));
route('POST', '/api/notifications/read', async (req) => {
  const { ids } = await readBody(req);
  ctx.inbox.markRead(Array.isArray(ids) ? ids.map(String) : null);
  return { unread: ctx.inbox.unread() };
});
route('POST', '/api/notifications/clear', async (req) => {
  const { onlyRead } = await readBody(req);
  ctx.inbox.clear(Boolean(onlyRead));
  return { unread: ctx.inbox.unread() };
});
route('DELETE', '/api/notifications/:id', (req, { params }) => { ctx.inbox.remove(params.id); return { unread: ctx.inbox.unread() }; });

// Webhook z Radarru/Sonarru (Settings → Connect → Webhook, události "On File Import" a "On File Upgrade").
// Novinky se sbírají a za 3 minuty (až Radarr/Sonarr spočítá MediaInfo) se načte knihovna a zkontrolují.
const webhookKeys = new Set();
let webhookTimer = null;
function flushWebhooks() {
  webhookTimer = null;
  const keys = [...webhookKeys];
  webhookKeys.clear();
  syncLibrary(ctx)
    .catch((e) => store.log('warn', I18N.t('server.webhookSyncFailed', { error: e.message })))
    .finally(() => {
      for (const k of keys) {
        const it = store.s.items[k];
        if (it && itemNeeds(it, store.settings, W.wantOf(store, it), W.codecOf(store, it)).any && !ctx.busyKeys().has(k)) {
          ctx.searcher.enqueue(k, { reason: I18N.t('server.reason.newDownload') });
          store.log('info', I18N.t('server.newDownload', { label: itemLabel(it), tier: L.tierLabel(it.current.tier) }));
        }
      }
    });
}
route('POST', '/api/webhook/:app', async (req, { params, query }) => {
  if (env.WEBHOOK_TOKEN && query.get('token') !== env.WEBHOOK_TOKEN) throw Object.assign(new Error(I18N.t('server.err.badToken')), { status: 401 });
  if (!['radarr', 'sonarr'].includes(params.app)) throw Object.assign(new Error(I18N.t('server.err.unknownApp')), { status: 404 });
  const body = await readBody(req);
  const ev = body.eventType;
  if (ev === 'Test') return { ok: true };
  // Nový film / seriál, nebo Radarr/Sonarr něco stáhl → první stažení (firstgrab.js) to projde hned
  if (['MovieAdded', 'SeriesAdd', 'Grab'].includes(ev)) {
    if (!READ_ONLY) ctx.firstGrab.poke();
    return { ok: true };
  }
  if (ev !== 'Download') return { ignored: ev };
  if (params.app === 'radarr' && Number.isInteger(body.movie?.id)) webhookKeys.add(`radarr:${body.movie.id}`);
  if (params.app === 'sonarr' && Number.isInteger(body.series?.id) && Array.isArray(body.episodes)) {
    for (const e of body.episodes) if (Number.isInteger(e?.seasonNumber)) webhookKeys.add(`sonarr:${body.series.id}:${e.seasonNumber}`);
  }
  if (webhookKeys.size && !webhookTimer) webhookTimer = setTimeout(flushWebhooks, 3 * 60e3);
  return { ok: true };
});

route('GET', '/api/health', () => ({ ok: true }));

// V náhledu (READ_ONLY) jde měnit jen stav v data/ – nastavení, hledané jazyky, hlídání, odmítnutí návrhu
const READ_ONLY_ALLOWED = [/^\/api\/settings$/, /^\/api\/sync$/, /^\/api\/items\/[^/]+\/(languages|codec|watch|ignore)$/, /^\/api\/proposals\/[^/]+\/reject$/,
  /^\/api\/notifications(\/[^/]+)?$/];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const isPublic = url.pathname.startsWith('/api/webhook/') || url.pathname === '/api/health';
  if (!isPublic && !authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Updaterr", charset="UTF-8"' });
    return res.end('Unauthorized');
  }

  if (url.pathname.startsWith('/api/')) {
    if (csrfBlocked(req, url.pathname)) return send(res, 403, { error: I18N.t('server.err.crossSite') });
    if (READ_ONLY && req.method !== 'GET' && !READ_ONLY_ALLOWED.some((re) => re.test(url.pathname))) {
      return send(res, 403, { error: I18N.t('readOnly.blocked') });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const out = await r.fn(req, { params, query: url.searchParams });
        return send(res, 200, out ?? { ok: true });
      } catch (e) {
        return send(res, e.status || 400, { error: e.message });
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  // Statické soubory
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, 400, { error: e.message });
    else res.end();
  });
});

// --- Start ------------------------------------------------------------------------

async function main() {
  if (!ctx.radarr.enabled && !ctx.sonarr.enabled) {
    console.error(I18N.t('server.noArr'));
  }
  for (const c of [ctx.radarr, ctx.sonarr]) {
    if (!c.enabled) continue;
    try {
      const s = await c.status();
      ctx.versions[c.kind] = s.version;
      store.log('info', I18N.t('server.connected', { app: c.kind, version: s.version }));
    } catch (e) {
      store.log('error', I18N.t('server.unavailable', { app: c.kind, error: e.message }));
    }
  }
  if (ctx.qbit.enabled) {
    try {
      ctx.versions.qbit = await ctx.qbit.version();
      store.log('info', I18N.t('server.qbitConnected', { version: ctx.versions.qbit }));
    } catch (e) {
      store.log('error', I18N.t('server.qbitUnavailable', { error: e.message }));
    }
  } else {
    store.log('info', I18N.t('server.qbitNotSet'));
  }
  server.listen(PORT, () => store.log('info', I18N.t(READ_ONLY ? 'server.listeningReadOnly' : 'server.listening', { port: PORT })));
  if (READ_ONLY) {
    await syncLibrary(ctx);
    setInterval(() => syncLibrary(ctx).catch((e) => store.log('error', e.message)), Math.max(5, store.settings.librarySyncMin) * 60e3);
    return;
  }
  if (store.settings.useGpu && speech.available()) checkGpu(I18N.t('server.reason.start')).catch((e) => store.log('warn', I18N.t('server.gpuCheckFailed', { error: e.message })));

  await syncLibrary(ctx);
  // setTimeout místo setInterval: změna intervalu v Nastavení platí hned od dalšího kola
  const librarySync = () => setTimeout(() => syncLibrary(ctx).catch((e) => store.log('error', e.message)).finally(librarySync),
    Math.max(5, store.settings.librarySyncMin) * 60e3);
  librarySync();
  setInterval(() => ctx.searcher.tick().catch((e) => store.log('error', e.message)), 5_000);
  setInterval(() => ctx.downloads.tick().catch((e) => store.log('error', e.message)), 60_000);
  setInterval(() => ctx.merger.tick().catch((e) => store.log('error', e.message)), 30_000);
  setInterval(() => ctx.langChecker.tick().catch((e) => store.log('error', e.message)), 20_000);
  setInterval(() => ctx.dubsync.tick().catch((e) => store.log('error', e.message)), 10_000);
  // Ověření sloučení v knihovně + úklid záloh podle retence
  const backupsTick = () => ctx.backups.verify().catch((e) => store.log('error', I18N.t('server.backupCleanup', { error: e.message })));
  setTimeout(backupsTick, 2 * 60e3);
  setInterval(backupsTick, 10 * 60e3);
  setInterval(() => ctx.stallGuard.tick().catch((e) => store.log('error', I18N.t('server.stallError', { error: e.message }))), 60_000);
  setInterval(() => ctx.torrentCleanup.tick().catch((e) => store.log('error', I18N.t('server.cleanupError', { error: e.message }))), 2 * 60e3);
  // První stažení nově přidaných: co nově chybí, každou minutu (webhook přidání to urychlí)
  const firstGrabError = (e) => store.log('error', I18N.t('server.firstGrabError', { error: e.message }));
  setInterval(() => ctx.firstGrab.poll().catch(firstGrabError), 60_000);
  setInterval(() => ctx.firstGrab.tick().catch(firstGrabError), 5_000);
  ctx.firstGrab.poll().catch(firstGrabError);
  // Úklid stavu: vyřízené návrhy a staré záznamy, zablokované releasy (store.prune) – hned a pak každých 6 h
  const prune = () => { try { store.prune(); } catch (e) { store.log('error', I18N.t('server.pruneError', { error: e.message })); } };
  prune();
  setInterval(prune, 6 * 3600e3);
  ctx.notify.pollTelegram();
}

// Pojistka: chyba v nějaké asynchronní větvi nesmí shodit celý proces
process.on('unhandledRejection', (e) => store.log('error', I18N.t('server.unhandledRejection', { error: e?.stack || e })));
process.on('uncaughtException', (e) => store.log('error', I18N.t('server.uncaughtException', { error: e?.stack || e })));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { store.flush(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Jednoduché perzistentní úložiště v JSON (atomický zápis, debounce).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('./i18n');

const env = process.env;

const DEFAULT_SETTINGS = {
  // Jazyky (ISO 639-1, viz languages.js): hledaný dabing a druhý jazyk (obvykle originál). Bez primárního
  // jazyka se knihovna neprochází – nastavuje se v UI, nebo výchozí hodnotou PRIMARY_LANGUAGE / SECOND_LANGUAGE.
  language: env.PRIMARY_LANGUAGE || '',
  secondLanguage: env.SECOND_LANGUAGE || 'en',
  uiLanguage: env.UI_LANGUAGE || 'auto', // auto = podle primárního jazyka, když pro něj je překlad, jinak angličtina
  scannerEnabled: true,       // automaticky procházet knihovnu       // automaticky procházet knihovnu
  scanRadarr: true,
  scanSonarr: true,
  searchIntervalSec: 90,      // pauza mezi dvěma hledáními (šetří indexery)
  maxSearchesPerDay: 300,
  recheckDays: 14,            // jak často znovu zkoušet položku, která ještě nemá cíl
  librarySyncMin: 60,
  qualityUpgrades: true,      // navrhovat i čistě kvalitativní upgrade (stejný jazyk, lepší kvalita)
  allowLowerQualityForLanguage: true, // např. CZ 720p místo EN 1080p? (s varováním)
  minResolution: 720,
  maxResolution: 1080,
  minSeeders: 3,
  maxMovieSizeGB: 30,
  maxEpisodeSizeGB: 5,
  candidatesPerProposal: 5,
  multiSeasonPacks: true,     // seriály: nabízet i balíky více sérií ("S01-S04") – stahují se přes Sonarr override
  episodeSets: true,          // seriály: když balík není, nabídnout sadu jednotlivých epizod
  maxEpisodeSetParts: 30,     // max. počet torrentů v jedné sadě epizod
  localIndexers: '',          // části názvů místních trackerů – release "MULTI" odsud je nejspíš i v primárním jazyce
  autoGrab: 'off',            // off | target (jen cíl: oba jazyky) | any (jakýkoli jistý upgrade)
  autoMinSeeders: 10,
  stallHours: 3,              // bez pokroku tak dlouho → zablokovat a zkusit dalšího kandidáta
  retryOnStall: true,
  maxRetries: 3,
  // Zaseknuté torrenty v qBittorrentu (všechny, nejen Updaterr) zastavit, ať uvolní frontu (stalled.js)
  qbitStopStalled: false,
  qbitStallMin: 30,           // bez spojení tak dlouho → zastavit
  qbitStallRetryMin: 120,     // zastavené po takové době znovu spustit a zkusit, jestli už jdou stáhnout
  forceImport: true,          // Radarr/Sonarr odmítne import "není upgrade" → importovat ručně
  qbitRemoveImported: true,   // po importu smazat torrent z qBittorrentu i se soubory (cleanup.js) – vypnout = seedovat
  notifyProposals: true,
  notifyDownloads: true,
  // Slučování stop: stáhnout jen chybějící jazyk a přidat ho do stávajícího souboru
  mergeEnabled: true,
  mergePrimaryDefault: true,  // přidaná stopa v primárním jazyce jako výchozí
  mergeCredit: true,          // do názvu přidané stopy připsat „(By: Updaterr)“
  mergeMaxDonorGB: 20,        // max. velikost "donoru" u filmu (u seriálů platí max. na epizodu)
  mergeSaveData: false,       // šetřit data: u přidání zvuku vyhrává nejmenší vhodný donor
  mergeMaxOffsetSec: 30,      // jak velký posun stop ještě hledat
  mergeDeleteDonor: true,     // po sloučení donor smazat z qBittorrentu
  keepBackupDays: 7,          // záloha původního souboru (hardlink) – kolik dní po dokončení ponechat (backups.js)
  maxBackupGB: 0,             // max. místo, které zálohy smějí zabírat (0 = bez limitu) – pak se mažou nejstarší
  backupDeleteVerified: false, // zálohu smazat hned po ověřeném sloučení / opravě; při odchylce zůstane a přijde notifikace
  // Složka pro donory a zálohy – musí ji vidět qBittorrent i Radarr/Sonarr pod stejnou cestou
  stagingDir: env.STAGING_DIR || '',
  // Volitelně samostatný staging pro filmy (radarr) a seriály (sonarr): každý na stejném
  // filesystému jako svá média, aby zálohy šly hardlinkem a import byl okamžitý rename
  stagingDirRadarr: env.STAGING_DIR_RADARR || '',
  stagingDirSonarr: env.STAGING_DIR_SONARR || '',
  qbitCategory: 'updaterr',
  // Hlídané položky (nastavují se u filmu/seriálu): kontrola častěji + automatický upgrade
  watchIntervalDays: 2,
  autoWatchNew: 'off',        // off | auto | ask – nově přidané filmy a seriály začnou hlídat samy (watch.js)
  // První stažení nově přidaných (firstgrab.js): release vybere Updaterr, ne Radarr/Sonarr
  firstGrab: false,
  firstGrabMovies: true,
  firstGrabSeries: true,
  firstGrabCancelArr: true,   // co mezitím stáhl sám Radarr/Sonarr (a je to jiný release), zrušit
  firstGrabFallback: true,    // nic vhodného / všechny pokusy selhaly → spustit hledání v Radarru/Sonarru
  // Ověřit jazyk poslechem (whisper.cpp) – odhalí chybně označené stopy, např. českou stopu jako "eng"
  verifySpeech: true,
  useGpu: true,               // Whisper na grafické kartě (Vulkan), když je připojená – jinak procesor (gpu.js)
  speechModel: 'base',        // base | small – small je přesnější (líp rozezná CZ × SK), na procesoru ~3× pomalejší
  // Synchronizace dabingu u souborů s oběma jazyky (dubsync.js)
  syncCheckEnabled: true,     // postupně měřit na pozadí
  syncCheckPauseSec: 60,      // pauza mezi dvěma soubory (min. 3× délka měření)
  syncWarnMs: 80,             // od jakého posunu upozornit a nabídnout opravu
};

// Meze nastavení (stejné jako ve webu) – 0 tam, kde znamená nesmysl: stallHours 0 = každé stahování je hned
// "mrtvé", qbitStallMin 0 = zastavit všechno, co zrovna nemá spojení, searchIntervalSec 0 = zahltit indexery
const SETTING_LIMITS = {
  searchIntervalSec: [10], maxSearchesPerDay: [1], recheckDays: [1], watchIntervalDays: [1], librarySyncMin: [5],
  maxMovieSizeGB: [1], maxEpisodeSizeGB: [0.5], candidatesPerProposal: [1, 20], maxEpisodeSetParts: [2],
  autoMinSeeders: [1], stallHours: [1], maxRetries: [1, 10], qbitStallMin: [5], qbitStallRetryMin: [15],
  mergeMaxDonorGB: [1], mergeMaxOffsetSec: [1, 600], syncCheckPauseSec: [10], syncWarnMs: [20],
  minResolution: [240, 4320], maxResolution: [240, 4320],
};
const SETTING_CHOICES = { autoGrab: ['off', 'target', 'any'], autoWatchNew: ['off', 'auto', 'ask'], speechModel: ['base', 'small'] };
// Texty, které smějí být prázdné (jazyk ještě nevybraný, žádné místní trackery, staging nenastavený)
const EMPTY_OK = new Set(['language', 'secondLanguage', 'localIndexers', 'stagingDir', 'stagingDirRadarr', 'stagingDirSonarr']);

/**
 * Kontrola změn nastavení z webu: { values, errors }. Neznámé klíče se ignorují; když je něco špatně,
 * neuloží se nic (errors = seznam "klíč: důvod"). `choices` doplní povolené hodnoty dalších textů
 * (jazyk rozhraní – seznam překladů zná server).
 */
function validateSettings(body, current, choices = {}) {
  const values = {};
  const errors = [];
  const allowed = { ...SETTING_CHOICES, ...choices };
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!body || !(k in body)) continue;
    const v = body[k];
    if (typeof def === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      const [min = 0, max = Infinity] = SETTING_LIMITS[k] || [];
      if (!Number.isFinite(n)) errors.push(t('settings.err.notNumber', { key: k }));
      else if (n < min || n > max) errors.push(t(max === Infinity ? 'settings.err.atLeast' : 'settings.err.range', { key: k, min, max }));
      else values[k] = n;
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') values[k] = v;
      else errors.push(t('settings.err.notBoolean', { key: k }));
    } else if (allowed[k]) {
      if (allowed[k].includes(v)) values[k] = v;
      else errors.push(t('settings.err.choice', { key: k, choices: allowed[k].join(' / ') }));
    } else if (typeof v !== 'string' || (!EMPTY_OK.has(k) && !v.trim())) {
      errors.push(t('settings.err.notText', { key: k }));
    } else if (k.startsWith('stagingDir') && v.trim() && !v.trim().startsWith('/')) {
      errors.push(t('settings.err.notAbsolute', { key: k }));
    } else values[k] = k === 'localIndexers' ? v : v.trim();
  }
  const res = (k) => (k in values ? values[k] : current?.[k]);
  if (res('minResolution') > res('maxResolution')) errors.push(t('settings.err.minAboveMax'));
  return { values, errors };
}

const EMPTY_STATE = () => ({
  settings: { ...DEFAULT_SETTINGS },
  items: {},
  proposals: {},
  downloads: {},
  merges: {},                 // slučování stop (merge.js)
  syncFixes: {},              // opravy synchronizace dabingu (dubsync.js)
  gpuCheck: null,             // poslední ověření grafické karty (gpu.js)
  qbitStalls: {},             // { [hash]: { name, since?, stoppedAt?, tries } } – zaseknuté torrenty (stalled.js)
  watchSeries: {},            // { [seriesId]: { auto } } – hlídané seriály
  firstGrab: { known: {}, primed: {}, queue: [] }, // první stažení nově přidaných (firstgrab.js)
  wantLangs: {},              // { "sonarr:<seriesId>" | "radarr:<movieId>": ['pri'] } – hledat jen tyto jazyky (sloty pri/sec)
  wantCodec: {},              // { "sonarr:<seriesId>" | "radarr:<movieId>": 'hevc' | 'av1' } – hledat novější formát videa
  ignoredGuids: {},
  badDonors: {},              // { [id]: { itemKey, title, hashes, guids, reason, jobs } } – donory, se kterými sloučení neprošlo (merge.js)
  groupSnooze: {},            // { "sonarr:<id>:multi": ISO datum } – odmítnuté balíky více sérií
  searchCounter: { day: '', count: 0 },
  notifications: [],          // notifikační centrum ve webu (inbox.js)
  log: [],
});

const ENV_ONLY = { stagingDir: 'STAGING_DIR', stagingDirRadarr: 'STAGING_DIR_RADARR', stagingDirSonarr: 'STAGING_DIR_SONARR' };

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.bak = this.file + '.bak';
    fs.mkdirSync(dir, { recursive: true });
    this.state = EMPTY_STATE();
    this.timer = null;
    const { loaded, note } = this.load();
    if (loaded) {
      migrate(loaded);
      this.state = { ...EMPTY_STATE(), ...loaded };
      this.state.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) };
      // Nastavená proměnná prostředí (STAGING_DIR*) má přednost před uloženou hodnotou
      for (const [k, name] of Object.entries(ENV_ONLY)) if (env[name]) this.state.settings[k] = env[name];
    }
    if (note) this.log('error', note);
  }

  // state.json, a když je poškozený (zápis přerušený výpadkem proudu), předchozí verze ze state.json.bak
  load() {
    let note = null;
    if (fs.existsSync(this.file)) {
      try {
        return { loaded: JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (e) {
        const bad = this.file + '.broken-' + Date.now();
        fs.renameSync(this.file, bad);
        note = t('server.stateLoadFailed', { error: e.message, path: bad });
      }
    }
    if (fs.existsSync(this.bak)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.bak, 'utf8'));
        return { loaded, note: t('server.stateRestored', { note: note || t('server.stateMissing'), path: this.bak }) };
      } catch (e) {
        note = t('server.stateBackupBroken', { note: note || t('server.stateMissing'), error: e.message });
      }
    }
    return { loaded: null, note };
  }

  get s() { return this.state; }
  get settings() { return this.state.settings; }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write().catch((e) => console.error(t('store.writeFailed', { error: e.message })));
    }, 2000);
    this.timer.unref?.();
  }

  // Asynchronní zápis: event loop nesmí nikdy čekat na disk. Média leží na sdíleném HDD poolu,
  // kde extrakce zvuku (ffmpeg/whisper) umí I/O na dlouhé minuty zamrazit – zamrzlý writeFileSync
  // tehdy zablokoval celý server včetně /api/health a liveness probe kontejner zabila. Zápis běží
  // souběžně s obsluhou požadavků; změna stavu uprostřed zápisu se zapíše hned znovu (dirty).
  // Dočasný soubor s fsync (po výpadku proudu nezůstane prázdný soubor); předchozí verze zůstává
  // jako state.json.bak – kdyby se nová přesto nedala přečíst, načte se ta.
  async write() {
    if (this.writing) { this.dirty = true; return; }
    this.writing = true;
    try {
      do {
        this.dirty = false;
        const tmp = this.file + '.tmp';
        const fh = await fs.promises.open(tmp, 'w');
        try {
          await fh.writeFile(JSON.stringify(this.state));
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.promises.rename(this.file, this.bak).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        await fs.promises.rename(tmp, this.file);
        try {
          const dh = await fs.promises.open(this.dir, 'r');
          try { await dh.sync(); } finally { await dh.close(); }
        } catch { /* některé souborové systémy fsync složky neumí */ }
      } while (this.dirty);
    } finally {
      this.writing = false;
    }
  }

  // Synchronní zápis jen při ukončení procesu (SIGINT/SIGTERM) – tehdy nevadí na disk čekat.
  // Stejně jako write(): fsync a předchozí verze jako state.json.bak
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.bak);
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* některé souborové systémy fsync složky neumí */ }
  }

  // Úklid (každých 6 h a při startu): vyřízené návrhy a staré záznamy po 60 dnech pryč, vyřízené návrhy
  // zmenšit na vybraného kandidáta, zablokované releasy zapomenout po 90 dnech
  prune(now = Date.now()) {
    const s = this.state;
    const cutoff = now - 60 * 86400e3;
    const jobs = [s.downloads, s.merges, s.syncFixes].flatMap((c) => Object.values(c || {}));
    const activeJobs = new Set(jobs.filter((j) => j.active).map((j) => j.id));
    let n = 0;
    for (const [id, p] of Object.entries(s.proposals)) {
      if (p.status === 'pending') continue;
      if (Date.parse(p.updatedAt) < cutoff) { delete s.proposals[id]; n++; continue; }
      // Probíhající stahování může návrh znovu otevřít (selhání) – kandidáti musí zůstat
      if (p.status === 'grabbed' && activeJobs.has(p.downloadId)) continue;
      if (compactProposal(p)) n++;
    }
    for (const [id, d] of Object.entries(s.downloads)) if (!d.active && (d.finishedAt || d.grabbedAt) < cutoff) { delete s.downloads[id]; n++; }
    for (const coll of [s.merges, s.syncFixes]) {
      for (const [id, j] of Object.entries(coll)) if (!j.active && (j.backupRemoved || !j.backupDir) && (j.finishedAt || j.grabbedAt) < cutoff) { delete coll[id]; n++; }
    }
    const guidCutoff = now - 90 * 86400e3;
    for (const [guid, at] of Object.entries(s.ignoredGuids)) {
      const ts = typeof at === 'number' ? at : Date.parse(at);
      if (!Number.isFinite(ts)) s.ignoredGuids[guid] = now; // neznámé datum – počítat od teď
      else if (ts < guidCutoff) { delete s.ignoredGuids[guid]; n++; }
    }
    this.save();
    return n;
  }

  log(level, msg, extra) {
    const entry = { t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
    this.state.log.push(entry);
    if (this.state.log.length > 1000) this.state.log.splice(0, this.state.log.length - 1000);
    console.log(`[${entry.t}] ${level.toUpperCase()} ${msg}`);
    this.save();
    if (this.onLog) try { this.onLog(entry); } catch { /* notifikace nesmí shodit logování */ }
  }

  // Denní limit hledání
  canSearchToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.state.searchCounter.day !== day) this.state.searchCounter = { day, count: 0 };
    return this.state.searchCounter.count < this.settings.maxSearchesPerDay;
  }

  countSearch() {
    this.canSearchToday();
    this.state.searchCounter.count++;
  }
}

// Stav z verze, která uměla jen CZ + EN: jazyk 'cz' → 'cs', příznaky cz/en → pri/sec (primární/druhý jazyk),
// hledané jazyky ['cz'] → ['pri'], nastavení czIndexers / mergeCzDefault → localIndexers / mergePrimaryDefault.
function migrate(st) {
  const s = st.settings || {};
  if (!('czIndexers' in s) && !('mergeCzDefault' in s)) return;
  s.language ||= 'cs';
  s.secondLanguage ||= 'en';
  if ('czIndexers' in s) { s.localIndexers ??= s.czIndexers; delete s.czIndexers; }
  if ('mergeCzDefault' in s) { s.mergePrimaryDefault ??= s.mergeCzDefault; delete s.mergeCzDefault; }
  const code = (l) => (l === 'cz' ? 'cs' : l);
  const flags = (c) => {
    if (!c || typeof c !== 'object') return;
    if ('cz' in c) { c.pri = c.cz; delete c.cz; }
    if ('en' in c) { c.sec = c.en; delete c.en; }
    if ('subsCz' in c) { c.subsPri = c.subsCz; delete c.subsCz; }
    if (c.mergeLang) c.mergeLang = code(c.mergeLang);
    if (c.donor?.mergeLang) c.donor.mergeLang = code(c.donor.mergeLang); // verze k dabingu (cutmatch)
    for (const x of c.parts || []) flags(x);
  };
  for (const it of Object.values(st.items || {})) {
    if (it.origLang) it.origLang = code(it.origLang);
    for (const f of it.langCheck?.files || []) for (const tr of f.tracks || []) { tr.tag = code(tr.tag); tr.used = code(tr.used); }
  }
  for (const p of Object.values(st.proposals || {})) (p.candidates || []).forEach(flags);
  for (const coll of [st.downloads, st.merges, st.syncFixes]) {
    for (const j of Object.values(coll || {})) {
      flags(j.candidate);
      if (j.need) j.need = code(j.need);
    }
  }
  for (const [k, w] of Object.entries(st.wantLangs || {})) st.wantLangs[k] = w.map((l) => (l === 'cz' ? 'pri' : l === 'en' ? 'sec' : l));
}

// Vyřízený návrh: nechat jen vybraného kandidáta (u stažených ten stažený, jinak nejlepší) a bez odkazů
// a dat pro Radarr/Sonarr – v state.json by jinak zbytečně zabíraly místo (a odkazy obsahují API klíč)
function compactProposal(p) {
  if (p.compact) return false;
  const list = p.candidates || [];
  let idx = 0;
  if (p.status === 'grabbed') {
    idx = p.grabbedGuid ? list.findIndex((c) => c.guid === p.grabbedGuid && (!p.grabbedKind || p.grabbedKind === c.kind)) : p.grabbedIdx ?? 0;
    if (idx < 0 || idx >= list.length) idx = 0;
  }
  const keep = list[idx];
  p.candidates = keep ? [{ ...keep, downloadUrl: undefined, magnetUrl: undefined, infoUrl: undefined, arr: undefined, arrRejections: undefined }] : [];
  if (p.status === 'grabbed') p.grabbedIdx = 0;
  p.compact = true;
  return true;
}

const newId = () => crypto.randomBytes(5).toString('hex');

// Staging pro danou aplikaci ('radarr' | 'sonarr'): vlastní adresář, jinak společný stagingDir
function stagingFor(settings, app) {
  const own = app === 'sonarr' ? settings.stagingDirSonarr : app === 'radarr' ? settings.stagingDirRadarr : '';
  return own || settings.stagingDir;
}

// Je nastavený nějaký staging (společný nebo pro některou aplikaci)?
function anyStaging(settings) {
  return Boolean(settings.stagingDir || settings.stagingDirRadarr || settings.stagingDirSonarr);
}

module.exports = { Store, DEFAULT_SETTINGS, newId, migrate, validateSettings, compactProposal, stagingFor, anyStaging };

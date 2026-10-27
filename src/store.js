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
  mergeMaxDonorGB: 20,        // max. velikost "donoru" u filmu (u seriálů platí max. na epizodu)
  mergeSaveData: false,       // šetřit data: u přidání zvuku vyhrává nejmenší vhodný donor
  mergeMaxOffsetSec: 30,      // jak velký posun stop ještě hledat
  mergeDeleteDonor: true,     // po sloučení donor smazat z qBittorrentu
  keepBackupDays: 7,          // záloha původního souboru (hardlink) – kolik dní po dokončení ponechat (backups.js)
  maxBackupGB: 0,             // max. místo, které zálohy smějí zabírat (0 = bez limitu) – pak se mažou nejstarší
  backupDeleteVerified: false, // zálohu smazat hned po ověřeném sloučení / opravě; při odchylce zůstane a přijde notifikace
  // Složka pro donory a zálohy – musí ji vidět qBittorrent i Radarr/Sonarr pod stejnou cestou
  stagingDir: env.STAGING_DIR || '',
  qbitCategory: 'updaterr',
  // Hlídané položky (nastavují se u filmu/seriálu): kontrola častěji + automatický upgrade
  watchIntervalDays: 2,
  autoWatchNew: 'off',        // off | auto | ask – nově přidané filmy a seriály začnou hlídat samy (watch.js)
  // Ověřit jazyk poslechem (whisper.cpp) – odhalí chybně označené stopy, např. českou stopu jako "eng"
  verifySpeech: true,
  useGpu: true,               // Whisper na grafické kartě (Vulkan), když je připojená – jinak procesor (gpu.js)
  speechModel: 'base',        // base | small – small je přesnější (líp rozezná CZ × SK), na procesoru ~3× pomalejší
  // Synchronizace dabingu u souborů s oběma jazyky (dubsync.js)
  syncCheckEnabled: true,     // postupně měřit na pozadí
  syncCheckPauseSec: 60,      // pauza mezi dvěma soubory (min. 3× délka měření)
  syncWarnMs: 80,             // od jakého posunu upozornit a nabídnout opravu
};

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
  wantLangs: {},              // { "sonarr:<seriesId>" | "radarr:<movieId>": ['pri'] } – hledat jen tyto jazyky (sloty pri/sec)
  wantCodec: {},              // { "sonarr:<seriesId>" | "radarr:<movieId>": 'hevc' | 'av1' } – hledat novější formát videa
  ignoredGuids: {},
  groupSnooze: {},            // { "sonarr:<id>:multi": ISO datum } – odmítnuté balíky více sérií
  searchCounter: { day: '', count: 0 },
  notifications: [],          // notifikační centrum ve webu (inbox.js)
  log: [],
});

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.state = EMPTY_STATE();
    if (fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        migrate(loaded);
        this.state = { ...EMPTY_STATE(), ...loaded };
        this.state.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) };
      } catch (e) {
        const bad = this.file + '.broken-' + Date.now();
        fs.renameSync(this.file, bad);
        console.error(t('server.stateLoadFailed', { error: e.message, path: bad }));
      }
    }
    this.timer = null;
  }

  get s() { return this.state; }
  get settings() { return this.state.settings; }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write().catch((e) => console.error(t('store.writeFailed', { error: e.message })));
    }, 2000);
  }

  // Asynchronní zápis: event loop nesmí nikdy čekat na disk. Média leží na sdíleném HDD poolu,
  // kde extrakce zvuku (ffmpeg/whisper) umí I/O na dlouhé minuty zamrazit – zamrzlý writeFileSync
  // tehdy zablokoval celý server včetně /api/health a liveness probe kontejner zabila. Zápis běží
  // souběžně s obsluhou požadavků; změna stavu uprostřed zápisu se zapíše hned znovu (dirty).
  async write() {
    if (this.writing) { this.dirty = true; return; }
    this.writing = true;
    try {
      do {
        this.dirty = false;
        const tmp = this.file + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(this.state));
        await fs.promises.rename(tmp, this.file);
      } while (this.dirty);
    } finally {
      this.writing = false;
    }
  }

  // Synchronní zápis jen při ukončení procesu (SIGINT/SIGTERM) – tehdy nevadí na disk čekat
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
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

const newId = () => crypto.randomBytes(5).toString('hex');

module.exports = { Store, DEFAULT_SETTINGS, newId, migrate };

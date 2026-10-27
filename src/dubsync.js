// Synchronizace dabingu u souborů, které už mají CZ i EN stopu: kontrola na pozadí a oprava na pokyn.
//
// Kontrola: po jednom souboru s pauzou mezi soubory. Obě stopy se čtou jedním průchodem ffmpegu s nejnižší
// prioritou CPU i disku, posun se hledá jen v ±10 s a měření končí, jakmile je výsledek jistý (obvykle
// 5–6 míst po 80 s → z disku se přečte zhruba 7 % filmu). Během slučování stop nebo opravy se nekontroluje.
// Výsledek se ukládá k položce: item.syncCheck = { offsetMs, matched, at, …, files: { [fileId]: měření } }.
//
// Oprava (jen po kliknutí): CZ stopy se znovu změří na všech 8 místech, mkvmerge --sync je posune do nového
// souboru, ten se změří znovu (v místech, kde měření před opravou vyšlo spolehlivě), originál se zazálohuje (hardlink do stagingDir/backup jako u slučování)
// a nový soubor se naimportuje přes Radarr/Sonarr (ManualImport). Knihovna se do té doby nemění.
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lang');
const A = require('./audio');
const { newId, stagingFor } = require('./store');
const { refreshItem } = require('./library');
const { backupOriginal, assertReplaceable, isTransient } = require('./merge');
const { itemLabel } = require('./search');
const I18N = require('./i18n');

const CHECK_OPTS = { maxOffsetSec: 10, earlyStop: true, lowPriority: true };
const MEASURE_OPTS = { maxOffsetSec: 10 };                        // před opravou: všech 8 míst
// Výsledek opravy se ověřuje v místech, kde stopy spolehlivě korelovaly už před opravou (A.verifyOpts)
const verifyOpts = (m) => A.verifyOpts(m, MEASURE_OPTS);
const FIX_MIN_MS = 40;              // menší posun stopy při opravě nechat být
const VERIFY_MAX_MS = 40;           // po opravě musí stopy sedět aspoň takhle
const ERROR_RETRY_MS = 24 * 3600e3; // chyba čtení souboru → zkusit znovu za den
const SKIP_MS = 3600e3;             // Radarr/Sonarr hlásí jiné soubory než knihovna → počkat na synchronizaci
const MAX_TRANSIENT = 20;
const COMMENTARY = /comment|koment/i;

// Popisek stopy pro UI a log: název ze souboru, jinak jazyk + kodek ("CZ eac3 6 ch")
const trackLabel = (a) => (a ? a.title || [a.lang && L.label(a.lang), a.codec, a.channels && `${a.channels} ch`].filter(Boolean).join(' ') : '');

// Stopy k porovnání: originál = druhý jazyk (značka v souboru napřed, pak výchozí), dabing = všechny stopy
// v primárním jazyce (bez komentářů)
function pickTracks(audio) {
  const usable = audio.filter((a) => !COMMENTARY.test(a.title || ''));
  const pref = (lang) => usable.filter((a) => a.lang === lang)
    .sort((x, y) => Number(y.from === 'tag') - Number(x.from === 'tag') || Number(y.default) - Number(x.default));
  const ref = pref(L.secondary());
  const dubs = pref(L.primary());
  if (!ref.length || !dubs.length) return null;
  return { ref: ref[0], primary: dubs[0], dubs };
}

/**
 * Souhrn měření pro aktuální soubory položky. Posunutý = |posun| > warnMs.
 * U seriálu je offsetMs ten nejhorší z epizod.
 */
function syncSummary(item, warnMs = 80) {
  const ids = item?.current?.fileIds || [];
  const files = item?.syncCheck?.files || {};
  // Epizody bez CZ nebo EN (u českých seriálů) se nepočítají
  const entries = ids.map((id) => files[id] && { id, ...files[id] }).filter((e) => e && !e.skipped);
  if (!entries.length) return null;
  const measured = entries.filter((e) => e.ok);
  const bad = measured.filter((e) => Math.abs(e.offsetMs) > warnMs);
  const worst = measured.reduce((w, e) => (!w || Math.abs(e.offsetMs) > Math.abs(w.offsetMs) ? e : w), null);
  const failed = entries.find((e) => !e.ok);
  return {
    offsetMs: worst ? worst.offsetMs : null,
    matched: worst ? worst.matched : null,
    at: entries.map((e) => e.at).sort().pop(),
    ok: Boolean(worst),
    warn: bad.length > 0,
    reason: worst ? null : failed?.reason || failed?.error || null,
    fixedFrom: worst?.fixedFrom ?? null,
    checked: entries.length,
    total: ids.filter((id) => !files[id]?.skipped).length,
    measured: measured.length,
    bad: bad.length,
    badFiles: bad.map((e) => ({ fileId: e.id, name: e.name, offsetMs: e.offsetMs })),
  };
}

// Má smysl měřit? Oba jazyky ověřené ze stop (dílo s originálem v primárním jazyce bez druhého jazyka je taky
// úroveň 3, ale není s čím porovnat)
function syncable(item) {
  const a = L.audioFromMediaInfo(item?.current?.audio);
  return item?.current?.tier === 3 && item.current.audioSource === 'mediainfo' && a.pri && a.sec;
}

// Soubory položky, které ještě nejsou změřené (nebo se měření nepovedlo kvůli chybě a je čas to zkusit znovu)
function uncheckedIds(item, ids = item.current?.fileIds || [], now = Date.now()) {
  const files = item.syncCheck?.files || {};
  return ids.filter((id) => !files[id] || (files[id].error && now - Date.parse(files[id].at) > ERROR_RETRY_MS));
}

// Text pro log/oznámení: záporný posun = dabing je potřeba posunout dřív → zpožďuje se
const describeOffset = (ms) => I18N.t(ms < 0 ? 'sync.offset.late' : 'sync.offset.early', { ms: Math.abs(ms) });

class DubSync {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = false;
    this.current = null;      // { key, label, name } – co se právě měří
    this.manual = [];         // [{ key, since }] – „Změřit znovu“ (bez pauzy a i při vypnuté kontrole)
    this.nextAt = 0;
    this.skip = new Map();    // key → do kdy přeskočit
    this.queueWasFull = false;
    this.ctx.store.s.syncFixes ??= {};
    for (const j of this.jobs()) if (j.active && j.state === 'processing') j.state = 'queued';
    // Položky, které měřit nejde (české dílo jen s CZ, soubor bez EN), nemají viset jako „nešlo změřit“
    for (const it of Object.values(this.ctx.store.s.items)) {
      if (it.syncCheck && !syncable(it) && !Object.values(it.syncCheck.files || {}).some((f) => f.ok)) delete it.syncCheck;
    }
  }

  get st() { return this.ctx.store.settings; }
  client(app) { return app === 'radarr' ? this.ctx.radarr : this.ctx.sonarr; }
  jobs() { return Object.values(this.ctx.store.s.syncFixes); }
  active() { return this.jobs().filter((j) => j.active); }
  summary(item) { return syncSummary(item, this.st.syncWarnMs); }

  log(j, level, msg) {
    j.message = msg;
    this.ctx.store.log(level, `${j.label}: ${msg}`);
  }

  // Soubory položky podle Radarru/Sonarru (cesty, kvalita a jazyky pro import, u seriálu i epizody)
  async files(item, { episodes = false } = {}) {
    const pick = (f) => ({
      fileId: f.id, path: f.path, name: path.basename(f.path || ''), size: f.size || 0,
      audio: L.audioFromMediaInfo(f.mediaInfo?.audioLanguages),
      quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || '',
    });
    if (item.app === 'radarr') {
      const m = await this.ctx.radarr.get(`/movie/${item.arrId}`);
      return m.movieFile ? [{ ...pick(m.movieFile), episodeIds: null }] : [];
    }
    const sonarr = this.ctx.sonarr;
    const [files, eps] = await Promise.all([
      sonarr.get('/episodefile', { seriesId: item.arrId }),
      episodes ? sonarr.get('/episode', { seriesId: item.arrId }) : [],
    ]);
    const byFile = new Map();
    for (const e of eps) if (e.seasonNumber === item.season && e.episodeFileId) byFile.set(e.episodeFileId, [...(byFile.get(e.episodeFileId) || []), e.id]);
    return files.filter((f) => f.seasonNumber === item.season).map((f) => ({ ...pick(f), episodeIds: byFile.get(f.id) || [] }));
  }

  // --- Kontrola na pozadí ---------------------------------------------------------

  candidates() {
    const now = Date.now();
    const busy = this.ctx.busyKeys();
    return Object.values(this.ctx.store.s.items)
      .filter(syncable)
      .filter((it) => !busy.has(it.key) && !(this.skip.get(it.key) > now))
      .filter((it) => uncheckedIds(it, undefined, now).length)
      .sort((a, b) => (a.app === 'radarr' ? 0 : 1) - (b.app === 'radarr' ? 0 : 1) || String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  }

  enqueue(key) {
    this.manual = this.manual.filter((m) => m.key !== key);
    this.manual.push({ key, since: new Date().toISOString() });
    this.skip.delete(key);
  }

  queued(key) { return this.manual.some((m) => m.key === key) || this.current?.key === key; }

  status() {
    const items = Object.values(this.ctx.store.s.items);
    return {
      enabled: this.st.syncCheckEnabled,
      checking: this.current ? `${this.current.label}${this.current.name && this.current.files > 1 ? ` – ${this.current.name}` : ''}` : null,
      queue: this.candidates().length + this.manual.length,
      bad: items.filter((it) => this.summary(it)?.warn).length,
    };
  }

  // Disk se nechá na pokoji, když se zrovna slučuje nebo opravuje (ty čtou celé soubory)
  diskBusy() {
    return this.ctx.merger.active().some((j) => j.state === 'processing') || this.active().some((j) => j.state !== 'importing');
  }

  async checkNext() {
    const { store } = this.ctx;
    const now = Date.now();
    if (this.diskBusy()) return;
    let item = null;
    let since = null;
    while (this.manual.length && !item) {
      const m = this.manual[0];
      item = store.s.items[m.key] || null;
      since = m.since;
      if (!item) this.manual.shift();
    }
    if (!item) {
      if (!this.st.syncCheckEnabled || now < this.nextAt) return;
      item = this.candidates()[0];
      if (!item) {
        if (this.queueWasFull) {
          this.queueWasFull = false;
          const s = this.status();
          store.log('info', s.bad ? I18N.t('sync.allMeasuredBad', { count: s.bad }) : I18N.t('sync.allMeasuredOk'));
        }
        return;
      }
      this.queueWasFull = true;
    }

    const label = itemLabel(item);
    let files;
    try {
      files = await this.files(item);
    } catch (e) {
      this.nextAt = now + 5 * 60e3;
      if (!isTransient(e)) store.log('warn', I18N.t('sync.checkError', { label, error: e.message }));
      return;
    }
    const sc = (item.syncCheck ??= { files: {} });
    sc.files ??= {};
    const todo = since
      ? files.filter((f) => !sc.files[f.fileId] || String(sc.files[f.fileId].at) < since)
      : files.filter((f) => uncheckedIds(item, [f.fileId], now).length);
    const f = todo[0];
    if (!f) {
      if (since) this.manual.shift();
      else this.skip.set(item.key, now + SKIP_MS); // knihovna ještě neví o výměně souboru
      return;
    }

    this.current = { key: item.key, label, name: f.name, files: files.length };
    const t0 = Date.now();
    let entry;
    try {
      entry = f.audio.pri && f.audio.sec ? await this.measure(f.path) : { ok: false, skipped: true, reason: I18N.t('sync.noBothTracks', { p: L.label(L.primary()), s: L.label(L.secondary()) }) };
    } catch (e) {
      entry = { ok: false, error: e.message };
    } finally {
      this.current = null;
    }
    const prev = sc.files[f.fileId];
    sc.files[f.fileId] = { at: new Date().toISOString(), name: f.name, ...entry, ...(prev?.fixedFrom != null && entry.ok ? { fixedFrom: prev.fixedFrom } : {}) };
    this.updateSummary(item, files.map((x) => x.fileId));
    // Pauza úměrná délce měření: kontrola nesmí zabrat disk na víc než zlomek času
    this.nextAt = Date.now() + Math.max(this.st.syncCheckPauseSec * 1000, (Date.now() - t0) * 3);

    const what = files.length > 1 ? `${label} – ${f.name}` : label;
    if (entry.error) store.log('warn', I18N.t('sync.measureFailed', { what, error: entry.error }));
    else if (entry.ok && Math.abs(entry.offsetMs) > this.st.syncWarnMs) {
      store.log('warn', I18N.t('sync.offsetWarn', { what, p: L.label(L.primary()), offset: describeOffset(entry.offsetMs), matched: entry.matched }));
    }
    store.save();
  }

  // Změří hlavní stopu v primárním jazyce proti druhému jazyku ve stejném souboru
  async measure(file) {
    const p = await A.probe(file);
    const tr = pickTracks(p.audio);
    if (!tr) return { ok: false, reason: I18N.t('sync.tracksMissing', { p: L.label(L.primary()), s: L.label(L.secondary()), tracks: p.audio.map((a) => a.lang || '?').join(', ') || I18N.t('sync.noAudio') }) };
    const T = (a) => ({ file: p.file, duration: p.duration, startTime: p.startTime, stream: a.index });
    const r = await A.checkSync(T(tr.ref), T(tr.primary), CHECK_OPTS);
    return r.ok
      ? { ok: true, offsetMs: r.offsetMs, matched: r.matched, track: trackLabel(tr.primary), ref: trackLabel(tr.ref) }
      : { ok: false, reason: r.reason, track: trackLabel(tr.primary), ref: trackLabel(tr.ref) };
  }

  // Souhrnná pole (offsetMs, matched, at) přímo na item.syncCheck; měření starých souborů pryč
  // (`alsoKeep` = soubory, které Radarr/Sonarr už hlásí, ale knihovna Updaterru ještě ne)
  updateSummary(item, alsoKeep = []) {
    const sc = item.syncCheck;
    if (!sc?.files) return;
    const keep = new Set([...(item.current?.fileIds || []), ...alsoKeep].map(String));
    for (const id of Object.keys(sc.files)) if (!keep.has(String(id))) delete sc.files[id];
    const s = syncSummary(item, this.st.syncWarnMs);
    Object.assign(sc, { offsetMs: s?.offsetMs ?? null, matched: s?.matched ?? null, at: s?.at ?? null, ok: Boolean(s?.ok) });
  }

  // --- Oprava ---------------------------------------------------------------------

  start(itemKey) {
    const { store } = this.ctx;
    const item = store.s.items[itemKey];
    if (!item) throw Object.assign(new Error(I18N.t('err.itemNotFound')), { status: 404 });
    if (this.ctx.busyKeys().has(item.key)) throw new Error(I18N.t('err.itemBusyAny'));
    const sum = this.summary(item);
    if (!sum?.warn) throw new Error(I18N.t('err.syncNothingToFix'));
    const st = this.st;
    const staging = stagingFor(st, item.app);
    if (!staging) throw new Error(I18N.t('err.noStagingDir'));
    const id = newId();
    const j = {
      id, type: 'syncfix',
      itemKey: item.key, label: itemLabel(item), app: item.app, arrId: item.arrId, season: item.season,
      title: sum.total > 1 ? I18N.t('sync.titleEpisodes', { bad: sum.bad, total: sum.total }) : sum.badFiles[0]?.name || item.current.sceneName || '',
      fileIds: sum.badFiles.map((f) => f.fileId),
      expectedMs: sum.offsetMs,
      prev: { tier: item.current.tier, audio: item.current.audio, quality: item.current.quality },
      dir: path.join(staging, `sync-${id}`),
      grabbedAt: Date.now(), state: 'queued', active: true, progress: 0,
    };
    store.s.syncFixes[id] = j;
    this.log(j, 'info', I18N.t('sync.fixStart', { p: L.label(L.primary()), offset: describeOffset(sum.offsetMs) }));
    store.save();
    setImmediate(() => this.tick().catch((e) => store.log('error', e.message)));
    return j;
  }

  // Hromadná oprava: založí opravu pro všechny posunuté položky (nebo jen pro `keys`), které zrovna nic nedělají.
  // Úlohy pak běží po jedné (tick je zpracovává postupně).
  startAll(keys = null) {
    const { store } = this.ctx;
    const pool = keys ? keys.map((k) => store.s.items[k]).filter(Boolean) : Object.values(store.s.items);
    const busy = this.ctx.busyKeys();
    const started = [];
    const skipped = [];
    for (const it of pool) {
      if (!this.summary(it)?.warn) continue;
      if (busy.has(it.key)) { skipped.push({ key: it.key, reason: I18N.t('sync.all.busy') }); continue; }
      try {
        started.push(this.start(it.key));
      } catch (e) {
        skipped.push({ key: it.key, reason: e.message });
      }
    }
    if (started.length) store.log('info', I18N.t('sync.all.queued', { count: started.length, skipped: skipped.length ? I18N.t('sync.all.skipped', { n: skipped.length }) : '' }));
    return { started, skipped };
  }

  async cancel(id) {
    const j = this.ctx.store.s.syncFixes[id];
    if (!j || !j.active) throw new Error(I18N.t('err.notRunning'));
    if (j.state !== 'queued') throw new Error(I18N.t('err.syncFixBusy'));
    j.active = false;
    j.state = 'cancelled';
    j.finishedAt = Date.now();
    this.log(j, 'info', I18N.t('sync.cancelled'));
    this.ctx.store.save();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const j of this.active()) {
        try {
          if (j.state === 'queued') await this.process(j);
          if (j.state === 'importing') await this.checkImport(j);
          j.transientErrors = 0;
        } catch (e) {
          if (isTransient(e) && (j.transientErrors = (j.transientErrors || 0) + 1) < MAX_TRANSIENT) {
            if (j.state === 'processing') j.state = 'queued';
            j.message = I18N.t('common.waitingForService', { error: e.message });
          } else {
            await this.fail(j, e.message).catch((e2) => {
              Object.assign(j, { active: false, state: 'failed', finishedAt: Date.now() });
              this.ctx.store.log('error', I18N.t('common.cleanupFailed', { label: j.label, error: e.message, error2: e2.message }));
            });
          }
        }
        this.ctx.store.save();
      }
      await this.checkNext();
    } finally {
      this.running = false;
      this.ctx.store.save();
    }
  }

  async process(j) {
    const { store } = this.ctx;
    const st = this.st;
    j.state = 'processing';
    j.message = I18N.t('sync.measuring');
    store.save();
    const item = store.s.items[j.itemKey];
    if (!item) return this.fail(j, I18N.t('err.itemGone'));
    const targets = (await this.files(item, { episodes: true })).filter((f) => j.fileIds.includes(f.fileId));
    if (!targets.length) return this.fail(j, I18N.t('sync.fileChanged'));

    fs.mkdirSync(j.dir, { recursive: true });
    const need = targets.reduce((s, t) => s + (fs.existsSync(t.path) ? fs.statSync(t.path).size : 0), 0) * 1.05;
    const sfs = fs.statfsSync(j.dir);
    if (sfs.bavail * sfs.bsize < need) return this.fail(j, I18N.t('common.lowDisk', { gb: (need / 1024 ** 3).toFixed(1) }));

    const results = [];
    for (const t of targets) {
      try {
        results.push({ ok: true, ...(await this.fixOne(j, t)) });
      } catch (e) {
        results.push({ ok: false, target: t.name, reason: e.message });
      }
      j.results = results;
      j.progress = results.length / targets.length;
      j.message = I18N.t('common.processed', { done: results.length, total: targets.length });
      store.save();
    }
    const ok = results.filter((r) => r.ok && !r.skipped);

    // Nová měření (i ta, kde se nakonec nic neopravovalo) rovnou k položce
    const sc = (item.syncCheck ??= { files: {} });
    sc.files ??= {};
    for (const r of results.filter((x) => x.ok && x.skipped)) {
      sc.files[r.fileId] = { at: new Date().toISOString(), ok: true, offsetMs: r.offsetMs, matched: r.matched, name: r.target, track: r.track, ref: r.ref };
    }
    this.updateSummary(item);

    if (!ok.length) {
      if (results.every((r) => r.ok)) {
        this.cleanup(j);
        Object.assign(j, { active: false, state: 'done', finishedAt: Date.now(), progress: 1 });
        this.log(j, 'info', I18N.t('sync.nothingToFix'));
        return;
      }
      return this.fail(j, I18N.t('sync.fixFailedAll', { why: [...new Set(results.filter((r) => !r.ok).map((r) => r.reason))].join('; ') }));
    }

    // Záloha originálů jako u slučování; bez zálohy se neimportuje
    j.backupDir = path.join(path.dirname(j.dir), 'backup', j.id);
    for (const r of ok) {
      try {
        if (backupOriginal(r.path, j.backupDir) === 'kopie') r.backup = 'kopie';
      } catch (e) {
        j.backupUntil = Date.now() + 86400e3;
        return this.fail(j, I18N.t('common.backupAbort', { error: e.message }));
      }
    }
    const files = ok.map((r) => {
      const base = { path: r.out, quality: r.quality, languages: r.languages, releaseGroup: r.releaseGroup || '', indexerFlags: 0 };
      return j.app === 'radarr'
        ? { ...base, movieId: j.arrId }
        : { ...base, seriesId: j.arrId, episodeIds: r.episodeIds, releaseType: 'singleEpisode' };
    });
    // Stav "importing" ještě před odesláním: když odpověď nedorazí (timeout), import možná proběhl
    // a opravené soubory se nesmí smazat – rozhodne až checkImport
    j.state = 'importing';
    j.importAt = Date.now();
    j.importedFileIds = ok.map((r) => r.fileId);
    j.backupUntil = Date.now() + Math.max(st.keepBackupDays, 30) * 86400e3; // zkrátí se po úspěšném importu
    const failed = results.filter((r) => !r.ok);
    this.log(j, 'info', I18N.t('sync.fixed', {
      done: ok.length, total: targets.length,
      failed: failed.length ? I18N.t('sync.fixedFailed', { list: failed.map((r) => `${r.target} – ${r.reason}`).join('; ') }) : '',
    }));
    try {
      await this.client(j.app).command({ name: 'ManualImport', importMode: 'move', files });
    } catch (e) {
      if (e.status && e.status < 500) { j.state = 'processing'; throw e; } // jasné odmítnutí → nic se nestalo
      j.message = I18N.t('sync.importNoReply', { error: e.message });
    }
  }

  async fixOne(j, t) {
    const p = await A.probe(t.path);
    const tr = pickTracks(p.audio);
    if (!tr) throw new Error(I18N.t('sync.tracksMissingShort', { p: L.label(L.primary()), s: L.label(L.secondary()) }));
    const T = (pr, a) => ({ file: pr.file, duration: pr.duration, startTime: pr.startTime, stream: a.index });

    // Každou CZ stopu změřit zvlášť (CZ 5.1 a 2.0 můžou být posunuté různě)
    const shifts = [];
    let primary = null;
    for (const d of tr.dubs) {
      j.message = I18N.t('sync.measuringTrack', { track: trackLabel(d), name: t.name });
      const r = await A.checkSync(T(p, tr.ref), T(p, d), MEASURE_OPTS);
      if (d === tr.primary) primary = r;
      if (r.ok && Math.abs(r.offsetMs) > FIX_MIN_MS) shifts.push({ track: d, offsetMs: r.offsetMs, matched: r.matched, verify: verifyOpts(r) });
    }
    if (!primary.ok) throw new Error(I18N.t('sync.cannotMeasure', { reason: primary.reason }));
    const base = { target: t.name, fileId: t.fileId, offsetMs: primary.offsetMs, matched: primary.matched, track: trackLabel(tr.primary), ref: trackLabel(tr.ref) };
    if (!shifts.length) return { ...base, skipped: true };
    assertReplaceable(t.path);

    // Nový soubor: všechno beze změny, jen CZ stopy posunuté
    const outDir = path.join(j.dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, t.name.replace(/\.[^.]+$/, '') + '.mkv');
    const info = JSON.parse(await A.run('mkvmerge', ['-J', t.path]));
    const aTracks = (info.tracks || []).filter((x) => x.type === 'audio');
    if (aTracks.length !== p.audio.length) throw new Error(I18N.t('sync.trackCountMismatch'));
    // Legacy MIME typy fontů: s novými (font/ttf) si ffmpeg (Jellyfin, Plex) přílohy nepozná
    const args = ['-o', out, '--enable-legacy-font-mime-types'];
    for (const s of shifts) args.push('--sync', `${aTracks[s.track.audioIndex].id}:${s.offsetMs}`);
    args.push(t.path);
    j.message = I18N.t('sync.creating', { name: t.name });
    j.phase = 'fix';
    await A.run('mkvmerge', args, { timeoutMs: 60 * 60e3, okCodes: [0, 1] });

    // Kontrola výsledku: video, délka, všechny stopy a znovu synchronizace každé posunuté stopy
    j.message = I18N.t('sync.verifying', { name: t.name });
    const op = await A.probe(out);
    if (!op.video) throw new Error(I18N.t('merge.resultNoVideo'));
    if (op.duration < p.duration - 2) throw new Error(I18N.t('merge.resultShorter', { out: op.duration.toFixed(0), orig: p.duration.toFixed(0) }));
    if (op.audio.length !== p.audio.length || op.audio.some((a, i) => a.lang !== p.audio[i].lang)) throw new Error(I18N.t('sync.resultTracksMismatch'));
    const applied = [];
    for (const s of shifts) {
      const v = await A.checkSync(T(op, op.audio[tr.ref.audioIndex]), T(op, op.audio[s.track.audioIndex]), s.verify);
      if (!v.ok || Math.abs(v.offsetMs) > VERIFY_MAX_MS) {
        throw new Error(I18N.t('sync.verifyFailed', { track: trackLabel(s.track), reason: v.ok ? `${v.offsetMs} ms` : v.reason }));
      }
      applied.push({ track: trackLabel(s.track), offsetMs: s.offsetMs, verifyMs: v.offsetMs, verifyMatched: v.matched, primary: s.track === tr.primary });
    }
    const main = applied.find((a) => a.primary) || applied[0];
    const langs = t.languages?.length ? t.languages : await this.client(j.app).languageObjs([L.primary(), L.secondary()]);
    return {
      ...base, out, outSize: op.size, path: t.path, applied, verifyMs: main.verifyMs, verifyMatched: main.verifyMatched,
      quality: t.quality, languages: langs, releaseGroup: t.releaseGroup, episodeIds: t.episodeIds,
    };
  }

  async checkImport(j) {
    const { store, notify } = this.ctx;
    const now = Date.now();
    const item0 = store.s.items[j.itemKey];
    const cur = item0 ? await refreshItem(this.ctx, item0) : null;
    const replaced = cur && j.importedFileIds.every((id) => !cur.fileIds.includes(id));
    if (replaced && (cur.mediaInfoKnown || now - j.importAt > 15 * 60e3)) {
      const { mediaInfoKnown, ...current } = cur;
      const item = store.s.items[j.itemKey] || item0;
      item.current = current;
      const done = (j.results || []).filter((r) => r.ok && !r.skipped);
      const sc = (item.syncCheck ??= { files: {} });
      sc.files ??= {};
      if (j.app === 'radarr' && done[0]) {
        // Ověřené měření opraveného souboru rovnou k novému souboru
        const r = done[0];
        sc.files[current.fileIds[0]] = { at: new Date().toISOString(), ok: true, offsetMs: r.verifyMs, matched: r.verifyMatched, fixedFrom: r.offsetMs, name: path.basename(r.out), track: r.track, ref: r.ref };
      } else {
        this.enqueue(item.key); // nové soubory epizod přeměřit hned
      }
      this.updateSummary(item);
      j.result = { tier: cur.tier, audio: cur.audio, quality: cur.quality };
      this.cleanup(j);
      Object.assign(j, { active: false, state: 'done', finishedAt: now, progress: 1, backupUntil: now + this.st.keepBackupDays * 86400e3 });
      const offs = done.map((r) => `${r.offsetMs} → ${r.verifyMs} ms`);
      this.log(j, 'info', I18N.t('sync.done', { p: L.label(L.primary()), offsets: [...new Set(offs)].join(', '), count: this.st.keepBackupDays, dir: j.backupDir }));
      notify.download(j, 'done').catch(() => {});
      return;
    }
    if (now - j.importAt > 20 * 60e3) {
      Object.assign(j, { active: false, state: 'blocked', finishedAt: now, backupUntil: now + Math.max(this.st.keepBackupDays, 30) * 86400e3 });
      this.log(j, 'warn', I18N.t('sync.importFailed', { outDir: path.join(j.dir, 'out'), dir: j.backupDir }));
      notify.download(j, 'blocked').catch(() => {});
    }
  }

  cleanup(j) {
    fs.rmSync(j.dir, { recursive: true, force: true });
  }

  async fail(j, reason) {
    const { notify } = this.ctx;
    if (j.state === 'importing') {
      // Radarr/Sonarr možná zrovna přesouvá opravený soubor – nic nemazat, jen přestat hlídat
      Object.assign(j, { active: false, state: 'blocked', finishedAt: Date.now(), backupUntil: Date.now() + Math.max(this.st.keepBackupDays, 30) * 86400e3 });
      this.log(j, 'warn', I18N.t('common.importUnknown', { reason, app: j.app === 'radarr' ? 'Radarr' : 'Sonarr', dir: j.backupDir }));
      notify.download(j, 'blocked').catch(() => {});
      return;
    }
    this.cleanup(j);
    if (j.backupDir && !j.backupUntil) j.backupUntil = Date.now() + 86400e3;
    Object.assign(j, { active: false, state: 'failed', finishedAt: Date.now() });
    this.log(j, 'warn', I18N.t('sync.failed', { reason }));
    notify.download(j, 'failed').catch(() => {});
  }
}

module.exports = { DubSync, pickTracks, syncSummary, syncable, uncheckedIds, describeOffset };

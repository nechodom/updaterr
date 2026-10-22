// Slučování zvukových stop: místo výměny celého souboru stáhne "donor" release s chybějícím jazykem,
// ověří podle skutečných zvukových stop, že ten jazyk obsahuje, změří synchronizaci proti stávajícímu
// souboru a stopu přidá (mkvmerge). Výsledek znovu ověří a naimportuje přes Radarr/Sonarr.
// Video i ostatní stopy zůstávají ze stávajícího souboru (např. 4K EN + CZ zvuk z 1080p releasu).
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lang');
const S = require('./speech');
const A = require('./audio');
const { newId, stagingFor, anyStaging } = require('./store');
const { refreshItem } = require('./library');
const I18N = require('./i18n');

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|mov|wmv)$/i;
const LANGS = require('./languages');
// Název přidané stopy v jejím vlastním jazyce ("Čeština", "Deutsch")
const trackName = (code) => {
  let n = code;
  try { n = new Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch { /* neznámý kód */ }
  return n.charAt(0).toLocaleUpperCase(code) + n.slice(1);
};
const FRESH_MS = 20 * 60e3;
const MAX_TRANSIENT = 20;                 // přechodných chyb po sobě (à 30 s), než to vzdáme
// Předběžná kontrola fps ze staženého začátku donoru (pokusy při 48 MB, 192 MB, 768 MB souvislého začátku).
// Odmítá jen jasný rozdíl: hlavička MKV bývá zaokrouhlená na celé ms (23,810 vs 23,976 fps = 0,7 %),
// menší rozdíly rozhodne až úplná kontrola v mergeOne. PAL 25 vs 23,976 fps je 4,3 %.
const EARLY_FPS_BYTES = 48 * 1024 ** 2;
const EARLY_FPS_TRIES = 3;
const EARLY_FPS_TOLERANCE = 0.02;

// Výpadek / restart Radarru, Sonarru nebo qBittorrentu – zkusit znovu při dalším ticku
function isTransient(e) {
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' ||
    /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|HTTP 5\d\d|HTTP 429/i.test(String(e?.message) + ' ' + String(e?.cause?.code || ''));
}

// Který jazyk chybí (kód ISO 639-1): jen druhý → doplnit primární, jen primární (u děl s jiným originálem) → doplnit druhý
function neededLang(item, want = null) {
  const t = item.current?.tier;
  const slot = t === 1 ? 'pri' : t === 2 && item.origLang !== L.primary() ? 'sec' : null;
  return slot && (!want || want.includes(slot)) ? L.slotCode(slot) : null;
}

// Záloha původního souboru před importem: hardlink (dokud je originál v knihovně, nezabírá místo navíc), jinak kopie.
// Úklid záloh podle retence: backups.js.
// Vrací 'hardlink' | 'kopie'; když nejde ani jedno, vyhodí chybu (a pak se nesmí importovat).
function backupOriginal(file, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(file));
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).ino === fs.statSync(file).ino) return 'hardlink';
    fs.linkSync(file, dest);
    return 'hardlink';
  } catch (e) {
    try {
      const size = fs.statSync(file).size;
      const free = fs.statfsSync(backupDir);
      if (free.bavail * free.bsize < size * 1.05) throw new Error(I18N.t('merge.backupNoSpace'));
      fs.copyFileSync(file, dest);
      return 'kopie';
    } catch (e2) {
      throw new Error(I18N.t('merge.backupFailed', { error: e.code || e.message, error2: e2.message }));
    }
  }
}

// Kolik bajtů souboru je souvisle stažených od jeho začátku (states z torrents/pieceStates, 2 = stažený kus)
function prefixBytes(states, [first, last], pieceSize) {
  let n = 0;
  for (let i = first; i <= last && states?.[i] === 2; i++) n++;
  return n * pieceSize;
}

// Jasně jiná snímková frekvence? Jen když se od cíle liší všechny známé hodnoty donoru (hlavička i změřená)
function fpsClearlyDiffers(targetFps, donorFps) {
  const known = donorFps.filter((f) => f > 0);
  return targetFps > 0 && known.length > 0 && known.every((f) => Math.abs(f / targetFps - 1) > EARLY_FPS_TOLERANCE);
}

/**
 * Jazyky zvukových stop stávajícího souboru podle poslechu (item.langCheck) – pole po audio stopách, null = nevíme.
 * Ověřený soubor podle indexu streamu. Neověřená epizoda jen tehdy, když má stejné stopy (počet a značky) jako
 * všechny ověřené epizody a poslech u nich dopadl na každé pozici stejně.
 */
function speechLangs(langCheck, fileId, audio) {
  const files = langCheck && !langCheck.error ? langCheck.files || [] : [];
  const own = files.find((f) => f.id === fileId);
  if (own) return audio.map((a) => own.tracks.find((t) => t.index === a.index)?.used || null);
  const same = (f) => f.tracks.length === audio.length && f.tracks.every((t, i) => (t.tag || null) === (audio[i].lang || null));
  if (!files.length || !files.every(same)) return audio.map(() => null);
  return audio.map((a, i) => {
    const used = new Set(files.map((f) => f.tracks[i].used || null));
    return used.size === 1 ? [...used][0] : null;
  });
}

const isDonorVideo = (f) => VIDEO_EXT.test(f.name) && !/\bsample\b/i.test(f.name);

function parseEpisode(name) {
  const base = path.basename(name);
  let m = base.match(/S(\d{1,2})[ ._-]?E(\d{1,3})/i);
  if (m) return { s: Number(m[1]), e: Number(m[2]) };
  m = base.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (m) return { s: Number(m[1]), e: Number(m[2]) };
  m = base.match(/\b(?:E|Ep|Episode|Díl|Dil)[ ._-]?(\d{1,3})\b/i);
  if (m) return { s: null, e: Number(m[1]) };
  return null;
}

/**
 * Kandidáti na sloučení z výsledků hledání. Volá se z evaluateReleases (search.js);
 * pomocné funkce dostává parametrem, ať nevzniká kruhová závislost.
 */
function mergeCandidates(item, releases, ctx, h) {
  const st = ctx.store.settings;
  if (!st.mergeEnabled || !ctx.qbit?.enabled || !anyStaging(st)) return [];
  if (!L.audioVerified(item.current)) return []; // stávající jazyk musí být ověřený ze stop nebo poslechem
  const need = neededLang(item, require('./watch').wantOf(ctx.store, item));
  if (!need) return [];
  const maxGB = item.app === 'radarr' ? st.mergeMaxDonorGB : st.maxEpisodeSizeGB * Math.max(1, item.current.files || 1);
  const out = [];
  for (const r of releases) {
    if (r.protocol === 'usenet') continue;
    if (item.app === 'sonarr' && (!r.fullSeason || (r.seasonNumber != null && r.seasonNumber !== item.season))) continue;
    if (ctx.store.s.ignoredGuids[r.guid]) continue;
    if (h.rejectionsOf(r).some((x) => h.HARD_REJECT.test(x))) continue;
    if (L.JUNK_RE.test(r.title) || /cam|telesync|telecine|workprint|dvdscr/i.test(r.quality?.quality?.source || '')) continue;
    const seeders = Number(r.seeders) || 0;
    if (seeders < st.minSeeders) continue;
    if ((r.size || 0) / 1024 ** 3 > maxGB) continue;
    const lang = L.evaluateRelease(r.title, { origLang: item.origLang, arrLangs: r.languages, localIndexer: h.isLocalIndexer(r.indexer, st) });
    if (!lang[need === L.primary() ? 'pri' : 'sec'] || lang.confidence === 'guess') continue;
    const dual = lang.pri && lang.sec;
    out.push({
      guid: r.guid,
      indexerId: r.indexerId,
      indexer: String(r.indexer || '').replace(/\s*\(Prowlarr\)\s*$/i, ''),
      title: r.title,
      size: r.size || 0,
      seeders,
      leechers: Number(r.leechers) || 0,
      protocol: r.protocol,
      quality: item.current.quality,            // video zůstává stávající
      donorQuality: r.quality?.quality?.name || '?',
      res: item.current.res,
      qrank: item.current.qrank,
      tier: 3,
      pri: true,
      sec: true,
      confidence: lang.confidence,
      notes: [I18N.t('merge.note.adds', { lang: L.label(need), quality: item.current.quality }),
        ...(dual ? [I18N.t('merge.note.dualDonor', { p: L.label(L.primary()), s: L.label(L.secondary()) })] : [])],
      kind: 'merge',
      mergeLang: need,
      dualDonor: dual,
      warnings: seeders < st.minSeeders * 3 ? [I18N.t('search.warn.lowSeeds')] : [],
      ageDays: Math.round(r.ageHours != null ? r.ageHours / 24 : r.age || 0),
      infoUrl: r.infoUrl || r.commentUrl || null,
      infoHash: r.infoHash || null,
      downloadUrl: r.downloadUrl || null,
      magnetUrl: r.magnetUrl || null,
    });
  }
  const conf = { sure: 2, likely: 1, guess: 0 };
  const seeds = (c) => Math.floor(Math.log2(c.seeders + 1));
  // Šetřit data: obraz se z donoru nebere, takže rozhoduje velikost (po 250 MB, drobné rozdíly nechá na dual/seedech)
  const size = (c) => Math.round(c.size / 2.5e8);
  out.sort(st.mergeSaveData
    ? (a, b) => conf[b.confidence] - conf[a.confidence] || size(a) - size(b) ||
      Number(b.dualDonor) - Number(a.dualDonor) || seeds(b) - seeds(a) || a.size - b.size
    : (a, b) => Number(b.dualDonor) - Number(a.dualDonor) || conf[b.confidence] - conf[a.confidence] ||
      seeds(b) - seeds(a) || a.size - b.size);
  const top = out.slice(0, 2);
  // Nejmenší vhodný donor nabídnout vždy, i když v pořadí vypadl (když je znatelně menší než ostatní nabízené)
  const smallest = out.reduce((a, b) => (b.size < a.size ? b : a), out[0]);
  if (out.length > 1 && top.every((c) => c === smallest || smallest.size < c.size * 0.9)) {
    smallest.smallest = true;
    if (!top.includes(smallest)) top.push(smallest);
  }
  return top;
}

class Merger {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = false;
    // Restart uprostřed zpracování → začít zpracování znovu
    for (const j of this.jobs()) if (j.active && j.state === 'processing') j.state = 'ready';
  }

  get st() { return this.ctx.store.settings; }
  get qbit() { return this.ctx.qbit; }
  client(app) { return app === 'radarr' ? this.ctx.radarr : this.ctx.sonarr; }
  jobs() { return Object.values(this.ctx.store.s.merges); }
  active() { return this.jobs().filter((j) => j.active); }

  log(j, level, msg) {
    j.message = msg;
    this.ctx.store.log(level, `${j.label}: ${msg}`);
  }

  async start(proposalId, idx, { auto = false, retryOf = null } = {}) {
    const { store, notify } = this.ctx;
    const st = this.st;
    if (!this.qbit.enabled) throw new Error(I18N.t('err.mergeNeedsQbit'));
    const p = store.s.proposals[proposalId];
    if (!p) throw new Error(I18N.t('err.proposalNotFound'));
    if (p.status !== 'pending') throw new Error(I18N.t('err.proposalDone', { status: p.status }));
    const item = store.s.items[p.itemKey];
    if (!item) throw new Error(I18N.t('err.itemGone'));
    const busy = new Set([...this.ctx.downloads.active().flatMap((d) => d.itemKeys || [d.itemKey]), ...this.active().map((j) => j.itemKey)]);
    if (busy.has(item.key)) throw new Error(I18N.t('err.itemBusy'));
    let cand = p.candidates?.[idx];
    if (!cand || cand.kind !== 'merge') throw new Error(I18N.t('err.candidateNotFound'));

    if (Date.now() - (p.searchedAt || 0) > FRESH_MS || !cand.downloadUrl && !cand.magnetUrl) {
      store.log('info', I18N.t('download.verifyingAlive', { label: p.label, title: cand.title }));
      store.countSearch();
      const params = item.app === 'radarr' ? { movieId: item.arrId } : { seriesId: item.arrId, seasonNumber: item.season };
      const releases = await this.client(item.app).searchReleases(params);
      const r = releases.find((x) => x.guid === cand.guid) || releases.find((x) => x.indexerId === cand.indexerId && x.title === cand.title);
      if (!r) throw new Error(I18N.t('merge.releaseGone'));
      cand = { ...cand, seeders: r.seeders, leechers: r.leechers, downloadUrl: r.downloadUrl, magnetUrl: r.magnetUrl };
      p.candidates[idx] = cand;
      p.searchedAt = Date.now();
      if ((Number(r.seeders) || 0) < st.minSeeders) throw new Error(I18N.t('download.torrentDied', { seeders: r.seeders || 0 }));
    }

    // Epizody zjistit předem – kdyby to selhalo až po přidání torrentu, zůstal by v qBittorrentu sirotek
    const episodeNumbers = item.app === 'sonarr'
      ? (await this.targets({ itemKey: item.key, app: item.app, arrId: item.arrId, season: item.season, need: cand.mergeLang })).flatMap((t) => t.episodeNumbers)
      : null;
    const id = newId();
    const dir = path.join(stagingFor(st, item.app), id);
    fs.mkdirSync(path.join(dir, 'donor'), { recursive: true });
    try {
      await this.qbit.ensureCategory(st.qbitCategory, stagingFor(st, item.app));
      await this.qbit.add({
        downloadUrl: cand.downloadUrl, magnetUrl: cand.magnetUrl,
        savepath: path.join(dir, 'donor'), category: st.qbitCategory, tags: `updaterr,ujob-${id}`,
      });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const j = {
      id, type: 'merge',
      itemKey: item.key, proposalId, label: p.label, app: item.app, arrId: item.arrId, season: item.season,
      title: cand.title, guid: cand.guid, candidate: cand, need: cand.mergeLang, dir,
      prev: { tier: item.current.tier, audio: item.current.audio, quality: item.current.quality },
      prevFileIds: item.current.fileIds,
      episodeNumbers,
      grabbedAt: Date.now(), lastProgressAt: Date.now(),
      state: 'downloading', active: true, auto,
      attempt: retryOf ? (retryOf.attempt || 1) + 1 : 1, retryOf: retryOf?.id || null,
      progress: 0,
    };
    store.s.merges[id] = j;
    p.status = 'grabbed';
    p.grabbedIdx = idx;
    p.downloadId = id;
    p.updatedAt = new Date().toISOString();
    this.log(j, 'info', I18N.t('merge.grabbing', { title: cand.title, indexer: cand.indexer, seeders: cand.seeders, auto: auto ? I18N.t('download.tag.auto') : '' }));
    store.save();
    if (auto || retryOf) notify.download(j, 'grabbed').catch(() => {});
    return j;
  }

  async cancel(id) {
    const j = this.ctx.store.s.merges[id];
    if (!j || !j.active) throw new Error(I18N.t('err.notRunning'));
    // Během slučování a importu se pracuje se soubory knihovny – rušit až po dokončení
    if (j.state === 'processing' || j.state === 'importing' || this.running && j.state === 'ready') {
      throw new Error(I18N.t('err.mergeBusy'));
    }
    await this.cleanup(j, { deleteTorrent: true });
    j.active = false;
    j.state = 'cancelled';
    j.finishedAt = Date.now();
    this.reopen(j, { note: I18N.t('merge.note.cancelled') });
    this.log(j, 'info', I18N.t('merge.cancelled'));
    this.ctx.store.save();
  }

  reopen(j, opts) {
    require('./search').reopenProposal(this.ctx, j, opts);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const j of this.active()) {
        try {
          if (j.state === 'downloading') await this.checkDownload(j);
          if (j.state === 'ready') await this.process(j);
          if (j.state === 'importing') await this.checkImport(j);
          j.transientErrors = 0;
        } catch (e) {
          if (isTransient(e) && (j.transientErrors = (j.transientErrors || 0) + 1) < MAX_TRANSIENT) {
            if (j.state === 'processing') j.state = 'ready';
            j.message = I18N.t('common.waitingForService', { error: e.message });
          } else {
            await this.fail(j, e.message).catch((e2) => {
              j.active = false;
              j.state = 'failed';
              j.finishedAt = Date.now();
              this.ctx.store.log('error', I18N.t('common.cleanupFailed', { label: j.label, error: e.message, error2: e2.message }));
            });
          }
        }
        this.ctx.store.save();
      }
    } finally {
      this.running = false;
      this.ctx.store.save();
    }
  }

  // Soubory stávající položky, kterým chybí potřebný jazyk
  async targets(j) {
    const need = j.need;
    // Ověřeno poslechem → značkám v MediaInfo nevěřit (můžou lhát); jestli stopa chybí, rozhodne mergeOne podle poslechu
    const heard = this.ctx.store.s.items[j.itemKey]?.current?.audioSource === 'poslech';
    const has = (f) => !heard && L.audioFromMediaInfo(f.mediaInfo?.audioLanguages).langs.includes(need);
    if (j.app === 'radarr') {
      const m = await this.ctx.radarr.get(`/movie/${j.arrId}`);
      const f = m.movieFile;
      if (!f || has(f)) return [];
      return [{ fileId: f.id, path: f.path, quality: f.quality, releaseGroup: f.releaseGroup, episodeIds: null, episodeNumbers: [] }];
    }
    const [eps, files] = await Promise.all([
      this.ctx.sonarr.get('/episode', { seriesId: j.arrId }),
      this.ctx.sonarr.get('/episodefile', { seriesId: j.arrId }),
    ]);
    const byFile = new Map();
    for (const e of eps) {
      if (e.seasonNumber !== j.season || !e.hasFile || !e.episodeFileId) continue;
      if (!byFile.has(e.episodeFileId)) byFile.set(e.episodeFileId, []);
      byFile.get(e.episodeFileId).push(e);
    }
    return files
      .filter((f) => byFile.has(f.id) && !has(f))
      .map((f) => ({
        fileId: f.id, path: f.path, quality: f.quality, releaseGroup: f.releaseGroup,
        episodeIds: byFile.get(f.id).map((e) => e.id), episodeNumbers: byFile.get(f.id).map((e) => e.episodeNumber),
      }));
  }

  // Z torrentu stahujeme jen to, co potřebujeme (film = největší video, seriál = chybějící epizody)
  wantedFiles(j, files) {
    const videos = files.filter(isDonorVideo);
    if (!videos.length) return new Set();
    if (j.app === 'radarr') return new Set([videos.reduce((a, b) => (b.size > a.size ? b : a)).index]);
    const want = new Set(j.episodeNumbers || []);
    const matched = videos.filter((f) => {
      const ep = parseEpisode(f.name);
      return ep && (ep.s == null || ep.s === j.season) && want.has(ep.e);
    });
    return new Set((matched.length ? matched : videos).map((f) => f.index));
  }

  async checkDownload(j) {
    const st = this.st;
    const now = Date.now();
    const t = await this.qbit.byTag(`ujob-${j.id}`);
    if (!t) {
      if (now - j.grabbedAt > 15 * 60e3) return this.fail(j, I18N.t('merge.neverAppeared'), { retry: true });
      return;
    }
    j.hash = t.hash;
    j.savePath = t.save_path;
    if (!j.filesSelected) {
      const files = await this.qbit.files(t.hash);
      if (files?.length) {
        const wanted = this.wantedFiles(j, files);
        if (!wanted.size) return this.fail(j, I18N.t('merge.noVideo'), { retry: true });
        await this.qbit.setFilePriority(t.hash, files.filter((f) => !wanted.has(f.index)).map((f) => f.index), 0);
        j.filesSelected = true;
        // Začátek videa napřed → snímková frekvence se ověří po pár desítkách MB, ne až po celém torrentu
        try {
          await this.qbit.prioritizeStart(t, true);
          j.fpsCheck = { state: 'pending', tries: 0 };
        } catch (e) {
          this.ctx.store.log('warn', I18N.t('merge.seqFailed', { label: j.label, error: e.message }));
        }
        return; // průběh přečteme příště, až qBittorrent přepočítá vybrané soubory
      }
    }
    const left = Number(t.amount_left) || 0;
    j.size = t.size;
    j.progress = Number(t.progress) || 0;
    j.timeleft = t.eta > 0 && t.eta < 8640000 ? new Date(t.eta * 1000).toISOString().slice(11, 19) : null;
    j.message = I18N.t('merge.progress', { seeds: t.num_seeds, speed: (t.dlspeed / 1024 ** 2).toFixed(1) });
    if (j.lastLeft == null || left < j.lastLeft - 5e6) {
      j.lastProgressAt = now;
      j.lastLeft = left;
    }
    if (/error|missingFiles/i.test(t.state)) return this.fail(j, I18N.t('merge.qbitError', { state: t.state }), { retry: true });
    if (j.filesSelected && (left === 0 || j.progress >= 1)) {
      j.state = 'ready';
      this.log(j, 'info', I18N.t('merge.donorDone'));
      return;
    }
    if (j.fpsCheck?.state === 'pending') {
      const reason = await this.earlyFpsCheck(j, t).catch(async (e) => {
        if (isTransient(e)) throw e;
        j.fpsCheck.state = 'skipped'; // předběžná kontrola nesmí shodit stahování – rozhodne úplná kontrola
        this.ctx.store.log('warn', I18N.t('merge.earlyFpsFailed', { label: j.label, error: e.message }));
        await this.qbit.prioritizeStart(t, false).catch(() => {});
        return null;
      });
      if (reason) return this.fail(j, reason, { retry: true });
    }
    if (now - j.lastProgressAt > st.stallHours * 3600e3) {
      return this.fail(j, I18N.t('download.noProgress', { hours: st.stallHours }), { retry: true });
    }
  }

  /**
   * Předběžná kontrola snímkové frekvence ze staženého začátku donoru (stahuje se sekvenčně).
   * Vrací důvod k odmítnutí při zjevně jiných fps (PAL 25 vs 23,976) – pak se torrent smaže a zkusí se
   * další kandidát jako při selhání v mergeOne; jinak null.
   */
  async earlyFpsCheck(j, t) {
    const c = j.fpsCheck;
    const done = async (state, msg) => {
      c.state = state;
      if (msg) this.log(j, 'info', msg);
      await this.qbit.prioritizeStart(t, false).catch(() => {}); // dál už normálně (rychlejší, šetrnější k roji)
      return null;
    };
    const files = await this.qbit.files(t.hash);
    // Sekvenčně se nejdřív stáhne soubor, který v torrentu začíná nejdřív
    const f = (files || []).filter((x) => x.priority > 0 && isDonorVideo(x) && x.piece_range)
      .sort((a, b) => a.piece_range[0] - b.piece_range[0])[0];
    if (!f || f.size < EARLY_FPS_BYTES * 4) return done('skipped'); // malý soubor – za chvíli je celý
    const [states, props] = await Promise.all([this.qbit.pieceStates(t.hash), this.qbit.properties(t.hash)]);
    if (prefixBytes(states, f.piece_range, Number(props?.piece_size) || 0) < EARLY_FPS_BYTES * 4 ** c.tries) return null;
    c.tries++;
    // Nedokončené soubory můžou být v dočasné složce qBittorrentu a s příponou .!qB
    const file = [t.download_path, t.save_path].filter(Boolean).flatMap((d) => [path.join(d, f.name), path.join(d, `${f.name}.!qB`)])
      .find((p) => fs.existsSync(p));
    if (!file) return done('skipped', I18N.t('merge.fps.notOnDisk'));
    const fps = await this.targetFps(j);
    if (!fps) return done('skipped');
    let header = 0, measured = 0;
    try {
      const dp = await A.probe(file);
      header = dp.video?.fps || 0;
      measured = await A.measureFps({ file, startTime: dp.startTime }).catch(() => 0); // prvních 60 s
    } catch { /* hlavička ještě nejde přečíst (např. MP4 s indexem na konci) */ }
    if (!header && !measured) {
      return c.tries < EARLY_FPS_TRIES ? null : done('skipped', I18N.t('merge.fps.unknown'));
    }
    if (fpsClearlyDiffers(fps, [header, measured])) {
      return I18N.t('merge.fps.differsEarly', { target: fps.toFixed(3), donor: (measured || header).toFixed(3) });
    }
    return done('ok', I18N.t('merge.fps.ok', { fps: (measured || header).toFixed(3) }));
  }

  // Snímková frekvence stávajícího souboru (u seriálu první epizody, které chybí jazyk); 0 = neznámá
  async targetFps(j) {
    if (j.fpsCheck.target) return j.fpsCheck.target;
    const [t] = await this.targets(j);
    if (!t || !fs.existsSync(t.path)) return 0;
    const tp = await A.probe(t.path);
    return (j.fpsCheck.target = (await A.measureFps(tp).catch(() => 0)) || tp.video?.fps || 0);
  }

  async process(j) {
    const st = this.st;
    j.state = 'processing';
    this.ctx.store.save();
    const targets = await this.targets(j);
    if (!targets.length) {
      await this.cleanup(j, { deleteTorrent: st.mergeDeleteDonor });
      j.active = false;
      j.state = 'done';
      j.finishedAt = Date.now();
      this.log(j, 'info', I18N.t('merge.alreadyHas', { lang: L.label(j.need) }));
      return;
    }
    const files = await this.qbit.files(j.hash);
    const donors = files
      .filter((f) => f.priority > 0 && isDonorVideo(f))
      .map((f) => ({ path: path.join(j.savePath, f.name), size: f.size, ep: parseEpisode(f.name) }));
    if (!donors.length) return this.fail(j, I18N.t('merge.donorNoVideo'), { retry: true });

    // Místo na disku: výsledek je zhruba velikost stávajícího souboru + zvuková stopa
    const need = targets.reduce((s, t) => s + (fs.existsSync(t.path) ? fs.statSync(t.path).size : 0), 0) * 1.1;
    const sfs = fs.statfsSync(stagingFor(st, j.app));
    if (sfs.bavail * sfs.bsize < need) return this.fail(j, I18N.t('common.lowDisk', { gb: (need / 1024 ** 3).toFixed(1) }));

    const results = [];
    for (const t of targets) {
      const donor = j.app === 'radarr'
        ? donors.reduce((a, b) => (b.size > a.size ? b : a))
        : donors.find((d) => d.ep && (d.ep.s == null || d.ep.s === j.season) && t.episodeNumbers.includes(d.ep.e));
      const name = path.basename(t.path);
      if (!donor) { results.push({ ok: false, target: name, reason: I18N.t('merge.episodeMissing') }); continue; }
      try {
        results.push({ ok: true, ...(await this.mergeOne(j, t, donor.path)) });
      } catch (e) {
        results.push({ ok: false, target: name, reason: e.message });
      }
      j.results = results;
      j.message = I18N.t('common.processed', { done: results.length, total: targets.length });
      this.ctx.store.save();
    }
    j.results = results;
    const ok = results.filter((r) => r.ok && !r.skipped);
    if (!ok.length && results.every((r) => r.skipped)) {
      // Stopa v souboru už je (jen ji Radarr/Sonarr neuvádí) – není co dělat, donor nezahazovat jako špatný
      await this.cleanup(j, { deleteTorrent: st.mergeDeleteDonor });
      j.active = false;
      j.state = 'done';
      j.finishedAt = Date.now();
      j.result = { tier: 3, audio: I18N.t('merge.result.trackPresent'), quality: j.prev.quality };
      this.log(j, 'info', I18N.t('merge.alreadyContains', { lang: L.label(j.need) }));
      return;
    }
    if (!ok.length) {
      const why = [...new Set(results.map((r) => r.reason))].join('; ');
      return this.fail(j, I18N.t('merge.nothingMerged', { why }), { retry: true });
    }

    // Záloha původních souborů (hardlink = nezabírá místo navíc; jinak kopie). Bez zálohy se neimportuje.
    j.backupDir = path.join(stagingFor(st, j.app), 'backup', j.id);
    for (const r of ok) {
      try {
        if (backupOriginal(r.path, j.backupDir) === 'kopie') r.backup = 'kopie';
      } catch (e) {
        j.backupUntil = Date.now() + 86400e3;
        return this.fail(j, I18N.t('common.backupAbort', { error: e.message }));
      }
    }
    const client = this.client(j.app);
    const files2 = ok.map((r) => {
      const base = { path: r.out, quality: r.quality, languages: r.languages, releaseGroup: r.releaseGroup || '', indexerFlags: 0 };
      return j.app === 'radarr'
        ? { ...base, movieId: j.arrId }
        : { ...base, seriesId: j.arrId, episodeIds: r.episodeIds, releaseType: 'singleEpisode' };
    });
    await client.command({ name: 'ManualImport', importMode: 'move', files: files2 });
    j.state = 'importing';
    j.importAt = Date.now();
    j.importedFileIds = ok.map((r) => r.fileId);
    j.backupUntil = Date.now() + Math.max(this.st.keepBackupDays, 30) * 86400e3; // zkrátí se po úspěšném importu
    const failed = results.filter((r) => !r.ok);
    this.log(j, 'info', I18N.t('merge.merged', {
      done: ok.length, total: targets.length,
      failed: failed.length ? I18N.t('merge.mergedFailed', { list: failed.map((r) => `${r.target} – ${r.reason}`).join('; ') }) : '',
    }));
  }

  async mergeOne(j, t, donorPath) {
    const st = this.st;
    const need = j.need;
    const other = need === L.primary() ? L.secondary() : L.primary();
    const [tp, dp] = await Promise.all([A.probe(t.path), A.probe(donorPath)]);
    const name = path.basename(t.path);
    // Stávající stopy bez značky nebo se špatnou značkou: jazyk podle poslechu (a ve výsledku je podle něj i označíme)
    const heard = speechLangs(this.ctx.store.s.items[j.itemKey]?.langCheck, t.fileId, tp.audio);
    const relabel = [];
    tp.audio = tp.audio.map((a, i) => {
      const l = heard[i];
      if (!l || !LANGS.get(l) || (l === a.lang && a.from === 'tag')) return a;
      relabel.push({ audioIndex: a.audioIndex, lang: l, was: a.from === 'tag' ? a.lang : null });
      return { ...a, lang: l, from: 'poslech' };
    });
    if (tp.audio.some((a) => a.lang === need)) return { skipped: true, target: name, reason: I18N.t('merge.hasTrack') };

    // Jazyk podle skutečných zvukových stop donoru
    let track = dp.audio.find((a) => a.lang === need && a.from === 'tag') || dp.audio.find((a) => a.lang === need);
    const notes = relabel.map((r) => (r.was
      ? I18N.t('merge.relabel.tagged', { n: r.audioIndex + 1, was: L.label(r.was), lang: L.label(r.lang) })
      : I18N.t('merge.relabel.untagged', { n: r.audioIndex + 1, lang: L.label(r.lang) })));
    if (!track) {
      const c = j.candidate;
      if (dp.audio.length === 1 && !dp.audio[0].lang && c && !(c.dualDonor)) {
        track = dp.audio[0];
        notes.push(I18N.t('merge.donorUntagged'));
      } else {
        throw new Error(I18N.t('merge.donorLacks', { lang: L.label(need), tracks: dp.audio.map((a) => a.lang || '?').join(', ') || I18N.t('common.none') }));
      }
    }
    const ref = tp.audio.find((a) => a.lang === other && a.default) || tp.audio.find((a) => a.lang === other) || tp.audio.find((a) => a.default) || tp.audio[0];
    if (!ref) throw new Error(I18N.t('merge.noAudio'));
    const fpsDiffers = (a, b) => a && b && Math.abs(a / b - 1) > 0.002;
    if (fpsDiffers(tp.video?.fps, dp.video?.fps)) {
      // Hlavička může lhát (zaokrouhlení na ms) → změřit podle časových značek snímků
      const [tf, df] = await Promise.all([A.measureFps(tp), A.measureFps(dp)]);
      if (fpsDiffers(tf || tp.video.fps, df || dp.video.fps)) {
        throw new Error(I18N.t('merge.fps.differs', { target: (tf || tp.video.fps).toFixed(3), donor: (df || dp.video.fps).toFixed(3) }));
      }
    }
    if (Math.abs(tp.duration - dp.duration) > 10 * 60) {
      throw new Error(I18N.t('merge.lengthDiffers', { min: Math.round(Math.abs(tp.duration - dp.duration) / 60) }));
    }

    const T = (p, a) => ({ file: p.file, duration: p.duration, startTime: p.startTime, stream: a.index });
    const opts = { maxOffsetSec: st.mergeMaxOffsetSec };
    let sync = await A.checkSync(T(tp, ref), T(dp, track), opts);
    let via = I18N.t('merge.via.direct', { lang: L.label(need), ref: L.label(ref.lang) });
    let direct = true;
    if (!sync.ok) {
      // Dabing se od originálu může lišit víc, než korelace snese – zkusit to přes stejný jazyk v donoru
      const dRef = dp.audio.find((a) => a !== track && a.lang && a.lang === ref.lang);
      if (dRef) {
        const s2 = await A.checkSync(T(tp, ref), T(dp, dRef), opts);
        const s3 = s2.ok ? await A.checkSync(T(dp, dRef), T(dp, track), { maxOffsetSec: 5 }) : null;
        if (s2.ok && s3?.ok) {
          sync = { ...s2, offsetMs: s2.offsetMs + s3.offsetMs };
          via = I18N.t('merge.via.donorRef', { ref: L.label(ref.lang) });
          direct = false;
        }
      }
    }
    if (!sync.ok) throw new Error(I18N.t('merge.syncFailed', { reason: sync.reason }));

    // Sloučení
    const outDir = path.join(j.dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, name.replace(/\.[^.]+$/, '') + '.mkv');
    const [tj, dj] = await Promise.all([A.run('mkvmerge', ['-J', t.path]), A.run('mkvmerge', ['-J', donorPath])]).then((x) => x.map(JSON.parse));
    const tAudio = (tj.tracks || []).filter((x) => x.type === 'audio');
    const dTid = (dj.tracks || []).filter((x) => x.type === 'audio')[track.audioIndex]?.id;
    if (dTid == null) throw new Error(I18N.t('merge.mkvNoDonorTrack'));
    const makeDefault = need === L.primary() && st.mergePrimaryDefault;
    const args = ['-o', out, '--enable-legacy-font-mime-types']; // jinak font/ttf, který ffmpeg nepozná
    if (makeDefault) for (const a of tAudio) args.push('--default-track-flag', `${a.id}:0`);
    for (const r of relabel) {
      const tid = tAudio[r.audioIndex]?.id;
      if (tid == null) throw new Error(I18N.t('merge.mkvNoTargetTrack'));
      args.push('--language', `${tid}:${LANGS.tagOf(r.lang)}`);
    }
    args.push(t.path,
      '--no-video', '--no-subtitles', '--no-chapters', '--no-attachments', '--no-buttons', '--no-global-tags', '--no-track-tags',
      '--audio-tracks', String(dTid),
      '--sync', `${dTid}:${sync.offsetMs}`,
      '--language', `${dTid}:${LANGS.tagOf(need)}`,
      '--track-name', `${dTid}:${trackName(need)}`,
      '--default-track-flag', `${dTid}:${makeDefault ? 1 : 0}`,
      donorPath);
    await A.run('mkvmerge', args, { timeoutMs: 60 * 60e3, okCodes: [0, 1] });

    // Kontrola výsledku: video, délka, oba jazyky a znovu synchronizace přímo ve výsledném souboru
    const op = await A.probe(out);
    if (!op.video) throw new Error(I18N.t('merge.resultNoVideo'));
    // Kratší výsledek = něco se ztratilo. Delší je v pořádku (donor má třeba delší titulky na konci).
    if (op.duration < tp.duration - 2) throw new Error(I18N.t('merge.resultShorter', { out: op.duration.toFixed(0), orig: tp.duration.toFixed(0) }));
    const oNew = op.audio.find((a) => a.lang === need);
    const oRef = op.audio[ref.audioIndex];
    if (!oNew || !oRef) throw new Error(I18N.t('merge.resultNoTrack'));
    const verify = await A.checkSync(T(op, oRef), T(op, oNew), { maxOffsetSec: 5, anchors: 6, minValid: 4 });
    if (!verify.ok || Math.abs(verify.offsetMs) > 80) {
      throw new Error(I18N.t('merge.verifyFailed', { reason: verify.reason || verify.offsetMs + ' ms' }));
    }
    const langs = await this.client(j.app).languageObjs(op.audio.map((a) => a.lang).filter((l) => LANGS.get(l)));
    return {
      target: name, out, outSize: op.size, offsetMs: sync.offsetMs, via, direct, matched: sync.matched, verifyMs: verify.offsetMs, langNote: notes.join(' · ') || null,
      fileId: t.fileId, episodeIds: t.episodeIds, quality: t.quality, releaseGroup: t.releaseGroup, path: t.path, languages: langs,
      added: { lang: need, codec: oNew.codec, channels: oNew.channels },
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
      item.lastSearchedAt = new Date().toISOString();
      j.result = { tier: cur.tier, audio: cur.audio, quality: cur.quality };
      if (cur.tier < 3 && j.app === 'radarr') j.warning = I18N.t('merge.warn.afterImport', { app: j.app, audio: cur.audio });
      await this.cleanup(j, { deleteTorrent: this.st.mergeDeleteDonor });
      j.active = false;
      j.state = 'done';
      j.finishedAt = now;
      j.progress = 1;
      j.backupUntil = now + this.st.keepBackupDays * 86400e3;
      const offs = (j.results || []).filter((r) => r.ok && !r.skipped).map((r) => `${r.offsetMs > 0 ? '+' : ''}${r.offsetMs} ms`);
      this.log(j, 'info', I18N.t('merge.done', {
        from: L.tierLabel(j.prev.tier), to: L.tierLabel(cur.tier), audio: cur.audio, offsets: [...new Set(offs)].join(', '),
        count: this.st.keepBackupDays, dir: j.backupDir,
      }));
      notify.download(j, 'done').catch(() => {});
      return;
    }
    if (now - j.importAt > 20 * 60e3) {
      const outDir = path.join(j.dir, 'out');
      const left = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0;
      const moved = (j.importedFileIds?.length || 0) - left;
      j.active = false;
      j.state = 'blocked';
      j.finishedAt = now;
      j.backupUntil = now + Math.max(this.st.keepBackupDays, 30) * 86400e3;
      this.log(j, 'warn', I18N.t('merge.importFailed', {
        moved: moved > 0 ? I18N.t('merge.importFailedPartial', { moved, total: j.importedFileIds.length }) : '', outDir, dir: j.backupDir,
      }));
      notify.download(j, 'blocked').catch(() => {});
    }
  }

  async cleanup(j, { deleteTorrent }) {
    if (deleteTorrent) {
      try {
        const hash = j.hash || (await this.qbit.byTag(`ujob-${j.id}`))?.hash;
        if (hash) await this.qbit.delete(hash, true);
      } catch (e) {
        this.ctx.store.log('warn', I18N.t('merge.deleteDonorFailed', { label: j.label, error: e.message }));
      }
    }
    fs.rmSync(path.join(j.dir, 'out'), { recursive: true, force: true });
    if (deleteTorrent) fs.rmSync(j.dir, { recursive: true, force: true });
  }

  async fail(j, reason, { retry = false } = {}) {
    const { store, notify } = this.ctx;
    if (j.state === 'importing') {
      // Radarr/Sonarr možná zrovna přesouvá sloučený soubor – nic nemazat, jen přestat hlídat
      j.active = false;
      j.state = 'blocked';
      j.finishedAt = Date.now();
      j.backupUntil = Date.now() + Math.max(this.st.keepBackupDays, 30) * 86400e3;
      this.log(j, 'warn', I18N.t('common.importUnknown', { reason, app: j.app === 'radarr' ? 'Radarr' : 'Sonarr', dir: j.backupDir }));
      notify.download(j, 'blocked').catch(() => {});
      return;
    }
    await this.cleanup(j, { deleteTorrent: true });
    if (j.backupDir && !j.backupUntil) j.backupUntil = Date.now() + 86400e3;
    if (retry) store.s.ignoredGuids[j.guid] = Date.now();
    j.active = false;
    j.state = 'failed';
    j.finishedAt = Date.now();
    this.log(j, 'warn', reason);

    const item = store.s.items[j.itemKey];
    if (retry && item && this.st.retryOnStall && j.attempt < this.st.maxRetries) {
      try {
        const { searchItem } = require('./search');
        const res = await searchItem(this.ctx, item, { reason: I18N.t('merge.reason.replacementDonor'), silent: true });
        const idx = res.proposal?.candidates.findIndex((c) => c.kind === 'merge' && c.mergeLang === j.need) ?? -1;
        if (idx >= 0) {
          j.replacedBy = (await this.start(res.proposal.id, idx, { retryOf: j })).id;
          return;
        }
        j.message += I18N.t('merge.noDonor');
      } catch (e) {
        j.message += I18N.t('download.replacementFailed', { error: e.message });
      }
    }
    this.reopen(j, { dropGuid: retry ? j.guid : null, note: I18N.t('common.prevAttemptFailed', { reason }) });
    notify.download(j, 'failed').catch(() => {});
  }
}

module.exports = { Merger, mergeCandidates, neededLang, parseEpisode, backupOriginal, isTransient, prefixBytes, fpsClearlyDiffers, speechLangs };

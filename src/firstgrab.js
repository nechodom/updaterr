// První stažení nově přidaných filmů a sérií (settings.firstGrab): release místo Radarru/Sonarru vybere Updaterr
// podle svých pravidel (dabing + originál › dabing › originál, pak rozlišení a seedy), ať se jedna věc nestahuje dvakrát – napřed
// verze, kterou vybral Radarr, a hned potom upgrade od Updaterru.
//
//  - Nové = film nebo série bez souborů, která se mezi chybějícími (monitorované, vydané) objevila až teď:
//    přidaná třeba z Jellyseerru, nově vydaná, nebo nově zapnutá série. Při prvním průchodu (i po zapnutí)
//    se jen zapamatuje, co chybí teď – starší chybějící položky zůstávají Radarru/Sonarru. Co v knihovně
//    soubor už mělo (smazaný soubor), se nestahuje.
//  - Radarr/Sonarr mohl mezitím stáhnout sám (hledání po přidání, RSS). Vybral-li stejný release, nechá se
//    mu, jinak se jeho stažení zruší (firstGrabCancelArr) – i to, které se ve frontě objeví až později.
//  - Nic vhodného, nebo všechny pokusy selhaly → položka se vrátí Radarru/Sonarru a spustí se jejich hledání
//    (firstGrabFallback). Pak už běží jen běžné upgrady.
//
// Chybějící položka žije ve store.s.items s `missing: true` a prázdným `current`, dokud se nestáhne – stahování
// (downloads.js) ji tak hlídá stejně jako upgrade (mrtvé torrenty, další kandidát, vynucený import, kontrola
// jazyka). V Knihovně ani v přehledu se neukazuje.
const L = require('./lang');
const S = require('./seasons');
const { newId } = require('./store');
const { posterOf } = require('./library');
const { fetchReleases, itemLabel, basicReject, makeCandidate, rank, releaseRes, packLangs, isLocalIndexer } = require('./search');
const { t } = require('./i18n');

const MARGIN_MS = 10 * 60e3;          // cizí stažení až tak dlouho před zjištěním nové položky (hledání po přidání)
const RETRY_MS = 10 * 60e3;           // chyba (třeba nedostupný indexer) → zkusit znovu za
const MAX_TRIES = 3;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashOf = (x) => String(x || '').toUpperCase();
const CONF_RANK = { sure: 2, likely: 1, guess: 0 };
const appName = (app) => (app === 'radarr' ? 'Radarr' : 'Sonarr');

// Stav položky bez souboru
const emptyCurrent = () => ({
  tier: 0, audio: '–', audioSource: 'none', quality: '–', qrank: 0, res: 0, vcodec: null, vcodecName: '–',
  size: 0, fileIds: [], files: 0, tierCounts: [0, 0, 0, 0],
});

// --- Co chybí -----------------------------------------------------------------------
// Filmy: monitorované, bez souboru a už vydané (podle minimální dostupnosti v Radarru)
function missingMovies(movies) {
  const out = new Map();
  for (const m of movies || []) {
    if (!m.monitored || m.hasFile || !m.isAvailable) continue;
    out.set(`radarr:${m.id}`, {
      key: `radarr:${m.id}`, app: 'radarr', arrId: m.id, season: null, title: m.title, year: m.year,
      poster: posterOf(m.images), origLang: L.origLangOf(m.originalLanguage), originalLanguage: m.originalLanguage?.name,
      addedAt: m.added,
    });
  }
  return out;
}

// Série: monitorovaný seriál i série, bez jediného souboru a aspoň jedna monitorovaná epizoda už vyšla
function missingSeasons(series) {
  const out = new Map();
  for (const s of series || []) {
    if (!s.monitored) continue;
    for (const x of s.seasons || []) {
      const st = x.statistics || {};
      if (!x.seasonNumber || !x.monitored || st.episodeFileCount > 0 || !(st.episodeCount > 0)) continue;
      const key = `sonarr:${s.id}:${x.seasonNumber}`;
      out.set(key, {
        key, app: 'sonarr', arrId: s.id, season: x.seasonNumber, title: s.title, year: s.year,
        poster: posterOf(s.images), origLang: L.origLangOf(s.originalLanguage), originalLanguage: s.originalLanguage?.name,
        episodeCount: st.totalEpisodeCount || st.episodeCount, addedAt: s.added,
      });
    }
  }
  return out;
}

// Nově chybějící položky jedné aplikace. fg = store.s.firstGrab, items = store.s.items.
// Bez předchozího průchodu (první spuštění, zapnutí funkce) se jen zapamatuje, co chybí teď.
function detectNew(fg, app, missing, items, now = Date.now()) {
  const primed = fg.primed[app];
  const fresh = [];
  for (const [key, info] of missing) {
    if (fg.known[key]) continue;
    fg.known[key] = now;
    if (!primed) continue;
    if (items[key] && !items[key].missing) continue; // soubor měla – smazaný soubor není nový titul
    fresh.push(info);
  }
  for (const key of Object.keys(fg.known)) if (key.startsWith(app + ':') && !missing.has(key)) delete fg.known[key];
  fg.primed[app] = true;
  return fresh;
}

// --- Vyhodnocení releasů --------------------------------------------------------------
// Není s čím porovnávat – každý použitelný release je kandidát, pořadí určí jazyk, jistota, rozlišení, seedy.
//   siblings – { [season]: item } ostatní chybějící série téhož seriálu, které se taky stahují poprvé
function evaluateFirst(item, releases, ctx, { siblings } = {}) {
  const st = ctx.store.settings;
  const out = [];
  const stats = { total: releases.length, notPack: 0, multiSeason: 0, dead: 0, junk: 0, rejected: 0, size: 0, res: 0, ignored: 0 };
  const seasonItems = { ...(siblings || {}), ...(item.app === 'sonarr' ? { [item.season]: item } : {}) };
  const lowSeeds = (r) => r.protocol !== 'usenet' && (Number(r.seeders) || 0) < st.minSeeders * 3;

  for (const r of releases) {
    let seasons = null;
    if (item.app === 'sonarr') {
      if (!r.fullSeason) { stats.notPack++; continue; }
      seasons = S.parseSeasons(r.title);
      if (seasons.length <= 1) seasons = [r.mappedSeasonNumber ?? r.seasonNumber];
      if (!seasons.includes(item.season)) { stats.notPack++; continue; }
      if (seasons.length > 1 && !st.multiSeasonPacks) { stats.notPack++; continue; }
    }
    const isMulti = seasons?.length > 1;
    const why = basicReject(r, ctx, { allowMultiSeason: isMulti, ignoreQueue: true });
    if (why) { stats[why]++; continue; }
    const res = releaseRes(r);

    const sizeGB = (r.size || 0) / 1024 ** 3;
    if (item.app === 'radarr' && sizeGB > st.maxMovieSizeGB) { stats.size++; continue; }
    if (item.app === 'sonarr') {
      const episodes = seasons.reduce((a, s) => a + (seasonItems[s]?.episodeCount || item.episodeCount || 10), 0);
      if (sizeGB / Math.max(1, episodes) > st.maxEpisodeSizeGB) { stats.size++; continue; }
    }

    const evalOpts = { origLang: item.origLang, arrLangs: r.languages, localIndexer: isLocalIndexer(r.indexer, st) };
    if (!isMulti) {
      const lang = L.evaluateRelease(r.title, evalOpts);
      const warnings = [];
      if (lang.confidence === 'guess') warnings.push(t('search.warn.releaseGuess'));
      if (lowSeeds(r)) warnings.push(t('search.warn.lowSeeds'));
      out.push(makeCandidate(r, { lang, tier: L.tierOf(lang, item.origLang), res, kind: 'first', warnings }));
      continue;
    }

    // Balík více sérií: importují se jen série, které se taky stahují poprvé
    stats.multiSeason++;
    const { segments, langFor } = packLangs(r, evalOpts);
    const targets = seasons.filter((s) => seasonItems[s]);
    const seasonTiers = {};
    let shown = null; // jazyk nejslabší stahované série
    for (const s of seasons) {
      const lang = langFor(s);
      const tier = L.tierOf(lang, item.origLang);
      seasonTiers[s] = tier;
      if (!targets.includes(s)) continue;
      if (!shown || tier < shown.tier || (tier === shown.tier && CONF_RANK[lang.confidence] < CONF_RANK[shown.lang.confidence])) shown = { lang, tier };
    }
    const warnings = [];
    if (shown.lang.confidence === 'guess') warnings.push(t('search.warn.releaseGuess'));
    if (lowSeeds(r)) warnings.push(t('search.warn.lowSeeds'));
    const c = makeCandidate(r, { lang: shown.lang, tier: shown.tier, res, kind: 'first', warnings });
    const extra = seasons.filter((s) => !targets.includes(s));
    c.notes.unshift(t(extra.length ? 'firstgrab.note.packPart' : 'firstgrab.note.pack', { seasons: S.formatSeasons(seasons), targets: S.formatSeasons(targets) }));
    if (segments.length > 1) c.notes.push(seasons.map((s) => `S${String(s).padStart(2, '0')} ${L.tierLabel(seasonTiers[s])}`).join(', '));
    Object.assign(c, {
      seasons, targetSeasons: targets, itemKeys: targets.map((s) => seasonItems[s].key), seasonTiers,
      searchSeason: item.season, searchedAt: Date.now(),
    });
    out.push(c);
  }
  return { candidates: rank(out), stats };
}

// Záznam fronty Radarru/Sonarru patří k položce (u seriálu k některé ze sérií)
function queueOfItem(app, arrId, seasons, r) {
  if (app === 'radarr') return r.movieId === arrId;
  return r.seriesId === arrId && seasons.includes(r.episode?.seasonNumber ?? r.seasonNumber);
}

// --- Plánovač ---------------------------------------------------------------------------

class FirstGrab {
  constructor(ctx) {
    this.ctx = ctx;
    this.polling = false;
    this.running = false;
    this.current = null;
    this.pokeTimer = null;
    this.pollErrors = {};
  }

  get fg() {
    const s = this.ctx.store.s;
    s.firstGrab ??= {};
    s.firstGrab.known ??= {};   // { [key]: kdy se poprvé objevila mezi chybějícími }
    s.firstGrab.primed ??= {};  // { radarr: true } – první průchod proběhl
    s.firstGrab.queue ??= [];   // [{ key, since, reason, tries, notBefore }]
    return s.firstGrab;
  }

  client(app) { return app === 'radarr' ? this.ctx.radarr : this.ctx.sonarr; }

  enabledFor(app) {
    const st = this.ctx.store.settings;
    if (!st.firstGrab) return false;
    return app === 'radarr' ? st.firstGrabMovies && this.ctx.radarr.enabled : st.firstGrabSeries && this.ctx.sonarr.enabled;
  }

  // Chybějící položky, které modul drží (fronta, hledání, stahování) – načtení knihovny je nesmaže
  tracked(key) {
    return this.current === key || this.fg.queue.some((j) => j.key === key) || this.ctx.busyKeys().has(key);
  }

  summary() {
    const it = this.current && this.ctx.store.s.items[this.current];
    return {
      queue: this.fg.queue.length,
      current: it ? itemLabel(it) : null,
      downloading: this.ctx.downloads.active().filter((d) => d.first).length,
    };
  }

  // Webhook (přidání, stažení) → projít hned, ne až za minutu
  poke(delayMs = 5000) {
    if (!this.ctx.store.settings.firstGrab) return;
    clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => this.poll().catch((e) => this.ctx.store.log('error', t('server.firstGrabError', { error: e.message }))), delayMs);
  }

  async poll() {
    if (this.polling) return;
    const { store } = this.ctx;
    const fg = this.fg;
    this.polling = true;
    try {
      for (const app of ['radarr', 'sonarr']) {
        // Vypnuto → po zapnutí se znovu jen zapamatuje, co chybí (nestahovat, co mezitím přibylo)
        if (!this.enabledFor(app)) {
          delete fg.primed[app];
          // Co ještě čekalo na výběr, vrátit Radarru/Sonarru (rozběhnutá stahování doběhnou)
          for (const j of fg.queue.filter((x) => x.key.startsWith(app + ':') && x.key !== this.current)) {
            const it = store.s.items[j.key];
            if (it) store.log('info', t('firstgrab.disabled', { label: itemLabel(it), app: appName(app) }));
            if (it) this.release(it); else fg.queue = fg.queue.filter((x) => x !== j);
          }
          continue;
        }
        let missing;
        try {
          missing = app === 'radarr' ? missingMovies(await this.ctx.radarr.get('/movie')) : missingSeasons(await this.ctx.sonarr.get('/series'));
          if (this.pollErrors[app]) store.log('info', t('firstgrab.pollBack', { app: appName(app) }));
          delete this.pollErrors[app];
        } catch (e) {
          if (this.pollErrors[app] !== e.message) store.log('warn', t('firstgrab.pollFailed', { app: appName(app), error: e.message }));
          this.pollErrors[app] = e.message;
          continue;
        }
        for (const info of detectNew(fg, app, missing, store.s.items)) this.add(info);
      }
    } finally {
      this.polling = false;
      store.save();
    }
  }

  add(info, reason = t('firstgrab.reason.added')) {
    const { store } = this.ctx;
    store.s.items[info.key] = Object.assign(store.s.items[info.key] || {}, info, { monitored: true, missing: true, current: emptyCurrent() });
    const fg = this.fg;
    if (!fg.queue.some((j) => j.key === info.key)) fg.queue.push({ key: info.key, since: Date.now(), reason, tries: 0 });
    store.log('info', t(info.app === 'radarr' ? 'firstgrab.newMovie' : 'firstgrab.newSeason', { label: itemLabel(store.s.items[info.key]) }));
  }

  async tick() {
    if (this.running || !this.ctx.store.settings.firstGrab) return;
    const { store } = this.ctx;
    const fg = this.fg;
    const busy = this.ctx.busyKeys();
    // Sérii mezitím pokryl balík více sérií, nebo položka zmizela
    fg.queue = fg.queue.filter((j) => !busy.has(j.key) && store.s.items[j.key]?.missing);
    const job = fg.queue.find((j) => !j.notBefore || j.notBefore <= Date.now());
    if (!job) return;
    this.running = true;
    this.current = job.key;
    try {
      await this.handle(job);
      fg.queue = fg.queue.filter((j) => j !== job);
    } catch (e) {
      const item = store.s.items[job.key];
      job.tries = (job.tries || 0) + 1;
      if (item && job.tries < MAX_TRIES) {
        job.notBefore = Date.now() + RETRY_MS;
        store.log('warn', t('firstgrab.retry', { label: itemLabel(item), error: e.message, min: RETRY_MS / 60e3 }));
      } else {
        fg.queue = fg.queue.filter((j) => j !== job);
        if (item) await this.handover(item, t('firstgrab.failed', { error: e.message })).catch(() => {});
      }
    } finally {
      this.running = false;
      this.current = null;
      store.save();
    }
  }

  // Pořád chybí? (Radarr/Sonarr mohl mezitím stáhnout a naimportovat sám)
  async stillMissing(item) {
    if (item.app === 'radarr') return !(await this.ctx.radarr.get(`/movie/${item.arrId}`)).hasFile;
    const files = await this.ctx.sonarr.get('/episodefile', { seriesId: item.arrId });
    return !files.some((f) => f.seasonNumber === item.season);
  }

  async handle(job) {
    const { store } = this.ctx;
    const item = store.s.items[job.key];
    if (!item?.missing) return;
    const label = itemLabel(item);
    if (!(await this.stillMissing(item))) {
      store.log('info', t('firstgrab.arrGotIt', { label, app: appName(item.app) }));
      this.release(item);
      return;
    }
    const { proposal: p } = await this.search(item, { reason: job.reason });
    if (!store.s.items[item.key]) return;
    if (!p) return this.handover(item, t('firstgrab.nothing'));

    // Radarr/Sonarr už stahuje stejný release → nechat mu ho
    const foreign = await this.foreignGrabs(item, job.since - MARGIN_MS);
    const best = p.candidates[0];
    const same = foreign.find((f) => norm(f.title) === norm(best.title));
    if (same) {
      Object.assign(p, { status: 'expired', note: t('firstgrab.sameNote', { app: appName(item.app) }), updatedAt: new Date().toISOString() });
      store.log('info', t('firstgrab.same', { label, app: appName(item.app), title: same.title }));
      this.release(item);
      return;
    }
    const d = await this.ctx.grab(p.id, 0, { auto: true });
    if (foreign.length) {
      try { await this.cancelForeign(d, await this.client(item.app).queue()); } catch { /* zkusí se při další kontrole stahování */ }
    }
  }

  // Hledání a návrh pro chybějící položku (i náhrada za mrtvý torrent – volá ho search.searchItem)
  async search(item, { reason }) {
    const { store } = this.ctx;
    const st = store.settings;
    const t0 = Date.now();
    store.countSearch();
    item.searching = true;
    let releases;
    try {
      releases = await fetchReleases(this.ctx, item);
    } finally {
      item.searching = false;
    }
    if (!store.s.items[item.key]) return { proposal: null, groupProposal: null, candidates: [] };
    const { candidates, stats } = evaluateFirst(item, releases, this.ctx, { siblings: this.siblings(item) });
    const top = candidates.slice(0, st.candidatesPerProposal);
    item.lastSearchedAt = new Date().toISOString();
    item.lastResult = { found: top.length, bestTier: top[0]?.tier ?? null, stats, ms: Date.now() - t0 };
    const label = itemLabel(item);
    let p = Object.values(store.s.proposals).find((x) => x.first && x.itemKey === item.key && x.status === 'pending');
    if (!top.length) {
      if (p) Object.assign(p, { status: 'expired', updatedAt: item.lastSearchedAt, note: t('firstgrab.nothingNow') });
      store.log('info', t('firstgrab.nothingLog', {
        label, total: stats.total, dead: stats.dead, res: stats.res, size: stats.size,
        notPack: stats.notPack ? t('firstgrab.notPack', { count: stats.notPack }) : '', reason,
      }));
      store.save();
      return { proposal: null, groupProposal: null, candidates: [] };
    }
    if (!p) {
      p = { id: newId(), itemKey: item.key, createdAt: item.lastSearchedAt, status: 'pending', first: true };
      store.s.proposals[p.id] = p;
    }
    Object.assign(p, { updatedAt: item.lastSearchedAt, searchedAt: Date.now(), label, current: { ...item.current }, candidates: top, kind: 'first' });
    const c = top[0];
    store.log('info', t('firstgrab.picked', {
      label, tier: L.tierLabel(c.tier), quality: c.quality, seeders: c.seeders ?? '?', title: c.title, reason,
      pack: c.targetSeasons?.length > 1 ? t('firstgrab.pickedPack', { seasons: S.formatSeasons(c.targetSeasons) }) : '',
    }));
    store.save();
    return { proposal: p, groupProposal: null, candidates: top };
  }

  // Ostatní chybějící série téhož seriálu, které se stahují poprvé a nic je zrovna nestahuje
  siblings(item) {
    if (item.app !== 'sonarr') return null;
    const busy = this.ctx.busyKeys();
    return Object.fromEntries(Object.values(this.ctx.store.s.items)
      .filter((x) => x.missing && x.app === 'sonarr' && x.arrId === item.arrId && x.key !== item.key && !busy.has(x.key))
      .map((x) => [x.season, x]));
  }

  // Stažení položky z historie Radarru/Sonarru od `since`: [{ downloadId, title, date }]
  async grabHistory(app, arrId, season, since) {
    const list = app === 'radarr'
      ? await this.ctx.radarr.get('/history/movie', { movieId: arrId, eventType: 1 })
      : await this.ctx.sonarr.get('/history/series', { seriesId: arrId, seasonNumber: season, eventType: 1 });
    const seen = new Map();
    for (const h of list || []) {
      if (!h.downloadId || Date.parse(h.date) < since) continue;
      if (!seen.has(hashOf(h.downloadId))) seen.set(hashOf(h.downloadId), { downloadId: hashOf(h.downloadId), title: h.sourceTitle, date: h.date });
    }
    return [...seen.values()];
  }

  // Co Radarr/Sonarr stáhl sám (ne Updaterr) a ještě je ve frontě
  async foreignGrabs(item, since) {
    const grabs = await this.grabHistory(item.app, item.arrId, item.season, since);
    if (!grabs.length) return [];
    const queue = await this.client(item.app).queue();
    const inQueue = new Set(queue.filter((r) => queueOfItem(item.app, item.arrId, [item.season], r)).map((r) => hashOf(r.downloadId)));
    const ours = new Set(this.ctx.downloads.active().flatMap((d) => this.ctx.downloads.partsOf(d).map((x) => hashOf(x.downloadId))).filter(Boolean));
    return grabs.filter((g) => inQueue.has(g.downloadId) && !ours.has(g.downloadId));
  }

  // Hash torrentu vlastního stažení podle historie (název ve frontě bývá jiný než název releasu) –
  // bez něj by se vlastní a cizí stažení téhož filmu nedalo rozlišit
  async identify(d) {
    const parts = this.ctx.downloads.partsOf(d).filter((x) => !x.downloadId && !x.infoHash);
    if (!parts.length) return;
    const grabs = await this.grabHistory(d.app, d.arrId, d.app === 'sonarr' ? (d.seasons || [d.season])[0] : null, d.grabbedAt - 2 * 60e3);
    for (const part of parts) {
      const g = grabs.find((x) => x.title === part.title) || grabs.find((x) => norm(x.title) === norm(part.title));
      if (g) part.downloadId = g.downloadId;
    }
  }

  // Ve frontě je i stažení, které Radarr/Sonarr spustil sám (hledání po přidání, RSS) → zrušit.
  // Jen když je jasné, které torrenty jsou naše, a jen rozstahovaná (dokončené se nechávají, už jsou stažená).
  // Vrací frontu bez zrušených záznamů.
  async cancelForeign(d, records) {
    const { store } = this.ctx;
    if (!store.settings.firstGrabCancelArr) return records;
    const parts = this.ctx.downloads.partsOf(d).filter((x) => !['failed', 'dismissed'].includes(x.state));
    if (parts.some((x) => !x.downloadId && !x.infoHash)) {
      await this.identify(d).catch(() => {});
      if (parts.some((x) => !x.downloadId && !x.infoHash)) return records;
    }
    const ours = new Set(this.ctx.downloads.partsOf(d).flatMap((x) => [x.downloadId, x.infoHash]).filter(Boolean).map(hashOf));
    const seasons = d.seasons || [d.season];
    const foreign = new Map();
    for (const r of records) {
      if (!queueOfItem(d.app, d.arrId, seasons, r) || !r.downloadId || ours.has(hashOf(r.downloadId))) continue;
      if (!(Number(r.sizeleft) > 0)) continue;
      if (!foreign.has(hashOf(r.downloadId))) foreign.set(hashOf(r.downloadId), r);
    }
    const removed = new Set();
    for (const [hash, r] of foreign) {
      try {
        await this.client(d.app).removeFromQueue(r.id, { blocklist: false, removeFromClient: true });
        removed.add(hash);
        (d.cancelledForeign ??= []).push(r.title);
        store.log('info', t('firstgrab.cancelled', { label: d.label, app: appName(d.app), title: r.title }));
      } catch (e) {
        store.log('warn', t('firstgrab.cancelFailed', { label: d.label, title: r.title, error: e.message }));
      }
    }
    return removed.size ? records.filter((r) => !removed.has(hashOf(r.downloadId))) : records;
  }

  // Updaterr to nestáhne → Radarr/Sonarr převezme (spustí hledání, pokud sám nic nestahuje)
  async handover(item, why) {
    const { store } = this.ctx;
    const app = appName(item.app);
    let note = t('firstgrab.handover.leave', { app });
    if (store.settings.firstGrabFallback) {
      try {
        const queue = await this.client(item.app).queue();
        if (queue.some((r) => queueOfItem(item.app, item.arrId, [item.season], r))) note = t('firstgrab.handover.already', { app });
        else {
          await this.client(item.app).command(item.app === 'radarr'
            ? { name: 'MoviesSearch', movieIds: [item.arrId] }
            : { name: 'SeasonSearch', seriesId: item.arrId, seasonNumber: item.season });
          note = t('firstgrab.handover.search', { app });
        }
      } catch (e) {
        note = t('firstgrab.handover.searchFailed', { app, error: e.message });
      }
    }
    store.log('info', `${itemLabel(item)}: ${why}${note}`);
    this.release(item);
  }

  // Konec prvního stažení bez výsledku – položka zmizí, do knihovny se dostane se souborem
  release(item) {
    const { store } = this.ctx;
    const now = new Date().toISOString();
    for (const p of Object.values(store.s.proposals)) {
      if (p.first && p.itemKey === item.key && p.status === 'pending') Object.assign(p, { status: 'expired', updatedAt: now });
    }
    this.fg.queue = this.fg.queue.filter((j) => j.key !== item.key);
    if (store.s.items[item.key]?.missing) delete store.s.items[item.key];
    store.save();
  }

  // Stahování skončilo bez úspěchu a bez náhrady (downloads.js)
  // keepProposal: stažení se povedlo (vracejí se jen série, které v balíku nebyly) – návrh zůstává „staženo“
  async giveUp(d, why, { search = true, keepProposal = false } = {}) {
    const { store } = this.ctx;
    const p = store.s.proposals[d.proposalId];
    if (p && p.downloadId === d.id && !keepProposal) Object.assign(p, { status: 'expired', note: why, updatedAt: new Date().toISOString() });
    for (const k of d.itemKeys || [d.itemKey]) {
      const it = store.s.items[k];
      if (!it?.missing) continue;
      if (search) await this.handover(it, why);
      else {
        store.log('info', t('firstgrab.giveUp', { label: itemLabel(it), why, app: appName(it.app) }));
        this.release(it);
      }
    }
  }
}

module.exports = { FirstGrab, missingMovies, missingSeasons, detectNew, evaluateFirst, emptyCurrent, queueOfItem };

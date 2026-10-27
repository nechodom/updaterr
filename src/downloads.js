// Stažení schváleného kandidáta a hlídání jeho osudu:
//  - torrent se nehýbe (stalled) → odebrat z klienta, zablokovat, zkusit dalšího kandidáta
//  - Radarr/Sonarr odmítne import "není upgrade" (jejich pravidla neznají náš jazyk) → vynutit ruční import
//  - po importu ověřit skutečné audio stopy z MediaInfo (release mohl o jazyku lhát)
//
// Jedno stahování může mít víc torrentů (parts) – sada jednotlivých epizod. Balík více sérií je jeden torrent,
// ale nahrazuje víc položek (itemKeys) a importují se z něj jen nahrazované série (seasons).
const L = require('./lang');
const S = require('./seasons');
const { newId } = require('./store');
const { fetchReleases, searchItem, itemLabel, seasonLabel, combineCurrent, reopenProposal } = require('./search');
const { refreshItem, minCodec } = require('./library');
const { badDonorOf, badDonorCode } = require('./merge');
const LC = require('./langcheck');
const { t } = require('./i18n');
const W = require('./watch');

const FRESH_MS = 20 * 60e3;            // výsledky hledání starší než tohle před stažením ověříme znovu
const UPGRADE_REJECTION = /upgrade|cutoff|existing (movie |episode )?file|custom format/i;
// Název souboru nejde rozparsovat (třeba překlep v roce) – film Radarr zná podle downloadId, chybí jen kvalita
const PARSE_REJECTION = /unable to parse/i;
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|mpe?g)$/i;
const GONE = new Set(['failed', 'dismissed']);
// Stav fronty Radarru/Sonarru, kdy torrent stát smí: čeká ve frontě qBittorrentu, je ručně zastavený, klient neodpovídá
const WAITING = /^(queued|paused|delay|downloadClientUnavailable)$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const reasons = (x) => (x.rejections || []).map((r) => (typeof r === 'string' ? r : r?.reason || '')).filter(Boolean);
const newPart = (x) => ({ guid: x.guid, indexerId: x.indexerId, infoHash: x.infoHash || null, title: x.title, size: x.size || 0, state: 'grabbed', progress: 0 });
const uniqJoin = (list) => [...new Set(list)].join(' | ');

class Downloads {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = false;
  }

  client(app) { return app === 'radarr' ? this.ctx.radarr : this.ctx.sonarr; }

  active() { return Object.values(this.ctx.store.s.downloads).filter((d) => d.active); }

  // Záznamy z doby před sadami epizod mají jediný torrent přímo v sobě
  partsOf(d) {
    if (!d.parts) {
      d.parts = [{
        guid: d.guid, indexerId: d.indexerId, title: d.title, size: d.size || 0, state: d.state, progress: d.progress || 0,
        downloadId: d.downloadId, queueId: d.queueId, seenInQueue: d.seenInQueue, lastSeenInQueue: d.lastSeenInQueue,
        lastProgressAt: d.lastProgressAt, lastSizeLeft: d.lastSizeLeft, completedAt: d.completedAt, forceImportAt: d.forceImportAt,
      }];
    }
    return d.parts;
  }

  // Release z návrhu je starý → znovu vyhledat, ověřit seedy a obnovit cache releasů v Radarru/Sonarru
  async refreshCandidate(p, idx, cand, item, label) {
    const { store } = this.ctx;
    const st = store.settings;
    store.log('info', t('download.verifyingAlive', { label, title: cand.title }));
    store.countSearch();
    const searched = cand.searchSeason != null ? store.s.items[`sonarr:${item.arrId}:${cand.searchSeason}`] || item : item;
    const releases = await fetchReleases(this.ctx, searched);
    const find = (x) => releases.find((r) => r.guid === x.guid) || releases.find((r) => r.indexerId === x.indexerId && r.title === x.title);
    const dead = (r) => r.protocol !== 'usenet' && (Number(r.seeders) || 0) < st.minSeeders;
    const gone = (title) => {
      this.ctx.searcher.enqueue(searched.key, { reason: t('download.reason.releaseGone') });
      return new Error(title ? t('download.goneTitled', { title }) : t('download.gone'));
    };

    if (cand.set) {
      const parts = [];
      for (const part of cand.parts) {
        const r = find(part);
        if (!r) throw gone(part.title);
        if (dead(r)) {
          this.ctx.searcher.enqueue(searched.key, { reason: t('download.reason.setEpisodeDied') });
          throw new Error(t('download.partDied', { title: part.title, seeders: r.seeders || 0 }));
        }
        parts.push({ ...part, guid: r.guid, seeders: r.protocol === 'usenet' ? null : Number(r.seeders) || 0 });
      }
      const seeds = parts.map((x) => x.seeders).filter((x) => x != null);
      cand = { ...cand, parts, seeders: seeds.length ? Math.min(...seeds) : null };
    } else {
      const r = find(cand);
      if (!r) throw gone();
      cand = { ...cand, guid: r.guid, seeders: r.seeders, leechers: r.leechers, arr: { quality: r.quality, languages: r.languages || [] } };
      if (dead(r)) {
        p.candidates[idx] = cand;
        store.save();
        throw new Error(t('download.torrentDied', { seeders: r.seeders || 0 }));
      }
    }
    cand.searchedAt = Date.now();
    p.candidates[idx] = cand;
    p.searchedAt = Date.now();
    store.save();
    return cand;
  }

  async grab(proposalId, idx, { auto = false, retryOf = null } = {}) {
    const { store, notify } = this.ctx;
    const p = store.s.proposals[proposalId];
    if (!p) throw new Error(t('err.proposalNotFound'));
    if (p.status !== 'pending') throw new Error(t('err.proposalDone', { status: p.status }));
    const item = store.s.items[p.itemKey];
    if (!item) throw new Error(t('err.itemGone'));
    let cand = p.candidates?.[idx];
    if (!cand) throw new Error(t('err.candidateNotFound'));
    const keys = cand.itemKeys || [item.key];
    const targets = keys.map((k) => store.s.items[k]);
    if (targets.some((t) => !t)) throw new Error(t('err.seasonGone'));
    const busy = this.ctx.busyKeys({ except: proposalId });
    if (keys.some((k) => busy.has(k))) throw new Error(keys.length > 1 ? t('err.seasonsBusy') : t('err.itemBusy'));
    const label = keys.length > 1 ? seasonLabel(item.title, targets.map((t) => t.season)) : itemLabel(item);
    const multiSeason = cand.seasons?.length > 1;

    if (Date.now() - (cand.searchedAt || p.searchedAt || 0) > FRESH_MS) cand = await this.refreshCandidate(p, idx, cand, item, label);

    const client = this.client(item.app);
    let parts;
    if (cand.set) {
      // Sada epizod: každá epizoda zvlášť; co se nepovede odeslat, jen zalogovat
      parts = [];
      const errors = [];
      for (const part of cand.parts) {
        try {
          await client.grab(part.guid, part.indexerId);
          parts.push(newPart(part));
        } catch (e) {
          errors.push(t('download.partError', { title: part.title, error: e.message }));
        }
      }
      if (!parts.length) throw new Error(t('download.setGrabNone', { error: errors[0] }));
      if (errors.length) store.log('warn', t('download.setGrabPartial', { label, count: errors.length, total: cand.parts.length, errors: errors.join('; ') }));
    } else if (multiSeason) {
      // Sonarr balíky více sérií odmítá – stáhnout s ručně zadanými epizodami nahrazovaných sérií
      const episodes = await client.get('/episode', { seriesId: item.arrId });
      const episodeIds = episodes.filter((e) => cand.targetSeasons.includes(e.seasonNumber)).map((e) => e.id);
      if (!episodeIds.length) throw new Error(t('download.noEpisodes'));
      if (!cand.arr?.quality) throw new Error(t('download.noQuality'));
      await client.grabOverride({
        guid: cand.guid, indexerId: cand.indexerId, seriesId: item.arrId, episodeIds,
        quality: cand.arr.quality, languages: cand.arr.languages || [],
      });
      parts = [newPart(cand)];
    } else {
      await client.grab(cand.guid, cand.indexerId);
      parts = [newPart(cand)];
    }

    const prev = combineCurrent(targets);
    const d = {
      id: newId(),
      itemKey: item.key, itemKeys: keys, groupKey: p.groupKey || null, seasons: multiSeason ? cand.targetSeasons : null,
      proposalId, label, app: item.app, arrId: item.arrId, season: item.season,
      title: cand.title, guid: cand.guid, indexerId: cand.indexerId, candidate: cand,
      prev: { tier: prev.tier, audio: prev.audio, quality: prev.quality, vcodec: prev.vcodec, vcodecName: prev.vcodecName },
      prevFileIds: item.current.fileIds,
      prevFileIdsByKey: Object.fromEntries(targets.map((t) => [t.key, t.current.fileIds])),
      parts,
      grabbedAt: Date.now(),
      state: 'grabbed', active: true, auto,
      first: Boolean(p.first), // první stažení nové položky (firstgrab.js) – žádný soubor se nenahrazuje
      attempt: retryOf ? (retryOf.attempt || 1) + 1 : 1,
      retryOf: retryOf?.id || null,
      progress: 0,
    };
    store.s.downloads[d.id] = d;
    p.status = 'grabbed';
    p.grabbedIdx = idx;
    p.downloadId = d.id;
    p.updatedAt = new Date().toISOString();
    // Balík více sérií nahrazuje i samostatné návrhy dotčených sérií
    if (keys.length > 1) {
      for (const x of Object.values(store.s.proposals)) {
        if (x === p || x.status !== 'pending' || x.groupKey || !keys.includes(x.itemKey)) continue;
        x.status = 'expired';
        x.updatedAt = p.updatedAt;
        x.note = t('download.note.packDownloading', { seasons: S.formatSeasons(cand.targetSeasons) });
      }
    }
    const how = cand.set ? t('download.how.set', { count: parts.length })
      : multiSeason ? t('download.how.multi', { seasons: S.formatSeasons(cand.seasons), targets: S.formatSeasons(cand.targetSeasons) }) : '';
    store.log('info', t('download.grabbing', {
      label, title: cand.title, indexer: cand.indexer, seeders: cand.seeders ?? '?', how,
      auto: d.first ? t('download.tag.first') : auto ? t('download.tag.auto') : '', retry: retryOf ? t('download.tag.retry', { attempt: d.attempt }) : '',
    }));
    store.save();
    // Vlastní torrent poznat podle hashe (z historie Radarru/Sonarru), ať se nesplete s tím, co Radarr/Sonarr
    // stáhl sám – jinak by se mohl převzít (a po importu smazat) cizí torrent téhož filmu
    await this.ctx.firstGrab?.identify(d).catch(() => {});
    if (auto || retryOf) notify.download(d, 'grabbed').catch(() => {});
    return d;
  }

  async cancel(id) {
    const { store } = this.ctx;
    const d = store.s.downloads[id];
    if (!d || !d.active) throw new Error(t('err.downloadNotRunning'));
    // Torrent, který ještě nebyl spárovaný s frontou, dohledat – jinak by ho Radarr/Sonarr dál stahoval a importoval
    const parts = this.partsOf(d);
    if (parts.some((p) => !p.queueId && !GONE.has(p.state))) {
      const records = await this.client(d.app).queue();
      for (const p of parts) if (!p.queueId) p.queueId = this.findInQueue(d, p, records)?.id;
    }
    const missing = [];
    for (const part of parts) {
      if (GONE.has(part.state)) continue;
      if (!part.queueId) { missing.push(part.title); continue; }
      try { await this.client(d.app).removeFromQueue(part.queueId, { blocklist: false }); } catch (e) { missing.push(part.title); store.log('warn', t('download.removeFailed', { label: d.label, error: e.message })); }
    }
    d.active = false;
    d.state = 'cancelled';
    d.finishedAt = Date.now();
    if (missing.length) d.message = t(d.app === 'radarr' ? 'download.notInQueue.radarr' : 'download.notInQueue.sonarr', { titles: missing.join(', ') });
    if (d.first) await this.ctx.firstGrab.giveUp(d, t('download.giveUp.cancelled'), { search: false });
    else reopenProposal(this.ctx, d, { note: t('download.note.cancelled') });
    store.log('info', missing.length ? t('download.cancelledMissing', { label: d.label, message: d.message }) : t('download.cancelled', { label: d.label }));
    store.save();
  }

  async tick() {
    if (this.running) return;
    const list = this.active();
    if (!list.length) return;
    this.running = true;
    const queues = {};
    try {
      for (const d of list) {
        try {
          queues[d.app] ??= await this.client(d.app).queue();
          // První stažení: co mezitím stáhl sám Radarr/Sonarr, zrušit (a z fronty vyřadit, ať se nespáruje)
          if (d.first) queues[d.app] = await this.ctx.firstGrab.cancelForeign(d, queues[d.app]);
          if (d.active) await this.check(d, queues[d.app]); // mezitím zrušeno → nesahat

        } catch (e) {
          this.ctx.store.log('warn', t('download.checkFailed', { label: d.label, error: e.message }));
        }
      }
    } finally {
      this.running = false;
      this.ctx.store.save();
    }
  }

  // Ve frontě Radarru/Sonarru je název torrentu (často jméno souboru), ne název releasu → párujeme přes
  // info-hash (= downloadId u qBittorrentu), pak přes název, a nakonec přes film/seriál, pokud je jednoznačný.
  findInQueue(d, part, records) {
    const hashOf = (x) => String(x || '').toUpperCase();
    const hash = hashOf(part.downloadId || part.infoHash || (String(part.guid).match(/\b[0-9a-f]{40}\b/i) || [])[0]);
    if (hash) {
      const q = records.find((r) => hashOf(r.downloadId) === hash);
      if (q) return q;
    }
    const same = records.filter((r) => (d.app === 'radarr' ? r.movieId === d.arrId : r.seriesId === d.arrId));
    const byTitle = same.find((r) => norm(r.title) === norm(part.title));
    if (byTitle) return byTitle;
    if (d.parts?.length > 1) return null; // u sady epizod bez shody nehádat
    // Hash známe (z hledání nebo z historie), ale ve frontě není → je to jiný torrent, nehádat
    if (hash) return null;
    const claimed = new Set(this.active().filter((x) => x.id !== d.id).flatMap((x) => this.partsOf(x).map((y) => hashOf(y.downloadId))).filter(Boolean));
    const free = [...new Map(same.filter((r) => !claimed.has(hashOf(r.downloadId))).map((r) => [r.downloadId, r])).values()];
    // Odhad (jediný záznam filmu ve frontě) může být i stažení Radarru – označit, ať se jeho hash nepřevezme
    return free.length === 1 ? { ...free[0], guessed: true } : null;
  }

  // Položky, jejichž soubory se od stažení změnily: { [itemKey]: nový stav }
  async changedTargets(d) {
    const { store } = this.ctx;
    const prevBy = d.prevFileIdsByKey || { [d.itemKey]: d.prevFileIds };
    const out = {};
    for (const k of d.itemKeys || [d.itemKey]) {
      const it = store.s.items[k];
      const cur = it ? await refreshItem(this.ctx, it) : null;
      if (cur && JSON.stringify(cur.fileIds) !== JSON.stringify(prevBy[k])) out[k] = cur;
    }
    return out;
  }

  async check(d, records) {
    const { store, notify } = this.ctx;
    const st = store.settings;
    const now = Date.now();
    const parts = this.partsOf(d);
    let inQueue = 0;
    // Hash vlastního torrentu ještě neznáme (historie se zapisuje se zpožděním) → zkusit znovu
    if (parts.some((x) => !GONE.has(x.state) && !x.downloadId && !x.infoHash)) await this.ctx.firstGrab?.identify(d).catch(() => {});
    if (!d.active) return;

    for (const part of parts) {
      if (GONE.has(part.state)) continue;
      const q = this.findInQueue(d, part, records);
      if (!q) {
        if (!part.seenInQueue && now - d.grabbedAt > 15 * 60e3) {
          // Rychlé stažení mohlo proběhnout i s importem mezi dvěma koly – to dořeší souhrn níže
          if (parts.length === 1 && Object.keys(await this.changedTargets(d)).length) continue;
          // Fronta Radarru/Sonarru je prázdná i při výpadku qBittorrentu – to není chyba torrentu.
          // Torrent v qBittorrentu je, jen ho Radarr/Sonarr ve frontě nespároval → dát mu čas (jako u „ztraceného“)
          const client = await this.clientState(d, [part]);
          if (client?.down || (client?.present && now - d.grabbedAt < 6 * 3600e3)) { d.message = client.message; continue; }
          if (await this.fail(d, t('download.neverAppeared'), part)) return;
        }
        continue;
      }
      inQueue++;
      part.seenInQueue = true;
      part.lastSeenInQueue = now;
      part.queueId = q.id;
      if (q.guessed) {
        part.guessed = true; // spárováno jen odhadem – hash nepřebírat (úklid by mohl smazat cizí torrent)
        part.queueDownloadId = q.downloadId || null; // jen pro vynucený import tohohle záznamu fronty
      } else part.downloadId = q.downloadId || part.downloadId;
      const size = Number(q.size) || 0;
      const left = Number(q.sizeleft) || 0;
      // Velikost 0 = magnet ještě nemá metadata: nic se nestahuje, ale ani není staženo
      const noMeta = size <= 0;
      // Metadata dorazila (nebo se změnil obsah) – výchozí bod pro pokrok měřit znovu od teď
      if (!noMeta && part.size !== size) {
        part.lastSizeLeft = left;
        part.lastProgressAt = now;
      }
      part.size = size;
      part.progress = size ? Math.max(0, Math.min(1, 1 - left / size)) : 0;
      // Výchozí bod posouvat jen při pokroku – jinak by pomalý torrent (pár kB/s) vypadal jako mrtvý
      if (!noMeta && (part.lastSizeLeft == null || left < part.lastSizeLeft - 5e6)) {
        part.lastProgressAt = now;
        part.lastSizeLeft = left;
      }
      // Čeká ve frontě klienta, je ručně zastavený nebo klient nejede – to se za "žádný pokrok" nepočítá
      if (WAITING.test(q.status || '')) part.lastProgressAt = now;
      part.queueState = q.trackedDownloadState || q.status;
      part.message = (q.statusMessages || []).flatMap((m) => m.messages || [m.title]).filter(Boolean).join(' · ') || q.errorMessage || '';
      part.timeleft = q.timeleft || null;

      if (q.status === 'failed' || /failed/i.test(q.trackedDownloadState || '')) {
        if (await this.fail(d, t('download.failedMsg', { message: part.message || q.status }), part)) return;
        inQueue--;
        continue;
      }
      if (left > 0 || noMeta) {
        part.state = 'downloading';
        if (now - (part.lastProgressAt || d.grabbedAt) > st.stallHours * 3600e3) {
          if (await this.fail(d, t('download.noProgress', { hours: st.stallHours }), part)) return;
          inQueue--;
        }
        continue;
      }
      // Staženo – čeká se na import
      part.state = 'importing';
      part.completedAt ??= now;
      const blocked = /importBlocked|importPending|importFailed/i.test(q.trackedDownloadState || '') && q.trackedDownloadStatus !== 'ok';
      if (!blocked || now - part.completedAt <= 2 * 60e3) continue;
      // Bez vynuceného importu se počítá od dokončení (jinak by blokovaný import visel navždy)
      const blockedSince = part.forceImportAt || (!st.forceImport && part.completedAt);
      if (!blockedSince) {
        await this.forceImport(d, part);
      } else if (part.forceImportAt && now - part.forceImportAt > 5 * 60e3 && parts.length === 1 && Object.keys(await this.changedTargets(d)).length && !(await this.importRunning(d, part))) {
        // Vynucený import proběhl, ve frontě visí jen zbytek (např. série z balíku, které nenahrazujeme)
        await this.dismiss(d, part, t('download.importedRest'));
      } else if (now - blockedSince > 15 * 60e3) {
        part.state = 'blocked';
        if (!d.blockedNotified) {
          d.blockedNotified = true;
          d.message = part.message;
          store.log('warn', t('download.stillBlocked', { label: d.label, message: part.message }));
          notify.download(d, 'blocked').catch(() => {});
        }
        // Občas zkusit znovu – soubor mohl někdo přejmenovat nebo se změnila pravidla importu
        if (st.forceImport && part.forceImportAt && now - part.forceImportAt > 6 * 3600e3) await this.forceImport(d, part);
      }
      if (part.state === 'dismissed') inQueue--;
    }

    if (!d.active) return; // selhalo nebo zrušeno během kontroly
    // Souhrn za všechny torrenty
    const alive = parts.filter((x) => x.state !== 'failed');
    d.progress = alive.length ? alive.reduce((a, x) => a + (x.state === 'dismissed' ? 1 : x.progress || 0), 0) / alive.length : 0;
    d.size = alive.reduce((a, x) => a + (x.size || 0), 0);
    const states = alive.map((x) => x.state);
    d.state = ['downloading', 'blocked', 'importing', 'grabbed'].find((s) => states.includes(s)) || d.state;
    if (parts.length === 1) {
      Object.assign(d, { queueId: parts[0].queueId, downloadId: parts[0].downloadId, queueState: parts[0].queueState, timeleft: parts[0].timeleft });
      if (d.state !== 'blocked' || !d.message) d.message = parts[0].message || '';
    } else {
      const failed = parts.length - alive.length;
      const finished = alive.filter((x) => x.state === 'dismissed' || (x.seenInQueue && x.lastSeenInQueue < now) || x.state === 'importing').length;
      d.message = t('download.partsProgress', { done: finished, total: parts.length, failed: failed ? t('download.partsFailed', { count: failed }) : '' });
      d.timeleft = alive.filter((x) => x.state === 'downloading').map((x) => x.timeleft).filter(Boolean).sort().pop() || null;
    }
    if (inQueue > 0) return;

    // Ve frontě nic není → buď naimportováno, nebo se ztratilo
    const changed = await this.changedTargets(d);
    if (!d.active) return;
    const keys = Object.keys(changed);
    if (keys.length) {
      // MediaInfo se po importu chvíli počítá
      d.importSeenAt ??= now;
      if (keys.some((k) => !changed[k].mediaInfoKnown) && now - d.importSeenAt < 15 * 60e3) return;
      for (const k of keys) {
        const { mediaInfoKnown, ...current } = changed[k];
        store.s.items[k].current = current;
        store.s.items[k].lastSearchedAt = new Date().toISOString();
        delete store.s.items[k].missing;
      }
      const results = keys.map((k) => changed[k]);
      d.active = false;
      d.state = 'done';
      d.finishedAt = now;
      d.progress = 1;
      d.result = {
        tier: Math.min(...results.map((c) => c.tier)), audio: uniqJoin(results.map((c) => c.audio)), quality: uniqJoin(results.map((c) => c.quality)),
        vcodec: minCodec(results), vcodecName: uniqJoin(results.map((c) => c.vcodecName || '?')),
      };
      d.message = parts.some((x) => x.forceImportAt) ? t('download.forcedImported', { app: d.app === 'radarr' ? 'Radarr' : 'Sonarr' }) : '';
      const warnings = [];
      // Verze k dabingu (cutmatch): release sám slibuje jen jazyk obrazu, druhý jazyk přidá až navazující sloučení
      const promised = d.candidate.baseTier ?? d.candidate.tier;
      // Než release obviníme ze lži: možná jen nový soubor má chybně označené stopy → ověřit poslechem
      if (d.result.tier < promised && keys.some((k) => LC.needsCheck(this.ctx, store.s.items[k]))) {
        for (const k of keys) {
          try { await LC.verify(this.ctx, store.s.items[k], { reason: t('download.reason.afterDownload') }); } catch (e) { store.log('warn', t('download.langCheckFailed', { label: d.label, error: e.message })); }
        }
        const now2 = keys.map((k) => store.s.items[k].current);
        d.result = { ...d.result, tier: Math.min(...now2.map((c) => c.tier)), audio: uniqJoin(now2.map((c) => c.audio)) };
      }
      // Spárováno jen odhadem → naimportovat mohl i Radarr/Sonarr něco svého; release za to neblokovat
      const guessed = parts.some((x) => x.guessed && !x.downloadId);
      if (d.result.tier < promised) {
        warnings.push(t('download.warn.lied', { promised: L.tierLabel(promised), got: L.tierLabel(d.result.tier), audio: d.result.audio }) + (guessed ? t('download.warn.liedGuessed') : ''));
        if (!guessed) store.s.ignoredGuids[d.guid] = now;
      }
      // Upgrade kvůli formátu videa: release o kodeku lhal (v názvu x265, soubor H.264)
      if (d.candidate.kind === 'codec' && d.result.vcodec != null && d.candidate.vcodec != null && d.result.vcodec < d.candidate.vcodec) {
        warnings.push(t('download.warn.codecLied', { promised: d.candidate.vcodecName, got: d.result.vcodecName }));
        store.s.ignoredGuids[d.guid] = now;
      }
      const unchanged = (d.itemKeys || []).filter((k) => !changed[k] && store.s.items[k]);
      if (unchanged.length) warnings.push(t('download.warn.unchanged', { seasons: S.formatSeasons(unchanged.map((k) => store.s.items[k].season)), count: unchanged.length }));
      const failed = parts.filter((x) => x.state === 'failed').length;
      if (failed) warnings.push(t('download.warn.partsFailed', { count: failed, total: parts.length }));
      if (warnings.length) {
        d.warning = warnings.join(' · ');
        store.log('warn', `${d.label}: ${d.warning}`);
      } else if (d.first) {
        store.log('info', t('download.doneFirst', { label: d.label, tier: L.tierLabel(d.result.tier), audio: d.result.audio, quality: d.result.quality }));
      } else {
        const codec = d.candidate.kind === 'codec' ? `, ${d.prev.vcodecName || '?'} → ${d.result.vcodecName}` : '';
        store.log('info', t('download.done', { label: d.label, from: L.tierLabel(d.prev.tier), to: L.tierLabel(d.result.tier), audio: d.result.audio, quality: d.result.quality + codec }));
      }
      if (d.first) {
        const firstItems = keys.map((k) => store.s.items[k]);
        for (const it of W.watchFirst(store, firstItems)) {
          store.log('info', t(it.watch?.auto || store.s.watchSeries?.[it.arrId]?.auto ? 'download.firstWatchAuto' : 'download.firstWatch', { what: it.app === 'sonarr' ? it.title : itemLabel(it) }));
        }
        // Série, které z balíku zůstaly bez souboru, vrátit Sonarru
        await this.ctx.firstGrab.giveUp(d, t('download.giveUp.notInPack'), { keepProposal: true });
      }
      if (d.candidate.kind === 'cutmatch') await this.chainMerge(d);
      notify.download(d, 'done').catch(() => {});
      return;
    }
    const lastSeen = Math.max(0, ...parts.map((x) => x.lastSeenInQueue || 0));
    if (lastSeen && now - lastSeen > 30 * 60e3) {
      // Než stahování odepíšeme: zeptat se qBittorrentu přímo. Když neodpovídá, Radarr/Sonarr ho ve frontě
      // nevidí, ale torrent je pořád v něm – počkat. Když torrent v qBittorrentu je, dát Radarru/Sonarru čas.
      const client = await this.clientState(d, parts);
      if (client?.down || (client?.present && now - lastSeen < 6 * 3600e3)) {
        d.message = client.message;
        return;
      }
      d.active = false;
      d.state = 'lost';
      d.finishedAt = now;
      d.message = t('download.lost');
      if (d.first) await this.ctx.firstGrab.giveUp(d, t('download.giveUp.lost'));
      else reopenProposal(this.ctx, d, { note: t('download.note.lost') });
      store.log('warn', `${d.label}: ${d.message}`);
      notify.download(d, 'lost').catch(() => {});
    }
  }

  // Verze k dabingu (search.js cutMatchCandidates): nový soubor je naimportovaný → rovnou do něj přidat zvuk
  // z donoru, který byl součástí schváleného návrhu. Když donor mezitím zmizel, vezme se jiný stejné verze.
  async chainMerge(d) {
    const { store } = this.ctx;
    const item = store.s.items[d.itemKey];
    const donor = d.candidate.donor;
    if (!item || !donor) return;
    const need = L.label(donor.mergeLang);
    try {
      if (item.current.truncated) throw new Error(t('download.chain.truncated'));
      if (item.current.tier >= 3) {
        store.log('info', t('download.chain.hasAudio', { label: d.label, lang: need }));
        return;
      }
      // Donor neprošel sloučením se starým souborem kvůli délce (jiný střih) – k novému souboru to neplatí
      const bad = badDonorOf(store, item.key, donor);
      if (bad && badDonorCode(bad) === 'length') delete store.s.badDonors[bad.id];
      const res = await searchItem(this.ctx, item, { reason: t('download.chain.reason'), silent: true });
      const cands = res.proposal?.candidates || [];
      let idx = cands.findIndex((c) => c.kind === 'merge' && !c.set && (c.guid === donor.guid || c.title === donor.title));
      if (idx < 0) idx = cands.findIndex((c) => c.kind === 'merge' && !c.set && c.mergeLang === donor.mergeLang && !c.otherCut);
      if (idx < 0) throw new Error(t('download.chain.noDonor'));
      const title = cands[idx].title;
      const j = await this.ctx.grab(res.proposal.id, idx, { auto: true });
      d.chainedMergeId = j.id;
      store.log('info', t('download.chain.started', { label: d.label, lang: need, title }));
    } catch (e) {
      d.warning = [d.warning, t('download.chain.failedShort', { lang: need, error: e.message })].filter(Boolean).join(' · ');
      store.log('warn', t('download.chain.failed', { label: d.label, lang: need, error: e.message }));
    }
    store.save();
  }

  // První stažení balíku selhalo a náhrada pokrývá jen část sérií: zbylé vrátit prvnímu stažení
  // (firstgrab.js je předá Sonarru) – jinak by na ně čekalo stahování, které už neběží
  async returnUncovered(d, replacement, reason) {
    const covered = new Set(replacement.itemKeys || [replacement.itemKey]);
    const rest = (d.itemKeys || [d.itemKey]).filter((k) => !covered.has(k));
    if (rest.length) await this.ctx.firstGrab.giveUp({ ...d, proposalId: null, itemKeys: rest }, t('download.giveUp.notInReplacement', { reason }));
    return rest;
  }

  // Stav torrentů stahování přímo v qBittorrentu: null = nejde ověřit (není nastavený),
  // { down } = neodpovídá, { present } = aspoň jeden torrent tam pořád je
  async clientState(d, parts) {
    const q = this.ctx.qbit;
    if (!q?.enabled || d.candidate?.protocol === 'usenet') return null;
    const hashes = parts.filter((x) => !GONE.has(x.state)).map((x) => String(x.downloadId || x.infoHash || '').toLowerCase())
      .filter((h) => /^[0-9a-f]{40}$/.test(h));
    try {
      if (!hashes.length) {
        await q.version();
        return { present: false, message: '' };
      }
      const list = await q.byHashes(hashes);
      const present = (list || []).length > 0;
      return { present, message: present ? t('download.client.present', { app: d.app === 'radarr' ? 'Radarr' : 'Sonarr' }) : '' };
    } catch (e) {
      return { down: true, message: t('download.client.down', { error: e.message }) };
    }
  }

  // Vynucený import ještě běží (první epizoda už je v knihovně, další se kopírují) – dokud neskončí, torrent
  // nepouštět: po "hotovo" by ho úklid smazal i se soubory, které se ještě nenaimportovaly
  async importRunning(d, part) {
    if (part.forceImportCmd == null) return false;
    try {
      const cmd = await this.client(d.app).get(`/command/${part.forceImportCmd}`);
      return ['queued', 'started'].includes(cmd?.status);
    } catch {
      return false; // příkaz už Radarr/Sonarr zapomněl (restart) – doběhl
    }
  }

  // Přestat sledovat ve frontě Radarru/Sonarru, torrent nechat v klientovi
  async dismiss(d, part, why) {
    const { store } = this.ctx;
    try {
      await this.client(d.app).removeFromQueue(part.queueId, { blocklist: false, removeFromClient: false });
    } catch (e) {
      store.log('warn', t('download.removeFailed', { label: d.label, error: e.message }));
      return;
    }
    part.state = 'dismissed';
    store.log('info', `${d.label}: ${why}`);
  }

  async forceImport(d, part) {
    const { store, notify } = this.ctx;
    part.forceImportAt = Date.now();
    const client = this.client(d.app);
    const downloadId = part.downloadId || part.queueDownloadId;
    const list = await client.manualImportList(downloadId);
    const unparsed = (f) => d.app === 'radarr' && reasons(f).some((r) => PARSE_REJECTION.test(r));
    let usable = list.filter((f) => {
      const rs = reasons(f);
      if (rs.length && !rs.every((r) => UPGRADE_REJECTION.test(r) || (unparsed(f) && PARSE_REJECTION.test(r)))) return false;
      if (d.app === 'radarr') return f.movie?.id === d.arrId && (!unparsed(f) || VIDEO_EXT.test(f.path));
      if (f.series?.id !== d.arrId || !f.episodes?.length) return false;
      // z balíku více sérií jen série, které nahrazujeme
      return !d.seasons || f.episodes.every((e) => d.seasons.includes(e.seasonNumber));
    });
    // U nerozparsovaného názvu nepoznáme ani ukázku (sample) – film je jen ten největší soubor
    if (usable.some(unparsed)) usable = [usable.reduce((a, f) => ((f.size || 0) > (a.size || 0) ? f : a))];
    if (!usable.length) {
      if (Object.keys(await this.changedTargets(d)).length) {
        if (await this.importRunning(d, part)) return;
        await this.dismiss(d, part, t('download.importedWhatCould'));
        return;
      }
      const why = [...new Set(list.flatMap(reasons))].join('; ') || t('download.noFiles');
      part.state = 'blocked';
      d.state = 'blocked';
      d.message = t('download.cannotForce', { why });
      store.log('warn', `${d.label}: ${d.message}`);
      if (!d.blockedNotified) {
        d.blockedNotified = true;
        notify.download(d, 'blocked').catch(() => {});
      }
      return;
    }
    const files = usable.map((f) => {
      // Kvalitu/jazyky, které Radarr z názvu nevyčetl, doplnit podle stahovaného release
      const quality = f.quality?.quality ? f.quality : d.candidate?.arr?.quality;
      const languages = f.languages?.length ? f.languages : d.candidate?.arr?.languages || [];
      const base = { path: f.path, quality, languages, releaseGroup: f.releaseGroup, downloadId, indexerFlags: f.indexerFlags || 0 };
      return d.app === 'radarr'
        ? { ...base, movieId: d.arrId }
        : { ...base, seriesId: d.arrId, episodeIds: f.episodes.map((e) => e.id), releaseType: f.releaseType };
    });
    const cmd = await client.command({ name: 'ManualImport', importMode: 'auto', files });
    part.forceImportCmd = cmd?.id ?? null;
    store.log('info', t('download.forcing', {
      label: d.label, app: d.app, count: files.length,
      seasons: d.seasons ? t('download.forcingSeasons', { seasons: S.formatSeasons(d.seasons), count: d.seasons.length }) : '',
    }));
  }

  // Selhání torrentu. U sady epizod se zablokuje jen ten jeden a zbytek běží dál (vrací false);
  // jinak skončí celé stahování (vrací true) a případně se stáhne další kandidát.
  async fail(d, reason, part) {
    const { store, notify } = this.ctx;
    if (!d.active) return true; // mezitím zrušeno – neblokovat release ani nestahovat náhradu
    const st = store.settings;
    const parts = this.partsOf(d);
    part ??= parts[0];
    if (part.queueId) {
      try { await this.client(d.app).removeFromQueue(part.queueId, { blocklist: true }); } catch (e) { store.log('warn', t('download.removeFailed', { label: d.label, error: e.message })); }
    }
    store.s.ignoredGuids[part.guid] = Date.now();
    part.state = 'failed';
    part.message = reason;
    if (parts.some((x) => x.state !== 'failed')) {
      store.log('warn', t('download.partBlocked', { label: d.label, title: part.title, reason }));
      return false;
    }

    store.s.ignoredGuids[d.guid] = Date.now();
    d.active = false;
    d.state = 'failed';
    d.finishedAt = Date.now();
    d.message = reason;
    store.log('warn', t('download.blocked', { label: d.label, reason }));

    const item = store.s.items[d.itemKey];
    if (item && st.retryOnStall && d.attempt < st.maxRetries) {
      try {
        const res = await searchItem(this.ctx, item, { reason: t('download.reason.replacement'), silent: true });
        const next = d.groupKey ? res.groupProposal : res.proposal;
        if (next) {
          const r = await this.ctx.grab(next.id, 0, { retryOf: d });
          d.replacedBy = r.id;
          // Původní návrh by jinak navždy visel jako „stahuje se“ (a nešel by odmítnout)
          const old = store.s.proposals[d.proposalId];
          if (old && old.id !== next.id && old.downloadId === d.id && old.status === 'grabbed') {
            Object.assign(old, { status: 'expired', note: `nahrazeno: ${reason}`, updatedAt: new Date().toISOString() });
          }
          if (d.first) await this.returnUncovered(d, r, reason);
          return true;
        }
        d.message += t('download.noAlternative');
      } catch (e) {
        d.message += t('download.replacementFailed', { error: e.message });
      }
    }
    if (d.first) await this.ctx.firstGrab.giveUp(d, t('download.giveUp.failed', { reason }));
    else reopenProposal(this.ctx, d, { dropGuid: d.guid, note: t('common.prevAttemptFailed', { reason }) });
    notify.download(d, 'failed').catch(() => {});
    return true;
  }
}

module.exports = { Downloads };

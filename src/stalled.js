// Zaseknuté torrenty v qBittorrentu (všechny kategorie, nejen Updaterr): kdo stojí bez spojení déle než
// `qbitStallMin`, ten se zastaví a označí štítkem, aby uvolnil místo ve frontě. Každých `qbitStallRetryMin`
// se zastavené znovu spustí – když mezitím přibyli seedeři, rozjedou se; jinak se po `qbitStallMin` zase zastaví.
// Vynucené (force start) a ručně zastavené torrenty se nechávají být.
const { t: tr } = require('./i18n');

const TAG = 'updaterr-stalled';
const STALLED = new Set(['stalledDL', 'metaDL']);
const STOPPED = new Set(['stoppedDL', 'pausedDL']);

const hasTag = (t) => String(t.tags || '').split(',').map((s) => s.trim()).includes(TAG);

/**
 * Rozhodne, co s torrenty udělat. `recs` = { [hash]: { name, since?, stoppedAt?, tries } } se upravuje na místě.
 * Vrací { stop: [t], start: [t], untag: [t] } a seznam událostí do logu.
 */
// `skip` = hashe (malými písmeny) stahování Updaterru: ta mají vlastní pravidlo pro mrtvé torrenty (stallHours,
// pak další kandidát) – zastavením by čas bez pokroku utíkal, aniž by torrent dostal šanci.
function plan(torrents, recs, { enabled, stallMin, retryMin, skip = new Set() }, now) {
  const out = { stop: [], start: [], untag: [], events: [] };
  const seen = new Set();
  for (const t of torrents) {
    seen.add(t.hash);
    const ours = hasTag(t);
    const rec = recs[t.hash];
    const done = Number(t.progress) >= 1;

    if (!enabled || done || skip.has(String(t.hash).toLowerCase())) {
      // Vypnuto, staženo nebo stahování Updaterru → vrátit do původního stavu
      if (ours) {
        if (STOPPED.has(t.state) && !done) out.start.push(t);
        out.untag.push(t);
      }
      delete recs[t.hash];
      continue;
    }

    if (STOPPED.has(t.state)) {
      if (!ours) { delete recs[t.hash]; continue; } // zastavil uživatel
      const r = recs[t.hash] ||= { name: t.name, stoppedAt: now, tries: 1 }; // štítek přežil ztrátu stavu
      // Po spuštění je stoppedAt pryč – když torrent pořád stojí (spuštění v qBittorrentu selhalo), počítá se od pokusu
      if (now - (r.stoppedAt ?? r.retriedAt ?? now) >= retryMin * 60e3) {
        out.start.push(t);
        r.retriedAt = now;
        delete r.stoppedAt;
        delete r.since;
      }
      continue;
    }

    if (STALLED.has(t.state)) {
      const r = recs[t.hash] ||= { name: t.name, tries: 0 };
      r.since ??= now;
      if (now - r.since >= stallMin * 60e3) {
        out.stop.push(t);
        r.stoppedAt = now;
        r.tries++;
        delete r.since;
        out.events.push(tr('stall.stopped', { name: t.name, min: stallMin, tries: r.tries > 1 ? ` (${r.tries}×)` : '', retry: retryMin }));
      }
      continue;
    }

    // Stahuje se, čeká ve frontě, kontroluje se… – fronta nebo vynucené stahování se za zaseknutí nepočítá
    if (rec) {
      delete rec.since;
      if (/^(downloading|forcedDL)$/.test(t.state) && Number(t.dlspeed) > 0) {
        if (rec.tries) out.events.push(tr('stall.resumed', { name: t.name }));
        delete recs[t.hash];
        if (ours) out.untag.push(t);
      }
    }
  }
  for (const h of Object.keys(recs)) if (!seen.has(h)) delete recs[h]; // torrent smazán
  return out;
}

class StallGuard {
  constructor(ctx) {
    this.ctx = ctx;
    this.qbit = ctx.qbit;
    this.tagSeen = true; // po startu jednou projít – štítky mohly zůstat z dřívějška
  }

  get recs() { return (this.ctx.store.s.qbitStalls ||= {}); }

  async tick() {
    const { store } = this.ctx;
    const st = store.settings;
    if (!this.qbit.enabled) return;
    // Vypnuto a nic nezastavené → ani se neptat
    if (!st.qbitStopStalled && !Object.keys(this.recs).length && !this.tagSeen) return;
    const list = (await this.qbit.req('torrents/info')) || [];
    this.tagSeen = list.some(hasTag);
    const p = plan(list, this.recs, { enabled: st.qbitStopStalled, stallMin: st.qbitStallMin, retryMin: st.qbitStallRetryMin, skip: this.ownHashes() }, Date.now());
    const hashes = (ts) => ts.map((t) => t.hash).join('|');
    if (p.stop.length) {
      await this.qbit.addTags(hashes(p.stop), TAG);
      await this.qbit.stop(hashes(p.stop));
    }
    if (p.start.length) {
      await this.qbit.start(hashes(p.start));
      store.log('info', tr('stall.restarted', { count: p.start.length }));
    }
    if (p.untag.length) await this.qbit.removeTags(hashes(p.untag), TAG);
    for (const e of p.events) store.log('info', `qBittorrent: ${e}`);
    store.save();
  }

  // Torrenty, které hlídá Updaterr sám (stahování upgradů a donory pro sloučení)
  ownHashes() {
    const { downloads, merger } = this.ctx;
    const hashes = [
      ...(downloads?.active() || []).flatMap((d) => downloads.partsOf(d).map((x) => x.downloadId)),
      ...(merger?.active() || []).map((j) => j.hash),
    ];
    return new Set(hashes.filter(Boolean).map((h) => String(h).toLowerCase()));
  }

  // Přehled pro UI
  summary() {
    const r = Object.values(this.recs);
    return { stopped: r.filter((x) => x.stoppedAt).length, watching: r.filter((x) => x.since).length };
  }
}

module.exports = { StallGuard, plan, TAG };

// Ověření jazyka "poslechem": porovná značky zvukových stop s rozpoznanou řečí a výsledek uloží k položce
// (item.langCheck). Platí jen pro soubory, na kterých se ověřovalo – po výměně souboru se zahodí.
const L = require('./lang');
const S = require('./speech');
const A = require('./audio');

const sameIds = (a, b) => JSON.stringify([...(a || [])].sort((x, y) => x - y)) === JSON.stringify([...(b || [])].sort((x, y) => x - y));
const LANGS = require('./languages');
const I18N = require('./i18n');

// Jazyk → značka stopy pro log a UI ("cs" → "cze")
const tagOut = (l) => (l === 'other' ? '?' : LANGS.tagOf(l));
const tierText = (tier, item) => L.tierText(tier, item.origLang);

// Položka ještě není ověřená (pro tyhle soubory)
const unverified = (item) => !item.missing && (!item.langCheck || !sameIds(item.langCheck.fileIds, item.current?.fileIds));

// Ověření zapnuté a k dispozici, a položka ještě není ověřená
function needsCheck(ctx, item) {
  return Boolean(ctx.store.settings.verifySpeech && S.available() && unverified(item));
}

// Použít uložené ověření na aktuální stav položky (volá se po každém načtení knihovny)
// Úroveň souboru z jazyků stop podle poslechu – vždy podle aktuálně nastavených jazyků (po jejich změně
// by uložená úroveň z doby ověření neplatila); u série nejslabší ze slyšených souborů
function heardTier(lc, origLang) {
  const tiers = (lc.files || []).filter((f) => f.tracks?.length).map((f) => {
    const used = f.tracks.map((x) => x.used).filter(Boolean);
    return L.tierOf({ pri: used.includes(L.primary()), sec: used.includes(L.secondary()) }, origLang);
  });
  return tiers.length ? Math.min(...tiers) : lc.tier;
}

function applyLangCheck(item) {
  const lc = item.langCheck;
  if (!lc || !item.current) return item;
  if (!sameIds(lc.fileIds, item.current.fileIds)) {
    delete item.langCheck;
    return item;
  }
  if (lc.error) return item;
  item.current.verified = true;
  if (lc.corrected) {
    item.current.tagAudio = item.current.audio;
    item.current.tagTier = item.current.tier;
    item.current.tier = heardTier(lc, item.origLang);
    item.current.audio = lc.audio;
    item.current.audioSource = 'poslech';
  }
  return item;
}

const labelOf = (item) => require('./search').itemLabel(item);

// Soubory k ověření: film celý, u série nejvýš 3 epizody (první, prostřední, poslední)
async function filesFor(ctx, item) {
  if (item.app === 'radarr') {
    const m = await ctx.radarr.get(`/movie/${item.arrId}`);
    return m.movieFile ? [{ id: m.movieFile.id, path: m.movieFile.path }] : [];
  }
  const files = (await ctx.sonarr.get('/episodefile', { seriesId: item.arrId }))
    .filter((f) => f.seasonNumber === item.season)
    .sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath)));
  const pick = [...new Set([0, Math.floor(files.length / 2), files.length - 1])].filter((i) => files[i]);
  return pick.map((i) => ({ id: files[i].id, path: files[i].path }));
}

// Whisper na GPU a velikost modelu podle nastavení
const speechOpts = (settings) => ({ gpu: Boolean(settings.useGpu), model: settings.speechModel || 'base' });

async function checkFile(file, origLang, opts = {}) {
  const p = await A.probe(file.path);
  const tracks = [];
  for (const t of p.audio.slice(0, S.MAX_TRACKS)) {
    const det = await S.detectStream(p.file, t.index, { duration: p.duration, startTime: p.startTime, ...opts });
    const r = S.reconcile(t.lang || null, det, origLang);
    tracks.push({
      index: t.index, title: t.title || '', tag: t.lang || null,
      detected: det.lang, confidence: det.confidence, samples: det.samples,
      used: r.lang, corrected: r.corrected, ...(r.doubtful ? { doubtful: true } : {}),
    });
  }
  const used = tracks.map((t) => t.used).filter(Boolean);
  const tier = L.tierOf({ pri: used.includes(L.primary()), sec: used.includes(L.secondary()) }, origLang);
  return { id: file.id, name: file.path.split('/').pop(), tier, tracks, audio: used.map(tagOut).join('/') || '?' };
}

/**
 * Ověří položku poslechem a uloží výsledek. Vrací { changed, before, after, langCheck }.
 * `changed` = úroveň jazyka se oproti značkám změnila.
 */
async function verify(ctx, item, { reason = I18N.t('langcheck.reason.verify') } = {}) {
  const { store } = ctx;
  const files = await filesFor(ctx, item);
  if (!files.length) return { changed: false };
  const label = labelOf(item);
  const t0 = Date.now();
  const results = [];
  for (const f of files) results.push(await checkFile(f, item.origLang, speechOpts(store.settings)));

  const fresh = store.s.items[item.key] || item;
  // Poslech trvá minuty – mezitím se soubor mohl vyměnit; výsledek starého souboru k novému nepřipisovat
  const ids = new Set((fresh.current?.fileIds || []).map(String));
  if (!results.every((r) => ids.has(String(r.id)))) {
    store.log('info', I18N.t('langcheck.fileChanged', { label, reason }));
    return { changed: false };
  }
  const before = fresh.current.tagTier ?? fresh.current.tier;
  const corrected = results.some((r) => r.tracks.some((t) => t.corrected));
  fresh.langCheck = {
    fileIds: fresh.current.fileIds,
    at: new Date().toISOString(),
    corrected,
    tier: Math.min(...results.map((r) => r.tier)),
    audio: [...new Set(results.map((r) => r.audio))].join(' | '),
    sampled: results.length,
    files: results,
    ms: Date.now() - t0,
  };
  // Znovu spočítat aktuální stav ze značek a ověření použít
  if (fresh.current.tagAudio) {
    fresh.current.audio = fresh.current.tagAudio;
    fresh.current.tier = fresh.current.tagTier;
    delete fresh.current.tagAudio;
    delete fresh.current.tagTier;
    if (fresh.current.audioSource === 'poslech') fresh.current.audioSource = 'mediainfo';
  }
  applyLangCheck(fresh);
  const after = fresh.current.tier;

  // Stopy, kde poslech značce odporuje, ale ne jistě (blízké jazyky, např. CZ × SK) – neopravuje se, jen upozornit
  const doubts = [...new Set(results.flatMap((r) => r.tracks.filter((t) => t.doubtful).map((t) => I18N.t('langcheck.doubtTrack', { tag: t.tag ? tagOut(t.tag) : I18N.t('langcheck.noTag'), heard: tagOut(t.detected) || t.detected }))))];
  if (doubts.length) store.log('warn', I18N.t('langcheck.doubtful', { label, tracks: doubts.join(', '), lang: L.label(L.primary()), reason }));
  const fixes = results.flatMap((r) => r.tracks.filter((t) => t.corrected).map((t) => `${t.tag ? tagOut(t.tag) : I18N.t('langcheck.noTag')} → ${tagOut(t.used)}`));
  store.log(corrected ? 'warn' : 'info', corrected
    ? I18N.t('langcheck.mislabeled', { label, fixes: [...new Set(fixes)].join(', '), actual: tierText(after, fresh), reason })
    : I18N.t('langcheck.tagsOk', { label, audio: fresh.langCheck.audio, reason }));
  store.save();
  return { changed: before !== after, before, after, langCheck: fresh.langCheck };
}

// Návrh po ověření: nechat jen kandidáty, kteří jsou pořád lepší
function prune(ctx, p, item, { note } = {}) {
  const st = ctx.store.settings;
  const cur = item.current;
  const { neededLang } = require('./merge');
  const want = require('./watch').wantOf(ctx.store, item);
  const need = neededLang(item, want);
  const sc = (t) => L.wantScore(t, want, item.origLang);
  const wantCodec = require('./codec').wantRank(require('./watch').codecOf(ctx.store, item));
  const codecBetter = (c) => wantCodec != null && cur.vcodec != null && cur.vcodec < wantCodec && c.vcodec != null && c.vcodec >= wantCodec
    && sc(c.tier) >= sc(cur.tier) && c.res >= cur.res;
  const keep = (p.candidates || []).filter((c) => (c.kind === 'merge'
    ? c.mergeLang === need
    // Oprava useknutého souboru: stejný jazyk stačí, dokud je soubor pořád useknutý
    : (c.kind === 'repair' && cur.truncated && sc(c.tier) >= sc(cur.tier)) || sc(c.tier) > sc(cur.tier) || codecBetter(c) || (st.qualityUpgrades && c.tier === cur.tier && c.res > cur.res)));
  const removed = (p.candidates || []).length - keep.length;
  p.candidates = keep;
  p.current = { ...cur };
  if (!keep.length) {
    p.status = 'expired';
    p.note = note || I18N.t('langcheck.note.alreadyHas', { tier: tierText(cur.tier, item) });
  }
  p.updatedAt = new Date().toISOString();
  return removed;
}

// Prázdná fronta hromadného poslechu (Knihovna → Poslechnout vše)
const EMPTY_QUEUE = () => ({ items: [], total: 0, corrected: 0, failed: 0, startedAt: null });

// Na pozadí: ověřit položky čekajících návrhů, které vznikly bez ověření, a pak frontu hromadného poslechu
class LangChecker {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = false;
    this.current = null;
    this.verify = verify;
    if (!ctx.store.s.langQueue?.items) ctx.store.s.langQueue = EMPTY_QUEUE();
  }

  get queue() { return this.ctx.store.s.langQueue; }

  /**
   * Zařadit položky do hromadného poslechu. `force` = poslechnout znovu i už ověřené
   * (třeba po přechodu na přesnější model). Vrací počet nově zařazených.
   */
  enqueueAll(keys, { force = false } = {}) {
    const q = this.queue;
    if (!q.items.length) Object.assign(q, EMPTY_QUEUE(), { startedAt: new Date().toISOString() });
    const have = new Set(q.items.map((e) => e.key));
    const add = keys.filter((k) => !have.has(k)).map((key) => (force ? { key, force: true } : { key }));
    q.items.push(...add);
    q.total += add.length;
    this.ctx.store.save();
    return add.length;
  }

  cancel() {
    const left = this.queue.items.length;
    this.ctx.store.s.langQueue = EMPTY_QUEUE();
    this.ctx.store.save();
    return left;
  }

  status() {
    const q = this.queue;
    const cur = this.current && this.ctx.store.s.items[this.current];
    return {
      queued: q.items.length, total: q.total, done: q.total - q.items.length, corrected: q.corrected, failed: q.failed,
      current: cur ? labelOf(cur) : null,
    };
  }

  // Další položka z fronty: co mezitím zmizelo nebo se ověřilo jinak, vypadne; položky, které se právě
  // stahují nebo slučují, počkají
  nextQueued() {
    const { store } = this.ctx;
    const q = this.queue;
    q.items = q.items.filter((e) => store.s.items[e.key] && (e.force || unverified(store.s.items[e.key])));
    const busy = this.ctx.busyKeys();
    return q.items.find((e) => !busy.has(e.key)) || null;
  }

  async tick() {
    const { store, searcher } = this.ctx;
    if (this.running || this.current || searcher.busy || !S.available()) return;
    const p = store.settings.verifySpeech && Object.values(store.s.proposals).find((x) => x.status === 'pending' && !x.groupKey
      && store.s.items[x.itemKey] && needsCheck(this.ctx, store.s.items[x.itemKey])
      && !this.ctx.busyKeys().has(x.itemKey));
    if (p) return this.check(store.s.items[p.itemKey], I18N.t('langcheck.reason.pending'));
    const had = this.queue.items.length;
    const e = this.nextQueued();
    if (e) {
      await this.check(store.s.items[e.key], I18N.t('langcheck.reason.library'), e);
      // další hned, ať hromadný poslech netrvá zbytečně dlouho (hledání má pořád přednost)
      if (this.queue.items.length) setTimeout(() => this.tick().catch((err) => store.log('error', err.message)), 1000).unref?.();
    } else if (had && !this.queue.items.length) {
      this.finished();
    }
  }

  async check(item, reason, entry = null) {
    const { store } = this.ctx;
    this.running = true;
    this.current = item.key;
    try {
      const r = await this.verify(this.ctx, item, { reason });
      const fresh = store.s.items[item.key] || item;
      if (r.changed) {
        for (const p of Object.values(store.s.proposals)) {
          if (p.status === 'pending' && !p.groupKey && p.itemKey === item.key) prune(this.ctx, p, fresh);
        }
        // poslech odhalil horší jazyk, než tvrdily značky → hledat upgrade co nejdřív
        if (r.after < r.before) fresh.lastSearchedAt = null;
      }
      if (entry && r.langCheck?.corrected) this.queue.corrected++;
    } catch (e) {
      // ať se to nezkouší pořád dokola – poznamenat neúspěch k souborům
      item.langCheck = { fileIds: item.current.fileIds, at: new Date().toISOString(), error: e.message, corrected: false };
      store.log('warn', I18N.t('search.langCheckFailed', { label: item.title, error: e.message }));
      if (entry) this.queue.failed++;
    } finally {
      if (entry) {
        const i = this.queue.items.indexOf(entry);
        if (i >= 0) this.queue.items.splice(i, 1);
        if (!this.queue.items.length) this.finished();
      }
      this.running = false;
      this.current = null;
      store.save();
    }
  }

  finished() {
    const q = this.queue;
    if (!q.total) return;
    const text = I18N.t('langcheck.queue.items', { count: q.total })
      + (q.corrected ? I18N.t('langcheck.queue.corrected', { count: q.corrected }) : I18N.t('langcheck.queue.allOk'))
      + (q.failed ? I18N.t('langcheck.queue.failed', { count: q.failed }) : '');
    this.ctx.store.log(q.corrected || q.failed ? 'warn' : 'info', I18N.t('langcheck.queue.doneLog', { text }));
    this.ctx.inbox?.add({ kind: 'langcheck', level: q.corrected || q.failed ? 'warn' : 'ok', title: I18N.t('langcheck.queue.doneTitle'), text, link: { tab: 'library' } });
    this.ctx.store.s.langQueue = EMPTY_QUEUE();
    this.ctx.store.save();
  }
}

module.exports = { speechOpts, needsCheck, unverified, applyLangCheck, heardTier, verify, prune, LangChecker, sameIds };

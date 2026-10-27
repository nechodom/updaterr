// Slučování zvukových stop: místo výměny celého souboru stáhne "donor" release s chybějícím jazykem,
// ověří podle skutečných zvukových stop, že ten jazyk obsahuje, změří synchronizaci proti stávajícímu
// souboru a stopu přidá (mkvmerge). Výsledek znovu ověří a naimportuje přes Radarr/Sonarr.
// Video i ostatní stopy zůstávají ze stávajícího souboru (např. 4K EN + CZ zvuk z 1080p releasu).
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lang');
const S = require('./speech');
const A = require('./audio');
const { newId, stagingFor } = require('./store');
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

// Radarr/Sonarr běží pod stejným uživatelem jako Updaterr: když tu do složky knihovny nejde zapisovat,
// import by původní soubor nenahradil (UnauthorizedAccessException) a výsledek by zůstal ležet ve stagingu
function assertReplaceable(file) {
  const dir = path.dirname(file);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    let owner = '';
    try { owner = I18N.t('merge.err.dirOwner', { uid: fs.statSync(dir).uid }); } catch { /* složka chybí */ }
    throw new Error(I18N.t('merge.err.notWritable', { dir, owner, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }));
  }
}

// „25.000 → 23.976 fps“; když rychlost z fps nevychází (odvozená z nárůstu posunu), změna tempa v %
function speedText(speed, fps = {}) {
  if (fps.donor && fps.target && Math.abs(fps.donor / fps.target / speed - 1) < 0.003) return `${fps.donor.toFixed(3)} → ${fps.target.toFixed(3)} fps`;
  return I18N.t('merge.tempo', { sign: speed > 1 ? '−' : '+', pct: (Math.abs(1 / speed - 1) * 100).toFixed(1) });
}

// Poznámka k výsledku sloučení (UI, log): jak se zvuk donoru přepočítal
function retimeNote(speed, fps, pitch) {
  const p = Math.abs(speed - 1) <= 0.02 ? ''
    : I18N.t(pitch?.raised ? 'merge.pitch.restored' : pitch?.raised === false ? 'merge.pitch.same' : 'merge.pitch.unknown');
  return I18N.t('merge.retimed', { speed: speedText(speed, fps), pitch: p });
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

// --- Nevhodné donory (state.badDonors) ------------------------------------------------------------
// Torrent, se kterým sloučení neprošlo (nesedí synchronizace, jiná fps nebo délka, chybí stopa, mrtvý),
// se znovu nestahuje. Pozná se i pod jiným GUID (jiný indexer, magnet místo stránky): podle info hashe
// a u stejné položky podle názvu bez interpunkce. U seriálu stačí, že neprošla část epizod.
const normTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function releaseHash(r) {
  if (/^[0-9a-f]{40}$/i.test(r?.infoHash || '')) return r.infoHash.toLowerCase();
  for (const s of [r?.magnetUrl, r?.guid, r?.downloadUrl]) {
    const m = String(s || '').match(/(?:^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function badDonorOf(store, itemKey, r) {
  const hash = releaseHash(r);
  const norm = normTitle(r.title);
  return Object.values(store.s.badDonors || {}).find((b) => (hash && b.hashes.includes(hash)) || b.guids.includes(r.guid) ||
    (itemKey && b.itemKey === itemKey && norm && b.norm === norm)) || null;
}

// into = známý záznam: jen k němu přidat další GUID / hash (stejný torrent pod jiným názvem), bez počítání pokusu
// code = proč neprošel (failureCode): 'length' (jiná délka – jiný střih), 'sync', 'verify', 'track', 'episode'…
// Podle kódu se rozhoduje (jiná verze filmu, nabídnout znovu po přepočtu tempa) – text důvodu je jen pro lidi.
function rememberBadDonor(store, j, reason, { into = null, code = null, lengthMin = null } = {}) {
  store.s.badDonors ||= {};
  const norm = normTitle(j.title);
  const id = into?.id || require('node:crypto').createHash('sha1').update(`${j.itemKey}|${norm}`).digest('hex').slice(0, 12);
  const b = store.s.badDonors[id] ||= { id, itemKey: j.itemKey, label: j.label, title: j.title, norm, hashes: [], guids: [], jobs: [] };
  for (const h of [j.hash?.toLowerCase(), releaseHash(j.candidate || {})]) if (h && !b.hashes.includes(h)) b.hashes.push(h);
  if (j.guid && !b.guids.includes(j.guid)) b.guids.push(j.guid);
  if (!into && !b.jobs.includes(j.id)) {
    b.jobs.push(j.id);
    b.reason = reason;
    b.code = code || null;
    b.lengthMin = lengthMin ?? null;
    b.at = j.finishedAt || Date.now();
  }
  return b;
}

// Z čekajících návrhů vyhodit kandidáty na sloučení, kteří už jednou neprošli
function pruneBadDonorCandidates(store) {
  let n = 0;
  for (const p of Object.values(store.s.proposals || {})) {
    if (p.status !== 'pending') continue;
    const keep = (p.candidates || []).filter((c) => c.kind !== 'merge' || !(c.set ? c.parts : [c]).some((x) => badDonorOf(store, p.itemKey, x)));
    if (keep.length === (p.candidates || []).length) continue;
    n += p.candidates.length - keep.length;
    p.candidates = keep;
    if (!keep.length) p.status = 'expired';
    p.updatedAt = new Date().toISOString();
  }
  return n;
}

// Jednorázově z historie: neúspěšná sloučení (s blokovaným GUID = selhání torrentu, ne např. málo místa)
// a hotová sloučení, kde část epizod neprošla
function backfillBadDonors(store) {
  if (store.s.badDonorsBackfilled) return 0;
  let n = 0;
  const jobs = Object.values(store.s.merges || {}).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  for (const j of jobs) {
    if (j.active) continue;
    const failedParts = (j.results || []).filter((r) => !r.ok);
    let reason = null;
    if (j.state === 'failed' && store.s.ignoredGuids[j.guid]) reason = String(j.message || 'selhalo').split(' · ')[0];
    else if (j.state === 'done' && failedParts.length) reason = partialReason(failedParts, j.results.length);
    if (!reason) continue;
    rememberBadDonor(store, j, reason);
    n++;
  }
  store.s.badDonorsBackfilled = true;
  return n;
}

// Chyba, za kterou může donor (nesedí synchronizace, fps, délka, chybí stopa) – jen kvůli takové se donor
// zablokuje a zapamatuje jako nevhodný. Místní potíže (timeout ffmpeg, plný disk, mkvmerge) donor nevylučují.
//   mismatch – release je v pořádku, jen nesedí k tomuhle souboru (jiný střih, fps, synchronizace): jako
//   výměna celého souboru se nabízet dál smí, blokuje se jen pro přidání zvuku (badDonors)
//   code – druh chyby (badDonorCode), lengthMin – o kolik minut se liší délka (jiný střih)
const donorError = (msg, { mismatch = false, code = null, lengthMin = null } = {}) => Object.assign(new Error(msg), { donor: true, mismatch, code, lengthMin });
const MISMATCH_CODES = new Set(['length', 'fps', 'sync', 'verify']);

// Druh chyby záznamu nevhodného donoru. Starší záznamy (z doby před kódy) mají jen český text důvodu.
function badDonorCode(b) {
  if (!b) return null;
  if (b.code) return b.code;
  const r = String(b.reason || '');
  if (/délka se liší|jiná verze filmu/.test(r)) return 'length';
  if (/jiná snímková frekvence|posun postupně narůstá/.test(r)) return 'fps';
  if (/kontrola výsledku: stopy nesedí/.test(r)) return 'verify';
  if (/nesedí synchronizace/.test(r)) return 'sync';
  return null;
}
// O kolik minut se délka donoru liší od stávajícího souboru (jen u code 'length'), jinak null
function badDonorLengthMin(b) {
  if (badDonorCode(b) !== 'length') return null;
  return b.lengthMin ?? (Number(String(b.reason || '').match(/(\d+) min/)?.[1]) || null);
}
// Společný druh chyby výsledků (sloučení všech epizod) pro rememberBadDonor
function failureCode(results) {
  const failed = results.filter((r) => !r.ok);
  const codes = [...new Set(failed.map((r) => r.code || null))];
  return { code: codes.length === 1 ? codes[0] : null, lengthMin: failed.find((r) => r.lengthMin)?.lengthMin ?? null };
}

// Jednorázově: dřív se releasy, které jen nesedí ke stávajícímu souboru, blokovaly úplně (ignoredGuids) –
// pak se nenabízely ani jako výměna celého souboru, kde jiný střih nevadí. Vrací klíče dotčených položek.
function unblockMismatchedDonors(store) {
  if (store.s.mismatchUnblocked) return [];
  const keys = new Set();
  for (const b of Object.values(store.s.badDonors || {})) {
    if (!MISMATCH_CODES.has(badDonorCode(b))) continue;
    for (const g of b.guids) if (store.s.ignoredGuids[g]) { delete store.s.ignoredGuids[g]; keys.add(b.itemKey); }
  }
  store.s.mismatchUnblocked = true;
  return [...keys];
}

// Jednorázově: dřív se donor s jinou rychlostí (PAL 25 vs 23,976 fps, postupně narůstající posun) odmítal –
// dnes se jeho zvuk přepočítá. Takové donory zapomenout, ať se znovu nabídnou k přidání zvuku. Vrací klíče položek.
function unblockRetimableDonors(store) {
  if (store.s.retimeUnblocked) return [];
  const keys = new Set();
  for (const [id, b] of Object.entries(store.s.badDonors || {})) {
    if (badDonorCode(b) !== 'fps') continue;
    for (const g of b.guids) delete store.s.ignoredGuids[g];
    delete store.s.badDonors[id];
    keys.add(b.itemKey);
  }
  store.s.retimeUnblocked = true;
  return [...keys];
}

// Zvuková stopa z ffprobe → ID stopy v mkvmerge. Pořadí bývá stejné, ale jistota to není (mkvmerge
// u některých kontejnerů stopy řadí jinak) – jazyk, počet kanálů a kodek musí sedět, jinak by se přidala
// nebo přeznačila jiná stopa. null = stopu nejde jednoznačně určit.
function mkvAudioId(mkv, a) {
  const audio = (mkv?.tracks || []).filter((x) => x.type === 'audio');
  const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fits = (x) => {
    const p = x.properties || {};
    if (p.audio_channels != null && a.channels != null && Number(p.audio_channels) !== Number(a.channels)) return false;
    const ml = L.normLangCode(p.language);
    const al = a.from === 'tag' ? a.lang : null;
    if (ml && al && ml !== al) return false;
    const mc = norm(x.codec);
    const fc = norm(a.codec);
    return !mc || !fc || mc.startsWith(fc) || fc.startsWith(mc);
  };
  const byIndex = audio[a.audioIndex];
  if (byIndex && fits(byIndex)) return byIndex.id;
  const any = audio.filter(fits);
  return any.length === 1 ? any[0].id : null;
}

function partialReason(failed, total) {
  return I18N.t('merge.partialReason', { count: failed.length, total, reasons: [...new Set(failed.map((r) => r.reason))].join('; ') });
}

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
  if (!st.mergeEnabled || !ctx.qbit?.enabled || !stagingFor(st, item.app)) return [];
  if (!L.audioVerified(item.current)) return []; // stávající jazyk musí být ověřený ze stop nebo poslechem
  if (item.current.truncated) return []; // useknutý/poškozený soubor – zvuk se k němu nepřidává, nabídne se jen náhrada
  const need = neededLang(item, require('./watch').wantOf(ctx.store, item));
  if (!need) return [];
  const maxGB = item.app === 'radarr' ? st.mergeMaxDonorGB : st.maxEpisodeSizeGB * Math.max(1, item.current.files || 1);
  const out = [];
  for (const r of releases) {
    if (r.protocol === 'usenet') continue;
    if (item.app === 'sonarr' && (!r.fullSeason || (r.seasonNumber != null && r.seasonNumber !== item.season))) continue;
    if (ctx.store.s.ignoredGuids[r.guid] || badDonorOf(ctx.store, item.key, r)) continue;
    if (h.rejectionsOf(r).some((x) => h.HARD_REJECT.test(x))) continue;
    if (L.JUNK_RE.test(r.title) || /cam|telesync|telecine|workprint|dvdscr/i.test(r.quality?.quality?.source || '')) continue;
    const seeders = Number(r.seeders) || 0;
    if (seeders < st.minSeeders) continue;
    if ((r.size || 0) / 1024 ** 3 > maxGB) continue;
    const lang = L.evaluateRelease(r.title, { origLang: item.origLang, arrLangs: r.languages, localIndexer: h.isLocalIndexer(r.indexer, st) });
    if (!lang[need === L.primary() ? 'pri' : 'sec'] || lang.confidence === 'guess') continue;
    const dual = lang.pri && lang.sec;
    const otherCut = item.app === 'radarr' ? L.editionWarning(item.current.sceneName, r.title) : null;
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
      warnings: [...(otherCut ? [I18N.t('merge.warn.otherCut', { edition: otherCut })] : []), ...(seeders < st.minSeeders * 3 ? [I18N.t('search.warn.lowSeeds')] : [])],
      otherCut: Boolean(otherCut),
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
  // Napřed donory stejné verze filmu (Extended k Extended) – jiný střih sloučit nejde
  const cut = (a, b) => Number(a.otherCut) - Number(b.otherCut);
  out.sort(st.mergeSaveData
    ? (a, b) => cut(a, b) || conf[b.confidence] - conf[a.confidence] || size(a) - size(b) ||
      Number(b.dualDonor) - Number(a.dualDonor) || seeds(b) - seeds(a) || a.size - b.size
    : (a, b) => cut(a, b) || Number(b.dualDonor) - Number(a.dualDonor) || conf[b.confidence] - conf[a.confidence] ||
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
    const store = ctx.store;
    store.s.badDonors ||= {};
    const n = backfillBadDonors(store);
    if (n) {
      const pruned = pruneBadDonorCandidates(store);
      store.log('info', I18N.t('merge.badDonors.backfilled', { count: Object.keys(store.s.badDonors).length, jobs: n, pruned: pruned ? I18N.t('merge.badDonors.pruned', { count: pruned }) : '' }));
    }
    const unblocked = unblockMismatchedDonors(store);
    if (unblocked.length) {
      for (const k of unblocked) if (store.s.items[k]) ctx.searcher?.enqueue(k, { reason: I18N.t('merge.reason.otherCut') });
      store.log('info', I18N.t('merge.badDonors.mismatchUnblocked', { count: unblocked.length }));
      store.save();
    }
    const retimable = unblockRetimableDonors(store);
    if (retimable.length) {
      for (const k of retimable) if (store.s.items[k]) ctx.searcher?.enqueue(k, { reason: I18N.t('merge.reason.retime') });
      store.log('info', I18N.t('merge.badDonors.retimeUnblocked', { count: retimable.length }));
      store.save();
    }
  }

  badDonorsOf(itemKey) {
    return Object.values(this.ctx.store.s.badDonors).filter((b) => b.itemKey === itemKey).sort((a, b) => b.at - a.at)
      .map((b) => ({ id: b.id, title: b.title, reason: b.reason, code: badDonorCode(b), at: b.at, times: b.jobs.length }));
  }

  // retry = rovnou přehledat položku, ať se „Přidat zvuk“ s tímhle donorem nabídne hned (tlačítko v návrhu)
  forgetBadDonor(id, { retry = false } = {}) {
    const { store } = this.ctx;
    const b = store.s.badDonors[id];
    if (!b) throw Object.assign(new Error(I18N.t('merge.err.noRecord')), { status: 404 });
    delete store.s.badDonors[id];
    for (const g of b.guids) delete store.s.ignoredGuids[g];
    if (retry && store.s.items[b.itemKey]) this.ctx.searcher?.enqueue(b.itemKey, { reason: I18N.t('merge.reason.retryAudio') });
    store.log('info', I18N.t(retry ? 'merge.badDonors.forgotRetry' : 'merge.badDonors.forgot', { label: b.label, title: b.title }));
    store.save();
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
    // Návrh mohl vzniknout před změnou nastavení – staging musí existovat pro aplikaci položky
    const staging = stagingFor(st, item.app);
    if (!staging) throw new Error(I18N.t('err.noStagingDir'));
    // I oprava synchronizace a jiný právě schvalovaný návrh – dvě úlohy by přepisovaly tentýž soubor
    const busy = this.ctx.busyKeys
      ? this.ctx.busyKeys({ except: proposalId })
      : new Set([...this.ctx.downloads.active().flatMap((d) => d.itemKeys || [d.itemKey]), ...this.active().map((j) => j.itemKey)]);
    if (busy.has(item.key)) throw new Error(I18N.t('err.itemBusy'));
    let cand = p.candidates?.[idx];
    if (!cand || cand.kind !== 'merge') throw new Error(I18N.t('err.candidateNotFound'));
    for (const x of cand.set ? cand.parts : [cand]) {
      const bad = badDonorOf(store, item.key, x);
      if (bad) throw new Error(I18N.t(cand.set ? 'merge.err.badPart' : 'merge.err.badDonor', { title: x.title, reason: bad.reason }));
    }

    if (cand.set) {
      if (Date.now() - (p.searchedAt || 0) > FRESH_MS || cand.parts.some((x) => !x.downloadUrl && !x.magnetUrl)) {
        cand = await this.refreshSet(p, idx, item);
      }
      return this.startSet(p, idx, item, cand, { auto, retryOf });
    }

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
    const dir = path.join(staging, id);
    fs.mkdirSync(path.join(dir, 'donor'), { recursive: true });
    try {
      await this.qbit.ensureCategory(st.qbitCategory, staging);
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

  // Sada torrentů epizod: ověřit, že všechny pořád žijí, a vzít čerstvé odkazy na torrenty
  async refreshSet(p, idx, item) {
    const { store } = this.ctx;
    let cand = p.candidates[idx];
    store.log('info', I18N.t('merge.set.checking', { label: p.label, count: cand.parts.length }));
    store.countSearch();
    const releases = await this.ctx.sonarr.searchReleases({ seriesId: item.arrId, seasonNumber: item.season });
    const parts = cand.parts.map((x) => {
      const r = releases.find((y) => y.guid === x.guid) || releases.find((y) => y.indexerId === x.indexerId && y.title === x.title);
      if (!r) throw new Error(I18N.t('merge.set.gone', { title: x.title }));
      return { ...x, seeders: Number(r.seeders) || 0, downloadUrl: r.downloadUrl || null, magnetUrl: r.magnetUrl || null, infoHash: r.infoHash || x.infoHash || null };
    });
    cand = { ...cand, parts, seeders: Math.min(...parts.map((x) => x.seeders)) };
    p.candidates[idx] = cand;
    p.searchedAt = Date.now();
    const dead = parts.find((x) => x.seeders < this.st.minSeeders);
    if (dead) throw new Error(I18N.t('merge.set.dead', { title: dead.title, seeders: dead.seeders }));
    return cand;
  }

  // Úloha s víc torrenty (jeden na epizodu): každý do vlastní složky a s vlastním štítkem
  async startSet(p, idx, item, cand, { auto, retryOf }) {
    const { store, notify } = this.ctx;
    const st = this.st;
    const episodeNumbers = (await this.targets({ itemKey: item.key, app: item.app, arrId: item.arrId, season: item.season, need: cand.mergeLang }))
      .flatMap((t) => t.episodeNumbers);
    const id = newId();
    const dir = path.join(stagingFor(st, item.app), id);
    const parts = cand.parts.map((x, i) => ({
      guid: x.guid, indexerId: x.indexerId, title: x.title, infoHash: x.infoHash, episodes: x.episodes, dualDonor: x.dualDonor,
      tag: `ujob-${id}-${i + 1}`, dir: path.join(dir, 'donor', String(i + 1)), progress: 0,
    }));
    const added = [];
    try {
      await this.qbit.ensureCategory(st.qbitCategory, stagingFor(st, item.app));
      for (const [i, x] of parts.entries()) {
        fs.mkdirSync(x.dir, { recursive: true });
        await this.qbit.add({
          downloadUrl: cand.parts[i].downloadUrl, magnetUrl: cand.parts[i].magnetUrl,
          savepath: x.dir, category: st.qbitCategory, tags: `updaterr,ujob-${id},${x.tag}`,
        }).catch((e) => { throw new Error(`“${x.title}”: ${e.message}`); });
        added.push(x);
      }
    } catch (e) {
      // Už přidané torrenty sady nenechat v qBittorrentu jako sirotky
      for (const x of added) {
        const t = await this.qbit.byTag(x.tag).catch(() => null);
        if (t) await this.qbit.delete(t.hash, true).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const j = {
      id, type: 'merge',
      itemKey: item.key, proposalId: p.id, label: p.label, app: item.app, arrId: item.arrId, season: item.season,
      title: cand.title, guid: cand.guid, candidate: cand, need: cand.mergeLang, dir, parts,
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
    this.log(j, 'info', I18N.t('merge.set.grabbed', { count: parts.length, indexer: cand.indexer, seeders: cand.seeders, auto: auto ? I18N.t('merge.autoTag') : '' }));
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
    // Kolo zrovna kontroluje stahování (ffprobe na částečném souboru…) – zrušit až po něm, jinak by ho přepsalo
    if (this.running) {
      j.cancelRequested = true;
      j.message = I18N.t('merge.cancelling');
      this.ctx.store.save();
      return;
    }
    await this.cancelNow(j);
  }

  async cancelNow(j) {
    delete j.cancelRequested;
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
    pruneBadDonorCandidates(this.ctx.store); // stejný torrent z jiného indexeru v návrhu nenechávat
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const j of this.active()) {
        try {
          if (j.cancelRequested) { await this.cancelNow(j); continue; }
          if (j.state === 'downloading') await this.checkDownload(j);
          if (j.cancelRequested && j.active && j.state !== 'processing' && j.state !== 'importing') { await this.cancelNow(j); continue; }
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
  //   part – torrent jedné epizody ze sady: jeho jediné video patří k jeho epizodě, i když se jmenuje jinak
  wantedFiles(j, files, part = null) {
    const videos = files.filter(isDonorVideo);
    if (!videos.length) return new Set();
    if (j.app === 'radarr') return new Set([videos.reduce((a, b) => (b.size > a.size ? b : a)).index]);
    const want = new Set(j.episodeNumbers || []);
    const matched = videos.filter((f) => {
      const ep = parseEpisode(f.name);
      return ep && (ep.s == null || ep.s === j.season) && want.has(ep.e);
    });
    if (part && !matched.length && videos.length > 1) {
      const own = videos.filter((f) => part.episodes.includes(parseEpisode(f.name)?.e));
      if (own.length) return new Set(own.map((f) => f.index));
    }
    return new Set((matched.length ? matched : videos).map((f) => f.index));
  }

  // Video z torrentu sady → epizoda: podle názvu souboru, jinak podle epizody, pro kterou se torrent stahoval
  static partEpisode(part, name, season) {
    const ep = parseEpisode(name);
    if (ep && (ep.s == null || ep.s === season)) return ep;
    return part.episodes?.length === 1 ? { s: season, e: part.episodes[0] } : null;
  }

  // Sada torrentů epizod: stav všech torrentů najednou, hotovo až po stažení všech
  async checkSetDownload(j) {
    const st = this.st;
    const now = Date.now();
    let size = 0, left = 0, done = 0, seeds = Infinity, speed = 0;
    for (const x of j.parts) {
      const t = await this.qbit.byTag(x.tag);
      if (!t) {
        if (now - j.grabbedAt > 15 * 60e3) return this.fail(j, I18N.t('merge.set.notInQbit', { title: x.title }), { retry: true, part: x });
        continue;
      }
      x.hash = t.hash;
      x.savePath = t.save_path;
      if (!x.hashChecked) {
        x.hashChecked = true;
        const bad = badDonorOf(this.ctx.store, null, { guid: x.guid, infoHash: t.hash });
        if (bad) {
          rememberBadDonor(this.ctx.store, this.partJob(j, x), bad.reason, { into: bad });
          return this.fail(j, I18N.t('merge.set.sameBad', { title: x.title, bad: bad.title, reason: bad.reason }), { retry: true, remember: false, part: x });
        }
      }
      if (!x.filesSelected) {
        const files = await this.qbit.files(t.hash);
        if (!files?.length) continue; // metadata magnetu ještě nedorazila
        const wanted = this.wantedFiles(j, files, x);
        if (!wanted.size) return this.fail(j, I18N.t('merge.set.noVideo', { title: x.title }), { retry: true, part: x });
        await this.qbit.setFilePriority(t.hash, files.filter((f) => !wanted.has(f.index)).map((f) => f.index), 0);
        x.filesSelected = true;
        continue; // průběh přečteme příště, až qBittorrent přepočítá vybrané soubory
      }
      if (/error|missingFiles/i.test(t.state)) return this.fail(j, I18N.t('merge.set.qbitError', { title: x.title, state: t.state }), { retry: true, part: x });
      if (x === j.parts[0]) await this.stopEarlyFpsCheck(j, t);
      x.progress = Number(t.progress) || 0;
      size += Number(t.size) || 0;
      left += Number(t.amount_left) || 0;
      speed += Number(t.dlspeed) || 0;
      seeds = Math.min(seeds, Number(t.num_seeds) || 0);
      if (Number(t.amount_left) === 0 || x.progress >= 1) done++;
    }
    j.size = size;
    j.progress = size ? (size - left) / size : 0;
    j.timeleft = speed > 0 ? new Date(left / speed * 1000).toISOString().slice(11, 19) : null;
    j.message = I18N.t('merge.set.progress', { done, total: j.parts.length, seeders: seeds, speed: (speed / 1024 ** 2).toFixed(1) });
    if (j.lastLeft == null || left < j.lastLeft - 5e6) {
      j.lastProgressAt = now;
      j.lastLeft = left;
    }
    if (done === j.parts.length) {
      j.state = 'ready';
      this.log(j, 'info', I18N.t('merge.set.downloaded'));
      return;
    }
    if (now - j.lastProgressAt > st.stallHours * 3600e3) {
      const slow = j.parts.filter((x) => x.progress < 1).sort((a, b) => a.progress - b.progress)[0];
      return this.fail(j, I18N.t('merge.set.stalled', { hours: st.stallHours, title: slow?.title }), { retry: true, part: slow });
    }
  }

  // Torrent ze sady jako samostatný "donor" pro paměť nevhodných donorů (badDonors)
  partJob(j, x) {
    return { id: j.id, itemKey: j.itemKey, label: j.label, title: x.title, guid: x.guid, hash: x.hash, candidate: x, finishedAt: j.finishedAt };
  }

  async checkDownload(j) {
    if (j.parts) return this.checkSetDownload(j);
    const st = this.st;
    const now = Date.now();
    const t = await this.qbit.byTag(`ujob-${j.id}`);
    if (!t) {
      if (now - j.grabbedAt > 15 * 60e3) return this.fail(j, I18N.t('merge.neverAppeared'), { retry: true });
      return;
    }
    j.hash = t.hash;
    j.savePath = t.save_path;
    if (!j.hashChecked) {
      // Hash u části indexerů (1337x) známe až z qBittorrentu – stejný torrent pod jiným názvem / GUID
      j.hashChecked = true;
      const bad = badDonorOf(this.ctx.store, null, { guid: j.guid, infoHash: t.hash });
      if (bad) {
        rememberBadDonor(this.ctx.store, j, bad.reason, { into: bad });
        return this.fail(j, I18N.t('merge.sameBad', { bad: bad.title, reason: bad.reason }), { retry: true, remember: false });
      }
    }
    if (!j.filesSelected) {
      const files = await this.qbit.files(t.hash);
      if (files?.length) {
        const wanted = this.wantedFiles(j, files);
        if (!wanted.size) return this.fail(j, I18N.t('merge.noVideo'), { retry: true });
        await this.qbit.setFilePriority(t.hash, files.filter((f) => !wanted.has(f.index)).map((f) => f.index), 0);
        j.filesSelected = true;
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
    await this.stopEarlyFpsCheck(j, t);
    if (j.filesSelected && (left === 0 || j.progress >= 1)) {
      j.state = 'ready';
      this.log(j, 'info', I18N.t('merge.donorDone'));
      return;
    }
    if (now - j.lastProgressAt > st.stallHours * 3600e3) {
      return this.fail(j, I18N.t('download.noProgress', { hours: st.stallHours }), { retry: true });
    }
  }

  // Úloha z doby, kdy se fps ověřovala ze začátku donoru (sekvenční stahování): vypnout sekvenční stahování,
  // jiná fps už donor nevylučuje – zvuk se přepočítá (findSync)
  async stopEarlyFpsCheck(j, t) {
    if (j.fpsCheck?.state !== 'pending') return;
    await this.qbit.prioritizeStart(t, false).catch(() => {});
    delete j.fpsCheck;
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
    const donors = [];
    for (const x of j.parts || [null]) {
      const files = await this.qbit.files(x ? x.hash : j.hash);
      for (const f of files.filter((f) => f.priority > 0 && isDonorVideo(f))) {
        donors.push(x
          ? { path: path.join(x.savePath, f.name), size: f.size, ep: Merger.partEpisode(x, f.name, j.season), part: x }
          : { path: path.join(j.savePath, f.name), size: f.size, ep: parseEpisode(f.name) });
      }
    }
    if (!donors.length) return this.fail(j, I18N.t('merge.donorNoVideo'), { retry: true });

    // Místo na disku: výsledek je zhruba velikost stávajícího souboru + zvuková stopa (+ případně přepočtená stopa)
    const need = targets.reduce((s, t) => s + (fs.existsSync(t.path) ? fs.statSync(t.path).size : 0), 0) * 1.1 + 2 * 1024 ** 3;
    // Staging úlohy (j.dir = <staging>/<id>); starší úlohy bez dir → staging aplikace položky
    const jobStaging = j.dir ? path.dirname(j.dir) : stagingFor(st, j.app);
    const sfs = fs.statfsSync(jobStaging);
    if (sfs.bavail * sfs.bsize < need) return this.fail(j, I18N.t('common.lowDisk', { gb: (need / 1024 ** 3).toFixed(1) }));

    const results = [];
    for (const t of targets) {
      const donor = j.app === 'radarr'
        ? donors.reduce((a, b) => (b.size > a.size ? b : a))
        : donors.find((d) => d.ep && (d.ep.s == null || d.ep.s === j.season) && t.episodeNumbers.includes(d.ep.e));
      const name = path.basename(t.path);
      if (!donor) { results.push({ ok: false, target: name, reason: I18N.t('merge.episodeMissing'), donor: true, code: 'episode' }); continue; }
      const part = donor.part ? j.parts.indexOf(donor.part) : undefined;
      try {
        results.push({ ok: true, part, ...(await this.mergeOne(j, t, donor.path, donor.part)) });
      } catch (e) {
        results.push({ ok: false, part, target: name, reason: e.message, donor: Boolean(e.donor), mismatch: Boolean(e.mismatch), code: e.code || null, lengthMin: e.lengthMin ?? null });
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
      // Zablokovat donor a zkusit jiný jen tehdy, když za všechno může donor – ne při místní chybě
      const retry = results.every((r) => r.ok || r.donor);
      const mismatch = results.every((r) => r.ok || r.mismatch);
      // U sady zablokovat jen torrenty, se kterými to neprošlo (ne celou sadu – zbytek se může hodit do jiné)
      if (j.parts && retry) this.rememberFailedParts(j, results, { mismatch });
      return this.fail(j, I18N.t('merge.nothingMerged', { why }), { retry, mismatch, remember: retry && !j.parts, memo: { reason: why, ...failureCode(results) } });
    }

    // Záloha původních souborů (hardlink = nezabírá místo navíc; jinak kopie). Bez zálohy se neimportuje.
    j.backupDir = path.join(jobStaging, 'backup', j.id);
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
    // Stav "importing" ještě před odesláním (jako u opravy synchronizace): když odpověď nedorazí (timeout),
    // import možná proběhl – sloučené soubory se nesmí smazat ani znovu vyrobit a záloha musí vydržet
    j.state = 'importing';
    j.importAt = Date.now();
    j.importedFileIds = ok.map((r) => r.fileId);
    j.backupUntil = Date.now() + Math.max(this.st.keepBackupDays, 30) * 86400e3; // zkrátí se po úspěšném importu
    this.ctx.store.save();
    try {
      await client.command({ name: 'ManualImport', importMode: 'move', files: files2 });
    } catch (e) {
      if (e.status && e.status < 500) { j.state = 'processing'; throw e; } // jasné odmítnutí → nic se nestalo
      j.message = I18N.t('merge.importNoReply', { error: e.message });
    }
    const failed = results.filter((r) => !r.ok);
    // Zbylé epizody z tohohle donoru stejně neprojdou – nestahovat ho pro ně znovu (jen když za to může donor)
    const donorFailed = failed.filter((r) => r.donor);
    if (donorFailed.length && j.parts) this.rememberFailedParts(j, donorFailed, { mismatch: true });
    else if (donorFailed.length) rememberBadDonor(this.ctx.store, j, partialReason(donorFailed, results.length), failureCode(donorFailed));
    this.log(j, 'info', I18N.t('merge.merged', {
      done: ok.length, total: targets.length,
      failed: failed.length ? I18N.t('merge.mergedFailed', { list: failed.map((r) => `${r.target} – ${r.reason}`).join('; ') }) : '',
    }));
  }

  async mergeOne(j, t, donorPath, part = null) {
    const st = this.st;
    const need = j.need;
    const other = need === L.primary() ? L.secondary() : L.primary();
    assertReplaceable(t.path);
    const [tp, dp] = await Promise.all([A.probe(t.path), A.probe(donorPath)]);
    const name = path.basename(t.path);
    // Stávající stopy bez značky nebo se špatnou značkou: jazyk podle poslechu (a ve výsledku je podle něj i označíme)
    const heard = speechLangs(this.ctx.store.s.items[j.itemKey]?.langCheck, t.fileId, tp.audio);
    const tagged = tp.audio; // stopy, jak je vidí ffprobe (se značkami ze souboru) – pro spárování s mkvmerge
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
      const c = part || j.candidate;
      if (dp.audio.length === 1 && !dp.audio[0].lang && c && !(c.dualDonor)) {
        track = dp.audio[0];
        notes.push(I18N.t('merge.donorUntagged'));
      } else {
        throw donorError(I18N.t('merge.donorLacks', { lang: L.label(need), tracks: dp.audio.map((a) => a.lang || '?').join(', ') || I18N.t('common.none') }), { code: 'track' });
      }
    }
    const ref = tp.audio.find((a) => a.lang === other && a.default) || tp.audio.find((a) => a.lang === other) || tp.audio.find((a) => a.default) || tp.audio[0];
    if (!ref) throw new Error(I18N.t('merge.noAudio'));

    // Rychlost donoru: jiná fps samy o sobě nevadí (zvuk je časový), vadí jen jiná rychlost obsahu (PAL 25 fps
    // z 23,976 fps filmu je o 4,3 % rychlejší). Takový zvuk se přepočítá na tempo stávajícího souboru.
    // Hlavička MKV bývá zaokrouhlená na ms (23,810 místo 23,976) → fps podle časových značek snímků.
    const [tf, df] = await Promise.all([A.measureFps(tp).catch(() => 0), A.measureFps(dp).catch(() => 0)]);
    const fps = { target: tf || tp.video?.fps || 0, donor: df || dp.video?.fps || 0 };
    const speeds = A.speedCandidates({ targetFps: fps.target, donorFps: fps.donor, targetDur: tp.duration, donorDur: dp.duration });
    const work = path.join(j.dir, 'work', String(t.fileId ?? 'f'));
    try {
      const found = await this.findSync(j, { tp, dp, ref, track, need, speeds, fps, work });
      const { sync, via, direct, speed } = found;
      if (speed !== 1) notes.unshift(retimeNote(speed, fps, found.pitch));

      // Sloučení
      const outDir = path.join(j.dir, 'out');
      fs.mkdirSync(outDir, { recursive: true });
      const out = path.join(outDir, name.replace(/\.[^.]+$/, '') + '.mkv');
      try {
        const res = await this.mkvMerge(j, { t, tp, tagged, donorPath: found.src.p.file, track: found.src.track, ref, relabel, sync, out, name, need, via, direct, notes });
        return speed === 1 ? res : { ...res, retimed: { speed, fromFps: fps.donor, toFps: fps.target, pitch: found.pitch?.raised ? 'restore' : 'keep', codec: found.src.codec } };
      } catch (e) {
        fs.rmSync(out, { force: true }); // nepovedený výstup nenechávat v out/ (import by ho počítal, zabírá místo)
        throw e;
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Synchronizace donoru proti stávajícímu souboru, postupně pro každou rychlost ze `speeds` (1 = beze změny,
   * jinak se stopa napřed přepočítá na tempo stávajícího souboru). Když posun v průběhu filmu rovnoměrně
   * narůstá (24 vs 23,976 fps), zkusí se i rychlost odvozená z toho nárůstu.
   * Vrací { sync, via, speed, src: { p, track, codec }, pitch }; když nesedí nic, vyhodí chybu donoru.
   */
  async findSync(j, { tp, dp, ref, track, need, speeds, fps, work }) {
    const st = this.st;
    const T = (p, a) => ({ file: p.file, duration: p.duration, startTime: p.startTime, stream: a.index });
    const opts = { maxOffsetSec: st.mergeMaxOffsetSec };
    const dRef = dp.audio.find((a) => a !== track && a.lang && a.lang === ref.lang);
    const cache = new Map();
    // Stopa donoru v požadované rychlosti (a výšce): u 1 přímo z donoru, jinak přepočtená do work/
    const source = async (a, speed, pitch = 'keep') => {
      if (speed === 1) return { p: dp, track: a };
      const key = `${a.index}:${speed}:${pitch}`;
      if (!cache.has(key)) {
        fs.mkdirSync(work, { recursive: true });
        const out = path.join(work, `${a.index}-${pitch}.mka`);
        this.log(j, 'info', I18N.t(pitch === 'restore' ? 'merge.retiming.pitch' : 'merge.retiming', { lang: L.label(a.lang), speed: speedText(speed, fps) }));
        const enc = await A.retime({ file: dp.file, audio: a }, speed, out, { pitch, lang: a.lang && LANGS.get(a.lang) ? LANGS.tagOf(a.lang) : null });
        const p = await A.probe(out);
        if (!p.audio[0]) throw new Error(I18N.t('merge.retimedNoAudio'));
        cache.set(key, { p, track: { ...p.audio[0], lang: a.lang, from: a.from }, codec: enc.codec });
      }
      return cache.get(key);
    };

    const tried = [];
    let lengthDiff = null;
    for (let k = 0; k < speeds.length; k++) {
      const speed = speeds[k];
      // Délka po přepočtu: víc než 10 min rozdíl = jiná verze filmu (jiný střih), ne jiná rychlost
      const diff = Math.abs(tp.duration - dp.duration * speed);
      if (diff > 10 * 60) { lengthDiff ??= diff; continue; }
      const src = await source(track, speed);
      let sync = await A.checkSync(T(tp, ref), T(src.p, src.track), opts);
      let via = I18N.t('merge.via.direct', { lang: L.label(need), ref: L.label(ref.lang) });
      let direct = true;
      const measured = [sync];
      if (!sync.ok && dRef) {
        // Dabing se od originálu může lišit víc, než korelace snese – zkusit to přes stejný jazyk v donoru
        const rsrc = await source(dRef, speed);
        const s2 = await A.checkSync(T(tp, ref), T(rsrc.p, rsrc.track), opts);
        const s3 = s2.ok ? await A.checkSync(T(rsrc.p, rsrc.track), T(src.p, src.track), { maxOffsetSec: 5 }) : null;
        if (s2.ok && s3?.ok) {
          sync = { ...s2, offsetMs: s2.offsetMs + s3.offsetMs };
          via = I18N.t('merge.via.donorRef', { ref: L.label(ref.lang) });
          direct = false;
        }
        measured.push(s2);
      }
      if (sync.ok) {
        // PAL zrychlení bez korekce zvedne i výšku hlasů – pak přepočítat i ji (u 24 vs 23,976 je rozdíl neslyšitelný)
        let pitch = null;
        let out = src;
        if (Math.abs(speed - 1) > 0.02) {
          pitch = await A.pitchCheck(T(tp, ref), T(src.p, src.track), { offsetMs: sync.offsetMs, speed, times: A.reliableTimes(sync) })
            .catch((e) => ({ raised: null, error: e.message }));
          if (pitch.raised) out = await source(track, speed, 'restore');
        }
        return { sync, via, direct, speed, src: out, pitch };
      }
      tried.push(speeds.length > 1 ? `${speed === 1 ? I18N.t('merge.tempoKept') : I18N.t('merge.tempoAfter', { speed: speedText(speed, fps) })}: ${sync.reason}` : sync.reason);
      const drift = speed === 1 && measured.map((m) => A.driftSpeed(m.anchors)).find(Boolean);
      if (drift && !speeds.includes(drift)) speeds.push(drift);
    }
    if (!tried.length && lengthDiff != null) {
      const min = Math.round(lengthDiff / 60);
      throw donorError(I18N.t('merge.lengthDiffers', { min }), { mismatch: true, code: 'length', lengthMin: min });
    }
    throw donorError(I18N.t('merge.syncFailed', { reason: tried.join('; ') }), { mismatch: true, code: 'sync' });
  }

  // mkvmerge a kontrola výsledku (mergeOne)
  async mkvMerge(j, { t, tp, tagged, donorPath, track, ref, relabel, sync, out, name, need, via, direct, notes }) {
    const st = this.st;
    const T = (p, a) => ({ file: p.file, duration: p.duration, startTime: p.startTime, stream: a.index });
    const [tj, dj] = await Promise.all([A.run('mkvmerge', ['-J', t.path]), A.run('mkvmerge', ['-J', donorPath])]).then((x) => x.map(JSON.parse));
    const tAudio = (tj.tracks || []).filter((x) => x.type === 'audio');
    const dTid = mkvAudioId(dj, track);
    // Ve výsledku jsou napřed stopy stávajícího souboru v pořadí mkvmerge (to se od ffprobe může lišit)
    const refTid = mkvAudioId(tj, ref);
    const refPos = refTid == null ? ref.audioIndex : tAudio.findIndex((x) => x.id === refTid);
    if (dTid == null) throw new Error(I18N.t('merge.mkvNoDonorTrack'));
    const makeDefault = need === L.primary() && st.mergePrimaryDefault;
    const args = ['-o', out, '--enable-legacy-font-mime-types']; // jinak font/ttf, který ffmpeg nepozná
    if (makeDefault) for (const a of tAudio) args.push('--default-track-flag', `${a.id}:0`);
    for (const r of relabel) {
      const tid = mkvAudioId(tj, tagged[r.audioIndex]);
      if (tid == null) throw new Error(I18N.t('merge.mkvNoTargetTrack'));
      args.push('--language', `${tid}:${LANGS.tagOf(r.lang)}`);
    }
    args.push(t.path,
      '--no-video', '--no-subtitles', '--no-chapters', '--no-attachments', '--no-buttons', '--no-global-tags', '--no-track-tags',
      '--audio-tracks', String(dTid),
      '--sync', `${dTid}:${sync.offsetMs}`,
      '--language', `${dTid}:${LANGS.tagOf(need)}`,
      '--track-name', `${dTid}:${trackName(need)}${st.mergeCredit ? ' (By: Updaterr)' : ''}`,
      '--default-track-flag', `${dTid}:${makeDefault ? 1 : 0}`,
      donorPath);
    await A.run('mkvmerge', args, { timeoutMs: 60 * 60e3, okCodes: [0, 1] });

    // Kontrola výsledku: video, délka, oba jazyky a znovu synchronizace přímo ve výsledném souboru
    const op = await A.probe(out);
    if (!op.video) throw new Error(I18N.t('merge.resultNoVideo'));
    // Kratší výsledek = něco se ztratilo. Delší je v pořádku (donor má třeba delší titulky na konci).
    if (op.duration < tp.duration - 2) throw new Error(I18N.t('merge.resultShorter', { out: op.duration.toFixed(0), orig: tp.duration.toFixed(0) }));
    const oNew = op.audio.find((a) => a.lang === need);
    const oRef = op.audio[refPos];
    if (!oNew || !oRef) throw new Error(I18N.t('merge.resultNoTrack'));
    // Ověřit v místech, kde měření před sloučením vyšlo spolehlivě (jinak tiché scény shodí i dobrý výsledek)
    const verify = await A.checkSync(T(op, oRef), T(op, oNew), A.verifyOpts(sync, { maxOffsetSec: 5, anchors: 6, minValid: 4 }));
    if (!verify.ok || Math.abs(verify.offsetMs) > 80) {
      throw donorError(I18N.t('merge.verifyFailed', { reason: verify.reason || verify.offsetMs + ' ms' }), { mismatch: true, code: 'verify' });
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
      const parts = j.parts || [{ hash: j.hash, tag: `ujob-${j.id}` }];
      for (const x of parts) {
        try {
          const hash = x.hash || (await this.qbit.byTag(x.tag))?.hash;
          if (hash) await this.qbit.delete(hash, true);
        } catch (e) {
          this.ctx.store.log('warn', I18N.t('merge.deleteDonorFailed', { label: j.label, error: e.message }));
        }
      }
      // qBittorrent tag po smazání torrentu sám nemaže – bez tohohle by se ujob-* tagy hromadily v jeho seznamu
      try {
        await this.qbit.deleteTags([...new Set([`ujob-${j.id}`, ...parts.map((x) => x.tag)])].join(','));
      } catch (e) {
        this.ctx.store.log('warn', I18N.t('merge.deleteTagsFailed', { label: j.label, error: e.message }));
      }
    }
    fs.rmSync(path.join(j.dir, 'out'), { recursive: true, force: true });
    if (deleteTorrent) fs.rmSync(j.dir, { recursive: true, force: true });
  }

  // Torrenty sady, se kterými sloučení neprošlo, zapamatovat jako nevhodné donory (každý zvlášť).
  // Jako výměna celého souboru se dál nenabízí jen torrent, který je vadný sám o sobě (ne jen nesedí).
  rememberFailedParts(j, results, { mismatch = false } = {}) {
    const { store } = this.ctx;
    const byPart = new Map();
    for (const r of results) {
      if (r.ok || r.part == null || !r.donor) continue;
      if (!byPart.has(r.part)) byPart.set(r.part, []);
      byPart.get(r.part).push(r);
    }
    for (const [i, rs] of byPart) {
      const x = j.parts[i];
      rememberBadDonor(store, this.partJob(j, x), [...new Set(rs.map((r) => r.reason))].join('; '), failureCode(rs));
      if (!mismatch && !rs.some((r) => r.mismatch)) store.s.ignoredGuids[x.guid] = Date.now();
    }
  }

  // retry = vadný torrent (zablokovat a zkusit další donor); remember = zapamatovat si ho i podle hashe a názvu
  // mismatch = release jen nesedí k tomuhle souboru (jiný střih, fps, synchronizace) – blokuje se jen pro přidání
  //   zvuku, jako výměna celého souboru se nabízí dál; když jiný donor není, nabídne se právě ta
  // part = u sady torrent, za který to může – zablokuje se on, ne celá sada
  // memo = co si k nevhodnému donoru zapamatovat ({ reason, code, lengthMin }), jinak `reason`
  async fail(j, reason, { retry = false, remember = retry, mismatch = false, part = null, memo = null } = {}) {
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
    if (j.cancelRequested) { retry = false; mismatch = false; remember = false; delete j.cancelRequested; }
    mismatch &&= retry;
    await this.cleanup(j, { deleteTorrent: true });
    if (j.backupDir && !j.backupUntil) j.backupUntil = Date.now() + 86400e3;
    const culprit = part ? this.partJob(j, part) : j;
    if (retry && !mismatch && (part || !j.parts)) store.s.ignoredGuids[culprit.guid] = Date.now();
    j.active = false;
    j.state = 'failed';
    j.finishedAt = Date.now();
    if (part) part.state = 'failed';
    if (remember && (part || !j.parts)) rememberBadDonor(store, { ...culprit, finishedAt: j.finishedAt }, memo?.reason || reason, memo || {});
    this.log(j, 'warn', reason);

    const item = store.s.items[j.itemKey];
    const tryDonor = retry && this.st.retryOnStall && j.attempt < this.st.maxRetries;
    let offer = null;
    if (item && (tryDonor || mismatch)) {
      try {
        const { searchItem } = require('./search');
        const res = await searchItem(this.ctx, item, { reason: I18N.t(tryDonor ? 'merge.reason.replacementDonor' : 'merge.reason.otherCut'), silent: true });
        const cands = res.proposal?.candidates || [];
        // Po nesouladu sám nezkoušet donor, který je podle názvu zase jiná verze filmu
        const idx = tryDonor ? cands.findIndex((c) => c.kind === 'merge' && c.mergeLang === j.need && !(mismatch && c.otherCut)) : -1;
        if (idx >= 0) {
          j.replacedBy = (await this.start(res.proposal.id, idx, { retryOf: j })).id;
          return;
        }
        if (tryDonor) j.message += I18N.t('merge.noDonor');
        const whole = mismatch && (cands.find((c) => c.kind === 'cutmatch') || cands.find((c) => c.kind !== 'merge'));
        if (whole) {
          offer = res.proposal;
          j.offerProposalId = offer.id;
          j.message += whole.kind === 'cutmatch'
            ? I18N.t('merge.offer.cutmatch', { title: whole.title, quality: whole.quality, lang: L.label(j.need) })
            : I18N.t('merge.offer.whole', { title: whole.title, tier: L.tierLabel(whole.tier), quality: whole.quality });
        }
      } catch (e) {
        j.message += I18N.t(tryDonor ? 'download.replacementFailed' : 'merge.replacementNotFound', { error: e.message });
      }
    }
    this.reopen(j, { dropGuid: retry && !mismatch ? j.guid : null, note: I18N.t('common.prevAttemptFailed', { reason }) });
    notify.download(j, 'failed').catch(() => {});
    if (offer && this.st.notifyProposals) notify.proposal(offer, item).catch(() => {});
  }
}

module.exports = {
  Merger, mergeCandidates, neededLang, parseEpisode, backupOriginal, assertReplaceable, isTransient, speechLangs, speedText, retimeNote,
  releaseHash, badDonorOf, badDonorCode, badDonorLengthMin, failureCode, rememberBadDonor, backfillBadDonors, pruneBadDonorCandidates,
  unblockMismatchedDonors, unblockRetimableDonors, mkvAudioId,
};

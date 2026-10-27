// Zálohy původních souborů (slučování stop, opravy synchronizace) ve stagingDir/backup/<id úlohy>:
// přehled, ruční smazání, vlastní termín u jednotlivé zálohy a úklid podle retence (dny a max. velikost).
// Záloha je hardlink originálu – dokud je soubor i v knihovně, místo nezabírá. Po importu ho ale
// Radarr/Sonarr z knihovny smaže a záloha zůstane jedinou kopií, pak zabírá plnou velikost.
// Po dokončení úlohy se ověří, že výsledek v knihovně sedí se zálohou (verify): když ano, záloha se může
// hned smazat (backupDeleteVerified), při odchylce zůstane a přijde notifikace.
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('./i18n');
const A = require('./audio');
const L = require('./lang');

const DAY = 86400e3;
const BLOCKED_MIN_DAYS = 30; // nepovedený import: originál se může hodit déle
const REVIEW_OFFSET_MS = 10_000; // takhle velký posun přidané stopy bývá jiný úvod nebo střih donoru
const REVIEW_VERIFY_MS = 50;     // zbytkový posun ve výsledku (sloučení i oprava pustí až 80 ms)

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) {
      const s = fs.statSync(path.join(dir, r));
      out.push({ name: r, size: s.size, shared: s.nlink > 1, mtime: s.mtimeMs });
    }
  }
  return out;
}

// Kdy by se záloha smazala při retenci `days`: vlastní termín > podle stavu úlohy; null = nikdy (automaticky)
function expiryAt(b, days) {
  if (b.keep === 'forever' || b.keep === 'orphan') return null;
  if (b.keep === 'custom') return b.expiresAt;
  if (b.state === 'done' && b.finishedAt) return b.finishedAt + days * DAY;
  if (b.state === 'blocked' && b.finishedAt) return b.finishedAt + Math.max(days, BLOCKED_MIN_DAYS) * DAY;
  return b.expiresAt;
}

// Co se při dané retenci smaže: [{ id, why: 'age' | 'verified' | 'size' }]. S deleteVerified jdou pryč
// hned zálohy s ověřeným sloučením (ne ty s vlastním termínem). Limit velikosti počítá jen místo, které
// zálohy opravdu zabírají (bez hardlinků sdílených s knihovnou), a maže od nejstarších – nikdy ty
// s vlastním termínem, běžící úlohy ani zálohy po nepovedeném importu.
function plan(list, { days, maxBytes = 0, deleteVerified = false }, now = Date.now()) {
  const out = [];
  const left = [];
  for (const b of list) {
    const exp = expiryAt(b, days);
    if (!b.active && exp != null && exp <= now) out.push({ id: b.id, why: 'age' });
    else if (deleteVerified && b.keep === 'auto' && !b.active && b.check?.status === 'ok') out.push({ id: b.id, why: 'verified' });
    else left.push(b);
  }
  let total = left.reduce((s, b) => s + b.exclusive, 0);
  if (maxBytes > 0 && total > maxBytes) {
    const victims = left.filter((b) => b.keep === 'auto' && !b.active && b.state === 'done' && b.exclusive > 0)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const b of victims) {
      if (total <= maxBytes) break;
      out.push({ id: b.id, why: 'size' });
      total -= b.exclusive;
    }
  }
  return out;
}

// Stav sloučení / opravy k záloze: running | pending (čeká na ověření) | ok | review | notMerged | unknown
function mergeStatus(j) {
  if (!j) return { status: 'unknown' };
  if (j.active) return { status: 'running' };
  if (j.state === 'blocked') return { status: 'review', issues: [{ msg: I18N.t('backup.check.blocked') }] };
  if (j.state !== 'done') return { status: 'notMerged' }; // selhalo před importem: v knihovně zůstal originál
  return j.backupCheck || { status: 'pending' };
}

// Jaký zvuk sloučení přidalo: jazyk, kodek a kanály (starší úlohy je nemají – doplní je ověření) a posun stopy
function addedAudio(j) {
  if (j?.type !== 'merge' || !j.need) return null;
  const done = (j.results || []).filter((r) => r.ok && !r.skipped);
  if (!done.length) return null;
  const seen = new Map();
  for (const r of done) if (r.added?.codec) seen.set(`${r.added.codec}/${r.added.channels}`, { codec: r.added.codec, channels: r.added.channels || null });
  const offsets = done.map((r) => r.offsetMs).filter(Number.isFinite);
  return { lang: j.need, tracks: [...seen.values()], offsetMs: offsets.length ? [Math.min(...offsets), Math.max(...offsets)] : null };
}

// Co na jednom sloučeném / opraveném souboru stojí za kontrolu člověkem. r = výsledek z úlohy,
// lib = soubor v knihovně ({ fileId, size }), libProbe / bakProbe = ffprobe souboru v knihovně a zálohy,
// meas = měření synchronizace souboru v knihovně (dubsync), pokud už proběhlo.
function fileIssues(j, r, { lib, libProbe, bakProbe, meas, syncWarnMs = 80 }) {
  if (!lib) return [I18N.t('backup.issue.noLibFile')];
  if (lib.fileId === r.fileId) return [I18N.t('backup.issue.original')];
  const out = [];
  if (r.outSize && lib.size && lib.size !== r.outSize) out.push(I18N.t('backup.issue.changed'));
  if (!libProbe) out.push(I18N.t('backup.issue.libUnreadable'));
  if (!bakProbe) out.push(I18N.t('backup.issue.bakUnreadable'));
  if (libProbe && bakProbe) {
    if (!libProbe.video) out.push(I18N.t('backup.issue.noVideo'));
    if (libProbe.duration < bakProbe.duration - 2) out.push(I18N.t('backup.issue.shorter', { lib: Math.round(libProbe.duration), orig: Math.round(bakProbe.duration) }));
    const n = libProbe.audio.length;
    const n0 = bakProbe.audio.length;
    if (j.type === 'merge') {
      if (!libProbe.audio.some((a) => a.lang === j.need)) out.push(I18N.t('backup.issue.missingTrack', { lang: L.label(j.need) }));
      else if (n < n0 + 1) out.push(I18N.t('backup.issue.trackCount', { n, expected: n0 + 1 }));
    } else if (n !== n0) out.push(I18N.t('backup.issue.trackCountOrig', { n, orig: n0 }));
  }
  if (meas?.ok && Math.abs(meas.offsetMs) > syncWarnMs) out.push(I18N.t('backup.issue.syncAfter', { ms: meas.offsetMs }));
  // Z průběhu sloučení / opravy
  if (Math.abs(r.offsetMs) > REVIEW_OFFSET_MS) out.push(I18N.t('backup.issue.bigOffset', { sec: (r.offsetMs / 1000).toLocaleString(I18N.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
  const verify = j.type === 'merge' ? [r.verifyMs] : (r.applied || []).map((a) => a.verifyMs);
  const worst = Math.max(0, ...verify.filter(Number.isFinite).map(Math.abs));
  if (worst > REVIEW_VERIFY_MS) out.push(I18N.t('backup.issue.residual', { ms: worst }));
  // direct chybí u záznamů ze starší verze – tam rozhoduje text
  if (r.direct === false || (r.direct == null && r.via && !/přímo/.test(r.via))) out.push(I18N.t('backup.issue.indirect', { via: r.via }));
  if (r.langNote) out.push(I18N.t('backup.issue.langNote', { note: r.langNote }));
  return out;
}

class Backups {
  constructor(ctx, { probe = A.probe } = {}) {
    this.ctx = ctx;
    this.probe = probe;
    this.verifying = false;
  }

  get st() { return this.ctx.store.settings; }
  get root() { return this.st.stagingDir ? path.join(this.st.stagingDir, 'backup') : null; }

  job(id) {
    const s = this.ctx.store.s;
    return s.merges[id] || s.syncFixes[id] || null;
  }

  // Zálohy na disku spárované s úlohami
  list() {
    let dirs = [];
    if (!this.root) return [];
    try { dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* složka ještě není */ }
    const out = [];
    for (const id of dirs) {
      const dir = path.join(this.root, id);
      let files;
      try { files = walk(dir); } catch { continue; }
      const j = this.job(id);
      const keep = !j ? 'orphan' : j.backupKeep === 'forever' ? 'forever' : j.backupCustom ? 'custom' : 'auto';
      out.push({
        id, dir, keep,
        type: j?.type || null, app: j?.app || null, itemKey: j?.itemKey || null,
        label: j?.label || id, title: j?.title || null,
        state: j?.state || null, active: Boolean(j?.active),
        finishedAt: j?.finishedAt || null,
        check: mergeStatus(j),
        added: addedAudio(j),
        createdAt: j?.importAt || j?.finishedAt || Math.min(...files.map((f) => f.mtime), fs.statSync(dir).mtimeMs),
        expiresAt: keep === 'forever' || keep === 'orphan' ? null : j.backupUntil || null,
        files: files.map(({ mtime, ...f }) => f).sort((a, b) => a.name.localeCompare(b.name)),
        size: files.reduce((s, f) => s + f.size, 0),
        exclusive: files.reduce((s, f) => s + (f.shared ? 0 : f.size), 0),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  overview() {
    const list = this.list();
    let disk = null;
    try {
      const f = fs.statfsSync(this.root && fs.existsSync(this.root) ? this.root : this.st.stagingDir);
      disk = { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
    } catch { /* bez disku */ }
    return {
      root: this.root,
      keepBackupDays: this.st.keepBackupDays,
      maxBackupGB: this.st.maxBackupGB,
      deleteVerified: this.st.backupDeleteVerified,
      blockedMinDays: BLOCKED_MIN_DAYS,
      size: list.reduce((s, b) => s + b.size, 0),
      exclusive: list.reduce((s, b) => s + b.exclusive, 0),
      disk,
      backups: list,
    };
  }

  // Náhled / použití retence: vrátí, co se smaže. Bez `apply` nic nemění.
  retention({ days, maxGB, deleteVerified = this.st.backupDeleteVerified }, { apply = false } = {}) {
    const list = this.list();
    const p = plan(list, { days, maxBytes: maxGB * 1024 ** 3, deleteVerified });
    const byId = Object.fromEntries(list.map((b) => [b.id, b]));
    if (apply) {
      // Nová retence platí i pro stávající zálohy (ne pro ty s vlastním termínem)
      for (const b of list) {
        const j = this.job(b.id);
        if (j && b.keep === 'auto' && !b.active) {
          const exp = expiryAt(b, days);
          if (exp) j.backupUntil = exp;
        }
      }
      const reason = { age: I18N.t('backup.reason.expired'), verified: I18N.t('backup.reason.verified'), size: I18N.t('backup.reason.limit', { gb: maxGB }) };
      for (const { id, why } of p) this.remove(id, reason[why]);
      this.ctx.store.save();
    }
    return p.map(({ id, why }) => ({ id, why, label: byId[id].label, exclusive: byId[id].exclusive }));
  }

  tick() {
    return this.retention({ days: this.st.keepBackupDays, maxGB: this.st.maxBackupGB }, { apply: true });
  }

  // Ověření jedné dokončené úlohy: každý sloučený / opravený soubor v knihovně proti jeho záloze.
  // Když Radarr/Sonarr neodpoví, vyhodí chybu (ověří se příště).
  async verifyJob(j) {
    const item = this.ctx.store.s.items[j.itemKey];
    const done = (j.results || []).filter((r) => r.ok && !r.skipped);
    const issues = [];
    if (!item) issues.push({ msg: I18N.t('backup.issue.itemGone') });
    else if (!done.length) issues.push({ msg: I18N.t('backup.issue.noResults') });
    else {
      const lib = await this.ctx.dubsync.files(item, { episodes: true });
      for (const r of done) {
        const f = j.app === 'radarr' ? lib[0] : lib.find((x) => x.episodeIds?.some((e) => r.episodeIds?.includes(e)));
        const [libProbe, bakProbe] = await Promise.all([
          f ? this.probe(f.path).catch(() => null) : null,
          this.probe(path.join(j.backupDir, path.basename(r.path))).catch(() => null),
        ]);
        // Starší sloučení si přidanou stopu nepamatují – doplnit ji podle souboru v knihovně
        if (j.type === 'merge' && !r.added && libProbe) {
          const a = libProbe.audio.find((x) => x.lang === j.need);
          if (a) r.added = { lang: j.need, codec: a.codec, channels: a.channels };
        }
        const meas = f && item.syncCheck?.files?.[f.fileId];
        for (const msg of fileIssues(j, r, { lib: f, libProbe, bakProbe, meas, syncWarnMs: this.st.syncWarnMs })) issues.push({ file: r.target, msg });
      }
    }
    if (j.warning) issues.push({ msg: j.warning });
    const notes = [];
    const failed = (j.results || []).filter((r) => !r.ok).length;
    if (failed) notes.push(I18N.t(j.type === 'syncfix' ? 'backup.note.failedSyncfix' : 'backup.note.failedMerge', { failed, total: j.results.length }));
    return { status: issues.length ? 'review' : 'ok', at: Date.now(), files: done.length, issues, notes };
  }

  // Ověří dokončené úlohy, které ještě ověřené nejsou (nebo jen `id` znovu, ručně), pošle notifikaci
  // u odchylek a pak uklidí podle retence – ověřené zálohy hned, když je zapnuté backupDeleteVerified.
  async verify(id = null) {
    if (this.verifying) {
      if (id) throw new Error(I18N.t('backup.err.verifying'));
      return;
    }
    this.verifying = true;
    const { store, notify } = this.ctx;
    try {
      for (const b of this.list()) {
        const j = this.job(b.id);
        if (!j || j.active || j.state !== 'done' || (id ? b.id !== id : j.backupCheck)) continue;
        let c;
        try {
          c = await this.verifyJob(j);
        } catch (e) {
          if (id) throw e;
          continue; // Radarr/Sonarr teď neodpovídá – příště
        }
        const was = j.backupCheck;
        j.backupCheck = c;
        store.save();
        const what = I18N.t(j.type === 'syncfix' ? 'backup.what.syncfix' : 'backup.what.merge');
        if (c.status === 'ok') {
          store.log('info', I18N.t('backup.verifiedOk', { label: j.label, what, count: c.files }));
        } else {
          store.log('warn', I18N.t('backup.verifiedReview', { label: j.label, what, issues: c.issues.map((i) => (i.file ? `${i.file}: ${i.msg}` : i.msg)).join('; ') }));
          // Ruční „znovu ověřit“ se stejným výsledkem znovu neupozorňuje
          if (!id || was?.status !== 'review') {
            c.notified = true;
            notify.backupReview(j).catch(() => {});
          } else c.notified = was.notified;
        }
      }
    } finally {
      this.verifying = false;
    }
    return this.tick();
  }

  remove(id, reason) {
    const b = this.list().find((x) => x.id === id);
    if (!b) throw Object.assign(new Error(I18N.t('backup.err.notFound')), { status: 404 });
    if (b.active) throw new Error(I18N.t('backup.err.active'));
    if (path.dirname(b.dir) !== this.root) throw new Error(I18N.t('backup.err.badPath'));
    fs.rmSync(b.dir, { recursive: true, force: true });
    const j = this.job(id);
    if (j) j.backupRemoved = true;
    this.ctx.store.save();
    this.ctx.store.log('info', I18N.t('backup.removed', { label: b.label, reason, freed: b.exclusive ? I18N.t('backup.freed', { gb: (b.exclusive / 1024 ** 3).toFixed(1) }) : '' }));
    return { removed: id };
  }

  // Vlastní termín: { days } ode dneška, { forever: true }, nebo { reset: true } = zpět podle retence
  keep(id, { days, forever, reset }) {
    const j = this.job(id);
    if (!j || j.backupRemoved || !j.backupDir) throw Object.assign(new Error(I18N.t('backup.err.noJob')), { status: 404 });
    if (reset) {
      delete j.backupKeep;
      delete j.backupCustom;
      const b = this.list().find((x) => x.id === id);
      const exp = b && expiryAt({ ...b, keep: 'auto' }, this.st.keepBackupDays);
      if (exp) j.backupUntil = exp;
    } else if (forever) {
      j.backupKeep = 'forever';
      delete j.backupCustom;
    } else {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0) throw new Error(I18N.t('backup.err.days'));
      delete j.backupKeep;
      j.backupCustom = true;
      j.backupUntil = Date.now() + n * DAY;
    }
    this.ctx.store.save();
    const what = reset ? I18N.t('backup.keep.retention') : forever ? I18N.t('backup.keep.forever') : I18N.t('backup.keep.until', { date: I18N.fmtDate(j.backupUntil) });
    this.ctx.store.log('info', I18N.t('backup.kept', { label: j.label, what }));
    return { ok: true };
  }
}

module.exports = { Backups, plan, expiryAt, mergeStatus, addedAudio, fileIssues, BLOCKED_MIN_DAYS };

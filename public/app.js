'use strict';
/* ==========================================================================
   Updaterr – webové rozhraní (bez frameworku)
   ========================================================================== */

// --- Pomocné funkce -------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ucFirst = (s) => (s ? s[0].toLocaleUpperCase(I18N.locale) + s.slice(1) : s);
const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// Jazyky z nastavení (server je posílá v přehledu): primární = hledaný dabing, druhý = obvykle originál.
// Po změně jazyků v nastavení se stránka načte znovu, takže tyhle hodnoty platí po celou dobu běhu.
const LANG = (() => {
  const l = I18N.boot?.languages || {};
  const pri = l.primary || { code: '', label: '?', name: '' };
  const sec = l.secondary || { code: '', label: '?', name: '' };
  return { pri: pri.code, sec: sec.code, P: pri.label, S: sec.label, priName: pri.name, secName: sec.name, priFlag: pri.flag, secFlag: sec.flag };
})();
const langLabel = (code) => (code === LANG.pri ? LANG.P : code === LANG.sec ? LANG.S : String(code || '?').toUpperCase());
const LP = { p: LANG.P, s: LANG.S }; // parametry překladů s jazyky
const TIER = { 3: `${LANG.P} + ${LANG.S}`, 2: LANG.P, 1: LANG.S, 0: t('tier.none', LP) };
const TIER_LONG = { 3: t('tier.long.both', LP), 2: t('tier.onlyP', LP), 1: t('tier.onlyS', LP), 0: t('tier.long.none', LP) };
const PRI_ORIG = t('tier.priOriginal', LP);
const PRI_ORIG_PAREN = t('tier.priOriginalParen', LP);
// U originálu v primárním jazyce je cílem samotný primární jazyk – nepsat "CZ + EN"
// (orig = originalLanguage z Radarru/Sonarru, anglický název jazyka)
const czOrig = (t, orig) => t === 3 && Boolean(orig) && orig === LANG.priName;
const tierChip = (t, orig, tip) => (t == null ? '' : `<span class="tier t${t}"${tip ? ` title="${esc(tip)}"` : ''}>${czOrig(t, orig) ? PRI_ORIG : TIER[t]}</span>`);
const CONF = { likely: t('conf.likely'), guess: t('common.guess') };
// Hledané jazyky položky (null = výchozí CZ i EN)
// Hodnoty jsou sloty pri/sec (primární / druhý jazyk), ne kódy jazyků
const WANT_OPTS = [['pri,sec', `${LANG.P} + ${LANG.S}`, t('want.both.help', LP)], ['pri', t('tier.onlyP', LP), t('want.pri.help', LP)], ['sec', t('tier.onlyS', LP), t('want.sec.help', LP)]];
const wantLabel = (want) => want.map((l) => (l === 'pri' ? LANG.P : l === 'sec' ? LANG.S : l.toUpperCase())).join(' + ');
const wantText = (want) => (want?.length ? t('want.only', { langs: wantLabel(want) }) : '');
// Má soubor dané úrovně všechny hledané jazyky? (u českého originálu je "3" samotná čeština)
const tierLangs = (t, orig) => (t === 3 ? (czOrig(t, orig) ? ['pri'] : ['pri', 'sec']) : t === 2 ? ['pri'] : t === 1 ? ['sec'] : []);
const meetsWant = (t, want, orig) => want.every((l) => tierLangs(t, orig).includes(l));
const wantChip = (want, tip) => `<span class="tier t3"${tip ? ` title="${esc(tip)}"` : ''}>${wantLabel(want)}</span>`;
// Hledaný formát (kodek) videa ('' = neřešit). Úrovně: 0 starší, 1 H.264, 2 H.265 / VP9, 3 AV1
const CODEC_OPTS = [
  ['', t('codec.none.label'), t('codec.none.help')],
  ['hevc', 'H.265 / AV1', t('codec.hevc.help')],
  ['av1', t('codec.av1.label'), t('codec.av1.help')],
];
const CODEC_RANK = { hevc: 2, av1: 3 };
const codecText = (codec) => (codec ? t('codec.searching', { codec: codec === 'av1' ? 'AV1' : 'H.265 / AV1' }) : '');
const codecChip = (name, ok) => (name && name !== '?' ? `<span class="chip ${ok ? 'ok' : ''}" title="${t('codec.title')}">${icon('film')}${esc(name)}</span>` : '');

function gb(b) {
  if (!b) return '–';
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)} TB`;
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}
const ts = (t) => (typeof t === 'number' ? t : Date.parse(t));
function ago(tm) {
  if (!tm) return '–';
  const s = (Date.now() - ts(tm)) / 1000;
  if (s < 45) return t('time.justNow');
  if (s < 3600) return t('time.minAgo', { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return t('time.hoursAgo', { n: Math.round(s / 3600) });
  if (s < 2 * 86400) return t('time.yesterday');
  if (s < 60 * 86400) return t('time.daysAgo', { n: Math.round(s / 86400) });
  return new Date(ts(tm)).toLocaleDateString(I18N.locale);
}
const fullDate = (t) => (t ? new Date(ts(t)).toLocaleString(I18N.locale) : '');
// Posun CZ dabingu proti EN (offsetMs = korekce pro mkvmerge --sync: záporná → dabing se zpožďuje)
const syncLag = (ms) => (ms < 0 ? t('sync.lags') : t('sync.leads'));
const syncLagSentence = (ms) => (ms < 0 ? t('sync.lagsSentence') : t('sync.leadsSentence'));
function syncWarnText(sy) {
  const series = sy.total > 1;
  return t(series && sy.bad > 1 ? 'sync.warnUpTo' : 'sync.warn', { ...LP, ms: Math.abs(sy.offsetMs) }) + (series ? ` (${t('sync.badOf', { bad: sy.bad, count: sy.total })})` : '');
}
const seedClass = (n) => (n == null ? '' : n >= 20 ? 'good' : n >= 8 ? 'ok' : 'low');
const lsGet = (k, d) => { try { const v = localStorage.getItem('updaterr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem('updaterr.' + k, JSON.stringify(v)); } catch { /* soukromé okno */ } };

async function api(method, path, body) {
  const res = await fetch('api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('err.server', { status: res.status }));
  return data;
}

function toast(msg, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `${icon(error ? 'alert' : 'check')}<div>${esc(msg)}</div>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, error ? 7000 : 3800);
}

function confirmDialog({ title, text, ok = t('common.confirm'), danger = false }) {
  const dlg = $('#confirm');
  if (!dlg.showModal) return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const btn = $('#confirm-ok');
  btn.textContent = ok;
  btn.className = `btn ${danger ? 'danger' : 'primary'}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// Tlačítko během akce: zablokovat a ukázat točící ikonu
async function busy(btn, fn, label) {
  if (!btn || btn.disabled) return;
  const html = btn.innerHTML;
  btn.disabled = true;
  if (label != null) btn.innerHTML = `${icon('refresh', 'spin')}${label ? `<span>${esc(label)}</span>` : ''}`;
  try { await fn(); } catch (e) { toast(e.message, { error: true }); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

// Statické texty z index.html (data-i18n = text, data-i18n-<atribut> = atribut)
function applyStaticI18n() {
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  for (const a of ['title', 'aria-label', 'placeholder']) $$(`[data-i18n-${a}]`).forEach((el) => el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`))));
}
applyStaticI18n();

// --- Stav ----------------------------------------------------------------------
const S = {
  tab: 'proposals',
  ov: null,
  proposals: [],
  items: [],
  jobs: [],
  log: [],
  settings: null,
  draft: {},
  last: {},              // poslední vykreslená data (bez zbytečného překreslování)
  propFilter: lsGet('propFilter', 'all'),
  lib: { q: '', app: lsGet('lib.app', ''), tier: '', status: '', watched: false, desync: false, unverified: false, sort: lsGet('lib.sort', { key: 'tier', dir: 1 }), limit: 200 },
  backups: null,
  grabbing: {},          // návrh → guid kandidáta, jehož schválení z tohohle okna ještě běží
  bkDraft: {},           // rozepsaná retence záloh (nepřepisovat při obnovení)
  logLevel: 'all',
  logQ: '',
  act: { f: lsGet('act.f', 'all'), q: '', open: new Set(), limit: 60 },
  drawer: null,          // klíč otevřené položky
  highlight: null,       // návrh k zvýraznění (#p=…)
};
const TABS = ['proposals', 'library', 'activity', 'backups', 'log', 'settings'];

// --- Navigace ------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^p=(\w+)/);
  if (m) { openProposal(m[1], false); return; }
  showTab(TABS.includes(h) ? h : 'proposals', false);
}
// Otevřít konkrétní návrh: filtr typu ho nesmí schovat
function openProposal(id, push = true) {
  S.highlight = id;
  S.propFilter = 'all';
  lsSet('propFilter', 'all');
  showTab('proposals', push);
}
function showTab(tab, push = true) {
  if (S.tab === 'settings' && tab !== 'settings' && Object.keys(S.draft).length) toast(t('toast.unsavedSettings'));
  S.tab = tab;
  $$('#tabs button').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  TABS.forEach((x) => ($(`#view-${x}`).hidden = x !== tab));
  if (push && location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  S.last[tab] = null;
  refreshTab();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
window.addEventListener('hashchange', route);

// --- Vzhled ---------------------------------------------------------------------
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function applyThemeIcon() { $('#theme').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon'); }
$('#theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('updaterr.theme', next); } catch { /* nic */ }
  applyThemeIcon();
});
applyThemeIcon();

// --- Stavový řádek ----------------------------------------------------------------
function renderPulse() {
  const ov = S.ov;
  if (!ov) return;
  // Pod 1100 px mají záložky jen ikonu – počet patří i do jména tlačítka (aria-label)
  const cnt = (id, n) => {
    const el = $(id);
    el.hidden = !n;
    el.textContent = n;
    const b = el.closest('button');
    const name = b.querySelector('span')?.textContent || '';
    b.setAttribute('aria-label', n ? `${name} (${n})` : name);
  };
  cnt('#count-proposals', ov.pending);
  cnt('#count-activity', ov.downloading);
  let dot = 'ok';
  let text;
  if (!ov.radarr && !ov.sonarr) { dot = 'err'; text = esc(t('pulse.noArr')); }
  else if (ov.setupNeeded) { dot = 'off'; text = esc(t('pulse.setup')); }
  else if (ov.searchingNow) { dot = 'busy'; text = t('pulse.searching', { name: `<b>${esc(ov.searchingNow)}</b>` }); }
  else if (!ov.scannerEnabled) { dot = 'off'; text = esc(t('pulse.scanOff')); }
  else if (ov.queue + ov.manualQueue === 0) text = esc(t('pulse.allChecked'));
  else text = `${t('pulse.queue', { n: ov.queue + ov.manualQueue })}<span class="sep"> · </span>${t('pulse.today', { n: ov.searchesToday, max: ov.maxSearchesPerDay })}`;
  $('#pulse').innerHTML = `<i class="dot ${dot}"></i><span>${text}</span>`;
  const banner = $('#banner');
  const msg = ov.setupNeeded
    ? `${icon('alert')}<span>${t('banner.setup')}</span> <a href="#settings" data-act="tab" data-tab="settings">${t('nav.settings')} → ${t('settings.lang.title')}</a>`
    : ov.readOnly ? `${icon('eye')}<span>${t('banner.readOnly')}</span>` : '';
  banner.hidden = !msg;
  if (banner.innerHTML !== msg) banner.innerHTML = msg;
  $('#pulse').title = t('pulse.lastSync', { ago: ago(ov.lastSync) });
}

// ===================================================================================
// Návrhy
// ===================================================================================
function kindBadge(c) {
  const setChip = c.set ? `<span class="chip">${icon('layers')}${t('kind.set', { count: c.parts?.length || 1 })}</span>` : '';
  if (c.kind === 'merge') return `<span class="chip accent">${icon('merge')}${t('kind.merge', { lang: langLabel(c.mergeLang) })}</span>${setChip}`;
  if (c.set) return setChip;
  if (c.seasons?.length > 1) return `<span class="chip">${icon('layers')}${t('kind.pack', { from: c.seasons[0], to: c.seasons[c.seasons.length - 1] })}</span>`;
  if (c.kind === 'codec') return `<span class="chip">${icon('zap')}${t('kind.codec')}</span>`;
  if (c.kind === 'cutmatch') return `<span class="chip accent" title="${esc(t('kind.cutmatchTitle', { lang: langLabel(c.donor?.mergeLang) }))}">${icon('merge')}${t('kind.cutmatch', { lang: langLabel(c.donor?.mergeLang) })}</span>`;
  if (c.kind === 'repair') return `<span class="chip warn">${icon('alert')}${t('kind.repair')}</span>`;
  return c.kind === 'quality' ? `<span class="chip">${icon('up')}${t('kind.quality')}</span>` : `<span class="chip">${icon('sparkles')}${t('kind.language')}</span>`;
}

// Useknutý/poškozený soubor filmu (library.js truncationOf): soubor výrazně kratší než film
const truncText = (x) => t('trunc.text', { file: x.fileMin, runtime: x.runtimeMin });
const truncTitle = () => t('trunc.title');

function poster(url, cls = 'poster') {
  const ph = `<div class="${cls} ph">${icon('film', 'lg')}</div>`;
  return url ? `<img class="${cls}" loading="lazy" src="${esc(url)}" alt="" onerror="this.outerHTML=this.dataset.ph" data-ph="${esc(ph)}">` : ph;
}

// Guid kandidáta, který se právě schvaluje – ze serveru (i když schválení přišlo z Telegramu/ntfy), nebo z tohohle okna
const approvingGuid = (p) => p.approving || S.grabbing[p.id] || null;

function optionRow(p, c, i, pending) {
  const chosen = p.status === 'grabbed' && (p.grabbedGuid ? p.grabbedGuid === c.guid && (!p.grabbedKind || p.grabbedKind === c.kind) : p.grabbedIdx === i);
  const title = /^https?:\/\//i.test(c.infoUrl || '') ? `<a href="${esc(c.infoUrl)}" target="_blank" rel="noreferrer noopener">${esc(c.title)}</a>` : esc(c.title);
  const notes = (c.notes || []).map((n) => `<span class="note">${esc(n)}</span>`).join('') +
    (c.badDonorId && pending ? `<button class="btn ghost sm o-retry" data-act="retrymerge" data-id="${esc(c.badDonorId)}" title="${esc(t('option.retryMergeTitle'))}">${icon('merge')}<span>${t('option.retryMerge')}</span></button>` : '');
  const warns = (c.warnings || []).map((w) => `<span class="warn-text">${icon('alert')}${esc(w)}</span>`).join('');
  const merge = c.kind === 'merge';
  // U sady se seedy berou z nejslabšího torrentu, velikost se sčítá
  const multiPart = c.set && c.parts?.length > 1;
  // Návrh se právě schvaluje (ověření může trvat i minuty) – po překreslení nenabízet znovu „Stáhnout“
  const approving = approvingGuid(p);
  const off = approving ? ' disabled' : '';
  const action = pending
    ? `<button class="btn ${merge ? 'success' : 'primary'}" data-act="grab" data-p="${p.id}" data-c="${esc(c.cid)}"${off}>${approving === c.guid ? `${icon('refresh', 'spin')}<span>${t('common.verifying')}</span>` : `${icon(merge ? 'merge' : 'download')}<span>${merge ? t('option.addAudio') : t('common.download')}</span>`}</button>
       <button class="icon-btn sm" data-act="skip" data-p="${p.id}" data-guid="${esc(c.guid)}" title="${t('option.skipTitle')}" aria-label="${t('option.skip')}"${off}>${icon('x')}</button>`
    : chosen ? `<span class="chip ok">${icon('check')}${t('option.chosen')}</span>` : '';
  return `<div class="option ${i === 0 && pending ? 'best' : ''} ${chosen ? 'chosen' : ''}">
    <div>
      <div class="o-top">${kindBadge(c)}${tierChip(c.tier)}${c.kind !== 'merge' && (c.kind === 'codec' || p.item?.codec) ? codecChip(c.vcodecName, c.vcodec >= CODEC_RANK[p.item?.codec]) : ''}${CONF[c.confidence] ? `<span class="chip warn" title="${t('option.guessTitle')}">${CONF[c.confidence]}</span>` : ''}${c.smallest ? `<span class="chip ok" title="${t('option.smallestTitle')}">${t('option.smallest')}</span>` : ''}${i === 0 && pending ? `<span class="best-tag">${t('option.best')}</span>` : ''}</div>
      <div class="o-title">${title}</div>
      ${notes || warns ? `<div class="o-sub">${notes}${warns}</div>` : ''}
    </div>
    <div class="o-right">
      <div class="o-metrics">
        <div class="m"><span class="seeds ${seedClass(c.seeders)}">${c.seeders ?? '–'}</span><small>${multiPart ? t('option.minSeeds') : t('option.seeds')}</small></div>
        <div class="m"><span class="num">${gb(c.size)}</span><small>${merge ? t('option.toDownload') : multiPart || c.kind === 'cutmatch' ? t('option.total') : t('option.size')}</small></div>
        <div class="m"><span>${esc(c.indexer)}</span><small>${c.ageDays != null ? t(multiPart ? 'option.oldest' : 'option.age', { n: c.ageDays }) : ''}</small></div>
      </div>
      <div class="o-actions">${action}</div>
    </div>
  </div>`;
}

// "2. série: CZ + EN" / "1., 3.–5. série: EN" – stav ostatních sérií seriálu (návrh se jich netýká)
function otherSeasonsNote(list, orig) {
  if (!list?.length) return '';
  const byTier = new Map();
  for (const x of list) byTier.set(x.tier, [...(byTier.get(x.tier) || []), x.season]);
  const ranges = (nums) => nums.reduce((acc, n) => {
    const last = acc[acc.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else acc.push([n, n]);
    return acc;
  }, []).map(([a, b]) => (a === b ? t('proposals.seasonNum', { n: a }) : `${t('proposals.seasonNum', { n: a })}–${t('proposals.seasonNum', { n: b })}`)).join(', ');
  const parts = [...byTier].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))
    .map(([x, seasons]) => t('proposals.otherSeasons', { count: seasons.length, seasons: ranges(seasons), tier: x == null ? t('proposals.notDownloaded') : czOrig(x, orig) ? PRI_ORIG : TIER[x] }));
  return `<span class="sep"></span><span title="${t('proposals.otherSeasonsTitle')}">${esc(parts.join(' · '))}</span>`;
}

// Současný jazyk. S vybranými jazyky jen to, jestli je hledaný jazyk splněný ("CZ 4/8 ep."), skutečné stopy v tooltipu.
function currentChips(cur, it) {
  const tip = cur.audio ? t('proposals.audioTip', { audio: cur.audio }) : '';
  const want = it.want;
  if (!want?.length) return tierChip(cur.tier, it.originalLanguage, tip) + epsMixed(cur.tierCounts, cur.tier);
  const counts = cur.tierCounts;
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const ok = counts ? [3, 2, 1, 0].reduce((a, t) => a + (meetsWant(t, want, it.originalLanguage) ? counts[t] : 0), 0) : 0;
  if (counts && ok > 0 && ok < total) return `<span class="tier t1" title="${esc(tip)}">${t('proposals.wantEps', { langs: wantLabel(want), ok, total })}</span>`;
  if (counts ? ok === total && total > 0 : meetsWant(cur.tier, want, it.originalLanguage)) return wantChip(want, tip);
  return tierChip(cur.tier, it.originalLanguage, tip);
}

function proposalCard(p) {
  const it = p.item || {};
  const cur = p.current || {};
  const pending = p.status === 'pending';
  const best = p.candidates?.[0] || {};
  const afterQuality = best.kind === 'merge' ? cur.quality : best.quality;
  const status = { grabbed: ['ok', 'check', t('proposals.status.grabbed')], rejected: ['', 'ban', t('proposals.status.rejected')], expired: ['warn', 'clock', t('proposals.status.expired')] }[p.status];
  const off = approvingGuid(p) ? ' disabled' : '';
  return `<article class="card proposal ${pending ? '' : 'settled'} ${S.highlight === p.id ? 'flash' : ''}" id="p-${p.id}">
    ${poster(it.poster)}
    <div>
      <div class="p-head">
        <div>
          <h2 class="p-title">${icon(it.app === 'sonarr' ? 'tv' : 'film')}${esc(p.label)}</h2>
          <div class="p-meta">
            <span>${it.app === 'sonarr' ? t('common.series') : t('common.movie')}</span>
            ${it.originalLanguage ? `<span class="sep"></span><span>${t('common.original', { lang: esc(it.originalLanguage) })}</span>` : ''}
            <span class="sep"></span><span title="${esc(fullDate(p.updatedAt))}">${t('proposals.found', { ago: ago(p.updatedAt) })}</span>
            ${otherSeasonsNote(p.otherSeasons, it.originalLanguage)}
            ${it.want ? `<span class="sep"></span><span>${wantText(it.want)}</span>` : ''}
            ${it.codec ? `<span class="sep"></span><span>${codecText(it.codec)}</span>` : ''}
            ${it.watch ? `<span class="chip accent">${icon('eye')}${t('proposals.watched')}</span>` : ''}
          </div>
        </div>
        ${status ? `<span class="chip ${status[0]}">${icon(status[1])}${status[2]}${p.note ? ` – ${esc(p.note)}` : ''}</span>` : ''}
      </div>
      <div class="compare">
        <div class="side"><span class="lbl">${t('proposals.now')}</span>${currentChips(cur, it)}<span class="chip">${esc(cur.quality)}</span>${it.codec ? codecChip(cur.vcodecName) : ''}
          ${cur.truncated ? `<span class="chip warn" title="${esc(truncTitle())}">${icon('alert')}${esc(truncText(cur.truncated))}</span>` : ''}
          ${cur.audioSource === 'nazev' ? `<span class="chip warn" title="${t('proposals.nameGuessTitle')}">${t('common.guess')}</span>` : ''}
          ${cur.audioSource === 'poslech' ? `<span class="chip ok" title="${esc(t('proposals.speechTitle', { tag: cur.tagAudio || '?', audio: cur.audio }))}">${icon('check')}${t('common.verifiedBySpeech')}</span>` : ''}</div>
        ${best.tier != null ? `${icon('arrow')}<div class="side"><span class="lbl">${t('proposals.best')}</span>${it.want?.length && meetsWant(best.tier, it.want, it.originalLanguage) ? wantChip(it.want, t('proposals.releaseHas', { tier: TIER[best.tier] })) : tierChip(best.tier)}<span class="chip">${esc(afterQuality)}</span>${it.codec ? codecChip(best.kind === 'merge' ? cur.vcodecName : best.vcodecName, best.kind !== 'merge' && best.vcodec >= CODEC_RANK[it.codec]) : ''}
          ${best.kind === 'merge' ? `<span class="chip accent">${icon('merge')}${t('proposals.videoStays')}</span>` : ''}</div>` : ''}
      </div>
      <div class="options">${(p.candidates || []).map((c, i) => optionRow(p, c, i, pending)).join('')}</div>
      ${pending ? `<div class="p-foot">
        <button class="btn ghost sm" data-act="recheck" data-key="${esc(p.itemKey)}"${off}>${icon('refresh')}${t('proposals.searchAgain')}</button>
        <button class="btn ghost sm" data-act="reject" data-p="${p.id}" data-days="30"${off}>${icon('pause')}${t('proposals.snooze')}</button>
        <button class="btn ghost sm danger" data-act="reject" data-p="${p.id}" data-days="3650"${off}>${icon('ban')}${t('proposals.reject')}</button>
        <span class="spacer"></span>
        ${it.key ? `<button class="btn ghost sm" data-act="open" data-key="${esc(it.key)}">${t('proposals.detail')}${icon('chevron')}</button>` : ''}
      </div>` : ''}
    </div>
  </article>`;
}

function renderProposals() {
  const el = $('#view-proposals');
  const pending = S.proposals.filter((p) => p.status === 'pending');
  const settled = S.proposals.filter((p) => p.status !== 'pending');
  const kinds = {
    all: () => true,
    language: (p) => p.candidates?.some((c) => c.kind === 'language'),
    merge: (p) => p.candidates?.some((c) => c.kind === 'merge' || c.kind === 'cutmatch'),
    quality: (p) => p.candidates?.some((c) => c.kind === 'quality'),
    codec: (p) => p.candidates?.some((c) => c.kind === 'codec'),
    repair: (p) => p.candidates?.some((c) => c.kind === 'repair'),
  };
  if (!kinds[S.propFilter]) S.propFilter = 'all';
  const shown = pending.filter(kinds[S.propFilter]);
  const n = (k) => pending.filter(kinds[k]).length;
  const ov = S.ov || {};

  let body;
  if (!pending.length && ov.setupNeeded) {
    body = `<div class="card empty">${icon('mic', 'xl')}
      <h3>${t('proposals.setup.title')}</h3>
      <p>${t('proposals.setup.text')}</p>
      <button class="btn primary" data-act="tab" data-tab="settings">${icon('settings')}${t('proposals.setup.button')}</button></div>`;
  } else if (!pending.length) {
    const eta = ov.queue ? Math.round((ov.queue * (S.settings?.settings?.searchIntervalSec || 90)) / 3600) : 0;
    body = `<div class="card empty">${icon('inbox', 'xl')}
      <h3>${t('proposals.empty.title')}</h3>
      <p>${ov.queue ? t('proposals.empty.scanning', { items: t('count.items', { count: ov.queue }), eta: eta ? ` ${t('proposals.empty.eta', { dur: t('count.hours', { count: eta }) })}` : '' }) : t('proposals.empty.done')}</p>
      <button class="btn" data-act="tab" data-tab="library">${icon('library')}${t('proposals.empty.openLibrary')}</button></div>`;
  } else if (!shown.length) {
    body = `<div class="card empty"><h3>${t('proposals.noneInFilter')}</h3><p>${t('proposals.tryOtherFilter')}</p></div>`;
  } else {
    body = shown.map(proposalCard).join('');
  }

  // Při obnově drž na místě kartu, kterou má uživatel zrovna na očích (nové návrhy nad ní by jinak stránku posunuly).
  // Jen čekající návrhy: schválený se přesune do Vyřízených na konec stránky – na jeho místo pak přijde další v pořadí.
  let anchor = null;
  if (window.scrollY > 0) {
    const cards = [...el.querySelectorAll('article.proposal')].filter((c) => !c.closest('details.history'));
    const i = cards.findIndex((c) => c.getBoundingClientRect().bottom > 0);
    if (i >= 0) anchor = { ids: cards.slice(i).map((c) => c.id), top: cards[i].getBoundingClientRect().top };
  }

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${t('proposals.title')}</h1>
        <p>${ov.setupNeeded ? t('proposals.leadSetup') : t('proposals.lead', { order: `<b>${esc(TIER[3])}</b> › <b>${esc(LANG.P)}</b> › <b>${esc(LANG.S)}</b>` })}</p>
      </div>
      ${pending.length ? `<div class="segmented" role="group" aria-label="${t('proposals.filterLabel')}">
        ${[['all', t('common.all'), pending.length], ['language', t('common.language'), n('language')], ['merge', t('proposals.filter.merge'), n('merge')], ['quality', t('common.quality'), n('quality')], ['codec', t('proposals.filter.codec'), n('codec')], ['repair', t('proposals.filter.repair'), n('repair')]]
          .filter(([k, , c]) => k === 'all' || c)
          .map(([k, l, c]) => `<button data-act="pfilter" data-f="${k}" aria-pressed="${S.propFilter === k}">${l} <span class="muted">${c}</span></button>`).join('')}
      </div>` : ''}
    </div>
    ${body}
    ${settled.length ? `<details class="history" ${lsGet('historyOpen', false) ? 'open' : ''}>
      <summary class="section-title">${icon('chevron')}${t('proposals.history', { n: settled.length })}</summary>
      ${settled.map(proposalCard).join('')}
    </details>` : ''}`;
  $('details.history', el)?.addEventListener('toggle', (e) => lsSet('historyOpen', e.target.open));
  const same = anchor?.ids.map((id) => document.getElementById(id)).find((c) => c && !c.closest('details.history'));
  if (same) window.scrollBy(0, same.getBoundingClientRect().top - anchor.top);

  if (S.highlight) {
    const card = $(`#p-${S.highlight}`);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    S.highlight = null;
    history.replaceState(null, '', '#proposals');
  }
}

// ===================================================================================
// Knihovna
// ===================================================================================
const STATUS = {
  ok: t('status.ok'), proposal: t('status.proposal'), unchecked: t('status.unchecked'), waiting: t('status.waiting'),
  ignored: t('status.ignored'), downloading: t('status.downloading'), searching: t('status.searching'), fixing: t('status.fixing'),
};

// Posunutý dabing, který se dá opravit hned (pro položku zrovna nic neběží)
const syncFixable = (i) => i.sync?.warn && !i.downloadId;

function libFiltered() {
  const L = S.lib;
  const q = fold(L.q.trim());
  const list = S.items.filter((i) =>
    (!L.app || i.app === L.app) &&
    (L.tier === '' || String(i.current.tier) === L.tier) &&
    (!L.status || i.status === L.status) &&
    (!L.watched || i.watch) &&
    (!L.desync || i.sync?.warn) &&
    (!L.unverified || !heard(i)) &&
    (!q || fold(i.label).includes(q)));
  const key = {
    label: (i) => i.label,
    tier: (i) => i.current.tier,
    quality: (i) => i.current.qrank ?? 0,
    status: (i) => i.status,
    checked: (i) => i.lastSearchedAt || '',
  }[L.sort.key] || ((i) => i.label);
  return list.sort((a, b) => {
    const x = key(a), y = key(b);
    return (compareValues(x, y) || textCompare(a.label, b.label)) * L.sort.dir;
  });
}

// U smíšené série: kolik epizod je na tom líp než nejhorší ("1/6 ep. EN")
function epsMixed(counts, tier) {
  if (!counts) return '';
  const total = counts.reduce((a, b) => a + b, 0);
  const better = [3, 2, 1].filter((t) => t > tier && counts[t]);
  if (!better.length) return '';
  return `<span class="chip" title="${t('library.mixedTip', { list: [3, 2, 1, 0].filter((x) => counts[x]).map((x) => `${TIER[x]}: ${counts[x]}`).join(', ') })}">${better.map((x) => t('library.epsAlready', { n: counts[x], total, tier: TIER[x] })).join(' · ')}</span>`;
}

function epsBar(counts) {
  if (!counts) return '';
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return `<div class="eps" title="${t('library.epsTip', { list: [3, 2, 1, 0].map((x) => `${TIER[x]} ${counts[x]}`).join(', ') })}">${[3, 2, 1, 0].filter((t) => counts[t]).map((t) => `<div style="flex:${counts[t] / total};background:var(--t${t})"></div>`).join('')}</div>`;
}

function libRow(i) {
  const lr = i.lastResult;
  const checked = lr?.error
    ? `<span class="warn-text" title="${esc(lr.error)}">${icon('alert')}${t('common.errorWord')}</span>`
    : i.lastSearchedAt ? `<span title="${esc(fullDate(i.lastSearchedAt))}">${ago(i.lastSearchedAt)}</span>` : '<span class="muted">–</span>';
  return `<tr data-key="${esc(i.key)}" tabindex="0">
    <td class="hide-m">${i.poster ? `<img class="thumb" loading="lazy" src="${esc(i.poster)}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="thumb"></div>'}</td>
    <td class="t-name">${esc(i.label)}${i.originalLanguage && i.originalLanguage !== LANG.secName ? `<small>${t('common.original', { lang: esc(i.originalLanguage) })}</small>` : ''}${i.want ? `<small>${wantText(i.want)}</small>` : ''}${i.codec ? `<small>${codecText(i.codec)}</small>` : ''}${i.current.truncated ? `<small class="sync-warn" title="${esc(truncTitle())}">${icon('alert')}${esc(truncText(i.current.truncated))}</small>` : ''}${i.sync?.warn ? `<small class="sync-warn" title="${esc(t('library.syncTip', { ...LP, lag: syncLagSentence(i.sync.offsetMs).toLowerCase() }))}">${icon('alert')}${esc(syncWarnText(i.sync))}</small>` : ''}<small class="show-m"><span class="status s-${i.status}">${STATUS[i.status] || i.status}</span></small></td>
    <td>${tierChip(i.current.tier, i.originalLanguage)}${epsBar(i.current.tierCounts)}</td>
    <td class="hide-m"><div class="audio" title="${esc(i.current.audio)}">${esc(i.current.audio)}${i.current.audioSource === 'nazev' ? ` <span class="chip warn">${t('common.guess')}</span>` : ''}${i.current.audioSource === 'poslech' ? ` <span class="chip ok" title="${esc(t('library.tagTip', { tag: i.current.tagAudio || '?' }))}">${t('library.bySpeech')}</span>` : heard(i) ? ` <span class="heard" title="${esc(t('library.heardTip'))}">${icon('headphones')}</span>` : ''}</div></td>
    <td class="hide-m nowrap">${esc(i.current.quality)}${i.current.vcodecName && i.current.vcodecName !== '?' ? `<small class="muted">${esc(i.current.vcodecName)}</small>` : ''}</td>
    <td class="hide-m"><span class="status s-${i.status}">${STATUS[i.status] || i.status}</span></td>
    <td class="hide-m nowrap small">${checked}</td>
    <td><div class="row-actions">
      <button class="icon-btn sm ${i.watch ? 'on' : ''}" data-act="watch" data-key="${esc(i.key)}" title="${i.watch ? t('library.watchOn') : t('library.watchOff')}${i.app === 'sonarr' ? ` ${t('common.wholeSeries')}` : ''}" aria-pressed="${Boolean(i.watch)}" aria-label="${t('library.watch')}">${icon('eye')}</button>
      <button class="icon-btn sm" data-act="recheck" data-key="${esc(i.key)}" title="${t('common.searchNow')}" aria-label="${t('common.searchNow')}">${icon('search')}</button>
    </div></td>
  </tr>`;
}

// --- Hromadná kontrola a poslech ----------------------------------------------------
// Ověřeno poslechem (pro aktuální soubory)
const heard = (i) => Boolean(i.langCheck && !i.langCheck.error);

// Odhad délky poslechu: průměr z už ověřených položek (film ~1 soubor, série 3 epizody)
function listenSec(items) {
  const avg = (app, dflt) => {
    const ms = S.items.filter((i) => i.app === app && heard(i) && i.langCheck.ms).map((i) => i.langCheck.ms);
    return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length / 1000 : dflt;
  };
  const per = { radarr: avg('radarr', 25), sonarr: avg('sonarr', 75) };
  return items.reduce((a, i) => a + (per[i.app] || 30), 0);
}

function duration(sec) {
  if (sec < 90) return t('duration.fewMinutes');
  if (sec < 3600) return t('count.minutes', { count: Math.round(sec / 60) });
  const h = sec / 3600;
  return h < 10 ? `${(Math.round(h * 2) / 2).toLocaleString(I18N.locale)} h` : t('count.hours', { count: Math.round(h) });
}

// Pruh v Knihovně: kolik je ověřeno poslechem a průběh hromadného poslechu
function renderListen(scope) {
  const el = $('#lib-listen');
  if (!el) return;
  const q = S.ov?.langQueue || {};
  if (!S.ov?.speech) { el.hidden = true; return; }
  const done = scope.filter(heard).length;
  const total = scope.length || 1;
  const running = q.queued > 0;
  const left = running && S.items.length ? (listenSec(S.items) / S.items.length) * q.queued : 0;
  el.hidden = false;
  el.classList.toggle('on', running);
  el.innerHTML = `
    <span class="listen-ic">${icon('headphones', running ? 'pulse-ic' : '')}</span>
    <div class="listen-main">
      ${running
        ? `<div class="listen-line"><b>${t('listen.running', { n: q.done + (q.current ? 1 : 0), total: q.total })}</b><span class="muted"> · ${q.current ? esc(q.current) : t('listen.continuing')}</span></div>
           <small>${t('listen.left', { dur: duration(left) })}${q.corrected ? ` · <span class="warn-text">${t('listen.corrected', { n: q.corrected })}</span>` : ''}${q.failed ? ` · ${t('listen.failed', { n: q.failed })}` : ''}</small>`
        : `<div class="listen-line"><b>${t('listen.verified', { n: done, total: scope.length })}</b></div>
           <small>${done === scope.length ? t('listen.allOk') : t('listen.restByTags')}</small>`}
      <span class="listen-bar"><i style="width:${((running ? q.done / (q.total || 1) : done / total) * 100).toFixed(1)}%"></i></span>
    </div>
    ${running
      ? `<button class="btn sm ghost" data-act="listencancel">${t('listen.stop')}</button>`
      : done < scope.length ? `<button class="btn sm ghost" data-act="lunverified" aria-pressed="${S.lib.unverified}">${S.lib.unverified ? t('listen.showAll') : t('listen.showUnverified')}</button>` : ''}`;
}

// Dialog hromadné kontroly – vrací zvolenou akci, nebo null
function bulkDialog() {
  const dlg = $('#bulk');
  const scope = S.items.filter((i) => !S.lib.app || i.app === S.lib.app);
  const where = t({ radarr: 'bulk.scope.movies', sonarr: 'bulk.scope.series' }[S.lib.app] || 'bulk.scope.all');
  const sec = S.settings?.settings?.searchIntervalSec || 90;
  const q = S.ov?.langQueue || {};
  const model = S.settings?.settings?.speechModel;
  const unheard = scope.filter((i) => !heard(i));
  const opts = [];
  if (S.ov?.speech) {
    opts.push({ group: t('bulk.group.listen') },
      { v: 'listen', n: unheard.length, t: t('bulk.listen.title'), d: t('bulk.listen.text'),
        time: listenSec(unheard), badge: unheard.length ? t('bulk.recommended') : '' },
      { v: 'listen-all', n: scope.length, t: t('bulk.listenAll.title'),
        d: t(model ? 'bulk.listenAll.textModel' : 'bulk.listenAll.text', { model }), time: listenSec(scope) });
  }
  opts.push({ group: t('bulk.group.search') });
  for (const tier of [1, 2]) {
    const n = scope.filter((i) => i.current.tier <= tier).length;
    opts.push({ v: `search-${tier}`, n, t: t(tier === 1 ? 'bulk.search1.title' : 'bulk.search2.title', LP),
      d: t(tier === 1 ? 'bulk.search1.text' : 'bulk.search2.text', LP), time: n * sec });
  }
  const first = opts.find((o) => o.v && o.n);
  $('#bulk-body').innerHTML = `
    <p>${t('bulk.intro', { where, items: t('count.items', { count: scope.length }) })}</p>
    ${q.queued ? `<p class="note">${icon('headphones')} ${t('bulk.alreadyRunning', { n: q.queued, total: q.total })}</p>` : ''}
    <div class="bulk-opts" role="radiogroup">
      ${opts.map((o) => (o.group ? `<div class="bulk-group">${esc(o.group)}</div>` : `
        <label class="bulk-opt ${o.n ? '' : 'off'}">
          <input type="radio" name="bulk" value="${o.v}" ${o === first ? 'checked' : ''} ${o.n ? '' : 'disabled'}>
          <span class="bulk-txt"><b>${esc(o.t)}${o.badge ? ` <span class="chip ok">${o.badge}</span>` : ''}</b><small>${esc(o.d)}</small></span>
          <span class="bulk-n"><b>${o.n}</b><small>${o.n ? `~${duration(o.time)}` : t('bulk.nothing')}</small></span>
        </label>`)).join('')}
    </div>`;
  $('#bulk-ok').disabled = !first;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    resolve(dlg.returnValue === 'ok' ? dlg.querySelector('input[name="bulk"]:checked')?.value || null : null);
  }, { once: true }));
}

function renderLibrary(full = true) {
  const el = $('#view-library');
  const L = S.lib;
  const scope = S.items.filter((i) => !L.app || i.app === L.app);
  const counts = [0, 0, 0, 0];
  scope.forEach((i) => counts[i.current.tier]++);
  const total = scope.length || 1;
  const watched = scope.filter((i) => i.watch).length;
  const desync = scope.filter((i) => i.sync?.warn).length;
  const sc = S.ov?.syncCheck || {};
  // Měří se jen soubory s CZ i EN ověřenými ze stop (ne odhad z názvu, ne české dílo jen s CZ)
  const measurable = scope.filter((i) => i.syncable).length;
  const measured = scope.filter((i) => i.syncable && i.sync).length;
  const list = libFiltered();
  const movies = S.items.filter((i) => i.app === 'radarr').length;
  const seasons = S.items.length - movies;

  if (full || !$('#lib-table')) {
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${t('nav.library')}</h1>
          <p>${t('library.lead', { movies: t('count.movies', { count: movies }), seasons: t('library.countSeasons', { count: seasons }) })}</p>
        </div>
        <div class="toolbar">
          <button class="btn" data-act="bulk" title="${t('library.bulkTitle')}">${icon('layers')}${t('library.bulk')}</button>
          <button class="icon-btn" data-act="sync" title="${t('library.syncTitle')}" aria-label="${t('library.syncLabel')}">${icon('refresh')}</button>
        </div>
      </div>
      <div class="stats" id="lib-stats"></div>
      <div class="dist" id="lib-dist"></div>
      <div class="listen" id="lib-listen" hidden></div>
      <div class="toolbar" style="margin-bottom:12px">
        <label class="search"><span class="sr-only">${t('common.search')}</span>${icon('search')}<input class="input" id="lib-q" type="search" placeholder="${t('library.searchPlaceholder')}" value="${esc(L.q)}"></label>
        <div class="segmented" role="group" aria-label="${t('library.typeLabel')}">
          ${[['', t('common.all')], ['radarr', t('library.movies')], ['sonarr', t('library.series')]].map(([v, l]) => `<button data-act="lapp" data-v="${v}" aria-pressed="${L.app === v}">${l}</button>`).join('')}
        </div>
        <select class="select" id="lib-status" aria-label="${t('common.status')}">
          <option value="">${t('library.anyStatus')}</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${L.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span id="lib-fixall"></span>
        <span class="spacer"></span>
        <span class="muted small" id="lib-count"></span>
      </div>
      <div class="table-wrap"><div class="table-scroll"><table class="lib" id="lib-table">
        <thead><tr>
          <th class="hide-m"></th>
          <th data-sort="label">${t('library.col.title')}</th><th data-sort="tier">${t('common.language')}</th><th class="hide-m">${t('common.audioTracks')}</th>
          <th class="hide-m" data-sort="quality">${t('common.quality')}</th><th class="hide-m" data-sort="status">${t('common.status')}</th><th class="hide-m" data-sort="checked">${t('library.col.checked')}</th><th></th>
        </tr></thead><tbody></tbody></table></div><div class="more" id="lib-more" hidden></div></div>`;
    $('#lib-q').addEventListener('input', (e) => { L.q = e.target.value; L.limit = 200; renderLibrary(false); });
    $('#lib-status').addEventListener('change', (e) => { L.status = e.target.value; L.limit = 200; renderLibrary(false); });
  }

  $('#lib-stats').innerHTML = [3, 2, 1, 0].map((t) => `
    <button class="stat" data-act="ltier" data-t="${t}" aria-pressed="${L.tier === String(t)}">
      <span class="l"><i style="background:var(--t${t})"></i>${TIER_LONG[t]}</span>
      <span class="v">${counts[t]}<small>${Math.round((counts[t] / total) * 100)} %</small></span>
      <span class="bar" style="width:${(counts[t] / total) * 100}%;background:var(--t${t})"></span>
    </button>`).join('') + `
    <button class="stat" data-act="lwatched" aria-pressed="${L.watched}">
      <span class="l">${icon('eye')}${t('library.stat.watched')}</span><span class="v">${watched}</span>
    </button>
    <button class="stat ${desync ? 'warn' : ''}" data-act="ldesync" aria-pressed="${L.desync}" title="${esc(sc.checking ? t('library.measuringNow', { name: sc.checking }) : sc.enabled === false ? t('library.stat.syncOff') : t('library.stat.syncInfo', LP))}">
      <span class="l">${icon('alert')}${t('library.stat.desync')}</span>
      <span class="v">${desync}<small>${t('library.stat.measured', { n: measured, total: measurable })}</small></span>
      ${measurable ? `<span class="bar" style="width:${(measured / measurable) * 100}%;background:var(--border-strong)"></span>` : ''}
    </button>`;
  $('#lib-dist').innerHTML = [3, 2, 1, 0].filter((t) => counts[t]).map((t) => `<div style="flex:${counts[t]};background:var(--t${t})" title="${TIER_LONG[t]}: ${counts[t]}"></div>`).join('');
  $$('#lib-table th[data-sort]').forEach((th) => {
    th.innerHTML = th.textContent.replace(/[↑↓]/g, '').trim() + (L.sort.key === th.dataset.sort ? ` <span class="arrow">${L.sort.dir > 0 ? '↑' : '↓'}</span>` : '');
    th.setAttribute('aria-sort', L.sort.key === th.dataset.sort ? (L.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  renderListen(scope);
  $('#lib-count').textContent = t('library.count', { n: list.length, total: S.items.length });
  const fixable = L.desync ? list.filter(syncFixable) : [];
  $('#lib-fixall').innerHTML = fixable.length ? `<button class="btn primary" data-act="syncfixall" title="${t('library.fixAllTitle')}">${icon('zap')}${t('library.fixAll', { n: fixable.length })}</button>` : '';
  $('#lib-table tbody').innerHTML = list.length
    ? list.slice(0, L.limit).map(libRow).join('')
    : `<tr><td colspan="8"><div class="empty" style="padding:40px">${t('library.noMatch')}</div></td></tr>`;
  const more = $('#lib-more');
  more.hidden = list.length <= L.limit;
  more.innerHTML = `<button class="btn ghost" data-act="lmore">${t('library.more', { n: Math.min(200, list.length - L.limit) })}</button>`;
}

// --- Detail položky ---------------------------------------------------------------
const STAT_LABELS = {
  total: t('drawer.stat.total'), notBetter: t('drawer.stat.notBetter'), dead: t('drawer.stat.dead'), junk: t('drawer.stat.junk'), rejected: t('drawer.stat.rejected'),
  res: t('drawer.stat.res'), size: t('drawer.stat.size'), ignored: t('drawer.stat.ignored'), notPack: t('drawer.stat.notPack'), multiSeason: t('drawer.stat.multiSeason'),
};

// Výsledek ověření jazyka poslechem (whisper) v detailu položky
// Kódy jazyků (ISO 639-1) → název v jazyce UI; 'other' = jazyk mimo tabulku
const LANG_NAME = (code) => (code === 'other' ? t('langcheck.otherLang') : code ? langName(code) : null);
function langCheckHtml(it) {
  if (!S.ov?.speech) return '';
  const lc = it.langCheck;
  const btn = `<button class="btn sm" data-act="verifylang" data-key="${esc(it.key)}">${icon('search')}${lc ? t('langcheck.again') : t('langcheck.verify')}</button>`;
  if (it.langChecking) return `<div class="d-sec"><h4>${t('langcheck.title')}</h4><p class="note">${icon('refresh', 'spin')} ${t('langcheck.listening')}</p></div>`;
  if (!lc) return `<div class="d-sec"><h4>${t('langcheck.title')}</h4><p class="note" style="margin:0 0 8px">${t('langcheck.intro')}</p>${btn}</div>`;
  if (lc.error) return `<div class="d-sec"><h4>${t('langcheck.title')}</h4><p class="warn-text">${icon('alert')}${esc(lc.error)}</p>${btn}</div>`;
  const rows = (lc.files || []).map((f) => `
    ${lc.files.length > 1 ? `<dt class="mono" style="grid-column:1/-1;margin-top:4px">${esc(f.name)}</dt>` : ''}
    ${f.tracks.map((tr, i) => `<dt>${t('langcheck.track', { n: i + 1 })}${tr.title ? ` <span class="muted small">${esc(tr.title)}</span>` : ''}</dt><dd>
      ${t('langcheck.tag', { lang: esc(LANG_NAME(tr.tag) || t('langcheck.noTag')) })} · ${t('langcheck.heard', { lang: tr.detected ? `${esc(langName(tr.detected))} <span class="muted small">(${t('langcheck.confidence', { pct: Math.round((tr.confidence || 0) * 100), n: tr.samples })})</span>` : `<span class="muted">${t('langcheck.noSpeech')}</span>` })}
      ${tr.corrected ? `<span class="chip warn">${t('langcheck.correctedTo', { lang: esc(LANG_NAME(tr.used) || tr.used) })}</span>` : ''}</dd>`).join('')}`).join('');
  return `<div class="d-sec"><h4>${t('langcheck.title')}</h4>
    <p style="margin:0 0 8px">${lc.corrected ? `<span class="warn-text">${icon('alert')}${t('langcheck.wrong', { tier: `<b>${czOrig(lc.tier, it.originalLanguage) ? PRI_ORIG_PAREN : TIER[lc.tier]}</b>` })}</span>` : `<span class="chip ok">${icon('check')}${t('langcheck.ok')}</span>`}
      <span class="muted small">${ago(lc.at)}${lc.sampled > 1 ? `, ${t('langcheck.sampled', { n: lc.sampled })}` : ''}</span></p>
    <dl class="kv">${rows}</dl>
    <div style="margin-top:10px">${btn}</div></div>`;
}

// Donory, se kterými sloučení zvuku neprošlo – znovu se nestahují (ani pod jiným indexerem / magnetem)
function badDonorsHtml(it) {
  if (!it.badDonors?.length) return '';
  return `<div class="d-sec"><h4>${t('badDonors.title')}</h4>
    <p class="note" style="margin:0 0 8px">${t('badDonors.text')}</p>
    <ul class="results bad-donors">${it.badDonors.map((b) => `<li class="bad">${icon('ban')}<div>
      <span class="mono">${esc(b.title)}</span>
      <small class="muted">${esc(b.reason || '')} · <span title="${esc(fullDate(b.at))}">${ago(b.at)}</span>${b.times > 1 ? ` · ${t('badDonors.times', { n: b.times })}` : ''}</small></div>
      <button class="btn ghost sm" data-act="unbaddonor" data-id="${esc(b.id)}" title="${esc(t('badDonors.unblockTitle'))}">${t('badDonors.unblock')}</button></li>`).join('')}</ul></div>`;
}

function renderDrawer() {
  const d = $('#drawer');
  const it = S.items.find((x) => x.key === S.drawer);
  if (!S.drawer || !it) { closeDrawer(); return; }
  const focused = document.activeElement?.dataset?.act;
  const c = it.current;
  const lr = it.lastResult;
  const w = it.watch;
  const st = S.settings?.settings || {};
  const breakdown = lr?.stats ? Object.entries(lr.stats).filter(([k, v]) => v && STAT_LABELS[k]).map(([k, v]) => `<span class="chip">${v} ${STAT_LABELS[k]}</span>`).join('') : '';
  d.innerHTML = `
    <div class="d-hero">
      ${poster(it.poster)}
      <div>
        <h2 id="drawer-title">${esc(it.label)}</h2>
        <div class="p-meta"><span>${it.app === 'sonarr' ? t('common.series') : t('common.movie')}</span>${it.originalLanguage ? `<span class="sep"></span><span>${t('common.original', { lang: esc(it.originalLanguage) })}</span>` : ''}</div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${tierChip(c.tier, it.originalLanguage)}<span class="status s-${it.status}">${STATUS[it.status] || it.status}</span></div>
      </div>
      <button class="icon-btn d-close" data-act="close" aria-label="${t('common.close')}">${icon('x')}</button>
    </div>
    <div class="d-body">
      <div class="d-sec">
        <h4>${t('drawer.inLibrary')}</h4>
        <dl class="kv">
          <dt>${t('common.language')}</dt><dd>${czOrig(c.tier, it.originalLanguage) ? esc(t('drawer.priOriginal', { name: ucFirst(langName(LANG.pri)) })) : TIER_LONG[c.tier]}${c.audioSource === 'nazev' ? ` <span class="chip warn">${t('drawer.nameGuess')}</span>` : c.audioSource === 'poslech' ? ` <span class="chip ok">${icon('check')}${t('common.verifiedBySpeech')}</span>` : ` <span class="muted small">${t('drawer.byTags')}</span>`}</dd>
          <dt>${t('common.audioTracks')}</dt><dd class="mono">${esc(c.audio)}</dd>
          <dt>${t('common.quality')}</dt><dd>${esc(c.quality)}</dd>
          <dt>${t('codec.title')}</dt><dd>${c.vcodecName && c.vcodecName !== '?' ? esc(c.vcodecName) : `<span class="muted">${t('drawer.vcodecUnknown')}</span>`}</dd>
          ${c.truncated ? `<dt>${t('drawer.length')}</dt><dd><span class="chip warn" title="${esc(truncTitle())}">${icon('alert')}${t('drawer.truncated')}</span> ${esc(t('drawer.truncatedText', { file: c.truncated.fileMin, runtime: c.truncated.runtimeMin }))}</dd>` : ''}
          <dt>${t('drawer.size')}</dt><dd>${gb(c.size)}${c.files > 1 ? ` · ${t('count.files', { count: c.files })}` : ''}</dd>
          ${c.tierCounts ? `<dt>${t('drawer.episodes')}</dt><dd>${[3, 2, 1, 0].filter((x) => c.tierCounts[x]).map((x) => `${TIER[x]}: ${c.tierCounts[x]}`).join(' · ')}${epsBar(c.tierCounts)}</dd>` : ''}
        </dl>
      </div>
      ${syncSection(it)}
      <div class="d-sec">
        <h4>${t('drawer.watching')}</h4>
        <div class="watch-box">
          <div class="row"><div><b>${it.app === 'sonarr' ? t('drawer.watchSeries') : t('drawer.watchMovie')}</b><small>${t(it.app === 'sonarr' ? 'drawer.watchEverySeries' : 'drawer.watchEvery', { count: st.watchIntervalDays || 2, recheck: st.recheckDays || 14 })}${w?.origin === 'new' ? ` ${t(it.app === 'sonarr' ? 'drawer.autoOnSeries' : 'drawer.autoOnMovie', { date: new Date(w.since).toLocaleDateString(I18N.locale) })}` : ''}</small></div>
            <label class="switch"><input type="checkbox" data-act="dwatch" ${w ? 'checked' : ''} aria-label="${t('library.watch')}"><span></span></label></div>
          <div class="row"><div><b>${t('drawer.auto')}</b><small>${t('drawer.autoHelp', { n: st.autoMinSeeders ?? 10 })}</small></div>
            <label class="switch"><input type="checkbox" data-act="dauto" ${w?.auto ? 'checked' : ''} ${w ? '' : 'disabled'} aria-label="${t('drawer.autoLabel')}"><span></span></label></div>
        </div>
      </div>
      <div class="d-sec">
        <h4>${t('drawer.want')}</h4>
        <div class="segmented" role="group" aria-label="${t('drawer.want')}">
          ${WANT_OPTS.map(([v, label, help]) => `<button data-act="dwant" data-key="${esc(it.key)}" data-langs="${v}" title="${esc(help)}" aria-pressed="${(it.want?.join(',') || 'pri,sec') === v}">${label}</button>`).join('')}
        </div>
        <p class="muted small" style="margin:8px 0 0">${esc(WANT_OPTS.find(([v]) => v === (it.want?.join(',') || 'pri,sec'))[2])}.${it.app === 'sonarr' ? ` ${t('drawer.wantSeries')}` : ''}</p>
      </div>
      <div class="d-sec">
        <h4>${t('codec.title')}</h4>
        <div class="segmented" role="group" aria-label="${t('codec.wanted')}">
          ${CODEC_OPTS.map(([v, label, help]) => `<button data-act="dcodec" data-key="${esc(it.key)}" data-codec="${v}" title="${esc(help)}" aria-pressed="${(it.codec || '') === v}">${label}</button>`).join('')}
        </div>
        <p class="muted small" style="margin:8px 0 0">${esc(CODEC_OPTS.find(([v]) => v === (it.codec || ''))[2])}.${it.codec ? ` ${t('codec.note')}` : ''}${it.codec && it.app === 'sonarr' ? ` ${t('codec.series')}` : ''}</p>
      </div>
      ${langCheckHtml(it)}
      ${badDonorsHtml(it)}
      <div class="d-sec">
        <h4>${t('drawer.lastCheck')}</h4>
        ${it.lastSearchedAt ? `<p style="margin:0 0 8px">${ago(it.lastSearchedAt)} <span class="muted small">(${esc(fullDate(it.lastSearchedAt))})</span>${lr?.found != null ? ` – ${lr.found ? `<b>${t('count.suitable', { count: lr.found })}</b>` : t('drawer.nothingBetter')}` : ''}</p>` : `<p class="muted" style="margin:0">${t('drawer.notChecked')}</p>`}
        ${lr?.error ? `<p class="warn-text">${icon('alert')}${esc(lr.error)}</p>` : ''}
        ${breakdown ? `<div class="breakdown">${breakdown}</div>` : ''}
        ${it.ignoredUntil && Date.parse(it.ignoredUntil) > Date.now() ? `<p class="note">${t('drawer.ignoredUntil', { date: new Date(it.ignoredUntil).toLocaleDateString(I18N.locale) })}</p>` : ''}
      </div>
      <div class="d-actions">
        <button class="btn primary" data-act="recheck" data-key="${esc(it.key)}">${icon('search')}${t('common.searchNow')}</button>
        ${it.proposalId ? `<a class="btn" href="#p=${it.proposalId}" data-act="close">${icon('inbox')}${t('drawer.openProposal')}</a>` : ''}
        ${it.downloadId ? `<a class="btn" href="#activity" data-act="close">${icon('activity')}${t('drawer.downloadProgress')}</a>` : ''}
        ${it.status === 'ignored'
          ? `<button class="btn ghost" data-act="unignore" data-key="${esc(it.key)}">${t('drawer.unignore')}</button>`
          : `<button class="btn ghost danger" data-act="ignore" data-key="${esc(it.key)}">${icon('ban')}${t('drawer.ignore')}</button>`}
      </div>
    </div>`;
  if (focused) $(`[data-act="${focused}"]`, d)?.focus();
}
function syncSection(it) {
  const sy = it.sync;
  const sc = S.ov?.syncCheck || {};
  if (!it.syncable && !sy?.ok) return '';
  const measuring = it.syncQueued;
  const when = sy?.at ? `<span title="${esc(fullDate(sy.at))}">${ago(sy.at)}</span>` : '';
  const progress = sy && sy.total > 1 ? ` · ${t('sync.measuredOf', { n: sy.checked, count: sy.total })}` : '';
  let body;
  if (it.status === 'fixing') {
    body = `<p class="sync-line">${icon('refresh', 'spin')}${t('sync.fixRunning', { link: `<a href="#activity" data-act="close">${t('sync.activityLink')}</a>` })}</p>`;
  } else if (sy?.warn) {
    body = `<div class="sync-box warn">
        <div class="sync-head">${icon('alert')}<b>${esc(syncWarnText(sy))}</b></div>
        <p>${syncLagSentence(sy.offsetMs)}${sy.matched ? `, ${t('sync.matchedMeasured', { n: esc(sy.matched) })}` : ''}${when ? ` · ${t('sync.measuredAgo', { when })}` : ''}${progress}.</p>
        ${sy.badFiles?.length > 1 ? `<ul class="results">${sy.badFiles.map((f) => `<li class="bad">${icon('alert')}<span class="mono">${esc(f.name)}</span><span class="muted">${Math.abs(f.offsetMs)} ms</span></li>`).join('')}</ul>` : ''}
        <p class="note">${t('sync.fixNote', { p: LANG.P, app: it.app === 'sonarr' ? 'Sonarr' : 'Radarr' })}</p>
      </div>`;
  } else if (sy?.ok) {
    body = `<p class="sync-line ok">${icon('check')}${t('sync.ok', { ms: Math.abs(sy.offsetMs) })}${sy.matched ? `, ${t('sync.matched', { n: esc(sy.matched) })}` : ''}${when ? ` · ${when}` : ''}${progress}</p>
      ${sy.fixedFrom != null ? `<p class="note">${t('sync.fixedFrom', { ms: Math.abs(sy.fixedFrom), lag: syncLag(sy.fixedFrom) })}</p>` : ''}`;
  } else if (sy) {
    body = `<p class="sync-line muted">${icon('alert')}${t('sync.failed')}${sy.reason ? `: ${esc(sy.reason)}` : ''}${when ? ` · ${when}` : ''}</p>`;
  } else {
    body = `<p class="sync-line muted">${sc.enabled === false ? t('sync.bgOff') : t('sync.bgWaiting')}</p>`;
  }
  const canFix = sy?.warn && !['fixing', 'downloading'].includes(it.status);
  return `<div class="d-sec">
    <h4>${t('sync.title')}</h4>
    ${body}
    ${it.status === 'fixing' ? '' : `<div class="d-actions" style="margin-top:10px">
      ${canFix ? `<button class="btn primary" data-act="syncfix" data-key="${esc(it.key)}">${icon('zap')}${t('sync.fix')}</button>` : ''}
      ${measuring
        ? `<span class="chip accent">${icon('refresh', 'spin')}${t('sync.measuring')}</span>`
        : `<button class="btn ${canFix ? 'ghost' : ''} sm" data-act="synccheck" data-key="${esc(it.key)}" title="${t('sync.checkTitle')}">${icon('refresh')}${sy ? t('sync.checkAgain') : t('sync.checkNow')}</button>`}
    </div>`}
  </div>`;
}
function openDrawer(key) {
  S.drawer = key;
  renderDrawer();
  $('#drawer-backdrop').hidden = false;
  const d = $('#drawer');
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('.d-close', d)?.focus(), 60);
}
function closeDrawer() {
  if (!S.drawer && !$('#drawer').classList.contains('open')) return;
  const key = S.drawer;
  S.drawer = null;
  $('#drawer-backdrop').hidden = true;
  const d = $('#drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  if (key) $(`#lib-table tr[data-key="${CSS.escape(key)}"]`)?.focus();
}
$('#drawer-backdrop').addEventListener('click', closeDrawer);

// ===================================================================================
// Aktivita
// ===================================================================================
const DL_STEPS = [t('activity.step.sent'), t('activity.step.download'), t('activity.step.import'), t('activity.step.langCheck')];
const MERGE_STEPS = [t('activity.step.downloadAudio'), t('activity.step.checkTracks'), t('activity.step.import'), t('activity.step.verify')];
const SYNCFIX_STEPS = [t('activity.step.measure'), t('activity.step.fix'), t('activity.step.import'), t('activity.step.done')];
const STATE_LABEL = {
  queued: t('activity.state.queued'), grabbed: t('activity.state.grabbed'), downloading: t('activity.state.downloading'), importing: t('activity.state.importing'), blocked: t('activity.state.blocked'),
  ready: t('activity.state.ready'), processing: t('activity.state.processing'), done: t('activity.state.done'), failed: t('activity.state.failed'), lost: t('activity.state.lost'), cancelled: t('activity.state.cancelled'),
};

function stepIndex(j) {
  if (j.type === 'syncfix') {
    const m = { queued: 0, importing: 2, blocked: 2, done: 4 };
    if (j.state in m) return m[j.state];
    return j.results?.length || j.phase === 'fix' || /vytvářím|ověřuji/.test(j.message || '') ? 1 : 0; // text jen u starších záznamů
  }
  const merge = j.type === 'merge';
  const map = merge
    ? { downloading: 0, ready: 1, processing: 1, importing: 2, blocked: 2, done: 4 }
    : { grabbed: 0, downloading: 1, importing: 2, blocked: 2, done: 4 };
  if (j.state in map) return map[j.state];
  if (merge) return j.results?.length || (j.progress || 0) >= 1 ? 1 : 0;
  return (j.progress || 0) >= 1 ? 2 : 1;
}

const jobSteps = (j) => (j.type === 'syncfix' ? SYNCFIX_STEPS : j.type === 'merge' ? MERGE_STEPS : DL_STEPS);
const jobKind = (j) => (j.active ? 'run' : j.state === 'done' ? 'done' : 'bad');
const jobEnd = (j) => j.finishedAt || j.grabbedAt;
const hhmm = (tm) => new Date(ts(tm)).toLocaleTimeString(I18N.locale, { hour: 'numeric', minute: '2-digit' });
// Zbývající čas z Radarru/Sonarru ("1.06:54:44") → "1 d 7 h"
function timeLeft(s) {
  const m = String(s).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return s;
  const [d, h, min] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  const D = t('time.dur.d', { n: d }), H = t('time.dur.h', { n: h });
  return d ? `${D}${h ? ` ${H}` : ''}` : h ? `${H}${min ? ` ${t('time.dur.min', { n: min })}` : ''}` : t('time.dur.min', { n: Math.max(1, min) });
}

// Opakované pokusy (retryOf) tvoří jednu řadu: v seznamu je jen poslední pokus, starší jsou v detailu
function jobChains(jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const chains = new Map();
  for (const j of jobs) {
    let r = j;
    for (let n = 0; r.retryOf && byId.has(r.retryOf) && n < 50; n++) r = byId.get(r.retryOf);
    if (!chains.has(r.id)) chains.set(r.id, []);
    chains.get(r.id).push(j);
  }
  return [...chains].map(([id, list]) => {
    list.sort((a, b) => (a.attempt || 1) - (b.attempt || 1) || a.grabbedAt - b.grabbedAt);
    return { id, j: list.at(-1), tries: list.slice(0, -1).reverse() };
  });
}

function jobBadge(j) {
  if (j.active) return `<span class="j-ic run">${icon(j.type === 'syncfix' ? 'zap' : j.type === 'merge' ? 'merge' : 'download')}</span>`;
  const [cls, ic] = { done: ['ok', 'check'], cancelled: ['off', 'ban'], blocked: ['warn', 'alert'] }[j.state] || ['bad', 'x'];
  return `<span class="j-ic ${cls}" title="${esc(STATE_LABEL[j.state] || j.state)}">${icon(ic)}</span>`;
}

// Druhý řádek: co se právě děje / jak to dopadlo
function jobSub(j) {
  if (j.active) return `<span class="j-sub"><span class="state s-${j.state}">${STATE_LABEL[j.state] || j.state}</span>${j.message ? ` · ${esc(j.message)}` : ''}</span>`;
  if (j.state === 'done') {
    if (j.warning) return `<span class="j-sub warn">${esc(j.warning)}</span>`;
    const c = j.candidate || {};
    if (j.type === 'syncfix') return `<span class="j-sub">${esc(j.message || t('activity.sub.syncFixed'))}</span>`;
    if (j.type === 'merge') return `<span class="j-sub">${t('activity.sub.trackAdded')}${j.result?.quality || j.prev?.quality ? ` · ${esc(j.result?.quality || j.prev.quality)}` : ''}</span>`;
    const q = j.result?.quality || c.quality || '';
    const from = j.prev?.quality && j.prev.quality !== q && !j.prev.quality.includes('|') ? `${esc(j.prev.quality)} → ` : '';
    return `<span class="j-sub">${from}${esc(q)}${j.size || c.size ? ` · ${gb(j.size || c.size)}` : ''}</span>`;
  }
  return `<span class="j-sub ${j.state === 'cancelled' ? '' : 'bad'}">${esc(j.message || STATE_LABEL[j.state] || j.state)}</span>`;
}

// Pravá část řádku: průběh u běžících, změna jazyka u hotových
function jobSide(j) {
  if (j.active) {
    const pct = Math.round((j.progress || 0) * 100);
    const indet = ['processing', 'ready', 'importing'].includes(j.state);
    return `<span class="j-side">${j.timeleft ? `<span class="hide-m" title="${t('activity.timeLeftTitle')}">${icon('clock')}${esc(timeLeft(j.timeleft))}</span>` : ''}
      <span class="progress ${indet ? 'indet' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></span>
      <span class="j-pct">${indet ? '' : `${pct} %`}</span></span>`;
  }
  if (j.state !== 'done' || j.type === 'syncfix') return '<span class="j-side"></span>';
  const to = j.result?.tier ?? j.candidate?.tier;
  if (j.first) return `<span class="j-side">${tierChip(to)}</span>`;
  return `<span class="j-side">${tierChip(j.prev?.tier)}${icon('arrow')}${tierChip(to)}</span>`;
}

function jobRow({ id, j, tries }, { clock = false } = {}) {
  const open = S.act.open.has(id);
  const typeChip = j.type === 'syncfix' ? `<span class="chip xs warn">${t('activity.type.syncfixShort')}</span>` : j.type === 'merge' ? `<span class="chip xs accent">${t('activity.type.mergeShort')}</span>`
    : j.first ? `<span class="chip xs accent" title="${esc(t('activity.type.firstTitle'))}">${t('activity.type.first')}</span>` : '';
  const cancellable = j.active && !['processing', 'importing'].includes(j.state);
  const tm = j.active ? j.grabbedAt : jobEnd(j);
  return `<div class="jitem ${open ? 'open' : ''}">
    <div class="jrow">
      <button class="j-btn" data-act="jtoggle" data-id="${esc(id)}" aria-expanded="${open}">
        ${jobBadge(j)}
        <span class="j-main">
          <span class="j-title"><b>${esc(j.label)}</b>${typeChip}${j.auto && !j.first ? `<span class="chip xs">${t('activity.autoShort')}</span>` : ''}${tries.length ? `<span class="chip xs" title="${t('activity.retriedTitle')}">${t('activity.attemptNth', { n: tries.length + 1 })}</span>` : ''}</span>
          ${jobSub(j)}
        </span>
        ${jobSide(j)}
        <time title="${esc(fullDate(tm))}">${clock ? hhmm(tm) : ago(tm)}</time>
        ${icon('chevron')}
      </button>
      ${cancellable ? `<button class="icon-btn sm danger" data-act="cancel" data-id="${j.id}" title="${t('activity.cancel')}" aria-label="${t('activity.cancel')}">${icon('x')}</button>` : ''}
    </div>
    ${open ? jobDetail(j, tries) : ''}
  </div>`;
}

function jobDetail(j, tries) {
  const merge = j.type === 'merge';
  const fix = j.type === 'syncfix';
  const steps = jobSteps(j);
  const idx = stepIndex(j);
  const bad = ['failed', 'lost', 'blocked', 'cancelled'].includes(j.state);
  const c = j.candidate || {};
  const kind = c.set ? `<span class="chip">${icon('layers')}${t('activity.type.set')}</span>` : j.seasons?.length > 1 ? `<span class="chip">${icon('layers')}${t('activity.type.pack')}</span>` : '';
  const results = (j.results || []).map((r) => (fix && r.ok
    ? `<li class="ok">${icon('check')}<span><b>${esc(r.target)}</b> – ${r.skipped
      ? t('activity.fix.skipped', { ms: Math.abs(r.offsetMs) })
      : `${t('activity.fix.result', { p: LANG.P, ms: Math.abs(r.offsetMs), lag: syncLag(r.offsetMs), m: esc(r.matched || '?'), v: Math.abs(r.verifyMs), vm: esc(r.verifyMatched || '?') })}${(r.applied || []).length > 1 ? ` · ${t('activity.fix.shifted', { n: r.applied.length, p: LANG.P })}` : ''}`}</span></li>`
    : r.ok
    ? `<li class="ok">${icon('check')}<span><b>${esc(r.target)}</b> – ${r.skipped ? t('activity.merge.hasTrack') : `${t('activity.merge.offset', { ms: `${r.offsetMs > 0 ? '+' : ''}${r.offsetMs}` })}, ${t('sync.matched', { n: esc(r.matched || '?') })}${r.via ? ` (${esc(r.via)})` : ''}${r.langNote ? ` · ${esc(r.langNote)}` : ''}`}</span></li>`
    : `<li class="bad">${icon('x')}<span><b>${esc(r.target)}</b> – ${esc(r.reason)}</span></li>`)).join('');
  const parts = (j.parts || []).length > 1 ? `<ul class="results">${j.parts.map((p) => `<li class="${p.state === 'failed' ? 'bad' : 'ok'}">${icon(p.state === 'failed' ? 'x' : p.state === 'dismissed' || p.progress >= 1 ? 'check' : 'download')}<span class="mono">${esc(p.title)}</span><span class="muted">${Math.round((p.progress || 0) * 100)} %</span></li>`).join('')}</ul>` : '';
  const result = j.result ? tierChip(j.result.tier) : tierChip(c.tier);
  return `<div class="j-detail">
    <div class="o-title">${icon(j.app === 'sonarr' ? 'tv' : 'film')} ${esc(j.title)}</div>
    <div class="steps">${steps.map((s, i) => {
      const cls = i < idx || j.state === 'done' ? 'done' : i === idx ? (bad ? 'bad' : 'now') : '';
      return `<span class="step ${cls}"><i>${cls === 'done' ? icon('check') : cls === 'bad' ? '!' : i + 1}</i>${s}</span>`;
    }).join('')}</div>
    ${fix ? `<div class="job-meta">
      <span>${t('activity.fix.dub', { p: LANG.P, v: j.expectedMs != null ? `${Math.abs(j.expectedMs)} ms (${syncLag(j.expectedMs)})` : '?' })}</span>${icon('arrow')}<span>${(() => { const r = (j.results || []).find((x) => x.ok && !x.skipped); return r ? `${Math.abs(r.verifyMs)} ms` : j.state === 'done' ? t('activity.fix.unchanged') : '…'; })()}</span>
      <span>${esc(j.prev?.quality || '')}</span>
      <span title="${esc(fullDate(j.grabbedAt))}">${t('activity.started', { ago: ago(j.grabbedAt) })}</span>
    </div>` : `<div class="job-meta">
      ${kind}
      ${j.first ? `<span>${t('activity.noFileYet')}</span>` : `<span>${tierChip(j.prev?.tier)} ${esc(j.prev?.quality || '')}</span>`}${icon('arrow')}<span>${result} ${esc(j.result?.quality || (merge ? j.prev?.quality : c.quality) || '')}</span>
      ${c.indexer ? `<span>${esc(c.indexer)}</span>` : ''}
      ${c.seeders != null ? `<span class="seeds ${seedClass(c.seeders)}">${c.seeders} ${t('option.seeds')}</span>` : ''}
      <span>${gb(j.size || c.size)}</span>
      <span title="${esc(fullDate(j.grabbedAt))}">${t('activity.sent', { ago: ago(j.grabbedAt) })}</span>
      ${!j.active && j.finishedAt ? `<span title="${esc(fullDate(j.finishedAt))}">${t('activity.finished', { ago: ago(j.finishedAt) })}</span>` : ''}
    </div>`}
    ${j.message ? `<div class="job-msg">${esc(j.message)}</div>` : ''}
    ${j.offerPending ? `<div style="margin-top:8px"><a class="btn sm" href="#p=${esc(j.offerProposalId)}">${icon('inbox')}${t('activity.openOffer')}</a></div>` : ''}
    ${j.cancelledForeign?.length ? `<div class="note" style="margin-top:6px">${t('activity.cancelledForeign', { app: j.app === 'sonarr' ? 'Sonarr' : 'Radarr' })} <span class="mono">${j.cancelledForeign.map(esc).join(', ')}</span></div>` : ''}
    ${j.warning ? `<div class="warn-text" style="margin-top:6px">${icon('alert')}${esc(j.warning)}</div>` : ''}
    ${results ? `<ul class="results">${results}</ul>` : ''}
    ${parts}
    ${j.backupDir && !j.backupRemoved && (j.backupUntil || j.backupKeep) ? `<div class="note" style="margin-top:6px">${t('activity.backup', { when: j.backupKeep === 'forever' ? t('backups.forever') : t('backups.until', { date: new Date(j.backupUntil).toLocaleDateString(I18N.locale) }) })}: <span class="mono">${esc(j.backupDir)}</span> · <a href="#backups" data-act="tab" data-tab="backups">${t('nav.backups')}</a></div>` : ''}
    ${tries.length ? `<div class="j-tries"><div class="j-h">${t('activity.prevTries')}</div><ul class="results">${tries.map((p) => `<li class="bad">${icon('x')}<span><b>${t('activity.attemptNth', { n: p.attempt || 1 })}</b> · <span title="${esc(fullDate(jobEnd(p)))}">${ago(jobEnd(p))}</span> – ${esc(p.message || STATE_LABEL[p.state] || p.state)}<span class="o-title" style="display:block">${esc(p.title)}</span></span></li>`).join('')}</ul></div>` : ''}
  </div>`;
}

function dayLabel(tm) {
  const d = new Date(ts(tm)); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400e3);
  if (diff === 0) return t('time.today');
  if (diff === 1) return t('time.yesterdayDay');
  return d.toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function renderActivity(full = true) {
  const el = $('#view-activity');
  const A = S.act;
  if (full || !$('#act-list', el)) {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>${t('nav.activity')}</h1>
        <p>${t('activity.lead')}</p></div>
      </div>
      <div class="toolbar" style="margin-bottom:16px">
        <label class="search"><span class="sr-only">${t('common.search')}</span>${icon('search')}<input class="input" id="act-q" type="search" placeholder="${t('library.searchPlaceholder')}" value="${esc(A.q)}"></label>
        <div class="segmented" role="group" aria-label="${t('common.status')}" id="act-seg"></div>
      </div>
      <div id="act-list"></div>`;
    $('#act-q', el).addEventListener('input', (e) => { A.q = e.target.value; A.limit = 60; renderActivity(false); });
  }
  const focused = document.activeElement?.closest?.('#act-list [data-act]');
  const focusSel = focused ? `[data-act="${focused.dataset.act}"][data-id="${CSS.escape(focused.dataset.id || '')}"]` : null;

  const q = fold(A.q.trim());
  const chains = jobChains(S.jobs).filter((c) => !q || fold(`${c.j.label} ${c.j.title}`).includes(q));
  const n = { all: chains.length, run: 0, done: 0, bad: 0 };
  for (const c of chains) n[jobKind(c.j)]++;
  $('#act-seg', el).innerHTML = [['all', t('common.all')], ['run', t('activity.filter.run')], ['done', t('activity.filter.done')], ['bad', t('activity.filter.bad')]]
    .map(([k, l]) => `<button data-act="afilter" data-f="${k}" aria-pressed="${A.f === k}">${l} <span class="muted">${n[k]}</span></button>`).join('');

  const shown = chains.filter((c) => A.f === 'all' || jobKind(c.j) === A.f);
  const run = shown.filter((c) => c.j.active);
  const hist = shown.filter((c) => !c.j.active).sort((a, b) => jobEnd(b.j) - jobEnd(a.j));
  let html = '';
  if (run.length) html += `<div class="section-title">${t('activity.filter.run')} <span class="count-pill">${run.length}</span></div><div class="card jlist">${run.map((c) => jobRow(c)).join('')}</div>`;
  else if (!q && A.f !== 'done' && A.f !== 'bad') html += `<div class="card empty" style="padding:28px">${icon('activity', 'xl')}<h3>${t('activity.empty.title')}</h3><p>${t('activity.empty.text')}</p></div>`;
  const groups = [];
  for (const c of hist.slice(0, A.limit)) {
    const label = dayLabel(jobEnd(c.j));
    if (groups.at(-1)?.label !== label) groups.push({ label, list: [] });
    groups.at(-1).list.push(c);
  }
  html += groups.map((g) => `<div class="section-title">${esc(g.label)} <span class="count-pill">${g.list.length}</span></div>
    <div class="card jlist">${g.list.map((c) => jobRow(c, { clock: true })).join('')}</div>`).join('');
  if (hist.length > A.limit) html += `<div class="more"><button class="btn ghost" data-act="amore">${t('library.more', { n: Math.min(60, hist.length - A.limit) })}</button></div>`;
  if (!shown.length && (q || A.f === 'done' || A.f === 'bad')) html += `<div class="card empty" style="padding:28px">${icon('search', 'xl')}<h3>${t('activity.noMatch.title')}</h3><p>${t('activity.noMatch.text')}</p></div>`;
  $('#act-list', el).innerHTML = html;
  if (focusSel) $(focusSel, el)?.focus();
}

// ===================================================================================
// Zálohy
// ===================================================================================
const DAY_MS = 86400e3;
const fmtDate = (tm) => new Date(tm).toLocaleDateString(I18N.locale);
const KEEP_OPTS = [['auto', t('backups.keep.auto')], ['30', t('backups.keep.days', { n: 30 })], ['90', t('backups.keep.days', { n: 90 })], ['365', t('backups.keep.year')], ['forever', t('backups.keep.forever')]];

function bkExpiry(b) {
  if (b.keep === 'orphan') return `<span class="muted">${t('backups.expiry.orphan')}</span>`;
  if (b.keep === 'forever') return `<span class="chip accent">${t('backups.forever')}</span>`;
  if (b.active) return `<span class="muted">${t('backups.expiry.active')}</span>`;
  if (S.backups?.deleteVerified && b.keep === 'auto' && b.check?.status === 'pending') return `${t('backups.expiry.afterVerify')}${b.expiresAt ? ` <span class="muted">(${t('backups.expiry.latest', { date: fmtDate(b.expiresAt) })})</span>` : ''}`;
  if (!b.expiresAt) return '<span class="muted">–</span>';
  const days = Math.ceil((b.expiresAt - Date.now()) / DAY_MS);
  const when = days <= 0 ? t('backups.expiry.nextCleanup') : days === 1 ? t('time.tomorrow') : t('time.inDays', { count: days });
  return `<span title="${esc(fullDate(b.expiresAt))}">${fmtDate(b.expiresAt)} <span class="muted">(${when})</span></span>${b.keep === 'custom' ? ` <span class="chip xs">${t('backups.customDate')}</span>` : ''}`;
}

// Sloučilo se? Stav úlohy a ověření výsledku v knihovně proti záloze (backups.js)
function bkCheckChip(b) {
  const c = b.check || {};
  const fix = b.type === 'syncfix';
  if (c.status === 'ok') return `<span class="chip ok" title="${esc(t('backups.check.okTitle', { date: fullDate(c.at) }))}">${icon('check')}${t(fix ? 'backups.check.okFix' : 'backups.check.okMerge')}</span>`;
  if (c.status === 'review' && b.state !== 'blocked') return `<span class="chip warn" title="${t('backups.check.reviewTitle')}">${icon('alert')}${t('backups.check.review')}</span>`;
  if (c.status === 'pending') return `<span class="chip" title="${t('backups.check.pendingTitle')}">${icon('clock')}${t(fix ? 'backups.check.pendingFix' : 'backups.check.pendingMerge')}</span>`;
  if (c.status === 'notMerged') return `<span class="chip" title="${t('backups.check.notMergedTitle')}">${t(fix ? 'backups.check.notFixed' : 'backups.check.notMerged')}</span>`;
  return '';
}

function bkCheckDetail(b) {
  const c = b.check || {};
  const issues = c.status === 'review' && b.state !== 'blocked' ? c.issues || [] : [];
  const notes = c.notes || [];
  if (!issues.length && !notes.length) return '';
  return `<ul class="results bk-issues">${issues.map((i) => `<li class="bad">${icon('alert')}<span>${i.file ? `<span class="mono">${esc(i.file)}</span>: ` : ''}${esc(i.msg)}</span></li>`).join('')}${notes.map((n) => `<li class="muted">${icon('layers')}<span>${esc(n)}</span></li>`).join('')}</ul>`;
}

// Přidaný zvuk ze sloučení: „přidán CZ zvuk · E-AC3 5.1 · posun +980 ms“
const CODEC_NAME = { ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', truehd: 'TrueHD', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis' };
const chLabel = (n) => ({ 1: 'mono', 2: '2.0', 6: '5.1', 7: '6.1', 8: '7.1' })[n] || (n ? `${n} ch` : '');
const offLabel = (ms) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms) >= 1000 ? `${(Math.abs(ms) / 1000).toLocaleString(I18N.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : `${Math.abs(ms)} ms`}`;
function bkAdded(b) {
  const a = b.added;
  if (!a) return '';
  const tracks = a.tracks.map((tr) => [CODEC_NAME[tr.codec] || String(tr.codec).toUpperCase(), chLabel(tr.channels)].filter(Boolean).join(' ')).join(', ');
  const [lo, hi] = a.offsetMs || [];
  const off = a.offsetMs ? (lo === hi ? offLabel(lo) : t('backups.added.range', { from: offLabel(lo), to: offLabel(hi) })) : '';
  return `<span class="bk-added" title="${esc(off ? t('backups.added.titleOffset', { off }) : t('backups.added.title'))}">${icon('mic')}${t('backups.added.text', { lang: `<b>${esc(langLabel(a.lang))}</b>` })}${tracks ? ` · ${esc(tracks)}` : ''}${off ? ` · ${t('backups.added.offset', { off })}` : ''}</span>`;
}

function backupCard(b) {
  const shared = b.size - b.exclusive;
  const typeChip = b.type === 'syncfix' ? `<span class="chip warn">${icon('zap')}${t('activity.type.syncfix')}</span>`
    : b.type === 'merge' ? `<span class="chip accent">${icon('merge')}${t('activity.type.merge')}</span>`
    : `<span class="chip">${t('backups.noRecord')}</span>`;
  const keepVal = b.keep === 'forever' ? 'forever' : b.keep === 'custom' ? 'custom' : 'auto';
  const opts = [...KEEP_OPTS.slice(0, 1), ...(b.keep === 'custom' ? [['custom', t('backups.keep.until', { date: fmtDate(b.expiresAt) })]] : []), ...KEEP_OPTS.slice(1)];
  return `<article class="card job backup" data-id="${esc(b.id)}">
    <div class="job-head">
      <div style="min-width:0">
        <h3 class="job-title">${icon(b.app === 'sonarr' ? 'tv' : b.app ? 'film' : 'archive')}${esc(b.label)}${typeChip}${bkCheckChip(b)}${b.state === 'blocked' ? `<span class="chip danger" title="${t('backups.blockedTitle')}">${t('backups.blocked')}</span>` : ''}${b.active ? `<span class="chip">${t('backups.jobRunning')}</span>` : ''}</h3>
        ${b.title ? `<div class="o-title">${esc(b.title)}</div>` : ''}
      </div>
      <div class="bk-actions">
        ${b.keep !== 'orphan' ? `<label class="sr-only" for="bk-keep-${esc(b.id)}">${t('backups.keepLabel')}</label>
        <select class="select sm" id="bk-keep-${esc(b.id)}" data-bk-keep="${esc(b.id)}" ${b.active ? 'disabled' : ''}>${opts.map(([v, l]) => `<option value="${v}" ${v === keepVal ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        ${b.state === 'done' && !b.active && b.keep !== 'orphan' ? `<button class="btn sm" data-act="bkverify" data-id="${esc(b.id)}" title="${t('backups.verifyTitle')}">${icon('refresh')}${b.check?.status === 'pending' ? t('backups.verifyNow') : t('backups.verifyAgain')}</button>` : ''}
        <button class="btn sm danger" data-act="bkdelete" data-id="${esc(b.id)}" ${b.active ? 'disabled' : ''}>${icon('trash')}${t('common.delete')}</button>
      </div>
    </div>
    <div class="job-meta">
      <span title="${b.exclusive ? t('backups.freesTitle') : t('backups.hardlinkTitle')}"><b class="bk-size">${gb(b.exclusive) === '–' ? '0 GB' : gb(b.exclusive)}</b> ${t('backups.onDisk')}${shared ? ` · ${t('backups.sharedSize', { size: gb(shared) })}` : ''}</span>
      <span>${t('count.files', { count: b.files.length })}</span>
      ${bkAdded(b)}
      <span title="${esc(fullDate(b.createdAt))}">${t('backups.created', { ago: ago(b.createdAt) })}</span>
      <span>${icon('clock')} ${t('backups.deletes', { when: bkExpiry(b) })}</span>
    </div>
    ${bkCheckDetail(b)}
    <details class="history bk-files">
      <summary class="note">${icon('chevron')}${t('backups.filesAndPath')}</summary>
      <ul class="results">${b.files.map((f) => `<li class="ok"><span class="mono" style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(f.name)}</span><span class="muted num">${gb(f.size)}</span>${f.shared ? `<span class="chip xs" title="${t('backups.fileSharedTitle')}">${t('backups.shared')}</span>` : ''}</li>`).join('')}</ul>
      <div class="note" style="margin-top:8px">${t('backups.folder', { dir: `<span class="mono">${esc(b.dir)}</span>` })} <button class="icon-btn sm" data-act="copy" data-text="${esc(b.dir)}" title="${t('backups.copyPath')}" aria-label="${t('backups.copyPath')}">${icon('copy')}</button></div>
    </details>
  </article>`;
}

function renderBackups() {
  const o = S.backups;
  if (!o) return;
  const days = S.bkDraft.days ?? o.keepBackupDays;
  const maxGB = S.bkDraft.maxGB ?? o.maxBackupGB;
  const delVer = S.bkDraft.delVer ?? o.deleteVerified;
  const shared = o.size - o.exclusive;
  const review = o.backups.filter((b) => b.check?.status === 'review').length;
  const next = o.backups.filter((b) => b.expiresAt && b.keep !== 'forever' && !b.active).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  const over = o.maxBackupGB > 0 && o.exclusive > o.maxBackupGB * 1024 ** 3;
  const usedPct = o.maxBackupGB ? Math.min(100, (o.exclusive / (o.maxBackupGB * 1024 ** 3)) * 100) : 0;
  $('#view-backups').innerHTML = `
    <div class="page-head">
      <div><h1>${t('nav.backups')}</h1>
      <p>${t('backups.lead')}</p></div>
      <div class="toolbar"><button class="icon-btn" data-act="bkrefresh" title="${t('common.reload')}" aria-label="${t('common.reload')}">${icon('refresh')}</button></div>
    </div>
    <div class="stats bk-stats">
      <div class="stat"><span class="v">${o.backups.length}</span><span class="l">${t('backups.stat.count', { count: o.backups.length })} · ${t('count.files', { count: o.backups.reduce((n, b) => n + b.files.length, 0) })}</span></div>
      <div class="stat ${over ? 'warn' : ''}"><span class="v">${o.exclusive ? gb(o.exclusive) : '0 GB'}</span><span class="l">${t('backups.stat.used')}${o.maxBackupGB ? ` ${t('backups.stat.ofLimit', { n: o.maxBackupGB })}` : ''}</span>${o.maxBackupGB ? `<i class="bar" style="width:${usedPct.toFixed(1)}%;background:var(${over ? '--warn' : '--accent'})"></i>` : ''}</div>
      <div class="stat"><span class="v">${shared ? gb(shared) : '0 GB'}</span><span class="l">${t('backups.stat.shared')}</span></div>
      <div class="stat"><span class="v">${o.disk ? gb(o.disk.free) : '–'}</span><span class="l">${t('backups.stat.free')}${o.disk ? ` ${t('backups.stat.ofTotal', { total: gb(o.disk.total) })}` : ''}</span></div>
    </div>
    <section class="card card-pad bk-ret" aria-labelledby="bk-ret-h">
      <div class="bk-ret-head">
        <div><h2 id="bk-ret-h">${t('backups.ret.title')}</h2>
        <p class="note">${t('backups.ret.lead', { n: o.blockedMinDays })}${next ? ` ${t('backups.ret.next', { name: `<b>${esc(next.label)}</b>`, date: fmtDate(next.expiresAt) })}` : ''}${review ? ` <b>${t('backups.ret.review', { count: review })}</b>` : ''}</p></div>
      </div>
      <div class="bk-ret-form">
        <label class="bk-field"><span>${t('backups.ret.days')}</span><span class="num-ctl"><input class="input num" id="bk-days" type="number" min="0" step="1" inputmode="numeric" value="${esc(days)}"><span class="unit">${t('unit.daysAfter')}</span></span><small class="note">${t('backups.ret.daysHelp')}</small></label>
        <label class="bk-field"><span>${t('backups.ret.max')}</span><span class="num-ctl"><input class="input num" id="bk-max" type="number" min="0" step="1" inputmode="numeric" value="${esc(maxGB)}"><span class="unit">GB</span></span><small class="note">${t('backups.ret.maxHelp')}</small></label>
        <label class="bk-field bk-toggle"><span>${t('backups.ret.delVer')}</span><span class="bk-switch"><span class="switch"><input type="checkbox" role="switch" id="bk-delver" ${delVer ? 'checked' : ''}><span></span></span><small class="note">${t('backups.ret.delVerHelp')}</small></span></label>
        <button class="btn primary" data-act="bkretention" ${Number(days) === o.keepBackupDays && Number(maxGB) === o.maxBackupGB && delVer === o.deleteVerified ? 'disabled' : ''}>${t('backups.ret.save')}</button>
      </div>
    </section>
    ${o.backups.length ? `<div class="section-title">${t('nav.backups')}</div>${o.backups.map(backupCard).join('')}`
      : `<div class="card empty" style="padding:40px;margin-top:14px">${icon('archive', 'xl')}<h3>${t('backups.empty.title')}</h3><p>${t('backups.empty.text')} ${t('backups.folder', { dir: `<span class="mono">${esc(o.root)}</span>` })}</p></div>`}`;
  for (const [id, k] of [['#bk-days', 'days'], ['#bk-max', 'maxGB'], ['#bk-delver', 'delVer']]) {
    $(id).addEventListener(k === 'delVer' ? 'change' : 'input', (e) => {
      S.bkDraft[k] = k === 'delVer' ? e.target.checked : e.target.value;
      const btn = $('[data-act="bkretention"]');
      const d = S.bkDraft.days ?? o.keepBackupDays;
      const m = S.bkDraft.maxGB ?? o.maxBackupGB;
      const v = S.bkDraft.delVer ?? o.deleteVerified;
      btn.disabled = Number(d) === o.keepBackupDays && Number(m) === o.maxBackupGB && v === o.deleteVerified;
    });
  }
}

async function loadBackups(force = false) {
  const o = await api('GET', 'backups');
  S.backups = o;
  // Rozepsanou retenci nepřekreslovat (přišel by fokus i rozepsané číslo)
  const editing = ['bk-days', 'bk-max'].includes(document.activeElement?.id);
  if ((changed('backups', o) || force) && !editing) renderBackups();
}

async function saveRetention(btn) {
  const o = S.backups;
  const body = { keepBackupDays: Number(S.bkDraft.days ?? o.keepBackupDays), maxBackupGB: Number(S.bkDraft.maxGB ?? o.maxBackupGB), deleteVerified: Boolean(S.bkDraft.delVer ?? o.deleteVerified) };
  // Prázdné pole by bylo Number('') = 0 = "smazat hned"
  if ([S.bkDraft.days, S.bkDraft.maxGB].some((v) => String(v ?? 'x').trim() === '')
    || ![body.keepBackupDays, body.maxBackupGB].every((n) => Number.isFinite(n) && n >= 0)) return toast(t('err.nonNegative'), { error: true });
  return busy(btn, async () => {
    const { removed } = await api('POST', 'backups/retention', { ...body, dryRun: true });
    if (removed.length) {
      const free = removed.reduce((s, r) => s + r.exclusive, 0);
      const ok = await confirmDialog({
        title: t('confirm.retention.title', { count: removed.length }),
        text: t('confirm.retention.text', { list: removed.map((r) => `${r.label} (${{ age: t('confirm.retention.older'), verified: t('confirm.retention.verified'), size: t('confirm.retention.overLimit') }[r.why]})`).join(', '), size: free ? gb(free) : '0 GB' }),
        ok: t('confirm.retention.ok'), danger: true,
      });
      if (!ok) return;
    }
    const r = await api('POST', 'backups/retention', body);
    if (S.settings) S.settings.settings = r.settings;
    S.bkDraft = {};
    toast(r.removed.length ? t('toast.retentionDeleted', { count: r.removed.length }) : t('toast.retentionSaved'));
    await loadBackups(true);
  });
}

// ===================================================================================
// Log
// ===================================================================================
const LOG_FMT = new Intl.DateTimeFormat(I18N.locale, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const LOG_LVL = { info: t('log.level.info'), warn: t('log.level.warn'), error: t('log.level.error') };
function renderLog(full = true) {
  const el = $('#view-log');
  if (full || !$('#log-list')) {
    el.innerHTML = `
      <div class="page-head"><div><h1>${t('nav.log')}</h1><p>${t('log.lead')}</p></div>
        <div class="toolbar">
          <label class="search"><span class="sr-only">${t('log.filter')}</span>${icon('search')}<input class="input" id="log-q" type="search" placeholder="${t('log.filterPlaceholder')}" value="${esc(S.logQ)}"></label>
          <div class="segmented" role="group" aria-label="${t('log.levelLabel')}">${[['all', t('common.all')], ['warn', t('log.warnings')], ['error', t('log.errors')]].map(([k, l]) => `<button data-act="loglevel" data-v="${k}" aria-pressed="${S.logLevel === k}">${l}</button>`).join('')}</div>
        </div></div>
      <div class="log" id="log-list"></div>`;
    $('#log-q').addEventListener('input', (e) => { S.logQ = e.target.value; renderLog(false); });
  }
  const q = S.logQ.trim().toLowerCase();
  const list = S.log.filter((l) => (S.logLevel === 'all' || (S.logLevel === 'warn' ? l.level !== 'info' : l.level === 'error')) && (!q || l.msg.toLowerCase().includes(q)));
  $('#log-list').innerHTML = list.length
    ? list.map((l) => `<div class="log-row"><time datetime="${esc(l.t)}">${LOG_FMT.format(new Date(l.t))}</time><span class="lvl ${l.level}">${LOG_LVL[l.level] || l.level}</span><span>${esc(l.msg)}</span></div>`).join('')
    : `<div class="empty" style="padding:40px">${t('log.empty')}</div>`;
}

// ===================================================================================
// Nastavení
// ===================================================================================
// Sekce → skupiny → pole. Pole: k (klíč), label, help, unit, min/max/step,
// kind ('choice' = karty s popisem, 'res' = rozsah rozlišení, 'list' = seznam oddělený čárkou),
// dep (platí jen se zapnutým jiným polem), need (vyžaduje službu z .env), warn (riskantní volba), restart
const RES = [[480, '480p'], [576, '576p'], [720, '720p · HD'], [1080, '1080p · Full HD'], [2160, '2160p · 4K']];
const SETTINGS_UI = [
  { id: 'conn', icon: 'plug', title: t('settings.conn.title'), lead: t('settings.conn.lead') },
  { id: 'lang', icon: 'mic', title: t('settings.lang.title'), lead: t('settings.lang.lead'),
    groups: [
      { title: t('settings.lang.group.dub'), fields: [
        { k: 'language', label: t('settings.field.language.label'), help: t('settings.field.language.help'), kind: 'lang' },
        { k: 'secondLanguage', label: t('settings.field.secondLanguage.label'), help: t('settings.field.secondLanguage.help'), kind: 'lang' },
      ] },
      { title: t('settings.lang.group.ui'), fields: [
        { k: 'uiLanguage', label: t('settings.field.uiLanguage.label'), help: t('settings.field.uiLanguage.help'), kind: 'locale' },
      ] },
    ] },
  { id: 'scan', icon: 'search', title: t('settings.scan.title'), lead: t('settings.scan.lead'),
    master: { k: 'scannerEnabled', label: t('settings.field.scannerEnabled.label'), help: t('settings.field.scannerEnabled.help') },
    groups: [
      { title: t('settings.scan.group.what'), fields: [
        { k: 'scanRadarr', label: t('settings.field.scanRadarr.label'), help: t('settings.field.scanRadarr.help'), dep: 'scannerEnabled' },
        { k: 'scanSonarr', label: t('settings.field.scanSonarr.label'), help: t('settings.field.scanSonarr.help'), dep: 'scannerEnabled' },
      ] },
      { title: t('settings.scan.group.tempo'), live: 'tempo', fields: [
        { k: 'searchIntervalSec', label: t('settings.field.searchIntervalSec.label'), help: t('settings.field.searchIntervalSec.help'), unit: 's', min: 10, step: 5, dep: 'scannerEnabled' },
        { k: 'maxSearchesPerDay', label: t('settings.field.maxSearchesPerDay.label'), min: 1, step: 10, dep: 'scannerEnabled' },
      ] },
      { title: t('settings.scan.group.recheck'), fields: [
        { k: 'recheckDays', label: t('settings.field.recheckDays.label'), help: t('settings.field.recheckDays.help'), unit: t('unit.daysAfter'), longUnit: true, min: 1, dep: 'scannerEnabled' },
        { k: 'watchIntervalDays', label: t('settings.field.watchIntervalDays.label'), help: t('settings.field.watchIntervalDays.help'), unit: t('unit.daysAfter'), longUnit: true, min: 1, dep: 'scannerEnabled' },
        { k: 'librarySyncMin', label: t('settings.field.librarySyncMin.label'), unit: 'min', min: 5, step: 5, restart: true },
      ] },
      { title: t('settings.scan.group.new'), fields: [
        { k: 'autoWatchNew', label: t('settings.field.autoWatchNew.label'), help: t('settings.field.autoWatchNew.help', LP), kind: 'choice', dep: 'scannerEnabled', options: [
          ['off', t('settings.field.autoWatchNew.opt.off'), t('settings.field.autoWatchNew.opt.off.help')],
          ['auto', t('settings.field.autoWatchNew.opt.auto'), t('settings.field.autoWatchNew.opt.auto.help')],
          ['ask', t('settings.field.autoWatchNew.opt.ask'), t('settings.field.autoWatchNew.opt.ask.help')],
        ] },
      ] },
    ] },
  { id: 'criteria', icon: 'up', title: t('settings.criteria.title'), lead: t('settings.criteria.lead', LP),
    groups: [
      { title: t('common.language'), fields: [
        { k: 'verifySpeech', label: t('settings.field.verifySpeech.label'), help: t('settings.field.verifySpeech.help'), need: 'speech' },
        { k: 'localIndexers', label: t('settings.field.localIndexers.label'), help: t('settings.field.localIndexers.help', LP), kind: 'list' },
      ] },
      { title: t('common.quality'), fields: [
        { k: 'qualityUpgrades', label: t('settings.field.qualityUpgrades.label'), help: t('settings.field.qualityUpgrades.help') },
        { k: 'allowLowerQualityForLanguage', label: t('settings.field.allowLowerQualityForLanguage.label'), help: t('settings.field.allowLowerQualityForLanguage.help', LP), warn: true },
        { k: 'minResolution', k2: 'maxResolution', label: t('settings.field.minResolution.label'), help: t('settings.field.minResolution.help'), kind: 'res' },
        { k: 'maxMovieSizeGB', label: t('settings.field.maxMovieSizeGB.label'), unit: 'GB', min: 1 },
        { k: 'maxEpisodeSizeGB', label: t('settings.field.maxEpisodeSizeGB.label'), unit: 'GB', min: 0.5, step: 0.5 },
      ] },
      { title: t('nav.proposals'), fields: [
        { k: 'candidatesPerProposal', label: t('settings.field.candidatesPerProposal.label'), min: 1, max: 20 },
      ] },
    ] },
  { id: 'series', icon: 'tv', title: t('settings.series.title'), lead: t('settings.series.lead'),
    groups: [
      { fields: [
        { k: 'multiSeasonPacks', label: t('settings.field.multiSeasonPacks.label'), help: t('settings.field.multiSeasonPacks.help', LP) },
        { k: 'episodeSets', label: t('settings.field.episodeSets.label'), help: t('settings.field.episodeSets.help') },
        { k: 'maxEpisodeSetParts', label: t('settings.field.maxEpisodeSetParts.label'), min: 2, dep: 'episodeSets' },
      ] },
    ] },
  { id: 'download', icon: 'download', title: t('settings.download.title'), lead: t('settings.download.lead'),
    groups: [
      { title: t('settings.download.group.approval'), fields: [
        { k: 'autoGrab', label: t('settings.field.autoGrab.label'), help: t('settings.field.autoGrab.help'), kind: 'choice', options: [
          ['off', t('settings.field.autoGrab.opt.off'), t('settings.field.autoGrab.opt.off.help')],
          ['target', t('settings.field.autoGrab.opt.target', LP), t('settings.field.autoGrab.opt.target.help')],
          ['any', t('settings.field.autoGrab.opt.any'), t('settings.field.autoGrab.opt.any.help', LP)],
        ] },
        { k: 'autoMinSeeders', label: t('settings.field.autoMinSeeders.label'), help: t('settings.field.autoMinSeeders.help'), min: 1 },
      ] },
      { title: t('settings.download.group.health'), fields: [
        { k: 'minSeeders', label: t('settings.field.minSeeders.label'), help: t('settings.field.minSeeders.help'), min: 0 },
        { k: 'stallHours', label: t('settings.field.stallHours.label'), help: t('settings.field.stallHours.help'), unit: 'h', min: 1 },
        { k: 'retryOnStall', label: t('settings.field.retryOnStall.label'), help: t('settings.field.retryOnStall.help') },
        { k: 'maxRetries', label: t('settings.field.maxRetries.label'), min: 1, max: 10, dep: 'retryOnStall' },
      ] },
      { title: t('settings.download.group.qbit'), live: 'stalls', fields: [
        { k: 'qbitStopStalled', label: t('settings.field.qbitStopStalled.label'), help: t('settings.field.qbitStopStalled.help'), need: 'qbit' },
        { k: 'qbitStallMin', label: t('settings.field.qbitStallMin.label'), help: t('settings.field.qbitStallMin.help'), unit: 'min', min: 5, step: 5, dep: 'qbitStopStalled' },
        { k: 'qbitStallRetryMin', label: t('settings.field.qbitStallRetryMin.label'), help: t('settings.field.qbitStallRetryMin.help'), unit: 'min', min: 15, step: 15, dep: 'qbitStopStalled' },
      ] },
      { title: t('settings.download.group.import'), fields: [
        { k: 'forceImport', label: t('settings.field.forceImport.label'), help: t('settings.field.forceImport.help'), warn: true },
        { k: 'qbitRemoveImported', label: t('settings.field.qbitRemoveImported.label'), help: t('settings.field.qbitRemoveImported.help'), need: 'qbit' },
      ] },
    ] },
  { id: 'first', icon: 'sparkles', title: t('settings.first.title'), nav: t('settings.first.nav'), lead: t('settings.first.lead', LP),
    master: { k: 'firstGrab', label: t('settings.field.firstGrab.label'), help: t('settings.field.firstGrab.help') },
    groups: [
      { title: t('settings.first.group.what'), live: 'first', fields: [
        { k: 'firstGrabMovies', label: t('settings.field.firstGrabMovies.label'), help: t('settings.field.firstGrabMovies.help'), dep: 'firstGrab' },
        { k: 'firstGrabSeries', label: t('settings.field.firstGrabSeries.label'), help: t('settings.field.firstGrabSeries.help'), dep: 'firstGrab' },
      ] },
      { title: t('settings.first.group.arr'), fields: [
        { k: 'firstGrabCancelArr', label: t('settings.field.firstGrabCancelArr.label'), help: t('settings.field.firstGrabCancelArr.help'), dep: 'firstGrab' },
        { k: 'firstGrabFallback', label: t('settings.field.firstGrabFallback.label'), help: t('settings.field.firstGrabFallback.help'), dep: 'firstGrab' },
      ] },
    ] },
  { id: 'merge', icon: 'merge', title: t('settings.merge.title'), nav: t('settings.merge.nav'), lead: t('settings.merge.lead'),
    master: { k: 'mergeEnabled', label: t('settings.field.mergeEnabled.label'), help: t('settings.field.mergeEnabled.help'), need: 'qbit' },
    groups: [
      { fields: [
        { k: 'mergePrimaryDefault', label: t('settings.field.mergePrimaryDefault.label', LP), dep: 'mergeEnabled' },
        { k: 'mergeCredit', label: t('settings.field.mergeCredit.label'), help: t('settings.field.mergeCredit.help', { name: ucFirst(langName(LANG.pri) || '') }), dep: 'mergeEnabled' },
        { k: 'mergeMaxDonorGB', label: t('settings.field.mergeMaxDonorGB.label'), help: t('settings.field.mergeMaxDonorGB.help'), unit: 'GB', min: 1, dep: 'mergeEnabled' },
        { k: 'mergeSaveData', label: t('settings.field.mergeSaveData.label'), help: t('settings.field.mergeSaveData.help'), dep: 'mergeEnabled' },
        { k: 'mergeMaxOffsetSec', label: t('settings.field.mergeMaxOffsetSec.label'), unit: 's', min: 1, max: 600, dep: 'mergeEnabled' },
        { k: 'mergeDeleteDonor', label: t('settings.field.mergeDeleteDonor.label'), help: t('settings.field.mergeDeleteDonor.help'), warn: true, dep: 'mergeEnabled' },
      ] },
      { title: t('nav.backups'), fields: [
        { k: 'keepBackupDays', label: t('settings.field.keepBackupDays.label'), help: t('settings.field.keepBackupDays.help'), unit: t('unit.days'), min: 0 },
        { k: 'maxBackupGB', label: t('settings.field.maxBackupGB.label'), help: t('settings.field.maxBackupGB.help'), unit: 'GB', min: 0 },
        { k: 'backupDeleteVerified', label: t('settings.field.backupDeleteVerified.label'), help: t('settings.field.backupDeleteVerified.help') },
      ] },
    ] },
  { id: 'sync', icon: 'refresh', title: t('sync.title'), lead: t('settings.sync.lead', LP),
    master: { k: 'syncCheckEnabled', label: t('settings.field.syncCheckEnabled.label'), help: t('settings.field.syncCheckEnabled.help') },
    groups: [
      { live: 'sync', fields: [
        { k: 'syncCheckPauseSec', label: t('settings.field.syncCheckPauseSec.label'), help: t('settings.field.syncCheckPauseSec.help'), unit: 's', min: 10, step: 5, dep: 'syncCheckEnabled' },
        { k: 'syncWarnMs', label: t('settings.field.syncWarnMs.label'), help: t('settings.field.syncWarnMs.help'), unit: 'ms', min: 20, step: 10, dep: 'syncCheckEnabled' },
      ] },
    ] },
  { id: 'gpu', icon: 'zap', title: t('settings.gpu.title'), lead: t('settings.gpu.lead'),
    master: { k: 'useGpu', label: t('settings.field.useGpu.label'), help: t('settings.field.useGpu.help'), need: 'speech' },
    groups: [
      { title: t('settings.gpu.group.model'), fields: [
        { k: 'speechModel', label: t('settings.field.speechModel.label'), help: t('settings.field.speechModel.help'), kind: 'choice', need: 'speech', options: [
          ['base', t('settings.field.speechModel.opt.base'), t('settings.field.speechModel.opt.base.help')],
          ['small', t('settings.field.speechModel.opt.small'), t('settings.field.speechModel.opt.small.help')],
        ] },
      ] },
    ] },
  { id: 'notify', icon: 'bell', title: t('settings.notify.title'), lead: t('settings.notify.lead'),
    groups: [
      { fields: [
        { k: 'notifyProposals', label: t('settings.field.notifyProposals.label'), need: 'notify' },
        { k: 'notifyDownloads', label: t('settings.field.notifyDownloads.label'), need: 'notify' },
      ] },
    ] },
];
const SET_FIELDS = SETTINGS_UI.flatMap((s) => [...(s.master ? [{ ...s.master, sec: s.id }] : []), ...(s.groups || []).flatMap((g) => g.fields.map((f) => ({ ...f, sec: s.id })))]);
const SET_NEEDS = {
  qbit: [() => S.ov?.qbit && S.ov?.versions?.qbit, t('settings.need.qbit')],
  speech: [() => S.ov?.speech, t('settings.need.speech')],
  notify: [() => S.ov?.notify?.telegram || S.ov?.notify?.ntfy, t('settings.need.notify')],
};
const setVal = (k) => (k in S.draft ? S.draft[k] : S.settings.settings[k]);
const setDef = (k) => S.settings.defaults?.[k];
const keysOf = (f) => (f.k2 ? [f.k, f.k2] : [f.k]);
const needOk = (f) => !f.need || !!SET_NEEDS[f.need][0]();
S.setQ = '';

function fmtSetting(f, k, v) {
  if (typeof v === 'boolean') return v ? t('settings.value.on') : t('settings.value.off');
  if (f.kind === 'res') return `${v}p`;
  if (f.options) return f.options.find(([x]) => x === v)?.[1] ?? v;
  if (f.kind === 'lang') return v ? langName(v) : t('settings.value.unset');
  if (f.kind === 'locale') return v === 'auto' ? t('settings.value.autoLocale') : langName(v);
  if (f.kind === 'list') return v || t('settings.value.empty');
  return `${v}${f.unit && !f.longUnit ? ` ${f.unit}` : ''}`;
}

function fmtDuration(sec) {
  if (sec < 5400) return t('count.minutes', { count: Math.max(1, Math.round(sec / 60)) });
  if (sec < 2 * 86400) return t('count.hours', { count: Math.round(sec / 3600) });
  return t('count.days', { count: Math.round(sec / 86400) });
}

function setError(f) {
  const msg = [];
  for (const k of keysOf(f)) {
    const v = setVal(k);
    if (typeof setDef(k) !== 'number') continue;
    if (!Number.isFinite(v)) msg.push(t('settings.err.number'));
    else if (f.min != null && v < f.min) msg.push(t('settings.err.min', { v: `${f.min}${f.unit && !f.longUnit ? ` ${f.unit}` : ''}` }));
    else if (f.max != null && v > f.max) msg.push(t('settings.err.max', { v: `${f.max}${f.unit && !f.longUnit ? ` ${f.unit}` : ''}` }));
  }
  if (f.kind === 'res' && setVal(f.k) > setVal(f.k2)) msg.push(t('settings.err.minMax'));
  if (f.k === 'language' && !setVal('language')) msg.push(t('settings.err.language'));
  if (f.k === 'secondLanguage' && setVal('secondLanguage') && setVal('secondLanguage') === setVal('language')) msg.push(t('settings.err.sameLanguage'));
  return msg[0] || '';
}

function setControl(f) {
  const v = setVal(f.k);
  const id = `set-${f.k}`;
  if (f.kind === 'choice') {
    return `<div class="choices" role="radiogroup" aria-labelledby="${id}-l">${f.options.map(([val, l, d]) => `
      <label class="choice"><input type="radio" name="${id}" data-k="${f.k}" value="${val}" ${v === val ? 'checked' : ''}><span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`).join('')}</div>`;
  }
  if (f.kind === 'res') {
    const sel = (k, lbl) => {
      const cur = setVal(k);
      const opts = RES.some(([x]) => x === cur) ? RES : [...RES, [cur, `${cur}p`]].sort((a, b) => a[0] - b[0]);
      return `<select class="select" id="${k === f.k ? id : `set-${k}`}" data-k="${k}" aria-label="${lbl}">${opts.map(([x, l]) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    };
    return `<span class="res-range">${sel(f.k, t('settings.res.min'))}<span class="muted">${t('settings.res.to')}</span>${sel(f.k2, t('settings.res.max'))}</span>`;
  }
  if (f.kind === 'lang' || f.kind === 'locale') {
    const opts = f.kind === 'lang'
      ? (S.langs?.languages || []).map((l) => [l.code, `${langName(l.code)} (${l.label})`]).sort((a, b) => a[1].localeCompare(b[1], I18N.locale))
      : [['auto', t('settings.locale.auto')], ...(S.langs?.locales || []).map((l) => [l, langName(l)])];
    if (f.k === 'language' && !v) opts.unshift(['', t('settings.lang.choose')]);
    if (!opts.some(([x]) => x === v)) opts.unshift([v, v]);
    return `<select class="select" id="${id}" data-k="${f.k}">${opts.map(([x, l]) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  if (f.kind === 'list') return `<div class="list-ctl"><input class="input" id="${id}" type="text" data-k="${f.k}" value="${esc(v)}" spellcheck="false" autocomplete="off"><div class="tag-preview" aria-hidden="true"></div></div>`;
  if (typeof v === 'boolean') return `<label class="switch"><input type="checkbox" role="switch" id="${id}" data-k="${f.k}" ${v ? 'checked' : ''}><span></span></label>`;
  return `<span class="num-ctl"><input class="input num" id="${id}" type="number" inputmode="decimal" data-k="${f.k}" value="${Number.isFinite(v) ? v : ''}" min="${f.min ?? 0}" ${f.max != null ? `max="${f.max}"` : ''} step="${f.step ?? 1}"><span class="unit">${esc(f.unit || '')}</span></span>`;
}

function setRow(f, group, master) {
  const block = f.kind === 'choice' || f.kind === 'list';
  const id = `set-${f.k}`;
  const def = keysOf(f).map((k) => fmtSetting(f, k, setDef(k))).join(' – ');
  const needMsg = needOk(f) ? '' : SET_NEEDS[f.need][1];
  const lbl = f.kind === 'choice' ? `<span class="f-label" id="${id}-l">${esc(f.label)}</span>` : `<label class="f-label" for="${id}">${esc(f.label)}</label>`;
  return `<div class="field ${block ? 'block' : ''} ${f.kind === 'res' ? 'wrap-m' : ''} ${master ? 'master' : ''}" data-keys="${keysOf(f).join(' ')}" ${f.dep ? `data-dep="${f.dep}"` : ''} ${needMsg ? 'data-need-off' : ''}
      data-search="${esc(fold([f.label, f.help, group, keysOf(f).join(' ')].filter(Boolean).join(' ')))}">
    <div class="f-text">
      <div class="f-head">${lbl}${f.restart ? `<span class="chip xs" title="${t('settings.restartTitle')}">${t('settings.restart')}</span>` : ''}</div>
      ${f.help ? `<small class="${f.warn ? 'f-warn' : ''}">${f.warn ? icon('alert') : ''}${esc(f.help)}</small>` : ''}
      ${needMsg ? `<small class="f-need">${icon('plug')}${esc(needMsg)}</small>` : ''}
      <small class="f-err" role="alert"></small>
    </div>
    <div class="f-ctl">
      ${setControl(f)}
      <button class="icon-btn xs f-reset" data-act="setdefault" data-keys="${keysOf(f).join(' ')}" title="${esc(t('settings.resetTitle', { v: def }))}" aria-label="${esc(t('settings.resetLabel', { v: def }))}">${icon('reset')}</button>
    </div>
  </div>`;
}

function connRow(state, ic, name, detail, search) {
  const chip = { ok: ['ok', t('conn.ok')], err: ['danger', t('conn.err')], off: ['', t('conn.off')] }[state];
  return `<div class="conn-row" data-search="${esc(fold(`${name} ${search || ''}`))}">
    <div class="conn-ic ${state}">${icon(ic)}</div>
    <div class="conn-text"><b>${name}</b><small>${detail}</small></div>
    <span class="chip ${chip[0]}">${chip[1]}</span>
  </div>`;
}

// Stav grafické karty podle posledního ověření (při startu kontejneru a ručně v Nastavení)
function gpuConnRow(g) {
  const lc = g?.lastCheck;
  const env = (x) => `<span class="mono">${x}</span>`;
  const name = t('settings.gpu.title');
  if (!g?.enabled) return connRow('off', 'zap', name, t('conn.gpu.off'), 'gpu vulkan');
  if (!lc) return connRow('off', 'zap', name, g.devices ? t('conn.gpu.untested') : t('conn.gpu.noDevice', { dev: env('/dev/dri') }), 'gpu vulkan');
  const bad = lc.steps.find((x) => !x.ok);
  return connRow(lc.ok ? 'ok' : 'err', 'zap', name, lc.ok ? t('conn.gpu.ok', { device: esc(lc.device) }) : `${esc(bad?.label || t('common.errorWord'))}: ${esc(bad?.detail || '')}`, 'gpu vulkan');
}

function connSection() {
  const ov = S.ov || {};
  const v = ov.versions || {};
  const env = (s) => `<span class="mono">${s}</span>`;
  const arr = (on, name, key) => connRow(on ? 'ok' : 'off', key === 'radarr' ? 'film' : 'tv', name, on ? t('conn.version', { v: esc(v[key] || '?') }) : t('conn.arrMissing', { env: env(`${key.toUpperCase()}_URL`) }));
  const notif = t('settings.notify.title');
  return `
    <div class="conn-grid">
      ${arr(ov.radarr, 'Radarr', 'radarr')}
      ${arr(ov.sonarr, 'Sonarr', 'sonarr')}
      ${connRow(!ov.qbit ? 'off' : v.qbit ? 'ok' : 'err', 'download', 'qBittorrent', !ov.qbit ? t('conn.qbitMissing', { env: env('QBIT_PASSWORD') }) : v.qbit ? t('conn.version', { v: esc(v.qbit) }) : t('conn.noResponse'), t('settings.merge.nav'))}
      ${connRow(ov.speech ? 'ok' : 'off', 'mic', t('conn.speech'), ov.speech ? t('conn.speechOk') : t('conn.speechMissing'), `whisper ${t('common.language')}`)}
      ${gpuConnRow(ov.gpu)}
      ${connRow(ov.notify?.telegram ? 'ok' : 'off', 'bell', 'Telegram', ov.notify?.telegram ? t('conn.telegramOk') : `${env('TELEGRAM_BOT_TOKEN')} + ${env('TELEGRAM_CHAT_ID')}`, notif)}
      ${connRow(ov.notify?.ntfy ? 'ok' : 'off', 'bell', 'ntfy', ov.notify?.ntfy ? t('conn.ntfyOk') : env('NTFY_URL'), notif)}
    </div>
    <div class="set-group" data-search-group>
      <h3>${t('settings.webhook.title')}</h3>
      <div class="webhook" data-search="${esc(fold(`webhook ${t('settings.webhook.title')} connect import upgrade`))}">
        <p>${t('settings.webhook.help', { path: '<i>Settings → Connect → + → Webhook</i>', a: '<b>On File Import</b>', b: '<b>On File Upgrade</b>' })}</p>
        ${['radarr', 'sonarr'].map((a) => `<div class="copy-row"><span class="copy-lbl">${a === 'radarr' ? 'Radarr' : 'Sonarr'}</span><code>http://updaterr:8080/api/webhook/${a}</code><button class="icon-btn sm" data-act="copy" data-text="http://updaterr:8080/api/webhook/${a}" title="${t('common.copy')}" aria-label="${t('settings.webhook.copyLabel', { app: a === 'radarr' ? 'Radarr' : 'Sonarr' })}">${icon('copy')}</button></div>`).join('')}
        <p class="note">${t('settings.webhook.outside', { url: `<span class="mono">${esc(location.origin + location.pathname.replace(/\/$/, ''))}/api/webhook/radarr</span>` })}</p>
      </div>
    </div>`;
}

function setSection(s) {
  const st = S.settings.settings;
  const body = s.id === 'conn' ? connSection() : `
    ${s.master && s.master.k in st ? `<div class="set-group">${setRow(s.master, s.title, true)}</div>` : ''}
    ${s.groups.map((g) => {
      const fields = g.fields.filter((f) => keysOf(f).every((k) => k in st));
      if (!fields.length) return '';
      return `<div class="set-group" data-search-group>
        ${g.title ? `<h3>${g.title}</h3>` : ''}
        ${fields.map((f) => setRow(f, `${s.title} ${g.title || ''}`)).join('')}
        ${g.live ? `<div class="set-live" data-live="${g.live}" aria-live="polite"></div>` : ''}
      </div>`;
    }).join('')}
    ${s.id === 'gpu' ? `<div class="set-group" data-search-group><h3>${t('settings.gpu.group.check')}</h3><div class="field" data-search="${esc(fold(`${t('settings.gpu.check.label')} ${t('settings.gpu.check.help')} ${t('settings.gpu.title')} gpu vulkan test`))}"><div class="f-text"><span class="f-label">${t('settings.gpu.check.label')}</span><small>${t('settings.gpu.check.help')}</small></div><div class="f-ctl"><button class="btn sm" data-act="gpucheck" ${needOk({ need: 'speech' }) ? '' : 'disabled'}>${icon('zap')}<span>${t('settings.gpu.check.button')}</span></button><span class="f-reset-space"></span></div></div><div class="set-live" data-live="gpu" aria-live="polite"></div></div>` : ''}
    ${s.id === 'notify' ? `<div class="set-group"><div class="field" data-search="${esc(fold(`${t('settings.notify.test.label')} test ${t('settings.notify.title')}`))}"><div class="f-text"><span class="f-label">${t('settings.notify.test.label')}</span><small>${t('settings.notify.test.help')}</small></div><div class="f-ctl"><button class="btn sm" data-act="testnotify" ${needOk({ need: 'notify' }) ? '' : 'disabled'}>${icon('bell')}<span>${t('settings.notify.test.button')}</span></button><span class="f-reset-space"></span></div></div></div>` : ''}`;
  return `<section class="card set-sec" id="s-${s.id}" data-sec="${s.id}" aria-labelledby="h-${s.id}">
    <header class="set-head">
      <div class="set-ic">${icon(s.icon)}</div>
      <div><h2 id="h-${s.id}">${s.title}</h2><p>${esc(s.lead)}</p></div>
    </header>
    ${body}
  </section>`;
}

let setSpy = null;
function renderSettings() {
  const el = $('#view-settings');
  if (!S.settings?.settings) { el.innerHTML = '<div class="skeleton" style="height:300px"></div>'; return; }
  const hadFocus = document.activeElement?.id === 'set-q';
  el.innerHTML = `
    <div class="page-head"><div><h1>${t('nav.settings')}</h1><p>${t('settings.lead', { file: '<span class="mono">.env</span>' })}</p></div></div>
    <div class="set-layout">
      <aside class="set-nav">
        <label class="set-q"><span class="sr-only">${t('settings.search')}</span>${icon('search')}<input class="input" id="set-q" type="search" placeholder="${t('settings.search')}" value="${esc(S.setQ)}" autocomplete="off"><kbd aria-hidden="true">/</kbd></label>
        <nav aria-label="${t('settings.navLabel')}">${SETTINGS_UI.map((s) => `<button type="button" data-act="setjump" data-sec="${s.id}">${icon(s.icon)}<span>${s.nav || s.title}</span><i class="n-state"></i></button>`).join('')}</nav>
      </aside>
      <div class="set-main">
        ${SETTINGS_UI.map(setSection).join('')}
        <div class="empty set-empty" hidden>${icon('search', 'xl')}<h3>${t('settings.noResults.title')}</h3><p>${t('settings.noResults.text')}</p></div>
      </div>
    </div>
    <div class="savebar" id="savebar" role="region" aria-label="${t('settings.unsavedLabel')}">
      <span id="savebar-text"></span>
      <button class="btn ghost sm" data-act="discard">${t('settings.discard')}</button>
      <button class="btn primary sm" data-act="save" title="${t('settings.saveTitle')}">${icon('check')}<span>${t('common.save')}</span></button>
    </div>`;
  if (hadFocus) { const q = $('#set-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  settingsSync();
  settingsFilter();
  settingsLive();
  // Zvýraznění aktuální sekce v navigaci podle scrollování
  setSpy?.disconnect();
  setSpy = new IntersectionObserver((entries) => {
    const vis = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) $$('.set-nav nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.sec === vis.target.dataset.sec));
  }, { rootMargin: '-90px 0px -55% 0px' });
  $$('.set-sec').forEach((s) => setSpy.observe(s));
}

// Stav polí podle rozpracovaných změn: změněno, chyba, závislosti, tlačítko „výchozí“, lišta s uložením
function settingsSync() {
  if (!$('.set-layout')) return;
  let errors = 0;
  const secChanged = {};
  for (const row of $$('.set-main .field[data-keys]')) {
    const f = SET_FIELDS.find((x) => x.k === row.dataset.keys.split(' ')[0]);
    if (!f) continue;
    const keys = keysOf(f);
    const changed = keys.some((k) => k in S.draft);
    const err = setError(f);
    const depOff = f.dep ? !setVal(f.dep) : false;
    row.classList.toggle('changed', changed);
    row.classList.toggle('invalid', !!err);
    row.classList.toggle('off', depOff);
    $('.f-err', row).textContent = err;
    // neplatnou hodnotu musí jít opravit i ve vypnuté části
    $$('input, select', row).forEach((i) => { i.disabled = (depOff && !err) || row.hasAttribute('data-need-off'); i.setAttribute('aria-invalid', !!err); });
    const reset = $('.f-reset', row);
    const isDef = keys.every((k) => setVal(k) === setDef(k));
    reset.classList.toggle('gone', isDef || depOff);
    reset.tabIndex = isDef || depOff ? -1 : 0;
    if (f.kind === 'list') $('.tag-preview', row).innerHTML = String(setVal(f.k)).split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
    if (changed) secChanged[f.sec] = (secChanged[f.sec] || 0) + keys.filter((k) => k in S.draft).length;
    if (err) errors++;
  }
  for (const s of SETTINGS_UI) {
    const off = s.master && !setVal(s.master.k);
    $(`#s-${s.id}`)?.classList.toggle('is-off', !!off);
    const st = $(`.set-nav [data-sec="${s.id}"] .n-state`);
    if (!st) continue;
    st.className = `n-state ${secChanged[s.id] ? 'dot' : off ? 'off' : ''}`;
    st.textContent = secChanged[s.id] ? '' : off ? t('settings.offShort') : '';
    st.title = secChanged[s.id] ? t('count.unsaved', { count: secChanged[s.id] }) : off ? t('settings.offTitle') : '';
  }
  const n = Object.keys(S.draft).length;
  $('#savebar').classList.toggle('show', n > 0);
  $('#savebar').classList.toggle('bad', errors > 0);
  $('#savebar-text').innerHTML = errors
    ? `${icon('alert')}${t('settings.fixErrors', { count: errors })}`
    : n ? t('count.unsaved', { count: n }) : '';
  $('[data-act="save"]', $('#savebar')).disabled = errors > 0;
  settingsLive();
}

// Odvozené údaje přímo u nastavení (počítají se i z neuložených hodnot)
function settingsLive() {
  const ov = S.ov || {};
  const tempo = $('[data-live="tempo"]');
  if (tempo) {
    const iv = setVal('searchIntervalSec');
    const lim = setVal('maxSearchesPerDay');
    if (!setVal('scannerEnabled') || !(iv > 0) || !(lim > 0)) tempo.hidden = true;
    else {
      tempo.hidden = false;
      const cap = Math.floor(86400 / iv);
      const perDay = Math.min(cap, lim);
      const today = ov.searchesToday || 0;
      const lines = [
        cap < lim
          ? `${icon('alert')}<span>${t('settings.live.cap', { iv, cap: `<b>~${cap}</b>`, lim })}</span>`
          : `${icon('clock')}<span>${t('settings.live.limit', { lim, dur: fmtDuration(lim * iv) })}</span>`,
        ov.queue ? `${icon('layers')}<span>${t('settings.live.queue', { items: t('count.items', { count: ov.queue }), dur: `<b>${fmtDuration((ov.queue / Math.max(1, perDay)) * 86400)}</b>` })}</span>` : '',
      ];
      tempo.innerHTML = `
        <div class="meter-row"><span>${t('settings.live.today')}</span><div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${lim}" aria-valuenow="${today}" aria-label="${t('settings.live.todayLabel')}"><i style="width:${Math.min(100, (today / lim) * 100)}%"></i></div><b class="num">${today} / ${lim}</b></div>
        ${lines.filter(Boolean).map((l) => `<p>${l}</p>`).join('')}`;
    }
  }
  const sync = $('[data-live="sync"]');
  if (sync) {
    const sc = ov.syncCheck;
    sync.hidden = !sc || !setVal('syncCheckEnabled');
    if (sc) {
      sync.innerHTML = `<p>${icon(sc.checking ? 'activity' : 'check')}<span>${sc.checking ? t('library.measuringNow', { name: `<b>${esc(sc.checking)}</b>` }) : t('settings.live.syncIdle')}</span></p>
        <p>${icon('layers')}<span>${t('settings.live.syncQueue', { files: t('count.files', { count: sc.queue || 0 }) })}${sc.bad ? ` · <a href="#library" data-act="showdesync">${t('settings.live.syncBad', { items: t('count.items', { count: sc.bad }) })}</a>` : ''}</span></p>`;
    }
  }
  const gpuBox = $('[data-live="gpu"]');
  if (gpuBox) {
    const g = ov.gpu || {};
    const lc = g.lastCheck;
    const ms = (r) => (r ? `${r.encodeMs ?? r.ms} ms` : '?');
    const lines = [];
    if (g.checking) lines.push(`${icon('refresh', 'spin')}<span>${t('settings.live.gpuChecking')}</span>`);
    else if (!lc) lines.push(`${icon('clock')}<span>${t('settings.live.gpuUntested')}</span>`);
    else {
      lines.push(`${icon(lc.ok ? 'check' : 'alert')}<span>${lc.ok ? t('settings.live.gpuOk', { device: `<b>${esc(lc.device)}</b>` }) : t('settings.live.gpuBad', { what: `<b>${t('settings.live.gpuBadWhat')}</b>` })} · ${t('settings.live.testedAgo', { ago: ago(lc.at) })}</span>`);
      for (const st of lc.steps) lines.push(`${icon(st.ok ? 'check' : 'alert')}<span>${esc(st.label)} – ${esc(st.detail)}</span>`);
      if (lc.ok && lc.gpu && lc.cpu) {
        const a = lc.gpu.encodeMs ?? lc.gpu.ms;
        const b = lc.cpu.encodeMs ?? lc.cpu.ms;
        lines.push(`${icon('zap')}<span>${t('settings.live.bench', { model: esc(String(lc.model || '').replace(/^ggml-|\.bin$/g, '')), gpu: `<b>${ms(lc.gpu)}</b>`, cpu: ms(lc.cpu) })}${a > 0 && b > a ? ` – ${t('settings.live.faster', { x: `<b>${(b / a).toLocaleString(I18N.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×</b>` })}` : ''}</span>`);
      }
    }
    if (g.enabled && g.lastError && !g.checking) lines.push(`${icon('alert')}<span>${t('settings.live.gpuError', { err: esc(g.lastError) })}${g.cpuFallbacks ? ` (${t('settings.live.cpuFallbacks', { count: g.cpuFallbacks })})` : ''}</span>`);
    else if (g.lastUsedAt) lines.push(`${icon('activity')}<span>${t('settings.live.gpuLastUsed', { ago: ago(g.lastUsedAt) })}</span>`);
    gpuBox.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  }
  const first = $('[data-live="first"]');
  if (first) {
    const f = ov.firstGrab;
    first.hidden = !setVal('firstGrab');
    first.innerHTML = [
      f && (f.current || f.queue || f.downloading)
        ? `${icon('activity')}<span>${f.current ? t('settings.live.firstPicking', { title: `<b>${esc(f.current)}</b>` }) : t('settings.live.firstQueue', { items: t('count.items', { count: f.queue }) })}${f.downloading ? ` · ${t('settings.live.firstDownloading', { count: f.downloading })}` : ''}</span>`
        : `${icon('check')}<span>${t('settings.live.firstIdle')}</span>`,
    ].map((l) => `<p>${l}</p>`).join('') + jellyseerrHint(ov.jellyseerr);
  }
  const stalls = $('[data-live="stalls"]');
  if (stalls) {
    const q = ov.stalls;
    stalls.hidden = !q || !setVal('qbitStopStalled') || !(q.stopped || q.watching);
    if (q) {
      stalls.innerHTML = `<p>${icon('layers')}<span>${t('settings.live.stopped', { count: q.stopped, tag: '<b>updaterr-stalled</b>' })}${q.watching ? ` · ${t('settings.live.stalledMore', { count: q.watching })}` : ''}</span></p>`;
    }
  }
}

// Jellyseerr (jen když je připojený): po přidání nesmí spouštět hledání v Radarru/Sonarru
function jellyseerrHint(js) {
  if (!js) return '';
  if (js.error) return `<p>${icon('alert')}<span>${esc(t('jellyseerr.error', { error: js.error }))}</span></p>`;
  const all = [...js.radarr.map((s) => ({ ...s, app: 'Radarr' })), ...js.sonarr.map((s) => ({ ...s, app: 'Sonarr' }))];
  const on = all.filter((s) => s.search);
  if (!all.length) return '';
  if (!on.length) return `<p>${icon('check')}<span>${t('jellyseerr.ok')}</span></p>`;
  const where = js.url ? `<a href="${esc(js.url)}/settings/services" target="_blank" rel="noopener">${t('jellyseerr.where')}</a>` : `<b>${t('jellyseerr.where')}</b>`;
  const names = on.map((s) => `<b>${esc(s.app)}</b>${s.name.toLowerCase() !== s.app.toLowerCase() ? ` (${esc(s.name)})` : ''}${s.is4k ? ' 4K' : ''}`).join(', ');
  return `<p>${icon('alert')}<span>${t('jellyseerr.on', { names })}</span></p>
    <ol class="steps-list">
      <li>${t('jellyseerr.step1', { where })}</li>
      <li>${t('jellyseerr.step2', { names })}</li>
      <li>${t('jellyseerr.step3')}</li>
      <li>${t(on.length > 1 ? 'jellyseerr.step4Each' : 'jellyseerr.step4')}</li>
    </ol>`;
}

function settingsFilter() {
  const q = fold(S.setQ.trim());
  let any = false;
  for (const sec of $$('.set-sec')) {
    let secHit = !q;
    for (const g of $$('[data-search-group]', sec)) {
      let gHit = false;
      for (const r of $$('[data-search]', g)) { const hit = !q || r.dataset.search.includes(q); r.hidden = !hit; gHit ||= hit; }
      g.hidden = !gHit;
      secHit ||= gHit;
    }
    for (const r of $$(':scope > .conn-grid > [data-search], :scope > .set-group:not([data-search-group]) > [data-search]', sec)) { const hit = !q || r.dataset.search.includes(q); r.hidden = !hit; secHit ||= hit; }
    sec.hidden = !secHit;
    $(`.set-nav [data-sec="${sec.dataset.sec}"]`).hidden = !secHit;
    any ||= secHit;
  }
  $('.set-empty').hidden = any;
}

function onSettingInput(e) {
  const t = e.target;
  if (t.id === 'set-q') { S.setQ = t.value; settingsFilter(); return; }
  const k = t.dataset?.k;
  if (!k || !S.settings || (t.type === 'radio' && !t.checked)) return;
  const st = S.settings.settings;
  let v = t.type === 'checkbox' ? t.checked : t.value;
  if (typeof setDef(k) === 'number') v = String(v).trim() === '' ? NaN : Number(v);
  if (v === st[k]) delete S.draft[k]; else S.draft[k] = v;
  settingsSync();
}
$('#view-settings').addEventListener('input', onSettingInput);
$('#view-settings').addEventListener('change', onSettingInput);

// Změna retence záloh v Nastavení maže hned – stejně jako v záložce Zálohy nejdřív ukázat, co se smaže
async function confirmRetention(draft) {
  const keys = ['keepBackupDays', 'maxBackupGB', 'backupDeleteVerified'];
  if (!keys.some((k) => k in draft)) return true;
  const cur = S.settings.settings;
  const val = (k) => (k in draft ? draft[k] : cur[k]);
  const body = { keepBackupDays: val('keepBackupDays'), maxBackupGB: val('maxBackupGB'), deleteVerified: val('backupDeleteVerified'), dryRun: true };
  const { removed } = await api('POST', 'backups/retention', body);
  if (!removed.length) return true;
  const free = removed.reduce((s, r) => s + r.exclusive, 0);
  return confirmDialog({
    title: t('confirm.retention.title', { count: removed.length }),
    text: t('confirm.retention.text', { list: removed.map((r) => `${r.label} (${{ age: t('confirm.retention.older'), verified: t('confirm.retention.verified'), size: t('confirm.retention.overLimit') }[r.why]})`).join(', '), size: free ? gb(free) : '0 GB' }),
    ok: t('confirm.retention.ok'), danger: true,
  });
}

async function saveSettings(btn) {
  if (!Object.keys(S.draft).length || $('#savebar')?.classList.contains('bad')) return;
  await busy(btn || $('[data-act="save"]'), async () => {
    if (!(await confirmRetention(S.draft))) return;
    const r = await api('PUT', 'settings', S.draft);
    S.settings.settings = r.settings;
    S.draft = {};
    toast(t('toast.settingsSaved'));
    renderSettings();
    await loadOverview(); // nové jazyky nebo jazyk UI → stránka se načte znovu
  });
}
document.addEventListener('keydown', (e) => {
  if (S.tab === 'settings' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSettings(); }
});
window.addEventListener('beforeunload', (e) => { if (Object.keys(S.draft).length) e.preventDefault(); });

// ===================================================================================
// Akce
// ===================================================================================
async function act(btn, e) {
  const d = btn.dataset;
  switch (d.act) {
    case 'tab': return showTab(d.tab);
    case 'open': return openDrawer(d.key);
    case 'close': return closeDrawer();
    case 'pfilter': S.propFilter = d.f; lsSet('propFilter', d.f); return renderProposals();

    case 'grab': {
      const p = S.proposals.find((x) => x.id === d.p);
      const c = p?.candidates?.find((x) => x.cid === d.c);
      if (!c) return undefined;
      // Horší obraz kvůli lepšímu jazyku (starší záznamy mají jen text varování)
      const lower = c.lowerRes ?? c.warnings?.some((w) => w.includes('nižší'));
      if (c.kind === 'merge' && c.set) {
        const ok = await confirmDialog({
          title: t('confirm.mergeSet.title'),
          text: t('confirm.mergeSet.text', { torrents: t('count.torrents', { count: c.parts.length }), size: gb(c.size), lang: langLabel(c.mergeLang) }),
          ok: t('option.addAudio'),
        });
        if (!ok) return undefined;
      } else if (lower || c.set || c.seasons?.length > 1) {
        const ok = await confirmDialog({
          title: c.set ? t('confirm.grab.setTitle') : c.seasons?.length > 1 ? t('confirm.grab.packTitle') : t('confirm.grab.lowerTitle'),
          text: [lower && t('confirm.grab.lowerRes', { from: p.current?.res ? `${p.current.res}p` : '?', to: c.res ? `${c.res}p` : '?' }), c.set && t('confirm.grab.set', { count: c.parts.length }), c.seasons?.length > 1 && (c.notes?.[0] || '')].filter(Boolean).join(' '),
          ok: t('common.download'),
        });
        if (!ok) return undefined;
      }
      S.grabbing[p.id] = c.guid;
      return busy(btn, async () => {
        try {
          const r = await api('POST', `proposals/${d.p}/grab/${encodeURIComponent(d.c)}`);
          toast(r.download?.type === 'merge' ? t('toast.grabMerge') : t('toast.grabSent'));
        } finally {
          delete S.grabbing[p.id];
          await refreshAll();
        }
      }, t('common.verifying'));
    }
    case 'skip': return busy(btn, async () => { await api('POST', `proposals/${d.p}/reject`, { guid: d.guid }); toast(t('toast.skipped')); await refreshAll(); });
    case 'reject': return busy(btn, async () => {
      await api('POST', `proposals/${d.p}/reject`, { days: Number(d.days) });
      toast(Number(d.days) > 365 ? t('toast.rejected') : t('toast.snoozed'));
      await refreshAll();
    });
    case 'recheck': e.stopPropagation(); return busy(btn, async () => { await api('POST', `items/${encodeURIComponent(d.key)}/check`); toast(t('toast.rechecking')); await refreshAll(); });
    case 'watch': {
      e.stopPropagation();
      const it = S.items.find((x) => x.key === d.key);
      return busy(btn, async () => {
        await api('POST', `items/${encodeURIComponent(d.key)}/watch`, { enabled: !it?.watch, auto: true });
        toast(it?.watch ? t('toast.watchOff') : it?.app === 'sonarr' ? t('toast.watchOnSeries') : t('toast.watchOn'));
        await refreshAll();
      });
    }
    case 'dwant': {
      if (btn.getAttribute('aria-pressed') === 'true') return;
      return busy(btn, async () => {
        const r = await api('POST', `items/${encodeURIComponent(d.key)}/languages`, { langs: d.langs.split(',') });
        toast(r.want ? `${t('toast.wantOnly', { langs: wantLabel(r.want) })}${r.app === 'sonarr' ? ` ${t('common.wholeSeries')}` : ''}` : t('toast.wantDefault', LP));
        await refreshAll();
      });
    }
    case 'dcodec': {
      if (btn.getAttribute('aria-pressed') === 'true') return;
      return busy(btn, async () => {
        const r = await api('POST', `items/${encodeURIComponent(d.key)}/codec`, { codec: d.codec || null });
        toast(r.codec ? `${t(r.codec === 'av1' ? 'toast.codecAv1' : 'toast.codecHevc')}${r.app === 'sonarr' ? ` ${t('common.wholeSeries')}` : ''}` : t('toast.codecOff'));
        await refreshAll();
      });
    }
    case 'retrymerge': return busy(btn, async () => {
      await api('POST', `bad-donors/${encodeURIComponent(d.id)}/retry`);
      toast(t('toast.retryMerge'));
      await refreshAll();
    });
    case 'unbaddonor': return busy(btn, async () => {
      await api('DELETE', `bad-donors/${encodeURIComponent(d.id)}`);
      toast(t('toast.unblocked'));
      await refreshAll();
    });
    case 'ignore':
    case 'unignore': return busy(btn, async () => {
      await api('POST', `items/${encodeURIComponent(d.key)}/ignore`, { days: d.act === 'ignore' ? 3650 : 0 });
      toast(d.act === 'ignore' ? t('toast.ignored') : t('toast.unignored'));
      await refreshAll();
    });
    case 'bulk': {
      const choice = await bulkDialog();
      if (!choice) return undefined;
      const app = S.lib.app || undefined;
      if (choice.startsWith('listen')) {
        return busy(btn, async () => {
          const r = await api('POST', 'verify-all', { app, force: choice === 'listen-all' });
          toast(r.queued ? t('toast.listenQueued', { count: r.queued }) : t('toast.listenNothing'));
          await refreshAll();
        });
      }
      const maxTier = Number(choice.split('-')[1]);
      return busy(btn, async () => { const r = await api('POST', 'check-all', { maxTier, app }); toast(t('toast.searchQueued', { count: r.reset })); await refreshAll(); });
    }
    case 'listencancel': {
      const q = S.ov?.langQueue || {};
      const ok = await confirmDialog({ title: t('confirm.listenStop.title'), text: t('confirm.listenStop.text', { n: q.queued }), ok: t('confirm.listenStop.ok'), danger: true });
      if (!ok) return undefined;
      return busy(btn, async () => { await api('DELETE', 'verify-all'); toast(t('toast.listenStopped')); await refreshAll(); });
    }
    case 'lunverified': S.lib.unverified = !S.lib.unverified; S.lib.limit = 200; return renderLibrary(false);
    case 'sync': return busy(btn, async () => { await api('POST', 'sync'); toast(t('toast.librarySynced')); await refreshAll(); }, '');
    case 'verifylang': return busy(btn, async () => {
      const r = await api('POST', `items/${encodeURIComponent(d.key)}/verify-language`);
      toast(r.langCheck?.corrected ? t('toast.langWrong', { tier: czOrig(r.current.tier, r.originalLanguage) ? PRI_ORIG_PAREN : TIER[r.current.tier] }) : t('toast.langOk'));
      await refreshAll();
    }, t('common.listening'));
    case 'ltier': S.lib.tier = S.lib.tier === d.t ? '' : d.t; S.lib.limit = 200; return renderLibrary(false);
    case 'lwatched': S.lib.watched = !S.lib.watched; return renderLibrary(false);
    case 'ldesync': S.lib.desync = !S.lib.desync; S.lib.limit = 200; return renderLibrary(false);
    case 'synccheck': return busy(btn, async () => {
      await api('POST', `items/${encodeURIComponent(d.key)}/synccheck`);
      toast(t('toast.measuring'));
      await refreshAll();
    });
    case 'syncfix': {
      const it = S.items.find((x) => x.key === d.key);
      const sy = it?.sync;
      if (!sy) return undefined;
      const ok = await confirmDialog({
        title: t('confirm.syncfix.title'),
        text: t('confirm.syncfix.text', { warn: syncWarnText(sy), lag: syncLag(sy.offsetMs), p: LANG.P, app: it.app === 'sonarr' ? 'Sonarr' : 'Radarr', days: S.settings?.settings?.keepBackupDays ?? 7 }),
        ok: t('confirm.syncfix.ok'),
      });
      if (!ok) return undefined;
      return busy(btn, async () => {
        await api('POST', `items/${encodeURIComponent(d.key)}/syncfix`);
        toast(t('toast.fixing'));
        await refreshAll();
      }, t('common.starting'));
    }
    case 'syncfixall': {
      const keys = libFiltered().filter(syncFixable).map((i) => i.key);
      if (!keys.length) return undefined;
      const ok = await confirmDialog({
        title: t('confirm.syncfixAll.title'),
        text: t('confirm.syncfixAll.text', { count: keys.length, p: LANG.P, days: S.settings?.settings?.keepBackupDays ?? 7 }),
        ok: t('confirm.syncfixAll.ok'),
      });
      if (!ok) return undefined;
      return busy(btn, async () => {
        const r = await api('POST', 'syncfix-all', { keys });
        toast(t('toast.fixAll', { count: r.started, skipped: r.skipped ? t('toast.fixAllSkipped', { n: r.skipped }) : '' }));
        await refreshAll();
      }, t('common.starting'));
    }
    case 'lapp': S.lib.app = d.v; lsSet('lib.app', d.v); $$('[data-act="lapp"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === d.v)); return renderLibrary(false);
    case 'lmore': S.lib.limit += 200; return renderLibrary(false);
    case 'jtoggle': if (!S.act.open.delete(d.id)) S.act.open.add(d.id); return renderActivity(false);
    case 'afilter': S.act.f = d.f; S.act.limit = 60; lsSet('act.f', d.f); return renderActivity(false);
    case 'amore': S.act.limit += 60; return renderActivity(false);
    case 'cancel': {
      const ok = await confirmDialog({ title: t('confirm.cancel.title'), text: t('confirm.cancel.text'), ok: t('confirm.cancel.ok'), danger: true });
      if (!ok) return undefined;
      return busy(btn, async () => { await api('POST', `downloads/${d.id}/cancel`); toast(t('toast.cancelled')); await refreshAll(); });
    }
    case 'loglevel': S.logLevel = d.v; $$('[data-act="loglevel"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === d.v)); return renderLog(false);
    case 'save': return saveSettings(btn);
    case 'discard': S.draft = {}; return renderSettings();
    case 'setjump': {
      $$('.set-nav nav button').forEach((b) => b.setAttribute('aria-current', b === btn));
      $(`#s-${d.sec}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      return undefined;
    }
    case 'setdefault': {
      for (const k of d.keys.split(' ')) {
        const def = setDef(k);
        if (def === S.settings.settings[k]) delete S.draft[k]; else S.draft[k] = def;
        $$(`#view-settings input[data-k="${k}"], #view-settings select[data-k="${k}"]`).forEach((i) => {
          if (i.type === 'checkbox') i.checked = def; else if (i.type === 'radio') i.checked = i.value === def; else i.value = def;
        });
      }
      settingsSync();
      return $('input, select', btn.closest('.field'))?.focus();
    }
    case 'showdesync': S.lib.desync = true; S.lib.limit = 200; return showTab('library');
    case 'gpucheck': return busy(btn, async () => {
      const p = api('POST', 'gpu/check');
      setTimeout(() => loadOverview().catch(() => {}), 300);
      const r = await p;
      toast(r.ok ? t('toast.gpuOk', { device: r.device }) : t('toast.gpuBad'), { error: !r.ok });
      await loadOverview();
      renderSettings();
    }, t('common.testing'));
    case 'bkrefresh': return busy(btn, () => loadBackups(true), '');
    case 'bkretention': return saveRetention(btn);
    case 'bkverify': return busy(btn, async () => {
      const r = await api('POST', `backups/${encodeURIComponent(d.id)}/verify`);
      toast(r.removed?.some((x) => x.id === d.id) ? t('toast.verifyDeleted')
        : r.check?.status === 'ok' ? t('toast.verifyOk')
        : r.check?.status === 'review' ? t('toast.verifyReview') : t('toast.verified'), { error: r.check?.status === 'review' });
      await loadBackups(true);
    }, t('backups.verifying'));
    case 'bkdelete': {
      const b = S.backups?.backups.find((x) => x.id === d.id);
      if (!b) return undefined;
      const ok = await confirmDialog({
        title: t('confirm.bkdelete.title'),
        text: `${b.label}: ${t('count.files', { count: b.files.length })}. ${b.exclusive ? t('confirm.bkdelete.frees', { size: gb(b.exclusive) }) : t('confirm.bkdelete.hardlink')} ${t('confirm.bkdelete.final')}`,
        ok: t('common.delete'), danger: true,
      });
      if (!ok) return undefined;
      return busy(btn, async () => { await api('POST', `backups/${encodeURIComponent(b.id)}/delete`); toast(t('toast.backupDeleted')); await loadBackups(true); });
    }
    case 'testnotify': return busy(btn, async () => { await api('POST', 'notify/test'); toast(t('toast.testSent')); });
    case 'copy':
      if (await copyText(d.text)) toast(t('toast.copied')); else toast(t('toast.copyFailed'), { error: true });
      return undefined;
    default: return undefined;
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn && !btn.matches('input')) {
    if (btn.tagName === 'A' && btn.dataset.act === 'close') { closeDrawer(); return; }
    e.preventDefault();
    act(btn, e);
    return;
  }
  const row = e.target.closest('#lib-table tbody tr[data-key]');
  if (row) openDrawer(row.dataset.key);
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.bkKeep) {
    const v = el.value;
    const body = v === 'auto' ? { reset: true } : v === 'forever' ? { forever: true } : v === 'custom' ? null : { days: Number(v) };
    if (!body) return;
    el.disabled = true;
    try {
      await api('POST', `backups/${encodeURIComponent(el.dataset.bkKeep)}/keep`, body);
      toast(v === 'auto' ? t('toast.keepAuto') : v === 'forever' ? t('toast.keepForever') : t('toast.keepDays', { count: Number(v) }));
      await loadBackups(true);
    } catch (err) { toast(err.message, { error: true }); el.disabled = false; }
    return;
  }
  if (el.dataset.act !== 'dwatch' && el.dataset.act !== 'dauto') return;
  const it = S.items.find((x) => x.key === S.drawer);
  if (!it) return;
  const enabled = el.dataset.act === 'dwatch' ? el.checked : true;
  const auto = el.dataset.act === 'dauto' ? el.checked : true;
  try {
    await api('POST', `items/${encodeURIComponent(it.key)}/watch`, { enabled, auto });
    toast(!enabled ? t('toast.watchOff') : auto ? t('toast.watchAuto') : t('toast.watchAsk'));
    await refreshAll();
  } catch (err) { toast(err.message, { error: true }); el.checked = !el.checked; }
});
$('#view-library').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  S.lib.sort = { key: th.dataset.sort, dir: S.lib.sort.key === th.dataset.sort ? -S.lib.sort.dir : 1 };
  lsSet('lib.sort', S.lib.sort);
  renderLibrary(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.drawer) closeDrawer();
  if (e.key === 'Enter' && e.target.matches?.('#lib-table tbody tr[data-key]')) openDrawer(e.target.dataset.key);
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
    const q = { library: '#lib-q', activity: '#act-q', log: '#log-q', settings: '#set-q' }[S.tab];
    if (q && $(q)) { e.preventDefault(); $(q).focus(); }
  }
});

// ===================================================================================
// Načítání dat
// ===================================================================================
function changed(key, data) {
  const json = JSON.stringify(data);
  if (S.last[key] === json) return false;
  S.last[key] = json;
  return true;
}

async function loadOverview() {
  S.ov = await api('GET', 'overview');
  // Jiné jazyky nebo jazyk UI (třeba po uložení nastavení jinde) → načíst stránku znovu s novými texty
  const boot = I18N.boot;
  if (boot && (S.ov.locale !== boot.locale || S.ov.languages?.primary?.code !== boot.languages?.primary?.code
    || S.ov.languages?.secondary?.code !== boot.languages?.secondary?.code)) { location.reload(); return; }
  renderPulse();
  if (S.tab === 'settings') settingsLive();
}

async function refreshTab() {
  try {
    if (!S.settings) S.settings = await api('GET', 'settings');
    switch (S.tab) {
      case 'proposals': {
        const [p, items] = await Promise.all([api('GET', 'proposals'), S.items.length ? null : api('GET', 'items')]);
        if (items) S.items = items;
        S.proposals = p;
        if (changed('proposals', p) || S.highlight) renderProposals();
        break;
      }
      case 'library':
        S.items = await api('GET', 'items');
        if (changed('library', S.items)) renderLibrary(!$('#lib-table'));
        break;
      case 'activity':
        S.jobs = await api('GET', 'downloads');
        if (changed('activity', S.jobs)) renderActivity(!$('#act-list'));
        break;
      case 'backups':
        await loadBackups();
        break;
      case 'log':
        S.log = await api('GET', 'log');
        if (changed('log', S.log)) renderLog(!$('#log-list'));
        break;
      case 'settings':
        if (!S.langs) S.langs = await api('GET', 'languages');
        if (!Object.keys(S.draft).length) {
          S.settings = await api('GET', 'settings');
          if (changed('settings', [S.settings, S.ov?.versions, S.ov?.qbit, S.ov?.notify, S.ov?.speech, S.ov?.gpu?.enabled, S.ov?.gpu?.lastCheck?.at])) renderSettings();
        }
        break;
      default:
    }
    if (S.drawer) {
      if (S.tab !== 'library') S.items = await api('GET', 'items');
      renderDrawer();
    }
  } catch (e) {
    $('#pulse').innerHTML = `<i class="dot err"></i><span>${t('pulse.offline', { msg: esc(e.message) })}</span>`;
  }
}

async function refreshAll() {
  await loadOverview().catch(() => {});
  S.last[S.tab] = null;
  if (S.tab !== 'library' || S.drawer) S.items = await api('GET', 'items').catch(() => S.items);
  await refreshTab();
}

// Pravidelné obnovování (jen když je stránka vidět a nic se zrovna nepotvrzuje)
let ticks = 0;
setInterval(async () => {
  if (document.hidden || $('#confirm').open || $('#bulk').open) return;
  ticks++;
  await loadOverview().catch((e) => { $('#pulse').innerHTML = `<i class="dot err"></i><span>${t('pulse.offline', { msg: esc(e.message) })}</span>`; });
  const every = { proposals: 2, library: 3, activity: 1, backups: 6, log: 2, settings: 6 }[S.tab] || 2;
  if (ticks % every === 0) refreshTab();
}, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });

// Start
loadOverview().catch(() => {}).finally(route);

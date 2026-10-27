// Hledání upgradů: projde releasy přes interaktivní hledání Radarru/Sonarru (= všechny indexery z Prowlarru),
// vyhodnotí jazyk + kvalitu + seedy a vytvoří návrh ke schválení.
//
// Seriály: kromě balíků jedné série umí i
//  - balíky více sérií ("S01-S04 (CZ/EN)", "S01-S02 (CZ) / S03-S06 (EN)") – jeden společný návrh pro všechny
//    dotčené série (groupKey "sonarr:<id>:multi"), stahuje se přes Sonarr s ručně zadanými epizodami (override),
//  - sady jednotlivých epizod, když balík není a lepší release má každá epizoda, která ho potřebuje.
const crypto = require('node:crypto');
const L = require('./lang');
const C = require('./codec');
const S = require('./seasons');
const { newId, stagingFor } = require('./store');
const { fileState, minCodec } = require('./library');
const { mergeCandidates, badDonorOf, badDonorCode, badDonorLengthMin, neededLang } = require('./merge');
const W = require('./watch');
const LC = require('./langcheck');
const { t } = require('./i18n');

// Odmítnutí od Radarru/Sonarru, kvůli kterým release nemá smysl nabízet.
// (Ostatní – "není upgrade", "kvalita není v profilu", "soubor splňuje cutoff" – ignorujeme schválně,
//  protože právě ta pravidla jazyk neřeší. "Multi-season releases are not supported" řešíme sami.)
const HARD_REJECT = /unknown (movie|series)|unable to (match|parse|identify)|wrong (movie|series|season|episode)|blocklist|sample|hardcoded|already in (the )?(download )?queue|in (the )?queue already|not wanted in (this )?season|couldn.t find|does not match|wasn.t requested/i;
const MULTI_SEASON_REJECT = /multi-season/i;
// "Už je ve frontě" – u prvního stažení (firstgrab.js) nevadí, cizí stažení se případně zruší
const QUEUE_REJECT = /queue/i;

const CONF_RANK = { sure: 2, likely: 1, guess: 0 };
const CONF_BY_RANK = ['guess', 'likely', 'sure'];
// Pořadí procházení: nejdřív jen druhý jazyk (největší šance na dabing), pak neznámé, pak jen primární (hledá se druhý navíc)
const TIER_PRIORITY = { 1: 0, 0: 1, 2: 2, 3: 3 };

const seasonLabel = (title, seasons) => t('search.seasonLabel', { title, seasons: S.formatSeasons(seasons), count: seasons.length });

function itemLabel(item) {
  if (item.app === 'sonarr') return seasonLabel(item.title, [item.season]);
  return `${item.title} (${item.year})`;
}

const groupKeyOf = (item) => `sonarr:${item.arrId}:multi`;

// Stabilní krátké ID kandidáta (pro tlačítka ve webu, Telegramu a ntfy – pořadí se po přehledání mění)
// Stejný release bývá v návrhu dvakrát (výměna souboru i přidání zvuku) – sloučení má proto vlastní ID,
// jinak by tlačítko "Stáhnout" mohlo spustit sloučení (nebo naopak). Výměna si nechává původní ID.
const hash10 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const candId = (c) => hash10(c.kind === 'merge' ? `merge|${c.guid}` : c.kind === 'cutmatch' ? `cutmatch|${c.guid}|${c.donor?.guid}` : String(c.guid));
// Kandidát podle ID (řetězec), nebo podle pořadí (číslo – jen interní volání)
function resolveCandidate(p, ref) {
  const list = p?.candidates || [];
  if (typeof ref === 'number') return ref >= 0 && ref < list.length ? ref : -1;
  const idx = list.findIndex((c) => candId(c) === String(ref));
  if (idx >= 0) return idx;
  // Starší tlačítko sloučení (ID jen z GUID): jen když je release v návrhu jednou, jinak by to bylo nejednoznačné
  const legacy = list.map((c, i) => (hash10(String(c.guid)) === String(ref) ? i : -1)).filter((i) => i >= 0);
  return legacy.length === 1 ? legacy[0] : -1;
}

// Stahování/slučování skončilo bez úspěchu a bez náhrady → návrh znovu otevřít se zbylými kandidáty
function reopenProposal(ctx, job, { dropGuid = null, note } = {}) {
  const p = ctx.store.s.proposals[job.proposalId];
  if (!p || p.status !== 'grabbed' || p.downloadId !== job.id) return;
  if (dropGuid) p.candidates = (p.candidates || []).filter((c) => c.guid !== dropGuid);
  // Náhradní hledání mohlo mezitím založit nový návrh pro stejnou položku – pak starý jen uzavřít
  const keys = proposalKeys(p);
  const newer = Object.values(ctx.store.s.proposals).some((x) => x !== p && x.status === 'pending'
    && Boolean(x.groupKey) === Boolean(p.groupKey) && proposalKeys(x).some((k) => keys.includes(k)));
  p.status = p.candidates?.length && !newer ? 'pending' : 'expired';
  p.note = note || null;
  p.updatedAt = new Date().toISOString();
  p.searchedAt = 0; // před dalším stažením znovu ověřit seedy
  delete p.grabbedIdx;
  delete p.grabbedGuid;
  delete p.grabbedKind;
  delete p.downloadId;
  ctx.store.save();
}
const proposalKeys = (p) => p.itemKeys || [p.itemKey];

// Po načtení knihovny: návrh počítal se soubory, které už neplatí (přibyla epizoda, soubor vyměněn mimo Updaterr) –
// sada epizod by novou epizodu vynechala, sloučení by mířilo do jiného souboru. Návrh zahodit a hledat znovu.
function expireStaleProposals(ctx) {
  const { store } = ctx;
  const ids = (list) => [...(list || [])].sort((a, b) => a - b).join();
  let n = 0;
  for (const p of Object.values(store.s.proposals || {})) {
    if (p.status !== 'pending' || p.first || !p.current?.fileIds) continue;
    const items = proposalKeys(p).map((k) => store.s.items[k]);
    if (items.some((i) => !i || i.missing)) continue;
    if (ids(items.flatMap((i) => i.current.fileIds || [])) === ids(p.current.fileIds)) continue;
    Object.assign(p, { status: 'expired', note: t('search.stale.note'), updatedAt: new Date().toISOString() });
    if (!ctx.busyKeys?.().has(p.itemKey)) ctx.searcher?.enqueue(p.itemKey, { reason: t('search.reason.libraryChange') });
    store.log('info', t('search.stale.log', { label: p.label }));
    n++;
  }
  return n;
}

// want – hledané jazyky položky (W.wantOf), null = oba jazyky; codec – hledaný formát videa (W.codecOf), null = neřešit
function itemNeeds(item, settings, want = null, codec = null) {
  const c = item.current || {};
  const lang = L.wantScore(c.tier, want, item.origLang) < 3;
  const quality = settings.qualityUpgrades && c.res > 0 && c.res < settings.maxResolution;
  // kodek, který MediaInfo neuvádí (null), se neřeší – nevíme, jestli je starší
  const vcodec = Boolean(codec) && c.vcodec != null && c.vcodec < C.wantRank(codec);
  // useknutý/poškozený soubor (library.js truncationOf) – hledá se náhrada, i když jazyk sedí
  const broken = Boolean(c.truncated);
  return { lang, quality, codec: vcodec, broken, any: lang || quality || vcodec || broken };
}

// Souhrnný stav několika sérií (návrh/stahování balíku více sérií)
function combineCurrent(items) {
  const cs = items.map((i) => i.current);
  if (cs.length === 1) return { ...cs[0] };
  const uniq = (k) => [...new Set(cs.map((c) => c[k]))].join(' | ');
  const tierCounts = [0, 0, 0, 0];
  cs.forEach((c) => (c.tierCounts || []).forEach((n, t) => { tierCounts[t] += n; }));
  return {
    tier: Math.min(...cs.map((c) => c.tier)),
    audio: uniq('audio'),
    audioSource: cs.some((c) => c.audioSource === 'nazev') ? 'nazev' : 'mediainfo',
    quality: uniq('quality'),
    qrank: Math.min(...cs.map((c) => c.qrank)),
    res: Math.min(...cs.map((c) => c.res)),
    vcodec: minCodec(cs),
    vcodecName: uniq('vcodecName'),
    size: cs.reduce((a, c) => a + (c.size || 0), 0),
    files: cs.reduce((a, c) => a + (c.files || 0), 0),
    fileIds: cs.flatMap((c) => c.fileIds || []).sort((a, b) => a - b),
    tierCounts,
  };
}

function rejectionsOf(r) {
  return (r.rejections || []).map((x) => (typeof x === 'string' ? x : x?.reason || '')).filter(Boolean);
}

function isLocalIndexer(name, settings) {
  const n = String(name || '').toLowerCase();
  return String(settings.localIndexers || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => n.includes(x));
}

const releaseRes = (r) => L.resolutionOf(r.quality) || L.resolutionFromTitle(r.title);
const qualityName = (r, res) => (r.quality?.quality?.name && r.quality.quality.name !== 'Unknown' ? r.quality.quality.name : `${res}p`);
const indexerName = (r) => String(r.indexer || '').replace(/\s*\(Prowlarr\)\s*$/i, '');

// Kolik epizod série má teď lepší jazyk, než by měl release (série se hodnotí podle nejhorší epizody,
// takže balík jen v primárním jazyce je pro sérii s jednou epizodou jen v druhém jazyce upgrade – ostatní
// epizody s oběma jazyky by ale zhoršil)
function worsenedEpisodes(cur, tier, sc = (x) => x) {
  return (cur.tierCounts || []).reduce((a, n, x) => a + (sc(x) > sc(tier) ? n || 0 : 0), 0);
}

// Je release lepší než současný stav? → { kind, warnings, worse, worseText, lowerRes } nebo null
//   sc – úroveň z pohledu hledaných jazyků (L.wantScore)
//   vc – kodek releasu (C.codecOfTitle, null = neuveden), want – hledaná úroveň kodeku (C.wantRank, null = neřešit)
//   langs – hledané jazyky (W.wantOf, null = oba): release bez nich se nenabízí ani kvůli kvalitě či formátu
function judge(cur, tier, res, st, sc = (x) => x, { vc = null, want = null, langs = null } = {}) {
  const warnings = [];
  let lowerRes = false;
  const offTarget = Boolean(langs) && sc(tier) < 3;
  // S hledaným formátem upozornit, když by release kodek zhoršil (H.265 → H.264)
  const codecDrop = () => {
    if (want && cur.vcodec != null && vc != null && vc < cur.vcodec) warnings.push(t('search.warn.codecDrop', { from: C.nameOf(cur.vcodec), to: C.nameOf(vc) }));
  };
  const lower = () => {
    warnings.push(t('search.warn.lowerRes', { from: cur.res, to: res }));
    lowerRes = true;
  };
  const verdict = (kind) => {
    const worse = worsenedEpisodes(cur, tier, sc);
    const worseText = worse ? t('search.warn.worsens', { count: worse, tier: L.tierLabel(tier) }) : null;
    if (worseText) warnings.push(worseText);
    return { kind, warnings, worse, worseText, ...(lowerRes ? { lowerRes: true } : {}) };
  };
  // Useknutý/poškozený soubor: náhrada celým souborem i se stejným jazykem (a klidně v nižším rozlišení)
  if (cur.truncated && sc(tier) >= sc(cur.tier)) {
    if (res < cur.res) lower();
    codecDrop();
    return verdict(sc(tier) > sc(cur.tier) ? 'language' : 'repair');
  }
  if (sc(tier) > sc(cur.tier)) {
    if (res < cur.res) {
      if (!st.allowLowerQualityForLanguage) return null;
      lower();
    }
    codecDrop();
    return verdict('language');
  }
  // Release bez hledaných jazyků (jen primární jazyk hledaný, release jen v druhém) – kvalita ani formát na tom nic nemění
  if (offTarget) return null;
  // Novější formát videa: hledaný kodek, jazyk ani rozlišení se nezhorší
  if (want && cur.vcodec != null && cur.vcodec < want && vc != null && vc >= want && sc(tier) >= sc(cur.tier) && res >= cur.res) {
    return verdict('codec');
  }
  if (tier === cur.tier && st.qualityUpgrades && res > cur.res) {
    codecDrop();
    return verdict('quality');
  }
  return null;
}

// Společné filtry releasu. Vrací důvod vyřazení (klíč do stats), nebo null.
function basicReject(r, ctx, { allowMultiSeason = false, ignoreQueue = false } = {}) {
  const st = ctx.store.settings;
  if (ctx.store.s.ignoredGuids[r.guid]) return 'ignored';
  const rej = rejectionsOf(r).filter((x) => !(allowMultiSeason && MULTI_SEASON_REJECT.test(x)) && !(ignoreQueue && QUEUE_REJECT.test(x)));
  if (rej.some((x) => HARD_REJECT.test(x) || MULTI_SEASON_REJECT.test(x))) return 'rejected';
  if (L.JUNK_RE.test(r.title) || /cam|telesync|telecine|workprint|dvdscr/i.test(r.quality?.quality?.source || '')) return 'junk';
  if (r.protocol !== 'usenet' && (Number(r.seeders) || 0) < st.minSeeders) return 'dead';
  const res = releaseRes(r);
  if (!res || res < st.minResolution || res > st.maxResolution) return 'res';
  return null;
}

// Kandidát má horší obraz než současný soubor (kvůli lepšímu jazyku). Starší záznamy mají jen text varování.
const lowerRes = (c) => Boolean(c?.lowerRes ?? (c?.warnings || []).some((w) => w.includes('nižší')));

function makeCandidate(r, { lang, tier, res, kind, warnings, lowerRes: lower = false }) {
  const vcodec = C.codecOfTitle(r.title);
  const isTorrent = r.protocol !== 'usenet';
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: indexerName(r),
    title: r.title,
    size: r.size || 0,
    seeders: isTorrent ? Number(r.seeders) || 0 : null,
    leechers: isTorrent ? Number(r.leechers) || 0 : null,
    protocol: r.protocol,
    quality: qualityName(r, res),
    res,
    qrank: L.qualityRank(L.resolutionOf(r.quality) ? r.quality : { quality: { ...r.quality?.quality, resolution: res } }),
    vcodec,
    vcodecName: vcodec != null ? C.nameOf(vcodec, r.title.match(/vp9/i)?.[0]) : null,
    tier,
    pri: lang.pri,
    sec: lang.sec,
    confidence: lang.confidence,
    notes: [...lang.notes],
    kind,
    warnings,
    ...(lower ? { lowerRes: true } : {}),
    ageDays: Math.round(r.ageHours != null ? r.ageHours / 24 : r.age || 0),
    infoUrl: r.infoUrl || r.commentUrl || null,
    infoHash: r.infoHash || null,
    arrRejections: rejectionsOf(r),
    // pro Sonarr override (balíky více sérií)
    arr: { quality: r.quality, languages: r.languages || [] },
  };
}

// Balík více sérií: jazyk zvlášť pro každou část názvu ("S01-S02 (CZ) / S03-S06 (EN)")
function packLangs(r, evalOpts) {
  const fullLang = L.evaluateRelease(r.title, evalOpts);
  const segments = S.seasonSegments(r.title);
  const langFor = (season) => {
    const seg = segments.length > 1 ? segments.find((x) => x.seasons.includes(season)) : null;
    if (!seg) return fullLang;
    const p = L.parseReleaseTitle(seg.text);
    if (!p.audio.size && !p.subs.size && !p.multi && !p.dual) return fullLang;
    // Sonarr dává jazyky za celý release – do části s vlastním jazykem je nepouštět
    return L.evaluateRelease(seg.text, { ...evalOpts, arrLangs: [] });
  };
  return { segments, langFor };
}

// Duplicity (stejný release na víc indexerech / víckrát) – necháme ten s nejvíc seedy, pak seřadit
//   wantCodec – hledaná úroveň kodeku (C.wantRank): po jazyku napřed releasy, které ho splňují
function rank(out, wantCodec = null) {
  const codecOk = (c) => (wantCodec && c.vcodec != null && c.vcodec >= wantCodec ? 1 : 0);
  const dedup = new Map();
  for (const c of out) {
    const k = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '') + ':' + Math.round(c.size / 50e6);
    const prev = dedup.get(k);
    if (!prev || (c.seeders || 0) > (prev.seeders || 0)) dedup.set(k, c);
  }
  return [...dedup.values()].sort((a, b) =>
    b.tier - a.tier ||
    codecOk(b) - codecOk(a) ||
    CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
    (b.targetSeasons?.length || 1) - (a.targetSeasons?.length || 1) ||
    b.res - a.res ||
    // seedy v "logaritmických" kýblech, ať 400 vs 380 seedů nepřebije lepší zdroj
    Math.floor(Math.log2((b.seeders ?? 64) + 1)) - Math.floor(Math.log2((a.seeders ?? 64) + 1)) ||
    b.qrank - a.qrank ||
    (b.seeders || 0) - (a.seeders || 0));
}

// Vyhodnotí seznam releasů vůči aktuálnímu stavu položky.
//   siblings – { [season]: item } ostatní série téhož seriálu v knihovně (pro balíky více sérií)
// Vrací { candidates (filmy / balíky jedné série), multi (balíky více sérií), stats }.
function evaluateReleases(item, releases, ctx, { siblings } = {}) {
  const st = ctx.store.settings;
  const cur = item.current;
  const want = W.wantOf(ctx.store, item);
  const sc = (t) => L.wantScore(t, want, item.origLang);
  const wantCodec = C.wantRank(W.codecOf(ctx.store, item));
  const out = [];
  const multi = [];
  const stats = { total: releases.length, notPack: 0, multiSeason: 0, dead: 0, junk: 0, rejected: 0, notBetter: 0, size: 0, res: 0, ignored: 0 };
  const seasonItems = { ...(siblings || {}), ...(item.app === 'sonarr' ? { [item.season]: item } : {}) };
  const known = Object.values(seasonItems).map((i) => i.episodeCount || i.current.files || 0).filter(Boolean);
  const avgEpisodes = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 10;
  const lowSeeds = (r) => r.protocol !== 'usenet' && (Number(r.seeders) || 0) < st.minSeeders * 3;

  for (const r of releases) {
    let seasons = null;
    if (item.app === 'sonarr') {
      // jednotlivé epizody řeší evaluateEpisodeSet
      if (!r.fullSeason) { stats.notPack++; continue; }
      seasons = S.parseSeasons(r.title);
      if (seasons.length <= 1) seasons = [r.mappedSeasonNumber ?? r.seasonNumber];
      if (!seasons.includes(item.season)) { stats.notPack++; continue; }
      if (seasons.length > 1 && !st.multiSeasonPacks) { stats.notPack++; continue; }
    }
    const isMulti = seasons?.length > 1;

    const why = basicReject(r, ctx, { allowMultiSeason: isMulti });
    if (why) { stats[why]++; continue; }
    const res = releaseRes(r);

    const sizeGB = (r.size || 0) / 1024 ** 3;
    if (item.app === 'radarr' && sizeGB > st.maxMovieSizeGB) { stats.size++; continue; }
    if (item.app === 'sonarr') {
      const episodes = seasons.reduce((a, s) => a + (seasonItems[s]?.episodeCount || seasonItems[s]?.current.files || avgEpisodes), 0);
      if (sizeGB / Math.max(1, episodes) > st.maxEpisodeSizeGB) { stats.size++; continue; }
    }

    const evalOpts = { origLang: item.origLang, arrLangs: r.languages, localIndexer: isLocalIndexer(r.indexer, st) };

    if (!isMulti) {
      const lang = L.evaluateRelease(r.title, evalOpts);
      const tier = L.tierOf(lang, item.origLang);
      const verdict = judge(cur, tier, res, st, sc, { vc: C.codecOfTitle(r.title), want: wantCodec, langs: want });
      if (!verdict) { stats.notBetter++; continue; }
      const warnings = verdict.warnings;
      if (!L.audioVerified(cur)) warnings.push(t('search.warn.currentGuessed'));
      if (lang.confidence === 'guess') warnings.push(t('search.warn.releaseGuess'));
      if (lowSeeds(r)) warnings.push(t('search.warn.lowSeeds'));
      const cut = item.app === 'radarr' && otherCut(ctx, item, r);
      if (cut) warnings.unshift(cut);
      if (cur.truncated) warnings.unshift(truncatedWarning(cur));
      const c = makeCandidate(r, { lang, tier, res, kind: verdict.kind, warnings, lowerRes: verdict.lowerRes });
      if (verdict.worse) c.worsens = verdict.worse;
      if (cut) c.otherEdition = true;
      if (cur.truncated) c.replacesTruncated = true;
      const why = mergeFailedNote(ctx, item, r);
      if (why) {
        c.notes.unshift(why.note);
        c.badDonorId = why.id;
      }
      out.push(c);
      continue;
    }

    stats.multiSeason++;
    const { segments, langFor } = packLangs(r, evalOpts);
    const seasonTiers = {};
    const targets = [];
    const warnings = new Set();
    let kind = 'quality';
    let shown = null; // jazyk nejslabší nahrazované série (pro vlajky a jistotu)
    let lower = false;
    let worsens = 0;
    for (const s of seasons) {
      const lang = langFor(s);
      const tier = L.tierOf(lang, item.origLang);
      seasonTiers[s] = tier;
      const sib = seasonItems[s];
      if (!sib) continue; // série, kterou v knihovně nemáme – v balíku je navíc
      if (sib !== item && sib.ignoredUntil && Date.parse(sib.ignoredUntil) > Date.now()) continue;
      const verdict = judge(sib.current, tier, res, st, sc, { vc: C.codecOfTitle(r.title), want: wantCodec, langs: want });
      if (!verdict) continue;
      targets.push(s);
      if (verdict.kind === 'language') kind = 'language';
      else if (verdict.kind === 'codec' && kind !== 'language') kind = 'codec';
      if (verdict.lowerRes) lower = true;
      verdict.warnings.filter((w) => w !== verdict.worseText).forEach((w) => warnings.add(w));
      worsens += verdict.worse || 0;
      if (!L.audioVerified(sib.current)) warnings.add(t('search.warn.currentGuessed'));
      if (!shown || tier < shown.tier || (tier === shown.tier && CONF_RANK[lang.confidence] < CONF_RANK[shown.lang.confidence])) shown = { lang, tier };
    }
    if (!targets.includes(item.season)) { stats.notBetter++; continue; }
    if (worsens) warnings.add(t('search.warn.worsensPack', { count: worsens }));
    if (shown.lang.confidence === 'guess') warnings.add(t('search.warn.releaseGuess'));
    if (lowSeeds(r)) warnings.add(t('search.warn.lowSeeds'));
    const c = makeCandidate(r, { lang: shown.lang, tier: shown.tier, res, kind, warnings: [...warnings], lowerRes: lower });
    if (worsens) c.worsens = worsens;
    const extra = seasons.filter((s) => !targets.includes(s));
    c.notes.unshift(extra.length
      ? t('search.note.multiPackReplaces', { seasons: S.formatSeasons(seasons), targets: S.formatSeasons(targets), count: targets.length })
      : t('search.note.multiPack', { seasons: S.formatSeasons(seasons) }));
    if (segments.length > 1) c.notes.push(seasons.map((s) => `S${String(s).padStart(2, '0')} ${L.tierLabel(seasonTiers[s])}`).join(', '));
    Object.assign(c, {
      seasons,
      targetSeasons: targets,
      itemKeys: targets.map((s) => seasonItems[s].key),
      seasonTiers,
      searchSeason: item.season,
      searchedAt: Date.now(),
    });
    multi.push(c);
  }

  const merges = mergeCandidates(item, releases, ctx, { HARD_REJECT, rejectionsOf, isLocalIndexer });
  // Dabing ke stávající verzi (sloučení bez jiného střihu) je lepší než výměna verze – tu pak nenabízet
  const combos = merges.some((m) => !m.otherCut) ? [] : cutMatchCandidates(item, releases, ctx);
  return { candidates: rank(out, wantCodec), multi: rank(multi, wantCodec), merges, combos, stats };
}

// Výměna celého souboru za jinou verzi filmu (kino verze místo Extended) – upozornit, ať se nestáhne bez schválení.
// Jistě to víme, když tenhle release už neprošel sloučením kvůli délce; jinak jen podle názvu.
// U useknutého souboru délka o verzi nic neříká – zbývá jen název.
function otherCut(ctx, item, r) {
  const bad = !item.current.truncated && badDonorOf(ctx.store, item.key, r);
  const min = badDonorLengthMin(bad);
  if (min) return t('search.warn.otherCutLength', { min });
  return L.editionWarning(item.current.sceneName, r.title);
}

// Bonusové disky a doprovodné materiály – nejsou film, jako obraz pro výměnu se nehodí
const EXTRAS_RE = /\b(bonus|featurettes?|extras|special[ ._-]features|behind[ ._-]the[ ._-]scenes|appendices)\b/i;

// Slot ('pri' | 'sec') jazyka s kódem `code` (neededLang vrací kód)
const slotOf = (code) => (code === L.primary() ? 'pri' : 'sec');

// Dabing existuje jen k jiné verzi filmu, než je stávající soubor (dabing ke kino verzi, soubor Extended), nebo je
// soubor useknutý: nabídnout dvojici – release ve stejném jazyce jako teď, ale ve verzi, ke které dabing podle
// názvu sedí, a po jeho importu do něj přidat zvuk z donoru (downloads.js chainMerge). Obraz se tak nezhorší
// (oproti výměně za 720p release s dabingem). Jen filmy, vždy jen po schválení.
function cutMatchCandidates(item, releases, ctx) {
  const st = ctx.store.settings;
  const cur = item.current;
  if (item.app !== 'radarr' || !st.mergeEnabled || !ctx.qbit?.enabled || !stagingFor(st, item.app) || !L.audioVerified(cur)) return [];
  const need = neededLang(item, W.wantOf(ctx.store, item));
  if (!need) return [];
  const needSlot = slotOf(need);
  const haveSlot = needSlot === 'pri' ? 'sec' : 'pri';
  const curCut = L.editionOf(cur.sceneName);
  const donors = [];
  const bases = [];
  for (const r of releases) {
    if (basicReject(r, ctx) || EXTRAS_RE.test(r.title)) continue;
    const lang = L.evaluateRelease(r.title, { origLang: item.origLang, arrLangs: r.languages, localIndexer: isLocalIndexer(r.indexer, st) });
    if (lang.confidence === 'guess') continue;
    const x = { r, lang, res: releaseRes(r), cut: L.editionOf(r.title) };
    const sizeGB = (r.size || 0) / 1024 ** 3;
    if (lang[needSlot]) {
      if (r.protocol === 'usenet' || sizeGB > st.mergeMaxDonorGB) continue;
      // Donor, který k souboru nesedí jen délkou, se k nové verzi hodit může; jiné selhání (mrtvý torrent) ne
      const bad = badDonorOf(ctx.store, item.key, r);
      if (bad && badDonorCode(bad) !== 'length') continue;
      // Verzi poznáme jen z názvu – donor musí být podle názvu jiná verze než soubor (u useknutého jakákoli)
      if (!cur.truncated && (x.cut.key === curCut.key || !otherCut(ctx, item, r))) continue;
      donors.push(x);
    } else if (lang[haveSlot] && sizeGB <= st.maxMovieSizeGB && !/br-?disk/i.test(r.quality?.quality?.name || '')) {
      bases.push(x);
    }
  }
  const conf = (l) => CONF_RANK[l.confidence];
  const seeds = (r) => Math.floor(Math.log2((Number(r.seeders) || 0) + 1));
  // Obraz: napřed releasy, které nejsou výrazně menší než stávající soubor (nezhorší datový tok – u useknutého
  // to nejde poznat), se zdravým počtem seedů a lepším zdrojem; pak víc seedů a menší stahování
  const big = (x) => Boolean(cur.truncated || !cur.size || (x.r.size || 0) >= cur.size * 0.7);
  const healthy = (x) => (Number(x.r.seeders) || 0) >= st.minSeeders * 3;
  donors.sort((a, b) => Number(b.lang.pri && b.lang.sec) - Number(a.lang.pri && a.lang.sec) || conf(b.lang) - conf(a.lang) || seeds(b.r) - seeds(a.r) || a.r.size - b.r.size);
  bases.sort((a, b) => b.res - a.res || Number(big(b)) - Number(big(a)) || Number(healthy(b)) - Number(healthy(a)) || conf(b.lang) - conf(a.lang) ||
    L.qualityRank(b.r.quality) - L.qualityRank(a.r.quality) || seeds(b.r) - seeds(a.r) || a.r.size - b.r.size);

  const out = [];
  const cuts = new Set();
  for (const d of donors) {
    if (cuts.has(d.cut.key)) continue;
    // Obraz nesmí být horší než teď (u useknutého než z donoru) a donor sám nesmí být lepší volba.
    // Dva nejlepší obrazy – ať je na výběr mezi menším stahováním a lepší kvalitou.
    const fit = bases.filter((x) => x.cut.key === d.cut.key && x.res >= (cur.truncated ? d.res : cur.res) && !(d.lang[haveSlot] && d.res >= x.res)).slice(0, 2);
    if (!fit.length) continue;
    cuts.add(d.cut.key);
    for (const b of fit) out.push(cutMatchCandidate(item, b, d, { need, haveSlot, curCut, conf, st }));
  }
  return out.slice(0, 2);
}

// Kandidát z dvojice obraz (b) + zdroj zvuku (d)
function cutMatchCandidate(item, b, d, { need, haveSlot, curCut, conf, st }) {
  const cur = item.current;
  const lang = { pri: true, sec: true, confidence: CONF_BY_RANK[Math.min(conf(b.lang), conf(d.lang))], notes: [] };
  const warnings = [];
  if (cur.truncated) warnings.push(truncatedWarning(cur));
  else warnings.push(t('search.cut.warnOther', { cur: curCut.label, rel: b.cut.label, lang: L.label(need) }));
  warnings.push(t('search.cut.warnByTitle'));
  if (Number(b.r.seeders) < st.minSeeders * 3) warnings.push(t('search.warn.lowSeeds'));
  if (Number(d.r.seeders) < st.minSeeders * 3) warnings.push(t('search.cut.warnDonorSeeds'));
  const c = makeCandidate(b.r, { lang, tier: L.tierOf(lang, item.origLang), res: b.res, kind: 'cutmatch', warnings });
  c.baseTier = L.tierOf(b.lang, item.origLang);
  c.baseSize = c.size;
  c.size += d.r.size || 0;
  c.seeders = c.seeders == null ? Number(d.r.seeders) || 0 : Math.min(c.seeders, Number(d.r.seeders) || 0);
  c.notes = [t('search.cut.note', {
    cut: b.cut.label, quality: c.quality, have: L.label(L.slotCode(haveSlot)), lang: L.label(need), title: d.r.title,
    gb: ((d.r.size || 0) / 1024 ** 3).toFixed(1), seeders: d.r.seeders,
  })];
  c.donor = { guid: d.r.guid, indexerId: d.r.indexerId, indexer: indexerName(d.r), title: d.r.title, size: d.r.size || 0, seeders: Number(d.r.seeders) || 0, mergeLang: need, infoHash: d.r.infoHash || null };
  if (!cur.truncated) c.otherEdition = true;
  return c;
}

// Kam v návrhu zařadit dvojici z cutMatchCandidates: před první volbu, která je horší (nižší jazyk, horší obraz,
// jiná verze filmu, náhrada useknutého souboru) – sloučení stop ke stávajícímu souboru (stejná verze) zůstane napřed
function withCutMatch(top, combos) {
  if (!combos.length) return top;
  const worse = (c) => !(c.kind === 'merge' && !c.otherCut) &&
    (c.tier < combos[0].tier || c.otherEdition || c.otherCut || c.replacesTruncated || lowerRes(c));
  const i = top.findIndex(worse);
  return i < 0 ? [...top, ...combos] : [...top.slice(0, i), ...combos, ...top.slice(i)];
}

// Proč u releasu chybí "Přidat zvuk": sloučení s ním už jednou neprošlo (badDonors) – nabízí se jen výměna
// celého souboru. Délku hlásí už otherCut jako varování, tady jen ostatní důvody (synchronizace, …).
// Vrací { note, id } – id záznamu, aby šlo donor rovnou z návrhu odblokovat a zkusit znovu.
function mergeFailedNote(ctx, item, r) {
  if (item.current.truncated) return null;
  const bad = badDonorOf(ctx.store, item.key, r);
  if (!bad || badDonorCode(bad) === 'length') return null;
  // starší záznamy mají před důvodem "Nic nešlo sloučit: "
  const reason = String(bad.reason || t('search.mergeFailed')).replace(/^Nic nešlo sloučit:\s*/, '');
  return { note: t('search.note.mergeFailed', { reason }), id: bad.id };
}

// Varování u každé náhrady useknutého souboru (W.autoAllowed ji bez schválení nestáhne)
const truncatedWarning = (cur) => t('search.warn.truncated', { file: cur.truncated.fileMin, runtime: cur.truncated.runtimeMin });

// Pořadí v návrhu: sloučení stop napřed, když náhrada celého souboru cíl nesplní nebo zhorší obraz
function arrange(main, merges) {
  if (!merges.length) return main;
  const best = main[0];
  const mergeFirst = !best || best.tier < 3 || lowerRes(best);
  return mergeFirst ? [...merges, ...main] : [...main, ...merges];
}

// --- Sady epizod ---------------------------------------------------------------------
// [2, 6, 7, 8] → "E02, E06–E08"
function epRanges(nums) {
  const e = (n) => 'E' + String(n).padStart(2, '0');
  return nums.reduce((acc, n) => {
    const last = acc[acc.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else acc.push([n, n]);
    return acc;
  }, []).map(([a, b]) => (a === b ? e(a) : `${e(a)}–${e(b)}`)).join(', ');
}

// Když série nemá použitelný balík: pro každou epizodu (se souborem), která je pod cílovou úrovní, najít živý
// lepší release jednotlivé epizody (nebo "S01E01-02"). Povede-li se to pro všechny, vznikne jeden kandidát.
//   episodes – epizody seriálu ze Sonarru (/episode), files – { [episodeFileId]: soubor } (/episodefile)
function evaluateEpisodeSet(item, releases, ctx, { episodes, files }) {
  const st = ctx.store.settings;
  const cur = item.current;
  const want = W.wantOf(ctx.store, item);
  const sc = (t) => L.wantScore(t, want, item.origLang);
  const have = episodes
    .filter((e) => e.seasonNumber === item.season && e.hasFile && files[e.episodeFileId])
    .map((e) => ({ id: e.id, num: e.episodeNumber, state: fileState(files[e.episodeFileId], item.origLang) }));
  if (!have.length) return null;

  // Použitelné releasy epizod této série
  const opts = [];
  for (const r of releases) {
    if (r.fullSeason) continue;
    const eps = (r.mappedEpisodeInfo || []).filter((e) => e.seasonNumber === item.season);
    if (!eps.length || (r.mappedSeasonNumber ?? r.seasonNumber) !== item.season) continue;
    if (basicReject(r, ctx)) continue;
    const res = releaseRes(r);
    if ((r.size || 0) / 1024 ** 3 / eps.length > st.maxEpisodeSizeGB) continue;
    const lang = L.evaluateRelease(r.title, { origLang: item.origLang, arrLangs: r.languages, localIndexer: isLocalIndexer(r.indexer, st) });
    opts.push({ r, res, lang, tier: L.tierOf(lang, item.origLang), ids: eps.map((e) => e.id), nums: eps.map((e) => e.episodeNumber) });
  }
  if (!opts.length) return null;

  // Nejvyšší dosažitelná úroveň goal: každá epizoda pod goal musí mít release s úrovní ≥ goal
  // (s vybranými jazyky jen "má všechny hledané" = 3)
  for (const goal of (want ? [3] : [3, 2, 1]).filter((x) => x > sc(cur.tier))) {
    const needing = have.filter((e) => sc(e.state.tier) < goal);
    if (!needing.length) continue;
    const chosen = new Map();
    const warnings = new Set();
    let lower = false;
    let ok = true;
    for (const ep of needing) {
      const fits = opts.filter((o) => o.ids.includes(ep.id) && sc(o.tier) >= goal && (o.res >= ep.state.res || st.allowLowerQualityForLanguage));
      if (!fits.length) { ok = false; break; }
      // už vybraný release, který epizodu taky pokrývá (S01E01-02), má přednost
      const best = fits.find((o) => chosen.has(o.r.guid)) || fits.sort((a, b) =>
        b.tier - a.tier || CONF_RANK[b.lang.confidence] - CONF_RANK[a.lang.confidence] || b.res - a.res ||
        (Number(b.r.seeders) || 0) - (Number(a.r.seeders) || 0))[0];
      if (best.res < ep.state.res) { warnings.add(t('search.warn.lowerRes', { from: ep.state.res, to: best.res })); lower = true; }
      chosen.set(best.r.guid, best);
    }
    if (!ok) continue;
    const parts = [...chosen.values()].sort((a, b) => Math.min(...a.nums) - Math.min(...b.nums));
    if (parts.length > st.maxEpisodeSetParts) return null;
    const guid = 'set:' + crypto.createHash('sha1').update(parts.map((p) => p.r.guid).sort().join('\n')).digest('hex').slice(0, 16);
    if (ctx.store.s.ignoredGuids[guid]) return null;

    const confidence = CONF_BY_RANK[Math.min(...parts.map((p) => CONF_RANK[p.lang.confidence]))];
    const torrents = parts.filter((p) => p.r.protocol !== 'usenet');
    const seeders = torrents.length ? Math.min(...torrents.map((p) => Number(p.r.seeders) || 0)) : null;
    const nums = parts.flatMap((p) => p.nums).sort((a, b) => a - b);
    // epizody, které zůstanou (S01E01-02 může přepsat i epizodu, která cíl už splňuje)
    const kept = have.map((e) => e.num).filter((n) => !nums.includes(n)).sort((a, b) => a - b);
    // výsledná úroveň série: vybrané releasy + epizody, které zůstanou
    const tier = Math.min(...parts.map((p) => p.tier), ...have.filter((e) => !needing.includes(e)).map((e) => e.state.tier));
    if (!L.audioVerified(cur)) warnings.add(t('search.warn.currentGuessed'));
    if (confidence === 'guess') warnings.add(t('search.warn.releaseGuess'));
    if (seeders != null && seeders < st.minSeeders * 3) warnings.add(t('search.warn.lowSeeds'));
    const first = parts[0].r;
    // Série ještě vychází / chybí epizody: sada nahradí jen to, co v knihovně je
    const partial = item.episodeCount > have.length ? t('search.note.setPartial', { have: have.length, total: item.episodeCount }) : null;
    return {
      set: true,
      guid,
      indexerId: first.indexerId,
      indexer: [...new Set(parts.map((p) => indexerName(p.r)))].join(', '),
      title: parts.length > 1 ? t('search.episodeSetTitle', { count: nums.length, title: first.title, more: parts.length - 1 }) : first.title,
      size: parts.reduce((a, p) => a + (p.r.size || 0), 0),
      seeders,
      leechers: torrents.length ? Math.min(...torrents.map((p) => Number(p.r.leechers) || 0)) : null,
      protocol: first.protocol,
      quality: [...new Set(parts.map((p) => qualityName(p.r, p.res)))].join(' | '),
      res: Math.min(...parts.map((p) => p.res)),
      qrank: Math.min(...parts.map((p) => L.qualityRank(p.r.quality))),
      tier,
      pri: parts.every((p) => p.lang.pri),
      sec: parts.every((p) => p.lang.sec),
      confidence,
      notes: [kept.length
        ? t('search.note.episodesKept', { eps: epRanges(nums), kept: epRanges(kept), lang: want ? L.wantLabel(want) : L.tierLabel(goal), count: kept.length })
        : t('search.note.episodes', { eps: epRanges(nums) }), ...(partial ? [partial] : [])],
      kind: 'language',
      warnings: [...warnings],
      ...(lower ? { lowerRes: true } : {}),
      ageDays: Math.max(...parts.map((p) => Math.round(p.r.ageHours != null ? p.r.ageHours / 24 : p.r.age || 0))),
      infoUrl: parts.length === 1 ? first.infoUrl || first.commentUrl || null : null,
      arrRejections: [],
      parts: parts.map((p) => ({
        guid: p.r.guid, indexerId: p.r.indexerId, title: p.r.title, size: p.r.size || 0, protocol: p.r.protocol,
        seeders: p.r.protocol === 'usenet' ? null : Number(p.r.seeders) || 0,
        episodeIds: p.ids, episodes: p.nums, tier: p.tier,
      })),
      searchedAt: Date.now(),
    };
  }
  return null;
}

// Přidání zvuku ze sady jednotlivých epizod: série nemá donor s celou sérií, ale chybějící jazyk má každá epizoda,
// které chybí, ve vlastním torrentu. Video zůstává stávající, z torrentů se bere jen zvuková stopa (merge.js).
function mergeSetPossible(ctx, item) {
  const st = ctx.store.settings;
  return item.app === 'sonarr' && st.mergeEnabled && ctx.qbit?.enabled && stagingFor(st, item.app) && L.audioVerified(item.current) && !item.current.truncated
    && Boolean(neededLang(item, W.wantOf(ctx.store, item)));
}

function evaluateMergeSet(item, releases, ctx, { episodes, files }) {
  if (!mergeSetPossible(ctx, item)) return null;
  const st = ctx.store.settings;
  const need = neededLang(item, W.wantOf(ctx.store, item));
  // Které epizody jazyk nemají – jako Merger.targets (po poslechu značkám nevěřit, rozhodne až slučování)
  const heard = item.current.audioSource === 'poslech';
  const needing = episodes
    .filter((e) => e.seasonNumber === item.season && e.hasFile && files[e.episodeFileId])
    .filter((e) => heard || !L.audioFromMediaInfo(files[e.episodeFileId].mediaInfo?.audioLanguages)[slotOf(need)]);
  if (!needing.length) return null;

  const opts = [];
  for (const r of releases) {
    if (r.fullSeason || r.protocol === 'usenet') continue;
    const eps = (r.mappedEpisodeInfo || []).filter((e) => e.seasonNumber === item.season);
    if (!eps.length || (r.mappedSeasonNumber ?? r.seasonNumber) !== item.season) continue;
    const why = basicReject(r, ctx);
    if (why && why !== 'res') continue; // rozlišení nevadí – obraz se z donoru nebere
    if (badDonorOf(ctx.store, item.key, r)) continue;
    if ((r.size || 0) / 1024 ** 3 / eps.length > st.maxEpisodeSizeGB) continue;
    const lang = L.evaluateRelease(r.title, { origLang: item.origLang, arrLangs: r.languages, localIndexer: isLocalIndexer(r.indexer, st) });
    if (!lang[slotOf(need)] || lang.confidence === 'guess') continue;
    opts.push({ r, lang, dual: Boolean(lang.pri && lang.sec), ids: eps.map((e) => e.id), nums: eps.map((e) => e.episodeNumber) });
  }
  if (!opts.length) return null;

  // Každá epizoda bez jazyka musí mít donor; pořadí jako u donorů s celou sérií (mergeCandidates)
  const seeds = (o) => Math.floor(Math.log2((Number(o.r.seeders) || 0) + 1));
  const better = st.mergeSaveData
    ? (a, b) => CONF_RANK[b.lang.confidence] - CONF_RANK[a.lang.confidence] || (a.r.size || 0) / a.nums.length - (b.r.size || 0) / b.nums.length || Number(b.dual) - Number(a.dual) || seeds(b) - seeds(a)
    : (a, b) => Number(b.dual) - Number(a.dual) || CONF_RANK[b.lang.confidence] - CONF_RANK[a.lang.confidence] || seeds(b) - seeds(a) || (a.r.size || 0) - (b.r.size || 0);
  const chosen = new Map();
  for (const ep of needing) {
    const fits = opts.filter((o) => o.ids.includes(ep.id));
    if (!fits.length) return null;
    const best = fits.find((o) => chosen.has(o.r.guid)) || fits.sort(better)[0];
    chosen.set(best.r.guid, best);
  }
  const parts = [...chosen.values()].sort((a, b) => Math.min(...a.nums) - Math.min(...b.nums));
  if (parts.length > st.maxEpisodeSetParts) return null;
  const guid = 'mset:' + crypto.createHash('sha1').update(parts.map((p) => p.r.guid).sort().join('\n')).digest('hex').slice(0, 16);
  if (ctx.store.s.ignoredGuids[guid]) return null;

  const confidence = CONF_BY_RANK[Math.min(...parts.map((p) => CONF_RANK[p.lang.confidence]))];
  const seeders = Math.min(...parts.map((p) => Number(p.r.seeders) || 0));
  const dual = parts.every((p) => p.dual);
  const nums = [...new Set(parts.flatMap((p) => p.nums))].sort((a, b) => a - b);
  const first = parts[0].r;
  return {
    set: true,
    guid,
    indexerId: first.indexerId,
    indexer: [...new Set(parts.map((p) => indexerName(p.r)))].join(', '),
    title: parts.length > 1 ? t('search.set.title', { count: nums.length, title: first.title, more: parts.length - 1 }) : first.title,
    size: parts.reduce((a, p) => a + (p.r.size || 0), 0),
    seeders,
    leechers: Math.min(...parts.map((p) => Number(p.r.leechers) || 0)),
    protocol: 'torrent',
    quality: item.current.quality,            // video zůstává stávající
    res: item.current.res,
    qrank: item.current.qrank,
    tier: 3,
    pri: true,
    sec: true,
    confidence,
    notes: [t('search.mset.note', { lang: L.label(need), quality: item.current.quality }),
      t('search.mset.episodes', { eps: epRanges(nums) }),
      ...(dual ? [t('search.mset.dual', { p: L.label(L.primary()), s: L.label(L.secondary()) })] : [])],
    kind: 'merge',
    mergeLang: need,
    dualDonor: dual,
    warnings: seeders < st.minSeeders * 3 ? [t('search.warn.lowSeeds')] : [],
    otherCut: false,
    ageDays: Math.max(...parts.map((p) => Math.round(p.r.ageHours != null ? p.r.ageHours / 24 : p.r.age || 0))),
    infoUrl: parts.length === 1 ? first.infoUrl || first.commentUrl || null : null,
    parts: parts.map((p) => ({
      guid: p.r.guid, indexerId: p.r.indexerId, title: p.r.title, size: p.r.size || 0, protocol: p.r.protocol,
      seeders: Number(p.r.seeders) || 0, episodeIds: p.ids, episodes: p.nums, dualDonor: p.dual,
      infoHash: p.r.infoHash || null, downloadUrl: p.r.downloadUrl || null, magnetUrl: p.r.magnetUrl || null,
    })),
    searchedAt: Date.now(),
  };
}

async function seasonFiles(ctx, item) {
  const [episodes, fileList] = await Promise.all([
    ctx.sonarr.get('/episode', { seriesId: item.arrId }),
    ctx.sonarr.get('/episodefile', { seriesId: item.arrId }),
  ]);
  return { episodes, files: Object.fromEntries(fileList.map((f) => [f.id, f])) };
}

async function fetchReleases(ctx, item) {
  const client = item.app === 'radarr' ? ctx.radarr : ctx.sonarr;
  const params = item.app === 'radarr' ? { movieId: item.arrId } : { seriesId: item.arrId, seasonNumber: item.season };
  return client.searchReleases(params);
}

// Ostatní série téhož seriálu, které jde nahradit balíkem (ne ty, které se právě stahují)
function siblingsOf(ctx, item) {
  if (item.app !== 'sonarr') return null;
  const { store } = ctx;
  const busy = ctx.busyKeys();
  return Object.fromEntries(Object.values(store.s.items)
    .filter((x) => x.app === 'sonarr' && x.arrId === item.arrId && x.key !== item.key && !x.missing && !busy.has(x.key))
    .map((x) => [x.season, x]));
}

// Odmítnutí návrhu (web i Telegram). U balíku více sérií se neodkládají samotné série, jen další balíky.
function rejectProposal(ctx, p, days = 3650) {
  const { store } = ctx;
  if (p.status === 'grabbed') throw new Error(t('err.proposalDownloading'));
  if (ctx.inflight?.has(p.id)) throw new Error(t('server.err.approving'));
  p.status = 'rejected';
  p.updatedAt = new Date().toISOString();
  const until = Number(days) > 0 ? new Date(Date.now() + Number(days) * 86400e3).toISOString() : null;
  if (until && p.groupKey) store.s.groupSnooze[p.groupKey] = until;
  else if (until && store.s.items[p.itemKey]) store.s.items[p.itemKey].ignoredUntil = until;
  store.save();
}

// Jeden společný návrh balíků více sérií pro celý seriál. Kandidáti nalezení při hledání jiných sérií zůstávají,
// ti, kteří pokrývají právě hledanou sérii, se nahradí čerstvými.
function upsertGroupProposal(ctx, item, fresh, { reason, silent }) {
  const { store } = ctx;
  const st = store.settings;
  const gk = groupKeyOf(item);
  const now = new Date().toISOString();
  let p = Object.values(store.s.proposals).find((x) => x.groupKey === gk && x.status === 'pending');
  if (store.s.groupSnooze[gk] && Date.parse(store.s.groupSnooze[gk]) > Date.now()) return p || null;

  const kept = (p?.candidates || []).filter((c) => !c.seasons.includes(item.season) && !store.s.ignoredGuids[c.guid]
    && c.itemKeys.every((k) => store.s.items[k]));
  const list = rank([...fresh, ...kept], C.wantRank(W.codecOf(store, item))).slice(0, st.candidatesPerProposal);
  if (!list.length) {
    if (p) {
      p.status = 'expired';
      p.updatedAt = now;
      p.note = t('search.note.noMultiPack');
    }
    return null;
  }

  const isNew = !p;
  const prevBest = p?.candidates?.[0];
  if (!p) {
    p = { id: newId(), groupKey: gk, createdAt: now, status: 'pending' };
    store.s.proposals[p.id] = p;
  }
  const items = [...new Set(list.flatMap((c) => c.itemKeys))]
    .map((k) => store.s.items[k]).filter(Boolean)
    .sort((a, b) => a.season - b.season);
  Object.assign(p, {
    itemKey: items[0].key,
    itemKeys: items.map((i) => i.key),
    seriesId: item.arrId,
    updatedAt: now,
    searchedAt: Math.min(...list.map((c) => c.searchedAt || 0)),
    label: seasonLabel(item.title, items.map((i) => i.season)),
    current: combineCurrent(items),
    candidates: list,
    kind: list[0].kind,
  });
  store.log('info', t('search.proposalMulti', { label: p.label, tier: L.tierLabel(list[0].tier), quality: list[0].quality, seeders: list[0].seeders ?? '?', title: list[0].title, reason }));

  const improved = !prevBest || list[0].tier > prevBest.tier || list[0].res > prevBest.res
    || list[0].targetSeasons.length > prevBest.targetSeasons.length;
  if (!silent && st.notifyProposals && (isNew || improved)) {
    ctx.notify.proposal(p, store.s.items[p.itemKey]).catch((e) => store.log('warn', t('notify.failed', { error: e.message })));
  }
  return p;
}

// Hledání pro jednu položku. Vytvoří/aktualizuje návrh(y) a případně spustí automatické stažení.
async function searchItem(ctx, item, { reason = t('search.reason.schedule'), silent = false } = {}) {
  // Položka bez souboru (první stažení) – hodnotí se jinak, není co upgradovat (firstgrab.js)
  if (item.missing) return ctx.firstGrab.search(item, { reason });
  const { store } = ctx;
  const st = store.settings;
  const t0 = Date.now();
  store.countSearch();
  item.searching = true;
  let releases;
  try {
    releases = await fetchReleases(ctx, item);
  } finally {
    item.searching = false;
  }
  // Během hledání (i minuty) mohla položka zmizet z knihovny
  if (!store.s.items[item.key]) return { proposal: null, groupProposal: null, candidates: [] };
  item = store.s.items[item.key];
  let { candidates, multi, merges, combos, stats } = evaluateReleases(item, releases, ctx, { siblings: siblingsOf(ctx, item) });
  // Než se něco nabídne: ověřit jazyk stávajícího souboru poslechem (značky stop občas lžou)
  if ((candidates.length || multi.length || merges.length || combos.length) && LC.needsCheck(ctx, item)) {
    try {
      const r = await LC.verify(ctx, item, { reason });
      if (r.changed) ({ candidates, multi, merges, combos, stats } = evaluateReleases(item, releases, ctx, { siblings: siblingsOf(ctx, item) }));
    } catch (e) {
      item.langCheck = { fileIds: item.current.fileIds, at: new Date().toISOString(), error: e.message, corrected: false };
      store.log('warn', t('search.langCheckFailed', { label: itemLabel(item), error: e.message }));
    }
  }
  let top = withCutMatch(arrange(candidates.slice(0, st.candidatesPerProposal), merges), combos);

  // Žádný balík → zkusit sadu jednotlivých epizod; žádný donor s celou sérií → přidat zvuk z torrentů epizod
  const wantSet = item.app === 'sonarr' && st.episodeSets && !candidates.length && !multi.length && !merges.length;
  const wantMergeSet = !merges.length && mergeSetPossible(ctx, item) && releases.some((r) => !r.fullSeason);
  if (wantSet || wantMergeSet) {
    try {
      const sf = await seasonFiles(ctx, item);
      const set = wantSet ? evaluateEpisodeSet(item, releases, ctx, sf) : null;
      const mset = wantMergeSet ? evaluateMergeSet(item, releases, ctx, sf) : null;
      top = arrange(set ? [set] : top, mset ? [mset] : []);
    } catch (e) {
      store.log('warn', t('search.episodeSetFailed', { label: itemLabel(item), error: e.message }));
    }
  }

  item.lastSearchedAt = new Date().toISOString();
  item.searchCount = (item.searchCount || 0) + 1;
  const bestTier = Math.max(top[0]?.tier ?? -1, multi[0]?.tier ?? -1);
  item.lastResult = { found: top.length + multi.length, bestTier: bestTier >= 0 ? bestTier : null, stats, ms: Date.now() - t0 };

  const label = itemLabel(item);
  const groupProposal = item.app === 'sonarr' ? upsertGroupProposal(ctx, item, multi, { reason, silent }) : null;
  const existing = Object.values(store.s.proposals).find((p) => p.itemKey === item.key && !p.groupKey && p.status === 'pending');

  if (!top.length) {
    if (existing) {
      existing.status = 'expired';
      existing.updatedAt = item.lastSearchedAt;
      existing.note = t('search.note.nothingNow');
    }
    if (!groupProposal) {
      store.log('info', t('search.nothingBetter', {
        label, total: stats.total, dead: stats.dead, notBetter: stats.notBetter, reason,
        notPack: stats.notPack ? t('search.nothingBetter.notPack', { count: stats.notPack }) : '',
        multi: stats.multiSeason ? t('search.nothingBetter.multi', { count: stats.multiSeason }) : '',
      }));
    }
    store.save();
    return { proposal: null, groupProposal, candidates: [] };
  }

  let proposal = existing;
  const isNew = !proposal;
  const prevBest = proposal?.candidates?.[0];
  if (!proposal) {
    proposal = { id: newId(), itemKey: item.key, createdAt: item.lastSearchedAt, status: 'pending' };
    store.s.proposals[proposal.id] = proposal;
  }
  Object.assign(proposal, {
    updatedAt: item.lastSearchedAt,
    searchedAt: Date.now(),
    label,
    current: { ...item.current },
    candidates: top,
    kind: top[0].kind,
  });
  store.log('info', t('search.proposal', { label, tier: L.tierLabel(top[0].tier), quality: top[0].quality + (top[0].kind === 'codec' ? ` ${top[0].vcodecName}` : ''), seeders: top[0].seeders ?? '?', title: top[0].title, reason }));
  store.save();

  if (silent) return { proposal, groupProposal, candidates: top };

  // Automatické stažení – globální nastavení, nebo hlídaná položka (sady epizod jen po schválení)
  if (W.autoAllowed(store, item, top[0])) {
    try {
      await ctx.grab(proposal.id, 0, { auto: true });
      return { proposal, groupProposal, candidates: top };
    } catch (e) {
      store.log('warn', t('search.autoGrabFailed', { label, error: e.message }));
    }
  }

  const improved = !prevBest || top[0].tier > prevBest.tier || top[0].res > prevBest.res;
  if (st.notifyProposals && (isNew || improved)) ctx.notify.proposal(proposal, item).catch((e) => store.log('warn', t('notify.failed', { error: e.message })));
  return { proposal, groupProposal, candidates: top };
}

// --- Plánovač ------------------------------------------------------------------

class Searcher {
  constructor(ctx) {
    this.ctx = ctx;
    this.manual = []; // [{ key, notBefore, reason }]
    this.busy = false;
    this.current = null;
    this.lastAutoAt = 0;
  }

  enqueue(key, { delayMs = 0, reason = t('search.reason.manual') } = {}) {
    this.manual = this.manual.filter((x) => x.key !== key);
    this.manual.push({ key, notBefore: Date.now() + delayMs, reason });
  }

  eligible() {
    if (!L.primary()) return []; // bez jazyka se knihovna neprochází
    const { store } = this.ctx;
    const st = store.settings;
    const now = Date.now();
    const busyKeys = this.ctx.busyKeys();
    return Object.values(store.s.items)
      .filter((it) => !it.missing && (it.app === 'radarr' ? st.scanRadarr : st.scanSonarr))
      .filter((it) => itemNeeds(it, st, W.wantOf(store, it), W.codecOf(store, it)).any)
      .filter((it) => !busyKeys.has(it.key))
      .filter((it) => !(it.ignoredUntil && Date.parse(it.ignoredUntil) > now))
      .filter((it) => !it.lastSearchedAt || now - Date.parse(it.lastSearchedAt) > W.recheckMs(store, it))
      .sort((a, b) =>
        (W.watchOf(store, a) ? 0 : 1) - (W.watchOf(store, b) ? 0 : 1) || // hlídané napřed
        (a.lastSearchedAt ? 1 : 0) - (b.lastSearchedAt ? 1 : 0) || // nikdy nehledané napřed
        TIER_PRIORITY[a.current.tier] - TIER_PRIORITY[b.current.tier] ||
        String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || // novější napřed
        String(a.lastSearchedAt || '').localeCompare(String(b.lastSearchedAt || '')));
  }

  async tick() {
    if (this.busy) return;
    const { store } = this.ctx;
    const st = store.settings;
    const now = Date.now();

    let job = null;
    const idx = this.manual.findIndex((x) => x.notBefore <= now);
    if (idx >= 0) {
      job = this.manual.splice(idx, 1)[0];
    } else if (st.scannerEnabled && L.primary() && now - this.lastAutoAt >= st.searchIntervalSec * 1000 && store.canSearchToday()) {
      const next = this.eligible()[0];
      if (next) job = { key: next.key, reason: t('search.reason.schedule') };
      this.lastAutoAt = now;
    }
    if (!job) return;
    const item = store.s.items[job.key];
    if (!item || item.missing) return;
    if (this.ctx.busyKeys().has(item.key)) {
      store.log('info', t('search.skippedBusy', { label: itemLabel(item) }));
      return;
    }

    this.busy = true;
    this.current = job.key;
    try {
      await searchItem(this.ctx, item, { reason: job.reason });
    } catch (e) {
      item.lastSearchedAt = new Date().toISOString();
      item.lastResult = { error: e.message };
      store.log('error', t('search.failed', { label: itemLabel(item), error: e.message }));
    } finally {
      this.busy = false;
      this.current = null;
      store.save();
    }
  }
}

module.exports = {
  Searcher, searchItem, evaluateReleases, evaluateEpisodeSet, evaluateMergeSet, fetchReleases, itemNeeds, itemLabel, seasonLabel,
  combineCurrent, rejectProposal, reopenProposal, proposalKeys, expireStaleProposals, groupKeyOf, HARD_REJECT, rejectionsOf, isLocalIndexer,
  candId, resolveCandidate, lowerRes, cutMatchCandidates, withCutMatch, basicReject, makeCandidate, rank, releaseRes, packLangs, judge, worsenedEpisodes,
};

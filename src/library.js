// Načtení knihovny z Radarru/Sonarru a výpočet aktuálního stavu (jazyk + kvalita) každé položky.
// Položka = film (radarr:<movieId>) nebo série seriálu (sonarr:<seriesId>:<season>).
const L = require('./lang');
const LANGS = require('./languages');
const C = require('./codec');
const { applyLangCheck } = require('./langcheck');
const W = require('./watch');
const I18N = require('./i18n');

function posterOf(images) {
  const p = (images || []).find((i) => i.coverType === 'poster');
  return p?.remoteUrl || null;
}

// Aktuální stav jednoho souboru
function fileState(file, origLang) {
  let audio = L.audioFromMediaInfo(file?.mediaInfo?.audioLanguages);
  let source = 'mediainfo';
  if (!audio.known) {
    // MediaInfo nic neříká ("und") → aspoň to, co si Radarr/Sonarr vyparsoval z názvu
    const names = (file?.languages || []).map((l) => l.name);
    const codes = names.map((n) => LANGS.fromArrName(n));
    audio = { pri: codes.includes(L.primary()), sec: codes.includes(L.secondary()), known: false, raw: names.join('/').toLowerCase() };
    source = 'nazev';
  }
  return {
    tier: L.tierOf(audio, origLang),
    audio: audio.raw || '?',
    audioSource: source,
    quality: file?.quality?.quality?.name || '?',
    qrank: L.qualityRank(file?.quality),
    res: L.resolutionOf(file?.quality),
    vcodec: C.rankOfCodec(file?.mediaInfo?.videoCodec), // null = MediaInfo kodek neuvádí
    vcodecName: file?.mediaInfo?.videoCodec ? C.nameOf(C.rankOfCodec(file.mediaInfo.videoCodec), file.mediaInfo.videoCodec) : '?',
    size: file?.size || 0,
  };
}

// Délka z MediaInfo ("H:MM:SS", "MM:SS", případně s desetinami sekund) → sekundy, null = neznámá
function parseRunTime(v) {
  const m = String(v ?? '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?$/);
  if (!m) return null;
  const sec = (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return sec > 0 ? sec : null;
}

// Soubor filmu výrazně kratší než film (useknutý/poškozený, ne jiná verze) → { fileMin, runtimeMin }, jinak null.
// Jen Radarr; když délku filmu nebo souboru neznáme, nic neříkáme.
const TRUNCATED_RATIO = 0.6;
function truncationOf(movie) {
  const runtimeMin = Number(movie?.runtime) || 0;
  const sec = parseRunTime(movie?.movieFile?.mediaInfo?.runTime);
  if (!runtimeMin || !sec || sec >= runtimeMin * 60 * TRUNCATED_RATIO) return null;
  return { fileMin: Math.round(sec / 60), runtimeMin };
}

// Nejstarší známý kodek (u série nejhorší epizoda), null = žádný soubor ho neuvádí
function minCodec(states) {
  const known = states.map((x) => x.vcodec).filter((v) => v != null);
  return known.length ? Math.min(...known) : null;
}

// Souhrnný stav série = nejhorší epizoda
function seasonState(files, origLang) {
  const states = files.map((f) => fileState(f, origLang));
  const tierCounts = [0, 0, 0, 0];
  states.forEach((x) => tierCounts[x.tier]++);
  return {
    tier: Math.min(...states.map((x) => x.tier)),
    audio: [...new Set(states.map((x) => x.audio))].join(' | '),
    audioSource: states.some((x) => x.audioSource === 'nazev') ? 'nazev' : 'mediainfo',
    quality: [...new Set(states.map((x) => x.quality))].join(' | '),
    qrank: Math.min(...states.map((x) => x.qrank)),
    res: Math.min(...states.map((x) => x.res)),
    vcodec: minCodec(states),
    vcodecName: [...new Set(states.map((x) => x.vcodecName))].join(' | '),
    size: files.reduce((a, f) => a + (f.size || 0), 0),
    fileIds: files.map((f) => f.id).sort((a, b) => a - b),
    files: files.length,
    tierCounts,
  };
}

async function syncRadarr(ctx) {
  const { radarr, store } = ctx;
  const movies = await radarr.get('/movie');
  const seen = new Set();
  for (const m of movies) {
    if (!m.hasFile || !m.movieFile) continue;
    const key = `radarr:${m.id}`;
    seen.add(key);
    const origLang = L.origLangOf(m.originalLanguage);
    const cur = fileState(m.movieFile, origLang);
    // Aktualizace na místě: rozběhnuté hledání/stahování drží odkaz na stejný objekt
    store.s.items[key] = Object.assign(store.s.items[key] || {}, {
      key, app: 'radarr', arrId: m.id, season: null,
      title: m.title, year: m.year, poster: posterOf(m.images), monitored: m.monitored,
      origLang, originalLanguage: m.originalLanguage?.name,
      addedAt: m.movieFile.dateAdded,
      current: { ...cur, fileIds: [m.movieFile.id], files: 1, sceneName: m.movieFile.sceneName || m.movieFile.relativePath, truncated: truncationOf(m) },
    });
    delete store.s.items[key].missing; // první stažení (firstgrab.js) je v knihovně
    applyLangCheck(store.s.items[key]);
  }
  return seen;
}

async function syncSonarr(ctx) {
  const { sonarr, store } = ctx;
  const series = await sonarr.get('/series');
  const seen = new Set();
  const withFiles = series.filter((s) => s.statistics?.episodeFileCount > 0);

  let i = 0;
  const worker = async () => {
    while (i < withFiles.length) {
      const s = withFiles[i++];
      const files = await sonarr.get('/episodefile', { seriesId: s.id });
      const origLang = L.origLangOf(s.originalLanguage);
      const bySeason = new Map();
      for (const f of files) {
        if (!f.seasonNumber) continue; // speciály (S00) přeskakujeme
        if (!bySeason.has(f.seasonNumber)) bySeason.set(f.seasonNumber, []);
        bySeason.get(f.seasonNumber).push(f);
      }
      for (const [season, sf] of bySeason) {
        const key = `sonarr:${s.id}:${season}`;
        seen.add(key);
        const seasonInfo = s.seasons?.find((x) => x.seasonNumber === season);
        store.s.items[key] = Object.assign(store.s.items[key] || {}, {
          key, app: 'sonarr', arrId: s.id, season,
          title: s.title, year: s.year, poster: posterOf(s.images), monitored: s.monitored && seasonInfo?.monitored !== false,
          origLang, originalLanguage: s.originalLanguage?.name,
          episodeCount: seasonInfo?.statistics?.totalEpisodeCount || sf.length,
          addedAt: sf.map((f) => f.dateAdded).sort().pop(),
          current: seasonState(sf, origLang),
        });
        delete store.s.items[key].missing;
        applyLangCheck(store.s.items[key]);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return seen;
}

async function syncLibrary(ctx) {
  const { store, radarr, sonarr } = ctx;
  const t0 = Date.now();
  const counts = {};
  const prevKeys = new Set(Object.keys(store.s.items));
  for (const [name, client, fn] of [['radarr', radarr, syncRadarr], ['sonarr', sonarr, syncSonarr]]) {
    if (!client.enabled) continue;
    try {
      const seen = await fn(ctx);
      counts[name] = seen.size;
      // Chybějící položky, které Updaterr právě stahuje poprvé (firstgrab.js) – soubor ještě nemají, nemazat
      for (const [key, it] of Object.entries(store.s.items)) {
        if (it.missing && key.startsWith(name + ':') && !seen.has(key) && ctx.firstGrab?.tracked(key)) seen.add(key);
      }
      // Položky, které z Radarru/Sonarru zmizely (smazané filmy/série), zahodit
      for (const key of Object.keys(store.s.items)) {
        if (key.startsWith(name + ':') && !seen.has(key)) delete store.s.items[key];
      }
      const auto = store.settings.autoWatchNew === 'auto';
      for (const it of W.autoWatchNew(store, name, prevKeys, seen)) {
        const what = it.app === 'sonarr' ? it.title : `${it.title}${it.year ? ` (${it.year})` : ''}`;
        store.log('info', I18N.t(auto ? 'library.newWatchedAuto' : 'library.newWatched', { what, tier: L.tierLabel(it.current.tier) }));
      }
    } catch (e) {
      store.log('error', I18N.t('library.syncFailed', { app: name, error: e.message }));
    }
  }
  // líně – search.js načítá library.js
  require('./search').expireStaleProposals(ctx);
  store.s.lastSync = new Date().toISOString();
  store.save();
  store.log('info', I18N.t('library.loaded', { sec: ((Date.now() - t0) / 1000).toFixed(1), counts: Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') }));
}

// Znovunačtení jedné položky (po importu)
async function refreshItem(ctx, item) {
  if (item.app === 'radarr') {
    const m = await ctx.radarr.get(`/movie/${item.arrId}`);
    if (!m.movieFile) return null;
    const cur = fileState(m.movieFile, item.origLang);
    return { ...cur, fileIds: [m.movieFile.id], files: 1, sceneName: m.movieFile.sceneName || m.movieFile.relativePath, truncated: truncationOf(m), mediaInfoKnown: cur.audioSource === 'mediainfo' };
  }
  const files = (await ctx.sonarr.get('/episodefile', { seriesId: item.arrId })).filter((f) => f.seasonNumber === item.season);
  if (!files.length) return null;
  const st = seasonState(files, item.origLang);
  return { ...st, mediaInfoKnown: st.audioSource === 'mediainfo' };
}

module.exports = { syncLibrary, refreshItem, fileState, minCodec, posterOf, parseRunTime, truncationOf, TRUNCATED_RATIO };

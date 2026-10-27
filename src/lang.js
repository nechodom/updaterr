// Detekce jazyků (audio stopy) – z MediaInfo souboru i z názvu releasu – a výpočet "úrovně".
//
// Pracuje se dvěma jazyky z nastavení: hledaný (primární) jazyk dabingu, třeba čeština, a druhý jazyk,
// obvykle originál (angličtina). Jazyky jsou kódy ISO 639-1 ('cs', 'en', 'de'…), viz languages.js.
// Úrovně (tier):
//   3 = primární + druhý (cíl)   2 = jen primární   1 = jen druhý   0 = nic z toho / neznámé
// U děl, jejichž originál je v primárním jazyce, je cílem samotný primární jazyk (počítá se jako 3).
// Hledané jazyky položky (want) jsou "sloty" 'pri' / 'sec', ať platí i po změně jazyků v nastavení.
const LANGS = require('./languages');
const { t } = require('./i18n');

let PRI = 'cs';
let SEC = 'en';

// Jazyky z nastavení (volá server po načtení a po uložení nastavení). Prázdný primární = ještě nenastaveno.
function configure({ primary, secondary } = {}) {
  PRI = LANGS.get(primary) ? primary : null;
  SEC = LANGS.get(secondary) && secondary !== PRI ? secondary : PRI === 'en' ? null : 'en';
}
const primary = () => PRI;
const secondary = () => SEC;

// Zkratka jazyka pro UI ("CZ", "EN", "DE")
const label = (code) => LANGS.get(code)?.label || String(code || '?').toUpperCase();
const slotCode = (slot) => (slot === 'pri' ? PRI : slot === 'sec' ? SEC : slot);

const SUB_WORDS = new Set(['sub', 'subs', 'subbed', 'subtitle', 'subtitles', 'titles', 'hardsub', 'hc', 'st', 'forced', 'srt',
  ...LANGS.LANGUAGES.flatMap((l) => l.sub)]);
const DUB_WORDS = new Set(['dub', 'dubbed', 'dubbing', 'audio',
  'dd', 'dd2', 'dd5', 'ddp', 'ddp5', 'ddp7', 'dts', 'ac3', 'aac', 'aac2', 'eac3', 'truehd', 'atmos', 'flac', 'mp3', 'opus',
  ...LANGS.LANGUAGES.flatMap((l) => l.dub)]);
// Slova, která samy znamenají titulky v daném jazyce ("VOSTFR" = originál s francouzskými titulky)
const SUB_TOKENS = new Map(LANGS.LANGUAGES.flatMap((l) => l.subTokens.map((w) => [w, l.code])));

// Krátké kódy pro rozdělení "CZtitulky", "ENsub", "PLdub"
const SHORT = [...new Set(LANGS.LANGUAGES.flatMap((l) => l.tokens).filter((w) => /^[a-z]{2,3}$/.test(w)))];
const GLUED_RE = new RegExp(`\\b(${SHORT.join('|')})(dab\\w*|dub\\w*|tit\\w*|sub\\w*)\\b`, 'g');

const tierLabels = () => ({
  3: PRI && SEC ? `${label(PRI)} + ${label(SEC)}` : label(PRI || SEC),
  2: label(PRI),
  1: label(SEC),
  0: t('tier.none', { p: label(PRI), s: label(SEC) }),
});
const tierLabel = (tier) => tierLabels()[tier] ?? '?';
// U děl s originálem v primárním jazyce je cílem samotný primární jazyk – "CZ + EN" by mátlo
const tierText = (tier, origLang) => (tier === 3 && origLang && origLang === PRI ? t('tier.origOnly', { p: label(PRI) }) : tierLabel(tier));

const langOf = (tok) => LANGS.fromToken(tok);
const normLangCode = (code) => LANGS.fromTag(code);

// "cze/eng", "Slovak/Czech", "eng/spa/fra" → { pri, sec, langs, known, raw }
function audioFromMediaInfo(audioLanguages) {
  const langs = String(audioLanguages || '').split(/[\/,;|]+/).map(normLangCode).filter(Boolean);
  return { pri: Boolean(PRI) && langs.includes(PRI), sec: Boolean(SEC) && langs.includes(SEC), langs, known: langs.length > 0, raw: audioLanguages || '' };
}

// "(DE/EN)", "ES-EN", "DE+EN": krátké kódy, které samy nebereme (de, es, it… jsou běžná slova), platí
// v seznamu jazyků spojeném / - +, když je v něm aspoň jeden jednoznačný jazyk. Nahradí se jednoznačným slovem.
const PAIR_RE = /(?<![\p{L}\p{N}])[a-z]{2,3}(?:[\/+-][a-z]{2,3})+(?![\p{L}\p{N}])/gu;
const strongToken = (code) => LANGS.get(code)?.tokens.find((w) => langOf(w) === code) || null;
function expandPairs(s) {
  return s.replace(PAIR_RE, (m) => {
    const parts = m.split(/[\/+-]/);
    if (!parts.some((p) => langOf(p)) || !parts.every((p) => langOf(p) || strongToken(p))) return m;
    return parts.map((p) => (langOf(p) ? p : strongToken(p))).join(' ');
  })
    // Samotný kód v závorkách – "(DE)", "[ES]", "(IT dabing)": v závorce je to označení jazyka, ne slovo
    .replace(/([([])\s*([a-z]{2,3})(?=\s*[)\]]|\s+\p{L})/gu, (m, br, code) => (!langOf(code) && strongToken(code) ? `${br}${strongToken(code)}` : m));
}

// Hranice skupin: závorky, "+" a " - " oddělují části názvu – "(CZ/EN)(CZ titulky)" jsou dvě různé informace
const GROUP = '|';

function tokenize(title) {
  const raw = expandPairs(String(title || '').toLowerCase())
    // "CZtitulky", "CZdab", "ENsub" → rozdělit
    .replace(GLUED_RE, '$1 $2')
    .replace(/[()[\]{}+]|\s[-–]\s/g, ` ${GROUP} `)
    .split(/[^\p{L}\p{N}|]+/u)
    .filter(Boolean)
    .filter((tok, i, all) => tok !== GROUP || (i > 0 && all[i - 1] !== GROUP));
  // "czsk", "czen", "plen" – dva slepené kódy, z nichž aspoň jeden je hledaný
  const out = [];
  for (const tok of raw) {
    const half = tok.length / 2;
    if (!langOf(tok) && (tok.length === 4 || tok.length === 6)) {
      const a = langOf(tok.slice(0, half));
      const b = langOf(tok.slice(half));
      if (a && b && [a, b].some((x) => x === PRI || x === SEC)) { out.push(tok.slice(0, half), tok.slice(half)); continue; }
    }
    out.push(tok);
  }
  return out;
}

// Konec názvu díla: rok, S01/S01E02, rozlišení. Jazykové zkratky před ním můžou být slova z názvu
// ("En.man.som.heter.Ove.2015" je švédský film, ne anglická verze).
const TITLE_END = /^((19|20)\d\d|s\d{1,2}(e\d{1,3})?|\d{3,4}p|season|serie|staffel|saison|temporada|stagione|sezon)$/;

// Najde ve výrazu jazykové zmínky a rozliší, jestli jde o dabing, nebo titulky.
function parseReleaseTitle(title) {
  const tk = tokenize(title);
  const audio = new Set();
  const subs = new Set();
  let multi = false;
  let dual = false;
  const titleEnd = tk.findIndex((x) => TITLE_END.test(x));

  for (let i = 0; i < tk.length; i++) {
    const tok = tk[i];
    if (tok === 'multi' || tok === 'multidub' || tok === 'multiaudio') multi = true;
    if (tok === 'dual' || tok === 'dualaudio' || tok === '2audio') dual = true;
    if (SUB_TOKENS.has(tok)) { subs.add(SUB_TOKENS.get(tok)); continue; }
    const lang = langOf(tok);
    if (!lang) continue;

    // Dopředu: přes řetěz jazyků ("cz en titulky", "cz sk dabing") až k prvnímu ne-jazykovému slovu
    // (řetěz končí i na hranici skupiny)
    let j = i + 1;
    while (j < tk.length && langOf(tk[j])) j++;
    const after = tk[j];
    // "German.DL" = německý dabing + originál (DL = dual language)
    if (after === 'dl') dual = true;
    // Dozadu: "titulky cz en", "sub ita eng"
    let k = i - 1;
    while (k >= 0 && langOf(tk[k])) k--;
    const before = tk[k];

    // V názvu díla platí zkratka jen samostatně ("[CZ] Film 2020", "Film CZ 2020") nebo u slova titulky/dabing
    if (i < titleEnd) {
      const explicit = SUB_WORDS.has(after) || DUB_WORDS.has(after) || SUB_WORDS.has(before);
      if (!explicit && !(after === undefined || after === GROUP || j === titleEnd)) continue;
    }

    let kind = 'audio';
    if (after && SUB_WORDS.has(after)) kind = 'sub';
    else if (after && DUB_WORDS.has(after)) kind = 'audio';
    else if (before && SUB_WORDS.has(before)) kind = 'sub';
    (kind === 'sub' ? subs : audio).add(lang);
  }
  return { audio, subs, multi, dual, tokens: tk.filter((x) => x !== GROUP) };
}

// Vyhodnotí jazyk kandidáta (releasu).
//   origLang – originální jazyk díla (kód ISO 639-1 | 'other')
//   arrLangs – jazyky, které vyparsoval Radarr/Sonarr (pole {name})
//   localIndexer – release pochází z místního trackeru (nastavení localIndexers)
function evaluateRelease(title, { origLang = 'en', arrLangs = [], localIndexer = false } = {}) {
  const p = parseReleaseTitle(title);
  let pri = Boolean(PRI) && p.audio.has(PRI);
  let sec = Boolean(SEC) && p.audio.has(SEC);
  let confidence = 'sure';
  const notes = [];
  const P = label(PRI);

  // Radarr/Sonarr parser jako doplněk (zná i pár dalších zápisů) – ale ne, pokud jde o titulky
  if (PRI && !pri && !p.subs.has(PRI) && (arrLangs || []).some((l) => LANGS.fromArrName(l?.name) === PRI)) {
    pri = true;
    confidence = 'likely';
  }

  const mentionedAudio = p.audio.size > 0;
  if ((p.multi || p.dual) && !(pri && sec)) {
    // DUAL/MULTI: obvykle originál + dabing
    if (pri && SEC && origLang === SEC) { sec = true; confidence = 'likely'; notes.push(t('lang.note.multiOriginal')); }
    // S titulky v primárním jazyce je ten jazyk jen v titulcích – MULTI z místního trackeru pak dabing nenaznačuje
    else if (PRI && !pri && localIndexer && !p.subs.has(PRI)) { pri = true; sec = sec || (Boolean(SEC) && origLang === SEC); confidence = 'guess'; notes.push(t('lang.note.multiLocal', { p: P })); }
    else if (!sec && SEC && origLang === SEC) { sec = true; confidence = confidence === 'sure' ? 'likely' : confidence; }
    // Dílo s originálem v primárním jazyce a DUAL/MULTI: originál je mezi stopami
    else if (PRI && !pri && origLang === PRI) { pri = true; confidence = 'likely'; notes.push(t('lang.note.multiOriginalPrimary', { p: P })); }
  }
  if (!mentionedAudio && !p.multi && !p.dual && !pri) {
    // Bez zmínky o jazyce = originální znění
    if (SEC && origLang === SEC) sec = true;
    if (PRI && origLang === PRI) pri = true;
    if (confidence === 'sure') confidence = 'likely';
    notes.push(t('lang.note.noLanguage'));
  }
  const subsPri = Boolean(PRI) && p.subs.has(PRI);
  if (subsPri) notes.push(t('lang.note.subtitles', { p: P }));

  return { pri, sec, langs: [...p.audio], confidence, notes, subsPri };
}

function tierOf({ pri, sec }, origLang = 'en') {
  if (pri && (sec || (PRI && origLang === PRI) || !SEC)) return 3;
  if (pri) return 2;
  if (sec) return 1;
  return 0;
}

// Hledané jazyky položky (nastavují se u seriálu nebo filmu). Výchozí jsou oba – pořadí P + S › P › S.
// Když vybereš jen jeden, cílem je mít ten jeden a ostatní jazyky se neřeší.
const WANT_LANGS = ['pri', 'sec'];
function normWant(want) {
  const w = WANT_LANGS.filter((l) => (want || []).includes(l));
  return w.length && w.length < WANT_LANGS.length ? w : null; // null = výchozí (oba)
}
const wantLabel = (want) => (want ? want.map((s) => label(slotCode(s))).join(' + ') : tierLabel(3));

// Sloty, které soubor dané úrovně má
function tierSlots(tier, origLang = 'en') {
  if (tier === 3) return PRI && origLang === PRI ? ['pri'] : ['pri', 'sec'];
  return tier === 2 ? ['pri'] : tier === 1 ? ['sec'] : [];
}

// Úroveň z pohledu hledaných jazyků: bez omezení = tier, jinak 3 (má vše hledané) nebo 0
function wantScore(tier, want, origLang = 'en') {
  if (!want) return tier;
  const has = tierSlots(tier, origLang);
  return want.every((l) => has.includes(l)) ? 3 : 0;
}

// Originální jazyk z Radarru/Sonarru ({ name: 'Czech' }) → 'cs'; neznámý → 'other'
function origLangOf(languageObj) {
  return LANGS.fromArrName(languageObj?.name) || 'other';
}

// --- Kvalita -----------------------------------------------------------------

const SOURCE_SCORE = {
  // Radarr
  cam: -10, telesync: -10, telecine: -10, workprint: -10, dvdscr: -5,
  dvd: 1, tv: 2, webrip: 3, webdl: 4, bluray: 5,
  // Sonarr
  television: 2, televisionraw: 2, web: 4, blurayraw: 6,
};

function qualityRank(q) {
  // q = { quality: { name, source, resolution, modifier } }
  const qq = q?.quality || q || {};
  const res = Number(qq.resolution) || 0;
  let src = SOURCE_SCORE[String(qq.source || '').toLowerCase()] ?? 0;
  const mod = String(qq.modifier || '').toLowerCase();
  if (mod === 'remux' || /remux/i.test(qq.name || '')) src = 6;
  if (mod === 'screener' || mod === 'regional') src = Math.min(src, 0);
  const resScore = res >= 2160 ? 4 : res >= 1080 ? 3 : res >= 720 ? 2 : res >= 480 ? 1 : 0;
  return resScore * 10 + src;
}

function resolutionOf(q) {
  return Number((q?.quality || q || {}).resolution) || 0;
}

// Záloha, když Radarr/Sonarr kvalitu nepozná ("Unknown") – české trackery píšou "[720pHD]", "(1080p)", "4K"
function resolutionFromTitle(title) {
  const m = String(title || '').match(/(?:^|[^a-z0-9])(2160|1080|720|576|480)[pi](?![a-z0-9])|(?:^|[^a-z0-9])(?:(4k|uhd)|(fullhd|fhd))(?![a-z0-9])/i)
    || String(title || '').match(/(2160|1080|720)p/i);
  if (!m) return 0;
  if (m[1]) return Number(m[1]);
  if (m[2]) return 2160;
  if (m[3]) return 1080;
  return 0;
}

// Jazyk stávajícího souboru je ověřený: ze značek stop (MediaInfo) nebo poslechem; 'nazev' = jen odhad z názvu
const audioVerified = (cur) => cur?.audioSource === 'mediainfo' || cur?.audioSource === 'poslech';

// Verze (střih) filmu podle názvu: Extended, Director's Cut… Bez značky = běžná (kino) verze.
// Délku filmu z názvu nepoznáme – je to jen odhad, potvrdí ho až porovnání délky při slučování.
// Vedle anglických značek i místní zápisy (prodloužená/rozšířená/režisérská/nesestříhaná verze).
const EDITIONS = [
  // EE / EXT = Extended Edition (Tigole „EE“, 3Li „EXT“)
  ['extended', /\b(extended|prodlouzena|rozsirena|ee|ext)\b/],
  ['directors', /\b(directors?'?s?[ ._-]?cut|rezisersk[aey])\b/],
  ['unrated', /\b(unrated|uncut|nesestrihana)\b/],
  ['ultimate', /\bultimate[ ._-]?(edition|cut)\b/],
  ['final', /\bfinal[ ._-]?cut\b/],
];
function editionOf(title) {
  const s = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const key = EDITIONS.find(([, re]) => re.test(s))?.[0] || 'theatrical';
  return { key, label: t(`edition.${key}`) };
}
// Upozornění, když release podle názvu není stejná verze filmu jako stávající soubor (jinak null)
function editionWarning(curTitle, relTitle) {
  const cur = editionOf(curTitle);
  const rel = editionOf(relTitle);
  if (cur.key === rel.key) return null;
  return t(rel.key === 'theatrical' ? 'edition.warningLikely' : 'edition.warning', { cur: cur.label, rel: rel.label });
}

const JUNK_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|hdtc|scr|screener|dvdscr|workprint|3d|sbs|hsbs|half[\s.-]?sbs|half[\s.-]?ou)\b/i;

module.exports = {
  configure, primary, secondary, label, slotCode, tierLabel, tierLabels, tierText, tierSlots,
  WANT_LANGS, normWant, wantLabel, wantScore, audioFromMediaInfo, parseReleaseTitle, evaluateRelease, tierOf, origLangOf,
  qualityRank, resolutionOf, resolutionFromTitle, JUNK_RE, normLangCode, audioVerified, editionOf, editionWarning,
};

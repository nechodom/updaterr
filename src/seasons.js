// Rozsahy sérií v názvech releasů: "S01-S04", "S01.S02.S03", "Season 1-4", "1.-3. série",
// "S01-S02 (CZ) / S03-S06 (EN)" (různé jazyky pro různé série) apod.
const { t } = require('./i18n');

const MAX_SEASON = 99;
const DASH = '[-–—~]';
const SEP = '[\\s._]';
const WORD_START = '(?<![\\p{L}\\d])'; // \b z ASCII – před "ř"/"Ř" nefunguje

const range = (a, b) => {
  a = Number(a);
  b = Number(b);
  if (!(a <= b) || b - a > 60) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
};

// Všechny série zmíněné v textu (seřazené, bez S00). Prázdné pole = žádná zmínka.
function parseSeasons(text) {
  const t = String(text || '');
  const out = new Set();
  const add = (list) => list.forEach((n) => n > 0 && n <= MAX_SEASON && out.add(n));
  let m;

  // S01-S04, S01-04, S01-4, (S01 - S04)
  const reRange = new RegExp(`\\bS(\\d{1,2})\\s*${DASH}\\s*S?(\\d{1,2})\\b(?!\\s*E\\d)`, 'gi');
  while ((m = reRange.exec(t))) add(range(m[1], m[2]));

  // S01.S02.S03 / S01 S04 (pomlčku indexer zahodil) / S01.S01 (duplicitní zápis)
  const reSeq = new RegExp(`\\bS\\d{1,2}(?:${SEP}+S\\d{1,2})+\\b(?!E\\d)`, 'gi');
  while ((m = reSeq.exec(t))) {
    const nums = [...new Set(m[0].match(/\d{1,2}/g).map(Number))].sort((a, b) => a - b);
    // dvě nesousední čísla ("S01 S04") = rozsah, jinak výčet
    add(nums.length === 2 ? range(nums[0], nums[1]) : nums);
  }

  // Season 1-4, Seasons 1 to 4, Série 1-3, Season.1.4. Čísla musí být celá ("Season 14" není 1–4)
  // a druhé nesmí být kanály zvuku ("Season 1 5.1"). \b nefunguje před "ř" – proto lookbehind s /u.
  const reWordRange = new RegExp(`${WORD_START}(?:seasons?|series|s[eé]rie|serie|řada|rada|sezóna|sezona)${SEP}*(\\d{1,2})(?!\\d)${SEP}*(?:${DASH}|to|až|az)?${SEP}*(\\d{1,2})\\b(?![.,]\\d)(?!\\s*(?:p|i|bit)\\b)(?!${SEP}*(?:ep|eps|episodes?|epizod[aey]?|d[ií]l[yůu]?)\\b)`, 'giu');
  while ((m = reWordRange.exec(t))) add(range(m[1], m[2]));

  // 1-4. série, 1.-3. řada, 1. - 4. sezóna
  const reCzRange = new RegExp(`\\b(\\d{1,2})\\.?\\s*${DASH}\\s*(\\d{1,2})\\.?\\s*(?:s[eé]rie|řada|rada|sezóna|sezona)\\b`, 'gi');
  while ((m = reCzRange.exec(t))) add(range(m[1], m[2]));

  // Jednotlivě: S01, S01E05, Season 2, 2. série
  const reSingle = /\bS(\d{1,2})(?=E\d|\b)/gi;
  while ((m = reSingle.exec(t))) add([Number(m[1])]);
  const reWord = /(?<![\p{L}\d])(?:season|series|s[eé]rie|serie|řada|rada|sezóna|sezona)[\s._]*(\d{1,2})\b(?!\s*(?:p|i|bit)\b)/giu;
  while ((m = reWord.exec(t))) add([Number(m[1])]);
  const reCz = /\b(\d{1,2})\.\s*(?:s[eé]rie|řada|rada|sezóna|sezona)\b/gi;
  while ((m = reCz.exec(t))) add([Number(m[1])]);

  return [...out].sort((a, b) => a - b);
}

// Rozdělí název na části podle série: "X S01-S02 (CZ) / S03-S06 (EN)" → [{ text, seasons:[1,2] }, { text, seasons:[3..6] }].
// Dělí se jen na "/", "|", "+", ";" a jen tam, kde obě strany zmiňují série – "(CZ/EN)" zůstane pohromadě.
function seasonSegments(title) {
  const pieces = String(title || '').split(/([/|+;])/);
  const raw = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const text = pieces[i] + (pieces[i + 1] || '');
    if (!raw.length || parseSeasons(pieces[i]).length) raw.push(text);
    else raw[raw.length - 1] += text;
  }
  // úvodní část bez série ("Název / Name S01-S03") patří k následující
  if (raw.length > 1 && !parseSeasons(raw[0]).length) raw.splice(0, 2, raw[0] + raw[1]);
  // Každá série patří první části, která ji zmiňuje
  const seen = new Set();
  return raw.map((text) => {
    const own = parseSeasons(text).filter((n) => !seen.has(n));
    own.forEach((n) => seen.add(n));
    return { text: text.replace(/[\s/|+;]+$/, '').trim(), seasons: own };
  }).filter((x) => x.seasons.length);
}

// Co release pokrývá: { seasons, segments }. Bez zmínky o sérii vrací prázdné pole.
function seasonCoverage(title) {
  const seasons = parseSeasons(title);
  const segments = seasons.length > 1 ? seasonSegments(title) : [];
  return { seasons, segments: segments.length > 1 ? segments : [] };
}

// [1,2,3] → "01.–03."   [1,3] → "01., 03."   (anglicky "1–3", "1, 3")
function formatSeasons(list) {
  const s = [...list].sort((a, b) => a - b);
  const pad = (n) => t('common.seasonNum', { n, nn: String(n).padStart(2, '0') });
  if (s.length === 1) return pad(s[0]);
  const contiguous = s.every((n, i) => i === 0 || n === s[i - 1] + 1);
  return contiguous ? `${pad(s[0])}–${pad(s[s.length - 1])}` : s.map(pad).join(', ');
}

module.exports = { parseSeasons, seasonSegments, seasonCoverage, formatSeasons };

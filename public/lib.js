'use strict';
/* ==========================================================================
   Pomocné funkce bez DOM – používá je app.js a dají se otestovat v Node (test/web.test.js)
   ========================================================================== */

// Bez diakritiky a malými písmeny: "Pelíšky" najde i "pelisky"
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Řazení: texty podle jazyka rozhraní (česky ch za h, Č za C…), čísla a data podle hodnoty
const uiLocale = () => globalThis.I18N?.locale || undefined;
const textCompare = (a, b, locale = uiLocale()) => String(a).localeCompare(String(b), locale, { sensitivity: 'base', numeric: true });
function compareValues(x, y, locale = uiLocale()) {
  if (typeof x === 'string' || typeof y === 'string') return textCompare(x ?? '', y ?? '', locale);
  return x > y ? 1 : x < y ? -1 : 0;
}

// Zkopírovat text: Clipboard API funguje jen na https/localhost – po http se použije skrytá textarea
async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  if (nav?.clipboard?.writeText && globalThis.isSecureContext !== false) {
    try { await nav.clipboard.writeText(text); return true; } catch { /* zkusit náhradní cestu */ }
  }
  if (!doc?.body) return false;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  doc.body.appendChild(ta);
  try {
    ta.select();
    return Boolean(doc.execCommand?.('copy'));
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

if (typeof module !== 'undefined') module.exports = { fold, textCompare, compareValues, copyText };

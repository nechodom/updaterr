// Analýza zvukových stop (ffprobe) a kontrola synchronizace dvou stop přes korelaci zvukové obálky.
//
// Dabing a originál sdílejí hudbu a ruchy (M&E), takže "obálka" hlasitosti (nástupy zvuků) obou stop
// koreluje. V několika místech filmu najdeme posun, při kterém se obálky nejlépe překrývají. Když všechna
// místa dávají stejný posun, stopa sedí (případně s konstantním zpožděním, které při slučování vyrovnáme).
// Když se posun mezi místy liší, jde o jiný střih nebo jinou rychlost → nesloučit.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const L = require('./lang');
const LANGS = require('./languages');
const I18N = require('./i18n');

const RATE = 8000;        // Hz pro analýzu
const HOP = 80;           // vzorků na bod obálky → 10 ms
const FPS = RATE / HOP;   // 100 bodů obálky za sekundu

// okCodes: mkvmerge vrací 1 při pouhých varováních
function run(cmd, args, { timeoutMs = 120_000, maxBuffer = 64 * 1024 * 1024, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !(typeof err.code === 'number' && okCodes.includes(err.code))) return reject(new Error(I18N.t('common.cmdFailed', { cmd, error: (stderr || err.message).trim().split('\n').slice(-3).join(' | ') })));
      resolve(stdout);
    });
  });
}

// Jazyk stopy: značka v souboru, případně název stopy ("CZ dabing", "Czech DD 5.1", "Original")
function streamLang(s) {
  const tag = L.normLangCode(s.tags?.language);
  if (tag) return { lang: tag, from: 'tag' };
  const words = String(s.tags?.title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const named = words.map(LANGS.fromToken).find(Boolean);
  if (named) return { lang: named, from: 'title' };
  // "Dabing" bez jazyka = dabing v primárním jazyce, "Original" = druhý jazyk (obvykle originál)
  const pri = LANGS.get(L.primary());
  if (pri && words.some((w) => pri.dub.includes(w))) return { lang: pri.code, from: 'title' };
  if (L.secondary() && words.includes('original')) return { lang: L.secondary(), from: 'title' };
  return { lang: null, from: null };
}

function parseFps(r) {
  const [a, b] = String(r || '0/1').split('/').map(Number);
  return b ? a / b : a || 0;
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 60_000 });
  const d = JSON.parse(out);
  const streams = d.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
    index: s.index,           // index ve všech streamech (pro ffmpeg -map 0:N)
    audioIndex: i,            // pořadí mezi audio stopami
    codec: s.codec_name,
    channels: s.channels,
    sampleRate: Number(s.sample_rate) || 0,
    bitRate: Number(s.bit_rate) || Number(s.tags?.BPS) || Number(s.tags?.['BPS-eng']) || 0,
    title: s.tags?.title || '',
    default: Boolean(s.disposition?.default),
    ...streamLang(s),
  }));
  return {
    file,
    duration: Number(d.format?.duration) || 0,
    // ffmpeg -ss počítá od začátku souboru; kvůli zpožděným stopám/souborům přepočítáváme na časovou osu kontejneru
    startTime: Number(d.format?.start_time) || 0,
    size: Number(d.format?.size) || 0,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: parseFps(v.avg_frame_rate || v.r_frame_rate) } : null,
    audio,
  };
}

// Skutečná snímková frekvence z časových značek snímků. Hlavička MKV bývá zaokrouhlená na celé ms
// (42 ms/snímek → „23,810 fps“), přestože video má 23,976 fps – rozhodovat podle ní by mohlo zbytečně odmítnout.
function fpsFromPts(pts) {
  const t = pts.filter(Number.isFinite).sort((a, b) => a - b);
  return t.length > 10 && t[t.length - 1] > t[0] ? (t.length - 1) / (t[t.length - 1] - t[0]) : 0;
}

// Měří 60 s videa od 10 % délky (mimo úvodní logo)
async function measureFps({ file, duration = 0, startTime = 0 }) {
  const from = startTime + Math.max(0, Math.round(duration * 0.1));
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${from}%+60`,
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { timeoutMs: 60_000 });
  return fpsFromPts(out.split('\n').map((l) => parseFloat(l)));
}

// --- Jiná rychlost donoru (PAL 25 fps vs 23,976 fps) ------------------------------------------------
// Zvuk je časový, ne snímkový: jiná snímková frekvence sama o sobě nevadí (29,97 s telecine má stejnou délku).
// Vadí jen jiná rychlost obsahu – typicky televizní/PAL release, kde se 23,976 fps film pustí na 25 fps
// a je o 4,3 % kratší. Takový zvuk jde zpomalit zpátky na tempo stávajícího souboru (retime).
// speed = kolikrát rychleji běží obsah donoru než stávající soubor (PAL: 25 / 23,976 = 1,0427).
const STD_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30];
const SPEEDS = [...new Set(STD_FPS.flatMap((a) => STD_FPS.map((b) => a / b)).filter((r) => r !== 1 && Math.abs(r - 1) < 0.06).map((r) => r.toFixed(6)))].map(Number);

// Nejbližší standardní poměr rychlostí (25/23,976, 24/23,976, 25/24, …) v toleranci; jinak null
function snapSpeed(r, tol = 0.003) {
  if (!(r > 0)) return null;
  const best = SPEEDS.reduce((a, b) => (Math.abs(b / r - 1) < Math.abs(a / r - 1) ? b : a));
  return Math.abs(best / r - 1) <= tol ? best : null;
}

/**
 * Rychlosti donoru k vyzkoušení, nejpravděpodobnější napřed (vždy obsahuje 1).
 * Rozdíl fps je jen podezření – rozhoduje, jestli k němu sedí i délka (PAL release je o 4 % kratší),
 * a nakonec synchronizace. Délka sama (bez rozdílu fps) mívá jinou příčinu (titulky na konci, jiný střih).
 */
function speedCandidates({ targetFps = 0, donorFps = 0, targetDur = 0, donorDur = 0 }) {
  const byFps = targetFps > 0 && donorFps > 0 && Math.abs(donorFps / targetFps - 1) > 0.0005 ? snapSpeed(donorFps / targetFps) : null;
  const durRatio = targetDur > 0 && donorDur > 0 ? targetDur / donorDur : 1;
  if (!byFps) {
    // Stejná fps, ale délka sedí na zrychlenou verzi (video převedené zpátky, zvuk ne) – zkusit až jako druhé
    const byDur = Math.abs(durRatio - 1) > 0.02 ? snapSpeed(durRatio, 0.005) : null;
    return byDur ? [1, byDur] : [1];
  }
  // Délka blíž zrychlené verzi než stejné → napřed přepočet; jinak (telecine, stejná délka) napřed beze změny
  return Math.abs(Math.log(durRatio / byFps)) < Math.abs(Math.log(durRatio)) ? [byFps, 1] : [1, byFps];
}

/**
 * Rychlost z měření, kde posun v průběhu filmu rovnoměrně narůstá (malý rozdíl jako 24 vs 23,976 fps:
 * za minutu jen 60 ms, takže jednotlivá místa korelují, ale posun se mění). Lineární proložení
 * spolehlivých míst; null, když body na přímce neleží nebo poměr není standardní.
 */
function driftSpeed(anchors, { minZ = 7, toleranceMs = 60 } = {}) {
  const v = (anchors || []).filter((a) => a.z >= minZ);
  if (v.length < 4) return null;
  const mx = v.reduce((s, a) => s + a.at, 0) / v.length;
  const my = v.reduce((s, a) => s + a.offsetMs, 0) / v.length;
  const sxx = v.reduce((s, a) => s + (a.at - mx) ** 2, 0);
  if (!sxx) return null;
  const slope = v.reduce((s, a) => s + (a.at - mx) * (a.offsetMs - my), 0) / sxx; // ms za sekundu
  if (v.some((a) => Math.abs(my + slope * (a.at - mx) - a.offsetMs) > toleranceMs)) return null;
  // Obsah donoru v čase T stávajícího souboru je v čase T / speed → posun T·(1 − 1/speed)
  return snapSpeed(1 / (1 - slope / 1000), 0.0003);
}

// Kodek a datový tok přepočítané stopy: AAC zůstane AAC, ostatní (AC-3, E-AC-3, DTS, TrueHD…) → E-AC-3
// (víc než 5.1 se smíchá do 5.1 – enkodér E-AC-3 víc neumí)
function retimeCodec(a) {
  const ch = Math.min(6, a.channels || 2);
  const src = Math.round((a.bitRate || 0) / 1000);
  if (a.codec === 'aac') return { codec: 'aac', channels: ch, kbps: Math.min(ch * 128, Math.max(ch > 2 ? 384 : 160, src)) };
  return { codec: 'eac3', channels: ch, kbps: Math.min(1024, Math.max(ch > 2 ? 448 : 192, src)) };
}

/**
 * Zvuková stopa `stream` souboru `file` přepočítaná na tempo stávajícího souboru → `out` (Matroska, jedna stopa).
 * pitch: 'keep' = jen tempo (atempo, výška hlasu zůstane, jaká je v donoru),
 *        'restore' = tempo i výška (asetrate – vrátí zvýšení, které PAL zrychlení bez korekce způsobí).
 */
async function retime({ file, audio }, speed, out, { pitch = 'keep', lang = null, timeoutMs = 90 * 60e3 } = {}) {
  const { codec, channels, kbps } = retimeCodec(audio);
  const sr = audio.sampleRate || 48000;
  const filter = pitch === 'restore'
    ? `asetrate=${(sr / speed).toFixed(4)},aresample=${sr}`
    : `atempo=${(1 / speed).toFixed(8)}`;
  // E-AC-3 umí jen 48 / 44,1 / 32 kHz
  const outRate = codec === 'aac' || [48000, 44100, 32000].includes(sr) ? sr : 48000;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', `0:${audio.index}`, '-vn', '-sn', '-dn',
    '-af', filter, '-ac', String(channels), '-ar', String(outRate), '-c:a', codec, '-b:a', `${kbps}k`,
    ...(lang ? ['-metadata:s:a:0', `language=${lang}`] : []), '-f', 'matroska', out], { timeoutMs });
  return { codec, channels, kbps };
}

// Kontrola na pozadí: ffmpeg s nejnižší prioritou CPU i disku (ionice v Alpine je, jinde se přeskočí)
const IONICE = ['/usr/bin/ionice', '/bin/ionice'].find((f) => fs.existsSync(f));

// Dekóduje úsek jedné nebo více stop téhož souboru do mono PCM 8 kHz (pole Float32Array, jedno na stopu).
// Víc stop = jedno čtení souboru (každá stopa má vlastní rouru). `start` je čas na ose kontejneru.
function decode({ file, startTime = 0 }, streams, start, duration, { lowPriority = false } = {}) {
  start -= startTime;
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-ss', String(Math.max(0, start)), '-t', String(duration), '-i', file];
    streams.forEach((s, k) => args.push('-map', `0:${s}`, '-ac', '1', '-ar', String(RATE), '-f', 's16le', `pipe:${3 + k}`));
    const [cmd, pre] = lowPriority && IONICE ? [IONICE, ['-c', '3', 'ffmpeg']] : ['ffmpeg', []];
    const p = spawn(cmd, [...pre, ...args], { stdio: ['ignore', 'ignore', 'pipe', ...streams.map(() => 'pipe')] });
    if (lowPriority) try { os.setPriority(p.pid, 19); } catch { /* proces už skončil */ }
    const chunks = streams.map(() => []);
    let err = '';
    streams.forEach((s, k) => p.stdio[3 + k].on('data', (c) => chunks[k].push(c)));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`ffmpeg: ${err.trim().split('\n').pop() || I18N.t('common.exitCode', { code })}`));
      resolve(chunks.map((list) => {
        const buf = Buffer.concat(list);
        const n = buf.length >> 1;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
        return out;
      }));
    });
  });
}

const pcm = (src, start, duration, opts) => decode(src, [src.stream], start, duration, opts).then((x) => x[0]);

// --- Výška zvuku po přepočtu rychlosti ----------------------------------------------------------------
const SPEC_N = 1024;                       // 128 ms při 8 kHz, rozlišení 7,8 Hz
const SPEC_LO = Math.round((150 * SPEC_N) / RATE);
const SPEC_HI = Math.round((3400 * SPEC_N) / RATE);

// Amplitudové spektrum (radix-2 FFT, Hannovo okno)
function magnitude(x) {
  const n = x.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  const m = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) m[k] = Math.hypot(re[k], im[k]);
  return m;
}

// Spektra po 64 ms: log-amplituda minus klouzavý průměr (zůstanou tónové vrcholy, ne celkové zabarvení)
function spectra(samples) {
  const out = [];
  for (let s = 0; s + SPEC_N <= samples.length; s += SPEC_N / 2) {
    const m = magnitude(samples.subarray(s, s + SPEC_N));
    const l = m.map((v) => Math.log(1e-6 + v));
    const w = new Float32Array(l.length);
    for (let k = 0; k < l.length; k++) {
      let sum = 0, c = 0;
      for (let i = Math.max(0, k - 10); i <= Math.min(l.length - 1, k + 10); i++) { sum += l[i]; c++; }
      w[k] = l[k] - sum / c;
    }
    out.push(w);
  }
  return out;
}

// Korelace spektra r se spektrem d čteným na frekvencích ×f (f > 1 = d je vyšší než r)
function specCorr(r, d, f) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let k = SPEC_LO; k <= SPEC_HI && k * f < d.length - 1; k++) {
    const p = k * f, i = Math.floor(p), y = d[i] + (d[i + 1] - d[i]) * (p - i), x = r[k];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
  }
  const den = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
  return den > 0 ? (sxy - (sx * sy) / n) / den : 0;
}

/**
 * Je donor (už přepočtený na správné tempo) vyšší o `speed`? PAL zrychlení bez korekce zvedne i výšku
 * (hlasy o 0,7 půltónu výš) – pak se má přepočítat i výška, jinak jen tempo. Hudba a ruchy jsou v dabingu
 * i originálu stejné, takže v zarovnaných místech se spektra shodují – buď beze změny, nebo posunutá o `speed`.
 * Vrací { raised: true/false/null (nejde poznat), same, shifted } – průměrné korelace spekter.
 */
// Na Skyfallu (CZ proti EN): správná varianta ~0,35–0,40, špatná ~−0,02 → rozhoduje rozdíl nad `margin`.
async function pitchCheck(ref, donor, { offsetMs = 0, speed, times, segmentSec = 20, margin = 0.08 }) {
  let same = 0, shifted = 0, frames = 0;
  for (const t of times.slice(0, 6)) {
    const [ra, da] = await Promise.all([pcm(ref, t, segmentSec), pcm(donor, t - offsetMs / 1000, segmentSec)]);
    const R = spectra(ra), D = spectra(da);
    for (let i = 0; i < Math.min(R.length, D.length); i++) {
      same += specCorr(R[i], D[i], 1);
      shifted += specCorr(R[i], D[i], speed);
      frames++;
    }
  }
  if (!frames) return { raised: null, same: 0, shifted: 0 };
  same /= frames;
  shifted /= frames;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { raised: shifted - same > margin ? true : same - shifted > margin ? false : null, same: r3(same), shifted: r3(shifted) };
}

// Obálka nástupů: log-energie v 10ms oknech → kladná derivace → z-normalizace
function envelope(samples) {
  const n = Math.floor(samples.length / HOP);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) s += samples[j] * samples[j];
    e[i] = Math.log10(1e-8 + s / HOP);
  }
  const o = new Float32Array(n);
  for (let i = 1; i < n; i++) o[i] = Math.max(0, e[i] - e[i - 1]);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i];
  mean /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) v += (o[i] - mean) ** 2;
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) o[i] = (o[i] - mean) / sd;
  return o;
}

// Najde posun b vůči a (v bodech obálky) v rozsahu ±maxLag. a je kratší úsek, b je delší o 2*maxLag.
function bestLag(a, b, maxLag) {
  const scores = new Float32Array(2 * maxLag + 1);
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0;
    const off = maxLag + L;
    for (let i = 0; i < a.length; i++) s += a[i] * (b[i + off] || 0);
    scores[L + maxLag] = s / a.length;
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  // "Výraznost" vrcholu: kolik směrodatných odchylek nad ostatními posuny (mimo okolí vrcholu)
  let mean = 0, cnt = 0;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) > 5) { mean += scores[i]; cnt++; }
  mean /= cnt || 1;
  let v = 0;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) > 5) v += (scores[i] - mean) ** 2;
  const sd = Math.sqrt(v / (cnt || 1)) || 1e-9;
  // Jemnější odhad (parabola přes vrchol)
  let frac = 0;
  if (best > 0 && best < scores.length - 1) {
    const y0 = scores[best - 1], y1 = scores[best], y2 = scores[best + 1];
    const den = y0 - 2 * y1 + y2;
    if (den) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  return { lag: best - maxLag + frac, peak: scores[best], z: (scores[best] - mean) / sd };
}

// Pořadí měřených míst tak, aby i prvních pár pokrylo celý film (0, 7, 4, 2, 5, 1, 3, 6 pro 8 míst)
function spreadOrder(n) {
  const out = n > 1 ? [0, n - 1] : [0];
  for (let step = (n - 1) / 2; out.length < n && step >= 0.5; step /= 2) {
    for (let x = step; x < n - 1; x += 2 * step) if (!out.includes(Math.round(x))) out.push(Math.round(x));
  }
  for (let k = 0; k < n; k++) if (!out.includes(k)) out.push(k);
  return out;
}

// Nejpočetnější skupina posunů, které se od sebe liší nejvýš o toleranceMs
function tightestCluster(offsets, toleranceMs) {
  const s = [...offsets].sort((x, y) => x - y);
  let best = 0;
  for (let i = 0, j = 0; j < s.length; j++) {
    while (s[j] - s[i] > toleranceMs) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

/**
 * Výsledek z naměřených míst ({ at, offsetMs, z }, v pořadí podle času).
 * `anchors` = kolik míst se mělo měřit; při předčasném ukončení jich je v results míň.
 */
function syncVerdict(results, { anchors = results.length, minZ = 7, toleranceMs = 60, minValid = 5 } = {}) {
  const valid = results.filter((r) => r.z >= minZ);
  if (valid.length < minValid) {
    return { ok: false, anchors: results, reason: I18N.t('sync.verdict.noMatch', { valid: valid.length, anchors }) };
  }
  const sorted = valid.map((r) => r.offsetMs).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const agree = valid.filter((r) => Math.abs(r.offsetMs - median) <= toleranceMs);
  if (agree.length < minValid) {
    const spread = sorted[sorted.length - 1] - sorted[0];
    const drift = valid.length >= 2 && Math.abs(valid[valid.length - 1].offsetMs - valid[0].offsetMs) > toleranceMs * 3 &&
      valid.every((r, i) => i === 0 || r.offsetMs >= valid[i - 1].offsetMs - toleranceMs) ? I18N.t('sync.verdict.drift') : I18N.t('sync.verdict.otherCut');
    return { ok: false, anchors: results, reason: I18N.t('sync.verdict.varies', { spread, drift }) };
  }
  const offsetMs = Math.round(agree.reduce((s, r) => s + r.offsetMs, 0) / agree.length);
  return { ok: true, offsetMs, anchors: results, matched: `${agree.length}/${results.length}` };
}

/**
 * Smí měření skončit dřív? Ano, když už je výsledek jistý:
 *  - shoduje se nadpoloviční většina všech míst → ať zbylá místa vyjdou jakkoli, medián zůstane ve shodné skupině,
 *  - nebo už ani zbylá místa nemůžou dát potřebný počet platných měření.
 */
function canStopEarly(results, { anchors, minZ = 7, toleranceMs = 60, minValid = 5 }) {
  const valid = results.filter((r) => r.z >= minZ);
  if (valid.length + (anchors - results.length) < minValid) return true;
  return minValid * 2 > anchors && tightestCluster(valid.map((r) => r.offsetMs), toleranceMs) >= minValid;
}

/**
 * Porovná stopu `donor` se stopou `ref` ({ file, stream, duration, startTime } – stream = index z probe()).
 * Vrací { ok, offsetMs, anchors, matched, reason }.
 * offsetMs = o kolik je potřeba donor posunout (mkvmerge --sync TID:offsetMs), aby seděl na ref.
 * times: měřit v daných místech (s); earlyStop: skončit, jakmile je výsledek jistý (šetří čtení disku); lowPriority: ffmpeg s nízkou prioritou.
 * Obě stopy ze stejného souboru se dekódují jedním čtením.
 */
async function checkSync(ref, donor, { maxOffsetSec = 30, segmentSec = 60, anchors = 8, times = null, minZ = 7, toleranceMs = 60, minValid = 5, earlyStop = false, lowPriority = false } = {}) {
  const dur = Math.min(ref.duration, donor.duration + maxOffsetSec);
  if (!dur || dur < segmentSec * 3) return { ok: false, reason: I18N.t('sync.verdict.tooShort') };
  const maxLag = Math.round(maxOffsetSec * FPS);
  const sameFile = ref.file === donor.file && (ref.startTime || 0) === (donor.startTime || 0);
  // `times` = měřit přesně v těchto místech (s) místo rovnoměrně rozložených
  const points = times || [...Array(anchors).keys()].map((k) => dur * (0.08 + (0.84 * k) / Math.max(1, anchors - 1)));
  anchors = points.length;
  const vopts = { anchors, minZ, toleranceMs, minValid };
  const results = [];
  for (const k of earlyStop ? spreadOrder(anchors) : [...points.keys()]) {
    const start = Math.min(points[k], ref.duration - segmentSec - 1);
    let ra, da;
    if (sameFile) {
      // Jedno okno pro obě stopy; ref je jeho prostředek (začátek zarovnaný na celé body obálky)
      const [wr, wd] = await decode(ref, [ref.stream, donor.stream], start - maxOffsetSec, segmentSec + 2 * maxOffsetSec, { lowPriority });
      const winStart = Math.max(ref.startTime || 0, start - maxOffsetSec);
      const off = Math.round(((start - winStart) * RATE) / HOP) * HOP;
      ra = wr.subarray(off, off + segmentSec * RATE);
      da = wd;
    } else {
      [ra, da] = await Promise.all([
        pcm(ref, start, segmentSec, { lowPriority }),
        pcm(donor, start - maxOffsetSec, segmentSec + 2 * maxOffsetSec, { lowPriority }),
      ]);
    }
    const a = envelope(ra);
    let b = envelope(da);
    // Začátek filmu: donor nejde číst před 0 → doplnit nulami zleva
    const missing = Math.round(Math.max(0, maxOffsetSec - start + (donor.startTime || 0)) * FPS);
    if (missing) { const nb = new Float32Array(b.length + missing); nb.set(b, missing); b = nb; }
    const r = bestLag(a, b, maxLag);
    results.push({ at: Math.round(start), offsetMs: Math.round((-r.lag * 1000) / FPS), z: Math.round(r.z * 10) / 10 });
    if (earlyStop && results.length < anchors && canStopEarly(results, vopts)) break;
  }
  results.sort((x, y) => x.at - y.at);
  return syncVerdict(results, vopts);
}

// Místa (s), kde stopy spolehlivě korelovaly – výsledek úpravy se ověřuje právě tam. V tichých místech
// (dialog bez hudby) vychází shoda náhodně a rovnoměrně rozložená místa pak neprojdou ani u souboru, který sedí.
const reliableTimes = (r, minZ = 7) => (r?.anchors || []).filter((a) => a.z >= minZ).map((a) => a.at);

// Volby checkSync pro ověření výsledku: spolehlivá místa z měření před úpravou, jinak `fallback`
function verifyOpts(measured, fallback, base = { maxOffsetSec: 10 }) {
  const times = reliableTimes(measured);
  return times.length >= 3 ? { ...base, times, minValid: Math.max(3, Math.ceil(times.length * 0.6)) } : fallback;
}

module.exports = {
  reliableTimes, verifyOpts, probe, measureFps, fpsFromPts, checkSync, syncVerdict, canStopEarly, spreadOrder, streamLang, run,
  snapSpeed, speedCandidates, driftSpeed, retimeCodec, retime, pitchCheck, spectra, specCorr,
};

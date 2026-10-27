// Rozpoznání jazyka řeči ve zvukových stopách (whisper.cpp + Silero VAD).
//
// Značky jazyka ve stopách občas lžou – typicky soubory z YouTube mají českou stopu označenou jako "eng".
// Tady si stopu "poslechneme": z několika míst souboru vezmeme 90 s, VAD z nich vybere jen úseky s řečí
// (hudba, ruchy a vzdechy by jinak vycházely jako angličtina) a Whisper určí jazyk.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const G = require('./gpu');
const LANGS = require('./languages');
const { t } = require('./i18n');

const BIN = process.env.WHISPER_BIN || '/usr/local/bin/whisper-cli';
const MODEL = process.env.WHISPER_MODEL || '/models/ggml-base.bin';
const MODEL_DIR = process.env.WHISPER_MODEL_DIR || path.dirname(MODEL);
const VAD_MODEL = process.env.WHISPER_VAD_MODEL || '/models/ggml-silero.bin';
const THREADS = Math.max(1, Math.min(4, os.cpus().length - 1));

const POINTS = [0.15, 0.35, 0.55, 0.75];
const SEGMENT_SEC = 90;
const MIN_SPEECH_SEC = 4;      // méně řeči v úseku → úsek nehodnotit
const MAX_TRACKS = 4;


const available = () => [BIN, MODEL, VAD_MODEL].every((f) => fs.existsSync(f));

// Model podle nastavení ('base' | 'small'); když v kontejneru není, použije se základní
function modelPath(name) {
  const p = name && name !== 'base' ? path.join(MODEL_DIR, `ggml-${name}.bin`) : MODEL;
  return fs.existsSync(p) ? p : MODEL;
}

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(cmd)}: ${(stderr || err.message).trim().split('\n').slice(-2).join(' | ')}`));
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

// Výstup whisper-cli → { lang, p, speechSec }
function parseWhisper(out) {
  const det = out.match(/auto-detected language: ([a-z]+) \(p = ([0-9.]+)\)/);
  const speech = out.match(/total duration of speech segments: ([0-9.]+) seconds/);
  const none = /speech segments after filtering: 0\b/.test(out);
  return {
    lang: det ? det[1] : null,
    p: det ? Number(det[2]) : 0,
    speechSec: none ? 0 : speech ? Number(speech[1]) : null,
  };
}

// Hlasování přes úseky: vážené pravděpodobností, úseky bez řeči se nepočítají
function vote(samples) {
  const used = samples.filter((s) => s.lang && (s.speechSec == null || s.speechSec >= MIN_SPEECH_SEC));
  if (!used.length) return { lang: null, confidence: 0, samples: used.length };
  const score = {};
  for (const s of used) score[s.lang] = (score[s.lang] || 0) + s.p;
  const total = Object.values(score).reduce((a, b) => a + b, 0) || 1;
  const [best, bestScore] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const agree = used.filter((s) => s.lang === best).length;
  return { lang: best, confidence: Math.round((bestScore / total) * 100) / 100, agree, samples: used.length };
}

// Whisper na grafické kartě, když je zapnutá a funguje; jinak (nebo když GPU selže) na procesoru
async function whisper(args, { gpu = false } = {}) {
  if (gpu && G.usable()) {
    let gpuErr;
    try {
      const out = await run(G.BIN, args);
      G.noteRun(out);
      return out;
    } catch (e) {
      gpuErr = e;
    }
    // Za chybu může GPU, jen když na procesoru stejný výpočet projde
    const out = await run(BIN, args);
    G.noteFailure(gpuErr.message);
    console.warn(t('speech.gpuFallback', { error: gpuErr.message }));
    return out;
  }
  return run(BIN, args);
}

async function detectStream(file, streamIndex, { duration, startTime = 0, gpu = false, model = 'base' }) {
  const tmp = path.join(os.tmpdir(), `updaterr-${crypto.randomBytes(5).toString('hex')}.wav`);
  const samples = [];
  try {
    for (const pt of POINTS) {
      const at = Math.max(0, duration * pt - startTime);
      if (duration && at + 10 > duration) continue;
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-t', String(SEGMENT_SEC), '-i', file,
        '-map', `0:${streamIndex}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp]);
      const out = await whisper(['-m', modelPath(model), '--vad', '--vad-model', VAD_MODEL, '-l', 'auto', '-dl', '-t', String(THREADS), '-f', tmp], { gpu });
      samples.push({ at: Math.round(at), ...parseWhisper(out) });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ...vote(samples), raw: samples };
}

/**
 * Rozhodnutí pro jednu stopu: věřit značce, nebo poslechu?
 *   tag      – jazyk ze značky (ISO 639-1 | 'other' | null)
 *   detected – { lang (ISO 639-1 – Whisper vrací stejné kódy), confidence, agree, samples }
 *   origLang – původní jazyk titulu (ISO 639-1 | 'other')
 * Vrací jazyk, který se má použít (ISO 639-1 | 'other' | null), a zda jde o opravu.
 */
function reconcile(tag, detected, origLang) {
  const d = detected?.lang ? (LANGS.get(detected.lang) ? detected.lang : 'other') : null;
  const sure = detected && detected.samples >= 2 && detected.agree >= 2 && detected.confidence >= 0.7;
  if (!d || !sure) return { lang: tag, corrected: false };
  if (!tag) return { lang: d, corrected: true };
  if (tag === d) return { lang: tag, corrected: false };
  // Blízké jazyky (čeština × slovenština, chorvatština × srbština…) se Whisperu pletou – značce věříme.
  // Výjimka: slyšet je jazyk originálu, třeba český film se stopou "slo" (originální zvuk se slovenskými
  // herci nebo prostě špatná značka, ne slovenský dabing) – počítá se jako jazyk originálu.
  if (LANGS.get(tag)?.confusable.includes(d)) {
    return d === origLang ? { lang: d, corrected: true } : { lang: tag, corrected: false };
  }
  // Slyšet je jazyk, který se s primárním jazykem plete (stopa "eng", ve které Whisper slyší slovenštinu, když
  // se hledá čeština): je to primární jazyk, nebo opravdu ten druhý? Jistá oprava to není – nechat značku a upozornit
  const primary = require('./lang').primary();
  if (primary && d !== primary && LANGS.get(d)?.confusable.includes(primary)) return { lang: tag, corrected: false, doubtful: true };
  return { lang: d, corrected: true };
}

module.exports = { available, modelPath, detectStream, reconcile, parseWhisper, vote, MAX_TRACKS };

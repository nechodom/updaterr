// Grafická karta pro rozpoznání řeči (whisper.cpp přes Vulkan).
//
// Na GPU má smysl jen Whisper – je to jediný opravdový výpočet. Měření synchronizace dabingu i slučování stop
// jsou omezené čtením z disku a dekódováním zvuku (to na GPU nejde), korelace obálek trvá desítky ms.
//
// whisper-cli je v kontejneru dvakrát: pro procesor a s Vulkanem. Když GPU selže, použije se procesor
// a GPU se na chvíli přestane zkoušet.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { t } = require('./i18n');

const BIN = process.env.WHISPER_GPU_BIN || '/usr/local/bin/whisper-cli-vulkan';
const CPU_BIN = process.env.WHISPER_BIN || '/usr/local/bin/whisper-cli';
const DRI = process.env.GPU_DRI_DIR || '/dev/dri';
// Krátká anglická nahrávka ze zdrojáků whisper.cpp – známý výsledek pro ověření, že GPU počítá správně
const SAMPLE = process.env.WHISPER_TEST_WAV || '/models/jfk.wav';
const RETRY_AFTER_MS = 30 * 60e3;

// Stav posledního použití – co se stalo při skutečné práci (ne při testu)
// badResults = test ukázal, že GPU počítá špatně (nespadne, jen dává chybné jazyky) → nepoužívat do dalšího úspěšného ověření
const state = { device: null, lastUsedAt: null, lastError: null, failedAt: 0, cpuFallbacks: 0, badResults: false };

function renderNodes() {
  let names = [];
  try { names = fs.readdirSync(DRI).filter((n) => /^renderD\d+$/.test(n)); } catch { return []; }
  return names.map((n) => {
    const p = path.join(DRI, n);
    let access = true;
    try { fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK); } catch { access = false; }
    let gid = null;
    try { gid = fs.statSync(p).gid; } catch {}
    return { path: p, access, gid };
  });
}

const binaryOk = () => fs.existsSync(BIN);

// Může se GPU teď použít? (binárka, zařízení s přístupem, nedávno neselhalo)
function usable() {
  return !state.badResults && binaryOk() && renderNodes().some((n) => n.access) && Date.now() - state.failedAt > RETRY_AFTER_MS;
}

// Z výstupu whisper-cli: jaké zařízení Vulkan našel a jestli ho whisper opravdu použil
function parseBackend(out) {
  const dev = out.match(/ggml_vulkan: \d+ = ([^|\n]+?)\s*(?:\||\n|$)/);
  const found = out.match(/ggml_vulkan: Found (\d+) Vulkan devices?/);
  const noGpu = /no GPU found/i.test(out) || /use gpu\s*=\s*0/.test(out);
  return {
    device: dev ? dev[1].trim() : null,
    devices: found ? Number(found[1]) : dev ? 1 : 0,
    gpu: Boolean(dev) && !noGpu,
  };
}

function parseTimings(out) {
  const num = (re) => { const m = out.match(re); return m ? Math.round(Number(m[1])) : null; };
  return {
    encodeMs: num(/encode time\s*=\s*([0-9.]+) ms/),
    totalMs: num(/total time\s*=\s*([0-9.]+) ms/),
  };
}

function exec(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout}\n${stderr}`, ms: Date.now() - t0 });
    });
  });
}

const errText = (r) => (r.err?.killed ? t('gpu.timeout') : r.out.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || r.err?.message || t('gpu.unknownError'));

// Zápis výsledku skutečného běhu na GPU (volá speech.js)
function noteRun(out) {
  const b = parseBackend(out);
  if (b.device) state.device = b.device;
  if (b.gpu) {
    state.lastUsedAt = new Date().toISOString();
    state.lastError = null;
  } else {
    // binárka s Vulkanem běží, ale grafickou kartu nenašla – zbytečně ji nezkoušet
    state.lastError = t('gpu.noCardCpu');
    state.failedAt = Date.now();
  }
  return b.gpu;
}

function noteFailure(message) {
  state.lastError = message;
  state.failedAt = Date.now();
  state.cpuFallbacks++;
}

function summary(enabled) {
  const nodes = renderNodes();
  return {
    enabled: Boolean(enabled),
    binary: binaryOk(),
    devices: nodes.length,
    access: nodes.some((n) => n.access),
    usable: Boolean(enabled) && usable(),
    device: state.device,
    lastUsedAt: state.lastUsedAt,
    lastError: state.lastError,
    cpuFallbacks: state.cpuFallbacks,
  };
}

/**
 * Úplné ověření: zařízení v kontejneru, oprávnění, Vulkan, a výpočet na známé nahrávce porovnaný s procesorem.
 * Vrací { ok, device, steps: [{ id, label, ok, detail }], gpu, cpu, at }.
 */
async function check({ model }) {
  const steps = [];
  const step = (id, label, ok, detail) => { steps.push({ id, label, ok, detail }); return ok; };
  const done = (extra = {}) => ({ ok: steps.every((s) => s.ok !== false), steps, at: new Date().toISOString(), ...extra });

  const nodes = renderNodes();
  if (!step('device', t('gpu.step.device'), nodes.length > 0, nodes.length
    ? nodes.map((n) => n.path).join(', ')
    : t('gpu.noDevice', { dir: DRI }))) return done();

  const denied = nodes.filter((n) => !n.access);
  if (!step('access', t('gpu.step.access'), denied.length < nodes.length, denied.length < nodes.length
    ? t('gpu.accessOk', { uid: process.getuid?.(), groups: (process.getgroups?.() || []).join(', ') })
    : t('gpu.accessDenied', { uid: process.getuid?.(), path: denied[0].path, gid: denied[0].gid }))) return done();

  if (!step('binary', t('gpu.step.binary'), binaryOk() && fs.existsSync(SAMPLE), binaryOk()
    ? (fs.existsSync(SAMPLE) ? path.basename(BIN) : t('gpu.noSample', { path: SAMPLE }))
    : t('gpu.noBinary', { bin: BIN }))) return done();

  const args = ['-m', model, '-l', 'auto', '-dl', '-t', '4', '-f', SAMPLE];
  // První běh připraví shadery (Mesa je uloží do cache), měří se až druhý
  const warm = await exec(BIN, args, 180_000);
  const b = parseBackend(warm.out);
  if (b.device) state.device = b.device;
  if (!step('vulkan', t('gpu.step.vulkan'), !warm.err && b.gpu, warm.err
    ? t('gpu.vulkanCrashed', { error: errText(warm) })
    : b.gpu ? b.device : b.devices ? t('gpu.deviceUnused', { device: b.device || '?' }) : t('gpu.noCard'))) return done({ device: b.device });

  const gpuRun = await exec(BIN, args, 120_000);
  const cpuRun = await exec(CPU_BIN, args, 120_000);
  const det = (r) => {
    const m = r.out.match(/auto-detected language: ([a-z]+) \(p = ([0-9.]+)\)/);
    return { lang: m ? m[1] : null, p: m ? Number(m[2]) : 0, ms: r.ms, ...parseTimings(r.out), error: r.err ? errText(r) : null };
  };
  const gpu = det(gpuRun);
  const cpu = det(cpuRun);
  const pct = (x) => `${Math.round(x * 100)} %`;
  step('compute', t('gpu.step.compute'), !gpu.error && gpu.lang === 'en' && gpu.p >= 0.5, gpu.error
    ? t('gpu.computeFailed', { error: gpu.error })
    : t(gpu.lang === 'en' ? 'gpu.sampleOk' : 'gpu.sampleWrong', { lang: gpu.lang || t('gpu.nothing'), pct: pct(gpu.p) }));
  if (!cpu.error) {
    step('match', t('gpu.step.match'), cpu.lang === gpu.lang && Math.abs(cpu.p - gpu.p) < 0.1,
      t('gpu.matchDetail', { cpu: cpu.lang || t('gpu.nothing'), cpuPct: pct(cpu.p), gpu: gpu.lang || t('gpu.nothing'), gpuPct: pct(gpu.p) }));
  }
  if (steps.every((s) => s.ok)) {
    state.failedAt = 0;
    state.lastError = null;
    state.badResults = false;
  } else {
    // Výpočet proběhl, ale s chybným výsledkem – skutečná práce by tiše dávala špatné jazyky
    const bad = steps.find((s) => !s.ok);
    state.badResults = true;
    state.failedAt = Date.now();
    state.lastError = t('gpu.checkFailed', { step: bad.label, detail: bad.detail });
  }
  return done({ device: b.device, model: path.basename(model), gpu, cpu });
}

module.exports = { BIN, usable, summary, check, noteRun, noteFailure, parseBackend, parseTimings, renderNodes };

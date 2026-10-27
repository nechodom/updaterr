const test = require('node:test');
const assert = require('node:assert');
require('../src/i18n').setLocale('cs'); // testy ověřují české texty
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Prázdný /dev/dri, ať test nezávisí na stroji, kde běží
const dri = fs.mkdtempSync(path.join(os.tmpdir(), 'updaterr-dri-'));
process.env.GPU_DRI_DIR = dri;
process.env.WHISPER_GPU_BIN = path.join(dri, 'whisper-cli-vulkan');
const G = require('../src/gpu');

test.after(() => fs.rmSync(dri, { recursive: true, force: true }));
const { speechOpts } = require('../src/langcheck');
const { DEFAULT_SETTINGS } = require('../src/store');

const VK_OK = `ggml_vulkan: Found 1 Vulkan devices:
ggml_vulkan: 0 = AMD Radeon RX 580 Series (RADV POLARIS10) (radv) | uma: 0 | fp16: 0 | bf16: 0 | warp size: 64 | shared memory: 65536 | int dot: 0 | matrix cores: none
whisper_init_with_params_no_state: use gpu    = 1
whisper_backend_init_gpu: using Vulkan0 backend
whisper_full_with_state: auto-detected language: en (p = 0.977607)
whisper_print_timings:   encode time =    41.52 ms /     1 runs (   41.52 ms per run)
whisper_print_timings:    total time =   812.09 ms`;

test('parseBackend – Vulkan našel kartu a whisper ji použil', () => {
  assert.deepStrictEqual(G.parseBackend(VK_OK), { device: 'AMD Radeon RX 580 Series (RADV POLARIS10) (radv)', devices: 1, gpu: true });
});

test('parseBackend – binárka s Vulkanem bez karty počítá na procesoru', () => {
  assert.strictEqual(G.parseBackend('ggml_vulkan: Found 0 Vulkan devices:\nwhisper_backend_init_gpu: no GPU found\n').gpu, false);
  assert.strictEqual(G.parseBackend('whisper_init_with_params_no_state: use gpu    = 1\n').gpu, false);
});

test('parseTimings – čas enkodéru a celkový čas', () => {
  assert.deepStrictEqual(G.parseTimings(VK_OK), { encodeMs: 42, totalMs: 812 });
  assert.deepStrictEqual(G.parseTimings(''), { encodeMs: null, totalMs: null });
});

test('bez /dev/dri se GPU nepoužije a ověření řekne proč', async () => {
  assert.strictEqual(G.usable(), false);
  assert.strictEqual(G.summary(true).usable, false);
  const r = await G.check({ model: '/models/ggml-base.bin' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.steps.length, 1);
  assert.match(r.steps[0].detail, /devices/);
});

test('bez oprávnění k render node poradí group_add', { skip: process.getuid?.() === 0 && 'root má přístup ke všemu' }, async () => {
  const node = path.join(dri, 'renderD128');
  fs.writeFileSync(node, '');
  fs.chmodSync(node, 0o000);
  try {
    const r = await G.check({ model: '/models/ggml-base.bin' });
    assert.strictEqual(r.steps[1].ok, false);
    assert.match(r.steps[1].detail, /group_add/);
  } finally {
    fs.rmSync(node, { force: true });
  }
});

test('nastavení – GPU a model se předají rozpoznání řeči', () => {
  assert.deepStrictEqual(speechOpts(DEFAULT_SETTINGS), { gpu: true, model: 'base' });
  assert.deepStrictEqual(speechOpts({ ...DEFAULT_SETTINGS, useGpu: false, speechModel: 'small' }), { gpu: false, model: 'small' });
});

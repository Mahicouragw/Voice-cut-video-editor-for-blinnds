const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const NR2 = require('../web/nr2.js');
const NR1 = require('../web/nr.js');

const MOD = pathToFileURL(path.join(__dirname, '..', 'web', 'vendor', 'rnnoise.js')).href;
const SR = 48000;

function voiceProxy(len, seed) {
  const o = new Float32Array(len);
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f0 = 115 + 25 * Math.sin(2 * Math.PI * 0.4 * t) + 8 * Math.sin(2 * Math.PI * 1.7 * t);
    const block = Math.floor(t / 0.2);
    const paused = ((block * 7919 + seed) % 7) === 0;
    const am = paused ? 0 : 0.3 + 0.7 * Math.abs(Math.sin(2 * Math.PI * 3.5 * t));
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const f = f0 * h;
      const formant = Math.exp(-Math.pow((f - 500) / 400, 2)) + 0.8 * Math.exp(-Math.pow((f - 1500) / 600, 2)) + 0.5 * Math.exp(-Math.pow((f - 2600) / 800, 2));
      v += (0.25 + formant) / h * Math.sin(2 * Math.PI * f * t + h);
    }
    o[i] = 0.25 * am * v + 0.005 * rnd();
  }
  return o;
}
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function brown(len, rng, amt) {
  const o = new Float32Array(len); let last = 0;
  for (let i = 0; i < len; i++) { const w = rng() * 2 - 1; last = (last + 0.02 * w) / 1.02; o[i] = last * 3.2 * amt; }
  return o;
}
function brr(len) {
  const o = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const ph = 2 * Math.PI * 55 * i / SR;
    o[i] = Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph) + 0.25 * Math.sin(4 * ph);
  }
  return o;
}
function energy(d) { let a = 0; for (let i = 0; i < d.length; i++) a += d[i] * d[i]; return a / Math.max(1, d.length); }
function snr(clean, out) {
  const m = 4800; let s = 0, e = 0;
  for (let i = m; i < clean.length - m; i++) { s += clean[i] * clean[i]; const d = out[i] - clean[i]; e += d * d; }
  const n = clean.length - 2 * m;
  return 10 * Math.log10((s / n) / Math.max(e / n, 1e-12));
}
function mixAtLevels(clean, noise, cleanLvl, noiseLvl) {
  const ce = Math.sqrt(energy(clean)), ne = Math.sqrt(energy(noise));
  const norm = new Float32Array(clean.length), mix = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) { norm[i] = clean[i] / ce * cleanLvl; mix[i] = norm[i] + noise[i] / ne * noiseLvl; }
  return {norm, mix};
}
class MemBuffer {
  constructor(d) { this.numberOfChannels = 1; this.length = d.length; this.sampleRate = SR; this._d = [d]; }
  getChannelData() { return this._d[0]; }
  copyToChannel(src) { this._d[0].set(src); }
}

test('NR-2 neural improves a 0 dB voice-level noise mix', async () => {
  const len = SR * 4;
  const {norm, mix} = mixAtLevels(voiceProxy(len, 11), brown(len, mulberry32(5), 1), 0.15, 0.15);
  const r = await NR2.process48k(mix, {moduleUrl: MOD});
  const out = snr(norm, r.out);
  assert.ok(out >= 3, `expected >=3 dB SNR on 0 dB mix, got ${out.toFixed(1)} dB`);
  assert.ok(r.meanVad > 0.3, 'neural VAD should hear voice, got ' + r.meanVad.toFixed(2));
});

test('NR-2 neural beats NR-1 gating on voice-level noise', async () => {
  const len = SR * 4;
  const {norm, mix} = mixAtLevels(voiceProxy(len, 11), brown(len, mulberry32(5), 1), 0.15, 0.15);
  const neural = await NR2.process48k(mix, {moduleUrl: MOD});
  const gated = await NR1.spectralDenoise(new MemBuffer(mix.slice()), 'ultra', () => {}, (c, l, r) => new MemBuffer(new Float32Array(l)));
  const sN = snr(norm, neural.out), sG = snr(norm, gated.getChannelData(0));
  assert.ok(sN > sG + 2, `neural (${sN.toFixed(1)} dB) must beat gating (${sG.toFixed(1)} dB) by 2+ dB`);
});

test('NR-2 neural removes noise-only audio almost completely', async () => {
  const len = SR * 4;
  const nz = brown(len, mulberry32(9), 1);
  const ne = Math.sqrt(energy(nz));
  const mix = new Float32Array(len);
  for (let i = 0; i < len; i++) mix[i] = nz[i] / ne * 0.15;
  const r = await NR2.process48k(mix, {moduleUrl: MOD});
  const db = -10 * Math.log10(energy(r.out) / energy(mix));
  assert.ok(db >= 30, `expected >=30 dB noise-only suppression, got ${db.toFixed(1)} dB`);
  assert.ok(r.meanVad < 0.15, 'VAD should stay near zero on pure noise, got ' + r.meanVad.toFixed(2));
});

test('NR-2 neural rescues voice buried under louder BRR rumble', async () => {
  const len = SR * 4;
  const {norm, mix} = mixAtLevels(voiceProxy(len, 11), brr(len), 0.1, 0.2);
  const r = await NR2.process48k(mix, {moduleUrl: MOD});
  const out = snr(norm, r.out);
  assert.ok(out >= 0, `expected >=0 dB SNR on -6 dB BRR mix, got ${out.toFixed(1)} dB`);
});

test('NR-2 neural largely preserves clean voice', async () => {
  const len = SR * 4;
  const v = voiceProxy(len, 11);
  const ce = Math.sqrt(energy(v));
  const norm = new Float32Array(len);
  for (let i = 0; i < len; i++) norm[i] = v[i] / ce * 0.15;
  const r = await NR2.process48k(norm, {moduleUrl: MOD});
  const out = snr(norm, r.out);
  assert.ok(out >= 6, `expected clean voice preserved (>=6 dB), got ${out.toFixed(1)} dB`);
});

test('NR-2 mix envelope blends original and neural output', async () => {
  const len = SR * 2;
  const nz = brown(len, mulberry32(9), 1);
  const ne = Math.sqrt(energy(nz));
  const mix = new Float32Array(len);
  for (let i = 0; i < len; i++) mix[i] = nz[i] / ne * 0.15;
  const dry = await NR2.process48k(mix, {moduleUrl: MOD, mixAt: () => 0});
  const wet = await NR2.process48k(mix, {moduleUrl: MOD, mixAt: () => 1});
  const dryDb = -10 * Math.log10(energy(dry.out) / energy(mix));
  const wetDb = -10 * Math.log10(energy(wet.out) / energy(mix));
  assert.ok(Math.abs(dryDb) < 1, `mix 0 must leave audio untouched, got ${dryDb.toFixed(1)} dB`);
  assert.ok(wetDb >= 30, `mix 1 must fully clean, got ${wetDb.toFixed(1)} dB`);
});

test('NR-2 buried-voice rescue keeps voice audible under dominating bike noise', async () => {
  const len = SR * 4;
  const v = voiceProxy(len, 11);
  const nz = (function bike(len, rng) {
    const o = new Float32Array(len); let last = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR, ph = 2 * Math.PI * 48 * t;
      const w = rng() * 2 - 1; last = (last + 0.02 * w) / 1.02;
      const chug = Math.sin(ph) + 0.7 * Math.sin(2 * ph) + 0.5 * Math.sin(3 * ph);
      const trill = Math.sin(2 * Math.PI * 220 * t) * Math.max(0, Math.sin(2 * Math.PI * 28 * t));
      let click = 0; const ct = t % 0.37; if (ct < 0.005) click = (rng() * 2 - 1) * Math.exp(-ct * 800);
      o[i] = 0.5 * chug + last * 3.0 + 0.4 * trill + click * 2.0;
    }
    return o;
  })(len, mulberry32(3));
  const ce = Math.sqrt(energy(v)), ne = Math.sqrt(energy(nz));
  const mix = new Float32Array(len);
  for (let i = 0; i < len; i++) mix[i] = v[i] / ce * 0.1 + nz[i] / ne * 0.316; // -10 dB
  const r = await NR2.process48k(mix, {moduleUrl: MOD, buriedVoice: true});
  const B = Math.floor(SR * 0.2), nb = Math.floor(len / B);
  let vIn = 0, vOut = 0, nIn = 0, nOut = 0;
  for (let b = 0; b < nb; b++) {
    const paused = ((b * 7919 + 11) % 7) === 0;
    let si = 0, so = 0;
    for (let i = b * B; i < (b + 1) * B; i++) { si += mix[i] * mix[i]; so += r.out[i] * r.out[i]; }
    if (!paused) { vIn += si; vOut += so; } else { nIn += si; nOut += so; }
  }
  const pres = 10 * Math.log10(vOut / vIn), supp = -10 * Math.log10(nOut / nIn);
  assert.ok(pres >= -6, `buried voice must stay audible (>= -6 dB), got ${pres.toFixed(1)} dB`);
  assert.ok(supp >= 4, `extreme noise must still reduce (>= 4 dB), got ${supp.toFixed(1)} dB`);
  assert.equal(r.buriedBlend, 0.55);
});

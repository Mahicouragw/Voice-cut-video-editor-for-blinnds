const {test} = require('node:test');
const assert = require('node:assert/strict');
const NR = require('../web/nr.js');

function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
class MemBuffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
    this._d = Array.from({length: ch}, () => new Float32Array(len));
  }
  getChannelData(c) { return this._d[c]; }
  copyToChannel(src, c) { this._d[c].set(src); }
}
function energy(d) { let a = 0; for (let i = 0; i < d.length; i++) a += d[i] * d[i]; return a / Math.max(1, d.length); }
function brown(len, rng, amt) {
  const o = new Float32Array(len); let last = 0;
  for (let i = 0; i < len; i++) { const w = rng() * 2 - 1; last = (last + 0.02 * w) / 1.02; o[i] = last * 3.2 * amt; }
  return o;
}
const factory = (c, l, r) => new MemBuffer(c, l, r);

test('NR-1 suppresses noise-only audio strongly (offline, no server)', async () => {
  const sr = 16000, len = sr * 4, rng = mulberry32(7);
  const buf = new MemBuffer(1, len, sr);
  buf._d[0].set(brown(len, rng, 1));
  const before = energy(buf._d[0]);
  assert.ok(before > 1e-6, 'synth sanity: input must be loud');
  const out = await NR.spectralDenoise(buf, 'voicefocus', () => {}, factory);
  const after = energy(out.getChannelData(0));
  const db = 10 * Math.log10(before / Math.max(after, 1e-12));
  assert.ok(db >= 15, `expected >=15 dB suppression, got ${db.toFixed(1)} dB`);
});

test('NR-1 preserves a loud tone while cleaning the background', async () => {
  const sr = 16000, len = sr * 4, rng = mulberry32(3);
  const buf = new MemBuffer(1, len, sr);
  const d = buf._d[0], nz = brown(len, rng, 0.15);
  for (let i = 0; i < len; i++) {
    const toneOn = (i > sr && i < sr * 3) ? 1 : 0; // speech-like: pauses + 2 s of tone
    d[i] = toneOn * 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) + nz[i];
  }
  const before = energy(d);
  const out = await NR.spectralDenoise(buf, 'medium', () => {}, factory);
  const after = energy(out.getChannelData(0));
  const loss = 10 * Math.log10(before / Math.max(after, 1e-12));
  assert.ok(loss < 6, `tone should survive, lost ${loss.toFixed(1)} dB`);
});

test('NR-1 rejects empty audio and falls back to medium for unknown levels', async () => {
  const bad = new MemBuffer(1, 0, 16000);
  await assert.rejects(() => NR.spectralDenoise(bad, 'medium', () => {}, factory), /Empty audio/);
  const sr = 16000, buf = new MemBuffer(1, sr, sr);
  const out = await NR.spectralDenoise(buf, 'nope', () => {}, factory);
  assert.equal(out.length, sr);
});

test('NR-1 ultra is stronger than voice focus and keeps a loud tone usable', async () => {
  const sr = 16000, len = sr * 4;
  const sig = brown(len, mulberry32(11), 1);
  async function supp(level) {
    const buf = new MemBuffer(1, len, sr);
    buf._d[0].set(sig);
    const out = await NR.spectralDenoise(buf, level, () => {}, factory);
    return 10 * Math.log10(energy(sig) / Math.max(energy(out.getChannelData(0)), 1e-12));
  }
  const vf = await supp('voicefocus'), ul = await supp('ultra');
  assert.ok(ul >= 26, `expected ultra >=26 dB suppression, got ${ul.toFixed(1)} dB`);
  assert.ok(ul > vf + 3, `ultra (${ul.toFixed(1)} dB) must beat voice focus (${vf.toFixed(1)} dB) by 3+ dB`);
  const buf2 = new MemBuffer(1, len, sr);
  const d = buf2._d[0], nz = brown(len, mulberry32(13), 0.15);
  for (let i = 0; i < len; i++) d[i] = ((i > sr && i < sr * 3) ? 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) : 0) + nz[i];
  const out2 = await NR.spectralDenoise(buf2, 'ultra', () => {}, factory);
  const loss = 10 * Math.log10(energy(d) / Math.max(energy(out2.getChannelData(0)), 1e-12));
  assert.ok(loss < 12, `ultra tone should stay usable, lost ${loss.toFixed(1)} dB`);
});

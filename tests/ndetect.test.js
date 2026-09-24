const {test} = require('node:test');
const assert = require('node:assert/strict');
const ND = require('../web/ndetect.js');

const SR = 16000;
// Speech-like proxy: wandering pitch, harmonics with formants, syllabic AM, pauses.
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
// Engine-like BRR: rock-steady 55 Hz harmonic stack.
function brr(len, from, to, amp) {
  const o = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    if (t < from || t >= to) continue;
    const ph = 2 * Math.PI * 55 * t;
    o[i] = amp * (Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph) + 0.25 * Math.sin(4 * ph));
  }
  return o;
}
function mix(a, b) { const o = new Float32Array(a.length); for (let i = 0; i < o.length; i++) o[i] = a[i] + b[i]; return o; }

test('ND-1 finds a steady BRR stretch at the right time', () => {
  const len = SR * 8;
  const sig = mix(brr(len, 2.0, 4.5, 0.4), voiceProxy(len, 3).map(v => v * 0.1));
  const rep = ND.scanNoise(sig, SR);
  assert.equal(rep.summary.brrCount, 1);
  assert.ok(Math.abs(rep.regions[0].start - 2.0) < 0.6, 'start near 2.0s, got ' + rep.regions[0].start.toFixed(2));
  assert.ok(Math.abs(rep.regions[0].end - 4.5) < 0.6, 'end near 4.5s, got ' + rep.regions[0].end.toFixed(2));
  assert.match(rep.summary.text, /Engine-like noise found at 0:01\u20130:04/);
});

test('ND-1 still finds BRR buried 6 dB under voice-like sound', () => {
  const len = SR * 8;
  const v = voiceProxy(len, 11);
  const b = brr(len, 1.0, 6.0, 0.8);
  const sig = mix(v, b);
  const rep = ND.scanNoise(sig, SR);
  assert.ok(rep.summary.brrCount >= 1, 'expected a BRR region, got ' + rep.summary.brrCount);
  assert.ok(rep.regions[0].start < 2.0 && rep.regions[rep.regions.length - 1].end > 5.0);
});

test('ND-1 does not mistake voice-like sound for engine rumble', () => {
  const rep = ND.scanNoise(voiceProxy(SR * 6, 21), SR);
  assert.equal(rep.summary.brrCount, 0);
  assert.match(rep.summary.text, /No steady engine-like rumble/);
});

test('ND-1 handles silence without false regions', () => {
  const rep = ND.scanNoise(new Float32Array(SR * 3), SR);
  assert.equal(rep.summary.brrCount, 0);
});

test('ND-1 strength envelope boosts inside BRR regions only', () => {
  const len = SR * 8;
  const rep = ND.scanNoise(brr(len, 2.0, 4.5, 0.4), SR);
  assert.equal(rep.summary.brrCount, 1);
  const st = rep.regions[0].start, en = rep.regions[0].end;
  assert.ok(rep.strengthAt((st + en) / 2, 0.5, 1.0) > 0.99);
  assert.ok(Math.abs(rep.strengthAt(7.5, 0.5, 1.0) - 0.5) < 0.01);
  const edge = rep.strengthAt(st - 0.12, 0.5, 1.0);
  assert.ok(edge > 0.5 && edge < 1.0, 'ramp should be smooth, got ' + edge);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {computeVoiceCurve, voiceActiveAt, duckedGain, VIDEO_FILTERS, VOICE_FILTERS} = require('../web/core');

test('voice curve marks speech active and silence quiet', () => {
  const sr = 8000, len = sr * 4, samples = new Float32Array(len);
  for (let i = 0; i < sr * 2; i++) samples[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / sr);
  const curve = computeVoiceCurve(samples, sr);
  assert.equal(curve.fps, 10);
  assert.equal(curve.frames.length, 40);
  assert.equal(voiceActiveAt(curve, 0.5), true);
  assert.equal(voiceActiveAt(curve, 1.9), true);
  assert.equal(voiceActiveAt(curve, 2.6), false);
  assert.equal(voiceActiveAt(curve, 3.9), false);
  assert.equal(voiceActiveAt(null, 1), false);
});

test('music gain dips under voice and rises in silence by the ducking level', () => {
  assert.equal(duckedGain(100, 30, true, true), 0.7);
  assert.ok(Math.abs(duckedGain(100, 30, false, true) - 1.3) < 1e-9);
  assert.equal(duckedGain(20, 50, true, true), 0.1);
  assert.ok(Math.abs(duckedGain(20, 50, false, true) - 0.3) < 1e-9);
  assert.equal(duckedGain(100, 50, true, true), 0.5);
  assert.ok(Math.abs(duckedGain(60, 80, false, true) - 1.08) < 1e-9);
  assert.equal(duckedGain(100, 30, true, false), 1);
  assert.equal(duckedGain(100, 30, false, false), 1);
});

test('video and voice filter tables cover the promised looks', () => {
  for (const name of ['normal', 'bright', 'warm', 'cool', 'bw', 'vintage', 'vivid', 'overflow']) {
    assert.ok(name in VIDEO_FILTERS, name);
  }
  assert.equal(VIDEO_FILTERS.normal, '');
  assert.deepEqual(Object.keys(VOICE_FILTERS).sort(), ['alien', 'chipmunk', 'high', 'low', 'none', 'robot']);
  assert.ok(VOICE_FILTERS.chipmunk > VOICE_FILTERS.high && VOICE_FILTERS.high > 1 && VOICE_FILTERS.low < 1);
});

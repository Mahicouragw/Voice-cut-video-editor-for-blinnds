const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {demuxMp4, parseAsc, displaySize} = require('../web/merge');

// Committed fixtures (no ffmpeg needed): clip1 is 320x180 24fps + 48kHz
// stereo AAC; clip2 is 640x360 30fps + 44.1kHz mono AAC, both 2 seconds.
const f1 = path.join(__dirname, 'fixtures', 'merge-demux-clip1.mp4');
const f2 = path.join(__dirname, 'fixtures', 'merge-demux-clip2.mp4');
const f3 = path.join(__dirname, 'fixtures', 'rot90-320x180.mp4');

test('AAC config bytes decode to object type, rate and channels', () => {
  assert.deepEqual(parseAsc(new Uint8Array([0x11, 0x90])), {objectType: 2, sampleRate: 48000, channels: 2});
  assert.deepEqual(parseAsc(new Uint8Array([0x12, 0x10])), {objectType: 2, sampleRate: 44100, channels: 2});
  assert.throws(() => parseAsc(new Uint8Array([0x00])), /bad-audio-config/);
});

test('demuxer rejects non-videos', () => {
  assert.throws(() => demuxMp4(new Uint8Array(10)), /too small/);
  const junk = new Uint8Array(64); junk.set([0,0,0,32,109,100,97,116], 0);
  assert.throws(() => demuxMp4(junk), /not an MP4/);
});

test('demuxer reads H.264 video track with timed samples', () => {
  const d = demuxMp4(new Uint8Array(fs.readFileSync(f1)));
  assert.ok(d.video, 'video track found');
  assert.match(d.video.codec, /^avc1\.[0-9A-F]{6}$/);
  assert.equal(d.video.width, 320);
  assert.equal(d.video.height, 180);
  assert.ok(d.video.desc && d.video.desc.length > 4, 'avcC description present');
  assert.ok(d.video.samples.length >= 40, 'samples present, got ' + d.video.samples.length);
  assert.ok(d.video.samples[0].key, 'first sample is a keyframe');
  for (let i = 1; i < d.video.samples.length; i++) {
    assert.ok(d.video.samples[i].dts >= d.video.samples[i-1].dts, 'decode timestamps never go back');
  }
  const last = d.video.samples[d.video.samples.length - 1];
  const spanSec = (last.cts / d.video.timescale) + (d.video.nominalFrameUs / 1000000);
  assert.ok(Math.abs(spanSec - 2) < 0.25, 'video span ~2s, got ' + spanSec);
  assert.ok(d.video.nominalFrameUs > 30000 && d.video.nominalFrameUs < 50000, 'nominal frame ~24fps');
});

test('demuxer reads AAC audio track with exact trims', () => {
  const d = demuxMp4(new Uint8Array(fs.readFileSync(f1)));
  assert.ok(d.audio, 'audio track found');
  assert.equal(d.audio.codec, 'mp4a.40.2');
  assert.equal(d.audio.sampleRate, 48000);
  assert.equal(d.audio.channels, 2);
  assert.ok(d.audio.asc && d.audio.asc.length >= 2, 'ASC present');
  assert.ok(d.audio.samples.length >= 80, 'audio samples present, got ' + d.audio.samples.length);
  console.log('ffmpeg aac elst head=' + d.audio.elstHeadSec.toFixed(4) + 's tail=' + d.audio.elstSegSec.toFixed(4) + 's tkhd=' + d.audio.tkDurationSec.toFixed(4) + 's');
  const exactSec = d.audio.elstSegSec > 0 ? d.audio.elstSegSec : d.audio.tkDurationSec;
  assert.ok(exactSec > 1.8 && exactSec < 2.2, 'exact audio length ~2s, got ' + exactSec);
});

test('demuxer reads a mismatched second clip (size, rate, channels, fps)', () => {
  const d = demuxMp4(new Uint8Array(fs.readFileSync(f2)));
  assert.equal(d.video.width, 640);
  assert.equal(d.video.height, 360);
  assert.equal(d.audio.sampleRate, 44100);
  assert.equal(d.audio.channels, 1);
  assert.ok(d.video.nominalFrameUs > 25000 && d.video.nominalFrameUs < 40000, 'nominal frame ~30fps');
});

test('2.41 demuxer reads the phone rotation tag and coded size', () => {
  const d = demuxMp4(new Uint8Array(fs.readFileSync(f3)));
  assert.ok(d.video, 'video track found');
  assert.equal(d.video.rotation, 90);
  assert.equal(d.video.codedWidth, 320);
  assert.equal(d.video.codedHeight, 180);
  assert.deepEqual(displaySize(d.video), {w: 180, h: 320});
  const plain = demuxMp4(new Uint8Array(fs.readFileSync(f1)));
  assert.equal(plain.video.rotation, 0);
  assert.deepEqual(displaySize(plain.video), {w: 320, h: 180});
});

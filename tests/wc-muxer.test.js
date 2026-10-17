const test = require('node:test');
const assert = require('node:assert/strict');
const { WCMuxer } = require('../web/wc-muxer.js');

// Minimal shaped fixtures (structure-level; real decode is proven in tests/browser.cjs).
const AVCC = new Uint8Array([0x01, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x08,
  0x67, 0x42, 0x00, 0x1e, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x04, 0x68, 0xce, 0x06, 0xe2]);
const ASC = new Uint8Array([0x11, 0x90]); // AAC-LC, 48kHz, stereo

function concat(list) {
  const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}
function u32at(b, o) { return (b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]) >>> 0; }
// Walk top-level boxes: returns [{type,size,start}].
function topBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = u32at(buf, off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    assert.ok(size >= 8 && off + size <= buf.length, `bad box ${type} at ${off}`);
    out.push({ type, size, start: off });
    off += size;
  }
  assert.equal(off, buf.length, 'trailing bytes after last box');
  return out;
}
function hasFourCC(buf, cc) {
  return Buffer.from(buf).includes(cc);
}
// Find all trun entries: [{count, dataOffset, samples:[{duration,size,flags,cts}]}].
function findTruns(buf) {
  const out = [];
  for (let i = 0; i + 16 < buf.length; i++) {
    if (buf[i + 4] === 0x74 && buf[i + 5] === 0x72 && buf[i + 6] === 0x75 && buf[i + 7] === 0x6e) {
      const version = buf[i + 8];
      const flags = (buf[i + 9] << 16) | (buf[i + 10] << 8) | buf[i + 11];
      assert.equal(version, 1, 'trun must be v1 (signed CTS)');
      assert.equal(flags, 0x0f01, 'trun flags carry offset+duration+size+flags+cts');
      const count = u32at(buf, i + 12);
      const dataOffset = u32at(buf, i + 16);
      const samples = [];
      let p = i + 20;
      for (let s = 0; s < count; s++, p += 16) {
        samples.push({ duration: u32at(buf, p), size: u32at(buf, p + 4), flags: u32at(buf, p + 8), cts: u32at(buf, p + 12) });
      }
      out.push({ count, dataOffset, samples, at: i });
    }
  }
  return out;
}
// Find tfdt base decode times in file order.
function findTfdts(buf) {
  const out = [];
  for (let i = 0; i + 20 < buf.length; i++) {
    if (buf[i + 4] === 0x74 && buf[i + 5] === 0x66 && buf[i + 6] === 0x64 && buf[i + 7] === 0x74) {
      assert.equal(buf[i + 8], 1, 'tfdt must be v1');
      const hi = u32at(buf, i + 12), lo = u32at(buf, i + 16);
      out.push(hi * 4294967296 + lo);
    }
  }
  return out;
}
function fakeBytes(n, seed) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (seed + i * 31) & 255;
  return b;
}
function buildFile(audioCodec) {
  const mux = new WCMuxer({ fragmentUs: 500000 });
  mux.setVideoConfig(64, 64, AVCC);
  mux.setAudioConfig({ codec: audioCodec, sampleRate: 48000, channels: 2, bitrate: 128000, asc: audioCodec === 'aac' ? ASC : null });
  const file = [...mux.takeBoxes()];
  const frameUs = 1000000 / 30;
  for (let f = 0; f < 30; f++) {
    mux.addVideoSample(Math.round(f * frameUs), Math.round(frameUs), f % 10 === 0, fakeBytes(120 + f, f));
    file.push(...mux.takeBoxes());
  }
  const audioDurUs = Math.round((1024 / 48000) * 1000000);
  for (let a = 0; a < 47; a++) {
    mux.addAudioSample(a * audioDurUs, audioDurUs, fakeBytes(300, a + 50));
  }
  file.push(...mux.finish());
  return concat(file);
}

test('muxer writes ftyp + moov first, then moof/mdat fragments', () => {
  const buf = buildFile('aac');
  const tops = topBoxes(buf).map((b) => b.type);
  assert.deepEqual(tops.slice(0, 2), ['ftyp', 'moov']);
  assert.ok(tops.length >= 4, 'expected at least one fragment pair');
  for (let i = 2; i < tops.length; i += 2) assert.deepEqual([tops[i], tops[i + 1]], ['moof', 'mdat']);
  assert.ok(hasFourCC(buf, 'avc1'), 'video track must be avc1');
  assert.ok(hasFourCC(buf, 'mp4a'), 'audio track must be mp4a for AAC');
  assert.ok(hasFourCC(buf, 'esds'), 'AAC track must carry esds');
  assert.ok(hasFourCC(buf, 'trex'), 'moov must carry trex (fragmented MP4 signal)');
  assert.ok(!hasFourCC(buf, 'edts'), 'no edit lists (Instagram-safe)');
});

test('trun data offsets land exactly on sample bytes inside mdat', () => {
  const buf = buildFile('aac');
  const tops = topBoxes(buf);
  const truns = findTruns(buf);
  assert.ok(truns.length >= 2, 'video + audio truns expected');
  for (const t of truns) {
    // Owning moof: last moof starting at or before the trun.
    const moofs = tops.filter((b) => b.type === 'moof' && b.start <= t.at);
    const moof = moofs[moofs.length - 1];
    const mdat = tops.find((b) => b.type === 'mdat' && b.start > moof.start);
    const firstByte = moof.start + t.dataOffset;
    const totalSize = t.samples.reduce((n, s) => n + s.size, 0);
    assert.ok(firstByte >= mdat.start + 8, 'trun must point inside mdat payload');
    assert.ok(firstByte + totalSize <= mdat.start + mdat.size, 'trun samples must fit inside mdat');
  }
});

test('fragment durations chain: tfdt advances by previous durations', () => {
  const buf = buildFile('aac');
  // Group truns per moof in file order; tfdt order matches trun order (video, audio per fragment).
  const tops = topBoxes(buf);
  const truns = findTruns(buf);
  const tfdts = findTfdts(buf);
  assert.equal(tfdts.length, truns.length);
  const perMoof = [];
  for (const t of truns) {
    const idx = tops.filter((b) => b.type === 'moof' && b.start <= t.at).length - 1;
    (perMoof[idx] = perMoof[idx] || []).push(t);
  }
  const videoDur = perMoof.map((g) => g[0].samples.reduce((n, s) => n + s.duration, 0));
  const videoTfdts = perMoof.map((g, i) => tfdts[truns.indexOf(g[0])]);
  assert.equal(videoTfdts[0], 0, 'first video fragment starts at zero');
  for (let i = 1; i < videoTfdts.length; i++) {
    assert.equal(videoTfdts[i], videoTfdts[i - 1] + videoDur[i - 1], `video tfdt chains at fragment ${i}`);
  }
  const totalVideo = videoDur.reduce((n, d) => n + d, 0);
  assert.ok(Math.abs(totalVideo - 90000) <= 30, `30 frames at 30fps must span ~90000 ticks, got ${totalVideo}`);
});

test('key frames flagged sync, inter frames flagged dependent', () => {
  const buf = buildFile('aac');
  const truns = findTruns(buf);
  const videoTrun = truns[0];
  assert.equal(videoTrun.samples[0].flags, 0x02000000);
  assert.equal(videoTrun.samples[1].flags, 0x01010000);
  assert.equal(videoTrun.samples[10].flags, 0x02000000);
});

test('opus variant carries Opus + dOps entries', () => {
  const buf = buildFile('opus');
  assert.ok(hasFourCC(buf, 'Opus'), 'opus sample entry expected');
  assert.ok(hasFourCC(buf, 'dOps'), 'opus specific box expected');
  const tops = topBoxes(buf).map((b) => b.type);
  assert.deepEqual(tops.slice(0, 2), ['ftyp', 'moov']);
});

test('esds carries the AAC decoder bytes and AAC object type', () => {
  const buf = buildFile('aac');
  const at = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0x65 && buf[i + 1] === 0x73 && buf[i + 2] === 0x64 && buf[i + 3] === 0x73) at.push(i);
  }
  assert.equal(at.length, 1, 'exactly one esds box');
  const esds = buf.slice(at[0], at[0] + 60);
  assert.ok(esds.includes(0x40), 'AAC object type 0x40 present');
  const ascAt = esds.findIndex((v, i) => v === 0x11 && esds[i + 1] === 0x90);
  assert.ok(ascAt > 0, 'ASC bytes embedded in esds');
});

test('finish without both codec configs refuses to write media', () => {
  const mux = new WCMuxer();
  mux.setVideoConfig(64, 64, AVCC);
  assert.throws(() => mux.finish(), /missing audio or video codec config/);
});

test('takeBoxes drains the queue', () => {
  const mux = new WCMuxer();
  mux.setVideoConfig(64, 64, AVCC);
  mux.setAudioConfig({ codec: 'opus', sampleRate: 48000, channels: 2 });
  assert.ok(mux.takeBoxes().length >= 2, 'ftyp + moov emitted');
  assert.deepEqual(mux.takeBoxes(), [], 'queue empty after drain');
});

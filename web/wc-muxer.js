/* VoiceCut WebCodecs fMP4 muxer (pure, no DOM).
 * Builds an Instagram-safe fragmented MP4: ftyp + moov (avc1 + mp4a/Opus) +
 * moof+mdat fragments. moov is emitted first once both codec configs are
 * known; fragments are emitted incrementally so peak memory stays low.
 * Usable from the browser (window.VoiceCutMuxer) and from Node tests.
 */
(function (root) {
  'use strict';

  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  function u16(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
  function u24(v) { return new Uint8Array([(v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function u32(v) { v >>>= 0; return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function u64(v) {
    const hi = Math.floor(v / 4294967296) >>> 0, lo = (v >>> 0);
    return concatBytes([u32(hi), u32(lo)]);
  }
  function ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 127;
    return out;
  }
  function box(type, ...payloads) {
    const body = concatBytes(payloads);
    return concatBytes([u32(8 + body.length), ascii(type), body]);
  }
  function fullBox(type, version, flags, ...payloads) {
    return box(type, new Uint8Array([version & 255]), u24(flags >>> 0), ...payloads);
  }
  // ES_Descriptor length field: 7 bits per byte, high bit set except last.
  function esdsLen(n) {
    if (n < 128) return new Uint8Array([n]);
    const bytes = [];
    let v = n;
    const stack = [];
    stack.push(v & 127); v >>>= 7;
    while (v > 0) { stack.push(0x80 | (v & 127)); v >>>= 7; }
    while (stack.length) bytes.push(stack.pop());
    return new Uint8Array(bytes);
  }

  const IDENTITY_MATRIX = new Uint8Array([
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
  ]);
  const KEY_FLAGS = 0x02000000;   // sample is a sync sample, no dependencies
  const NONKEY_FLAGS = 0x01010000; // depends on others (P frame)
  const AUDIO_FLAGS = 0x02000000;
  // Millisecond video timeline: every duration field in the file (movie and
  // both tracks) shares the millisecond unit, so a reader that mixes up
  // timescales still lands on the right length. Timescales are arbitrary in
  // legal MP4; 1ms precision is plenty for video presentation timestamps.
  const VIDEO_TIMESCALE = 1000;
  // Millisecond audio timeline, same reasoning: every duration field in
  // the file (movie and both tracks) shares the millisecond unit, no
  // matter which track a reader looks at. The real sample rate is still
  // declared in the audio sample entry where decoders read it; only the
  // timestamp grid is milliseconds. Position-rounded chaining keeps the
  // total exact (21.333ms blocks land as 21/21/22 gaps on the grid).
  const AUDIO_TIMESCALE = 1000;

  function ftypBox() {
    // Brands match ffmpeg's fragmented MP4 (major iso5 + iso6/mp41) plus
    // mp42/isom so header-keyed readers always find a brand they accept.
    return box('ftyp', ascii('iso5'), u32(0x200), ascii('iso5'), ascii('iso6'), ascii('mp41'), ascii('mp42'), ascii('isom'));
  }

  function mvhdBox() {
    return fullBox('mvhd', 0, 0,
      u32(0), u32(0), u32(1000), u32(0), // creation, modification, timescale, duration(0: fragments carry it)
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      IDENTITY_MATRIX,
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(3));
  }

  function tkhdBox(trackId, isVideo, width, height) {
    return fullBox('tkhd', 0, 0x000007,
      u32(0), u32(0), u32(trackId), u32(0), u32(0),
      u32(0), u32(0), u16(0), u16(0),
      isVideo ? u16(0) : u16(0x0100), u16(0),
      IDENTITY_MATRIX,
      u32(isVideo ? (width << 16) >>> 0 : 0), u32(isVideo ? (height << 16) >>> 0 : 0));
  }

  function mdhdBox(timescale) {
    return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  }

  function hdlrBox(isVideo) {
    return fullBox('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'),
      u32(0), u32(0), u32(0), ascii(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'));
  }

  function minfHeaderBox(isVideo) {
    const mediaHead = isVideo
      ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    return { mediaHead, dinf };
  }

  function emptySampleTables() {
    return concatBytes([
      fullBox('stts', 0, 0, u32(0)),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
    ]);
  }

  function avc1Entry(width, height, avcCBytes) {
    const compressor = new Uint8Array(32);
    return box('avc1',
      new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0),
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      compressor, u16(0x18), u16(0xffff),
      box('avcC', avcCBytes));
  }

  function esdsBox(audioBitrate, ascBytes) {
    const avgBr = u32(audioBitrate >>> 0);
    const decSpecific = concatBytes([new Uint8Array([0x05]), esdsLen(ascBytes.length), ascBytes]);
    const decConfig = concatBytes([
      new Uint8Array([0x04]), esdsLen(13 + decSpecific.length),
      new Uint8Array([0x40, 0x15, 0x00, 0x06, 0x00]), avgBr, avgBr, decSpecific,
    ]);
    const es = concatBytes([
      new Uint8Array([0x03]), esdsLen(3 + decConfig.length + 3),
      u16(1), new Uint8Array([0x00]), decConfig,
      new Uint8Array([0x06, 0x01, 0x02]),
    ]);
    return fullBox('esds', 0, 0, es);
  }

  function mp4aEntry(channels, sampleRate, audioBitrate, ascBytes) {
    return box('mp4a',
      new Uint8Array(6), u16(1), u16(0), u16(0), u32(0),
      u16(channels), u16(16), u16(0), u16(0), u32((sampleRate << 16) >>> 0),
      esdsBox(audioBitrate, ascBytes));
  }

  function opusEntry(channels, sampleRate, preSkip) {
    const dOps = box('dOps',
      new Uint8Array([0x00, channels & 255]), u16(preSkip), u32(sampleRate >>> 0), u16(0), new Uint8Array([0x00]));
    return box('Opus',
      new Uint8Array(6), u16(1), u16(0), u16(0), u32(0),
      u16(channels), u16(16), u16(0), u16(0), u32((sampleRate << 16) >>> 0),
      dOps);
  }

  function trakBox(trackId, isVideo, timescale, width, height, sampleEntry) {
    const { mediaHead, dinf } = minfHeaderBox(isVideo);
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), sampleEntry),
      emptySampleTables());
    const minf = box('minf', mediaHead, dinf, stbl);
    const mdia = box('mdia', mdhdBox(timescale), hdlrBox(isVideo), minf);
    return box('trak', tkhdBox(trackId, isVideo, width, height), mdia);
  }

  function trexBox(trackId) {
    return fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));
  }

  function moovBox(opts) {
    const audioEntry = opts.audioCodec === 'aac'
      ? mp4aEntry(opts.audioChannels, opts.audioSampleRate, opts.audioBitrate, opts.audioAsc)
      : opusEntry(opts.audioChannels, opts.audioSampleRate, opts.opusPreSkip || 384);
    return box('moov',
      mvhdBox(),
      trakBox(1, true, VIDEO_TIMESCALE, opts.width, opts.height,
        avc1Entry(opts.width, opts.height, opts.avcC)),
      trakBox(2, false, AUDIO_TIMESCALE, 0, 0, audioEntry),
      box('mvex', trexBox(1), trexBox(2)));
  }

  // One track fragment. sampleBytes: concatenated raw sample data for data offsets.
  function trafBox(trackId, baseDecodeTime, samples, dataOffset) {
    const tfhd = fullBox('tfhd', 0, 0x020000, u32(trackId)); // default-base-is-moof
    const tfdt = fullBox('tfdt', 1, 0, u64(baseDecodeTime));
    const entries = [];
    for (const s of samples) {
      entries.push(u32(s.duration), u32(s.size), u32(s.flags), u32(s.ctsOffset));
    }
    // trun v1: signed CTS offsets. flags 0x0f01 = data-offset + duration +
    // size + per-sample flags + cts (no first-sample-flags). Every bit here
    // must match a field actually written per entry, or readers desync.
    const trun = fullBox('trun', 1, 0x0f01, u32(samples.length), u32(dataOffset), ...entries);
    return box('traf', tfhd, tfdt, trun);
  }

  function readU32At(buf, off) {
    return (((buf[off] * 256 + buf[off + 1]) * 256 + buf[off + 2]) * 256 + buf[off + 3]) >>> 0;
  }
  function writeU32At(buf, off, v) {
    v = Math.max(0, Math.min(0xffffffff, Math.round(v))) >>> 0;
    buf[off] = (v >>> 24) & 255; buf[off + 1] = (v >>> 16) & 255;
    buf[off + 2] = (v >>> 8) & 255; buf[off + 3] = v & 255;
  }
  function fourccAt(buf, off) {
    return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  }
  // Some players (Instagram included) read the total length from the moov
  // header instead of the fragments. The header is written before the
  // length is known, so after muxing we patch the real durations into
  // mvhd/tkhd/mdhd. moovBytes is modified in place.
  // durations: {movie: <mvhd timescale units>, tracks: {<trackId>: <track timescale units>}}.
  function patchMoovDurations(moovBytes, durations) {
    const tracks = (durations && durations.tracks) || {};
    const patchMdia = (start, end, dur) => {
      let o = start;
      while (o + 8 <= end) {
        const size = readU32At(moovBytes, o);
        if (size < 8 || o + size > end) return;
        if (fourccAt(moovBytes, o) === 'mdhd') {
          if (moovBytes[o + 8] === 1) { writeU32At(moovBytes, o + 32, 0); writeU32At(moovBytes, o + 36, dur); }
          else writeU32At(moovBytes, o + 24, dur);
        }
        o += size;
      }
    };
    const patchTrak = (start, end) => {
      let o = start, trackId = 0;
      while (o + 8 <= end) {
        const size = readU32At(moovBytes, o);
        if (size < 8 || o + size > end) return;
        if (fourccAt(moovBytes, o) === 'tkhd') {
          trackId = moovBytes[o + 8] === 1 ? readU32At(moovBytes, o + 28) : readU32At(moovBytes, o + 20);
        }
        o += size;
      }
      if (!Number.isFinite(tracks[trackId])) return;
      o = start;
      while (o + 8 <= end) {
        const size = readU32At(moovBytes, o);
        if (size < 8 || o + size > end) return;
        const t = fourccAt(moovBytes, o);
        if (t === 'tkhd') {
          if (moovBytes[o + 8] === 1) { writeU32At(moovBytes, o + 36, 0); writeU32At(moovBytes, o + 40, tracks[trackId]); }
          else writeU32At(moovBytes, o + 28, tracks[trackId]);
        } else if (t === 'mdia') {
          patchMdia(o + 8, o + size, tracks[trackId]);
        }
        o += size;
      }
    };
    if (fourccAt(moovBytes, 0) !== 'moov') return;
    let o = 8;
    while (o + 8 <= moovBytes.length) {
      const size = readU32At(moovBytes, o);
      if (size < 8 || o + size > moovBytes.length) return;
      const t = fourccAt(moovBytes, o);
      if (t === 'mvhd' && durations && Number.isFinite(durations.movie)) {
        if (moovBytes[o + 8] === 1) { writeU32At(moovBytes, o + 32, 0); writeU32At(moovBytes, o + 36, durations.movie); }
        else writeU32At(moovBytes, o + 24, durations.movie);
      } else if (t === 'trak') {
        patchTrak(o + 8, o + size);
      }
      o += size;
    }
  }

  class WCMuxer {
    constructor(opts) {
      opts = opts || {};
      this.fragmentUs = opts.fragmentUs || 1000000;
      this.video = []; // pending {ptsUs,durationUs,key,data}
      this.audio = []; // pending {ptsUs,durationUs,data}
      this.out = [];   // finished boxes, in file order
      this.headerDone = false;
      this.sequence = 0;
      this.videoCfg = null;
      this.audioCfg = null;
      this.videoFirstPtsUs = null; // track-absolute decode grid origin (µs)
      this.audioFirstPtsUs = null;
      this.videoNextDts = 0;
      this.audioNextDts = 0;
      this.videoFragStart = 0;
      this.audioFragStart = 0;
    }
    setVideoConfig(width, height, avcC) {
      this.videoCfg = { width, height, avcC: avcC instanceof Uint8Array ? avcC : new Uint8Array(avcC) };
      this._maybeHeader();
    }
    setAudioConfig(cfg) {
      this.audioCfg = {
        codec: cfg.codec, sampleRate: cfg.sampleRate, channels: cfg.channels,
        bitrate: cfg.bitrate || 128000,
        asc: cfg.asc ? (cfg.asc instanceof Uint8Array ? cfg.asc : new Uint8Array(cfg.asc)) : null,
        preSkip: cfg.preSkip || 384,
      };
      this._maybeHeader();
    }
    _maybeHeader() {
      if (this.headerDone || !this.videoCfg || !this.audioCfg) return;
      this.out.push(ftypBox(), moovBox({
        width: this.videoCfg.width, height: this.videoCfg.height, avcC: this.videoCfg.avcC,
        audioCodec: this.audioCfg.codec, audioChannels: this.audioCfg.channels,
        audioSampleRate: this.audioCfg.sampleRate, audioBitrate: this.audioCfg.bitrate,
        audioAsc: this.audioCfg.asc, opusPreSkip: this.audioCfg.preSkip,
      }));
      this.headerDone = true;
    }
    // Drain finished boxes (call repeatedly; returns array, empties the queue).
    takeBoxes() {
      const boxes = this.out;
      this.out = [];
      return boxes;
    }
    addVideoSample(ptsUs, durationUs, key, data) {
      if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
      this.video.push({ ptsUs, durationUs, key: !!key, data });
      const span = ptsUs - this.video[0].ptsUs;
      if (span >= this.fragmentUs) this._flush(false);
    }
    addAudioSample(ptsUs, durationUs, data) {
      if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
      this.audio.push({ ptsUs, durationUs, data });
    }
    _ticks(us, timescale) { return Math.max(0, Math.round((us * timescale) / 1000000)); }
    _flush(isLast) {
      if (!this.headerDone) {
        if (!isLast) return; // wait for both configs
        this._maybeHeader();
        if (!this.headerDone) throw new Error('Cannot finish: missing audio or video codec config.');
      }
      // Non-final flushes hold back one sample per track: the held stamp is
      // the exact endpoint of the last emitted length, so batch boundaries
      // stay position-exact instead of re-rounded.
      const takeBatch = (queue) => {
        if (isLast || queue.length < 2) return { emit: queue.splice(0, queue.length), nextPtsUs: null };
        const emit = queue.splice(0, queue.length - 1);
        return { emit, nextPtsUs: queue[0].ptsUs };
      };
      const vbatch = takeBatch(this.video);
      const abatch = takeBatch(this.audio);
      const vsamples = vbatch.emit;
      const asamples = abatch.emit;
      if (!vsamples.length && !asamples.length) return;
      this.sequence += 1;
      const parts = [fullBox('mfhd', 0, 0, u32(this.sequence))];
      const mdatParts = [];
      let videoBytes = 0;
      // Position-rounded chaining on a track-absolute grid: each decode
      // stamp is the rounded position since the track's first stamp, each
      // sample length the gap to the next stamp. Every stamp rounds once
      // against the same origin, so batch boundaries are exact (no
      // re-rounded fractions) and error never accumulates at any
      // timescale. Only the true final sample of each track uses the
      // caller-chained tail length (the exporter's nominal frame/block
      // length, as before).
      const chainBatch = (samples, timescale, firstPtsUs, nextPtsUs) => {
        const pos = samples.map((s) => this._ticks(s.ptsUs - firstPtsUs, timescale));
        return samples.map((s, i) => {
          let duration;
          if (i + 1 < samples.length) duration = Math.max(1, pos[i + 1] - pos[i]);
          else if (nextPtsUs != null) duration = Math.max(1, this._ticks(nextPtsUs - firstPtsUs, timescale) - pos[i]);
          else duration = this._ticks(s.durationUs, timescale) || 1;
          return { dts: pos[i], duration };
        });
      };
      const vTrunSamples = [];
      if (vsamples.length) {
        if (this.videoFirstPtsUs == null) this.videoFirstPtsUs = vsamples[0].ptsUs;
        const chain = chainBatch(vsamples, VIDEO_TIMESCALE, this.videoFirstPtsUs, vbatch.nextPtsUs);
        for (let i = 0; i < vsamples.length; i++) {
          const s = vsamples[i];
          const cts = this._ticks(s.ptsUs, VIDEO_TIMESCALE) - chain[i].dts;
          vTrunSamples.push({
            duration: chain[i].duration, size: s.data.length,
            flags: s.key ? KEY_FLAGS : NONKEY_FLAGS,
            ctsOffset: Math.max(0, cts) >>> 0,
          });
          videoBytes += s.data.length;
          mdatParts.push(s.data);
        }
        this.videoNextDts = chain[chain.length - 1].dts + vTrunSamples[vTrunSamples.length - 1].duration;
      }
      const aTrunSamples = [];
      if (asamples.length) {
        if (this.audioFirstPtsUs == null) this.audioFirstPtsUs = asamples[0].ptsUs;
        const chain = chainBatch(asamples, AUDIO_TIMESCALE, this.audioFirstPtsUs, abatch.nextPtsUs);
        for (let i = 0; i < asamples.length; i++) {
          const s = asamples[i];
          aTrunSamples.push({ duration: chain[i].duration, size: s.data.length, flags: AUDIO_FLAGS, ctsOffset: 0 });
          mdatParts.push(s.data);
        }
        this.audioNextDts = chain[chain.length - 1].dts + aTrunSamples[aTrunSamples.length - 1].duration;
      }
      // Two-pass: build trafs with placeholder offsets to measure moof, then patch.
      const buildTrafs = (vOff, aOff) => {
        const trafs = [];
        if (vTrunSamples.length) trafs.push(trafBox(1, this.videoFragStart, vTrunSamples, vOff));
        if (aTrunSamples.length) trafs.push(trafBox(2, this.audioFragStart, aTrunSamples, aOff));
        return trafs;
      };
      this.videoFragStart = this.videoNextDts - vTrunSamples.reduce((n, s) => n + s.duration, 0);
      this.audioFragStart = this.audioNextDts - aTrunSamples.reduce((n, s) => n + s.duration, 0);
      const probe = box('moof', parts[0], ...buildTrafs(0, 0));
      const vOff = probe.length + 8;
      const aOff = probe.length + 8 + videoBytes;
      const moof = box('moof', parts[0], ...buildTrafs(vOff, aOff));
      this.out.push(moof, box('mdat', ...mdatParts));
    }
    finish() {
      this._flush(true);
      return this.takeBoxes();
    }
    // Exact muxed lengths for the header patch: movie in mvhd timescale
    // (1000) units, tracks in their own timescale units. Call after finish().
    totalDurations() {
      const vSec = this.videoNextDts / VIDEO_TIMESCALE;
      const aSec = this.audioCfg && AUDIO_TIMESCALE
        ? this.audioNextDts / AUDIO_TIMESCALE : 0;
      return {
        movie: Math.max(0, Math.round(Math.max(vSec, aSec) * 1000)),
        tracks: {
          1: Math.max(0, Math.round(this.videoNextDts)),
          2: Math.max(0, Math.round(this.audioNextDts)),
        },
      };
    }
  }

  const api = { WCMuxer, VIDEO_TIMESCALE, AUDIO_TIMESCALE, KEY_FLAGS, NONKEY_FLAGS, patchMoovDurations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceCutMuxer = api;
})(typeof self !== 'undefined' ? self : this);

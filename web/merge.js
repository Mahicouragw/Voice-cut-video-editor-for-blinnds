/* VoiceCut video merge: join MP4/MOV clips into one file, in order, gapless.
 *
 * How it works: every picked clip is demuxed (pure MP4 reader below, no DOM),
 * decoded with WebCodecs, and re-encoded into one continuous file. Audio and
 * video timestamps are content-derived counters, so clips butt against each
 * other with no silence or black frames between them: the audio block
 * assembler carries its partial block across file boundaries, and each
 * clip's AAC encoder-delay (priming) is trimmed using the file's edit list.
 * Mixed clip sizes are letterboxed to the first clip with video; mixed frame
 * rates are absorbed by the continuous timestamps. Runs fully on-device.
 */
(function (root) {
  'use strict';

  // ---------------- Pure MP4 demuxer (no DOM; Node tests use this too) ----------------
  function readU32(b, o) { return ((b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0; }
  function readI32(b, o) { const v = readU32(b, o); return v > 2147483647 ? v - 4294967296 : v; }
  function readU64(b, o) { return readU32(b, o) * 4294967296 + readU32(b, o + 4); }
  function readI64(b, o) { const hi = readI32(b, o); return hi * 4294967296 + readU32(b, o + 4); }
  function boxType(b, o) { return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]); }
  function walkBoxes(b, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
      let size = readU32(b, o);
      let hdr = 8;
      if (size === 1) { size = readU64(b, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (!(size >= hdr)) break;
      cb(boxType(b, o), o + hdr, Math.min(end, o + size));
      if (!(o + size > o)) break;
      o += size;
      if (o > end) break;
    }
  }
  function hexByte(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }

  // AAC AudioSpecificConfig -> {objectType, sampleRate, channels}.
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function parseAsc(asc) {
    if (!asc || asc.length < 2) throw new Error('bad-audio-config');
    const objectType = asc[0] >> 3;
    const freqIndex = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
    let sampleRate = 0;
    if (freqIndex === 0x0f) {
      if (asc.length < 5) throw new Error('bad-audio-config');
      sampleRate = (asc[1] << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
    } else {
      sampleRate = AAC_RATES[freqIndex] || 0;
    }
    const chanCfg = (asc[1] >> 3) & 0x0f;
    const channels = [0, 1, 2, 3, 4, 5, 6, 8][chanCfg] || 2;
    if (!sampleRate) throw new Error('bad-audio-config');
    return { objectType: objectType || 2, sampleRate, channels };
  }

  // esds box content -> AudioSpecificConfig bytes.
  function parseEsds(content) {
    let asc = null;
    function walk(buf, start, end) {
      let o = start;
      while (o + 2 <= end && !asc) {
        const tag = buf[o++];
        let len = 0;
        for (let i = 0; i < 4 && o < end; i++) { const v = buf[o++]; len = (len << 7) | (v & 0x7f); if (!(v & 0x80)) break; }
        const payload = o, payloadEnd = Math.min(end, o + len);
        if (tag === 0x05) asc = buf.slice(payload, payloadEnd);
        else if (tag === 0x03) walk(buf, payload + 3, payloadEnd);
        else if (tag === 0x04) walk(buf, payload + 13, payloadEnd);
        o = payloadEnd;
      }
    }
    walk(content, 4, content.length); // skip version/flags + walk from ES_ID area
    if (!asc) throw new Error('bad-audio-config');
    return asc;
  }

  function readStts(content) {
    const count = readU32(content, 4);
    const deltas = [];
    let o = 8;
    for (let i = 0; i < count; i++, o += 8) {
      const n = readU32(content, o), d = readU32(content, o + 4);
      for (let k = 0; k < n; k++) deltas.push(d);
    }
    return deltas;
  }
  function readCtts(content) {
    const version = content[0];
    const count = readU32(content, 4);
    const offs = [];
    let o = 8;
    for (let i = 0; i < count; i++, o += 8) {
      const n = readU32(content, o);
      const v = version === 1 ? readI32(content, o + 4) : readU32(content, o + 4);
      for (let k = 0; k < n; k++) offs.push(v);
    }
    return offs;
  }
  function readStss(content) {
    const count = readU32(content, 4);
    const set = new Set();
    for (let i = 0; i < count; i++) set.add(readU32(content, 8 + i * 4));
    return set;
  }
  function readStsz(content) {
    const size = readU32(content, 4), count = readU32(content, 8);
    if (size !== 0) return new Array(count).fill(size);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = readU32(content, 12 + i * 4);
    return out;
  }
  function readStsc(content) {
    const count = readU32(content, 4);
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push({ first: readU32(content, 8 + i * 12), per: readU32(content, 12 + i * 12) });
    }
    return entries;
  }
  function readChunkOffsets(content, wide) {
    const count = readU32(content, 4);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = wide ? readU64(content, 8 + i * 8) : readU32(content, 8 + i * 4);
    return out;
  }

  // Demux one MP4/MOV file into timed samples. Throws plain-word Errors.
  function demuxMp4(u8) {
    if (!u8 || u8.length < 32) throw new Error('This file is too small to be a video.');
    if (boxType(u8, 0) !== 'ftyp') throw new Error('This is not an MP4 or MOV file.');
    const out = { durationSec: 0, video: null, audio: null };
    let moov = null;
    walkBoxes(u8, 0, u8.length, (type, start, end) => { if (type === 'moov' && !moov) moov = u8.subarray(start, end); });
    if (!moov) throw new Error('This file has no playable header.');
    let movieTimescale = 1000;
    walkBoxes(moov, 0, moov.length, (type, start, end) => {
      const c = moov.subarray(start, end);
      if (type === 'mvhd') {
        const v = c[0];
        movieTimescale = v === 1 ? readU32(c, 20) : readU32(c, 12);
        const dur = v === 1 ? readU64(c, 24) : readU32(c, 16);
        if (movieTimescale > 0) out.durationSec = dur / movieTimescale;
      } else if (type === 'trak') {
        const track = parseTrak(u8, moov.subarray(start, end), movieTimescale);
        if (track && track.kind === 'vide' && !out.video) out.video = track;
        else if (track && track.kind === 'soun' && !out.audio) out.audio = track;
      }
    });
    return out;
  }

  function parseTrak(file, trak, movieTimescale) {
    const t = { kind: null, codec: null, timescale: 0, durationSec: 0, tkDurationSec: 0, width: 0, height: 0, desc: null, asc: null, sampleRate: 0, channels: 0, elstHeadSec: 0, elstSegSec: 0, samples: [], nominalFrameUs: 33367 };
    walkBoxes(trak, 0, trak.length, (type, start, end) => {
      const c = trak.subarray(start, end);
      if (type === 'tkhd') {
        const v = c[0];
        const dur = v === 1 ? readU64(c, 28) : readU32(c, 20);
        if (movieTimescale > 0) t.tkDurationSec = dur / movieTimescale;
        const wo = v === 1 ? 84 : 76;
        t.width = readU32(c, wo) >>> 16; t.height = readU32(c, wo + 4) >>> 16;
      } else if (type === 'edts') {
        walkBoxes(trak, start, end, (t2, s2, e2) => {
          if (t2 !== 'elst') return;
          const e = trak.subarray(s2, e2);
          const v = e[0];
          const count = v === 1 ? readU32(e, 8) : readU32(e, 4);
          if (count < 1) return;
          let segDur, mediaTime;
          if (v === 1) { segDur = readU64(e, 12); mediaTime = readI64(e, 20); }
          else { segDur = readU32(e, 8); mediaTime = readI32(e, 12); }
          t.elstSegRaw = segDur; t.elstMediaRaw = mediaTime;
        });
      } else if (type === 'mdia') {
        parseMdia(file, trak.subarray(start, end), t);
      }
    });
    if (!t.kind || !t.timescale) return null;
    if (t.elstMediaRaw > 0) t.elstHeadSec = t.elstMediaRaw / t.timescale;
    if (t.elstSegRaw > 0 && movieTimescale > 0) t.elstSegSec = t.elstSegRaw / movieTimescale;
    return t;
  }

  function parseMdia(file, mdia, t) {
    let stbl = null;
    walkBoxes(mdia, 0, mdia.length, (type, start, end) => {
      const c = mdia.subarray(start, end);
      if (type === 'mdhd') {
        const v = c[0];
        t.timescale = v === 1 ? readU32(c, 20) : readU32(c, 12);
        const dur = v === 1 ? readU64(c, 24) : readU32(c, 16);
        if (t.timescale > 0) t.durationSec = dur / t.timescale;
      } else if (type === 'hdlr') {
        t.kind = String.fromCharCode(c[8], c[9], c[10], c[11]);
      } else if (type === 'minf') {
        walkBoxes(mdia, start, end, (t2, s2, e2) => { if (t2 === 'stbl') stbl = mdia.subarray(s2, e2); });
      }
    });
    if (t.kind !== 'vide' && t.kind !== 'soun') { t.kind = null; return; }
    if (!stbl) return;
    let deltas = [], ctts = [], syncSet = null, sizes = [], chunks = [], chunkOffs = [];
    walkBoxes(stbl, 0, stbl.length, (type, start, end) => {
      const c = stbl.subarray(start, end);
      if (type === 'stsd') parseStsd(stbl.subarray(start, end), t);
      else if (type === 'stts') deltas = readStts(c);
      else if (type === 'ctts') ctts = readCtts(c);
      else if (type === 'stss') syncSet = readStss(c);
      else if (type === 'stsz') sizes = readStsz(c);
      else if (type === 'stsc') chunks = readStsc(c);
      else if (type === 'stco') chunkOffs = readChunkOffsets(c, false);
      else if (type === 'co64') chunkOffs = readChunkOffsets(c, true);
    });
    if (!t.codec || !sizes.length || !chunkOffs.length || !deltas.length) return;
    // Per-chunk sample counts from the chunk map.
    const perChunk = new Array(chunkOffs.length);
    let ei = 0;
    for (let i = 0; i < chunkOffs.length; i++) {
      while (ei + 1 < chunks.length && chunks[ei + 1].first <= i + 1) ei++;
      perChunk[i] = chunks.length ? chunks[ei].per : 0;
    }
    const samples = [];
    let si = 0, dts = 0;
    for (let ci = 0; ci < chunkOffs.length && si < sizes.length; ci++) {
      let off = chunkOffs[ci];
      for (let k = 0; k < perChunk[ci] && si < sizes.length; k++, si++) {
        const cts = dts + (ctts[si] || 0);
        samples.push({ off, size: sizes[si], dts, cts, key: syncSet ? syncSet.has(si + 1) : true });
        off += sizes[si];
        dts += deltas[si] || 0;
      }
    }
    // Bounds-check every sample against the file.
    for (const s of samples) {
      if (!(s.off >= 0) || !(s.size > 0) || s.off + s.size > file.length) {
        throw new Error('This file looks damaged. Its picture or sound points outside the file.');
      }
    }
    t.samples = samples;
    if (t.kind === 'vide' && samples.length) {
      const totalUs = (t.durationSec > 0 ? t.durationSec : dts / (t.timescale || 30000)) * 1000000;
      t.nominalFrameUs = Math.min(1000000, Math.max(1000, Math.round(totalUs / samples.length)));
    }
  }

  function parseStsd(stsd, t) {
    const count = readU32(stsd, 4);
    if (count < 1) return;
    // First sample entry: size + fourcc + reserved + codec boxes.
    let o = 8;
    const entrySize = readU32(stsd, o);
    const fourcc = String.fromCharCode(stsd[o + 4], stsd[o + 5], stsd[o + 6], stsd[o + 7]);
    const entryEnd = Math.min(stsd.length, o + entrySize);
    if (fourcc === 'avc1' || fourcc === 'avc3') {
      walkBoxes(stsd, o + 86, entryEnd, (bt, bs, be) => {
        if (bt === 'avcC' && !t.desc) t.desc = stsd.slice(bs, be);
      });
      if (!t.desc || t.desc.length < 4) return;
      t.codec = 'avc1.' + hexByte(t.desc[1]) + hexByte(t.desc[2]) + hexByte(t.desc[3]);
      t.width = t.width || (stsd[o + 24] << 8) | stsd[o + 25];
      t.height = t.height || (stsd[o + 26] << 8) | stsd[o + 27];
    } else if (fourcc === 'mp4a') {
      // Sound entries version 0/1/2 put extensions at different offsets.
      for (const ext of [36, 52, 64]) {
        if (t.asc || o + ext + 8 > entryEnd) continue;
        walkBoxes(stsd, o + ext, entryEnd, (bt, bs, be) => {
          if (bt === 'esds' && !t.asc) {
            try { t.asc = parseEsds(stsd.slice(bs, be)); } catch (e) { t.asc = null; }
          }
        });
      }
      // mp4a v0: channels at +24, sample rate (16.16) at +32.
      t.channels = (stsd[o + 24] << 8) | stsd[o + 25];
      t.sampleRate = readU32(stsd, o + 32) >>> 16;
      if (t.asc) {
        try {
          const a = parseAsc(t.asc);
          t.sampleRate = a.sampleRate; t.channels = a.channels;
          t.codec = 'mp4a.40.' + a.objectType;
        } catch (e) { /* keep entry values, no codec */ }
      }
      if (!t.codec && t.sampleRate) t.codec = 'mp4a.40.2';
    } else if (fourcc === 'Opus') {
      for (const ext of [36, 52, 64]) {
        if (t.desc || o + ext + 8 > entryEnd) continue;
        walkBoxes(stsd, o + ext, entryEnd, (bt, bs, be) => {
          if (bt === 'dOps' && !t.desc) t.desc = stsd.slice(bs, be);
        });
      }
      if (t.desc && t.desc.length >= 12) {
        t.channels = t.desc[1] || 2;
        t.sampleRate = readU32(t.desc, 2) || 48000;
        t.preSkip = (t.desc[6] << 8) | t.desc[7];
        t.codec = 'opus';
      }
    } else {
      t.unsupportedFourcc = fourcc;
    }
  }

  // ---------------- Merge engine (browser, WebCodecs) ----------------
  function even(n) { return Math.max(2, Math.round(n) & ~1); }

  async function mergeMp4Files(files, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const isCancelled = opts.isCancelled || function () { return false; };
    const Muxer = root.VoiceCutMuxer && root.VoiceCutMuxer.WCMuxer;
    if (!root.VideoDecoder || !root.AudioDecoder || !root.VideoEncoder || !root.AudioEncoder ||
        !root.VideoFrame || !root.AudioData || !Muxer || typeof document === 'undefined') {
      throw new Error('Merging needs Chrome or Edge on this device. Your browser cannot join videos.');
    }
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) throw new Error('Pick at least two clips to merge.');
    if (list.length === 1) return { single: true, file: list[0] };
    let totalBytes = 0;
    for (const f of list) totalBytes += f.size || 0;
    if (totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('The clips add up to more than 2 GB. Pick fewer or shorter clips.');
    const fail = (msg) => { throw new Error(msg); };
    const checkCancel = () => { if (isCancelled()) { const e = new Error('Merge cancelled.'); e.cancelled = true; throw e; } };

    // Phase 1: read + demux every clip (metadata only is kept; bytes released).
    const clips = [];
    for (let i = 0; i < list.length; i++) {
      checkCancel();
      const f = list[i];
      const label = 'Clip ' + (i + 1) + ' (“' + (f.name || 'clip') + '”)';
      onProgress(i / list.length * 0.05, 'Reading ' + label);
      let head;
      try { head = new Uint8Array(await f.slice(0, 12).arrayBuffer()); }
      catch (e) { fail(label + ' could not be read.'); }
      if (head.length < 12 || String.fromCharCode(head[4], head[5], head[6], head[7]) !== 'ftyp') {
        fail(label + ' is not an MP4 or MOV file. Merge works with MP4 and MOV clips.');
      }
      let bytes;
      try { bytes = new Uint8Array(await f.arrayBuffer()); }
      catch (e) { fail(label + ' could not be read. It may be too large for this device.'); }
      let demuxed;
      try { demuxed = demuxMp4(bytes); }
      catch (e) { fail(label + ': ' + e.message.charAt(0).toLowerCase() + e.message.slice(1)); }
      if (demuxed.video && !demuxed.video.codec) {
        const cc = demuxed.video.unsupportedFourcc || 'unknown';
        fail(label + ' uses the ' + cc + ' picture format. Merge needs H.264 clips.');
      }
      if (demuxed.audio && !demuxed.audio.codec) {
        const cc = demuxed.audio.unsupportedFourcc || 'unknown';
        fail(label + ' uses the ' + cc + ' sound format. Merge needs AAC or Opus sound.');
      }
      if (!demuxed.video && !demuxed.audio) fail(label + ' has no playable picture or sound.');
      if (demuxed.video && !(demuxed.video.width > 0 && demuxed.video.height > 0)) demuxed.video = null;
      if (demuxed.video && !demuxed.video.samples.length) demuxed.video = null;
      if (demuxed.audio && !demuxed.audio.samples.length) demuxed.audio = null;
      if (!demuxed.video && !demuxed.audio) fail(label + ' has no playable picture or sound.');
      clips.push({ file: f, label, info: demuxed });
      bytes = null;
    }

    // Plan the output from the first clip that has each track.
    const firstVideo = clips.map(c => c.info.video).find(v => v);
    const firstAudio = clips.map(c => c.info.audio).find(a => a);
    const outW = firstVideo ? even(firstVideo.width) : 640;
    const outH = firstVideo ? even(firstVideo.height) : 360;
    const outRate = firstAudio ? firstAudio.sampleRate : 48000;
    const outCh = 2;
    const mixedSizes = clips.some(c => c.info.video && (even(c.info.video.width) !== outW || even(c.info.video.height) !== outH));
    let totalSamples = 0;
    for (const c of clips) {
      if (c.info.video) totalSamples += c.info.video.samples.length;
      if (c.info.audio) totalSamples += c.info.audio.samples.length;
    }
    totalSamples = Math.max(1, totalSamples);

    // Encoders + muxer (same shapes as the export path).
    const mux = new Muxer({ fragmentUs: 1000000 });
    const fileParts = [];
    const drain = () => { for (const b of mux.takeBoxes()) fileParts.push(b); };
    let encoderError = null;
    const onEncoderError = (what) => () => { if (!encoderError) encoderError = new Error('The ' + what + ' stopped unexpectedly. Try fewer or shorter clips.'); };
    const audioCodecPick = async () => {
      for (const c of ['mp4a.40.2', 'opus']) {
        try {
          const sup = await root.AudioEncoder.isConfigSupported({ codec: c, sampleRate: outRate, numberOfChannels: outCh, bitrate: 128000 });
          if (sup && sup.supported) return c;
        } catch (e) {}
      }
      return null;
    };
    const audioCodec = await audioCodecPick();
    if (!audioCodec) fail('This browser cannot write merged sound. Try Chrome or Edge.');
    let pendingVideo = null;
    const venc = new root.VideoEncoder({
      output: (chunk, meta) => {
        try {
          if (meta && meta.decoderConfig && meta.decoderConfig.description && !mux.videoCfg) {
            mux.setVideoConfig(outW, outH, new Uint8Array(meta.decoderConfig.description));
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const cur = { ts: chunk.timestamp, key: chunk.type === 'key', data };
          if (pendingVideo) {
            mux.addVideoSample(pendingVideo.ts, Math.max(1, cur.ts - pendingVideo.ts), pendingVideo.key, pendingVideo.data);
            drain();
          }
          pendingVideo = cur;
        } catch (e) { if (!encoderError) encoderError = e; }
      },
      error: onEncoderError('video writer'),
    });
    const vBitrate = outH > 1080 ? 16000000 : outH > 720 ? 10000000 : 6000000;
    const avcCodec = outH > 720 ? 'avc1.42E028' : 'avc1.42E01E';
    try {
      const fpsGuess = firstVideo ? Math.min(60, Math.max(10, Math.round(1000000 / firstVideo.nominalFrameUs))) : 30;
      venc.configure({ codec: avcCodec, width: outW, height: outH, bitrate: vBitrate, framerate: fpsGuess, avc: { format: 'avc' } });
    } catch (e) { fail('This browser cannot write merged video. Try Chrome or Edge.'); }
    const aenc = new root.AudioEncoder({
      output: (chunk, meta) => {
        try {
          if (!mux.audioCfg) {
            const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
            mux.setAudioConfig({
              codec: audioCodec === 'mp4a.40.2' ? 'aac' : 'opus',
              sampleRate: outRate, channels: outCh, bitrate: 128000,
              asc: desc ? new Uint8Array(desc) : null,
            });
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          mux.addAudioSample(chunk.timestamp, chunk.duration || Math.round(1024 / outRate * 1000000), data);
          drain();
        } catch (e) { if (!encoderError) encoderError = e; }
      },
      error: onEncoderError('sound writer'),
    });
    try {
      aenc.configure({ codec: audioCodec, sampleRate: outRate, numberOfChannels: outCh, bitrate: 128000 });
    } catch (e) { fail('This browser cannot write merged sound. Try Chrome or Edge.'); }
    drain();

    // Continuous content-derived cursors: the gapless mechanism.
    let videoCursorUs = 0;
    let audioBlockCount = 0;
    let samplesDone = 0;
    const scaleCanvas = document.createElement('canvas');
    scaleCanvas.width = outW; scaleCanvas.height = outH;
    const scaleCtx = scaleCanvas.getContext('2d');
    scaleCtx.fillStyle = '#000000';
    // Stereo block assembler; the partial block carries across clips.
    let aCarryL = [], aCarryR = [], aCarryLen = 0;
    const pushStereo = (l, r) => {
      aCarryL.push(l); aCarryR.push(r); aCarryLen += l.length;
      const BLOCK = 1024;
      while (aCarryLen >= BLOCK) {
        const out = new Float32Array(BLOCK * 2);
        let need = BLOCK, qi = 0;
        while (need > 0) {
          const hl = aCarryL[qi], hr = aCarryR[qi];
          const off = hl._off || 0;
          const take = Math.min(need, hl.length - off);
          out.set(hl.subarray(off, off + take), (BLOCK - need));
          out.set(hr.subarray(off, off + take), (BLOCK - need) + BLOCK);
          hl._off = off + take;
          need -= take;
          if (hl._off >= hl.length) qi++;
        }
        aCarryL = aCarryL.slice(qi); aCarryR = aCarryR.slice(qi);
        aCarryLen -= BLOCK;
        const ts = Math.round((audioBlockCount * BLOCK * 1000000) / outRate);
        audioBlockCount++;
        aenc.encode(new root.AudioData({
          format: 'f32-planar', sampleRate: outRate, numberOfFrames: BLOCK,
          numberOfChannels: 2, timestamp: ts, data: out.buffer,
        }));
        if (encoderError) throw encoderError;
      }
    };
    const checkEncoder = () => { if (encoderError) throw encoderError; };

    const closeCodecs = () => {
      try { venc.close(); } catch (e) {}
      try { aenc.close(); } catch (e) {}
    };

    try {
      for (let ci = 0; ci < clips.length; ci++) {
        checkCancel(); checkEncoder();
        const clip = clips[ci];
        onProgress(0.05 + 0.9 * (samplesDone / totalSamples), 'Joining ' + clip.label);
        let bytes;
        try { bytes = new Uint8Array(await clip.file.arrayBuffer()); }
        catch (e) { fail(clip.label + ' could not be read a second time.'); }
        const info = clip.info;
        const toUs = (v, ts) => Math.round((v * 1000000) / ts);

        // ---- Video pass ----
        let videoAdvancedUs = 0, videoYielded = false;
        if (info.video) {
          const vt = info.video;
          const vStartUs = videoCursorUs;
          const needScale = even(vt.width) !== outW || even(vt.height) !== outH;
          // Presentation-order grid from the container: decoder output
          // timestamps echo input order, so durations come from here.
          const presCtsUs = vt.samples.map(s => s.cts).sort((a, b) => a - b).map(c => toUs(c, vt.timescale));
          let pending = null, pendingKey = true, fed = 0, got = 0, frameIdx = 0, prevCtsUs = -1;
          const nominalUs = vt.nominalFrameUs;
          const emitFrame = (frame, durUs, key) => {
            videoYielded = true;
            if (!(durUs > 0)) durUs = nominalUs;
            durUs = Math.min(2000000, Math.max(1, Math.round(durUs)));
            const ts = videoCursorUs;
            videoCursorUs += durUs;
            try {
              if (needScale) {
                scaleCtx.fillStyle = '#000000';
                scaleCtx.fillRect(0, 0, outW, outH);
                const s = Math.min(outW / vt.width, outH / vt.height);
                const dw = Math.max(1, Math.round(vt.width * s)), dh = Math.max(1, Math.round(vt.height * s));
                scaleCtx.drawImage(frame, Math.round((outW - dw) / 2), Math.round((outH - dh) / 2), dw, dh);
                frame.close();
                const vf = new root.VideoFrame(scaleCanvas, { timestamp: ts, duration: durUs });
                venc.encode(vf, { keyFrame: !!key });
                vf.close();
              } else {
                let vf;
                try { vf = new root.VideoFrame(frame, { timestamp: ts, duration: durUs }); }
                catch (e) {
                  scaleCtx.drawImage(frame, 0, 0, outW, outH);
                  vf = new root.VideoFrame(scaleCanvas, { timestamp: ts, duration: durUs });
                }
                frame.close();
                venc.encode(vf, { keyFrame: !!key });
                vf.close();
              }
            } catch (e) { fail(clip.label + ' has a picture frame this browser cannot write.'); }
            checkEncoder();
          };
          const vdec = new root.VideoDecoder({
            output: (frame) => {
              got++;
              const myCtsUs = frameIdx < presCtsUs.length ? presCtsUs[frameIdx] : (prevCtsUs >= 0 ? prevCtsUs + nominalUs : 0);
              frameIdx++;
              if (pending) { emitFrame(pending, myCtsUs - prevCtsUs, pendingKey); pendingKey = false; }
              pending = frame; prevCtsUs = myCtsUs;
            },
            error: (e) => { if (!encoderError) encoderError = new Error(clip.label + ' has a picture this browser cannot read.'); },
          });
          try {
            vdec.configure({ codec: vt.codec, description: vt.desc, codedWidth: vt.width, codedHeight: vt.height });
          } catch (e) { fail(clip.label + ' uses a picture format this browser cannot read.'); }
          for (let si = 0; si < vt.samples.length; si++) {
            checkEncoder();
            if ((si & 31) === 0) {
              checkCancel();
              onProgress(0.05 + 0.9 * ((samplesDone + si) / totalSamples), 'Joining ' + clip.label);
              while (fed - got > 120) await new Promise(r => setTimeout(r, 0));
            }
            const s = vt.samples[si];
            const dur = si + 1 < vt.samples.length ? toUs(vt.samples[si + 1].cts - s.cts, vt.timescale) : nominalUs;
            try {
              vdec.decode(new root.EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: toUs(s.dts, vt.timescale), duration: Math.max(1, dur), data: bytes.subarray(s.off, s.off + s.size) }));
            } catch (e) { fail(clip.label + ' has a damaged picture.'); }
            fed++;
          }
          samplesDone += vt.samples.length;
          try { await vdec.flush(); } catch (e) {}
          try { vdec.close(); } catch (e) {}
          checkEncoder();
          if (pending) { emitFrame(pending, nominalUs, pendingKey); pending = null; }
          videoAdvancedUs = videoCursorUs - vStartUs;
        }

        // ---- Audio pass ----
        let audioAdvancedSec = 0;
        if (info.audio) {
          const at = info.audio;
          const sttsTotalSec = at.samples.length && at.timescale ? (at.samples[at.samples.length - 1].dts / at.timescale) + (at.durationSec / Math.max(1, at.samples.length)) : at.durationSec;
          // Exact trims: edit-list head (AAC priming) and exact tail; sanity-checked.
          let skipOut = 0, validOut = Infinity;
          if (at.codec !== 'opus' && at.elstHeadSec > 0) {
            const sk = Math.round(at.elstHeadSec * outRate);
            if (sk > 0 && sk < sttsTotalSec * outRate * 0.5) skipOut = sk;
          }
          const exactSec = at.elstSegSec > 0 ? at.elstSegSec : (at.tkDurationSec > 0 ? at.tkDurationSec : 0);
          if (exactSec > 0) {
            const v = Math.round(exactSec * outRate);
            const approx = sttsTotalSec * outRate;
            if (v > approx * 0.5 && v < approx + outRate) validOut = v;
          }
          let skipped = 0, emitted = 0;
          let resPrevL = null, resPrevR = null;
          let currentInRate = at.sampleRate;
          // Linear resample to the output rate (streaming, bounded state).
          // Upsampling (44.1k to 48k) is clean; rare downmix input only.
          const resample = (plane, prev) => {
            if (currentInRate === outRate || !plane.length) {
              return { data: plane, prev: plane.length ? plane[plane.length - 1] : prev };
            }
            const ratio = outRate / currentInRate;
            const outLen = Math.max(0, Math.floor(plane.length * ratio));
            const out = new Float32Array(outLen);
            const p = (prev === null || prev === undefined) ? plane[0] : prev;
            const last = plane[plane.length - 1];
            const at = (i) => i < 0 ? p : (i >= plane.length ? last : plane[i]);
            for (let i = 0; i < outLen; i++) {
              const src = i / ratio;
              const i0 = Math.floor(src), frac = src - i0;
              out[i] = at(i0) + (at(i0 + 1) - at(i0)) * frac;
            }
            return { data: out, prev: last };
          };
          let fed = 0, got = 0;
          const adec = new root.AudioDecoder({
            output: (ad) => {
              got++;
              try {
                const n = ad.numberOfFrames;
                const inCh = ad.numberOfChannels;
                currentInRate = ad.sampleRate || at.sampleRate;
                const planes = [];
                for (let c = 0; c < Math.min(inCh, 2); c++) {
                  const plane = new Float32Array(n);
                  ad.copyTo(plane, { planeIndex: c, frameCount: n, format: 'f32-planar' });
                  planes.push(plane);
                }
                let L = planes[0] || new Float32Array(n);
                let R = inCh > 1 ? (planes[1] || new Float32Array(n)) : null;
                const rl = resample(L, resPrevL); resPrevL = rl.prev; L = rl.data;
                if (R) { const rr = resample(R, resPrevR); resPrevR = rr.prev; R = rr.data; }
                else { R = L.slice(); resPrevR = resPrevL; }
                let start = 0;
                if (skipped < skipOut) { start = Math.min(L.length, skipOut - skipped); skipped += start; }
                let end = L.length;
                if (emitted + (end - start) > validOut) end = start + Math.max(0, validOut - emitted);
                if (end > start) { pushStereo(L.subarray(start, end), R.subarray(start, end)); emitted += end - start; }
              } finally { try { ad.close(); } catch (e) {} }
            },
            error: () => { if (!encoderError) encoderError = new Error(clip.label + ' has sound this browser cannot read.'); },
          });
          try {
            adec.configure({ codec: at.codec, sampleRate: at.sampleRate, numberOfChannels: Math.min(at.channels || 2, 8), description: at.asc || at.desc || undefined });
          } catch (e) {
            // Opus descriptions vary by browser: retry with the full dOps box.
            if (at.codec !== 'opus' || !at.desc) fail(clip.label + ' uses sound this browser cannot read.');
            try {
              const full = new Uint8Array(at.desc.length + 8);
              const dv = new DataView(full.buffer);
              dv.setUint32(0, full.length);
              full.set([0x64, 0x4f, 0x70, 0x73], 4);
              full.set(at.desc, 8);
              adec.configure({ codec: 'opus', sampleRate: at.sampleRate, numberOfChannels: Math.min(at.channels || 2, 8), description: full });
            } catch (e2) { fail(clip.label + ' uses sound this browser cannot read.'); }
          }
          for (let si = 0; si < at.samples.length; si++) {
            checkEncoder();
            if ((si & 63) === 0) {
              checkCancel();
              onProgress(0.05 + 0.9 * ((samplesDone + si) / totalSamples), 'Joining ' + clip.label);
              while (fed - got > 240) await new Promise(r => setTimeout(r, 0));
            }
            const s = at.samples[si];
            const dur = si + 1 < at.samples.length ? toUs(at.samples[si + 1].dts - s.dts, at.timescale) : Math.round(1024 / at.sampleRate * 1000000);
            try {
              adec.decode(new root.EncodedAudioChunk({ type: 'key', timestamp: toUs(s.dts, at.timescale), duration: Math.max(1, dur), data: bytes.subarray(s.off, s.off + s.size) }));
            } catch (e) { fail(clip.label + ' has damaged sound.'); }
            fed++;
          }
          samplesDone += at.samples.length;
          try { await adec.flush(); } catch (e) {}
          try { adec.close(); } catch (e) {}
          checkEncoder();
          audioAdvancedSec = emitted / outRate;
          resPrevL = resPrevR = null;
        } else {
          // No sound: silent stretch matching this clip's picture length.
          const fillSec = videoAdvancedUs / 1000000;
          const total = Math.round(fillSec * outRate);
          const CHUNK = 4096;
          for (let o = 0; o < total; o += CHUNK) {
            checkEncoder();
            if (((o / CHUNK) & 63) === 0) checkCancel();
            const n = Math.min(CHUNK, total - o);
            pushStereo(new Float32Array(n), new Float32Array(n));
          }
          audioAdvancedSec = total / outRate;
        }

        // Still picture when the clip has sound but no (decodable) picture.
        if ((!info.video || !videoYielded) && audioAdvancedSec > 0) {
          const stillFps = 30, stepUs = Math.round(1000000 / stillFps);
          const frames = Math.max(1, Math.round(audioAdvancedSec * stillFps));
          scaleCtx.fillStyle = '#141824';
          scaleCtx.fillRect(0, 0, outW, outH);
          for (let fi = 0; fi < frames; fi++) {
            checkEncoder();
            if ((fi & 31) === 0) checkCancel();
            const vf = new root.VideoFrame(scaleCanvas, { timestamp: videoCursorUs, duration: stepUs });
            venc.encode(vf, { keyFrame: fi === 0 });
            vf.close();
            videoCursorUs += stepUs;
          }
        }
        bytes = null;
        onProgress(0.05 + 0.9 * (samplesDone / totalSamples), clip.label + ' joined');
      }

      // Final partial audio block only (mid-merge partials carried across).
      if (aCarryLen > 0) {
        const BLOCK = 1024;
        const out = new Float32Array(BLOCK * 2);
        let qp = 0;
        for (let qi = 0; qi < aCarryL.length; qi++) {
          const hl = aCarryL[qi], hr = aCarryR[qi];
          const off = hl._off || 0;
          const len = hl.length - off;
          out.set(hl.subarray(off), qp);
          out.set(hr.subarray(off), qp + BLOCK);
          qp += len;
        }
        const ts = Math.round((audioBlockCount * BLOCK * 1000000) / outRate);
        audioBlockCount++;
        aenc.encode(new root.AudioData({
          format: 'f32-planar', sampleRate: outRate, numberOfFrames: BLOCK,
          numberOfChannels: 2, timestamp: ts, data: out.buffer,
        }));
        checkEncoder();
      }
      aCarryL = []; aCarryR = []; aCarryLen = 0;
      try { await venc.flush(); } catch (e) {}
      try { await aenc.flush(); } catch (e) {}
      checkEncoder();
      if (pendingVideo) {
        mux.addVideoSample(pendingVideo.ts, 33367, pendingVideo.key, pendingVideo.data);
        pendingVideo = null;
      }
      drain();
      let boxes = [];
      try { boxes = mux.finish(); } catch (e) { fail('The joined file came out empty.'); }
      for (const b of boxes) fileParts.push(b);
      try {
        const moovPart = fileParts.find(b => b.length > 8 && b[4] === 0x6d && b[5] === 0x6f && b[6] === 0x6f && b[7] === 0x76);
        if (moovPart) root.VoiceCutMuxer.patchMoovDurations(moovPart, mux.totalDurations());
      } catch (e) {}
      onProgress(1, 'Finishing');
      try { console.log('[VoiceCut merge] videoUs=' + videoCursorUs + ' audioBlocks=' + audioBlockCount + ' mux=' + JSON.stringify(mux.totalDurations())); } catch (e) {}
      const blob = new Blob(fileParts, { type: 'video/mp4' });
      fileParts.length = 0;
      closeCodecs();
      if (!blob.size) fail('The joined file came out empty.');
      return {
        file: new File([blob], 'merged-videos.mp4', { type: 'video/mp4' }),
        durationSec: Math.max(videoCursorUs / 1000000, (audioBlockCount * 1024) / outRate),
        mixedSizes,
        count: clips.length,
      };
    } catch (e) {
      closeCodecs();
      throw e;
    }
  }

  const api = { demuxMp4, mergeMp4Files, parseAsc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceCutMerge = api;
})(typeof self !== 'undefined' ? self : this);

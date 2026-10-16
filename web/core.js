/* Pure helpers, shared by browser and Node tests. */
(function(root) {
  'use strict';
  const TTL_MS = 15 * 60 * 1000;
  function ranges(project) {
    const start = Number(project.trimStart), end = Number(project.trimEnd || project.duration);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > project.duration + 0.01) throw new Error('Choose a valid start and end within the video.');
    const kept = project.segments.map(s => ({start: Math.max(start, s.start), end: Math.min(end, s.end)})).filter(s => s.end > s.start).sort((a,b) => a.start-b.start);
    if (!kept.length) throw new Error('No video segments remain. Undo deletion or upload a video.');
    return kept;
  }
  function mimeFor(format, supports) {
    const options = format === 'mp4' ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4'] : ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
    const mime = options.find(supports);
    if (!mime) throw new Error(format.toUpperCase() + ' recording is unavailable in this browser. Choose another format.');
    return mime;
  }
  function extension(mime) { return mime.startsWith('video/mp4') ? 'mp4' : 'webm'; }
  function expired(createdAt, now = Date.now()) { return now - createdAt >= TTL_MS; }
  // Crop rectangle in source pixels. Presets are centered; custom uses percentages 0-100.
  function cropRect(preset, videoWidth, videoHeight, custom) {
    const vw = Number(videoWidth), vh = Number(videoHeight);
    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) throw new Error('Video dimensions are unavailable.');
    const ratios = {'16:9': 16/9, '9:16': 9/16, '1:1': 1, '4:3': 4/3};
    if (preset === 'custom') {
      const x = Number(custom?.x), y = Number(custom?.y), w = Number(custom?.w), h = Number(custom?.h);
      if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 100.01 || y+h > 100.01) throw new Error('Crop values must be percentages inside the frame.');
      return {x: Math.round(vw*x/100), y: Math.round(vh*y/100), w: Math.max(2, Math.round(vw*w/100)), h: Math.max(2, Math.round(vh*h/100))};
    }
    if (!preset || preset === 'original' || !ratios[preset]) return {x: 0, y: 0, w: Math.round(vw), h: Math.round(vh)};
    const target = ratios[preset];
    let w = vw, h = vw/target;
    if (h > vh) { h = vh; w = vh*target; }
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    return {x: Math.round((vw-w)/2), y: Math.round((vh-h)/2), w, h};
  }
  // Remove [delStart, delEnd] from every segment, splitting segments that
  // straddle the range. Pure: returns new {start,end} pieces without ids.
  function deleteRange(project, delStart, delEnd) {
    const ds = Number(delStart), de = Number(delEnd);
    if (!Number.isFinite(ds) || !Number.isFinite(de) || ds < 0 || de - ds < 0.05 || de > project.duration + 0.01)
      throw new Error('Type a valid range inside the video, at least 0.05 seconds long.');
    const kept = ranges(project);
    if (kept.every(r => r.start >= ds - 0.001 && r.end <= de + 0.001))
      throw new Error('That range covers the whole video. Delete a smaller range instead.');
    const out = [];
    for (const s of project.segments) {
      if (s.start < ds) out.push({start: s.start, end: Math.min(s.end, ds)});
      if (s.end > de) out.push({start: Math.max(s.start, de), end: s.end});
    }
    return out.filter(s => s.end - s.start >= 0.01);
  }
  // Split the segment containing pos into two pieces at pos. Pure: returns
  // new {start,end} pieces without ids. Points on a boundary are a no-op.
  function splitAt(project, pos) {
    const p = Number(pos);
    const start = Number(project.trimStart), end = Number(project.trimEnd || project.duration);
    if (!Number.isFinite(p) || p <= start || p >= end)
      throw new Error('Split point must be inside the trimmed video.');
    const segs = (project.segments && project.segments.length) ? project.segments : [{start, end}];
    const out = [];
    for (const s of segs) {
      if (p > s.start + 0.001 && p < s.end - 0.001) out.push({start: s.start, end: p}, {start: p, end: s.end});
      else out.push({start: s.start, end: s.end});
    }
    return out;
  }
  // Find quiet gaps in decoded audio. Pure: channels is an array of
  // Float32Array-like sample arrays, all the same length. Mirrors the server
  // silence ladder (-30/-25/-20 dBFS) with 0.1s edge padding so on-device
  // results match server results. Returns {gaps:[[start,end]...],thresholdDb}.
  function findGaps(channels, sampleRate, minSeconds) {
    const sr = Number(sampleRate), minLen = Number(minSeconds);
    if (!Array.isArray(channels) || !channels.length || !Number.isFinite(sr) || sr <= 0)
      throw new Error('Audio data is missing.');
    if (!Number.isFinite(minLen) || minLen < 0.5 || minLen > 30)
      throw new Error('Silence length must be between 0.5 and 30 seconds.');
    const len = channels[0].length;
    if (!len) return {gaps:[], thresholdDb:-30};
    const frame = Math.max(1, Math.floor(sr * 0.01));
    const frames = Math.ceil(len / frame);
    const db = new Array(frames);
    for (let f = 0; f < frames; f++) {
      let peak = 0;
      const s0 = f * frame, s1 = Math.min(len, s0 + frame);
      for (const ch of channels) for (let i = s0; i < s1; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      db[f] = 20 * Math.log10(peak + 1e-9);
    }
    for (const th of [-30, -25, -20]) {
      const raw = [];
      let start = -1;
      for (let f = 0; f <= frames; f++) {
        const quiet = f < frames && db[f] < th;
        if (quiet && start < 0) start = f;
        if (!quiet && start >= 0) { raw.push([start / 100, f / 100]); start = -1; }
      }
      const gaps = raw
        .filter(([a, b]) => b - a >= minLen - 0.05)
        .map(([a, b]) => [Math.max(0, a + 0.1), b - 0.1])
        .filter(([a, b]) => b - a >= 0.2)
        .map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
      if (gaps.length) return {gaps, thresholdDb: th};
    }
    return {gaps:[], thresholdDb:-20};
  }
  // Total kept video length in seconds (trim window minus deleted segments).
  // Display code must never crash, so invalid projects fall back to duration.
  function retainedDuration(p) {
    try {
      const rs = ranges(p);
      const total = rs.reduce((s, r) => s + Math.max(0, r.end - r.start), 0);
      return total > 0 ? total : (Number(p.duration) || 0);
    } catch { return Number(p.duration) || 0; }
  }
  // Nominal [start,end] chunk windows for long-audio processing.
  function splitChunks(duration, chunkSeconds) {
    const total = Number(duration), len = Number(chunkSeconds);
    if (!Number.isFinite(total) || total <= 0) throw new Error('Audio duration is missing.');
    if (!Number.isFinite(len) || len < 1) throw new Error('Chunk length must be at least 1 second.');
    const out = [];
    for (let s = 0; s < total; s += len) out.push([s, Math.min(total, s + len)]);
    return out;
  }
  // Move a chunk boundary to the quietest moment within +/-searchSeconds so
  // separately processed parts join without clicks. samples is Float32Array-like
  // mono audio; returns seconds. Falls back to nominal when nothing is quiet.
  function chooseCutPoint(samples, sampleRate, nominalSeconds, searchSeconds = 2) {
    const sr = Number(sampleRate), nom = Number(nominalSeconds), search = Math.max(0.2, Number(searchSeconds) || 0);
    const len = samples ? samples.length : 0;
    if (!len || !Number.isFinite(sr) || sr <= 0 || !Number.isFinite(nom)) return nom;
    const total = len / sr;
    const win = Math.max(1, Math.floor(sr * 0.05));
    const energyAt = (t) => {
      const c = Math.floor(t * sr);
      const s0 = Math.max(0, c - win), s1 = Math.min(len, c + win);
      let e = 0;
      for (let i = s0; i < s1; i++) e += samples[i] * samples[i];
      return e / Math.max(1, s1 - s0);
    };
    let best = Math.min(Math.max(nom, 0.5), Math.max(0.5, total - 0.5));
    let bestE = energyAt(best);
    for (let t = Math.max(0.25, nom - search); t <= Math.min(total - 0.25, nom + search); t += 0.05) {
      const e = energyAt(t);
      if (e < bestE) { bestE = e; best = t; }
    }
    return Math.round(best * 100) / 100;
  }
  // Voice-activity curve at 10 frames/second: 1 where someone speaks, 0 in
  // silence. The threshold adapts to each recording (loudest frame sets the
  // scale), with a hangover so short pauses inside speech stay "voice".
  function computeVoiceCurve(samples, sampleRate) {
    const sr = Number(sampleRate);
    if (!samples || !samples.length || !Number.isFinite(sr) || sr <= 0) throw new Error('Audio is unavailable.');
    const step = Math.max(1, Math.floor(sr / 10));
    const n = Math.max(1, Math.ceil(samples.length / step));
    const energy = new Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const s0 = i * step, s1 = Math.min(samples.length, s0 + step);
      let e = 0, c = 0;
      for (let j = s0; j < s1; j += 7) { e += samples[j] * samples[j]; c++; }
      e = e / Math.max(1, c);
      energy[i] = e;
      if (e > peak) peak = e;
    }
    const floor = peak * 0.02 + 1e-6;
    const active = new Array(n).fill(0);
    for (let i = 0; i < n; i++) if (energy[i] > floor) active[i] = 1;
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n; i++) if (active[i - 1] && !active[i] && energy[i] > floor * 0.25) active[i] = 1;
    for (let i = 0; i < n; i++) if (!active[i]) {
      let j = i;
      while (j < n && !active[j]) j++;
      if (j - i <= 2 && i > 0 && j < n) for (let k = i; k < j; k++) active[k] = 1;
      i = j;
    }
    return { frames: active, fps: 10, duration: samples.length / sr };
  }
  function voiceActiveAt(curve, t) {
    if (!curve || !curve.frames || !curve.frames.length) return false;
    const i = Math.floor(Number(t) * (curve.fps || 10));
    if (!Number.isFinite(i) || i < 0) return false;
    return !!curve.frames[Math.min(i, curve.frames.length - 1)];
  }
  // Keep only the retained ranges of decoded channel data, concatenated.
  // channels: array of Float32Arrays, all the same length. ranges: [{start,
  // end}] in seconds. Deleted parts never reach the result.
  function selectRanges(channels, sampleRate, ranges) {
    const sr = Number(sampleRate);
    if (!Array.isArray(channels) || !channels.length || !Number.isFinite(sr) || sr <= 0) throw new Error('Audio is unavailable.');
    const cuts = (ranges || []).map(r => ({start: Math.max(0, Number(r.start)), end: Math.max(0, Number(r.end))})).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
    if (!cuts.length) throw new Error('No video segments remain. Undo deletion or upload a video.');
    const len = channels[0].length;
    const pieces = cuts.map(r => [Math.min(len, Math.floor(r.start * sr)), Math.min(len, Math.floor(r.end * sr))]).filter(([a, b]) => b > a);
    const total = pieces.reduce((s, [a, b]) => s + (b - a), 0);
    if (!total) throw new Error('No video segments remain. Undo deletion or upload a video.');
    const out = [];
    for (let c = 0; c < channels.length; c++) {
      const dst = new Float32Array(total);
      let o = 0;
      for (const [a, b] of pieces) { dst.set(channels[c].subarray(a, b), o); o += b - a; }
      out.push(dst);
    }
    return {channels: out, sampleRate: sr};
  }
  // Spread retained-only channels back onto the full timeline so enhanced
  // audio stays aligned with the video. Deleted parts become silence.
  function expandRanges(channels, sampleRate, fullLength, ranges) {
    const sr = Number(sampleRate), full = Math.floor(Number(fullLength));
    if (!Array.isArray(channels) || !channels.length || !Number.isFinite(sr) || sr <= 0 || !Number.isFinite(full) || full <= 0) throw new Error('Audio is unavailable.');
    const cuts = (ranges || []).map(r => ({start: Math.max(0, Number(r.start)), end: Math.max(0, Number(r.end))})).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
    const out = channels.map(() => new Float32Array(full));
    let o = 0;
    for (const r of cuts) {
      const a = Math.min(full, Math.floor(r.start * sr)), b = Math.min(full, Math.floor(r.end * sr));
      const n = Math.min(b - a, channels[0].length - o);
      if (n <= 0) break;
      for (let c = 0; c < channels.length; c++) out[c].set(channels[c].subarray(o, o + n), a);
      o += n;
    }
    return {channels: out, sampleRate: sr};
  }
  // Plain-words recording failures: raw browser errors confuse, these guide.
  function recordErrorHint(name) {
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied. Allow the microphone for VoiceCut in the app settings, then try again.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found. Recording needs a working mic.';
    if (name === 'NotReadableError') return 'The microphone is busy. Close other apps using the mic such as calls, voice recorder or assistant, wait a moment, then try again.';
    if (name === 'OverconstrainedError' || name === 'AbortError') return 'Recording was interrupted. Try again.';
    return '';
  }
  // Smart music gain: the ducking level moves both sides. Under voice the
  // music drops by the level; in silence it rises by the level.
  function duckedGain(volumePercent, duckLevel, voiceActive, duckingEnabled) {
    const vol = Math.max(0, Number(volumePercent) || 0) / 100;
    if (!duckingEnabled) return vol;
    const level = Math.min(90, Math.max(0, Number(duckLevel) || 0)) / 100;
    if (voiceActive) return vol * (1 - level);
    return Math.min(1.5, vol * (1 + level));
  }
  const VIDEO_FILTERS = { normal:'', bright:'brightness(1.25)', warm:'sepia(0.35) saturate(1.4)', cool:'brightness(1.05) contrast(1.08) saturate(1.2) hue-rotate(-12deg)', bw:'grayscale(1)', vintage:'sepia(0.5) contrast(1.1) brightness(0.95)', vivid:'saturate(1.8) contrast(1.15)', overflow:'brightness(1.15) saturate(1.35) contrast(1.05)' };
  const VOICE_FILTERS = { none:1, high:1.335, low:0.749, chipmunk:1.782, alien:1.5, robot:0.9 };
  const api = { TTL_MS, ranges, mimeFor, extension, expired, cropRect, deleteRange, splitAt, findGaps, retainedDuration, splitChunks, chooseCutPoint, computeVoiceCurve, voiceActiveAt, selectRanges, expandRanges, recordErrorHint, duckedGain, VIDEO_FILTERS, VOICE_FILTERS };
  root.VoiceCutCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

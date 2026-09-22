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
  const api = { TTL_MS, ranges, mimeFor, extension, expired, cropRect };
  root.VoiceCutCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

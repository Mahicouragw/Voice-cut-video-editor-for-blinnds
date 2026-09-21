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
  const api = { TTL_MS, ranges, mimeFor, extension, expired };
  root.VoiceCutCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

/* VoiceCut NR-2 neural cleanup engine: wraps the bundled RNNoise recurrent
 * neural network (Mozilla/Xiph, see web/vendor/RNNOISE-COPYING.txt) to remove
 * background noise that is as loud as, or louder than, the voice — the case
 * classic spectral gating cannot solve. 48 kHz mono core; the app resamples
 * around it. Works in browsers (lazy dynamic import) and Node tests. */
(function(root) {
  'use strict';
  var FRAME = 480, NORM_PEAK = 20000, DELAY = 480;
  // Neural mix per level: base strength everywhere, boosted inside detected
  // noise regions. Ultra is full neural everywhere.
  var MIX = {
    light: {base: 0.40, boost: 0.70},
    medium: {base: 0.60, boost: 0.85},
    strong: {base: 0.80, boost: 1.0},
    voicefocus: {base: 0.85, boost: 1.0},
    ultra: {base: 1.0, boost: 1.0}
  };
  var enginePromise = null;
  function ensureEngine(moduleUrl) {
    if (!enginePromise) {
      enginePromise = import(moduleUrl).then(function(m) {
        var factory = m.default || m;
        if (typeof factory !== 'function') throw new Error('Neural engine module has no factory.');
        return factory();
      });
    }
    return enginePromise;
  }
  function tick() { return new Promise(function(r) { setTimeout(r, 0); }); }
  /* mono48: Float32Array at 48 kHz. opts: {moduleUrl, peak, mixAt(t)->0..1,
   * onProgress(0..1), shouldCancel()->bool}.
   * Returns {out: Float32Array, meanVad}. Throws on cancel or engine failure. */
  async function process48k(mono48, opts) {
    opts = opts || {};
    if (!opts.moduleUrl) throw new Error('Neural engine module URL missing.');
    var Module = await ensureEngine(opts.moduleUrl);
    var n = mono48.length | 0;
    if (!(n > FRAME)) throw new Error('Audio too short for neural cleanup.');
    var peak = opts.peak;
    if (!(peak > 0)) { peak = 0; for (var i = 0; i < n; i++) { var a = Math.abs(mono48[i]); if (a > peak) peak = a; } }
    if (!(peak > 1e-9)) return {out: new Float32Array(n), meanVad: 0};
    var g = NORM_PEAK / peak;
    var st = 0, pIn = 0, pOut = 0;
    try {
      st = Module._rnnoise_create(0);
      if (!st) throw new Error('Neural engine failed to start.');
      pIn = Module._malloc(FRAME * 4); pOut = Module._malloc(FRAME * 4);
      if (!pIn || !pOut) throw new Error('Neural engine ran out of memory.');
      var frames = Math.ceil(n / FRAME);
      var raw = new Float32Array((frames + 1) * FRAME);
      var fr = new Float32Array(FRAME);
      var HEAPF32 = Module.HEAPF32, inW = pIn >> 2, outW = pOut >> 2;
      var vadSum = 0, f, o, k;
      var CHUNK = 6000; // ~60 s per progress yield
      for (var f0 = 0; f0 <= frames; f0 += CHUNK) {
        if (opts.shouldCancel && opts.shouldCancel()) throw new Error('Cancelled');
        var f1 = Math.min(frames + 1, f0 + CHUNK);
        for (f = f0; f < f1; f++) {
          o = f * FRAME;
          for (k = 0; k < FRAME; k++) fr[k] = (o + k < n ? mono48[o + k] : 0) * g;
          HEAPF32.set(fr, inW);
          vadSum += Module._rnnoise_process_frame(st, pOut, pIn);
          fr.set(HEAPF32.subarray(outW, outW + FRAME));
          raw.set(fr, o);
        }
        if (opts.onProgress) opts.onProgress(f1 / (frames + 1));
        await tick();
      }
      // Output lags input by exactly one frame: shift back, restore gain, mix.
      var mixAt = typeof opts.mixAt === 'function' ? opts.mixAt : function() { return 1; };
      var out = new Float32Array(n), neural, m, t;
      for (i = 0; i < n; i++) {
        neural = raw[i + DELAY] / g;
        t = i / 48000;
        m = mixAt(t);
        if (m < 0) m = 0; else if (m > 1) m = 1;
        out[i] = mono48[i] * (1 - m) + neural * m;
      }
      return {out: out, meanVad: vadSum / (frames + 1)};
    } finally {
      try { if (pIn) Module._free(pIn); } catch (e) {}
      try { if (pOut) Module._free(pOut); } catch (e) {}
      try { if (st) Module._rnnoise_destroy(st); } catch (e) {}
    }
  }
  var api = {process48k: process48k, MIX: MIX, FRAME: FRAME, version: '2.0.0'};
  root.VoiceCutNR2 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

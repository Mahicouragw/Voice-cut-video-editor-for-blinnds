/* VoiceCut ND-1 noise profiler: scans the whole audio and finds engine-like
 * BRR/rrr/trrr rumble (steady, low, periodic) plus overall loudness, so the
 * neural cleanup can work hardest exactly where the noise dominates.
 * Pure JavaScript, no dependencies. Runs in browsers and Node tests. */
(function(root) {
  'use strict';
  var WIN_SEC = 0.5, HOP_SEC = 0.25, LP_FC = 250, DEC_SR = 1000;
  function fmt(t) {
    t = Math.max(0, t);
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  // Returns {regions:[{start,end,score}], summary:{brrCount,brrSeconds,text}, strengthAt(t,base,boost)}.
  // mono: Float32Array single channel, sr: sample rate.
  function scanNoise(mono, sr) {
    sr = sr | 0;
    var n = mono ? mono.length : 0;
    if (!(sr > 0) || !(n > sr / 4)) throw new Error('Audio too short to scan.');
    var win = Math.max(64, Math.floor(WIN_SEC * sr));
    var hop = Math.max(32, Math.floor(HOP_SEC * sr));
    // One-pole lowpass at 250 Hz over the whole file (cheap, O(n)).
    var dt = 1 / sr, rc = 1 / (2 * Math.PI * LP_FC), a = dt / (rc + dt);
    var lp = new Float32Array(n), y = 0, i;
    for (i = 0; i < n; i++) { y += a * (mono[i] - y); lp[i] = y; }
    // Decimate the lowpassed signal to ~1 kHz for fast autocorrelation.
    var dec = Math.max(1, Math.round(sr / DEC_SR));
    var dn = Math.floor(n / dec), dsr = sr / dec;
    var d = new Float32Array(dn), k, j, acc;
    for (k = 0; k < dn; k++) { acc = 0; for (j = 0; j < dec; j++) acc += lp[k * dec + j]; d[k] = acc / dec; }
    var lagMin = Math.max(2, Math.floor(dsr / 150)); // 150 Hz top
    var lagMax = Math.min(Math.floor(dn / 4), Math.ceil(dsr / 30)); // 30 Hz bottom
    // Window statistics.
    var wins = [];
    var w0, w1, s2, l2, m, v, mean, e0, best, blag, e, jj, ll;
    for (w0 = 0; w0 + win <= n; w0 += hop) {
      w1 = w0 + win;
      s2 = 0; l2 = 0;
      for (i = w0; i < w1; i++) { s2 += mono[i] * mono[i]; l2 += lp[i] * lp[i]; }
      var rms = Math.sqrt(s2 / win), lowRatio = rms > 1e-9 ? Math.sqrt(l2 / win) / rms : 0;
      // Normalized autocorrelation peak on decimated lowpassed signal.
      var dw0 = Math.floor(w0 / dec), dw1 = Math.min(dn, dw0 + Math.floor(win / dec));
      mean = 0; for (i = dw0; i < dw1; i++) mean += d[i]; mean /= Math.max(1, dw1 - dw0);
      e0 = 0; for (i = dw0; i < dw1; i++) { v = d[i] - mean; e0 += v * v; }
      best = 0; blag = 0;
      if (e0 > 1e-12) {
        for (ll = lagMin; ll <= lagMax && dw0 + ll < dw1; ll++) {
          e = 0;
          for (jj = dw0; jj + ll < dw1; jj++) e += (d[jj] - mean) * (d[jj + ll] - mean);
          e /= e0;
          if (e > best) { best = e; blag = ll; }
        }
      }
      wins.push({t0: w0 / sr, t1: w1 / sr, rms: rms, lowRatio: Math.min(1, lowRatio), periodic: best, lag: blag});
    }
    if (!wins.length) throw new Error('Audio too short to scan.');
    // Median window level: relative quiet/loud thresholds that adapt to the recording.
    var levels = wins.map(function(w) { return w.rms; }).sort(function(x, y) { return x - y; });
    var median = levels[Math.floor(levels.length / 2)] || 0;
    var quietBelow = Math.max(0.004, median * 0.12);
    var w;
    for (k = 0; k < wins.length; k++) { w = wins[k]; w.quiet = w.rms < quietBelow; }
    // BRR candidates: loud-ish, low-heavy, strongly periodic.
    var cand = wins.map(function(w) {
      return !w.quiet && w.lowRatio > 0.5 && w.periodic > 0.55;
    });
    // Confirm only steady runs: 6+ consecutive windows (~1.5 s) with a stable
    // pitch lag. Speech wobbles; engines do not.
    var regions = [], runStart = -1;
    function flushRun(end) {
      if (runStart < 0 || end - runStart < 6) { runStart = -1; return; }
      var lags = [];
      for (k = runStart; k < end; k++) lags.push(wins[k].lag);
      lags.sort(function(x, y) { return x - y; });
      var med = lags[Math.floor(lags.length / 2)] || 1;
      var stable = lags.every(function(l) { return Math.abs(l - med) <= Math.max(1, med * 0.2); });
      if (!stable) { runStart = -1; return; }
      var score = 0;
      for (k = runStart; k < end; k++) score += wins[k].periodic;
      score /= (end - runStart);
      var ns = wins[runStart].t0, ne = wins[end - 1].t1;
      var hz = med > 0 ? dsr / med : 0;
      var prev = regions[regions.length - 1];
      if (prev && ns - prev.end < 0.75) { prev.end = ne; prev.score = Math.max(prev.score, score); }
      else regions.push({start: ns, end: ne, score: score, hz: hz});
      runStart = -1;
    }
    for (k = 0; k <= cand.length; k++) {
      if (k < cand.length && cand[k]) { if (runStart < 0) runStart = k; }
      else flushRun(k);
    }
    regions = regions.filter(function(r) { return r.end - r.start >= 1.0; });
    var brrSeconds = regions.reduce(function(s, r) { return s + (r.end - r.start); }, 0);
    // Engine fundamental: median region pitch, for comb notching of drone harmonics.
    var combHz = 0;
    if (regions.length) {
      var hzs = regions.map(function(r) { return r.hz || 0; }).filter(function(h) { return h > 20 && h < 160; }).sort(function(x, y) { return x - y; });
      if (hzs.length) combHz = hzs[Math.floor(hzs.length / 2)];
    }
    // Rough speech-to-floor ratio: median window level vs the quiet 10%.
    // Near 0 dB the noise dominates everywhere and the cleanup cascades.
    var floor = levels[Math.floor(levels.length * 0.1)] || 0;
    var snrDb = (median > 1e-9 && floor > 1e-9) ? 20 * Math.log10(median / floor) : 0;
    var text;
    if (!regions.length) text = 'No steady engine-like rumble found. General background noise will still be reduced.';
    else if (regions.length <= 3) text = 'Engine-like noise found at ' + regions.map(function(r) { return fmt(r.start) + '\u2013' + fmt(r.end); }).join(', ') + '. Cleanup will work hardest there.';
    else text = regions.length + ' engine-like noise stretches found (' + Math.round(brrSeconds) + ' s total). Cleanup will work hardest there.';
    // Smooth strength envelope: boost inside regions, base elsewhere, 0.25 s ramps.
    function strengthAt(t, base, boost) {
      var wgt = 0, r, x;
      for (var q = 0; q < regions.length; q++) {
        r = regions[q];
        if (t < r.start - 0.25 || t > r.end + 0.25) continue;
        if (t <= r.start) x = (t - (r.start - 0.25)) / 0.25;
        else if (t >= r.end) x = ((r.end + 0.25) - t) / 0.25;
        else x = 1;
        x = Math.max(0, Math.min(1, x));
        wgt = Math.max(wgt, x * x * (3 - 2 * x));
      }
      return base + (boost - base) * wgt;
    }
    return {
      regions: regions,
      summary: {brrCount: regions.length, brrSeconds: brrSeconds, text: text, combHz: combHz, snrDb: snrDb},
      strengthAt: strengthAt
    };
  }
  var api = {scanNoise: scanNoise, version: '1.1.0'};
  root.VoiceCutNDetect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

// VoiceCut export audio fidelity check (reproducible diagnostic).
// Constant-tone fixture in, windowed RMS + tone-content analysis out.
// Run from repo root: node scripts/export-audio-check.cjs [mp4|webm|both]
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FMT = process.argv[2] || 'both';
const DIR = '/tmp/a236';
const ROOT = require('path').join(__dirname, '..');
fs.mkdirSync(DIR, { recursive: true });

function ff(args, opts) { return execFileSync('ffmpeg', ['-v', 'error', ...args], opts); }
function fp(args) { return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim(); }

// ---- fixture: 8s video, 440Hz 0-4s then 880Hz 4-8s, constant level ----
const SRC = path.join(DIR, 'tones.mp4');
if (!fs.existsSync(SRC)) {
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=8',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,volume=0.5,aformat=sample_fmts=fltp:channel_layouts=stereo[a]',
    '-map', '2:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest', '-y', SRC]);
}
const MUSIC = path.join(DIR, 'music.wav');
if (!fs.existsSync(MUSIC)) ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=8', '-ac', '2', '-ar', '44100', '-y', MUSIC]);

// ---- analysis ----
function decodeMono(file) {
  const buf = ff(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
function rmsDb(samples, from, to) {
  let s = 0; for (let i = from; i < to; i++) s += samples[i] * samples[i];
  const m = s / Math.max(1, to - from);
  return 10 * Math.log10(Math.max(1e-12, m));
}
function goertzel(samples, from, to, freq, sr) {
  const k = Math.round(freq * (to - from) / sr), w = 2 * Math.PI * k / (to - from);
  const cw = Math.cos(w); let s0 = 0, s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { s0 = samples[i] + 2 * cw * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - 2 * cw * s1 * s2;
}
function analyze(label, file) {
  const sr = 48000, pcm = decodeMono(file);
  const dur = pcm.length / sr, win = Math.floor(sr * 0.1), edge = Math.floor(sr * 0.3);
  let mn = 1e9, mx = -1e9; const perSec = [];
  for (let s = 0; s < Math.floor(dur); s++) {
    const a = s * sr, b = Math.min(pcm.length, a + sr);
    const g440 = goertzel(pcm, a, b, 440, sr), g880 = goertzel(pcm, a, b, 880, sr);
    perSec.push(`${s}s:${g880 > g440 * 4 ? '880' : g440 > g880 * 4 ? '440' : 'mix?'}`);
  }
  for (let o = edge; o + win <= pcm.length - edge; o += win) {
    const d = rmsDb(pcm, o, o + win); if (d < mn) mn = d; if (d > mx) mx = d;
  }
  let peak = 0; for (let i = 0; i < pcm.length; i += 7) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  const info = JSON.parse(fp(['-show_entries', 'stream=codec_type,codec_name,sample_rate,channels', '-show_entries', 'format=duration', '-of', 'json', file]));
  const astreams = info.streams.filter(s => s.codec_type === 'audio');
  console.log(`--- ${label} ---`);
  console.log(`file=${path.basename(file)} dur=${Number(info.format.duration || dur).toFixed(2)}s audio=${astreams.map(s => s.codec_name + '/' + s.sample_rate + 'Hz/ch' + s.channels).join(',') || 'NONE'} peak=${(20 * Math.log10(Math.max(1e-9, peak))).toFixed(1)}dBFS`);
  console.log(`content/sec: ${perSec.join(' ')}`);
  console.log(`RMS window min=${mn.toFixed(2)}dB max=${mx.toFixed(2)}dB FLATNESS=${(mx - mn).toFixed(2)}dB`);
  return { mn, mx, flat: mx - mn };
}

(async () => {
  console.log('=== SOURCE ===');
  analyze('source tones.mp4', SRC);
  const server = spawn('node', ['scripts/serve.js'], { cwd: ROOT, env: { ...process.env, PORT: '3099' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (/error|failed|Error/i.test(t) && !t.includes('[Announce]')) console.log('CONSOLE:', t.slice(0, 160)); });

  async function freshUpload() {
    await page.goto('http://127.0.0.1:3099');
    await page.setInputFiles('#fileVideo', SRC);
    await page.waitForFunction(() => document.querySelector('#mainVideo').duration > 7, {}, { timeout: 30000 });
  }
  async function doExport(fmt, name) {
    await page.locator('#tab-export').click();
    await page.locator('#exportFormat').selectOption(fmt);
    await page.locator('#btnDoExport').click();
    await page.waitForFunction(() => document.querySelector('#exportStatus').textContent.startsWith('Export complete'), {}, { timeout: 120000 });
    const dl = page.waitForEvent('download');
    await page.locator('#btnDownloadExported').click();
    const d = await dl, out = path.join(DIR, name);
    await d.saveAs(out);
    return out;
  }
  async function cleanup() {
    await page.locator('#tab-clips').click();
    await page.locator('#btnDeleteProject').click(); await page.locator('#btnConfirmApply').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Project deleted.');
  }

  const fmts = FMT === 'both' ? ['mp4', 'webm'] : [FMT];
  for (const fmt of fmts) {
    await freshUpload();
    analyze(`${fmt} untouched`, await doExport(fmt, `exp-${fmt}-plain.${fmt === 'mp4' ? 'mp4' : 'webm'}`));
    await cleanup();
    await freshUpload();
    await page.locator('#delRangeStart').fill('00:00'); await page.locator('#delRangeEnd').fill('00:04'); await page.locator('#btnDeleteRange').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent.includes('Deleted'), {}, { timeout: 30000 });
    analyze(`${fmt} delete 0-4 (user scenario)`, await doExport(fmt, `exp-${fmt}-delhead.${fmt === 'mp4' ? 'mp4' : 'webm'}`));
    await cleanup();
  }
  await freshUpload(); // music mix sanity (mp4): duration + peak only
  await page.locator('#tab-audio').click();
  await page.locator('#subMusic').click();
  await page.setInputFiles('#fileAudio', { name: 'diagmusic.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(MUSIC) });
  await page.waitForFunction(() => [...document.querySelectorAll('#timelineContainer .clip')].some(el => (el.getAttribute('aria-label') || '').includes('diagmusic')), {}, { timeout: 30000 });
  analyze('mp4 + music (mix, ducking off)', await doExport('mp4', 'exp-mp4-music.mp4'));
  await cleanup();
  await browser.close();
  server.kill();
})().catch(e => { console.error('DIAG-FAIL:', e.message); process.exit(1); });

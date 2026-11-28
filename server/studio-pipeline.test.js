const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStudioPipeline } = require('./studio-pipeline');
const { createApp } = require('./server');

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://example.org';

function makeFixtures(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vc-studio-${tag}-`));
  const vidPath = path.join(dir, 'clip.mp4');
  const wavPath = path.join(dir, 'tone.wav');
  const imgPath = path.join(dir, 'ref.jpg');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-y', vidPath,
  ]);
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-y', wavPath,
  ]);
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:size=320x180:d=0.1',
    '-frames:v', '1',
    '-y', imgPath,
  ]);
  return {
    dir,
    rawVid: fs.readFileSync(vidPath),
    rawWav: fs.readFileSync(wavPath),
    imageDataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64'),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function probeMp4(bytes, dir, name = 'out.mp4') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  const info = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', p]).toString()
  );
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(info.format?.duration || videoStream?.duration || 0),
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}

test('PromptAnalyzer & ScenePlanner cover English narration, genuine Telugu narration, silent/no-music prompts, and 30s/60s multi-scene planning', async () => {
  const pipeline = createStudioPipeline({ providers: {} });

  // Test 1: English narration prompt
  const enAnalysis = await pipeline.promptAnalyzer.analyze({
    prompt: 'Create a 15 second cinematic documentary video about Hyderabad Charminar at sunrise. Include natural English female narration welcoming travellers, warm acoustic flute music, and morning bird sound effects.',
    mode: 'text-to-video',
    aspectRatio: '16:9',
    durationSec: 15,
  });
  assert.equal(enAnalysis.narrationRequested, true);
  assert.equal(enAnalysis.narrationLanguage, 'en');
  assert.equal(enAnalysis.voiceGender, 'female');
  assert.equal(enAnalysis.musicRequested, true);
  assert.equal(enAnalysis.sfxRequested, true);
  assert.ok(enAnalysis.narrationScript.length > 10);

  // Test 2: Genuine Telugu narration prompt (must preserve Telugu script & language='te')
  const teAnalysis = await pipeline.promptAnalyzer.analyze({
    prompt: 'Create a 10 second peaceful temple sunrise video with natural Telugu female narration saying: "ఈ ఉదయం సూర్యోదయం మనసుకు ఎంతో ప్రశాంతతను ఇస్తుంది." Soft classical flute background music.',
    mode: 'text-to-video',
    aspectRatio: '16:9',
    durationSec: 10,
  });
  assert.equal(teAnalysis.narrationRequested, true);
  assert.equal(teAnalysis.narrationLanguage, 'te');
  assert.match(teAnalysis.narrationScript, /[\u0C00-\u0C7F]/, 'Telugu script preserved');

  // Test 4 & 5: Video without narration AND video without music
  const pureVisual = await pipeline.promptAnalyzer.analyze({
    prompt: 'Ocean waves crashing against black volcanic cliffs at golden hour, slow aerial drone shot, no music, without narration, natural wave sound effects only.',
    mode: 'text-to-video',
    aspectRatio: '21:9',
    durationSec: 10,
  });
  assert.equal(pureVisual.narrationRequested, false);
  assert.equal(pureVisual.musicRequested, false);
  assert.equal(pureVisual.sfxRequested, true);
  assert.equal(pureVisual.aspectRatio, '21:9');

  // Test 7 & 8: 30s and 60s multi-scene planning (never restricts to a single 6s clip)
  const plan30 = pipeline.scenePlanner.plan({ ...enAnalysis, requestedDurationSec: 30, targetSceneCount: 3 });
  assert.equal(plan30.scenes.length, 3);
  assert.equal(plan30.totalDurationSec, 30);
  assert.ok(plan30.scenes.every((s) => s.providerDurationSec >= 6 && s.providerDurationSec <= 15));

  const plan60 = pipeline.scenePlanner.plan({ ...enAnalysis, requestedDurationSec: 60, targetSceneCount: 6 });
  assert.equal(plan60.scenes.length, 6);
  assert.equal(plan60.totalDurationSec, 60);
});

test('Studio full pipeline executes Text-to-Video (9:16 & 16:9), Image-to-Video, Telugu TTS, 30s multi-scene stitching, and stem audio mastering', async () => {
  const fx = makeFixtures('pipeline');
  try {
    const calls = { video: [], tts: [], music: 0, sfx: 0 };
    const providers = {
      configured: { captions: false, isolation: false, videoGen: true, tts: true, musicGen: true, sfxGen: true },
      async generateVideo(opts) {
        calls.video.push(opts);
        return { bytes: fx.rawVid, mime: 'video/mp4', provider: 'LTX-Video' };
      },
      async synthesizeSpeech(opts) {
        calls.tts.push(opts);
        return { bytes: fx.rawWav, mime: 'audio/wav', provider: 'Edge-Neural-TTS' };
      },
      async generateMusic() {
        calls.music++;
        return { bytes: fx.rawWav, mime: 'audio/wav', provider: 'Stable-Audio' };
      },
      async generateVideoFoley() {
        calls.sfx++;
        return { bytes: fx.rawWav, mime: 'audio/wav', kind: 'audio', provider: 'MMAudio' };
      },
    };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-studio-srv-'));
    const server = createApp({ key: KEY, origin: ORIGIN, root, providers }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;

    try {
      // 1. Async Studio Job: 30-second vertical 9:16 multi-scene video with Telugu narration + music + SFX
      const startRes = await fetch(baseUrl + '/api/studio/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Create a 30 second 3-scene nature journey through lush waterfalls and misty hills. Add Telugu female narration: "ప్రకృతి ఒడిలో ప్రశాంతమైన ప్రయాణం." Include gentle cinematic flute music and waterfall sound effects.',
          mode: 'text-to-video',
          aspectRatio: '9:16',
          duration: 30,
        }),
      });
      assert.equal(startRes.status, 202);
      const { jobId } = await startRes.json();
      assert.ok(jobId);

      let job = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 150));
        job = await (await fetch(`${baseUrl}/api/studio/jobs/${jobId}`, {
          headers: { Authorization: 'Bearer ' + KEY },
        })).json();
        if (job.status === 'completed' || job.status === 'failed') break;
      }
      assert.equal(job.status, 'completed', job.error || 'job should complete');
      assert.equal(job.analysis.narrationLanguage, 'te');
      assert.equal(job.hasNarrationAudio, true);
      assert.equal(job.hasMusicAudio, true);
      assert.equal(job.hasSfxAudio, true);
      assert.ok(job.scenes.length >= 3, '30s video uses genuine multi-scene generation');
      assert.equal(calls.video.length, job.scenes.length, 'each scene calls AI video generation');
      assert.equal(calls.tts[0].language, 'te');

      const vidRes = await fetch(`${baseUrl}/api/studio/jobs/${jobId}/video`, {
        headers: { Authorization: 'Bearer ' + KEY },
      });
      assert.equal(vidRes.status, 200);
      const mp4Bytes = Buffer.from(await vidRes.arrayBuffer());
      const meta = probeMp4(mp4Bytes, fx.dir, 'vertical-30s.mp4');
      assert.equal(meta.hasVideo, true);
      assert.equal(meta.hasAudio, true);
      assert.ok(meta.height > meta.width, '9:16 vertical resolution rendered');
      assert.ok(meta.duration >= 27 && meta.duration <= 33, `expected ~30s duration, got ${meta.duration}s`);

      // Verify stem endpoints return real audio
      const narRes = await fetch(`${baseUrl}/api/studio/jobs/${jobId}/narration`, {
        headers: { Authorization: 'Bearer ' + KEY },
      });
      assert.equal(narRes.status, 200);
      assert.ok((await narRes.arrayBuffer()).byteLength > 200);

      // 2. Image-to-Video 16:9 without narration and without music
      const prevTtsCount = calls.tts.length;
      const prevMusicCount = calls.music;
      const syncRes = await fetch(baseUrl + '/api/studio/generate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + KEY,
          'Content-Type': 'application/json',
          'X-Upload-Consent': 'yes',
        },
        body: JSON.stringify({
          prompt: 'Slow cinematic zoom in on the subject with gentle wind sound effects, no music, no narration.',
          mode: 'image-to-video',
          aspectRatio: '16:9',
          duration: 6,
          imageDataUrl: fx.imageDataUrl,
        }),
      });
      assert.equal(syncRes.status, 200);
      assert.equal(calls.tts.length, prevTtsCount, 'TTS not called when narration not requested');
      assert.equal(calls.music, prevMusicCount, 'Music not called when user asks for no music');
      assert.ok(calls.video.at(-1).imageDataUrl?.startsWith('data:image/'), 'uploaded reference image passed to video generator');
      const i2vMeta = probeMp4(Buffer.from(await syncRes.arrayBuffer()), fx.dir, 'i2v-16x9.mp4');
      assert.ok(i2vMeta.width > i2vMeta.height, '16:9 landscape resolution rendered');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('Scene checkpointing preserves completed scenes on failed request retry and supports single-scene regeneration', async () => {
  const fx = makeFixtures('retry');
  try {
    let failScene2Once = true;
    const generatedScenePrompts = [];
    const providers = {
      configured: { captions: false, isolation: false, videoGen: true, tts: false, musicGen: false, sfxGen: false },
      async generateVideo(opts) {
        generatedScenePrompts.push(opts.prompt);
        if (failScene2Once && generatedScenePrompts.length === 2) {
          failScene2Once = false;
          throw new Error('Temporary upstream GPU timeout on scene 2');
        }
        return { bytes: fx.rawVid, mime: 'video/mp4', provider: 'LTX-Video' };
      },
    };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-studio-retry-'));
    const server = createApp({ key: KEY, origin: ORIGIN, root, providers }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;

    try {
    // Initial 14s (2-scene: ceil(14/7.5)=2) job fails on Scene 2 after completing Scene 1
      const r1 = await fetch(baseUrl + '/api/studio/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Two scene mountain timelapse from dawn to golden sunrise, silent, no music, no narration.',
          mode: 'text-to-video',
          aspectRatio: '16:9',
          duration: 14,
          sfxPreference: 'off',
          musicPreference: 'off',
          voicePreference: 'off',
        }),
      });
      const { jobId: failedJobId } = await r1.json();
      let st1 = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        st1 = await (await fetch(`${baseUrl}/api/studio/jobs/${failedJobId}`, {
          headers: { Authorization: 'Bearer ' + KEY },
        })).json();
        if (st1.status === 'failed' || st1.status === 'completed') break;
      }
      assert.equal(st1.status, 'failed');
      assert.deepEqual(st1.completedSceneNumbers, [1], 'Scene 1 preserved in checkpoint cache');
      assert.equal(generatedScenePrompts.length, 2);

      // Retry with resumeJobId -> must ONLY generate Scene 2 (1 provider call instead of 2!)
      const r2 = await fetch(baseUrl + '/api/studio/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Two scene mountain timelapse from dawn to golden sunrise, silent, no music, no narration.',
          mode: 'text-to-video',
          aspectRatio: '16:9',
          duration: 14,
          sfxPreference: 'off',
          musicPreference: 'off',
          voicePreference: 'off',
          resumeJobId: failedJobId,
        }),
      });
      const { jobId: resumedJobId } = await r2.json();
      let st2 = null;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 120));
        st2 = await (await fetch(`${baseUrl}/api/studio/jobs/${resumedJobId}`, {
          headers: { Authorization: 'Bearer ' + KEY },
        })).json();
        if (st2.status === 'completed' || st2.status === 'failed') break;
      }
      assert.equal(st2.status, 'completed', st2.error || 'resumed job completed');
      assert.equal(generatedScenePrompts.length, 3, 'Scene 1 reused from cache; only Scene 2 regenerated');

      // Single-scene regeneration of Scene 1 (index 0) while keeping Scene 2 cached
      const r3 = await fetch(baseUrl + '/api/studio/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Two scene mountain timelapse from dawn to golden sunrise, silent, no music, no narration.',
          mode: 'text-to-video',
          aspectRatio: '16:9',
          duration: 14,
          sfxPreference: 'off',
          musicPreference: 'off',
          voicePreference: 'off',
          resumeJobId: resumedJobId,
          regenerateSceneIndex: 0,
        }),
      });
      const { jobId: regenSceneJobId } = await r3.json();
      let st3 = null;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 120));
        st3 = await (await fetch(`${baseUrl}/api/studio/jobs/${regenSceneJobId}`, {
          headers: { Authorization: 'Bearer ' + KEY },
        })).json();
        if (st3.status === 'completed' || st3.status === 'failed') break;
      }
      assert.equal(st3.status, 'completed');
      assert.equal(generatedScenePrompts.length, 4, 'Only Scene 1 regenerated while Scene 2 remained cached');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fx.cleanup();
  }
});

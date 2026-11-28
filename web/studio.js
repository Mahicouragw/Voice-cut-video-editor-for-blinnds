/* VoiceCut Creative Studio: pure helpers & on-device canvas/WebCodecs media builders.
 * Shared by the browser and Node tests.
 * Supports:
 *  - Aspect ratio dimensions (16:9, 9:16, 1:1, 4:3, 4:5) & durations (4-15s+)
 *  - Prompt formatting for YouTube Thumbnails, Logos, Social Posts & Videos
 *  - Auto-timed narration subtitle cues (word-boundary safe via VoiceCutCaptions)
 *  - Audio-to-Video & Image-to-Video (Ken Burns motion + audio + burned-in captions -> MP4/WebM)
 *  - Video-to-Audio extraction (WAV/MP3-ready AudioBuffer extraction)
 */
(function (root) {
  'use strict';

  const ASPECT_RATIOS = {
    '16:9': { width: 1280, height: 720, label: 'Landscape 16:9 (YouTube, Desktop)' },
    '9:16': { width: 720, height: 1280, label: 'Portrait 9:16 (Shorts, Reels, TikTok)' },
    '1:1':  { width: 1080, height: 1080, label: 'Square 1:1 (Instagram, Logo, Feed)' },
    '4:3':  { width: 1024, height: 768, label: 'Standard 4:3 (Classic)' },
    '4:5':  { width: 864, height: 1080, label: 'Vertical 4:5 (Social Feed)' },
    '21:9': { width: 1344, height: 576, label: 'Cinematic Widescreen 21:9' },
  };

  function dimensionsForAspect(aspectRatio, maxSide) {
    const base = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['16:9'];
    const limit = Number(maxSide) || Math.max(base.width, base.height);
    const scale = limit / Math.max(base.width, base.height);
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    return { width: even(base.width * scale), height: even(base.height * scale) };
  }

  function buildImagePrompt(prompt, preset, titleText) {
    const clean = String(prompt || '').trim();
    if (!clean) throw new Error('Enter a prompt describing what you want to create.');
    const badge = String(titleText || '').trim();
    const note = badge ? ` Visual theme supporting headline "${badge}".` : '';
    if (preset === 'thumbnail') {
      return `High-contrast YouTube thumbnail background, expressive clear focal subject on rule-of-thirds, dramatic rim lighting, vibrant colors, clean negative space for title text, ultra-sharp: ${clean}.${note}`;
    }
    if (preset === 'logo') {
      return `Modern professional brand logo mark, clean minimalist vector icon centered on solid clean background, bold geometric silhouette, memorable emblem, scalable flat design: ${clean}.${note}`;
    }
    if (preset === 'social') {
      return `Polished social media graphic, eye-catching composition, rich studio lighting, crisp modern aesthetic: ${clean}.${note}`;
    }
    return clean;
  }

  // Build word-boundary-safe timed caption cues across [0, durationSec] from narration script.
  function cuesFromScript(scriptText, durationSec) {
    const text = String(scriptText || '').trim();
    const dur = Number(durationSec);
    if (!text || !Number.isFinite(dur) || dur <= 0) return [];
    const Captions = root.VoiceCutCaptions || (typeof require === 'function' ? require('./captions') : null);
    if (Captions && typeof Captions.splitSegmentToCues === 'function') {
      return Captions.splitSegmentToCues(0, Math.max(0.5, dur), text);
    }
    return [{ start: 0, end: Math.max(0.5, dur), text }];
  }

  // Draw an image (or stylized gradient backdrop) with optional gentle Ken Burns zoom/pan,
  // audio waveform bars, and optional title overlay (for thumbnails / logos / audio-to-video).
  function drawStudioFrame(ctx, width, height, opts) {
    const {
      image = null,
      progress = 0, // 0..1 across clip
      motion = 'zoomIn', // 'zoomIn' | 'zoomOut' | 'panRight' | 'still'
      title = '',
      subtitle = '',
      waveform = null, // Float32Array slice -1..1
      captionText = '',
      themeColor = '#7c5cff',
    } = opts || {};

    ctx.save();
    ctx.fillStyle = '#0d101b';
    ctx.fillRect(0, 0, width, height);

    if (image && (image.width || image.videoWidth || image.naturalWidth)) {
      const iw = image.naturalWidth || image.videoWidth || image.width;
      const ih = image.naturalHeight || image.videoHeight || image.height;
      const baseScale = Math.max(width / iw, height / ih);
      const p = Math.max(0, Math.min(1, Number(progress) || 0));
      let zoom = 1, panX = 0, panY = 0;
      if (motion === 'zoomIn') zoom = 1 + 0.08 * p;
      else if (motion === 'zoomOut') zoom = 1.08 - 0.08 * p;
      else if (motion === 'panRight') { zoom = 1.08; panX = (p - 0.5) * width * 0.05; }
      const dw = iw * baseScale * zoom;
      const dh = ih * baseScale * zoom;
      ctx.drawImage(image, (width - dw) / 2 + panX, (height - dh) / 2 + panY, dw, dh);
    } else {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#17192c');
      grad.addColorStop(0.55, '#1e1b38');
      grad.addColorStop(1, '#0f172a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      // Soft ambient glow circle
      const rad = ctx.createRadialGradient(width * 0.5, height * 0.42, width * 0.04, width * 0.5, height * 0.42, width * 0.48);
      rad.addColorStop(0, 'rgba(124,92,255,0.32)');
      rad.addColorStop(1, 'rgba(124,92,255,0)');
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, width, height);
    }

    // Optional audio waveform visualizer bars (for Audio-to-Video)
    if (waveform && waveform.length) {
      const bars = 36;
      const barAreaW = width * 0.68;
      const startX = (width - barAreaW) / 2;
      const step = barAreaW / bars;
      const baseY = height * (captionText ? 0.64 : 0.72);
      const maxBarH = height * 0.16;
      const samplesPerBar = Math.max(1, Math.floor(waveform.length / bars));
      ctx.fillStyle = themeColor || '#a48fff';
      for (let b = 0; b < bars; b++) {
        let sum = 0;
        for (let j = 0; j < samplesPerBar; j++) {
          sum += Math.abs(waveform[b * samplesPerBar + j] || 0);
        }
        const amp = Math.min(1, (sum / samplesPerBar) * 3.2);
        const bh = Math.max(4, amp * maxBarH);
        const bw = Math.max(3, step * 0.58);
        ctx.fillRect(startX + b * step, baseY - bh / 2, bw, bh);
      }
    }

    // Optional headline / thumbnail / audio title text (wrapped strictly on spaces)
    if (title) {
      const Captions = root.VoiceCutCaptions;
      const fontSize = Math.max(20, Math.round(Math.min(width, height) * 0.065));
      ctx.font = `800 ${fontSize}px system-ui, -apple-system, "Noto Sans Telugu", "Noto Sans Devanagari", sans-serif`;
      const maxW = width * 0.84;
      const lines = Captions?.linesFor ? Captions.linesFor(ctx, title, maxW) : [title];
      const lh = fontSize * 1.28;
      const startY = image ? height * 0.10 : height * 0.30;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      lines.slice(0, 3).forEach((line, idx) => {
        const y = startY + idx * lh;
        ctx.fillStyle = 'rgba(0,0,0,0.68)';
        const tw = Math.min(maxW + 28, ctx.measureText(line).width + 28);
        ctx.fillRect((width - tw) / 2, y - 6, tw, lh + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, width / 2, y, maxW);
      });
      if (subtitle) {
        const subSize = Math.max(14, Math.round(fontSize * 0.52));
        ctx.font = `600 ${subSize}px system-ui, -apple-system, sans-serif`;
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(subtitle, width / 2, startY + Math.min(3, lines.length) * lh + 12, maxW);
      }
    }

    if (captionText && root.VoiceCutCaptions?.draw) {
      root.VoiceCutCaptions.draw(ctx, captionText, width, height);
    }
    ctx.restore();
  }

  // Render an on-device MP4 (via WebCodecs + VoiceCutMuxer) or WebM fallback for Audio-to-Video
  // (converts an audio file + optional cover art + audio waveform into an editable MP4).
  async function renderAudioVisualizerVideo(options) {
    const {
      aspectRatio = '16:9',
      durationSec = 6,
      fps = 24,
      images = [], // Array of HTMLImageElement / ImageBitmap (can be empty for Audio-to-Video)
      audioBuffer = null, // Optional AudioBuffer
      cues = [], // Optional [{start,end,text}]
      title = '',
      subtitle = '',
      motion = 'zoomIn',
      showWaveform = false,
      onProgress = null,
    } = options || {};

    const dims = dimensionsForAspect(aspectRatio);
    const totalSec = Math.max(1, Math.min(600, Number(durationSec) || (audioBuffer ? audioBuffer.duration : 6)));
    const totalFrames = Math.max(1, Math.round(totalSec * fps));
    const frameUs = Math.round(1000000 / fps);

    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d');

    const sampleRate = audioBuffer ? audioBuffer.sampleRate : 48000;
    const totalAudioFrames = Math.max(1024, Math.round(totalSec * sampleRate));
    const ch0 = new Float32Array(totalAudioFrames);
    const ch1 = new Float32Array(totalAudioFrames);
    if (audioBuffer) {
      const src0 = audioBuffer.getChannelData(0);
      const src1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : src0;
      const copyLen = Math.min(totalAudioFrames, src0.length);
      ch0.set(src0.subarray(0, copyLen));
      ch1.set(src1.subarray(0, copyLen));
    }

    const canWebCodecs = typeof root.VideoEncoder === 'function' &&
      typeof root.AudioEncoder === 'function' &&
      typeof root.VideoFrame === 'function' &&
      typeof root.AudioData === 'function' &&
      root.VoiceCutMuxer?.WCMuxer;

    if (canWebCodecs) {
      const vCodec = dims.height > 720 ? 'avc1.42E028' : 'avc1.42E01E';
      const vSup = await root.VideoEncoder.isConfigSupported({
        codec: vCodec, width: dims.width, height: dims.height, bitrate: 4500000, framerate: fps,
      }).catch(() => ({ supported: false }));
      let aCodec = null;
      for (const cand of ['mp4a.40.2', 'opus']) {
        const sup = await root.AudioEncoder.isConfigSupported({
          codec: cand, sampleRate, numberOfChannels: 2, bitrate: 128000,
        }).catch(() => ({ supported: false }));
        if (sup.supported) { aCodec = cand; break; }
      }
      if (vSup.supported && aCodec) {
        const mux = new root.VoiceCutMuxer.WCMuxer({ fragmentUs: 1000000 });
        const parts = [];
        const drain = () => { for (const b of mux.takeBoxes()) parts.push(b); };
        let pendingV = null;
        const venc = new root.VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig?.description && !mux.videoCfg) {
              mux.setVideoConfig(dims.width, dims.height, new Uint8Array(meta.decoderConfig.description));
            }
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const cur = { ts: chunk.timestamp, key: chunk.type === 'key', data };
            if (pendingV) {
              mux.addVideoSample(pendingV.ts, Math.max(1, cur.ts - pendingV.ts), pendingV.key, pendingV.data);
              drain();
            }
            pendingV = cur;
          },
          error: (e) => { throw e; },
        });
        venc.configure({ codec: vCodec, width: dims.width, height: dims.height, bitrate: 4500000, framerate: fps, avc: { format: 'avc' } });

        const aenc = new root.AudioEncoder({
          output: (chunk, meta) => {
            if (!mux.audioCfg) {
              const desc = meta?.decoderConfig?.description;
              mux.setAudioConfig({
                codec: aCodec === 'mp4a.40.2' ? 'aac' : 'opus',
                sampleRate, channels: 2, bitrate: 128000,
                asc: desc ? new Uint8Array(desc) : null,
              });
            }
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            mux.addAudioSample(chunk.timestamp, chunk.duration || Math.round(1024 / sampleRate * 1000000), data);
            drain();
          },
          error: (e) => { throw e; },
        });
        aenc.configure({ codec: aCodec, sampleRate, numberOfChannels: 2, bitrate: 128000 });

        for (let fi = 0; fi < totalFrames; fi++) {
          const t = fi / fps;
          const img = images.length ? images[Math.min(images.length - 1, Math.floor((fi / totalFrames) * images.length))] : null;
          const segProgress = images.length > 1
            ? ((fi / totalFrames) * images.length) % 1
            : fi / Math.max(1, totalFrames - 1);
          const waveStart = Math.floor(t * sampleRate);
          const waveSlice = showWaveform ? ch0.subarray(waveStart, Math.min(ch0.length, waveStart + Math.floor(sampleRate / fps))) : null;
          const cap = cues.length && root.VoiceCutCaptions?.active ? root.VoiceCutCaptions.active(cues, t) : '';
          const motions = ['zoomIn', 'zoomOut', 'panRight'];
          const curMotion = motion === 'auto' ? motions[Math.floor((fi / totalFrames) * images.length) % motions.length] : motion;

          drawStudioFrame(ctx, dims.width, dims.height, {
            image: img, progress: segProgress, motion: curMotion,
            title, subtitle, waveform: waveSlice, captionText: cap,
          });
          const vf = new root.VideoFrame(canvas, { timestamp: fi * frameUs, duration: frameUs });
          venc.encode(vf, { keyFrame: fi % fps === 0 });
          vf.close();
          if (venc.encodeQueueSize > 30) await new Promise(r => setTimeout(r, 0));
          if (typeof onProgress === 'function' && (fi % 6 === 0 || fi === totalFrames - 1)) {
            onProgress(Math.round(((fi + 1) / totalFrames) * 85));
          }
        }

        const BLOCK = 1024;
        for (let off = 0, b = 0; off < totalAudioFrames; off += BLOCK, b++) {
          const buf = new Float32Array(BLOCK * 2);
          const take = Math.min(BLOCK, totalAudioFrames - off);
          buf.set(ch0.subarray(off, off + take), 0);
          buf.set(ch1.subarray(off, off + take), BLOCK);
          const ad = new root.AudioData({
            format: 'f32-planar', sampleRate, numberOfFrames: BLOCK,
            numberOfChannels: 2, timestamp: Math.round((b * BLOCK * 1000000) / sampleRate), data: buf.buffer,
          });
          aenc.encode(ad);
          ad.close();
          if (aenc.encodeQueueSize > 60) await new Promise(r => setTimeout(r, 0));
        }

        await venc.flush();
        await aenc.flush();
        venc.close();
        aenc.close();
        if (pendingV) {
          mux.addVideoSample(pendingV.ts, frameUs, pendingV.key, pendingV.data);
          pendingV = null;
        }
        drain();
        for (const bx of mux.finish()) parts.push(bx);
        const moov = parts.find(b => b.length > 8 && b[4] === 0x6d && b[5] === 0x6f && b[6] === 0x6f && b[7] === 0x76);
        if (moov) root.VoiceCutMuxer.patchMoovDurations(moov, mux.totalDurations());
        if (typeof onProgress === 'function') onProgress(100);
        return new Blob(parts, { type: 'video/mp4' });
      }
    }

    // Fallback: real-time MediaRecorder canvas + AudioContext stream for browsers without WebCodecs
    const stream = canvas.captureStream(fps);
    let actx = null, srcNode = null;
    if (audioBuffer && (root.AudioContext || root.webkitAudioContext)) {
      actx = new (root.AudioContext || root.webkitAudioContext)();
      const dest = actx.createMediaStreamDestination();
      srcNode = actx.createBufferSource();
      srcNode.buffer = audioBuffer;
      srcNode.connect(dest);
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    }
    const mime = root.MediaRecorder?.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const rec = new root.MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(250);
    if (srcNode) srcNode.start(0);
    const startWall = performance.now();
    while ((performance.now() - startWall) / 1000 < totalSec) {
      const elapsed = (performance.now() - startWall) / 1000;
      const p = Math.min(1, elapsed / totalSec);
      const img = images.length ? images[Math.min(images.length - 1, Math.floor(p * images.length))] : null;
      const cap = cues.length && root.VoiceCutCaptions?.active ? root.VoiceCutCaptions.active(cues, elapsed) : '';
      drawStudioFrame(ctx, dims.width, dims.height, { image: img, progress: p, motion, title, subtitle, captionText: cap });
      if (typeof onProgress === 'function') onProgress(Math.min(99, Math.round(p * 100)));
      await new Promise(r => setTimeout(r, Math.round(1000 / fps)));
    }
    rec.stop();
    await stopped;
    stream.getTracks().forEach(t => t.stop());
    if (actx) actx.close().catch(() => {});
    if (typeof onProgress === 'function') onProgress(100);
    return new Blob(chunks, { type: rec.mimeType || 'video/webm' });
  }

  // Client-side prompt analyzer (shared fallback when older backend lacks /api/studio/jobs)
  const CLIENT_LANG_RULES = [
    { code: 'te', words: /\b(telugu|తెలుగు)\b/i, script: /[\u0C00-\u0C7F]/ },
    { code: 'hi', words: /\b(hindi|हिन्दी|हिंदी)\b/i, script: /[\u0900-\u097F]/ },
    { code: 'ta', words: /\b(tamil|தமிழ்)\b/i, script: /[\u0B80-\u0BFF]/ },
    { code: 'kn', words: /\b(kannada|ಕನ್ನಡ)\b/i, script: /[\u0C80-\u0CFF]/ },
    { code: 'ml', words: /\b(malayalam|മലയാളം)\b/i, script: /[\u0D00-\u0D7F]/ },
    { code: 'mr', words: /\b(marathi|मराठी)\b/i, script: null },
    { code: 'bn', words: /\b(bengali|bangla|বাংলা)\b/i, script: /[\u0980-\u09FF]/ },
    { code: 'gu', words: /\b(gujarati|ગુજરાતી)\b/i, script: /[\u0A80-\u0AFF]/ },
    { code: 'ur', words: /\b(urdu|اردو)\b/i, script: null },
    { code: 'es', words: /\b(spanish|español)\b/i, script: null },
    { code: 'fr', words: /\b(french|français)\b/i, script: null },
    { code: 'de', words: /\b(german|deutsch)\b/i, script: null },
    { code: 'ar', words: /\b(arabic|العربية)\b/i, script: /[\u0600-\u06FF]/ },
    { code: 'zh', words: /\b(chinese|mandarin|中文)\b/i, script: /[\u4E00-\u9FFF]/ },
    { code: 'ja', words: /\b(japanese|日本語)\b/i, script: /[\u3040-\u30FF]/ },
    { code: 'ko', words: /\b(korean|한국어)\b/i, script: /[\uAC00-\uD7AF]/ },
  ];

  function analyzeCreativePromptLocally({
    prompt = '',
    mode = 'text-to-video',
    aspectRatio = '16:9',
    durationSec = 10,
    voiceLanguage = 'auto',
    voiceGender = 'auto',
    voiceStyle = 'auto',
    voicePreference = 'auto',
    musicPreference = 'auto',
    sfxPreference = 'auto',
  } = {}) {
    const text = String(prompt || '').trim();
    const dur = Math.max(4, Math.min(180, Math.round(Number(durationSec) || 10)));

    let lang = voiceLanguage && voiceLanguage !== 'auto' && voiceLanguage !== 'none' ? voiceLanguage : '';
    if (!lang) {
      for (const r of CLIENT_LANG_RULES) { if (r.words && r.words.test(text)) { lang = r.code; break; } }
    }
    if (!lang) {
      for (const r of CLIENT_LANG_RULES) { if (r.script && r.script.test(text)) { lang = r.code; break; } }
    }
    if (!lang) lang = 'en';

    let gender = voiceGender && voiceGender !== 'auto' ? voiceGender : '';
    if (!gender) {
      if (/\b(male|man|boy|gentleman|deep voice|baritone)\b|పురుష|पुरुष|ஆண்/i.test(text)) gender = 'male';
      else gender = 'female';
    }

    let style = voiceStyle && voiceStyle !== 'auto' ? voiceStyle : '';
    if (!style) {
      if (/\b(epic|heroic|legendary|grand|trailer|blockbuster)\b/i.test(text)) style = 'epic';
      else if (/\b(intense|urgent|fierce|powerful|thrilling|suspense|dramatic)\b/i.test(text)) style = 'intense';
      else if (/\b(sad|sadness|sorrow|somber|melanchol(?:y|ic)|grief|tragic|heartbreak)\b/i.test(text)) style = 'sad';
      else if (/\b(serious|grave|solemn|stern|authoritative)\b/i.test(text)) style = 'serious';
      else if (/\b(emotional|heartfelt|devotional|worship|touching|moving)\b/i.test(text)) style = 'emotional';
      else if (/\b(cinematic|film|movie)\b/i.test(text)) style = 'cinematic';
      else if (/\b(documentary|educational|informative|history)\b/i.test(text)) style = 'documentary';
      else if (/\b(professional|corporate|clear|news|presenter)\b/i.test(text)) style = 'professional';
      else if (/\b(storytelling|story|narrative|fable)\b/i.test(text)) style = 'storytelling';
      else if (/\b(calm|peaceful|serene|meditative|gentle|soothing)\b/i.test(text)) style = 'calm';
      else if (/\b(excited|energetic|inspiring|motivational|uplifting)\b/i.test(text)) style = 'excited';
      else style = 'auto';
    }

    const noNarration = voicePreference === 'off'
      || /\b(no\s+(?:voice|narration|voiceover|voice-over|speech|dialogue|talking)|without\s+(?:voice|narration|voiceover|voice-over|speech|talking)|silent\s+video|visuals?\s+only|instrumental\s+only|mute\s+voice)\b/i.test(text);
    const narrationRequested = !noNarration && (
      voicePreference === 'on'
      || /\b(narrat(?:e|ion|or)|voice[-\s]?over|voice\s+narration|male\s+voice|female\s+voice|speak(?:ing)?|explaining|explain\s+about|tell(?:ing)?\s+the\s+story|say(?:ing)?|monologue|dialogue|commentary)\b/i.test(text)
      || /(?:వివరిస్తూ|వాయిస్|కథనం|చెబుతూ|आवाज़|वर्णन|कहानी|குரல்|விவரிப்பு)/i.test(text)
    );

    const noMusic = musicPreference === 'off'
      || /\b(no\s+(?:background\s+)?music|without\s+(?:background\s+)?music|music[-\s]?free|no\s+soundtrack|no\s+bgm)\b/i.test(text);
    const musicRequested = !noMusic && (
      musicPreference === 'on'
      || /\b(music|soundtrack|score|bgm|orchestral|instrumental|melody|piano|flute|strings|violin|guitar|ambient\s+music|worship\s+video|devotional\s+music|peaceful\s+atmospheric\s+music|background\s+score)\b/i.test(text)
    );

    const noSfx = sfxPreference === 'off'
      || /\b(no\s+(?:sound\s+effects?|sfx|foley|ambient\s+sounds?)|without\s+(?:sound\s+effects?|sfx|ambient\s+sounds?)|completely\s+silent)\b/i.test(text);
    const sfxRequested = !noSfx && (
      sfxPreference === 'on'
      || /\b(sound\s+effects?|sfx|foley|ambient\s+sound|natural\s+sound|environmental\s+sound|birds?|wind|breeze|rain|thunder|waves?|ocean|water|river|waterfall|footsteps|fire|crowd|traffic)\b/i.test(text)
    );

    const cleanSubject = text
      .replace(/\b(add|include|with|featuring)\s+[^.;!\n]*?\b(narration|voice[-\s]?over|voice|background\s+music|sound\s+effects?|sfx)\b[^.;!\n]*([.;!]|$)/gi, ' ')
      .replace(/\b(no|without)\s+(?:background\s+)?(?:music|narration|voice[-\s]?over|sound\s+effects?)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || text;

    let narrationScript = '';
    if (narrationRequested) {
      const quoted = /["“”]([^"“”]{6,600})["“”]/.exec(text);
      const langRule = CLIENT_LANG_RULES.find(l => l.code === lang);
      if (quoted && (!langRule?.script || langRule.script.test(quoted[1]))) {
        narrationScript = quoted[1].trim();
      } else if (lang === 'te') {
        const teLines = [
          'ప్రకృతి అందాలను మరియు అద్భుతమైన దృశ్యాలను ఇప్పుడు మనం చూస్తున్నాము.',
          'ప్రతి దృశ్యం ప్రశాంతతను, సహజమైన జీవన సౌందర్యాన్ని కళ్ళకు కట్టినట్లు చూపిస్తుంది.',
          'ఈ మధురమైన వాతావరణం మనసుకు ఎంతో ఆనందాన్ని మరియు నూతన ఉత్సాహాన్ని అందిస్తుంది.',
          'ఈ అందమైన ప్రయాణంలో ప్రతి క్షణం ఒక మరపురాని అనుభూతిగా నిలిచిపోతుంది.',
        ];
        narrationScript = teLines.slice(0, Math.max(1, Math.min(teLines.length, Math.round(dur / 6)))).join(' ');
      } else if (lang === 'hi') {
        const hiLines = [
          'आइए इस सुंदर दृश्य और इसके शांत वातावरण का अनुभव करें।',
          'हर पल अपनी प्राकृतिक सुंदरता और गहरी भावनाओं के साथ जीवंत हो उठता है।',
          'यह यात्रा मन को सुकून और नई प्रेरणा से भर देती है।',
        ];
        narrationScript = hiLines.slice(0, Math.max(1, Math.min(hiLines.length, Math.round(dur / 6)))).join(' ');
      } else {
        const topic = cleanSubject
          .replace(/^(create|make|generate|produce|build)\s+(a|an|the)?\s*(\d+\s*(?:second|sec|s|minute|min)s?\s*)?/i, '')
          .replace(/\b(video|clip|film|footage)\s+(about|of|showing|on)\s+/i, '')
          .trim().slice(0, 140) || 'this story';
        const enByStyle = {
          epic: [
            `Across vast horizons, the legend of ${topic} rises with unstoppable power.`,
            `Every shadow and every spark builds toward a defining moment of destiny.`,
            `Witness a breathtaking journey forged in courage and awe.`,
          ],
          intense: [
            `Every second counts as ${topic} unfolds with gripping intensity.`,
            `Tension sharpens in every movement, driving straight toward the turning point.`,
            `Nothing holds back when the moment arrives.`,
          ],
          sad: [
            `In quiet reflection, memories of ${topic} linger softly in the stillness.`,
            `Each fleeting frame carries a gentle ache of time passing by.`,
            `Even in sorrow, beauty remains quietly unbroken.`,
          ],
          serious: [
            `Here is a focused look at ${topic}, where every detail carries weight and meaning.`,
            `Step by step, the reality of the moment comes clearly into view.`,
          ],
          emotional: [
            `Feel the heartfelt story of ${topic}, where light and emotion meet in harmony.`,
            `Every moment speaks gently to the spirit, leaving a lasting impression.`,
          ],
        };
        const pool = enByStyle[style] || [
          `Experience ${topic}, captured with rich atmosphere and cinematic detail.`,
          `Each scene unfolds smoothly, revealing the depth and beauty of the moment.`,
          `Every detail comes together in a vivid, memorable visual story.`,
          `Stay with this journey as light, motion, and sound unite seamlessly.`,
        ];
        narrationScript = pool.slice(0, Math.max(1, Math.min(pool.length, Math.round(dur / 6)))).join(' ');
      }
    }

    const idealClipSec = dur <= 10 ? dur : 8;
    const sceneCount = mode === 'image-to-video' && dur <= 12 && !/\b(multiple\s+scenes|next\s+scene|sequence)\b/i.test(text)
      ? 1
      : Math.max(1, Math.min(12, Math.ceil(dur / idealClipSec)));
    const perSceneSec = Number((dur / sceneCount).toFixed(2));
    const cameraArcs = [
      'establishing wide cinematic shot, smooth push-in camera motion',
      'fluid tracking medium shot following the main subject',
      'intimate close-up shot with shallow depth of field',
      'sweeping elevated camera glide revealing surrounding atmosphere',
    ];
    const scenes = Array.from({ length: sceneCount }, (_, i) => ({
      index: i,
      sceneNumber: i + 1,
      durationSec: perSceneSec,
      providerDurationSec: Math.max(5, Math.min(12, Math.ceil(perSceneSec))),
      cameraMovement: cameraArcs[i % cameraArcs.length],
      visualPrompt: sceneCount === 1
        ? `${cleanSubject}, ${cameraArcs[0]}, cinematic lighting, photorealistic`
        : `Scene ${i + 1} of ${sceneCount}: ${cleanSubject}. ${cameraArcs[i % cameraArcs.length]}, cohesive cinematic lighting`,
    }));

    return {
      analysis: {
        title: cleanSubject.split(/\s+/).slice(0, 5).join(' ').slice(0, 48) || 'AI Studio Video',
        mode,
        aspectRatio,
        requestedDurationSec: dur,
        narrationRequested,
        narrationLanguage: lang,
        voiceGender: gender,
        voiceStyle: style,
        narrationScript,
        musicRequested,
        musicPrompt: musicRequested ? `Instrumental cinematic background score matching: ${cleanSubject.slice(0, 180)}` : '',
        sfxRequested,
        sfxPrompt: sfxRequested ? `Realistic environmental sound effects for: ${cleanSubject.slice(0, 180)}` : '',
      },
      scenes,
    };
  }

  const api = {
    ASPECT_RATIOS,
    dimensionsForAspect,
    buildImagePrompt,
    cuesFromScript,
    drawStudioFrame,
    renderAudioVisualizerVideo,
    analyzeCreativePromptLocally,
  };
  root.VoiceCutStudio = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

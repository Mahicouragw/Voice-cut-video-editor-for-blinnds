'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ServiceError, VIDEO_SIZES } = require('./providers');

const LANGUAGE_PATTERNS = [
  { code: 'te', name: 'Telugu', script: /[\u0C00-\u0C7F]/, words: /\b(telugu)\b|తెలుగు/i },
  { code: 'hi', name: 'Hindi', script: /[\u0900-\u097F]/, words: /\b(hindi)\b|हिन्दी|हिंदी/i },
  { code: 'ta', name: 'Tamil', script: /[\u0B80-\u0BFF]/, words: /\b(tamil)\b|தமிழ்/i },
  { code: 'kn', name: 'Kannada', script: /[\u0C80-\u0CFF]/, words: /\b(kannada)\b|ಕನ್ನಡ/i },
  { code: 'ml', name: 'Malayalam', script: /[\u0D00-\u0D7F]/, words: /\b(malayalam)\b|മലയാളം/i },
  { code: 'mr', name: 'Marathi', script: null, words: /\b(marathi)\b|मराठी/i },
  { code: 'bn', name: 'Bengali', script: /[\u0980-\u09FF]/, words: /\b(bengali|bangla)\b|বাংলা/i },
  { code: 'ur', name: 'Urdu', script: null, words: /\b(urdu)\b|اردو/i },
  { code: 'gu', name: 'Gujarati', script: /[\u0A80-\u0AFF]/, words: /\b(gujarati)\b|ગુજરાતી/i },
  { code: 'pa', name: 'Punjabi', script: /[\u0A00-\u0A7F]/, words: /\b(punjabi)\b|ਪੰਜਾਬੀ/i },
  { code: 'es', name: 'Spanish', script: null, words: /\b(spanish|español|espanol)\b/i },
  { code: 'fr', name: 'French', script: null, words: /\b(french|français|francais)\b/i },
  { code: 'de', name: 'German', script: null, words: /\b(german|deutsch)\b/i },
  { code: 'ar', name: 'Arabic', script: /[\u0600-\u06FF]/, words: /\b(arabic)\b|العربية/i },
  { code: 'zh', name: 'Chinese', script: /[\u4E00-\u9FFF]/, words: /\b(chinese|mandarin)\b|中文/i },
  { code: 'ja', name: 'Japanese', script: /[\u3040-\u30FF]/, words: /\b(japanese)\b|日本語/i },
  { code: 'ko', name: 'Korean', script: /[\uAC00-\uD7AF]/, words: /\b(korean)\b|한국어/i },
  { code: 'pt', name: 'Portuguese', script: null, words: /\b(portuguese|português|portugues)\b/i },
  { code: 'ru', name: 'Russian', script: /[\u0400-\u04FF]/, words: /\b(russian)\b|русский/i },
  { code: 'en', name: 'English', script: null, words: /\b(english)\b/i },
];

const OUTPUT_RESOLUTIONS = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
  '4:5': { width: 720, height: 900 },
  '21:9': { width: 1280, height: 548 },
};

const ENV_SFX_KEYWORDS = [
  'rain', 'rainfall', 'thunder', 'storm', 'lightning', 'wind', 'breeze',
  'water', 'river', 'stream', 'waterfall', 'ocean', 'waves', 'sea',
  'birds', 'chirping', 'forest', 'jungle', 'nature sounds', 'ambient sound',
  'footsteps', 'fire', 'campfire', 'crackling', 'crowd', 'applause', 'traffic',
  'city sounds', 'space hum', 'whoosh', 'sound effect', 'sound effects', 'sfx', 'foley',
];

function runFfmpegBin(binary, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ServiceError(408, 'EXPIRED', 'Generation cancelled or expired.'));
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { if (stdout.length < 2 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 2 * 1024 * 1024) stderr += d; });
    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ServiceError(503, 'PROCESSOR_UNAVAILABLE', 'FFmpeg or FFprobe is unavailable on the server.'));
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new ServiceError(408, 'EXPIRED', 'Generation cancelled or expired.'));
      if (code !== 0) {
        return reject(new ServiceError(502, 'MEDIA_MASTERING_FAILED', `Video processing failed: ${stderr.slice(-280) || 'exit ' + code}`));
      }
      resolve(stdout.trim());
    });
  });
}

async function probeDuration(ffprobeBin, mediaPath, signal) {
  try {
    const out = await runFfmpegBin(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      mediaPath,
    ], signal);
    const val = Number(out);
    return Number.isFinite(val) && val > 0.05 ? val : 0;
  } catch {
    return 0;
  }
}

function extractJsonObject(raw) {
  const txt = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(txt);
  const candidate = fenced ? fenced[1].trim() : txt;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in response');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * 1. PromptAnalyzer
 * Analyzes natural-language creative instructions using connected LLM when configured
 * plus deterministic linguistic/intent verification so explicit user instructions
 * ("no narration", "without music", "Telugu female narration", etc.) are always honored.
 */
class PromptAnalyzer {
  constructor(providers) {
    this.providers = providers;
  }

  detectLanguage(prompt, overrideLang = 'auto') {
    if (overrideLang && overrideLang !== 'auto' && overrideLang !== 'none') {
      const hit = LANGUAGE_PATTERNS.find(l => l.code === overrideLang);
      return { code: overrideLang, name: hit ? hit.name : overrideLang };
    }
    const text = String(prompt || '');
    // Explicit language name in prompt takes highest priority (e.g. "Telugu narration", "in Hindi")
    for (const lang of LANGUAGE_PATTERNS) {
      if (lang.words && lang.words.test(text)) return { code: lang.code, name: lang.name };
    }
    // Native script detection
    for (const lang of LANGUAGE_PATTERNS) {
      if (lang.script && lang.script.test(text)) return { code: lang.code, name: lang.name };
    }
    return { code: 'en', name: 'English' };
  }

  detectVoiceCharacteristics(prompt, voiceGender = 'auto', voiceStyle = 'auto') {
    const text = String(prompt || '');
    let gender = voiceGender && voiceGender !== 'auto' ? voiceGender : null;
    if (!gender) {
      if (/\b(male|man|boy|gentleman|deep voice|baritone)\b|పురుష|पुरुष|ஆண்/i.test(text)) gender = 'male';
      else if (/\b(female|woman|girl|lady|soft female)\b|మహిళ|స్త్రీ|महिला|பெண்/i.test(text)) gender = 'female';
      else gender = 'female';
    }
    let style = voiceStyle && voiceStyle !== 'auto' ? voiceStyle : null;
    if (!style) {
      if (/\b(documentary|educational|informative)\b/i.test(text)) style = 'documentary';
      else if (/\b(emotional|heartfelt|devotional|worship|touching)\b/i.test(text)) style = 'emotional';
      else if (/\b(cinematic|epic|dramatic|trailer)\b/i.test(text)) style = 'cinematic';
      else if (/\b(professional|corporate|clear|news)\b/i.test(text)) style = 'professional';
      else if (/\b(storytelling|story|narrative)\b/i.test(text)) style = 'storytelling';
      else style = 'natural';
    }
    return { gender, style };
  }

  detectAudioIntents(prompt, options = {}) {
    const text = String(prompt || '');

    // Negative checks MUST win whenever explicitly stated
    const explicitNoNarration = /\b(no\s+(?:voice|narration|voiceover|voice-over|speech|dialogue|talking)|without\s+(?:voice|narration|voiceover|voice-over|speech|talking)|silent\s+video|visuals?\s+only|instrumental\s+only|mute\s+voice)\b/i.test(text)
      || options.voicePreference === 'off';
    const explicitWantNarration = !explicitNoNarration && (
      options.voicePreference === 'on'
      || /\b(narrat(?:e|ion|or)|voice[-\s]?over|voice\s+narration|male\s+voice|female\s+voice|speak(?:ing)?|explaining|explain\s+about|tell(?:ing)?\s+the\s+story|say(?:ing)?|monologue|dialogue|commentary)\b/i.test(text)
      || /(?:వివరిస్తూ|వాయిస్|కథనం|చెబుతూ|आवाज़|वर्णन|कहानी|குரல்|விவரிப்பு)/i.test(text)
    );

    const explicitNoMusic = /\b(no\s+(?:background\s+)?music|without\s+(?:background\s+)?music|music[-\s]?free|no\s+soundtrack|no\s+bgm)\b/i.test(text)
      || options.musicPreference === 'off';
    const explicitWantMusic = !explicitNoMusic && (
      options.musicPreference === 'on'
      || /\b(music|soundtrack|score|bgm|orchestral|instrumental|melody|piano|flute|strings|violin|guitar|ambient\s+music|worship\s+video|devotional\s+music|peaceful\s+atmospheric\s+music|background\s+score)\b/i.test(text)
    );

    const explicitNoSfx = /\b(no\s+(?:sound\s+effects?|sfx|foley|ambient\s+sounds?)|without\s+(?:sound\s+effects?|sfx|ambient\s+sounds?)|completely\s+silent)\b/i.test(text)
      || options.sfxPreference === 'off';
    const explicitWantSfx = !explicitNoSfx && (
      options.sfxPreference === 'on'
      || ENV_SFX_KEYWORDS.some(kw => text.toLowerCase().includes(kw))
      || /\b(realistic\s+\w+\s+sounds?|environmental\s+sounds?|natural\s+sounds?|appropriate\s+sound\s+effects?)\b/i.test(text)
    );

    return {
      narrationRequested: explicitWantNarration,
      explicitNoNarration,
      musicRequested: explicitWantMusic,
      explicitNoMusic,
      sfxRequested: explicitWantSfx,
      explicitNoSfx,
    };
  }

  cleanVisualSubject(prompt) {
    return String(prompt || '')
      .replace(/\b(add|include|with|featuring)\s+[^.;!\n]*?\b(narration|voice[-\s]?over|voice|background\s+music|sound\s+effects?|sfx)\b[^.;!\n]*([.;!]|$)/gi, ' ')
      .replace(/\b(no|without)\s+(?:background\s+)?(?:music|narration|voice[-\s]?over|sound\s+effects?)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || String(prompt || '').trim();
  }

  buildFallbackNarration(subject, langCode, targetDurationSec) {
    const cleanTopic = subject
      .replace(/^(create|make|generate|produce|build)\s+(a|an|the)?\s*/i, '')
      .replace(/\b(video|clip|film|footage)\s+(about|of|showing|on)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'this beautiful moment';

    const targetSentences = Math.max(1, Math.min(10, Math.round(targetDurationSec / 6)));
    const templates = {
      te: [
        `ప్రకృతి అందాలను మరియు అద్భుతమైన దృశ్యాలను ఇప్పుడు మనం చూస్తున్నాము.`,
        `ప్రతి దృశ్యం ప్రశాంతతను, సహజమైన జీవన సౌందర్యాన్ని కళ్ళకు కట్టినట్లు చూపిస్తుంది.`,
        `ఈ మధురమైన వాతావరణం మనసుకు ఎంతో ఆనందాన్ని మరియు నూతన ఉత్సాహాన్ని అందిస్తుంది.`,
        `సహజ కాంతి, సున్నితమైన కదలికలు ఈ క్షణాన్ని మరింత ప్రత్యేకంగా మారుస్తున్నాయి.`,
        `ఈ అందమైన ప్రయాణంలో ప్రతి క్షణం ఒక మరపురాని అనుభూతిగా నిలిచిపోతుంది.`,
        `ప్రకృతిలోని ఈ నిశ్శబ్ద సంగీతం హృదయానికి లోతైన ప్రశాంతతను కలిగిస్తుంది.`,
      ],
      hi: [
        `आइए इस सुंदर और जीवंत दृश्य की शांति का अनुभव करें।`,
        `हर एक पल प्रकृति और वातावरण की अद्भुत सुंदरता को दर्शाता है।`,
        `यह मनमोहक दृश्य मन को गहरी शांति और नई ऊर्जा प्रदान करता है।`,
        `रोशनी और गति का यह संगम इस कहानी को और भी खास बनाता है।`,
        `इस यात्रा का प्रत्येक दृश्य एक यादगार एहसास छोड़ जाता है।`,
      ],
      ta: [
        `இந்த அழகான மற்றும் அமைதியான காட்சியின் சிறப்பை இப்போது காண்போம்.`,
        `ஒவ்வொரு காட்சியும் இயற்கையின் உயிரோட்டமான அழகை வெளிப்படுத்துகிறது.`,
        `இந்த இனிமையான சூழல் மனதிற்கு ஆழ்ந்த அமைதியையும் மகிழ்ச்சியையும் தருகிறது.`,
        `ஒளியும் அசைவும் இணைந்து ஒரு மறக்க முடியாத அனுபவத்தை உருவாக்குகின்றன.`,
      ],
      kn: [
        `ಈ ಸುಂದರ ಮತ್ತು ಶಾಂತಿಯುತ ದೃಶ್ಯದ ಸೊಬಗನ್ನು ಈಗ ಸವಿಯೋಣ.`,
        `ಪ್ರತಿಯೊಂದು ಕ್ಷಣವೂ ಪ್ರಕೃತಿಯ ಸಹಜ ಸೌಂದರ್ಯವನ್ನು ಕಣ್ಣ ಮುಂದೆ ತರುತ್ತದೆ.`,
        `ಈ ಮನಮೋಹಕ ವಾತಾವರಣ ಮನಸ್ಸಿಗೆ ಆಳವಾದ ನೆಮ್ಮದಿಯನ್ನು ನೀಡುತ್ತದೆ.`,
      ],
      ml: [
        `ഈ മനോഹരവും ശാന്തവുമായ കാഴ്ചയുടെ ഭംഗി നമുക്ക് അനുഭവിച്ചറിയാം.`,
        `ഓരോ നിമിഷവും പ്രകൃതിയുടെ ജീവസ്സുറ്റ സൗಂದര്യം നമ്മളിലേക്ക് എത്തിക്കുന്നു.`,
        `ഈ അന്തരീക്ഷം മനസ്സിന് ആഴത്തിലുള്ള ശാന്തിയും സന്തോഷവും നൽകുന്നു.`,
      ],
      en: [
        `Experience ${cleanTopic}, captured with rich atmosphere and natural motion.`,
        `Every detail unfolds smoothly, revealing the depth, texture, and character of the scene.`,
        `Light, movement, and perspective come together in a calm, immersive visual journey.`,
        `As the perspective shifts, each new angle highlights the harmony and beauty of the environment.`,
        `Notice how subtle motion and surrounding details bring the entire moment to life.`,
        `From wide vistas to intimate close-ups, the story continues with clarity and grace.`,
      ],
    };
    const pool = templates[langCode] || templates.en;
    const picked = [];
    for (let i = 0; i < targetSentences; i++) {
      picked.push(pool[i % pool.length]);
    }
    return picked.join(' ');
  }

  async analyze({
    prompt,
    mode = 'text-to-video',
    aspectRatio = '16:9',
    durationSec = 10,
    voiceLanguage = 'auto',
    voiceGender = 'auto',
    voiceStyle = 'auto',
    voicePreference = 'auto',
    musicPreference = 'auto',
    sfxPreference = 'auto',
  }, signal) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) throw new ServiceError(400, 'EMPTY_PROMPT', 'Describe the video you want to create first.');

    const clampedDuration = Math.max(4, Math.min(180, Math.round(Number(durationSec) || 10)));
    const detectedLang = this.detectLanguage(cleanPrompt, voiceLanguage);
    const voiceChars = this.detectVoiceCharacteristics(cleanPrompt, voiceGender, voiceStyle);
    const intents = this.detectAudioIntents(cleanPrompt, { voicePreference, musicPreference, sfxPreference });

    // Determine target scene count based on requested duration and mode
    // Single clip up to ~8s; multi-scene genuine AI clips for longer durations (e.g. 15s -> 2, 30s -> 4, 60s -> 8, 90s -> 11, 120s -> 14)
    const idealClipSec = clampedDuration <= 8 ? clampedDuration : 7.5;
    const targetSceneCount = mode === 'image-to-video' && clampedDuration <= 10 && !/\b(multiple\s+scenes|next\s+scene|then\s+show|sequence)\b/i.test(cleanPrompt)
      ? 1
      : Math.max(1, Math.min(16, Math.ceil(clampedDuration / idealClipSec)));

    let llmPlan = null;
    if (typeof this.providers?.completeChat === 'function') {
      try {
        const wordsTarget = Math.max(12, Math.round(clampedDuration * 2.1));
        const sys = [
          'You are the AI Director and Prompt Intelligence Engine for VoiceCut Studio.',
          'Analyze the user creative video request and return ONLY a valid JSON object with this exact structure:',
          '{',
          '  "title": "Short 3-6 word project title",',
          '  "subject": "Main visual subject and story summary",',
          '  "visualStyle": "Consistent cinematography, lighting, lens, color palette, and character/subject continuity anchor",',
          '  "narrationRequested": boolean,',
          '  "narrationLanguage": "two-letter ISO code such as en, te, hi, ta, kn, ml, es, fr, ar, zh, ja, ko",',
          '  "voiceGender": "female" | "male",',
          '  "voiceStyle": "natural" | "cinematic" | "professional" | "emotional" | "documentary" | "storytelling",',
          '  "narrationScript": "If narrationRequested is true, write expressive, natural spoken narration STRICTLY in narrationLanguage script (for te use authentic Telugu script తెలుగు, for hi use Devanagari हिन्दी, for ta use Tamil தமிழ், etc. NEVER translate requested Telugu/Hindi/Tamil narration into English). Roughly ' + wordsTarget + ' words matching ' + clampedDuration + ' seconds. Empty string if narrationRequested is false.",',
          '  "musicRequested": boolean,',
          '  "musicPrompt": "If musicRequested is true, detailed instrumental soundtrack description (genre, mood, tempo, instruments, atmosphere, no vocals). Empty string if false.",',
          '  "sfxRequested": boolean,',
          '  "sfxPrompt": "If sfxRequested is true, realistic environmental Foley sound effects description (no speech, no music). Empty string if false.",',
          '  "transitionStyle": "fade" | "smoothleft" | "dissolve",',
          '  "scenes": [',
          '    {',
          '      "sceneNumber": 1,',
          '      "visualPrompt": "Detailed English visual generation prompt for this scene with subject, environment, lighting, camera movement, maintaining strict continuity with visualStyle. No text overlays.",',
          '      "cameraMovement": "Smooth camera motion description",',
          '      "sfxPrompt": "Scene-specific ambient sound effect",',
          '      "narrationSegment": "Portion of narration spoken during this scene (in narrationLanguage)"',
          '    }',
          '  ]',
          '}',
          `Plan exactly ${targetSceneCount} scene(s) totaling ${clampedDuration} seconds for ${aspectRatio} (${mode}).`,
          'CRITICAL RULES:',
          '- Follow the user prompt faithfully. Do NOT force narration if the user did not ask for narration/voice/explanation.',
          '- Do NOT force music if the user asked for no music or only natural sounds.',
          '- If the user asks for Telugu narration, narrationLanguage MUST be "te" and narrationScript MUST be written in Telugu Unicode script (తెలుగు), NEVER English.',
        ].join('\n');

        const llmRes = await this.providers.completeChat({
          systemPrompt: sys,
          userPrompt: `User Creative Prompt:\n${cleanPrompt}\n\nMode: ${mode}\nAspect Ratio: ${aspectRatio}\nRequested Duration: ${clampedDuration} seconds\nDetected Language Hint: ${detectedLang.code} (${detectedLang.name})`,
          jsonMode: true,
        }, signal);
        llmPlan = extractJsonObject(llmRes.text);
        llmPlan._plannerProvider = llmRes.provider;
      } catch (e) {
        if (signal?.aborted) throw e;
        llmPlan = null;
      }
    }

    // Merge LLM intelligence with deterministic user-intent guardrails
    const narrationRequested = intents.explicitNoNarration
      ? false
      : (intents.narrationRequested || Boolean(llmPlan?.narrationRequested));

    const musicRequested = intents.explicitNoMusic
      ? false
      : (intents.musicRequested || Boolean(llmPlan?.musicRequested));

    const sfxRequested = intents.explicitNoSfx
      ? false
      : (intents.sfxRequested || Boolean(llmPlan?.sfxRequested));

    const finalLangCode = (voiceLanguage && voiceLanguage !== 'auto' && voiceLanguage !== 'none')
      ? voiceLanguage
      : (detectedLang.code !== 'en' ? detectedLang.code : (llmPlan?.narrationLanguage || detectedLang.code || 'en')).slice(0, 2).toLowerCase();

    const finalGender = (voiceGender && voiceGender !== 'auto')
      ? voiceGender
      : (llmPlan?.voiceGender === 'male' || llmPlan?.voiceGender === 'female' ? llmPlan.voiceGender : voiceChars.gender);

    const finalStyle = (voiceStyle && voiceStyle !== 'auto')
      ? voiceStyle
      : (llmPlan?.voiceStyle || voiceChars.style);

    const cleanSubject = this.cleanVisualSubject(cleanPrompt);
    const visualStyle = String(llmPlan?.visualStyle || 'cinematic natural lighting, photorealistic detail, smooth camera motion, cohesive color grading').trim();

    // Validate narration script language (if user asked for Telugu/Hindi/Tamil/etc., ensure native script is used!)
    let narrationScript = narrationRequested ? String(llmPlan?.narrationScript || '').trim() : '';
    const langRule = LANGUAGE_PATTERNS.find(l => l.code === finalLangCode);
    if (narrationRequested) {
      const scriptMismatch = langRule?.script && narrationScript && !langRule.script.test(narrationScript);
      if (!narrationScript || scriptMismatch) {
        // If user wrote native-script text inside quotes in the prompt, use it; otherwise synthesize authentic script narration
        const quoted = /["“”]([^"“”]{8,600})["“”]/.exec(cleanPrompt);
        if (quoted && (!langRule?.script || langRule.script.test(quoted[1]))) {
          narrationScript = quoted[1].trim();
        } else {
          narrationScript = this.buildFallbackNarration(cleanSubject, finalLangCode, clampedDuration);
        }
      }
    }

    const musicPrompt = musicRequested
      ? String(llmPlan?.musicPrompt || `Cinematic ${finalStyle} instrumental background music matching: ${cleanSubject.slice(0, 220)}, smooth atmosphere, no vocals`).trim()
      : '';

    const sfxPrompt = sfxRequested
      ? String(llmPlan?.sfxPrompt || `Realistic environmental Foley soundscape matching: ${cleanSubject.slice(0, 220)}, natural stereo ambience`).trim()
      : '';

    return {
      mode,
      originalPrompt: cleanPrompt,
      title: String(llmPlan?.title || cleanSubject.split(/[,.!?]/)[0].slice(0, 48) || 'AI Studio Video').trim(),
      subject: String(llmPlan?.subject || cleanSubject).trim(),
      visualStyle,
      aspectRatio: OUTPUT_RESOLUTIONS[aspectRatio] ? aspectRatio : '16:9',
      requestedDurationSec: clampedDuration,
      targetSceneCount,
      narrationRequested,
      narrationLanguage: finalLangCode,
      voiceGender: finalGender,
      voiceStyle: finalStyle,
      narrationScript,
      musicRequested,
      musicPrompt,
      sfxRequested,
      sfxPrompt,
      transitionStyle: ['fade', 'smoothleft', 'dissolve'].includes(llmPlan?.transitionStyle) ? llmPlan.transitionStyle : 'fade',
      rawScenes: Array.isArray(llmPlan?.scenes) ? llmPlan.scenes : [],
      plannerProvider: llmPlan?._plannerProvider || 'VoiceCut Prompt Intelligence',
    };
  }
}

/**
 * 2. ScenePlanner
 * Divides requested duration into genuine AI scenes with visual continuity anchors,
 * camera progression, and per-scene duration targets.
 */
class ScenePlanner {
  plan(analysis) {
    const count = Math.max(1, Math.min(16, Number(analysis.targetSceneCount) || 1));
    const totalSec = analysis.requestedDurationSec;
    const transitionOverlap = count > 1 ? 0.35 : 0;
    // Account for xfade overlap so assembled output matches totalSec closely
    const perSceneSec = Number(((totalSec + (count - 1) * transitionOverlap) / count).toFixed(2));

    const cameraArcs = [
      'establishing wide cinematic shot, slow push-in camera movement',
      'smooth tracking medium shot following the main subject with natural parallax',
      'intimate close-up detail shot with shallow depth of field and gentle motion',
      'sweeping elevated camera glide revealing surrounding environment and atmosphere',
      'dynamic low-angle pan with rich atmospheric lighting and realistic motion',
      'serene pullback wide shot bringing the visual story together harmoniously',
    ];

    const sentenceParts = analysis.originalPrompt
      .split(/(?<=[.!?।॥])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 8 && !/^(add|include)\s+(natural\s+)?[a-z]+\s+(female|male)?\s*narration/i.test(s));

    const scenes = [];
    for (let i = 0; i < count; i++) {
      const llmScene = analysis.rawScenes[i] || null;
      const camera = String(llmScene?.cameraMovement || cameraArcs[i % cameraArcs.length]).trim();
      let visualPrompt = String(llmScene?.visualPrompt || '').trim();
      if (!visualPrompt) {
        const beat = sentenceParts.length > 1
          ? sentenceParts[i % sentenceParts.length]
          : analysis.subject;
        visualPrompt = count === 1
          ? `${analysis.subject}, ${camera}, ${analysis.visualStyle}`
          : `Scene ${i + 1} of ${count}: ${beat}. ${camera}. Continuity style: ${analysis.visualStyle}`;
      } else if (!visualPrompt.toLowerCase().includes(analysis.visualStyle.slice(0, 18).toLowerCase())) {
        visualPrompt = `${visualPrompt}. ${analysis.visualStyle}`;
      }

      scenes.push({
        index: i,
        sceneNumber: i + 1,
        durationSec: perSceneSec,
        providerDurationSec: Math.max(4, Math.min(15, Math.ceil(perSceneSec))),
        visualPrompt: visualPrompt.slice(0, 1750),
        cameraMovement: camera,
        sfxPrompt: String(llmScene?.sfxPrompt || analysis.sfxPrompt || '').trim(),
        useUploadedImage: analysis.mode === 'image-to-video' && i === 0,
        continueFromPreviousFrame: i > 0,
      });
    }

    return {
      totalDurationSec: totalSec,
      transitionOverlapSec: transitionOverlap,
      transitionStyle: analysis.transitionStyle || 'fade',
      scenes,
    };
  }
}

/**
 * 3. ImageGenerationService
 */
class ImageGenerationService {
  constructor(providers) {
    this.providers = providers;
  }

  async generateReferenceImage({ prompt, aspectRatio, preset = 'general' }, signal) {
    return this.providers.generateImage({ prompt, aspectRatio, preset, model: 'auto' }, signal);
  }
}

/**
 * 4. VideoGenerationService
 * Generates genuine AI motion clips per scene and maintains visual continuity across
 * multi-scene long videos by extracting the final frame of Scene N to guide Scene N+1
 * when appropriate or generating cohesive continuity-anchored scenes.
 */
class VideoGenerationService {
  constructor(providers, ffmpegBin = 'ffmpeg') {
    this.providers = providers;
    this.ffmpegBin = ffmpegBin;
  }

  async extractLastFrameDataUrl(videoPath, workdir, idx, signal) {
    const framePath = path.join(workdir, `scene-${idx}-last.jpg`);
    try {
      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error',
        '-sseof', '-0.15',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '3',
        '-y', framePath,
      ], signal);
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 200) {
        const b64 = fs.readFileSync(framePath).toString('base64');
        return `data:image/jpeg;base64,${b64}`;
      }
    } catch {}
    return null;
  }

  async generateScenes({ plan, analysis, initialImageDataUrl, workdir, sceneCache = null, regenerateSceneIndex = null, onProgress }, signal) {
    const generatedScenes = [];
    let continuityFrameDataUrl = initialImageDataUrl || null;

    for (let i = 0; i < plan.scenes.length; i++) {
      signal?.throwIfAborted();
      const scene = plan.scenes[i];

      // Reuse already-completed scene bytes when retrying after a partial failure or regenerating a single scene!
      const cached = sceneCache?.get?.(i);
      const shouldReuse = cached?.bytes?.length > 100 && (regenerateSceneIndex === null ? true : i !== regenerateSceneIndex);

      if (shouldReuse) {
        const rawPath = path.join(workdir, `scene-raw-${i}.mp4`);
        fs.writeFileSync(rawPath, cached.bytes);
        if (i < plan.scenes.length - 1 && analysis.mode === 'image-to-video') {
          const nextFrame = await this.extractLastFrameDataUrl(rawPath, workdir, i, signal);
          if (nextFrame) continuityFrameDataUrl = nextFrame;
        }
        generatedScenes.push({
          ...scene,
          rawPath,
          bytes: cached.bytes,
          provider: cached.provider || 'Cached-AI-Scene',
        });
        continue;
      }

      onProgress?.({
        stage: 'visuals',
        label: plan.scenes.length > 1
          ? `Generating AI Visuals (Scene ${i + 1} of ${plan.scenes.length})`
          : 'Generating AI Visuals',
        sceneIndex: i,
        sceneCount: plan.scenes.length,
      });

      const useImage = (i === 0 && initialImageDataUrl)
        ? initialImageDataUrl
        : (analysis.mode === 'image-to-video' && continuityFrameDataUrl ? continuityFrameDataUrl : null);

      const res = await this.providers.generateVideo({
        prompt: scene.visualPrompt,
        aspectRatio: analysis.aspectRatio,
        duration: scene.providerDurationSec,
        imageDataUrl: useImage,
        model: 'auto',
      }, signal);

      if (!res?.bytes || res.bytes.length < 100) {
        throw new ServiceError(502, 'BAD_VIDEO_RESPONSE', `AI video provider returned empty media for scene ${i + 1}.`);
      }

      const rawPath = path.join(workdir, `scene-raw-${i}.mp4`);
      fs.writeFileSync(rawPath, res.bytes);
      sceneCache?.set?.(i, { bytes: res.bytes, provider: res.provider || 'AI-Video' });

      if (i < plan.scenes.length - 1 && analysis.mode === 'image-to-video') {
        const nextFrame = await this.extractLastFrameDataUrl(rawPath, workdir, i, signal);
        if (nextFrame) continuityFrameDataUrl = nextFrame;
      }

      generatedScenes.push({
        ...scene,
        rawPath,
        bytes: res.bytes,
        provider: res.provider || 'AI-Video',
      });
    }

    return generatedScenes;
  }
}

/**
 * 5. VoiceGenerationService
 */
class VoiceGenerationService {
  constructor(providers) {
    this.providers = providers;
  }

  async generate({ analysis, workdir, onProgress }, signal) {
    if (!analysis.narrationRequested || !analysis.narrationScript || !this.providers.synthesizeSpeech) {
      return null;
    }
    onProgress?.({ stage: 'narration', label: 'Generating Voice Narration' });
    const res = await this.providers.synthesizeSpeech({
      text: analysis.narrationScript,
      language: analysis.narrationLanguage || 'en',
      gender: analysis.voiceGender || 'female',
      model: 'auto',
    }, signal);
    if (!res?.bytes || res.bytes.length < 100) return null;
    const ext = (res.mime || '').includes('wav') ? 'wav' : 'mp3';
    const rawPath = path.join(workdir, `narration-raw.${ext}`);
    fs.writeFileSync(rawPath, res.bytes);
    return {
      rawPath,
      bytes: res.bytes,
      mime: res.mime || 'audio/mpeg',
      provider: res.provider || 'Neural-TTS',
      language: analysis.narrationLanguage,
      script: analysis.narrationScript,
    };
  }
}

/**
 * 6. MusicGenerationService
 */
class MusicGenerationService {
  constructor(providers) {
    this.providers = providers;
  }

  async generate({ analysis, targetDurationSec, workdir, onProgress }, signal) {
    if (!analysis.musicRequested || !this.providers.generateMusic) return null;
    onProgress?.({ stage: 'music', label: 'Generating Background Music' });
    // Generate enough authentic musical material (up to 60s per pass, or 2 passes for 90-120s videos)
    const firstDur = Math.min(60, Math.max(8, Math.ceil(targetDurationSec)));
    const res = await this.providers.generateMusic({
      prompt: analysis.musicPrompt,
      duration: firstDur,
      model: 'auto',
    }, signal);
    if (!res?.bytes || res.bytes.length < 100) return null;
    const rawPath = path.join(workdir, 'music-raw-0.audio');
    fs.writeFileSync(rawPath, res.bytes);
    const paths = [rawPath];

    if (targetDurationSec > 55) {
      try {
        const res2 = await this.providers.generateMusic({
          prompt: `${analysis.musicPrompt}, seamless continuation movement`,
          duration: Math.min(60, Math.max(15, Math.ceil(targetDurationSec - 45))),
          model: 'auto',
        }, signal);
        if (res2?.bytes?.length > 100) {
          const p2 = path.join(workdir, 'music-raw-1.audio');
          fs.writeFileSync(p2, res2.bytes);
          paths.push(p2);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }

    return {
      rawPaths: paths,
      bytes: res.bytes,
      mime: res.mime || 'audio/wav',
      provider: res.provider || 'AI-Music',
    };
  }
}

/**
 * 7. SoundEffectsService
 */
class SoundEffectsService {
  constructor(providers) {
    this.providers = providers;
  }

  async generate({ analysis, generatedScenes, targetDurationSec, workdir, onProgress }, signal) {
    if (!analysis.sfxRequested || !this.providers.generateVideoFoley) return null;
    onProgress?.({ stage: 'sfx', label: 'Creating Sound Effects' });
    const firstClipBytes = generatedScenes[0]?.bytes || null;
    const res = await this.providers.generateVideoFoley({
      videoBytes: targetDurationSec <= 15 ? firstClipBytes : null,
      prompt: analysis.sfxPrompt || generatedScenes[0]?.sfxPrompt || analysis.subject,
      duration: Math.min(45, Math.max(6, Math.ceil(targetDurationSec))),
      model: 'auto',
    }, signal);
    if (!res?.bytes || res.bytes.length < 100) return null;
    const rawPath = path.join(workdir, res.kind === 'video-with-audio' ? 'sfx-raw.mp4' : 'sfx-raw.audio');
    fs.writeFileSync(rawPath, res.bytes);
    return {
      rawPath,
      kind: res.kind || 'audio',
      provider: res.provider || 'Scene-SFX',
    };
  }
}

/**
 * 8. VideoRenderingService
 * Normalizes each generated AI scene to exact target resolution, aspect ratio, frame rate,
 * and scene timing (using gentle natural motion pacing within bounds—never extreme stretching
 * or clip duplication) and applies smooth crossfade transitions across multi-scene timelines.
 */
class VideoRenderingService {
  constructor(ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe') {
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
  }

  async assembleVisualTimeline({ generatedScenes, plan, aspectRatio, targetDurationSec, workdir, onProgress }, signal) {
    onProgress?.({ stage: 'assembling', label: 'Assembling Final Video' });
    const outDims = OUTPUT_RESOLUTIONS[aspectRatio] || VIDEO_SIZES[aspectRatio] || OUTPUT_RESOLUTIONS['16:9'];
    const w = outDims.width;
    const h = outDims.height;

    const normalizedPaths = [];
    const normalizedDurations = [];
    const sceneCount = generatedScenes.length;
    const overlap = sceneCount > 1 ? plan.transitionOverlapSec : 0;
    const perSceneTarget = (targetDurationSec + (sceneCount - 1) * overlap) / sceneCount;

    for (let i = 0; i < sceneCount; i++) {
      signal?.throwIfAborted();
      const scene = generatedScenes[i];
      const rawDur = (await probeDuration(this.ffprobeBin, scene.rawPath, signal)) || scene.providerDurationSec || 5;
      // Gently pace clip to match its planned scene slot (clamped between 0.5x and 1.85x so motion stays fluid)
      const factor = Math.max(0.55, Math.min(1.85, perSceneTarget / Math.max(0.5, rawDur)));
      const expectedSceneDur = Math.min(perSceneTarget, rawDur * factor);
      const normPath = path.join(workdir, `scene-norm-${i}.mp4`);

      const vf = [
        `scale=${w}:${h}:force_original_aspect_ratio=increase`,
        `crop=${w}:${h}`,
        `setpts=${factor.toFixed(4)}*PTS`,
        'fps=24',
        'format=yuv420p',
      ].join(',');

      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error', '-threads', '2',
        '-i', scene.rawPath,
        '-an',
        '-vf', vf,
        '-t', perSceneTarget.toFixed(3),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21',
        '-y', normPath,
      ], signal);

      const actualDur = (await probeDuration(this.ffprobeBin, normPath, signal)) || expectedSceneDur;
      normalizedPaths.push(normPath);
      normalizedDurations.push(actualDur);
    }

    if (normalizedPaths.length === 1) {
      return {
        visualPath: normalizedPaths[0],
        visualDurationSec: normalizedDurations[0],
        width: w,
        height: h,
      };
    }

    // Multi-scene assembly with smooth xfade transitions
    const assembledPath = path.join(workdir, 'visual-assembled.mp4');
    const transition = ['fade', 'smoothleft', 'dissolve'].includes(plan.transitionStyle) ? plan.transitionStyle : 'fade';
    const ffArgs = ['-nostdin', '-v', 'error', '-threads', '2'];
    normalizedPaths.forEach(p => ffArgs.push('-i', p));

    const filters = [];
    let currentLabel = '[0:v]';
    let timelineDur = normalizedDurations[0];

    for (let i = 1; i < normalizedPaths.length; i++) {
      const xfadeDur = Math.min(overlap, normalizedDurations[i - 1] * 0.35, normalizedDurations[i] * 0.35);
      const offset = Math.max(0.05, timelineDur - xfadeDur);
      const outLabel = i === normalizedPaths.length - 1 ? '[vfinal]' : `[vx${i}]`;
      filters.push(`${currentLabel}[${i}:v]xfade=transition=${transition}:duration=${xfadeDur.toFixed(3)}:offset=${offset.toFixed(3)}${outLabel}`);
      currentLabel = outLabel;
      timelineDur = offset + normalizedDurations[i];
    }

    ffArgs.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-y', assembledPath
    );

    try {
      await runFfmpegBin(this.ffmpegBin, ffArgs, signal);
    } catch {
      // Fallback to clean concat demuxer if xfade filter version differs
      const listPath = path.join(workdir, 'scenes.txt');
      fs.writeFileSync(listPath, normalizedPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-y', assembledPath,
      ], signal);
      timelineDur = normalizedDurations.reduce((a, b) => a + b, 0);
    }

    const probed = await probeDuration(this.ffprobeBin, assembledPath, signal);
    return {
      visualPath: assembledPath,
      visualDurationSec: probed > 0.2 ? probed : timelineDur,
      width: w,
      height: h,
    };
  }
}

/**
 * 9. AudioVideoSynchronizer & 10. ExportService
 * Normalizes voice narration, background music, and environmental sound effects,
 * applies automatic voice-priority ducking (`sidechaincompress` / balanced stems),
 * anti-clipping limiter, smooth fade-in/fade-out, and exports synchronized MP4 (`+faststart`).
 */
class AudioVideoSynchronizer {
  constructor(ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe') {
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
  }

  async prepareStems({ voice, music, sfx, visualDurationSec, workdir, onProgress }, signal) {
    onProgress?.({ stage: 'syncing', label: 'Synchronizing Audio and Video' });
    let finalDurationSec = visualDurationSec;
    let voiceWav = null;
    let voiceDurationSec = 0;

    if (voice?.rawPath) {
      voiceWav = path.join(workdir, 'stem-voice.wav');
      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error',
        '-i', voice.rawPath,
        '-vn', '-ac', '2', '-ar', '48000',
        '-af', 'highpass=f=70,acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180,alimiter=limit=0.95',
        '-y', voiceWav,
      ], signal);
      voiceDurationSec = await probeDuration(this.ffprobeBin, voiceWav, signal);
      // If narration slightly exceeds visual clip, let final duration accommodate full spoken sentence cleanly
      if (voiceDurationSec > finalDurationSec) {
        finalDurationSec = Math.min(voiceDurationSec + 0.25, visualDurationSec * 1.35 + 2);
      }
    }

    let musicWav = null;
    if (music?.rawPaths?.length) {
      musicWav = path.join(workdir, 'stem-music.wav');
      if (music.rawPaths.length > 1) {
        const concatRaw = path.join(workdir, 'music-joined.wav');
        await runFfmpegBin(this.ffmpegBin, [
          '-nostdin', '-v', 'error',
          '-i', music.rawPaths[0],
          '-i', music.rawPaths[1],
          '-filter_complex', '[0:a]aresample=48000,aformat=channel_layouts=stereo[m0];[1:a]aresample=48000,aformat=channel_layouts=stereo[m1];[m0][m1]acrossfade=d=1.5:c1=tri:c2=tri[mout]',
          '-map', '[mout]',
          '-y', concatRaw,
        ], signal).catch(async () => {
          fs.copyFileSync(music.rawPaths[0], concatRaw);
        });
        await runFfmpegBin(this.ffmpegBin, [
          '-nostdin', '-v', 'error',
          '-stream_loop', '-1', '-i', concatRaw,
          '-vn', '-ac', '2', '-ar', '48000',
          '-t', finalDurationSec.toFixed(3),
          '-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, finalDurationSec - 1.2).toFixed(3)}:d=1.2`,
          '-y', musicWav,
        ], signal);
      } else {
        await runFfmpegBin(this.ffmpegBin, [
          '-nostdin', '-v', 'error',
          '-stream_loop', '-1', '-i', music.rawPaths[0],
          '-vn', '-ac', '2', '-ar', '48000',
          '-t', finalDurationSec.toFixed(3),
          '-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, finalDurationSec - 1.2).toFixed(3)}:d=1.2`,
          '-y', musicWav,
        ], signal);
      }
    }

    let sfxWav = null;
    if (sfx?.rawPath) {
      sfxWav = path.join(workdir, 'stem-sfx.wav');
      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error',
        '-stream_loop', '-1', '-i', sfx.rawPath,
        '-vn', '-ac', '2', '-ar', '48000',
        '-t', finalDurationSec.toFixed(3),
        '-af', `afade=t=in:st=0:d=0.35,afade=t=out:st=${Math.max(0, finalDurationSec - 0.8).toFixed(3)}:d=0.8`,
        '-y', sfxWav,
      ], signal);
    }

    return {
      voiceWav,
      voiceDurationSec,
      musicWav,
      sfxWav,
      finalDurationSec,
    };
  }
}

class ExportService {
  constructor(ffmpegBin = 'ffmpeg') {
    this.ffmpegBin = ffmpegBin;
  }

  async renderMasterMp4({ visualPath, visualDurationSec, stems, workdir, onProgress }, signal) {
    onProgress?.({ stage: 'exporting', label: 'Preparing Download' });
    const finalDur = stems.finalDurationSec || visualDurationSec;
    const outPath = path.join(workdir, 'studio-master.mp4');

    const activeStems = [];
    if (stems.voiceWav) activeStems.push({ type: 'voice', path: stems.voiceWav });
    if (stems.musicWav) activeStems.push({ type: 'music', path: stems.musicWav });
    if (stems.sfxWav) activeStems.push({ type: 'sfx', path: stems.sfxWav });

    if (!activeStems.length) {
      // Visual-only MP4 with faststart
      await runFfmpegBin(this.ffmpegBin, [
        '-nostdin', '-v', 'error', '-threads', '2',
        '-i', visualPath,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', outPath,
      ], signal);
      return { masteredPath: outPath, bytes: fs.readFileSync(outPath), durationSec: finalDur };
    }

    // If narration slightly outlasts visual clip, hold final frame smoothly via tpad (never loop/duplicate clips!)
    const padSec = Math.max(0, finalDur - visualDurationSec);
    const ffArgs = ['-nostdin', '-v', 'error', '-threads', '2', '-i', visualPath];
    activeStems.forEach(s => ffArgs.push('-i', s.path));

    const hasVoice = Boolean(stems.voiceWav);
    const filterChains = [];
    let vMap = '0:v:0';
    if (padSec > 0.08) {
      filterChains.push(`[0:v]tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}[vpad]`);
      vMap = '[vpad]';
    }

    const mixLabels = [];
    let voiceIdx = -1;
    let musicIdx = -1;
    let sfxIdx = -1;
    activeStems.forEach((s, idx) => {
      if (s.type === 'voice') voiceIdx = idx + 1;
      if (s.type === 'music') musicIdx = idx + 1;
      if (s.type === 'sfx') sfxIdx = idx + 1;
    });

    if (hasVoice && musicIdx > 0) {
      // Dynamic sidechain ducking: music lowers smoothly while narration speaks and rises in pauses!
      filterChains.push(
        `[${voiceIdx}:a]apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS,asplit=2[vmain][vsc]`
      );
      filterChains.push(
        `[${musicIdx}:a]volume=0.52,apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[mraw]`
      );
      filterChains.push(
        `[mraw][vsc]sidechaincompress=threshold=0.025:ratio=6:attack=35:release=420:makeup=1[mduck]`
      );
      mixLabels.push('[vmain]', '[mduck]');
    } else {
      if (voiceIdx > 0) {
        filterChains.push(`[${voiceIdx}:a]volume=1.0,apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[vmain]`);
        mixLabels.push('[vmain]');
      }
      if (musicIdx > 0) {
        filterChains.push(`[${musicIdx}:a]volume=0.65,apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[mmain]`);
        mixLabels.push('[mmain]');
      }
    }

    if (sfxIdx > 0) {
      const sfxGain = hasVoice ? '0.38' : '0.72';
      filterChains.push(`[${sfxIdx}:a]volume=${sfxGain},apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[sfxmain]`);
      mixLabels.push('[sfxmain]');
    }

    const fadeOutStart = Math.max(0, finalDur - 0.3).toFixed(3);
    filterChains.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutStart}:d=0.28[aout]`
    );

    ffArgs.push(
      '-filter_complex', filterChains.join(';'),
      '-map', vMap,
      '-map', '[aout]',
      '-t', finalDur.toFixed(3),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', outPath
    );

    try {
      await runFfmpegBin(this.ffmpegBin, ffArgs, signal);
    } catch {
      // Fallback mix without sidechaincompress if older FFmpeg build lacks sidechaincompress
      const simpleArgs = ['-nostdin', '-v', 'error', '-threads', '2', '-i', visualPath];
      activeStems.forEach(s => simpleArgs.push('-i', s.path));
      const parts = activeStems.map((s, idx) => {
        const g = s.type === 'voice' ? '1.00' : (s.type === 'music' ? (hasVoice ? '0.26' : '0.60') : (hasVoice ? '0.36' : '0.72'));
        return `[${idx + 1}:a]volume=${g},apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[sa${idx}]`;
      });
      const inputs = activeStems.map((_, idx) => `[sa${idx}]`).join('');
      const graph = [
        ...(padSec > 0.08 ? [`[0:v]tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}[vpad]`] : []),
        ...parts,
        `${inputs}amix=inputs=${activeStems.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
      ].join(';');
      simpleArgs.push(
        '-filter_complex', graph,
        '-map', padSec > 0.08 ? '[vpad]' : '0:v:0',
        '-map', '[aout]',
        '-t', finalDur.toFixed(3),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y', outPath
      );
      await runFfmpegBin(this.ffmpegBin, simpleArgs, signal);
    }

    return { masteredPath: outPath, bytes: fs.readFileSync(outPath), durationSec: finalDur };
  }
}

/**
 * Orchestrates the complete modular studio pipeline:
 * Creative Prompt -> PromptAnalyzer -> ScenePlanner -> VideoGenerationService ->
 * VoiceGenerationService -> MusicGenerationService -> SoundEffectsService ->
 * VideoRenderingService -> AudioVideoSynchronizer -> ExportService
 */
function createStudioPipeline({ providers, ffmpegPath, ffprobePath } = {}) {
  const ff = ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const fp = ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';

  const promptAnalyzer = new PromptAnalyzer(providers);
  const scenePlanner = new ScenePlanner();
  const imageService = new ImageGenerationService(providers);
  const videoService = new VideoGenerationService(providers, ff);
  const voiceService = new VoiceGenerationService(providers);
  const musicService = new MusicGenerationService(providers);
  const sfxService = new SoundEffectsService(providers);
  const renderingService = new VideoRenderingService(ff, fp);
  const synchronizer = new AudioVideoSynchronizer(ff, fp);
  const exportService = new ExportService(ff);

  return {
    promptAnalyzer,
    scenePlanner,
    imageService,
    videoService,
    voiceService,
    musicService,
    sfxService,
    renderingService,
    synchronizer,
    exportService,

    async analyzeAndPlan(input, signal) {
      const analysis = await promptAnalyzer.analyze(input, signal);
      const plan = scenePlanner.plan(analysis);
      return { analysis, plan };
    },

    async executeStudioJob({ input, workdir, existingAnalysis = null, existingPlan = null, sceneCache = null, regenerateSceneIndex = null, onProgress }, signal) {
      let analysis = existingAnalysis;
      if (!analysis) {
        onProgress?.({ stage: 'analyzing', label: 'Analyzing Creative Prompt' });
        analysis = await promptAnalyzer.analyze(input, signal);
        signal?.throwIfAborted();
      }

      let plan = existingPlan;
      if (!plan) {
        onProgress?.({ stage: 'planning', label: 'Planning Video Scenes' });
        plan = scenePlanner.plan(analysis);
        signal?.throwIfAborted();
      }
      onProgress?.({ stage: 'planning', label: 'Planning Video Scenes', analysis, plan, sceneCount: plan.scenes.length });

      const generatedScenes = await videoService.generateScenes({
        plan,
        analysis,
        initialImageDataUrl: input.imageDataUrl || null,
        workdir,
        sceneCache,
        regenerateSceneIndex,
        onProgress,
      }, signal);
      signal?.throwIfAborted();

      const methods = [...new Set(generatedScenes.map(s => s.provider))];

      // Generate Voice Narration (only if requested)
      let voice = null;
      if (analysis.narrationRequested) {
        try {
          voice = await voiceService.generate({ analysis, workdir, onProgress }, signal);
          if (voice?.provider) methods.push(voice.provider);
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }

      // Generate Background Music (only if requested)
      let music = null;
      if (analysis.musicRequested) {
        try {
          music = await musicService.generate({
            analysis,
            targetDurationSec: analysis.requestedDurationSec,
            workdir,
            onProgress,
          }, signal);
          if (music?.provider) methods.push(music.provider);
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }

      // Generate Environmental Sound Effects (only if requested)
      let sfx = null;
      if (analysis.sfxRequested) {
        try {
          sfx = await sfxService.generate({
            analysis,
            generatedScenes,
            targetDurationSec: analysis.requestedDurationSec,
            workdir,
            onProgress,
          }, signal);
          if (sfx?.provider) methods.push(sfx.provider);
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }

      const assembled = await renderingService.assembleVisualTimeline({
        generatedScenes,
        plan,
        aspectRatio: analysis.aspectRatio,
        targetDurationSec: analysis.requestedDurationSec,
        workdir,
        onProgress,
      }, signal);
      signal?.throwIfAborted();

      const stems = await synchronizer.prepareStems({
        voice,
        music,
        sfx,
        visualDurationSec: assembled.visualDurationSec,
        workdir,
        onProgress,
      }, signal);
      signal?.throwIfAborted();

      const exported = await exportService.renderMasterMp4({
        visualPath: assembled.visualPath,
        visualDurationSec: assembled.visualDurationSec,
        stems,
        workdir,
        onProgress,
      }, signal);

      return {
        bytes: exported.bytes,
        mime: 'video/mp4',
        durationSec: exported.durationSec,
        providersUsed: methods,
        analysis,
        plan,
        narrationAudioBytes: voice?.bytes || null,
        narrationMime: voice?.mime || null,
        musicAudioBytes: music?.bytes || null,
        musicMime: music?.mime || null,
        sfxAudioBytes: sfx && sfx.kind === 'audio' ? fs.readFileSync(sfx.rawPath) : (stems.sfxWav ? fs.readFileSync(stems.sfxWav) : null),
        sfxMime: stems.sfxWav ? 'audio/wav' : 'audio/wav',
      };
    },
  };
}

module.exports = {
  PromptAnalyzer,
  ScenePlanner,
  ImageGenerationService,
  VideoGenerationService,
  VoiceGenerationService,
  MusicGenerationService,
  SoundEffectsService,
  VideoRenderingService,
  AudioVideoSynchronizer,
  ExportService,
  createStudioPipeline,
  OUTPUT_RESOLUTIONS,
};

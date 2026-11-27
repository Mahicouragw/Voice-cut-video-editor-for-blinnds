'use strict';
const fs=require('node:fs/promises');
class ServiceError extends Error {
  constructor(status,code,message) {super(message);this.status=status;this.code=code;}
}
async function readBounded(response,limit,signal) {
  if (!response.body) throw new ServiceError(502,'EMPTY_PROVIDER_RESPONSE','The provider returned an empty response.');
  let total=0;const chunks=[];
  for await (const chunk of response.body) {
    signal?.throwIfAborted();total+=chunk.length;
    if(total>limit) {await response.body.cancel().catch(()=>{});throw new ServiceError(502,'RESPONSE_TOO_LARGE','Provider response exceeded the safety limit.');}
    chunks.push(Buffer.from(chunk));
  }
  signal?.throwIfAborted();return Buffer.concat(chunks);
}
async function readJSON(response,limit,signal,name) {
  try{return JSON.parse((await readBounded(response,limit,signal)).toString());}
  catch(e){if(e instanceof ServiceError || signal?.aborted) throw e;throw new ServiceError(502,'BAD_TRANSCRIPT',`${name} returned an unreadable transcript.`);}
}
async function requireSuccess(response,name) {
  if(response.ok) return;
  try{const snippet=(await readBounded(response,2048,null)).toString().slice(0,400);console.error(`[VoiceCut] ${name} error HTTP ${response.status}: ${snippet}`);}catch{await response.body?.cancel().catch(()=>{});}
  // Do not return arbitrary provider error bodies: they may contain sensitive details.
  if([401,403].includes(response.status)) throw new ServiceError(502,'PROVIDER_AUTH',`${name} rejected the server API key or its permissions. Update it in your host Environment settings.`);
  if(response.status===429) throw new ServiceError(503,'PROVIDER_QUOTA',`${name} quota or rate limit reached. Check API billing/credits, then retry manually.`);
  if(response.status===402) throw new ServiceError(503,'PROVIDER_BILLING',`${name} requires available credits or API billing.`);
  if(response.status>=500) throw new ServiceError(503,'PROVIDER_UNAVAILABLE',`${name} is temporarily unavailable. No automatic paid retry was made.`);
  throw new ServiceError(502,'PROVIDER_REJECTED',`${name} rejected the audio request (HTTP ${response.status}). Check supported media and account access.`);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Normalize every provider to {language, words:[{word,start,end}]} for Captions.fromTranscript.
function wordsOnly(words) {
  return (words||[]).map(w=>({word:String(w.punctuated_word??w.text??w.word??''),start:Number(w.start),end:Number(w.end)}));
}
const IMAGE_SIZES={
  '16:9':{width:1280,height:720},
  '9:16':{width:720,height:1280},
  '1:1':{width:1024,height:1024},
  '4:3':{width:1024,height:768},
  '4:5':{width:864,height:1080},
};
// Dimensions divisible by 32 within LTX-Video / Wan ZeroGPU limits so free HF_TOKEN stays inside the 60s ZeroGPU ceiling.
const VIDEO_SIZES={
  '16:9':{width:768,height:448},
  '9:16':{width:448,height:768},
  '1:1':{width:640,height:640},
};
const EDGE_VOICES={
  en:{female:'en-IN-NeerjaNeural',male:'en-IN-PrabhatNeural'},
  te:{female:'te-IN-ShrutiNeural',male:'te-IN-MohanNeural'},
  hi:{female:'hi-IN-SwaraNeural',male:'hi-IN-MadhurNeural'},
  ta:{female:'ta-IN-PallaviNeural',male:'ta-IN-ValluvarNeural'},
  kn:{female:'kn-IN-SapnaNeural',male:'kn-IN-GaganNeural'},
  ml:{female:'ml-IN-SobhanaNeural',male:'ml-IN-MidhunNeural'},
  mr:{female:'mr-IN-AarohiNeural',male:'mr-IN-ManoharNeural'},
  bn:{female:'bn-IN-TanishaaNeural',male:'bn-IN-BashkarNeural'},
  ur:{female:'ur-IN-GulNeural',male:'ur-IN-SalmanNeural'},
  gu:{female:'gu-IN-DhwaniNeural',male:'gu-IN-NiranjanNeural'},
  pa:{female:'pa-IN-OjasNeural',male:'pa-IN-VaaniNeural'},
  es:{female:'es-ES-ElviraNeural',male:'es-ES-AlvaroNeural'},
  fr:{female:'fr-FR-DeniseNeural',male:'fr-FR-HenriNeural'},
  de:{female:'de-DE-KatjaNeural',male:'de-DE-ConradNeural'},
  ar:{female:'ar-SA-ZariyahNeural',male:'ar-SA-HamedNeural'},
  zh:{female:'zh-CN-XiaoxiaoNeural',male:'zh-CN-YunxiNeural'},
  ja:{female:'ja-JP-NanamiNeural',male:'ja-JP-KeitaNeural'},
  ko:{female:'ko-KR-SunHiNeural',male:'ko-KR-InJoonNeural'},
  pt:{female:'pt-BR-FranciscaNeural',male:'pt-BR-AntonioNeural'},
  ru:{female:'ru-RU-SvetlanaNeural',male:'ru-RU-DmitryNeural'},
  ga:{female:'ga-IE-OrlaNeural',male:'ga-IE-ColmNeural'},
  mt:{female:'mt-MT-GraceNeural',male:'mt-MT-JosephNeural'},
};
const QWEN_TTS_LANGS={
  en:'English',zh:'Chinese',ja:'Japanese',ko:'Korean',fr:'French',de:'German',es:'Spanish',pt:'Portuguese',ru:'Russian',
};
function pickEdgeVoice(language,gender='female') {
  const code=String(language||'en').toLowerCase().slice(0,2);
  const entry=EDGE_VOICES[code]||EDGE_VOICES.en;
  return gender==='male'?entry.male:entry.female;
}
function dataUrlToBlob(dataUrl,fallbackMime='image/jpeg') {
  if(!dataUrl||!String(dataUrl).startsWith('data:')) return null;
  const parts=String(dataUrl).split(',');
  const mime=(parts[0].match(/data:([^;]+)/)||[])[1]||fallbackMime;
  return new Blob([Buffer.from(parts[1]||'','base64')],{type:mime});
}
function createProviders({openaiKey,elevenKey,groqKey,deepgramKey,assemblyKey,cfAccountId,cfApiToken,pollinationsKey,falKey,replicateToken,hfToken,gradioClientImpl,edgeTtsImpl,googleTtsImpl,fetchImpl=fetch}={}) {
  const captionKeys={openai:openaiKey,groq:groqKey,deepgram:deepgramKey,assemblyai:assemblyKey};
  const envNames={openai:'OPENAI_API_KEY',groq:'GROQ_API_KEY',deepgram:'DEEPGRAM_API_KEY',assemblyai:'ASSEMBLYAI_API_KEY'};
  const cfReady=Boolean(cfAccountId&&cfApiToken);
  async function loadGradioClient() {
    if(gradioClientImpl) return gradioClientImpl;
    return import('@gradio/client');
  }
  function extractGradioMediaUrl(data) {
    const visit=(v)=>{
      if(!v) return null;
      if(typeof v==='string'&&/^https?:\/\//i.test(v)) return v;
      if(Array.isArray(v)) { for(const item of v){ const hit=visit(item); if(hit) return hit; } return null; }
      if(typeof v==='object') {
        if(typeof v.url==='string'&&/^https?:\/\//i.test(v.url)) return v.url;
        if(v.video) { const hit=visit(v.video); if(hit) return hit; }
        if(v.audio) { const hit=visit(v.audio); if(hit) return hit; }
        if(v.image) { const hit=visit(v.image); if(hit) return hit; }
        for(const val of Object.values(v)) { const hit=visit(val); if(hit) return hit; }
      }
      return null;
    };
    return visit(data);
  }
  async function downloadHfMedia(mediaUrl,signal,label,maxBytes=100*1024*1024,defaultMime='application/octet-stream') {
    const headers=hfToken&&/hf\.space|huggingface\.co/i.test(mediaUrl)?{Authorization:'Bearer '+hfToken}:{};
    const dl=await fetchImpl(mediaUrl,{headers,signal,redirect:'follow'});
    await requireSuccess(dl,label);
    return {
      bytes:await readBounded(dl,maxBytes,signal),
      mime:(dl.headers.get('content-type')||defaultMime).split(';')[0],
    };
  }
  return {
    configured:{
      captions:Object.values(captionKeys).some(Boolean),
      isolation:!!elevenKey,
      captionProviders:{openai:!!openaiKey,groq:!!groqKey,deepgram:!!deepgramKey,assemblyai:!!assemblyKey},
      imageGen:true,
      videoGen:true,
      tts:true,
      musicGen:true,
      sfxGen:true,
      imageProviders:{cloudflare:cfReady,hfZeroGpu:true,hfTokenConfigured:!!hfToken,pollinations:!!pollinationsKey,fal:!!falKey,freeFallback:true},
      videoProviders:{hfZeroGpu:true,hfTokenConfigured:!!hfToken,pollinations:!!pollinationsKey,fal:!!falKey,replicate:!!replicateToken},
      ttsProviders:{edgeNeural:true,googleTranslate:true,qwen3Tts:true,openai:!!openaiKey},
      soundProviders:{mmaudio:true,hunyuanFoley:true,stableAudio:true,aceStep:true,musicgen:true},
      models:{
        video:[
          {id:'auto',label:'Auto (Best Free AI Video)'},
          {id:'ltx-video',label:'LTX-Video 0.9.8 13B Distilled (Text & Image to Video)'},
          {id:'wan21-fast',label:'Wan 2.1 CausVid 14B Fast (Image to Video / Animated Scene)'},
          ...(pollinationsKey?[{id:'pollinations-wan',label:'Pollinations Wan / Seedance'}]:[]),
          ...(falKey?[{id:'fal-wan',label:'fal.ai Wan 2.1'}]:[]),
          ...(replicateToken?[{id:'replicate-wan',label:'Replicate Wan 2.1'}]:[]),
        ],
        image:[
          {id:'auto',label:'Auto (Best Free AI Image)'},
          {id:'cloudflare-flux',label:'Cloudflare FLUX.1-schnell (Fast Daily Free)'},
          {id:'hf-flux',label:'Hugging Face FLUX.1-schnell (ZeroGPU)'},
          {id:'z-image-turbo',label:'Z-Image Turbo (Fastest HD)'},
          {id:'qwen-image',label:'Qwen-Image (Best Text & Logos)'},
          {id:'pollinations',label:'Pollinations FLUX Free'},
          {id:'sdxl-cpu',label:'SDXL-Turbo CPU (Zero Quota Fallback)'},
        ],
        tts:[
          {id:'auto',label:'Auto (Best Free Multilingual Voice)'},
          {id:'edge-neural',label:'Microsoft Edge Neural TTS v2 (Telugu, Hindi, Tamil + 20 langs)'},
          {id:'google-tts',label:'Google Translate TTS (Unlimited Keyless Multi-language)'},
          {id:'qwen3-tts',label:'Qwen3-TTS 1.7B Neural (Hugging Face ZeroGPU)'},
          ...(openaiKey?[{id:'openai-tts',label:'OpenAI TTS-1'}]:[]),
        ],
        sfx:[
          {id:'auto',label:'Auto (Google Flow–style Synchronized Scene SFX)'},
          {id:'mmaudio',label:'MMAudio Video-to-Audio Synchronized Foley'},
          {id:'hunyuan-foley',label:'HunyuanVideo-Foley Synchronized Scene Audio'},
          {id:'stable-audio',label:'Stable Audio Open 1.0 Sound Effects'},
        ],
        music:[
          {id:'auto',label:'Auto (Best Free AI Music)'},
          {id:'stable-audio',label:'Stable Audio Open 1.0 (Cinematic Instrumental)'},
          {id:'ace-step',label:'ACE-Step 3.5B (Full Songs & Melodic Beds)'},
          {id:'musicgen',label:'Meta MusicGen (Instrumental Soundtrack)'},
        ],
      },
    },
    async transcribe(file,language,signal,provider='openai') {
      if(!captionKeys.hasOwnProperty(provider)) throw new ServiceError(400,'UNKNOWN_PROVIDER','Unknown caption provider: '+provider);
      const key=captionKeys[provider];
      if(!key) throw new ServiceError(503,'KEY_NOT_CONFIGURED',envNames[provider]+' is missing from the server Environment settings.');
      const data=await fs.readFile(file);signal.throwIfAborted();
      if(provider==='openai'||provider==='groq') {
        const form=new FormData();form.append('file',new Blob([data],{type:'audio/mpeg'}),'speech.mp3');
        form.append('model',provider==='groq'?'whisper-large-v3-turbo':'whisper-1');form.append('response_format','verbose_json');
        form.append('timestamp_granularities[]','word');form.append('timestamp_granularities[]','segment');
        if(language) form.append('language',language);
        const url=provider==='groq'?'https://api.groq.com/openai/v1/audio/transcriptions':'https://api.openai.com/v1/audio/transcriptions';
        const name=provider==='groq'?'Groq':'OpenAI';
        const response=await fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal,redirect:'error'});
        await requireSuccess(response,name);
        return readJSON(response,4*1024*1024,signal,name);
      }
      if(provider==='deepgram') {
        const params=new URLSearchParams({model:'nova-3',smart_format:'true',utterances:'true'});
        if(language) params.set('language',language); else params.set('detect_language','true');
        const response=await fetchImpl('https://api.deepgram.com/v1/listen?'+params,{method:'POST',headers:{Authorization:'Token '+key,'Content-Type':'audio/mpeg'},body:data,signal,redirect:'error'});
        await requireSuccess(response,'Deepgram');
        const payload=await readJSON(response,8*1024*1024,signal,'Deepgram');
        const channel=payload?.results?.channels?.[0],alternative=channel?.alternatives?.[0];
        if(!alternative) throw new ServiceError(502,'BAD_TRANSCRIPT','Deepgram returned no transcript.');
        return {language:String(channel?.detected_language||alternative?.languages?.[0]||language||''),words:wordsOnly(alternative.words)};
      }
      const upload=await fetchImpl('https://api.assemblyai.com/v2/upload',{method:'POST',headers:{Authorization:key,'Content-Type':'application/octet-stream'},body:data,signal,redirect:'error'});
      await requireSuccess(upload,'AssemblyAI');
      const audio_url=(await readJSON(upload,64*1024,signal,'AssemblyAI')).upload_url;
      if(!audio_url) throw new ServiceError(502,'BAD_TRANSCRIPT','AssemblyAI did not accept the audio upload.');
      const created=await fetchImpl('https://api.assemblyai.com/v2/transcript',{method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},body:JSON.stringify({audio_url,...(language?{language_code:language}:{language_detection:true})}),signal,redirect:'error'});
      await requireSuccess(created,'AssemblyAI');
      const id=(await readJSON(created,64*1024,signal,'AssemblyAI')).id;
      if(!id) throw new ServiceError(502,'BAD_TRANSCRIPT','AssemblyAI did not start transcription.');
      for(let poll=0,pollErrors=0;poll<240;poll++) {
        signal.throwIfAborted();await sleep(3000);signal.throwIfAborted();
        let job;
        try{
          const status=await fetchImpl('https://api.assemblyai.com/v2/transcript/'+id,{headers:{Authorization:key},signal,redirect:'error'});
          await requireSuccess(status,'AssemblyAI');
          job=await readJSON(status,8*1024*1024,signal,'AssemblyAI');
        }catch(e){signal.throwIfAborted();if(++pollErrors>10)throw e;continue;}
        pollErrors=0;
        if(job.status==='completed') return {language:String(job.language_code||language||''),words:(job.words||[]).map(w=>({word:String(w.text??''),start:Number(w.start)/1000,end:Number(w.end)/1000}))};
        if(job.status==='error') throw new ServiceError(502,'PROVIDER_REJECTED','AssemblyAI could not transcribe this audio. Try a clearer recording.');
      }
      throw new ServiceError(408,'EXPIRED','AssemblyAI transcription timed out. No automatic paid retry was made.');
    },
    async isolate(file,signal) {
      if(!elevenKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','ELEVENLABS_API_KEY is missing from the server Environment settings.');
      const data=await fs.readFile(file);signal.throwIfAborted();
      const form=new FormData();form.append('audio',new Blob([data],{type:'audio/mpeg'}),'speech.mp3');form.append('file_format','other');
      const response=await fetchImpl('https://api.elevenlabs.io/v1/audio-isolation',{method:'POST',headers:{'xi-api-key':elevenKey},body:form,signal,redirect:'error'});
      await requireSuccess(response,'ElevenLabs');
      const type=response.headers.get('content-type')||'';
      if(!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {await response.body?.cancel();throw new ServiceError(502,'BAD_AUDIO_RESPONSE','ElevenLabs did not return audio.');}
      return readBounded(response,128*1024*1024,signal);
    },
    async generateImage({prompt,aspectRatio='16:9',preset='general',seed,model='auto'},signal) {
      const cleanPrompt=String(prompt||'').trim().slice(0,1800);
      if(!cleanPrompt) throw new ServiceError(400,'EMPTY_PROMPT','Enter a description for the image you want to generate.');
      const dims=IMAGE_SIZES[aspectRatio]||IMAGE_SIZES['16:9'];
      const prefix=preset==='thumbnail'?'High-contrast vibrant YouTube thumbnail, expressive focal subject, crisp studio lighting, eye-catching composition: '
        :preset==='logo'?'Clean modern vector brand logo mark, centered icon, crisp geometric shapes, high contrast, minimalist emblem design: '
        :preset==='social'?'Polished social media post graphic, cinematic framing, vibrant colors, crisp detail: ':'';
      const fullPrompt=(prefix+cleanPrompt).slice(0,1950);
      const chosenSeed=Number.isInteger(seed)?seed:Math.floor(Math.random()*1000000);
      const picked=String(model||'auto').toLowerCase();
      const runCloudflare=async()=>{
        if(!cfReady) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Cloudflare Workers AI keys (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) are not configured.');
        const cfUrl=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccountId)}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
        const response=await fetchImpl(cfUrl,{
          method:'POST',
          headers:{Authorization:'Bearer '+cfApiToken,'Content-Type':'application/json'},
          body:JSON.stringify({prompt:fullPrompt,num_steps:4,seed:chosenSeed}),
          signal,redirect:'error',
        });
        await requireSuccess(response,'Cloudflare Workers AI');
        const ctype=response.headers.get('content-type')||'';
        if(ctype.startsWith('image/')) {
          return {bytes:await readBounded(response,20*1024*1024,signal),mime:ctype.split(';')[0],provider:'Cloudflare FLUX.1-schnell'};
        }
        const payload=await readJSON(response,24*1024*1024,signal,'Cloudflare Workers AI');
        const b64=payload?.result?.image||payload?.image;
        if(!b64) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Cloudflare Workers AI did not return an image.');
        return {bytes:Buffer.from(b64,'base64'),mime:'image/jpeg',provider:'Cloudflare FLUX.1-schnell'};
      };
      const runPollinationsAuth=async()=>{
        if(!pollinationsKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','POLLINATIONS_API_KEY is not configured.');
        const params=new URLSearchParams({model:'flux',width:String(dims.width),height:String(dims.height),seed:String(chosenSeed),nologo:'true'});
        const url=`https://gen.pollinations.ai/image/${encodeURIComponent(fullPrompt)}?${params}`;
        const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+pollinationsKey},signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations');
        const ctype=response.headers.get('content-type')||'image/jpeg';
        if(!ctype.startsWith('image/')) {await response.body?.cancel().catch(()=>{});throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Pollinations did not return an image.');}
        return {bytes:await readBounded(response,20*1024*1024,signal),mime:ctype.split(';')[0],provider:'Pollinations FLUX'};
      };
      const runFal=async()=>{
        if(!falKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','FAL_KEY is not configured.');
        const sizeMap={'16:9':'landscape_16_9','9:16':'portrait_16_9','1:1':'square_hd','4:3':'landscape_4_3','4:5':'portrait_4_3'};
        const response=await fetchImpl('https://fal.run/fal-ai/flux/schnell',{
          method:'POST',
          headers:{Authorization:'Key '+falKey,'Content-Type':'application/json'},
          body:JSON.stringify({prompt:fullPrompt,image_size:sizeMap[aspectRatio]||'landscape_16_9',num_inference_steps:4,seed:chosenSeed}),
          signal,redirect:'error',
        });
        await requireSuccess(response,'fal.ai');
        const payload=await readJSON(response,4*1024*1024,signal,'fal.ai');
        const imgUrl=payload?.images?.[0]?.url;
        if(!imgUrl) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','fal.ai did not return an image URL.');
        const dl=await fetchImpl(imgUrl,{signal,redirect:'follow'});
        await requireSuccess(dl,'fal.ai media');
        return {bytes:await readBounded(dl,24*1024*1024,signal),mime:(dl.headers.get('content-type')||'image/jpeg').split(';')[0],provider:'fal.ai FLUX.1-schnell'};
      };
      const runPollinationsFree=async()=>{
        const scale=Math.min(1,768/Math.max(dims.width,dims.height));
        const fw=Math.max(256,Math.round(dims.width*scale/16)*16),fh=Math.max(256,Math.round(dims.height*scale/16)*16);
        const classicUrl=`https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=${fw}&height=${fh}&seed=${chosenSeed}`;
        const response=await fetchImpl(classicUrl,{signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations Free');
        const ctype=response.headers.get('content-type')||'';
        if(!ctype.startsWith('image/')) {
          await response.body?.cancel().catch(()=>{});
          throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Pollinations Free did not return an image.');
        }
        return {bytes:await readBounded(response,20*1024*1024,signal),mime:ctype.split(';')[0],provider:'Pollinations Free'};
      };
      const runHfImageSpace=async(which)=>{
        const {Client}=await loadGradioClient();
        const opts=hfToken?{token:hfToken}:{};
        if(which==='z-image-turbo') {
          const zRes=aspectRatio==='9:16'?'720x1280 ( 9:16 )':aspectRatio==='1:1'?'1024x1024 ( 1:1 )':aspectRatio==='4:3'?'1152x864 ( 4:3 )':'1280x720 ( 16:9 )';
          const app=await Client.connect('Tongyi-MAI/Z-Image-Turbo',opts);
          const res=await app.predict('/generate',{prompt:fullPrompt,resolution:zRes,seed:chosenSeed,steps:8,shift:3.0,random_seed:false});
          const mediaUrl=extractGradioMediaUrl(res?.data);
          if(!mediaUrl) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Z-Image-Turbo returned no image URL.');
          const dl=await downloadHfMedia(mediaUrl,signal,'HF ZeroGPU Z-Image-Turbo',24*1024*1024,'image/png');
          return {...dl,provider:'HF ZeroGPU Z-Image-Turbo'};
        }
        if(which==='qwen-image') {
          const qAr=['1:1','16:9','9:16','4:3'].includes(aspectRatio)?aspectRatio:aspectRatio==='4:5'?'3:4':'16:9';
          const app=await Client.connect('Qwen/Qwen-Image',opts);
          const res=await app.predict('/infer',{prompt:fullPrompt,seed:chosenSeed,randomize_seed:false,aspect_ratio:qAr,guidance_scale:4.0,num_inference_steps:28,prompt_enhance:true});
          const mediaUrl=extractGradioMediaUrl(res?.data);
          if(!mediaUrl) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Qwen-Image returned no image URL.');
          const dl=await downloadHfMedia(mediaUrl,signal,'HF ZeroGPU Qwen-Image',24*1024*1024,'image/png');
          return {...dl,provider:'HF ZeroGPU Qwen-Image'};
        }
        if(which==='sdxl-cpu') {
          const app=await Client.connect('Manjushri/SDXL-Turbo-CPU',opts);
          const res=await app.predict('/genie',{prompt:fullPrompt.slice(0,300),steps:2,seed:chosenSeed});
          const mediaUrl=extractGradioMediaUrl(res?.data);
          if(!mediaUrl) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','SDXL-Turbo CPU returned no image URL.');
          const dl=await downloadHfMedia(mediaUrl,signal,'HF CPU SDXL-Turbo',24*1024*1024,'image/png');
          return {...dl,provider:'HF CPU SDXL-Turbo'};
        }
        const app=await Client.connect('black-forest-labs/FLUX.1-schnell',opts);
        const res=await app.predict('/infer',{prompt:fullPrompt,seed:chosenSeed,randomize_seed:false,width:dims.width,height:dims.height,num_inference_steps:4});
        const mediaUrl=extractGradioMediaUrl(res?.data);
        if(!mediaUrl) throw new ServiceError(502,'BAD_IMAGE_RESPONSE','FLUX.1-schnell returned no image URL.');
        const dl=await downloadHfMedia(mediaUrl,signal,'Hugging Face ZeroGPU FLUX',24*1024*1024,'image/webp');
        return {...dl,provider:'HF ZeroGPU FLUX.1-schnell'};
      };

      // Explicit model selection
      if(picked==='cloudflare-flux') return runCloudflare();
      if(picked==='pollinations') return pollinationsKey?runPollinationsAuth():runPollinationsFree();
      if(picked==='fal-flux') return runFal();
      if(['hf-flux','z-image-turbo','qwen-image','sdxl-cpu'].includes(picked)) return runHfImageSpace(picked);

      // Auto mode: prioritize configured fast keys, then free keyless & ZeroGPU + CPU fallbacks
      const chain=[];
      if(cfReady) chain.push(runCloudflare);
      if(pollinationsKey) chain.push(runPollinationsAuth);
      if(falKey) chain.push(runFal);
      chain.push(runPollinationsFree);
      chain.push(()=>runHfImageSpace('hf-flux'));
      chain.push(()=>runHfImageSpace('z-image-turbo'));
      chain.push(()=>runHfImageSpace('sdxl-cpu'));

      let lastErr=null;
      for(const step of chain) {
        try {
          signal?.throwIfAborted();
          return await step();
        } catch(e) {
          if(signal?.aborted) throw e;
          lastErr=e;
        }
      }
      throw lastErr||new ServiceError(503,'PROVIDER_QUOTA','Free image slots are busy right now. Please retry in a moment.');
    },
    async generateVideo({prompt,aspectRatio='16:9',duration=5,imageDataUrl=null,model='auto'},signal) {
      const cleanPrompt=String(prompt||'').trim().slice(0,1800);
      if(!cleanPrompt) throw new ServiceError(400,'EMPTY_PROMPT','Enter a description for the video scene you want to generate.');
      const dur=Math.max(2,Math.min(15,Math.round(Number(duration)||5)));
      const ar=aspectRatio==='9:16'?'9:16':aspectRatio==='1:1'?'1:1':'16:9';
      const vDims=VIDEO_SIZES[ar]||VIDEO_SIZES['16:9'];
      const picked=String(model||'auto').toLowerCase();

      const runPollinationsVideo=async()=>{
        if(!pollinationsKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','POLLINATIONS_API_KEY is not configured.');
        const pModel=imageDataUrl?'seedance':dur>10?'wan':'seedance';
        const clampedDur=pModel==='seedance'?Math.min(10,dur):dur;
        if(imageDataUrl) {
          const chatRes=await fetchImpl('https://gen.pollinations.ai/v1/chat/completions',{
            method:'POST',
            headers:{Authorization:'Bearer '+pollinationsKey,'Content-Type':'application/json'},
            body:JSON.stringify({
              model:pModel,
              messages:[{role:'user',content:[{type:'text',text:`${cleanPrompt} (aspect ratio ${ar}, duration ${clampedDur}s)`},{type:'image_url',image_url:{url:imageDataUrl}}]}],
            }),
            signal,redirect:'error',
          });
          await requireSuccess(chatRes,'Pollinations Video');
          const linkHdr=chatRes.headers.get('link')||'';
          const payload=await readJSON(chatRes,2*1024*1024,signal,'Pollinations Video');
          const content=String(payload?.choices?.[0]?.message?.content||'');
          const urlMatch=/https:\/\/[^\s)>"]+/i.exec(linkHdr)||/https:\/\/[^\s)>"]+/i.exec(content);
          if(!urlMatch) throw new ServiceError(502,'BAD_VIDEO_RESPONSE','Pollinations did not return a video link.');
          const dl=await fetchImpl(urlMatch[0],{headers:{Authorization:'Bearer '+pollinationsKey},signal,redirect:'follow'});
          await requireSuccess(dl,'Pollinations Video Media');
          return {bytes:await readBounded(dl,100*1024*1024,signal),mime:'video/mp4',provider:`Pollinations ${pModel}`};
        }
        const params=new URLSearchParams({model:pModel,duration:String(clampedDur),aspectRatio:ar==='1:1'?'16:9':ar});
        const url=`https://gen.pollinations.ai/image/${encodeURIComponent(cleanPrompt)}?${params}`;
        const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+pollinationsKey},signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations Video');
        const ctype=response.headers.get('content-type')||'';
        if(!ctype.startsWith('video/')&&!ctype.startsWith('application/octet-stream')) {
          await response.body?.cancel().catch(()=>{});
          throw new ServiceError(502,'BAD_VIDEO_RESPONSE','Pollinations did not return a video file.');
        }
        return {bytes:await readBounded(response,100*1024*1024,signal),mime:'video/mp4',provider:`Pollinations ${pModel}`};
      };

      const runFalVideo=async()=>{
        if(!falKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','FAL_KEY is not configured.');
        const endpoint=imageDataUrl?'fal-ai/wan-i2v':'fal-ai/wan-t2v';
        const input=imageDataUrl?{prompt:cleanPrompt,image_url:imageDataUrl,aspect_ratio:ar}:{prompt:cleanPrompt,aspect_ratio:ar};
        const submit=await fetchImpl(`https://queue.fal.run/${endpoint}`,{
          method:'POST',
          headers:{Authorization:'Key '+falKey,'Content-Type':'application/json'},
          body:JSON.stringify(input),
          signal,redirect:'error',
        });
        await requireSuccess(submit,'fal.ai Video');
        const queued=await readJSON(submit,128*1024,signal,'fal.ai Video');
        const statusUrl=queued.status_url||`https://queue.fal.run/${endpoint}/requests/${queued.request_id}/status`;
        const responseUrl=queued.response_url||`https://queue.fal.run/${endpoint}/requests/${queued.request_id}`;
        for(let poll=0;poll<180;poll++) {
          signal.throwIfAborted();await sleep(3000);signal.throwIfAborted();
          const stRes=await fetchImpl(statusUrl,{headers:{Authorization:'Key '+falKey},signal,redirect:'error'});
          await requireSuccess(stRes,'fal.ai Queue');
          const st=await readJSON(stRes,256*1024,signal,'fal.ai Queue');
          if(st.status==='COMPLETED') {
            const finalRes=await fetchImpl(responseUrl,{headers:{Authorization:'Key '+falKey},signal,redirect:'error'});
            await requireSuccess(finalRes,'fal.ai Result');
            const out=await readJSON(finalRes,2*1024*1024,signal,'fal.ai Result');
            const videoUrl=out?.video?.url||out?.data?.video?.url;
            if(!videoUrl) throw new ServiceError(502,'BAD_VIDEO_RESPONSE','fal.ai completed without a video URL.');
            const dl=await fetchImpl(videoUrl,{signal,redirect:'follow'});
            await requireSuccess(dl,'fal.ai Media');
            return {bytes:await readBounded(dl,100*1024*1024,signal),mime:'video/mp4',provider:'fal.ai Wan'};
          }
          if(st.status==='FAILED') throw new ServiceError(502,'PROVIDER_REJECTED','fal.ai could not generate this video prompt.');
        }
        throw new ServiceError(408,'EXPIRED','fal.ai video generation timed out.');
      };

      const runReplicateVideo=async()=>{
        if(!replicateToken) throw new ServiceError(503,'KEY_NOT_CONFIGURED','REPLICATE_API_TOKEN is not configured.');
        const modelPath=imageDataUrl?'wavespeedai/wan-2.1-i2v-480p':'wavespeedai/wan-2.1-t2v-480p';
        const createRes=await fetchImpl(`https://api.replicate.com/v1/models/${modelPath}/predictions`,{
          method:'POST',
          headers:{Authorization:'Bearer '+replicateToken,'Content-Type':'application/json'},
          body:JSON.stringify({input:{prompt:cleanPrompt,aspect_ratio:ar,...(imageDataUrl?{image:imageDataUrl}:{})}}),
          signal,redirect:'error',
        });
        await requireSuccess(createRes,'Replicate');
        let pred=await readJSON(createRes,256*1024,signal,'Replicate');
        for(let poll=0;poll<180&&pred.status!=='succeeded';poll++) {
          if(pred.status==='failed'||pred.status==='canceled') throw new ServiceError(502,'PROVIDER_REJECTED','Replicate could not generate this video.');
          signal.throwIfAborted();await sleep(3000);signal.throwIfAborted();
          const pollRes=await fetchImpl(pred.urls.get,{headers:{Authorization:'Bearer '+replicateToken},signal,redirect:'error'});
          await requireSuccess(pollRes,'Replicate');
          pred=await readJSON(pollRes,512*1024,signal,'Replicate');
        }
        const outUrl=Array.isArray(pred.output)?pred.output[0]:pred.output;
        if(!outUrl) throw new ServiceError(502,'BAD_VIDEO_RESPONSE','Replicate did not return a video URL.');
        const dl=await fetchImpl(outUrl,{signal,redirect:'follow'});
        await requireSuccess(dl,'Replicate Media');
        return {bytes:await readBounded(dl,100*1024*1024,signal),mime:'video/mp4',provider:'Replicate Wan-2.1'};
      };

      const runLtxVideo=async()=>{
        const {Client,handle_file}=await loadGradioClient();
        const opts=hfToken?{token:hfToken}:{};
        const imageBlob=dataUrlToBlob(imageDataUrl);
        // LTX-Video 0.9.8 13B Distilled: duration_ui <= 7.0 requests 60s ZeroGPU (fits free HF_TOKEN!).
        // CRITICAL: /text_to_video defaults mode to 'image-to-video' in Gradio schema, so always pass mode: 'text-to-video' explicitly!
        const ltxDur=Math.max(2,Math.min(7,dur));
        const app=await Client.connect('Lightricks/ltx-video-distilled',opts);
        const res=imageBlob
          ? await app.predict('/image_to_video',{
              prompt:cleanPrompt,
              negative_prompt:'worst quality, inconsistent motion, blurry, jittery, distorted',
              input_image_filepath:handle_file?handle_file(imageBlob):imageBlob,
              height_ui:vDims.height,
              width_ui:vDims.width,
              mode:'image-to-video',
              duration_ui:ltxDur,
              ui_guidance_scale:3.0,
              improve_texture_flag:true,
              randomize_seed:true,
            })
          : await app.predict('/text_to_video',{
              prompt:cleanPrompt,
              negative_prompt:'worst quality, inconsistent motion, blurry, jittery, distorted',
              height_ui:vDims.height,
              width_ui:vDims.width,
              mode:'text-to-video',
              duration_ui:ltxDur,
              ui_guidance_scale:3.0,
              improve_texture_flag:true,
              randomize_seed:true,
            });
        const videoUrl=extractGradioMediaUrl(res?.data);
        if(!videoUrl) throw new ServiceError(502,'BAD_VIDEO_RESPONSE','LTX-Video returned no video URL.');
        const dl=await downloadHfMedia(videoUrl,signal,'Hugging Face ZeroGPU LTX-Video',100*1024*1024,'video/mp4');
        return {bytes:dl.bytes,mime:'video/mp4',provider:'HF ZeroGPU (Lightricks/ltx-video-distilled)'};
      };

      const runWan21Fast=async()=>{
        const {Client,handle_file}=await loadGradioClient();
        const opts=hfToken?{token:hfToken}:{};
        let imageBlob=dataUrlToBlob(imageDataUrl);
        if(!imageBlob) {
          // Wan 2.1 CausVid Fast is an I2V 4-step pipeline; synthesize an initial high-res keyframe automatically using our configured free image model!
          const firstFrame=await this.generateImage({prompt:cleanPrompt,aspectRatio:ar,preset:'general'},signal);
          imageBlob=new Blob([firstFrame.bytes],{type:firstFrame.mime||'image/jpeg'});
        }
        // steps=4, duration_seconds=2..3.3 keeps GPU request at 60s (within free HF_TOKEN ZeroGPU limit).
        const app=await Client.connect('multimodalart/wan2-1-fast',opts);
        const res=await app.predict('/generate_video',{
          input_image:handle_file?handle_file(imageBlob):imageBlob,
          prompt:cleanPrompt,
          height:vDims.height,
          width:vDims.width,
          duration_seconds:Math.min(3.3,Math.max(2,dur)),
          guidance_scale:1.0,
          steps:4,
          randomize_seed:true,
        });
        const videoUrl=extractGradioMediaUrl(res?.data);
        if(!videoUrl) throw new ServiceError(502,'BAD_VIDEO_RESPONSE','Wan 2.1 Fast returned no video URL.');
        const dl=await downloadHfMedia(videoUrl,signal,'Hugging Face ZeroGPU Wan 2.1 Fast',100*1024*1024,'video/mp4');
        return {bytes:dl.bytes,mime:'video/mp4',provider:'HF ZeroGPU (multimodalart/wan2-1-fast)'};
      };

      if(picked==='pollinations-wan') return runPollinationsVideo();
      if(picked==='fal-wan') return runFalVideo();
      if(picked==='replicate-wan') return runReplicateVideo();
      if(picked==='ltx-video') return runLtxVideo();
      if(picked==='wan21-fast') return runWan21Fast();

      // Auto mode: try configured dedicated video keys first, then LTX-Video 0.9.8 Distilled, then Wan 2.1 Fast
      const chain=[];
      if(pollinationsKey) chain.push(runPollinationsVideo);
      if(falKey) chain.push(runFalVideo);
      if(replicateToken) chain.push(runReplicateVideo);
      chain.push(runLtxVideo);
      chain.push(runWan21Fast);

      let lastErr=null;
      for(const step of chain) {
        try {
          signal?.throwIfAborted();
          return await step();
        } catch(e) {
          if(signal?.aborted) throw e;
          lastErr=e;
        }
      }
      throw lastErr||new ServiceError(503,'PROVIDER_QUOTA','Free AI video GPU queue is temporarily busy. Wait 30 seconds and retry, or try switching between LTX-Video and Wan 2.1 Fast.');
    },
    async generateVideoFoley({videoBytes,prompt,duration=8,model='auto'},signal) {
      const cleanPrompt=String(prompt||'ambient realistic scene sound effects').trim().slice(0,500);
      const dur=Math.max(2,Math.min(15,Number(duration)||8));
      const picked=String(model||'auto').toLowerCase();
      const {Client,handle_file}=await loadGradioClient();
      const opts=hfToken?{token:hfToken}:{};
      const videoBlob=videoBytes?new Blob([videoBytes],{type:'video/mp4'}):null;

      const runMmAudio=async()=>{
        const app=await Client.connect('hkchengrex/MMAudio',opts);
        if(videoBlob) {
          const res=await app.predict('/video_to_audio',{
            video:handle_file?handle_file(videoBlob):videoBlob,
            prompt:cleanPrompt,
            negative_prompt:'music, speech, distorted, harsh static',
            seed:-1,
            num_steps:25,
            cfg_strength:4.5,
            duration:Math.min(12,dur),
          });
          const url=extractGradioMediaUrl(res?.data);
          if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','MMAudio video-to-audio returned no media URL.');
          const dl=await downloadHfMedia(url,signal,'MMAudio Synchronized Foley',64*1024*1024,'video/mp4');
          return {bytes:dl.bytes,mime:dl.mime,kind:'video-with-audio',provider:'MMAudio Video-to-Audio'};
        }
        const res=await app.predict('/text_to_audio',{
          prompt:cleanPrompt,
          negative_prompt:'music, speech, harsh static',
          seed:-1,
          num_steps:25,
          cfg_strength:4.5,
          duration:Math.min(12,dur),
        });
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','MMAudio text-to-audio returned no audio URL.');
        const dl=await downloadHfMedia(url,signal,'MMAudio Sound Effects',32*1024*1024,'audio/flac');
        return {bytes:dl.bytes,mime:dl.mime,kind:'audio',provider:'MMAudio Text-to-Audio'};
      };

      const runHunyuanFoley=async()=>{
        if(!videoBlob) throw new ServiceError(400,'VIDEO_REQUIRED','HunyuanVideo-Foley requires a video clip.');
        const app=await Client.connect('tencent/HunyuanVideo-Foley',opts);
        const fRef=handle_file?handle_file(videoBlob):videoBlob;
        const res=await app.predict('/process_inference',{
          video_file:{video:fRef},
          text_prompt:cleanPrompt,
          neg_prompt:'music, speech, noise, static',
          guidance_scale:4.5,
          inference_steps:35,
          sample_nums:1,
        });
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','HunyuanVideo-Foley returned no media URL.');
        const dl=await downloadHfMedia(url,signal,'HunyuanVideo-Foley',64*1024*1024,'video/mp4');
        return {bytes:dl.bytes,mime:dl.mime,kind:'video-with-audio',provider:'HunyuanVideo-Foley'};
      };

      const runStableSfx=async()=>{
        const app=await Client.connect('artificialguybr/Stable-Audio-Open-Zero',opts);
        const res=await app.predict('/predict',{
          prompt:`Realistic cinema Foley sound effects, ${cleanPrompt}, high fidelity stereo soundscape`,
          seconds_total:Math.min(45,Math.max(4,dur)),
          steps:60,
          cfg_scale:7,
        });
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','Stable Audio Open returned no audio URL.');
        const dl=await downloadHfMedia(url,signal,'Stable Audio Open SFX',48*1024*1024,'audio/wav');
        return {bytes:dl.bytes,mime:dl.mime,kind:'audio',provider:'Stable Audio Open SFX'};
      };

      if(picked==='mmaudio') return runMmAudio();
      if(picked==='hunyuan-foley') return runHunyuanFoley();
      if(picked==='stable-audio') return runStableSfx();

      const chain=videoBlob?[runMmAudio,runHunyuanFoley,runStableSfx]:[runStableSfx,runMmAudio];
      let lastErr=null;
      for(const step of chain) {
        try {
          signal?.throwIfAborted();
          return await step();
        } catch(e) {
          if(signal?.aborted) throw e;
          lastErr=e;
        }
      }
      throw lastErr||new ServiceError(503,'PROVIDER_QUOTA','Free scene sound-effect models are busy right now. Retry in a moment.');
    },
    async generateMusic({prompt,duration=15,lyrics='',model='auto'},signal) {
      const cleanPrompt=String(prompt||'warm cinematic background music, gentle ambient soundtrack').trim().slice(0,600);
      const dur=Math.max(4,Math.min(60,Number(duration)||15));
      const picked=String(model||'auto').toLowerCase();
      const {Client}=await loadGradioClient();
      const opts=hfToken?{token:hfToken}:{};

      const runStableMusic=async()=>{
        const app=await Client.connect('artificialguybr/Stable-Audio-Open-Zero',opts);
        const res=await app.predict('/predict',{
          prompt:`${cleanPrompt}, clean studio mix, high quality stereo instrumental soundtrack`,
          seconds_total:Math.min(47,dur),
          steps:80,
          cfg_scale:7,
        });
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','Stable Audio Open returned no music URL.');
        const dl=await downloadHfMedia(url,signal,'Stable Audio Open Music',64*1024*1024,'audio/wav');
        return {bytes:dl.bytes,mime:dl.mime,provider:'Stable Audio Open 1.0'};
      };

      const runAceStep=async()=>{
        const app=await Client.connect('ACE-Step/ACE-Step',opts);
        const res=await app.predict('/__call__',{
          audio_duration:dur,
          prompt:cleanPrompt,
          lyrics:String(lyrics||'').trim()||'[inst]',
          infer_step:45,
          guidance_scale:15.0,
          scheduler_type:'euler',
          cfg_type:'apg',
          omega_scale:10.0,
        });
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','ACE-Step returned no music URL.');
        const dl=await downloadHfMedia(url,signal,'ACE-Step Music',64*1024*1024,'audio/wav');
        return {bytes:dl.bytes,mime:dl.mime,provider:'ACE-Step 3.5B'};
      };

      const runMusicGen=async()=>{
        const app=await Client.connect('facebook/MusicGen',opts);
        const res=await app.predict('/predict_batched',{texts:cleanPrompt,melodies:null});
        const url=extractGradioMediaUrl(res?.data);
        if(!url) throw new ServiceError(502,'BAD_AUDIO_RESPONSE','MusicGen returned no audio URL.');
        const dl=await downloadHfMedia(url,signal,'Meta MusicGen',64*1024*1024,'audio/wav');
        return {bytes:dl.bytes,mime:dl.mime,provider:'Meta MusicGen'};
      };

      if(picked==='stable-audio') return runStableMusic();
      if(picked==='ace-step') return runAceStep();
      if(picked==='musicgen') return runMusicGen();

      const chain=lyrics&&String(lyrics).trim()?[runAceStep,runStableMusic,runMusicGen]:[runStableMusic,runAceStep,runMusicGen];
      let lastErr=null;
      for(const step of chain) {
        try {
          signal?.throwIfAborted();
          return await step();
        } catch(e) {
          if(signal?.aborted) throw e;
          lastErr=e;
        }
      }
      throw lastErr||new ServiceError(503,'PROVIDER_QUOTA','Free AI music models are busy right now. Retry in a moment.');
    },
    async synthesizeSpeech({text,language='en',gender='female',model='auto'},signal) {
      const clean=String(text||'').trim().slice(0,2500);
      if(!clean) throw new ServiceError(400,'EMPTY_TEXT','Enter narration text to speak.');
      const langCode=String(language||'en').toLowerCase().slice(0,2);
      const voice=pickEdgeVoice(langCode,gender);
      const picked=String(model||'auto').toLowerCase();

      // 1. Free keyless Microsoft Edge Neural TTS v2 (msedge-tts >= 2.1.1 with v2 Sec-MS-GEC token; supports Telugu, Hindi, Tamil, English + 20+ languages).
      const runEdgeNeural=async()=>{
        const ttsLib=edgeTtsImpl||require('msedge-tts');
        const tts=new ttsLib.MsEdgeTTS();
        await tts.setMetadata(voice,ttsLib.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        signal?.throwIfAborted();
        const streamRes=await tts.toStream(clean);
        const audioStream=streamRes.audioStream;
        const chunks=[];let total=0;
        try {
          await new Promise((resolve,reject)=>{
            const onAbort=()=>{try{audioStream.destroy();}catch{}reject(new ServiceError(408,'EXPIRED','Narration request cancelled.'));};
            signal?.addEventListener('abort',onAbort,{once:true});
            audioStream.on('data',d=>{total+=d.length;if(total>32*1024*1024){audioStream.destroy();reject(new ServiceError(502,'RESPONSE_TOO_LARGE','Generated audio exceeded limit.'));return;}chunks.push(Buffer.from(d));});
            audioStream.on('end',()=>{signal?.removeEventListener('abort',onAbort);resolve();});
            audioStream.on('close',()=>{signal?.removeEventListener('abort',onAbort);resolve();});
            audioStream.on('error',err=>{signal?.removeEventListener('abort',onAbort);reject(err);});
          });
        } finally {
          try{if(typeof tts.close==='function') tts.close();}catch{}
        }
        const buf=Buffer.concat(chunks);
        if(buf.length<=200) throw new ServiceError(502,'TTS_EMPTY','Edge Neural TTS returned empty audio.');
        return {bytes:buf,mime:'audio/mpeg',voice,provider:'Edge Neural TTS'};
      };

      // 2. Free keyless Google Translate TTS multi-chunk MP3 synthesis (supports Telugu te, Hindi hi, Tamil ta, Kannada kn, Malayalam ml, Bengali bn, Marathi mr, Gujarati gu, Urdu ur, English en, etc.).
      const runGoogleTts=async()=>{
        const gtts=googleTtsImpl||require('google-tts-api');
        const items=gtts.getAllAudioUrls(clean,{
          lang:langCode,
          slow:false,
          host:'https://translate.google.com',
          splitPunct:',.?!।॥\n',
        });
        if(!items?.length) throw new ServiceError(502,'TTS_EMPTY','Could not segment text for Google TTS.');
        const mp3Parts=[];
        for(const item of items) {
          signal?.throwIfAborted();
          const res=await fetchImpl(item.url,{
            headers:{'User-Agent':'Mozilla/5.0'},
            signal,
            redirect:'follow',
          });
          await requireSuccess(res,'Google Translate TTS');
          mp3Parts.push(await readBounded(res,8*1024*1024,signal));
        }
        const combined=Buffer.concat(mp3Parts);
        if(combined.length<=100) throw new ServiceError(502,'TTS_EMPTY','Google Translate TTS returned empty audio.');
        return {bytes:combined,mime:'audio/mpeg',voice:`google-${langCode}`,provider:'Google Translate TTS'};
      };

      // 3. Free Hugging Face Qwen3-TTS 1.7B Space (supports Auto + major global languages).
      const runQwen3Tts=async()=>{
        const {Client}=await loadGradioClient();
        const opts=hfToken?{token:hfToken}:{};
        const qLang=QWEN_TTS_LANGS[langCode]||'Auto';
        const speaker=gender==='male'?'Ryan':'Serena';
        const app=await Client.connect('Qwen/Qwen3-TTS',opts);
        const res=await app.predict('/generate_custom_voice',{
          text:clean,
          language:qLang,
          speaker,
          instruct:'',
          model_size:'1.7B',
        });
        const mediaUrl=extractGradioMediaUrl(res?.data);
        if(!mediaUrl) throw new ServiceError(502,'TTS_EMPTY','Qwen3-TTS returned no audio URL.');
        const dl=await downloadHfMedia(mediaUrl,signal,'Qwen3-TTS',32*1024*1024,'audio/wav');
        return {bytes:dl.bytes,mime:dl.mime,voice:`qwen3-${speaker.toLowerCase()}`,provider:'Qwen3-TTS 1.7B'};
      };

      // 4. OpenAI TTS fallback if OPENAI_API_KEY is configured.
      const runOpenAiTts=async()=>{
        if(!openaiKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','OPENAI_API_KEY is not configured.');
        const oaVoice=gender==='male'?'onyx':'nova';
        const response=await fetchImpl('https://api.openai.com/v1/audio/speech',{
          method:'POST',
          headers:{Authorization:'Bearer '+openaiKey,'Content-Type':'application/json'},
          body:JSON.stringify({model:'tts-1',voice:oaVoice,input:clean,response_format:'mp3'}),
          signal,redirect:'error',
        });
        await requireSuccess(response,'OpenAI TTS');
        return {bytes:await readBounded(response,32*1024*1024,signal),mime:'audio/mpeg',voice:oaVoice,provider:'OpenAI TTS'};
      };

      if(picked==='edge-neural') return runEdgeNeural();
      if(picked==='google-tts') return runGoogleTts();
      if(picked==='qwen3-tts') return runQwen3Tts();
      if(picked==='openai-tts') return runOpenAiTts();

      // Auto mode: Edge Neural TTS v2 -> Google Translate TTS (covers all Indic & world languages keylessly!) -> Qwen3-TTS -> OpenAI
      const chain=[runEdgeNeural,runGoogleTts];
      if(QWEN_TTS_LANGS[langCode]) chain.push(runQwen3Tts);
      if(openaiKey) chain.push(runOpenAiTts);

      let lastErr=null;
      for(const step of chain) {
        try {
          signal?.throwIfAborted();
          return await step();
        } catch(e) {
          if(signal?.aborted) throw e;
          lastErr=e;
        }
      }
      throw lastErr||new ServiceError(502,'TTS_UNAVAILABLE','Multilingual voice synthesis is temporarily unavailable. Please try again.');
    },
  };
}
module.exports={createProviders,ServiceError,readBounded,pickEdgeVoice,IMAGE_SIZES,VIDEO_SIZES};

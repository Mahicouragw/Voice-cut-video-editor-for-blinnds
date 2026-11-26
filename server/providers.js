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
function pickEdgeVoice(language,gender='female') {
  const code=String(language||'en').toLowerCase().slice(0,2);
  const entry=EDGE_VOICES[code]||EDGE_VOICES.en;
  return gender==='male'?entry.male:entry.female;
}
function createProviders({openaiKey,elevenKey,groqKey,deepgramKey,assemblyKey,cfAccountId,cfApiToken,pollinationsKey,falKey,replicateToken,hfToken,gradioClientImpl,edgeTtsImpl,fetchImpl=fetch}={}) {
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
        if(v.image) { const hit=visit(v.image); if(hit) return hit; }
        for(const val of Object.values(v)) { const hit=visit(val); if(hit) return hit; }
      }
      return null;
    };
    return visit(data);
  }
  return {
    configured:{
      captions:Object.values(captionKeys).some(Boolean),
      isolation:!!elevenKey,
      captionProviders:{openai:!!openaiKey,groq:!!groqKey,deepgram:!!deepgramKey,assemblyai:!!assemblyKey},
      imageGen:true,
      videoGen:true, // Free Hugging Face ZeroGPU Spaces + optional Pollinations/fal/Replicate
      tts:true,
      imageProviders:{cloudflare:cfReady,hfZeroGpu:true,pollinations:!!pollinationsKey,fal:!!falKey,freeFallback:true},
      videoProviders:{hfZeroGpu:true,pollinations:!!pollinationsKey,fal:!!falKey,replicate:!!replicateToken},
    },
    async transcribe(file,language,signal,provider='openai') {
      if(!captionKeys.hasOwnProperty(provider)) throw new ServiceError(400,'UNKNOWN_PROVIDER','Unknown caption provider: '+provider);
      const key=captionKeys[provider];
      if(!key) throw new ServiceError(503,'KEY_NOT_CONFIGURED',envNames[provider]+' is missing from the server Environment settings.');
      const data=await fs.readFile(file);signal.throwIfAborted();
      if(provider==='openai'||provider==='groq') {
        // Groq exposes an OpenAI-compatible transcription endpoint, including verbose_json timestamps.
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
      // AssemblyAI: upload the audio, create a transcription job, then poll for completion.
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
    async generateImage({prompt,aspectRatio='16:9',preset='general',seed},signal) {
      const cleanPrompt=String(prompt||'').trim().slice(0,1800);
      if(!cleanPrompt) throw new ServiceError(400,'EMPTY_PROMPT','Enter a description for the image you want to generate.');
      const dims=IMAGE_SIZES[aspectRatio]||IMAGE_SIZES['16:9'];
      const prefix=preset==='thumbnail'?'High-contrast vibrant YouTube thumbnail, expressive focal subject, crisp studio lighting, eye-catching composition: '
        :preset==='logo'?'Clean modern vector brand logo mark, centered icon, crisp geometric shapes, high contrast, minimalist emblem design: '
        :preset==='social'?'Polished social media post graphic, cinematic framing, vibrant colors, crisp detail: ':'';
      const fullPrompt=(prefix+cleanPrompt).slice(0,1950);
      const chosenSeed=Number.isInteger(seed)?seed:Math.floor(Math.random()*1000000);
      // 1. Cloudflare Workers AI FLUX.1-schnell (~170 free images/day, resets daily at 00:00 UTC).
      if(cfReady) {
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
      }
      // 2. Pollinations authenticated unified endpoint (FLUX, no logo watermark).
      if(pollinationsKey) {
        const params=new URLSearchParams({model:'flux',width:String(dims.width),height:String(dims.height),seed:String(chosenSeed),nologo:'true'});
        const url=`https://gen.pollinations.ai/image/${encodeURIComponent(fullPrompt)}?${params}`;
        const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+pollinationsKey},signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations');
        const ctype=response.headers.get('content-type')||'image/jpeg';
        if(!ctype.startsWith('image/')) {await response.body?.cancel().catch(()=>{});throw new ServiceError(502,'BAD_IMAGE_RESPONSE','Pollinations did not return an image.');}
        return {bytes:await readBounded(response,20*1024*1024,signal),mime:ctype.split(';')[0],provider:'Pollinations FLUX'};
      }
      // 3. fal.ai FLUX.1-schnell if FAL_KEY is configured.
      if(falKey) {
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
      }
      // 4. Keyless Pollinations classic endpoint fallback (up to 768px area, rate-limited per IP).
      try {
        const scale=Math.min(1,768/Math.max(dims.width,dims.height));
        const fw=Math.max(256,Math.round(dims.width*scale/16)*16),fh=Math.max(256,Math.round(dims.height*scale/16)*16);
        const classicUrl=`https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=${fw}&height=${fh}&seed=${chosenSeed}`;
        const response=await fetchImpl(classicUrl,{signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations Free');
        const ctype=response.headers.get('content-type')||'';
        if(ctype.startsWith('image/')) {
          return {bytes:await readBounded(response,20*1024*1024,signal),mime:ctype.split(';')[0],provider:'Pollinations Free'};
        }
        await response.body?.cancel().catch(()=>{});
      } catch(e) {
        if(signal?.aborted) throw e;
      }
      // 5. Free Hugging Face ZeroGPU FLUX.1-schnell Space fallback (no paid credits needed!).
      try {
        const {Client}=await loadGradioClient();
        const opts=hfToken?{token:hfToken}:{};
        const app=await Client.connect('black-forest-labs/FLUX.1-schnell',opts);
        const res=await app.predict('/infer',{prompt:fullPrompt,seed:chosenSeed,randomize_seed:false,width:dims.width,height:dims.height,num_inference_steps:4});
        const mediaUrl=extractGradioMediaUrl(res?.data);
        if(mediaUrl) {
          const dl=await fetchImpl(mediaUrl,{signal,redirect:'follow'});
          await requireSuccess(dl,'Hugging Face ZeroGPU FLUX');
          return {bytes:await readBounded(dl,24*1024*1024,signal),mime:(dl.headers.get('content-type')||'image/webp').split(';')[0],provider:'HF ZeroGPU FLUX.1-schnell'};
        }
      } catch(e) {
        if(signal?.aborted) throw e;
      }
      throw new ServiceError(503,'PROVIDER_QUOTA','Free image slots are busy right now. Add free CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN or HF_TOKEN in server Environment settings for priority daily quota.');
    },
    async generateVideo({prompt,aspectRatio='16:9',duration=5,imageDataUrl=null},signal) {
      const cleanPrompt=String(prompt||'').trim().slice(0,1800);
      if(!cleanPrompt) throw new ServiceError(400,'EMPTY_PROMPT','Enter a description for the video scene you want to generate.');
      const dur=Math.max(2,Math.min(15,Math.round(Number(duration)||5)));
      const ar=aspectRatio==='9:16'?'9:16':aspectRatio==='1:1'?'1:1':'16:9';
      // 1. Pollinations unified video generation (wan up to 15s, seedance 2-10s with start-frame image).
      if(pollinationsKey) {
        const model=imageDataUrl?'seedance':dur>10?'wan':'seedance';
        const clampedDur=model==='seedance'?Math.min(10,dur):dur;
        if(imageDataUrl) {
          // Use OpenAI-compatible chat/completions multimodal input for start-frame data URIs so large base64 strings aren't placed in query URLs.
          const chatRes=await fetchImpl('https://gen.pollinations.ai/v1/chat/completions',{
            method:'POST',
            headers:{Authorization:'Bearer '+pollinationsKey,'Content-Type':'application/json'},
            body:JSON.stringify({
              model,
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
          return {bytes:await readBounded(dl,100*1024*1024,signal),mime:'video/mp4',provider:`Pollinations ${model}`};
        }
        const params=new URLSearchParams({model,duration:String(clampedDur),aspectRatio:ar==='1:1'?'16:9':ar});
        const url=`https://gen.pollinations.ai/image/${encodeURIComponent(cleanPrompt)}?${params}`;
        const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+pollinationsKey},signal,redirect:'follow'});
        await requireSuccess(response,'Pollinations Video');
        const ctype=response.headers.get('content-type')||'';
        if(!ctype.startsWith('video/')&&!ctype.startsWith('application/octet-stream')) {
          await response.body?.cancel().catch(()=>{});
          throw new ServiceError(502,'BAD_VIDEO_RESPONSE','Pollinations did not return a video file.');
        }
        return {bytes:await readBounded(response,100*1024*1024,signal),mime:'video/mp4',provider:`Pollinations ${model}`};
      }
      // 2. fal.ai queue API (Wan-2.1 / Kling / LTX-Video).
      if(falKey) {
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
      }
      // 3. Replicate API (Wan 2.1) if REPLICATE_API_TOKEN is configured.
      if(replicateToken) {
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
      }
      // 4. Free Hugging Face ZeroGPU Spaces (Wan 2.1 & LTX-Video — works free, higher daily quota with free HF_TOKEN!).
      const {Client,handle_file}=await loadGradioClient();
      const opts=hfToken?{token:hfToken}:{};
      let imageBlob=null;
      if(imageDataUrl&&imageDataUrl.startsWith('data:')) {
        const parts=imageDataUrl.split(',');
        const mime=(parts[0].match(/data:([^;]+)/)||[])[1]||'image/jpeg';
        imageBlob=new Blob([Buffer.from(parts[1]||'','base64')],{type:mime});
      }
      const spaceCandidates=imageBlob
        ? [
            {space:'Lightricks/ltx-video-distilled',fn:'/image_to_video',args:{prompt:cleanPrompt,image:handle_file?handle_file(imageBlob):imageBlob}},
            {space:'Wan-AI/Wan2.1',fn:'/i2v_generation',args:{img2vid_prompt:cleanPrompt,img2vid_image:handle_file?handle_file(imageBlob):imageBlob}},
          ]
        : [
            {space:'Lightricks/ltx-video-distilled',fn:'/text_to_video',args:{prompt:cleanPrompt}},
            {space:'Wan-AI/Wan2.1',fn:'/t2v_generation',args:{txt2vid_prompt:cleanPrompt}},
          ];
      for(const cand of spaceCandidates) {
        try {
          signal?.throwIfAborted();
          const app=await Client.connect(cand.space,opts);
          const res=await app.predict(cand.fn,cand.args);
          const videoUrl=extractGradioMediaUrl(res?.data);
          if(videoUrl) {
            const dl=await fetchImpl(videoUrl,{headers:hfToken?{Authorization:'Bearer '+hfToken}:{},signal,redirect:'follow'});
            await requireSuccess(dl,'Hugging Face ZeroGPU Video');
            return {bytes:await readBounded(dl,100*1024*1024,signal),mime:'video/mp4',provider:`HF ZeroGPU (${cand.space})`};
          }
        } catch(e) {
          if(signal?.aborted) throw e;
        }
      }
      throw new ServiceError(503,'PROVIDER_QUOTA','Free ZeroGPU video queue is currently full. Add a free HF_TOKEN (https://huggingface.co/settings/tokens) in server Environment settings for priority ZeroGPU access, or use Instant AI Storyboard Video mode which always runs with zero wait.');
    },
    async synthesizeSpeech({text,language='en',gender='female'},signal) {
      const clean=String(text||'').trim().slice(0,2500);
      if(!clean) throw new ServiceError(400,'EMPTY_TEXT','Enter narration text to speak.');
      const voice=pickEdgeVoice(language,gender);
      // 1. Free keyless Microsoft Edge Neural TTS (supports Telugu, Hindi, Tamil, English + 20+ languages).
      try {
        const ttsLib=edgeTtsImpl||require('msedge-tts');
        const tts=new ttsLib.MsEdgeTTS();
        await tts.setMetadata(voice,ttsLib.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        signal?.throwIfAborted();
        const {audioStream}=await tts.toStream(clean);
        const chunks=[];let total=0;
        await new Promise((resolve,reject)=>{
          const onAbort=()=>{try{audioStream.destroy();}catch{}reject(new ServiceError(408,'EXPIRED','Narration request cancelled.'));};
          signal?.addEventListener('abort',onAbort,{once:true});
          audioStream.on('data',d=>{total+=d.length;if(total>32*1024*1024){audioStream.destroy();reject(new ServiceError(502,'RESPONSE_TOO_LARGE','Generated audio exceeded limit.'));return;}chunks.push(Buffer.from(d));});
          audioStream.on('end',()=>{signal?.removeEventListener('abort',onAbort);resolve();});
          audioStream.on('close',()=>{signal?.removeEventListener('abort',onAbort);resolve();});
          audioStream.on('error',err=>{signal?.removeEventListener('abort',onAbort);reject(err);});
        });
        const buf=Buffer.concat(chunks);
        if(buf.length>200) return {bytes:buf,mime:'audio/mpeg',voice,provider:'Edge Neural TTS'};
      } catch(e) {
        if(signal?.aborted) throw e;
        if(!openaiKey) throw new ServiceError(502,'TTS_UNAVAILABLE','Multilingual voice synthesis is temporarily unavailable. Please try again.');
      }
      // 2. OpenAI TTS fallback when OPENAI_API_KEY is present.
      const oaVoice=gender==='male'?'onyx':'nova';
      const response=await fetchImpl('https://api.openai.com/v1/audio/speech',{
        method:'POST',
        headers:{Authorization:'Bearer '+openaiKey,'Content-Type':'application/json'},
        body:JSON.stringify({model:'tts-1',voice:oaVoice,input:clean,response_format:'mp3'}),
        signal,redirect:'error',
      });
      await requireSuccess(response,'OpenAI TTS');
      return {bytes:await readBounded(response,32*1024*1024,signal),mime:'audio/mpeg',voice:oaVoice,provider:'OpenAI TTS'};
    }
  };
}
module.exports={createProviders,ServiceError,readBounded,pickEdgeVoice,IMAGE_SIZES};

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
function createProviders({openaiKey,elevenKey,groqKey,deepgramKey,assemblyKey,fetchImpl=fetch}={}) {
  const captionKeys={openai:openaiKey,groq:groqKey,deepgram:deepgramKey,assemblyai:assemblyKey};
  const envNames={openai:'OPENAI_API_KEY',groq:'GROQ_API_KEY',deepgram:'DEEPGRAM_API_KEY',assemblyai:'ASSEMBLYAI_API_KEY'};
  return {
    configured:{
      captions:Object.values(captionKeys).some(Boolean),
      isolation:!!elevenKey,
      captionProviders:{openai:!!openaiKey,groq:!!groqKey,deepgram:!!deepgramKey,assemblyai:!!assemblyKey},
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
        if(language) params.set('language',language);
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
      const created=await fetchImpl('https://api.assemblyai.com/v2/transcript',{method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},body:JSON.stringify({audio_url,...(language?{language_code:language}:{})}),signal,redirect:'error'});
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
    }
  };
}
module.exports={createProviders,ServiceError,readBounded};

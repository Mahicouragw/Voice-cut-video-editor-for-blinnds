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
async function requireSuccess(response,name) {
  if(response.ok) return;
  await response.body?.cancel().catch(()=>{});
  // Do not return arbitrary provider error bodies: they may contain sensitive details.
  if([401,403].includes(response.status)) throw new ServiceError(502,'PROVIDER_AUTH',`${name} rejected the server API key or its permissions. Update it in your host Environment settings.`);
  if(response.status===429) throw new ServiceError(503,'PROVIDER_QUOTA',`${name} quota or rate limit reached. Check API billing/credits, then retry manually.`);
  if(response.status===402) throw new ServiceError(503,'PROVIDER_BILLING',`${name} requires available credits or API billing.`);
  if(response.status>=500) throw new ServiceError(503,'PROVIDER_UNAVAILABLE',`${name} is temporarily unavailable. No automatic paid retry was made.`);
  throw new ServiceError(502,'PROVIDER_REJECTED',`${name} rejected the audio request (HTTP ${response.status}). Check supported media and account access.`);
}
function createProviders({openaiKey,elevenKey,fetchImpl=fetch}={}) {
  return {
    configured:{captions:!!openaiKey,isolation:!!elevenKey},
    async transcribe(file,language,signal) {
      if(!openaiKey) throw new ServiceError(503,'KEY_NOT_CONFIGURED','OPENAI_API_KEY is missing from the server Environment settings.');
      const data=await fs.readFile(file);signal.throwIfAborted();
      const form=new FormData();form.append('file',new Blob([data],{type:'audio/mpeg'}),'speech.mp3');
      form.append('model','whisper-1');form.append('response_format','verbose_json');
      form.append('timestamp_granularities[]','word');form.append('timestamp_granularities[]','segment');
      if(language) form.append('language',language);
      const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+openaiKey},body:form,signal,redirect:'error'});
      await requireSuccess(response,'OpenAI');
      try{return JSON.parse((await readBounded(response,4*1024*1024,signal)).toString());}
      catch(e){if(e instanceof ServiceError || signal.aborted) throw e;throw new ServiceError(502,'BAD_TRANSCRIPT','OpenAI returned an unreadable transcript.');}
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

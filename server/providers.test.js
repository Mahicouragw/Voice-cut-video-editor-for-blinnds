const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createProviders}=require('./providers');
const withFile=async fn=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vc-provider-'));const file=path.join(dir,'input.mp3');fs.writeFileSync(file,Buffer.from('test fixture'));try{await fn(file);}finally{fs.rmSync(dir,{recursive:true,force:true});}};
test('OpenAI contract uses correct endpoint, key, whisper timestamps and optional language',()=>withFile(async file=>{
 const p=createProviders({openaiKey:'PRIVATE-OPENAI',fetchImpl:async(url,request)=>{
  assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(request.headers.Authorization,'Bearer PRIVATE-OPENAI');
  assert.equal(request.body.get('model'),'whisper-1');assert.equal(request.body.get('response_format'),'verbose_json');assert.deepEqual(request.body.getAll('timestamp_granularities[]'),['word','segment']);assert.equal(request.body.get('language'),'te');
  assert.ok(request.body.get('file') instanceof Blob);assert.equal(request.redirect,'error');return Response.json({words:[],language:'telugu'});
 }});
 assert.equal((await p.transcribe(file,'te',new AbortController().signal)).language,'telugu');
}));
test('ElevenLabs contract uses audio isolation endpoint and xi-api-key',()=>withFile(async file=>{
 const p=createProviders({elevenKey:'PRIVATE-ELEVEN',fetchImpl:async(url,request)=>{
  assert.equal(url,'https://api.elevenlabs.io/v1/audio-isolation');assert.equal(request.headers['xi-api-key'],'PRIVATE-ELEVEN');assert.ok(request.body.get('audio') instanceof Blob);assert.equal(request.body.get('file_format'),'other');return new Response(Buffer.from('binary audio'),{headers:{'content-type':'audio/mpeg'}});
 }});
 assert.equal((await p.isolate(file,new AbortController().signal)).toString(),'binary audio');
}));
test('provider authentication and quota errors are sanitized and never auto-retried',()=>withFile(async file=>{
 for(const [status,code] of [[401,'PROVIDER_AUTH'],[403,'PROVIDER_AUTH'],[429,'PROVIDER_QUOTA'],[402,'PROVIDER_BILLING'],[500,'PROVIDER_UNAVAILABLE']]){
  let calls=0;const p=createProviders({openaiKey:'SECRET-NEVER-RETURN',fetchImpl:async()=>{calls++;return new Response('SECRET-NEVER-RETURN',{status});}});
  await assert.rejects(p.transcribe(file,'',new AbortController().signal),e=>e.code===code&&!e.message.includes('SECRET-NEVER-RETURN'));assert.equal(calls,1);
 }
}));
test('missing provider key fails locally before network',()=>withFile(async file=>{let calls=0;const p=createProviders({fetchImpl:async()=>calls++});await assert.rejects(p.transcribe(file,'',new AbortController().signal),e=>e.code==='KEY_NOT_CONFIGURED');assert.equal(calls,0);}));
test('Groq contract uses OpenAI-compatible endpoint with whisper-large-v3-turbo',()=>withFile(async file=>{
 const p=createProviders({groqKey:'PRIVATE-GROQ',fetchImpl:async(url,request)=>{
  assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');assert.equal(request.headers.Authorization,'Bearer PRIVATE-GROQ');
  assert.equal(request.body.get('model'),'whisper-large-v3-turbo');assert.equal(request.body.get('response_format'),'verbose_json');assert.deepEqual(request.body.getAll('timestamp_granularities[]'),['word','segment']);
  return Response.json({words:[{word:'hi',start:0,end:0.5}],language:'english'});
 }});
 assert.equal((await p.transcribe(file,'',new AbortController().signal,'groq')).language,'english');
}));
test('Deepgram contract uses Token auth and normalizes timed words',()=>withFile(async file=>{
 const p=createProviders({deepgramKey:'PRIVATE-DEEPGRAM',fetchImpl:async(url,request)=>{
  const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,'https://api.deepgram.com/v1/listen');
  assert.equal(parsed.searchParams.get('model'),'nova-3');assert.equal(parsed.searchParams.get('utterances'),'true');assert.equal(parsed.searchParams.get('language'),'hi');
  assert.equal(request.headers.Authorization,'Token PRIVATE-DEEPGRAM');assert.equal(request.headers['Content-Type'],'audio/mpeg');assert.equal(request.redirect,'error');
  return Response.json({results:{channels:[{detected_language:'hi',alternatives:[{words:[{word:'namaste',punctuated_word:'Namaste',start:0.1,end:0.8}]}]}]}});
 }});
 const transcript=await p.transcribe(file,'hi',new AbortController().signal,'deepgram');
 assert.equal(transcript.language,'hi');assert.equal(transcript.words[0].word,'Namaste');assert.equal(transcript.words[0].start,0.1);
}));
test('AssemblyAI uploads audio, polls once, and converts millisecond words to seconds',()=>withFile(async file=>{
 let stage=0;const p=createProviders({assemblyKey:'PRIVATE-ASSEMBLY',fetchImpl:async(url,request)=>{
  stage++;const target=String(url);
  if(target.endsWith('/v2/upload')){assert.equal(request.headers.Authorization,'PRIVATE-ASSEMBLY');assert.ok(request.body instanceof Buffer||request.body instanceof Uint8Array);return Response.json({upload_url:'https://assembly.ai/audio'});}
  if(target.endsWith('/v2/transcript')&&request.method==='POST'){assert.equal('speech_model' in JSON.parse(request.body),false);return Response.json({id:'job1'});}
  assert.equal(target,'https://api.assemblyai.com/v2/transcript/job1');
  if(stage===3)return Response.json({status:'processing'});
  return Response.json({status:'completed',language_code:'en',words:[{text:'Hello',start:100,end:900,confidence:0.99}]});
 }});
 const transcript=await p.transcribe(file,'',new AbortController().signal,'assemblyai');
 assert.equal(transcript.words[0].word,'Hello');assert.equal(transcript.words[0].start,0.1);assert.equal(transcript.words[0].end,0.9);assert.ok(stage>=4);
}));
test('unknown or unconfigured caption provider fails locally with exact key name',()=>withFile(async file=>{
 let calls=0;const p=createProviders({groqKey:'PRIVATE-GROQ',fetchImpl:async()=>{calls++;return Response.json({});}});
 assert.deepEqual(p.configured.captionProviders,{openai:false,groq:true,deepgram:false,assemblyai:false});assert.equal(p.configured.captions,true);
 await assert.rejects(p.transcribe(file,'',new AbortController().signal,'nope'),e=>e.code==='UNKNOWN_PROVIDER');
 await assert.rejects(p.transcribe(file,'',new AbortController().signal,'deepgram'),e=>e.code==='KEY_NOT_CONFIGURED'&&e.message.includes('DEEPGRAM_API_KEY'));
 assert.equal(calls,0);
}));
test('Deepgram auto language sends detect_language instead of defaulting to English',()=>withFile(async file=>{
 const p=createProviders({deepgramKey:'PRIVATE-DEEPGRAM',fetchImpl:async(url)=>{
  const parsed=new URL(url);assert.equal(parsed.searchParams.get('detect_language'),'true');assert.equal(parsed.searchParams.get('language'),null);
  return Response.json({results:{channels:[{detected_language:'te',alternatives:[{words:[{word:'oka',start:0,end:0.5}]}]}]}});
 }});
 assert.equal((await p.transcribe(file,'',new AbortController().signal,'deepgram')).language,'te');
}));
test('AssemblyAI auto language enables language_detection',()=>withFile(async file=>{
 const p=createProviders({assemblyKey:'PRIVATE-ASSEMBLY',fetchImpl:async(url,request)=>{
  const target=String(url);
  if(target.endsWith('/v2/upload'))return Response.json({upload_url:'https://assembly.ai/audio'});
  if(target.endsWith('/v2/transcript')&&request.method==='POST'){assert.equal(JSON.parse(request.body).language_detection,true);return Response.json({id:'job9'});}
  return Response.json({status:'completed',language_code:'hi',words:[]});
 }});
 assert.equal((await p.transcribe(file,'',new AbortController().signal,'assemblyai')).language,'hi');
}));
test('Cloudflare Workers AI FLUX image generation decodes base64 result and falls back to Pollinations Free when keyless',async()=>{
 const fakeImg=Buffer.from([0xff,0xd8,0xff,0xd9]);
 const cf=createProviders({cfAccountId:'acc123',cfApiToken:'tok456',fetchImpl:async(url,req)=>{
  assert.ok(String(url).includes('/accounts/acc123/ai/run/@cf/black-forest-labs/flux-1-schnell'));
  assert.equal(req.headers.Authorization,'Bearer tok456');
  const body=JSON.parse(req.body);
  assert.match(body.prompt,/YouTube thumbnail/);
  return Response.json({result:{image:fakeImg.toString('base64')}});
 }});
 const out=await cf.generateImage({prompt:'Creator smiling',aspectRatio:'16:9',preset:'thumbnail'},new AbortController().signal);
 assert.equal(out.provider,'Cloudflare FLUX.1-schnell');
 assert.deepEqual(out.bytes,fakeImg);

 const keyless=createProviders({fetchImpl:async(url)=>{
  assert.ok(String(url).startsWith('https://image.pollinations.ai/prompt/'));
  return new Response(fakeImg,{headers:{'content-type':'image/jpeg'}});
 }});
 const freeOut=await keyless.generateImage({prompt:'Minimalist lotus logo',aspectRatio:'1:1',preset:'logo'},new AbortController().signal);
 assert.equal(freeOut.provider,'Pollinations Free');
 assert.deepEqual(freeOut.bytes,fakeImg);
});
test('Pollinations video generation supports text-to-video up to 15s (wan) and image-to-video (seedance)',async()=>{
 const fakeMp4=Buffer.from('00000018667479706d703432','hex');
 const seen=[];
 const p=createProviders({pollinationsKey:'sk_poll_test',fetchImpl:async(url,req)=>{
  seen.push({url:String(url),method:req?.method||'GET'});
  if(String(url).includes('/v1/chat/completions')){
   const body=JSON.parse(req.body);
   assert.equal(body.model,'seedance');
   assert.equal(body.messages[0].content[1].type,'image_url');
   return Response.json({choices:[{message:{content:'[video](https://gen.pollinations.ai/media/vid1.mp4)'}}]});
  }
  return new Response(fakeMp4,{headers:{'content-type':'video/mp4'}});
 }});
 const t2v=await p.generateVideo({prompt:'Sunrise over Hyderabad Charminar',aspectRatio:'9:16',duration:15},new AbortController().signal);
 assert.equal(t2v.provider,'Pollinations wan');
 assert.ok(seen[0].url.includes('model=wan')&&seen[0].url.includes('duration=15')&&seen[0].url.includes('aspectRatio=9%3A16'));
 const i2v=await p.generateVideo({prompt:'Gentle camera pan',aspectRatio:'16:9',duration:8,imageDataUrl:'data:image/png;base64,AAAA'},new AbortController().signal);
 assert.equal(i2v.provider,'Pollinations seedance');
});
test('multilingual Edge Neural TTS selects Telugu/Hindi/English voices without API keys',async()=>{
 const {Readable}=require('node:stream');
 let chosenVoice='';
 const fakeEdge={
  OUTPUT_FORMAT:{AUDIO_24KHZ_96KBITRATE_MONO_MP3:'mp3'},
  MsEdgeTTS:class{
   async setMetadata(v){chosenVoice=v;}
   async toStream(){return {audioStream:Readable.from([Buffer.alloc(300,0x55)])};}
  }
 };
 const p=createProviders({edgeTtsImpl:fakeEdge});
 const res=await p.synthesizeSpeech({text:'నమస్కారం మిత్రులారా',language:'te',gender:'female'},new AbortController().signal);
 assert.equal(chosenVoice,'te-IN-ShrutiNeural');
 assert.equal(res.provider,'Edge Neural TTS');
 assert.equal(res.bytes.length,300);
});
test('free Hugging Face ZeroGPU Spaces fallback works for Text-to-Video and Image-to-Video with verified LTX mode and no paid keys',async()=>{
 const fakeMp4=Buffer.from('00000018667479706d703432','hex');
 const connectedSpaces=[],predicted=[];
 const fakeGradio={
  handle_file:b=>b,
  Client:{
   async connect(space,opts){
    connectedSpaces.push({space,token:opts?.token||null});
    return {
     async predict(fn,args){
      predicted.push({space,fn,args});
      return {data:[{video:{url:'https://hf.space/file/out.mp4'},fn}]};
     }
    };
   }
  }
 };
 const p=createProviders({
  hfToken:'hf_free_user_token',
  gradioClientImpl:fakeGradio,
  fetchImpl:async()=>new Response(fakeMp4,{headers:{'content-type':'video/mp4'}}),
 });
 const t2v=await p.generateVideo({prompt:'Ocean waves at sunset',aspectRatio:'16:9',duration:8},new AbortController().signal);
 assert.match(t2v.provider,/HF ZeroGPU/);
 assert.equal(connectedSpaces[0].token,'hf_free_user_token');
 assert.equal(predicted[0].fn,'/text_to_video');
 assert.equal(predicted[0].args.mode,'text-to-video');
 assert.ok(predicted[0].args.duration_ui<=7);
 const i2v=await p.generateVideo({prompt:'Clouds drifting',aspectRatio:'9:16',duration:8,imageDataUrl:'data:image/png;base64,AAAA'},new AbortController().signal);
 assert.match(i2v.provider,/HF ZeroGPU/);
 assert.equal(predicted[1].fn,'/image_to_video');
 assert.equal(predicted[1].args.mode,'image-to-video');
});

test('multilingual TTS automatically falls back to keyless Google Translate TTS if Edge Neural fails, and honors explicit model picker',async()=>{
 const mp3Chunk=Buffer.alloc(240,0x49);
 const failingEdge={
  OUTPUT_FORMAT:{AUDIO_24KHZ_96KBITRATE_MONO_MP3:'mp3'},
  MsEdgeTTS:class{async setMetadata(){throw new Error('403 Forbidden');}}
 };
 const fakeGoogle={
  getAllAudioUrls(text,opts){
   assert.equal(opts.lang,'te');
   return [{shortText:text,url:'https://translate.google.com/translate_tts?tl=te'}];
  }
 };
 const p=createProviders({
  edgeTtsImpl:failingEdge,
  googleTtsImpl:fakeGoogle,
  fetchImpl:async()=>new Response(mp3Chunk,{headers:{'content-type':'audio/mpeg'}}),
 });
 const autoRes=await p.synthesizeSpeech({text:'నమస్కారం మిత్రులారా',language:'te',gender:'female',model:'auto'},new AbortController().signal);
 assert.equal(autoRes.provider,'Google Translate TTS');
 assert.equal(autoRes.bytes.length,240);
 const explicitRes=await p.synthesizeSpeech({text:'నమస్కారం మిత్రులారా',language:'te',gender:'male',model:'google-tts'},new AbortController().signal);
 assert.equal(explicitRes.provider,'Google Translate TTS');
});

test('MMAudio scene Foley and Stable Audio / ACE-Step music adapters pass verified Space schemas',async()=>{
 const fakeBytes=Buffer.alloc(512,0x22);
 const calls=[];
 const fakeGradio={
  handle_file:b=>b,
  Client:{
   async connect(space){
    return {
     async predict(fn,args){
      calls.push({space,fn,args});
      return {data:[{url:'https://hf.space/file/audio-out.mp4'}]};
     }
    };
   }
  }
 };
 const p=createProviders({
  hfToken:'hf_test',
  gradioClientImpl:fakeGradio,
  fetchImpl:async()=>new Response(fakeBytes,{headers:{'content-type':'audio/wav'}}),
 });
 const foley=await p.generateVideoFoley({videoBytes:Buffer.from('0000001866747970','hex'),prompt:'rain and thunder',duration:8,model:'mmaudio'},new AbortController().signal);
 assert.equal(foley.provider,'MMAudio Video-to-Audio');
 assert.equal(calls[0].space,'hkchengrex/MMAudio');
 assert.equal(calls[0].fn,'/video_to_audio');
 const mus=await p.generateMusic({prompt:'warm acoustic guitar',duration:15,model:'ace-step'},new AbortController().signal);
 assert.equal(mus.provider,'ACE-Step 3.5B');
 assert.equal(calls[1].space,'ACE-Step/ACE-Step');
 assert.equal(calls[1].fn,'/__call__');
});

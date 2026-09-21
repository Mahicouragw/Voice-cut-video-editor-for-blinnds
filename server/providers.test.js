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
test('Groq contract uses OpenAI-compatible endpoint with whisper-large-v3',()=>withFile(async file=>{
 const p=createProviders({groqKey:'PRIVATE-GROQ',fetchImpl:async(url,request)=>{
  assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');assert.equal(request.headers.Authorization,'Bearer PRIVATE-GROQ');
  assert.equal(request.body.get('model'),'whisper-large-v3');assert.equal(request.body.get('response_format'),'verbose_json');assert.deepEqual(request.body.getAll('timestamp_granularities[]'),['word','segment']);
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
  if(target.endsWith('/v2/transcript')&&request.method==='POST'){assert.equal(JSON.parse(request.body).speech_model,'universal');return Response.json({id:'job1'});}
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

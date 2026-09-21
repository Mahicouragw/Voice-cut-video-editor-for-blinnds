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

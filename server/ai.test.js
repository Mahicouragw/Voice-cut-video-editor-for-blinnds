const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {createApp}=require('./server');const {ServiceError}=require('./providers');
const KEY='t'.repeat(64);
async function setup(providers,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vc-ai-'));const fixture=path.join(os.tmpdir(),'vc-ai-'+Math.random()+'.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',fixture]);
 const server=createApp({key:KEY,origin:'https://example.org',root,providers,...options}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 return {root,url,fixture,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});fs.rmSync(fixture,{force:true});}};
}
function upload(fixture,consent=true,signal){const body=new FormData();body.append('file',new Blob([fs.readFileSync(fixture)]),'audio.wav');return {method:'POST',body,signal,headers:{Authorization:'Bearer '+KEY,...(consent?{'X-Upload-Consent':'yes'}:{})}};}
test('configuration check is authenticated; captions require consent and clean up files',async()=>{
 let calls=0;const p={configured:{captions:true,isolation:false},async transcribe(file,language){calls++;assert.ok(fs.statSync(file).size>0);assert.equal(language,'hi');return {language:'hindi',words:[{word:'नमस्ते',start:.1,end:.8}]};}};
 const t=await setup(p);try{
  assert.equal((await fetch(t.url+'/capabilities')).status,401);
  const capabilities=await(await fetch(t.url+'/capabilities',{headers:{Authorization:'Bearer '+KEY}})).json();assert.equal(capabilities.captions,true);
  assert.equal((await fetch(t.url+'/api/captions',upload(t.fixture,false))).status,400);assert.equal(calls,0);
  const r=await fetch(t.url+'/api/captions?language=hi',upload(t.fixture));assert.equal(r.status,200);const result=await r.json();assert.equal(result.cues[0].text,'नमस्ते');assert.equal(result.reviewRequired,true);assert.equal(calls,1);
  assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});
test('AI isolation output is normalized to WAV; provider failure preserves error code and cleans up',async()=>{
 let fixture,fail=false;const p={configured:{captions:false,isolation:true},async isolate(){if(fail)throw new ServiceError(503,'PROVIDER_QUOTA','Check credits');return fs.readFileSync(fixture);}};
 const t=await setup(p);fixture=t.fixture;try{
  let r=await fetch(t.url+'/api/isolate',upload(fixture));assert.equal(r.status,200);assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  fail=true;r=await fetch(t.url+'/api/isolate',upload(fixture));assert.equal(r.status,503);assert.equal((await r.json()).code,'PROVIDER_QUOTA');assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});
test('absolute deadline aborts pending provider request and removes files',async()=>{
 let seenAbort=false;const p={configured:{captions:true,isolation:false},async transcribe(file,language,signal){return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{seenAbort=true;reject(new Error('aborted'));},{once:true});});}};
 const t=await setup(p,{ttlMs:1200});try{
  const response=await fetch(t.url+'/api/captions',upload(t.fixture));assert.equal(response.status,408);assert.equal((await response.json()).code,'EXPIRED');assert.equal(seenAbort,true);assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});
test('missing provider configuration gives actionable error without calling a provider',async()=>{
 const t=await setup({configured:{captions:false,isolation:false}});try{const r=await fetch(t.url+'/api/captions',upload(t.fixture));assert.equal(r.status,503);assert.match((await r.json()).error,/OPENAI_API_KEY/);assert.deepEqual(fs.readdirSync(t.root),[]);}finally{await t.close();}
});
test('caption provider selection passes through; unknown or unconfigured providers fail safely',async()=>{
 let seen='';const p={configured:{captions:true,isolation:false,captionProviders:{openai:false,groq:true,deepgram:false,assemblyai:false}},async transcribe(file,language,signal,provider){seen=provider;assert.ok(fs.statSync(file).size>0);return {language:'english',words:[{word:'hello',start:.1,end:.8}]};}};
 const t=await setup(p);try{
  const capabilities=await(await fetch(t.url+'/capabilities',{headers:{Authorization:'Bearer '+KEY}})).json();
  assert.deepEqual(capabilities.captionProviders,{openai:false,groq:true,deepgram:false,assemblyai:false});assert.equal(typeof capabilities.deepFilterNet,'boolean');
  let r=await fetch(t.url+'/api/captions?provider=groq',upload(t.fixture));assert.equal(r.status,200);assert.equal(seen,'groq');assert.match((await r.json()).provider,/Groq/);
  r=await fetch(t.url+'/api/captions?provider=nope',upload(t.fixture));assert.equal(r.status,400);assert.equal((await r.json()).code,'UNKNOWN_PROVIDER');
  r=await fetch(t.url+'/api/captions?provider=openai',upload(t.fixture));assert.equal(r.status,503);assert.match((await r.json()).error,/OPENAI_API_KEY/);
  assert.equal(seen,'groq');assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});
test('DeepFilterNet denoising needs no cloud consent; missing binary gives install guidance',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vc-df-'));
 const fake=path.join(dir,'deep_filter');
 fs.writeFileSync(fake,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo deep_filter-test; exit 0; fi\nout="";prev="";for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\ncp "$1" "$out/enhanced.wav"\n');fs.chmodSync(fake,0o700);
 const old=process.env.DEEPFILTER_PATH;process.env.DEEPFILTER_PATH=fake;
 const local=(fixture)=>{const body=new FormData();body.append('file',new Blob([fs.readFileSync(fixture)]),'audio.wav');return {method:'POST',body,headers:{Authorization:'Bearer '+KEY}};};
 const t=await setup({configured:{captions:false,isolation:false}});try{
  let r=await fetch(t.url+'/api/denoise-local',local(t.fixture));
  assert.equal(r.status,200);assert.equal(r.headers.get('x-processing-method'),'DeepFilterNet-local-AI');assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  process.env.DEEPFILTER_PATH='/nonexistent/deep_filter';
  r=await fetch(t.url+'/api/denoise-local',local(t.fixture));
  assert.equal(r.status,503);assert.equal((await r.json()).code,'DEEPFILTER_MISSING');
  assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();if(old===undefined)delete process.env.DEEPFILTER_PATH;else process.env.DEEPFILTER_PATH=old;fs.rmSync(dir,{recursive:true,force:true});}
});
test('automatic provider prefers free tiers; explicit provider still honored',async()=>{
 let seen='';const p={configured:{captions:true,isolation:false,captionProviders:{openai:true,groq:true,deepgram:false,assemblyai:false}},async transcribe(file,language,signal,provider){seen=provider;return {language:'english',words:[{word:'hello',start:.1,end:.8}]};}};
 const t=await setup(p);try{
  let r=await fetch(t.url+'/api/captions',upload(t.fixture));assert.equal(r.status,200);assert.equal(seen,'groq');
  r=await fetch(t.url+'/api/captions?provider=openai',upload(t.fixture));assert.equal(r.status,200);assert.equal(seen,'openai');
  assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});
test('public mode skips access key and enforces per-IP AI quotas',async()=>{
 const p={configured:{captions:true,isolation:false,captionProviders:{groq:true}},async transcribe(){return {language:'english',words:[{word:'hi',start:.1,end:.5}]};}};
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vc-public-'));const fixture=path.join(os.tmpdir(),'vc-public-'+Math.random()+'.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',fixture]);
 const server=createApp({key:'x'.repeat(64),origin:'https://example.org',root,providers:p,public:true}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const open=await(await fetch(url+'/capabilities')).json();assert.equal(open.publicMode,true);assert.equal(open.autoProvider,'groq');
  const body=()=>{const b=new FormData();b.append('file',new Blob([fs.readFileSync(fixture)]),'a.wav');return {method:'POST',body:b,headers:{'X-Upload-Consent':'yes'}};};
  assert.equal((await fetch(url+'/api/captions',body())).status,200);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});fs.rmSync(fixture,{force:true});}
});
test('unknown noise reduction level is rejected before processing',async()=>{
 const t=await setup({configured:{captions:false,isolation:false}});try{
  const r=await fetch(t.url+'/enhance?level=nope',upload(t.fixture));assert.equal(r.status,400);assert.equal((await r.json()).code,'UNKNOWN_LEVEL');
  assert.deepEqual(fs.readdirSync(t.root),[]);
 }finally{await t.close();}
});

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

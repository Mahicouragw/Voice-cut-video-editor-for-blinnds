const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createApp,TTL} = require('./server');
test('reject insecure startup',()=>{assert.throws(()=>createApp({key:'short'}));assert.equal(TTL,900000);});
test('authentication, CORS, invalid media cleanup, actual FFmpeg processing and cleanup',async()=>{
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'voicecut-test-'));
 const key = 'a'.repeat(64), origin='https://example.org';
 const server=createApp({key,origin,root}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try {
  assert.equal((await fetch(url+'/health')).status,200);
  assert.equal((await fetch(url+'/enhance',{method:'POST'})).status,401);
  assert.equal((await fetch(url+'/enhance',{method:'POST',headers:{Origin:'https://evil.test',Authorization:'Bearer '+key}})).status,403);
  const form = new FormData();form.append('file',new Blob(['not audio']),'fake.wav');
  assert.equal((await fetch(url+'/enhance',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+key},body:form})).status,422);
  const fixture = path.join(os.tmpdir(),'voicecut-fixture-'+process.pid+'.wav');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',fixture]);
  const valid = new FormData();valid.append('file',new Blob([fs.readFileSync(fixture)]),'voice.wav');
  const response = await fetch(url+'/enhance',{method:'POST',headers:{Authorization:'Bearer '+key},body:valid});
  assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fs.readdirSync(root),[]);
  fs.unlinkSync(fixture);
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('silence removal cuts quiet gaps and reports honest stats',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voicecut-test-'));
 const key='b'.repeat(64),origin='https://example.org';
 const server=createApp({key,origin,root}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 const fixture=path.join(os.tmpdir(),'voicecut-silence-'+process.pid+'.wav');
 try{
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1:sample_rate=44100','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-f','lavfi','-i','sine=frequency=880:duration=1:sample_rate=44100','-filter_complex','[0]aformat=sample_rates=44100:channel_layouts=mono[a0];[1]atrim=duration=3,aformat=sample_rates=44100:channel_layouts=mono[a1];[2]aformat=sample_rates=44100:channel_layouts=mono[a2];[a0][a1][a2]concat=n=3:v=0:a=1','-y',fixture]);
  const good=new FormData();good.append('file',new Blob([fs.readFileSync(fixture)]),'gaps.wav');
  const response=await fetch(url+'/api/silence?seconds=2',{method:'POST',headers:{Authorization:'Bearer '+key},body:good});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-silence-removed'),'1');
  assert.ok(Math.abs(Number(response.headers.get('x-silence-seconds'))-3)<0.3);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  const bad=new FormData();bad.append('file',new Blob([fs.readFileSync(fixture)]),'gaps.wav');
  assert.equal((await fetch(url+'/api/silence?seconds=99',{method:'POST',headers:{Authorization:'Bearer '+key},body:bad})).status,400);
  const vfix=path.join(os.tmpdir(),'voicecut-silence-v-'+process.pid+'.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=duration=5:size=320x240:rate=15','-i',fixture,'-shortest','-c:v','libx264','-preset','ultrafast','-c:a','aac','-y',vfix]);
  const vid=new FormData();vid.append('file',new Blob([fs.readFileSync(vfix)]),'gaps.mp4');
  const vres=await fetch(url+'/api/silence?seconds=2',{method:'POST',headers:{Authorization:'Bearer '+key},body:vid});
  assert.equal(vres.status,200);
  assert.equal(vres.headers.get('x-silence-removed'),'1');
  assert.equal(Buffer.from(await vres.arrayBuffer()).subarray(4,8).toString(),'ftyp');
  fs.unlinkSync(vfix);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fs.readdirSync(root),[]);
  fs.unlinkSync(fixture);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('silence detect mode previews gaps and no-gap trim returns instantly',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voicecut-test-'));
 const key='c'.repeat(64);
 const server=createApp({key,origin:'https://example.org',root}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 const fixture=path.join(os.tmpdir(),'voicecut-silence-d-'+process.pid+'.wav');
 try{
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1:sample_rate=44100','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-f','lavfi','-i','sine=frequency=880:duration=1:sample_rate=44100','-filter_complex','[0]aformat=sample_rates=44100:channel_layouts=mono[a0];[1]atrim=duration=3,aformat=sample_rates=44100:channel_layouts=mono[a1];[2]aformat=sample_rates=44100:channel_layouts=mono[a2];[a0][a1][a2]concat=n=3:v=0:a=1','-y',fixture]);
  const data=fs.readFileSync(fixture);
  const det=new FormData();det.append('file',new Blob([data]),'gaps.wav');
  const dres=await fetch(url+'/api/silence?seconds=2&detect=1',{method:'POST',headers:{Authorization:'Bearer '+key},body:det});
  assert.equal(dres.status,200);
  assert.ok(String(dres.headers.get('content-type')).includes('application/json'));
  const preview=await dres.json();
  assert.equal(preview.gapCount,1);
  assert.ok(Math.abs(preview.removedSeconds-3)<0.3);
  assert.deepEqual(preview.gaps.map(g=>g.map(t=>Math.round(t))),[[1,4]]);
  const nogap=new FormData();nogap.append('file',new Blob([data]),'gaps.wav');
  const nres=await fetch(url+'/api/silence?seconds=10',{method:'POST',headers:{Authorization:'Bearer '+key},body:nogap});
  assert.equal(nres.status,200);
  assert.equal(nres.headers.get('x-silence-removed'),'0');
  assert.equal(Buffer.from(await nres.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  fs.unlinkSync(fixture);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

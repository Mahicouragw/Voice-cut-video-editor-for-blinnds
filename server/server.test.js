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

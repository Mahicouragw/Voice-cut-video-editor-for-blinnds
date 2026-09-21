const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ranges,mimeFor,extension,expired,TTL_MS} = require('../web/core');
test('15-minute boundary',()=>{assert.equal(expired(0,TTL_MS-1),false);assert.equal(expired(0,TTL_MS),true);});
test('deleted segments omitted and trim intersects retained segments',()=>assert.deepEqual(ranges({trimStart:2,trimEnd:9,duration:10,segments:[{start:0,end:4},{start:6,end:10}]}),[{start:2,end:4},{start:6,end:9}]));
test('invalid trim rejected',()=>assert.throws(()=>ranges({trimStart:5,trimEnd:2,duration:10,segments:[]})));
test('deleted entire timeline rejected',()=>assert.throws(()=>ranges({trimStart:0,trimEnd:10,duration:10,segments:[]})));
test('requested codec respected instead of relabeling WebM as MP4',()=>{assert.throws(()=>mimeFor('mp4',x=>x.startsWith('video/webm')));assert.match(mimeFor('webm',()=>true),/^video\/webm/);assert.equal(extension('video/webm;codecs=vp9'),'webm');});
test('public build contains no private server files',()=>{require('../scripts/build');const fs=require('node:fs');assert.equal(fs.existsSync('dist/server'),false);assert.equal(fs.existsSync('dist/.env'),false);assert.ok(fs.existsSync('dist/web/app.js'));});

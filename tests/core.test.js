const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ranges,mimeFor,extension,expired,TTL_MS,deleteRange} = require('../web/core');
test('15-minute boundary',()=>{assert.equal(expired(0,TTL_MS-1),false);assert.equal(expired(0,TTL_MS),true);});
test('deleted segments omitted and trim intersects retained segments',()=>assert.deepEqual(ranges({trimStart:2,trimEnd:9,duration:10,segments:[{start:0,end:4},{start:6,end:10}]}),[{start:2,end:4},{start:6,end:9}]));
test('invalid trim rejected',()=>assert.throws(()=>ranges({trimStart:5,trimEnd:2,duration:10,segments:[]})));
test('deleted entire timeline rejected',()=>assert.throws(()=>ranges({trimStart:0,trimEnd:10,duration:10,segments:[]})));
test('requested codec respected instead of relabeling WebM as MP4',()=>{assert.throws(()=>mimeFor('mp4',x=>x.startsWith('video/webm')));assert.match(mimeFor('webm',()=>true),/^video\/webm/);assert.equal(extension('video/webm;codecs=vp9'),'webm');});
test('public build contains no private server files',()=>{require('../scripts/build');const fs=require('node:fs');assert.equal(fs.existsSync('dist/server'),false);assert.equal(fs.existsSync('dist/.env'),false);assert.ok(fs.existsSync('dist/web/app.js'));});
test('cropRect centers presets and validates custom percentages',()=>{
 const full=VoiceCutCore.cropRect('original',1920,1080);assert.deepEqual(full,{x:0,y:0,w:1920,h:1080});
 const square=VoiceCutCore.cropRect('1:1',1920,1080);assert.deepEqual(square,{x:420,y:0,w:1080,h:1080});
 const vertical=VoiceCutCore.cropRect('9:16',1920,1080);assert.equal(vertical.w,608);assert.equal(vertical.h,1080);
 const custom=VoiceCutCore.cropRect('custom',1000,500,{x:10,y:20,w:50,h:60});assert.deepEqual(custom,{x:100,y:100,w:500,h:300});
 assert.throws(()=>VoiceCutCore.cropRect('custom',1000,500,{x:80,y:0,w:50,h:50}));
});

test('deleteRange cuts a typed range by splitting segments',()=>{
 const p={trimStart:0,trimEnd:600,duration:600,segments:[{start:0,end:600}]};
 assert.deepEqual(deleteRange(p,327,329),[{start:0,end:327},{start:329,end:600}]);
});
test('deleteRange drops enclosed segments and trims straddlers',()=>{
 const p={trimStart:0,trimEnd:10,duration:10,segments:[{start:0,end:4},{start:4,end:6},{start:6,end:10}]};
 assert.deepEqual(deleteRange(p,3,7),[{start:0,end:3},{start:7,end:10}]);
});
test('deleteRange refuses whole-video and invalid ranges',()=>{
 const p={trimStart:0,trimEnd:10,duration:10,segments:[{start:0,end:10}]};
 assert.throws(()=>deleteRange(p,0,10));
 assert.throws(()=>deleteRange(p,5,5));
 assert.throws(()=>deleteRange(p,8,20));
 assert.throws(()=>deleteRange(p,-1,2));
});

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
test('splitAt divides the containing segment at the playhead point',()=>{
 const p={trimStart:0,trimEnd:10,duration:10,segments:[{start:0,end:10}]};
 assert.deepEqual(VoiceCutCore.splitAt(p,4),[{start:0,end:4},{start:4,end:10}]);
});
test('splitAt leaves boundary points alone and rejects outside points',()=>{
 const p={trimStart:1,trimEnd:9,duration:10,segments:[{start:1,end:5},{start:5,end:9}]};
 assert.deepEqual(VoiceCutCore.splitAt(p,5),[{start:1,end:5},{start:5,end:9}]);
 assert.throws(()=>VoiceCutCore.splitAt(p,0.5));
 assert.throws(()=>VoiceCutCore.splitAt(p,9.5));
});
test('splitAt works when segments are empty by using the trimmed range',()=>{
 const p={trimStart:2,trimEnd:8,duration:10,segments:[]};
 assert.deepEqual(VoiceCutCore.splitAt(p,6),[{start:2,end:6},{start:6,end:8}]);
});
test('findGaps detects a quiet middle gap with edge padding',()=>{
 const {findGaps}=require('../web/core');
 const sr=8000,a=new Float32Array(sr*5);
 for(let i=0;i<a.length;i++){const t=i/sr;a[i]=(t<1||t>=4)?0.5*Math.sin(2*Math.PI*440*t):0;}
 const r=findGaps([a],sr,2);
 assert.equal(r.thresholdDb,-30);assert.deepEqual(r.gaps,[[1.1,3.9]]);
});
test('findGaps climbs the sensitivity ladder on noisy pauses',()=>{
 const {findGaps}=require('../web/core');
 const sr=8000,a=new Float32Array(sr*5);
 for(let i=0;i<a.length;i++){const t=i/sr;a[i]=(t<1||t>=4)?0.5:0.04;}
 const r=findGaps([a],sr,2);
 assert.equal(r.thresholdDb,-25);assert.deepEqual(r.gaps,[[1.1,3.9]]);
});
test('findGaps uses high sensitivity for loud background hum',()=>{
 const {findGaps}=require('../web/core');
 const sr=8000,a=new Float32Array(sr*5);
 for(let i=0;i<a.length;i++){const t=i/sr;a[i]=(t<1||t>=4)?0.5:0.08;}
 const r=findGaps([a],sr,2);
 assert.equal(r.thresholdDb,-20);assert.deepEqual(r.gaps,[[1.1,3.9]]);
});
test('findGaps ignores short pauses and clean audio',()=>{
 const {findGaps}=require('../web/core');
 const sr=8000,short=new Float32Array(sr*5),clean=new Float32Array(sr*3);
 for(let i=0;i<short.length;i++){const t=i/sr;short[i]=(t<1||t>=2)?0.5:0;}
 for(let i=0;i<clean.length;i++)clean[i]=0.5;
 assert.deepEqual(findGaps([short],sr,2).gaps,[]);
 assert.deepEqual(findGaps([clean],sr,2).gaps,[]);
});
test('findGaps validates inputs',()=>{
 const {findGaps}=require('../web/core');
 assert.throws(()=>findGaps([],8000,2));
 assert.throws(()=>findGaps([new Float32Array(80)],0,2));
 assert.throws(()=>findGaps([new Float32Array(80)],8000,0.1));
 assert.throws(()=>findGaps([new Float32Array(80)],8000,60));
});
test('retainedDuration sums kept ranges and falls back on invalid projects',()=>{
 const {retainedDuration}=require('../web/core');
 assert.equal(retainedDuration({trimStart:0,trimEnd:600,duration:600,segments:[{start:0,end:600}]}),600);
 assert.equal(retainedDuration({trimStart:0,trimEnd:10,duration:10,segments:[{start:0,end:4},{start:6,end:10}]}),8);
 assert.equal(retainedDuration({trimStart:2,trimEnd:9,duration:10,segments:[{start:0,end:4},{start:6,end:10}]}),5);
 assert.equal(retainedDuration({trimStart:0,trimEnd:null,duration:10,segments:[{start:0,end:10}]}),10);
 assert.equal(retainedDuration({trimStart:5,trimEnd:2,duration:10,segments:[]}),10);
 assert.equal(retainedDuration({trimStart:0,trimEnd:10,duration:10,segments:[]}),10);
});
test('splitChunks windows long audio',()=>{
 const {splitChunks}=require('../web/core');
 assert.deepEqual(splitChunks(740,300),[[0,300],[300,600],[600,740]]);
 assert.deepEqual(splitChunks(300,300),[[0,300]]);
 assert.throws(()=>splitChunks(0,300));assert.throws(()=>splitChunks(100,0));
});
test('chooseCutPoint moves boundaries to quiet moments',()=>{
 const {chooseCutPoint}=require('../web/core');
 const sr=8000,a=new Float32Array(sr*10);
 for(let i=0;i<a.length;i++){const t=i/sr;a[i]=(t>4.9&&t<5.1)?0:0.5;}
 const cut=chooseCutPoint(a,sr,6,2);
 assert.ok(cut>4.8&&cut<5.2,'cut at '+cut);
});
test('chooseCutPoint stays at nominal when nothing is quieter',()=>{
 const {chooseCutPoint}=require('../web/core');
 const sr=8000,loud=new Float32Array(sr*10).fill(0.5);
 assert.equal(chooseCutPoint(loud,sr,6,2),6);
 assert.equal(chooseCutPoint(new Float32Array(0),sr,6,2),6);
});

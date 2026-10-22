const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ranges,mimeFor,mimeOptions,exportLooksShort,extension,expired,TTL_MS,deleteRange,detectCaptionScript,captionScriptMismatch,audioBlockTimestamp} = require('../web/core');
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
test('export prefers plain containers and detects cut-short phone recordings',()=>{
  assert.deepEqual(mimeOptions('mp4'),['video/mp4','video/mp4;codecs=avc1,opus','video/mp4;codecs=avc1.42E01E,mp4a.40.2']);
  assert.equal(mimeOptions('webm')[0],'video/webm');
  assert.equal(mimeFor('mp4',()=>true),'video/mp4');
  assert.equal(exportLooksShort(3,420),true);
  assert.equal(exportLooksShort(419,420),false);
  assert.equal(exportLooksShort(NaN,420),false);
  assert.equal(exportLooksShort(Infinity,420),false);
  assert.equal(exportLooksShort(2.5,3),false);
  assert.equal(exportLooksShort(0.5,3),true);
});
test('transcript script check proves the real caption language',()=>{
  const te='నేను తెలుగు మాట్లాడుతున్నాను';
  const hi='मैं हिंदी बोल रहा हूँ';
  const en='hello how are you doing today';
  assert.equal(detectCaptionScript(te),'te');
  assert.equal(detectCaptionScript(hi),'dev');
  assert.equal(detectCaptionScript(en),'');
  const cues=(t)=>[{text:t,start:0,end:1}];
  assert.equal(captionScriptMismatch(cues(te),'te'),'');
  assert.equal(captionScriptMismatch(cues(en),'te'),'latin');
  assert.equal(captionScriptMismatch(cues(hi),'te'),'dev');
  assert.equal(captionScriptMismatch(cues(te),'en'),'te');
  assert.equal(captionScriptMismatch(cues(en),'en'),'');
  assert.equal(captionScriptMismatch(cues(hi),'mr'),'');
  assert.equal(captionScriptMismatch([],'te'),'');
});
test('kept position maps player time onto the kept timeline',()=>{
  const {keptPositionAt} = require('../web/core');
  const rs = [{start:0,end:60},{start:120,end:162}]; // 60 kept + 42 kept = 102s kept
  assert.equal(keptPositionAt(rs,30),30);
  assert.equal(keptPositionAt(rs,60),60);
  assert.equal(keptPositionAt(rs,90),60); // inside a deleted part: capped at kept-so-far
  assert.equal(keptPositionAt(rs,120),60);
  assert.equal(keptPositionAt(rs,141),81);
  assert.equal(keptPositionAt(rs,162),102);
  assert.equal(keptPositionAt(rs,200),102);
  assert.equal(keptPositionAt([],5),5); // invalid input falls back to the raw time
});
test('kept seeking jumps over deleted parts and clamps to kept ends',()=>{
  const {keptSeekAt} = require('../web/core');
  const rs = [{start:0,end:60},{start:120,end:162}]; // 102s kept
  assert.equal(keptSeekAt(rs,30,5),35);
  assert.equal(keptSeekAt(rs,58,5),123); // 5 kept seconds jump the 60s deleted gap
  assert.equal(keptSeekAt(rs,130,-15),55); // backward over the gap
  assert.equal(keptSeekAt(rs,160,10),162); // clamps to kept end, not trim end
  assert.equal(keptSeekAt(rs,5,-10),0);
  assert.equal(keptSeekAt(rs,90,5),125); // starting inside a deleted span
  const one = [{start:10,end:50}]; // unedited: identical to plain clamped seeking
  assert.equal(keptSeekAt(one,20,-5),15);
  assert.equal(keptSeekAt(one,12,-5),10);
  assert.equal(keptSeekAt(one,48,5),50);
  assert.equal(keptSeekAt([],5,5),5); // invalid input returns the time untouched
  assert.equal(keptSeekAt(rs,30,NaN),30);
});
test('speed ranges shrink kept time and survive round trips',()=>{
  const {speedRangesOf,speedAt,keptRangeLen,keptRangesDuration,keptPositionAt,keptSeekAt,retainedDuration,addSpeedRange}=require('../web/core');
  const p={duration:600,trimStart:0,trimEnd:600,segments:[{start:0,end:600}],speedRanges:[{start:120,end:240,rate:2},{start:360,end:480,rate:2}]};
  assert.equal(speedRangesOf(p).length,2);
  assert.equal(speedRangesOf({}).length,0);
  assert.equal(speedAt(p,130),2); assert.equal(speedAt(p,10),1); assert.equal(speedAt(p,240),1);
  assert.equal(keptRangeLen({start:0,end:600},speedRangesOf(p)),480);
  assert.equal(keptRangesDuration([{start:0,end:600}],speedRangesOf(p)),480);
  assert.equal(retainedDuration(p),480);
  assert.equal(keptPositionAt([{start:0,end:600}],600,speedRangesOf(p)),480);
  assert.equal(keptPositionAt([{start:0,end:600}],130,speedRangesOf(p)),125);
  assert.equal(keptSeekAt([{start:0,end:600}],0,90,speedRangesOf(p)),90);
  assert.equal(keptSeekAt([{start:0,end:600}],0,150,speedRangesOf(p)),180);
  assert.equal(keptSeekAt([{start:0,end:600}],600,-60,speedRangesOf(p)),540);
  // old two-arg calls behave exactly as before
  assert.equal(keptPositionAt([{start:0,end:600}],130),130);
  assert.equal(keptSeekAt([{start:0,end:600}],0,90),90);
  const added=addSpeedRange({duration:600,speedRanges:[]},60,120,2);
  assert.equal(added.length,1); assert.equal(added[0].rate,2);
  assert.throws(()=>addSpeedRange(p,100,130,2),/overlap/);
  assert.throws(()=>addSpeedRange(p,100,100,2),/valid range/);
  assert.throws(()=>addSpeedRange(p,100,200,0),/valid speed/);
  assert.throws(()=>addSpeedRange(p,100,700,2),/valid range/);
});

test('2.37 audio stamps derive from content, not encode wall-clock',()=>{
  const sr=48000,base=1000000;
  const steady=[0,1,2,3,4].map(i=>audioBlockTimestamp(base,i*1024,sr,i?audioBlockTimestamp(base,(i-1)*1024,sr,i>1?audioBlockTimestamp(base,(i-2)*1024,sr,-1):-1):-1));
  for(let i=1;i<steady.length;i++){const gap=steady[i]-steady[i-1];assert.ok(gap>20000&&gap<23000,'block gap '+gap+'us stays one block wide');}
  const burst=audioBlockTimestamp(base,5*1024,sr,steady[4]);
  assert.ok(burst-steady[4]>=21333&&burst-steady[4]<=21334,'a burst-encoded block keeps its content slot, never the encode instant');
  assert.equal(audioBlockTimestamp(base,0,sr,9999999),10000000,'stamps stay strictly increasing');
});

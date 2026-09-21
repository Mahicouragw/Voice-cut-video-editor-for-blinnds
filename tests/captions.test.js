const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../web/captions');
test('word timestamps become short timed cues with pause boundaries',()=>{
 const cues=C.fromTranscript({words:[{word:'Hello',start:.1,end:.5},{word:'world.',start:.6,end:1},{word:'नमस्ते',start:3,end:3.5}]},4);
 assert.deepEqual(cues,[{text:'Hello world.',start:.1,end:1},{text:'नमस्ते',start:3,end:3.5}]);
});
test('segment fallback ignores high no-speech probability and preserves Telugu text',()=>{
 assert.deepEqual(C.fromTranscript({segments:[{text:'తెలుగు',start:0,end:1},{text:'noise hallucination',start:1,end:2,no_speech_prob:.95}]},2),[{text:'తెలుగు',start:0,end:1}]);
});
test('caption times follow trim, cuts and speed; crossing cut duplicates only retained portions',()=>{
 const cues=C.forExport([{start:1,end:9,text:'Hello'}],[{start:2,end:4},{start:6,end:10}],2);
 assert.deepEqual(cues,[{start:0,end:1,text:'Hello'},{start:1,end:2.5,text:'Hello'}]);
});
test('subtitle serialization escapes markup and keeps millisecond timestamps',()=>{
 const cues=[{start:.9996,end:2.456,text:'<b>Hello</b> & world'}];
 assert.match(C.serialize(cues),/00:00:01,000 --> 00:00:02,456/);
 assert.match(C.serialize(cues),/&lt;b&gt;Hello&lt;\/b&gt; &amp; world/);
 assert.ok(C.serialize(cues,'vtt').startsWith('WEBVTT\n\n1\n00:00:01.000'));
});
test('invalid times, NaN, empty text and unbounded lists rejected',()=>{
 for(const cue of [{start:-1,end:3,text:'x'},{start:4,end:3,text:'x'},{start:NaN,end:1,text:'x'},{start:0,end:1,text:' '},{start:0,end:8,text:'x'}])assert.throws(()=>C.validate([cue],5));
 assert.throws(()=>C.validate(new Array(2001).fill({start:0,end:1,text:'x'})));
});
test('active cues are half-open and do not mutate project data',()=>{
 const cues=[{start:0,end:1,text:'A'},{start:1,end:2,text:'B'}];assert.equal(C.active(cues,1),'B');C.forExport(cues,[{start:0,end:2}],2);assert.equal(cues[1].start,1);
});

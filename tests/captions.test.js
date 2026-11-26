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
test('forExport maps cues through speed ranges',()=>{
 const out=C.forExport([{start:130,end:140,text:'Hi'}],[{start:0,end:600}],1,[{start:120,end:240,rate:2}]);
 assert.equal(out.length,1);assert.equal(out[0].start,125);assert.equal(out[0].end,130);
 const plain=C.forExport([{start:1,end:9,text:'Hello'}],[{start:2,end:4},{start:6,end:10}],2);
 assert.equal(plain.length,2); // unchanged when no speed ranges are passed
});
test('linesFor wraps strictly on spaces and never splits English or Telugu words mid-syllable',()=>{
 const fakeCtx={measureText:s=>({width:Array.from(s).length*10})};
 const telugu='మన తెలుగు భాష సంస్కృతి మరియు సాంప్రదాయాలు ఎంతో గొప్పవి';
 const lines=C.linesFor(fakeCtx,telugu,240);
 assert.ok(lines.length>=2,'expected multi-line wrap');
 // Every original word must appear intact inside one of the wrapped lines (never split across lines)
 for(const word of telugu.split(' ')){
  assert.ok(lines.some(line=>line.split(' ').includes(word)),`Telugu word "${word}" was split across lines: ${JSON.stringify(lines)}`);
 }
  // Even if a single compound word exceeds width, linesFor keeps it whole on its own line rather than splitting mid-word
 const longWordLines=C.linesFor(fakeCtx,'స్వాతంత్ర్యోద్యమము మనందరి స్ఫూర్తి',170);
 assert.deepEqual(longWordLines,['స్వాతంత్ర్యోద్యమము','మనందరి స్ఫూర్తి']);
});
test('wrapCueText balances into at most 2 lines on space boundaries and preserves UTF-8 diacritics',()=>{
 const text='మన రాజ్యాంగం ప్రతి పౌరుడికి సమాన హక్కులు మరియు బాధ్యతలను ఎల్లప్పుడూ కల్పిస్తుంది.';
 const wrapped=C.wrapCueText(text);
 const parts=wrapped.split('\n');
 assert.equal(parts.length,2);
 assert.equal(parts.join(' '),text);
 for(const word of text.split(' ')){
  assert.ok(parts.some(line=>line.split(' ').includes(word)),`word "${word}" split across lines`);
 }
});
test('fromTranscript chunks long segments into natural <=2-line cards without mid-word breaks',()=>{
 const segText='Today we celebrate the makers, teachers, farmers, and students who build our shared future every single day with courage and honesty.';
 const cues=C.fromTranscript({segments:[{start:0,end:9,text:segText}]},10);
 assert.ok(cues.length>=2,'long segment should split into multiple readable cards');
 assert.equal(cues[0].start,0);
 assert.equal(cues.at(-1).end,9);
 // Reassembled words match original text exactly without dropping or mangling tokens
 assert.equal(cues.map(c=>c.text.replace(/\n+/g,' ')).join(' '),segText);
 for(const cue of cues){
  assert.ok(cue.text.split('\n').length<=2,`cue exceeded 2 lines: ${cue.text}`);
 }
});
test('draw shrinks font to fit long words inside safe margins without mid-word wrapping',()=>{
 const drawn=[];
 let currentFont='600 40px sans-serif';
 const ctx={
  save(){},restore(){},fillRect(){},
  set font(v){currentFont=v;},get font(){return currentFont;},
  measureText(s){const px=Number((/(\d+)px/.exec(currentFont)||[0,20])[1]);return {width:Array.from(s).length*px*0.62};},
  fillText(line,x,y,maxW){drawn.push({line,x,y,maxW,font:currentFont});}
 };
 C.draw(ctx,'స్వాతంత్ర్యోద్యమము మనందరి స్ఫూర్తి',360,640);
 assert.ok(drawn.length>=1 && drawn.length<=2);
 assert.equal(drawn.map(d=>d.line).join(' '),'స్వాతంత్ర్యోద్యమము మనందరి స్ఫూర్తి');
 for(const d of drawn){
  assert.ok(ctx.measureText(d.line).width<=360*0.84+0.5,'drawn line must fit safe width without horizontal squish');
 }
});
test('inspectCues flags >2 lines, unbroken oversize tokens, overlaps, and flash cues',()=>{
 const issues=C.inspectCues([
  {start:0,end:0.2,text:'Flash'},
  {start:0.15,end:2,text:'Line one\nLine two\nLine three'},
  {start:2.5,end:4,text:'A'.repeat(50)}
 ]);
 const types=issues.map(i=>i.type);
 assert.ok(types.includes('too_short'));
 assert.ok(types.includes('overlap'));
 assert.ok(types.includes('too_many_lines'));
 assert.ok(types.includes('unbroken_token'));
});

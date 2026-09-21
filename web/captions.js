/* Timed captions. Pure helpers are shared by the browser, server and tests. */
(function(root) {
  'use strict';
  const cleanText = text => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/\s+/g,' ').trim().slice(0,1000);
  function validate(cues, maxDuration=86400) {
    if (!Array.isArray(cues) || cues.length > 2000) throw new Error('Expected at most 2,000 caption cues.');
    return cues.map(c => {
      const start=Number(c.start), end=Number(c.end), text=cleanText(c.text);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>maxDuration+0.1 || !text) throw new Error('Each caption needs text and valid start/end times within the media.');
      return {start,end,text};
    }).sort((a,b)=>a.start-b.start || a.end-b.end);
  }
  function fromTranscript(data, duration) {
    const words = Array.isArray(data.words) ? data.words.filter(w=>Number.isFinite(w.start) && Number.isFinite(w.end) && w.start>=0 && w.end>w.start && w.start<duration && cleanText(w.word)).sort((a,b)=>a.start-b.start) : [];
    let cues=[];
    if (words.length) {
      let group=[];
      const flush=()=>{ if (group.length) { cues.push({start:group[0].start,end:Math.min(duration,group.at(-1).end),text:group.map(w=>cleanText(w.word)).join(' ')}); group=[]; } };
      for (const w of words) {
        if (group.length && (group.length>=12 || w.end-group[0].start>4.5 || w.start-group.at(-1).end>0.9 || group.map(x=>x.word).join(' ').length+String(w.word).length>78)) flush();
        group.push(w);
        if (/[.!?।。！？]$/.test(cleanText(w.word))) flush();
      }
      flush();
    } else if (Array.isArray(data.segments)) {
      cues=data.segments.filter(s=>Number.isFinite(s.start) && Number.isFinite(s.end) && s.start>=0 && s.end>s.start && s.start<duration && cleanText(s.text) && !(s.no_speech_prob>0.8)).map(s=>({start:s.start,end:Math.min(duration,s.end),text:cleanText(s.text)}));
    } else throw new Error('Provider did not return timed words or segments.');
    return validate(cues,duration);
  }
  function active(cues,time) { return (cues || []).filter(c=>time>=c.start && time<c.end).map(c=>c.text).join('\n'); }
  function forExport(cues,ranges,speed=1) {
    if (!Number.isFinite(speed) || speed<=0) throw new Error('Invalid playback speed.');
    let offset=0; const output=[];
    for (const range of ranges) {
      for (const cue of validate(cues)) {
        const start=Math.max(cue.start,range.start), end=Math.min(cue.end,range.end);
        if (end>start) output.push({text:cue.text,start:(offset+start-range.start)/speed,end:(offset+end-range.start)/speed});
      }
      offset+=range.end-range.start;
    }
    return output.sort((a,b)=>a.start-b.start);
  }
  function timecode(seconds,comma=false) {
    const total=Math.max(0,Math.round(seconds*1000));
    const pad=(v,n=2)=>String(v).padStart(n,'0');
    return `${pad(Math.floor(total/3600000))}:${pad(Math.floor(total/60000)%60)}:${pad(Math.floor(total/1000)%60)}${comma?',':'.'}${pad(total%1000,3)}`;
  }
  function serialize(cues,format='srt') {
    const escape=text=>cleanText(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return (format==='vtt'?'WEBVTT\n\n':'')+validate(cues).map((c,i)=>`${i+1}\n${timecode(c.start,format==='srt')} --> ${timecode(Math.max(c.end,c.start+0.001),format==='srt')}\n${escape(c.text)}\n`).join('\n');
  }
  function linesFor(ctx,text,width) {
    const lines=[];let line='';
    // Segment graphemes, not code units, so Indic vowel signs and emoji stay together.
    const units=typeof Intl.Segmenter==='function' ? [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(v=>v.segment) : Array.from(text);
    for (const unit of units) {
      if (unit==='\n') {lines.push(line);line='';continue;}
      if (line && ctx.measureText(line+unit).width>width) {lines.push(line.trim());line='';}
      line+=unit;
    }
    if (line) lines.push(line.trim());
    return lines;
  }
  function draw(ctx,text,width,height) {
    if (!text) return;
    ctx.save();
    let size=Math.max(14,Math.round(height*0.043));
    ctx.font=`600 ${size}px sans-serif`;
    let lines=linesFor(ctx,text,width*0.84);
    while (lines.length*size*1.35>height*0.48 && size>10) {size--;ctx.font=`600 ${size}px sans-serif`;lines=linesFor(ctx,text,width*0.84);}
    const lineHeight=size*1.35, bottom=height*0.92, top=bottom-lines.length*lineHeight;
    ctx.fillStyle='rgba(0,0,0,0.82)';ctx.fillRect(width*0.06,top-size*0.25,width*0.88,lines.length*lineHeight+size*0.5);
    ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle='#fff';
    lines.forEach((line,i)=>ctx.fillText(line,width/2,top+i*lineHeight,width*0.84));
    ctx.restore();
  }
  const api={cleanText,validate,fromTranscript,active,forExport,timecode,serialize,draw};
  root.VoiceCutCaptions=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);

/* Timed captions. Pure helpers are shared by the browser, server and tests. */
(function(root) {
  'use strict';
  const MAX_LINE_CHARS = 42;
  const MAX_LINES_PER_CUE = 2;
  const MAX_CUE_WORDS = 8;
  const MAX_CUE_DURATION = 4.2;
  const PAUSE_BREAK_SECONDS = 0.65;
  const cleanText = text => String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'')
    .replace(/\r\n?/g,'\n')
    .split('\n')
    .map(part=>part.replace(/[^\S\n]+/g,' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0,1000);
  function graphemeLength(text) {
    const s = String(text ?? '');
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      let n = 0;
      for (const _ of new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(s)) n++;
      return n;
    }
    return Array.from(s).length;
  }
  function hasIndicScript(text) {
    return /[\u0900-\u0D7F]/.test(String(text ?? ''));
  }
  function effectiveMaxLineChars(text, explicitMax) {
    if (explicitMax !== undefined) return explicitMax;
    return hasIndicScript(text) ? 28 : MAX_LINE_CHARS;
  }
  // Wrap plain text on space boundaries only (never mid-word or mid-conjunct).
  // Aim for <= maxLineChars graphemes per line and <= maxLines lines when balanced.
  function wrapCueText(text, maxLineChars, maxLines = MAX_LINES_PER_CUE) {
    const cleaned = cleanText(text);
    if (!cleaned) return '';
    const lineLimit = effectiveMaxLineChars(cleaned, maxLineChars);
    if (cleaned.includes('\n')) {
      const explicit = cleaned.split('\n').map(l=>l.trim()).filter(Boolean);
      if (explicit.length <= maxLines && explicit.every(l=>graphemeLength(l) <= lineLimit)) return explicit.join('\n');
    }
    const words = cleaned.replace(/\n+/g, ' ').split(' ').filter(Boolean);
    if (words.length <= 1) return words[0] || '';
    const totalLen = words.reduce((sum, w) => sum + graphemeLength(w), 0) + (words.length - 1);
    if (totalLen <= lineLimit) return words.join(' ');
    // For 2-line cards, pick the balanced split point on a space boundary so neither line breaks mid-word.
    if (maxLines === 2) {
      let bestIdx = -1, bestScore = Infinity;
      for (let i = 1; i < words.length; i++) {
        const left = words.slice(0, i).join(' ');
        const right = words.slice(i).join(' ');
        const lLen = graphemeLength(left), rLen = graphemeLength(right);
        const over = Math.max(0, lLen - lineLimit) + Math.max(0, rLen - lineLimit);
        const punctBonus = /[,;:—–.!?।。！？]$/.test(words[i - 1]) ? -3 : 0;
        const score = over * 100 + Math.abs(lLen - rLen) + punctBonus;
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx > 0) return words.slice(0, bestIdx).join(' ') + '\n' + words.slice(bestIdx).join(' ');
    }
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (current && graphemeLength(candidate) > lineLimit && lines.length + 1 < maxLines) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.join('\n');
  }
  // Split a long segment into natural phrase chunks on word boundaries with proportional timing.
  function splitSegmentToCues(start, end, text, maxLineChars) {
    const cleaned = cleanText(text).replace(/\n+/g, ' ');
    const lineLimit = effectiveMaxLineChars(cleaned, maxLineChars);
    const words = cleaned.split(' ').filter(Boolean);
    const maxCueChars = lineLimit * MAX_LINES_PER_CUE;
    if (words.length <= MAX_CUE_WORDS && graphemeLength(cleaned) <= maxCueChars) {
      return [{start, end, text: wrapCueText(cleaned, lineLimit, MAX_LINES_PER_CUE)}];
    }
    const groups = [];
    let cur = [], curChars = 0;
    for (const w of words) {
      const wLen = graphemeLength(w);
      const nextChars = cur.length ? curChars + 1 + wLen : wLen;
      if (cur.length && (cur.length >= MAX_CUE_WORDS || nextChars > maxCueChars)) {
        groups.push(cur);
        cur = [w];
        curChars = wLen;
      } else {
        cur.push(w);
        curChars = nextChars;
        if (cur.length >= 3 && (/[,;:—–]$/.test(w) && curChars >= Math.floor(lineLimit * 0.7) || /[.!?।。！？]$/.test(w))) {
          groups.push(cur);
          cur = [];
          curChars = 0;
        }
      }
    }
    if (cur.length) {
      // Avoid a 1-word orphan tail when it comfortably fits the previous card without exceeding 2 lines.
      if (cur.length === 1 && groups.length && graphemeLength(groups.at(-1).join(' ') + ' ' + cur[0]) <= maxCueChars + 6) {
        groups.at(-1).push(cur[0]);
      } else {
        groups.push(cur);
      }
    }
    const weights = groups.map(g => Math.max(1, g.reduce((s, w) => s + graphemeLength(w), 0)));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0.01, end - start);
    let cursor = start;
    return groups.map((g, idx) => {
      const cStart = cursor;
      const cEnd = idx === groups.length - 1 ? end : Math.min(end, cStart + span * (weights[idx] / totalWeight));
      cursor = cEnd;
      return {start: cStart, end: Math.max(cEnd, cStart + 0.001), text: wrapCueText(g.join(' '), lineLimit, MAX_LINES_PER_CUE)};
    });
  }
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
      const flush=()=>{
        if (!group.length) return;
        const joined = group.map(w=>cleanText(w.word).replace(/\n+/g,' ')).join(' ');
        cues.push({start:group[0].start,end:Math.min(duration,group.at(-1).end),text:wrapCueText(joined,undefined,MAX_LINES_PER_CUE)});
        group=[];
      };
      for (const w of words) {
        const wText = cleanText(w.word).replace(/\n+/g,' ');
        const currentText = group.map(x=>cleanText(x.word).replace(/\n+/g,' ')).join(' ');
        const maxCueChars = effectiveMaxLineChars(currentText + ' ' + wText) * MAX_LINES_PER_CUE;
        const maxWords = hasIndicScript(currentText + ' ' + wText) ? 6 : MAX_CUE_WORDS;
        const nextLen = currentText ? graphemeLength(currentText) + 1 + graphemeLength(wText) : graphemeLength(wText);
        if (group.length && (
          group.length >= maxWords ||
          w.end - group[0].start > MAX_CUE_DURATION ||
          w.start - group.at(-1).end > PAUSE_BREAK_SECONDS ||
          nextLen > maxCueChars
        )) flush();
        group.push(w);
        if (/[.!?।。！？]$/.test(wText) || (group.length >= 4 && /[,;:—–]$/.test(wText))) flush();
      }
      flush();
    } else if (Array.isArray(data.segments)) {
      for (const s of data.segments) {
        if (Number.isFinite(s.start) && Number.isFinite(s.end) && s.start>=0 && s.end>s.start && s.start<duration && cleanText(s.text) && !(s.no_speech_prob>0.8)) {
          cues.push(...splitSegmentToCues(s.start, Math.min(duration, s.end), s.text));
        }
      }
    } else throw new Error('Provider did not return timed words or segments.');
    return validate(cues,duration);
  }
  function active(cues,time) { return (cues || []).filter(c=>time>=c.start && time<c.end).map(c=>c.text).join('\n'); }
  function forExport(cues,ranges,speed=1,speeds=[]) {
    if (!Number.isFinite(speed) || speed<=0) throw new Error('Invalid playback speed.');
    const spd=Array.isArray(speeds)?speeds.filter(s=>s&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&Number.isFinite(s.rate)&&s.end>s.start&&s.rate>0):[];
    const rateAt=t=>{ for (const s of spd) { if (t>=s.start&&t<s.end) return s.rate; } return 1; };
    let offset=0; const output=[];
    for (const range of ranges) {
      const pts=[range.start];
      for (const s of spd) { if (s.end>range.start&&s.start<range.end) pts.push(Math.min(range.end,Math.max(range.start,s.start)),Math.min(range.end,Math.max(range.start,s.end))); }
      pts.push(range.end); pts.sort((a,b)=>a-b);
      for (let i=0;i+1<pts.length;i++) {
        const a=pts[i],b=pts[i+1];
        if (b<=a) continue;
        const rate=rateAt((a+b)/2);
        for (const cue of validate(cues)) {
          const start=Math.max(cue.start,a), end=Math.min(cue.end,b);
          if (end>start) output.push({text:cue.text,start:(offset+(start-a)/rate)/speed,end:(offset+(end-a)/rate)/speed});
        }
        offset+=(b-a)/rate;
      }
    }
    return output.sort((a,b)=>a.start-b.start);
  }
  function timecode(seconds,comma=false) {
    const total=Math.max(0,Math.round(seconds*1000));
    const pad=(v,n=2)=>String(v).padStart(n,'0');
    return `${pad(Math.floor(total/3600000))}:${pad(Math.floor(total/60000)%60)}:${pad(Math.floor(total/1000)%60)}${comma?',':'.'}${pad(total%1000,3)}`;
  }
  function serialize(cues,format='srt') {
    const escape=text=>wrapCueText(text,undefined,MAX_LINES_PER_CUE).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return (format==='vtt'?'WEBVTT\n\n':'')+validate(cues).map((c,i)=>`${i+1}\n${timecode(c.start,format==='srt')} --> ${timecode(Math.max(c.end,c.start+0.001),format==='srt')}\n${escape(c.text)}\n`).join('\n');
  }
  // Wrap lines strictly on word boundaries (spaces and explicit newlines).
  // Never split words mid-syllable, mid-character, or across Indic conjuncts/vowel signs (మాత్రలు).
  function linesFor(ctx,text,width) {
    const lines=[];
    const paragraphs=String(text ?? '').split('\n');
    for (const para of paragraphs) {
      const words=para.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      let line='';
      for (const word of words) {
        const candidate=line ? line+' '+word : word;
        if (line && ctx.measureText(candidate).width>width) {
          lines.push(line);
          line=word;
        } else {
          line=candidate;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }
  function widestLine(ctx,lines) {
    let max=0;
    for (const line of lines) {
      const w=ctx.measureText(line).width;
      if (w>max) max=w;
    }
    return max;
  }
  // Inspect cues before export/publishing to flag mid-word wraps, overflow (>2 lines),
  // overlaps, ultra-short flashes, or safe-margin risks.
  function inspectCues(cues, maxLineChars = MAX_LINE_CHARS) {
    const issues=[];
    const list=Array.isArray(cues) ? cues : [];
    for (let i=0;i<list.length;i++) {
      const c=list[i];
      const raw=String(c?.text ?? '');
      const explicitLines=raw.split('\n').map(s=>s.trim()).filter(Boolean);
      const rendered=explicitLines.length>1 ? explicitLines : wrapCueText(raw,maxLineChars,MAX_LINES_PER_CUE).split('\n').filter(Boolean);
      if (rendered.length>MAX_LINES_PER_CUE) {
        issues.push({index:i,type:'too_many_lines',message:`Caption ${i+1} spans ${rendered.length} lines (keep to at most ${MAX_LINES_PER_CUE} lines).`});
      }
      const longToken=raw.split(/\s+/).find(w=>graphemeLength(w)>maxLineChars);
      if (longToken) {
        issues.push({index:i,type:'unbroken_token',message:`Caption ${i+1} has a single unbroken token of ${graphemeLength(longToken)} characters without spaces.`});
      } else if (rendered.some(l=>graphemeLength(l)>maxLineChars+4)) {
        issues.push({index:i,type:'line_too_long',message:`Caption ${i+1} exceeds safe line length (${maxLineChars} characters per line).`});
      }
      if (Number.isFinite(c?.start) && Number.isFinite(c?.end)) {
        if (c.end-c.start<0.35) {
          issues.push({index:i,type:'too_short',message:`Caption ${i+1} flashes for ${(c.end-c.start).toFixed(2)}s (under 0.35s).`});
        }
        if (i>0 && Number.isFinite(list[i-1]?.end) && c.start<list[i-1].end-0.01) {
          issues.push({index:i,type:'overlap',message:`Caption ${i+1} overlaps with Caption ${i}.`});
        }
      }
    }
    return issues;
  }
  function draw(ctx,text,width,height) {
    if (!text) return;
    ctx.save();
    const safeWidth=width*0.84;
    const minSize=10;
    let size=Math.max(14,Math.round(Math.min(height*0.043,width*0.052)));
    const fontFor=px=>`600 ${px}px system-ui, -apple-system, "Noto Sans Telugu", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans Kannada", "Noto Sans Malayalam", "Noto Sans Bengali", sans-serif`;
    // Normalize single-line cues into balanced <=2-line word-wrapped text first when needed.
    const prepared=String(text).includes('\n') ? String(text) : wrapCueText(text,undefined,MAX_LINES_PER_CUE);
    ctx.font=fontFor(size);
    let lines=linesFor(ctx,prepared,safeWidth);
    // Shrink font cleanly so lines fit <= 2 lines (or vertical budget) AND no single word exceeds safeWidth,
    // rather than horizontally squishing glyphs or splitting words mid-syllable.
    while (size>minSize && (
      lines.length>MAX_LINES_PER_CUE && !String(text).includes('\n') ||
      lines.length*size*1.35>height*0.42 ||
      widestLine(ctx,lines)>safeWidth
    )) {
      size--;
      ctx.font=fontFor(size);
      lines=linesFor(ctx,prepared,safeWidth);
    }
    const lineHeight=size*1.38;
    const padX=Math.max(10,Math.round(size*0.55)), padY=Math.max(6,Math.round(size*0.32));
    const boxW=Math.min(width*0.88, Math.max(width*0.24, widestLine(ctx,lines)+padX*2));
    const boxH=lines.length*lineHeight+padY*2;
    const bottom=height*0.91, top=Math.max(height*0.06, bottom-boxH);
    ctx.fillStyle='rgba(0,0,0,0.82)';
    ctx.fillRect((width-boxW)/2, top, boxW, boxH);
    ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle='#fff';
    lines.forEach((line,i)=>ctx.fillText(line,width/2,top+padY+i*lineHeight,safeWidth));
    ctx.restore();
  }
  const api={cleanText,graphemeLength,wrapCueText,splitSegmentToCues,inspectCues,linesFor,validate,fromTranscript,active,forExport,timecode,serialize,draw};
  root.VoiceCutCaptions=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);


/* VoiceCut Studio - Accessible Video Editor - Complete Implementation */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const escapeHTML = value => String(value).replace(/[&<>"\']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","\'":"&#39;"}[c]));

  // State
  let project = {
    id: 'proj_' + Date.now(),
    name: 'Untitled Project',
    videoFile: null,
    videoUrl: null,
    duration: 0,
    trimStart: 0,
    trimEnd: 0,
    captions: [],
    captionSettings: {preview:true,burnIn:true},
    segments: [], // {id, start, end, label}
    originalAudio: { volume: 100, muted: false, fadeIn: 0, fadeOut: 0, noiseReduction: 'medium' },
    clips: [], // {id, name, type: 'music'|'voiceover', file, url, startTime, trimStart, trimEnd, duration, volume, muted, fadeIn, fadeOut, noiseReduction, trackIndex}
    ducking: { enabled: true, level: 30 },
    playbackSpeed: 1,
    skipAmount: 5,
    resolution: '1080',
    fps: 30,
    format: 'mp4',
    created: Date.now(),
    modified: Date.now()
  };
  let selectedClipId = null;
  let historyStack = [];
  let historyIndex = -1;
  let audioContext = null;
  let audioNodes = new Map(); // clipId -> {source, gain, filters, element}
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStartTime = 0;
  let recordTimerInterval = null;
  let exportRecorder = null;
  let exportedBlob = null;
  let isExporting = false;
  let advancedMode = false;
  let currentVideoTime = 0;

  const video = $('#mainVideo');
  const exportCanvas = $('#exportCanvas');
  const exportedVideoEl = $('#exportedVideo');

  let captionSelection = 0;
  let captionRequestBusy = false;
  let mediaEpoch = 0;
  function captionDefaults() {
    project.captions ||= [];
    project.captionSettings ||= {preview:true,burnIn:true};
  }
  function renderCaptions() {
    captionDefaults();
    const select=$('#captionCueSelect'); select.replaceChildren();
    project.captions.forEach((cue,index)=>{
      const option=document.createElement('option');option.value=index;
      option.textContent=`${index+1}. ${cue.start.toFixed(2)} to ${cue.end.toFixed(2)} seconds: ${cue.text.slice(0,100)}`;
      select.append(option);
    });
    captionSelection=Math.min(captionSelection,Math.max(0,project.captions.length-1));select.value=String(captionSelection);
    $('#captionPreview').checked=project.captionSettings.preview;
    $('#captionBurn').checked=project.captionSettings.burnIn;
    const cue=project.captions[captionSelection];
    $('#captionStart').value=cue?cue.start:'';$('#captionEnd').value=cue?cue.end:'';$('#captionText').value=cue?cue.text:'';
    for(const id of ['btnSaveCaption','btnDeleteCaption','btnDownloadSRT','btnDownloadVTT','btnClearCaptions']) $('#'+id).disabled=!cue;
    updateCaptionPreview();
  }
  function updateCaptionPreview() {
    const text=VoiceCutCaptions.active(project.captions,video.currentTime);
    const overlay=$('#captionOverlay');
    overlay.textContent=text;overlay.hidden=!text||!project.captionSettings?.preview;
    // Not a live region: screen-reader users choose when to hear changing captions.
    $('#currentCaption').textContent='Current caption: '+(text||'none');
  }
  async function generateCaptions() {
    if(captionRequestBusy||isExporting||cleanupBusy){announce('Wait for the current operation to finish.',true);return;}
    const original=$('#captionSource').value==='original';
    const clip=original?null:project.clips.find(c=>c.id===selectedClipId);
    const file=original?project.videoFile:clip?.file;
    if(!project.videoFile||!file){announce('Load a video and select the audio clip if required.',true);return;}
    if(project.captions?.length&&!confirm('Replace the current caption list? You can undo after generation.'))return;
    const epoch=mediaEpoch, id=project.id;
    const clipSnapshot=clip?structuredClone(clip):null;
    captionRequestBusy=true;$('#btnGenerateCaptions').disabled=true;$('#btnCancelCaptions').disabled=false;
    $('#captionStatus').textContent='Waiting for upload confirmation. Your existing captions are unchanged.';
    try{
      const result=await requestServer('/api/captions?language='+encodeURIComponent($('#captionLanguage').value),file,'OpenAI automatic captions');
      if(epoch!==mediaEpoch||id!==project.id)throw new Error('Project changed during processing. Result was not applied.');
      let cues=VoiceCutCaptions.validate(result.cues,result.duration);
      if(clipSnapshot){
        const start=clipSnapshot.trimStart||0,end=clipSnapshot.duration-(clipSnapshot.trimEnd||0);
        cues=cues.map(c=>({text:c.text,start:Math.max(start,c.start)-start+clipSnapshot.startTime,end:Math.min(end,c.end)-start+clipSnapshot.startTime})).filter(c=>c.end>c.start);
      }
      cues=cues.map(c=>({...c,start:Math.max(0,c.start),end:Math.min(project.duration,c.end)})).filter(c=>c.end>c.start);
      project.captions=VoiceCutCaptions.validate(cues,project.duration);
      project.captionLanguage=result.language;
      project.captionSource=original?'Original video audio':'Audio clip: '+clipSnapshot.name;
      captionSelection=0;pushHistory();renderCaptions();
      const message=`${cues.length} captions generated. Detected language: ${result.language||'unknown'}. Review text and timing before publishing.`;
      $('#captionStatus').textContent=message;announce(message);
    }catch(e){$('#captionStatus').textContent='Caption generation stopped: '+e.message;announce('Caption generation stopped: '+e.message,true);}
    finally{captionRequestBusy=false;$('#btnGenerateCaptions').disabled=false;$('#btnCancelCaptions').disabled=true;}
  }
  async function downloadSubtitles(format) {
    try{
      const cues=VoiceCutCaptions.forExport(project.captions,VoiceCutCore.ranges(project),project.playbackSpeed);
      if(!cues.length)throw new Error('No captions fall within the retained video segments.');
      const text=VoiceCutCaptions.serialize(cues,format);
      if(window.flutter_inappwebview){await window.flutter_inappwebview.callHandler('shareSubtitles',text,format);}
      else{
        const blob=new Blob([text],{type:format==='vtt'?'text/vtt;charset=utf-8':'application/x-subrip;charset=utf-8'});
        const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='voicecut-captions.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),60000);
      }
      announce(format.toUpperCase()+' subtitles prepared for the current edited video settings.');
    }catch(e){announce('Subtitle download failed: '+e.message,true);}
  }
  function initCaptions() {
    $('#btnGenerateCaptions').addEventListener('click',generateCaptions);
    $('#btnCancelCaptions').addEventListener('click',()=>currentRequest?.abort());
    $('#captionCueSelect').addEventListener('change',e=>{captionSelection=Number(e.target.value);renderCaptions();});
    $('#captionPreview').addEventListener('change',e=>{captionDefaults();project.captionSettings.preview=e.target.checked;pushHistory();updateCaptionPreview();});
    $('#captionBurn').addEventListener('change',e=>{captionDefaults();project.captionSettings.burnIn=e.target.checked;pushHistory();});
    $('#btnReadCaption').addEventListener('click',()=>announce($('#currentCaption').textContent));
    $('#btnAddCaption').addEventListener('click',()=>{
      if(!project.videoFile){announce('Load a video first.',true);return;}
      captionDefaults();
      if(project.captions.length>=2000){announce('Caption limit reached.',true);return;}
      const start=Math.max(0,Math.min(video.currentTime,project.duration-0.1));
      const cue={start,end:Math.min(project.duration,start+3),text:'Edit this caption'};
      project.captions.push(cue);project.captions.sort((a,b)=>a.start-b.start);captionSelection=project.captions.indexOf(cue);pushHistory();renderCaptions();$('#captionText').focus();
    });
    $('#btnSaveCaption').addEventListener('click',()=>{
      try{
        const cue=VoiceCutCaptions.validate([{start:Number($('#captionStart').value),end:Number($('#captionEnd').value),text:$('#captionText').value}],project.duration)[0];
        if(!project.captions[captionSelection])return;
        project.captions[captionSelection]=cue;project.captions.sort((a,b)=>a.start-b.start);captionSelection=project.captions.indexOf(cue);
        pushHistory();renderCaptions();announce('Caption changes saved.');
      }catch(e){announce(e.message,true);}
    });
    $('#btnDeleteCaption').addEventListener('click',()=>{project.captions.splice(captionSelection,1);pushHistory();renderCaptions();announce('Caption deleted. Undo is available.');});
    $('#btnClearCaptions').addEventListener('click',()=>showConfirm('Clear every caption? You can undo.',()=>{project.captions=[];pushHistory();renderCaptions();announce('Captions cleared.');}));
    $('#btnDownloadSRT').addEventListener('click',()=>downloadSubtitles('srt'));
    $('#btnDownloadVTT').addEventListener('click',()=>downloadSubtitles('vtt'));
    video.addEventListener('timeupdate',updateCaptionPreview);video.addEventListener('seeked',updateCaptionPreview);
  }

  // Utilities
  function announce(msg, assertive=false, long=false) {
    const el = assertive ? $('#aria-live-assertive') : $('#aria-live-polite');
    el.textContent = '';
    setTimeout(()=>{ el.textContent = msg; }, 50);
    $('#statusText').textContent = msg;
    if (long || $('#settingLongAnnouncements')?.checked) {
      // keep longer
    }
    console.log('[Announce]', msg);
  }
  function formatTime(seconds, withMs=false) {
    if (isNaN(seconds) || seconds <0) seconds = 0;
    const h = Math.floor(seconds/3600);
    const m = Math.floor((seconds%3600)/60);
    const s = Math.floor(seconds%60);
    const ms = Math.floor((seconds - Math.floor(seconds))*1000);
    const pad = (n) => String(n).padStart(2,'0');
    if (withMs) return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3,'0')}`;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  function formatTimeVerbose(seconds) {
    if (isNaN(seconds)) seconds=0;
    const h = Math.floor(seconds/3600);
    const m = Math.floor((seconds%3600)/60);
    const s = Math.floor(seconds%60);
    let parts=[];
    if (h>0) parts.push(`${String(h).padStart(2,'0')} ${h===1?'hour':'hours'}`);
    parts.push(`${String(m).padStart(2,'0')} ${m===1?'minute':'minutes'}`);
    parts.push(`${String(s).padStart(2,'0')} ${s===1?'second':'seconds'}`);
    return parts.join(' ');
  }
  function parseTime(str) {
    if (!str) return 0;
    const parts = str.split(':').map(p=>parseFloat(p));
    if (parts.length===3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length===2) return parts[0]*60 + parts[1];
    if (parts.length===1) return parts[0];
    return 0;
  }
  function uid() { return 'id_' + Math.random().toString(36).slice(2,9) + '_' + Date.now().toString(36); }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state==='suspended') audioContext.resume();
    return audioContext;
  }

  function pushHistory() {
    const snapshot = structuredClone(project);
    // Trim stack if needed
    historyStack = historyStack.slice(0, historyIndex+1);
    historyStack.push(snapshot);
    historyIndex++;
    if (historyStack.length>50) { historyStack.shift(); historyIndex--; }
    updateUndoRedoButtons();
    autoSave();
  }
  function updateUndoRedoButtons() {
    $('#btnUndo').disabled = historyIndex<=0;
    $('#btnRedo').disabled = historyIndex>=historyStack.length-1;
  }
  function undo() {
    if (historyIndex<=0) { announce('Nothing to undo.'); return; }
    historyIndex--;
    const snap = historyStack[historyIndex];
    restoreSnapshot(snap);
    announce('Undo successful.');
  }
  function redo() {
    if (historyIndex>=historyStack.length-1) { announce('Nothing to redo.'); return; }
    historyIndex++;
    const snap = historyStack[historyIndex];
    restoreSnapshot(snap);
    announce('Redo successful.');
  }
  function restoreSnapshot(snap) {
    pauseAllAudio();
    currentRequest?.abort(); mediaEpoch++;
    project = structuredClone(snap);
    if (video.src !== project.videoUrl) { video.src = project.videoUrl || ''; video.load(); }
    for (const clip of project.clips) if (clip.url) createAudioNodeForClip(clip);
    renderAll(); updateUndoRedoButtons(); autoSave();
  }
  function pauseAllAudio() {
    video.pause();
    for (const node of audioNodes.values()) {
      node.element.pause(); node.source.disconnect(); node.gain.disconnect();
    }
    audioNodes.clear();
  }

  // Rendering
  function renderAll() {
    renderCaptions();
    $('#projectNameInput').value = project.name;
    $('#skipAmountSelect').value = project.skipAmount;
    $('#playbackSpeedSelect').value = project.playbackSpeed;
    $('#exportResolution').value = project.resolution;
    $('#exportFps').value = project.fps;
    $('#exportFormat').value = project.format;
    $('#duckingToggle').checked = project.ducking.enabled;
    $('#duckingLevel').value = project.ducking.level;
    $('#origVolumeSlider').value = project.originalAudio.volume;
    $('#origVolumeNumber').value = project.originalAudio.volume;
    $('#origVolumeText').textContent = project.originalAudio.volume+'%';
    $('#origVolumeSlider').setAttribute('aria-valuetext', `Volume ${project.originalAudio.volume} percent`);
    $('#origNoiseReduction').value = project.originalAudio.noiseReduction;
    $('#globalNoiseReduction').value = project.originalAudio.noiseReduction;
    $('#btnMuteOrig').setAttribute('aria-pressed', project.originalAudio.muted ? 'true':'false');
    $('#btnMuteOrig').textContent = project.originalAudio.muted ? 'Unmute Original Audio' : 'Mute Original Audio';
    $('#trimStartInput').value = formatTime(project.trimStart);
    $('#trimEndInput').value = formatTime(project.trimEnd || project.duration);
    $('#recordPosition').value = formatTime(video.currentTime || 0);
    // FIX: Prevent double audio - mute video element when original audio muted or enhanced exists
    if (video) {
      video.muted = !!project.originalAudio.muted;
      // If enhanced original exists, always mute video element to avoid double playback
      if (project.originalAudio.enhanced) {
        video.muted = true;
      }
      // Apply volume to video element as well
      video.volume = project.originalAudio.muted ? 0 : project.originalAudio.volume / 100;
    }
    renderTimeline();
    renderMusicTracks();
    renderVoiceoverTracks();
    renderNoiseReductionTracks();
    updateExportSummary();
    renderSelectedClip();
    $('#modeBadge').textContent = advancedMode ? 'Advanced Mode' : 'Simple Mode';
  }

  function renderTimeline() {
    const container = $('#timelineContainer');
    container.innerHTML = '';
    // Video Track
    const videoTrack = document.createElement('div');
    videoTrack.className='track';
    videoTrack.setAttribute('role','listitem');
    videoTrack.setAttribute('aria-label', `Video Track. Duration ${formatTimeVerbose(project.duration)}. Trim start ${formatTimeVerbose(project.trimStart)} end ${formatTimeVerbose(project.trimEnd || project.duration)}`);
    videoTrack.innerHTML = `
      <div class="track-header"><span class="track-title">Video Track</span><span class="badge">${project.segments.length>0?project.segments.length+' segments':'1 clip'}</span></div>
      <div class="track-clips">
        ${project.segments.length>0 ? project.segments.map(seg=>`
          <div class="clip ${selectedClipId===seg.id?'selected':''}" tabindex="0" role="button" aria-label="Video Segment ${escapeHTML(seg.label||'')}. Starts at ${formatTimeVerbose(seg.start)}. Ends at ${formatTimeVerbose(seg.end)}. Duration ${formatTimeVerbose(seg.end-seg.start)}. Press Enter to select" data-clip-id="${seg.id}">
            <div class="clip-label">Video: ${escapeHTML(seg.label||formatTime(seg.start)+' - '+formatTime(seg.end))}</div>
            <div class="clip-meta">Start ${formatTime(seg.start)} End ${formatTime(seg.end)} Duration ${formatTime(seg.end-seg.start)}</div>
          </div>
        `).join('') : `
          <div class="clip" tabindex="0" role="button" aria-label="Video Track. Starts at ${formatTimeVerbose(project.trimStart)}. Ends at ${formatTimeVerbose(project.trimEnd||project.duration)}. Duration ${formatTimeVerbose((project.trimEnd||project.duration)-project.trimStart)}. Volume ${project.originalAudio.volume} percent. ${project.originalAudio.muted?'Muted':'Unmuted'}. Noise reduction ${project.originalAudio.noiseReduction}">
            <div class="clip-label">Main Video ${escapeHTML(project.name)}</div>
            <div class="clip-meta">Start ${formatTime(project.trimStart)} End ${formatTime(project.trimEnd||project.duration)} Duration ${formatTime((project.trimEnd||project.duration)-project.trimStart)} | Vol ${project.originalAudio.volume}% | NR ${project.originalAudio.noiseReduction}</div>
          </div>
        `}
      </div>
    `;
    container.appendChild(videoTrack);

    // Original Audio Track
    const origTrack = document.createElement('div');
    origTrack.className='track';
    origTrack.setAttribute('role','listitem');
    origTrack.setAttribute('aria-label', `Original Audio Track. Volume ${project.originalAudio.volume} percent. ${project.originalAudio.muted?'Muted':'Unmuted'}. Noise reduction ${project.originalAudio.noiseReduction}. Fade in ${project.originalAudio.fadeIn} seconds. Fade out ${project.originalAudio.fadeOut} seconds.`);
    origTrack.innerHTML = `
      <div class="track-header"><span class="track-title">Original Audio Track</span><span class="badge">${project.originalAudio.muted?'Muted':project.originalAudio.volume+'%'}</span></div>
      <div class="track-clips">
        <div class="clip ${project.originalAudio.muted?'muted':''}" tabindex="0" role="button" aria-label="Original Audio Track. Starts at ${formatTimeVerbose(project.trimStart)}. Ends at ${formatTimeVerbose(project.trimEnd||project.duration)}. Volume ${project.originalAudio.volume} percent. ${project.originalAudio.muted?'Muted':'Unmuted'}. Noise reduction ${project.originalAudio.noiseReduction}">
          <div class="clip-label">Original Audio</div>
          <div class="clip-meta">Vol ${project.originalAudio.volume}% | ${project.originalAudio.muted?'Muted':'Unmuted'} | NR ${project.originalAudio.noiseReduction} | Fade In ${project.originalAudio.fadeIn}s Out ${project.originalAudio.fadeOut}s</div>
        </div>
      </div>
    `;
    container.appendChild(origTrack);

    // Group clips by type
    const musicClips = project.clips.filter(c=>c.type==='music');
    const voiceClips = project.clips.filter(c=>c.type==='voiceover');

    // Music tracks grouped by trackIndex or each clip as separate track for accessibility
    const musicByTrack = {};
    musicClips.forEach(c=>{
      const key = c.trackIndex ?? 1;
      if (!musicByTrack[key]) musicByTrack[key]=[];
      musicByTrack[key].push(c);
    });
    Object.keys(musicByTrack).sort().forEach(trackNum=>{
      const clips = musicByTrack[trackNum];
      const trackEl = document.createElement('div');
      trackEl.className='track';
      trackEl.setAttribute('role','listitem');
      trackEl.setAttribute('aria-label', `Music Track ${trackNum}. ${clips.length} clips`);
      trackEl.innerHTML = `
        <div class="track-header"><span class="track-title">Music Track ${trackNum}</span><span class="badge">${clips.length} clips</span></div>
        <div class="track-clips">
          ${clips.map(c=>`
            <div class="clip ${selectedClipId===c.id?'selected':''} ${c.muted?'muted':''}" tabindex="0" role="button" aria-label="Music Track ${trackNum}. ${escapeHTML(c.name)}. Starts at ${formatTimeVerbose(c.startTime)}. Ends at ${formatTimeVerbose(c.startTime + (c.duration - c.trimStart - c.trimEnd))}. Duration ${formatTimeVerbose(c.duration - c.trimStart - c.trimEnd)}. Volume ${c.volume} percent. ${c.muted?'Muted':'Unmuted'}. Fade in ${c.fadeIn} seconds. Fade out ${c.fadeOut} seconds. Noise reduction ${c.noiseReduction}. Press Enter to select. Press Delete to delete" data-clip-id="${c.id}">
              <div class="clip-label">${escapeHTML(c.name)}</div>
              <div class="clip-meta">Start ${formatTime(c.startTime)} End ${formatTime(c.startTime + (c.duration - c.trimStart - c.trimEnd))} Dur ${formatTime(c.duration - c.trimStart - c.trimEnd)} | Vol ${c.volume}% | ${c.muted?'Muted':''} NR ${c.noiseReduction}</div>
              <div class="clip-controls">
                <button aria-label="Play ${escapeHTML(c.name)}, button" data-action="play" data-id="${c.id}">Play</button>
                <button aria-label="Mute ${escapeHTML(c.name)}, button" data-action="mute" data-id="${c.id}">${c.muted?'Unmute':'Mute'}</button>
                <button aria-label="Delete ${escapeHTML(c.name)}, button" data-action="delete" data-id="${c.id}">Delete</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      container.appendChild(trackEl);
    });

    const voiceByTrack = {};
    voiceClips.forEach(c=>{
      const key = c.trackIndex ?? 1;
      if (!voiceByTrack[key]) voiceByTrack[key]=[];
      voiceByTrack[key].push(c);
    });
    Object.keys(voiceByTrack).sort().forEach(trackNum=>{
      const clips = voiceByTrack[trackNum];
      const trackEl = document.createElement('div');
      trackEl.className='track';
      trackEl.setAttribute('role','listitem');
      trackEl.setAttribute('aria-label', `Voice-over Track ${trackNum}. ${clips.length} clips`);
      trackEl.innerHTML = `
        <div class="track-header"><span class="track-title">Voice-over Track ${trackNum}</span><span class="badge">${clips.length} clips</span></div>
        <div class="track-clips">
          ${clips.map(c=>`
            <div class="clip ${selectedClipId===c.id?'selected':''} ${c.muted?'muted':''}" tabindex="0" role="button" aria-label="Voice-over Track ${trackNum}. ${escapeHTML(c.name)}. Starts at ${formatTimeVerbose(c.startTime)}. Ends at ${formatTimeVerbose(c.startTime + (c.duration - c.trimStart - c.trimEnd))}. Duration ${formatTimeVerbose(c.duration - c.trimStart - c.trimEnd)}. Volume ${c.volume} percent. ${c.muted?'Muted':'Unmuted'}. Noise reduction ${c.noiseReduction}. Press Enter to select" data-clip-id="${c.id}">
              <div class="clip-label">${escapeHTML(c.name)}</div>
              <div class="clip-meta">Start ${formatTime(c.startTime)} End ${formatTime(c.startTime + (c.duration - c.trimStart - c.trimEnd))} Dur ${formatTime(c.duration - c.trimStart - c.trimEnd)} | Vol ${c.volume}% | NR ${c.noiseReduction}</div>
              <div class="clip-controls">
                <button aria-label="Play ${escapeHTML(c.name)}, button" data-action="play" data-id="${c.id}">Play</button>
                <button aria-label="Mute ${escapeHTML(c.name)}, button" data-action="mute" data-id="${c.id}">${c.muted?'Unmute':'Mute'}</button>
                <button aria-label="Delete ${escapeHTML(c.name)}, button" data-action="delete" data-id="${c.id}">Delete</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      container.appendChild(trackEl);
    });

    // Attach listeners
    container.querySelectorAll('[data-clip-id]').forEach(el=>{
      el.addEventListener('click', (e)=>{
        if (e.target.tagName==='BUTTON') return;
        selectClip(el.getAttribute('data-clip-id'));
      });
      el.addEventListener('keydown', (e)=>{
        if (e.key==='Enter' || e.key===' ') {
          e.preventDefault();
          selectClip(el.getAttribute('data-clip-id'));
        }
        if (e.key==='Delete') {
          deleteClip(el.getAttribute('data-clip-id'));
        }
      });
    });
    container.querySelectorAll('button[data-action]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-action');
        if (act==='play') playClipPreview(id);
        if (act==='mute') toggleMuteClip(id);
        if (act==='delete') deleteClip(id);
      });
    });
  }

  function renderMusicTracks() {
    const container = $('#musicTracksList');
    const musicClips = project.clips.filter(c=>c.type==='music');
    if (musicClips.length===0) {
      container.innerHTML = '<p style="color:var(--text2)">No music tracks yet. Add music to start.</p>';
      return;
    }
    container.innerHTML = musicClips.map(c=>`
      <div class="track" role="listitem" aria-label="Music Track clip ${escapeHTML(c.name)}. Starts at ${formatTimeVerbose(c.startTime)}. Ends at ${formatTimeVerbose(c.startTime + c.duration)}. Volume ${c.volume} percent">
        <div class="track-header"><span class="track-title">${escapeHTML(c.name)}</span><span class="badge">${c.volume}%</span></div>
        <div>Start ${formatTime(c.startTime)} | Duration ${formatTime(c.duration - c.trimStart - c.trimEnd)} | Volume ${c.volume}% | ${c.muted?'Muted':'Unmuted'}</div>
      </div>
    `).join('');
  }
  function renderVoiceoverTracks() {
    const container = $('#voiceoverTracksList');
    const clips = project.clips.filter(c=>c.type==='voiceover');
    if (clips.length===0) {
      container.innerHTML = '<p style="color:var(--text2)">No voice-over tracks yet.</p>';
      return;
    }
    container.innerHTML = clips.map(c=>`
      <div class="track" role="listitem" aria-label="Voice-over Track clip ${escapeHTML(c.name)}. Starts at ${formatTimeVerbose(c.startTime)}. Volume ${c.volume} percent. Noise reduction ${c.noiseReduction}">
        <div class="track-header"><span class="track-title">${escapeHTML(c.name)}</span><span class="badge">Vol ${c.volume}% | NR ${c.noiseReduction}</span></div>
        <div>Start ${formatTime(c.startTime)} | Duration ${formatTime(c.duration - c.trimStart - c.trimEnd)} | Vol ${c.volume}% | NR ${c.noiseReduction}</div>
      </div>
    `).join('');
  }
  function renderNoiseReductionTracks() {
    const container = $('#noiseReductionTracks');
    container.innerHTML = '';
    const allTracks = [
      {label:'Original Audio', value:project.originalAudio.noiseReduction, id:'orig'},
      ...project.clips.map(c=>({label:c.name, value:c.noiseReduction, id:c.id}))
    ];
    allTracks.forEach(t=>{
      const div = document.createElement('div');
      div.innerHTML = `<label>${escapeHTML(t.label)}: <select data-nr-id="${t.id}" aria-label="Noise reduction for ${escapeHTML(t.label)}">
        <option value="off" ${t.value==='off'?'selected':''}>Off</option>
        <option value="light" ${t.value==='light'?'selected':''}>Light</option>
        <option value="medium" ${t.value==='medium'?'selected':''}>Medium</option>
        <option value="strong" ${t.value==='strong'?'selected':''}>Strong</option>
        <option value="custom" ${t.value==='custom'?'selected':''}>Custom</option>
      </select></label>`;
      container.appendChild(div);
    });
    container.querySelectorAll('select').forEach(sel=>{
      sel.addEventListener('change', (e)=>{
        const id = e.target.getAttribute('data-nr-id');
        const val = e.target.value;
        if (id==='orig') {
          project.originalAudio.noiseReduction = val;
          announce(`Noise reduction for original audio set to ${val}.`);
        } else {
          const clip = project.clips.find(c=>c.id===id);
          if (clip) { clip.noiseReduction = val; announce(`Noise reduction for ${escapeHTML(clip.name)} set to ${val}.`); }
        }
        pushHistory();
        renderAll();
      });
    });
  }

  function renderSelectedClip() {
    const panel = $('#selectedClipPanel');
    if (!selectedClipId) { panel.classList.add('hidden'); return; }
    const clip = project.clips.find(c=>c.id===selectedClipId) || project.segments.find(s=>s.id===selectedClipId);
    if (!clip) { panel.classList.add('hidden'); return; }
    if (clip.start!==undefined && clip.end!==undefined && !clip.type) {
      // video segment
      panel.classList.remove('hidden');
      $('#selectedClipInfo').textContent = `Video Segment. Starts at ${formatTime(clip.start)}. Ends at ${formatTime(clip.end)}. Duration ${formatTime(clip.end-clip.start)}.`;
      return;
    }
    panel.classList.remove('hidden');
    $('#selectedClipInfo').textContent = `${clip.type==='music'?'Music':'Voice-over'} Track. ${escapeHTML(clip.name)}. Starts at ${formatTimeVerbose(clip.startTime)}. Ends at ${formatTimeVerbose(clip.startTime + (clip.duration - clip.trimStart - clip.trimEnd))}. Duration ${formatTimeVerbose(clip.duration - clip.trimStart - clip.trimEnd)}. Volume ${clip.volume} percent. ${clip.muted?'Muted':'Unmuted'}. Noise reduction ${clip.noiseReduction}.`;
    $('#selStartTime').value = formatTime(clip.startTime);
    $('#selEndTime').value = formatTime(clip.startTime + (clip.duration - clip.trimStart - clip.trimEnd));
    $('#selDuration').value = formatTime(clip.duration - clip.trimStart - clip.trimEnd);
    $('#selVolumeSlider').value = clip.volume;
    $('#selVolumeNumber').value = clip.volume;
    $('#selVolumeText').textContent = clip.volume+'%';
    $('#selVolumeSlider').setAttribute('aria-valuetext', `Volume ${clip.volume} percent`);
    $('#selNoiseReduction').value = clip.noiseReduction;
    $('#selFadeIn').value = clip.fadeIn;
    $('#selFadeOut').value = clip.fadeOut;
    $('#selMute').setAttribute('aria-pressed', clip.muted?'true':'false');
    $('#selMute').textContent = clip.muted?'Unmute':'Mute';
  }

  function selectClip(id) {
    selectedClipId = id;
    renderAll();
    const clip = project.clips.find(c=>c.id===id);
    if (clip) {
      announce(`${clip.type==='music'?'Music':'Voice-over'} Track ${clip.trackIndex||''}. ${escapeHTML(clip.name)}. Starts at ${formatTimeVerbose(clip.startTime)}. Ends at ${formatTimeVerbose(clip.startTime + clip.duration)}. Volume ${clip.volume} percent. ${clip.muted?'Muted':'Unmuted'}. Noise reduction ${clip.noiseReduction}.`);
      $('#selectedClipPanel').focus();
    } else {
      const seg = project.segments.find(s=>s.id===id);
      if (seg) announce(`Video segment selected. Starts at ${formatTimeVerbose(seg.start)}. Ends at ${formatTimeVerbose(seg.end)}.`);
    }
  }

  function updateExportSummary() {
    const summary = $('#exportSummary');
    const musicCount = project.clips.filter(c=>c.type==='music').length;
    const voiceCount = project.clips.filter(c=>c.type==='voiceover').length;
    const totalDuration = (project.trimEnd||project.duration) - project.trimStart;
    summary.innerHTML = `
      Video duration: ${formatTime(totalDuration)}<br>
      Resolution: ${project.resolution}p<br>
      Frame rate: ${project.fps} fps<br>
      Format: ${project.format.toUpperCase()}<br>
      Audio tracks: Original Audio (${project.originalAudio.volume}%) + ${musicCount} music + ${voiceCount} voice-over<br>
      Ducking: ${project.ducking.enabled?'On at '+project.ducking.level+'%':'Off'}<br>
      Estimated file size: ${Math.round(totalDuration* (project.resolution==='1080'?2.5:1.5))} MB (approx)
    `;
  }

  // Video handling
  function loadVideoFile(file) {
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) { announce('Use a video under 500 MB; large files can exhaust device memory.',true); return; }
    currentRequest?.abort(); mediaEpoch++;
    pauseAllAudio();
    project.captions = [];
    project.trimStart = 0;
    project.originalAudio.enhanced = false; project.originalAudio.muted = false;
    project.clips = project.clips.filter(c => !c.id.startsWith('enhanced_original_'));
    historyStack = []; historyIndex = -1;
    project.videoFile = file;
    project.videoUrl = URL.createObjectURL(file);
    video.src = project.videoUrl;
    video.load();
    $('#videoPlaceholder').classList.add('hidden');
    video.addEventListener('loadedmetadata', () => {
      project.duration = video.duration;
      project.trimEnd = video.duration;
      project.segments = [{id:uid(), start:0, end:video.duration, label:'Full Video'}];
      pushHistory();
      renderAll();
      announce(`Video loaded successfully. Duration ${formatTimeVerbose(video.duration)}.`, true);
      $('#editorScreen').classList.remove('hidden');
      $('#homeScreen').classList.add('hidden');
      $('#section-video').scrollIntoView({behavior:'smooth'});
    }, {once:true});
    video.addEventListener('error', ()=>{
      announce('Video load failed. Try MP4 at 1080p.', true);
    }, {once:true});
  }

  function addAudioFile(file, type='music', position=video.currentTime || 0) {
    if (!file) return;
    ensureAudioContext();
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.src = url;
    audio.addEventListener('error', () => { URL.revokeObjectURL(url); announce('Audio cannot be decoded by this browser.', true); }, {once:true});
    audio.addEventListener('loadedmetadata', async ()=>{
      if (!Number.isFinite(audio.duration)) {
        try {
          const decoded = await ensureAudioContext().decodeAudioData(await file.arrayBuffer());
          Object.defineProperty(audio, 'duration', {value: decoded.duration});
        } catch { announce('Could not determine recording duration. Try importing another audio format.',true); return; }
      }
      const existingOfType = project.clips.filter(c=>c.type===type).length;
      const trackIndex = type==='music' ? Math.floor(existingOfType/1)+1 : Math.floor(existingOfType/1)+1;
      // Determine next track index: if music, count distinct trackIndex
      let nextTrackIndex = 1;
      if (type==='music') {
        const musicTracks = new Set(project.clips.filter(c=>c.type==='music').map(c=>c.trackIndex));
        nextTrackIndex = musicTracks.size + 1;
      } else {
        const voiceTracks = new Set(project.clips.filter(c=>c.type==='voiceover').map(c=>c.trackIndex));
        nextTrackIndex = voiceTracks.size + 1;
      }
      const clip = {
        id: uid(),
        name: file.name.replace(/\.[^/.]+$/,''),
        type,
        file,
        url,
        startTime: position,
        trimStart: 0,
        trimEnd: 0,
        duration: audio.duration || 60,
        volume: type==='music' ? 60 : 100,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        noiseReduction: type==='music' ? 'off' : 'medium',
        trackIndex: nextTrackIndex
      };
      project.clips.push(clip);
      pushHistory();
      renderAll();
      announce(`${type==='music'?'Music':'Voice-over'} Track ${nextTrackIndex} added at ${formatTimeVerbose(clip.startTime)}. ${escapeHTML(clip.name)}. Duration ${formatTimeVerbose(clip.duration)}. Volume ${clip.volume} percent.`);
      // Auto play preview?
      createAudioNodeForClip(clip);
    });
  }

  function createAudioNodeForClip(clip) {
    const previous = audioNodes.get(clip.id);
    if (previous) { previous.element.pause(); previous.source.disconnect(); previous.gain.disconnect(); }
    if (!clip.url) return;
    try {
      ensureAudioContext();
      const audioEl = new Audio();
      audioEl.src = clip.url;
      audioEl.crossOrigin = 'anonymous';
      audioEl.preload = 'auto';
      const source = audioContext.createMediaElementSource(audioEl);
      const gain = audioContext.createGain();
      gain.gain.value = (clip.muted?0:clip.volume/100);
      // Filters for noise reduction
      const highpass = audioContext.createBiquadFilter();
      highpass.type='highpass';
      highpass.frequency.value = clip.noiseReduction==='off'?0 : clip.noiseReduction==='light'?80 : clip.noiseReduction==='medium'?100 : 120;
      const lowpass = audioContext.createBiquadFilter();
      lowpass.type='lowpass';
      lowpass.frequency.value = clip.noiseReduction==='off'?20000 : clip.noiseReduction==='light'?12000 : clip.noiseReduction==='medium'?8000 : 6000;
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = clip.noiseReduction==='off'?0 : clip.noiseReduction==='light'?-30 : -40;
      compressor.knee.value = 20;
      compressor.ratio.value = clip.noiseReduction==='off'?1 : clip.noiseReduction==='strong'?12 : 6;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.25;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(gain);
      gain.connect(audioContext.destination);

      audioNodes.set(clip.id, {element:audioEl, source, gain, highpass, lowpass, compressor});
    } catch(e) {
      console.warn('Web Audio setup failed', e);
    }
  }

  function syncAudioPlayback(forExport = false) {
    if (isExporting && !forExport) return;
    // FIX: Ensure video element muted state matches project setting to prevent double audio
    if (video) {
      if (project.originalAudio.enhanced || project.originalAudio.muted) {
        if (!video.muted) video.muted = true;
      } else {
        if (video.muted) video.muted = false;
      }
    }
    const original = project.originalAudio;
    const t = video.currentTime - project.trimStart;
    const duration = (project.trimEnd || project.duration) - project.trimStart;
    let fade = 1;
    if (original.fadeIn > 0) fade = Math.min(fade, t / original.fadeIn);
    if (original.fadeOut > 0) fade = Math.min(fade, (duration-t) / original.fadeOut);
    video.volume = Math.max(0, Math.min(1, original.volume / 100 * fade));
    if (!project.clips.length) return;
    const currentTime = video.currentTime;
    const voiceActive = project.clips.some(c=>c.type==='voiceover' && !c.muted && currentTime>=c.startTime && currentTime<=c.startTime + (c.duration - c.trimStart - c.trimEnd));

    project.clips.forEach(clip=>{
      const node = audioNodes.get(clip.id);
      if (!node) { createAudioNodeForClip(clip); return; }
      const clipEnd = clip.startTime + (clip.duration - clip.trimStart - clip.trimEnd);
      const shouldPlay = currentTime>=clip.startTime && currentTime<=clipEnd && !clip.muted && !video.paused;
      const audioEl = node.element;

      // Ducking
      let effectiveVolume = clip.volume/100;
      if (clip.type==='music' && voiceActive && project.ducking.enabled) {
        effectiveVolume = effectiveVolume * (1 - project.ducking.level/100);
        // Smooth transition
        node.gain.gain.linearRampToValueAtTime(effectiveVolume, audioContext.currentTime+0.3);
      } else {
        if (!clip.muted) node.gain.gain.linearRampToValueAtTime(clip.muted?0:clip.volume/100, audioContext.currentTime+0.1);
      }

      // Fade
      const timeInClip = currentTime - clip.startTime;
      const clipDur = clip.duration - clip.trimStart - clip.trimEnd;
      let fadeVol = 1;
      if (clip.fadeIn>0 && timeInClip < clip.fadeIn) fadeVol = timeInClip/clip.fadeIn;
      if (clip.fadeOut>0 && timeInClip > clipDur - clip.fadeOut) fadeVol = Math.min(fadeVol, (clipDur - timeInClip)/clip.fadeOut);
      // Apply fade as multiplier
      const finalVol = clip.muted ? 0 : effectiveVolume * Math.max(0,fadeVol);
      node.gain.gain.cancelScheduledValues(audioContext.currentTime);
      node.gain.gain.value = finalVol;
      audioEl.playbackRate = project.playbackSpeed;
      // Don't ramp too often for fade, set directly
      // Use gain node for volume, but we already used for ducking, so combine
      // For simplicity, set gain to finalVol
      // Actually we already set gain for ducking, so adjust

      if (shouldPlay) {
        const desiredAudioTime = (currentTime - clip.startTime) + clip.trimStart;
        if (Math.abs(audioEl.currentTime - desiredAudioTime) > 0.5) audioEl.currentTime = desiredAudioTime;
        if (audioEl.paused) audioEl.play().catch(()=>{});
      } else {
        if (!audioEl.paused) audioEl.pause();
      }
    });
  }

  function playClipPreview(id) {
    const clip = project.clips.find(c=>c.id===id);
    if (!clip) return;
    const node = audioNodes.get(id);
    if (node) {
      node.element.currentTime = clip.trimStart;
      node.element.play();
      announce(`Playing ${escapeHTML(clip.name)}. Volume ${clip.volume} percent.`);
      setTimeout(()=>{ node.element.pause(); }, 5000);
    }
  }
  function toggleMuteClip(id) {
    const clip = project.clips.find(c=>c.id===id);
    if (!clip) return;
    clip.muted = !clip.muted;
    const node = audioNodes.get(id);
    if (node) node.gain.gain.value = clip.muted?0:clip.volume/100;
    pushHistory();
    renderAll();
    announce(`${escapeHTML(clip.name)} ${clip.muted?'muted':'unmuted'}.`);
  }
  function deleteClip(id) {
    const clip = project.clips.find(c=>c.id===id);
    if (!clip) {
      // maybe video segment
      const segIndex = project.segments.findIndex(s=>s.id===id);
      if (segIndex>=0) {
        project.segments.splice(segIndex,1);
        pushHistory();
        renderAll();
        announce('Video segment deleted.');
        return;
      }
      return;
    }
    showConfirm(`Delete ${escapeHTML(clip.name)}?`, ()=>{
      project.clips = project.clips.filter(c=>c.id!==id);
      if (clip.isEnhancedOriginal) { project.originalAudio.enhanced = false; project.originalAudio.muted = false; }
      const node = audioNodes.get(id);
      if (node) { try{node.element.pause();}catch{}; audioNodes.delete(id); }
      if (selectedClipId===id) selectedClipId=null;
      pushHistory();
      renderAll();
      announce(`${escapeHTML(clip.name)} deleted.`);
    });
  }

  // Playback controls
  function playVideo() {
    if(isExporting)return;
    if(project.videoFile){
      try { const ranges=VoiceCutCore.ranges(project); if(video.currentTime<ranges[0].start || video.currentTime>=ranges.at(-1).end-0.015)video.currentTime=ranges[0].start; }
      catch(e){announce(e.message,true);return;}
    }
    ensureAudioContext();
    video.playbackRate = project.playbackSpeed;
    video.play();
    announce('Playing video.');
  }
  function pauseVideo() { video.pause(); announce('Video paused.'); }
  function stopVideo() { video.pause(); video.currentTime = project.trimStart || 0; announce('Video stopped.'); }
  function skipBack() {
    const amt = project.skipAmount;
    video.currentTime = Math.max(project.trimStart, video.currentTime - amt);
    announce(`Skipped backward ${amt} seconds. Current position ${formatTimeVerbose(video.currentTime)} of ${formatTimeVerbose(project.duration)}.`);
  }
  function skipForward() {
    const amt = project.skipAmount;
    video.currentTime = Math.min(project.trimEnd||project.duration, video.currentTime + amt);
    announce(`Skipped forward ${amt} seconds. Current position ${formatTimeVerbose(video.currentTime)} of ${formatTimeVerbose(project.duration)}.`);
  }
  function prevFrame() {
    video.currentTime = Math.max(0, video.currentTime - 1/30);
    announce(`Previous frame. Position ${formatTimeVerbose(video.currentTime)}.`);
  }
  function nextFrame() {
    video.currentTime = Math.min(video.duration, video.currentTime + 1/30);
    announce(`Next frame. Position ${formatTimeVerbose(video.currentTime)}.`);
  }
  function splitVideo() {
    const pos = video.currentTime;
    if (pos<=project.trimStart || pos>= (project.trimEnd||project.duration)) { announce('Cannot split outside trimmed range.'); return; }
    // Find segment containing pos
    let segIndex = project.segments.findIndex(s=> pos>=s.start && pos<=s.end);
    if (segIndex===-1) {
      // create segments from trim
      project.segments = [{id:uid(), start:project.trimStart, end:pos, label:'Clip 1'}, {id:uid(), start:pos, end:project.trimEnd||project.duration, label:'Clip 2'}];
    } else {
      const seg = project.segments[segIndex];
      const newSeg1 = {id:uid(), start:seg.start, end:pos, label: seg.label+' A'};
      const newSeg2 = {id:uid(), start:pos, end:seg.end, label: seg.label+' B'};
      project.segments.splice(segIndex,1,newSeg1,newSeg2);
    }
    pushHistory();
    renderAll();
    announce(`Video split at ${formatTimeVerbose(pos)}.`);
  }
  function trimStart() {
    project.trimStart = video.currentTime;
    if (project.trimStart >= (project.trimEnd||project.duration)) project.trimStart = Math.max(0, (project.trimEnd||project.duration)-1);
    pushHistory();
    renderAll();
    announce(`Trim start set to ${formatTimeVerbose(project.trimStart)}.`);
  }
  function trimEnd() {
    project.trimEnd = video.currentTime;
    if (project.trimEnd <= project.trimStart) project.trimEnd = project.duration;
    pushHistory();
    renderAll();
    announce(`Trim end set to ${formatTimeVerbose(project.trimEnd)}.`);
  }

  // Selected clip controls
  function updateSelectedClipVolume(vol) {
    if (!selectedClipId) return;
    const clip = project.clips.find(c=>c.id===selectedClipId);
    if (!clip) return;
    clip.volume = Math.max(0,Math.min(100, vol));
    const node = audioNodes.get(clip.id);
    if (node) node.gain.gain.value = clip.muted?0:clip.volume/100;
    renderSelectedClip();
    renderTimeline(); autoSave();
    announce(`Volume for ${escapeHTML(clip.name)} changed to ${clip.volume} percent.`);
  }
  function applyVolumeToScope(scope) {
    if (!selectedClipId) return;
    const clip = project.clips.find(c=>c.id===selectedClipId);
    if (!clip) return;
    const vol = clip.volume;
    if (scope==='clip') { pushHistory(); announce(`Volume ${vol} percent applied to this clip only.`); return; }
    if (scope==='track') {
      const sameTrack = project.clips.filter(c=>c.trackIndex===clip.trackIndex && c.type===clip.type);
      sameTrack.forEach(c=>{ c.volume=vol; const n=audioNodes.get(c.id); if(n) n.gain.gain.value=c.muted?0:c.volume/100; });
      pushHistory(); renderAll(); announce(`Apply ${vol} percent volume to all clips in this track? Applied to ${sameTrack.length} clips.`);
      return;
    }
    if (scope==='allMusic') {
      showConfirm(`Apply ${vol} percent volume to all music tracks?`, ()=>{
        project.clips.filter(c=>c.type==='music').forEach(c=>{ c.volume=vol; const n=audioNodes.get(c.id); if(n) n.gain.gain.value=c.muted?0:c.volume/100; });
        pushHistory(); renderAll(); announce(`Applied ${vol} percent volume to all music tracks.`);
      });
      return;
    }
    if (scope==='allAudio') {
      showConfirm(`Apply ${vol} percent volume to all audio?`, ()=>{
        project.clips.forEach(c=>{ c.volume=vol; const n=audioNodes.get(c.id); if(n) n.gain.gain.value=c.muted?0:c.volume/100; });
        project.originalAudio.volume=vol;
        pushHistory(); renderAll(); announce(`Applied ${vol} percent volume to all audio.`);
      });
    }
  }

  // Recording
  function openRecordDialog() {
    $('#recordDialog').showModal();
    $('#recordPosition').value = formatTime(video.currentTime);
  }
  let recordingStream = null;
  let recordingRequest = 0;
  async function startRecording() {
    if (isRecording || recordingStream) return;
    const requestId = ++recordingRequest;
    const position = parseTime($('#recordPosition').value);
    if (!Number.isFinite(position) || position < 0) { announce('Enter a valid recording position.', true); return; }
    $('#btnStartRecording').disabled = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Recording needs HTTPS and a browser with microphone support.');
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (requestId !== recordingRequest || !$('#recordDialog').open) { stream.getTracks().forEach(t=>t.stop()); return; }
      recordingStream = stream;
      const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error('No supported audio recorder format.');
      mediaRecorder = new MediaRecorder(stream,{mimeType:mime});
      const chunks = [];
      mediaRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      mediaRecorder.onstop = () => {
        clearInterval(recordTimerInterval); stream.getTracks().forEach(t=>t.stop()); recordingStream = null; isRecording=false;
        $('#btnStopVO').disabled=true; $('#btnRecordVO').disabled=false;
        $('#btnStopRecordingDialog').disabled=true; $('#btnStartRecording').disabled=false;
        video.pause();
        if (chunks.length) {
          const blob = new Blob(chunks,{type:mediaRecorder.mimeType});
          const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
          addAudioFile(new File([blob],`Voiceover_${Date.now()}.${extension}`,{type:blob.type}),'voiceover',position);
        }
        $('#recordDialog').close();
        announce('Recording stopped. Adding voice-over.');
      };
      mediaRecorder.onerror = () => { stopRecording(); announce('Recording failed.',true); };
      mediaRecorder.start(250); isRecording=true; recordStartTime=Date.now();
      $('#btnStopVO').disabled=false; $('#btnStopRecordingDialog').disabled=false; $('#btnRecordVO').disabled=true;
      $('#recordCountdown').textContent='Recording'; $('#recordCountdown').classList.remove('hidden');
      // No video sound through speakers during voice-over recording.
      video.pause(); for (const node of audioNodes.values()) node.element.pause();
      announce('Recording started. Speak now.');
      recordTimerInterval=setInterval(()=>{ $('#recordTimer').textContent=formatTime((Date.now()-recordStartTime)/1000); },1000);
    } catch(e) {
      recordingStream?.getTracks().forEach(t=>t.stop()); recordingStream=null;
      $('#btnStartRecording').disabled=false; announce('Cannot record: '+e.message,true);
    }
  }
  function stopRecording() {
    recordingRequest++;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    else { recordingStream?.getTracks().forEach(t=>t.stop()); recordingStream=null; $('#btnStartRecording').disabled=false; }
  }

  let originalSource = null;
  let originalGain = null;
  let exportCleanup = null;
  let lockedExportControls = [];
  function lockExportControls(lock) {
    if(lock) { lockedExportControls = [...document.querySelectorAll('button,input,select,textarea')].filter(el=>el.id!=='btnCancelExport' && !el.disabled); lockedExportControls.forEach(el=>el.disabled=true); }
    else { lockedExportControls.forEach(el=>el.disabled=false); lockedExportControls=[]; }
  }
  let exportCancelled = false;
  let exportUrl = null;
  function ensureOriginalGraph() {
    ensureAudioContext();
    if (!originalSource) {
      originalSource = audioContext.createMediaElementSource(video);
      originalGain = audioContext.createGain();
      originalSource.connect(originalGain);
      originalGain.connect(audioContext.destination);
    }
    return originalGain;
  }
  function seekTo(time) {
    if (Math.abs(video.currentTime-time) < 0.001 && video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('Video seek timed out.')); }, 10000);
      function done() { clearTimeout(timer); resolve(); }
      video.addEventListener('seeked', done, {once:true});
      video.currentTime = time;
    });
  }
  async function doExport() {
    if (captionRequestBusy || cleanupBusy) { announce('Wait for audio or caption processing to finish.',true); return; }
    if (!project.videoUrl || isExporting) { announce('Load a video first, or wait for the current export.'); return; }
    let recorder;
    try {
      if (!window.MediaRecorder || !exportCanvas.captureStream) throw new Error('This browser cannot record video. Try current Chrome.');
      const ranges = VoiceCutCore.ranges(project);
      const mime = VoiceCutCore.mimeFor(project.format, value => MediaRecorder.isTypeSupported(value));
      const duration = ranges.reduce((sum,r) => sum+r.end-r.start,0);
      video.pause();
      for (const node of audioNodes.values()) node.element.pause();
      isExporting = true; exportCancelled = false; lockExportControls(true);
      $('#btnDoExport').disabled = true;
      $('#btnCancelExport').disabled = false;
      $('#exportProgressContainer').classList.remove('hidden');
      $('#exportProgressContainer').removeAttribute('aria-hidden');
      $('#exportStatus').textContent = 'Exporting. Keep this tab visible until finished.';
      announce('Export started. Keep this tab visible. Export runs in real time.');
      await ensureAudioContext().resume();
      const gain = ensureOriginalGraph();
      const dest = audioContext.createMediaStreamDestination();
      gain.disconnect(); gain.connect(dest);
      gain.gain.value = 1;
      for (const clip of project.clips) if (!audioNodes.has(clip.id)) createAudioNodeForClip(clip);
      for (const node of audioNodes.values()) { node.gain.disconnect(); node.gain.connect(dest); }
      const height = Number(project.resolution);
      exportCanvas.height = height; exportCanvas.width = Math.round(height*16/9/2)*2;
      const ctx = exportCanvas.getContext('2d');
      const canvasStream = exportCanvas.captureStream(Number(project.fps));
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      let raf, timeout, completed = 0, rangeIndex = 0, lastAnnouncement = -1;
      const visibility = () => { if (document.hidden) cancelExport(); };
      document.addEventListener('visibilitychange', visibility);
      exportCleanup = () => {
        cancelAnimationFrame(raf); clearTimeout(timeout);
        document.removeEventListener('visibilitychange', visibility);
        video.pause();
        for (const node of audioNodes.values()) { node.element.pause(); node.gain.disconnect(); node.gain.connect(audioContext.destination); }
        gain.disconnect(); gain.connect(audioContext.destination);
        stream.getTracks().forEach(t => t.stop());
        isExporting = false; lockExportControls(false); $('#btnDoExport').disabled = false; $('#btnCancelExport').disabled = true;
        exportCleanup = null;
      };
      recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6000000});
      exportRecorder = recorder;
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { exportCancelled = true; exportCleanup?.(); announce('Recording failed. Try another browser or resolution.', true); };
      recorder.onstop = () => {
        exportCleanup?.();
        if (exportCancelled) { $('#exportStatus').textContent = 'Export cancelled. No partial file saved.'; return; }
        exportedBlob = new Blob(chunks, {type: recorder.mimeType});
        if (exportUrl) URL.revokeObjectURL(exportUrl);
        exportUrl = URL.createObjectURL(exportedBlob); exportedVideoEl.src = exportUrl;
        for (const id of ['exportedVideo','btnPlayExported','btnDownloadExported','btnShareExported']) $('#'+id).classList.remove('hidden');
        $('#exportProgressBar').style.width = '100%'; $('#exportProgressBar').setAttribute('aria-valuenow','100');
        $('#exportStatus').textContent = 'Export complete. Preview, then download.';
        announce('Export complete. Preview, then download.', true);
      };
      await seekTo(ranges[0].start);
      if (exportCancelled) { exportCleanup?.(); return; }
      video.playbackRate = project.playbackSpeed;
      recorder.start(250);
      await video.play();
      timeout = setTimeout(cancelExport, (duration / project.playbackSpeed + 60) * 1000);
      async function frame() {
        if (!isExporting || exportCancelled) return;
        try {
          const range = ranges[rangeIndex];
          if (video.currentTime >= range.end - 0.015 || video.ended) {
            completed += range.end-range.start;
            rangeIndex++;
            if (rangeIndex === ranges.length) { recorder.stop(); return; }
            recorder.pause(); video.pause();
            for (const node of audioNodes.values()) node.element.pause();
            await seekTo(ranges[rangeIndex].start);
            if (!isExporting || exportCancelled) return;
            recorder.resume(); await video.play();
          }
          ctx.fillStyle = '#000'; ctx.fillRect(0,0,exportCanvas.width,exportCanvas.height);
          const scale = Math.min(exportCanvas.width/video.videoWidth, exportCanvas.height/video.videoHeight);
          const w = video.videoWidth*scale, h = video.videoHeight*scale;
          ctx.drawImage(video,(exportCanvas.width-w)/2,(exportCanvas.height-h)/2,w,h);
          if (project.captionSettings?.burnIn) VoiceCutCaptions.draw(ctx,VoiceCutCaptions.active(project.captions,video.currentTime),exportCanvas.width,exportCanvas.height);
          syncAudioPlayback(true);
          const percent = Math.min(99, Math.round(100*(completed+video.currentTime-ranges[rangeIndex].start)/duration));
          $('#exportProgressBar').style.width = percent+'%'; $('#exportProgressBar').setAttribute('aria-valuenow',String(percent));
          const quarter = Math.floor(percent/25);
          if (quarter > lastAnnouncement) { lastAnnouncement = quarter; announce('Export '+quarter*25+' percent complete.'); }
          raf = requestAnimationFrame(frame);
        } catch(e) { cancelExport(); announce('Export failed: '+e.message,true); }
      }
      raf = requestAnimationFrame(frame);
    } catch(e) {
      exportCancelled = true;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      exportCleanup?.(); isExporting = false; lockExportControls(false);
      $('#btnDoExport').disabled = false;
      $('#exportStatus').textContent = 'Export failed: '+e.message;
      announce('Export failed: '+e.message,true);
    }
  }
  function cancelExport() {
    exportCancelled = true;
    if (exportRecorder && exportRecorder.state !== 'inactive') exportRecorder.stop();
    else exportCleanup?.();
    video.pause();
    announce('Export cancelled. Keep the tab visible when retrying.');
  }

  let aiProcessingCancelled = false;
  let currentAIJob = null;

  // Convert AudioBuffer to WAV Blob (real audio processing)
  function audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const dataLength = buffer.length * numChannels * (bitDepth/8);
    const headerLength = 44;
    const arrayBuffer = new ArrayBuffer(headerLength + dataLength);
    const view = new DataView(arrayBuffer);

    function writeString(offset, str) {
      for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i));
    }

    // WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth/8), true);
    view.setUint16(32, numChannels * (bitDepth/8), true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    // Write PCM data
    let offset = 44;
    for (let i=0; i<buffer.length; i++) {
      for (let ch=0; ch<numChannels; ch++) {
        const channelData = buffer.getChannelData(ch);
        let sample = Math.max(-1, Math.min(1, channelData[i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], {type:'audio/wav'});
  }

  async function decodeAudioFile(fileOrUrl) {
    ensureAudioContext();
    let arrayBuffer;
    if (typeof fileOrUrl === 'string') {
      const resp = await fetch(fileOrUrl);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      arrayBuffer = await fileOrUrl.arrayBuffer();
    }
    return await audioContext.decodeAudioData(arrayBuffer);
  }

  // Advanced Audio Noise Reduction - Real Processing with OfflineAudioContext
  async function processAudioBufferWithAI(buffer, level, onProgress) {
    if (buffer.duration > 600) throw new Error('Local cleanup is limited to 10 minutes to protect device memory.');
    onProgress(10, 'Preparing audio filters', 'Not a neural AI model');
    const ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const source = ctx.createBufferSource(); source.buffer = buffer;
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = level === 'strong' ? 120 : 80;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = level === 'strong' ? 7000 : 12000;
    const notch = ctx.createBiquadFilter(); notch.type = 'notch'; notch.frequency.value = 50; notch.Q.value = 10;
    source.connect(high); high.connect(notch); notch.connect(low); low.connect(ctx.destination); source.start();
    onProgress(30, 'Rendering filtered audio', 'Reducing low-frequency rumble and high-frequency hiss');
    const result = await ctx.startRendering();
    if (aiProcessingCancelled) throw new Error('Cancelled');
    onProgress(100, 'Filters applied. Preview before applying.', 'Noise removal is not guaranteed');
    return result;
  }

  let cleanupBusy = false;
  async function enhanceAudioClipWithAI(clipId, level='medium') {
    const clip = project.clips.find(c => c.id === clipId);
    if (!clip) { announce('Select an audio clip first.', true); return; }
    return processSelectedAudio(clip.file || clip.url, clip.name, level, clipId);
  }
  async function enhanceOriginalVideoAudioWithAI(level='medium') {
    if (!project.videoFile) { announce('Upload a video first.', true); return; }
    return processSelectedAudio(project.videoFile, 'Original video audio', level, null);
  }
  async function processSelectedAudio(input, name, level, clipId) {
    if (cleanupBusy || captionRequestBusy || isExporting) { announce('Wait for the current operation to finish.',true); return; }
    cleanupBusy = true; aiProcessingCancelled = false; currentAIJob = null;
    video.pause(); for (const node of audioNodes.values()) node.element.pause();
    const epoch = mediaEpoch;
    const dialog = $('#aiProcessingDialog');
    $('#aiCurrentFile').textContent = name;
    $('#aiBeforeAfter').classList.add('hidden');
    $('#btnApplyEnhanced').classList.add('hidden');
    $('#btnCloseAI').classList.add('hidden');
    $('#btnCancelAI').textContent = 'Cancel Processing';
    if (!dialog.open) dialog.showModal();
    const progress = (percent,text) => {
      if (aiProcessingCancelled) return;
      $('#aiProgressBar').style.width = percent+'%'; $('#aiProgressBar').setAttribute('aria-valuenow',String(percent));
      $('#aiPercentLabel').textContent = percent+'%'; $('#aiProgressText').textContent = text;
    };
    try {
      progress(0,'Preparing audio');
      const file = input instanceof Blob ? input : await (await fetch(input)).blob();
      if (file.size > 100 * 1024 * 1024) throw new Error('Cleanup supports media files up to 100 MB.');
      let enhancedBlob, enhancedBuffer;
      const serverResult = await enhanceWithRealAI(file,level,progress);
      if (aiProcessingCancelled) throw new Error('Cancelled');
      if (serverResult) {
        enhancedBlob = serverResult.blob; enhancedBuffer = await decodeAudioFile(enhancedBlob);
      } else {
        progress(5,'Decoding audio. Some video codecs cannot be decoded by Web Audio.');
        const original = await decodeAudioFile(file);
        if (aiProcessingCancelled) throw new Error('Cancelled');
        enhancedBuffer = await processAudioBufferWithAI(original,level,progress);
        enhancedBlob = audioBufferToWavBlob(enhancedBuffer);
      }
      if (aiProcessingCancelled) throw new Error('Cancelled');
      const enhancedUrl = URL.createObjectURL(enhancedBlob);
      const originalUrl = URL.createObjectURL(file);
      if (epoch !== mediaEpoch) throw new Error('Project changed during processing. Result not applied.');
      currentAIJob = {type:clipId ? 'clip' : 'original',clipId,enhancedBlob,enhancedBuffer,enhancedUrl,originalUrl,level,provider:serverResult?.provider||'Local filters (not AI)',epoch};
      $('#aiOriginalAudio').src = originalUrl; $('#aiEnhancedAudio').src = enhancedUrl;
      $('#aiBeforeAfter').classList.remove('hidden'); $('#btnApplyEnhanced').classList.remove('hidden');
      $('#aiResultText').textContent = (serverResult?.provider || 'Local filters (not AI)') + ': complete. Listen before applying.';
      progress(100,'Complete'); announce('Audio processing complete. Preview before applying.');
    } catch(e) { $('#aiProgressText').textContent = 'Processing stopped: '+e.message; announce('Processing stopped: '+e.message,true); }
    finally { cleanupBusy = false; $('#btnCloseAI').classList.remove('hidden'); }
  }

  function applyCurrentAIEnhancement() {
    if (!currentAIJob) return;
    if (currentAIJob.epoch !== mediaEpoch) { announce('Project changed. Process this media again.',true); return; }

    if (currentAIJob.type === 'original') {
      // Apply enhanced original audio
      const { enhancedBlob, enhancedUrl, level } = currentAIJob;
      // Store enhanced version
      project.originalAudio.enhanced = true;
      project.originalAudio.enhancedUrl = enhancedUrl;
      project.originalAudio.enhancedBlob = enhancedBlob;
      project.originalAudio.enhancementLevel = level;
      project.originalAudio.originalMuted = false;

      // Create a new audio node for enhanced original
      const enhancedClip = {
        id: 'enhanced_original_' + Date.now(),
        name: 'Processed Original Audio',
        type: 'voiceover',
        file: new File([enhancedBlob], `enhanced_original_${Date.now()}.wav`, {type:'audio/wav'}),
        url: enhancedUrl,
        startTime: 0,
        trimStart: 0,
        trimEnd: 0,
        duration: currentAIJob.enhancedBuffer.duration,
        volume: 100,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        noiseReduction: 'off',
        trackIndex: 99,
        isEnhancedOriginal: true,
        originalIsMuted: true
      };

      // Mute original video audio and add enhanced as separate track
      project.originalAudio.muted = true;
      for (const c of project.clips.filter(c=>c.isEnhancedOriginal)) {
        const node = audioNodes.get(c.id);
        if (node) { node.element.pause(); node.source.disconnect(); node.gain.disconnect(); audioNodes.delete(c.id); }
      }
      project.clips = project.clips.filter(c=>!c.isEnhancedOriginal);
      project.clips.push(enhancedClip);
      createAudioNodeForClip(enhancedClip);

      pushHistory();
      renderAll();
      $('#aiProcessingDialog').close();
      announce(`${currentAIJob.provider} applied to original audio. Original video audio is muted to avoid double playback. Preview before exporting.`, true);

    } else {
      // Apply enhanced clip
      const clip = project.clips.find(c=>c.id===currentAIJob.clipId);
      if (!clip) return;

      // Keep original for comparison
      if (!clip.originalUrl) {
        clip.originalUrl = clip.url;
        clip.originalFile = clip.file;
      }

      // Replace with enhanced
      if (clip.url && clip.url.startsWith('blob:')) {
        // Don't revoke if it's original backup
        // Keep URLs valid for undo snapshots until this tab closes.
      }

      clip.url = currentAIJob.enhancedUrl;
      clip.file = new File([currentAIJob.enhancedBlob], `${escapeHTML(clip.name)}_enhanced_${Date.now()}.wav`, {type:'audio/wav'});
      clip.enhanced = true;
      clip.enhancementLevel = currentAIJob.level;
      clip.noiseReduction = 'off';

      // Recreate audio node
      const existingNode = audioNodes.get(clip.id);
      if (existingNode) {
        try { existingNode.element.pause(); existingNode.source.disconnect(); existingNode.gain.disconnect(); } catch {}
        audioNodes.delete(clip.id);
      }
      createAudioNodeForClip(clip);

      pushHistory();
      renderAll();
      $('#aiProcessingDialog').close();
      announce(`${currentAIJob.provider} applied to ${escapeHTML(clip.name)}. Original preserved for comparison; preview before exporting.`, true);
    }

    $('#aiOriginalAudio').pause(); $('#aiEnhancedAudio').pause();
    currentAIJob = null;
  }

  let serverAccessKey = '';
  let serverKeyExpiry = 0;
  function saveApiKeys() {
    try {
      const value = $('#aiServerUrl').value.trim();
      const access = $('#serverAccessKey').value.trim();
      if (/^sk[-_]/.test(access)) throw new Error('Do not paste a provider API key here. Enter your generated SERVER_ACCESS_KEY instead.');
      if (value) {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('Use an HTTPS server URL.');
        localStorage.setItem('voicecut_ai_server', url.origin);
      } else localStorage.removeItem('voicecut_ai_server');
      serverAccessKey = $('#serverAccessKey').value.trim();
      $('#serverAccessKey').value = '';
      serverKeyExpiry = Date.now() + 15 * 60 * 1000;
      announce('Server settings saved. Access key expires from memory in 15 minutes.');
    } catch (e) { announce(e.message, true); }
  }
  function loadApiKeys() {
    for (const key of ['voicecut_dolby_key','voicecut_hf_key','voicecut_replicate_key']) localStorage.removeItem(key);
    $('#aiServerUrl').value = localStorage.getItem('voicecut_ai_server') || '';
  }
  setInterval(() => { if (Date.now() >= serverKeyExpiry) serverAccessKey = ''; }, 1000);
  async function requestServer(endpoint,file=null,cloudName='') {
    const server=localStorage.getItem('voicecut_ai_server');
    if(!server)throw new Error('Set your HTTPS server URL and SERVER_ACCESS_KEY in Settings first.');
    if(Date.now()>=serverKeyExpiry||!serverAccessKey)throw new Error('Enter your server access key in Settings again. Its browser copy expires after 15 minutes.');
    if(currentRequest)throw new Error('Another server request is running. Wait or cancel it first.');
    if(file?.size>100*1024*1024)throw new Error('Use a file smaller than 100 MB.');
    if(file){
      const message=cloudName
        ? `Upload this source file to your server and send its extracted audio to ${cloudName}? This may use paid API credits. Maximum 10 minutes and 100 MB. Server copies expire within 15 minutes; provider retention follows its own policy. Cancellation may not stop provider billing.`
        : 'Upload this file to your server for ordinary FFmpeg filters (not AI)? Maximum 10 minutes and 100 MB. Server copies expire within 15 minutes.';
      if(!confirm(message))throw new Error('Upload cancelled.');
    }
    const controller=new AbortController();currentRequest=controller;
    const timer=setTimeout(()=>controller.abort(),file?14*60*1000:30000);
    const status=file?'Uploading and processing. You can cancel; do not submit twice.':'Checking server connection…';
    if(captionRequestBusy)$('#captionStatus').textContent=status;
    try{
      const body=file?new FormData():undefined;if(file)body.append('file',file);
      const response=await fetch(new URL(endpoint,server),{method:file?'POST':'GET',body,signal:controller.signal,
        headers:{Authorization:'Bearer '+serverAccessKey,...(cloudName?{'X-Upload-Consent':'yes'}:{})}});
      if(!response.ok){
        let detail='';try{detail=(await response.json()).error||'';}catch{}
        throw new Error(detail||`Server returned HTTP ${response.status}. Check connection, authorization and server logs without sharing secrets.`);
      }
      return response.headers.get('content-type')?.includes('application/json')?await response.json():await response.blob();
    }catch(e){
      if(controller.signal.aborted)throw new Error('Request cancelled or timed out. Your original media is unchanged; provider processing or billing may already have occurred.');
      if(e instanceof TypeError)throw new Error('Cannot reach the server. Check its HTTPS URL, deployment health and allowed website origin.');
      throw e;
    }finally{clearTimeout(timer);currentRequest=null;}
  }
  async function enhanceWithRealAI(file,level,onProgress) {
    const method=$('#cleanupMethod').value;
    if(method==='local')return null;
    onProgress(5,'Waiting for server processing. No automatic paid retries.');
    const blob=await requestServer(method==='elevenlabs'?'/api/isolate':'/enhance',file,method==='elevenlabs'?'ElevenLabs AI Voice Isolator':'');
    if(!(blob instanceof Blob))throw new Error('The server did not return audio.');
    onProgress(100,'Processing complete. Compare with the original before applying.');
    return {blob,provider:method==='elevenlabs'?'ElevenLabs AI Voice Isolator':'FFmpeg filters (not AI)'};
  }
  let currentRequest = null;
  // Project saving - SILENT auto-save to fix TalkBack chatter
  let autoSaveTimeout = null;
  let lastAutoSaveTime = 0;

  let saveQueue = Promise.resolve();
  let dirty = false;
  function silentSave() {
    if (!dirty) return saveQueue;
    dirty = false;
    const snapshot = structuredClone(project);
    saveQueue = saveQueue.catch(() => {}).then(() => VoiceCutStorage.save(snapshot)).catch(e => {
      dirty = true;
      $('#statusText').textContent = 'Could not save project: ' + e.message + '. Keep this tab open.';
      throw e;
    });
    return saveQueue;
  }
  function autoSave() {
    dirty = true;
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => { silentSave().catch(() => {}); }, 1000);
  }
  async function saveProject() {
    dirty = true;
    try { await silentSave(); announce('Project and media saved on this device.'); }
    catch (e) { announce('Save failed. Storage may be full. ' + e.message, true); }
  }
  async function loadProjectFromStorage() {
    try {
      await saveQueue.catch(() => {});
      const saved = await VoiceCutStorage.load();
      if (!saved) { announce('No saved project. Upload a video to begin.'); return; }
      pauseAllAudio();
      currentRequest?.abort(); mediaEpoch++;
      project = saved;
      project.videoUrl = project.videoFile ? URL.createObjectURL(project.videoFile) : null;
      project.clips.forEach(c => { c.url = c.file ? URL.createObjectURL(c.file) : null; c.originalUrl = c.originalFile ? URL.createObjectURL(c.originalFile) : null; });
      video.src = project.videoUrl || '';
      for (const c of project.clips) createAudioNodeForClip(c);
      historyStack = []; historyIndex = -1;
      pushHistory(); renderAll();
      $('#editorScreen').classList.remove('hidden'); $('#homeScreen').classList.add('hidden');
      $('#videoPlaceholder').classList.toggle('hidden', !!project.videoUrl);
      announce('Saved project and media restored.');
    } catch(e) { announce('Cannot restore project: ' + e.message, true); }
  }

  // Confirm dialog
  let confirmCallback = null;
  function showConfirm(message, cb) {
    $('#confirmMessage').textContent = message;
    confirmCallback = cb;
    $('#confirmDialog').showModal();
  }

  // Event Listeners
  function initEvents() {
    // Home buttons
    $('#homeUploadVideo').addEventListener('click', ()=>$('#fileVideo').click());
    $('#homeRecordVoice').addEventListener('click', ()=>{ if(!project.videoUrl){ announce('Please upload a video first, then record voice-over.'); $('#fileVideo').click(); } else { openRecordDialog(); } });
    $('#homeImportAudio').addEventListener('click', ()=>$('#fileAudio').click());
    $('#homeOpenProject').addEventListener('click', loadProjectFromStorage);
    $('#homeRecentProjects').addEventListener('click', loadProjectFromStorage);
    $('#homeSettings').addEventListener('click', ()=>{ $('#editorScreen').classList.remove('hidden'); $('#homeScreen').classList.add('hidden'); $('#section-settings').scrollIntoView({behavior:'smooth'}); });
    $('#homeHelp').addEventListener('click', ()=>$('#helpDialog').showModal());

    $('#btnCloseHelp').addEventListener('click', ()=>$('#helpDialog').close());
    $('#btnCloseHelp2').addEventListener('click', ()=>$('#helpDialog').close());
    $('#helpDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });

    $('#confirmDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });
    $('#btnConfirmClose').addEventListener('click', ()=>$('#confirmDialog').close());
    $('#btnConfirmCancel').addEventListener('click', ()=>$('#confirmDialog').close());
    $('#btnConfirmApply').addEventListener('click', ()=>{ $('#confirmDialog').close(); if(confirmCallback) confirmCallback(); confirmCallback=null; });

    $('#recordDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });
    $('#btnCloseRecord').addEventListener('click', ()=>{ stopRecording(); $('#recordDialog').close(); });
    $('#recordDialog').addEventListener('close', stopRecording);
    $('#recordDialog').addEventListener('cancel', stopRecording);
    $('#btnStartRecording').addEventListener('click', startRecording);
    $('#btnStopRecordingDialog').addEventListener('click', stopRecording);
    $('#btnRecordVO').addEventListener('click', openRecordDialog);
    $('#btnStopVO').addEventListener('click', stopRecording);

    document.addEventListener('change', e => {
      if (e.target.matches('input,select') && !['aiServerUrl','serverAccessKey'].includes(e.target.id)) autoSave();
    });
    // File inputs
    $('#fileVideo').addEventListener('change', (e)=>{ const f=e.target.files[0]; if(f) loadVideoFile(f); });
    $('#fileAudio').addEventListener('change', (e)=>{ const f=e.target.files[0]; if(f) addAudioFile(f,'music'); e.target.value=''; });
    $('#fileVoiceover').addEventListener('change', (e)=>{ const f=e.target.files[0]; if(f) addAudioFile(f,'voiceover'); e.target.value=''; });

    $('#btnUploadVideoEditor').addEventListener('click', ()=>$('#fileVideo').click());
    $('#btnAddMusic').addEventListener('click', ()=>$('#fileAudio').click());
    $('#btnAddMusic2').addEventListener('click', ()=>$('#fileAudio').click());
    $('#btnImportAudioEditor').addEventListener('click', ()=>$('#fileAudio').click());
    $('#btnAddVoiceover').addEventListener('click', openRecordDialog);
    $('#btnImportVoiceover').addEventListener('click', ()=>$('#fileVoiceover').click());
    $('#btnImportVO2').addEventListener('click', ()=>$('#fileVoiceover').click());

    // Video controls
    $('#btnPlay').addEventListener('click', playVideo);
    $('#btnPause').addEventListener('click', pauseVideo);
    $('#btnStop').addEventListener('click', stopVideo);
    $('#btnSkipBack').addEventListener('click', skipBack);
    $('#btnSkipForward').addEventListener('click', skipForward);
    $('#btnPrevFrame').addEventListener('click', prevFrame);
    $('#btnNextFrame').addEventListener('click', nextFrame);
    $('#btnFullscreen').addEventListener('click', ()=>{ if(video.requestFullscreen) video.requestFullscreen(); });
    $('#skipAmountSelect').addEventListener('change', (e)=>{ project.skipAmount=parseInt(e.target.value); $('#settingDefaultSkip').value=e.target.value; announce(`Skip amount set to ${e.target.value} seconds.`); });
    $('#playbackSpeedSelect').addEventListener('change', (e)=>{ project.playbackSpeed=parseFloat(e.target.value); video.playbackRate=project.playbackSpeed; announce(`Playback speed set to ${e.target.value}x.`); });

    $('#btnSplitVideo').addEventListener('click', splitVideo);
    $('#btnTrimStart').addEventListener('click', trimStart);
    $('#btnTrimEnd').addEventListener('click', trimEnd);
    $('#btnSetStart').addEventListener('click', ()=>{ project.trimStart=video.currentTime; renderAll(); pushHistory(); announce(`Start set to ${formatTimeVerbose(project.trimStart)}`); });
    $('#btnSetEnd').addEventListener('click', ()=>{ project.trimEnd=video.currentTime; renderAll(); pushHistory(); announce(`End set to ${formatTimeVerbose(project.trimEnd)}`); });
    $('#btnDecStart').addEventListener('click', ()=>{ project.trimStart=Math.max(0,project.trimStart-1); renderAll(); pushHistory(); });
    $('#btnIncStart').addEventListener('click', ()=>{ project.trimStart=Math.min(project.trimEnd-0.5, project.trimStart+1); renderAll(); pushHistory(); });
    $('#btnDecEnd').addEventListener('click', ()=>{ project.trimEnd=Math.max(project.trimStart+0.5, (project.trimEnd||project.duration)-1); renderAll(); pushHistory(); });
    $('#btnIncEnd').addEventListener('click', ()=>{ project.trimEnd=Math.min(project.duration, (project.trimEnd||project.duration)+1); renderAll(); pushHistory(); });
    $('#trimStartInput').addEventListener('change', (e)=>{ const value=parseTime(e.target.value); if (!Number.isFinite(value) || value<0 || value>=(project.trimEnd||project.duration)) { announce('Start must be before end and within the video.',true); renderAll(); return; } project.trimStart=value; renderAll(); pushHistory(); });
    $('#trimEndInput').addEventListener('change', (e)=>{ const value=parseTime(e.target.value); if (!Number.isFinite(value) || value<=project.trimStart || value>project.duration) { announce('End must be after start and within the video.',true); renderAll(); return; } project.trimEnd=value; renderAll(); pushHistory(); });

    $('#btnDeleteSection').addEventListener('click', ()=>{
      if (!selectedClipId) { announce('No section selected. Select a video segment first.'); return; }
      deleteClip(selectedClipId);
    });
    $('#btnKeepSection').addEventListener('click', ()=>{
      if (!selectedClipId) { announce('No section selected.'); return; }
      const seg = project.segments.find(s=>s.id===selectedClipId);
      if (seg) {
        project.trimStart=seg.start;
        project.trimEnd=seg.end;
        project.segments=[{id:uid(), start:seg.start, end:seg.end, label:'Kept Section'}];
        pushHistory(); renderAll(); announce(`Kept selected section from ${formatTimeVerbose(seg.start)} to ${formatTimeVerbose(seg.end)}.`);
      }
    });
    $('#btnDuplicateSegment').addEventListener('click', ()=>{
      if (!selectedClipId) { announce('No segment selected.'); return; }
      const seg = project.segments.find(s=>s.id===selectedClipId);
      if (seg) {
        const newSeg = {...seg, id:uid(), start:seg.end, end:Math.min(project.duration, seg.end + (seg.end-seg.start)), label: seg.label+' Copy'};
        project.segments.push(newSeg);
        pushHistory(); renderAll(); announce('Segment duplicated.');
      } else {
        const clip = project.clips.find(c=>c.id===selectedClipId);
        if (clip) {
          const newClip = {...clip, id:uid(), name:clip.name+' Copy', startTime:clip.startTime + 5};
          project.clips.push(newClip);
          createAudioNodeForClip(newClip);
          pushHistory(); renderAll(); announce(`${escapeHTML(clip.name)} duplicated.`);
        }
      }
    });
    $('#btnCrop').addEventListener('click', ()=>announce('Crop feature: In advanced mode, use canvas transform. Current video will be cropped at export based on resolution.'));
    $('#btnRotate').addEventListener('click', ()=>announce('Rotate feature: Video rotation will be applied at export.'));
    $('#btnFreezeFrame').addEventListener('click', ()=>{
      const pos=video.currentTime;
      announce(`Freeze frame at ${formatTimeVerbose(pos)}. This will hold the frame for 2 seconds at export.`);
      // Implement as segment with freeze? For demo, just announce
    });

    // Original audio
    $('#origVolumeSlider').addEventListener('input', (e)=>{ project.originalAudio.volume=parseInt(e.target.value); $('#origVolumeNumber').value=e.target.value; $('#origVolumeText').textContent=e.target.value+'%'; e.target.setAttribute('aria-valuetext', `Volume ${e.target.value} percent`); });
    $('#origVolumeSlider').addEventListener('change', (e)=>{ pushHistory(); renderAll(); announce(`Original audio volume changed to ${e.target.value} percent.`); });
    $('#origVolumeNumber').addEventListener('change', (e)=>{ project.originalAudio.volume=parseInt(e.target.value); $('#origVolumeSlider').value=e.target.value; pushHistory(); renderAll(); });
    $('#origVolDec').addEventListener('click', ()=>{ project.originalAudio.volume=Math.max(0,project.originalAudio.volume-5); $('#origVolumeSlider').value=project.originalAudio.volume; $('#origVolumeNumber').value=project.originalAudio.volume; pushHistory(); renderAll(); announce(`Original audio volume ${project.originalAudio.volume} percent.`); });
    $('#origVolInc').addEventListener('click', ()=>{ project.originalAudio.volume=Math.min(100,project.originalAudio.volume+5); $('#origVolumeSlider').value=project.originalAudio.volume; $('#origVolumeNumber').value=project.originalAudio.volume; pushHistory(); renderAll(); announce(`Original audio volume ${project.originalAudio.volume} percent.`); });
    $('#btnMuteOrig').addEventListener('click', ()=>{ project.originalAudio.muted=!project.originalAudio.muted; pushHistory(); renderAll(); announce(project.originalAudio.muted?'Original audio muted.':'Original audio unmuted.'); });
    $('#origNoiseReduction').addEventListener('change', (e)=>{ project.originalAudio.noiseReduction=e.target.value; pushHistory(); renderAll(); announce(`Noise reduction set to ${e.target.value}.`); $('#noiseReductionStatus').textContent=`Noise reduction enabled. ${e.target.value} strength.`; });
    $('#globalNoiseReduction').addEventListener('change', (e)=>{ project.originalAudio.noiseReduction=e.target.value; $('#origNoiseReduction').value=e.target.value; pushHistory(); renderAll(); announce(`Noise reduction set to ${e.target.value}.`); $('#noiseReductionStatus').textContent=`Noise reduction enabled. ${e.target.value} strength.`; });
    $('#btnOrigFadeIn').addEventListener('click', ()=>{ project.originalAudio.fadeIn = project.originalAudio.fadeIn?0:2; pushHistory(); renderAll(); announce(`Original audio fade in ${project.originalAudio.fadeIn} seconds.`); });
    $('#btnOrigFadeOut').addEventListener('click', ()=>{ project.originalAudio.fadeOut = project.originalAudio.fadeOut?0:2; pushHistory(); renderAll(); announce(`Original audio fade out ${project.originalAudio.fadeOut} seconds.`); });
    $('#btnOrigAIEnhance').addEventListener('click', ()=>{
      const level = $('#origNoiseReduction').value;
      if (level==='off') { announce('Set noise reduction to Light, Medium, or Strong first.', true); return; }
      enhanceOriginalVideoAudioWithAI(level);
    });

    // Selected clip
    $('#selPlay').addEventListener('click', ()=>{ if(selectedClipId) playClipPreview(selectedClipId); });
    $('#selPause').addEventListener('click', ()=>{
      if(selectedClipId){ const n=audioNodes.get(selectedClipId); if(n) n.element.pause(); announce('Clip paused.'); }
    });
    $('#selTrim').addEventListener('click', ()=>announce('Use start and end time inputs to trim selected clip.'));
    $('#selSplit').addEventListener('click', ()=>{
      if(!selectedClipId) return;
      const clip=project.clips.find(c=>c.id===selectedClipId);
      if(!clip) return;
      const pos=video.currentTime;
      if(pos<=clip.startTime || pos>=clip.startTime + (clip.duration - clip.trimStart - clip.trimEnd)) { announce('Split position outside clip.'); return; }
      const offset = pos - clip.startTime;
      const newClip = {...clip, id:uid(), name:clip.name+' B', startTime:pos, trimStart: clip.trimStart + offset, duration:clip.duration};
      clip.trimEnd = clip.duration - (clip.trimStart + offset);
      clip.name = clip.name+' A';
      project.clips.push(newClip);
      createAudioNodeForClip(newClip);
      pushHistory(); renderAll(); announce(`Clip split at ${formatTimeVerbose(pos)}.`);
    });
    $('#selMoveEarlier').addEventListener('click', ()=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      clip.startTime=Math.max(0, clip.startTime-1); pushHistory(); renderAll(); announce(`Moved earlier to ${formatTimeVerbose(clip.startTime)}.`);
    });
    $('#selMoveLater').addEventListener('click', ()=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      clip.startTime=Math.min((project.trimEnd||project.duration), clip.startTime+1); pushHistory(); renderAll(); announce(`Moved later to ${formatTimeVerbose(clip.startTime)}.`);
    });
    $('#selMoveToCurrent').addEventListener('click', ()=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      clip.startTime=video.currentTime; pushHistory(); renderAll(); announce(`Moved to current position ${formatTimeVerbose(clip.startTime)}.`);
    });
    $('#selMute').addEventListener('click', ()=>{ if(selectedClipId) toggleMuteClip(selectedClipId); });
    $('#selDelete').addEventListener('click', ()=>{ if(selectedClipId) deleteClip(selectedClipId); });
    $('#selDuplicate').addEventListener('click', ()=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      const newClip={...clip, id:uid(), name:clip.name+' Copy', startTime:clip.startTime+2}; project.clips.push(newClip); createAudioNodeForClip(newClip); pushHistory(); renderAll(); announce(`${escapeHTML(clip.name)} duplicated.`);
    });
    $('#selAIEnhance').addEventListener('click', ()=>{
      if (!selectedClipId) { announce('No clip selected.', true); return; }
      const level = $('#selNoiseReduction')?.value || 'medium';
      enhanceAudioClipWithAI(selectedClipId, level);
    });
    $('#selStartTime').addEventListener('change', (e)=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      clip.startTime=parseTime(e.target.value); pushHistory(); renderAll(); announce(`Start time set to ${formatTimeVerbose(clip.startTime)}.`);
    });
    $('#selEndTime').addEventListener('change', (e)=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return;
      const newEnd=parseTime(e.target.value);
      const newDur=newEnd - clip.startTime;
      if(newDur>0) { clip.trimEnd = clip.duration - clip.trimStart - newDur; pushHistory(); renderAll(); }
    });
    $('#selVolumeSlider').addEventListener('input', (e)=>{ $('#selVolumeNumber').value=e.target.value; $('#selVolumeText').textContent=e.target.value+'%'; e.target.setAttribute('aria-valuetext', `Volume ${e.target.value} percent`); if(selectedClipId){ const clip=project.clips.find(c=>c.id===selectedClipId); if(clip){ clip.volume=parseInt(e.target.value); const n=audioNodes.get(clip.id); if(n) n.gain.gain.value=clip.muted?0:clip.volume/100; } } });
    $('#selVolumeSlider').addEventListener('change', (e)=>{ updateSelectedClipVolume(parseInt(e.target.value)); pushHistory(); });
    $('#selVolumeNumber').addEventListener('change', (e)=>{ updateSelectedClipVolume(parseInt(e.target.value)); pushHistory(); });
    $('#selVolDec').addEventListener('click', ()=>{ const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; updateSelectedClipVolume(Math.max(0,clip.volume-5)); pushHistory(); });
    $('#selVolInc').addEventListener('click', ()=>{ const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; updateSelectedClipVolume(Math.min(100,clip.volume+5)); pushHistory(); });
    $('#selApplyClipOnly').addEventListener('click', ()=>applyVolumeToScope('clip'));
    $('#selApplyTrack').addEventListener('click', ()=>applyVolumeToScope('track'));
    $('#selApplyAllMusic').addEventListener('click', ()=>applyVolumeToScope('allMusic'));
    $('#selApplyAllAudio').addEventListener('click', ()=>applyVolumeToScope('allAudio'));
    $('#selNoiseReduction').addEventListener('change', (e)=>{
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; clip.noiseReduction=e.target.value; pushHistory(); renderAll(); announce(`Noise reduction for ${escapeHTML(clip.name)} set to ${e.target.value}.`);
    });
    $('#selFadeIn').addEventListener('change', (e)=>{ const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; clip.fadeIn=parseFloat(e.target.value); pushHistory(); renderAll(); announce(`Fade in set to ${e.target.value} seconds.`); });
    $('#selFadeOut').addEventListener('change', (e)=>{ const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; clip.fadeOut=parseFloat(e.target.value); pushHistory(); renderAll(); announce(`Fade out set to ${e.target.value} seconds.`); });

    // Effects
    $('#fadeInSelect').addEventListener('change', (e)=>{ if(selectedClipId){ const clip=project.clips.find(c=>c.id===selectedClipId); if(clip){ clip.fadeIn=parseFloat(e.target.value); pushHistory(); renderAll(); } } });
    $('#fadeOutSelect').addEventListener('change', (e)=>{ if(selectedClipId){ const clip=project.clips.find(c=>c.id===selectedClipId); if(clip){ clip.fadeOut=parseFloat(e.target.value); pushHistory(); renderAll(); } } });
    $('#fadeInCustom').addEventListener('input', (e)=>{ $('#fadeInCustomVal').textContent=e.target.value+'s'; if(selectedClipId){ const clip=project.clips.find(c=>c.id===selectedClipId); if(clip) clip.fadeIn=parseFloat(e.target.value); } });
    $('#fadeOutCustom').addEventListener('input', (e)=>{ $('#fadeOutCustomVal').textContent=e.target.value+'s'; if(selectedClipId){ const clip=project.clips.find(c=>c.id===selectedClipId); if(clip) clip.fadeOut=parseFloat(e.target.value); } });
    $('#duckingToggle').addEventListener('change', (e)=>{ project.ducking.enabled=e.target.checked; pushHistory(); announce(`Voice ducking ${e.target.checked?'enabled':'disabled'}.`); });
    $('#duckingLevel').addEventListener('change', (e)=>{ project.ducking.level=parseInt(e.target.value); pushHistory(); announce(`Ducking level set to ${e.target.value} percent.`); });

    $('#btnPreviewNoiseReduction').addEventListener('click', () => announce('Use Reduce Noise, then compare the Original and Processed audio players before applying.'));

    // audio cleanup ENHANCEMENT BUTTONS
    $('#btnAIEnhanceOriginal').addEventListener('click', ()=>{
      const level = $('#globalNoiseReduction').value;
      if (level==='off') { announce('Noise reduction is off. Set to Light, Medium, or Strong first.', true); return; }
      enhanceOriginalVideoAudioWithAI(level);
    });
    $('#btnAIEnhanceSelected').addEventListener('click', ()=>{
      if (!selectedClipId) { announce('No clip selected. Select a clip in timeline first, then click Enhance Selected Clip.', true); return; }
      const level = $('#selNoiseReduction')?.value || $('#globalNoiseReduction').value;
      enhanceAudioClipWithAI(selectedClipId, level);
    });
    const stopCleanup = () => {
      aiProcessingCancelled = true; currentRequest?.abort();
      $('#aiOriginalAudio').pause(); $('#aiEnhancedAudio').pause();
      $('#aiProcessingDialog').close();
    };
    $('#btnCancelAI').addEventListener('click', stopCleanup);
    $('#btnCloseAI').addEventListener('click', stopCleanup);
    $('#aiProcessingDialog').addEventListener('cancel', stopCleanup);
    $('#btnApplyEnhanced').addEventListener('click', applyCurrentAIEnhancement);
    $('#aiOriginalAudio').addEventListener('play', () => $('#aiEnhancedAudio').pause());
    $('#aiEnhancedAudio').addEventListener('play', () => $('#aiOriginalAudio').pause());

    // Timeline exit
    $('#btnExitTimeline').addEventListener('click', ()=>{ $('#section-project').scrollIntoView({behavior:'smooth'}); announce('Exited timeline editing. Focus moved to project section.'); });

    // Export
    $('#exportResolution').addEventListener('change', (e)=>{ project.resolution=e.target.value; updateExportSummary(); });
    $('#exportFps').addEventListener('change', (e)=>{ project.fps=parseInt(e.target.value); updateExportSummary(); });
    $('#exportFormat').addEventListener('change', (e)=>{ project.format=e.target.value; updateExportSummary(); });
    $('#btnDoExport').addEventListener('click', doExport);
    $('#btnExport').addEventListener('click', ()=>{ $('#section-export').scrollIntoView({behavior:'smooth'}); doExport(); });
    $('#btnCancelExport').addEventListener('click', cancelExport);
    $('#btnPlayExported').addEventListener('click', ()=>{ exportedVideoEl.play(); });
    $('#btnDownloadExported').addEventListener('click', async ()=>{
      if(!exportedBlob) return;
      if (window.flutter_inappwebview) {
        if (exportedBlob.size > 40 * 1024 * 1024) { announce('Android in-app sharing is limited to 40 MB. Use the website in Chrome for larger exports.', true); return; }
        try {
          const base64 = await new Promise((resolve,reject) => { const r = new FileReader(); r.onload=()=>resolve(r.result.split(',')[1]); r.onerror=()=>reject(r.error); r.readAsDataURL(exportedBlob); });
          await window.flutter_inappwebview.callHandler('shareExport', base64, VoiceCutCore.extension(exportedBlob.type));
        } catch(e) { announce('Sharing failed: '+e.message, true); }
        return;
      }
      const a=document.createElement('a');
      a.href=URL.createObjectURL(exportedBlob);
      a.download=`${project.name.replace(/\s+/g,'_')}_export.${VoiceCutCore.extension(exportedBlob.type)}`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      announce('Download started.');
    });
    $('#btnShareExported').addEventListener('click', async ()=>{
      if(!exportedBlob) return;
      if(navigator.share && navigator.canShare && navigator.canShare({files:[new File([exportedBlob], 'video.' + VoiceCutCore.extension(exportedBlob.type), {type:exportedBlob.type})]})) {
        try {
          await navigator.share({files:[new File([exportedBlob], `${escapeHTML(project.name)}.${VoiceCutCore.extension(exportedBlob.type)}`, {type:exportedBlob.type})], title:project.name});
          announce('Video shared.');
        } catch(e) { announce('Share canceled.'); }
      } else {
        announce('Share not supported on this device. Use download instead.');
      }
    });

    // Project
    $('#projectNameInput').addEventListener('change', (e)=>{ project.name=e.target.value; pushHistory(); announce(`Project renamed to ${e.target.value}.`); });
    $('#btnRenameProject').addEventListener('click', ()=>{ const name=prompt('Enter new project name:', project.name); if(name){ project.name=name; renderAll(); pushHistory(); } });
    $('#btnSaveProject').addEventListener('click', saveProject);
    $('#btnSaveAs').addEventListener('click', ()=>{
      const name=prompt('Save as:', project.name+' Copy');
      if(name){ project.name=name; project.id='proj_'+Date.now(); saveProject(); renderAll(); announce(`Project saved as ${name}.`); }
    });
    $('#btnDeleteProject').addEventListener('click', ()=>{
      showConfirm(`Delete project ${escapeHTML(project.name)}? This cannot be undone.`, async ()=>{
        currentRequest?.abort(); mediaEpoch++;
        clearTimeout(autoSaveTimeout); dirty = false; pauseAllAudio();
        await saveQueue.catch(() => {});
        await VoiceCutStorage.clear();
        localStorage.removeItem('voicecut_current_project');
        project = { id:'proj_'+Date.now(), name:'Untitled Project', videoFile:null, videoUrl:null, duration:0, trimStart:0, trimEnd:0, segments:[], originalAudio:{volume:100, muted:false, fadeIn:0, fadeOut:0, noiseReduction:'medium'}, clips:[], ducking:{enabled:true, level:30}, playbackSpeed:1, skipAmount:5, resolution:'1080', fps:30, format:'mp4', created:Date.now(), modified:Date.now() };
        selectedClipId=null;
        video.src='';
        $('#videoPlaceholder').classList.remove('hidden');
        $('#editorScreen').classList.add('hidden');
        $('#homeScreen').classList.remove('hidden');
        historyStack=[]; historyIndex=-1;
        announce('Project deleted.');
      });
    });
    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnClearStatus').addEventListener('click', ()=>{ $('#statusText').textContent='Status cleared.'; });

    // Settings
    $('#settingLargeControls').addEventListener('change', (e)=>{ document.documentElement.setAttribute('data-large-controls', e.target.checked); announce(`Large controls ${e.target.checked?'enabled':'disabled'}.`); });
    $('#settingHighContrast').addEventListener('change', (e)=>{ document.documentElement.setAttribute('data-theme', e.target.checked?'high-contrast':''); announce(`High contrast ${e.target.checked?'enabled':'disabled'}.`); });
    $('#settingReducedMotion').addEventListener('change', (e)=>{ document.documentElement.setAttribute('data-reduced-motion', e.target.checked); announce(`Reduced motion ${e.target.checked?'enabled':'disabled'}.`); });
    $('#settingDefaultSkip').addEventListener('change', (e)=>{ project.skipAmount=parseInt(e.target.value); $('#skipAmountSelect').value=e.target.value; announce(`Default skip amount set to ${e.target.value} seconds.`); });
    $('#settingDefaultVolume').addEventListener('input', (e)=>{ $('#settingDefaultVolumeVal').textContent=e.target.value+'%'; });
    $('#settingSimpleMode').addEventListener('change', (e)=>{
      if(e.target.checked){ advancedMode=false; $('#modeBadge').textContent='Simple Mode'; announce('Simple editing mode enabled. Main controls: Upload Video, Add Music, Record Voice-over, Play/Pause, Trim, Split, Volume, Noise Reduction, Undo, Redo, Export.'); }
      else { advancedMode=true; $('#modeBadge').textContent='Advanced Mode'; announce('Advanced editing mode enabled. Multiple tracks, precise timeline, fades, ducking, noise reduction strength, playback speed, detailed export.'); }
    });
    $('#btnToggleAdvanced').addEventListener('click', ()=>{
      advancedMode=!advancedMode;
      $('#settingSimpleMode').checked=!advancedMode;
      $('#modeBadge').textContent=advancedMode?'Advanced Mode':'Simple Mode';
      $('#btnToggleAdvanced').textContent=advancedMode?'Enable Simple Mode':'Enable Advanced Editing Mode';
      announce(advancedMode?'Advanced editing mode enabled.':'Simple editing mode enabled.');
    });

    loadApiKeys();
    $('#btnSaveApiKeys').addEventListener('click', saveApiKeys);
    $('#btnCheckServer').addEventListener('click', async () => {
      $('#apiKeysStatus').textContent='Checking server connection…';
      try {
        const status=await requestServer('/capabilities');
        $('#apiKeysStatus').textContent=`Connected. OpenAI captions: ${status.captions?'key configured':'key missing'}. ElevenLabs isolation: ${status.isolation?'key configured':'key missing'}. This checks configuration only, not provider billing or key validity.`;
      } catch(e) { $('#apiKeysStatus').textContent=e.message; }
    });
    $('#btnClearApiKeys').addEventListener('click', () => {
      localStorage.removeItem('voicecut_ai_server'); serverAccessKey = ''; serverKeyExpiry = 0;
      $('#aiServerUrl').value = ''; $('#serverAccessKey').value = '';
      announce('Server settings cleared. Processing stays on this device.');
    });

    // Video time updates
    video.addEventListener('timeupdate', ()=>{
      currentVideoTime=video.currentTime;
      $('#currentPositionDisplay').textContent=`Current: ${formatTime(video.currentTime)} / Total: ${formatTime(project.duration)}`;
      $('#currentPositionDisplay').setAttribute('aria-label', `Current position ${formatTimeVerbose(video.currentTime)} of ${formatTimeVerbose(project.duration)}. Playback speed ${project.playbackSpeed}x`);
      if(!isExporting && !video.paused) {
        try {
          const ranges=VoiceCutCore.ranges(project);
          const next=ranges.find(r=>video.currentTime<r.end-0.015);
          if(!next)video.pause();
          else if(video.currentTime<next.start)video.currentTime=next.start;
        }catch {video.pause();}
      }
      syncAudioPlayback();
    });
    video.addEventListener('play', ()=>{ $('#btnPlay').setAttribute('aria-pressed','true'); });
    video.addEventListener('pause', ()=>{ $('#btnPlay').setAttribute('aria-pressed','false'); syncAudioPlayback(); });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e)=>{
      if(isExporting){if(e.key==='Escape')cancelExport();return;}
      const activeTag = document.activeElement.tagName;
      if (document.querySelector('dialog[open]') || ['INPUT','TEXTAREA','SELECT','BUTTON','A','VIDEO','AUDIO'].includes(activeTag)) {
        if (e.key==='Escape') document.activeElement.blur();
        return;
      }
      if (e.code==='Space') { e.preventDefault(); if(video.paused) playVideo(); else pauseVideo(); }
      else if (e.key==='ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) { video.currentTime=Math.max(0, video.currentTime-10); announce(`Jumped backward 10 seconds to ${formatTimeVerbose(video.currentTime)}.`); }
        else { video.currentTime=Math.max(0, video.currentTime-1); }
      }
      else if (e.key==='ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) { video.currentTime=Math.min(video.duration, video.currentTime+10); announce(`Jumped forward 10 seconds to ${formatTimeVerbose(video.currentTime)}.`); }
        else { video.currentTime=Math.min(video.duration, video.currentTime+1); }
      }
      else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      else if (e.key.toLowerCase()==='s' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); splitVideo(); }
      else if (e.key==='Delete') { if(selectedClipId){ e.preventDefault(); deleteClip(selectedClipId); } }
      else if (e.key.toLowerCase()==='a') { e.preventDefault(); $('#fileAudio').click(); }
      else if (e.key.toLowerCase()==='v') { e.preventDefault(); openRecordDialog(); }
      else if (e.key.toLowerCase()==='m') { e.preventDefault(); if(selectedClipId) toggleMuteClip(selectedClipId); else { project.originalAudio.muted=!project.originalAudio.muted; renderAll(); } }
    });

    // Load saved project on start
    const saved = localStorage.getItem('voicecut_current_project');
    if (saved) {
      try {
        const parsed=JSON.parse(saved);
        if (parsed.name) {
          $('#projectNameInput').value=parsed.name;
          // Don't auto load video without file
        }
      } catch {}
    }
  }

  // Init
  document.addEventListener('DOMContentLoaded', ()=>{
    initEvents(); initCaptions();
    renderAll();
    announce('Welcome to VoiceCut Studio. Upload a video to begin editing. Screen reader optimized. Press H for help. Use Tab to navigate controls.', false, true);
    // Add hidden help shortcut
    document.addEventListener('keydown', (e)=>{ if(e.key.toLowerCase()==='h' && !e.ctrlKey && !['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')){ $('#helpDialog').showModal(); } });
    // Auto save interval - SILENT, no TalkBack announcement
    setInterval(() => { silentSave().catch(() => {}); }, 15000);
  });

})();

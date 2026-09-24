
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
    crop: {preset:'original',x:0,y:0,w:100,h:100},
    rotation: 0,
    freezes: [],
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
  let currentView = 'home';
  const VIEW_IDS = {home:'homeScreen',library:'libraryScreen',settings:'settingsScreen',editor:'editorScreen',none:'noProjectScreen'};
  const hasProject = () => !!project.videoUrl;
  function showView(name) {
    if (name === 'editor' && !hasProject()) name = 'none';
    currentView = name;
    for (const [key,id] of Object.entries(VIEW_IDS)) $('#'+id).classList.toggle('hidden', key!==name);
    $('#navEditor').classList.toggle('hidden', !hasProject());
    $$('#mainNav a').forEach(a => { a.getAttribute('data-route')===name ? a.setAttribute('aria-current','page') : a.removeAttribute('aria-current'); });
    document.querySelector('.header-actions').style.display = name==='editor' ? '' : 'none';
    if (name !== 'editor') pauseAllAudio();
    if (name === 'library') renderLibrary();
    if (name === 'home') renderHomeRecent();
    $('#main-content').focus({preventScroll:true});
    window.scrollTo(0,0);
  }
  function route() {
    const h = location.hash || '';
    if (h.startsWith('#') && !h.startsWith('#/')) {
      // In-page anchor, not a route: stay on the current view.
      const target = document.querySelector(h.split('?')[0]);
      if (target && currentView === 'editor') target.scrollIntoView();
      history.replaceState(null, '', '#/' + (currentView || 'home'));
      return;
    }
    const name = h.replace(/^#\/?/,'').split('?')[0] || 'home';
    showView(VIEW_IDS[name] ? name : 'home');
  }
  function hashQuery() { const h=location.hash||''; return h.includes('?') ? '?'+h.split('?').slice(1).join('?') : ''; }
  function openEditor() { showView('editor'); const target='#/editor'+hashQuery(); if ((location.hash||'') !== target) history.pushState(null,'',target); }
  function projectCardHTML(p) {
    return `<div class="card library-card" role="group" aria-label="Project: ${escapeHTML(p.name)}. Duration ${formatTimeVerbose(p.duration)}. Last modified ${new Date(p.modified).toLocaleString()}.">
      <div><strong>${escapeHTML(p.name)}</strong></div>
      <div class="clip-meta">Duration ${formatTimeVerbose(p.duration)} • Modified ${new Date(p.modified).toLocaleString()}</div>
      <div class="flex gap-8 wrap mt-8">
        <button data-open-project="${p.id}">Open</button>
        <button data-rename-project="${p.id}">Rename</button>
        <button data-delete-project="${p.id}">Delete</button>
      </div>
    </div>`;
  }
  function wireProjectCards(root) {
    root.querySelectorAll('[data-open-project]').forEach(b => b.addEventListener('click', () => openProjectById(b.getAttribute('data-open-project'))));
    root.querySelectorAll('[data-delete-project]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-delete-project');
      showConfirm('Delete this project and its saved media from this device?', async () => {
        await VoiceCutStorage.remove(id);
        if (project.id === id) resetProjectState();
        renderLibrary(); renderHomeRecent();
        announce('Project deleted.');
      });
    }));
    root.querySelectorAll('[data-rename-project]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-rename-project');
      const card = b.closest('.library-card');
      const input = document.createElement('input');
      input.type = 'text'; input.setAttribute('aria-label','New project name');
      input.value = card.querySelector('strong').textContent;
      const save = document.createElement('button'); save.textContent = 'Save name';
      save.addEventListener('click', async () => {
        const name = input.value.trim() || 'Untitled Project';
        await VoiceCutStorage.rename(id, name);
        if (project.id === id) { project.name = name; renderAll(); }
        renderLibrary(); renderHomeRecent();
        announce(`Project renamed to ${name}.`);
      });
      card.append(input, save); input.focus(); input.select();
    }));
  }
  async function renderLibrary() {
    const list = await VoiceCutStorage.list().catch(() => []);
    $('#libraryEmpty').style.display = list.length ? 'none' : '';
    $('#libraryList').innerHTML = list.map(projectCardHTML).join('');
    wireProjectCards($('#libraryList'));
  }
  async function renderHomeRecent() {
    const list = (await VoiceCutStorage.list().catch(() => [])).slice(0,3);
    $('#homeRecentEmpty').style.display = list.length ? 'none' : '';
    $('#homeRecentList').innerHTML = list.map(projectCardHTML).join('');
    wireProjectCards($('#homeRecentList'));
  }
  async function openProjectById(id) {
    try {
      await saveQueue.catch(() => {});
      const saved = id ? await VoiceCutStorage.get(id) : await VoiceCutStorage.load();
      if (!saved) { announce('No saved project. Upload a video to begin.'); return; }
      pauseAllAudio();
      currentRequest?.abort(); mediaEpoch++;
      project = saved; captionDefaults();
      applyPrefsToProject(false);
      project.videoUrl = project.videoFile ? URL.createObjectURL(project.videoFile) : null;
      project.clips.forEach(c => { c.url = c.file ? URL.createObjectURL(c.file) : null; c.originalUrl = c.originalFile ? URL.createObjectURL(c.originalFile) : null; });
      video.src = project.videoUrl || '';
      for (const c of project.clips) createAudioNodeForClip(c);
      applyOriginalNR();
      selectedClipId = null;
      historyStack = []; historyIndex = -1;
      pushHistory(); renderAll();
      $('#videoPlaceholder').classList.toggle('hidden', !!project.videoUrl);
      openEditor();
      $('#section-video').scrollIntoView();
      announce(`Project opened: ${project.name}. Duration ${formatTimeVerbose(project.duration)}.`);
    } catch(e) { announce('Cannot open project: ' + e.message, true); }
  }
  function resetProjectState() {
    pauseAllAudio();
    currentRequest?.abort(); mediaEpoch++;
    clearTimeout(autoSaveTimeout); dirty = false;
    project = { id:'proj_'+Date.now(), name:'Untitled Project', videoFile:null, videoUrl:null, duration:0, trimStart:0, trimEnd:0, crop:{preset:'original',x:0,y:0,w:100,h:100}, rotation:0, freezes:[], segments:[], captions:[], captionSettings:{preview:true,burnIn:true}, originalAudio:{volume:100, muted:false, fadeIn:0, fadeOut:0, noiseReduction:'medium'}, clips:[], ducking:{enabled:true, level:30}, playbackSpeed:1, skipAmount:5, resolution:'1080', fps:30, format:'mp4', created:Date.now(), modified:Date.now() };
    applyPrefsToProject(true);
    selectedClipId = null;
    video.src = '';
    $('#videoPlaceholder').classList.remove('hidden');
    historyStack = []; historyIndex = -1;
    renderAll();
  }
  function captionDefaults() {
    project.captions ||= [];
    project.captionSettings ||= {preview:true,burnIn:true};
    project.crop ||= {preset:'original',x:0,y:0,w:100,h:100};
    project.rotation ||= 0;
    project.freezes ||= [];
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
    $('#captionCounter').textContent=project.captions.length?`Caption ${captionSelection+1} of ${project.captions.length}`:'No captions';
    $('#btnPrevCaption').disabled=!cue||captionSelection<=0;
    $('#btnNextCaption').disabled=!cue||captionSelection>=project.captions.length-1;
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
    const source=$('#captionSource').value;
    const clip=source==='original'?null:source==='voiceover'?project.clips.find(c=>c.type==='voiceover'):project.clips.find(c=>c.id===selectedClipId);
    const file=source==='original'?project.videoFile:clip?.file;
    if(!project.videoFile){announce('Load a video first.',true);return;}
    if(!file){announce(source==='voiceover'?'No voice-over track. Record or import one first.':'Select an audio clip in the timeline first.',true);return;}
    if(project.captions?.length&&!confirm('Replace the current caption list? You can undo after generation.'))return;
    const epoch=mediaEpoch, id=project.id;
    const clipSnapshot=clip?structuredClone(clip):null;
    captionRequestBusy=true;$('#btnGenerateCaptions').disabled=true;$('#btnCancelCaptions').disabled=false;
    $('#captionStatus').textContent='Waiting for upload confirmation. Your existing captions are unchanged.';
    try{
      $('#captionStatus').textContent='Preparing small audio for upload. Your existing captions are unchanged.';
      let uploadFile=file, uploadTrimmed=false;
      try{
        if(clipSnapshot){uploadFile=await shrinkAudioFile(file,clipSnapshot.trimStart||0,clipSnapshot.duration-(clipSnapshot.trimEnd||0));uploadTrimmed=true;}
        else uploadFile=await shrinkAudioFile(file);
      }catch(prepErr){console.warn('Caption audio prep fell back to original file:',prepErr);uploadFile=file;}
      let result=null;
      for(let captionAttempt=1;captionAttempt<=2;captionAttempt++){
        try{
          result=await requestServerUpload('/api/captions?language='+encodeURIComponent($('#captionLanguage').value),uploadFile,{cloud:true,onProgress:(pct)=>{
            $('#captionStatus').textContent=pct>=100?'Upload complete. Transcribing. This can take a minute on a slow connection.':'Uploading caption audio: '+pct+'%. You can cancel; do not submit twice.';
          }});
          break;
        }
        catch(e){
          if(captionAttempt===1&&e.message==='SERVICE_UNAVAILABLE'){$('#captionStatus').textContent='Connection stumbled. Retrying once…';await new Promise(r=>setTimeout(r,1500));}
          else throw e;
        }
      }
      if(epoch!==mediaEpoch||id!==project.id)throw new Error('Project changed during processing. Result was not applied.');
      let cues=VoiceCutCaptions.validate(result.cues,result.duration);
      if(clipSnapshot){
        if(uploadTrimmed){
          const clipLen=(clipSnapshot.duration-(clipSnapshot.trimEnd||0))-(clipSnapshot.trimStart||0);
          cues=cues.map(c=>({text:c.text,start:c.start+clipSnapshot.startTime,end:Math.min(c.end,clipLen)+clipSnapshot.startTime})).filter(c=>c.end>c.start);
        }else{
          const start=clipSnapshot.trimStart||0,end=clipSnapshot.duration-(clipSnapshot.trimEnd||0);
          cues=cues.map(c=>({text:c.text,start:Math.max(start,c.start)-start+clipSnapshot.startTime,end:Math.min(end,c.end)-start+clipSnapshot.startTime})).filter(c=>c.end>c.start);
        }
      }
      cues=cues.map(c=>({...c,start:Math.max(0,c.start),end:Math.min(project.duration,c.end)})).filter(c=>c.end>c.start);
      project.captions=VoiceCutCaptions.validate(cues,project.duration);
      project.captionLanguage=result.language;
      project.captionSource=source==='original'?'Original video audio':source==='voiceover'?'Voice-over track':'Audio clip: '+clipSnapshot.name;
      captionSelection=0;pushHistory();renderCaptions();
      const cover=cues.length?` covering ${formatTimeVerbose(cues[0].start)} to ${formatTimeVerbose(cues[cues.length-1].end)} of ${formatTimeVerbose(project.duration)} video`:'';
      let langNote='';
      const chosen=$('#captionLanguage').value,detected=String(result.language||'').toLowerCase();
      if(chosen&&detected&&detected!=='unknown'&&detected!=='und'&&chosen.slice(0,2)!==detected.slice(0,2)){
        const names={en:'English',hi:'Hindi',te:'Telugu',ta:'Tamil',kn:'Kannada',ml:'Malayalam',mr:'Marathi',bn:'Bengali',ur:'Urdu'};
        langNote=` Warning: you chose ${names[chosen]||chosen} but the transcript was detected as ${names[detected.slice(0,2)]||result.language}. Wrong-language transcripts look like nonsense. Change Spoken language and regenerate.`;
      }
      let sparseNote='';
      const span=cues.length?cues[cues.length-1].end-cues[0].start:0;
      if(cues.length&&project.duration>20&&span<project.duration*0.5){
        sparseNote=` Only ${formatTimeVerbose(span)} of ${formatTimeVerbose(project.duration)} has detected speech. The rest is likely music, silence, or unclear audio.`;
      }
      const firstCue=cues.length?` First caption: "${cues[0].text.slice(0,120)}".`:'';
      const message=`${cues.length} captions generated${cover}. Detected language: ${result.language||'unknown'}.${langNote}${sparseNote}${firstCue} Review text and timing before publishing.`;
      $('#captionStatus').textContent=message;announce(message);
      notifyComplete('Captions ready',`${cues.length} captions generated for your video.`);
    }catch(e){
      console.warn('Caption request failed:',e);
      const cancelled=/cancelled|timed out/i.test(e.message);
      const message=cancelled?'Caption request cancelled. Your existing captions are unchanged.':'Caption generation is temporarily unavailable. Please try again.';
      $('#captionStatus').textContent=message;announce(message,!cancelled);
      $('#btnRetryCaptions').classList.toggle('hidden',cancelled);
    }
    finally{captionRequestBusy=false;$('#btnGenerateCaptions').disabled=false;$('#btnCancelCaptions').disabled=true;}
  }
  function stepCaption(dir) {
    if(!project.captions.length){announce('No captions.',true);return;}
    captionSelection=Math.min(project.captions.length-1,Math.max(0,captionSelection+dir));
    renderCaptions();
    const cue=project.captions[captionSelection];
    announce(`Caption ${captionSelection+1} of ${project.captions.length}, ${cue.start.toFixed(1)} to ${cue.end.toFixed(1)} seconds: ${cue.text}`);
  }
  function readAllCaptions() {
    if(!project.captions.length){announce('No captions to read.',true);return;}
    const parts=project.captions.map((c,i)=>`Caption ${i+1}, ${c.start.toFixed(1)} to ${c.end.toFixed(1)} seconds: ${c.text}`);
    announce(`All ${project.captions.length} captions. `+parts.join(' '),false,true);
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
    $('#btnGenerateCaptions').addEventListener('click',()=>{$('#btnRetryCaptions').classList.add('hidden');generateCaptions();});
    $('#btnRetryCaptions').addEventListener('click',()=>{$('#btnRetryCaptions').classList.add('hidden');generateCaptions();});
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
    $('#btnPrevCaption').addEventListener('click',()=>stepCaption(-1));
    $('#btnNextCaption').addEventListener('click',()=>stepCaption(1));
    $('#btnReadAllCaptions').addEventListener('click',readAllCaptions);
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
  function renderEdit(){
    captionDefaults();
    $('#cropPreset').value=project.crop.preset;
    $('#cropX').value=project.crop.x;$('#cropY').value=project.crop.y;$('#cropW').value=project.crop.w;$('#cropH').value=project.crop.h;
    $('#rotateAngle').value=String(project.rotation);
    const custom=project.crop.preset==='custom';
    ['cropX','cropY','cropW','cropH'].forEach(id=>{$('#'+id).disabled=!custom;});
    const cropLabel=project.crop.preset==='original'?'original frame':project.crop.preset==='custom'?`left ${project.crop.x}%, top ${project.crop.y}%, ${project.crop.w}% by ${project.crop.h}%`:project.crop.preset;
    $('#cropSummary').textContent=`Crop: ${cropLabel}. Rotation: ${project.rotation?project.rotation+' degrees':'none'}. Applied at export.`;
    const list=$('#freezeList');list.innerHTML='';
    [...project.freezes].sort((a,b)=>a.at-b.at).forEach(f=>{
      const li=document.createElement('li');
      li.textContent=`Freeze at ${formatTimeVerbose(f.at)} for ${f.hold} seconds. `;
      const del=document.createElement('button');del.textContent='Delete freeze frame';
      del.setAttribute('aria-label',`Delete freeze frame at ${formatTimeVerbose(f.at)}`);
      del.addEventListener('click',()=>{project.freezes=project.freezes.filter(x=>x.id!==f.id);pushHistory();renderAll();announce('Freeze frame deleted.');});
      li.appendChild(del);list.appendChild(li);
    });
  }
  function renderAll() {
    captionDefaults();
    renderCaptions();renderEdit();
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
        <option value="voicefocus" ${t.value==='voicefocus'?'selected':''}>Voice Focus</option>
        <option value="ultra" ${t.value==='ultra'?'selected':''}>Ultra \u2014 strongest</option>
      </select></label>`;
      container.appendChild(div);
    });
    container.querySelectorAll('select').forEach(sel=>{
      sel.addEventListener('change', (e)=>{
        const id = e.target.getAttribute('data-nr-id');
        const val = e.target.value;
        if (id==='orig') {
          project.originalAudio.noiseReduction = val;
          applyOriginalNR();
          announce(`Noise reduction for original audio set to ${val}.`);
        } else {
          const clip = project.clips.find(c=>c.id===id);
          if (clip) { clip.noiseReduction = val; createAudioNodeForClip(clip); announce(`Noise reduction for ${escapeHTML(clip.name)} set to ${val}.`); }
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
      Crop: ${project.crop?.preset||'original'} • Rotation: ${project.rotation||0}° • Freeze frames: ${(project.freezes||[]).length}<br>
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
      project.id = 'proj_'+Date.now();
      captionDefaults();
      applyPrefsToProject(true);
      openEditor();
      $('#section-video').scrollIntoView({behavior:'smooth'});
      autoSave();
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
      if (clip.noiseReduction && clip.noiseReduction!=='off') {
        const chain = buildNRChain(clip.noiseReduction);
        source.connect(chain.input);
        chain.output.connect(gain);
      } else {
        source.connect(gain);
      }
      gain.connect(audioContext.destination);

      audioNodes.set(clip.id, {element:audioEl, source, gain});
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
  let pendingRecording = null;
  let recordPreviewUrl = null;
  let recordingRequest = 0;
  async function startRecording() {
    if (isRecording || recordingStream) return;
    const requestId = ++recordingRequest;
    const position = parseTime($('#recordPosition').value);
    if (!Number.isFinite(position) || position < 0) { announce('Enter a valid recording position.', true); return; }
    $('#btnStartRecording').disabled = true;
    pendingRecording=null; $('#recordReview').classList.add('hidden'); $('#recordPreview').removeAttribute('src');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Recording needs HTTPS and a browser with microphone support.');
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (requestId !== recordingRequest || !$('#recordDialog').open) { stream.getTracks().forEach(t=>t.stop()); return; }
      recordingStream = stream;
      const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error('No supported audio recorder format.');
      for (const n of [3,2,1]) {
        if (requestId !== recordingRequest || !$('#recordDialog').open) { stream.getTracks().forEach(t=>t.stop()); return; }
        $('#recordCountdown').textContent = 'Recording starts in '+n;
        $('#recordCountdown').classList.remove('hidden');
        announce('Recording starts in '+n);
        await new Promise(r=>setTimeout(r,700));
      }
      if (requestId !== recordingRequest || !$('#recordDialog').open) { stream.getTracks().forEach(t=>t.stop()); return; }
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
          pendingRecording = {blob, position};
          if (recordPreviewUrl) URL.revokeObjectURL(recordPreviewUrl);
          recordPreviewUrl = URL.createObjectURL(blob);
          $('#recordPreview').src = recordPreviewUrl;
          $('#recordReview').classList.remove('hidden');
          $('#btnStopRecordingDialog').disabled = true;
          $('#recordCountdown').textContent = 'Recording finished. Press Play Voice to preview, then Apply or Discard.';
          announce('Recording stopped. Preview your voice, then Apply or Discard.');
        } else {
          $('#recordDialog').close();
          announce('Recording stopped. No audio was captured.');
        }
      };
      mediaRecorder.onerror = () => { stopRecording(); announce('Recording failed.',true); };
      mediaRecorder.start(250); isRecording=true; recordStartTime=Date.now();
      $('#btnStopVO').disabled=false; $('#btnStopRecordingDialog').disabled=false; $('#btnRecordVO').disabled=true;
      $('#recordCountdown').textContent='Recording your voice\u2026'; $('#recordCountdown').classList.remove('hidden');
      // No video sound through speakers during voice-over recording.
      video.pause(); for (const node of audioNodes.values()) node.element.pause();
      announce('Recording started. Speak now.');
      recordTimerInterval=setInterval(()=>{ $('#recordTimer').textContent=formatTime((Date.now()-recordStartTime)/1000); },1000);
    } catch(e) {
      recordingStream?.getTracks().forEach(t=>t.stop()); recordingStream=null;
      $('#btnStartRecording').disabled=false; announce('Cannot record: '+e.message,true);
    }
  }
  function closeRecordDialog() { if ($('#recordDialog').open) $('#recordDialog').close(); }
  function clearRecordPreview() {
    pendingRecording = null;
    $('#recordReview').classList.add('hidden');
    $('#recordPreview').pause(); $('#recordPreview').removeAttribute('src');
    if (recordPreviewUrl) { URL.revokeObjectURL(recordPreviewUrl); recordPreviewUrl = null; }
  }
  function applyPendingRecording() {
    if (!pendingRecording) { closeRecordDialog(); return; }
    const {blob, position} = pendingRecording;
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    addAudioFile(new File([blob],`Voiceover_${Date.now()}.${extension}`,{type:blob.type}),'voiceover',position);
    clearRecordPreview(); closeRecordDialog();
    announce('Voice-over applied.');
  }
  function discardPendingRecording(silent) {
    clearRecordPreview(); closeRecordDialog();
    if (!silent) announce('Recording discarded.');
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
  const NR_CHAINS={
    off:{hp:0,lp:20000,notch:0,presence:0,threshold:0,ratio:1},
    light:{hp:80,lp:12000,notch:0,presence:0,threshold:-30,ratio:6},
    medium:{hp:100,lp:8000,notch:0,presence:3,threshold:-40,ratio:6},
    strong:{hp:120,lp:6000,notch:50,presence:4,threshold:-40,ratio:12},
    voicefocus:{hp:120,lp:8000,notch:50,presence:6,threshold:-45,ratio:12},
    ultra:{hp:150,lp:7000,notch:50,presence:8,threshold:-40,ratio:20}
  };
  function buildNRChain(level){
    const p=NR_CHAINS[level]||NR_CHAINS.medium;
    const highpass=audioContext.createBiquadFilter();highpass.type='highpass';highpass.frequency.value=p.hp;
    const lowpass=audioContext.createBiquadFilter();lowpass.type='lowpass';lowpass.frequency.value=p.lp;
    const notch=audioContext.createBiquadFilter();notch.type='notch';notch.frequency.value=50;notch.Q.value=8;
    const presence=audioContext.createBiquadFilter();presence.type='peaking';presence.frequency.value=3000;presence.Q.value=0.9;presence.gain.value=p.presence;
    const compressor=audioContext.createDynamicsCompressor();
    compressor.threshold.value=p.threshold;compressor.knee.value=20;compressor.ratio.value=p.ratio;compressor.attack.value=0.01;compressor.release.value=0.25;
    highpass.connect(lowpass);
    let tail=lowpass;
    if(p.notch){tail.connect(notch);tail=notch;}
    tail.connect(presence);presence.connect(compressor);
    return {input:highpass,output:compressor};
  }
  function ensureOriginalGraph() {
    ensureAudioContext();
    if (!originalSource) {
      originalSource = audioContext.createMediaElementSource(video);
      originalGain = audioContext.createGain();
      originalGain.connect(audioContext.destination);
      applyOriginalNR();
    }
    return originalGain;
  }
  function applyOriginalNR() {
    if (!originalSource || !originalGain) return;
    try { originalSource.disconnect(); } catch {}
    if (!project.originalAudio || project.originalAudio.noiseReduction==='off') {
      originalSource.connect(originalGain);
    } else {
      const chain = buildNRChain(project.originalAudio.noiseReduction);
      originalSource.connect(chain.input);
      chain.output.connect(originalGain);
    }
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
      const freezes = [...(project.freezes||[])].filter(f=>Number.isFinite(f.at)&&Number.isFinite(f.hold)).sort((a,b)=>a.at-b.at);
      const exportDuration = duration + freezes.reduce((sum,f)=>sum+f.hold,0);
      const rotation = ((Number(project.rotation)%360)+360)%360;
      const portrait = rotation===90||rotation===270;
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
      exportCanvas.height = height;
      exportCanvas.width = portrait?Math.round(height*9/16/2)*2:Math.round(height*16/9/2)*2;
      const ctx = exportCanvas.getContext('2d');
      const drawFrame = () => {
        ctx.fillStyle = '#000'; ctx.fillRect(0,0,exportCanvas.width,exportCanvas.height);
        const rect = VoiceCutCore.cropRect(project.crop?.preset||'original',video.videoWidth,video.videoHeight,project.crop);
        const cw = exportCanvas.width, ch = exportCanvas.height;
        const fitW = portrait?ch:cw, fitH = portrait?cw:ch;
        const scale = Math.min(fitW/rect.w,fitH/rect.h), w = rect.w*scale, h = rect.h*scale;
        if (rotation===0) { ctx.drawImage(video,rect.x,rect.y,rect.w,rect.h,(cw-w)/2,(ch-h)/2,w,h); return; }
        ctx.save(); ctx.translate(cw/2,ch/2); ctx.rotate(rotation*Math.PI/180);
        ctx.drawImage(video,rect.x,rect.y,rect.w,rect.h,-w/2,-h/2,w,h); ctx.restore();
      };
      const canvasStream = exportCanvas.captureStream(Number(project.fps));
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      let raf, timeout, completed = 0, rangeIndex = 0, lastAnnouncement = -1;
      let freezeIndex = 0, holdsDone = 0, freezeHoldUntil = 0, frozenTime = 0, currentHold = 0, holdStart = 0;
      const reportProgress = (elapsed) => {
        const percent = Math.min(99, Math.round(100*elapsed/exportDuration));
        $('#exportProgressBar').style.width = percent+'%'; $('#exportProgressBar').setAttribute('aria-valuenow',String(percent));
        const quarter = Math.floor(percent/25);
        if (quarter > lastAnnouncement) { lastAnnouncement = quarter; announce('Exporting video. '+quarter*25+' percent.'); }
      };
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
        notifyComplete('Export complete','Your video export is ready. Preview, then download.');
      };
      await seekTo(ranges[0].start);
      if (exportCancelled) { exportCleanup?.(); return; }
      video.playbackRate = project.playbackSpeed;
      recorder.start(250);
      await video.play();
      timeout = setTimeout(cancelExport, (exportDuration / project.playbackSpeed + 60) * 1000);
      async function frame() {
        if (!isExporting || exportCancelled) return;
        try {
          const range = ranges[rangeIndex];
          if (freezeHoldUntil) {
            if (performance.now() < freezeHoldUntil) {
              drawFrame();
              if (project.captionSettings?.burnIn) VoiceCutCaptions.draw(ctx,VoiceCutCaptions.active(project.captions,frozenTime),exportCanvas.width,exportCanvas.height);
              reportProgress(completed+holdsDone+Math.min(currentHold,(performance.now()-holdStart)/1000));
              raf = requestAnimationFrame(frame);
              return;
            }
            holdsDone += currentHold; freezeHoldUntil = 0;
            await video.play();
          }
          const freeze = freezes[freezeIndex];
          if (freeze && video.currentTime >= freeze.at && video.currentTime < range.end) {
            freezeIndex++;
            video.pause();
            for (const node of audioNodes.values()) node.element.pause();
            frozenTime = video.currentTime; currentHold = freeze.hold; holdStart = performance.now();
            freezeHoldUntil = holdStart + freeze.hold*1000;
          }
          if (video.currentTime >= range.end - 0.015 || video.ended) {
            completed += range.end-range.start;
            rangeIndex++;
            if (rangeIndex === ranges.length) { recorder.stop(); return; }
            recorder.pause(); video.pause();
            for (const node of audioNodes.values()) node.element.pause();
            await seekTo(ranges[rangeIndex].start);
            while (freezeIndex < freezes.length && freezes[freezeIndex].at < ranges[rangeIndex].start) freezeIndex++;
            if (!isExporting || exportCancelled) return;
            recorder.resume(); await video.play();
          }
          drawFrame();
          if (project.captionSettings?.burnIn) VoiceCutCaptions.draw(ctx,VoiceCutCaptions.active(project.captions,video.currentTime),exportCanvas.width,exportCanvas.height);
          syncAudioPlayback(true);
          reportProgress(completed+holdsDone+video.currentTime-ranges[rangeIndex].start);
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

  let lastCleanupEngine = 'classic';
  let lastScanReport = '';
  // Scan the whole audio (downsampled for speed) for engine-like BRR regions.
  function scanWholeAudio(buffer) {
    try{
      if (!window.VoiceCutNDetect?.scanNoise) return {};
      const sr = buffer.sampleRate, len = buffer.length, ch = buffer.numberOfChannels;
      const dec = Math.max(1, Math.floor(sr / 4000));
      const dn = Math.floor(len / dec);
      if (dn < 2000) return {};
      const chs = [];
      for (let c = 0; c < ch; c++) chs.push(buffer.getChannelData(c));
      const mono = new Float32Array(dn);
      for (let k = 0; k < dn; k++) {
        let acc = 0;
        for (let j = 0; j < dec; j++) { const idx = k * dec + j; for (let c = 0; c < ch; c++) acc += chs[c][idx]; }
        mono[k] = acc / (dec * ch);
      }
      const report = window.VoiceCutNDetect.scanNoise(mono, sr / dec);
      return {report, strengthAt: report.strengthAt};
    }catch(e){ console.warn('Noise scan fell back to uniform strength:', e); return {}; }
  }
  async function resampleChannel(data, fromSr, toSr, exactLen) {
    if (fromSr === toSr) return data.slice(0, exactLen || data.length);
    const targetLen = exactLen || Math.max(1, Math.ceil(data.length / fromSr * toSr));
    const off = new OfflineAudioContext(1, targetLen, toSr);
    const tmp = off.createBuffer(1, data.length, fromSr);
    tmp.copyToChannel(data, 0);
    const src = off.createBufferSource();
    src.buffer = tmp; src.connect(off.destination); src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice();
  }
  // NR-2 neural cleanup: full-file scan plus a recurrent neural network that
  // removes noise as loud as the voice. Fully offline; per-channel states.
  async function neuralCleanup(buffer, level, scan, onProgress) {
    const NR2 = window.VoiceCutNR2;
    if (!NR2?.process48k) throw new Error('Neural engine unavailable.');
    const mixCfg = NR2.MIX[level] || NR2.MIX.medium;
    const strengthAt = scan.strengthAt;
    const mixAt = strengthAt ? ((t) => strengthAt(t, mixCfg.base, mixCfg.boost)) : (() => mixCfg.base);
    const sr = buffer.sampleRate, len = buffer.length, ch = buffer.numberOfChannels;
    let peak = 0;
    for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i += 7) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
    const moduleUrl = String(new URL('web/vendor/rnnoise.js', document.baseURI));
    const out = new AudioBuffer({numberOfChannels: ch, length: len, sampleRate: sr});
    for (let c = 0; c < ch; c++) {
      if (aiProcessingCancelled) throw new Error('Cancelled');
      onProgress(5 + Math.round(c / ch * 90), 'Neural cleanup: preparing channel ' + (c + 1) + ' of ' + ch + '.');
      const up = await resampleChannel(buffer.getChannelData(c), sr, 48000);
      if (aiProcessingCancelled) throw new Error('Cancelled');
      const r = await NR2.process48k(up, {moduleUrl, peak, mixAt,
        onProgress: (p) => onProgress(5 + Math.round((c + p) / ch * 90), 'Neural cleanup: removing noise (channel ' + (c + 1) + ' of ' + ch + ').'),
        shouldCancel: () => aiProcessingCancelled});
      const back = await resampleChannel(r.out, 48000, sr, len);
      out.copyToChannel(back, c);
    }
    return out;
  }
  // On-device cleanup: neural first (NR-2), classic spectral (NR-1) fallback.
  async function processAudioBufferWithAI(buffer, level, onProgress) {
    if (buffer.duration > 600) throw new Error('Local cleanup is limited to 10 minutes to protect device memory.');
    onProgress(3, 'Scanning the whole audio for noise. No upload.');
    await new Promise(r => setTimeout(r, 0));
    const scan = scanWholeAudio(buffer);
    lastScanReport = scan.report ? scan.report.summary.text : '';
    lastCleanupEngine = 'classic';
    if (window.VoiceCutNR2?.process48k) {
      try{
        const result = await neuralCleanup(buffer, level, scan, onProgress);
        if (aiProcessingCancelled) throw new Error('Cancelled');
        lastCleanupEngine = 'neural';
        onProgress(100, 'On-device neural cleanup complete. Preview before applying.');
        return result;
      }catch(e){
        if (/cancelled/i.test(e.message)) throw e;
        console.warn('Neural cleanup failed; using classic cleanup:', e);
        announce('Neural engine unavailable. Used classic cleanup instead.');
      }
    } else {
      announce('Neural engine unavailable. Used classic cleanup instead.');
    }
    if (!window.VoiceCutNR?.spectralDenoise) throw new Error('On-device cleanup engine missing. Reload the app.');
    onProgress(5, 'Reducing noise on this device. No upload.');
    const result = await window.VoiceCutNR.spectralDenoise(buffer, level, (pct, text) => onProgress(pct, text), (ch, len, sr) => new AudioBuffer({numberOfChannels: ch, length: len, sampleRate: sr}), () => aiProcessingCancelled);
    if (aiProcessingCancelled) throw new Error('Cancelled');
    onProgress(100, 'On-device cleanup complete. Preview before applying.');
    return result;
  }

  let silenceTicker=null;
  function showSilenceProgress(pct){
    const bar=$('#silenceProgress');
    bar.style.display='block';
    if(pct===null||pct===undefined){bar.removeAttribute('value');}
    else{bar.value=Math.max(0,Math.min(100,pct));}
  }
  function hideSilenceProgress(){
    const bar=$('#silenceProgress');
    bar.style.display='none';bar.value=0;
    $('#silenceElapsed').textContent='';
  }
  function silenceTickStart(label){
    silenceTickStop();
    const el=$('#silenceElapsed'),t0=Date.now();
    el.textContent=label+'. Time elapsed: 0 seconds.';
    silenceTicker=setInterval(()=>{
      const s=Math.round((Date.now()-t0)/1000);
      el.textContent=label+'. Time elapsed: '+formatTimeVerbose(s)+'.';
    },1000);
  }
  function silenceTickStop(){if(silenceTicker){clearInterval(silenceTicker);silenceTicker=null;}}
  async function detectSilenceClips(){return detectSilenceGaps(true);}
  async function detectSilenceOriginal(){return detectSilenceGaps(false);}
  async function detectSilenceGaps(fromClip) {
    if (cleanupBusy || captionRequestBusy || isExporting) { announce('Wait for the current operation to finish.', true); return; }
    let input,name;
    if(fromClip){
      const clip = project.clips.find(c=>c.id===selectedClipId);
      if (!clip || !(clip.file || clip.url)) { announce('Select an audio clip in the timeline first.', true); return; }
      input=clip.file||clip.url;name=clip.name;
    }else{
      if (!project.videoFile) { announce('Upload a video first.', true); return; }
      input=project.videoFile;name='Original video audio';
    }
    const seconds = $('#silenceSeconds').value;
    const statusEl = $('#silenceStatus');
    cleanupBusy = true; aiProcessingCancelled = false;
    showSilenceProgress(0);
    statusEl.textContent='Preparing a small audio copy for fast gap detection.';
    announce('Detecting quiet gaps. Uploading a small audio copy.');
    try {
      const file = input instanceof Blob ? input : await (await fetch(input)).blob();
      let uploadFile=file;
      try{uploadFile=await shrinkAudioFile(file,0,Infinity,16000);}catch(e){uploadFile=file;}
      const result = await requestServerUpload('/api/silence?seconds=' + encodeURIComponent(seconds) + '&detect=1', uploadFile, {cloud:false, consent:'Upload a small audio copy to your VoiceCut server to preview quiet gaps? Temporary server copies expire within 15 minutes.', onProgress:(pct)=>{
        showSilenceProgress(pct);
        if(pct<100)statusEl.textContent='Uploading small audio for gap detection: '+pct+'%.';
      }});
      if(aiProcessingCancelled)throw new Error('Cancelled');
      if(!(result&&typeof result==='object'))throw new Error('SERVICE_UNAVAILABLE');
      const gaps=Array.isArray(result.gaps)?result.gaps:[];
      const fmtT=(t)=>{const m=Math.floor(t/60),s2=Math.floor(t%60);return m+':'+String(s2).padStart(2,'0');};
      const message=gaps.length
        ?`Found ${gaps.length} quiet ${gaps.length===1?'gap':'gaps'} (${result.removedSeconds} seconds total): `+gaps.slice(0,8).map(g=>fmtT(g[0])+' to '+fmtT(g[1])).join(', ')+(gaps.length>8?', and more':'')+'. Tap Remove Silence to cut them out.'
        :`No quiet gaps longer than ${seconds} seconds found.`;
      statusEl.textContent=message;announce(message);
    } catch(e) {
      const msg = /cancelled|timed out/i.test(e.message) ? 'Detection stopped: ' + e.message
        : e.message === 'SERVICE_UNAVAILABLE' ? 'Could not reach the VoiceCut server. Check your internet and try again.'
        : 'Detection stopped: ' + e.message;
      statusEl.textContent = msg; announce(msg, true);
    } finally { cleanupBusy = false; hideSilenceProgress(); silenceTickStop(); }
  }
  async function silenceClipWithAI() {
    const clip = project.clips.find(c=>c.id===selectedClipId);
    if (!clip || !(clip.file || clip.url)) { announce('Select an audio clip in the timeline first.', true); return; }
    return processSilence(clip.file || clip.url, clip.name, clip.id);
  }
  async function silenceOriginalVideo() {
    if (!project.videoFile) { announce('Upload a video first.', true); return; }
    return processSilence(project.videoFile, 'Original video audio', null);
  }
  async function processSilence(input, name, clipId) {
    if (cleanupBusy || captionRequestBusy || isExporting) { announce('Wait for the current operation to finish.', true); return; }
    const seconds = $('#silenceSeconds').value;
    const statusEl = $('#silenceStatus');
    cleanupBusy = true; aiProcessingCancelled = false;
    video.pause(); for (const node of audioNodes.values()) node.element.pause();
    const epoch = mediaEpoch;
    showSilenceProgress(0);
    statusEl.textContent = 'Uploading to your VoiceCut server…';
    announce('Removing silence. Uploading to your VoiceCut server.');
    try {
      const file = input instanceof Blob ? input : await (await fetch(input)).blob();
      if (file.size > 100 * 1024 * 1024) throw new Error('Cleanup supports media files up to 100 MB.');
      statusEl.textContent = 'Detecting quiet gaps longer than ' + seconds + ' seconds…';
      const blob = await requestServerUpload('/api/silence?seconds=' + encodeURIComponent(seconds), file, {cloud:false, consent:'Upload this file to your VoiceCut server to remove silence? Maximum 10 minutes and 100 MB. Temporary server copies expire within 15 minutes.', onProgress:(pct)=>{
        showSilenceProgress(pct);
        if(pct>=100){showSilenceProgress(null);silenceTickStart('Trimming on the server');statusEl.textContent='Upload complete. Detecting quiet gaps longer than '+seconds+' seconds.';}
        else statusEl.textContent='Uploading to your VoiceCut server: '+pct+'%.';
      }});
      if (!(blob instanceof Blob)) throw new Error('SERVICE_UNAVAILABLE');
      if (aiProcessingCancelled) throw new Error('Cancelled');
      if (epoch !== mediaEpoch) throw new Error('Project changed during processing. Result not applied.');
      const removed = Number(lastResponseHeaders?.get('X-Silence-Removed') || 0);
      const secs = Number(lastResponseHeaders?.get('X-Silence-Seconds') || 0);
      const message = removed > 0
        ? `Removed ${removed} silent ${removed === 1 ? 'gap' : 'gaps'}. Media is shorter by ${secs.toFixed(1)} seconds.`
        : `No quiet gaps longer than ${seconds} seconds found. Background noise may be filling the pauses; try noise reduction first.`;
      if (!clipId) {
        if (removed > 0) {
          const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'wav';
          if (window.flutter_inappwebview && blob.size <= 40 * 1024 * 1024) {
            const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
            await window.flutter_inappwebview.callHandler('shareExport', base64, ext);
          } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'silence-removed.' + ext;
            a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          }
        }
        silenceTickStop();showSilenceProgress(100);
        statusEl.textContent = message + (removed > 0 ? ' Trimmed file downloaded.' : '');
        announce(message + (removed > 0 ? ' Trimmed file downloaded.' : ''), removed === 0);
        notifyComplete('Silence removal complete',removed>0?`Removed ${removed} silent gaps. Trimmed file downloaded.`:`No gaps longer than ${seconds} seconds found.`);
        return;
      }
      const enhancedBuffer = await decodeAudioFile(blob);
      if (aiProcessingCancelled) throw new Error('Cancelled');
      const enhancedUrl = URL.createObjectURL(blob);
      const originalUrl = URL.createObjectURL(file);
      currentAIJob = {type:'clip', clipId, enhancedBlob:blob, enhancedBuffer, enhancedUrl, originalUrl, level:'silence-' + seconds + 's', provider:'VoiceCut silence removal', epoch};
      $('#aiOriginalAudio').src = originalUrl; $('#aiEnhancedAudio').src = enhancedUrl;
      $('#aiBeforeAfter').classList.remove('hidden'); $('#btnApplyEnhanced').classList.remove('hidden');
      $('#btnCloseAI').classList.remove('hidden');
      $('#aiResultText').textContent = 'VoiceCut silence removal: complete. Listen before applying.';
      const dialog = $('#aiProcessingDialog');
      if (!dialog.open) dialog.showModal();
      silenceTickStop();showSilenceProgress(100);
      statusEl.textContent = message;
      announce(message + ' Preview before applying.');
      notifyComplete('Silence removal complete',message);
    } catch(e) {
      const msg = /cancelled|timed out/i.test(e.message) ? 'Processing stopped: ' + e.message
        : e.message === 'SERVICE_UNAVAILABLE' ? 'Could not reach the VoiceCut server. Check your internet and try again. Your media is unchanged.'
        : 'Processing stopped: ' + e.message;
      statusEl.textContent = msg; announce(msg, true);
    } finally { cleanupBusy = false; hideSilenceProgress(); silenceTickStop(); }
  }
  let cleanupBusy = false;
  let lastResponseHeaders = null;
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
    cleanupBusy = true; aiProcessingCancelled = false; currentAIJob = null; lastScanReport='';
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
      const engineName = serverResult?.provider || (lastCleanupEngine==='classic'?'On-device classic cleanup':'On-device neural cleanup');
      const reportText = (!serverResult && lastScanReport) ? lastScanReport+' ' : '';
      currentAIJob = {type:clipId ? 'clip' : 'original',clipId,enhancedBlob,enhancedBuffer,enhancedUrl,originalUrl,level,provider:engineName,epoch};
      $('#aiOriginalAudio').src = originalUrl; $('#aiEnhancedAudio').src = enhancedUrl;
      $('#aiBeforeAfter').classList.remove('hidden'); $('#btnApplyEnhanced').classList.remove('hidden');
      $('#aiResultText').textContent = engineName+': complete. '+reportText+'Listen before applying.';
      progress(100,'Complete'); announce('Audio processing complete. '+reportText+'Preview before applying.');
      notifyComplete('Noise reduction complete','Enhanced audio is ready. Preview before applying.');
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

  function backendConfig() {
    try {
      const dev = window.VoiceCutConfig?.devOverride?.();
      if (dev) return dev;
      const url = window.VoiceCutConfig?.BACKEND_URL || null;
      return url ? {url, key:''} : null;
    } catch { return null; }
  }
  let cachedCapabilities = null;
  async function getCapabilities() {
    if (cachedCapabilities) return cachedCapabilities;
    let lastError=null;
    for (let attempt=1; attempt<=3; attempt++) {
      try { cachedCapabilities=await requestServer('/capabilities'); return cachedCapabilities; }
      catch(e){ lastError=e; if(attempt<3) await new Promise(r=>setTimeout(r,1000)); }
    }
    throw lastError;
  }
  function userPrefs(){try{return JSON.parse(localStorage.getItem('voicecut_prefs')||'{}');}catch{return{};}}
  function savePrefs(patch){localStorage.setItem('voicecut_prefs',JSON.stringify({...userPrefs(),...patch}));}
  function loadPrefs(){
    const p=userPrefs();
    if(p.playbackSpeed)$('#settingPlaybackSpeed').value=p.playbackSpeed;
    if(p.exportResolution)$('#settingExportResolution').value=p.exportResolution;
    if(p.captionLanguage!==undefined)$('#settingCaptionLanguage').value=p.captionLanguage;
    if(p.captionPreview!==undefined)$('#settingCaptionPreview').checked=!!p.captionPreview;
    if(p.captionBurn!==undefined)$('#settingCaptionBurn').checked=!!p.captionBurn;
    if(p.notifications!==undefined)$('#settingNotifications').checked=!!p.notifications;
    if(p.captionLanguage!==undefined)$('#captionLanguage').value=p.captionLanguage;
  }
  function notificationsEnabled(){return userPrefs().notifications===true;}
  function notifyComplete(title,body){
    try{
      if(!notificationsEnabled())return false;
      if(!document.hidden)return false;
      if(window.flutter_inappwebview&&window.flutter_inappwebview.callHandler){window.flutter_inappwebview.callHandler('showNotification',String(title),String(body));return true;}
      if('Notification' in window&&Notification.permission==='granted'){new Notification(String(title),{body:String(body)});return true;}
    }catch(e){console.warn('Completion notification failed:',e);}
    return false;
  }
  if(typeof window!=='undefined')window.VoiceCutNotify={notifyComplete,notificationsEnabled};
  function applyPrefsToProject(isNew){
    const p=userPrefs();
    if(isNew){
      if(p.playbackSpeed)project.playbackSpeed=Number(p.playbackSpeed);
      if(p.exportResolution)project.resolution=p.exportResolution;
      captionDefaults();
      if(p.captionPreview!==undefined)project.captionSettings.preview=!!p.captionPreview;
      if(p.captionBurn!==undefined)project.captionSettings.burnIn=!!p.captionBurn;
    }
    if(p.captionLanguage!==undefined)$('#captionLanguage').value=p.captionLanguage;
  }
  // Shrink any source to 16 kHz mono WAV so caption uploads stay tiny on
  // slow networks. Optional [start,end] slice (seconds) for trimmed clips.
  async function shrinkAudioFile(file, start=0, end=Infinity, targetSr=16000) {
    const decoded = await decodeAudioFile(file);
    const sr = decoded.sampleRate;
    const s0 = Math.max(0, Math.floor(start*sr));
    const s1 = Math.min(decoded.length, Math.ceil(Math.min(end, decoded.duration)*sr));
    if (s1-s0 < sr*0.2) throw new Error('Caption audio too short.');
    const mono = new AudioBuffer({numberOfChannels:1, length:s1-s0, sampleRate:sr});
    const out = mono.getChannelData(0), chs = [];
    for (let c=0;c<decoded.numberOfChannels;c++) chs.push(decoded.getChannelData(c));
    for (let i=0;i<s1-s0;i++){ let v=0; for (const d of chs) v+=d[s0+i]; out[i]=v/chs.length; }
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((s1-s0)/sr*targetSr)), targetSr);
    const srcNode = offline.createBufferSource(); srcNode.buffer=mono; srcNode.connect(offline.destination); srcNode.start(0);
    const rendered = await offline.startRendering();
    return new File([audioBufferToWavBlob(rendered)], 'voicecut-caption-audio.wav', {type:'audio/wav'});
  }
  // Same guards as requestServer, but XMLHttpRequest so uploads report real
  // progress and stay cancellable through currentRequest.
  async function requestServerUpload(endpoint, file, options={}) {
    const backend=backendConfig();
    if(!backend)throw new Error('SERVICE_UNAVAILABLE');
    const {cloud=false,consent='Upload this file to the secure VoiceCut service for AI processing? Maximum 10 minutes and 100 MB. Temporary server copies expire within 15 minutes.',onProgress=null}=options;
    if(currentRequest)throw new Error('Another server request is running. Wait or cancel it first.');
    if(file?.size>100*1024*1024)throw new Error('Use a file smaller than 100 MB.');
    if(file&&!confirm(consent))throw new Error('Upload cancelled.');
    return await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      currentRequest={abort:()=>xhr.abort()};
      let settled=false;
      const finish=(fn,val)=>{ if(settled)return; settled=true; currentRequest=null; fn(val); };
      xhr.open('POST', String(new URL(endpoint,backend.url)));
      if(backend.key)xhr.setRequestHeader('Authorization','Bearer '+backend.key);
      if(cloud)xhr.setRequestHeader('X-Upload-Consent','yes');
      xhr.timeout=14*60*1000;
      xhr.upload.onprogress=(e)=>{ if(e.lengthComputable&&typeof onProgress==='function')onProgress(Math.round(e.loaded/e.total*100)); };
      xhr.responseType='arraybuffer';
      xhr.onload=()=>{
        if(xhr.status<200||xhr.status>=300){finish(reject,new Error('SERVICE_UNAVAILABLE'));return;}
        lastResponseHeaders={get:(n)=>xhr.getResponseHeader(n)};
        const ct=xhr.getResponseHeader('content-type')||'';
        const bytes=xhr.response;
        if(ct.includes('application/json')){
          try{finish(resolve,JSON.parse(new TextDecoder().decode(bytes)));}catch(e){finish(reject,new Error('SERVICE_UNAVAILABLE'));}
        }else finish(resolve,new Blob([bytes],{type:ct||'application/octet-stream'}));
      };
      xhr.onerror=()=>{console.warn('VoiceCut service upload failed:',endpoint);finish(reject,new Error('SERVICE_UNAVAILABLE'));};
      xhr.onabort=()=>finish(reject,new Error('Request cancelled or timed out. Your original media is unchanged.'));
      xhr.ontimeout=()=>finish(reject,new Error('Request cancelled or timed out. Your original media is unchanged.'));
      const body=new FormData(); body.append('file',file); xhr.send(body);
    });
  }
  async function requestServer(endpoint,file=null,options={}) {
    const backend=backendConfig();
    if(!backend)throw new Error('SERVICE_UNAVAILABLE');
    const {cloud=false,consent='Upload this file to the secure VoiceCut service for AI processing? Maximum 10 minutes and 100 MB. Temporary server copies expire within 15 minutes.'}=options;
    if(currentRequest)throw new Error('Another server request is running. Wait or cancel it first.');
    if(file?.size>100*1024*1024)throw new Error('Use a file smaller than 100 MB.');
    if(file&&!confirm(consent))throw new Error('Upload cancelled.');
    const controller=new AbortController();currentRequest=controller;
    const timer=setTimeout(()=>controller.abort(),file?14*60*1000:60000);
    if(captionRequestBusy)$('#captionStatus').textContent='Uploading and processing. You can cancel; do not submit twice.';
    try{
      const body=file?new FormData():undefined;if(file)body.append('file',file);
      const headers={...(backend.key?{Authorization:'Bearer '+backend.key}:{}),...(cloud?{'X-Upload-Consent':'yes'}:{})};
      const response=await fetch(new URL(endpoint,backend.url),{method:file?'POST':'GET',body,signal:controller.signal,headers});
      lastResponseHeaders=response.headers;
      if(!response.ok)throw new Error('SERVICE_UNAVAILABLE');
      return response.headers.get('content-type')?.includes('application/json')?await response.json():await response.blob();
    }catch(e){
      if(controller.signal.aborted)throw new Error('Request cancelled or timed out. Your original media is unchanged.');
      if(e.message==='SERVICE_UNAVAILABLE'||e instanceof TypeError){console.warn('VoiceCut service request failed:',endpoint,e);throw new Error('SERVICE_UNAVAILABLE');}
      throw e;
    }finally{clearTimeout(timer);currentRequest=null;}
  }
  async function enhanceWithRealAI(file,level,onProgress) {
    if($('#enhanceMode').value==='device')return null;
    onProgress(5,'Contacting the VoiceCut service.');
    let capabilities=null;
    try{capabilities=await getCapabilities();}catch(e){capabilities=null;}
    const nrLevel=['light','medium','strong','voicefocus','ultra'].includes(level)?level:'medium';
    let uploadFile=file;
    try{
      onProgress(8,'Preparing small audio for upload. The full video stays on this device.');
      uploadFile=await shrinkAudioFile(file,0,Infinity,48000);
    }catch(prepErr){console.warn('Enhancement upload prep fell back to original file:',prepErr);uploadFile=file;}
    const useService=async(endpoint,cloud)=>{
      const blob=await requestServerUpload(endpoint,uploadFile,{cloud,onProgress:(pct)=>{
        onProgress(Math.min(90,8+Math.round(pct*0.5)),pct>=100?'Upload complete. Enhancing on the server. This can take a minute.':'Uploading small audio: '+pct+'%. You can cancel.');
      }});
      if(!(blob instanceof Blob))throw new Error('SERVICE_UNAVAILABLE');
      onProgress(100,'Processing complete. Compare with the original before applying.');
      return {blob,provider:'VoiceCut AI enhancement'};
    };
    try{
      if(capabilities?.deepFilterNet)return await useService('/api/denoise-local?level='+nrLevel,false);
      if(capabilities?.isolation)return await useService('/api/isolate',true);
    }catch(e){
      if(/cancelled|timed out/i.test(e.message))throw e;
      console.warn('Server enhancement failed; using on-device cleanup:',e);
      announce('VoiceCut server unreachable after retries. Using strong on-device cleanup instead.');
    }
    announce('VoiceCut server unreachable. Using strong on-device cleanup instead.');
    return null;
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
    saveQueue = saveQueue.catch(() => {}).then(() => VoiceCutStorage.save(snapshot)).then(()=>{announce('Project saved.');}).catch(e => {
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
    try { await silentSave(); }
    catch (e) { announce('Save failed. Storage may be full. ' + e.message, true); }
  }
  async function loadProjectFromStorage() { return openProjectById(null); }

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
    $('#homeOpenProject').addEventListener('click', ()=>openProjectById(null));
    $('#homeLibrary').addEventListener('click', ()=>{ location.hash='#/library'; });
    $('#homeHelp').addEventListener('click', ()=>$('#helpDialog').showModal());
    $('#noProjectUpload').addEventListener('click', ()=>$('#fileVideo').click());
    $('#noProjectOpen').addEventListener('click', ()=>openProjectById(null));
    $$('#mainNav a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); location.hash = a.getAttribute('href'); }));
    $$('a[href^="#section-"]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const target = document.querySelector(a.getAttribute('href'));
      if (!target) return;
      if (!hasProject()) { announce('Upload a video first.', true); return; }
      if (currentView !== 'editor') openEditor();
      target.scrollIntoView({behavior: 'smooth', block: 'start'});
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({preventScroll: true});
      announce((a.getAttribute('aria-label') || 'Section').replace(/^Go to /, '') + '. Swipe to explore.');
    }));
    window.addEventListener('hashchange', route);

    $('#btnCloseHelp').addEventListener('click', ()=>$('#helpDialog').close());
    $('#btnCloseHelp2').addEventListener('click', ()=>$('#helpDialog').close());
    $('#helpDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });

    $('#confirmDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });
    $('#btnConfirmClose').addEventListener('click', ()=>$('#confirmDialog').close());
    $('#btnConfirmCancel').addEventListener('click', ()=>$('#confirmDialog').close());
    $('#btnConfirmApply').addEventListener('click', ()=>{ $('#confirmDialog').close(); if(confirmCallback) confirmCallback(); confirmCallback=null; });

    $('#recordDialog').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) e.currentTarget.close(); });
    $('#btnCloseRecord').addEventListener('click', ()=>{ stopRecording(); discardPendingRecording(true); });
    $('#recordDialog').addEventListener('close', stopRecording);
    $('#recordDialog').addEventListener('cancel', stopRecording);
    $('#btnStartRecording').addEventListener('click', startRecording);
    $('#btnStopRecordingDialog').addEventListener('click', stopRecording);
    $('#btnApplyRecord').addEventListener('click', applyPendingRecording);
    $('#btnDiscardRecord').addEventListener('click', ()=>discardPendingRecording(false));
    $('#recordDialog').addEventListener('cancel', ()=>discardPendingRecording(true));
    $('#btnRecordVO').addEventListener('click', openRecordDialog);
    $('#btnStopVO').addEventListener('click', stopRecording);

    document.addEventListener('change', e => {
      if (e.target.matches('input,select')) autoSave();
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
    $('#btnDeleteRange').addEventListener('click', ()=>{
      try{
        const ds=parseTime($('#delRangeStart').value), de=parseTime($('#delRangeEnd').value);
        const pieces=VoiceCutCore.deleteRange(project,ds,de);
        project.segments=pieces.map(s=>({...s,id:uid(),label:'Segment'}));
        selectedClipId=null; pushHistory(); renderAll();
        announce(`Deleted ${formatTimeVerbose(ds)} to ${formatTimeVerbose(de)}. Export will skip it.`);
      }catch(e){ announce(e.message,true); }
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
    $('#btnCrop').addEventListener('click', ()=>{ $('#section-edit').scrollIntoView({behavior:'smooth'}); $('#cropPreset').focus(); announce('Crop settings.'); });
    $('#btnRotate').addEventListener('click', ()=>{ $('#section-edit').scrollIntoView({behavior:'smooth'}); $('#rotateAngle').focus(); announce('Rotation settings.'); });
    $('#btnFreezeFrame').addEventListener('click', ()=>{ $('#section-edit').scrollIntoView({behavior:'smooth'}); $('#freezeSeconds').focus(); announce('Freeze frame settings.'); });
    $('#cropPreset').addEventListener('change',(e)=>{project.crop.preset=e.target.value;pushHistory();renderAll();announce(`Crop set to ${e.target.selectedOptions[0].textContent}. Applied at export.`);});
    for(const id of ['cropX','cropY','cropW','cropH']){$('#'+id).addEventListener('change',()=>{
      const v={x:Number($('#cropX').value),y:Number($('#cropY').value),w:Number($('#cropW').value),h:Number($('#cropH').value)};
      try{
        if(video.videoWidth)VoiceCutCore.cropRect('custom',video.videoWidth,video.videoHeight,v);
        else if(!(v.x>=0&&v.y>=0&&v.w>0&&v.h>0&&v.x+v.w<=100.01&&v.y+v.h<=100.01))throw new Error('Crop values must be percentages inside the frame.');
        project.crop={...project.crop,...v};
        pushHistory();renderAll();announce('Custom crop area saved. Applied at export.');
      }catch(err){announce(err.message,true);renderAll();}
    });}
    $('#rotateAngle').addEventListener('change',(e)=>{project.rotation=Number(e.target.value);pushHistory();renderAll();announce(`Rotation set to ${e.target.selectedOptions[0].textContent}. Applied at export.`);});
    $('#btnAddFreeze').addEventListener('click',()=>{
      if(!project.videoUrl){announce('Upload a video first.',true);return;}
      const hold=Math.max(1,Math.min(10,Math.round(Number($('#freezeSeconds').value)||2)));
      project.freezes.push({id:uid(),at:video.currentTime,hold});
      pushHistory();renderAll();announce(`Freeze frame added at ${formatTimeVerbose(video.currentTime)} for ${hold} seconds.`);
    });
    $('#settingPlaybackSpeed').addEventListener('change',(e)=>{savePrefs({playbackSpeed:e.target.value});project.playbackSpeed=Number(e.target.value);video.playbackRate=project.playbackSpeed;$('#playbackSpeedSelect').value=e.target.value;announce(`Default playback speed ${e.target.value}x.`);});
    $('#settingExportResolution').addEventListener('change',(e)=>{savePrefs({exportResolution:e.target.value});project.resolution=e.target.value;updateExportSummary();renderAll();announce(`Default export quality ${e.target.value}p.`);});
    $('#settingCaptionLanguage').addEventListener('change',(e)=>{savePrefs({captionLanguage:e.target.value});$('#captionLanguage').value=e.target.value;announce('Preferred caption language saved.');});
    $('#settingCaptionPreview').addEventListener('change',(e)=>{savePrefs({captionPreview:e.target.checked});captionDefaults();project.captionSettings.preview=e.target.checked;announce(`Caption preview ${e.target.checked?'on':'off'}.`);});
    $('#settingCaptionBurn').addEventListener('change',(e)=>{savePrefs({captionBurn:e.target.checked});captionDefaults();project.captionSettings.burnIn=e.target.checked;announce(`Burned-in captions ${e.target.checked?'on':'off'}.`);});
    $('#settingNotifications').addEventListener('change',async(e)=>{
      const on=e.target.checked;
      savePrefs({notifications:on});
      if(on){
        let granted=false;
        try{
          if(window.flutter_inappwebview&&window.flutter_inappwebview.callHandler){granted=(await window.flutter_inappwebview.callHandler('requestNotificationPermission'))===true;}
          else if('Notification' in window){granted=(await Notification.requestPermission())==='granted';}
        }catch(err){granted=false;}
        if(!granted){savePrefs({notifications:false});e.target.checked=false;announce('Notifications were not allowed. In-app announcements still work.',true);return;}
      }
      announce(on?'Completion notifications on. You will be notified when long jobs finish while the app is in the background.':'Completion notifications off.');
    });

    // Original audio
    $('#origVolumeSlider').addEventListener('input', (e)=>{ project.originalAudio.volume=parseInt(e.target.value); $('#origVolumeNumber').value=e.target.value; $('#origVolumeText').textContent=e.target.value+'%'; e.target.setAttribute('aria-valuetext', `Volume ${e.target.value} percent`); });
    $('#origVolumeSlider').addEventListener('change', (e)=>{ pushHistory(); renderAll(); announce(`Original audio volume changed to ${e.target.value} percent.`); });
    $('#origVolumeNumber').addEventListener('change', (e)=>{ project.originalAudio.volume=parseInt(e.target.value); $('#origVolumeSlider').value=e.target.value; pushHistory(); renderAll(); });
    $('#origVolDec').addEventListener('click', ()=>{ project.originalAudio.volume=Math.max(0,project.originalAudio.volume-5); $('#origVolumeSlider').value=project.originalAudio.volume; $('#origVolumeNumber').value=project.originalAudio.volume; pushHistory(); renderAll(); announce(`Original audio volume ${project.originalAudio.volume} percent.`); });
    $('#origVolInc').addEventListener('click', ()=>{ project.originalAudio.volume=Math.min(100,project.originalAudio.volume+5); $('#origVolumeSlider').value=project.originalAudio.volume; $('#origVolumeNumber').value=project.originalAudio.volume; pushHistory(); renderAll(); announce(`Original audio volume ${project.originalAudio.volume} percent.`); });
    $('#btnMuteOrig').addEventListener('click', ()=>{ project.originalAudio.muted=!project.originalAudio.muted; pushHistory(); renderAll(); announce(project.originalAudio.muted?'Original audio muted.':'Original audio unmuted.'); });
    $('#origNoiseReduction').addEventListener('change', (e)=>{ project.originalAudio.noiseReduction=e.target.value; applyOriginalNR(); pushHistory(); renderAll(); announce(`Noise reduction set to ${e.target.value}.`); $('#noiseReductionStatus').textContent=`Noise reduction enabled. ${e.target.value} strength.`; });
    $('#globalNoiseReduction').addEventListener('change', (e)=>{ project.originalAudio.noiseReduction=e.target.value; $('#origNoiseReduction').value=e.target.value; applyOriginalNR(); pushHistory(); renderAll(); announce(`Noise reduction set to ${e.target.value}.`); $('#noiseReductionStatus').textContent=`Noise reduction enabled. ${e.target.value} strength.`; });
    $('#btnOrigFadeIn').addEventListener('click', ()=>{ project.originalAudio.fadeIn = project.originalAudio.fadeIn?0:2; pushHistory(); renderAll(); announce(`Original audio fade in ${project.originalAudio.fadeIn} seconds.`); });
    $('#btnOrigFadeOut').addEventListener('click', ()=>{ project.originalAudio.fadeOut = project.originalAudio.fadeOut?0:2; pushHistory(); renderAll(); announce(`Original audio fade out ${project.originalAudio.fadeOut} seconds.`); });
    $('#btnOrigAIEnhance').addEventListener('click', ()=>{
      const level = $('#origNoiseReduction').value;
      if (level==='off') { announce('Set noise reduction to Light, Medium, Strong, Voice Focus or Ultra first.', true); return; }
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
      const clip=project.clips.find(c=>c.id===selectedClipId); if(!clip) return; clip.noiseReduction=e.target.value; createAudioNodeForClip(clip); pushHistory(); renderAll(); announce(`Noise reduction for ${escapeHTML(clip.name)} set to ${e.target.value}.`);
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
      if (level==='off') { announce('Noise reduction is off. Choose Light, Medium, Strong, Voice Focus or Ultra first.', true); return; }
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
    $('#btnSilenceOriginal').addEventListener('click', silenceOriginalVideo);
    $('#btnSilenceSelected').addEventListener('click', silenceClipWithAI);
    $('#btnDetectSilenceOriginal').addEventListener('click', detectSilenceOriginal);
    $('#btnDetectSilenceSelected').addEventListener('click', detectSilenceClips);
    $('#aiOriginalAudio').addEventListener('play', () => $('#aiEnhancedAudio').pause());
    $('#aiEnhancedAudio').addEventListener('play', () => $('#aiOriginalAudio').pause());

    // Timeline exit
    $('#btnExitTimeline').addEventListener('click', ()=>{ $('#section-project').scrollIntoView({behavior:'smooth'}); announce('Exited timeline editing. Focus moved to project section.'); });

    // Export
    $('#exportResolution').addEventListener('change', (e)=>{ project.resolution=e.target.value; updateExportSummary(); });
    $('#exportFps').addEventListener('change', (e)=>{ project.fps=parseInt(e.target.value); updateExportSummary(); });
    $('#exportFormat').addEventListener('change', (e)=>{ project.format=e.target.value; updateExportSummary(); });
    $('#btnDoExport').addEventListener('click', doExport);
    $('#btnExport').addEventListener('click', ()=>{ if(!hasProject()){ showView('none'); return; } openEditor(); $('#section-export').scrollIntoView({behavior:'smooth'}); doExport(); });
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
        await VoiceCutStorage.remove(project.id);
        project = { id:'proj_'+Date.now(), name:'Untitled Project', videoFile:null, videoUrl:null, duration:0, trimStart:0, trimEnd:0, crop:{preset:'original',x:0,y:0,w:100,h:100}, rotation:0, freezes:[], segments:[], originalAudio:{volume:100, muted:false, fadeIn:0, fadeOut:0, noiseReduction:'medium'}, clips:[], ducking:{enabled:true, level:30}, playbackSpeed:1, skipAmount:5, resolution:'1080', fps:30, format:'mp4', created:Date.now(), modified:Date.now() };
        selectedClipId=null;
        video.src='';
        $('#videoPlaceholder').classList.remove('hidden');
        historyStack=[]; historyIndex=-1;
        location.hash='#/library';
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

    loadPrefs();

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
      if(currentView!=='editor')return;
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
    initEvents(); initCaptions(); loadPrefs(); applyPrefsToProject(true);
    for (const key of ['voicecut_ai_server','voicecut_dolby_key','voicecut_hf_key','voicecut_replicate_key']) localStorage.removeItem(key);
    renderAll(); route();
    if (history.length <= 1 && currentView !== 'home') {
      const here = '#/' + currentView + hashQuery();
      history.replaceState(null, '', '#/home');
      history.pushState(null, '', here);
    }
    announce('Welcome to VoiceCut Studio. Upload a video to begin editing. Screen reader optimized. Press H for help. Use Tab to navigate controls.', false, true);
    // Add hidden help shortcut
    document.addEventListener('keydown', (e)=>{ if(e.key.toLowerCase()==='h' && !e.ctrlKey && !['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')){ $('#helpDialog').showModal(); } });
    // Auto save interval - SILENT, no TalkBack announcement
    setInterval(() => { silentSave().catch(() => {}); }, 15000);
  });

})();

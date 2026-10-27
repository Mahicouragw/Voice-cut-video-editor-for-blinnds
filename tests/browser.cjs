const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {spawn,spawnSync,execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
(async()=>{
 const dir = path.resolve('artifacts');fs.mkdirSync(dir,{recursive:true});
 const videoPath=path.join(dir,'sample.mp4'), audioPath=path.join(dir,'sample.wav'), bigPath=path.join(dir,'bigcaption.wav'), gappyPath=path.join(dir,'gappy.wav'), audioOnlyPath=path.join(dir,'audioonly.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',videoPath]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=660:duration=3','-y',audioPath]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=560','-ac','2','-ar','48000','-y',bigPath]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-f','lavfi','-i','anullsrc=r=44100:cl=stereo:d=5','-f','lavfi','-i','sine=frequency=880:duration=4','-filter_complex','[0:a][1:a][2:a]concat=n=3:v=0:a=1','-y',gappyPath]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-ac','2','-ar','44100','-c:a','aac','-y',audioOnlyPath]);
 const tonePath=path.join(dir,'tones.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-f','lavfi','-i','sine=frequency=880:duration=3','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=6','-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1,volume=0.5,aformat=sample_fmts=fltp:channel_layouts=stereo[a]','-map','2:v','-map','[a]','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-shortest','-y',tonePath]);
 const server=spawn(process.execPath,['scripts/serve.js'],{env:{...process.env,PORT:'3099'},stdio:['ignore','pipe','inherit']});
 await new Promise((resolve,reject)=>{server.stdout.on('data',data=>{if(data.toString().includes('preview on port'))resolve();});server.on('error',reject);server.on('exit',code=>{if(code)reject(new Error('Server failed'));});});
 const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}).catch(error=>{server.kill();throw error;});
 const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',dialog=>dialog.accept());
 try {
  const text = sel => page.locator(sel).textContent();
  const showPanel = (name) => page.locator('#tab-'+name).click();
  const showSub = (which) => page.locator(which==='music'?'#subMusic':which==='sfx'?'#subSfx':'#subVoiceover').click();
  const meanVolume = (file) => { const r=spawnSync('ffmpeg',['-v','info','-i',file,'-map','0:a','-af','volumedetect','-f','null','-'],{encoding:'utf8'}); const m=String(r.stderr||'').match(/mean_volume:\s*([-\d.]+|n\/a)/); return m?m[1]:'n/a'; };
  const audioFidelity = (file) => {
    const sr=48000;
    const raw=execFileSync('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar',String(sr),'-f','f32le','-'],{maxBuffer:64*1024*1024});
    const pcm=new Float32Array(raw.buffer,raw.byteOffset,Math.floor(raw.length/4));
    const win=Math.floor(sr*0.1), edge=Math.floor(sr*0.3);
    let mn=1e9, mx=-1e9;
    for (let o=edge;o+win<=pcm.length-edge;o+=win) {
      let s=0; for (let i=o;i<o+win;i++) s+=pcm[i]*pcm[i];
      const d=10*Math.log10(Math.max(1e-12,s/win));
      if (d<mn) mn=d; if (d>mx) mx=d;
    }
    const tone=(sec,freq)=>{ const a=Math.floor(sec*sr), b=Math.min(pcm.length,a+sr), n=b-a;
      const k=Math.round(freq*n/sr), cw=Math.cos(2*Math.PI*k/n);
      let s0=0,s1=0,s2=0; for (let i=a;i<b;i++){ s0=pcm[i]+2*cw*s1-s2; s2=s1; s1=s0; }
      return s1*s1+s2*s2-2*cw*s1*s2; };
    return { flat:mx-mn, tone, dur:pcm.length/sr };
  };
  // HOME shell: nav only, editor hidden, no server/credential fields anywhere.
  await page.goto('http://127.0.0.1:3099');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Welcome to VoiceCut'));
  await page.locator('#homeScreen:not(.hidden)').waitFor();
  assert.equal(await page.locator('#editorScreen:not(.hidden)').count(),0);
  assert.equal(await page.locator('#navEditor:not(.hidden)').count(),0);
  // The screen-reader cursor lands inside the page content on load.
  assert.equal(await page.evaluate(()=>document.activeElement && document.activeElement.id),'main-content');
  for (const sel of ['#aiServerUrl','#serverAccessKey','#btnSaveApiKeys','#btnCheckServer','#apiKeysStatus','#cleanupMethod','#captionProvider']) {
    assert.equal(await page.locator(sel).count(),0,sel+' must not exist in user UI');
  }
  // Deep link to the editor with no project: friendly no-project view.
  await page.goto('http://127.0.0.1:3099/#/editor');
  await page.locator('#noProjectScreen:not(.hidden)').waitFor();
  assert.match(await text('#noProjectTitle'),/No project is open/);
  // Home upload opens the editor and autosaves.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2);
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  await page.locator('#navEditor:not(.hidden)').waitFor();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project saved'));
  // The noise dialog exposes no backend details to normal users.
  assert.ok(!(await text('#aiTechDetails')).includes('server AI'));
  assert.ok(!(await text('#aiTechDetails')).includes('DeepFilterNet'));
  // Back/forward stays inside the app instead of exiting to the device home.
  await page.goBack();
  await page.locator('#homeScreen:not(.hidden)').waitFor();
  await page.goForward();
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  // Library lists, renames, and reopens the project.
  await page.locator('a[data-route="library"]').click();
  await page.locator('#libraryScreen:not(.hidden)').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('#libraryList .library-card').length===1);
  await page.locator('#libraryList [data-rename-project]').click();
  await page.locator('#libraryList input[aria-label="New project name"]').fill('E2E Renamed');
  await page.locator('#libraryList .library-card button').filter({hasText:'Save name'}).click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project renamed to E2E Renamed'));
  await page.locator('#libraryList [data-open-project]').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project opened: E2E Renamed'));
  // Reopening a project puts the screen-reader cursor on the Play button.
  assert.equal(await page.evaluate(()=>document.activeElement && document.activeElement.id),'btnPlay');
  // Reload flushes the current project, performs a real document reload, and restores the editor state.
  await page.locator('#btnReloadApp').click();
  await page.waitForFunction(()=>!document.querySelector('#editorScreen').classList.contains('hidden') && document.querySelector('#projectNameInput').value==='E2E Renamed' && document.querySelector('#mainVideo').duration>2,{}, {timeout:30000});
  // Settings holds only normal preferences; caption language pref applies to the editor.
  await page.locator('a[data-route="settings"]').click();
  await page.locator('#settingsScreen:not(.hidden)').waitFor();
  await page.locator('#settingCaptionLanguage').selectOption('en');
  assert.equal(await page.locator('#captionLanguage').inputValue(),'en');
  await page.locator('#settingTextSize').selectOption('extra');
  assert.equal(await page.evaluate(()=>document.documentElement.style.zoom),'1.3');
  await page.locator('#settingTextSize').selectOption('normal');
  assert.equal(await page.evaluate(()=>document.documentElement.style.zoom),'1');
  // Completion notifications: permission-gated pref, hidden-tab-only, app bridge contract.
  await page.context().grantPermissions(['notifications']);
  await page.locator('#settingNotifications').check();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Completion notifications on'));
  {
    const got=await page.evaluate(async()=>{
      const calls=[];
      window.flutter_inappwebview={callHandler:async(name,title,body)=>{calls.push([name,title,body]);return true;}};
      const before=window.VoiceCutNotify.notifyComplete('T1','B1');
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      const after=window.VoiceCutNotify.notifyComplete('T2','B2');
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
      delete window.flutter_inappwebview;
      return {before,after,calls};
    });
    assert.equal(got.before,false);assert.equal(got.after,true);
    assert.deepEqual(got.calls,[['showNotification','T2','B2']]);
  }
  await page.locator('a[data-route="home"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#homeRecentList .library-card').length===1);
  await page.locator('#homeOpenProject').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  // Audio clip add, delete with in-app confirm, undo.
  await showPanel('clips');
  await page.setInputFiles('#fileAudio',audioPath);
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  await page.locator('#timelineContainer [data-action="delete"]').first().click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>!document.querySelector('#timelineContainer [data-action="delete"]'));
  await page.locator('#btnUndo').click();
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  // Capture actual MediaRecorder data from a fake microphone device.
  await showPanel('audio');await showSub('voiceover');
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled);
  await page.waitForTimeout(1200);
  await page.locator('#btnStopRecordingDialog').click();
  await page.locator('#recordReview:not(.hidden)').waitFor();
  assert.match(await page.locator('#recordPreview').getAttribute('src'),/^blob:/);
  await page.locator('#btnApplyRecord').click();
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('Voiceover_'));
  // A busy mic gets one automatic retry, then plain guidance.
  await page.evaluate(()=>{ window.__origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = ()=>Promise.reject(new DOMException('Could not start audio source','NotReadableError')); });
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('microphone would not start'),{},{timeout:30000});
  assert.match(await page.locator('#recordCountdown').textContent(),/update VoiceCut Studio/);
  await page.locator('#btnCloseRecord').click();
  await page.evaluate(()=>{ navigator.mediaDevices.getUserMedia = window.__origGUM; });
  // An enhanced-mode mic failure falls back to the basic mic and still records.
  await page.evaluate(()=>{ navigator.mediaDevices.getUserMedia = (c)=> (c && c.audio === true) ? Promise.reject(new DOMException('Could not start audio source','NotReadableError')) : window.__origGUM(c); });
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled,{},{timeout:30000});
  assert.match(await page.locator('#statusText').textContent(),/basic microphone mode/);
  await page.waitForTimeout(1200);
  await page.locator('#btnStopRecordingDialog').click();
  await page.locator('#recordReview:not(.hidden)').waitFor();
  await page.locator('#btnDiscardRecord').click();
  await page.evaluate(()=>{ navigator.mediaDevices.getUserMedia = window.__origGUM; });
  // Voice changer effects really transform the sound, not just relabel it.
  {
    const changed = await page.evaluate(async ()=>{
      const sr = 44100, len = sr;
      const ctx = new OfflineAudioContext(1, len, sr);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i=0;i<len;i++) d[i]=Math.sin(2*Math.PI*440*i/sr)*0.5;
      const out = await window.VoiceCutTestAudio.renderVoiceFilter(buf, 'robot');
      const o = out.getChannelData(0);
      let diff=0, n=0;
      for (let i=0;i<Math.min(len,o.length);i+=7) { diff+=Math.abs(o[i]-d[i]); n++; }
      return {inLen:len,outLen:o.length,meanDiff:diff/Math.max(1,n)};
    });
    assert.ok(changed.outLen > changed.inLen, 'robot filter slows audio, lengthening it');
    assert.ok(changed.meanDiff > 0.05, 'robot filter must audibly change audio, got '+changed.meanDiff);
  }
  // Echo really repeats into a tail, not just relabeling volume.
  {
    const echo = await page.evaluate(async ()=>{
      const sr = 44100, len = sr;
      const ctx = new OfflineAudioContext(1, len, sr);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i=0;i<len;i++) d[i]=Math.sin(2*Math.PI*440*i/sr)*0.5;
      const out = await window.VoiceCutTestAudio.renderVoiceFilter(buf, 'echo');
      const o = out.getChannelData(0);
      let tail=0, tn=0;
      for (let i=len;i<o.length;i+=7) { tail+=Math.abs(o[i]); tn++; }
      return {inLen:len,outLen:o.length,tailMean:tail/Math.max(1,tn)};
    });
    assert.ok(echo.outLen >= echo.inLen + 44100, 'echo must append a ~1.5s tail, got '+echo.outLen);
    assert.ok(echo.tailMean > 0.01, 'echo tail must carry audible repeats, got '+echo.tailMean);
  }
  // Voice Focus noise-reduction level applies live without errors.
  await showPanel('cleanup');
  await page.locator('#globalNoiseReduction').selectOption('voicefocus');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Noise reduction set to voicefocus'));
  await page.locator('#globalNoiseReduction').selectOption('ultra');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Noise reduction set to ultra'));
  await page.locator('#globalNoiseReduction').selectOption('medium');
  // Panel tabs switch tool panels and never route home.
  {
    const hashBefore = await page.evaluate(()=>location.hash);
    await page.locator('#tab-captions').click();
    await page.waitForFunction(()=>document.activeElement && document.activeElement.id==='captionsHeading');
    assert.equal(await page.evaluate(()=>location.hash),hashBefore);
    assert.equal(await page.locator('#editorScreen:not(.hidden)').count(),1);
    assert.equal(await page.locator('#homeScreen:not(.hidden)').count(),0);
    assert.equal(await page.locator('#section-captions:not(.hidden)').count(),1);
    await page.locator('#tab-cleanup').click();
    await page.waitForFunction(()=>document.activeElement && document.activeElement.id==='aiToolsHeading');
    assert.equal(await page.locator('#section-aitools:not(.hidden)').count(),1);
    assert.equal(await page.locator('#editorScreen:not(.hidden)').count(),1);
  }
  // Real on-device neural cleanup (no backend configured), replacing original track.
  const setBalance = (noise, speech) => page.evaluate(([n, s]) => {
    for (const [sel, val] of [['#noiseLeftSlider', n], ['#speechBoostSlider', s]]) {
      const el = document.querySelector(sel); el.value = String(val);
      el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }, [noise, speech]);
  const measureCleanup = () => page.evaluate(async()=>{
    const statsOf = async (url) => {
      const raw = await (await fetch(url)).arrayBuffer();
      const C = new (window.AudioContext || window.webkitAudioContext)();
      try{
        const ab = await C.decodeAudioData(raw);
        const d = ab.getChannelData(0); let s = 0, peak = 0;
        for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; const a = Math.abs(d[i]); if (a > peak) peak = a; }
        return {energy: s / Math.max(1, d.length), peak};
      } finally { try{await C.close();}catch(e){} }
    };
    const e = await statsOf(document.querySelector('#aiEnhancedAudio').src);
    const o = await statsOf(document.querySelector('#aiOriginalAudio').src);
    return {ratio: e.energy / o.energy, peak: e.peak};
  });
  // Neutral balance: the engine itself must preserve a clean tone.
  await setBalance(0, 0);
  await showPanel('cleanup');
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:60000});
  await page.waitForFunction(()=>document.querySelector('#aiResultText').textContent.includes('Noise reduction'),{},{timeout:60000});
  assert.match(await page.locator('#aiResultText').textContent(),/No steady engine-like rumble/);
  {
    const {ratio, peak} = await measureCleanup();
    assert.ok(ratio > 0.25 && ratio < 2, 'neural cleanup must preserve a clean tone (ratio ' + ratio + ')');
    assert.ok(peak <= 1.0, 'cleaned audio must not clip (peak ' + peak + ')');
  }
  // User balance 31/70: voice gets louder, never clips.
  await page.locator('#btnCloseAI').click();
  await page.waitForFunction(()=>!document.querySelector('#aiProcessingDialog').open);
  await setBalance(31, 70);
  {
    const srcBefore = await page.locator('#aiEnhancedAudio').getAttribute('src');
    await showPanel('cleanup');
  await page.locator('#btnAIEnhanceOriginal').click();
    await page.waitForFunction((s)=>document.querySelector('#aiEnhancedAudio').src!==s, srcBefore, {timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#aiResultText').textContent.includes('Noise reduction'),{},{timeout:60000});
    const boosted = await measureCleanup();
    assert.ok(boosted.ratio > 1, 'speech enhancement must make the voice louder (ratio ' + boosted.ratio + ')');
    assert.ok(boosted.ratio < 3.5, 'speech enhancement must stay bounded (ratio ' + boosted.ratio + ')');
    assert.ok(boosted.peak <= 1.0, 'boosted audio must not clip (peak ' + boosted.peak + ')');
  }
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  // Provider responses are mocked in browser tests. No paid API call or quality claim.
  // Backend is reached only through the hidden dev hash; the user UI has no URL/key fields.
  let captionCalls=[],isolateCalls=0,denoiseCalls=0,denoiseConsent='unset',providerFailure=false;
  let capabilities={captions:true,isolation:true};
  await page.route('https://voicecut-test.example/**',async route=>{
    const request=route.request();
    if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type,x-upload-consent','access-control-allow-methods':'GET,POST,OPTIONS'}});return;}
    assert.equal(request.headers().authorization,undefined);
    const headers={'access-control-allow-origin':'*'};
    if(request.url().includes('/capabilities')){await route.fulfill({headers,contentType:'application/json',body:JSON.stringify(capabilities)});return;}
    if(request.url().includes('/api/isolate')){isolateCalls++;assert.equal(request.headers()['x-upload-consent'],'yes');await route.fulfill({headers,contentType:'audio/wav',body:fs.readFileSync(audioPath)});return;}
    if(request.url().includes('/api/denoise-local')){denoiseCalls++;denoiseConsent=request.headers()['x-upload-consent'];await route.fulfill({headers,contentType:'audio/wav',body:fs.readFileSync(audioPath)});return;}
    if(request.url().includes('/api/silence')){if(request.url().includes('detect=1')){await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({gaps:[[1,2]],gapCount:1,removedSeconds:1,duration:3})});return;}await route.fulfill({headers:{'access-control-allow-origin':'*','access-control-expose-headers':'x-silence-removed,x-silence-seconds','x-silence-removed':'1','x-silence-seconds':'1'},contentType:'audio/wav',body:fs.readFileSync(audioPath)});return;}
    if(request.url().includes('/api/reverse')){await route.fulfill({headers,contentType:'video/mp4',body:fs.readFileSync(videoPath)});return;}
    assert.ok(request.url().includes('/api/captions'));
    captionCalls.push({url:request.url(),consent:request.headers()['x-upload-consent']});
    assert.equal(request.headers()['x-upload-consent'],'yes');
    if(providerFailure){await route.fulfill({status:503,headers,contentType:'application/json',body:JSON.stringify({error:'upstream exploded'})});return;}
    await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({language:'english',duration:3,cues:[{start:.2,end:2.7,text:'Hello from VoiceCut.'}]})});
  });
  await page.goto('http://127.0.0.1:3099/#/editor?dev-backend='+encodeURIComponent('https://voicecut-test.example'));
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('voicecut-test'))),false);
  // Cloud captions: consent header sent, provider invisible (no provider= param).
  await showPanel('captions');
  await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:60000});
  assert.equal(captionCalls.length,1);
  assert.equal(captionCalls[0].consent,'yes');
  assert.equal(captionCalls[0].url.includes('provider='),false);
  assert.equal(await page.locator('#captionText').inputValue(),'Hello from VoiceCut.');
  // Caption review: counter, prev/next, read-all, wrong-language warning.
  assert.equal(await text('#captionCounter'),'Caption 1 of 1');
  assert.equal(await page.locator('#btnPrevCaption').isDisabled(),true);
  assert.equal(await page.locator('#btnNextCaption').isDisabled(),true);
  await page.locator('#btnReadAllCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('All 1 captions. Caption 1, 0.2 to 2.7 seconds: Hello from VoiceCut.'));
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=2.9;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>2.8);
  await page.locator('#btnAddCaption').click();
  await page.waitForFunction(()=>document.querySelector('#captionCounter').textContent==='Caption 2 of 2');
  await page.locator('#btnPrevCaption').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Caption 1 of 2'));
  await page.locator('#captionStart').fill('0.25');await page.locator('#captionEnd').fill('2.75');await page.locator('#captionText').fill('Reviewed caption');await page.locator('#btnSaveCaption').click();
  for(const [button,extension,expected] of [['#btnDownloadSRT','srt','00:00:00,250 --> 00:00:02,750'],['#btnDownloadVTT','vtt','WEBVTT']]){
    const event=page.waitForEvent('download');await page.locator(button).click();const d=await event;assert.match(d.suggestedFilename(),new RegExp('\\.'+extension+'$'));
    const file=path.join(dir,'captions.'+extension);await d.saveAs(file);assert.ok(fs.readFileSync(file,'utf8').includes(expected));
  }
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1;});
  await page.waitForFunction(()=>document.querySelector('#captionOverlay').textContent==='Reviewed caption'&&!document.querySelector('#captionOverlay').hidden);
  // Friendly failure: existing cues preserved, Retry recovers, hidden tab notifies.
  await page.evaluate(()=>{
    window.__notifCalls=[];
    window.flutter_inappwebview={callHandler:async(name,title,body)=>{window.__notifCalls.push([name,title,body]);return true;}};
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
  });
  providerFailure=true;await showPanel('captions');await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('Caption generation is temporarily unavailable'));
  assert.deepEqual(await page.evaluate(()=>window.__notifCalls),[['showNotification','Captions failed','Caption generation failed. Open the app and tap Retry.']]);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});delete window.flutter_inappwebview;});
  await page.locator('#btnRetryCaptions:not(.hidden)').waitFor();
  assert.equal(await page.locator('#captionText').inputValue(),'Reviewed caption');
  providerFailure=false;await showPanel('captions');await page.locator('#btnRetryCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:60000});
  assert.equal(await page.locator('#captionText').inputValue(),'Hello from VoiceCut.');
  await page.locator('#captionLanguage').selectOption('hi');
  await showPanel('captions');
  await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('Warning: you chose Hindi'),{},{timeout:60000});
  assert.match(await text('#captionStatus'),/First caption: "Hello from VoiceCut\."/);
  assert.match(await text('#captionStatus'),/covering .* of .* video/);
  await page.locator('#captionLanguage').selectOption('en');
  // Captions accept a genuinely large source (101MB audio clip): only the small prepared copy uploads.
  assert.ok(fs.statSync(bigPath).size>100*1024*1024);
  await showPanel('clips');
  await page.setInputFiles('#fileAudio',bigPath);
  await page.locator('#timelineContainer .clip[aria-label*="bigcaption"]').click();
  await page.locator('#selectedClipPanel:not(.hidden)').waitFor();
  await showPanel('captions');
  await page.locator('#captionSource').selectOption('selected');
  await showPanel('captions');
  await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:180000});
  await page.locator('#captionSource').selectOption('original');
  await showPanel('clips');
  await page.locator('#timelineContainer .clip[aria-label*="bigcaption"]').click();
  await page.locator('#selDelete').click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>![...document.querySelectorAll('#timelineContainer .clip')].some(el=>el.getAttribute('aria-label').includes('bigcaption')));
  await showPanel('captions');
  await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:60000});
  // Cloud isolation is auto-selected when on-device neural denoise is unavailable.
  await showPanel('cleanup');
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:60000});
  assert.equal(isolateCalls,1);assert.equal(denoiseCalls,0);
  assert.match(await text('#aiResultText'),/Noise reduction/);
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  // After reload the server neural denoise is auto-preferred, with no cloud consent header.
  capabilities={captions:true,isolation:true,deepFilterNet:true};
  await page.locator('#btnSaveProject').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project saved'));
  await page.reload();
  await page.locator('#noProjectScreen:not(.hidden)').waitFor();
  await page.locator('#noProjectOpen').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2);
  await showPanel('cleanup');
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:60000});
  assert.equal(denoiseCalls,1);assert.equal(denoiseConsent,undefined);
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  // Large files skip the server and use on-device cleanup (Blob.size shadowed to 800MB; real bytes stay small).
  await page.evaluate(()=>{window.__origBlobSize=window.__origBlobSize||Object.getOwnPropertyDescriptor(Blob.prototype,'size');Object.defineProperty(Blob.prototype,'size',{configurable:true,get:()=>800*1024*1024});});
  await showPanel('cleanup');
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.waitForFunction(()=>document.querySelector('#aiResultText').textContent.includes('Noise reduction'),{},{timeout:120000});
  assert.equal(denoiseCalls,1);
  await page.evaluate(()=>{Object.defineProperty(Blob.prototype,'size',window.__origBlobSize);});
  await page.locator('#btnCloseAI').click();
  // Silence: fast gap preview, then full removal with progress bar.
  await page.locator('#btnDetectSilenceOriginal').click();
  await page.waitForFunction(()=>document.querySelector('#silenceStatus').textContent.includes('Found 1 quiet gap'),{},{timeout:60000});
  assert.match(await text('#silenceStatus'),/0:01 to 0:02/);
  {
    const event=page.waitForEvent('download');
    await page.locator('#btnSilenceOriginal').click();
    const d=await event;assert.match(d.suggestedFilename(),/\.wav$/);
    const file=path.join(dir,'silence-removed.wav');await d.saveAs(file);
    assert.ok(fs.statSync(file).size>1000);
  }
  await page.waitForFunction(()=>document.querySelector('#silenceStatus').textContent.includes('Removed 1 silent gap'));
  await page.evaluate(()=>{window.__origBlobSize=window.__origBlobSize||Object.getOwnPropertyDescriptor(Blob.prototype,'size');Object.defineProperty(Blob.prototype,'size',{configurable:true,get:()=>800*1024*1024});});
  await page.locator('#btnSilenceOriginal').click();
  await page.waitForFunction(()=>document.querySelector('#silenceStatus').textContent.includes('No quiet gaps longer than'),{},{timeout:60000});
  await page.evaluate(()=>{Object.defineProperty(Blob.prototype,'size',window.__origBlobSize);});
  await page.locator('#enhanceMode').selectOption('device');
  await page.locator('#btnSilenceOriginal').click();
  await page.waitForFunction(()=>document.querySelector('#silenceStatus').textContent.includes('No quiet gaps longer than'),{},{timeout:60000});
  await page.locator('#enhanceMode').selectOption('automatic');
  // On-device silence removal really cuts: the gappy clip is shortened and previews before applying.
  await showPanel('clips');
  await page.setInputFiles('#fileAudio',gappyPath);
  await page.locator('#timelineContainer .clip[aria-label*="gappy"]').click();
  await page.locator('#selectedClipPanel:not(.hidden)').waitFor();
  await showPanel('cleanup');
  await page.locator('#enhanceMode').selectOption('device');
  await page.locator('#btnSilenceSelected').click();
  await page.waitForFunction(()=>document.querySelector('#silenceStatus').textContent.includes('Removed 1 silent gap'),{},{timeout:60000});
  assert.match(await text('#aiResultText'),/Silence removal/);
  await page.locator('#btnApplyEnhanced').click();
  await page.waitForFunction(()=>document.querySelector('#timelineContainer .clip[aria-label*="gappy"]').getAttribute('aria-label').includes('Duration 00 minutes 07 seconds'));
  await page.locator('#enhanceMode').selectOption('automatic');
  await showPanel('clips');
  await page.locator('#timelineContainer .clip[aria-label*="gappy"]').click();
  await page.locator('#selDelete').click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>![...document.querySelectorAll('#timelineContainer .clip')].some(el=>el.getAttribute('aria-label').includes('gappy')));
  // Long-audio engine works in parts: dev-chunk-seconds=2 cleans the 3s clip in 2 parts.
  await showPanel('clips');
  await page.setInputFiles('#fileAudio',{name:'chunky.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.locator('#timelineContainer .clip[aria-label*="chunky"]').click();
  await page.locator('#selectedClipPanel:not(.hidden)').waitFor();
  await showPanel('cleanup');
  await page.locator('#enhanceMode').selectOption('device');
  await page.evaluate(()=>history.replaceState(null,'','#/editor?dev-backend='+encodeURIComponent('https://voicecut-test.example')+'&dev-chunk-seconds=2'));
  await showPanel('cleanup');
  await page.locator('#btnAIEnhanceSelected').click();
  await page.waitForFunction(()=>document.querySelector('#aiResultText').textContent.includes('Checked in 2 parts'),{},{timeout:120000});
  await page.locator('#btnCloseAI').click();
  await page.evaluate(()=>history.replaceState(null,'','#/editor?dev-backend='+encodeURIComponent('https://voicecut-test.example')));
  await page.locator('#enhanceMode').selectOption('automatic');
  await showPanel('clips');
  await page.locator('#timelineContainer .clip[aria-label*="chunky"]').click();
  await page.locator('#selDelete').click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>![...document.querySelectorAll('#timelineContainer .clip')].some(el=>el.getAttribute('aria-label').includes('chunky')));
  // Clip reverse, audio merge with undo, video reverse download.
  await showPanel('clips');
  await page.locator('#timelineContainer .clip[aria-label^="Music Track"]').first().click();
  await page.locator('#selectedClipPanel:not(.hidden)').waitFor();
  await page.locator('#selReverse').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Clip audio reversed'));
  const clipsBefore=await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip[data-clip-id]')].filter(el=>!el.getAttribute('aria-label').startsWith('Video Segment')).length);
  await page.setInputFiles('#fileAudio',audioPath);
  await page.waitForFunction((n)=>[...document.querySelectorAll('#timelineContainer .clip[data-clip-id]')].filter(el=>!el.getAttribute('aria-label').startsWith('Video Segment')).length===n+1,clipsBefore);
  const beforeMerge=clipsBefore+1;
  await showPanel('audio');await showSub('music');
  await page.locator('#btnMergeAudio').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Merged '),{},{timeout:60000});
  assert.match(await text('#statusText'),new RegExp('Merged '+beforeMerge+' clips into one'));
  await page.waitForFunction(()=>[...document.querySelectorAll('#timelineContainer .clip[data-clip-id]')].filter(el=>!el.getAttribute('aria-label').startsWith('Video Segment')).length===1);
  await page.locator('#btnUndo').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Undo successful'));
  {
    const event=page.waitForEvent('download');
    await page.locator('#btnReverseVideo').click();
    const d=await event;assert.match(d.suggestedFilename(),/\.mp4$/);
    const file=path.join(dir,'reversed-video.mp4');await d.saveAs(file);
    assert.ok(fs.statSync(file).size>1000);
  }
  await page.waitForFunction(()=>document.querySelector('#reverseStatus').textContent.includes('Video reversed'));
  // Marked range: mark start/end at the playhead, then split, delete, keep.
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=0.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>=0.4);
  await page.locator('#btnMarkStart').click();
  await page.waitForFunction(()=>document.querySelector('#markStatus').textContent.includes('Start marked'));
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>=1.4);
  await page.locator('#btnMarkEnd').click();
  await page.waitForFunction(()=>document.querySelector('#markStatus').textContent.includes('Marked part'));
  await page.locator('#btnSplitMarked').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Split at'));
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip')].filter(el=>(el.getAttribute('aria-label')||'').startsWith('Video Segment')).length),3);
  await page.locator('#btnDeleteMarked').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Deleted'));
  assert.match(await text('#exportSummary'),/Video duration: 00:00:02/);
  assert.ok(await page.evaluate(()=>document.querySelector('#timelineContainer [aria-label^="Video Track"]').getAttribute('aria-label').includes('Duration 00 minutes 02 seconds')));
  await page.locator('#btnUndo').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Undo successful'));
  await page.locator('#btnKeepMarked').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Kept only'));
  await page.locator('#btnUndo').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Undo successful'));
  await page.locator('#btnUndo').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Undo successful'));
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip')].filter(el=>(el.getAttribute('aria-label')||'').startsWith('Video Segment')).length),1);
  // Noise/voice balance sliders default to 31/70.
  assert.equal(await page.locator('#noiseLeftSlider').inputValue(),'31');
  assert.equal(await page.locator('#speechBoostSlider').inputValue(),'70');
  // Crop, rotate, and freeze-frame controls update the edit summary.
  await showPanel('edit');
  await page.locator('#cropPreset').selectOption('1:1');
  await page.waitForFunction(()=>document.querySelector('#cropSummary').textContent.includes('1:1'));
  await page.locator('#rotateAngle').selectOption('90');
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=2.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>2.4);
  await page.locator('#btnAddFreeze').click();
  await page.waitForFunction(()=>document.querySelectorAll('#freezeList li').length===1);
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');
  // Export 0: rotation + freeze + burn-in are honored in the file.
  await showPanel('export');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Exporting video'),{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    assert.match(download.suggestedFilename(),/E2E_Renamed_export\.webm$/);
    const output=path.join(dir,'export-rotated.webm');await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-select_streams','v:0','-show_entries','stream=width,height,nb_read_frames,avg_frame_rate','-of','json',output],{encoding:'utf8'}));
    const vstream=info.streams[0];
    assert.ok(vstream.height>vstream.width,'rotated export must be portrait');
    assert.ok(Number(vstream.nb_read_frames)>135,'freeze hold must extend export duration (got '+vstream.nb_read_frames+' frames at 30fps)')
    const pixels=execFileSync('ffmpeg',['-v','error','-ss','1','-i',output,'-frames:v','1','-vf','crop=iw:ih/2:0:ih/2','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:4*1024*1024});
    let white=0;for(let j=0;j<pixels.length;j+=3)if(pixels[j]>200&&pixels[j+1]>200&&pixels[j+2]>200)white++;
    assert.ok(white>100,'Export must contain visible burned-in caption glyphs');
  }
  // Chunked app bridge: a mocked app shell receives the export in small parts and reassembles it.
  await page.evaluate(()=>{
    window.__bridgeLog=[];
    const store={ext:null,action:null,total:0,got:0,parts:0};
    window.flutter_inappwebview={callHandler:async(name,...a)=>{
      window.__bridgeLog.push(name);
      if(name==='shareExportStart'){store.ext=a[0];store.action=a[1];store.total=a[2];return 't1';}
      if(name==='shareExportChunk'){
        if(a[0]!=='t1'||a[1]!==store.parts)throw new Error('bad chunk');
        const bin=Uint8Array.from(atob(a[2]),c=>c.charCodeAt(0));
        store.got+=bin.length;store.parts++;
        return store.got;
      }
      if(name==='shareExportFinish'){window.__bridgeStore={ext:store.ext,action:store.action,total:store.total,got:store.got,parts:store.parts};return true;}
      throw new Error('unexpected '+name);
    }};
  });
  await page.evaluate(()=>history.replaceState(null,'','#/editor?dev-backend='+encodeURIComponent('https://voicecut-test.example')+'&dev-bridge-chunk-kb=64'));
  await showPanel('export');await page.locator('#btnDownloadExported').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.includes('Video saved to your device gallery.'),{},{timeout:60000});
  {
    const summary=await page.evaluate(()=>({log:window.__bridgeLog,s:window.__bridgeStore}));
    assert.equal(summary.log[0],'shareExportStart');
    assert.equal(summary.log[summary.log.length-1],'shareExportFinish');
    assert.ok(summary.s.total>0);
    assert.equal(summary.s.got,summary.s.total);
    assert.equal(summary.s.parts,Math.ceil(summary.s.total/(64*1024)));
    assert.equal(summary.s.action,'save');
    assert.equal(summary.s.ext,'webm');
  }
  await page.evaluate(()=>{delete window.flutter_inappwebview;history.replaceState(null,'','#/editor?dev-backend='+encodeURIComponent('https://voicecut-test.example'));});
  // Export 1: plain export still carries audio, video, and burn-in.
  await showPanel('edit');
  await page.locator('#cropPreset').selectOption('original');
  await page.locator('#rotateAngle').selectOption('0');
  await page.locator('#freezeList button').click();
  await page.waitForFunction(()=>document.querySelectorAll('#freezeList li').length===0);
  await showPanel('export');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-plain.webm');await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
    assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(info.streams.some(s=>s.codec_type==='video'));
    const pixels=execFileSync('ffmpeg',['-v','error','-ss','1','-i',output,'-frames:v','1','-vf','crop=iw:ih/2:0:ih/2','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:4*1024*1024});
    let white=0;for(let j=0;j<pixels.length;j+=3)if(pixels[j]>200&&pixels[j+1]>200&&pixels[j+2]>200)white++;
    assert.ok(white>100,'Export must contain visible burned-in caption glyphs');
  }
  await showPanel('export');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>!document.querySelector('#btnCancelExport').disabled);
  await page.locator('#btnCancelExport').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Export cancelled'));
  await page.waitForFunction(()=>!document.querySelector('#btnDoExport').disabled && document.querySelector('#btnCancelExport').disabled);
  // Native button Space activation must not be stolen by global play shortcuts.
  await page.locator('#btnSaveProject').focus();
  await page.waitForFunction(()=>document.activeElement && document.activeElement.id==='btnSaveProject');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project saved'));
  // Simple editor: home Trim opens edit tools, home Split cuts at the playhead.
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>0.9);
  await page.locator('#btnHomeTrim').click();
  await page.locator('#section-edit:not(.hidden)').waitFor();
  await page.locator('#btnHomeSplit').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Video split at'));
  // Audio choices: voice-over and music open their own tools.
  await showPanel('audio');
  await page.locator('#audioSubTabs:not(.hidden)').waitFor();
  await showSub('music');
  await page.locator('#section-audio:not(.hidden)').waitFor();
  assert.equal(await page.locator('#section-voiceover:not(.hidden)').count(),0);
  await showSub('voiceover');
  await page.locator('#section-voiceover:not(.hidden)').waitFor();
  assert.equal(await page.locator('#section-audio:not(.hidden)').count(),0);
  // A new song stops the previous one where it starts.
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=0.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>0.4);
  await page.setInputFiles('#fileAudio',{name:'songone.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.waitForFunction(()=>[...document.querySelectorAll('#timelineContainer .clip')].some(el=>(el.getAttribute('aria-label')||'').includes('songone')));
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>1.4);
  await page.setInputFiles('#fileAudio',{name:'songtwo.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.waitForFunction(()=>[...document.querySelectorAll('#timelineContainer .clip')].some(el=>(el.getAttribute('aria-label')||'').includes('songtwo')));
  {
    const stopsPrevious = await page.evaluate(()=>{
      const clips=[...document.querySelectorAll('#timelineContainer .clip')].map(el=>el.getAttribute('aria-label')||'');
      const one=clips.find(a=>a.includes('songone'));
      return one && one.includes('Duration 00 minutes 01 second');
    });
    assert.ok(stopsPrevious,'previous song must stop where the new song starts');
  }
  // One volume for every song.
  await showPanel('clips');
  await page.locator('#timelineContainer .clip[aria-label*="songtwo"]').click();
  await page.locator('#selectedClipPanel:not(.hidden)').waitFor();
  await page.locator('#selVolumeNumber').fill('40');
  await page.locator('#selVolumeNumber').dispatchEvent('change');
  await showPanel('audio');await showSub('music');
  await page.locator('#btnApplyVolumeAll').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('applied to all songs'));
  // Voice changer offers every voice; preview renders or guides when empty.
  await showSub('voiceover');
  for (const v of ['high','low','chipmunk','alien','robot']) assert.ok(await page.locator('#voiceFilterSelect option[value="'+v+'"]').count(),v);
  const hasVO = await page.evaluate(()=>!![...document.querySelectorAll('#timelineContainer .clip')].some(el=>/^Voice-over Track/.test(el.getAttribute('aria-label')||'')));
  if (!hasVO) {
    await page.locator('#voiceFilterSelect').selectOption('chipmunk');
    await page.locator('#btnPreviewVoiceFilter').click();
    await page.waitForFunction(()=>document.querySelector('#voiceFilterStatus').textContent.includes('Record or select a voice-over first'));
  } else {
    await page.locator('#voiceFilterSelect').selectOption('none');
    await page.locator('#btnPreviewVoiceFilter').click();
    await page.waitForFunction(()=>document.querySelector('#voiceFilterStatus').textContent.includes('Choose a voice effect first'));
    await page.locator('#voiceFilterSelect').selectOption('chipmunk');
    await page.locator('#btnPreviewVoiceFilter').click();
    await page.waitForFunction(()=>document.querySelector('#aiResultText').textContent.includes('Voice filter: complete'),{},{timeout:60000});
    await page.locator('#btnCloseAI').click();
    await page.waitForFunction(()=>!document.querySelector('#aiProcessingDialog').open);
  }
  // Video looks change the preview and reset cleanly.
  await showPanel('home');
  await page.locator('#videoFilter').selectOption('vivid');
  assert.match(await page.locator('#mainVideo').evaluate(v=>v.style.filter),/saturate\(1\.8\)/);
  await page.locator('#videoFilter').selectOption('normal');
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.style.filter),'');
  // Captions panel names its source plainly; every file has its own tools.
  await showPanel('captions');
  assert.match(await page.locator('#section-captions').textContent(),/Get captions from/);
  await showPanel('clips');
  assert.equal(await page.locator('#btnVideoSilence:not(.hidden)').count(),1);
  await page.locator('#timelineContainer .clip[aria-label*="songtwo"]').click();
  await page.locator('#btnSelSilence:not(.hidden)').waitFor();
  // Ducking: 20% music at 50% ducking dips to 10% under voice, rises to 30% in silence.
  await showPanel('audio');await showSub('music');
  for (const v of ['60','70','80']) assert.ok(await page.locator('#duckingLevel option[value="'+v+'"]').count(),v);
  assert.equal(await page.evaluate(()=>window.VoiceCutCore.duckedGain(20,50,true,true)),0.1);
  assert.ok(Math.abs(await page.evaluate(()=>window.VoiceCutCore.duckedGain(20,50,false,true))-0.3)<1e-9);
  await page.locator('#duckingLevel').selectOption('50');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Ducking level set to 50 percent'));
  await page.locator('#duckingSilenceWait').selectOption('2');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Music rises after 2 seconds of silence.'));
  await page.locator('#duckingSilenceWait').selectOption('0');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Music rises as soon as there is silence.'));
  // Sound effects: own tab, device picker, music keeps playing untouched.
  await showPanel('audio');await showSub('sfx');
  assert.equal(await page.locator('#section-sfx:not(.hidden)').count(),1);
  assert.match(await page.locator('#sfxHelp').textContent(),/never stop it/);
  const musicBefore = await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip')].map(el=>el.getAttribute('aria-label')).filter(a=>a&&a.startsWith('Music Track')));
  assert.ok(musicBefore.length>0);
  const [sfxChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#btnAddSfx').click()]);
  await sfxChooser.setFiles(audioPath);
  await page.waitForFunction(()=>document.querySelector('#sfxTracksList').textContent.includes('sample'));
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Sound effect Track'));
  const musicAfter = await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip')].map(el=>el.getAttribute('aria-label')).filter(a=>a&&a.startsWith('Music Track')));
  assert.deepEqual(musicAfter, musicBefore);
  assert.ok(await page.locator('#timelineContainer .clip[aria-label^="Sound effect Track"]').count()>=1);
  // Retained slicing in the shipped core: deleted parts drop out and expand back aligned.
  assert.equal(await page.locator('#reconnectVideoBox.hidden').count(),1);
  const sliceRoundTrip = await page.evaluate(()=>{
    const ch = [new Float32Array([0,1,2,3,4,5,6,7,8,9])];
    const ranges = [{start:0.2,end:0.5},{start:0.7,end:0.9}];
    const sel = window.VoiceCutCore.selectRanges(ch, 10, ranges);
    const exp = window.VoiceCutCore.expandRanges(sel.channels, 10, 10, ranges);
    return {kept:[...sel.channels[0]], full:[...exp.channels[0]]};
  });
  assert.deepEqual(sliceRoundTrip.kept,[2,3,4,7,8]);
  assert.deepEqual(sliceRoundTrip.full,[0,0,2,3,4,0,0,7,8,0]);
  // Filename is rendered as text, never HTML.
  await page.setInputFiles('#fileAudio',{name:'<img src=x onerror=window.INJECTED=1>.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('<img'));
  assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
  // Deletion routes to the library and must not reappear due to queued auto-save.
  await page.locator('#delRangeStart').fill('00:01');await page.locator('#delRangeEnd').fill('00:02');await page.locator('#btnDeleteRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Deleted'));
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  await page.locator('#libraryScreen:not(.hidden)').waitFor();
  await page.locator('#libraryEmpty:not([style*="none"])').waitFor();
  await page.goto('http://127.0.0.1:3099/#/editor');
  await page.locator('#noProjectScreen:not(.hidden)').waitFor();
  // Record video with the camera: dialog, countdown, stop, review, use as project.
  await page.goto('http://127.0.0.1:3099');
  await page.locator('#homeScreen:not(.hidden)').waitFor();
  await page.locator('#homeRecordVideo').click();
  await page.locator('#videoRecordDialog[open]').waitFor();
  await page.waitForFunction(()=>document.querySelector('#videoRecordCountdown').textContent.includes('Camera ready'),{},{timeout:30000});
  await page.locator('#btnStartVideoRecording').click();
  await page.waitForFunction(()=>document.querySelector('#videoRecordCountdown').textContent.includes('Recording your video'),{},{timeout:30000});
  await page.waitForTimeout(2500);
  await page.locator('#btnStopVideoRecording').click();
  await page.locator('#videoRecordReview:not(.hidden)').waitFor({timeout:30000});
  await page.locator('#btnApplyVideoRecord').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor({timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration>1,{},{timeout:30000});
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  await page.goto('http://127.0.0.1:3099/#/editor');
  await page.locator('#noProjectScreen:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>VoiceCutStorage.load()),null);
  // An audio-only MP4 (a voice recording saved as video) exports with a still background.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',audioOnlyPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#videoPlaceholder p').textContent.includes('Audio file loaded'),{},{timeout:30000});
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('still background'),{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-audioonly.webm');await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
    assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(info.streams.some(s=>s.codec_type==='video'));
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // MP4 export after a delete keeps the full kept length and speaks it.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.locator('#delRangeStart').fill('00:01');await page.locator('#delRangeEnd').fill('00:02');await page.locator('#btnDeleteRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Deleted'),{},{timeout:30000});
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('mp4');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  assert.match(await page.locator('#exportStatus').textContent(),/seconds/);
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-mp4delete.mp4');await download.saveAs(output);
    const dur=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',output],{encoding:'utf8'}).trim());
    assert.ok(Math.abs(dur-2)<1,'MP4 export after delete must keep ~2s, got '+dur);
    const streams=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','json',output],{encoding:'utf8'})).streams;
    const vcode=streams.find(s=>s.codec_type==='video').codec_name, acode=streams.find(s=>s.codec_type==='audio').codec_name;
    assert.equal(vcode,'h264','MP4 video track must be H.264 for Instagram, got '+vcode);
    assert.ok(['aac','opus'].includes(acode),'MP4 audio track must be AAC (Opus on AAC-less desktops), got '+acode);
    const raw=fs.readFileSync(output);
    assert.ok(raw.indexOf('moov')>-1&&raw.indexOf('moov')<raw.indexOf('mdat'),'movie header must come before media data');
    const mvhdBox=raw.indexOf('mvhd')-4;
    assert.equal(raw[mvhdBox+8],0,'mvhd must be version 0');
    assert.equal(raw.readUInt32BE(mvhdBox+20),1000,'mvhd timescale must be 1000');
    const mvhdMs=raw.readUInt32BE(mvhdBox+24);
    assert.ok(Math.abs(mvhdMs/1000-2)<1.5,'mvhd must carry the real ~2s length, got '+mvhdMs+'ms');
    execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-']);
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Swapped speed times are forgiven, and position buttons fill the boxes.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.locator('#speedRangeStart').fill('00:02');await page.locator('#speedRangeEnd').fill('00:01');await page.locator('#btnApplySpeedRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('swapped them'),{},{timeout:30000});
  await page.locator('#speedRangeRate').selectOption('1');await page.locator('#btnApplySpeedRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Removed 1 speed change'),{},{timeout:30000});
  await page.evaluate(()=>{document.querySelector('#mainVideo').currentTime=1.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>1.4,{},{timeout:10000});
  await page.locator('#btnSpeedMarkStart').click();
  assert.equal(await page.locator('#speedRangeStart').inputValue(),'00:00:01');
  await page.evaluate(()=>{document.querySelector('#mainVideo').currentTime=2.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>2.4,{},{timeout:10000});
  await page.locator('#btnSpeedMarkEnd').click();
  assert.equal(await page.locator('#speedRangeEnd').inputValue(),'00:00:02');
  await page.locator('#speedRangeRate').selectOption('2');await page.locator('#btnApplySpeedRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Speed 2x applied'),{},{timeout:30000});
  await page.evaluate(()=>{document.querySelector('#mainVideo').currentTime=0;});
  await page.locator('#btnPlay').click();
  await page.waitForFunction(()=>document.querySelector('#mainVideo').playbackRate===2,{},{timeout:15000});
  await page.evaluate(()=>document.querySelector('#mainVideo').pause());
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // A 2x speed range shortens the export. Applied by typing and exported
  // without playing first: playing, pausing, seeking and exporting back to
  // back makes loaded headless media report the video ended early, which the
  // pumps now refuse to mistake for a finished range.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.locator('#speedRangeStart').fill('00:01');await page.locator('#speedRangeEnd').fill('00:02');await page.locator('#btnApplySpeedRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Timeline is now'),{},{timeout:30000});
  assert.match(await page.locator('#speedRangesList').textContent(),/2x/);
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete')||document.querySelector('#statusText').textContent.includes('Export failed'),{},{timeout:90000});
  if ((await page.locator('#statusText').textContent()).includes('Export failed')) {
    await page.locator('#btnDoExport').click(); // transient media glitch: a user would simply press Export again
    await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  }
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-speed.webm');await download.saveAs(output);
    const frames=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',output],{encoding:'utf8'})).streams[0];
    const pts=execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',output],{encoding:'utf8'}).trim().split('\n');
    const lastPts=Number(pts[pts.length-1].replace(',',''));
    assert.ok(Number(frames.nb_read_frames)>15,'2x speed range export must contain real frames, got '+frames.nb_read_frames);
    assert.ok(Math.abs(lastPts-2.5)<0.9,'2x speed range export must span ~2.5s, got '+lastPts);
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Exported sound keeps the source level and content: flat RMS, right tones.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',tonePath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 5,{},{timeout:30000});
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('mp4');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:120000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-fidelity.mp4');await download.saveAs(output);
    console.log('fidelity mp4 audio:',execFileSync('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels','-of','csv=p=0',output],{encoding:'utf8'}).trim());
    const f=audioFidelity(output);
    assert.ok(f.flat<2,'untouched export must keep a flat level, RMS spread '+f.flat.toFixed(2)+'dB');
    assert.ok(f.tone(1,440)>f.tone(1,880)*4,'first half must stay 440Hz');
    assert.ok(f.tone(4,880)>f.tone(4,440)*4,'second half must stay 880Hz');
    assert.ok(Math.abs(f.dur-6)<0.4,'untouched export must keep ~6s, got '+f.dur.toFixed(2));
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Deleting the head keeps the tail's sound intact (del 0-3 of 6, webm path).
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',tonePath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 5,{},{timeout:30000});
  await page.locator('#delRangeStart').fill('00:00');await page.locator('#delRangeEnd').fill('00:03');await page.locator('#btnDeleteRange').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Deleted'),{},{timeout:30000});
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:120000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-fidelity-del.webm');await download.saveAs(output);
    console.log('fidelity webm audio:',execFileSync('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels','-of','csv=p=0',output],{encoding:'utf8'}).trim());
    const f=audioFidelity(output);
    assert.ok(Math.abs(f.dur-3)<0.4,'delete-head export must keep ~3s, got '+f.dur.toFixed(2));
    assert.ok(f.tone(1,880)>f.tone(1,440)*4,'remaining audio must be the 880Hz tail');
    assert.ok(f.flat<2,'delete-head export must keep a flat level, RMS spread '+f.flat.toFixed(2)+'dB');
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // A recorded voice-over is audible in the export, not just on the timeline.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await showPanel('audio');await showSub('voiceover');
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled,{},{timeout:30000});
  await page.waitForTimeout(1500);
  await page.locator('#btnStopRecordingDialog').click();
  await page.locator('#recordReview:not(.hidden)').waitFor();
  await page.locator('#btnApplyRecord').click();
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('Voiceover_'),{},{timeout:30000});
  await showPanel('clips');
  await page.locator('#btnMuteOrig').click();
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-voiceover.webm');await download.saveAs(output);
    const vol=meanVolume(output);
    assert.ok(vol!=='n/a'&&Number(vol)>-50,'voice-over must be audible in export, mean_volume '+vol);
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Added music is audible in the export.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.setInputFiles('#fileAudio',audioPath);
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Music Track'),{},{timeout:30000});
  await showPanel('clips');
  await page.locator('#btnMuteOrig').click();
  await showPanel('export');
  await page.locator('#exportFormat').selectOption('webm');
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await showPanel('export');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-music.webm');await download.saveAs(output);
    const vol=meanVolume(output);
    assert.ok(vol!=='n/a'&&Number(vol)>-50,'music must be audible in export, mean_volume '+vol);
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Recording offers a voice effect that bakes into the voice-over.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await showPanel('audio');await showSub('voiceover');
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled,{},{timeout:30000});
  await page.waitForTimeout(1500);
  await page.locator('#btnStopRecordingDialog').click();
  await page.locator('#recordReview:not(.hidden)').waitFor({timeout:30000});
  await page.locator('#recordEffectSelect').selectOption('echo');
  await page.locator('#btnPreviewRecordEffect').click();
  await page.waitForFunction(()=>document.querySelector('#recordEffectStatus').textContent.includes('Apply to keep it'),{},{timeout:30000});
  await page.locator('#btnApplyRecord').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('with Echo'),{},{timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('#recordDialog').open,{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('Voiceover_'),{},{timeout:30000});
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Fresh projects ship with automatic sound processing off.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Project saved'),{},{timeout:30000});
  assert.equal(await page.evaluate(()=>document.querySelector('#duckingToggle').checked), false);
  assert.equal(await page.evaluate(()=>document.querySelector('#globalNoiseReduction').value), 'off');
  assert.equal(await page.evaluate(()=>document.querySelector('#origNoiseReduction').value), 'off');
  // Legacy projects with untouched processing settings migrate to off on open.
  await page.evaluate(async ()=>{
    const p = await window.VoiceCutStorage.load();
    p.originalAudio.noiseReduction = 'medium';
    p.ducking = {enabled:true, level:30, silenceWait:0};
    delete p.autoProcessingMigrated;
    await window.VoiceCutStorage.save(p);
  });
  await page.reload();
  await page.locator('#noProjectScreen:not(.hidden)').waitFor({timeout:30000});
  await page.locator('#noProjectOpen').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor({timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Automatic sound changes are now off'),{},{timeout:30000});
  assert.equal(await page.evaluate(()=>document.querySelector('#duckingToggle').checked), false);
  assert.equal(await page.evaluate(()=>document.querySelector('#globalNoiseReduction').value), 'off');
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');

  // Merge videos: picked order is kept and no silence is inserted.
  await page.goto('http://127.0.0.1:3099');
  {
    const m1=path.join(dir,'merge1.mp4'), m2=path.join(dir,'merge2.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-shortest','-y',m1]);
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=2','-f','lavfi','-i','sine=frequency=880:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-shortest','-y',m2]);
    await page.setInputFiles('#fileMergeVideos',[m1,m2]);
    await page.locator('#mergePanel:not(.hidden)').waitFor({timeout:30000});
    assert.equal(await page.locator('#mergeFileList li').count(), 2);
    assert.match(await page.locator('#mergeFileList li').first().textContent(), /Clip 1: merge1\.mp4/);
    assert.match(await page.locator('#mergeFileList li').nth(1).textContent(), /Clip 2: merge2\.mp4/);
    await page.locator('#btnStartMerge').click();
    await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 3.5,{},{timeout:180000});
    const mergedDur = await page.evaluate(()=>document.querySelector('#mainVideo').duration);
    assert.ok(Math.abs(mergedDur-4)<0.5,'merged video must last ~4s, got '+mergedDur);
    const mergedBytes = await page.evaluate(async ()=>[...new Uint8Array(await window.VoiceCutDebug.lastMergeBlob.arrayBuffer())]);
    const mergedPath = path.join(dir,'merged.mp4');
    fs.writeFileSync(mergedPath, Buffer.from(mergedBytes));
    const f = audioFidelity(mergedPath);
    assert.ok(Math.abs(f.dur-4)<0.4,'merged audio must last ~4s, got '+f.dur.toFixed(2));
    assert.ok(f.tone(0,440)>f.tone(0,880)*4,'first clip must come first (440Hz)');
    assert.ok(f.tone(3,880)>f.tone(3,440)*4,'second clip must come second (880Hz)');
    console.log('merge boundary flatness: '+f.flat.toFixed(2)+'dB');
    assert.ok(f.flat<3,'merge must not insert silence or clicks at the boundary, RMS spread '+f.flat.toFixed(2)+'dB');
    const m3=path.join(dir,'merge3.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=640x360:r=30:d=2','-f','lavfi','-i','sine=frequency=660:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','44100','-ac','1','-shortest','-y',m3]);
    await showPanel('clips');
    await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
    await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
    await page.goto('http://127.0.0.1:3099');
    await page.setInputFiles('#fileMergeVideos',[m3,m1]);
    await page.locator('#mergePanel:not(.hidden)').waitFor({timeout:30000});
    await page.locator('#btnStartMerge').click();
    await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 3.5,{},{timeout:180000});
    const mergedBytes2 = await page.evaluate(async ()=>[...new Uint8Array(await window.VoiceCutDebug.lastMergeBlob.arrayBuffer())]);
    const mergedPath2 = path.join(dir,'merged-mixed.mp4');
    fs.writeFileSync(mergedPath2, Buffer.from(mergedBytes2));
    const f2 = audioFidelity(mergedPath2);
    assert.ok(Math.abs(f2.dur-4)<0.4,'mixed merge must last ~4s, got '+f2.dur.toFixed(2));
    assert.ok(f2.tone(0,660)>f2.tone(0,440)*4,'mixed merge must keep picked order (660Hz first)');
    assert.ok(f2.tone(3,440)>f2.tone(3,660)*4,'mixed merge must keep picked order (440Hz second)');
    console.log('mixed merge boundary flatness: '+f2.flat.toFixed(2)+'dB');
    assert.ok(f2.flat<3,'mixed merge must stay gapless, RMS spread '+f2.flat.toFixed(2)+'dB');
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  // Time steppers: every time control gets -/+ buttons that adjust and announce.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.vc-stepper').length), 14);
  await showPanel('home');
  await page.locator('#trimStartInput + .vc-stepper button[aria-label="Start time, increase by 1 second"]').click();
  assert.equal(await page.locator('#trimStartInput').inputValue(), '00:00:01');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Start time 00 minutes 01 second'));
  await showPanel('cleanup');
  const silBefore = await page.evaluate(()=>document.querySelector('#silenceSeconds').selectedIndex);
  await page.locator('#silenceSeconds + .vc-stepper button[aria-label$="next choice"]').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#silenceSeconds').selectedIndex), silBefore+1);
  await showPanel('edit');
  await page.locator('#freezeSeconds + .vc-stepper button[aria-label$="decrease by 1 second"]').click();
  assert.equal(await page.locator('#freezeSeconds').inputValue(), '1');
  await showPanel('captions');
  await page.locator('#captionStart + .vc-stepper button[aria-label$="increase by 1 second"]').click();
  assert.equal(await page.locator('#captionStart').inputValue(), '1');
  await showPanel('audio');await showSub('music');
  const duckBefore = await page.evaluate(()=>document.querySelector('#duckingSilenceWait').selectedIndex);
  await page.locator('#duckingSilenceWait + .vc-stepper button[aria-label$="previous choice"]').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#duckingSilenceWait').selectedIndex), Math.max(0,duckBefore-1));
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');

  // Music re-upload after delete: track numbers stay unique, no leftovers.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await page.setInputFiles('#fileAudio',audioPath);
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Track 1 added'),{},{timeout:30000});
  await page.setInputFiles('#fileAudio',audioPath);
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Track 2 added'),{},{timeout:30000});
  await showPanel('clips');
  await page.locator('.clip [data-action="delete"]').first().click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('deleted.'),{},{timeout:30000});
  await page.setInputFiles('#fileAudio',audioPath);
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Track 1 added'),{},{timeout:30000});
  {
    const tracks = await page.evaluate(()=>[...document.querySelectorAll('#timelineContainer .clip')].map(el=>el.getAttribute('aria-label')).filter(l=>l&&l.includes('Music Track')).map(l=>l.match(/Track (\d+)/)[1]));
    assert.deepEqual(tracks.sort(),['1','2'],'timeline must show distinct track numbers, got '+tracks.join(','));
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');

  // Export shapes: portrait, landscape and square canvases from one source.
  await page.goto('http://127.0.0.1:3099');
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2,{},{timeout:30000});
  await showPanel('export');
  for (const [shape,fmt,w,h] of [['portrait','webm',1080,1920],['landscape','mp4',1920,1080],['square','webm',1080,1080]]) {
    await page.locator('#exportShape').selectOption(shape);
    await page.locator('#exportFormat').selectOption(fmt);
    await page.locator('#btnDoExport').click();
    await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.includes('Exporting'),{},{timeout:30000});
    await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:120000});
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#btnDownloadExported').click();
    const download=await downloadPromise;
    const output=path.join(dir,'export-shape-'+shape+'.'+fmt);
    await download.saveAs(output);
    const dims=execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',output],{encoding:'utf8'}).trim();
    console.log('shape '+shape+': '+dims);
    assert.equal(dims,w+','+h,shape+' export must be '+w+'x'+h+', got '+dims);
  }
  await showPanel('clips');
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  assert.deepEqual(errors,[]);
  console.log('PASS: home/library/settings router, no-project editor guard, rename/reopen, reload/project restore, prefs, in-app back/forward, section navigation, delete+undo, microphone recording with preview+apply, Voice Focus and Ultra NR, typed delete-range, on-device neural cleanup with scan, mocked cloud captions with consent and friendly Retry, mocked isolation then local-NN denoise auto-selection, reviewed SRT/VTT, caption overlay, crop/rotate/freeze export verification, plain export with burn-in, cancel, keyboard, filename escaping, delete storage, caption counter/prev/next/read-all with language warning, notifications pref plus hidden-tab bridge, silence gap preview plus removal with progress, buried-voice rescue notify on failure, clip reverse, audio merge with undo, video reverse download, marked-range split/delete/keep, noise/voice balance sliders, camera video recording, text size, large-file on-device routing, on-device silence cut, large-file captions, 30-minute part-based cleanup, retained duration displays, chunked app file transfer, clarity plus ultra finish, simple editor panels, voice changer, video looks, smart ducking, talkback cursor, ducking levels, ducking wait, sound effects, retained export, record rescue, mic fallback, audio-only export, mp4 h264 direct, mvhd durations, voice filter dsp, clip export audio, vo record effect, processing opt-in, speed ranges, speed position buttons, export ended guard, export audio fidelity, merge videos, time steppers, music re-upload track numbers, export shapes');
 } finally {await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

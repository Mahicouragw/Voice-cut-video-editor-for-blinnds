const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {spawn,execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
(async()=>{
 const dir = path.resolve('artifacts');fs.mkdirSync(dir,{recursive:true});
 const videoPath=path.join(dir,'sample.mp4'), audioPath=path.join(dir,'sample.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',videoPath]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=660:duration=3','-y',audioPath]);
 const server=spawn(process.execPath,['scripts/serve.js'],{env:{...process.env,PORT:'3099'},stdio:['ignore','pipe','inherit']});
 await new Promise((resolve,reject)=>{server.stdout.on('data',data=>{if(data.toString().includes('preview on port'))resolve();});server.on('error',reject);server.on('exit',code=>{if(code)reject(new Error('Server failed'));});});
 const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}).catch(error=>{server.kill();throw error;});
 const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',dialog=>dialog.accept());
 try {
  const text = sel => page.locator(sel).textContent();
  // HOME shell: nav only, editor hidden, no server/credential fields anywhere.
  await page.goto('http://127.0.0.1:3099');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Welcome to VoiceCut'));
  await page.locator('#homeScreen:not(.hidden)').waitFor();
  assert.equal(await page.locator('#editorScreen:not(.hidden)').count(),0);
  assert.equal(await page.locator('#navEditor:not(.hidden)').count(),0);
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
  // Settings holds only normal preferences; caption language pref applies to the editor.
  await page.locator('a[data-route="settings"]').click();
  await page.locator('#settingsScreen:not(.hidden)').waitFor();
  await page.locator('#settingCaptionLanguage').selectOption('en');
  assert.equal(await page.locator('#captionLanguage').inputValue(),'en');
  await page.locator('a[data-route="home"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#homeRecentList .library-card').length===1);
  await page.locator('#homeOpenProject').click();
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  // Audio clip add, delete with in-app confirm, undo.
  await page.setInputFiles('#fileAudio',audioPath);
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  await page.locator('#timelineContainer [data-action="delete"]').first().click();
  await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>!document.querySelector('#timelineContainer [data-action="delete"]'));
  await page.locator('#btnUndo').click();
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  // Capture actual MediaRecorder data from a fake microphone device.
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled);
  await page.waitForTimeout(1200);
  await page.locator('#btnStopRecordingDialog').click();
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('Voiceover_'));
  // Voice Focus noise-reduction level applies live without errors.
  await page.locator('#globalNoiseReduction').selectOption('voicefocus');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Noise reduction set to voicefocus'));
  await page.locator('#globalNoiseReduction').selectOption('medium');
  // Real on-device cleanup (no backend configured), replacing original track.
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:30000});
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
  await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:60000});
  assert.equal(captionCalls.length,1);
  assert.equal(captionCalls[0].consent,'yes');
  assert.equal(captionCalls[0].url.includes('provider='),false);
  assert.equal(await page.locator('#captionText').inputValue(),'Hello from VoiceCut.');
  await page.locator('#captionStart').fill('0.25');await page.locator('#captionEnd').fill('2.75');await page.locator('#captionText').fill('Reviewed caption');await page.locator('#btnSaveCaption').click();
  for(const [button,extension,expected] of [['#btnDownloadSRT','srt','00:00:00,250 --> 00:00:02,750'],['#btnDownloadVTT','vtt','WEBVTT']]){
    const event=page.waitForEvent('download');await page.locator(button).click();const d=await event;assert.match(d.suggestedFilename(),new RegExp('\\.'+extension+'$'));
    const file=path.join(dir,'captions.'+extension);await d.saveAs(file);assert.ok(fs.readFileSync(file,'utf8').includes(expected));
  }
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1;});
  await page.waitForFunction(()=>document.querySelector('#captionOverlay').textContent==='Reviewed caption'&&!document.querySelector('#captionOverlay').hidden);
  // Friendly failure: existing cues preserved, Retry recovers.
  providerFailure=true;await page.locator('#btnGenerateCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('Caption generation is temporarily unavailable'));
  await page.locator('#btnRetryCaptions:not(.hidden)').waitFor();
  assert.equal(await page.locator('#captionText').inputValue(),'Reviewed caption');
  providerFailure=false;await page.locator('#btnRetryCaptions').click();
  await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'),{},{timeout:60000});
  assert.equal(await page.locator('#captionText').inputValue(),'Hello from VoiceCut.');
  // Cloud isolation is auto-selected when on-device neural denoise is unavailable.
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:60000});
  assert.equal(isolateCalls,1);assert.equal(denoiseCalls,0);
  assert.match(await text('#aiResultText'),/VoiceCut AI enhancement/);
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
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:60000});
  assert.equal(denoiseCalls,1);assert.equal(denoiseConsent,undefined);
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  // Crop, rotate, and freeze-frame controls update the edit summary.
  await page.locator('#cropPreset').selectOption('1:1');
  await page.waitForFunction(()=>document.querySelector('#cropSummary').textContent.includes('1:1'));
  await page.locator('#rotateAngle').selectOption('90');
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=2.5;});
  await page.waitForFunction(()=>document.querySelector('#mainVideo').currentTime>2.4);
  await page.locator('#btnAddFreeze').click();
  await page.waitForFunction(()=>document.querySelectorAll('#freezeList li').length===1);
  await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');
  // Export 0: rotation + freeze + burn-in are honored in the file.
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Exporting video'),{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
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
  // Export 1: plain export still carries audio, video, and burn-in.
  await page.locator('#cropPreset').selectOption('original');
  await page.locator('#rotateAngle').selectOption('0');
  await page.locator('#freezeList button').click();
  await page.waitForFunction(()=>document.querySelectorAll('#freezeList li').length===0);
  await page.locator('#btnDoExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:90000});
  {
    const downloadPromise=page.waitForEvent('download');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    const output=path.join(dir,'export-plain.webm');await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
    assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(info.streams.some(s=>s.codec_type==='video'));
    const pixels=execFileSync('ffmpeg',['-v','error','-ss','1','-i',output,'-frames:v','1','-vf','crop=iw:ih/2:0:ih/2','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:4*1024*1024});
    let white=0;for(let j=0;j<pixels.length;j+=3)if(pixels[j]>200&&pixels[j+1]>200&&pixels[j+2]>200)white++;
    assert.ok(white>100,'Export must contain visible burned-in caption glyphs');
  }
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
  // Filename is rendered as text, never HTML.
  await page.setInputFiles('#fileAudio',{name:'<img src=x onerror=window.INJECTED=1>.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('<img'));
  assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
  // Deletion routes to the library and must not reappear due to queued auto-save.
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  await page.locator('#libraryScreen:not(.hidden)').waitFor();
  await page.locator('#libraryEmpty:not([style*="none"])').waitFor();
  await page.goto('http://127.0.0.1:3099/#/editor');
  await page.locator('#noProjectScreen:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>VoiceCutStorage.load()),null);
  assert.deepEqual(errors,[]);
  console.log('PASS: home/library/settings router, no-project editor guard, rename/reopen, prefs, delete+undo, microphone recording, Voice Focus NR, on-device cleanup, mocked cloud captions with consent and friendly Retry, mocked isolation then local-NN denoise auto-selection, reviewed SRT/VTT, caption overlay, crop/rotate/freeze export verification, plain export with burn-in, cancel, keyboard, filename escaping, delete storage');
 } finally {await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

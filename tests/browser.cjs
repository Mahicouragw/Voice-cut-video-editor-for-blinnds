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
 try {
  await page.goto('http://127.0.0.1:3099');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('Welcome'));
  await page.setInputFiles('#fileVideo',videoPath);
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2);
  await page.locator('#editorScreen:not(.hidden)').waitFor();
  await page.setInputFiles('#fileAudio',audioPath);
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  await page.locator('#btnSaveProject').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('media saved'));
  await page.reload();await page.locator('#homeOpenProject').click();
  await page.waitForFunction(()=>document.querySelector('#mainVideo').duration > 2);
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  await page.locator('#timelineContainer [data-action="delete"]').first().click();await page.locator('#btnConfirmApply').click();
  await page.locator('#btnUndo').click();
  await page.locator('#timelineContainer [data-action="delete"]').first().waitFor();
  // Capture actual MediaRecorder data from a fake microphone device.
  await page.locator('#btnRecordVO').click();
  await page.locator('#btnStartRecording').click();
  await page.waitForFunction(()=>!document.querySelector('#btnStopRecordingDialog').disabled);
  await page.waitForTimeout(1200);
  await page.locator('#btnStopRecordingDialog').click();
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('Voiceover_'));
  // Real cleanup, replacing original track, with no duplicate original playback.
  await page.locator('#btnAIEnhanceOriginal').click();
  await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor({timeout:20000});
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  // Provider responses are mocked in browser tests. No paid API call or quality claim.
  let captionCalls=0,providerFailure=false;
  const accessKey='b'.repeat(64);
  page.on('dialog',dialog=>dialog.accept());
  await page.route('https://voicecut-test.example/**',async route=>{
    const request=route.request();
    if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type,x-upload-consent','access-control-allow-methods':'GET,POST,OPTIONS'}});return;}
    assert.equal(request.headers().authorization,'Bearer '+accessKey);
    const headers={'access-control-allow-origin':'*'};
    if(request.url().includes('/capabilities')){await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({captions:true,isolation:true})});return;}
    if(request.url().includes('/api/isolate')){assert.equal(request.headers()['x-upload-consent'],'yes');await route.fulfill({headers,contentType:'audio/wav',body:fs.readFileSync(audioPath)});return;}
    captionCalls++;assert.equal(request.headers()['x-upload-consent'],'yes');
    if(providerFailure){await route.fulfill({status:503,headers,contentType:'application/json',body:JSON.stringify({error:'OpenAI quota reached. Check billing.'})});return;}
    await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({language:'english',duration:3,cues:[{start:.2,end:2.7,text:'Hello from VoiceCut.'}]})});
  });
  await page.locator('#aiServerUrl').fill('https://voicecut-test.example');
  await page.locator('#serverAccessKey').fill(accessKey);await page.locator('#btnSaveApiKeys').click();
  assert.equal(await page.locator('#serverAccessKey').inputValue(),'');
  assert.equal(await page.evaluate(key=>Object.values(localStorage).some(value=>value.includes(key)),accessKey),false);
  await page.locator('#btnCheckServer').click();await page.waitForFunction(()=>document.querySelector('#apiKeysStatus').textContent.includes('Connected.'));
  await page.locator('#btnGenerateCaptions').click();await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('1 captions generated'));
  assert.equal(await page.locator('#captionText').inputValue(),'Hello from VoiceCut.');
  await page.locator('#captionStart').fill('0.25');await page.locator('#captionEnd').fill('2.75');await page.locator('#captionText').fill('Reviewed caption');await page.locator('#btnSaveCaption').click();
  for(const [button,extension,expected] of [['#btnDownloadSRT','srt','00:00:00,250 --> 00:00:02,750'],['#btnDownloadVTT','vtt','WEBVTT']]){
    const event=page.waitForEvent('download');await page.locator(button).click();const d=await event;assert.match(d.suggestedFilename(),new RegExp('\\.'+extension+'$'));
    const file=path.join(dir,'captions.'+extension);await d.saveAs(file);assert.ok(fs.readFileSync(file,'utf8').includes(expected));
  }
  await page.locator('#mainVideo').evaluate(v=>{v.currentTime=1;});
  await page.waitForFunction(()=>document.querySelector('#captionOverlay').textContent==='Reviewed caption'&&!document.querySelector('#captionOverlay').hidden);
  providerFailure=true;await page.locator('#btnGenerateCaptions').click();await page.waitForFunction(()=>document.querySelector('#captionStatus').textContent.includes('quota reached'));
  assert.equal(captionCalls,2);assert.equal(await page.locator('#captionText').inputValue(),'Reviewed caption');
  await page.locator('#cleanupMethod').selectOption('elevenlabs');
  await page.locator('#btnAIEnhanceOriginal').click();await page.locator('#btnApplyEnhanced:not(.hidden)').waitFor();
  assert.match(await page.locator('#aiResultText').textContent(),/ElevenLabs/);
  await page.locator('#btnApplyEnhanced').click();
  assert.equal(await page.locator('#mainVideo').evaluate(v=>v.muted),true);
  await page.locator('#btnSaveProject').click();await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('media saved'));
  await page.reload();await page.locator('#homeOpenProject').click();await page.waitForFunction(()=>document.querySelector('#mainVideo').duration>2);
  assert.equal(await page.locator('#captionText').inputValue(),'Reviewed caption');
  await page.locator('#btnCheckServer').click();await page.waitForFunction(()=>document.querySelector('#apiKeysStatus').textContent.includes('expires after 15 minutes'));

  await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');
  for (let i=0;i<2;i++) {
    await page.locator('#btnDoExport').click();
    await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.startsWith('Export complete'),{},{timeout:30000});
    const downloadPromise=page.waitForEvent('download');await page.locator('#btnDownloadExported').click();const download=await downloadPromise;
    assert.match(download.suggestedFilename(),/\.webm$/);const output=path.join(dir,'export-'+i+'.webm');await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
    assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(info.streams.some(s=>s.codec_type==='video'));
    // Caption burn-in: the source is solid blue; white pixels in the lower region are caption glyphs.
    const pixels=execFileSync('ffmpeg',['-v','error','-ss','1','-i',output,'-frames:v','1','-vf','crop=iw:ih/2:0:ih/2','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:4*1024*1024});
    let white=0;for(let j=0;j<pixels.length;j+=3)if(pixels[j]>200&&pixels[j+1]>200&&pixels[j+2]>200)white++;
    assert.ok(white>100,'Export must contain visible burned-in caption glyphs');
  }
  await page.locator('#btnDoExport').click();await page.locator('#btnCancelExport').click();
  await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent.includes('cancelled'));
  // Native button Space activation must not be stolen by global play shortcuts.
  await page.locator('#btnSaveProject').focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('media saved'));
  // Filename is rendered as text, never HTML.
  await page.setInputFiles('#fileAudio',{name:'<img src=x onerror=window.INJECTED=1>.wav',mimeType:'audio/wav',buffer:fs.readFileSync(audioPath)});
  await page.waitForFunction(()=>document.querySelector('#timelineContainer').textContent.includes('<img'));
  assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
  // Deletion must not reappear due to queued auto-save.
  await page.locator('#btnDeleteProject').click();await page.locator('#btnConfirmApply').click();
  await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='Project deleted.');
  assert.equal(await page.evaluate(()=>VoiceCutStorage.load()),null);
  assert.deepEqual(errors,[]);
  console.log('PASS: upload, media persistence/reload, delete+undo, cleanup/apply, microphone recording, mocked cloud captions/isolation, caption edit/save/SRT/VTT, provider failure preservation, two real exports with verified caption burn-in, cancel, keyboard, filename escaping, delete storage');
 } finally {await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

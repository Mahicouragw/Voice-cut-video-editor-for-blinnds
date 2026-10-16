const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');

test('silence length offers short gaps up to multi-minute pauses', () => {
  for (const v of ['2', '3', '5', '7', '8', '10', '30', '60', '65', '90', '120']) {
    assert.match(html, new RegExp(`<option value="${v}"[^>]*>[^<]+</option>`));
  }
  assert.match(html, /<option value="60">1 minute<\/option>/);
  assert.match(html, /<option value="65">1 minute 5 seconds<\/option>/);
  assert.match(html, /<option value="90">1 minute 30 seconds<\/option>/);
  assert.match(html, /<option value="120">2 minutes<\/option>/);
});

test('editor hides upload and processing mechanics from users', () => {
  assert.doesNotMatch(page, /VoiceCut server/);
  assert.doesNotMatch(page, /on the server/);
  assert.doesNotMatch(page, /No upload/);
  assert.doesNotMatch(page, /Temporary server copies/);
  assert.doesNotMatch(page, /Uploading to your/);
  assert.doesNotMatch(page, /Detecting quiet gaps/);
  assert.doesNotMatch(page, /On-device/);
  assert.doesNotMatch(page, /VoiceCut (AI|silence)/);
  // The only allowed "this device" line is the share fallback (the phone itself).
  const stripped = page.replace("announce('Share not supported on this device. Use download instead.');", '');
  assert.doesNotMatch(stripped, /on this device/);
  // Plain progress words stay.
  assert.match(page, /Uploading…/);
  assert.match(page, /Generating captions/);
  assert.match(page, /Reducing noise/);
  assert.match(page, /Removing silence/);
});

test('uploaded music keeps its original sound (full volume, no effects)', () => {
  assert.doesNotMatch(page, /type==='music' \? 60/);
  assert.match(page, /volume: 100,/);
  assert.match(page, /noiseReduction: \(type==='music'\|\|type==='sfx'\) \? 'off'/);
});

test('simple editor has one home screen with panel tabs', () => {
  for (const id of ['tab-home', 'tab-edit', 'tab-audio', 'tab-captions', 'tab-cleanup', 'tab-clips', 'tab-export']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="btnHomeTrim"/);
  assert.match(html, /id="btnHomeSplit"/);
  assert.match(html, /id="audioSubTabs"/);
  assert.match(html, /id="subVoiceover"/);
  assert.match(html, /id="subMusic"/);
  assert.match(page, /function showEditorPanel/);
  assert.match(page, /function showAudioSub/);
});

test('voice changer, video looks and per-file tools exist', () => {
  for (const v of ['high', 'low', 'chipmunk', 'alien', 'robot']) {
    assert.match(html, new RegExp(`<option value="${v}">`));
  }
  assert.match(html, /id="btnPreviewVoiceFilter"/);
  for (const v of ['bright', 'warm', 'cool', 'bw', 'vintage', 'vivid', 'overflow']) {
    assert.match(html, new RegExp(`<option value="${v}">`));
  }
  assert.match(html, /id="btnApplyVolumeAll"/);
  assert.match(html, /id="btnSelSilence"/);
  assert.match(html, /id="btnVideoSilence"/);
  assert.match(html, /Get captions from/);
  assert.match(page, /function renderVoiceFilter/);
  assert.match(page, /function previewVoiceFilter/);
  assert.match(page, /function applyVideoFilter/);
  assert.match(page, /function applyVolumeToAllMusic/);
  assert.match(page, /ctx\.filter/);
});

test('smart ducking reads a voice map of the video', () => {
  assert.match(page, /function ensureVoiceCurve/);
  assert.match(page, /duckedGain\(clip\.volume/);
  assert.match(page, /computeVoiceCurve\(decoded\.getChannelData/);
});

test('server silence results cut the open project timeline', () => {
  assert.match(page, /X-Silence-Gaps/);
  assert.match(page, /The video is shorter by/);
});

test('sound effects tab adds clips that never stop the music', () => {
  assert.match(html, /id="subSfx"/);
  assert.match(html, /id="section-sfx"/);
  assert.match(html, /id="btnAddSfx"/);
  assert.match(html, /id="sfxTracksList"/);
  assert.match(html, /They never stop it/);
  assert.match(html, /Opens your device audio files/);
  assert.match(page, /function renderSfxTracks/);
  assert.match(page, /function clipTypeLabel/);
  assert.match(page, /pendingAudioType='sfx'/);
  assert.match(page, /showAudioSub\('sfx'\)/);
  // Only a new song stops the old song; sound effects never truncate music.
  assert.match(page, /if \(type==='music'\) for \(const c of project\.clips\.filter\(c=>c\.type==='music'\)\)/);
  // Merge keeps sound effects out so spot effects survive.
  assert.match(page, /c\.type === 'music' \|\| c\.type === 'voiceover'/);
});

test('ducking waits out short pauses and hears the enhanced track', () => {
  assert.match(html, /id="duckingSilenceWait"/);
  assert.match(html, /Music rises after silence of/);
  for (const v of ['0', '1', '2', '3', '5']) {
    assert.match(html, new RegExp(`<option value="${v}">[^<]+<\\/option>`));
  }
  assert.match(page, /ducking\.silenceWait/);
  assert.match(page, /duckSilenceStart/);
  assert.match(page, /!c\.isEnhancedOriginal/);
  assert.match(page, /function liveVoiceClipActive/);
  assert.match(page, /function tapSpeaking/);
});

test('export survives deletes: readiness wait, frame tolerance, reconnect', () => {
  assert.match(html, /id="reconnectVideoBox"/);
  assert.match(html, /id="btnReconnectVideo"/);
  assert.match(html, /id="fileVideoReconnect"/);
  assert.match(html, /Your edits are safe/);
  assert.match(page, /function reconnectVideoFile/);
  assert.match(page, /The video picture is not loaded\. Play the video once, then export again\./);
  assert.match(page, /The video picture dropped out during export/);
  assert.match(page, /badFrames/);
  assert.match(page, /The video file is no longer attached to this project/);
});

test('noise reduction previews only the kept timeline after deletes', () => {
  assert.match(page, /function sliceBufferRetained/);
  assert.match(page, /function expandBufferRetained/);
  assert.match(page, /keptRanges/);
  assert.match(page, /retainedPreview/);
  assert.match(page, /previewOriginalUrl/);
  assert.match(page, /previewEnhancedUrl/);
});

test('voice recording rescues a busy mic with retry and plain words', () => {
  assert.match(page, /recordErrorHint\(e\?\.name\)/);
  assert.match(page, /enumerateDevices/);
  assert.match(page, /one waited retry/);
  assert.match(page, /microphone is muted\. Unmute it/);
});

test('ducking offers strong levels, plain dip-and-rise words, live speech check', () => {
  for (const v of ['60', '70', '80']) {
    assert.match(html, new RegExp(`<option value="${v}">${v}%<\\/option>`));
  }
  assert.match(html, /music goes down/);
  assert.match(html, /comes back up/);
  assert.match(page, /function liveVoiceActive/);
  assert.match(page, /liveVoiceActive\(\)/);
});

test('mic recording falls back to the basic mic and wrapper declares audio settings', () => {
  assert.match(page, /echoCancellation:false/);
  assert.match(page, /basic microphone mode/);
  assert.match(page, /micAttempts/);
  assert.match(page, /avAttempts/);
  const manifest = fs.readFileSync(path.join(root, 'flutter_app/android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /MODIFY_AUDIO_SETTINGS/);
});

test('audio-only uploads export with a still background', () => {
  assert.match(page, /audioOnly/);
  assert.match(page, /drawAudioOnlyFrame/);
  assert.match(page, /Audio file loaded\. No video picture/);
  assert.match(page, /still background is used/);
});

test('export verifies length, retries short phone recordings, clears stale files', () => {
  assert.match(page, /mimeCandidates/);
  assert.match(page, /measureBlobDuration/);
  assert.match(page, /exportLooksShort/);
  assert.match(page, /That recording came out short/);
  assert.match(page, /Saved as WebM because/);
  assert.match(page, /exportedBlob = null;/);
  assert.match(page, /lastChunkAt/);
  assert.match(page, /formatExportLength/);
  assert.match(page, /btnDoExport'\)\.addEventListener\('click', \(\)=>doExport\(0\)\)/);
  assert.doesNotMatch(page, /addEventListener\('click', doExport\)/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = fs.readFileSync(path.join(root, 'flutter_app/android/app/src/main/AndroidManifest.xml'), 'utf8');
const wrapper = fs.readFileSync(path.join(root, 'flutter_app/lib/main.dart'), 'utf8');
const page = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('Android source declares only the app permissions it uses and keeps camera hardware optional', () => {
  const declared = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*\/>/g)]
    .map((match) => match[1]).sort();
  assert.deepEqual(declared, [
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECORD_AUDIO',
  ]);
  assert.match(manifest, /android\.hardware\.camera(?:\.any)?" android:required="false"/);
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA_|ACCESS_FINE_LOCATION|READ_CONTACTS/);
});

test('WebView camera and microphone grants remain restricted to the VoiceCut origin', () => {
  assert.match(wrapper, /const siteOrigin = 'https:\/\/mahicouragw\.github\.io'/);
  assert.match(wrapper, /request\.origin\.origin == siteOrigin/);
  assert.match(wrapper, /final captureResources = <PermissionResourceType>\{/);
  assert.match(wrapper, /request\.resources\.every\(captureResources\.contains\)/);
  assert.match(wrapper, /Permission\.camera\.request\(\)/);
  assert.match(wrapper, /Permission\.microphone\.request\(\)/);
  assert.match(page, /navigator\.mediaDevices\.getUserMedia\(\{video:\{facingMode:'environment'\},audio:true\}\)/);
  assert.match(page, /blob\.size > 500 \* 1024 \* 1024/);
  assert.match(page, /requestNotificationPermission/);
});

test('accessible reload flushes and restores the open project after page reload', () => {
  assert.match(html, /id="btnReloadApp"[^>]*>↻ Reload/);
  assert.match(page, /sessionStorage\.setItem\('voicecut_reload_project', project\.id\)/);
  assert.match(page, /openProjectById\(reloadProjectId\)/);
  assert.match(page, /Cannot reload safely because the project could not be saved/);
});

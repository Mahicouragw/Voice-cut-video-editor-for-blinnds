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
  assert.match(page, /noiseReduction: type==='music' \? 'off'/);
});

test('server silence results cut the open project timeline', () => {
  assert.match(page, /X-Silence-Gaps/);
  assert.match(page, /The video is shorter by/);
});

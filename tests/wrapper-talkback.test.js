const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dart = fs.readFileSync(path.join(root, 'flutter_app/lib/main.dart'), 'utf8');
const page = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('app wrapper keeps TalkBack inside the page with a reload button', () => {
  assert.match(dart, /useHybridComposition: true/);
  assert.match(dart, /tooltip: 'Reload page'/);
  assert.match(dart, /SemanticsService\.announce\('VoiceCut editor loaded\.'/);
  assert.match(dart, /then tap Retry\./);
  assert.match(dart, /ElevatedButton\(onPressed: retry/);
});

test('opening a project puts the screen-reader cursor on Play', () => {
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(page, /\$\('#btnPlay'\)\?\.focus\(\{preventScroll:true\}\)/);
});

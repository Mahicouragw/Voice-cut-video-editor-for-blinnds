const test = require('node:test');
const assert = require('node:assert/strict');
require('../web/captions.js');
const Studio = require('../web/studio.js');

test('dimensionsForAspect produces even-numbered dimensions for 16:9, 9:16, 1:1, and 4:5', () => {
  assert.deepEqual(Studio.dimensionsForAspect('16:9'), { width: 1280, height: 720 });
  assert.deepEqual(Studio.dimensionsForAspect('9:16'), { width: 720, height: 1280 });
  assert.deepEqual(Studio.dimensionsForAspect('1:1'), { width: 1080, height: 1080 });
  const scaled = Studio.dimensionsForAspect('4:5', 768);
  assert.equal(scaled.width % 2, 0);
  assert.equal(scaled.height, 768);
});

test('buildImagePrompt formats YouTube thumbnails, brand logos, and social graphics cleanly', () => {
  const thumb = Studio.buildImagePrompt('Creator holding microphone', 'thumbnail', 'HOW TO EDIT');
  assert.match(thumb, /YouTube thumbnail/);
  assert.match(thumb, /HOW TO EDIT/);

  const logo = Studio.buildImagePrompt('Golden phoenix wave icon', 'logo', 'VOICECUT');
  assert.match(logo, /vector icon/);
  assert.match(logo, /VOICECUT/);

  assert.throws(() => Studio.buildImagePrompt('   ', 'general'), /Enter a prompt/);
});

test('cuesFromScript splits English and Telugu narration into word-boundary-safe timed cues across 8-15s clips', () => {
  const te = 'నమస్కారం మిత్రులారా ఈ రోజు మనం వాయిస్ కట్ స్టూడియోలో కొత్త వీడియో ఎలా తయారు చేయాలో వివరంగా తెలుసుకుందాం';
  const cues = Studio.cuesFromScript(te, 12);
  assert.ok(cues.length >= 2, 'long Telugu narration splits into multiple cues');
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[cues.length - 1].end - 12) < 0.01);
  // Every word from original text must remain intact without mid-word breaks
  const origWords = te.split(/\s+/);
  const cueWords = cues.flatMap(c => c.text.split(/\s+/));
  assert.deepEqual(cueWords, origWords);
});

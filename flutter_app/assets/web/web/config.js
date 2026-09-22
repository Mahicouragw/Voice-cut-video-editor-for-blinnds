/* Developer-configured backend. Normal users never edit this file and never see these values in the UI. */
window.VoiceCutConfig = (() => {
  'use strict';
  // The app owner sets their public backend origin here before deploying.
  // Leave null to ship without cloud AI: the app shows a friendly
  // "temporarily unavailable" message instead of asking users for keys or URLs.
  const BACKEND_URL = null; // e.g. 'https://voicecut-processing.onrender.com'
  // Hidden developer-only override, never linked from the UI and never stored.
  // Open the app with #dev-backend=<encoded-https-url>&dev-key=<key> for this tab only.
  function devOverride() {
    try {
      const hashPart = String(location.hash || '').replace(/^#\/?/, '');
      const query = hashPart.includes('?') ? hashPart.split('?').slice(1).join('?') : hashPart;
      const params = new URLSearchParams(query);
      const url = params.get('dev-backend');
      if (!url) return null;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      return {url: parsed.origin, key: params.get('dev-key') || ''};
    } catch { return null; }
  }
  return {BACKEND_URL, devOverride};
})();

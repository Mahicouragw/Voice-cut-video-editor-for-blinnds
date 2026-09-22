# VoiceCut Studio 2.0 — Accessible shell, project library, crop/rotate/freeze, automatic cloud AI

An accessible-first browser video editor, packaged Android WebView app, and private Node/FFmpeg backend.

**For the requested one-command GitHub device authorization and deployment, see [docs/GITHUB_DEVICE_DEPLOY.md](docs/GITHUB_DEVICE_DEPLOY.md). Run `npm run all` from the prepared repository with GitHub CLI installed.** The 15-minute requirement applies to the pending authorization request, not to deleting your media.

The earlier manual alternative remains in [AI_UPDATE_START_HERE.md](AI_UPDATE_START_HERE.md). For precise key creation/paste instructions, read [docs/API_KEYS_GUIDE.md](docs/API_KEYS_GUIDE.md).

## What is new
- **Simple shell:** HOME, LIBRARY and SETTINGS navigation. The editor opens only after a project is uploaded or opened; a direct editor link with no project shows a friendly “No project is open” view.
- **Project library:** multiple saved projects on the device with open, rename and delete, plus recent projects on Home and a “Project saved” announcement.
- **Crop, rotate and freeze-frame export:** percentage-based crop presets plus custom numbers, 90/180/270-degree rotation, and freeze holds — all honored in the exported video.
- **Automatic AI, no provider menus:** captions need only Generate plus a language and speech source; the backend automatically prefers free Groq, then Deepgram, AssemblyAI, then OpenAI. Noise reduction offers Off/Light/Medium/Strong/Voice Focus with Original/Processed compare, and Reduce Noise automatically uses on-server DeepFilterNet AI, then ElevenLabs cloud isolation, then on-device filters.
- **No credentials in the user UI:** provider keys live only in backend environment variables. The normal Settings hold only accessibility and editing preferences. The owner connects a backend by setting `BACKEND_URL` in `web/config.js` (or a session-only `#dev-backend`/`#dev-key` page address for testing).
- Friendly failures (“Caption generation is temporarily unavailable…”) with Retry, per-request upload consent, cancel/timeout handling and no automatic paid retries.

Cloud features require your own provider accounts and may cost money. No paid account, API keys or public deployment have been created for you. Automated tests use mocked external responses; live provider quality must be tested after setup. Ordinary editing, manual captions and local filters need no provider key.

## Source layout
- `index.html`: semantic interface and accessible forms.
- `web/app.js`: editing, preview, recording, media routing, caption UI, export and network controls.
- `web/styles.css`: visual styles.
- `web/captions.js`: pure timing, grouping, serialization and canvas caption rendering.
- `web/core.js`: tested ranges, crop math, MIME and expiry helpers.
- `web/config.js`: baked backend URL (empty by default) plus the hidden session-only page-address override.
- `web/storage.js`: IndexedDB media and caption persistence.
- `server/server.js`: authenticated multipart routes, FFmpeg/FFprobe preprocessing, limits and cleanup.
- `server/providers.js`: Groq/Deepgram/AssemblyAI/OpenAI caption and ElevenLabs isolation contracts, bounded responses and safe error handling.
- `flutter_app/lib/main.dart`: Android microphone permission, local asset loading and video/subtitle sharing.
- `scripts/android-signing.py`: private signing configuration helper.
- `.github/workflows/`: website tests/deployment, debug APK, explicitly requested signed AAB.

## Local website
With Node.js 22:
```bash
npm ci
npm start
```
Open http://localhost:3000 on that computer. Hosted recording requires HTTPS. `npm run build` writes only public assets to `dist/`; it never publishes backend secrets.

## Backend configuration
Deploy the root Dockerfile on your authorized host, or install Node 22 and FFmpeg/FFprobe locally. Read the key guide before spending money.

Server environment variables:
```dotenv
GROQ_API_KEY=replace_privately_on_your_backend
DEEPGRAM_API_KEY=replace_privately_on_your_backend
ASSEMBLYAI_API_KEY=replace_privately_on_your_backend
OPENAI_API_KEY=replace_privately_on_your_backend
ELEVENLABS_API_KEY=replace_privately_on_your_backend
SERVER_ACCESS_KEY=your_separate_random_64_character_key
ALLOWED_ORIGIN=https://mahicouragw.github.io
ALLOW_ANDROID_APP=true
MAX_AI_REQUESTS_PER_HOUR=20
```
These are placeholders, not usable credentials. Do not commit real values. GitHub Pages cannot run this backend or keep frontend secrets.

Endpoints:
- `GET /health`: public liveness/version only.
- `GET /capabilities`: requires server access key; checks presence, not provider validity/billing.
- `POST /api/captions?language=te`: requires auth and `X-Upload-Consent: yes`; multipart file field `file`; provider auto-selects groq, deepgram, assemblyai or openai (free tiers first) unless `provider=` overrides it; returns validated timestamped cues.
- `POST /api/isolate`: requires auth and consent; returns normalized processed WAV.
- `POST /api/denoise-local`: authenticated keyless DeepFilterNet AI denoising on your server; no cloud consent or provider account.
- `POST /enhance`: authenticated ordinary FFmpeg filters, not AI.

## Tests
Install FFmpeg/FFprobe before the backend/browser suites:
```bash
npm ci
npm --prefix server ci
npm test
npm --prefix server test
npx playwright install --with-deps chromium
npm run test:browser
```
There are 13 unit tests, 19 backend/provider-contract tests and a Chromium workflow covering the router, library, prefs, recording, on-device and mocked cloud AI (captions with consent and friendly Retry, isolation, neural denoise auto-selection), reviewed SRT/VTT, crop/rotate/freeze export verification, plain export with burn-in, cancel, keyboard, filename escaping and delete storage. See [the report](docs/REPAIR_REPORT.md) for what was and was not verified.

## Limits and honest feature status
- Sources for server processing: maximum **10 minutes and 100 MB**; larger inputs rejected before provider processing. A timeline trim alone does not shorten the uploaded source file.
- Captions describe one chosen source at a time, not all overlapping speech in the final mix. Export/reimport the final mix to caption it. Regenerate or retime captions after moving their source audio clip.
- AI can mishear speech or hallucinate words in silence. Review text and timing, especially names/numbers. This is not speaker identification or automatic translation.
- AI isolation can remove music and alter speech. Listen before applying; keep originals.
- Automated batch cleanup remains unavailable by design: process one clip at a time and preview before applying. No claim that every possible repository issue is resolved.
- Multiple projects are saved locally in the browser library. Browser storage quotas or data clearing can remove them; keep original media and exported files.
- Export is real time and the tab must remain visible. Formats/codecs vary; unsupported MP4 recording fails clearly rather than renaming WebM. Large/4K exports can overwhelm mobile devices. Frame-accurate gaps and perfect synchronization are not guaranteed.
- Caption preview and exported appearance can differ with screen size/font support. Unicode text is preserved; verify your language's actual rendering on your device.
- Android native video sharing is limited to 40 MB. SRT/VTT sharing is included; the new APK must be rebuilt. Static analysis passed; physical Android, TalkBack and Play release testing are still required.
- This is a **personal** backend with one job at a time, not a multiuser SaaS. The server access key can spend your configured API credits; do not distribute it. The hourly cap is per-process and resets on restart, not a monetary guarantee.

## Privacy and 15-minute expiry
Local editing does not upload media. After cloud consent, the server receives the source file, extracts audio and sends audio to the automatically chosen free-first provider. Server temporary files are deleted on completion/error/disconnect or the 15-minute absolute deadline while running. Crashed/suspended hosts cannot execute cleanup while stopped; leftovers are removed on startup.

**Provider copies/retention and billing are not controlled by our timer.** Cancelling our request does not guarantee a provider refund or stopped provider-side processing. Review provider data policies before using sensitive recordings.

The owner’s `#dev-key` page-address override lives only in the current tab and is forgotten on reload; host environment/provider keys remain valid until their own expiry/rotation/revocation. Local saved projects and downloaded media do not automatically expire. GitHub sign-in waiting has a separate 15-minute helper timeout, not automatic revocation of established GitHub credentials.

## Deployment
- [AI update and patch choices](AI_UPDATE_START_HERE.md)
- [Create keys and paste them correctly](docs/API_KEYS_GUIDE.md)
- [Build Android APK/signed AAB](docs/PLAY_STORE_GUIDE.md)

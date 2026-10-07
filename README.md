# VoiceCut Studio 2.8 — Accessible editor, camera capture, reload, captions and media trimming

An accessible-first browser video editor, packaged Android WebView app, and private Node/FFmpeg backend.

**For the requested one-command GitHub device authorization and deployment, see [docs/GITHUB_DEVICE_DEPLOY.md](docs/GITHUB_DEVICE_DEPLOY.md). Run `npm run all` from the prepared repository with GitHub CLI installed.** The 15-minute requirement applies to the pending authorization request, not to deleting your media.

The earlier manual alternative remains in [AI_UPDATE_START_HERE.md](AI_UPDATE_START_HERE.md). For precise key creation/paste instructions, read [docs/API_KEYS_GUIDE.md](docs/API_KEYS_GUIDE.md).

## What is new
- **Android APK 2.8.0 (version code 12):** camera video capture, microphone recording, opt-in completion notifications, an accessible reload action that saves and restores the open project, and the editor loaded from the live website.
- **Camera capture:** Record Video uses the device camera and microphone only after the user taps Start. The recording can be previewed, discarded, or loaded as the project's source video.
- **Editing:** video trim/split/marked-range edits, audio clip trimming and track controls, automatic captions with review and SRT/VTT export, and local video export.
- **Simple shell:** HOME, LIBRARY and SETTINGS navigation. The editor opens only after a project is uploaded or opened; a direct editor link with no project shows a friendly “No project is open” view.
- **Project library:** multiple saved projects on the device with open, rename and delete, plus recent projects on Home and a “Project saved” announcement.
- **Crop, rotate and freeze-frame export:** percentage-based crop presets plus custom numbers, 90/180/270-degree rotation, and freeze holds — all honored in the exported video.
- **Automatic AI, no provider menus:** captions need only Generate plus a language and speech source; the backend automatically prefers free Groq, then Deepgram, AssemblyAI, then OpenAI. Noise reduction offers Off/Light/Medium/Strong/Voice Focus with Original/Processed compare, and Reduce Noise automatically uses on-server DeepFilterNet AI, then ElevenLabs cloud isolation, then on-device filters.
- **No credentials in the user UI:** provider keys live only in backend environment variables. The normal Settings hold only accessibility and editing preferences. The owner connects a backend by setting `BACKEND_URL` in `web/config.js` (or a session-only `#dev-backend`/`#dev-key` page address for testing).
- Friendly failures (“Caption generation is temporarily unavailable…”) with Retry, per-request upload consent, cancel/timeout handling and no automatic paid retries.

Cloud features require your own provider accounts and may cost money. No paid account, API keys or public deployment have been created for you. Automated tests use mocked external responses; live provider quality must be tested after setup. Ordinary editing, manual captions and local filters need no provider key.

## Android permissions and APK
The manifest declares internet, camera, microphone, and Android 13+ notification permission. Camera and microphone permission prompts appear only after the user taps **Record Video**; microphone permission for voice-over recording is still requested only when recording. Notifications are requested only when enabling completion alerts. Camera hardware is optional, and files are selected through Android's system picker, so the app does not request broad storage/photo-library access or unrelated game permissions.

The Android app version is `2.8.0+12`. Use the **Android test APK and optional signed AAB** GitHub Actions workflow to build the debug APK; see [the Android build guide](docs/PLAY_STORE_GUIDE.md). Debug APKs are for testing/distribution outside Play, not a Play Store release. The APK loads the live website, so it needs internet; website updates apply to installed apps after the Pages deployment, without reinstalling.

## Source layout
- `index.html`: semantic interface and accessible forms.
- `web/app.js`: editing, preview, recording, media routing, caption UI, export and network controls.
- `web/styles.css`: visual styles.
- `web/captions.js`: pure timing, grouping, serialization and canvas caption rendering.
- `web/core.js`: tested ranges, crop math, MIME and expiry helpers.
- `web/config.js`: owner-configured backend URL plus the hidden session-only page-address override.
- `web/storage.js`: IndexedDB media and caption persistence.
- `server/server.js`: authenticated multipart routes, FFmpeg/FFprobe preprocessing, limits and cleanup.
- `server/providers.js`: Groq/Deepgram/AssemblyAI/OpenAI caption and ElevenLabs isolation contracts, bounded responses and safe error handling.
- `flutter_app/lib/main.dart`: trusted-origin camera/microphone permission handling, notification bridge, live-website WebView and video/subtitle sharing.
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
The root Node suite has 38 unit tests. The Chromium workflow also exercises the router, library, preferences, microphone and camera capture, reload/project restore, local and mocked cloud AI, captions/SRT/VTT, video/audio editing and export. Server/provider tests run separately. The current workspace verification and what still needs a device build/test are documented in [the report](docs/REPAIR_REPORT.md).

## Limits and honest feature status
- Sources for server processing: maximum **10 minutes and 100 MB**; larger inputs rejected before provider processing. A timeline trim alone does not shorten the uploaded source file.
- Captions describe one chosen source at a time, not all overlapping speech in the final mix. Export/reimport the final mix to caption it. Regenerate or retime captions after moving their source audio clip.
- AI can mishear speech or hallucinate words in silence. Review text and timing, especially names/numbers. This is not speaker identification or automatic translation.
- AI isolation can remove music and alter speech. Listen before applying; keep originals.
- Automated batch cleanup remains unavailable by design: process one clip at a time and preview before applying. No claim that every possible repository issue is resolved.
- Multiple projects are saved locally in the browser library. Browser storage quotas or data clearing can remove them; keep original media and exported files.
- Export is real time and the tab must remain visible. Formats/codecs vary; unsupported MP4 recording fails clearly rather than renaming WebM. Large/4K exports can overwhelm mobile devices. Frame-accurate gaps and perfect synchronization are not guaranteed.
- Caption preview and exported appearance can differ with screen size/font support. Unicode text is preserved; verify your language's actual rendering on your device.
- Android native video sharing is limited to 40 MB. SRT/VTT sharing is included. The 2.8 APK must be rebuilt; Flutter/Gradle compilation and physical Android/TalkBack testing are still required.
- This is a **personal** backend with one job at a time, not a multiuser SaaS. The server access key can spend your configured API credits; do not distribute it. The hourly cap is per-process and resets on restart, not a monetary guarantee.

## Privacy and 15-minute expiry
Local editing does not upload media. After cloud consent, the server receives the source file, extracts audio and sends audio to the automatically chosen free-first provider. Server temporary files are deleted on completion/error/disconnect or the 15-minute absolute deadline while running. Crashed/suspended hosts cannot execute cleanup while stopped; leftovers are removed on startup.

**Provider copies/retention and billing are not controlled by our timer.** Cancelling our request does not guarantee a provider refund or stopped provider-side processing. Review provider data policies before using sensitive recordings.

The owner’s `#dev-key` page-address override lives only in the current tab and is forgotten on reload; host environment/provider keys remain valid until their own expiry/rotation/revocation. Local saved projects and downloaded media do not automatically expire. GitHub sign-in waiting has a separate 15-minute helper timeout, not automatic revocation of established GitHub credentials.

## Deployment
- [AI update and patch choices](AI_UPDATE_START_HERE.md)
- [Create keys and paste them correctly](docs/API_KEYS_GUIDE.md)
- [Build Android APK/signed AAB](docs/PLAY_STORE_GUIDE.md)

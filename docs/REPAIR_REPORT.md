# VoiceCut 1.2 — AI update verification

## Added and repaired in this update
- Documented OpenAI `/v1/audio/transcriptions` integration, using `whisper-1`, `verbose_json` and word/segment timestamps; optional language hint, grouped editable cues, retained-source timing and explicit human review.
- Documented ElevenLabs `/v1/audio-isolation` integration. Server-only provider secrets; no fake neural-model fallback.
- Captions rendered on preview and directly into canvas-recorded exports. SRT/VTT timing follows trim, retained segments and speed. Safe text rendering, editable timing/text, local persistence and Android subtitle sharing.
- Connection/configuration check, separate server access secret, upload/cost consent, single-job concurrency, hourly attempt limit, no automatic paid retries, explicit provider-auth/quota errors.
- Server rejects recordings over 10 minutes instead of truncating silently. Normalizes extracted audio before provider requests; aligns delayed audio tracks; rejects gross isolation output duration drift.
- Absolute local request deadline aborts provider fetches, kills local FFmpeg children and removes temporary files. It does not control provider retention or refunds.
- In-flight results invalidated on project changes, export controls locked until completion/cancel, disconnected replaced audio nodes, and preview skips deleted source gaps.

## Tests run for version 1.2
- **12 Node unit/build tests passed**, including caption grouping, Hindi/Telugu text handling, cut/speed timestamp mapping, SRT/VTT escaping and validation, plus previous core tests.
- **10 backend tests passed**, including provider request contracts, explicit consent, configuration/authentication, sanitized quota/auth errors, no automatic retries, real local FFmpeg processing, simulated AI response conversion, cleanup and a shortened absolute-deadline abort test.
- **Chromium integration passed**: import/save/reload, undo, simulated microphone recording, generated captions with mocked API response, manual edits, SRT/VTT download, local caption persistence, provider failure leaving previous captions intact, mocked isolation, two real WebM exports. Frames decoded with FFmpeg contained white caption glyphs over the solid-blue fixture, confirming burn-in rather than merely a UI overlay. Cancellation, keyboard handling, hostile filename escaping, deleting saved projects and server-key removal on reload were also tested.
- Flutter 3.41.2 dependency resolution and `flutter analyze --no-fatal-infos`: **No issues found**.
- Dependency audits reported no known vulnerabilities at the time checked.

## What these tests do NOT establish
No real OpenAI or ElevenLabs request was made: no user API keys were supplied, no paid usage authorized, and no live transcription/denoising quality measured. Provider-contract tests use simulated responses. Actual API entitlement, key validity, billing and output quality must be checked with a short real recording after setup.

No permanent GitHub/Render deployment, Android APK/AAB build, native device/TalkBack/VoiceOver certification, Play Store publication, extended load test or regulatory erasure guarantee was performed. Browser frame checks do not prove perfect audiovisual sync or readability across every font/device. Cropping, rotation, freeze-frame and batch cleanup remain unimplemented and disabled. Captions cover one selected source; final-mix captions require exporting/reimporting that mix. Provider retention and billing are outside our 15-minute local cleanup timer.

---

# Historical report: version 1.1 (before this AI update)

The following is retained as a record of the previous repair, not a description of the new provider features.

# Repair and test report

Inspected upstream main at `dc77c7d8c15fba5c3912e63e19ae1ff27192f208`. This is a bounded repair pass, not a guarantee that every possible issue is fixed.

## Observed and addressed
| Finding | Change |
|---|---|
| HTML contained styling and thousands of JS lines | Separate web CSS, app logic, core helpers, and IndexedDB storage |
| Fake local neural-model claims / missing model assets | Remove imaginary models, document and label actual filter processing |
| Broken cloud endpoints / incomplete provider implementations | Remove unsupported paid-provider code; authenticated optional FFmpeg service |
| API keys stored in localStorage and sent from browser directly to provider | Remove old persisted provider keys; optional server key held in memory with expiry |
| Snapshot strips actual media and keeps stale blob URLs | IndexedDB stores media blobs; URLs regenerated on restore; errors surfaced |
| Undo loses deleted media / stale audio nodes continue playing | Structured-clone history, recreate/disconnect playback nodes |
| Repeated export creates a second MediaElementSource for the same video | Reuse source and route the same clip graph to export, with teardown |
| Codec fallback mislabeled as MP4 | Respect requested format or fail clearly; actual MIME determines filename |
| Cancel runs success handler | Separate cancellation flag; no new partial export offered |
| Deleted video segments ignored on export | Intersect retained segments with trim; seek across removed gaps |
| Fades calculated but not applied, track speed out of sync | Apply gain and playback rate during preview/export |
| Audio cleanup uses variables outside their block scope | Replace both processing paths with a common bounded implementation |
| Recording MIME hardcoded, asynchronous clip positioning race, microphone retained | Actual recorder MIME, explicit position parameter, stop/close cleanup |
| Global Space shortcut steals button activation | Leave native controls and dialogs to native keyboard behavior |
| Filenames interpolated as markup | Escape untrusted names before HTML interpolation; browser regression test |
| Server uploads/results not consistently deleted, no auth/deadline | Secret authentication, origin allowlist, concurrency/size limits, absolute deadline and cleanup |
| Android missing scaffold and references to nonexistent assets/fonts | Generate/include valid scaffold; package current JS/CSS assets only |
| Flutter duplicate named argument and broad auto-permission grants | Reworked wrapper; microphone-only trusted-origin permission on request |
| AAB automatically described as Play-ready without proper signing | Debug APK separate; signed AAB opt-in with four secrets and no auto-publish |
| Deploy publishes server/docs alongside app | Explicit public-only web build; GitHub Pages OIDC workflow |
| CLI deploy implies auth success or waits indefinitely | Fail on missing auth/workflow, 15-minute new sign-in timeout, link to actual run status |

## Verification actually performed
- Node syntax checks for web application logic.
- **6 Node unit/build tests passed**: expiry boundary, segment trim intersections, invalid ranges, empty ranges, codec choice/extension, public-only build.
- **2 backend tests passed**: invalid configuration; authenticated/CORS-protected processing of real audio, invalid input rejection, completion/error cleanup.
- **Chromium integration script passed**: generate/import actual video and audio; save+reload media; delete+undo; record actual MediaRecorder audio using a simulated microphone; process and apply original audio; verify original muted; two successive actual WebM exports with video+audio streams; export cancellation; Space activation on focused button; malicious filename escaping; project deletion.
- `npm audit` and `npm --prefix server audit` reported **0 known vulnerabilities at the time of checking**. Future advisories can change this result.
- Flutter 3.41.2 source prepared and dependencies resolved; `flutter analyze --no-fatal-infos` reported **No issues found**.

## Not verified here
- GitHub Actions permissions, actual Pages deployment, Render deployment, provider account approvals.
- Android Gradle/APK/AAB build, signing with your real keystore, physical Android device behavior, native share destinations, Play Console acceptance.
- Human TalkBack/VoiceOver testing or comprehensive accessibility conformance.
- MP4 recording across browsers, long recordings, 4K/60 FPS export, low-memory devices, every supported input codec.
- Wall-clock 15-minute upload simulation, crash-at-deadline fault injection, deployment device-code approval/rejection with a real GitHub login.
- Perfect audiovisual synchronization, frame-accurate gap transitions or perceptual audio quality. Export test verifies stream presence, not all signal properties.

## Remaining functional limits
Crop, rotate, freeze-frame, automatic batch cleanup and full project libraries are not implemented and are disabled/documented. Preview does not yet reproduce deleted segment gaps exactly like export. Cleanup is DSP, not neural AI. The server processes only the first ten minutes. See README for limits before public release.

# VoiceCut 1.2 — real AI captions and voice isolation

## What this update adds
- OpenAI Whisper automatic, editable timestamped captions with automatic language detection or a chosen language hint.
- Captions on preview and burned into video exports, plus SRT and VTT downloads.
- ElevenLabs AI Voice Isolator as a separate, explicit cleanup option. Local/FFmpeg filters remain available and honestly labeled as not AI.
- Private provider keys on your backend, server connection checks, clear authorization/quota errors, cancellation, no automatic paid retries, and 15-minute local server-copy lifetime.
- Android subtitle sharing and configured origin support for its packaged editor.
- Additional fixes: export controls locked during recording, old requests invalidated on project changes, preview skips deleted source gaps, delayed audio aligned when preparing provider input, gross isolation timing drift rejected, and no silent truncation of long input.

**Status:** code and automated tests are provided. No repository push, permanent deployment, paid provider request or Play Store publication has been performed on your behalf. Genuine provider quality/billing must be checked using your own keys and a short recording. Not every remaining editor feature is implemented; crop/rotate/freeze-frame and batch cleanup remain disabled.

## 1. Download the right file
- `voicecut-ai-update.zip`: complete updated source and all instructions.
- `voicecut-ai-full.patch`: use **only if you have not applied the earlier repair**. Applies to original upstream commit `dc77c7d8c15fba5c3912e63e19ae1ff27192f208`.
- `voicecut-ai-upgrade.patch`: use **only if your repository already contains the earlier 1.1 repair exactly as supplied**.

**Do not apply both patches.** If you edited the files independently, patch validation may fail. Stop and share the error text (no secrets) rather than using force/reset. Keep your original videos and project backups.

## 2. Open your GitHub workspace
1. Open [VoiceCut Codespaces](https://codespaces.new/Mahicouragw/Voice-cut-video-editor-for-blinnds) while signed into your own GitHub account. Review Codespaces allowance/billing.
2. Start from the branch containing the version you currently use. If the previous repair is still in a pull-request branch, start from that branch for the upgrade patch, or merge it first after checks pass.
3. Upload the correct `.patch` file into the repository folder beside `package.json`.
4. Open Terminal. Run `git status`. If there are unrelated uncommitted changes, commit or back them up first.

## 3. Apply on a new branch

If you **have not installed the earlier repair**, paste:

```bash
set -e
git switch -c feature/voicecut-ai-captions
git apply --check voicecut-ai-full.patch
git apply voicecut-ai-full.patch
npm ci
npm test
```

If you **already installed the earlier repair**, paste this block instead:

```bash
set -e
git switch -c feature/voicecut-ai-captions
git apply --check voicecut-ai-upgrade.patch
git apply voicecut-ai-upgrade.patch
npm ci
npm test
```

The `--check` step must succeed. If a branch with this name already exists, choose a new branch name; do not delete existing work to reuse it.

## 4. Review, push and create a pull request

```bash
set -e
git diff --stat
git add .github .gitignore .dockerignore Dockerfile render.yaml \
  README.md START_HERE.md AI_UPDATE_START_HERE.md \
  PUSH_TO_GITHUB.md REAL_AI_SETUP_CLICKABLE.md docs \
  index.html package.json package-lock.json web server scripts tests flutter_app
git diff --cached --stat
git commit -m "Add timed AI captions, subtitle export and private AI voice isolation"
git push -u origin feature/voicecut-ai-captions
```

Review the staged filenames; no `.env`, keystore, passwords or provider keys should be present. The patch itself does not need to be committed.

Open [Create AI update pull request](https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/compare/main...feature/voicecut-ai-captions?expand=1). Wait for website tests and the Android debug-build checks. If you branched from an unmerged earlier repair branch, the pull request to main includes both repairs; review accordingly.

## 5. Publish website and backend
1. [Pages settings](https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/settings/pages) → Source: **GitHub Actions**.
2. Merge the reviewed pull request after checks pass. If the environment requires approval, its authorized reviewer must approve.
3. [Actions](https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/actions) → **Test and deploy website** → wait for successful test/build and deploy. Do not treat “pending” as completed.
4. Expected website address after successful deployment: [VoiceCut](https://mahicouragw.github.io/Voice-cut-video-editor-for-blinnds/).
5. **AI needs the private backend too.** Follow [the key creation and exact paste-location guide](docs/API_KEYS_GUIDE.md). It explains OpenAI, ElevenLabs, Render environment variables and the editor's separate server access key.
6. For Android, run the workflow in [the Android guide](docs/PLAY_STORE_GUIDE.md); download a new APK because it packages this version of the website. An older APK will not gain captions simply because Pages was updated.

`npm run deploy` is still available to request the Pages workflow after it is merged. It is not needed for each main-branch commit and does not deploy the backend. It cannot make failed authorization succeed; inspect the actual Actions log.

## 6. Your first short live test
1. Create provider keys and configure backend variables as documented.
2. In the editor, enter the backend URL and **SERVER_ACCESS_KEY**, then Check connection.
3. Import a 10–20 second non-sensitive recording of clear speech.
4. Generate captions with consent. Review/edit them, download SRT/VTT, and export a video with captions enabled.
5. Select **ElevenLabs AI Voice Isolator** in Settings, process that recording with separate consent, and compare original/processed speech before Apply.
6. Check provider usage dashboards. If something fails, share the error text and failing feature, **not the key**.

## 7. Verification included
- 12 Node unit/build tests.
- 10 backend/provider-contract tests, including real local FFmpeg work and a shortened deadline test for abort/cleanup. External provider responses are simulated.
- Chromium workflow: saved media, recording, undo, generated/editable captions using a mocked provider, SRT/VTT downloads, provider-error preservation, isolation response handling, local caption persistence, two real video exports with frame-pixel verification that captions are burned in, cancellation and key-memory behavior.
- Flutter static analysis with no issues. Android APK/AAB build and physical TalkBack/VoiceOver tests are still needed.

See [the repair report](docs/REPAIR_REPORT.md). Automated tests do not establish actual speech-recognition accuracy, perceptual noise-removal quality, perfect audiovisual synchronization or complete accessibility compliance.

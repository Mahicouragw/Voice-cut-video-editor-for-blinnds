# Android: test APK first, signed AAB second

The Android wrapper version is **2.8.0+12**. The camera capture and permission changes require a fresh build. A GitHub Actions build is required here because this workspace does not include the Android SDK/Flutter toolchain. A successful compile is not the same as a tested app or guaranteed Play Store approval.

## 1. Build a debug APK without secrets
1. Merge the repair after pull-request checks pass. The PR also requests an Android debug build.
2. Open [repository Actions](https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/actions).
3. Select **Android test APK and optional signed AAB** → **Run workflow**.
4. Choose main. Leave **signed_release** unchecked.
5. Wait for green. A pending job is not a completed build. Android is allowed up to 30 minutes for dependency downloads/build; this is separate from the 15-minute sign-in/file-retention policies.
6. Open the run → **Artifacts** → download `voicecut-debug-apk-NOT-FOR-PLAY-STORE`. Unzip it.
7. On your Android test device, install `app-debug.apk` if you are comfortable granting install permission to your file manager. Never disable Play Protect globally.
8. Test picking and recording video, voice-over recording, camera/microphone/notification denial and grant paths, TalkBack traversal, project reload/persistence, automatic captions (with the configured backend), video/audio trimming, editing, cancelling export and saving/sharing an actual video. WebView camera support, codecs and export performance vary by Android version and device.

The app loads the live VoiceCut website, so website updates apply to installed apps after the Pages deployment without reinstalling. An internet connection is required. Camera and microphone permissions are requested only after the user taps **Record Video**; microphone permission for voice-over is requested only when recording. Permission requests are restricted to the trusted website origin. Notification permission is requested only if you enable completion notifications in Settings. Camera hardware is optional. It does not request broad media-library/storage permissions or unrelated game permissions; file selection uses the WebView/system picker. The webpage has an accessible **Reload** button that saves and restores the current project after reload. The editor fills the whole screen with no separate native header, so TalkBack swipe navigation starts inside the page content instead of stopping on an app bar. App 2.8 pins a permanent debug signing key in the repo, so debug updates install over each other.

## 2. Important limitations
- Since app version 2.1 the website is loaded from its address, not packaged inside. Updating the website updates every installed app after Pages deployment; rebuild the APK only when the wrapper itself (permissions, sharing, version) changes.
- Export capability depends on Android WebView and device performance. Update Android System WebView/Chrome where available.
- Native sharing is limited to 40 MB to bound the binary bridge's memory usage. Open the deployed website in Chrome for bigger exports.
- Native temporary sharing files are deleted after the system share sheet completes. Process termination can interrupt this; Android may retain cache until cleared. The 15-minute server-file rule is about the optional processing server, not files saved by the user to their device.
- The shared media must be tested with the receiving app. Make sure a copied file opens after VoiceCut closes.
- The app uses the same HTTPS website origin as the browser version, so the backend needs no separate Android origin flag. Provider keys stay on that backend; the owner connects it through the same private page-address override as on desktop.
- Retain the correct application ID and signing key if updating an app that already exists in Play Console. The new scaffold defaults to `com.mahicouragw.voicecut_studio`. **Do not replace a previously published app's ID blindly.**

## 3. Create an upload keystore, privately
Skip this if you already have the upload key for an existing Play app. Reuse its correct key instead. Java's `keytool` is available in Codespaces if a JDK is installed, or on a computer with a JDK.

In a trusted terminal outside public source files:
```bash
keytool -genkeypair -v \
  -keystore "$HOME/voicecut-upload.jks" \
  -alias voicecut \
  -keyalg RSA -keysize 2048 -validity 10000
```
It asks for a strong keystore password, your certificate details and possibly a key password. Keep the passwords and `.jks` file in a private backup. Losing the upload key complicates updates. Do not include passwords in shell command lines.

Generate a Base64 file:
```bash
python3 - <<'PY'
from pathlib import Path
import base64
key = Path.home() / 'voicecut-upload.jks'
(Path.home() / 'voicecut-upload.base64').write_text(base64.b64encode(key.read_bytes()).decode())
print('Private Base64 file created in your home folder. Do not commit it.')
PY
```
Open that private file locally and copy its entire one-line contents. Base64 is not encryption: treat it exactly like the keystore.

## 4. Paste four secrets in GitHub, not source code
Open [Repository Actions secrets](https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/settings/secrets/actions).

Select **New repository secret** once for each row:

| Secret name — copy exactly | Value to paste |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Entire contents of the private Base64 file |
| `ANDROID_KEYSTORE_PASSWORD` | Password entered for the keystore |
| `ANDROID_KEY_ALIAS` | `voicecut`, unless you used another alias |
| `ANDROID_KEY_PASSWORD` | Password for that alias, often the same as the keystore password |

Secret values are not printed by the signing helper. They are exposed to the release step only, not to the Pages build or pull-request builds. The job removes the temporary keystore afterward.

## 5. Request a signed AAB
1. Actions → **Android test APK and optional signed AAB** → Run workflow.
2. Select main, check **signed_release**, and run.
3. If a secret is missing or the Gradle template does not match, the signing script fails instead of presenting an unsigned/debug-signed bundle as a release.
4. Download the `voicecut-signed-aab` artifact from the successful run.
5. Check the application ID, versionCode and signing certificate. For an existing Play app, the build number must exceed the current versionCode. The workflow uses its run number; adjust `--build-number` if it is too low for your existing app.
6. Open [Google Play Console](https://play.google.com/console), use internal testing first, and upload the AAB. Complete store listing, app access instructions, privacy/data-safety disclosures, content rating, developer verification and all applicable testing requirements. Google determines availability and approval. Developer registration may cost money.
7. Describe features accurately: local filters are not AI; optional OpenAI captions and ElevenLabs AI isolation require a configured backend, separate provider accounts and upload consent. Disclose cloud processing and any charges in the listing/privacy information.

The workflow does not publish to Play automatically and does not create public GitHub releases. Debug and signed artifacts have seven-day retention, **not** 15-minute retention. GitHub artifacts use day-based retention controls; the requested 15-minute timer applies to authorization waits and server media, not build artifacts.

## 6. Local Android build
Install Flutter 3.41.2, Java 17 and an Android SDK, then:
```bash
bash scripts/prepare-android.sh
cd flutter_app
flutter pub get
flutter analyze --no-fatal-infos
flutter build apk --debug
```
The preparation script supplies Gradle wrapper/scaffold files and copies the current website assets; do not maintain a separate hand-edited HTML copy. Signed builds are intentionally not configured by default. Use the reviewed release workflow or provide the same secrets privately for the signing helper.

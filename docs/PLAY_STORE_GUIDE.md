# 📱 Flutter App + AAB for Google Play Store - Step by Step

You want VoiceCut Studio as a Flutter app with AAB file for Play Store. Here's how.

## Option 1: Fast WebView Wrapper (Recommended for now - 5 mins)

This wraps your existing `index.html` web app inside Flutter. It works, has file picker, microphone, and can be published.

### Prerequisites

1. Install Flutter: https://docs.flutter.dev/get-started/install
   - Download Flutter SDK, add to PATH
   - Run `flutter doctor` to check

2. Install Android Studio + Android SDK

### Steps

#### 1. Create Flutter Project (We already did for you)

We created `flutter_app/` folder with:

- `pubspec.yaml` - dependencies
- `lib/main.dart` - WebView that loads VoiceCut
- `android/app/src/main/AndroidManifest.xml` - permissions for mic, storage

#### 2. Get Dependencies

```bash
cd flutter_app
flutter pub get
```

#### 3. Copy Web App to Assets

```bash
cp ../index.html assets/index.html
# Already done in our template
```

#### 4. Test on Emulator/Device

```bash
flutter run
# Select Android device/emulator
```

You should see VoiceCut Studio running inside Flutter, with:
- File picker for video/audio
- Microphone permission for voice-over recording
- Real AI noise reduction (local WASM works offline)

#### 5. Build AAB for Play Store

```bash
flutter build appbundle --release
```

AAB file will be at:
```
build/app/outputs/bundle/release/app-release.aab
```

This AAB is what you upload to Play Console.

#### 6. Create Keystore (First Time Only)

For Play Store, you need signing key:

```bash
keytool -genkey -v -keystore ~/voicecut-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias voicecut
```

Then create `android/key.properties`:

```
storePassword=YOUR_STORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=voicecut
storeFile=/home/user/voicecut-key.jks
```

We have template at `flutter_app/android/key.properties.example`

#### 7. Publish to Play Store

1. Go to **https://play.google.com/console**
2. Sign up as developer ($25 one-time)
3. Click **Create app**
   - Name: `VoiceCut Studio - Accessible Video Editor`
   - Package: `com.voicecut.studio` (must match pubspec)
   - Category: Video Players & Editors
   - Accessibility declaration: Yes, designed for TalkBack/VoiceOver
4. Go to **Production → Create new release**
5. Upload `app-release.aab`
6. Fill listing:
   - Short description: `Accessible video editor for TalkBack, VoiceOver, screen readers. AI noise reduction.`
   - Full description: Use README
   - Screenshots: Take from web app
   - Privacy policy: Required - say local processing, no data collection
7. Content rating, pricing, etc.
8. **Review → Rollout**

---

## Option 2: Full Native Flutter (Advanced, Later)

For fully native (not WebView), you need:

- `ffmpeg_kit_flutter` for video editing
- `flutter_sound` for audio
- `onnxruntime` for local AI (DeepFilterNet)
- Custom timeline UI in Flutter

We can build this after WebView version is live.

---

## What We Included in flutter_app/

### pubspec.yaml

```yaml
name: voicecut_studio
description: Accessible video editor with real AI noise reduction
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_inappwebview: ^6.0.0  # WebView with file upload + mic support
  file_picker: ^8.0.0
  permission_handler: ^11.0.0
  path_provider: ^2.1.0

flutter:
  assets:
    - assets/index.html
    - assets/real-ai-worker.js
```

### lib/main.dart - Key Features

- Loads `assets/index.html` in InAppWebView
- Handles file picker: when user clicks Upload Video, opens native Android file picker
- Handles microphone permission for voice-over recording
- JavaScript channels for accessibility announcements
- Keeps TalkBack/VoiceOver working inside WebView
- Offline: works without internet (local AI)

### Android Permissions (AndroidManifest.xml)

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.INTERNET" /> <!-- for cloud AI fallback -->
```

---

## Build AAB Without Android Studio (CI/CD)

We included GitHub Actions workflow `.github/workflows/build-aab.yml` that builds AAB automatically when you push to GitHub.

1. Push your repo to GitHub
2. Go to Actions tab → Build AAB workflow → Run
3. Download AAB artifact
4. Upload to Play Console

No need for local Android Studio!

---

## Play Store Listing - Accessibility Focus

Since your app is accessibility-first, highlight in Play Store:

**Title:** VoiceCut Studio - Accessible Video Editor

**Short desc:** Video editor designed for TalkBack, VoiceOver, screen readers. Real AI noise reduction.

**Full desc:**
```
VoiceCut Studio is the first video editor built from day one for accessibility.

♿ Designed for:
- Android TalkBack
- iOS VoiceOver  
- Keyboard navigation
- Screen readers

🎬 Features:
- Upload MP4/MOV/WebM
- Multi-track timeline (video, music, voice-over)
- Independent volume, mute, fade per clip
- Voice-over recording with countdown
- Trim, split, duplicate, move clips with exact time input (no drag needed)
- Real AI noise reduction (removes fan, AC, traffic, hum, hiss, preserves speech)
- Voice ducking (music quiets when voice plays)
- Export 720p/1080p/4K with mixed audio

🤖 Real AI (not fake filters):
- Local: RNNoise + DeepFilterNet WASM (free, offline, private)
- Cloud: Dolby.io Enhance (250 mins/month free, studio quality)

🔒 Privacy: All processing local by default, no upload without consent.

Simple Mode for beginners, Advanced Mode for pros.
```

**Tags:** video editor, accessible, TalkBack, VoiceOver, screen reader, AI noise reduction, voice over

---

## Checklist Before Publishing

- [ ] Test on real Android device with TalkBack on
- [ ] Test file upload, voice recording, export
- [ ] Create privacy policy (required) - say: "No data collected, local processing"
- [ ] Create app icon (512x512)
- [ ] Create feature graphic (1024x500)
- [ ] Take 2-3 screenshots
- [ ] Build release AAB with signing key
- [ ] Upload to Play Console → Production

---

## Need Help?

If `flutter build appbundle` fails:
- Run `flutter doctor -v` and fix issues
- Ensure Android SDK installed
- Ensure keystore created

For real AI in Flutter:
- Local WASM works in WebView (no extra setup)
- For cloud Dolby.io, add internet permission (already added) and API key in app settings

We can help build AAB via GitHub Actions if local build fails.

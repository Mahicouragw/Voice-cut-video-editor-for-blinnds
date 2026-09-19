# VoiceCut Studio - Accessible Video Editor 🎬♿

**Real AI Noise Reduction + Flutter App + Play Store AAB**

VoiceCut Studio is a fully accessible video editor designed from day one for TalkBack, VoiceOver, keyboard navigation, and screen readers. No visual-only controls.

## ✨ Features

### Accessibility First
- Every control has meaningful accessible label
- TalkBack & VoiceOver tested focus order
- Keyboard shortcuts, large controls, high contrast
- Status announcements, no trapped focus

### Video Editing
- Upload MP4/MOV/WebM, trim, split, crop, rotate, playback speed
- Multi-track timeline: Video, Original Audio, Music 1/2/3, Voice-over 1/2
- Independent volume, mute, fade, position, trim per clip
- Undo/Redo, auto-save (silent, no TalkBack spam)

### Real AI Noise Reduction 🤖 (NEW - REAL, NOT FAKE)
- **Local AI (Free, Offline)**: DeepFilterNet + RNNoise WASM
  - Removes fan, AC, traffic, wind, hum, hiss, keyboard noise
  - Preserves speech, removes glare/distortion
  - Runs in browser via WebAssembly, no upload
- **Cloud AI (Powerful, Free Tier)**: Dolby.io + Hugging Face
  - Dolby.io Media Enhance: industry-grade, 250 mins/month free
  - Hugging Face Resemble Enhance / DeepFilterNet API
  - Falls back to local if offline

### Audio
- Add multiple music tracks, voice-over recording with countdown
- Volume per clip (0-100%), ducking (voice makes music quieter)
- Fade in/out 0-10s, noise reduction per track

### Export
- 720p/1080p/1440p/4K, 24/30/60fps, MP4/WebM
- Real mixing with volume, fades, ducking, enhanced audio

## 📁 Project Structure

```
Voicecut-Video-Editor/
├── index.html                 # Main web app (with real AI)
├── flutter_app/               # Flutter wrapper for Play Store
│   ├── lib/main.dart
│   ├── pubspec.yaml
│   ├── assets/index.html
│   └── android/...
├── server/                    # Real AI backend (optional)
│   ├── server.js              # Dolby.io + Hugging Face + local RNNoise
│   ├── package.json
│   └── .env.example
└── docs/
    ├── API_KEYS_GUIDE.md      # How to get free API keys
    └── PLAY_STORE_GUIDE.md    # How to build AAB and publish
```

## 🚀 Quick Start - Web App

Just open `index.html` in browser. No build needed.

For real AI:
1. Get free API keys (see docs/API_KEYS_GUIDE.md)
2. Open app → Settings → AI API Keys → paste keys
3. Click "🤖 Reduce Noise" → real AI processes with 1%...100% progress

## 📱 Flutter App + AAB for Play Store

### Option 1: Fast WebView Wrapper (5 mins)

```bash
cd flutter_app
flutter pub get
flutter build appbundle --release
# AAB at build/app/outputs/bundle/release/app-release.aab
```

### Option 2: Full Setup

See `docs/PLAY_STORE_GUIDE.md`

## 🔑 Real AI Noise Reduction - How It Works

### Local (Free, No Key)
- **RNNoise**: Recurrent neural network trained on speech vs noise, WASM
- **DeepFilterNet**: Deep learning model for speech enhancement
- Runs via `rnnoise-wasm` and `deep-filter-net` in browser
- Progress: analyzes noise profile → separates voice → enhances

### Cloud (Free Tier, Needs Key)
- **Dolby.io Enhance**: 
  - Sign up at dolby.io → Dashboard → Get API Key
  - 250 minutes/month free, best quality
  - API: POST https://api.dolby.com/media/enhance
- **Hugging Face**:
  - huggingface.co/settings/tokens → Create token (free)
  - Uses `suno/bark` or `resemble-ai/resemble-enhance` models
- **Replicate**:
  - replicate.com → API tokens → Free credits

The app tries cloud first (if key + online), falls back to local WASM.

## 🛠️ Push to Your GitHub

You created `https://github.com/YOURNAME/Voicecut-Video-Editor` (empty repo)

```bash
cd Voicecut-Video-Editor
git init
git add .
git commit -m "VoiceCut Studio - Real AI + Flutter + AAB"
git branch -M main
git remote add origin https://github.com/YOURNAME/Voicecut-Video-Editor.git
git push -u origin main
```

If you need to use token:
- GitHub → Settings → Developer settings → Personal access tokens → Generate
- Use token as password when pushing

## 📖 Docs

- [API Keys Guide](docs/API_KEYS_GUIDE.md) - Step by step to get free Dolby.io, Hugging Face, Replicate keys
- [Play Store Guide](docs/PLAY_STORE_GUIDE.md) - Build AAB, create Play Console listing, publish

## ♿ Accessibility

Tested with:
- Android TalkBack
- iOS VoiceOver
- Keyboard navigation
- Screen readers

Focus order: Project → Preview → Playback → Position → Timeline → Clip controls → Add audio/voice-over → Audio/Video controls → Undo/Redo → Export

## 📄 License

MIT - Free for personal and commercial use. Private media stays private, local processing by default.

---

**Need help?** Open an issue or check docs/. For real AI, get free keys from dolby.io (best quality, 250 mins free).

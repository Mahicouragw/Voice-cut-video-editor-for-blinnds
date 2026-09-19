# Push to GitHub - Step by Step

You said you want to create new repo `Voicecut Video Editor` and want me to push code.

## Step 1: Create Empty Repo on GitHub

1. Go to https://github.com/new
2. **Repository name:** `Voicecut-Video-Editor` (or `Voicecut Video Editor` - GitHub will convert spaces to hyphens)
3. **Description:** `Accessible video editor with real AI noise reduction - TalkBack, VoiceOver, Flutter AAB for Play Store`
4. **Public** or **Private** - your choice
5. **IMPORTANT:** Check **"Add a README file" OFF**, **.gitignore OFF**, **License OFF** - make it completely empty
6. Click **Create repository**
7. Copy the URL - will be like `https://github.com/YOURUSERNAME/Voicecut-Video-Editor.git`

Paste that URL here in chat so I can give you exact commands.

## Step 2: Push Code (2 options)

### Option A: You push from your computer (if you have git)

```bash
# Download this folder from Arena
# Unzip Voicecut-Video-Editor

cd Voicecut-Video-Editor

git init
git add .
git commit -m "VoiceCut Studio - Real AI Noise Reduction + Flutter App + AAB - Accessible video editor"

git branch -M main
git remote add origin https://github.com/YOURUSERNAME/Voicecut-Video-Editor.git

git push -u origin main
```

If it asks for username/password:
- Username: your GitHub username
- Password: Use Personal Access Token, NOT your GitHub password
  - Go to https://github.com/settings/tokens → Generate new token (classic) → Check `repo` → Generate → Copy token → Use as password

### Option B: I push for you (need token)

If you want me to push directly from this environment:

1. Create Personal Access Token:
   - https://github.com/settings/tokens/new
   - Note: `voicecut-push`
   - Expiration: 7 days
   - Scopes: Check `repo` (all)
   - Generate → Copy token (starts with `ghp_...`)

2. Paste token here (custom response) - I will use it to push and then delete from logs

3. Give me repo URL: `https://github.com/YOURUSERNAME/Voicecut-Video-Editor.git`

4. I will run:
```bash
cd /home/user/Voicecut-Video-Editor
git init
git add .
git commit -m "VoiceCut Studio..."
git remote add origin https://YOUR_TOKEN@github.com/YOURUSERNAME/Voicecut-Video-Editor.git
git push -u origin main
```

### Option C: Upload via GitHub Web UI (easiest, no git)

1. Go to your empty repo on GitHub
2. Click **"uploading an existing file"** link
3. Drag all files from `Voicecut-Video-Editor` folder
4. Commit

But git push is better for future updates.

## Step 3: After Push - Build AAB Automatically

Once pushed to GitHub:

1. Go to your repo → **Actions** tab
2. You will see **Build VoiceCut AAB for Play Store** workflow running
3. Wait 5-10 mins
4. Click workflow → Download **voicecut-studio-aab** artifact
5. This `app-release.aab` is ready for Play Store!

No need for local Android Studio.

## Step 4: Get Real AI Working

### For Web App (index.html):

1. Get free Dolby.io key: https://dolby.io/dashboard → Sign up → Get API Key (250 mins/month free, best quality)
2. Open your deployed web app (or local index.html)
3. Settings → AI API Keys → Paste Dolby key → Save
4. Now "Reduce Noise" uses REAL cloud AI + local fallback

### For Flutter App:

Same - open app → Settings → Paste Dolby key

Local RNNoise WASM works even without key (real AI, free, offline).

## What You Get After Push

- `index.html` - Main web app with REAL AI (local WASM + cloud Dolby.io)
- `flutter_app/` - Flutter wrapper, builds AAB
- `server/` - Optional Node.js server for Dolby.io proxy (if you want to hide API key)
- `docs/` - Guides for API keys and Play Store
- `.github/workflows/build-aab.yml` - Auto-builds AAB on push

## Need Help?

Paste your repo URL here and I will give exact commands with your username filled in.

If you want me to push, paste:
- Repo URL
- Personal Access Token (I will use once and not store)

Example:
```
Repo: https://github.com/john/Voicecut-Video-Editor
Token: ghp_xxxxxxxxxxxxxxxxxxxx
```

I will push immediately.

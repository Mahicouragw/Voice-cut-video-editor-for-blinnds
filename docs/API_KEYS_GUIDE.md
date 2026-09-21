# Real AI captions and noise removal: create keys and paste them safely

This guide applies to **VoiceCut 1.3 (the free-AI update)**. It adds free caption providers (Groq, Deepgram, AssemblyAI) and free built-in DeepFilterNet noise removal alongside the paid OpenAI/ElevenLabs options. The previous 1.1 repair had only filters and cannot use these provider keys. Install/deploy the new code first using [AI_UPDATE_START_HERE.md](../AI_UPDATE_START_HERE.md).

**Do not send keys to this chat. Do not paste them into JavaScript, HTML, Android assets, public GitHub files, screenshots, or GitHub issues.**

## The keys — they are different

| Name | What it does | Exact place to paste it |
|---|---|---|
| `GROQ_API_KEY` | Free-tier Whisper captions (recommended free option) | Render → your **backend service** → **Environment** → variable with this exact name |
| `DEEPGRAM_API_KEY` | Nova captions using Deepgram's free starter credit | Same backend Environment page |
| `ASSEMBLYAI_API_KEY` | Captions using AssemblyAI's free tier | Same backend Environment page |
| `OPENAI_API_KEY` | Paid Whisper captions (optional alternative) | Same backend Environment page |
| `ELEVENLABS_API_KEY` | Cloud AI voice isolation/background-noise removal | Same backend Environment page |
| `SERVER_ACCESS_KEY` | Protects your personal backend against other people using your API credits | Backend Environment **and** VoiceCut → Settings → **Your SERVER_ACCESS_KEY** |

**The website should never receive any provider key.** Only the separate server access key goes into the editor. The backend attaches the appropriate provider key privately when making requests.

DeepFilterNet noise removal needs **no key at all**: it runs inside your backend. Local editing, manual captions and local filters also need no key.

Free tiers are real but limited: each provider sets its own quotas, rate limits and expiry, and can change them. Verify the current free allowance in your own account dashboard at signup. “Key configured” in VoiceCut only means a key is present — it never means unlimited free usage.

## Step 1 — Create a free caption key (recommended: Groq)

You only need **one** caption provider to start. Groq is recommended because its free tier includes Whisper large-v3 transcription with word timestamps at no charge within generous daily limits, and no credit card is required for the free tier. Verify the current limits in your own Groq dashboard — the provider controls them, not VoiceCut.

1. Open [Groq Cloud Console](https://console.groq.com/) and sign in or create your own account.
2. Open [API Keys](https://console.groq.com/keys).
3. Choose **Create API Key**, name it **VoiceCut captions**.
4. Copy the key immediately into a password manager or directly into your backend's `GROQ_API_KEY` environment variable. If you lose it, create a replacement.
5. Review the current [rate limits](https://console.groq.com/docs/rate-limits) for `whisper-large-v3` (requests per day and audio seconds per day). If you exceed them, requests fail with a quota error instead of silently billing you.
6. Do not paste it into VoiceCut's “Server access key” box. That box is for a different, self-generated secret.

### Free alternatives (configure one or more)

- **Deepgram:** sign up at [Deepgram](https://deepgram.com/), open **Console → API Keys**, create a key named **VoiceCut captions**, and paste it as `DEEPGRAM_API_KEY`. New accounts receive a one-time free starter credit (historically $200, enough for hundreds of transcription hours); confirm the current offer and Nova model rates in your own console. VoiceCut uses model `nova-3`.
- **AssemblyAI:** sign up at [AssemblyAI](https://www.assemblyai.com/), open your dashboard's **API keys** section, create a key, and paste it as `ASSEMBLYAI_API_KEY`. AssemblyAI advertises a free tier for testing; confirm the current free hours and terms in your own account before relying on it. VoiceCut uses the `universal` speech model.

### Optional paid alternative — OpenAI captions

1. Open [OpenAI Platform](https://platform.openai.com/) and sign in or create your own account.
2. Select your organization/project. If needed, create a project called **VoiceCut** so usage can be tracked separately.
3. Open [API billing](https://platform.openai.com/settings/organization/billing/overview). Review the current [API pricing](https://developers.openai.com/api/docs/pricing) and enable API billing/prepaid credit if your account requires it. **A ChatGPT subscription does not include API billing.** Do not buy another ChatGPT plan for this feature.
4. Configure the available project usage budgets/alerts. Read the provider's explanation: budget alerts are not necessarily hard spending caps. Start with a short test and monitor the usage dashboard.
5. Open [API keys](https://platform.openai.com/api-keys).
6. Choose **Create new secret key** (wording may vary), name it **VoiceCut captions**, and select the intended project.
7. If you restrict permissions, allow the audio transcription endpoint, `POST /v1/audio/transcriptions`. The code uses **`whisper-1`**, because this integration needs timestamped words/segments. Your project must have access to that model and endpoint.
8. Create the key. Copy it immediately into a password manager or directly into your backend's `OPENAI_API_KEY` environment variable. OpenAI shows the full secret only when it is created. If you lose it, create a replacement rather than sharing another person's key.
9. Do not paste it into VoiceCut's “Server access key” box. That box is for a different, self-generated secret.

This implementation transcribes the spoken language; it does not automatically translate captions into English or identify who a speaker is. Select English, Hindi, Telugu or another offered language hint, or choose automatic detection. Accuracy depends on language, speech, recording conditions and model behavior. Review the captions.

Official references: [OpenAI key creation/security](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key), [separate API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform), [Whisper timestamp documentation](https://developers.openai.com/api/docs/guides/speech-to-text#timestamps).

## Step 2 — Create an ElevenLabs key for genuine AI noise removal

1. Open [ElevenLabs](https://elevenlabs.io/) and sign in or create your account.
2. Check your workspace's current [pricing and credits](https://elevenlabs.io/pricing). Confirm that your account can use **Voice Isolator / Audio Isolation through the API**. ElevenLabs offers a free plan with a small monthly credit pool (historically about 10 minutes of isolation per month); confirm the current free allowance in your own dashboard. For unlimited free denoising with no account, use DeepFilterNet instead (Step 7). A website feature being visible is not proof of API entitlement or remaining credit.
3. Open [Personal API keys](https://elevenlabs.io/app/settings/api-keys). If redirected, find API Keys under your profile/settings; the exact navigation can vary by account.
4. Select **Create API key** and name it **VoiceCut isolation**.
5. Restrict its scope to **Audio Isolation / Voice Isolator** when that control is available. Other unrelated endpoints do not need access.
6. Set a conservative credit quota. If using IP restrictions, use your backend provider's supported outbound IP addresses—not your phone's IP. Incorrect IP allowlisting causes a 403 error.
7. Personal keys can have an **Expire After** setting. For a temporary test you can choose **15 minutes** if offered. Such a key will actually stop working after that period and must be replaced or extended for continued service. For a long-running app, deliberately choose an appropriate lifetime and rotation plan instead. Do not confuse this with VoiceCut's separate 15-minute browser/server-copy timers.
8. Create/copy the key into your backend's `ELEVENLABS_API_KEY` variable. Never paste it in the editor or source code.
9. If you cannot create a personal key, check the workspace seat/role requirements; ask its administrator rather than trying someone else's credentials.

The implementation calls `POST https://api.elevenlabs.io/v1/audio-isolation` with the documented `audio` file field and `xi-api-key` header. It does not imitate AI with filters. However, AI isolation may remove music or alter parts of speech. Always listen before applying. No guarantee of perfect noise removal or restoration of damaged speech is made.

Official references: [API key scopes, quota and expiry](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys), [audio-isolation endpoint](https://elevenlabs.io/docs/api-reference/audio-isolation/convert), [Voice Isolator capabilities and usage](https://elevenlabs.io/docs/overview/capabilities/voice-isolator).

## Step 3 — Deploy or update the private backend

GitHub Pages can host the editor, **but cannot run this Node/FFmpeg backend or keep API keys secret**. Do not put the keys into GitHub Pages build variables or frontend code.

### If the Render backend already exists
1. Open [Render dashboard](https://dashboard.render.com/).
2. Open your **voicecut-processing** service.
3. Ensure it points to your updated repository/branch and root Dockerfile. Deploy the latest repaired commit.
4. Open **Environment**. Add/update the variables in the table below, then save/redeploy.

### If you do not have a backend yet
1. First merge the AI update into your GitHub `main` branch.
2. Open [Render dashboard](https://dashboard.render.com/) → **New → Blueprint**.
3. Connect GitHub and select only `Mahicouragw/Voice-cut-video-editor-for-blinnds`.
4. Render reads the included `render.yaml` and `Dockerfile`. It may ask for the two provider secret values before creating the service.
5. **Review hosting prices before confirming.** The blueprint requests Render's paid `starter` plan; this is not a free-hosting promise. If you do not accept the charge, do not confirm deployment.
6. Enter your provider keys in the private secret/environment fields. The blueprint generates a separate `SERVER_ACCESS_KEY` for you.
7. Apply/deploy. Wait for the service to be healthy. The assistant has not created a paid service or granted account authorization for you.

### Exact backend environment values

| Variable name | Value |
|---|---|
| `GROQ_API_KEY` | Your free key from Step 1 (recommended); leave blank if unused |
| `DEEPGRAM_API_KEY` | Your Deepgram key, or blank |
| `ASSEMBLYAI_API_KEY` | Your AssemblyAI key, or blank |
| `OPENAI_API_KEY` | Your paid OpenAI key, or blank |
| `ELEVENLABS_API_KEY` | Your real key from Step 2, or blank |
| `SERVER_ACCESS_KEY` | Render-generated random value, or your self-generated value from Step 4 |
| `ALLOWED_ORIGIN` | `https://mahicouragw.github.io` — **no repository path and no trailing slash** |
| `ALLOW_ANDROID_APP` | `true` to allow the packaged Android app's `http://localhost:8080` origin; its requests still require the server access key |
| `MAX_AI_REQUESTS_PER_HOUR` | `20` by default; you can use `3` while testing |

Optional features work independently: configure only the providers you want. The editor reports which key is missing, and caption requests never silently fall back to a different (possibly paid) provider. DeepFilterNet is included in the server image automatically — no key or extra step needed. Its first run downloads its neural model (about 30 MB); allow extra time on the very first denoise.

Render supplies `PORT`; you normally do not need to set it manually. FFmpeg and FFprobe are installed by the Dockerfile.

Copy your service's real HTTPS URL from Render. It will look like `https://your-service.onrender.com`; **do not paste that example literally**. Open `YOUR-REAL-URL/health`. The new version returns JSON containing `status: "ok"` and `version: "1.3.0"`.

## Step 4 — Create your separate server access key, if needed

Render's blueprint can generate this for you. To generate your own instead, run in a trusted Node.js terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the random 64-character output. Paste the **same value** in:
1. Render → backend → Environment → `SERVER_ACCESS_KEY`.
2. VoiceCut editor → Settings → **Your SERVER_ACCESS_KEY**.

This key is not from OpenAI, ElevenLabs, or GitHub. It is your private password protecting the backend. Treat it as secret: anyone holding it can request processing using the backend's provider accounts. This is a personal setup, not a secure multiuser billing system. Do not embed the key in a public app for all users.

## Step 5 — Connect the editor

1. Open your deployed VoiceCut website. The expected Pages address is [VoiceCut](https://mahicouragw.github.io/Voice-cut-video-editor-for-blinnds/), **after successful deployment of this update**.
2. Open **Settings → AI server connection and audio cleanup method**.
3. Paste the Render HTTPS URL into **Your deployed HTTPS server URL**.
4. Paste only the generated **SERVER_ACCESS_KEY** into **Your SERVER_ACCESS_KEY**.
5. Click **Save server settings**. The access-key field clears; its value stays in memory for up to 15 minutes and is lost on page reload. It is not saved with your project.
6. Click **Check connection and configured features**.
7. Expect “Connected. Captions — Groq (free): key configured…” listing each provider you set, plus ElevenLabs isolation and DeepFilterNet install status. This checks your server access and the presence of provider keys; **it does not validate those keys with providers, verify billing, or make a paid processing request**.
8. If the editor complains that you pasted a provider key, remove it and enter your generated server access key instead.

## Step 6 — Generate captions and put them on the video

1. Upload a short, non-sensitive test video, ideally 10–20 seconds of clear speech.
2. Go to **CAPTIONS → Automatic captions**.
3. Choose **Original video audio**. To transcribe a voice-over separately, select its audio clip in the timeline, then choose **Selected audio clip**.
4. Choose the spoken language, or **Detect automatically**.
5. Choose the **Caption service** (Groq is preselected). Only configure the matching key on the backend.
6. Click **Generate AI captions**. Read and approve the upload/cost consent. The server receives your selected source file, extracts audio, and sends only the extracted audio to your chosen provider.
6. Wait. Do not submit repeated requests. **Cancel caption request** aborts our waiting/request; it cannot promise a provider refund or stop provider-side processing already underway.
7. Select each caption in **Caption to edit**. Correct the words and start/end seconds, then click **Save caption changes**.
8. **Show captions on preview** controls the visible overlay. The caption text is also provided as ordinary screen-reader-readable text. **Announce current caption** reads it through the app's status region on demand; it does not interrupt TalkBack continuously during playback.
9. Leave **Include captions permanently in exported video** checked to burn them into the video. Uncheck it if you only want separate subtitles.
10. Download **SRT** and/or **VTT**. These timings automatically account for trim, deleted video segments and playback speed.
11. Export the video using matching settings, then play the downloaded result. Burned-in text cannot be turned off afterward.
12. Save the project. Caption edits and media persist locally. After reloading, re-enter the server access key only if you need another cloud request.

This release captions **one chosen source at a time**, not all overlapping speech in the final mix. Generation replaces the current caption list after confirmation; Undo restores the previous list. To caption the exact final mix, first export it, import that exported video, then generate captions for its original audio. After moving a captioned audio clip, regenerate or manually retime its captions.

## Step 7 — Use genuine AI background-noise removal

### Free option: DeepFilterNet (no key, no account)

1. Settings → **Method used by Reduce Noise buttons** → choose **DeepFilterNet AI**.
2. Choose Reduce Noise for the original video audio, or select an audio clip and enhance that clip.
3. Approve the upload prompt. Audio is processed by the neural model **on your own server** — nothing is sent to any AI company and no credits are used.
4. The very first denoise downloads the model (about 30 MB); later runs are faster.
5. Wait for completion. Listen to **Original** and **Processed** separately.
6. Choose **Apply** only if it sounds better. The original video track is muted when its denoised replacement is applied to avoid double audio. Undo is available.
7. Export and listen again.

### Cloud option: ElevenLabs AI Voice Isolator

Follow the same steps with **ElevenLabs AI Voice Isolator** selected. Extracted audio is sent to ElevenLabs and uses your ElevenLabs credits after any free allowance. To keep the recording entirely on your device, select **Local filters** instead — but that mode is not AI.

## Limits, cost control and privacy

- This implementation accepts sources up to **100 MB and 10 minutes**. Longer recordings are rejected before any provider call; no silent truncation. Export a shorter clip and re-import it if necessary. A timeline trim does not reduce the source upload itself.
- Only one server job runs at a time. The hourly AI-attempt cap is per process and resets on server restart; it is **not** a hard currency spending guarantee. Use provider quotas and monitor actual usage.
- Provider input audio is normalized to a bounded MP3: captions use 16 kHz mono; isolation uses 48 kHz stereo. Isolated audio is decoded back to WAV and checked for gross duration drift before it can replace your track.
- The browser waits at most 14 minutes for a processing request. The server's absolute deadline is 15 minutes from request start and includes upload/processing/download time. It kills local processing, aborts the provider request and removes temporary server files at completion, failure, disconnect or deadline.
- A sleeping or crashed host cannot perform wall-clock disk deletion while stopped. Stale files are removed on startup before accepting new requests. Use independent provider-managed lifecycle/audit controls if regulated deletion guarantees are required.
- **OpenAI and ElevenLabs retention, logging, processing location and billing are separate.** Our 15-minute timer does not erase their copies. Review your account's data controls and the providers' terms before uploading private recordings.
- Saved local projects, subtitles and downloaded exports do not expire automatically.
- The server environment keys remain valid until provider expiry/revocation or rotation. VoiceCut's 15-minute in-browser copy expiry does not globally revoke your server key.
- GitHub authorization codes have their own expiry. The existing deployment helper caps new CLI sign-in waiting at 15 minutes. No GitHub account authorization request has been created by this guide.

## Troubleshooting — exact distinction between errors

| Error | What to check |
|---|---|
| Server access key rejected / HTTP 401 | The **SERVER_ACCESS_KEY** in the editor must match the backend; do not use a provider key. Re-enter it after 15 minutes or reload. |
| `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` missing | Add the named key to the **backend Environment**, then redeploy. |
| OpenAI/ElevenLabs rejected the API key or permissions | The provider key is wrong, revoked, expired, missing endpoint permissions, belongs to the wrong project, or has an IP restriction. Fix it on the server, not in the editor. |
| Quota/rate limit reached | Check API billing/credits and provider rate limits. A “configured” connection check is not a credit check. There is no automatic paid retry. |
| Server hourly limit reached | Wait for the one-hour window or adjust your intentional testing limit. Do not remove all limits merely to suppress an error. |
| Another job is running | Wait or cancel the existing operation. |
| Cannot reach server / origin denied | Check the HTTPS URL, deployment health, exact `ALLOWED_ORIGIN` and Android flag if using the app. The website origin has no repository path. |
| Source longer than 10 minutes or over 100 MB | Export a shorter/smaller video, import that new file, and try again. |
| No readable audio / unsupported media | Import an ordinary MP4 with audio, WAV, MP3, M4A, WebM, OGG or FLAC. A silent video may have no audio track. |
| Unexpected isolated audio duration | The replacement was rejected rather than corrupting synchronization. Keep the original and retry a short standard-format source. |
| Captions contain wrong words | Edit them. AI can hallucinate words in silence/music; no automatic transcript is guaranteed correct. |
| Settings look like the old version | Confirm the updated workflow deployed successfully, then reload the page. Open `/health` to check backend version 1.3.0. |

## Local backend alternative

With Node.js 22 and FFmpeg/FFprobe installed:

```bash
npm --prefix server ci
cp server/.env.example server/.env
```

Open `server/.env` privately and fill the key values plus your exact HTTPS frontend origin. For local DeepFilterNet support, install the `deep_filter` binary (see https://github.com/Rikorose/DeepFilterNet/releases) or set `DEEPFILTER_PATH`. Never commit it. Then:

```bash
npm --prefix server start
```

The editor accepts HTTPS backend URLs. For another device, use an authorized HTTPS deployment or trusted tunnel; `localhost` on a phone is not your computer. Do not expose your backend without the access key and upload limits.

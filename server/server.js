'use strict';
require('dotenv').config({path:require('node:path').join(__dirname,'.env'),quiet:true});
const express=require('express');
const multer=require('multer');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {createProviders,ServiceError}=require('./providers');
const {createStudioPipeline}=require('./studio-pipeline');
const Captions=require('../web/captions');
const VERSION='2.0.0';
const CAPTION_ORDER=['groq','deepgram','assemblyai','openai']; // Automatic preference: free tiers first.
const FILTER_LEVELS={light:'highpass=f=80,afftdn=nf=-20',medium:'highpass=f=100,lowpass=f=12000,afftdn=nf=-25',strong:'highpass=f=120,lowpass=f=8000,afftdn=nf=-35',voicefocus:'highpass=f=120,lowpass=f=8000,afftdn=nf=-40,equalizer=f=3000:t=q:w=1:g=5,acompressor=threshold=-20dB:ratio=4:attack=10:release=200',ultra:'highpass=f=140,lowpass=f=7000,afftdn=nf=-45,equalizer=f=3000:t=q:w=1:g=6,acompressor=threshold=-24dB:ratio=6:attack=8:release=150'};
const DF_LEVEL_ARGS={light:['--atten-lim-db','12'],medium:['--atten-lim-db','30'],strong:['--atten-lim-db','60','--pf'],voicefocus:['--atten-lim-db','100','--pf','--pf-beta','0.05'],ultra:['--atten-lim-db','100','--pf','--pf-beta','0.05']}; // ultra uses the server maximum; extra strength is the on-device single-pass maximum
const CAPTION_LABELS={openai:'OpenAI whisper-1',groq:'Groq whisper-large-v3-turbo',deepgram:'Deepgram Nova-3',assemblyai:'AssemblyAI Universal'};
const CAPTION_ENV={openai:'OPENAI_API_KEY',groq:'GROQ_API_KEY',deepgram:'DEEPGRAM_API_KEY',assemblyai:'ASSEMBLYAI_API_KEY'};
function deepFilterAvailable() {
  try{return spawnSync(process.env.DEEPFILTER_PATH||'deep_filter',['--version'],{timeout:10000,stdio:'ignore'}).status===0;}
  catch{return false;}
}
const TTL=15*60*1000;
const FORMATS='mov,matroska,webm,wav,mp3,flac,ogg,aac,aiff';
function createApp(options={}) {
  const publicMode=options.public??process.env.PUBLIC_MODE==='true';
  const key=options.key||process.env.SERVER_ACCESS_KEY;
  if(!publicMode&&(!key||key.length<32)) throw new Error('Set SERVER_ACCESS_KEY to a random secret of at least 32 characters, or explicitly set PUBLIC_MODE=true with quotas.');
  const perIpHour=Number(process.env.MAX_AI_PER_IP_PER_HOUR||12),perIpDay=Number(process.env.MAX_AI_PER_IP_PER_DAY||60);
  if(!Number.isInteger(perIpHour)||perIpHour<1||perIpHour>100||!Number.isInteger(perIpDay)||perIpDay<1||perIpDay>500) throw new Error('Per-IP quotas must be within 1-100/hour and 1-500/day.');
  const origin=options.origin||process.env.ALLOWED_ORIGIN;
  if(!origin||new URL(origin).origin!==origin||!origin.startsWith('https://')) throw new Error('ALLOWED_ORIGIN must be an exact HTTPS origin.');
  const origins=new Set([origin]);
  if(options.allowAndroid??process.env.ALLOW_ANDROID_APP==='true') origins.add('http://localhost:8080');
  const providers=options.providers||createProviders({
    openaiKey:process.env.OPENAI_API_KEY,
    elevenKey:process.env.ELEVENLABS_API_KEY,
    groqKey:process.env.GROQ_API_KEY,
    deepgramKey:process.env.DEEPGRAM_API_KEY,
    assemblyKey:process.env.ASSEMBLYAI_API_KEY,
    cfAccountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    cfApiToken:process.env.CLOUDFLARE_API_TOKEN,
    pollinationsKey:process.env.POLLINATIONS_API_KEY,
    falKey:process.env.FAL_KEY,
    replicateToken:process.env.REPLICATE_API_TOKEN,
    hfToken:process.env.HF_TOKEN,
  });
  const root=options.root||path.join(os.tmpdir(),'voicecut-temporary');
  const lifetime=Math.min(TTL,options.ttlMs||TTL); // Shorter deadline only used by tests.
  const jobsPerHour=Number(process.env.MAX_AI_REQUESTS_PER_HOUR||60);
  if(!Number.isInteger(jobsPerHour)||jobsPerHour<1||jobsPerHour>100) throw new Error('MAX_AI_REQUESTS_PER_HOUR must be between 1 and 100.');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  for(const name of fs.readdirSync(root)) fs.rmSync(path.join(root,name),{recursive:true,force:true});
  const app=express();app.disable('x-powered-by');
  let active=false,attempts=[],ipAttempts=new Map();
  app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    if(req.headers.origin) {
      if(!origins.has(req.headers.origin)) return res.status(403).json({code:'ORIGIN_DENIED',error:'This website origin is not allowed by your server.'});
      res.set('Access-Control-Allow-Origin',req.headers.origin);res.set('Vary','Origin');
      res.set('Access-Control-Allow-Headers','Authorization, Content-Type, X-Upload-Consent');
      res.set('Access-Control-Allow-Methods','POST, GET, OPTIONS');
      res.set('Access-Control-Expose-Headers','X-Processing-Method, X-Studio-Plan, X-Silence-Removed, X-Silence-Seconds, X-Silence-Threshold');
    }
    if(req.method==='OPTIONS') return res.sendStatus(204);
    next();
  });
  const clientIp=req=>(String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket?.remoteAddress||'unknown').slice(0,80);
  const authorized=(req,res,next)=>{
    if(publicMode) return next();
    const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+key);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({code:'ACCESS_KEY_REJECTED',error:'Server access key rejected. Check the #dev-key value in the page address.'});
    next();
  };
  app.get('/health',(_,res)=>res.json({status:'ok',version:VERSION,temporaryFileTTLSeconds:900}));
  app.get('/capabilities',authorized,(_,res)=>{const keys=providers.configured.captionProviders||{openai:providers.configured.captions};res.json({publicMode,captions:providers.configured.captions,isolation:providers.configured.isolation,autoProvider:CAPTION_ORDER.find(id=>keys[id])||null,captionProviders:providers.configured.captionProviders||{openai:providers.configured.captions},imageGen:providers.configured.imageGen??true,videoGen:!!providers.configured.videoGen,tts:providers.configured.tts??true,musicGen:providers.configured.musicGen??true,sfxGen:providers.configured.sfxGen??true,imageProviders:providers.configured.imageProviders||{freeFallback:true},videoProviders:providers.configured.videoProviders||{},ttsProviders:providers.configured.ttsProviders||{edgeNeural:true},soundProviders:providers.configured.soundProviders||{},models:providers.configured.models||{},deepFilterNet:deepFilterAvailable(),providerKeys:'Configuration only; not validated with providers',maxUploadMB:100,maxDurationSeconds:600,temporaryFileTTLSeconds:900});});
  const storage=multer.diskStorage({destination:(req,_,cb)=>cb(null,req.workdir),filename:(_,__,cb)=>cb(null,'input')});
  const upload=multer({storage,limits:{fileSize:100*1024*1024,files:1,fields:0,parts:1}}).single('file');
  const job=(kind)=>async(req,res)=>{
    if(active) return res.status(429).json({code:'BUSY',error:'Another job is running. Wait before trying again.'});
    const cloud=kind==='captions'||kind==='isolation';
    const usesAI=cloud||kind==='deepfilter';
    const language=String(req.query.language||'');
    if(language&&!/^[a-z]{2}$/.test(language)) return res.status(400).json({error:'Language must be blank for automatic detection or a two-letter code.'});
    const level=String(req.query.level||'medium');
    if((kind==='filter'||kind==='deepfilter')&&!FILTER_LEVELS[level]) return res.status(400).json({code:'UNKNOWN_LEVEL',error:'Unknown noise reduction level.'});
    const silenceSeconds=Number(req.query.seconds||3);
    if(kind==='silence'&&(!Number.isFinite(silenceSeconds)||silenceSeconds<1||silenceSeconds>180)) return res.status(400).json({code:'BAD_SECONDS',error:'Silence length must be between 1 second and 3 minutes.'});
    const captionKeys=providers.configured.captionProviders||{openai:providers.configured.captions};
    let provider=String(req.query.provider||'auto');
    if(provider==='auto') provider=CAPTION_ORDER.find(id=>captionKeys[id])||'openai';
    if(kind==='captions'&&!CAPTION_LABELS[provider]) return res.status(400).json({code:'UNKNOWN_PROVIDER',error:'Unknown caption provider.'});
    if(publicMode&&usesAI) {
      const ip=clientIp(req),now=Date.now();
      const log=(ipAttempts.get(ip)||[]).filter(t=>now-t<86400000);
      if(log.filter(t=>now-t<3600000).length>=perIpHour||log.length>=perIpDay) return res.status(429).json({code:'IP_QUOTA',error:'Too many AI requests from this address. Try again later.'});
      log.push(now);ipAttempts.set(ip,log);
      if(ipAttempts.size>10000) ipAttempts.clear();
    }
    if(cloud) {
      if(req.headers['x-upload-consent']!=='yes') return res.status(400).json({code:'CONSENT_REQUIRED',error:'Explicit cloud-processing consent is required.'});
      const ready=kind==='captions'?captionKeys[provider]:providers.configured.isolation;
      if(!ready) return res.status(503).json({code:'KEY_NOT_CONFIGURED',error:(kind==='captions'?CAPTION_ENV[provider]:'ELEVENLABS_API_KEY')+' is not configured on the server.'});
      attempts=attempts.filter(t=>Date.now()-t<3600000);
      if(attempts.length>=jobsPerHour) return res.status(429).json({code:'HOURLY_LIMIT',error:'The server hourly AI request limit was reached. Wait before retrying.'});
      attempts.push(Date.now());
    }
    active=true;
    req.workdir=fs.mkdtempSync(path.join(root,'job-'));
    const controller=new AbortController(),signal=controller.signal;
    const children=new Set();let closed=false,deadline;
    const cleanup=()=>{
      if(closed)return;closed=true;clearTimeout(deadline);controller.abort();
      children.forEach(child=>child.kill('SIGKILL'));
      fs.rmSync(req.workdir,{recursive:true,force:true});active=false;
    };
    deadline=setTimeout(()=>{
      if(!res.headersSent) res.status(408).json({code:'EXPIRED',error:'The processing deadline expired. No automatic paid retry was made.'});
      else res.destroy();
      cleanup();req.destroy();
    },lifetime);
    req.on('aborted',cleanup);res.on('close',cleanup);
    const run=(binary,args)=>new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new ServiceError(408,'EXPIRED','Request expired.'));
      const child=spawn(binary,args,{stdio:['ignore','pipe','ignore']});children.add(child);let output='';
      child.stdout.on('data',data=>{output+=data;if(output.length>2*1024*1024)child.kill('SIGKILL');});
      child.on('error',()=>reject(new ServiceError(503,'PROCESSOR_UNAVAILABLE','FFmpeg or FFprobe is unavailable on the server.')));
      child.on('close',code=>{children.delete(child);if(code!==0)reject(new ServiceError(422,'BAD_MEDIA','Unsupported, damaged or unreadable audio/video.'));else resolve(output);});
    });
    const runStderr=(binary,args)=>new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new ServiceError(408,'EXPIRED','Request expired.'));
      const child=spawn(binary,args,{stdio:['ignore','ignore','pipe']});children.add(child);let output='';
      child.stderr.on('data',data=>{output+=data;if(output.length>2*1024*1024)child.kill('SIGKILL');});
      child.on('error',()=>reject(new ServiceError(503,'PROCESSOR_UNAVAILABLE','FFmpeg or FFprobe is unavailable on the server.')));
      child.on('close',code=>{children.delete(child);if(code!==0)reject(new ServiceError(422,'BAD_MEDIA','Unsupported, damaged or unreadable audio/video.'));else resolve(output);});
    });
    const encode=async(input,output,args)=>{
      await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',input,'-vn','-t','600',...args,'-y',output]);signal.throwIfAborted();
    };
    try {
      await new Promise((resolve,reject)=>upload(req,res,error=>error?reject(new ServiceError(error.code==='LIMIT_FILE_SIZE'?413:400,'UPLOAD_REJECTED','Upload rejected: '+error.code)):resolve()));
      signal.throwIfAborted();
      if(!req.file)throw new ServiceError(400,'NO_FILE','Send one media file using field name file.');
      const info=JSON.parse(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-show_streams','-show_format','-of','json',req.file.path]));
      if(!info.streams?.some(s=>s.codec_type==='audio'))throw new ServiceError(422,'NO_AUDIO','This media has no readable audio track.');
      let duration=Number(info.format?.duration||info.streams.find(s=>s.codec_type==='audio')?.duration);
      if(!Number.isFinite(duration)||duration<=0)throw new ServiceError(422,'UNKNOWN_DURATION','Could not determine audio duration. Export to MP4/WAV and try again.');
      if(duration>600.05)throw new ServiceError(413,'MEDIA_TOO_LONG','Use a source recording no longer than 10 minutes. Longer recordings are rejected, not silently truncated.');
      duration=Math.min(duration,600);
      const audioStream=info.streams.find(s=>s.codec_type==='audio');
      const offset=Math.max(0,(Number(audioStream.start_time)||0)-(Number(info.format?.start_time)||0));
      const align=`adelay=${Math.round(offset*1000)}:all=1,apad,atrim=duration=${duration.toFixed(6)},asetpts=N/SR/TB`;
      const hasVideo=info.streams.some(s=>s.codec_type==='video');
      if(kind==='reverse'&&hasVideo&&duration>120.05)throw new ServiceError(413,'MEDIA_TOO_LONG','Video reverse supports up to 2 minutes. Reverse a shorter section instead.');
      const output=path.join(req.workdir,((kind==='silence'||kind==='reverse')&&hasVideo)?(kind==='reverse'?'reversed.mp4':'trimmed.mp4'):'processed.wav');
      const downloadName=((kind==='silence'||kind==='reverse')&&hasVideo)?(kind==='reverse'?'reversed-video.mp4':'silence-removed.mp4'):(kind==='reverse'?'reversed-audio.wav':'processed.wav');
      if(kind==='silence') {
        // Real silence removal: detect quiet gaps, cut them from audio AND video.
        // Phone recordings have noisy pauses, so the threshold escalates until
        // gaps appear (-30dB studio-quiet up to -20dB noisy background). The
        // -20dB cap protects soft speech from being cut.
        const ff=process.env.FFMPEG_PATH||'ffmpeg';
        let silent=[],thresholdDb=-30;
        for(const db of [-30,-25,-20]){
          const out=await runStderr(ff,['-nostdin','-v','info','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',req.file.path,'-af',`silencedetect=noise=${db}dB:d=${silenceSeconds}`,'-vn','-sn','-dn','-f','null','-']);
          signal.throwIfAborted();
          const gaps=[];let pending=null;
          for(const line of out.split('\n')){
            let m=/silence_start:\s*([0-9.]+)/.exec(line);if(m){pending=Number(m[1]);continue;}
            m=/silence_end:\s*([0-9.]+)/.exec(line);if(m&&pending!==null){gaps.push([pending,Number(m[1])]);pending=null;}
          }
          if(pending!==null)gaps.push([pending,duration]);
          // Keep 0.1s of padding at each gap edge so word starts/ends survive.
          silent=gaps.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b-a>=silenceSeconds-0.05&&a<duration)
            .map(([a,b])=>[Math.max(0,a+0.1),b-0.1]).filter(([a,b])=>b-a>=0.2);
          thresholdDb=db;
          if(silent.length)break;
        }
        if(req.query.detect) {
          // Fast preview: report gaps without trimming anything.
          const removedSeconds=silent.reduce((t,[a,b])=>t+Math.max(0,Math.min(duration,b)-Math.max(0,a)),0);
          res.json({gaps:silent.map(([a,b])=>[Number(Math.max(0,a).toFixed(2)),Number(Math.min(duration,b).toFixed(2))]),gapCount:silent.length,removedSeconds:Number(removedSeconds.toFixed(1)),duration:Number(duration.toFixed(2)),thresholdDb});
          cleanup();return;
        }
        const kept=[];let cursor=0,removed=0;
        for(const [a,b] of silent){const st=Math.max(0,a),en=Math.min(duration,b);if(st>cursor+0.02)kept.push([cursor,st]);removed+=Math.max(0,en-st);cursor=Math.max(cursor,en);}
        if(cursor<duration-0.02)kept.push([cursor,duration]);
        if(!kept.length)throw new ServiceError(422,'SILENCE_ONLY','No speech found: the whole recording is quiet. Your original media is unchanged.');
        if(!silent.length){
          // Nothing to cut: return the original bytes untouched (instant, no re-encode).
          fs.copyFileSync(req.file.path,output);
        }else if(hasVideo){
          const chains=[],inputs=[];
          kept.forEach(([a,b],i)=>{
            chains.push(`[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
            inputs.push(`[v${i}][a${i}]`);
          });
          const fg=`${chains.join(';')};${inputs.join('')}concat=n=${kept.length}:v=1:a=1[vout][aout]`;
          await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',req.file.path,'-filter_complex',fg,'-map','[vout]','-map','[aout]','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart','-y',output]);
        }else{
          const chains=[],inputs=[];
          kept.forEach(([a,b],i)=>{
            chains.push(`[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
            inputs.push(`[a${i}]`);
          });
          const fg=`${chains.join(';')};${inputs.join('')}concat=n=${kept.length}:v=0:a=1,aresample=48000[aout]`;
          await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',req.file.path,'-vn','-t','600','-filter_complex',fg,'-map','[aout]','-ar','48000','-ac','2','-c:a','pcm_s16le','-y',output]);
        }
        signal.throwIfAborted();
        const expected=kept.reduce((t,[a,b])=>t+(b-a),0);
        const trimmed=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(trimmed)||Math.abs(trimmed-expected)>Math.max(1.0,expected*0.05))throw new ServiceError(502,'TRIM_MISMATCH','Trimmed media duration changed unexpectedly. Not applied; retain your original.');
        res.set('X-Silence-Removed',String(silent.length));
        res.set('X-Silence-Seconds',removed.toFixed(1));
        res.set('X-Silence-Threshold',String(thresholdDb));
        // Gap list (capped for header size) so the editor can cut the same
        // ranges from the open project, shortening the timeline in place.
        res.set('X-Silence-Gaps',JSON.stringify(silent.slice(0,300).map(([a,b])=>[Number(Math.max(0,a).toFixed(2)),Number(Math.min(duration,b).toFixed(2))])));
      } else if(kind==='reverse') {
        // Whole-file reverse. The reverse filter buffers entire streams, so
        // video is reversed in short memory-safe chunks joined back to front.
        if(hasVideo){
          const CH=5,chunks=Math.max(1,Math.ceil(duration/CH)),parts=[];
          for(let k=0;k<chunks;k++){
            const split=path.join(req.workdir,'part'+k+'.mp4');
            await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-ss',(k*CH).toFixed(3),'-t',String(CH),'-i',req.file.path,'-c:v','libx264','-preset','ultrafast','-crf','23','-g','30','-c:a','aac','-b:a','128k','-y',split]);
            signal.throwIfAborted();
            const rev=path.join(req.workdir,'rev'+k+'.mp4');
            await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',split,'-vf','reverse','-af','areverse','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart','-y',rev]);
            signal.throwIfAborted();
            parts.unshift(rev);
          }
          fs.writeFileSync(path.join(req.workdir,'list.txt'),parts.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n'));
          await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS+',concat','-f','concat','-safe','0','-i',path.join(req.workdir,'list.txt'),'-c','copy','-movflags','+faststart','-y',output]);
        }else{
          await encode(req.file.path,output,['-af','areverse,aresample=48000','-ar','48000','-ac','2','-c:a','pcm_s16le']);
        }
        signal.throwIfAborted();
        const reversed=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(reversed)||Math.abs(reversed-duration)>Math.max(0.5,duration*0.01))throw new ServiceError(502,'DURATION_MISMATCH','Reversed media duration changed unexpectedly. Not applied; retain your original.');
      } else if(kind==='filter') {
        await encode(req.file.path,output,['-af',align+','+FILTER_LEVELS[level],'-ar','48000','-ac','2','-c:a','pcm_s16le']);
      } else if(kind==='deepfilter') {
        // Free, keyless neural denoising that runs on your own server. No provider account or credits.
        if(!deepFilterAvailable()) throw new ServiceError(503,'DEEPFILTER_MISSING','DeepFilterNet is not installed on this server. Rebuild the server image with deep_filter, or choose ElevenLabs cloud isolation instead.');
        const noisy=path.join(req.workdir,'noisy.wav');
        await encode(req.file.path,noisy,['-af',align,'-ar','48000','-ac','1','-c:a','pcm_s16le']);
        const outdir=path.join(req.workdir,'df');fs.mkdirSync(outdir);
        await new Promise((resolve,reject)=>{
          if(signal.aborted) return reject(new ServiceError(408,'EXPIRED','Request expired.'));
          const child=spawn(process.env.DEEPFILTER_PATH||'deep_filter',[noisy,'-o',outdir,...DF_LEVEL_ARGS[level]],{stdio:'ignore'});
          children.add(child);
          const onAbort=()=>child.kill('SIGKILL');
          signal.addEventListener('abort',onAbort,{once:true});
          child.on('error',()=>{children.delete(child);signal.removeEventListener('abort',onAbort);reject(new ServiceError(503,'DEEPFILTER_MISSING','DeepFilterNet could not start on this server.'));});
          child.on('close',code=>{children.delete(child);signal.removeEventListener('abort',onAbort);code===0?resolve():reject(new ServiceError(502,'DENOISE_FAILED','DeepFilterNet could not process this audio. Your original media is unchanged.'));});
        });
        signal.throwIfAborted();
        const found=fs.readdirSync(outdir).filter(f=>f.toLowerCase().endsWith('.wav')).map(f=>path.join(outdir,f)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size);
        if(!found.length) throw new ServiceError(502,'DENOISE_FAILED','DeepFilterNet produced no audio. Your original media is unchanged.');
        await encode(found[0],output,['-ar','48000','-ac','2','-c:a','pcm_s16le']);
        const denoised=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(denoised)||Math.abs(denoised-duration)>Math.max(0.5,duration*0.01))throw new ServiceError(502,'DURATION_MISMATCH','Denoised audio duration changed unexpectedly. Not applied; retain your original.');
      } else {
        const speech=path.join(req.workdir,'speech.mp3');
        await encode(req.file.path,speech,['-af',align,'-ar',kind==='captions'?'16000':'48000','-ac',kind==='captions'?'1':'2','-c:a','libmp3lame','-b:a',kind==='captions'?'64k':'192k']);
        if(kind==='captions') {
          const transcript=await providers.transcribe(speech,language,signal,provider);signal.throwIfAborted();
          let cues;
          try {cues=Captions.fromTranscript(transcript,duration);}catch {throw new ServiceError(502,'INVALID_TIMESTAMPS','Provider returned invalid caption timestamps. Please retry or add captions manually.');}
          res.json({provider:CAPTION_LABELS[provider],language:String(transcript.language||language||'und').slice(0,60),duration,cues,reviewRequired:true});cleanup();return;
        }
        const audio=await providers.isolate(speech,signal);signal.throwIfAborted();
        const isolated=path.join(req.workdir,'isolated-audio');fs.writeFileSync(isolated,audio);
        // Decode provider output to a known format and reject gross timing drift.
        await encode(isolated,output,['-ar','48000','-ac','2','-c:a','pcm_s16le']);
        const processed=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(processed)||Math.abs(processed-duration)>Math.max(0.5,duration*0.01))throw new ServiceError(502,'DURATION_MISMATCH','Isolated audio duration changed unexpectedly. Not applied; retain your original.');
      }
      signal.throwIfAborted();
      res.set('X-Processing-Method',kind==='filter'?'FFmpeg-filters-not-AI':kind==='deepfilter'?'DeepFilterNet-local-AI':kind==='silence'?'FFmpeg-silence-removal':kind==='reverse'?'FFmpeg-reverse':'ElevenLabs-Voice-Isolator');
      res.download(output,downloadName,cleanup);
    }catch(e){
      if(!closed&&!res.headersSent)res.status(e instanceof ServiceError?e.status:502).json({code:e.code||'PROCESSING_FAILED',error:e instanceof ServiceError?e.message:'Processing failed or timed out. Your original media is unchanged. No automatic paid retry was made.'});
      cleanup();
    }
  };
  const jsonParser=express.json({limit:'12mb'});
  const jsonJob=(kind)=>async(req,res)=>{
    if(active) return res.status(429).json({code:'BUSY',error:'Another job is running. Wait before trying again.'});
    if(publicMode) {
      const ip=clientIp(req),now=Date.now();
      const log=(ipAttempts.get(ip)||[]).filter(t=>now-t<86400000);
      if(log.filter(t=>now-t<3600000).length>=perIpHour||log.length>=perIpDay) return res.status(429).json({code:'IP_QUOTA',error:'Too many AI requests from this address. Try again later.'});
      log.push(now);ipAttempts.set(ip,log);
      if(ipAttempts.size>10000) ipAttempts.clear();
    }
    attempts=attempts.filter(t=>Date.now()-t<3600000);
    if(attempts.length>=jobsPerHour) return res.status(429).json({code:'HOURLY_LIMIT',error:'The server hourly AI request limit was reached. Wait before retrying.'});
    attempts.push(Date.now());
    active=true;
    const workdir=fs.mkdtempSync(path.join(root,'json-job-'));
    const controller=new AbortController(),signal=controller.signal;
    const children=new Set();
    let closed=false,deadline;
    const cleanup=()=>{
      if(closed)return;closed=true;clearTimeout(deadline);controller.abort();
      children.forEach(child=>child.kill('SIGKILL'));
      fs.rmSync(workdir,{recursive:true,force:true});
      active=false;
    };
    const runBin=(binary,args)=>new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new ServiceError(408,'EXPIRED','Request expired.'));
      const child=spawn(binary,args,{stdio:['ignore','pipe','ignore']});children.add(child);let out='';
      child.stdout.on('data',d=>{out+=d;if(out.length>2*1024*1024)child.kill('SIGKILL');});
      child.on('error',()=>reject(new ServiceError(503,'PROCESSOR_UNAVAILABLE','FFmpeg or FFprobe is unavailable on the server.')));
      child.on('close',code=>{children.delete(child);code===0?resolve(out):reject(new ServiceError(502,'MUX_FAILED','Audio-visual mastering failed on the server.'));});
    });
    deadline=setTimeout(()=>{
      if(!res.headersSent) res.status(408).json({code:'EXPIRED',error:'The processing deadline expired. No automatic paid retry was made.'});
      else res.destroy();
      cleanup();req.destroy();
    },lifetime);
    req.on('aborted',cleanup);res.on('close',cleanup);
    try {
      const body=req.body||{};
      if(kind==='genImage') {
        if(!providers.generateImage) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Image generation is not available on this server.');
        const result=await providers.generateImage({
          prompt:body.prompt,
          aspectRatio:body.aspectRatio,
          preset:body.preset,
          seed:body.seed,
          model:body.model||'auto',
        },signal);
        signal.throwIfAborted();
        res.set('Content-Type',result.mime||'image/jpeg');
        res.set('X-Processing-Method',result.provider||'AI-Image');
        res.send(result.bytes);
        cleanup();return;
      }
      if(kind==='genVideo') {
        if(body.imageDataUrl&&req.headers['x-upload-consent']!=='yes') throw new ServiceError(400,'CONSENT_REQUIRED','Explicit cloud-processing consent is required when uploading an image.');
        if(!providers.generateVideo) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Video generation is not available on this server.');
        const targetSec=Math.max(2,Math.min(15,Math.round(Number(body.duration)||8)));
        const result=await providers.generateVideo({
          prompt:body.prompt,
          aspectRatio:body.aspectRatio,
          duration:targetSec,
          imageDataUrl:body.imageDataUrl||null,
          model:body.model||'auto',
        },signal);
        signal.throwIfAborted();

        const wantSceneAudio=Boolean(body.includeSceneAudio);
        const wantMusic=Boolean(body.includeMusic);
        const wantNarration=Boolean(body.narrationText&&String(body.narrationText).trim()&&body.voiceLanguage&&body.voiceLanguage!=='none');
        if(!wantSceneAudio&&!wantMusic&&!wantNarration) {
          res.set('Content-Type',result.mime||'video/mp4');
          res.set('X-Processing-Method',result.provider||'AI-Video');
          res.send(result.bytes);
          cleanup();return;
        }

        // Google Flow–style Audio-Visual Mastering:
        // Generate synchronized scene Foley/SFX + background music + multilingual dialogue/voice and master into a single H.264/AAC MP4.
        const ff=process.env.FFMPEG_PATH||'ffmpeg';
        const fp=process.env.FFPROBE_PATH||'ffprobe';
        const rawVidPath=path.join(workdir,'raw.mp4');
        fs.writeFileSync(rawVidPath,result.bytes);
        let clipDur=Number((await runBin(fp,['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',rawVidPath]).catch(()=>''))||0);
        if(!Number.isFinite(clipDur)||clipDur<=0.2) clipDur=targetSec;

        const methods=[result.provider||'AI-Video'];
        const audioStems=[];

        // 1) Synchronized Scene Sound Effects (MMAudio / HunyuanVideo-Foley / Stable Audio Open)
        if(wantSceneAudio&&providers.generateVideoFoley) {
          try {
            const sfxRes=await providers.generateVideoFoley({
              videoBytes:result.bytes,
              prompt:String(body.sfxPrompt||body.prompt||'realistic ambient scene sound effects').slice(0,500),
              duration:clipDur,
              model:body.sfxModel||'auto',
            },signal);
            signal.throwIfAborted();
            if(sfxRes?.bytes?.length>100) {
              const sfxRaw=path.join(workdir,sfxRes.kind==='video-with-audio'?'foley-vid.mp4':'foley-raw.audio');
              const sfxWav=path.join(workdir,'sfx.wav');
              fs.writeFileSync(sfxRaw,sfxRes.bytes);
              await runBin(ff,['-nostdin','-v','error','-i',sfxRaw,'-vn','-ac','2','-ar','48000','-t',clipDur.toFixed(3),'-y',sfxWav]);
              audioStems.push({path:sfxWav,gain:wantNarration?0.55:0.85});
              methods.push(sfxRes.provider||'Scene-SFX');
            }
          } catch(sfxErr) {
            if(signal.aborted) throw sfxErr;
          }
        }

        // 2) Background Music Bed (Stable Audio Open / ACE-Step / MusicGen)
        if(wantMusic&&providers.generateMusic) {
          try {
            const musRes=await providers.generateMusic({
              prompt:String(body.musicPrompt||`cinematic soundtrack matching scene: ${body.prompt}`).slice(0,500),
              duration:Math.ceil(clipDur)+2,
              model:body.musicModel||'auto',
            },signal);
            signal.throwIfAborted();
            if(musRes?.bytes?.length>100) {
              const musRaw=path.join(workdir,'music-raw.audio');
              const musWav=path.join(workdir,'music.wav');
              fs.writeFileSync(musRaw,musRes.bytes);
              await runBin(ff,['-nostdin','-v','error','-i',musRaw,'-vn','-ac','2','-ar','48000','-t',clipDur.toFixed(3),'-y',musWav]);
              audioStems.push({path:musWav,gain:wantNarration?0.26:0.48});
              methods.push(musRes.provider||'AI-Music');
            }
          } catch(musErr) {
            if(signal.aborted) throw musErr;
          }
        }

        // 3) Multilingual Neural Voice / Dialogue
        let finalDur=clipDur;
        if(wantNarration&&providers.synthesizeSpeech) {
          try {
            const ttsRes=await providers.synthesizeSpeech({
              text:String(body.narrationText).trim(),
              language:body.voiceLanguage||'en',
              gender:body.voiceGender||'female',
              style:body.voiceStyle||'auto',
              model:body.ttsModel||'auto',
            },signal);
            signal.throwIfAborted();
            if(ttsRes?.bytes?.length>100) {
              const voRaw=path.join(workdir,'vo.mp3');
              const voWav=path.join(workdir,'vo.wav');
              fs.writeFileSync(voRaw,ttsRes.bytes);
              await runBin(ff,['-nostdin','-v','error','-i',voRaw,'-vn','-ac','2','-ar','48000','-y',voWav]);
              const voDur=Number((await runBin(fp,['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',voWav]).catch(()=>''))||0);
              if(Number.isFinite(voDur)&&voDur>finalDur) finalDur=Math.min(20,voDur+0.15);
              audioStems.push({path:voWav,gain:1.0});
              methods.push(ttsRes.provider||'Neural-TTS');
            }
          } catch(voErr) {
            if(signal.aborted) throw voErr;
          }
        }

        if(!audioStems.length) {
          res.set('Content-Type',result.mime||'video/mp4');
          res.set('X-Processing-Method',methods.join(' + '));
          res.send(result.bytes);
          cleanup();return;
        }

        const masteredPath=path.join(workdir,'mastered.mp4');
        const ffArgs=['-nostdin','-v','error','-threads','2','-stream_loop','-1','-i',rawVidPath];
        audioStems.forEach(s=>ffArgs.push('-i',s.path));
        const filterParts=audioStems.map((s,idx)=>`[${idx+1}:a]volume=${s.gain.toFixed(2)},apad,atrim=duration=${finalDur.toFixed(3)},asetpts=PTS-STARTPTS[a${idx}]`);
        const mixInputs=audioStems.map((_,idx)=>`[a${idx}]`).join('');
        const fadeOutStart=Math.max(0,finalDur-0.25).toFixed(3);
        const filterGraph=`${filterParts.join(';')};${mixInputs}amix=inputs=${audioStems.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,afade=t=in:st=0:d=0.04,afade=t=out:st=${fadeOutStart}:d=0.22[aout]`;
        ffArgs.push(
          '-filter_complex',filterGraph,
          '-map','0:v:0','-map','[aout]',
          '-t',finalDur.toFixed(3),
          '-c:v','libx264','-preset','ultrafast','-crf','22','-pix_fmt','yuv420p',
          '-c:a','aac','-b:a','160k','-movflags','+faststart',
          '-y',masteredPath
        );
        await runBin(ff,ffArgs);
        signal.throwIfAborted();
        const masteredBytes=fs.readFileSync(masteredPath);
        res.set('Content-Type','video/mp4');
        res.set('X-Processing-Method',methods.join(' + '));
        res.send(masteredBytes);
        cleanup();return;
      }
      if(kind==='genMusic') {
        if(!providers.generateMusic) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Music generation is not available on this server.');
        const result=await providers.generateMusic({
          prompt:body.prompt,
          duration:body.duration,
          lyrics:body.lyrics||'',
          model:body.model||'auto',
        },signal);
        signal.throwIfAborted();
        res.set('Content-Type',result.mime||'audio/wav');
        res.set('X-Processing-Method',result.provider||'AI-Music');
        res.send(result.bytes);
        cleanup();return;
      }
      if(kind==='genSfx') {
        if(!providers.generateVideoFoley) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Sound effect generation is not available on this server.');
        let videoBytes=null;
        if(body.videoDataUrl&&String(body.videoDataUrl).startsWith('data:')) {
          if(req.headers['x-upload-consent']!=='yes') throw new ServiceError(400,'CONSENT_REQUIRED','Explicit cloud-processing consent is required when uploading video.');
          videoBytes=Buffer.from(String(body.videoDataUrl).split(',')[1]||'','base64');
        }
        const result=await providers.generateVideoFoley({
          videoBytes,
          prompt:body.prompt,
          duration:body.duration,
          model:body.model||'auto',
        },signal);
        signal.throwIfAborted();
        if(result.kind==='video-with-audio') {
          const ff=process.env.FFMPEG_PATH||'ffmpeg';
          const vIn=path.join(workdir,'foley.mp4');
          const aOut=path.join(workdir,'foley.wav');
          fs.writeFileSync(vIn,result.bytes);
          await runBin(ff,['-nostdin','-v','error','-i',vIn,'-vn','-ac','2','-ar','48000','-y',aOut]);
          const wavBytes=fs.readFileSync(aOut);
          res.set('Content-Type','audio/wav');
          res.set('X-Processing-Method',result.provider||'AI-SFX');
          res.send(wavBytes);
          cleanup();return;
        }
        res.set('Content-Type',result.mime||'audio/wav');
        res.set('X-Processing-Method',result.provider||'AI-SFX');
        res.send(result.bytes);
        cleanup();return;
      }
      if(kind==='tts') {
        if(!providers.synthesizeSpeech) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Speech synthesis is not available on this server.');
        const result=await providers.synthesizeSpeech({
          text:body.text,
          language:body.language,
          gender:body.gender,
          style:body.style||'auto',
          model:body.model||'auto',
        },signal);
        signal.throwIfAborted();
        res.set('Content-Type',result.mime||'audio/mpeg');
        res.set('X-Processing-Method',result.provider||'Edge-Neural-TTS');
        res.send(result.bytes);
        cleanup();return;
      }
      if(kind==='studioPlan') {
        const studio=createStudioPipeline({providers});
        const {analysis,plan}=await studio.analyzeAndPlan({
          prompt:body.prompt,
          mode:body.mode||'text-to-video',
          aspectRatio:body.aspectRatio||'16:9',
          durationSec:body.duration||10,
          voiceLanguage:body.voiceLanguage||'auto',
          voiceGender:body.voiceGender||'auto',
          voiceStyle:body.voiceStyle||'auto',
          voicePreference:body.voicePreference||'auto',
          musicPreference:body.musicPreference||'auto',
          sfxPreference:body.sfxPreference||'auto',
        },signal);
        signal.throwIfAborted();
        res.json({analysis,plan});
        cleanup();return;
      }
      if(kind==='studioGenerate') {
        if(body.imageDataUrl&&req.headers['x-upload-consent']!=='yes') throw new ServiceError(400,'CONSENT_REQUIRED','Explicit cloud-processing consent is required when uploading an image.');
        if(!providers.generateVideo) throw new ServiceError(503,'KEY_NOT_CONFIGURED','Video generation is not available on this server.');
        const studio=createStudioPipeline({providers});
        const result=await studio.executeStudioJob({
          input:{
            prompt:body.prompt,
            mode:body.mode||(body.imageDataUrl?'image-to-video':'text-to-video'),
            aspectRatio:body.aspectRatio||'16:9',
            durationSec:body.duration||10,
            imageDataUrl:body.imageDataUrl||null,
            voiceLanguage:body.voiceLanguage||'auto',
            voiceGender:body.voiceGender||'auto',
            voiceStyle:body.voiceStyle||'auto',
            voicePreference:body.voicePreference||'auto',
            musicPreference:body.musicPreference||'auto',
            sfxPreference:body.sfxPreference||'auto',
          },
          workdir,
        },signal);
        signal.throwIfAborted();
        const planHeader=Buffer.from(JSON.stringify({
          title:result.analysis.title,
          durationSec:result.durationSec,
          sceneCount:result.plan.scenes.length,
          narrationRequested:result.analysis.narrationRequested,
          narrationLanguage:result.analysis.narrationLanguage,
          narrationScript:result.analysis.narrationScript,
          musicRequested:result.analysis.musicRequested,
          sfxRequested:result.analysis.sfxRequested,
          providersUsed:result.providersUsed,
        }),'utf8').toString('base64');
        res.set('Content-Type','video/mp4');
        res.set('X-Processing-Method',result.providersUsed.join(' + ')||'AI-Studio');
        res.set('X-Studio-Plan',planHeader);
        res.send(result.bytes);
        cleanup();return;
      }
      throw new ServiceError(400,'UNKNOWN_JOB','Unknown request.');
    }catch(e){
      if(!closed&&!res.headersSent)res.status(e instanceof ServiceError?e.status:502).json({code:e.code||'PROCESSING_FAILED',error:e instanceof ServiceError?e.message:'Processing failed or timed out. No automatic paid retry was made.'});
      cleanup();
    }
  };
  const studioJobs=new Map();
  const pruneStudioJobs=()=>{
    const now=Date.now();
    for(const [id,st] of studioJobs) {
      if(now-st.createdAt>lifetime) {
        try{st.controller?.abort();}catch{}
        if(st.workdir) fs.rmSync(st.workdir,{recursive:true,force:true});
        studioJobs.delete(id);
      }
    }
  };
  app.post('/api/studio/jobs',authorized,jsonParser,(req,res)=>{
    pruneStudioJobs();
    if(active) return res.status(429).json({code:'BUSY',error:'Another job is running. Wait before trying again.'});
    const body=req.body||{};
    if(!String(body.prompt||'').trim()) return res.status(400).json({code:'EMPTY_PROMPT',error:'Describe the video you want to create first.'});
    if(body.imageDataUrl&&req.headers['x-upload-consent']!=='yes') return res.status(400).json({code:'CONSENT_REQUIRED',error:'Explicit cloud-processing consent is required when uploading an image.'});
    if(!providers.generateVideo) return res.status(503).json({code:'KEY_NOT_CONFIGURED',error:'Video generation is not available on this server.'});
    if(publicMode) {
      const ip=clientIp(req),now=Date.now();
      const log=(ipAttempts.get(ip)||[]).filter(t=>now-t<86400000);
      if(log.filter(t=>now-t<3600000).length>=perIpHour||log.length>=perIpDay) return res.status(429).json({code:'IP_QUOTA',error:'Too many AI requests from this address. Try again later.'});
      log.push(now);ipAttempts.set(ip,log);
      if(ipAttempts.size>10000) ipAttempts.clear();
    }
    attempts=attempts.filter(t=>Date.now()-t<3600000);
    if(attempts.length>=jobsPerHour) return res.status(429).json({code:'HOURLY_LIMIT',error:'The server hourly AI request limit was reached. Wait before retrying.'});
    attempts.push(Date.now());

    const parentJob=body.resumeJobId?studioJobs.get(String(body.resumeJobId)):null;
    const regenSceneIdx=Number.isInteger(body.regenerateSceneIndex)?body.regenerateSceneIndex:null;
    const sceneCache=parentJob?.sceneCache instanceof Map?new Map(parentJob.sceneCache):new Map();

    const jobId='studio_'+crypto.randomBytes(12).toString('hex');
    const workdir=fs.mkdtempSync(path.join(root,'studio-job-'));
    const controller=new AbortController();
    active=true;
    const jobState={
      id:jobId,
      createdAt:Date.now(),
      status:'running',
      stage:'planning',
      stageLabel:'Planning Video Scenes',
      sceneIndex:0,
      sceneCount:parentJob?.plan?.scenes?.length||1,
      analysis:parentJob?.analysis||null,
      plan:parentJob?.plan||null,
      sceneCache,
      completedSceneNumbers:[...sceneCache.keys()].map(i=>i+1),
      providersUsed:[],
      error:null,
      videoBytes:null,
      narrationBytes:null,
      narrationMime:null,
      durationSec:0,
      workdir,
      controller,
    };
    const timer=setTimeout(()=>{
      if(jobState.status==='running') {
        jobState.status='failed';
        jobState.error='The processing deadline expired. No automatic paid retry was made.';
        controller.abort();
        fs.rmSync(workdir,{recursive:true,force:true});
        jobState.workdir=null;
        active=false;
      }
    },lifetime);
    studioJobs.set(jobId,jobState);

    const studio=createStudioPipeline({providers});
    (async()=>{
      try {
        const out=await studio.executeStudioJob({
          input:{
            prompt:body.prompt,
            mode:body.mode||(body.imageDataUrl?'image-to-video':'text-to-video'),
            aspectRatio:body.aspectRatio||'16:9',
            durationSec:body.duration||10,
            imageDataUrl:body.imageDataUrl||null,
            voiceLanguage:body.voiceLanguage||'auto',
            voiceGender:body.voiceGender||'auto',
            voiceStyle:body.voiceStyle||'auto',
            voicePreference:body.voicePreference||'auto',
            musicPreference:body.musicPreference||'auto',
            sfxPreference:body.sfxPreference||'auto',
          },
          workdir,
          existingAnalysis:parentJob?.analysis||null,
          existingPlan:parentJob?.plan||null,
          sceneCache,
          regenerateSceneIndex:regenSceneIdx,
          onProgress:(p)=>{
            jobState.stage=p.stage||jobState.stage;
            jobState.stageLabel=p.label||jobState.stageLabel;
            if(p.analysis) jobState.analysis=p.analysis;
            if(p.plan) jobState.plan=p.plan;
            if(typeof p.sceneIndex==='number') jobState.sceneIndex=p.sceneIndex;
            if(typeof p.sceneCount==='number') jobState.sceneCount=p.sceneCount;
            jobState.completedSceneNumbers=[...sceneCache.keys()].map(i=>i+1);
          },
        },controller.signal);
        clearTimeout(timer);
        jobState.videoBytes=out.bytes;
        jobState.narrationBytes=out.narrationAudioBytes;
        jobState.narrationMime=out.narrationMime;
        jobState.musicBytes=out.musicAudioBytes;
        jobState.musicMime=out.musicMime;
        jobState.sfxBytes=out.sfxAudioBytes;
        jobState.sfxMime=out.sfxMime;
        jobState.durationSec=out.durationSec;
        jobState.providersUsed=out.providersUsed;
        jobState.analysis=out.analysis;
        jobState.plan=out.plan;
        jobState.sceneCount=out.plan.scenes.length;
        jobState.completedSceneNumbers=[...sceneCache.keys()].map(i=>i+1);
        jobState.stage='ready';
        jobState.stageLabel='Completed';
        jobState.status='completed';
      } catch(err) {
        clearTimeout(timer);
        jobState.completedSceneNumbers=[...sceneCache.keys()].map(i=>i+1);
        jobState.status=controller.signal.aborted?'cancelled':'failed';
        jobState.error=err instanceof ServiceError?err.message:(err?.message||'Video generation failed.');
      } finally {
        if(jobState.workdir) {
          fs.rmSync(jobState.workdir,{recursive:true,force:true});
          jobState.workdir=null;
        }
        active=false;
      }
    })();

    res.status(202).json({jobId,status:'running',stage:jobState.stage,stageLabel:jobState.stageLabel});
  });
  app.get('/api/studio/jobs/:id',authorized,(req,res)=>{
    pruneStudioJobs();
    const st=studioJobs.get(req.params.id);
    if(!st) return res.status(404).json({code:'NOT_FOUND',error:'Studio job not found or expired.'});
    res.json({
      jobId:st.id,
      status:st.status,
      stage:st.stage,
      stageLabel:st.stageLabel,
      sceneIndex:st.sceneIndex,
      sceneCount:st.sceneCount,
      completedSceneNumbers:st.completedSceneNumbers||[],
      durationSec:st.durationSec,
      providersUsed:st.providersUsed,
      error:st.error,
      hasNarrationAudio:Boolean(st.narrationBytes),
      hasMusicAudio:Boolean(st.musicBytes),
      hasSfxAudio:Boolean(st.sfxBytes),
      analysis:st.analysis?{
        title:st.analysis.title,
        subject:st.analysis.subject,
        aspectRatio:st.analysis.aspectRatio,
        requestedDurationSec:st.analysis.requestedDurationSec,
        narrationRequested:st.analysis.narrationRequested,
        narrationLanguage:st.analysis.narrationLanguage,
        voiceGender:st.analysis.voiceGender,
        voiceStyle:st.analysis.voiceStyle,
        narrationScript:st.analysis.narrationScript,
        musicRequested:st.analysis.musicRequested,
        sfxRequested:st.analysis.sfxRequested,
      }:null,
      scenes:st.plan?.scenes?.map(s=>({sceneNumber:s.sceneNumber,durationSec:s.durationSec,cameraMovement:s.cameraMovement}))||[],
    });
  });
  app.get('/api/studio/jobs/:id/video',authorized,(req,res)=>{
    pruneStudioJobs();
    const st=studioJobs.get(req.params.id);
    if(!st||!st.videoBytes) return res.status(404).json({code:'NOT_FOUND',error:'Generated video is not ready or has expired.'});
    res.set('Content-Type','video/mp4');
    res.set('X-Processing-Method',st.providersUsed.join(' + ')||'AI-Studio');
    res.send(st.videoBytes);
  });
  app.get('/api/studio/jobs/:id/narration',authorized,(req,res)=>{
    pruneStudioJobs();
    const st=studioJobs.get(req.params.id);
    if(!st||!st.narrationBytes) return res.status(404).json({code:'NOT_FOUND',error:'Narration preview is not available for this generation.'});
    res.set('Content-Type',st.narrationMime||'audio/mpeg');
    res.send(st.narrationBytes);
  });
  app.get('/api/studio/jobs/:id/music',authorized,(req,res)=>{
    pruneStudioJobs();
    const st=studioJobs.get(req.params.id);
    if(!st||!st.musicBytes) return res.status(404).json({code:'NOT_FOUND',error:'Music stem is not available for this generation.'});
    res.set('Content-Type',st.musicMime||'audio/wav');
    res.send(st.musicBytes);
  });
  app.get('/api/studio/jobs/:id/sfx',authorized,(req,res)=>{
    pruneStudioJobs();
    const st=studioJobs.get(req.params.id);
    if(!st||!st.sfxBytes) return res.status(404).json({code:'NOT_FOUND',error:'Sound effects stem is not available for this generation.'});
    res.set('Content-Type',st.sfxMime||'audio/wav');
    res.send(st.sfxBytes);
  });
  app.post('/api/studio/jobs/:id/cancel',authorized,(req,res)=>{
    const st=studioJobs.get(req.params.id);
    if(!st) return res.status(404).json({code:'NOT_FOUND',error:'Studio job not found.'});
    st.status='cancelled';
    try{st.controller?.abort();}catch{}
    if(st.workdir){fs.rmSync(st.workdir,{recursive:true,force:true});st.workdir=null;}
    active=false;
    res.json({jobId:st.id,status:'cancelled'});
  });
  app.post('/enhance',authorized,job('filter'));
  app.post('/api/captions',authorized,job('captions'));
  app.post('/api/isolate',authorized,job('isolation'));
  app.post('/api/denoise-local',authorized,job('deepfilter'));
  app.post('/api/silence',authorized,job('silence'));
  app.post('/api/reverse',authorized,job('reverse'));
  app.post('/api/generate-image',authorized,jsonParser,jsonJob('genImage'));
  app.post('/api/generate-video',authorized,jsonParser,jsonJob('genVideo'));
  app.post('/api/generate-music',authorized,jsonParser,jsonJob('genMusic'));
  app.post('/api/generate-sfx',authorized,jsonParser,jsonJob('genSfx'));
  app.post('/api/tts',authorized,jsonParser,jsonJob('tts'));
  app.post('/api/studio/plan',authorized,jsonParser,jsonJob('studioPlan'));
  app.post('/api/studio/generate',authorized,jsonParser,jsonJob('studioGenerate'));
  return app;
}
if(require.main===module){
  const server=createApp().listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log('VoiceCut processing server ready'));
  server.requestTimeout=TTL;server.headersTimeout=30000;
}
module.exports={createApp,TTL};

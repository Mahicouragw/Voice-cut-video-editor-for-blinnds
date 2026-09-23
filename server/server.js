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
  const perIpHour=Number(process.env.MAX_AI_PER_IP_PER_HOUR||5),perIpDay=Number(process.env.MAX_AI_PER_IP_PER_DAY||20);
  if(!Number.isInteger(perIpHour)||perIpHour<1||perIpHour>100||!Number.isInteger(perIpDay)||perIpDay<1||perIpDay>500) throw new Error('Per-IP quotas must be within 1-100/hour and 1-500/day.');
  const origin=options.origin||process.env.ALLOWED_ORIGIN;
  if(!origin||new URL(origin).origin!==origin||!origin.startsWith('https://')) throw new Error('ALLOWED_ORIGIN must be an exact HTTPS origin.');
  const origins=new Set([origin]);
  if(options.allowAndroid??process.env.ALLOW_ANDROID_APP==='true') origins.add('http://localhost:8080');
  const providers=options.providers||createProviders({openaiKey:process.env.OPENAI_API_KEY,elevenKey:process.env.ELEVENLABS_API_KEY,groqKey:process.env.GROQ_API_KEY,deepgramKey:process.env.DEEPGRAM_API_KEY,assemblyKey:process.env.ASSEMBLYAI_API_KEY});
  const root=options.root||path.join(os.tmpdir(),'voicecut-temporary');
  const lifetime=Math.min(TTL,options.ttlMs||TTL); // Shorter deadline only used by tests.
  const jobsPerHour=Number(process.env.MAX_AI_REQUESTS_PER_HOUR||20);
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
      res.set('Access-Control-Expose-Headers','X-Processing-Method, X-Silence-Removed, X-Silence-Seconds');
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
  app.get('/capabilities',authorized,(_,res)=>{const keys=providers.configured.captionProviders||{openai:providers.configured.captions};res.json({publicMode,captions:providers.configured.captions,isolation:providers.configured.isolation,autoProvider:CAPTION_ORDER.find(id=>keys[id])||null,captionProviders:providers.configured.captionProviders||{openai:providers.configured.captions},deepFilterNet:deepFilterAvailable(),providerKeys:'Configuration only; not validated with providers',maxUploadMB:100,maxDurationSeconds:600,temporaryFileTTLSeconds:900});});
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
    if(kind==='silence'&&(!Number.isFinite(silenceSeconds)||silenceSeconds<1||silenceSeconds>10)) return res.status(400).json({code:'BAD_SECONDS',error:'Silence length must be between 1 and 10 seconds.'});
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
      const output=path.join(req.workdir,(kind==='silence'&&hasVideo)?'trimmed.mp4':'processed.wav');
      const downloadName=(kind==='silence'&&hasVideo)?'silence-removed.mp4':'processed.wav';
      if(kind==='silence') {
        // Real silence removal: detect quiet gaps, cut them from audio AND video.
        const detect=await runStderr(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','info','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',req.file.path,'-af',`silencedetect=noise=-30dB:d=${silenceSeconds}`,'-vn','-sn','-dn','-f','null','-']);
        signal.throwIfAborted();
        const gaps=[];let pending=null;
        for(const line of detect.split('\n')){
          let m=/silence_start:\s*([0-9.]+)/.exec(line);if(m){pending=Number(m[1]);continue;}
          m=/silence_end:\s*([0-9.]+)/.exec(line);if(m&&pending!==null){gaps.push([pending,Number(m[1])]);pending=null;}
        }
        if(pending!==null)gaps.push([pending,duration]);
        const silent=gaps.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b-a>=silenceSeconds-0.05&&a<duration);
        const kept=[];let cursor=0,removed=0;
        for(const [a,b] of silent){const st=Math.max(0,a),en=Math.min(duration,b);if(st>cursor+0.02)kept.push([cursor,st]);removed+=Math.max(0,en-st);cursor=Math.max(cursor,en);}
        if(cursor<duration-0.02)kept.push([cursor,duration]);
        if(!kept.length)throw new ServiceError(422,'SILENCE_ONLY','No speech found: the whole recording is quiet. Your original media is unchanged.');
        const span=([a,b])=>`between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`;
        const expr=kept.map(span).join('+');
        if(hasVideo){
          await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',req.file.path,'-vf',`select=${expr},setpts=N/FRAME_RATE/TB`,'-af',`aselect=${expr},asetpts=N/SR/TB`,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart','-y',output]);
        }else{
          await encode(req.file.path,output,['-af',`aselect=${expr},asetpts=N/SR/TB,aresample=48000`,'-ar','48000','-ac','2','-c:a','pcm_s16le']);
        }
        signal.throwIfAborted();
        const expected=kept.reduce((t,[a,b])=>t+(b-a),0);
        const trimmed=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(trimmed)||Math.abs(trimmed-expected)>Math.max(1.0,expected*0.05))throw new ServiceError(502,'TRIM_MISMATCH','Trimmed media duration changed unexpectedly. Not applied; retain your original.');
        res.set('X-Silence-Removed',String(silent.length));
        res.set('X-Silence-Seconds',removed.toFixed(1));
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
      res.set('X-Processing-Method',kind==='filter'?'FFmpeg-filters-not-AI':kind==='deepfilter'?'DeepFilterNet-local-AI':kind==='silence'?'FFmpeg-silence-removal':'ElevenLabs-Voice-Isolator');
      res.download(output,downloadName,cleanup);
    }catch(e){
      if(!closed&&!res.headersSent)res.status(e instanceof ServiceError?e.status:502).json({code:e.code||'PROCESSING_FAILED',error:e instanceof ServiceError?e.message:'Processing failed or timed out. Your original media is unchanged. No automatic paid retry was made.'});
      cleanup();
    }
  };
  app.post('/enhance',authorized,job('filter'));
  app.post('/api/captions',authorized,job('captions'));
  app.post('/api/isolate',authorized,job('isolation'));
  app.post('/api/denoise-local',authorized,job('deepfilter'));
  app.post('/api/silence',authorized,job('silence'));
  return app;
}
if(require.main===module){
  const server=createApp().listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log('VoiceCut processing server ready'));
  server.requestTimeout=TTL;server.headersTimeout=30000;
}
module.exports={createApp,TTL};

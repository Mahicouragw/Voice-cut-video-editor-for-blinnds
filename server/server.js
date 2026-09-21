'use strict';
require('dotenv').config({path:require('node:path').join(__dirname,'.env'),quiet:true});
const express=require('express');
const multer=require('multer');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {createProviders,ServiceError}=require('./providers');
const Captions=require('../web/captions');
const TTL=15*60*1000;
const FORMATS='mov,matroska,webm,wav,mp3,flac,ogg,aac,aiff';
function createApp(options={}) {
  const key=options.key||process.env.SERVER_ACCESS_KEY;
  if(!key||key.length<32) throw new Error('Set SERVER_ACCESS_KEY to a random secret of at least 32 characters.');
  const origin=options.origin||process.env.ALLOWED_ORIGIN;
  if(!origin||new URL(origin).origin!==origin||!origin.startsWith('https://')) throw new Error('ALLOWED_ORIGIN must be an exact HTTPS origin.');
  const origins=new Set([origin]);
  if(options.allowAndroid??process.env.ALLOW_ANDROID_APP==='true') origins.add('http://localhost:8080');
  const providers=options.providers||createProviders({openaiKey:process.env.OPENAI_API_KEY,elevenKey:process.env.ELEVENLABS_API_KEY});
  const root=options.root||path.join(os.tmpdir(),'voicecut-temporary');
  const lifetime=Math.min(TTL,options.ttlMs||TTL); // Shorter deadline only used by tests.
  const jobsPerHour=Number(process.env.MAX_AI_REQUESTS_PER_HOUR||20);
  if(!Number.isInteger(jobsPerHour)||jobsPerHour<1||jobsPerHour>100) throw new Error('MAX_AI_REQUESTS_PER_HOUR must be between 1 and 100.');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  for(const name of fs.readdirSync(root)) fs.rmSync(path.join(root,name),{recursive:true,force:true});
  const app=express();app.disable('x-powered-by');
  let active=false,attempts=[];
  app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    if(req.headers.origin) {
      if(!origins.has(req.headers.origin)) return res.status(403).json({code:'ORIGIN_DENIED',error:'This website origin is not allowed by your server.'});
      res.set('Access-Control-Allow-Origin',req.headers.origin);res.set('Vary','Origin');
      res.set('Access-Control-Allow-Headers','Authorization, Content-Type, X-Upload-Consent');
      res.set('Access-Control-Allow-Methods','POST, GET, OPTIONS');
    }
    if(req.method==='OPTIONS') return res.sendStatus(204);
    next();
  });
  const authorized=(req,res,next)=>{
    const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+key);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({code:'ACCESS_KEY_REJECTED',error:'Server access key rejected. Re-enter the current SERVER_ACCESS_KEY in editor Settings.'});
    next();
  };
  app.get('/health',(_,res)=>res.json({status:'ok',version:'1.2.0',temporaryFileTTLSeconds:900}));
  app.get('/capabilities',authorized,(_,res)=>res.json({captions:providers.configured.captions,isolation:providers.configured.isolation,providerKeys:'Configuration only; not validated with providers',maxUploadMB:100,maxDurationSeconds:600,temporaryFileTTLSeconds:900}));
  const storage=multer.diskStorage({destination:(req,_,cb)=>cb(null,req.workdir),filename:(_,__,cb)=>cb(null,'input')});
  const upload=multer({storage,limits:{fileSize:100*1024*1024,files:1,fields:0,parts:1}}).single('file');
  const job=(kind)=>async(req,res)=>{
    if(active) return res.status(429).json({code:'BUSY',error:'Another job is running. Wait before trying again.'});
    const cloud=kind!=='filter';
    const language=String(req.query.language||'');
    if(language&&!/^[a-z]{2}$/.test(language)) return res.status(400).json({error:'Language must be blank for automatic detection or a two-letter code.'});
    if(cloud) {
      if(req.headers['x-upload-consent']!=='yes') return res.status(400).json({code:'CONSENT_REQUIRED',error:'Explicit cloud-processing consent is required.'});
      if(!providers.configured[kind==='captions'?'captions':'isolation']) return res.status(503).json({code:'KEY_NOT_CONFIGURED',error:(kind==='captions'?'OPENAI_API_KEY':'ELEVENLABS_API_KEY')+' is not configured on the server.'});
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
      const output=path.join(req.workdir,'processed.wav');
      if(kind==='filter') {
        await encode(req.file.path,output,['-af',align+',highpass=f=80,lowpass=f=12000,afftdn=nf=-25','-ar','48000','-ac','2','-c:a','pcm_s16le']);
      } else {
        const speech=path.join(req.workdir,'speech.mp3');
        await encode(req.file.path,speech,['-af',align,'-ar',kind==='captions'?'16000':'48000','-ac',kind==='captions'?'1':'2','-c:a','libmp3lame','-b:a',kind==='captions'?'64k':'192k']);
        if(kind==='captions') {
          const transcript=await providers.transcribe(speech,language,signal);signal.throwIfAborted();
          let cues;
          try {cues=Captions.fromTranscript(transcript,duration);}catch {throw new ServiceError(502,'INVALID_TIMESTAMPS','Provider returned invalid caption timestamps. Please retry or add captions manually.');}
          res.json({provider:'OpenAI whisper-1',language:String(transcript.language||language||'und').slice(0,60),duration,cues,reviewRequired:true});cleanup();return;
        }
        const audio=await providers.isolate(speech,signal);signal.throwIfAborted();
        const isolated=path.join(req.workdir,'isolated-audio');fs.writeFileSync(isolated,audio);
        // Decode provider output to a known format and reject gross timing drift.
        await encode(isolated,output,['-ar','48000','-ac','2','-c:a','pcm_s16le']);
        const processed=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output]));
        if(!Number.isFinite(processed)||Math.abs(processed-duration)>Math.max(0.5,duration*0.01))throw new ServiceError(502,'DURATION_MISMATCH','Isolated audio duration changed unexpectedly. Not applied; retain your original.');
      }
      signal.throwIfAborted();
      res.set('X-Processing-Method',kind==='filter'?'FFmpeg-filters-not-AI':'ElevenLabs-Voice-Isolator');
      res.download(output,'processed.wav',cleanup);
    }catch(e){
      if(!closed&&!res.headersSent)res.status(e instanceof ServiceError?e.status:502).json({code:e.code||'PROCESSING_FAILED',error:e instanceof ServiceError?e.message:'Processing failed or timed out. Your original media is unchanged. No automatic paid retry was made.'});
      cleanup();
    }
  };
  app.post('/enhance',authorized,job('filter'));
  app.post('/api/captions',authorized,job('captions'));
  app.post('/api/isolate',authorized,job('isolation'));
  return app;
}
if(require.main===module){
  const server=createApp().listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log('VoiceCut processing server ready'));
  server.requestTimeout=TTL;server.headersTimeout=30000;
}
module.exports={createApp,TTL};

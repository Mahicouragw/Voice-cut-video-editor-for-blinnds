/* One-command, consent-gated GitHub publication. No credential is committed or printed. */
'use strict';
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const REPO='Mahicouragw/Voice-cut-video-editor-for-blinnds';
const ROOT=path.resolve(__dirname,'..');
process.chdir(ROOT);
const gh=process.env.VOICECUT_GH_BIN||'gh';
const cache=process.env.VOICECUT_AUTH_ROOT||path.join(os.homedir(),'.cache','voicecut-auth');
fs.mkdirSync(cache,{recursive:true,mode:0o700});
const authDir=fs.mkdtempSync(path.join(cache,'session-'));fs.chmodSync(authDir,0o700);
const env={...process.env,GH_CONFIG_DIR:authDir,GH_HOST:'github.com',GH_PROMPT_DISABLED:'true',GH_BROWSER:'true',NO_COLOR:'1'};
// Only the fresh, user-approved device session may be used by this command.
delete env.GH_TOKEN;delete env.GITHUB_TOKEN;delete env.GH_ENTERPRISE_TOKEN;delete env.GITHUB_ENTERPRISE_TOKEN;
let activeChild=null;
let authorized=false;
function terminate(child){if(!child)return;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}}
function run(command,args,{capture=false,timeout=120000,allowFailure=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:ROOT,env,detached:process.platform!=='win32',stdio:['ignore',capture?'pipe':'inherit',capture?'pipe':'inherit']});
    activeChild=child;let stdout='',stderr='',expired=false,killTimer;
    if(capture){child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);}
    const timer=setTimeout(()=>{expired=true;terminate(child);killTimer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},5000);},timeout);
    child.on('error',error=>{clearTimeout(timer);clearTimeout(killTimer);activeChild=null;reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);activeChild=null;
      if(expired)return reject(new Error(command===gh&&args[0]==='auth'?'AUTHORIZATION EXPIRED: stopped waiting after 15 minutes. No push or deployment was authorized. Start npm run all again for a new device code.':'Command exceeded its time limit: '+command));
      if(code!==0&&!allowFailure)return reject(new Error(command+' '+args.slice(0,3).join(' ')+' failed with exit '+code+(stderr?'\n'+stderr.trim():'')));
      resolve({stdout:stdout.trim(),stderr:stderr.trim(),code});
    });
  });
}
const git=(args,options)=>run('git',args,options);
const api=async(args)=>JSON.parse((await run(gh,args,{capture:true})).stdout);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForRuns(branch,event,sha,expected,maxMinutes){
  const deadline=Date.now()+maxMinutes*60000;let previous='';
  while(Date.now()<deadline){
    const runs=await api(['run','list','--repo',REPO,'--branch',branch,'--event',event,'--limit','30','--json','databaseId,name,status,conclusion,headSha,url']);
    const latest=expected.map(name=>runs.find(r=>r.name===name&&r.headSha===sha));
    const status=latest.map((r,i)=>expected[i]+': '+(r?r.status+(r.conclusion?' / '+r.conclusion:''):'waiting for GitHub to schedule')).join('\n');
    if(status!==previous){console.log(status);previous=status;}
    for(const r of latest){if(r?.status==='completed'&&r.conclusion!=='success')throw new Error('GitHub checks did not pass. Nothing will be force-merged. Inspect '+r.url);}
    if(latest.every(r=>r?.status==='completed'&&r.conclusion==='success'))return latest;
    await delay(15000);
  }
  throw new Error('GitHub checks are still pending. Authorization is already complete; this is a separate build/deployment wait. Inspect https://github.com/'+REPO+'/actions');
}
async function publish(){
  console.log('VOICECUT: npm run all');
  console.log('Preflight: validating the repository connection before requesting authorization.');
  const remoteURL='https://github.com/'+REPO+'.git';
  const configured=await git(['remote','get-url','origin'],{capture:true,allowFailure:true});
  if(configured.code!==0){await git(['remote','add','origin',remoteURL]);console.log('Restored origin to the requested VoiceCut repository.');}
  else if(configured.stdout!==remoteURL&&configured.stdout!==remoteURL.replace(/\.git$/,''))throw new Error('Origin points to another repository. Stopping before authorization instead of changing it.');
  await git(['fetch','origin','main']);
  const localBase=(await git(['rev-parse','HEAD'],{capture:true})).stdout;
  const upstreamBase=(await git(['rev-parse','origin/main'],{capture:true})).stdout;
  if(localBase!==upstreamBase)throw new Error('The local baseline and GitHub main differ. Reconcile changes before requesting another authorization.');

  console.log('Step 1: official GitHub device authorization. Maximum waiting time: 15 minutes. Provider expiry may be earlier.');
  console.log('Review the GitHub CLI OAuth permissions on GitHub. Repository and workflow writes are required to publish this update. Do not paste an API key or personal access token into chat.');
  await run(gh,['auth','login','--hostname','github.com','--git-protocol','https','--web','--scopes','workflow','--insecure-storage'],{timeout:15*60000});
  authorized=true;
  console.log('DEVICE AUTHORIZATION COMPLETE. Beginning publication; this does not revoke GitHub credentials after 15 minutes.');
  const user=await api(['api','user']);console.log('Authorized GitHub account: '+user.login);
  const permissions=await api(['repo','view',REPO,'--json','viewerPermission']);
  if(!['ADMIN','MAINTAIN','WRITE'].includes(permissions.viewerPermission))throw new Error('This account cannot write to the requested repository. No files were pushed.');

  console.log('Step 2: installing dependencies and verifying the update.');
  await run('npm',['ci'],{timeout:5*60000});
  await run('npm',['--prefix','server','ci'],{timeout:5*60000});
  await run('npm',['test']);
  await run('npm',['--prefix','server','test']);
  await run('npx',['playwright','install','--with-deps','chromium'],{timeout:10*60000});
  await run('npm',['run','test:browser'],{timeout:5*60000});
  await run('npm',['run','build']);

  console.log('Step 3: safely publishing on a new branch. No force push or branch deletion.');
  const baseline=(await git(['rev-parse','HEAD'],{capture:true})).stdout;
  await git(['fetch','origin','main']);
  const remote=(await git(['rev-parse','origin/main'],{capture:true})).stdout;
  if(baseline!==remote)throw new Error('GitHub main has changed since this repair baseline. Stopping rather than overwriting newer work.');
  const branch='voicecut/ai-device-deploy-'+new Date().toISOString().replace(/[-:.]/g,'').replace('T','-').replace('Z','');
  await git(['switch','-c',branch]);
  await git(['add','.github','.gitignore','.dockerignore','Dockerfile','render.yaml','README.md','START_HERE.md','AI_UPDATE_START_HERE.md','PUSH_TO_GITHUB.md','REAL_AI_SETUP_CLICKABLE.md','docs','index.html','package.json','package-lock.json','web','server','scripts','tests','flutter_app']);
  const names=(await git(['diff','--cached','--name-only'],{capture:true})).stdout.split('\n');
  const blockedStaged=names.filter(name=>/(^|\/)\.env$|\.(jks|keystore|pem|base64)$|(^|\/)key\.properties$/.test(name)&&name!=='flutter_app/android/app/voicecut-debug.keystore');if(blockedStaged.length)throw new Error('A credential-related file was staged. Refusing to commit.');
  await git(['-c','user.name=VoiceCut deployment automation','-c','user.email=voicecut-deployment@users.noreply.github.com','commit','-m','VoiceCut app 2.2: offline NR-1 noise reduction, silence remover, reliable cloud retry']);
  const sha=(await git(['rev-parse','HEAD'],{capture:true})).stdout;
  await git(['-c','credential.helper=','-c','credential.helper=!'+gh+' auth git-credential','push','-u','origin',branch]);
  const body=path.join(authDir,'pull-request.md');
  fs.writeFileSync(body,'User-authorized VoiceCut app 2.2 update.\n\nTalkBack linear navigation got stuck on the native app bar and could not swipe into the page. The wrapper is now a fullscreen WebView with no native header. Noise reduction now works fully offline via the NR-1 spectral engine, the cloud AI path retries patiently with honest errors, a silence remover cuts quiet gaps from audio and video, and a permanent install key lets updates install over each other. No keys in the app; keys stay in server env.\n\nNo API keys are included. This automation merges only after the website and Android pull-request workflows succeed. It does not bypass protected-branch rules or delete branches.\n');
  await run(gh,['pr','create','--repo',REPO,'--base','main','--head',branch,'--title','VoiceCut app 2.2: reliable noise reduction + silence remover','--body-file',body]);
  const pr=await api(['pr','view',branch,'--repo',REPO,'--json','number,url']);console.log('Pull request: '+pr.url);
  await waitForRuns(branch,'pull_request',sha,['Test and deploy website','Android test APK and optional signed AAB'],40);

  console.log('Step 4: configuring GitHub Pages to use the reviewed workflow.');
  const pages=await run(gh,['api','repos/'+REPO+'/pages'],{capture:true,allowFailure:true});
  if(pages.code===0)await run(gh,['api','--method','PUT','repos/'+REPO+'/pages','-f','build_type=workflow']);
  else if(pages.stderr.includes('404'))await run(gh,['api','--method','POST','repos/'+REPO+'/pages','-f','build_type=workflow']);
  else throw new Error('Could not inspect Pages settings. An owner may need to grant permission; no protection will be bypassed.');
  await run(gh,['pr','merge',String(pr.number),'--repo',REPO,'--squash','--match-head-commit',sha]);
  const main=await api(['api','repos/'+REPO+'/branches/main']);
  const completed=await waitForRuns('main','push',main.commit.sha,['Test and deploy website'],25);
  const deployed=await api(['api','repos/'+REPO+'/pages']);
  console.log('WEBSITE DEPLOYMENT SUCCEEDED: '+deployed.html_url);
  console.log('Verified successful workflow: '+completed[0].url);
  console.log('The AI backend is separate. Render account approval and private provider keys are still needed; GitHub approval does not authorize paid hosting or create API keys.');
}
function cleanup(){fs.rmSync(authDir,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{terminate(activeChild);cleanup();process.exit(130);});
publish().catch(async error=>{
  console.error('STOPPED: '+error.message);process.exitCode=1;
  if(authorized){
    console.log('PAUSED_FOR_REPAIR: preserving the already-authorized private session for at most 30 minutes so a build/deployment issue can be repaired without another sign-in. No further publishing actions run automatically during this pause.');
    await delay(30*60000);
  }
}).finally(()=>{cleanup();console.log('Temporary local GitHub credential files removed. This does not revoke the GitHub CLI OAuth grant; manage it in GitHub account settings.');});

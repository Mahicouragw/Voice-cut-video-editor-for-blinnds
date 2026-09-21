// Dispatch an existing reviewed workflow; never pushes, deletes branches or force-pushes.
const {spawnSync} = require('node:child_process');
function run(args, timeout=60000) {
  const result = spawnSync('gh',args,{stdio:'inherit',timeout});
  if (result.error) { console.error(result.error.code === 'ETIMEDOUT' ? 'Authorization expired after 15 minutes. Run npm run deploy to start again.' : 'Install GitHub CLI first: https://cli.github.com/'); process.exit(1); }
  return result.status === 0;
}
if (!run(['auth','status'])) {
  console.log('Open the URL printed by GitHub CLI and enter its newly generated code. Never paste tokens into chat. Waiting at most 15 minutes. Provider codes may expire sooner.');
  if (!run(['auth','login','--hostname','github.com','--git-protocol','https','--web'],15*60*1000)) process.exit(1);
}
if (!run(['workflow','run','deploy-pages.yml','--repo','Mahicouragw/Voice-cut-video-editor-for-blinnds','--ref','main'])) {
  console.error('Not deployed. First merge these files into main, enable Pages: GitHub Actions, and verify repository write permission. Pending approval is not success.');
  process.exit(1);
}
console.log('Deployment REQUESTED, not yet complete. Check: https://github.com/Mahicouragw/Voice-cut-video-editor-for-blinnds/actions');

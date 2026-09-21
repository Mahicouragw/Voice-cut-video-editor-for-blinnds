const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname,'../flutter_app/assets/web');
fs.rmSync(target,{recursive:true,force:true}); fs.mkdirSync(target,{recursive:true});
fs.copyFileSync(path.resolve(__dirname,'../index.html'),path.join(target,'index.html'));
fs.cpSync(path.resolve(__dirname,'../web'),path.join(target,'web'),{recursive:true});

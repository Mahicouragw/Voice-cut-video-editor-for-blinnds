const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, {recursive:true, force:true});
fs.mkdirSync(output, {recursive:true});
fs.copyFileSync(path.join(root, 'index.html'), path.join(output, 'index.html'));
fs.cpSync(path.join(root, 'web'), path.join(output, 'web'), {recursive:true});
console.log('Built dist/: public web assets only. No server files or secrets.');

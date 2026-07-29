// Run from Desktop/sweepfi-server:  node ntfy-title-fix.js
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
const before = "'Title': 'Good morning \u2014 ' + money(data.safe) + ' safe to invest',";
const after  = "'Title': 'Good morning: ' + money(data.safe) + ' safe to invest',";
if (!code.includes(before)) {
  console.log(code.includes(after) ? 'Already fixed.' : 'ERROR: line not found');
  process.exit(code.includes(after) ? 0 : 1);
}
code = code.split(before).join(after);
fs.writeFileSync('server.js', code);
console.log('Done! Em dash removed from notification title.');

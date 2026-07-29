// Run from Desktop/sweepfi-server:  node node22-fix.js
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.engines = { node: "22.x" };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('Done! Node 22 pinned.');

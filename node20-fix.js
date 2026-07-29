// Run from Desktop/sweepfi-server:  node node20-fix.js
const fs = require('fs');

// 1. Force Node 20 on Railway
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.engines = { node: "20.x" };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('package.json: Node 20 pinned');

// 2. Log the underlying cause of any ntfy failure
let code = fs.readFileSync('server.js', 'utf8');
const before = "} catch (e) { console.log('[brief] ntfy error:', e.message); }";
const after  = "} catch (e) { console.log('[brief] ntfy error:', e.message, '| cause:', e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : 'none'); }";
if (code.includes(before)) {
  code = code.split(before).join(after);
  fs.writeFileSync('server.js', code);
  console.log('server.js: deeper error logging added');
} else {
  console.log('server.js: logging line not found (may already be updated)');
}
console.log('Done!');

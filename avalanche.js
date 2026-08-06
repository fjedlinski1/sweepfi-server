// Run from Desktop/sweepfi-server:  node avalanche.js
// Persist the avalanche "extra $/mo" in user_settings
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes("'debt_extra'")) { console.log('Already patched.'); process.exit(0); }
const oldList = `['min_buffer', 'birth_year', 'retire_age', 'monthly_invest', 'roth_ytd', 'k401_ytd']`;
if (!code.includes(oldList)) { console.log('ERROR: settings whitelist not found — run plan-todos.js first'); process.exit(1); }
code = SPLITJOIN(code, oldList, `['min_buffer', 'birth_year', 'retire_age', 'monthly_invest', 'roth_ytd', 'k401_ytd', 'debt_extra']`);
fs.writeFileSync('server.js', code);
console.log('Done! debt_extra persisted (AVALANCHE).');

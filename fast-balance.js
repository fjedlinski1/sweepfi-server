// Run from Desktop/sweepfi-server:  node fast-balance.js
// Live bank balances: accountsGet (cached) -> accountsBalanceGet (real-time)
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('accountsBalanceGet')) { console.log('Already patched.'); process.exit(0); }
const n = code.split('plaid.accountsGet(').length - 1;
if (!n) { console.log('ERROR: no plaid.accountsGet calls found — paste your balance-fetch line to Claude.'); process.exit(1); }
code = code.split('plaid.accountsGet(').join('plaid.accountsBalanceGet(');
fs.writeFileSync('server.js', code);
console.log(`Done! ${n} balance call(s) now real-time (accountsBalanceGet).`);

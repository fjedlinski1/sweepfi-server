// Run from Desktop/sweepfi-server:  node bills-classify.js
// Transfers, brokerage deposits, P2P sends, and bank fees are NOT bills.
// Applies to both /expenses detection and the sweep engine's reservation.
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('BILL-CLASSIFY')) { console.log('Already patched.'); process.exit(0); }

const oldStart = `    Object.entries(byName).forEach(([name, txs]) => {
      if (txs.length < 2) return;`;
const newStart = `    Object.entries(byName).forEach(([name, txs]) => {
      if (txs.length < 2) return;
      // BILL-CLASSIFY: transfers, brokerage deposits, P2P, and bank fees are not bills
      const sampleTx = txs[txs.length - 1];
      const pfc = (sampleTx.personal_finance_category?.primary || sampleTx.category?.[0] || '').toString().toUpperCase().replace(/ /g, '_');
      if (pfc.includes('TRANSFER') || pfc.includes('BANK_FEES')) return;
      if (/plus ?500|coinbase|robinhood|webull|alpaca|etrade|e\\*trade|fidelity|schwab|tradovate|topstepx|zelle|venmo|cash ?app|paypal|apple cash|overdraft|nsf fee|insufficient|wire (out|transfer)|brokerage|crossmint/i.test(name)) return;`;

const count = code.split(oldStart).length - 1;
if (count === 0) { console.log('ERROR: detection block not found'); process.exit(1); }
code = SPLITJOIN(code, oldStart, newStart);
fs.writeFileSync('server.js', code);
console.log('Done! Patched ' + count + ' detection block(s) (expenses + sweep engine).');

// Run from Desktop/sweepfi-server:  node expenses-60d.js
// /expenses: detect recurring bills over 60 days (catches monthly payments seen once in 30d)
// while keeping spent totals / categories / top merchants honest to the last 30 days.
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('SIXTY-DAY-BILLS')) { console.log('Already patched.'); process.exit(0); }

const segStart = code.indexOf("app.post('/expenses'");
if (segStart === -1) { console.log('ERROR: /expenses not found'); process.exit(1); }
let segEnd = code.indexOf('// ── DAILY-BRIEF', segStart);
if (segEnd === -1) segEnd = code.indexOf('app.listen(', segStart);
let seg = code.slice(segStart, segEnd);

const edits = [
  ["const startDate = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];",
   "const startDate = new Date(Date.now() - 60 * 864e5).toISOString().split('T')[0]; // SIXTY-DAY-BILLS"],
  ["options: { count: 250 },",
   "options: { count: 500 },"],
  ["const outflows = transactions.filter(tx => tx.amount > 0);",
   `const outflows = transactions.filter(tx => tx.amount > 0);
    const cutoff30 = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    const outflows30 = outflows.filter(tx => tx.date >= cutoff30);`],
  ["const totalMonthly = Math.round(outflows.reduce((s, t) => s + t.amount, 0) * 100) / 100;",
   "const totalMonthly = Math.round(outflows30.reduce((s, t) => s + t.amount, 0) * 100) / 100;"],
];

for (const [a, b] of edits) {
  if (!seg.includes(a)) { console.log('ERROR: not found:', a.slice(0, 60)); process.exit(1); }
  seg = SPLITJOIN(seg, a, b);
}

// Categories: 30-day view (the forEach that builds catTotals)
const catOld = `    outflows.forEach(tx => {
      const cat = (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other')`;
const catNew = `    outflows30.forEach(tx => {
      const cat = (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other')`;
if (!seg.includes(catOld)) { console.log('ERROR: category block not found'); process.exit(1); }
seg = SPLITJOIN(seg, catOld, catNew);

// Top merchants: totals from the 30-day slice of each merchant's transactions
const tmOld = `      .map(([name, txs]) => ({
        name,
        total: Math.round(txs.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        count: txs.length,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);`;
const tmNew = `      .map(([name, txs]) => {
        const t30 = txs.filter(t => t.date >= cutoff30);
        return {
          name,
          total: Math.round(t30.reduce((s, t) => s + t.amount, 0) * 100) / 100,
          count: t30.length,
        };
      })
      .filter(m => m.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);`;
if (!seg.includes(tmOld)) { console.log('ERROR: top merchants block not found'); process.exit(1); }
seg = SPLITJOIN(seg, tmOld, tmNew);

code = code.slice(0, segStart) + seg + code.slice(segEnd);
fs.writeFileSync('server.js', code);
console.log('Done! Bills detected over 60 days; totals stay 30-day honest.');

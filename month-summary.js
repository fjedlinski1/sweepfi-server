// Run from Desktop/sweepfi-server:  node month-summary.js
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('MONTH-SUMMARY')) { console.log('Already patched.'); process.exit(0); }

const oldToday = `    const today = new Date();
    bills.forEach(b => {
      if (!b.due_day) { b.next_due = null; return; }`;
const newToday = `    const today = new Date(); // MONTH-SUMMARY
    const monthStartStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01';
    bills.forEach(b => {
      b.paid_this_month = !!(b.last_date && b.last_date >= monthStartStr);
      if (!b.due_day) { b.next_due = null; return; }`;
if (!code.includes(oldToday)) { console.log('ERROR: due-date block not found'); process.exit(1); }
code = SPLITJOIN(code, oldToday, newToday);
fs.writeFileSync('server.js', code);
console.log('Done! Bills now carry paid_this_month.');

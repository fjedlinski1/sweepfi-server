// Run from Desktop/sweepfi-server:  node bill-rename.js
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('BILL-RENAME')) { console.log('Already patched.'); process.exit(0); }

// override endpoint accepts display_name
const oldHidden = `    if (req.body.hidden != null) row.hidden = req.body.hidden === true;`;
const newHidden = `    if (req.body.hidden != null) row.hidden = req.body.hidden === true;
    if (req.body.display_name != null) row.display_name = String(req.body.display_name).trim(); // BILL-RENAME`;
if (!code.includes(oldHidden)) { console.log('ERROR: override hidden line not found'); process.exit(1); }
code = SPLITJOIN(code, oldHidden, newHidden);

// expenses: pull + merge display_name
code = SPLITJOIN(code, `.select('name, amount, due_day, hidden')`, `.select('name, amount, due_day, hidden, display_name')`);
const oldMerge = `            if (o.hidden) b.hidden = true;`;
const newMerge = `            if (o.hidden) b.hidden = true;
            if (o.display_name) b.display_name = o.display_name;`;
if (!code.includes(oldMerge)) { console.log('ERROR: merge block not found'); process.exit(1); }
code = SPLITJOIN(code, oldMerge, newMerge);

// morning push uses the pretty name
code = SPLITJOIN(code,
  `dueLine = 'Due soon: ' + due.map(b => b.name + ' ' + money(b.monthly) + ' (' + b.days_until + 'd)').join(', ');`,
  `dueLine = 'Due soon: ' + due.map(b => (b.display_name || b.name) + ' ' + money(b.monthly) + ' (' + b.days_until + 'd)').join(', ');`);

fs.writeFileSync('server.js', code);
console.log('Done! Bills can be renamed (BILL-RENAME).');

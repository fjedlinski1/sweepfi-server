// Run from Desktop/sweepfi-server:  node hide-bills.js
// Bills can be removed (hidden): excluded from bills list, totals, and sweep reservation
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');

if (code.includes('HIDE-BILLS')) { console.log('Already patched.'); process.exit(0); }

// 1. Override endpoint: only update fields actually sent (and accept hidden)
const oldRow = `    const row = {
      user_id: req.body.user_id,
      name: req.body.name.toLowerCase(),
      amount: req.body.amount != null ? Number(req.body.amount) : null,
      due_day: req.body.due_day != null ? Math.min(31, Math.max(1, Number(req.body.due_day))) : null,
      created_at: new Date().toISOString(),
    };`;
const newRow = `    // HIDE-BILLS: partial updates — only touch fields provided
    const row = {
      user_id: req.body.user_id,
      name: req.body.name.toLowerCase(),
    };
    if (req.body.amount != null) row.amount = Number(req.body.amount);
    if (req.body.due_day != null) row.due_day = Math.min(31, Math.max(1, Number(req.body.due_day)));
    if (req.body.hidden != null) row.hidden = req.body.hidden === true;`;
if (!code.includes(oldRow)) { console.log('ERROR: override row block not found'); process.exit(1); }
code = SPLITJOIN(code, oldRow, newRow);

// 2. /expenses: pull hidden flag, filter hidden bills out of list + totals
code = SPLITJOIN(code,
  `.select('name, amount, due_day')`,
  `.select('name, amount, due_day, hidden')`);
const oldMergeIf = `          if (o) {
            if (o.amount != null) { b.monthly = Number(o.amount); b.overridden = true; }
            if (o.due_day != null) { b.due_day = Number(o.due_day); b.overridden = true; }
            b.ready_to_pay = cash - 200 >= b.monthly;
          }`;
const newMergeIf = `          if (o) {
            if (o.amount != null) { b.monthly = Number(o.amount); b.overridden = true; }
            if (o.due_day != null) { b.due_day = Number(o.due_day); b.overridden = true; }
            if (o.hidden) b.hidden = true;
            b.ready_to_pay = cash - 200 >= b.monthly;
          }`;
if (!code.includes(oldMergeIf)) { console.log('ERROR: merge block not found'); process.exit(1); }
code = SPLITJOIN(code, oldMergeIf, newMergeIf);

code = SPLITJOIN(code,
  `const totalBills = Math.round(bills.reduce((s, b) => s + b.monthly, 0) * 100) / 100;`,
  `const totalBills = Math.round(bills.filter(b => !b.hidden).reduce((s, b) => s + b.monthly, 0) * 100) / 100;`);
code = SPLITJOIN(code,
  `res.json({ total_monthly: totalMonthly, total_bills: totalBills, cash: Math.round(cash*100)/100, bills, categories, debts, top_merchants });`,
  `res.json({ total_monthly: totalMonthly, total_bills: totalBills, cash: Math.round(cash*100)/100, bills: bills.filter(b => !b.hidden), categories, debts, top_merchants });`);

// 3. Sweep engine: hidden bills stop reserving money
const sweepAnchor = `    const upcomingBills = recurringBills.reduce((s, b) => s + b.monthly, 0);`;
const sweepNew = `    let visibleBills = recurringBills;
    try {
      const { data: hov } = await supabase
        .from('bill_overrides')
        .select('name, hidden')
        .eq('user_id', req.body.user_id)
        .eq('hidden', true);
      if (hov && hov.length) {
        const hiddenSet = new Set(hov.map(o => o.name));
        visibleBills = recurringBills.filter(b => !hiddenSet.has(b.name));
      }
    } catch (e) {}
    const upcomingBills = visibleBills.reduce((s, b) => s + b.monthly, 0);`;
if (!code.includes(sweepAnchor)) { console.log('ERROR: sweep upcomingBills not found'); process.exit(1); }
code = SPLITJOIN(code, sweepAnchor, sweepNew);
code = SPLITJOIN(code,
  `recurring_bills: recurringBills.sort((a, b) => b.monthly - a.monthly),`,
  `recurring_bills: visibleBills.sort((a, b) => b.monthly - a.monthly),`);

fs.writeFileSync('server.js', code);
console.log('Done! Bills can now be removed (HIDE-BILLS applied).');

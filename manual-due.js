// Run from Desktop/sweepfi-server:  node manual-due.js
// Manual accounts gain payment + due_day -> become bills in calendar & reservation
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('MANUAL-DUE')) { console.log('Already patched.'); process.exit(0); }

// 1. Read the new columns
const oldSel = `.select('name, type, balance, apr')`;
if (!code.includes(oldSel)) { console.log('ERROR: manual select not found'); process.exit(1); }
code = SPLITJOIN(code, oldSel, `.select('name, type, balance, apr, due_day, payment')`);

// 2. Save endpoint accepts them
const oldApr = `      apr: req.body.apr != null && req.body.apr !== '' ? Number(req.body.apr) : null,`;
const newApr = `      apr: req.body.apr != null && req.body.apr !== '' ? Number(req.body.apr) : null,
      due_day: req.body.due_day != null && req.body.due_day !== '' ? Math.min(31, Math.max(1, Number(req.body.due_day))) : null,
      payment: req.body.payment != null && req.body.payment !== '' ? Number(req.body.payment) : null,`;
if (!code.includes(oldApr)) { console.log('ERROR: save apr line not found'); process.exit(1); }
code = SPLITJOIN(code, oldApr, newApr);

// 3. /expenses: manual accounts with payment+due_day become bills (deduped vs detection)
const exAnchor = `    // BILL-OVERRIDES: user-set amount/due day win over detection`;
const exNew = `    // MANUAL-DUE: manual accounts with a payment + due day become bills
    try {
      const manB = await getManualAccounts(req.body.user_id);
      manB.filter(m => (m.type === 'credit' || m.type === 'loan') && m.payment && m.due_day).forEach(m => {
        const key = m.name.toLowerCase().split(' ')[0];
        if (key.length >= 4 && bills.some(b => b.name.includes(key))) return;
        const paidTx = outflows30.filter(t => (t.merchant_name || t.name || '').toLowerCase().includes(key)).map(t => t.date).sort().pop();
        bills.push({
          name: m.name.toLowerCase(),
          monthly: Math.round(Number(m.payment) * 100) / 100,
          last_date: paidTx || null,
          due_day: Number(m.due_day),
          manual_bill: true,
          ready_to_pay: cash - 200 >= Number(m.payment),
        });
      });
    } catch (e) {}

    // BILL-OVERRIDES: user-set amount/due day win over detection`;
if (!code.includes(exAnchor)) { console.log('ERROR: overrides anchor not found'); process.exit(1); }
code = SPLITJOIN(code, exAnchor, exNew);

// 4. Sweep engine reserves manual payments too
const swAnchor = `    const upcomingBills = visibleBills.reduce((s, b) => s + b.monthly, 0);`;
const swNew = `    try {
      const manB = await getManualAccounts(req.body.user_id);
      manB.filter(m => (m.type === 'credit' || m.type === 'loan') && m.payment && m.due_day).forEach(m => {
        const key = m.name.toLowerCase().split(' ')[0];
        if (key.length >= 4 && visibleBills.some(b => b.name.includes(key))) return;
        visibleBills = visibleBills.concat([{ name: m.name.toLowerCase(), monthly: Number(m.payment) }]);
      });
    } catch (e) {}
    const upcomingBills = visibleBills.reduce((s, b) => s + b.monthly, 0);`;
if (!code.includes(swAnchor)) { console.log('ERROR: sweep anchor not found'); process.exit(1); }
code = SPLITJOIN(code, swAnchor, swNew);

fs.writeFileSync('server.js', code);
console.log('Done! Manual accounts carry payment dates (MANUAL-DUE).');

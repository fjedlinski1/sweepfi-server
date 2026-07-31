// Run from Desktop/sweepfi-server:  node fix-bills-final.js
// Normalizes line endings, then applies bill-overrides + 60-day detection.
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

// CRLF -> LF so multi-line matches work
const hadCRLF = code.includes('\r\n');
code = code.replace(/\r\n/g, '\n');
if (hadCRLF) console.log('Normalized Windows line endings.');

let applied = [];

// ── Part 1: bill due days + overrides ──
if (code.includes('BILL-OVERRIDES')) {
  console.log('Bill overrides: already applied.');
} else {
  const oldPush = `        bills.push({
          name,
          monthly: Math.round(avg * 100) / 100,
          last_date: txs.map(t => t.date).sort().pop(),
          ready_to_pay: cash - 200 >= avg, // cash covers it beyond min buffer
        });`;
  const newPush = `        const days = txs.map(t => Number(t.date.split('-')[2])).sort((a, b) => a - b);
        const dueDay = days[Math.floor(days.length / 2)];
        bills.push({
          name,
          monthly: Math.round(avg * 100) / 100,
          last_date: txs.map(t => t.date).sort().pop(),
          due_day: dueDay,
          ready_to_pay: cash - 200 >= avg,
        });`;
  if (!code.includes(oldPush)) { console.log('ERROR: bill push block STILL not found'); process.exit(1); }
  code = SPLITJOIN(code, oldPush, newPush);

  const oldSort = `    bills.sort((a, b) => b.monthly - a.monthly);`;
  const newSort = `    // BILL-OVERRIDES: user-set amount/due day win over detection
    try {
      const { data: ov } = await supabase
        .from('bill_overrides')
        .select('name, amount, due_day')
        .eq('user_id', req.body.user_id);
      if (ov && ov.length) {
        const byOv = Object.fromEntries(ov.map(o => [o.name, o]));
        bills.forEach(b => {
          const o = byOv[b.name];
          if (o) {
            if (o.amount != null) { b.monthly = Number(o.amount); b.overridden = true; }
            if (o.due_day != null) { b.due_day = Number(o.due_day); b.overridden = true; }
            b.ready_to_pay = cash - 200 >= b.monthly;
          }
        });
      }
    } catch (e) { console.log('[expenses] overrides skip:', e.message); }

    const today = new Date();
    bills.forEach(b => {
      if (!b.due_day) { b.next_due = null; return; }
      let y = today.getFullYear(), m = today.getMonth();
      if (today.getDate() > b.due_day) { m += 1; if (m > 11) { m = 0; y += 1; } }
      const lastDay = new Date(y, m + 1, 0).getDate();
      const d = new Date(y, m, Math.min(b.due_day, lastDay));
      b.next_due = d.toISOString().split('T')[0];
      b.days_until = Math.round((d - today) / 864e5);
    });
    bills.sort((a, b) => (a.days_until ?? 99) - (b.days_until ?? 99));`;
  if (!code.includes(oldSort)) { console.log('ERROR: bill sort line not found'); process.exit(1); }
  code = SPLITJOIN(code, oldSort, newSort);

  const endpointBlock = `
// ── BILL-OVERRIDES endpoint ──────────────────────────────────────────────
app.post('/bills/override', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.name) return res.status(400).json({ error: 'user_id and name required' });
    const row = {
      user_id: req.body.user_id,
      name: req.body.name.toLowerCase(),
      amount: req.body.amount != null ? Number(req.body.amount) : null,
      due_day: req.body.due_day != null ? Math.min(31, Math.max(1, Number(req.body.due_day))) : null,
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('bill_overrides').upsert(row, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[bills] override saved:', row.name, row.amount, 'day', row.due_day);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
  code = code.replace(/app\.listen\(/, () => endpointBlock + 'app.listen(');
  applied.push('bill-overrides');
}

// ── Part 2: 60-day detection, 30-day totals ──
if (code.includes('SIXTY-DAY-BILLS')) {
  console.log('60-day bills: already applied.');
} else {
  const segStart = code.indexOf("app.post('/expenses'");
  if (segStart === -1) { console.log('ERROR: /expenses not found'); process.exit(1); }
  let segEnd = code.indexOf('// ── DAILY-BRIEF', segStart);
  if (segEnd === -1) segEnd = code.indexOf('app.listen(', segStart);
  let seg = code.slice(segStart, segEnd);

  const edits = [
    ["const startDate = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];",
     "const startDate = new Date(Date.now() - 60 * 864e5).toISOString().split('T')[0]; // SIXTY-DAY-BILLS"],
    ["options: { count: 250 },", "options: { count: 500 },"],
    ["const outflows = transactions.filter(tx => tx.amount > 0);",
     `const outflows = transactions.filter(tx => tx.amount > 0);
    const cutoff30 = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    const outflows30 = outflows.filter(tx => tx.date >= cutoff30);`],
    ["const totalMonthly = Math.round(outflows.reduce((s, t) => s + t.amount, 0) * 100) / 100;",
     "const totalMonthly = Math.round(outflows30.reduce((s, t) => s + t.amount, 0) * 100) / 100;"],
    [`    outflows.forEach(tx => {
      const cat = (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other')`,
     `    outflows30.forEach(tx => {
      const cat = (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other')`],
    [`      .map(([name, txs]) => ({
        name,
        total: Math.round(txs.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        count: txs.length,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);`,
     `      .map(([name, txs]) => {
        const t30 = txs.filter(t => t.date >= cutoff30);
        return {
          name,
          total: Math.round(t30.reduce((s, t) => s + t.amount, 0) * 100) / 100,
          count: t30.length,
        };
      })
      .filter(m => m.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);`],
  ];
  for (const [a, b] of edits) {
    if (!seg.includes(a)) { console.log('ERROR in 60d patch, not found:', a.slice(0, 50)); process.exit(1); }
    seg = SPLITJOIN(seg, a, b);
  }
  code = code.slice(0, segStart) + seg + code.slice(segEnd);
  applied.push('60-day-bills');
}

fs.writeFileSync('server.js', code);
const count = (code.match(/BILL-OVERRIDES|SIXTY-DAY-BILLS|DUE-SOON-PUSH/g) || []).length;
console.log('Applied now:', applied.join(', ') || 'nothing new');
console.log('Marker check (need >= 3):', count);
console.log(count >= 3 ? 'ALL GOOD — deploy it!' : 'STILL MISSING SOMETHING — tell Claude');

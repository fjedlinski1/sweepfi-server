// Run from Desktop/sweepfi-server:  node add-bill-overrides.js
// Bills get due dates (estimated from history) + user overrides for amount/due day
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('BILL-OVERRIDES')) { console.log('Already patched.'); process.exit(0); }

// 1. Bills carry a detected due day (median day-of-month of occurrences)
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
if (!code.includes(oldPush)) { console.log('ERROR: bill push block not found'); process.exit(1); }
code = SPLITJOIN(code, oldPush, newPush);

// 2. Merge user overrides + compute next due date, sort by urgency
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

// 3. Override endpoint
const block = `
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
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Bill due dates + overrides.');

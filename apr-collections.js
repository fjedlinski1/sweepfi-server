// Run from Desktop/sweepfi-server:  node apr-collections.js
// APR on all debts (fillable), collections type with settlements, payoff ordering
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('APR-COLLECTIONS')) { console.log('Already patched.'); process.exit(0); }

// 1. Collections count as debt everywhere manual debt types are filtered
code = SPLITJOIN(code, "(m.type === 'credit' || m.type === 'loan')", "(m.type === 'credit' || m.type === 'loan' || m.type === 'collection')");

// 2. Save endpoint: allow the type + settled amount
code = SPLITJOIN(code, "['credit', 'loan', 'cash', 'investment'].includes(req.body.type)",
                       "['credit', 'loan', 'cash', 'investment', 'collection'].includes(req.body.type)");
const oldPay = `      payment: req.body.payment != null && req.body.payment !== '' ? Number(req.body.payment) : null,`;
const newPay = `      payment: req.body.payment != null && req.body.payment !== '' ? Number(req.body.payment) : null,
      settled: req.body.settled != null && req.body.settled !== '' ? Number(req.body.settled) : null, // APR-COLLECTIONS`;
if (!code.includes(oldPay)) { console.log('ERROR: save payment line not found'); process.exit(1); }
code = SPLITJOIN(code, oldPay, newPay);
code = SPLITJOIN(code, `.select('name, type, balance, apr, due_day, payment')`, `.select('name, type, balance, apr, due_day, payment, settled')`);
code = SPLITJOIN(code, `          payment: m.payment, due_day: m.due_day, apr: m.apr,`,
                       `          payment: m.payment, due_day: m.due_day, apr: m.apr, settled: m.settled,`);

// 3. Manual debts: settlement is the real balance; carry collection flag
const oldMap = `          return {
            name: m.name,
            balance: Math.round(Number(m.balance) * 100) / 100,
            min_payment: pay,
            apr: m.apr,
            manual: true,
            matched_bill: matched ? matched.name : null,
            ready_to_pay: cash - 200 >= (pay || Number(m.balance) * 0.03),
          };`;
const newMap = `          const owed = m.settled != null ? Number(m.settled) : Number(m.balance);
          return {
            name: m.name,
            balance: Math.round(owed * 100) / 100,
            original_balance: Math.round(Number(m.balance) * 100) / 100,
            settled: m.settled != null ? Number(m.settled) : null,
            is_collection: m.type === 'collection',
            min_payment: pay,
            apr: m.apr != null ? Number(m.apr) : null,
            manual: true,
            matched_bill: matched ? matched.name : null,
            ready_to_pay: cash - 200 >= (pay || owed * 0.03),
          };`;
if (!code.includes(oldMap)) { console.log('ERROR: manual debts map not found'); process.exit(1); }
code = SPLITJOIN(code, oldMap, newMap);

// 4. APR settings for Plaid debts + payoff ordering (highest APR first)
const oldDebts = `    const debts = [...plaidDebts, ...manualDebts];`;
const newDebts = `    let debts = [...plaidDebts, ...manualDebts];
    try {
      const { data: ds } = await supabase.from('debt_settings').select('name, apr').eq('user_id', req.body.user_id);
      if (ds && ds.length) {
        const byD = Object.fromEntries(ds.map(o => [o.name.toLowerCase(), o.apr]));
        debts.forEach(d => {
          if (d.apr == null && byD[d.name.toLowerCase()] != null) d.apr = Number(byD[d.name.toLowerCase()]);
        });
      }
    } catch (e) {}
    debts.sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1));`;
if (!code.includes(oldDebts)) { console.log('ERROR: debts merge not found'); process.exit(1); }
code = SPLITJOIN(code, oldDebts, newDebts);

// 5. APR save endpoint
const block = `
// ── APR-COLLECTIONS: set APR on any debt ─────────────────────────────────
app.post('/debts/apr', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.name || req.body.apr == null) {
      return res.status(400).json({ error: 'user_id, name, apr required' });
    }
    const { error } = await supabase.from('debt_settings').upsert({
      user_id: req.body.user_id,
      name: req.body.name.toLowerCase(),
      apr: Number(req.body.apr),
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[debts] apr set:', req.body.name, req.body.apr);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! APR + collections live (APR-COLLECTIONS).');

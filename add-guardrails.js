// Run from Desktop/sweepfi-server:  node add-guardrails.js
// Real guardrails: top merchants in /expenses + guardrail CRUD + monthly spend tracking
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('GUARDRAILS')) { console.log('Already patched.'); process.exit(0); }

// 1. /expenses: include top merchants (non-recurring, ranked)
const oldJson = `res.json({ total_monthly: totalMonthly, total_bills: totalBills, cash: Math.round(cash*100)/100, bills, categories, debts });`;
const newJson = `const recurringSet = new Set(bills.map(b => b.name));
    const top_merchants = Object.entries(byName)
      .filter(([name]) => !recurringSet.has(name))
      .map(([name, txs]) => ({
        name,
        total: Math.round(txs.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        count: txs.length,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    res.json({ total_monthly: totalMonthly, total_bills: totalBills, cash: Math.round(cash*100)/100, bills, categories, debts, top_merchants });`;
if (!code.includes(oldJson)) { console.log('ERROR: /expenses response line not found'); process.exit(1); }
code = SPLITJOIN(code, oldJson, newJson);

// 2. Guardrail endpoints
const block = `
// ── GUARDRAILS ────────────────────────────────────────────────────────────
const railKey = (tx) => (tx.merchant_name || tx.name || 'unknown').toLowerCase().slice(0, 24);
const railCat = (tx) => (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other').replace(/_/g, ' ').toLowerCase();

app.post('/guardrails', async (req, res) => {
  try {
    const { data: rails } = await supabase
      .from('guardrails')
      .select('target, kind, monthly_limit')
      .eq('user_id', req.body.user_id);
    if (!rails || !rails.length) return res.json({ rails: [] });

    const { data: tokens } = await supabase
      .from('plaid_tokens').select('access_token').eq('user_id', req.body.user_id);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];
    let txns = [];
    for (const t of (tokens || [])) {
      try {
        const r = await plaid.transactionsGet({
          access_token: t.access_token,
          start_date: monthStart, end_date: endDate,
          options: { count: 250 },
        });
        txns = txns.concat(r.data.transactions);
      } catch (e) {}
    }
    const outflows = txns.filter(tx => tx.amount > 0);

    const out = rails.map(rail => {
      const target = rail.target.toLowerCase();
      const spent = outflows
        .filter(tx => railKey(tx) === target || railCat(tx) === target)
        .reduce((s, t) => s + t.amount, 0);
      const spentR = Math.round(spent * 100) / 100;
      let status = 'ok';
      if (rail.kind === 'block') status = spentR > 0 ? 'violated' : 'clean';
      else if (rail.monthly_limit) {
        if (spentR > rail.monthly_limit) status = 'over';
        else if (spentR > rail.monthly_limit * 0.8) status = 'near';
      }
      return { ...rail, spent: spentR, status };
    });
    console.log('[guardrails]', out.length, 'rails for', req.body.user_id);
    res.json({ rails: out });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/guardrails/save', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.target || !req.body.kind) {
      return res.status(400).json({ error: 'user_id, target, kind required' });
    }
    const { error } = await supabase.from('guardrails').upsert({
      user_id: req.body.user_id,
      target: req.body.target.toLowerCase(),
      kind: req.body.kind,
      monthly_limit: req.body.kind === 'limit' ? (Number(req.body.monthly_limit) || null) : null,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,target' });
    if (error) throw new Error(error.message);
    console.log('[guardrails] saved', req.body.kind, req.body.target);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/guardrails/remove', async (req, res) => {
  try {
    const { error } = await supabase.from('guardrails')
      .delete()
      .eq('user_id', req.body.user_id)
      .eq('target', (req.body.target || '').toLowerCase());
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Guardrails: top merchants + /guardrails + save + remove.');

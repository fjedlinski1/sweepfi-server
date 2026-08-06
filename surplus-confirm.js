// Run from Desktop/sweepfi-server:  node surplus-confirm.js
// Surplus debt-payment claims + auto-confirmation from bank transactions
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('SURPLUS-CONFIRM')) { console.log('Already patched.'); process.exit(0); }

// 1. Verify pending claims against transactions inside /expenses (outflows30 in scope)
const anchor = `    // MANUAL-DUE: manual accounts with a payment + due day become bills`;
const verify = `    // SURPLUS-CONFIRM: verify claimed extra debt payments against bank transactions
    try {
      const { data: dps } = await supabase.from('debt_payments').select('*')
        .eq('user_id', req.body.user_id).eq('status', 'pending').limit(10);
      for (const p of (dps || [])) {
        const key = p.debt_name.toLowerCase().split(' ')[0];
        const hit = outflows30.find(t => {
          const nm = (t.merchant_name || t.name || '').toLowerCase();
          return t.date >= String(p.created_at).slice(0, 10) && nm.includes(key)
            && Math.abs(Math.abs(t.amount) - Number(p.amount)) <= Number(p.amount) * 0.2;
        });
        if (hit) {
          await supabase.from('debt_payments').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', p.id);
          console.log('[surplus] confirmed', p.debt_name, p.amount, 'via tx:', hit.merchant_name || hit.name);
        }
      }
    } catch (e) {}

    // MANUAL-DUE: manual accounts with a payment + due day become bills`;
if (!code.includes(anchor)) { console.log('ERROR: MANUAL-DUE anchor not found'); process.exit(1); }
code = SPLITJOIN(code, anchor, verify);

// 2. Claim/list/dismiss endpoint
const block = `
// ── SURPLUS-CONFIRM: claimed extra debt payments ─────────────────────────
app.post('/debt-payment', async (req, res) => {
  try {
    if (!req.body.user_id) return res.status(400).json({ error: 'user_id required' });
    if (req.body.action === 'claim' && req.body.debt_name && req.body.amount) {
      await supabase.from('debt_payments').insert({
        user_id: req.body.user_id,
        debt_name: String(req.body.debt_name).slice(0, 60),
        amount: Number(req.body.amount),
        status: 'pending',
      });
      console.log('[surplus] claimed', req.body.debt_name, req.body.amount);
    }
    if (req.body.action === 'dismiss' && req.body.id) {
      await supabase.from('debt_payments').delete().eq('id', req.body.id).eq('user_id', req.body.user_id);
    }
    const { data } = await supabase.from('debt_payments').select('*')
      .eq('user_id', req.body.user_id).order('created_at', { ascending: false }).limit(10);
    res.json({ payments: data || [] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Surplus suggestions + statement confirmation live (SURPLUS-CONFIRM).');

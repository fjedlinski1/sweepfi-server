// Run from Desktop/sweepfi-server:  node add-method-pay.js
// Adds Method payment flow (dev-simulated now, production-ready shape):
//   POST /method/source   — create/reuse an ACH source account for the entity
//   POST /method/pay      — pay a liability account (amount in dollars)
//   POST /method/payments — list payments + statuses
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('METHOD-PAY')) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

const block = `
// ── METHOD-PAY ────────────────────────────────────────────────────────────
async function methodEntityFor(userId) {
  const { data } = await supabase
    .from('method_entities')
    .select('entity_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data ? data.entity_id : null;
}

// Create (or reuse) an ACH source account on the entity — dev uses test coordinates
app.post('/method/source', async (req, res) => {
  console.log('\\n[method/source] user:', req.body.user_id);
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity — run /method-link first' });

    // Reuse an existing ach source if present
    const list = await methodFetch('/accounts?holder_id=' + entityId);
    const existing = (list.data || []).find(a => a.type === 'ach');
    if (existing) {
      console.log('[method/source] reusing', existing.id);
      return res.json({ source_id: existing.id, reused: true });
    }

    const acct = await methodFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        holder_id: entityId,
        ach: {
          routing: req.body.routing || '021000021',
          number:  req.body.number  || '1122334455',
          type: 'checking',
        },
      }),
    });
    const a = acct.data || acct;
    console.log('[method/source] created', a.id, a.status);
    res.json({ source_id: a.id, reused: false, status: a.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pay a liability. amount in DOLLARS here; Method wants cents.
app.post('/method/pay', async (req, res) => {
  console.log('\\n[method/pay] user:', req.body.user_id, 'dest:', req.body.destination, 'amount:', req.body.amount);
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity' });
    const amount = Math.round(Number(req.body.amount) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum $1' });
    if (amount > 2500000) return res.status(400).json({ error: 'Exceeds $25,000 safety cap' });
    if (!req.body.destination) return res.status(400).json({ error: 'destination (liability account id) required' });

    // Ensure a source exists
    const list = await methodFetch('/accounts?holder_id=' + entityId);
    let source = (list.data || []).find(a => a.type === 'ach');
    if (!source) {
      const acct = await methodFetch('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          holder_id: entityId,
          ach: { routing: '021000021', number: '1122334455', type: 'checking' },
        }),
      });
      source = acct.data || acct;
      console.log('[method/pay] created source', source.id);
    }

    const payment = await methodFetch('/payments', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        source: source.id,
        destination: req.body.destination,
        description: 'SweepFi',
      }),
    });
    const p = payment.data || payment;
    console.log('[method/pay] payment', p.id, p.status);
    res.json({ ok: true, payment_id: p.id, status: p.status, amount_dollars: amount / 100, estimated_completion: p.estimated_completion_date || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List payments for the user's entity
app.post('/method/payments', async (req, res) => {
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity' });
    const list = await methodFetch('/payments?holder_id=' + entityId);
    const payments = (list.data || []).map(p => ({
      id: p.id, status: p.status, amount: (p.amount || 0) / 100,
      destination: p.destination, created_at: p.created_at,
    }));
    res.json({ payments });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

`;

code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Method payment endpoints added.');

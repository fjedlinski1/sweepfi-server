// Run from Desktop/sweepfi-server:  node add-history.js
// Real net-worth history: daily snapshot at 8AM ET + /snapshot + /history
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('NET-WORTH-HISTORY')) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

const block = `
// ── NET-WORTH-HISTORY ─────────────────────────────────────────────────────
async function snapshotNetWorth(userId) {
  const { data: tokens } = await supabase
    .from('plaid_tokens')
    .select('access_token')
    .eq('user_id', userId);
  if (!tokens || !tokens.length) throw new Error('No linked accounts');

  let assets = 0, debt = 0;
  for (const t of tokens) {
    try {
      const r = await plaid.accountsGet({ access_token: t.access_token });
      for (const a of r.data.accounts) {
        const bal = a.balances.current ?? a.balances.available ?? 0;
        if (a.type === 'credit') debt += bal;
        else assets += bal;
      }
    } catch (e) { console.log('[snapshot] token skip:', e.response?.data?.error_code || e.message); }
  }
  const row = {
    user_id: userId,
    date: new Date().toISOString().split('T')[0],
    net_worth: Math.round((assets - debt) * 100) / 100,
    assets: Math.round(assets * 100) / 100,
    debt: Math.round(debt * 100) / 100,
  };
  const { error } = await supabase.from('net_worth_history').upsert(row, { onConflict: 'user_id,date' });
  if (error) throw new Error(error.message);
  console.log('[snapshot]', row.date, 'net:', row.net_worth);
  return row;
}

// Manual trigger (browser-friendly)
app.get('/snapshot', async (req, res) => {
  try {
    const row = await snapshotNetWorth(req.query.user_id);
    res.json(row);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// History for charts
app.post('/history', async (req, res) => {
  try {
    const days = Math.min(365, Number(req.body.days) || 90);
    const since = new Date(Date.now() - days * 864e5).toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('net_worth_history')
      .select('date, net_worth, assets, debt')
      .eq('user_id', req.body.user_id)
      .gte('date', since)
      .order('date', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ points: data || [] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;

code = code.replace(/app\.listen\(/, () => block + 'app.listen(');

// Snapshot daily alongside the 8AM brief
const oldSched = `    if (et.hour === '08' && lastBriefDate !== today) {
      lastBriefDate = today;
      sendBrief('scheduled').catch(e => console.log('[brief] error:', e.message));
    }`;
const newSched = `    if (et.hour === '08' && lastBriefDate !== today) {
      lastBriefDate = today;
      if (NOTIFY_USER_ID) snapshotNetWorth(NOTIFY_USER_ID).catch(e => console.log('[snapshot] error:', e.message));
      sendBrief('scheduled').catch(e => console.log('[brief] error:', e.message));
    }`;
if (!code.includes(oldSched)) {
  console.log('WARNING: scheduler block not found — snapshot endpoints added, daily automation NOT wired.');
} else {
  code = SPLITJOIN(code, oldSched, newSched);
}

fs.writeFileSync('server.js', code);
console.log('Done! Net-worth history: daily snapshot + /snapshot + /history.');

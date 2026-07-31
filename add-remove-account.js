// Run from Desktop/sweepfi-server:  node add-remove-account.js
// Disconnect a Plaid institution: revokes access at Plaid + deletes stored tokens
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('REMOVE-INSTITUTION')) { console.log('Already patched.'); process.exit(0); }

const block = `
// ── REMOVE-INSTITUTION ────────────────────────────────────────────────────
app.post('/remove-institution', async (req, res) => {
  console.log('\\n[remove-institution]', req.body.institution, 'for', req.body.user_id);
  try {
    if (!req.body.user_id || !req.body.institution) {
      return res.status(400).json({ error: 'user_id and institution required' });
    }
    const { data: rows } = await supabase
      .from('plaid_tokens')
      .select('access_token, item_id')
      .eq('user_id', req.body.user_id)
      .eq('institution', req.body.institution);
    if (!rows || !rows.length) return res.status(400).json({ error: 'No connection found for ' + req.body.institution });

    let revoked = 0;
    for (const r of rows) {
      try {
        await plaid.itemRemove({ access_token: r.access_token });
        revoked++;
      } catch (e) {
        console.log('[remove-institution] plaid revoke failed (continuing):', e.response?.data?.error_code || e.message);
      }
    }
    const { error } = await supabase
      .from('plaid_tokens')
      .delete()
      .eq('user_id', req.body.user_id)
      .eq('institution', req.body.institution);
    if (error) throw new Error(error.message);
    console.log('[remove-institution] removed', rows.length, 'connection(s), revoked', revoked);
    res.json({ ok: true, removed: rows.length, revoked });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! /remove-institution added.');

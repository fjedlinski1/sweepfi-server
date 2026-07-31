// Run from Desktop/sweepfi-server:  node add-manual-accounts.js
// Manual accounts for non-Plaid institutions: merged into accounts, debts,
// sweep engine, and net-worth snapshots; payments auto-matched from bills.
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('MANUAL-ACCOUNTS')) { console.log('Already patched.'); process.exit(0); }

// 1. CRUD endpoints
const block = `
// ── MANUAL-ACCOUNTS ───────────────────────────────────────────────────────
async function getManualAccounts(userId) {
  const { data } = await supabase
    .from('manual_accounts')
    .select('name, type, balance, apr')
    .eq('user_id', userId);
  return data || [];
}

app.post('/manual-accounts/save', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.name || req.body.balance == null) {
      return res.status(400).json({ error: 'user_id, name, balance required' });
    }
    const { error } = await supabase.from('manual_accounts').upsert({
      user_id: req.body.user_id,
      name: req.body.name.trim(),
      type: ['credit', 'loan', 'cash', 'investment'].includes(req.body.type) ? req.body.type : 'credit',
      balance: Number(req.body.balance),
      apr: req.body.apr != null && req.body.apr !== '' ? Number(req.body.apr) : null,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[manual] saved', req.body.name, req.body.balance);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/manual-accounts/remove', async (req, res) => {
  try {
    const { error } = await supabase.from('manual_accounts')
      .delete()
      .eq('user_id', req.body.user_id)
      .eq('name', req.body.name);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');

// 2. /get-accounts: merge manual accounts (debt types render as credit)
const gaOld = `    console.log('[get-accounts] got', allAccounts.length, 'accounts from', tokens.length, 'bank(s)');
    res.json({ accounts: allAccounts });`;
const gaNew = `    if (req.body.user_id) {
      try {
        const man = await getManualAccounts(req.body.user_id);
        man.forEach(m => allAccounts.push({
          account_id: 'manual-' + m.name.toLowerCase().replace(/\\s+/g, '-'),
          name: m.name,
          official_name: m.name,
          type: (m.type === 'credit' || m.type === 'loan') ? 'credit'
              : (m.type === 'cash' ? 'depository' : 'investment'),
          subtype: m.type,
          manual: true,
          balances: { current: Number(m.balance), available: m.type === 'cash' ? Number(m.balance) : null },
          institution: 'Manual',
        }));
      } catch (e) { console.log('[get-accounts] manual skip:', e.message); }
    }
    console.log('[get-accounts] got', allAccounts.length, 'accounts from', tokens.length, 'bank(s)');
    res.json({ accounts: allAccounts });`;
if (!code.includes(gaOld)) { console.log('ERROR: get-accounts block not found'); process.exit(1); }
code = SPLITJOIN(code, gaOld, gaNew);

// 3. /expenses debts: include manual debts with payment auto-matched from bills
const exOld = `    const debts = accounts
      .filter(a => a.type === 'credit' && (a.balances.current || 0) > 0)
      .map(d => ({
        name: d.name,
        balance: Math.round(d.balances.current * 100) / 100,
        min_payment: d.balances.minimum_payment || null,
        ready_to_pay: cash - 200 >= (d.balances.minimum_payment || d.balances.current * 0.03),
      }));`;
const exNew = `    const plaidDebts = accounts
      .filter(a => a.type === 'credit' && (a.balances.current || 0) > 0)
      .map(d => ({
        name: d.name,
        balance: Math.round(d.balances.current * 100) / 100,
        min_payment: d.balances.minimum_payment || null,
        ready_to_pay: cash - 200 >= (d.balances.minimum_payment || d.balances.current * 0.03),
      }));
    let manualDebts = [];
    try {
      const man = await getManualAccounts(req.body.user_id);
      manualDebts = man.filter(m => (m.type === 'credit' || m.type === 'loan') && Number(m.balance) > 0)
        .map(m => {
          const key = m.name.toLowerCase().split(' ')[0];
          const matched = key.length >= 4 ? bills.find(b => b.name.includes(key)) : null;
          const pay = matched ? matched.monthly : null;
          return {
            name: m.name,
            balance: Math.round(Number(m.balance) * 100) / 100,
            min_payment: pay,
            apr: m.apr,
            manual: true,
            matched_bill: matched ? matched.name : null,
            ready_to_pay: cash - 200 >= (pay || Number(m.balance) * 0.03),
          };
        });
    } catch (e) {}
    const debts = [...plaidDebts, ...manualDebts];`;
if (!code.includes(exOld)) { console.log('ERROR: expenses debts block not found'); process.exit(1); }
code = SPLITJOIN(code, exOld, exNew);

// 4. Sweep engine: manual debts join the paydown queue
const swOld = `    const debts = accounts.filter(a => a.type === 'credit' && (a.balances.current || 0) > 0);`;
const swNew = `    let debts = accounts.filter(a => a.type === 'credit' && (a.balances.current || 0) > 0);
    try {
      const man = await getManualAccounts(req.body.user_id);
      man.filter(m => (m.type === 'credit' || m.type === 'loan') && Number(m.balance) > 0)
        .forEach(m => debts.push({ name: m.name, balances: { current: Number(m.balance) } }));
    } catch (e) {}`;
if (!code.includes(swOld)) { console.log('ERROR: sweep debts line not found'); process.exit(1); }
code = SPLITJOIN(code, swOld, swNew);

// 5. Daily snapshot: manual balances count in net worth
const snOld = `  const row = {
    user_id: userId,
    date: new Date()`;
const snNew = `  try {
    const man = await getManualAccounts(userId);
    man.forEach(m => {
      const bal = Number(m.balance) || 0;
      if (m.type === 'credit' || m.type === 'loan') debt += bal; else assets += bal;
    });
  } catch (e) {}
  const row = {
    user_id: userId,
    date: new Date()`;
if (!code.includes(snOld)) { console.log('WARNING: snapshot block not found — snapshots skip manual accounts'); }
else code = SPLITJOIN(code, snOld, snNew);

fs.writeFileSync('server.js', code);
console.log('Done! Manual accounts merged everywhere (MANUAL-ACCOUNTS).');

// Run from Desktop/sweepfi-server:  node import-dedupe.js
// Import merges with existing manual accounts instead of duplicating
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('IMPORT-DEDUPE')) { console.log('Already patched.'); process.exit(0); }

const oldBlock = `    const rows = req.body.accounts.slice(0, 40).map(a => ({
      user_id: req.body.user_id,
      name: String(a.name).slice(0, 60).trim(),
      type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
      balance: Number(a.balance) || 0,
      payment: a.payment != null && a.payment !== '' ? Number(a.payment) : null,
    })).filter(r => r.name && r.balance > 0);
    const { error } = await supabase.from('manual_accounts').upsert(rows, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[import-report] imported', rows.length, 'accounts');
    res.json({ ok: true, imported: rows.length });`;
const newBlock = `    const rows = req.body.accounts.slice(0, 40).map(a => ({ // IMPORT-DEDUPE
      user_id: req.body.user_id,
      name: String(a.name).slice(0, 60).trim(),
      type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
      balance: Number(a.balance) || 0,
      payment: a.payment != null && a.payment !== '' ? Number(a.payment) : null,
    })).filter(r => r.name && r.balance > 0);
    const { data: existing } = await supabase.from('manual_accounts').select('name').eq('user_id', req.body.user_id);
    const exNames = (existing || []).map(e => e.name);
    const keyOf = (n) => String(n).toLowerCase().split(/[\\s\\/]+/)[0];
    let imported = 0, updated = 0;
    const errs = [];
    for (const r of rows) {
      try {
        const match = exNames.find(n => n.toLowerCase() === r.name.toLowerCase())
          || exNames.find(n => keyOf(n).length >= 4 && keyOf(n) === keyOf(r.name));
        if (match) {
          const { error } = await supabase.from('manual_accounts')
            .update({ balance: r.balance, payment: r.payment })
            .eq('user_id', req.body.user_id).eq('name', match);
          if (error) throw new Error(error.message);
          updated++;
        } else {
          const { error } = await supabase.from('manual_accounts').insert(r);
          if (error) throw new Error(error.message);
          exNames.push(r.name);
          imported++;
        }
      } catch (e) { errs.push(r.name + ': ' + e.message); }
    }
    console.log('[import-report] imported', imported, 'updated', updated, errs.length ? 'errors: ' + errs.join(' | ') : '');
    if (!imported && !updated && errs.length) return res.status(400).json({ error: errs[0] });
    res.json({ ok: true, imported: imported + updated, added: imported, updated });`;
if (!code.includes(oldBlock)) { console.log('ERROR: confirm block not found'); process.exit(1); }
code = SPLITJOIN(code, oldBlock, newBlock);
fs.writeFileSync('server.js', code);
console.log('Done! Import now merges instead of duplicating (IMPORT-DEDUPE).');

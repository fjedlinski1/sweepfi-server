// Run from Desktop/sweepfi-server:  node manual-edit.js
// Manual account editing: rename support + full fields returned for prefill
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('MANUAL-EDIT')) { console.log('Already patched.'); process.exit(0); }

// 1. /get-accounts manual rows carry payment/due_day/apr for the edit form
const oldPush = `          manual: true,
          balances: { current: Number(m.balance), available: m.type === 'cash' ? Number(m.balance) : null },`;
const newPush = `          manual: true, // MANUAL-EDIT
          payment: m.payment, due_day: m.due_day, apr: m.apr,
          balances: { current: Number(m.balance), available: m.type === 'cash' ? Number(m.balance) : null },`;
if (!code.includes(oldPush)) { console.log('ERROR: get-accounts manual push not found'); process.exit(1); }
code = SPLITJOIN(code, oldPush, newPush);

// 2. Save endpoint: renaming deletes the old row after upserting the new
const oldLog = `    console.log('[manual] saved', req.body.name, req.body.balance);`;
const newLog = `    if (req.body.original_name && req.body.original_name !== req.body.name.trim()) {
      await supabase.from('manual_accounts').delete()
        .eq('user_id', req.body.user_id)
        .eq('name', req.body.original_name);
      console.log('[manual] renamed', req.body.original_name, '->', req.body.name.trim());
    }
    console.log('[manual] saved', req.body.name, req.body.balance);`;
if (!code.includes(oldLog)) { console.log('ERROR: save log line not found'); process.exit(1); }
code = SPLITJOIN(code, oldLog, newLog);

fs.writeFileSync('server.js', code);
console.log('Done! Manual accounts editable (MANUAL-EDIT).');

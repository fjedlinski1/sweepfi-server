// Run from Desktop/sweepfi-server:  node snowball.js
// Payoff method choice: avalanche or snowball, per user
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('SNOWBALL')) { console.log('Already patched.'); process.exit(0); }

// 1. /settings/save accepts the string field
const oldRow = `    const row = { user_id: req.body.user_id, updated_at: new Date().toISOString() }; // PLAN-TODOS`;
const newRow = `    const row = { user_id: req.body.user_id, updated_at: new Date().toISOString() }; // PLAN-TODOS SNOWBALL
    if (req.body.debt_method === 'avalanche' || req.body.debt_method === 'snowball') row.debt_method = req.body.debt_method;`;
if (!code.includes(oldRow)) { console.log('ERROR: settings row line not found'); process.exit(1); }
code = SPLITJOIN(code, oldRow, newRow);

// 2. /expenses debt ordering follows the method
const oldSort = `    debts.sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1));`;
const newSort = `    let debtMethod = 'avalanche';
    try {
      const { data: us } = await supabase.from('user_settings').select('debt_method').eq('user_id', req.body.user_id).maybeSingle();
      if (us && us.debt_method === 'snowball') debtMethod = 'snowball';
    } catch (e) {}
    if (debtMethod === 'snowball') debts.sort((a, b) => (Number(a.balance) || 0) - (Number(b.balance) || 0));
    else debts.sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1));`;
if (!code.includes(oldSort)) { console.log('ERROR: debts sort not found'); process.exit(1); }
code = SPLITJOIN(code, oldSort, newSort);

fs.writeFileSync('server.js', code);
console.log('Done! Payoff method choice live (SNOWBALL).');

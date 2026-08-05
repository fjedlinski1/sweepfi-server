// Run from Desktop/sweepfi-server:  node import-report.js
// Credit report import: paste text -> parsed tradelines -> bulk manual accounts
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('IMPORT-REPORT')) { console.log('Already patched.'); process.exit(0); }

const block = `
// ── IMPORT-REPORT: parse a pasted credit report into debts ───────────────
function parseCreditReport(text) {
  const lines = String(text).split('\\n').map(l => l.trim());
  const out = [];
  let cur = null;
  const money = (s) => { const m = s.replace(/[,$]/g, '').match(/-?\\d+(\\.\\d+)?/); return m ? Number(m[0]) : null; };
  const NOISE = /BALANCE|PAYMENT|ACCOUNT|STATUS|DATE|CREDIT|LIMIT|OPENED|REPORTED|HIGH|TERMS|ADDRESS|INQUIR|HISTORY|PERSONAL|SUMMARY|REVOLVING|INSTALLMENT|CLOSED|OPEN|CURRENT|TYPE|RESPONSIB|MONTHS|CONTACT|PHONE|BUREAU|EXPERIAN|EQUIFAX|TRANSUNION/i;
  const push = () => { if (cur && cur.balance != null && cur.balance > 0) out.push(cur); cur = null; };
  for (const line of lines) {
    if (!line) continue;
    const isName = line.length >= 4 && line.length <= 42 && /^[A-Z0-9 &.,\\/'-]+$/.test(line) && /[A-Z]{3}/.test(line) && !NOISE.test(line);
    if (isName) { push(); cur = { name: line.replace(/\\s+/g, ' '), balance: null, payment: null, type: 'credit' }; continue; }
    if (!cur) continue;
    if (/collection|charge[- ]?off|charged off/i.test(line)) cur.type = 'collection';
    else if (/student|auto loan|vehicle|mortgage|installment|personal loan|education/i.test(line) && cur.type !== 'collection') cur.type = 'loan';
    if (cur.balance == null && /balance/i.test(line) && !/high balance|balance date/i.test(line)) {
      const v = money(line); if (v != null && v >= 0 && v < 10000000) cur.balance = v;
    }
    if (cur.payment == null && /(monthly|scheduled|min).{0,14}payment|payment amount/i.test(line)) {
      const v = money(line); if (v && v > 0 && v < 100000) cur.payment = v;
    }
  }
  push();
  const seen = new Set();
  return out.filter(a => { const k = a.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

app.post('/import-report', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.text) return res.status(400).json({ error: 'user_id and text required' });
    const found = parseCreditReport(req.body.text);
    console.log('[import-report] parsed', found.length, 'tradelines');
    res.json({ found });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/import-report-confirm', async (req, res) => {
  try {
    if (!req.body.user_id || !Array.isArray(req.body.accounts) || !req.body.accounts.length) {
      return res.status(400).json({ error: 'user_id and accounts required' });
    }
    const rows = req.body.accounts.slice(0, 40).map(a => ({
      user_id: req.body.user_id,
      name: String(a.name).slice(0, 60).trim(),
      type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
      balance: Number(a.balance) || 0,
      payment: a.payment != null && a.payment !== '' ? Number(a.payment) : null,
    })).filter(r => r.name && r.balance > 0);
    const { error } = await supabase.from('manual_accounts').upsert(rows, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[import-report] imported', rows.length, 'accounts');
    res.json({ ok: true, imported: rows.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Credit report import live (IMPORT-REPORT).');

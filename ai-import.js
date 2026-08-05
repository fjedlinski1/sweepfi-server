// Run from Desktop/sweepfi-server:  node ai-import.js
// AI-powered credit report parsing (Claude API), regex as fallback
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('AI-IMPORT')) { console.log('Already patched.'); process.exit(0); }

const fn = `
// ── AI-IMPORT: LLM parsing for credit reports ────────────────────────────
async function aiParseReport(text) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: 'Extract every debt tradeline from this credit report text (the text may be jumbled from copy-paste — reconstruct carefully). Return ONLY a JSON array, no markdown fences, no prose. Each item: {"name": creditor name as shown, "balance": current balance as a number, "payment": monthly or scheduled payment as a number or null, "type": one of "credit" (credit cards/revolving), "loan" (installment/auto/student/mortgage/personal), "collection" (collections or charge-offs)}. Rules: skip accounts with zero balance, skip closed accounts, skip inquiries, skip non-debt items. Text:\\n\\n' + String(text).slice(0, 150000),
    }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'api error');
  const raw = (d.content || []).map(c => c.text || '').join('').replace(/\`\`\`json|\`\`\`/g, '').trim();
  const arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  return arr.filter(a => a && a.name && Number(a.balance) > 0).slice(0, 40).map(a => ({
    name: String(a.name).slice(0, 60).trim(),
    balance: Number(a.balance),
    payment: a.payment != null && Number(a.payment) > 0 ? Number(a.payment) : null,
    type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
  }));
}

`;
const anchor = `app.post('/import-report', async (req, res) => {`;
if (!code.includes(anchor)) { console.log('ERROR: import-report route not found — run import-report.js first'); process.exit(1); }
code = SPLITJOIN(code, anchor, fn + anchor);

const oldParse = `    const found = parseCreditReport(req.body.text);
    console.log('[import-report] parsed', found.length, 'tradelines');`;
const newParse = `    let found = [], source = 'regex';
    if (process.env.ANTHROPIC_API_KEY) {
      try { found = await aiParseReport(req.body.text); source = 'ai'; }
      catch (e) { console.log('[import-report] AI parse failed, falling back:', e.message); }
    }
    if (!found.length) { found = parseCreditReport(req.body.text); source = 'regex'; }
    console.log('[import-report] parsed', found.length, 'tradelines via', source);`;
if (!code.includes(oldParse)) { console.log('ERROR: parse call not found'); process.exit(1); }
code = SPLITJOIN(code, oldParse, newParse);

fs.writeFileSync('server.js', code);
console.log('Done! AI report parsing live (AI-IMPORT). Set ANTHROPIC_API_KEY in Railway.');

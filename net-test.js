// Run from Desktop/sweepfi-server:  node net-test.js
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
if (code.includes('NET-TEST')) { console.log('Already added.'); process.exit(0); }
const block = `
// NET-TEST
app.get('/net-test', async (req, res) => {
  const targets = ['https://ntfy.sh/health', 'https://example.com', 'https://production.plaid.com'];
  const results = {};
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      results[url] = { ok: true, status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      results[url] = { ok: false, error: e.message, cause: e.cause ? (e.cause.code || e.cause.message) : null, ms: Date.now() - t0 };
    }
  }
  res.json(results);
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! /net-test added.');

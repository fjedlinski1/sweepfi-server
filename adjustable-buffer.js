// Run from Desktop/sweepfi-server:  node adjustable-buffer.js
// User-adjustable minimum buffer (default $200) via user_settings table
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
const COUNT = (s, sub) => s.split(sub).length - 1;
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('ADJUSTABLE-BUFFER')) { console.log('Already patched.'); process.exit(0); }

// 1. Helper + middleware + save endpoint, registered BEFORE all routes
const block = `
// ── ADJUSTABLE-BUFFER ────────────────────────────────────────────────────
async function getUserBuffer(user_id) {
  try {
    const { data } = await supabase.from('user_settings').select('min_buffer').eq('user_id', user_id).maybeSingle();
    const v = data && data.min_buffer != null ? Number(data.min_buffer) : 200;
    return isFinite(v) && v >= 0 ? v : 200;
  } catch (e) { return 200; }
}
app.use(async (req, res, next) => {
  req.minBuffer = 200;
  try { if (req.body && req.body.user_id) req.minBuffer = await getUserBuffer(req.body.user_id); } catch (e) {}
  next();
});
app.post('/settings/save', async (req, res) => {
  try {
    if (!req.body.user_id || req.body.min_buffer == null || req.body.min_buffer === '') {
      return res.status(400).json({ error: 'user_id and min_buffer required' });
    }
    const mb = Number(req.body.min_buffer);
    if (!isFinite(mb) || mb < 0) return res.status(400).json({ error: 'Buffer must be a number ≥ 0' });
    const { error } = await supabase.from('user_settings').upsert({
      user_id: req.body.user_id, min_buffer: mb, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
    console.log('[settings] min_buffer set:', mb);
    res.json({ ok: true, min_buffer: mb });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
const firstRoute = code.search(/app\.(post|get)\(/);
if (firstRoute === -1) { console.log('ERROR: no routes found'); process.exit(1); }
code = code.slice(0, firstRoute) + block + code.slice(firstRoute);

// 2. Every "Funds ready" check uses the user's buffer
const n1 = COUNT(code, 'cash - 200');
code = SPLITJOIN(code, 'cash - 200', 'cash - req.minBuffer');
console.log('Replaced cash-200 checks:', n1);

// 3. Sweep engine breakdown + safe formula
const n2 = COUNT(code, 'min_buffer: 200');
code = SPLITJOIN(code, 'min_buffer: 200', 'min_buffer: req.minBuffer');
console.log('Replaced breakdown min_buffer:', n2);
const n3 = COUNT(code, '- 200)');
code = SPLITJOIN(code, '- 200)', '- req.minBuffer)');
console.log('Replaced formula -200):', n3);
const n4 = COUNT(code, '- 200;');
code = SPLITJOIN(code, '- 200;', '- req.minBuffer;');
console.log('Replaced formula -200; :', n4);

fs.writeFileSync('server.js', code);
console.log('\nDone! Adjustable buffer live (ADJUSTABLE-BUFFER).');

// 4. Diagnostics — anything buffer-ish still hardcoded?
const leftovers = code.split('\n')
  .map((l, i) => ({ l, i: i + 1 }))
  .filter(({ l }) => /200/.test(l) && /buffer/i.test(l) && !l.includes('req.minBuffer'));
if (leftovers.length) {
  console.log('\n⚠ CHECK THESE LINES (possible hardcoded buffer remaining) — paste to Claude:');
  leftovers.forEach(({ l, i }) => console.log(`  ${i}: ${l.trim()}`));
} else {
  console.log('No hardcoded buffer references remain. Clean.');
}

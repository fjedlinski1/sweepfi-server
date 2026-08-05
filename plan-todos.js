// Run from Desktop/sweepfi-server:  node plan-todos.js
// Plan tab backend: flexible settings, settings/get, todos CRUD
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('PLAN-TODOS')) { console.log('Already patched.'); process.exit(0); }

// 1. /settings/save accepts all plan fields, not just min_buffer
const oldSave = `    if (!req.body.user_id || req.body.min_buffer == null || req.body.min_buffer === '') {
      return res.status(400).json({ error: 'user_id and min_buffer required' });
    }
    const mb = Number(req.body.min_buffer);
    if (!isFinite(mb) || mb < 0) return res.status(400).json({ error: 'Buffer must be a number ≥ 0' });
    const { error } = await supabase.from('user_settings').upsert({
      user_id: req.body.user_id, min_buffer: mb, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
    console.log('[settings] min_buffer set:', mb);
    res.json({ ok: true, min_buffer: mb });`;
const newSave = `    if (!req.body.user_id) return res.status(400).json({ error: 'user_id required' });
    const row = { user_id: req.body.user_id, updated_at: new Date().toISOString() }; // PLAN-TODOS
    for (const k of ['min_buffer', 'birth_year', 'retire_age', 'monthly_invest', 'roth_ytd', 'k401_ytd']) {
      if (req.body[k] != null && req.body[k] !== '') {
        const v = Number(req.body[k]);
        if (!isFinite(v) || v < 0) return res.status(400).json({ error: 'Invalid ' + k });
        row[k] = v;
      }
    }
    if (Object.keys(row).length <= 2) return res.status(400).json({ error: 'nothing to save' });
    const { error } = await supabase.from('user_settings').upsert(row, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
    console.log('[settings] saved:', Object.keys(row).join(','));
    res.json({ ok: true, ...row });`;
if (!code.includes(oldSave)) { console.log('ERROR: settings/save block not found — run adjustable-buffer.js first'); process.exit(1); }
code = SPLITJOIN(code, oldSave, newSave);

// 2. settings/get + todos endpoints
const block = `
// ── PLAN-TODOS ───────────────────────────────────────────────────────────
app.post('/settings/get', async (req, res) => {
  try {
    if (!req.body.user_id) return res.status(400).json({ error: 'user_id required' });
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', req.body.user_id).maybeSingle();
    res.json(data || {});
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/todos', async (req, res) => {
  try {
    if (!req.body.user_id) return res.status(400).json({ error: 'user_id required' });
    const a = req.body.action;
    if (a === 'add' && req.body.text) {
      await supabase.from('todos').insert({ user_id: req.body.user_id, text: String(req.body.text).slice(0, 200) });
    } else if (a === 'toggle' && req.body.id) {
      await supabase.from('todos').update({ done: !!req.body.done }).eq('id', req.body.id).eq('user_id', req.body.user_id);
    } else if (a === 'delete' && req.body.id) {
      await supabase.from('todos').delete().eq('id', req.body.id).eq('user_id', req.body.user_id);
    }
    const { data } = await supabase.from('todos').select('*').eq('user_id', req.body.user_id)
      .order('done', { ascending: true }).order('created_at', { ascending: false });
    res.json({ todos: data || [] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

`;
code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Plan backend live (PLAN-TODOS).');

// Run from Desktop/sweepfi-server:  node add-expo-push.js
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('EXPO-PUSH')) { console.log('Already patched.'); process.exit(0); }

const endpoint = `
// ── EXPO-PUSH ─────────────────────────────────────────────────────────────
app.post('/register-push', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.token) return res.status(400).json({ error: 'user_id and token required' });
    const { error } = await supabase.from('push_tokens').upsert(
      { user_id: req.body.user_id, token: req.body.token, created_at: new Date().toISOString() },
      { onConflict: 'token' }
    );
    if (error) throw new Error(error.message);
    console.log('[push] registered token for', req.body.user_id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

async function sendExpoPush(userId, title, body) {
  const { data: rows } = await supabase.from('push_tokens').select('token').eq('user_id', userId);
  if (!rows || !rows.length) { console.log('[push] no tokens for', userId); return null; }
  const messages = rows.map(r => ({ to: r.token, sound: 'default', title, body }));
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const out = await res.json().catch(() => ({}));
  console.log('[push] expo send:', res.status, JSON.stringify(out).slice(0, 160));
  return out;
}

`;
code = code.replace(/app\.listen\(/, () => endpoint + 'app.listen(');

// Guard: user id alone is enough now (expo push needs no other env)
code = SPLITJOIN(code,
  `if (!NOTIFY_USER_ID || (!NTFY_TOPIC && !(RESEND_KEY && NOTIFY_EMAIL))) {
    console.log('[brief] skipped — need NOTIFY_USER_ID plus NTFY_TOPIC and/or RESEND_KEY+NOTIFY_EMAIL');
    return { skipped: true };
  }`,
  `if (!NOTIFY_USER_ID) {
    console.log('[brief] skipped — NOTIFY_USER_ID not set');
    return { skipped: true };
  }`);

// Branded push first in sendBrief
code = SPLITJOIN(code,
  `  // Phone push via ntfy`,
  `  // Branded app push via Expo
  let expoPushResult = null;
  try {
    const planLine = (data.plan || []).map(p => p.name + ' ' + money(p.amount)).join(' · ');
    expoPushResult = await sendExpoPush(
      NOTIFY_USER_ID,
      'Good morning — ' + money(data.safe) + ' safe to invest',
      planLine || 'Nothing safe to sweep today — bills and cushion come first.'
    );
  } catch (e) { console.log('[push] error:', e.message); }

  // Phone push via ntfy`);

fs.writeFileSync('server.js', code);
console.log('Done! /register-push + branded Expo push in morning brief.');

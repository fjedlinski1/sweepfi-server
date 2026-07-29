// Run from Desktop/sweepfi-server:  node add-daily-brief.js
// Adds the daily 8:00 AM ET morning brief email + /test-brief endpoint
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('DAILY-BRIEF')) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

const block = `
// ── DAILY-BRIEF ───────────────────────────────────────────────────────────
// Env needed: RESEND_KEY, NOTIFY_EMAIL, NOTIFY_USER_ID
const RESEND_KEY     = process.env.RESEND_KEY;
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL;
const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID;

async function buildBrief(userId) {
  const port = process.env.PORT || 3001;
  const res = await fetch('http://localhost:' + port + '/sweep-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  return res.json();
}

function briefHtml(d) {
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const planRows = (d.plan || []).map(p =>
    '<tr><td style="padding:8px 0;color:#EDEDED;font-size:15px;">' + p.name +
    '<div style="color:#8A8A93;font-size:12px;">' + p.sub + '</div></td>' +
    '<td style="padding:8px 0;color:#FFFFFF;font-size:15px;font-weight:600;text-align:right;">' + money(p.amount) + '</td></tr>'
  ).join('');
  const b = d.breakdown || {};
  return \`
  <div style="background:#0C0C0E;padding:36px 24px;font-family:-apple-system,Segoe UI,sans-serif;border-radius:16px;max-width:480px;margin:0 auto;">
    <div style="font-size:18px;font-weight:700;color:#FFFFFF;">Sweep<span style="color:#F5A623;">Fi</span></div>
    <div style="font-size:13px;color:#8A8A93;margin-top:22px;">Good morning</div>
    <div style="font-size:42px;font-weight:600;color:#FFFFFF;letter-spacing:-1px;margin-top:8px;">\${money(d.safe)}</div>
    <div style="font-size:13px;color:#8A8A93;margin-top:6px;">safe to invest today</div>
    <div style="border-top:1px solid #17171A;margin-top:22px;padding-top:14px;">
      <div style="font-size:11px;color:#5A5A63;text-transform:uppercase;letter-spacing:0.5px;">Today's plan</div>
      <table style="width:100%;border-collapse:collapse;margin-top:6px;">\${planRows || '<tr><td style="color:#8A8A93;font-size:14px;padding:8px 0;">Nothing safe to sweep today — bills and cushion come first.</td></tr>'}</table>
    </div>
    <div style="border-top:1px solid #17171A;margin-top:14px;padding-top:14px;font-size:12px;color:#5A5A63;line-height:1.7;">
      Cash \${money(b.cash)} · Bills −\${money(b.upcoming_bills)} · Cushion −\${money(b.spending_cushion)} · Buffer −\${money(b.min_buffer)}
    </div>
  </div>\`;
}

async function sendBrief(reason) {
  if (!RESEND_KEY || !NOTIFY_EMAIL || !NOTIFY_USER_ID) {
    console.log('[brief] skipped — RESEND_KEY / NOTIFY_EMAIL / NOTIFY_USER_ID not set');
    return { skipped: true };
  }
  const data = await buildBrief(NOTIFY_USER_ID);
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SweepFi <onboarding@resend.dev>',
      to: [NOTIFY_EMAIL],
      subject: 'Good morning — ' + money(data.safe) + ' safe to invest today',
      html: briefHtml(data),
    }),
  });
  const body = await r.json().catch(() => ({}));
  console.log('[brief] sent (' + reason + '):', r.status, JSON.stringify(body).slice(0, 120));
  return { status: r.status, body };
}

// Scheduler: fire once daily at 8:00 AM Eastern
let lastBriefDate = null;
setInterval(() => {
  try {
    const now = new Date();
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
    const today = et.year + '-' + et.month + '-' + et.day;
    if (et.hour === '08' && lastBriefDate !== today) {
      lastBriefDate = today;
      sendBrief('scheduled').catch(e => console.log('[brief] error:', e.message));
    }
  } catch (e) { console.log('[brief] scheduler error:', e.message); }
}, 60 * 1000);

// Manual trigger for testing
app.get('/test-brief', async (req, res) => {
  try {
    const result = await sendBrief('manual test');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

`;

code = code.replace(/app\.listen\(/, block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! Daily brief added (8:00 AM ET) + /test-brief endpoint.');

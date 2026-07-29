// Run from Desktop/sweepfi-server:  node add-ntfy.js
// Adds phone push notifications via ntfy to the morning brief
// (Requires add-daily-brief.js to be applied first)
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (!code.includes('DAILY-BRIEF')) {
  console.log('ERROR: run add-daily-brief.js first (the brief system is the base).');
  process.exit(1);
}
if (code.includes('NTFY-PUSH')) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

// 1. Add NTFY_TOPIC env
code = SPLITJOIN(code,
  "const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID;",
  "const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID;\nconst NTFY_TOPIC     = process.env.NTFY_TOPIC; // NTFY-PUSH"
);

// 2. Loosen the guard: run if we have a user and at least one channel
code = SPLITJOIN(code,
  `if (!RESEND_KEY || !NOTIFY_EMAIL || !NOTIFY_USER_ID) {
    console.log('[brief] skipped — RESEND_KEY / NOTIFY_EMAIL / NOTIFY_USER_ID not set');
    return { skipped: true };
  }`,
  `if (!NOTIFY_USER_ID || (!NTFY_TOPIC && !(RESEND_KEY && NOTIFY_EMAIL))) {
    console.log('[brief] skipped — need NOTIFY_USER_ID plus NTFY_TOPIC and/or RESEND_KEY+NOTIFY_EMAIL');
    return { skipped: true };
  }`
);

// 3. Send phone push first, then email only if configured
code = SPLITJOIN(code,
  `  const r = await fetch('https://api.resend.com/emails', {`,
  `  // Phone push via ntfy
  let pushStatus = null;
  if (NTFY_TOPIC) {
    try {
      const planLine = (data.plan || []).map(p => p.name + ' ' + money(p.amount)).join(' · ');
      const p = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
        method: 'POST',
        headers: {
          'Title': 'Good morning — ' + money(data.safe) + ' safe to invest',
          'Priority': 'default',
          'Tags': 'moneybag',
        },
        body: planLine || 'Nothing safe to sweep today — bills and cushion come first.',
      });
      pushStatus = p.status;
      console.log('[brief] ntfy push:', p.status);
    } catch (e) { console.log('[brief] ntfy error:', e.message); }
  }

  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    return { push: pushStatus, email: 'not configured' };
  }
  const r = await fetch('https://api.resend.com/emails', {`
);

// 4. Include push status in the email result
code = SPLITJOIN(code,
  "  return { status: r.status, body };\n}",
  "  return { push: pushStatus, status: r.status, body };\n}"
);

fs.writeFileSync('server.js', code);
const ok = code.includes('NTFY-PUSH') && code.includes('ntfy.sh/');
console.log(ok ? 'Done! Morning brief now sends a phone push via ntfy.' : 'WARNING: patch may not have fully applied');

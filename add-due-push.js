// Run from Desktop/sweepfi-server:  node add-due-push.js
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');
if (code.includes('DUE-SOON-PUSH')) { console.log('Already patched.'); process.exit(0); }

const oldExpo = `    const planLine = (data.plan || []).map(p => p.name + ' ' + money(p.amount)).join(' · ');
    expoPushResult = await sendExpoPush(
      NOTIFY_USER_ID,
      'Good morning — ' + money(data.safe) + ' safe to invest',
      planLine || 'Nothing safe to sweep today — bills and cushion come first.'
    );`;
const newExpo = `    // DUE-SOON-PUSH
    const planLine = (data.plan || []).map(p => p.name + ' ' + money(p.amount)).join(' · ');
    let dueLine = '';
    try {
      const port = process.env.PORT || 3001;
      const er = await fetch('http://localhost:' + port + '/expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: NOTIFY_USER_ID }),
      });
      const ed = await er.json();
      const due = (ed.bills || []).filter(b => b.days_until != null && b.days_until <= 3);
      if (due.length) dueLine = 'Due soon: ' + due.map(b => b.name + ' ' + money(b.monthly) + ' (' + b.days_until + 'd)').join(', ');
    } catch (e) {}
    const pushBody = [planLine, dueLine].filter(Boolean).join('  •  ') || 'Nothing safe to sweep today — bills and cushion come first.';
    expoPushResult = await sendExpoPush(
      NOTIFY_USER_ID,
      'Good morning — ' + money(data.safe) + ' safe to invest',
      pushBody
    );`;
if (!code.includes(oldExpo)) { console.log('ERROR: expo push block not found — run add-expo-push.js first'); process.exit(1); }
code = SPLITJOIN(code, oldExpo, newExpo);
fs.writeFileSync('server.js', code);
console.log('Done! Due-soon bills now ride the morning push.');

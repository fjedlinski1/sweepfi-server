// Run from Desktop/sweepfi-server:  node add-alpaca.js
// Adds Alpaca investing: /invest (places order) + /alpaca-status
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('ALPACA-INVEST')) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

const block = `
// ── ALPACA-INVEST ─────────────────────────────────────────────────────────
// Env: ALPACA_KEY, ALPACA_SECRET, ALPACA_URL (defaults to paper)
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_URL    = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';

async function alpacaFetch(path, options = {}) {
  const res = await fetch(ALPACA_URL + path, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('[alpaca] ' + path + ' failed:', res.status, JSON.stringify(body).slice(0, 200));
    throw new Error(body.message || ('Alpaca error ' + res.status));
  }
  return body;
}

// Account status — is the connection alive, what's the buying power
app.get('/alpaca-status', async (req, res) => {
  try {
    if (!ALPACA_KEY) return res.status(400).json({ error: 'ALPACA_KEY not set' });
    const acct = await alpacaFetch('/v2/account');
    res.json({
      status: acct.status,
      paper: ALPACA_URL.includes('paper'),
      equity: acct.equity,
      buying_power: acct.buying_power,
      currency: acct.currency,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Place a notional market buy (default SPY)
app.post('/invest', async (req, res) => {
  console.log('\\n[invest] user:', req.body.user_id, 'amount:', req.body.amount);
  try {
    if (!ALPACA_KEY) return res.status(400).json({ error: 'ALPACA_KEY not set' });
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Amount must be at least $1' });
    if (amount > 25000) return res.status(400).json({ error: 'Amount exceeds safety cap ($25,000)' });
    const symbol = (req.body.symbol || 'SPY').toUpperCase();

    const order = await alpacaFetch('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol,
        notional: String(amount),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      }),
    });
    console.log('[invest] order placed:', order.id, order.status);
    res.json({
      ok: true,
      paper: ALPACA_URL.includes('paper'),
      order_id: order.id,
      symbol: order.symbol,
      notional: order.notional,
      status: order.status,
      submitted_at: order.submitted_at,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

`;

code = code.replace(/app\.listen\(/, () => block + 'app.listen(');
fs.writeFileSync('server.js', code);
console.log('Done! /invest and /alpaca-status added.');

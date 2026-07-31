// Run from Desktop/sweepfi-server:  node add-roth-routing.js
// Roth-first order routing: if the Roth IRA has buying power, orders go there;
// otherwise taxable. Roth uses its own API keys (ALPACA_ROTH_KEY/SECRET).
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('ROTH-ROUTING')) { console.log('Already patched.'); process.exit(0); }

// 1. Roth credentials
const oldConsts = `const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_URL    = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';`;
const newConsts = `const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_URL    = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
// ROTH-ROUTING: the IRA has its own keys; live-only environment
const ALPACA_ROTH_KEY    = process.env.ALPACA_ROTH_KEY;
const ALPACA_ROTH_SECRET = process.env.ALPACA_ROTH_SECRET;
const ALPACA_ROTH_URL    = process.env.ALPACA_ROTH_URL || 'https://api.alpaca.markets';`;
if (!code.includes(oldConsts)) { console.log('ERROR: alpaca consts not found'); process.exit(1); }
code = SPLITJOIN(code, oldConsts, newConsts);

// 2. alpacaFetch picks credentials by account
const oldFetch = `async function alpacaFetch(path, options = {}) {
  const res = await fetch(ALPACA_URL + path, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,`;
const newFetch = `async function alpacaFetch(path, options = {}, acct = 'taxable') {
  const base = acct === 'roth' ? ALPACA_ROTH_URL : ALPACA_URL;
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': acct === 'roth' ? ALPACA_ROTH_KEY : ALPACA_KEY,
      'APCA-API-SECRET-KEY': acct === 'roth' ? ALPACA_ROTH_SECRET : ALPACA_SECRET,`;
if (!code.includes(oldFetch)) { console.log('ERROR: alpacaFetch not found'); process.exit(1); }
code = SPLITJOIN(code, oldFetch, newFetch);

// 3. Status shows both accounts
const oldStatus = `    const acct = await alpacaFetch('/v2/account');
    res.json({
      status: acct.status,
      paper: ALPACA_URL.includes('paper'),
      equity: acct.equity,
      buying_power: acct.buying_power,
      currency: acct.currency,
    });`;
const newStatus = `    const acct = await alpacaFetch('/v2/account');
    let roth = null;
    if (ALPACA_ROTH_KEY) {
      try {
        const r = await alpacaFetch('/v2/account', {}, 'roth');
        roth = { status: r.status, equity: r.equity, buying_power: r.buying_power };
      } catch (e) { roth = { error: e.message }; }
    }
    res.json({
      taxable: {
        status: acct.status,
        paper: ALPACA_URL.includes('paper'),
        equity: acct.equity,
        buying_power: acct.buying_power,
      },
      roth,
    });`;
if (!code.includes(oldStatus)) { console.log('ERROR: status block not found'); process.exit(1); }
code = SPLITJOIN(code, oldStatus, newStatus);

// 4. Routing in /invest
const oldOrder = `    const symbol = (req.body.symbol || 'SPY').toUpperCase();

    const order = await alpacaFetch('/v2/orders', {`;
const newOrder = `    const symbol = (req.body.symbol || 'IQQ').toUpperCase();

    // Roth-first: if the IRA holds enough cash, the order belongs there
    let account = req.body.account === 'roth' ? 'roth' : 'taxable';
    if (!req.body.account && ALPACA_ROTH_KEY) {
      try {
        const r = await alpacaFetch('/v2/account', {}, 'roth');
        if (Number(r.buying_power) >= amount) account = 'roth';
        console.log('[invest] roth buying power', r.buying_power, '-> routing to', account);
      } catch (e) { console.log('[invest] roth check failed, using taxable:', e.message); }
    }

    const order = await alpacaFetch('/v2/orders', {`;
if (!code.includes(oldOrder)) { console.log('ERROR: invest order block not found'); process.exit(1); }
code = SPLITJOIN(code, oldOrder, newOrder);

code = SPLITJOIN(code,
  `        time_in_force: 'day',
      }),
    });
    console.log('[invest] order placed:', order.id, order.status);
    res.json({
      ok: true,
      paper: ALPACA_URL.includes('paper'),`,
  `        time_in_force: 'day',
      }),
    }, account);
    console.log('[invest] order placed in', account + ':', order.id, order.status);
    res.json({
      ok: true,
      account,
      paper: account === 'roth' ? false : ALPACA_URL.includes('paper'),`);

fs.writeFileSync('server.js', code);
console.log('Done! Roth-first routing live (ROTH-ROUTING).');

const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Credentials — paste your keys here ───────────────────────────────────
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service role key from Supabase settings
// ─────────────────────────────────────────────────────────────────────────

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Create Plaid link token ───────────────────────────────────────────────
app.post('/create-link-token', async (req, res) => {
  console.log('\n[create-link-token] user:', req.body.user_id);
  try {
    const r = await plaid.linkTokenCreate({
      user: { client_user_id: req.body.user_id || 'user-1' },
      client_name: 'SweepFi',
      products: ['transactions', 'liabilities'],
      country_codes: ['US'],
      language: 'en',
    });
    console.log('[create-link-token] success');
    res.json({ link_token: r.data.link_token });
  } catch (err) {
    console.log('[create-link-token] error:', err.response?.data || err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Exchange public token ──────────────────────────────────────────────────
app.post('/exchange-token', async (req, res) => {
  console.log('\n[exchange-token] received');
  try {
    const r = await plaid.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    const accessToken = r.data.access_token;
    const itemId = r.data.item_id;
    const userId = req.body.user_id;

    // Save to Supabase
    if (userId) {
      await supabase.from('plaid_tokens').upsert({
        user_id: userId,
        access_token: accessToken,
        item_id: itemId,
        institution: req.body.institution || null,
        created_at: new Date().toISOString(),
      });
    }

    console.log('[exchange-token] success, item:', itemId);
    res.json({ access_token: accessToken, item_id: itemId });
  } catch (err) {
    console.log('[exchange-token] error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Sandbox: create test access token automatically ───────────────────────
app.post('/sandbox-setup', async (req, res) => {
  console.log('\n[sandbox-setup] user:', req.body.user_id);
  try {
    // Create a sandbox public token for Chase (institution id: ins_3)
    const r = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_3',
      initial_products: ['transactions', 'liabilities'],
    });
    const publicToken = r.data.public_token;

    // Exchange for access token
    const ex = await plaid.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = ex.data.access_token;
    const itemId = ex.data.item_id;
    const userId = req.body.user_id;

    // Save to Supabase
    if (userId) {
      await supabase.from('plaid_tokens').upsert({
        user_id: userId,
        access_token: accessToken,
        item_id: itemId,
        institution: 'Chase',
        created_at: new Date().toISOString(),
      });
      console.log('[sandbox-setup] saved token for user:', userId);
    }

    // Fetch accounts immediately
    const accts = await plaid.accountsGet({ access_token: accessToken });
    console.log('[sandbox-setup] got', accts.data.accounts.length, 'accounts');

    res.json({
      success: true,
      access_token: accessToken,
      item_id: itemId,
      accounts: accts.data.accounts,
    });
  } catch (err) {
    console.log('[sandbox-setup] error:', err.response?.data || err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Get accounts (MULTI-BANK: merges all connected institutions) ─────────
app.post('/get-accounts', async (req, res) => {
  console.log('\n[get-accounts] user:', req.body.user_id);
  try {
    let tokens = [];
    if (req.body.access_token) {
      tokens = [{ access_token: req.body.access_token }];
    } else if (req.body.user_id) {
      const { data } = await supabase
        .from('plaid_tokens')
        .select('access_token, institution')
        .eq('user_id', req.body.user_id)
        .order('created_at', { ascending: false });
      if (data) tokens = data;
    }

    if (!tokens.length) {
      return res.status(400).json({ error: 'No access token found' });
    }

    let allAccounts = [];
    for (const t of tokens) {
      try {
        const r = await plaid.accountsGet({ access_token: t.access_token });
        const withInst = r.data.accounts.map(a => ({ ...a, institution: t.institution || null }));
        allAccounts = allAccounts.concat(withInst);
      } catch (err) {
        console.log('[get-accounts] token failed (skipping):', err.response?.data?.error_code || err.message);
      }
    }

    if (req.body.user_id) {
      try {
        const man = await getManualAccounts(req.body.user_id);
        man.forEach(m => allAccounts.push({
          account_id: 'manual-' + m.name.toLowerCase().replace(/\s+/g, '-'),
          name: m.name,
          official_name: m.name,
          type: (m.type === 'credit' || m.type === 'loan') ? 'credit'
              : (m.type === 'cash' ? 'depository' : 'investment'),
          subtype: m.type,
          manual: true,
          balances: { current: Number(m.balance), available: m.type === 'cash' ? Number(m.balance) : null },
          institution: 'Manual',
        }));
      } catch (e) { console.log('[get-accounts] manual skip:', e.message); }
    }
    console.log('[get-accounts] got', allAccounts.length, 'accounts from', tokens.length, 'bank(s)');
    res.json({ accounts: allAccounts });
  } catch (err) {
    console.log('[get-accounts] error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Get transactions ──────────────────────────────────────────────────────
app.post('/get-transactions', async (req, res) => {
  console.log('\n[get-transactions] user:', req.body.user_id);
  try {
    let accessToken = req.body.access_token;

    if (!accessToken && req.body.user_id) {
      const { data } = await supabase
        .from('plaid_tokens')
        .select('access_token')
        .eq('user_id', req.body.user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (data) accessToken = data.access_token;
    }

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const r = await plaid.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 100 },
    });

    console.log('[get-transactions] got', r.data.transactions.length, 'transactions');
    res.json({ transactions: r.data.transactions });
  } catch (err) {
    console.log('[get-transactions] error:', err.message);
    res.status(400).json({ error: err.message });
  }
});


// ── Browser-based Plaid Link page (TWO-BUTTON-LINK) ──────────────────────
app.get('/link', async (req, res) => {
  const userId = req.query.user_id || '';
  try {
    // Bank link: transactions required, liabilities only if the bank supports it
    const bankR = await plaid.linkTokenCreate({
      user: { client_user_id: userId || 'user-1' },
      client_name: 'SweepFi',
      products: ['transactions'],
      required_if_supported_products: ['liabilities'],
      country_codes: ['US'],
      language: 'en',
    });
    // Investment link: for brokerages like Fidelity, Vanguard, Schwab
    const invR = await plaid.linkTokenCreate({
      user: { client_user_id: userId || 'user-1' },
      client_name: 'SweepFi',
      products: ['investments'],
      country_codes: ['US'],
      language: 'en',
    });
    const bankToken = bankR.data.link_token;
    const invToken = invR.data.link_token;
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SweepFi — Connect Accounts</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { background:#0E0D0A; color:#F5F0E8; font-family:-apple-system,sans-serif;
           display:flex; flex-direction:column; align-items:center; justify-content:center;
           height:100vh; margin:0; }
    h1 { font-size:32px; font-weight:800; margin:0 0 4px; }
    .fi { color:#FFB84D; }
    p { color:#7A7065; font-size:14px; margin:0 0 40px; }
    button { background:#F5A623; color:#0E0D0A; border:none; border-radius:12px;
             padding:18px 40px; font-size:13px; font-weight:800; letter-spacing:1.5px;
             cursor:pointer; margin-bottom:14px; width:300px; }
    button.secondary { background:transparent; color:#FFB84D; border:1px solid rgba(255,184,77,0.4); }
    #status { margin-top:24px; font-family:monospace; font-size:13px; color:#22C97A; max-width:80%; text-align:center; }
  </style>
</head>
<body>
  <h1>Sweep<span class="fi">Fi</span></h1>
  <p>Connect your accounts</p>
  <button id="bank">CONNECT BANK →</button>
  <button id="inv" class="secondary">CONNECT INVESTMENT ACCOUNT →</button>
  <div id="status"></div>
  <script>
    function makeHandler(token) {
      return Plaid.create({
        token: token,
        onSuccess: async (public_token, metadata) => {
          document.getElementById('status').textContent = 'Saving connection...';
          const resp = await fetch('/exchange-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token: public_token,
              user_id: '${userId}',
              institution: metadata.institution ? metadata.institution.name : ''
            })
          });
          const data = await resp.json();
          if (data.access_token || data.item_id) {
            document.getElementById('status').textContent =
              '✓ ' + (metadata.institution ? metadata.institution.name : 'Account') +
              ' connected! Refresh the SweepFi app.';
          } else {
            document.getElementById('status').textContent = 'Error: ' + (data.error || 'unknown');
          }
        },
        onExit: (err) => {
          if (err) document.getElementById('status').textContent = 'Exited: ' + (err.display_message || err.error_message || 'closed');
        }
      });
    }
    const bankHandler = makeHandler('${bankToken}');
    const invHandler = makeHandler('${invToken}');
    document.getElementById('bank').onclick = () => bankHandler.open();
    document.getElementById('inv').onclick = () => invHandler.open();
  </script>
</body>
</html>`);
  } catch (err) {
    console.log('[/link] error:', err.response?.data || err.message);
    res.status(400).send('Error creating link token: ' + err.message);
  }
});


// ── METHOD-INTEGRATION ────────────────────────────────────────────────────
const METHOD_KEY = process.env.METHOD_KEY; // dev key
const METHOD_URL = 'https://dev.methodfi.com';

async function methodFetch(path, options = {}) {
  const res = await fetch(METHOD_URL + path, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + METHOD_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('[method] ' + path + ' failed:', res.status, JSON.stringify(body));
    throw new Error(body.message || ('Method API error ' + res.status));
  }
  return body;
}

// Create Method entity + run debt discovery.
// In DEV, Method returns simulated data — use their test identity.
// METHOD-VERIFY-V2
app.post('/method/setup', async (req, res) => {
  console.log('\n[method/setup] user:', req.body.user_id);
  const log = [];
  const step = (m) => { console.log('[method/setup]', m); log.push(m); };
  try {
    // 1. Create entity (dev test identity by default)
    const entResp = await methodFetch('/entities', {
      method: 'POST',
      body: JSON.stringify({
        type: 'individual',
        individual: {
          first_name: req.body.first_name || 'Kevin',
          last_name:  req.body.last_name  || 'Doyle',
          phone:      req.body.phone      || '+15121231111',
        },
      }),
    });
    const entity = entResp.data || entResp;
    step('entity created: ' + entity.id + ' status: ' + entity.status);

    if (req.body.user_id) {
      await supabase.from('method_entities').upsert({
        user_id: req.body.user_id,
        entity_id: entity.id,
        created_at: new Date().toISOString(),
      });
    }

    // 2. Phone verification — try byo_sms (attested), fall back to sms flow
    try {
      const v = await methodFetch('/entities/' + entity.id + '/verification_sessions', {
        method: 'POST',
        body: JSON.stringify({ type: 'phone', method: 'byo_sms', byo_sms: { timestamp: new Date().toISOString() } }),
      });
      step('phone byo_sms: ' + ((v.data || v).status));
    } catch (e1) {
      step('byo_sms failed (' + e1.message + '), trying sms flow');
      try {
        const s = await methodFetch('/entities/' + entity.id + '/verification_sessions', {
          method: 'POST',
          body: JSON.stringify({ type: 'phone', method: 'sms', sms: {} }),
        });
        const sess = s.data || s;
        const u = await methodFetch('/entities/' + entity.id + '/verification_sessions/' + sess.id, {
          method: 'PUT',
          body: JSON.stringify({ type: 'phone', method: 'sms', sms: { sms_code: '111111' } }),
        });
        step('phone sms: ' + ((u.data || u).status));
      } catch (e2) {
        step('phone sms flow failed: ' + e2.message);
      }
    }

    // 3. Identity verification — KBA, auto-answering "Correct" options (dev convention)
    try {
      const k = await methodFetch('/entities/' + entity.id + '/verification_sessions', {
        method: 'POST',
        body: JSON.stringify({ type: 'identity', method: 'kba', kba: {} }),
      });
      const kba = k.data || k;
      const questions = (kba.kba && kba.kba.questions) || [];
      step('kba questions: ' + questions.length);
      if (questions.length) {
        const answers = questions.map(q => {
          const correct = (q.answers || []).find(a => /correct/i.test(a.text || '')) || (q.answers || [])[0];
          return { question_id: q.id, answer_id: correct ? correct.id : null };
        }).filter(a => a.answer_id);
        const done = await methodFetch('/entities/' + entity.id + '/verification_sessions/' + kba.id, {
          method: 'PUT',
          body: JSON.stringify({ type: 'identity', method: 'kba', kba: { answers } }),
        });
        step('kba result: ' + ((done.data || done).status));
      }
    } catch (e) {
      step('kba failed: ' + e.message);
    }

    // 4. Connect — debt discovery
    let connection = null;
    try {
      const c = await methodFetch('/entities/' + entity.id + '/connect', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      connection = c.data || c;
      step('connect: ' + (connection.status || JSON.stringify(connection).slice(0, 120)));
    } catch (e) {
      step('connect failed: ' + e.message);
    }

    // 5. List discovered accounts
    let accounts = [];
    try {
      const list = await methodFetch('/accounts?holder_id=' + entity.id);
      accounts = list.data || list || [];
      step('accounts found: ' + accounts.length);
    } catch (e) {
      step('account list failed: ' + e.message);
    }

    res.json({ entity_id: entity.id, log, accounts });
  } catch (err) {
    res.status(400).json({ error: err.message, log });
  }
});

// List debts for a user (looks up saved entity)
app.post('/method/debts', async (req, res) => {
  console.log('\n[method/debts] user:', req.body.user_id);
  try {
    const { data } = await supabase
      .from('method_entities')
      .select('entity_id')
      .eq('user_id', req.body.user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!data) return res.status(400).json({ error: 'No Method entity — run setup first' });

    const list = await methodFetch('/accounts?holder_id=' + data.entity_id);
    const accounts = list.data || list || [];
    console.log('[method/debts] returning', accounts.length, 'accounts');
    res.json({ accounts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ── METHOD-LINK-PAGE ──────────────────────────────────────────────────────
app.get('/method-link', async (req, res) => {
  const userId = req.query.user_id || '';
  try {
    // 1. Reuse saved entity or create one
    let entityId = null;
    if (userId) {
      const { data } = await supabase
        .from('method_entities')
        .select('entity_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (data) entityId = data.entity_id;
    }
    if (!entityId) {
      const entResp = await methodFetch('/entities', {
        method: 'POST',
        body: JSON.stringify({
          type: 'individual',
          individual: { first_name: 'Kevin', last_name: 'Doyle', phone: '+15121231111' },
        }),
      });
      entityId = (entResp.data || entResp).id;
      if (userId) {
        await supabase.from('method_entities').upsert({
          user_id: userId, entity_id: entityId, created_at: new Date().toISOString(),
        });
      }
      console.log('[method-link] created entity', entityId);
    } else {
      console.log('[method-link] reusing entity', entityId);
    }

    // 2. Create Connect element token
    const tokResp = await methodFetch('/elements/token', {
      method: 'POST',
      headers: { 'Method-Version': '2025-07-04' },
      body: JSON.stringify({
        entity_id: entityId,
        team_name: 'SweepFi',
        type: 'connect',
        connect: {},
      }),
    });
    const elementToken = (tokResp.data || tokResp).element_token || tokResp.element_token;
    console.log('[method-link] element token created');

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SweepFi — Connect Debts</title>
  <script src="https://static.methodfi.com/elements/v1/stable/init.js"></script>
  <style>
    body { background:#0C0C0E; color:#EDEDED; font-family:-apple-system,sans-serif;
           display:flex; flex-direction:column; align-items:center; justify-content:center;
           height:100vh; margin:0; }
    h1 { font-size:30px; font-weight:700; margin:0 0 6px; letter-spacing:-1px; }
    .fi { color:#F5A623; }
    p { color:#8A8A93; font-size:14px; margin:0 0 36px; }
    button { background:#F5A623; color:#0C0C0E; border:none; border-radius:14px;
             padding:16px 44px; font-size:15px; font-weight:700; cursor:pointer; }
    #status { margin-top:22px; font-size:13px; color:#22C97A; max-width:80%; text-align:center; }
    .hint { margin-top:16px; font-size:12px; color:#5A5A63; max-width:340px; text-align:center; line-height:1.5; }
  </style>
</head>
<body>
  <h1>Sweep<span class="fi">Fi</span></h1>
  <p>Discover all your debts</p>
  <button id="go">Find my debts</button>
  <div id="status"></div>
  <div class="hint">Dev mode: use any phone code, and pick the "Correct" answer on each security question.</div>
  <script>
    const method = new Method({
      env: 'dev',
      onSuccess: (payload) => {
        document.getElementById('status').textContent = '✓ Debts discovered! Refresh the SweepFi app.';
        console.log('success', payload);
      },
      onError: (err) => {
        document.getElementById('status').textContent = 'Error: ' + JSON.stringify(err);
      },
      onExit: (p) => { console.log('exit', p); },
    });
    document.getElementById('go').onclick = () => method.open('${elementToken}');
  </script>
</body>
</html>`);
  } catch (err) {
    console.log('[method-link] error:', err.message);
    res.status(400).send('Error: ' + err.message);
  }
});


// ── SWEEP-ENGINE ──────────────────────────────────────────────────────────
const MIN_BUFFER = 200; // configurable minimum checking buffer

app.post('/sweep-plan', async (req, res) => {
  console.log('\n[sweep-plan] user:', req.body.user_id);
  try {
    // 1. Gather all tokens
    const { data: tokens } = await supabase
      .from('plaid_tokens')
      .select('access_token, institution')
      .eq('user_id', req.body.user_id)
      .order('created_at', { ascending: false });
    if (!tokens || !tokens.length) return res.status(400).json({ error: 'No linked accounts' });

    // 2. Accounts + transactions from every institution
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    let accounts = [], transactions = [];
    for (const t of tokens) {
      try {
        const a = await plaid.accountsGet({ access_token: t.access_token });
        accounts = accounts.concat(a.data.accounts.map(x => ({ ...x, institution: t.institution })));
      } catch (e) { console.log('[sweep-plan] accounts fail:', e.response?.data?.error_code || e.message); }
      try {
        const tr = await plaid.transactionsGet({
          access_token: t.access_token,
          start_date: startDate, end_date: endDate,
          options: { count: 250 },
        });
        transactions = transactions.concat(tr.data.transactions);
      } catch (e) { console.log('[sweep-plan] txns fail:', e.response?.data?.error_code || e.message); }
    }
    console.log('[sweep-plan]', accounts.length, 'accounts,', transactions.length, 'transactions');

    // 3. Cash position (checking + savings)
    const cashAccounts = accounts.filter(a => a.type === 'depository');
    const cash = cashAccounts.reduce((s, a) => s + (a.balances.available ?? a.balances.current ?? 0), 0);

    // 4. Recurring bill detection: same merchant appearing with similar amounts
    const outflows = transactions.filter(tx => tx.amount > 0); // Plaid: positive = money out
    const byName = {};
    outflows.forEach(tx => {
      const key = (tx.merchant_name || tx.name || 'unknown').toLowerCase().slice(0, 24);
      (byName[key] = byName[key] || []).push(tx);
    });
    const recurringBills = [];
    Object.entries(byName).forEach(([name, txs]) => {
      if (txs.length < 2) return;
      // BILL-CLASSIFY: transfers, brokerage deposits, P2P, and bank fees are not bills
      const sampleTx = txs[txs.length - 1];
      const pfc = (sampleTx.personal_finance_category?.primary || sampleTx.category?.[0] || '').toString().toUpperCase().replace(/ /g, '_');
      if (pfc.includes('TRANSFER') || pfc.includes('BANK_FEES')) return;
      if (/plus ?500|coinbase|robinhood|webull|alpaca|etrade|e\*trade|fidelity|schwab|tradovate|topstepx|zelle|venmo|cash ?app|paypal|apple cash|overdraft|nsf fee|insufficient|wire (out|transfer)|brokerage|crossmint/i.test(name)) return;
      const amounts = txs.map(t => t.amount);
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const similar = amounts.every(a => Math.abs(a - avg) / avg < 0.25);
      if (similar && avg >= 5) {
        recurringBills.push({ name, monthly: Math.round(avg * 100) / 100, occurrences: txs.length });
      }
    });
    let visibleBills = recurringBills;
    try {
      const { data: hov } = await supabase
        .from('bill_overrides')
        .select('name, hidden')
        .eq('user_id', req.body.user_id)
        .eq('hidden', true);
      if (hov && hov.length) {
        const hiddenSet = new Set(hov.map(o => o.name));
        visibleBills = recurringBills.filter(b => !hiddenSet.has(b.name));
      }
    } catch (e) {}
    const upcomingBills = visibleBills.reduce((s, b) => s + b.monthly, 0);

    // 5. Average daily discretionary spend (non-recurring outflows)
    const recurringNames = new Set(recurringBills.map(b => b.name));
    const discretionary = outflows.filter(tx => {
      const key = (tx.merchant_name || tx.name || 'unknown').toLowerCase().slice(0, 24);
      return !recurringNames.has(key);
    });
    const totalDiscretionary = discretionary.reduce((s, t) => s + t.amount, 0);
    const dailySpend = totalDiscretionary / 30;
    const spendingCushion = Math.round(dailySpend * 14 * 100) / 100; // 2 weeks of runway

    // 6. Pending transactions
    const pending = transactions.filter(t => t.pending).reduce((s, t) => s + Math.max(0, t.amount), 0);

    // 7. Safe to optimize
    const safe = Math.max(0, Math.round((cash - upcomingBills - spendingCushion - pending - MIN_BUFFER) * 100) / 100);

    // 8. Allocation plan against real debts (Plaid credit accounts)
    let debts = accounts.filter(a => a.type === 'credit' && (a.balances.current || 0) > 0);
    try {
      const man = await getManualAccounts(req.body.user_id);
      man.filter(m => (m.type === 'credit' || m.type === 'loan') && Number(m.balance) > 0)
        .forEach(m => debts.push({ name: m.name, balances: { current: Number(m.balance) } }));
    } catch (e) {}
    const plan = [];
    let remaining = safe;
    if (safe > 0) {
      if (debts.length) {
        const debtAmt = Math.min(remaining * 0.5, debts.reduce((s, d) => s + d.balances.current, 0));
        if (debtAmt > 1) {
          plan.push({ name: 'Pay down ' + (debts[0].name || 'credit card'), sub: 'Highest-cost debt first', amount: Math.round(debtAmt * 100) / 100, color: 'coral' });
          remaining -= debtAmt;
        }
      }
      if (remaining > 1) {
        const invest = remaining * (debts.length ? 0.6 : 0.5);
        plan.push({ name: 'Invest', sub: 'Roth IRA first, then taxable', amount: Math.round(invest * 100) / 100, color: 'mint' });
        remaining -= invest;
      }
      if (remaining > 1) {
        plan.push({ name: 'Emergency fund', sub: 'Building your safety net', amount: Math.round(remaining * 100) / 100, color: 'amber' });
      }
    }

    res.json({
      safe,
      breakdown: {
        cash: Math.round(cash * 100) / 100,
        upcoming_bills: Math.round(upcomingBills * 100) / 100,
        spending_cushion: spendingCushion,
        pending: Math.round(pending * 100) / 100,
        min_buffer: MIN_BUFFER,
      },
      recurring_bills: visibleBills.sort((a, b) => b.monthly - a.monthly),
      plan,
    });
  } catch (err) {
    console.log('[sweep-plan] error:', err.message);
    res.status(400).json({ error: err.message });
  }
});


// ── EXPENSES-ENDPOINT ─────────────────────────────────────────────────────
app.post('/expenses', async (req, res) => {
  console.log('\n[expenses] user:', req.body.user_id);
  try {
    const { data: tokens } = await supabase
      .from('plaid_tokens')
      .select('access_token, institution')
      .eq('user_id', req.body.user_id)
      .order('created_at', { ascending: false });
    if (!tokens || !tokens.length) return res.status(400).json({ error: 'No linked accounts' });

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 60 * 864e5).toISOString().split('T')[0]; // SIXTY-DAY-BILLS
    let transactions = [], accounts = [];
    for (const t of tokens) {
      try {
        const a = await plaid.accountsGet({ access_token: t.access_token });
        accounts = accounts.concat(a.data.accounts);
      } catch (e) {}
      try {
        const tr = await plaid.transactionsGet({
          access_token: t.access_token,
          start_date: startDate, end_date: endDate,
          options: { count: 500 },
        });
        transactions = transactions.concat(tr.data.transactions);
      } catch (e) { console.log('[expenses] txn fail:', e.response?.data?.error_code || e.message); }
    }

    const cash = accounts
      .filter(a => a.type === 'depository')
      .reduce((s, a) => s + (a.balances.available ?? a.balances.current ?? 0), 0);

    const outflows = transactions.filter(tx => tx.amount > 0);
    const cutoff30 = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    const outflows30 = outflows.filter(tx => tx.date >= cutoff30);

    // Recurring bills
    const byName = {};
    outflows.forEach(tx => {
      const key = (tx.merchant_name || tx.name || 'unknown').toLowerCase().slice(0, 24);
      (byName[key] = byName[key] || []).push(tx);
    });
    const bills = [];
    Object.entries(byName).forEach(([name, txs]) => {
      if (txs.length < 2) return;
      // BILL-CLASSIFY: transfers, brokerage deposits, P2P, and bank fees are not bills
      const sampleTx = txs[txs.length - 1];
      const pfc = (sampleTx.personal_finance_category?.primary || sampleTx.category?.[0] || '').toString().toUpperCase().replace(/ /g, '_');
      if (pfc.includes('TRANSFER') || pfc.includes('BANK_FEES')) return;
      if (/plus ?500|coinbase|robinhood|webull|alpaca|etrade|e\*trade|fidelity|schwab|tradovate|topstepx|zelle|venmo|cash ?app|paypal|apple cash|overdraft|nsf fee|insufficient|wire (out|transfer)|brokerage|crossmint/i.test(name)) return;
      const amounts = txs.map(t => t.amount);
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      if (amounts.every(a => Math.abs(a - avg) / avg < 0.25) && avg >= 5) {
        const days = txs.map(t => Number(t.date.split('-')[2])).sort((a, b) => a - b);
        const dueDay = days[Math.floor(days.length / 2)];
        bills.push({
          name,
          monthly: Math.round(avg * 100) / 100,
          last_date: txs.map(t => t.date).sort().pop(),
          due_day: dueDay,
          ready_to_pay: cash - 200 >= avg,
        });
      }
    });
    // BILL-OVERRIDES: user-set amount/due day win over detection
    try {
      const { data: ov } = await supabase
        .from('bill_overrides')
        .select('name, amount, due_day, hidden, display_name')
        .eq('user_id', req.body.user_id);
      if (ov && ov.length) {
        const byOv = Object.fromEntries(ov.map(o => [o.name, o]));
        bills.forEach(b => {
          const o = byOv[b.name];
          if (o) {
            if (o.amount != null) { b.monthly = Number(o.amount); b.overridden = true; }
            if (o.due_day != null) { b.due_day = Number(o.due_day); b.overridden = true; }
            if (o.hidden) b.hidden = true;
            if (o.display_name) b.display_name = o.display_name;
            b.ready_to_pay = cash - 200 >= b.monthly;
          }
        });
      }
    } catch (e) { console.log('[expenses] overrides skip:', e.message); }

    const today = new Date(); // MONTH-SUMMARY
    const monthStartStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01';
    bills.forEach(b => {
      b.paid_this_month = !!(b.last_date && b.last_date >= monthStartStr);
      if (!b.due_day) { b.next_due = null; return; }
      let y = today.getFullYear(), m = today.getMonth();
      if (today.getDate() > b.due_day) { m += 1; if (m > 11) { m = 0; y += 1; } }
      const lastDay = new Date(y, m + 1, 0).getDate();
      const d = new Date(y, m, Math.min(b.due_day, lastDay));
      b.next_due = d.toISOString().split('T')[0];
      b.days_until = Math.round((d - today) / 864e5);
    });
    bills.sort((a, b) => (a.days_until ?? 99) - (b.days_until ?? 99));

    // Category totals
    const catTotals = {};
    outflows30.forEach(tx => {
      const cat = (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other')
        .replace(/_/g, ' ').toLowerCase();
      catTotals[cat] = (catTotals[cat] || 0) + tx.amount;
    });
    const categories = Object.entries(catTotals)
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    const totalMonthly = Math.round(outflows30.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const totalBills = Math.round(bills.filter(b => !b.hidden).reduce((s, b) => s + b.monthly, 0) * 100) / 100;

    // Debts ready to pay
    const plaidDebts = accounts
      .filter(a => a.type === 'credit' && (a.balances.current || 0) > 0)
      .map(d => ({
        name: d.name,
        balance: Math.round(d.balances.current * 100) / 100,
        min_payment: d.balances.minimum_payment || null,
        ready_to_pay: cash - 200 >= (d.balances.minimum_payment || d.balances.current * 0.03),
      }));
    let manualDebts = [];
    try {
      const man = await getManualAccounts(req.body.user_id);
      manualDebts = man.filter(m => (m.type === 'credit' || m.type === 'loan') && Number(m.balance) > 0)
        .map(m => {
          const key = m.name.toLowerCase().split(' ')[0];
          const matched = key.length >= 4 ? bills.find(b => b.name.includes(key)) : null;
          const pay = matched ? matched.monthly : null;
          return {
            name: m.name,
            balance: Math.round(Number(m.balance) * 100) / 100,
            min_payment: pay,
            apr: m.apr,
            manual: true,
            matched_bill: matched ? matched.name : null,
            ready_to_pay: cash - 200 >= (pay || Number(m.balance) * 0.03),
          };
        });
    } catch (e) {}
    const debts = [...plaidDebts, ...manualDebts];

    console.log('[expenses]', bills.length, 'bills,', categories.length, 'categories, total out:', totalMonthly);
    const recurringSet = new Set(bills.map(b => b.name));
    const top_merchants = Object.entries(byName)
      .filter(([name]) => !recurringSet.has(name))
      .map(([name, txs]) => {
        const t30 = txs.filter(t => t.date >= cutoff30);
        return {
          name,
          total: Math.round(t30.reduce((s, t) => s + t.amount, 0) * 100) / 100,
          count: t30.length,
        };
      })
      .filter(m => m.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    res.json({ total_monthly: totalMonthly, total_bills: totalBills, cash: Math.round(cash*100)/100, bills: bills.filter(b => !b.hidden), categories, debts, top_merchants });
  } catch (err) {
    console.log('[expenses] error:', err.message);
    res.status(400).json({ error: err.message });
  }
});


// ── DAILY-BRIEF ───────────────────────────────────────────────────────────
// Env needed: RESEND_KEY, NOTIFY_EMAIL, NOTIFY_USER_ID
const RESEND_KEY     = process.env.RESEND_KEY;
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL;
const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID;
const NTFY_TOPIC     = process.env.NTFY_TOPIC; // NTFY-PUSH

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
  return `
  <div style="background:#0C0C0E;padding:36px 24px;font-family:-apple-system,Segoe UI,sans-serif;border-radius:16px;max-width:480px;margin:0 auto;">
    <div style="font-size:18px;font-weight:700;color:#FFFFFF;">Sweep<span style="color:#F5A623;">Fi</span></div>
    <div style="font-size:13px;color:#8A8A93;margin-top:22px;">Good morning</div>
    <div style="font-size:42px;font-weight:600;color:#FFFFFF;letter-spacing:-1px;margin-top:8px;">${money(d.safe)}</div>
    <div style="font-size:13px;color:#8A8A93;margin-top:6px;">safe to invest today</div>
    <div style="border-top:1px solid #17171A;margin-top:22px;padding-top:14px;">
      <div style="font-size:11px;color:#5A5A63;text-transform:uppercase;letter-spacing:0.5px;">Today's plan</div>
      <table style="width:100%;border-collapse:collapse;margin-top:6px;">${planRows || '<tr><td style="color:#8A8A93;font-size:14px;padding:8px 0;">Nothing safe to sweep today — bills and cushion come first.</td></tr>'}</table>
    </div>
    <div style="border-top:1px solid #17171A;margin-top:14px;padding-top:14px;font-size:12px;color:#5A5A63;line-height:1.7;">
      Cash ${money(b.cash)} · Bills −${money(b.upcoming_bills)} · Cushion −${money(b.spending_cushion)} · Buffer −${money(b.min_buffer)}
    </div>
  </div>`;
}

async function sendBrief(reason) {
  if (!NOTIFY_USER_ID) {
    console.log('[brief] skipped — NOTIFY_USER_ID not set');
    return { skipped: true };
  }
  const data = await buildBrief(NOTIFY_USER_ID);
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  // Branded app push via Expo
  let expoPushResult = null;
  try {
    // DUE-SOON-PUSH
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
      if (due.length) dueLine = 'Due soon: ' + due.map(b => (b.display_name || b.name) + ' ' + money(b.monthly) + ' (' + b.days_until + 'd)').join(', ');
    } catch (e) {}
    const pushBody = [planLine, dueLine].filter(Boolean).join('  •  ') || 'Nothing safe to sweep today — bills and cushion come first.';
    expoPushResult = await sendExpoPush(
      NOTIFY_USER_ID,
      'Good morning — ' + money(data.safe) + ' safe to invest',
      pushBody
    );
  } catch (e) { console.log('[push] error:', e.message); }

  // Phone push via ntfy
  let pushStatus = null;
  if (NTFY_TOPIC) {
    try {
      const planLine = (data.plan || []).map(p => p.name + ' ' + money(p.amount)).join(' · ');
      const p = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
        method: 'POST',
        headers: {
          'Title': 'Good morning: ' + money(data.safe) + ' safe to invest',
          'Priority': 'default',
          'Tags': 'moneybag',
        },
        body: planLine || 'Nothing safe to sweep today — bills and cushion come first.',
      });
      pushStatus = p.status;
      console.log('[brief] ntfy push:', p.status);
    } catch (e) { console.log('[brief] ntfy error:', e.message, '| cause:', e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : 'none'); }
  }

  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    return { push: pushStatus, email: 'not configured' };
  }
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
  return { push: pushStatus, status: r.status, body };
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
      if (NOTIFY_USER_ID) snapshotNetWorth(NOTIFY_USER_ID).catch(e => console.log('[snapshot] error:', e.message));
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


// ── ALPACA-INVEST ─────────────────────────────────────────────────────────
// Env: ALPACA_KEY, ALPACA_SECRET, ALPACA_URL (defaults to paper)
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_URL    = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
// ROTH-ROUTING: the IRA has its own keys; live-only environment
const ALPACA_ROTH_KEY    = process.env.ALPACA_ROTH_KEY;
const ALPACA_ROTH_SECRET = process.env.ALPACA_ROTH_SECRET;
const ALPACA_ROTH_URL    = process.env.ALPACA_ROTH_URL || 'https://api.alpaca.markets';

async function alpacaFetch(path, options = {}, acct = 'taxable') {
  const base = acct === 'roth' ? ALPACA_ROTH_URL : ALPACA_URL;
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': acct === 'roth' ? ALPACA_ROTH_KEY : ALPACA_KEY,
      'APCA-API-SECRET-KEY': acct === 'roth' ? ALPACA_ROTH_SECRET : ALPACA_SECRET,
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
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Place a notional market buy (default SPY)
app.post('/invest', async (req, res) => {
  console.log('\n[invest] user:', req.body.user_id, 'amount:', req.body.amount);
  try {
    if (!ALPACA_KEY) return res.status(400).json({ error: 'ALPACA_KEY not set' });
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Amount must be at least $1' });
    if (amount > 25000) return res.status(400).json({ error: 'Amount exceeds safety cap ($25,000)' });
    const symbol = (req.body.symbol || 'IQQ').toUpperCase();

    // Roth-first: if the IRA holds enough cash, the order belongs there
    let account = req.body.account === 'roth' ? 'roth' : 'taxable';
    if (!req.body.account && ALPACA_ROTH_KEY) {
      try {
        const r = await alpacaFetch('/v2/account', {}, 'roth');
        if (Number(r.buying_power) >= amount) account = 'roth';
        console.log('[invest] roth buying power', r.buying_power, '-> routing to', account);
      } catch (e) { console.log('[invest] roth check failed, using taxable:', e.message); }
    }

    const order = await alpacaFetch('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol,
        notional: String(amount),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      }),
    }, account);
    console.log('[invest] order placed in', account + ':', order.id, order.status);
    res.json({
      ok: true,
      account,
      paper: account === 'roth' ? false : ALPACA_URL.includes('paper'),
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


// ── METHOD-PAY ────────────────────────────────────────────────────────────
async function methodEntityFor(userId) {
  const { data } = await supabase
    .from('method_entities')
    .select('entity_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data ? data.entity_id : null;
}

// Create (or reuse) an ACH source account on the entity — dev uses test coordinates
app.post('/method/source', async (req, res) => {
  console.log('\n[method/source] user:', req.body.user_id);
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity — run /method-link first' });

    // Reuse an existing ach source if present
    const list = await methodFetch('/accounts?holder_id=' + entityId);
    const existing = (list.data || []).find(a => a.type === 'ach');
    if (existing) {
      console.log('[method/source] reusing', existing.id);
      return res.json({ source_id: existing.id, reused: true });
    }

    const acct = await methodFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        holder_id: entityId,
        ach: {
          routing: req.body.routing || '021000021',
          number:  req.body.number  || '1122334455',
          type: 'checking',
        },
      }),
    });
    const a = acct.data || acct;
    console.log('[method/source] created', a.id, a.status);
    res.json({ source_id: a.id, reused: false, status: a.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pay a liability. amount in DOLLARS here; Method wants cents.
app.post('/method/pay', async (req, res) => {
  console.log('\n[method/pay] user:', req.body.user_id, 'dest:', req.body.destination, 'amount:', req.body.amount);
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity' });
    const amount = Math.round(Number(req.body.amount) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum $1' });
    if (amount > 2500000) return res.status(400).json({ error: 'Exceeds $25,000 safety cap' });
    if (!req.body.destination) return res.status(400).json({ error: 'destination (liability account id) required' });

    // Ensure a source exists
    const list = await methodFetch('/accounts?holder_id=' + entityId);
    let source = (list.data || []).find(a => a.type === 'ach');
    if (!source) {
      const acct = await methodFetch('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          holder_id: entityId,
          ach: { routing: '021000021', number: '1122334455', type: 'checking' },
        }),
      });
      source = acct.data || acct;
      console.log('[method/pay] created source', source.id);
    }

    const payment = await methodFetch('/payments', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        source: source.id,
        destination: req.body.destination,
        description: 'SweepFi',
      }),
    });
    const p = payment.data || payment;
    console.log('[method/pay] payment', p.id, p.status);
    res.json({ ok: true, payment_id: p.id, status: p.status, amount_dollars: amount / 100, estimated_completion: p.estimated_completion_date || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List payments for the user's entity
app.post('/method/payments', async (req, res) => {
  try {
    const entityId = await methodEntityFor(req.body.user_id);
    if (!entityId) return res.status(400).json({ error: 'No Method entity' });
    const list = await methodFetch('/payments?holder_id=' + entityId);
    const payments = (list.data || []).map(p => ({
      id: p.id, status: p.status, amount: (p.amount || 0) / 100,
      destination: p.destination, created_at: p.created_at,
    }));
    res.json({ payments });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ── NET-WORTH-HISTORY ─────────────────────────────────────────────────────
async function snapshotNetWorth(userId) {
  const { data: tokens } = await supabase
    .from('plaid_tokens')
    .select('access_token')
    .eq('user_id', userId);
  if (!tokens || !tokens.length) throw new Error('No linked accounts');

  let assets = 0, debt = 0;
  for (const t of tokens) {
    try {
      const r = await plaid.accountsGet({ access_token: t.access_token });
      for (const a of r.data.accounts) {
        const bal = a.balances.current ?? a.balances.available ?? 0;
        if (a.type === 'credit') debt += bal;
        else assets += bal;
      }
    } catch (e) { console.log('[snapshot] token skip:', e.response?.data?.error_code || e.message); }
  }
  try {
    const man = await getManualAccounts(userId);
    man.forEach(m => {
      const bal = Number(m.balance) || 0;
      if (m.type === 'credit' || m.type === 'loan') debt += bal; else assets += bal;
    });
  } catch (e) {}
  const row = {
    user_id: userId,
    date: new Date().toISOString().split('T')[0],
    net_worth: Math.round((assets - debt) * 100) / 100,
    assets: Math.round(assets * 100) / 100,
    debt: Math.round(debt * 100) / 100,
  };
  const { error } = await supabase.from('net_worth_history').upsert(row, { onConflict: 'user_id,date' });
  if (error) throw new Error(error.message);
  console.log('[snapshot]', row.date, 'net:', row.net_worth);
  return row;
}

// Manual trigger (browser-friendly)
app.get('/snapshot', async (req, res) => {
  try {
    const row = await snapshotNetWorth(req.query.user_id);
    res.json(row);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// History for charts
app.post('/history', async (req, res) => {
  try {
    const days = Math.min(365, Number(req.body.days) || 90);
    const since = new Date(Date.now() - days * 864e5).toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('net_worth_history')
      .select('date, net_worth, assets, debt')
      .eq('user_id', req.body.user_id)
      .gte('date', since)
      .order('date', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ points: data || [] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


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


// ── GUARDRAILS ────────────────────────────────────────────────────────────
const railKey = (tx) => (tx.merchant_name || tx.name || 'unknown').toLowerCase().slice(0, 24);
const railCat = (tx) => (tx.personal_finance_category?.primary || tx.category?.[0] || 'Other').replace(/_/g, ' ').toLowerCase();

app.post('/guardrails', async (req, res) => {
  try {
    const { data: rails } = await supabase
      .from('guardrails')
      .select('target, kind, monthly_limit')
      .eq('user_id', req.body.user_id);
    if (!rails || !rails.length) return res.json({ rails: [] });

    const { data: tokens } = await supabase
      .from('plaid_tokens').select('access_token').eq('user_id', req.body.user_id);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];
    let txns = [];
    for (const t of (tokens || [])) {
      try {
        const r = await plaid.transactionsGet({
          access_token: t.access_token,
          start_date: monthStart, end_date: endDate,
          options: { count: 250 },
        });
        txns = txns.concat(r.data.transactions);
      } catch (e) {}
    }
    const outflows = txns.filter(tx => tx.amount > 0);

    const out = rails.map(rail => {
      const target = rail.target.toLowerCase();
      const spent = outflows
        .filter(tx => railKey(tx) === target || railCat(tx) === target)
        .reduce((s, t) => s + t.amount, 0);
      const spentR = Math.round(spent * 100) / 100;
      let status = 'ok';
      if (rail.kind === 'block') status = spentR > 0 ? 'violated' : 'clean';
      else if (rail.monthly_limit) {
        if (spentR > rail.monthly_limit) status = 'over';
        else if (spentR > rail.monthly_limit * 0.8) status = 'near';
      }
      return { ...rail, spent: spentR, status };
    });
    console.log('[guardrails]', out.length, 'rails for', req.body.user_id);
    res.json({ rails: out });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/guardrails/save', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.target || !req.body.kind) {
      return res.status(400).json({ error: 'user_id, target, kind required' });
    }
    const { error } = await supabase.from('guardrails').upsert({
      user_id: req.body.user_id,
      target: req.body.target.toLowerCase(),
      kind: req.body.kind,
      monthly_limit: req.body.kind === 'limit' ? (Number(req.body.monthly_limit) || null) : null,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,target' });
    if (error) throw new Error(error.message);
    console.log('[guardrails] saved', req.body.kind, req.body.target);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/guardrails/remove', async (req, res) => {
  try {
    const { error } = await supabase.from('guardrails')
      .delete()
      .eq('user_id', req.body.user_id)
      .eq('target', (req.body.target || '').toLowerCase());
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


// ── BILL-OVERRIDES endpoint ──────────────────────────────────────────────
app.post('/bills/override', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.name) return res.status(400).json({ error: 'user_id and name required' });
    // HIDE-BILLS: partial updates — only touch fields provided
    const row = {
      user_id: req.body.user_id,
      name: req.body.name.toLowerCase(),
    };
    if (req.body.amount != null) row.amount = Number(req.body.amount);
    if (req.body.due_day != null) row.due_day = Math.min(31, Math.max(1, Number(req.body.due_day)));
    if (req.body.hidden != null) row.hidden = req.body.hidden === true;
    if (req.body.display_name != null) row.display_name = String(req.body.display_name).trim(); // BILL-RENAME
    const { error } = await supabase.from('bill_overrides').upsert(row, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[bills] override saved:', row.name, row.amount, 'day', row.due_day);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


// ── MANUAL-ACCOUNTS ───────────────────────────────────────────────────────
async function getManualAccounts(userId) {
  const { data } = await supabase
    .from('manual_accounts')
    .select('name, type, balance, apr')
    .eq('user_id', userId);
  return data || [];
}

app.post('/manual-accounts/save', async (req, res) => {
  try {
    if (!req.body.user_id || !req.body.name || req.body.balance == null) {
      return res.status(400).json({ error: 'user_id, name, balance required' });
    }
    const { error } = await supabase.from('manual_accounts').upsert({
      user_id: req.body.user_id,
      name: req.body.name.trim(),
      type: ['credit', 'loan', 'cash', 'investment'].includes(req.body.type) ? req.body.type : 'credit',
      balance: Number(req.body.balance),
      apr: req.body.apr != null && req.body.apr !== '' ? Number(req.body.apr) : null,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,name' });
    if (error) throw new Error(error.message);
    console.log('[manual] saved', req.body.name, req.body.balance);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/manual-accounts/remove', async (req, res) => {
  try {
    const { error } = await supabase.from('manual_accounts')
      .delete()
      .eq('user_id', req.body.user_id)
      .eq('name', req.body.name);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3001, () => {
  console.log('\n✓ SweepFi server running on http://192.168.1.155:3001');
  console.log('✓ Plaid environment: sandbox');
  console.log('✓ Waiting for requests...\n');
});

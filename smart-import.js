// Run from Desktop/sweepfi-server:  node smart-import.js
// AI does the account matching too: semantic merge, multi-account issuers stay separate
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('SMART-IMPORT')) { console.log('Already patched.'); process.exit(0); }

// 1. aiParseReport takes the user's existing accounts and returns matches
code = SPLITJOIN(code, 'async function aiParseReport(text) {', 'async function aiParseReport(text, existing) { // SMART-IMPORT');
code = SPLITJOIN(code, "    max_tokens: 4000,", "    max_tokens: 8000,");

const oldPrompt = code.match(/content: 'Extract every debt tradeline[\s\S]*?String\(text\)\.slice\(0, 150000\),\n/);
if (!oldPrompt) { console.log('ERROR: prompt not found'); process.exit(1); }
const newPrompt = `content: 'You are matching a credit report against a user\\'s existing accounts. Existing accounts (JSON): ' + JSON.stringify((existing || []).slice(0, 60)) + '\\n\\nExtract every debt tradeline from the credit report text below (the text may be jumbled from copy-paste — reconstruct carefully). Return ONLY a compact JSON array, no markdown fences, no prose. Each item: {"name": creditor/account name as shown, "balance": current balance as a number, "payment": monthly or scheduled payment as a number or null, "type": "credit" (cards/revolving) | "loan" (installment/auto/student/mortgage/personal) | "collection" (collections or charge-offs), "matches": the name of the ONE existing account this tradeline is, copied EXACTLY from the existing list, or null}. Matching rules — use common sense: the same account is often named differently on a report vs the list (e.g. "APPLE CARD/GS BANK" is "Apple Card"); a similar balance is strong evidence of a match. The same issuer can have MULTIPLE different accounts (a card and an auto loan from the same bank are different accounts) — never merge different accounts, and when unsure set matches to null. Extraction rules: include EVERY open account with a balance above zero, including collections and charge-offs; skip zero-balance accounts, closed accounts, and inquiries. Report text:\\n\\n' + String(text).slice(0, 150000),
`;
code = code.replace(oldPrompt[0], newPrompt);

// matches survives the output mapping
const oldMapEnd = `    type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
  }));
}`;
const newMapEnd = `    type: ['credit', 'loan', 'collection'].includes(a.type) ? a.type : 'credit',
    matches: a.matches != null && String(a.matches).trim() ? String(a.matches).slice(0, 60).trim() : null,
  }));
}`;
if (!code.includes(oldMapEnd)) { console.log('ERROR: map end not found'); process.exit(1); }
code = SPLITJOIN(code, oldMapEnd, newMapEnd);

// 2. Route passes existing through
code = SPLITJOIN(code, "try { found = await aiParseReport(req.body.text); source = 'ai'; }",
                       "try { found = await aiParseReport(req.body.text, req.body.existing); source = 'ai'; }");

// 3. Confirm: trust the AI's match, exact-name second, no first-word guessing
const oldRows = `      payment: a.payment != null && a.payment !== '' ? Number(a.payment) : null,
    })).filter(r => r.name && r.balance > 0);`;
const newRows = `      payment: a.payment != null && a.payment !== '' ? Number(a.payment) : null,
      matches: a.matches != null && String(a.matches).trim() ? String(a.matches).slice(0, 60).trim() : null,
    })).filter(r => r.name && r.balance > 0);`;
if (!code.includes(oldRows)) { console.log('ERROR: confirm rows map not found'); process.exit(1); }
code = SPLITJOIN(code, oldRows, newRows);

const oldMatch = `        const match = exNames.find(n => n.toLowerCase() === r.name.toLowerCase())
          || exNames.find(n => keyOf(n).length >= 4 && keyOf(n) === keyOf(r.name));`;
const newMatch = `        const match = (r.matches && exNames.find(n => n.toLowerCase() === r.matches.toLowerCase()))
          || exNames.find(n => n.toLowerCase() === r.name.toLowerCase());`;
if (!code.includes(oldMatch)) { console.log('ERROR: match logic not found'); process.exit(1); }
code = SPLITJOIN(code, oldMatch, newMatch);

const oldIns = `          const { error } = await supabase.from('manual_accounts').insert(r);`;
const newIns = `          const { matches, ...ins } = r;
          const { error } = await supabase.from('manual_accounts').insert(ins);`;
if (!code.includes(oldIns)) { console.log('ERROR: insert line not found'); process.exit(1); }
code = SPLITJOIN(code, oldIns, newIns);

fs.writeFileSync('server.js', code);
console.log('Done! Smart matching live (SMART-IMPORT).');

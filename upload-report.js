// Run from Desktop/sweepfi-server:  node upload-report.js
// PDF upload for credit reports (pdf-parse) + bigger body limit
// REQUIRES: npm install pdf-parse --save   (the .bat does this)
const fs = require('fs');
const SPLITJOIN = (s, a, b) => s.split(a).join(b);
let code = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
if (code.includes('UPLOAD-REPORT')) { console.log('Already patched.'); process.exit(0); }

// 1. Raise the JSON body limit so big reports/PDFs fit
let limitFixed = false;
for (const [a, b] of [
  ["app.use(express.json())", "app.use(express.json({ limit: '15mb' }))"],
  ["app.use(express.json());", "app.use(express.json({ limit: '15mb' }));"],
  ["app.use(bodyParser.json())", "app.use(bodyParser.json({ limit: '15mb' }))"],
]) {
  if (code.includes(a) && !limitFixed) { code = SPLITJOIN(code, a, b); limitFixed = true; }
}
console.log(limitFixed ? 'Body limit raised to 15mb.' : '⚠ Could not find express.json() line — paste your server.js json middleware line to Claude.');

// 2. /import-report accepts file_b64 (PDF) as an alternative to text
const oldVal = `    if (!req.body.user_id || !req.body.text) return res.status(400).json({ error: 'user_id and text required' });`;
const newVal = `    if (!req.body.user_id || (!req.body.text && !req.body.file_b64)) return res.status(400).json({ error: 'user_id and text or file_b64 required' });
    let reportText = req.body.text; // UPLOAD-REPORT
    if (!reportText && req.body.file_b64) {
      const pdfParse = require('pdf-parse');
      const buf = Buffer.from(String(req.body.file_b64), 'base64');
      const parsed = await pdfParse(buf);
      reportText = parsed.text || '';
      console.log('[import-report] pdf extracted', reportText.length, 'chars,', parsed.numpages, 'pages');
      if (!reportText.trim()) return res.status(400).json({ error: 'Could not read text from this PDF — it may be a scanned image. Paste the text instead.' });
    }`;
if (!code.includes(oldVal)) { console.log('ERROR: import-report validation not found'); process.exit(1); }
code = SPLITJOIN(code, oldVal, newVal);

code = SPLITJOIN(code, "try { found = await aiParseReport(req.body.text, req.body.existing); source = 'ai'; }",
                       "try { found = await aiParseReport(reportText, req.body.existing); source = 'ai'; }");
code = SPLITJOIN(code, "if (!found.length) { found = parseCreditReport(req.body.text); source = 'regex'; }",
                       "if (!found.length) { found = parseCreditReport(reportText); source = 'regex'; }");

fs.writeFileSync('server.js', code);
console.log('Done! PDF upload live (UPLOAD-REPORT).');

#!/usr/bin/env node
// Reports the STRUCTURE of a Supabase connection string so a bad one can be diagnosed
// without anyone -- including a chat log or an issue -- ever seeing the password.
//
//   node --env-file=.env.local inspect-url.mjs SUPABASE_DB_URL_MY_PROJECT
//   npm run inspect SUPABASE_DB_URL_MY_PROJECT
//
// Prints host / port / username / database / password LENGTH / encoding validity, and flags
// the shapes that produce misleading errors: quote-wrapped values, a pasted `psql "..."`
// command, a BOM, and invalid percent-encoding.
//
// Structure being right does not prove the password is right -- follow up with
// `npm run keepalive:local` for a real connection test.
//
// Full guide: TROUBLESHOOTING.md
const varName = process.argv[2] || 'SUPABASE_DB_URL_TECHSILON_PROD'
const raw = process.env[varName] || ''
console.log('checking      :', varName)
if (!raw) { console.log('env var not set'); process.exit(1) }
if (/^["'“‘]|["'”’]$/.test(raw)) console.log('!! value is wrapped in quotes  <-- problem')
if (/^psql\s/i.test(raw)) console.log("!! value is a psql COMMAND, not a URI  <-- set Type to 'URI' in Supabase")
if (raw.charCodeAt(0) === 0xFEFF) console.log('!! value starts with a BOM  <-- problem')

console.log('raw length      :', raw.length)
console.log('leading/trailing whitespace:', raw !== raw.trim() ? 'YES  <-- problem' : 'no')

let u
try { u = new URL(raw) } catch (e) { console.log('URL PARSE FAILED:', e.message); process.exit(1) }

let pw, encOk = true, encMsg
try { pw = decodeURIComponent(u.password || '') }
catch { pw = null; encOk = false; encMsg = 'INVALID percent-encoding  <-- a literal % must be written %25' }
// Only these four actually break a Postgres URL. Everything else is safe unencoded.
const MUST_ENCODE = /[#/?%]/

console.log('protocol        :', u.protocol)
console.log('username        :', u.username)
console.log('host            :', u.hostname, '<-- must end in pooler.supabase.com')
console.log('port            :', u.port, '<-- expect 6543')
console.log('database        :', u.pathname)
if (!encOk) { console.log('password        :', encMsg); process.exit(1) }
console.log('password length :', pw.length, '(decoded)')
console.log('password encoding:', MUST_ENCODE.test(pw)
  ? 'contains # / ? or % — and they are correctly encoded  OK'
  : 'no characters that need encoding  OK')
console.log('password still literal placeholder :', /YOUR-PASSWORD/.test(pw) ? 'YES  <-- problem' : 'no')

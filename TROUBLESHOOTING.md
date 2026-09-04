# Troubleshooting

Everything here was learned the hard way on 2026-09-04, when the keepalive had been failing
for 18 days without anyone noticing. Read the [symptom table](#symptom-table) first — it maps
each error string straight to its cause.

## `inspect-url.mjs`

A connection string that is wrong produces an error that names neither the project nor the
problem. `inspect-url.mjs` takes a connection string apart and reports its **structure** —
host, port, username, database, password length, encoding — **without ever printing the
password**, so its output is safe to paste into a chat or an issue.

### Usage

```powershell
# 1. Put the connection string in .env.local (gitignored)
#    SUPABASE_DB_URL_MY_PROJECT=postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres

# 2. Inspect it — pass the variable name as the argument
node --env-file=.env.local inspect-url.mjs SUPABASE_DB_URL_MY_PROJECT
```

With no argument it defaults to `SUPABASE_DB_URL_TECHSILON_PROD`.

### Healthy output

```
checking      : SUPABASE_DB_URL_MY_PROJECT
raw length      : 111
leading/trailing whitespace: no
protocol        : postgresql:
username        : postgres.wavfrkcskjbgxdwxunjn
host            : aws-1-us-east-2.pooler.supabase.com <-- must end in pooler.supabase.com
port            : 6543 <-- expect 6543
database        : /postgres
password length : 16 (decoded)
password encoding: no characters that need encoding  OK
password still literal placeholder : no
```

Structure being right does **not** prove the password is right. Confirm for real with:

```powershell
node --env-file=.env.local keepalive.mjs
```

Projects not present in `.env.local` report `SKIP … is not set` — expected.

## Password encoding — the four characters

Only **four** characters must be percent-encoded in the password. Every other character is
safe as-is; encoding them unnecessarily will *break* the password.

| Character | Write as | If you don't |
|---|---|---|
| `#` | `%23` | `TypeError: Invalid URL` |
| `/` | `%2F` | `TypeError: Invalid URL` |
| `?` | `%3F` | `TypeError: Invalid URL` |
| `%` | `%25` | `URIError: URI malformed` |

**Confirmed safe unencoded** — do not touch these: `& $ @ : + = ! * ( ) , ; ~ - _ . ' " < > | ^ { } [ ]` and spaces.

Encode the password **only**. The `:` before it and the `@` after it are structural.

```
password  ab#cd/ef
becomes   postgresql://postgres.<ref>:ab%23cd%2Fef@aws-1-us-east-2.pooler.supabase.com:6543/postgres
```

## Symptom table

| Error | Cause | Fix |
|---|---|---|
| `password authentication failed for user "postgres"` | Wrong password, or an unencoded char silently mangled it | Check encoding above; confirm the ref in the URL matches the project's dashboard URL |
| `TypeError: Invalid URL` | Unencoded `#`, `/` or `?` in the password; or the value is a `psql "..."` command, quote-wrapped, or just the password with no URL | Set **Type: URI** in the Connect dialog; encode the password |
| `URIError: URI malformed` | A literal `%` in the password | Write it `%25` |
| `tenant/user postgres.<ref> not found` | The ref in the username is not a real project | Compare against `https://supabase.com/dashboard/project/<ref>` |
| `ENETUNREACH` / connection times out in Actions | Direct connection string used — it is IPv6-only, Actions is IPv4-only | Use the **Transaction pooler** string (`…pooler.supabase.com`) |
| `SKIP <label>: secret/env "…" is not set` | `projects.json` entry exists but the secret does not | Add the secret; **secrets before config** |
| Run shows **Action required**, zero jobs, no logs | GitHub's scanner flagged the workflow | See [Silent stoppages](#silent-stoppages) |

## IPv4 vs IPv6 — ignore the dashboard banner

The Supabase Connect dialog shows *"Transaction pooler uses IPv6 by default — Enable the
dedicated IPv4 address add-on."* **Do not buy the add-on.** It applies to the *direct*
connection only.

Verify for yourself:

```bash
nslookup -type=A    aws-1-us-east-2.pooler.supabase.com   # returns IPv4 addresses
nslookup -type=AAAA db.<ref>.supabase.co                  # direct connection: IPv6 only
```

Rule: host contains `pooler.supabase.com` → correct. Host is `db.<ref>.supabase.co` → wrong.

## Silent stoppages

This job is designed to be ignored, which means it can stop without anyone noticing. Two
mechanisms have caused that, both now fixed — but check them first if projects get paused:

1. **`toJSON(secrets)`** — bundling every secret into one variable reads as an exfiltration
   pattern to GitHub's workflow scanner. Runs are created but dispatch **zero jobs** and are
   marked `action_required`. No failure email, no logs. Fix: pass each secret explicitly in
   the workflow's `env:` block. Never reintroduce `toJSON(secrets)`.
2. **The heartbeat commit was coupled to the ping succeeding** — one bad credential failed
   the ping step, which skipped the heartbeat commit, which meant the repo went quiet and
   GitHub would have auto-disabled the schedule at 60 days. Fix: `if: always()`.

### Health check

```bash
# Last 10 runs — anything not "success" needs attention
gh run list --repo techsilon-apps/keepalive-functions --limit 10

# Why the most recent run failed
gh run view --repo techsilon-apps/keepalive-functions --log-failed

# Force a run now
gh workflow run keepalive.yml --repo techsilon-apps/keepalive-functions
```

In Supabase, confirm a project is actually being written to:

```sql
select * from keepalive.heartbeat order by ran_at desc limit 5;
```

### Are two projects secretly the same database?

If two entries point at the same database, both stay alive but one project is silently never
pinged. Tell from a single run's log: separate databases each report their **own** `#id` and
`heartbeats` count. Sequential ids across two labels (`#2`/`heartbeats=2` then
`#3`/`heartbeats=3`) mean one database, two names.

## Commands reference

```powershell
# Which secrets exist
gh secret list --repo techsilon-apps/keepalive-functions

# Add/update one (interactive — value never enters shell history, and PowerShell
# cannot mangle a `$` in it). Never pipe or double-quote the URL.
gh secret set SUPABASE_DB_URL_MY_PROJECT --repo techsilon-apps/keepalive-functions

# Inspect a connection string's structure (no password printed)
node --env-file=.env.local inspect-url.mjs SUPABASE_DB_URL_MY_PROJECT

# Real connection test against everything in .env.local
node --env-file=.env.local keepalive.mjs

# Install exactly what the lockfile pins
npm ci
```

> **PowerShell:** never wrap a connection string in double quotes — `$` expands and the
> password is silently corrupted, giving a misleading `password authentication failed`.
> Use single quotes, or paste at the `gh secret set` prompt.

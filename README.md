# keepalive-functions

Scheduled **read / write / delete** keepalive for free-tier Supabase projects — one repo
keeps *any number* of projects, across *any number* of Supabase accounts, from being
auto-paused after 7 days of inactivity.

## Why

Supabase pauses free-tier projects after ~7 days without activity. Activity is measured as
database/API traffic — **a deploy does not count**, only real queries/connections. This job
performs a genuine transaction cycle against each configured project every day, which
resets the inactivity timer.

## How it works

Per project, each run:

1. **Bootstraps** a dedicated `keepalive` schema + `keepalive.heartbeat` table
   (`CREATE ... IF NOT EXISTS`) — never touches product data, never collides with app
   migrations, works on any project regardless of its schema.
2. **WRITE** — inserts a heartbeat row.
3. **READ** — selects heartbeat count, plus optional row-counts from a few configured app
   tables (guarded: a missing table is harmless).
4. **DELETE** — prunes heartbeat rows older than 30 days (bounded table + rolling audit log).

Connection is direct Postgres over the **IPv4 pooler** string (`prepare:false` → transaction-pooler
safe). GitHub Actions is IPv4-only; Supabase "direct" is IPv6-only, so the pooler string is required.

A failure in one project — bad credential, unparseable URL, unreachable host — is contained to
that project. Every other project still gets pinged, and the run exits non-zero so the failure
is visible.

## Onboard a new project or account

Works for any Supabase project in any account — a Supabase account is **not** a GitHub
account, so this one repo can keep alive projects from all of your accounts.

Three edits, **in this order**. The order matters: a project listed in `projects.json` with no
matching secret counts as a *failure*, which fails the whole run.

### Step 1 — Get the project's IPv4 pooler connection string

1. Open the project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Click **Connect** (top bar).
3. Connection method **Transaction pooler**, Type **URI**. It looks like:
   ```
   postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-<n>-<region>.pooler.supabase.com:6543/postgres
   ```
   - ✅ Must contain `…pooler.supabase.com` — the **IPv4** path GitHub Actions needs.
   - ❌ Not **Direct connection** (`db.<ref>.supabase.co`) — IPv6-only, fails in Actions.
   - ⚠️ Ignore the *"Transaction pooler uses IPv6 by default"* banner and do **not** buy the
     IPv4 add-on. It applies to the direct connection only. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ipv4-vs-ipv6--ignore-the-dashboard-banner).
4. Replace `[YOUR-PASSWORD]` (brackets included) with the real database password, and
   **percent-encode `#` `/` `?` `%` if the password contains them** — see
   [the four characters](TROUBLESHOOTING.md#password-encoding--the-four-characters).
   Every other character is safe as-is.
5. Verify before going further:
   ```powershell
   # put it in .env.local first (gitignored)
   node --env-file=.env.local inspect-url.mjs SUPABASE_DB_URL_MY_PROJECT   # structure
   node --env-file=.env.local keepalive.mjs                                # real connection
   ```

### Step 2 — Add the secret

```powershell
gh secret set SUPABASE_DB_URL_MY_PROJECT --repo techsilon-apps/keepalive-functions
```

Paste at the prompt — the value never enters shell history and PowerShell cannot mangle a `$`
in it. **Never pipe it or wrap it in double quotes.** Convention: `SUPABASE_DB_URL_<PROJECT>`,
uppercase.

Or via the web UI: repo → **Settings → Secrets and variables → Actions → New repository secret**.

### Step 3 — Pass the secret to the job

Add one line to the `env:` block of the *Ping all projects* step in
`.github/workflows/keepalive.yml`:

```yaml
SUPABASE_DB_URL_MY_PROJECT: ${{ secrets.SUPABASE_DB_URL_MY_PROJECT }}
```

> **Do not** replace these explicit lines with `SECRETS_JSON: ${{ toJSON(secrets) }}`. It makes
> onboarding config-only, but GitHub's workflow scanner reads it as a possible exfiltration
> pattern and silently blocks the run — no jobs, no logs, no email. That took the keepalive
> down for three days. The comment in the workflow says the same thing; leave it there.

### Step 4 — Register it in `projects.json`

```json
{
  "label": "my-project",
  "envVar": "SUPABASE_DB_URL_MY_PROJECT",
  "sampleTables": []
}
```

- **`label`** — any human name for logs (e.g. `sideproject-prod`).
- **`envVar`** — must match the secret name from Step 2 exactly.
- **`sampleTables`** — *optional*. Schema-qualified tables to also read a row-count from each
  run (e.g. `"public.profiles"`). Leave `[]` if unsure — the heartbeat table's own
  write/read/delete is enough to count as activity. Missing tables are harmless (guarded), and
  names that aren't plain identifiers are rejected rather than executed.
  **On a public repo these counts appear in world-readable Actions logs** — leave `[]` for
  anything business-sensitive.
- Optional: add `"enabled": false` to park a project without deleting its block.

### Step 5 — Verify

Push, then Actions tab → *supabase-keepalive* → **Run workflow**, or:

```bash
gh workflow run keepalive.yml --repo techsilon-apps/keepalive-functions
```

The log should show `OK my-project: wrote #… heartbeats=… …` and the run should conclude
**success**.

## Schedule

`.github/workflows/keepalive.yml` runs daily (`cron: '17 6 * * *'`) + manual
**Run workflow** button. Daily keeps a comfortable margin under the 7-day threshold even
if a scheduled run is delayed or dropped. A tiny heartbeat commit each run keeps the repo
active so GitHub never auto-disables the schedule (its 60-day-inactivity rule for public
repos). That step runs `if: always()` — it must not be switched off by a failing ping.

**Public repo** is recommended (unlimited Actions minutes; private-repo minutes are drawn from
an allowance shared across the whole org). The repo holds no secrets. Two rules:

- Triggers stay `schedule` + `workflow_dispatch` — **never** `pull_request`, so forked PRs
  can't reach the secrets.
- Actions logs are world-readable, so keep `sampleTables` empty for sensitive tables.

## Test it

- **Manually:** Actions tab → *supabase-keepalive* → **Run workflow**. Check the log for
  `OK <project>: wrote #… heartbeats=… pruned=… samples=…`.
- **Locally:** copy `.env.example` → `.env.local`, fill in the pooler URLs, then
  `npm run keepalive:local`.
- **Verify in Supabase:** `select * from keepalive.heartbeat order by ran_at desc limit 5;`

## When something breaks

See **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — symptom-to-cause table, the password
encoding rules, the IPv4/IPv6 question, and the two ways this job has stopped silently.

## Registered projects

See [`projects.json`](projects.json) — it is the single source of truth. Confirm the matching
secrets exist with `gh secret list --repo techsilon-apps/keepalive-functions`.

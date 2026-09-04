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

## Onboard a new project or account

Works for any Supabase project in any account — a Supabase account is **not** a GitHub
account, so this one repo can keep alive projects from all of your accounts. Onboarding is
config + one secret; **no workflow edit is ever needed** (all secrets reach the job via
`toJSON(secrets)`, masked in logs).

> **Do the secret (Step 3) before the config (Step 1).** A project listed in `projects.json`
> with no matching secret counts as a *failure*, which fails the whole run — and a failed run
> also skips the heartbeat commit.

### Step 1 — Register it in `projects.json`

Copy an existing block, paste it into the `projects` array, and update the fields:

```json
{
  "label": "my-project",
  "envVar": "SUPABASE_DB_URL_MY_PROJECT",
  "sampleTables": []
}
```

- **`label`** — any human name for logs (e.g. `sideproject-prod`).
- **`envVar`** — the exact name of the GitHub secret you'll create in Step 3. Convention:
  `SUPABASE_DB_URL_<PROJECT>`, uppercase, no spaces.
- **`sampleTables`** — *optional*. Schema-qualified tables to also read a row-count from each
  run (e.g. `"public.profiles"`, `"pulsilon.checks"`). Leave `[]` if unsure — the heartbeat
  table's own write/read/delete is enough to count as activity. Missing tables are harmless
  (guarded), so nothing breaks if a name is wrong.
- Optional: add `"enabled": false` to park a project without deleting its block.

### Step 2 — Get that project's IPv4 pooler connection string

1. Open the project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Click **Connect** (top bar).
3. Under **Connection string**, choose the **Transaction pooler** tab (Session pooler also
   works — both are IPv4). It looks like:
   ```
   postgres://postgres.<ref>:[YOUR-PASSWORD]@aws-<n>-<region>.pooler.supabase.com:6543/postgres
   ```
   - ✅ Must contain `…pooler.supabase.com` — that is the **IPv4** path GitHub Actions needs.
   - ❌ Do **not** use **Direct connection** (`db.<ref>.supabase.co`) — it is IPv6-only and
     fails in Actions.
4. Replace `[YOUR-PASSWORD]` with the project's real database password. If you don't have it:
   **Settings → Database → Database password → Reset database password** generates a new one
   (safe to reset as long as nothing live is currently using the old password).

### Step 3 — Add the secret (named exactly the `envVar`)

Easiest via the web UI (keeps the value out of shell history):

> repo → **Settings → Secrets and variables → Actions → New repository secret** →
> name = the `envVar` from Step 1, value = the full pooler URL from Step 2.

Or via CLI:

```bash
echo "postgres://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres" \
  | gh secret set SUPABASE_DB_URL_MY_PROJECT --repo <owner>/keepalive-functions
```

### Step 4 — Verify

Commit/push the `projects.json` change, then Actions tab → *supabase-keepalive* →
**Run workflow**. The log should show `OK my-project: wrote #… heartbeats=… …`.

## Schedule

`.github/workflows/keepalive.yml` runs daily (`cron: '17 6 * * *'`) + manual
**Run workflow** button. Daily keeps a comfortable margin under the 7-day threshold even
if a scheduled run is delayed or dropped. A tiny heartbeat commit each run keeps the repo
active so GitHub never auto-disables the schedule (its 60-day-inactivity rule).

**Public repo** is recommended (unlimited Actions minutes; the repo holds no secrets). The
only rule: triggers stay `schedule` + `workflow_dispatch` — **never** `pull_request`, so
forked PRs can't reach the secrets.

## Test it

- **Manually:** Actions tab → *supabase-keepalive* → **Run workflow**. Check the log for
  `OK <project>: wrote #… heartbeats=… pruned=… samples=…`.
- **Locally:** copy `.env.example` → `.env`, fill the pooler URLs, then `pnpm keepalive:local`.
- **Verify in Supabase:** `select * from keepalive.heartbeat order by ran_at desc limit 5;`

## Currently registered

| Project | Secret |
|---|---|
| `techsilon-dev` | `SUPABASE_DB_URL_TECHSILON_DEV` |
| `techsilon-prod` | `SUPABASE_DB_URL_TECHSILON_PROD` |
| `natnlab-dev` | `SUPABASE_DB_URL_NATNLAB_DEV` |
| `natnlab-prod` | `SUPABASE_DB_URL_NATNLAB_PROD` |

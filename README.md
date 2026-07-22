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

## Onboard a project (2 steps, no workflow edit)

1. Add an entry to [`projects.json`](./projects.json):
   ```json
   { "label": "my-project", "envVar": "SUPABASE_DB_URL_MY_PROJECT", "sampleTables": [] }
   ```
2. Add a repo secret named exactly that `envVar`, holding the project's **Transaction pooler**
   connection string (Supabase → Project → Connect → Transaction pooler):
   ```bash
   gh secret set SUPABASE_DB_URL_MY_PROJECT --repo <owner>/keepalive-functions
   ```

All secrets reach the job via `toJSON(secrets)` (masked in logs), so no new project needs a
workflow change. `sampleTables` are optional and schema-qualified (e.g. `pulsilon.checks`).
Set `"enabled": false` to park a project without removing it.

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

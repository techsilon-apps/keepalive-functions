#!/usr/bin/env node
// Supabase free-tier keepalive: a genuine read/write/delete cycle per project,
// run on a schedule so each project stays "active" and is never auto-paused.
//
// Design notes:
//   * Uses a dedicated `keepalive` schema + `heartbeat` table so it NEVER touches
//     product data and NEVER collides with an app's real migrations. Self-bootstraps
//     (CREATE ... IF NOT EXISTS), so onboarding a project = add a secret + a config row.
//   * Direct Postgres over the IPv4 pooler connection string (GitHub Actions is IPv4-only;
//     Supabase "direct" is IPv6-only). `prepare:false` makes it transaction-pooler safe.
//   * Config (projects.json) carries NO secrets. Each project names an env var / secret
//     that holds its connection string. In CI each one is passed explicitly in the workflow's
//     `env:` block -- deliberately NOT `toJSON(secrets)`, which GitHub's workflow scanner
//     flags as a possible secret-exfiltration pattern and then silently blocks the run.
//   * One failed project does not abort the others -- including a malformed connection URL,
//     which must not take down projects that would otherwise be pinged. The process exits
//     non-zero if any project failed.

import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const RETAIN_DAYS = 30
const SCHEMA = 'keepalive'

const cfg = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url)))
// Secrets arrive as ordinary env vars: from the workflow's `env:` block in CI, or from
// `node --env-file=.env.local keepalive.mjs` locally. Same code path either way.
const resolve = (name) => process.env[name] || ''

// A schema-qualified table name we are willing to interpolate into SQL. Config is
// maintainer-edited so this is not an injection boundary, but a typo containing a `;`
// would otherwise execute as a second statement and be swallowed by the guard below.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/

const runId = process.env.GITHUB_RUN_ID || 'local'
let failures = 0

for (const p of cfg.projects ?? []) {
  if (p.enabled === false) {
    console.log(`SKIP ${p.label}: disabled in projects.json`)
    continue
  }
  const url = resolve(p.envVar)
  if (!url) {
    console.error(`SKIP ${p.label}: secret/env "${p.envVar}" is not set`)
    failures++
    continue
  }

  // NOTE: constructed inside the try. postgres() throws synchronously on an unparseable
  // URL (e.g. an unencoded `#`, `/`, `?` or `%` in the password), and an uncaught throw
  // here would abort the whole run and leave every remaining project unpinged.
  let sql
  try {
    sql = postgres(url, {
      max: 1,
      prepare: false, // required for Supabase transaction pooler (port 6543)
      ssl: 'require',
      idle_timeout: 5,
      connect_timeout: 15,
    })
    // --- bootstrap (idempotent) ---
    await sql.unsafe(`create schema if not exists ${SCHEMA}`)
    await sql.unsafe(`create table if not exists ${SCHEMA}.heartbeat (
      id bigserial primary key,
      ran_at timestamptz not null default now(),
      source text not null default 'github-actions',
      detail jsonb not null default '{}'::jsonb
    )`)

    // --- WRITE ---
    const [row] = await sql`
      insert into keepalive.heartbeat (source, detail)
      values ('github-actions', ${sql.json({ project: p.label, runId })})
      returning id, ran_at`

    // --- READ (self) ---
    const [{ count: heartbeats }] = await sql`
      select count(*)::int as count from keepalive.heartbeat`

    // --- READ (sample app tables, guarded — a missing table never fails the run) ---
    const samples = {}
    for (const t of p.sampleTables ?? []) {
      if (!SAFE_IDENT.test(t)) {
        samples[t] = 'err:invalid-identifier'
        continue
      }
      try {
        const [{ count }] = await sql.unsafe(`select count(*)::int as count from ${t}`)
        samples[t] = count
      } catch (e) {
        samples[t] = `err:${e.code || e.message}`
      }
    }

    // --- DELETE (prune, keeps the table bounded + a rolling audit trail) ---
    const pruned = await sql`
      delete from keepalive.heartbeat
      where ran_at < now() - make_interval(days => ${RETAIN_DAYS})`

    console.log(
      `OK ${p.label}: wrote #${row.id} @ ${row.ran_at.toISOString()}; ` +
        `heartbeats=${heartbeats}; pruned=${pruned.count}; samples=${JSON.stringify(samples)}`,
    )
  } catch (e) {
    console.error(`FAIL ${p.label}: ${e.message}`)
    failures++
  } finally {
    if (sql) await sql.end({ timeout: 5 })
  }
}

if (failures > 0) {
  console.error(`\nkeepalive finished with ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nkeepalive complete — all projects pinged')

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
//     that holds its connection string. In CI those arrive via SECRETS_JSON (toJSON(secrets)).
//   * One failed project does not abort the others; the process exits non-zero if any failed.

import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const RETAIN_DAYS = 30
const SCHEMA = 'keepalive'

const cfg = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url)))
// In CI all repo secrets arrive as one JSON blob (masked in logs by GitHub); locally
// fall back to plain process.env (e.g. `node --env-file=.env keepalive.mjs`).
const secrets = JSON.parse(process.env.SECRETS_JSON || '{}')
const resolve = (name) => secrets[name] || process.env[name] || ''

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

  const sql = postgres(url, {
    max: 1,
    prepare: false, // required for Supabase transaction pooler (port 6543)
    ssl: 'require',
    idle_timeout: 5,
    connect_timeout: 15,
  })

  try {
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
    await sql.end({ timeout: 5 })
  }
}

if (failures > 0) {
  console.error(`\nkeepalive finished with ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nkeepalive complete — all projects pinged')

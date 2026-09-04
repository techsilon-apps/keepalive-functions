#!/usr/bin/env node
// Offline conformance check. `npm run check` -- must pass before every commit.
//
// This repo has no unit tests: its real behaviour is "can it reach six databases",
// which cannot be asserted without live credentials. What CAN be asserted offline is
// that the three layers stay consistent (projects.json <-> workflow env <-> code) and
// that the changes which previously took the keepalive down silently do not return.
//
// Live verification is a separate, deliberate step: `npm run keepalive:local`.

import { readFileSync, existsSync } from 'node:fs'

let failed = 0
const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m) => { console.error(`  FAIL  ${m}`); failed++ }

// --- files present --------------------------------------------------------
for (const f of ['keepalive.mjs', 'inspect-url.mjs', 'scripts/check.mjs', 'TROUBLESHOOTING.md']) {
  if (existsSync(f)) ok(`${f} present`)
  else bad(`${f} missing`)
}

// --- config parses --------------------------------------------------------
let cfg
try {
  cfg = JSON.parse(readFileSync('projects.json', 'utf8'))
  ok(`projects.json parses (${cfg.projects.length} projects)`)
} catch (e) {
  bad(`projects.json does not parse: ${e.message}`)
  process.exit(1)
}

// --- every project entry is well formed -----------------------------------
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/
const labels = new Set()
let entryProblems = 0
for (const p of cfg.projects) {
  if (!p.label || !p.envVar) { bad(`project entry missing label/envVar: ${JSON.stringify(p)}`); entryProblems++; continue }
  if (labels.has(p.label)) { bad(`duplicate label "${p.label}"`); entryProblems++ }
  labels.add(p.label)
  if (!/^SUPABASE_DB_URL_[A-Z0-9_]+$/.test(p.envVar)) {
    bad(`${p.label}: envVar "${p.envVar}" breaks the SUPABASE_DB_URL_<PROJECT> convention`)
    entryProblems++
  }
  for (const t of p.sampleTables ?? []) {
    if (!SAFE_IDENT.test(t)) {
      bad(`${p.label}: sampleTable "${t}" is not a plain schema.table identifier`)
      entryProblems++
    }
  }
}
if (!entryProblems) ok('every project entry is well formed')

// --- workflow -------------------------------------------------------------
const wf = readFileSync('.github/workflows/keepalive.yml', 'utf8')
// Comment lines deliberately mention `pull_request` and `toJSON(secrets)` in order to
// warn against them. Test the actual YAML, not the prose about it.
const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

// Regression guard: bundling all secrets made GitHub's scanner block the run,
// dispatching zero jobs with no logs and no email. See TROUBLESHOOTING.md.
if (/\btoJSON\(\s*secrets\s*\)/.test(wfCode)) bad('workflow uses toJSON(secrets) -- this silently blocks runs; pass each secret explicitly')
else ok('workflow does not bundle secrets via toJSON(secrets)')

// Regression guard: without always(), one bad credential also disables the commit
// that stops GitHub auto-disabling the schedule at 60 days.
if (/if:\s*always\(\)/.test(wfCode)) ok('heartbeat step keeps `if: always()`')
else bad('heartbeat step lost `if: always()` -- a failing ping would disable the schedule protection')

if (/^\s*pull_request\s*:/m.test(wfCode)) bad('workflow has a pull_request trigger -- forked PRs could reach the secrets')
else ok('no pull_request trigger')

if (/npm ci/.test(wfCode)) ok('workflow uses npm ci')
else bad('workflow should use `npm ci`, not `npm install`')

// Regression guards: a failure here is silent by default. Both notification paths
// must survive future edits, or the job goes back to failing unnoticed for weeks.
if (/if:\s*failure\(\)/.test(wfCode)) ok('workflow notifies on failure')
else bad('workflow lost its `if: failure()` notification step -- failures would go unnoticed')

if (/issues:\s*write/.test(wfCode)) ok('workflow can open the failure issue (issues: write)')
else bad('workflow lacks `issues: write` -- the failure notification cannot open an issue')

if (/HEALTHCHECK_PING_URL/.test(wfCode)) ok('dead-man\'s-switch ping step present')
else bad('workflow lost the dead-man\'s-switch ping -- a run that never dispatches would go unnoticed')

// --- config and workflow agree --------------------------------------------
for (const p of cfg.projects) {
  if (wfCode.includes(`${p.envVar}:`)) ok(`${p.label}: workflow passes ${p.envVar}`)
  else bad(`${p.label}: ${p.envVar} is in projects.json but NOT in the workflow env block -- it would report "not set" and fail the run`)
}

// --- secrets must never be committable ------------------------------------
const gi = readFileSync('.gitignore', 'utf8')
if (/^\.env\.\*$/m.test(gi) && /^\.env$/m.test(gi)) ok('.gitignore covers .env and .env.*')
else bad('.gitignore must ignore .env and .env.* (connection strings live there)')

if (/^!\.env\.example$/m.test(gi)) ok('.env.example stays tracked')
else bad('.gitignore should un-ignore .env.example')

// --- lockfile is committed -------------------------------------------------
if (existsSync('package-lock.json')) ok('package-lock.json present (npm ci is reproducible)')
else bad('package-lock.json missing -- npm ci would fail and deps would float')

console.log()
if (failed) {
  console.error(`check FAILED with ${failed} problem(s)`)
  process.exit(1)
}
console.log('check passed')

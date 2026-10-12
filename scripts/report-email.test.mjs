// Unit tests for the daily keepalive email renderer. `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, mergeResults, safeUntil, humanMs } from './report-email.mjs'

const projects = ['a-dev', 'b-prod'].map((label) => ({ label }))
const at = '2026-10-13T06:19:04.000Z'
const ok = (label) => ({ label, outcome: 'ok', heartbeatId: '7', ranAt: at, heartbeats: 3, pruned: 0, ms: 420 })
const now = new Date('2026-10-13T06:20:00Z')

test('normal day says so plainly and names the pause date', () => {
  const r = buildReport({ rows: mergeResults(projects, [ok('a-dev'), ok('b-prod')]), pingResult: 'success', now })
  assert.equal(r.healthy, true)
  assert.equal(r.subject, '✅ Supabase keepalive OK: 2/2 active (2026-10-13)')
  assert.match(r.html, /Normal day: nothing needs your attention/)
  assert.match(r.text, /none can pause before Oct 20/)
  assert.match(r.html, /a-dev/)
  assert.match(r.html, /b-prod/)
})

test('a failed project turns the email red and shows its error', () => {
  const rows = mergeResults(projects, [ok('a-dev'), { label: 'b-prod', outcome: 'failed', error: 'password authentication failed' }])
  const r = buildReport({ rows, pingResult: 'failure', now })
  assert.equal(r.healthy, false)
  assert.equal(r.subject, '❌ Supabase keepalive FAILED: 1/2 not pinged (2026-10-13)')
  assert.match(r.html, /password authentication failed/)
  assert.match(r.html, /What to do/)
})

test('a project missing from the results appears as "no result", not silently dropped', () => {
  const rows = mergeResults(projects, [ok('a-dev')])
  assert.deepEqual(rows[1], { label: 'b-prod', outcome: 'no result' })
  const r = buildReport({ rows, pingResult: 'success', now })
  assert.equal(r.healthy, false)
  assert.match(r.html, /No result/)
})

test('no results at all is reported as a failed run', () => {
  const r = buildReport({ rows: mergeResults(projects, []), pingResult: 'failure', now })
  assert.equal(r.healthy, false)
  assert.match(r.html, /did not report any results/)
})

test('heartbeat-commit failure is a warning, not a project failure', () => {
  const r = buildReport({ rows: mergeResults(projects, [ok('a-dev'), ok('b-prod')]), pingResult: 'success', heartbeatResult: 'failure', now })
  assert.equal(r.healthy, false)
  assert.match(r.subject, /^⚠️ .*repo heartbeat failed/)
})

test('disabled projects are shown but do not count against health', () => {
  const rows = mergeResults([...projects, { label: 'c-old' }], [ok('a-dev'), ok('b-prod'), { label: 'c-old', outcome: 'disabled' }])
  const r = buildReport({ rows, pingResult: 'success', now })
  assert.equal(r.healthy, true)
  assert.match(r.subject, /2\/2/)
  assert.match(r.html, /Disabled/)
})

test('project labels and errors are HTML-escaped', () => {
  const rows = [{ label: '<b>x</b>', outcome: 'failed', error: '<script>' }]
  const r = buildReport({ rows, pingResult: 'failure', now })
  assert.doesNotMatch(r.html, /<script>|<b>x<\/b>/)
})

test('helpers', () => {
  assert.equal(safeUntil('2026-12-28T10:00:00Z'), 'Jan 4')
  assert.equal(safeUntil('nope'), '—')
  assert.equal(humanMs(420), '420ms')
  assert.equal(humanMs(1530), '1.5s')
  assert.equal(humanMs(undefined), '—')
})

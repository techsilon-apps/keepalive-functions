#!/usr/bin/env node
// Renders the daily keepalive email (subject, HTML, plain text) in TechSilon branding.
//
// Called by the last step of keepalive.yml, which then POSTs the payload to Resend.
// Dependency-free (Node built-ins only).
//
// Layout and BRAND tokens are copied from techsilon-ops/supabase-db-backups
// scripts/report-email.mjs so both operations emails look the same. Keep them in step;
// a shared notifier is on that repo's roadmap once a third sender appears.
//   - palette mirrors techsilon-website brand/README.md (--ts-nav / --ts-cta / --ts-page-bg)
//   - logo: `techsilon-monogram-light` = WHITE ink on transparent, for the navy header.
//     `f-png` keeps the transparency (ImageKit otherwise auto-converts to JPEG).
//
// Usage (CI):   node scripts/report-email.mjs > "$RUNNER_TEMP/email.json"
// Preview:      node scripts/report-email.mjs --preview <dir>   (writes sample .html files)

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BRAND = {
  nav: '#003260',
  cta: '#0068B5',
  pageBg: '#F2F5F9',
  text: '#111827',
  textMuted: '#6B7280',
  border: '#E5E7EB',
  ok: '#15803D',
  okBg: '#ECFDF3',
  bad: '#B91C1C',
  badBg: '#FEF2F2',
  warn: '#B45309',
  warnBg: '#FFFBEB',
  logo: 'https://ik.imagekit.io/f9grhllxb/Logos/techsilon-monogram-light.png?tr=w-112,h-112,f-png',
  font: "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', Consolas, 'SFMono-Regular', Menlo, monospace",
}

// Supabase pauses a free-tier project after 7 days without activity.
export const PAUSE_DAYS = 7

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Oct 19" for a date PAUSE_DAYS after `iso`, or '—'. UTC, so it never shifts with the reader. */
export function safeUntil(iso) {
  const t = Date.parse(iso ?? '')
  if (Number.isNaN(t)) return '—'
  const d = new Date(t + PAUSE_DAYS * 86400e3)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

export function humanMs(ms) {
  if (!/^\d+$/.test(String(ms ?? ''))) return '—'
  const n = Number(ms)
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

/**
 * Merge the projects projects.json EXPECTED with what keepalive.mjs REPORTED, so a project
 * the script never reached (crash, missing results file) shows as "no result" instead of
 * silently vanishing from the email.
 */
export function mergeResults(projects, results) {
  const expected = (projects ?? []).map((p) => p.label)
  const byLabel = new Map((results ?? []).map((r) => [r.label, r]))
  const rows = expected.map((label) => byLabel.get(label) ?? { label, outcome: 'no result' })
  for (const r of results ?? []) if (!expected.includes(r.label)) rows.push(r)
  return rows
}

/** Pure: everything the email says is decided here, so it can be tested without a network. */
export function buildReport({ rows, pingResult, heartbeatResult = 'success', event = 'schedule',
  runUrl = '', repo = '', now = new Date() }) {
  const active = rows.filter((r) => r.outcome !== 'disabled')
  const disabled = rows.length - active.length
  const total = active.length
  const ok = active.filter((r) => r.outcome === 'ok').length
  const projectsOk = pingResult === 'success' && total > 0 && ok === total
  const repoOk = heartbeatResult === 'success' || heartbeatResult === 'skipped'
  const healthy = projectsOk && repoOk
  const date = now.toISOString().slice(0, 10)
  const time = now.toISOString().slice(11, 16)
  const pruned = active.reduce((n, r) => n + (Number.isInteger(r.pruned) ? r.pruned : 0), 0)
  const okRows = active.filter((r) => r.outcome === 'ok')
  const earliestSafe = okRows.length ? safeUntil(okRows.map((r) => r.ranAt).sort()[0]) : '—'

  let headline, detail
  if (healthy) {
    headline = 'Normal day: nothing needs your attention'
    detail = `All ${total} Supabase project${total === 1 ? ' was' : 's were'} pinged with a real write, read and cleanup. `
      + `Each one's ${PAUSE_DAYS}-day inactivity clock has restarted, so none can pause before ${earliestSafe}.`
  } else if (total === 0 || rows.every((r) => r.outcome === 'no result')) {
    headline = 'Keepalive did not report any results'
    detail = `The job ran but no project result was recorded (ping step: ${pingResult || 'unknown'}). Treat every project as NOT pinged today.`
  } else if (!projectsOk) {
    headline = `${total - ok} of ${total} project${total === 1 ? '' : 's'} NOT kept alive`
    detail = `The others were pinged and are safe. A project that keeps failing pauses ${PAUSE_DAYS} days after its last successful ping, so fix this within days.`
  } else {
    headline = 'Projects OK, but the repo heartbeat commit failed'
    detail = 'Every project was pinged. The commit that keeps GitHub from auto-disabling this schedule after 60 days did not land. Not urgent today, but it must not keep failing.'
  }

  const subject = healthy
    ? `✅ Supabase keepalive OK: ${ok}/${total} active (${date})`
    : projectsOk
      ? `⚠️ Supabase keepalive: projects OK, repo heartbeat failed (${date})`
      : `❌ Supabase keepalive FAILED: ${total - ok}/${total} not pinged (${date})`
  const preheader = healthy
    ? `Normal day. ${ok}/${total} projects pinged; none can pause before ${earliestSafe}.`
    : `${headline}. Action needed.`
  const trigger = event === 'schedule' ? 'Scheduled (daily 06:17 UTC)' : 'Manual run'
  const tone = healthy ? [BRAND.ok, BRAND.okBg] : projectsOk ? [BRAND.warn, BRAND.warnBg] : [BRAND.bad, BRAND.badBg]

  const statusPill = (r) => {
    const map = { ok: ['Kept alive', BRAND.ok, BRAND.okBg], disabled: ['Disabled', BRAND.textMuted, BRAND.pageBg] }
    const [label, fg, bg] = map[r.outcome] ?? [r.outcome === 'no result' ? 'No result' : 'Failed', BRAND.bad, BRAND.badBg]
    return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;`
      + `color:${fg};background:${bg}">${esc(label)}</span>`
  }
  const subline = (r) => r.outcome === 'ok'
    ? `heartbeat #${esc(r.heartbeatId)} · ${esc(r.heartbeats)} on record${r.pruned ? ` · ${esc(r.pruned)} old pruned` : ''}`
    : r.outcome === 'disabled' ? 'parked in projects.json'
      : esc(r.error || 'no result recorded for this project')

  const td = `padding:12px 16px;border-top:1px solid ${BRAND.border};font-size:14px;color:${BRAND.text};vertical-align:top`
  const tableRows = rows.map((r) => `
          <tr>
            <td style="${td}">
              <div style="font-weight:600">${esc(r.label)}</div>
              <div style="font-family:${BRAND.mono};font-size:11px;color:${r.outcome === 'ok' || r.outcome === 'disabled' ? BRAND.textMuted : BRAND.bad};padding-top:3px;word-break:break-word">${subline(r)}</div>
            </td>
            <td style="${td};white-space:nowrap">${statusPill(r)}</td>
            <td style="${td};white-space:nowrap;text-align:right">${r.outcome === 'ok' ? esc(safeUntil(r.ranAt)) : '—'}</td>
            <td style="${td};white-space:nowrap;text-align:right">${esc(humanMs(r.ms))}</td>
          </tr>`).join('')

  const kpi = (label, value) => `
            <td width="33%" style="padding:16px;text-align:center;border:1px solid ${BRAND.border};border-radius:8px;background:#FFFFFF">
              <div style="font-size:22px;font-weight:700;color:${BRAND.nav}">${esc(value)}</div>
              <div style="font-size:12px;color:${BRAND.textMuted};padding-top:4px">${esc(label)}</div>
            </td>`

  const actions = healthy ? '' : `
      <tr><td style="padding:0 32px 8px">
        <div style="font-size:15px;font-weight:700;color:${BRAND.text};padding-bottom:8px">What to do</div>
        <ol style="margin:0;padding-left:20px;font-size:14px;line-height:22px;color:${BRAND.text}">
          <li>Open the run and read the <strong>FAIL</strong> line for each red project above. The error names its cause.</li>
          <li>Match it in <strong>TROUBLESHOOTING.md</strong> (symptom table). Most are a wrong or badly encoded connection string.</li>
          <li>After fixing, re-run from <strong>Actions → supabase-keepalive → Run workflow</strong>.</li>
        </ol>
      </td></tr>`

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};font-family:${BRAND.font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg}">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid ${BRAND.border}">
    <tr><td style="background:${BRAND.nav};padding:14px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="56" style="width:56px"><img src="${esc(BRAND.logo)}" width="56" height="56" alt="TechSilon" style="display:block;width:56px;height:56px;border:0"></td>
        <td style="padding-left:8px">
          <div style="font-size:20px;font-weight:800;letter-spacing:0.5px;color:#FFFFFF">TechSilon</div>
          <div style="font-size:12px;color:#C7D7E8">Operations</div>
        </td>
        <td align="right" style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;color:#C7D7E8">Keepalive Report</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 8px">
      <div style="font-size:13px;color:${BRAND.textMuted}">Supabase keepalive · ${esc(date)}</div>
      <div style="margin-top:12px;padding:16px 18px;border-radius:8px;border-left:4px solid ${tone[0]};background:${tone[1]}">
        <div style="font-size:20px;font-weight:700;color:${tone[0]}">${healthy ? '✓' : '!'}&nbsp; ${esc(headline)}</div>
        <div style="font-size:14px;color:${BRAND.text};padding-top:6px;line-height:20px">${esc(detail)}</div>
      </div>
    </td></tr>
    <tr><td style="padding:16px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate"><tr>
        ${kpi('Projects kept alive', `${ok}/${total}`)}
        ${kpi('Earliest possible pause', earliestSafe)}
        ${kpi('Finished (UTC)', time)}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 32px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;border-collapse:separate;overflow:hidden">
        <tr style="background:${BRAND.pageBg}">
          <th align="left" style="padding:10px 16px;font-size:12px;color:${BRAND.textMuted};font-weight:600">Project</th>
          <th align="left" style="padding:10px 16px;font-size:12px;color:${BRAND.textMuted};font-weight:600">Status</th>
          <th align="right" style="padding:10px 16px;font-size:12px;color:${BRAND.textMuted};font-weight:600">Safe until</th>
          <th align="right" style="padding:10px 16px;font-size:12px;color:${BRAND.textMuted};font-weight:600">Time</th>
        </tr>${tableRows || `
          <tr><td colspan="4" style="${td};color:${BRAND.textMuted}">No projects are configured.</td></tr>`}
      </table>
    </td></tr>${actions}
    <tr><td style="padding:16px 32px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:${BRAND.cta}">
        <a href="${esc(runUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none">View run on GitHub →</a>
      </td></tr></table>
      <div style="font-size:12px;color:${BRAND.textMuted};padding-top:14px;line-height:18px">
        Trigger: ${esc(trigger)} · Repo heartbeat: ${esc(repoOk ? 'committed' : heartbeatResult || 'unknown')}${disabled ? ` · ${disabled} disabled` : ''}${pruned ? ` · ${pruned} heartbeat rows older than 30 days pruned` : ''}
      </div>
    </td></tr>
    <tr><td style="background:${BRAND.pageBg};padding:18px 32px;border-top:1px solid ${BRAND.border};font-size:11px;line-height:17px;color:${BRAND.textMuted}">
      Automated report from <strong>${esc(repo || 'techsilon-ops/supabase-keepalive')}</strong>. "Safe until" is ${PAUSE_DAYS} days after the ping, when Supabase would pause an idle free-tier project. One email is sent after every run, so a day without one means the job did not run.<br>
      TechSilon Operations · <a href="https://techsilon.com" style="color:${BRAND.textMuted}">techsilon.com</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`

  const text = [
    headline,
    detail,
    '',
    ...rows.map((r) => `- ${r.label}: ${r.outcome}${r.outcome === 'ok' ? `  safe until ${safeUntil(r.ranAt)}` : r.error ? `  (${r.error})` : ''}`),
    '',
    `Projects kept alive: ${ok}/${total} · Earliest possible pause: ${earliestSafe} · Finished ${time} UTC`,
    `Trigger: ${trigger} · Repo heartbeat: ${repoOk ? 'committed' : heartbeatResult || 'unknown'}`,
    `Run: ${runUrl}`,
    '',
    `Automated report from ${repo || 'techsilon-ops/supabase-keepalive'}. TechSilon Operations.`,
  ].join('\n')

  return { subject, html, text, healthy }
}

export function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback } catch { return fallback }
}

function preview(outDir) {
  mkdirSync(outDir, { recursive: true })
  const projects = ['techsilon-dev', 'natnlab-prod', 'rav-prod'].map((label) => ({ label }))
  const at = '2026-10-13T06:19:04.000Z'
  const good = projects.map((p, i) => ({ label: p.label, outcome: 'ok', heartbeatId: String(90 + i), ranAt: at, heartbeats: 33, pruned: i === 0 ? 1 : 0, ms: 600 + i * 300 }))
  const common = { runUrl: 'https://github.com/techsilon-ops/supabase-keepalive/actions/runs/1', repo: 'techsilon-ops/supabase-keepalive', now: new Date('2026-10-13T06:19:30Z') }
  const ok = buildReport({ rows: mergeResults(projects, good), pingResult: 'success', ...common })
  const bad = buildReport({ rows: mergeResults(projects, [good[0], { label: 'natnlab-prod', outcome: 'failed', error: 'password authentication failed for user "postgres"', ms: 812 }]), pingResult: 'failure', heartbeatResult: 'success', ...common })
  writeFileSync(join(outDir, 'keepalive-success.html'), ok.html)
  writeFileSync(join(outDir, 'keepalive-failure.html'), bad.html)
  console.log(`${ok.subject}\n${bad.subject}\nwritten to ${outDir}`)
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--preview') return preview(args[1] || 'test-results/email-preview')
  const env = process.env
  const projects = readJson(new URL('../projects.json', import.meta.url), { projects: [] }).projects
  const rows = mergeResults(projects, readJson(env.KEEPALIVE_RESULTS || 'results.json', []))
  const report = buildReport({
    rows, pingResult: env.PING_RESULT, heartbeatResult: env.HEARTBEAT_RESULT, event: env.EVENT,
    runUrl: env.RUN_URL, repo: env.GITHUB_REPOSITORY,
  })
  const to = String(env.REPORT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean)
  process.stdout.write(JSON.stringify({ from: env.REPORT_EMAIL_FROM, to, subject: report.subject, html: report.html, text: report.text }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

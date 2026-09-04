# Next Priorities — keepalive-functions

**READ THIS FIRST when resuming a session.** Single source of truth for "what's the order of
work right now?" Durable rules live in `CLAUDE.md`.

*Last updated: 2026-09-04*

---

## Session-start checklist (do these in order)

1. Real history since last time — plain `git log` is ~80% bot heartbeat commits:
   ```bash
   git fetch origin
   git log --oneline --invert-grep --grep="keepalive heartbeat" main | head -20
   ```
2. **Is the job actually green?** This is the check that matters most:
   ```bash
   gh run list --repo techsilon-apps/keepalive-functions --limit 10
   ```
   Anything not `success` needs attention *today* — projects pause ~7 days after their last
   real query. If runs show `action_required`, open the run page: GitHub is blocking
   dispatch, and no job ran at all.
3. `npm ci && npm run check` — expect `check passed`.
4. Skim **Status snapshot**, then pick the next incomplete item from **Priority sequence**.

---

## Status snapshot (as of 2026-09-04)

*If this date is more than a few weeks old, verify against `gh run list` and `git log` before
trusting any line below.*

- **Six projects** registered and pinging green: techsilon-dev/prod, natnlab-dev/prod,
  polysilon-dev/prod. Authoritative list: `projects.json`.
- All secrets present and verified by a real run concluding `success`.
- **Failure notification is fully live and tested**: GitHub issue for failed runs, plus a
  healthchecks.io dead man's switch alerting Telegram if the job stops running at all.
- `sampleTables` is empty for every project — no row counts leak into public Actions logs.
- techsilon-prod's database password was rotated on 2026-09-04 and its secret updated;
  confirmed working by a live run.
- **Recovered from an 18-day silent outage** (2026-08-18 → 2026-09-04). Two independent
  causes, both fixed and both now guarded by `npm run check`:
  a stale prod credential after a rotation, and GitHub blocking dispatch because the
  workflow bundled all secrets via `toJSON(secrets)`.
- Repo is **public**, by decision — see Open strategic decisions.

---

## Open strategic decisions

These are the user's calls. Do not resolve them silently.

### 1. Public vs private repo — *decided 2026-09-04: stay public, revisit later*

Private would stop Actions logs being world-readable and remove the fork-PR risk class
entirely. Rejected for now because Actions minutes for private repos draw from an allowance
shared across the whole `techsilon-apps` org (8–10 repos), and this would not be the only
repo to go private. Mitigated instead by emptying `sampleTables`. Revisit if the org's
private-minutes position changes.

### 2. Dedicated least-privilege Postgres role — *deferred 2026-09-04*

Today every project's **`postgres` superuser** connection string is stored in GitHub Actions
secrets. A dedicated `keepalive` role per project would shrink that blast radius and let a
password be rotated without touching anything else. Rejected for now: it adds 2 manual SQL
steps per project on top of the existing 3-step onboarding. Note `keepalive.mjs` runs
`create schema if not exists` on every run, so any restricted role still needs CREATE on the
database — that has to be solved as part of this, not after.

---

## Priority sequence

### Priority 1 — Failure notification (DONE, verified end to end 2026-09-04)

Two independent mechanisms, because they catch different failures. Both proven by deliberate
tests, not by reading the config.

**In-job failure -> GitHub issue** (`497051d`). A failed run opens or comments on a
deduplicated `keepalive-failure` issue; a successful run closes it. Verified by seeding a
registered project with no secret: issue #1 opened, a second failure commented rather than
duplicating, the recovery run closed it.

**Job stops running -> dead man's switch.** The job pings healthchecks.io only on full
success, so silence is the alarm. This is the only mechanism that can catch a run which never
dispatches -- `action_required`, the schedule being auto-disabled, the repo being archived --
which is how this job has actually broken. Verified by sending a failure signal and confirming
the Telegram alert arrived, then recovering.

- Check: `supabase-keepalive` on healthchecks.io (account `admin@techsilon.com`)
- Period 1 day, grace 6 hours -> alerts if no successful ping for ~30 hours, leaving ~5.75
  days of margin before Supabase pauses anything
- Channels: **Telegram DM** (primary -- phone push, near-zero background noise) and email
  (backup). Email alone was deliberately rejected: GitHub emailed 14 times during the August
  outage and it was not noticed.
- Ping URL lives in the `HEALTHCHECK_PING_URL` repo secret. If it is ever unset, the run log
  says so explicitly rather than looking healthy.

### Priority 2 — Reduce heartbeat commit noise (not started)

The large majority of commits on `main` are bot heartbeats, which is why `CLAUDE.md` has to
teach an `--invert-grep` incantation just to read history. Current ratio:

```bash
echo "heartbeat: $(git log --oneline --grep='keepalive heartbeat' main | wc -l)  real: $(git log --oneline --invert-grep --grep='keepalive heartbeat' main | wc -l)"
```

- [ ] The repo only needs *some* activity inside GitHub's 60-day window, not daily. Change
      the heartbeat step to commit at most weekly (e.g. only when `state/last-run.txt`'s week
      number changes) while the ping itself stays daily
- [ ] Confirm the schedule is still not auto-disabled after the change

### Priority 3 — Onboarding ergonomics (optional)

Onboarding is now 3 edits (secret → workflow `env:` line → `projects.json`). The workflow
line is pure boilerplate.

- [ ] Consider generating the `env:` block from `projects.json` via a small script that
      `npm run check` verifies, so the human edit reduces to 2 steps
- [ ] Must not reintroduce `toJSON(secrets)` (Hard Rule 2)

---

## Completed (evidence in git)

| Item | Commit |
|---|---|
| Original keepalive: scheduled read/write/delete | `7feabf4` |
| Daily cadence | `5ef9367` |
| Onboarding docs incl. IPv4 pooler URL | `a400fb2` |
| Register natnlab-dev / natnlab-prod | `52a0fd9` |
| 7 reliability fixes + `TROUBLESHOOTING.md` + `inspect-url.mjs` | `1c1d56b` |
| Register polysilon-dev / polysilon-prod | `c94494e` |
| Stop publishing row counts to public logs | `a57f629` |
| Adopt documentation standard + `npm run check` | `bdd2aa8` |
| Failure issue + dead man's switch (Priority 1) | `497051d` |

---

## Session-resume prompt (copy-paste when you come back)

> Resume keepalive-functions. Read `CLAUDE.md`, then `tasks/NEXT_PRIORITIES.md`. First run
> `gh run list --repo techsilon-apps/keepalive-functions --limit 10` and tell me whether the
> job is green — if anything is failing or `action_required`, that is the whole session.
> Otherwise start Priority 2: reduce heartbeat commit noise. Report a green/red baseline
> (`npm run check`) before proposing changes.

---

## Context for next-session Claude

- **The user prefers one step at a time.** Give a single action, wait for the result, then
  give the next. Lead every answer with a plain verdict — "this is good, do nothing" /
  "this is broken, do X" — before the explanation. A reply containing five things to check
  means four of them get lost.
- **Small verified fixes over sweeping rewrites**; audit before non-trivial changes.
- Supabase dashboard guidance is not always right for this use case (the IPv6 pooler banner
  is the standing example). Verify with DNS or a real connection before believing a UI hint.
- The user works across multiple machines and profiles; auto-memory does not sync. Anything
  worth keeping goes in these repo docs.
- Connection strings must never be pasted into chat. `npm run inspect` exists precisely so a
  bad one can be diagnosed without exposing the password — use it.

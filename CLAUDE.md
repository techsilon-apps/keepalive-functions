# keepalive-functions — Project Context for Claude

**This file holds durable context and rules. It is NOT a status log.** Current work state lives in `tasks/NEXT_PRIORITIES.md` — history lives in `git log`.

## Read order (every session, before writing any code)

1. **This file** — rules, architecture, workflow.
2. **`tasks/NEXT_PRIORITIES.md`** — current status and what's next.
3. **`TROUBLESHOOTING.md`** — mandatory before touching any connection string, password, or the workflow. It encodes an 18-day outage worth of findings.
4. **Real history** — *not* plain `git log`:
   ```bash
   git log --oneline --invert-grep --grep="keepalive heartbeat" main | head -20
   ```
   See the first architecture gotcha for why.

---

## What This Is

A scheduled read/write/delete job that keeps free-tier Supabase projects from being
auto-paused after ~7 days of inactivity. One repo covers any number of projects across any
number of Supabase accounts — a Supabase account is not a GitHub account, so the only thing
this repo needs per project is a connection string.

Per project, each run bootstraps a private `keepalive` schema (never touching product data),
inserts a heartbeat row, reads it back, and prunes rows older than 30 days. That transaction
cycle is what resets Supabase's inactivity timer — **a deploy does not count**.

- **Runs:** GitHub Actions, daily at `17 6 * * *` UTC, plus manual dispatch.
- **Repo:** `techsilon-apps/keepalive-functions`, **public** — deliberately (Actions minutes
  for private repos draw from an allowance shared across the whole org).
- **Targets:** whatever is listed in `projects.json`. That file is the single source of
  truth; do not maintain a second list anywhere.

---

## Hard Rules

Each rule below exists because something actually broke. The story is the reason it stays.

1. **`npm run check` must pass before every commit.** It is the only automated gate — there
   are no unit tests.
2. **Never reintroduce `SECRETS_JSON: ${{ toJSON(secrets) }}` in the workflow.** It makes
   onboarding config-only, which is tempting. It also reads to GitHub's workflow scanner as
   a secret-exfiltration pattern: runs get marked `action_required`, **zero jobs dispatch**,
   and there is no failure email and no log. That silently stopped the keepalive for three
   days (2026-09-01..09-03). Pass each secret explicitly instead; one line per project.
3. **The heartbeat-commit step keeps `if: always()`.** Without it, a failing ping skips the
   commit that keeps the repo active, so GitHub would auto-disable the schedule at 60 days —
   i.e. one bad credential silently disarms the protection against total shutdown. This was
   live from 2026-08-18 to 2026-09-04.
4. **Add the secret BEFORE adding the `projects.json` entry.** A project listed with no
   matching secret counts as a *failure*, which fails the whole run (`keepalive.mjs`).
5. **Triggers stay `schedule` + `workflow_dispatch`. Never `pull_request`.** This is a public
   repo; a fork PR trigger could reach the connection-string secrets.
6. **Keep `sampleTables` empty unless the counts are genuinely public.** Actions logs on a
   public repo are world-readable, and this job prints row counts into them. It was
   publishing live subscription counts until 2026-09-04.
7. **`postgres()` stays inside the `try` block.** It throws synchronously on an unparseable
   URL; outside the try, one bad connection string aborts the entire run and leaves every
   remaining project unpinged.
8. **Never commit `.env` or `.env.local`.** Only `.env.example` is tracked. `npm run check`
   enforces the `.gitignore` rules that make this true.
9. **Conventional commits** — `type(scope): description`.
10. **Repo docs beat Claude auto-memory.** Memory is machine-local and does not sync across
    machines or profiles.
11. **Rotating a Supabase database password is an approval gate, not a technical block.** Ask
    first — other services may share the credential. Never claim it cannot be done. After any
    rotation the matching GitHub secret **must** be updated in the same sitting: a stale
    secret is exactly how this job ran broken for 18 days.
12. **Verify by running, not by reading metadata.** `gh secret list` timestamps have been
    observed lagging a just-updated secret. A real run is the only proof.
13. **Never remove either notification path.** The `if: failure()` issue step and the dead
    man's switch are the only reasons a broken keepalive reaches a human — GitHub's own
    failure email demonstrably did not, for 18 days. `npm run check` guards both.
14. **Alerting changes must be proven by a seeded failure, never by reading the YAML.** The
    verified method: add a project entry plus its workflow `env:` line but no secret, so the
    run fails deterministically without touching a real credential; confirm the issue opens;
    revert; confirm it closes.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node 22 (ESM, `"type": "module"`) |
| Database client | `postgres` (postgres.js), zero-dependency, pinned via `package-lock.json` |
| Scheduler | GitHub Actions (`.github/workflows/keepalive.yml`) |
| Config | `projects.json` (no secrets) + one GitHub Actions secret per project |
| Tests | **None.** `npm run check` is a static conformance gate, not a test suite. |

### Architecture gotchas (things a new session gets wrong)

- **`git log` is mostly noise.** The bot commits a heartbeat every run, so the vast majority
  of commits are `chore: keepalive heartbeat [skip ci]`. Plain `git log --oneline -20` can
  show almost no real work. Always filter:
  `git log --oneline --invert-grep --grep="keepalive heartbeat" main`.
- **`git log --all` is worse.** A `refs/notes/ai` ref adds empty-message commits authored by
  `git-ai`. They are tooling metadata, not project history. Prefer `main` over `--all` here.
- **The bot pushes to `main` while you work.** Always `git pull --rebase origin main` before
  pushing, or your push is rejected as non-fast-forward.
- **Three layers must agree for a project to be pinged:** an entry in `projects.json`, a
  matching line in the workflow's `env:` block, and a GitHub secret of the same name.
  `npm run check` verifies the first two; secrets need `gh secret list` (network).
- **The connection string must be the Transaction pooler URI**, not the direct connection.
  The Supabase dashboard shows a banner claiming the pooler is IPv6 — it is wrong for this
  purpose, and the IPv4 add-on is not needed. `TROUBLESHOOTING.md` has the DNS proof.
- **Only four characters need percent-encoding in a password** (`#` `/` `?` `%`). Encoding
  anything else *breaks* it. Getting this wrong produces errors that name neither the project
  nor the password.
- **Two notification paths, and they catch different things.** A failed run opens/updates a
  deduplicated `keepalive-failure` issue (a successful run closes it). But a run that never
  *dispatches* produces no job and therefore no notification — only the dead man's switch
  catches that, and it is active only when the `HEALTHCHECK_PING_URL` secret is set. Check
  the tail of any run's log: it says explicitly when the watchdog is not active.

### Repo map

```
keepalive.mjs           the job itself: bootstrap, write, read, prune, per project
inspect-url.mjs         diagnoses a connection string without printing the password
scripts/check.mjs       `npm run check` — offline conformance + regression guards
projects.json           which projects to ping (no secrets) — single source of truth
.env.example            local-testing template; copy to .env.local (gitignored)
.github/workflows/      the schedule, and the explicit per-project secret env block
TROUBLESHOOTING.md      symptom -> cause -> fix; read before debugging anything
tasks/                  NEXT_PRIORITIES.md, the living tracker
```

---

## Daily Workflow

```bash
npm ci                      # install exactly what the lockfile pins
npm run check               # REQUIRED before every commit
npm run keepalive:local     # live test against whatever is in .env.local
npm run inspect SUPABASE_DB_URL_X   # structure of one connection string, no password shown

gh secret list --repo techsilon-apps/keepalive-functions
gh workflow run keepalive.yml --repo techsilon-apps/keepalive-functions
gh run list --repo techsilon-apps/keepalive-functions --limit 10
```

Onboarding a new project is documented in `README.md` — secret, then workflow `env:` line,
then `projects.json`, in that order.

---

## Definition of Done

Work is finished only when ALL of these hold:

- [ ] `npm run check` passes
- [ ] If the job's behaviour changed: a real workflow run concluded **success** with every
      project reporting `OK` (`gh run list`) — static checks do not prove connectivity
- [ ] Docs updated where reality moved: `README.md` for onboarding, `TROUBLESHOOTING.md` for
      a new failure mode
- [ ] `tasks/NEXT_PRIORITIES.md` updated if status or priorities changed
- [ ] Committed and pushed — nothing stranded on this machine

---

## What NOT to Do

- ❌ Never add a `pull_request` trigger to the workflow.
- ❌ Never put a connection string on a command line, in a pipe, or inside PowerShell double
  quotes — `$` expands and silently corrupts the password. Use `gh secret set` interactively.
- ❌ Never paste a real connection string into chat, a commit, or an issue. Use
  `npm run inspect`, which reports structure without the password.
- ❌ Never maintain a second list of projects (README table, docs, comments). `projects.json`
  is it.
- ❌ Never trust counts or timestamps written in docs — trust command output and `git log`.
- ❌ Never assume a green `npm run check` means the projects are alive. It is offline.
- ❌ Never leave work uncommitted at session end.

---

## Related Docs

- `tasks/NEXT_PRIORITIES.md` — **living tracker**, current status and priority order
- `TROUBLESHOOTING.md` — symptom table, password encoding, IPv4/IPv6, silent-stoppage checks
- `README.md` — what it is and how to onboard a project

*Durable-context file last reviewed: 2026-09-04. If this file and reality disagree, trust
`git log` + `tasks/NEXT_PRIORITIES.md`, then fix this file.*

# Deployment

Live application: <http://192.168.22.205/ai-live-report/>

## Current architecture (verified 10 Aug 2026)

| | |
| --- | --- |
| Production host | `192.168.22.205` — a separate machine on the LAN |
| OS | Ubuntu Linux |
| Web server | nginx/1.18.0 (Ubuntu) |
| Serving | Static file from disk. `index.html` only |
| Routing | Catch-all — every path under `/ai-live-report/` returns `index.html` |
| App server | None. No PM2, no Docker, no Node process |
| Build step | None. The app is hand-written HTML/CSS/JS with no bundler |
| Data store | Google Sheet via Apps Script. No database on the server |
| Deployment | **Manual file copy** — no CI/CD, no automation |

The whole application is one file. There is nothing to compile, install or
restart: publishing means putting a newer `index.html` in place.

## Workflow

```
VS Code  →  git commit  →  git push  →  GitHub
                                          │
                                          ▼
                              ./scripts/deploy.sh
                                          │
                                          ▼
                    192.168.22.205:/…/ai-live-report/index.html
```

The deploy step is deliberately **pull-free and manual**. See
[Why not CI/CD](#why-not-cicd) below.

## One-time setup

The script needs to know who to connect as and where the files live. Neither
is guessable from outside, so set them once:

```bash
export PROD_USER=your-ssh-user
export PROD_DIR=/var/www/html/ai-live-report     # confirm the real path first
```

To find the real path, on the production server:

```bash
grep -R "ai-live-report" /etc/nginx/sites-enabled/
```

The `root` or `alias` line in that output is `PROD_DIR`.

Add both to `~/.bashrc` so they persist. They are machine configuration, not
secrets, and are **not** committed.

## Deploying

```bash
./scripts/deploy.sh --check      # inspect production, change nothing
./scripts/deploy.sh --dry-run    # show exactly what would happen
./scripts/deploy.sh              # deploy, with confirmation
./scripts/deploy.sh --rollback   # restore the previous backup
```

Run `--check` first, always. It is read-only.

### What the script refuses to do

It will not deploy if:

- the working tree has uncommitted changes — what goes live must exist in git
- `HEAD` differs from `origin/main` — production must match GitHub
- `index.html` has a JavaScript syntax error — checked with `node --check`
- the host is unreachable

### What it guarantees

- **Backs up the live file first**, timestamped, before overwriting
- **Never deletes anything** on production
- **Publishes only `index.html`** — `backend/`, `docs/`, `scripts/` and
  `archive/` are development material and are not copied into a web-served
  directory
- **Verifies after deploying** by re-fetching the live URL and comparing
  SHA-256; a mismatch is a hard failure telling you to roll back
- **Records the deployed commit** in `.deployed-commits` on the server, so the
  running version can always be traced back to git

## Why not CI/CD

A GitHub Actions workflow cannot reach `192.168.22.205` — it is a private
address behind your network. Making it work would need one of:

1. a **self-hosted runner** installed on the production server, or
2. an **SSH deploy key** plus the server exposed to the internet, or
3. a **cron pull** on the server (`git pull` every N minutes)

Option 2 means exposing an internal server publicly — not worth it for a
static file. Option 3 removes the human check before a change goes live.

Option 1 is reasonable if you want it later; the runner would simply run
`scripts/deploy.sh` locally on the box. Until then, a controlled script with a
confirmation prompt is the safer trade for a single-file app on an internal
host.

## Rolling back

```bash
./scripts/deploy.sh --rollback
```

Restores the most recent `.backup-index.html.<timestamp>` from the production
directory. Backups accumulate; prune them by hand when you choose to.

## Data safety

Deployment touches **only the HTML file**. Your automation records live in the
Google Sheet and are never involved — deploying cannot delete, reset or
duplicate them. The same is true of user accounts, sessions and audit logs.

## Checklist

```
[ ] changes tested locally      START.bat → http://localhost:8080
[ ] git status clean
[ ] git push origin main
[ ] ./scripts/deploy.sh --check
[ ] ./scripts/deploy.sh --dry-run
[ ] ./scripts/deploy.sh
[ ] load http://192.168.22.205/ai-live-report/ and hard-refresh (Ctrl+F5)
[ ] confirm KPI numbers and the automation register look right
```

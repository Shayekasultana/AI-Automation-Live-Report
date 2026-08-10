#!/usr/bin/env bash
#
# Controlled deployment to the DBL AI Automation production server.
#
#   ./scripts/deploy.sh --check     inspect production, change nothing
#   ./scripts/deploy.sh --dry-run   show exactly what would happen
#   ./scripts/deploy.sh             deploy (asks for confirmation)
#   ./scripts/deploy.sh --rollback  restore the previous backup
#
# Design notes:
#   - Only index.html is published. It is the whole application; the docs,
#     backend/ and scripts/ folders are development material and are
#     deliberately NOT copied to a web-served directory.
#   - The live file is backed up, timestamped, before every deploy.
#   - Nothing is deleted from production. Ever.
#   - Deploys the committed HEAD, not your dirty working tree, so what goes
#     live always matches something in git history.
#
set -euo pipefail

# ---- configuration -------------------------------------------------------
PROD_HOST="${PROD_HOST:-192.168.22.205}"
PROD_USER="${PROD_USER:-}"                       # set: export PROD_USER=youruser
PROD_DIR="${PROD_DIR:-/var/www/html/ai-live-report}"
LIVE_URL="${LIVE_URL:-http://192.168.22.205/ai-live-report/}"
APP_FILE="index.html"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_off=$'\033[0m'
say(){ printf '%s\n' "$*"; }
ok(){  printf '%s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn(){ printf '%s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die(){ printf '%s✗%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

ssh_target(){
  [ -n "$PROD_USER" ] || die "PROD_USER is not set.  export PROD_USER=youruser"
  printf '%s@%s' "$PROD_USER" "$PROD_HOST"
}

# ---- checks --------------------------------------------------------------
preflight(){
  say "── preflight ─────────────────────────────────────────"

  git diff --quiet && git diff --cached --quiet \
    || die "Working tree has uncommitted changes. Commit or stash first."
  ok "working tree clean"

  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || warn "on branch '$branch', not 'main'"

  git fetch -q origin 2>/dev/null || warn "could not reach origin (offline?)"
  if git rev-parse --verify -q origin/main >/dev/null; then
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
      || die "HEAD differs from origin/main. Push first, so production matches GitHub."
    ok "HEAD matches origin/main"
  fi

  [ -f "$APP_FILE" ] || die "$APP_FILE not found"
  node --check <(sed -n '/^<script>$/,/^<\/script>$/p' "$APP_FILE" | sed '1d;$d') 2>/dev/null \
    && ok "$APP_FILE script block parses" \
    || die "$APP_FILE has a JavaScript syntax error — refusing to deploy"

  ping -c1 -W2 "$PROD_HOST" >/dev/null 2>&1 && ok "$PROD_HOST reachable" \
    || die "$PROD_HOST unreachable"
}

remote_state(){
  say "── production ────────────────────────────────────────"
  curl -sI -m 10 "$LIVE_URL" | sed -n '1p;/^Server:/p;/^Content-Length:/p;/^Last-Modified:/p' \
    | sed 's/^/    /'
  local live_hash local_hash
  live_hash="$(curl -s -m 20 "$LIVE_URL" | sha256sum | cut -c1-16)"
  local_hash="$(sha256sum "$APP_FILE" | cut -c1-16)"
  say "    live  sha256: $live_hash"
  say "    local sha256: $local_hash"
  [ "$live_hash" = "$local_hash" ] \
    && ok "production already matches local — nothing to deploy" \
    || warn "production differs from local — deploy would update it"
}

# ---- actions -------------------------------------------------------------
do_deploy(){
  local target stamp
  target="$(ssh_target)"
  stamp="$(date +%Y%m%d-%H%M%S)"

  say "── deploying ─────────────────────────────────────────"
  say "    from : $REPO_ROOT/$APP_FILE  ($(git rev-parse --short HEAD))"
  say "    to   : $target:$PROD_DIR/$APP_FILE"

  # back up the live file first; never overwrite without a way back
  ssh "$target" "set -e
    [ -d '$PROD_DIR' ] || { echo 'PROD_DIR does not exist: $PROD_DIR' >&2; exit 1; }
    if [ -f '$PROD_DIR/$APP_FILE' ]; then
      cp -p '$PROD_DIR/$APP_FILE' '$PROD_DIR/.backup-$APP_FILE.$stamp'
      echo 'backed up to .backup-$APP_FILE.$stamp'
    fi"
  ok "backup taken"

  scp -q "$APP_FILE" "$target:$PROD_DIR/$APP_FILE"
  ok "uploaded"

  # record which commit is live, so the server can always be traced to git
  ssh "$target" "printf '%s\n' '$(git rev-parse HEAD)  $(date -u +%FT%TZ)' >> '$PROD_DIR/.deployed-commits'"

  say "── verifying ─────────────────────────────────────────"
  sleep 1
  local live_hash local_hash
  live_hash="$(curl -s -m 20 "$LIVE_URL" | sha256sum | cut -c1-16)"
  local_hash="$(sha256sum "$APP_FILE" | cut -c1-16)"
  if [ "$live_hash" = "$local_hash" ]; then
    ok "live now serves the deployed build ($live_hash)"
    say ""
    ok "DONE → $LIVE_URL"
  else
    die "verification FAILED: live=$live_hash local=$local_hash. Run --rollback."
  fi
}

do_rollback(){
  local target; target="$(ssh_target)"
  say "── rollback ──────────────────────────────────────────"
  local latest
  latest="$(ssh "$target" "ls -1t '$PROD_DIR'/.backup-$APP_FILE.* 2>/dev/null | head -1")"
  [ -n "$latest" ] || die "no backup found in $PROD_DIR"
  say "    restoring: $latest"
  read -rp "    confirm rollback? [y/N] " a; [ "$a" = "y" ] || die "cancelled"
  ssh "$target" "cp -p '$latest' '$PROD_DIR/$APP_FILE'"
  ok "restored — verify at $LIVE_URL"
}

# ---- entry ---------------------------------------------------------------
case "${1:-}" in
  --check)
    preflight; remote_state ;;
  --dry-run)
    preflight; remote_state
    say "── dry run ───────────────────────────────────────────"
    say "    would back up : $PROD_DIR/$APP_FILE → .backup-$APP_FILE.<timestamp>"
    say "    would upload  : $APP_FILE ($(wc -c < "$APP_FILE") bytes)"
    say "    would verify  : sha256 of $LIVE_URL"
    say "    nothing else is touched; no file is ever deleted"
    ok "dry run complete — no changes made" ;;
  --rollback)
    do_rollback ;;
  "")
    preflight; remote_state
    say ""
    read -rp "Deploy $(git rev-parse --short HEAD) to $PROD_HOST? [y/N] " a
    [ "$a" = "y" ] || die "cancelled"
    do_deploy ;;
  *)
    say "usage: $0 [--check | --dry-run | --rollback]"; exit 1 ;;
esac

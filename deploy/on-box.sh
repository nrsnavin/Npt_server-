#!/usr/bin/env bash
#
# Put the current main on the box and make sure it answers [DEPLOY-AWS.md §11].
#
# Run by the self-hosted runner after the tests on GitHub have gone green. It can also be run by
# hand over SSH, which is the point of it being a script rather than steps in a workflow file:
# the thing that deploys at three in the afternoon is the same thing that deploys at midnight
# when the runner is down.
#
# The tests are deliberately *not* run here. They ran on GitHub against this exact commit, on a
# machine with room for them; running them again on a 2 GB box with MongoDB on it buys nothing
# and is the step most likely to fail for want of memory. What protects this box is the health
# check below, which tests never could: it asks the process that is actually serving traffic
# whether it can reach the database.
#
set -Eeuo pipefail

APP="${DEPLOY_DIR:-/srv/npt/server}"
PM2_NAME="${PM2_NAME:-npt-api}"
HEALTH="${HEALTH_URL:-http://127.0.0.1:5000/health/ready}"
TRIES="${HEALTH_TRIES:-20}"

say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }

cd "$APP"

# What we are on now, so a failed deploy has somewhere to go back to. Captured before anything
# moves — after `git reset` it is unknowable.
PREVIOUS=$(git rev-parse HEAD)

install_and_reload() {
  npm ci --omit=dev --no-audit --no-fund
  # `reload` starts the new process before stopping the old one, so a deploy does not drop a
  # request. `--update-env` picks up an edited .env without a full restart.
  pm2 reload "$PM2_NAME" --update-env
}

healthy() {
  for _ in $(seq 1 "$TRIES"); do
    if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

say "Fetching"
git fetch --quiet origin main
TARGET=$(git rev-parse origin/main)

if [ "$PREVIOUS" = "$TARGET" ]; then
  echo "Already on ${TARGET:0:8} — nothing to do."
  exit 0
fi

# `reset --hard` rather than `pull`: the box is a checkout nobody edits, and a merge commit
# created here by a stray local change is a divergence that has to be untangled over SSH.
git reset --hard --quiet "$TARGET"
echo "${PREVIOUS:0:8} → ${TARGET:0:8}"

say "Installing and reloading"
install_and_reload

say "Health"
if healthy; then
  echo "✓ ${TARGET:0:8} is live and can reach the database"
else
  say "FAILED — rolling back to ${PREVIOUS:0:8}"
  git reset --hard --quiet "$PREVIOUS"
  install_and_reload

  if healthy; then
    echo "Rolled back. The box is serving ${PREVIOUS:0:8} again." >&2
  else
    # Both are down, which is not a deploy problem any more. Said plainly rather than dressed
    # up as a rollback that worked.
    echo "ROLLED BACK AND STILL UNHEALTHY — the database or the box is the problem," >&2
    echo "not this commit. Check: pm2 logs $PM2_NAME --lines 50" >&2
  fi
  exit 1
fi

# Migrations are never run from here, and this is the whole of why: they rewrite existing rows,
# several of them are not reversible, and the instruction that goes with every one of them is
# "mongodump first". A deploy that runs them automatically is a deploy that can lose the plant's
# data at three in the afternoon with nobody watching. So the script says what arrived and stops.
NEW_SCRIPTS=$(git diff --name-only "$PREVIOUS" "$TARGET" -- scripts/ | grep -E 'migrate|backfill' || true)
if [ -n "$NEW_SCRIPTS" ]; then
  say "THIS RELEASE CARRIES DATA SCRIPTS — none of them have been run"
  echo "$NEW_SCRIPTS" | sed 's/^/  /'
  echo
  echo "  Take a dump first, then run them by hand:"
  echo "    mongodump --uri \"\$MONGO_URI\" --out ~/dump-\$(date +%F)"
  echo "    cd $APP && npm run <the script> -- --confirm"
fi

#!/usr/bin/env bash
# Deploy Number Crunch on this PC: test, keep the current image as :previous, build, start,
# wait for the health check, then check that accounts and the database answer.
# Run from anywhere: npm run deploy (or bash scripts/deploy.sh), from Git Bash.
# Pushing to GitHub deploys nothing; this script is the deploy.
# Any step that fails stops the script with a non-zero exit (set -e).
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="http://127.0.0.1:3010"
HEALTH_URL="$BASE_URL/api/health"
HEALTH_TIMEOUT_S=90

# Tests run on the host: they need the PGlite dev dependency, which the image omits.
echo "== tests"
npm test

# The rollback target (README "Rollback"). web-dev shares this image name, so a dev rebuild replaces it too.
if docker image inspect numbercrunch-web >/dev/null 2>&1; then
  echo "== tagging the current image as numbercrunch-web:previous"
  docker tag numbercrunch-web numbercrunch-web:previous
fi

echo "== docker compose up -d --build"
docker compose up -d --build

echo "== waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT_S}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until body=$(curl -fsS "$HEALTH_URL" 2>/dev/null); do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "health check failed: no 200 from $HEALTH_URL after ${HEALTH_TIMEOUT_S}s" >&2
    docker compose ps >&2 || true
    docker compose logs web --tail 40 >&2 || true
    exit 1
  fi
  sleep 2
done

echo "$body"

# Health only proves the process is up: /api/me needs the account configuration, /api/bests the database.
for path in /api/me /api/bests; do
  echo "== checking $path"
  if ! curl -fsS "$BASE_URL$path" >/dev/null; then
    echo "deploy check failed: $path did not answer 200 (accounts or database unavailable?)" >&2
    docker compose logs web --tail 40 >&2 || true
    exit 1
  fi
done

echo "== deployed"

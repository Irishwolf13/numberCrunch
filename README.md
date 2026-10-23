# Number Crunch

Live at https://crunch.blackcatmatrix.com, self-hosted on John's PC with Docker Compose and a Cloudflare Tunnel.

## What it is

Number Crunch is a number puzzle for the browser: combine 1, 2, 3, 4 and 5 with + − × ÷ to hit the target. Sign in with your shared Black Cat Matrix account (Keycloak) to save times and appear on the leaderboard; guests can play without saving.

Solves are verified server-side: the server replays the submitted steps and times the round with its own clock. Every saved time comes from a valid solution, is bounded by the server's clock (never longer than the server measured, at most 1.5 s shorter) and is never below 1 s; a round the server timed under 1 s is rejected. A fast, scripted solver can still post a real-looking time, so see "Removing bad times" below.

It is a small Node server (`server/server.mjs`) that serves `public/` and a JSON API, backed by its own PostgreSQL database `number_crunch` on the shared `bcm-postgres`.

## Local dev

```bash
npm install
npm test
npm run preview
```

`npm test` runs `node --test "test/**/*.test.mjs"` against an in-process PGlite database. `npm run preview` starts a local server as a guest; `node scripts/preview.mjs --as "Name"` previews signed in as that player.

## Accounts

Configuration comes from environment variables in protected files outside the source tree and outside OneDrive:

- `APP_ORIGIN`: the public origin, e.g. `https://crunch.blackcatmatrix.com`. Writes must carry exactly this `Origin`.
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`: the Keycloak realm and this game's confidential client.
- `AUTH_ENCRYPTION_KEY`: encrypts the server-side sessions.
- `DATABASE_URL`: the runtime connection string for `number_crunch`.
- `AUTH_ALLOW_HTTP_LOCALHOST=true` (optional): allows an `http://localhost` origin, for the dev client.
- `APP_ENV_FILE` (optional): a path the server loads with `process.loadEnvFile` instead of getting the variables from Compose.

The files:

- `C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.env`: production runtime (client `number-crunch`).
- `C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.development.env`: dev runtime (client `number-crunch-dev`, origin `http://localhost:3110`).
- `C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.migration.env`: migration credential, used only for DDL and the legacy import. Never use it at runtime.

Never print these files. Env files never enter the image; compose loads them with `env_file`.

## Database

The database is `number_crunch` on the shared `bcm-postgres`, reachable only on the external Docker network `bcm-apps`. Apply migrations with the migration credential:

```bash
docker build -t numbercrunch-web .
docker run --rm --network bcm-apps --env-file C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.migration.env numbercrunch-web node scripts/migrate.mjs
```

Backups: the shared accounts repo's daily backup includes `number_crunch`.

## Legacy import

The old Firebase leaderboard was imported once, on 2026-10-23, from the protected snapshot `C:/ProgramData/BlackCatMatrix/accounts/imports/number-crunch-firebase-20261023`. The importer (`scripts/import-firebase.mjs`) is idempotent, so running it again changes nothing. It runs like the migration, with the snapshot mounted read-only (in Git Bash, `MSYS_NO_PATHCONV=1` stops `/snapshot` being rewritten to a Windows path):

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network bcm-apps --env-file C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.migration.env -v C:/ProgramData/BlackCatMatrix/accounts/imports/number-crunch-firebase-20261023:/snapshot:ro numbercrunch-web node scripts/import-firebase.mjs /snapshot
```

A signed-in player whose verified email matches an old account takes over its times automatically.

## Deploy

A push to GitHub deploys nothing. The deploy runs on John's PC, from Git Bash (from PowerShell or cmd, `bash` resolves to WSL instead):

```bash
npm run deploy
```

It runs `npm test` on the host (the image omits the PGlite dev dependency), tags the current `numbercrunch-web` image as `numbercrunch-web:previous` (if there is one), then `docker compose up -d --build`, then polls `http://127.0.0.1:3010/api/health` for up to 90 seconds and prints `{"ok":true,"build":"<12 hex>"}`. Last, it fetches `/api/me` (account configuration) and `/api/bests` (database); if either fails it prints the last 40 `web` log lines. Any failure stops it with a non-zero exit. When accounts fail, the server logs only `Number Crunch accounts unavailable`, never the raw error.

The stack (`docker-compose.yml`, project name `numbercrunch`):

- `web`: the server, published on `127.0.0.1:3010` for local checks only. Healthcheck: `/api/health`.
- `web-dev` (profile `dev`): the same image with the dev client, on `127.0.0.1:3110`. Start it with `docker compose --profile dev up -d --build web-dev`.
- `cloudflared`: the tunnel, which serves `crunch.blackcatmatrix.com` from `http://web:3000`.

Never run `docker compose config` without `--quiet`; it expands the secrets.

```bash
docker compose ps
docker compose logs cloudflared --tail 20
curl -fsS https://crunch.blackcatmatrix.com/api/health
```

## Tunnel recipe

The tunnel already exists (uuid `6e50b2be-4f4a-4949-9fa9-21628bb7fae0`, in `cloudflared/config.yml`). Its credentials JSON lives in `cloudflared/<uuid>.json` and is gitignored; never commit it. To set one up from scratch:

```bash
cloudflared tunnel create numbercrunch
cloudflared tunnel route dns --overwrite-dns <uuid> crunch.blackcatmatrix.com
```

Always route DNS by uuid, never by tunnel name. This PC runs several tunnels, and a hostname routed by name once landed on the wrong one.

## Rollback

`npm run deploy` tags the image it is about to replace as `numbercrunch-web:previous`. To roll back, point the name back at that tag and restart without building:

```bash
docker tag numbercrunch-web:previous numbercrunch-web && docker compose up -d --no-build --no-deps web
```

`web` and `web-dev` share the `numbercrunch-web` image, so `docker compose --profile dev up --build web-dev` rebuilds the image that production restarts from (and that the next deploy tags as `:previous`). It leaves `:previous` itself alone, so a rollback still works after a dev rebuild.

## Removing bad times

To remove a vandal's times, find their player id from their display name, then delete their rows (`best_times` holds every saved time):

```bash
docker exec -i bcm-accounts-postgres-1 psql -U bcm_admin -d number_crunch -c "SELECT id, display_name FROM players WHERE display_name ILIKE '%<name>%'"
docker exec -i bcm-accounts-postgres-1 psql -U bcm_admin -d number_crunch -c "DELETE FROM best_times WHERE player_id = '<id>'"
```

Check the `SELECT` matches exactly one player before deleting. The player can still sign in and post new times.

## Known limits

- Single instance on one PC: a redeploy briefly interrupts the site.
- Guests' progress is not saved.
- The old Firebase site only shows a "moved" notice.

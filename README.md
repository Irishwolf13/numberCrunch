# Number Crunch

Live at https://crunch.blackcatmatrix.com, self-hosted on John's PC with Docker Compose and a Cloudflare Tunnel.

## What it is

Number Crunch is a daily number puzzle for the browser. Sign in with your shared Black Cat Matrix account (Keycloak) to save times and appear on the leaderboard; guests can play without saving.

Solves are verified server-side: the server replays the submitted steps and bounds the solve time by its own clock, so the leaderboard cannot be filled with made-up times.

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

The old Firebase leaderboard was imported once, on 2026-10-23, from the protected snapshot `C:/ProgramData/BlackCatMatrix/accounts/imports/number-crunch-firebase-20261023`. The importer (`scripts/import-firebase.mjs`) is idempotent and runs like the migration, with the migration env file and the snapshot available to the container. A signed-in player whose verified email matches an old account takes over its times automatically.

## Deploy

A push to GitHub deploys nothing. The deploy runs on John's PC, from Git Bash (from PowerShell or cmd, `bash` resolves to WSL instead):

```bash
npm run deploy
```

It runs `npm test` on the host (the image omits the PGlite dev dependency), then `docker compose up -d --build`, then polls `http://127.0.0.1:3010/api/health` for up to 90 seconds and prints `{"ok":true,"build":"<12 hex>"}`. Any failure stops it with a non-zero exit.

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

Before deploying, tag the current image: `docker tag numbercrunch-web numbercrunch-web:previous`. To roll back, point the name back at that tag and restart without building:

```bash
docker tag numbercrunch-web:previous numbercrunch-web
docker compose up -d --no-build --no-deps web
```

## Known limits

- Single instance on one PC: a redeploy briefly interrupts the site.
- Guests' progress is not saved.
- The old Firebase site only shows a "moved" notice.

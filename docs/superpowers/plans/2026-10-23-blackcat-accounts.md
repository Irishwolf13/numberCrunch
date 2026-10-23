# Number Crunch on Black Cat Matrix Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Number Crunch's Firebase Auth + Realtime Database with the shared Black Cat Matrix account service (Keycloak at accounts.blackcatmatrix.com), so one sign-in works across all the owner's games, and fix the UI and game-flow defects found in review.

**Architecture:** Number Crunch becomes a small Node server, following the same pattern as The Grid (`Code/theGrid`). It serves the static game, mounts `@blackcat/auth` (confidential OIDC client, server-side encrypted sessions, HttpOnly cookies) and exposes a small JSON API backed by its own PostgreSQL database `number_crunch` on the shared `bcm-postgres`. Solves are verified on the server: the client starts a server round, then submits its steps. The server replays the steps with the same rules module the browser uses, and bounds the time by its own clock. The site is self-hosted in Docker on this PC behind a Cloudflare Tunnel at `https://crunch.blackcatmatrix.com`, replacing the Firebase Hosting CNAME. Firebase leaderboard history is imported as legacy players. A signed-in player whose verified email matches a legacy account takes over that history automatically.

**Tech Stack:** Node 22 ESM (plain JavaScript, no build step), `node:http`, `pg`, `@blackcat/auth` 0.1.2 (vendored tarball), `node:test`, `@electric-sql/pglite` for database tests, Docker Compose, cloudflared.

**Spec:** The Design section below. No separate spec doc exists; the owner authorized the work ("leroy") and asked for the login move plus a UI/game-flow review.

## Design

- Identity: Keycloak clients `number-crunch` (production, origin `https://crunch.blackcatmatrix.com`) and `number-crunch-dev` (origin `http://localhost:3110`), cloned from the live `the-grid` client. The infrastructure part (clients, database, protected env files, tunnel, DNS, Firebase) is done by the controller, not by task implementers. Implementers only read the env-var names.
- Env contract (same as the other games): `APP_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_ENCRYPTION_KEY`, `DATABASE_URL`, optional `AUTH_ALLOW_HTTP_LOCALHOST=true`, optional `APP_ENV_FILE` (path loaded with `process.loadEnvFile`). Migration/import scripts use only `MIGRATION_DATABASE_URL`.
- Guests can still play with no account. Only signed-in players save times.
- Silent SSO is tried once per tab (sessionStorage key `blackcat.sso.attempted.v1`), so a player already signed in to another Black Cat Matrix game arrives signed in.
- Sign-in uses `openAccountWindow` from `@blackcat/auth/browser` (a popup; the game page is preserved). Fallback: "Continue in this tab" link to `/api/auth/login?next=%2F`.
- Times are stored in integer milliseconds and displayed in seconds with one decimal.
- Legacy Firebase data (62 leaderboard entries, 4 players) is imported once into the new database. Firebase player keys become player ids `legacy:<key>`. A legacy player is claimed when a signed-in user's verified email (lowercased) matches a `legacy_claims` row. Claiming merges best times: min of best, sum of solve counts, max of last-solved.

## Global Constraints

- Node `>=22`; ESM everywhere (`"type": "module"`); plain `.mjs`/`.js`, no TypeScript, no bundler.
- Runtime dependencies: only `@blackcat/auth` (`file:vendor/blackcat-auth-0.1.2.tgz`) and `pg`. Dev dependency: `@electric-sql/pglite`.
- The browser never receives the client secret, encryption key, email, session id or tokens. Display names are rendered with `textContent` only, never `innerHTML`.
- Every non-GET/HEAD request must carry `Origin` exactly equal to `APP_ORIGIN`. The only exception is `POST /api/auth/backchannel-logout`. Otherwise respond 403 `{"error":"forbidden"}`.
- JSON API responses carry `cache-control: private, no-store`.
- Never log cookies, query strings of `/api/auth/*`, tokens or raw provider errors.
- Targets: integers 0–100 except the unreachable set `{76, 79, 86, 92, 94, 97, 98}` (verified by exact brute force), so 94 playable targets. Start numbers `[1, 2, 3, 4, 5]`; a full solution is exactly 4 steps.
- Copy must use the exact strings given in Task 5.
- Commit messages: imperative subject. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BR6vyhVM2L9j6ck8fRVKtS
  ```
  Write the message to a file and use `git commit -F <file>` (PowerShell piping adds a BOM).

## Review Focus

1. **Postgres BIGINT comes back as a string from `pg`, but PGlite may return a number.** Every numeric column read in `store.mjs` must be wrapped in `Number()`. Task 2 adds a test asserting `typeof === 'number'` for each returned numeric field.
2. **A replayed or foreign round id.** Finishing the same round twice, or finishing another player's round, must fail with 404 and record nothing. Task 2 (store) and Task 4 (HTTP) both test this.
3. **Hostile display names** such as `<img src=x onerror=alert(1)>`. They must appear literally on the leaderboard and in the stats grid. Task 4 checks that the API returns them verbatim, and Task 5 renders them with `textContent`.
4. **Sign-in mid-round.** A guest who signs in during a round has no server round, so that round must not be saved, and the result must say so. Task 5 owns this ("Times save from your next round.").
5. **Path traversal and odd paths on static serving**, such as `/../server/server.mjs`, `/%2e%2e/package.json` or `/public/../package.json`. These must return 404 and never serve files outside `public/`. Task 4 tests them.

---

### Task 1: Project scaffold and shared game rules

**Files:**
- Create: `package.json`, `vendor/blackcat-auth-0.1.2.tgz` (copy from `C:/Users/roone/OneDrive/Documents/Code/ticOff/vendor/blackcat-auth-0.1.2.tgz`, sha256 `224d899d62883320c8467b30d33a3ab0774bb8be6a76cbf47c220be0ad9f079b`), `public/game-rules.js`
- Modify: `.gitignore` (add `node_modules/`, `.build-id`, `cloudflared/*.json`)
- Test: `test/game-rules.test.mjs`

**Interfaces:**
- Produces (`public/game-rules.js`, a browser-and-Node ES module with no imports):
  - `START_NUMBERS: number[]` = `[1, 2, 3, 4, 5]` (frozen)
  - `UNREACHABLE: Set<number>` = `{76, 79, 86, 92, 94, 97, 98}`
  - `ALL_TARGETS: number[]`: 0..100 minus `UNREACHABLE`, ascending (94 entries)
  - `isPlayableTarget(n: unknown): boolean`: integer, 0 ≤ n ≤ 100, not unreachable
  - `applyOp(a: number, op: string, b: number): number | null`: `+ - * /`; `null` for an unknown op or division by zero
  - `applyStep(numbers: number[], step: {a: number, b: number, op: string}): number[] | null`: `a`/`b` are distinct integer indices into `numbers`. Returns a NEW array: the other numbers in their original order, then the result appended. Returns `null` on any invalid input. The input is never mutated. (This matches the current client: splice both indices out, push the result.)
  - `isTargetHit(value: number, target: number): boolean`: `Math.abs(value - Math.round(value)) < 1e-9 && Math.round(value) === target`
  - `verifySolution(target: number, steps: unknown): boolean`: `isPlayableTarget(target)`, `steps` is an array of exactly `START_NUMBERS.length - 1` steps, every `applyStep` is valid starting from `START_NUMBERS`, and the final single number hits the target
- `package.json`: `name: "number-crunch"`, `private: true`, `type: "module"`, `engines.node: ">=22"`. Scripts: `start: "node server/server.mjs"`, `test: "node --test test/"`, `preview: "node scripts/preview.mjs"`, `migrate: "node scripts/migrate.mjs"`, `deploy: "bash scripts/deploy.sh"`. Dependencies `@blackcat/auth: file:vendor/blackcat-auth-0.1.2.tgz` and `pg: ^8.16`; devDependency `@electric-sql/pglite: ^0.3.14`. Run `npm install` to create `package-lock.json`.

- [ ] **Step 1: Write the failing tests** in `test/game-rules.test.mjs`:
  - `ALL_TARGETS.length === 94`, and none of the unreachable numbers are in it.
  - Brute force: port an exact BigInt-rational search over all ways to combine `[1,2,3,4,5]` with `+ - * /` (every ordered pair at every level, no division by zero). Assert that the integers 0..100 it cannot reach are exactly `[...UNREACHABLE].sort((a, b) => a - b)`.
  - How to Play example, target 12: steps `{a:4,b:3,op:'+'}` gives `[1,2,3,9]`; `{a:3,b:2,op:'+'}` gives `[1,2,12]`; `{a:1,b:0,op:'-'}` gives `[12,1]`; `{a:0,b:1,op:'*'}` gives `[12]`. Assert each intermediate array, and that `verifySolution(12, steps) === true`.
  - `verifySolution` is false for: the right steps with the wrong target (13); 3 steps; 5 steps; `null`; a non-array; an unreachable target (76); a step with `a === b`; an index out of range; a non-integer index (`1.5`); an unknown op (`'^'`); division by zero (e.g. reach a 0 first with `{a:0,b:0}`... use `2-2` then divide by it).
  - `applyStep` does not mutate its input (deep-equal the input before and after).
  - Division producing a fraction works: `applyStep([1,3], {a:0,b:1,op:'/'})` deep-equals `[1/3]`. Also, `verifySolution(1, ...)` accepts a path through fractions, for example `1/3` then `×3` then `+(4-4)`. Compose any valid path; the test must contain a fraction step.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `public/game-rules.js`** per the interface.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add shared game rules module and project scaffold`.

### Task 2: Database schema and store

**Files:**
- Create: `migrations/001-number-crunch.sql`, `server/store.mjs`, `scripts/migrate.mjs`
- Test: `test/store.test.mjs`, `test/helpers/db.mjs` (PGlite harness)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `migrations/001-number-crunch.sql`. Wrap it in `BEGIN; SET LOCAL ROLE number_crunch_owner; … COMMIT;` and make it idempotent (`IF NOT EXISTS`). Tables:
    - `account_auth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT NOT NULL)` plus index `account_auth_state_expiry (expires_at)`. This is identical to The Grid's and is required by `@blackcat/auth/postgres`.
    - `players (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, legacy BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`
    - `best_times (player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, target SMALLINT NOT NULL CHECK (target BETWEEN 0 AND 100), best_ms INTEGER NOT NULL CHECK (best_ms > 0), solve_count INTEGER NOT NULL CHECK (solve_count > 0), best_at BIGINT NOT NULL, last_solved_at BIGINT NOT NULL, PRIMARY KEY (player_id, target))` plus index `best_times_leaderboard (target, best_ms, best_at)`
    - `rounds (id UUID PRIMARY KEY, player_id TEXT NOT NULL, target SMALLINT NOT NULL, started_at BIGINT NOT NULL)` plus index `rounds_started (started_at)`
    - `legacy_claims (email TEXT NOT NULL, legacy_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, claimed_by TEXT, claimed_at BIGINT, PRIMARY KEY (email, legacy_player_id))`
  - `server/store.mjs` exports `ROUND_TTL_MS = 86_400_000` and `createStore(db)`. Here `db` is anything with `query(text, params) → Promise<{ rows }>`, which covers both a `pg.Pool` and a PGlite instance. Every method is a single SQL statement, so no explicit transactions are needed (data-modifying CTEs where necessary). Methods:
    - `ensurePlayer(id: string, displayName: string, now: number): Promise<void>`: upsert; on conflict, update `display_name` and `updated_at`.
    - `claimLegacy(email: string, playerId: string, now: number): Promise<number>`: one statement. It marks unclaimed `legacy_claims` rows for `lower(email)` as claimed by `playerId`, deletes those legacy players' `best_times`, and upserts them into `playerId`'s rows. On conflict: `best_ms = LEAST`, `best_at` follows whichever row is faster (keep the old one on ties), `solve_count` is summed, and `last_solved_at = GREATEST`. When one email maps to several legacy players, collapse them per target first (min best with its `best_at`, summed counts, max last-solved). Returns the number of claims marked. The caller has already called `ensurePlayer(playerId, …)`.
    - `records(playerId: string): Promise<Record<number, {bestMs: number, solveCount: number}>>`
    - `leaderboard(target: number, limit = 5): Promise<Array<{playerId: string, name: string, ms: number}>>`: ordered by `best_ms`, then `best_at`, then `player_id`.
    - `globalBests(): Promise<Record<number, {playerId: string, name: string, ms: number}>>`: the top entry per target, with the same ordering (`DISTINCT ON (target)`).
    - `startRound(id: string, playerId: string, target: number, now: number): Promise<void>`
    - `takeRound(id: string, playerId: string): Promise<{target: number, startedAt: number} | null>`: an atomic `DELETE … WHERE id = $1 AND player_id = $2 RETURNING …`. It is single-use and bound to the player.
    - `recordSolve(playerId: string, target: number, ms: number, now: number): Promise<{bestMs: number, solveCount: number, personalBest: boolean}>`: upsert. `personalBest` is true when the row is new or `ms` is strictly below the previous best. Read the previous best inside the same statement through a CTE.
    - `purgeExpired(now: number): Promise<void>`: delete `account_auth_state` rows with `expires_at < now` and `rounds` with `started_at < now - ROUND_TTL_MS`.
    - All numeric outputs go through `Number()`.
  - `scripts/migrate.mjs` follows `C:/Users/roone/OneDrive/Documents/Code/theGrid/scripts/migrate-accounts.mjs` exactly, for every `.sql` file in `migrations/` in sorted order. It requires `MIGRATION_DATABASE_URL`, prints `Number Crunch migrations complete`, and on failure prints a generic message and exits 1 without echoing the error, because the error could contain the URL.
  - `test/helpers/db.mjs` exports `async function freshDb()`. It returns a PGlite instance with `CREATE ROLE number_crunch_owner` executed and the migration applied. If PGlite rejects `SET LOCAL ROLE`, the helper strips that one line before applying, and says so in a comment.

- [ ] **Step 1: Write failing tests** in `test/store.test.mjs`:
  - The migration applies twice without error, proving it is idempotent.
  - `recordSolve`: the first solve returns `{bestMs: 12000, solveCount: 1, personalBest: true}`. A slower 15000 returns `{bestMs: 12000, solveCount: 2, personalBest: false}`. A faster 9000 returns `{bestMs: 9000, solveCount: 3, personalBest: true}`. An equal 9000 gives `personalBest: false`. `records()` reflects this, and every field is `typeof 'number'`.
  - `leaderboard(12)` with 7 players returns 5, fastest first. On a tie it orders by the earlier `best_at`. Names come back verbatim, including `<img src=x onerror=alert(1)>`.
  - `globalBests()` returns one entry per solved target, and it is the fastest.
  - `ensurePlayer` rename: the leaderboard shows the new name.
  - `takeRound`: it returns `{target, startedAt}` once. The second call returns `null`. Another player's id returns `null`, and the round is still takeable by its owner afterwards.
  - `claimLegacy`:
    - Seed two legacy players: `legacy:a` with target 5 at 10000 ms ×2 and target 7 at 8000 ms ×1, and `legacy:b` with target 5 at 9000 ms ×1. Seed claims for `Owner@Example.com`, which the import stores lowercased, mapped to both.
    - Seed the user `u1` with target 7 at 7000 ms ×4.
    - `claimLegacy('owner@example.com', 'u1', now)` returns 2.
    - `records('u1')` is `{5: {bestMs: 9000, solveCount: 3}, 7: {bestMs: 7000, solveCount: 5}}`.
    - A second claim returns 0 and changes nothing.
    - Legacy players no longer appear in `leaderboard(5)`.
  - `purgeExpired` removes old rounds and expired auth state, and keeps fresh ones.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the migration, `server/store.mjs`, `scripts/migrate.mjs` and the helper.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `Add Number Crunch database schema and store`.

### Task 3: Firebase legacy import

**Files:**
- Create: `server/legacy-import.mjs`, `scripts/import-firebase.mjs`
- Test: `test/legacy-import.test.mjs`, `test/fixtures/firebase/{leaderboard,records,users,legacy-emails}.json`

**Interfaces:**
- Consumes: the Task 2 schema and `test/helpers/db.mjs` `freshDb()`.
- Produces:
  - `buildLegacyImport({leaderboard, records, users, emails, now}) → {players: [{id, displayName}], bestTimes: [{playerId, target, bestMs, solveCount, bestAt, lastSolvedAt}], claims: [{email, legacyPlayerId}]}`. Firebase shapes:
    - `leaderboard` is an ARRAY indexed by target, with `null` holes, OR an object keyed by target string. Each entry is `{[key]: {name?, time: seconds, timestamp}}`.
    - `records` is `{[key]: ARRAY-or-object indexed by target of {bestTime: seconds, solveCount, lastSolved}}`.
    - `users` is `{[key]: {displayName?, created, passHash?}}`. Never read or copy `passHash`.
    - `emails` is `{[key]: {email}}`.
  - Rules:
    - Player id `legacy:${key}`. Display name: `users[key].displayName`, else the leaderboard `name`, else `key`. Trim it and clamp it to 60 chars.
    - Skip targets that are not playable.
    - `bestMs = Math.round(seconds * 1000)`, and it must be at least 1. For each (key, target), take the min of the records `bestTime` and the leaderboard `time`.
    - `solveCount`: `records.solveCount` if it is at least 1, else 1.
    - `bestAt`: the timestamp of whichever source supplied the best time; `lastSolvedAt`: the max of the available timestamps. When a timestamp is missing, use `now`.
    - Claims: one per `emails` entry, with the email lowercased and trimmed.
  - `applyLegacyImport(db, data): Promise<{players, bestTimes, claims}>` inserts with `ON CONFLICT DO NOTHING`, so it is idempotent. Players get `legacy = true` and `created_at = updated_at = now`. It runs inside `BEGIN`/`COMMIT` when given a pg client. Simplest: `db.query('BEGIN')`, then the inserts, then `db.query('COMMIT')`, with `ROLLBACK` on error. It returns counts.
  - `scripts/import-firebase.mjs <snapshotDir>` reads the four JSON files from `snapshotDir`, connects with `MIGRATION_DATABASE_URL` (a `pg.Client`), runs `SET ROLE number_crunch_owner`, then `applyLegacyImport`, and prints only the counts. It never prints emails.
- Fixture: a trimmed copy of the real shape. Write it by hand; do not use real data. Leaderboard as an array with `null` holes. One legacy username key without `displayName` (for example `oldname`) whose leaderboard entry has no `name`. One uid-keyed user with a `displayName`. One target that appears in the leaderboard only. One record faster than its leaderboard entry. A `passHash` field. Emails for 2 of the players, one in mixed case.

- [ ] **Step 1: Write failing tests**:
  - `buildLegacyImport` on the fixture: the expected player ids and names (`oldname` falls back to its key); the min-of-both best times; the leaderboard-only target is included; the mixed-case email is lowercased; `JSON.stringify(result)` does not contain `passHash` or the hash value.
  - `applyLegacyImport` on `freshDb()`: the inserted counts are correct, `leaderboard()` from the store shows the legacy names, and running it twice leaves the counts unchanged.
  - End to end: import, then `ensurePlayer('u1')`, then `claimLegacy(<fixture email>, 'u1')`, which moves those times to `u1`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add Firebase legacy leaderboard import`.

### Task 4: HTTP application and server entry

**Files:**
- Create: `server/app.mjs`, `server/server.mjs`, `scripts/preview.mjs`
- Test: `test/app.test.mjs`

**Interfaces:**
- Consumes: `createStore` and `ROUND_TTL_MS` (Task 2); `isPlayableTarget` and `verifySolution` from `../public/game-rules.js` (Task 1).
- Produces:
  - `createApp({origin, getAuth, store, publicDir, vendorFiles, buildId, now = Date.now, randomId = crypto.randomUUID}) → (request: Request) => Promise<Response>`. `getAuth()` returns `{handle(request): Promise<Response|null>, session(request): Promise<Session|null>, accountUrl: string}` and may throw when accounts are unavailable. `Session` is `{user: {id, displayName, email, roles}, sid, expiresAt, reference}`. `vendorFiles` maps a URL path to an absolute file path, for example `{'/vendor/bcm-auth-browser.js': <resolved @blackcat/auth/browser file>}`.
  - Routes:

    | Method | Path | Response |
    | --- | --- | --- |
    | GET | `/api/health` | 200 `{ok: true, build}` |
    | any | `/api/auth/*` | `(await auth.handle(request)) ?? 404 {error:'not_found'}`, passed through UNCHANGED (no added headers). If `getAuth()` or `handle` throws: 503 `{error:'authentication_unavailable'}` |
    | GET | `/api/me` | No session: 200 `{user: null, accountUrl, records: {}}`. Session: `ensurePlayer(user.id, user.displayName, now)`, then `claimLegacy(user.email, user.id, now)` if an email is present, then 200 `{user: {id, displayName}, accountUrl, records}` where records is `{[target]: {bestMs, solveCount}}`. If auth throws: 503 `{error:'authentication_unavailable'}` |
    | GET | `/api/leaderboard/:target` | `:target` must match `^\d{1,3}$` and be playable, else 400 `{error:'invalid_target'}`. Returns 200 `{target, entries: [{name, ms, you}]}`, where `you` is true when the session user id equals `playerId`. A session lookup failure means `you: false`, not an error. `playerId` is NOT included |
    | GET | `/api/bests` | 200 `{bests: {[target]: {name, ms}}}` |
    | POST | `/api/rounds` | No session: 401 `{error:'authentication_required'}`. JSON body `{target}` must be playable, else 400 `{error:'invalid_target'}`. Calls `startRound(randomId(), …)` and returns 201 `{roundId}` |
    | POST | `/api/rounds/:id/finish` | No session: 401. `:id` must be a UUID, else 404 `{error:'round_not_found'}`. Body `{steps, clientMs}`; `clientMs` must be a finite number ≥ 0, else 400 `{error:'invalid_request'}`. `takeRound(id, user.id)`; null gives 404 `{error:'round_not_found'}`. `!verifySolution(round.target, steps)` gives 422 `{error:'invalid_solution'}`. Otherwise `serverMs = now() - round.startedAt` and `recordedMs = Math.max(1, Math.max(serverMs - 1500, Math.min(Math.round(clientMs), serverMs)))`. Then `ensurePlayer`, then `recordSolve`, and return 200 `{recordedMs, bestMs, solveCount, personalBest}` |
    | GET/HEAD | `/`, `/login` | `public/index.html` |
    | GET/HEAD | other paths | A vendor file, or a file under `publicDir`. Resolve the decoded path and require it to stay inside `publicDir`, with no dotfiles. Content types: `.html .js .css .svg .png .ico .json .txt`. A miss returns 404 with `public/404.html` |
    | other | API paths | 405 `{error:'method_not_allowed'}` |

  - Bad JSON or a non-object body on the POST API returns 400 `{error:'invalid_request'}`.
  - Responses the app produces (everything except auth passthrough) get these headers:
    - `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.blackcatmatrix.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`
    - `x-content-type-options: nosniff`, `referrer-policy: same-origin`, `x-frame-options: DENY`
    - Static files: `cache-control: no-cache`.
  - `server/server.mjs`:
    - If `APP_ENV_FILE` is set, call `process.loadEnvFile` on it. Require the six env vars; when one is missing, `getAuth` throws "Account configuration is incomplete", like The Grid's `server/auth.ts`.
    - `pg.Pool` with The Grid's settings (`max: 10`, `connectionTimeoutMillis: 5000`, `query_timeout: 5000`, `statement_timeout: 5000`, an error listener that logs `Number Crunch database unavailable`). Lazy `createAuth({..., allowHttpLocalhost: AUTH_ALLOW_HTTP_LOCALHOST === 'true', store: createPostgresAuthStore(pool)})`.
    - Node adapter: copy The Grid's `apps/web/server.ts` request conversion. Build the URL from the configured origin, reject a path that does not start with `/` (400), buffer POST bodies with a 16384-byte cap (413), and write multiple `set-cookie` headers correctly.
    - Port: `PORT`, or `3000` in production / `3110` otherwise.
    - `buildId` comes from the `.build-id` file at the repo root, else `'dev'`.
    - `vendorFiles['/vendor/bcm-auth-browser.js'] = fileURLToPath(import.meta.resolve('@blackcat/auth/browser'))`.
    - `store.purgeExpired(Date.now())` runs hourly; the timer is `unref()`'d and failures are swallowed with a generic log line.
    - SIGTERM/SIGINT: close the server, then `pool.end()`.
  - `scripts/preview.mjs [--as "Display Name"] [--port 3119]` is a dev-only UI preview. It uses `createApp` with an in-memory PGlite (`freshDb` from `test/helpers/db.mjs`), seeded with a few leaderboard rows, one of them with a hostile name. It uses a fake auth with a fixed `accountUrl`:
    - With `--as`: `session()` returns that user, and `handle()` answers `/api/auth/session` with that user.
    - Without `--as`: the session is null.
    - In both modes `handle()` answers `/api/auth/login` and `/api/auth/logout` with 303 to `/`.
    - It prints the URL.

- [ ] **Step 1: Write failing tests** in `test/app.test.mjs`, using `freshDb()`, a real store and a fake auth. Cover each table row above, plus:
  - 403 for a POST without `Origin`, and for one with the wrong `Origin`.
  - The backchannel POST without `Origin` reaches `auth.handle`.
  - Auth responses are passed through byte-for-byte: assert that a custom header from the fake survives and that no CSP is added.
  - `/api/me` claims legacy data: seed a legacy player and a claim, and the records appear.
  - The finish flow:
    - The happy path uses the How-to-Play steps for target 12.
    - A replay gives 404.
    - Another user's round gives 404.
    - Invalid steps give 422.
    - The clamp: with `now` stubbed so `serverMs = 10000`, `clientMs: 100` records 8500, `clientMs: 9800` records 9800, and `clientMs: 20000` records 10000.
  - `/api/leaderboard/abc`, `/api/leaderboard/76` and `/api/leaderboard/101` give 400.
  - A hostile name is returned verbatim.
  - The traversal paths from Review Focus give 404 and the body never contains `createApp`.
  - `/game-rules.js` is served as `text/javascript`, and `/vendor/bcm-auth-browser.js` is served from the map.
  - When `getAuth` throws, `/` still serves the page and `/api/me` gives 503.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/app.mjs`, `server/server.mjs` and `scripts/preview.mjs`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Also run `node scripts/preview.mjs` and `curl -s localhost:3119/api/health`, which should return `{"ok":true,...}`, then stop it.
- [ ] **Step 5: Commit** `Add Number Crunch server with shared account sign-in and verified solves`.

### Task 5: Front end: accounts UI, API integration, UI and game-flow fixes

**Files:**
- Modify: `public/index.html` (keep the CSS and markup; remove every inline `<script>` and every `onclick`/`oninput` attribute)
- Create: `public/app.js` (ES module, loaded with `<script type="module" src="/app.js">`), `public/favicon.svg`
- Replace: `public/404.html` (a page in the game's theme, "Page not found", with a link back to `/`)

**Interfaces:**
- Consumes: `public/game-rules.js` (`START_NUMBERS`, `UNREACHABLE`, `ALL_TARGETS`, `applyStep`, `isTargetHit`); `/vendor/bcm-auth-browser.js` (`openAccountWindow({next, register, onSignedIn, onError}) → cleanup`); the API from Task 4.
- Event wiring: use `data-action="<name>"` (plus `data-target`, `data-op` etc. as needed) and ONE delegated click listener with an actions map. The CSP forbids inline handlers.

Requirements. Each item is a checkable behavior:

1. **Boot:** the auth overlay shows "Checking your account…" until `/api/me` resolves.
   - A `user` enters the game.
   - No user and the URL has `auth_error`: clean the URL (`history.replaceState(null, '', '/')`) and show the sign-in options.
   - No user, no `auth_error`, and `sessionStorage['blackcat.sso.attempted.v1']` unset: set it, then `location.replace('/api/auth/login?next=%2F&silent=1')`. Wrap sessionStorage in try/catch; if it throws, skip silent SSO.
   - Otherwise, show the sign-in options.
   - On a `/login` path or an `error` query param, show "Sign-in did not finish. Please try again." and clean the URL to `/`.
   - When `/api/me` fails (503 or network error), show "Accounts are unavailable right now. You can still play as a guest."
2. **Sign-in box** (replaces the email, password, display-name, Google and Log In/Sign Up tabs):
   - Title "Number Crunch" and subtitle "Use +, −, ×, ÷ to hit the target".
   - The line "One Black Cat Matrix account works across our games."
   - Primary button "Sign in with Black Cat Matrix" and a text button "Create an account" (`register: true`).
   - The divider "or", then "Play as Guest" and "How to Play".
   - The footnote "Played before? Sign in with the same email and your old times come with you."
3. **Account window:** call `openAccountWindow` synchronously inside the click handler, with `next: '/'`. Show a small modal dialog (`<dialog>`, with Escape cancelling) titled "Black Cat Matrix".
   - While waiting: "Finish signing in in the Black Cat Matrix window. Your game stays here.", with the buttons "Reopen sign-in" and "Cancel".
   - On error: the helper's message, with "Try again" and "Cancel", plus the link "Continue in this tab" to `/api/auth/login?next=%2F` (with `&mode=register` for registration).
   - Keep the cleanup function, and call it on cancel or retry.
   - Key events inside the dialog must not reach the game's keyboard handler.
   - `onSignedIn`: reload `/api/me` and update the account state IN PLACE. Never reset the board or timer.
4. **Top bar:**
   - Guest: badge "👤 Guest", then "How to Play" and "Sign In" (opens the account window directly; the game is preserved).
   - Signed in: the badge "🏆 {displayName}" as a link to `accountUrl` (`target="_blank" rel="noopener"`, `title="Account settings"`), then "How to Play", "My Stats" and "Sign Out".
   - Sign Out: set the SSO flag, then submit a hidden native `<form method="post" action="/api/auth/logout">`. Never use fetch here.
   - At ≤ 520 px wide, the bar wraps cleanly: no horizontal scroll at 320 px, and the badge truncates with an ellipsis.
5. **Rounds:**
   - Every `newGame` for a signed-in user calls `POST /api/rounds {target}` and keeps that promise with its target. A round started as a guest has none.
   - Record steps from `history` as `{a, b, op}`. `a` and `b` are indices in selection order, the same indices `compute()` used. `compute()` must use `applyStep` from game-rules, and the win check uses `isTargetHit`.
   - Compute the final time exactly at the finishing compute (`(Date.now() - timerStart)`). Don't use the last 100 ms tick.
   - On a win, a signed-in user, and a round promise present: await it, then `POST /api/rounds/{id}/finish {steps, clientMs}`.
   - The result line under the time shows:
     - while waiting: "Saving your time…"
     - then "New personal best!" when `personalBest` is true
     - otherwise "Saved. Your best: {best}s"
     - on failure: "Couldn't save this time."
     - for a guest: "Sign in to save your times."
     - for a user with no round (signed in mid-round): "Times save from your next round."
   - Afterwards, refresh the leaderboard, the best-time line and the cached records.
6. **Leaderboard and stats:** these use the API. Names are always set with `textContent`. The leaderboard shows "Loading…" while fetching and "Couldn't load times." on error, and keeps "No times yet — be the first!" for an empty board. "(you)" comes from `you`. The stats "Global Best Times" grid shows the player NAME from `/api/bests`; it currently shows Firebase uids, which is a bug. Times are displayed as `(ms / 1000).toFixed(1) + 's'`.
7. **Game-flow fixes:**
   - (a) Tapping a number in My Stats while the start screen is showing must open the game. Add one `playTarget(n)` that hides the start screen, shows the game, closes overlays and calls `newGame(n)`. Use it from the stats grid, the picker and the result "Select Number" flow.
   - (b) Escape closes How to Play, Stats, Picker and the account dialog.
   - (c) Clicking an overlay's backdrop closes it.
   - (d) Game keys are ignored while any overlay, the auth screen or the start screen is up.
   - (e) Ctrl/Cmd+Z works with Shift or Caps Lock (`e.key.toLowerCase() === 'z'`).
   - (f) Keys `1`–`5` select the nth visible number tile.
   - (g) When focus is on a button, Enter or Space activates that button and does not also trigger compute.
   - (h) Remove the unused `streak` variable.
   - (i) Update the How to Play keyboard tip to "Tip: Keyboard works too: press 1–5 to pick numbers, + − * / for an operator, Enter to compute and Ctrl+Z to undo."
8. **Accessibility and mobile:**
   - Number tiles, picker cells and stats cells are `<button type="button">` elements, with CSS reset so they look identical to before.
   - Overlays have `role="dialog"`, `aria-modal="true"` and `aria-labelledby`.
   - At ≤ 480 px: tiles 58 px with a 0.5 rem gap, so 5 tiles fit on one row at 360 px.
   - Add `<link rel="icon" href="/favicon.svg">`. The favicon is a simple SVG: a rounded square in `#13131f` with a `÷` glyph in `#00e6a0`.
   - Add `<meta name="description" content="Combine 1–5 with +, −, ×, ÷ to hit the target number. A Black Cat Matrix game.">`.
9. No Firebase script or config remains anywhere in `public/`.

- [ ] **Step 1: Implement** `public/app.js`, and update `public/index.html`, `public/404.html` and `public/favicon.svg`.
- [ ] **Step 2: Verify** with `node scripts/preview.mjs` (guest) and `node scripts/preview.mjs --as "Tester"` (signed in).
  - Use the Playwright from `C:/ProgramData/BlackCatMatrix/accounts-test/browser-tools/node_modules/playwright`. Import it by absolute file URL from a script in the scratchpad, not the repo.
  - Script a guest round with the How-to-Play steps for target 12: pick it with "Select Number", then 12.
  - Script a signed-in round and assert that "New personal best!" appears and the leaderboard shows "Tester (you)".
  - Check that the hostile seeded name shows literally.
  - Check that there are no console errors or CSP violations.
  - Check that there is no horizontal scroll at 320/375/1280 px (`document.documentElement.scrollWidth <= innerWidth`).
  - Save screenshots at 375 and 1280 px to the scratchpad.
- [ ] **Step 3: Run** `npm test`. Expected: PASS (no regressions).
- [ ] **Step 4: Commit** `Move sign-in to Black Cat Matrix accounts and fix game flow issues`.

### Task 6: Packaging and deployment files

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `cloudflared/config.yml` (template only; the controller fills in the uuid), `scripts/deploy.sh`, `README.md`
- Modify: `firebase.json`, `.firebaserc` (left for the controller's Firebase step; do not touch them)

**Interfaces:**
- `Dockerfile`:
  - `FROM node:22-slim`, `WORKDIR /app`.
  - Copy `package.json`, `package-lock.json` and `vendor/`, then `npm ci --omit=dev`.
  - Copy `public/`, `server/`, `migrations/`, `scripts/migrate.mjs` and `scripts/import-firebase.mjs`.
  - Write `.build-id` with `date +%s%N | sha256sum | cut -c1-12`.
  - `ENV NODE_ENV=production PORT=3000`, `USER node`, `EXPOSE 3000`, `CMD ["node","server/server.mjs"]`.
  - `import-firebase.mjs` needs `server/legacy-import.mjs` and `pg`, both of which are present.
- `docker-compose.yml`: modelled on The Grid's, with project `name: numbercrunch`.
  - `web` reads `env_file: C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch.env`, publishes `127.0.0.1:3010:3000`, joins the networks `default` and external `bcm-apps` (alias `accounts`), and has the healthcheck `node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`. It uses json-file logging with 10m×3.
  - `web-dev` (profile `dev`) uses the same build, `env_file …/number-crunch.development.env`, `127.0.0.1:3110:3000`, and the same networks.
  - `cloudflared` is the same as The Grid's and depends on `web` being healthy.
- `cloudflared/config.yml`: `tunnel: REPLACE_WITH_UUID`, `credentials-file: /etc/cloudflared/REPLACE_WITH_UUID.json`, ingress `crunch.blackcatmatrix.com` to `http://web:3000`, then `http_status:404`.
- `scripts/deploy.sh`: The Grid's script with `npm test` in place of the typecheck/test steps, and health URL `http://127.0.0.1:3010/api/health`.
- `README.md`: What it is. Local dev (`npm install`, `npm test`, `npm run preview`). Accounts (env names, the protected file paths `C:/ProgramData/BlackCatMatrix/accounts/clients/number-crunch{,.development,.migration}.env`, clients `number-crunch`/`number-crunch-dev`). Database (migrate via `docker run --rm --network bcm-apps --env-file <migration env> numbercrunch-web node scripts/migrate.mjs`). Legacy import (one-time; snapshot in protected `C:/ProgramData/BlackCatMatrix/accounts/imports/number-crunch-firebase-20261023`). Deploy (`npm run deploy` from Git Bash). Tunnel recipe (route DNS by uuid). Rollback. Known limits.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Verify:** `docker compose config --quiet` exits 0. Never run `docker compose config` without `--quiet`, because it expands secrets. `docker build -t numbercrunch-web .` succeeds. `docker run --rm numbercrunch-web node -e "import('/app/server/app.mjs').then(()=>console.log('ok'))"` prints `ok`.
- [ ] **Step 3: Commit** `Add Docker, tunnel and deploy tooling for self-hosting`.

### Controller-only infrastructure (not dispatched; uses protected secrets)

1. Keycloak: create `number-crunch` and `number-crunch-dev` by cloning the live `the-grid` representation, with new URLs and a generated secret. Add the `game-admin` realm scope mapping. Add the secrets to `secrets.json`, and write `clients/number-crunch.env`, `number-crunch.development.env` and `number-crunch.migration.env`.
2. PostgreSQL: create the roles `number_crunch_owner`, `number_crunch_migration` and `number_crunch_runtime` and the database `number_crunch`, using the bootstrap SQL pattern.
3. blackCatAccounts repo: add `number_crunch` and `number-crunch` to `bootstrap.mjs`, the realm template, `backup.ps1`, `restore.ps1`, `runtime-smoke.mjs`, `admin.mjs status` and the README. Run its infrastructure tests and commit.
4. Run the migration, then import the Firebase snapshot.
5. Verify the dev container end to end with a disposable Keycloak user (create, sign in through the popup, play, save, then delete the user and its rows).
6. Create the tunnel, deploy, cut DNS `crunch.blackcatmatrix.com` over to the tunnel by uuid, and check production.
7. Firebase: deploy a "moved" page to the old hosting site, and close public reads of the old `users`, `records` and `leaderboard` paths while keeping `button`.
8. Merge to master and push.

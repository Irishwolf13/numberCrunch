import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb } from "./helpers/db.mjs";
import { createStore, ROUND_TTL_MS } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const ORIGIN = "https://crunch.example.test";
const ACCOUNT_URL = "https://accounts.example.test/realms/test/account/";
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const VENDOR_FILE = fileURLToPath(import.meta.resolve("@blackcat/auth/browser"));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.blackcatmatrix.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const HOSTILE = "<img src=x onerror=alert(1)>";
const HOW_TO_PLAY_12 = [{ a: 4, b: 3, op: "+" }, { a: 3, b: 2, op: "+" }, { a: 1, b: 0, op: "-" }, { a: 0, b: 1, op: "*" }];
const USERS = {
  ann: { id: "kc-ann", displayName: "Ann", email: "Ann@Example.com", roles: [] },
  bob: { id: "kc-bob", displayName: "Bob", email: null, roles: [] },
};
const AUTH_ROUTES = new Set(["/api/auth/session", "/api/auth/logout", "/api/auth/backchannel-logout"]);

function fakeAuth() {
  const auth = {
    accountUrl: ACCOUNT_URL,
    handled: [],
    async session(request) {
      const who = /(?:^|; )test-user=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      return USERS[who] ? { user: USERS[who], sid: "central-sid-secret", expiresAt: 9e15, reference: "ref-secret" } : null;
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (!AUTH_ROUTES.has(pathname)) return null;
      const response = new Response(`{"fake":"${pathname}"}`, { status: 299, headers: { "x-fake-auth": "1", "content-type": "application/json" } });
      auth.handled.push({ method: request.method, pathname, response });
      return response;
    },
  };
  return auth;
}

async function setup(options = {}) {
  const db = await freshDb();
  const store = createStore(db);
  const auth = fakeAuth();
  const clock = { now: 1_700_000_000_000 };
  const app = createApp({
    origin: ORIGIN, store, publicDir: PUBLIC_DIR, buildId: "test-build",
    vendorFiles: { "/vendor/bcm-auth-browser.js": VENDOR_FILE },
    getAuth: () => auth, now: () => clock.now, ...options,
  });
  return { db, store, auth, clock, app };
}

function request(path, { method = "GET", user, origin, body, type = "application/json" } = {}) {
  const headers = new Headers();
  if (user) headers.set("cookie", `theme=dark; test-user=${user}`);
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", type);
  return new Request(ORIGIN + path, { method, headers, body: body === undefined || typeof body === "string" ? body : JSON.stringify(body) });
}
const post = (path, body, options) => request(path, { method: "POST", origin: ORIGIN, body, ...options });
const result = async (res) => [res.status, await res.json()];

function assertAppHeaders(res) {
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
}

function assertJsonApi(res) {
  assertAppHeaders(res);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.match(res.headers.get("content-type"), /^application\/json/);
}

async function startRound(app, user, target) {
  const res = await app(post("/api/rounds", { target }, { user }));
  assert.equal(res.status, 201);
  return (await res.json()).roundId;
}
const finish = (app, id, body, user = "ann") => app(post(`/api/rounds/${id}/finish`, body, { user }));

test("health reports ok and the build", async () => {
  const { app } = await setup();
  const res = await app(request("/api/health"));
  assert.deepEqual(await result(res), [200, { ok: true, build: "test-build" }]);
  assertJsonApi(res);
});

test("auth routes pass the package response through unchanged", async () => {
  const { app, auth } = await setup();
  const res = await app(request("/api/auth/session"));
  assert.equal(res, auth.handled[0].response);
  assert.equal(res.status, 299);
  assert.equal(res.headers.get("x-fake-auth"), "1");
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(await res.text(), '{"fake":"/api/auth/session"}');
});

test("an auth route the package does not handle is a JSON 404", async () => {
  const { app } = await setup();
  const res = await app(request("/api/auth/nope"));
  assert.deepEqual(await result(res), [404, { error: "not_found" }]);
  assertJsonApi(res);
});

test("auth outages on auth routes give 503", async () => {
  const down = () => { throw new Error("Account configuration is incomplete"); };
  const broken = { ...fakeAuth(), handle: async () => { throw new Error("provider exploded"); } };
  for (const getAuth of [down, () => broken]) {
    const { app } = await setup({ getAuth });
    const res = await app(request("/api/auth/session"));
    assert.deepEqual(await result(res), [503, { error: "authentication_unavailable" }]);
    assertJsonApi(res);
  }
});

test("writes need the exact app Origin", async () => {
  const { app, auth, db } = await setup();
  for (const origin of [undefined, "https://evil.example", `${ORIGIN}/`, "null"]) {
    const res = await app(post("/api/rounds", { target: 12 }, { user: "ann", origin }));
    assert.deepEqual(await result(res), [403, { error: "forbidden" }]);
    assertJsonApi(res);
  }
  const logout = await app(request("/api/auth/logout", { method: "POST" }));
  assert.deepEqual(await result(logout), [403, { error: "forbidden" }]);
  const put = await app(request("/api/auth/backchannel-logout", { method: "PUT" }));
  assert.equal(put.status, 403);
  assert.equal(auth.handled.length, 0);
  assert.equal((await db.query("SELECT 1 FROM rounds")).rows.length, 0);
});

test("backchannel logout reaches the package without an Origin", async () => {
  const { app, auth } = await setup();
  const res = await app(request("/api/auth/backchannel-logout", { method: "POST", body: "logout_token=x", type: "application/x-www-form-urlencoded" }));
  assert.equal(res, auth.handled[0].response);
  assert.deepEqual(auth.handled.map((h) => [h.method, h.pathname]), [["POST", "/api/auth/backchannel-logout"]]);
});

test("me without a session is a guest", async () => {
  const { app } = await setup();
  const res = await app(request("/api/me"));
  assert.deepEqual(await result(res), [200, { user: null, accountUrl: ACCOUNT_URL, records: {} }]);
  assertJsonApi(res);
});

test("me registers the player, claims legacy times and exposes no email or session ids", async () => {
  const { app, db } = await setup();
  await db.query("INSERT INTO players (id, display_name, legacy, created_at, updated_at) VALUES ('legacy:ann', 'ann-old', true, 1, 1)");
  await db.query("INSERT INTO legacy_claims (email, legacy_player_id) VALUES ('ann@example.com', 'legacy:ann')");
  await db.query("INSERT INTO best_times (player_id, target, best_ms, solve_count, best_at, last_solved_at) VALUES ('legacy:ann', 12, 11900, 2, 5, 5)");
  const res = await app(request("/api/me", { user: "ann" }));
  const text = await res.text();
  assert.equal(res.status, 200);
  assertJsonApi(res);
  assert.deepEqual(JSON.parse(text), { user: { id: "kc-ann", displayName: "Ann" }, accountUrl: ACCOUNT_URL, records: { 12: { bestMs: 11900, solveCount: 2 } } });
  for (const secret of ["example.com", "central-sid-secret", "ref-secret", "legacy:ann"]) assert.equal(text.toLowerCase().includes(secret), false, secret);
  assert.equal((await db.query("SELECT display_name FROM players WHERE id = 'kc-ann'")).rows[0].display_name, "Ann");
  assert.equal((await db.query("SELECT claimed_by FROM legacy_claims")).rows[0].claimed_by, "kc-ann");
});

test("me works for an account without an email", async () => {
  const { app } = await setup();
  const res = await app(request("/api/me", { user: "bob" }));
  assert.deepEqual(await result(res), [200, { user: { id: "kc-bob", displayName: "Bob" }, accountUrl: ACCOUNT_URL, records: {} }]);
});

test("me gives 503 when accounts are unavailable", async () => {
  const down = () => { throw new Error("Account configuration is incomplete"); };
  const broken = { ...fakeAuth(), session: async () => { throw new Error("store down"); } };
  for (const getAuth of [down, () => broken]) {
    const { app } = await setup({ getAuth });
    const res = await app(request("/api/me", { user: "ann" }));
    assert.deepEqual(await result(res), [503, { error: "authentication_unavailable" }]);
    assertJsonApi(res);
  }
});

async function seedBoard(store) {
  await store.ensurePlayer("p-hostile", HOSTILE, 1);
  await store.recordSolve("p-hostile", 12, 9000, 2);
  await store.ensurePlayer("kc-ann", "Ann", 1);
  await store.recordSolve("kc-ann", 12, 9500, 3);
}

test("leaderboard returns names, times and you flags only, with hostile names verbatim", async () => {
  const { app, store } = await setup();
  await seedBoard(store);
  const res = await app(request("/api/leaderboard/12", { user: "ann" }));
  assert.deepEqual(await result(res), [200, { target: 12, entries: [{ name: HOSTILE, ms: 9000, you: false }, { name: "Ann", ms: 9500, you: true }] }]);
  assertJsonApi(res);
  const guest = await (await app(request("/api/leaderboard/12"))).json();
  assert.deepEqual(guest.entries.map((e) => e.you), [false, false]);
  assert.deepEqual((await (await app(request("/api/leaderboard/13"))).json()), { target: 13, entries: [] });
});

test("leaderboard treats a session lookup failure as not you", async () => {
  const broken = { ...fakeAuth(), session: async () => { throw new Error("store down"); } };
  for (const getAuth of [() => broken, () => { throw new Error("Account configuration is incomplete"); }]) {
    const { app, store } = await setup({ getAuth });
    await seedBoard(store);
    const res = await app(request("/api/leaderboard/12", { user: "ann" }));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).entries.map((e) => e.you), [false, false]);
  }
});

test("leaderboard rejects targets that are not playable", async () => {
  const { app } = await setup();
  for (const target of ["abc", "76", "101", "1000", "-1", "1e1", "12.0", "%31%32", ""]) {
    const res = await app(request(`/api/leaderboard/${target}`));
    assert.deepEqual(await result(res), [400, { error: "invalid_target" }], target);
    assertJsonApi(res);
  }
});

test("bests returns the fastest name and time per target", async () => {
  const { app, store } = await setup();
  await seedBoard(store);
  await store.recordSolve("kc-ann", 30, 20000, 4);
  const res = await app(request("/api/bests"));
  assert.deepEqual(await result(res), [200, { bests: { 12: { name: HOSTILE, ms: 9000 }, 30: { name: "Ann", ms: 20000 } } }]);
  assertJsonApi(res);
});

test("starting a round needs a session and a playable target", async () => {
  const { app, db, clock } = await setup();
  assert.deepEqual(await result(await app(post("/api/rounds", { target: 12 }))), [401, { error: "authentication_required" }]);
  for (const body of ["not json", "[]", "null", "12", ""]) {
    assert.deepEqual(await result(await app(post("/api/rounds", body, { user: "ann" }))), [400, { error: "invalid_request" }], body);
  }
  for (const body of [{ target: 76 }, { target: "12" }, { target: 12.5 }, { target: 101 }, {}]) {
    assert.deepEqual(await result(await app(post("/api/rounds", body, { user: "ann" }))), [400, { error: "invalid_target" }], JSON.stringify(body));
  }
  const res = await app(post("/api/rounds", { target: 12 }, { user: "ann" }));
  assert.equal(res.status, 201);
  assertJsonApi(res);
  const { roundId } = await res.json();
  assert.match(roundId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const { rows } = await db.query("SELECT player_id, target, started_at FROM rounds");
  assert.deepEqual(rows, [{ player_id: "kc-ann", target: 12, started_at: String(clock.now) }]);
});

test("rounds use the injected id generator", async () => {
  const { app } = await setup({ randomId: () => "44444444-4444-4444-8444-444444444444" });
  assert.equal(await startRound(app, "ann", 12), "44444444-4444-4444-8444-444444444444");
});

test("finishing a verified round records it once", async () => {
  const { app, clock } = await setup();
  const id = await startRound(app, "ann", 12);
  clock.now += 12_345;
  const res = await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 12_000 });
  assert.deepEqual(await result(res), [200, { recordedMs: 12_000, bestMs: 12_000, solveCount: 1, personalBest: true }]);
  assertJsonApi(res);
  assert.deepEqual(await result(await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 12_000 })), [404, { error: "round_not_found" }]);
  const me = await (await app(request("/api/me", { user: "ann" }))).json();
  assert.deepEqual(me.records, { 12: { bestMs: 12_000, solveCount: 1 } });
  const board = await (await app(request("/api/leaderboard/12", { user: "ann" }))).json();
  assert.deepEqual(board.entries, [{ name: "Ann", ms: 12_000, you: true }]);
});

test("another player's round is not found and records nothing", async () => {
  const { app, clock } = await setup();
  const id = await startRound(app, "ann", 12);
  clock.now += 5000;
  assert.deepEqual(await result(await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 5000 }, "bob")), [404, { error: "round_not_found" }]);
  assert.deepEqual((await (await app(request("/api/me", { user: "bob" }))).json()).records, {});
  assert.equal((await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 5000 })).status, 200);
});

test("invalid steps are rejected and use up the round", async () => {
  const { app, clock } = await setup();
  const wrongTarget = await startRound(app, "ann", 13);
  const garbage = await startRound(app, "ann", 12);
  clock.now += 5000;
  assert.deepEqual(await result(await finish(app, wrongTarget, { steps: HOW_TO_PLAY_12, clientMs: 5000 })), [422, { error: "invalid_solution" }]);
  assert.deepEqual(await result(await finish(app, garbage, { steps: [{ a: 0, b: 0, op: "+" }], clientMs: 5000 })), [422, { error: "invalid_solution" }]);
  assert.equal((await finish(app, garbage, { steps: HOW_TO_PLAY_12, clientMs: 5000 })).status, 404);
  assert.deepEqual((await (await app(request("/api/me", { user: "ann" }))).json()).records, {});
});

test("finish checks the session, round id and clientMs before using the round", async () => {
  const { app } = await setup();
  const id = await startRound(app, "ann", 12);
  assert.deepEqual(await result(await app(post(`/api/rounds/${id}/finish`, { steps: HOW_TO_PLAY_12, clientMs: 1 }))), [401, { error: "authentication_required" }]);
  for (const bad of ["abc", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "%31"]) {
    assert.deepEqual(await result(await finish(app, bad, { steps: HOW_TO_PLAY_12, clientMs: 1 })), [404, { error: "round_not_found" }], bad);
  }
  assert.deepEqual(await result(await finish(app, "55555555-5555-4555-8555-555555555555", { steps: HOW_TO_PLAY_12, clientMs: 1 })), [404, { error: "round_not_found" }]);
  for (const body of ["{", "[]", { steps: HOW_TO_PLAY_12 }, { steps: HOW_TO_PLAY_12, clientMs: -1 }, { steps: HOW_TO_PLAY_12, clientMs: "100" }, { steps: HOW_TO_PLAY_12, clientMs: null }]) {
    assert.deepEqual(await result(await finish(app, id, body)), [400, { error: "invalid_request" }], JSON.stringify(body));
  }
  assert.equal((await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 1 })).status, 200);
});

test("recorded time is bounded by the server clock", async () => {
  const { app, clock } = await setup();
  for (const [clientMs, recordedMs] of [[100, 8500], [9800, 9800], [20_000, 10_000]]) {
    const id = await startRound(app, "ann", 12);
    clock.now += 10_000;
    const res = await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs });
    assert.equal((await res.json()).recordedMs, recordedMs, `clientMs ${clientMs}`);
  }
  const instant = await startRound(app, "ann", 12);
  assert.equal((await (await finish(app, instant, { steps: HOW_TO_PLAY_12, clientMs: 0 })).json()).recordedMs, 1);
});

test("a round older than ROUND_TTL_MS cannot be finished", async () => {
  const { app, clock } = await setup();
  const id = await startRound(app, "ann", 12);
  clock.now += ROUND_TTL_MS + 1;
  assert.deepEqual(await result(await finish(app, id, { steps: HOW_TO_PLAY_12, clientMs: 5000 })), [404, { error: "round_not_found" }]);
});

test("API routes reject other methods and unknown API paths", async () => {
  const { app } = await setup();
  const cases = [
    [request("/api/rounds"), "POST"],
    [request("/api/rounds/44444444-4444-4444-8444-444444444444/finish"), "POST"],
    [post("/api/health", {}), "GET"],
    [request("/api/me", { method: "DELETE", origin: ORIGIN }), "GET"],
    [request("/api/bests", { method: "HEAD" }), "GET"],
  ];
  for (const [req, allow] of cases) {
    const res = await app(req);
    assert.equal(res.status, 405, `${req.method} ${req.url}`);
    assert.equal(res.headers.get("allow"), allow);
    if (req.method !== "HEAD") assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    assertJsonApi(res);
  }
  const res = await app(request("/api/nope"));
  assert.deepEqual(await result(res), [404, { error: "not_found" }]);
  assertJsonApi(res);
  const page = await app(post("/", {}));
  assert.deepEqual(await result(page), [405, { error: "method_not_allowed" }]);
});

test("the page is served at / and /login", async () => {
  const { app } = await setup();
  const page = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
  for (const path of ["/", "/login", "/login?error=invalid_callback"]) {
    const res = await app(request(path));
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assertAppHeaders(res);
    assert.equal(await res.text(), page);
  }
  const head = await app(request("/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.match(head.headers.get("content-type"), /^text\/html/);
  assert.equal(await head.text(), "");
});

test("static and vendor files are served with their types", async () => {
  const { app } = await setup();
  const rules = await app(request("/game-rules.js"));
  assert.equal(rules.status, 200);
  assert.match(rules.headers.get("content-type"), /^text\/javascript/);
  assert.equal(rules.headers.get("cache-control"), "no-cache");
  assertAppHeaders(rules);
  assert.equal(await rules.text(), readFileSync(join(PUBLIC_DIR, "game-rules.js"), "utf8"));
  const vendor = await app(request("/vendor/bcm-auth-browser.js"));
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get("content-type"), /^text\/javascript/);
  assertAppHeaders(vendor);
  assert.equal(await vendor.text(), readFileSync(VENDOR_FILE, "utf8"));
});

test("misses and traversal attempts give the 404 page", async () => {
  const { app } = await setup();
  const notFound = readFileSync(join(PUBLIC_DIR, "404.html"), "utf8");
  const paths = [
    "/../server/server.mjs", "/%2e%2e/package.json", "/public/../package.json",
    "/..%2fpackage.json", "/%2e%2e%2fserver%2fapp.mjs", "/..%5cpackage.json", "/x%5c..%5c..%5cpackage.json",
    "/%2e%2e%5c%2e%2e%5cpackage.json", "/..%2fnode_modules%2f%40blackcat%2fauth%2fdist%2fbrowser.js",
    "/%252e%252e/package.json", "/game-rules.js%00.html", "/%E0%A4%A", "/server/app.mjs", "/vendor/", "/missing.js",
    "//package.json", "/C:%5cWindows%5cwin.ini",
  ];
  for (const path of paths) {
    const res = await app(request(path));
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assertAppHeaders(res);
    const body = await res.text();
    assert.equal(body, notFound, path);
    assert.equal(body.includes("createApp"), false);
    assert.equal(body.includes('"dependencies"'), false);
  }
});

test("dotfiles and unlisted extensions are never served", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nc-public-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of [["index.html", "home"], ["404.html", "missing"], ["ok.txt", "fine"], [".secret.txt", "dot"], ["notes.md", "md"], ["logo.PNG", "png"]]) {
    await writeFile(join(dir, name), text);
  }
  const { app } = await setup({ publicDir: dir });
  const ok = await app(request("/ok.txt"));
  assert.match(ok.headers.get("content-type"), /^text\/plain/);
  assert.equal(await ok.text(), "fine");
  const png = await app(request("/logo.PNG"));
  assert.equal(png.headers.get("content-type"), "image/png");
  for (const path of ["/.secret.txt", "/%2esecret.txt", "/notes.md"]) {
    const res = await app(request(path));
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), "missing");
  }
});

test("the page still loads when accounts are unavailable", async () => {
  const { app } = await setup({ getAuth: () => { throw new Error("Account configuration is incomplete"); } });
  assert.equal((await app(request("/"))).status, 200);
  assert.equal((await app(request("/game-rules.js"))).status, 200);
  assert.equal((await app(request("/api/health"))).status, 200);
  assert.deepEqual(await result(await app(request("/api/me"))), [503, { error: "authentication_unavailable" }]);
  assert.deepEqual(await result(await app(post("/api/rounds", { target: 12 }))), [503, { error: "authentication_unavailable" }]);
});

test("store failures give a generic 500 and a generic log line", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failing = async () => { throw new Error("connect ECONNREFUSED postgres://runtime:hunter2@db/number_crunch"); };
  const { app } = await setup({ store: { globalBests: failing, leaderboard: failing } });
  for (const path of ["/api/bests", "/api/leaderboard/12"]) {
    const res = await app(request(path));
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { error: "internal_error" });
    assert.equal(text.includes("hunter2"), false);
    assertJsonApi(res);
  }
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["Number Crunch request failed"], ["Number Crunch request failed"]]);
});

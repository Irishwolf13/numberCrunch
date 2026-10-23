import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, applyMigration } from "./helpers/db.mjs";
import { createStore, ROUND_TTL_MS } from "../server/store.mjs";

async function setup() {
  const db = await freshDb();
  return { db, store: createStore(db) };
}

test("migration is idempotent", async () => {
  const { db } = await setup();
  await applyMigration(db);
});

test("recordSolve tracks best, count and personal best", async () => {
  const { store } = await setup();
  await store.ensurePlayer("u1", "Ann", 1);
  assert.deepEqual(await store.recordSolve("u1", 12, 12000, 10), { bestMs: 12000, solveCount: 1, personalBest: true });
  assert.deepEqual(await store.recordSolve("u1", 12, 15000, 11), { bestMs: 12000, solveCount: 2, personalBest: false });
  assert.deepEqual(await store.recordSolve("u1", 12, 9000, 12), { bestMs: 9000, solveCount: 3, personalBest: true });
  assert.deepEqual(await store.recordSolve("u1", 12, 9000, 13), { bestMs: 9000, solveCount: 4, personalBest: false });
  const records = await store.records("u1");
  assert.deepEqual(records, { 12: { bestMs: 9000, solveCount: 4 } });
  assert.equal(typeof records[12].bestMs, "number");
  assert.equal(typeof records[12].solveCount, "number");
});

test("leaderboard returns top 5, ties by earlier best_at, names verbatim", async () => {
  const { store } = await setup();
  const xss = "<img src=x onerror=alert(1)>";
  const times = [5000, 6000, 7000, 8000, 8000, 9000, 10000];
  for (const [i, ms] of times.entries()) {
    await store.ensurePlayer(`p${i}`, i === 0 ? xss : `P${i}`, 1);
    await store.recordSolve(`p${i}`, 12, ms, 100 + (i === 4 ? -50 : i));
  }
  const board = await store.leaderboard(12);
  assert.equal(board.length, 5);
  assert.deepEqual(board.map((r) => r.playerId), ["p0", "p1", "p2", "p4", "p3"]);
  assert.equal(board[0].name, xss);
  assert.equal(typeof board[0].ms, "number");
});

test("globalBests returns the fastest per target", async () => {
  const { store } = await setup();
  await store.ensurePlayer("a", "A", 1);
  await store.ensurePlayer("b", "B", 1);
  await store.recordSolve("a", 5, 4000, 1);
  await store.recordSolve("b", 5, 3000, 2);
  await store.recordSolve("a", 7, 2000, 3);
  assert.deepEqual(await store.globalBests(), {
    5: { playerId: "b", name: "B", ms: 3000 },
    7: { playerId: "a", name: "A", ms: 2000 },
  });
});

test("ensurePlayer rename shows on the leaderboard", async () => {
  const { store } = await setup();
  await store.ensurePlayer("a", "Old", 1);
  await store.recordSolve("a", 5, 4000, 1);
  await store.ensurePlayer("a", "New", 2);
  assert.equal((await store.leaderboard(5))[0].name, "New");
});

test("takeRound is single-use and bound to the player", async () => {
  const { store } = await setup();
  const id = "11111111-1111-4111-8111-111111111111";
  await store.startRound(id, "u1", 42, 500);
  assert.equal(await store.takeRound(id, "u2"), null);
  assert.deepEqual(await store.takeRound(id, "u1"), { target: 42, startedAt: 500 });
  assert.equal(await store.takeRound(id, "u1"), null);
});

test("startRound keeps only a player's three newest open rounds", async () => {
  const { db, store } = await setup();
  const ids = [1, 2, 3, 4, 5].map((n) => `${n}`.repeat(8) + "-0000-4000-8000-000000000000");
  const other = "99999999-9999-4999-8999-999999999999";
  await store.startRound(other, "u2", 12, 50);
  for (const [i, id] of ids.entries()) await store.startRound(id, "u1", 12, 100 + i);
  const { rows } = await db.query("SELECT id FROM rounds WHERE player_id = 'u1' ORDER BY started_at");
  assert.deepEqual(rows.map((r) => r.id), ids.slice(2));
  assert.equal(await store.takeRound(ids[0], "u1"), null);
  assert.equal(await store.takeRound(ids[1], "u1"), null);
  assert.deepEqual(await store.takeRound(ids[4], "u1"), { target: 12, startedAt: 104 });
  assert.deepEqual(await store.takeRound(other, "u2"), { target: 12, startedAt: 50 });
});

test("claimLegacy merges legacy records into the account once", async () => {
  const { db, store } = await setup();
  for (const id of ["legacy:a", "legacy:b"]) {
    await db.query("INSERT INTO players (id, display_name, legacy, created_at, updated_at) VALUES ($1, $1, true, 1, 1)", [id]);
    await db.query("INSERT INTO legacy_claims (email, legacy_player_id) VALUES ('owner@example.com', $1)", [id]);
  }
  const bt = "INSERT INTO best_times (player_id, target, best_ms, solve_count, best_at, last_solved_at) VALUES ($1,$2,$3,$4,$5,$5)";
  await db.query(bt, ["legacy:a", 5, 10000, 2, 100]);
  await db.query(bt, ["legacy:a", 7, 8000, 1, 100]);
  await db.query(bt, ["legacy:b", 5, 9000, 1, 100]);
  await store.ensurePlayer("u1", "Me", 1);
  await db.query(bt, ["u1", 7, 7000, 4, 100]);

  assert.equal(await store.claimLegacy("owner@example.com", "u1", 200), 2);
  const expected = { 5: { bestMs: 9000, solveCount: 3 }, 7: { bestMs: 7000, solveCount: 5 } };
  assert.deepEqual(await store.records("u1"), expected);
  assert.equal(await store.claimLegacy("owner@example.com", "u1", 300), 0);
  assert.deepEqual(await store.records("u1"), expected);
  assert.deepEqual((await store.leaderboard(5)).map((r) => r.playerId), ["u1"]);
});

test("purgeExpired drops old rounds and auth state, keeps fresh ones", async () => {
  const { db, store } = await setup();
  const now = 10 * ROUND_TTL_MS;
  const [oldId, newId] = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  await store.startRound(oldId, "u1", 1, now - ROUND_TTL_MS - 1);
  await store.startRound(newId, "u1", 1, now - 1000);
  await db.query("INSERT INTO account_auth_state (key, value, expires_at) VALUES ('old','v',$1), ('new','v',$2)", [now - 1, now + 1]);
  await store.purgeExpired(now);
  assert.equal(await store.takeRound(oldId, "u1"), null);
  assert.notEqual(await store.takeRound(newId, "u1"), null);
  const { rows } = await db.query("SELECT key FROM account_auth_state");
  assert.deepEqual(rows.map((r) => r.key), ["new"]);
});

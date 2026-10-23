import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb } from "./helpers/db.mjs";
import { createStore } from "../server/store.mjs";
import { buildLegacyImport, applyLegacyImport } from "../server/legacy-import.mjs";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/firebase/${n}.json`, import.meta.url), "utf8"));
const NOW = 1_800_000_000_000;
const snapshot = () => ({ leaderboard: load("leaderboard"), records: load("records"), users: load("users"), emails: load("legacy-emails"), now: NOW });
const bt = (r, id, target) => r.bestTimes.find((b) => b.playerId === id && b.target === target);

test("buildLegacyImport maps players, names and claims", () => {
  const r = buildLegacyImport(snapshot());
  assert.deepEqual(
    r.players.map((p) => [p.id, p.displayName]).sort(),
    [["legacy:ghostkey", "Ghost Player"], ["legacy:oldname", "oldname"], ["legacy:uidAnn001", "Ann Example"], ["legacy:uidBob002", "Bob Tester"]],
  );
  assert.deepEqual(r.claims.map((c) => [c.email, c.legacyPlayerId]).sort(), [["ann@example.com", "legacy:uidAnn001"], ["old.name@example.com", "legacy:oldname"]]);
  assert.equal(r.bestTimes.length, 7);
});

test("buildLegacyImport takes the min of records and leaderboard", () => {
  const r = buildLegacyImport(snapshot());
  // record faster than leaderboard
  assert.deepEqual(bt(r, "legacy:oldname", 12), { playerId: "legacy:oldname", target: 12, bestMs: 17000, solveCount: 3, bestAt: 1700000400000, lastSolvedAt: 1700000400000 });
  // leaderboard faster than record; best_at from leaderboard, last_solved from records
  assert.deepEqual(bt(r, "legacy:uidAnn001", 12), { playerId: "legacy:uidAnn001", target: 12, bestMs: 11900, solveCount: 2, bestAt: 1700000112000, lastSolvedAt: 1700000300000 });
  // leaderboard-only target, solveCount defaults to 1
  assert.deepEqual(bt(r, "legacy:oldname", 24), { playerId: "legacy:oldname", target: 24, bestMs: 30000, solveCount: 1, bestAt: 1700000024000, lastSolvedAt: 1700000024000 });
  // solveCount 0 becomes 1; records-only target; fractional seconds round
  assert.deepEqual(bt(r, "legacy:uidBob002", 30), { playerId: "legacy:uidBob002", target: 30, bestMs: 42123, solveCount: 1, bestAt: 1700000500000, lastSolvedAt: 1700000500000 });
  // sub-millisecond time clamps to 1
  assert.equal(bt(r, "legacy:uidBob002", 100).bestMs, 1);
});

test("buildLegacyImport skips unplayable targets and uses now for missing timestamps", () => {
  const r = buildLegacyImport(snapshot());
  assert.equal(r.bestTimes.some((b) => b.target === 76), false);
  const r2 = buildLegacyImport({ leaderboard: [null, { k: { time: 5 } }], records: {}, users: {}, emails: {}, now: NOW });
  assert.deepEqual(r2.bestTimes, [{ playerId: "legacy:k", target: 1, bestMs: 5000, solveCount: 1, bestAt: NOW, lastSolvedAt: NOW }]);
});

test("buildLegacyImport trims and clamps names, and never leaks passHash", () => {
  const r = buildLegacyImport({ leaderboard: [], records: {}, users: { a: { displayName: `  ${"x".repeat(80)}  ` } }, emails: {}, now: NOW });
  assert.equal(r.players[0].displayName, "x".repeat(60));
  const json = JSON.stringify(buildLegacyImport(snapshot()));
  assert.equal(json.includes("passHash"), false);
  assert.equal(json.includes(load("users").oldname.passHash), false);
});

const counts = async (db) => Object.fromEntries(await Promise.all(["players", "best_times", "legacy_claims"].map(async (t) => [t, Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)])));

test("applyLegacyImport inserts rows, is idempotent, and feeds the leaderboard", async () => {
  const db = await freshDb();
  assert.deepEqual(await applyLegacyImport(db, snapshot()), { players: 4, bestTimes: 7, claims: 2 });
  assert.deepEqual(await counts(db), { players: 4, best_times: 7, legacy_claims: 2 });
  const { rows } = await db.query("SELECT legacy, created_at, updated_at FROM players WHERE id = 'legacy:oldname'");
  assert.deepEqual(rows[0], { legacy: true, created_at: String(NOW), updated_at: String(NOW) });
  assert.deepEqual(
    (await createStore(db).leaderboard(12)).map((e) => [e.name, e.ms]),
    [["Ann Example", 11900], ["oldname", 17000], ["Ghost Player", 40000]],
  );
  await applyLegacyImport(db, snapshot());
  assert.deepEqual(await counts(db), { players: 4, best_times: 7, legacy_claims: 2 });
});

test("applyLegacyImport rolls back on error", async () => {
  const db = await freshDb();
  const failing = { query: (text, params) => (text.includes("legacy_claims") ? Promise.reject(new Error("boom")) : db.query(text, params)) };
  await assert.rejects(applyLegacyImport(failing, snapshot()), /boom/);
  assert.deepEqual(await counts(db), { players: 0, best_times: 0, legacy_claims: 0 });
});

test("a new account can claim an imported legacy email", async () => {
  const db = await freshDb();
  const store = createStore(db);
  await applyLegacyImport(db, snapshot());
  await store.ensurePlayer("u1", "Ann", 1);
  assert.equal(await store.claimLegacy("ann@example.com", "u1", 2), 1);
  assert.deepEqual(await store.records("u1"), { 12: { bestMs: 11900, solveCount: 2 }, 50: { bestMs: 25250, solveCount: 1 } });
  assert.deepEqual(await store.records("legacy:uidAnn001"), {});
});

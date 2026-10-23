import { isPlayableTarget } from "../public/game-rules.js";

const NAME_MAX = 60;
const ms = (seconds) => Math.max(1, Math.round(seconds * 1000));
const isTime = (t) => Number.isFinite(t) && t > 0;
// Firebase returns arrays with null holes, or objects keyed by index; both reduce to [index, value] pairs.
const entries = (x) => Object.entries(x ?? {}).filter(([, v]) => v != null);

export function buildLegacyImport({ leaderboard, records, users, emails, now }) {
  const names = new Map(); // key -> leaderboard name
  const cells = new Map(); // `${key}\0${target}` -> {key, target, rec, lb}
  const cell = (key, target) => {
    const id = `${key}\0${target}`;
    if (!cells.has(id)) cells.set(id, { key, target });
    return cells.get(id);
  };

  for (const [t, row] of entries(leaderboard)) {
    const target = Number(t);
    for (const [key, e] of entries(row)) {
      if (typeof e.name === "string" && e.name.trim() && !names.has(key)) names.set(key, e.name);
      if (isPlayableTarget(target) && isTime(e.time)) cell(key, target).lb = e;
    }
  }
  for (const [key, byTarget] of entries(records)) {
    for (const [t, r] of entries(byTarget)) {
      const target = Number(t);
      if (isPlayableTarget(target) && isTime(r.bestTime)) cell(key, target).rec = r;
    }
  }

  const keys = new Set([...Object.keys(users ?? {}), ...Object.keys(records ?? {}), ...names.keys(), ...Object.keys(emails ?? {}), ...[...cells.values()].map((c) => c.key)]);
  const players = [...keys].map((key) => {
    const name = [users?.[key]?.displayName, names.get(key)].find((n) => typeof n === "string" && n.trim());
    return { id: `legacy:${key}`, displayName: (name ?? key).trim().slice(0, NAME_MAX) };
  });

  const bestTimes = [...cells.values()].map(({ key, target, rec, lb }) => {
    const useLb = lb && (!rec || ms(lb.time) < ms(rec.bestTime));
    const best = useLb ? lb : rec;
    const stamps = [rec?.lastSolved, lb?.timestamp].filter(Number.isFinite);
    return {
      playerId: `legacy:${key}`,
      target,
      bestMs: ms(useLb ? lb.time : rec.bestTime),
      solveCount: rec?.solveCount >= 1 ? Math.floor(rec.solveCount) : 1,
      bestAt: (useLb ? best.timestamp : best.lastSolved) ?? now,
      lastSolvedAt: stamps.length ? Math.max(...stamps) : now,
    };
  });

  const claims = entries(emails)
    .filter(([, e]) => typeof e.email === "string" && e.email.trim())
    .map(([key, e]) => ({ email: e.email.trim().toLowerCase(), legacyPlayerId: `legacy:${key}` }));

  return { players, bestTimes, claims };
}

// db is anything with query(text, params): a single pg.Client in production, PGlite in tests.
export async function applyLegacyImport(db, data) {
  const { players, bestTimes, claims } = buildLegacyImport(data);
  const now = data.now;
  const run = async (text, params) => (await db.query(text, params)).rows;
  await db.query("BEGIN");
  try {
    // Only players inserted by this run get times and claims: a claimed legacy player keeps its row
    // but loses its times, so re-inserting them would duplicate a claimed account's records.
    const fresh = new Set(
      (await run(
        `INSERT INTO players (id, display_name, legacy, created_at, updated_at)
         SELECT id, name, true, $3::bigint, $3::bigint FROM unnest($1::text[], $2::text[]) AS t(id, name)
         ON CONFLICT DO NOTHING RETURNING id`,
        [players.map((p) => p.id), players.map((p) => p.displayName), now],
      )).map((r) => r.id),
    );
    const times = bestTimes.filter((b) => fresh.has(b.playerId));
    const newClaims = claims.filter((c) => fresh.has(c.legacyPlayerId));
    const out = {
      players: fresh.size,
      bestTimes: (await run(
        `INSERT INTO best_times (player_id, target, best_ms, solve_count, best_at, last_solved_at)
         SELECT * FROM unnest($1::text[], $2::smallint[], $3::int[], $4::int[], $5::bigint[], $6::bigint[])
         ON CONFLICT DO NOTHING RETURNING 1`,
        [times.map((b) => b.playerId), times.map((b) => b.target), times.map((b) => b.bestMs), times.map((b) => b.solveCount), times.map((b) => b.bestAt), times.map((b) => b.lastSolvedAt)],
      )).length,
      claims: (await run(
        `INSERT INTO legacy_claims (email, legacy_player_id)
         SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING RETURNING 1`,
        [newClaims.map((c) => c.email), newClaims.map((c) => c.legacyPlayerId)],
      )).length,
    };
    await db.query("COMMIT");
    return out;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

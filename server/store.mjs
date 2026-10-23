export const ROUND_TTL_MS = 86_400_000;
export const MAX_OPEN_ROUNDS = 3;

// best_at follows whichever time is faster; the old row wins ties.
const MERGE_BEST = `
  best_ms = LEAST(best_times.best_ms, EXCLUDED.best_ms),
  best_at = CASE WHEN EXCLUDED.best_ms < best_times.best_ms THEN EXCLUDED.best_at ELSE best_times.best_at END,
  last_solved_at = GREATEST(best_times.last_solved_at, EXCLUDED.last_solved_at)`;

const toEntry = (r) => ({ playerId: r.player_id, name: r.name, ms: Number(r.best_ms) });

export function createStore(db) {
  const q = async (text, params) => (await db.query(text, params)).rows;

  return {
    async ensurePlayer(id, displayName, now) {
      await q(
        `INSERT INTO players (id, display_name, created_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at`,
        [id, displayName, now],
      );
    },

    // Moves every unclaimed legacy record for this email into playerId's rows, in one statement.
    async claimLegacy(email, playerId, now) {
      const [row] = await q(
        `WITH claimed AS (
           UPDATE legacy_claims SET claimed_by = $2, claimed_at = $3
           WHERE email = lower($1) AND claimed_by IS NULL
           RETURNING legacy_player_id
         ), taken AS (
           DELETE FROM best_times WHERE player_id IN (SELECT legacy_player_id FROM claimed)
           RETURNING target, best_ms, solve_count, best_at, last_solved_at
         ), merged AS (
           SELECT DISTINCT ON (target) target, best_ms, best_at,
                  SUM(solve_count) OVER (PARTITION BY target) AS solve_count,
                  MAX(last_solved_at) OVER (PARTITION BY target) AS last_solved_at
           FROM taken ORDER BY target, best_ms, best_at
         ), moved AS (
           INSERT INTO best_times (player_id, target, best_ms, solve_count, best_at, last_solved_at)
           SELECT $2, target, best_ms, solve_count, best_at, last_solved_at FROM merged
           ON CONFLICT (player_id, target) DO UPDATE SET ${MERGE_BEST},
             solve_count = best_times.solve_count + EXCLUDED.solve_count
         )
         SELECT count(*) AS n FROM claimed`,
        [email, playerId, now],
      );
      return Number(row.n);
    },

    async records(playerId) {
      const rows = await q("SELECT target, best_ms, solve_count FROM best_times WHERE player_id = $1", [playerId]);
      return Object.fromEntries(
        rows.map((r) => [Number(r.target), { bestMs: Number(r.best_ms), solveCount: Number(r.solve_count) }]),
      );
    },

    async leaderboard(target, limit = 5) {
      const rows = await q(
        `SELECT b.player_id, p.display_name AS name, b.best_ms
         FROM best_times b JOIN players p ON p.id = b.player_id
         WHERE b.target = $1 ORDER BY b.best_ms, b.best_at, b.player_id LIMIT $2`,
        [target, limit],
      );
      return rows.map(toEntry);
    },

    async globalBests() {
      const rows = await q(
        `SELECT DISTINCT ON (b.target) b.target, b.player_id, p.display_name AS name, b.best_ms
         FROM best_times b JOIN players p ON p.id = b.player_id
         ORDER BY b.target, b.best_ms, b.best_at, b.player_id`,
      );
      return Object.fromEntries(rows.map((r) => [Number(r.target), toEntry(r)]));
    },

    // A player keeps at most MAX_OPEN_ROUNDS open: the new one plus their newest older ones.
    async startRound(id, playerId, target, now) {
      await q(
        `WITH pruned AS (
           DELETE FROM rounds WHERE id IN (
             SELECT id FROM rounds WHERE player_id = $2 ORDER BY started_at DESC, id DESC OFFSET $5
           )
         )
         INSERT INTO rounds (id, player_id, target, started_at) VALUES ($1, $2, $3, $4)`,
        [id, playerId, target, now, MAX_OPEN_ROUNDS - 1],
      );
    },

    async takeRound(id, playerId) {
      const [row] = await q(
        "DELETE FROM rounds WHERE id = $1 AND player_id = $2 RETURNING target, started_at",
        [id, playerId],
      );
      return row ? { target: Number(row.target), startedAt: Number(row.started_at) } : null;
    },

    async recordSolve(playerId, target, ms, now) {
      const [row] = await q(
        `WITH prev AS (
           SELECT best_ms FROM best_times WHERE player_id = $1 AND target = $2
         ), upserted AS (
           INSERT INTO best_times (player_id, target, best_ms, solve_count, best_at, last_solved_at)
           VALUES ($1, $2, $3, 1, $4, $4)
           ON CONFLICT (player_id, target) DO UPDATE SET ${MERGE_BEST},
             solve_count = best_times.solve_count + 1
           RETURNING best_ms, solve_count
         )
         SELECT u.best_ms, u.solve_count,
                NOT EXISTS (SELECT 1 FROM prev) OR $3 < (SELECT best_ms FROM prev) AS personal_best
         FROM upserted u`,
        [playerId, target, ms, now],
      );
      return { bestMs: Number(row.best_ms), solveCount: Number(row.solve_count), personalBest: row.personal_best };
    },

    async purgeExpired(now) {
      await q("DELETE FROM account_auth_state WHERE expires_at < $1", [now]);
      await q("DELETE FROM rounds WHERE started_at < $1", [now - ROUND_TTL_MS]);
    },
  };
}

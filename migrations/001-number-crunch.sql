BEGIN;
SET LOCAL ROLE number_crunch_owner;

-- Required by @blackcat/auth/postgres (identical to The Grid's)
CREATE TABLE IF NOT EXISTS account_auth_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_auth_state_expiry ON account_auth_state (expires_at);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  legacy BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS best_times (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target SMALLINT NOT NULL CHECK (target BETWEEN 0 AND 100),
  best_ms INTEGER NOT NULL CHECK (best_ms > 0),
  solve_count INTEGER NOT NULL CHECK (solve_count > 0),
  best_at BIGINT NOT NULL,
  last_solved_at BIGINT NOT NULL,
  PRIMARY KEY (player_id, target)
);
CREATE INDEX IF NOT EXISTS best_times_leaderboard ON best_times (target, best_ms, best_at);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY,
  player_id TEXT NOT NULL,
  target SMALLINT NOT NULL,
  started_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_started ON rounds (started_at);

CREATE TABLE IF NOT EXISTS legacy_claims (
  email TEXT NOT NULL,
  legacy_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  claimed_by TEXT,
  claimed_at BIGINT,
  PRIMARY KEY (email, legacy_player_id)
);
COMMIT;

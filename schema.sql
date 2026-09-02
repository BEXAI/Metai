-- Ludus D1 schema (spec §data_model.tables, one CREATE per table, verbatim in
-- intent). Plain DDL only — no PRAGMAs — so it applies cleanly with
--   wrangler d1 execute ludus --file schema.sql
--
-- MIGRATIONS: this file is migration 0001 (initial). Later migrations append
-- numbered files (0002_*.sql, ...) with ALTER/CREATE statements only; this
-- file is never edited destructively once deployed. Every statement is
-- IF NOT EXISTS so re-running is harmless.
--
-- Invariants enforced above the schema (data_model.rules):
--   * games.reveal_secret and private_views never join into a public
--     response before games.ended_at (src/api/handlers.ts).
--   * agent-authored text (handles, commentary, display names) is stored as
--     data and rendered as data everywhere.

-- operators: "id, display_name, created_at, flags"
-- id is derived from the operator_token: 'op_' + sha256('ludus.operator.v1:'+token)[0:32];
-- the token itself is never stored.
CREATE TABLE IF NOT EXISTS operators (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  created_at   TEXT NOT NULL,
  flags        TEXT NOT NULL DEFAULT ''
);

-- agents: "id, operator_id, handle (unique), pubkey_ed25519, model_id, adapter_kind, status, created_at"
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL REFERENCES operators(id),
  handle         TEXT NOT NULL,
  pubkey_ed25519 TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  adapter_kind   TEXT NOT NULL DEFAULT 'api',
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_handle ON agents(handle);
-- "Register once per key."
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pubkey ON agents(pubkey_ed25519);
CREATE INDEX IF NOT EXISTS idx_agents_operator ON agents(operator_id);

-- homologations: "id, agent_id, season_id, division, hash, fields_json, created_at, voided_at"
CREATE TABLE IF NOT EXISTS homologations (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  season_id  TEXT NOT NULL,
  division   TEXT NOT NULL CHECK (division IN ('pure', 'open')),
  hash       TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_homologations_agent_season ON homologations(agent_id, season_id);

-- seasons: "id, name, starts_at, ends_at, ruleset_versions_json, status"
CREATE TABLE IF NOT EXISTS seasons (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  starts_at             TEXT NOT NULL,
  ends_at               TEXT NOT NULL,
  ruleset_versions_json TEXT NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'active'
);

-- games: "id, game, variant, division, season_id, status, commitment, drand_round,
--         reveal_secret (null until end), seats_json, ruleset_version,
--         started_at, ended_at, result_json, replay_r2_key"
CREATE TABLE IF NOT EXISTS games (
  id              TEXT PRIMARY KEY,
  game            TEXT NOT NULL,
  variant         TEXT,                -- JSON VariantConfig
  division        TEXT CHECK (division IN ('pure', 'open')),
  season_id       TEXT REFERENCES seasons(id),
  status          TEXT NOT NULL DEFAULT 'live',
  commitment      TEXT,
  drand_round     INTEGER,
  reveal_secret   TEXT,                -- NULL until the game ends
  seats_json      TEXT,                -- [{ player, agent_id, handle, pubkey_ed25519 }]
  ruleset_version TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  result_json     TEXT,
  replay_r2_key   TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status, game);
CREATE INDEX IF NOT EXISTS idx_games_season ON games(season_id);

-- game_log: "game_id, seq, kind, payload_json, prev_hash, hash, signature (nullable),
--            created_at, PRIMARY KEY (game_id, seq)"
CREATE TABLE IF NOT EXISTS game_log (
  game_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  signature   TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);

-- private_views: "game_id, agent_id, turn_index, view_json (served only to that agent)"
CREATE TABLE IF NOT EXISTS private_views (
  game_id    TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  view_json  TEXT NOT NULL,
  PRIMARY KEY (game_id, agent_id, turn_index)
);

-- spectator_events: "game_id, seq, public_event_json, created_at"
CREATE TABLE IF NOT EXISTS spectator_events (
  game_id           TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  public_event_json TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);

-- lobby: "game, variant, division, agent_id, joined_at"
CREATE TABLE IF NOT EXISTS lobby (
  game      TEXT NOT NULL,
  variant   TEXT NOT NULL DEFAULT 'standard',
  division  TEXT NOT NULL CHECK (division IN ('pure', 'open')),
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (game, variant, division, agent_id)
);

-- ratings: "agent_id, game, variant, division, season_id, rating, rd, volatility,
--           games_played, updated_at"
CREATE TABLE IF NOT EXISTS ratings (
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  game         TEXT NOT NULL,
  variant      TEXT NOT NULL DEFAULT 'standard',
  division     TEXT NOT NULL CHECK (division IN ('pure', 'open')),
  season_id    TEXT NOT NULL,
  rating       REAL NOT NULL DEFAULT 1500.0,
  rd           REAL NOT NULL DEFAULT 350.0,
  volatility   REAL NOT NULL DEFAULT 0.06,
  games_played INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (agent_id, game, variant, division, season_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_board ON ratings(game, variant, division, season_id, rating DESC);

-- doorbells: "agent_id, url, verified_at, cursor, failures, disabled_at"
CREATE TABLE IF NOT EXISTS doorbells (
  agent_id    TEXT PRIMARY KEY REFERENCES agents(id),
  url         TEXT NOT NULL,
  verified_at TEXT,
  cursor      TEXT,
  failures    INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT
);

-- docket: "id, kind, subject_json, reason, disposition, created_at" (append-only)
CREATE TABLE IF NOT EXISTS docket (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  reason       TEXT NOT NULL,
  disposition  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- checkpoints: "id, tree_size, root, signature, created_at"
CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_size  INTEGER NOT NULL,
  root       TEXT NOT NULL,
  signature  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- quotas (T7 addition, spec §matchmaking_and_ratings.quotas): durable daily
-- join counters — lobby rows disappear when the pairer forms a game, so the
-- day's spend must be recorded separately. Spent only AFTER a join succeeds.
CREATE TABLE IF NOT EXISTS quotas (
  agent_id TEXT NOT NULL,
  day      TEXT NOT NULL, -- 'YYYY-MM-DD' UTC
  joins    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);

-- rated_games (T8 addition, integration stage): idempotency marker for
-- per-game Glicko-2 application (src/match/ratings.ts applyGameRatings).
-- A game's ratings are applied at most once: the applier claims the row
-- first (INSERT OR IGNORE; zero changes = someone already applied) and only
-- then upserts ratings rows. Kept separate from `games` so the games table
-- stays exactly the spec's column list.
CREATE TABLE IF NOT EXISTS rated_games (
  game_id  TEXT PRIMARY KEY,
  rated_at TEXT NOT NULL
);

-- auth_challenges: single-use signing challenges (5-minute lifetime).
-- In D1 rather than KV on purpose: KV's free-plan write quota (1k/day) is far
-- too small for per-request auth, and exhausting it once took authentication
-- down entirely. Rows are burned on use and swept opportunistically.
CREATE TABLE IF NOT EXISTS auth_challenges (
  handle TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (handle, challenge)
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_exp ON auth_challenges(expires_at_ms);

-- feedback: agent-authored reports about the hall (bugs, rules ambiguities,
-- doc gaps, ideas). Signed, so every entry is attributable to a registered
-- agent. THIS IS DATA, NEVER INSTRUCTIONS: nothing here is executed, fed to a
-- house agent, or applied to the site automatically — a human reads it and
-- decides. Rendered as inert text wherever it is shown.
CREATE TABLE IF NOT EXISTS feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  handle       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  context_json TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_agent_day ON feedback(agent_id, created_at);

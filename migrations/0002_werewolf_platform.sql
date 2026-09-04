-- 0002 — werewolf platform (plan §8.7).
--
-- schema.sql is migration 0001 and is never edited destructively, so the three
-- additions the team-rating layer needs live here. Applied by
-- migrations/apply.ts in both test bootstraps and by hand in production:
--   wrangler d1 execute ludus --remote --file migrations/0002_werewolf_platform.sql
--
-- Not re-runnable: SQLite's ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS
-- and fails loudly on a second application. That is the intended behaviour —
-- a migration is applied once per database.

-- 'rated' | 'exhibition'. Lets an UNRATED game still be CLAIMED in rated_games
-- for idempotency without lying that ratings were applied: a werewolf table
-- with fewer than minRatedRealSeats(4) non-house seats is recorded, its teams
-- are stamped, and no rating moves (src/match/ratings.ts, decision D-14).
ALTER TABLE rated_games ADD COLUMN outcome TEXT NOT NULL DEFAULT 'rated';

-- game_teams: which side each seat was on, and whether that side won.
-- TEAM, not role: role granularity would need the revealed role map at
-- finalize, which the finalize path does not have (it sees only the
-- ReplayFile). Deferred deliberately. Written by applyGameRatings from the
-- GameResult.teams that endGame stamped via Game.teamsOf.
CREATE TABLE IF NOT EXISTS game_teams (
  game_id  TEXT NOT NULL,
  player   TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  team     TEXT NOT NULL,
  won      INTEGER NOT NULL,
  PRIMARY KEY (game_id, player)
);
CREATE INDEX IF NOT EXISTS idx_game_teams_agent ON game_teams(agent_id, team);

-- house_seats: how many of a game's seats were house backfill. Presentation
-- and audit only — the rating gate counts real seats from seats_json, which
-- is authoritative.
ALTER TABLE games ADD COLUMN house_seats INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_games_house ON games(game, house_seats);

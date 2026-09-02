/**
 * Inline test fixture: a tiny deterministic game implementing the full Game
 * contract, so room/agent tests do not depend on any game track landing.
 *
 * Rules: players alternate playing 'a' or 'b'; every applied move rolls a
 * seeded d6 (purpose `roll:turn:<n>`); after `limit` applied moves (variant,
 * default 5) the game ends and the LAST mover wins ('turn_limit').
 * Variant { simultaneous: true } makes the FIRST turn a simultaneous phase:
 * both players must submit one move under a single shared deadline (the
 * islanders discard-half trap in miniature).
 *
 * Hidden information (for gate A10): each player holds a distinctive probe
 * string `SECRET_<player>_TOKEN_DO_NOT_LEAK` visible only in their own
 * private view / private render — never in publicView, renderText(state,
 * null), or another player's view.
 */

import {
  playerId,
  type AnyGame,
  type GameEvent,
  type GameMeta,
  type GameResult,
  type Json,
  type PlayerId,
  type SeedStream,
  type VariantConfig,
} from '../../kernel/types.ts';

type MiniState = {
  players: PlayerId[];
  seq: { player: PlayerId; m: string }[];
  hidden: Record<string, string>;
  simul: boolean;
  simulDone: Record<string, boolean>;
  limit: number;
  lastRoll: number | null;
  layout: number;
};

export function secretProbe(player: PlayerId): string {
  return `SECRET_${player}_TOKEN_DO_NOT_LEAK`;
}

const meta: GameMeta = {
  id: 'mini',
  name: 'Mini Test Game',
  players: { min: 2, max: 2 },
  information: 'hidden',
  randomness: 'dice',
  variants: {
    simultaneous: { description: 'first turn is a simultaneous phase', values: [false, true], default: false },
    limit: { description: 'applied moves until the game ends', values: [5, 9], default: 5 },
  },
  notation: "single letter 'a' or 'b'",
  boardText: 'one line listing the moves played so far',
  listed: false,
};

function st(state: Json): MiniState {
  return state as MiniState;
}

function simulActive(s: MiniState): boolean {
  return s.simul && s.players.some((p) => s.simulDone[p] !== true);
}

function playersToMove(s: MiniState): PlayerId[] {
  if (s.seq.length >= s.limit) return [];
  if (simulActive(s)) return s.players.filter((p) => s.simulDone[p] !== true);
  const idx = s.seq.length % s.players.length;
  return [s.players[idx]!];
}

function makeGame(withDefault: boolean): AnyGame {
  const game: AnyGame = {
    meta,

    initialState(seed: SeedStream, players: PlayerId[], variant: VariantConfig): Json {
      const hidden: Record<string, string> = {};
      const simulDone: Record<string, boolean> = {};
      for (const p of players) {
        hidden[p] = secretProbe(p);
        simulDone[p] = false;
      }
      const state: MiniState = {
        players: players.slice(),
        seq: [],
        hidden,
        simul: variant['simultaneous'] === true,
        simulDone,
        limit: typeof variant['limit'] === 'number' ? variant['limit'] : 5,
        lastRoll: null,
        layout: seed.int('setup:layout', 4),
      };
      return state as Json;
    },

    playersToMove(state) {
      return playersToMove(st(state));
    },

    legalMoves(state, player) {
      const s = st(state);
      if (!playersToMove(s).includes(player)) return [];
      return [{ m: 'a' }, { m: 'b' }] as Json[];
    },

    apply(state, player, move, seed) {
      const s = st(state);
      if (!playersToMove(s).includes(player)) {
        return { error: true, code: 'not_to_move', message: `${player} is not to move` };
      }
      const m = (move as { m?: unknown }).m;
      if (m !== 'a' && m !== 'b') {
        return { error: true, code: 'bad_move', message: `move must be 'a' or 'b'` };
      }
      const roll = seed.die(`roll:turn:${s.seq.length}`, 6);
      const next: MiniState = {
        ...s,
        seq: [...s.seq, { player, m }],
        simulDone: simulActive(s) ? { ...s.simulDone, [player]: true } : s.simulDone,
        lastRoll: roll,
      };
      const events: GameEvent[] = [
        { type: 'played', data: { player, m, roll }, visibility: 'public' },
        // Private-event probe (gate A10): carries the mover's secret token.
        // It must reach the log (replay, post-end) but NEVER the live
        // spectator feed.
        {
          type: 'peek',
          data: { player, secret: s.hidden[player] ?? null },
          visibility: 'private',
          to: [player],
        },
      ];
      return { state: next as Json, events };
    },

    isTerminal(state): GameResult | null {
      const s = st(state);
      if (s.seq.length < s.limit) return null;
      const last = s.seq[s.seq.length - 1]!;
      return { winners: [last.player], draw: false, reason: 'turn_limit' };
    },

    publicView(state) {
      const s = st(state);
      return {
        phase: simulActive(s) ? 'discard' : 'play',
        moves: s.seq.map((e) => `${e.player}:${e.m}`),
        count: s.seq.length,
        last_roll: s.lastRoll,
        layout: s.layout,
      };
    },

    privateView(state, player) {
      const s = st(state);
      return { secret: s.hidden[player] ?? null };
    },

    renderText(state, viewer) {
      const s = st(state);
      const line = s.seq.map((e) => `${e.player}${e.m}`).join(' ') || '(empty)';
      const base = `mini[${s.seq.length}/${s.limit}] ${line} roll=${s.lastRoll ?? '-'}`;
      if (viewer === null) return base;
      return `${base}\nyour secret: ${s.hidden[viewer] ?? '?'}`;
    },

    encodeState(state) {
      return JSON.stringify(state);
    },
    decodeState(encoded) {
      return JSON.parse(encoded) as Json;
    },

    parseMove(input, _state, _player) {
      const t = input.trim();
      if (t === 'a' || t === 'b') return { m: t } as Json;
      return { parseError: true, message: `unknown notation '${input}' (expected 'a' or 'b')` };
    },

    moveToNotation(move) {
      return String((move as { m?: unknown }).m);
    },

    moveSummary(move) {
      return `plays ${String((move as { m?: unknown }).m)}`;
    },
  };

  if (withDefault) {
    game.defaultMove = (_state, _player, legal) => legal[0]!; // deterministic: 'a'
  }
  return game;
}

/** The standard fixture: has defaultMove (timeouts apply 'a'). */
export const miniGame: AnyGame = makeGame(true);
/** Same rules but no defaultMove (timeouts apply a seeded random legal move). */
export const miniGameNoDefault: AnyGame = makeGame(false);

export const P0: PlayerId = playerId(0);
export const P1: PlayerId = playerId(1);

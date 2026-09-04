/**
 * OCTO — the fixture for the room engine's optional hooks, modelled on
 * mini-game.ts.
 *
 * It exists so the ENGINE CHANGES LAND AND ARE REVIEWED BEFORE ANY GAME DOES.
 * `octoGame` turns every optional hook ON; `octoGameBare` has identical rules
 * with every hook OFF and the meta flags absent. Each hook assertion is written
 * as an octoGame/octoGameBare PAIR, so the same test that proves a hook works
 * also proves the games that do not implement it are unaffected.
 *
 * Rules (deliberately minimal, chosen only to exercise engine paths):
 *   - 4..8 seats. Two phases repeat: `gather`, in which EVERY living seat is a
 *     mover under one shared deadline (the simultaneous path), and `lead`, in
 *     which exactly the lowest living seat moves alone (the sequential path).
 *   - A move is 'a' or 'b' plus optional text. 'c' PARSES but apply() rejects
 *     it — the only way to reach the "resolved fine, apply said no" branch of
 *     the room's illegal-move policy.
 *   - variant { shift: true } additionally makes 'b' illegal once another seat
 *     has already committed 'b' this round. That is exactly the rule a real
 *     simultaneous game must never have, and it is here on purpose: it is the
 *     only way to make a legally-held submission become illegal by the time the
 *     phase resolves.
 *   - After `rounds` rounds (variant, default 4) everyone still seated wins.
 *     With one seat or fewer left, the survivors win immediately.
 *
 * Hooks on `octoGame` only: forfeitPlayer (elimination instead of a table-wide
 * forfeit), phaseBudgetMs (gather 20 s, lead 5 s — both different from any
 * perMoveMs a test passes), speechInfo + bindUtterance, privateMessages,
 * teamsOf, revealOnEnd; plus meta.speechLimit, meta.historyWindow,
 * meta.allowsResign: false and meta.allowsDrawOffer: false.
 *
 * Hidden information (for leakage probes): each seat holds a distinctive
 * `OCTO_SECRET_<player>_DO_NOT_LEAK` string, visible only in its own private
 * view and in the post-end reveal.
 */

import {
  playerId,
  type AnyGame,
  type GameEvent,
  type GameMeta,
  type GameResult,
  type Json,
  type PlayerId,
  type PrivateMessage,
  type SeedStream,
  type SpeechChannel,
  type VariantConfig,
} from '../../kernel/types.ts';

type OctoPhase = 'gather' | 'lead' | 'over';

type OctoSlot = { m: string; text: string };

type OctoState = {
  players: PlayerId[];
  alive: Record<string, boolean>;
  hidden: Record<string, string>;
  phase: OctoPhase;
  round: number;
  rounds: number;
  shift: boolean;
  /** Per-phase slot map: key-presence IS the slot, exactly like werewolf's. */
  slots: Record<string, OctoSlot>;
  said: { round: number; player: PlayerId; m: string; text: string }[];
  leader: PlayerId | null;
  leaderDone: boolean;
  gone: PlayerId[];
  layout: number;
};

export function octoSecretProbe(player: PlayerId): string {
  return `OCTO_SECRET_${player}_DO_NOT_LEAK`;
}

/** Text accepted in the current phase (the speech channel's live limit). */
export function octoCapFor(phase: OctoPhase): number {
  return phase === 'gather' ? 40 : phase === 'lead' ? 20 : 0;
}

const MAX_TEXT = 40;

function st(state: Json): OctoState {
  return state as unknown as OctoState;
}

function living(s: OctoState): PlayerId[] {
  return s.players.filter((p) => s.alive[p] === true);
}

function terminal(s: OctoState): GameResult | null {
  const alive = living(s);
  if (alive.length <= 1) return { winners: alive, draw: false, reason: 'last_standing' };
  if (s.round >= s.rounds) return { winners: alive, draw: false, reason: 'round_limit' };
  return null;
}

function toMove(s: OctoState): PlayerId[] {
  if (s.phase === 'over') return [];
  if (terminal(s) !== null) return [];
  const alive = living(s);
  if (s.phase === 'gather') return alive.filter((p) => s.slots[p] === undefined);
  return s.leader !== null && s.alive[s.leader] === true && !s.leaderDone ? [s.leader] : [];
}

function bCommitted(s: OctoState, except: PlayerId): boolean {
  for (const p of living(s)) {
    if (p !== except && s.slots[p]?.m === 'b') return true;
  }
  return false;
}

function moveOptions(s: OctoState, player: PlayerId): OctoSlot[] {
  const out: OctoSlot[] = [{ m: 'a', text: '' }];
  if (!s.shift || !bCommitted(s, player)) out.push({ m: 'b', text: '' });
  return out;
}

/**
 * Advances the phase only when the LAST slot of the current one is filled, and
 * repeats so a cascade completes inside a single apply(). Also runs after
 * forfeitPlayer, which is what guarantees the invariant on return:
 * phase === 'over' || toMove(s).length > 0.
 */
function settle(s: OctoState, events: GameEvent[]): void {
  for (let guard = 0; guard < 16; guard++) {
    if (s.phase === 'over') return;
    if (terminal(s) !== null) {
      s.phase = 'over';
      return;
    }
    const alive = living(s);
    if (s.phase === 'gather') {
      if (alive.some((p) => s.slots[p] === undefined)) return;
      // Drained in SEAT ORDER so the state hash cannot depend on the order in
      // which the room happened to replay the held submissions.
      for (const p of alive) {
        const slot = s.slots[p]!;
        s.said.push({ round: s.round, player: p, m: slot.m, text: slot.text });
        events.push({
          type: 'said',
          data: { round: s.round, player: p, m: slot.m, text: slot.text },
          visibility: 'public',
        });
      }
      s.slots = {};
      s.leader = alive[0] ?? null;
      s.leaderDone = s.leader === null;
      s.phase = 'lead';
      continue;
    }
    if (s.phase === 'lead') {
      if (s.leader !== null && s.alive[s.leader] === true && !s.leaderDone) return;
      s.round += 1;
      s.phase = 'gather';
      s.slots = {};
      s.leader = null;
      s.leaderDone = false;
      continue;
    }
    return;
  }
}

function makeGame(withHooks: boolean): AnyGame {
  const meta: GameMeta = {
    id: 'octo',
    name: 'Octo Test Game',
    players: { min: 4, max: 8 },
    information: 'hidden',
    randomness: 'dice',
    variants: {
      rounds: { description: 'gather/lead cycles until the game ends', values: [2, 4], default: 4 },
      shift: { description: "a held 'b' can become illegal", values: [false, true], default: false },
    },
    notation: `'a' or 'b', optionally followed by a JSON string of text`,
    boardText: 'one line per completed round',
    listed: false,
  };
  if (withHooks) {
    meta.speechLimit = MAX_TEXT;
    meta.historyWindow = 3;
    meta.allowsResign = false;
    meta.allowsDrawOffer = false;
  }

  const game: AnyGame = {
    meta,

    initialState(seed: SeedStream, players: PlayerId[], variant: VariantConfig): Json {
      const alive: Record<string, boolean> = {};
      const hidden: Record<string, string> = {};
      for (const p of players) {
        alive[p] = true;
        hidden[p] = octoSecretProbe(p);
      }
      const state: OctoState = {
        players: players.slice(),
        alive,
        hidden,
        phase: 'gather',
        round: 0,
        rounds: typeof variant['rounds'] === 'number' ? variant['rounds'] : 4,
        shift: variant['shift'] === true,
        slots: {},
        said: [],
        leader: null,
        leaderDone: false,
        gone: [],
        layout: seed.int('setup:layout', 4),
      };
      return state as unknown as Json;
    },

    playersToMove(state) {
      return toMove(st(state));
    },

    legalMoves(state, player) {
      const s = st(state);
      if (!toMove(s).includes(player)) return [];
      return moveOptions(s, player) as unknown as Json[];
    },

    apply(state, player, move, seed) {
      const s = st(state);
      if (terminal(s) !== null) return { error: true, code: 'game_over', message: 'the game has ended' };
      if (s.alive[player] !== true) {
        return { error: true, code: 'dead', message: `${player} has been eliminated` };
      }
      if (!toMove(s).includes(player)) {
        return { error: true, code: 'not_to_move', message: `${player} is not to move` };
      }
      const m = (move as { m?: unknown }).m;
      const text = (move as { text?: unknown }).text;
      if (m !== 'a' && m !== 'b') {
        return { error: true, code: 'bad_move', message: `move must be 'a' or 'b', got ${JSON.stringify(m)}` };
      }
      if (typeof text !== 'string') {
        return { error: true, code: 'bad_text', message: 'move.text must be a string' };
      }
      const cap = octoCapFor(s.phase);
      if (text.length > cap) {
        return { error: true, code: 'text_too_long', message: `text exceeds ${cap} characters (got ${text.length})` };
      }
      if (m === 'b' && s.shift && bCommitted(s, player)) {
        return { error: true, code: 'b_taken', message: `another seat already committed 'b' this round` };
      }

      const next = structuredClone(s);
      const events: GameEvent[] = [];
      const roll = seed.die(`roll:round:${s.round}`, 6);
      events.push({ type: 'roll', data: { player, roll }, visibility: 'public' });
      // Private-event probe: reaches the log (and so the replay) but never the
      // live spectator feed.
      events.push({
        type: 'peek',
        data: { player, secret: s.hidden[player] ?? null },
        visibility: 'private',
        to: [player],
      });
      if (s.phase === 'gather') {
        next.slots[player] = { m, text };
      } else {
        next.said.push({ round: s.round, player, m, text });
        next.leaderDone = true;
      }
      settle(next, events);
      return { state: next as unknown as Json, events };
    },

    isTerminal(state) {
      return terminal(st(state));
    },

    publicView(state) {
      const s = st(state);
      return {
        phase: s.phase,
        round: s.round,
        rounds: s.rounds,
        players: s.players.slice(),
        alive: s.players.filter((p) => s.alive[p] === true),
        gone: s.gone.slice(),
        said: s.said.map((u) => `${u.round}:${u.player}:${u.m}`),
        acted: Object.keys(s.slots).sort(),
        leader: s.leader,
        layout: s.layout,
      };
    },

    privateView(state, player) {
      const s = st(state);
      return { you: player, you_alive: s.alive[player] === true, secret: s.hidden[player] ?? null };
    },

    renderText(state, viewer) {
      const s = st(state);
      const base = `octo[${s.round}/${s.rounds}] ${s.phase} alive=${living(s).join(',')}`;
      if (viewer === null) return base;
      return `${base}\nyou are ${viewer}`;
    },

    encodeState(state) {
      return JSON.stringify(state);
    },
    decodeState(encoded) {
      return JSON.parse(encoded) as Json;
    },

    viewStateString(state, viewer) {
      const s = st(state);
      return `octo|${s.phase}|${s.round}|${living(s).join(',')}|you=${viewer}`;
    },

    parseMove(input, _state, _player) {
      const t = input.trim();
      const m = /^([abc])(?:\s+([\s\S]*))?$/.exec(t);
      if (!m) return { parseError: true, message: `unknown notation '${input}' (expected 'a' or 'b')` };
      let text = '';
      const rest = m[2];
      if (rest !== undefined && rest.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rest);
          text = typeof parsed === 'string' ? parsed : rest;
        } catch {
          text = rest;
        }
      }
      return { m: m[1]!, text } as unknown as Json;
    },

    moveToNotation(move) {
      const m = move as { m?: unknown; text?: unknown };
      const text = typeof m.text === 'string' ? m.text : '';
      return text === '' ? String(m.m) : `${String(m.m)} ${JSON.stringify(text)}`;
    },

    moveSummary(move) {
      return `commits ${String((move as { m?: unknown }).m)}`;
    },

    defaultMove(_state, _player, legal) {
      return legal[0]!; // deterministic: 'a' with no text
    },
  };

  if (!withHooks) return game;

  /** Fills an empty text slot only; inline text always wins. Total and pure. */
  game.bindUtterance = (move, utterance, state, _player) => {
    const m = move as { m?: unknown; text?: unknown };
    if (typeof m.text !== 'string' || m.text !== '') return move;
    return { ...(move as object), text: String(utterance).slice(0, octoCapFor(st(state).phase)) } as Json;
  };

  game.forfeitPlayer = (state, player) => {
    const s = st(state);
    if (terminal(s) !== null) return null;
    if (s.alive[player] !== true) return null;
    const next = structuredClone(s);
    const events: GameEvent[] = [];
    next.alive[player] = false;
    next.gone.push(player);
    delete next.slots[player];
    // The lone mover of a sequential phase can be eliminated mid-phase; settle
    // must never be left resting with nobody to move.
    if (next.leader === player) {
      next.leader = null;
      next.leaderDone = true;
    }
    events.push({
      type: 'seat_lost',
      data: { round: next.round, seat: player, reason: 'abandoned' },
      visibility: 'public',
    });
    settle(next, events);
    return { state: next as unknown as Json, events };
  };

  game.phaseBudgetMs = (state) => {
    const s = st(state);
    if (s.phase === 'gather') return 20_000;
    if (s.phase === 'lead') return 5_000;
    return null;
  };

  game.speechInfo = (state, _player): SpeechChannel => {
    const s = st(state);
    return {
      limit: octoCapFor(s.phase),
      maxLimit: MAX_TEXT,
      audience: 'village',
      note: 'Every living seat reads this.',
    };
  };

  game.privateMessages = (state, viewer): PrivateMessage[] => {
    const s = st(state);
    return s.said
      .filter((u) => u.player !== viewer && u.text.length > 0)
      .map((u) => ({ turn: u.round, from: u.player, channel: 'table', text: u.text }));
  };

  game.teamsOf = (state) => {
    const s = st(state);
    const teams: Record<PlayerId, string> = {};
    for (const p of s.players) teams[p] = Number(p.slice(1)) % 2 === 0 ? 'evens' : 'odds';
    return teams;
  };

  game.revealOnEnd = (state) => ({ secrets: st(state).hidden });

  return game;
}

/** Every optional hook ON, plus the four meta flags. */
export const octoGame: AnyGame = makeGame(true);
/** Identical rules, every optional hook OFF — the regression baseline. */
export const octoGameBare: AnyGame = makeGame(false);

export const OCTO_SEATS: PlayerId[] = [0, 1, 2, 3].map(playerId);

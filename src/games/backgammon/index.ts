/**
 * Backgammon — standard single games. One move object = one complete turn
 * (an ordered list of hops); dice for the next turn are rolled from the seed
 * at the end of apply. See rules.ts for the full rules documentation and
 * seed-draw purposes ('dice:open:a'/'dice:open:b', 'dice:turn:N').
 *
 * The doubling cube and match play are declared variants but NOT implemented
 * in this ruleset version: only cube=false / matchTo=1 are accepted.
 */

import {
  playerId,
  seatIndex,
  type Game,
  type GameEvent,
  type Json,
  type PlayerId,
} from '../../kernel/types.ts';
import { parseTurn, turnNotation, turnSummary } from './notation.ts';
import { renderBoard } from './render.ts';
import {
  advance,
  legalTurns,
  legalTurnsWithKeys,
  makeInitialState,
  pipCount,
  simulateTurn,
  terminalResult,
  turnKey,
  type BgMove,
  type BgState,
  type Hop,
} from './rules.ts';

const PAGE_SIZE = 1000;

function movesFor(state: BgState, player: PlayerId): BgMove[] {
  if (terminalResult(state) !== null || seatIndex(player) !== state.turn) return [];
  return legalTurns(state);
}

function buildPublicView(state: BgState): Json {
  return {
    points: state.points.slice(),
    bar: state.bar.slice(),
    off: state.off.slice(),
    turn: playerId(state.turn),
    dice: state.dice.slice(),
    turn_index: state.turnIndex,
    pips: { p0: pipCount(state, 0), p1: pipCount(state, 1) },
    last_move: state.lastMove,
  };
}

function isBgMove(move: unknown): move is BgMove {
  if (typeof move !== 'object' || move === null || Array.isArray(move)) return false;
  const hops = (move as { hops?: unknown }).hops;
  if (!Array.isArray(hops)) return false;
  return hops.every(
    (h) =>
      typeof h === 'object' &&
      h !== null &&
      !Array.isArray(h) &&
      typeof (h as Hop).from === 'number' &&
      typeof (h as Hop).to === 'number' &&
      typeof (h as Hop).die === 'number',
  );
}

const backgammon: Game<BgState, BgMove> = {
  meta: {
    id: 'backgammon',
    name: 'Backgammon',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'dice',
    variants: {
      cube: {
        description:
          'Doubling cube. Declared for future seasons but not implemented in this ruleset version; only false is accepted.',
        values: [false],
        default: false,
      },
      matchTo: {
        description:
          'Match play target points. Only single games (1) are implemented in this ruleset version.',
        values: [1],
        default: 1,
      },
    },
    notation:
      "One complete turn as mover-perspective hops: '24/18 13/11', 'bar/22', '6/off', doubles '13/11(2) 6/4(2)'; '*' marks hits; '(no play)' when fully blocked.",
    boardText:
      "Classic point board from the viewer's perspective (top 13-24, bottom 12-1), bar/off counts, dice, pip counts, last move.",
    listed: true,
  },

  initialState: makeInitialState,

  playersToMove(state) {
    if (terminalResult(state) !== null) return [];
    return [playerId(state.turn)];
  },

  legalMoves: movesFor,

  legalMovesPaged(state, player, page) {
    const all = movesFor(state, player);
    const start = page * PAGE_SIZE;
    return { moves: all.slice(start, start + PAGE_SIZE), total: all.length, pageSize: PAGE_SIZE };
  },

  apply(state, player, move, seed) {
    if (terminalResult(state) !== null) {
      return { error: true, code: 'game_over', message: 'the game is already over' };
    }
    if (seatIndex(player) !== state.turn) {
      return { error: true, code: 'not_your_turn', message: `it is p${state.turn}'s turn` };
    }
    if (!isBgMove(move)) {
      return { error: true, code: 'bad_move', message: 'move must be { hops: [{from, to, die}, ...] }' };
    }

    const sim = simulateTurn(state, move.hops);
    if (typeof sim === 'string') {
      return { error: true, code: 'illegal_hop', message: sim };
    }

    const key = turnKey(move.hops, sim.pos);
    const matched = legalTurnsWithKeys(state).some((e) => e.key === key);
    if (!matched) {
      return {
        error: true,
        code: 'incomplete_turn',
        message:
          'not a complete legal turn: you must use as many dice as possible (both, four for doubles), ' +
          'play the larger die when only one can be played, and enter from the bar first',
      };
    }

    const notation = turnNotation(move, state);
    const nHits = sim.hits.filter(Boolean).length;
    const next = advance(state, sim.pos, notation, seed);

    const events: GameEvent[] = [
      {
        type: 'turn',
        data: {
          player,
          notation,
          dice: state.dice.slice(),
          hits: nHits,
          borne_off: move.hops.filter((h) => h.to === 0).length,
        },
        visibility: 'public',
      },
    ];
    if (next.dice.length > 0) {
      events.push({
        type: 'dice',
        data: { player: playerId(next.turn), turn: next.turnIndex, dice: next.dice.slice() },
        visibility: 'public',
      });
    }
    return { state: next, events };
  },

  isTerminal: terminalResult,

  publicView: buildPublicView,

  // Perfect information: the private view is exactly the public view.
  privateView: (state, _player) => buildPublicView(state),

  renderText: renderBoard,

  encodeState(state): string {
    return [
      'bg1',
      String(state.turn),
      String(state.turnIndex),
      state.dice.join(','),
      state.bar.join(','),
      state.off.join(','),
      state.points.join(','),
      state.lastMove ?? '~',
    ].join('|');
  },

  decodeState(encoded): BgState {
    const parts = encoded.split('|');
    if (parts.length < 8 || parts[0] !== 'bg1') {
      throw new Error('backgammon: bad encoded state');
    }
    const ints = (s: string): number[] =>
      s === '' ? [] : s.split(',').map((x) => {
        const n = Number(x);
        if (!Number.isInteger(n)) throw new Error(`backgammon: bad number '${x}' in encoded state`);
        return n;
      });
    const points = ints(parts[6]!);
    const bar = ints(parts[4]!);
    const off = ints(parts[5]!);
    const turn = Number(parts[1]);
    const turnIndex = Number(parts[2]);
    if (
      points.length !== 24 ||
      bar.length !== 2 ||
      off.length !== 2 ||
      !Number.isInteger(turn) ||
      !Number.isInteger(turnIndex)
    ) {
      throw new Error('backgammon: encoded state has wrong shape');
    }
    const lastMove = parts.slice(7).join('|');
    return {
      points,
      bar,
      off,
      turn,
      dice: ints(parts[3]!),
      turnIndex,
      lastMove: lastMove === '~' ? null : lastMove,
    };
  },

  parseMove: parseTurn,

  moveToNotation: (move, state) => turnNotation(move, state),

  moveSummary: (move, state) => turnSummary(move, state),
};

export default backgammon;

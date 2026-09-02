/**
 * Checkers — English draughts 8x8 (default) with an 'international' 10x10
 * variant (flying kings, backward-capturing men, majority-capture rule).
 * Moves are square-number paths: '11-15' quiet, '11x18x25' jump chains.
 * No randomness; no seed draws.
 */

import type { AnyGame, Game, Json, VariantConfig } from '../../kernel/types.ts';
import { checkersNotation, parseCheckersMove } from './notation.ts';
import { renderCheckers } from './render.ts';
import {
  applyCheckersMove,
  checkersError,
  checkersTerminal,
  colorOf,
  enumerateMoves,
  initialCheckersState,
  isKingChar,
  seatOfColor,
  squareCount,
  type CheckersMove,
  type CheckersState,
  type CheckersVariant,
} from './rules.ts';

function variantOf(config: VariantConfig): CheckersVariant {
  const v = config['ruleset'] ?? 'english';
  if (v !== 'english' && v !== 'international') {
    throw new Error(`checkers: unknown ruleset '${String(v)}' (want 'english' or 'international')`);
  }
  return v;
}

function publicViewOf(state: CheckersState): Json {
  let bMen = 0;
  let wMen = 0;
  let bKings = 0;
  let wKings = 0;
  for (const ch of state.board) {
    if (ch === 'b') bMen++;
    else if (ch === 'w') wMen++;
    else if (ch === 'B') bKings++;
    else if (ch === 'W') wKings++;
  }
  return {
    variant: state.variant,
    board: state.board,
    toMove: seatOfColor(state.toMove, state.variant),
    toMoveColor: state.toMove,
    quietClock: state.quietClock,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    pieces: { b: { men: bMen, kings: bKings }, w: { men: wMen, kings: wKings } },
  };
}

const game: Game<CheckersState, CheckersMove> = {
  meta: {
    id: 'checkers',
    name: 'Checkers',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {
      ruleset: {
        description:
          "'english' 8x8 draughts (default), or 'international' 10x10 with flying kings, backward-capturing men, and the majority-capture rule",
        values: ['english', 'international'],
        default: 'english',
      },
    },
    notation:
      "square numbers (1-32 english, 1-50 international) joined by '-' for quiet moves and 'x' per jump: '11-15', '11x18x25'",
    boardText:
      "grid with row 0 at the top; each dark square shows occupant + square number ('b12', '.16'); b/w men, B/W kings",
    listed: true,
  },

  initialState(_seed, players, variant): CheckersState {
    if (players.length !== 2) throw new Error(`checkers needs exactly 2 players, got ${players.length}`);
    return initialCheckersState(variantOf(variant));
  },

  playersToMove(state) {
    return checkersTerminal(state) ? [] : [seatOfColor(state.toMove, state.variant)];
  },

  legalMoves(state, player) {
    if (checkersTerminal(state) || player !== seatOfColor(state.toMove, state.variant)) return [];
    return enumerateMoves(state).map((m) => m.path);
  },

  apply(state, player, move, _seed) {
    if (checkersTerminal(state)) return checkersError('game_over', 'the game is already over');
    if (player !== seatOfColor(state.toMove, state.variant)) {
      return checkersError('not_your_turn', `${player} is not to move`);
    }
    if (
      !Array.isArray(move) ||
      move.length < 2 ||
      move.some((sq) => !Number.isInteger(sq) || sq < 1 || sq > squareCount(state.variant))
    ) {
      return checkersError('bad_move', 'a move is a path of at least two square numbers');
    }
    const notation = checkersNotation(move, state);
    const applied = applyCheckersMove(state, move, notation);
    if ('error' in applied) return applied;
    const events: { type: string; data: Json; visibility: 'public' }[] = [];
    if (applied.captures.length > 0) {
      events.push({
        type: 'capture',
        data: { player, squares: applied.captures.slice(), count: applied.captures.length },
        visibility: 'public',
      });
    }
    if (applied.crowned) {
      events.push({
        type: 'crown',
        data: { player, square: move[move.length - 1]! },
        visibility: 'public',
      });
    }
    return { state: applied.state, events };
  },

  isTerminal(state) {
    return checkersTerminal(state);
  },

  publicView(state) {
    return publicViewOf(state);
  },

  privateView(state, _player) {
    return publicViewOf(state);
  },

  renderText(state, _viewer) {
    return renderCheckers(state);
  },

  encodeState(state) {
    const rep = Object.keys(state.rep)
      .sort()
      .map((k) => `${k}:${state.rep[k]!}`)
      .join(',');
    return [
      state.variant,
      state.board,
      state.toMove,
      String(state.quietClock),
      String(state.moveCount),
      state.lastMove ?? '-',
      rep,
    ].join('|');
  },

  decodeState(encoded) {
    const parts = encoded.split('|');
    if (parts.length !== 7) throw new Error(`checkers: malformed state string '${encoded}'`);
    const variant = parts[0]!;
    if (variant !== 'english' && variant !== 'international') {
      throw new Error(`checkers: unknown variant '${variant}'`);
    }
    const board = parts[1]!;
    if (board.length !== squareCount(variant) || !/^[.bwBW]+$/.test(board)) {
      throw new Error(`checkers: malformed board '${board}'`);
    }
    const toMove = parts[2]!;
    if (toMove !== 'b' && toMove !== 'w') throw new Error(`checkers: bad side to move '${toMove}'`);
    const rep: Record<string, number> = {};
    if (parts[6]! !== '') {
      for (const entry of parts[6]!.split(',')) {
        const i = entry.lastIndexOf(':');
        if (i < 0) throw new Error(`checkers: malformed repetition entry '${entry}'`);
        rep[entry.slice(0, i)] = Number(entry.slice(i + 1));
      }
    }
    return {
      variant,
      board,
      toMove,
      quietClock: Number(parts[3]),
      moveCount: Number(parts[4]),
      lastMove: parts[5] === '-' ? null : parts[5]!,
      rep,
    };
  },

  parseMove(input, state, _player) {
    return parseCheckersMove(input, state.variant);
  },

  moveToNotation(move, state) {
    return checkersNotation(move, state);
  },

  moveSummary(move, state) {
    const from = move[0]!;
    const ch = state.board[from - 1] ?? '.';
    const color = colorOf(ch);
    const kind = isKingChar(ch) ? 'king' : 'man';
    const who = color === 'b' ? 'black' : 'white';
    const legal = enumerateMoves(state).find(
      (m) => m.path.length === move.length && m.path.every((sq, i) => sq === move[i]),
    );
    const caps = legal ? legal.captures.length : 0;
    const dest = move[move.length - 1]!;
    if (caps > 0) {
      return `${who} ${kind} jumps ${from} to ${dest}, capturing ${caps} piece${caps === 1 ? '' : 's'}`;
    }
    return `${who} ${kind} moves ${from} to ${dest}`;
  },
};

export default game as unknown as AnyGame;
export type { CheckersState, CheckersMove, CheckersVariant };

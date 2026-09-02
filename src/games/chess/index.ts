/**
 * Chess (track T3a) — full FIDE rules: castling, en passant, promotion,
 * check/checkmate/stalemate, automatic fifty-move draw at 100 halfmoves,
 * automatic threefold repetition, insufficient material. Resignation and
 * draw-by-agreement are room-level, not moves.
 *
 * State string: FEN extended with a repetition segment and a last-move
 * segment — `<FEN> R[key*count|key*count|...] L[uci|san]` (see
 * notes/T3a-chess.md for the exact grammar). decodeState also accepts a plain
 * 6-field FEN (repetition table starts at { current: 1 }, last move unknown).
 *
 * Moves are UCI strings ('e2e4', 'e7e8q'); castling is the king's two-square
 * move ('e1g1'). Seat p0 = White, seat p1 = Black; no seeded randomness.
 */

import {
  playerId,
  type ApplyOk,
  type Game,
  type GameEvent,
  type GameResult,
  type ParseError,
  type PlayerId,
  type RuleError,
  type SeedStream,
  type VariantConfig,
} from '../../kernel/types.ts';
import { normalizeUci, uciOfMove } from './notation.ts';
import { renderChess } from './render.ts';
import {
  EMPTY,
  P,
  START_FEN,
  colorOf,
  epCaptureLegal,
  fenBoardField,
  genLegal,
  inCheck,
  make,
  mvFrom,
  mvPromo,
  mvTo,
  posFromFen,
  posKey,
  sqName,
  stateFromPos,
  stateToPos,
  terminalOf,
  toSAN,
  typeOf,
  type ChessState,
} from './rules.ts';

type ChessMove = string; // UCI

const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

function moverOf(state: ChessState): PlayerId {
  return state.turn === 'w' ? playerId(0) : playerId(1);
}

function fenOf(state: ChessState): string {
  return (
    `${fenBoardField(state.board)} ${state.turn} ${state.castling} ${state.ep} ` +
    `${state.halfmove} ${state.fullmove}`
  );
}

function encode(state: ChessState): string {
  const reps = Object.keys(state.reps)
    .sort()
    .map((k) => `${k}*${state.reps[k]}`)
    .join('|');
  const last = state.lastMove === null ? '-' : `${state.lastMove}|${state.lastSan ?? ''}`;
  return `${fenOf(state)} R[${reps}] L[${last}]`;
}

function decode(encoded: string): ChessState {
  let rest = encoded.trim();
  let repsSeg: string | null = null;
  let lastSeg: string | null = null;

  if (rest.endsWith(']')) {
    const li = rest.lastIndexOf(' L[');
    if (li >= 0) {
      lastSeg = rest.slice(li + 3, -1);
      rest = rest.slice(0, li).trimEnd();
    }
  }
  if (rest.endsWith(']')) {
    const ri = rest.indexOf(' R[');
    if (ri >= 0) {
      repsSeg = rest.slice(ri + 3, -1);
      rest = rest.slice(0, ri).trimEnd();
    }
  }

  const pos = posFromFen(rest); // validates board, kings, clocks, ep square
  // Normalize ep the FIDE way: keep it only when a legal ep capture exists.
  if (pos.ep >= 0 && !epCaptureLegal(pos)) pos.ep = -1;

  const st = stateFromPos(pos, null, null, null); // reps = { currentKey: 1 }

  if (repsSeg !== null) {
    const reps: { [key: string]: number } = {};
    if (repsSeg !== '') {
      for (const entry of repsSeg.split('|')) {
        const star = entry.lastIndexOf('*');
        if (star <= 0) throw new Error(`bad repetition entry '${entry}'`);
        const key = entry.slice(0, star);
        const count = Number(entry.slice(star + 1));
        if (!Number.isInteger(count) || count < 1) throw new Error(`bad repetition count in '${entry}'`);
        reps[key] = count;
      }
    }
    st.reps = reps;
  }
  if (lastSeg !== null && lastSeg !== '-') {
    const bar = lastSeg.indexOf('|');
    if (bar < 0) throw new Error(`bad last-move segment '${lastSeg}'`);
    st.lastMove = lastSeg.slice(0, bar);
    st.lastSan = lastSeg.slice(bar + 1);
  }
  return st;
}

const chess: Game<ChessState, ChessMove> = {
  meta: {
    id: 'chess',
    name: 'Chess',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation:
      'UCI: from-square + to-square + optional promotion letter (e2e4, e7e8q). Castle by moving the king two squares (e1g1).',
    boardText:
      "8x8 ASCII grid with files a-h and ranks 1-8 on the edges; UPPERCASE = White, lowercase = Black, '.' = empty.",
    listed: true,
  },

  initialState(_seed: SeedStream, players: PlayerId[], _variant: VariantConfig): ChessState {
    // No seeded randomness: seat p0 is always White, seat p1 always Black.
    if (players.length !== 2) throw new Error(`chess needs exactly 2 players, got ${players.length}`);
    return decode(START_FEN);
  },

  playersToMove(state: ChessState): PlayerId[] {
    return terminalOf(state) !== null ? [] : [moverOf(state)];
  },

  legalMoves(state: ChessState, player: PlayerId): ChessMove[] {
    if (player !== moverOf(state) || terminalOf(state) !== null) return [];
    // Canonical order: UCI strings sorted lexicographically.
    return genLegal(stateToPos(state)).map(uciOfMove).sort();
  },

  apply(state: ChessState, player: PlayerId, move: ChessMove, _seed: SeedStream): ApplyOk<ChessState> | RuleError {
    if (terminalOf(state) !== null) return err('game_over', 'the game is already over');
    const mover = moverOf(state);
    if (player !== mover) return err('not_your_turn', `it is ${mover}'s turn`);
    if (typeof move !== 'string') return err('bad_move', 'move must be a UCI string like e2e4');
    const uci = normalizeUci(move);
    if (uci === null) {
      return err('bad_move', `'${move}' is not UCI notation (expected e.g. e2e4, e7e8q, e1g1)`);
    }
    const pos = stateToPos(state);
    const legal = genLegal(pos);
    const m = legal.find((x) => uciOfMove(x) === uci);
    if (m === undefined) {
      return err('illegal_move', `'${uci}' is not a legal move in this position (${legal.length} legal moves)`);
    }
    const san = toSAN(pos, m, legal);
    const capture = pos.board[mvTo(m)] !== EMPTY || (typeOf(pos.board[mvFrom(m)]!) === P && mvTo(m) === pos.ep);
    make(pos, m);
    const next = stateFromPos(pos, state.reps, uci, san);
    const events: GameEvent[] = [
      { type: 'move', data: { player, uci, san, capture }, visibility: 'public' },
    ];
    return { state: next, events };
  },

  isTerminal(state: ChessState): GameResult | null {
    return terminalOf(state);
  },

  publicView(state: ChessState) {
    return {
      fen: fenOf(state),
      turn: state.turn,
      castling: state.castling,
      en_passant: state.ep,
      halfmove_clock: state.halfmove,
      fullmove: state.fullmove,
      last_move: state.lastMove,
      last_san: state.lastSan,
      in_check: inCheck(stateToPos(state)),
      repetition_count: state.reps[posKey(state)] ?? 0,
    };
  },

  privateView(state: ChessState, _player: PlayerId) {
    return chess.publicView(state); // perfect information: nothing hidden
  },

  renderText(state: ChessState, viewer: PlayerId | null): string {
    return renderChess(state, viewer);
  },

  encodeState(state: ChessState): string {
    return encode(state);
  },

  decodeState(encoded: string): ChessState {
    return decode(encoded);
  },

  parseMove(input: string, _state: ChessState, _player: PlayerId): ChessMove | ParseError {
    const uci = normalizeUci(input);
    if (uci === null) {
      return {
        parseError: true,
        message: `'${input}' is not UCI notation: expected from-square + to-square + optional promotion letter (e2e4, e7e8q, e1g1)`,
      };
    }
    return uci;
  },

  moveToNotation(move: ChessMove, _state: ChessState): string {
    return move;
  },

  moveSummary(move: ChessMove, state: ChessState): string {
    const uci = normalizeUci(move);
    if (uci === null) return `move ${String(move)}`;
    const pos = stateToPos(state);
    const legal = genLegal(pos);
    const m = legal.find((x) => uciOfMove(x) === uci);
    if (m === undefined) return `move ${uci}`;
    const from = mvFrom(m);
    const to = mvTo(m);
    const promo = mvPromo(m);
    const piece = pos.board[from]!;
    const san = toSAN(pos, m, legal);
    const color = colorOf(piece) === 0 ? 'White' : 'Black';
    let txt = `${san}: ${color} ${PIECE_NAMES[typeOf(piece)]} ${sqName(from)} to ${sqName(to)}`;
    if (typeOf(piece) === P && to === pos.ep && pos.board[to] === EMPTY) {
      txt += ', capturing en passant';
    } else if (pos.board[to] !== EMPTY) {
      txt += `, capturing the ${PIECE_NAMES[typeOf(pos.board[to]!)]}`;
    }
    if (promo !== 0) txt += `, promoting to ${PIECE_NAMES[promo]}`;
    if (san.endsWith('#')) txt += ' — checkmate';
    else if (san.endsWith('+')) txt += ' — check';
    return txt;
  },
};

// Re-exported for tests.
export { decode as decodeChessState, encode as encodeChessState };
export type { ChessState };

export default chess;

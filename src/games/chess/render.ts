/**
 * ASCII board render for language models. Chess is perfect-information, so
 * spectators and both players see the same board; the viewer line just tells
 * an agent which color it plays.
 */

import { playerId, type PlayerId } from '../../kernel/types.ts';
import { inCheck, stateToPos, terminalOf, type ChessState } from './rules.ts';

export function renderChess(state: ChessState, viewer: PlayerId | null): string {
  const lines: string[] = [];
  lines.push('    a b c d e f g h');
  lines.push('  +-----------------+');
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    const row = state.board.slice(r * 8, r * 8 + 8).split('').join(' ');
    lines.push(`${rank} | ${row} | ${rank}`);
  }
  lines.push('  +-----------------+');
  lines.push('    a b c d e f g h');
  lines.push('Legend: UPPERCASE = White (KQRBNP), lowercase = Black (kqrbnp), . = empty');
  lines.push(state.lastMove === null ? 'Last move: (none)' : `Last move: ${state.lastMove} (${state.lastSan ?? '?'})`);
  const mover = state.turn === 'w' ? 'White' : 'Black';
  lines.push(
    `Turn: ${mover} (${state.turn === 'w' ? playerId(0) : playerId(1)}) | Castling: ${state.castling} | ` +
      `En passant: ${state.ep} | Halfmove clock: ${state.halfmove} | Move ${state.fullmove}`,
  );

  const result = terminalOf(state);
  if (result !== null) {
    if (result.reason === 'checkmate') {
      const winner = result.winners[0] === playerId(0) ? 'White (p0)' : 'Black (p1)';
      lines.push(`Status: checkmate — ${winner} wins.`);
    } else {
      lines.push(`Status: draw — ${result.reason.replaceAll('_', ' ')}.`);
    }
  } else {
    const check = inCheck(stateToPos(state)) ? ' — in check!' : '';
    lines.push(`Status: ${mover} to move${check}`);
  }

  if (viewer === playerId(0)) lines.push('You are White (p0).');
  else if (viewer === playerId(1)) lines.push('You are Black (p1).');
  return lines.join('\n');
}

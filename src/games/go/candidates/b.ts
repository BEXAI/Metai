/**
 * Candidate B: independent implementation of Go legality (Tromp-Taylor) and
 * area scoring for the Ludus engine tournament.
 *
 * Rules implemented (Tromp-Taylor):
 *  - A move on an occupied point is illegal.
 *  - After placing a stone, opponent chains without liberties are removed
 *    first; only then is the mover's own chain checked for liberties.
 *  - Self-capture (suicide, single- or multi-stone) is illegal by default;
 *    when `allowSuicide` is true the mover's libertyless chain is removed
 *    instead (Tromp-Taylor suicide is ANY self-capture).
 *  - Positional superko: the resulting whole-board position (stones only,
 *    no player-to-move component) must not repeat any position in `history`.
 *  - Passing is always legal and never subject to superko (it does not
 *    change the position).
 *  - Area scoring: a player's score is their stones plus empty regions that
 *    reach only their color; empty regions reaching both colors or neither
 *    (an empty board) count for no one. White receives komi.
 *
 * `captured` counts opponent stones removed by the move. A suicide move
 * (only possible with `allowSuicide`) removes the mover's own stones and
 * reports `captured: 0`, since a chain that captured opponents would have
 * gained a liberty and could not be a self-capture.
 */

export type Board = number[][]; // [row][col], 0 empty, 1 black, 2 white

const OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function boardDims(board: Board): { rows: number; cols: number } {
  const firstRow = board[0];
  return { rows: board.length, cols: firstRow === undefined ? 0 : firstRow.length };
}

function cellAt(board: Board, row: number, col: number): number | undefined {
  const r = board[row];
  return r === undefined ? undefined : r[col];
}

function setCell(board: Board, row: number, col: number, value: number): void {
  const r = board[row];
  if (r !== undefined) r[col] = value;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

/** Canonical positional serialization: digit rows joined by '/'. */
function keyOf(board: Board): string {
  return board.map((row) => row.join('')).join('/');
}

/**
 * Flood-fill the chain of `color` stones containing (row, col).
 * Returns the chain's stones encoded as row * cols + col, and whether the
 * chain has at least one liberty.
 */
function chainOf(
  board: Board,
  row: number,
  col: number,
  color: number,
): { stones: number[]; hasLiberty: boolean } {
  const { cols } = boardDims(board);
  const start = row * cols + col;
  const stones: number[] = [start];
  const seen = new Set<number>([start]);
  const stack: number[] = [start];
  let hasLiberty = false;
  while (stack.length > 0) {
    const enc = stack.pop();
    if (enc === undefined) break;
    const r = Math.floor(enc / cols);
    const c = enc % cols;
    for (const [dr, dc] of OFFSETS) {
      const nr = r + dr;
      const nc = c + dc;
      const v = cellAt(board, nr, nc);
      if (v === undefined) continue;
      if (v === 0) {
        hasLiberty = true;
      } else if (v === color) {
        const nenc = nr * cols + nc;
        if (!seen.has(nenc)) {
          seen.add(nenc);
          stones.push(nenc);
          stack.push(nenc);
        }
      }
    }
  }
  return { stones, hasLiberty };
}

export function applyGoMove(
  board: Board,
  player: 1 | 2,
  move: { row: number; col: number } | 'pass',
  history: string[],
  allowSuicide: boolean,
): { board: Board; captured: number; positionKey: string } | { error: string } {
  if (move === 'pass') {
    // Passing never changes the position and is always legal.
    const next = cloneBoard(board);
    return { board: next, captured: 0, positionKey: keyOf(next) };
  }

  const { row, col } = move;
  const current = cellAt(board, row, col);
  if (current === undefined) {
    return { error: `move out of bounds: row ${row}, col ${col}` };
  }
  if (current !== 0) {
    return { error: `point is occupied: row ${row}, col ${col}` };
  }

  const next = cloneBoard(board);
  const opponent: 1 | 2 = player === 1 ? 2 : 1;
  const { cols } = boardDims(next);
  setCell(next, row, col, player);

  // 1) Capture: remove adjacent opponent chains left without liberties.
  let captured = 0;
  for (const [dr, dc] of OFFSETS) {
    const nr = row + dr;
    const nc = col + dc;
    if (cellAt(next, nr, nc) !== opponent) continue;
    const chain = chainOf(next, nr, nc, opponent);
    if (!chain.hasLiberty) {
      for (const enc of chain.stones) {
        setCell(next, Math.floor(enc / cols), enc % cols, 0);
        captured++;
      }
    }
  }

  // 2) Self-capture check on the mover's own chain (after captures).
  const own = chainOf(next, row, col, player);
  if (!own.hasLiberty) {
    if (!allowSuicide) {
      return { error: `suicide is illegal: row ${row}, col ${col}` };
    }
    for (const enc of own.stones) {
      setCell(next, Math.floor(enc / cols), enc % cols, 0);
    }
  }

  // 3) Positional superko: the resulting position must not repeat.
  const positionKey = keyOf(next);
  if (history.includes(positionKey)) {
    return { error: 'positional superko: resulting position repeats an earlier one' };
  }

  return { board: next, captured, positionKey };
}

export function scoreArea(
  board: Board,
  komi: number,
): { black: number; white: number; winner: 1 | 2 | 0 } {
  const { rows, cols } = boardDims(board);
  let black = 0;
  let whiteRaw = 0;
  const visited = new Set<number>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const v = cellAt(board, row, col);
      if (v === 1) {
        black++;
        continue;
      }
      if (v === 2) {
        whiteRaw++;
        continue;
      }
      const startEnc = row * cols + col;
      if (visited.has(startEnc)) continue;

      // Flood-fill this empty region and record which colors it reaches.
      visited.add(startEnc);
      const stack: number[] = [startEnc];
      let size = 0;
      let reachesBlack = false;
      let reachesWhite = false;
      while (stack.length > 0) {
        const enc = stack.pop();
        if (enc === undefined) break;
        size++;
        const r = Math.floor(enc / cols);
        const c = enc % cols;
        for (const [dr, dc] of OFFSETS) {
          const nr = r + dr;
          const nc = c + dc;
          const nv = cellAt(board, nr, nc);
          if (nv === undefined) continue;
          if (nv === 1) {
            reachesBlack = true;
          } else if (nv === 2) {
            reachesWhite = true;
          } else {
            const nenc = nr * cols + nc;
            if (!visited.has(nenc)) {
              visited.add(nenc);
              stack.push(nenc);
            }
          }
        }
      }
      if (reachesBlack && !reachesWhite) black += size;
      else if (reachesWhite && !reachesBlack) whiteRaw += size;
      // Regions reaching both colors (dame/seki) or neither (empty board)
      // count for no one.
    }
  }

  const white = whiteRaw + komi;
  const winner: 1 | 2 | 0 = black > white ? 1 : white > black ? 2 : 0;
  return { black, white, winner };
}

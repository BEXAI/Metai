/**
 * RED TEAM red-team-rules — tictactoe, connect_drop, reversi, hex,
 * nine_mens_morris (spec games.M1_perfect_information.*). One attack pass per
 * game: forced-pass discipline, swap-rule timing, mill removal preference,
 * flying threshold, blocked-player loss, and codec-crafted draw rules.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError } from '../../src/kernel/types.ts';
import ttt from '../../src/games/tictactoe/index.ts';
import drop from '../../src/games/connect_drop/index.ts';
import reversi from '../../src/games/reversi/index.ts';
import hex from '../../src/games/hex/index.ts';
import nmm from '../../src/games/nine_mens_morris/index.ts';
import type { ReversiState } from '../../src/games/reversi/rules.ts';
import type { DropState } from '../../src/games/connect_drop/rules.ts';
import { decodeHex, type HexState } from '../../src/games/hex/rules.ts';
import { decodeNmm, POINTS, type NmmState } from '../../src/games/nine_mens_morris/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-smallgames'));

describe('tictactoe', () => {
  it('occupied cells and off-board cells are rejected; wins are detected', () => {
    let st = ttt.initialState(seed(), ['p0', 'p1'], {});
    const play = (p: string, m: string): void => {
      const r = ttt.apply(st, p, m, seed());
      if (isRuleError(r)) throw new Error(r.message);
      st = r.state;
    };
    play('p0', 'a1');
    expect(isRuleError(ttt.apply(st, 'p1', 'a1', seed()))).toBe(true);
    expect(isRuleError(ttt.apply(st, 'p1', 'd1', seed()))).toBe(true);
    expect(isRuleError(ttt.apply(st, 'p0', 'b1', seed()))).toBe(true); // not your turn
    play('p1', 'b2');
    play('p0', 'a2');
    play('p1', 'c3');
    play('p0', 'a3'); // a-column three in a row
    const t = ttt.isTerminal(st);
    expect(t?.winners).toEqual(['p0']);
    expect(ttt.legalMoves(st, 'p1')).toEqual([]);
    expect(isRuleError(ttt.apply(st, 'p1', 'c1', seed()))).toBe(true);
  });
});

describe('connect_drop', () => {
  it('a full column rejects further drops; four in a row wins in all directions', () => {
    // craft: column a full with alternating discs, X to move
    const full: DropState = { cols: ['XOXOXO', '', '', '', '', '', ''], toMove: 0, moveCount: 6, lastMove: null };
    expect(drop.legalMoves(full, 'p0')).not.toContain('a');
    expect(isRuleError(drop.apply(full, 'p0', 'a', seed()))).toBe(true);

    // horizontal win: X on a1,b1,c1; dropping d completes four
    const horiz: DropState = { cols: ['X', 'X', 'X', '', '', '', ''], toMove: 0, moveCount: 3, lastMove: null };
    const r = drop.apply(horiz, 'p0', 'd', seed());
    if (isRuleError(r)) throw new Error(r.message);
    expect(drop.isTerminal(r.state)?.winners).toEqual(['p0']);

    // diagonal win up-right
    const diag: DropState = {
      cols: ['X', 'OX', 'OOX', 'OOO', '', '', ''],
      toMove: 0,
      moveCount: 9,
      lastMove: null,
    };
    const r2 = drop.apply(diag, 'p0', 'd', seed());
    if (isRuleError(r2)) throw new Error(r2.message);
    expect(drop.isTerminal(r2.state)?.winners).toEqual(['p0']);
  });

  it('game over rejects moves; a full board without four in a row is a draw', () => {
    // 42-disc draw board (columns bottom-up), verified four-free pattern:
    // pair columns so no vertical/horizontal/diagonal run of 4 exists.
    const draw: DropState = {
      cols: ['XXOOXX', 'OOXXOO', 'XXOOXX', 'OOXXOO', 'XXOOXX', 'OOXXOO', 'XOXOXO'],
      toMove: 0,
      moveCount: 42,
      lastMove: null,
    };
    const t = drop.isTerminal(draw);
    expect(t?.draw).toBe(true);
    expect(drop.legalMoves(draw, 'p0')).toEqual([]);
    expect(isRuleError(drop.apply(draw, 'p0', 'a', seed()))).toBe(true);
  });
});

describe('reversi', () => {
  it('pass is rejected while a flanking move exists; forced pass is the only legal move', () => {
    const st0 = reversi.initialState(seed(), ['p0', 'p1'], {}) as ReversiState;
    expect(isRuleError(reversi.apply(st0, 'p0', 'pass', seed()))).toBe(true);

    // craft: B at a1, W at b1 — W (p1) to move has NO flanking move; B would.
    const cells = Array.from({ length: 64 }, () => '.');
    cells[0] = 'B';
    cells[1] = 'W';
    const st: ReversiState = { board: cells.join(''), toMove: 1, passes: 0, moveCount: 4, lastMove: null };
    expect(reversi.legalMoves(st, 'p1')).toEqual(['pass']);
    expect(isRuleError(reversi.apply(st, 'p1', 'c1', seed()))).toBe(true);
    const r = reversi.apply(st, 'p1', 'pass', seed());
    expect(isRuleError(r)).toBe(false);
  });

  it('a non-flanking placement on an empty cell is rejected', () => {
    const st0 = reversi.initialState(seed(), ['p0', 'p1'], {}) as ReversiState;
    const r = reversi.apply(st0, 'p0', 'a1', seed()); // corner, flanks nothing
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('no_flank');
  });

  it('two consecutive passes end the game and most discs wins', () => {
    const cells = Array.from({ length: 64 }, () => '.');
    cells[0] = 'B';
    cells[1] = 'B';
    cells[2] = 'W';
    const st: ReversiState = { board: cells.join(''), toMove: 0, passes: 2, moveCount: 10, lastMove: 'pass' };
    const t = reversi.isTerminal(st);
    expect(t?.winners).toEqual(['p0']);
    expect(t?.scores).toEqual({ p0: 2, p1: 1 });
    expect(isRuleError(reversi.apply(st, 'p0', 'pass', seed()))).toBe(true);
  });
});

describe('hex', () => {
  it("swap is offered ONLY on the second player's first move and never again", () => {
    let st = hex.initialState(seed(), ['p0', 'p1'], {}) as HexState;
    expect(hex.legalMoves(st, 'p0')).not.toContain('swap');
    expect(isRuleError(hex.apply(st, 'p0', 'swap', seed()))).toBe(true);
    const r1 = hex.apply(st, 'p0', 'f6', seed());
    if (isRuleError(r1)) throw new Error(r1.message);
    st = r1.state as HexState;
    expect(hex.legalMoves(st, 'p1')).toContain('swap');
    const r2 = hex.apply(st, 'p1', 'swap', seed());
    if (isRuleError(r2)) throw new Error(r2.message);
    st = r2.state as HexState;
    // the stone flipped ownership in place and it is p0's turn again
    expect(st.board.includes('O')).toBe(true);
    expect(st.board.includes('X')).toBe(false);
    expect(hex.playersToMove(st)).toEqual(['p0']);
    const r3 = hex.apply(st, 'p0', 'a1', seed());
    if (isRuleError(r3)) throw new Error(r3.message);
    st = r3.state as HexState;
    expect(hex.legalMoves(st, 'p1')).not.toContain('swap');
    expect(isRuleError(hex.apply(st, 'p1', 'swap', seed()))).toBe(true);
  });

  it('a full X column from row 1 to row N wins for p0 (edge orientation)', () => {
    const size = 7;
    const board = Array.from({ length: size * size }, () => '.');
    for (let r = 0; r < size; r++) board[r * size + 3] = 'X'; // column d
    const st = decodeHex(`${size}|${board.join('')}|1|${size}|0|-`);
    const t = hex.isTerminal(st);
    expect(t?.winners).toEqual(['p0']);
    expect(hex.legalMoves(st, 'p1')).toEqual([]);
    expect(isRuleError(hex.apply(st, 'p1', 'a1', seed()))).toBe(true);
  });

  it('an O row from column a to the last column wins for p1', () => {
    const size = 7;
    const board = Array.from({ length: size * size }, () => '.');
    for (let c = 0; c < size; c++) board[3 * size + c] = 'O'; // row 4
    const st = decodeHex(`${size}|${board.join('')}|0|${size}|0|-`);
    expect(hex.isTerminal(st)?.winners).toEqual(['p1']);
  });
});

describe('nine_mens_morris', () => {
  const IDX = Object.fromEntries(POINTS.map((p, i) => [p, i])) as Record<string, number>;

  function craftBoard(x: string[], o: string[]): string {
    const cells = Array.from({ length: 24 }, () => '.');
    for (const p of x) cells[IDX[p]!] = 'X';
    for (const p of o) cells[IDX[p]!] = 'O';
    return cells.join('');
  }

  function craft(x: string[], o: string[], opts: { toMove?: number; inHand?: [number, number]; phase?: 'p' | 'm'; quiet?: number; history?: string[] } = {}): NmmState {
    const board = craftBoard(x, o);
    return decodeNmm(
      [
        board,
        opts.toMove ?? 0,
        `${opts.inHand?.[0] ?? 0},${opts.inHand?.[1] ?? 0}`,
        opts.phase ?? 'm',
        opts.quiet ?? 0,
        20,
        '-',
        (opts.history ?? []).join(','),
      ].join('|'),
    );
  }

  it('mill removal must take an UNMILLED man when one exists', () => {
    // p0 placing d1 completes the a1-d1-g1 mill. O men: b2 (unmilled) and the
    // milled trio c3,c4,c5. Only xb2 may be offered.
    const st = craft(['a1', 'g1'], ['b2', 'c3', 'c4', 'c5'], { phase: 'p', inHand: [7, 4], toMove: 0 });
    const moves = nmm.legalMoves(st, 'p0') as string[];
    expect(moves).toContain('d1xb2');
    expect(moves).not.toContain('d1xc3');
    expect(moves).not.toContain('d1xc4');
    expect(isRuleError(nmm.apply(st, 'p0', 'd1xc3', seed()))).toBe(true);
    const r = nmm.apply(st, 'p0', 'd1xb2', seed());
    expect(isRuleError(r)).toBe(false);
  });

  it('when EVERY opponent man is milled, a milled man may be taken', () => {
    const st = craft(['a1', 'g1'], ['c3', 'c4', 'c5'], { phase: 'p', inHand: [7, 6], toMove: 0 });
    const moves = nmm.legalMoves(st, 'p0') as string[];
    expect(moves).toContain('d1xc3');
    expect(moves).toContain('d1xc4');
    expect(moves).toContain('d1xc5');
  });

  it('a double mill in one placement still removes exactly ONE man', () => {
    // placing d2 completes b2-d2-f2 AND d1-d2-d3 simultaneously.
    const st = craft(['b2', 'f2', 'd1', 'd3'], ['a1', 'a4', 'g7', 'e5'], { phase: 'p', inHand: [5, 5], toMove: 0 });
    const moves = (nmm.legalMoves(st, 'p0') as string[]).filter((m) => m.startsWith('d2'));
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      expect(m.split('x').length).toBe(2); // exactly one removal, never two
    }
  });

  it('flying starts at EXACTLY 3 men; 4 men still slide adjacently', () => {
    const st3 = craft(['a1', 'a4', 'd1'], ['g7', 'g4', 'g1', 'f2', 'b2'], { phase: 'm', toMove: 0 });
    const moves3 = nmm.legalMoves(st3, 'p0') as string[];
    // a non-adjacent destination proves flying (a1 -> e5 is far away)
    expect(moves3.some((m) => m.startsWith('a1-e5') || m.startsWith('a1-d5'))).toBe(true);

    const st4 = craft(['a1', 'a4', 'd1', 'd2'], ['g7', 'g4', 'g1', 'f2', 'b2'], { phase: 'm', toMove: 0 });
    const moves4 = nmm.legalMoves(st4, 'p0') as string[];
    for (const m of moves4) {
      const [from, rest] = m.split('-') as [string, string];
      const to = rest.split('x')[0]!;
      // adjacency check via the module's own list would be circular; assert
      // the known non-adjacent teleport does not appear
      expect(`${from}-${to}`).not.toBe('a1-e5');
      expect(`${from}-${to}`).not.toBe('a1-g7');
    }
  });

  it('a blocked player loses immediately (blocked), a reduced player loses (reduced)', () => {
    // X men on a1,d1,b2,d2 with every escape square held by O -> X blocked.
    const blocked = craft(['a1', 'd1', 'b2', 'd2'], ['a4', 'g1', 'b4', 'f2', 'd3'], { phase: 'm', toMove: 0 });
    const t = nmm.isTerminal(blocked);
    expect(t?.winners).toEqual(['p1']);
    expect(t?.reason).toBe('blocked');

    const reduced = craft(['a1', 'a4'], ['g7', 'g4', 'g1', 'f2'], { phase: 'm', toMove: 0 });
    expect(nmm.isTerminal(reduced)?.reason).toBe('reduced');
  });

  it('50 quiet moving-phase plies draw; threefold repetition draws (attack family 2)', () => {
    const quiet = craft(['a1', 'a4', 'd1', 'd2'], ['g7', 'g4', 'g1', 'f2'], { phase: 'm', quiet: 50 });
    expect(nmm.isTerminal(quiet)?.reason).toBe('fifty_moves');

    const board = craftBoard(['a1', 'a4', 'd1', 'd2'], ['g7', 'g4', 'g1', 'f2']);
    const key = `${board}0`;
    const rep = craft(['a1', 'a4', 'd1', 'd2'], ['g7', 'g4', 'g1', 'f2'], {
      phase: 'm',
      history: [key, key, key],
    });
    expect(nmm.isTerminal(rep)?.reason).toBe('repetition');
  });

  it('apply robustness: garbage is a RuleError, never a throw', () => {
    const st = nmm.initialState(seed(), ['p0', 'p1'], {});
    for (const bad of ['d4', 'a1-a1', 'a1xd6', 'zz', '', 'a1-b2-c3']) {
      let out: unknown;
      expect(() => {
        out = nmm.apply(st, 'p0', bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});

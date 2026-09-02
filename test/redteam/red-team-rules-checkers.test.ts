/**
 * RED TEAM red-team-rules — checkers (spec games.M1_perfect_information.checkers).
 * Attacks: mandatory-capture completeness, multi-jump MUST continue,
 * crowning mid-jump ends the move (english) / does not crown (international),
 * majority rule, the 40-move and threefold draw rules, malformed-move
 * robustness. Failing tests are exploitable holes; passing ones are
 * regression guards on rules the shipped suite does not pin.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError } from '../../src/kernel/types.ts';
import game from '../../src/games/checkers/index.ts';
import { squareCount, type CheckersState, type CheckersVariant } from '../../src/games/checkers/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-checkers'));

function stateWith(
  variant: CheckersVariant,
  pieces: Record<number, string>,
  toMove: 'b' | 'w',
  extra: Partial<Pick<CheckersState, 'quietClock' | 'rep'>> = {},
): CheckersState {
  const cells = Array.from({ length: squareCount(variant) }, () => '.');
  for (const [sq, ch] of Object.entries(pieces)) cells[Number(sq) - 1] = ch;
  const board = cells.join('');
  return {
    variant,
    board,
    toMove,
    quietClock: extra.quietClock ?? 0,
    moveCount: 0,
    lastMove: null,
    rep: extra.rep ?? { [board + toMove]: 1 },
  };
}

const paths = (st: CheckersState, p: string): number[][] => game.legalMoves(st, p) as number[][];

function mustApply(st: CheckersState, p: string, path: number[]): CheckersState {
  const r = game.apply(st, p, path, seed());
  if (isRuleError(r)) throw new Error(`${path.join('x')} rejected: ${r.message}`);
  return r.state as CheckersState;
}

describe('english: mandatory-capture completeness', () => {
  it('when TWO different pieces can capture, both chains are offered and nothing else', () => {
    // Black men on 9 and 10; white men on 13 and 14 with empty landing squares.
    // 9x18 wait — use verified geometry: 9 jumps 14 -> 18? 9 (row2,col1); 14
    // (row3,col2); land (row4,col3) = 18. 10 jumps 14? 10 is (row2,col3),
    // 14 (row3,col2), land (row4,col1) = 17. Both capture the same man 14.
    const st = stateWith('english', { 9: 'b', 10: 'b', 14: 'w' }, 'b');
    const lm = paths(st, 'p0');
    expect(lm).toContainEqual([9, 18]);
    expect(lm).toContainEqual([10, 17]);
    expect(lm.every((m) => m.length === 2 && (m[0] === 9 || m[0] === 10))).toBe(true);
    // every quiet move by any piece is rejected while a capture exists
    const r = game.apply(st, 'p0', [9, 13], seed());
    expect(isRuleError(r)).toBe(true);
  });

  it('a multi-jump MUST be played to the end: the truncated prefix is rejected', () => {
    // Black man on 6: 6x15 over 10 (wait, craft verified double): black man 6
    // (row1,col2); white on 10 (row2,col3)? no — jump over 10 lands 15?
    // Use the note-verified chain 13x22x31: black man 13, whites on 17 and 26.
    const st = stateWith('english', { 13: 'b', 17: 'w', 26: 'w' }, 'b');
    const lm = paths(st, 'p0');
    expect(lm).toContainEqual([13, 22, 31]);
    expect(lm).not.toContainEqual([13, 22]);
    const r = game.apply(st, 'p0', [13, 22], seed());
    expect(isRuleError(r)).toBe(true);
    const done = mustApply(st, 'p0', [13, 22, 31]);
    expect(done.board[16]).toBe('.'); // 17 captured
    expect(done.board[25]).toBe('.'); // 26 captured
    expect(done.board[30]).toBe('B'); // crowned on 31 (bottom row)
  });

  it('crowning by capture ENDS the chain even when a king-jump could continue', () => {
    // Black man on 11 jumps over 7 to 2? No: black moves DOWN. Use white man
    // moving UP: white man on 11 (row2,col5) jumps black on 7 (row1,col4)
    // landing on 2 (row0,col3) = crowning row for white; a further jump as a
    // king (over 6 back down) must NOT be part of the same move.
    const st = stateWith('english', { 7: 'b', 6: 'b', 10: 'b', 11: 'w' }, 'w');
    const lm = paths(st, 'p1');
    expect(lm).toContainEqual([11, 2]);
    for (const m of lm) expect(m.length).toBe(2); // no continuation past crowning
    const done = mustApply(st, 'p1', [11, 2]);
    expect(done.board[1]).toBe('W'); // crowned
    expect(done.board[6]).toBe('.'); // 7 captured
    expect(done.board[5]).toBe('b'); // 6 NOT captured — chain ended at crowning
  });

  it('capture-less positions do not hallucinate mandatory captures (man cannot capture backward)', () => {
    // White man on 18 sits diagonally behind black man on 22 — black men
    // cannot capture backward, so black keeps its quiet moves.
    const st = stateWith('english', { 22: 'b', 18: 'w', 1: 'b' }, 'b');
    const lm = paths(st, 'p0');
    expect(lm.some((m) => m.length === 2)).toBe(true);
    expect(lm).toContainEqual([1, 5]);
    expect(lm).toContainEqual([1, 6]);
  });
});

describe('international: majority rule and mid-chain crowning', () => {
  it('only maximum-capture chains are legal; a shorter capture is rejected with not_maximal_capture', () => {
    // From the module notes fixture: white man 28 can take 28x19x10 (two men)
    // or 28x17 (one man): only the double is legal.
    const st = stateWith('international', { 28: 'w', 23: 'b', 14: 'b', 22: 'b' }, 'w');
    const lm = paths(st, 'p0'); // international: white = p0
    expect(lm.some((m) => m.length === 3)).toBe(true);
    expect(lm.every((m) => m.length === 3)).toBe(true);
    const short = lm.find((m) => m.length === 2);
    expect(short).toBeUndefined();
    const r = game.apply(st, 'p0', [28, 17], seed());
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('not_maximal_capture');
  });

  it('a man PASSING THROUGH the crowning row mid-chain is not crowned', () => {
    // White man on 7 (row1): jumps to row0 (crowning row) then continues and
    // ends OFF the crowning row -> stays a man. Board: white man 12 (row2,col2),
    // black men on 7 (row1,col2) and 8 (row1,col4).
    // 12 jumps 7 -> lands 1 (row0,col0)? 12=(2,3): over (1,2)=7, land (0,1)=1.
    // From 1 (row0), continue over 8? 1=(0,1) -> over (1,2)=7 already dead.
    // Craft instead: white man 13=(2,5); blacks 8=(1,4) and 7=(1,2).
    // 13 over 8 -> land 2=(0,3). From 2 over 7=(1,2) -> land 11=(2,1).
    const st = stateWith('international', { 13: 'w', 8: 'b', 7: 'b' }, 'w');
    const lm = paths(st, 'p0');
    expect(lm).toContainEqual([13, 2, 11]);
    // the two-capture chain is forced; stopping on the crowning row is illegal
    expect(lm.every((m) => m.length === 3)).toBe(true);
    const done = mustApply(st, 'p0', [13, 2, 11]);
    expect(done.board[10]).toBe('w'); // still a man — passed through row 0
  });

  it('flying king captures at distance and may stop on any empty square beyond', () => {
    // King on 46=(9,1); black man on 28=(5,4)? diagonal from (9,1): (8,2)=37?
    // Use the notes fixture: king 46, victim 37, landings beyond on that
    // diagonal are all legal endpoints.
    const st = stateWith('international', { 46: 'W', 37: 'b' }, 'w');
    const lm = paths(st, 'p0');
    const capturing = lm.filter((m) => m.length === 2 && m[0] === 46 && m[1] !== 41);
    expect(capturing.length).toBeGreaterThan(1); // multiple landing squares
    for (const m of capturing) {
      const done = mustApply(st, 'p0', m);
      expect(done.board[36]).toBe('.'); // 37 captured whatever the landing
    }
  });
});

describe('draw rules: 40 quiet moves per side and threefold repetition', () => {
  it('quietClock 80 draws as forty_move_rule', () => {
    const st = stateWith('english', { 1: 'B', 32: 'W' }, 'b', { quietClock: 80 });
    const t = game.isTerminal(st);
    expect(t?.draw).toBe(true);
    expect(t?.reason).toBe('forty_move_rule');
  });

  it('a king move at clock 79 reaches 80 and draws; a man move resets instead', () => {
    const st = stateWith('english', { 5: 'B', 21: 'b', 32: 'W' }, 'b', { quietClock: 79 });
    expect(game.isTerminal(st)).toBeNull();
    const kingMove = mustApply(st, 'p0', [5, 1]);
    expect(game.isTerminal(kingMove)?.reason).toBe('forty_move_rule');
    const manMove = mustApply(st, 'p0', [21, 25]);
    expect(manMove.quietClock).toBe(0);
    expect(game.isTerminal(manMove)).toBeNull();
  });

  it('threefold repetition of board+side draws and outranks the 40-move rule', () => {
    const cells = Array.from({ length: 32 }, () => '.');
    cells[0] = 'B';
    cells[31] = 'W';
    const board = cells.join('');
    const st: CheckersState = {
      variant: 'english',
      board,
      toMove: 'b',
      quietClock: 80,
      moveCount: 40,
      lastMove: null,
      rep: { [board + 'b']: 3 },
    };
    const t = game.isTerminal(st);
    expect(t?.draw).toBe(true);
    expect(t?.reason).toBe('threefold_repetition');
  });

  it('a blocked player loses (no_moves), including with no pieces left', () => {
    // Black man on 5 fully blocked: 5=(1,0) -> forward squares 9=(2,1) via
    // (2,1); occupy 9 with white and its jump landing 14 with white too.
    const st = stateWith('english', { 5: 'b', 9: 'w', 14: 'w' }, 'b');
    const t = game.isTerminal(st);
    expect(t?.winners).toEqual(['p1']);
    expect(t?.reason).toBe('no_moves');
    // no pieces at all: same result
    const none = stateWith('english', { 32: 'w' }, 'b');
    expect(game.isTerminal(none)?.winners).toEqual(['p1']);
  });
});

describe('apply robustness', () => {
  it('malformed paths return RuleError, never throw', () => {
    const st = game.initialState(seed(), ['p0', 'p1'], {});
    for (const bad of [null, 'hello', [1], [0, 5], [1, 2, 3, 4, 5], [{ a: 1 }], [9, 9]]) {
      let out: unknown;
      expect(() => {
        out = game.apply(st, 'p0', bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});

/**
 * Tournament: Go scoring and superko (spec workflow.stage_3_tournaments,
 * judging criteria: fixture suite for capture, ko, superko, seki; 1,000 9x9
 * playouts; scores match a reference implementation).
 *
 * Incumbent: src/games/go/ Game object (Tromp-Taylor, positional superko via
 *   FNV board hashes carried in state.hashes — includes the CURRENT position).
 * Candidate B: src/games/go/candidates/b.ts applyGoMove/scoreArea on
 *   number[][] boards with a caller-maintained history of position keys.
 *
 * Driving convention (fixes the caller-contract degrees of freedom so the two
 * engines are comparable):
 *  - Board mapping: incumbent board string index = row*size+col (row 0 =
 *    bottom); candidate Board[row][col] uses the SAME row indexing.
 *  - Candidate history mirrors the incumbent's hash set: it contains the key
 *    of every position seen INCLUDING the current one (seeded with the start
 *    position; a key is appended after every successful play; passes append
 *    nothing since the position is unchanged).
 *
 * Every differential assertion fails loudly with the smallest reproducing
 * position: the incumbent's encoded state string BEFORE the move plus the
 * single diverging move (paste into go.decodeState to replay).
 *
 * Deterministic: all randomness flows from createSeedStream(sha256Hex(...)).
 * Re-runnable: passes when the engines agree; no golden values from either
 * engine are used for the differential parts (fixture scores are hand-counted
 * from the rules text, not taken from either implementation).
 */

import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { isParseError, isRuleError, type SeedStream } from '../../src/kernel/types.ts';
import go from '../../src/games/go/index.ts';
import type { GoMove, GoState } from '../../src/games/go/rules.ts';
import { GO_LETTERS } from '../../src/games/go/notation.ts';
import { applyGoMove, scoreArea, type Board } from '../../src/games/go/candidates/b.ts';

// ---------------------------------------------------------------------------
// Shared driving harness ("twin" = the same game tracked in both engines)
// ---------------------------------------------------------------------------

const seed = () => createSeedStream(sha256Hex('tournament:go:apply').slice(0, 64));

/** Convert the incumbent board string to candidate Board (same row indexing). */
function toCandidate(board: string, size: number): Board {
  const rows: Board = [];
  for (let r = 0; r < size; r++) {
    const row: number[] = [];
    for (let c = 0; c < size; c++) {
      const ch = board[r * size + c]!;
      row.push(ch === 'X' ? 1 : ch === 'O' ? 2 : 0);
    }
    rows.push(row);
  }
  return rows;
}

function keyOf(b: Board): string {
  return b.map((row) => row.join('')).join('/');
}

interface Twin {
  state: GoState;
  bBoard: Board;
  bHistory: string[];
  /** Notation trace since the twin was composed (for repro messages). */
  trace: string[];
}

function twinOf(state: GoState): Twin {
  const bBoard = toCandidate(state.board, state.size);
  return { state, bBoard, bHistory: [keyOf(bBoard)], trace: [] };
}

function twinInitial(size: number, variant: Record<string, number | boolean> = {}): Twin {
  const v = size === 9 ? variant : { board_size: size, ...variant };
  return twinOf(go.initialState(seed(), ['p0', 'p1'], v));
}

function pt(n: string, size: number): number {
  const col = GO_LETTERS.indexOf(n[0]!.toUpperCase());
  const row = Number(n.slice(1)) - 1;
  if (col < 0 || col >= size || row < 0 || row >= size) throw new Error(`bad test point ${n}`);
  return row * size + col;
}

/** Compose a position directly (decodeState with hashes=auto seeds superko history). */
function fixture(opts: {
  size?: number;
  black?: string[];
  white?: string[];
  toMove?: 'B' | 'W';
  komi?: number;
  allowSuicide?: boolean;
  ended?: boolean;
}): Twin {
  const size = opts.size ?? 9;
  const cells = Array<string>(size * size).fill('.');
  for (const n of opts.black ?? []) cells[pt(n, size)] = 'X';
  for (const n of opts.white ?? []) cells[pt(n, size)] = 'O';
  const enc = [
    'go1',
    String(size),
    String(opts.komi ?? 7.5),
    opts.allowSuicide ? '1' : '0',
    opts.toMove ?? 'B',
    opts.ended ? '2' : '0',
    '0',
    '0',
    cells.join(''),
    '-',
    'auto',
    '-',
    opts.ended ? '1' : '0',
  ].join('|');
  return twinOf(go.decodeState(enc));
}

function parse(state: GoState, notation: string): GoMove {
  const mv = go.parseMove(notation, state, state.toMove === 'B' ? 'p0' : 'p1');
  if (isParseError(mv)) throw new Error(`test setup: cannot parse ${notation}: ${mv.message}`);
  return mv;
}

function divergence(twin: Twin, moveText: string, detail: string): never {
  throw new Error(
    `ENGINE DIVERGENCE: ${detail}\n` +
      `  move: ${moveText} (${twin.state.toMove} to play)\n` +
      `  repro state (go.decodeState): ${go.encodeState(twin.state)}\n` +
      `  candidate board: ${keyOf(twin.bBoard)}\n` +
      `  candidate history (${twin.bHistory.length}): ${twin.bHistory.join(' ')}\n` +
      `  trace since fixture: ${twin.trace.join(' ') || '(none)'}`,
  );
}

interface ProbeResult {
  legal: boolean;
  incumbentCode: string | null;
  candidateError: string | null;
}

/**
 * Try one move in BOTH engines without mutating the twin. Throws with a
 * repro if the legality verdicts differ; otherwise returns the shared verdict.
 */
function probeBoth(twin: Twin, mv: GoMove): ProbeResult {
  const player = twin.state.toMove === 'B' ? ('p0' as const) : ('p1' as const);
  const r = go.apply(twin.state, player, mv, seed());
  const incumbentLegal = !isRuleError(r);
  const bPlayer = twin.state.toMove === 'B' ? 1 : (2 as 1 | 2);
  const bMove = mv.pass ? ('pass' as const) : { row: mv.row, col: mv.col };
  const b = applyGoMove(twin.bBoard, bPlayer, bMove, twin.bHistory, twin.state.allowSuicide);
  const candidateLegal = !('error' in b);
  const moveText = go.moveToNotation(mv, twin.state);
  if (incumbentLegal !== candidateLegal) {
    divergence(
      twin,
      moveText,
      `legality verdicts differ — incumbent: ${
        incumbentLegal ? 'LEGAL' : `illegal (${(r as { code: string }).code})`
      }, candidate B: ${candidateLegal ? 'LEGAL' : `illegal (${(b as { error: string }).error})`}`,
    );
  }
  return {
    legal: incumbentLegal,
    incumbentCode: isRuleError(r) ? r.code : null,
    candidateError: 'error' in b ? b.error : null,
  };
}

/**
 * Apply one move in BOTH engines (must be legal in both), asserting identical
 * capture counts and identical resulting boards. Mutates the twin.
 */
function stepBoth(twin: Twin, mv: GoMove): void {
  const moveText = go.moveToNotation(mv, twin.state);
  const player = twin.state.toMove === 'B' ? ('p0' as const) : ('p1' as const);
  const r = go.apply(twin.state, player, mv, seed());
  const bPlayer = twin.state.toMove === 'B' ? 1 : (2 as 1 | 2);
  const bMove = mv.pass ? ('pass' as const) : { row: mv.row, col: mv.col };
  const b = applyGoMove(twin.bBoard, bPlayer, bMove, twin.bHistory, twin.state.allowSuicide);
  if (isRuleError(r) && 'error' in b) {
    throw new Error(`test setup: stepBoth on a move both engines reject: ${moveText}: ${r.message}`);
  }
  if (isRuleError(r)) divergence(twin, moveText, `incumbent rejects (${r.code}) but candidate B accepts`);
  if ('error' in b) divergence(twin, moveText, `candidate B rejects (${b.error}) but incumbent accepts`);

  // Captures: incumbent reports them on the public 'play' event.
  let incumbentCaptured = 0;
  for (const ev of r.events) {
    if (ev.type === 'play') {
      const c = (ev.data as Record<string, unknown>)['captured'];
      if (typeof c === 'number') incumbentCaptured = c;
    }
  }
  if (b.captured !== incumbentCaptured) {
    divergence(twin, moveText, `capture counts differ — incumbent ${incumbentCaptured}, candidate B ${b.captured}`);
  }

  // Boards must be identical point for point.
  const incumbentKey = keyOf(toCandidate(r.state.board, r.state.size));
  if (incumbentKey !== b.positionKey) {
    divergence(twin, moveText, `resulting boards differ —\n  incumbent: ${incumbentKey}\n  candidate: ${b.positionKey}`);
  }

  if (!mv.pass) twin.bHistory.push(b.positionKey);
  twin.bBoard = b.board;
  twin.state = r.state;
  twin.trace.push(moveText);
}

function stepN(twin: Twin, ...notations: string[]): void {
  for (const n of notations) stepBoth(twin, parse(twin.state, n));
}

/** Both engines score the twin's ENDED position; scores must match exactly. */
function compareScores(twin: Twin): { black: number; white: number } {
  const res = go.isTerminal(twin.state);
  if (res === null || res.scores === undefined) {
    throw new Error(`test setup: compareScores on a non-terminal state: ${go.encodeState(twin.state)}`);
  }
  const s = scoreArea(twin.bBoard, twin.state.komi);
  const p0 = res.scores['p0']!;
  const p1 = res.scores['p1']!;
  if (s.black !== p0 || s.white !== p1) {
    divergence(
      twin,
      '(scoring)',
      `final scores differ — incumbent B=${p0} W=${p1} (komi ${twin.state.komi}), candidate B=${s.black} W=${s.white}`,
    );
  }
  const expectedWinner = res.draw ? 0 : res.winners[0] === 'p0' ? 1 : 2;
  if (s.winner !== expectedWinner) {
    divergence(twin, '(scoring)', `winner differs — incumbent ${res.draw ? 'draw' : res.winners[0]}, candidate ${s.winner}`);
  }
  return { black: s.black, white: s.white };
}

// ---------------------------------------------------------------------------
// 1. Spec criterion fixtures — the incumbent's own A4 scenarios re-expressed
//    positionally and evaluated by BOTH engines.
// ---------------------------------------------------------------------------

describe('go tournament: shared fixtures (capture, ko, superko, seki, suicide, scoring)', () => {
  it('F1 captures a single surrounded stone identically', () => {
    const t = fixture({ black: ['D5', 'F5', 'E4'], white: ['E5'], toMove: 'B' });
    stepN(t, 'E6');
    expect(t.state.board[pt('E5', 9)]).toBe('.');
    expect(t.bBoard[4]![4]).toBe(0); // E5 = row 4, col 4
    expect(t.state.capB).toBe(1);
  });

  it('F2 captures a multi-stone group identically', () => {
    const t = fixture({ black: ['D5', 'D6', 'F5', 'F6', 'E4'], white: ['E5', 'E6'], toMove: 'B' });
    stepN(t, 'E7');
    expect(t.state.board[pt('E5', 9)]).toBe('.');
    expect(t.state.board[pt('E6', 9)]).toBe('.');
    expect(t.state.capB).toBe(2);
  });

  it('F3 captures in the corner identically', () => {
    const t = fixture({ black: ['B1'], white: ['A1'], toMove: 'B' });
    stepN(t, 'A2');
    expect(t.state.board[pt('A1', 9)]).toBe('.');
    expect(t.bBoard[0]![0]).toBe(0);
  });

  it('F4 captures on the edge identically', () => {
    const t = fixture({ black: ['A4', 'A6'], white: ['A5'], toMove: 'B' });
    stepN(t, 'B5');
    expect(t.state.board[pt('A5', 9)]).toBe('.');
  });

  it('F5 captures two separate chains with one move identically', () => {
    // White D5 captures Black C5 and E5 (two one-stone chains) at once.
    const t = fixture({
      black: ['C5', 'E5'],
      white: ['C4', 'C6', 'B5', 'E4', 'E6', 'F5'],
      toMove: 'W',
    });
    stepN(t, 'D5');
    expect(t.state.capW).toBe(2);
    expect(t.state.board[pt('C5', 9)]).toBe('.');
    expect(t.state.board[pt('E5', 9)]).toBe('.');
  });

  it('F6 rejects occupied and out-of-bounds points in both engines', () => {
    const t = fixture({ black: ['E5'], toMove: 'W' });
    const occupied = probeBoth(t, { pass: false, col: 4, row: 4 }); // E5
    expect(occupied.legal).toBe(false);
    expect(occupied.incumbentCode).toBe('occupied');
    expect(occupied.candidateError).toMatch(/occupied/);
    const off = probeBoth(t, { pass: false, col: 9, row: 0 });
    expect(off.legal).toBe(false);
    const off2 = probeBoth(t, { pass: false, col: 0, row: -1 });
    expect(off2.legal).toBe(false);
  });

  it('F7 simple ko: immediate retake barred in both, legal in both after an exchange', () => {
    const t = fixture({ black: ['D5', 'E4', 'E6'], white: ['E5', 'F4', 'F6', 'G5'], toMove: 'B' });
    stepN(t, 'F5'); // Black takes the ko, capturing E5
    expect(t.state.capB).toBe(1);
    const retake = probeBoth(t, parse(t.state, 'E5'));
    expect(retake.legal).toBe(false);
    expect(retake.incumbentCode).toBe('superko');
    expect(retake.candidateError).toMatch(/superko/);
    // Exchange elsewhere, then the retake is legal in both (position now novel).
    stepN(t, 'A1', 'A9', 'E5');
    expect(t.state.capW).toBe(1);
  });

  it('F8 positional superko: sending-two-returning-one barred in both (simple ko would allow it)', () => {
    const t = fixture({ black: ['B1', 'C2', 'D1'], white: ['A2', 'B2'], toMove: 'B' });
    stepN(t, 'A1'); // Black sends two: {A1,B1} left with one liberty C1
    stepN(t, 'C1'); // White captures TWO stones
    expect(t.state.capW).toBe(2);
    // Black returning at B1 would capture C1 and recreate the start position
    // three plies back — NOT a simple-ko shape; positional superko must bar it.
    const back = probeBoth(t, parse(t.state, 'B1'));
    expect(back.legal).toBe(false);
    expect(back.incumbentCode).toBe('superko');
    expect(back.candidateError).toMatch(/superko/);
    // A different reply is legal in both — neither engine over-blocks.
    expect(probeBoth(t, parse(t.state, 'A1')).legal).toBe(true);
  });

  it('F9 suicide illegal by default in both: single-stone and multi-stone', () => {
    const single = fixture({ white: ['A2', 'B1'], toMove: 'B' });
    const s = probeBoth(single, parse(single.state, 'A1'));
    expect(s.legal).toBe(false);
    expect(s.incumbentCode).toBe('suicide');
    expect(s.candidateError).toMatch(/suicide/);

    const multi = fixture({ black: ['A1', 'B1'], white: ['A3', 'B2', 'C1'], toMove: 'B' });
    const m = probeBoth(multi, parse(multi.state, 'A2'));
    expect(m.legal).toBe(false);
    expect(m.incumbentCode).toBe('suicide');
    expect(m.candidateError).toMatch(/suicide/);
  });

  it('F10 allow_suicide variant: multi-stone suicide plays out identically, single-stone stays barred (superko)', () => {
    const t = fixture({ black: ['A1', 'B1'], white: ['A3', 'B2', 'C1'], toMove: 'B', allowSuicide: true });
    stepN(t, 'A2'); // 3-stone self-capture, boards compared inside stepBoth
    expect(t.state.board[pt('A1', 9)]).toBe('.');
    expect(t.state.board[pt('A2', 9)]).toBe('.');
    expect(t.state.board[pt('B1', 9)]).toBe('.');
    expect(t.bBoard[0]![0]).toBe(0);
    expect(t.bBoard[1]![0]).toBe(0);

    const single = fixture({ white: ['A2', 'B1'], toMove: 'B', allowSuicide: true });
    const s = probeBoth(single, parse(single.state, 'A1'));
    expect(s.legal).toBe(false); // board unchanged -> recreates the current position
    expect(s.incumbentCode).toBe('superko');
    expect(s.candidateError).toMatch(/superko/);
  });

  it('F11 Tromp-Taylor score, split columns: B 36 / W 36+komi at komi 7.5 AND komi 0', () => {
    const cols = (letter: string) => Array.from({ length: 9 }, (_, r) => `${letter}${r + 1}`);
    for (const komi of [7.5, 0]) {
      const t = fixture({ black: cols('D'), white: cols('F'), toMove: 'B', komi });
      stepN(t, 'pass', 'pass');
      expect(t.state.ended).toBe(true);
      const s = compareScores(t); // engines must agree...
      expect(s).toEqual({ black: 36, white: 36 + komi }); // ...and match the hand count
    }
  });

  it('F12 seki: shared liberties neutral in both engines, at komi 7.5 AND komi 0', () => {
    // Corner seki: inner Black B1 vs inner White A2-B2-C2 share liberties A1, C1.
    const colE = Array.from({ length: 9 }, (_, r) => `E${r + 1}`);
    const colF = Array.from({ length: 9 }, (_, r) => `F${r + 1}`);
    for (const komi of [7.5, 0]) {
      const t = fixture({
        black: ['B1', 'A3', 'B3', 'C3', 'D1', 'D2', ...colE],
        white: ['A2', 'B2', 'C2', ...colF],
        toMove: 'B',
        komi,
      });
      stepN(t, 'pass', 'pass');
      const s = compareScores(t);
      // Hand count: Black 15 stones + 25 territory = 40; White 12 stones + 27
      // territory (+komi); A1 and C1 reach both colors -> neutral.
      expect(s).toEqual({ black: 40, white: 39 + komi });
    }
  });

  it('F13 empty-board double pass: 0 vs komi in both engines (komi 7.5 wins W, komi 0 draws)', () => {
    for (const komi of [7.5, 0]) {
      const t = twinInitial(9, { komi });
      stepN(t, 'pass', 'pass');
      expect(t.state.ended).toBe(true);
      const s = compareScores(t); // compareScores also checks winner/draw parity
      expect(s).toEqual({ black: 0, white: komi });
    }
  });

  it('F14 stones stand as they are: full-board and lone-stone scoring agree', () => {
    // No dead-stone agreement: an uncaptured lone White stone keeps the whole
    // empty rest of the board neutral? No — empties reach BOTH colors -> dame,
    // unless only one color is present. Hand-count both cases.
    const lone = fixture({ black: ['E5'], white: ['C3'], toMove: 'B', komi: 0, ended: true });
    expect(compareScores(lone)).toEqual({ black: 1, white: 1 }); // 79 empties reach both

    const oneColor = fixture({ black: ['E5'], toMove: 'B', komi: 0, ended: true });
    expect(compareScores(oneColor)).toEqual({ black: 81, white: 0 }); // all empties reach only Black
  });

  it('F15 pass is always legal in both engines even when the position repeats', () => {
    const t = fixture({ black: ['D5'], white: ['F5'], toMove: 'B' });
    expect(probeBoth(t, { pass: true }).legal).toBe(true);
    stepN(t, 'pass'); // position unchanged and already in history — still legal
    expect(probeBoth(t, { pass: true }).legal).toBe(true);
  });

  it('F16 capture sequence bookkeeping: a two-pass end scores captures as area, identically', () => {
    // Black captures one stone, then both sides pass. Area scoring must count
    // the board as it stands (capture already removed the White stone).
    const t = fixture({ black: ['D5', 'F5', 'E4'], white: ['E5', 'A1'], toMove: 'B', komi: 0 });
    stepN(t, 'E6', 'pass', 'pass');
    expect(t.state.ended).toBe(true);
    compareScores(t); // exact parity; hand count: B stones 4, W stone 1, empties reach both
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Differential sweep with superko cross-checks
// ---------------------------------------------------------------------------

/** Candidate verdict for a play at board index idx (twin untouched). */
function candidateAccepts(twin: Twin, idx: number): boolean {
  const size = twin.state.size;
  const mv = { row: Math.floor(idx / size), col: idx % size };
  const bPlayer = twin.state.toMove === 'B' ? 1 : (2 as 1 | 2);
  const r = applyGoMove(twin.bBoard, bPlayer, mv, twin.bHistory, twin.state.allowSuicide);
  return !('error' in r);
}

/**
 * Superko/suicide asymmetry check: sample empty points and require the two
 * engines to agree on their legality in BOTH directions —
 *  (a) up to 3 empty points the incumbent does NOT list must be candidate-illegal;
 *  (b) 3 random empty points: candidate verdict must equal incumbent list
 *      membership (catches candidate-illegal points the incumbent lists).
 */
function crossCheck(twin: Twin, legal: GoMove[], pick: SeedStream): void {
  const size = twin.state.size;
  const legalIdx = new Set<number>();
  for (const m of legal) if (!m.pass) legalIdx.add(m.row * size + m.col);
  const empties: number[] = [];
  for (let i = 0; i < size * size; i++) if (twin.state.board[i] === '.') empties.push(i);

  const incumbentRejects = empties.filter((i) => !legalIdx.has(i));
  for (let k = 0; k < 3 && incumbentRejects.length > 0; k++) {
    const idx = incumbentRejects[pick.int('xcheck:rejected', incumbentRejects.length)]!;
    if (candidateAccepts(twin, idx)) {
      divergence(
        twin,
        `${idx % size},${Math.floor(idx / size)} (col,row)`,
        'incumbent omits this empty point from legal_moves but candidate B accepts it',
      );
    }
  }
  for (let k = 0; k < 3 && empties.length > 0; k++) {
    const idx = empties[pick.int('xcheck:any', empties.length)]!;
    const cand = candidateAccepts(twin, idx);
    const inc = legalIdx.has(idx);
    if (cand !== inc) {
      divergence(
        twin,
        `${idx % size},${Math.floor(idx / size)} (col,row)`,
        `asymmetric verdict on an empty point — incumbent ${inc ? 'lists' : 'omits'} it, candidate B ${
          cand ? 'accepts' : 'rejects'
        } it`,
      );
    }
  }
}

/**
 * One full seeded random game driven through the incumbent's legal-move list,
 * mirrored move by move into candidate B. Returns the ply count.
 */
function differentialGame(size: number, gameIdx: number): number {
  const pick = createSeedStream(sha256Hex(`ludus:tournament:go:${size}x${size}:game:${gameIdx}`));
  const twin = twinInitial(size);
  let plies = 0;
  const MAX_PLIES = 40_000; // superko guarantees termination; this is a loud failure bound
  while (!twin.state.ended) {
    if (plies >= MAX_PLIES) {
      throw new Error(`differential game ${size}x${size}#${gameIdx} exceeded ${MAX_PLIES} plies without ending`);
    }
    const player = twin.state.toMove === 'B' ? 'p0' : 'p1';
    const legal = go.legalMoves(twin.state, player);
    if (legal.length === 0) {
      throw new Error(`incumbent returned no legal moves in a live game: ${go.encodeState(twin.state)}`);
    }
    crossCheck(twin, legal, pick);
    const mv = legal[pick.int('move', legal.length)]!;
    stepBoth(twin, mv); // legality/captures/board parity asserted inside
    plies++;
  }
  compareScores(twin);
  return plies;
}

describe('go tournament: differential sweep (incumbent drives, candidate B mirrors)', () => {
  it(
    '1,000 seeded random 9x9 playouts agree on every verdict, board, capture, and final score',
    () => {
      let totalPlies = 0;
      for (let g = 0; g < 1000; g++) totalPlies += differentialGame(9, g);
      // eslint-disable-next-line no-console
      console.log(`go tournament 9x9 sweep: 1000 games, ${totalPlies} plies in lockstep`);
      // Sanity: games actually played out (random go on 9x9 averages ~100+ plies).
      expect(totalPlies).toBeGreaterThan(50_000);
    },
    { timeout: 600_000 },
  );

  it(
    '50 seeded random 13x13 playouts agree end to end',
    () => {
      let totalPlies = 0;
      for (let g = 0; g < 50; g++) totalPlies += differentialGame(13, g);
      // eslint-disable-next-line no-console
      console.log(`go tournament 13x13 sweep: 50 games, ${totalPlies} plies in lockstep`);
      expect(totalPlies).toBeGreaterThan(5_000);
    },
    { timeout: 600_000 },
  );

  it(
    '20 seeded random 9x9 playouts under allow_suicide agree end to end',
    () => {
      // Same differential loop but with the suicide variant on, since the
      // engines special-case it differently (incumbent: superko via unchanged
      // board; candidate: explicit removal then history check).
      const pickRoot = 'ludus:tournament:go:suicide';
      for (let g = 0; g < 20; g++) {
        const pick = createSeedStream(sha256Hex(`${pickRoot}:game:${g}`));
        const twin = twinInitial(9, { allow_suicide: true });
        let plies = 0;
        while (!twin.state.ended && plies < 40_000) {
          const player = twin.state.toMove === 'B' ? 'p0' : 'p1';
          const legal = go.legalMoves(twin.state, player);
          crossCheck(twin, legal, pick);
          const mv = legal[pick.int('move', legal.length)]!;
          stepBoth(twin, mv);
          plies++;
        }
        expect(twin.state.ended).toBe(true);
        compareScores(twin);
      }
    },
    { timeout: 600_000 },
  );
});

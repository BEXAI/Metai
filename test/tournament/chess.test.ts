/**
 * Stage-3 tournament: chess move generation.
 *   Incumbent  — src/games/chess/ (Game object; UCI moves; encodeState = FEN + R[..] L[..]).
 *   Candidate B — src/games/chess/candidates/b.ts (legalMovesFromFen / applyUci / perftFromFen).
 *
 * Judge criteria (LUDUS_BUILD_SPEC.json workflow.stage_3_tournaments):
 *   perft depths 1-5 exact, plus 10,000 random playout positions without error.
 *
 * These tests are re-runnable and deterministic (createSeedStream over sha256Hex
 * seeds). They PASS while the two engines agree and FAIL loudly with the
 * smallest reproducing FEN when they diverge.
 *
 * Known convention difference (adjudicated in notes/tournament-chess.md):
 * the incumbent FIDE-normalizes the FEN ep field (recorded only when a legal
 * ep capture exists — X-FEN style, documented in notes/T3a-chess.md), while
 * candidate B records the raw ep target after every double push (classic FEN).
 * FEN-core comparison therefore compares ep by *capturability* (normalizing
 * both sides with each engine's OWN move list); raw textual differences are
 * counted and surfaced but are not rule divergences.
 */

import { describe, expect, it } from 'vitest';
import chess, { decodeChessState, type ChessState } from '../../src/games/chess/index.ts';
import { START_FEN, perft as incumbentPerft, posFromFen } from '../../src/games/chess/rules.ts';
import {
  applyUci as bApplyUci,
  legalMovesFromFen as bLegalMoves,
  perftFromFen as bPerft,
} from '../../src/games/chess/candidates/b.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { isRuleError, type PlayerId } from '../../src/kernel/types.ts';

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const CPW_POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
const CPW_POS4 = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';

const PLAYERS: PlayerId[] = ['p0', 'p1'];

// ---------------------------------------------------------------------------
// Test-local helpers (independent of both engines' internals)
// ---------------------------------------------------------------------------

/** Plain 6-field FEN from the incumbent's encodeState (strip ' R[..] L[..]'). */
function plainFen(state: ChessState): string {
  const enc = chess.encodeState(state);
  const i = enc.indexOf(' R[');
  if (i < 0) throw new Error(`encodeState missing R[ segment: '${enc}'`);
  return enc.slice(0, i);
}

/** Piece char on an algebraic square from the FEN placement field alone ('.' = empty). */
function pieceAt(fen: string, sq: string): string {
  const placement = fen.split(' ')[0]!;
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  const row = placement.split('/')[7 - rank]!;
  let f = 0;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') {
      f += ch.charCodeAt(0) - 48;
      if (f > file) return '.';
    } else {
      if (f === file) return ch;
      f++;
    }
  }
  return '.';
}

/**
 * Is the FEN's ep square actually capturable, judged ONLY by the given legal
 * move list (a pawn of the side to move moving diagonally onto the ep square)?
 */
function epAvailable(fen: string, legalUcis: readonly string[]): boolean {
  const parts = fen.split(' ');
  const side = parts[1]!;
  const ep = parts[3]!;
  if (ep === '-') return false;
  const pawn = side === 'w' ? 'P' : 'p';
  return legalUcis.some(
    (u) => u.slice(2, 4) === ep && u.charAt(0) !== ep.charAt(0) && pieceAt(fen, u.slice(0, 2)) === pawn,
  );
}

function diffLists(a: readonly string[], b: readonly string[]): { onlyA: string[]; onlyB: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) };
}

interface SweepStats {
  games: number;
  positions: number;
  epConventionDiffs: number;
  epConventionExample: string | null;
  castlesWhite: number;
  castlesBlack: number;
  epCaptures: number;
  promotions: number;
  underpromotions: number;
}

const TOTAL: SweepStats = {
  games: 0,
  positions: 0,
  epConventionDiffs: 0,
  epConventionExample: null,
  castlesWhite: 0,
  castlesBlack: 0,
  epCaptures: 0,
  promotions: 0,
  underpromotions: 0,
};

/**
 * Drives seeded uniform-random games through the INCUMBENT Game interface.
 * At every non-terminal position: sorted UCI legal-move lists must be equal.
 * For every applied move: resulting FEN cores must match (placement, side,
 * castling, halfmove, fullmove strict; ep by capturability, see header).
 */
function runSweep(shard: string, games: number, startFen: string | null, plyCap: number): void {
  for (let g = 0; g < games; g++) {
    const seed = createSeedStream(sha256Hex(`tournament:chess:${shard}:game:${g}`));
    let state: ChessState =
      startFen === null ? chess.initialState(seed, PLAYERS, {}) : decodeChessState(startFen);
    let ply = 0;
    TOTAL.games++;

    while (chess.isTerminal(state) === null && ply < plyCap) {
      const mover = chess.playersToMove(state)[0];
      if (mover === undefined) throw new Error('non-terminal state with no player to move');
      const fen = plainFen(state);
      if (ply % 25 === 0) {
        // Guard the FEN extraction itself against the other public surface.
        const pv = chess.publicView(state) as { fen: string };
        expect(fen).toBe(pv.fen);
      }

      const incMoves = chess.legalMoves(state, mover);
      const bMoves = bLegalMoves(fen);
      if (incMoves.join(' ') !== bMoves.join(' ')) {
        const d = diffLists(incMoves, bMoves);
        expect.fail(
          `LEGAL-MOVE DIVERGENCE (repro FEN: "${fen}")\n` +
            `  incumbent-only: [${d.onlyA.join(', ')}]\n` +
            `  candidate-only: [${d.onlyB.join(', ')}]\n` +
            `  incumbent n=${incMoves.length} candidate n=${bMoves.length}\n` +
            `  shard=${shard} game=${g} ply=${ply}`,
        );
      }
      expect(incMoves.length).toBeGreaterThan(0);
      TOTAL.positions++;

      const uci = incMoves[seed.int(`pick:${ply}`, incMoves.length)]!;

      // Feature counters (from the pre-move FEN, engine-independent).
      const fromSq = uci.slice(0, 2);
      const toSq = uci.slice(2, 4);
      const piece = pieceAt(fen, fromSq);
      if (uci.length === 5) {
        TOTAL.promotions++;
        if (uci.charAt(4) !== 'q') TOTAL.underpromotions++;
      }
      if ((piece === 'K' || piece === 'k') && Math.abs(fromSq.charCodeAt(0) - toSq.charCodeAt(0)) === 2) {
        if (piece === 'K') TOTAL.castlesWhite++;
        else TOTAL.castlesBlack++;
      }
      if ((piece === 'P' || piece === 'p') && fromSq.charAt(0) !== toSq.charAt(0) && pieceAt(fen, toSq) === '.') {
        TOTAL.epCaptures++;
      }

      const res = chess.apply(state, mover, uci, seed);
      if (isRuleError(res)) {
        expect.fail(
          `incumbent rejected its own legal move '${uci}' (${res.code}: ${res.message})\n` +
            `  repro FEN: "${fen}" shard=${shard} game=${g} ply=${ply}`,
        );
        return;
      }
      const nextState = res.state;
      const incNext = plainFen(nextState);
      const bNext = bApplyUci(fen, uci);

      if (incNext !== bNext) {
        const ai = incNext.split(' ');
        const bi = bNext.split(' ');
        const labels = ['placement', 'side', 'castling', 'ep', 'halfmove', 'fullmove'] as const;
        const hard: string[] = [];
        for (const idx of [0, 1, 2, 4, 5]) {
          if (ai[idx] !== bi[idx]) hard.push(`${labels[idx]!}: incumbent '${ai[idx]}' vs candidate '${bi[idx]}'`);
        }
        if (ai[3] !== bi[3]) {
          // ep differs textually: compare by capturability, each engine judged
          // by its OWN legal-move list for the resulting position.
          const nextMover = chess.playersToMove(nextState)[0];
          const incLegalNext = nextMover === undefined ? [] : chess.legalMoves(nextState, nextMover);
          const incNorm = epAvailable(incNext, incLegalNext) ? ai[3]! : '-';
          const bNorm = epAvailable(bNext, bLegalMoves(bNext)) ? bi[3]! : '-';
          if (incNorm !== bNorm) {
            hard.push(
              `ep availability: incumbent '${ai[3]}' (normalized '${incNorm}') vs candidate '${bi[3]}' (normalized '${bNorm}')`,
            );
          } else {
            TOTAL.epConventionDiffs++;
            if (TOTAL.epConventionExample === null) {
              TOTAL.epConventionExample = `after '${uci}' from "${fen}": incumbent ep '${ai[3]}', candidate ep '${bi[3]}'`;
            }
          }
        }
        if (hard.length > 0) {
          expect.fail(
            `FEN-CORE DIVERGENCE after '${uci}' (repro FEN: "${fen}")\n` +
              `  incumbent: ${incNext}\n  candidate: ${bNext}\n` +
              hard.map((h) => `  ${h}`).join('\n') +
              `\n  shard=${shard} game=${g} ply=${ply}`,
          );
        }
      }

      state = nextState;
      ply++;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Spec criterion: perft depths 1-5 from the initial position, BOTH engines
// ---------------------------------------------------------------------------

describe('perft: initial position depths 1-5, both engines exact', () => {
  const EXPECTED = [20, 400, 8_902, 197_281, 4_865_609] as const;

  it('incumbent (rules.perft, importable engine helper): depths 1-5', { timeout: 600_000 }, () => {
    for (let d = 1; d <= 5; d++) {
      expect(incumbentPerft(posFromFen(START_FEN), d), `incumbent perft(${d})`).toBe(EXPECTED[d - 1]);
    }
  });

  it('candidate B (perftFromFen): depths 1-5', { timeout: 600_000 }, () => {
    for (let d = 1; d <= 5; d++) {
      expect(bPerft(START_FEN, d), `candidate perft(${d})`).toBe(EXPECTED[d - 1]);
    }
  });

  it('incumbent via the public Game interface (legalMoves/apply walk): depths 1-4', { timeout: 600_000 }, () => {
    const seed = createSeedStream(sha256Hex('tournament:chess:perft-walk'));
    function walk(state: ChessState, depth: number): number {
      const mover = chess.playersToMove(state)[0];
      if (mover === undefined) return 0; // terminal: no perft children
      const moves = chess.legalMoves(state, mover);
      if (depth === 1) return moves.length;
      let n = 0;
      for (const m of moves) {
        const res = chess.apply(state, mover, m, seed);
        if (isRuleError(res)) throw new Error(`apply rejected legal move ${m}: ${res.message}`);
        n += walk(res.state, depth - 1);
      }
      return n;
    }
    const root = decodeChessState(START_FEN);
    for (let d = 1; d <= 4; d++) {
      expect(walk(root, d), `Game-interface perft(${d})`).toBe(EXPECTED[d - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Differential sweep: seeded random games via the incumbent Game interface
// ---------------------------------------------------------------------------

describe('differential sweep: incumbent vs candidate B on random playouts', () => {
  for (let shard = 0; shard < 6; shard++) {
    it(`shard ${shard}: 50 seeded games from the initial position`, { timeout: 600_000 }, () => {
      runSweep(`initial:${shard}`, 50, null, 250);
    });
  }

  it('feature shard: promotion-rich starts', { timeout: 600_000 }, () => {
    runSweep('promo', 8, '8/PPPP1k2/8/8/8/8/pppp1K2/8 w - - 0 1', 200);
  });

  it('feature shard: castling-rich starts', { timeout: 600_000 }, () => {
    runSweep('castle', 16, 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 200);
  });

  it('feature shard: en-passant-rich starts (white and black captures)', { timeout: 600_000 }, () => {
    runSweep('ep-w', 8, '4k3/pppppppp/8/P1P1P1P1/8/8/8/4K3 w - - 0 1', 200);
    runSweep('ep-b', 8, '4k3/8/8/8/p1p1p1p1/8/PPPPPPPP/4K3 w - - 0 1', 200);
  });

  it('coverage: >= 10,000 positions, >= 300 games, all special moves exercised', () => {
    console.log(`[tournament:chess] sweep stats ${JSON.stringify(TOTAL)}`);
    expect(TOTAL.positions).toBeGreaterThanOrEqual(10_000);
    expect(TOTAL.games).toBeGreaterThanOrEqual(300);
    expect(TOTAL.promotions).toBeGreaterThan(0);
    expect(TOTAL.underpromotions).toBeGreaterThan(0);
    expect(TOTAL.castlesWhite).toBeGreaterThan(0);
    expect(TOTAL.castlesBlack).toBeGreaterThan(0);
    expect(TOTAL.epCaptures).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fixture spot-checks: Kiwipete + CPW positions 3/4
// ---------------------------------------------------------------------------

describe('fixtures: Kiwipete and CPW positions 3/4', () => {
  const CASES: ReadonlyArray<{ name: string; fen: string; d1: number; d3: number }> = [
    { name: 'Kiwipete', fen: KIWIPETE, d1: 48, d3: 97_862 },
    { name: 'CPW position 3', fen: CPW_POS3, d1: 14, d3: 2_812 },
    { name: 'CPW position 4', fen: CPW_POS4, d1: 6, d3: 9_467 },
  ];

  for (const c of CASES) {
    it(`${c.name}: depth-1 move lists identical and correct`, () => {
      const state = decodeChessState(c.fen);
      const mover = chess.playersToMove(state)[0]!;
      const incMoves = chess.legalMoves(state, mover);
      const bMoves = bLegalMoves(c.fen);
      const d = diffLists(incMoves, bMoves);
      expect(
        d.onlyA.length + d.onlyB.length,
        `move-list divergence at "${c.fen}" — incumbent-only [${d.onlyA.join(', ')}], candidate-only [${d.onlyB.join(', ')}]`,
      ).toBe(0);
      expect(incMoves).toEqual(bMoves);
      expect(incMoves).toHaveLength(c.d1);
    });

    it(`${c.name}: perft(3) exact for both engines`, { timeout: 600_000 }, () => {
      expect(incumbentPerft(posFromFen(c.fen), 3), `incumbent perft(3) at ${c.name}`).toBe(c.d3);
      expect(bPerft(c.fen, 3), `candidate perft(3) at ${c.name}`).toBe(c.d3);
    });
  }
});

/**
 * Gate A3: perft node counts from the initial position (depths 1-5) and the
 * Kiwipete position (depths 1-4). Also pins legalMoves() to perft(1) so the
 * public API and the internal fast path can never disagree.
 */

import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../../kernel/seed.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { playerId } from '../../../kernel/types.ts';
import chess from '../index.ts';
import { genLegal, perft, posFromFen, START_FEN, stateToPos } from '../rules.ts';

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

describe('perft: initial position', () => {
  const expected: [depth: number, nodes: number][] = [
    [1, 20],
    [2, 400],
    [3, 8_902],
    [4, 197_281],
    [5, 4_865_609],
  ];
  for (const [depth, nodes] of expected) {
    it(`depth ${depth} = ${nodes}`, { timeout: 600_000 }, () => {
      const pos = posFromFen(START_FEN);
      expect(perft(pos, depth)).toBe(nodes);
    });
  }
});

describe('perft: Kiwipete', () => {
  const expected: [depth: number, nodes: number][] = [
    [1, 48],
    [2, 2_039],
    [3, 97_862],
    [4, 4_085_603],
  ];
  for (const [depth, nodes] of expected) {
    it(`depth ${depth} = ${nodes}`, { timeout: 600_000 }, () => {
      const pos = posFromFen(KIWIPETE);
      expect(perft(pos, depth)).toBe(nodes);
    });
  }
});

describe('tricky known positions (perft 1-3)', () => {
  // CPW standard test positions 3, 4, 5 with published node counts.
  const cases: [fen: string, counts: number[]][] = [
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2_812, 43_238]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9_467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1_486, 62_379]],
  ];
  for (const [fen, counts] of cases) {
    it(`perft of ${fen.split(' ')[0]}`, { timeout: 600_000 }, () => {
      const pos = posFromFen(fen);
      counts.forEach((nodes, i) => {
        expect(perft(pos, i + 1)).toBe(nodes);
      });
    });
  }
});

describe('legalMoves matches perft(1)', () => {
  it('initial position: 20 moves via the public API', () => {
    const seed = createSeedStream(sha256Hex('chess perft seed'));
    const state = chess.initialState(seed, [playerId(0), playerId(1)], {});
    const moves = chess.legalMoves(state, playerId(0));
    expect(moves.length).toBe(20);
    expect(chess.legalMoves(state, playerId(1))).toEqual([]);
    // canonical order = sorted UCI
    expect([...moves].sort()).toEqual(moves);
  });

  it('Kiwipete: 48 moves via the public API and genLegal', () => {
    const state = chess.decodeState(KIWIPETE);
    expect(chess.legalMoves(state, playerId(0)).length).toBe(48);
    expect(genLegal(stateToPos(state)).length).toBe(48);
  });
});

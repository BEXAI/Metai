/** Shared fixture helpers for the islanders test suite. */

import { sha256Hex } from '../../../crypto/canonical.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isRuleError, playerId, type SeedStream } from '../../../kernel/types.ts';
import {
  applyMove,
  createInitialState,
  SUPPLY_ROADS,
  SUPPLY_VILLAGES,
  SUPPLY_CITIES,
  type IslMove,
  type IslState,
  type Multiset,
} from '../rules.ts';

export function seatPlayers(n: number): string[] {
  return Array.from({ length: n }, (_, i) => playerId(i));
}

export function freshSeed(tag: string): SeedStream {
  return createSeedStream(sha256Hex(tag));
}

/**
 * Bare post-setup state in main phase, turn 1, p0 to act, no buildings.
 * Tests place buildings and hands surgically (states are plain JSON).
 */
export function craft(n: number, mods: Partial<IslState> = {}): IslState {
  const s = createInitialState(freshSeed('craft'), seatPlayers(n), {});
  s.phase = 'main';
  s.turn = 1;
  s.currentSeat = 0;
  s.setupMoves = 4 * n;
  Object.assign(s, mods);
  return s;
}

/** Move resources from the bank into a player's hand. */
export function give(s: IslState, p: string, ms: Multiset): void {
  for (const [r, c] of Object.entries(ms)) {
    s.bank[r] = (s.bank[r] ?? 0) - c;
    s.hands[p]![r] = (s.hands[p]![r] ?? 0) + c;
  }
}

export function placeVillage(s: IslState, vertex: string, p: string): void {
  s.villages[vertex] = p;
  s.supply[p]!['villages'] = (s.supply[p]!['villages'] ?? SUPPLY_VILLAGES) - 1;
}

export function placeCity(s: IslState, vertex: string, p: string): void {
  s.cities[vertex] = p;
  s.supply[p]!['cities'] = (s.supply[p]!['cities'] ?? SUPPLY_CITIES) - 1;
}

export function placeRoad(s: IslState, edge: string, p: string): void {
  s.roads[edge] = p;
  s.supply[p]!['roads'] = (s.supply[p]!['roads'] ?? SUPPLY_ROADS) - 1;
}

/** Apply a move that must succeed; throws with the rule error otherwise. */
export function mustApply(s: IslState, p: string, move: IslMove, seed?: SeedStream): IslState {
  const res = applyMove(s, p, move, seed ?? freshSeed(`apply:${p}:${JSON.stringify(move)}`));
  if (isRuleError(res)) throw new Error(`apply failed: ${res.code}: ${res.message}`);
  return res.state;
}

/** Apply a move that must be rejected; returns the rule error code. */
export function mustReject(s: IslState, p: string, move: IslMove, seed?: SeedStream): string {
  const res = applyMove(s, p, move, seed ?? freshSeed('reject'));
  if (!isRuleError(res)) throw new Error(`expected rejection of ${JSON.stringify(move)}, but it was applied`);
  return res.code;
}

/** Deterministic search for a seed whose dice roll for `turn` satisfies pred. */
export function seedForRoll(turn: number, pred: (total: number) => boolean): SeedStream {
  for (let i = 0; ; i++) {
    const hex = sha256Hex(`roll:${turn}:${i}`);
    const probe = createSeedStream(hex);
    const total = probe.die(`dice:turn:${turn}`, 6) + probe.die(`dice:turn:${turn}`, 6);
    if (pred(total)) return createSeedStream(hex);
  }
}

/** Hex string of the seed found by the same search (for recomputing draws). */
export function seedHexForRoll(turn: number, pred: (total: number) => boolean): string {
  for (let i = 0; ; i++) {
    const hex = sha256Hex(`roll:${turn}:${i}`);
    const probe = createSeedStream(hex);
    const total = probe.die(`dice:turn:${turn}`, 6) + probe.die(`dice:turn:${turn}`, 6);
    if (pred(total)) return hex;
  }
}

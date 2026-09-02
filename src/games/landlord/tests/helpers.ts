/** Shared fixture helpers for the landlord test suite. */

import { sha256Hex } from '../../../crypto/canonical.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isRuleError, type GameEvent, type RuleError, type SeedStream } from '../../../kernel/types.ts';
import { parseLandlordMove } from '../notation.ts';
import { applyMove, makeInitialState, type LandlordMove, type LandlordState } from '../rules.ts';
import { isParseError } from '../../../kernel/types.ts';

export function seed(tag = 'fixture'): SeedStream {
  return createSeedStream(sha256Hex(tag));
}

export function fresh(nPlayers = 2, tag = 'fixture', variant: { [k: string]: string | number | boolean } = {}): LandlordState {
  const players = Array.from({ length: nPlayers }, (_, i) => `p${i}`);
  const st = makeInitialState(seed(tag), players, variant);
  st.current = 'p0'; // fixtures assume p0 on turn unless stated otherwise
  return st;
}

/** Apply a move written in notation; throws on parse or rule errors. */
export function play(st: LandlordState, player: string, notation: string, s: SeedStream = seed('play')): { state: LandlordState; events: GameEvent[] } {
  const mv = parseLandlordMove(notation);
  if (isParseError(mv)) throw new Error(`parse failed for '${notation}': ${mv.message}`);
  const res = applyMove(st, player, mv, s);
  if (isRuleError(res)) throw new Error(`'${notation}' by ${player} rejected: ${res.code} ${res.message}`);
  return res;
}

/** Apply a move expecting a rule error; returns it. */
export function playErr(st: LandlordState, player: string, notation: string, s: SeedStream = seed('play')): RuleError {
  const mv = parseLandlordMove(notation);
  if (isParseError(mv)) throw new Error(`parse failed for '${notation}': ${mv.message}`);
  const res = applyMove(st, player, mv, s);
  if (!isRuleError(res)) throw new Error(`expected '${notation}' by ${player} to be rejected`);
  return res;
}

export function applyRaw(st: LandlordState, player: string, mv: LandlordMove, s: SeedStream = seed('play')): { state: LandlordState; events: GameEvent[] } {
  const res = applyMove(st, player, mv, s);
  if (isRuleError(res)) throw new Error(`move rejected: ${res.code} ${res.message}`);
  return res;
}

/** Find a seed whose first movement roll ('dice:roll:1') satisfies pred. */
export function findRollSeed(pred: (d1: number, d2: number) => boolean): SeedStream {
  for (let i = 0; i < 10_000; i++) {
    const hex = sha256Hex(`roll-hunt:${i}`);
    const probe = createSeedStream(hex);
    const d1 = probe.die('dice:roll:1', 6);
    const d2 = probe.die('dice:roll:1', 6);
    if (pred(d1, d2)) return createSeedStream(hex);
  }
  throw new Error('no seed found');
}

/** Give a player a property (fixture mutation). */
export function grant(st: LandlordState, player: string, ...props: string[]): void {
  for (const id of props) {
    const ps = st.props[id];
    if (!ps) throw new Error(`unknown prop ${id}`);
    ps.owner = player;
  }
}

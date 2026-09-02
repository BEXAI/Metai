/**
 * Placeholder game used only during the build so the registry typechecks
 * before a track lands its real module. Every method throws. A stub must be
 * gone from src/games/index.ts imports by integration; test/no-stubs.test.ts
 * enforces it at the end of stage 1.
 */

import type { AnyGame, GameMeta } from './types.ts';

export function stubGame(id: string, name: string, minPlayers = 2, maxPlayers = 2): AnyGame {
  const meta: GameMeta = {
    id,
    name,
    players: { min: minPlayers, max: maxPlayers },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation: 'not implemented',
    boardText: 'not implemented',
    listed: false,
  };
  const boom = (): never => {
    throw new Error(`game '${id}' is a stub — its build track has not landed yet`);
  };
  return {
    meta,
    initialState: boom,
    playersToMove: boom,
    legalMoves: boom,
    apply: boom,
    isTerminal: boom,
    publicView: boom,
    privateView: boom,
    renderText: boom,
    encodeState: boom,
    decodeState: boom,
    parseMove: boom,
    moveToNotation: boom,
  };
}

export function isStub(game: AnyGame): boolean {
  return game.meta.notation === 'not implemented';
}

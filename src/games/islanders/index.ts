/**
 * Islanders — original island-settlement game for 3-4 players (spec
 * games.M3_hidden_information_and_trading.islanders). Hidden information:
 * resource hand contents (counts public) and unplayed saga cards.
 */

import type { Game, Json, PlayerId, SeedStream, VariantConfig } from '../../kernel/types.ts';
import { canonicalJson } from '../../crypto/canonical.ts';
import {
  applyMove,
  createInitialState,
  isTerminal,
  legalMoves,
  moveToNotation,
  playersToMove,
  secretProbes,
  type IslMove,
  type IslState,
} from './rules.ts';
import { moveSummary, parseMove } from './notation.ts';
import { privateView, publicView, renderText } from './render.ts';

export { secretProbes };

const PAGE_SIZE = 1000;

const islanders: Game<IslState, IslMove> = {
  meta: {
    id: 'islanders',
    name: 'Islanders',
    players: { min: 3, max: 4 },
    information: 'hidden',
    randomness: 'both',
    variants: {
      layout: {
        description: "Board layout: 'beginner' is the fixed documented island; 'random' shuffles terrain and number tokens from the seed (harbors stay fixed).",
        values: ['beginner', 'random'],
        default: 'beginner',
      },
    },
    notation:
      'build_road(AB), build_village(ABa), build_city(ABa), buy_progress, play_progress(warrior,hex,victim|-), play_progress(pathfinder,e1[,e2]), play_progress(bounty,res+res), play_progress(tithe,res), trade_bank(give,get), offer(give,get,to), accept(id), reject(id), counter(id,give,get), move_bandit(hex,victim|-), discard(res+res+...), end_turn',
    boardText:
      '19 land hexes lettered A-S with terrain and number tokens, ringed by sea hexes a-r; vertices are the 3 touching hex letters (ABa), edges the 2 (AB); buildings, bank, harbors, and public counts are listed below the map.',
    listed: true,
  },

  initialState(seed: SeedStream, players: PlayerId[], variant: VariantConfig): IslState {
    return createInitialState(seed, players, variant);
  },

  playersToMove,
  legalMoves,

  legalMovesPaged(state: IslState, player: PlayerId, page: number) {
    const all = legalMoves(state, player);
    const start = Math.max(0, page) * PAGE_SIZE;
    return { moves: all.slice(start, start + PAGE_SIZE), total: all.length, pageSize: PAGE_SIZE };
  },

  apply: applyMove,
  isTerminal,
  publicView,
  privateView,
  renderText,

  encodeState(state: IslState): string {
    return canonicalJson(state);
  },

  viewStateString(state: IslState, viewer: string): string {
    // Hidden: everyone's hand contents, unplayed/bought saga cards, and the
    // saga deck order. The viewer keeps their OWN hand and cards; every other
    // player collapses to counts; the deck collapses to its remaining count.
    const hands: { [k: string]: Json } = {};
    const progress: { [k: string]: Json } = {};
    const bought: { [k: string]: Json } = {};
    for (const p of state.players) {
      const hand = state.hands[p] ?? {};
      const prog = state.progress[p] ?? [];
      const bgt = state.bought[p] ?? [];
      if (p === viewer) {
        hands[p] = { ...hand };
        progress[p] = [...prog];
        bought[p] = [...bgt];
      } else {
        hands[p] = { total: Object.values(hand).reduce((a, b) => a + b, 0) };
        progress[p] = { count: prog.length };
        bought[p] = { count: bgt.length };
      }
    }
    const { deck, ...open } = state;
    return canonicalJson({ ...open, hands, progress, bought, deck_remaining: deck.length } as unknown as Json);
  },

  decodeState(encoded: string): IslState {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as IslState).players)) {
      throw new Error('islanders: invalid encoded state');
    }
    return parsed as IslState;
  },

  parseMove,
  moveToNotation(move: IslMove): string {
    return moveToNotation(move);
  },
  moveSummary,

  defaultMove(state: IslState, _player: PlayerId, legal: IslMove[]): IslMove {
    const preferred = legal.find((m) => m.type === 'end_turn') ?? legal.find((m) => m.type === 'reject');
    return preferred ?? legal[0]!;
  },
};

export default islanders;

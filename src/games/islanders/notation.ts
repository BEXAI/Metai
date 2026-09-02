/**
 * Islanders notation: verb or verb(args). Args are comma-separated; resource
 * multisets are '+'-joined resource names in canonical order (palm, coral,
 * reed, taro, obsidian), e.g. offer(palm+palm,taro,p2). parseMove accepts this
 * notation only — index fallback ('#7') is kernel-level.
 */

import type { ParseError, PlayerId } from '../../kernel/types.ts';
import {
  RESOURCES,
  isEdgeId,
  isVertexId,
  msToNotation,
  moveToNotation,
  type IslMove,
  type IslState,
  type Multiset,
  NO_VICTIM,
  LAND_LETTERS,
  PLAYABLE_CARDS,
} from './rules.ts';

export { moveToNotation };

function bad(message: string): ParseError {
  return { parseError: true, message };
}

function parseMultiset(text: string): Multiset | null {
  if (text.length === 0) return null;
  const ms: Multiset = {};
  for (const part of text.split('+')) {
    if (!(RESOURCES as readonly string[]).includes(part)) return null;
    ms[part] = (ms[part] ?? 0) + 1;
  }
  return ms;
}

function isPlayerRef(s: IslState, x: string): boolean {
  return s.players.includes(x);
}

export function parseMove(input: string, state: IslState, _player: PlayerId): IslMove | ParseError {
  const text = input.trim();
  const m = /^([a-z_]+)(?:\(([^)]*)\))?$/.exec(text);
  if (!m) return bad(`cannot parse '${text}' — expected verb or verb(args)`);
  const verb = m[1]!;
  const args = m[2] === undefined || m[2] === '' ? [] : m[2].split(',').map((a) => a.trim());

  switch (verb) {
    case 'build_road': {
      if (args.length !== 1 || !isEdgeId(args[0]!)) return bad('build_road(edge) needs a 2-letter edge id like AB');
      return { type: 'build_road', edge: args[0]! };
    }
    case 'build_village': {
      if (args.length !== 1 || !isVertexId(args[0]!)) return bad('build_village(vertex) needs a 3-letter vertex id like ABa');
      return { type: 'build_village', vertex: args[0]! };
    }
    case 'build_city': {
      if (args.length !== 1 || !isVertexId(args[0]!)) return bad('build_city(vertex) needs a 3-letter vertex id like ABa');
      return { type: 'build_city', vertex: args[0]! };
    }
    case 'buy_progress': {
      if (args.length !== 0) return bad('buy_progress takes no arguments');
      return { type: 'buy_progress' };
    }
    case 'play_progress': {
      if (args.length < 1) return bad('play_progress(card, ...) needs a card name');
      const card = args[0]!;
      switch (card) {
        case 'warrior': {
          if (args.length !== 3) return bad('play_progress(warrior,hex,victim) — victim is a player id or -');
          const hex = args[1]!;
          const victim = args[2]!;
          if (!LAND_LETTERS.includes(hex)) return bad(`unknown hex '${hex}'`);
          if (victim !== NO_VICTIM && !isPlayerRef(state, victim)) return bad(`unknown victim '${victim}'`);
          return { type: 'play_progress', card: 'warrior', hex, victim };
        }
        case 'pathfinder': {
          const edges = args.slice(1);
          if (edges.length < 1 || edges.length > 2) return bad('play_progress(pathfinder,edge[,edge]) places 1-2 roads');
          for (const e of edges) if (!isEdgeId(e)) return bad(`unknown edge '${e}'`);
          return { type: 'play_progress', card: 'pathfinder', edges };
        }
        case 'bounty': {
          if (args.length !== 2) return bad('play_progress(bounty,res[+res])');
          const take = parseMultiset(args[1]!);
          if (!take) return bad(`bad resource list '${args[1]}'`);
          return { type: 'play_progress', card: 'bounty', take };
        }
        case 'tithe': {
          if (args.length !== 2 || !(RESOURCES as readonly string[]).includes(args[1]!)) {
            return bad('play_progress(tithe,resource) names one resource');
          }
          return { type: 'play_progress', card: 'tithe', resource: args[1]! };
        }
        default:
          return bad(`unknown saga card '${card}' — playable cards: ${PLAYABLE_CARDS.join(', ')}`);
      }
    }
    case 'trade_bank': {
      if (
        args.length !== 2 ||
        !(RESOURCES as readonly string[]).includes(args[0]!) ||
        !(RESOURCES as readonly string[]).includes(args[1]!)
      ) {
        return bad('trade_bank(give,get) needs two resource names');
      }
      return { type: 'trade_bank', give: args[0]!, get: args[1]! };
    }
    case 'offer': {
      if (args.length !== 3) return bad('offer(give,get,to) e.g. offer(palm+palm,taro,p2)');
      const give = parseMultiset(args[0]!);
      const get = parseMultiset(args[1]!);
      if (!give || !get) return bad('offer give/get must be +-joined resource names');
      if (!isPlayerRef(state, args[2]!)) return bad(`unknown player '${args[2]}'`);
      return { type: 'offer', give, get, to: args[2]! };
    }
    case 'accept':
    case 'reject': {
      if (args.length !== 1 || !/^\d+$/.test(args[0]!)) return bad(`${verb}(id) needs a numeric offer id`);
      return { type: verb, id: Number(args[0]!) };
    }
    case 'counter': {
      if (args.length !== 3 || !/^\d+$/.test(args[0]!)) return bad('counter(id,give,get)');
      const give = parseMultiset(args[1]!);
      const get = parseMultiset(args[2]!);
      if (!give || !get) return bad('counter give/get must be +-joined resource names');
      return { type: 'counter', id: Number(args[0]!), give, get };
    }
    case 'move_bandit': {
      if (args.length !== 2) return bad('move_bandit(hex,victim) — victim is a player id or -');
      const hex = args[0]!;
      const victim = args[1]!;
      if (!LAND_LETTERS.includes(hex)) return bad(`unknown hex '${hex}'`);
      if (victim !== NO_VICTIM && !isPlayerRef(state, victim)) return bad(`unknown victim '${victim}'`);
      return { type: 'move_bandit', hex, victim };
    }
    case 'discard': {
      if (args.length !== 1) return bad('discard(res+res+...)');
      const cards = parseMultiset(args[0]!);
      if (!cards) return bad(`bad resource list '${args[0]}'`);
      return { type: 'discard', cards };
    }
    case 'end_turn': {
      if (args.length !== 0) return bad('end_turn takes no arguments');
      return { type: 'end_turn' };
    }
    default:
      return bad(`unknown move '${verb}'`);
  }
}

export function moveSummary(move: IslMove, _state: IslState): string {
  switch (move.type) {
    case 'build_road':
      return `builds a road on ${move.edge}`;
    case 'build_village':
      return `founds a village at ${move.vertex}`;
    case 'build_city':
      return `raises a city at ${move.vertex}`;
    case 'buy_progress':
      return 'buys a saga card';
    case 'play_progress':
      switch (move.card) {
        case 'warrior':
          return move.victim === NO_VICTIM
            ? `plays a warrior, sending the raider to ${move.hex}`
            : `plays a warrior, sending the raider to ${move.hex} and robbing ${move.victim}`;
        case 'pathfinder':
          return `plays a pathfinder, laying roads on ${move.edges.join(' and ')}`;
        case 'bounty':
          return `plays a bounty, taking ${msToNotation(move.take).replaceAll('+', ' and ')} from the bank`;
        case 'tithe':
          return `plays a tithe, collecting every ${move.resource}`;
      }
      break;
    case 'trade_bank':
      return `trades ${move.give} to the bank for 1 ${move.get}`;
    case 'offer':
      return `offers ${msToNotation(move.give).replaceAll('+', ' + ')} for ${msToNotation(move.get).replaceAll('+', ' + ')} to ${move.to}`;
    case 'accept':
      return `accepts trade offer #${move.id}`;
    case 'reject':
      return `rejects trade offer #${move.id}`;
    case 'counter':
      return `counters offer #${move.id}: ${msToNotation(move.give).replaceAll('+', ' + ')} for ${msToNotation(move.get).replaceAll('+', ' + ')}`;
    case 'move_bandit':
      return move.victim === NO_VICTIM
        ? `moves the raider to ${move.hex}`
        : `moves the raider to ${move.hex} and robs ${move.victim}`;
    case 'discard':
      return `discards ${msToNotation(move.cards).replaceAll('+', ', ')}`;
    case 'end_turn':
      return 'ends the turn';
  }
  /* c8 ignore next */
  return '';
}

/**
 * Landlord move notation. Phase-tagged actions:
 *
 *   roll · buy · decline · end_turn · pay_detention · use_card · pay_debt
 *   declare_bankruptcy · auction_bid(120) · build(quarry,1)
 *   sell_buildings(quarry,1) · mortgage(quarry) · unmortgage(quarry)
 *   offer({"get":{"cash":180,"props":[],"writs":0},"give":{"cash":0,"props":["quarry"],"writs":0},"note":null,"to":"p1"})
 *   accept(3) · reject(3) · counter(3,{"get":{...},"give":{...},"note":null})
 *
 * Bundles in offer/counter JSON use canonical-JSON key order (get, give, note,
 * to). moveToNotation and parseMove are exact inverses.
 */

import { canonicalJson } from '../../crypto/canonical.ts';
import type { Json, ParseError } from '../../kernel/types.ts';
import { MAX_NOTE_CHARS, propName, propPrice } from './board.ts';
import type { Bundle, LandlordMove, LandlordState } from './rules.ts';

function bad(message: string): ParseError {
  return { parseError: true, message };
}

const SIMPLE: readonly LandlordMove['t'][] = [
  'roll',
  'buy',
  'decline',
  'end_turn',
  'pay_detention',
  'use_card',
  'pay_debt',
  'declare_bankruptcy',
];

function parseBundle(x: unknown): Bundle | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as { [k: string]: unknown };
  if (typeof o['cash'] !== 'number' || typeof o['writs'] !== 'number' || !Array.isArray(o['props'])) return null;
  const props: string[] = [];
  for (const p of o['props'] as unknown[]) {
    if (typeof p !== 'string') return null;
    props.push(p);
  }
  return { cash: o['cash'], props, writs: o['writs'] };
}

function parseNote(x: unknown): string | null | undefined {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string') return undefined; // undefined = invalid
  if (x.length > MAX_NOTE_CHARS) return undefined;
  return x;
}

export function parseLandlordMove(input: string): LandlordMove | ParseError {
  const s = input.trim();
  if ((SIMPLE as readonly string[]).includes(s)) return { t: s as LandlordMove['t'] } as LandlordMove;
  if (s === 'pay_jail') return { t: 'pay_detention' }; // spec-listed alias

  let m = /^auction_bid\((\d+)\)$/.exec(s);
  if (m) return { t: 'auction_bid', amount: Number(m[1]) };

  m = /^(build|sell_buildings)\(([a-z_]+),(\d+)\)$/.exec(s);
  if (m) return { t: m[1] as 'build' | 'sell_buildings', prop: m[2]!, n: Number(m[3]) };

  m = /^(mortgage|unmortgage)\(([a-z_]+)\)$/.exec(s);
  if (m) return { t: m[1] as 'mortgage' | 'unmortgage', prop: m[2]! };

  m = /^(accept|reject)\((\d+)\)$/.exec(s);
  if (m) return { t: m[1] as 'accept' | 'reject', id: Number(m[2]) };

  m = /^offer\((\{[\s\S]*\})\)$/.exec(s);
  if (m) {
    let body: unknown;
    try {
      body = JSON.parse(m[1]!);
    } catch {
      return bad('offer(...) body is not valid JSON');
    }
    const o = body as { [k: string]: unknown };
    const give = parseBundle(o['give']);
    const get = parseBundle(o['get']);
    const note = parseNote(o['note']);
    if (!give || !get) return bad('offer needs give and get bundles: {"cash":int,"props":[ids],"writs":int}');
    if (note === undefined) return bad(`offer note must be a string of at most ${MAX_NOTE_CHARS} characters`);
    if (typeof o['to'] !== 'string') return bad('offer needs "to": a player id');
    return { t: 'offer', to: o['to'], give, get, note };
  }

  m = /^counter\((\d+),(\{[\s\S]*\})\)$/.exec(s);
  if (m) {
    let body: unknown;
    try {
      body = JSON.parse(m[2]!);
    } catch {
      return bad('counter(id, ...) body is not valid JSON');
    }
    const o = body as { [k: string]: unknown };
    const give = parseBundle(o['give']);
    const get = parseBundle(o['get']);
    const note = parseNote(o['note']);
    if (!give || !get) return bad('counter needs give and get bundles: {"cash":int,"props":[ids],"writs":int}');
    if (note === undefined) return bad(`counter note must be a string of at most ${MAX_NOTE_CHARS} characters`);
    return { t: 'counter', id: Number(m[1]), give, get, note };
  }

  return bad(
    'unrecognized move; expected one of: roll, buy, decline, end_turn, pay_detention, use_card, pay_debt, ' +
      'declare_bankruptcy, auction_bid(N), build(prop,n), sell_buildings(prop,n), mortgage(prop), unmortgage(prop), ' +
      'offer({...}), accept(id), reject(id), counter(id,{...})',
  );
}

export function landlordMoveToNotation(move: LandlordMove): string {
  switch (move.t) {
    case 'roll':
    case 'buy':
    case 'decline':
    case 'end_turn':
    case 'pay_detention':
    case 'use_card':
    case 'pay_debt':
    case 'declare_bankruptcy':
      return move.t;
    case 'auction_bid':
      return `auction_bid(${move.amount})`;
    case 'build':
      return `build(${move.prop},${move.n})`;
    case 'sell_buildings':
      return `sell_buildings(${move.prop},${move.n})`;
    case 'mortgage':
      return `mortgage(${move.prop})`;
    case 'unmortgage':
      return `unmortgage(${move.prop})`;
    case 'offer':
      return `offer(${canonicalJson({ get: move.get, give: move.give, note: move.note, to: move.to } as unknown as Json)})`;
    case 'accept':
      return `accept(${move.id})`;
    case 'reject':
      return `reject(${move.id})`;
    case 'counter':
      return `counter(${move.id},${canonicalJson({ get: move.get, give: move.give, note: move.note } as unknown as Json)})`;
  }
}

function bundleText(b: Bundle): string {
  const parts: string[] = [];
  if (b.cash > 0) parts.push(`$${b.cash}`);
  for (const id of b.props) parts.push(propName(id));
  if (b.writs > 0) parts.push(`${b.writs} writ${b.writs > 1 ? 's' : ''}`);
  return parts.length ? parts.join(' + ') : 'nothing';
}

export function landlordMoveSummary(move: LandlordMove, st: LandlordState): string {
  switch (move.t) {
    case 'roll':
      return st.detained[st.current] ?? false ? 'tries to roll doubles for release' : 'rolls the dice';
    case 'buy': {
      const id = st.pendingProp;
      return id ? `buys ${propName(id)} for ${propPrice(id)}` : 'buys the property';
    }
    case 'decline':
      return st.phase === 'auction' ? 'passes on bidding' : 'declines to buy; the property goes to auction';
    case 'auction_bid':
      return `bids ${move.amount}${st.auction ? ` for ${propName(st.auction.prop)}` : ''}`;
    case 'build':
      return `builds ${move.n === 1 ? 'a house' : `${move.n} houses`} on ${propName(move.prop)}`;
    case 'sell_buildings':
      return `sells ${move.n === 5 ? 'the hotel' : move.n === 1 ? 'a building' : `${move.n} buildings`} on ${propName(move.prop)}`;
    case 'mortgage':
      return `mortgages ${propName(move.prop)}`;
    case 'unmortgage':
      return `lifts the mortgage on ${propName(move.prop)}`;
    case 'offer':
      return `offers ${move.to}: gives ${bundleText(move.give)} for ${bundleText(move.get)}`;
    case 'accept':
      return `accepts trade #${move.id}`;
    case 'reject':
      return `rejects trade #${move.id}`;
    case 'counter':
      return `counters trade #${move.id}: gives ${bundleText(move.give)} for ${bundleText(move.get)}`;
    case 'pay_detention':
      return 'pays the 50 fine and will roll normally';
    case 'use_card':
      return 'plays a Release Writ';
    case 'pay_debt':
      return 'settles the outstanding debt';
    case 'declare_bankruptcy':
      return 'declares bankruptcy';
    case 'end_turn':
      return 'ends the turn';
  }
}

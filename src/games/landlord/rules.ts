/**
 * Landlord — pure rules. Phase machine over plain-JSON state:
 *
 *   roll -> (movement, landing resolution) -> buy_or_auction? -> auction?
 *        -> manage (build/sell/mortgage/trade) -> end_turn
 *   debt is entered whenever a player owes more cash than they hold; they sell
 *   buildings / mortgage until they can pay_debt or must declare_bankruptcy.
 *
 * All randomness is drawn from the SeedStream:
 *   'first_player'        one int at setup
 *   'shuffle:deckA'       deck A order at setup (the game's only hidden info)
 *   'shuffle:deckB'       deck B order at setup
 *   'dice:roll:K'         two d6 per movement/detention roll, K = global roll #
 *   'dice:utility:K'      two d6 when a Works Inspection card demands a fresh roll
 */

import type { GameEvent, PlayerId, RuleError, SeedStream } from '../../kernel/types.ts';
import { playerId, seatIndex } from '../../kernel/types.ts';
import {
  ALL_PROPS,
  AUCTION_MAX_ROUNDS,
  BID_STEP,
  BOARD,
  CARD_BY_ID,
  DECK_A,
  DECK_B,
  DETENTION_FINE,
  GROUP_BY_ID,
  HOTEL_SUPPLY,
  HOUSE_SUPPLY,
  MAX_NOTE_CHARS,
  MAX_OFFERS_PER_TURN,
  SALARY,
  STREET_BY_ID,
  TRANSIT_BY_ID,
  TRANSIT_RENT,
  UTILITY_BY_ID,
  UTILITY_MULT,
  mortgageValue,
  propName,
  propPrice,
  transferFee,
  unmortgageCost,
  type CardDef,
  type Space,
} from './board.ts';

// ---------------------------------------------------------------------------
// State and move shapes (plain JSON; type aliases so they satisfy Json)
// ---------------------------------------------------------------------------

export type Bundle = { cash: number; props: string[]; writs: number };

export type PropState = { owner: string | null; houses: number; mortgaged: boolean };

export type AuctionState = {
  prop: string;
  order: string[];
  idx: number;
  round: number;
  high: number;
  highBidder: string | null;
  bidsInRound: number;
};

export type OfferState = {
  id: number;
  from: string;
  to: string;
  give: Bundle;
  get: Bundle;
  note: string | null;
  countered: boolean;
};

export type PaymentState = { from: string; to: string; amount: number; reason: string };

export type Phase = 'roll' | 'buy_or_auction' | 'auction' | 'manage' | 'debt';

export type LandlordState = {
  players: string[];
  cash: { [p: string]: number };
  pos: { [p: string]: number };
  detained: { [p: string]: boolean };
  detTries: { [p: string]: number };
  writs: { [p: string]: string[] };
  bankrupt: { [p: string]: boolean };
  props: { [id: string]: PropState };
  housePool: number;
  hotelPool: number;
  /** Hidden from every player and spectator until game end. Front = next card. */
  deckA: string[];
  deckB: string[];
  phase: Phase;
  current: string;
  round: number;
  rollCount: number;
  doubles: number;
  rolledDouble: boolean;
  lastDice: number[] | null;
  pendingProp: string | null;
  auction: AuctionState | null;
  offer: OfferState | null;
  offersMade: number;
  nextOfferId: number;
  payments: PaymentState[];
  bankQueue: string[];
  afterPipeline: 'manage' | 'end_turn' | 'move';
  pendingMove: number | null;
  turnLimit: number;
  recent: string[];
};

export type LandlordMove =
  | { t: 'roll' }
  | { t: 'buy' }
  | { t: 'decline' }
  | { t: 'end_turn' }
  | { t: 'pay_detention' }
  | { t: 'use_card' }
  | { t: 'pay_debt' }
  | { t: 'declare_bankruptcy' }
  | { t: 'auction_bid'; amount: number }
  | { t: 'build'; prop: string; n: number }
  | { t: 'sell_buildings'; prop: string; n: number }
  | { t: 'mortgage'; prop: string }
  | { t: 'unmortgage'; prop: string }
  | { t: 'offer'; to: string; give: Bundle; get: Bundle; note: string | null }
  | { t: 'accept'; id: number }
  | { t: 'reject'; id: number }
  | { t: 'counter'; id: number; give: Bundle; get: Bundle; note: string | null };

export function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(v as object)) out[k] = deepClone((v as { [k: string]: unknown })[k]);
  return out as T;
}

export function cashOf(st: LandlordState, p: string): number {
  return st.cash[p] ?? 0;
}
export function posOf(st: LandlordState, p: string): number {
  return st.pos[p] ?? 0;
}
export function prop(st: LandlordState, id: string): PropState {
  const ps = st.props[id];
  if (!ps) throw new Error(`unknown property ${id}`);
  return ps;
}
export function writsOf(st: LandlordState, p: string): string[] {
  return st.writs[p] ?? [];
}
export function isAlive(st: LandlordState, p: string): boolean {
  return st.players.includes(p) && !(st.bankrupt[p] ?? false);
}
export function alivePlayers(st: LandlordState): string[] {
  return st.players.filter((p) => !(st.bankrupt[p] ?? false));
}

function nextAlive(st: LandlordState, from: string): string {
  const n = st.players.length;
  const cur = seatIndex(from);
  for (let k = 1; k <= n; k++) {
    const cand = playerId((cur + k) % n);
    if (isAlive(st, cand)) return cand;
  }
  return from;
}

/** Alive players in seat-cyclic order starting at `from` (or the next alive). */
function cyclicAlive(st: LandlordState, from: string): string[] {
  const n = st.players.length;
  const start = seatIndex(from);
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const cand = playerId((start + k) % n);
    if (isAlive(st, cand)) out.push(cand);
  }
  return out;
}

function note(st: LandlordState, line: string): void {
  st.recent.push(line);
  if (st.recent.length > 6) st.recent.shift();
}

function ev(events: GameEvent[], type: string, data: { [k: string]: unknown }): void {
  events.push({ type, data: data as GameEvent['data'], visibility: 'public' });
}

export function ownsFullGroup(st: LandlordState, player: string, groupId: string): boolean {
  const g = GROUP_BY_ID.get(groupId);
  if (!g) return false;
  return g.streets.every((sid) => prop(st, sid).owner === player);
}

export function ownedCount(st: LandlordState, player: string, ids: readonly { id: string }[]): number {
  return ids.filter((d) => prop(st, d.id).owner === player).length;
}

function buildingsValueHalf(st: LandlordState, p: string): number {
  let sum = 0;
  for (const s of STREET_BY_ID.values()) {
    const ps = prop(st, s.id);
    if (ps.owner === p && ps.houses > 0) sum += ps.houses * (s.houseCost / 2);
  }
  return sum;
}

/**
 * Cash the player could raise by selling every building and mortgaging
 * everything. A street only counts as mortgageable if every building in its
 * group belongs to the player (those get sold during liquidation); buildings
 * owned by someone else block the mortgage, so counting the street here would
 * overstate the ceiling and could strand the player in the debt phase with no
 * legal move.
 */
export function liquidationCeiling(st: LandlordState, p: string): number {
  let sum = cashOf(st, p) + buildingsValueHalf(st, p);
  for (const id of ALL_PROPS) {
    const ps = prop(st, id);
    if (ps.owner !== p || ps.mortgaged) continue;
    const street = STREET_BY_ID.get(id);
    if (street) {
      const g = GROUP_BY_ID.get(street.group)!;
      if (g.streets.some((x) => prop(st, x).houses > 0 && prop(st, x).owner !== p)) continue;
    }
    sum += mortgageValue(id);
  }
  return sum;
}

/** Net worth: cash + list price (mortgaged at mortgage value) + building costs. */
export function netWorth(st: LandlordState, p: string): number {
  if (st.bankrupt[p] ?? false) return 0;
  let sum = cashOf(st, p);
  for (const id of ALL_PROPS) {
    const ps = prop(st, id);
    if (ps.owner !== p) continue;
    sum += ps.mortgaged ? mortgageValue(id) : propPrice(id);
    const street = STREET_BY_ID.get(id);
    if (street && ps.houses > 0) sum += ps.houses * street.houseCost;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function makeInitialState(
  seed: SeedStream,
  players: PlayerId[],
  variant: { [k: string]: string | number | boolean },
): LandlordState {
  if (players.length < 2 || players.length > 4) {
    throw new Error(`landlord supports 2-4 players, got ${players.length}`);
  }
  const startCash = Number(variant['starting_cash'] ?? 1500);
  const turnLimit = Number(variant['turn_limit'] ?? 150);
  const st: LandlordState = {
    players: players.slice(),
    cash: {},
    pos: {},
    detained: {},
    detTries: {},
    writs: {},
    bankrupt: {},
    props: {},
    housePool: HOUSE_SUPPLY,
    hotelPool: HOTEL_SUPPLY,
    deckA: seed.shuffle('shuffle:deckA', DECK_A.map((c) => c.id)),
    deckB: seed.shuffle('shuffle:deckB', DECK_B.map((c) => c.id)),
    phase: 'roll',
    current: '',
    round: 1,
    rollCount: 0,
    doubles: 0,
    rolledDouble: false,
    lastDice: null,
    pendingProp: null,
    auction: null,
    offer: null,
    offersMade: 0,
    nextOfferId: 1,
    payments: [],
    bankQueue: [],
    afterPipeline: 'manage',
    pendingMove: null,
    turnLimit,
    recent: [],
  };
  for (const p of players) {
    st.cash[p] = startCash;
    st.pos[p] = 0;
    st.detained[p] = false;
    st.detTries[p] = 0;
    st.writs[p] = [];
    st.bankrupt[p] = false;
  }
  for (const id of ALL_PROPS) st.props[id] = { owner: null, houses: 0, mortgaged: false };
  st.current = players[seed.int('first_player', players.length)]!;
  note(st, `${st.current} plays first`);
  return st;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export function terminalResult(st: LandlordState): { winners: string[]; draw: boolean; scores: { [p: string]: number }; reason: string } | null {
  const alive = alivePlayers(st);
  const scores: { [p: string]: number } = {};
  for (const p of st.players) scores[p] = netWorth(st, p);
  if (alive.length <= 1) {
    return { winners: alive, draw: false, scores, reason: 'last_standing' };
  }
  if (st.round > st.turnLimit) {
    let best = -1;
    for (const p of alive) best = Math.max(best, scores[p] ?? 0);
    const winners = alive.filter((p) => (scores[p] ?? 0) === best);
    return { winners, draw: false, scores, reason: 'turn_limit' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whose move
// ---------------------------------------------------------------------------

export function toMove(st: LandlordState): string[] {
  if (terminalResult(st)) return [];
  switch (st.phase) {
    case 'roll':
    case 'buy_or_auction':
      return [st.current];
    case 'auction': {
      const a = st.auction;
      if (!a) return [];
      return [a.order[a.idx]!];
    }
    case 'manage':
      return st.offer ? [st.offer.to] : [st.current];
    case 'debt': {
      const pay = st.payments[0];
      return pay ? [pay.from] : [];
    }
  }
}

// ---------------------------------------------------------------------------
// Legal move enumeration
// ---------------------------------------------------------------------------

function canBuildOne(st: LandlordState, player: string, sid: string): boolean {
  const street = STREET_BY_ID.get(sid);
  if (!street) return false;
  const ps = prop(st, sid);
  if (ps.owner !== player || ps.houses >= 5) return false;
  const g = GROUP_BY_ID.get(street.group)!;
  if (!g.streets.every((x) => prop(st, x).owner === player)) return false;
  if (g.streets.some((x) => prop(st, x).mortgaged)) return false;
  const min = Math.min(...g.streets.map((x) => prop(st, x).houses));
  if (ps.houses !== min) return false; // even-build
  if (ps.houses === 4) {
    if (st.hotelPool < 1) return false;
  } else if (st.housePool < 1) return false;
  return cashOf(st, player) >= street.houseCost;
}

/** n=1 sells one house (or breaks a hotel down to 4 houses when supply allows). */
function canSellOne(st: LandlordState, player: string, sid: string): boolean {
  const street = STREET_BY_ID.get(sid);
  if (!street) return false;
  const ps = prop(st, sid);
  if (ps.owner !== player || ps.houses < 1) return false;
  const g = GROUP_BY_ID.get(street.group)!;
  const max = Math.max(...g.streets.map((x) => prop(st, x).houses));
  if (ps.houses !== max) return false; // even-sell
  if (ps.houses === 5 && st.housePool < 4) return false; // must use whole-hotel sale instead
  return true;
}

/** Shortage exception: sell an entire hotel at once when < 4 houses remain in supply. */
function canSellWholeHotel(st: LandlordState, player: string, sid: string): boolean {
  const street = STREET_BY_ID.get(sid);
  if (!street) return false;
  const ps = prop(st, sid);
  return ps.owner === player && ps.houses === 5 && st.housePool < 4;
}

function canMortgage(st: LandlordState, player: string, id: string): boolean {
  const ps = prop(st, id);
  if (ps.owner !== player || ps.mortgaged) return false;
  const street = STREET_BY_ID.get(id);
  if (street) {
    const g = GROUP_BY_ID.get(street.group)!;
    if (g.streets.some((x) => prop(st, x).houses > 0)) return false;
  }
  return true;
}

function canUnmortgage(st: LandlordState, player: string, id: string): boolean {
  const ps = prop(st, id);
  return ps.owner === player && ps.mortgaged && cashOf(st, player) >= unmortgageCost(id);
}

/** Properties `who` may put in a trade bundle: owned, building-free. */
function tradable(st: LandlordState, who: string): string[] {
  return ALL_PROPS.filter((id) => {
    const ps = prop(st, id);
    if (ps.owner !== who || ps.houses > 0) return false;
    const street = STREET_BY_ID.get(id);
    if (street) {
      const g = GROUP_BY_ID.get(street.group)!;
      if (g.streets.some((x) => prop(st, x).houses > 0)) return false;
    }
    return true;
  });
}

function manageMoves(st: LandlordState, player: string): LandlordMove[] {
  const out: LandlordMove[] = [];
  for (const id of ALL_PROPS) if (canBuildOne(st, player, id)) out.push({ t: 'build', prop: id, n: 1 });
  for (const id of ALL_PROPS) {
    if (canSellOne(st, player, id)) out.push({ t: 'sell_buildings', prop: id, n: 1 });
    else if (canSellWholeHotel(st, player, id)) out.push({ t: 'sell_buildings', prop: id, n: 5 });
  }
  for (const id of ALL_PROPS) if (canMortgage(st, player, id)) out.push({ t: 'mortgage', prop: id });
  for (const id of ALL_PROPS) if (canUnmortgage(st, player, id)) out.push({ t: 'unmortgage', prop: id });
  // Canonical representative offers (the offer grammar accepted by parseMove /
  // apply is far larger; see notes/T5b-landlord.md). Aimed at the next player.
  if (st.offersMade < MAX_OFFERS_PER_TURN && alivePlayers(st).length >= 2) {
    const target = nextAlive(st, player);
    if (target !== player) {
      for (const id of tradable(st, player)) {
        if (prop(st, id).mortgaged) continue;
        out.push({
          t: 'offer',
          to: target,
          give: { cash: 0, props: [id], writs: 0 },
          get: { cash: propPrice(id), props: [], writs: 0 },
          note: null,
        });
      }
      for (const id of tradable(st, target)) {
        if (prop(st, id).mortgaged) continue;
        if (cashOf(st, player) < propPrice(id)) continue;
        out.push({
          t: 'offer',
          to: target,
          give: { cash: propPrice(id), props: [], writs: 0 },
          get: { cash: 0, props: [id], writs: 0 },
          note: null,
        });
      }
    }
  }
  out.push({ t: 'end_turn' });
  return out;
}

function offerResponseMoves(st: LandlordState, player: string): LandlordMove[] {
  const o = st.offer;
  if (!o || o.to !== player) return [];
  const out: LandlordMove[] = [];
  if (validateAccept(st, o) === null) out.push({ t: 'accept', id: o.id });
  out.push({ t: 'reject', id: o.id });
  if (!o.countered) {
    // One canonical counter: mirror the offer, demanding 100 more cash.
    const give: Bundle = { cash: o.get.cash, props: o.get.props.slice(), writs: o.get.writs };
    const get: Bundle = { cash: o.give.cash + 100, props: o.give.props.slice(), writs: o.give.writs };
    const trial: OfferState = { id: -1, from: player, to: o.from, give, get, note: null, countered: true };
    if (validateAccept(st, trial) === null) out.push({ t: 'counter', id: o.id, give, get, note: null });
  }
  return out;
}

export function legalMovesFor(st: LandlordState, player: string): LandlordMove[] {
  const movers = toMove(st);
  if (!movers.includes(player)) return [];
  switch (st.phase) {
    case 'roll': {
      const out: LandlordMove[] = [{ t: 'roll' }];
      if (st.detained[player] ?? false) {
        if (cashOf(st, player) >= DETENTION_FINE) out.push({ t: 'pay_detention' });
        if (writsOf(st, player).length > 0) out.push({ t: 'use_card' });
      }
      return out;
    }
    case 'buy_or_auction': {
      const out: LandlordMove[] = [];
      const id = st.pendingProp;
      if (id && cashOf(st, player) >= propPrice(id)) out.push({ t: 'buy' });
      out.push({ t: 'decline' });
      return out;
    }
    case 'auction': {
      const a = st.auction!;
      const out: LandlordMove[] = [];
      const cash = cashOf(st, player);
      for (let amt = a.high + BID_STEP; amt <= cash; amt += BID_STEP) out.push({ t: 'auction_bid', amount: amt });
      out.push({ t: 'decline' });
      return out;
    }
    case 'manage':
      return st.offer ? offerResponseMoves(st, player) : manageMoves(st, player);
    case 'debt': {
      const pay = st.payments[0];
      if (!pay) return [];
      const out: LandlordMove[] = [];
      for (const id of ALL_PROPS) {
        if (canSellOne(st, player, id)) out.push({ t: 'sell_buildings', prop: id, n: 1 });
        else if (canSellWholeHotel(st, player, id)) out.push({ t: 'sell_buildings', prop: id, n: 5 });
      }
      for (const id of ALL_PROPS) if (canMortgage(st, player, id)) out.push({ t: 'mortgage', prop: id });
      if (cashOf(st, player) >= pay.amount) out.push({ t: 'pay_debt' });
      else if (liquidationCeiling(st, player) < pay.amount) out.push({ t: 'declare_bankruptcy' });
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Movement, landing, cards, payments
// ---------------------------------------------------------------------------

function paySalary(st: LandlordState, p: string, events: GameEvent[]): void {
  st.cash[p] = cashOf(st, p) + SALARY;
  ev(events, 'salary', { player: p, amount: SALARY });
  note(st, `${p} collects ${SALARY} salary at Launch Pier`);
}

/** Forward move to an absolute space; salary when crossing (or landing on) start. */
function moveForwardTo(st: LandlordState, p: string, target: number, events: GameEvent[]): void {
  const from = posOf(st, p);
  st.pos[p] = target;
  if (target <= from) paySalary(st, p, events); // wrapped past (or onto) start
  else if (target === 0) paySalary(st, p, events);
}

function sendToDetention(st: LandlordState, p: string, events: GameEvent[]): void {
  st.pos[p] = 10;
  st.detained[p] = true;
  st.detTries[p] = 0;
  if (p === st.current) st.rolledDouble = false;
  ev(events, 'detention', { player: p });
  note(st, `${p} is sent to the Detention Yard`);
}

function queuePayment(st: LandlordState, from: string, to: string, amount: number, reason: string): void {
  if (amount > 0) st.payments.push({ from, to, amount, reason });
}

function drawCard(st: LandlordState, deck: 'A' | 'B'): CardDef {
  const arr = deck === 'A' ? st.deckA : st.deckB;
  const id = arr.shift();
  if (!id) throw new Error(`deck ${deck} is empty`);
  const card = CARD_BY_ID.get(id)!;
  if (card.effect.k !== 'writ') arr.push(id); // writs leave the deck until used
  return card;
}

function countBuildings(st: LandlordState, p: string): { houses: number; hotels: number } {
  let houses = 0;
  let hotels = 0;
  for (const id of ALL_PROPS) {
    const ps = prop(st, id);
    if (ps.owner !== p) continue;
    if (ps.houses === 5) hotels++;
    else houses += ps.houses;
  }
  return { houses, hotels };
}

function resolveCard(
  st: LandlordState,
  p: string,
  deck: 'A' | 'B',
  seed: SeedStream,
  events: GameEvent[],
): void {
  const card = drawCard(st, deck);
  ev(events, 'card', { player: p, deck, card: card.id, title: card.title, text: card.text });
  note(st, `${p} draws "${card.title}"`);
  const fx = card.effect;
  switch (fx.k) {
    case 'collect':
      st.cash[p] = cashOf(st, p) + fx.amount;
      return finishLanding(st, events, seed);
    case 'pay':
      queuePayment(st, p, 'bank', fx.amount, `card:${card.id}`);
      return processPipeline(st, events, seed);
    case 'pay_each': {
      for (const q of st.players) {
        if (q !== p && isAlive(st, q)) queuePayment(st, p, q, fx.amount, `card:${card.id}`);
      }
      return processPipeline(st, events, seed);
    }
    case 'collect_each': {
      for (const q of st.players) {
        if (q !== p && isAlive(st, q)) queuePayment(st, q, p, fx.amount, `card:${card.id}`);
      }
      return processPipeline(st, events, seed);
    }
    case 'repairs': {
      const b = countBuildings(st, p);
      const cost = b.houses * fx.perHouse + b.hotels * fx.perHotel;
      queuePayment(st, p, 'bank', cost, `card:${card.id}`);
      return processPipeline(st, events, seed);
    }
    case 'writ':
      st.writs[p] = [...writsOf(st, p), card.id];
      ev(events, 'writ_kept', { player: p, card: card.id });
      return finishLanding(st, events, seed);
    case 'go_detention':
      sendToDetention(st, p, events);
      return finishLanding(st, events, seed);
    case 'advance_to':
      moveForwardTo(st, p, fx.idx, events);
      return resolveLanding(st, p, { diceTotal: sumDice(st) }, seed, events);
    case 'back': {
      const target = (posOf(st, p) - fx.n + 40) % 40;
      st.pos[p] = target; // moving back never collects salary
      return resolveLanding(st, p, { diceTotal: sumDice(st) }, seed, events);
    }
    case 'advance_nearest': {
      const from = posOf(st, p);
      const idxs = fx.which === 'transit' ? TRANSIT_BY_ID : UTILITY_BY_ID;
      let bestDist = 41;
      let bestIdx = -1;
      for (const d of idxs.values()) {
        const dist = (d.idx - from + 40) % 40;
        if (dist > 0 && dist < bestDist) {
          bestDist = dist;
          bestIdx = d.idx;
        }
      }
      moveForwardTo(st, p, bestIdx, events);
      return resolveLanding(
        st,
        p,
        fx.which === 'transit' ? { diceTotal: sumDice(st), transitMult: 2 } : { diceTotal: sumDice(st), utilityOverride: true },
        seed,
        events,
      );
    }
  }
}

function sumDice(st: LandlordState): number {
  const d = st.lastDice;
  return d ? (d[0] ?? 0) + (d[1] ?? 0) : 7;
}

type LandingOpts = { diceTotal: number; transitMult?: number; utilityOverride?: boolean };

function streetRent(st: LandlordState, sid: string): number {
  const street = STREET_BY_ID.get(sid)!;
  const ps = prop(st, sid);
  const owner = ps.owner!;
  if (ps.houses > 0) return street.rent[ps.houses as 1 | 2 | 3 | 4 | 5];
  const base = street.rent[0];
  return ownsFullGroup(st, owner, street.group) ? base * 2 : base;
}

function resolveLanding(st: LandlordState, p: string, opts: LandingOpts, seed: SeedStream, events: GameEvent[]): void {
  const sp: Space = BOARD[posOf(st, p)]!;
  switch (sp.kind) {
    case 'start':
    case 'detention':
    case 'free_rest':
      return finishLanding(st, events, seed);
    case 'go_to_detention':
      sendToDetention(st, p, events);
      return finishLanding(st, events, seed);
    case 'tax':
      ev(events, 'tax', { player: p, space: sp.name, amount: sp.tax! });
      note(st, `${p} owes ${sp.tax} ${sp.name}`);
      queuePayment(st, p, 'bank', sp.tax!, `tax:${sp.idx}`);
      return processPipeline(st, events, seed);
    case 'event_a':
      return resolveCard(st, p, 'A', seed, events);
    case 'event_b':
      return resolveCard(st, p, 'B', seed, events);
    case 'street':
    case 'transit':
    case 'utility': {
      const id = sp.prop!;
      const ps = prop(st, id);
      if (ps.owner === null) {
        st.pendingProp = id;
        st.phase = 'buy_or_auction';
        note(st, `${p} may buy ${sp.name} for ${sp.price}`);
        return;
      }
      if (ps.owner === p || ps.mortgaged) return finishLanding(st, events, seed);
      let rent = 0;
      if (sp.kind === 'street') {
        rent = streetRent(st, id);
      } else if (sp.kind === 'transit') {
        const count = ownedCount(st, ps.owner, [...TRANSIT_BY_ID.values()].map((t) => ({ id: t.id })));
        rent = (TRANSIT_RENT[count] ?? 0) * (opts.transitMult ?? 1);
      } else {
        if (opts.utilityOverride) {
          const k = st.rollCount;
          const d1 = seed.die(`dice:utility:${k}`, 6);
          const d2 = seed.die(`dice:utility:${k}`, 6);
          ev(events, 'roll', { player: p, dice: [d1, d2], purpose: 'utility' });
          rent = (d1 + d2) * 10;
        } else {
          const count = ownedCount(st, ps.owner, [...UTILITY_BY_ID.values()].map((u) => ({ id: u.id })));
          rent = opts.diceTotal * (UTILITY_MULT[count] ?? 0);
        }
      }
      ev(events, 'rent', { player: p, owner: ps.owner, prop: id, amount: rent });
      note(st, `${p} owes ${ps.owner} ${rent} rent on ${sp.name}`);
      queuePayment(st, p, ps.owner, rent, `rent:${id}`);
      return processPipeline(st, events, seed);
    }
  }
}

function finishLanding(st: LandlordState, events: GameEvent[], seed: SeedStream): void {
  return processPipeline(st, events, seed);
}

// ---------------------------------------------------------------------------
// The payment / auction pipeline
// ---------------------------------------------------------------------------

function processPipeline(st: LandlordState, events: GameEvent[], seed: SeedStream): void {
  for (;;) {
    const pay = st.payments[0];
    if (pay) {
      if (st.bankrupt[pay.from] ?? false) {
        st.payments.shift();
        continue;
      }
      if (cashOf(st, pay.from) >= pay.amount) {
        st.cash[pay.from] = cashOf(st, pay.from) - pay.amount;
        if (pay.to !== 'bank') st.cash[pay.to] = cashOf(st, pay.to) + pay.amount;
        ev(events, 'payment', { from: pay.from, to: pay.to, amount: pay.amount, reason: pay.reason });
        st.payments.shift();
        continue;
      }
      st.phase = 'debt';
      note(st, `${pay.from} must raise ${pay.amount} for ${pay.to === 'bank' ? 'the bank' : pay.to}`);
      return;
    }
    if (st.bankQueue.length > 0) {
      if (alivePlayers(st).length < 2) {
        st.bankQueue = [];
        continue;
      }
      const id = st.bankQueue.shift()!;
      startAuction(st, id, events);
      return;
    }
    switch (st.afterPipeline) {
      case 'manage':
        st.phase = 'manage';
        return;
      case 'move': {
        const p = st.current;
        st.detained[p] = false;
        st.detTries[p] = 0;
        const total = st.pendingMove ?? 0;
        st.pendingMove = null;
        st.afterPipeline = 'manage';
        moveForwardTo(st, p, (posOf(st, p) + total) % 40, events);
        return resolveLanding(st, p, { diceTotal: total }, seed, events);
      }
      case 'end_turn':
        st.afterPipeline = 'manage';
        advanceTurn(st);
        return;
    }
  }
}

function startAuction(st: LandlordState, id: string, events: GameEvent[]): void {
  const order = cyclicAlive(st, isAlive(st, st.current) ? st.current : nextAlive(st, st.current));
  st.auction = { prop: id, order, idx: 0, round: 1, high: 0, highBidder: null, bidsInRound: 0 };
  st.phase = 'auction';
  ev(events, 'auction_start', { prop: id, order });
  note(st, `auction opens for ${propName(id)}`);
}

function settleAuction(st: LandlordState, events: GameEvent[], seed: SeedStream): void {
  const a = st.auction!;
  if (a.highBidder) {
    st.cash[a.highBidder] = cashOf(st, a.highBidder) - a.high;
    prop(st, a.prop).owner = a.highBidder;
    ev(events, 'auction_won', { prop: a.prop, winner: a.highBidder, amount: a.high });
    note(st, `${a.highBidder} wins ${propName(a.prop)} at auction for ${a.high}`);
  } else {
    ev(events, 'auction_unsold', { prop: a.prop });
    note(st, `${propName(a.prop)} goes unsold`);
  }
  st.auction = null;
  st.pendingProp = null;
  processPipeline(st, events, seed);
}

// ---------------------------------------------------------------------------
// Bankruptcy
// ---------------------------------------------------------------------------

function doBankruptcy(st: LandlordState, debtor: string, creditor: string, events: GameEvent[]): void {
  // Liquidate all buildings at half cost (proceeds join the debtor's cash).
  for (const s of STREET_BY_ID.values()) {
    const ps = prop(st, s.id);
    if (ps.owner !== debtor || ps.houses === 0) continue;
    const refund = ps.houses * (s.houseCost / 2);
    if (ps.houses === 5) st.hotelPool++;
    else st.housePool += ps.houses;
    ps.houses = 0;
    st.cash[debtor] = cashOf(st, debtor) + refund;
  }
  const held = writsOf(st, debtor);
  st.writs[debtor] = [];
  if (creditor === 'bank') {
    for (const w of held) (w.startsWith('evA') ? st.deckA : st.deckB).push(w);
    for (const id of ALL_PROPS) {
      const ps = prop(st, id);
      if (ps.owner === debtor) {
        ps.owner = null;
        ps.mortgaged = false;
        st.bankQueue.push(id);
      }
    }
  } else {
    st.writs[creditor] = [...writsOf(st, creditor), ...held];
    st.cash[creditor] = cashOf(st, creditor) + cashOf(st, debtor);
    for (const id of ALL_PROPS) {
      const ps = prop(st, id);
      if (ps.owner !== debtor) continue;
      ps.owner = creditor;
      if (ps.mortgaged) {
        // Immediate 10% interest on receiving a mortgaged property (bank fee).
        const fee = Math.min(transferFee(id), cashOf(st, creditor));
        st.cash[creditor] = cashOf(st, creditor) - fee;
      }
    }
  }
  st.cash[debtor] = 0;
  st.bankrupt[debtor] = true;
  st.payments = st.payments.filter((p) => p.from !== debtor && p.to !== debtor);
  if (st.offer && (st.offer.from === debtor || st.offer.to === debtor)) st.offer = null;
  if (debtor === st.current) {
    st.afterPipeline = 'end_turn';
    st.rolledDouble = false;
  }
  ev(events, 'bankruptcy', { player: debtor, creditor });
  note(st, `${debtor} is bankrupt (creditor: ${creditor === 'bank' ? 'the bank' : creditor})`);
}

function advanceTurn(st: LandlordState): void {
  const n = st.players.length;
  const cur = seatIndex(st.current);
  for (let k = 1; k <= n; k++) {
    const cand = playerId((cur + k) % n);
    if (isAlive(st, cand)) {
      if (cur + k >= n) st.round++;
      st.current = cand;
      break;
    }
  }
  st.phase = 'roll';
  st.doubles = 0;
  st.rolledDouble = false;
  st.offersMade = 0;
  st.lastDice = null;
  st.pendingProp = null;
  st.pendingMove = null;
  st.afterPipeline = 'manage';
}

// ---------------------------------------------------------------------------
// Offer validation and execution
// ---------------------------------------------------------------------------

function validBundleShape(b: Bundle): string | null {
  // Hostile move bodies can reach apply() with anything here — a missing /
  // null / non-object bundle must become a structured rejection, not a throw.
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    return 'bundle must be an object with cash, props, and writs';
  }
  if (!Number.isInteger(b.cash) || b.cash < 0) return 'bundle cash must be a non-negative integer';
  if (!Number.isInteger(b.writs) || b.writs < 0) return 'bundle writs must be a non-negative integer';
  if (!Array.isArray(b.props)) return 'bundle props must be an array';
  if (new Set(b.props).size !== b.props.length) return 'bundle props must be distinct';
  for (const id of b.props) if (!ALL_PROPS.includes(id)) return `unknown property '${id}'`;
  return null;
}

function validateOfferSides(st: LandlordState, o: OfferState): string | null {
  for (const [who, bundle] of [
    [o.from, o.give],
    [o.to, o.get],
  ] as const) {
    const shape = validBundleShape(bundle);
    if (shape) return shape;
    for (const id of bundle.props) {
      const ps = prop(st, id);
      if (ps.owner !== who) return `${who} does not own ${id}`;
      if (ps.houses > 0) return `${id} carries buildings; sell them before trading`;
      const street = STREET_BY_ID.get(id);
      if (street) {
        const g = GROUP_BY_ID.get(street.group)!;
        if (g.streets.some((x) => prop(st, x).houses > 0)) {
          return `${id} is in a group with buildings; sell them before trading`;
        }
      }
    }
    if (bundle.writs > writsOf(st, who).length) return `${who} holds fewer than ${bundle.writs} release writs`;
  }
  if (o.give.cash === 0 && o.give.props.length === 0 && o.give.writs === 0 && o.get.cash === 0 && o.get.props.length === 0 && o.get.writs === 0) {
    return 'offer is empty';
  }
  // The note is TEXT capped at MAX_NOTE_CHARS: a non-string (number, object,
  // missing field) must not slip past the cap via `.length === undefined`.
  if (o.note !== null && typeof o.note !== 'string') return 'note must be a string or null';
  if (o.note !== null && o.note.length > MAX_NOTE_CHARS) return `note exceeds ${MAX_NOTE_CHARS} characters`;
  return null;
}

/** Null when the pending offer could settle right now without anyone going negative. */
function validateAccept(st: LandlordState, o: OfferState): string | null {
  const sides = validateOfferSides(st, o);
  if (sides) return sides;
  const feeFrom = o.get.props.reduce((s, id) => s + (prop(st, id).mortgaged ? transferFee(id) : 0), 0);
  const feeTo = o.give.props.reduce((s, id) => s + (prop(st, id).mortgaged ? transferFee(id) : 0), 0);
  if (cashOf(st, o.from) - o.give.cash + o.get.cash - feeFrom < 0) return `${o.from} cannot cover the cash side`;
  if (cashOf(st, o.to) - o.get.cash + o.give.cash - feeTo < 0) return `${o.to} cannot cover the cash side`;
  return null;
}

function executeTrade(st: LandlordState, o: OfferState, events: GameEvent[]): void {
  st.cash[o.from] = cashOf(st, o.from) - o.give.cash + o.get.cash;
  st.cash[o.to] = cashOf(st, o.to) - o.get.cash + o.give.cash;
  for (const [newOwner, ids] of [
    [o.to, o.give.props],
    [o.from, o.get.props],
  ] as const) {
    for (const id of ids) {
      const ps = prop(st, id);
      ps.owner = newOwner;
      if (ps.mortgaged) {
        st.cash[newOwner] = cashOf(st, newOwner) - transferFee(id);
      }
    }
  }
  const fromWrits = writsOf(st, o.from).slice();
  const toWrits = writsOf(st, o.to).slice();
  const movedFrom = fromWrits.splice(0, o.give.writs);
  const movedTo = toWrits.splice(0, o.get.writs);
  st.writs[o.from] = [...fromWrits, ...movedTo];
  st.writs[o.to] = [...toWrits, ...movedFrom];
  ev(events, 'trade', { from: o.from, to: o.to, give: o.give as unknown, get: o.get as unknown, offer_id: o.id });
  note(st, `${o.to} accepts trade #${o.id} from ${o.from}`);
}

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

export function applyMove(
  prev: LandlordState,
  player: PlayerId,
  move: LandlordMove,
  seed: SeedStream,
): { state: LandlordState; events: GameEvent[] } | RuleError {
  if (terminalResult(prev)) return err('game_over', 'the game has ended');
  if (!toMove(prev).includes(player)) return err('not_your_turn', `${player} is not to move`);
  if (typeof move !== 'object' || move === null || typeof (move as { t?: unknown }).t !== 'string') {
    return err('bad_move', 'move must be a phase-tagged object');
  }
  const st = deepClone(prev);
  const events: GameEvent[] = [];

  switch (move.t) {
    case 'roll': {
      if (st.phase !== 'roll') return err('wrong_phase', 'roll is only legal in the roll phase');
      const k = ++st.rollCount;
      const d1 = seed.die(`dice:roll:${k}`, 6);
      const d2 = seed.die(`dice:roll:${k}`, 6);
      st.lastDice = [d1, d2];
      ev(events, 'roll', { player, dice: [d1, d2] });
      if (st.detained[player] ?? false) {
        if (d1 === d2) {
          st.detained[player] = false;
          st.detTries[player] = 0;
          st.rolledDouble = false;
          st.doubles = 0;
          note(st, `${player} rolls double ${d1} and walks free`);
          moveForwardTo(st, player, (posOf(st, player) + d1 + d2) % 40, events);
          resolveLanding(st, player, { diceTotal: d1 + d2 }, seed, events);
        } else {
          const tries = (st.detTries[player] ?? 0) + 1;
          st.detTries[player] = tries;
          note(st, `${player} fails to roll doubles (${tries}/3)`);
          if (tries >= 3) {
            queuePayment(st, player, 'bank', DETENTION_FINE, 'detention_fine');
            st.pendingMove = d1 + d2;
            st.afterPipeline = 'move';
            processPipeline(st, events, seed);
          } else {
            st.phase = 'manage';
          }
        }
      } else {
        if (d1 === d2) {
          st.doubles++;
          if (st.doubles >= 3) {
            note(st, `${player} rolls a third double`);
            sendToDetention(st, player, events);
            st.phase = 'manage';
            break;
          }
          st.rolledDouble = true;
        } else {
          st.rolledDouble = false;
        }
        note(st, `${player} rolls ${d1}+${d2}`);
        moveForwardTo(st, player, (posOf(st, player) + d1 + d2) % 40, events);
        resolveLanding(st, player, { diceTotal: d1 + d2 }, seed, events);
      }
      break;
    }

    case 'pay_detention': {
      if (st.phase !== 'roll' || !(st.detained[player] ?? false)) return err('wrong_phase', 'not detained');
      if (cashOf(st, player) < DETENTION_FINE) return err('poor', `need ${DETENTION_FINE} to pay the fine`);
      st.cash[player] = cashOf(st, player) - DETENTION_FINE;
      st.detained[player] = false;
      st.detTries[player] = 0;
      ev(events, 'release', { player, how: 'fine' });
      note(st, `${player} pays the ${DETENTION_FINE} fine and is released`);
      break; // stays in roll phase; rolls normally now
    }

    case 'use_card': {
      if (st.phase !== 'roll' || !(st.detained[player] ?? false)) return err('wrong_phase', 'not detained');
      const held = writsOf(st, player);
      const w = held[0];
      if (!w) return err('no_writ', 'no release writ held');
      st.writs[player] = held.slice(1);
      (w.startsWith('evA') ? st.deckA : st.deckB).push(w); // writ returns to the bottom of its deck
      st.detained[player] = false;
      st.detTries[player] = 0;
      ev(events, 'release', { player, how: 'writ', card: w });
      note(st, `${player} plays a Release Writ and is released`);
      break;
    }

    case 'buy': {
      if (st.phase !== 'buy_or_auction') return err('wrong_phase', 'nothing to buy');
      const id = st.pendingProp!;
      const price = propPrice(id);
      if (cashOf(st, player) < price) return err('poor', `need ${price} to buy ${propName(id)}`);
      st.cash[player] = cashOf(st, player) - price;
      prop(st, id).owner = player;
      st.pendingProp = null;
      ev(events, 'purchase', { player, prop: id, price });
      note(st, `${player} buys ${propName(id)} for ${price}`);
      st.afterPipeline = 'manage';
      processPipeline(st, events, seed);
      break;
    }

    case 'decline': {
      if (st.phase === 'buy_or_auction') {
        const id = st.pendingProp!;
        note(st, `${player} declines ${propName(id)}`);
        startAuction(st, id, events);
        break;
      }
      if (st.phase === 'auction') {
        const a = st.auction!;
        if (a.order[a.idx] !== player) return err('not_your_turn', 'not your bid');
        ev(events, 'bid_pass', { player, prop: a.prop });
        a.idx++;
        if (a.idx >= a.order.length) {
          if (a.bidsInRound === 0 || a.round >= AUCTION_MAX_ROUNDS) {
            settleAuction(st, events, seed);
          } else {
            a.round++;
            a.idx = 0;
            a.bidsInRound = 0;
          }
        }
        break;
      }
      return err('wrong_phase', 'nothing to decline');
    }

    case 'auction_bid': {
      if (st.phase !== 'auction') return err('wrong_phase', 'no auction running');
      const a = st.auction!;
      if (a.order[a.idx] !== player) return err('not_your_turn', 'not your bid');
      const amt = move.amount;
      if (!Number.isInteger(amt) || amt % BID_STEP !== 0) return err('bad_bid', `bids are multiples of ${BID_STEP}`);
      if (amt <= a.high) return err('bad_bid', `bid must beat ${a.high} (ties go to the earlier bidder)`);
      if (amt > cashOf(st, player)) return err('poor', 'bid exceeds your cash');
      a.high = amt;
      a.highBidder = player;
      a.bidsInRound++;
      ev(events, 'bid', { player, prop: a.prop, amount: amt });
      note(st, `${player} bids ${amt} for ${propName(a.prop)}`);
      a.idx++;
      if (a.idx >= a.order.length) {
        if (a.round >= AUCTION_MAX_ROUNDS) settleAuction(st, events, seed);
        else {
          a.round++;
          a.idx = 0;
          a.bidsInRound = 0;
        }
      }
      break;
    }

    case 'build': {
      if (st.phase !== 'manage' || st.offer) return err('wrong_phase', 'building happens in your manage phase');
      if (!Number.isInteger(move.n) || move.n < 1) return err('bad_move', 'n must be a positive integer');
      const street = STREET_BY_ID.get(move.prop);
      if (!street) return err('bad_prop', `'${move.prop}' is not a street`);
      for (let i = 0; i < move.n; i++) {
        if (!canBuildOne(st, player, move.prop)) return err('cannot_build', `cannot build house ${i + 1} on ${street.name} (even-build, supply, mortgage, or cash)`);
        const ps = prop(st, move.prop);
        if (ps.houses === 4) {
          st.hotelPool--;
          st.housePool += 4;
        } else {
          st.housePool--;
        }
        ps.houses++;
        st.cash[player] = cashOf(st, player) - street.houseCost;
      }
      ev(events, 'build', { player, prop: move.prop, n: move.n, houses: prop(st, move.prop).houses });
      note(st, `${player} builds on ${street.name} (now ${prop(st, move.prop).houses === 5 ? 'a hotel' : `${prop(st, move.prop).houses} houses`})`);
      break;
    }

    case 'sell_buildings': {
      if (st.phase !== 'manage' && st.phase !== 'debt') return err('wrong_phase', 'selling happens in manage or debt phases');
      if (st.phase === 'manage' && st.offer) return err('wrong_phase', 'respond to the pending offer first');
      const street = STREET_BY_ID.get(move.prop);
      if (!street) return err('bad_prop', `'${move.prop}' is not a street`);
      if (!Number.isInteger(move.n) || move.n < 1) return err('bad_move', 'n must be a positive integer');
      const ps = prop(st, move.prop);
      if (ps.houses === 5 && st.housePool < 4) {
        // Whole-hotel sale under house shortage.
        if (move.n !== 5) return err('cannot_sell', 'house shortage: the hotel must be sold whole (n=5)');
        ps.houses = 0;
        st.hotelPool++;
        st.cash[player] = cashOf(st, player) + 5 * (street.houseCost / 2);
      } else {
        for (let i = 0; i < move.n; i++) {
          if (!canSellOne(st, player, move.prop)) return err('cannot_sell', `cannot sell building ${i + 1} on ${street.name} (even-sell or nothing to sell)`);
          if (ps.houses === 5) {
            st.hotelPool++;
            st.housePool -= 4;
          } else {
            st.housePool++;
          }
          ps.houses--;
          st.cash[player] = cashOf(st, player) + street.houseCost / 2;
        }
      }
      ev(events, 'sell', { player, prop: move.prop, n: move.n, houses: ps.houses });
      note(st, `${player} sells buildings on ${street.name}`);
      break;
    }

    case 'mortgage': {
      if (st.phase !== 'manage' && st.phase !== 'debt') return err('wrong_phase', 'mortgaging happens in manage or debt phases');
      if (st.phase === 'manage' && st.offer) return err('wrong_phase', 'respond to the pending offer first');
      if (!canMortgage(st, player, move.prop)) return err('cannot_mortgage', `cannot mortgage ${propName(move.prop)}`);
      prop(st, move.prop).mortgaged = true;
      const v = mortgageValue(move.prop);
      st.cash[player] = cashOf(st, player) + v;
      ev(events, 'mortgage', { player, prop: move.prop, value: v });
      note(st, `${player} mortgages ${propName(move.prop)} for ${v}`);
      break;
    }

    case 'unmortgage': {
      if (st.phase !== 'manage' || st.offer) return err('wrong_phase', 'unmortgaging happens in your manage phase');
      if (!canUnmortgage(st, player, move.prop)) return err('cannot_unmortgage', `cannot unmortgage ${propName(move.prop)}`);
      const cost = unmortgageCost(move.prop);
      prop(st, move.prop).mortgaged = false;
      st.cash[player] = cashOf(st, player) - cost;
      ev(events, 'unmortgage', { player, prop: move.prop, cost });
      note(st, `${player} lifts the mortgage on ${propName(move.prop)} for ${cost}`);
      break;
    }

    case 'offer': {
      if (st.phase !== 'manage' || st.offer) return err('wrong_phase', 'offers are made in your manage phase with no offer pending');
      if (player !== st.current) return err('not_your_turn', 'only the player on turn initiates offers');
      if (st.offersMade >= MAX_OFFERS_PER_TURN) return err('offer_cap', `at most ${MAX_OFFERS_PER_TURN} offers per turn`);
      if (move.to === player || !isAlive(st, move.to)) return err('bad_target', 'offer must name another solvent player');
      const o: OfferState = {
        id: st.nextOfferId,
        from: player,
        to: move.to,
        give: deepClone(move.give),
        get: deepClone(move.get),
        note: move.note,
        countered: false,
      };
      const bad = validateOfferSides(st, o);
      if (bad) return err('bad_offer', bad);
      st.nextOfferId++;
      st.offersMade++;
      st.offer = o;
      ev(events, 'offer', { offer_id: o.id, from: o.from, to: o.to, give: o.give as unknown, get: o.get as unknown, note: o.note });
      note(st, `${player} offers trade #${o.id} to ${move.to}`);
      break;
    }

    case 'accept': {
      const o = st.offer;
      if (st.phase !== 'manage' || !o) return err('wrong_phase', 'no pending offer');
      if (o.to !== player) return err('not_your_turn', 'this offer is not addressed to you');
      if (o.id !== move.id) return err('bad_offer_id', `pending offer is #${o.id}`);
      const bad = validateAccept(st, o);
      if (bad) return err('cannot_accept', bad);
      executeTrade(st, o, events);
      st.offer = null;
      break;
    }

    case 'reject': {
      const o = st.offer;
      if (st.phase !== 'manage' || !o) return err('wrong_phase', 'no pending offer');
      if (o.to !== player) return err('not_your_turn', 'this offer is not addressed to you');
      if (o.id !== move.id) return err('bad_offer_id', `pending offer is #${o.id}`);
      ev(events, 'reject', { offer_id: o.id, by: player });
      note(st, `${player} rejects trade #${o.id}`);
      st.offer = null;
      break;
    }

    case 'counter': {
      const o = st.offer;
      if (st.phase !== 'manage' || !o) return err('wrong_phase', 'no pending offer');
      if (o.to !== player) return err('not_your_turn', 'this offer is not addressed to you');
      if (o.id !== move.id) return err('bad_offer_id', `pending offer is #${o.id}`);
      if (o.countered) return err('countered', 'an offer may be countered only once');
      const c: OfferState = {
        id: st.nextOfferId,
        from: player,
        to: o.from,
        give: deepClone(move.give),
        get: deepClone(move.get),
        note: move.note,
        countered: true,
      };
      const bad = validateOfferSides(st, c);
      if (bad) return err('bad_offer', bad);
      st.nextOfferId++;
      st.offer = c;
      ev(events, 'counter', { offer_id: c.id, in_reply_to: o.id, from: c.from, to: c.to, give: c.give as unknown, get: c.get as unknown, note: c.note });
      note(st, `${player} counters with trade #${c.id}`);
      break;
    }

    case 'pay_debt': {
      if (st.phase !== 'debt') return err('wrong_phase', 'no debt to pay');
      const pay = st.payments[0]!;
      if (pay.from !== player) return err('not_your_turn', 'not your debt');
      if (cashOf(st, player) < pay.amount) return err('poor', `need ${pay.amount}`);
      note(st, `${player} settles the debt of ${pay.amount}`);
      processPipeline(st, events, seed); // the pipeline pays it and continues
      break;
    }

    case 'declare_bankruptcy': {
      if (st.phase !== 'debt') return err('wrong_phase', 'no debt outstanding');
      const pay = st.payments[0]!;
      if (pay.from !== player) return err('not_your_turn', 'not your debt');
      if (liquidationCeiling(st, player) >= pay.amount) {
        return err('solvent', 'you can still raise the money by selling or mortgaging');
      }
      doBankruptcy(st, player, pay.to, events);
      processPipeline(st, events, seed);
      break;
    }

    case 'end_turn': {
      if (st.phase !== 'manage') return err('wrong_phase', 'end_turn is a manage-phase move');
      if (st.offer) return err('wrong_phase', 'the pending offer must be resolved first');
      if (player !== st.current) return err('not_your_turn', 'only the player on turn ends it');
      if (st.rolledDouble && !(st.detained[player] ?? false)) {
        st.rolledDouble = false;
        st.phase = 'roll';
        note(st, `${player} rolled a double and goes again`);
      } else {
        advanceTurn(st);
      }
      ev(events, 'end_turn', { player });
      break;
    }

    default:
      return err('bad_move', `unknown move tag '${(move as { t: string }).t}'`);
  }

  return { state: st, events };
}

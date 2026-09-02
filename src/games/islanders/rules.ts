/**
 * Islanders — an original island-settlement game (spec
 * games.M3_hidden_information_and_trading.islanders). 3-4 players settle a
 * 19-hex island: five original resources (palm, coral, reed, taro, obsidian),
 * a Raider instead of a bandit piece, "saga" progress cards (warrior,
 * landmark, pathfinder, bounty, tithe), and harbors for cheap bank trades.
 * All names, layouts, and card text are original; only the public-domain
 * mechanics are shared with the well-known trading game.
 *
 * Board coordinates: the 19 land hexes are lettered A-S in reading order and
 * the 18 surrounding sea hexes a-r. A vertex is named by the ASCII-sorted
 * letters of the 3 hexes it touches (e.g. "ABa"); an edge by the 2 hexes it
 * separates (e.g. "AB", "Aa"). 54 vertices, 72 edges — asserted in tests.
 */

import type {
  ApplyOk,
  GameEvent,
  GameResult,
  PlayerId,
  RuleError,
  SeedStream,
  VariantConfig,
} from '../../kernel/types.ts';
import { playerId } from '../../kernel/types.ts';

// ---------------------------------------------------------------------------
// Resources, terrain, cards, costs
// ---------------------------------------------------------------------------

export const RESOURCES = ['palm', 'coral', 'reed', 'taro', 'obsidian'] as const;
export type Resource = (typeof RESOURCES)[number];

export const TERRAIN_RESOURCE: Record<string, Resource | null> = {
  grove: 'palm',
  reef: 'coral',
  marsh: 'reed',
  paddy: 'taro',
  volcano: 'obsidian',
  dunes: null,
};

export const CARD_WARRIOR = 'warrior';
export const CARD_LANDMARK = 'landmark';
export const CARD_PATHFINDER = 'pathfinder';
export const CARD_BOUNTY = 'bounty';
export const CARD_TITHE = 'tithe';
/** Playable (non-VP) cards in canonical order. */
export const PLAYABLE_CARDS = [CARD_WARRIOR, CARD_PATHFINDER, CARD_BOUNTY, CARD_TITHE] as const;

/** 25-card saga deck: 14 warrior, 5 landmark, 2 pathfinder, 2 bounty, 2 tithe. */
export function deckComposition(): string[] {
  const d: string[] = [];
  for (let i = 0; i < 14; i++) d.push(CARD_WARRIOR);
  for (let i = 0; i < 5; i++) d.push(CARD_LANDMARK);
  for (let i = 0; i < 2; i++) d.push(CARD_PATHFINDER);
  for (let i = 0; i < 2; i++) d.push(CARD_BOUNTY);
  for (let i = 0; i < 2; i++) d.push(CARD_TITHE);
  return d;
}

export type Multiset = Record<string, number>;

export const COST_ROAD: Multiset = { palm: 1, coral: 1 };
export const COST_VILLAGE: Multiset = { palm: 1, coral: 1, reed: 1, taro: 1 };
export const COST_CITY: Multiset = { taro: 2, obsidian: 3 };
export const COST_PROGRESS: Multiset = { reed: 1, taro: 1, obsidian: 1 };

export const SUPPLY_ROADS = 15;
export const SUPPLY_VILLAGES = 5;
export const SUPPLY_CITIES = 4;
export const BANK_PER_RESOURCE = 19;
export const ROUND_LIMIT = 100;
export const WIN_VP = 10;
export const NO_VICTIM = '-';

// ---------------------------------------------------------------------------
// Board geometry (computed once at module load)
// ---------------------------------------------------------------------------

export const LAND_LETTERS: readonly string[] = [...'ABCDEFGHIJKLMNOPQRS'];
export const SEA_LETTERS: readonly string[] = [...'abcdefghijklmnopqr'];

export interface Axial {
  q: number;
  r: number;
}

const DIRS: readonly [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

function buildGeometry(): {
  coords: Record<string, Axial>;
  edgeIds: string[];
  vertexIds: string[];
  edgeVertices: Record<string, [string, string]>;
  vertexEdges: Record<string, string[]>;
  vertexAdj: Record<string, string[]>;
  hexVertices: Record<string, string[]>;
} {
  const coords: Record<string, Axial> = {};
  let li = 0;
  for (let r = -2; r <= 2; r++) {
    const qMin = Math.max(-2, -r - 2);
    const qMax = Math.min(2, -r + 2);
    for (let q = qMin; q <= qMax; q++) coords[LAND_LETTERS[li++]!] = { q, r };
  }
  let si = 0;
  for (let r = -3; r <= 3; r++) {
    const qMin = Math.max(-3, -r - 3);
    const qMax = Math.min(3, -r + 3);
    for (let q = qMin; q <= qMax; q++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3) {
        coords[SEA_LETTERS[si++]!] = { q, r };
      }
    }
  }
  if (li !== 19 || si !== 18) throw new Error('islanders geometry: bad letter counts');

  const byCoord = new Map<string, string>();
  for (const [letter, c] of Object.entries(coords)) byCoord.set(`${c.q},${c.r}`, letter);
  const neighborLetter = (letter: string, dir: number): string | undefined => {
    const c = coords[letter]!;
    const d = DIRS[dir]!;
    return byCoord.get(`${c.q + d[0]},${c.r + d[1]}`);
  };
  const sortId = (chars: string[]): string => chars.slice().sort().join('');

  const edgeSet = new Set<string>();
  const vertexSet = new Set<string>();
  const hexVertices: Record<string, string[]> = {};
  for (const L of LAND_LETTERS) {
    const verts: string[] = [];
    for (let d = 0; d < 6; d++) {
      const n1 = neighborLetter(L, d);
      if (n1) edgeSet.add(sortId([L, n1]));
      const n2 = neighborLetter(L, (d + 1) % 6);
      if (n1 && n2) verts.push(sortId([L, n1, n2]));
    }
    for (const v of verts) vertexSet.add(v);
    hexVertices[L] = [...new Set(verts)].sort();
  }

  const edgeIds = [...edgeSet].sort();
  const vertexIds = [...vertexSet].sort();

  const adjacent = (a: string, b: string): boolean => {
    const ca = coords[a]!;
    const cb = coords[b]!;
    return DIRS.some((d) => ca.q + d[0] === cb.q && ca.r + d[1] === cb.r);
  };

  const edgeVertices: Record<string, [string, string]> = {};
  for (const e of edgeIds) {
    const [x, y] = [e[0]!, e[1]!];
    const common = Object.keys(coords).filter((c) => c !== x && c !== y && adjacent(c, x) && adjacent(c, y));
    if (common.length !== 2) throw new Error(`islanders geometry: edge ${e} has ${common.length} flank hexes`);
    const vs = common.map((c) => sortId([x, y, c])).sort() as [string, string];
    edgeVertices[e] = vs;
    for (const v of vs) {
      if (!vertexSet.has(v)) throw new Error(`islanders geometry: edge ${e} vertex ${v} missing`);
    }
  }

  const vertexEdges: Record<string, string[]> = {};
  const vertexAdj: Record<string, string[]> = {};
  for (const v of vertexIds) {
    const chars = [...v];
    const es: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const e = sortId([chars[i]!, chars[j]!]);
        if (edgeSet.has(e)) es.push(e);
      }
    }
    vertexEdges[v] = es.sort();
    vertexAdj[v] = es
      .map((e) => {
        const [a, b] = edgeVertices[e]!;
        return a === v ? b : a;
      })
      .sort();
  }

  return { coords, edgeIds, vertexIds, edgeVertices, vertexEdges, vertexAdj, hexVertices };
}

const GEO = buildGeometry();
export const HEX_COORDS = GEO.coords;
export const EDGE_IDS: readonly string[] = GEO.edgeIds;
export const VERTEX_IDS: readonly string[] = GEO.vertexIds;
export const EDGE_VERTICES = GEO.edgeVertices;
export const VERTEX_EDGES = GEO.vertexEdges;
export const VERTEX_ADJ = GEO.vertexAdj;
export const HEX_VERTICES = GEO.hexVertices;
const EDGE_SET = new Set(EDGE_IDS);
const VERTEX_SET = new Set(VERTEX_IDS);

export function isEdgeId(id: string): boolean {
  return EDGE_SET.has(id);
}
export function isVertexId(id: string): boolean {
  return VERTEX_SET.has(id);
}
/** Land hexes a vertex touches (1-3 uppercase letters). */
export function vertexLandHexes(v: string): string[] {
  return [...v].filter((c) => c >= 'A' && c <= 'Z');
}

// ---------------------------------------------------------------------------
// Fixed beginner layout (original design, documented in notes/T5c-islanders.md)
// ---------------------------------------------------------------------------

export const BEGINNER_TERRAIN: Record<string, string> = {
  A: 'volcano', B: 'marsh', C: 'grove',
  D: 'paddy', E: 'reef', F: 'marsh', G: 'reef',
  H: 'paddy', I: 'grove', J: 'dunes', K: 'grove', L: 'volcano',
  M: 'grove', N: 'paddy', O: 'reef', P: 'marsh',
  Q: 'volcano', R: 'paddy', S: 'marsh',
};

export const BEGINNER_TOKENS: Record<string, number> = {
  A: 10, B: 2, C: 9,
  D: 12, E: 6, F: 4, G: 10,
  H: 9, I: 11, K: 3, L: 8,
  M: 8, N: 3, O: 4, P: 5,
  Q: 5, R: 6, S: 11,
};

/** Harbors: coastal edge -> 'any' (3:1) or a resource (2:1). Fixed in both variants. */
export const HARBORS: Record<string, string> = {
  Aa: 'palm',
  Cc: 'any',
  Gh: 'coral',
  Hg: 'any',
  Lj: 'any',
  Mk: 'reed',
  Pl: 'taro',
  Qp: 'obsidian',
  Sn: 'any',
};

// ---------------------------------------------------------------------------
// State and moves (plain JSON)
// ---------------------------------------------------------------------------

export type Hand = Record<string, number>; // dense: every resource key present

export type PendingOffer = {
  id: number;
  from: string;
  to: string;
  give: Multiset; // what `from` gives
  get: Multiset; // what `from` wants from `to`
  /** After a counter: terms from the responder's perspective. */
  counter: { give: Multiset; get: Multiset } | null;
};

export type IslState = {
  players: string[];
  layout: string; // 'beginner' | 'random'
  terrain: Record<string, string>;
  tokens: Record<string, number>;
  harbors: Record<string, string>;
  raider: string;
  villages: Record<string, string>; // vertex -> owner
  cities: Record<string, string>;
  roads: Record<string, string>; // edge -> owner
  hands: Record<string, Hand>;
  /** Unplayed saga cards, playable (not bought this turn). Hidden. */
  progress: Record<string, string[]>;
  /** Saga cards bought this turn (unplayable until next turn). Hidden. */
  bought: Record<string, string[]>;
  warriors: Record<string, number>;
  bank: Record<string, number>;
  deck: string[]; // hidden from everyone
  phase: string; // 'setup' | 'main' | 'discard' | 'raider' | 'over'
  setupMoves: number;
  lastSetupVertex: string;
  turn: number; // 1-based global player-turn counter; 0 during setup
  currentSeat: number;
  lastRoll: number; // 0 = none yet
  discardDue: Record<string, number>;
  offer: PendingOffer | null;
  offersMade: number; // offers initiated by the current player this turn
  progressPlayed: boolean;
  longestRoadHolder: string | null;
  largestArmyHolder: string | null;
  supply: Record<string, Record<string, number>>; // {roads, villages, cities}
  nextOfferId: number;
  lastMove: string;
};

export type IslMove =
  | { type: 'build_road'; edge: string }
  | { type: 'build_village'; vertex: string }
  | { type: 'build_city'; vertex: string }
  | { type: 'buy_progress' }
  | { type: 'play_progress'; card: 'warrior'; hex: string; victim: string }
  | { type: 'play_progress'; card: 'pathfinder'; edges: string[] }
  | { type: 'play_progress'; card: 'bounty'; take: Multiset }
  | { type: 'play_progress'; card: 'tithe'; resource: string }
  | { type: 'trade_bank'; give: string; get: string }
  | { type: 'offer'; give: Multiset; get: Multiset; to: string }
  | { type: 'accept'; id: number }
  | { type: 'reject'; id: number }
  | { type: 'counter'; id: number; give: Multiset; get: Multiset }
  | { type: 'move_bandit'; hex: string; victim: string }
  | { type: 'discard'; cards: Multiset }
  | { type: 'end_turn' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function emptyHand(): Hand {
  const h: Hand = {};
  for (const r of RESOURCES) h[r] = 0;
  return h;
}

export function handTotal(h: Hand): number {
  let t = 0;
  for (const r of RESOURCES) t += h[r] ?? 0;
  return t;
}

export function msTotal(ms: Multiset): number {
  let t = 0;
  for (const k of Object.keys(ms)) t += ms[k] ?? 0;
  return t;
}

function msEntries(ms: Multiset): [Resource, number][] {
  const out: [Resource, number][] = [];
  for (const r of RESOURCES) {
    const c = ms[r] ?? 0;
    if (c > 0) out.push([r, c]);
  }
  return out;
}

function validMultiset(ms: Multiset): boolean {
  // Hostile move bodies can reach apply() with anything here (missing field,
  // null, a number, an array) — that must be a structured rejection upstream,
  // never a thrown TypeError from Object.keys(null/undefined).
  if (typeof ms !== 'object' || ms === null || Array.isArray(ms)) return false;
  const keys = Object.keys(ms);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!(RESOURCES as readonly string[]).includes(k)) return false;
    const v = ms[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return false;
  }
  return true;
}

function holds(hand: Hand, ms: Multiset): boolean {
  for (const [r, c] of msEntries(ms)) if ((hand[r] ?? 0) < c) return false;
  return true;
}

function transfer(fromHand: Hand, toHand: Hand, ms: Multiset): void {
  for (const [r, c] of msEntries(ms)) {
    fromHand[r] = (fromHand[r] ?? 0) - c;
    toHand[r] = (toHand[r] ?? 0) + c;
  }
}

function payToBank(s: IslState, p: string, cost: Multiset): void {
  transfer(s.hands[p]!, s.bank, cost);
}

function gainFromBank(s: IslState, p: string, res: Resource, n: number): number {
  const avail = Math.min(s.bank[res] ?? 0, n);
  s.bank[res] = (s.bank[res] ?? 0) - avail;
  const h = s.hands[p]!;
  h[res] = (h[res] ?? 0) + avail;
  return avail;
}

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

function ev(type: string, data: GameEvent['data'], visibility: 'public' | 'private' = 'public', to?: string[]): GameEvent {
  const e: GameEvent = { type, data, visibility };
  if (to) e.to = to;
  return e;
}

export function currentPlayer(s: IslState): string {
  return s.players[s.currentSeat]!;
}

export function roundOf(s: IslState): number {
  return s.turn === 0 ? 0 : Math.ceil(s.turn / s.players.length);
}

/** Snake seat for setup placement k (0-based village+road pair index). */
export function snakeSeat(k: number, n: number): number {
  return k < n ? k : 2 * n - 1 - k;
}

function setupSeat(s: IslState): number {
  return snakeSeat(Math.floor(s.setupMoves / 2), s.players.length);
}

function buildingOwner(s: IslState, vertex: string): string | undefined {
  return s.villages[vertex] ?? s.cities[vertex];
}

// ---------------------------------------------------------------------------
// Setup / initial state
// ---------------------------------------------------------------------------

export function createInitialState(seed: SeedStream, players: PlayerId[], variant: VariantConfig): IslState {
  const n = players.length;
  if (n < 3 || n > 4) throw new Error('islanders: 3 or 4 players');
  const layout = String(variant['layout'] ?? 'beginner');

  let terrain: Record<string, string>;
  let tokens: Record<string, number>;
  if (layout === 'random') {
    const terrainList = LAND_LETTERS.map((L) => BEGINNER_TERRAIN[L]!);
    const shuffledTerrain = seed.shuffle('shuffle:terrain', terrainList);
    terrain = {};
    LAND_LETTERS.forEach((L, i) => {
      terrain[L] = shuffledTerrain[i]!;
    });
    const tokenList = LAND_LETTERS.filter((L) => BEGINNER_TERRAIN[L] !== 'dunes').map((L) => BEGINNER_TOKENS[L]!);
    const shuffledTokens = seed.shuffle('shuffle:tokens', tokenList);
    tokens = {};
    let ti = 0;
    for (const L of LAND_LETTERS) {
      if (terrain[L] !== 'dunes') tokens[L] = shuffledTokens[ti++]!;
    }
  } else {
    terrain = { ...BEGINNER_TERRAIN };
    tokens = { ...BEGINNER_TOKENS };
  }

  const dunesHex = LAND_LETTERS.find((L) => terrain[L] === 'dunes')!;
  const deck = seed.shuffle('shuffle:progress', deckComposition());

  const hands: Record<string, Hand> = {};
  const progress: Record<string, string[]> = {};
  const bought: Record<string, string[]> = {};
  const warriors: Record<string, number> = {};
  const supply: Record<string, Record<string, number>> = {};
  for (const p of players) {
    hands[p] = emptyHand();
    progress[p] = [];
    bought[p] = [];
    warriors[p] = 0;
    supply[p] = { roads: SUPPLY_ROADS, villages: SUPPLY_VILLAGES, cities: SUPPLY_CITIES };
  }
  const bank: Record<string, number> = {};
  for (const r of RESOURCES) bank[r] = BANK_PER_RESOURCE;

  return {
    players: players.slice(),
    layout,
    terrain,
    tokens,
    harbors: { ...HARBORS },
    raider: dunesHex,
    villages: {},
    cities: {},
    roads: {},
    hands,
    progress,
    bought,
    warriors,
    bank,
    deck,
    phase: 'setup',
    setupMoves: 0,
    lastSetupVertex: '',
    turn: 0,
    currentSeat: 0,
    lastRoll: 0,
    discardDue: {},
    offer: null,
    offersMade: 0,
    progressPlayed: false,
    longestRoadHolder: null,
    largestArmyHolder: null,
    supply,
    nextOfferId: 1,
    lastMove: '',
  };
}

// ---------------------------------------------------------------------------
// Players to move
// ---------------------------------------------------------------------------

export function playersToMove(s: IslState): PlayerId[] {
  if (s.phase === 'over') return [];
  if (s.phase === 'setup') return [s.players[setupSeat(s)]!];
  if (s.phase === 'discard') return s.players.filter((p) => (s.discardDue[p] ?? 0) > 0);
  if (s.phase === 'raider') return [currentPlayer(s)];
  // main
  if (s.offer) return [s.offer.counter ? s.offer.from : s.offer.to];
  return [currentPlayer(s)];
}

// ---------------------------------------------------------------------------
// Placement legality
// ---------------------------------------------------------------------------

/** Distance rule: vertex free and no adjacent vertex occupied (any owner). */
export function vertexOpenForVillage(s: IslState, vertex: string): boolean {
  if (buildingOwner(s, vertex)) return false;
  for (const w of VERTEX_ADJ[vertex]!) if (buildingOwner(s, w)) return false;
  return true;
}

/** Setup village spots additionally need a free adjacent edge for the paired road. */
export function setupVillageSpots(s: IslState): string[] {
  return VERTEX_IDS.filter(
    (v) => vertexOpenForVillage(s, v) && VERTEX_EDGES[v]!.some((e) => s.roads[e] === undefined),
  );
}

/** Main-phase village spots: distance rule + touching own road. */
export function villageSpots(s: IslState, p: string): string[] {
  return VERTEX_IDS.filter(
    (v) => vertexOpenForVillage(s, v) && VERTEX_EDGES[v]!.some((e) => s.roads[e] === p),
  );
}

/**
 * Road legality: edge free, and one endpoint either carries the player's own
 * building, or is an unblocked junction (no opponent building) reached by one
 * of the player's roads.
 */
export function edgeOpenForRoad(s: IslState, p: string, edge: string): boolean {
  if (s.roads[edge] !== undefined) return false;
  for (const v of EDGE_VERTICES[edge]!) {
    const owner = buildingOwner(s, v);
    if (owner === p) return true;
    if (owner === undefined && VERTEX_EDGES[v]!.some((e) => e !== edge && s.roads[e] === p)) return true;
  }
  return false;
}

export function roadSpots(s: IslState, p: string): string[] {
  return EDGE_IDS.filter((e) => edgeOpenForRoad(s, p, e));
}

// ---------------------------------------------------------------------------
// Longest road / largest army
// ---------------------------------------------------------------------------

/**
 * Longest trail over the player's road edges. Each edge used once; the trail
 * may not pass THROUGH a vertex occupied by an opponent building (it may end
 * there). Brute-force DFS — road supply caps the edge count at 15.
 */
export function longestRoadLength(s: IslState, p: string): number {
  const own = Object.keys(s.roads).filter((e) => s.roads[e] === p);
  if (own.length === 0) return 0;
  const incident = new Map<string, string[]>();
  for (const e of own) {
    for (const v of EDGE_VERTICES[e]!) {
      const list = incident.get(v);
      if (list) list.push(e);
      else incident.set(v, [e]);
    }
  }
  const blocked = (v: string): boolean => {
    const o = buildingOwner(s, v);
    return o !== undefined && o !== p;
  };
  let best = 0;
  const used = new Set<string>();
  const dfs = (v: string, len: number): void => {
    if (len > best) best = len;
    if (len > 0 && blocked(v)) return; // may end at, not pass through
    for (const e of incident.get(v) ?? []) {
      if (used.has(e)) continue;
      const [a, b] = EDGE_VERTICES[e]!;
      used.add(e);
      dfs(a === v ? b : a, len + 1);
      used.delete(e);
    }
  };
  for (const v of incident.keys()) dfs(v, 0);
  return best;
}

/**
 * Sticky-holder rule: first to 5+ takes the bonus; it transfers only when
 * strictly exceeded; ties retain the holder. If the holder's road is broken
 * below 5, the bonus goes to the unique strict leader with 5+, else to no one.
 */
function updateLongestRoad(s: IslState, events: GameEvent[]): void {
  const lens = new Map<string, number>();
  for (const p of s.players) lens.set(p, longestRoadLength(s, p));
  const holder = s.longestRoadHolder;
  let next: string | null = holder;

  if (holder !== null && (lens.get(holder) ?? 0) >= 5) {
    const holderLen = lens.get(holder)!;
    let bestP: string | null = null;
    let bestLen = holderLen;
    for (const p of s.players) {
      if (p === holder) continue;
      const l = lens.get(p)!;
      if (l > bestLen) {
        bestLen = l;
        bestP = p;
      }
    }
    if (bestP !== null) next = bestP; // strictly exceeded
  } else {
    // no holder, or holder broken below 5: unique strict leader with 5+ takes it
    let bestLen = 0;
    for (const p of s.players) bestLen = Math.max(bestLen, lens.get(p)!);
    const leaders = s.players.filter((p) => lens.get(p)! === bestLen);
    next = bestLen >= 5 && leaders.length === 1 ? leaders[0]! : null;
  }

  if (next !== s.longestRoadHolder) {
    events.push(
      ev('longest_road', {
        holder: next,
        previous: s.longestRoadHolder,
        length: next === null ? 0 : lens.get(next)!,
      }),
    );
    s.longestRoadHolder = next;
  }
}

function updateLargestArmy(s: IslState, p: string, events: GameEvent[]): void {
  const c = s.warriors[p] ?? 0;
  if (c < 3) return;
  const holder = s.largestArmyHolder;
  if (holder === p) return;
  if (holder === null || c > (s.warriors[holder] ?? 0)) {
    events.push(ev('largest_army', { holder: p, previous: holder, warriors: c }));
    s.largestArmyHolder = p;
  }
}

// ---------------------------------------------------------------------------
// Victory points and terminal
// ---------------------------------------------------------------------------

export function victoryPoints(s: IslState, p: string, includeHidden: boolean): number {
  let vp = 0;
  for (const v of Object.keys(s.villages)) if (s.villages[v] === p) vp += 1;
  for (const v of Object.keys(s.cities)) if (s.cities[v] === p) vp += 2;
  if (s.longestRoadHolder === p) vp += 2;
  if (s.largestArmyHolder === p) vp += 2;
  if (includeHidden) {
    for (const c of s.progress[p] ?? []) if (c === CARD_LANDMARK) vp += 1;
    for (const c of s.bought[p] ?? []) if (c === CARD_LANDMARK) vp += 1;
  }
  return vp;
}

export function isTerminal(s: IslState): GameResult | null {
  const scores = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of s.players) out[p] = victoryPoints(s, p, true);
    return out;
  };
  if (s.phase === 'over') {
    const vps = scores();
    let bestVp = -1;
    for (const p of s.players) bestVp = Math.max(bestVp, vps[p]!);
    let leaders = s.players.filter((p) => vps[p] === bestVp);
    if (leaders.length > 1) {
      let bestRes = -1;
      for (const p of leaders) bestRes = Math.max(bestRes, handTotal(s.hands[p]!));
      leaders = leaders.filter((p) => handTotal(s.hands[p]!) === bestRes);
    }
    return { winners: leaders, draw: leaders.length > 1, scores: vps, reason: 'turn_limit' };
  }
  if (s.phase === 'setup') return null;
  // 10 VP win is checked on the current player's turn only (hidden landmarks count).
  const cur = currentPlayer(s);
  if (victoryPoints(s, cur, true) >= WIN_VP) {
    return { winners: [cur], draw: false, scores: scores(), reason: 'points' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Production, rolls, discards, steals
// ---------------------------------------------------------------------------

/**
 * Distribute production for a roll. Standard shortage rule: if the bank cannot
 * cover everyone owed a resource and more than one player is owed it, nobody
 * receives that resource; a single owed player takes what remains.
 */
export function produce(s: IslState, roll: number, events: GameEvent[]): void {
  const owed = new Map<Resource, Map<string, number>>();
  for (const hex of Object.keys(s.tokens)) {
    if (s.tokens[hex] !== roll || s.raider === hex) continue;
    const res = TERRAIN_RESOURCE[s.terrain[hex]!];
    if (!res) continue;
    for (const v of HEX_VERTICES[hex]!) {
      const add = (owner: string | undefined, amount: number): void => {
        if (!owner) return;
        let m = owed.get(res);
        if (!m) {
          m = new Map();
          owed.set(res, m);
        }
        m.set(owner, (m.get(owner) ?? 0) + amount);
      };
      add(s.villages[v], 1);
      add(s.cities[v], 2);
    }
  }
  const gains: Record<string, Multiset> = {};
  for (const [res, perPlayer] of owed) {
    let total = 0;
    for (const c of perPlayer.values()) total += c;
    const avail = s.bank[res] ?? 0;
    if (total > avail && perPlayer.size > 1) {
      events.push(ev('production_shortage', { resource: res, owed: total, bank: avail }));
      continue;
    }
    for (const p of s.players) {
      const c = perPlayer.get(p);
      if (!c) continue;
      const got = gainFromBank(s, p, res, c);
      if (got > 0) {
        const g = (gains[p] ??= {});
        g[res] = (g[res] ?? 0) + got;
      }
    }
  }
  events.push(ev('production', { roll, gains }));
}

/** Roll the dice for s.turn and set up production / discard / raider phases. */
function beginTurn(s: IslState, seed: SeedStream, events: GameEvent[]): void {
  const cur = currentPlayer(s);
  const purpose = `dice:turn:${s.turn}`;
  const d1 = seed.die(purpose, 6);
  const d2 = seed.die(purpose, 6);
  const roll = d1 + d2;
  s.lastRoll = roll;
  events.push(ev('roll', { player: cur, dice: [d1, d2], total: roll }));
  if (roll === 7) {
    const due: Record<string, number> = {};
    for (const p of s.players) {
      const t = handTotal(s.hands[p]!);
      if (t > 7) due[p] = Math.floor(t / 2);
    }
    s.discardDue = due;
    if (Object.keys(due).length > 0) {
      s.phase = 'discard';
      events.push(ev('discard_due', { due }));
    } else {
      s.phase = 'raider';
    }
  } else {
    produce(s, roll, events);
    s.phase = 'main';
  }
}

/** Opponents with a building on the hex and at least one card to steal. */
export function stealVictims(s: IslState, mover: string, hex: string): string[] {
  const out: string[] = [];
  for (const p of s.players) {
    if (p === mover) continue;
    const hasBuilding = HEX_VERTICES[hex]!.some((v) => buildingOwner(s, v) === p);
    if (hasBuilding && handTotal(s.hands[p]!) > 0) out.push(p);
  }
  return out;
}

/** Steal one seeded-random card from victim; purpose 'steal:turn:N'. */
function stealCard(s: IslState, thief: string, victim: string, seed: SeedStream, events: GameEvent[]): void {
  const hand = s.hands[victim]!;
  const total = handTotal(hand);
  const idx = seed.int(`steal:turn:${s.turn}`, total);
  let acc = 0;
  let stolen: Resource = RESOURCES[0];
  for (const r of RESOURCES) {
    acc += hand[r] ?? 0;
    if (idx < acc) {
      stolen = r;
      break;
    }
  }
  hand[stolen] = (hand[stolen] ?? 0) - 1;
  const th = s.hands[thief]!;
  th[stolen] = (th[stolen] ?? 0) + 1;
  events.push(ev('stolen', { from: victim, to: thief }));
  events.push(ev('stolen_card', { from: victim, to: thief, resource: stolen }, 'private', [thief, victim]));
}

/** All exact discard combinations for a hand and due count, canonical order. */
export function discardCombos(hand: Hand, due: number): Multiset[] {
  const out: Multiset[] = [];
  const counts: number[] = [];
  const rec = (idx: number, remaining: number): void => {
    if (idx === RESOURCES.length) {
      if (remaining === 0) {
        const ms: Multiset = {};
        for (let i = 0; i < RESOURCES.length; i++) {
          if (counts[i]! > 0) ms[RESOURCES[i]!] = counts[i]!;
        }
        out.push(ms);
      }
      return;
    }
    let laterMax = 0;
    for (let i = idx + 1; i < RESOURCES.length; i++) laterMax += hand[RESOURCES[i]!] ?? 0;
    const maxTake = Math.min(hand[RESOURCES[idx]!] ?? 0, remaining);
    const minTake = Math.max(0, remaining - laterMax);
    for (let t = minTake; t <= maxTake; t++) {
      counts[idx] = t;
      rec(idx + 1, remaining - t);
    }
    counts[idx] = 0;
  };
  rec(0, due);
  return out;
}

// ---------------------------------------------------------------------------
// Trading helpers
// ---------------------------------------------------------------------------

/** Best bank rate for giving `res`: 2 with its harbor, 3 with any-harbor, else 4. */
export function bankRate(s: IslState, p: string, res: Resource): number {
  let rate = 4;
  for (const [edge, kind] of Object.entries(s.harbors)) {
    const owns = EDGE_VERTICES[edge]!.some((v) => buildingOwner(s, v) === p);
    if (!owns) continue;
    if (kind === res) return 2;
    if (kind === 'any') rate = Math.min(rate, 3);
  }
  return rate;
}

/**
 * Bounded structured-offer shapes (documented implementation choice so
 * legalMoves stays complete): give and get each total 1 or 2, combined total
 * at most 3 (1:1, 2:1, 1:2), no resource on both sides, both non-empty.
 */
function offerShapeOk(give: Multiset, get: Multiset): boolean {
  if (!validMultiset(give) || !validMultiset(get)) return false;
  const gt = msTotal(give);
  const wt = msTotal(get);
  if (gt < 1 || gt > 2 || wt < 1 || wt > 2 || gt + wt > 3) return false;
  for (const k of Object.keys(give)) if ((get[k] ?? 0) > 0) return false;
  return true;
}

/** Multisets of total 1 (then 2) drawable from `limit`, canonical order. */
function boundedMultisets(limit: Hand): Multiset[] {
  const out: Multiset[] = [];
  for (const r of RESOURCES) if ((limit[r] ?? 0) >= 1) out.push({ [r]: 1 });
  for (let i = 0; i < RESOURCES.length; i++) {
    for (let j = i; j < RESOURCES.length; j++) {
      const a = RESOURCES[i]!;
      const b = RESOURCES[j]!;
      if (a === b) {
        if ((limit[a] ?? 0) >= 2) out.push({ [a]: 2 });
      } else if ((limit[a] ?? 0) >= 1 && (limit[b] ?? 0) >= 1) {
        out.push({ [a]: 1, [b]: 1 });
      }
    }
  }
  return out;
}

const UNLIMITED: Hand = { palm: 99, coral: 99, reed: 99, taro: 99, obsidian: 99 };

function offerMoves(s: IslState, p: string): IslMove[] {
  const out: IslMove[] = [];
  if (s.offersMade >= 3) return out;
  const gives = boundedMultisets(s.hands[p]!);
  const gets = boundedMultisets(UNLIMITED);
  for (const to of s.players) {
    if (to === p) continue;
    for (const give of gives) {
      for (const get of gets) {
        if (!offerShapeOk(give, get)) continue;
        out.push({ type: 'offer', give, get, to });
      }
    }
  }
  return out;
}

function counterMoves(s: IslState, p: string): IslMove[] {
  const out: IslMove[] = [];
  const offer = s.offer;
  if (!offer || offer.counter) return out;
  const gives = boundedMultisets(s.hands[p]!);
  const gets = boundedMultisets(UNLIMITED);
  for (const give of gives) {
    for (const get of gets) {
      if (!offerShapeOk(give, get)) continue;
      out.push({ type: 'counter', id: offer.id, give, get });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raider moves and pathfinder enumeration
// ---------------------------------------------------------------------------

function raiderMoves(s: IslState, mover: string, moveType: 'move_bandit' | 'warrior'): IslMove[] {
  const out: IslMove[] = [];
  for (const hex of LAND_LETTERS) {
    if (hex === s.raider) continue;
    const victims = stealVictims(s, mover, hex);
    if (victims.length === 0) {
      out.push(
        moveType === 'move_bandit'
          ? { type: 'move_bandit', hex, victim: NO_VICTIM }
          : { type: 'play_progress', card: 'warrior', hex, victim: NO_VICTIM },
      );
    } else {
      for (const v of victims) {
        out.push(
          moveType === 'move_bandit'
            ? { type: 'move_bandit', hex, victim: v }
            : { type: 'play_progress', card: 'warrior', hex, victim: v },
        );
      }
    }
  }
  return out;
}

/**
 * Pathfinder placements: ordered pairs (e1, e2) where e2 is legal after e1 is
 * placed. When no pair exists (one placement possible, or one road left in
 * supply) single-edge plays are offered instead.
 */
export function pathfinderMoves(s: IslState, p: string): IslMove[] {
  const supplyRoads = s.supply[p]!['roads'] ?? 0;
  if (supplyRoads < 1) return [];
  const first = roadSpots(s, p);
  if (first.length === 0) return [];
  const out: IslMove[] = [];
  if (supplyRoads >= 2) {
    for (const e1 of first) {
      s.roads[e1] = p; // tentative
      for (const e2 of roadSpots(s, p)) out.push({ type: 'play_progress', card: 'pathfinder', edges: [e1, e2] });
      delete s.roads[e1];
    }
  }
  if (out.length === 0) {
    for (const e1 of first) out.push({ type: 'play_progress', card: 'pathfinder', edges: [e1] });
  }
  return out;
}

function bountyMoves(s: IslState): IslMove[] {
  const out: IslMove[] = [];
  let bankTotal = 0;
  for (const r of RESOURCES) bankTotal += s.bank[r] ?? 0;
  if (bankTotal === 0) return out;
  if (bankTotal === 1) {
    for (const r of RESOURCES) if ((s.bank[r] ?? 0) >= 1) out.push({ type: 'play_progress', card: 'bounty', take: { [r]: 1 } });
    return out;
  }
  for (let i = 0; i < RESOURCES.length; i++) {
    for (let j = i; j < RESOURCES.length; j++) {
      const a = RESOURCES[i]!;
      const b = RESOURCES[j]!;
      if (a === b) {
        if ((s.bank[a] ?? 0) >= 2) out.push({ type: 'play_progress', card: 'bounty', take: { [a]: 2 } });
      } else if ((s.bank[a] ?? 0) >= 1 && (s.bank[b] ?? 0) >= 1) {
        out.push({ type: 'play_progress', card: 'bounty', take: { [a]: 1, [b]: 1 } });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legal moves
// ---------------------------------------------------------------------------

export function legalMoves(state: IslState, player: PlayerId): IslMove[] {
  const s = state;
  if (!playersToMove(s).includes(player)) return [];
  if (isTerminal(s)) return [];

  if (s.phase === 'setup') {
    if (s.setupMoves % 2 === 0) {
      return setupVillageSpots(s).map((vertex) => ({ type: 'build_village', vertex }) as IslMove);
    }
    return VERTEX_EDGES[s.lastSetupVertex]!.filter((e) => s.roads[e] === undefined).map(
      (edge) => ({ type: 'build_road', edge }) as IslMove,
    );
  }

  if (s.phase === 'discard') {
    const due = s.discardDue[player] ?? 0;
    return discardCombos(s.hands[player]!, due).map((cards) => ({ type: 'discard', cards }) as IslMove);
  }

  if (s.phase === 'raider') {
    return raiderMoves(s, player, 'move_bandit');
  }

  // main phase
  if (s.offer) {
    const offer = s.offer;
    const out: IslMove[] = [];
    if (offer.counter) {
      // original offerer responds to the counter
      if (holds(s.hands[player]!, offer.counter.get)) out.push({ type: 'accept', id: offer.id });
      out.push({ type: 'reject', id: offer.id });
    } else {
      if (holds(s.hands[player]!, offer.get)) out.push({ type: 'accept', id: offer.id });
      out.push({ type: 'reject', id: offer.id });
      out.push(...counterMoves(s, player));
    }
    return out;
  }

  const out: IslMove[] = [];
  const hand = s.hands[player]!;
  const supply = s.supply[player]!;

  if ((supply['roads'] ?? 0) > 0 && holds(hand, COST_ROAD)) {
    for (const edge of roadSpots(s, player)) out.push({ type: 'build_road', edge });
  }
  if ((supply['villages'] ?? 0) > 0 && holds(hand, COST_VILLAGE)) {
    for (const vertex of villageSpots(s, player)) out.push({ type: 'build_village', vertex });
  }
  if ((supply['cities'] ?? 0) > 0 && holds(hand, COST_CITY)) {
    for (const vertex of VERTEX_IDS) if (s.villages[vertex] === player) out.push({ type: 'build_city', vertex });
  }
  if (s.deck.length > 0 && holds(hand, COST_PROGRESS)) {
    out.push({ type: 'buy_progress' });
  }
  if (!s.progressPlayed) {
    const cards = new Set(s.progress[player] ?? []);
    if (cards.has(CARD_WARRIOR)) out.push(...raiderMoves(s, player, 'warrior'));
    if (cards.has(CARD_PATHFINDER)) out.push(...pathfinderMoves(s, player));
    if (cards.has(CARD_BOUNTY)) out.push(...bountyMoves(s));
    if (cards.has(CARD_TITHE)) {
      for (const r of RESOURCES) out.push({ type: 'play_progress', card: 'tithe', resource: r });
    }
  }
  for (const give of RESOURCES) {
    const rate = bankRate(s, player, give);
    if ((hand[give] ?? 0) < rate) continue;
    for (const get of RESOURCES) {
      if (get === give || (s.bank[get] ?? 0) < 1) continue;
      out.push({ type: 'trade_bank', give, get });
    }
  }
  out.push(...offerMoves(s, player));
  out.push({ type: 'end_turn' });
  return out;
}

// ---------------------------------------------------------------------------
// Notation (kept here so apply can stamp lastMove without circular imports)
// ---------------------------------------------------------------------------

/** Multiset as notation: resources in canonical order, repeated, '+'-joined. */
export function msToNotation(ms: Multiset): string {
  const parts: string[] = [];
  for (const [r, c] of msEntries(ms)) for (let i = 0; i < c; i++) parts.push(r);
  return parts.join('+');
}

export function moveToNotation(move: IslMove): string {
  switch (move.type) {
    case 'build_road':
      return `build_road(${move.edge})`;
    case 'build_village':
      return `build_village(${move.vertex})`;
    case 'build_city':
      return `build_city(${move.vertex})`;
    case 'buy_progress':
      return 'buy_progress';
    case 'play_progress':
      switch (move.card) {
        case 'warrior':
          return `play_progress(warrior,${move.hex},${move.victim})`;
        case 'pathfinder':
          return `play_progress(pathfinder,${move.edges.join(',')})`;
        case 'bounty':
          return `play_progress(bounty,${msToNotation(move.take)})`;
        case 'tithe':
          return `play_progress(tithe,${move.resource})`;
      }
      break;
    case 'trade_bank':
      return `trade_bank(${move.give},${move.get})`;
    case 'offer':
      return `offer(${msToNotation(move.give)},${msToNotation(move.get)},${move.to})`;
    case 'accept':
      return `accept(${move.id})`;
    case 'reject':
      return `reject(${move.id})`;
    case 'counter':
      return `counter(${move.id},${msToNotation(move.give)},${msToNotation(move.get)})`;
    case 'move_bandit':
      return `move_bandit(${move.hex},${move.victim})`;
    case 'discard':
      return `discard(${msToNotation(move.cards)})`;
    case 'end_turn':
      return 'end_turn';
  }
  /* c8 ignore next */
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function applyMove(
  state: IslState,
  player: PlayerId,
  move: IslMove,
  seed: SeedStream,
): ApplyOk<IslState> | RuleError {
  if (isTerminal(state)) return err('game_over', 'the game has ended');
  if (!playersToMove(state).includes(player)) return err('not_your_turn', `${player} is not to move`);
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  const n = s.players.length;

  const finish = (): ApplyOk<IslState> => {
    s.lastMove = `${player} ${moveToNotation(move)}`;
    return { state: s, events };
  };

  // ----- setup phase -----
  if (s.phase === 'setup') {
    if (s.setupMoves % 2 === 0) {
      if (move.type !== 'build_village') return err('bad_phase', 'setup: place a village');
      const v = move.vertex;
      if (!isVertexId(v)) return err('bad_vertex', `unknown vertex ${v}`);
      if (!vertexOpenForVillage(s, v)) return err('distance_rule', `vertex ${v} is occupied or adjacent to a building`);
      if (!VERTEX_EDGES[v]!.some((e) => s.roads[e] === undefined)) {
        return err('no_road_slot', `vertex ${v} has no free adjacent edge for the setup road`);
      }
      s.villages[v] = player;
      s.supply[player]!['villages'] = (s.supply[player]!['villages'] ?? 0) - 1;
      s.lastSetupVertex = v;
      events.push(ev('built', { player, kind: 'village', at: v }));
      // second-pass village pays one resource per adjacent producing hex
      const k = Math.floor(s.setupMoves / 2);
      if (k >= n) {
        const gained: Multiset = {};
        for (const hex of vertexLandHexes(v)) {
          const res = TERRAIN_RESOURCE[s.terrain[hex]!];
          if (!res) continue;
          const got = gainFromBank(s, player, res, 1);
          if (got > 0) gained[res] = (gained[res] ?? 0) + got;
        }
        events.push(ev('setup_payout', { player, gained }));
      }
      s.setupMoves++;
      return finish();
    }
    if (move.type !== 'build_road') return err('bad_phase', 'setup: place a road next to your new village');
    const e = move.edge;
    if (!isEdgeId(e)) return err('bad_edge', `unknown edge ${e}`);
    if (!VERTEX_EDGES[s.lastSetupVertex]!.includes(e)) {
      return err('bad_setup_road', `edge ${e} does not touch the village just placed at ${s.lastSetupVertex}`);
    }
    if (s.roads[e] !== undefined) return err('occupied', `edge ${e} already has a road`);
    s.roads[e] = player;
    s.supply[player]!['roads'] = (s.supply[player]!['roads'] ?? 0) - 1;
    events.push(ev('built', { player, kind: 'road', at: e }));
    s.setupMoves++;
    if (s.setupMoves === 4 * n) {
      s.turn = 1;
      s.currentSeat = 0;
      s.phase = 'main';
      beginTurn(s, seed, events);
    } else {
      s.currentSeat = setupSeat(s);
    }
    return finish();
  }

  // ----- discard phase -----
  if (s.phase === 'discard') {
    if (move.type !== 'discard') return err('bad_phase', 'discard phase: submit discard(cards)');
    const due = s.discardDue[player] ?? 0;
    if (due <= 0) return err('nothing_due', `${player} owes no discard`);
    const cards = move.cards;
    if (!validMultiset(cards)) return err('bad_cards', 'discard needs a non-empty resource multiset');
    if (msTotal(cards) !== due) return err('wrong_count', `must discard exactly ${due} cards`);
    if (!holds(s.hands[player]!, cards)) return err('not_held', 'cannot discard cards you do not hold');
    transfer(s.hands[player]!, s.bank, cards);
    delete s.discardDue[player];
    events.push(ev('discarded', { player, count: due }));
    events.push(ev('discarded_cards', { player, cards }, 'private', [player]));
    if (Object.keys(s.discardDue).length === 0) s.phase = 'raider';
    return finish();
  }

  // ----- raider phase -----
  if (s.phase === 'raider') {
    if (move.type !== 'move_bandit') return err('bad_phase', 'raider phase: move_bandit(hex,victim)');
    const res = moveRaider(s, player, move.hex, move.victim, seed, events);
    if (res) return res;
    s.phase = 'main';
    return finish();
  }

  // ----- main phase -----
  if (s.phase !== 'main') return err('bad_phase', `no moves in phase ${s.phase}`);

  // pending offer responses
  if (s.offer) {
    const offer = s.offer;
    if (move.type === 'accept') {
      if (move.id !== offer.id) return err('bad_offer_id', `offer ${move.id} is not pending`);
      const from = offer.from;
      const to = offer.to;
      if (offer.counter) {
        if (player !== from) return err('not_your_turn', 'only the original offerer answers a counter');
        const terms = offer.counter;
        if (!holds(s.hands[to]!, terms.give)) return err('not_held', `${to} no longer holds the countered give`);
        if (!holds(s.hands[from]!, terms.get)) return err('not_held', `${from} cannot pay the countered ask`);
        transfer(s.hands[to]!, s.hands[from]!, terms.give);
        transfer(s.hands[from]!, s.hands[to]!, terms.get);
        events.push(ev('trade', { kind: 'player', id: offer.id, from: to, to: from, give: terms.give, get: terms.get }));
      } else {
        if (player !== to) return err('not_your_turn', 'only the offer recipient may accept');
        if (!holds(s.hands[to]!, offer.get)) return err('not_held', `${to} cannot pay the asked resources`);
        if (!holds(s.hands[from]!, offer.give)) return err('not_held', `${from} cannot pay the offered resources`);
        transfer(s.hands[from]!, s.hands[to]!, offer.give);
        transfer(s.hands[to]!, s.hands[from]!, offer.get);
        events.push(ev('trade', { kind: 'player', id: offer.id, from, to, give: offer.give, get: offer.get }));
      }
      s.offer = null;
      return finish();
    }
    if (move.type === 'reject') {
      if (move.id !== offer.id) return err('bad_offer_id', `offer ${move.id} is not pending`);
      events.push(ev('offer_rejected', { id: offer.id, by: player }));
      s.offer = null;
      return finish();
    }
    if (move.type === 'counter') {
      if (move.id !== offer.id) return err('bad_offer_id', `offer ${move.id} is not pending`);
      if (offer.counter) return err('counter_once', 'an offer may be countered only once');
      if (player !== offer.to) return err('not_your_turn', 'only the offer recipient may counter');
      if (!offerShapeOk(move.give, move.get)) return err('bad_offer', 'counter give/get must each total 1-2 (combined at most 3) with no shared resource');
      if (!holds(s.hands[player]!, move.give)) return err('not_held', 'cannot counter-offer resources you do not hold');
      offer.counter = { give: move.give, get: move.get };
      events.push(ev('offer_countered', { id: offer.id, by: player, give: move.give, get: move.get }));
      return finish();
    }
    return err('offer_pending', 'a trade offer is pending; accept, reject, or counter it');
  }

  if (player !== currentPlayer(s)) return err('not_your_turn', `${player} is not the current player`);
  const hand = s.hands[player]!;
  const supply = s.supply[player]!;

  switch (move.type) {
    case 'build_road': {
      if ((supply['roads'] ?? 0) < 1) return err('no_supply', 'no roads left in supply');
      if (!holds(hand, COST_ROAD)) return err('cannot_pay', 'road costs 1 palm + 1 coral');
      if (!isEdgeId(move.edge)) return err('bad_edge', `unknown edge ${move.edge}`);
      if (!edgeOpenForRoad(s, player, move.edge)) return err('bad_placement', `edge ${move.edge} is occupied or unconnected`);
      payToBank(s, player, COST_ROAD);
      s.roads[move.edge] = player;
      supply['roads'] = (supply['roads'] ?? 0) - 1;
      events.push(ev('built', { player, kind: 'road', at: move.edge }));
      updateLongestRoad(s, events);
      return finish();
    }
    case 'build_village': {
      if ((supply['villages'] ?? 0) < 1) return err('no_supply', 'no villages left in supply');
      if (!holds(hand, COST_VILLAGE)) return err('cannot_pay', 'village costs palm + coral + reed + taro');
      if (!isVertexId(move.vertex)) return err('bad_vertex', `unknown vertex ${move.vertex}`);
      if (!vertexOpenForVillage(s, move.vertex)) return err('distance_rule', `vertex ${move.vertex} is occupied or adjacent to a building`);
      if (!VERTEX_EDGES[move.vertex]!.some((e) => s.roads[e] === player)) {
        return err('bad_placement', `vertex ${move.vertex} does not touch one of your roads`);
      }
      payToBank(s, player, COST_VILLAGE);
      s.villages[move.vertex] = player;
      supply['villages'] = (supply['villages'] ?? 0) - 1;
      events.push(ev('built', { player, kind: 'village', at: move.vertex }));
      updateLongestRoad(s, events); // a new village can break an opponent's road
      return finish();
    }
    case 'build_city': {
      if ((supply['cities'] ?? 0) < 1) return err('no_supply', 'no cities left in supply');
      if (!holds(hand, COST_CITY)) return err('cannot_pay', 'city costs 2 taro + 3 obsidian');
      if (s.villages[move.vertex] !== player) return err('bad_placement', `no village of yours at ${move.vertex}`);
      payToBank(s, player, COST_CITY);
      delete s.villages[move.vertex];
      s.cities[move.vertex] = player;
      supply['cities'] = (supply['cities'] ?? 0) - 1;
      supply['villages'] = (supply['villages'] ?? 0) + 1;
      events.push(ev('built', { player, kind: 'city', at: move.vertex }));
      return finish();
    }
    case 'buy_progress': {
      if (s.deck.length === 0) return err('deck_empty', 'the saga deck is empty');
      if (!holds(hand, COST_PROGRESS)) return err('cannot_pay', 'a saga card costs reed + taro + obsidian');
      payToBank(s, player, COST_PROGRESS);
      const card = s.deck[0]!;
      s.deck = s.deck.slice(1);
      s.bought[player]!.push(card);
      events.push(ev('bought_progress', { player, deckLeft: s.deck.length }));
      events.push(ev('bought_card', { player, card }, 'private', [player]));
      return finish();
    }
    case 'play_progress': {
      if (s.progressPlayed) return err('one_per_turn', 'only one saga card may be played per turn');
      if (!(PLAYABLE_CARDS as readonly string[]).includes(move.card)) {
        return err('bad_card', `'${move.card}' is not a playable saga card (landmarks reveal themselves at the win check)`);
      }
      const list = s.progress[player]!;
      const idx = list.indexOf(move.card);
      if (idx < 0) {
        if (s.bought[player]!.includes(move.card)) return err('bought_this_turn', 'cannot play a saga card bought this turn');
        return err('not_held', `you hold no ${move.card} card`);
      }
      switch (move.card) {
        case 'warrior': {
          const res = moveRaider(s, player, move.hex, move.victim, seed, events);
          if (res) return res;
          s.warriors[player] = (s.warriors[player] ?? 0) + 1;
          updateLargestArmy(s, player, events);
          break;
        }
        case 'pathfinder': {
          const edges = move.edges;
          if (!Array.isArray(edges) || edges.length < 1 || edges.length > 2) {
            return err('bad_move', 'pathfinder places 1 or 2 roads');
          }
          if ((supply['roads'] ?? 0) < edges.length) return err('no_supply', 'not enough roads in supply');
          if (edges.length === 1) {
            // a single placement is only legal when no pair exists
            const pairPossible = pathfinderMoves(s, player).some(
              (m) => m.type === 'play_progress' && m.card === 'pathfinder' && m.edges.length === 2,
            );
            if (pairPossible) return err('must_place_two', 'pathfinder must place two roads when possible');
          }
          for (const e of edges) {
            if (!isEdgeId(e)) return err('bad_edge', `unknown edge ${e}`);
            if (!edgeOpenForRoad(s, player, e)) return err('bad_placement', `edge ${e} is occupied or unconnected`);
            s.roads[e] = player;
            supply['roads'] = (supply['roads'] ?? 0) - 1;
            events.push(ev('built', { player, kind: 'road', at: e }));
          }
          updateLongestRoad(s, events);
          break;
        }
        case 'bounty': {
          if (!validMultiset(move.take)) return err('bad_move', 'bounty names 1-2 bank resources');
          const total = msTotal(move.take);
          let bankTotal = 0;
          for (const r of RESOURCES) bankTotal += s.bank[r] ?? 0;
          const wanted = bankTotal >= 2 ? 2 : 1;
          if (total !== wanted) return err('bad_move', `bounty takes exactly ${wanted} resource(s) now`);
          for (const [r, c] of msEntries(move.take)) {
            if ((s.bank[r] ?? 0) < c) return err('bank_short', `bank has no ${r}`);
          }
          for (const [r, c] of msEntries(move.take)) gainFromBank(s, player, r, c);
          events.push(ev('played_progress', { player, card: 'bounty', take: move.take }));
          break;
        }
        case 'tithe': {
          const res = move.resource as Resource;
          if (!(RESOURCES as readonly string[]).includes(res)) return err('bad_move', `unknown resource ${move.resource}`);
          const collected: Record<string, number> = {};
          for (const q of s.players) {
            if (q === player) continue;
            const c = s.hands[q]![res] ?? 0;
            if (c > 0) {
              s.hands[q]![res] = 0;
              hand[res] = (hand[res] ?? 0) + c;
              collected[q] = c;
            }
          }
          events.push(ev('played_progress', { player, card: 'tithe', resource: res, collected }));
          break;
        }
      }
      list.splice(idx, 1);
      s.progressPlayed = true;
      if (move.card === 'warrior' || move.card === 'pathfinder') {
        events.push(ev('played_progress', { player, card: move.card }));
      }
      return finish();
    }
    case 'trade_bank': {
      const give = move.give as Resource;
      const get = move.get as Resource;
      if (!(RESOURCES as readonly string[]).includes(give) || !(RESOURCES as readonly string[]).includes(get)) {
        return err('bad_move', 'trade_bank needs two resource names');
      }
      if (give === get) return err('bad_move', 'cannot trade a resource for itself');
      const rate = bankRate(s, player, give);
      if ((hand[give] ?? 0) < rate) return err('cannot_pay', `bank rate for ${give} is ${rate}:1`);
      if ((s.bank[get] ?? 0) < 1) return err('bank_short', `bank has no ${get}`);
      hand[give] = (hand[give] ?? 0) - rate;
      s.bank[give] = (s.bank[give] ?? 0) + rate;
      gainFromBank(s, player, get, 1);
      events.push(ev('trade', { kind: 'bank', player, give, rate, get }));
      return finish();
    }
    case 'offer': {
      if (s.offersMade >= 3) return err('offer_limit', 'at most 3 offers per player per turn');
      if (!s.players.includes(move.to) || move.to === player) return err('bad_move', `cannot offer to ${move.to}`);
      if (!offerShapeOk(move.give, move.get)) return err('bad_offer', 'offer give/get must each total 1-2 (combined at most 3) with no shared resource');
      if (!holds(hand, move.give)) return err('not_held', 'cannot offer resources you do not hold');
      s.offer = { id: s.nextOfferId, from: player, to: move.to, give: move.give, get: move.get, counter: null };
      s.nextOfferId++;
      s.offersMade++;
      events.push(ev('offer_made', { id: s.offer.id, from: player, to: move.to, give: move.give, get: move.get }));
      return finish();
    }
    case 'end_turn': {
      // cards bought this turn become playable
      const boughtNow = s.bought[player]!;
      if (boughtNow.length > 0) {
        s.progress[player] = [...s.progress[player]!, ...boughtNow];
        s.bought[player] = [];
      }
      s.progressPlayed = false;
      s.offersMade = 0;
      s.turn++;
      s.currentSeat = (s.turn - 1) % n;
      events.push(ev('turn_end', { player, nextTurn: s.turn }));
      if (s.turn > ROUND_LIMIT * n) {
        s.phase = 'over';
        return finish();
      }
      beginTurn(s, seed, events);
      return finish();
    }
    case 'accept':
    case 'reject':
    case 'counter':
      return err('no_offer', 'no trade offer is pending');
    case 'move_bandit':
      return err('bad_phase', 'the raider moves only after a 7 (or via a warrior card)');
    case 'discard':
      return err('bad_phase', 'no discard is due');
  }
  /* c8 ignore next */
  return err('bad_move', 'unrecognized move');
}

/** Shared raider relocation + steal for move_bandit and the warrior card. */
function moveRaider(
  s: IslState,
  player: string,
  hex: string,
  victim: string,
  seed: SeedStream,
  events: GameEvent[],
): RuleError | null {
  if (!LAND_LETTERS.includes(hex)) return err('bad_hex', `unknown hex ${hex}`);
  if (hex === s.raider) return err('bad_hex', 'the raider must move to a different hex');
  const victims = stealVictims(s, player, hex);
  if (victims.length === 0) {
    if (victim !== NO_VICTIM) return err('bad_victim', `no player can be robbed at ${hex}`);
  } else if (!victims.includes(victim)) {
    return err('bad_victim', `victim must be one of: ${victims.join(', ')}`);
  }
  s.raider = hex;
  events.push(ev('raider_moved', { player, hex }));
  if (victim !== NO_VICTIM) stealCard(s, player, victim, seed, events);
  return null;
}

// ---------------------------------------------------------------------------
// Hidden-information probes (gate A10) and shared secret-line formatting
// ---------------------------------------------------------------------------

/** Exact line renderText prints for the owner's hand — used as a leak probe. */
export function secretHandLine(p: string, hand: Hand): string {
  const parts = msEntries(hand).map(([r, c]) => `${c} ${r}`);
  return `Hand (${p}): ${parts.length > 0 ? parts.join(', ') : '(empty)'}`;
}

/** Exact line renderText prints for the owner's unplayed saga cards. */
export function secretCardsLine(p: string, progress: string[], bought: string[]): string {
  const held = progress.length > 0 ? progress.join(', ') : '(none)';
  const boughtStr = bought.length > 0 ? ` | bought this turn: ${bought.join(', ')}` : '';
  return `Saga cards (${p}): ${held}${boughtStr}`;
}

/**
 * Distinctive strings that would only appear if this player's hidden data
 * leaked: raw-state JSON fragments (keyed by the player id) for the hand and
 * unplayed cards, plus the exact render lines shown only to the owner.
 */
export function secretProbes(state: IslState, p: PlayerId): string[] {
  const probes: string[] = [];
  const hand = state.hands[p];
  const progress = state.progress[p] ?? [];
  const bought = state.bought[p] ?? [];
  if (hand) {
    probes.push(`"${p}":${JSON.stringify(sortedHand(hand))}`);
    if (handTotal(hand) > 0) probes.push(secretHandLine(p, hand));
  }
  if (progress.length > 0) probes.push(`"${p}":${JSON.stringify(progress)}`);
  if (progress.length > 0 || bought.length > 0) probes.push(secretCardsLine(p, progress, bought));
  return probes;
}

function sortedHand(hand: Hand): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(hand).sort()) out[k] = hand[k]!;
  return out;
}

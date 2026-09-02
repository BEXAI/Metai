/**
 * Landlord — static board data. An ORIGINAL property-trading board set in the
 * invented harbor city of Meridian Bay. All 40 spaces, 22 streets in 8 color
 * groups, 4 transit lines, 2 utilities, 2 tax spaces, 6 event spaces, and two
 * original 16-card event decks. Every name and card text here is invented for
 * Ludus (spec §project.intellectual_property_note): no trademarked names, no
 * published card text.
 *
 * Mechanics constants (salary 200, rent tables, 32 houses / 12 hotels, house
 * costs by board side) follow the familiar public mechanics; numbers are not
 * protected expression.
 */

export const SALARY = 200;
export const DETENTION_FINE = 50;
export const HOUSE_SUPPLY = 32;
export const HOTEL_SUPPLY = 12;
export const BID_STEP = 10;
export const AUCTION_MAX_ROUNDS = 3;
export const MAX_OFFERS_PER_TURN = 3;
export const MAX_NOTE_CHARS = 280;

export type SpaceKind =
  | 'start'
  | 'detention'
  | 'free_rest'
  | 'go_to_detention'
  | 'street'
  | 'transit'
  | 'utility'
  | 'tax'
  | 'event_a'
  | 'event_b';

export interface Space {
  idx: number;
  kind: SpaceKind;
  name: string;
  /** Property id (streets/transit/utilities only). */
  prop?: string;
  /** Color group id for streets. */
  group?: string;
  /** List price (streets/transit/utilities). */
  price?: number;
  /** Tax amount for tax spaces. */
  tax?: number;
}

export interface StreetDef {
  id: string;
  name: string;
  group: string;
  idx: number;
  price: number;
  /** rent[0] unimproved, rent[1..4] houses, rent[5] hotel. */
  rent: [number, number, number, number, number, number];
  houseCost: number;
}

export interface GroupDef {
  id: string;
  label: string;
  streets: string[]; // street ids in board order
}

const S = (
  id: string,
  name: string,
  group: string,
  idx: number,
  price: number,
  rent: [number, number, number, number, number, number],
  houseCost: number,
): StreetDef => ({ id, name, group, idx, price, rent, houseCost });

export const STREETS: readonly StreetDef[] = [
  S('cinder', 'Cinder Lane', 'umber', 1, 60, [2, 10, 30, 90, 160, 250], 50),
  S('mudlark', 'Mudlark Alley', 'umber', 3, 60, [4, 20, 60, 180, 320, 450], 50),
  S('foghorn', 'Foghorn Row', 'sky', 6, 100, [6, 30, 90, 270, 400, 550], 50),
  S('brine', 'Brine Street', 'sky', 8, 100, [6, 30, 90, 270, 400, 550], 50),
  S('gullwing', 'Gullwing Way', 'sky', 9, 120, [8, 40, 100, 300, 450, 600], 50),
  S('lantern', 'Lantern Court', 'rose', 11, 140, [10, 50, 150, 450, 625, 750], 100),
  S('coopers', "Cooper's Bend", 'rose', 13, 140, [10, 50, 150, 450, 625, 750], 100),
  S('saltworks', 'Saltworks Road', 'rose', 14, 160, [12, 60, 180, 500, 700, 900], 100),
  S('quarry', 'Quarry Street', 'amber', 16, 180, [14, 70, 200, 550, 750, 950], 100),
  S('millrace', 'Millrace Avenue', 'amber', 18, 180, [14, 70, 200, 550, 750, 950], 100),
  S('ironmonger', 'Ironmonger Row', 'amber', 19, 200, [16, 80, 220, 600, 800, 1000], 100),
  S('beaconhill', 'Beacon Hill Drive', 'crimson', 21, 220, [18, 90, 250, 700, 875, 1050], 150),
  S('weathervane', 'Weathervane Walk', 'crimson', 23, 220, [18, 90, 250, 700, 875, 1050], 150),
  S('clocktower', 'Clocktower Parade', 'crimson', 24, 240, [20, 100, 300, 750, 925, 1100], 150),
  S('halyard', 'Halyard Terrace', 'gold', 26, 260, [22, 110, 330, 800, 975, 1150], 150),
  S('spyglass', 'Spyglass Esplanade', 'gold', 27, 260, [22, 110, 330, 800, 975, 1150], 150),
  S('compassrose', 'Compass Rose Court', 'gold', 29, 280, [24, 120, 360, 850, 1025, 1200], 150),
  S('argent', 'Argent Heights', 'jade', 31, 300, [26, 130, 390, 900, 1100, 1275], 200),
  S('velvet', 'Velvet Orchard Lane', 'jade', 32, 300, [26, 130, 390, 900, 1100, 1275], 200),
  S('marble', 'Marble Arcade', 'jade', 34, 320, [28, 150, 450, 1000, 1200, 1400], 200),
  S('zephyr', 'Zephyr Promenade', 'violet', 37, 350, [35, 175, 500, 1100, 1300, 1500], 200),
  S('aurora', 'Aurora Summit', 'violet', 39, 400, [50, 200, 600, 1400, 1700, 2000], 200),
];

export const GROUPS: readonly GroupDef[] = [
  { id: 'umber', label: 'Umber', streets: ['cinder', 'mudlark'] },
  { id: 'sky', label: 'Sky', streets: ['foghorn', 'brine', 'gullwing'] },
  { id: 'rose', label: 'Rose', streets: ['lantern', 'coopers', 'saltworks'] },
  { id: 'amber', label: 'Amber', streets: ['quarry', 'millrace', 'ironmonger'] },
  { id: 'crimson', label: 'Crimson', streets: ['beaconhill', 'weathervane', 'clocktower'] },
  { id: 'gold', label: 'Gold', streets: ['halyard', 'spyglass', 'compassrose'] },
  { id: 'jade', label: 'Jade', streets: ['argent', 'velvet', 'marble'] },
  { id: 'violet', label: 'Violet', streets: ['zephyr', 'aurora'] },
];

export interface TransitDef {
  id: string;
  name: string;
  idx: number;
  price: number;
}

export const TRANSITS: readonly TransitDef[] = [
  { id: 'north_spur', name: 'North Spur Rail', idx: 5, price: 200 },
  { id: 'east_quay', name: 'East Quay Ferry', idx: 15, price: 200 },
  { id: 'south_loop', name: 'South Loop Tram', idx: 25, price: 200 },
  { id: 'west_ridge', name: 'West Ridge Cable', idx: 35, price: 200 },
];

/** Rent by number of transit lines the owner holds (1..4). */
export const TRANSIT_RENT = [0, 25, 50, 100, 200] as const;

export interface UtilityDef {
  id: string;
  name: string;
  idx: number;
  price: number;
}

export const UTILITIES: readonly UtilityDef[] = [
  { id: 'dynamo', name: 'Dynamo Power Co.', idx: 12, price: 150 },
  { id: 'aqueduct', name: 'Aqueduct Trust', idx: 28, price: 150 },
];

/** Utility rent = dice total x 4 (one owned) or x 10 (both owned). */
export const UTILITY_MULT = [0, 4, 10] as const;

// ---------------------------------------------------------------------------
// The 40-space track
// ---------------------------------------------------------------------------

function buildBoard(): Space[] {
  const board: Space[] = [];
  const put = (s: Space): void => {
    board[s.idx] = s;
  };
  put({ idx: 0, kind: 'start', name: 'Launch Pier' });
  put({ idx: 2, kind: 'event_b', name: 'Town Ledger' });
  put({ idx: 4, kind: 'tax', name: 'Assessment Levy', tax: 200 });
  put({ idx: 7, kind: 'event_a', name: 'Dispatches' });
  put({ idx: 10, kind: 'detention', name: 'Detention Yard' });
  put({ idx: 17, kind: 'event_b', name: 'Town Ledger' });
  put({ idx: 20, kind: 'free_rest', name: 'Rest Green' });
  put({ idx: 22, kind: 'event_a', name: 'Dispatches' });
  put({ idx: 30, kind: 'go_to_detention', name: "Constable's Order" });
  put({ idx: 33, kind: 'event_b', name: 'Town Ledger' });
  put({ idx: 36, kind: 'event_a', name: 'Dispatches' });
  put({ idx: 38, kind: 'tax', name: 'Upkeep Levy', tax: 100 });
  for (const st of STREETS) {
    put({ idx: st.idx, kind: 'street', name: st.name, prop: st.id, group: st.group, price: st.price });
  }
  for (const t of TRANSITS) {
    put({ idx: t.idx, kind: 'transit', name: t.name, prop: t.id, price: t.price });
  }
  for (const u of UTILITIES) {
    put({ idx: u.idx, kind: 'utility', name: u.name, prop: u.id, price: u.price });
  }
  if (board.length !== 40) throw new Error('board must have 40 spaces');
  for (let i = 0; i < 40; i++) if (!board[i]) throw new Error(`missing space ${i}`);
  return board;
}

export const BOARD: readonly Space[] = buildBoard();

export const STREET_BY_ID: ReadonlyMap<string, StreetDef> = new Map(STREETS.map((s) => [s.id, s]));
export const GROUP_BY_ID: ReadonlyMap<string, GroupDef> = new Map(GROUPS.map((g) => [g.id, g]));
export const TRANSIT_BY_ID: ReadonlyMap<string, TransitDef> = new Map(TRANSITS.map((t) => [t.id, t]));
export const UTILITY_BY_ID: ReadonlyMap<string, UtilityDef> = new Map(UTILITIES.map((u) => [u.id, u]));

/** All property ids in board order (streets + transit + utilities). */
export const ALL_PROPS: readonly string[] = BOARD.filter((s) => s.prop !== undefined).map((s) => s.prop!);

export function propPrice(id: string): number {
  return STREET_BY_ID.get(id)?.price ?? TRANSIT_BY_ID.get(id)?.price ?? UTILITY_BY_ID.get(id)?.price ?? 0;
}

export function propName(id: string): string {
  return STREET_BY_ID.get(id)?.name ?? TRANSIT_BY_ID.get(id)?.name ?? UTILITY_BY_ID.get(id)?.name ?? id;
}

export function mortgageValue(id: string): number {
  return Math.floor(propPrice(id) / 2);
}

/** Unmortgage cost: mortgage value plus 10% interest, rounded up. */
export function unmortgageCost(id: string): number {
  const m = mortgageValue(id);
  return m + Math.ceil(m / 10);
}

/** 10% fee (rounded up) paid when a mortgaged property changes hands. */
export function transferFee(id: string): number {
  return Math.ceil(mortgageValue(id) / 10);
}

// ---------------------------------------------------------------------------
// Event decks — original card text. Deck A 'Harbormaster Dispatches'
// (movement-flavored), Deck B 'Town Ledger Notices' (money-flavored).
// Exactly one escape writ and one go-to-detention card per deck.
// ---------------------------------------------------------------------------

export type CardEffect =
  | { k: 'advance_to'; idx: number } // forward to space, salary when crossing start
  | { k: 'advance_nearest'; which: 'transit' | 'utility' } // special rent rules
  | { k: 'back'; n: number }
  | { k: 'go_detention' }
  | { k: 'collect'; amount: number }
  | { k: 'pay'; amount: number }
  | { k: 'pay_each'; amount: number }
  | { k: 'collect_each'; amount: number }
  | { k: 'repairs'; perHouse: number; perHotel: number }
  | { k: 'writ' };

export interface CardDef {
  id: string;
  title: string;
  text: string;
  effect: CardEffect;
}

export const DECK_A: readonly CardDef[] = [
  { id: 'evA01', title: 'Express to Launch Pier', text: 'Ride the express straight to Launch Pier and collect the full salary.', effect: { k: 'advance_to', idx: 0 } },
  { id: 'evA02', title: 'Summons to Clocktower Parade', text: 'The magistrate expects you. Advance to Clocktower Parade.', effect: { k: 'advance_to', idx: 24 } },
  { id: 'evA03', title: 'Priority Freight', text: 'Advance to the nearest transit line. If it is owned, pay the operator double the usual fare.', effect: { k: 'advance_nearest', which: 'transit' } },
  { id: 'evA04', title: 'Works Inspection', text: 'Advance to the nearest utility. If it is owned, roll the dice and pay the holder ten times the roll.', effect: { k: 'advance_nearest', which: 'utility' } },
  { id: 'evA05', title: "Harbormaster's Bonus", text: 'The harbormaster commends your seamanship. Collect 50.', effect: { k: 'collect', amount: 50 } },
  { id: 'evA06', title: 'Release Writ', text: 'This writ frees you from the Detention Yard. Keep it until used or traded.', effect: { k: 'writ' } },
  { id: 'evA07', title: 'Back Three Berths', text: 'A shifting tide carries you back three spaces.', effect: { k: 'back', n: 3 } },
  { id: 'evA08', title: "Constable's Writ", text: 'Report directly to the Detention Yard. Do not cross Launch Pier; collect no salary.', effect: { k: 'go_detention' } },
  { id: 'evA09', title: 'Dredging Assessment', text: 'The channel must be dredged. Pay 25 per house and 100 per hotel you own.', effect: { k: 'repairs', perHouse: 25, perHotel: 100 } },
  { id: 'evA10', title: 'Speeding Skiff Fine', text: 'Caught racing in the harbor lanes. Pay a fine of 15.', effect: { k: 'pay', amount: 15 } },
  { id: 'evA11', title: 'Ride the North Spur', text: 'Take the rails north. Advance to North Spur Rail.', effect: { k: 'advance_to', idx: 5 } },
  { id: 'evA12', title: 'Gala at Lantern Court', text: 'You are invited to the lantern-lighting gala. Advance to Lantern Court.', effect: { k: 'advance_to', idx: 11 } },
  { id: 'evA13', title: 'Elected Pier Warden', text: 'Your new office comes with obligations. Pay each other player 50.', effect: { k: 'pay_each', amount: 50 } },
  { id: 'evA14', title: 'Loan Note Matures', text: 'Your harbor bond matures. Collect 150.', effect: { k: 'collect', amount: 150 } },
  { id: 'evA15', title: 'Ascent to Aurora Summit', text: 'Take the cable car all the way up. Advance to Aurora Summit.', effect: { k: 'advance_to', idx: 39 } },
  { id: 'evA16', title: 'Crosswind Detour', text: 'Contrary winds push you to Rest Green. Advance there and catch your breath.', effect: { k: 'advance_to', idx: 20 } },
];

export const DECK_B: readonly CardDef[] = [
  { id: 'evB01', title: 'Municipal Grant', text: 'The town council funds your civic works. Collect 200.', effect: { k: 'collect', amount: 200 } },
  { id: 'evB02', title: "Clerk's Error in Your Favor", text: 'A ledger slip breaks your way. Collect 75.', effect: { k: 'collect', amount: 75 } },
  { id: 'evB03', title: "Physician's Invoice", text: 'The dockside physician bills you. Pay 50.', effect: { k: 'pay', amount: 50 } },
  { id: 'evB04', title: 'Sale of Surplus Stock', text: 'Your warehouse overstock finds a buyer. Collect 45.', effect: { k: 'collect', amount: 45 } },
  { id: 'evB05', title: 'Release Writ', text: 'This writ frees you from the Detention Yard. Keep it until used or traded.', effect: { k: 'writ' } },
  { id: 'evB06', title: "Constable's Writ", text: 'Report directly to the Detention Yard. Do not cross Launch Pier; collect no salary.', effect: { k: 'go_detention' } },
  { id: 'evB07', title: 'Harvest Festival Prize', text: 'Your pumpkin takes first prize. Collect 100.', effect: { k: 'collect', amount: 100 } },
  { id: 'evB08', title: 'Overdue Ledger Fine', text: 'The archive wants its ledgers back. Pay 20.', effect: { k: 'pay', amount: 20 } },
  { id: 'evB09', title: 'Bequest from a Distant Aunt', text: 'A relative you barely remember remembers you. Collect 100.', effect: { k: 'collect', amount: 100 } },
  { id: 'evB10', title: 'Street Repairs', text: 'The cobbles need relaying. Pay 40 per house and 115 per hotel you own.', effect: { k: 'repairs', perHouse: 40, perHotel: 115 } },
  { id: 'evB11', title: 'Insurance Premium Due', text: 'Your warehouse policy renews. Pay 100.', effect: { k: 'pay', amount: 100 } },
  { id: 'evB12', title: 'Consulting Fee', text: 'Your advice on moorings is valued. Collect 25.', effect: { k: 'collect', amount: 25 } },
  { id: 'evB13', title: 'Founding Day Collection', text: 'It is your founding day. Collect 10 from each other player.', effect: { k: 'collect_each', amount: 10 } },
  { id: 'evB14', title: 'Levy Rebate', text: 'The assessor overcharged you last season. Collect 20.', effect: { k: 'collect', amount: 20 } },
  { id: 'evB15', title: 'Second Prize in the Regatta', text: 'Your sloop places second. Collect 10.', effect: { k: 'collect', amount: 10 } },
  { id: 'evB16', title: 'Return to Launch Pier', text: 'Business calls you home. Advance to Launch Pier and collect the salary.', effect: { k: 'advance_to', idx: 0 } },
];

export const CARD_BY_ID: ReadonlyMap<string, CardDef> = new Map([...DECK_A, ...DECK_B].map((c) => [c.id, c]));

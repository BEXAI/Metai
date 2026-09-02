import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  isTerminal,
  legalMoves,
  longestRoadLength,
  victoryPoints,
  type IslState,
} from '../rules.ts';
import { craft, freshSeed, give, mustApply, mustReject, placeCity, placeRoad, placeVillage, seatPlayers } from './helpers.ts';

// The 6-cycle of edges around center hex J: EFJ -FJ- FJK -JK- JKO -JO- JNO -JN- IJN -IJ- EIJ -EJ- EFJ
const J_RING = ['FJ', 'JK', 'JO', 'JN', 'IJ', 'EJ'];
// The 6-cycle around hex R (south): ORS -OR- NOR -NR- NQR -QR- QRp -Rp- Rpq -Rq- RSq -RS- ORS
const R_RING = ['OR', 'NR', 'QR', 'Rp', 'Rq', 'RS'];

describe('islanders longest road', () => {
  it('measures the longest trail, cut by opponent buildings', () => {
    const s = craft(3);
    for (const e of J_RING.slice(0, 5)) placeRoad(s, e, 'p0');
    expect(longestRoadLength(s, 'p0')).toBe(5);
    expect(longestRoadLength(s, 'p1')).toBe(0);
    // full ring counts 6 (a loop is a legal trail)
    placeRoad(s, 'EJ', 'p0');
    expect(longestRoadLength(s, 'p0')).toBe(6);
    // an opponent village mid-path cuts the trail
    const cut = craft(3);
    for (const e of J_RING.slice(0, 5)) placeRoad(cut, e, 'p0');
    cut.villages['JKO'] = 'p1'; // between JK and JO
    expect(longestRoadLength(cut, 'p0')).toBe(3);
    // the player's own building does not cut it
    const own = craft(3);
    for (const e of J_RING.slice(0, 5)) placeRoad(own, e, 'p0');
    own.villages['JKO'] = 'p0';
    expect(longestRoadLength(own, 'p0')).toBe(5);
  });

  it('first to 5 takes the bonus; a tie retains the holder; strictly longer transfers it', () => {
    let s = craft(3);
    for (const e of J_RING.slice(0, 4)) placeRoad(s, e, 'p0');
    for (const e of R_RING.slice(0, 4)) placeRoad(s, e, 'p1');
    give(s, 'p0', { palm: 1, coral: 1 });
    give(s, 'p1', { palm: 2, coral: 2 });
    // p0 builds the 5th road -> takes longest road (+2 VP)
    s = mustApply(s, 'p0', { type: 'build_road', edge: 'IJ' });
    expect(s.longestRoadHolder).toBe('p0');
    expect(victoryPoints(s, 'p0', true)).toBe(2);
    // p1 reaches 5 too -> tie, p0 retains
    s.currentSeat = 1;
    s = mustApply(s, 'p1', { type: 'build_road', edge: 'Rq' });
    expect(longestRoadLength(s, 'p1')).toBe(5);
    expect(s.longestRoadHolder).toBe('p0');
    // p1 reaches 6 -> strictly longer, transfers
    s = mustApply(s, 'p1', { type: 'build_road', edge: 'RS' });
    expect(s.longestRoadHolder).toBe('p1');
    expect(victoryPoints(s, 'p0', true)).toBe(0);
    expect(victoryPoints(s, 'p1', true)).toBe(2);
  });

  it('a village that breaks the road removes or transfers the bonus', () => {
    // set-aside case: holder drops below 5, nobody else qualifies
    let s = craft(3);
    for (const e of J_RING.slice(0, 5)) placeRoad(s, e, 'p0');
    s.longestRoadHolder = 'p0';
    placeRoad(s, 'KO', 'p2'); // p2 road touching vertex JKO
    give(s, 'p2', { palm: 1, coral: 1, reed: 1, taro: 1 });
    s.currentSeat = 2;
    s = mustApply(s, 'p2', { type: 'build_village', vertex: 'JKO' });
    expect(longestRoadLength(s, 'p0')).toBe(3);
    expect(s.longestRoadHolder).toBeNull();
    // transfer case: another player already has 5+
    let t = craft(3);
    for (const e of J_RING.slice(0, 5)) placeRoad(t, e, 'p0');
    for (const e of R_RING.slice(0, 5)) placeRoad(t, e, 'p1');
    t.longestRoadHolder = 'p0';
    placeRoad(t, 'KO', 'p2');
    give(t, 'p2', { palm: 1, coral: 1, reed: 1, taro: 1 });
    t.currentSeat = 2;
    t = mustApply(t, 'p2', { type: 'build_village', vertex: 'JKO' });
    expect(t.longestRoadHolder).toBe('p1');
  });
});

describe('islanders largest army', () => {
  it('3+ warriors takes it; ties retain; strictly more transfers', () => {
    let s = craft(3);
    s.progress['p0'] = ['warrior'];
    s.progress['p1'] = ['warrior', 'warrior'];
    s.warriors['p0'] = 2;
    s.warriors['p1'] = 2;
    s = mustApply(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' });
    expect(s.warriors['p0']).toBe(3);
    expect(s.largestArmyHolder).toBe('p0');
    expect(victoryPoints(s, 'p0', true)).toBe(2);
    // p1 ties at 3: p0 retains
    s.currentSeat = 1;
    s.progressPlayed = false;
    s = mustApply(s, 'p1', { type: 'play_progress', card: 'warrior', hex: 'C', victim: '-' });
    expect(s.warriors['p1']).toBe(3);
    expect(s.largestArmyHolder).toBe('p0');
    // p1 reaches 4: transfers
    s.progressPlayed = false;
    s = mustApply(s, 'p1', { type: 'play_progress', card: 'warrior', hex: 'D', victim: '-' });
    expect(s.largestArmyHolder).toBe('p1');
    expect(victoryPoints(s, 'p1', true)).toBe(2);
    expect(victoryPoints(s, 'p0', true)).toBe(0);
  });

  it('two warriors are not an army', () => {
    let s = craft(3);
    s.progress['p0'] = ['warrior'];
    s.warriors['p0'] = 1;
    s = mustApply(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' });
    expect(s.warriors['p0']).toBe(2);
    expect(s.largestArmyHolder).toBeNull();
  });
});

describe('islanders win and turn-limit checks', () => {
  function tenPointState(): IslState {
    const s = craft(3);
    placeVillage(s, 'Aab', 'p2');
    placeVillage(s, 'Hgi', 'p2');
    placeVillage(s, 'Snr', 'p2');
    placeVillage(s, 'EFJ', 'p2');
    placeCity(s, 'JNO', 'p2');
    placeCity(s, 'MNQ', 'p2');
    placeCity(s, 'BCc', 'p2'); // 4 + 6 = 10 VP
    return s;
  }

  it('10 VP wins only on the winner own turn', () => {
    const s = tenPointState();
    expect(victoryPoints(s, 'p2', true)).toBe(10);
    s.currentSeat = 0;
    expect(isTerminal(s)).toBeNull(); // not p2's turn
    s.currentSeat = 1;
    expect(isTerminal(s)).toBeNull();
    s.currentSeat = 2;
    const result = isTerminal(s);
    expect(result?.winners).toEqual(['p2']);
    expect(result?.draw).toBe(false);
    expect(result?.reason).toBe('points');
  });

  it('never terminal during setup', () => {
    const s = createInitialState(freshSeed('terminal-setup'), seatPlayers(3), {});
    expect(isTerminal(s)).toBeNull();
  });

  it('after 100 rounds the most VP wins, ties broken by resources held', () => {
    // 3 players -> the limit trips when turn 300 ends
    let s = craft(3, { turn: 300, currentSeat: 2 });
    placeVillage(s, 'Aab', 'p0');
    placeVillage(s, 'Hgi', 'p1');
    give(s, 'p0', { palm: 3 });
    give(s, 'p1', { reed: 5 });
    s = mustApply(s, 'p2', { type: 'end_turn' });
    expect(s.phase).toBe('over');
    expect(legalMoves(s, 'p0')).toEqual([]);
    const result = isTerminal(s);
    expect(result?.reason).toBe('turn_limit');
    expect(result?.winners).toEqual(['p1']); // 1 VP each, p1 holds more resources
    expect(result?.draw).toBe(false);
    expect(result?.scores).toEqual({ p0: 1, p1: 1, p2: 0 });
  });

  it('hidden landmarks are revealed and counted at the turn-limit check', () => {
    let s = craft(3, { turn: 300, currentSeat: 2 });
    placeVillage(s, 'Aab', 'p0');
    s.progress['p1'] = ['landmark', 'landmark'];
    s = mustApply(s, 'p2', { type: 'end_turn' });
    const result = isTerminal(s);
    expect(result?.winners).toEqual(['p1']);
    expect(result?.scores).toEqual({ p0: 1, p1: 2, p2: 0 });
  });

  it('a full tie at the turn limit is a shared draw', () => {
    let s = craft(3, { turn: 300, currentSeat: 2 });
    placeVillage(s, 'Aab', 'p0');
    placeVillage(s, 'Hgi', 'p1');
    give(s, 'p0', { palm: 2 });
    give(s, 'p1', { reed: 2 });
    s = mustApply(s, 'p2', { type: 'end_turn' });
    const result = isTerminal(s);
    expect(result?.winners).toEqual(['p0', 'p1']);
    expect(result?.draw).toBe(true);
  });

  it('the game does not end at exactly 100 rounds until the last turn ends', () => {
    const s = craft(3, { turn: 300, currentSeat: 2 });
    expect(isTerminal(s)).toBeNull(); // round 100 still being played
    expect(playersToMoveLen(s)).toBe(1);
  });
});

function playersToMoveLen(s: IslState): number {
  return legalMoves(s, 'p2').length > 0 ? 1 : 0;
}

describe('islanders main-phase building rules', () => {
  it('villages need a connecting road and the distance rule; cities need your village', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 5, coral: 5, reed: 5, taro: 5, obsidian: 5 });
    expect(mustReject(s, 'p0', { type: 'build_village', vertex: 'EFJ' })).toBe('bad_placement'); // no road
    placeRoad(s, 'FJ', 'p0');
    const built = mustApply(s, 'p0', { type: 'build_village', vertex: 'EFJ' });
    expect(mustReject(built, 'p0', { type: 'build_village', vertex: 'FJK' })).toBe('distance_rule');
    expect(mustReject(built, 'p0', { type: 'build_city', vertex: 'JNO' })).toBe('bad_placement');
    const city = mustApply(built, 'p0', { type: 'build_city', vertex: 'EFJ' });
    expect(city.cities['EFJ']).toBe('p0');
    expect(city.villages['EFJ']).toBeUndefined();
    expect(city.supply['p0']!['villages']).toBe(5); // village returned to supply
    expect(city.supply['p0']!['cities']).toBe(3);
    expect(victoryPoints(city, 'p0', true)).toBe(2);
  });

  it('roads must connect and cannot extend through an opponent building', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 5, coral: 5 });
    expect(mustReject(s, 'p0', { type: 'build_road', edge: 'FJ' })).toBe('bad_placement'); // nothing to connect to
    placeRoad(s, 'FJ', 'p0');
    // p1 village on FJK blocks p0 from continuing through that vertex
    placeVillage(s, 'FJK', 'p1');
    expect(mustReject(s, 'p0', { type: 'build_road', edge: 'JK' })).toBe('bad_placement');
    // ...but continuing from the other end works
    const ok = mustApply(s, 'p0', { type: 'build_road', edge: 'EJ' });
    expect(ok.roads['EJ']).toBe('p0');
    // building on an occupied edge fails
    expect(mustReject(ok, 'p0', { type: 'build_road', edge: 'FJ' })).toBe('bad_placement');
  });

  it('supply limits are enforced', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 5, coral: 5 });
    placeRoad(s, 'FJ', 'p0');
    s.supply['p0']!['roads'] = 0;
    expect(mustReject(s, 'p0', { type: 'build_road', edge: 'JK' })).toBe('no_supply');
    expect(legalMoves(s, 'p0').some((m) => m.type === 'build_road')).toBe(false);
  });
});

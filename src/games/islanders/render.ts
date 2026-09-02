/**
 * Islanders views and ASCII render. The public view carries counts only for
 * hands and unplayed saga cards; the private view adds the viewer's own hand
 * and cards. renderText draws the lettered hex schematic with the sea-letter
 * ring used for vertex/edge naming.
 */

import type { Json, PlayerId } from '../../kernel/types.ts';
import {
  HEX_COORDS,
  LAND_LETTERS,
  SEA_LETTERS,
  RESOURCES,
  currentPlayer,
  handTotal,
  roundOf,
  secretCardsLine,
  secretHandLine,
  victoryPoints,
  playersToMove,
  type IslState,
} from './rules.ts';

const TERRAIN_CODE: Record<string, string> = {
  grove: 'GRV',
  reef: 'REF',
  marsh: 'MAR',
  paddy: 'PAD',
  volcano: 'VOL',
  dunes: 'DUN',
};

function phaseLabel(s: IslState): string {
  if (s.phase === 'main' && s.offer) return 'trade_response';
  return s.phase;
}

export function publicView(s: IslState): Json {
  const handCounts: Record<string, number> = {};
  const progressCounts: Record<string, number> = {};
  const publicVp: Record<string, number> = {};
  for (const p of s.players) {
    handCounts[p] = handTotal(s.hands[p]!);
    progressCounts[p] = (s.progress[p]?.length ?? 0) + (s.bought[p]?.length ?? 0);
    publicVp[p] = victoryPoints(s, p, false);
  }
  return {
    layout: s.layout,
    terrain: s.terrain,
    tokens: s.tokens,
    harbors: s.harbors,
    raider: s.raider,
    villages: s.villages,
    cities: s.cities,
    roads: s.roads,
    handCounts,
    progressCounts,
    warriors: s.warriors,
    bank: s.bank,
    deckCount: s.deck.length,
    phase: phaseLabel(s),
    turn: s.turn,
    round: roundOf(s),
    currentPlayer: s.phase === 'setup' ? (playersToMove(s)[0] ?? null) : currentPlayer(s),
    toMove: playersToMove(s),
    lastRoll: s.lastRoll,
    lastMove: s.lastMove,
    discardDue: s.discardDue,
    offer: s.offer,
    offersMade: s.offersMade,
    progressPlayed: s.progressPlayed,
    longestRoadHolder: s.longestRoadHolder,
    largestArmyHolder: s.largestArmyHolder,
    supply: s.supply,
    publicVictoryPoints: publicVp,
  };
}

export function privateView(s: IslState, player: PlayerId): Json {
  const pub = publicView(s) as Record<string, Json>;
  return {
    ...pub,
    you: player,
    hand: { ...s.hands[player]! },
    progressCards: [...(s.progress[player] ?? [])],
    boughtThisTurn: [...(s.bought[player] ?? [])],
  };
}

// ---------------------------------------------------------------------------
// ASCII board
// ---------------------------------------------------------------------------

const CELL_W = 10;

function hexMap(s: IslState): string[] {
  // x position of a hex in cell units: q + r/2; min x across the 37 hexes is -3.
  const rows = new Map<number, { col: number; text: string }[]>();
  const place = (letter: string, text: string): void => {
    const c = HEX_COORDS[letter]!;
    const col = Math.round((c.q + c.r / 2 + 3) * CELL_W);
    const row = rows.get(c.r) ?? [];
    row.push({ col, text });
    rows.set(c.r, row);
  };
  for (const L of LAND_LETTERS) {
    const code = TERRAIN_CODE[s.terrain[L]!] ?? '???';
    const tok = s.tokens[L] !== undefined ? String(s.tokens[L]).padStart(2, '0') : '--';
    place(L, `${L}:${code}-${tok}${s.raider === L ? '*' : ' '}`);
  }
  for (const l of SEA_LETTERS) place(l, `~${l}~`);
  const lines: string[] = [];
  for (let r = -3; r <= 3; r++) {
    const cells = (rows.get(r) ?? []).sort((a, b) => a.col - b.col);
    let line = '';
    for (const cell of cells) {
      while (line.length < cell.col) line += ' ';
      line += cell.text;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function listByOwner(map: Record<string, string>, owner: string): string {
  const items = Object.keys(map)
    .filter((k) => map[k] === owner)
    .sort();
  return items.length > 0 ? items.join(',') : '-';
}

export function renderText(s: IslState, viewer: PlayerId | null): string {
  const lines: string[] = [];
  const toMove = playersToMove(s);
  lines.push(
    `Islanders | round ${roundOf(s)} turn ${s.turn} | phase: ${phaseLabel(s)} | to act: ${toMove.join(' ') || '-'}` +
      (s.lastRoll > 0 ? ` | last roll: ${s.lastRoll}` : ''),
  );
  if (s.lastMove) lines.push(`last move: ${s.lastMove}`);
  lines.push('');
  lines.push(...hexMap(s));
  lines.push('');
  lines.push('Vertices are the 3 letters of the hexes they touch (e.g. ABa); edges the 2 (e.g. AB, Aa).');
  lines.push(`Raider (*) on hex ${s.raider}. Sea hexes ~a~..~r~ exist only for naming coastal spots.`);
  const harborStr = Object.keys(s.harbors)
    .sort()
    .map((e) => `${e}=${s.harbors[e] === 'any' ? '3:1 any' : `2:1 ${s.harbors[e]}`}`)
    .join(' | ');
  lines.push(`Harbors: ${harborStr}`);
  lines.push('');
  for (const p of s.players) {
    const vp = victoryPoints(s, p, false);
    const cardCount = (s.progress[p]?.length ?? 0) + (s.bought[p]?.length ?? 0);
    lines.push(
      `${p}: ${handTotal(s.hands[p]!)} cards, ${cardCount} saga, warriors ${s.warriors[p] ?? 0}, VP(public) ${vp}` +
        ` | villages: ${listByOwner(s.villages, p)} | cities: ${listByOwner(s.cities, p)} | roads: ${listByOwner(s.roads, p)}`,
    );
  }
  lines.push('');
  lines.push(
    `Bank: ${RESOURCES.map((r) => `${r} ${s.bank[r] ?? 0}`).join(', ')} | saga deck: ${s.deck.length}` +
      ` | longest road: ${s.longestRoadHolder ?? '-'} | largest army: ${s.largestArmyHolder ?? '-'}`,
  );
  if (s.phase === 'discard') {
    const due = Object.keys(s.discardDue)
      .map((p) => `${p} owes ${s.discardDue[p]}`)
      .join(', ');
    lines.push(`Waiting on discards: ${due}`);
  }
  if (s.offer) {
    const o = s.offer;
    const ms = (m: Record<string, number>): string =>
      Object.keys(m)
        .sort()
        .map((k) => `${m[k]} ${k}`)
        .join(' + ');
    if (o.counter) {
      lines.push(
        `Offer #${o.id} countered: ${o.to} now gives ${ms(o.counter.give)} for ${ms(o.counter.get)} (awaiting ${o.from})`,
      );
    } else {
      lines.push(`Offer #${o.id}: ${o.from} gives ${ms(o.give)} for ${ms(o.get)} to ${o.to} (awaiting ${o.to})`);
    }
  }
  if (viewer !== null && s.players.includes(viewer)) {
    lines.push('');
    lines.push(secretHandLine(viewer, s.hands[viewer]!));
    lines.push(secretCardsLine(viewer, s.progress[viewer] ?? [], s.bought[viewer] ?? []));
  }
  lines.push('');
  lines.push('Legend: GRV grove->palm, REF reef->coral, MAR marsh->reed, PAD paddy->taro, VOL volcano->obsidian, DUN dunes->nothing.');
  lines.push('Costs: road=palm+coral | village=palm+coral+reed+taro | city=2 taro+3 obsidian | saga card=reed+taro+obsidian.');
  const status =
    s.phase === 'setup'
      ? `Status: setup — ${toMove[0] ?? '?'} places a ${s.setupMoves % 2 === 0 ? 'village' : 'road'}.`
      : s.phase === 'discard'
        ? 'Status: a 7 was rolled — players over 7 cards discard half (rounded down), all at once.'
        : s.phase === 'raider'
          ? `Status: ${toMove[0] ?? '?'} must move the raider (move_bandit).`
          : s.phase === 'over'
            ? 'Status: round limit reached — most victory points wins.'
            : s.offer
              ? `Status: trade offer pending — ${toMove[0] ?? '?'} must accept, reject, or counter.`
              : `Status: ${toMove[0] ?? '?'} may build, trade, play a saga card, or end_turn. First to 10 VP on their own turn wins.`;
  lines.push(status);
  return lines.join('\n');
}

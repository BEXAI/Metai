// Landlord: the 40-space perimeter board (spec: original board/names, familiar
// mechanics). Space names/positions/groups are static public board data —
// mirrors src/games/landlord/board.ts's BOARD/STREETS/TRANSITS/UTILITIES
// tables (property names and layout are not secret; only deck order is
// hidden) so tooltips can show real names instead of raw property ids.

import { makeSvg, rect, label, circle, svgEl, svgTitle } from './common.js';
import { clear } from '../dom.js';

const CELL = 48;
const GRID = 10; // 0..10 => 11x11 perimeter, 40 unique spaces

// idx -> { kind, name, prop?, group? }. Mirrors src/games/landlord/board.ts.
const SPACES = [
  { idx: 0, kind: 'start', name: 'Launch Pier' },
  { idx: 1, kind: 'street', name: 'Cinder Lane', prop: 'cinder', group: 'umber' },
  { idx: 2, kind: 'event_b', name: 'Town Ledger' },
  { idx: 3, kind: 'street', name: 'Mudlark Alley', prop: 'mudlark', group: 'umber' },
  { idx: 4, kind: 'tax', name: 'Assessment Levy' },
  { idx: 5, kind: 'transit', name: 'North Spur Rail', prop: 'north_spur' },
  { idx: 6, kind: 'street', name: 'Foghorn Row', prop: 'foghorn', group: 'sky' },
  { idx: 7, kind: 'event_a', name: 'Dispatches' },
  { idx: 8, kind: 'street', name: 'Brine Street', prop: 'brine', group: 'sky' },
  { idx: 9, kind: 'street', name: 'Gullwing Way', prop: 'gullwing', group: 'sky' },
  { idx: 10, kind: 'detention', name: 'Detention Yard' },
  { idx: 11, kind: 'street', name: 'Lantern Court', prop: 'lantern', group: 'rose' },
  { idx: 12, kind: 'utility', name: 'Dynamo Power Co.', prop: 'dynamo' },
  { idx: 13, kind: 'street', name: "Cooper's Bend", prop: 'coopers', group: 'rose' },
  { idx: 14, kind: 'street', name: 'Saltworks Road', prop: 'saltworks', group: 'rose' },
  { idx: 15, kind: 'transit', name: 'East Quay Ferry', prop: 'east_quay' },
  { idx: 16, kind: 'street', name: 'Quarry Street', prop: 'quarry', group: 'amber' },
  { idx: 17, kind: 'event_b', name: 'Town Ledger' },
  { idx: 18, kind: 'street', name: 'Millrace Avenue', prop: 'millrace', group: 'amber' },
  { idx: 19, kind: 'street', name: 'Ironmonger Row', prop: 'ironmonger', group: 'amber' },
  { idx: 20, kind: 'free_rest', name: 'Rest Green' },
  { idx: 21, kind: 'street', name: 'Beacon Hill Drive', prop: 'beaconhill', group: 'crimson' },
  { idx: 22, kind: 'event_a', name: 'Dispatches' },
  { idx: 23, kind: 'street', name: 'Weathervane Walk', prop: 'weathervane', group: 'crimson' },
  { idx: 24, kind: 'street', name: 'Clocktower Parade', prop: 'clocktower', group: 'crimson' },
  { idx: 25, kind: 'transit', name: 'South Loop Tram', prop: 'south_loop' },
  { idx: 26, kind: 'street', name: 'Halyard Terrace', prop: 'halyard', group: 'gold' },
  { idx: 27, kind: 'street', name: 'Spyglass Esplanade', prop: 'spyglass', group: 'gold' },
  { idx: 28, kind: 'utility', name: 'Aqueduct Trust', prop: 'aqueduct' },
  { idx: 29, kind: 'street', name: 'Compass Rose Court', prop: 'compassrose', group: 'gold' },
  { idx: 30, kind: 'go_to_detention', name: "Constable's Order" },
  { idx: 31, kind: 'street', name: 'Argent Heights', prop: 'argent', group: 'jade' },
  { idx: 32, kind: 'street', name: 'Velvet Orchard Lane', prop: 'velvet', group: 'jade' },
  { idx: 33, kind: 'event_b', name: 'Town Ledger' },
  { idx: 34, kind: 'street', name: 'Marble Arcade', prop: 'marble', group: 'jade' },
  { idx: 35, kind: 'transit', name: 'West Ridge Cable', prop: 'west_ridge' },
  { idx: 36, kind: 'event_a', name: 'Dispatches' },
  { idx: 37, kind: 'street', name: 'Zephyr Promenade', prop: 'zephyr', group: 'violet' },
  { idx: 38, kind: 'tax', name: 'Upkeep Levy' },
  { idx: 39, kind: 'street', name: 'Aurora Summit', prop: 'aurora', group: 'violet' },
];

function perimeterCell(i) {
  if (i < 10) return [GRID - i, GRID]; // bottom row, right -> left
  if (i < 20) return [0, GRID - (i - 10)]; // left column, bottom -> top
  if (i < 30) return [i - 20, 0]; // top row, left -> right
  return [GRID, i - 30]; // right column, top -> bottom
}

function seatOf(owner) {
  if (typeof owner !== 'string') return null;
  const m = /^p(\d+)$/.exec(owner);
  return m ? Number(m[1]) : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function render(container, view) {
  const props = pick(view, ['props']);
  const pos = pick(view, ['pos']);
  if (!props || typeof props !== 'object') return false;

  const size = (GRID + 1) * CELL;
  const svg = makeSvg(size, size, 'landlord-board');
  svg.appendChild(rect(0, 0, size, size, 'landlord-frame'));

  for (const space of SPACES) {
    const [col, row] = perimeterCell(space.idx);
    const x = col * CELL;
    const y = row * CELL;
    const group = svgEl('g');
    const cls = ['landlord-space', `kind-${space.kind}`];
    const owned = space.prop ? props[space.prop] : undefined;
    const ownerSeat = owned ? seatOf(owned.owner) : null;
    if (ownerSeat !== null) cls.push(`owner-seat-${ownerSeat}`);
    if (owned && owned.mortgaged) cls.push('landlord-mortgaged');
    group.appendChild(rect(x, y, CELL, CELL, cls.join(' ')));
    if (space.group) group.appendChild(rect(x, y, CELL, 8, `group-band group-${space.group}`));

    const tipParts = [space.name];
    if (space.group) tipParts.push(`group: ${space.group}`);
    if (owned) {
      tipParts.push(owned.owner ? `owner: ${owned.owner}` : 'unowned');
      if (owned.houses) tipParts.push(`houses: ${owned.houses}`);
      if (owned.mortgaged) tipParts.push('mortgaged');
    }
    group.appendChild(svgTitle(tipParts.join(' — ')));
    svg.appendChild(group);

    if (owned && owned.houses > 0) {
      svg.appendChild(label(x + CELL / 2, y + CELL - 6, owned.houses >= 5 ? 'H' : String(owned.houses), 'landlord-houses'));
    }
  }

  // Player tokens: small colored dots offset within their current space.
  if (pos && typeof pos === 'object') {
    const entries = Object.entries(pos);
    entries.forEach(([player, idx], i) => {
      const space = SPACES[idx];
      if (!space) return;
      const [col, row] = perimeterCell(space.idx);
      const seat = seatOf(player);
      const offset = (i % 4) * 9 - 13;
      const dot = circle(col * CELL + CELL / 2 + offset, row * CELL + CELL / 2 + offset, 6, `landlord-token piece-seat-${seat ?? 0}`);
      dot.appendChild(svgTitle(`${player} at ${space.name}`));
      svg.appendChild(dot);
    });
  }

  clear(container);
  container.appendChild(svg);
  return true;
}

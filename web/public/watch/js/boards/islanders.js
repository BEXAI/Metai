// Islanders: 19 land hexes (letters A-S) ringed by 18 sea hexes (a-r), axial
// coordinates generated with the EXACT same loop as
// src/games/islanders/rules.ts#buildGeometry, so hex letters land on the same
// positions the game engine uses. Vertex ids are 3 sorted hex letters and
// edge ids are 2; a vertex's pixel position is the centroid of its 3 hex
// centers (exact, for a regular hex grid), and an edge's segment is centered
// on the midpoint of its 2 hex centers, perpendicular to the line between
// them, one hex side-length long.
//
// view fields read (src/games/islanders/render.ts#publicView, a near-direct
// passthrough of IslState): terrain, tokens (Record<hexLetter,...>), raider
// (hex letter), villages, cities, roads (Record<vertexOrEdgeId, PlayerId>).

import { makeSvg, svgEl, label, svgTitle, circle } from './common.js';
import { clear } from '../dom.js';

const LAND_LETTERS = [...'ABCDEFGHIJKLMNOPQRS'];
const SEA_LETTERS = [...'abcdefghijklmnopqr'];
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const SIZE = 34;

function buildCoords() {
  const coords = {};
  let li = 0;
  for (let r = -2; r <= 2; r++) {
    const qMin = Math.max(-2, -r - 2);
    const qMax = Math.min(2, -r + 2);
    for (let q = qMin; q <= qMax; q++) coords[LAND_LETTERS[li++]] = { q, r };
  }
  let si = 0;
  for (let r = -3; r <= 3; r++) {
    const qMin = Math.max(-3, -r - 3);
    const qMax = Math.min(3, -r + 3);
    for (let q = qMin; q <= qMax; q++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3) {
        coords[SEA_LETTERS[si++]] = { q, r };
      }
    }
  }
  return coords;
}

const COORDS = buildCoords();

function hexCenter(letter) {
  const c = COORDS[letter];
  if (!c) return null;
  return [SIZE * Math.sqrt(3) * (c.q + c.r / 2), SIZE * 1.5 * c.r];
}

function hexPolygonPoints(cx, cy) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const deg = 60 * i - 30;
    const rad = (Math.PI / 180) * deg;
    pts.push(`${cx + SIZE * Math.cos(rad)},${cy + SIZE * Math.sin(rad)}`);
  }
  return pts.join(' ');
}

function seatOf(owner) {
  if (typeof owner !== 'string') return null;
  const m = /^p(\d+)$/.exec(owner);
  return m ? Number(m[1]) : null;
}

function centroid(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [xs.reduce((a, b) => a + b, 0) / points.length, ys.reduce((a, b) => a + b, 0) / points.length];
}

function vertexPixel(vertexId) {
  const centers = [...vertexId].map(hexCenter).filter(Boolean);
  if (centers.length === 0) return null;
  return centroid(centers);
}

function edgeSegment(edgeId) {
  const [a, b] = [...edgeId];
  const ca = hexCenter(a);
  const cb = hexCenter(b);
  if (!ca || !cb) return null;
  const mx = (ca[0] + cb[0]) / 2;
  const my = (ca[1] + cb[1]) / 2;
  const dx = cb[0] - ca[0];
  const dy = cb[1] - ca[1];
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const half = SIZE / 2;
  return [[mx - px * half, my - py * half], [mx + px * half, my + py * half]];
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function render(container, view) {
  const terrain = pick(view, ['terrain']);
  if (!terrain || typeof terrain !== 'object') return false;
  const tokens = pick(view, ['tokens']) || {};
  const villages = pick(view, ['villages']) || {};
  const cities = pick(view, ['cities']) || {};
  const roads = pick(view, ['roads']) || {};
  const raider = pick(view, ['raider']);

  const centers = LAND_LETTERS.map(hexCenter);
  const pad = SIZE * 2.5;
  const minX = Math.min(...centers.map((c) => c[0])) - pad;
  const minY = Math.min(...centers.map((c) => c[1])) - pad;
  const maxX = Math.max(...centers.map((c) => c[0])) + pad;
  const maxY = Math.max(...centers.map((c) => c[1])) + pad;

  const svg = makeSvg(maxX - minX, maxY - minY, 'islanders-board');
  const g = svgEl('g', { transform: `translate(${-minX},${-minY})` });
  svg.appendChild(g);

  for (const L of LAND_LETTERS) {
    const [cx, cy] = hexCenter(L);
    const terr = String(terrain[L] ?? 'unknown').toLowerCase();
    const group = svgEl('g');
    group.appendChild(svgEl('polygon', { points: hexPolygonPoints(cx, cy), class: `islanders-hex terrain-${terr}` }));
    const tok = tokens[L];
    if (tok !== undefined && tok !== null) group.appendChild(label(cx, cy + 5, String(tok), 'islanders-number'));
    if (raider === L) group.appendChild(circle(cx, cy, SIZE * 0.3, 'islanders-raider'));
    group.appendChild(svgTitle(`${L}: ${terr}${tok !== undefined ? ` (${tok})` : ''}${raider === L ? ' — raider here' : ''}`));
    g.appendChild(group);
  }

  for (const [edgeId, owner] of Object.entries(roads)) {
    const seg = edgeSegment(edgeId);
    const seat = seatOf(owner);
    if (!seg || seat === null) continue;
    const line = svgEl('line', {
      x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1],
      class: `islanders-road piece-seat-${seat}`,
    });
    line.appendChild(svgTitle(`road ${edgeId}: ${owner}`));
    g.appendChild(line);
  }

  for (const [vertexId, owner] of Object.entries(villages)) {
    const pos = vertexPixel(vertexId);
    const seat = seatOf(owner);
    if (!pos || seat === null) continue;
    const dot = circle(pos[0], pos[1], SIZE * 0.22, `islanders-village piece-seat-${seat}`);
    dot.appendChild(svgTitle(`village ${vertexId}: ${owner}`));
    g.appendChild(dot);
  }

  for (const [vertexId, owner] of Object.entries(cities)) {
    const pos = vertexPixel(vertexId);
    const seat = seatOf(owner);
    if (!pos || seat === null) continue;
    const dot = circle(pos[0], pos[1], SIZE * 0.34, `islanders-city piece-seat-${seat}`);
    dot.appendChild(svgTitle(`city ${vertexId}: ${owner}`));
    g.appendChild(dot);
  }

  clear(container);
  container.appendChild(svg);
  return true;
}

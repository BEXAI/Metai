// Backgammon: 24 points in four 6-point quadrants around a central bar, with
// bear-off trays on the right. Checkers are drawn as stacked discs.

import { makeSvg, polygon, circle, label, rect, line } from './common.js';
import { pickPointList, ownerOf } from '../shapes.js';

const POINT_W = 46;
const POINT_H = 200;
const BAR_W = 46;
const OFF_W = 50;
const MARGIN = 30;
const CHECKER_R = 18;

// Column order, left to right, for the bottom row and top row (classic
// four-quadrant layout: 13-18 | bar | 19-24 on top, 12-7 | bar | 6-1 on bottom).
const TOP_LEFT = [13, 14, 15, 16, 17, 18];
const TOP_RIGHT = [19, 20, 21, 22, 23, 24];
const BOTTOM_LEFT = [12, 11, 10, 9, 8, 7];
const BOTTOM_RIGHT = [6, 5, 4, 3, 2, 1];

function seatOf(owner) {
  if (owner === null || owner === undefined) return null;
  if (owner === 0 || owner === '0' || owner === 'p0' || owner === 'w' || owner === 'white') return 0;
  if (owner === 1 || owner === '1' || owner === 'p1' || owner === 'b' || owner === 'black') return 1;
  return null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function pointNumberOf(entry, fallbackIndex) {
  const n = pick(entry, ['point', 'number', 'index', 'pos']);
  return typeof n === 'number' ? n : fallbackIndex + 1;
}

function readPoints(list) {
  // Returns Map<pointNumber, {owner, count}>
  const map = new Map();
  list.forEach((entry, i) => {
    if (entry === null || entry === undefined) return;
    const num = pointNumberOf(entry, i);
    if (typeof entry === 'object') {
      const owner = ownerOf(entry);
      const count = pick(entry, ['count', 'checkers', 'n']);
      if (owner !== null && owner !== undefined && typeof count === 'number' && count > 0) {
        map.set(num, { owner: seatOf(owner), count });
      }
    } else if (typeof entry === 'number' && entry !== 0) {
      // signed count convention: positive = seat 0, negative = seat 1
      map.set(num, { owner: entry > 0 ? 0 : 1, count: Math.abs(entry) });
    }
  });
  return map;
}

function readCounts(value) {
  // bar/off shapes: {p0:n,p1:n} | [{owner,count}] | [n0,n1] | undefined
  const out = { 0: 0, 1: 0 };
  if (!value) return out;
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number') {
      out[0] = value[0];
      out[1] = value[1];
      return out;
    }
    for (const e of value) {
      const owner = seatOf(ownerOf(e));
      const count = pick(e, ['count', 'checkers', 'n']);
      if (owner !== null && typeof count === 'number') out[owner] += count;
    }
    return out;
  }
  if (typeof value === 'object') {
    const p0 = pick(value, ['p0', '0', 'white', 'w']);
    const p1 = pick(value, ['p1', '1', 'black', 'b']);
    if (typeof p0 === 'number') out[0] = p0;
    if (typeof p1 === 'number') out[1] = p1;
  }
  return out;
}

function pointX(colIndex, half) {
  // half: 0 = left quadrant, 1 = right quadrant (after the bar)
  const base = MARGIN + colIndex * POINT_W;
  return half === 0 ? base : base + POINT_W * 6 + BAR_W;
}

export function render(container, view) {
  const list = pickPointList(view, ['points', 'board']);
  if (!list) return false;
  const points = readPoints(list);
  if (points.size === 0) return false;

  const bar = readCounts(pick(view, ['bar']));
  const off = readCounts(pick(view, ['off', 'borne_off', 'borneOff']));

  const boardW = MARGIN * 2 + POINT_W * 12 + BAR_W + OFF_W;
  const boardH = MARGIN * 2 + POINT_H * 2 + 40;
  const svg = makeSvg(boardW, boardH, 'backgammon-board');

  svg.appendChild(rect(MARGIN, MARGIN, POINT_W * 12 + BAR_W, POINT_H * 2, 'bg-frame'));
  svg.appendChild(rect(MARGIN + POINT_W * 6, MARGIN, BAR_W, POINT_H * 2, 'bg-bar'));
  svg.appendChild(rect(MARGIN + POINT_W * 12 + BAR_W, MARGIN, OFF_W, POINT_H * 2, 'bg-off-tray'));

  const topY = MARGIN;
  const bottomY = MARGIN + POINT_H * 2;

  function drawColumn(pointNum, colIndex, half, top) {
    const x = pointX(colIndex, half);
    const dark = colIndex % 2 === 0;
    const trianglePts = top
      ? [[x, topY], [x + POINT_W, topY], [x + POINT_W / 2, topY + POINT_H * 0.82]]
      : [[x, bottomY], [x + POINT_W, bottomY], [x + POINT_W / 2, bottomY - POINT_H * 0.82]];
    svg.appendChild(polygon(trianglePts, dark ? 'bg-point bg-point-dark' : 'bg-point bg-point-light'));
    svg.appendChild(label(x + POINT_W / 2, top ? topY - 8 : bottomY + 18, String(pointNum), 'coord-label bg-point-label'));

    const cell = points.get(pointNum);
    if (cell) {
      const stackDir = top ? 1 : -1;
      const startY = top ? topY + CHECKER_R : bottomY - CHECKER_R;
      const visible = Math.min(cell.count, 5);
      for (let i = 0; i < visible; i++) {
        const cy = startY + stackDir * i * (CHECKER_R * 1.9);
        svg.appendChild(circle(x + POINT_W / 2, cy, CHECKER_R, `bg-checker piece-seat-${cell.owner}`));
      }
      if (cell.count > visible) {
        const cy = startY + stackDir * visible * (CHECKER_R * 1.9);
        svg.appendChild(label(x + POINT_W / 2, cy + 5, `${cell.count}`, 'bg-stack-count'));
      }
    }
  }

  TOP_LEFT.forEach((n, i) => drawColumn(n, i, 0, true));
  TOP_RIGHT.forEach((n, i) => drawColumn(n, i, 1, true));
  BOTTOM_LEFT.forEach((n, i) => drawColumn(n, i, 0, false));
  BOTTOM_RIGHT.forEach((n, i) => drawColumn(n, i, 1, false));

  // Bar checkers.
  const barX = MARGIN + POINT_W * 6 + BAR_W / 2;
  for (let i = 0; i < bar[0]; i++) svg.appendChild(circle(barX, bottomY - CHECKER_R - i * (CHECKER_R * 1.9), CHECKER_R, 'bg-checker piece-seat-0'));
  for (let i = 0; i < bar[1]; i++) svg.appendChild(circle(barX, topY + CHECKER_R + i * (CHECKER_R * 1.9), CHECKER_R, 'bg-checker piece-seat-1'));

  // Off trays.
  const offX = MARGIN + POINT_W * 12 + BAR_W + OFF_W / 2;
  svg.appendChild(label(offX, topY + 14, `off ${off[1]}`, 'coord-label bg-off-label'));
  svg.appendChild(label(offX, bottomY - 6, `off ${off[0]}`, 'coord-label bg-off-label'));

  svg.appendChild(line(MARGIN, MARGIN + POINT_H, MARGIN + POINT_W * 12 + BAR_W, MARGIN + POINT_H, 'bg-midline'));

  container.textContent = '';
  container.appendChild(svg);
  return true;
}

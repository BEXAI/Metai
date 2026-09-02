// Shared SVG helpers for board renderers. Every renderer takes a container
// element and a PUBLIC view value (never private state) and either fills the
// container with an <svg> board or falls back to a <pre> render — always via
// createElement/createTextNode, per the rendering law.

import { svgEl, svgTitle, clear, preJson, text, el } from '../dom.js';
import { pickBoardText } from '../shapes.js';

export { svgEl, svgTitle };

/** Fill `container` with the safe fallback: view.board_text if present, else raw JSON. */
export function renderFallback(container, view) {
  clear(container);
  const boardText = pickBoardText(view);
  if (boardText) {
    container.appendChild(preJson(boardText));
  } else {
    container.appendChild(el('p', { class: 'board-fallback-note' }, 'Board shape not recognized by the spectator renderer — showing raw public state.'));
    container.appendChild(preJson(view ?? null));
  }
}

export function makeSvg(viewBoxW, viewBoxH, extraClass) {
  return svgEl('svg', {
    class: extraClass ? `board-svg ${extraClass}` : 'board-svg',
    viewBox: `0 0 ${viewBoxW} ${viewBoxH}`,
    role: 'img',
  });
}

export function circle(cx, cy, r, cls) {
  return svgEl('circle', { cx, cy, r, class: cls });
}

export function rect(x, y, w, h, cls) {
  return svgEl('rect', { x, y, width: w, height: h, class: cls });
}

export function line(x1, y1, x2, y2, cls) {
  return svgEl('line', { x1, y1, x2, y2, class: cls });
}

export function label(x, y, str, cls) {
  const t = svgEl('text', { x, y, class: cls || 'board-label' });
  t.appendChild(text(str));
  return t;
}

export function polygon(points, cls) {
  return svgEl('polygon', { points: points.map((p) => `${p[0]},${p[1]}`).join(' '), class: cls });
}

// Dispatcher for landlord + islanders: each has its own dedicated renderer
// (boards/landlord.js, boards/islanders.js) built from its real public view
// shape; board_text is always appended below as well, since spec explicitly
// allows "board_text-first" as an acceptable v1 for these two and it's a
// useful cross-check regardless.

import { el, clear } from '../dom.js';
import { pickBoardText } from '../shapes.js';
import * as landlord from './landlord.js';
import * as islanders from './islanders.js';

export function render(container, gameId, view) {
  clear(container);
  const wrapper = el('div', { class: 'schematic-wrapper' });
  let hasSchematic = false;
  try {
    if (gameId === 'landlord') hasSchematic = landlord.render(wrapper, view);
    else if (gameId === 'islanders') hasSchematic = islanders.render(wrapper, view);
  } catch {
    hasSchematic = false;
  }

  const boardText = pickBoardText(view);
  if (boardText) {
    wrapper.appendChild(el('pre', { class: 'board-text' }, boardText));
  }

  if (!hasSchematic && !boardText) return false;
  container.appendChild(wrapper);
  return true;
}

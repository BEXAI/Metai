// Board renderer dispatcher. Picks the renderer for a game id and always
// falls back to view.board_text (or the raw public JSON) when the specific
// renderer doesn't recognize the data shape — spec §spectator.board_renderers.

import * as grid from './grid.js';
import * as go from './go.js';
import * as hex from './hex.js';
import * as morris from './morris.js';
import * as chineseCheckers from './chinese_checkers.js';
import * as backgammon from './backgammon.js';
import * as schematic from './schematic.js';
import * as werewolf from './werewolf.js';
import { renderFallback } from './common.js';

const GRID_GAMES = new Set(['chess', 'checkers', 'reversi', 'connect_drop', 'tictactoe']);

/** Render the board for `gameId` from a PUBLIC view value into `container`. */
export function renderBoard(container, gameId, view) {
  try {
    if (!view) {
      renderFallback(container, view);
      return;
    }
    let ok = false;
    if (GRID_GAMES.has(gameId)) {
      ok = grid.render(container, gameId, view);
    } else if (gameId === 'go') {
      ok = go.render(container, view);
    } else if (gameId === 'hex') {
      ok = hex.render(container, view);
    } else if (gameId === 'nine_mens_morris') {
      ok = morris.render(container, view);
    } else if (gameId === 'chinese_checkers') {
      ok = chineseCheckers.render(container, view);
    } else if (gameId === 'backgammon') {
      ok = backgammon.render(container, view);
    } else if (gameId === 'landlord' || gameId === 'islanders') {
      ok = schematic.render(container, gameId, view);
    } else if (gameId === 'werewolf') {
      // Not through schematic.js: that appends board_text under the board, and
      // for werewolf board_text is the whole engine dossier — the same content
      // twice under every mini-board. The fallback below still prints it if
      // the renderer declines the shape.
      ok = werewolf.render(container, view);
    }
    if (!ok) renderFallback(container, view);
  } catch {
    renderFallback(container, view);
  }
}

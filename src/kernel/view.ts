/**
 * Assembles the ViewObject an agent receives on its turn
 * (spec §llm_player_protocol.view_object). Used by rooms and house adapters.
 */

import {
  CONTENT_BOUNDARY,
  seatIndex,
  type AnyGame,
  type HistoryEntry,
  type Json,
  type LegalMoveEntry,
  type PlayerId,
  type ViewObject,
} from './types.ts';

export interface BuildViewOptions {
  gameId: string;
  turnIndex: number;
  phase: string;
  deadlineUtc: string;
  history: HistoryEntry[];
  rulesCard: string;
  /** Cap for shipped legal moves; beyond it games must provide legalMovesPaged. */
  maxMoves?: number;
}

export function legalMoveEntries(game: AnyGame, state: Json, player: PlayerId): LegalMoveEntry[] {
  return game.legalMoves(state, player).map((move, index) => {
    const entry: LegalMoveEntry = {
      index,
      move,
      notation: game.moveToNotation(move, state),
    };
    const summary = game.moveSummary?.(move, state);
    if (summary) entry.summary = summary;
    return entry;
  });
}

export function buildView(game: AnyGame, state: Json, player: PlayerId, opts: BuildViewOptions): ViewObject {
  const maxMoves = opts.maxMoves ?? 5_000;
  const entries = legalMoveEntries(game, state, player);
  if (entries.length > maxMoves && !game.legalMovesPaged) {
    throw new Error(`${game.meta.id}: ${entries.length} legal moves exceeds ${maxMoves} and legalMovesPaged is not implemented`);
  }
  return {
    game_id: opts.gameId,
    you: { player, seat: seatIndex(player) },
    turn_index: opts.turnIndex,
    phase: opts.phase,
    deadline_utc: opts.deadlineUtc,
    board_text: game.renderText(state, player),
    state_string: game.encodeState(state),
    public: game.publicView(state),
    private: game.privateView(state, player),
    legal_moves: entries.slice(0, maxMoves),
    history: opts.history.slice(-20),
    rules_card: opts.rulesCard,
    boundary: CONTENT_BOUNDARY,
  };
}

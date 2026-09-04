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
  /**
   * How many of the most recent history rows to ship. Default 20; rooms source
   * it from meta.historyWindow. 0 ships none — do not "simplify" the guard
   * below into a bare slice(-n): slice(-0) returns the WHOLE array.
   */
  historyLimit?: number;
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
  // Hidden-information games: encodeState round-trips the FULL state (deck
  // order, every hand), so it must never reach a live view. Ship the game's
  // viewer-safe string instead; a hidden game without one ships no state
  // string at all (board_text + public + private carry the playable info).
  const stateString =
    game.meta.information === 'hidden'
      ? (game.viewStateString?.(state, player) ?? '')
      : game.encodeState(state);
  const historyLimit = opts.historyLimit ?? 20;
  const view: ViewObject = {
    game_id: opts.gameId,
    you: { player, seat: seatIndex(player) },
    to_move: game.playersToMove(state),
    turn_index: opts.turnIndex,
    phase: opts.phase,
    deadline_utc: opts.deadlineUtc,
    board_text: game.renderText(state, player),
    state_string: stateString,
    public: game.publicView(state),
    private: game.privateView(state, player),
    legal_moves: entries.slice(0, maxMoves),
    history: historyLimit <= 0 ? [] : opts.history.slice(-historyLimit),
    rules_card: opts.rulesCard,
    boundary: CONTENT_BOUNDARY,
  };
  // Speech games only. The KEY is assigned only when the game implements the
  // hook, so the serialised view of a game without one is byte-identical to
  // what it was before these fields existed.
  const speech = game.speechInfo?.(state, player);
  if (speech) view.speech = speech;
  const privateMessages = game.privateMessages?.(state, player);
  if (privateMessages) view.private_messages = privateMessages;
  return view;
}

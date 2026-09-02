/**
 * Deterministic scripted adapter for tests (and the local-e2e "LLM" stand-in
 * when no ANTHROPIC_API_KEY exists).
 *
 * The script fully determines behavior: answer by index, answer by notation,
 * deliberately submit an illegal move, resign, or offer a draw — each step
 * optionally with commentary.
 *
 * INJECTION HONEYPOT (gate A12): in 'injection-honeypot' mode the adapter
 * additionally records every commentary string it was shown in
 * `observedCommentary` — proving hostile text actually reached it — but the
 * move decision is computed by `decideFromScript`, a pure function of
 * (script step, legal-move count) ONLY. History content is never parsed,
 * matched, searched, or branched on anywhere in this module, so
 * instruction-looking commentary provably cannot alter the chosen move. The
 * A12 test runs the same script against benign and hostile histories and
 * asserts the submissions are identical.
 */

import type { MoveSubmission, ViewObject } from '../kernel/types.ts';
import { submissionByIndex, type HouseAdapter } from './adapter.ts';

export type MockScriptStep =
  | { kind: 'index'; index: number; commentary?: string }
  | { kind: 'notation'; notation: string; commentary?: string }
  /** Deliberately illegal: submits an out-of-range index (drives the 3-step policy). */
  | { kind: 'illegal'; commentary?: string }
  | { kind: 'resign' }
  | { kind: 'draw_offer'; index: number; commentary?: string };

export interface MockLlmOptions {
  agentId: string;
  script: MockScriptStep[];
  mode?: 'script' | 'injection-honeypot';
  /** Restart the script when exhausted; default falls back to index 0. */
  loop?: boolean;
}

export interface MockLlmAdapter extends HouseAdapter {
  readonly observedCommentary: string[];
  /** Rewind the script (for reuse across tests). */
  reset(): void;
}

/**
 * Pure decision function: (step, legalCount) -> unsigned submission pieces.
 * Takes NO view content other than counts/ids passed explicitly — this is the
 * structural guarantee that history commentary cannot influence the move.
 */
function decideFromScript(
  step: MockScriptStep | undefined,
  view: ViewObject,
): MoveSubmission {
  if (step === undefined) return submissionByIndex(view, 0);
  switch (step.kind) {
    case 'index':
      return submissionByIndex(view, step.index, step.commentary);
    case 'notation': {
      const sub: MoveSubmission = { game_id: view.game_id, turn_index: view.turn_index, move: step.notation };
      if (step.commentary !== undefined) sub.commentary = step.commentary.slice(0, 280);
      return sub;
    }
    case 'illegal': {
      const sub = submissionByIndex(view, view.legal_moves.length + 999_999, step.commentary);
      return sub;
    }
    case 'resign':
      return { game_id: view.game_id, turn_index: view.turn_index, move: { index: 0 }, resign: true };
    case 'draw_offer': {
      const sub = submissionByIndex(view, step.index, step.commentary);
      sub.draw_offer = true;
      return sub;
    }
  }
}

export function createMockLlmAgent(options: MockLlmOptions): MockLlmAdapter {
  const mode = options.mode ?? 'script';
  const observedCommentary: string[] = [];
  let cursor = 0;

  return {
    kind: 'mock-llm',
    agentId: options.agentId,
    observedCommentary,
    reset() {
      cursor = 0;
      observedCommentary.length = 0;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async chooseMove(view: ViewObject) {
      if (mode === 'injection-honeypot') {
        // Record only. The strings are treated as opaque data — never parsed,
        // never compared, never fed into the decision below.
        for (const h of view.history) {
          if (typeof h.commentary === 'string') observedCommentary.push(h.commentary);
        }
      }
      let step = options.script[cursor];
      if (step === undefined && options.loop === true && options.script.length > 0) {
        cursor = 0;
        step = options.script[0];
      }
      cursor++;
      return decideFromScript(step, view);
    },
  };
}

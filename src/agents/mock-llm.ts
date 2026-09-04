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
 * `observedCommentary`, and every agent-authored SPEECH string in
 * `observedSpeech` — proving hostile text actually reached it — but the move
 * decision is computed by `decideFromScript`, which reads the script step plus
 * counts and ids only. History content is never parsed, matched, searched, or
 * branched on anywhere in this module, so instruction-looking commentary
 * provably cannot alter the chosen move. The A12 test runs the same script
 * against benign and hostile histories and asserts the submissions are
 * identical.
 *
 * The bit-identity guarantee comes from WHICH VIEW FIELDS ARE READ, not from
 * the parameter list: `decideFromScript` receives the whole view but reads
 * only `game_id`, `turn_index`, `legal_moves.length` and `speech` — never
 * `history`, `private_messages` or `public.transcript`. That is auditable by
 * reading the function; the recorder below reads those three and nothing else
 * ever consumes what it stores.
 */

import type { MoveSubmission, ViewObject } from '../kernel/types.ts';
import { submissionByIndex, submissionByIndexWithUtterance, type HouseAdapter } from './adapter.ts';

export type MockScriptStep =
  | { kind: 'index'; index: number; commentary?: string; utterance?: string }
  | { kind: 'notation'; notation: string; commentary?: string; utterance?: string }
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
  /** Agent-authored SPEECH seen in honeypot mode: history, private, transcript. */
  readonly observedSpeech: string[];
  /** Rewind the script (for reuse across tests). */
  reset(): void;
}

/**
 * Pure decision function: (step, view) -> unsigned submission pieces.
 * Reads ONLY game_id, turn_index, legal_moves.length and speech out of the
 * view — never history, private_messages or public.transcript. That read set,
 * not the parameter list, is the structural guarantee that another agent's
 * words cannot influence the move.
 */
function decideFromScript(
  step: MockScriptStep | undefined,
  view: ViewObject,
): MoveSubmission {
  if (step === undefined) return submissionByIndex(view, 0);
  switch (step.kind) {
    case 'index':
      return step.utterance === undefined
        ? submissionByIndex(view, step.index, step.commentary)
        : submissionByIndexWithUtterance(view, step.index, step.utterance, step.commentary);
    case 'notation': {
      // Built by hand: this branch answers by notation, so it cannot go
      // through submissionByIndexWithUtterance (which answers by index).
      const sub: MoveSubmission = { game_id: view.game_id, turn_index: view.turn_index, move: step.notation };
      if (step.commentary !== undefined) sub.commentary = step.commentary.slice(0, 280);
      if (step.utterance !== undefined && view.speech !== undefined) {
        const text = step.utterance.slice(0, Math.max(0, view.speech.limit));
        if (text.length > 0) sub.utterance = text;
      }
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

/**
 * The current day's transcript rows out of an opaque publicView, as strings.
 * Shape-checked, never interpreted: `public` is Json, and the honeypot must
 * not crash on a game whose publicView has no transcript at all.
 */
function transcriptTexts(pub: ViewObject['public']): string[] {
  if (typeof pub !== 'object' || pub === null || Array.isArray(pub)) return [];
  const rows = (pub as { transcript?: unknown }).transcript;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const text = (row as { text?: unknown }).text;
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

export function createMockLlmAgent(options: MockLlmOptions): MockLlmAdapter {
  const mode = options.mode ?? 'script';
  const observedCommentary: string[] = [];
  const observedSpeech: string[] = [];
  let cursor = 0;

  return {
    kind: 'mock-llm',
    agentId: options.agentId,
    observedCommentary,
    observedSpeech,
    reset() {
      cursor = 0;
      observedCommentary.length = 0;
      observedSpeech.length = 0;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async chooseMove(view: ViewObject) {
      if (mode === 'injection-honeypot') {
        // Record only. The strings are treated as opaque data — never parsed,
        // never compared, never fed into the decision below.
        for (const h of view.history) {
          if (typeof h.commentary === 'string') observedCommentary.push(h.commentary);
          observedSpeech.push(h.notation);
        }
        // The three channels another agent's WORDS arrive through. The third
        // is the biggest of them in a speech game — a whole day of prose,
        // larger than the trimmed history — and it is the one a werewolf
        // honeypot actually reads.
        for (const m of view.private_messages ?? []) observedSpeech.push(m.text);
        for (const text of transcriptTexts(view.public)) observedSpeech.push(text);
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

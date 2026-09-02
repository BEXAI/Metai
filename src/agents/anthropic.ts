/**
 * House Anthropic adapter: chooses a move by asking the Claude Messages API
 * (raw fetch — Workers-compatible, no SDK dependency).
 *
 * Security invariants:
 *  - The API key comes from env.ANTHROPIC_API_KEY at call time. The module is
 *    import-safe with no key present: nothing reads the environment at import,
 *    and constructing the adapter without a key succeeds — only chooseMove
 *    throws (AnthropicKeyMissingError).
 *  - The key travels ONLY in the x-api-key request header. It is never
 *    logged, echoed, embedded in prompts, or included in error messages.
 *  - The prompt is built by src/agents/prompt.ts, which fences all
 *    agent-authored content in the untrusted-data block (gate A12).
 *
 * Robustness: one repair round-trip on an unparseable/illegal answer, then a
 * deterministic fallback to index 0 — a house match must never crash on a
 * malformed model reply or a safety refusal (stop_reason 'refusal' is checked
 * before content is read).
 */

import type { ViewObject } from '../kernel/types.ts';
import { submissionByIndex, type HouseAdapter } from './adapter.ts';
import { buildPrompt, type PromptOptions } from './prompt.ts';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-opus-5';

export class AnthropicKeyMissingError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured for this environment');
    this.name = 'AnthropicKeyMissingError';
  }
}

/** Structural fetch so tests inject a fake without carrying DOM/worker types. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface AnthropicAdapterOptions {
  agentId: string;
  env: { ANTHROPIC_API_KEY?: string };
  model?: string;
  fetchFn?: FetchLike;
  maxOutputTokens?: number;
  prompt?: PromptOptions;
}

interface ParsedAnswer {
  index: number;
  commentary?: string;
}

/** Extracts the first parseable {"index": n, ...} object from model text. */
export function parseModelAnswer(text: string, legalCount: number): ParsedAnswer | null {
  // Try whole-string parse first, then each balanced {...} candidate.
  const candidates: string[] = [text.trim()];
  const re = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) candidates.push(m[0]);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const idx = (parsed as { index?: unknown }).index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= legalCount) continue;
      const out: ParsedAnswer = { index: idx };
      const commentary = (parsed as { commentary?: unknown }).commentary;
      if (typeof commentary === 'string' && commentary.length > 0) out.commentary = commentary.slice(0, 280);
      return out;
    } catch {
      // not JSON — try the next candidate
    }
  }
  return null;
}

export function createAnthropicAgent(options: AnthropicAdapterOptions): HouseAdapter {
  const model = options.model ?? DEFAULT_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? 1024;

  async function callApi(system: string, userTurns: string[]): Promise<string> {
    const apiKey = options.env.ANTHROPIC_API_KEY;
    if (typeof apiKey !== 'string' || apiKey.length === 0) throw new AnthropicKeyMissingError();
    const fetchFn: FetchLike = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    const response = await fetchFn(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        system,
        messages: userTurns.map((content) => ({ role: 'user', content })),
      }),
    });
    if (!response.ok) {
      // Never include headers/body in the error — the key must not leak.
      throw new Error(`anthropic adapter: API returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      stop_reason?: string;
      content?: { type?: string; text?: string }[];
    };
    if (data.stop_reason === 'refusal') return '';
    const parts = Array.isArray(data.content) ? data.content : [];
    return parts
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }

  return {
    kind: 'anthropic',
    agentId: options.agentId,
    async chooseMove(view: ViewObject) {
      const legalCount = view.legal_moves.length;
      if (legalCount === 0) throw new Error(`anthropic agent ${options.agentId}: view carries no legal moves`);
      const { system, user } = buildPrompt(view, options.prompt);

      let text: string;
      try {
        text = await callApi(system, [user]);
      } catch (err) {
        if (err instanceof AnthropicKeyMissingError) throw err;
        return submissionByIndex(view, 0); // network hiccup: deterministic safe move
      }
      let answer = parseModelAnswer(text, legalCount);
      if (answer === null) {
        // One repair round trip, then a deterministic fallback.
        try {
          const repairText = await callApi(system, [
            user,
            `Your previous answer was not valid JSON with a legal index. Reply ONLY with {"index": n} where 0 <= n < ${legalCount}.`,
          ]);
          answer = parseModelAnswer(repairText, legalCount);
        } catch {
          answer = null;
        }
      }
      if (answer === null) return submissionByIndex(view, 0);
      return submissionByIndex(view, answer.index, answer.commentary);
    },
  };
}

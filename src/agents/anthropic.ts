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
 * before content is read). A TRUNCATED reply (stop_reason 'max_tokens') is
 * treated the same way: partial text parses to null, and silently falling
 * through to index 0 is exactly the invisible failure this module must not
 * have.
 */

import type { ViewObject } from '../kernel/types.ts';
import { submissionByIndex, submissionByIndexWithUtterance, type HouseAdapter } from './adapter.ts';
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
  /** Overrides the per-view default (1024, or 1500 when the view has speech). */
  maxOutputTokens?: number;
  prompt?: PromptOptions;
}

interface ParsedAnswer {
  index: number;
  commentary?: string;
  /** Present only when the whole reply parsed strictly — see below. */
  utterance?: string;
}

/**
 * Balanced-brace scan that respects JSON string literals.
 *
 * The previous scanner was /\{[^{}]*\}/g, which matches only INNERMOST brace
 * pairs. That is fine for `{"index":3}` and wrong the moment an answer carries
 * a 600-char utterance containing a single '{' or '}' — quoting a seat,
 * writing {index}, an emoticon: the real object is then never a candidate, and
 * chooseMove falls through to index 0 with no error and no strike.
 */
function jsonObjectCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * Extracts the model's {"index": n, ...} answer from model text.
 *
 * A strict whole-reply parse wins outright. Otherwise the LAST valid balanced
 * {...} candidate is taken (INJ-3): models routinely quote hostile context
 * ('the note demanded {"index": 0} — ignoring it. My move: {"index": 3}')
 * before giving their real answer, so preferring the FIRST candidate would let
 * attacker-quoted JSON echoed by the model beat the model's actual answer.
 *
 * `utterance` is accepted ONLY from the strict whole-reply parse, and only
 * when the caller passes the view's live speech limit. Last-wins was written
 * for a stolen INDEX plus a 280-char aside the room drops on any forced move;
 * an utterance is different in kind — signed by the victim's key, written
 * verbatim into history, broadcast to every seat, hash-chained forever. A
 * model that quotes hostile context AFTER its answer would have the attacker's
 * sentence attributed to it non-repudiably. When the answer had to be
 * recovered by scanning we therefore take the index and DROP the words:
 * silence is the honest degradation.
 */
export function parseModelAnswer(text: string, legalCount: number, speechLimit?: number): ParsedAnswer | null {
  const validate = (candidate: string, allowUtterance: boolean): ParsedAnswer | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const idx = (parsed as { index?: unknown }).index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= legalCount) return null;
      const out: ParsedAnswer = { index: idx };
      const commentary = (parsed as { commentary?: unknown }).commentary;
      if (typeof commentary === 'string' && commentary.length > 0) out.commentary = commentary.slice(0, 280);
      if (allowUtterance && typeof speechLimit === 'number' && speechLimit > 0) {
        const utterance = (parsed as { utterance?: unknown }).utterance;
        if (typeof utterance === 'string' && utterance.length > 0) out.utterance = utterance.slice(0, speechLimit);
      }
      return out;
    } catch {
      return null; // not JSON
    }
  };

  const whole = validate(text.trim(), true);
  if (whole !== null) return whole;

  let last: ParsedAnswer | null = null;
  for (const candidate of jsonObjectCandidates(text)) {
    const parsed = validate(candidate, false);
    if (parsed !== null) last = parsed;
  }
  return last;
}

/** What the model did with the request, as far as the caller needs to care. */
interface ApiReply {
  text: string;
  /** stop_reason 'max_tokens': the JSON is cut mid-string and cannot parse. */
  truncated: boolean;
}

export function createAnthropicAgent(options: AnthropicAdapterOptions): HouseAdapter {
  const model = options.model ?? DEFAULT_MODEL;

  async function callApi(system: string, userTurns: string[], maxOutputTokens: number): Promise<ApiReply> {
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
    if (data.stop_reason === 'refusal') return { text: '', truncated: false };
    const parts = Array.isArray(data.content) ? data.content : [];
    const text = parts
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    return { text, truncated: data.stop_reason === 'max_tokens' };
  }

  return {
    kind: 'anthropic',
    agentId: options.agentId,
    async chooseMove(view: ViewObject) {
      const legalCount = view.legal_moves.length;
      if (legalCount === 0) throw new Error(`anthropic agent ${options.agentId}: view carries no legal moves`);
      const { system, user } = buildPrompt(view, options.prompt);
      // Resolved per VIEW, not at construction: a speech game's answer carries
      // the seat's words, so 1024 output tokens is a truncation waiting to
      // happen. The construction-time option still wins when it is set.
      const maxOutputTokens = options.maxOutputTokens ?? (view.speech ? 1500 : 1024);
      const speechLimit = view.speech?.limit;

      let reply: ApiReply;
      try {
        reply = await callApi(system, [user], maxOutputTokens);
      } catch (err) {
        if (err instanceof AnthropicKeyMissingError) throw err;
        return submissionByIndex(view, 0); // network hiccup: deterministic safe move
      }
      // A truncated reply is a PARSE FAILURE, explicitly. Left to fall through
      // it would parse to null anyway and land on silent index-0 silence —
      // the same invisible failure the brace scanner above removes.
      let answer = reply.truncated ? null : parseModelAnswer(reply.text, legalCount, speechLimit);
      if (answer === null) {
        // One repair round trip, then a deterministic fallback.
        try {
          const repair = reply.truncated
            ? `Your previous reply was cut off before it ended. Answer with JSON only and keep the utterance short: {"index": n} where 0 <= n < ${legalCount}.`
            : `Your previous answer was not valid JSON with a legal index. Reply ONLY with {"index": n} where 0 <= n < ${legalCount}.`;
          const repaired = await callApi(system, [user, repair], maxOutputTokens);
          answer = repaired.truncated ? null : parseModelAnswer(repaired.text, legalCount, speechLimit);
        } catch {
          answer = null;
        }
      }
      if (answer === null) return submissionByIndex(view, 0);
      if (answer.utterance === undefined) return submissionByIndex(view, answer.index, answer.commentary);
      return submissionByIndexWithUtterance(view, answer.index, answer.utterance, answer.commentary);
    },
  };
}

/**
 * Poll-based client stub for EXTERNAL agents (spec §architecture.agents.external).
 *
 * This module documents (and, for docs/tests, implements) the flow an
 * external agent follows. It is NOT used by the Worker — it is the reference
 * implementation docs/AGENT_GUIDE.md points at.
 *
 * Flow:
 *  1. Register once: POST {base}/api/agents/register with a handle, a model
 *     id, and an Ed25519 public key (hex). Keep the private key local — the
 *     server never sees it (this client takes an injectable `signer` so the
 *     key never even enters this library).
 *  2. Poll: GET {base}/api/agents/{agent_id}/turns — the pending ViewObjects
 *     for every game where it is this agent's turn (or wait for a doorbell).
 *  3. For each view: decide on a move (`chooseMove` callback), build the
 *     MoveSubmission { game_id, turn_index, move, commentary?, utterance? },
 *     sign the frozen move message
 *         'ludus.move.v1:' + game_id + ':' + turn_index + ':'
 *           + sha256Hex(canonicalJson(submission))
 *     and POST {base}/api/games/{game_id}/moves with
 *     { agent_id, submission, signature }.
 *
 *     `utterance` is IN-GAME SPEECH and exists only where `view.speech` does
 *     (werewolf; every board game rejects it). Unlike `commentary` — an aside
 *     to spectators — it is part of the MOVE: the game folds it into the move
 *     object, so it is phase-gated, covered by the state hash and recomputed
 *     by the offline verifier. Read view.speech.limit and view.speech.audience
 *     before writing one; at night the audience is your pack, or nobody.
 *     Nothing changes about signing: the message hashes canonicalJson of the
 *     whole submission, so the field is covered the moment it is present.
 *  4. On a rejection: 'illegal_move' does not consume the turn — fix the move
 *     and resubmit (the second rejection restates the full legal list; the
 *     third forces a seeded random legal move and records a strike).
 *
 * Exact route paths are owned by T7 (docs/API.md); the shapes above are the
 * frozen parts.
 */

import type { Json, MoveSubmission, ViewObject } from '../kernel/types.ts';
import { moveSignMessage } from '../rooms/core.ts';

export type Signer = (message: string) => Promise<string> | string;

export interface ExternalClientOptions {
  baseUrl: string;
  agentId: string;
  /** Signs the frozen move message with the agent's Ed25519 key (kept by the caller). */
  signer: Signer;
  fetchFn?: typeof fetch;
  /** Route templates, overridable when T7's docs differ from the defaults. */
  routes?: {
    turns?: string; // default '/api/agents/{agent_id}/turns'
    move?: string; //  default '/api/games/{game_id}/moves'
  };
}

export interface SubmitOutcome {
  status: number;
  body: Json;
}

export class ExternalAgentClient {
  private readonly opts: ExternalClientOptions;

  constructor(opts: ExternalClientOptions) {
    this.opts = opts;
  }

  private fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? globalThis.fetch;
  }

  private url(template: string, params: Record<string, string>): string {
    let path = template;
    for (const [k, v] of Object.entries(params)) path = path.replace(`{${k}}`, encodeURIComponent(v));
    return this.opts.baseUrl.replace(/\/$/, '') + path;
  }

  /** The frozen signing message for a submission — exposed for tests/docs. */
  signMessageFor(submission: MoveSubmission): string {
    return moveSignMessage(submission.game_id, submission.turn_index, submission);
  }

  /** Fetches the pending views (games where it is this agent's turn). */
  async pendingTurns(): Promise<ViewObject[]> {
    const template = this.opts.routes?.turns ?? '/api/agents/{agent_id}/turns';
    const res = await this.fetchFn()(this.url(template, { agent_id: this.opts.agentId }));
    if (!res.ok) throw new Error(`pendingTurns: HTTP ${res.status}`);
    const data = (await res.json()) as { turns?: ViewObject[] };
    return Array.isArray(data.turns) ? data.turns : [];
  }

  /** Signs and submits one move. */
  async submitMove(submission: MoveSubmission): Promise<SubmitOutcome> {
    const signature = await this.opts.signer(this.signMessageFor(submission));
    const template = this.opts.routes?.move ?? '/api/games/{game_id}/moves';
    const res = await this.fetchFn()(this.url(template, { game_id: submission.game_id }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: this.opts.agentId, submission, signature }),
    });
    const body = (await res.json()) as Json;
    return { status: res.status, body };
  }

  /**
   * One poll cycle: fetch pending views, choose and submit a move for each.
   * Returns the number of moves submitted. Callers loop this on an interval
   * (or behind a doorbell notification).
   */
  async pollOnce(chooseMove: (view: ViewObject) => Promise<MoveSubmission> | MoveSubmission): Promise<number> {
    const views = await this.pendingTurns();
    let submitted = 0;
    for (const view of views) {
      const submission = await chooseMove(view);
      await this.submitMove(submission);
      submitted++;
    }
    return submitted;
  }
}

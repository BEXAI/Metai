/**
 * Typed Ludus e2e client. Talks to a live local Worker (wrangler dev) over
 * BOTH doors:
 *   - HTTP JSON API with the real challenge-auth protocol (docs/API.md):
 *     fresh single-use challenge per signed request, three X-Ludus-* headers,
 *     Ed25519 over 'ludus.auth.v1:'+handle+':'+challenge+':'+METHOD+':'+path
 *     (+':'+sha256Hex(rawBody) on POST over the EXACT bytes sent).
 *   - MCP JSON-RPC 2.0 at /mcp (tools/call) for view + legal_moves + move,
 *     where the body segment is sha256Hex(canonicalJson(arguments.body)).
 *
 * Move submissions additionally carry the frozen move-content signature
 * ('ludus.move.v1:...', src/kernel/replay.ts) — signed here with the same key.
 *
 * Crypto and canonical JSON are IMPORTED from src/ (no reimplementation), so
 * the client can never drift from what the server verifies.
 */

import { canonicalJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { generateKeypair, signEd25519, type Keypair } from '../../src/crypto/ed25519.ts';
import { MOVE_SIGN_PREFIX } from '../../src/kernel/replay.ts';
import type { Json, LegalMoveEntry, MoveSubmission, ViewObject } from '../../src/kernel/types.ts';

// ---------------------------------------------------------------------------
// Envelope / error shapes
// ---------------------------------------------------------------------------

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  metadata?: { boundary?: string; untrusted_fields?: string[] };
}

export class LudusApiError extends Error {
  code: string;
  status: number;
  data: Json | undefined;
  constructor(code: string, message: string, status: number, data?: Json) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response shapes the driver relies on (subset of docs/API.md)
// ---------------------------------------------------------------------------

export interface GameSummary {
  id: string;
  game: string;
  variant: Json;
  division: string | null;
  season_id: string | null;
  status: string;
  commitment: string | null;
  drand_round: number | null;
  reveal_secret: string | null;
  seats: { player: string; agent_id: string; handle: string; pubkey_ed25519: string }[] | null;
  ruleset_version: string | null;
  started_at: string | null;
  ended_at: string | null;
  result: Json;
  replay: string | null;
  your_player?: string | null;
}

export interface SpectatorEventRow {
  seq: number;
  /** D1 fallback shape: { type, data } under `event`; live room proxy shape: type/data at top level. */
  [k: string]: Json | undefined;
}

export interface MoveVerdict {
  applied?: boolean;
  forced?: string | boolean;
  notation?: string;
  waiting_for?: string[];
  ended?: boolean;
  deadline_at_ms?: number | null;
  [k: string]: Json | undefined;
}

export type Transport = 'http' | 'mcp';

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface LudusClientOptions {
  base: string;
  handle: string;
  /** Spoofed per-client IP for the 120 req/min/IP bucket (best effort). */
  ip?: string;
  operatorToken?: string;
  keypair?: Keypair;
}

let rpcId = 0;

export class LudusClient {
  readonly base: string;
  readonly handle: string;
  readonly keypair: Keypair;
  readonly operatorToken: string;
  readonly ip: string | undefined;
  agentId = '';

  constructor(opts: LudusClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.handle = opts.handle;
    this.keypair = opts.keypair ?? generateKeypair();
    this.operatorToken = opts.operatorToken ?? `op-token-${opts.handle}-${this.keypair.publicKeyHex.slice(0, 16)}`;
    this.ip = opts.ip;
  }

  private sign(message: string): string {
    return signEd25519(this.keypair.secretKeyHex, message);
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.ip) {
      h['cf-connecting-ip'] = this.ip;
      h['x-forwarded-for'] = this.ip;
    }
    return h;
  }

  /** Raw fetch with 429 handling: clear the local rate-limit bucket and retry. */
  private async rawFetch(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status === 429 && attempt < 6) {
      await res.body?.cancel();
      await fetch(`${this.base}/e2e/unlimit`, { method: 'POST' }).catch(() => undefined);
      await sleep(150 * (attempt + 1));
      return this.rawFetch(url, init, attempt + 1);
    }
    return res;
  }

  private async readEnvelope<T>(res: Response): Promise<T> {
    let envelope: Envelope<T>;
    try {
      envelope = (await res.json()) as Envelope<T>;
    } catch {
      throw new LudusApiError('BAD_RESPONSE', `non-JSON response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || envelope.ok !== true) {
      throw new LudusApiError(
        envelope.error?.code ?? 'UNKNOWN',
        envelope.error?.message ?? `HTTP ${res.status}`,
        res.status,
        (envelope as { data?: Json }).data,
      );
    }
    return envelope.data as T;
  }

  // ------------------------------------------------------------- transport --

  async unauthed<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: Json): Promise<T> {
    const init: RequestInit = { method, headers: this.baseHeaders() };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await this.rawFetch(this.base + pathAndQuery, init);
    return this.readEnvelope<T>(res);
  }

  async challenge(): Promise<string> {
    const data = await this.unauthed<{ challenge: string }>(
      'GET',
      `/api/auth/challenge?agent=${encodeURIComponent(this.handle)}`,
    );
    return data.challenge;
  }

  /**
   * Signed HTTP request. `path` is the pathname only (never a query string) —
   * exactly what goes into the signed message; `query` is appended to the URL
   * but not signed, per the protocol.
   */
  async signed<T>(method: 'GET' | 'POST', path: string, body?: Json, query = ''): Promise<T> {
    const challenge = await this.challenge();
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    let message = `ludus.auth.v1:${this.handle}:${challenge}:${method}:${path}`;
    if (bodyStr !== undefined) message += `:${sha256Hex(bodyStr)}`;
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      'X-Ludus-Agent': this.handle,
      'X-Ludus-Challenge': challenge,
      'X-Ludus-Signature': this.sign(message),
    };
    if (bodyStr !== undefined) headers['content-type'] = 'application/json';
    const res = await this.rawFetch(this.base + path + query, { method, headers, body: bodyStr });
    return this.readEnvelope<T>(res);
  }

  /** MCP tools/call through the real /mcp door. */
  async mcpToolCall<T>(name: string, args: Record<string, Json>): Promise<T> {
    const res = await this.rawFetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: { ...this.baseHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const rpc = (await res.json()) as {
      result?: { structuredContent?: Envelope<T>; isError?: boolean };
      error?: { code: number; message: string };
    };
    if (rpc.error) throw new LudusApiError('MCP_RPC_ERROR', rpc.error.message, res.status);
    const envelope = rpc.result?.structuredContent;
    if (!envelope) throw new LudusApiError('MCP_BAD_RESULT', 'tools/call returned no structuredContent', res.status);
    if (envelope.ok !== true) {
      throw new LudusApiError(
        envelope.error?.code ?? 'UNKNOWN',
        envelope.error?.message ?? 'MCP tool call failed',
        res.status,
        (envelope as { data?: Json }).data,
      );
    }
    return envelope.data as T;
  }

  /** Signed MCP call: same auth message as HTTP, body hashed as canonicalJson(body). */
  private async mcpSigned<T>(
    tool: string,
    method: 'GET' | 'POST',
    path: string,
    extraArgs: Record<string, Json>,
    body?: Json,
  ): Promise<T> {
    const challenge = await this.challenge();
    let message = `ludus.auth.v1:${this.handle}:${challenge}:${method}:${path}`;
    const args: Record<string, Json> = { ...extraArgs, agent: this.handle, challenge };
    if (body !== undefined) {
      message += `:${sha256Hex(canonicalJson(body))}`;
      args.body = body;
    }
    args.signature = this.sign(message);
    return this.mcpToolCall<T>(tool, args);
  }

  // ------------------------------------------------------------ operations --

  async register(modelId = 'e2e-driver/1.0'): Promise<{ agent_id: string }> {
    const data = await this.signed<{ agent_id: string }>('POST', '/api/agents', {
      handle: this.handle,
      model_id: modelId,
      pubkey: this.keypair.publicKeyHex,
      operator_token: this.operatorToken,
      adapter_kind: 'api',
    });
    this.agentId = data.agent_id;
    return data;
  }

  async homologate(division: 'pure' | 'open' = 'open', seasonId?: string): Promise<Json> {
    const season = seasonId ?? currentSeasonId();
    return this.signed<Json>('POST', `/api/agents/${this.agentId}/homologate`, {
      season_id: season,
      division,
      model_id: 'e2e-driver/1.0',
      adapter_kind: 'api',
      endpoint_url: null,
      system_prompt_sha256: sha256Hex('e2e driver has no system prompt'),
      config_sha256: sha256Hex(canonicalJson({ e2e: true })),
      tool_access: division === 'pure' ? 'pure' : 'engine-assisted',
    });
  }

  async lobbyJoin(game: string, variant = 'standard', division: 'pure' | 'open' = 'open'): Promise<Json> {
    return this.signed<Json>('POST', '/api/lobby/join', { game, variant, division });
  }

  async lobbyLeave(game: string, variant = 'standard', division: 'pure' | 'open' = 'open'): Promise<Json> {
    return this.signed<Json>('POST', '/api/lobby/leave', { game, variant, division });
  }

  /** Authenticated pulse (adds waiting_on_you). */
  async pulse(): Promise<{ waiting_on_you?: { game_id: string; turn_index: number | null; deadline_utc: string | null }[] }> {
    return this.signed('GET', '/api/pulse');
  }

  async myGames(status: 'live' | 'ended' = 'live'): Promise<{ games: GameSummary[] }> {
    return this.signed('GET', '/api/my/games', undefined, `?status=${status}`);
  }

  async game(id: string): Promise<{ game: GameSummary }> {
    return this.unauthed('GET', `/api/games/${id}`);
  }

  async events(id: string, since = 0): Promise<{ events: SpectatorEventRow[] }> {
    return this.unauthed('GET', `/api/games/${id}/events?since=${since}`);
  }

  async replay(id: string): Promise<{ replay: Json }> {
    return this.unauthed('GET', `/api/games/${id}/replay`);
  }

  async leaderboard(query: string): Promise<{ leaderboard: { agent_id: string; handle: string; rating: number; games_played: number }[] }> {
    return this.unauthed('GET', `/api/leaderboards${query}`);
  }

  async view(id: string, transport: Transport = 'http'): Promise<ViewObject> {
    if (transport === 'mcp') {
      const data = await this.mcpSigned<{ view: ViewObject }>('view', 'GET', `/api/games/${encodeURIComponent(id)}/view`, { id });
      return data.view;
    }
    const data = await this.signed<{ view: ViewObject }>('GET', `/api/games/${id}/view`);
    return data.view;
  }

  async legalMoves(id: string, transport: Transport = 'http'): Promise<{ turn_index: number | null; legal_moves: LegalMoveEntry[] }> {
    if (transport === 'mcp') {
      return this.mcpSigned('legal_moves', 'GET', `/api/games/${encodeURIComponent(id)}/legal_moves`, { id });
    }
    return this.signed('GET', `/api/games/${id}/legal_moves`);
  }

  /** Build + sign a MoveSubmission body (the frozen ludus.move.v1 signature). */
  signMoveBody(sub: MoveSubmission): Json {
    const body = sub as unknown as Json;
    const signature = this.sign(
      `${MOVE_SIGN_PREFIX}:${sub.game_id}:${sub.turn_index}:${sha256Hex(canonicalJson(body))}`,
    );
    return { ...(sub as unknown as Record<string, Json>), signature };
  }

  async move(
    gameId: string,
    turnIndex: number,
    move: string | { index: number },
    opts: {
      commentary?: string;
      /** In-game speech (speech games only); signed with the rest of the body. */
      utterance?: string;
      resign?: boolean;
      draw_offer?: boolean;
      transport?: Transport;
    } = {},
  ): Promise<{ verdict: MoveVerdict }> {
    const sub: MoveSubmission = { game_id: gameId, turn_index: turnIndex, move };
    if (opts.commentary !== undefined) sub.commentary = opts.commentary;
    if (opts.utterance !== undefined) sub.utterance = opts.utterance;
    if (opts.resign) sub.resign = true;
    if (opts.draw_offer) sub.draw_offer = true;
    const body = this.signMoveBody(sub);
    if (opts.transport === 'mcp') {
      return this.mcpSigned<{ verdict: MoveVerdict }>('move', 'POST', `/api/games/${encodeURIComponent(gameId)}/moves`, { id: gameId }, body);
    }
    return this.signed<{ verdict: MoveVerdict }>('POST', `/api/games/${gameId}/moves`, body);
  }

  async resign(gameId: string, turnIndex: number, transport: Transport = 'http'): Promise<{ verdict: MoveVerdict }> {
    return this.move(gameId, turnIndex, { index: 0 }, { resign: true, transport });
  }
}

export function currentSeasonId(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

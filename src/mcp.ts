/**
 * MCP server (JSON-RPC 2.0 over HTTP POST) at /mcp, with a read-only door at
 * /mcp/read for spectators' tools. Tools are GENERATED from the same route
 * table (src/doc.ts) the HTTP router uses, and tools/call delegates to the
 * SAME handler functions (src/api/handlers.ts) — HTTP and MCP cannot diverge.
 *
 * Signed tools take `agent`, `challenge`, `signature` arguments mirroring the
 * X-Ludus-* headers. The signature is Ed25519 over
 *   'ludus.auth.v1:' + handle + ':' + challenge + ':' + METHOD + ':' + path
 * where METHOD and path are those of the underlying HTTP route (path with
 * params substituted), and for POST-shaped tools additionally
 *   ':' + sha256Hex(canonicalJson(arguments.body))
 * — the server serializes arguments.body with canonicalJson so both sides
 * hash identical bytes. Challenges come from GET /api/auth/challenge.
 */

import { canonicalJson } from './crypto/canonical.ts';
import {
  MCP_ALIASES,
  MCP_READ_ONLY_TOOLS,
  MCP_TOOL_ORDER,
  NO_KEY_SENTENCE,
  ROUTES,
  type RouteDef,
} from './doc.ts';
import type { Json } from './kernel/types.ts';
import type { ApiEnv } from './api/env.ts';
import { HANDLERS, type HandlerRequest } from './api/handlers.ts';
import type { ApiResult } from './api/http.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

// ---------------------------------------------------------------------------
// Tool table (derived once from the route table)
// ---------------------------------------------------------------------------

interface ToolSpec {
  name: string;
  route: RouteDef;
  routeKey: string;
  summary: string;
  /** For alias tools (resign, offer_draw): body flags that MUST be present. */
  preset?: Record<string, boolean>;
  readOnly: boolean;
}

function buildToolTable(): ToolSpec[] {
  const byName = new Map<string, ToolSpec>();
  for (const r of ROUTES) {
    if (!r.mcp_tool) continue;
    byName.set(r.mcp_tool, {
      name: r.mcp_tool,
      route: r,
      routeKey: `${r.method} ${r.path}`,
      summary: r.summary,
      readOnly: MCP_READ_ONLY_TOOLS.has(r.mcp_tool),
    });
  }
  for (const alias of MCP_ALIASES) {
    const [method, ...pathParts] = alias.route.split(' ');
    const path = pathParts.join(' ');
    const route = ROUTES.find((r) => `${r.method} ${r.path}` === `${method} ${path}`);
    if (!route) throw new Error(`MCP alias ${alias.name} references unknown route ${alias.route}`);
    byName.set(alias.name, {
      name: alias.name,
      route,
      routeKey: alias.route,
      summary: alias.summary,
      preset: alias.preset,
      readOnly: MCP_READ_ONLY_TOOLS.has(alias.name),
    });
  }
  // Spec order, exactly (a test compares tools/list to spec api.mcp_tools).
  return MCP_TOOL_ORDER.map((name) => {
    const spec = byName.get(name);
    if (!spec) throw new Error(`spec mcp tool '${name}' missing from route table`);
    return spec;
  });
}

export const TOOLS: ToolSpec[] = buildToolTable();

function inputSchemaFor(tool: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of tool.route.params ?? []) {
    if (p.in === 'path') {
      properties[p.name] = { type: 'string', description: p.description };
      required.push(p.name);
    } else if (p.in === 'query') {
      properties[p.name] = { type: 'string', description: `(optional) ${p.description}` };
    }
  }
  const bodyParams = (tool.route.params ?? []).filter((p) => p.in === 'body');
  if (tool.route.method === 'POST') {
    const bodyProps: Record<string, unknown> = {};
    const bodyRequired: string[] = [];
    for (const p of bodyParams) {
      bodyProps[p.name] = { description: p.description };
      if (p.required) bodyRequired.push(p.name);
    }
    properties.body = {
      type: 'object',
      description:
        'The request body. Signed tools: your signature covers sha256Hex(canonicalJson(body)).' +
        (tool.preset ? ` Must include ${Object.keys(tool.preset).map((k) => `${k}: true`).join(', ')}.` : ''),
      properties: bodyProps,
      ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
    };
    required.push('body');
  }
  if (tool.route.auth === 'signed') {
    properties.agent = { type: 'string', description: 'your handle' };
    properties.challenge = { type: 'string', description: 'single-use challenge from GET /api/auth/challenge' };
    properties.signature = {
      type: 'string',
      description:
        `Ed25519 hex over 'ludus.auth.v1:<agent>:<challenge>:${tool.route.method}:<path>'` +
        (tool.route.method === 'POST' ? ` + ':' + sha256Hex(canonicalJson(body))` : ''),
    };
    required.push('agent', 'challenge', 'signature');
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

export function toolsList(readOnlyDoor: boolean): Json {
  const tools = TOOLS.filter((t) => !readOnlyDoor || t.readOnly).map((t) => ({
    name: t.name,
    description: `${t.summary} ${t.route.auth === 'signed' ? '(signed) ' : ''}${NO_KEY_SENTENCE}`,
    inputSchema: inputSchemaFor(t) as Json,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly && (t.name === 'resign'), openWorldHint: false },
  }));
  return { tools } as unknown as Json;
}

// ---------------------------------------------------------------------------
// tools/call -> the same handlers as HTTP
// ---------------------------------------------------------------------------

class McpArgError extends Error {}

function argString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) throw new McpArgError(`argument '${name}' must be a non-empty string`);
  return v;
}

interface HeaderBag {
  get(name: string): string | null;
}

function headerBag(entries: Record<string, string>): HeaderBag {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

export async function callTool(env: ApiEnv, name: string, rawArgs: unknown, readOnlyDoor: boolean): Promise<{ result: Json; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new McpArgError(`unknown tool '${name}'`);
  if (readOnlyDoor && !tool.readOnly) {
    throw new McpArgError(`tool '${name}' is not available on the read-only door /mcp/read; use /mcp`);
  }
  const args = (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;

  // Substitute path params.
  let path = tool.route.path;
  for (const p of tool.route.params ?? []) {
    if (p.in === 'path') path = path.replace(`:${p.name}`, encodeURIComponent(argString(args, p.name)));
  }
  const params: Record<string, string> = {};
  for (const p of tool.route.params ?? []) {
    if (p.in === 'path') params[p.name] = argString(args, p.name);
  }

  // Query params.
  const query = new URLSearchParams();
  for (const p of tool.route.params ?? []) {
    if (p.in === 'query') {
      const v = args[p.name];
      if (typeof v === 'string' && v !== '') query.set(p.name, v);
    }
  }

  // Body: canonical serialization so the caller's signature over
  // sha256Hex(canonicalJson(body)) matches what the auth layer hashes.
  let rawBody: string | null = null;
  let json: Json | null = null;
  if (tool.route.method === 'POST') {
    const body = args.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new McpArgError(`argument 'body' must be an object`);
    }
    if (tool.preset) {
      for (const [k, v] of Object.entries(tool.preset)) {
        if ((body as Record<string, unknown>)[k] !== v) {
          throw new McpArgError(`tool '${name}' requires body.${k} = ${String(v)} (your signature must cover it)`);
        }
      }
    }
    json = body as Json;
    rawBody = canonicalJson(json);
  }

  const headers: Record<string, string> = {};
  if (tool.route.auth === 'signed') {
    headers['x-ludus-agent'] = argString(args, 'agent');
    headers['x-ludus-challenge'] = argString(args, 'challenge');
    headers['x-ludus-signature'] = argString(args, 'signature');
  }

  const handler = HANDLERS[tool.routeKey];
  if (!handler) throw new Error(`route ${tool.routeKey} has no handler`);
  const req: HandlerRequest = {
    method: tool.route.method,
    path,
    origin: 'https://ludus.invalid',
    params,
    query,
    headers: headerBag(headers),
    rawBody,
    json,
  };
  const out = await handler(env, req);
  if (out instanceof Response) {
    const textBody = await out.text();
    let parsed: Json = textBody;
    const ct = out.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try {
        parsed = JSON.parse(textBody) as Json;
      } catch {
        /* keep text */
      }
    }
    return { result: parsed, isError: !out.ok };
  }
  const apiResult = out as ApiResult;
  return { result: apiResult.body as unknown as Json, isError: apiResult.body.ok !== true };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: Json): Json {
  return { jsonrpc: '2.0', id: (id ?? null) as Json, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: (id ?? null) as Json, error: { code, message } };
}

export async function handleMcpRpc(env: ApiEnv, body: unknown, readOnlyDoor: boolean): Promise<Json | null> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid request: expected a single JSON-RPC 2.0 request object.');
  }
  const req = body as RpcRequest;
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;

  if (req.jsonrpc !== '2.0') return rpcError(id, -32600, "Invalid request: jsonrpc must be '2.0'.");

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: readOnlyDoor ? 'naibul-read' : 'naibul', version: '1.0.0' },
        instructions:
          'Naibul: an agent-only board-game hall. Call the rules/game/leaderboard tools freely; signed tools need a ' +
          'challenge from GET /api/auth/challenge and an Ed25519 signature (see each tool description). ' +
          NO_KEY_SENTENCE,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification: no response body
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolsList(readOnlyDoor));
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      try {
        const { result, isError } = await callTool(env, name, params.arguments, readOnlyDoor);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError,
        });
      } catch (e) {
        if (e instanceof McpArgError) return rpcError(id, -32602, e.message);
        console.error(`mcp tools/call ${name} threw:`, e);
        return rpcError(id, -32603, 'Internal error; it has been logged.');
      }
    }
    default:
      return rpcError(id, -32601, `Method '${method}' not found. Methods: initialize, ping, tools/list, tools/call.`);
  }
}

/** HTTP entry for POST /mcp and POST /mcp/read (GET returns a hint). */
export async function handleMcpHttp(env: ApiEnv, request: Request, readOnlyDoor: boolean): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        hint: 'POST JSON-RPC 2.0 here. Discovery: /.well-known/mcp.json. ' + NO_KEY_SENTENCE,
      }),
      { status: 405, headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' } },
    );
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error: body must be JSON.')), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const result = await handleMcpRpc(env, parsed, readOnlyDoor);
  if (result === null) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

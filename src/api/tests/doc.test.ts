/**
 * The single route table generates every discovery surface (front door,
 * llms.txt, openapi.json, mcp.json), the router, and the MCP tool list —
 * and every surface carries THE no-key sentence (gate A14, front-door half).
 */

import { describe, expect, it } from 'vitest';
import {
  API_BOUNDARY,
  MCP_ALIASES,
  MCP_TOOL_ORDER,
  NO_KEY_SENTENCE,
  ROUTES,
  frontDoorText,
  llmsTxt,
  mcpWellKnown,
  openapiJson,
} from '../../doc.ts';
import { HANDLERS } from '../handlers.ts';
import { matchRoute } from '../router.ts';
import { makeTestEnv } from './fakes.ts';
import { apiRequest } from './helpers.ts';
import { handleApiRequest } from '../router.ts';

describe('route table', () => {
  it('every route has a handler and every handler has a route (1:1)', () => {
    const routeKeys = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    const handlerKeys = Object.keys(HANDLERS).sort();
    expect(handlerKeys).toEqual(routeKeys);
  });

  it('every spec mcp tool maps to a route or alias', () => {
    const names = new Set(ROUTES.filter((r) => r.mcp_tool).map((r) => r.mcp_tool));
    for (const alias of MCP_ALIASES) names.add(alias.name);
    expect([...MCP_TOOL_ORDER].sort()).toEqual([...names].sort());
  });

  it('matches concrete paths with params', () => {
    const m = matchRoute('GET', '/api/games/g_123/replay');
    expect(m?.route.key).toBe('GET /api/games/:id/replay');
    expect(m?.params).toEqual({ id: 'g_123' });
    expect(matchRoute('GET', '/api/nope')).toBeNull();
    expect(matchRoute('POST', '/api/games')).toBeNull(); // wrong method
  });
});

describe('front door (GET /)', () => {
  it('serves text/plain with the no-key sentence, quotas, and every route', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(env, apiRequest('GET', '/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain(NO_KEY_SENTENCE);
    expect(body).toContain('never generates or stores private keys');
    expect(body).toContain('hostile');
    expect(body).toContain('50 game joins, 20 concurrent games');
    expect(body).toContain('120 requests/minute/IP');
    expect(body).toContain('A rejected request never spends a quota');
    for (const r of ROUTES) expect(body).toContain(r.path);
    expect(body).toContain(API_BOUNDARY);
  });

  it('llms.txt tells the same story', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(env, apiRequest('GET', '/llms.txt'));
    const body = await res.text();
    expect(body).toContain(NO_KEY_SENTENCE);
    expect(body).toContain('/openapi.json');
    expect(body).toContain('/mcp');
  });
});

describe('openapi.json', () => {
  it('is OpenAPI 3.1 with one path item per route path and the sentence', () => {
    const doc = openapiJson('https://ludus.test') as {
      openapi: string;
      info: { description: string };
      paths: Record<string, Record<string, { summary?: string }>>;
      components: { securitySchemes: { ludusChallenge: { description: string } } };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.description).toContain(NO_KEY_SENTENCE);
    const distinctPaths = new Set(ROUTES.map((r) => r.path.replace(/:([a-zA-Z_]+)/g, '{$1}')));
    expect(Object.keys(doc.paths).sort()).toEqual([...distinctPaths].sort());
    for (const r of ROUTES) {
      const oa = doc.paths[r.path.replace(/:([a-zA-Z_]+)/g, '{$1}')];
      expect(oa?.[r.method.toLowerCase()]?.summary).toBe(r.summary);
    }
    expect(doc.components.securitySchemes.ludusChallenge.description).toContain(NO_KEY_SENTENCE);
  });
});

describe('/.well-known/mcp.json', () => {
  it('advertises both doors, the tool list, and the sentence', () => {
    const doc = mcpWellKnown('https://ludus.test') as {
      description: string;
      endpoints: { mcp: string; read_only: string };
      tools: { name: string; read_only: boolean }[];
    };
    expect(doc.description).toContain(NO_KEY_SENTENCE);
    expect(doc.endpoints.mcp).toBe('https://ludus.test/mcp');
    expect(doc.endpoints.read_only).toBe('https://ludus.test/mcp/read');
    expect(doc.tools.map((t) => t.name)).toEqual([...MCP_TOOL_ORDER]);
  });
});

describe('generated docs stay in sync', () => {
  it('front door and llms.txt list identical route sets', () => {
    const front = frontDoorText('https://x');
    const llms = llmsTxt('https://x');
    for (const r of ROUTES) {
      expect(front).toContain(`${r.method.padEnd(4)} ${r.path}`.trimEnd());
      expect(llms).toContain(`${r.method} https://x${r.path}`);
    }
  });
});

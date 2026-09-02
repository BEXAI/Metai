/**
 * Router over the ONE route table in src/doc.ts. Matching is by method +
 * exact segment count, with ':name' segments captured as params. Rate
 * limiting (120 req/min/IP, best-effort KV token bucket) applies to /api/*
 * BEFORE any handler runs, so a rate-limited request can never spend a quota.
 */

import { ROUTES, type RouteDef } from '../doc.ts';
import type { Json } from '../kernel/types.ts';
import type { ApiEnv } from './env.ts';
import { HANDLERS, type HandlerRequest } from './handlers.ts';
import { err, toResponse, type ApiResult } from './http.ts';
import { allowRequest } from './ratelimit.ts';

export interface CompiledRoute {
  def: RouteDef;
  key: string; // 'GET /api/games/:id'
  segments: string[];
}

export function compileRoutes(): CompiledRoute[] {
  return ROUTES.map((def) => ({
    def,
    key: `${def.method} ${def.path}`,
    segments: def.path === '/' ? [''] : def.path.split('/').slice(1),
  }));
}

const COMPILED = compileRoutes();

export function matchRoute(method: string, pathname: string): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = pathname === '/' ? [''] : pathname.split('/').slice(1);
  for (const route of COMPILED) {
    if (route.def.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let okMatch = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i]!;
      const part = parts[i]!;
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(part);
      } else if (seg !== part) {
        okMatch = false;
        break;
      }
    }
    if (okMatch) return { route, params };
  }
  return null;
}

/** Full request pipeline used by the Worker fetch handler and by tests. */
export async function handleApiRequest(env: ApiEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (method !== 'GET' && method !== 'POST') {
    return toResponse(err(405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are used here. GET / for instructions.'));
  }

  if (pathname.startsWith('/api/')) {
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    const allowed = await allowRequest(env, ip);
    if (!allowed) {
      return toResponse(err(429, 'RATE_LIMITED', 'Rate limit: 120 requests per minute per IP on /api/*. Slow down; nothing was spent.'));
    }
  }

  const matched = matchRoute(method, pathname);
  if (!matched) {
    return toResponse(err(404, 'NOT_FOUND', `No route ${method} ${pathname}. GET / lists every route.`));
  }
  const handler = HANDLERS[matched.route.key];
  if (!handler) {
    return toResponse(err(500, 'NO_HANDLER', `Route ${matched.route.key} has no handler (build error).`));
  }

  let rawBody: string | null = null;
  let json: Json | null = null;
  if (method === 'POST') {
    try {
      rawBody = await request.text();
    } catch {
      rawBody = '';
    }
    if (rawBody !== '') {
      try {
        json = JSON.parse(rawBody) as Json;
      } catch {
        return toResponse(err(400, 'BAD_JSON', 'Body must be valid JSON.'));
      }
    }
  }

  const req: HandlerRequest = {
    method,
    path: pathname,
    origin: url.origin,
    params: matched.params,
    query: url.searchParams,
    headers: request.headers,
    rawBody,
    json,
  };

  try {
    const result = await handler(env, req);
    return result instanceof Response ? result : toResponse(result as ApiResult);
  } catch (e) {
    console.error(`handler ${matched.route.key} threw:`, e);
    return toResponse(err(500, 'INTERNAL', 'Internal error; it has been logged.'));
  }
}

/**
 * JSON response envelope used by every API endpoint (spec §api $comment):
 * every response carries `metadata.boundary` marking agent-authored fields
 * as untrusted data, never instructions.
 *
 * Shape:
 *   ok:    { ok: true,  data, metadata: { boundary, untrusted_fields? } }
 *   error: { ok: false, error: { code, message }, metadata: { boundary } }
 */

import type { Json } from '../kernel/types.ts';
import { API_BOUNDARY } from '../doc.ts';

export interface ApiError {
  ok: false;
  error: { code: string; message: string };
  /** Optional structured context (e.g. the restated legal move list). */
  data?: Json;
  metadata: { boundary: string };
}

export interface ApiOk {
  ok: true;
  data: Json;
  metadata: { boundary: string; untrusted_fields?: string[] };
}

export type ApiResult = { status: number; body: ApiOk | ApiError };

export function ok(data: Json, untrustedFields?: string[], status = 200): ApiResult {
  const metadata: ApiOk['metadata'] = { boundary: API_BOUNDARY };
  if (untrustedFields && untrustedFields.length > 0) metadata.untrusted_fields = untrustedFields;
  return { status, body: { ok: true, data, metadata } };
}

export function err(status: number, code: string, message: string, data?: Json): ApiResult {
  const body: ApiError = { ok: false, error: { code, message }, metadata: { boundary: API_BOUNDARY } };
  if (data !== undefined) body.data = data;
  return { status, body };
}

export function toResponse(r: ApiResult): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}


export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function asString(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

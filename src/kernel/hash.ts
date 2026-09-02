/**
 * hashState: sha256 over canonical JSON of the state (uniform for every game;
 * appended to every log entry). A game never implements its own hashing.
 */

import { hashJson } from '../crypto/canonical.ts';
import type { Json } from './types.ts';

export function hashState(state: Json): string {
  return hashJson(state);
}

/**
 * Werewolf constants, closed enums, and the two pure text helpers every other
 * werewolf module shares. This file is a LEAF: it imports nothing from the
 * game, so rules.ts, notation.ts and render.ts can all depend on it without a
 * cycle.
 *
 * WHY normalizeSpeech / capText LIVE HERE AND NOT IN notation.ts.
 * The plan lists them under notation.ts, but the in-tree layering is
 * rules.ts -> (nothing in the game) and notation.ts -> rules.ts
 * (`islanders/notation.ts:8-20` imports values out of `islanders/rules.ts`;
 * rules.ts never imports notation.ts). `applyMove` needs normalizeSpeech for
 * its `text === normalizeSpeech(text)` assertion, so putting it in notation.ts
 * would invert that layering into a runtime cycle. notation.ts MUST re-export
 * these two functions — `export { capText, normalizeSpeech } from './board.ts'`
 * — and must never redefine them: two implementations of the normaliser is two
 * ways to compute the move object, which is a replay divergence waiting to
 * happen (verify.ts:327-330 string-compares the recomputed notation).
 *
 * The character classes below are written as \uXXXX escapes ONLY. Literal
 * control or zero-width bytes in source are exactly what an editor or
 * formatter silently mangles, and a mangled class changes the move object and
 * diverges every historical replay. There is also deliberately NO call to
 * String.prototype's Unicode normaliser anywhere in this game (a grep test
 * pins its absence, so do not name it here either): the room runs in
 * workerd, the verifier runs in Node and in a browser bundle
 * (web/verify-entry.ts), and an ICU version skew on the move-resolution path
 * would look exactly like tampering.
 */

// ---------------------------------------------------------------------------
// Caps, rounds, limits
// ---------------------------------------------------------------------------

/** day_talk / day_defense. 600, not 280: two sentences flattens every model. */
export const MAX_SPEECH_CHARS = 600;
/** night whisper (wolves) / private note (everyone else). */
export const MAX_NIGHT_CHARS = 300;
/** vote / abstain statement. */
export const MAX_BALLOT_CHARS = 200;

/** Simultaneous discussion rounds per day. */
export const TALK_ROUNDS = 2;
/** The game ends (wolves win) once `day` passes this. */
export const DAY_LIMIT = 6;
/** meta.historyWindow: ~1.8 cycles at 33 history rows per cycle (NOT 2.5). */
export const HISTORY_WINDOW = 60;
/** The whole seat configuration; meta.players is { min: 8, max: 8 }. */
export const SEAT_COUNT = 8;

/**
 * Per-phase move budgets (Game.phaseBudgetMs). A simultaneous phase costs ONE
 * shared deadline, not eight sequential ones, so a full cycle is bounded by
 * 60 + 150 + 150 + 60 + 60 = 480 s and the whole game by DAY_LIMIT * 480 s.
 */
export const NIGHT_BUDGET_MS = 60_000;
export const TALK_BUDGET_MS = 150_000;
export const DEFENSE_BUDGET_MS = 60_000;
export const VOTE_BUDGET_MS = 60_000;

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
export type Verdict = 'wolf' | 'clear';
export type Cause = 'lynch' | 'wolves' | 'abandoned';
export type Phase = 'night' | 'day_talk' | 'day_defense' | 'day_vote' | 'over';

/**
 * Dealt by ONE seeded shuffle, purpose string 'deal:roles'. 2 wolves keeps the
 * pack channel alive and lands the random-play town baseline near 23%; the
 * seer is the only source of ground truth in the language layer; the doctor
 * plus the suppressed save flag makes a quiet night ambiguous, which turns a
 * wolf `stay_in` into a real bluff. No hunter and no vigilante: both need an
 * interstitial single-actor shot phase, which risks a zero-mover state and
 * flips the night onto the sequential path.
 */
export const ROLE_MULTISET: readonly Role[] = [
  'werewolf',
  'werewolf',
  'seer',
  'doctor',
  'villager',
  'villager',
  'villager',
  'villager',
];

/** Canonical order for claim(r) enumeration and for role listings. */
export const ROLES_CANON: readonly Role[] = ['werewolf', 'seer', 'doctor', 'villager'];
/** Canonical order for report(q,v) enumeration. */
export const VERDICTS_CANON: readonly Verdict[] = ['wolf', 'clear'];

/**
 * `archivedDigest` before anything has been archived. PINNED AND FROZEN: the
 * offline verifier recomputes the digest chain from initialState, so changing
 * this changes every historical state hash. 64 zeros rather than '' so the
 * field is always a fixed-width hex digest and renderers can slice it.
 */
export const GENESIS_DIGEST = '0000000000000000000000000000000000000000000000000000000000000000';

/** Characters of speech accepted in `move.text` in this phase. */
export function capFor(phase: Phase): number {
  switch (phase) {
    case 'night':
      return MAX_NIGHT_CHARS;
    case 'day_talk':
    case 'day_defense':
      return MAX_SPEECH_CHARS;
    case 'day_vote':
      return MAX_BALLOT_CHARS;
    case 'over':
      return 0;
  }
}

export function isRoleName(x: string): x is Role {
  return ROLES_CANON.includes(x as Role);
}

export function isVerdictName(x: string): x is Verdict {
  return VERDICTS_CANON.includes(x as Verdict);
}

/** How many of `role` the deal contains. Public: the composition is published. */
export function countRole(roles: readonly Role[], role: Role): number {
  return roles.filter((r) => r === role).length;
}

// ---------------------------------------------------------------------------
// Speech normalisation
// ---------------------------------------------------------------------------

/**
 * Cc / C1 controls MINUS \t \n \r, which the next pass turns into a space so
 * "a\nb" becomes "a b" and not "ab".
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Zero-width, bidi overrides/isolates, word joiner, invisible ops, BOM. */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/**
 * Every line separator. U+2028 and U+2029 are included because JSON.stringify
 * does NOT escape them and a renderer treats them as newlines — which is how a
 * forged transcript line gets smuggled inside the prompt fence.
 */
const LINE_SEPARATORS = /[\t\r\n\u2028\u2029]+/g;

/**
 * TOTAL, PURE and IDEMPOTENT. Called from parseMove and bindUtterance, NEVER
 * from moveToNotation: sanitising on the notation side would rewrite what an
 * agent already said and break every historical replay.
 */
export function normalizeSpeech(raw: string): string {
  return String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(LINE_SEPARATORS, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Surrogate-safe truncation. `.slice()` cuts by UTF-16 code unit and can split
 * a surrogate pair; a lone surrogate serialises differently on older engines,
 * which is exactly where the workerd room and the Node/browser verifier could
 * disagree about the state hash. The trailing trim keeps the result a
 * normalizeSpeech fixpoint.
 */
export function capText(s: string, cap: number): string {
  if (s.length <= cap) return s;
  let out = s.slice(0, cap);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // lone high surrogate
  return out.trimEnd();
}

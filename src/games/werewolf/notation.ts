/**
 * Werewolf move notation. Three pure surfaces:
 *
 *   wwMoveToNotation  the canonical string for the log, history and legal_moves
 *   parseWwMove       TOTAL — it never returns a ParseError
 *   wwMoveSummary     mechanics, never quality, never a target's role
 *
 * THE NIGHT REDACTION. Every night move — kill, stay_in, peek, guard, sleep,
 * any target, any text — notates as the single constant `night`. That is not
 * decoration; it is the only mechanism available. HistoryEntry has no
 * visibility field, rooms/core.ts pushes a history row for EVERY applied move,
 * kernel/view.ts ships `history` to every seat with no viewer argument and no
 * filter, and the room's public `move` spectator event carries the notation
 * verbatim to anyone watching. A literal `kill(p4)` would expose the pack live
 * to every villager and to /watch. Eight identical `night` tokens carry zero
 * bits.
 *
 * The redaction is VERIFIER-SAFE: kernel/verify.ts re-resolves the move from
 * the SIGNED SUBMISSION, recomputes the notation with this function, and only
 * string-compares. It never parses a logged notation. Night notation is
 * therefore deliberately NON-INJECTIVE: `night` parses back to the mover's
 * canonical abstain, which is exactly `legalMoves(s, p)[0]`.
 *
 * `wwMoveToNotation` takes NO state parameter. The Game interface passes one
 * and werewolf ignores it, exactly as islanders does. That is stronger than
 * the kernel requires and it matters: in resolveSimultaneous the notation for
 * a late seat is computed AFTER the earlier seats' moves have already applied,
 * so a state-dependent notation would be a silent coupling between
 * simultaneous movers.
 *
 * PARSING IS TOTAL. A ParseError routes into the frozen illegal-move policy —
 * three attempts force a random legal move plus a strike, and three strikes
 * now ELIMINATE a seat. An agent must never be struck for talking, so nothing
 * here ever returns one. Unrecognised input becomes plain speech in the day
 * phases; in the strict phases (night, day_vote) it is scanned for a seat
 * token and otherwise becomes the mover's canonical abstain. Legality stays
 * entirely apply()'s job, which is what lets vote(p99), claim(wizard) and
 * report(p1,wizard) all parse and come back as a specific RuleError instead of
 * an unhelpful `unrecognized move`.
 *
 * THE VERB TABLE IS PHASE-SCOPED (see verbActsIn). Totality is worthless if an
 * English sentence scans as another phase's verb: `sleep`, `night`, `kill`,
 * `guard`, `peek` and `vote` all start ordinary discussion sentences, and an
 * out-of-phase act in a SIMULTANEOUS phase is not rejected at submit time — it
 * surfaces at resolution as a forced random legal move plus a silent strike.
 * A verb this phase cannot act on therefore falls through to the totality rule
 * exactly like an unrecognised word. Argument errors are untouched: they are
 * in-phase and still reach apply().
 *
 * LENGTH IS NOT ENFORCED HERE. Over-length inline text is apply()'s
 * `text_too_long` RuleError, which does NOT consume the turn, so the agent can
 * shorten and resubmit. Truncating in the parser would silently change what an
 * agent said and clip mid-word into the hash chain. `bindUtterance` is the one
 * deliberate exception (it caps), and that asymmetry is documented in the
 * rules card, the howto traps and the generated docs.
 *
 * NORMALISATION happens here and in bindUtterance, never in
 * wwMoveToNotation: sanitising on the notation side would rewrite what an
 * agent already said and break every historical replay. The two helpers live
 * in board.ts (rules.ts needs normalizeSpeech for its apply() assertion, and
 * rules.ts must not import this file) and are re-exported here so callers have
 * one place to reach them.
 */

import type { PlayerId } from '../../kernel/types.ts';
import { capFor, capText, normalizeSpeech } from './board.ts';
import type { Seat, WwMove, WwState } from './rules.ts';

export { capText, normalizeSpeech };

/** The whole night, for every role, every target and every word. */
export const NIGHT_NOTATION = 'night';

// ---------------------------------------------------------------------------
// moveToNotation
// ---------------------------------------------------------------------------

/** `head` alone when the move is wordless, else `head "the words"`. */
function withText(head: string, text: unknown): string {
  return typeof text === 'string' && text !== '' ? `${head} ${JSON.stringify(text)}` : head;
}

export function wwMoveToNotation(move: WwMove): string {
  switch (move.t) {
    case 'kill':
    case 'stay_in':
    case 'peek':
    case 'guard':
    case 'sleep':
      return NIGHT_NOTATION; // THE CONSTANT — see the file header
    case 'say':
      return withText('say', move.text);
    case 'accuse':
      return withText(`accuse(${move.target})`, move.text);
    case 'defend':
      return withText(`defend(${move.target})`, move.text);
    case 'claim':
      return withText(`claim(${move.role})`, move.text);
    case 'report':
      return withText(`report(${move.target},${move.verdict})`, move.text);
    case 'vote':
      return withText(`vote(${move.target})`, move.text);
    case 'abstain':
      return withText('abstain', move.text);
  }
}

// ---------------------------------------------------------------------------
// parseMove
// ---------------------------------------------------------------------------

/**
 * ASCII-only case folding, deliberately hand-rolled. `toLowerCase` consults
 * Unicode case tables, which is the same class of engine-version dependency
 * this game refuses on the move-resolution path: the room runs in workerd and
 * the verifier runs in Node and in a browser bundle, and a table skew would
 * change the move object and look exactly like tampering. Verbs and arguments
 * are ASCII by construction, so folding only A-Z is lossless for them.
 */
function asciiLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : s[i]!;
  }
  return out;
}

type Call = {
  verb: string;
  /** Parenthesised arguments, or null when the caller used the bare form. */
  args: string[] | null;
  /** Everything after the verb (and after the closing paren, if any). */
  tail: string;
};

/** Index of the `)` closing `open`, skipping any JSON string literal. */
function matchParen(s: string, open: number): number {
  let inString = false;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ')') return i;
  }
  return -1;
}

/** Splits on commas that are not inside a JSON string literal. */
function splitArgs(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      cur += c;
      if (c === '\\' && i + 1 < body.length) cur += body[++i]!;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      cur += c;
      continue;
    }
    if (c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function scanCall(src: string): Call | null {
  const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src);
  if (!head) return null;
  const verb = asciiLower(head[0]);
  let i = head[0].length;
  let args: string[] | null = null;
  if (src[i] === '(') {
    const close = matchParen(src, i);
    if (close < 0) return null; // unbalanced: treat the whole input as speech
    args = splitArgs(src.slice(i + 1, close));
    i = close + 1;
  }
  return { verb, args, tail: src.slice(i).trim() };
}

/**
 * The three equivalent text tails, all reduced here:
 *   <verb> "…"          a JSON string literal (canonical)
 *   <verb>(args,"…")    the landlord-style comma form
 *   <verb> <bare rest>  unquoted; the remainder becomes the text
 */
function textFrom(raw: string): string {
  const t = raw.trim();
  if (t === '') return '';
  if (t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return normalizeSpeech(parsed);
    } catch {
      // An unbalanced quote is just text; fall through.
    }
  }
  return normalizeSpeech(t);
}

/** Pulls `arity` arguments out of a call, leaving the rest as the text. */
function takeArgs(call: Call, arity: number): { args: string[]; text: string } {
  if (call.args !== null) {
    const args = call.args.slice(0, arity);
    while (args.length < arity) args.push('');
    const extra = call.args.slice(arity).filter((a) => a !== '');
    const tail = [extra.join(','), call.tail].filter((x) => x !== '').join(' ');
    return { args: args.map(asciiLower), text: textFrom(tail) };
  }
  let rest = call.tail;
  const args: string[] = [];
  for (let i = 0; i < arity; i++) {
    const m = /^(\S+)\s*/.exec(rest);
    if (!m) {
      args.push('');
      continue;
    }
    args.push(asciiLower(m[1]!));
    rest = rest.slice(m[0].length);
  }
  return { args, text: textFrom(rest) };
}

/** The mover's null night act. A wolf declines to kill; everyone else sleeps. */
function nightAbstain(s: WwState, player: PlayerId, text: string): WwMove {
  return s.roles[player] === 'werewolf' ? { t: 'stay_in', text } : { t: 'sleep', text };
}

/** The first `pN` token anywhere in the input, or null. */
function firstSeatToken(src: string): string | null {
  const m = /\bp\d+\b/.exec(src);
  return m === null ? null : m[0];
}

/**
 * The verbs each phase recognises AS A MOVE. Anything else falls through to the
 * totality rule at the bottom of parseWwMove.
 *
 * WHY THE TABLE IS PHASE-SCOPED AND NOT GLOBAL. A global table makes ordinary
 * English a move. "Sleep tight." scans as the verb `sleep`; "night everyone,
 * see you tomorrow" as `night`; "kill the p3 wagon, it is a trap" as `kill`;
 * "guard your claims" as `guard`; "peek at p2 tonight if you are the seer" as
 * `peek`. Every one of those is an out-of-phase act in day_talk, and day_talk
 * is SIMULTANEOUS: rooms/core.ts checks only the submission's SHAPE at submit
 * time and returns ok:true, so the wrong_act does not surface until the phase
 * resolves — where it costs a seeded random legal move (a PERMANENT public
 * accuse/defend/claim/report written into the ledger that the seat never
 * wrote) plus a strike, with nothing in the agent's rejections list. Three
 * sentences eliminate a seat for talking, which is precisely what the totality
 * rule exists to make impossible.
 *
 * The stated benefit of a permissive table survives untouched, because it was
 * never about verbs from another phase: ARGUMENT errors still parse and still
 * come back as a specific RuleError on attempt 1 — vote(p99) is bad_target,
 * claim(wizard) is bad_role, report(p1,wizard) is bad_verdict.
 *
 * `over` keeps the whole table: the game has ended, every act is rejected with
 * the same message, and there is no phase left to mis-file it into.
 */
const NIGHT_VERBS: ReadonlySet<string> = new Set(['night', 'sleep', 'stay_in', 'kill', 'peek', 'guard']);
const DAY_VERBS: ReadonlySet<string> = new Set(['say', 'accuse', 'defend', 'claim', 'report']);
const BALLOT_VERBS: ReadonlySet<string> = new Set(['vote', 'abstain']);

function verbActsIn(phase: WwState['phase'], verb: string): boolean {
  switch (phase) {
    case 'night':
      return NIGHT_VERBS.has(verb);
    case 'day_talk':
    case 'day_defense':
      return DAY_VERBS.has(verb);
    case 'day_vote':
      return BALLOT_VERBS.has(verb);
    case 'over':
      return true;
  }
}

function fromCall(call: Call, s: WwState, player: PlayerId): WwMove | null {
  switch (call.verb) {
    case 'night': {
      // The redacted notation itself. It parses back to the canonical abstain,
      // which is legalMoves[0] — the fixpoint the replay walk relies on.
      return nightAbstain(s, player, takeArgs(call, 0).text);
    }
    case 'sleep':
      return { t: 'sleep', text: takeArgs(call, 0).text };
    case 'stay_in':
      return { t: 'stay_in', text: takeArgs(call, 0).text };
    case 'kill': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'kill', target: args[0]!, text };
    }
    case 'peek': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'peek', target: args[0]!, text };
    }
    case 'guard': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'guard', target: args[0]!, text };
    }
    case 'say':
      return { t: 'say', text: takeArgs(call, 0).text };
    case 'accuse': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'accuse', target: args[0]!, text };
    }
    case 'defend': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'defend', target: args[0]!, text };
    }
    case 'claim': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'claim', role: args[0]!, text };
    }
    case 'report': {
      const { args, text } = takeArgs(call, 2);
      return { t: 'report', target: args[0]!, verdict: args[1]!, text };
    }
    case 'vote': {
      const { args, text } = takeArgs(call, 1);
      return { t: 'vote', target: args[0]!, text };
    }
    case 'abstain':
      return { t: 'abstain', text: takeArgs(call, 0).text };
    default:
      return null;
  }
}

/**
 * TOTAL. Never returns a ParseError, in any phase, for any input — see the
 * file header for why that is a safety property and not laziness.
 *
 * Shape only: a verb legal in another phase still parses, so apply() can
 * answer with a specific RuleError on attempt 1 instead of the parser
 * answering with `unrecognized move` three times and a strike.
 *
 * In the STRICT phases the unrecognised-input fallback keeps the ACTION and
 * drops the words (there is nowhere sensible to put them, and carrying them
 * could trip apply()'s cap and cost a strike). An agent that wants both sends
 * its words in `utterance`: the move it lands on has an empty text slot, so
 * bindUtterance fills it.
 */
export function parseWwMove(input: string, s: WwState, player: PlayerId): WwMove {
  const src = normalizeSpeech(String(input ?? ''));
  if (src !== '') {
    const call = scanCall(src);
    if (call !== null && verbActsIn(s.phase, call.verb)) {
      const move = fromCall(call, s, player);
      if (move !== null) return move;
    }
  }

  // TOTALITY RULE — day phases: anything matching no verb is plain speech.
  if (s.phase === 'day_talk' || s.phase === 'day_defense') return { t: 'say', text: src };

  const seat = firstSeatToken(src);
  if (s.phase === 'day_vote') {
    return seat === null ? { t: 'abstain', text: '' } : { t: 'vote', target: seat, text: '' };
  }
  if (seat !== null) {
    const role = s.roles[player];
    if (role === 'werewolf') return { t: 'kill', target: seat, text: '' };
    if (role === 'seer') return { t: 'peek', target: seat, text: '' };
    if (role === 'doctor') return { t: 'guard', target: seat, text: '' };
  }
  return nightAbstain(s, player, '');
}

// ---------------------------------------------------------------------------
// bindUtterance
// ---------------------------------------------------------------------------

/**
 * TOTAL and PURE. Inline notation text ALWAYS wins; an utterance fills only an
 * empty text slot, so nobody is ever struck for supplying both channels.
 *
 * Called from exactly one shared helper (kernel/move.ts#resolveSubmittedMove),
 * consumed by both rooms/core.ts and kernel/verify.ts, and NEVER on the forced
 * or timeout paths — which is what guarantees a forced move always carries
 * text: '' and the engine can never attribute fabricated words to an agent.
 *
 * DOCUMENTED ASYMMETRY: an over-length utterance is SILENTLY CAPPED here,
 * whereas over-length INLINE text is REJECTED by apply() with a character
 * count and does not consume the turn.
 */
export function bindUtterance(m: WwMove, u: string, s: WwState, _p: PlayerId): WwMove {
  const text = (m as { text?: unknown } | null | undefined)?.text;
  if (typeof text !== 'string' || text !== '') return m;
  return { ...m, text: capText(normalizeSpeech(String(u ?? '')), capFor(s.phase)) };
}

// ---------------------------------------------------------------------------
// moveSummary
// ---------------------------------------------------------------------------

/**
 * MECHANICS, NEVER QUALITY: `KILL p3 tonight`, never `p3 is your best target`.
 * This is the line that stops the engine playing the game for a weak model.
 *
 * It is also the ONLY place a night target is legible, because the notation is
 * the constant `night` — an agent reading its own legal_moves needs the target
 * somewhere, and summaries only ever reach the acting player's own view
 * (kernel/view.ts assembles them per viewer) and the fixed-seed howto example.
 *
 * TWO CONTAINMENT RULES, both mechanically checkable:
 *  L6a NIGHT summaries name no seat's role but the viewer's own (they name no
 *      role at all) and contain no Verdict literal at all.
 *  L6b DAY summaries are byte-invariant under any role permutation fixing the
 *      viewer's own role and pack — which holds here trivially, because
 *      nothing below reads state.roles. `claim(r)` and `report(q,v)` are
 *      SPEAKER-CHOSEN assertions carrying zero engine bits.
 * Gate A10 cannot catch a role-naming summary (the harness does a plain
 * substring test and `KILL p3 (villager)` matches no probe), so these rules
 * are enforced by a dedicated containment test instead.
 */
export function wwMoveSummary(move: WwMove, _s: WwState): string {
  switch (move.t) {
    case 'kill':
      return `KILL ${move.target} tonight`;
    case 'stay_in':
      return 'STAY IN: the pack takes nobody tonight';
    case 'peek':
      return `CHECK ${move.target} tonight`;
    case 'guard':
      return `GUARD ${move.target} tonight`;
    case 'sleep':
      return 'SLEEP: no night action';
    case 'say':
      return move.text === '' ? 'SAY NOTHING (silence, and every seat sees it)' : 'SPEAK, naming nobody';
    case 'accuse':
      return `ACCUSE ${move.target}`;
    case 'defend':
      return `DEFEND ${move.target}`;
    case 'claim':
      return `CLAIM the role ${move.role}`;
    case 'report':
      return `REPORT ${move.target} as ${move.verdict}`;
    case 'vote':
      return `VOTE to lynch ${move.target}`;
    case 'abstain':
      return 'ABSTAIN (no vote counted)';
  }
}

/** Seat ids as the parser accepts them; used by the dossier and the docs. */
export function isSeatToken(x: string): x is Seat {
  return /^p\d+$/.test(x);
}

/**
 * Werewolf transcript theater — behavioural tests for
 * web/public/watch/js/pages/werewolf.js.
 *
 * The headline assertion is the second describe block: A LIVE GAME MUST
 * EXPOSE NO REVEAL DATA ANYWHERE IN THE DOM. Not hidden behind a class, not
 * parked in a data-* attribute, not sitting in a detached node waiting for a
 * toggle — absent. In the one UI in the hall whose entire premise is that
 * hidden information stays sealed until it is earned, "we hide it with CSS"
 * is not a defence.
 *
 * NO JSDOM. package.json's devDependencies are @cloudflare/workers-types,
 * @types/node, typescript, vitest and wrangler, and the no-new-dependency
 * rule holds, so this file ships a ~120-line DOM shim covering exactly the
 * surface web/public/watch/js/dom.js and the theater touch. That is a real
 * constraint, not a shortcut: it is also why the page keeps its model pure
 * and its renderers dumb.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The DOM shim. Installed before the page module is exercised; the module
// itself touches no DOM at import time (verified: top level is constants and
// function declarations only), so a static import is safe.
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor(private readonly owner: FakeNode) {}
  private list(): string[] {
    return String(this.owner.attrs['class'] ?? '')
      .split(/\s+/)
      .filter(Boolean);
  }
  private write(tokens: string[]): void {
    this.owner.attrs['class'] = tokens.join(' ');
  }
  contains(token: string): boolean {
    return this.list().includes(token);
  }
  add(...tokens: string[]): void {
    const l = this.list();
    for (const t of tokens) if (t && !l.includes(t)) l.push(t);
    this.write(l);
  }
  remove(...tokens: string[]): void {
    this.write(this.list().filter((t) => !tokens.includes(t)));
  }
  toggle(token: string, force?: boolean): boolean {
    const want = force === undefined ? !this.contains(token) : force;
    if (want) this.add(token);
    else this.remove(token);
    return want;
  }
}

class FakeNode {
  nodeType: number;
  tagName: string;
  data = '';
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  handlers: Record<string, ((ev: unknown) => void)[]> = {};
  classList: FakeClassList;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  value = '';

  constructor(nodeType: number, tagName: string) {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.classList = new FakeClassList(this);
  }

  get children(): FakeNode[] {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get textContent(): string {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((n) => n.textContent).join('');
  }
  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (ref === null || ref === undefined) return this.appendChild(child);
    const at = this.childNodes.indexOf(ref);
    if (at < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(at, 0, child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }
  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.handlers[type] ?? []) fn({});
  }
}

function makeElement(tag: string): FakeNode {
  return new FakeNode(1, String(tag).toLowerCase());
}

const fakeDocument = {
  createElement: (tag: string) => makeElement(tag),
  createElementNS: (_ns: string, tag: string) => makeElement(tag),
  createTextNode: (value: string) => {
    const n = new FakeNode(3, '#text');
    n.data = String(value);
    return n;
  },
  body: makeElement('body'),
  documentElement: makeElement('html'),
  scrollingElement: null as FakeNode | null,
  title: '',
};

(globalThis as unknown as { document: unknown }).document = fakeDocument;

// eslint-disable-next-line import/first -- the shim above must exist first.
import { applyBeat, atBeat, createTheater, foldEvent, createModel, sealedRowsFromReplay, tallyOf, veracityOf } from '../public/watch/js/pages/werewolf.js';

// ---------------------------------------------------------------------------
// Serialisation helpers — "anywhere in the DOM" means attributes, dataset
// values and text, not just the rendered words.
// ---------------------------------------------------------------------------

function serialize(node: FakeNode): string {
  if (node.nodeType === 3) return node.data;
  const attrs = Object.keys(node.attrs)
    .map((k) => `${k}="${node.attrs[k]}"`)
    .join(' ');
  const data = Object.keys(node.dataset)
    .map((k) => `data-${k}="${node.dataset[k]}"`)
    .join(' ');
  const head = [node.tagName, attrs, data].filter(Boolean).join(' ');
  return `<${head}>${node.childNodes.map(serialize).join('')}</${node.tagName}>`;
}

function allClasses(node: FakeNode, out = new Set<string>()): Set<string> {
  for (const t of String(node.attrs['class'] ?? '').split(/\s+/)) if (t) out.add(t);
  for (const c of node.children) allClasses(c, out);
  return out;
}

function findAll(node: FakeNode, pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (pred(node)) out.push(node);
  for (const c of node.children) findAll(c, pred, out);
  return out;
}

const hasClass = (cls: string) => (n: FakeNode) => n.classList.contains(cls);

// ---------------------------------------------------------------------------
// Fixtures: the game the plan describes. p4 hard-claims seer, p1
// counter-claims, the table lynches p4 — the wrong one — and only the
// post-game overlay shows p1's sealed night whisper.
// ---------------------------------------------------------------------------

const ROLES = {
  p0: 'villager',
  p1: 'werewolf',
  p2: 'doctor',
  p3: 'villager',
  p4: 'seer',
  p5: 'villager',
  p6: 'werewolf',
  p7: 'villager',
} as const;

const WHISPER = 'take the doctor claim tomorrow';

const SEATS = Object.keys(ROLES).map((p, i) => ({ player: p, agent_id: `a${i}`, handle: `agent-${i}`, pubkey_ed25519: '' }));

const ROW = { id: 'g-ww-1', game: 'werewolf', status: 'live', seats: SEATS };

const DAY1_TRANSCRIPT = [
  { seq: 0, day: 1, round: 0, speaker: 'p0', act: 'say', target: null, role: null, verdict: null, text: 'Quiet night. p4, anything?' },
  { seq: 1, day: 1, round: 0, speaker: 'p1', act: 'claim', target: null, role: 'seer', verdict: null, text: 'I am the seer. p2 is clear.' },
  { seq: 2, day: 1, round: 0, speaker: 'p2', act: 'say', target: null, role: null, verdict: null, text: 'Two seers. One of you is lying.' },
  { seq: 3, day: 1, round: 0, speaker: 'p4', act: 'report', target: 'p1', role: null, verdict: 'wolf', text: 'I checked p1 on night 1: wolf.' },
  { seq: 4, day: 1, round: 0, speaker: 'p5', act: 'say', target: null, role: null, verdict: null, text: '' },
  { seq: 5, day: 1, round: 0, speaker: 'p6', act: 'accuse', target: 'p4', role: null, verdict: null, text: 'p4 is fabricating. Vote p4.' },
  { seq: 6, day: 1, round: 0, speaker: 'p7', act: 'say', target: null, role: null, verdict: null, text: '' },
];

let seqCounter = 0;
function ev(type: string, data: unknown) {
  seqCounter += 1;
  return { seq: seqCounter, type, data, at: '2026-01-01T00:00:00.000Z' };
}

function pub(over: Record<string, unknown>) {
  return {
    day: 1,
    phase: 'night',
    round: 0,
    players: Object.keys(ROLES),
    alive: Object.keys(ROLES),
    dead: [],
    claims: [],
    reports: [],
    edges: [],
    vote_history: [],
    nights: [],
    defenders: [],
    defender: null,
    transcript: [],
    archived: { count: 0, digest: '' },
    acted_this_night: [],
    spoke_this_round: [],
    voted_this_phase: [],
    pending: [],
    wolves_remaining: 2,
    village_remaining: 6,
    ...over,
  };
}

/** The public spectator stream of a game that is STILL RUNNING. */
function liveEvents() {
  seqCounter = 0;
  const out: ReturnType<typeof ev>[] = [];
  out.push(ev('start', { public: pub({}) }));

  // Night 1, turn 0, seat order. p7 times out AT NIGHT — which must not bleed
  // into p7's deliberate day-1 silence.
  for (const p of Object.keys(ROLES)) {
    const isTimeout = p === 'p7';
    out.push(
      ev(isTimeout ? 'timeout' : 'move', {
        turn_index: 0,
        player: p,
        agent_id: 'a',
        notation: 'night',
        public: pub({}),
        ...(isTimeout ? { forced: 'timeout' } : {}),
      }),
    );
    if (isTimeout) out.push(ev('strike', { turn_index: 0, player: p, reason: 'timeout', strike_count: 1 }));
  }

  const afterDawn = pub({
    day: 1,
    phase: 'day_talk',
    round: 0,
    alive: ['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7'],
    dead: [{ seat: 'p3', day: 1, cause: 'wolves', role: 'villager' }],
    village_remaining: 5,
  });
  out.push(ev('game:dawn', { turn_index: 0, player: 'p7', data: { day: 1, died: 'p3', role: 'villager' } }));
  out.push(ev('game:phase', { turn_index: 0, player: 'p7', data: { day: 1, phase: 'day_talk', round: 0, pending: ['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7'] } }));

  // Day 1 discussion, turn 1. p5 times out mid-discussion.
  const talkers = ['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7'];
  talkers.forEach((p, i) => {
    const isTimeout = p === 'p5';
    const last = i === talkers.length - 1;
    out.push(
      ev(isTimeout ? 'timeout' : 'move', {
        turn_index: 1,
        player: p,
        agent_id: 'a',
        notation: 'say',
        // Only the LAST mover's snapshot carries the drained transcript: the
        // round settles inside its apply(). This is also the dedupe test —
        // the same rows arrive again as game:speech events below.
        public: last ? { ...afterDawn, phase: 'day_vote', transcript: DAY1_TRANSCRIPT } : afterDawn,
        ...(isTimeout ? { forced: 'timeout' } : {}),
      }),
    );
    if (isTimeout) out.push(ev('strike', { turn_index: 1, player: p, reason: 'timeout', strike_count: 2 }));
  });
  for (const u of DAY1_TRANSCRIPT) out.push(ev('game:speech', { turn_index: 1, player: 'p7', data: u }));
  out.push(ev('game:phase', { turn_index: 1, player: 'p7', data: { day: 1, phase: 'day_vote', round: 0, pending: talkers } }));

  const ballots = { p0: 'p4', p1: 'p4', p2: 'p4', p4: 'p1', p5: 'p4', p6: 'p4', p7: null };
  out.push(ev('game:ballots', { turn_index: 2, player: 'p7', data: { day: 1, ballots } }));
  out.push(
    ev('game:lynch', {
      turn_index: 2,
      player: 'p7',
      data: { day: 1, seat: 'p4', role: 'seer', tally: { p4: 5, p1: 1 }, abstains: 1, reason: 'plurality' },
    }),
  );
  out.push(ev('game:phase', { turn_index: 2, player: 'p7', data: { day: 2, phase: 'night', round: 0, pending: [] } }));
  return out;
}

/** The same stream, plus the post-'end' reveal. */
function endedEvents() {
  const out = liveEvents();
  out.push(ev('end', { result: { winners: ['p1', 'p6'], reason: 'parity' }, final_state_hash: 'x' }));
  out.push(ev('reveal', { roles: { ...ROLES }, commitment: 'c', reveal_secret: 's', final_seed: 'f', drand_round: 1 }));
  return out;
}

/** A replay whose log payloads carry the private night GameEvents. */
function replayFixture() {
  return {
    version: 'ludus.replay.v1',
    game_id: ROW.id,
    game: 'werewolf',
    initial_state: { roles: { ...ROLES } },
    log: [
      {
        seq: 3,
        kind: 'move',
        payload: {
          turn_index: 0,
          player: 'p1',
          events: [
            { type: 'pack_whisper', visibility: 'private', to: ['p1', 'p6'], data: { day: 1, from: 'p1', text: WHISPER } },
            { type: 'kill_intent', visibility: 'private', to: ['p1', 'p6'], data: { day: 1, by: 'p1', target: 'p3' } },
          ],
        },
      },
      {
        seq: 4,
        kind: 'move',
        payload: {
          turn_index: 0,
          player: 'p4',
          events: [{ type: 'peek_result', visibility: 'private', to: ['p4'], data: { day: 1, target: 'p1', verdict: 'wolf' } }],
        },
      },
      {
        seq: 5,
        kind: 'move',
        payload: {
          turn_index: 0,
          player: 'p2',
          events: [
            { type: 'guard_choice', visibility: 'private', to: ['p2'], data: { day: 1, target: 'p0' } },
            // A PUBLIC event in the same payload: must never become a sealed row.
            { type: 'dawn', visibility: 'public', data: { day: 1, died: 'p3', role: 'villager' } },
          ],
        },
      },
    ],
  };
}

function mountLive() {
  const host = makeElement('div');
  const t = createTheater(host, { row: { ...ROW, status: 'live' }, events: liveEvents() });
  return { host, t };
}

function mountEnded() {
  const host = makeElement('div');
  const t = createTheater(host, { row: { ...ROW, status: 'ended' }, events: endedEvents() });
  t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() });
  return { host, t };
}

// ---------------------------------------------------------------------------

describe('werewolf theater — the transcript', () => {
  let host: FakeNode;
  let t: ReturnType<typeof createTheater>;

  beforeEach(() => {
    const m = mountLive();
    host = m.host as unknown as FakeNode;
    t = m.t;
  });

  it('renders every utterance exactly once even though two channels deliver it', () => {
    // publicView.transcript (on the last mover's snapshot) AND game:speech
    // both carry seq 0..6. One key space, one row each.
    const rows = findAll(host, (n) => n.tagName === 'li' && n.dataset['seq'] !== undefined && n.dataset['seq'] !== '');
    const seqs = rows.map((n) => n.dataset['seq']);
    expect(seqs).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('attributes each row to its seat and stamps the day it belongs to', () => {
    const claim = findAll(host, (n) => n.dataset['seq'] === '1')[0]!;
    expect(claim.dataset['speaker']).toBe('p1');
    expect(claim.dataset['act']).toBe('claim');
    expect(claim.dataset['day']).toBe('1');
    expect(claim.classList.contains('ww-seat-1')).toBe(true);
    expect(claim.textContent).toContain('claims SEER');
    expect(claim.textContent).toContain('I am the seer.');
  });

  it('renders the phase and death dividers in stream order, each with its own beat', () => {
    const list = t.listEl as unknown as FakeNode;
    const labels = list.children.filter((n) => n.classList.contains('ww-divider')).map((n) => n.textContent);
    expect(labels.some((l) => l.includes('NIGHT 1'))).toBe(true);
    expect(labels.some((l) => l.includes('DAWN') && l.includes('p3 found dead') && l.includes('VILLAGER'))).toBe(true);
    expect(labels.some((l) => l.includes('DAY 1 — DISCUSSION'))).toBe(true);
    expect(labels.some((l) => l.includes('DAY 1 — VOTE'))).toBe(true);
    for (const n of list.children) expect(Number.isFinite(Number(n.dataset['beat']))).toBe(true);
  });

  it('never emits a phase divider twice for one transition', () => {
    const list = t.listEl as unknown as FakeNode;
    const votes = list.children.filter((n) => n.classList.contains('ww-divider') && n.textContent.includes('DAY 1 — VOTE'));
    expect(votes).toHaveLength(1);
  });

  it('A TIMEOUT IS NOT A SILENCE — the two render differently', () => {
    const timedOut = findAll(host, (n) => n.dataset['seq'] === '4')[0]!; // p5 timed out
    const silent = findAll(host, (n) => n.dataset['seq'] === '6')[0]!; // p7 chose silence

    expect(timedOut.classList.contains('ww-timeout')).toBe(true);
    expect(timedOut.classList.contains('ww-silent')).toBe(false);
    expect(timedOut.textContent).toContain('no answer');
    expect(timedOut.textContent).toContain('strike 2/3');

    expect(silent.classList.contains('ww-silent')).toBe(true);
    expect(silent.classList.contains('ww-timeout')).toBe(false);
    expect(silent.textContent).toContain('silent');
    expect(silent.textContent).not.toContain('no answer');
  });

  it("a NIGHT timeout does not bleed onto that seat's next day utterance", () => {
    // p7 timed out at night 1 and then deliberately said nothing on day 1.
    // Keying the forced flag on (seat, day, slot, round) is what stops the
    // night strike from libelling the day silence.
    const silent = findAll(host, (n) => n.dataset['seq'] === '6')[0]!;
    expect(silent.classList.contains('ww-timeout')).toBe(false);
  });

  it('renders the ballot: who voted for whom, plus the plurality outcome', () => {
    const card = findAll(host, hasClass('ww-ballot-card'))[0]!;
    expect(card).toBeDefined();
    const rows = findAll(card, hasClass('ww-ballot-row')).map((n) => n.textContent);
    expect(rows).toContain('p0→p4');
    expect(rows).toContain('p4→p1');
    expect(rows).toContain('p7→abstain');
    expect(card.textContent).toContain('p4 ×5');
    expect(card.textContent).toContain('abstains 1');
    expect(card.textContent).toContain('strict plurality — p4 is lynched');
    const lynch = findAll(host, (n) => n.classList.contains('ww-divider-lynch'))[0]!;
    expect(lynch.textContent).toContain('p4 lynched by strict plurality');
    expect(lynch.textContent).toContain('SEER');
  });

  it('STRICT PLURALITY: any tie is no lynch, and the card says so', () => {
    expect(tallyOf({ p0: 'p1', p1: 'p0', p2: null }).outcome).toBe('tie');
    expect(tallyOf({ p0: 'p1', p1: 'p0', p2: null }).lynched).toBeNull();
    expect(tallyOf({ p0: null, p1: null }).outcome).toBe('no_votes');
    expect(tallyOf({ p0: 'p1', p1: 'p1', p2: 'p0' })).toMatchObject({ outcome: 'plurality', lynched: 'p1' });

    const tieHost = makeElement('div');
    const model = createModel();
    foldEvent(model, { seq: 1, type: 'game:ballots', data: { turn_index: 0, player: 'p0', data: { day: 2, ballots: { p0: 'p1', p1: 'p0' } } }, at: null });
    const tie = createTheater(tieHost, { row: ROW, model });
    expect((tieHost as unknown as FakeNode).textContent).toContain('NO LYNCH');
    expect((tieHost as unknown as FakeNode).textContent).toContain('any tie is no lynch');
    tie.dispose();
  });

  it('renders agent text as text — a markup payload never becomes markup', () => {
    const model = createModel();
    const nasty = '<img src=x onerror=alert(1)> **not bold** [link](http://evil)';
    foldEvent(model, { seq: 1, type: 'start', data: { public: pub({}) }, at: null });
    foldEvent(model, {
      seq: 2,
      type: 'game:speech',
      data: { turn_index: 1, player: 'p0', data: { seq: 0, day: 1, round: 0, speaker: 'p0', act: 'say', target: null, role: null, verdict: null, text: nasty } },
      at: null,
    });
    const h = makeElement('div');
    const th = createTheater(h, { row: ROW, model });
    const row = findAll(h, (n) => n.dataset['seq'] === '0')[0]!;
    // The payload survives verbatim as CHARACTER DATA — no element named img
    // or a exists anywhere under the row.
    expect(row.textContent).toContain(nasty);
    expect(findAll(row, (n) => n.tagName === 'img' || n.tagName === 'a')).toEqual([]);
    th.dispose();
  });
});

describe('werewolf theater — a LIVE game leaks nothing', () => {
  it('exposes no reveal data anywhere in the DOM', () => {
    const { host } = mountLive();
    const dump = serialize(host as unknown as FakeNode);

    // The probe set mirrors src/games/werewolf/rules.ts#secretProbes: every
    // encoding a role could plausibly arrive in. Only seats that are still
    // ALIVE are probed — a lynched or night-killed seat's role is public by
    // the rules and is printed on purpose.
    for (const seat of ['p1', 'p6', 'p2', 'p0', 'p5', 'p7'] as const) {
      const role = ROLES[seat];
      expect(dump).not.toContain(`"${seat}":"${role}"`);
      expect(dump).not.toContain(`${seat} ${role.toUpperCase()}`);
      expect(dump).not.toContain(`"seat":"${seat}","role":"${role}"`);
    }
    // The sealed night channel, in every shape the replay carries it.
    expect(dump).not.toContain(WHISPER);
    expect(dump).not.toContain('pack_whisper');
    expect(dump).not.toContain('kill_intent');
    expect(dump).not.toContain('peek_result');
    expect(dump).not.toContain('guard_choice');
    expect(dump).not.toContain('"seer":"p4","target":"p1","verdict":"wolf"');
    expect(dump).not.toContain(JSON.stringify(ROLES));
  });

  it('builds no truth-overlay nodes at all — there is nothing to un-hide', () => {
    const { host } = mountLive();
    const node = host as unknown as FakeNode;
    const classes = allClasses(node);
    for (const cls of ['ww-truth-on', 'ww-sealed', 'ww-by-wolf', 'ww-lie', 'ww-true-claim', 'ww-fake-report', 'ww-true-report', 'ww-anomaly', 'ww-misdirect', 'ww-pack-cover', 'ww-role-badge']) {
      expect(classes.has(cls)).toBe(false);
    }
    expect(findAll(node, hasClass('ww-sealed'))).toEqual([]);
    expect(findAll(node, hasClass('ww-role-badge'))).toEqual([]);
    // The chip slots exist so the overlay is a classList pass later, but every
    // one of them is empty.
    const slots = findAll(node, hasClass('ww-truth-chip'));
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.textContent).toBe('');
  });

  it('shows the seal as DISABLED rather than absent, and refuses applyReveal', () => {
    const { host, t } = mountLive();
    const node = host as unknown as FakeNode;
    const btn = t.truthButton as unknown as FakeNode;
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(node.textContent).toContain('sealed until this game ends');

    // Even handed the real role map and the real replay, a live model refuses.
    expect(t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() })).toBe(false);
    expect(serialize(node)).not.toContain(WHISPER);
    expect(allClasses(node).has('ww-by-wolf')).toBe(false);
    expect(t.model.roles).toBeNull();
  });

  it('does not put an aria-live region on the page-level container', () => {
    const { t } = mountLive();
    const root = t.root as unknown as FakeNode;
    // index.html mounts the SPA inside <main aria-live="polite">; the theater
    // root switches that off for its whole subtree.
    expect(root.getAttribute('aria-live')).toBe('off');
    const regions = findAll(root, (n) => n.getAttribute('aria-live') === 'polite');
    expect(regions).toHaveLength(1);
    expect(regions[0]!.classList.contains('ww-status-strip')).toBe(true);
  });
});

describe('werewolf theater — the truth overlay, post-game only', () => {
  it('interleaves the sealed night whispers at the beat they were spoken', () => {
    const { host, t } = mountEnded();
    const node = host as unknown as FakeNode;
    const sealed = findAll(node, hasClass('ww-sealed'));
    expect(sealed.length).toBe(4); // whisper, kill intent, peek, guard — never the public dawn
    expect(sealed.every((n) => Number.isFinite(Number(n.dataset['beat'])))).toBe(true);
    expect(node.textContent).toContain(WHISPER);
    expect(node.textContent).toContain('marks p3 for the kill');
    expect(node.textContent).toContain('peeks p1 = WOLF');
    expect(node.textContent).toContain('guards p0');
    // Every sealed row sits before the day-1 discussion it explains.
    const list = t.listEl as unknown as FakeNode;
    const kids = list.children;
    const lastSealed = kids.map((n, i) => (n.classList.contains('ww-sealed') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstDay = kids.findIndex((n) => n.dataset['seq'] === '0');
    expect(lastSealed).toBeGreaterThanOrEqual(0);
    expect(lastSealed).toBeLessThan(firstDay);
  });

  it('sorts sealed rows within one night by seat order', () => {
    const model = createModel();
    for (const e of endedEvents()) foldEvent(model, e);
    const rows = sealedRowsFromReplay(replayFixture(), model);
    const beats = rows.map((r) => r.beat);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    // p1 (seat 1) before p2 (seat 2) before p4 (seat 4) — night moves share a
    // turn index, so seat order is the only ordering there is.
    expect(rows.map((r) => r.speaker)).toEqual(['p1', 'p1', 'p2', 'p4']);
  });

  it('marks the public lies against the revealed roles', () => {
    const { host } = mountEnded();
    const node = host as unknown as FakeNode;
    const claim = findAll(node, (n) => n.dataset['seq'] === '1')[0]!; // p1 claims seer, is a wolf
    expect(claim.classList.contains('ww-lie')).toBe(true);
    expect(claim.classList.contains('ww-by-wolf')).toBe(true);
    expect(claim.textContent).toContain('FALSE CLAIM');

    const report = findAll(node, (n) => n.dataset['seq'] === '3')[0]!; // p4 the real seer
    expect(report.classList.contains('ww-true-report')).toBe(true);
    expect(report.textContent).toContain('TRUE CHECK');

    const misdirect = findAll(node, (n) => n.dataset['seq'] === '5')[0]!; // p6 wolf accuses p4
    expect(misdirect.classList.contains('ww-misdirect')).toBe(true);
    expect(misdirect.textContent).toContain('MISDIRECT');

    const honest = findAll(node, (n) => n.dataset['seq'] === '2')[0]!; // p2 the doctor, just talking
    expect(honest.classList.contains('ww-lie')).toBe(false);
    expect(honest.classList.contains('ww-by-wolf')).toBe(false);
  });

  it('classifies each act against the role map', () => {
    const r = { speaker: 'p1', act: 'claim', role: 'seer', target: null, verdict: null };
    expect(veracityOf(r, ROLES)).toMatchObject({ cls: 'ww-lie' });
    expect(veracityOf({ ...r, speaker: 'p4' }, ROLES)).toMatchObject({ cls: 'ww-true-claim' });
    expect(veracityOf({ speaker: 'p0', act: 'report', target: 'p1', verdict: 'wolf', role: null }, ROLES)).toMatchObject({ cls: 'ww-fake-report' });
    expect(veracityOf({ speaker: 'p4', act: 'report', target: 'p0', verdict: 'wolf', role: null }, ROLES)).toMatchObject({ cls: 'ww-anomaly' });
    expect(veracityOf({ speaker: 'p1', act: 'defend', target: 'p6', verdict: null, role: null }, ROLES)).toMatchObject({ cls: 'ww-pack-cover' });
    expect(veracityOf({ speaker: 'p0', act: 'say', target: null, verdict: null, role: null }, ROLES)).toBeNull();
  });

  it('says "from the signed log", never "verified"', () => {
    const { host } = mountEnded();
    const dump = (host as unknown as FakeNode).textContent;
    expect(dump).toContain('from the signed log');
    expect(dump).not.toContain('independently verified');
  });

  it('puts the revealed role on the roster as text, not only as colour', () => {
    const { host } = mountEnded();
    const badges = findAll(host as unknown as FakeNode, hasClass('ww-role-badge')).map((n) => n.textContent);
    expect(badges).toContain('WEREWOLF');
    expect(badges).toContain('SEER');
    expect(badges).toContain('DOCTOR');
  });

  it('lands the roles at the buzzer and the sealed night when the replay catches up', () => {
    // The post-'end' reveal event carries the ROLES; the replay endpoint may
    // still be a moment from being written. Neither half may block the other,
    // and neither may apply twice.
    const host = makeElement('div');
    const t = createTheater(host, { row: { ...ROW, status: 'ended' }, events: endedEvents() });
    expect(t.applyReveal({ roles: { ...ROLES }, replay: null })).toBe(true);
    const node = host as unknown as FakeNode;
    expect(allClasses(node).has('ww-lie')).toBe(true);
    expect(findAll(node, hasClass('ww-sealed'))).toEqual([]);
    expect(node.textContent).not.toContain(WHISPER);

    expect(t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() })).toBe(true);
    expect(findAll(node, hasClass('ww-sealed'))).toHaveLength(4);
    expect(node.textContent).toContain(WHISPER);
    // A third pass changes nothing.
    expect(t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() })).toBe(false);
    expect(findAll(node, hasClass('ww-sealed'))).toHaveLength(4);
    t.dispose();
  });

  it('refuses to apply a second time', () => {
    const host = makeElement('div');
    const t = createTheater(host, { row: { ...ROW, status: 'ended' }, events: endedEvents() });
    expect(t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() })).toBe(true);
    expect(t.applyReveal({ roles: { ...ROLES }, replay: replayFixture() })).toBe(false);
    expect(findAll(host as unknown as FakeNode, hasClass('ww-sealed'))).toHaveLength(4);
  });
});

describe('werewolf theater — scrubbing back must not reveal the ending', () => {
  it('hides every node past the scrub position, at every beat', () => {
    const { t } = mountEnded();
    const list = t.listEl as unknown as FakeNode;
    const max = t.model.beat;
    for (let k = 0; k <= max; k++) {
      applyBeat(list, k);
      for (const n of list.children) {
        const b = Number(n.dataset['beat']);
        const future = n.classList.contains('is-future');
        expect(Number.isFinite(b)).toBe(true);
        expect(future).toBe(b > k);
      }
      // The rendered set is exactly the model's set at that beat.
      const visible = list.children.filter((n) => !n.classList.contains('is-future')).length;
      expect(visible).toBe(atBeat(t.model, k).length);
    }
  });

  it('the lynch outcome is hidden while scrubbed before it', () => {
    const { t } = mountEnded();
    const list = t.listEl as unknown as FakeNode;
    const lynch = list.children.find((n) => n.classList.contains('ww-divider-lynch'))!;
    const lynchBeat = Number(lynch.dataset['beat']);
    applyBeat(list, lynchBeat - 1);
    expect(lynch.classList.contains('is-future')).toBe(true);
    applyBeat(list, lynchBeat);
    expect(lynch.classList.contains('is-future')).toBe(false);
  });

  it('FAILS CLOSED on a node with no finite beat', () => {
    const { t } = mountEnded();
    const list = t.listEl as unknown as FakeNode;
    const victim = list.children.find((n) => n.classList.contains('ww-divider-lynch'))!;
    delete victim.dataset['beat'];
    applyBeat(list, t.model.beat); // scrub fully forward: everything visible
    // NaN < lo and NaN > hi are BOTH false. A pass that `continue`s here would
    // leave "p4 lynched — SEER" on screen at beat 0 forever.
    expect(victim.classList.contains('is-future')).toBe(true);
    applyBeat(list, 0);
    expect(victim.classList.contains('is-future')).toBe(true);
  });

  it('every appended node carries a data-beat, dividers and ballot cards included', () => {
    const { t } = mountEnded();
    const list = t.listEl as unknown as FakeNode;
    expect(list.children.length).toBeGreaterThan(10);
    for (const n of list.children) {
      expect(n.dataset['beat']).toBeDefined();
      expect(Number.isFinite(Number(n.dataset['beat']))).toBe(true);
    }
  });
});


describe('werewolf theater — model joins', () => {
  it('a timeout in one round does not mark the same seat in the next round', () => {
    const m = createModel();
    foldEvent(m, { seq: 1, type: 'start', data: { public: pub({ phase: 'day_talk', round: 0 }) }, at: null });
    foldEvent(m, {
      seq: 2,
      type: 'timeout',
      data: { turn_index: 1, player: 'p0', forced: 'timeout', public: pub({ phase: 'day_talk', round: 0 }) },
      at: null,
    });
    const say = (seq: number, round: number) => ({
      seq: 10 + seq,
      type: 'game:speech',
      data: { turn_index: 1, player: 'p0', data: { seq, day: 1, round, speaker: 'p0', act: 'say', target: null, role: null, verdict: null, text: '' } },
      at: null,
    });
    foldEvent(m, say(0, 1)); // ROUND 1 — a different slot, must stay a silence
    foldEvent(m, say(1, 0)); // ROUND 0 — the round that actually timed out
    const byId = new Map(m.rows.filter((r) => r.kind === 'utt').map((r) => [r.seq, r]));
    expect(byId.get(0)!.forced).toBeNull();
    expect(byId.get(1)!.forced).toBe('timeout');
  });

  it('the forced flag is consumed once, not smeared across a day', () => {
    const m = createModel();
    foldEvent(m, { seq: 1, type: 'start', data: { public: pub({ phase: 'day_talk', round: 0 }) }, at: null });
    foldEvent(m, { seq: 2, type: 'timeout', data: { turn_index: 1, player: 'p0', forced: 'timeout', public: pub({ phase: 'day_talk', round: 0 }) }, at: null });
    const dup = (seq: number) => ({
      seq: 20 + seq,
      type: 'game:speech',
      data: { turn_index: 1, player: 'p0', data: { seq, day: 1, round: 0, speaker: 'p0', act: 'say', target: null, role: null, verdict: null, text: '' } },
      at: null,
    });
    foldEvent(m, dup(0));
    foldEvent(m, dup(1)); // a second round-0 row for p0 cannot happen, but must not re-fire
    const rows = m.rows.filter((r) => r.kind === 'utt');
    expect(rows.filter((r) => r.forced === 'timeout')).toHaveLength(1);
  });

  it('sealedRowsFromReplay yields nothing without a replay or a beat join', () => {
    const m = createModel();
    expect(sealedRowsFromReplay(null, m)).toEqual([]);
    expect(sealedRowsFromReplay({ log: [] }, m)).toEqual([]);
    // No matching move beat: the rows still surface, pinned to beat 0, rather
    // than being dropped on the floor.
    const rows = sealedRowsFromReplay(replayFixture(), m);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.beat === 0)).toBe(true);
  });
});

describe('werewolf theater — appends, never rebuilds', () => {
  it('keeps the identity of already-rendered nodes across incremental batches', () => {
    const all = liveEvents();
    const host = makeElement('div');
    const t = createTheater(host, { row: ROW, events: all.slice(0, 12) });
    const list = t.listEl as unknown as FakeNode;
    const before = list.children.slice();
    expect(before.length).toBeGreaterThan(0);

    t.absorb(all.slice(12));
    const after = list.children.slice();
    expect(after.length).toBeGreaterThan(before.length);
    // Every node that existed still exists, as the SAME object, in order —
    // a clear()+rebuild would fail this and would also fight a human reading
    // back through an hour of debate.
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    t.dispose();
  });

  it('produces the same transcript whether events arrive in one batch or many', () => {
    const all = liveEvents();
    const oneHost = makeElement('div');
    const one = createTheater(oneHost, { row: ROW, events: all });
    const manyHost = makeElement('div');
    const many = createTheater(manyHost, { row: ROW });
    for (const e of all) many.absorb([e]);
    const textOf = (t: ReturnType<typeof createTheater>) =>
      (t.listEl as unknown as FakeNode).children.map((n) => `${n.dataset['beat']}|${n.attrs['class']}|${n.textContent}`);
    expect(textOf(many)).toEqual(textOf(one));
    one.dispose();
    many.dispose();
  });
});

// ---------------------------------------------------------------------------
// Static guards. These catch the two failure modes that would pass every
// behavioural test above while being broken on screen.
// ---------------------------------------------------------------------------

describe('werewolf theater — static guards', () => {
  const PAGE = readFileSync(new URL('../public/watch/js/pages/werewolf.js', import.meta.url), 'utf8');
  const CSS = readFileSync(new URL('../public/watch/css/styles.css', import.meta.url), 'utf8');

  it('never builds a seat class from a seat ID', () => {
    // publicView carries seat IDS ('p3'); the CSS families are NUMERIC
    // (.ww-seat-0 … -7, the repo convention). `ww-seat-${e.from}` yields
    // .ww-seat-p3, which does not exist — every consumer paints unstyled while
    // a "do the classes exist" test passes. Only `idx`, `seatIdx(...)` or a
    // literal digit may fill that slot.
    const offenders: string[] = [];
    for (const match of PAGE.matchAll(/seat-\$\{([^}]*)\}/g)) {
      const expr = match[1]!.trim();
      const ok = expr === 'idx' || expr === 'i' || /^\d+$/.test(expr) || /^seatIdx\(/.test(expr);
      if (!ok) offenders.push(expr);
    }
    expect(offenders).toEqual([]);
  });

  it('the eight-seat palette is complete', () => {
    for (let i = 0; i < 8; i++) {
      expect(CSS).toContain(`--seat-${i}:`);
      expect(CSS).toContain(`.piece-seat-${i} {`);
      expect(CSS).toContain(`.ww-fg-seat-${i} {`);
      expect(CSS).toContain(`.ww-bg-seat-${i} {`);
    }
  });

  it('no theater colour token collides with a seat or status token', () => {
    // In this one UI a hue simultaneously encodes seat identity, role and act
    // type. A seer badge painted --seat-4 is a real defect, so the palettes
    // must be disjoint by value, not merely by name.
    const decls = [...CSS.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)];
    const wwByName = new Map<string, Set<string>>();
    const baseByName = new Map<string, Set<string>>();
    for (const [, name, value] of decls) {
      const bucket = name!.startsWith('ww-') ? wwByName : baseByName;
      if (!/^(seat-\d|ok|bad|warn|accent|accent-strong|ww-)/.test(name!)) continue;
      const key = value!.toLowerCase();
      if (!bucket.has(key)) bucket.set(key, new Set());
      bucket.get(key)!.add(name!);
    }
    const collisions: string[] = [];
    for (const [value, wwNames] of wwByName) {
      const base = baseByName.get(value);
      if (base) collisions.push(`${value}: ${[...wwNames].join('/')} == ${[...base].join('/')}`);
    }
    expect(collisions).toEqual([]);
  });

  it('the transcript filters and the scrub guard are class-driven, not re-renders', () => {
    for (const rule of ['.ww-transcript.filter-wolves', '.ww-transcript.filter-lies', '.ww-transcript .is-future']) {
      expect(CSS).toContain(rule);
    }
    expect(CSS).toContain('prefers-reduced-motion');
  });
});

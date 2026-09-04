/**
 * boards/werewolf.js — the hidden-information test for the spectator dossier.
 *
 * THE PROPERTY UNDER TEST: a LIVING seat's role never reaches the DOM. Only a
 * seat that has died — and whose role the engine therefore published in
 * `dead[].role` (src/games/werewolf/render.ts#PublicDead) — may show one. The
 * renderer is fed deliberately hostile inputs here: a public view carrying an
 * extra `roles` map it must ignore, and the RAW WwState that
 * pages/replay.js:270 hands renderBoard, which contains every role, every peek
 * and the wolves' whole channel.
 *
 * The repo has no jsdom and adding one would be a new dependency (see the plan,
 * §6.5), so this file ships a ~40-line DOM shim implementing exactly the four
 * calls web/public/watch/js/dom.js makes — createElement, createElementNS,
 * createTextNode, and the appendChild/removeChild/setAttribute/firstChild
 * surface. That is enough to render the module for real and then read back
 * every text node and every attribute value it produced.
 *
 * Runs with the rest of web/tests:  npx vitest run web/tests
 */

import { describe, expect, it } from 'vitest';

// --- the DOM shim ----------------------------------------------------------

type ShimNode = {
  tagName: string;
  ns: string | null;
  attributes: Record<string, string>;
  childNodes: ShimNode[];
  nodeValue: string | null;
  readonly firstChild: ShimNode | null;
  appendChild(child: ShimNode): ShimNode;
  removeChild(child: ShimNode): ShimNode;
  setAttribute(key: string, value: unknown): void;
  addEventListener(): void;
};

function makeNode(tagName: string, ns: string | null, nodeValue: string | null = null): ShimNode {
  const node: ShimNode = {
    tagName,
    ns,
    attributes: {},
    childNodes: [],
    nodeValue,
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    appendChild(child) {
      node.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const i = node.childNodes.indexOf(child);
      if (i >= 0) node.childNodes.splice(i, 1);
      return child;
    },
    setAttribute(key, value) {
      node.attributes[key] = String(value);
    },
    addEventListener() {
      /* the renderer registers none; present so dom.js's on* branch is safe */
    },
  };
  return node;
}

const shimDocument = {
  createElement: (tag: string) => makeNode(String(tag).toLowerCase(), null),
  createElementNS: (ns: string, tag: string) => makeNode(String(tag).toLowerCase(), ns),
  createTextNode: (value: string) => makeNode('#text', null, String(value)),
};

(globalThis as unknown as { document: typeof shimDocument }).document = shimDocument;

// Imported AFTER the shim is installed. (dom.js only touches `document` inside
// its functions, so the order is belt-and-braces rather than load-bearing.)
const { render } = (await import('../public/watch/js/boards/werewolf.js')) as {
  render: (container: ShimNode, view: unknown) => boolean;
};

// --- readers ---------------------------------------------------------------

function textOf(node: ShimNode): string {
  if (node.nodeValue !== null) return node.nodeValue;
  return node.childNodes.map(textOf).join(' ');
}

function walk(node: ShimNode, out: ShimNode[] = []): ShimNode[] {
  out.push(node);
  for (const child of node.childNodes) walk(child, out);
  return out;
}

function tagged(root: ShimNode, tagName: string): ShimNode[] {
  return walk(root).filter((n) => n.tagName === tagName);
}

function attributeValues(root: ShimNode): string[] {
  return walk(root).flatMap((n) => Object.values(n.attributes));
}

// ROLES_CANON, src/games/werewolf/board.ts. Note none of these is a substring
// of a phrase the renderer legitimately prints: 'wolves left' and 'taken by the
// wolves' do not contain 'werewolf', and 'village left' does not contain
// 'villager'.
const ROLE_WORDS = ['werewolf', 'seer', 'doctor', 'villager'];

function roleWordsIn(str: string): string[] {
  const low = str.toLowerCase();
  return ROLE_WORDS.filter((w) => low.includes(w));
}

// --- fixtures --------------------------------------------------------------

const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

/** The true roles. p1 and p5 are dead and therefore public; the rest are not. */
const SECRET_ROLES: Record<string, string> = {
  p0: 'seer',
  p1: 'villager', // dead n1
  p2: 'werewolf',
  p3: 'doctor',
  p4: 'villager',
  p5: 'werewolf', // dead d2
  p6: 'villager',
  p7: 'villager',
};

const DEAD = [
  { seat: 'p1', day: 1, cause: 'wolves', role: 'villager' },
  { seat: 'p5', day: 2, cause: 'lynch', role: 'werewolf' },
];
const LIVING = PLAYERS.filter((p) => !DEAD.some((d) => d.seat === p));

/** publicOf(state) as it arrives on a spectator `move` event, day 3. */
function livePublicView(extra: Record<string, unknown> = {}) {
  return {
    day: 3,
    phase: 'day_talk',
    round: 1,
    players: PLAYERS.slice(),
    alive: LIVING.slice(),
    dead: DEAD.map((d) => ({ ...d })),
    claims: [
      { day: 2, seq: 4, speaker: 'p0', role: 'seer' },
      { day: 3, seq: 9, speaker: 'p2', role: 'doctor' },
    ],
    reports: [{ day: 3, seq: 10, speaker: 'p0', target: 'p2', verdict: 'wolf' }],
    edges: [
      { day: 3, seq: 11, from: 'p0', to: 'p2', polarity: 'accuse' },
      { day: 3, seq: 12, from: 'p4', to: 'p2', polarity: 'accuse' },
      { day: 3, seq: 13, from: 'p6', to: 'p3', polarity: 'accuse' },
      { day: 3, seq: 14, from: 'p7', to: 'p2', polarity: 'defend' },
      { day: 2, seq: 3, from: 'p0', to: 'p5', polarity: 'accuse' },
    ],
    vote_history: [{ day: 2, ballots: { p0: 'p5', p2: 'p5', p3: 'p5', p4: null, p6: 'p0', p7: 'p0' }, lynched: 'p5' }],
    nights: [
      { day: 1, died: 'p1' },
      { day: 2, died: null },
    ],
    defenders: [{ day: 2, seat: 'p5' }],
    defender: null,
    transcript: [],
    archived: { count: 12, digest: 'ab'.repeat(32) },
    acted_this_night: [],
    spoke_this_round: ['p0', 'p4'],
    voted_this_phase: [],
    pending: ['p2', 'p3', 'p6', 'p7'],
    wolves_remaining: 1,
    village_remaining: 5,
    board_text: 'WEREWOLF day 3 …',
    ...extra,
  };
}

/** The raw WwState pages/replay.js:270 passes as `replay.initial_state`. */
function rawInitialState() {
  const alive: Record<string, boolean> = {};
  for (const p of PLAYERS) alive[p] = true;
  return {
    players: PLAYERS.slice(),
    roles: { ...SECRET_ROLES },
    day: 1,
    phase: 'night',
    round: 0,
    seq: 0,
    peeks: [{ day: 1, seer: 'p0', target: 'p2', verdict: 'wolf' }],
    guards: [{ day: 1, doctor: 'p3', target: 'p0', saved: false }],
    kills: [{ day: 1, wolf: 'p2', target: 'p1', died: true }],
    packLog: [{ day: 1, from: 'p2', text: 'take the doctor first' }],
    noteLog: [{ day: 1, who: 'p0', text: 'p2 reads werewolf to me' }],
    alive,
    cause: {},
    revealed: {},
    claims: [],
    reports: [],
    edges: [],
    voteHistory: [],
    nights: [],
    defenders: [],
    transcript: [],
    archivedCount: 0,
    archivedDigest: '00'.repeat(32),
    nightActs: {},
    said: {},
    ballots: {},
    defender: null,
    defended: false,
  };
}

function renderInto(view: unknown) {
  const container = makeNode('div', null);
  const ok = render(container, view);
  return { ok, container };
}

// --- tests -----------------------------------------------------------------

describe('boards/werewolf.js — the spectator dossier', () => {
  it('renders the public view and reports that it handled the shape', () => {
    const { ok, container } = renderInto(livePublicView());
    expect(ok).toBe(true);
    const body = textOf(container);
    expect(body).toContain('day 3');
    expect(body).toContain('6 of 8 alive');
    expect(body).toContain('wolves left 1');
    expect(body).toContain('village left 5');
    for (const seat of PLAYERS) expect(body).toContain(seat);
  });

  it('shows the public role of the dead — so the leak test below is not vacuous', () => {
    const { container } = renderInto(livePublicView());
    const rows = tagged(container, 'li').filter((li) => textOf(li).includes('p5'));
    const p5 = rows.find((li) => textOf(li).startsWith('p5'));
    expect(p5, 'expected a roster row for the dead seat p5').toBeDefined();
    expect(textOf(p5!)).toContain('WEREWOLF');
    expect(textOf(p5!)).toContain('d2 lynched');
    const p1 = tagged(container, 'li').find((li) => textOf(li).startsWith('p1'));
    expect(textOf(p1!)).toContain('VILLAGER');
    expect(textOf(p1!)).toContain('taken by the wolves');
  });

  it('NEVER puts a living seat’s role in the DOM, even when the view smuggles one in', () => {
    // `roles` is not a publicView key; it is here to prove the renderer reads
    // only the frozen key set and would ignore a leak upstream of it.
    const { ok, container } = renderInto(livePublicView({ roles: { ...SECRET_ROLES } }));
    expect(ok).toBe(true);

    // p0 is the seer and p3 the doctor: neither role is held by any DEAD seat,
    // so neither word may occur anywhere in the rendered output.
    const body = textOf(container).toLowerCase();
    expect(body).not.toContain('seer');
    expect(body).not.toContain('doctor');

    // And no living seat's row carries any role word at all — p2 is secretly a
    // werewolf, and 'werewolf' does legitimately appear elsewhere (dead p5).
    for (const seat of LIVING) {
      const row = tagged(container, 'li').find((li) => textOf(li).startsWith(seat));
      expect(row, `expected a roster row for ${seat}`).toBeDefined();
      expect(roleWordsIn(textOf(row!)), `${seat} is alive; its row must name no role`).toEqual([]);
      expect(textOf(row!)).toContain('role sealed');
    }

    // <title> tooltips are text nodes too, and they are the classic leak site.
    for (const title of tagged(container, 'title')) {
      const str = textOf(title);
      const mentionsLiving = LIVING.some((seat) => str.includes(seat));
      if (mentionsLiving) expect(roleWordsIn(str), `tooltip "${str}" names a living seat`).toEqual([]);
    }

    // No role reaches a class, an aria-label or any other attribute either.
    for (const value of attributeValues(container)) {
      expect(roleWordsIn(value), `attribute value "${value}" carries a role`).toEqual([]);
    }
  });

  it('projects the replay’s raw WwState publicly — no role, peek or whisper escapes', () => {
    // Everyone is alive in an initial_state, so the correct output contains no
    // role word at all, anywhere.
    const { ok, container } = renderInto(rawInitialState());
    expect(ok).toBe(true);
    const body = textOf(container);
    expect(body).toContain('night 1');
    expect(body).toContain('8 of 8 alive');
    expect(roleWordsIn(body)).toEqual([]);
    for (const value of attributeValues(container)) expect(roleWordsIn(value)).toEqual([]);
    // The hidden ledgers are not read at all, so their prose cannot appear.
    expect(body).not.toContain('take the doctor first');
    expect(body).not.toContain('p2 reads werewolf to me');
    // wolves_remaining is derived in publicOf from the public role multiset,
    // which this shape does not carry: it must be absent, not guessed.
    expect(body).not.toContain('wolves left');
  });

  it('does not render claims or reports — they are assertions about a living seat', () => {
    // The claim ledger is public, but a claim names a ROLE next to a LIVING
    // seat. That belongs to the transcript surface, which can frame it as an
    // assertion; a dossier row cannot.
    const { container } = renderInto(livePublicView());
    const body = textOf(container).toLowerCase();
    expect(body).not.toContain('claims');
    expect(body).not.toContain('reports');
  });

  it('builds every seat class from the NUMERIC seat index, never from the p-id string', () => {
    const { container } = renderInto(livePublicView());
    const classes = walk(container)
      .map((n) => n.attributes.class)
      .filter((c): c is string => typeof c === 'string');
    const all = classes.join(' ');
    // `ww-stroke-seat-p3` would resolve to a rule that does not exist and paint
    // nothing — the trap the plan calls out in §6.2.
    expect(all).not.toMatch(/seat-p\d/);
    for (let i = 0; i < 8; i++) expect(all).toContain(`ww-seat-${i}`);
    // Seats 6 and 7 need --seat-6/--seat-7 and .piece-seat-6/-7 in styles.css.
    expect(all).toContain('piece-seat-6');
    expect(all).toContain('piece-seat-7');
  });

  it('counts the ballot without ever implying it knows a sealed target', () => {
    const view = livePublicView({ phase: 'day_vote', voted_this_phase: ['p0', 'p4'], pending: ['p2', 'p3', 'p6', 'p7'] });
    const { container } = renderInto(view);
    const body = textOf(container);
    expect(body).toContain('2 of 6 ballots sealed');
    expect(body).toContain('no ballot is public until every seat has voted');
    // Day 2's completed ballot is history and is fully revealed, including the
    // lynched seat's role.
    expect(body).toContain('p5 ×3 (p0,p2,p3)');
    expect(body).toContain('abstain ×1 (p4)');
    expect(body).toContain('p5 lynched (WEREWOLF)');
  });

  it('tallies today’s accusations and shows the night results', () => {
    const { container } = renderInto(livePublicView());
    const body = textOf(container);
    expect(body).toContain('×2'); // p2 accused twice today
    expect(body).toContain('p7 defends p2');
    expect(body).toContain('p1 died (VILLAGER)');
    expect(body).toContain('nobody died');
    expect(body).toContain('still to act: p2 p3 p6 p7');
  });

  it('handles an abandoned seat: no death day, no revealed role, a closed cause class', () => {
    // forfeitPlayer leaves no dated row in any public ledger, so PublicDead.day
    // is null and PublicDead.role can be null too (render.ts:62-73).
    const view = livePublicView({
      dead: [...DEAD.map((d) => ({ ...d })), { seat: 'p4', day: null, cause: 'vanished', role: null }],
      alive: LIVING.filter((p) => p !== 'p4'),
    });
    const { container } = renderInto(view);
    const row = tagged(container, 'li').find((li) => textOf(li).startsWith('p4'));
    expect(textOf(row!)).toContain('abandoned (three strikes or clock)');
    expect(textOf(row!)).toContain('role unrecorded');
    const classes = walk(container)
      .map((n) => n.attributes.class)
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(classes).toContain('is-dead-abandoned');
    expect(classes).not.toContain('is-dead-vanished');
  });

  it('declines a shape it does not recognise so renderFallback can take over', () => {
    for (const view of [null, undefined, 42, 'p0', {}, { players: [] }, { board_text: 'x' }, { players: PLAYERS.slice() }]) {
      expect(render(makeNode('div', null), view)).toBe(false);
    }
  });

  it('replaces the container’s previous contents instead of appending to them', () => {
    const container = makeNode('div', null);
    container.appendChild(makeNode('p', null));
    render(container, livePublicView());
    expect(container.childNodes.length).toBe(1);
  });
});

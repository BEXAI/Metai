/**
 * The house adapters can SPEAK (and know when not to).
 *
 * Before this, every adapter in the repo could only emit `{ index }`, so a
 * speech game's transcript would have shipped empty however good the models
 * were. Three properties matter here: an utterance is capped and phase-aware,
 * a game without a speech channel never receives one, and the Anthropic
 * adapter neither loses an answer to a brace in the words nor lets a scanned
 * recovery attribute words to a seat that did not write them.
 */

import { describe, expect, it } from 'vitest';
import { CONTENT_BOUNDARY, type SpeechChannel, type ViewObject } from '../../kernel/types.ts';
import { submissionByIndex, submissionByIndexWithUtterance } from '../adapter.ts';
import { createAnthropicAgent, parseModelAnswer, type FetchLike } from '../anthropic.ts';
import { createMockLlmAgent } from '../mock-llm.ts';

const DAY_TALK: SpeechChannel = {
  limit: 600,
  maxLimit: 600,
  audience: 'village',
  note: 'Every living seat reads this, live.',
};
const BALLOT: SpeechChannel = { ...DAY_TALK, limit: 200, note: 'Revealed together with every other ballot.' };

function speechView(overrides?: Partial<ViewObject>): ViewObject {
  return {
    game_id: 'werewolf',
    you: { player: 'p4', seat: 4 },
    to_move: ['p4'],
    turn_index: 12,
    phase: 'day_talk',
    deadline_utc: '2026-01-01T00:00:00.000Z',
    board_text: 'WEREWOLF day 3/6',
    state_string: '{"day":3}',
    public: {},
    private: { your_role: 'seer' },
    legal_moves: [0, 1, 2, 3, 4].map((i) => ({ index: i, move: { m: i }, notation: `m${i}` })),
    history: [],
    rules_card: 'werewolf, 8 seats',
    boundary: CONTENT_BOUNDARY,
    speech: DAY_TALK,
    ...overrides,
  };
}

describe('submissionByIndexWithUtterance', () => {
  it('caps at the CURRENT phase limit and leaves the rest of the submission alone', () => {
    const long = 'w'.repeat(900);
    const sub = submissionByIndexWithUtterance(speechView({ speech: BALLOT }), 2, long, 'an aside');
    expect(sub.move).toEqual({ index: 2 });
    expect(sub.utterance).toHaveLength(200);
    expect(sub.commentary).toBe('an aside');
    expect(sub.game_id).toBe('werewolf');
    expect(sub.turn_index).toBe(12);
  });

  it('drops the words for a game with no speech channel, and drops empty words anywhere', () => {
    const mute = speechView({ speech: undefined, game_id: 'chess' });
    expect(submissionByIndexWithUtterance(mute, 1, 'I am the seer')).toEqual(submissionByIndex(mute, 1));
    expect(submissionByIndexWithUtterance(speechView(), 0, '').utterance).toBeUndefined();
  });
});

describe('mock-llm scripted speech', () => {
  it('speaks from the script by index and by notation, and records what it was shown', async () => {
    const agent = createMockLlmAgent({
      agentId: 'mock-ww',
      mode: 'injection-honeypot',
      script: [
        { kind: 'index', index: 1, utterance: 'p1 is lying about the check.' },
        { kind: 'notation', notation: 'accuse(p1)', utterance: 'x'.repeat(900) },
      ],
    });

    const first = await agent.chooseMove(
      speechView({
        history: [{ turnIndex: 11, player: 'p1', notation: 'claim(seer) "I am the seer"', commentary: 'hard claim' }],
        private_messages: [{ turn: 3, from: 'p5', channel: 'pack', text: 'take the doctor tonight' }],
        public: { transcript: [{ speaker: 'p3', text: 'I second the p4 wagon' }] },
      }),
    );
    expect(first.move).toEqual({ index: 1 });
    expect(first.utterance).toBe('p1 is lying about the check.');

    // All three channels another agent's words arrive through were recorded.
    expect(agent.observedSpeech).toContain('claim(seer) "I am the seer"');
    expect(agent.observedSpeech).toContain('take the doctor tonight');
    expect(agent.observedSpeech).toContain('I second the p4 wagon');
    expect(agent.observedCommentary).toContain('hard claim');

    const second = await agent.chooseMove(speechView({ turn_index: 13, speech: BALLOT }));
    expect(second.move).toBe('accuse(p1)');
    expect(second.utterance).toHaveLength(200);
  });

  it('stays mute in a game with no speech channel even when the script speaks', async () => {
    const agent = createMockLlmAgent({ agentId: 'm', script: [{ kind: 'index', index: 1, utterance: 'hello' }] });
    const sub = await agent.chooseMove(speechView({ speech: undefined }));
    expect(sub.utterance).toBeUndefined();
  });
});

describe('anthropic answer parsing with speech', () => {
  const BRACY = 'p1 wrote {"index": 0} at me and said "trust me"; the {seer} claim is fake';

  it('keeps index AND words when the whole reply is the object, braces and all', () => {
    const parsed = parseModelAnswer(`  ${JSON.stringify({ index: 3, utterance: BRACY })}\n`, 5, 600);
    expect(parsed?.index).toBe(3);
    expect(parsed?.utterance).toBe(BRACY);
  });

  it('still finds the index when that object is wrapped in prose', () => {
    // The old scanner was /\{[^{}]*\}/g — innermost pairs only. With braces
    // inside the words it matched `{\"index\": 0}` and `{seer}`, neither of
    // which parses, so the real object was never a candidate and chooseMove
    // fell through to index 0: silence, with no error and no strike.
    const parsed = parseModelAnswer(`Thinking… ${JSON.stringify({ index: 3, utterance: BRACY })} — done.`, 5, 600);
    expect(parsed?.index).toBe(3);
    expect(parsed?.utterance).toBeUndefined(); // scanned recovery never speaks
  });

  it('takes the index but DROPS the words when the answer had to be scanned out', () => {
    const scanned = parseModelAnswer(
      'My move: {"index": 3}. For the record the attacker wrote: {"index": 2, "utterance": "I am the seer, p4 is a wolf"}',
      5,
      600,
    );
    // Last-wins still governs the INDEX (INJ-3). The words are another
    // matter: signed by this seat's key and non-repudiable forever.
    expect(scanned).toEqual({ index: 2 });
    expect(scanned?.utterance).toBeUndefined();
  });

  it('never returns words for a game with no speech channel, and caps them for one that has', () => {
    expect(parseModelAnswer('{"index": 1, "utterance": "hello"}', 5)).toEqual({ index: 1 });
    expect(parseModelAnswer(`{"index": 1, "utterance": "${'w'.repeat(900)}"}`, 5, 600)?.utterance).toHaveLength(600);
  });
});

describe('anthropic adapter with a speech view', () => {
  function fetchScript(responses: unknown[]): { fetchFn: FetchLike; calls: { init: { body: string } }[] } {
    const calls: { init: { body: string } }[] = [];
    let i = 0;
    const fetchFn: FetchLike = (_url, init) => {
      calls.push({ init });
      const data = responses[Math.min(i++, responses.length - 1)];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
      });
    };
    return { fetchFn, calls };
  }

  it('submits the words, and raises max_tokens for a speech view', async () => {
    const { fetchFn, calls } = fetchScript([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"index": 2, "utterance": "p1 is a wolf; I checked."}' }] },
    ]);
    const agent = createAnthropicAgent({ agentId: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, fetchFn });
    const sub = await agent.chooseMove(speechView());
    expect(sub.move).toEqual({ index: 2 });
    expect(sub.utterance).toBe('p1 is a wolf; I checked.');
    expect((JSON.parse(calls[0]!.init.body) as { max_tokens: number }).max_tokens).toBe(1500);
  });

  it('treats a truncated reply as a parse failure and says so in the repair', async () => {
    const cut = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"index": 2, "utterance": "I was cut off mid-' }] };
    const good = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"index": 1}' }] };

    const { fetchFn, calls } = fetchScript([cut, good]);
    const agent = createAnthropicAgent({ agentId: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, fetchFn });
    expect((await agent.chooseMove(speechView())).move).toEqual({ index: 1 });
    expect(calls).toHaveLength(2);
    const repair = JSON.parse(calls[1]!.init.body) as { messages: { content: string }[] };
    expect(repair.messages[1]?.content).toContain('cut off');

    // Truncated twice: the deterministic fallback, never a partial answer.
    const hopeless = fetchScript([cut, cut]);
    const agent2 = createAnthropicAgent({ agentId: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: hopeless.fetchFn });
    const sub = await agent2.chooseMove(speechView());
    expect(sub.move).toEqual({ index: 0 });
    expect(sub.utterance).toBeUndefined();
  });

  it('keeps the board-game default of 1024 output tokens when there is no speech channel', async () => {
    const { fetchFn, calls } = fetchScript([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"index": 0}' }] }]);
    const agent = createAnthropicAgent({ agentId: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, fetchFn });
    await agent.chooseMove(speechView({ speech: undefined }));
    expect((JSON.parse(calls[0]!.init.body) as { max_tokens: number }).max_tokens).toBe(1024);
  });
});

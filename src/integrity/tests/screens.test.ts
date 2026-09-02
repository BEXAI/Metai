import { describe, expect, it } from 'vitest';
import { MemoryDocketRepo } from '../docket.ts';
import {
  RESIGN_SCREEN_MIN_SAMPLES,
  fileFlags,
  screenResignations,
  screenSeat,
  screenTradeBias,
  type ScreenGame,
  type TradeRecord,
} from '../screens.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextGameId = 0;

/** A finished islanders-like game with a score table. */
function scoredGame(
  scores: number[],
  opts: { resignedSeat?: number; agents?: string[]; game?: string; variant?: string } = {},
): ScreenGame {
  const agents = opts.agents ?? scores.map((_, i) => `agent${i}`);
  const id = `sg${nextGameId++}`;
  const scoreTable: Record<string, number> = {};
  scores.forEach((s, i) => (scoreTable[`p${i}`] = s));
  const best = Math.max(...scores);
  return {
    game_id: id,
    game: opts.game ?? 'islanders',
    variant: opts.variant ?? '{}',
    division: 'pure',
    seats: agents.map((a, i) => screenSeat(i, a, `op-${a}`)),
    result: {
      winners: scores.map((s, i) => (s === best ? `p${i}` : null)).filter((x): x is string => x !== null),
      draw: false,
      reason: opts.resignedSeat !== undefined ? 'resignation' : 'points',
      scores: scoreTable,
    },
    resigned_player: opts.resignedSeat !== undefined ? `p${opts.resignedSeat}` : null,
  };
}

/** Background pool: N games with unremarkable score spreads. */
function backgroundGames(n: number): ScreenGame[] {
  const out: ScreenGame[] = [];
  for (let i = 0; i < n; i++) {
    out.push(scoredGame([4 + (i % 3), 5 + ((i + 1) % 4), 6 + (i % 2)]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resignation screen
// ---------------------------------------------------------------------------

describe('screenResignations', () => {
  it('flags a resignation while holding a top-decile final score', () => {
    const games = backgroundGames(10); // 30 scores in [4..9]
    games.push(scoredGame([10, 3, 2], { resignedSeat: 0, agents: ['suspect', 'x', 'y'] }));
    const flags = screenResignations(games);
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.kind).toBe('screen:resign_won_position');
    const subject = flag.subject as { agent_id: string; score: number; percentile_rank: number };
    expect(subject.agent_id).toBe('suspect');
    expect(subject.score).toBe(10);
    expect(subject.percentile_rank).toBeGreaterThanOrEqual(0.9);
    expect(flag.reason).toContain('suspect');
  });

  it('does not flag a resignation with a mid-pack score', () => {
    const games = backgroundGames(10);
    games.push(scoredGame([5, 8, 9], { resignedSeat: 0, agents: ['loser', 'x', 'y'] }));
    expect(screenResignations(games)).toHaveLength(0);
  });

  it('skips games whose results carry no scores (documented limit)', () => {
    const chess: ScreenGame = {
      game_id: 'c1',
      game: 'chess',
      variant: '{}',
      division: 'pure',
      seats: [screenSeat(0, 'a', 'opA'), screenSeat(1, 'b', 'opB')],
      result: { winners: ['p1'], draw: false, reason: 'resignation' },
      resigned_player: 'p0',
    };
    expect(screenResignations([chess, ...backgroundGames(10)])).toHaveLength(0);
  });

  it('requires a minimum score pool before flagging anything', () => {
    // Only 1 background game -> 3 + 3 = 6 scores < 20.
    const games = backgroundGames(1);
    games.push(scoredGame([10, 3, 2], { resignedSeat: 0 }));
    expect(screenResignations(games)).toHaveLength(0);
    expect(RESIGN_SCREEN_MIN_SAMPLES).toBe(20);
  });

  it('pools per (game, variant): scores from other games never contaminate', () => {
    // Big pool for islanders '{}', but the resignation is in variant '{"x":1}' with a tiny pool.
    const games = backgroundGames(10);
    games.push(scoredGame([10, 3, 2], { resignedSeat: 0, variant: '{"x":1}' }));
    expect(screenResignations(games)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trade-bias screen
// ---------------------------------------------------------------------------

function trade(
  game_id: string,
  fromOp: string,
  toOp: string,
  value: number,
): TradeRecord {
  return {
    game_id,
    from_agent: `agent-${fromOp}`,
    to_agent: `agent-${toOp}`,
    from_operator: fromOp,
    to_operator: toOp,
    value,
  };
}

describe('screenTradeBias', () => {
  it('flags persistent one-way value flow between one operator pair', () => {
    const trades = [
      trade('g1', 'opA', 'opB', 6),
      trade('g2', 'opA', 'opB', 7),
      trade('g3', 'opA', 'opB', 5),
    ];
    const flags = screenTradeBias(trades);
    expect(flags).toHaveLength(1);
    const subject = flags[0]!.subject as {
      donor_operator: string;
      beneficiary_operator: string;
      net_value: number;
      games: string[];
    };
    expect(subject.donor_operator).toBe('opA');
    expect(subject.beneficiary_operator).toBe('opB');
    expect(subject.net_value).toBe(18);
    expect(subject.games).toEqual(['g1', 'g2', 'g3']);
  });

  it('direction is normalized: value flowing the other way names the other donor', () => {
    const flags = screenTradeBias([
      trade('g1', 'opB', 'opA', 10),
      trade('g2', 'opB', 'opA', 10),
      trade('g3', 'opB', 'opA', 10),
    ]);
    expect(flags).toHaveLength(1);
    expect((flags[0]!.subject as { donor_operator: string }).donor_operator).toBe('opB');
  });

  it('does not flag high-volume but balanced trading (imbalance ratio)', () => {
    const trades = [
      trade('g1', 'opA', 'opB', 10),
      trade('g1', 'opB', 'opA', 9),
      trade('g2', 'opA', 'opB', 12),
      trade('g2', 'opB', 'opA', 10),
      trade('g3', 'opA', 'opB', 11),
      trade('g3', 'opB', 'opA', 12),
    ];
    // net = 2, gross = 64 -> imbalance ~3%: no flag even though gross is large.
    expect(screenTradeBias(trades)).toHaveLength(0);
  });

  it('needs enough distinct games and enough net value', () => {
    // Big net but only 2 games.
    expect(screenTradeBias([trade('g1', 'opA', 'opB', 20), trade('g2', 'opA', 'opB', 20)])).toHaveLength(0);
    // 3 games but trivial net.
    expect(
      screenTradeBias([trade('g1', 'opA', 'opB', 2), trade('g2', 'opA', 'opB', 2), trade('g3', 'opA', 'opB', 2)]),
    ).toHaveLength(0);
  });

  it('ignores same-operator (house vs house) trades and rejects bad values', () => {
    expect(
      screenTradeBias([trade('g1', 'house', 'house', 50), trade('g2', 'house', 'house', 50), trade('g3', 'house', 'house', 50)]),
    ).toHaveLength(0);
    expect(() => screenTradeBias([trade('g1', 'opA', 'opB', -5)])).toThrow(/value/);
  });
});

// ---------------------------------------------------------------------------
// Filing on the docket
// ---------------------------------------------------------------------------

describe('fileFlags', () => {
  it("files flags with disposition 'watching' and dedupes repeat sweeps", async () => {
    const docket = new MemoryDocketRepo();
    const trades = [trade('g1', 'opA', 'opB', 6), trade('g2', 'opA', 'opB', 7), trade('g3', 'opA', 'opB', 5)];

    const first = await fileFlags(screenTradeBias(trades), docket, '2026-09-02T00:00:00Z');
    expect(first).toHaveLength(1);
    expect(first[0]!.disposition).toBe('watching');
    expect(first[0]!.kind).toBe('screen:trade_bias');
    expect(first[0]!.created_at).toBe('2026-09-02T00:00:00Z');

    // Same screen output on the next sweep: nothing new filed.
    const second = await fileFlags(screenTradeBias(trades), docket, '2026-09-03T00:00:00Z');
    expect(second).toHaveLength(0);
    expect(await docket.list()).toHaveLength(1);

    // New evidence (an extra game changes the subject) files a new entry.
    const moreTrades = [...trades, trade('g4', 'opA', 'opB', 6)];
    const third = await fileFlags(screenTradeBias(moreTrades), docket, '2026-09-04T00:00:00Z');
    expect(third).toHaveLength(1);
    expect(await docket.list()).toHaveLength(2);
  });
});

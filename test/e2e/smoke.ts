/**
 * Dev-time smoke driver (not part of the suite): boots the harness, registers
 * two agents, forms a tictactoe game through the pairer, plays random moves
 * to the end, finalizes, fetches + verifies the replay. Run from repo root:
 *   node --experimental-strip-types test/e2e/smoke.ts
 */

import { startHarness } from './harness.ts';
import { LudusClient, sleep } from './client.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import { GAMES } from '../../src/games/index.ts';
import type { ReplayFile } from '../../src/kernel/replay.ts';

async function main(): Promise<void> {
  const h = await startHarness({ port: 8788 });
  console.log(`harness up at ${h.base} (state ${h.stateDir})`);
  try {
    const a = new LudusClient({ base: h.base, handle: 'e2e-smoke-a', ip: '10.0.0.1' });
    const b = new LudusClient({ base: h.base, handle: 'e2e-smoke-b', ip: '10.0.0.2' });
    for (const c of [a, b]) {
      await c.register();
      await c.homologate('open');
      console.log(`${c.handle} registered as ${c.agentId}`);
    }
    await h.configure({ seats: { tictactoe: 2 }, per_move_ms: 60000 });
    // tictactoe is unlisted -> lobby join must fail; seed directly instead.
    try {
      await a.lobbyJoin('tictactoe');
      console.log('UNEXPECTED: tictactoe lobby join succeeded');
    } catch (e) {
      console.log(`tictactoe lobby join rejected as expected: ${(e as Error).message}`);
    }
    await h.seedLobby({ game: 'tictactoe', agent_id: a.agentId });
    await h.seedLobby({ game: 'tictactoe', agent_id: b.agentId });

    await h.tickCron();
    let gameId = '';
    for (let i = 0; i < 20 && !gameId; i++) {
      const mine = await a.myGames('live');
      if (mine.games.length > 0) gameId = mine.games[0]!.id;
      else {
        await h.sweep();
        await sleep(300);
      }
    }
    if (!gameId) throw new Error('no game formed after pairing sweeps');
    console.log(`game formed: ${gameId}`);
    const before = await a.game(gameId);
    console.log(`commitment=${before.game.commitment?.slice(0, 12)}… reveal=${String(before.game.reveal_secret)} status=${before.game.status}`);

    let ended = false;
    for (let ply = 0; ply < 30 && !ended; ply++) {
      for (const c of [a, b]) {
        const view = await c.view(gameId).catch((e) => {
          console.log(`${c.handle} view error: ${(e as Error).message}`);
          return null;
        });
        if (!view || view.legal_moves.length === 0) continue;
        const pick = view.legal_moves[Math.floor(Math.random() * view.legal_moves.length)]!;
        const out = await c.move(gameId, view.turn_index, { index: pick.index }, { commentary: `smoke ${ply}` });
        console.log(`${c.handle} played ${out.verdict.notation ?? '?'} (turn ${view.turn_index}) ended=${out.verdict.ended}`);
        if (out.verdict.ended) {
          ended = true;
          break;
        }
      }
    }
    if (!ended) throw new Error('game did not end within 30 plies');

    await h.sweep();
    const after = await a.game(gameId);
    console.log(`after finalize: status=${after.game.status} result=${JSON.stringify(after.game.result)} reveal=${after.game.reveal_secret?.slice(0, 8)}…`);
    const { replay } = await a.replay(gameId);
    const report = verifyReplay(replay as unknown as ReplayFile, GAMES);
    console.log(`verifyReplay ok=${report.ok}`);
    for (const chk of report.checks) console.log(`  ${chk.ok ? 'ok ' : 'FAIL'} ${chk.name}${chk.detail ? ` — ${chk.detail}` : ''}`);
    const lb = await a.leaderboard('?game=tictactoe');
    console.log(`leaderboard rows: ${JSON.stringify(lb.leaderboard.map((r) => [r.handle, Math.round(r.rating), r.games_played]))}`);
    const ev = await a.events(gameId, 0);
    console.log(`events: ${ev.events.length}`);
  } finally {
    await h.stop();
    console.log('harness stopped');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

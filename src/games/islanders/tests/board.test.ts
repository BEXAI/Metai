import { describe, expect, it } from 'vitest';
import {
  BEGINNER_TERRAIN,
  BEGINNER_TOKENS,
  EDGE_IDS,
  EDGE_VERTICES,
  HARBORS,
  HEX_VERTICES,
  LAND_LETTERS,
  SEA_LETTERS,
  VERTEX_ADJ,
  VERTEX_EDGES,
  VERTEX_IDS,
  createInitialState,
  isEdgeId,
  vertexLandHexes,
} from '../rules.ts';
import { freshSeed, seatPlayers } from './helpers.ts';

describe('islanders board geometry', () => {
  it('has the standard 19 hexes, 54 vertices, 72 edges', () => {
    expect(LAND_LETTERS.length).toBe(19);
    expect(SEA_LETTERS.length).toBe(18);
    expect(VERTEX_IDS.length).toBe(54);
    expect(EDGE_IDS.length).toBe(72);
  });

  it('every land hex has exactly 6 vertices; every edge 2 vertices; vertex ids are sorted letters', () => {
    for (const L of LAND_LETTERS) expect(HEX_VERTICES[L]!.length).toBe(6);
    for (const e of EDGE_IDS) expect(EDGE_VERTICES[e]!.length).toBe(2);
    for (const v of VERTEX_IDS) {
      expect(v).toBe([...v].sort().join(''));
      expect(vertexLandHexes(v).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('vertex adjacency is symmetric and 2-3 wide', () => {
    for (const v of VERTEX_IDS) {
      const adj = VERTEX_ADJ[v]!;
      expect(adj.length).toBeGreaterThanOrEqual(2);
      expect(adj.length).toBeLessThanOrEqual(3);
      for (const w of adj) expect(VERTEX_ADJ[w]!).toContain(v);
      expect(VERTEX_EDGES[v]!.length).toBe(adj.length);
    }
  });

  it('beginner layout has the documented terrain and token distribution', () => {
    const terrainCounts: Record<string, number> = {};
    for (const L of LAND_LETTERS) {
      const t = BEGINNER_TERRAIN[L]!;
      terrainCounts[t] = (terrainCounts[t] ?? 0) + 1;
    }
    expect(terrainCounts).toEqual({ grove: 4, reef: 3, marsh: 4, paddy: 4, volcano: 3, dunes: 1 });
    const tokens = Object.values(BEGINNER_TOKENS).sort((a, b) => a - b);
    expect(tokens).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
    expect(BEGINNER_TOKENS['J']).toBeUndefined(); // dunes has no token
  });

  it('all 9 harbors sit on real coastal edges (one land + one sea hex)', () => {
    const kinds = Object.values(HARBORS);
    expect(kinds.filter((k) => k === 'any').length).toBe(4);
    expect(new Set(kinds.filter((k) => k !== 'any'))).toEqual(new Set(['palm', 'coral', 'reed', 'taro', 'obsidian']));
    for (const e of Object.keys(HARBORS)) {
      expect(isEdgeId(e)).toBe(true);
      const land = [...e].filter((c) => c >= 'A' && c <= 'Z');
      expect(land.length).toBe(1); // coastal: exactly one land hex
    }
  });

  it('random variant shuffles terrain and tokens deterministically from the seed', () => {
    const players = seatPlayers(3);
    const a = createInitialState(freshSeed('layout-a'), players, { layout: 'random' });
    const b = createInitialState(freshSeed('layout-a'), players, { layout: 'random' });
    const c = createInitialState(freshSeed('layout-c'), players, { layout: 'random' });
    expect(a.terrain).toEqual(b.terrain);
    expect(a.tokens).toEqual(b.tokens);
    expect(a.terrain).not.toEqual(c.terrain);
    // same multisets as beginner
    const count = (m: Record<string, string>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const v of Object.values(m)) out[v] = (out[v] ?? 0) + 1;
      return out;
    };
    expect(count(a.terrain)).toEqual(count(BEGINNER_TERRAIN));
    expect(Object.values(a.tokens).sort((x, y) => x - y)).toEqual(Object.values(BEGINNER_TOKENS).sort((x, y) => x - y));
    // raider starts on the dunes hex; dunes has no token
    expect(a.terrain[a.raider]).toBe('dunes');
    expect(a.tokens[a.raider]).toBeUndefined();
    expect(Object.keys(a.tokens).length).toBe(18);
  });
});

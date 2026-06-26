import { describe, it, expect } from 'vitest';
import {
  statusPenalty,
  rerankScore,
  rankPenalty,
  STATUS_PENALTY,
} from '../src/utils/rank-weight.js';

describe('statusPenalty', () => {
  it('penalises repealed most, then not-yet-in-force/amended, never in_force', () => {
    expect(statusPenalty('in_force')).toBe(0);
    expect(statusPenalty('amended')).toBeGreaterThan(0);
    expect(statusPenalty('repealed')).toBeGreaterThan(statusPenalty('amended'));
  });

  it('treats unknown/null status as no penalty (in_force)', () => {
    expect(statusPenalty(null)).toBe(0);
    expect(statusPenalty(undefined)).toBe(0);
    expect(statusPenalty('garbage')).toBe(0);
  });
});

describe('rerankScore', () => {
  it('keeps bm25 direction (lower = better) and adds the status penalty', () => {
    // bm25 is negative; repealed gets a positive penalty -> ranked worse (higher).
    expect(rerankScore(-17, 'in_force')).toBe(-17);
    expect(rerankScore(-17, 'repealed')).toBe(-17 + STATUS_PENALTY.repealed);
  });

  it('sinks a slightly-more-relevant repealed row below an in-force one', () => {
    // Repealed row is marginally more relevant by bm25, but should rank lower.
    const repealed = rerankScore(-17.6, 'repealed'); // -15.6
    const inForce = rerankScore(-17.2, 'in_force');  // -17.2
    expect(inForce).toBeLessThan(repealed); // in_force wins (lower = better)
  });

  it('still lets a FAR-more-relevant repealed row surface', () => {
    // A repealed provision that massively out-matches keeps the top spot — repealed
    // law is sometimes the right answer; the penalty demotes, it does not delete.
    const repealed = rerankScore(-25, 'repealed'); // -23
    const inForce = rerankScore(-17, 'in_force');  // -17
    expect(repealed).toBeLessThan(inForce);
  });
});

describe('rankPenalty + hierarchy in rerankScore', () => {
  it('penalises lower source-of-law rank, never the Constitution (rank 0)', () => {
    expect(rankPenalty(0)).toBe(0);                 // Konstytucja
    expect(rankPenalty(2)).toBeGreaterThan(0);      // ustawa
    expect(rankPenalty(3)).toBeGreaterThan(rankPenalty(2)); // rozporządzenie below ustawa
    expect(rankPenalty(null)).toBe(0);
  });

  it('status dominates rank: an in-force statute beats a repealed constitution match', () => {
    const repealedConst = rerankScore(-17, 'repealed', 0); // status penalty 2.0, rank 0
    const inForceStatute = rerankScore(-17, 'in_force', 2); // rank penalty 0.5
    expect(inForceStatute).toBeLessThan(repealedConst);
  });

  it('rank breaks ties between equally-relevant in-force sources', () => {
    const konstytucja = rerankScore(-17, 'in_force', 0);
    const ustawa = rerankScore(-17, 'in_force', 2);
    expect(konstytucja).toBeLessThan(ustawa); // Constitution ranks higher
  });
});

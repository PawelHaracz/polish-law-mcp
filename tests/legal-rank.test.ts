import { describe, it, expect } from 'vitest';
import {
  classifyLegalRank,
  RANK_CONSTITUTION,
  RANK_TREATY,
  RANK_STATUTE,
  RANK_REGULATION,
} from '../src/utils/legal-rank.js';

describe('classifyLegalRank', () => {
  it('ranks the Constitution highest (0)', () => {
    expect(classifyLegalRank('Konstytucja Rzeczypospolitej Polskiej z dnia 2 kwietnia 1997 r.'))
      .toBe(RANK_CONSTITUTION);
  });

  it('ranks ratified international instruments above statutes (1)', () => {
    expect(classifyLegalRank('Konwencja o ochronie praw człowieka')).toBe(RANK_TREATY);
    expect(classifyLegalRank('Traktat o Unii Europejskiej')).toBe(RANK_TREATY);
  });

  it('ranks ordinary statutes and codes at the statutory rung (2)', () => {
    expect(classifyLegalRank('Ustawa z dnia 6 czerwca 1997 r. - Kodeks karny')).toBe(RANK_STATUTE);
    expect(classifyLegalRank('Ustawa z dnia 26 czerwca 1974 r. Kodeks pracy.')).toBe(RANK_STATUTE);
  });

  it('keeps rozporządzenie z mocą ustawy at the statutory rung', () => {
    expect(classifyLegalRank('Rozporządzenie Prezydenta Rzeczypospolitej z dnia 27 czerwca 1934 r. z mocą ustawy - Kodeks handlowy'))
      .toBe(RANK_STATUTE);
  });

  it('ranks ordinary (executive) regulations below statutes (3)', () => {
    expect(classifyLegalRank('Rozporządzenie Ministra Finansów z dnia 1 stycznia 2020 r.'))
      .toBe(RANK_REGULATION);
  });

  it('falls back to statute for empty/unknown titles', () => {
    expect(classifyLegalRank(null)).toBe(RANK_STATUTE);
    expect(classifyLegalRank('')).toBe(RANK_STATUTE);
  });
});

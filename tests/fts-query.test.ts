import { describe, it, expect } from 'vitest';
import {
  sanitizeFtsInput,
  buildFtsQueryVariants,
  buildLikePattern,
  normalizePolishForFts,
} from '../src/utils/fts-query.js';

describe('normalizePolishForFts', () => {
  it('folds ł/Ł to l/L only — unicode61 handles the rest', () => {
    expect(normalizePolishForFts('opłata')).toBe('oplata');
    // Only ł is folded; ś is left for unicode61's diacritic stripping.
    expect(normalizePolishForFts('właściciel')).toBe('wlaściciel');
    expect(normalizePolishForFts('PŁATNOŚĆ')).toBe('PLATNOŚĆ');
  });

  it('leaves NFD-decomposable diacritics for unicode61 to handle but is idempotent', () => {
    // ą, ć, ę, ś, ż etc. — keeping them is fine (unicode61 strips them);
    // the function only needs to guarantee ł is folded.
    expect(normalizePolishForFts('świadczenie')).toBe('świadczenie');
    expect(normalizePolishForFts(normalizePolishForFts('opłata'))).toBe('oplata');
  });
});

describe('sanitizeFtsInput — Polish ł folding', () => {
  it('folds ł so queries match the (ł-folded) index', () => {
    expect(sanitizeFtsInput('opłata')).toBe('oplata');
    expect(sanitizeFtsInput('umowa o pracę')).toContain('prac');
  });
});

describe('buildFtsQueryVariants — Polish inflection via prefix', () => {
  it('emits an all-token prefix variant before the OR fallback (catches inflection)', () => {
    const variants = buildFtsQueryVariants(sanitizeFtsInput('świadczenie odszkodowanie'));
    // Should contain a variant where BOTH tokens are prefix-wildcarded.
    const allPrefix = variants.find(
      v => v.includes('świadczenie*') && v.includes('odszkodowanie*') && v.includes('AND'),
    );
    expect(allPrefix).toBeTruthy();
  });

  it('for a single term, emits the prefix variant', () => {
    const variants = buildFtsQueryVariants(sanitizeFtsInput('świadczenie'));
    expect(variants).toContain('świadczenie*');
  });

  it('orders the all-token-prefix variant ahead of the OR variant', () => {
    const variants = buildFtsQueryVariants(sanitizeFtsInput('umowa najmu'));
    const prefixIdx = variants.findIndex(v => v.includes('umowa*') && v.includes('najmu*'));
    const orIdx = variants.findIndex(v => v === 'umowa OR najmu');
    expect(prefixIdx).toBeGreaterThanOrEqual(0);
    expect(orIdx).toBeGreaterThanOrEqual(0);
    expect(prefixIdx).toBeLessThan(orIdx);
  });
});

describe('buildLikePattern — keeps raw spelling', () => {
  it('does NOT fold ł, because the LIKE fallback queries raw content', () => {
    // Raw content column keeps "opłata"; a folded "%oplata%" would miss it.
    expect(buildLikePattern('opłata')).toBe('%opłata%');
  });
});

import { describe, it, expect } from 'vitest';
import { isDescendantRef, collapseAncestorRefs, normalizeSuperscriptRef } from '../src/utils/provision-ref.js';

describe('isDescendantRef', () => {
  it('treats sub-level refs as descendants of the article', () => {
    expect(isDescendantRef('art1u2', 'art1')).toBe(true);
    expect(isDescendantRef('art1u2p3la', 'art1')).toBe(true);
    expect(isDescendantRef('art1u2p3la', 'art1u2')).toBe(true);
    expect(isDescendantRef('art267par1', 'art267')).toBe(true);
  });

  it('does NOT treat a string-prefix of a different article as a descendant', () => {
    // "art1" is a string-prefix of "art10" but they are different articles.
    expect(isDescendantRef('art10', 'art1')).toBe(false);
    expect(isDescendantRef('art10u1', 'art1')).toBe(false);
  });

  it('is false for equal refs and unrelated refs', () => {
    expect(isDescendantRef('art1', 'art1')).toBe(false);
    expect(isDescendantRef('art2u1', 'art1')).toBe(false);
  });
});

describe('collapseAncestorRefs', () => {
  const row = (document_title: string, provision_ref: string) => ({ document_title, provision_ref });

  it('drops the article aggregate when a descendant is present in the same document', () => {
    const rows = [row('KK', 'art267'), row('KK', 'art267par1')];
    const out = collapseAncestorRefs(rows).map(r => r.provision_ref);
    expect(out).toEqual(['art267par1']);
  });

  it('keeps the article when no descendant is present', () => {
    const rows = [row('KK', 'art267'), row('KC', 'art23')];
    expect(collapseAncestorRefs(rows)).toHaveLength(2);
  });

  it('does not collapse across different documents', () => {
    const rows = [row('KK', 'art1'), row('KC', 'art1u2')];
    expect(collapseAncestorRefs(rows)).toHaveLength(2);
  });

  it('preserves relevance order of surviving rows', () => {
    const rows = [row('KK', 'art10'), row('KK', 'art1'), row('KK', 'art1u2')];
    const out = collapseAncestorRefs(rows).map(r => r.provision_ref);
    expect(out).toEqual(['art10', 'art1u2']);
  });
});

describe('normalizeSuperscriptRef', () => {
  it('maps typed superscripts and brackets to the stored ^ form', () => {
    expect(normalizeSuperscriptRef('art22¹')).toBe('art22^1');
    expect(normalizeSuperscriptRef('art22[1]')).toBe('art22^1');
    expect(normalizeSuperscriptRef('art30par2²ᵃ')).toBe('art30par2^2a');
    expect(normalizeSuperscriptRef('art22^1')).toBe('art22^1');
    expect(normalizeSuperscriptRef('art221')).toBe('art221');
  });

  it('treats a superscript article as a sibling, not a descendant, of the base article', () => {
    expect(isDescendantRef('art22^1', 'art22')).toBe(false);
    expect(isDescendantRef('art22^1par2', 'art22^1')).toBe(true);
    expect(isDescendantRef('art30par2^1', 'art30')).toBe(true);
    expect(isDescendantRef('art30par2^1', 'art30par2')).toBe(false);
  });
});

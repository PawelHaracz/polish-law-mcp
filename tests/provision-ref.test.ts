import { describe, it, expect } from 'vitest';
import { isDescendantRef, collapseAncestorRefs } from '../src/utils/provision-ref.js';

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

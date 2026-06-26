/**
 * Helpers for the hierarchical provision_ref scheme produced by the parser.
 *
 * Refs concatenate level tags + numbers, e.g.
 *   art1            artykuł 1 (the whole-article aggregate row)
 *   art1par2        art. 1 § 2
 *   art1u2          art. 1 ust. 2
 *   art1u2p3        art. 1 ust. 2 pkt 3
 *   art1u2p3la      art. 1 ust. 2 pkt 3 lit. a
 *
 * The DB stores BOTH an article aggregate row and one row per leaf sub-unit, so
 * a full-text query can match both the article and a descendant. When that
 * happens we want to surface the most specific (descendant) hit, not the broad
 * article — see collapseAncestorRefs.
 */

/** Sub-level tags that may follow an article number in a ref. */
const SUBLEVEL_TAGS = ['par', 'sl', 'u', 'p', 'l'] as const;

/**
 * True when `descendant` is a strictly deeper ref under `ancestor` — i.e. it
 * starts with the ancestor ref AND the remainder begins with a sub-level tag.
 * The tag check prevents "art1" from being treated as an ancestor of "art10"
 * (string-prefix but a different article).
 */
export function isDescendantRef(descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return false;
  if (!descendant.startsWith(ancestor)) return false;
  const rest = descendant.slice(ancestor.length);
  return SUBLEVEL_TAGS.some(tag => rest.startsWith(tag));
}

/** A search/stance row, reduced to the fields collapse needs. */
interface RefRow {
  document_title: string;
  provision_ref: string;
}

/**
 * Drop an aggregate/ancestor row when a more specific descendant row for the
 * same document is also present in the result set. Preserves input order
 * (which callers keep sorted by relevance). Generic over the row shape.
 */
export function collapseAncestorRefs<T extends RefRow>(rows: T[]): T[] {
  return rows.filter(row =>
    !rows.some(other =>
      other.document_title === row.document_title &&
      isDescendantRef(other.provision_ref, row.provision_ref),
    ),
  );
}

/**
 * Superscript unit numbers (art. 22¹, § 2¹, art. 300⁷⁵) shared by the HTML and
 * PDF parsers. Refs and the section column carry them as "^k" ("art22^1",
 * section "22^1"), which never collides with a real art. 221; titles and text
 * show real superscript characters.
 */

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ',
};

/** "75" -> "⁷⁵"; null when a character has no superscript form. */
export function toSuperscript(s: string): string | null {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const sup = SUPERSCRIPT[ch];
    if (!sup) return null;
    out += sup;
  }
  return out;
}

/** Display form of a caret number: "300^75" -> "300⁷⁵", "20a" -> "20a". */
export function caretToDisplay(n: string): string {
  return n.replace(/\^(\w+)/, (whole, k: string) => toSuperscript(k) ?? whole);
}

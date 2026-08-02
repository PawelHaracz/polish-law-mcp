/**
 * Source-of-law hierarchy (art. 87/91 Konstytucji RP), as a sortable rank.
 *
 * Lower rank = higher legal force. Used as a secondary reranking signal so that,
 * all else being comparable, a higher-ranked source (Konstytucja, ratified
 * treaty) surfaces above an ordinary statute, and a regulation below it.
 *
 *   0  Konstytucja
 *   1  ratyfikowana umowa międzynarodowa / konwencja / traktat (pierwszeństwo
 *      przed ustawą — art. 91 ust. 2)
 *   2  ustawa (w tym kodeksy) i rozporządzenie z mocą ustawy
 *   3  rozporządzenie (wykonawcze)
 *   4  akt prawa miejscowego
 *
 * EU regulations apply "across" this ladder (art. 91 ust. 3) — flagged
 * separately where relevant, not encoded as a single rung.
 *
 * NOTE: this corpus currently ingests only Ustawy, so in practice we see ranks
 * 0–2. The classifier still handles 3–4 so it keeps working once regulations /
 * local law are added.
 */

export const RANK_CONSTITUTION = 0;
export const RANK_TREATY = 1;
export const RANK_STATUTE = 2;
export const RANK_REGULATION = 3;
export const RANK_LOCAL = 4;

/** Default rank when a title doesn't match a more specific pattern. */
export const RANK_DEFAULT = RANK_STATUTE;

/**
 * Classify an act into the source-of-law hierarchy from its (Polish) title.
 * Title-based because the Sejm ELI feed does not carry a structured act-kind.
 */
export function classifyLegalRank(title: string | null | undefined): number {
  if (!title) return RANK_DEFAULT;
  const t = title.trim();

  if (/\bKonstytucja\b/i.test(t)) return RANK_CONSTITUTION;

  // Ratified international instruments — outrank ordinary statutes.
  if (/\b(Konwencja|Traktat|Umowa mi[ęe]dzynarodowa|Protok[óo][łl]|Porozumienie mi[ęe]dzynarodowe|Pakt)\b/i.test(t)) {
    return RANK_TREATY;
  }

  // Rozporządzenie z mocą ustawy (war-time) sits at the statutory rung.
  if (/rozporz[ąa]dzeni\w*\s+Prezydenta[\s\S]*z\s+moc[ąa]\s+ustawy/i.test(t)) {
    return RANK_STATUTE;
  }
  // Ordinary (executive) regulation.
  if (/^Rozporz[ąa]dzeni\w*/i.test(t)) return RANK_REGULATION;

  // Local law (voivodeship/municipal) — included for forward-compatibility.
  if (/\b(uchwa[łl]a rady|prawo miejscowe|zarz[ąa]dzenie wojewody)\b/i.test(t)) {
    return RANK_LOCAL;
  }

  // Ustawa / Kodeks / Dekret / older statute variants.
  return RANK_DEFAULT;
}

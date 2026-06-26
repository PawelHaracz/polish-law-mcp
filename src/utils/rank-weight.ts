/**
 * Multi-signal reranking weights for legal search.
 *
 * FTS5 bm25() is NEGATIVE — more negative = more relevant. We rerank by ADDING a
 * penalty to bm25 (higher final score = worse), so a less-relevant-but-in-force
 * provision can outrank a perfectly-matching but repealed one. This is NOT hybrid
 * (lexical+semantic) search — it enriches the single lexical signal with legal
 * metadata (validity status, and later source hierarchy) that embeddings could
 * not supply, because "this provision was repealed" is a legal fact, not meaning.
 *
 * The eval that motivated this: queries like "odpowiedzialność za szkodę" returned
 * a repealed Atomic Law provision at rank 1 with the Civil Code pushed to 4-5;
 * "przetwarzanie danych" returned 4/5 repealed Telecom Law 2000 rows.
 *
 * Penalty magnitudes are calibrated against the observed bm25 spread across the
 * top results (~0.05–0.5 between neighbours, values around -17): a repealed
 * penalty of ~2.0 reliably sinks repealed rows below comparably-relevant in-force
 * rows, without erasing a repealed row that is FAR more relevant than anything
 * else (it can still surface — repealed law is sometimes the right answer).
 */

export type DocStatus = 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';

/** Penalty added to bm25 by document validity status. Higher = ranked lower. */
export const STATUS_PENALTY: Record<DocStatus, number> = {
  in_force: 0,
  not_yet_in_force: 0.5, // applies, but not yet binding — slight demotion
  amended: 0.3,          // still in force in amended form — minor demotion
  repealed: 2.0,         // no longer binding — strong demotion, not removal
};

/** Fallback for unknown/null status values — treat as in_force (no penalty). */
export function statusPenalty(status: string | null | undefined): number {
  if (status && status in STATUS_PENALTY) {
    return STATUS_PENALTY[status as DocStatus];
  }
  return 0;
}

/**
 * Final rerank score from a raw bm25 value and the document status.
 * Lower = better, same direction as bm25, so existing ORDER BY ASC keeps working.
 *
 * Designed to extend: a future legal_rank (Konstytucja=0 … prawo miejscowe=4)
 * becomes another additive term here without touching call sites.
 */
export function rerankScore(bm25: number, status: string | null | undefined): number {
  return bm25 + statusPenalty(status);
}

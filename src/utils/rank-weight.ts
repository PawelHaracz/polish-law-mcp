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
 * Per-rung penalty for the source-of-law hierarchy (legal_rank). Konstytucja=0
 * gets no penalty; each rung down (ustawa, rozporządzenie, …) adds a small nudge.
 * Deliberately SMALLER than the status penalties: validity ("is this still
 * binding") matters more than rank ("how high in the hierarchy") for surfacing
 * the right provision. Tunable.
 */
export const RANK_PENALTY_PER_RUNG = 0.25;

/** Penalty added to bm25 by source-of-law rank (0=Konstytucja … 4=local). */
export function rankPenalty(legalRank: number | null | undefined): number {
  if (typeof legalRank !== 'number' || legalRank <= 0) return 0;
  return legalRank * RANK_PENALTY_PER_RUNG;
}

/**
 * Final rerank score from a raw bm25 value, the document status, and the
 * source-of-law rank. Lower = better, same direction as bm25, so existing
 * ORDER BY ASC keeps working.
 *
 * Combined signal: bm25 (relevance) + status penalty (validity) + rank penalty
 * (hierarchy). Status dominates rank by design.
 */
export function rerankScore(
  bm25: number,
  status: string | null | undefined,
  legalRank?: number | null,
): number {
  return bm25 + statusPenalty(status) + rankPenalty(legalRank);
}

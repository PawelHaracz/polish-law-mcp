/**
 * search_legislation — Full-text search across Polish statute provisions.
 */

import type Database from '@ansvar/mcp-sqlite';
import { buildFtsQueryVariants, buildLikePattern, sanitizeFtsInput } from '../utils/fts-query.js';
import { normalizeAsOfDate } from '../utils/as-of-date.js';
import { resolveDocumentId } from '../utils/statute-id.js';
import { collapseAncestorRefs } from '../utils/provision-ref.js';
import { rerankScore } from '../utils/rank-weight.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SearchLegislationInput {
  query: string;
  document_id?: string;
  status?: string;
  as_of_date?: string;
  limit?: number;
}

export interface SearchLegislationResult {
  document_id: string;
  document_title: string;
  provision_ref: string;
  chapter: string | null;
  section: string;
  title: string | null;
  snippet: string;
  relevance: number;
  /** Document validity status — used internally for reranking; not part of the public shape. */
  status?: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function searchLegislation(
  db: InstanceType<typeof Database>,
  input: SearchLegislationInput,
): Promise<ToolResponse<SearchLegislationResult[]>> {
  if (!input.query || input.query.trim().length === 0) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Fetch extra rows to account for deduplication
  const fetchLimit = limit * 2;
  const queryVariants = buildFtsQueryVariants(sanitizeFtsInput(input.query));

  // Resolve document_id from title if provided (same resolution as get_provision)
  let resolvedDocId: string | undefined;
  if (input.document_id) {
    const resolved = resolveDocumentId(db, input.document_id);
    resolvedDocId = resolved ?? undefined;
    if (!resolved) {
      return {
        results: [],
        _metadata: {
          ...generateResponseMetadata(db),
          note: `No document found matching "${input.document_id}"`,
        },
      };
    }
  }

  let queryStrategy = 'none';
  for (const ftsQuery of queryVariants) {
    // bm25 weights: content (col 0) is the primary signal; doc_title (col 1) is
    // weighted higher so a query matching the statute name (e.g. "kodeks karny")
    // surfaces that act's provisions ahead of incidental body mentions.
    // Snippet is built from the RAW lp.content (not the ł-folded FTS copy) so the
    // displayed text keeps correct Polish spelling.
    let sql = `
      SELECT
        lp.document_id,
        ld.title as document_title,
        lp.provision_ref,
        lp.chapter,
        lp.section,
        lp.title,
        substr(lp.content, 1, 240) as snippet,
        bm25(provisions_fts, 1.0, 8.0) as relevance,
        ld.status as status
      FROM provisions_fts
      JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
      JOIN legal_documents ld ON ld.id = lp.document_id
      WHERE provisions_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (resolvedDocId) {
      sql += ' AND lp.document_id = ?';
      params.push(resolvedDocId);
    }

    if (input.status) {
      sql += ' AND ld.status = ?';
      params.push(input.status);
    }

    sql += ' ORDER BY relevance LIMIT ?';
    params.push(fetchLimit);

    try {
      const rows = db.prepare(sql).all(...params) as SearchLegislationResult[];
      if (rows.length > 0) {
        queryStrategy = ftsQuery === queryVariants[0] ? 'exact' : 'fallback';
        rerankByStatus(rows);
        const deduped = deduplicateResults(rows, limit);
        return {
          results: deduped,
          _metadata: {
            ...generateResponseMetadata(db),
            ...(queryStrategy === 'fallback' ? { query_strategy: 'broadened' } : {}),
          },
        };
      }
    } catch {
      // FTS query syntax error — try next variant
      continue;
    }
  }

  // LIKE fallback — last resort when all FTS5 variants return empty
  {
    const likePattern = buildLikePattern(sanitizeFtsInput(input.query));
    let sql = `
      SELECT
        lp.document_id,
        ld.title as document_title,
        lp.provision_ref,
        lp.chapter,
        lp.section,
        lp.title,
        substr(lp.content, 1, 200) as snippet,
        0 as relevance
      FROM legal_provisions lp
      JOIN legal_documents ld ON ld.id = lp.document_id
      WHERE lp.content LIKE ? COLLATE NOCASE
    `;
    const params: (string | number)[] = [likePattern];

    if (resolvedDocId) {
      sql += ' AND lp.document_id = ?';
      params.push(resolvedDocId);
    }

    if (input.status) {
      sql += ' AND ld.status = ?';
      params.push(input.status);
    }

    sql += ' LIMIT ?';
    params.push(fetchLimit);

    try {
      const rows = db.prepare(sql).all(...params) as SearchLegislationResult[];
      if (rows.length > 0) {
        return {
          results: deduplicateResults(rows, limit),
          _metadata: {
            ...generateResponseMetadata(db),
            query_strategy: 'like_fallback',
          },
        };
      }
    } catch {
      // LIKE query failed — fall through to empty return
    }
  }

  return { results: [], _metadata: generateResponseMetadata(db) };
}

/**
 * Rerank rows in place by relevance AND document validity status, so a repealed
 * provision no longer outranks a comparably-relevant in-force one. bm25 rows come
 * in pre-sorted by relevance; this is a stable demotion of repealed/amended rows.
 * Sorts ascending because both bm25 and the penalty are "lower = better".
 */
function rerankByStatus(rows: SearchLegislationResult[]): void {
  rows.sort((a, b) => rerankScore(a.relevance, a.status) - rerankScore(b.relevance, b.status));
}

/**
 * Deduplicate search results by document_title + provision_ref.
 * Duplicate document IDs (numeric vs slug) cause the same provision to appear twice.
 * Keeps the first (highest-ranked) occurrence.
 *
 * First collapses ancestor rows: because the DB holds both an article aggregate
 * and its leaf sub-units, a query can match both — we drop the broad article when
 * a more specific descendant (e.g. art1u2p3) is present, so the hit points at the
 * precise provision.
 */
function deduplicateResults(
  rows: SearchLegislationResult[],
  limit: number,
): SearchLegislationResult[] {
  rows = collapseAncestorRefs(rows);
  const seen = new Set<string>();
  const deduped: SearchLegislationResult[] = [];
  for (const row of rows) {
    const key = `${row.document_title}::${row.provision_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

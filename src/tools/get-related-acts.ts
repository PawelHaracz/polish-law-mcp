/**
 * get_related_acts — Graph neighbours of an act via the cross_references edges
 * (amended_by / references). Answers "what amends this act?" and "what does this
 * act amend or cite?" by traversing the citation graph in both directions.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface GetRelatedActsInput {
  document_id: string;
  /** 'outbound' = acts this one cites/amends; 'inbound' = acts citing/amending this one; 'both' (default). */
  direction?: 'outbound' | 'inbound' | 'both';
  ref_type?: 'references' | 'amended_by';
  limit?: number;
}

export interface RelatedActResult {
  document_id: string;
  document_title: string;
  status: string;
  legal_rank: number;
  ref_type: string;
  /** 'outbound' (target of this act's edge) or 'inbound' (source pointing at this act). */
  direction: 'outbound' | 'inbound';
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function getRelatedActs(
  db: InstanceType<typeof Database>,
  input: GetRelatedActsInput,
): Promise<ToolResponse<RelatedActResult[]>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return {
      results: [],
      _metadata: {
        ...generateResponseMetadata(db),
        note: `No document found matching "${input.document_id}"`,
      },
    };
  }

  try {
    db.prepare('SELECT 1 FROM cross_references LIMIT 1').get();
  } catch {
    return {
      results: [],
      _metadata: { ...generateResponseMetadata(db), note: 'Citation graph not available in this database.' },
    };
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const direction = input.direction ?? 'both';
  const results: RelatedActResult[] = [];

  // Outbound: edges where this act is the source — acts it cites/amends.
  if (direction === 'outbound' || direction === 'both') {
    let sql = `
      SELECT ld.id as document_id, ld.title as document_title, ld.status,
             ld.legal_rank, xr.ref_type
      FROM cross_references xr
      JOIN legal_documents ld ON ld.id = xr.target_document_id
      WHERE xr.source_document_id = ?
    `;
    const params: (string | number)[] = [resolvedId];
    if (input.ref_type) { sql += ' AND xr.ref_type = ?'; params.push(input.ref_type); }
    sql += ' ORDER BY ld.legal_rank, ld.status LIMIT ?';
    params.push(limit);
    for (const r of db.prepare(sql).all(...params) as Omit<RelatedActResult, 'direction'>[]) {
      results.push({ ...r, direction: 'outbound' });
    }
  }

  // Inbound: edges where this act is the target — acts that cite/amend it.
  if (direction === 'inbound' || direction === 'both') {
    let sql = `
      SELECT ld.id as document_id, ld.title as document_title, ld.status,
             ld.legal_rank, xr.ref_type
      FROM cross_references xr
      JOIN legal_documents ld ON ld.id = xr.source_document_id
      WHERE xr.target_document_id = ?
    `;
    const params: (string | number)[] = [resolvedId];
    if (input.ref_type) { sql += ' AND xr.ref_type = ?'; params.push(input.ref_type); }
    sql += ' ORDER BY ld.legal_rank, ld.status LIMIT ?';
    params.push(limit);
    for (const r of db.prepare(sql).all(...params) as Omit<RelatedActResult, 'direction'>[]) {
      results.push({ ...r, direction: 'inbound' });
    }
  }

  return { results, _metadata: generateResponseMetadata(db) };
}

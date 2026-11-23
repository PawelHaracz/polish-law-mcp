/**
 * get_provision — Retrieve specific provision(s) from an Polish statute.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse, type RelatedActRef } from '../utils/metadata.js';
import { buildProvisionCitation } from '../utils/citation.js';
import { normalizeSuperscriptRef } from '../utils/provision-ref.js';

/**
 * Graph-aware context: the acts that amend the given document (inbound
 * amended_by edges). Surfaced alongside a provision so the caller immediately
 * sees "this act has been amended by …" without a separate get_related_acts call.
 * Returns at most `limit` rows; empty when the graph is absent or there are none.
 */
function relatedAmendingActs(
  db: InstanceType<typeof Database>,
  documentId: string,
  limit = 10,
): RelatedActRef[] {
  try {
    const rows = db.prepare(`
      SELECT ld.id as document_id, ld.title as document_title, xr.ref_type
      FROM cross_references xr
      JOIN legal_documents ld ON ld.id = xr.source_document_id
      WHERE xr.target_document_id = ? AND xr.ref_type = 'amended_by'
      ORDER BY ld.issued_date DESC
      LIMIT ?
    `).all(documentId, limit) as Array<{ document_id: string; document_title: string; ref_type: string }>;
    return rows.map(r => ({ ...r, direction: 'inbound' as const }));
  } catch {
    return []; // graph table not present in this DB tier
  }
}

export interface GetProvisionInput {
  document_id: string;
  section?: string;
  provision_ref?: string;
  as_of_date?: string;
}

export interface ProvisionResult {
  document_id: string;
  document_title: string;
  provision_ref: string;
  chapter: string | null;
  section: string;
  title: string | null;
  content: string;
  section_number?: string;
  url?: string;
}

export async function getProvision(
  db: InstanceType<typeof Database>,
  input: GetProvisionInput,
): Promise<ToolResponse<ProvisionResult[]>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return {
      results: [],
      _metadata: {
        ...generateResponseMetadata(db),
        ...{ note: `No document found matching "${input.document_id}"` },
      },
    };
  }

  const docRow = db.prepare(
    'SELECT id, title, url FROM legal_documents WHERE id = ?'
  ).get(resolvedId) as { id: string; title: string; url: string | null } | undefined;
  if (!docRow) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  // Specific provision lookup
  const ref = input.provision_ref ?? input.section;
  if (ref) {
    // Strip subsection references: "13(1)" -> "13", "s13(2)(a)" -> "s13"
    const refTrimmed = normalizeSuperscriptRef(ref.trim()).replace(/(\([\dA-Za-z]+\))+$/, '');

    // Try direct provision_ref match
    let provision = db.prepare(
      'SELECT * FROM legal_provisions WHERE document_id = ? AND provision_ref = ?'
    ).get(resolvedId, refTrimmed) as Record<string, unknown> | undefined;

    // Try with "s" prefix (e.g., "1" -> "s1")
    if (!provision) {
      provision = db.prepare(
        'SELECT * FROM legal_provisions WHERE document_id = ? AND provision_ref = ?'
      ).get(resolvedId, `s${refTrimmed}`) as Record<string, unknown> | undefined;
    }

    // Try section column match
    if (!provision) {
      provision = db.prepare(
        'SELECT * FROM legal_provisions WHERE document_id = ? AND section = ?'
      ).get(resolvedId, refTrimmed) as Record<string, unknown> | undefined;
    }

    // Acts parsed from HTML store superscript units flattened ("art22^1" as "art221").
    if (!provision && refTrimmed.includes('^')) {
      const flat = refTrimmed.replace(/\^/g, '');
      provision = db.prepare(
        'SELECT * FROM legal_provisions WHERE document_id = ? AND (provision_ref = ? OR section = ?)'
      ).get(resolvedId, flat, flat) as Record<string, unknown> | undefined;
    }

    // Try LIKE match for flexible input
    if (!provision) {
      provision = db.prepare(
        "SELECT * FROM legal_provisions WHERE document_id = ? AND (provision_ref LIKE ? OR section LIKE ?)"
      ).get(resolvedId, `%${refTrimmed}%`, `%${refTrimmed}%`) as Record<string, unknown> | undefined;
    }

    if (provision) {
      const related = relatedAmendingActs(db, resolvedId);
      return {
        results: [{
          document_id: resolvedId,
          document_title: docRow.title,
          provision_ref: String(provision.provision_ref),
          chapter: provision.chapter as string | null,
          section: String(provision.section),
          title: provision.title as string | null,
          content: String(provision.content),
          section_number: String(provision.provision_ref).replace(/^s/, ''),
          url: docRow.url ?? undefined,
        }],
        _citation: buildProvisionCitation(
          resolvedId,
          docRow.title || '',
          String(provision.provision_ref) || '',
          input.document_id,
          input.section || input.provision_ref || '',
          docRow.url || null,
          null,
          provision.title ? String(provision.title) : null,
        ),
        ...(related.length > 0 ? { _related: related } : {}),
        _metadata: generateResponseMetadata(db),
      };
    }

    return {
      results: [],
      _metadata: {
        ...generateResponseMetadata(db),
        ...{ note: `Provision "${ref}" not found in document "${resolvedId}"` },
      },
    };
  }

  // Return all provisions for the document
  const provisions = db.prepare(
    'SELECT * FROM legal_provisions WHERE document_id = ? ORDER BY id'
  ).all(resolvedId) as Record<string, unknown>[];

  return {
    results: provisions.map(p => ({
      document_id: resolvedId,
      document_title: docRow.title,
      provision_ref: String(p.provision_ref),
      chapter: p.chapter as string | null,
      section: String(p.section),
      title: p.title as string | null,
      content: String(p.content),
      section_number: String(p.provision_ref).replace(/^s/, ''),
      url: docRow.url ?? undefined,
    })),
    _metadata: generateResponseMetadata(db),
  };
}
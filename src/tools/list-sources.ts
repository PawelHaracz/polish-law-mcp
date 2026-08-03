/**
 * list_sources — Return provenance metadata for all data sources.
 */

import type Database from '@ansvar/mcp-sqlite';
import { readDbMetadata } from '../capabilities.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';
import { describeCoverage, getCoverageStats, type CoverageStats } from '../utils/coverage.js';

export interface SourceInfo {
  name: string;
  authority: string;
  url: string;
  license: string;
  coverage: string;
  languages: string[];
}

export interface ListSourcesResult {
  sources: SourceInfo[];
  database: {
    tier: string;
    schema_version: string;
    built_at?: string;
    document_count: number;
    provision_count: number;
    coverage: CoverageStats;
  };
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

export async function listSources(
  db: InstanceType<typeof Database>,
): Promise<ToolResponse<ListSourcesResult>> {
  const meta = readDbMetadata(db);
  const coverage = getCoverageStats(db);

  return {
    results: {
      sources: [
        {
          name: 'Internetowy System Aktów Prawnych (ISAP)',
          authority: 'Sejm Rzeczypospolitej Polskiej (Sejm of the Republic of Poland)',
          url: 'https://isap.sejm.gov.pl',
          license:
            'Public domain under art. 4 of the Polish Copyright Act ' +
            '(ustawa o prawie autorskim i prawach pokrewnych) — normative acts ' +
            'and their official drafts are not subject to copyright',
          coverage: describeCoverage(db),
          languages: ['pl'],
        },
      ],
      database: {
        tier: meta.tier,
        schema_version: meta.schema_version,
        built_at: meta.built_at,
        document_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
        provision_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
        coverage,
      },
    },
    _metadata: generateResponseMetadata(db),
  };
}

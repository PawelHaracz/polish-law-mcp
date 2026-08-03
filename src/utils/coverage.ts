/**
 * Coverage statistics derived from the database at query time.
 *
 * Everything here is computed from the actual contents of the shipped
 * database — never hardcoded. When the database is rebuilt with newer acts,
 * the reported coverage moves with it automatically.
 */

import type Database from '@ansvar/mcp-sqlite';

export interface CoverageStats {
  /** Total documents in the database, regardless of status. */
  document_count: number;
  /** Documents by status: in_force, amended, repealed. */
  by_status: Record<string, number>;
  /** Documents by legal rank (1 = constitution/codes, 2 = statutes, 3 = regulations). */
  by_rank: Record<string, number>;
  /** Earliest issue date present in the database (ISO date). */
  earliest_issued?: string;
  /**
   * Latest issue date that is not in the future. Acts with a deferred entry
   * into force can carry a later date; those would overstate coverage.
   */
  latest_issued?: string;
  /** Latest in-force date present, including deferred commencements. */
  latest_in_force?: string;
  /** Human-readable coverage range, e.g. "1918-02-04 – 2026-01-23". */
  range: string;
}

function safeGet<T>(db: InstanceType<typeof Database>, sql: string): T | undefined {
  try {
    return db.prepare(sql).get() as T | undefined;
  } catch {
    return undefined;
  }
}

function safeAll<T>(db: InstanceType<typeof Database>, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

function groupCount(
  db: InstanceType<typeof Database>,
  column: string,
): Record<string, number> {
  const rows = safeAll<{ key: string | number | null; count: number }>(
    db,
    `SELECT ${column} as key, COUNT(*) as count FROM legal_documents GROUP BY ${column}`,
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.key === null) continue;
    out[String(row.key)] = Number(row.count);
  }
  return out;
}

export function getCoverageStats(db: InstanceType<typeof Database>): CoverageStats {
  const total = safeGet<{ count: number }>(
    db,
    'SELECT COUNT(*) as count FROM legal_documents',
  );

  // Exclude future-dated acts from the upper bound: an act issued today may
  // carry an issue or commencement date years ahead, which would misreport
  // how current the dataset actually is.
  const dates = safeGet<{
    earliest: string | null;
    latest: string | null;
  }>(
    db,
    `SELECT MIN(issued_date) as earliest, MAX(issued_date) as latest
     FROM legal_documents
     WHERE issued_date IS NOT NULL AND issued_date <= date('now')`,
  );

  const inForce = safeGet<{ latest: string | null }>(
    db,
    `SELECT MAX(in_force_date) as latest
     FROM legal_documents
     WHERE in_force_date IS NOT NULL`,
  );

  const earliest = dates?.earliest ?? undefined;
  const latest = dates?.latest ?? undefined;

  return {
    document_count: total ? Number(total.count) : 0,
    by_status: groupCount(db, 'status'),
    by_rank: groupCount(db, 'legal_rank'),
    earliest_issued: earliest,
    latest_issued: latest,
    latest_in_force: inForce?.latest ?? undefined,
    range: earliest && latest ? `${earliest} – ${latest}` : 'unknown',
  };
}

/**
 * One-line coverage summary suitable for a `coverage` string field.
 * Reads entirely from the database so it can never drift from the data.
 */
export function describeCoverage(db: InstanceType<typeof Database>): string {
  const stats = getCoverageStats(db);

  if (stats.document_count === 0) {
    return 'No documents present in this database build.';
  }

  // Regulations are rank 3; everything else (constitution, codes, statutes,
  // and any unranked rows) counts as statute-level so the two figures always
  // add up to document_count.
  const regulations = stats.by_rank['3'] ?? 0;
  const statutes = stats.document_count - regulations;
  const inForce = stats.by_status.in_force ?? 0;

  const parts = [
    `${stats.document_count.toLocaleString('en-US')} acts published in Dziennik Ustaw`,
    `covering ${stats.range}`,
    `${statutes.toLocaleString('en-US')} statutes and codes, ${regulations.toLocaleString('en-US')} regulations`,
    `${inForce.toLocaleString('en-US')} currently in force`,
  ];

  return parts.join('; ');
}

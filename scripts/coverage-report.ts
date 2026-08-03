/**
 * coverage-report — print real coverage figures from the shipped database.
 *
 * Use this instead of quoting numbers from memory: every figure in README.md
 * that describes dataset size or date range should be refreshed from here
 * after a rebuild or a new ingest run.
 *
 *   npm run coverage:report
 */

import Database from '@ansvar/mcp-sqlite';
import { existsSync } from 'node:fs';
import { getCoverageStats, describeCoverage } from '../src/utils/coverage.js';

const DB_PATH = process.env.DB_PATH ?? 'data/database.db';

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}. Run "npm run build:db" first.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const stats = getCoverageStats(db);
const provisions = (
  db.prepare('SELECT COUNT(*) as count FROM legal_provisions').get() as { count: number }
).count;

const built = (() => {
  try {
    const row = db
      .prepare("SELECT value FROM db_metadata WHERE key = 'built_at'")
      .get() as { value: string } | undefined;
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const n = (v: number) => v.toLocaleString('en-US');

console.log(`\nCoverage report for ${DB_PATH}`);
console.log(`Database built: ${built}\n`);
console.log(describeCoverage(db));
console.log(`\nProvisions: ${n(provisions)}`);
console.log(`Date range (issued): ${stats.range}`);
console.log(`Latest in-force date: ${stats.latest_in_force ?? 'n/a'}`);

console.log('\nBy status:');
for (const [key, value] of Object.entries(stats.by_status).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key.padEnd(12)} ${n(value)}`);
}

const RANK_LABELS: Record<string, string> = {
  '0': 'unranked',
  '1': 'constitution / codes',
  '2': 'statutes',
  '3': 'regulations',
};

console.log('\nBy legal rank:');
for (const [key, value] of Object.entries(stats.by_rank).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${(RANK_LABELS[key] ?? `rank ${key}`).padEnd(22)} ${n(value)}`);
}

console.log('\nREADME table values:');
console.log(`  Coverage     | ${n(stats.document_count)} acts published in Dziennik Ustaw (${stats.earliest_issued?.slice(0, 4)}-${stats.latest_issued?.slice(0, 4)})`);
console.log(`  Last ingested| ${built.slice(0, 10)}`);
console.log('');

db.close();

/**
 * Integration tests for get_related_acts against the real built database.
 * Locks in the citation-graph (cross_references) behaviour:
 *   - inbound amended_by edges resolve real amending acts
 *   - direction filtering works
 * Skipped automatically when data/database.db has not been built.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getRelatedActs } from '../src/tools/get-related-acts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'database.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

run('get_related_acts (integration)', () => {
  let db: InstanceType<typeof Database>;
  beforeAll(() => { db = new Database(DB_PATH, { readonly: true }); });
  afterAll(() => { db?.close(); });

  it('finds acts that amend the Labour Code (inbound amended_by)', async () => {
    const res = await getRelatedActs(db as never, {
      document_id: 'pl-du-1974-141',
      direction: 'inbound',
      ref_type: 'amended_by',
      limit: 5,
    });
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.direction).toBe('inbound');
      expect(r.ref_type).toBe('amended_by');
    }
  });

  it('returns a friendly note for an unknown document', async () => {
    const res = await getRelatedActs(db as never, { document_id: 'pl-du-9999-9999' });
    expect(res.results).toHaveLength(0);
    expect(res._metadata?.note).toMatch(/No document found/);
  });
});

run('get_provision _related enrichment (integration)', () => {
  let db2: import('better-sqlite3').Database;
  beforeAll(async () => {
    const Database = (await import('better-sqlite3')).default;
    db2 = new Database(DB_PATH, { readonly: true });
  });
  afterAll(() => { db2?.close(); });

  it('attaches amending acts as _related when fetching a provision of an amended act', async () => {
    const { getProvision } = await import('../src/tools/get-provision.js');
    const res = await getProvision(db2 as never, { document_id: 'pl-du-1974-141', provision_ref: 'art30' });
    expect(res.results.length).toBe(1);
    expect(res._related && res._related.length).toBeGreaterThan(0);
    for (const r of res._related ?? []) expect(r.ref_type).toBe('amended_by');
  });
});

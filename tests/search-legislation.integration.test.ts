/**
 * Integration tests for search_legislation against the real built database.
 *
 * These lock in the Polish-search quality fixes:
 *   - ł folding (opłata == oplata)
 *   - inflection recall via prefix variants
 *   - document-title matching (kodeks karny finds the statute)
 *
 * Skipped automatically when data/database.db has not been built
 * (CI builds it via `npm run build:db`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { searchLegislation } from '../src/tools/search-legislation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'database.db');
const hasDb = existsSync(DB_PATH);

// better-sqlite3 and @ansvar/mcp-sqlite share the same prepare/all/get surface
// that searchLegislation uses, so the real driver stands in for the type.
const run = hasDb ? describe : describe.skip;

run('search_legislation (integration)', () => {
  let db: InstanceType<typeof Database>;

  beforeAll(() => {
    db = new Database(DB_PATH, { readonly: true });
  });
  afterAll(() => {
    db?.close();
  });

  it('finds ł-words whether or not the user types the ł', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withL = await searchLegislation(db as any, { query: 'opłata', limit: 10 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withoutL = await searchLegislation(db as any, { query: 'oplata', limit: 10 });
    expect(withL.results.length).toBeGreaterThan(0);
    expect(withoutL.results.length).toBeGreaterThan(0);
    // Both spellings must reach the same provisions.
    expect(withoutL.results[0]?.provision_ref).toBe(withL.results[0]?.provision_ref);
  });

  it('returns inflection-tolerant results for a multi-word Polish query', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchLegislation(db as any, { query: 'umowa najmu', limit: 10 });
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('finds a statute by its title via doc_title indexing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchLegislation(db as any, { query: 'kodeks karny', limit: 10 });
    expect(res.results.length).toBeGreaterThan(0);
    // At least one top result should come from a "Kodeks karny" act.
    const fromKK = res.results.some(r => /kodeks karny/i.test(r.document_title));
    expect(fromKK).toBe(true);
  });

  it('snippet preserves correct Polish spelling (raw content, not folded)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchLegislation(db as any, { query: 'opłata', limit: 5 });
    // Folded FTS would show "oplata"; raw snippet must be able to carry "ł".
    const anyHasL = res.results.some(r => /ł/.test(r.snippet));
    expect(anyHasL).toBe(true);
  });
});

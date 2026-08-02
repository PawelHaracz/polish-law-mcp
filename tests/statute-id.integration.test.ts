/**
 * Integration tests for resolveDocumentId against the real built database.
 *
 * Locks in the Polish abbreviation map (RODO, k.c., KSH, ...) so common legal
 * shorthand resolves to the canonical in-force code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDocumentId, resetCaches } from '../src/utils/statute-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'database.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

run('resolveDocumentId — Polish abbreviations (integration)', () => {
  let db: InstanceType<typeof Database>;
  beforeAll(() => {
    db = new Database(DB_PATH, { readonly: true });
    resetCaches();
  });
  afterAll(() => {
    db?.close();
    resetCaches();
  });

  const cases: Array<[string, string]> = [
    ['k.c.', 'pl-du-1964-93'],
    ['KC', 'pl-du-1964-93'],
    ['k.k.', 'pl-du-1997-553'],
    ['KK', 'pl-du-1997-553'],
    ['k.p.', 'pl-du-1974-141'],
    ['KSH', 'pl-du-2000-1037'],
    ['k.p.c.', 'pl-du-1964-296'],
    ['k.p.k.', 'pl-du-1997-555'],
    ['RODO', 'pl-du-2018-1000'],
  ];

  for (const [abbr, expected] of cases) {
    it(`resolves "${abbr}" to ${expected}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(resolveDocumentId(db as any, abbr)).toBe(expected);
    });
  }

  it('still resolves a full title (no regression)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveDocumentId(db as any, 'pl-du-1964-93')).toBe('pl-du-1964-93');
  });
});

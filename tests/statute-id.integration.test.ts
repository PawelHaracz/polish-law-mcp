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

/**
 * Regression for the worst failure mode this server has: returning a REPEALED
 * code as if it were current law.
 *
 * "Kodeks karny" resolved to pl-du-1969-94 (repealed in 1998) instead of
 * pl-du-1997-553, because the fuzzy matching steps sorted by title length
 * only — and the older title happens to be shorter.
 *
 * check_currency would NOT catch this: it verifies whatever act it is given,
 * so it would report the wrong document while the agent had already quoted
 * its text as binding law.
 */
const runFullNames = existsSync(DB_PATH) ? describe : describe.skip;

runFullNames('resolveDocumentId — full names prefer acts in force', () => {
  let db: InstanceType<typeof Database>;
  beforeAll(() => {
    db = new Database(DB_PATH, { readonly: true });
    resetCaches();
  });
  afterAll(() => {
    db?.close();
    resetCaches();
  });

  function statusOf(id: string | null): string | null {
    if (!id) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (db as any)
      .prepare('SELECT status FROM legal_documents WHERE id = ?')
      .get(id) as { status: string | null } | undefined;
    return row?.status ?? null;
  }

  // Asserting on status, not on a hardcoded id, keeps this meaningful after
  // a database rebuild.
  for (const name of [
    'Kodeks cywilny',
    'Kodeks karny',
    'Kodeks pracy',
    'Kodeks postępowania karnego',
  ]) {
    it(`"${name}" resolves to an act in force`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = resolveDocumentId(db as any, name);
      expect(id).not.toBeNull();
      expect(statusOf(id)).toBe('in_force');
    });
  }

  it('Kodeks karny resolves to the 1997 code, not the repealed 1969 one', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveDocumentId(db as any, 'Kodeks karny')).toBe('pl-du-1997-553');
  });

  it('full name and abbreviation agree', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName = resolveDocumentId(db as any, 'Kodeks karny');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveDocumentId(db as any, 'KK')).toBe(byName);
  });

  it('an explicit id still wins, even for a repealed act', () => {
    // Preferring in-force acts must not hide repealed ones from callers who
    // ask for them by id — historical research is a legitimate use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveDocumentId(db as any, 'pl-du-1969-94')).toBe('pl-du-1969-94');
    expect(statusOf('pl-du-1969-94')).toBe('repealed');
  });
});

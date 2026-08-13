/**
 * Integration test dla build_legal_stance na prawdziwej bazie.
 *
 * Pilnuje, że po przejściu provisions_fts na contentless FTS narzędzie nadal
 * zwraca treść przepisu. Contentless FTS nie przechowuje tekstu, więc
 * snippet(provisions_fts, ...) zwracałby pusty string — tekst musi pochodzić
 * z legal_provisions.content.
 *
 * Pomijany, gdy data/database.db nie zostało zbudowane.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildLegalStance } from '../src/tools/build-legal-stance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'database.db');
const hasDb = existsSync(DB_PATH);

const run = hasDb ? describe : describe.skip;

run('build_legal_stance (integration)', () => {
  it('zwraca niepusty snippet z treścią przepisu', async () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const res = await buildLegalStance(db as never, { query: 'kradzież', limit: 3 });

      expect(res.results.length).toBeGreaterThan(0);
      for (const item of res.results) {
        expect(item.snippet).toBeTruthy();
        expect(item.snippet.length).toBeGreaterThan(20);
      }
    } finally {
      db.close();
    }
  });

  it('snippet zachowuje polską pisownię, nie wersję ł-foldowaną', async () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const res = await buildLegalStance(db as never, { query: 'opłata', limit: 5 });

      // substr bierze tekst z legal_provisions, gdzie ł jest nietknięte.
      // snippet() zwracał tekst z indeksu, czyli po ł-foldingu.
      const joined = res.results.map((r) => r.snippet).join(' ');
      expect(joined.length).toBeGreaterThan(0);
      expect(joined).toMatch(/[ąćęłńóśźż]/);
    } finally {
      db.close();
    }
  });
});

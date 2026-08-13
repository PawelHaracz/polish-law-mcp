/**
 * Przerabia provisions_fts ze standalone FTS5 na contentless (content='').
 *
 * Standalone FTS5 przechowuje własną kopię indeksowanego tekstu — przy
 * produkcyjnej bazie to 934 MB obok 811 MB w legal_provisions. Kopia jest
 * martwa: search_legislation bierze snippet z substr(lp.content, ...), a FTS
 * służy wyłącznie jako indeks (MATCH + bm25 + rowid).
 *
 * Contentless, nie external-content (content='legal_provisions'), bo indeks
 * obejmuje doc_title, którego w legal_provisions nie ma — pochodzi z joina z
 * legal_documents. External content wymaga, by wszystkie kolumny dały się
 * odtworzyć z jednej tabeli.
 *
 * ł-folding zachowany bez zmian: unicode61 nie składa ł/Ł, więc składamy je
 * sami przy wejściu do indeksu, tak jak robi to build-db.ts.
 *
 * Użycie: npm run migrate:fts
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.db');

export function migrateFtsToContentless(db: InstanceType<typeof Database>): void {
  db.exec(`
    DROP TRIGGER IF EXISTS provisions_ai;
    DROP TRIGGER IF EXISTS provisions_ad;
    DROP TRIGGER IF EXISTS provisions_au;
    DROP TABLE IF EXISTS provisions_fts;

    CREATE VIRTUAL TABLE provisions_fts USING fts5(
      content, doc_title,
      content='',
      tokenize='unicode61'
    );

    INSERT INTO provisions_fts(rowid, content, doc_title)
    SELECT
      lp.id,
      replace(replace(lp.content, 'ł', 'l'), 'Ł', 'L'),
      replace(replace(ld.title, 'ł', 'l'), 'Ł', 'L')
    FROM legal_provisions lp
    JOIN legal_documents ld ON ld.id = lp.document_id;

    CREATE TRIGGER provisions_ai AFTER INSERT ON legal_provisions BEGIN
      INSERT INTO provisions_fts(rowid, content, doc_title)
      VALUES (
        new.id,
        replace(replace(new.content, 'ł', 'l'), 'Ł', 'L'),
        replace(replace(
          (SELECT title FROM legal_documents WHERE id = new.document_id),
          'ł', 'l'), 'Ł', 'L')
      );
    END;

    CREATE TRIGGER provisions_ad AFTER DELETE ON legal_provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, content, doc_title)
      VALUES ('delete', old.id,
        replace(replace(old.content, 'ł', 'l'), 'Ł', 'L'),
        replace(replace(
          (SELECT title FROM legal_documents WHERE id = old.document_id),
          'ł', 'l'), 'Ł', 'L'));
    END;

    CREATE TRIGGER provisions_au AFTER UPDATE ON legal_provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, content, doc_title)
      VALUES ('delete', old.id,
        replace(replace(old.content, 'ł', 'l'), 'Ł', 'L'),
        replace(replace(
          (SELECT title FROM legal_documents WHERE id = old.document_id),
          'ł', 'l'), 'Ł', 'L'));
      INSERT INTO provisions_fts(rowid, content, doc_title)
      VALUES (new.id,
        replace(replace(new.content, 'ł', 'l'), 'Ł', 'L'),
        replace(replace(
          (SELECT title FROM legal_documents WHERE id = new.document_id),
          'ł', 'l'), 'Ł', 'L'));
    END;
  `);
}

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Nie znaleziono bazy: ${DB_PATH}`);
    process.exit(1);
  }

  const before = fs.statSync(DB_PATH).size;
  console.log(`Baza przed migracją: ${(before / 1024 / 1024).toFixed(1)} MB`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = OFF');

  console.log('Przebudowa provisions_fts na contentless...');
  migrateFtsToContentless(db);

  console.log('VACUUM...');
  db.exec('VACUUM');

  // ensure-readable-db kopiuje bazę do /tmp, a WASM SQLite wymaga trybu DELETE.
  db.pragma('journal_mode = DELETE');
  db.close();

  const after = fs.statSync(DB_PATH).size;
  console.log(
    `Baza po migracji: ${(after / 1024 / 1024).toFixed(1)} MB ` +
    `(-${((before - after) / 1024 / 1024).toFixed(1)} MB)`,
  );
}

// Uruchom main() tylko przy wywołaniu jako skrypt, nie przy imporcie w teście.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}

/**
 * Migracja provisions_fts na contentless FTS5.
 *
 * Standalone FTS5 trzyma własną kopię tekstu przepisów — 934 MB przy
 * produkcyjnej bazie. search_legislation czyta tekst z legal_provisions
 * (substr), a nie z FTS, więc kopia jest martwa. Test pilnuje, że po
 * migracji MATCH i bm25 działają identycznie, a kopii nie ma.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateFtsToContentless } from '../scripts/migrate-fts.js';

function buildFixture(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE legal_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE legal_provisions (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES legal_documents(id),
      provision_ref TEXT NOT NULL,
      chapter TEXT,
      section TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      UNIQUE(document_id, provision_ref)
    );
    CREATE VIRTUAL TABLE provisions_fts USING fts5(
      content, doc_title,
      tokenize='unicode61'
    );
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
  `);

  db.prepare('INSERT INTO legal_documents (id, title) VALUES (?, ?)')
    .run('pl-du-1997-553', 'Kodeks karny');
  db.prepare('INSERT INTO legal_documents (id, title) VALUES (?, ?)')
    .run('pl-du-1964-16', 'Kodeks cywilny');

  const ins = db.prepare(
    'INSERT INTO legal_provisions (id, document_id, provision_ref, section, content) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run(1, 'pl-du-1997-553', 'art278', '278',
    'Kto zabiera w celu przywłaszczenia cudzą rzecz ruchomą, podlega karze pozbawienia wolności. Kradzież.');
  ins.run(2, 'pl-du-1997-553', 'art279', '279',
    'Kto kradnie z włamaniem, podlega karze pozbawienia wolności.');
  ins.run(3, 'pl-du-1964-16', 'art415', '415',
    'Kto z winy swej wyrządził drugiemu szkodę, obowiązany jest do jej naprawienia. Opłata za szkodę.');

  return db;
}

describe('migrateFtsToContentless', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = buildFixture();
  });

  it('usuwa tabelę z duplikatem tekstu', () => {
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'provisions_fts_content'")
      .get();
    expect(before).toBeDefined();

    migrateFtsToContentless(db);

    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'provisions_fts_content'")
      .get();
    expect(after).toBeUndefined();
  });

  it('zachowuje wyniki wyszukiwania i ich kolejność', () => {
    const query = (d: InstanceType<typeof Database>) =>
      d.prepare(`
        SELECT lp.document_id || ':' || lp.provision_ref AS ref
        FROM provisions_fts
        JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
        WHERE provisions_fts MATCH ?
        ORDER BY bm25(provisions_fts, 1.0, 8.0)
      `).all('kradziez') as { ref: string }[];

    const before = query(db).map((r) => r.ref);
    migrateFtsToContentless(db);
    const after = query(db).map((r) => r.ref);

    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });

  it('zachowuje ł-folding — zapytanie bez ł znajduje przepis z ł', () => {
    migrateFtsToContentless(db);

    const rows = db.prepare(`
      SELECT lp.provision_ref AS ref
      FROM provisions_fts
      JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
      WHERE provisions_fts MATCH ?
    `).all('oplata') as { ref: string }[];

    expect(rows.map((r) => r.ref)).toContain('art415');
  });

  it('zachowuje dopasowanie po tytule dokumentu', () => {
    migrateFtsToContentless(db);

    const rows = db.prepare(`
      SELECT lp.provision_ref AS ref
      FROM provisions_fts
      JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
      WHERE provisions_fts MATCH ?
    `).all('cywilny') as { ref: string }[];

    expect(rows.map((r) => r.ref)).toContain('art415');
  });

  it('odtwarza triggery, więc nowe przepisy trafiają do indeksu', () => {
    migrateFtsToContentless(db);

    db.prepare(
      'INSERT INTO legal_provisions (id, document_id, provision_ref, section, content) VALUES (?, ?, ?, ?, ?)',
    ).run(4, 'pl-du-1997-553', 'art280', '280', 'Kto stosuje rozbój, podlega karze.');

    const rows = db.prepare(`
      SELECT lp.provision_ref AS ref
      FROM provisions_fts
      JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
      WHERE provisions_fts MATCH ?
    `).all('rozboj') as { ref: string }[];

    expect(rows.map((r) => r.ref)).toContain('art280');
  });
});

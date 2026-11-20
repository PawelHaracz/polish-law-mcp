#!/usr/bin/env tsx
/**
 * Polish Law MCP — PDF ingestion for acts the ELI API serves ONLY as PDF.
 *
 * ~220 in-force acts (incl. the 1997 Constitution and ratified international
 * agreements) have textHTML:false / textPDF:true, so the HTML ingest skips them
 * and they are absent from the database. This script fetches each act's PDF,
 * extracts text via pdftotext, parses it into the same seed shape, and writes
 * data/seed/<id>.json so the normal build-db picks them up.
 *
 * Usage:
 *   npm run ingest:pdf                 # all in-force PDF-only acts (resume-aware)
 *   npm run ingest:pdf -- --limit 20   # first N
 *   npm run ingest:pdf -- --force      # re-ingest even if seed exists
 *   npm run ingest:pdf -- --id a,b     # only these acts (repealed ones skipped)
 *   npm run ingest:pdf -- --id-file f  # ids from a file
 *   npm run ingest:pdf -- --include-repealed   # keep repealed acts in an --id run
 *   npm run ingest:pdf -- --regulations --from 2025   # in-force PDF-only rozporządzenia
 *   npm run ingest:pdf -- --regulations --from 1990 --id-file f   # these regulations from PDF
 *                                                     # (since 2025 the API serves new acts as PDF only)
 *
 * Requires poppler's `pdftotext` on PATH (build-time only).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parsePolishPdf, pdfToText } from './lib/pdf-parser.js';
import type { ActIndexEntry } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_DIR = path.resolve(__dirname, '../data/seed');
const PDF_DIR = path.resolve(__dirname, '../data/source-pdf');
const CENSUS_PATH = path.resolve(__dirname, '../data/census.json');
const ELI_API_BASE = 'https://api.sejm.gov.pl/eli/acts/DU';
const PDF_ONLY_REASON = 'No HTML text available from API';

interface CensusEntry {
  id: string; title: string; status: string; sejm_status: string;
  classification: string; skip_reason?: string; year: number; poz: number;
  url: string; announcement_date: string; promulgation_date: string;
}
interface Census { laws: CensusEntry[]; }

interface TextEntry { fileName: string; type: string }

function parseArgs() {
  const a = process.argv.slice(2);
  let limit: number | null = null, force = false, includeRepealed = false;
  let regulations = false, from = 2025;
  let ids: Set<string> | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--limit' && a[i + 1]) { limit = parseInt(a[++i], 10); }
    else if (a[i] === '--force') force = true;
    else if (a[i] === '--include-repealed') includeRepealed = true;
    else if (a[i] === '--regulations') regulations = true;
    else if (a[i] === '--from' && a[i + 1]) from = parseInt(a[++i]!, 10);
    else if (a[i] === '--id' && a[i + 1]) {
      ids = new Set(a[++i]!.split(',').map(s => s.trim()).filter(Boolean));
    } else if (a[i] === '--id-file' && a[i + 1]) {
      ids = new Set(fs.readFileSync(a[++i]!, 'utf-8').split(/[\s,]+/).map(s => s.trim()).filter(Boolean));
    }
  }
  return { limit, force, ids, includeRepealed, regulations, from };
}

/** True when the act is currently binding law, per census/ISAP status. */
function isInForce(e: CensusEntry): boolean {
  return e.sejm_status === 'obowiązujący' || e.status === 'in_force';
}

/**
 * Newest consolidated text (tekst jednolity) of an act, if any.
 *
 * Mirrors resolveConsolidatedText in ingest.ts: the base act carries its original
 * wording, so for amended acts the consolidated text is the only current source.
 * Returns null when the act has never been consolidated.
 */
async function resolveConsolidated(
  year: number,
  poz: number,
): Promise<{ year: number; poz: number; displayAddress: string } | null> {
  let refs: any;
  try {
    refs = await fetchJson(`${ELI_API_BASE}/${year}/${poz}/references`);
  } catch {
    return null;
  }
  const entries = refs?.['Inf. o tekście jednolitym'];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const acts = entries.map((e: any) => e?.act).filter((x: any) => x && typeof x === 'object');
  if (acts.length === 0) return null;
  acts.sort((a: any, b: any) =>
    (a.year ?? 0) !== (b.year ?? 0) ? (a.year ?? 0) - (b.year ?? 0) : (a.pos ?? 0) - (b.pos ?? 0));
  const newest = acts[acts.length - 1];
  if (!newest.year || !newest.pos) return null;
  return {
    year: newest.year,
    poz: newest.pos,
    displayAddress: newest.displayAddress ?? `Dz.U. ${newest.year} poz. ${newest.pos}`,
  };
}

/** Pick the best PDF: consolidated (U) > consolidated text (T) > original (O). */
function pickPdf(texts: TextEntry[]): TextEntry | null {
  return (
    texts.find(t => t.type === 'U') ??
    texts.find(t => t.type === 'T') ??
    texts.find(t => t.type === 'O') ??
    texts[0] ?? null
  );
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'polish-law-mcp pdf-ingest' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchPdf(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'polish-law-mcp pdf-ingest' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function censusToAct(e: CensusEntry): ActIndexEntry {
  return {
    id: e.id, title: e.title, titleEn: '', shortName: e.id,
    status: (e.status as ActIndexEntry['status']) || 'in_force',
    issuedDate: e.announcement_date || '', inForceDate: e.promulgation_date || '',
    dziennikRef: '', year: e.year, poz: e.poz, url: e.url,
  };
}

/** Same "currently binding" statuses ingest-regulations keeps. */
const ACTIVE_REG_STATUSES = new Set([
  'obowiązujący',
  'akt objęty tekstem jednolitym',
  'akt posiada tekst jednolity',
]);

/**
 * Regulations are not in census.json (it lists Ustawy only). Build census-shaped
 * entries for in-force, PDF-only rozporządzenia from the ELI year index.
 */
async function regulationEntries(from: number, ids: Set<string> | null): Promise<CensusEntry[]> {
  const out: CensusEntry[] = [];
  for (let y = from; y <= new Date().getFullYear(); y++) {
    const d = await fetchJson(`${ELI_API_BASE}/${y}`);
    for (const it of d.items ?? []) {
      // With --id-file, HTML acts are allowed too: the target is typically a
      // regulation whose base act has HTML but whose newest tekst jednolity is
      // PDF-only (the norm since 2025).
      if (it.type !== 'Rozporządzenie' || !it.textPDF) continue;
      if (it.textHTML && !ids) continue;
      if (!ACTIVE_REG_STATUSES.has(it.status)) continue;
      const id = `pl-du-${it.year}-${it.pos}`;
      out.push({
        id, title: it.title, status: 'in_force', sejm_status: it.status,
        classification: 'ingestable', skip_reason: PDF_ONLY_REASON, year: it.year, poz: it.pos,
        url: `${ELI_API_BASE}/${it.year}/${it.pos}`,
        announcement_date: it.announcementDate ?? '', promulgation_date: it.promulgation ?? '',
      });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { limit, force, ids, includeRepealed, regulations, from } = parseArgs();
  console.log('Polish Law MCP — PDF ingestion\n' + '='.repeat(40));

  const census: Census = regulations
    ? { laws: await regulationEntries(from, ids) }
    : JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf-8'));
  if (regulations) console.log(`  Mode: regulations ${from}-${new Date().getFullYear()} (${census.laws.length} in-force candidates)`);

  // Default target: acts the API serves only as PDF. With --id the caller picks
  // acts explicitly — typically ones whose CONSOLIDATED text is PDF-only even
  // though the base act has HTML (every major code is in this group).
  let todo = ids
    ? census.laws.filter(e => ids.has(e.id))
    : census.laws.filter(e => e.skip_reason === PDF_ONLY_REASON && isInForce(e));

  if (ids) {
    const missing = [...ids].filter(id => !todo.some(e => e.id === id));
    if (missing.length > 0) {
      console.log(`  WARNING: ${missing.length} id(s) not in census: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}`);
    }

    // --id bypasses the in-force filter the default path applies, so a repealed
    // act can slip into a run and then "fail" on unreadable pre-war OCR — noise
    // that reads like a real gap. Drop them by default; --include-repealed keeps
    // them for deliberate historical re-ingest.
    const repealed = todo.filter(e => !isInForce(e));
    if (repealed.length > 0) {
      if (includeRepealed) {
        console.log(`  NOTE: ${repealed.length} repealed act(s) included via --include-repealed`);
      } else {
        console.log(`  Skipping ${repealed.length} repealed act(s) (use --include-repealed to ingest them):`);
        for (const e of repealed.slice(0, 5)) {
          console.log(`    ${e.id} — ${e.sejm_status || e.status} — ${e.title.slice(0, 55)}`);
        }
        if (repealed.length > 5) console.log(`    ... and ${repealed.length - 5} more`);
        todo = todo.filter(isInForce);
      }
    }
  }

  // An explicit id selection always re-ingests; otherwise resume.
  if (!force && !ids) todo = todo.filter(e => !fs.existsSync(path.join(SEED_DIR, `${e.id}.json`)));
  if (limit) todo = todo.slice(0, limit);

  console.log(`  In-force PDF-only acts to ingest: ${todo.length}\n`);
  if (todo.length === 0) { console.log('Nothing to do.'); return; }

  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  let ok = 0, failed = 0, totalProv = 0;
  for (let i = 0; i < todo.length; i++) {
    const e = todo[i];
    if (i > 0) await sleep(500); // be gentle with api.sejm.gov.pl (3 requests per act)
    try {
      // Pull the PDF of the newest consolidated text when one exists; the base
      // act's own PDF still carries the original, pre-amendment wording.
      const consolidated = await resolveConsolidated(e.year, e.poz);
      const srcYear = consolidated?.year ?? e.year;
      const srcPoz = consolidated?.poz ?? e.poz;
      if (consolidated) {
        console.log(`  [${i + 1}] ${e.id}: using consolidated ${consolidated.displayAddress}`);
      }

      const meta = await fetchJson(`${ELI_API_BASE}/${srcYear}/${srcPoz}`);
      const pdf = pickPdf(meta.texts ?? []);
      if (!pdf) { console.log(`  [${i + 1}] no PDF entry for ${e.id}`); failed++; continue; }

      const pdfPath = path.join(PDF_DIR, `${e.id}.pdf`);
      await fetchPdf(`${ELI_API_BASE}/${srcYear}/${srcPoz}/text/${pdf.type}/${pdf.fileName}`, pdfPath);

      const text = pdfToText(pdfPath);
      const parsed = parsePolishPdf(text, censusToAct(e));
      if (parsed.provisions.length === 0) { console.log(`  [${i + 1}] 0 provisions ${e.id}`); failed++; continue; }

      fs.writeFileSync(path.join(SEED_DIR, `${e.id}.json`), JSON.stringify(parsed, null, 2));
      totalProv += parsed.provisions.length;
      ok++;
      if ((i + 1) % 10 === 0 || i < 5) {
        console.log(`  [${i + 1}/${todo.length}] ${e.id}: ${parsed.provisions.length} provisions`);
      }
    } catch (err) {
      failed++;
      console.log(`  [${i + 1}] ERROR ${e.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`);
    }
  }

  console.log(`\n${'='.repeat(40)}\nDone: ${ok} ok, ${failed} failed, ${totalProv} provisions`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

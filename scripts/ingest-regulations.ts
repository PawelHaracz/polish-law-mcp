#!/usr/bin/env tsx
/**
 * Polish Law MCP — in-force regulation (Rozporządzenie) ingestion.
 *
 * The base census covers only Ustawy. Regulations are the executive layer
 * (rank 3) and the largest act type by volume, but most are short-lived: only
 * ~15k of ~45k (1990-2025) are still in force. We ingest ONLY active ones —
 * repealed executive regulations are dead law that would bloat the DB and noise
 * up search (reranking would sink them anyway).
 *
 * Lists regulations per year from the ELI year index, keeps in-force statuses,
 * fetches each act's text.html, parses with the §-aware HTML parser (regulations
 * use § as the primary unit), and writes data/seed/<id>.json.
 *
 * Usage:
 *   npm run ingest:regulations                 # all in-force, 1990-current
 *   npm run ingest:regulations -- --from 2021  # only from a given year
 *   npm run ingest:regulations -- --limit 100  # cap (testing)
 *   npm run ingest:regulations -- --force      # re-ingest existing seeds
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import { parsePolishHtml, type ActIndexEntry } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_DIR = path.resolve(__dirname, '../data/seed');
const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const ELI_API_BASE = 'https://api.sejm.gov.pl/eli/acts/DU';
const CURRENT_YEAR = 2026;
const DEFAULT_FROM = 1990;

/** Statuses we treat as currently binding / worth keeping. */
const ACTIVE_STATUSES = new Set([
  'obowiązujący',
  'akt objęty tekstem jednolitym',
  'akt posiada tekst jednolity',
]);

interface YearItem {
  ELI: string; address: string; type: string; status: string;
  title: string; textHTML: boolean; year: number; pos: number;
  promulgation?: string; announcementDate?: string;
}

function parseArgs() {
  const a = process.argv.slice(2);
  let from = DEFAULT_FROM, limit: number | null = null, force = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--from' && a[i + 1]) from = parseInt(a[++i], 10);
    else if (a[i] === '--limit' && a[i + 1]) limit = parseInt(a[++i], 10);
    else if (a[i] === '--force') force = true;
  }
  return { from, limit, force };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'polish-law-mcp regulation-ingest' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function toAct(item: YearItem): ActIndexEntry {
  // Use the ELI field ("DU/2015/123"); `address` is the ISAP form (WDU...).
  const [, year, pos] = (item.ELI ?? '').match(/DU\/(\d+)\/(\d+)/) ?? [];
  return {
    id: `pl-du-${year}-${pos}`,
    title: item.title,
    titleEn: '',
    shortName: `pl-du-${year}-${pos}`,
    status: 'in_force',
    issuedDate: item.announcementDate ?? '',
    inForceDate: item.promulgation ?? '',
    dziennikRef: item.address,
    year: Number(year),
    poz: Number(pos),
    url: `${ELI_API_BASE}/${year}/${pos}`,
  };
}

async function main() {
  const { from, limit, force } = parseArgs();
  console.log('Polish Law MCP — in-force regulation ingestion\n' + '='.repeat(48));
  console.log(`  Years: ${from}-${CURRENT_YEAR} | active statuses only`);

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  // 1) Collect the work-list across years.
  const work: ActIndexEntry[] = [];
  for (let y = from; y <= CURRENT_YEAR; y++) {
    try {
      const d = await fetchJson(`${ELI_API_BASE}/${y}`);
      for (const it of (d.items ?? []) as YearItem[]) {
        if (it.type !== 'Rozporządzenie') continue;
        if (!ACTIVE_STATUSES.has(it.status)) continue;
        if (!it.textHTML) continue; // PDF-only regulations: out of scope here
        work.push(toAct(it));
      }
    } catch (e) {
      console.log(`  year ${y}: list error ${(e as Error).message.slice(0, 60)}`);
    }
  }
  let todo = force ? work : work.filter(a => !fs.existsSync(path.join(SEED_DIR, `${a.id}.json`)));
  if (limit) todo = todo.slice(0, limit);
  console.log(`  In-force regulations to ingest: ${todo.length} (of ${work.length} active)\n`);
  if (todo.length === 0) { console.log('Nothing to do.'); return; }

  // 2) Fetch + parse + write seed.
  let ok = 0, failed = 0, empty = 0, totalProv = 0;
  for (let i = 0; i < todo.length; i++) {
    const act = todo[i];
    try {
      const res = await fetchWithRateLimit(`${ELI_API_BASE}/${act.year}/${act.poz}/text.html`, 3, 60_000);
      if (res.status !== 200 || res.body.includes('window["bobcmn"]')) { failed++; continue; }
      const parsed = parsePolishHtml(res.body, act);
      if (parsed.provisions.length === 0) { empty++; continue; }
      fs.writeFileSync(path.join(SEED_DIR, `${act.id}.json`), JSON.stringify(parsed, null, 2));
      totalProv += parsed.provisions.length;
      ok++;
    } catch {
      failed++;
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${todo.length} (${ok} ok, ${failed} fail, ${empty} empty, ${totalProv} provisions)`);
    }
  }

  console.log(`\n${'='.repeat(48)}\nDone: ${ok} ok, ${failed} failed, ${empty} empty, ${totalProv} provisions`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

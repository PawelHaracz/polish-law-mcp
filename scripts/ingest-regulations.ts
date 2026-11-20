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
 *   npm run ingest:regulations -- --id-file f  # re-ingest only these ids (implies --force)
 *   npm run ingest:regulations -- --prune      # delete seeds of regulations no longer in force
 *
 * Text source: the newest consolidated text (tekst jednolity) when one exists
 * with HTML, otherwise the base act — same rule as `npm run ingest`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import { parsePolishHtml, type ActIndexEntry } from './lib/parser.js';
import { resolveConsolidatedText } from './lib/consolidated.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_DIR = path.resolve(__dirname, '../data/seed');
const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const ELI_API_BASE = 'https://api.sejm.gov.pl/eli/acts/DU';
const CURRENT_YEAR = new Date().getFullYear();
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
  let from = DEFAULT_FROM, limit: number | null = null, force = false, prune = false;
  let ids: Set<string> | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--from' && a[i + 1]) from = parseInt(a[++i], 10);
    else if (a[i] === '--limit' && a[i + 1]) limit = parseInt(a[++i], 10);
    else if (a[i] === '--force') force = true;
    else if (a[i] === '--prune') prune = true;
    else if (a[i] === '--id-file' && a[i + 1]) {
      ids = new Set(fs.readFileSync(a[++i], 'utf-8').split(/[\s,]+/).map(x => x.trim()).filter(Boolean));
    }
  }
  return { from, limit, force, prune, ids };
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
  const { from, limit, force, prune, ids } = parseArgs();
  console.log('Polish Law MCP — in-force regulation ingestion\n' + '='.repeat(48));
  console.log(`  Years: ${from}-${CURRENT_YEAR} | active statuses only`);

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  // 1) Collect the work-list across years.
  const work: ActIndexEntry[] = [];
  const inactive: string[] = [];
  for (let y = from; y <= CURRENT_YEAR; y++) {
    try {
      const d = await fetchJson(`${ELI_API_BASE}/${y}`);
      for (const it of (d.items ?? []) as YearItem[]) {
        if (it.type !== 'Rozporządzenie') continue;
        if (!ACTIVE_STATUSES.has(it.status)) {
          inactive.push(toAct(it).id);
          continue;
        }
        if (!it.textHTML) continue; // PDF-only regulations: out of scope here
        work.push(toAct(it));
      }
    } catch (e) {
      console.log(`  year ${y}: list error ${(e as Error).message.slice(0, 60)}`);
    }
  }
  // Regulations repealed since they were ingested: this ingester keeps only
  // binding law, so their seeds go (build-db would otherwise list them in force).
  if (prune) {
    let removed = 0;
    for (const id of inactive) {
      const f = path.join(SEED_DIR, `${id}.json`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
    }
    console.log(`  Pruned ${removed} seed(s) of regulations no longer in force`);
  }

  let todo = ids
    ? work.filter(a => ids.has(a.id))
    : force ? work : work.filter(a => !fs.existsSync(path.join(SEED_DIR, `${a.id}.json`)));
  if (limit) todo = todo.slice(0, limit);
  console.log(`  In-force regulations to ingest: ${todo.length} (of ${work.length} active)\n`);
  if (todo.length === 0) { console.log('Nothing to do.'); return; }

  // 2) Fetch + parse + write seed.
  let ok = 0, failed = 0, empty = 0, totalProv = 0, consolidatedUsed = 0;
  for (let i = 0; i < todo.length; i++) {
    const act = todo[i];
    try {
      const consolidated = await resolveConsolidatedText(act.year, act.poz);
      const candidates = consolidated
        ? [{ year: consolidated.year, poz: consolidated.poz }, { year: act.year, poz: act.poz }]
        : [{ year: act.year, poz: act.poz }];
      let body: string | null = null;
      for (const c of candidates) {
        const res = await fetchWithRateLimit(`${ELI_API_BASE}/${c.year}/${c.poz}/text.html`, 3, 60_000);
        // PDF-only consolidations answer 200 with an empty body — fall back.
        if (res.status === 200 && res.body.trim().length > 0 && !res.body.includes('window["bobcmn"]')) {
          body = res.body;
          if (c !== candidates[candidates.length - 1]) consolidatedUsed++;
          break;
        }
      }
      if (!body) { failed++; continue; }
      const parsed = parsePolishHtml(body, act);
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

  console.log(`\n${'='.repeat(48)}\nDone: ${ok} ok (${consolidatedUsed} from consolidated text), ${failed} failed, ${empty} empty, ${totalProv} provisions`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

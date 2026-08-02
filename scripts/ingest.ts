#!/usr/bin/env tsx
/**
 * Polish Law MCP -- Census-Driven Ingestion Pipeline
 *
 * Fetches Polish legislation from the Sejm ELI API (api.sejm.gov.pl).
 * Reads census.json for the full list of ingestable Acts (Ustawy).
 * Supports resume: skips acts that already have seed files.
 *
 * Strategy:
 * 1. Read census.json to get all ingestable acts
 * 2. For each act, fetch the HTML text from the ELI API endpoint
 * 3. Parse articles (Art.) from the structured HTML
 * 4. Write seed JSON files for the database builder
 * 5. Update census.json with ingestion results
 *
 * Usage:
 *   npm run ingest                    # Full ingestion (resume-aware)
 *   npm run ingest -- --limit 50      # Ingest next 50 un-ingested acts
 *   npm run ingest -- --skip-fetch    # Reuse cached HTML source files
 *   npm run ingest -- --force         # Re-ingest even if seed exists
 *
 * Data source: api.sejm.gov.pl (Chancellery of the Sejm of the Republic of Poland)
 * License: Polish legislation is public domain under Art. 4 of the Copyright Act
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import { parsePolishHtml, type ActIndexEntry } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');
const CENSUS_PATH = path.resolve(__dirname, '../data/census.json');

/** ELI API base URL for the Sejm */
const ELI_API_BASE = 'https://api.sejm.gov.pl/eli/acts/DU';

/** Log progress every N acts */
const LOG_INTERVAL = 10;

/**
 * Newest consolidated text (tekst jednolity) of an act, if one exists.
 *
 * The base act (e.g. DU/1964/93 for the Civil Code) carries its ORIGINAL 1964
 * wording — amendments are published as separate acts and only folded together
 * in a consolidated text. Ingesting the base act therefore yields text that can
 * be decades out of date. Roughly 2% of in-force acts have a consolidated text;
 * for the rest the base act is the correct source and this returns null.
 */
interface ConsolidatedText {
  year: number;
  poz: number;
  displayAddress: string;
}

async function resolveConsolidatedText(
  year: number,
  poz: number,
): Promise<ConsolidatedText | null> {
  let refsResult;
  try {
    refsResult = await fetchWithRateLimit(`${ELI_API_BASE}/${year}/${poz}/references`, 2, 30_000);
  } catch {
    return null;
  }
  if (refsResult.status !== 200) return null;

  let refs: Record<string, Array<{ act?: Record<string, unknown> }>>;
  try {
    refs = JSON.parse(refsResult.body);
  } catch {
    return null;
  }

  const entries = refs['Inf. o tekście jednolitym'];
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const acts = entries
    .map((e) => e.act)
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object');
  if (acts.length === 0) return null;

  // Highest (year, poz) wins — consolidated texts are published in order.
  acts.sort((a, b) => {
    const ay = Number(a['year'] ?? 0);
    const by = Number(b['year'] ?? 0);
    return ay !== by ? ay - by : Number(a['pos'] ?? 0) - Number(b['pos'] ?? 0);
  });
  const newest = acts[acts.length - 1]!;

  const ny = Number(newest['year'] ?? 0);
  const np = Number(newest['pos'] ?? 0);
  if (!ny || !np) return null;

  return {
    year: ny,
    poz: np,
    displayAddress: String(newest['displayAddress'] ?? `Dz.U. ${ny} poz. ${np}`),
  };
}

interface CensusEntry {
  id: string;
  title: string;
  identifier: string;
  url: string;
  status: string;
  category: string;
  classification: 'ingestable' | 'not_ingestable' | 'skip';
  skip_reason?: string;
  ingested: boolean;
  provision_count: number;
  ingestion_date: string | null;
  year: number;
  poz: number;
  announcement_date: string;
  promulgation_date: string;
  text_html_available: boolean;
  sejm_status: string;
}

interface Census {
  schema_version: string;
  jurisdiction: string;
  jurisdiction_name: string;
  portal: string;
  portal_url: string;
  generated: string;
  summary: {
    total_laws: number;
    total_ingestable: number;
    total_not_ingestable: number;
    total_ingested: number;
    total_provisions: number;
    years_covered: string;
    act_types_included: string[];
  };
  laws: CensusEntry[];
}

function parseArgs(): {
  limit: number | null;
  skipFetch: boolean;
  force: boolean;
  ids: Set<string> | null;
} {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;
  let force = false;
  let ids: Set<string> | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--skip-fetch') {
      skipFetch = true;
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--id' && args[i + 1]) {
      // Comma-separated act ids, e.g. --id pl-du-1964-93,pl-du-2000-1037
      ids = new Set(
        args[i + 1]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i++;
    } else if (args[i] === '--id-file' && args[i + 1]) {
      // Newline- or comma-separated ids from a file (for large re-ingest runs).
      const raw = fs.readFileSync(args[i + 1]!, 'utf-8');
      ids = new Set(
        raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i++;
    }
  }

  return { limit, skipFetch, force, ids };
}

/**
 * Convert a census entry to the ActIndexEntry format expected by parsePolishHtml.
 */
function censusToActEntry(entry: CensusEntry): ActIndexEntry {
  return {
    id: entry.id,
    title: entry.title,
    titleEn: '', // Census-driven acts do not have English titles (will be empty)
    shortName: entry.id,
    status: (entry.status as ActIndexEntry['status']) || 'in_force',
    issuedDate: entry.announcement_date || '',
    inForceDate: entry.promulgation_date || '',
    dziennikRef: entry.identifier,
    year: entry.year,
    poz: entry.poz,
    url: entry.url,
  };
}

async function main(): Promise<void> {
  const { limit, skipFetch, force, ids } = parseArgs();

  console.log('Polish Law MCP -- Census-Driven Ingestion Pipeline');
  console.log('===================================================\n');
  console.log(`  Source: api.sejm.gov.pl (Chancellery of the Sejm)`);
  console.log(`  Format: ELI HTML (structured legislation text)`);
  console.log(`  License: Public domain (Art. 4 Polish Copyright Act)`);

  if (limit) console.log(`  --limit ${limit}`);
  if (skipFetch) console.log(`  --skip-fetch`);
  if (force) console.log(`  --force (re-ingest all)`);
  if (ids) console.log(`  --id (${ids.size} act(s) selected)`);

  // Load census
  if (!fs.existsSync(CENSUS_PATH)) {
    console.error(`\nERROR: Census not found at ${CENSUS_PATH}`);
    console.error('Run "npx tsx scripts/census.ts" first.');
    process.exit(1);
  }

  const census: Census = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf-8'));
  console.log(`\n  Census: ${census.summary.total_laws} total laws`);
  console.log(`  Ingestable: ${census.summary.total_ingestable}`);
  console.log(`  Already ingested: ${census.summary.total_ingested}`);

  // Filter to ingestable acts
  let toIngest = census.laws.filter(e => e.classification === 'ingestable');

  // Restrict to explicitly selected ids (implies --force: selecting an act by id
  // means you want it re-fetched even though its seed already exists).
  if (ids) {
    toIngest = toIngest.filter(e => ids.has(e.id));
    const missing = [...ids].filter(id => !toIngest.some(e => e.id === id));
    if (missing.length > 0) {
      console.log(`  WARNING: ${missing.length} id(s) not ingestable/not in census: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}`);
    }
  }

  // Skip already-ingested unless --force (or an explicit id selection)
  if (!force && !ids) {
    toIngest = toIngest.filter(e => {
      const seedFile = path.join(SEED_DIR, `${e.id}.json`);
      return !fs.existsSync(seedFile);
    });
  }

  // Apply limit
  if (limit) {
    toIngest = toIngest.slice(0, limit);
  }

  console.log(`\n  Acts to ingest this run: ${toIngest.length}\n`);

  if (toIngest.length === 0) {
    console.log('Nothing to ingest. All ingestable acts already have seed files.');
    console.log('Use --force to re-ingest existing acts.');
    return;
  }

  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedNoContent = 0;
  let totalProvisions = 0;
  let totalDefinitions = 0;

  const startTime = Date.now();

  for (const entry of toIngest) {
    const act = censusToActEntry(entry);
    const sourceFile = path.join(SOURCE_DIR, `${act.id}.html`);
    const seedFile = path.join(SEED_DIR, `${act.id}.json`);

    try {
      let html: string;

      if (fs.existsSync(sourceFile) && skipFetch) {
        html = fs.readFileSync(sourceFile, 'utf-8');
      } else {
        // Prefer the newest consolidated text — the base act holds the ORIGINAL
        // wording, which for amended acts is stale (see resolveConsolidatedText).
        // The /references payload does not say which formats exist, so we simply
        // try the consolidated text's HTML and fall back to the base act if it is
        // missing (PDF-only consolidations are handled by `npm run ingest:pdf`).
        const consolidated = await resolveConsolidatedText(act.year, act.poz);

        const candidates: Array<{ year: number; poz: number; label: string }> = [];
        if (consolidated) {
          candidates.push({
            year: consolidated.year,
            poz: consolidated.poz,
            label: `consolidated ${consolidated.displayAddress}`,
          });
        }
        candidates.push({ year: act.year, poz: act.poz, label: 'base act' });

        let result: Awaited<ReturnType<typeof fetchWithRateLimit>> | null = null;
        let usedLabel = '';

        for (const c of candidates) {
          const textUrl = `${ELI_API_BASE}/${c.year}/${c.poz}/text.html`;
          let r;
          try {
            r = await fetchWithRateLimit(textUrl, 3, 60_000);
          } catch (fetchError) {
            const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
            if (processed % LOG_INTERVAL === 0 || processed < 5) {
              console.log(`  [${processed + 1}/${toIngest.length}] FETCH ERROR ${act.id} (${c.label}): ${msg}`);
            }
            continue;
          }
          // A consolidated text that exists only as PDF still answers 200 here —
          // with an empty body. Treat that (and bot challenges) as a miss so the
          // base act is tried instead of storing nothing.
          const usable =
            r.status === 200 &&
            r.body.trim().length > 0 &&
            !r.body.includes('window["bobcmn"]');
          if (usable) {
            result = r;
            usedLabel = c.label;
            break;
          }
          if (processed % LOG_INTERVAL === 0 || processed < 5) {
            console.log(`  [${processed + 1}/${toIngest.length}] HTTP ${r.status} for ${act.id} (${c.label})`);
          }
        }

        if (!result) {
          failed++;
          processed++;
          continue;
        }

        if (consolidated && usedLabel === 'base act') {
          // Consolidated text exists but has no HTML — the base act text we are
          // about to store is out of date. Surface it loudly; ingest:pdf fixes it.
          console.log(
            `  [${processed + 1}/${toIngest.length}] ${act.id}: consolidated text ${consolidated.displayAddress} has no HTML — stored text will be STALE (run ingest:pdf)`,
          );
        } else if (consolidated && (processed % LOG_INTERVAL === 0 || processed < 5)) {
          console.log(`  [${processed + 1}/${toIngest.length}] ${act.id}: using ${usedLabel}`);
        }

        html = result.body;

        // Some acts may not have article structure (very short, or special acts)
        if (!html.includes('unit_arti') && !html.includes('Art.')) {
          // Still save the source but mark as no-content
          fs.writeFileSync(sourceFile, html);
          skippedNoContent++;
          processed++;
          continue;
        }

        fs.writeFileSync(sourceFile, html);
      }

      const parsed = parsePolishHtml(html, act);

      // Only write seed if we got at least 1 provision
      if (parsed.provisions.length === 0) {
        skippedNoContent++;
        processed++;
        continue;
      }

      fs.writeFileSync(seedFile, JSON.stringify(parsed, null, 2));
      totalProvisions += parsed.provisions.length;
      totalDefinitions += parsed.definitions.length;
      succeeded++;

      // Update census entry
      const censusEntry = census.laws.find(l => l.id === entry.id);
      if (censusEntry) {
        censusEntry.ingested = true;
        censusEntry.provision_count = parsed.provisions.length;
        censusEntry.ingestion_date = new Date().toISOString().slice(0, 10);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (processed % LOG_INTERVAL === 0 || processed < 5) {
        console.log(`  [${processed + 1}/${toIngest.length}] ERROR ${act.id}: ${msg.substring(0, 100)}`);
      }
      failed++;
    }

    processed++;

    // Log progress every LOG_INTERVAL acts
    if (processed % LOG_INTERVAL === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (processed / ((Date.now() - startTime) / 1000)).toFixed(1);
      console.log(
        `  Progress: ${processed}/${toIngest.length} (${succeeded} ok, ${failed} fail, ${skippedNoContent} no-content) ` +
        `[${elapsed}s, ${rate} acts/s, ${totalProvisions} provisions]`
      );
    }

    // Save census periodically (every 100 acts) for resume support
    if (processed % 100 === 0) {
      saveCensus(census);
    }
  }

  // Final census update
  census.summary.total_ingested = census.laws.filter(l => l.ingested).length;
  census.summary.total_provisions = census.laws.reduce((sum, l) => sum + l.provision_count, 0);
  saveCensus(census);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log(`\n${'='.repeat(72)}`);
  console.log('Ingestion Report');
  console.log('='.repeat(72));
  console.log(`\n  Source:         api.sejm.gov.pl (Sejm ELI API)`);
  console.log(`  License:       Public domain (Art. 4 Polish Copyright Act)`);
  console.log(`  Duration:      ${elapsed}s`);
  console.log(`  Processed:     ${processed}`);
  console.log(`  Succeeded:     ${succeeded}`);
  console.log(`  Failed:        ${failed}`);
  console.log(`  No content:    ${skippedNoContent}`);
  console.log(`  Provisions:    ${totalProvisions}`);
  console.log(`  Definitions:   ${totalDefinitions}`);
  console.log(`\n  Census updated: ${CENSUS_PATH}`);
  console.log(`  Seed dir: ${SEED_DIR}`);
  console.log('');
}

function saveCensus(census: Census): void {
  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

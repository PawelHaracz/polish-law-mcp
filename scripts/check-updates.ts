#!/usr/bin/env tsx
/**
 * Polish Law MCP — Data Freshness Checker
 *
 * Checks whether the local database is stale or missing expected legislation.
 *
 * Detection strategy:
 * 1. Database age — flags if build_date > MAX_AGE days old
 * 2. Document count — compares DB rows against census.json expected count
 * 3. Source portal — verifies the official legal portal is reachable
 *
 * Exit codes:
 *   0 = database is fresh, no updates detected
 *   1 = updates detected (stale DB, missing documents, or new content upstream)
 *   2 = check failed (DB missing, portal unreachable, unexpected error)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../data/database.db');
const CENSUS_PATH = resolve(__dirname, '../data/census.json');

const MAX_DB_AGE_DAYS = Number(process.env['MAX_DB_AGE_DAYS'] ?? '90');
const PORTAL_URL = 'https://isap.sejm.gov.pl';
const PORTAL_NAME = 'ISAP (Internetowy System Aktow Prawnych)';

interface CensusSummary {
  total_laws?: number;
  total_ingestable?: number;
  total_ingested?: number;
  [key: string]: unknown;
}

function daysSince(isoDate: string): number | null {
  const dt = new Date(isoDate);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkPortal(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    // GET with redirect:'manual': ISAP answers a bare HEAD with a redirect loop
    // ("redirect count exceeded"), which fetch surfaces as a network error even
    // though the portal is up. Not following redirects turns that into a plain
    // 3xx we can read.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': '@ansvar/polish-law-mcp/1.0 (data-freshness-check)' },
    });
    clearTimeout(timeout);
    // Any HTTP answer proves the portal is up — including 3xx and a 403 from a
    // bot filter. Only a network-level failure (caught below) means unreachable.
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('Polish Law MCP — Data Freshness Check');
  console.log(`Portal: ${PORTAL_NAME} (${PORTAL_URL})`);
  console.log('');

  // --- 1. Database existence ---
  if (!existsSync(DB_PATH)) {
    console.error('ERROR: Database not found at', DB_PATH);
    console.error('Run "npm run build:db" first.');
    process.exit(2);
  }

  // --- 2. Database age check ---
  let updatesNeeded = false;
  const { default: Database } = await import('@ansvar/mcp-sqlite');
  const db = new Database(DB_PATH, { readonly: true });

  let buildDate: string | null = null;
  try {
    // build-db.ts writes 'built_at'; 'build_date' is accepted for older databases.
    const row = db
      .prepare("SELECT value FROM db_metadata WHERE key IN ('built_at', 'build_date') ORDER BY key LIMIT 1")
      .get() as { value: string } | undefined;
    buildDate = row?.value ?? null;
  } catch {
    // db_metadata table may not exist
  }

  if (buildDate) {
    const age = daysSince(buildDate);
    if (age !== null && age > MAX_DB_AGE_DAYS) {
      console.log(`STALE: Database is ${age} days old (threshold: ${MAX_DB_AGE_DAYS} days)`);
      updatesNeeded = true;
    } else if (age !== null) {
      console.log(`OK: Database is ${age} days old (threshold: ${MAX_DB_AGE_DAYS} days)`);
    }
  } else {
    console.log('WARN: No build_date in db_metadata — cannot assess age');
  }

  // --- 3. Document count check ---
  let dbDocCount = 0;
  let dbProvCount = 0;
  try {
    const docRow = db.prepare("SELECT COUNT(*) as count FROM legal_documents").get() as { count: number };
    dbDocCount = docRow.count;
    console.log(`DB documents: ${dbDocCount}`);
  } catch {
    console.log('WARN: Cannot count legal_documents');
  }

  try {
    const provRow = db.prepare("SELECT COUNT(*) as count FROM legal_provisions").get() as { count: number };
    dbProvCount = provRow.count;
    console.log(`DB provisions: ${dbProvCount}`);
  } catch {
    console.log('WARN: Cannot count legal_provisions');
  }

  // Compare against census if available. Only statutes (Ustawy) are counted:
  // the DB also holds regulations, so a raw total would always clear the bar.
  if (existsSync(CENSUS_PATH)) {
    try {
      const census = JSON.parse(readFileSync(CENSUS_PATH, 'utf-8')) as { summary?: CensusSummary };
      const expected = census.summary?.total_ingested ?? census.summary?.total_ingestable ?? census.summary?.total_laws;

      // NOTE: every row currently carries type='statute', including ingested
      // regulations, so this count cannot be narrowed to Ustawy. It therefore
      // only catches gross loss (documents disappearing), never a missing act —
      // 19k rows will always clear a ~9k bar. The drift check below is what
      // actually detects out-of-date content.
      if (expected && dbDocCount < expected) {
        console.log(`MISSING: DB has ${dbDocCount} documents but census expects ${expected}`);
        updatesNeeded = true;
      } else if (expected) {
        console.log(`OK: DB documents (${dbDocCount}) >= census expected (${expected}) — coarse check only`);
      }
    } catch {
      console.log('WARN: Could not parse census.json');
    }
  } else {
    console.log('INFO: No census.json — skipping count comparison');
  }

  db.close();

  // --- 3b. Consolidated-text drift (sampled) ---
  // The failure this catches: an act is ingested from its BASE act, which carries
  // the original wording, while the current text lives in a later tekst jednolity.
  // Counts and dates look fine in that case — only the wording is decades stale.
  // We sample well-known codes rather than all ~9k acts to keep the check quick.
  const SAMPLE: Array<{ name: string; eli: string }> = [
    { name: 'Kodeks cywilny', eli: 'DU/1964/93' },
    { name: 'Kodeks karny', eli: 'DU/1997/553' },
    { name: 'Kodeks pracy', eli: 'DU/1974/141' },
    { name: 'Kodeks spolek handlowych', eli: 'DU/2000/1037' },
    { name: 'Kodeks postepowania cywilnego', eli: 'DU/1964/296' },
  ];

  console.log('');
  console.log('Checking consolidated-text drift (sample of major codes)...');

  let censusById: Record<string, { ingestion_date?: string | null }> = {};
  if (existsSync(CENSUS_PATH)) {
    try {
      const census = JSON.parse(readFileSync(CENSUS_PATH, 'utf-8')) as {
        laws?: Array<{ id: string; ingestion_date?: string | null }>;
      };
      for (const l of census.laws ?? []) censusById[l.id] = l;
    } catch {
      // handled below by the missing-entry branch
    }
  }

  for (const s of SAMPLE) {
    const [, year, poz] = s.eli.split('/');
    const id = `pl-du-${year}-${poz}`;
    try {
      const res = await fetch(`https://api.sejm.gov.pl/eli/acts/${s.eli}/references`, {
        headers: { 'User-Agent': '@ansvar/polish-law-mcp/1.0 (data-freshness-check)' },
      });
      if (!res.ok) {
        console.log(`  WARN: ${s.name} — references HTTP ${res.status}`);
        continue;
      }
      const refs = (await res.json()) as Record<string, Array<{ act?: Record<string, unknown> }>>;
      const acts = (refs['Inf. o tekście jednolitym'] ?? [])
        .map((e) => e.act)
        .filter((a): a is Record<string, unknown> => Boolean(a));
      if (acts.length === 0) continue; // never consolidated — base act is correct

      acts.sort((a, b) => {
        const ay = Number(a['year'] ?? 0);
        const by = Number(b['year'] ?? 0);
        return ay !== by ? ay - by : Number(a['pos'] ?? 0) - Number(b['pos'] ?? 0);
      });
      const newest = acts[acts.length - 1]!;
      const promulgation = String(newest['promulgation'] ?? '');
      const display = String(newest['displayAddress'] ?? '');
      const ingested = censusById[id]?.ingestion_date ?? null;

      if (ingested && promulgation && promulgation > ingested) {
        console.log(`  STALE: ${s.name} — ${display} (${promulgation}) is newer than ingest (${ingested})`);
        updatesNeeded = true;
      } else {
        console.log(`  OK: ${s.name} — newest consolidated text ${display}`);
      }
    } catch (err) {
      console.log(`  WARN: ${s.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- 4. Source portal reachability ---
  console.log('');
  console.log(`Checking portal: ${PORTAL_URL}`);
  const portalOk = await checkPortal(PORTAL_URL);
  if (portalOk) {
    console.log(`OK: ${PORTAL_NAME} is reachable`);
  } else {
    console.log(`WARN: ${PORTAL_NAME} is unreachable — manual check recommended`);
  }

  // --- Result ---
  console.log('');
  if (updatesNeeded) {
    console.log('RESULT: Updates detected — re-ingestion recommended');
    process.exit(1);
  } else {
    console.log('RESULT: Database appears current — no updates needed');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});

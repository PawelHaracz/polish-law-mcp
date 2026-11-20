/**
 * Shared consolidated-text (tekst jednolity) resolver for the Sejm ELI API.
 */

import { fetchWithRateLimit } from './fetcher.js';

const ELI_API_BASE = 'https://api.sejm.gov.pl/eli/acts/DU';

/**
 * Newest consolidated text (tekst jednolity) of an act, if one exists.
 *
 * The base act (e.g. DU/1964/93 for the Civil Code) carries its ORIGINAL 1964
 * wording — amendments are published as separate acts and only folded together
 * in a consolidated text. Ingesting the base act therefore yields text that can
 * be decades out of date. Roughly 2% of in-force acts have a consolidated text;
 * for the rest the base act is the correct source and this returns null.
 */
export interface ConsolidatedText {
  year: number;
  poz: number;
  displayAddress: string;
}

export async function resolveConsolidatedText(
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

/**
 * PDF text parser for Polish acts that the Sejm ELI API serves ONLY as PDF
 * (textHTML:false, textPDF:true) — ~220 in-force acts, including the 1997
 * Constitution and ratified international agreements. These never reach the HTML
 * parser, so without this they are absent from the database entirely.
 *
 * Strategy: `pdftotext` (poppler) extracts a clean text layer (verified: the
 * Constitution PDF yields correct "Art. 1. Rzeczpospolita Polska …"). We strip
 * the repeating Kancelaria Sejmu page chrome, then parse the flat text into the
 * SAME ParsedProvision shape the HTML parser emits (art1, art1u2, art1u2p3…),
 * so downstream (build-db, search, refs) treats both sources identically.
 *
 * pdftotext is a BUILD-TIME dependency only (ingest/build-db), never shipped in
 * the runtime package.
 */

import { execFileSync } from 'child_process';
import type { ActIndexEntry, ParsedAct, ParsedProvision } from './parser.js';

/** Repeating page header/footer lines emitted by the Sejm PDF template. */
const CHROME_PATTERNS: RegExp[] = [
  /^©?\s*Kancelaria Sejmu\s*$/i,
  /^s\.\s*\d+\/\d+\s*$/i,            // "s. 5/56"
  /^\d{4}-\d{2}-\d{2}\s*$/,          // revision date stamp
  /^Dziennik Ustaw\s*$/i,
  /^[-–—\s]*\d+[-–—\s]*$/,           // bare page numbers
];

/** True if a line is page chrome that must not enter provision text. */
function isChrome(line: string): boolean {
  return CHROME_PATTERNS.some(p => p.test(line.trim()));
}

/**
 * Extract plain text from a PDF file via pdftotext. Throws a clear error if the
 * binary is missing so the ingest run fails loudly with a fix hint.
 */
export function pdfToText(pdfPath: string): string {
  try {
    // -nopgbrk: no form-feed between pages; -enc UTF-8: keep Polish letters.
    return execFileSync('pdftotext', ['-nopgbrk', '-enc', 'UTF-8', pdfPath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(msg)) {
      throw new Error(
        'pdftotext not found. Install poppler (macOS: `brew install poppler`, ' +
        'Debian/Ubuntu: `apt-get install poppler-utils`) — required to ingest PDF-only acts.',
      );
    }
    throw err;
  }
}

/** Normalise: drop chrome lines, collapse hyphenation/whitespace artefacts. */
function cleanLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(l => l.replace(/ /g, ' ').trimEnd())
    .filter(l => l.trim().length > 0 && !isChrome(l));
}

/**
 * Parse the flat PDF text into article-level provisions plus ustęp/punkt leaves.
 * The PDF layout puts "Art. N." at line start, sometimes with the first ustęp on
 * the same line ("Art. 4. 1. Władza …"); subsequent ustępy/punkty start their own
 * lines ("2.", "3)", etc.). We reconstruct each article's full text, then split
 * it into sub-units mirroring the HTML hierarchy.
 */
export function parsePolishPdf(rawText: string, act: ActIndexEntry): ParsedAct {
  const lines = cleanLines(rawText);
  const provisions: ParsedProvision[] = [];

  // Split into articles by the "Art. N." marker at line start. Pre-war PDFs are
  // low-quality OCR where "Art." often comes out as "Rrt."/"flrt." (A↔R/fl). Accept
  // a short OCR-tolerant token ending in "rt" before ". N.". The quality gate
  // below rejects acts whose OCR is too poor to trust, rather than storing garbage.
  // "Art" plus the handful of real OCR confusions seen in pre-war scans
  // (A↔R, A↔fl/ft ligatures). Tight enough to avoid matching ordinary words.
  const artStart = /^(?:Art|Rrt|flrt|ftrt|Art)\.?\s*(\d+[a-z]*)\.\s*(.*)$/i;
  let current: { num: string; buf: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.buf.join(' ').replace(/\s+/g, ' ').trim();
    if (body.length >= 3) {
      build(current.num, body, act, provisions);
    }
    current = null;
  };

  // Rozporządzenia have no articles: § is their top-level unit (refs par1,
  // par1u2 … like the HTML parser). Codes (KP, KC …) also start many lines with
  // "§ N." — usually more than with "Art." — so a simple majority is wrong.
  // Pick § mode only when Art. markers are absent or a stray handful (a quoted
  // statute in an annex) next to an order of magnitude more §§.
  const parStart = /^§\s*(\d+[a-z]*)\.\s*(.*)$/;
  const artCount = lines.filter(l => artStart.test(l)).length;
  const parCount = lines.filter(l => parStart.test(l)).length;
  const paragrafMode = parCount > 0 && artCount * 10 < parCount;
  const unitStart = paragrafMode ? parStart : artStart;
  const build = paragrafMode ? buildParagrafRows : buildArticleRows;

  // Annexes (załączniki: tariffs, forms, classifications) follow the last unit;
  // glued onto it, their numbering became bogus ustęp/punkt leaves (PKWiU
  // yielded par4u1…u71 and a 780 KB § 4). Once a unit has started, each annex
  // heading opens its own unsplit row: zal1, zal2 … "do obwieszczenia" is
  // skipped: in consolidated texts the act itself IS that annex.
  const annexStart = /^(?:Załącznik|ZAŁĄCZNIK)(?:i|I)?(?:\s+(?:nr|NR)\s+\d+[a-z]*)?(?:\s+do\s+(?!obwieszczenia)|\s*$)/;

  const annexes: Array<{ heading: string; buf: string[] }> = [];

  for (const line of lines) {
    if (annexes.length > 0) {
      if (annexStart.test(line.trim())) annexes.push({ heading: line.trim(), buf: [] });
      else annexes[annexes.length - 1]!.buf.push(line);
      continue;
    }
    if (current && annexStart.test(line.trim())) {
      flush();
      annexes.push({ heading: line.trim(), buf: [] });
      continue;
    }
    const m = line.match(unitStart);
    if (m) {
      flush();
      current = { num: m[1].toLowerCase(), buf: m[2] ? [m[2]] : [] };
    } else if (current) {
      current.buf.push(line);
    }
    // Lines before the first article (preamble/title) are ignored for provisions.
  }
  flush();

  // Consecutive headings (a multi-line "Załącznik nr 1 / do rozporządzenia …")
  // leave empty chunks; fold them into the next one so numbering stays dense.
  let zal = 0;
  let pendingHeading = '';
  for (const a of annexes) {
    const body = a.buf.join(' ').replace(/\s+/g, ' ').trim();
    const heading = (pendingHeading ? `${pendingHeading} ${a.heading}` : a.heading).slice(0, 200);
    if (body.length < 3) { pendingHeading = heading; continue; }
    pendingHeading = '';
    zal++;
    provisions.push({ provision_ref: `zal${zal}`, section: `zal${zal}`, title: heading, content: body });
  }

  // Quality gate: an act with substantial text but almost no recognised articles
  // is unusable OCR (typical of pre-war scans). Better to skip it than to store a
  // garbage seed in a legal database. Threshold is deliberately lenient — one
  // good article per ~4 KB of text — so clean modern PDFs always pass.
  const articleRows = provisions.filter(p => /^(?:art|par)\d+[a-z]*$/.test(p.provision_ref)).length;
  const textKb = rawText.length / 1024;
  // The density check targets scanned OCR (always Art.-based). Regulations are
  // born-digital and often carry huge annexes (PKWiU, forms) after a handful of
  // §§, so in § mode only an empty parse is rejected.
  // Post-2000 Dziennik Ustaw PDFs are born-digital too (budget acts, amending
  // acts with long quoted annexes trip the density check without being OCR).
  const ocrEra = act.year < 2000;
  const tooSparse = !paragrafMode && ocrEra && textKb > 8 && articleRows < textKb / 8;
  if (articleRows === 0 || tooSparse) {
    return {
      id: act.id, type: 'statute', title: act.title, title_en: act.titleEn,
      short_name: act.shortName, status: act.status, issued_date: act.issuedDate,
      in_force_date: act.inForceDate, url: act.url, description: act.description,
      provisions: [], definitions: [],
    };
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.shortName,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    description: act.description,
    provisions,
    definitions: [],
  };
}

/**
 * From one article's full text, emit the aggregate row (art{N}) plus ustęp/punkt
 * leaf rows. Sub-units in the flat text are marker-delimited: "1." / "2." for
 * ustępy, "1)" / "2)" for punkty. This is a pragmatic split — PDFs lack the DOM
 * the HTML parser uses — but it produces the same ref scheme (art1, art1u2, …).
 */
function buildArticleRows(
  num: string,
  body: string,
  act: ActIndexEntry,
  provisions: ParsedProvision[],
): void {
  const baseRef = `art${num}`;
  provisions.push({
    provision_ref: baseRef,
    section: num,
    title: `Art. ${num}`,
    content: body,
  });

  // Codes (KC, KK, KSH, KPC …) divide articles into paragrafy — "§ 1." — while
  // ordinary statutes use ustępy ("1."). An article uses one scheme or the other,
  // so try § first and only fall back to ustępy when no § marker is present.
  const paragrafParts = splitNumbered(body, /(?:^|\s)§\s*(\d+[a-z]*)\.\s+/g);
  if (paragrafParts.some(p => p.n)) {
    for (const { n, text } of paragrafParts) {
      if (!n) continue;
      const ref = `${baseRef}par${n}`;
      emitLeafWithPunkty(ref, `Art. ${num} § ${n}`, num, text, provisions);
    }
    return;
  }

  // Split ustępy on " N. " boundaries. Keep the leading chapeau (text before the
  // first "1.") attached to each leaf for context.
  const ustepParts = splitNumbered(body, USTEP_RE);
  if (ustepParts.some(p => p.n)) {
    for (const { n, text } of ustepParts) {
      if (!n) continue; // chapeau handled inside splitNumbered consumers
      emitLeafWithPunkty(`${baseRef}u${n}`, `Art. ${num} ust. ${n}`, num, text, provisions);
    }
  }
}

/**
 * Regulation counterpart of buildArticleRows: § N is the top-level unit, split
 * into ustępy ("1.") and punkty ("1)") the same way.
 */
function buildParagrafRows(
  num: string,
  body: string,
  _act: ActIndexEntry,
  provisions: ParsedProvision[],
): void {
  const baseRef = `par${num}`;
  provisions.push({ provision_ref: baseRef, section: num, title: `§ ${num}`, content: body });

  const ustepParts = splitNumbered(body, USTEP_RE);
  if (ustepParts.some(p => p.n)) {
    for (const { n, text } of ustepParts) {
      if (!n) continue;
      emitLeafWithPunkty(`${baseRef}u${n}`, `§ ${num} ust. ${n}`, num, text, provisions);
    }
    return;
  }
  // No ustępy: split punkty straight off the § ("§ 1. … określa: 1) … 2) …").
  const punktParts = splitNumbered(body, /(?:^|\s)(\d+[a-z]*)\)\s+/g);
  if (punktParts.filter(p => p.n).length > 1) {
    for (const p of punktParts) {
      if (!p.n) continue;
      provisions.push({ provision_ref: `${baseRef}p${p.n}`, section: num, title: `§ ${num} pkt ${p.n}`, content: p.text });
    }
  }
}

/**
 * Emit one sub-unit row, split further into punkty ("N) …") when it has them.
 * Shared by the § and ustęp paths so both produce the same leaf shape.
 */
function emitLeafWithPunkty(
  ref: string,
  title: string,
  section: string,
  text: string,
  provisions: ParsedProvision[],
): void {
  const punktParts = splitNumbered(text, /(?:^|\s)(\d+[a-z]*)\)\s+/g);
  if (punktParts.filter(p => p.n).length > 1) {
    for (const p of punktParts) {
      if (!p.n) continue;
      provisions.push({
        provision_ref: `${ref}p${p.n}`,
        section,
        title: `${title} pkt ${p.n}`,
        content: p.text,
      });
    }
    return;
  }
  provisions.push({ provision_ref: ref, section, title, content: text });
}

/**
 * Ustęp marker: " N. " starting a sentence. Requires an uppercase/quote opening
 * after the number so citations and cross-references do not register as ustępy —
 * "Dz.U. 2026 poz. 795" and "art. 5 ust. 2. zdanie" previously produced bogus
 * refs like art4u31p795. Ustęp numbers are also capped at 3 digits (real ones are
 * small; a 4-digit "number" is a year or a Dz.U. position).
 */
const USTEP_RE = /(?:^|\s)(\d{1,3}[a-z]*)\.\s+(?=[A-ZŁŚŻŹĆŃÓĄĘ„"])/g;

/** Split text on a numbered-marker regex, returning {n, text} segments. */
function splitNumbered(text: string, re: RegExp): Array<{ n: string | null; text: string }> {
  const out: Array<{ n: string | null; text: string }> = [];
  let lastIndex = 0;
  let lastN: string | null = null;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const seg = text.slice(lastIndex, m.index).trim();
    if (seg) out.push({ n: lastN, text: seg });
    lastN = m[1];
    lastIndex = re.lastIndex;
  }
  const tail = text.slice(lastIndex).trim();
  if (tail) out.push({ n: lastN, text: tail });
  return out;
}

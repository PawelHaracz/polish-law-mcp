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
import { toSuperscript } from './superscript.js';

/** Repeating page header/footer lines emitted by the Sejm PDF template. */
const CHROME_PATTERNS: RegExp[] = [
  /^©?\s*Kancelaria Sejmu\s*$/i,
  /^s\.\s*\d+\/\d+\s*$/i,            // "s. 5/56"
  /^\d{4}-\d{2}-\d{2}\s*$/,          // revision date stamp
  /^Dziennik Ustaw\s*$/i,
  /^[-–—\s]*\d+[-–—\s]*$/,           // bare page numbers
  /^Poz\.\s*\d+\s*$/i,               // Dziennik Ustaw page header ("Poz. 1245")
];

/**
 * pdftotext renders superscript unit numbers as brackets: "Art. 22[1]." is
 * art. 22¹, "§ 2[1]." is § 2¹. SUP is the optional bracket suffix every unit
 * marker regex must accept, or the unit is glued onto the one before it.
 */
const SUP = String.raw`(?:\[\d{1,3}[a-z]{0,2}\])?`;

/** Ref/section form of a unit number: "22[1]" -> "22^1" (never collides with art. 221). */
function refNum(n: string): string {
  return n.toLowerCase().replace(/\[(\w+)\]/, '^$1');
}

/** Display form of a unit number: "22[1]" -> "22¹". */
function displayNum(n: string): string {
  return n.toLowerCase().replace(/\[(\w+)\]/, (whole, k: string) => toSuperscript(k) ?? whole);
}

/**
 * Turn bracketed superscripts after unit numbers into real superscripts in
 * provision text ("art. 22[1] § 2[1]" -> "art. 22¹ § 2¹"). The number must start
 * a token (space, "(", en dash or line start), so standard references such as
 * "V3.5.1:2023-12[5]" and ASN.1 tags ("message [1]") stay untouched.
 */
export function supify(text: string): string {
  return text.replace(
    /(^|[\s(–])(\d{1,4}[a-z]{0,3})\[(\d{1,3}[a-z]{0,2})\]/g,
    (whole, pre: string, n: string, k: string) => {
      const sup = toSuperscript(k);
      return sup ? `${pre}${n}${sup}` : whole;
    },
  );
}

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
function cleanLines(raw: string, notes?: string[]): string[] {
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\u00a0/g, ' ').trimEnd());
  return stripFootnotes(lines, notes).filter(l => l.trim().length > 0 && !isChrome(l));
}

const MARKER_ONLY = /^(\d{1,3})\)$/;

function nextNonBlank(lines: string[], i: number, limit = 3): number {
  for (let j = i + 1; j < lines.length && j <= i + limit; j++) if (lines[j]!.trim()) return j;
  return -1;
}

/** Footnote number when line i opens a consolidated-text footnote ("14)" + "W brzmieniu …"). */
function footnoteStart(lines: string[], i: number): string | null {
  const t = lines[i]!.trim();
  const inline = t.match(/^(\d{1,3})\)\s+(.*)$/);
  if (inline && FOOTNOTE_RE.test(inline[2]!)) return inline[1]!;
  const only = t.match(MARKER_ONLY);
  if (!only) return null;
  const j = nextNonBlank(lines, i);
  return j >= 0 && FOOTNOTE_RE.test(lines[j]!.trim()) ? only[1]! : null;
}

/**
 * Consolidated texts print footnotes at the page bottom, right before the page
 * chrome (date stamp, "Dziennik Ustaw", page number, "Poz. N"), and mark them in
 * the text with a superscript "N)" that pdftotext puts on its own line. Drop each
 * footnote block up to the chrome that closes the page (no chrome within 40
 * lines: keep everything), then drop the in-text markers of those footnotes that
 * stand right before a punkt marker ("14)" "6)" → "6)").
 */
function stripFootnotes(lines: string[], sink?: string[]): string[] {
  const drop = new Array<boolean>(lines.length).fill(false);
  const notes = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const n = footnoteStart(lines, i);
    if (n === null) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      if (lines[j]!.trim() && isChrome(lines[j]!)) { end = j; break; }
    }
    if (end < 0) continue;
    let current = '';
    const flushNote = () => { const t = current.replace(/\s+/g, ' ').trim(); if (t && sink) sink.push(t); current = ''; };
    for (let j = i; j < end; j++) {
      drop[j] = true;
      const line = lines[j]!.trim();
      const m = line.match(/^(\d{1,3})\)(?:\s+(.*))?$/);
      if (m) { notes.add(m[1]!); flushNote(); current = m[2] ?? ''; }
      else current += ` ${line}`;
    }
    flushNote();
    i = end;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = drop[i] ? null : lines[i]!.trim().match(MARKER_ONLY);
    if (!m || !notes.has(m[1]!)) continue;
    const j = nextNonBlank(lines, i);
    if (j >= 0 && /^\d+[a-z]*(?:\[\w+\])?\)(?:\s|$)/.test(lines[j]!.trim())) drop[i] = true;
  }
  return lines.filter((_, i) => !drop[i]);
}

/**
 * Parse the flat PDF text into article-level provisions plus ustęp/punkt leaves.
 * The PDF layout puts "Art. N." at line start, sometimes with the first ustęp on
 * the same line ("Art. 4. 1. Władza …"); subsequent ustępy/punkty start their own
 * lines ("2.", "3)", etc.). We reconstruct each article's full text, then split
 * it into sub-units mirroring the HTML hierarchy.
 */
export function parsePolishPdf(rawText: string, act: ActIndexEntry): ParsedAct {
  const footnotes: string[] = [];
  const lines = cleanLines(rawText, footnotes);
  const provisions: ParsedProvision[] = [];

  // Split into articles by the "Art. N." marker at line start. Pre-war PDFs are
  // low-quality OCR where "Art." often comes out as "Rrt."/"flrt." (A↔R/fl). Accept
  // a short OCR-tolerant token ending in "rt" before ". N.". The quality gate
  // below rejects acts whose OCR is too poor to trust, rather than storing garbage.
  // "Art" plus the handful of real OCR confusions seen in pre-war scans
  // (A↔R, A↔fl/ft ligatures). Tight enough to avoid matching ordinary words.
  const artStart = new RegExp(String.raw`^(?:Art|Rrt|flrt|ftrt)\.?\s*(\d+[a-z]*${SUP})\.\s*(.*)$`, 'i');
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
  const parStart = new RegExp(String.raw`^§\s*(\d+[a-z]*${SUP})\.\s*(.*)$`);
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
      current = { num: m[1], buf: m[2] ? [m[2]] : [] };
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
    provisions.push({ provision_ref: `zal${zal}`, section: `zal${zal}`, title: supify(heading), content: supify(body) });
  }

  // Quality gate: an act with substantial text but almost no recognised articles
  // is unusable OCR (typical of pre-war scans). Better to skip it than to store a
  // garbage seed in a legal database. Threshold is deliberately lenient — one
  // good article per ~4 KB of text — so clean modern PDFs always pass.
  const articleRows = provisions.filter(p => /^(?:art|par)\d+[a-z]*(?:\^\w+)?$/.test(p.provision_ref)).length;
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
    footnotes: [...new Set(footnotes)],
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
  const sec = refNum(num);
  const disp = displayNum(num);
  const baseRef = `art${sec}`;
  provisions.push({
    provision_ref: baseRef,
    section: sec,
    title: `Art. ${disp}`,
    content: supify(body),
  });

  // Codes (KC, KK, KSH, KPC …) divide articles into paragrafy — "§ 1." — while
  // ordinary statutes use ustępy ("1."). An article uses one scheme or the other,
  // so try § first and only fall back to ustępy when no § marker is present.
  const paragrafParts = splitNumbered(body, new RegExp(String.raw`(?:^|\s)§\s*(\d+[a-z]*${SUP})\.\s+`, 'g'));
  if (paragrafParts.some(p => p.n)) {
    for (const { n, text } of paragrafParts) {
      if (!n) continue;
      const ref = `${baseRef}par${refNum(n)}`;
      emitLeafWithPunkty(ref, `Art. ${disp} § ${displayNum(n)}`, sec, text, provisions);
    }
    return;
  }

  // Split ustępy on " N. " boundaries. Keep the leading chapeau (text before the
  // first "1.") attached to each leaf for context.
  const ustepParts = splitNumbered(body, USTEP_RE);
  if (ustepParts.some(p => p.n)) {
    for (const { n, text } of ustepParts) {
      if (!n) continue; // chapeau handled inside splitNumbered consumers
      emitLeafWithPunkty(`${baseRef}u${refNum(n)}`, `Art. ${disp} ust. ${displayNum(n)}`, sec, text, provisions);
    }
    return;
  }

  // No ustępy: punkty straight off the article ("Art. 2. … oznacza: 1) … 2) …"),
  // stored as art2p1 like the HTML parser does. Consolidated-text footnotes look
  // like punkty too ("11) W brzmieniu ustalonym …"), so only markers that
  // continue the numbering count.
  const punktParts = sequentialPunkty(splitNumbered(body, PUNKT_RE));
  if (punktParts.filter(p => p.n).length > 1) {
    for (const p of punktParts) {
      if (!p.n) continue;
      provisions.push({
        provision_ref: `${baseRef}p${refNum(p.n)}`,
        section: sec,
        title: `Art. ${disp} pkt ${displayNum(p.n)}`,
        content: supify(p.text),
      });
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
  const sec = refNum(num);
  const disp = displayNum(num);
  const baseRef = `par${sec}`;
  provisions.push({ provision_ref: baseRef, section: sec, title: `§ ${disp}`, content: supify(body) });

  const ustepParts = splitNumbered(body, USTEP_RE);
  if (ustepParts.some(p => p.n)) {
    for (const { n, text } of ustepParts) {
      if (!n) continue;
      emitLeafWithPunkty(`${baseRef}u${refNum(n)}`, `§ ${disp} ust. ${displayNum(n)}`, sec, text, provisions);
    }
    return;
  }
  // No ustępy: split punkty straight off the § ("§ 1. … określa: 1) … 2) …").
  const punktParts = sequentialPunkty(splitNumbered(body, PUNKT_RE));
  if (punktParts.filter(p => p.n).length > 1) {
    for (const p of punktParts) {
      if (!p.n) continue;
      provisions.push({ provision_ref: `${baseRef}p${refNum(p.n)}`, section: sec, title: `§ ${disp} pkt ${displayNum(p.n)}`, content: supify(p.text) });
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
  const punktParts = sequentialPunkty(splitNumbered(text, PUNKT_RE));
  if (punktParts.filter(p => p.n).length > 1) {
    for (const p of punktParts) {
      if (!p.n) continue;
      provisions.push({
        provision_ref: `${ref}p${refNum(p.n)}`,
        section,
        title: `${title} pkt ${displayNum(p.n)}`,
        content: supify(p.text),
      });
    }
    return;
  }
  provisions.push({ provision_ref: ref, section, title, content: supify(text) });
}

/**
 * Ustęp marker: " N. " starting a sentence. Requires an uppercase/quote opening
 * after the number so citations and cross-references do not register as ustępy —
 * "Dz.U. 2026 poz. 795" and "art. 5 ust. 2. zdanie" previously produced bogus
 * refs like art4u31p795. Ustęp numbers are also capped at 3 digits (real ones are
 * small; a 4-digit "number" is a year or a Dz.U. position).
 */
const USTEP_RE = new RegExp(String.raw`(?:^|\s)(\d{1,3}[a-z]*${SUP})\.\s+(?=[A-ZŁŚŻŹĆŃÓĄĘ„"])`, 'g');

/** Punkt marker: "N)" or "N[k])" (pkt N^k). */
const PUNKT_RE = new RegExp(String.raw`(?:^|\s)(\d+[a-z]*${SUP})\)\s+`, 'g');

/**
 * Consolidated-text footnotes ("11) W brzmieniu ustalonym przez …") print
 * between punkty at page bottoms and look exactly like punkt markers. They are
 * recognised by their wording; a real repealed punkt reads "(uchylony)".
 */
const FOOTNOTE_RE = new RegExp([
  String.raw`^(?:W brzmieniu ustalonym|W tym brzmieniu obowiązuje|Ze zmian(?:ą|ami) wprowadzon|Wprowadzenie do wyliczenia|Zdanie wstępne|Część wspólna)`,
  String.raw`^(?:(?:Rozdział|Oddział|Dział|Tytuł|Art\.|Ust\.|Pkt|Lit\.|Załącznik)\s+(?:\S+\s+)?)?(?:Dodan[yae]|Uchylon[yae]|Zmienion[yae]|Skreślon[yae]) przez`,
  String.raw`^Zmian[ay] (?:tekstu jednolitego )?wymienion\w+ (?:ustawy|rozporządzenia|dyrektywy|decyzji)`,
  String.raw`^(?:Niniejsza ustawa|Niniejsze rozporządzenie) (?:dokonuje|wdraża|służy|w zakresie)`,
  String.raw`^(?:Rozporządzenie|Ustawa) został[ao] ogłoszon[ey] w dniu`,
  String.raw`^(?:Utracił[ay]? moc|Stwierdzon[yae]|Uznan[yae] za niezgodn|Wszedł|Weszł[ay])`,
  String.raw`^[A-ZŁŚŻŹĆŃÓ][^.;]{0,160}\b(?:o któr\w+ mowa|wymienion\w+) w (?:odnośniku|przypisie) \d+`,
].join('|'));

/** Fold footnote "N)" segments back into the preceding segment. */
function sequentialPunkty(parts: Array<{ n: string | null; text: string }>): Array<{ n: string | null; text: string }> {
  const out: Array<{ n: string | null; text: string }> = [];
  for (const part of parts) {
    if (part.n === null || !FOOTNOTE_RE.test(part.text)) { out.push({ ...part }); continue; }
    const folded = `${part.n}) ${part.text}`;
    if (out.length === 0) out.push({ n: null, text: folded });
    else out[out.length - 1]!.text += ` ${folded}`;
  }
  return out;
}

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

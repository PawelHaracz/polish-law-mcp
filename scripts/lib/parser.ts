/**
 * HTML parser for Polish legislation from the Sejm ELI API (api.sejm.gov.pl).
 *
 * Parses the structured HTML served by the ELI text endpoint into seed JSON.
 * The HTML structure uses:
 *
 * - <div class="unit unit_chpt" id="chpt_N"> for chapters (Rozdział)
 * - <div class="unit unit_arti" id="chpt_N-arti_M"> for articles (Art.)
 * - <h3> inside articles for article number (Art. N.)
 * - <div class="unit unit_pass"> for numbered paragraphs (ustępy)
 * - <div class="unit unit_pint"> for numbered points (punkty)
 * - <div data-template="xText" class="pro-text"> for text content
 *
 * Polish legislation references: Dz.U. YYYY poz. NNNN
 * API endpoint: https://api.sejm.gov.pl/eli/acts/DU/{YEAR}/{POZ}/text.html
 */

export interface ActIndexEntry {
  id: string;
  title: string;
  titleEn: string;
  shortName: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issuedDate: string;
  inForceDate: string;
  /** ISAP display address, e.g. "Dz.U. 2018 poz. 1000" */
  dziennikRef: string;
  /** Year of publication in Dziennik Ustaw */
  year: number;
  /** Position number (poz.) in Dziennik Ustaw */
  poz: number;
  /** Human-readable URL on ISAP */
  url: string;
  description?: string;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en: string;
  short_name: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date: string;
  in_force_date: string;
  url: string;
  description?: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

/**
 * Observability threshold — provisions longer than this trigger a warning so we
 * can SEE unusually large rows (typically amending acts that rewrite a whole
 * chapter under one punkt). It does NOT truncate: a legal MCP must not silently
 * drop statutory text. SQLite TEXT and FTS5 handle multi-hundred-KB strings fine.
 */
const LARGE_PROVISION_WARN_CHARS = 50000;

/**
 * Runaway backstop only — bounds pathological/corrupt input (e.g. a parsing bug
 * that swallows the whole document). The largest genuine act source is a few MB,
 * so real provisions stay well under this. Truncation here is logged loudly.
 */
const HARD_LIMIT_CHARS = 5_000_000;

/**
 * Strip HTML tags and decode common entities, normalising whitespace.
 *
 * IMPORTANT: <script>/<style> bodies are removed FIRST. The ELI page appends an
 * inline `<script>var tree = [ ... ]</script>` (the document navigation tree) to
 * the footer. The naive `<[^>]+>` tag-strip only removes the tags, leaving the
 * JS/JSON body behind — which is how ~8.7k provisions ended up with
 * "...Pokaż całość var tree = [{"id":"part_1","type":"part",...}]" appended to
 * their legal text. Drop the element bodies before stripping tags.
 *
 * <span class="xHidden"> blocks are also dropped: they hold the UI-collapsed
 * Dz.U. citation list (publication history of the referenced act), not statutory
 * text. In amending acts this list can dominate an article's chapeau (e.g. 2197
 * of 2633 chapeau chars), so keeping it would bloat the aggregate and duplicate
 * the citation list across every child punkt.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<span\b[^>]*\bclass="[^"]*\bxHidden\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&shy;/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cut the ELI page footer (navigation tree + scripts) off the raw HTML so it
 * cannot leak into the last article's content. Returns the HTML up to the first
 * footer marker found, or the original HTML if no marker is present.
 *
 * Markers, in priority order:
 *   - <div id="show-all"            the "Pokaż całość" navigation block
 *   - <div class="...show-all...    same block, class-only variant
 *   - var tree =                    the inline JSON document tree
 */
function trimActFooter(html: string): string {
  const markers = [
    /<div[^>]*\bid="show-all"/i,
    /<div[^>]*\bclass="[^"]*\bshow-all\b/i,
    /var\s+tree\s*=/i,
  ];
  let cut = html.length;
  for (const marker of markers) {
    const m = html.match(marker);
    if (m && m.index !== undefined && m.index < cut) {
      cut = m.index;
    }
  }
  return cut < html.length ? html.slice(0, cut) : html;
}

/**
 * Find the chapter heading (Rozdział) for a given article position.
 * Searches backwards from the article position for the nearest chapter div.
 */
function findChapterHeading(html: string, articlePos: number): string | undefined {
  const beforeArticle = html.substring(Math.max(0, articlePos - 10000), articlePos);

  // Look for the last chapter heading: Rozdział N ... Title
  // Pattern in ISAP HTML: <div class="unit unit_chpt"...> <h3> Rozdział N ... Title </h3>
  const chapterMatches = [
    ...beforeArticle.matchAll(/Rozdzia[łl]\s*&nbsp;\s*(\d+[a-z]?)\s*(.*?)(?=<\/h3>|<\/P>)/gi),
  ];

  if (chapterMatches.length > 0) {
    const last = chapterMatches[chapterMatches.length - 1];
    const chapterNum = last[1].trim();
    // Try to find the title in subsequent <P> or <SPAN> tags
    const afterChapter = beforeArticle.substring(last.index! + last[0].length);
    const titleMatch = afterChapter.match(/<SPAN[^>]*class="pro-title-unit"[^>]*>(.*?)<\/SPAN>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';

    return title
      ? `Rozdział ${chapterNum} - ${title}`
      : `Rozdział ${chapterNum}`;
  }

  // Also check for Dział (Division) used in larger codes
  const dzialMatches = [
    ...beforeArticle.matchAll(/Dzia[łl]\s*&nbsp;\s*([IVXLCDM]+[a-z]?)\s*(.*?)(?=<\/h3>|<\/P>)/gi),
  ];

  if (dzialMatches.length > 0) {
    const last = dzialMatches[dzialMatches.length - 1];
    const dzialNum = last[1].trim();
    const afterDzial = beforeArticle.substring(last.index! + last[0].length);
    const titleMatch = afterDzial.match(/<SPAN[^>]*class="pro-title-unit"[^>]*>(.*?)<\/SPAN>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';

    return title
      ? `Dział ${dzialNum} - ${title}`
      : `Dział ${dzialNum}`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Recursive sub-unit parsing
//
// ELI HTML nests legal units as <div class="unit unit_X ..."> with data-id
// "X_N". The levels we care about, with how their number is printed in <h3>:
//
//   arti  (artykuł)  Art. N.        ref tag: art
//   para  (§)        § N.           ref tag: par
//   pass  (ustęp)    N.             ref tag: u
//   pint  (punkt)    N)             ref tag: p
//   lett  (litera)   x)             ref tag: l
//   slet  (podlit.)  —              ref tag: sl   (rare)
//
// Refs concatenate level tags + numbers, e.g. art1u2p3la = art.1 ust.2 pkt.3
// lit.a. No parens/colons, so the subsection-strip regex in get-provision.ts
// never mangles them. We emit one aggregate row per article (full recursive
// text — backward-compatible with get_provision('art1')) plus one row per leaf
// sub-unit (precise citation + FTS). Amendment cite-box content stays INLINE in
// its parent punkt (never promoted), so the replacement wording is preserved
// without polluting the DB with provisions that belong to a different act.
// ---------------------------------------------------------------------------

/** Sub-unit levels, in nesting order, with the ref tag each contributes. */
const UNIT_LEVELS = ['para', 'pass', 'pint', 'lett', 'slet'] as const;
type UnitLevel = (typeof UNIT_LEVELS)[number] | 'arti';

const LEVEL_TAG: Record<UnitLevel, string> = {
  arti: 'art', para: 'par', pass: 'u', pint: 'p', lett: 'l', slet: 'sl',
};

interface UnitNode {
  level: UnitLevel;
  /** The full id attribute, e.g. "arti_1-pint_8" — used to detect cite-box nesting. */
  id: string;
  /** Absolute position of this unit's opening <div> within the full html. */
  pos: number;
  /** The unit's full HTML (opening div … matching close div). */
  html: string;
}

/**
 * True when an id has more than one `arti_` segment, or a structural container
 * segment (chpt_/part_/book_/titl_/bran_) appears after an `arti_` segment. Such
 * units live inside an amendment cite-box and belong to a different act — they
 * must not become their own rows.
 */
function isNestedOrCiteBoxId(id: string): boolean {
  const artiCount = (id.match(/arti_/g) ?? []).length;
  if (artiCount > 1) return true;
  return /arti_[^-]*-(?:chpt|part|book|titl|bran|schp)_/.test(id);
}

/**
 * Find the DIRECT child units of the given level(s) within `html`, using
 * depth-aware <div> matching so we only pick units at the current nesting depth
 * (not grandchildren). Returns them in document order with their full HTML.
 */
function findChildUnits(html: string, levels: readonly string[]): UnitNode[] {
  const levelAlt = levels.join('|');
  // Opening tag of any "unit unit_X" div, capturing the level and the id.
  const openUnit = new RegExp(
    `<div[^>]*class="unit unit_(${levelAlt})\\b[^"]*"[^>]*\\bid="([^"]*)"[^>]*>`,
    'gi',
  );
  // Any div open/close, to track nesting depth between candidate matches.
  const anyDiv = /<div\b[^>]*>|<\/div>/gi;

  const nodes: UnitNode[] = [];
  let m: RegExpExecArray | null;
  openUnit.lastIndex = 0;

  while ((m = openUnit.exec(html)) !== null) {
    const level = m[1].toLowerCase() as UnitLevel;
    const id = m[2];
    const start = m.index;

    // Walk forward counting div depth until this unit's matching </div>.
    anyDiv.lastIndex = openUnit.lastIndex; // first tag after the opening div
    let depth = 1;
    let end = html.length;
    let d: RegExpExecArray | null;
    while ((d = anyDiv.exec(html)) !== null) {
      if (d[0].startsWith('</')) {
        depth--;
        if (depth === 0) { end = d.index + d[0].length; break; }
      } else {
        depth++;
      }
    }

    nodes.push({ level, id, pos: start, html: html.slice(start, end) });
    // Continue scanning AFTER this unit so siblings are found but descendants
    // (already inside [start,end)) are skipped at this level.
    openUnit.lastIndex = end;
  }

  return nodes;
}

/** Read this unit's printed number from its first <h3> heading. */
function unitNumber(unitHtml: string, level: UnitLevel): string {
  // The heading is the first <h3>…</h3> of the unit.
  const h3 = unitHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  const text = stripHtml(h3);
  switch (level) {
    case 'arti': // "Art. 1." / "Art. 20a."
      return text.match(/Art\.?\s*(\d+[a-z]*)/i)?.[1]?.toLowerCase() ?? '';
    case 'para': // "§ 1." / "§ 2a."
      return text.match(/§\s*(\d+[a-z]*)/)?.[1]?.toLowerCase() ?? '';
    case 'pass': // "1." / "2a."
      return text.match(/(\d+[a-z]*)\s*\.?/)?.[1]?.toLowerCase() ?? '';
    case 'pint': // "1)" / "10a)"
      return text.match(/(\d+[a-z]*)\s*\)/)?.[1]?.toLowerCase() ?? '';
    case 'lett': // "a)" / "aa)"
      return text.match(/([a-z]+)\s*\)/i)?.[1]?.toLowerCase() ?? '';
    case 'slet':
      return text.match(/(\d+[a-z]*|[a-z]+)/i)?.[1]?.toLowerCase() ?? '';
  }
}

/** Remove every <h3> heading so unit numbers don't pollute extracted text. */
function stripHeadings(html: string): string {
  return html.replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi, ' ');
}

/** The leading text of a unit, before its first numbered child unit (chapeau). */
function leadingChapeau(unitHtml: string): string {
  // Skip the unit's OWN opening <div>, else its own wrapper is mistaken for the
  // first child and the chapeau comes back empty.
  const inner = innerOf(unitHtml);
  const childAlt = UNIT_LEVELS.join('|');
  const firstChild = inner.search(
    new RegExp(`<div[^>]*class="unit unit_(?:${childAlt})\\b`, 'i'),
  );
  const head = firstChild === -1 ? inner : inner.slice(0, firstChild);
  return stripHtml(stripHeadings(head)).trim();
}

/** Emit a provision row, warning on oversized content and guarding runaway size. */
function emitProvision(
  provisions: ParsedProvision[],
  definitions: ParsedDefinition[],
  act: ActIndexEntry,
  ref: string,
  chapter: string | undefined,
  section: string,
  title: string,
  rawContent: string,
): void {
  let content = rawContent.trim();
  if (content.length < 5) return;

  if (content.length > LARGE_PROVISION_WARN_CHARS) {
    console.warn(
      `[parser] large provision: ${act.id}/${ref} (${content.length} chars)`,
    );
  }
  if (content.length > HARD_LIMIT_CHARS) {
    console.warn(
      `[parser] content truncated at hard limit: ${act.id}/${ref} ` +
      `(${content.length} > ${HARD_LIMIT_CHARS} chars)`,
    );
    content = content.slice(0, HARD_LIMIT_CHARS);
  }

  provisions.push({ provision_ref: ref, chapter, section, title, content });

  if (
    content.includes('ilekro') ||
    content.includes('rozumie si') ||
    content.includes('oznacza') ||
    (content.includes('nale') && content.includes('rozumie'))
  ) {
    extractDefinitions(content, ref, definitions);
  }
}

/** Parse one top-level article: emit its aggregate row + recurse into sub-units. */
function walkArticle(
  node: UnitNode,
  act: ActIndexEntry,
  chapter: string | undefined,
  provisions: ParsedProvision[],
  definitions: ParsedDefinition[],
): void {
  const num = unitNumber(node.html, 'arti') || node.id.match(/arti_(\d+[a-z]*)/i)?.[1] || '';
  if (!num) return;
  const baseRef = `art${num}`;

  // Aggregate row — full recursive text (backward-compatible whole-article view).
  emitProvision(
    provisions, definitions, act, baseRef, chapter, num,
    `Art. ${num}`, stripHtml(stripHeadings(node.html)),
  );

  // Leaf rows — recurse into the article's direct numbered children.
  const children = directChildUnits(node.html);
  if (children.length === 0) return;
  const chapeau = leadingChapeau(node.html);
  for (const child of children) {
    walkUnit(child, baseRef, chapeau ? [chapeau] : [], act, chapter, num, provisions, definitions);
  }
}

/**
 * Strip a unit's OWN outermost opening <div ...> so child-unit search does not
 * rediscover the unit itself (which would recurse forever).
 */
function innerOf(unitHtml: string): string {
  return unitHtml.replace(/^\s*<div\b[^>]*>/i, ' ');
}

/** Direct numbered child units of any sub-level, excluding cite-box nesting. */
function directChildUnits(unitHtml: string): UnitNode[] {
  return findChildUnits(innerOf(unitHtml), UNIT_LEVELS).filter(n => !isNestedOrCiteBoxId(n.id));
}

/** Recurse into a sub-unit: emit a leaf row, or push context down to children. */
function walkUnit(
  node: UnitNode,
  parentRef: string,
  context: string[],
  act: ActIndexEntry,
  chapter: string | undefined,
  section: string,
  provisions: ParsedProvision[],
  definitions: ParsedDefinition[],
): void {
  const num = unitNumber(node.html, node.level);
  if (!num) return;
  const ref = `${parentRef}${LEVEL_TAG[node.level]}${num}`;

  const children = directChildUnits(node.html);
  if (children.length === 0) {
    // Leaf: inherited chapeaus + this unit's own full text (cite-box inline).
    const own = stripHtml(stripHeadings(node.html)).trim();
    const body = [...context, own].filter(Boolean).join(' ');
    emitProvision(
      provisions, definitions, act, ref, chapter, section, refTitle(ref), body,
    );
    return;
  }
  // Internal node: no separate leaf for the chapeau; push it down as context.
  const ownChapeau = leadingChapeau(node.html);
  const nextContext = ownChapeau ? [...context, ownChapeau] : context;
  for (const child of children) {
    walkUnit(child, ref, nextContext, act, chapter, section, provisions, definitions);
  }
}

// Ref tags, longest-first so `art`/`par`/`sl` win over the single-char tags
// during left-to-right tokenisation. Single-char `u`/`p`/`l` are matched last.
const REF_TAGS = ['art', 'par', 'sl', 'u', 'p', 'l'] as const;
const REF_TAG_LABEL: Record<string, string> = {
  art: 'Art.', par: '§', u: 'ust.', p: 'pkt', l: 'lit.', sl: 'podlit.',
};

/**
 * Split a hierarchical ref into [tag, value] tokens, e.g.
 * "art267par1" → [["art","267"],["par","1"]], "art1u2p3la" →
 * [["art","1"],["u","2"],["p","3"],["l","a"]], "art20a" → [["art","20a"]].
 *
 * The tricky case is the optional single-letter numeric suffix (`20a`, `10a`):
 * after the digits we only absorb a trailing letter as part of the number when
 * the remaining string does NOT start with a known tag. This keeps `par`/`u`/`p`
 * from being swallowed into the previous value.
 */
function tokenizeRef(ref: string): Array<[string, string]> {
  const tokens: Array<[string, string]> = [];
  let i = 0;
  while (i < ref.length) {
    const rest = ref.slice(i);
    const tag = REF_TAGS.find(t => rest.startsWith(t));
    if (!tag) break;
    i += tag.length;
    const after = ref.slice(i);
    // litera/podlitera carry a letter value; the rest carry digits (+opt suffix).
    if (tag === 'l' || tag === 'sl') {
      const v = after.match(/^[a-z]+/)?.[0] ?? '';
      tokens.push([tag, v]);
      i += v.length;
    } else {
      const digits = after.match(/^\d+/)?.[0] ?? '';
      let value = digits;
      const tail = after.slice(digits.length);
      // Absorb a single trailing letter only if it does not begin another tag.
      const suffix = tail.match(/^[a-z]/)?.[0];
      if (suffix && !REF_TAGS.some(t => tail.startsWith(t))) {
        value += suffix;
      }
      tokens.push([tag, value]);
      i += value.length;
    }
  }
  return tokens;
}

/** Human-readable title from a hierarchical ref, e.g. art1u2p3la → "Art. 1 ust. 2 pkt 3 lit. a". */
function refTitle(ref: string): string {
  const parts = tokenizeRef(ref).map(([tag, val]) => `${REF_TAG_LABEL[tag]} ${val}`);
  return parts.join(' ') || ref;
}

/**
 * Parse HTML from the Sejm ELI API (api.sejm.gov.pl/eli/acts/DU/YYYY/POZ/text.html)
 * to extract provisions from a Polish statute.
 *
 * The HTML uses div-based structure:
 *   <div class="unit unit_arti" id="chpt_N-arti_M" data-id="arti_M">
 *     <h3><B>Art. M.</B></h3>
 *     <div class="unit-inner">
 *       <div class="unit unit_pass">
 *         <h3>1.</h3>
 *         <div class="unit-inner">
 *           <div data-template="xText">...content...</div>
 *         </div>
 *       </div>
 *     </div>
 *   </div>
 */
export function parsePolishHtml(rawHtml: string, act: ActIndexEntry): ParsedAct {
  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  // Drop the page footer before parsing. The ELI page ends the article body and
  // then appends a navigation block:
  //   <div id="show-all"><button>Pokaż całość</button></div>
  //   <script src="/act.js"></script><script>var tree = [ ... ]</script>
  // The last article's slice runs to html.length, so without this trim it
  // absorbs the "Pokaż całość" button text and the inline `var tree` JSON.
  // Cut at the first footer marker that appears after article content.
  const html = trimActFooter(rawHtml);

  // Enumerate TOP-LEVEL articles only (skip nested arti inside amendment
  // cite-boxes — those are the new wording of a DIFFERENT act and are kept inline
  // in their parent punkt, never promoted to their own rows).
  const articleNodes = findChildUnits(html, ['arti']);

  for (const node of articleNodes) {
    if (isNestedOrCiteBoxId(node.id)) continue;
    const chapter = findChapterHeading(html, node.pos);
    walkArticle(node, act, chapter, provisions, definitions);
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
    definitions,
  };
}

/**
 * Extract definitions from Polish legal text.
 *
 * Polish definitions typically use patterns like:
 *   - "«term» – oznacza ..." ("term" – means ...)
 *   - "N) term – ..." (numbered list of definitions)
 *   - "ilekroć ... mowa o «term» – rozumie się przez to ..."
 */
function extractDefinitions(
  text: string,
  sourceProvision: string,
  definitions: ParsedDefinition[],
): void {
  // Pattern: numbered definitions like "1) term - definition;"
  const numberedDefRegex = /\d+\)\s+([^–\-]+?)\s+[–\-]\s+(.*?)(?=;\s*\d+\)|$)/g;
  let defMatch: RegExpExecArray | null;

  while ((defMatch = numberedDefRegex.exec(text)) !== null) {
    const term = defMatch[1].trim();
    const definition = defMatch[2].replace(/;$/, '').trim();

    if (term.length > 1 && term.length < 100 && definition.length > 5) {
      definitions.push({
        term,
        definition,
        source_provision: sourceProvision,
      });
    }
  }

  // Pattern: «quoted term» – definition
  const quotedDefRegex = /[„«\u201e]([^"»\u201d]+)["\u201d»]\s*[–\-]\s*(.*?)(?=[;.]\s*[„«\u201e]|[;.]\s*$)/g;
  while ((defMatch = quotedDefRegex.exec(text)) !== null) {
    const term = defMatch[1].trim();
    const definition = defMatch[2].replace(/[;.]$/, '').trim();

    if (term.length > 1 && term.length < 100 && definition.length > 5) {
      definitions.push({
        term,
        definition,
        source_provision: sourceProvision,
      });
    }
  }
}

/**
 * Pre-configured list of key Polish Acts to ingest.
 *
 * Source: api.sejm.gov.pl (Sejm ELI API)
 * URL pattern: https://api.sejm.gov.pl/eli/acts/DU/{YEAR}/{POZ}/text.html
 *
 * These are the most important Polish statutes for cybersecurity, data protection,
 * and compliance use cases. References use the Dziennik Ustaw (Journal of Laws)
 * format: Dz.U. YYYY poz. NNNN.
 */
export const KEY_POLISH_ACTS: ActIndexEntry[] = [
  {
    id: 'dpa-2018',
    title: 'Ustawa z dnia 10 maja 2018 r. o ochronie danych osobowych',
    titleEn: 'Personal Data Protection Act 2018',
    shortName: 'UODO 2018',
    status: 'in_force',
    issuedDate: '2018-05-10',
    inForceDate: '2018-05-25',
    dziennikRef: 'Dz.U. 2018 poz. 1000',
    year: 2018,
    poz: 1000,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180001000',
    description: 'GDPR implementing provisions (RODO); establishes UODO (Urząd Ochrony Danych Osobowych) as the supervisory authority; covers certification, codes of conduct, and administrative penalties',
  },
  {
    id: 'ksc-2018',
    title: 'Ustawa z dnia 5 lipca 2018 r. o krajowym systemie cyberbezpieczeństwa',
    titleEn: 'National Cybersecurity System Act 2018 (KSC)',
    shortName: 'KSC',
    status: 'in_force',
    issuedDate: '2018-07-05',
    inForceDate: '2018-08-28',
    dziennikRef: 'Dz.U. 2018 poz. 1560',
    year: 2018,
    poz: 1560,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180001560',
    description: 'NIS Directive implementation; establishes national cybersecurity system with CSIRT teams (CSIRT NASK, CSIRT GOV, CSIRT MON); covers essential services operators and digital service providers',
  },
  {
    id: 'ksh-2000',
    title: 'Ustawa z dnia 15 września 2000 r. - Kodeks spółek handlowych',
    titleEn: 'Commercial Companies Code (KSH)',
    shortName: 'KSH',
    status: 'in_force',
    issuedDate: '2000-09-15',
    inForceDate: '2001-01-01',
    dziennikRef: 'Dz.U. 2000 nr 94 poz. 1037',
    year: 2000,
    poz: 1037,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20000940037',
    description: 'Comprehensive commercial companies law governing partnerships (spółka jawna, komandytowa, etc.) and capital companies (sp. z o.o. and S.A.); corporate governance requirements',
  },
  {
    id: 'kodeks-karny-1997',
    title: 'Ustawa z dnia 6 czerwca 1997 r. - Kodeks karny',
    titleEn: 'Criminal Code (Kodeks karny)',
    shortName: 'KK',
    status: 'in_force',
    issuedDate: '1997-06-06',
    inForceDate: '1998-09-01',
    dziennikRef: 'Dz.U. 1997 nr 88 poz. 553',
    year: 1997,
    poz: 553,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19970880553',
    description: 'Criminal Code; cybercrime provisions in Art. 267 (unauthorized access), Art. 268 (data destruction), Art. 268a (computer sabotage), Art. 269 (sabotage of critical systems), Art. 269a (DoS), Art. 269b (hacking tools)',
  },
  {
    id: 'e-services-2002',
    title: 'Ustawa z dnia 18 lipca 2002 r. o świadczeniu usług drogą elektroniczną',
    titleEn: 'Act on Provision of Electronic Services',
    shortName: 'E-Services Act',
    status: 'in_force',
    issuedDate: '2002-07-18',
    inForceDate: '2002-10-10',
    dziennikRef: 'Dz.U. 2002 nr 144 poz. 1204',
    year: 2002,
    poz: 1204,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20021441204',
    description: 'E-Commerce Directive implementation; regulates electronic services, ISP liability, spam prohibition, electronic contracts',
  },
  {
    id: 'telecom-2004',
    title: 'Ustawa z dnia 16 lipca 2004 r. - Prawo telekomunikacyjne',
    titleEn: 'Telecommunications Law',
    shortName: 'PT',
    status: 'in_force',
    issuedDate: '2004-07-16',
    inForceDate: '2004-09-03',
    dziennikRef: 'Dz.U. 2004 nr 171 poz. 1800',
    year: 2004,
    poz: 1800,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20041711800',
    description: 'Telecommunications regulation; data retention, communications security, network integrity obligations, UKE (Office of Electronic Communications) authority',
  },
  {
    id: 'constitution-1997',
    title: 'Konstytucja Rzeczypospolitej Polskiej z dnia 2 kwietnia 1997 r.',
    titleEn: 'Constitution of the Republic of Poland',
    shortName: 'Konstytucja RP',
    status: 'in_force',
    issuedDate: '1997-04-02',
    inForceDate: '1997-10-17',
    dziennikRef: 'Dz.U. 1997 nr 78 poz. 483',
    year: 1997,
    poz: 483,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19970780483',
    description: 'Supreme law; Art. 47 (privacy), Art. 49 (communication secrecy), Art. 51 (personal data protection), Art. 54 (freedom of expression)',
  },
  {
    id: 'kodeks-cywilny-1964',
    title: 'Ustawa z dnia 23 kwietnia 1964 r. - Kodeks cywilny',
    titleEn: 'Civil Code (Kodeks cywilny)',
    shortName: 'KC',
    status: 'in_force',
    issuedDate: '1964-04-23',
    inForceDate: '1965-01-01',
    dziennikRef: 'Dz.U. 1964 nr 16 poz. 93',
    year: 1964,
    poz: 93,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19640160093',
    description: 'Core private law; personality rights protection (Art. 23-24), contract law, liability for damages, electronic declarations of intent',
  },
  {
    id: 'banking-law-1997',
    title: 'Ustawa z dnia 29 sierpnia 1997 r. - Prawo bankowe',
    titleEn: 'Banking Law',
    shortName: 'PB',
    status: 'in_force',
    issuedDate: '1997-08-29',
    inForceDate: '1998-01-01',
    dziennikRef: 'Dz.U. 1997 nr 140 poz. 939',
    year: 1997,
    poz: 939,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19971400939',
    description: 'Banking regulation; banking secrecy obligations, outsourcing of banking activities, IT security requirements for banks, cloud computing provisions',
  },
  {
    id: 'kpa-1960',
    title: 'Ustawa z dnia 14 czerwca 1960 r. - Kodeks postępowania administracyjnego',
    titleEn: 'Code of Administrative Procedure (KPA)',
    shortName: 'KPA',
    status: 'in_force',
    issuedDate: '1960-06-14',
    inForceDate: '1961-01-01',
    dziennikRef: 'Dz.U. 1960 nr 30 poz. 168',
    year: 1960,
    poz: 168,
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19600300168',
    description: 'Administrative procedure code; governs proceedings before UODO (data protection authority), UKE, and other regulators; electronic administration provisions',
  },
];

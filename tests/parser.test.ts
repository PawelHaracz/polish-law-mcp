import { describe, it, expect, vi } from 'vitest';
import { parsePolishHtml, type ActIndexEntry } from '../scripts/lib/parser.js';

const ACT: ActIndexEntry = {
  id: 'pl-du-test-1',
  title: 'Ustawa testowa',
  titleEn: '',
  shortName: 'test',
  status: 'in_force',
  issuedDate: '',
  inForceDate: '',
  dziennikRef: '',
  year: 2024,
  poz: 1,
  url: '',
};

/**
 * Reproduces the ELI page shape that leaked into provisions: an article body
 * followed by the "Pokaż całość" footer and an inline `var tree = [...]` script.
 */
function htmlWithFooter(articleBody: string): string {
  // Real ELI headings use &nbsp; between "Art." and the number: "Art.&nbsp;1."
  return `
<div class="unit unit_arti" id="chpt_1-arti_1" data-id="arti_1">
  <h3><B>Art.&nbsp;1.</B></h3>
  <div class="unit-inner">${articleBody}</div>
</div>
<div id="show-all" class="show-all hidden"><button id="show-all-button">Pokaż całość</button></div>
<script src="/act.js"></script>
<script>
var tree = [
  { "id": "part_1", "title": "Treść ustawy", "type": "part", "symbol": "part_1",
    "children": [ { "id": "arti_1", "type": "arti", "name": "1", "title": "Art. 1." } ] }
];
</script>
`;
}

describe('parsePolishHtml — footer / var tree leak (P1)', () => {
  it('does not leak the navigation tree JSON into the last article', () => {
    const parsed = parsePolishHtml(
      htmlWithFooter('Wykonanie niniejszej ustawy porucza się Ministrowi.'),
      ACT,
    );
    expect(parsed.provisions).toHaveLength(1);
    const content = parsed.provisions[0].content;
    expect(content).toBe('Wykonanie niniejszej ustawy porucza się Ministrowi.');
    // None of the footer fingerprints survive.
    expect(content).not.toMatch(/var tree/);
    expect(content).not.toMatch(/"type":\s*"arti"/);
    expect(content).not.toMatch(/"symbol":/);
    expect(content).not.toMatch(/Poka[zż]\s+ca/);
  });

  it('strips <script> bodies even when no show-all marker is present', () => {
    const html = `
<div class="unit unit_arti" id="chpt_1-arti_1" data-id="arti_1">
  <h3><B>Art.&nbsp;1.</B></h3>
  <div class="unit-inner">Treść przepisu.<script>var tree = [{"type":"arti"}];</script></div>
</div>`;
    const parsed = parsePolishHtml(html, ACT);
    expect(parsed.provisions[0].content).toBe('Treść przepisu.');
  });
});

describe('parsePolishHtml — no silent truncation (P2)', () => {
  it('keeps genuinely long provisions intact (well above the old 12K cap)', () => {
    const longBody = 'A. ' + 'słowo '.repeat(5000); // ~30K chars of real text
    const parsed = parsePolishHtml(htmlWithFooter(longBody), ACT);
    expect(parsed.provisions[0].content.length).toBeGreaterThan(12000);
  });

  it('warns on large provisions but does NOT truncate them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hugeBody = 'x'.repeat(60000); // > LARGE_PROVISION_WARN_CHARS (50000)
    const parsed = parsePolishHtml(htmlWithFooter(hugeBody), ACT);
    // Full text is preserved — a legal MCP must not drop statutory text.
    expect(parsed.provisions[0].content.length).toBeGreaterThanOrEqual(60000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('large provision: pl-du-test-1/art1'),
    );
    warn.mockRestore();
  });
});

/**
 * Builds an article with nested ustęp/punkt/litera so we can assert the
 * hierarchical ref scheme and chapeau prefixing.
 */
function htmlWithHierarchy(): string {
  return `
<div class="unit unit_arti pro-text false" id="arti_2" data-id="arti_2">
  <h3><B>Art.&nbsp;2.</B></h3>
  <div class="unit-inner">
    <div data-template="xText" class="pro-text">Ilekroć w ustawie mowa o:</div>
    <div class="unit unit_pint pro-text false" id="arti_2-pint_1" data-id="pint_1">
      <h3 class="pro-align-padding-right">1)</h3>
      <div class="unit-inner">
        <div data-template="xText" class="pro-text">rejestrze — rozumie się rejestr przedsiębiorców;</div>
      </div>
    </div>
    <div class="unit unit_pint pro-text false" id="arti_2-pint_2" data-id="pint_2">
      <h3 class="pro-align-padding-right">2)</h3>
      <div class="unit-inner">
        <div data-template="xText" class="pro-text">organie — rozumie się:</div>
        <div class="unit unit_lett pro-text false" id="arti_2-pint_2-lett_a" data-id="lett_a">
          <h3 class="pro-align-padding-right">a)</h3>
          <div class="unit-inner"><div data-template="xText" class="pro-text">ministra właściwego do spraw gospodarki,</div></div>
        </div>
        <div class="unit unit_lett pro-text false" id="arti_2-pint_2-lett_b" data-id="lett_b">
          <h3 class="pro-align-padding-right">b)</h3>
          <div class="unit-inner"><div data-template="xText" class="pro-text">Prezesa Urzędu.</div></div>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

describe('parsePolishHtml — hierarchical chunking (P3)', () => {
  it('emits an article aggregate plus one leaf row per ustęp/punkt/litera', () => {
    const parsed = parsePolishHtml(htmlWithHierarchy(), ACT);
    const refs = parsed.provisions.map(p => p.provision_ref);
    expect(refs).toContain('art2');          // aggregate (backward compat)
    expect(refs).toContain('art2p1');        // punkt 1 (leaf)
    expect(refs).toContain('art2p2la');      // punkt 2 litera a (leaf)
    expect(refs).toContain('art2p2lb');      // punkt 2 litera b (leaf)
    // The chapeau "organie — rozumie się:" is an internal node, not its own leaf.
    expect(refs).not.toContain('art2p2');
  });

  it('aggregate row holds the full article text; leaves carry chapeau context', () => {
    const parsed = parsePolishHtml(htmlWithHierarchy(), ACT);
    const agg = parsed.provisions.find(p => p.provision_ref === 'art2')!;
    expect(agg.content).toContain('rejestr przedsiębiorców');
    expect(agg.content).toContain('Prezesa Urzędu');
    // Leaf litera a inherits both chapeaus for self-contained context.
    const leaf = parsed.provisions.find(p => p.provision_ref === 'art2p2la')!;
    expect(leaf.content).toContain('Ilekroć w ustawie mowa o:');
    expect(leaf.content).toContain('organie — rozumie się:');
    expect(leaf.content).toContain('ministra właściwego do spraw gospodarki');
  });

  it('gives leaves a lawyer-readable title', () => {
    const parsed = parsePolishHtml(htmlWithHierarchy(), ACT);
    const leaf = parsed.provisions.find(p => p.provision_ref === 'art2p2la')!;
    expect(leaf.title).toBe('Art. 2 pkt 2 lit. a');
  });
});

/** An amending article whose punkt rewrites a target act's article via a cite-box. */
function htmlWithCiteBox(): string {
  return `
<div class="unit unit_arti pro-text false" id="arti_1" data-id="arti_1">
  <h3><B>Art.&nbsp;1.</B></h3>
  <div class="unit-inner">
    <div data-template="xText" class="pro-text">W ustawie - Kodeks pracy<span class="xHidden">(Dz. U. Nr 24, poz. 141, z 1975 r. Nr 16, poz. 91)</span> wprowadza się następujące zmiany:</div>
    <div class="unit unit_pint pro-text false" id="arti_1-pint_1" data-id="pint_1">
      <h3 class="pro-align-padding-right">1)</h3>
      <div class="unit-inner">
        <div data-template="xText" class="pro-text">art. 18 otrzymuje brzmienie:</div>
        <div class="cite-box pro-rplc-text"><div class="cite-body">
          <div class="unit unit_arti pro-rplc-text false" id="arti_1-pint_1-arti_18" data-id="arti_18">
            <h3 class="pro-padding-right">Art.&nbsp;18.</h3>
            <div class="unit-inner"><div data-template="xText" class="pro-rplc-text">Pracownik ma prawo do godziwego wynagrodzenia.</div></div>
          </div>
        </div></div>
      </div>
    </div>
  </div>
</div>`;
}

describe('parsePolishHtml — amendment cite-box handling (P3)', () => {
  it('keeps replacement text inline and does NOT promote nested foreign articles', () => {
    const parsed = parsePolishHtml(htmlWithCiteBox(), ACT);
    const refs = parsed.provisions.map(p => p.provision_ref);
    expect(refs).toContain('art1');     // amending act's own article
    expect(refs).toContain('art1p1');   // the punkt that does the amending
    // The cite-box's nested Art. 18 belongs to a DIFFERENT act — never its own row.
    expect(refs).not.toContain('art18');
    // …but its new wording IS preserved inline in the punkt.
    const pint = parsed.provisions.find(p => p.provision_ref === 'art1p1')!;
    expect(pint.content).toContain('art. 18 otrzymuje brzmienie');
    expect(pint.content).toContain('Pracownik ma prawo do godziwego wynagrodzenia');
  });

  it('strips xHidden Dz.U. citation chrome from content', () => {
    const parsed = parsePolishHtml(htmlWithCiteBox(), ACT);
    const agg = parsed.provisions.find(p => p.provision_ref === 'art1')!;
    expect(agg.content).not.toContain('poz. 141');
    expect(agg.content).toContain('wprowadza się następujące zmiany');
  });
});

/** An amending punkt whose cite-box starts below article level ("ust. 2 otrzymuje brzmienie"). */
function htmlWithUstCiteBox(): string {
  return `
<div class="unit unit_arti pro-text false" id="arti_1" data-id="arti_1">
  <h3><B>Art.&nbsp;1.</B></h3>
  <div class="unit-inner">
    <div data-template="xText" class="pro-text">W ustawie - Prawo bankowe wprowadza się następujące zmiany:</div>
    <div class="unit unit_pint pro-text false" id="arti_1-pint_4" data-id="pint_4">
      <h3 class="pro-align-padding-right">4)</h3>
      <div class="unit-inner">
        <div data-template="xText" class="pro-text">w art. 25 ust. 1 i 2 otrzymują brzmienie:</div>
        <DIV CLASS="cite-box pro-cite-text"><div class="cite-body">
          <div class="unit unit_pass pro-cite-text false" id="arti_1-pint_4-pass_1" data-id="pass_1">
            <h3>1.</h3><div class="unit-inner"><div data-template="xText" class="pro-cite-text">Bank tworzy fundusz.</div></div>
          </div>
          <div class="unit unit_pass pro-cite-text false" id="arti_1-pint_4-pass_2" data-id="pass_2">
            <h3>2.</h3><div class="unit-inner"><div data-template="xText" class="pro-cite-text">Fundusz jest jawny.</div></div>
          </div>
        </div></DIV>
      </div>
    </div>
  </div>
</div>`;
}

/**
 * A consolidated text: the obwieszczenie quotes, in a cite-box, an amending act's
 * art. 29 that the jednolity tekst does not cover; the act itself (załącznik)
 * follows with its own art. 29.
 */
function htmlObwieszczenie(heading = 'Obwieszczenie Marszałka Sejmu z dnia 21 czerwca 2024 r. w sprawie ogłoszenia jednolitego tekstu ustawy - Prawo o ruchu drogowym'): string {
  return `
<h1>${heading}</h1>
<div class="unit unit_pass pro-text false" id="pass_2" data-id="pass_2" data-bookmark="_001_2">
  <h3>2.</h3>
  <div class="unit-inner">
    <div data-template="xText" class="pro-text">Podany w załączniku tekst jednolity ustawy nie obejmuje:</div>
    <div class="unit unit_pint pro-text false" id="pass_2-pint_1" data-id="pint_1" data-bookmark="_001_2_1">
      <h3>1)</h3>
      <div class="unit-inner">
        <div data-template="xText" class="pro-text">art. 29 ustawy z dnia 14 sierpnia 2020 r., który stanowi:</div>
        <DIV CLASS="cite-box pro-cite-text"><DIV class="cite-body">
          <div class="unit unit_arti pro-cite-text false" id="pass_2-pint_1-arti_29" data-id="arti_29">
            <h3>Art.&nbsp;29.</h3>
            <div class="unit-inner"><div data-template="xText" class="pro-cite-text">Ustawa wchodzi w życie po upływie 3 miesięcy od dnia ogłoszenia.</div></div>
          </div>
        </DIV></DIV>
      </div>
    </div>
  </div>
</div>
<div class="unit unit_bran pro-text with-title" id="bran_I" data-id="bran_I" data-bookmark="_002_z1_a1">
  <div class="unit-inner">
    <div class="unit unit_arti pro-text false" id="bran_I-arti_29" data-id="arti_29" data-bookmark="_002_z1_a1_29">
      <h3>Art.&nbsp;29.</h3>
      <div class="unit-inner"><div data-template="xText" class="pro-text">Kierujący pojazdem może używać sygnału dźwiękowego.</div></div>
    </div>
  </div>
</div>`;
}

describe('parsePolishHtml — quoted wording never becomes rows of the act', () => {
  it('keeps an amendment\'s quoted ustępy inline in the punkt', () => {
    const parsed = parsePolishHtml(htmlWithUstCiteBox(), ACT);
    const refs = parsed.provisions.map(p => p.provision_ref);
    expect(refs).toEqual(['art1', 'art1p4']);
    const pint = parsed.provisions.find(p => p.provision_ref === 'art1p4')!;
    expect(pint.content).toContain('Bank tworzy fundusz.');
    expect(pint.content).toContain('Fundusz jest jawny.');
  });

  it('skips the obwieszczenie of a jednolity tekst, so its quotes cannot shadow the act', () => {
    const parsed = parsePolishHtml(htmlObwieszczenie(), ACT);
    const arts = parsed.provisions.filter(p => p.provision_ref === 'art29');
    expect(arts).toHaveLength(1);
    expect(arts[0].content).toContain('sygnału dźwiękowego');
  });

  it('keeps a plain act whose own załącznik is bookmarked _002_z1_', () => {
    const parsed = parsePolishHtml(htmlObwieszczenie('Ustawa z dnia 4 lutego 1921 r. o ustanowieniu orderu'), ACT);
    expect(parsed.provisions.filter(p => p.provision_ref === 'art29')).toHaveLength(2);
  });
});

/** A rozporządzenie: § is the primary unit (no Art.), with punkty inside. */
function htmlRegulation(): string {
  return `
<div class="unit unit_para pro-text false" id="para_1" data-id="para_1">
  <h3><B>§&nbsp;1.</B></h3>
  <div class="unit-inner">
    <div data-template="xText" class="pro-text">Rozporządzenie określa:</div>
    <div class="unit unit_pint pro-text false" id="para_1-pint_1" data-id="pint_1">
      <h3 class="pro-align-padding-right">1)</h3>
      <div class="unit-inner"><div data-template="xText" class="pro-text">tryb przyznawania świadczeń;</div></div>
    </div>
    <div class="unit unit_pint pro-text false" id="para_1-pint_2" data-id="pint_2">
      <h3 class="pro-align-padding-right">2)</h3>
      <div class="unit-inner"><div data-template="xText" class="pro-text">wysokość zasiłku.</div></div>
    </div>
  </div>
</div>`;
}

describe('parsePolishHtml — rozporządzenie (§ as top-level unit)', () => {
  it('parses § units when the act has no articles', () => {
    const parsed = parsePolishHtml(htmlRegulation(), ACT);
    const refs = parsed.provisions.map(p => p.provision_ref);
    expect(refs).toContain('par1');      // top-level § (not art1par1)
    expect(refs).toContain('par1p1');    // § 1 pkt 1
    expect(refs).toContain('par1p2');
    const leaf = parsed.provisions.find(p => p.provision_ref === 'par1p1')!;
    expect(leaf.title).toBe('§ 1 pkt 1');
    expect(leaf.content).toContain('tryb przyznawania świadczeń');
  });
});

/** ELI prints superscript unit numbers with <SUP>: "Art.&nbsp;300<SUP>1</SUP>." is art. 300¹. */
function htmlWithSuperscripts(): string {
  return `
<div class="unit unit_arti" id="chpt_1-arti_300" data-id="arti_300">
  <h3><B>Art.&nbsp;300.</B></h3>
  <div class="unit-inner"><div data-template="xText" class="pro-text">Przepisy art. 291-299 nie naruszają praw.</div></div>
</div>
<div class="unit unit_arti" id="chpt_1-arti_300_1" data-id="arti_300_1">
  <h3><B>Art.&nbsp;300<SUP>1</SUP>.</B><A class="gloss-link tooltip" href="#gloss-0:2:"><sup>2)</sup><span class="tooltip-text"><span class="pro-gloss-inner">Dodany przez art. 1 pkt 3 ustawy.</span></span></A></h3>
  <div class="unit-inner">
    <div class="unit unit_para" id="chpt_1-arti_300_1-para_1" data-id="para_1">
      <h3>§&nbsp;1.</h3>
      <div class="unit-inner"><div data-template="xText" class="pro-text">Prosta spółka akcyjna może być utworzona w każdym celu.</div></div>
    </div>
    <div class="unit unit_para" id="chpt_1-arti_300_1-para_1_1" data-id="para_1_1">
      <h3>§&nbsp;1<SUP>1</SUP>.</h3>
      <div class="unit-inner"><div data-template="xText" class="pro-text">Zob. art. 300<SUP>75</SUP> § 2.</div></div>
    </div>
  </div>
</div>
<div class="unit unit_arti" id="chpt_1-arti_3001" data-id="arti_3001">
  <h3><B>Art.&nbsp;3001.</B></h3>
  <div class="unit-inner"><div data-template="xText" class="pro-text">Prawdziwy artykuł 3001.</div></div>
</div>`;
}

describe('parsePolishHtml — superscript unit numbers', () => {
  const p = parsePolishHtml(htmlWithSuperscripts(), ACT).provisions;
  const byRef = (r: string) => p.filter(x => x.provision_ref === r);

  it('gives art. 300¹ its own ^ ref instead of a duplicate art300', () => {
    expect(byRef('art300')).toHaveLength(1);
    expect(byRef('art300^1')).toHaveLength(1);
    expect(byRef('art300^1')[0]!.title).toBe('Art. 300¹');
    expect(byRef('art300^1')[0]!.section).toBe('300^1');
    expect(byRef('art3001')[0]!.content).toBe('Prawdziwy artykuł 3001.');
  });

  it('carries superscripts into sub-unit refs and titles', () => {
    expect(byRef('art300^1par1^1')[0]!.title).toBe('Art. 300¹ § 1¹');
    expect(byRef('art300^1par1')).toHaveLength(1);
  });

  it('renders superscripts in text as real superscripts, not "300 75"', () => {
    expect(byRef('art300^1par1^1')[0]!.content).toContain('art. 300⁷⁵ § 2');
  });
});

describe('parsePolishHtml — footnote tooltips', () => {
  it('drops gloss-link footnotes (with nested links) from provision text', () => {
    const html = `
<div class="unit unit_arti" id="chpt_1-arti_4" data-id="arti_4">
  <h3><B>Art.&nbsp;4.</B></h3>
  <div class="unit-inner"><div data-template="xText" class="pro-text">W ustawie o podatku akcyzowym (Dz. U. poz. 2538, z późn. zm.<A class="gloss-link tooltip" href="#gloss-0:5:"><sup>5)</sup><span class="tooltip-text"><span class="pro-gloss-inner">Zmiany wymienionej ustawy zostały ogłoszone w <A CLASS="pro-lexlink" HREF="https://api.sejm.gov.pl/eli/acts/DU/2019/412/text.html">Dz. U. z 2019 r. poz. 412</A> i 1210.</span></span></A>) wprowadza się zmiany.</div></div>
</div>`;
    const p = parsePolishHtml(html, ACT);
    const art = p.provisions.find(x => x.provision_ref === 'art4')!;
    expect(art.content).toBe('W ustawie o podatku akcyzowym (Dz. U. poz. 2538, z późn. zm.) wprowadza się zmiany.');
    expect(p.footnotes).toEqual(['Zmiany wymienionej ustawy zostały ogłoszone w Dz. U. z 2019 r. poz. 412 i 1210.']);
    // The footnote's act link still feeds the citation graph.
    expect((p.references ?? []).length).toBeGreaterThan(0);
  });
});

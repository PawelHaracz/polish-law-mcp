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

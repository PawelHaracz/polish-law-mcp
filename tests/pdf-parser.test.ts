import { describe, it, expect } from 'vitest';
import { parsePolishPdf } from '../scripts/lib/pdf-parser.js';
import type { ActIndexEntry } from '../scripts/lib/parser.js';

const ACT: ActIndexEntry = {
  id: 'pl-du-test-pdf', title: 'Ustawa testowa PDF', titleEn: '', shortName: 'test',
  status: 'in_force', issuedDate: '', inForceDate: '', dziennikRef: '', year: 2024, poz: 1, url: '',
};

/** Mimics pdftotext output: article markers, ustępy, and Kancelaria page chrome. */
const SAMPLE = `©Kancelaria Sejmu
s. 1/3
2015-01-07

Art. 1. Rzeczpospolita Polska jest dobrem wspólnym wszystkich obywateli.
Art. 4. 1. Władza zwierzchnia należy do Narodu.
2. Naród sprawuje władzę przez swoich przedstawicieli.
©Kancelaria Sejmu
s. 2/3
Art. 25. 1. Kościoły i inne związki wyznaniowe są równouprawnione.
2. Władze publiczne zachowują bezstronność.`;

describe('parsePolishPdf', () => {
  it('extracts articles and ustęp leaves from PDF text', () => {
    const p = parsePolishPdf(SAMPLE, ACT);
    const refs = p.provisions.map(x => x.provision_ref);
    expect(refs).toContain('art1');
    expect(refs).toContain('art4');
    expect(refs).toContain('art4u1');
    expect(refs).toContain('art4u2');
    expect(refs).toContain('art25u1');
    expect(refs).toContain('art25u2');
  });

  it('strips Kancelaria Sejmu page chrome from content', () => {
    const p = parsePolishPdf(SAMPLE, ACT);
    for (const pr of p.provisions) {
      expect(pr.content).not.toMatch(/Kancelaria Sejmu/);
      expect(pr.content).not.toMatch(/s\. \d+\/\d+/);
      expect(pr.content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('gives ustęp leaves the correct content and title', () => {
    const p = parsePolishPdf(SAMPLE, ACT);
    const u1 = p.provisions.find(x => x.provision_ref === 'art4u1')!;
    expect(u1.content).toContain('Władza zwierzchnia należy do Narodu');
    expect(u1.title).toBe('Art. 4 ust. 1');
  });

  it('quality gate: returns no provisions for unusable OCR (text, no articles)', () => {
    const garbage = 'x'.repeat(20000); // 20 KB of text, zero article markers
    const p = parsePolishPdf(garbage, ACT);
    expect(p.provisions).toHaveLength(0);
  });

  it('tolerates common pre-war OCR confusion of "Art" (Rrt)', () => {
    const ocr = 'Rrt. 1. Ustęp pierwszy stanowi co następuje.\nRrt. 2. Przepis drugi.';
    const p = parsePolishPdf(ocr, ACT);
    expect(p.provisions.map(x => x.provision_ref)).toEqual(
      expect.arrayContaining(['art1', 'art2']),
    );
  });
});

/** Rozporządzenia use § as the top-level unit — no "Art." markers at all. */
const REG_SAMPLE = `ROZPORZĄDZENIE MINISTRA EDUKACJI
z dnia 4 marca 2026 r.
w sprawie testowej
Na podstawie art. 12 ust. 3 ustawy z dnia 1 stycznia 2020 r. zarządza się, co następuje:
§ 1. Rozporządzenie określa:
1) warunki przyznawania akredytacji;
2) tryb odmowy.
§ 2. 1. Wniosek składa się do kuratora oświaty.
2. Do wniosku dołącza się dokumenty.
§ 3. Rozporządzenie wchodzi w życie z dniem 1 kwietnia 2026 r.`;

describe('parsePolishPdf — regulations (§ top-level)', () => {
  it('splits on top-level § when the act has no articles', () => {
    const p = parsePolishPdf(REG_SAMPLE, { ...ACT, title: 'Rozporządzenie testowe' });
    const refs = p.provisions.map(x => x.provision_ref);
    expect(refs).toEqual(expect.arrayContaining(['par1', 'par1p1', 'par1p2', 'par2', 'par2u1', 'par2u2', 'par3']));
    expect(refs.some(r => r.startsWith('art'))).toBe(false);
    const par2 = p.provisions.find(x => x.provision_ref === 'par2')!;
    expect(par2.title).toBe('§ 2');
    expect(p.provisions.find(x => x.provision_ref === 'par2u2')!.title).toBe('§ 2 ust. 2');
  });

  it('keeps Art. mode for statutes that quote § inside articles', () => {
    const refs = parsePolishPdf(SAMPLE, ACT).provisions.map(x => x.provision_ref);
    expect(refs.some(r => r.startsWith('par'))).toBe(false);
  });

  it('does not reject regulations whose annex dwarfs the §§', () => {
    const annex = '\nZałącznik nr 1\n' + 'Pozycja klasyfikacji wyrobów i usług. '.repeat(2000);
    const p = parsePolishPdf(REG_SAMPLE + annex, { ...ACT, title: 'Rozporządzenie testowe' });
    expect(p.provisions.map(x => x.provision_ref)).toContain('par3');
  });

  it('keeps Art. mode for codes whose §§ start more lines than articles do', () => {
    const code = `Art. 30. § 1. Umowa o pracę rozwiązuje się:
1) na mocy porozumienia stron;
2) przez oświadczenie jednej ze stron.
§ 2. Umowa o pracę na okres próbny rozwiązuje się z upływem czasu.
§ 3. Oświadczenie każdej ze stron powinno nastąpić na piśmie.
§ 4. W oświadczeniu pracodawcy należy wskazać przyczynę.
Art. 31. § 1. Za pracodawcę czynności dokonuje osoba wyznaczona.
§ 2. Przepis stosuje się odpowiednio.
§ 3. Inny przepis.`;
    const refs = parsePolishPdf(code, ACT).provisions.map(x => x.provision_ref);
    expect(refs).toEqual(expect.arrayContaining(['art30', 'art30par2', 'art31', 'art31par3']));
    expect(refs).not.toContain('par2');
  });

  it('stops at the annex heading instead of gluing the annex onto the last §', () => {
    const withAnnex = REG_SAMPLE + `
Minister Edukacji: B. Nowacka
Załącznik do rozporządzenia Ministra Edukacji z dnia 4 marca 2026 r.
1. Sekcja A – Produkty rolnictwa.
2. Sekcja B – Górnictwo.`;
    const p = parsePolishPdf(withAnnex, { ...ACT, title: 'Rozporządzenie testowe' });
    const refs = p.provisions.map(x => x.provision_ref);
    expect(refs.filter(r => r.startsWith('par3'))).toEqual(['par3']);
    expect(p.provisions.find(x => x.provision_ref === 'par3')!.content).not.toMatch(/Sekcja/);
    // The annex is kept as its own unsplit row, not dropped.
    const zal = p.provisions.filter(x => x.provision_ref.startsWith('zal'));
    expect(zal.map(x => x.provision_ref)).toEqual(['zal1']);
    expect(zal[0]!.title).toMatch(/^Załącznik do rozporządzenia/);
    expect(zal[0]!.content).toMatch(/Sekcja A.*Sekcja B/);
  });

  it('does not stop at the obwieszczenie annex that carries a consolidated text', () => {
    const tj = `Załącznik do obwieszczenia Marszałka Sejmu Rzeczypospolitej Polskiej
Art. 1. Ustawa określa zasady.
Art. 2. 1. Pierwszy ustęp.
2. Drugi ustęp.`;
    const refs = parsePolishPdf(tj, ACT).provisions.map(x => x.provision_ref);
    expect(refs).toEqual(expect.arrayContaining(['art1', 'art2', 'art2u2']));
  });
});

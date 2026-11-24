import { describe, it, expect } from 'vitest';
import { parsePolishPdf, supify } from '../scripts/lib/pdf-parser.js';
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

/** pdftotext prints superscript unit numbers as brackets: "Art. 11[1]." is art. 11¹. */
const SUP_SAMPLE = `Poz. 1245
Art. 11. Nawiązanie stosunku pracy wymaga zgodnego oświadczenia woli.
Art. 11[1]. Pracodawca jest obowiązany szanować godność pracownika.
–6–
Poz. 1245
Art. 30. § 1. Umowa o pracę rozwiązuje się:
1) na mocy porozumienia stron;
2) przez oświadczenie jednej ze stron.
§ 2. Umowa na okres próbny rozwiązuje się z upływem tego okresu.
§ 2[1]. Okres wypowiedzenia kończy się w sobotę, zob. art. 11[1].
§ 3. Oświadczenie powinno nastąpić na piśmie.
Art. 111. Przepis o innej treści.`;

describe('parsePolishPdf — superscript units and page headers', () => {
  const p = parsePolishPdf(SUP_SAMPLE, ACT);
  const byRef = (r: string) => p.provisions.find(x => x.provision_ref === r);

  it('gives Art. 11[1] its own row instead of gluing it onto art. 11', () => {
    expect(byRef('art11^1')?.title).toBe('Art. 11¹');
    expect(byRef('art11^1')?.section).toBe('11^1');
    expect(byRef('art11^1')?.content).toMatch(/^Pracodawca jest obowiązany/);
    expect(byRef('art11')?.content).not.toMatch(/Pracodawca/);
  });

  it('keeps the real art. 111 distinct from art. 11¹', () => {
    expect(byRef('art111')?.content).toBe('Przepis o innej treści.');
  });

  it('splits § 2[1] inside an article as its own sibling paragraf', () => {
    const refs = p.provisions.map(x => x.provision_ref).filter(r => r.startsWith('art30'));
    expect(refs).toEqual(['art30', 'art30par1p1', 'art30par1p2', 'art30par2', 'art30par2^1', 'art30par3']);
    expect(byRef('art30par2^1')?.title).toBe('Art. 30 § 2¹');
    expect(byRef('art30par2')?.content).not.toMatch(/sobotę/);
  });

  it('renders bracketed superscripts in text as real superscripts', () => {
    expect(byRef('art30par2^1')?.content).toContain('zob. art. 11¹.');
    expect(byRef('art30')?.content).toContain('§ 2¹. Okres');
  });

  it('drops the "Poz. N" Dziennik Ustaw page header', () => {
    for (const pr of p.provisions) expect(pr.content).not.toMatch(/Poz\. 1245/);
  });
});

describe('supify', () => {
  it('converts superscripts after unit numbers', () => {
    expect(supify('art. 22[1] § 2[1] pkt 3[2a] i 22[1]–22[3]')).toBe('art. 22¹ § 2¹ pkt 3²ᵃ i 22¹–22³');
  });

  it('leaves standard references and ASN.1 tags alone', () => {
    for (const s of ['ETSI EN 302 818 V3.5.1:2023-12[5]', 'IEC 62106-2:2021[11]', 'message [1] UTF8String']) {
      expect(supify(s)).toBe(s);
    }
  });
});

describe('parsePolishPdf — article with punkty but no ustępy', () => {
  it('emits art2p1… like the HTML parser, and a "Poz. N" header does not fake an ustęp', () => {
    const text = `Art. 2. W rozumieniu ustawy:
1) statkiem jest urządzenie latające;
2) lotniskiem jest obszar, o którym mowa w odnośniku 3.
Poz. 1407
3) lądowiskiem jest obszar na lądzie.`;
    const refs = parsePolishPdf(text, ACT).provisions.map(x => x.provision_ref);
    expect(refs).toEqual(['art2', 'art2p1', 'art2p2', 'art2p3']);
  });

  it('does not turn a consolidated-text footnote into a punkt', () => {
    const text = `Art. 2. W rozumieniu ustawy:
1) statkiem jest urządzenie latające;
2) lotniskiem jest obszar wyznaczony;
11) W brzmieniu ustalonym przez art. 3 pkt 2 ustawy, o której mowa w odnośniku 3.
3) lądowiskiem jest obszar na lądzie.`;
    const p = parsePolishPdf(text, ACT).provisions;
    expect(p.map(x => x.provision_ref)).toEqual(['art2', 'art2p1', 'art2p2', 'art2p3']);
    expect(p.find(x => x.provision_ref === 'art2p3')!.content).toBe('lądowiskiem jest obszar na lądzie.');
  });
});

describe('parsePolishPdf — footnotes inside regulation §§', () => {
  it('does not turn a footnote in a § or ustęp into a punkt', () => {
    const text = `§ 1. Rozporządzenie określa:
1) wzory wniosków;
2) sposób składania;
12) Uchylony przez art. 1 pkt 23 ustawy z dnia 26 stycznia 2018 r.
3) tryb rozpatrywania.
§ 2. 1. Wniosek zawiera:
1) imię i nazwisko;
17) W brzmieniu ustalonym przez § 1 pkt 2 rozporządzenia zmieniającego.
2) adres.
2. Wniosek składa się na piśmie.`;
    const refs = parsePolishPdf(text, { ...ACT, title: 'Rozporządzenie testowe' }).provisions.map(x => x.provision_ref);
    expect(refs).toEqual(['par1', 'par1p1', 'par1p2', 'par1p3', 'par2', 'par2u1p1', 'par2u1p2', 'par2u2']);
  });

  it('keeps a punkt list that starts mid-sequence after a bogus split', () => {
    const text = `§ 1. 1. Wykaz obejmuje:
1) sędziego;
2) prokuratora.
4. Dodany przez § 1 pkt 3 rozporządzenia. 3) członka Rady; 4) prezesa banku.`;
    const refs = parsePolishPdf(text, { ...ACT, title: 'Rozporządzenie testowe' }).provisions.map(x => x.provision_ref);
    expect(refs).toContain('par1u4p3');
    expect(refs).toContain('par1u4p4');
  });
});

/** pdftotext layout of a page-bottom footnote (KP art. 22¹): marker in text, footnote before the date stamp. */
const FOOTNOTE_PAGE = `Art. 22[1]. § 1. Pracodawca żąda podania danych osobowych obejmujących:
1)

imię (imiona) i nazwisko;

5)

kwalifikacje zawodowe;

14)

6)

przebieg dotychczasowego zatrudnienia.

§ 3. Pracodawca żąda od pracownika podania dodatkowo danych osobowych obejmujących:
1)

adres zamieszkania;

2)

numer PESEL;

14)

W brzmieniu ustalonym przez art. 1 pkt 2 ustawy, o której mowa w odnośniku 10.
15)
Dodany przez art. 3 ustawy z dnia 1 marca 2024 r.

2026-09-25

Dziennik Ustaw

– 12 –

Poz. 1245

3)

inne dane osobowe pracownika.
Art. 23. Przepis kolejny.`;

describe('parsePolishPdf — page-bottom footnotes', () => {
  const p = parsePolishPdf(FOOTNOTE_PAGE, ACT).provisions;
  const byRef = (r: string) => p.find(x => x.provision_ref === r);

  it('drops the footnote block and keeps the text that continues on the next page', () => {
    const art = byRef('art22^1')!.content;
    expect(art).not.toMatch(/W brzmieniu ustalonym|Dodany przez/);
    expect(art).toContain('numer PESEL; 3) inne dane osobowe pracownika.');
  });

  it('drops the footnote reference marker in front of a punkt', () => {
    expect(byRef('art22^1')!.content).toContain('kwalifikacje zawodowe; 6) przebieg');
    expect(byRef('art22^1par3p3')!.content).toBe('inne dane osobowe pracownika.');
  });

  it('keeps the dropped footnotes on the act for EU-reference extraction', () => {
    expect(parsePolishPdf(FOOTNOTE_PAGE, ACT).footnotes).toEqual([
      'W brzmieniu ustalonym przez art. 1 pkt 2 ustawy, o której mowa w odnośniku 10.',
      'Dodany przez art. 3 ustawy z dnia 1 marca 2024 r.',
    ]);
  });

  it('keeps a quoted footnote that an amending act inserts', () => {
    const text = `Art. 1. W ustawie do tytułu dodaje się odnośnik nr 1 w brzmieniu:
„1) Niniejsza ustawa dokonuje wdrożenia dyrektywy 2014/65/UE.”.
Art. 2. Ustawa wchodzi w życie.`;
    expect(parsePolishPdf(text, ACT).provisions.find(x => x.provision_ref === 'art1')!.content).toContain('Niniejsza ustawa dokonuje');
  });
});

/** A consolidated text: obwieszczenie quoting an amending act's art. 8, then the act. */
const OBWIESZCZENIE = `O B W IE S Z CZ E N I E
M AR S ZA ŁK A S EJ MU RZ E C ZY PO S PO LI T EJ PO L SK I EJ
z dnia 1 września 2026 r.
w sprawie ogłoszenia jednolitego tekstu ustawy – Kodeks pracy
2. Podany w załączniku do niniejszego obwieszczenia tekst jednolity ustawy nie obejmuje:
1) art. 8 ustawy z dnia 4 czerwca 2025 r., który stanowi:
„Art. 8. Okresów, o których mowa w art. 302 ustawy zmienianej w art. 1, nie wlicza się.”.
Załącznik do obwieszczenia Marszałka Sejmu Rzeczypospolitej
Polskiej z dnia 1 września 2026 r. (Dz. U. poz. 1245)
US T AW A
z dnia 26 czerwca 1974 r.
Kodeks pracy1)
1)
Niniejsza ustawa dokonuje w zakresie swojej regulacji wdrożenia następujących dyrektyw Wspólnot Europejskich:
1) dyrektywy 83/477/EWG z dnia 19 września 1983 r.
DZIAŁ PIERWSZY
Art. 7. (uchylony)
Art. 8. Nie można czynić ze swego prawa użytku, który byłby sprzeczny ze społeczno-gospodarczym przeznaczeniem tego prawa.`;

describe('parsePolishPdf — consolidated text (obwieszczenie)', () => {
  it('skips the obwieszczenie, so its quotes cannot shadow the act', () => {
    const arts = parsePolishPdf(OBWIESZCZENIE, ACT).provisions.filter(x => x.provision_ref === 'art8');
    expect(arts).toHaveLength(1);
    expect(arts[0].content).toContain('Nie można czynić ze swego prawa użytku');
  });

  it('keeps the title footnote with EU directives in footnotes', () => {
    const notes = parsePolishPdf(OBWIESZCZENIE, ACT).footnotes ?? [];
    expect(notes.some(n => n.includes('83/477/EWG'))).toBe(true);
  });
});

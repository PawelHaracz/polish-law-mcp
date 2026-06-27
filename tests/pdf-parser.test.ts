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

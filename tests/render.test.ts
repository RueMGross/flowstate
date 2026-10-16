import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { parseSup } from '../src/render/painter';
import { PdfPainter } from '../src/render/pdf';
import { writeXlsx } from '../src/io/xlsx';

describe('parseSup', () => {
  const show = (s: string) => parseSup(s).map((r) => (r.sup ? `^(${r.text})` : r.text)).join('');
  it('raises only the sign after a marker', () => {
    expect(parseSup('CD4^+CD8^-')).toEqual([{ text: 'CD4' }, { text: '+', sup: true }, { text: 'CD8' }, { text: '-', sup: true }]);
    expect(show('CD8^-CD4^+ T cells')).toBe('CD8^(-)CD4^(+) T cells');
  });
  it('keeps exponents and braces', () => {
    expect(show('10^4')).toBe('10^(4)');
    expect(show('10^-3 and 10^{-3}')).toBe('10^(-3) and 10^(-3)');
    expect(show('x^2y')).toBe('x^(2y)');
  });
});

describe('PDF text', () => {
  const content = (bytes: Uint8Array) => {
    const s = strFromU8(bytes, true);
    const id = /\/Contents (\d+) 0 R/.exec(s)![1];
    const at = s.indexOf(`\n${id} 0 obj\n`);
    const len = Number(/\/Length (\d+) >>\nstream\n/.exec(s.slice(at))![1]);
    const i = s.indexOf('stream\n', at) + 7;
    return strFromU8(unzlibSync(bytes.subarray(i, i + len)), true);
  };
  const objects = (bytes: Uint8Array) => strFromU8(bytes, true);
  it('embeds TrueType subsets and writes Greek letters and superscripts as real glyphs', () => {
    const p = new PdfPainter(200, 100);
    p.text(0, 20, 'IFN-γ CD4⁺ 10⁴ Œ', { family: 'Arial', size: 10, color: '#000000' });
    p.text(0, 40, 'Times', { family: "'Times New Roman', Times, serif", size: 10, color: '#000000', weight: 'bold' });
    p.text(0, 60, 'Calibri', { family: 'Calibri, Carlito, Arial, sans-serif', size: 10, color: '#000000', italic: true });
    const bytes = p.toBytes({ title: 'IFN-γ' });
    const all = objects(bytes);
    expect(all).toContain('/Subtype /Type0');
    expect(all).toContain('/Encoding /Identity-H');
    expect(all).toMatch(/\/BaseFont \/[A-Z]{6}\+FlowStateSans /);
    expect(all).toMatch(/\/BaseFont \/[A-Z]{6}\+FlowStateSerif-Bold /);
    expect(all).toMatch(/\/BaseFont \/[A-Z]{6}\+FlowStateHumanist /);
    // OFL: the modified (subset) fonts must not carry the Reserved Font Names
    expect(all).not.toMatch(/\/(BaseFont|FontName) \/[A-Z]{6}\+(Liberation|Arimo|Tinos|Cousine|Carlito)/);
    expect(all).toContain('/FontFile2');
    expect(all).toContain('/ToUnicode');
    expect(all).not.toContain('/Symbol');
    expect(all).not.toContain('/Type1');
    const ops = content(bytes);
    expect(ops).toContain('/FFlowStateSans 10 Tf');
    expect(ops).toContain('/FFlowStateSans 7 Tf'); // superscript size
    expect(ops).toMatch(/1 0 0\.213 -1 [\d.-]+ [\d.-]+ Tm/); // synthetic italic for Calibri
    for (const m of ops.matchAll(/<([0-9a-f]+)> Tj/g)) expect(m[1].match(/.{4}/g)).not.toContain('0000'); // no .notdef glyphs
    expect(all).toContain('/Title <FEFF00490046004E002D03B3>');
  });
});

describe('XLSX', () => {
  it('drops characters that are illegal in XML', () => {
    const z = unzipSync(writeXlsx('S', [['a\u0001b\u000bc\td']]));
    const sheet = strFromU8(z['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('>abc\td<');
  });
});

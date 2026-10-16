// Robustness of the file readers against damaged input (QC fuzz findings): every failure is a clear Error message,
// never a hang, a raw TypeError / RangeError or a silent partial import.
import { exportGatingMLDoc, importGatingML } from '../src/core/gatingml';
import { MAX_PAR, parseFcs, parseFcsSamples } from '../src/core/fcs';
import { emptyWorkspace, type Population } from '../src/core/model';
import { descendants, parseXml } from '../src/core/xml';
import { importFlowJo } from '../src/core/flowjo';
import { importGatingMLText, openFiles } from '../src/io/files';
import { zipSync } from 'fflate';
import { loadDemo } from '../src/state/demo';
import { loadFcsFiles, readableError, useStore } from '../src/state/store';
import { MAX_SPECTRA_ROWS, parseSpectraCsv } from '../src/ui/unmix/helpers';
import { buildFcs, type BuildOpts } from './fcsBuilder';

/** Errors the user may see: our own messages, no raw JavaScript errors. */
const RAW = /TypeError|Cannot read prop|is not a function|is not iterable|\[object|Maximum call stack|Invalid code point|Invalid (typed )?array length/;

function expectClearError(f: () => unknown, re?: RegExp, ms = 1000): string {
  const t0 = Date.now();
  let msg = '';
  try {
    f();
  } catch (e) {
    expect((e as Error).name).toBe('Error');
    msg = (e as Error).message;
  }
  expect(msg, 'an error was expected').not.toBe('');
  expect(msg).not.toMatch(RAW);
  if (re) expect(msg).toMatch(re);
  expect(Date.now() - t0).toBeLessThan(ms);
  return msg;
}

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ------------------------------------------------------------------ XML (Gating-ML, FlowJo .wsp)

describe('XML parser on damaged documents', () => {
  it('a truncated end tag is an error, not an endless loop (repro truncated_end_tag.xml / .wsp)', () => {
    const gml = '<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"></gating:Gating-ML';
    expectClearError(() => parseXml(gml), /truncated/);
    expectClearError(() => importGatingML(gml), /truncated/);
    const wsp = '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="20.0" flowJoVersion="10.8.1"></Workspa';
    expectClearError(() => importFlowJo(wsp), /truncated/);
  });
  it('truncation anywhere is reported (start tag, comment, CDATA, declaration, open elements)', () => {
    for (const s of ['<a><b x="1"', '<a><!-- note', '<a><![CDATA[x', '<a><?pi', '<a><b></b>', '<a b="unterminated></a>']) expectClearError(() => parseXml(s), /truncated or damaged/);
  });
  it('every prefix of a document parses or fails quickly', () => {
    const doc = '<?xml version="1.0"?><!-- c --><g:R xmlns:g="x" a="1"><g:d n=\'2\'>t&amp;<![CDATA[<x>]]></g:d><e/></g:R>';
    for (let i = 0; i <= doc.length; i++) {
      const t0 = Date.now();
      try {
        parseXml(doc.slice(0, i));
      } catch (e) {
        expect((e as Error).message).not.toMatch(RAW);
      }
      expect(Date.now() - t0).toBeLessThan(200);
    }
    const ok = parseXml(doc);
    expect(ok.children[0].name).toBe('R');
    expect(ok.children[0].children[0].text).toBe('t&<x>');
  });
  it('deep nesting does not overflow the stack (parse and descendants)', () => {
    const n = 100000;
    const d = parseXml('<a>' + '<x>'.repeat(n) + '<P/>' + '</x>'.repeat(n) + '</a>');
    expect(descendants(d, 'x').length).toBe(n);
    expect(descendants(d, 'P').length).toBe(1);
  });
  it('descendants keeps document order', () => {
    const d = parseXml('<r><p id="1"><p id="2"/></p><q><p id="3"/></q><p id="4"/></r>');
    expect(descendants(d, 'p').map((p) => p.attrs.id)).toEqual(['1', '2', '3', '4']);
  });
  it('an invalid character reference has a clear message (no "Invalid code point")', () => {
    expectClearError(() => parseXml('<a b="&#99999999;"/>'), /invalid character reference/);
    expectClearError(() => parseXml('<a>&#x110000;</a>'), /invalid character reference/);
    expect(parseXml('<a b="&#65;&#x42;"/>').children[0].attrs.b).toBe('AB');
  });
});

// ------------------------------------------------------------------ FCS

const pars = [{ name: 'FSC-A', range: 262144 }, { name: 'SSC-A', range: 262144 }, { name: 'Time', range: 1024 }];
const data = [Array.from({ length: 200 }, (_, i) => i * 100), Array.from({ length: 200 }, (_, i) => 5000 + i), Array.from({ length: 200 }, (_, i) => i)];
const fcs = (o: Partial<BuildOpts> = {}) => ab(buildFcs({ pars, data, ...o }));

describe('FCS reader on damaged keywords', () => {
  it('a huge $PAR is rejected before anything is allocated (repro par_99999999.fcs, $PAR=1000000)', () => {
    for (const v of ['99999999', '1000000', String(MAX_PAR + 1)]) expectClearError(() => parseFcs(fcs({ kw: { $PAR: v } })), /\$PAR is \d+: more parameters/, 300);
  });
  it('$PAR missing, 0, negative or not a whole number', () => {
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: '-1' } })), /Invalid \$PAR "-1"/);
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: '0' } })), /no parameters/);
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: '1.5' } })), /Invalid \$PAR/);
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: 'abc' } })), /Invalid \$PAR/);
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: '' } })), /\$PAR keyword .* is missing/);
  });
  it('a $PAR larger than the parameters described (no $PnN) is a damaged file', () => {
    expectClearError(() => parseFcs(fcs({ kw: { $PAR: '50' } })), /no name \(\$P4N\)/);
  });
  it('$PnR of Infinity / 1e308 / a denormal: the data maximum is used, with a note (repro pnr_inf.fcs)', () => {
    for (const r of ['Infinity', '1e308', '1e-320', 'NaN']) {
      const ds = parseFcs(fcs({ pars: [{ name: 'FSC-A', range: r }, pars[1], pars[2]] }));
      expect(ds.channels[0].range).toBe(19900);
      if (r !== 'NaN') expect(ds.warnings.join(' ')).toMatch(/Implausible ranges \$P1R/);
    }
  });
  it('an empty file says so (repro empty.fcs), as do files shorter than a HEADER', () => {
    expectClearError(() => parseFcsSamples(new ArrayBuffer(0)), /Empty file/);
    expectClearError(() => parseFcsSamples(new TextEncoder().encode('FCS3.1  ').buffer as ArrayBuffer), /too short/);
  });
  it('loadFcsFiles reports an empty file with an error toast (not silently ignored)', async () => {
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const t0 = useStore.getState().ui.toasts.length;
    const ids = await loadFcsFiles([new File([new Uint8Array(0)], 'empty.fcs')]);
    expect(ids).toEqual([]);
    const t = useStore.getState().ui.toasts.slice(t0);
    expect(t.some((x) => x.kind === 'error' && /empty\.fcs: Empty file/.test(x.text))).toBe(true);
  });
  it('notes on a file read in part or with implausible keywords are shown when it is loaded', async () => {
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const t0 = useStore.getState().ui.toasts.length;
    await loadFcsFiles([new File([fcs({ kw: { $TIMESTEP: '1e30' } })], 'ts.fcs')]);
    expect(useStore.getState().ui.toasts.slice(t0).map((x) => x.text)).toContain('ts.fcs: $TIMESTEP "1e30" is not usable; Time is shown in instrument ticks');
  });
  it('$TIMESTEP that would overflow Time (1e30) is not applied (repro timestep_1e30.fcs)', () => {
    const ds = parseFcs(fcs({ kw: { $TIMESTEP: '1e30' } }));
    expect(ds.timeStep).toBeUndefined();
    expect(Array.from(ds.data[2]).every(Number.isFinite)).toBe(true);
    expect(ds.warnings.join(' ')).toMatch(/\$TIMESTEP "1e30" is not usable/);
    expect(parseFcs(fcs({ kw: { $TIMESTEP: '0.01' } })).timeStep).toBe(0.01);
  });

  /** An FCS 3.1 file with ASCII data (delimited, or fixed width with `bits` digits per value). */
  function asciiFcs(rows: number[][], tot: number, bits = '*'): ArrayBuffer {
    const body = bits === '*' ? rows.map((r) => r.join(',')).join('\n') + '\n' : rows.map((r) => r.map((v) => String(v).padStart(Number(bits), ' ')).join('')).join('');
    const kw = (b: number, e: number) =>
      `/$BEGINDATA/${String(b).padStart(10, '0')}/$ENDDATA/${String(e).padStart(10, '0')}/$BYTEORD/1,2,3,4/$DATATYPE/A/$MODE/L/$NEXTDATA/0/$PAR/2/$TOT/${tot}/$P1N/A/$P1B/${bits}/$P1R/1024/$P1E/0,0/$P2N/B/$P2B/${bits}/$P2R/1024/$P2E/0,0/`;
    const tl = kw(0, 0).length;
    const ds = 58 + tl;
    const text = kw(ds, ds + body.length - 1);
    const head = 'FCS3.1    ' + [58, 58 + tl - 1, ds, ds + body.length - 1].map((n) => String(n).padStart(8, ' ')).join('') + '       0       0';
    return new TextEncoder().encode(head + text + body).buffer as ArrayBuffer;
  }
  it('ASCII data: a huge $TOT is bounded by the DATA segment (repro ascii_tot_huge.fcs)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i, 2 * i]);
    for (const bits of ['*', '6']) {
      const t0 = Date.now();
      const ds = parseFcs(asciiFcs(rows, 300000000, bits));
      expect(Date.now() - t0).toBeLessThan(500);
      expect(ds.eventCount).toBe(50);
      expect(ds.data[0].length).toBe(50);
      expect(ds.data[1][49]).toBe(98);
    }
    const ok = parseFcs(asciiFcs(rows, 50));
    expect(ok.eventCount).toBe(50);
    expect(Array.from(ok.data[0].subarray(0, 3))).toEqual([0, 1, 2]);
  });
  it('the reader wraps raw JavaScript errors for toasts', () => {
    expect(readableError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(/could not be read: it is damaged/);
    expect(readableError(new Error('$PAR missing'))).toBe('$PAR missing');
  });
});

// ------------------------------------------------------------------ Gating-ML

const GML = (body: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations">${extra}${body}</gating:Gating-ML>`;
const dim = (ch: string | null, attrs = '') => `<gating:dimension gating:compensation-ref="uncompensated"${attrs}>${ch === null ? '' : `<data-type:fcs-dimension${ch ? ` data-type:name="${ch}"` : ''}/>`}</gating:dimension>`;
const vtx = (x: string, y: string) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
const rect = (id: string, parent?: string) => `<gating:RectangleGate gating:id="${id}"${parent ? ` gating:parent_id="${parent}"` : ''}>${dim('FSC-A', ' gating:min="1"')}</gating:RectangleGate>`;
const finite = (p: Population) => !JSON.stringify(p.gate, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v)).includes('__NaN__');

describe('Gating-ML import validates gates', () => {
  it('NaN coordinates and dimensions without a channel skip the gate with a note (repro gml_nan_vertex.xml, gml_*dimension_without_name.xml)', () => {
    const r1 = importGatingML(GML(`<gating:PolygonGate gating:id="P1">${dim('FSC-A')}${dim('SSC-A')}${vtx('1000', '1000')}${vtx('900000', 'abc')}${vtx('900000', '900000')}</gating:PolygonGate>`));
    expect(r1.populations).toEqual([]);
    expect(r1.warnings.join()).toMatch(/Gate P1 skipped: a vertex coordinate is not a number/);
    const r2 = importGatingML(GML(`<gating:RectangleGate gating:id="R1">${dim(null, ' gating:min="20"')}</gating:RectangleGate>`));
    expect(r2.populations).toEqual([]);
    expect(r2.warnings.join()).toMatch(/R1.*names no channel/);
    const r3 = importGatingML(GML(`<gating:RectangleGate gating:id="R1">${dim('', ' gating:min="20"')}</gating:RectangleGate>`));
    expect(r3.populations).toEqual([]);
    expect(r3.warnings.join()).toMatch(/R1: a dimension has no channel name/);
  });
  it('a bound that is not a number does not become an open bound', () => {
    const r = importGatingML(GML(`<gating:RectangleGate gating:id="R1">${dim('FSC-A', ' gating:min="1,5" gating:max="80"')}</gating:RectangleGate>`));
    expect(r.populations).toEqual([]);
    expect(r.warnings.join()).toMatch(/min of FSC-A \("1,5"\) is not a number/);
  });
  it('transformations with invalid parameters do not produce NaN gates', () => {
    const t = `<transforms:transformation transforms:id="T1"><transforms:logicle transforms:T="262144" transforms:W="0.5" transforms:M="-Infinity" transforms:A="0"/></transforms:transformation>`;
    const r = importGatingML(GML(`<gating:RectangleGate gating:id="R1">${dim('FSC-A', ' gating:min="0.2" gating:transformation-ref="T1"')}</gating:RectangleGate>`, t));
    expect(r.populations.every(finite)).toBe(true);
    expect(r.populations).toEqual([]);
    expect(r.warnings.join()).toMatch(/Transformation "T1" \(logicle\) has missing or invalid parameters/);
  });
  it('incomplete ellipsoids and quadrants are skipped with notes, not TypeErrors (fuzz cases at gatingml.ts 179 / 185)', () => {
    const noMean = `<gating:EllipsoidGate gating:id="E1">${dim('FSC-A')}${dim('SSC-A')}<gating:covarianceMatrix><gating:row><gating:entry data-type:value="1"/><gating:entry data-type:value="0"/></gating:row></gating:covarianceMatrix></gating:EllipsoidGate>`;
    const oneRow = `<gating:EllipsoidGate gating:id="E2">${dim('FSC-A')}${dim('SSC-A')}<gating:mean><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="2"/></gating:mean><gating:covarianceMatrix><gating:row><gating:entry data-type:value="1"/><gating:entry data-type:value="0"/></gating:row></gating:covarianceMatrix><gating:distanceSquare data-type:value="1"/></gating:EllipsoidGate>`;
    const quad = `<gating:QuadrantGate gating:id="Q1"><gating:divider gating:id="D1" gating:compensation-ref="uncompensated"><data-type:fcs-dimension/><gating:value>5</gating:value></gating:divider><gating:Quadrant gating:id="QA"><gating:position gating:divider_ref="D1" gating:location="10"/></gating:Quadrant></gating:QuadrantGate>`;
    const r = importGatingML(GML(noMean + oneRow + quad));
    expect(r.populations).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/Gate E1 skipped: the ellipsoid needs a mean/);
    expect(r.warnings.join('\n')).toMatch(/Gate E2 skipped/);
    expect(r.warnings.join('\n')).toMatch(/Quadrant gate Q1 skipped: a divider names no channel/);
  });
  it('cyclic parent_id: the gates are skipped with a note, not dropped silently', () => {
    const r = importGatingML(GML(rect('A', 'B') + rect('B', 'A') + rect('C', 'A') + rect('D') + rect('S', 'S')));
    expect(r.populations.map((p) => p.name)).toEqual(['D']);
    const w = r.warnings.join('\n');
    expect(w).toMatch(/Gates "A", "B" name each other as parent/);
    expect(w).toMatch(/Gate C skipped: its parent "A" is part of a parent cycle/);
    expect(w).toMatch(/Gate "S" names itself as its parent/);
  });
  it('deep gate chains (over the former limit of 1000 levels) in any document order keep every gate', () => {
    const n = 1100;
    const body = Array.from({ length: n }, (_, i) => rect(`G${n - 1 - i}`, n - 1 - i ? `G${n - 2 - i}` : undefined)).join('');
    const r = importGatingML(GML(body));
    expect(r.populations.length).toBe(n);
    expect(r.populations[0].parentId).toBeNull();
  });
  it('the import into the workspace toasts the notes', () => {
    loadDemo();
    const t0 = useStore.getState().ui.toasts.length;
    importGatingMLText(GML(rect('A', 'B') + rect('B', 'A')), 'cyc.xml');
    const t = useStore.getState().ui.toasts.slice(t0).map((x) => x.text).join('\n');
    expect(t).toMatch(/Imported 0 gates from Gating-ML\. Gates "A", "B" name each other/);
  });
  it('export skips damaged gates with a note instead of throwing (gatingml.ts escapeXml(undefined))', () => {
    const ws = emptyWorkspace();
    ws.populations.push(
      { id: 'a', name: 'ok', parentId: null, color: '#000', gate: { type: 'range', x: 'FSC-A', min: 1, max: 5 } },
      { id: 'b', name: 'no channel', parentId: null, color: undefined as unknown as string, gate: { type: 'range', x: undefined as unknown as string, min: 1, max: 5 } },
      { id: 'c', name: 'NaN', parentId: null, color: '#000', gate: { type: 'polygon', x: 'A', y: 'B', points: [[0, 0], [1, NaN], [2, 2]] } },
    );
    const { xml, warnings } = exportGatingMLDoc(ws);
    expect(xml).toContain('gating:id="ok"');
    expect(xml).not.toContain('no_channel');
    expect(warnings.join('\n')).toMatch(/Gate "no channel" is incomplete and was not exported/);
    expect(warnings.join('\n')).toMatch(/Gate "NaN" is incomplete/);
    expect(importGatingML(xml).populations.length).toBe(1);
  });
});

// ------------------------------------------------------------------ spectra CSV

describe('spectra CSV import', () => {
  it('a huge file is rejected with a message, not "Maximum call stack size exceeded"', () => {
    const big = 'det,A\n' + Array.from({ length: 200000 }, (_, i) => `D${i},${(i % 7) + 1}`).join('\n');
    expectClearError(() => parseSpectraCsv(big), new RegExp(`at most ${MAX_SPECTRA_ROWS}`), 3000);
    const wide = 'det,' + Array.from({ length: 150000 }, (_, i) => 'E' + i).join(',') + '\nV1-A,' + Array.from({ length: 150000 }, () => '1').join(',');
    expectClearError(() => parseSpectraCsv(wide), /columns/, 3000);
  });
  it('a large but valid table still parses', () => {
    const D = 1000;
    const text = 'det,PE,APC\n' + Array.from({ length: D }, (_, i) => `V${i}-A,${i + 1},${D - i}`).join('\n');
    const t = parseSpectraCsv(text);
    expect(t.detectors.length).toBe(D);
    expect(Math.max(...t.endmembers[0].signature)).toBe(1);
  });
});

// ------------------------------------------------------------------ files opened together

describe('opening damaged files reports each one', () => {
  it('a damaged zip, a zip without usable files, a truncated workspace, a truncated FlowJo workspace', async () => {
    loadDemo();
    const t0 = useStore.getState().ui.toasts.length;
    await openFiles([
      new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3])], 'broken.zip'),
      new File([zipSync({ 'notes.txt': new Uint8Array([65]) }) as BlobPart], 'other.zip'),
      new File(['{"app":"FlowState","samples":[{"id":'], 'cut.flowstate.json'),
      new File(['<?xml version="1.0"?><Workspace version="20.0"><Groups'], 'cut.wsp'),
    ]);
    const t = useStore.getState().ui.toasts.slice(t0).filter((x) => x.kind === 'error').map((x) => x.text);
    expect(t.find((x) => x.startsWith('broken.zip:'))).toMatch(/not a readable zip archive/);
    expect(t.find((x) => x.startsWith('other.zip:'))).toMatch(/holds no FlowState workspace, FCS, FlowJo or Gating-ML files/);
    expect(t.find((x) => x.startsWith('cut.flowstate.json:'))).toMatch(/not valid JSON .* cut off/);
    expect(t.find((x) => x.startsWith('cut.wsp:'))).toMatch(/truncated or damaged/);
    for (const x of t) expect(x).not.toMatch(RAW);
  });
});

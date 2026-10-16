import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { emptyWorkspace, type Workspace } from '../src/core/model';
import { controlSpread, createUnmixDef, defaultDetectors, unmixOutputNames, type UnmixDef } from '../src/core/unmix';
import { useStore } from '../src/state/store';
import { applyDraft, plannedOutputs, showUnmixPlots } from '../src/ui/unmix/apply';
import { buildDraftDef, computeAf, computeRow, mapSignature, unstainedSet, type RowResult } from '../src/ui/unmix/compute';
import { draftFromDef, duplicateDraft, guessControls, newDraft, nextColor, type DerivedWithSetup, type Draft } from '../src/ui/unmix/draft';
import {
  capIndices,
  channelWavelengths,
  complexityInfo,
  defsEquivalent,
  detectorCandidates,
  groupDetectors,
  isAfName,
  laserOf,
  looksLikeControl,
  looksLikeUnstained,
  parseSpectraCsv,
  plotPartners,
  spectraToCsv,
  uniqueName,
  unmixOutputRanges,
} from '../src/ui/unmix/helpers';

// ------------------------------------------------------------------ detectors

const CYTOFLEX_LX = [
  ...Array.from({ length: 20 }, (_, i) => `U${i + 1}-A`),
  ...Array.from({ length: 20 }, (_, i) => `V${i + 1}-A`),
  ...Array.from({ length: 16 }, (_, i) => `B${i + 1}-A`),
  ...Array.from({ length: 12 }, (_, i) => `Y${i + 1}-A`),
  ...Array.from({ length: 10 }, (_, i) => `R${i + 1}-A`),
  ...Array.from({ length: 3 }, (_, i) => `IR${i + 1}-A`),
];

describe('detector grouping', () => {
  it('CytoFLEX LX letter-coded detectors', () => {
    const g = groupDetectors(CYTOFLEX_LX);
    expect(g.map((x) => [x.id, x.detectors.length])).toEqual([
      ['UV', 20],
      ['V', 20],
      ['B', 16],
      ['Y', 12],
      ['R', 10],
      ['IR', 3],
    ]);
    expect(g[1].detectors[0]).toBe('V1-A');
  });

  it('Aurora, Symphony and Attune detector names', () => {
    expect(['UV1-A', 'V16-A', 'B14-A', 'YG10-A', 'R8-A'].map((n) => laserOf(n))).toEqual(['UV', 'V', 'B', 'YG', 'R']);
    expect(['UV379-A', 'V450-A', 'B530-A', 'YG586-A', 'R670-A'].map((n) => laserOf(n))).toEqual(['UV', 'V', 'B', 'YG', 'R']);
    expect(['UL1-A', 'VL3-A', 'BL1-A', 'YL2-A', 'RL1-A'].map((n) => laserOf(n))).toEqual(['UV', 'V', 'B', 'Y', 'R']);
  });

  it('BD fluorochrome-named detectors', () => {
    const bd = ['Alexa Fluor 488-A', 'PE-A', 'PE-Texas Red-A', '7-AAD-A', 'PE-Cy7-A', 'Alexa Fluor 405-A', 'Alexa Fluor 430-A', 'Qdot 605-A', 'Alexa Fluor 647-A', 'Alexa Fluor 700-A', 'APC-Cy7-A'];
    expect(bd.map((n) => laserOf(n))).toEqual(['B', 'YG', 'YG', 'B', 'YG', 'V', 'V', 'V', 'R', 'R', 'R']);
    expect(['BUV395-A', 'BV421-A', 'BV786-A', 'FITC-A', 'PerCP-Cy5.5-A', 'PE-CF594-A', 'APC-R700-A', 'APC-H7-A', 'BB515-A'].map((n) => laserOf(n))).toEqual(['UV', 'V', 'V', 'B', 'B', 'YG', 'R', 'R', 'B']);
    // CytoFLEX S/LX fluorochrome-style names
    expect(['PB450-A', 'KO525-A', 'PC5.5-A', 'PC7-A', 'ECD-A', 'APC-A750-A'].map((n) => laserOf(n))).toEqual(['V', 'V', 'B', 'YG', 'YG', 'R']);
    expect(laserOf('FL1-A')).toBe('other');
    const g = groupDetectors(bd);
    expect(g.map((x) => x.id)).toEqual(['V', 'B', 'YG', 'R']);
  });

  it('$PnL excitation wavelengths win over names', () => {
    const wl = channelWavelengths({ $P1L: '405', $P2L: '488,561', $P3L: '' }, ['FL1-A', 'FL2-A', 'FL3-A']);
    expect(wl).toEqual({ 'FL1-A': 405, 'FL2-A': 488 });
    expect(groupDetectors(['FL1-A', 'FL2-A', 'FL3-A'], wl).map((g) => [g.id, g.detectors])).toEqual([
      ['V', ['FL1-A']],
      ['B', ['FL2-A']],
      ['other', ['FL3-A']],
    ]);
  });

  it('detector candidates exclude scatter, time and width', () => {
    const names = ['FSC-A', 'FSC-H', 'SSC-A', 'VSSC-A', 'V1-A', 'V1-H', 'B1-A', 'FSC-Width', 'Time', 'PE-W'];
    expect(detectorCandidates(names)).toEqual(['V1-A', 'B1-A']);
    expect(detectorCandidates(names, true)).toEqual(['V1-A', 'V1-H', 'B1-A', 'PE-W']);
  });
});

// ------------------------------------------------------------------ names

describe('sample name heuristics', () => {
  it('controls and unstained samples', () => {
    for (const n of ['Compensation-FITC.fcs', 'Beads20_BV711', 'CD3 BV421 single stain', 'SS_PE', 'Ref PE-Cy7', 'comp_APC', 'BV605 beads', 'Ctrl-FITC']) expect(looksLikeControl(n)).toBe(true);
    for (const n of ['Sample 1', 'Patient_03_PBMC', 'Tube 4', 'Compensation-Unstained', 'Unstained_Cells', 'blank']) expect(looksLikeControl(n)).toBe(false);
    for (const n of ['Compensation-Unstained.fcs', 'Unstained_Cells', 'unst cells', 'Blank', 'AF control', 'US_beads', 'Neg']) expect(looksLikeUnstained(n)).toBe(true);
    for (const n of ['Compensation-FITC', 'Beads20_BV711', 'Sample 1', 'Negroni', 'Bus']) expect(looksLikeUnstained(n)).toBe(false);
  });
  it('unique names and AF names', () => {
    expect(uniqueName('PE', ['PE', 'PE 2'])).toBe('PE 3');
    expect(uniqueName('FITC', ['PE'])).toBe('FITC');
    expect(['AF', 'af1', 'Autofluorescence', 'AF 2'].every(isAfName)).toBe(true);
    expect(['AF488', 'AF700', 'Alexa Fluor 647'].some(isAfName)).toBe(false);
  });
});

// ------------------------------------------------------------------ CSV

describe('spectra CSV', () => {
  const dets = ['V1-A', 'V2-A', 'B1-A', 'R1-A'];
  const ems = [
    { name: 'BV421', signature: [1, 0.25, 0.01, 0] },
    { name: 'PE, Cy7', signature: [0.001, 0, 0.3, 1] },
  ];
  it('round trip (detectors x endmembers, quoted names)', () => {
    const csv = spectraToCsv(dets, ems);
    expect(csv.split('\n')[0]).toBe('Detector,BV421,"PE, Cy7"');
    const t = parseSpectraCsv(csv);
    expect(t.detectors).toEqual(dets);
    expect(t.endmembers.map((e) => e.name)).toEqual(['BV421', 'PE, Cy7']);
    expect(t.endmembers[1].signature).toEqual([0.001, 0, 0.3, 1]);
    expect(t.warnings).toEqual([]);
  });
  it('transposed, semicolons with decimal commas, normalisation', () => {
    const csv = 'Fluor;V1-A;V2-A;B1-A;R1-A\nBV421;2000;500;20;0\nAPC;0;0;10,5;1000\n';
    const t = parseSpectraCsv(csv);
    expect(t.detectors).toEqual(dets);
    expect(t.endmembers[0].signature).toEqual([1, 0.25, 0.01, 0]);
    expect(t.endmembers[1].signature[2]).toBeCloseTo(0.0105, 6);
    expect(t.warnings.length).toBe(2);
  });
  it('orientation from known detectors', () => {
    // labels that do not look like detectors: decided by the known detector list
    const csv = '\tCh1\tCh2\tCh3\nX\t1\t0.5\t0\nY\t0\t0.2\t1\n';
    expect(parseSpectraCsv(csv, ['Ch1', 'Ch2', 'Ch3']).detectors).toEqual(['Ch1', 'Ch2', 'Ch3']);
    expect(parseSpectraCsv(csv, ['X', 'Y']).detectors).toEqual(['X', 'Y']);
  });
  it('errors', () => {
    expect(() => parseSpectraCsv('Detector,A\n')).toThrow(/no data/);
    expect(() => parseSpectraCsv('Detector,A\nV1-A,abc\nV2-A,1\n')).toThrow(/not a number/);
    expect(() => parseSpectraCsv('Detector,A\nV1-A,1\nV1-A,0.5\n')).toThrow(/twice/);
    expect(() => parseSpectraCsv('Detector,A\nV1-A,0\nV2-A,-1\n')).toThrow(/no positive/);
  });
});

// ------------------------------------------------------------------ small helpers

describe('helpers', () => {
  it('complexity interpretation', () => {
    expect(complexityInfo(NaN).level).toBe('none');
    expect(complexityInfo(Infinity).level).toBe('singular');
    expect(complexityInfo(1.9).level).toBe('low');
    expect(complexityInfo(12).level).toBe('moderate');
    expect(complexityInfo(35).level).toBe('high');
    expect(complexityInfo(80).level).toBe('very high');
    for (const v of [NaN, Infinity, 1, 10, 30, 90]) expect(complexityInfo(v).text).not.toMatch(/—/);
  });

  it('definition equivalence', () => {
    const a = createUnmixDef({ id: 'u', name: 'X', detectors: ['a', 'b', 'c'], endmembers: [{ name: 'P', signature: [1, 0.2, 0] }], af: [{ name: 'AF', signature: [0.3, 1, 0.5] }], includeAF: false });
    const b: UnmixDef = JSON.parse(JSON.stringify(a));
    b.created = 'other';
    expect(defsEquivalent(a, b)).toBe(true);
    b.af![0].signature[0] = 0.4; // AF not unmixed: irrelevant
    expect(defsEquivalent(a, b)).toBe(true);
    expect(defsEquivalent(a, { ...b, includeAF: true })).toBe(false);
    expect(defsEquivalent(a, { ...b, method: 'wls' })).toBe(false);
    expect(defsEquivalent(a, { ...b, name: 'Y' })).toBe(false);
    const c: UnmixDef = JSON.parse(JSON.stringify(a));
    c.endmembers[0].signature[1] += 1e-4;
    expect(defsEquivalent(a, c)).toBe(false);
    expect(defsEquivalent(a, c, 1e-3)).toBe(true);
  });

  it('output ranges follow unmixOutputNames', () => {
    const range: Record<string, number> = { a: 1000, b: 2000, c: 4000 };
    const def = createUnmixDef({
      detectors: ['a', 'b', 'c'],
      endmembers: [
        { name: 'P', signature: [1, 0.2, 0], peak: 0 },
        { name: 'Q', signature: [0, 0.3, 1] },
      ],
      af: [
        { name: 'AF1', signature: [0.2, 1, 0.1] },
        { name: 'AF2', signature: [0.2, 0.5, 1] },
      ],
      includeAF: true,
      residual: 'rms',
    });
    expect(unmixOutputNames(def)).toEqual(['P', 'Q', 'AF', 'AF Index', 'Residual RMS']);
    expect(unmixOutputRanges(def, (d) => range[d])).toEqual([1000, 4000, 4000, 2, 4000]);
    expect(unmixOutputRanges({ ...def, afMode: 'all', residual: 'ssr' }, (d) => range[d])).toEqual([1000, 4000, 2000, 4000, 16e6]);
  });

  it('plot partners, index capping, colour slots', () => {
    const sim = [
      [1, 0.2, 0.9, 0.5],
      [0.2, 1, 0.1, 0.3],
      [0.9, 0.1, 1, 0.4],
      [0.5, 0.3, 0.4, 1],
    ];
    expect(plotPartners(sim, 2)).toEqual([
      [2, 3],
      [3, 0],
      [0, 3],
      [0, 2],
    ]);
    expect(Array.from(capIndices([5, 6, 7, 8, 9, 10], 3))).toEqual([5, 7, 9]);
    expect(Array.from(capIndices([1, 2], 3))).toEqual([1, 2]);
    expect(nextColor([{ color: 0 }, { color: 2 }] as never)).toBe(1);
  });

  it('mapSignature by detector name (case-insensitive)', () => {
    expect(mapSignature(['A', 'b', 'C'], [1, 2, 3], ['c', 'B'])).toEqual({ sig: [3, 2], missing: [] });
    expect(mapSignature(['A'], [1], ['A', 'D']).missing).toEqual(['D']);
  });

  it('buildDraftDef reports problems', () => {
    const draft = {
      id: 'u1',
      name: 'T',
      detectors: ['a', 'b'],
      method: 'ols',
      nonNegative: false,
      includeAF: true,
      afMode: 'best',
      residual: 'none',
      setup: {
        v: 1,
        scope: 'root',
        unstainedId: null,
        afK: 1,
        controls: [
          { key: 'k1', name: 'P', pos: 'auto', neg: 'auto', color: 0 },
          { key: 'k2', name: 'P', pos: 'auto', neg: 'auto', color: 1 },
          { key: 'k3', name: 'R', pos: 'auto', neg: 'auto', color: 2 },
        ],
      },
    } as Draft;
    const rows: Record<string, RowResult> = {
      k1: { kind: 'ok', warnings: [], signature: [1, 0.1], peak: 0 },
      k2: { kind: 'ok', warnings: [], signature: [0.1, 1], peak: 1 },
      k3: { kind: 'error', warnings: [], error: 'boom' },
    };
    const b = buildDraftDef(draft, rows, null);
    expect(b.complete).toBe(false);
    expect(b.used).toEqual([0, 1]);
    expect(b.def!.endmembers.map((e) => e.name)).toEqual(['P', 'P 2']);
    expect(b.problems.join('\n')).toMatch(/R: boom/);
    expect(b.problems.join('\n')).toMatch(/Duplicate endmember name: P/);
    expect(b.problems.join('\n')).toMatch(/no unstained sample/);
    const ok = buildDraftDef({ ...draft, includeAF: false, setup: { ...draft.setup, controls: [draft.setup.controls[0], { ...draft.setup.controls[2], name: 'Q' }] } }, { k1: rows.k1, k3: rows.k2 }, null);
    expect(ok.complete).toBe(true);
    expect(ok.problems).toEqual([]);
    const tooMany = buildDraftDef({ ...draft, includeAF: true, setup: { ...draft.setup, controls: [draft.setup.controls[0], { ...draft.setup.controls[2], name: 'Q' }] } }, { k1: rows.k1, k3: rows.k2 }, { kind: 'computed', endmembers: [{ name: 'AF', signature: [1, 1] }], warnings: [] });
    expect(tooMany.complete).toBe(false);
    expect(tooMany.problems.join()).toMatch(/More endmembers \(3\) than detectors \(2\)/);
  });
});

// ------------------------------------------------------------------ real data, end to end (store, engine, apply)

function loadInto(ws: Workspace, path: string, id: string) {
  const b = readFileSync(path);
  const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  engine.addSample(id, ds);
  const name = path.split('/').pop()!.replace(/\.fcs$/i, '');
  ws.samples.push({ id, name, fileName: name + '.fcs', fileSize: b.byteLength, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
}

function computeAll(ws: Workspace, draft: Draft) {
  const { un } = unstainedSet(ws, draft);
  const rows: Record<string, RowResult> = {};
  draft.setup.controls.forEach((c, i) => (rows[c.key] = computeRow(ws, draft, c, i, undefined, un)));
  const af = computeAf(draft, un, undefined, undefined);
  return { rows, af, un, b: buildDraftDef(draft, rows, af.af, af.noiseSD) };
}

const BD = '/home/claude/testdata/comp';
const CF = '/home/claude/testdata/cytoflex';

describe.skipIf(!existsSync(BD))('real data through the view logic', () => {
  it('BD single-stain controls: guess, signatures, apply, reload, plots', () => {
    const ws = emptyWorkspace();
    for (const f of readdirSync(BD).filter((x) => x.endsWith('.fcs')).sort()) loadInto(ws, join(BD, f), 'bd_' + f);
    useStore.getState().replaceWorkspace(ws);
    const g = guessControls(ws);
    expect(g.controls.length).toBe(6);
    expect(g.unstained).toBe('bd_Compensation-Unstained.fcs');
    const draft = newDraft(ws, { guess: true });
    expect(draft.detectors).toEqual(defaultDetectors(engine.samples.get('bd_Compensation-FITC.fcs')!.ds));
    expect(draft.setup.controls.map((c) => c.name).sort()).toEqual(['7AAD', 'AF700', 'APC', 'APC-Cy7', 'FITC', 'PE']);
    expect(draft.note).toMatch(/Added 6 samples/);
    const d2 = { ...draft, includeAF: true };
    const { rows, b } = computeAll(ws, d2);
    for (const c of d2.setup.controls) expect(rows[c.key].kind).toBe('ok');
    const peak = (n: string) => d2.detectors[rows[d2.setup.controls.find((c) => c.name === n)!.key].peak!];
    expect(peak('FITC')).toMatch(/488/);
    expect(peak('PE')).toBe('PE-A');
    expect(peak('APC')).toMatch(/647/);
    expect(b.complete).toBe(true);
    const def = b.def!;
    expect(def.includeAF).toBe(true);
    expect(def.noiseSD?.length).toBe(11);
    // each control is positive only in its own endmember
    const sp = controlSpread(
      def,
      b.used.map((ri, k) => ({ endmember: k, pos: rows[d2.setup.controls[ri].key].pos!, neg: rows[d2.setup.controls[ri].key].neg! })),
    );
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (i !== j) expect(Math.abs(sp.leakage[i][j])).toBeLessThan(0.03);
    // outputs and apply
    const markers = b.used.map((i) => (d2.setup.controls[i].name === 'PE' ? 'CD4' : undefined));
    const outs = plannedOutputs(useStore.getState().ws, def, markers);
    expect(outs.map((o) => o.name)).toEqual([...def.endmembers.map((e) => e.name), 'AF']);
    expect(outs.every((o) => o.range === 262144)).toBe(true);
    expect(outs.find((o) => o.name === 'PE')!.label).toBe('CD4');
    const applied = applyDraft(d2, def, markers);
    const st = useStore.getState();
    const saved = st.ws.derived!.find((x) => x.id === def.id) as DerivedWithSetup;
    expect(saved).toBe(applied);
    expect(saved.setup!.controls.length).toBe(6);
    for (const o of saved.outputs) expect(st.ws.scales[o.name]?.type).toBe('logicle');
    // unmixed values of a control through the engine: FITC positives high in FITC, ~0 elsewhere
    const fitcRow = d2.setup.controls.find((c) => c.name === 'FITC')!;
    const vals = st.ws.derived && engine.raw(st.ws, fitcRow.sampleId!, 'FITC');
    const pe = engine.raw(st.ws, fitcRow.sampleId!, 'PE');
    expect(vals && pe).toBeTruthy();
    const pos = rows[fitcRow.key].pos!.idx!;
    const med = (a: Float32Array) => Float32Array.from(Array.from(pos, (i) => a[i])).sort()[pos.length >> 1];
    expect(med(vals!)).toBeGreaterThan(1000);
    expect(Math.abs(med(pe!))).toBeLessThan(0.03 * med(vals!));
    // save / reload: the draft comes back from the stored setup
    const reloaded = JSON.parse(JSON.stringify(saved)) as DerivedWithSetup;
    const back = draftFromDef(reloaded);
    expect(back.setup.controls.map((c) => c.sampleId)).toEqual(d2.setup.controls.map((c) => c.sampleId));
    expect(back.setup.unstainedId).toBe(d2.setup.unstainedId);
    expect(back.includeAF).toBe(true);
    expect(back.setup.controls.find((c) => c.name === 'PE')!.marker).toBe('CD4');
    const again = computeAll(ws, back).b.def!;
    expect(defsEquivalent(again, saved.unmix)).toBe(true);
    // duplicate gets new ids and a free name
    const dup = duplicateDraft(back, ['Spectral unmixing']);
    expect(dup.id).not.toBe(back.id);
    expect(dup.name).toBe('Spectral unmixing copy');
    expect(new Set(dup.setup.controls.map((c) => c.key)).size).toBe(6);
    // worksheet of the unmixed controls
    const nSheets = st.ws.worksheets.length;
    expect(showUnmixPlots(def.id)).toBe(true);
    const ws2 = useStore.getState().ws;
    expect(ws2.worksheets.length).toBe(nSheets + 1);
    const plots = ws2.worksheets[ws2.worksheets.length - 1].items.filter((i) => i.kind === 'plot');
    expect(plots.length).toBe(6 * 5);
    const p0 = plots[0];
    expect(p0.kind === 'plot' && p0.layers[0].sample).toBe(d2.setup.controls[0].sampleId);
    // gated positive / negative populations and the unstained sample as negative give the same PE spectrum
    const peRow = d2.setup.controls.find((c) => c.name === 'PE')!;
    const wsG: Workspace = {
      ...ws,
      populations: [
        { id: 'pePos', name: 'PE+', parentId: null, color: '#f00', gate: { type: 'range', x: 'PE-A', min: 5000, max: Infinity } },
        { id: 'peNeg', name: 'PE-', parentId: null, color: '#00f', gate: { type: 'range', x: 'PE-A', min: -Infinity, max: 300 } },
      ],
    };
    const autoSig = rows[peRow.key].signature!;
    const un = unstainedSet(wsG, d2).un;
    const gated = computeRow(wsG, d2, { ...peRow, pos: 'pePos', neg: 'peNeg' }, 0, undefined, un);
    expect(gated.kind).toBe('ok');
    expect(gated.negSource).toBe('population');
    const viaUn = computeRow(wsG, d2, { ...peRow, neg: 'unstained' }, 0, undefined, un);
    expect(viaUn.negSource).toBe('unstained');
    const cos = (a: number[], b: number[]) => a.reduce((t, v, i) => t + v * b[i], 0) / Math.hypot(...a) / Math.hypot(...b);
    expect(cos(gated.signature!, autoSig)).toBeGreaterThan(0.995);
    expect(cos(viaUn.signature!, autoSig)).toBeGreaterThan(0.995);
    expect(computeRow(wsG, d2, { ...peRow, pos: 'missingPop' }, 0, undefined, un).error).toMatch(/positive population has no events/);
    expect(computeRow(wsG, { ...d2, setup: { ...d2.setup, unstainedId: null } }, { ...peRow, neg: 'unstained' }, 0, undefined, null).error).toMatch(/choose an unstained sample/);
    // a control that is no longer loaded falls back to the stored signature of the applied definition
    const gone = computeRow({ ...wsG, samples: wsG.samples.filter((x) => x.id !== peRow.sampleId) }, d2, peRow, d2.setup.controls.indexOf(peRow), saved, un);
    expect(gone.kind).toBe('stored');
    expect(gone.signature).toEqual(saved.unmix.endmembers[d2.setup.controls.indexOf(peRow)].signature);
    // library row from the exported spectra reproduces the signature
    const csv = spectraToCsv(def.detectors, def.endmembers);
    const lib = parseSpectraCsv(csv, def.detectors);
    const libDraft: Draft = { ...d2, setup: { ...d2.setup, controls: lib.endmembers.map((e, i) => ({ key: 'lib' + i, name: e.name, pos: 'auto', neg: 'auto', color: i, fixed: { detectors: lib.detectors, signature: e.signature } })) } };
    const lb = computeAll(ws, libDraft).b.def!;
    lb.endmembers.forEach((e, k) => e.signature.forEach((v, d) => expect(v).toBeCloseTo(def.endmembers[k].signature[d], 4)));
  });

  it.skipIf(!existsSync(CF))('CytoFLEX LX beads with unstained cells and AF', () => {
    const ws = emptyWorkspace();
    for (const f of readdirSync(CF).filter((x) => x.endsWith('.fcs')).sort()) loadInto(ws, join(CF, f), 'cf_' + f);
    useStore.getState().replaceWorkspace(ws);
    const draft = { ...newDraft(ws, { guess: true }), includeAF: true };
    expect(draft.detectors.length).toBe(81);
    expect(draft.setup.controls.map((c) => c.name)).toEqual(['BV711', 'PerCP']);
    expect(draft.setup.unstainedId).toBe('cf_Unstained_Cells.fcs');
    const { rows, b } = computeAll(ws, draft);
    for (const c of draft.setup.controls) {
      expect(rows[c.key].kind).toBe('ok');
      expect(rows[c.key].negSource).toBe('control'); // bead controls use their own negative beads
    }
    expect(draft.detectors[rows[draft.setup.controls[0].key].peak!]).toMatch(/^V1[2-5]-A$/);
    const def = b.def!;
    expect(b.complete).toBe(true);
    const sp = controlSpread(def, b.used.map((ri, k) => ({ endmember: k, pos: rows[draft.setup.controls[ri].key].pos!, neg: rows[draft.setup.controls[ri].key].neg! })));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) if (i !== j) expect(Math.abs(sp.leakage[i][j])).toBeLessThan(0.01);
    const outs = plannedOutputs(ws, def, []);
    expect(outs.map((o) => [o.name, o.range])).toEqual([
      ['BV711', 16777216],
      ['PerCP', 16777216],
      ['AF', 16777216],
    ]);
    // removing a detector the PerCP signature peaks in still works; an unknown detector is reported per control
    const bad = computeAll(ws, { ...draft, detectors: [...draft.detectors, 'XYZ-A'] });
    expect(bad.rows[draft.setup.controls[0].key].error).toMatch(/Detectors missing in this sample: XYZ-A/);
    expect(bad.b.complete).toBe(false);
  });
});

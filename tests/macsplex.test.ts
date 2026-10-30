// MACSPlex plugin (src/plugins/macsplex): the calculations on synthetic FCS files whose results are computed by hand
// (the same design and expected numbers as the Python reference's tests), the gating steps (auto gate, one undo,
// hand correction, confirmation), saved state, layout parsing. Synthetic data only.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { engine } from '../src/core/engine';
import { writeFcs } from '../src/core/fcs';
import { emptyWorkspace } from '../src/core/model';
import { contextFor } from '../src/plugins/context';
import macsplex from '../src/plugins/macsplex';
import {
  acquisitionTime,
  alignPolygon,
  draftLayout,
  layoutToCsv,
  pairBlanks,
  templateFromXit,
  analyse,
  createGates,
  DEFAULT_STATE,
  gateCheck,
  gateSignature,
  medianCi,
  normalizeWell,
  parseLayout,
  parseState,
  parseTemplateText,
  spearman,
  templateFromPopulations,
  type MacsplexState,
  type Results,
  type Template,
} from '../src/plugins/macsplex/compute';
import { loadFcsFiles, useStore } from '../src/state/store';

const st = () => useStore.getState();
const fs = contextFor(macsplex);

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  st().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...st().ui, toasts: [] } });
}

// ------------------------------------------------------------------ synthetic plate (as macsplex_ref/tests)

const CENTERS: Record<string, number> = { CD9: 1000, CD63: 2000, CD81: 3000, CD41b: 4000, 'REA control': 5000, 'mIgG1 control': 6000 };
const COUNTS: Record<string, number> = { CD9: 60, CD63: 30, CD81: 10, CD41b: 5, 'REA control': 6, 'mIgG1 control': 6 };
const REA_SPREAD = [-3, -2, -1, 1, 2, 3];
const square = (c: number): [number, number][] => [
  [c - 100, c - 100],
  [c + 100, c - 100],
  [c + 100, c + 100],
  [c - 100, c + 100],
];
const TEMPLATE: Template = {
  source: 'synthetic',
  gates: [
    {
      name: 'Single beads',
      parent: null,
      x: 'FSC-A',
      y: 'SSC-A',
      kind: 'rect',
      points: [
        [100, 100],
        [200, 100],
        [200, 200],
        [100, 200],
      ],
    },
    ...Object.entries(CENTERS).map(([b, c]) => ({
      name: b,
      parent: 'Single beads',
      x: 'B525-FITC-A',
      y: 'Y585-PE-A',
      kind: 'polygon' as const,
      points: square(c),
    })),
  ],
};
const CHANNELS = [
  { name: 'FSC-A', range: 1e6 },
  { name: 'SSC-A', range: 1e6 },
  { name: 'FL1-A', label: 'B525-FITC-A', range: 1e6 },
  { name: 'FL2-A', label: 'Y585-PE-A', range: 1e6 },
  { name: 'FL3-A', label: 'R660-APC-A', range: 1e6 },
];

function wellFile(well: string, apc: Record<string, number>, volNl: number, btim: string, empty: string[] = [], jitter = 0): File {
  const ev: number[][] = [];
  for (let i = 0; i < 7; i++) ev.push([50, 150, 1000, 1000, 9999]); // not single beads
  for (let i = 0; i < 5; i++) ev.push([150, 150, 10, 10, 1]); // single beads outside every bead gate
  ev.push([100, 150, 10, 10, 1], [200, 200, 10, 10, 1]); // on xmin (counts); on xmax and ymax (does not)
  let k = 0;
  for (const [b, c] of Object.entries(CENTERS)) {
    if (empty.includes(b)) continue;
    const vals = b === 'REA control' ? REA_SPREAD.map((d) => apc[b] + d) : Array(COUNTS[b]).fill(apc[b]);
    for (const v of vals) {
      const j = jitter ? jitter * (((k++ * 7919) % 101) / 100 - 0.5) : 0;
      ev.push([150, 150, c + j, c - j, v]);
    }
  }
  const data = [0, 1, 2, 3, 4].map((c) => Float32Array.from(ev.map((e) => e[c])));
  const kw = { $SMNO: well, $VOL: String(volNl), $BTIM: btim, $DATE: '29-Oct-2026' };
  return new File([writeFcs({ channels: CHANNELS, data, keywords: kw }) as BlobPart], `${well}.fcs`);
}

const base = Object.fromEntries(Object.keys(CENTERS).map((b) => [b, 100]));
const SAMPLE = { ...base, CD9: 1100, CD63: 2100, CD81: 3100 };
const LAYOUT = [
  'well,role,sample_id,condition,dose,replicate_group,blank_group,planned_volume_uL,failed',
  'A1,blank,,,,,bl,120,',
  'A2,blank,,,,,bl,120,',
  'A3,blank,,,,,bl,120,',
  'B1,sample,s1,,,g,bl,120,',
  'B2,sample,s1,,,g,bl,120,',
  'B3,sample,s1,,,g,bl,120,',
  'C1,unstained,s1,,,u,bl,120,',
].join('\n');

async function plate(jitter = 0) {
  reset();
  await loadFcsFiles([
    wellFile('A1', Object.fromEntries(Object.keys(CENTERS).map((b) => [b, 90])), 59000, '10:00:00', [], jitter),
    wellFile('A2', base, 120000, '10:01:00', [], jitter),
    wellFile('A3', Object.fromEntries(Object.keys(CENTERS).map((b) => [b, 140])), 120000, '10:02:00', [], jitter),
    wellFile('B1', { ...SAMPLE, CD41b: 4100, 'mIgG1 control': 50 }, 120000, '10:03:00', [], jitter),
    wellFile('B2', { ...SAMPLE, CD41b: 4200, 'mIgG1 control': 50 }, 120000, '10:04:00', [], jitter),
    wellFile('B3', { ...SAMPLE, CD41b: 4300 }, 120000, '10:05:00', ['mIgG1 control'], jitter),
    wellFile('C1', base, 120000, '10:06:00', [], jitter),
  ]);
  const sid = (w: string) => st().ws.samples.find((s) => s.name.startsWith(w))!.id;
  return { sid };
}

/** Template gates as they are (validation mode), layout pasted. */
async function validationPlate(extra: Partial<MacsplexState> = {}) {
  const { sid } = await plate();
  const s0: MacsplexState = { ...DEFAULT_STATE, template: TEMPLATE, mode: 'template', layoutText: LAYOUT, ...extra };
  fs.setState(s0);
  expect(createGates(fs, s0, sid('A2'))).toEqual([]);
  const s = fs.getState()!;
  const r = analyse(fs, s);
  if ('error' in r) throw new Error(r.error);
  return { r, s, sid };
}

const bead = (r: Results, w: string, b: string) => r.beads.find((x) => x.well === w && x.bead === b)!;
const flagSet = (f: string) => new Set(f ? f.split(';') : []);

// ------------------------------------------------------------------ tests

describe('MACSPlex statistics helpers', () => {
  it('order-statistic CI of the median (as the Python reference)', () => {
    const seq = (n: number) => Float32Array.from({ length: n }, (_, i) => i + 1);
    expect(medianCi(seq(5))).toBeNull(); // no 95% CI below 6 events
    expect(medianCi(seq(6))).toEqual([1, 6]);
    expect(medianCi(seq(20))).toEqual([6, 15]);
    expect(medianCi(seq(1000))).toEqual([469, 532]);
    expect(medianCi(seq(5000))).toEqual([2431, 2570]); // no underflow
    expect(medianCi(Float32Array.from([1, 2, NaN, 3, 4, 5, 6, Infinity]))).toEqual([1, 6]);
  });

  it('Spearman with average ranks, acquisition time, wells', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 3, 1])).toBeCloseTo(-0.9486832980505138, 12); // scipy.stats.spearmanr
    expect(acquisitionTime('29-Oct-2026', '10:01:00') - acquisitionTime('29-Oct-2026', '10:00:00')).toBe(60000);
    expect(acquisitionTime('29-Oct-2026', 'x')).toBeNaN();
    expect(normalizeWell(' a01')).toBe('A1');
  });

  it('layout CSV', () => {
    expect(parseLayout(LAYOUT).rows.length).toBe(7);
    expect(parseLayout(LAYOUT.replace(/,/g, ';')).rows[3]).toMatchObject({ well: 'B1', role: 'sample', replicate_group: 'g', planned_volume_uL: 120 });
    expect(parseLayout('well,role\nA1,blank\nA01,sample').errors).toEqual(['Line 3: well A1 appears twice.']);
    expect(parseLayout('well,role\nA1,blnk').errors[0]).toMatch(/unknown role "blnk"/);
    expect(parseLayout('role\nblank').errors).toEqual(['The layout needs a "well" column.']);
  });
});

describe('MACSPlex calculations (validation mode, hand-computed values)', () => {
  it('blank subtraction, normalization, CI and flags', async () => {
    const { r } = await validationPlate();
    // blank mean (90, 100, 140) = 110, not the median 100
    expect(bead(r, 'B1', 'CD9').blank_mean).toBeCloseTo(110, 9);
    expect(bead(r, 'B1', 'CD9').model_A).toBeCloseTo(990, 9);
    expect(bead(r, 'B1', 'CD41b').model_A).toBeCloseTo(3990, 9);
    expect(bead(r, 'B2', 'CD41b').normalized).toBeCloseTo(4090 / 1990, 12);
    expect(bead(r, 'B1', 'mIgG1 control').model_A).toBeCloseTo(-60, 9);
    expect(bead(r, 'B1', 'REA control').ci_low).toBe(97);
    expect(bead(r, 'B1', 'CD41b').ci_low).toBeNaN(); // 5 events: no CI, value kept
    expect(bead(r, 'B1', 'CD41b').median).toBe(4100);
    expect(flagSet(bead(r, 'B1', 'CD9').flags)).toEqual(new Set(['norm_low_events']));
    expect(flagSet(bead(r, 'B1', 'CD63').flags).has('low_events')).toBe(true);
    expect(flagSet(bead(r, 'B1', 'CD81').flags).has('very_low_events')).toBe(true);
    expect(flagSet(bead(r, 'B1', 'mIgG1 control').flags).has('below_background')).toBe(true);
    expect(flagSet(bead(r, 'B3', 'mIgG1 control').flags).has('empty_gate')).toBe(true);
    expect(bead(r, 'A1', 'CD9').model_A).toBeNaN(); // blanks are not corrected
    const w = Object.fromEntries(r.wells.map((x) => [x.well, x]));
    expect(flagSet(w.A1.flags).has('early_stop')).toBe(true);
    expect(flagSet(w.A2.flags).has('early_stop')).toBe(false);
    expect(flagSet(w.B1.flags).has('negative_isotype')).toBe(true);
    const n = Object.values(COUNTS).reduce((a, b) => a + b, 0);
    expect(w.B1.single_beads).toBe(6 + n); // the event on xmin counts, the one on xmax / ymax does not
    expect(w.B1.pct_assigned).toBeCloseTo((100 * n) / (6 + n), 12);
    expect(w.B1.volume_uL).toBeCloseTo(120, 9);
    // single beads 123 in every well but B3 (117: its mIgG1 bead is empty), acquired 6th
    expect(r.run.order_rho).toBeCloseTo(-0.408248290463863, 12); // scipy.stats.spearmanr on the same numbers
  });

  it('replicate summary', async () => {
    const { r } = await validationPlate();
    const g = r.summary.find((x) => x.group === 'g' && x.bead === 'CD41b')!;
    expect(g.n).toBe(3);
    expect(g.mean_A).toBeCloseTo(4090, 9);
    expect(g.sd_A).toBeCloseTo(100, 9);
    expect(g.cv_A).toBeCloseTo(100 / 4090, 12);
    expect(g.mean_normalized).toBeCloseTo(4090 / 1990, 12);
    const m = r.summary.find((x) => x.group === 'g' && x.bead === 'mIgG1 control')!;
    expect(m.n).toBe(2); // B3: empty gate, left out
    expect(m.mean_A).toBeCloseTo(-60, 9);
    const bl = r.blanks.find((x) => x.bead === 'CD9')!; // blanks 90, 100, 140: SD sqrt(700), CV 0.24 (below 0.30)
    expect(bl).toMatchObject({ n: 3, flags: '' });
    expect(bl.blank_sd).toBeCloseTo(Math.sqrt(700), 9);
  });

  it('model B is optional and off by default', async () => {
    const off = await validationPlate();
    expect(off.r.beads.every((x) => Number.isNaN(x.model_B))).toBe(true);
    const { r } = await validationPlate({ modelB: true });
    expect(bead(r, 'B1', 'CD41b').model_B).toBeCloseTo(4025, 9); // (4100 - 100) - mean(0, -50)
    expect(bead(r, 'B3', 'CD41b').model_B).toBeCloseTo(4200, 9); // mIgG1 empty: REA only
  });

  it('limits are adjustable and only highlight', async () => {
    const { r } = await validationPlate({ limits: { ...DEFAULT_STATE.limits, veryLowEvents: 5, lowEvents: 11 } });
    const f = flagSet(bead(r, 'B1', 'CD81').flags);
    expect(f.has('low_events') && !f.has('very_low_events')).toBe(true);
    expect(bead(r, 'B1', 'CD81').model_A).toBeCloseTo(2990, 9);
    // boundaries: a count equal to a limit is not below it
    const b = (await validationPlate({ limits: { ...DEFAULT_STATE.limits, veryLowEvents: 10, lowEvents: 60 } })).r;
    expect(flagSet(bead(b, 'B1', 'CD81').flags).has('very_low_events')).toBe(false);
    expect(flagSet(bead(b, 'B1', 'CD81').flags).has('low_events')).toBe(true);
    expect(flagSet(bead(b, 'B1', 'CD9').flags).has('low_events')).toBe(false);
  });

  it('layout and samples must match', async () => {
    const { s } = await validationPlate();
    expect(analyse(fs, { ...s, layoutText: LAYOUT + '\nH12,sample,,,,g,bl,120,' })).toEqual({ error: 'Layout wells without a loaded sample: H12.' });
    expect(analyse(fs, { ...s, layoutText: LAYOUT.split('\n').slice(0, -1).join('\n') })).toEqual({ error: 'Samples for wells not in the layout: C1.' });
  });
});

describe('MACSPlex gating steps', () => {
  it('aligning moves a shifted template onto the beads; one undo removes all gates', async () => {
    // three bead clusters of 500 events (3% spread); template squares (+-15%) shifted by +0.07 decades in both channels
    reset();
    const pos: Record<string, number> = { CD9: 1000, CD63: 10000, CD81: 100000 };
    let k = 0;
    const r = () => ((k++ * 7919) % 1000) / 1000 - 0.5;
    const ev: number[][] = [];
    for (const c of Object.values(pos)) for (let i = 0; i < 500; i++) ev.push([150, 150, c * (1 + 0.06 * r()), c * (1 + 0.06 * r()), 1000]);
    ev.push([150, 150, 5000, 5000, 1]); // a single bead between the clusters
    const data = [0, 1, 2, 3, 4].map((j) => Float32Array.from(ev.map((e) => e[j])));
    await loadFcsFiles([new File([writeFcs({ channels: CHANNELS, data, keywords: { $SMNO: 'B1' } }) as BlobPart], 'B1.fcs')]);
    const ref = st().ws.samples[0].id;
    const f = 10 ** 0.07;
    const sq = (c: number): [number, number][] => [
      [c * 0.85 * f, c * 0.85 * f],
      [c * 1.15 * f, c * 0.85 * f],
      [c * 1.15 * f, c * 1.15 * f],
      [c * 0.85 * f, c * 1.15 * f],
    ];
    const tpl: Template = {
      source: 'synthetic',
      gates: [
        TEMPLATE.gates[0],
        ...Object.entries(pos).map(([b, c]) => ({
          name: b,
          parent: 'Single beads',
          x: 'B525-FITC-A',
          y: 'Y585-PE-A',
          kind: 'polygon' as const,
          points: sq(c),
        })),
      ],
    };
    // as they are, the shifted squares miss part of each cluster
    const s0: MacsplexState = { ...DEFAULT_STATE, template: tpl, mode: 'template' };
    createGates(fs, s0, ref);
    expect(fs.count(ref, fs.getState()!.beads.CD9)).toBeLessThan(500);
    const before = st().ws;
    // aligned: every cluster complete, shape kept
    expect(createGates(fs, { ...fs.getState()!, mode: 'auto' }, ref)).toEqual([]);
    const s = fs.getState()!;
    for (const b of Object.keys(pos)) expect(fs.count(ref, s.beads[b])).toBe(500);
    const g = st().ws.populations.find((p) => p.id === s.beads.CD9)!.gate;
    expect(g.type === 'polygon' && g.points.length).toBe(4);
    expect(gateCheck(fs, s).map((x) => [x.bead, x.events])).toEqual(Object.keys(pos).map((b) => [b, 500]));
    st().undo();
    expect(st().ws).toBe(before);
  });

  it('alignPolygon: shape kept, shift in decades, deterministic', () => {
    const ex = Float32Array.from({ length: 200 }, (_, i) => 1000 * 10 ** (0.05 + 0.01 * (((i * 37) % 11) - 5)));
    const ey = Float32Array.from({ length: 200 }, (_, i) => 2000 * 10 ** (-0.03 + 0.01 * (((i * 53) % 11) - 5)));
    const sq: [number, number][] = [
      [800, 1600],
      [1250, 1600],
      [1250, 2500],
      [800, 2500],
    ];
    const a = alignPolygon(sq, ex, ey);
    expect(a.n).toBe(200);
    expect(a.dx).toBeGreaterThan(0.03);
    expect(a.dy).toBeLessThan(0);
    expect(a.points[1][0] / a.points[0][0]).toBeCloseTo(1250 / 800, 12); // same shape
    expect(alignPolygon(sq, ex, ey)).toEqual(a);
  });

  it('a hand correction is marked and removes the confirmation', async () => {
    const { s } = await validationPlate();
    const sig = gateSignature(fs, s);
    fs.setState({ ...s, confirmed: { at: '2026-10-29 10:00', signature: sig } });
    const r1 = analyse(fs, fs.getState()!);
    expect('error' in r1 ? '' : r1.run.gates_confirmed).toBe('2026-10-29 10:00');
    fs.setGate(s.beads.CD9, {
      type: 'polygon',
      x: 'FL1-A',
      y: 'FL2-A',
      points: square(1000).map(([x, y]) => [x + 10, y]),
      scales: s.created.CD9.type === 'polygon' ? s.created.CD9.scales : undefined,
      strict: true,
    });
    const s2 = fs.getState()!;
    expect(gateCheck(fs, s2).find((x) => x.bead === 'CD9')!.flags).toContain('gate_corrected');
    expect(gateSignature(fs, s2)).not.toBe(sig);
    const r2 = analyse(fs, s2);
    expect('error' in r2 ? 'x' : r2.run.gates_confirmed).toBe('');
  });

  it('template from populations (e.g. gates imported from a .xit) and pasted', async () => {
    const { s } = await validationPlate();
    const t = templateFromPopulations(fs, s.singles!);
    expect('error' in t ? [] : t.gates.map((g) => g.name)).toEqual(['Single beads', ...Object.keys(CENTERS)]);
    expect(parseTemplateText(JSON.stringify(TEMPLATE))).toEqual(TEMPLATE);
    expect(parseTemplateText('{')).toEqual({ error: 'not valid JSON' });
    expect(parseTemplateText('{"gates":[{"name":"x"}]}')).toMatchObject({ error: expect.stringMatching(/not a gate template/) });
  });
});

describe('MACSPlex saved state', () => {
  it('current, older and broken states', () => {
    const cur = { ...DEFAULT_STATE, template: TEMPLATE, mode: 'template', layoutText: 'well,role', modelB: true };
    expect(parseState(JSON.parse(JSON.stringify(cur)))).toEqual(cur);
    // saved before some fields existed: defaults filled in
    expect(parseState({ version: 1, reporter: 'FL3-A' })).toEqual({ ...DEFAULT_STATE, reporter: 'FL3-A' });
    expect(parseState({ reporter: 'FL3-A', limits: { lowEvents: 40, bogus: 1 } })!.limits).toEqual({ ...DEFAULT_STATE.limits, lowEvents: 40 });
    // not understood
    expect(parseState(null)).toBeNull();
    expect(parseState('x')).toBeNull();
    expect(parseState({ version: 2 })).toBeNull();
    expect(parseState({ version: 1, template: { gates: [{ name: 'x' }] } })).toBeNull();
  });
});

describe('MACSPlex page', () => {
  it('renders without data and with results', async () => {
    reset();
    expect(renderToString(createElement(macsplex.Page, { fs, revision: 0 }))).toContain('1. Template and reporter');
    await validationPlate();
    const html = renderToString(createElement(macsplex.Page, { fs, revision: 1 }));
    expect(html).toContain('Replicate groups');
    expect(html).toContain('Confirm gate set');
    expect(html).toContain('<svg'); // the bead plot of the reference well
    expect((html.match(/<polygon/g) ?? []).length).toBe(6); // one outline per bead gate
  });
});

describe('MACSPlex layout tools and raw results', () => {
  it('without a layout: medians, events and CIs only', async () => {
    await plate();
    const s0: MacsplexState = { ...DEFAULT_STATE, template: TEMPLATE, mode: 'template' };
    fs.setState(s0);
    createGates(fs, s0, st().ws.samples[0].id);
    const r = analyse(fs, fs.getState()!);
    if ('error' in r) throw new Error(r.error);
    expect(r.notes[0]).toMatch(/No plate layout yet/);
    expect(bead(r, 'B1', 'CD41b').median).toBe(4100);
    expect(bead(r, 'B1', 'CD41b').model_A).toBeNaN();
    expect(r.summary).toEqual([]);
  });

  it('a starting layout from the wells, blanks paired by column, CSV round trip', async () => {
    await plate();
    const d = draftLayout(fs, 120);
    expect(d.map((r) => r.well)).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'A3', 'B3']); // column by column
    expect(d.every((r) => r.role === 'sample' && r.planned_volume_uL === 120 && r.blank_group === '')).toBe(true);
    const rows = d.map((r) => (r.well.startsWith('A') ? { ...r, role: 'blank' as const } : r));
    const p = pairBlanks(rows, 'column');
    expect(p.find((r) => r.well === 'B2')!.blank_group).toBe('blank col 2');
    expect(p.find((r) => r.well === 'A2')!.blank_group).toBe('blank col 2');
    expect(parseLayout(layoutToCsv(p))).toEqual({ rows: p, errors: [] });
    expect(pairBlanks(rows, 'row').find((r) => r.well === 'B2')!.blank_group).toBe(''); // no blank in row B
  });

  it('reads a CytExpert .xit (errors are reported, not thrown)', () => {
    expect(templateFromXit(new Uint8Array([1, 2, 3]), 'x.xit')).toMatchObject({ error: expect.stringMatching(/not a readable CytExpert experiment/) });
  });
});

// Builds the example workspace (synthetic data, gating strategy, figure layout, table).
import { DEMO_SAMPLES, makeDemoDataset } from '../core/demo';
import { engine } from '../core/engine';
import { emptyWorkspace, MM, uid, type GateGeom, type PlotItem, type Population, type SheetItem, type Workspace } from '../core/model';
import { addDataset, newPlotItem, useStore } from './store';

export const DEMO_NAME = 'Example: T-cell activation (synthetic data)';

export function loadDemo() {
  const st = useStore.getState();
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  const base: Workspace = emptyWorkspace();
  base.name = DEMO_NAME;
  st.replaceWorkspace(base);
  const ids: string[] = [];
  for (const spec of DEMO_SAMPLES) {
    const ds = makeDemoDataset(spec);
    ids.push(addDataset(spec.name + '.fcs', ds.eventCount * ds.channels.length * 4, ds));
  }
  const [unstained, aUn, aSt, bUn, bSt] = ids;
  void unstained;

  const P = (name: string, parent: string | null, gate: GateGeom, color: string): Population => ({ id: uid('pop'), name, parentId: parent, gate, color });
  const cells = P('Cells', null, { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[215e3, 8e3], [1000e3, 8e3], [1060e3, 1060e3], [300e3, 1060e3], [175e3, 330e3]] }, '#d62728');
  const singlets = P('Singlets', cells.id, { type: 'polygon', x: 'FSC-A', y: 'FSC-H', points: [[150e3, 96e3], [1040e3, 720e3], [1040e3, 1040e3], [150e3, 175e3]] }, '#1f77b4');
  const live = P('Live', singlets.id, { type: 'range', x: 'KO525-A', min: -Infinity, max: 6000 }, '#2ca02c');
  const lymph = P('Lymphocytes', live.id, { type: 'polygon', x: 'PC5.5-A', y: 'SSC-A', points: [[16000, 25e3], [420000, 25e3], [420000, 215e3], [16000, 215e3]] }, '#9467bd');
  const tcells = P('T cells', lymph.id, { type: 'rect', x: 'FITC-A', y: 'SSC-A', xmin: 5500, xmax: Infinity, ymin: -Infinity, ymax: Infinity }, '#ff7f0e');
  const gid = uid('quad');
  const quads = (
    [
      ['UL', 'CD4- CD8+', '#1f77b4'],
      ['UR', 'CD4+ CD8+', '#d62728'],
      ['LR', 'CD4+ CD8-', '#2ca02c'],
      ['LL', 'CD4- CD8-', '#7f7f7f'],
    ] as const
  ).map(([q, n, c]) => P(n, tcells.id, { type: 'quadrant', x: 'PC7-A', y: 'PE-A', cx: 3200, cy: 4200, quadrant: q, groupId: gid }, c));
  const cd4 = quads[2];
  const cd69 = P('CD69+', cd4.id, { type: 'range', x: 'APC-A', min: 2600, max: Infinity }, '#d62728');
  const pops = [cells, singlets, live, lymph, tcells, ...quads, cd69];

  const g = 5 * MM; // grid 5 mm
  const W = 12 * g;
  const H = 11 * g;
  const col = (c: number) => g * 2 + c * (W + g);
  const row = (r: number) => g * 3 + r * (H + g * 1.5);
  const mk = (type: PlotItem['plotType'], x: string, y: string, c: number, r: number, pop: string): PlotItem => {
    const it = newPlotItem(type, x, y, col(c), row(r), W, H, pop);
    it.options.fontSize = 8;
    return it;
  };
  const items: SheetItem[] = [
    { id: uid('txt'), kind: 'text', x: g * 2, y: g * 0.6, w: g * 40, h: g * 2, text: 'T-cell activation panel (synthetic example data)', fontSize: 12, bold: true, italic: false, align: 'left', color: '' },
    mk('pseudo', 'FSC-A', 'SSC-A', 0, 0, 'root'),
    mk('pseudo', 'FSC-A', 'FSC-H', 1, 0, cells.id),
    mk('histogram', 'KO525-A', 'KO525-A', 2, 0, singlets.id),
    mk('pseudo', 'PC5.5-A', 'SSC-A', 3, 0, live.id),
    mk('pseudo', 'FITC-A', 'SSC-A', 0, 1, lymph.id),
    mk('pseudo', 'PC7-A', 'PE-A', 1, 1, tcells.id),
  ];
  const overlay = mk('histogram', 'APC-A', 'APC-A', 2, 1, cd4.id);
  overlay.layers = [
    { id: uid('ly'), sample: aUn, population: cd4.id, color: '#7f7f7f', label: 'unstim' },
    { id: uid('ly'), sample: aSt, population: cd4.id, color: '#d62728', label: 'stim' },
  ];
  overlay.options.title = 'Donor A: CD4+ T cells';
  items.push(overlay);
  const cd69Hist = mk('histogram', 'APC-A', 'APC-A', 3, 1, cd4.id);
  cd69Hist.options.histMode = 'count';
  items.push(cd69Hist);
  items.push({
    id: uid('stats'),
    kind: 'stats',
    x: col(0),
    y: row(2),
    w: g * 16,
    h: g * 6,
    sample: 'active',
    fontSize: 8,
    rows: [
      { id: uid('row'), population: lymph.id, stat: 'freqParent' },
      { id: uid('row'), population: tcells.id, stat: 'freqParent' },
      { id: uid('row'), population: cd4.id, stat: 'freqParent' },
      { id: uid('row'), population: cd69.id, stat: 'freqParent' },
      { id: uid('row'), population: cd4.id, stat: 'median', channel: 'APC-A', header: 'CD4+: median CD69' },
    ],
  });

  items.push({
    id: uid('chart'),
    kind: 'chart',
    x: col(1) + g * 4,
    y: row(2),
    w: g * 10,
    h: g * 11,
    stat: { id: uid('col'), population: cd69.id, stat: 'freqParent' },
    mode: 'groups',
    sampleSet: 'all',
    style: 'dot',
    errorBars: 'sd',
    showPoints: true,
    color: '#5b8fd1',
    useGroupColors: true,
    title: 'CD69^+ of CD4^+ T cells',
    yLabel: '% CD69^+',
    fontSize: 8,
    lineWidth: 1,
  });
  st.update((ws) => {
    ws.groups = [
      { id: uid('grp'), name: 'unstim', color: '#7f7f7f', sampleIds: [aUn, bUn] },
      { id: uid('grp'), name: 'stim', color: '#d62728', sampleIds: [aSt, bSt] },
    ];
    ws.populations = pops;
    ws.channelLabels = { 'KO525-A': 'Viability dye' };
    const sh = ws.worksheets[0];
    sh.name = 'Gating';
    sh.grid = g;
    sh.items = items;
    ws.tables = [
      {
        id: uid('tbl'),
        name: 'Frequencies',
        sampleSet: 'all',
        columns: [
          ...[lymph, tcells, ...quads.slice(0, 3), cd69].map((p) => ({ id: uid('col'), population: p.id, stat: 'freqParent' as const })),
          { id: uid('col'), population: cd4.id, stat: 'median' as const, channel: 'APC-A' },
          { id: uid('col'), population: cd4.id, stat: 'rcv' as const, channel: 'APC-A' },
        ],
      },
    ];
  });
  const after = useStore.getState().ws;
  st.setUI({ activeSampleId: aSt, activeSheetId: after.worksheets[0].id, activeTableId: after.tables[0].id, selectedItemIds: [], selectedPopId: null, view: 'sheet', dataVersion: st.ui.dataVersion + 1, missingFiles: [] });
  // demo history should not be undoable into an empty state
  useStore.setState({ past: [], future: [] });
}

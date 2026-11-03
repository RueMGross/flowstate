import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { strFromU8, unzipSync } from 'fflate';
import { parseFcs, type FcsDataset } from '../src/core/fcs';
import { Engine } from '../src/core/engine';
import { emptyWorkspace, type Population, type Workspace } from '../src/core/model';
import { channelStats } from '../src/core/stats';
import { mapChannelName } from '../src/core/matrixio';
import { cytExpertXitPopulations, parseCytExpertXit, splitPolygon, type XitContent, type XitGate } from '../src/core/cytexpert';
import { buildFcs } from './fcsBuilder';

// ------------------------------------------------------------------ a minimal MS-NRBF writer for synthetic .xit files

type N =
  | { t: 'cls'; name: string; m: [string, N][] }
  | { t: 'str'; v: string }
  | { t: 'i32'; v: number }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'arr'; v: N[] };

const enc = new TextEncoder();
const i32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return [...b];
};
const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...b];
};
const lps = (s: string) => {
  const u = enc.encode(s);
  const len: number[] = [];
  for (let n = u.length; ; n >>= 7) {
    if (n < 0x80) {
      len.push(n);
      break;
    }
    len.push((n & 0x7f) | 0x80);
  }
  return [...len, ...u];
};
const cls = (name: string, m: [string, N][]): N => ({ t: 'cls', name, m });
const str = (v: string): N => ({ t: 'str', v });
const int = (v: number): N => ({ t: 'i32', v });
const sng = (v: number): N => ({ t: 'f32', v });
const list = (itemType: string, items: N[]): N =>
  cls(`System.Collections.Generic.List\`1[[${itemType}]]`, [
    ['_items', { t: 'arr', v: items }],
    ['_size', int(items.length)],
    ['_version', int(1)],
  ]);
const enumOf = (name: string, v: number) => cls(name, [['value__', int(v)]]);

/** One BinaryFormatter stream with `root` as object 1 (classes in library 2, every member typed). */
function stream(root: N): number[] {
  let next = 100;
  const out: number[] = [0, ...i32(1), ...i32(-1), ...i32(1), ...i32(0), 12, ...i32(2), ...lps('Synthetic, Version=1.0.0.0')];
  const rec = (n: N, id = next++): void => {
    if (n.t === 'cls') {
      out.push(5, ...i32(id), ...lps(n.name), ...i32(n.m.length));
      for (const [k] of n.m) out.push(...lps(k));
      const bt = (v: N) => (v.t === 'i32' || v.t === 'f32' || v.t === 'bool' ? 0 : v.t === 'str' ? 1 : 2);
      for (const [, v] of n.m) out.push(bt(v));
      for (const [, v] of n.m) if (bt(v) === 0) out.push(v.t === 'i32' ? 8 : v.t === 'f32' ? 11 : 1);
      out.push(...i32(2));
      for (const [, v] of n.m) {
        if (v.t === 'i32') out.push(...i32(v.v));
        else if (v.t === 'f32') out.push(...f32(v.v));
        else if (v.t === 'bool') out.push(v.v ? 1 : 0);
        else rec(v);
      }
    } else if (n.t === 'str') out.push(6, ...i32(id), ...lps(n.v));
    else if (n.t === 'arr') {
      out.push(16, ...i32(id), ...i32(n.v.length));
      for (const e of n.v) rec(e);
    } else throw new Error('test writer: a primitive cannot be a record');
  };
  rec(root, 1);
  out.push(11);
  return out;
}

const pt = (x: number, y: number) =>
  cls('System.Drawing.PointF', [
    ['x', sng(x)],
    ['y', sng(y)],
  ]);
/** GraphInfo: m_Type 1 rectangle / 2 polygon / other; points = drawn vertices followed by the outline (polygons). */
const graph = (type: number, pts: [number, number][], outlineCount: number) =>
  cls('CMN_Graph_2D.GraphInfo', [
    [
      'm_ListPoint',
      list(
        'System.Drawing.PointF, System.Drawing',
        pts.map(([x, y]) => pt(x, y)),
      ),
    ],
    ['m_PointCountInterpolation', int(outlineCount)],
    ['m_Type', enumOf('CMN_Graph_2D.GraphType', type)],
  ]);
const signal = (name: string) => cls('CTG_Signal_RDC.SignalInfo', [['m_signalName', str(name)]]);

interface GateSpec {
  uid: string;
  name: string;
  parent: string;
  x: string;
  y: string;
  type: number;
  pts: [number, number][];
  outline: number;
  filter?: number;
}

/** The streams CytExpert writes per gate: GateType, GraphType, GraphInfo, Int32, GateInfo. */
function gateStreams(g: GateSpec): number[] {
  return [
    ...stream(enumOf('CTG_Gate_RDC.GateType', 0)),
    ...stream(enumOf('CMN_Graph_2D.GraphType', g.type)),
    ...stream(graph(g.type, g.pts, g.outline)),
    ...stream(cls('System.Int32', [['m_value', int(1)]])),
    ...stream(
      cls('CTG_Gate_RDC.GateInfo', [
        ['m_UID', str(g.uid)],
        ['m_Type', enumOf('CTG_Gate_RDC.GateType', 0)],
        ['m_IndexPart', int(0)],
        ['m_Filter', enumOf('CTG_Gate_RDC.GateFilter', g.filter ?? 0)],
        ['m_ParentGateUID', str(g.parent)],
        ['m_Name', str(g.name)],
        ['m_SignalX', signal(g.x)],
        ['m_SignalY', signal(g.y)],
      ]),
    ),
  ];
}

// gate geometry of the fixture (raw units). Bead A: drawn as a square, its stored outline adds a peak above it, so
// events in the peak are counted only when the outline is used.
const SQUARE: [number, number][] = [
  [1000, 1000],
  [2000, 1000],
  [2000, 2000],
  [1000, 2000],
];
const PEAKED: [number, number][] = [
  [1000, 1000],
  [2000, 1000],
  [2000, 2000],
  [1500, 2600],
  [1000, 2000],
];
const MOVED: [number, number][] = [
  [1400, 2200],
  [1600, 2200],
  [1600, 2400],
  [1400, 2400],
];
const FX = 'B525-FITC-A';
const FY = 'Y585-PE-A';
const GATES: GateSpec[] = [
  {
    uid: 'g-single',
    name: 'Single beads',
    parent: '',
    x: 'FSC-A',
    y: 'SSC-A',
    type: 1,
    pts: [
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200],
    ],
    outline: 0,
  },
  { uid: 'g-a', name: 'Bead A', parent: 'g-single', x: FX, y: FY, type: 2, pts: [...SQUARE, ...PEAKED], outline: PEAKED.length },
  {
    uid: 'g-b',
    name: 'Bead B',
    parent: 'g-single',
    x: FX,
    y: FY,
    type: 2,
    pts: [
      [4000, 4000],
      [6000, 4000],
      [5000, 6000],
      [4000, 4000],
      [6000, 4000],
      [5000, 6000],
    ],
    outline: 3,
  },
  {
    uid: 'g-inv',
    name: 'Filtered',
    parent: 'g-single',
    x: FX,
    y: FY,
    type: 1,
    pts: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    outline: 0,
    filter: 1,
  },
  {
    uid: 'g-inv-child',
    name: 'Under filtered',
    parent: 'g-inv',
    x: FX,
    y: FY,
    type: 1,
    pts: [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ],
    outline: 0,
  },
  {
    uid: 'g-ell',
    name: 'Ellipse',
    parent: 'g-single',
    x: FX,
    y: FY,
    type: 3,
    pts: [
      [0, 0],
      [1, 1],
    ],
    outline: 0,
  },
];
const TUBES = [
  { uid: 't-1', name: 'Tube A1', file: 't1.fcs' },
  { uid: 't-2', name: 'Tube A2', file: 't2.fcs' },
];

function syntheticXit(): Uint8Array {
  const bytes: number[] = [];
  bytes.push(
    ...stream(
      list(
        'CTG_Tube_RDC.TubeSummaryInfo, CTG_Tube_RDC',
        TUBES.map((t) =>
          cls('CTG_Tube_RDC.TubeSummaryInfo', [
            ['m_Name', str(t.name)],
            ['m_FileName', str(t.file)],
            ['m_UID', str(t.uid)],
            ['m_EventCount', int(29)],
            ['m_Volume', sng(120)],
          ]),
        ),
      ),
    ),
  );
  for (const g of GATES) bytes.push(...gateStreams(g));
  // per tube: the shapes of all gates; tube 2 has its own position of Bead A
  const tubeGraphs = (t: (typeof TUBES)[number]) =>
    cls('CTG_TubeGateVisible_RDC.TubeGateVisibleInfo', [
      [
        'm_ListGateUID',
        list(
          'System.String, mscorlib',
          GATES.map((g) => str(g.uid)),
        ),
      ],
      [
        'm_ListGraph',
        list(
          'CMN_Graph_2D.GraphInfo, CMN_Graph_2D',
          GATES.map((g) => (t.uid === 't-2' && g.uid === 'g-a' ? graph(2, [...MOVED, ...MOVED], MOVED.length) : graph(g.type, g.pts, g.outline))),
        ),
      ],
      ['m_TubeUID', str(t.uid)],
    ]);
  bytes.push(...stream(list('CTG_TubeGateVisible_RDC.TubeGateVisibleInfo, CTG_TubeGateVisible_RDC', TUBES.map(tubeGraphs))));
  // CytExpert's trailer (integrity text and checksum) is not NRBF
  bytes.push(...[...'CytExpertIntegrityCheck'].flatMap((c) => [c.charCodeAt(0), 0, 0, 0]), 1, 2, 3, 4);
  return new Uint8Array(bytes);
}

/** Events of each fixture tube: [FSC-A, SSC-A, FITC, PE, APC]; Bead A count 10 with its outline, 7 with its square. */
function syntheticEvents(): number[][] {
  const ev: number[][] = [];
  for (let k = 0; k < 10; k++) ev.push([50, 150, 1500, 1500, 999]); // outside Single beads, inside Bead A
  for (let k = 0; k < 7; k++) ev.push([150, 150, 1200 + 80 * k, 1500, 10 * (k + 1)]); // Bead A square: 10..70
  for (let k = 0; k < 3; k++) ev.push([150, 150, 1500, 2300, 100]); // Bead A peak only
  for (let k = 0; k < 4; k++) ev.push([150, 150, 5000, 4500, 7]); // Bead B
  for (let k = 0; k < 5; k++) ev.push([150, 150, 100, 100, 3]); // single beads, no bead gate
  return [0, 1, 2, 3, 4].map((c) => ev.map((e) => e[c]));
}

function syntheticFcs(well: string): FcsDataset {
  const bytes = buildFcs({
    version: 'FCS3.1',
    pars: [
      { name: 'FSC-A', s: 'FSC-A', range: 1e6 },
      { name: 'SSC-A', s: 'SSC-A', range: 1e6 },
      { name: 'FL1-A', s: FX, range: 1e6 },
      { name: 'FL2-A', s: FY, range: 1e6 },
      { name: 'FL3-A', s: 'R660-APC-A', range: 1e6 },
    ],
    data: syntheticEvents(),
    kw: { $SMNO: well },
  });
  return parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

// ------------------------------------------------------------------ tests on synthetic data (run in CI)

describe('splitPolygon', () => {
  const pts: [number, number][] = [
    [0, 0],
    [2, 0],
    [1, 2],
    [0, 0],
    [1, 0],
    [2, 0],
    [1.5, 1],
    [1, 2],
    [0.5, 1],
  ];
  it('separates drawn vertices from the outline at the repeat of the first vertex', () => {
    const p = splitPolygon(pts);
    expect(p.vertices.length).toBe(3);
    expect(p.outline.length).toBe(6);
  });
  it('uses the stored outline length and reports a disagreement', () => {
    expect(splitPolygon(pts, 6)).toMatchObject({ consistent: true });
    const odd = splitPolygon(pts, 5);
    expect(odd.outline.length).toBe(5);
    expect(odd.consistent).toBe(false);
  });
  it('keeps a list without a repeated first vertex as it is', () => {
    const p = splitPolygon([
      [0, 0],
      [2, 0],
      [1, 2],
    ]);
    expect(p.vertices).toEqual(p.outline);
  });
});

describe('cytExpertXitPopulations', () => {
  const gate = (uid: string, parent: string): XitGate => ({
    uid,
    name: uid,
    parent,
    x: 'A',
    y: 'B',
    shape: 'rect',
    shapeType: 1,
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    vertices: [],
    gateType: 0,
    filter: 0,
    indexPart: 0,
  });
  it('links a child stored before its parent and lists parents first', () => {
    const c: XitContent = { gates: [gate('child', 'parent'), gate('parent', '')], tubes: [], notes: [] };
    const r = cytExpertXitPopulations(c, []);
    expect(r.populations.map((p) => p.name)).toEqual(['parent', 'child']);
    expect(r.populations[1].parentId).toBe(r.populations[0].id);
    expect(r.warnings).toEqual([]);
  });
  it('imports a gate with a missing parent at the top level, with a warning', () => {
    const r = cytExpertXitPopulations({ gates: [gate('g', 'nope')], tubes: [], notes: [] }, []);
    expect(r.populations[0].parentId).toBeNull();
    expect(r.warnings.length).toBe(1);
  });
  it('skips the children of a gate that cannot be read', () => {
    const p = { ...gate('p', ''), shape: 'other' as const };
    expect(cytExpertXitPopulations({ gates: [p, gate('c', 'p')], tubes: [], notes: [] }, []).populations.length).toBe(0);
  });
});

describe('synthetic CytExpert experiment (.xit)', () => {
  const xit = parseCytExpertXit(syntheticXit());
  const byName = (n: string) => xit.gates.find((g) => g.name === n)!;

  it('reads gates, shapes, tubes and tube-specific shapes', () => {
    expect(xit.gates.map((g) => g.name)).toEqual(GATES.map((g) => g.name));
    expect(byName('Single beads')).toMatchObject({ shape: 'rect', x: 'FSC-A', y: 'SSC-A', parent: '' });
    expect(byName('Bead A')).toMatchObject({ shape: 'polygon', parent: 'g-single', x: FX, y: FY });
    expect(byName('Bead A').points).toEqual(PEAKED);
    expect(byName('Bead A').vertices).toEqual(SQUARE);
    expect(xit.tubes.map((t) => [t.uid, t.fileName])).toEqual(TUBES.map((t) => [t.uid, t.file]));
    expect(Object.keys(xit.tubes[0].shapes)).toEqual([]);
    expect(xit.tubes[1].shapes['g-a']).toEqual(MOVED);
  });

  it('skips gates whose meaning is unknown, with notes', () => {
    expect(byName('Filtered').shape).toBe('other');
    expect(byName('Ellipse').shape).toBe('other');
    expect(xit.notes.some((n) => n.includes('"Filtered"') && n.includes('filter 1'))).toBe(true);
    expect(xit.notes.some((n) => n.includes('"Ellipse" (type 3)'))).toBe(true);
  });

  it('counts like CytExpert: outline in linear space, tube-specific shape as a sample override', () => {
    const eng = new Engine();
    const ws: Workspace = emptyWorkspace();
    const datasets = TUBES.map((t, k) => ({ t, ds: syntheticFcs(`A${k + 1}`) }));
    for (const { t, ds } of datasets) {
      eng.addSample(t.file, ds);
      ws.samples.push({ id: t.file, name: t.name, fileName: t.file, fileSize: 0, eventCount: ds.eventCount, channels: [], compId: null });
    }
    const chans = datasets[0].ds.channels.map((c) => ({ name: c.name, label: c.label }));
    const imp = cytExpertXitPopulations(
      xit,
      chans,
      ws.samples.map((s) => ({ id: s.id, fileName: s.fileName })),
    );
    // the notes of the skipped gates, and nothing else (all parameters and tubes matched)
    expect(imp.warnings.length).toBe(3);
    expect(imp.warnings.some((w) => w.includes('"Under filtered" was skipped because its parent gate was skipped'))).toBe(true);
    expect(imp.populations.map((p) => p.name)).toEqual(['Single beads', 'Bead A', 'Bead B']);
    ws.populations = imp.populations;
    const pop = (n: string) => ws.populations.find((p: Population) => p.name === n)!.id;
    expect(Object.keys(ws.populations[1].overrides ?? {})).toEqual(['t2.fcs']);
    const count = (s: string, n: string) => eng.population(ws, s, pop(n)).length;
    // tube 1: shared shapes
    expect(count('t1.fcs', 'Single beads')).toBe(19);
    expect(count('t1.fcs', 'Bead A')).toBe(10); // 7 in the drawn square + 3 in the outline's peak
    expect(count('t1.fcs', 'Bead B')).toBe(4);
    const apc = datasets[0].ds.channels.findIndex((c) => c.label === 'R660-APC-A');
    expect(channelStats(datasets[0].ds.data[apc], eng.population(ws, 't1.fcs', pop('Bead A'))).median).toBe(55);
    // tube 2: its own position of Bead A covers only the peak
    expect(count('t2.fcs', 'Bead A')).toBe(3);
    expect(count('t2.fcs', 'Bead B')).toBe(4);
  });
});

// ------------------------------------------------------------------ opt-in check against a real CytExpert export
//
// CYTEXPERT_TESTDATA = a local folder (never committed) with one .xit, its FCS files (any subfolder) and CytExpert's
// statistics export (.csv or .xlsx; a header row starting with "Tube Name"). Columns "<gate> Events" are compared
// exactly, "<gate> Median <parameter>" within the export's rounding, and "<gate> % Parent" against the parent's count.

const REAL = process.env.CYTEXPERT_TESTDATA;
const HAVE_REAL = !!REAL && existsSync(REAL);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** Rows of a CytExpert statistics export as cell texts (the stored text keeps the export's decimals). */
function readExport(path: string): string[][] {
  if (path.toLowerCase().endsWith('.csv')) {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    return text.split(/\r?\n/).map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()));
  }
  const zip = unzipSync(new Uint8Array(readFileSync(path)));
  const shared = zip['xl/sharedStrings.xml']
    ? [...strFromU8(zip['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''),
      )
    : [];
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  const rows: string[][] = [];
  for (const c of sheet.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const col = [...c[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(c[2]) - 1;
    const v = c[4]?.match(/<v>([^<]*)<\/v>/)?.[1] ?? c[4]?.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
    (rows[row] ??= [])[col] = /t="s"/.test(c[3]) ? (shared[Number(v)] ?? '') : v;
  }
  return Array.from(rows, (r) => Array.from(r ?? [], (x) => x ?? ''));
}

/** Well at the end of a tube name ("...-A1", "A01") or the $SMNO keyword, as "A1"; else the name itself. */
const tubeKey = (s: string) => {
  const m = s.trim().match(/([A-P])0*(\d{1,2})$/i);
  return m ? `${m[1].toUpperCase()}${Number(m[2])}` : s.trim().toLowerCase();
};

describe.skipIf(!HAVE_REAL)('real CytExpert experiment (opt-in: CYTEXPERT_TESTDATA)', () => {
  it('reproduces the CytExpert statistics export', () => {
    const files = filesUnder(REAL!);
    const xitFiles = files.filter((f) => /\.xit$/i.test(f));
    expect(xitFiles.length, 'exactly one .xit in the folder').toBe(1);
    const xit = parseCytExpertXit(new Uint8Array(readFileSync(xitFiles[0])));
    const exp = files
      .filter((f) => /\.(csv|xlsx)$/i.test(f))
      .map(readExport)
      .find((rows) => rows.some((r) => /^Tube Name/i.test(r[0] ?? '')));
    expect(exp, 'a CytExpert export with a "Tube Name" header row').toBeTruthy();
    const h = exp!.findIndex((r) => /^Tube Name/i.test(r[0] ?? ''));
    const header = exp![h];
    const rows = exp!.slice(h + 1).filter((r) => r[0]);

    const eng = new Engine();
    const ws = emptyWorkspace();
    const byKey = new Map<string, { id: string; ds: FcsDataset }>();
    for (const f of files.filter((x) => /\.fcs$/i.test(x))) {
      const buf = readFileSync(f);
      const ds = parseFcs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      const id = f;
      eng.addSample(id, ds);
      ws.samples.push({ id, name: f, fileName: f.split(/[\\/]/).pop()!, fileSize: buf.length, eventCount: ds.eventCount, channels: [], compId: null });
      const kw = ds.keywords['$SMNO'] ?? ds.keywords['SMNO'];
      const base = f.split(/[\\/]/).pop()!.replace(/\.fcs$/i, '');
      const key = tubeKey(kw ?? base);
      expect(byKey.has(key), `two FCS files for tube ${key}`).toBe(false);
      byKey.set(key, { id, ds });
    }
    const anyDs = [...byKey.values()][0].ds;
    const chans = anyDs.channels.map((c) => ({ name: c.name, label: c.label }));
    const imp = cytExpertXitPopulations(
      xit,
      chans,
      ws.samples.map((s) => ({ id: s.id, fileName: s.fileName })),
    );
    ws.populations = imp.populations;
    const popByName = new Map(ws.populations.map((p) => [p.name, p]));

    let counts = 0,
      countBad = 0,
      medians = 0,
      medBad = 0,
      parents = 0,
      parentBad = 0;
    const unmatched: string[] = [];
    for (const r of rows) {
      const s = byKey.get(tubeKey(r[0]));
      if (!s) {
        unmatched.push(r[0]);
        continue;
      }
      header.forEach((col, k) => {
        const cell = (r[k] ?? '').trim();
        let m = col.match(/^(.*) Events$/);
        if (m && popByName.has(m[1])) {
          counts++;
          if (eng.population(ws, s.id, popByName.get(m[1])!.id).length !== Number(cell)) countBad++;
          return;
        }
        m = col.match(/^(.*) Median (.+)$/);
        if (m && popByName.has(m[1])) {
          const ch = mapChannelName(m[2], chans)?.channel;
          const ci = s.ds.channels.findIndex((c) => c.name === ch);
          if (ci < 0) return;
          medians++;
          const st = channelStats(s.ds.data[ci], eng.population(ws, s.id, popByName.get(m[1])!.id));
          const v = Number(cell);
          if (!Number.isFinite(v)) {
            if (st.n) medBad++; // "####": no events
            return;
          }
          const decimals = cell.includes('.') ? cell.split('.')[1].length : 0;
          if (!(Math.abs(st.median - v) <= 0.5 * 10 ** -decimals + 2e-7 * Math.abs(v))) medBad++;
          return;
        }
        m = col.match(/^(.*) % Parent$/);
        if (m && popByName.has(m[1])) {
          const p = popByName.get(m[1])!;
          const pct = parseFloat(cell);
          const n = eng.population(ws, s.id, p.id).length;
          if (!p.parentId || !(pct > 0) || !n) return;
          parents++;
          const step = 0.5 * 10 ** -(cell.split('.')[1]?.replace('%', '').length ?? 0);
          const parentN = eng.population(ws, s.id, p.parentId).length;
          const lo = n / ((pct + step) / 100);
          const hi = n / ((pct - step) / 100);
          if (parentN < Math.ceil(lo - 1e-9) || parentN > Math.floor(hi + 1e-9)) parentBad++;
        }
      });
    }
    console.log(
      `real-data check: ${rows.length} tubes, ${counts} counts (${countBad} differ), ${medians} medians (${medBad} differ), ${parents} parent checks (${parentBad} outside), unmatched tubes: ${unmatched.length}`,
    );
    expect(unmatched).toEqual([]);
    expect(counts).toBeGreaterThan(0);
    expect(countBad).toBe(0);
    expect(medBad).toBe(0);
    expect(parentBad).toBe(0);
  }, 300000);
});

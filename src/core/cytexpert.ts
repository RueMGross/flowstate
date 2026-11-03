// Gates of a CytExpert experiment file (.xit): the gate tree with its shapes, and tube-specific shapes.
//
// Format notes (CytExpert 2.7, CytoFLEX LX; checked against CytExpert's own statistics export of a real experiment with
// the opt-in test in tests/cytexpert_xit.test.ts; the synthetic test there covers every case below):
//   - Like a .comp file, a .xit is a series of .NET BinaryFormatter streams (see nrbf.ts) followed by a trailer that is
//     not NRBF ("CytExpertIntegrityCheck" in UTF-32LE and a checksum; ignored).
//   - The gate tree is stored gate by gate, as consecutive streams:
//       CTG_Gate_RDC.GateType, CMN_Graph_2D.GraphType, CMN_Graph_2D.GraphInfo (the shape), System.Int32 (1),
//       CTG_Gate_RDC.GateInfo (name, m_UID, m_ParentGateUID, m_SignalX / m_SignalY).
//     No field links a shape to its gate: the shape is the one GraphInfo stream right before the GateInfo. A gate with
//     no shape or several shapes before it is skipped (with a note) rather than given a guessed shape.
//   - GateInfo.m_Type, m_Filter and m_IndexPart were 0 in every gate seen; a gate with another value is skipped with a
//     note, because what it changes (e.g. an inverted gate, a quadrant part) is not known.
//   - GraphInfo.m_ListPoint is a List<PointF> in raw (linear) data units. m_Type 1 = rectangle (4 corners),
//     2 = polygon; other types are skipped with a note. A polygon's point list holds the drawn vertices, then the
//     closed outline densely interpolated; m_PointCountInterpolation is the outline's length, and the outline starts by
//     repeating the first vertex (cross-check). CytExpert counts events against the outline, tested in linear data
//     space: that reproduces CytExpert's exported counts exactly, while the drawn vertices (straight edges) or a log
//     space do not.
//   - GateInfo.m_SignalX / m_SignalY: SignalInfo with m_signalName = the detector parameter as CytExpert names it
//     ("FSC-A", "B525-FITC-A"); FCS files carry it as $PnS, so it is matched to the samples' channels by label.
//   - Tube-specific shapes: a List<TubeGateVisibleInfo> per experiment, one entry per tube (m_TubeUID) with parallel
//     lists m_ListGateUID / m_ListGraph. The tube UID is the FCS keyword TBID; TubeSummaryInfo (m_UID, m_FileName,
//     m_Name) links it to the data file. A tube shape that differs from the gate's own becomes a sample override.
//   - Only rectangle and polygon shapes are read; other shapes (and their child gates) are reported and skipped.

import { parseNrbf, type NrbfClass, type NrbfValue } from './nrbf';
import { mapChannelName, type ChannelRef } from './matrixio';
import { GATE_COLORS, uid, type GateGeom, type Population, type Pt } from './model';

export interface XitGate {
  uid: string;
  name: string;
  /** parent gate uid ('' = all events) */
  parent: string;
  /** CytExpert parameter names ("B525-FITC-A") */
  x: string;
  y: string;
  shape: 'rect' | 'polygon' | 'other';
  /** shape type number as stored (GraphInfo.m_Type) */
  shapeType: number;
  /** for polygons: the outline CytExpert counts with (interpolated); for rectangles: the 4 corners */
  points: Pt[];
  /** the drawn vertices of a polygon (informational) */
  vertices: Pt[];
  /** GateInfo.m_Type, m_Filter, m_IndexPart: 0 in all gates seen so far; other values have an unknown meaning */
  gateType: number;
  filter: number;
  indexPart: number;
}

export interface XitTube {
  uid: string;
  name: string;
  fileName: string;
  eventCount?: number;
  volume?: number;
  /** gate uid -> shape points of this tube, only where they differ from the gate's own */
  shapes: Record<string, Pt[]>;
}

export interface XitContent {
  gates: XitGate[];
  tubes: XitTube[];
  notes: string[];
}

const isClass = (v: NrbfValue | undefined, re?: RegExp): v is NrbfClass => !!v && typeof v === 'object' && v.kind === 'class' && (!re || re.test(v.className));

const str = (v: NrbfValue | undefined): string => (typeof v === 'string' ? v : '');
const numOf = (v: NrbfValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const enumVal = (v: NrbfValue | undefined): number => (isClass(v) ? (numOf(v.members['value__']) ?? -1) : -1);

/** Items of a serialized System.Collections.Generic.List<T> (only the first _size entries are used). */
function listItems(v: NrbfValue | undefined): NrbfValue[] {
  if (!isClass(v)) return [];
  const items = v.members['_items'];
  const size = numOf(v.members['_size']) ?? 0;
  if (!items || typeof items !== 'object' || items.kind !== 'array') return [];
  return items.values.slice(0, size);
}

function graphPoints(g: NrbfClass): Pt[] {
  return listItems(g.members['m_ListPoint']).map((p) =>
    isClass(p) ? ([numOf(p.members['x']) ?? NaN, numOf(p.members['y']) ?? NaN] as Pt) : ([NaN, NaN] as Pt),
  );
}

const samePt = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= 1e-6 * Math.max(1, Math.abs(a[0])) && Math.abs(a[1] - b[1]) <= 1e-6 * Math.max(1, Math.abs(a[1]));

/** Split a stored polygon into its drawn vertices and the interpolated outline (from the repeat of the first vertex on). */
export function splitPolygon(pts: Pt[], outlineCount?: number): { vertices: Pt[]; outline: Pt[]; consistent: boolean } {
  let rep = -1;
  for (let i = 1; i < pts.length; i++)
    if (samePt(pts[i], pts[0])) {
      rep = i;
      break;
    }
  // GraphInfo.m_PointCountInterpolation gives the outline length (the last points of the list); the repeat of the
  // first vertex is the cross-check
  if (outlineCount && outlineCount >= 3 && outlineCount < pts.length) {
    const start = pts.length - outlineCount;
    return {
      vertices: pts.slice(0, start),
      outline: pts.slice(start),
      consistent: rep === start,
    };
  }
  if (rep > 0)
    return {
      vertices: pts.slice(0, rep),
      outline: pts.slice(rep),
      consistent: !outlineCount,
    };
  return { vertices: pts, outline: pts, consistent: !outlineCount };
}

function shapeOf(g: NrbfClass | undefined): {
  shape: XitGate['shape'];
  shapeType: number;
  points: Pt[];
  vertices: Pt[];
  consistent: boolean;
} {
  if (!g)
    return {
      shape: 'other',
      shapeType: -1,
      points: [],
      vertices: [],
      consistent: true,
    };
  const t = enumVal(g.members['m_Type']);
  const pts = graphPoints(g);
  if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
    return {
      shape: 'other',
      shapeType: t,
      points: [],
      vertices: [],
      consistent: true,
    };
  if (t === 1 && pts.length === 4) {
    // only an axis-aligned rectangle is a rectangle gate; anything else is kept as the polygon it describes
    const xs = new Set(pts.map((p) => p[0]));
    const ys = new Set(pts.map((p) => p[1]));
    if (xs.size === 2 && ys.size === 2)
      return {
        shape: 'rect',
        shapeType: t,
        points: pts,
        vertices: pts,
        consistent: true,
      };
    return {
      shape: 'polygon',
      shapeType: t,
      points: pts,
      vertices: pts,
      consistent: true,
    };
  }
  if (t === 2 && pts.length >= 3) {
    const { vertices, outline, consistent } = splitPolygon(pts, numOf(g.members['m_PointCountInterpolation']));
    return {
      shape: 'polygon',
      shapeType: t,
      points: outline.length >= 3 ? outline : vertices,
      vertices,
      consistent,
    };
  }
  return {
    shape: 'other',
    shapeType: t,
    points: pts,
    vertices: pts,
    consistent: true,
  };
}

const samePoints = (a: Pt[], b: Pt[]) => a.length === b.length && a.every((p, i) => samePt(p, b[i]));

/** The gates and tubes of a CytExpert experiment file (see the format notes at the top of this file). */
export function parseCytExpertXit(bytes: Uint8Array): XitContent {
  const { roots } = parseNrbf(bytes);
  const notes: string[] = [];
  const gates: XitGate[] = [];
  let lastGraph: NrbfClass | undefined;
  let graphsSinceGate = 0;
  let tubeGates: NrbfValue[] = [];
  const tubeInfo = new Map<string, { name: string; fileName: string; eventCount?: number; volume?: number }>();
  for (const r of roots) {
    if (isClass(r, /^CMN_Graph_2D\.GraphInfo$/)) {
      lastGraph = r;
      graphsSinceGate++;
    } else if (isClass(r, /^CTG_Gate_RDC\.GateInfo$/)) {
      const sx = r.members['m_SignalX'];
      const sy = r.members['m_SignalY'];
      const s = shapeOf(lastGraph);
      const name0 = str(r.members['m_Name']) || `Gate ${gates.length + 1}`;
      // the shape is linked to its gate only by stream order (no shared id found): one shape per gate is expected
      if (graphsSinceGate !== 1) {
        notes.push(`Gate "${name0}": ${graphsSinceGate} shapes precede it in the file instead of 1; it was skipped (shape assignment uncertain)`);
        s.shape = 'other';
      }
      if (!s.consistent) notes.push(`Gate "${name0}": the stored outline length and the outline found in the point list disagree; the stored length was used`);
      graphsSinceGate = 0;
      gates.push({
        uid: str(r.members['m_UID']),
        name: name0,
        parent: str(r.members['m_ParentGateUID']),
        x: isClass(sx) ? str(sx.members['m_signalName']) : '',
        y: isClass(sy) ? str(sy.members['m_signalName']) : '',
        shape: s.shape,
        shapeType: s.shapeType,
        points: s.points,
        vertices: s.vertices,
        gateType: enumVal(r.members['m_Type']),
        filter: enumVal(r.members['m_Filter']),
        indexPart: numOf(r.members['m_IndexPart']) ?? 0,
      });
      lastGraph = undefined;
    } else if (isClass(r, /^System\.Collections\.Generic\.List`1\[\[CTG_TubeGateVisible_RDC\.TubeGateVisibleInfo/)) tubeGates = listItems(r);
    else if (isClass(r, /^System\.Collections\.Generic\.List`1\[\[CTG_Tube_RDC\.TubeSummaryInfo/))
      for (const t of listItems(r))
        if (isClass(t))
          tubeInfo.set(str(t.members['m_UID']), {
            name: str(t.members['m_Name']),
            fileName: str(t.members['m_FileName']),
            eventCount: numOf(t.members['m_EventCount']),
            volume: numOf(t.members['m_Volume']),
          });
  }
  if (!gates.length) notes.push('The experiment file holds no gates');
  const byUid = new Map(gates.map((g) => [g.uid, g]));
  const tubes: XitTube[] = [];
  for (const t of tubeGates) {
    if (!isClass(t)) continue;
    const tid = str(t.members['m_TubeUID']);
    const ids = listItems(t.members['m_ListGateUID']).map(str);
    const graphs = listItems(t.members['m_ListGraph']);
    const shapes: Record<string, Pt[]> = {};
    ids.forEach((gid, k) => {
      const g = byUid.get(gid);
      const gr = graphs[k];
      if (!g || g.shape === 'other' || !isClass(gr)) return;
      const s = shapeOf(gr);
      if (s.shape === g.shape && !samePoints(s.points, g.points)) shapes[gid] = s.points;
    });
    const info = tubeInfo.get(tid);
    tubes.push({
      uid: tid,
      name: info?.name ?? '',
      fileName: info?.fileName ?? '',
      eventCount: info?.eventCount,
      volume: info?.volume,
      shapes,
    });
  }
  for (const [tid, info] of tubeInfo) if (!tubes.some((t) => t.uid === tid)) tubes.push({ uid: tid, ...info, shapes: {} });
  for (const g of gates)
    if (g.shape !== 'other' && (g.gateType !== 0 || g.filter !== 0 || g.indexPart !== 0)) {
      notes.push(
        `Gate "${g.name}" has settings whose meaning is not known yet (type ${g.gateType}, filter ${g.filter}, part ${g.indexPart}); it was skipped rather than counted possibly wrongly`,
      );
      g.shape = 'other';
    }
  const other = gates.filter((g) => g.shape === 'other' && g.gateType === 0 && g.filter === 0 && g.indexPart === 0);
  if (other.length)
    notes.push(
      `${other.length} gate(s) with a shape that cannot be read yet were skipped: ${other.map((g) => `"${g.name}" (type ${g.shapeType})`).join(', ')}`,
    );
  return { gates, tubes, notes };
}

export interface XitImport {
  populations: Population[];
  warnings: string[];
  /** CytExpert gate uid -> population id */
  idMap: Record<string, string>;
}

/**
 * Populations from the gates of a .xit: parameter names matched to the samples' channels (`chans`; by $PnS label, as
 * CytExpert names them), polygons as strict gates evaluated on linear scales (CytExpert's own test), rectangles as
 * rectangle gates. Tube-specific shapes become overrides of the samples whose file name or TBID matches the tube
 * (`samples`).
 */
export function cytExpertXitPopulations(content: XitContent, chans: ChannelRef[], samples: { id: string; fileName: string; tbid?: string }[] = []): XitImport {
  const warnings = [...content.notes];
  const idMap: Record<string, string> = {};
  const chMap = new Map<string, string>();
  const unmapped = new Set<string>();
  const channel = (n: string) => {
    if (!chMap.has(n)) {
      const m = chans.length ? mapChannelName(n, chans) : null;
      if (!m && chans.length) unmapped.add(n);
      chMap.set(n, m ? m.channel : n);
    }
    return chMap.get(n)!;
  };
  const lin = { type: 'linear' as const, min: 0, max: 16777215 };
  const geom = (g: XitGate, pts: Pt[]): GateGeom => {
    const x = channel(g.x);
    const y = channel(g.y);
    if (g.shape === 'rect') {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return {
        type: 'rect',
        x,
        y,
        xmin: Math.min(...xs),
        xmax: Math.max(...xs),
        ymin: Math.min(...ys),
        ymax: Math.max(...ys),
      };
    }
    return {
      type: 'polygon',
      x,
      y,
      points: pts.map((p) => [p[0], p[1]] as Pt),
      scales: { x: lin, y: lin },
      strict: true,
    };
  };
  const skipped = new Set(content.gates.filter((g) => g.shape === 'other').map((g) => g.uid));
  // children of skipped gates are skipped too (their parent population would be missing)
  for (let changed = true; changed;) {
    changed = false;
    for (const g of content.gates)
      if (!skipped.has(g.uid) && g.parent && skipped.has(g.parent)) {
        skipped.add(g.uid);
        changed = true;
        warnings.push(`Gate "${g.name}" was skipped because its parent gate was skipped`);
      }
  }
  const sampleOfTube = (t: XitTube) => {
    const base = (f: string) =>
      f
        .replace(/\.fcs$/i, '')
        .trim()
        .toLowerCase();
    return samples.find((s) => (s.tbid && s.tbid === t.uid) || (!!t.fileName && base(s.fileName) === base(t.fileName)));
  };
  const pops: Population[] = [];
  // ids first, so that a child stored before its parent still finds it
  for (const g of content.gates) if (!skipped.has(g.uid)) idMap[g.uid] = uid('pop');
  const known = new Set(content.gates.map((g) => g.uid));
  for (const g of content.gates)
    if (g.parent && !known.has(g.parent)) warnings.push(`Gate "${g.name}": its parent gate is not in the file; imported at the top level`);
  // parents before children in the population list (FlowState's order for display)
  const order: XitGate[] = [];
  const placed = new Set<string>();
  const place = (g: XitGate, depth = 0) => {
    if (placed.has(g.uid) || depth > content.gates.length) return;
    const par = content.gates.find((x) => x.uid === g.parent);
    if (par) place(par, depth + 1);
    placed.add(g.uid);
    order.push(g);
  };
  content.gates.forEach((g) => place(g));
  order.forEach((g) => {
    if (skipped.has(g.uid)) return;
    const k = content.gates.indexOf(g);
    const id = idMap[g.uid];
    const p: Population = {
      id,
      name: g.name,
      parentId: g.parent ? (idMap[g.parent] ?? null) : null,
      gate: geom(g, g.points),
      color: GATE_COLORS[k % GATE_COLORS.length],
    };
    for (const t of content.tubes) {
      const pts = t.shapes[g.uid];
      if (!pts) continue;
      const s = sampleOfTube(t);
      if (!s) {
        warnings.push(`Tube "${t.name || t.uid}" has its own shape of gate "${g.name}", but no loaded sample matches it`);
        continue;
      }
      (p.overrides ??= {})[s.id] = geom(g, pts);
    }
    pops.push(p);
  });
  if (unmapped.size)
    warnings.push(
      `No loaded sample has the parameter(s) ${[...unmapped].map((n) => `"${n}"`).join(', ')}; gates on them count no events until such files are loaded`,
    );
  return { populations: pops, warnings, idMap };
}

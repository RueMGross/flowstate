// FlowJo v10 workspace (.wsp) import.
//
// FlowJo keeps one gating tree per sample. Populations are matched across samples by their path of names
// (e.g. Lymphocytes / Singlets / CD3+); the most common geometry becomes the population's gate and the other
// samples get sample-specific overrides. Where the trees differ (a population only some samples have), the population
// gets a scope (core/scope.ts): the FlowJo group with exactly those samples, else the samples; the others show it as n/a.
// Gate coordinates are read the way FlowJo evaluates them:
//   - rectangles: raw (compensated) values, min inclusive / max exclusive; a side at the edge of the axis is open,
//     because FlowJo shows off-scale events on the axis edge (also why polygons / ellipses are not strict);
//   - polygons: on FlowJo's gate grid (the gate's gateResolution, 256 or 1024 channels per axis; GateGrid in
//     transforms.ts) of the sample's display transform of each axis (g.scales): events and vertices as integer
//     channels, the outline included. This reproduces FlowJo's stored counts exactly; FlowKit's exact point-in-polygon
//     test (the app's evaluation before) differs by 0.1-1 % on scatter gates and up to 30 % on dim cytokine gates;
//   - ellipses: in the display transform of each axis (continuous, as FlowKit reads them; FlowJo's own ellipse
//     geometry is not documented); they come as foci + edge points in FlowJo's 256-channel display grid;
//   - quadrant gates (four rectangles with open sides) become quadrants, bisectors (two ranges) become splits;
//   - "Comp-<channel>" dimensions use the sample's spillover matrix, plain fluorescence dimensions are uncompensated;
//   - the Time axis is scaled by FlowJo's time gain (or $TIMESTEP), which FlowJo applies to the time ticks; the app
//     reads time in seconds (ticks x $TIMESTEP), so FlowJo values are converted by gain / $TIMESTEP;
//   - transforms: linear, log, logicle, arcsinh map to the app's scales; FlowJo's biex uses its exact lookup table.
//
// FlowJo 9 (Mac) workspaces (<Workspace version="2.0">, as read by CytoML / flowWorkspace) differ: populations nest
// directly (no <Subpopulations>), gates are <PolygonGate> with <ParameterNames> and one shape (<Polygon>, <PolyRect>,
// <Ellipse> = the four ends of the axes, <Range> = 1D) of raw-value vertices; the sample's <Parameter> elements and the
// workspace's <CalibrationTables> (4096-channel biex lookup tables, also per compensated parameter "<matrix> <FL1-A>")
// give the display transforms; samples refer to <CompensationMatrices> by compensationID (1-based; -1 = the file's
// acquisition matrix). The tables are matched by FlowJo biex parameters (fitFlowJoTable).
import { getSpillover } from './fcs';
import { child, childrenNamed, descendants, parseXml, type XNode } from './xml';
import {
  defaultPlotOptions,
  emptyWorkspace,
  GATE_COLORS,
  gateParams,
  MM,
  newWorksheet,
  uid,
  type CompDef,
  type PlotItem,
  type GateGeom,
  type Group,
  type Population,
  type Pt,
  type SampleChannel,
  type SampleRef,
  type Workspace,
} from './model';
import { flowJoBiexDef, flowJoBiexTable, isFlowJoBiexActive, Logicle, makeScale, withGateGrid, type FlowJoBiexParams, type ScaleDef } from './transforms';
import { instrumentKeyOf } from './instruments';

export interface FlowJoImportResult {
  workspace: Workspace;
  warnings: string[];
  /** FlowJo's stored event counts: sample id -> population id ('root' = all events) -> count (-1 = not computed). */
  counts: Record<string, Record<string, number>>;
}

/** True when an XML text is a FlowJo workspace (root element <Workspace>). */
export function isFlowJoWorkspaceXml(text: string): boolean {
  return /^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<Workspace[\s>/]/.test(text.slice(0, 4096));
}

// ------------------------------------------------------------------ helpers

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === '') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

/** Population-like nodes of a FlowJo gating tree. */
const POP_NODES = new Set(['Population', 'AndNode', 'OrNode', 'NotNode']);
const BOOL_OPS: Record<string, 'and' | 'or' | 'not'> = { AndNode: 'and', OrNode: 'or', NotNode: 'not' };

const INFO_KEYS: [string, string][] = [
  ['$DATE', 'Date'],
  ['$CYT', 'Cytometer'],
  ['$SRC', 'Source'],
  ['TUBE NAME', 'Tube'],
  ['$FIL', 'File'],
  ['$BTIM', 'Start'],
  ['$ETIM', 'End'],
  ['CREATOR', 'Software'],
  ['$OP', 'Operator'],
  ['$VOL', 'Volume'],
  ['WELL ID', 'Well'],
];

const isTime = (ch: string) => /^time$/i.test(ch.trim());

/** JSON key of a geometry (infinite bounds kept distinct). */
function geomKey(g: unknown): string {
  return JSON.stringify(g, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? `#${v}` : v));
}

function fileNameFromUri(uri: string): string {
  const last = uri.split(/[\\/]/).pop() ?? uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

interface Comp {
  prefix: string;
  suffix: string;
  detectors: string[]; // as written in the workspace
  def: CompDef | null;
  /** FlowJo 9: name of the matrix (its compensated parameters' calibration tables are "<name> <prefix><ch><suffix>") */
  matrixName?: string;
}

interface SampleCtx {
  id: string;
  name: string;
  keywords: Record<string, string>;
  channels: SampleChannel[];
  comp: Comp | null;
  transforms: Map<string, XForm>;
  scaleCache: Map<string, ScaleDef>;
  warn: (msg: string) => void;
}

/** A parsed transform element: display scale (in raw data units) and the factor FlowJo applies to raw values. */
interface XForm {
  scale: ScaleDef;
  k: number; // FlowJo value = app value * k (time: FlowJo gain / $TIMESTEP), 1 otherwise
}

interface Dim {
  ch: string; // FCS channel ($PnN)
  comp: boolean | null; // true = compensated, false = uncompensated fluorescence, null = not in the matrix
  scale: ScaleDef;
  k: number;
}

// ------------------------------------------------------------------ import

export function importFlowJo(xmlText: string, opts: { name?: string } = {}): FlowJoImportResult {
  const doc = parseXml(xmlText);
  const root = doc.children.find((c) => c.name === 'Workspace');
  if (!root) throw new Error('Not a FlowJo workspace (no <Workspace> element)');
  const warnings: string[] = [];
  const warnOnce = new Set<string>();
  const warn = (msg: string) => {
    if (warnOnce.has(msg)) return;
    warnOnce.add(msg);
    warnings.push(msg);
  };
  const version = num(root.attrs['version']) ?? 0;
  const mac9 = isFlowJo9Mac(root);
  if (mac9)
    warn(
      `FlowJo ${root.attrs['flowJoVersion'] ?? '9'} (Mac) workspace: gates, compensation and display transforms were converted from the FlowJo 9 format; compare the counts with FlowJo's (Compare counts).`,
    );
  else if (version && version < 2) warn(`This workspace was saved by FlowJo ${root.attrs['flowJoVersion'] ?? 'v9 or older'}; only FlowJo v10 workspaces are fully supported.`);
  const legacy = mac9 ? legacyContext(root) : null;

  const ws = emptyWorkspace();
  ws.name = opts.name ?? 'FlowJo workspace';

  // shared scale objects (identical definitions share one object: better caching, stable geometry keys)
  const scaleIntern = new Map<string, ScaleDef>();
  const intern = (s: ScaleDef): ScaleDef => {
    const k = JSON.stringify(s);
    const hit = scaleIntern.get(k);
    if (hit) return hit;
    scaleIntern.set(k, s);
    return s;
  };
  const compIntern = new Map<string, CompDef>();

  // ---------------------------------------------------------------- samples
  const sampleList = child(root, 'SampleList');
  const sampleEls = sampleList ? childrenNamed(sampleList, 'Sample') : [];
  const fjIdToSample = new Map<string, string>();
  const ctxs: { ctx: SampleCtx; node: XNode | undefined }[] = [];
  const counts: Record<string, Record<string, number>> = {};

  for (const sEl of sampleEls) {
    const sNode = child(sEl, 'SampleNode');
    const ds = child(sEl, 'DataSet');
    const keywords: Record<string, string> = {};
    const kwEl = child(sEl, 'Keywords');
    if (kwEl) for (const k of childrenNamed(kwEl, 'Keyword')) if (k.attrs['name'] !== undefined) keywords[k.attrs['name']] = k.attrs['value'] ?? '';
    const id = uid('smp');
    const fjId = sNode?.attrs['sampleID'] ?? ds?.attrs['sampleID'] ?? '';
    if (fjId) fjIdToSample.set(fjId, id);
    const uri = ds?.attrs['uri'] ?? '';
    const fileName = uri ? fileNameFromUri(uri) : keywords['$FIL'] ?? sNode?.attrs['name'] ?? 'sample.fcs';
    const sName = sNode?.attrs['name'] ?? fileName;
    // channels from the keywords FlowJo copied from the FCS file
    const channels: SampleChannel[] = [];
    const npar = num(keywords['$PAR']) ?? 0;
    for (let p = 1; p <= npar; p++) {
      const n = keywords[`$P${p}N`];
      if (!n) continue;
      const label = (keywords[`$P${p}S`] ?? '').trim();
      const range = num(keywords[`$P${p}R`]) ?? 0;
      // time in seconds, as the FCS reader returns it
      const step = isTime(n) ? num(keywords['$TIMESTEP']) : undefined;
      const ch: SampleChannel & { unit?: string } = { name: n.trim(), label: label === n.trim() ? '' : label, range };
      if (step && step > 0) {
        ch.range = range * step;
        ch.unit = 's';
      }
      channels.push(ch);
    }
    // FlowJo 9: no keywords for the parameters (older files): the <Parameter> elements
    if (!channels.length && legacy)
      for (const pe of childrenNamed(sEl, 'Parameter')) {
        const n = (pe.attrs['name'] ?? '').trim();
        if (!n) continue;
        const label = (pe.attrs['label'] ?? '').trim();
        channels.push({ name: n, label: label === n ? '' : label, range: num(pe.attrs['highValue']) ?? 0 });
      }
    const ctx: SampleCtx = { id, name: sName, keywords, channels, comp: null, transforms: new Map(), scaleCache: new Map(), warn };
    if (legacy) {
      ctx.comp = legacyComp(sEl, ctx, legacy, compIntern, warn);
      legacyTransforms(sEl, ctx, legacy, intern);
    } else {
      // compensation
      const sm = sEl.children.find((c) => c.name === 'spilloverMatrix');
      if (sm) ctx.comp = parseComp(sm, ctx, compIntern, warn);
      // transforms
      const tEl = child(sEl, 'Transformations');
      if (tEl) for (const t of tEl.children) parseTransform(t, ctx, intern);
    }
    const info: Record<string, string> = {};
    for (const [k, label] of INFO_KEYS) if (keywords[k] && !info[label]) info[label] = keywords[k].trim();
    const total = num(sNode?.attrs['count']) ?? num(keywords['$TOT']) ?? 0;
    const ref: SampleRef = {
      id,
      name: sName.replace(/\.(fcs|lmd)$/i, ''),
      fileName,
      fileSize: 0,
      eventCount: num(keywords['$TOT']) ?? Math.max(0, total),
      channels,
      compId: ctx.comp?.def?.id ?? null,
      info,
    };
    ws.samples.push(ref);
    counts[id] = { root: total };
    ctxs.push({ ctx, node: sNode });
  }
  ws.compensations = [...compIntern.values()];

  // ---------------------------------------------------------------- groups
  const groupsEl = child(root, 'Groups');
  if (groupsEl) {
    let gi = 0;
    for (const gn of childrenNamed(groupsEl, 'GroupNode')) {
      const name = gn.attrs['name'] ?? 'Group';
      if (name === 'All Samples') continue;
      const gEl = child(gn, 'Group');
      const refs = gEl ? child(gEl, 'SampleRefs') : undefined;
      const ids = [...new Set((refs ? childrenNamed(refs, 'SampleRef') : []).map((r) => fjIdToSample.get(r.attrs['sampleID'] ?? '')).filter((x): x is string => !!x))];
      if (!ids.length) continue;
      const g: Group = { id: uid('grp'), name, sampleIds: ids, color: GATE_COLORS[gi++ % GATE_COLORS.length] };
      ws.groups.push(g);
    }
  }

  // ---------------------------------------------------------------- gating trees
  interface PNode {
    key: string;
    path: string[];
    name: string;
    parentKey: string | null;
    per: Map<string, GateGeom | null>; // sample id -> geometry (null = could not be converted)
    complement: Set<string>; // samples whose FlowJo gate selects the events outside
    helperOf?: string; // key of the population this helper (positive gate of a complement) belongs to
  }
  const nodes = new Map<string, PNode>();
  const order: string[] = [];
  const joined = new Map<string, string>(); // "A/B/C" -> key
  const keyOf = (path: string[]) => JSON.stringify(path);
  const getNode = (path: string[]): PNode => {
    const key = keyOf(path);
    let n = nodes.get(key);
    if (!n) {
      n = { key, path, name: path[path.length - 1], parentKey: path.length > 1 ? keyOf(path.slice(0, -1)) : null, per: new Map(), complement: new Set() };
      nodes.set(key, n);
      order.push(key);
      const j = path.join('/');
      if (!joined.has(j)) joined.set(j, key);
    }
    return n;
  };
  const fjCounts = new Map<string, Map<string, number>>(); // key -> sample -> count

  // FlowJo 9 (Mac): populations nest directly in the sample node / population; v10: in <Subpopulations>
  const subOf = (n: XNode): XNode | undefined => (legacy ? n : child(n, 'Subpopulations'));
  for (const { ctx, node } of ctxs) {
    const sub = node ? subOf(node) : undefined;
    if (!sub) continue;
    const walk = (subEl: XNode, parentPath: string[]) => {
      const siblings: { node: PNode; geom: GateGeom }[] = [];
      for (const c of subEl.children) {
        if (!POP_NODES.has(c.name)) continue;
        const name = c.attrs['name'] ?? '';
        const path = [...parentPath, name];
        const pn = getNode(path);
        if (pn.per.has(ctx.id)) warn(`Sample "${ctx.name}": two populations named "${path.join(' / ')}"; the last one is used.`);
        const cnt = num(c.attrs['count']);
        if (cnt !== undefined) {
          let m = fjCounts.get(pn.key);
          if (!m) fjCounts.set(pn.key, (m = new Map()));
          m.set(ctx.id, cnt);
        }
        if (c.name === 'Population') {
          const gEl = child(c, 'Gate')?.children[0];
          const conv = legacy ? convertLegacyGate(c, ctx, path) : gEl ? convertGate(gEl, ctx, path) : null;
          pn.per.set(ctx.id, conv?.geom ?? null);
          if (conv?.complement) pn.complement.add(ctx.id);
          if (conv?.geom && (conv.geom.type === 'rect' || conv.geom.type === 'range')) siblings.push({ node: pn, geom: conv.geom });
        } else {
          const deps = (child(c, 'Dependents')?.children ?? []).filter((d) => d.name === 'Dependent').map((d) => d.attrs['name'] ?? '');
          pn.per.set(ctx.id, { type: 'bool', op: BOOL_OPS[c.name], operands: deps.map((d) => '@' + d) });
        }
        const s = subOf(c);
        if (s) walk(s, path);
      }
      groupQuadrants(siblings, ctx.id, parentPath);
    };
    walk(sub, []);
  }

  /** FlowJo quadrant / bisector gates are stored as rectangles with open sides: turn complete sets into quadrants / splits. */
  function groupQuadrants(sibs: { node: PNode; geom: GateGeom }[], sid: string, parentPath: string[]) {
    const quads = new Map<string, { node: PNode; g: Extract<GateGeom, { type: 'rect' }>; q: 'UR' | 'UL' | 'LL' | 'LR' }[]>();
    const splits = new Map<string, { node: PNode; g: Extract<GateGeom, { type: 'range' }>; side: 'lo' | 'hi' }[]>();
    const one = (lo: number, hi: number): 'lo' | 'hi' | null => (Number.isFinite(lo) && !Number.isFinite(hi) && hi > 0 ? 'hi' : !Number.isFinite(lo) && lo < 0 && Number.isFinite(hi) ? 'lo' : null);
    for (const s of sibs) {
      const g = s.geom;
      if (s.node.complement.has(sid)) continue;
      if (g.type === 'rect') {
        const sx = one(g.xmin, g.xmax);
        const sy = one(g.ymin, g.ymax);
        if (!sx || !sy) continue;
        const cx = sx === 'hi' ? g.xmin : g.xmax;
        const cy = sy === 'hi' ? g.ymin : g.ymax;
        const k = JSON.stringify([g.x, g.y, cx, cy, g.comp ?? '']);
        const q = sx === 'hi' ? (sy === 'hi' ? 'UR' : 'LR') : sy === 'hi' ? 'UL' : 'LL';
        if (!quads.has(k)) quads.set(k, []);
        quads.get(k)!.push({ node: s.node, g, q });
      } else if (g.type === 'range') {
        const side = one(g.min, g.max);
        if (!side) continue;
        const cut = side === 'hi' ? g.min : g.max;
        const k = JSON.stringify([g.x, cut, g.comp ?? '']);
        if (!splits.has(k)) splits.set(k, []);
        splits.get(k)!.push({ node: s.node, g, side });
      }
    }
    for (const set of quads.values()) {
      if (set.length !== 4 || new Set(set.map((m) => m.q)).size !== 4) continue;
      const gid = 'fjgrp:' + JSON.stringify([parentPath, set.map((m) => m.node.name).sort()]);
      for (const m of set) {
        const g = m.g;
        const cx = m.q === 'UR' || m.q === 'LR' ? g.xmin : g.xmax;
        const cy = m.q === 'UR' || m.q === 'UL' ? g.ymin : g.ymax;
        const q: GateGeom = { type: 'quadrant', x: g.x, y: g.y, cx, cy, quadrant: m.q, groupId: gid };
        if (g.comp) q.comp = g.comp;
        m.node.per.set(sid, q);
      }
    }
    for (const set of splits.values()) {
      if (set.length !== 2 || set[0].side === set[1].side) continue;
      const gid = 'fjgrp:' + JSON.stringify([parentPath, set.map((m) => m.node.name).sort()]);
      for (const m of set) {
        const g = m.g;
        const sp: GateGeom = { type: 'split', x: g.x, cut: m.side === 'hi' ? g.min : g.max, side: m.side, groupId: gid };
        if (g.comp) sp.comp = g.comp;
        m.node.per.set(sid, sp);
      }
    }
  }

  // complemented gates (eventsInside="0"): a helper population holds the drawn gate, the population is NOT(helper)
  for (const key of [...order]) {
    const n = nodes.get(key)!;
    if (!n.complement.size) continue;
    const hPath = [...n.path.slice(0, -1), `${n.name} (FlowJo gate, inverted)`];
    const h = getNode(hPath);
    h.helperOf = n.key;
    for (const [sid, g] of n.per) {
      if (!n.complement.has(sid)) continue;
      h.per.set(sid, g);
      n.per.set(sid, g ? { type: 'bool', op: 'not', operands: ['#' + h.key] } : null);
    }
    // the helper must come before the population it is used by
    order.splice(order.indexOf(h.key), 1);
    order.splice(order.indexOf(n.key), 0, h.key);
    warn(`Population "${n.path.join(' / ')}" excludes the events inside its FlowJo gate; the gate itself was added as "${h.name}".`);
  }

  // resolve boolean operands ('@FlowJo/path' or '#key') to population keys
  const sampleIds = ws.samples.map((s) => s.id);
  const sampleName = new Map(ws.samples.map((s) => [s.id, s.name]));
  for (const key of order) {
    const n = nodes.get(key)!;
    for (const [sid, g] of n.per) {
      if (!g || g.type !== 'bool') continue;
      const ops: string[] = [];
      let bad = '';
      for (const o of g.operands) {
        if (o.startsWith('#')) {
          ops.push(o);
          continue;
        }
        const dep = o.slice(1).replace(/^\/+|\/+$/g, '');
        const parentJ = n.path.slice(0, -1).join('/');
        const k = joined.get(dep) ?? (parentJ ? joined.get(parentJ + '/' + dep) : undefined);
        if (k && k !== n.key) ops.push('#' + k);
        else bad = dep;
      }
      if (bad || (!ops.length && g.op !== 'or')) {
        warn(`Boolean gate "${n.path.join(' / ')}" refers to "${bad || '(nothing)'}", which was not found; it is empty for sample "${sampleName.get(sid)}".`);
        n.per.set(sid, null);
      } else n.per.set(sid, { ...g, operands: ops });
    }
  }

  // drop populations that could not be converted for any sample (with their descendants and dependent boolean gates)
  const dropped = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of order) {
      if (dropped.has(key)) continue;
      const n = nodes.get(key)!;
      let why = '';
      if (n.parentKey && dropped.has(n.parentKey)) why = 'its parent was not imported';
      else if (![...n.per.values()].some((g) => g)) why = 'its gate could not be converted';
      else {
        const refs = [...n.per.values()].flatMap((g) => (g && g.type === 'bool' ? g.operands : []));
        if (refs.some((r) => dropped.has(r.slice(1)))) why = 'it uses a gate that was not imported';
      }
      if (why) {
        dropped.add(key);
        warn(`Population "${n.path.join(' / ')}" skipped: ${why}.`);
        changed = true;
      }
    }
  }

  // ---------------------------------------------------------------- populations
  const popId = new Map<string, string>();
  for (const key of order) if (!dropped.has(key)) popId.set(key, uid('pop'));
  const groupIds = new Map<string, string>();
  const finalize = (g: GateGeom): GateGeom => {
    if (g.type === 'bool') return { ...g, operands: g.operands.map((o) => popId.get(o.slice(1)) ?? o) };
    if ((g.type === 'quadrant' || g.type === 'split') && g.groupId.startsWith('fjgrp:')) {
      let id = groupIds.get(g.groupId);
      if (!id) groupIds.set(g.groupId, (id = uid(g.type === 'quadrant' ? 'quad' : 'split')));
      return { ...g, groupId: id };
    }
    return g;
  };
  const missing = new Map<string, string[]>(); // sample -> populations it lacks (top-most only)
  // samples each population applies to: those whose FlowJo tree has it (with a usable gate) under an applicable parent;
  // where that differs from the parent's samples, the population gets a scope (a group when the set is exactly a group)
  const appl = new Map<string, Set<string>>();
  const groupOfSet = (ids: string[]): string | undefined => {
    const set = new Set(ids);
    return ws.groups.find((g) => g.sampleIds.length === set.size && g.sampleIds.every((id) => set.has(id)))?.id;
  };
  let colorIdx = 0;
  for (const key of order) {
    if (dropped.has(key)) continue;
    const n = nodes.get(key)!;
    const parentAppl = n.parentKey ? appl.get(n.parentKey) ?? new Set<string>() : new Set(sampleIds);
    const relevant = sampleIds.filter((sid) => parentAppl.has(sid));
    const has = relevant.filter((sid) => !!n.per.get(sid));
    appl.set(key, new Set(has));
    const tally = new Map<string, { g: GateGeom; n: number }>();
    for (const sid of has) {
      const g = n.per.get(sid)!;
      const k = geomKey(g);
      const t = tally.get(k);
      if (t) t.n++;
      else tally.set(k, { g, n: 1 });
    }
    let best: { g: GateGeom; n: number } | null = null;
    for (const t of tally.values()) if (!best || t.n > best.n) best = t;
    // no sample with a usable gate under an applicable parent: the most common geometry of any sample (n/a everywhere)
    if (!best) for (const g of n.per.values()) if (g) best = { g, n: 0 };
    if (!best) continue; // cannot happen (dropped above)
    const bestKey = geomKey(best.g);
    const gate = finalize(best.g);
    const overrides: Record<string, GateGeom> = {};
    for (const sid of relevant) {
      const g = n.per.get(sid);
      if (g === undefined || g === null) {
        if (g === undefined && !n.helperOf) missing.set(sid, [...(missing.get(sid) ?? []), n.path.join(' / ')]);
        if (g === null) warn(`Sample "${sampleName.get(sid)}": the gate of "${n.path.join(' / ')}" could not be converted; the population is n/a for this sample.`);
      } else if (geomKey(g) !== bestKey) overrides[sid] = finalize(g);
    }
    const pop: Population = {
      id: popId.get(key)!,
      name: n.name,
      parentId: n.parentKey ? popId.get(n.parentKey) ?? null : null,
      gate,
      color: GATE_COLORS[colorIdx++ % GATE_COLORS.length],
    };
    if (Object.keys(overrides).length) pop.overrides = overrides;
    if (has.length < relevant.length) {
      const gid = groupOfSet(has);
      pop.scope = gid ? { groups: [gid] } : { samples: has };
    }
    ws.populations.push(pop);
    const fc = fjCounts.get(key);
    if (fc) for (const [sid, c] of fc) counts[sid][pop.id] = c;
  }
  for (const [sid, paths] of missing) {
    const list = paths.slice(0, 3).map((p) => `"${p}"`).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
    warn(`Sample "${sampleName.get(sid)}" has no gate for ${list} (gated in other samples); shown as n/a for this sample.`);
  }

  // ---------------------------------------------------------------- display scales (most common per channel)
  const scaleTally = new Map<string, Map<string, { s: ScaleDef; n: number }>>();
  // samples of several instruments: each instrument's most common transform too (its own axis scale where it differs,
  // see Workspace.instrumentScales; gate counts do not depend on it, imported polygons / ellipses carry their scales)
  const instOf = new Map(ctxs.map(({ ctx }) => [ctx.id, instrumentKeyOf(ctx.keywords)]));
  const multiInst = new Set([...instOf.values()].filter(Boolean)).size > 1;
  const instTally = new Map<string, Map<string, Map<string, { s: ScaleDef; n: number }>>>();
  for (const { ctx } of ctxs) {
    const names = new Set<string>([...ctx.channels.map((c) => c.name)]);
    for (const t of ctx.transforms.keys()) names.add(resolveChannel(ctx, stripComp(ctx, t).ch));
    for (const ch of names) {
      const d = ctx.comp && ctx.comp.detectors.some((x) => resolveChannel(ctx, x) === ch) ? ctx.comp.prefix + ch + ctx.comp.suffix : ch;
      const t = lookupTransform(ctx, d) ?? lookupTransform(ctx, ch);
      if (!t) continue;
      let m = scaleTally.get(ch);
      if (!m) scaleTally.set(ch, (m = new Map()));
      const k = JSON.stringify(t.scale);
      const e = m.get(k);
      if (e) e.n++;
      else m.set(k, { s: t.scale, n: 1 });
      const ik = multiInst ? instOf.get(ctx.id) : '';
      if (ik) {
        let byCh = instTally.get(ik);
        if (!byCh) instTally.set(ik, (byCh = new Map()));
        let im = byCh.get(ch);
        if (!im) byCh.set(ch, (im = new Map()));
        const ie = im.get(k);
        if (ie) ie.n++;
        else im.set(k, { s: t.scale, n: 1 });
      }
    }
  }
  const mostCommon = (m: Map<string, { s: ScaleDef; n: number }>) => {
    let best: { s: ScaleDef; n: number } | null = null;
    for (const e of m.values()) if (!best || e.n > best.n) best = e;
    return best?.s;
  };
  for (const [ch, m] of scaleTally) {
    const best = mostCommon(m);
    if (best) ws.scales[ch] = best;
  }
  for (const [ik, byCh] of instTally)
    for (const [ch, m] of byCh) {
      const own = mostCommon(m);
      if (own && JSON.stringify(own) !== JSON.stringify(ws.scales[ch])) ((ws.instrumentScales ??= {})[ik] ??= {})[ch] = own;
    }
  // the instrument of each sample (as loading its file would set it), for the scales above
  if (ws.instrumentScales) for (const smp of ws.samples) smp.instrument = instOf.get(smp.id) ?? '';

  // nothing imported although the workspace has gates: say so (e.g. a FlowJo version whose gate format is not known)
  if (!ws.populations.length) {
    const nPop = descendants(root, 'Population').length;
    if (nPop)
      warnings.push(
        `None of the ${nPop} gated populations of this workspace (FlowJo ${root.attrs['flowJoVersion'] ?? '?'}, workspace format ${root.attrs['version'] ?? '?'}) could be imported; the samples are opened without gates.`,
      );
  }

  layoutGatingSheets(ws);
  return { workspace: ws, warnings, counts };
}

/** Worksheets showing the gating strategy: one plot per parent population and gate axes, as in FlowJo's graph windows. */
function layoutGatingSheets(ws: Workspace) {
  const plots: { parent: string; x: string; y: string; type: 'pseudo' | 'histogram' }[] = [];
  const seen = new Set<string>();
  const parents: (string | null)[] = [null, ...ws.populations.map((p) => p.id)];
  for (const parent of parents) {
    for (const c of ws.populations.filter((p) => p.parentId === parent)) {
      const prm = gateParams(c.gate);
      if (!prm.length) continue;
      const [x, y] = prm.length === 1 ? [prm[0], prm[0]] : prm;
      const k = JSON.stringify([parent, x, y]);
      if (seen.has(k)) continue;
      seen.add(k);
      plots.push({ parent: parent ?? 'root', x, y, type: prm.length === 1 ? 'histogram' : 'pseudo' });
    }
  }
  if (!plots.length) return;
  const perRow = 4;
  const perSheet = 12;
  const sheets = [];
  for (let i = 0; i < plots.length; i += perSheet) {
    const sh = newWorksheet(plots.length > perSheet ? `Gating ${i / perSheet + 1}` : 'Gating');
    const g = sh.grid;
    const snap = (v: number) => Math.max(g, Math.round(v / g) * g);
    const W = snap((ws.style.plotW ?? 60) * MM);
    const H = snap((ws.style.plotH ?? 54) * MM);
    plots.slice(i, i + perSheet).forEach((p, j) => {
      const o = defaultPlotOptions();
      o.fontSize = ws.style.fontSize || o.fontSize;
      const item: PlotItem = {
        id: uid('plot'),
        kind: 'plot',
        plotType: p.type,
        xParam: p.x,
        yParam: p.y,
        layers: [{ id: uid('ly'), sample: 'active', population: p.parent }],
        options: o,
        x: g * 2 + (j % perRow) * (W + g),
        y: g * 2 + Math.floor(j / perRow) * (H + g),
        w: W,
        h: H,
      };
      sh.items.push(item);
    });
    sheets.push(sh);
  }
  ws.worksheets = sheets;
}

// ------------------------------------------------------------------ compensation

function parseComp(sm: XNode, ctx: SampleCtx, intern: Map<string, CompDef>, warn: (m: string) => void): Comp {
  const prefix = sm.attrs['prefix'] ?? 'Comp-';
  const suffix = sm.attrs['suffix'] ?? '';
  const paramsEl = child(sm, 'parameters');
  const detectors = (paramsEl ? childrenNamed(paramsEl, 'parameter') : []).map((p) => p.attrs['name'] ?? '').filter(Boolean);
  const comp: Comp = { prefix, suffix, detectors, def: null };
  if (sm.attrs['spectral'] === '1') {
    warn(`Sample "${ctx.name}": spectral (unmixing) matrices are not supported; the sample is shown uncompensated.`);
    return comp;
  }
  const rows = childrenNamed(sm, 'spillover');
  const idx = new Map(detectors.map((d, i) => [d, i]));
  const n = detectors.length;
  const matrix: number[][] = detectors.map((_, i) => detectors.map((__, j) => (i === j ? 1 : 0)));
  let ok = n > 0 && rows.length === n;
  for (const r of rows) {
    const i = idx.get(r.attrs['parameter'] ?? '');
    if (i === undefined) {
      ok = false;
      continue;
    }
    childrenNamed(r, 'coefficient').forEach((c, jj) => {
      const j = idx.get(c.attrs['parameter'] ?? '') ?? jj;
      const v = Number(c.attrs['value']);
      if (j < n && Number.isFinite(v)) matrix[i][j] = v;
    });
  }
  if (!ok) {
    warn(`Sample "${ctx.name}": the compensation matrix could not be read; the sample is shown uncompensated.`);
    return comp;
  }
  const channels = detectors.map((d) => resolveChannel(ctx, d));
  const key = JSON.stringify([channels, matrix]);
  let def = intern.get(key);
  if (!def) {
    const fjName = sm.attrs['name'] ?? 'FlowJo matrix';
    const acq = fjName === 'Acquisition-defined';
    def = { id: uid('comp'), name: acq ? 'Acquisition matrix (FlowJo)' : fjName, channels, matrix, source: acq ? 'file' : 'manual' };
    // several samples can carry different matrices of the same name
    const same = [...intern.values()].filter((c) => c.name === def!.name || c.name.startsWith(def!.name + ' ('));
    if (same.length) def.name = `${def.name} (${same.length + 1})`;
    intern.set(key, def);
  }
  comp.def = def;
  return comp;
}

// ------------------------------------------------------------------ channels and transforms

/**
 * FlowJo's form of a parameter name in a workspace: "/" and "\" become "_" ("LIVE/DEAD Aqua-A" is written as
 * "LIVE_DEAD Aqua-A" in the $PnN keywords it copies, in gates, transforms and matrices; CytoML's fix_slash does the same).
 */
export const flowJoSafeName = (s: string) => s.replace(/[/\\]/g, '_');

/** FlowJo replaces "/" in parameter names by "_": map a workspace name to the FCS $PnN. */
function resolveChannel(ctx: SampleCtx, name: string): string {
  if (!ctx.channels.length || ctx.channels.some((c) => c.name === name)) return name;
  return ctx.channels.find((c) => flowJoSafeName(c.name) === flowJoSafeName(name))?.name ?? name;
}

/**
 * Workspace channel names that are FlowJo's form (flowJoSafeName) of a channel of an FCS file: workspace name -> the
 * file's $PnN, e.g. "LIVE_DEAD Aqua-A" -> "LIVE/DEAD Aqua-A". Names the file has itself, names in `keep` (real channels
 * of other loaded files) and names that would be ambiguous are left alone.
 */
export function flowJoChannelRenames(wsNames: Iterable<string>, fcsNames: string[], keep: Set<string> = new Set()): Map<string, string> {
  const have = new Set(fcsNames);
  const bySafe = new Map<string, string[]>();
  for (const n of fcsNames) {
    const k = flowJoSafeName(n);
    bySafe.set(k, [...(bySafe.get(k) ?? []), n]);
  }
  const out = new Map<string, string>();
  for (const n of wsNames) {
    if (have.has(n) || keep.has(n) || out.has(n)) continue;
    const c = bySafe.get(flowJoSafeName(n));
    if (c && c.length === 1 && c[0] !== n) out.set(n, c[0]);
  }
  return out;
}

/** Channel names a workspace refers to: sample channels, gate dimensions, scales, matrices, labels, plot axes. */
export function workspaceChannelNames(ws: Workspace): Set<string> {
  const out = new Set<string>();
  for (const s of ws.samples) for (const c of s.channels) out.add(c.name);
  for (const p of ws.populations) for (const g of [p.gate, ...Object.values(p.overrides ?? {})]) for (const ch of gateParams(g)) out.add(ch);
  for (const k of Object.keys(ws.scales)) out.add(k);
  for (const k of Object.keys(ws.channelLabels)) out.add(k);
  for (const c of ws.compensations) for (const ch of c.channels) out.add(ch);
  return out;
}

/**
 * Rename channels throughout a workspace (mutates it; works on an immer draft): sample channels, gate dimensions,
 * scales, labels, matrices, plot axes and table columns.
 */
export function renameWorkspaceChannels(ws: Workspace, map: Map<string, string>) {
  if (!map.size) return;
  const r = (ch: string) => map.get(ch) ?? ch;
  const gate = (g: GateGeom) => {
    if ('x' in g && typeof g.x === 'string') g.x = r(g.x);
    if ('y' in g && typeof g.y === 'string') g.y = r(g.y);
  };
  for (const s of ws.samples) for (const c of s.channels) c.name = r(c.name);
  for (const p of ws.populations) {
    gate(p.gate);
    for (const g of Object.values(p.overrides ?? {})) gate(g);
  }
  for (const rec of [ws.scales, ws.channelLabels, ...Object.values(ws.instrumentScales ?? {})] as Record<string, unknown>[])
    for (const [from, to] of map)
      if (from in rec) {
        if (!(to in rec)) rec[to] = rec[from];
        delete rec[from];
      }
  for (const c of ws.compensations) c.channels = c.channels.map(r);
  for (const sh of ws.worksheets)
    for (const it of sh.items) {
      if (it.kind !== 'plot') continue;
      it.xParam = r(it.xParam);
      it.yParam = r(it.yParam);
      if (it.options.colorParam) it.options.colorParam = r(it.options.colorParam);
    }
  for (const t of ws.tables) for (const c of t.columns) if (c.channel) c.channel = r(c.channel);
}

/** "Comp-FL1-A" -> FL1-A (compensated) when FL1-A is in the sample's matrix. */
function stripComp(ctx: SampleCtx, dim: string): { ch: string; comp: boolean | null } {
  const c = ctx.comp;
  if (c && dim.startsWith(c.prefix) && dim.endsWith(c.suffix) && dim.length > c.prefix.length + c.suffix.length) {
    const core = dim.slice(c.prefix.length, dim.length - c.suffix.length);
    if (c.detectors.includes(core)) return { ch: core, comp: true };
  }
  if (c && c.detectors.includes(dim)) return { ch: dim, comp: false };
  // prefixed name of a channel outside the matrix (e.g. "Comp-FSC-A"): the plain channel
  if (c && c.prefix && dim.startsWith(c.prefix) && dim.endsWith(c.suffix)) {
    const core = dim.slice(c.prefix.length, dim.length - c.suffix.length);
    if (ctx.channels.some((x) => x.name === core)) return { ch: core, comp: null };
  }
  // a "Comp-" name without a matrix (or for a channel not in it)
  if (!c && /^Comp-/.test(dim)) return { ch: dim.slice(5), comp: null };
  return { ch: dim, comp: null };
}

function lookupTransform(ctx: SampleCtx, name: string): XForm | undefined {
  return ctx.transforms.get(name) ?? ctx.transforms.get(name.replace(/[/\\]/g, '_'));
}

function parseTransform(t: XNode, ctx: SampleCtx, intern: (s: ScaleDef) => ScaleDef) {
  const p = t.children.find((c) => c.name === 'parameter');
  const pname = p?.attrs['name'];
  if (!pname) return;
  const a = (k: string) => num(t.attrs[k]);
  let scale: ScaleDef | null = null;
  let k = 1;
  switch (t.name) {
    case 'linear': {
      const min = a('minRange') ?? 0;
      const max = a('maxRange') ?? 262144;
      if (isTime(pname)) {
        // FlowJo multiplies the time ticks by the transform's gain, or by $TIMESTEP when the gain is 1 (as CytoML does);
        // the app reads time in seconds (ticks x $TIMESTEP, see fcs.ts), so FlowJo value = app value x fjGain / $TIMESTEP
        const gain = a('gain');
        const step = num(ctx.keywords['$TIMESTEP']);
        const fjGain = gain !== undefined && gain !== 1 && gain > 0 ? gain : step && step > 0 ? step : 1;
        k = fjGain / (step && step > 0 ? step : 1);
      }
      scale = { type: 'linear', min: min / k, max: max > min ? max / k : (min + 1) / k };
      break;
    }
    case 'log': {
      const offset = a('offset') ?? 1;
      const decades = a('decades') ?? 4.5;
      const min = offset > 0 ? offset : 1;
      scale = { type: 'log', min, max: min * Math.pow(10, decades > 0 ? decades : 4.5), clampLow: true };
      break;
    }
    case 'logicle': {
      const T = a('T') ?? 262144;
      const W = a('W') ?? 0.5;
      const M = a('M') ?? 4.5;
      const A = a('A') ?? 0;
      try {
        new Logicle(T, W, M, A);
        scale = { type: 'logicle', T, W, M, A };
      } catch {
        ctx.warn(`Logicle parameters of "${pname}" are invalid (T=${T}, W=${W}, M=${M}, A=${A}); a default logicle is used.`);
        scale = { type: 'logicle', T: T > 0 ? T : 262144, W: 0.5, M: 4.5, A: 0 };
      }
      break;
    }
    case 'biex': {
      const width = a('width') ?? -10;
      const neg = a('neg') ?? 0;
      const pos = a('pos') ?? 4.418539922;
      const max = a('maxRange') ?? 262144;
      if (!(width < 0)) {
        ctx.warn(`Biex width basis of "${pname}" is invalid (${width}); -10 is used.`);
      }
      scale = flowJoBiexDef({ neg, width: width < 0 ? width : -10, pos, max });
      break;
    }
    case 'fasinh': {
      // FlowJo's arcsinh is the Gating-ML fasinh (its extra length / maxRange / W attributes do not change gating)
      const T = a('T') ?? 262144;
      const M = a('M') ?? 4.5;
      const A = a('A') ?? 0;
      scale = { type: 'arcsinh', T, M, A };
      break;
    }
    default:
      ctx.warn(`FlowJo transform "${t.name}" (${pname}) is not supported; a linear axis is used for it.`);
      scale = { type: 'linear', min: 0, max: a('maxRange') ?? 262144 };
  }
  ctx.transforms.set(pname, { scale: intern(scale), k });
}

function dimOf(ctx: SampleCtx, dimName: string): Dim {
  const s = stripComp(ctx, dimName);
  const ch = resolveChannel(ctx, s.ch);
  const t = lookupTransform(ctx, dimName) ?? lookupTransform(ctx, s.ch);
  if (t) return { ch, comp: s.comp, scale: t.scale, k: t.k };
  // no transform stored: linear over the parameter range; FlowJo's time (ticks x $TIMESTEP) is the app's time in seconds
  const k = 1;
  let range = ctx.channels.find((c) => c.name === ch)?.range || 262144;
  if (isTime(ch)) {
    const step = num(ctx.keywords['$TIMESTEP']);
    if (step && step > 0) range *= step;
  }
  let scale = ctx.scaleCache.get(ch);
  if (!scale) ctx.scaleCache.set(ch, (scale = { type: 'linear', min: 0, max: range }));
  return { ch, comp: s.comp, scale, k };
}

// ------------------------------------------------------------------ gates

/** Half a display channel at FlowJo's 4096-channel resolution (display units). */
const EDGE = 0.5 / 4096;

/** FlowJo's gate grid when a polygon does not state its gateResolution. */
const GATE_RESOLUTION = 256;

/**
 * A polygon axis on FlowJo's gate grid: linear and log axes round to the nearest channel, biex and logicle truncate
 * (log: measured on FlowJo 10.5 workspaces of CytoFLEX nanoscale data, log axes with offset 100: rounding gives FlowJo's
 * counts within 0.1 %, truncating was up to 7 % off).
 */
function gridScale(s: ScaleDef, n: number): ScaleDef {
  if (s.type === 'window') return s;
  return withGateGrid(s, { n, nearest: s.type === 'linear' || s.type === 'log' });
}

/** Raw values below / above which a FlowJo display transform places events on the axis edge (+-Infinity if none). */
function clampedEnds(s: ScaleDef): [number, number] {
  if (s.type === 'log' && s.clampLow) return [s.min, Infinity];
  if (s.type === 'logicle' && s.flowjo && isFlowJoBiexActive(s)) {
    const sc = makeScale(s);
    return [sc.inv(0), sc.inv(1)];
  }
  return [-Infinity, Infinity];
}

function dimNames(g: XNode): string[] {
  return childrenNamed(g, 'dimension').map((d) => d.children.find((c) => c.name === 'fcs-dimension' || c.name === 'parameter')?.attrs['name'] ?? '');
}

function coords(v: XNode): number[] {
  return childrenNamed(v, 'coordinate').map((c) => Number(c.attrs['value']));
}

/** Gate-level compensation from the kinds of its dimensions (undefined = the sample's own compensation). */
function gateComp(ctx: SampleCtx, dims: Dim[], path: string[]): string | undefined {
  const uncomp = dims.some((d) => d.comp === false);
  const comp = dims.some((d) => d.comp === true);
  if (uncomp && comp) ctx.warn(`Gate "${path.join(' / ')}" mixes compensated and uncompensated parameters; it is evaluated on compensated data.`);
  if (uncomp && !comp) return 'none';
  return undefined;
}

function convertGate(gEl: XNode, ctx: SampleCtx, path: string[]): { geom: GateGeom | null; complement: boolean } | null {
  const where = `"${path.join(' / ')}" (sample "${ctx.name}")`;
  const complement = gEl.attrs['eventsInside'] === '0';
  const names = dimNames(gEl);
  if (names.some((n) => !n)) {
    ctx.warn(`Gate ${where}: unsupported dimension (ratio or derived parameter).`);
    return null;
  }
  const dims = names.map((n) => dimOf(ctx, n));
  const missingCh = dims.find((d) => ctx.channels.length && !ctx.channels.some((c) => c.name === d.ch));
  if (missingCh) ctx.warn(`Gate ${where} uses parameter "${missingCh.ch}", which is not in the sample's keywords (derived parameter?).`);
  const comp = gateComp(ctx, dims, path);
  const withComp = <G extends GateGeom>(g: G): G => (comp ? { ...g, comp } : g);
  switch (gEl.name) {
    case 'RectangleGate': {
      const bounds = childrenNamed(gEl, 'dimension').map((d, i) => {
        const sc = makeScale(dims[i].scale);
        const lo = num(d.attrs['min']);
        const hi = num(d.attrs['max']);
        const rlo = lo === undefined ? -Infinity : lo / dims[i].k;
        const rhi = hi === undefined ? Infinity : hi / dims[i].k;
        // FlowJo shows off-scale events on the axis edge: a side at the edge of the axis (within half a display channel
        // of FlowJo's 4096) also takes the events beyond it
        return [sc.fwd(rlo) <= EDGE ? -Infinity : rlo, sc.fwd(rhi) >= 1 - EDGE ? Infinity : rhi];
      });
      if (dims.length === 1) return { geom: withComp({ type: 'range', x: dims[0].ch, min: bounds[0][0], max: bounds[0][1] }), complement };
      if (dims.length === 2)
        return {
          geom: withComp({ type: 'rect', x: dims[0].ch, y: dims[1].ch, xmin: bounds[0][0], xmax: bounds[0][1], ymin: bounds[1][0], ymax: bounds[1][1] }),
          complement,
        };
      ctx.warn(`Gate ${where}: rectangle gates with ${dims.length} dimensions are not supported.`);
      return null;
    }
    case 'PolygonGate': {
      if (dims.length !== 2) {
        ctx.warn(`Gate ${where}: polygon gates need two dimensions.`);
        return null;
      }
      const pts: Pt[] = childrenNamed(gEl, 'vertex').map((v) => {
        const c = coords(v);
        return [c[0] / dims[0].k, c[1] / dims[1].k];
      });
      if (pts.length < 3 || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
        ctx.warn(`Gate ${where}: invalid polygon.`);
        return null;
      }
      // FlowJo tests polygons on its channel grid of the gate's resolution (see GateGrid)
      const res = num(gEl.attrs['gateResolution']);
      const n = res !== undefined && Number.isInteger(res) && res >= 2 && res <= 1 << 16 ? res : GATE_RESOLUTION;
      const scales = { x: gridScale(dims[0].scale, n), y: gridScale(dims[1].scale, n) };
      return { geom: withComp({ type: 'polygon', x: dims[0].ch, y: dims[1].ch, points: pts, scales, strict: false }), complement };
    }
    case 'EllipsoidGate': {
      if (dims.length !== 2) {
        ctx.warn(`Gate ${where}: only two-dimensional ellipses are supported.`);
        return null;
      }
      const g = ellipseGeom(gEl, dims);
      if (!g) {
        ctx.warn(`Gate ${where}: the ellipse could not be read.`);
        return null;
      }
      return { geom: withComp(g), complement };
    }
    case 'CurlyQuad':
    case 'QuadrantGate': {
      ctx.warn(`Gate ${where}: FlowJo ${gEl.name} gates are not supported.`);
      return null;
    }
    default:
      ctx.warn(`Gate ${where}: unsupported gate type "${gEl.name}".`);
      return null;
  }
}

// Ported from FlowKit, (c) 2018 Scott White, BSD-3-Clause (FlowJo ellipse gate conversion; license text in THIRD_PARTY_NOTICES.md).
/**
 * FlowJo stores an ellipse as two foci and four edge points in a 256 x 256 display grid of the axes' transforms.
 * The geometry follows FlowKit: center and orientation from the foci, the semi-major axis from the edge points,
 * the semi-minor axis from the focal distance. Returned as an ellipse (or, when it cannot be expressed in raw values
 * of a clamped FlowJo biex axis, as a 128-vertex polygon) evaluated in the axes' display space.
 */
function ellipseGeom(gEl: XNode, dims: Dim[]): GateGeom | null {
  const foci = (child(gEl, 'foci')?.children ?? []).filter((c) => c.name === 'vertex').map(coords);
  const edge = (child(gEl, 'edge')?.children ?? []).filter((c) => c.name === 'vertex').map(coords);
  if (foci.length < 2 || edge.length < 4) return null;
  const f = foci.map((p) => [p[0] / 256, p[1] / 256]);
  const e = edge.map((p) => [p[0] / 256, p[1] / 256]);
  const c = [(f[0][0] + f[1][0]) / 2, (f[0][1] + f[1][1]) / 2];
  const dx = f[1][0] - f[0][0];
  const dy = f[1][1] - f[0][1];
  const theta = dx === 0 && dy === 0 ? 0 : Math.atan(dy / dx);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // rotate by -theta (FlowKit: p @ [[cos, -sin], [sin, cos]])
  const rot = (p: number[]) => [(p[0] - c[0]) * cos + (p[1] - c[1]) * sin, -(p[0] - c[0]) * sin + (p[1] - c[1]) * cos];
  const fr = rot(f[0]);
  const r1 = rot(e[0]).map(Math.abs);
  const r3 = rot(e[2]).map(Math.abs);
  const p1 = r1[1] > r1[0] ? 1 : 0;
  const p3 = r3[1] > r3[0] ? 1 : 0;
  if (p1 === p3) return null;
  const a = Math.max(r1[p1], r3[p3]);
  const b = Math.sqrt(Math.abs(fr[0] * fr[0] - a * a));
  const [rx, ry] = p1 === 0 ? [a, b] : [b, a];
  // display-space ellipse: c + cos(t) * va + sin(t) * vb
  const va: Pt = [rx * cos, rx * sin];
  const vb: Pt = [-ry * sin, ry * cos];
  return displayEllipse([c[0], c[1]], va, vb, dims);
}

/**
 * The display-space ellipse c + cos(t) va + sin(t) vb (axes' display units 0..1) as a gate: an ellipse in raw values with
 * the axes' scales, or (when that cannot be expressed in raw values of a clamped FlowJo biex axis) a 128-vertex polygon.
 */
function displayEllipse(c: Pt, va: Pt, vb: Pt, dims: Dim[]): GateGeom | null {
  const sx = makeScale(dims[0].scale);
  const sy = makeScale(dims[1].scale);
  // display range in which raw values can represent a point (axes that clamp cannot go beyond their edges)
  const span = (d: Dim): [number, number] => {
    const [lo, hi] = clampedEnds(d.scale);
    return [lo > -Infinity ? 0 : -Infinity, hi < Infinity ? 1 : Infinity];
  };
  const [sxr, syr] = [span(dims[0]), span(dims[1])];
  const P: Pt[] = [
    [c[0], c[1]],
    [c[0] + va[0], c[1] + va[1]],
    [c[0] + vb[0], c[1] + vb[1]],
  ];
  const raw = (p: Pt): Pt => [sx.inv(p[0]), sy.inv(p[1])];
  const exact = P.every((p) => p[0] >= sxr[0] && p[0] <= sxr[1] && p[1] >= syr[0] && p[1] <= syr[1]);
  const ok = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  if (exact) {
    const [rc, ra, rb] = P.map(raw);
    // the raw points must map back onto the display-space ellipse
    const back = (p: Pt, q: Pt) => Math.abs(sx.fwd(p[0]) - q[0]) < 1e-9 && Math.abs(sy.fwd(p[1]) - q[1]) < 1e-9;
    if (ok(rc) && ok(ra) && ok(rb) && back(rc, P[0]) && back(ra, P[1]) && back(rb, P[2]))
      return { type: 'ellipse', x: dims[0].ch, y: dims[1].ch, center: rc, a: ra, b: rb, scales: { x: dims[0].scale, y: dims[1].scale }, strict: false };
  }
  const n = 128;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const u = c[0] + Math.cos(t) * va[0] + Math.sin(t) * vb[0];
    const v = c[1] + Math.cos(t) * va[1] + Math.sin(t) * vb[1];
    pts.push(raw([Math.min(sxr[1], Math.max(sxr[0], u)), Math.min(syr[1], Math.max(syr[0], v))]));
  }
  if (!pts.every(ok)) return null;
  return { type: 'polygon', x: dims[0].ch, y: dims[1].ch, points: pts, scales: { x: dims[0].scale, y: dims[1].scale }, strict: false };
}

// ------------------------------------------------------------------ FlowJo 9 (Mac) workspaces

/** A FlowJo 9 (Mac) workspace: <Workspace version="2.0"> with <Parameter> elements in the samples. */
export function isFlowJo9Mac(root: XNode): boolean {
  const v = num(root.attrs['version']) ?? 0;
  if (v >= 3) return false;
  const sl = child(root, 'SampleList');
  const samples = sl ? childrenNamed(sl, 'Sample') : [];
  return samples.some((s) => s.children.some((c) => c.name === 'Parameter')) || (v >= 2 && !!child(root, 'CalibrationTables'));
}

interface CalTable {
  name: string;
  values: number[]; // raw value of display channel 0..4096
  pos: number;
  neg: number;
  width: number;
}

interface LegacyCtx {
  tables: CalTable[];
  byName: Map<string, CalTable>;
  matrices: XNode[];
  fits: Map<CalTable, ScaleDef | null>;
}

function legacyContext(root: XNode): LegacyCtx {
  const tables: CalTable[] = [];
  const ct = child(root, 'CalibrationTables');
  for (const t of ct ? childrenNamed(ct, 'Table') : []) {
    const nums = t.text.split(',').map((x) => Number(x.trim()));
    const values: number[] = [];
    for (let i = 1; i < nums.length; i += 2) values.push(nums[i]);
    tables.push({
      name: (t.attrs['name'] ?? '').trim(),
      values: values.every(Number.isFinite) ? values : [],
      pos: num(t.attrs['biexponentialDecades']) ?? 0,
      neg: num(t.attrs['biexponentialNegDecades']) ?? 0,
      width: num(t.attrs['biexponentialWidth']) ?? 0,
    });
  }
  const cm = child(root, 'CompensationMatrices');
  return { tables, byName: new Map(tables.map((t) => [t.name, t])), matrices: cm ? childrenNamed(cm, 'CompensationMatrix') : [], fits: new Map() };
}

/** Largest distance (in the table's 4096 display channels) between a table and FlowJo biex parameters `p`. */
function tableError(values: number[], p: FlowJoBiexParams): number {
  const n = values.length - 1;
  const xs = flowJoBiexTable(p, n);
  let err = 0;
  for (let i = 1; i < n; i += 16) {
    const v = values[i];
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= v) lo = mid;
      else hi = mid;
    }
    const ch = xs[hi] > xs[lo] ? lo + (v - xs[lo]) / (xs[hi] - xs[lo]) : lo;
    err = Math.max(err, Math.abs(ch - i));
  }
  return err;
}

/**
 * FlowJo biex parameters reproducing a FlowJo 9 calibration table (channel 0..4096 -> raw value). The table is
 * proportional to the top of scale, so for given decades the width follows from table[0] / table[4096] and the top
 * from table[4096]. The stated parameters are tried first (often exact); FlowJo 9.2 writes 0 for them.
 */
export function fitFlowJoTable(values: number[], stated: { pos: number; neg: number; width: number }): { p: FlowJoBiexParams; err: number } | null {
  const n = values.length - 1;
  if (n < 16 || !(values[n] > 0) || !(values[0] < 0)) return null;
  const pos = stated.pos > 0 ? stated.pos : 4.5;
  const neg = stated.neg > 0 ? stated.neg : 0;
  const withTop = (width: number): FlowJoBiexParams => {
    const t = flowJoBiexTable({ neg, width, pos, max: 262144 }, n);
    return { neg, width, pos, max: (262144 * values[n]) / t[n] };
  };
  const cands: FlowJoBiexParams[] = [];
  if (stated.width < 0) cands.push(withTop(stated.width));
  // width from the ratio of the ends (monotonic in log10(-width) over 0..3.5)
  const r = values[0] / values[n];
  const ratio = (lw: number) => {
    const t = flowJoBiexTable({ neg, width: -Math.pow(10, lw), pos, max: 262144 }, n);
    return t[0] / t[n];
  };
  let lo = 0;
  let hi = 3.5;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (ratio(m) > r) lo = m;
    else hi = m;
  }
  const w0 = -Math.pow(10, (lo + hi) / 2);
  for (let k = -12; k <= 12; k++) cands.push(withTop(w0 * (1 + k * 0.0025)));
  let best: { p: FlowJoBiexParams; err: number } | null = null;
  for (const p of cands) {
    if (!(p.max > 0) || !Number.isFinite(p.max)) continue;
    const err = tableError(values, p);
    if (!best || err < best.err) best = { p, err };
    if (err < 0.5) break;
  }
  return best;
}

/** Display scale of a FlowJo 9 calibration table: the FlowJo biex matching it, or a log scale for a plain log table. */
function tableScale(t: CalTable, lg: LegacyCtx, ctx: SampleCtx): ScaleDef | null {
  if (lg.fits.has(t)) return lg.fits.get(t)!;
  let s: ScaleDef | null = null;
  const v = t.values;
  const n = v.length - 1;
  if (n > 0 && v[0] > 0 && v[n] > v[0]) s = { type: 'log', min: v[0], max: v[n], clampLow: true };
  else {
    const fit = fitFlowJoTable(v, t);
    if (fit) {
      s = flowJoBiexDef(fit.p);
      if (fit.err > 16) ctx.warn(`FlowJo 9 display transform "${t.name}" matches a FlowJo biex only within ${Math.round(fit.err)} of 4096 channels.`);
    }
  }
  lg.fits.set(t, s);
  return s;
}

/** Compensation of a FlowJo 9 sample: compensationID -1 = the FCS file's matrix, k >= 1 = the workspace's k-th matrix. */
function legacyComp(sEl: XNode, ctx: SampleCtx, lg: LegacyCtx, intern: Map<string, CompDef>, warn: (m: string) => void): Comp | null {
  const cid = num(sEl.attrs['compensationID']);
  if (cid === undefined || cid === 0) return null;
  let detectors: string[];
  let matrix: number[][];
  let name: string;
  let prefix = '<';
  let suffix = '>';
  if (cid < 0) {
    const sp = getSpillover({ keywords: Object.fromEntries(Object.entries(ctx.keywords).map(([k, v]) => [k.toUpperCase(), v])), channels: ctx.channels });
    if (!sp) {
      warn(`Sample "${ctx.name}" uses the acquisition matrix of its FCS file, which the workspace keywords do not contain; the sample is shown uncompensated.`);
      return null;
    }
    detectors = sp.channels;
    matrix = sp.matrix;
    name = 'Acquisition-defined';
  } else {
    const m = lg.matrices[cid - 1];
    if (!m) {
      warn(`Sample "${ctx.name}" refers to compensation matrix ${cid}, which the workspace does not contain; the sample is shown uncompensated.`);
      return null;
    }
    name = m.attrs['name'] ?? `Matrix ${cid}`;
    prefix = m.attrs['prefix'] ?? '<';
    suffix = m.attrs['suffix'] ?? '>';
    const rows = childrenNamed(m, 'Channel');
    detectors = rows.map((r) => r.attrs['name'] ?? '').filter(Boolean);
    const idx = new Map(detectors.map((d, i) => [d, i]));
    matrix = detectors.map((_, i) => detectors.map((__, j) => (i === j ? 1 : 0)));
    // <Channel name="source"><ChannelValue name="detector" value="spillover"/>
    for (const r of rows) {
      const i = idx.get(r.attrs['name'] ?? '');
      if (i === undefined) continue;
      for (const cv of childrenNamed(r, 'ChannelValue')) {
        const j = idx.get(cv.attrs['name'] ?? '');
        const v = Number(cv.attrs['value']);
        if (j !== undefined && Number.isFinite(v)) matrix[i][j] = v;
      }
    }
  }
  const channels = detectors.map((d) => resolveChannel(ctx, d));
  const key = JSON.stringify([channels, matrix]);
  let def = intern.get(key);
  if (!def) {
    const acq = name === 'Acquisition-defined';
    def = { id: uid('comp'), name: acq ? 'Acquisition matrix (FlowJo)' : name, channels, matrix, source: acq ? 'file' : 'manual' };
    const same = [...intern.values()].filter((c) => c.name === def!.name || c.name.startsWith(def!.name + ' ('));
    if (same.length) def.name = `${def.name} (${same.length + 1})`;
    intern.set(key, def);
  }
  return { prefix, suffix, detectors, def, matrixName: name };
}

/**
 * Display transforms of a FlowJo 9 sample: per <Parameter> (log="1": its calibration table, else linear lowValue ..
 * highValue), and per compensated parameter the table "<matrix name> <prefix><name><suffix>" when there is one.
 */
function legacyTransforms(sEl: XNode, ctx: SampleCtx, lg: LegacyCtx, intern: (s: ScaleDef) => ScaleDef) {
  for (const pe of childrenNamed(sEl, 'Parameter')) {
    const name = (pe.attrs['name'] ?? '').trim();
    if (!name) continue;
    const lo = num(pe.attrs['lowValue']) ?? 0;
    const hi = num(pe.attrs['highValue']) ?? (ctx.channels.find((c) => c.name === name)?.range || 262144);
    let scale: ScaleDef | null = null;
    if (pe.attrs['log'] === '1') {
      const ci = num(pe.attrs['calibrationIndex']);
      const t = ci !== undefined ? lg.tables[ci - 1] : undefined;
      if (t && t.values.length) scale = tableScale(t, lg, ctx);
      if (!scale) {
        const dec = num(pe.attrs['decades']) ?? 4;
        scale = { type: 'log', min: lo > 0 ? lo : hi / Math.pow(10, dec > 0 ? dec : 4), max: hi, clampLow: true };
      }
    } else {
      // highValue can be in display channels (4096 with gain 1/64) while the gates are in raw values: the axis spans at
      // least the parameter's range (off-scale events are placed on the axis edge)
      const top = Math.max(hi, ctx.channels.find((c) => c.name === name)?.range ?? 0);
      scale = { type: 'linear', min: lo, max: top > lo ? top : lo + 1 };
    }
    ctx.transforms.set(name, { scale: intern(scale), k: 1 });
  }
  const comp = ctx.comp;
  if (!comp) return;
  for (const d of comp.detectors) {
    const cname = comp.prefix + d + comp.suffix;
    const t = lg.byName.get(`${comp.matrixName} ${cname}`);
    const s = t && t.values.length ? tableScale(t, lg, ctx) : null;
    const base = ctx.transforms.get(resolveChannel(ctx, d)) ?? ctx.transforms.get(d);
    if (s) ctx.transforms.set(cname, { scale: intern(s), k: 1 });
    else if (base) ctx.transforms.set(cname, base);
  }
}

/** Gate of a FlowJo 9 population: <PolygonGate> with <ParameterNames> and a <Polygon>, <PolyRect>, <Ellipse> or <Range>. */
function convertLegacyGate(pop: XNode, ctx: SampleCtx, path: string[]): { geom: GateGeom | null; complement: boolean } | null {
  const where = `"${path.join(' / ')}" (sample "${ctx.name}")`;
  const pg = child(pop, 'PolygonGate');
  if (!pg) {
    const other = pop.children.find((c) => /Gate$/.test(c.name));
    ctx.warn(other ? `Gate ${where}: FlowJo 9 ${other.name} gates are not supported.` : `Population ${where} has no gate.`);
    return null;
  }
  const pn = child(pg, 'ParameterNames');
  const arr = pn ? child(pn, 'StringArray') : undefined;
  const names = (arr ? childrenNamed(arr, 'String') : []).map((x) => x.text.trim());
  const shape = pg.children.find((c) => c.name !== 'ParameterNames' && c.name !== 'Graph');
  const polyEl = shape ? child(shape, 'Polygon') : undefined;
  const verts: Pt[] = (polyEl ? childrenNamed(polyEl, 'Vertex') : []).map((v) => [Number(v.attrs['x']), Number(v.attrs['y'])]);
  if (!shape || !verts.length || verts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    ctx.warn(`Gate ${where}: the FlowJo 9 gate could not be read.`);
    return null;
  }
  const used = shape.name === 'Range' ? names.slice(0, 1) : names.slice(0, 2);
  if (!used.length || used.some((n) => !n)) {
    ctx.warn(`Gate ${where}: unsupported dimension.`);
    return null;
  }
  const dims = used.map((n) => dimOf(ctx, n));
  const missingCh = dims.find((d) => ctx.channels.length && !ctx.channels.some((c) => c.name === d.ch));
  if (missingCh) ctx.warn(`Gate ${where} uses parameter "${missingCh.ch}", which is not in the sample's keywords (derived parameter?).`);
  const comp = gateComp(ctx, dims, path);
  const withComp = <G extends GateGeom>(g: G): G => (comp ? { ...g, comp } : g);
  // a side at (or beyond) the edge of the axis also takes the off-scale events, as in FlowJo
  const bound = (d: Dim, lo: number, hi: number): [number, number] => {
    const sc = makeScale(d.scale);
    return [sc.fwd(lo) <= EDGE ? -Infinity : lo, sc.fwd(hi) >= 1 - EDGE ? Infinity : hi];
  };
  // negated="1": the population is the events outside the drawn shape (e.g. "not debris")
  const complement = shape.attrs['negated'] === '1' || pg.attrs['negated'] === '1';
  switch (shape.name) {
    case 'Range': {
      const xs = verts.map((p) => p[0]);
      const [mn, mx] = bound(dims[0], Math.min(...xs), Math.max(...xs));
      return { geom: withComp({ type: 'range', x: dims[0].ch, min: mn, max: mx }), complement };
    }
    case 'PolyRect': {
      if (dims.length !== 2) break;
      const xs = verts.map((p) => p[0]);
      const ys = verts.map((p) => p[1]);
      const [x0, x1] = bound(dims[0], Math.min(...xs), Math.max(...xs));
      const [y0, y1] = bound(dims[1], Math.min(...ys), Math.max(...ys));
      return { geom: withComp({ type: 'rect', x: dims[0].ch, y: dims[1].ch, xmin: x0, xmax: x1, ymin: y0, ymax: y1 }), complement };
    }
    case 'Polygon': {
      if (dims.length !== 2 || verts.length < 3) break;
      return { geom: withComp({ type: 'polygon', x: dims[0].ch, y: dims[1].ch, points: verts, scales: { x: dims[0].scale, y: dims[1].scale }, strict: false }), complement };
    }
    case 'Ellipse': {
      if (dims.length !== 2 || verts.length !== 4) break;
      // the four ends of the ellipse's two axes (FlowJo 9 writes them as pairs: 0-1 and 2-3), in the display space of
      // the axes; the pairing whose midpoints coincide is used
      const sx = makeScale(dims[0].scale);
      const sy = makeScale(dims[1].scale);
      const d = verts.map((p): Pt => [sx.fwd(p[0]), sy.fwd(p[1])]);
      const mid = (i: number, j: number): Pt => [(d[i][0] + d[j][0]) / 2, (d[i][1] + d[j][1]) / 2];
      const pairings: [number, number, number, number][] = [
        [0, 1, 2, 3],
        [0, 2, 1, 3],
        [0, 3, 1, 2],
      ];
      const gap = (q: [number, number, number, number]) => Math.hypot(mid(q[0], q[1])[0] - mid(q[2], q[3])[0], mid(q[0], q[1])[1] - mid(q[2], q[3])[1]);
      const [i0, i1, j0, j1] = pairings.reduce((a, b) => (gap(b) < gap(a) ? b : a));
      const c: Pt = [(d[0][0] + d[1][0] + d[2][0] + d[3][0]) / 4, (d[0][1] + d[1][1] + d[2][1] + d[3][1]) / 4];
      const va: Pt = [(d[i0][0] - d[i1][0]) / 2, (d[i0][1] - d[i1][1]) / 2];
      const vb: Pt = [(d[j0][0] - d[j1][0]) / 2, (d[j0][1] - d[j1][1]) / 2];
      const g = displayEllipse(c, va, vb, dims);
      if (!g) break;
      return { geom: withComp(g), complement };
    }
    default:
      ctx.warn(`Gate ${where}: FlowJo 9 "${shape.name}" gates are not supported.`);
      return null;
  }
  ctx.warn(`Gate ${where}: the FlowJo 9 ${shape.name} gate could not be read.`);
  return null;
}

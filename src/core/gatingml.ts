// Gating-ML 2.0 import / export.
import { invertMatrix } from './compensation';
import { engine } from './engine';
import { escapeXml, parseXml, child, childrenNamed, type XNode } from './xml';
import { GATE_COLORS, gateParams, gateProblem, isDerivedChannel, popDescendants, uid, type CompDef, type GateGeom, type Population, type Pt, type Workspace } from './model';
import { isStrictGate, pointInPolygon, polygonGateGrids } from './gating';
import { scopeLabel } from './scope';
import { isFlowJoBiexActive, makeScale, scaleDefProblem, type BaseScaleDef, type ScaleDef } from './transforms';

const NS = {
  gating: 'http://www.isac-net.org/std/Gating-ML/v2.0/gating',
  transforms: 'http://www.isac-net.org/std/Gating-ML/v2.0/transformations',
  dt: 'http://www.isac-net.org/std/Gating-ML/v2.0/datatypes',
};

export interface GmlImportResult {
  populations: Population[];
  compensations: CompDef[];
  scales: Record<string, ScaleDef>; // suggested display scales per channel
  compRef: string | null; // 'FCS', 'uncompensated', or a CompDef id used by the gates
  warnings: string[];
  idMap: Record<string, string>; // gml id -> population id
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === null || s.trim() === '') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

function parseTransform(n: XNode, warnings: string[]): ScaleDef | null {
  const t = n.children[0];
  if (!t) return null;
  const a = (k: string) => num(t.attrs[k]);
  let def: ScaleDef | null;
  switch (t.name) {
    case 'logicle':
      def = { type: 'logicle', T: a('T')!, W: a('W')!, M: a('M')!, A: a('A') ?? 0 };
      break;
    case 'fasinh':
      def = { type: 'arcsinh', T: a('T')!, M: a('M')!, A: a('A') ?? 0 };
      break;
    case 'flin': {
      const T = a('T')!;
      const A = a('A') ?? 0;
      def = { type: 'linear', min: -A, max: T };
      break;
    }
    case 'flog': {
      const T = a('T')!;
      const M = a('M')!;
      def = { type: 'log', min: T / Math.pow(10, M), max: T };
      break;
    }
    default:
      return null; // hyperlog, fratio not supported
  }
  // missing or out-of-range parameters (e.g. T="abc", M="-Infinity") would turn every gate on this axis into NaN
  if (!validScaleDef(def)) {
    warnings.push(`Transformation "${n.attrs['id'] ?? '?'}" (${t.name}) has missing or invalid parameters; gates using it were skipped`);
    return null;
  }
  return def;
}

/** Whether a scale definition is usable (see scaleDefProblem). */
function validScaleDef(def: ScaleDef): boolean {
  return scaleDefProblem(def) === null;
}

interface Dim {
  name: string;
  comp: string;
  transform: ScaleDef | null;
  min?: number;
  max?: number;
}

function parseDim(d: XNode, transforms: Record<string, ScaleDef | null>, warnings: string[], flMaps: Record<string, Record<string, string>> = {}, gid = '?'): Dim | null {
  const fd = child(d, 'fcs-dimension');
  if (!fd) {
    warnings.push(child(d, 'new-dimension') || child(d, 'ratio') ? 'Unsupported dimension type (ratio / new-dimension)' : `Gate ${gid}: a dimension names no channel (no fcs-dimension); the gate was skipped`);
    return null;
  }
  const tref = d.attrs['transformation-ref'];
  const transform = tref ? transforms[tref] ?? null : null;
  if (tref && !transform) warnings.push(`Unsupported transformation "${tref}"`);
  if (tref && !transform) return null;
  const comp = d.attrs['compensation-ref'] ?? 'uncompensated';
  const raw = (fd.attrs['name'] ?? '').trim();
  if (!raw) {
    warnings.push(`Gate ${gid}: a dimension has no channel name; the gate was skipped`);
    return null;
  }
  const name = flMaps[comp]?.[raw] ?? raw;
  // a bound that is there but not a number ("1,5", "abc") must not become an open bound
  for (const k of ['min', 'max'])
    if ((d.attrs[k] ?? '').trim() && num(d.attrs[k]) === undefined) {
      warnings.push(`Gate ${gid}: the ${k} of ${name} ("${d.attrs[k].slice(0, 20)}") is not a number; the gate was skipped`);
      return null;
    }
  return { name, comp, transform, min: num(d.attrs['min']), max: num(d.attrs['max']) };
}

const toRaw = (t: ScaleDef | null, v: number) => (t ? makeScale(t).inv(v) : v);
const IDENT: ScaleDef = { type: 'linear', min: 0, max: 1 };

export function importGatingML(xml: string, opts: { perGateComp?: boolean } = {}): GmlImportResult {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => c.name === 'Gating-ML');
  if (!root) throw new Error('Not a Gating-ML document');
  const warnings: string[] = [];
  const transforms: Record<string, ScaleDef | null> = {};
  const comps: CompDef[] = [];
  const flMaps: Record<string, Record<string, string>> = {};
  for (const t of childrenNamed(root, 'transformation')) transforms[t.attrs['id']] = parseTransform(t, warnings);
  // matrices that cannot be used for compensation: gates referring to them are skipped (their dimensions name
  // fluorochromes that only the matrix maps to detectors)
  const unusableComps = new Map<string, string>();
  for (const sm of childrenNamed(root, 'spectrumMatrix')) {
    const mid = sm.attrs['id'] ?? '?';
    const fl = child(sm, 'fluorochromes');
    const det = child(sm, 'detectors');
    const names = (det ?? fl)?.children.map((c) => c.attrs['name']) ?? [];
    const flNames = fl?.children.map((c) => c.attrs['name']) ?? names;
    const rows = childrenNamed(sm, 'spectrum').map((r) => r.children.map((c) => Number(c.attrs['value'])));
    if (!rows.length) continue;
    // a matrix the engine can use: one row per fluorochrome, one finite value per detector
    if (names.some((x) => !x) || rows.length !== flNames.length || rows.some((r) => r.length !== names.length || r.some((v) => !Number.isFinite(v)))) {
      warnings.push(`Spectrum matrix "${mid}" is incomplete or has values that are not numbers; it was skipped (gates using it are evaluated uncompensated)`);
      continue;
    }
    // more detectors than fluorochromes (spectral unmixing) is not compensation: the engine needs a square matrix
    if (flNames.length !== names.length) {
      const why = `it is not square (${flNames.length} fluorochromes, ${names.length} detectors), which compensation cannot use`;
      warnings.push(`Spectrum matrix "${mid}" was skipped: ${why}`);
      unusableComps.set(mid, why);
      continue;
    }
    let matrix = rows;
    if (sm.attrs['matrix-inverted-already'] === 'true') {
      // the compensation matrix (inverse of the spillover) is given: its inverse is the spillover the app keeps
      let inv: number[][] | null = null;
      try {
        inv = invertMatrix(rows);
      } catch {
        inv = null;
      }
      if (!inv || inv.some((r) => r.some((v) => !Number.isFinite(v)))) {
        const why = 'it is marked as already inverted, but it cannot be inverted back to a spillover matrix (singular)';
        warnings.push(`Spectrum matrix "${mid}" was skipped: ${why}`);
        unusableComps.set(mid, why);
        continue;
      }
      matrix = inv;
    }
    comps.push({ id: sm.attrs['id'], name: sm.attrs['id'], channels: names, matrix, source: 'gatingml' });
    flMaps[sm.attrs['id']] = Object.fromEntries(flNames.map((f, i) => [f, names[i]]));
  }
  const pops: Population[] = [];
  const idMap: Record<string, string> = {};
  const scales: Record<string, ScaleDef> = {};
  const compRefs = new Set<string>();
  let colorIdx = 0;
  const nextColor = () => GATE_COLORS[colorIdx++ % GATE_COLORS.length];
  let pending: { gmlId: string; parentGml?: string; pop: Population }[] = [];

  const nameOf = (g: XNode, id: string) => {
    const ci = child(g, 'custom_info');
    const nm = ci ? child(ci, 'name')?.text.trim() : undefined;
    return nm || id;
  };
  const colorOf = (g: XNode) => {
    const ci = child(g, 'custom_info');
    return ci ? child(ci, 'color')?.text.trim() : undefined;
  };

  for (const g of root.children) {
    const gid = g.attrs['id'];
    const parentGml = g.attrs['parent_id'];
    const dims = () => childrenNamed(g, 'dimension').map((d) => parseDim(d, transforms, warnings, flMaps, gid));
    const gateRefs = new Set<string>();
    const add = (gmlId: string, geom: GateGeom, name?: string): boolean => {
      const bad = gateProblem(geom) ?? (geom.type === 'bool' && !geom.operands.length ? 'it refers to no gates' : null);
      if (bad) {
        warnings.push(`Gate ${gmlId ?? '?'} skipped: ${bad}`);
        return false;
      }
      if (geom.type !== 'bool') {
        const badComp = [...gateRefs].find((r) => unusableComps.has(r));
        if (badComp !== undefined) {
          warnings.push(`Gate ${gmlId ?? '?'} skipped: it uses spectrum matrix "${badComp}", which was not imported (${unusableComps.get(badComp)})`);
          return false;
        }
        const refs = [...gateRefs];
        const r = refs.find((x) => x !== 'uncompensated') ?? refs[0];
        if (r) refs.forEach((x) => compRefs.add(x));
        if (opts.perGateComp && r) geom = { ...geom, comp: r === 'uncompensated' ? 'none' : r === 'FCS' ? 'file' : r };
      }
      const pop: Population = { id: uid('pop'), name: name ?? gmlId, parentId: null, gate: geom, color: colorOf(g) ?? nextColor() };
      pending.push({ gmlId, parentGml, pop });
      return true;
    };
    if (/Gate$/.test(g.name) && !gid) {
      warnings.push(`A ${g.name} has no id; it was skipped`);
      continue;
    }
    switch (g.name) {
      case 'RectangleGate': {
        const ds = dims();
        if (ds.some((d) => !d)) break;
        const dd = ds as Dim[];
        dd.forEach((d) => gateRefs.add(d.comp));
        const lo = (d: Dim) => (d.min === undefined ? -Infinity : toRaw(d.transform, d.min));
        const hi = (d: Dim) => (d.max === undefined ? Infinity : toRaw(d.transform, d.max));
        dd.forEach((d) => d.transform && (scales[d.name] = d.transform));
        if (dd.length === 1) add(gid, { type: 'range', x: dd[0].name, min: lo(dd[0]), max: hi(dd[0]) }, nameOf(g, gid));
        else if (dd.length === 2)
          add(gid, { type: 'rect', x: dd[0].name, y: dd[1].name, xmin: lo(dd[0]), xmax: hi(dd[0]), ymin: lo(dd[1]), ymax: hi(dd[1]) }, nameOf(g, gid));
        else warnings.push(`Gate ${gid}: rectangle gates with ${dd.length} dimensions are not supported`);
        break;
      }
      case 'PolygonGate': {
        const ds = dims();
        if (ds.some((d) => !d) || ds.length !== 2) {
          warnings.push(`Gate ${gid}: unsupported polygon dimensions`);
          break;
        }
        const [dx, dy] = ds as Dim[];
        gateRefs.add(dx.comp);
        gateRefs.add(dy.comp);
        const pts: Pt[] = childrenNamed(g, 'vertex').map((v) => {
          const c = childrenNamed(v, 'coordinate').map((cc) => Number(cc.attrs['value']));
          return [toRaw(dx.transform, c[0]), toRaw(dy.transform, c[1])];
        });
        if (dx.transform) scales[dx.name] = dx.transform;
        if (dy.transform) scales[dy.name] = dy.transform;
        add(gid, { type: 'polygon', x: dx.name, y: dy.name, points: pts, scales: { x: dx.transform ?? IDENT, y: dy.transform ?? IDENT }, strict: true }, nameOf(g, gid));
        break;
      }
      case 'EllipsoidGate': {
        const ds = dims();
        if (ds.some((d) => !d) || ds.length !== 2) {
          warnings.push(`Gate ${gid}: only 2D ellipsoid gates are supported`);
          break;
        }
        const [dx, dy] = ds as Dim[];
        gateRefs.add(dx.comp);
        gateRefs.add(dy.comp);
        const meanEl = child(g, 'mean');
        const covEl = child(g, 'covarianceMatrix');
        const mean = meanEl ? childrenNamed(meanEl, 'coordinate').map((c) => Number(c.attrs['value'])) : [];
        const cov = covEl ? childrenNamed(covEl, 'row').map((r) => childrenNamed(r, 'entry').map((e) => Number(e.attrs['value']))) : [];
        const d2 = Number(child(g, 'distanceSquare')?.attrs['value'] ?? '1');
        const okNums = mean.length >= 2 && cov.length >= 2 && cov[0].length >= 2 && cov[1].length >= 2 && [mean[0], mean[1], cov[0][0], cov[0][1], cov[1][1], d2].every(Number.isFinite);
        if (!okNums || !(d2 > 0)) {
          warnings.push(`Gate ${gid} skipped: the ellipsoid needs a mean (2 coordinates), a 2 x 2 covariance matrix and a positive distance, all numbers`);
          break;
        }
        // eigen-decomposition of 2x2 symmetric covariance
        const a = cov[0][0],
          b = cov[0][1],
          c = cov[1][1];
        const tr = a + c;
        const det = a * c - b * b;
        const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
        const l1 = tr / 2 + disc;
        const l2 = tr / 2 - disc;
        let v1: Pt = Math.abs(b) > 1e-15 ? [l1 - c, b] : a >= c ? [1, 0] : [0, 1];
        const n1 = Math.hypot(v1[0], v1[1]);
        v1 = [v1[0] / n1, v1[1] / n1];
        const v2: Pt = [-v1[1], v1[0]];
        const r1 = Math.sqrt(Math.max(0, l1 * d2));
        const r2 = Math.sqrt(Math.max(0, l2 * d2));
        const cT: Pt = [mean[0], mean[1]];
        const aT: Pt = [mean[0] + r1 * v1[0], mean[1] + r1 * v1[1]];
        const bT: Pt = [mean[0] + r2 * v2[0], mean[1] + r2 * v2[1]];
        const raw = (p: Pt): Pt => [toRaw(dx.transform, p[0]), toRaw(dy.transform, p[1])];
        if (dx.transform) scales[dx.name] = dx.transform;
        if (dy.transform) scales[dy.name] = dy.transform;
        add(gid, { type: 'ellipse', x: dx.name, y: dy.name, center: raw(cT), a: raw(aT), b: raw(bT), scales: { x: dx.transform ?? IDENT, y: dy.transform ?? IDENT }, strict: true }, nameOf(g, gid));
        break;
      }
      case 'QuadrantGate': {
        const divs = childrenNamed(g, 'divider').map((d) => {
          const fd = child(d, 'fcs-dimension');
          const tref = d.attrs['transformation-ref'];
          const t = tref ? transforms[tref] ?? null : null;
          gateRefs.add(d.attrs['compensation-ref'] ?? 'uncompensated');
          const values = childrenNamed(d, 'value').map((v) => toRaw(t, Number(v.text.trim()))).sort((p, q) => p - q);
          return { id: d.attrs['id'], name: (fd?.attrs['name'] ?? '').trim(), values, t, tref };
        });
        const badDiv = divs.find((d) => !d.name || !d.values.length || d.values.some((v) => !Number.isFinite(v)) || (d.tref && !d.t));
        if (!divs.length || badDiv) {
          warnings.push(`Quadrant gate ${gid} skipped: ${!divs.length ? 'it has no dividers' : !badDiv!.name ? 'a divider names no channel' : badDiv!.tref && !badDiv!.t ? `unsupported transformation "${badDiv!.tref}"` : 'a divider value is not a number'}`);
          break;
        }
        const quads = childrenNamed(g, 'Quadrant');
        const simple = divs.length === 2 && divs.every((d) => d.values.length === 1);
        const groupId = uid('quad');
        // names / colors of the quadrants as written by our exporter
        const qInfo = new Map((child(g, 'custom_info')?.children ?? []).filter((c) => c.name === 'quadrant').map((c) => [c.attrs['ref'], c]));
        for (const q of quads) {
          const qid = q.attrs['id'];
          const qi = qInfo.get(qid);
          const qName = (qi && child(qi, 'name')?.text.trim()) || qid;
          const qColor = qi ? child(qi, 'color')?.text.trim() : undefined;
          const addQ = (geom: GateGeom) => {
            add(qid, geom, qName);
            if (qColor) pending[pending.length - 1].pop.color = qColor;
          };
          const bounds: Record<string, [number, number]> = {};
          for (const p of childrenNamed(q, 'position')) {
            const dv = divs.find((d) => d.id === p.attrs['divider_ref']);
            if (!dv) continue;
            const loc = toRaw(dv.t, Number(p.attrs['location']));
            if (!Number.isFinite(loc)) continue;
            let lo = -Infinity,
              hi = Infinity;
            for (const v of dv.values) {
              if (v <= loc) lo = v;
              else {
                hi = v;
                break;
              }
            }
            bounds[dv.id] = [lo, hi];
          }
          if (simple && Object.keys(bounds).length === 2) {
            const [d0, d1] = divs;
            const upX = bounds[d0.id][0] > -Infinity;
            const upY = bounds[d1.id][0] > -Infinity;
            const quadrant = upX ? (upY ? 'UR' : 'LR') : upY ? 'UL' : 'LL';
            addQ({ type: 'quadrant', x: d0.name, y: d1.name, cx: d0.values[0], cy: d1.values[0], quadrant, groupId });
          } else {
            const ks = Object.keys(bounds);
            const dv = (k: string) => divs.find((d) => d.id === k)!;
            if (ks.length === 1) addQ({ type: 'range', x: dv(ks[0]).name, min: bounds[ks[0]][0], max: bounds[ks[0]][1] });
            else if (ks.length === 2)
              addQ({ type: 'rect', x: dv(ks[0]).name, y: dv(ks[1]).name, xmin: bounds[ks[0]][0], xmax: bounds[ks[0]][1], ymin: bounds[ks[1]][0], ymax: bounds[ks[1]][1] });
            else warnings.push(`Quadrant ${qid}: more than two dividers not supported`);
          }
        }
        break;
      }
      case 'BooleanGate': {
        const opNode = g.children.find((c) => c.name === 'and' || c.name === 'or' || c.name === 'not');
        if (!opNode) {
          warnings.push(`Boolean gate ${gid} skipped: it has no and / or / not element`);
          break;
        }
        const refs = childrenNamed(opNode, 'gateReference')
          .filter((r) => (r.attrs['ref'] ?? '').trim())
          .map((r) => (r.attrs['use-as-complement'] === 'true' ? '!' : '') + r.attrs['ref'].trim());
        add(gid, { type: 'bool', op: opNode.name as 'and' | 'or' | 'not', operands: refs }, nameOf(g, gid));
        break;
      }
      default:
        break;
    }
  }
  // the same id twice: the first one is used
  const seenIds = new Set<string>();
  pending = pending.filter((p) => {
    if (!seenIds.has(p.gmlId)) {
      seenIds.add(p.gmlId);
      return true;
    }
    warnings.push(`Gate id "${p.gmlId}" occurs more than once; the second gate was skipped`);
    return false;
  });
  // parent cycles (A inside B inside A): no gate of a cycle has a defined parent; skipped with a note
  const parentOf = new Map(pending.map((p) => [p.gmlId, p.parentGml]));
  const inCycle = new Set<string>();
  for (const p of pending) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = p.gmlId;
    while (cur !== undefined && parentOf.has(cur) && !onPath.has(cur) && !inCycle.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur !== undefined && onPath.has(cur)) {
      const cyc = path.slice(path.indexOf(cur));
      cyc.forEach((c) => inCycle.add(c));
      warnings.push(
        cyc.length === 1
          ? `Gate "${cyc[0]}" names itself as its parent (parent_id), so its place in the gating tree is undefined; it was skipped`
          : `Gates ${cyc.map((c) => `"${c}"`).join(', ')} name each other as parent (parent_id), so their place in the gating tree is undefined; they were skipped`,
      );
    }
  }
  // drop gates whose parent or boolean operands could not be imported (and, transitively, their children)
  const known = new Set(pending.map((p) => p.gmlId));
  const dropped = new Set<string>(inCycle);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of pending) {
      if (dropped.has(p.gmlId)) continue;
      const missing = (ref: string) => !known.has(ref) || dropped.has(ref);
      let why = '';
      if (p.parentGml && missing(p.parentGml)) why = inCycle.has(p.parentGml) ? `its parent "${p.parentGml}" is part of a parent cycle` : `its parent "${p.parentGml}" was not imported`;
      else if (p.pop.gate.type === 'bool') {
        const ref = p.pop.gate.operands.map((o) => o.replace(/^!/, '')).find(missing);
        if (ref) why = `it refers to gate "${ref}", which was not imported`;
      }
      if (why) {
        dropped.add(p.gmlId);
        warnings.push(`Gate ${p.gmlId} skipped: ${why}`);
        changed = true;
      }
    }
  }
  pending = pending.filter((p) => !dropped.has(p.gmlId));
  for (const p of pending) idMap[p.gmlId] = p.pop.id;
  for (const p of pending) {
    if (p.parentGml) p.pop.parentId = idMap[p.parentGml] ?? null;
    if (p.pop.gate.type === 'bool') {
      p.pop.gate = { ...p.pop.gate, operands: p.pop.gate.operands.map((o) => (o.startsWith('!') ? '!' + (idMap[o.slice(1)] ?? o.slice(1)) : idMap[o] ?? o)) };
    }
    pops.push(p.pop);
  }
  // order parents before children (in document order otherwise); every pass places at least one gate, as cycles are gone
  const ordered: Population[] = [];
  const placed = new Set<string>();
  for (let progress = true; progress && ordered.length < pops.length; ) {
    progress = false;
    for (const p of pops) {
      if (placed.has(p.id)) continue;
      if (!p.parentId || placed.has(p.parentId)) {
        ordered.push(p);
        placed.add(p.id);
        progress = true;
      }
    }
  }
  const refs = [...compRefs];
  const compRef = refs.length === 1 ? refs[0] : refs.find((r) => r !== 'uncompensated') ?? null;
  if (refs.filter((r) => r !== 'uncompensated').length > 1) warnings.push('Gates use different compensation references; using one per sample');
  return { populations: ordered, compensations: comps, scales, compRef, warnings, idMap };
}

// ------------------------------------------------------------------ export

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '';
  return Number(v.toPrecision(10)).toString();
}

type NonLinearDef = Exclude<BaseScaleDef, { type: 'linear' }>;

function transformXml(id: string, def: NonLinearDef): string {
  switch (def.type) {
    case 'logicle':
      return `<transforms:transformation transforms:id="${id}"><transforms:logicle transforms:T="${fmt(def.T)}" transforms:W="${fmt(def.W)}" transforms:M="${fmt(def.M)}" transforms:A="${fmt(def.A)}"/></transforms:transformation>`;
    case 'arcsinh':
      return `<transforms:transformation transforms:id="${id}"><transforms:fasinh transforms:T="${fmt(def.T)}" transforms:M="${fmt(def.M)}" transforms:A="${fmt(def.A)}"/></transforms:transformation>`;
    case 'log': {
      // the same decades the app's log axis shows (min <= 0 is clamped to a tiny positive value, at least one decade)
      const lmin = Math.log10(Math.max(def.min, 1e-12));
      const lmax = Math.log10(Math.max(def.max, def.min * 10, 1e-11));
      return `<transforms:transformation transforms:id="${id}"><transforms:flog transforms:T="${fmt(Math.pow(10, lmax))}" transforms:M="${fmt(lmax - lmin)}"/></transforms:transformation>`;
    }
  }
}

/** Engine default for channels without a workspace scale (see engine.ts). */
const FALLBACK_SCALE: ScaleDef = { type: 'linear', min: 0, max: 262144 };

/**
 * Coordinate system of one exported axis: E = transformed value (non-linear scale, written with a transformation-ref)
 * or the raw value (linear scale), and the app's display coordinate C (0..1 = visible axis) in which polygon and
 * ellipse gates are evaluated. C is affine in E, except on FlowJo biex axes (`curved`): FlowJo's biex table has no
 * Gating-ML equivalent, so those axes are exported with the closest logicle and gate shapes are mapped point by point.
 */
interface Axis {
  t: NonLinearDef | null;
  e: (raw: number) => number;
  /** raw value -> display coordinate C (as the app gates) */
  c: (raw: number) => number;
  toC: (e: number) => number;
  toE: (c: number) => number;
  far: [number, number]; // display coordinates far below / above the axis (raw values stay finite)
  /** C -> E is not affine: straight edges in C must be densified */
  curved: boolean;
  /** the transform itself puts off-scale events on the axis edge (FlowJo biex), whatever the gate's strictness */
  clampsItself: boolean;
}

function axisOf(def: ScaleDef): Axis {
  const base = def.type === 'window' ? def.base : def;
  if (base.type === 'logicle' && base.flowjo && isFlowJoBiexActive(base)) return biexAxis(def, base);
  let k = 1;
  let d = 0;
  const t = base.type === 'linear' ? null : base;
  if (base.type === 'linear') {
    const span = base.max - base.min || 1;
    k = 1 / span;
    d = -base.min / span;
  }
  if (def.type === 'window') {
    const w = def.u1 - def.u0 || 1;
    k /= w;
    d = (d - def.u0) / w;
  }
  const sc = t ? makeScale(t) : null;
  const toC = (e: number) => k * e + d;
  // linear: 10^4 axis widths; transformed: the images of +-1e100 (beyond any float32 data, still invertible)
  const far: [number, number] = sc ? [toC(sc.fwd(t!.type === 'log' ? 1e-100 : -1e100)), toC(sc.fwd(1e100))] : [-FAR, 1 + FAR];
  const e = sc ? (v: number) => sc.fwd(v) : (v: number) => v;
  return { t, e, c: (v) => toC(e(v)), toC, toE: (c) => (c - d) / k, far, curved: false, clampsItself: false };
}

/**
 * FlowJo biex axis: exported as the closest logicle (E). Display C follows FlowJo's table, which puts values beyond the
 * table on the axis ends [cLo, cHi]; beyond those, C is extended linearly to the logicle images of +-1e100 so that the
 * off-table events (which have E beyond E(cLo) / E(cHi)) fall into the same region of the exported polygon.
 */
function biexAxis(def: ScaleDef, base: Extract<BaseScaleDef, { type: 'logicle' }>): Axis {
  const t: NonLinearDef = { type: 'logicle', T: base.T, W: base.W, M: base.M, A: base.A };
  const disp = makeScale(def);
  const exp = makeScale(t);
  const span = def.type === 'window' ? def.u1 - def.u0 || 1 : 1;
  const u0 = def.type === 'window' ? def.u0 : 0;
  const cLo = (0 - u0) / span;
  const cHi = (1 - u0) / span;
  const eLo = exp.fwd(disp.inv(cLo));
  const eHi = exp.fwd(disp.inv(cHi));
  const eFarLo = Math.min(exp.fwd(-1e100), eLo - 1);
  const eFarHi = Math.max(exp.fwd(1e100), eHi + 1);
  const far: [number, number] = [Math.min(cLo, 0) - 1, Math.max(cHi, 1) + 1];
  const toE = (c: number): number => {
    if (c <= cLo) return eLo + ((cLo - c) / (cLo - far[0])) * (eFarLo - eLo);
    if (c >= cHi) return eHi + ((c - cHi) / (far[1] - cHi)) * (eFarHi - eHi);
    return exp.fwd(disp.inv(c));
  };
  const toC = (e: number): number => {
    if (e <= eLo) return cLo - ((eLo - e) / (eLo - eFarLo)) * (cLo - far[0]);
    if (e >= eHi) return cHi + ((e - eHi) / (eFarHi - eHi)) * (far[1] - cHi);
    return disp.fwd(exp.inv(e));
  };
  return { t, e: (v) => exp.fwd(v), c: (v) => disp.fwd(v), toC, toE, far, curved: true, clampsItself: true };
}

/**
 * Map a polygon from display coordinates C to exported coordinates E. On curved (biex) axes a straight edge in C is a
 * curve in E: edges are subdivided until the exported straight segments stay within `tol` (E units) of the curve.
 */
function polygonToE(P: Pt[], ax: Axis, ay: Axis, tol = 2e-5): Pt[] {
  const E = (p: Pt): Pt => [ax.toE(p[0]), ay.toE(p[1])];
  if (!ax.curved && !ay.curved) return P.map(E);
  const out: Pt[] = [];
  const seg = (a: Pt, b: Pt, ea: Pt, eb: Pt, depth: number) => {
    // axis-parallel edges in C stay axis-parallel in E (each axis maps on its own)
    if (depth < 14 && a[0] !== b[0] && a[1] !== b[1]) {
      const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const em = E(m);
      const dev = Math.max(Math.abs(em[0] - (ea[0] + eb[0]) / 2), Math.abs(em[1] - (ea[1] + eb[1]) / 2));
      if (dev > tol || depth < 2) {
        seg(a, m, ea, em, depth + 1);
        out.push(em);
        seg(m, b, em, eb, depth + 1);
        return;
      }
    }
  };
  P.forEach((a, i) => {
    const b = P[(i + 1) % P.length];
    const ea = E(a);
    out.push(ea);
    seg(a, b, ea, E(b), 0);
  });
  return out;
}

/** Points of an ellipse (display coordinates: center and conjugate semi-axis vectors) as a closed polygon. */
function ellipsePolygon(c: Pt, va: Pt, vb: Pt, n = 256): Pt[] {
  return Array.from({ length: n }, (_, k): Pt => {
    const th = (2 * Math.PI * k) / n;
    return [c[0] + va[0] * Math.cos(th) + vb[0] * Math.sin(th), c[1] + va[1] * Math.cos(th) + vb[1] * Math.sin(th)];
  });
}

const FAR = 1e4;
const SIDES: [number, number][] = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
]; // [axis, value] of the four sides of the axis box

/**
 * Non-strict gates (drawn in the app) count off-scale events as sitting on the axis edge (see gating.ts). This returns a polygon
 * (display coordinates) with the same membership under strict even-odd semantics: the gate clipped to the axis box,
 * plus a far-reaching strip on every stretch of the box sides (and a quadrant at every box corner) where the app counts
 * the clamped events as inside. The pieces are joined into one ring by zero-width bridges.
 * Returns null when the gate lies inside the axis box (nothing to change).
 */
export function clampedPolygon(
  P: Pt[],
  far: [number, number][] = [[-FAR, 1 + FAR], [-FAR, 1 + FAR]],
  clampAxes: [boolean, boolean] = [true, true],
): { pts: Pt[]; lowX: boolean; lowY: boolean } | null {
  if (P.every(([x, y]) => (!clampAxes[0] || (x > 0 && x < 1)) && (!clampAxes[1] || (y > 0 && y < 1)))) return null;
  const sides = SIDES.filter(([ax]) => clampAxes[ax]);
  const xs = new Float64Array(P.map((p) => p[0]));
  const ys = new Float64Array(P.map((p) => p[1]));
  // loops, not Math.min(...xs): a polygon of very many vertices must not overflow the call stack
  const ext = (a: Float64Array): [number, number] => a.reduce<[number, number]>((m, v) => [Math.min(m[0], v), Math.max(m[1], v)], [Infinity, -Infinity]);
  const [[x0, x1], [y0, y1]] = [ext(xs), ext(ys)];
  const inApp = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && pointInPolygon(p[0], p[1], xs, ys);
  // Sutherland-Hodgman clip to the unit box (keeps the even-odd membership inside the box)
  let Q: Pt[] = P.map((p) => [p[0], p[1]]);
  for (const [ax, val] of sides) {
    const keep = (p: Pt) => (val === 0 ? p[ax] >= 0 : p[ax] <= 1);
    const out: Pt[] = [];
    Q.forEach((e, i) => {
      const s = Q[(i + Q.length - 1) % Q.length];
      const cut = (): Pt => {
        const f = (val - s[ax]) / (e[ax] - s[ax]);
        const p: Pt = [s[0] + f * (e[0] - s[0]), s[1] + f * (e[1] - s[1])];
        p[ax] = val;
        return p;
      };
      if (keep(e)) {
        if (!keep(s)) out.push(cut());
        out.push(e);
      } else if (keep(s)) out.push(cut());
    });
    Q = out;
  }
  const rings: Pt[][] = Q.length >= 3 ? [Q] : [];
  const at = (ax: number, a: number, b: number): Pt => (ax === 0 ? [a, b] : [b, a]);
  let lowX = false;
  let lowY = false;
  // strips: where the gate covers a stretch of a box side, events beyond it count
  // along a side, the other axis spans the unit box if it is clamped too, else the polygon's own extent
  const span = [clampAxes[0] ? [0, 1] : [x0, x1], clampAxes[1] ? [0, 1] : [y0, y1]];
  sides.forEach(([ax, v]) => {
    const o = 1 - ax;
    const [lo, hi] = span[o];
    const cuts = new Set([lo, hi]);
    P.forEach((a, i) => {
      const b = P[(i + 1) % P.length];
      if (a[ax] === v && a[o] > lo && a[o] < hi) cuts.add(a[o]);
      if ((a[ax] - v) * (b[ax] - v) < 0) {
        const c = a[o] + ((v - a[ax]) / (b[ax] - a[ax])) * (b[o] - a[o]);
        if (c > lo && c < hi) cuts.add(c);
      }
    });
    const cs = [...cuts].sort((p, q) => p - q);
    let start = -1;
    cs.forEach((c, k) => {
      const on = k < cs.length - 1 && inApp(at(ax, v, (c + cs[k + 1]) / 2));
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        rings.push([at(ax, v, start), at(ax, far[ax][v], start), at(ax, far[ax][v], c), at(ax, v, c)]);
        if (v === 0) ax === 0 ? (lowX = true) : (lowY = true);
        start = -1;
      }
    });
  });
  // corners: events beyond both axis ends sit on the corner
  for (const cx of clampAxes[0] && clampAxes[1] ? [0, 1] : [])
    for (const cy of [0, 1])
      if (inApp([cx, cy])) {
        const fx = far[0][cx];
        const fy = far[1][cy];
        rings.push([[cx, cy], [fx, cy], [fx, fy], [cx, fy]]);
        if (cx === 0) lowX = true;
        if (cy === 0) lowY = true;
      }
  // entirely off the axes: the app's gate is empty, so is a zero-area polygon far away
  if (!rings.length) return { pts: [0, 1, 2].map(() => [far[0][1], far[1][1]] as Pt), lowX, lowY };
  // attach each piece at its closest vertex (usually a shared one, so the bridge has no length)
  const [main, ...rest] = rings;
  const extra = main.map((): Pt[][] => []);
  for (const r of rest) {
    let best = [Infinity, 0, 0];
    main.forEach((m, i) => r.forEach((q, j) => {
      const d = Math.hypot(m[0] - q[0], m[1] - q[1]);
      if (d < best[0]) best = [d, i, j];
    }));
    const j = best[2];
    extra[best[1]].push([...r.slice(j), ...r.slice(0, j), r[j]]);
  }
  const pts: Pt[] = [];
  main.forEach((m, i) => {
    pts.push(m);
    for (const r of extra[i]) pts.push(...r, m);
  });
  return { pts, lowX, lowY };
}

/** A valid xs:ID (NCName) derived from a gate name; the readable name is kept in custom_info. */
function xsId(name: string): string {
  let id = name
    .trim()
    .replace(/\+/g, 'pos')
    .replace(/(?<=[A-Za-z0-9])-(?=$|[^A-Za-z0-9])/g, 'neg')
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!/^[A-Za-z_]/.test(id)) id = 'G_' + id;
  return id;
}

export interface GmlExport {
  xml: string;
  warnings: string[];
}

export function exportGatingML(ws: Workspace, opts: GmlExportOptions = {}): string {
  return exportGatingMLDoc(ws, opts).xml;
}

export interface GmlExportOptions {
  /** compensation of all gates ('FCS', 'uncompensated' or a matrix id); default: the samples' */
  compRef?: string;
  /**
   * Export for the samples of this instrument: polygon / ellipse gates that follow the axes use its own scales
   * (Workspace.instrumentScales) where it has them, as the app evaluates its samples. Default: the workspace scales.
   */
  instrument?: string;
  /**
   * The acquisition matrix of a sample's own file (null: the file has none; undefined: unknown, e.g. not loaded), to
   * tell whether a sample's acquisition matrix can be written as "FCS". Default: the app's engine (Engine.fileCompOf).
   */
  fileCompOf?: (sampleId: string) => { channels: string[]; matrix: number[][] } | null | undefined;
}

/** The same spillover matrix (channels in any order, values within `tol`). */
function sameMatrix(a: { channels: string[]; matrix: number[][] }, b: { channels: string[]; matrix: number[][] }, tol = 1e-6): boolean {
  const n = a.channels.length;
  if (b.channels.length !== n) return false;
  const at = new Map(b.channels.map((c, i) => [c, i]));
  if (at.size !== n) return false;
  const idx = a.channels.map((c) => at.get(c) ?? -1);
  if (idx.some((i) => i < 0)) return false;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (!(Math.abs((a.matrix[i]?.[j] ?? NaN) - (b.matrix[idx[i]]?.[idx[j]] ?? NaN)) <= tol)) return false;
  return true;
}

/**
 * Populations whose polygon / ellipse gates follow the axes on a channel some instrument has its own scale of: the app
 * evaluates them per instrument, one Gating-ML document holds one scale per channel (see exportGatingMLDoc `instrument`).
 */
export function instrumentDependentGates(ws: Workspace): Population[] {
  const inst = Object.values(ws.instrumentScales ?? {});
  if (!inst.length) return [];
  const own = (ch: string) => inst.some((m) => !!m?.[ch]);
  return ws.populations.filter((p) =>
    [p.gate, ...Object.values(p.overrides ?? {})].some(
      (g) => (g.type === 'polygon' || g.type === 'ellipse') && ((!g.scales?.x && own(g.x)) || (!g.scales?.y && own(g.y))),
    ),
  );
}

/** Gating-ML 2.0 document of all gates, plus notes on what other software will evaluate differently. */
export function exportGatingMLDoc(ws: Workspace, opts: GmlExportOptions = {}): GmlExport {
  const warnings: string[] = [];
  const lines: string[] = [];
  // every xs:ID in the document (gates, quadrants, dividers, transformations, matrices) is unique
  const usedIds = new Set<string>(['FCS', 'uncompensated']);
  const claim = (base: string) => {
    let id = xsId(base) || 'G';
    for (let k = 2; usedIds.has(id); k++) id = `${xsId(base)}_${k}`;
    usedIds.add(id);
    return id;
  };
  const gid = new Map<string, string>();
  for (const p of ws.populations) gid.set(p.id, claim(p.name || 'Gate'));

  const tIds = new Map<string, string>();
  const tXml: string[] = [];
  const transformRef = (ch: string, def: NonLinearDef): string => {
    const key = JSON.stringify(def);
    let id = tIds.get(key);
    if (!id) {
      id = claim(`T_${ch}`);
      tIds.set(key, id);
      tXml.push(transformXml(id, def));
    }
    return id;
  };

  // compensation: 'FCS' = each file's own acquisition matrix, 'uncompensated', or an exported spectrumMatrix
  const mIds = new Map<string, string>();
  const compXml: string[] = [];
  const matrixRef = (c: CompDef): string => {
    let id = mIds.get(c.id);
    if (!id) {
      id = claim(c.id);
      mIds.set(c.id, id);
      const dims = c.channels.map((n) => `<data-type:fcs-dimension data-type:name="${escapeXml(n)}"/>`).join('');
      const rows = c.matrix.map((r) => `<transforms:spectrum>${r.map((v) => `<transforms:coefficient transforms:value="${fmt(v)}"/>`).join('')}</transforms:spectrum>`).join('');
      compXml.push(`<transforms:spectrumMatrix transforms:id="${id}"><transforms:fluorochromes>${dims}</transforms:fluorochromes><transforms:detectors>${dims}</transforms:detectors>${rows}</transforms:spectrumMatrix>`);
    }
    return id;
  };
  const compById = (id: string | null | undefined) => (id ? ws.compensations.find((c) => c.id === id) : undefined);
  // An acquisition matrix (from FCS keywords) is written as "FCS" (each file's own matrix) only when it is the own
  // matrix of every sample using it. A sample can use another file's matrix ("Use Acquisition matrix 2 for all
  // samples"): then the matrix is written out, so other software applies the matrix the app applies. Samples whose
  // file is not loaded cannot be checked and do not count.
  const ownOf = opts.fileCompOf ?? ((sid: string) => (engine.has(sid) ? engine.fileCompOf(sid) : undefined));
  const fcsOk = new Map<string, boolean>();
  const isOwnFileMatrix = (c: CompDef): boolean => {
    let ok = fcsOk.get(c.id);
    if (ok === undefined) {
      ok = ws.samples
        .filter((s) => s.compId === c.id)
        .every((s) => {
          const own = ownOf(s.id);
          return own === undefined || (own !== null && sameMatrix(own, c));
        });
      fcsOk.set(c.id, ok);
    }
    return ok;
  };
  // the samples' compensation becomes the default of all gates
  let defKind = opts.compRef ?? 'uncompensated';
  if (!opts.compRef && ws.samples.length) {
    const kinds = ws.samples.map((s) => {
      const c = compById(s.compId);
      return !c ? 'uncompensated' : c.source === 'file' && isOwnFileMatrix(c) ? 'FCS' : c.id;
    });
    const counts = new Map<string, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    defKind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (counts.size > 1) {
      const label = (k: string) => (k === 'FCS' ? "each file's acquisition matrix" : k === 'uncompensated' ? 'no compensation' : `matrix "${compById(k)?.name ?? k}"`);
      warnings.push(`Samples use different compensation (${[...counts.keys()].map(label).join(', ')}); the exported gates use ${label(defKind)}.`);
    }
  }
  const kindRef = (k: string): string => {
    if (k === 'uncompensated' || k === 'none') return 'uncompensated';
    if (k === 'FCS' || k === 'file') return 'FCS';
    const c = compById(k);
    return c ? matrixRef(c) : 'uncompensated';
  };
  const compRefOf = (g: GateGeom) => kindRef(g.comp ?? defKind);

  const nOverrides = ws.populations.filter((p) => p.overrides && Object.keys(p.overrides).length).length;
  if (nOverrides)
    warnings.push(`${nOverrides} gate${nOverrides > 1 ? 's have' : ' has'} sample-specific positions. Gating-ML stores one position per gate, so the shared position was exported.`);
  // group- / sample-specific gating trees: Gating-ML has one tree for all files
  const scoped = ws.populations.filter((p) => p.scope);
  if (scoped.length) {
    const names = scoped.slice(0, 3).map((p) => `"${p.name}" (${scopeLabel(ws, p.scope)})`).join(', ') + (scoped.length > 3 ? ` and ${scoped.length - 3} more` : '');
    warnings.push(
      `${scoped.length} gate${scoped.length > 1 ? 's apply' : ' applies'} only to some samples: ${names}. Gating-ML has one gating tree for all files, so ${scoped.length > 1 ? 'they were' : 'it was'} exported for all samples; other software applies ${scoped.length > 1 ? 'them' : 'it'} to every file.`,
    );
  }

  // gates Gating-ML cannot represent are left out together with their descendants
  const skip = new Set<string>();
  // a missing boolean operand is an empty set (see gating.ts): AND / NOT become empty, OR ignores it
  const missingOp = (o: string) => !ws.populations.some((q) => q.id === o.replace(/^!/, ''));
  for (const p of ws.populations) {
    const g = p.gate;
    const bad =
      !g ||
      !!gateProblem(g) ||
      (g.type === 'bool' && (!g.operands.length || (g.op === 'or' ? g.operands.every(missingOp) : g.operands.some(missingOp))));
    if (!bad) continue;
    const sub = popDescendants(ws, p.id).filter((d) => !skip.has(d));
    [p.id, ...sub].forEach((d) => skip.add(d));
    warnings.push(`Gate "${p.name}" is incomplete and was not exported${sub.length ? ` (nor ${sub.length} gate${sub.length > 1 ? 's' : ''} inside it)` : ''}.`);
  }

  const info = (p: Population) => `<data-type:custom_info><name>${escapeXml(p.name)}</name><color>${escapeXml(p.color)}</color></data-type:custom_info>`;
  const parentAttr = (p: Population) => (p.parentId && gid.get(p.parentId) ? ` gating:parent_id="${gid.get(p.parentId)}"` : '');
  const dim = (ch: string, ref: string, extra = '', tref?: string) =>
    `<gating:dimension gating:compensation-ref="${escapeXml(ref)}"${tref ? ` gating:transformation-ref="${tref}"` : ''}${extra}><data-type:fcs-dimension data-type:name="${escapeXml(ch)}"/></gating:dimension>`;
  const mm = (lo: number, hi: number) => `${Number.isFinite(lo) ? ` gating:min="${fmt(lo)}"` : ''}${Number.isFinite(hi) ? ` gating:max="${fmt(hi)}"` : ''}`;
  const instScales = opts.instrument ? ws.instrumentScales?.[opts.instrument] : undefined;
  const scaleOf = (ch: string, own?: ScaleDef) => own ?? instScales?.[ch] ?? ws.scales[ch] ?? FALLBACK_SCALE;
  const big = (v: number, up: boolean) => fmt(up ? (Math.abs(v) + 1) * 2 + v : v - (Math.abs(v) + 1) * 2);
  const quadInfo = (members: Population[]) =>
    `<data-type:custom_info>${members.map((q) => `<quadrant ref="${gid.get(q.id)}"><name>${escapeXml(q.name)}</name><color>${escapeXml(q.color)}</color></quadrant>`).join('')}</data-type:custom_info>`;
  /** PolygonGate from display coordinates C (as the app evaluates the gate), with the app's off-scale semantics. */
  const polygonGateXml = (p: Population, id: string, chX: string, chY: string, ptsC: Pt[], ax: Axis, ay: Axis, strict: boolean, cref: string, comment?: string): string => {
    let pts = ptsC;
    // app-drawn gates count off-scale events on the axis edge; a FlowJo biex axis does so by itself
    const clampAxes: [boolean, boolean] = [!strict || ax.clampsItself, !strict || ay.clampsItself];
    if (clampAxes[0] || clampAxes[1]) {
      const r = clampedPolygon(pts, [ax.far, ay.far], clampAxes);
      if (r) {
        pts = r.pts;
        const logLow = [r.lowX && ax.t?.type === 'log' ? chX : '', r.lowY && ay.t?.type === 'log' ? chY : ''].filter(Boolean);
        if (logLow.length)
          warnings.push(`Gate "${p.name}": events at or below 0 on the log axis ${logLow.join(' / ')} are counted on the axis edge here but are excluded by other software.`);
      }
    }
    const ptsE = polygonToE(pts, ax, ay);
    const verts = ptsE.map((pt) => `<gating:vertex><gating:coordinate data-type:value="${fmt(pt[0])}"/><gating:coordinate data-type:value="${fmt(pt[1])}"/></gating:vertex>`).join('');
    const note = comment ? `<!-- ${escapeXml(comment).replace(/--/g, '- -')} -->` : '';
    return `${note}<gating:PolygonGate gating:id="${id}"${parentAttr(p)}>${info(p)}${dim(chX, cref, '', ax.t ? transformRef(chX, ax.t) : undefined)}${dim(chY, cref, '', ay.t ? transformRef(chY, ay.t) : undefined)}${verts}</gating:PolygonGate>`;
  };
  // gates on computed channels: other software has no such channel
  for (const p of ws.populations) {
    if (skip.has(p.id)) continue;
    const dch = gateParams(p.gate).filter((ch) => isDerivedChannel(ws, ch));
    if (!dch.length) continue;
    warnings.push(`Gate "${p.name}" uses computed channel${dch.length > 1 ? 's' : ''} ${dch.map((c) => `"${c}"`).join(' and ')}, which other programs cannot evaluate; export the population as FCS instead.`);
  }
  const onBiex = (g: GateGeom) => (g.type === 'polygon' || g.type === 'ellipse') && (axisOf(scaleOf(g.x, g.scales?.x)).curved || axisOf(scaleOf(g.y, g.scales?.y)).curved);
  const nBiex = ws.populations.filter((p) => !skip.has(p.id) && onBiex(p.gate)).length;
  if (nBiex)
    warnings.push(
      `${nBiex} polygon / ellipse gate${nBiex > 1 ? 's are' : ' is'} drawn on FlowJo biex axes. Gating-ML has no biex transform: the axes are exported as the closest logicle and the gate outlines are traced point by point. Other programs can count ${nBiex > 1 ? 'these gates' : 'this gate'} differently, most where an outline runs through many events near zero or along the axis edges; compare the counts after importing.`,
    );
  // imported FlowJo polygons are evaluated on FlowJo's channel grid here (as FlowJo counts them); Gating-ML has no grid
  const nGrid = ws.populations.filter((p) => !skip.has(p.id) && [p.gate, ...Object.values(p.overrides ?? {})].some((g) => !!polygonGateGrids(g))).length;
  if (nGrid)
    warnings.push(
      `${nGrid} polygon gate${nGrid > 1 ? 's' : ''} from FlowJo ${nGrid > 1 ? 'are' : 'is'} counted on FlowJo's channel grid here, as FlowJo does. FlowJo channel-grid gates are evaluated exactly by other programs; counts can differ, especially for dim populations.`,
    );
  const doneGroups = new Set<string>();
  for (const p of ws.populations) {
    if (skip.has(p.id)) continue;
    const g = p.gate;
    const id = gid.get(p.id)!;
    const cref = g.type === 'bool' ? '' : compRefOf(g);
    switch (g.type) {
      case 'rect':
        lines.push(`<gating:RectangleGate gating:id="${id}"${parentAttr(p)}>${info(p)}${dim(g.x, cref, mm(g.xmin, g.xmax))}${dim(g.y, cref, mm(g.ymin, g.ymax))}</gating:RectangleGate>`);
        break;
      case 'range':
        lines.push(`<gating:RectangleGate gating:id="${id}"${parentAttr(p)}>${info(p)}${dim(g.x, cref, mm(g.min, g.max))}</gating:RectangleGate>`);
        break;
      case 'polygon': {
        const ax = axisOf(scaleOf(g.x, g.scales?.x));
        const ay = axisOf(scaleOf(g.y, g.scales?.y));
        lines.push(polygonGateXml(p, id, g.x, g.y, g.points.map((pt): Pt => [ax.c(pt[0]), ay.c(pt[1])]), ax, ay, isStrictGate(g), cref));
        break;
      }
      case 'ellipse': {
        const ax = axisOf(scaleOf(g.x, g.scales?.x));
        const ay = axisOf(scaleOf(g.y, g.scales?.y));
        if (ax.curved || ay.curved) {
          // FlowJo biex axis: an ellipse in the biex display is no ellipse in the exported logicle space
          const C = (pt: Pt): Pt => [ax.c(pt[0]), ay.c(pt[1])];
          const c = C(g.center);
          const ca = C(g.a);
          const cb = C(g.b);
          const poly = ellipsePolygon(c, [ca[0] - c[0], ca[1] - c[1]], [cb[0] - c[0], cb[1] - c[1]]);
          lines.push(polygonGateXml(p, id, g.x, g.y, poly, ax, ay, isStrictGate(g), cref, 'Ellipse on a FlowJo biex axis, exported as a polygon in logicle space.'));
          break;
        }
        const E = (pt: Pt): Pt => [ax.e(pt[0]), ay.e(pt[1])];
        const c = E(g.center);
        const va: Pt = [E(g.a)[0] - c[0], E(g.a)[1] - c[1]];
        const vb: Pt = [E(g.b)[0] - c[0], E(g.b)[1] - c[1]];
        const cov = [
          [va[0] * va[0] + vb[0] * vb[0], va[0] * va[1] + vb[0] * vb[1]],
          [va[1] * va[0] + vb[1] * vb[0], va[1] * va[1] + vb[1] * vb[1]],
        ];
        let note = '';
        if (!isStrictGate(g)) {
          // The app counts off-scale events on the axis edge; an EllipsoidGate cannot express that, so an ellipse that
          // reaches past the axis may count a few events differently elsewhere.
          const ext = (a: Axis, i: 0 | 1) => {
            const cc = a.toC(c[i]);
            const r = Math.hypot(a.toC(c[i] + va[i]) - cc, a.toC(c[i] + vb[i]) - cc);
            return cc - r < 0 || cc + r > 1;
          };
          if (ext(ax, 0) || ext(ay, 1)) {
            const msg = `Gate "${p.name}" reaches beyond the axis: off-scale events on the axis edge are counted here but not by other software.`;
            warnings.push(msg);
            note = `<!-- ${escapeXml(msg).replace(/--/g, '- -')} -->`;
          }
        }
        lines.push(
          `${note}<gating:EllipsoidGate gating:id="${id}"${parentAttr(p)}>${info(p)}${dim(g.x, cref, '', ax.t ? transformRef(g.x, ax.t) : undefined)}${dim(g.y, cref, '', ay.t ? transformRef(g.y, ay.t) : undefined)}<gating:mean><gating:coordinate data-type:value="${fmt(c[0])}"/><gating:coordinate data-type:value="${fmt(c[1])}"/></gating:mean><gating:covarianceMatrix>${cov
            .map((r) => `<gating:row>${r.map((v) => `<gating:entry data-type:value="${fmt(v)}"/>`).join('')}</gating:row>`)
            .join('')}</gating:covarianceMatrix><gating:distanceSquare data-type:value="1"/></gating:EllipsoidGate>`,
        );
        break;
      }
      case 'quadrant': {
        if (doneGroups.has(g.groupId)) break;
        doneGroups.add(g.groupId);
        const members = ws.populations.filter((q) => q.gate.type === 'quadrant' && q.gate.groupId === g.groupId && !skip.has(q.id));
        const qid = claim(`Quad_${id}`);
        const dx = claim(`${qid}_Dx`);
        const dy = claim(`${qid}_Dy`);
        const quads = members
          .map((q) => {
            const qg = q.gate as Extract<GateGeom, { type: 'quadrant' }>;
            const upX = qg.quadrant === 'UR' || qg.quadrant === 'LR';
            const upY = qg.quadrant === 'UR' || qg.quadrant === 'UL';
            return `<gating:Quadrant gating:id="${gid.get(q.id)}"><gating:position gating:divider_ref="${dx}" gating:location="${big(g.cx, upX)}"/><gating:position gating:divider_ref="${dy}" gating:location="${big(g.cy, upY)}"/></gating:Quadrant>`;
          })
          .join('');
        lines.push(
          `<gating:QuadrantGate gating:id="${qid}"${parentAttr(p)}>${quadInfo(members)}<gating:divider gating:id="${dx}" gating:compensation-ref="${escapeXml(cref)}"><data-type:fcs-dimension data-type:name="${escapeXml(g.x)}"/><gating:value>${fmt(g.cx)}</gating:value></gating:divider><gating:divider gating:id="${dy}" gating:compensation-ref="${escapeXml(cref)}"><data-type:fcs-dimension data-type:name="${escapeXml(g.y)}"/><gating:value>${fmt(g.cy)}</gating:value></gating:divider>${quads}</gating:QuadrantGate>`,
        );
        break;
      }
      case 'split': {
        if (doneGroups.has(g.groupId)) break;
        doneGroups.add(g.groupId);
        const members = ws.populations.filter((q) => q.gate.type === 'split' && q.gate.groupId === g.groupId && !skip.has(q.id));
        const sid = claim(`Split_${id}`);
        const dx = claim(`${sid}_Dx`);
        const quads = members
          .map((q) => {
            const sg = q.gate as Extract<GateGeom, { type: 'split' }>;
            return `<gating:Quadrant gating:id="${gid.get(q.id)}"><gating:position gating:divider_ref="${dx}" gating:location="${big(g.cut, sg.side === 'hi')}"/></gating:Quadrant>`;
          })
          .join('');
        lines.push(
          `<gating:QuadrantGate gating:id="${sid}"${parentAttr(p)}>${quadInfo(members)}<gating:divider gating:id="${dx}" gating:compensation-ref="${escapeXml(cref)}"><data-type:fcs-dimension data-type:name="${escapeXml(g.x)}"/><gating:value>${fmt(g.cut)}</gating:value></gating:divider>${quads}</gating:QuadrantGate>`,
        );
        break;
      }
      case 'bool': {
        const refs = g.operands
          .map((o) => {
            const ref = gid.get(o.replace(/^!/, ''));
            return ref ? `<gating:gateReference gating:ref="${ref}"${o.startsWith('!') ? ' gating:use-as-complement="true"' : ''}/>` : '';
          })
          .filter(Boolean);
        // 'not' takes one operand, 'and' / 'or' at least two (a single operand is repeated)
        const ops = g.op === 'not' ? refs.slice(0, 1) : refs.length === 1 ? [refs[0], refs[0]] : refs;
        lines.push(`<gating:BooleanGate gating:id="${id}"${parentAttr(p)}>${info(p)}<gating:${g.op}>${ops.join('')}</gating:${g.op}></gating:BooleanGate>`);
        break;
      }
    }
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gating:Gating-ML xmlns:gating="${NS.gating}" xmlns:transforms="${NS.transforms}" xmlns:data-type="${NS.dt}">`,
    ...tXml.map((s) => '  ' + s),
    ...compXml.map((s) => '  ' + s),
    ...lines.map((s) => '  ' + s),
    '</gating:Gating-ML>',
    '',
  ].join('\n');
  return { xml, warnings };
}

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFcs, getSpillover } from '../src/core/fcs';
import { clampedPolygon, exportGatingMLDoc, importGatingML } from '../src/core/gatingml';
import { pointInPolygon } from '../src/core/gating';
import { Engine } from '../src/core/engine';
import { emptyWorkspace, type Population, type Pt, type Workspace } from '../src/core/model';

// Gating-ML 2.0 compliance suite (FlowKit gate_ref data; not part of the repository): skipped when the folder is missing
const DIR = '/home/claude/testdata/gatingml';
const HAVE_GML = ['data1.fcs', 'gml', 'truth'].every((f) => existsSync(join(DIR, f)));
const buf = HAVE_GML ? readFileSync(join(DIR, 'data1.fcs')) : null;
const ds = buf ? parseFcs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) : (null as unknown as ReturnType<typeof parseFcs>);
const gmlFiles = HAVE_GML ? readdirSync(join(DIR, 'gml')).filter((f) => f.endsWith('.xml') && f !== 'gml_all_gates.xml') : [];
const truthFiles = HAVE_GML ? readdirSync(join(DIR, 'truth')) : [];

function findGml(id: string): string | undefined {
  // prefer the smallest file containing the id as a gate id
  const hits = gmlFiles.filter((f) => readFileSync(join(DIR, 'gml', f), 'utf8').includes(`gating:id="${id}"`));
  hits.sort((a, b) => a.length - b.length);
  return hits[0];
}

describe.skipIf(!HAVE_GML)('Gating-ML 2.0 compliance (data1.fcs)', () => {
  it('parses data1.fcs', () => {
    expect(ds.eventCount).toBe(13367);
  });
  const results: { id: string; ok: boolean; note: string }[] = [];
  for (const tf of truthFiles) {
    const ALIAS: Record<string, string> = { ParQuadRect: 'ParRectangle1' };
    const id0 = tf.replace(/^Results_/, '').replace(/\.txt$/, '');
    const id = ALIAS[id0] ?? id0;
    it(`gate ${id}`, (ctx) => {
      const gf = findGml(id);
      if (!gf) {
        results.push({ id, ok: false, note: 'no gml' });
        ctx.skip();
        return;
      }
      const xml = readFileSync(join(DIR, 'gml', gf), 'utf8');
      const res = importGatingML(xml, { perGateComp: true });
      const popId = res.idMap[id];
      if (!popId) {
        results.push({ id, ok: false, note: 'unsupported: ' + res.warnings.join('; ') });
        ctx.skip();
        return;
      }
      const ws: Workspace = emptyWorkspace();
      ws.compensations = res.compensations;
      const spill = getSpillover(ds);
      let compId: string | null = null;
      if (res.compRef === 'FCS' && spill) {
        ws.compensations.push({ id: 'FCS', name: 'FCS', channels: spill.channels, matrix: spill.matrix, source: 'file' });
        compId = 'FCS';
      } else if (res.compRef && res.compRef !== 'uncompensated') compId = res.compRef;
      ws.samples = [{ id: 's1', name: 'data1', fileName: 'data1.fcs', fileSize: 0, eventCount: ds.eventCount, channels: [], compId }];
      ws.populations = res.populations;
      const eng = new Engine();
      eng.addSample('s1', ds);
      const idx = eng.population(ws, 's1', popId);
      const truth = readFileSync(join(DIR, 'truth', tf), 'utf8').trim().split(/\s+/).map(Number);
      const mask = new Uint8Array(ds.eventCount);
      idx.forEach((i) => (mask[i] = 1));
      let mism = 0;
      for (let i = 0; i < truth.length; i++) if (truth[i] !== mask[i]) mism++;
      results.push({ id, ok: mism === 0, note: `${gf} mismatches=${mism} n=${idx.length}` });
      expect(mism).toBe(0);
    });
  }
  afterAll(() => {
    console.log(results.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.id}: ${r.note}`).join('\n'));
  });
});

describe('Gating-ML export', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  it('clamped polygons count like the app (off-scale events on the axis edge)', () => {
    let mism = 0;
    for (let t = 0; t < 300; t++) {
      const n = 3 + Math.floor(rnd() * 6);
      const P: Pt[] = Array.from({ length: n }, () => [rnd() * 2 - 0.5, rnd() * 2 - 0.5]);
      const r = clampedPolygon(P);
      const xs = new Float64Array(P.map((p) => p[0]));
      const ys = new Float64Array(P.map((p) => p[1]));
      const R = r ? r.pts : P;
      const rx = new Float64Array(R.map((p) => p[0]));
      const ry = new Float64Array(R.map((p) => p[1]));
      for (let e = 0; e < 400; e++) {
        const x = rnd() * 3 - 1;
        const y = rnd() * 3 - 1;
        const cx = Math.min(1, Math.max(0, x));
        const cy = Math.min(1, Math.max(0, y));
        const app = cx >= Math.min(...xs) && cx <= Math.max(...xs) && cy >= Math.min(...ys) && cy <= Math.max(...ys) && pointInPolygon(cx, cy, xs, ys);
        if (app !== pointInPolygon(x, y, rx, ry)) mism++;
      }
    }
    expect(mism).toBe(0);
  });

  it('writes valid unique ids, keeps names and per-gate compensation', () => {
    const w: Workspace = emptyWorkspace();
    w.compensations = [{ id: 'c1', name: 'Acq', channels: ['A', 'B'], matrix: [[1, 0.1], [0, 1]], source: 'file' }];
    w.samples = [{ id: 's1', name: 's', fileName: 's.fcs', fileSize: 0, eventCount: 0, channels: [], compId: 'c1' }];
    const P = (id: string, name: string, gate: Population['gate'], parentId: string | null = null): Population => ({ id, name, parentId, color: '#123456', gate });
    w.populations = [
      P('p1', '1st cells', { type: 'rect', x: 'A', y: 'B', xmin: 0, xmax: 10, ymin: -Infinity, ymax: 5 }),
      P('p2', 'CD4+ CD8-', { type: 'quadrant', x: 'A', y: 'B', cx: 1, cy: 2, quadrant: 'LR', groupId: 'g' }, 'p1'),
      P('p3', 'CD4- CD8+', { type: 'quadrant', x: 'A', y: 'B', cx: 1, cy: 2, quadrant: 'UL', groupId: 'g' }, 'p1'),
      P('p4', 'Quad_CD4pos_CD8neg', { type: 'range', x: 'A', min: 1, max: 2, comp: 'none' }),
      P('p5', 'T_A', { type: 'quadrant', x: 'C', y: 'D', cx: 1, cy: 2, quadrant: 'UR', groupId: 'h' }),
    ];
    const { xml } = exportGatingMLDoc(w);
    const ids = [...xml.matchAll(/(?:gating|transforms):id="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    expect(xml).not.toContain('compensation-ref="c1"');
    expect(xml).toContain('compensation-ref="FCS"');
    expect(xml).toContain('compensation-ref="uncompensated"');
    const res = importGatingML(xml, { perGateComp: true });
    expect(res.populations.map((p) => p.name).sort()).toEqual(w.populations.map((p) => p.name).sort());
    expect(res.populations.find((p) => p.name === 'CD4+ CD8-')!.color).toBe('#123456');
    expect(res.populations.find((p) => p.name === 'Quad_CD4pos_CD8neg')!.gate.comp).toBe('none');
    expect(res.populations.find((p) => p.name === '1st cells')!.gate.comp).toBe('file');
  });

  it('skips the children of gates it cannot import', () => {
    const xml = `<gating:Gating-ML xmlns:gating="g" xmlns:data-type="d" xmlns:transforms="t">
<transforms:transformation transforms:id="H"><transforms:hyperlog transforms:T="1000" transforms:W="1" transforms:M="4.5" transforms:A="0"/></transforms:transformation>
<gating:RectangleGate gating:id="P"><gating:dimension gating:transformation-ref="H" gating:min="0.2" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension></gating:RectangleGate>
<gating:RectangleGate gating:id="C" gating:parent_id="P"><gating:dimension gating:min="100" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FSC-H"/></gating:dimension></gating:RectangleGate>
<gating:RectangleGate gating:id="GC" gating:parent_id="C"><gating:dimension gating:min="100" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FSC-H"/></gating:dimension></gating:RectangleGate>
<gating:RectangleGate gating:id="OK"><gating:dimension gating:min="100" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FSC-H"/></gating:dimension></gating:RectangleGate>
<gating:BooleanGate gating:id="B"><gating:and><gating:gateReference gating:ref="OK"/><gating:gateReference gating:ref="C"/></gating:and></gating:BooleanGate>
</gating:Gating-ML>`;
    const res = importGatingML(xml);
    expect(res.populations.map((p) => p.name)).toEqual(['OK']);
    expect(res.warnings.filter((w) => w.includes('skipped'))).toHaveLength(3);
  });
});

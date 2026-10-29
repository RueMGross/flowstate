// Log axes (cross-review 2026-10-29): a log axis spans min..max as set, also less than one decade (Gating-ML flog with
// M < 1 was stretched to one decade, moving imported gate boundaries); strict (imported Gating-ML) polygon and ellipse
// gates leave out events at or below 0 on a log axis, as other Gating-ML software does (the display puts them just
// below the axis, where a gate reaching below the axis caught them).
import { allIndices, applyGate, type GateContext } from '../src/core/gating';
import { importGatingML } from '../src/core/gatingml';
import type { GateGeom } from '../src/core/model';
import { makeScale, type ScaleDef } from '../src/core/transforms';

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;

function ctxOf(x: Float32Array, y: Float32Array, scale: ScaleDef): GateContext {
  return {
    raw: (ch) => (ch === 'X' ? x : ch === 'Y' ? y : null),
    display: (ch, d) => makeScale(d).fwdArray(ch === 'X' ? x : y),
    scaleOf: () => scale,
    population: () => new Uint32Array(0),
    eventCount: x.length,
  };
}

describe('log axis of less than one decade', () => {
  it('spans min..max as set', () => {
    const sc = makeScale({ type: 'log', min: 100, max: 500 });
    expect(sc.fwd(100)).toBeCloseTo(0, 12);
    expect(sc.fwd(500)).toBeCloseTo(1, 12);
    expect(sc.inv(1)).toBeCloseTo(500, 9);
  });

  it('a Gating-ML flog with M < 1 puts imported gate bounds where the transform says', () => {
    // flog(x) = log10(x / T) / M + 1: the transformed bound 0.5 is the raw value T * 10^(-M / 2)
    const xml = `<gating:Gating-ML ${NS}><transforms:transformation transforms:id="L"><transforms:flog transforms:T="500" transforms:M="0.5"/></transforms:transformation><gating:RectangleGate gating:id="G"><gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="L" gating:min="0.5"><data-type:fcs-dimension data-type:name="X"/></gating:dimension></gating:RectangleGate></gating:Gating-ML>`;
    const res = importGatingML(xml);
    const g = res.populations[0].gate as Extract<GateGeom, { type: 'range' }>;
    expect(g.type).toBe('range');
    expect(g.min).toBeCloseTo(500 * Math.pow(10, -0.25), 6);
  });
});

describe('strict gates on a log axis', () => {
  const scale: ScaleDef = { type: 'log', min: 1, max: 10000 };
  // events at or below 0, a tiny positive value (far below the axis) and one inside the axis
  const x = new Float32Array([-50, 0, 1e-6, 10]);
  const y = new Float32Array([100, 100, 100, 100]);
  // a polygon reaching below the axis (display -0.05): it covers -0.02, where values at or below 0 are drawn
  const sc = makeScale(scale);
  const pts: [number, number][] = [
    [sc.inv(-0.05), sc.inv(0.25)],
    [sc.inv(0.5), sc.inv(0.25)],
    [sc.inv(0.5), sc.inv(0.75)],
    [sc.inv(-0.05), sc.inv(0.75)],
  ];

  it('polygon: values at or below 0 are in no strict gate', () => {
    const g: GateGeom = { type: 'polygon', x: 'X', y: 'Y', points: pts, scales: { x: scale, y: scale }, strict: true };
    expect([...applyGate(g, allIndices(4), ctxOf(x, y, scale))]).toEqual([3]);
  });

  it('polygon drawn in the app (not strict): off-scale events still count on the axis edge', () => {
    const g: GateGeom = { type: 'polygon', x: 'X', y: 'Y', points: pts, scales: { x: scale, y: scale }, strict: false };
    expect([...applyGate(g, allIndices(4), ctxOf(x, y, scale))]).toEqual([0, 1, 2, 3]);
  });

  it('ellipse: values at or below 0 are in no strict gate', () => {
    const g: GateGeom = { type: 'ellipse', x: 'X', y: 'Y', center: [sc.inv(0), sc.inv(0.5)], a: [sc.inv(0.3), sc.inv(0.5)], b: [sc.inv(0), sc.inv(0.7)], scales: { x: scale, y: scale }, strict: true };
    expect([...applyGate(g, allIndices(4), ctxOf(x, y, scale))]).toEqual([3]);
  });

  it('a FlowJo log axis (clampLow) is not affected: values at or below min sit on the axis', () => {
    const fj: ScaleDef = { type: 'log', min: 1, max: 10000, clampLow: true };
    const s = makeScale(fj);
    // an ellipse centred on the axis (display 0) holds the events on it
    const g: GateGeom = { type: 'ellipse', x: 'X', y: 'Y', center: [s.inv(0), s.inv(0.5)], a: [s.inv(0.3), s.inv(0.5)], b: [s.inv(0), s.inv(0.7)], scales: { x: fj, y: fj }, strict: true };
    expect([...applyGate(g, allIndices(4), ctxOf(x, y, fj))]).toEqual([0, 1, 2, 3]);
  });
});

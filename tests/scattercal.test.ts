import { mieSphere, riWater, sizeParameter, wavenumber } from '../src/core/mie';
import {
  EV_MODEL,
  EXAMPLE_CYTOFLEX_VSSC,
  apertureCrossSection,
  apertureCrossSections,
  apertureQuadrature,
  buildSizeCurve,
  logSlopes,
  sizeResolution,
  sizeUncertaintyPct,
  diameterToScatter,
  fitCollectionAngle,
  gaussLegendre,
  scatterToCrossSection,
  scatterToDiameter,
  totalCrossSection,
  type CollectionGeometry,
  type Particle,
  type ScatterBead,
} from '../src/core/scattercal';
import { getBeadKit, kitScatterBeads } from '../src/core/beads';

const LAM = 405;
const NMED = riWater(405);
const ps = (d: number): Particle => ({ kind: 'sphere', ri: { material: 'polystyrene' }, diameterNm: d });
const ev = (d: number): Particle => ({ ...EV_MODEL, diameterNm: d });

/** Independent check: 2D Gauss–Legendre over the cone cap in its own polar coordinates (α, β). */
function bruteCone(diameterNm: number, g: CollectionGeometry, n = 200): number {
  const m = { re: 1.6267806 / NMED, im: 0 }; // fixed RI so the check does not depend on the dispersion helper
  const x = sizeParameter(diameterNm, LAM, NMED);
  const d2r = Math.PI / 180;
  const th0 = g.thetaDeg * d2r, ph0 = g.phiDeg * d2r, eps = g.halfAngleDeg * d2r;
  const ax = [Math.sin(th0) * Math.cos(ph0), Math.sin(th0) * Math.sin(ph0), Math.cos(th0)];
  let u = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const dot = u[0] * ax[0] + u[1] * ax[1] + u[2] * ax[2];
  u = u.map((c, i) => c - dot * ax[i]);
  const nu = Math.hypot(...u);
  u = u.map((c) => c / nu);
  const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
  const gl = gaussLegendre(n);
  const thetas: number[] = [];
  const w: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const al = (eps * (gl.x[i] + 1)) / 2;
    for (let j = 0; j < n; j++) {
      const be = Math.PI * (gl.x[j] + 1);
      const d = [0, 1, 2].map((c) => Math.cos(al) * ax[c] + Math.sin(al) * (Math.cos(be) * u[c] + Math.sin(be) * v[c]));
      thetas.push(Math.acos(Math.max(-1, Math.min(1, d[2]))));
      const ph = Math.atan2(d[1], d[0]);
      const ww = (eps / 2) * gl.w[i] * Math.PI * gl.w[j] * Math.sin(al);
      w.push(g.polarization === 'unpolarized' ? [ww / 2, ww / 2] : [ww * Math.sin(ph) ** 2, ww * Math.cos(ph) ** 2]);
    }
  }
  const r = mieSphere(m, x, thetas);
  let s = 0;
  for (let k = 0; k < thetas.length; k++) s += w[k][0] * (r.S1re[k] ** 2 + r.S1im[k] ** 2) + w[k][1] * (r.S2re[k] ** 2 + r.S2im[k] ** 2);
  return s / wavenumber(LAM, NMED) ** 2;
}

describe('aperture integration', () => {
  it('full sphere equals the total scattering cross section', () => {
    for (const p of [ps(50), ps(600), ps(3000), ev(150), ev(1200)]) {
      const c = totalCrossSection(p, LAM, NMED);
      expect(Math.abs(apertureCrossSection(p, { thetaDeg: 0, phiDeg: 0, halfAngleDeg: 180 }, LAM, NMED) / c - 1)).toBeLessThan(1e-9);
      expect(Math.abs(apertureCrossSection(p, { thetaDeg: 90, phiDeg: 33, halfAngleDeg: 180 }, LAM, NMED) / c - 1)).toBeLessThan(1e-9);
      expect(Math.abs(apertureCrossSection(p, { thetaDeg: 90, phiDeg: 33, halfAngleDeg: 180, polarization: 'unpolarized' }, LAM, NMED) / c - 1)).toBeLessThan(1e-9);
    }
  });
  it('quadrature weights integrate the solid angle of the cone', () => {
    for (const [th, e] of [[90, 53.2], [0, 15], [30, 60], [170, 25]]) {
      const q = apertureQuadrature({ thetaDeg: th, phiDeg: 90, halfAngleDeg: e }, 40);
      expect(q.solidAngle).toBeCloseTo(2 * Math.PI * (1 - Math.cos((e * Math.PI) / 180)), 10);
    }
  });
  it('matches a brute-force 2D integration over the cone cap (<1e-6)', () => {
    const geoms: CollectionGeometry[] = [
      { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2 },
      { thetaDeg: 90, phiDeg: 0, halfAngleDeg: 30 },
      { thetaDeg: 70, phiDeg: 45, halfAngleDeg: 80 },
      { thetaDeg: 20, phiDeg: 30, halfAngleDeg: 35 }, // cone containing the forward direction
      { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2, polarization: 'unpolarized' },
    ];
    for (const g of geoms) {
      for (const d of [100, 1020]) {
        const p: Particle = { kind: 'sphere', ri: 1.6267806, diameterNm: d };
        const a = apertureCrossSection(p, g, LAM, NMED);
        expect(Math.abs(a / bruteCone(d, g) - 1)).toBeLessThan(1e-6);
      }
    }
  });
  it('unpolarized = mean of two orthogonal linear polarizations; obscuration = difference of cones', () => {
    const p = ps(450);
    const g = { thetaDeg: 90, phiDeg: 20, halfAngleDeg: 40 };
    const a = apertureCrossSection(p, g, LAM, NMED);
    const b = apertureCrossSection(p, { ...g, phiDeg: 110 }, LAM, NMED);
    const u = apertureCrossSection(p, { ...g, polarization: 'unpolarized' }, LAM, NMED);
    expect(Math.abs(u / ((a + b) / 2) - 1)).toBeLessThan(1e-10);
    const inner = apertureCrossSection(p, { ...g, halfAngleDeg: 10 }, LAM, NMED);
    const ann = apertureCrossSection(p, { ...g, obscurationHalfAngleDeg: 10 }, LAM, NMED);
    expect(Math.abs(ann / (a - inner) - 1)).toBeLessThan(1e-10);
  });
  it('side scatter at phi = 90° exceeds phi = 0° for Rayleigh particles (dipole pattern)', () => {
    const s90 = apertureCrossSection(ps(50), { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 20 }, LAM, NMED);
    const s0 = apertureCrossSection(ps(50), { thetaDeg: 90, phiDeg: 0, halfAngleDeg: 20 }, LAM, NMED);
    expect(s90 / s0).toBeGreaterThan(5);
  });
});

describe('collection-angle fit (synthetic nanoViS calibration)', () => {
  const sizes = [40, 80, 108, 142, 304, 600, 1020];
  const beads: ScatterBead[] = sizes.map((d) => ({ diameterNm: d, ri: { material: 'polystyrene' } }));
  const { wavelengthNm, nMedium, geometry, nm2PerAu } = EXAMPLE_CYTOFLEX_VSSC;
  const F = 1 / nm2PerAu;
  const sig = beads.map((b) => apertureCrossSection({ kind: 'sphere', ri: b.ri, diameterNm: b.diameterNm }, geometry, wavelengthNm, nMedium));
  let seed = 20251215;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

  it('noise-free data are reproduced exactly', () => {
    const fit = fitCollectionAngle(beads, sig.map((s) => F * s), { wavelengthNm, nMedium });
    expect(fit.halfAngleDeg).toBeCloseTo(53.2, 6);
    expect(fit.nm2PerAu / nm2PerAu).toBeCloseTo(1, 6);
    expect(fit.r2Log).toBeGreaterThan(0.999999);
    for (const b of fit.beads) expect(Math.abs(b.sizeErrorPct)).toBeLessThan(0.01);
  });

  for (const method of ['cv', 'lsq'] as const) {
    it(`3% noise, method ${method}: angle within 2°, bead sizes within 3%`, () => {
      for (let trial = 0; trial < 3; trial++) {
        const meas = sig.map((s) => F * s * (1 + 0.03 * gauss()));
        const t0 = performance.now();
        const fit = fitCollectionAngle(beads, meas, { wavelengthNm, nMedium, method });
        expect(performance.now() - t0).toBeLessThan(3000);
        expect(Math.abs(fit.halfAngleDeg - 53.2)).toBeLessThan(2);
        expect(Math.abs(fit.nm2PerAu / nm2PerAu - 1)).toBeLessThan(0.12);
        expect(fit.r2Log).toBeGreaterThan(0.999);
        expect(fit.sweep.halfAngleDeg.length).toBe(900);
        for (const b of fit.beads) {
          expect(Math.abs(b.residualPct)).toBeLessThan(10);
          expect(Math.abs(b.sizeErrorPct)).toBeLessThan(3);
        }
      }
    });
  }

  it('known geometry: a single bead fixes the factor', () => {
    const fit = fitCollectionAngle([beads[5]], [F * sig[5]], { wavelengthNm, nMedium, fixedHalfAngleDeg: 53.2 });
    expect(fit.method).toBe('fixed');
    expect(fit.nm2PerAu / nm2PerAu).toBeCloseTo(1, 9);
  });

  it('ignores missing values and works with kit presets', () => {
    const kit = getBeadKit('beckman-nanovis-high')!;
    const kb = kitScatterBeads(kit);
    const meas = kb.map((b) => F * apertureCrossSection({ kind: 'sphere', ri: b.ri, diameterNm: b.diameterNm }, geometry, wavelengthNm, nMedium));
    const fit = fitCollectionAngle([...kb, { diameterNm: 80, ri: { material: 'polystyrene' } }], [...meas, NaN], { wavelengthNm, nMedium });
    expect(fit.beads[4].used).toBe(false);
    expect(fit.halfAngleDeg).toBeCloseTo(53.2, 6);
  });
});

describe('scatter-diameter curve', () => {
  const setup = { wavelengthNm: 405, nMedium: EXAMPLE_CYTOFLEX_VSSC.nMedium, geometry: EXAMPLE_CYTOFLEX_VSSC.geometry };

  it('builds a 1481-point EV curve with aperture integration well under 1 s, cached', () => {
    const t0 = performance.now();
    const c = buildSizeCurve(EV_MODEL, setup, { minNm: 20, maxNm: 1500, stepNm: 1 });
    const ms = performance.now() - t0;
    expect(c.diametersNm.length).toBe(1481);
    expect(ms).toBeLessThan(1000);
    const t1 = performance.now();
    expect(buildSizeCurve(EV_MODEL, setup, { minNm: 20, maxNm: 1500, stepNm: 1 })).toBe(c);
    expect(performance.now() - t1).toBeLessThan(5);
  });

  it('round-trips diameters through a.u. (PCHIP in log-log) and flags out-of-range values', () => {
    const c = buildSizeCurve(EV_MODEL, setup);
    const ds = [25, 50, 75, 100, 150, 237, 300];
    const sig = apertureCrossSections(EV_MODEL, ds, setup);
    const au = Float32Array.from(sig, (s) => s / EXAMPLE_CYTOFLEX_VSSC.nm2PerAu);
    const back = scatterToDiameter(c, au, { nm2PerAu: EXAMPLE_CYTOFLEX_VSSC.nm2PerAu });
    for (let i = 0; i < ds.length; i++) expect(Math.abs(back[i] / ds[i] - 1)).toBeLessThan(1e-3);
    // Updated with the QC fix of the size range: σ(d) of EV at 405 nm still rises over its flat part (~350 to 420 nm),
    // so the default curve sizes 400 and 800 nm too (they used to be NaN); only the legacy option of calibrations saved
    // before (endAtLowSlope) still ends the range at the flat part
    const c0 = buildSizeCurve(EV_MODEL, setup, { minLogSlope: 0 });
    const far = apertureCrossSections(EV_MODEL, [400, 800], setup);
    for (const cc of [c, c0]) {
      const back0 = scatterToDiameter(cc, Float64Array.from(far));
      expect(Math.abs(back0[0] / 400 - 1)).toBeLessThan(1e-3);
      expect(Math.abs(back0[1] / 800 - 1)).toBeLessThan(1e-3);
    }
    const legacy = buildSizeCurve(EV_MODEL, setup, { endAtLowSlope: true });
    expect(Array.from(scatterToDiameter(legacy, Float64Array.from(far))).every(Number.isNaN)).toBe(true);
    // calibrated channel in nm², then diameter
    const nm2 = scatterToCrossSection(au, EXAMPLE_CYTOFLEX_VSSC.nm2PerAu);
    expect(Math.abs(nm2[3] / sig[3] - 1)).toBeLessThan(1e-6);
    const out = scatterToDiameter(c, Float32Array.from([c.validSigmaNm2[0] * 0.5, c.validSigmaNm2[1] * 2, 0, -1, NaN]));
    expect(Array.from(out).every((v) => Number.isNaN(v))).toBe(true);
    expect(diameterToScatter(c, 237)).toBeCloseTo(sig[5], 0);
  });

  it('stops the invertible range at the first Mie maximum (narrow aperture)', () => {
    const c = buildSizeCurve({ kind: 'sphere', ri: { material: 'polystyrene' } }, { ...setup, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 10 } }, { minNm: 20, maxNm: 1500, stepNm: 2, minLogSlope: 0 });
    expect(c.endsAtMaximum).toBe(true);
    // Updated with the QC fix of the size range: the default threshold no longer ends the range where the curve
    // flattens towards that maximum (it reports that stretch as low resolution); the legacy option still does
    const cd = buildSizeCurve({ kind: 'sphere', ri: { material: 'polystyrene' } }, { ...setup, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 10 } }, { minNm: 20, maxNm: 1500, stepNm: 2 });
    expect(cd.endsAtMaximum).toBe(true);
    expect(cd.validRangeNm).toEqual(c.validRangeNm);
    expect(cd.lowResolutionNm.length).toBeGreaterThan(0);
    expect(cd.lowResolutionNm[cd.lowResolutionNm.length - 1][1]).toBe(cd.validRangeNm[1]);
    // signals just below the maximum also fit particles beyond it
    expect(cd.ambiguousNm).not.toBeNull();
    expect(cd.ambiguousNm![1]).toBe(cd.validRangeNm[1]);
    const cf = buildSizeCurve({ kind: 'sphere', ri: { material: 'polystyrene' } }, { ...setup, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 10 } }, { minNm: 20, maxNm: 1500, stepNm: 2, endAtLowSlope: true });
    expect(cf.endsAtFlat).toBe(true);
    expect(cf.validRangeNm[1]).toBeLessThan(c.validRangeNm[1]);
    expect(c.validRangeNm[1]).toBeLessThan(1500);
    for (let i = 1; i < c.lnSigma.length; i++) expect(c.lnSigma[i]).toBeGreaterThan(c.lnSigma[i - 1]);
    // a user range on a later monotonic branch
    const c2 = buildSizeCurve({ kind: 'sphere', ri: { material: 'polystyrene' } }, { ...setup, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 10 } }, { minNm: 20, maxNm: 1500, stepNm: 2, rangeNm: [20, 200] });
    expect(c2.validRangeNm[1]).toBeLessThanOrEqual(200);
  });
});

// Updated with the QC fix of the size range: ending the valid range at the first low-slope stretch is now only the
// legacy behaviour of calibrations saved before (endAtLowSlope); the default keeps such stretches while σ(d) rises
// (see tests/qc_fix_calib.test.ts)
describe('legacy: valid range ends where the curve turns flat', () => {
  const setup = { wavelengthNm: 405, nMedium: EXAMPLE_CYTOFLEX_VSSC.nMedium, geometry: EXAMPLE_CYTOFLEX_VSSC.geometry };
  const L = { endAtLowSlope: true };

  it('EV at 405 nm: ends before the plateau near 350 to 430 nm (log-log slope 0.5), reports the size resolution', () => {
    const c = buildSizeCurve(EV_MODEL, setup, L);
    expect(c.endsAtFlat).toBe(true);
    expect(c.minLogSlope).toBe(0.5);
    expect(c.validRangeNm[1]).toBeGreaterThan(320);
    expect(c.validRangeNm[1]).toBeLessThan(360);
    // the local slope at the end of the range is at the threshold, inside it is steeper
    const iEnd = c.validRangeNm[1] - 20;
    expect(c.logSlope[iEnd]).toBeGreaterThanOrEqual(0.5);
    expect(c.logSlope[iEnd + 1]).toBeLessThan(0.5);
    // size resolution: Rayleigh-like regime (slope ~ 6) vs near the end of the range (~2 % size per % scatter)
    expect(sizeResolution(c, 60)).toBeLessThan(0.25);
    expect(sizeResolution(c, c.validRangeNm[1])).toBeGreaterThan(1.5);
    expect(sizeResolution(c, c.validRangeNm[1])).toBeLessThan(2.1);
    expect(sizeUncertaintyPct(c, 100, 5)).toBeCloseTo(5 * sizeResolution(c, 100), 10);
    expect(Number.isNaN(sizeResolution(c, 5000))).toBe(true);
  });

  it('a configurable threshold, and a range that starts on the plateau moves to the next steep part', () => {
    const strict = buildSizeCurve(EV_MODEL, setup, { minLogSlope: 1, ...L });
    const loose = buildSizeCurve(EV_MODEL, setup, { minLogSlope: 0.2, ...L });
    expect(strict.validRangeNm[1]).toBeLessThan(buildSizeCurve(EV_MODEL, setup, L).validRangeNm[1]);
    expect(loose.validRangeNm[1]).toBeGreaterThan(buildSizeCurve(EV_MODEL, setup, L).validRangeNm[1]);
    const late = buildSizeCurve(EV_MODEL, setup, { rangeNm: [380, 1500], ...L });
    expect(late.validRangeNm[0]).toBeGreaterThan(400);
    expect(late.logSlope[late.validRangeNm[0] - 20]).toBeGreaterThanOrEqual(0.5);
    expect(() => buildSizeCurve(EV_MODEL, setup, { rangeNm: [370, 400], ...L })).toThrow(/no usable range/);
    // default: the threshold only marks low-resolution bands; a range on the rising plateau is usable as it is
    expect(buildSizeCurve(EV_MODEL, setup, { minLogSlope: 1 }).validRangeNm[1]).toBe(1500);
    expect(buildSizeCurve(EV_MODEL, setup, { rangeNm: [380, 1500] }).validRangeNm).toEqual([380, 1500]);
    expect(buildSizeCurve(EV_MODEL, setup, { rangeNm: [370, 400] }).validRangeNm).toEqual([370, 400]);
  });

  it('logSlopes of a power law is its exponent', () => {
    const ds = Float64Array.from({ length: 200 }, (_, i) => 20 + i * 5);
    const sl = logSlopes(ds, Float64Array.from(ds, (d) => 3 * Math.pow(d, 2.5)));
    for (const v of sl) expect(v).toBeCloseTo(2.5, 6);
  });
});


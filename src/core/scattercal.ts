// Light-scatter calibration for nanoparticles / extracellular vesicles (Mie model as in FCMPASS; Welsh et al., Cytometry A 2020,
// doi:10.1002/cyto.a.23782). Pure computation, no UI. Lengths in nm, cross sections in nm², angles in degrees in the
// public API.
//
// Model: the detector collects the differential scattering cross section integrated over a circular aperture (cone of
// half-angle ε) whose axis points at polar angle θ from the beam and azimuth φ from the incident polarization (E-field):
//   σ_coll = ∫_cone dC/dΩ dΩ,   dC/dΩ = (|S1|² sin²φ + |S2|² cos²φ)/k²  (linear polarization; unpolarized: average).
// The azimuthal integral over each cone cross-section is done analytically, the remaining polar integral with
// Gauss–Legendre quadrature on segments whose ends are mapped with θ = a + (b−a)(1−cos t)/2 (removes the square-root
// behaviour of the arc length at the cone edges), so no angular interpolation of S1/S2 is needed.
//
// Calibration: measured median scatter (a.u.) of reference beads = F · σ_coll(bead). FCMPASS sweeps ε 0..90° in 0.1°
// steps and picks the ε with the lowest CV of the ratios measured/predicted, F = mean ratio. FCMPASS reports the
// inverse as "Cali. Factor (nm^2)" (e.g. CytoFLEX VSSC 0.00365 nm² per a.u.): σ[nm²] = a.u. × nm2PerAu.
import {
  type MieCoefficients,
  type RISpec,
  type Complex,
  angularFunctions,
  amplitudeFromTables,
  mieCoatedCoefficients,
  mieCoefficients,
  mieEfficiencies,
  mieTerms,
  resolveRI,
  sizeParameter,
  wavenumber,
} from './mie';

export type { RISpec } from './mie';

// ------------------------------------------------------------------ types

export interface CollectionGeometry {
  /** polar angle (deg) of the detector axis from the beam propagation direction (90 = side scatter, 0 = forward) */
  thetaDeg: number;
  /**
   * azimuth (deg) of the detector axis measured from the incident E-field (polarization) direction.
   * 90 (default for SSC, as in FCMPASS reports): the scattering plane through the detector axis is perpendicular to
   * the polarization, i.e. the detector sits where a dipole radiates most and |S1|² dominates.
   */
  phiDeg: number;
  /** collection half-angle ε (deg) of the circular aperture, as seen from the particle in the sheath medium */
  halfAngleDeg: number;
  /**
   * optional central obscuration half-angle (deg): light within this cone around the detector axis is blocked
   * (annular aperture; a circular stand-in for an FSC obscuration bar)
   */
  obscurationHalfAngleDeg?: number;
  /** incident polarization; default 'linear' (FCMPASS models a linearly polarized plane wave) */
  polarization?: 'linear' | 'unpolarized';
}

/** Optical setup of one scatter detector. */
export interface ScatterSetup {
  /** laser vacuum wavelength (nm) */
  wavelengthNm: number;
  /** refractive index of the sheath / suspension medium at that wavelength (e.g. riWater(405) = 1.34309) */
  nMedium: number;
  geometry: CollectionGeometry;
}

export interface SphereModel {
  kind: 'sphere';
  ri: RISpec;
  name?: string;
}

/** Core–shell sphere (e.g. EV: aqueous core + lipid membrane). The outer diameter includes the shell. */
export interface CoreShellModel {
  kind: 'coreShell';
  core: RISpec;
  shell: RISpec;
  /** shell thickness (nm) */
  shellNm: number;
  name?: string;
}

export type ParticleModel = SphereModel | CoreShellModel;

/** A particle = model + outer diameter (nm). */
export type Particle = ParticleModel & { diameterNm: number };

/** Reference bead for the collection-angle fit. */
export interface ScatterBead {
  /** (certificate) mean diameter, nm */
  diameterNm: number;
  /** refractive index (absolute), e.g. { material: 'polystyrene' } or { material: 'silica', n: 1.43, atNm: 589 } */
  ri: RISpec;
  /** diameter CV (%), informational (the median of a monotonic signal equals the signal of the median diameter) */
  cvPct?: number;
  label?: string;
}

/**
 * EV core-shell model with FCMPASS's average RIs (core 1.38, shell 1.48, 5 nm shell) taken as they are at the laser
 * wavelength. FCMPASS itself states them at 488 nm and shifts them with the dispersion of water (see evModelFcmpass).
 */
export const EV_MODEL: CoreShellModel = { kind: 'coreShell', core: 1.38, shell: 1.48, shellNm: 5, name: 'EV (core 1.38 / shell 1.48, 5 nm)' };

/** FCMPASS's three EV models: core RI 1.36 (low), 1.38 (average), 1.40 (high); shell 1.48, 5 nm. */
export const FCMPASS_EV_CORES = { low: 1.36, average: 1.38, high: 1.4 } as const;

/**
 * An FCMPASS EV model: core and shell RIs at 488 nm, shifted with the dispersion of water to the laser wavelength
 * (at 405 nm: core 1.3857 and shell 1.4857 for the average model). Checked against the EV diameter columns
 * ("EV Diameter (nm) [Low / Average / High RI]") of FCMPASS 5.0.8 exports of CytoFLEX violet SSC data: at the same
 * calibration the diameters agree within 1.5 % (median 0.3 to 0.8 %); the RIs taken undispersed at 405 nm give about
 * 10 % (average) to 40 % (low RI) other diameters.
 */
export function evModelFcmpass(level: keyof typeof FCMPASS_EV_CORES = 'average'): CoreShellModel {
  const core = FCMPASS_EV_CORES[level];
  return {
    kind: 'coreShell',
    core: { material: 'water', n: core, atNm: 488 },
    shell: { material: 'water', n: 1.48, atNm: 488 },
    shellNm: 5,
    name: `EV ${level === 'average' ? '' : level + ' RI '}(core ${core} / shell 1.48 at 488 nm, 5 nm)`,
  };
}

/**
 * Example from the FCMPASS documentation ("Known Scatter Angle"): CytoFLEX VSSC, 405 nm, sheath 1.343091653,
 * θ = 90°, φ = 90°, ε = 53.2°, Cali. Factor 0.003651666 nm²/a.u. Instrument- and gain-specific: an example only.
 */
export const EXAMPLE_CYTOFLEX_VSSC: ScatterSetup & { nm2PerAu: number } = {
  wavelengthNm: 405,
  nMedium: 1.343091653,
  geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2 },
  nm2PerAu: 0.003651666,
};

// ------------------------------------------------------------------ Gauss–Legendre

const glCache = new Map<number, { x: Float64Array; w: Float64Array }>();

/** Gauss–Legendre nodes/weights on [-1, 1]. */
export function gaussLegendre(n: number): { x: Float64Array; w: Float64Array } {
  const c = glCache.get(n);
  if (c) return c;
  const x = new Float64Array(n);
  const w = new Float64Array(n);
  const m = (n + 1) >> 1;
  for (let i = 0; i < m; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let pp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1;
      let p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      pp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x[i] = -z;
    x[n - 1 - i] = z;
    w[i] = w[n - 1 - i] = 2 / ((1 - z * z) * pp * pp);
  }
  const r = { x, w };
  glCache.set(n, r);
  return r;
}

// ------------------------------------------------------------------ aperture quadrature

/**
 * Quadrature for the aperture integral: σ_coll = (1/k²) Σ_j (wPerp_j |S1(θ_j)|² + wPar_j |S2(θ_j)|²).
 * Weights are in steradians (they include sin θ dθ and the azimuthal arc integrals).
 */
export interface ApertureQuadrature {
  theta: Float64Array;
  wPerp: Float64Array;
  wPar: Float64Array;
  /** solid angle of the aperture (sr) */
  solidAngle: number;
  /** highest multipole order the node density was chosen for */
  nMax: number;
}

const D2R = Math.PI / 180;

/** Half-width Δ(θ) of the azimuth arc (around φ0) of the circle at polar angle θ lying inside a cone (θ0, ε). */
function arcHalfWidth(theta: number, theta0: number, eps: number): number {
  const s = Math.sin(theta) * Math.sin(theta0);
  const cosEps = Math.cos(eps);
  const cc = Math.cos(theta) * Math.cos(theta0);
  if (Math.abs(s) < 1e-14) return cc >= cosEps ? Math.PI : 0;
  const c = (cosEps - cc) / s;
  if (c <= -1) return Math.PI;
  if (c >= 1) return 0;
  return Math.acos(c);
}

function coneNodes(theta0: number, phi0: number, eps: number, nMax: number, linear: boolean, sign: number, out: { t: number[]; a: number[]; b: number[] }) {
  if (!(eps > 0)) return;
  const brk = [0, Math.PI, theta0 - eps, eps - theta0, theta0 + eps, 2 * Math.PI - theta0 - eps]
    .filter((v) => v >= 0 && v <= Math.PI)
    .sort((p, q) => p - q);
  const cos2phi = Math.cos(2 * phi0);
  for (let s = 0; s + 1 < brk.length; s++) {
    const a = brk[s];
    const b = brk[s + 1];
    if (b - a < 1e-12) continue;
    if (arcHalfWidth((a + b) / 2, theta0, eps) <= 0) continue;
    // node count: |S|² has angular frequencies up to ~2·nMax; the (1 - cos t) map stretches the middle by π/2
    const n = Math.min(800, Math.max(24, Math.ceil(0.85 * nMax * (b - a)) + 24));
    const gl = gaussLegendre(n);
    for (let i = 0; i < n; i++) {
      const t = (Math.PI * (gl.x[i] + 1)) / 2; // t in (0, π)
      const th = a + ((b - a) * (1 - Math.cos(t))) / 2;
      const jac = ((b - a) * Math.sin(t)) / 2 * (Math.PI / 2) * gl.w[i];
      const d = arcHalfWidth(th, theta0, eps);
      if (d <= 0) continue;
      const base = jac * Math.sin(th) * sign;
      let A: number;
      let B: number;
      if (linear) {
        // ∫ sin²φ dφ and ∫ cos²φ dφ over φ0 ± Δ (factor 2Δ split by polarization)
        const h = (Math.sin(2 * d) * cos2phi) / 2;
        A = d - h;
        B = d + h;
      } else {
        A = d;
        B = d;
      }
      out.t.push(th);
      out.a.push(base * A);
      out.b.push(base * B);
    }
  }
}

const quadCache = new Map<string, ApertureQuadrature>();

/**
 * Build (and cache) the aperture quadrature for a geometry, with node density sufficient for multipole orders up to
 * `nMax` (use mieTerms(x) of the largest particle).
 */
export function apertureQuadrature(geometry: CollectionGeometry, nMax: number): ApertureQuadrature {
  // round nMax up to a multiple of 8 to share cache entries
  const nm = Math.max(8, Math.ceil(nMax / 8) * 8);
  const key = `${geometry.thetaDeg}|${geometry.phiDeg}|${geometry.halfAngleDeg}|${geometry.obscurationHalfAngleDeg ?? 0}|${geometry.polarization ?? 'linear'}|${nm}`;
  const c = quadCache.get(key);
  if (c) return c;
  const q = buildQuadratureUncached(geometry, nm);
  if (quadCache.size > 64) quadCache.clear();
  quadCache.set(key, q);
  return q;
}

// angular-function tables per quadrature (weakly cached)
const tableCache = new WeakMap<ApertureQuadrature, { pi: Float64Array; tau: Float64Array; nMax: number }>();

function tablesFor(q: ApertureQuadrature, nTerms: number) {
  let t = tableCache.get(q);
  if (!t || t.nMax < nTerms) {
    t = angularFunctions(q.theta, Math.max(nTerms, q.nMax));
    tableCache.set(q, t);
  }
  return t;
}

/** Collected cross section (nm²) for given coefficients, quadrature and wavenumber k (1/nm). */
export function collectedCrossSection(coef: MieCoefficients, q: ApertureQuadrature, k: number): number {
  if (!q.theta.length) return 0;
  const amp = amplitudeFromTables(coef, tablesFor(q, coef.nTerms));
  let s = 0;
  for (let j = 0; j < q.theta.length; j++) {
    s += q.wPerp[j] * (amp.S1re[j] * amp.S1re[j] + amp.S1im[j] * amp.S1im[j]) + q.wPar[j] * (amp.S2re[j] * amp.S2re[j] + amp.S2im[j] * amp.S2im[j]);
  }
  return s / (k * k);
}

// ------------------------------------------------------------------ particles

const relIndex = (n: Complex, nMedium: number): Complex => ({ re: n.re / nMedium, im: n.im / nMedium });

/** Mie coefficients of a particle (diameter in nm) in a medium at a vacuum wavelength. */
export function particleCoefficients(p: Particle, wavelengthNm: number, nMedium: number): { coef: MieCoefficients; x: number } {
  const x = sizeParameter(p.diameterNm, wavelengthNm, nMedium);
  if (p.kind === 'sphere') return { coef: mieCoefficients(relIndex(resolveRI(p.ri, wavelengthNm), nMedium), x), x };
  const shell = relIndex(resolveRI(p.shell, wavelengthNm), nMedium);
  const dCore = p.diameterNm - 2 * p.shellNm;
  if (!(dCore > 0)) return { coef: mieCoefficients(shell, x), x };
  const core = relIndex(resolveRI(p.core, wavelengthNm), nMedium);
  return { coef: mieCoatedCoefficients(core, shell, sizeParameter(dCore, wavelengthNm, nMedium), x), x };
}

/** Total scattering cross section Csca (nm²) of a particle (all angles). */
export function totalCrossSection(p: Particle, wavelengthNm: number, nMedium: number): number {
  const { coef, x } = particleCoefficients(p, wavelengthNm, nMedium);
  const r = p.diameterNm / 2;
  return mieEfficiencies(coef, x).qsca * Math.PI * r * r;
}

/**
 * Scattering cross section (nm²) collected by the aperture `geometry` for one particle.
 * @param particle particle model with outer diameter (nm)
 * @param wavelengthNm laser vacuum wavelength (nm)
 * @param nMedium sheath / medium refractive index
 */
export function apertureCrossSection(particle: Particle, geometry: CollectionGeometry, wavelengthNm: number, nMedium: number): number {
  const { coef } = particleCoefficients(particle, wavelengthNm, nMedium);
  const q = apertureQuadrature(geometry, coef.nTerms);
  return collectedCrossSection(coef, q, wavenumber(wavelengthNm, nMedium));
}

/** Collected cross sections (nm²) of one particle model at many diameters (shared quadrature). */
export function apertureCrossSections(model: ParticleModel, diametersNm: ArrayLike<number>, setup: ScatterSetup): Float64Array {
  const { wavelengthNm, nMedium, geometry } = setup;
  let dMax = 0;
  for (let i = 0; i < diametersNm.length; i++) dMax = Math.max(dMax, diametersNm[i]);
  const q = apertureQuadrature(geometry, mieTerms(sizeParameter(dMax, wavelengthNm, nMedium)));
  const k = wavenumber(wavelengthNm, nMedium);
  const out = new Float64Array(diametersNm.length);
  for (let i = 0; i < diametersNm.length; i++) {
    const d = diametersNm[i];
    if (!(d > 0)) {
      out[i] = d === 0 ? 0 : NaN;
      continue;
    }
    out[i] = collectedCrossSection(particleCoefficients({ ...model, diameterNm: d } as Particle, wavelengthNm, nMedium).coef, q, k);
  }
  return out;
}

// ------------------------------------------------------------------ detector saturation

/**
 * Pile-up at the top of a channel: many events at (within 1 % of) its largest value, or at its $PnR, as when a detector
 * saturates below $PnR (e.g. the SSC-H of a CytoFLEX nano near 5.65e6 with $PnR 16.7e6). Pile-up means more events in
 * the top 1 % of the scale than in the 4 % below it (a smooth tail has fewer) and at least max(20, 0.05 %) of the events.
 * Returns the level from which values count as saturated, or null.
 */
export function detectPileUp(values: ArrayLike<number>, range?: number): { level: number; count: number } | null {
  let mx = -Infinity;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v && v !== Infinity) {
      n++;
      if (v > mx) mx = v;
    }
  }
  if (!n || !(mx > 0)) return null;
  const top = range && range > 0 && mx >= 0.999 * range ? Math.min(mx, range) : mx;
  const level = 0.99 * top;
  const below = 0.95 * top;
  let count = 0;
  let under = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v >= level) count++;
    else if (v >= below) under++;
  }
  return count >= Math.max(20, 0.0005 * n) && count > under ? { level, count } : null;
}

/**
 * How well the beads constrain the half-angle: the best value at the edge of the swept range, or a flat criterion
 * (a third or more of the swept angles within 10 % of the best score; e.g. beads all in the Rayleigh range).
 */
export function sweepConstraint(fit: Pick<CollectionFit, 'method' | 'sweep' | 'halfAngleDeg'>): { atEdge: boolean; flat: boolean } {
  const x = fit.sweep.halfAngleDeg;
  if (fit.method === 'fixed' || !x.length) return { atEdge: false, flat: false };
  const y = fit.method === 'lsq' ? fit.sweep.rmsLog : fit.sweep.cvPct;
  const atEdge = fit.halfAngleDeg <= x[0] + 1e-9 || fit.halfAngleDeg >= x[x.length - 1] - 1e-9;
  let best = Infinity;
  for (const v of y) if (v < best) best = v;
  let near = 0;
  let valid = 0;
  for (const v of y) {
    if (!Number.isFinite(v)) continue;
    valid++;
    if (v <= best * 1.1 + 1e-12) near++;
  }
  return { atEdge, flat: valid > 0 && near / valid >= 1 / 3 };
}

// ------------------------------------------------------------------ collection-angle fit

export interface FitCollectionOptions {
  /** laser vacuum wavelength (nm) */
  wavelengthNm: number;
  /** sheath refractive index at that wavelength */
  nMedium: number;
  /** detector axis polar angle (deg), default 90 (side scatter) */
  thetaDeg?: number;
  /** detector axis azimuth from the polarization (deg), default 90 */
  phiDeg?: number;
  polarization?: 'linear' | 'unpolarized';
  obscurationHalfAngleDeg?: number;
  /**
   * 'cv' (FCMPASS 2020): per half-angle, F = mean(measured/predicted); pick the half-angle with the lowest CV of the
   * ratios. 'lsq' (Rosetta / de Rond): log10(I) = log10(F·σ) least squares; pick the lowest RMS log residual.
   */
  method?: 'cv' | 'lsq';
  /** swept half-angle range (deg), default [0.1, 90] */
  halfAngleRangeDeg?: [number, number];
  /** sweep step (deg), default 0.1 */
  stepDeg?: number;
  /** use this half-angle instead of fitting (known geometry; one bead is then enough) */
  fixedHalfAngleDeg?: number;
  /** compute per-bead sizing (diameter at which the bead's own model reproduces its measured signal); default true */
  sizeBeads?: boolean;
  /** beads measured but left out of the fit (true): sized back and given a residual as a check */
  checkOnly?: ArrayLike<boolean>;
  /**
   * Group (detector) of each bead, 0-based: beads measured on different detectors of the same optics (e.g. CytoFLEX
   * nano VSSC1 and VSSC2) share the half-angle but each group gets its own factor. Default: one group.
   */
  groups?: ArrayLike<number>;
}

export interface BeadFitRow {
  label: string;
  diameterNm: number;
  /** measured median scatter (a.u.) */
  measured: number;
  /** modelled collected cross section (nm²) at the fitted geometry */
  sigmaNm2: number;
  /** predicted signal F·σ (a.u.) */
  predicted: number;
  /** 100·(measured/predicted − 1) */
  residualPct: number;
  /** diameter (nm) of this bead material reproducing the measured signal (nearest solution to the nominal), or NaN */
  sizedNm: number;
  /** 100·(sizedNm/diameterNm − 1) */
  sizeErrorPct: number;
  /** false if the measured value was missing / non-positive (ignored) or the bead is a check only */
  used: boolean;
  /** measured, but left out of the fit (opts.checkOnly): residual and sized-back diameter are a check */
  check?: boolean;
}

/** Factor of one group (detector) of a grouped fit. */
export interface GroupFactor {
  auPerNm2: number;
  nm2PerAu: number;
  /** beads of the group used in the fit */
  n: number;
  /** CV (%) of the group's measured/predicted ratios */
  cvPct: number;
}

export interface CollectionFit {
  method: 'cv' | 'lsq' | 'fixed';
  setup: ScatterSetup;
  /** fitted (or fixed) collection half-angle (deg) */
  halfAngleDeg: number;
  /** a.u. per nm²: measured = auPerNm2 · σ */
  auPerNm2: number;
  /** nm² per a.u. (FCMPASS "Cali. Factor (nm^2)"): σ = nm2PerAu · a.u. */
  nm2PerAu: number;
  /** CV (%) of measured/predicted ratios at the chosen angle */
  cvPct: number;
  /** R² of log10(measured) vs log10(F·σ) */
  r2Log: number;
  /** RMS of log10(measured/predicted) */
  rmsLog: number;
  beads: BeadFitRow[];
  /** factor per group (opts.groups; one entry without groups); auPerNm2 / nm2PerAu above are those of group 0 */
  groupFactors: GroupFactor[];
  /** sweep curves for plotting (empty when fixed) */
  sweep: { halfAngleDeg: Float64Array; cvPct: Float64Array; rmsLog: Float64Array; auPerNm2: Float64Array };
  warnings: string[];
}

function ratioStats(meas: number[], sig: number[]): { meanRatio: number; cv: number; logF: number; rms: number } {
  const n = meas.length;
  let s = 0;
  let sl = 0;
  const r = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    r[i] = meas[i] / sig[i];
    s += r[i];
    sl += Math.log10(r[i]);
  }
  const mean = s / n;
  const logF = sl / n;
  let ss = 0;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    ss += (r[i] - mean) ** 2;
    sr += (Math.log10(r[i]) - logF) ** 2;
  }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { meanRatio: mean, cv: (100 * sd) / mean, logF, rms: Math.sqrt(sr / n) };
}

/**
 * Ratio statistics of beads in groups (each group its own factor): per-group stats, the pooled CV
 * (sqrt(sum of squared relative deviations / (n - groups))) and the RMS log residual over all beads.
 */
function groupedStats(
  meas: number[],
  sig: number[],
  grp: number[],
  nGroups: number,
): { per: ReturnType<typeof ratioStats>[]; n: number[]; cv: number; rms: number; ssRelG: number[]; ssLogG: number[] } {
  const per: ReturnType<typeof ratioStats>[] = [];
  const n: number[] = [];
  const ssRelG: number[] = [];
  const ssLogG: number[] = [];
  let ssRel = 0;
  let ssLog = 0;
  for (let g = 0; g < nGroups; g++) {
    const m: number[] = [];
    const sg: number[] = [];
    for (let i = 0; i < meas.length; i++) if (grp[i] === g) (m.push(meas[i]), sg.push(sig[i]));
    n.push(m.length);
    if (!m.length) {
      per.push({ meanRatio: NaN, cv: NaN, logF: NaN, rms: NaN });
      ssRelG.push(0);
      ssLogG.push(0);
      continue;
    }
    const st = ratioStats(m, sg);
    per.push(st);
    let a = 0;
    let b = 0;
    for (let i = 0; i < m.length; i++) {
      const r = m[i] / sg[i];
      a += (r / st.meanRatio - 1) ** 2;
      b += (Math.log10(r) - st.logF) ** 2;
    }
    ssRelG.push(a);
    ssLogG.push(b);
    ssRel += a;
    ssLog += b;
  }
  const used = n.filter((k) => k > 0).length;
  const dof = meas.length - used;
  return { per, n, cv: dof > 0 ? 100 * Math.sqrt(ssRel / dof) : 0, rms: Math.sqrt(ssLog / Math.max(1, meas.length)), ssRelG, ssLogG };
}

/**
 * Fit the collection half-angle and the a.u.↔nm² factor from reference beads.
 * @param beads reference beads (diameter nm, RI)
 * @param measured median scatter (a.u.) per bead, same order; NaN / <= 0 entries are ignored
 */
export function fitCollectionAngle(beads: ScatterBead[], measured: ArrayLike<number>, opts: FitCollectionOptions): CollectionFit {
  if (beads.length !== measured.length) throw new Error('fitCollectionAngle: beads and measured differ in length');
  const warnings: string[] = [];
  const { wavelengthNm, nMedium } = opts;
  const thetaDeg = opts.thetaDeg ?? 90;
  const phiDeg = opts.phiDeg ?? 90;
  const valid = beads.map((b, i) => Number.isFinite(measured[i]) && measured[i] > 0 && b.diameterNm > 0);
  const check = beads.map((_, i) => valid[i] && !!opts.checkOnly?.[i]);
  const used = valid.map((v, i) => v && !check[i]);
  const idx = used.flatMap((u, i) => (u ? [i] : []));
  if (!idx.length) throw new Error('fitCollectionAngle: no valid bead measurements');
  const fixed = opts.fixedHalfAngleDeg;
  if (fixed === undefined && idx.length < 2) throw new Error('fitCollectionAngle: at least 2 beads are needed to fit the half-angle (or pass fixedHalfAngleDeg)');
  if (fixed === undefined && idx.length < 4) warnings.push('fewer than 4 beads: the fitted half-angle is poorly constrained');
  const method = opts.method ?? 'cv';
  const geomFor = (eps: number): CollectionGeometry => ({
    thetaDeg,
    phiDeg,
    halfAngleDeg: eps,
    obscurationHalfAngleDeg: opts.obscurationHalfAngleDeg,
    polarization: opts.polarization,
  });
  const k = wavenumber(wavelengthNm, nMedium);
  const coefs = beads.map((b) => particleCoefficients({ kind: 'sphere', ri: b.ri, diameterNm: b.diameterNm }, wavelengthNm, nMedium).coef);
  const nMax = Math.max(...beads.flatMap((_, i) => (valid[i] ? [coefs[i].nTerms] : [])));
  const meas = idx.map((i) => measured[i]);
  const groupOf = beads.map((_, i) => Math.max(0, Math.floor(Number(opts.groups?.[i] ?? 0)) || 0));
  const nGroups = Math.max(1, ...groupOf.map((g) => g + 1));
  const grp = idx.map((i) => groupOf[i]);
  const usedGroups = new Set(grp).size;
  if (fixed === undefined && idx.length - usedGroups < 1)
    throw new Error('fitCollectionAngle: at least one detector needs 2 beads to fit the half-angle (or pass fixedHalfAngleDeg)');

  let best = fixed ?? NaN;
  const sweep = { halfAngleDeg: new Float64Array(0), cvPct: new Float64Array(0), rmsLog: new Float64Array(0), auPerNm2: new Float64Array(0) };
  if (fixed === undefined) {
    const [lo, hi] = opts.halfAngleRangeDeg ?? [0.1, 90];
    const step = opts.stepDeg ?? 0.1;
    const nS = Math.max(1, Math.floor((hi - lo) / step + 1e-9) + 1);
    sweep.halfAngleDeg = new Float64Array(nS);
    sweep.cvPct = new Float64Array(nS);
    sweep.rmsLog = new Float64Array(nS);
    sweep.auPerNm2 = new Float64Array(nS);
    // per-group sums of squares over the sweep; with several groups each is weighted by its own scatter at its best
    // angle (maximum likelihood with a noise level per detector): a set of beads that fits poorly at every angle (e.g.
    // small beads near the noise) then hardly moves the half-angle that the well-fitting set determines
    const ssG: Float64Array[] = Array.from({ length: nGroups }, () => new Float64Array(nS).fill(NaN));
    const dofG = Array.from({ length: nGroups }, (_, g) => grp.filter((x) => x === g).length - 1);
    for (let s = 0; s < nS; s++) {
      const eps = Math.round((lo + s * step) * 1e6) / 1e6;
      const g = geomFor(eps);
      // uncached quadrature: build directly (avoid flooding the cache with 900 entries)
      const q = buildQuadratureUncached(g, nMax);
      const sig = idx.map((i) => collectedCrossSection(coefs[i], q, k));
      sweep.halfAngleDeg[s] = eps;
      if (sig.some((v) => !(v > 0))) {
        sweep.cvPct[s] = sweep.rmsLog[s] = sweep.auPerNm2[s] = NaN;
        continue;
      }
      const st = groupedStats(meas, sig, grp, nGroups);
      sweep.cvPct[s] = st.cv;
      sweep.rmsLog[s] = st.rms;
      const g0 = st.per.find((p) => Number.isFinite(p.meanRatio)) ?? st.per[0];
      sweep.auPerNm2[s] = method === 'cv' ? g0.meanRatio : Math.pow(10, g0.logF);
      for (let gi = 0; gi < nGroups; gi++) ssG[gi][s] = method === 'cv' ? st.ssRelG[gi] : st.ssLogG[gi];
    }
    // weights: 1 / (the group's smallest variance over the sweep), floored at a 2 % scatter
    const floor = method === 'cv' ? 0.02 ** 2 : Math.log10(1.02) ** 2;
    const varG = ssG.map((a, gi) => {
      if (dofG[gi] < 1) return NaN;
      let m = Infinity;
      for (const v of a) if (v < m) m = v;
      return Math.max(m / dofG[gi], floor);
    });
    const vRef = Math.min(...varG.filter((v) => Number.isFinite(v)));
    const wG = varG.map((v) => (Number.isFinite(v) ? vRef / v : 0));
    const weighted = usedGroups > 1;
    let bestScore = Infinity;
    for (let s = 0; s < nS; s++) {
      let num = 0;
      let den = 0;
      let bad = false;
      for (let gi = 0; gi < nGroups; gi++) {
        if (!(wG[gi] > 0)) continue;
        if (!Number.isFinite(ssG[gi][s])) bad = true;
        num += wG[gi] * ssG[gi][s];
        den += wG[gi] * dofG[gi];
      }
      if (bad || !(den > 0)) continue;
      // the plotted criterion of a grouped fit: the weighted pooled CV (or RMS log residual)
      if (weighted) {
        if (method === 'cv') sweep.cvPct[s] = 100 * Math.sqrt(num / den);
        else sweep.rmsLog[s] = Math.sqrt(num / den);
      }
      const score = num / den;
      if (score < bestScore - 1e-15) {
        bestScore = score;
        best = sweep.halfAngleDeg[s];
      }
    }
    if (!Number.isFinite(best)) throw new Error('fitCollectionAngle: no valid half-angle');
    const [lo2, hi2] = [sweep.halfAngleDeg[0], sweep.halfAngleDeg[nS - 1]];
    if (best <= lo2 + 1e-9 || best >= hi2 - 1e-9) warnings.push(`best half-angle ${best}° is at the edge of the swept range`);
  }
  const geometry = geomFor(best);
  const q = apertureQuadrature(geometry, nMax);
  const sigAll = beads.map((_, i) => collectedCrossSection(coefs[i], q, k));
  const sig = idx.map((i) => sigAll[i]);
  const gst = groupedStats(meas, sig, grp, nGroups);
  const Fg = gst.per.map((p) => (method === 'lsq' ? Math.pow(10, p.logF) : p.meanRatio));
  const F0 = Fg.find((f) => Number.isFinite(f)) ?? NaN;
  const Fof = (i: number) => (Number.isFinite(Fg[groupOf[i]]) ? Fg[groupOf[i]] : F0);
  // R² in log space (each group with its own factor)
  let mLog = 0;
  for (const v of meas) mLog += Math.log10(v);
  mLog /= meas.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let j = 0; j < meas.length; j++) {
    ssTot += (Math.log10(meas[j]) - mLog) ** 2;
    ssRes += (Math.log10(meas[j]) - Math.log10(Fof(idx[j]) * sig[j])) ** 2;
  }
  const setup: ScatterSetup = { wavelengthNm, nMedium, geometry };
  const rows: BeadFitRow[] = beads.map((b, i) => {
    const F = Fof(i);
    const pred = F * sigAll[i];
    const m = measured[i];
    let sized = NaN;
    if (valid[i] && opts.sizeBeads !== false) sized = sizeNear({ kind: 'sphere', ri: b.ri }, b.diameterNm, m / F, setup);
    return {
      label: b.label ?? `${b.diameterNm} nm`,
      diameterNm: b.diameterNm,
      measured: m,
      sigmaNm2: sigAll[i],
      predicted: pred,
      residualPct: valid[i] ? 100 * (m / pred - 1) : NaN,
      sizedNm: sized,
      sizeErrorPct: 100 * (sized / b.diameterNm - 1),
      used: used[i],
      ...(check[i] ? { check: true } : {}),
    };
  });
  const F = Number.isFinite(Fg[0]) ? Fg[0] : F0;
  return {
    method: fixed !== undefined ? 'fixed' : method,
    setup,
    halfAngleDeg: best,
    auPerNm2: F,
    nm2PerAu: 1 / F,
    cvPct: gst.cv,
    r2Log: ssTot > 0 ? 1 - ssRes / ssTot : NaN,
    rmsLog: Math.sqrt(ssRes / meas.length),
    beads: rows,
    groupFactors: Fg.map((f, g) => ({ auPerNm2: f, nm2PerAu: 1 / f, n: gst.n[g], cvPct: gst.per[g].cv })),
    sweep,
    warnings,
  };
}

function buildQuadratureUncached(geometry: CollectionGeometry, nMax: number): ApertureQuadrature {
  const linear = (geometry.polarization ?? 'linear') === 'linear';
  const th0 = geometry.thetaDeg * D2R;
  const ph0 = geometry.phiDeg * D2R;
  const nm = Math.max(8, Math.ceil(nMax / 8) * 8);
  const out = { t: [] as number[], a: [] as number[], b: [] as number[] };
  coneNodes(th0, ph0, Math.min(Math.PI, geometry.halfAngleDeg * D2R), nm, linear, 1, out);
  const obs = geometry.obscurationHalfAngleDeg ?? 0;
  if (obs > 0) coneNodes(th0, ph0, Math.min(Math.PI, obs * D2R, geometry.halfAngleDeg * D2R), nm, linear, -1, out);
  let solid = 0;
  for (let i = 0; i < out.a.length; i++) solid += out.a[i] + out.b[i];
  return { theta: Float64Array.from(out.t), wPerp: Float64Array.from(out.a), wPar: Float64Array.from(out.b), solidAngle: solid, nMax: nm };
}

/**
 * Diameter (nm) near `d0` at which `model` gives the collected cross section `sigma` (nm²); NaN if no solution
 * within [0.5·d0, 2·d0]. Picks the crossing closest to d0 (resolves Mie-resonance ambiguity locally).
 */
export function sizeNear(model: ParticleModel, d0: number, sigma: number, setup: ScatterSetup): number {
  if (!(sigma > 0) || !(d0 > 0)) return NaN;
  const n = 151;
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) ds[i] = d0 * Math.pow(4, i / (n - 1) - 0.5); // 0.5·d0 .. 2·d0, log-spaced
  const s = apertureCrossSections(model, ds, setup);
  let bestD = NaN;
  let bestDist = Infinity;
  for (let i = 0; i + 1 < n; i++) {
    const a = s[i] - sigma;
    const b = s[i + 1] - sigma;
    if (a === 0 || a * b < 0) {
      // log-log linear interpolation, then one secant refinement on the exact model
      const la = Math.log(s[i]);
      const lb = Math.log(s[i + 1]);
      const t = (Math.log(sigma) - la) / (lb - la);
      const d = Math.exp(Math.log(ds[i]) + t * (Math.log(ds[i + 1]) - Math.log(ds[i])));
      const dist = Math.abs(Math.log(d / d0));
      if (dist < bestDist) {
        bestDist = dist;
        bestD = refineRoot(model, sigma, setup, ds[i], ds[i + 1], d);
      }
    }
  }
  return bestD;
}

function refineRoot(model: ParticleModel, sigma: number, setup: ScatterSetup, lo: number, hi: number, guess: number): number {
  const f = (d: number) => Math.log(apertureCrossSection({ ...model, diameterNm: d } as Particle, setup.geometry, setup.wavelengthNm, setup.nMedium) / sigma);
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) return guess;
  let x = guess;
  for (let it = 0; it < 40; it++) {
    const fx = f(x);
    if (Math.abs(fx) < 1e-10) return x;
    if (fa * fx < 0) {
      b = x;
      fb = fx;
    } else {
      a = x;
      fa = fx;
    }
    // secant step, fall back to bisection when it leaves the bracket
    let xn = b - (fb * (b - a)) / (fb - fa);
    if (!(xn > a && xn < b)) xn = (a + b) / 2;
    if (Math.abs(xn - x) < 1e-9 * x) return xn;
    x = xn;
  }
  return x;
}

// ------------------------------------------------------------------ scatter-diameter curve

export interface SizeCurveOptions {
  /** smallest modelled diameter (nm), default 20 */
  minNm?: number;
  /** largest modelled diameter (nm), default 1500 */
  maxNm?: number;
  /** diameter step (nm), default 1 */
  stepNm?: number;
  /**
   * diameter range (nm) to use for inversion; the usable part starts at rangeNm[0] (or, if σ(d) does not rise there,
   * where it rises again) and ends at rangeNm[1] or at the first local maximum of σ(d), whichever comes first.
   * Default: from minNm.
   */
  rangeNm?: [number, number];
  /**
   * Low size resolution threshold (default 0.5): stretches of the valid range where the local log-log slope
   * dlnσ/dln d is below it are reported in `lowResolutionNm` (a 1 % error in scatter becomes more than a 1/slope %
   * error in size there). While σ(d) still rises they stay in the valid range and are sized. 0 = no bands.
   */
  minLogSlope?: number;
  /**
   * Legacy behaviour (calibrations saved before low-resolution bands): end the valid range at the first stretch below
   * minLogSlope, and move a range that starts on such a stretch to the next steep part. Default false.
   */
  endAtLowSlope?: boolean;
}

export const DEFAULT_MIN_LOG_SLOPE = 0.5;

export interface SizeCurve {
  model: ParticleModel;
  setup: ScatterSetup;
  /** full modelled curve */
  diametersNm: Float64Array;
  sigmaNm2: Float64Array;
  /** monotonic (invertible) part */
  validRangeNm: [number, number];
  validSigmaNm2: [number, number];
  /** true when the valid range ended at a local maximum (Mie resonance) rather than at the range limit */
  endsAtMaximum: boolean;
  /**
   * true when the valid range ended because the curve turned too flat (log-log slope below minLogSlope); only with
   * the legacy option endAtLowSlope
   */
  endsAtFlat: boolean;
  /** slope threshold used */
  minLogSlope: number;
  /**
   * stretches [from, to] (nm) inside the valid range where the log-log slope of σ(d) is below minLogSlope: still
   * sized (σ rises), but with low size resolution (size error over 1/minLogSlope times the scatter error)
   */
  lowResolutionNm: [number, number][];
  /**
   * when the range ends at a local maximum: the diameters at its top end [from, to] (nm) whose signals larger particles
   * (above the maximum, within the modelled grid) also give; null otherwise
   */
  ambiguousNm: [number, number] | null;
  /** local log-log slope dlnσ/dln d at each diameter of the full curve (size resolution = 1 / slope) */
  logSlope: Float64Array;
  /** inversion knots (ln σ → ln d) and PCHIP slopes */
  lnSigma: Float64Array;
  lnDiameter: Float64Array;
  slopes: Float64Array;
}

/** Monotone (Fritsch–Carlson / scipy PchipInterpolator) slopes. */
export function pchipSlopes(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const n = x.length;
  const d = new Float64Array(n);
  if (n < 2) return d;
  const h = new Float64Array(n - 1);
  const del = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    del[i] = (y[i + 1] - y[i]) / h[i];
  }
  if (n === 2) {
    d[0] = d[1] = del[0];
    return d;
  }
  for (let k = 1; k < n - 1; k++) {
    if (del[k - 1] * del[k] <= 0) d[k] = 0;
    else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / del[k - 1] + w2 / del[k]);
    }
  }
  const edge = (h0: number, h1: number, m0: number, m1: number) => {
    let dd = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (Math.sign(dd) !== Math.sign(m0)) dd = 0;
    else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(dd) > Math.abs(3 * m0)) dd = 3 * m0;
    return dd;
  };
  d[0] = edge(h[0], h[1], del[0], del[1]);
  d[n - 1] = edge(h[n - 2], h[n - 3], del[n - 2], del[n - 3]);
  return d;
}

function hermite(x: Float64Array, y: Float64Array, d: Float64Array, xv: number): number {
  let lo = 0;
  let hi = x.length - 1;
  if (xv <= x[0]) return y[0];
  if (xv >= x[hi]) return y[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= xv) lo = mid;
    else hi = mid;
  }
  const h = x[hi] - x[lo];
  const t = (xv - x[lo]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y[lo] + (t3 - 2 * t2 + t) * h * d[lo] + (-2 * t3 + 3 * t2) * y[hi] + (t3 - t2) * h * d[hi];
}

const curveCache = new Map<string, SizeCurve>();

/**
 * Local log-log slope dlnσ/dln d of a sampled curve: central differences over about ±1 % of the diameter (at least one
 * grid step), so the slope describes the curve on the scale of a measurement error rather than single grid steps.
 */
export function logSlopes(ds: Float64Array, sig: Float64Array): Float64Array {
  const n = ds.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.max(ds[i] * 0.01, 1e-12);
    let a = i;
    let b = i;
    while (a > 0 && ds[i] - ds[a] < h) a--;
    while (b < n - 1 && ds[b] - ds[i] < h) b++;
    out[i] = b > a && sig[a] > 0 && sig[b] > 0 ? Math.log(sig[b] / sig[a]) / Math.log(ds[b] / ds[a]) : NaN;
  }
  return out;
}

/**
 * Size resolution of a curve at a diameter: relative size error per relative scatter error (dln d / dlnσ), e.g. 0.3 =
 * a 1 % scatter error gives a 0.3 % size error. NaN outside the modelled grid; Infinity where the curve is flat.
 */
export function sizeResolution(curve: Pick<SizeCurve, 'diametersNm' | 'logSlope'>, diameterNm: number): number {
  const ds = curve.diametersNm;
  if (!(diameterNm >= ds[0] && diameterNm <= ds[ds.length - 1])) return NaN;
  let lo = 0;
  let hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] <= diameterNm) lo = mid;
    else hi = mid;
  }
  const t = hi === lo ? 0 : (diameterNm - ds[lo]) / (ds[hi] - ds[lo]);
  const sl = curve.logSlope[lo] * (1 - t) + curve.logSlope[hi] * t;
  return sl > 0 ? 1 / sl : Infinity;
}

/** Size uncertainty (± %) at a diameter for a given scatter CV (%), from the local size resolution. */
export function sizeUncertaintyPct(curve: Pick<SizeCurve, 'diametersNm' | 'logSlope'>, diameterNm: number, scatterCvPct: number): number {
  return sizeResolution(curve, diameterNm) * scatterCvPct;
}

/**
 * Scatter–diameter curve of a particle model for a detector, restricted to its monotonic part for inversion.
 * Cached by inputs. Diameters in nm, σ in nm².
 */
export function buildSizeCurve(model: ParticleModel, setup: ScatterSetup, opts: SizeCurveOptions = {}): SizeCurve {
  const minNm = opts.minNm ?? 20;
  const maxNm = opts.maxNm ?? 1500;
  const step = opts.stepNm ?? 1;
  if (!(maxNm > minNm) || !(step > 0)) throw new Error('buildSizeCurve: invalid diameter grid');
  const legacy = !!opts.endAtLowSlope;
  const key = JSON.stringify([model, setup, minNm, maxNm, step, opts.rangeNm ?? null, opts.minLogSlope ?? DEFAULT_MIN_LOG_SLOPE, legacy]);
  const cached = curveCache.get(key);
  if (cached) return cached;
  const n = Math.floor((maxNm - minNm) / step + 1e-9) + 1;
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) ds[i] = minNm + i * step;
  const sig = apertureCrossSections(model, ds, setup);
  const minSlope = opts.minLogSlope ?? DEFAULT_MIN_LOG_SLOPE;
  const slope = logSlopes(ds, sig);
  const [rLo, rHi] = opts.rangeNm ?? [minNm, maxNm];
  let i0 = 0;
  while (i0 < n - 1 && ds[i0] < rLo - 1e-9) i0++;
  if (legacy) {
    // a range that starts on a flat part begins where the curve is steep enough again
    if (minSlope > 0) while (i0 < n - 1 && ds[i0 + 1] <= rHi + 1e-9 && !(slope[i0] >= minSlope)) i0++;
  } else {
    // a range that starts where σ(d) does not rise (past a Mie maximum) begins where it rises again
    while (i0 < n - 1 && ds[i0 + 1] <= rHi + 1e-9 && !(sig[i0 + 1] > sig[i0])) i0++;
  }
  let i1 = i0;
  let endsAtMaximum = false;
  let endsAtFlat = false;
  // the valid range is the strictly rising part: it ends at a local maximum or at the range limit (legacy: also at the
  // first low-slope stretch)
  while (i1 + 1 < n && ds[i1 + 1] <= rHi + 1e-9) {
    if (!(sig[i1 + 1] > sig[i1])) {
      endsAtMaximum = true;
      break;
    }
    if (legacy && minSlope > 0 && !(slope[i1 + 1] >= minSlope)) {
      endsAtFlat = true;
      break;
    }
    i1++;
  }
  if (i1 - i0 < 1) throw new Error(`buildSizeCurve: no usable range${opts.rangeNm ? ` within ${rLo} to ${rHi} nm` : ''} (the curve is flat or falling there; check rangeNm)`);
  // low-resolution stretches inside the valid range
  const lowResolutionNm: [number, number][] = [];
  if (minSlope > 0) {
    let a = -1;
    for (let i = i0; i <= i1 + 1; i++) {
      const low = i <= i1 && !(slope[i] >= minSlope);
      if (low && a < 0) a = i;
      else if (!low && a >= 0) {
        lowResolutionNm.push([ds[a], ds[i - 1]]);
        a = -1;
      }
    }
  }
  // past a local maximum: diameters at the top of the range whose signals larger particles also give
  let ambiguousNm: [number, number] | null = null;
  if (endsAtMaximum) {
    let sMin = Infinity;
    for (let i = i1 + 1; i < n; i++) if (sig[i] < sMin) sMin = sig[i];
    let j = i1;
    while (j > i0 && sig[j - 1] >= sMin) j--;
    if (sig[i1] >= sMin) ambiguousNm = [ds[j], ds[i1]];
  }
  const m = i1 - i0 + 1;
  const lnS = new Float64Array(m);
  const lnD = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    lnS[i] = Math.log(sig[i0 + i]);
    lnD[i] = Math.log(ds[i0 + i]);
  }
  const curve: SizeCurve = {
    model,
    setup,
    diametersNm: ds,
    sigmaNm2: sig,
    validRangeNm: [ds[i0], ds[i1]],
    validSigmaNm2: [sig[i0], sig[i1]],
    endsAtMaximum,
    endsAtFlat,
    minLogSlope: minSlope,
    lowResolutionNm,
    ambiguousNm,
    logSlope: slope,
    lnSigma: lnS,
    lnDiameter: lnD,
    slopes: pchipSlopes(lnS, lnD),
  };
  if (curveCache.size > 32) curveCache.clear();
  curveCache.set(key, curve);
  return curve;
}

/**
 * Convert scatter values to diameters (nm) through the monotonic part of a size curve (PCHIP in log–log space).
 * Values are cross sections in nm² unless `nm2PerAu` is given (then raw a.u. are converted first). Values outside
 * curve.validSigmaNm2 (below the smallest or above the largest valid diameter), non-positive or NaN give NaN.
 */
export function scatterToDiameter(curve: SizeCurve, values: Float32Array | Float64Array, opts: { nm2PerAu?: number } = {}): Float32Array {
  const f = opts.nm2PerAu ?? 1;
  const out = new Float32Array(values.length);
  const [sLo, sHi] = curve.validSigmaNm2;
  const x = curve.lnSigma;
  const y = curve.lnDiameter;
  const d = curve.slopes;
  for (let i = 0; i < values.length; i++) {
    const s = values[i] * f;
    out[i] = s >= sLo && s <= sHi ? Math.exp(hermite(x, y, d, Math.log(s))) : NaN;
  }
  return out;
}

/** Collected cross section (nm²) of the curve's model at a diameter (log–log interpolation of the full curve). */
export function diameterToScatter(curve: SizeCurve, diameterNm: number): number {
  const ds = curve.diametersNm;
  const s = curve.sigmaNm2;
  if (!(diameterNm >= ds[0] && diameterNm <= ds[ds.length - 1])) return NaN;
  let lo = 0;
  let hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] <= diameterNm) lo = mid;
    else hi = mid;
  }
  if (hi === lo) return s[lo];
  const t = (Math.log(diameterNm) - Math.log(ds[lo])) / (Math.log(ds[hi]) - Math.log(ds[lo]));
  return Math.exp(Math.log(s[lo]) + t * (Math.log(s[hi]) - Math.log(s[lo])));
}

/** Calibrated scatter channel: a.u. → collected cross section (nm²). */
export function scatterToCrossSection(values: Float32Array | Float64Array, nm2PerAu: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] * nm2PerAu;
  return out;
}

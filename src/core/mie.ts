// Mie scattering for homogeneous spheres (BHMIE) and coated spheres (BHCOAT), after
// Bohren & Huffman, "Absorption and Scattering of Light by Small Particles" (Wiley 1983), App. A/B.
// Pure numerics, no UI. Lengths in nm; angles in radians unless a name ends in `Deg`.
//
// Conventions (Bohren & Huffman):
// - Complex refractive index m = n + i·k with k >= 0 for absorbing particles (miepython uses n - i·k).
// - Relative index m = n_particle / n_medium; size parameter x = π·d·n_medium / λ0 (λ0 = vacuum wavelength).
// - Amplitude functions S1 (perpendicular to the scattering plane) and S2 (parallel). For incident light linearly
//   polarized along x and a scattering direction (θ, φ) with φ measured from the polarization direction:
//     dC/dΩ = (|S1|²·sin²φ + |S2|²·cos²φ) / k²,   unpolarized: (|S1|² + |S2|²) / (2k²),   k = 2π·n_medium/λ0.
// - The logarithmic derivative D_n(mx) is computed by downward recurrence (stable for absorbing and large |mx|).

export interface Complex {
  re: number;
  im: number;
}

/** A refractive index: a real number or a complex value (im >= 0 = absorbing, Bohren & Huffman sign). */
export type RIValue = number | Complex;

/** Expansion coefficients a_n, b_n (n = 1..nTerms; index 0 of each array is n = 1). */
export interface MieCoefficients {
  nTerms: number;
  aRe: Float64Array;
  aIm: Float64Array;
  bRe: Float64Array;
  bIm: Float64Array;
}

export interface MieEfficiencies {
  /** extinction efficiency Qext = Cext / (π r²) */
  qext: number;
  /** scattering efficiency Qsca = Csca / (π r²) */
  qsca: number;
  /** absorption efficiency Qext - Qsca */
  qabs: number;
  /** backscattering efficiency (Bohren & Huffman definition, = 4π/(k²πr²)·dC/dΩ at 180°) */
  qback: number;
  /** asymmetry parameter <cos θ> */
  g: number;
}

/** Amplitude functions at the requested angles (Bohren & Huffman normalization). */
export interface AmplitudeFunctions {
  S1re: Float64Array;
  S1im: Float64Array;
  S2re: Float64Array;
  S2im: Float64Array;
}

export interface MieResult extends MieEfficiencies, AmplitudeFunctions {
  /** size parameter used for the efficiencies (outer size parameter for coated spheres) */
  x: number;
  nTerms: number;
}

const cplx = (v: RIValue): Complex => (typeof v === 'number' ? { re: v, im: 0 } : { re: v.re, im: v.im });

/** Number of terms (Wiscombe / Bohren & Huffman criterion): x + 4·x^(1/3) + 2. */
export function mieTerms(x: number): number {
  return Math.max(1, Math.floor(x + 4 * Math.cbrt(x) + 2));
}

/** Size parameter x = π·d·n_medium/λ0 (d and λ0 in nm). */
export function sizeParameter(diameterNm: number, wavelengthNm: number, nMedium: number): number {
  return (Math.PI * diameterNm * nMedium) / wavelengthNm;
}

/** Wavenumber in the medium k = 2π·n_medium/λ0 (1/nm). */
export function wavenumber(wavelengthNm: number, nMedium: number): number {
  return (2 * Math.PI * nMedium) / wavelengthNm;
}

/**
 * Logarithmic derivative D_n(z) = ψ_n'(z)/ψ_n(z) for n = 0..nMax by downward recurrence
 * D_{n-1} = n/z - 1/(D_n + n/z), started at n = nStart (> nMax) with D = 0.
 * Returns interleaved [re0, im0, re1, im1, ...].
 */
function logDerivative(zr: number, zi: number, nMax: number, nStart: number): Float64Array {
  const out = new Float64Array(2 * (nMax + 1));
  let dr = 0;
  let di = 0;
  // 1/z
  const zz = zr * zr + zi * zi;
  const izr = zr / zz;
  const izi = -zi / zz;
  for (let n = nStart; n >= 1; n--) {
    // n/z
    const nzr = n * izr;
    const nzi = n * izi;
    // t = D_n + n/z ; D_{n-1} = n/z - 1/t
    const tr = dr + nzr;
    const ti = di + nzi;
    const tt = tr * tr + ti * ti;
    dr = nzr - tr / tt;
    di = nzi + ti / tt;
    if (n - 1 <= nMax) {
      out[2 * (n - 1)] = dr;
      out[2 * (n - 1) + 1] = di;
    }
  }
  return out;
}

/**
 * Homogeneous sphere coefficients a_n, b_n (BHMIE).
 * @param m relative refractive index n_particle/n_medium (im >= 0 absorbing)
 * @param x size parameter π·d·n_medium/λ0
 */
export function mieCoefficients(m: RIValue, x: number): MieCoefficients {
  if (!(x > 0)) throw new Error('mieCoefficients: size parameter must be > 0');
  const { re: mr, im: mi } = cplx(m);
  const nStop = mieTerms(x);
  const yr = mr * x;
  const yi = mi * x;
  const yAbs = Math.hypot(yr, yi);
  const nmx = Math.ceil(Math.max(nStop, yAbs)) + 15;
  const D = logDerivative(yr, yi, nStop, nmx);
  const aRe = new Float64Array(nStop);
  const aIm = new Float64Array(nStop);
  const bRe = new Float64Array(nStop);
  const bIm = new Float64Array(nStop);
  // Riccati-Bessel ψ_n(x) and χ_n(x) (ξ = ψ - iχ), upward recurrence (real x)
  let psi0 = Math.cos(x);
  let psi1 = Math.sin(x);
  let chi0 = -Math.sin(x);
  let chi1 = Math.cos(x);
  const mm = mr * mr + mi * mi;
  for (let n = 1; n <= nStop; n++) {
    const psi = ((2 * n - 1) * psi1) / x - psi0;
    const chi = ((2 * n - 1) * chi1) / x - chi0;
    // ξ_n = ψ_n - iχ_n, ξ_{n-1} = ψ_{n-1} - iχ_{n-1}
    const Dr = D[2 * n];
    const Di = D[2 * n + 1];
    const nx = n / x;
    // a_n: u = D/m + n/x
    let ur = (Dr * mr + Di * mi) / mm + nx;
    let ui = (Di * mr - Dr * mi) / mm;
    // num = u·ψ - ψ_{n-1}; den = u·ξ - ξ_{n-1}
    let nr = ur * psi - psi1;
    let ni = ui * psi;
    // u·(psi - i chi) = (ur psi + ui chi) + i(ui psi - ur chi)
    let der = ur * psi + ui * chi - psi1;
    let dei = ui * psi - ur * chi + chi1;
    let dd = der * der + dei * dei;
    aRe[n - 1] = (nr * der + ni * dei) / dd;
    aIm[n - 1] = (ni * der - nr * dei) / dd;
    // b_n: u = m·D + n/x
    ur = mr * Dr - mi * Di + nx;
    ui = mr * Di + mi * Dr;
    nr = ur * psi - psi1;
    ni = ui * psi;
    der = ur * psi + ui * chi - psi1;
    dei = ui * psi - ur * chi + chi1;
    dd = der * der + dei * dei;
    bRe[n - 1] = (nr * der + ni * dei) / dd;
    bIm[n - 1] = (ni * der - nr * dei) / dd;
    psi0 = psi1;
    psi1 = psi;
    chi0 = chi1;
    chi1 = chi;
  }
  return { nTerms: nStop, aRe, aIm, bRe, bIm };
}

/**
 * Coated (core-shell) sphere coefficients a_n, b_n following BHCOAT (Bohren & Huffman App. B), with the
 * logarithmic derivatives computed by downward recurrence instead of BHCOAT's upward recurrence.
 * @param mCore relative index of the core
 * @param mShell relative index of the shell (coating)
 * @param xCore size parameter of the core (π·d_core·n_medium/λ0)
 * @param xShell size parameter of the whole particle (π·d_outer·n_medium/λ0)
 */
export function mieCoatedCoefficients(mCore: RIValue, mShell: RIValue, xCore: number, xShell: number): MieCoefficients {
  if (!(xCore > 0)) return mieCoefficients(mShell, xShell);
  if (!(xShell > xCore)) return mieCoefficients(mCore, xCore);
  const m1 = cplx(mCore);
  const m2 = cplx(mShell);
  const x = xCore;
  const y = xShell;
  const nStop = mieTerms(y);
  // complex arguments
  const x1r = m1.re * x, x1i = m1.im * x;
  const x2r = m2.re * x, x2i = m2.im * x;
  const y2r = m2.re * y, y2i = m2.im * y;
  const nmx = Math.ceil(Math.max(nStop, Math.hypot(x1r, x1i), Math.hypot(x2r, x2i), Math.hypot(y2r, y2i))) + 15;
  const Dx1 = logDerivative(x1r, x1i, nStop, nmx);
  const Dx2 = logDerivative(x2r, x2i, nStop, nmx);
  const Dy2 = logDerivative(y2r, y2i, nStop, nmx);
  // refrel = m2/m1
  const m1m = m1.re * m1.re + m1.im * m1.im;
  const rfr = (m2.re * m1.re + m2.im * m1.im) / m1m;
  const rfi = (m2.im * m1.re - m2.re * m1.im) / m1m;
  // χ_{n-2}, χ_{n-1} for z = x2 and z = y2: χ_{-1} = -sin z, χ_0 = cos z
  const sinC = (r: number, i: number): Complex => ({ re: Math.sin(r) * Math.cosh(i), im: Math.cos(r) * Math.sinh(i) });
  const cosC = (r: number, i: number): Complex => ({ re: Math.cos(r) * Math.cosh(i), im: -Math.sin(r) * Math.sinh(i) });
  let s = sinC(x2r, x2i);
  let c = cosC(x2r, x2i);
  let chi0x2r = -s.re, chi0x2i = -s.im, chi1x2r = c.re, chi1x2i = c.im;
  s = sinC(y2r, y2i);
  c = cosC(y2r, y2i);
  let chi0y2r = -s.re, chi0y2i = -s.im, chi1y2r = c.re, chi1y2i = c.im;
  // real outer Riccati-Bessel functions of y
  let psi0y = Math.cos(y), psi1y = Math.sin(y);
  let chi0y = -Math.sin(y), chi1y = Math.cos(y);
  const aRe = new Float64Array(nStop);
  const aIm = new Float64Array(nStop);
  const bRe = new Float64Array(nStop);
  const bIm = new Float64Array(nStop);
  // complex helpers (inline-ish)
  const mul = (ar: number, ai: number, br: number, bi: number): [number, number] => [ar * br - ai * bi, ar * bi + ai * br];
  const div = (ar: number, ai: number, br: number, bi: number): [number, number] => {
    const d = br * br + bi * bi;
    return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
  };
  const DEL = 1e-8;
  let coreNegligible = false;
  let brR = 0, brI = 0, crR = 0, crI = 0;
  for (let n = 1; n <= nStop; n++) {
    const psiy = ((2 * n - 1) * psi1y) / y - psi0y;
    const chiy = ((2 * n - 1) * chi1y) / y - chi0y;
    const d1y2r = Dy2[2 * n], d1y2i = Dy2[2 * n + 1];
    // χ_n(y2) and χ_n'(y2) are needed for every n (also after the core became negligible: keep recurrences going)
    let [t1r, t1i] = div(chi1y2r, chi1y2i, y2r, y2i);
    const chiy2r = (2 * n - 1) * t1r - chi0y2r;
    const chiy2i = (2 * n - 1) * t1i - chi0y2i;
    [t1r, t1i] = div(chiy2r, chiy2i, y2r, y2i);
    const chipy2r = chi1y2r - n * t1r;
    const chipy2i = chi1y2i - n * t1i;
    if (!coreNegligible) {
      [t1r, t1i] = div(chi1x2r, chi1x2i, x2r, x2i);
      const chix2r = (2 * n - 1) * t1r - chi0x2r;
      const chix2i = (2 * n - 1) * t1i - chi0x2i;
      const d1x1r = Dx1[2 * n], d1x1i = Dx1[2 * n + 1];
      const d1x2r = Dx2[2 * n], d1x2i = Dx2[2 * n + 1];
      [t1r, t1i] = div(chix2r, chix2i, x2r, x2i);
      const chipx2r = chi1x2r - n * t1r;
      const chipx2i = chi1x2i - n * t1i;
      // ancap = (refrel·D1x1 - D1x2) / (refrel·D1x1·χx2 - χ'x2) / (χx2·D1x2 - χ'x2)
      const [rdr, rdi] = mul(rfr, rfi, d1x1r, d1x1i);
      const [q1r, q1i] = mul(rdr, rdi, chix2r, chix2i);
      const [q2r, q2i] = mul(chix2r, chix2i, d1x2r, d1x2i);
      const den2r = q2r - chipx2r, den2i = q2i - chipx2i;
      let [ar, ai] = div(rdr - d1x2r, rdi - d1x2i, q1r - chipx2r, q1i - chipx2i);
      [ar, ai] = div(ar, ai, den2r, den2i);
      // bncap = (refrel·D1x2 - D1x1) / (refrel·χ'x2 - D1x1·χx2) / (χx2·D1x2 - χ'x2)
      const [rd2r, rd2i] = mul(rfr, rfi, d1x2r, d1x2i);
      const [rcpr, rcpi] = mul(rfr, rfi, chipx2r, chipx2i);
      const [q3r, q3i] = mul(d1x1r, d1x1i, chix2r, chix2i);
      let [br, bi] = div(rd2r - d1x1r, rd2i - d1x1i, rcpr - q3r, rcpi - q3i);
      [br, bi] = div(br, bi, den2r, den2i);
      // brack = ancap·(χy2·D1y2 - χ'y2), crack = bncap·(χy2·D1y2 - χ'y2)
      const [q4r, q4i] = mul(chiy2r, chiy2i, d1y2r, d1y2i);
      const fr = q4r - chipy2r, fi = q4i - chipy2i;
      [brR, brI] = mul(ar, ai, fr, fi);
      [crR, crI] = mul(br, bi, fr, fi);
      const absD = Math.hypot(d1y2r, d1y2i);
      const am1 = Math.hypot(...mul(brR, brI, chipy2r, chipy2i));
      const am2 = Math.hypot(...mul(brR, brI, chiy2r, chiy2i));
      const am3 = Math.hypot(...mul(crR, crI, chipy2r, chipy2i));
      const am4 = Math.hypot(...mul(crR, crI, chiy2r, chiy2i));
      if (am1 <= DEL * absD && am2 <= DEL && am3 <= DEL * absD && am4 <= DEL) {
        brR = brI = crR = crI = 0;
        coreNegligible = true;
      }
      chi0x2r = chi1x2r; chi0x2i = chi1x2i; chi1x2r = chix2r; chi1x2i = chix2i;
    }
    // dnbar = (D1y2 - brack·χ'y2) / (1 - brack·χy2); gnbar likewise with crack
    let [p1r, p1i] = mul(brR, brI, chipy2r, chipy2i);
    let [p2r, p2i] = mul(brR, brI, chiy2r, chiy2i);
    const [dnr, dni] = div(d1y2r - p1r, d1y2i - p1i, 1 - p2r, -p2i);
    [p1r, p1i] = mul(crR, crI, chipy2r, chipy2i);
    [p2r, p2i] = mul(crR, crI, chiy2r, chiy2i);
    const [gnr, gni] = div(d1y2r - p1r, d1y2i - p1i, 1 - p2r, -p2i);
    const ny = n / y;
    // a_n = ((dnbar/m2 + n/y)ψ - ψ_{n-1}) / ((dnbar/m2 + n/y)ξ - ξ_{n-1})
    let [ur, ui] = div(dnr, dni, m2.re, m2.im);
    ur += ny;
    let nr = ur * psiy - psi1y;
    let ni = ui * psiy;
    let der = ur * psiy + ui * chiy - psi1y;
    let dei = ui * psiy - ur * chiy + chi1y;
    let dd = der * der + dei * dei;
    aRe[n - 1] = (nr * der + ni * dei) / dd;
    aIm[n - 1] = (ni * der - nr * dei) / dd;
    // b_n with (m2·gnbar + n/y)
    [ur, ui] = mul(m2.re, m2.im, gnr, gni);
    ur += ny;
    nr = ur * psiy - psi1y;
    ni = ui * psiy;
    der = ur * psiy + ui * chiy - psi1y;
    dei = ui * psiy - ur * chiy + chi1y;
    dd = der * der + dei * dei;
    bRe[n - 1] = (nr * der + ni * dei) / dd;
    bIm[n - 1] = (ni * der - nr * dei) / dd;
    // advance recurrences
    psi0y = psi1y;
    psi1y = psiy;
    chi0y = chi1y;
    chi1y = chiy;
    chi0y2r = chi1y2r; chi0y2i = chi1y2i; chi1y2r = chiy2r; chi1y2i = chiy2i;
  }
  return { nTerms: nStop, aRe, aIm, bRe, bIm };
}

/** Efficiencies from the coefficients (x = outer size parameter). */
export function mieEfficiencies(c: MieCoefficients, x: number): MieEfficiencies {
  let qsca = 0;
  let qext = 0;
  let bkr = 0;
  let bki = 0;
  let gsum = 0;
  const N = c.nTerms;
  for (let i = 0; i < N; i++) {
    const n = i + 1;
    const ar = c.aRe[i], ai = c.aIm[i], br = c.bRe[i], bi = c.bIm[i];
    qsca += (2 * n + 1) * (ar * ar + ai * ai + br * br + bi * bi);
    qext += (2 * n + 1) * (ar + br);
    const sgn = n % 2 === 0 ? 1 : -1;
    bkr += (2 * n + 1) * sgn * (ar - br);
    bki += (2 * n + 1) * sgn * (ai - bi);
    // g: Σ n(n+2)/(n+1) Re(a_n a*_{n+1} + b_n b*_{n+1}) + (2n+1)/(n(n+1)) Re(a_n b*_n)
    gsum += ((2 * n + 1) / (n * (n + 1))) * (ar * br + ai * bi);
    if (i + 1 < N) {
      const ar1 = c.aRe[i + 1], ai1 = c.aIm[i + 1], br1 = c.bRe[i + 1], bi1 = c.bIm[i + 1];
      gsum += ((n * (n + 2)) / (n + 1)) * (ar * ar1 + ai * ai1 + br * br1 + bi * bi1);
    }
  }
  const x2 = x * x;
  qsca *= 2 / x2;
  qext *= 2 / x2;
  const qback = (bkr * bkr + bki * bki) / x2;
  const g = qsca > 0 ? (4 / x2) * gsum / qsca : 0;
  return { qext, qsca, qabs: qext - qsca, qback, g };
}

/**
 * Angular functions π_n(cos θ), τ_n(cos θ) for n = 1..nMax at each angle; layout [angle * nMax + (n-1)].
 */
export function angularFunctions(anglesRad: ArrayLike<number>, nMax: number): { pi: Float64Array; tau: Float64Array; nMax: number } {
  const J = anglesRad.length;
  const pi = new Float64Array(J * nMax);
  const tau = new Float64Array(J * nMax);
  for (let j = 0; j < J; j++) {
    const mu = Math.cos(anglesRad[j]);
    let p0 = 0;
    let p1 = 1;
    const o = j * nMax;
    for (let n = 1; n <= nMax; n++) {
      // p1 = π_n, p0 = π_{n-1}
      pi[o + n - 1] = p1;
      tau[o + n - 1] = n * mu * p1 - (n + 1) * p0;
      const p2 = ((2 * n + 1) * mu * p1 - (n + 1) * p0) / n;
      p0 = p1;
      p1 = p2;
    }
  }
  return { pi, tau, nMax };
}

/**
 * S1, S2 from coefficients using precomputed angular functions (nMax >= c.nTerms).
 * S1 = Σ (2n+1)/(n(n+1)) (a_n π_n + b_n τ_n), S2 = Σ (2n+1)/(n(n+1)) (a_n τ_n + b_n π_n).
 */
export function amplitudeFromTables(
  c: MieCoefficients,
  tables: { pi: Float64Array; tau: Float64Array; nMax: number },
  out?: AmplitudeFunctions,
): AmplitudeFunctions {
  const { pi, tau, nMax } = tables;
  if (c.nTerms > nMax) throw new Error('angular tables too short');
  const J = pi.length / nMax;
  const o = out ?? { S1re: new Float64Array(J), S1im: new Float64Array(J), S2re: new Float64Array(J), S2im: new Float64Array(J) };
  const N = c.nTerms;
  // fold (2n+1)/(n(n+1)) into the coefficients once
  const far = new Float64Array(N), fai = new Float64Array(N), fbr = new Float64Array(N), fbi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const n = i + 1;
    const f = (2 * n + 1) / (n * (n + 1));
    far[i] = f * c.aRe[i];
    fai[i] = f * c.aIm[i];
    fbr[i] = f * c.bRe[i];
    fbi[i] = f * c.bIm[i];
  }
  for (let j = 0; j < J; j++) {
    const b = j * nMax;
    let s1r = 0, s1i = 0, s2r = 0, s2i = 0;
    for (let i = 0; i < N; i++) {
      const p = pi[b + i];
      const t = tau[b + i];
      s1r += far[i] * p + fbr[i] * t;
      s1i += fai[i] * p + fbi[i] * t;
      s2r += far[i] * t + fbr[i] * p;
      s2i += fai[i] * t + fbi[i] * p;
    }
    o.S1re[j] = s1r;
    o.S1im[j] = s1i;
    o.S2re[j] = s2r;
    o.S2im[j] = s2i;
  }
  return o;
}

function assemble(c: MieCoefficients, x: number, anglesRad: ArrayLike<number>): MieResult {
  const eff = mieEfficiencies(c, x);
  const amp = anglesRad.length
    ? amplitudeFromTables(c, angularFunctions(anglesRad, c.nTerms))
    : { S1re: new Float64Array(0), S1im: new Float64Array(0), S2re: new Float64Array(0), S2im: new Float64Array(0) };
  return { ...eff, ...amp, x, nTerms: c.nTerms };
}

/**
 * Homogeneous sphere (BHMIE).
 * @param m relative refractive index n_particle/n_medium (im >= 0 absorbing)
 * @param x size parameter π·d·n_medium/λ0
 * @param anglesRad scattering angles θ (rad) at which S1, S2 are returned
 */
export function mieSphere(m: RIValue, x: number, anglesRad: ArrayLike<number> = []): MieResult {
  return assemble(mieCoefficients(m, x), x, anglesRad);
}

/**
 * Coated sphere (BHCOAT).
 * @param mCore relative index of the core, mShell relative index of the shell
 * @param xCore core size parameter, xShell outer size parameter (π·d·n_medium/λ0)
 */
export function mieCoated(mCore: RIValue, mShell: RIValue, xCore: number, xShell: number, anglesRad: ArrayLike<number> = []): MieResult {
  return assemble(mieCoatedCoefficients(mCore, mShell, xCore, xShell), xShell, anglesRad);
}

// ------------------------------------------------------------------ refractive indices

/**
 * Water (distilled), Daimon & Masumura, Appl. Opt. 46:3811 (2007), 4-term Sellmeier at 20.0 °C, valid 182–1129 nm.
 * 405 nm: 1.34309 (the sheath RI FCMPASS reports for 405 nm), 488 nm: 1.33740.
 */
export function riWater(lambdaNm: number): number {
  const l2 = (lambdaNm / 1000) ** 2;
  const n2 =
    1 +
    (5.684027565e-1 * l2) / (l2 - 5.101829712e-3) +
    (1.726177391e-1 * l2) / (l2 - 1.821153936e-2) +
    (2.086189578e-2 * l2) / (l2 - 2.620722293e-2) +
    (1.130748688e-1 * l2) / (l2 - 1.069792721e1);
  return Math.sqrt(n2);
}

/**
 * Polystyrene, Sultanova, Kasarova & Nikolov, Acta Phys. Pol. A 116:585 (2009), one-term Sellmeier
 * n² - 1 = 1.4435 λ²/(λ² - 0.020216) (λ in µm, fitted 437–1052 nm; extrapolated below 437 nm). This is the formula
 * used by FCMPASS (Welsh et al. 2020). 405 nm: 1.6268, 488 nm: 1.6054, 589 nm: 1.5915. Note: de Rond et al. (2018)
 * list 1.633 at 405 nm (measured bead value); pass an explicit RI if you prefer that.
 */
export function riPolystyrene(lambdaNm: number): number {
  const l2 = (lambdaNm / 1000) ** 2;
  return Math.sqrt(1 + (1.4435 * l2) / (l2 - 0.020216));
}

/**
 * Fused (amorphous) silica, Malitson, J. Opt. Soc. Am. 55:1205 (1965), 210–3710 nm.
 * 405 nm: 1.4696, 488 nm: 1.4630. Colloidal (Stöber) silica beads often have a lower RI (≈1.42–1.45);
 * use an RISpec with `n`/`atNm` to shift the curve to the certificate value.
 */
export function riSilica(lambdaNm: number): number {
  const l2 = (lambdaNm / 1000) ** 2;
  const n2 =
    1 +
    (0.6961663 * l2) / (l2 - 0.0684043 ** 2) +
    (0.4079426 * l2) / (l2 - 0.1162414 ** 2) +
    (0.8974794 * l2) / (l2 - 9.896161 ** 2);
  return Math.sqrt(n2);
}

export type Material = 'polystyrene' | 'silica' | 'water';

export function materialRI(material: Material, lambdaNm: number): number {
  switch (material) {
    case 'polystyrene':
      return riPolystyrene(lambdaNm);
    case 'silica':
      return riSilica(lambdaNm);
    case 'water':
      return riWater(lambdaNm);
    default:
      throw new Error(`unknown material ${material as string}`);
  }
}

/**
 * Refractive index specification (absolute, i.e. not relative to the medium):
 * - a number or Complex: the same value at every wavelength;
 * - `{ material }`: the material's dispersion formula;
 * - `{ material, n, atNm }`: the material's dispersion curve shifted (additively) so that RI(atNm) = n, e.g. a bead
 *   certificate value "1.43 at 589 nm" for silica, or an EV core "1.38 at 405 nm" following water dispersion
 *   (`{ material: 'water', n: 1.38, atNm: 405 }`, as FCMPASS updates custom particle models).
 * `k` adds an absorption index (im part).
 */
export type RISpec = number | Complex | { material: Material; n?: number; atNm?: number; k?: number };

/** Resolve an RISpec at a vacuum wavelength (nm) to a complex index. */
export function resolveRI(spec: RISpec, lambdaNm: number): Complex {
  if (typeof spec === 'number') return { re: spec, im: 0 };
  if ('re' in spec) return { re: spec.re, im: spec.im };
  let n = materialRI(spec.material, lambdaNm);
  if (spec.n !== undefined && spec.atNm !== undefined) n += spec.n - materialRI(spec.material, spec.atNm);
  else if (spec.n !== undefined) n = spec.n;
  return { re: n, im: spec.k ?? 0 };
}

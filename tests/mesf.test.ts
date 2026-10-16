import { findBeadPeaks, fitMesf, toMesf, mesfValue, mfiFromMesf } from '../src/core/mesf';
import { BEAD_KITS, getBeadKit, kitReferenceValues, kitValueWarnings, withLotValues, listBeadKits } from '../src/core/beads';

/** Synthetic 8-peak rainbow-bead channel: log-normal peaks (CV `cv`) at gain·MESF, blank near 0 (incl. negatives), doublets. */
function synth(refs: number[], gain: number, opts: { nPer?: number; cv?: number; blankSd?: number; doublets?: number; seed?: number } = {}) {
  const { nPer = 2000, cv = 0.04, blankSd = 60, doublets = 0.03 } = opts;
  let seed = opts.seed ?? 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const v: number[] = [];
  for (let p = 0; p < refs.length; p++) {
    const n = Math.round(nPer * (0.6 + 0.8 * rnd()));
    for (let i = 0; i < n; i++) {
      v.push(refs[p] === 0 ? blankSd * gauss() : gain * refs[p] * Math.exp(cv * gauss()) + 20 * gauss());
      if (rnd() < doublets) v.push(refs[p] === 0 ? blankSd * gauss() : 2 * gain * refs[p] * Math.exp(cv * gauss()));
    }
  }
  for (let i = 0; i < 300; i++) v.push(Math.exp(Math.log(10) + rnd() * Math.log(1e5))); // debris
  return Float32Array.from(v);
}

const REFS = [0, 792, 2079, 6588, 16471, 47497, 137049, 271647];

describe('bead peak finding + MESF regression', () => {
  it('recovers slope 1 and the reference values within 1%', () => {
    for (const seed of [1, 2, 3]) {
      const v = synth(REFS, 2.3, { seed });
      const r = findBeadPeaks(v, REFS.length);
      expect(r.ok).toBe(true);
      expect(r.peaks.length).toBe(8);
      const fit = fitMesf(r.peaks, REFS, { unit: 'MEFL' });
      expect(Math.abs(fit.slope - 1)).toBeLessThan(0.01);
      expect(fit.intercept).toBeCloseTo(-Math.log10(2.3), 2);
      expect(fit.r2).toBeGreaterThan(0.9999);
      expect(fit.n).toBe(7);
      for (const p of fit.points) {
        if (p.blank) continue;
        expect(Math.abs(p.residualPct)).toBeLessThan(1);
        expect(Math.abs(p.median / (2.3 * (p.reference as number)) - 1)).toBeLessThan(0.01);
        expect(Math.abs(p.rcvPct! - 4)).toBeLessThan(1);
      }
      expect(fit.blank).toBeDefined();
      expect(Math.abs(fit.blank!.median)).toBeLessThan(15);
      expect(fit.blank!.thresholdMfi).toBeGreaterThan(fit.blank!.median);
      expect(fit.blank!.thresholdValue).toBeGreaterThan(0);
    }
  });

  it('is robust to a broad blank, few events and many doublets', () => {
    const cases = [
      { blankSd: 400, doublets: 0.05 },
      { nPer: 300, blankSd: 100, cv: 0.05 },
      { doublets: 0.15, blankSd: 100 },
      { cv: 0.12, blankSd: 100, nPer: 3000 },
    ];
    for (const [i, c] of cases.entries()) {
      const r = findBeadPeaks(synth(REFS, 1.7, { ...c, seed: 100 + i }), 8);
      expect(r.ok).toBe(true);
      const fit = fitMesf(r.peaks, REFS);
      expect(Math.abs(fit.slope - 1)).toBeLessThan(0.01);
      // 300 events per peak: sampling error of the median alone is ~0.4% (1 SE)
      const tol = c.nPer === 300 ? 2 : 1;
      for (const p of fit.points) if (!p.blank) expect(Math.abs(p.residualPct)).toBeLessThan(tol);
    }
  });

  it('manual windows override detection', () => {
    const v = synth(REFS, 2.3);
    const auto = findBeadPeaks(v, 8);
    const man = findBeadPeaks(v, 8, { windows: auto.peaks.map((p) => [p.lo, p.hi] as [number, number]).reverse() });
    expect(man.peaks.every((p) => p.manual)).toBe(true);
    for (let i = 0; i < 8; i++) expect(man.peaks[i].median).toBe(auto.peaks[i].median);
  });

  it('reports fewer peaks than requested', () => {
    const r = findBeadPeaks(synth(REFS.slice(0, 4), 2), 6);
    expect(r.ok).toBe(false);
    expect(r.peaks.length).toBe(4);
    expect(r.warnings.join(' ')).toMatch(/found 4 of 6/);
  });

  it('weighted log and linear fits', () => {
    const r = findBeadPeaks(synth(REFS, 2.3), 8);
    const w = fitMesf(r.peaks, REFS, { method: 'weightedLog' });
    expect(Math.abs(w.slope - 1)).toBeLessThan(0.01);
    const l = fitMesf(r.peaks, REFS, { method: 'linear' });
    expect(l.slope).toBeCloseTo(1 / 2.3, 2);
    expect(Math.abs(mesfValue(l, 2.3 * 47497) / 47497 - 1)).toBeLessThan(0.01);
  });

  it('excludes beads, null references and validates input', () => {
    const med = REFS.map((r) => (r === 0 ? 5 : 2 * r));
    const f = fitMesf(med, [0, 792, null, 6588, 16471, 47497, 137049, 271647], { exclude: [7] });
    expect(f.n).toBe(5);
    expect(f.points[2].used).toBe(false);
    expect(f.points[7].used).toBe(false);
    expect(f.warnings.join(' ')).toMatch(/no reference value/);
    expect(f.slope).toBeCloseTo(1, 10);
    expect(() => fitMesf([1, 2], [0, 5, 6])).toThrow();
  });

  it('toMesf converts arrays; non-positive -> NaN or 0', () => {
    const fit = { method: 'log' as const, slope: 1.02, intercept: -0.3 };
    const out = toMesf(fit, Float32Array.from([-3, 0, 100, 1e5]));
    expect(Number.isNaN(out[0]) && Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(Math.pow(10, -0.3) * Math.pow(100, 1.02), 2);
    const z = toMesf(fit, Float32Array.from([-3, 0]), { nonPositive: 'zero' });
    expect(Array.from(z)).toEqual([0, 0]);
    expect(mfiFromMesf(fit, mesfValue(fit, 1234))).toBeCloseTo(1234, 6);
  });
});

describe('bead kit presets', () => {
  it('flags example and empty values; never presents them as certificates', () => {
    for (const k of BEAD_KITS) {
      if (k.valuesStatus === 'example' || k.valuesStatus === 'empty') expect(k.enterLotValues).toBe(true);
      if (k.kind === 'intensity') {
        expect(k.lotSpecific).toBe(true);
        expect(k.valuesStatus).not.toBe('certificate');
        for (const c of k.channels ?? []) expect(c.values.length).toBe(k.populations!.length);
      }
    }
    const qb = getBeadKit('bd-quantibrite-pe')!;
    expect(kitReferenceValues(qb, 'pe')!.values).toEqual([1700, 14200, 39400, 133400]);
    expect(kitValueWarnings(qb, 'PE').join(' ')).toMatch(/examples/);
    const q = getBeadKit('bangs-quantum-mesf-827')!;
    expect(q.populations!.length).toBe(5);
    expect(kitValueWarnings(q, 'PE').join(' ')).toMatch(/missing lot values/);
  });

  it('size kits: nanoViS sizes', () => {
    expect(getBeadKit('beckman-nanovis-low')!.beads!.map((b) => b.diameterNm)).toEqual([40, 80, 108, 142]);
    expect(getBeadKit('beckman-nanovis-high')!.beads!.map((b) => b.diameterNm)).toEqual([142, 304, 600, 1020]);
    expect(listBeadKits('size').every((k) => k.unit === 'nm')).toBe(true);
  });

  it('withLotValues produces a certificate copy', () => {
    const k = withLotValues(getBeadKit('spherotech-rcp-30-5a')!, 'PE', [0, 1, 2, 3, 4, 5, 6, 7], 'AB01');
    expect(k.valuesStatus).toBe('certificate');
    expect(kitReferenceValues(k, 'PE')!.values[7]).toBe(7);
    expect(() => withLotValues(k, 'PE', [1, 2])).toThrow();
  });
});

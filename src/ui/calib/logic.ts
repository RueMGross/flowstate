// Pure logic of the calibration pages (kit defaults, value provenance, bead-peak assignment). Testable without React.
import { kitReferenceValues, listBeadKits, type BeadKit } from '../../core/beads';
import type { BeadRowDraft, MesfChanDraft, MesfDraft } from './draft';
import { guessFluor } from './util';

// ---------------------------------------------------------------- MESF

export const intensityKits = () => listBeadKits('intensity');

export function kitLabels(kit: BeadKit | undefined, d: Pick<MesfDraft, 'customLabels'>): string[] {
  return kit?.populations ?? d.customLabels;
}

export function unitOf(kit: BeadKit | undefined, fluor: string): string {
  const c = kit && fluor ? kitReferenceValues(kit, fluor) : undefined;
  if (c) return c.unitLabel && /^[A-Z]{2,8}$/.test(c.unitLabel) ? c.unitLabel : c.unit;
  return kit?.unit && kit.unit !== 'nm' ? kit.unit : 'MESF';
}

/** A channel draft with the kit's values for a channel. */
export function chanFromKit(kit: BeadKit | undefined, d: Pick<MesfDraft, 'customLabels'>, channel: string, label: string, prev?: MesfChanDraft): MesfChanDraft {
  const labels = kitLabels(kit, d);
  const fluor = guessFluor(kit, channel, label);
  const vals = kit && fluor ? kitReferenceValues(kit, fluor)?.values : undefined;
  const refs = labels.map((l, i) => (vals ? vals[i] ?? null : /blank|unlabel|negative/i.test(l) ? 0 : prev && prev.refs.length === labels.length ? prev.refs[i] : null));
  return {
    channel,
    fluor,
    refs,
    edited: labels.map((_, i) => (!kit && prev && prev.refs.length === labels.length ? prev.edited[i] : false)),
    unit: kit ? unitOf(kit, fluor) : prev?.unit ?? 'MESF',
    present: labels.map(() => true),
    excluded: labels.map(() => false),
    windows: null,
    method: prev?.method ?? 'log',
    editId: prev?.editId,
  };
}

/**
 * Where the reference values of a channel come from (judged over the beads in the file, blank excluded). A template
 * without preset values (valuesStatus 'empty') never gives preset values: whatever is entered was typed by the user,
 * and beads still without a value are reported separately as missing.
 */
export function valuesSource(kit: BeadKit | undefined, c: MesfChanDraft): 'user' | 'kit-example' | 'kit-nominal' | 'mixed' {
  if (!kit || kit.valuesStatus === 'empty') return 'user';
  const idx = c.refs.map((_, i) => i).filter((i) => c.present[i] && c.refs[i] !== 0);
  const ed = idx.filter((i) => c.edited[i]).length;
  if (idx.length && ed === idx.length) return 'user';
  const base = kit.valuesStatus === 'example' ? 'kit-example' : kit.valuesStatus === 'certificate' ? 'user' : 'kit-nominal';
  if (ed === 0) return base;
  return base === 'user' ? 'user' : 'mixed';
}

export function guessKit(name: string): string {
  if (/rainbow|rcp|sphero/i.test(name)) return 'spherotech-rcp-30-5a';
  if (/urcp|ultra/i.test(name)) return 'spherotech-urcp-38-2k';
  if (/quantibrite/i.test(name)) return 'bd-quantibrite-pe';
  if (/simply/i.test(name)) return 'bangs-quantum-simply-cellular';
  if (/quantum|mesf/i.test(name)) {
    const k = intensityKits().find((k) => k.id.startsWith('bangs-quantum-mesf') && k.channels?.some((c) => name.toUpperCase().includes(c.fluorochrome.toUpperCase())));
    return k?.id ?? 'bangs-quantum-mesf-555';
  }
  return 'custom';
}


// ---------------------------------------------------------------- size

export const sizeKits = () => listBeadKits('size');

export function kitShort(kit: BeadKit | undefined): string {
  if (!kit) return 'custom';
  const m = /[–-]\s*(\w+)\s*$/.exec(kit.name);
  return m ? m[1] : kit.name.split(/\s+/).slice(0, 2).join(' ');
}

export function rowsFromKit(kit: BeadKit | undefined): BeadRowDraft[] {
  return (kit?.beads ?? []).map((b) => ({ label: b.label ?? `${b.diameterNm} nm`, diameterNm: b.diameterNm, ri: b.ri, use: true, assign: null, ...('checkOnly' in b && b.checkOnly ? { fit: false } : {}) }));
}

export function guessSizeKit(name: string): string | null {
  const n = name.toLowerCase();
  if (/apogee/.test(n)) return /1527|80\s*nm/.test(n) ? 'apogee-1527' : 'apogee-1493';
  if (/megamix/.test(n)) return /ssc/.test(n) ? 'biocytex-megamix-plus-ssc' : 'biocytex-megamix-plus-fsc';
  if (/nanovis|nano[\s_-]?vis|sizing/.test(n)) {
    if (/\blow\b|[_\s-]low/.test(n)) return 'beckman-nanovis-low';
    if (/\bhigh\b|[_\s-]high/.test(n)) return 'beckman-nanovis-high';
    return 'beckman-nanovis-mix-appnote';
  }
  if (/size.*(bead|std|standard)|(bead|std|standard).*size|\bps\b.*nm/.test(n)) return 'custom-ps-size';
  return null;
}


/** Where the diameters / RIs of a bead set come from (judged over the beads in use). */
export function sizeValuesSource(kit: BeadKit | undefined, beads: Pick<BeadRowDraft, 'use' | 'edited'>[]): 'user' | 'kit-example' | 'kit-nominal' | 'mixed' {
  if (!kit || kit.valuesStatus === 'empty' || kit.valuesStatus === 'certificate') return 'user';
  const used = beads.filter((b) => b.use);
  const ed = used.filter((b) => b.edited).length;
  if (used.length && ed === used.length) return 'user';
  const base = kit.valuesStatus === 'example' ? 'kit-example' : 'kit-nominal';
  return ed === 0 ? base : base === 'kit-example' ? 'mixed' : 'kit-nominal';
}

/**
 * Assign detected peaks (ascending) to beads. Beads are matched from the brightest down (dim beads are the ones lost
 * in the noise); with `noise`, the lowest peak is the background population. Manual choices (`assign` of a bead,
 * peak index) override. Returns the peak index per bead (-1 = none) and the noise peak index (-1 = none).
 * @param signal expected signal per bead (any monotonic proxy, e.g. modelled cross section) for ordering
 */
export function assignPeaks(beads: Pick<BeadRowDraft, 'use' | 'assign'>[], signal: number[], nPeaks: number, noise: boolean): { assign: number[]; noisePeak: number; conflicts: [number, number, number][] } {
  const assign = beads.map(() => -1);
  const used = beads.map((b, i) => (b.use ? i : -1)).filter((i) => i >= 0);
  const order = [...used].sort((a, b) => signal[a] - signal[b]);
  const avail = nPeaks - (noise ? 1 : 0);
  const nAuto = Math.max(0, Math.min(order.length, avail));
  for (let j = 0; j < nAuto; j++) assign[order[order.length - 1 - j]] = nPeaks - 1 - j;
  beads.forEach((b, i) => {
    if (!b.use) assign[i] = -1;
    else if (b.assign !== null) assign[i] = b.assign >= 0 && b.assign < nPeaks ? b.assign : -1;
  });
  const conflicts: [number, number, number][] = [];
  const seen = new Map<number, number>();
  assign.forEach((p, i) => {
    if (p < 0) return;
    if (seen.has(p)) conflicts.push([p, seen.get(p)!, i]);
    else seen.set(p, i);
  });
  let noisePeak = noise && nPeaks > 0 ? 0 : -1;
  if (noisePeak >= 0 && seen.has(noisePeak)) noisePeak = -1;
  return { assign, noisePeak, conflicts };
}

/**
 * Pick the bead populations of a size kit among all detected peaks by the kit's brightness pattern: the measured
 * medians of the beads must follow their modelled signals with one factor (measured = F·σ). Real bead tubes often hold
 * more populations than beads (aggregates and doublets far above the beads, contaminating particles, a second noise
 * band), and the largest peaks by event count are then not always the beads: e.g. a nanoViS Low tube on a CytoFLEX LX
 * whose 80 nm bead sits in the noise and whose two largest peaks above the beads are aggregates.
 * Beads are matched from the brightest down, keeping their order; dim beads may stay unassigned when their predicted
 * signal lies in the noise. Score (lower is better): spread of log10(measured/σ) (0.12 decade ≈ 30 % counts as one
 * unit), beads left out although they should be well above the noise, and small peaks chosen over large ones.
 * @param peaks all detected peaks, ascending (median, events)
 * @param signal modelled signal per bead (any scale; only ratios matter)
 * @param used indices of the beads to place (in use, no manual peak)
 * @param noise the lowest peak is the background population
 * @returns peak index per bead (-1 = none) and the noise peak, or null when nothing can be matched
 */
export function matchBeadPattern(
  peaks: { median: number; count: number }[],
  signal: number[],
  used: number[],
  noise: boolean,
): { assign: number[]; noisePeak: number; score: number; spread: number } | null {
  const P = peaks.length;
  const order = [...used].filter((i) => signal[i] > 0).sort((a, b) => signal[a] - signal[b]);
  // the background: the lowest peak, unless that is a speck below a much larger noise band
  const total = peaks.reduce((a, p) => a + p.count, 0);
  const noisePeak = !noise || !P ? -1 : P > 1 && peaks[0].count < 0.02 * total && peaks[1].count > 10 * peaks[0].count ? 1 : 0;
  const first = noisePeak + 1;
  // candidates: the 14 largest peaks above the noise, in ascending order
  const cand = Array.from({ length: P - first }, (_, j) => first + j)
    .filter((j) => peaks[j].median > 0 && peaks[j].count > 0)
    .sort((a, b) => peaks[b].count - peaks[a].count)
    .slice(0, 14)
    .sort((a, b) => a - b);
  const m = order.length;
  if (!m || !cand.length) return null;
  const noiseLevel = noisePeak >= 0 ? peaks[noisePeak].median : peaks[cand[0]].median / 2;
  const counts = cand.map((j) => peaks[j].count).sort((a, b) => b - a);
  let best: { assign: number[]; score: number; spread: number } | null = null;
  const pick: number[] = [];
  const nMin = Math.max(1, m - 4);
  for (let n = Math.min(m, cand.length); n >= nMin; n--) {
    const beads = order.slice(m - n); // the n brightest, ascending
    const typical = counts[Math.floor((Math.min(n, counts.length) - 1) / 2)];
    const rec = (start: number, k: number) => {
      if (k === n) {
        const r = beads.map((b, i) => Math.log10(peaks[pick[i]].median) - Math.log10(signal[b]));
        const mean = r.reduce((a, v) => a + v, 0) / n;
        const sd = n > 1 ? Math.sqrt(r.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
        let score = (sd / 0.12) ** 2 + (n === 1 ? 1 : 0);
        const F = Math.pow(10, mean);
        for (const b of order.slice(0, m - n)) score += F * signal[b] > 2 * noiseLevel ? 4 : 0.3;
        for (const j of pick) score += 0.5 * Math.max(0, Math.log10(typical / peaks[j].count));
        if (!best || score < best.score - 1e-9) {
          const assign = signal.map(() => -1);
          beads.forEach((b, i) => (assign[b] = pick[i]));
          best = { assign, score, spread: sd };
        }
        return;
      }
      for (let c = start; c <= cand.length - (n - k); c++) {
        pick[k] = cand[c];
        rec(c + 1, k + 1);
      }
    };
    rec(0, 0);
  }
  const b = best as { assign: number[]; score: number; spread: number } | null;
  return b ? { ...b, noisePeak } : null;
}

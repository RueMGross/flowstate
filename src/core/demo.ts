// Synthetic example data (CytoFLEX-like 8-colour PBMC panel). Clearly labelled as example data in the UI.
import type { FcsChannel, FcsDataset } from './fcs';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_CHANNELS: { name: string; label: string }[] = [
  { name: 'FSC-A', label: '' },
  { name: 'FSC-H', label: '' },
  { name: 'SSC-A', label: '' },
  { name: 'FITC-A', label: 'CD3' },
  { name: 'PE-A', label: 'CD8' },
  { name: 'PC5.5-A', label: 'CD45' },
  { name: 'PC7-A', label: 'CD4' },
  { name: 'APC-A', label: 'CD69' },
  { name: 'PB450-A', label: 'CD19' },
  { name: 'KO525-A', label: 'Viability' },
  { name: 'Time', label: '' },
];

// fluorescence channels in matrix order and their spillover (rows: dye, cols: detector)
export const DEMO_SPILL_CHANNELS = ['FITC-A', 'PE-A', 'PC5.5-A', 'PC7-A', 'APC-A', 'PB450-A', 'KO525-A'];
export const DEMO_SPILL = [
  [1, 0.185, 0.032, 0.006, 0, 0, 0.012],
  [0.012, 1, 0.142, 0.034, 0.002, 0, 0],
  [0, 0.006, 1, 0.21, 0.065, 0, 0],
  [0, 0.004, 0.018, 1, 0.004, 0, 0],
  [0, 0, 0.115, 0.042, 1, 0, 0],
  [0.004, 0, 0, 0, 0, 1, 0.28],
  [0.06, 0.012, 0.002, 0, 0, 0.042, 1],
];

interface Pheno {
  frac: number;
  fsc: [number, number];
  ssc: [number, number];
  // median intensity per fluorescence marker (0 = negative)
  m: Partial<Record<'CD3' | 'CD8' | 'CD45' | 'CD4' | 'CD69' | 'CD19' | 'Viability', number>>;
  doubletOK?: boolean;
}

const MARKERS = ['CD3', 'CD8', 'CD45', 'CD4', 'CD69', 'CD19', 'Viability'] as const;

export interface DemoSampleSpec {
  name: string;
  events: number;
  seed: number;
  stim: number; // fraction of T cells CD69+
  cd4: number; // CD4 fraction among T cells
  unstained?: boolean;
}

export const DEMO_SAMPLES: DemoSampleSpec[] = [
  { name: 'Unstained', events: 20000, seed: 11, stim: 0, cd4: 0.6, unstained: true },
  { name: 'Donor A unstim', events: 40000, seed: 21, stim: 0.04, cd4: 0.62 },
  { name: 'Donor A stim', events: 40000, seed: 22, stim: 0.46, cd4: 0.6 },
  { name: 'Donor B unstim', events: 40000, seed: 31, stim: 0.05, cd4: 0.48 },
  { name: 'Donor B stim', events: 40000, seed: 32, stim: 0.38, cd4: 0.47 },
];

export function makeDemoDataset(spec: DemoSampleSpec): FcsDataset {
  const rnd = mulberry32(spec.seed);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const tcell = 0.68;
  const lymphCD8 = (1 - spec.cd4) * 0.82;
  const phenos: Pheno[] = [
    // lymphocytes: T CD4, T CD8, T DN, B, NK
    { frac: 0.52 * tcell * spec.cd4, fsc: [420000, 44000], ssc: [104000, 24000], m: { CD3: 26000, CD4: 15000, CD45: 52000 }, doubletOK: true },
    { frac: 0.52 * tcell * lymphCD8, fsc: [410000, 44000], ssc: [100000, 24000], m: { CD3: 24000, CD8: 30000, CD45: 52000 }, doubletOK: true },
    { frac: 0.52 * tcell * (1 - spec.cd4 - lymphCD8), fsc: [400000, 40000], ssc: [104000, 24000], m: { CD3: 21000, CD45: 50000 } },
    { frac: 0.52 * 0.15, fsc: [430000, 44000], ssc: [110000, 24000], m: { CD19: 12000, CD45: 48000 }, doubletOK: true },
    { frac: 0.52 * (1 - tcell - 0.15), fsc: [450000, 44000], ssc: [136000, 30000], m: { CD8: 2500, CD45: 50000 } },
    // monocytes
    { frac: 0.14, fsc: [660000, 70000], ssc: [340000, 70000], m: { CD4: 2600, CD45: 38000 }, doubletOK: true },
    // granulocytes
    { frac: 0.16, fsc: [600000, 64000], ssc: [760000, 120000], m: { CD45: 15000 } },
    // dead cells
    { frac: 0.07, fsc: [280000, 60000], ssc: [190000, 80000], m: { Viability: 18000, CD45: 9000 } },
    // debris
    { frac: 0.11, fsc: [90000, 50000], ssc: [60000, 50000], m: { Viability: 3000 } },
  ];
  const tot = phenos.reduce((a, p) => a + p.frac, 0);
  const n = spec.events;
  const chans = DEMO_CHANNELS.length;
  const data: Float32Array[] = Array.from({ length: chans }, () => new Float32Array(n));
  const cum: number[] = [];
  let acc = 0;
  for (const p of phenos) cum.push((acc += p.frac / tot));
  const fl = new Float64Array(MARKERS.length);
  for (let e = 0; e < n; e++) {
    const r = rnd();
    let k = 0;
    while (k < cum.length - 1 && r > cum[k]) k++;
    const ph = phenos[k];
    let fsc = Math.max(2000, ph.fsc[0] + gauss() * ph.fsc[1]);
    let ssc = Math.max(500, ph.ssc[0] + gauss() * ph.ssc[1]);
    let fscH = fsc * (0.86 + gauss() * 0.025);
    const doublet = ph.doubletOK && rnd() < 0.045;
    // true marker intensities
    for (let i = 0; i < MARKERS.length; i++) {
      const mk = MARKERS[i];
      let med = spec.unstained ? 0 : ph.m[mk] ?? 0;
      if (mk === 'CD69' && !spec.unstained && (k === 0 || k === 1) && rnd() < spec.stim) med = 9000;
      if (mk === 'CD69' && !spec.unstained && k === 4 && rnd() < spec.stim * 0.5) med = 6000;
      const auto = (k >= 5 ? 900 : 180) * (1 + 0.3 * gauss());
      fl[i] = med > 0 ? Math.exp(Math.log(med) + 0.32 * gauss()) + auto : auto;
    }
    if (doublet) {
      fsc *= 1.85 + 0.1 * gauss();
      fscH *= 1.08;
      ssc *= 1.7;
      for (let i = 0; i < fl.length; i++) fl[i] *= 1.9;
    }
    data[0][e] = fsc;
    data[1][e] = fscH;
    data[2][e] = ssc;
    // spill + detector noise
    for (let d = 0; d < MARKERS.length; d++) {
      let v = 0;
      for (let s = 0; s < MARKERS.length; s++) v += fl[s] * DEMO_SPILL[s][d];
      v += gauss() * (110 + Math.sqrt(Math.max(v, 0)) * 3.2);
      data[3 + d][e] = v;
    }
    data[10][e] = (e / n) * 600 * 100; // 60 s, 10 ms ticks
  }
  const channels: FcsChannel[] = DEMO_CHANNELS.map((c, i) => ({
    index: i,
    name: c.name,
    label: c.label,
    range: c.name === 'Time' ? 60000 : 1048576,
    bits: 32,
    logDecades: 0,
    logOffset: 0,
    gain: 1,
    displayHint: '',
  }));
  const kw: Record<string, string> = {
    $CYT: 'Synthetic example cytometer',
    $DATE: '11-Oct-2026',
    $FIL: spec.name + '.fcs',
    $SRC: 'FlowState example data',
    'TUBE NAME': spec.name,
    $TOT: String(n),
    $PAR: String(chans),
    $DATATYPE: 'F',
    $TIMESTEP: '0.01',
  };
  channels.forEach((c, i) => {
    kw[`$P${i + 1}N`] = c.name;
    if (c.label) kw[`$P${i + 1}S`] = c.label;
    kw[`$P${i + 1}R`] = String(c.range);
  });
  kw['$SPILLOVER'] = [DEMO_SPILL_CHANNELS.length, ...DEMO_SPILL_CHANNELS, ...DEMO_SPILL.flat()].join(',');
  return { version: 'FCS3.1', keywords: kw, channels, eventCount: n, data, warnings: [] };
}

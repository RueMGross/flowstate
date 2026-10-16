// Bead kit presets (data only) for scatter-size calibration and fluorescence (MESF/ERF) calibration.
//
// IMPORTANT: intensity-bead values (and often exact bead diameters) are LOT-SPECIFIC. Values marked
// valuesStatus 'example' are typical numbers from one published lot and must not be used for calibration; the UI must
// ask for the certificate values of the user's lot (enterLotValues = true). 'empty' templates have null values.
import type { RISpec } from './mie';
import type { ScatterBead } from './scattercal';

export type BeadUnit = 'MESF' | 'ERF' | 'MEFL' | 'MEPE' | 'ABC' | 'nm';

/** How trustworthy the stored values are. */
export type ValuesStatus = 'nominal' | 'certificate' | 'example' | 'empty';

export interface SizeBead extends ScatterBead {
  material: 'polystyrene' | 'silica' | string;
  /** certificate SD of the diameter (nm), if known */
  sdNm?: number;
  /** fluorescent bead (can be gated on fluorescence) */
  fluorescent?: boolean;
  /** detected and sized back as a check, but left out of the fit by default (e.g. a bead whose nominal size is doubtful) */
  checkOnly?: boolean;
}

export interface IntensityChannelValues {
  /** fluorochrome or detector the values refer to (e.g. 'FITC', 'PE', 'APC', 'FL1') */
  fluorochrome: string;
  unit: BeadUnit;
  /** display label for units outside BeadUnit (e.g. 'MEPCY', 'MEAP') */
  unitLabel?: string;
  /** one value per population, aligned with BeadKit.populations; blank = 0; null = enter lot value */
  values: (number | null)[];
}

export interface BeadKit {
  id: string;
  name: string;
  vendor: string;
  catalog?: string;
  kind: 'size' | 'intensity';
  /** main unit ('nm' for size kits) */
  unit: BeadUnit;
  /** size kits: beads (diameter, RI) */
  beads?: SizeBead[];
  /** intensity kits: population labels in ascending intensity (blank first if the kit has one) */
  populations?: string[];
  /** intensity kits: reference values per fluorochrome/channel */
  channels?: IntensityChannelValues[];
  /** values vary from lot to lot (certificate needed) */
  lotSpecific: boolean;
  valuesStatus: ValuesStatus;
  /** the UI must ask the user for the values of their lot before calibrating */
  enterLotValues: boolean;
  note: string;
  source?: string;
}

const PS: RISpec = { material: 'polystyrene' };
const ps = (d: number, extra: Partial<SizeBead> = {}): SizeBead => ({ diameterNm: d, ri: PS, material: 'polystyrene', label: `PS ${d} nm`, ...extra });
/** silica with the dispersion of fused silica shifted to a stated RI at a reference wavelength */
const silica = (d: number, n: number, atNm: number, extra: Partial<SizeBead> = {}): SizeBead => ({
  diameterNm: d,
  ri: { material: 'silica', n, atNm },
  material: 'silica',
  label: `Silica ${d} nm`,
  ...extra,
});

export const BEAD_KITS: BeadKit[] = [
  // ------------------------------------------------------------ scatter / size
  {
    id: 'beckman-nanovis-low',
    name: 'nanoViS Nanoscale Sizing Standards – Low',
    vendor: 'Beckman Coulter',
    catalog: 'D03231 (nanoViS kit; verify part number)',
    kind: 'size',
    unit: 'nm',
    beads: [ps(40, { checkOnly: true }), ps(80), ps(108), ps(142)],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: "Polystyrene, scatter only (CytoFLEX nano, VSSC 405 nm). Nominal diameters as reported in bioRxiv 10.64898/2025.12.15.694348; Beckman's CytoFLEX nano application note gives 44 nm for the smallest bead, so it is sized back as a check and left out of the fit by default. Replace with the certificate means/CVs of your lot if available. Low beads alone (all in the Rayleigh range) hardly constrain the collection half-angle: calibrate on VSSC1 with a fixed half-angle, or together with nanoViS High on VSSC2.",
    source: 'https://www.biorxiv.org/content/10.64898/2025.12.15.694348v1',
  },
  {
    id: 'beckman-nanovis-high',
    name: 'nanoViS Nanoscale Sizing Standards – High',
    vendor: 'Beckman Coulter',
    catalog: 'D03231 (nanoViS kit; verify part number)',
    kind: 'size',
    unit: 'nm',
    beads: [ps(142), ps(304), ps(600), ps(1020)],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'Polystyrene, scatter only. Nominal diameters (bioRxiv 10.64898/2025.12.15.694348). Combine with the Low set (142 nm is shared) for a 40–1020 nm calibration; large beads constrain the collection angle through Mie resonances. On a CytoFLEX nano the 304 to 1020 nm beads saturate VSSC1: measure this set on VSSC2 (SSC_1-A; one half-angle, a factor per detector).',
    source: 'https://www.biorxiv.org/content/10.64898/2025.12.15.694348v1',
  },
  {
    id: 'beckman-nanovis-mix-appnote',
    name: 'nanoViS polystyrene mix (application-note sizes)',
    vendor: 'Beckman Coulter',
    kind: 'size',
    unit: 'nm',
    beads: [ps(44), ps(80), ps(100), ps(144), ps(300), ps(600), ps(1000)],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'Sizes listed in the Beckman CytoFLEX nano application note ("44 nm, 80 nm, 100 nm, 144 nm, 300 nm, 600 nm, and 1 µm"). Nominal values; check your certificate.',
    source: 'https://www.beckman.com/resources/reading-material/application-notes/cytoflex-nano-flow-cytometer-the-new-approach-to-nanoscale-flow-cytometry',
  },
  {
    id: 'apogee-1493',
    name: 'ApogeeMix (silica + polystyrene)',
    vendor: 'Apogee Flow Systems',
    catalog: '1493',
    kind: 'size',
    unit: 'nm',
    beads: [
      ps(110, { ri: { material: 'polystyrene', n: 1.59, atNm: 589 }, fluorescent: true }),
      silica(180, 1.43, 589),
      silica(240, 1.43, 589),
      silica(300, 1.43, 589),
      ps(500, { ri: { material: 'polystyrene', n: 1.59, atNm: 589 }, fluorescent: true }),
      silica(590, 1.43, 589),
      silica(880, 1.43, 589),
      silica(1300, 1.43, 589),
    ],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'Non-fluorescent silica (RI 1.43) 180/240/300/590/880/1300 nm plus green-fluorescent polystyrene (RI 1.59) 110/500 nm, per the Apogee product page. The RI wavelength is not stated: modelled as the fused-silica / polystyrene dispersion shifted to 1.43 / 1.59 at 589 nm. (Cat. 1517 could not be verified; 1527 = 1493 + 80 nm PS.)',
    source: 'https://www.apogeeflow.com/apogee-mix.php',
  },
  {
    id: 'apogee-1527',
    name: 'ApogeeMix with 80 nm PS',
    vendor: 'Apogee Flow Systems',
    catalog: '1527',
    kind: 'size',
    unit: 'nm',
    beads: [
      ps(80, { ri: { material: 'polystyrene', n: 1.59, atNm: 589 }, fluorescent: true }),
      ps(110, { ri: { material: 'polystyrene', n: 1.59, atNm: 589 }, fluorescent: true }),
      silica(180, 1.43, 589),
      silica(240, 1.43, 589),
      silica(300, 1.43, 589),
      ps(500, { ri: { material: 'polystyrene', n: 1.59, atNm: 589 }, fluorescent: true }),
      silica(590, 1.43, 589),
      silica(880, 1.43, 589),
      silica(1300, 1.43, 589),
    ],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'As ApogeeMix 1493 plus 80 nm green-fluorescent polystyrene (Apogee product page).',
    source: 'https://www.apogeeflow.com/apogee-mix.php',
  },
  {
    id: 'biocytex-megamix-plus-fsc',
    name: 'Megamix-Plus FSC',
    vendor: 'BioCytex / Stago',
    catalog: '01077 (Stago)',
    kind: 'size',
    unit: 'nm',
    beads: [ps(100, { fluorescent: true }), ps(300, { fluorescent: true }), ps(500, { fluorescent: true }), ps(900, { fluorescent: true })],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'Fluorescent polystyrene beads, nominal 0.1/0.3/0.5/0.9 µm. Actual diameters can differ substantially from nominal; prefer measured/certificate sizes.',
    source: 'https://stago-com.infogene.fr/products-services/new-products/detail/article/megamix-line-expand-the-limits-of-mp-analysis-with-2/',
  },
  {
    id: 'biocytex-megamix-plus-ssc',
    name: 'Megamix-Plus SSC',
    vendor: 'BioCytex / Stago',
    catalog: '01078 (Stago)',
    kind: 'size',
    unit: 'nm',
    beads: [ps(160, { fluorescent: true }), ps(200, { fluorescent: true }), ps(240, { fluorescent: true }), ps(500, { fluorescent: true })],
    lotSpecific: true,
    valuesStatus: 'nominal',
    enterLotValues: false,
    note: 'Fluorescent polystyrene beads, nominal 0.16/0.2/0.24/0.5 µm. Actual diameters can differ from nominal.',
    source: 'https://stago-com.infogene.fr/products-services/new-products/detail/article/megamix-line-expand-the-limits-of-mp-analysis-with-2/',
  },
  {
    id: 'welsh2020-nist-set',
    name: 'NIST-traceable PS + silica set (Welsh et al. 2020, Table 1)',
    vendor: 'Thermo Fisher (NIST-traceable size standards)',
    kind: 'size',
    unit: 'nm',
    beads: [
      ps(203, { sdNm: 5, ri: { material: 'polystyrene', n: 1.59, atNm: 589 } }),
      ps(400, { sdNm: 7, ri: { material: 'polystyrene', n: 1.59, atNm: 589 } }),
      ps(707, { sdNm: 8, ri: { material: 'polystyrene', n: 1.59, atNm: 589 } }),
      ps(1019, { sdNm: 10, ri: { material: 'polystyrene', n: 1.59, atNm: 589 } }),
      ps(1587, { sdNm: 21, ri: { material: 'polystyrene', n: 1.59, atNm: 589 } }),
      silica(490, 1.45, 589, { sdNm: 20 }),
      silica(730, 1.45, 589, { sdNm: 30 }),
      silica(990, 1.46, 589, { sdNm: 20 }),
      silica(1570, 1.46, 589, { sdNm: 40 }),
    ],
    lotSpecific: true,
    valuesStatus: 'example',
    enterLotValues: true,
    note: 'Certificate values of the specific lots used in Welsh et al., Cytometry A 2020 (RI stated at 589 nm). Your lots differ: enter your certificate means and SDs.',
    source: 'https://doi.org/10.1002/cyto.a.23782',
  },
  {
    id: 'custom-ps-size',
    name: 'Polystyrene size standards (custom)',
    vendor: 'any (e.g. Thermo Scientific Nanosphere 3000 series)',
    kind: 'size',
    unit: 'nm',
    beads: [],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: add your NIST-traceable polystyrene bead diameters (certificate mean, SD/CV). RI follows the Sultanova polystyrene dispersion.',
  },
  {
    id: 'spherotech-nfpps-52-4k',
    name: 'SPHERO Nano Fluorescent Size Standard Kit, Yellow (4 sizes)',
    vendor: 'Spherotech',
    catalog: 'NFPPS-52-4K (verify the part number)',
    kind: 'size',
    unit: 'nm',
    beads: [],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: yellow fluorescent polystyrene nanoparticles in four vials sold as size ranges (0.1-0.3, 0.4-0.6, 0.7-0.9 and 1.0-1.9 µm). The ranges are not diameters: add each bead with the mean diameter (and SD) from your lot certificate.',
    source: 'Spherotech catalog (Nano Fluorescent Size Standard Kit, NFPPS-52-4K; single sizes NFPPS-0252-5 to NFPPS-1552-5)',
  },
  {
    id: 'custom-silica-size',
    name: 'Silica size standards (custom)',
    vendor: 'any',
    kind: 'size',
    unit: 'nm',
    beads: [],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: add silica bead diameters and the certificate RI with its wavelength (colloidal silica is often 1.42–1.46, lower than fused silica 1.458 at 589 nm).',
  },

  // ------------------------------------------------------------ fluorescence intensity
  {
    id: 'spherotech-rcp-30-5a',
    name: 'SPHERO Rainbow Calibration Particles, 8 peaks (3.0–3.4 µm)',
    vendor: 'Spherotech',
    catalog: 'RCP-30-5A',
    kind: 'intensity',
    unit: 'MEFL',
    populations: ['Blank', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'],
    channels: [
      // Example lot values as used in the FlowCal documentation (Castillo-Hair et al. 2016) – NOT your lot.
      { fluorochrome: 'FITC', unit: 'MEFL', values: [0, 792, 2079, 6588, 16471, 47497, 137049, 271647] },
      { fluorochrome: 'PE', unit: 'MEPE', values: [0, null, null, null, null, null, null, null] },
      { fluorochrome: 'PE-Cy5', unit: 'ERF', unitLabel: 'MEPCY', values: [0, null, null, null, null, null, null, null] },
      { fluorochrome: 'APC', unit: 'ERF', unitLabel: 'MEAP', values: [0, null, null, null, null, null, null, null] },
    ],
    lotSpecific: true,
    valuesStatus: 'example',
    enterLotValues: true,
    note: 'Enter your lot values from the Spherotech certificate (per channel/fluorochrome). The FITC row holds EXAMPLE values of one lot (FlowCal tutorial) for testing only. Spherotech MEF values are relative to the listed fluorochrome; non-matching dyes give "equivalent" units (ERF).',
    source: 'https://github.com/taborlab/FlowCal',
  },
  {
    id: 'spherotech-urcp-38-2k',
    name: 'SPHERO Ultra Rainbow Calibration Particles, 6 peaks (3.8 µm)',
    vendor: 'Spherotech',
    catalog: 'URCP-38-2K',
    kind: 'intensity',
    unit: 'MEFL',
    populations: ['Blank', 'P2', 'P3', 'P4', 'P5', 'P6'],
    channels: [
      { fluorochrome: 'FITC', unit: 'MEFL', values: [0, null, null, null, null, null] },
      { fluorochrome: 'PE', unit: 'MEPE', values: [0, null, null, null, null, null] },
      { fluorochrome: 'APC', unit: 'ERF', unitLabel: 'MEAP', values: [0, null, null, null, null, null] },
    ],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: enter your lot certificate values. Adjust the number of peaks if your certificate differs (Ultra Rainbow particles are listed as 6 peaks, 3.8 or 5.1 µm).',
  },
  {
    id: 'polyan-scb-nanobeads-4',
    name: 'PolyAn Spectrum Calibration Nanobeads, 4 populations (PMMA, 100-525 nm)',
    vendor: 'PolyAn',
    catalog: '208 12 xxx (carboxy; size code 125, 225 or 500; verify)',
    kind: 'intensity',
    unit: 'ERF',
    populations: ['P1', 'P2', 'P3', 'P4'],
    channels: [
      { fluorochrome: 'FITC', unit: 'ERF', values: [null, null, null, null] },
      { fluorochrome: 'PE', unit: 'ERF', values: [null, null, null, null] },
      { fluorochrome: 'APC', unit: 'ERF', values: [null, null, null, null] },
    ],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: fluorescent PMMA nanobeads with four intensity populations (lowest first; the lowest may be unlabelled: enter 0 for a blank), sizes 100-150, 201-250 or 475-525 nm. PolyAn lists no MESF / ERF values: enter the values of your lot certificate if it gives them; relative intensities only allow a relative scale.',
    source: 'https://www.poly-an.de/micro-nanoparticles/calibration-imaging-tools/spectrum-calibration-nanobeads',
  },
  {
    id: 'bd-quantibrite-pe',
    name: 'BD Quantibrite PE beads',
    vendor: 'BD Biosciences',
    catalog: '340495',
    kind: 'intensity',
    unit: 'MEPE',
    populations: ['Low', 'Medium-low', 'Medium-high', 'High'],
    channels: [{ fluorochrome: 'PE', unit: 'MEPE', unitLabel: 'PE molecules/bead', values: [1700, 14200, 39400, 133400] }],
    lotSpecific: true,
    valuesStatus: 'example',
    enterLotValues: true,
    note: 'Four PE levels, no blank bead. Values are PE molecules per bead and differ per lot: the numbers here are EXAMPLES – enter the values printed on your lot. With 1:1 PE:antibody conjugates, PE molecules/cell ≈ antibodies bound (ABC).',
  },
  ...(
    [
      ['555', 'FITC', 5],
      ['827', 'PE', 4],
      ['823', 'APC', 4],
      ['488', 'Alexa Fluor 488', 4],
      ['647', 'Alexa Fluor 647', 4],
      ['828', 'PE-Cy5', 4],
      ['822', 'Cy5', 4],
    ] as const
  ).map(
    ([cat, fl, nLab]): BeadKit => ({
      id: `bangs-quantum-mesf-${cat}`,
      name: `Quantum ${fl}${cat === '555' ? '-5' : ''} MESF`,
      vendor: 'Bangs Laboratories (Polysciences)',
      catalog: cat,
      kind: 'intensity',
      unit: 'MESF',
      populations: ['Blank', ...Array.from({ length: nLab }, (_, i) => `L${i + 1}`)],
      channels: [{ fluorochrome: fl, unit: 'MESF', values: [0, ...Array<number | null>(nLab).fill(null)] }],
      lotSpecific: true,
      valuesStatus: 'empty',
      enterLotValues: true,
      note: `Template: blank + ${nLab} ${fl}-labelled populations calibrated in MESF; enter the MESF values from your lot certificate / QuickCal template.`,
      source: 'Bangs Laboratories PDS 821 (Quantum MESF kits)',
    }),
  ),
  {
    id: 'bangs-quantum-simply-cellular',
    name: 'Quantum Simply Cellular (antibody binding capacity)',
    vendor: 'Bangs Laboratories (Polysciences)',
    kind: 'intensity',
    unit: 'ABC',
    populations: ['Blank', 'L1', 'L2', 'L3', 'L4'],
    channels: [{ fluorochrome: 'any (stained with the test antibody)', unit: 'ABC', values: [0, null, null, null, null] }],
    lotSpecific: true,
    valuesStatus: 'empty',
    enterLotValues: true,
    note: 'Template: beads capture the labelled antibody; enter the ABC values of your lot (anti-mouse or anti-human variant).',
  },
];

/** All kits, optionally filtered by kind. */
export function listBeadKits(kind?: BeadKit['kind']): BeadKit[] {
  return kind ? BEAD_KITS.filter((k) => k.kind === kind) : BEAD_KITS.slice();
}

export function getBeadKit(id: string): BeadKit | undefined {
  return BEAD_KITS.find((k) => k.id === id);
}

/** Scatter beads of a size kit (for fitCollectionAngle). */
export function kitScatterBeads(kit: BeadKit): ScatterBead[] {
  return (kit.beads ?? []).map((b) => ({ diameterNm: b.diameterNm, ri: b.ri, cvPct: b.cvPct ?? (b.sdNm ? (100 * b.sdNm) / b.diameterNm : undefined), label: b.label }));
}

/** Reference values of an intensity kit for one fluorochrome (case-insensitive), or undefined. */
export function kitReferenceValues(kit: BeadKit, fluorochrome: string): IntensityChannelValues | undefined {
  const f = fluorochrome.toLowerCase();
  return kit.channels?.find((c) => c.fluorochrome.toLowerCase() === f);
}

/**
 * Problems that must be resolved before a kit's values may be used for calibration
 * (missing values, example values, nominal sizes). Empty array = ready.
 */
export function kitValueWarnings(kit: BeadKit, fluorochrome?: string): string[] {
  const w: string[] = [];
  if (kit.valuesStatus === 'example') w.push('values are examples from another lot – enter the certificate values of your lot');
  if (kit.valuesStatus === 'nominal') w.push('nominal values – use certificate values if available');
  if (kit.kind === 'size' && !(kit.beads && kit.beads.length)) w.push('no beads entered');
  if (kit.kind === 'intensity') {
    const ch = fluorochrome ? kitReferenceValues(kit, fluorochrome) : kit.channels?.[0];
    if (!ch) w.push(`no values for ${fluorochrome ?? 'any channel'}`);
    else if (ch.values.some((v) => v === null)) w.push(`missing lot values for ${ch.fluorochrome}`);
  }
  return w;
}

/**
 * Copy of an intensity kit with the user's lot values for one fluorochrome (marks the kit 'certificate').
 * `values` must have one entry per population.
 */
export function withLotValues(kit: BeadKit, fluorochrome: string, values: number[], lot?: string): BeadKit {
  if (!kit.populations || values.length !== kit.populations.length) throw new Error(`expected ${kit.populations?.length ?? 0} values`);
  const channels = (kit.channels ?? []).map((c) => (c.fluorochrome.toLowerCase() === fluorochrome.toLowerCase() ? { ...c, values: values.slice() } : c));
  if (!channels.some((c) => c.fluorochrome.toLowerCase() === fluorochrome.toLowerCase())) channels.push({ fluorochrome, unit: kit.unit, values: values.slice() });
  return { ...kit, id: `${kit.id}${lot ? `-lot-${lot}` : '-user'}`, channels, valuesStatus: 'certificate', enterLotValues: false, note: `${kit.note}${lot ? ` Lot ${lot}.` : ''}` };
}

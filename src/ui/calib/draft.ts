// Working state of the calibration pages (not part of the workspace; survives switching views).
// Applied calibrations live in Workspace.derived and carry their provenance.
import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import type { RISpec } from '../../core/mie';
import type { CollectionGeometry } from '../../core/scattercal';
import { GEOMETRY_PRESETS, type GeomPreset, type ModelDraft } from './util';

export type FitMethodMesf = 'log' | 'weightedLog' | 'linear';

export interface MesfChanDraft {
  channel: string;
  /** kit channel (fluorochrome) whose values were loaded; '' = none */
  fluor: string;
  /** reference value per population (blank = 0, null = missing) */
  refs: (number | null)[];
  /** per population: the value was typed by the user */
  edited: boolean[];
  unit: string;
  /** population is in the file (counts for the number of peaks to find) */
  present: boolean[];
  /** population is left out of the regression */
  excluded: boolean[];
  /**
   * per population: use it in the regression although it is flagged as saturated (beadSaturation); saturated beads are
   * left out by default. Unset / false = default.
   */
  keepSaturated?: boolean[];
  /** manual peak windows [lo, hi) in raw units; null = automatic detection */
  windows: [number, number][] | null;
  method: FitMethodMesf;
  /** derived definition being edited */
  editId?: string;
}

export interface MesfDraft {
  sampleId: string | null;
  population: string;
  kitId: string;
  /** population labels of a custom kit */
  customLabels: string[];
  lot: string;
  chans: MesfChanDraft[];
  active: number;
  applyAll: boolean;
  applyIds: string[];
}

export interface BeadRowDraft {
  label: string;
  diameterNm: number;
  ri: RISpec;
  /** counts as a population to detect and fit */
  use: boolean;
  /** false: detected and sized back as a check, not used in the fit (default true) */
  fit?: boolean;
  /** manual peak index (sorted ascending), null = automatic */
  assign: number | null;
  /** diameter or RI typed by the user (certificate value) */
  edited?: boolean;
}

export interface BeadSetDraft {
  id: string;
  sampleId: string | null;
  population: string;
  kitId: string;
  beads: BeadRowDraft[];
  /** detect an extra background (noise) population below the beads */
  noise: boolean;
  lot?: string;
  windows: [number, number][] | null;
  /** scatter channel of this bead set; unset = the calibration channel of step 1 (e.g. nanoViS High on VSSC2) */
  channel?: string;
}

export interface SizeDraft {
  channel: string;
  wavelength: number;
  nMedium: number;
  nAuto: boolean;
  preset: GeomPreset;
  geometry: CollectionGeometry;
  sets: BeadSetDraft[];
  activeSet: number;
  method: 'cv' | 'lsq' | 'fixed';
  sweep: [number, number];
  model: ModelDraft;
  /** manual inversion range */
  rangeOn: boolean;
  rangeNm: [number, number];
  /** without a manual range: start the inversion at the noise-equivalent diameter when a noise population is known */
  rangeAuto: boolean;
  /** the valid range ends where the log-log slope of σ(d) falls below this */
  minSlope: number;
  sigmaOut: boolean;
  /** channels to create size outputs for (unset = the step-1 channel); each gets its own factor from its bead sets */
  outChannels?: string[];
  applyAll: boolean;
  applyIds: string[];
  editId?: string;
}

interface CalibStore {
  mesf: MesfDraft;
  size: SizeDraft;
  setMesf: (f: (d: Draft<MesfDraft>) => void) => void;
  setSize: (f: (d: Draft<SizeDraft>) => void) => void;
  resetMesf: () => void;
  resetSize: () => void;
}

let setCounter = 0;
export const newSetId = () => `set${++setCounter}`;

export function emptyMesf(): MesfDraft {
  return { sampleId: null, population: 'root', kitId: '', customLabels: ['Blank', 'P1', 'P2', 'P3', 'P4'], lot: '', chans: [], active: 0, applyAll: true, applyIds: [] };
}

export function emptySize(): SizeDraft {
  const p = GEOMETRY_PRESETS[0];
  return {
    channel: '',
    wavelength: 405,
    nMedium: 1.34309,
    nAuto: true,
    preset: p.id,
    geometry: { ...p.geometry },
    sets: [],
    activeSet: 0,
    method: 'cv',
    sweep: [5, 90],
    model: { kind: 'ev', core: 1.38, shell: 1.48, shellNm: 5, refNm: 488 },
    rangeOn: false,
    rangeNm: [40, 1000],
    rangeAuto: true,
    minSlope: 0.5,
    sigmaOut: true,
    applyAll: true,
    applyIds: [],
  };
}

export const useCalib = create<CalibStore>((set) => ({
  mesf: emptyMesf(),
  size: emptySize(),
  setMesf: (f) => set((s) => ({ mesf: produce(s.mesf, f) })),
  setSize: (f) => set((s) => ({ size: produce(s.size, f) })),
  resetMesf: () => set({ mesf: emptyMesf() }),
  resetSize: () => set({ size: emptySize() }),
}));

// MACSPlex Exosome Kit, human: the 39 capture bead populations (37 markers and 2 isotype controls) and the bead roles
// the method uses. Bead positions are NOT stored here: they depend on the instrument and its settings, so they come
// from the user's own template (a CytExpert .xit imported into FlowState, gates drawn in FlowState, or a pasted
// template made by the Python reference from a .xit).

export const KIT_BEADS = [
  'CD3',
  'CD4',
  'CD19',
  'CD8',
  'HLA-DRDPDQ',
  'CD56',
  'CD105',
  'CD2',
  'CD1c',
  'CD25',
  'CD49e',
  'ROR1',
  'CD209',
  'CD9',
  'SSEA-4',
  'HLA-ABC',
  'CD63',
  'CD40',
  'CD62P',
  'CD11c',
  'CD81',
  'MCSP',
  'CD146',
  'CD41b',
  'CD42a',
  'CD24',
  'CD86',
  'CD44',
  'CD326',
  'CD133-1',
  'CD29',
  'CD69',
  'CD142',
  'CD45',
  'CD31',
  'REA control',
  'CD20',
  'CD14',
  'mIgG1 control',
] as const;

/** Beads whose mean the markers are normalized to (method D9). */
export const TETRASPANINS = ['CD9', 'CD63', 'CD81'];
/** Isotype control beads (method D7 model B, QC flag negative_isotype). */
export const ISOTYPES = ['REA control', 'mIgG1 control'];

/** Parameters as CytExpert names them ($PnS on the CytoFLEX); found in the samples with fs.findChannel. */
export const DEFAULT_REPORTER = 'R660-APC-A';
export const SINGLES_NAME = 'Single beads';

/** Template bead names that are not kit names (e.g. a typo in a CytExpert template): for a note, never an error. */
export function unknownBeadNames(names: string[]): string[] {
  const kit = new Set<string>(KIT_BEADS);
  return names.filter((n) => !kit.has(n));
}

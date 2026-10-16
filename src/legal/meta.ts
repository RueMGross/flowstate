// Project metadata shown in the About dialog and on the start screen.
import { version } from '../../package.json';

export const APP_VERSION: string = version;

/** SPDX identifier of FlowState's own license (full text: LICENSE). */
export const APP_LICENSE: string | null = 'AGPL-3.0-only';

/** Development stage, shown next to the name and version. */
export const APP_STAGE = 'Beta';

/** Copyright line. */
export const APP_COPYRIGHT: string | null = 'Copyright (C) 2026 Rüdiger Groß, Institute of Molecular Virology, Ulm University Medical Center';

/** Public repository (source code), once published; until then the source is available on request. */
export const APP_URL: string | null = null;

/** Author and contact, shown in About and on the start screen. */
export const APP_AUTHOR = 'Dr. Rüdiger Groß';
/** Affiliation, one line each (About dialog, README). */
export const APP_AFFILIATION: readonly string[] = ['Institute of Molecular Virology', 'Ulm University Medical Center, Germany'];
export const APP_CONTACT_EMAIL = 'flow@nanoscale.app';

/** mailto link to the contact address; the subject carries the version (useful for bug reports). */
export function contactMailto(topic = 'Feedback'): string {
  return `mailto:${APP_CONTACT_EMAIL}?subject=${encodeURIComponent(`FlowState ${APP_VERSION}: ${topic}`)}`;
}

/** Companies whose products FlowState names (file formats, instruments, reagents); used in the trademark notice. */
export const NAMED_COMPANIES = [
  'Beckman Coulter',
  'Becton, Dickinson and Company (BD) and FlowJo, LLC',
  'Cytek Biosciences',
  'Thermo Fisher Scientific',
  'Inivai Technologies (FlowLogic)',
  'De Novo Software (FCS Express)',
  'Miltenyi Biotec',
  'Sony Biotechnology',
  'Apogee Flow Systems',
  'Spherotech',
  'Bangs Laboratories / Polysciences',
  'BioCytex / Stago',
];

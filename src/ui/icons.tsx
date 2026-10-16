import type { ReactElement } from 'react';
import { LogoMark } from './Logo';

const S = (children: ReactElement | ReactElement[], vb = '0 0 24 24') => (
  <svg viewBox={vb} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  spectrum: () => S([<path key="a" d="M3 19c2 0 3-9 5-9s2 6 4 6 2-12 4-12 3 15 5 15" />, <path key="b" d="M3 21h18" />]),
  ruler: () => S([<circle key="a" cx="6" cy="8" r="2" />, <circle key="b" cx="12" cy="8" r="3" />, <circle key="c" cx="19" cy="8" r="2.5" />, <path key="d" d="M3 17h18M6 15v4M10 16v2M14 15v4M18 16v2" />]),
  beads: () => S([<circle key="a" cx="7" cy="14" r="3" />, <circle key="b" cx="15" cy="9" r="4" />, <path key="c" d="M3 21h18" />]),
  logo: () => <LogoMark small />,
  open: () => S([<path key="a" d="M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />, <path key="b" d="M3 7V5h6l2 2" />]),
  fcs: () => S([<path key="a" d="M6 3h8l4 4v14H6z" />, <path key="b" d="M14 3v4h4" />, <circle key="c" cx="10" cy="15" r="1" />, <circle key="d" cx="13" cy="12" r="1" />, <circle key="e" cx="14" cy="16" r="1" />]),
  save: () => S([<path key="a" d="M5 4h11l3 3v13H5z" />, <path key="b" d="M8 4v5h7V4" />, <rect key="c" x="8" y="13" width="8" height="5" />]),
  bundle: () => S([<rect key="a" x="4" y="4" width="16" height="16" rx="2" />, <path key="b" d="M12 4v4M12 10v2M12 14v2" />, <rect key="c" x="10.5" y="16" width="3" height="3" />]),
  undo: () => S([<path key="a" d="M9 14L4 9l5-5" />, <path key="b" d="M4 9h11a5 5 0 0 1 0 10h-3" />]),
  redo: () => S([<path key="a" d="M15 14l5-5-5-5" />, <path key="b" d="M20 9H9a5 5 0 0 0 0 10h3" />]),
  cursor: () => S([<path key="a" d="M6 3l12 9-5.5 1.2L15 20l-2.5 1-2.6-6.6L6 17z" />]),
  polygon: () => S([<path key="a" d="M5 8l6-4 8 5-3 9-9 1z" />, <circle key="b" cx="5" cy="8" r="1.3" fill="currentColor" />, <circle key="c" cx="19" cy="9" r="1.3" fill="currentColor" />, <circle key="d" cx="16" cy="18" r="1.3" fill="currentColor" />]),
  rect: () => S([<rect key="a" x="4" y="6" width="16" height="12" rx="0.5" />]),
  ellipse: () => S([<ellipse key="a" cx="12" cy="12" rx="8.5" ry="5.5" transform="rotate(-25 12 12)" />]),
  quadrant: () => S([<rect key="a" x="4" y="4" width="16" height="16" />, <path key="b" d="M11 4v16M4 13h16" />]),
  range: () => S([<path key="a" d="M3 19c3 0 3-10 6-10s3 10 6 10 3-6 6-6" />, <path key="b" d="M7 5h10M7 3.5v3M17 3.5v3" />]),
  split: () => S([<path key="a" d="M3 19c3 0 3-10 6-10s3 10 6 10 3-6 6-6" />, <path key="b" d="M12 3v18" strokeDasharray="2 2" />]),
  text: () => S([<path key="a" d="M5 6V4h14v2M12 4v16M9 20h6" />]),
  dot: () => S([<path key="a" d="M4 4v16h16" />, ...[[8, 14], [10, 11], [12, 13], [9, 16], [14, 9], [16, 11], [13, 7]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.9" fill="currentColor" />)]),
  pseudo: () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4v16h16" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="11" cy="13" r="4.5" fill="#3b8ee6" />
      <circle cx="11" cy="13" r="2.8" fill="#4cc46a" />
      <circle cx="11" cy="13" r="1.4" fill="#f2c94c" />
      <circle cx="16" cy="8" r="2" fill="#3b8ee6" />
      <circle cx="16" cy="8" r="0.9" fill="#e85d4a" />
    </svg>
  ),
  density: () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4v16h16" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <rect x="7" y="10" width="3" height="3" fill="#3b8ee6" />
      <rect x="10" y="10" width="3" height="3" fill="#4cc46a" />
      <rect x="10" y="13" width="3" height="3" fill="#f2c94c" />
      <rect x="13" y="7" width="3" height="3" fill="#3b8ee6" />
      <rect x="7" y="13" width="3" height="3" fill="#4cc46a" />
      <rect x="13" y="13" width="3" height="3" fill="#3b8ee6" />
    </svg>
  ),
  contour: () => S([<path key="a" d="M4 4v16h16" />, <ellipse key="b" cx="12" cy="12" rx="5.5" ry="4" />, <ellipse key="c" cx="12" cy="12" rx="2.6" ry="1.8" />]),
  histogram: () => S([<path key="a" d="M4 4v16h16" />, <path key="b" d="M6 19c2 0 3-11 6-11s4 11 7 11" />]),
  overlay: () => S([<path key="a" d="M4 4v16h16" />, <path key="b" d="M5 19c2 0 3-10 5-10s3 10 5 10" />, <path key="c" d="M9 19c2 0 3-13 5-13s3 13 5 13" strokeDasharray="2 1.6" />]),
  alignL: () => S([<path key="a" d="M4 3v18" />, <rect key="b" x="6" y="6" width="12" height="4" />, <rect key="c" x="6" y="14" width="8" height="4" />]),
  alignC: () => S([<path key="a" d="M12 3v18" />, <rect key="b" x="5" y="6" width="14" height="4" />, <rect key="c" x="8" y="14" width="8" height="4" />]),
  alignR: () => S([<path key="a" d="M20 3v18" />, <rect key="b" x="6" y="6" width="12" height="4" />, <rect key="c" x="10" y="14" width="8" height="4" />]),
  alignT: () => S([<path key="a" d="M3 4h18" />, <rect key="b" x="6" y="6" width="4" height="12" />, <rect key="c" x="14" y="6" width="4" height="8" />]),
  alignM: () => S([<path key="a" d="M3 12h18" />, <rect key="b" x="6" y="5" width="4" height="14" />, <rect key="c" x="14" y="8" width="4" height="8" />]),
  alignB: () => S([<path key="a" d="M3 20h18" />, <rect key="b" x="6" y="6" width="4" height="12" />, <rect key="c" x="14" y="10" width="4" height="8" />]),
  distH: () => S([<path key="a" d="M3 4v16M21 4v16" />, <rect key="b" x="6" y="8" width="4" height="8" />, <rect key="c" x="14" y="8" width="4" height="8" />]),
  distV: () => S([<path key="a" d="M4 3h16M4 21h16" />, <rect key="b" x="8" y="6" width="8" height="4" />, <rect key="c" x="8" y="14" width="8" height="4" />]),
  sameSize: () => S([<rect key="a" x="3" y="5" width="8" height="8" />, <rect key="b" x="13" y="5" width="8" height="8" />, <path key="c" d="M3 18h18M3 16.5v3M21 16.5v3" />]),
  grid: () => S([<rect key="a" x="3" y="3" width="18" height="18" />, <path key="b" d="M9 3v18M15 3v18M3 9h18M3 15h18" />]),
  snap: () => S([<path key="a" d="M6 3v6a6 6 0 0 0 12 0V3" />, <path key="b" d="M6 3h3v6M18 3h-3v6" />, <path key="c" d="M12 18v3" />]),
  arrange: () => S([<rect key="a" x="3" y="3" width="7" height="7" />, <rect key="b" x="14" y="3" width="7" height="7" />, <rect key="c" x="3" y="14" width="7" height="7" />, <rect key="d" x="14" y="14" width="7" height="7" />]),
  batch: () => S([<rect key="a" x="3" y="6" width="5" height="5" />, <rect key="b" x="9.5" y="6" width="5" height="5" />, <rect key="c" x="16" y="6" width="5" height="5" />, <path key="d" d="M3 16h18M3 19h12" />]),
  zoomIn: () => S([<circle key="a" cx="10" cy="10" r="6" />, <path key="b" d="M15 15l5 5M10 7v6M7 10h6" />]),
  zoomOut: () => S([<circle key="a" cx="10" cy="10" r="6" />, <path key="b" d="M15 15l5 5M7 10h6" />]),
  fit: () => S([<path key="a" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />]),
  export: () => S([<path key="a" d="M12 3v12M7 8l5-5 5 5" />, <path key="b" d="M5 14v6h14v-6" />]),
  image: () => S([<rect key="a" x="3" y="5" width="18" height="14" rx="1" />, <circle key="b" cx="8.5" cy="10" r="1.8" />, <path key="c" d="M21 16l-5-5-8 8" />]),
  tiff: () => S([<path key="a" d="M6 3h8l4 4v14H6z" />, <path key="b" d="M14 3v4h4" />, <path key="c" d="M8.5 18l2.5-3.5 2 2.2 1.5-1.7 1.5 3" />, <circle key="d" cx="10" cy="11" r="1.2" />]),
  pdf: () => S([<path key="a" d="M6 3h8l4 4v14H6z" />, <path key="b" d="M14 3v4h4" />, <path key="c" d="M9 16v-4h1.5a1.3 1.3 0 0 1 0 2.6H9" />]),
  svg: () => S([<path key="a" d="M4 18c4-1 3-10 8-11s4 8 8 7" />, <circle key="b" cx="4" cy="18" r="1.5" />, <circle key="c" cx="20" cy="14" r="1.5" />]),
  table: () => S([<rect key="a" x="3" y="4" width="18" height="16" rx="1" />, <path key="b" d="M3 9h18M3 14h18M9 4v16" />]),
  matrix: () => S([<path key="a" d="M6 4H4v16h2M18 4h2v16h-2" />, <path key="b" d="M8 8h1M12 8h1M16 8h1M8 12h1M12 12h1M16 12h1M8 16h1M12 16h1M16 16h1" strokeWidth={2.2} />]),
  wand: () => S([<path key="a" d="M4 20L15 9" />, <path key="b" d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M12 4v1.5M11.25 4.75h1.5" />]),
  trash: () => S([<path key="a" d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />]),
  copy: () => S([<rect key="a" x="8" y="8" width="12" height="12" rx="1" />, <path key="b" d="M16 8V4H4v12h4" />]),
  plus: () => S([<path key="a" d="M12 5v14M5 12h14" />]),
  close: () => S([<path key="a" d="M6 6l12 12M18 6L6 18" />]),
  eye: () => S([<path key="a" d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />, <circle key="b" cx="12" cy="12" r="3" />]),
  eyeOff: () => S([<path key="a" d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.5M6.5 7.5C3.9 9.3 2 12 2 12s4 7 10 7a9.5 9.5 0 0 0 4.4-1.1" />]),
  gear: () => S([<circle key="a" cx="12" cy="12" r="3" />, <path key="b" d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />]),
  axis: () => S([<path key="a" d="M4 4v16h16" />, <path key="b" d="M4 15h2M4 10h2M4 6h1M9 20v-2M14 20v-2M19 20v-1" />]),
  sheet: () => S([<rect key="a" x="4" y="3" width="16" height="18" rx="1" />, <rect key="b" x="7" y="6" width="4.5" height="4.5" />, <rect key="c" x="12.5" y="6" width="4.5" height="4.5" />, <path key="d" d="M7 14h10M7 17h7" />]),
  layers: () => S([<path key="a" d="M12 3l9 5-9 5-9-5z" />, <path key="b" d="M3 13l9 5 9-5" />]),
  gate: () => S([<path key="a" d="M4 4v16h16" />, <path key="b" d="M8 15l3-7 7 2-2 6z" />]),
  sun: () => S([<circle key="a" cx="12" cy="12" r="4" />, <path key="b" d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5" />]),
  moon: () => S([<path key="a" d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />]),
  xml: () => S([<path key="a" d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />]),
  down: () => S([<path key="a" d="M6 9l6 6 6-6" />]),
  right: () => S([<path key="a" d="M9 6l6 6-6 6" />]),
  bool: () => S([<circle key="a" cx="9" cy="12" r="5.5" />, <circle key="b" cx="15" cy="12" r="5.5" />]),
  help: () => S([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17h.01" />]),
  barchart: () => S([<path key="a" d="M4 4v16h16" />, <rect key="b" x="7" y="11" width="3" height="9" />, <rect key="c" x="12" y="7" width="3" height="13" />, <rect key="d" x="17" y="13" width="3" height="7" />]),
  demo: () => S([<path key="a" d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" />, <path key="b" d="M7.5 15h9" />]),
  /** a well plate (3 x 4 wells) */
  plate: () =>
    S([
      <rect key="a" x="2.5" y="4.5" width="19" height="15" rx="2" />,
      ...[8, 12, 16].flatMap((y) => [6.5, 10, 13.5, 17].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.25" />)),
    ]),
  /** a folder opened as a whole */
  folder: () => S([<path key="a" d="M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />, <path key="b" d="M3 7V5h6l2 2" />, <path key="c" d="M9 14h6M12 11v6" />]),
};

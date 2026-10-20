// "How do I …?": a compact manual of FlowState (ribbon tabs, buttons, panels, workflows) that goes to the model with the
// question, and the answer's "show me" targets checked against it. Nothing of the user's data is sent: only the question
// and which view is open. The manual's button labels are checked against the ribbon source by a test.

/** A place the answer can point at: a ribbon button (tab + its label) or an area of the window. */
export type HelpTarget = { tab: string; label: string } | { area: HelpArea };

export type HelpArea = 'samples' | 'groups' | 'populations' | 'inspector' | 'worksheet' | 'doctabs' | 'ai';

/** CSS selector of each area (see App.tsx, Panels.tsx, SheetView.tsx). */
export const AREA_SELECTORS: Record<HelpArea, string> = {
  samples: '[aria-label="Sample list"]',
  groups: '[aria-label="Sample groups"]',
  populations: '[role="tree"][aria-label="Populations"]',
  inspector: '#side-right',
  worksheet: '.sheet-scroll',
  doctabs: '.doc-tabs',
  ai: '.ai-tb',
};

const AREA_TEXT: Record<HelpArea, string> = {
  samples: 'Sample list (left panel, top): the loaded FCS files. Click a sample to make it the active one (plots that follow the active sample show it); Ctrl/Shift+click selects several; double-click renames; right-click for color, well, remove; switch List / Plate view; drag a sample onto the page for a plot of it.',
  groups: 'Sample groups (bar above the sample list): "+" makes a group from the selected samples; click a group to show only its samples. Groups are used in stat charts, tables, plate layouts and gate scopes.',
  populations: 'Population tree (left panel, below the samples): the gating hierarchy with counts / % of the active sample. Click a population to select it; double-click (or drag onto the page) for a plot of it; F2 or a click on the selected name renames; right-click to recolor, copy / paste gates (with or without the populations below), restrict a gate to some groups or samples (scope), delete.',
  inspector: 'Inspector (right panel): settings of the selected item: for a plot the population, sample, channels, plot type, scales and transforms (log, biexponential / logicle, arcsinh), colors, gate labels, titles, size in mm; for a gate its name, color, numbers; for a chart its statistic, groups, error bars.',
  worksheet: 'Worksheet (the page in the middle): plots, text, statistics boxes and charts laid out on a page in mm. Click to select, drag to move, handles resize; double-click a plot or press Enter for the large gating view.',
  doctabs: 'Document tabs (above the page): the worksheets, plus Tables, Plates, Compensation, Unmixing and Calibration views; "+" adds a worksheet; right-click a sheet tab to rename, duplicate, delete.',
  ai: 'AI button in the title bar: shows whether the AI assistant is on and opens the AI tab.',
};

interface Btn {
  label: string;
  does: string;
}
interface TabDoc {
  id: string;
  name: string;
  groups: { name: string; buttons: Btn[] }[];
}

/** The ribbon as the user sees it (labels exactly as on the buttons). */
export const RIBBON_DOC: TabDoc[] = [
  {
    id: 'home',
    name: 'Home',
    groups: [
      { name: 'File', buttons: [
        { label: 'Open FCS', does: 'open FCS / LMD files (or drop files anywhere on the window)' },
        { label: 'Open folder', does: 'open all FCS files of a folder, e.g. a plate export with a subfolder per plate' },
        { label: 'Open', does: 'open a saved workspace (.json), a bundle with data (.zip), a FlowJo workspace (.wsp) or Gating-ML (.xml)' },
        { label: 'Save workspace', does: 'save gates, layouts and tables as .json (Ctrl+S); FCS files are referenced by name' },
        { label: 'Save with data', does: 'save the workspace plus all FCS files as one .zip to reopen anywhere' },
        { label: 'New analysis', does: 'start a new empty analysis (the current one stays under Earlier analyses on the start screen)' },
      ] },
      { name: 'Edit', buttons: [
        { label: 'Undo', does: 'undo (Ctrl+Z)' },
        { label: 'Redo', does: 'redo (Ctrl+Y)' },
        { label: 'Duplicate', does: 'duplicate the selected items (Ctrl+D)' },
        { label: 'Delete', does: 'delete the selected items, or the selected population (Del)' },
      ] },
      { name: 'Tools', buttons: [
        { label: 'Select', does: 'select and move items (V)' },
        { label: 'Auto gate', does: 'click a cluster on a plot (or drag a box around it); a preview with a tight-to-loose slider appears; Enter or OK makes the gate (W)' },
        { label: 'Polygon', does: 'draw a polygon gate: click the corners, double-click to close (P)' },
        { label: 'Rectangle', does: 'drag a rectangle gate (R)' },
        { label: 'Ellipse', does: 'drag an ellipse gate (E)' },
        { label: 'Quadrant', does: 'click to place a quadrant gate: four populations (Q)' },
        { label: 'Range', does: 'drag a range gate on a histogram (H)' },
        { label: 'Split', does: 'click to split a histogram into a low and a high population (S)' },
        { label: 'Text', does: 'add a text box to the page (T)' },
        { label: 'Zoom', does: 'zoom into a plot region (Z)' },
      ] },
      { name: 'New plot', buttons: [
        { label: 'Pseudocolor', does: 'add a pseudocolor plot of the selected population' },
        { label: 'Histogram', does: 'add a histogram of the selected population' },
      ] },
      { name: 'View', buttons: [
        { label: 'Gating view', does: 'show the selected plot large with all gating tools (Enter, or double-click the plot; Esc closes)' },
        { label: 'Zoom to selection', does: 'zoom so the selected items fill the window (F)' },
        { label: 'Back / fit page', does: 'back to the previous zoom, else fit the page (Shift+1)' },
      ] },
    ],
  },
  {
    id: 'plot',
    name: 'Plot',
    groups: [
      { name: 'New plot', buttons: [
        { label: 'Dot', does: 'dot plot' },
        { label: 'Pseudocolor', does: 'pseudocolor density plot' },
        { label: 'Density', does: 'smoothed density image' },
        { label: 'Contour', does: 'contour plot' },
        { label: 'Zebra', does: 'contour bands filled with the colormap' },
        { label: 'Histogram', does: 'histogram' },
        { label: 'Overlay', does: 'histogram overlay of the selected samples (or the active sample and the next): compare samples on one channel' },
      ] },
      { name: 'Axes', buttons: [{ label: 'Fit axes to data', does: 'set every axis on the sheet from the events (0.1 to 99.9 percentile); select several samples to fit to all of them' }] },
      { name: 'Style', buttons: [
        { label: 'Apply to selected plots', does: 'apply the chosen style preset (colors, background, axes) to the selected plots' },
        { label: 'Apply to all plots on sheet', does: 'apply the style preset to every plot of the sheet' },
      ] },
      { name: 'Annotate', buttons: [
        { label: 'Text', does: 'text tool' },
        { label: 'Stats box', does: 'live statistics box (count, %, median ...) on the page' },
        { label: 'Stat chart', does: 'bar or dot chart of a statistic across samples or groups, with SD / SEM error bars' },
      ] },
      { name: 'Worksheets', buttons: [
        { label: 'New sheet', does: 'add a worksheet' },
        { label: 'Duplicate sheet', does: 'copy the sheet' },
        { label: 'Delete sheet…', does: 'delete the sheet' },
      ] },
    ],
  },
  {
    id: 'gate',
    name: 'Gate',
    groups: [
      { name: 'Draw gate', buttons: [
        { label: 'Polygon', does: 'polygon gate (P)' },
        { label: 'Rectangle', does: 'rectangle gate (R)' },
        { label: 'Ellipse', does: 'ellipse gate (E)' },
        { label: 'Quadrant', does: 'quadrant gate (Q)' },
        { label: 'Range', does: 'range gate on a histogram (H)' },
        { label: 'Split', does: 'split gate on a histogram (S)' },
      ] },
      { name: 'Combine', buttons: [{ label: 'Boolean', does: 'AND / OR / NOT combinations of populations' }] },
      { name: 'Gating-ML 2.0', buttons: [
        { label: 'Import', does: 'import gates from a Gating-ML 2.0 file' },
        { label: 'Export', does: 'export the gates as Gating-ML 2.0' },
      ] },
      { name: 'Compare', buttons: [{ label: 'FlowJo counts', does: 'compare the counts stored in an opened FlowJo .wsp with the counts computed here' }] },
    ],
  },
  {
    id: 'layout',
    name: 'Layout',
    groups: [
      { name: 'Align', buttons: [
        { label: 'Left', does: 'align left' },
        { label: 'Top', does: 'align top' },
      ] },
      { name: 'Distribute & size', buttons: [
        { label: 'Same size', does: 'make the selected items the size of the last clicked one' },
        { label: 'Arrange grid', does: 'arrange the selected items in an even grid' },
      ] },
      { name: 'Figure', buttons: [
        { label: 'Strategy sheet', does: 'new sheet with one plot per gating step, in hierarchy order (gating strategy figure)' },
        { label: 'Panel labels', does: 'add A, B, C … panel letters in reading order' },
      ] },
      { name: 'Batch', buttons: [{ label: 'Repeat for samples', does: 'select plots first; makes a row (or column) of copies for every chosen sample, with sample names as labels' }] },
      { name: 'Zoom', buttons: [
        { label: 'Fit page', does: 'fit the page into the window' },
        { label: '100%', does: 'zoom 100 %' },
      ] },
    ],
  },
  {
    id: 'comp',
    name: 'Compensation',
    groups: [
      { name: 'Compensation', buttons: [
        { label: 'Matrix editor', does: 'view and fine-tune the spillover matrix with a live preview; the acquisition matrix from the files is used by default' },
        { label: 'From controls', does: 'compute a spillover matrix from single-stained controls (wizard)' },
      ] },
      { name: 'Spectral', buttons: [{ label: 'Unmixing', does: 'spectral unmixing (OLS, WLS, non-negative) from single-stain controls, autofluorescence as a channel, similarity and spread checks' }] },
    ],
  },
  {
    id: 'calib',
    name: 'Calibration',
    groups: [
      { name: 'Fluorescence', buttons: [{ label: 'MESF / ERF', does: 'calibrate fluorescence in MESF, ERF or ABC units from a bead kit (enter the lot values)' }] },
      { name: 'Light scatter', buttons: [{ label: 'Size (Mie)', does: 'turn scatter into particle diameter (nm) with reference beads and Mie theory, e.g. for extracellular vesicles' }] },
      { name: 'Experiment', buttons: [{ label: 'Setup', does: 'kind of experiment (conventional / nanoscale) and which calibration tools are shown' }] },
    ],
  },
  {
    id: 'tables',
    name: 'Statistics',
    groups: [
      { name: 'Statistics tables', buttons: [
        { label: 'Table editor', does: 'the tables view: one row per sample, one column per statistic (count, % parent / total / of an ancestor, median, mean, geometric mean, CV, robust CV, percentiles, events/µL); add columns, choose the sample group, copy, CSV, Excel; a column can be turned into a chart' },
        { label: 'New table', does: 'new statistics table' },
        { label: 'MFI table', does: 'table with count, % parent and the median of every fluorescence channel for the selected populations' },
      ] },
      { name: 'Plates', buttons: [
        { label: 'Plates', does: 'heatmap of any statistic over 96 / 384 well plates; plate layout (compound, concentration) that makes groups; export' },
        { label: 'Re-detect wells', does: 'detect plates and wells again from keywords, names and folders' },
      ] },
    ],
  },
  {
    id: 'export',
    name: 'Export',
    groups: [
      { name: 'Figure', buttons: [
        { label: 'SVG', does: 'vector figure with editable text' },
        { label: 'PDF', does: 'PDF of the sheet at its exact size in mm, fonts embedded' },
        { label: 'PNG', does: 'bitmap at 150 to 1200 dpi' },
        { label: 'TIFF', does: 'TIFF for journals, 150 to 1200 dpi' },
      ] },
      { name: 'Data', buttons: [
        { label: 'Populations', does: 'export gated events of a population as FCS 3.1 or CSV' },
        { label: 'Tables', does: 'go to the tables (export them there as CSV / Excel)' },
        { label: 'Gating-ML', does: 'export the gates as Gating-ML 2.0' },
      ] },
      { name: 'Workspace', buttons: [
        { label: 'Workspace', does: 'save the workspace (.json)' },
        { label: 'With data', does: 'save workspace plus FCS files (.zip)' },
        { label: 'Template', does: 'save gates, layouts and tables without data; open it later and add new FCS files to analyse them the same way' },
      ] },
    ],
  },
  {
    id: 'ai',
    name: 'AI',
    groups: [
      { name: 'Help', buttons: [{ label: 'How do I…', does: 'ask how to do something in FlowState (this assistant)' }] },
      { name: 'Start', buttons: [
        { label: 'Analyze new files', does: 'the AI reads the files not analyzed yet (optionally your protocol as xlsx / docx / csv / txt: plate layout, conditions, experimental details), proposes a plan (groups, gating, figures, tables) that you check and comment on, then gates and builds the figures, tables and a results page' },
        { label: 'Describe experiment', does: 'the AI reads the files and suggests groups, the setup and next steps' },
      ] },
      { name: 'Gate', buttons: [
        { label: 'Gate with AI', does: 'select a plot, name a population (e.g. lymphocytes); the AI points at it and the auto gate draws it' },
        { label: 'Gating strategy', does: 'the AI proposes a gating hierarchy for the panel; edit it, then build it step by step' },
      ] },
      { name: 'Panel', buttons: [{ label: 'Marker labels', does: 'suggest marker names for channels from the FCS keywords and a pasted panel' }] },
      { name: 'Write', buttons: [{ label: 'Methods & legend', does: 'draft a methods paragraph or a figure legend' }] },
      { name: 'Review', buttons: [{ label: 'Check analysis', does: 'review the plots of a sheet for common gating problems' }] },
      { name: 'Assistant', buttons: [{ label: 'AI settings', does: 'provider (lab proxy, API key, claude.ai), what is sent, hide sample names' }] },
    ],
  },
];

const WORKFLOWS = `Common tasks:
- Load data: drag FCS files or a folder onto the window (Home > Open FCS / Open folder). Plates and wells are recognised from keywords and names.
- Make a plot: select a population in the population tree, Home > New plot > Pseudocolor (or double-click the population). Change channels by clicking an axis title on the plot (channel picker) or in the Inspector.
- Gate: Home > Tools > Auto gate (W), click the cluster, adjust the slider, Enter. Or draw with Polygon (P) / Rectangle (R) / Range (H). Double-click a gate to open a plot of the gated population ("next plot"). Gates apply to all samples; restrict one in the population tree (right-click > scope).
- Same gate, other sample: select another sample in the sample list; plots that follow the active sample switch. Adjust a gate for one sample only: select the gate, then in the Inspector "Adjust for <sample> only".
- Change axis scale / transform: select the plot, Inspector > scales (linear, log, biexponential / logicle, arcsinh with cofactor), or click the axis.
- Compare samples: Plot > Overlay (histogram overlay of the selected samples), or Layout > Repeat for samples (a grid of the same plots for every sample).
- Groups / conditions: select samples, "+" in the groups bar; then charts and tables can be per group (mean, SD, SEM).
- Statistics: Statistics > New table or MFI table; add columns in the table editor; copy / CSV / Excel; turn a column into a chart. A stats box (Plot > Stats box) shows numbers next to a plot.
- Chart: Plot > Stat chart (bar or dot chart of a statistic per sample or group, error bars SD / SEM).
- Figure: arrange plots (Layout tab), panel letters (Layout > Panel labels), page size in the Inspector with nothing selected; Export > PDF / SVG / PNG / TIFF.
- Gating strategy figure: Layout > Strategy sheet.
- Compensation: Compensation > Matrix editor (fine-tune) or From controls (compute from single stains). Spectral data: Compensation > Unmixing.
- Nanoscale / EVs: Calibration > Size (Mie) with size beads and MESF / ERF with fluorescence beads (Calibration > Setup turns these tools on).
- FlowJo: Home > Open a .wsp (with its FCS files); Gate > FlowJo counts compares the counts.
- Reuse an analysis on new files: Export > Template, later open it and add the new FCS files.
- Export events: Export > Populations (FCS or CSV).
- Save: Ctrl+S (workspace .json) or Save with data (.zip). The session is also kept in the browser automatically.
- Keyboard shortcuts: press ? or F1.
- AI does the whole analysis: AI > Analyze new files.`;

/** The manual as sent: tabs with groups and buttons, the window areas, the common workflows. */
export function manualText(): string {
  const tabs = RIBBON_DOC.map((t) => `Tab "${t.name}" (id ${t.id}):\n${t.groups.map((g) => `  Group "${g.name}": ${g.buttons.map((b) => `[${t.id}:${b.label}] ${b.does}`).join('; ')}`).join('\n')}`).join('\n');
  const areas = (Object.keys(AREA_TEXT) as HelpArea[]).map((a) => `[area:${a}] ${AREA_TEXT[a]}`).join('\n');
  return `FlowState is a browser app for flow cytometry analysis (like FlowJo): FCS import, gating, statistics, figures, compensation, spectral unmixing, EV size and MESF calibration. Files are analysed in the browser and never uploaded. The window: a ribbon of tabs at the top, the sample list and population tree on the left, the worksheet (page) in the middle, the inspector on the right.

Ribbon (button references in brackets, [tab:Label]):
${tabs}

Window areas:
${areas}

${WORKFLOWS}`;
}

export function helpPrompt(question: string, where: string): string {
  return `You are the built-in help of FlowState. Answer the user's question about how to do something in the app, using ONLY the manual below. If the manual does not cover it, say so briefly and suggest the closest thing it can do; do not invent buttons or menus.

${manualText()}

The user is currently in: ${where}.

Question: """${question.trim().slice(0, 1000)}"""

Reply with only a JSON object:
{"answer": "one or two sentences", "steps": [{"text": "one short instruction", "show": "tab:Label" or "area:name" or null}], "tip": "optional one-sentence tip or empty"}
steps: at most 6, in order. show: the reference of the button or area the step uses, exactly as written in the manual in brackets (without the brackets), or null.`;
}

export interface HelpStep {
  text: string;
  show: HelpTarget | null;
}
export interface HelpAnswer {
  answer: string;
  steps: HelpStep[];
  tip: string;
}

/** A "tab:Label" / "area:name" reference of the manual, or null (unknown references are dropped, not guessed). */
export function parseTarget(ref: unknown): HelpTarget | null {
  if (typeof ref !== 'string') return null;
  const m = /^\s*\[?\s*([a-z]+)\s*:\s*(.+?)\s*\]?\s*$/i.exec(ref);
  if (!m) return null;
  const k = m[1].toLowerCase();
  const v = m[2];
  if (k === 'area') return v.toLowerCase() in AREA_SELECTORS ? { area: v.toLowerCase() as HelpArea } : null;
  const tab = RIBBON_DOC.find((t) => t.id === k || t.name.toLowerCase() === k);
  const b = tab?.groups.flatMap((g) => g.buttons).find((x) => x.label.toLowerCase() === v.toLowerCase());
  return tab && b ? { tab: tab.id, label: b.label } : null;
}

export function parseHelp(v: unknown): HelpAnswer {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (x: unknown, n: number) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
  const steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 8).flatMap((s): HelpStep[] => {
    const x = (s && typeof s === 'object' ? s : { text: s }) as Record<string, unknown>;
    const text = str(x.text, 300);
    return text ? [{ text, show: parseTarget(x.show) }] : [];
  });
  return { answer: str(o.answer, 800), steps, tip: str(o.tip, 300) };
}

/** Example questions shown before the first one. */
export const HELP_EXAMPLES = ['How do I gate lymphocytes?', 'How do I compare CD69 between my samples?', 'How do I make a bar chart with error bars per group?', 'How do I export a figure for a paper?', 'How do I apply my gates to new files?'];

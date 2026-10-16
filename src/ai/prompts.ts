// Prompt templates of the AI assistant. Every prompt asks for facts from the data given only and for a fixed JSON shape
// (gate, strategy, markers, check) or plain text (methods, legend).

export const GRID_NOTE =
  'A blue coordinate grid is drawn over the plot frame: the blue numbers along the TOP edge are x and those along the RIGHT edge are y, in plot-frame units from 0 to 1 (x: 0 = left edge of the frame, 1 = right edge; y: 0 = bottom edge, 1 = top edge). These are not axis values. Report every position in these frame units.';

export function gatePrompt(o: { target: string; hist: boolean; context: string; peaks: string; tree: string; image: boolean }): string {
  const shape = o.hist
    ? '{"found": true, "name": string, "range": [x0, x1], "peak": string or null, "confidence": number, "rationale": string}\nrange: the population\'s extent along the x axis in frame units (x0 < x1).'
    : '{"found": true, "name": string, "x": number, "y": number, "bbox": [x0, y0, x1, y1], "peak": string or null, "confidence": number, "rationale": string}\nx, y: a point in the densest part of the population. bbox: a box around the whole population (x0 < x1, y0 < y1), all in frame units.';
  return [
    `You help a scientist gate flow cytometry data. ${o.image ? 'Look at the attached plot image and find' : 'Using the description of the plot below, find'} this population: "${o.target}".`,
    '',
    o.context,
    o.image ? (o.hist ? GRID_NOTE.replace(' and those along the RIGHT edge are y', '').replace('; y: 0 = bottom edge, 1 = top edge', '') : GRID_NOTE) : '',
    '',
    'Density peaks found in the data by the program (frame units; populations that touch may be merged into one peak):',
    o.peaks || '(none)',
    '',
    'Gating hierarchy so far:',
    o.tree,
    '',
    'The program will draw the gate boundary itself from the event density, starting from the position you give, so point at the population, do not trace it.',
    'Reply with only a JSON object of this shape:',
    shape,
    `peak: the id of the listed peak that is this population${o.image ? ' (check it against the image)' : ''}, or null if none matches. name: a short population name (at most 3 words). confidence: 0 to 1. rationale: one or two sentences.`,
    'If the population is not on this plot (wrong axes, absent, or too ambiguous to point at), reply {"found": false, "rationale": "why"} instead. Do not guess.',
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join('\n');
}

export function strategyPrompt(o: { panel: string; samples: string; instrument: string; tree: string; goal: string }): string {
  return `You are an expert flow cytometrist. Propose a gating strategy (a hierarchy of gates) for this experiment. Use only channel names from the panel list.

Panel (channel name: marker label, empty if unknown):
${o.panel}

Samples: ${o.samples || '(none)'}
Instrument: ${o.instrument || 'unknown'}
Existing gates:
${o.tree}
${o.goal ? `\nWhat the user wants to analyse: ${o.goal}\n` : ''}
Rules:
- Start from "All events": a scatter gate excluding debris, then doublet exclusion (FSC-A vs FSC-H, or SSC-A vs SSC-H) if height channels exist, then dead-cell exclusion if a viability dye is in the panel, then the populations of interest.
- Each step gates ONE population: on a 2D plot ("plot": "2d" with x and y) or a histogram ("plot": "histogram", x only).
- parent: "All events" or the name of an earlier step.
- target: what to gate, described for someone looking at that plot (e.g. "live cells: the population with low viability dye signal").
- At most 10 steps, in order.

Reply with only a JSON object:
{"steps": [{"name": "Cells", "parent": "All events", "plot": "2d", "x": "FSC-A", "y": "SSC-A", "target": "intact cells, excluding debris near the origin"}], "notes": "one or two sentences on assumptions"}`;
}

export function markerPrompt(o: { channels: string; samples: string; panel: string }): string {
  return `Suggest marker labels (the antigen or dye a channel measures, e.g. "CD3", "CD45RA", "Viability") for the fluorescence channels of a flow cytometry experiment.

Channels (channel name | stain keywords $PnS found in the files | current label):
${o.channels}

Samples: ${o.samples || '(none)'}
${o.panel ? `Panel description from the user:\n"""\n${o.panel}\n"""\n` : ''}
Rules:
- Use the panel description and the $PnS keywords. Give the common marker name only ("CD4", not "CD4 PE-Cy7").
- If nothing tells you what a channel measures, use "" and say so in the note. Do not guess from the fluorochrome alone.

Reply with only a JSON object:
{"labels": [{"channel": "FITC-A", "marker": "CD3", "note": "from $PnS"}]}`;
}

const FACTS =
  'Use ONLY facts from the summary below. Do not invent reagents, clones, instrument settings, numbers, sample sizes or statistical tests. Where the text would normally state something that is not in the summary, write [to fill] at that place.';

export function methodsPrompt(summary: string): string {
  return `Write the flow cytometry data acquisition and analysis part of a Methods section for a scientific paper, covering what MIFlowCyt (Minimum Information about a Flow Cytometry Experiment) asks for where the summary allows: instrument, data files, compensation or spectral unmixing, transformations, gating strategy, statistics, calibration, software.
${FACTS}
Write one or two paragraphs of plain text in the past tense, without headings, bullet points or Markdown.

Summary:
${summary}`;
}

export function legendPrompt(summary: string): string {
  return `Write a figure legend for a figure made from the worksheet described in the summary. Start with a one-sentence title, then describe each panel (A, B, C ... in the order listed): what is plotted, which population and sample, and the gates shown with their frequencies.
${FACTS}
Plain text without Markdown.

Summary:
${summary}`;
}

export function checkPrompt(o: { images: string; tree: string; perSample: string; panel: string; image: boolean }): string {
  return `Review this flow cytometry gating analysis for problems.${o.image ? ' The attached images are the plots of one worksheet, in this order:' : ' The plots of the worksheet are:'}
${o.images}

Panel: ${o.panel}

Gating tree with counts (active sample):
${o.tree}
${o.perSample ? `\nFrequencies (% of parent) per sample:\n${o.perSample}\n` : ''}
Look for: missing debris or doublet exclusion; no dead-cell exclusion although a viability dye is in the panel; gates that cut through a population or include part of a neighbouring one; compensation or unmixing artifacts (diagonal smears, populations skewed below zero); too few events for reliable statistics (fewer than about 100 in a gate); gates that look inconsistent across samples; gates on an unexpected parent.
Report only issues that the ${o.image ? 'images or the ' : ''}numbers support. Severity: "high" (result likely wrong), "medium" (worth checking), "low" (minor).

Reply with only a JSON object:
{"issues": [{"severity": "medium", "title": "short title", "detail": "one or two sentences", "image": 2, "population": "Lymphocytes"}], "summary": "one sentence"}
image: the image number the issue is seen on, or null. Return an empty list if you find nothing.`;
}

# FlowState 0.10.5-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## Fixed

- Log axes spanning less than one decade (for example 100 to 500) show the range as set; they were widened to one
  decade. Gating-ML gates on such axes (flog with M below 1) are now imported at the right values; their boundaries
  were shifted before, which changed their event counts
- Imported Gating-ML polygon and ellipse gates on a log axis no longer include events at or below 0 when the gate
  reaches below the axis, as in other Gating-ML software. Gates drawn in FlowState and FlowJo gates are unchanged

# FlowState 0.10.4-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## Changed

- Size calibration: the half-angle fit method "CV (FCMPASS)" is now called "Lowest CV"; its tooltip still credits the
  method to FCMPASS (Welsh et al. 2020)

# FlowState 0.10.3-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## Fixed

- Plots: gates also stay on a plot when its population is changed to one further up the tree (for example from Cells
  to All Events, the Singlets gate stays on the FSC-A / FSC-H plot). A plot keeps the gates it showed, on its axes, with
  their own % of parent; a new plot shows only the gates of its population. Show gates (Inspector) hides them all

# FlowState 0.10.2-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## Fixed

- Plots: changing the population of a plot no longer hides the gates on its axes. Gates further up the population's
  path stay drawn, for example the Singlets gate on an FSC-A / FSC-H plot of Live cells, with their own % of parent as
  on the plot they were drawn on; gates of other branches are still left out

# FlowState 0.10.1-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## New

- Statistics tables: hide single samples from a table with the × next to the sample name (for example a failed tube or
  a control you do not want in the export); they stay in the workspace and in other tables, and come back with one click
  below the table. Hidden samples are also left out of copies, CSV / Excel exports and charts made from the table
- Statistics tables: remove a statistic straight from its column header (×)
- What's new: the changes of each version, in About and from the start screen

# FlowState 0.10.0-beta

**Download:** `flowstate-standalone.html` below (double-click to open; works offline).

## New

- AI > Analyze new files: a whole analysis of the files not analyzed yet, from a plan you check, comment on and can have
  revised; attach your protocol (xlsx, docx, csv, txt) for the plate layout and the experimental context: groups,
  AI-seeded auto gates, a gating-strategy sheet, per-sample plots, overlays, charts per group,
  statistics tables and a drafted results text, all marked as AI-generated; one Undo removes it
- AI > How do I …: questions about the app in your own words; "Show me" opens the ribbon tab and points at the button
- AI auto-analysis is now called Describe experiment
- A hosted lab copy can start with its lab proxy switched on (build with `VITE_LAB_PROXY_URL` and
  `VITE_LAB_PROXY_DEFAULT=1`, for a server that already restricts access); its AI settings are kept apart from a public
  copy on the same site
- Lab proxy: `MAX_TOKENS` defaults to 16000, because the model's reasoning counts toward it and a shorter limit could
  cut JSON answers short

# FlowState 0.9.0-beta

First release on GitHub. FlowState is beta software: unexpected behaviour can occur, so please verify critical results
and report problems or ideas (issues or flow@nanoscale.app).

**Download:** `flowstate-standalone.html` below. Double-click it to open FlowState in your browser (Chrome, Edge, Firefox
or Safari). It works offline; your files are never uploaded.

## In this version

- FCS 2.0 to 3.2 and Beckman LMD, export folders and plates (96 and 384 wells), FlowJo workspaces, Gating-ML 2.0
- Gating with all common gate types and auto gate, statistics tables and plate heatmaps, publication figures
  (PDF, SVG, PNG, TIFF)
- Compensation and spectral unmixing
- Nanoscale: EV sizing by Mie theory (as in FCMPASS) and MESF / ERF calibration, with saturation checks, valid ranges
  and a calibration report
- Optional AI assistant (off by default): AI auto-analysis, gating help, marker labels, methods and legends, analysis
  check; runs on claude.ai, an own API key or a lab proxy
- Start screen with conventional or nanoscale setup and the calibrators you need

Licensed under the GNU AGPL v3.0 only. For research use only.

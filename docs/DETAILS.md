# FlowState: details

Reference notes that do not fit on the [main page](../README.md): plates, interoperability with other programs,
how results were checked, and the source layout.

## Plates (96 / 384 wells)

- Wells and plates are read when files are loaded: FCS keywords first ($WELLID / $PLATEID / $PLATENAME of FCS 3.1; BD
  FACSDiva "WELL ID", "PLATE NAME", "PLATE ID"; CytExpert PLTNO and $SMNO; Guava GTI$WELL; MACSQuant $SRC; Aurora
  PLATEROWS / PLATECOLS), then the sample names (A1 to H12, A01, P24, "Well_A1", CytExpert "01-Well-A1", BD
  "Specimen_001_C2_C02"; a token counts only where the names share a pattern, so "CD8", "H2O", "B6 mice" or "A549" are
  no wells). Plates come from keywords, plate names in the file names ("Plate 2", "P2"), the folder when a folder is
  opened (Home > Open folder, or drop it: a subfolder per plate), the file of a multi-data-set file (Guava), or from
  repeated wells (a date or barcode in the names, else the loading order). Set or correct wells by hand (right-click a
  sample, Set well...; drag a sample onto a well) and re-detect at any time (Statistics > Re-detect wells).
- The sample panel shows the samples as a list or on their plate; wells select samples like list rows (click,
  Ctrl / Cmd-click, Shift-click, drag a block, row / column headers, arrow keys), for overlays, groups, batch layouts
  and removal.
- The Plates tab: a heatmap of any table statistic over all plates (e.g. % parent of "GFP+", median MFI), colormap,
  automatic or fixed range, values in the wells, n/a wells hatched; computed in slices, so 192 samples stay responsive.
  A plate layout (per-well annotations such as compound and concentration) is shown in the wells and makes groups
  (one per value). Export: CSV / Excel (8 x 12 block per plate and a table plate, well, sample, value, layout) and
  "Add to sheet" (a plate heatmap figure item, the same on screen and in PNG / TIFF / PDF / SVG).

## Interoperability

Files are opened with Open or by dropping them on the window; the kind of a .csv / .tsv / .txt file (matrix or events)
is told from its content. Matrices can also be imported and exported in the Compensation view.

| Program | Into FlowState | Out of FlowState |
|---|---|---|
| FlowJo 10 | FCS; workspaces (.wsp, or .xml; a v11 .flowjo only if it holds one): samples, gates, transforms, matrices; matrix files (.mtx, spilloverMatrix XML); CSV event exports as samples | FCS 3.1 populations; matrix as tab-separated .txt or .csv; population CSV (header "FITC-A :: CD3", as FlowJo writes it) |
| FlowLogic (Inivai) | FCS; matrix TXT / CSV (tab, semicolon or comma; fractions or %); CSV event exports ("Raw" or "Real") as samples | FCS 3.1 populations; matrix .txt; statistics CSV / XLSX |
| CytExpert (CytoFLEX) | FCS ($SPILLOVER; plate number and well); export folders (Open folder); compensation files (.comp) | FCS 3.1 populations |
| Kaluza / Navios | FCS and LMD files ($COMP, $SPILLOVER) | FCS 3.1 populations |
| FCS Express | FCS; text / CSV exports of events and matrices | FCS 3.1 populations; matrix .txt / .csv; statistics CSV / XLSX |
| Cytobank | FCS; Gating-ML 2.0 | FCS 3.1; Gating-ML 2.0 gates |
| FlowKit, R (flowCore, CytoML) | FCS; Gating-ML 2.0; FlowJo .wsp | FCS 3.1; Gating-ML 2.0 (gates, transforms, compensation) |

- Exported FCS files (FCS 3.1, float32): uncompensated values carry the matrix the sample uses as `$SPILLOVER`, so the
  next program can compensate them as FlowState did (other matrix keywords, including CytExpert's COMPA / COMPH, are
  removed when that matrix differs from the file's own). Compensated values carry no matrix keywords.
- Matrix import: names are matched to the samples' channels by `$PnN` (also ignoring case, with or without `-A`,
  without FlowJo's `Comp-` prefix) or by the marker / detector label `$PnS`; names without a channel are reported and
  ignored when compensating. A compensation matrix (the inverse of the spillover) is recognised and inverted.
- CytExpert .comp files hold a Height and an Area matrix (rows = detectors); they are imported as one matrix over the
  -H and -A channels, matched through the `$PnS` labels ("B531-A"), as CytExpert writes `$SPILLOVER`.
- CSV event tables become samples with the values as exported and no compensation keywords (marked "imported from
  CSV" in the sample info): a table exported compensated must not be compensated again.

Known limits:

- Not read: FlowLogic workspaces (.glf), Kaluza analyses, FCS Express layouts, CytExpert experiments, FlowJo v11
  analyses (JSON), spectral (unmixing) matrices in FlowJo files, CytExpert's autofluorescence and background settings.
- Gating-ML 2.0: hyperlog transforms, ratio dimensions and gates in more than two dimensions are not supported.
- FlowJo matrix files are read but not written (the .mtx layout could not be checked against FlowJo); export the
  matrix as .txt, or the gates and matrix as Gating-ML.
- A text matrix is taken as rows = fluorochromes unless its corner cell says otherwise ("Detector \ Fluor") or the
  detector wavelengths in the names show the spill going to shorter wavelengths (then it is transposed, with a note).
- Event tables hold what the other program exported: FlowJo's "channel values" are binned display values (0-1023),
  its "scale values" are the data values; only the latter can be gated like FCS data. Time, event numbers and other
  columns are read as channels.

## Verification

- Gating-ML 2.0 compliance suite (FlowKit `gate_ref`): 40/51 gates exact; remaining need hyperlog, ratio or 3D gates
- FCS values checked against FlowIO on files from BD, Beckman Coulter (CytoFLEX, Navios LMD), Thermo Fisher (Attune),
  BD Accuri and Miltenyi instruments
- Statistics and compensation checked against FlowKit
- FlowJo 10 workspace counts reproduced exactly, including polygons evaluated on FlowJo's gate grid (ICS workspace: 288/288 counts)

The reference data (public example files of FlowKit, FlowIO and other projects) are kept outside the repository and
are not redistributed here.

## Source layout

- `src/core` - FCS reader/writer, transforms (logicle, arcsinh, log, linear), compensation, gating engine, statistics,
  Gating-ML 2.0, FlowJo workspace import, matrix files of other programs (FlowJo .mtx, CytExpert .comp, text) and
  event tables (CSV), unmixing, Mie / bead calibration, demo data
- `src/render` - backend-independent painter (canvas / SVG / PDF), plot, chart and item renderers, colormaps, fonts
- `src/state` - zustand store with undo/redo, demo workspace
- `src/io` - downloads, workspace JSON/ZIP, session autosave (IndexedDB), figure export, XLSX
- `src/ui` - React UI (ribbon, sample/population panels, worksheet, inspector, tables, compensation, About dialog)
- `src/legal` - project metadata (version, license, copyright) shown in the About dialog

## Building

```bash
npm ci
npm run dev            # development server
npm run typecheck      # TypeScript
npm test               # unit and reference tests
npm run build          # static build in dist/ (host on any web server)
npm run build:single   # one self-contained HTML file: artifact/flowstate-standalone.html (needs Python 3)
```

Tests that need public reference files (FlowKit, FlowIO and other projects' example data) skip themselves when the
files are not present; the files are not redistributed here.

## Lab AI proxy

`server/ai-proxy/` holds a small Node 18 proxy (no dependencies) that lets a lab use the optional AI features with one
Anthropic account while the API key stays on the server: personal access codes, rate limits, monthly caps, CORS
allowlist. See [server/ai-proxy/README.md](../server/ai-proxy/README.md) and
[server/ai-proxy/DEPLOY.md](../server/ai-proxy/DEPLOY.md).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { calibTools, MM, setGridStyle, sheetGridStyle, uid, type GridStyle, type PlotType, type StatsBoxItem } from '../core/model';
import { exportGatingMLFile } from '../io/files';
import { addSheet, currentPopulation, defaultPlotSize, newChartItem, newOverlayPlot, newPlotItem, pickDefaultChannels, useStore, type Tool, type View } from '../state/store';
import { fitAllAxes, fitSampleLabel } from './axisFit';
import { requestSave } from './saveOps';
import { Icon } from './icons';
import { addItems, addPanelLabels, arrange, buildGatingStrategySheet, confirmDeleteSheet, deleteSelection, duplicateItems, duplicateSheet, findFreeSlot, panelLabelKinds } from './layoutOps';
import { fitZoom, setZoom, zoomBack, zoomToSelection } from './SheetView';
import { openGatingView } from './GatingView';
import { applyPresetTo, PRESET_OPTIONS, ZebraIcon } from './stylePresets';
import { bodyPt } from '../render/figstyle';
import { AiRibbonGroups } from './ai/AiPanel';
import { openMfiTableDialog } from './TablesView';
import { ribbonMinimized, ShellIcon, SHORT_QUERY, toggleRibbon, useLayout, useMedia } from './shell';
import { openUnmixView } from './unmix/draft';
import { redetectWells } from '../state/plateOps';

/** Compaction levels of the ribbon body: 0 full, 1 tighter, 2 small buttons icon-only, 3 all buttons icon-only. */
const MAX_FIT = 3;

function RBtn({ icon, label, onClick, on, disabled, title }: { icon: ReactNode; label: string; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button className={`rbtn${on ? ' on' : ''}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-pressed={on}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function RSm({ icon, label, onClick, on, disabled, title }: { icon: ReactNode; label: string; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button className={`rbtn-sm${on ? ' on' : ''}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-pressed={on}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rgroup">
      <div className="rgroup-items">{children}</div>
      <div className="rgroup-label">{label}</div>
    </div>
  );
}

const ALL_TABS = [
  ['home', 'Home'],
  ['plot', 'Plot'],
  ['gate', 'Gate'],
  ['layout', 'Layout'],
  ['comp', 'Compensation'],
  ['calib', 'Calibration'],
  ['tables', 'Statistics'],
  ['export', 'Export'],
  ['ai', 'AI'],
] as const;

/** Ribbon tabs that belong to a view of their own (the document tab of the same name). */
const TAB_VIEW: Record<string, View[]> = { comp: ['comp', 'unmix'], calib: ['calib'], tables: ['tables', 'plate'] };
/** Ribbon tabs that work on the worksheet. */
const SHEET_TABS = new Set(['plot', 'gate', 'layout']);
let lastSheetTab = 'home';

/** The ribbon tab that goes with a view: its own tab, else the last worksheet tab used. */
export function ribbonTabForView(view: View, current: string): string {
  for (const [tab, views] of Object.entries(TAB_VIEW)) if (views.includes(view)) return tab;
  return TAB_VIEW[current] ? lastSheetTab : current;
}

/** Select a ribbon tab; tabs with a view of their own show it, worksheet tabs show the worksheet. */
export function selectRibbonTab(tab: string) {
  const st = useStore.getState();
  const patch: Partial<typeof st.ui> = { ribbonTab: tab };
  const views = TAB_VIEW[tab];
  if (views) {
    if (!views.includes(st.ui.view)) patch.view = views[0];
  } else {
    lastSheetTab = tab;
    if (SHEET_TABS.has(tab) && st.ui.view !== 'sheet') patch.view = 'sheet';
  }
  st.setUI(patch);
}

export function Ribbon({ openFcs, openFolder, openWorkspace, importGatingML }: { openFcs: () => void; openFolder: () => void; openWorkspace: () => void; importGatingML: () => void }) {
  const ui = useStore((s) => s.ui);
  const ws = useStore((s) => s.ws);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const st = useStore.getState();
  const sheet = ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
  const [preset, setPreset] = useState(ws.style.preset ?? 'classic');
  const upSheet = (f: (s: typeof sheet) => void) =>
    st.update((w) => {
      const s = w.worksheets.find((x) => x.id === sheet.id);
      if (s) f(s);
    });
  const selIds = ui.selectedItemIds;
  const selPlot = sheet.items.some((i) => i.kind === 'plot' && selIds.includes(i.id));
  // FlowJo counts of the last opened .wsp, while its samples are in the workspace (e.g. not after Undo of the open)
  const fjCounts = ui.flowjoCounts && ws.samples.some((s) => ui.flowjoCounts!.counts[s.id]) ? ui.flowjoCounts : null;
  const setTool = (t: Tool) => st.setUI({ tool: t, view: 'sheet' });
  const tools = calibTools(ws);
  const tool = (t: Tool, icon: ReactNode, label: string, key: string) => <RBtn icon={icon} label={label} on={ui.tool === t} onClick={() => setTool(t)} title={`${label} (${key})`} />;

  const addPlot = (type: PlotType) => {
    // of the current population (selected population, else the selected plot's), on the channels gated there
    const pop = currentPopulation();
    const { fsc, ssc, fl } = pickDefaultChannels(ws, { popId: pop === 'root' ? null : pop });
    const { w: W, h: H } = defaultPlotSize();
    const { x, y } = findFreeSlot(sheet, W, H);
    const xp = type === 'histogram' ? fl[0] ?? fsc : fsc;
    const yp = type === 'histogram' ? xp : ssc;
    const it = newPlotItem(type, xp, yp, x, y, W, H, pop);
    addItems(sheet.id, [it]);
    return it;
  };

  const addStatsBox = () => {
    const g = sheet.grid;
    const pop = currentPopulation();
    const { x, y } = findFreeSlot(sheet, g * 14, g * 6);
    const it: StatsBoxItem = {
      id: uid('stats'),
      kind: 'stats',
      x,
      y,
      w: g * 14,
      h: g * 6,
      sample: 'active',
      fontSize: bodyPt(ws, sheet),
      rows: (pop !== 'root' ? [pop] : ws.populations.slice(0, 4).map((p) => p.id)).map((p) => ({ id: uid('row'), population: p, stat: 'freqParent' as const })),
    };
    addItems(sheet.id, [it]);
  };

  const addChart = () => {
    const g = sheet.grid;
    const { x, y } = findFreeSlot(sheet, g * 14, g * 12);
    const it = newChartItem(x, y, g * 14, g * 12);
    addItems(sheet.id, [it]);
  };

  let body: ReactNode = null;
  // the Calibration tab is hidden when the experiment setup needs no calibration (Home stands in for it)
  const tab = ui.ribbonTab === 'calib' && !tools.mesf && !tools.size ? 'home' : ui.ribbonTab;
  switch (tab) {
    case 'home':
      body = (
        <>
          <Group label="File">
            <RBtn icon={<Icon.fcs />} label="Open FCS" onClick={openFcs} title="Open FCS / LMD files (or drop them anywhere)" />
            <RBtn icon={<Icon.folder />} label="Open folder" onClick={openFolder} title="Open all FCS / LMD files of a folder, e.g. a plate export with a subfolder per plate (or drop the folder anywhere)" />
            <RBtn icon={<Icon.open />} label="Open" onClick={openWorkspace} title="Open a workspace (.json), bundle (.zip), FlowJo workspace (.wsp) or Gating-ML (.xml)" />
            <div className="rstack">
              <RSm icon={<Icon.save />} label="Save workspace" onClick={() => requestSave('json')} title="Save the analysis (gates, layouts, tables) as .json; FCS files are referenced by name (Ctrl+S)" />
              <RSm icon={<Icon.bundle />} label="Save with data" onClick={() => requestSave('bundle')} title="Save workspace plus all FCS files as one .zip that can be re-opened anywhere" />
              <RSm icon={<Icon.plus />} label="New analysis" onClick={() => st.setUI({ dialog: { kind: 'confirmNew' } })} title="Start a new, empty analysis (the open one is kept under Earlier analyses on the start screen)" />
            </div>
          </Group>
          <Group label="Edit">
            <div className="rstack">
              <RSm icon={<Icon.undo />} label="Undo" onClick={st.undo} disabled={!past} title="Undo (Ctrl+Z)" />
              <RSm icon={<Icon.redo />} label="Redo" onClick={st.redo} disabled={!future} title="Redo (Ctrl+Y)" />
              <RSm icon={<Icon.copy />} label="Duplicate" onClick={() => duplicateItems(sheet.id, selIds)} disabled={!selIds.length} title="Duplicate (Ctrl+D)" />
            </div>
            <RBtn icon={<Icon.trash />} label="Delete" onClick={() => deleteSelection()} disabled={!selIds.length && !ui.selectedPopId} title="Delete the selected items, or the selected gate / population (Del)" />
          </Group>
          <Group label="Tools">
            {tool('select', <Icon.cursor />, 'Select', 'V')}
            {tool('autogate', <Icon.wand />, 'Auto gate', 'W')}
            {tool('polygon', <Icon.polygon />, 'Polygon', 'P')}
            {tool('rect', <Icon.rect />, 'Rectangle', 'R')}
            {tool('ellipse', <Icon.ellipse />, 'Ellipse', 'E')}
            {tool('quadrant', <Icon.quadrant />, 'Quadrant', 'Q')}
            {tool('range', <Icon.range />, 'Range', 'H')}
            {tool('split', <Icon.split />, 'Split', 'S')}
            {tool('text', <Icon.text />, 'Text', 'T')}
            {tool('zoom', <Icon.zoomIn />, 'Zoom', 'Z')}
          </Group>
          <Group label="New plot">
            <RBtn icon={<Icon.pseudo />} label="Pseudocolor" onClick={() => addPlot('pseudo')} />
            <RBtn icon={<Icon.histogram />} label="Histogram" onClick={() => addPlot('histogram')} />
          </Group>
          <Group label="View">
            <div className="rstack">
              <RSm icon={<Icon.gate />} label="Gating view" disabled={!selPlot} onClick={() => openGatingView()} title="Show the selected plot large, with all gating tools (Enter, or double-click the plot; Esc closes)" />
              <RSm icon={<Icon.zoomIn />} label="Zoom to selection" disabled={!selIds.length} onClick={() => zoomToSelection()} title="Zoom so the selected items fill the window (F or Shift+2)" />
              <RSm icon={<Icon.fit />} label="Back / fit page" onClick={() => zoomBack()} title="Back to the zoom before Zoom to selection, else fit the page (Shift+1)" />
            </div>
          </Group>
        </>
      );
      break;
    case 'plot':
      body = (
        <>
          <Group label="New plot">
            <RBtn icon={<Icon.dot />} label="Dot" onClick={() => addPlot('dot')} />
            <RBtn icon={<Icon.pseudo />} label="Pseudocolor" onClick={() => addPlot('pseudo')} />
            <RBtn icon={<Icon.density />} label="Density" onClick={() => addPlot('density')} />
            <RBtn icon={<Icon.contour />} label="Contour" onClick={() => addPlot('contour')} />
            <RBtn icon={<ZebraIcon />} label="Zebra" onClick={() => addPlot('zebra')} title="Zebra plot: density contour bands filled with the colormap" />
            <RBtn icon={<Icon.histogram />} label="Histogram" onClick={() => addPlot('histogram')} />
            <RBtn
              icon={<Icon.overlay />}
              label="Overlay"
              title="Histogram overlay of the selected samples (or the active sample and the next)"
              onClick={() => {
                const { w: W, h: H } = defaultPlotSize();
                const p = findFreeSlot(sheet, W, H);
                addItems(sheet.id, [newOverlayPlot(p.x, p.y, W, H)]);
              }}
            />
          </Group>
          <Group label="Axes">
            <RBtn
              icon={<Icon.fit />}
              label="Fit axes to data"
              disabled={!sheet.items.some((i) => i.kind === 'plot') || !ws.samples.length}
              onClick={() => fitAllAxes(sheet.id)}
              title={`Set the range of every axis on this sheet from the events of ${fitSampleLabel()} (0.1 to 99.9 percentile, round ends; transforms are kept). Select several samples in the sample list to fit to all of them.`}
            />
          </Group>
          <Group label="Style">
            <div className="rstack">
              <label className="rfield" title="Style preset: changes only the look (colors, background, axes), never channels, gates, scales or smoothing">
                <select className="sel" style={{ height: 22, width: 168 }} aria-label="Style preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {PRESET_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <RSm icon={<Icon.cursor />} label="Apply to selected plots" disabled={!selIds.length} onClick={() => applyPresetTo(sheet.id, selIds, preset)} />
              <RSm icon={<Icon.sheet />} label="Apply to all plots on sheet" onClick={() => applyPresetTo(sheet.id, 'all', preset)} />
            </div>
          </Group>
          <Group label="Annotate">
            <RBtn icon={<Icon.text />} label="Text" onClick={() => setTool('text')} on={ui.tool === 'text'} />
            <RBtn icon={<Icon.table />} label="Stats box" onClick={addStatsBox} title="Live statistics box on the worksheet" />
            <RBtn icon={<Icon.barchart />} label="Stat chart" onClick={addChart} title="Bar / dot chart of a statistic across samples or groups" />
          </Group>
          <Group label="Worksheets">
            <RBtn icon={<Icon.sheet />} label="New sheet" onClick={() => addSheet()} />
            <div className="rstack">
              <RSm icon={<Icon.copy />} label="Duplicate sheet" onClick={() => duplicateSheet(sheet.id)} />
              <RSm icon={<Icon.trash />} label="Delete sheet…" disabled={ws.worksheets.length < 2} onClick={() => confirmDeleteSheet(sheet.id)} />
            </div>
          </Group>
        </>
      );
      break;
    case 'gate':
      body = (
        <>
          <Group label="Draw gate">
            {tool('select', <Icon.cursor />, 'Select', 'V')}
            {tool('polygon', <Icon.polygon />, 'Polygon', 'P')}
            {tool('rect', <Icon.rect />, 'Rectangle', 'R')}
            {tool('ellipse', <Icon.ellipse />, 'Ellipse', 'E')}
            {tool('quadrant', <Icon.quadrant />, 'Quadrant', 'Q')}
            {tool('range', <Icon.range />, 'Range', 'H')}
            {tool('split', <Icon.split />, 'Split', 'S')}
          </Group>
          <Group label="Combine">
            <RBtn icon={<Icon.bool />} label="Boolean" onClick={() => st.setUI({ dialog: { kind: 'bool' } })} title="Create AND / OR / NOT combinations of populations" />
          </Group>
          <Group label="Gating-ML 2.0">
            <RBtn icon={<Icon.open />} label="Import" onClick={importGatingML} title="Import gates from a Gating-ML 2.0 .xml file" />
            <RBtn icon={<Icon.xml />} label="Export" onClick={exportGatingMLFile} />
          </Group>
          <Group label="Compare">
            <RBtn
              icon={<Icon.table />}
              label="FlowJo counts"
              disabled={!fjCounts}
              onClick={() => st.setUI({ dialog: { kind: 'flowjoCounts' } })}
              title={fjCounts ? `Compare FlowJo's stored counts of ${fjCounts.fileName} with the counts computed here` : 'Open a FlowJo workspace (.wsp) to compare its counts with the counts computed here'}
            />
          </Group>
        </>
      );
      break;
    case 'layout': {
      const many = selIds.length > 1;
      const any = selIds.length > 0;
      const to = many ? '' : ' (one item: on the page)';
      body = (
        <>
          <Group label="Align">
            <div className="rstack">
              <RSm icon={<Icon.alignL />} label="Left" disabled={!any} title={'Align left' + to} onClick={() => arrange(sheet.id, selIds, 'left')} />
              <RSm icon={<Icon.alignC />} label="Center" disabled={!any} title={'Align centers' + to} onClick={() => arrange(sheet.id, selIds, 'hcenter')} />
              <RSm icon={<Icon.alignR />} label="Right" disabled={!any} title={'Align right' + to} onClick={() => arrange(sheet.id, selIds, 'right')} />
            </div>
            <div className="rstack">
              <RSm icon={<Icon.alignT />} label="Top" disabled={!any} title={'Align top' + to} onClick={() => arrange(sheet.id, selIds, 'top')} />
              <RSm icon={<Icon.alignM />} label="Middle" disabled={!any} title={'Align middles' + to} onClick={() => arrange(sheet.id, selIds, 'vcenter')} />
              <RSm icon={<Icon.alignB />} label="Bottom" disabled={!any} title={'Align bottom' + to} onClick={() => arrange(sheet.id, selIds, 'bottom')} />
            </div>
          </Group>
          <Group label="Distribute & size">
            <div className="rstack">
              <RSm icon={<Icon.distH />} label="Distribute horizontally" disabled={selIds.length < 3} onClick={() => arrange(sheet.id, selIds, 'distH')} />
              <RSm icon={<Icon.distV />} label="Distribute vertically" disabled={selIds.length < 3} onClick={() => arrange(sheet.id, selIds, 'distV')} />
              <RSm icon={<Icon.sameSize />} label="Same size" disabled={!many} onClick={() => arrange(sheet.id, selIds, 'sameSize')} title="Make all selected items the size of the last clicked one" />
            </div>
            <RBtn icon={<Icon.arrange />} label="Arrange grid" disabled={!many} onClick={() => arrange(sheet.id, selIds, 'grid')} />
          </Group>
          <Group label="Figure">
            <RBtn icon={<Icon.gate />} label="Strategy sheet" disabled={!ws.populations.length} onClick={() => buildGatingStrategySheet('active')} title="Gating strategy sheet: a new sheet with one plot per gating step, in hierarchy order" />
            <RBtn
              icon={<Icon.text />}
              label="Panel labels"
              disabled={!sheet.items.some((i) => panelLabelKinds(true).includes(i.kind))}
              onClick={() => addPanelLabels(sheet.id, selIds)}
              title="Add A, B, C … in reading order to the selected items, or to all plots and stat charts (select statistics boxes to letter them too)"
            />
          </Group>
          <Group label="Batch">
            <RBtn icon={<Icon.batch />} label="Repeat for samples" disabled={!selIds.length} onClick={() => st.setUI({ dialog: { kind: 'batch', payload: { itemIds: selIds } } })} title="Create a row of the selected plots for every sample" />
          </Group>
          <Group label="Grid">
            <div className="rstack">
              <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <label className="rfield" title="Grid shown on the worksheet (an editing aid, not exported)">
                  <Icon.grid />
                  <select className="sel" style={{ height: 22, width: 74 }} aria-label="Grid style" value={sheetGridStyle(sheet)} onChange={(e) => upSheet((s) => setGridStyle(s, e.target.value as GridStyle))}>
                    <option value="lines">Lines</option>
                    <option value="dots">Dots</option>
                    <option value="none">Blank</option>
                  </select>
                </label>
                <select
                  className="sel"
                  style={{ height: 22, width: 70 }}
                  aria-label="Grid size"
                  title="Grid size"
                  value={String(Math.round((sheet.grid / MM) * 10) / 10)}
                  onChange={(e) => upSheet((s) => {
                    s.grid = Number(e.target.value) * MM;
                  })}
                >
                  {['1', '2', '2.5', '5', '10'].map((v) => (
                    <option key={v} value={v}>
                      {v} mm
                    </option>
                  ))}
                </select>
              </div>
              <RSm
                icon={<Icon.snap />}
                label="Snap to grid"
                on={sheet.snap}
                title="Snap to grid (works with the grid hidden too)"
                onClick={() => upSheet((s) => {
                  s.snap = !s.snap;
                })}
              />
            </div>
          </Group>
          <Group label="Page">
            <div className="rstack">
              <label className="rfield" title="Page color (exported unless switched off in the Inspector)">
                <input type="color" className="color-in" aria-label="Page color" value={sheet.pageColor ?? '#ffffff'} onChange={(e) => upSheet((s) => {
                  s.pageColor = e.target.value.toLowerCase() === '#ffffff' ? undefined : e.target.value;
                })} />
                Page color
              </label>
              <RSm icon={<Icon.image />} label="Grid in exports" on={!!sheet.exportGrid} title="Include the grid in exported figures" onClick={() => upSheet((s) => {
                s.exportGrid = s.exportGrid ? undefined : true;
              })} />
            </div>
          </Group>
          <Group label="Zoom">
            <RBtn icon={<Icon.zoomOut />} label="Out" onClick={() => setZoom(ui.zoom / 1.2)} />
            <RBtn icon={<Icon.zoomIn />} label="In" onClick={() => setZoom(ui.zoom * 1.2)} />
            <RBtn icon={<Icon.fit />} label="100%" onClick={() => setZoom(1)} />
            <div className="rstack">
              <RSm icon={<Icon.fit />} label="Fit page" onClick={() => fitZoom('page')} />
              <RSm icon={<Icon.fit />} label="Fit width" onClick={() => fitZoom('width')} />
              <RSm icon={<Icon.zoomIn />} label="To selection" disabled={!selIds.length} onClick={() => zoomToSelection()} title="Zoom so the selected items fill the window (F or Shift+2; Shift+1 goes back)" />
            </div>
          </Group>
        </>
      );
      break;
    }
    case 'comp':
      body = (
        <>
          <Group label="Compensation">
            <RBtn icon={<Icon.matrix />} label="Matrix editor" on={ui.view === 'comp'} onClick={() => st.setUI({ view: 'comp' })} />
            <RBtn icon={<Icon.wand />} label="From controls" onClick={() => st.setUI({ view: 'comp', dialog: { kind: 'compWizard' } })} title="Compute a spillover matrix from single-stained controls" />
          </Group>
          <Group label="Spectral">
            <RBtn icon={<Icon.spectrum />} label="Unmixing" on={ui.view === 'unmix'} onClick={() => openUnmixView()} title="Spectral unmixing from single-stained controls (also for conventional panels)" />
          </Group>
          <Group label="View">
            <RBtn icon={<Icon.sheet />} label="Worksheet" on={ui.view === 'sheet'} onClick={() => st.setUI({ view: 'sheet' })} />
          </Group>
        </>
      );
      break;
    case 'calib':
      body = (
        <>
          {tools.mesf && (
            <Group label="Fluorescence">
              <RBtn icon={<Icon.beads />} label="MESF / ERF" on={ui.view === 'calib' && (ui.calibMode !== 'size' || !tools.size)} onClick={() => st.setUI({ view: 'calib', calibMode: 'mesf' })} title="Calibrate fluorescence channels in MESF, ERF or ABC units with reference beads" />
            </Group>
          )}
          {tools.size && (
            <Group label="Light scatter">
              <RBtn icon={<Icon.ruler />} label="Size (Mie)" on={ui.view === 'calib' && (ui.calibMode === 'size' || !tools.mesf)} onClick={() => st.setUI({ view: 'calib', calibMode: 'size' })} title="Calibrate side or forward scatter in nm² and particle diameter (Mie theory, e.g. nanoViS beads)" />
            </Group>
          )}
          <Group label="Experiment">
            <RBtn icon={<Icon.gear />} label="Setup" onClick={() => st.setUI({ dialog: { kind: 'setup' } })} title="Kind of experiment and the calibration tools shown (also: the experiment label next to the workspace name)" />
          </Group>
          <Group label="View">
            <RBtn icon={<Icon.sheet />} label="Worksheet" on={ui.view === 'sheet'} onClick={() => st.setUI({ view: 'sheet' })} />
          </Group>
        </>
      );
      break;
    case 'tables':
      body = (
        <>
          <Group label="Statistics tables">
            <RBtn icon={<Icon.table />} label="Table editor" on={ui.view === 'tables'} onClick={() => st.setUI({ view: 'tables' })} />
            <RBtn
              icon={<Icon.plus />}
              label="New table"
              onClick={() => {
                const id = uid('tbl');
                st.update((w) => {
                  w.tables.push({
                    id,
                    name: `Table ${w.tables.length + 1}`,
                    sampleSet: 'all',
                    columns: w.populations.slice(0, 6).map((p) => ({ id: uid('col'), population: p.id, stat: 'freqParent' as const })),
                  });
                });
                st.setUI({ view: 'tables', activeTableId: id });
              }}
            />
            <RBtn
              icon={<Icon.plus />}
              label="MFI table"
              title="Table with count, % parent and the median of every fluorescence channel for the selected populations"
              onClick={() => openMfiTableDialog()}
            />
          </Group>
          <Group label="Plates">
            <RBtn icon={<Icon.plate />} label="Plates" on={ui.view === 'plate'} onClick={() => st.setUI({ view: 'plate' })} title="Heatmap of a statistic over the wells of the plates; plate layout; export" />
            <RBtn icon={<Icon.wand />} label="Re-detect wells" onClick={() => redetectWells()} title="Detect plates and wells again from the FCS keywords, sample names and folders (wells set by hand are kept)" />
          </Group>
          <Group label="Annotate">
            <RBtn icon={<Icon.table />} label="Stats box" onClick={addStatsBox} />
          </Group>
          <Group label="View">
            <RBtn icon={<Icon.sheet />} label="Worksheet" on={ui.view === 'sheet'} onClick={() => st.setUI({ view: 'sheet' })} />
          </Group>
        </>
      );
      break;
    case 'ai':
      body = <AiRibbonGroups />;
      break;
    case 'export':
      body = (
        <>
          <Group label="Figure">
            <RBtn icon={<Icon.svg />} label="SVG" onClick={() => st.setUI({ dialog: { kind: 'export', payload: { format: 'svg' } } })} title="Vector graphic with editable text (Illustrator, Inkscape)" />
            <RBtn icon={<Icon.pdf />} label="PDF" onClick={() => st.setUI({ dialog: { kind: 'export', payload: { format: 'pdf' } } })} />
            <RBtn icon={<Icon.image />} label="PNG" onClick={() => st.setUI({ dialog: { kind: 'export', payload: { format: 'png' } } })} title="High-resolution bitmap (150 to 1200 dpi) with the resolution stored in the file" />
            <RBtn icon={<Icon.tiff />} label="TIFF" onClick={() => st.setUI({ dialog: { kind: 'export', payload: { format: 'tiff' } } })} title="TIFF for journal submission: RGB, LZW compressed, 150 to 1200 dpi" />
          </Group>
          <Group label="Data">
            <RBtn icon={<Icon.fcs />} label="Populations" onClick={() => st.setUI({ dialog: { kind: 'exportPop', payload: { popId: ui.selectedPopId ?? 'root' } } })} title="Export gated events as FCS or CSV" />
            <RBtn icon={<Icon.table />} label="Tables" onClick={() => st.setUI({ view: 'tables' })} />
            <RBtn icon={<Icon.xml />} label="Gating-ML" onClick={exportGatingMLFile} />
          </Group>
          <Group label="Workspace">
            <RBtn icon={<Icon.save />} label="Workspace" onClick={() => requestSave('json')} />
            <RBtn icon={<Icon.bundle />} label="With data" onClick={() => requestSave('bundle')} />
            <RBtn icon={<Icon.layers />} label="Template" onClick={() => requestSave('template')} title="Gating strategy, layouts and tables without data. Open it and add new FCS files to analyse them the same way." />
          </Group>
        </>
      );
      break;
  }

  return <RibbonFrame tab={tab} body={body} showCalib={tools.mesf || tools.size} />;
}

/**
 * Tab row and body of the ribbon. The body gets more compact step by step when the window is narrow; groups that still
 * do not fit go into a "More" menu (no horizontal scrolling). Minimized, the tabs open the body as an overlay.
 */
function RibbonFrame({ tab, body, showCalib }: { tab: string; body: ReactNode; showCalib: boolean }) {
  const TABS = ALL_TABS.filter(([k]) => k !== 'calib' || showCalib);
  const lay = useLayout();
  const short = useMedia(SHORT_QUERY);
  // touch screens show no tooltips: large buttons keep their labels (what does not fit goes into More)
  const coarse = useMedia('(pointer: coarse)');
  const maxFit = coarse ? 2 : MAX_FIT;
  const minimized = ribbonMinimized(lay, short);
  const showBody = !minimized || lay.ribbonPeek;
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ level: number; hideFrom: number }>({ level: 0, hideFrom: Infinity });
  const [more, setMore] = useState<{ right: number; top: number } | null>(null);
  const [size, setSize] = useState(() => `${window.innerWidth}x${window.innerHeight}`);
  useEffect(() => {
    const on = () => setSize(`${window.innerWidth}x${window.innerHeight}`);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // measure: the least compact level at which everything fits, else hide the groups that do not fit
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !showBody) return;
    const groups = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('rgroup'));
    for (const g of groups) g.style.display = '';
    el.dataset.more = '';
    let level = 0;
    for (; level <= maxFit; level++) {
      el.dataset.fit = String(level);
      if (el.scrollWidth <= el.clientWidth + 1) break;
    }
    let hideFrom = Infinity;
    if (level > maxFit) {
      level = maxFit;
      el.dataset.fit = String(level);
      el.dataset.more = '1';
      const moreW = 64;
      const limit = el.getBoundingClientRect().left + el.clientWidth - moreW;
      const i = groups.findIndex((g) => g.getBoundingClientRect().right > limit);
      hideFrom = i < 0 ? Infinity : i;
      groups.forEach((g, k) => (g.style.display = k >= hideFrom ? 'none' : ''));
    }
    setFit((f) => (f.level === level && f.hideFrom === hideFrom ? f : { level, hideFrom }));
  }, [tab, size, showBody, minimized, maxFit]);

  // groups already in the bar are hidden in the More menu
  const moreRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    Array.from(el.children).forEach((c, k) => c instanceof HTMLElement && c.classList.contains('rgroup') && (c.style.display = k < fit.hideFrom ? 'none' : ''));
  });

  // the More menu and the peeking (minimized) ribbon close on a press outside, on Escape and after a command
  useEffect(() => {
    if (!more && !lay.ribbonPeek) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.ribbon-more, .ribbon-more-btn')) return;
      if (more) setMore(null);
      if (lay.ribbonPeek && !t?.closest?.('.ribbon')) useLayout.getState().set({ ribbonPeek: false });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (more) setMore(null);
      else useLayout.getState().set({ ribbonPeek: false });
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [more, lay.ribbonPeek]);
  useEffect(() => setMore(null), [tab, size]);

  const afterCommand = (e: React.MouseEvent) => {
    const b = (e.target as Element).closest('button');
    if (!b || b.classList.contains('ribbon-more-btn')) return;
    if (more) setMore(null);
    if (lay.ribbonPeek) useLayout.getState().set({ ribbonPeek: false });
  };

  const hidden = Number.isFinite(fit.hideFrom);
  return (
    <div ref={frameRef} className={`ribbon${minimized ? ' min' : ''}${lay.ribbonPeek && minimized ? ' peek' : ''}`}>
      <div className="ribbon-tabs" role="tablist" aria-label="Ribbon">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`ribbon-tab${tab === k ? ' on' : ''}`}
            tabIndex={tab === k ? 0 : -1}
            onKeyDown={(e) => {
              // arrow keys move between the tabs (one Tab stop for the whole row)
              const i = TABS.findIndex(([t]) => t === k);
              const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -2;
              if (j === -2) return;
              e.preventDefault();
              e.stopPropagation();
              const next = TABS[(j + TABS.length) % TABS.length][0];
              const row = e.currentTarget.parentElement;
              selectRibbonTab(next);
              requestAnimationFrame(() => (row?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus());
            }}
            data-tab={k}
            title={minimized ? `${label} (the ribbon is minimized: double-click a tab or press Ctrl+F1 to keep it open)` : undefined}
            onClick={() => {
              if (minimized) useLayout.getState().set({ ribbonPeek: !(lay.ribbonPeek && tab === k) });
              selectRibbonTab(k);
            }}
            onDoubleClick={() => toggleRibbon()}
          >
            {label}
          </button>
        ))}
        <span className="grow" />
        <button
          className="icon-btn ribbon-pin"
          aria-label={minimized ? 'Show the ribbon' : 'Minimize the ribbon'}
          title={minimized ? 'Show the ribbon (Ctrl+F1)' : 'Minimize the ribbon to its tabs (Ctrl+F1)'}
          aria-pressed={!minimized}
          onClick={() => toggleRibbon()}
        >
          {minimized ? <ShellIcon.chevronDown /> : <ShellIcon.chevronUp />}
        </button>
      </div>
      {showBody && (
        <div ref={bodyRef} className="ribbon-body" data-fit={fit.level} role="group" aria-label="Ribbon commands" onClick={afterCommand}>
          {body}
          {hidden && (
            <button
              className="rbtn ribbon-more-btn"
              aria-haspopup="true"
              aria-expanded={!!more}
              title="More commands of this tab"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMore(more ? null : { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 });
              }}
            >
              <ShellIcon.more />
              <span>More</span>
            </button>
          )}
        </div>
      )}
      {more && showBody && (
        <div ref={moreRef} className="ribbon-more" role="group" aria-label="More commands" style={{ right: more.right, top: more.top, maxHeight: `calc(100vh - ${more.top + 8}px)` }} onClick={afterCommand}>
          {body}
        </div>
      )}
    </div>
  );
}

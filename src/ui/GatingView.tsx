// Gating view: one plot of the worksheet shown large over the worksheet (about 70-80 % of the window), with the gating
// tools. It is the same plot item and the same gates: everything drawn or edited here is the normal workspace content.
// Opened with Enter on a selected plot, a double-click on a plot's empty data area, or the ribbon / status bar button;
// closed with Esc or the close button.
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { engine } from '../core/engine';
import { channelDisplayName, popById, type PlotItem } from '../core/model';
import { useStore, type Tool } from '../state/store';
import { Icon } from './icons';
import { PlotView } from './PlotView';
import { ParamPicker, RenameBox } from './SheetView';

/** Open the gating view on a plot of the active sheet (selects it). */
export function openGatingView(itemId?: string) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  const id = itemId ?? st.ui.selectedItemIds.find((i) => sheet?.items.some((x) => x.id === i && x.kind === 'plot'));
  const it = id ? sheet?.items.find((x) => x.id === id) : undefined;
  if (!it || it.kind !== 'plot') {
    st.toast('Select a plot first: the gating view shows it large, with all gating tools.', 'info');
    return;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  st.setUI({ view: 'sheet', gatingItemId: it.id, selectedItemIds: [it.id], keyItemId: it.id });
}

export function closeGatingView() {
  useStore.getState().setUI({ gatingItemId: null });
}

const TOOLS: [Tool, ReactNode, string, string][] = [
  ['select', <Icon.cursor key="s" />, 'Select', 'V'],
  ['autogate', <Icon.wand key="w" />, 'Auto gate', 'W'],
  ['polygon', <Icon.polygon key="p" />, 'Polygon', 'P'],
  ['rect', <Icon.rect key="r" />, 'Rectangle', 'R'],
  ['ellipse', <Icon.ellipse key="e" />, 'Ellipse', 'E'],
  ['quadrant', <Icon.quadrant key="q" />, 'Quadrant', 'Q'],
  ['range', <Icon.range key="h" />, 'Range', 'H'],
  ['split', <Icon.split key="sp" />, 'Split', 'S'],
  ['zoom', <Icon.zoomIn key="z" />, 'Zoom', 'Z'],
];

function useWindowSize() {
  const [s, setS] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setS({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return s;
}

export function GatingView() {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const win = useWindowSize();
  const [picker, setPicker] = useState<{ itemId: string; axis: 'x' | 'y'; x: number; y: number } | null>(null);
  const sheet = ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
  const item = ui.gatingItemId ? (sheet?.items.find((i) => i.id === ui.gatingItemId) as PlotItem | undefined) : undefined;
  const plots = (sheet?.items.filter((i) => i.kind === 'plot') ?? []) as PlotItem[];
  // the plot left the sheet (deleted, other sheet shown): close
  useLayoutEffect(() => {
    if (ui.gatingItemId && (!item || item.kind !== 'plot')) useStore.getState().setUI({ gatingItemId: null });
  }, [ui.gatingItemId, item]);
  if (!item || item.kind !== 'plot' || ui.view !== 'sheet') return null;

  // the plot frame grows to ~75 % of the window; text grows less (at most 1.5x), so the data get the room
  const maxW = Math.max(200, win.w * 0.78 - 32);
  const maxH = Math.max(160, win.h * 0.78 - 96);
  const fit = Math.max(1, Math.min(maxW / item.w, maxH / item.h));
  const zf = Math.min(fit, 1.5);
  const k = fit / zf;
  const shown: PlotItem = { ...item, w: item.w * k, h: item.h * k };
  const W = shown.w * zf;
  const H = shown.h * zf;
  const st = useStore.getState();
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const grp = ws.groups.find((g) => g.id === ui.sampleFilter);
  const steps = loaded.filter((s) => !grp || grp.sampleIds.includes(s.id));
  const pinned = item.layers[0] && item.layers[0].sample !== 'active' ? item.layers[0].sample : null;
  const sid = pinned ?? ui.activeSampleId;
  const sample = ws.samples.find((s) => s.id === sid);
  const step = (d: number) => {
    const i = steps.findIndex((s) => s.id === ui.activeSampleId);
    const n = Math.min(steps.length - 1, Math.max(0, i + d));
    if (steps[n]) st.setUI({ activeSampleId: steps[n].id, selectedSampleIds: [steps[n].id] });
  };
  const pi = plots.findIndex((p) => p.id === item.id);
  const goPlot = (d: number) => {
    const p = plots[(pi + d + plots.length) % plots.length];
    if (p) st.setUI({ gatingItemId: p.id, selectedItemIds: [p.id], keyItemId: p.id, selectedPopId: null });
  };
  const pop = item.layers[0]?.population;
  const popName = !pop || pop === 'root' ? 'All Events' : popById(ws, pop)?.name ?? '?';
  const axes = item.plotType === 'histogram' ? channelDisplayName(ws, item.xParam) : `${channelDisplayName(ws, item.xParam)} vs ${channelDisplayName(ws, item.yParam)}`;
  const rename = ui.dialog?.kind === 'renamePop' ? (ui.dialog.payload as { popId: string; itemId: string; x: number; y: number }) : null;
  const blurAfter = (f: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    f();
    e.currentTarget.blur(); // keys go to the shortcuts again
  };
  return (
    <div
      className="gv-back"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeGatingView();
      }}
    >
      <div className="gv" role="dialog" aria-label="Gating view" aria-modal="false">
        <div className="gv-head">
          <div className="gv-title">
            <b>{popName}</b>
            <span>{axes}</span>
          </div>
          <span className="grow" />
          <div className="gv-tools" role="toolbar" aria-label="Gating tools">
            {TOOLS.map(([t, ic, label, key]) => (
              <button key={t} className={`icon-btn${ui.tool === t ? ' on' : ''}`} aria-pressed={ui.tool === t} title={`${label} (${key})`} aria-label={label} onClick={blurAfter(() => st.setUI({ tool: t }))}>
                {ic}
              </button>
            ))}
          </div>
          <button className="icon-btn" title="Close the gating view (Esc)" aria-label="Close the gating view" onClick={closeGatingView}>
            <Icon.close />
          </button>
        </div>
        <div className="gv-body">
          {/* the page color behind the plot: a plot with an automatic or transparent background takes its text color from the page */}
          <div className="item gv-plot" style={{ width: W, height: H, background: sheet.pageColor ?? '#ffffff' }}>
            <PlotView item={shown} zoom={zf} sheetId={sheet.id} inGatingView labelLayoutSize={{ w: item.w, h: item.h }} onPickAxis={(axis, x, y) => setPicker({ itemId: item.id, axis, x, y })} />
            {rename && rename.itemId === item.id && <RenameBox payload={{ ...rename, x: rename.x - item.x, y: rename.y - item.y }} zoom={zf} />}
          </div>
        </div>
        <div className="gv-foot">
          <button className="icon-btn" aria-label="Previous sample" title="Previous sample (Alt+↑)" disabled={!!pinned || steps.length < 2} onClick={blurAfter(() => step(-1))}>
            <span className="gv-rot">
              <Icon.right />
            </span>
          </button>
          <span className="gv-sample" title={pinned ? 'This plot is pinned to one sample' : 'The active sample'}>
            {sample ? sample.name : 'No sample'}
            {pinned ? ' (pinned)' : ''}
          </span>
          <button className="icon-btn" aria-label="Next sample" title="Next sample (Alt+↓)" disabled={!!pinned || steps.length < 2} onClick={blurAfter(() => step(1))}>
            <Icon.right />
          </button>
          <span className="grow" />
          <span className="hint">Double-click a gate for the next plot · Esc closes</span>
          <span className="grow" />
          <button className="btn sm" disabled={plots.length < 2} onClick={blurAfter(() => goPlot(-1))} title="Previous plot of the worksheet">
            Previous plot
          </button>
          <span className="hint num">
            {pi + 1} / {plots.length}
          </span>
          <button className="btn sm" disabled={plots.length < 2} onClick={blurAfter(() => goPlot(1))} title="Next plot of the worksheet">
            Next plot
          </button>
        </div>
      </div>
      {picker && <ParamPicker picker={picker} sheet={sheet} onClose={() => setPicker(null)} />}
    </div>
  );
}

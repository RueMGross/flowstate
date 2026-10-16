// Open a plot of a population (double-click in the population tree, as in FlowJo).
import { popById, type PlotItem } from '../core/model';
import { newPlotItem, useStore } from '../state/store';
import { addPlotAt, populationPlotSpec, revealItems } from './layoutOps';

/**
 * Show a population in a plot on the active worksheet: an existing plot of it on the same axes is selected and scrolled
 * into view, else a new plot is placed at a free slot (see populationPlotSpec).
 */
export function openPopulationPlot(popId: string): PlotItem | null {
  const st = useStore.getState();
  const ws = st.ws;
  if (popId !== 'root' && !popById(ws, popId)) return null;
  const sheet = ws.worksheets.find((s) => s.id === st.ui.activeSheetId) ?? ws.worksheets[0];
  if (!sheet) return null;
  const ax = populationPlotSpec(ws, popId);
  const same = sheet.items.find(
    (i): i is PlotItem =>
      i.kind === 'plot' &&
      (i.layers.find((l) => l.visible !== false)?.population ?? 'root') === popId &&
      i.xParam === ax.x &&
      (ax.type === 'histogram' ? i.plotType === 'histogram' : i.plotType !== 'histogram' && i.yParam === ax.y),
  );
  if (same) {
    st.setUI({ view: 'sheet', activeSheetId: sheet.id, selectedItemIds: [same.id], keyItemId: same.id });
    revealItems([same.id]);
    return same;
  }
  if (st.ui.view !== 'sheet') st.setUI({ view: 'sheet' });
  return addPlotAt(sheet.id, (x, y, w, h) => newPlotItem(ax.type, ax.x, ax.y, x, y, w, h, popId));
}

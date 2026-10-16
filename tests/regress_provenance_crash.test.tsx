// Regression (review 3): repair kept a damaged gate provenance (only "is an object" was checked); the plot view then
// threw while rendering (aiGateNotes reads provenance.date.slice).
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { emptyWorkspace } from '../src/core/model';
import { parseWorkspace, serializeWorkspace, workspaceRepairNotes } from '../src/io/files';
import { newPlotItem, useStore } from '../src/state/store';
import { PlotView } from '../src/ui/PlotView';

it('a workspace whose gate provenance lacks fields opens and renders', () => {
  const ws = emptyWorkspace();
  const plot = newPlotItem('dot', 'FSC-A', 'SSC-A', 0, 0, 200, 200);
  ws.worksheets[0].items.push(plot);
  ws.populations = [{ id: 'p', name: 'P', parentId: null, color: '#000', gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 0, xmax: 1, ymin: 0, ymax: 1 }, provenance: { model: 'm' } as never }];
  const opened = parseWorkspace(serializeWorkspace(ws));
  expect(opened.populations[0].provenance).toBeUndefined();
  expect(workspaceRepairNotes(opened).join(' ')).toMatch(/origin note/);
  useStore.getState().replaceWorkspace(opened);
  // server rendering reads the store's initial state: make it the opened workspace
  Object.assign((useStore as unknown as { getInitialState: () => { ws: object } }).getInitialState().ws, useStore.getState().ws);
  const item = useStore.getState().ws.worksheets[0].items[0];
  expect(() => renderToString(createElement(PlotView, { item: item as never, zoom: 1, sheetId: useStore.getState().ws.worksheets[0].id, onPickAxis: (() => undefined) as never }))).not.toThrow();
});

it('a valid provenance is kept; damaged optional fields are dropped', () => {
  const ws = emptyWorkspace();
  ws.populations = [
    {
      id: 'p',
      name: 'P',
      parentId: null,
      color: '#000',
      gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 0, xmax: 1, ymin: 0, ymax: 1 },
      provenance: { method: 'ai-autogate', model: 'm', date: '2026-10-12T10:00:00Z', target: 'Lymphocytes', confidence: 7, seed: [0.1, 'x'], alpha: 0.5 } as never,
    },
  ];
  const opened = parseWorkspace(serializeWorkspace(ws));
  expect(opened.populations[0].provenance).toEqual({ method: 'ai-autogate', model: 'm', date: '2026-10-12T10:00:00Z', target: 'Lymphocytes', alpha: 0.5 });
});

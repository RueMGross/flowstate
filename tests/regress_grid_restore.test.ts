// Regression (review 3, LOW, perf/memory): after a FlowJo workspace was saved and reopened (or restored from the
// session), every polygon's grid scale was its own object: the engine computed and cached one display array per gate
// instead of one per channel (gateGridBase only knew the objects made at import time). Skipped without FlowKit's data.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Engine } from '../src/core/engine';
import { parseFcs } from '../src/core/fcs';
import { flowJoChannelRenames, importFlowJo, renameWorkspaceChannels } from '../src/core/flowjo';
import { parseWorkspace, serializeWorkspace } from '../src/io/files';
import type { Workspace } from '../src/core/model';

const DIR = '/tmp/claude-0/dl/FlowKit/data/8_color_data_set';
it.skipIf(!existsSync(join(DIR, '8_color_ICS.wsp')))('display arrays after reopening a FlowJo workspace', () => {
  const res = importFlowJo(readFileSync(join(DIR, '8_color_ICS.wsp'), 'utf8'));
  const ws0: Workspace = res.workspace;
  const files = readdirSync(join(DIR, 'fcs_files'));
  const s = ws0.samples.find((x) => files.includes(x.fileName))!;
  const b = readFileSync(join(DIR, 'fcs_files', s.fileName));
  const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  renameWorkspaceChannels(ws0, flowJoChannelRenames(s.channels.map((c) => c.name), ds.channels.map((c) => c.name)));
  const run = (ws: Workspace) => {
    const e = new Engine();
    e.addSample(s.id, ds);
    const counts = ws.populations.map((p) => e.count(ws, s.id, p.id));
    return { counts, disp: e.memory().byKind.disp };
  };
  const a = run(ws0);
  const ws1 = parseWorkspace(serializeWorkspace(ws0));
  const r = run(ws1);

  expect(r.counts).toEqual(a.counts);
  expect(r.disp.n).toBe(a.disp.n);
});

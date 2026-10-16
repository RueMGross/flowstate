import { emptyWorkspace, type Workspace } from '../src/core/model';
import { parseWorkspace, serializeWorkspace } from '../src/io/files';

function ws(): Workspace {
  const w = emptyWorkspace();
  w.worksheets[0].items.push({ kind: 'text', id: 't1', x: 0, y: 0, w: 10, h: 10, text: 'Infinity', fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' });
  w.populations.push(
    { id: 'p1', name: 'Infinity', parentId: null, color: '#000', gate: { type: 'rect', x: 'Infinity', y: 'B', xmin: 5, xmax: Infinity, ymin: -Infinity, ymax: 3 } },
    { id: 'p2', name: 'r', parentId: 'p1', color: '#000', gate: { type: 'range', x: 'A', min: -Infinity, max: 7 }, overrides: { s1: { type: 'range', x: 'A', min: 1, max: Infinity } } },
  );
  w.channelLabels['A'] = '-Infinity';
  return w;
}

describe('workspace JSON', () => {
  it('round-trips infinite numbers and leaves strings alone', () => {
    const back = parseWorkspace(serializeWorkspace(ws()));
    const t = back.worksheets[0].items[0];
    expect(t.kind === 'text' && t.text).toBe('Infinity');
    expect(back.channelLabels['A']).toBe('-Infinity');
    expect(back.populations[0].name).toBe('Infinity');
    expect(back.populations[0].gate).toEqual({ type: 'rect', x: 'Infinity', y: 'B', xmin: 5, xmax: Infinity, ymin: -Infinity, ymax: 3 });
    expect(back.populations[1].gate).toEqual({ type: 'range', x: 'A', min: -Infinity, max: 7 });
    expect(back.populations[1].overrides!.s1).toEqual({ type: 'range', x: 'A', min: 1, max: Infinity });
  });
  it('stores non-finite numbers as {"$n": ...}', () => {
    const s = serializeWorkspace(ws());
    expect(s).toContain('"xmax":{"$n":"Infinity"}');
    expect(s).toContain('"ymin":{"$n":"-Infinity"}');
    expect(s).toContain('"text":"Infinity"');
  });
  it('reads version 1 files with "Infinity" strings in gates', () => {
    const legacy = JSON.parse(JSON.stringify(ws(), (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v)));
    legacy.app = 'FlowCanvas';
    legacy.version = 1;
    const back = parseWorkspace(JSON.stringify(legacy));
    expect(back.populations[0].gate).toEqual({ type: 'rect', x: 'Infinity', y: 'B', xmin: 5, xmax: Infinity, ymin: -Infinity, ymax: 3 });
    expect(back.populations[1].overrides!.s1).toEqual({ type: 'range', x: 'A', min: 1, max: Infinity });
    const t = back.worksheets[0].items[0];
    expect(t.kind === 'text' && t.text).toBe('Infinity');
    expect(back.channelLabels['A']).toBe('-Infinity');
  });
});

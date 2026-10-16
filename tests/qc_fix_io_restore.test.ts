// QC fix: files opened while the last session is being restored are added to it once it is there (they used to go into
// the empty start workspace and be dropped when the restored one replaced it). IndexedDB: fake-indexeddb.
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

const G = globalThis as unknown as Record<string, unknown>;
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

async function freshModules() {
  const { writeFcs } = await import('../src/core/fcs');
  const { engine } = await import('../src/core/engine');
  const { emptyWorkspace } = await import('../src/core/model');
  const { restoreSession, startAutosave } = await import('../src/io/session');
  const { openFiles, openFilesInteractive } = await import('../src/io/files');
  const { loadFcsFiles, useStore } = await import('../src/state/store');
  const fcs = (name: string, n = 300) =>
    new File([writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', range: 262144 }], data: [new Float32Array(n).fill(5), new Float32Array(n).fill(7)], keywords: {} }) as BlobPart], name);
  return { engine, emptyWorkspace, fcs, restoreSession, startAutosave, openFiles, openFilesInteractive, loadFcsFiles, useStore };
}

describe('files opened while the last session is restored', () => {
  const ls = new Map<string, string>();
  beforeAll(() => {
    G.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, String(v)), removeItem: (k: string) => void ls.delete(k) };
    G.window = { addEventListener: () => undefined };
    G.document = { addEventListener: () => undefined, visibilityState: 'visible' };
  });

  it('are added to the restored workspace (loadFcsFiles, openFiles, a drop)', async () => {
    {
      const m = await freshModules();
      m.useStore.getState().replaceWorkspace(m.emptyWorkspace());
      m.startAutosave();
      await m.loadFcsFiles([m.fcs('old1.fcs'), m.fcs('old2.fcs')]);
      m.useStore.getState().update((w) => {
        w.name = 'Old session';
      });
      await settle();
    }
    // a reload: fresh modules (store, engine, session), the same browser database
    vi.resetModules();
    const m = await freshModules();
    const restoring = m.restoreSession();
    const loading = m.loadFcsFiles([m.fcs('new.fcs', 200)]);
    const opening = m.openFiles([m.fcs('other.fcs', 100)]);
    const dropped = m.openFilesInteractive([m.fcs('dropped.fcs', 50)]);
    const [r, ids] = await Promise.all([restoring, loading, opening, dropped]);
    expect(r.status).toBe('restored');
    const st = m.useStore.getState();
    expect(st.ws.name).toBe('Old session');
    expect(st.ws.samples.map((s) => s.fileName).sort()).toEqual(['dropped.fcs', 'new.fcs', 'old1.fcs', 'old2.fcs', 'other.fcs']);
    expect(ids).toHaveLength(1);
    expect(m.engine.has(ids[0])).toBe(true);
    expect(st.ws.samples.every((s) => m.engine.has(s.id))).toBe(true);
    expect(st.ui.toasts.some((t) => /added once the last session is restored/.test(t.text))).toBe(true);
  });
});

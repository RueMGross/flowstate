// Earlier analyses of the start screen: the current session is kept (workspace and files) when something else is
// started, listed, opened again with its data, and deleted with the files only it used. IndexedDB: fake-indexeddb.
import 'fake-indexeddb/auto';
import { writeFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { newBlankWorkspace } from '../src/io/files';
import { archiveCurrent, currentSessionInfo, deleteRecent, listRecent, openRecent, RECENT_MAX, recentBytes, recentMetaOf, restoreSession, startAutosave } from '../src/io/session';
import { loadDemo } from '../src/state/demo';
import { loadFcsFiles, useStore } from '../src/state/store';
import { autoName } from '../src/ui/saveOps';

const G = globalThis as unknown as Record<string, unknown>;
const st = () => useStore.getState();

function fcs(name: string, kw: Record<string, string> = {}, n = 300) {
  const a = new Float32Array(n).map((_, i) => 1000 + i);
  const b = new Float32Array(n).map((_, i) => (i % 7) * 100);
  return new File([writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', range: 262144 }], data: [a, b], keywords: { $CYT: 'CytoFLEX', ...kw } }) as BlobPart], name);
}

/** Let the autosave timer (800 ms) and the IndexedDB transactions run. */
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

async function storedFileKeys(): Promise<string[]> {
  return new Promise((resolve) => {
    const req = indexedDB.open('flowcanvas-session', 2);
    req.onsuccess = () => {
      const t = req.result.transaction('files', 'readonly').objectStore('files').getAllKeys();
      t.onsuccess = () => resolve(t.result as string[]);
    };
  });
}

describe('earlier analyses (start screen)', () => {
  const ls = new Map<string, string>();
  beforeAll(() => {
    G.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, String(v)), removeItem: (k: string) => void ls.delete(k) };
    G.window = { addEventListener: () => undefined };
    G.document = { addEventListener: () => undefined, visibilityState: 'visible' };
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    st().replaceWorkspace(emptyWorkspace());
    startAutosave();
  });
  afterAll(() => {
    delete G.localStorage;
    delete G.window;
    delete G.document;
  });

  it('keeps the analysis with its files when a new one starts, lists it, and opens it again with its data', async () => {
    await loadFcsFiles([fcs('01-Well-A1.fcs', { $PROJ: 'Screen 1' }), fcs('01-Well-A2.fcs', { $PROJ: 'Screen 1' })]);
    st().update((w) => {
      w.name = 'Screen 1';
    });
    await settle();
    expect((await currentSessionInfo())?.samples).toBe(2);

    // a new analysis: the first one moves to the list (files kept)
    newBlankWorkspace();
    await settle(300);
    const list = await listRecent();
    expect(list.map((r) => [r.name, r.samples, r.files, r.plates])).toEqual([['Screen 1', 2, 2, 1]]);
    expect(list[0].bytes).toBeGreaterThan(0);
    expect(await currentSessionInfo()).toBeNull();
    expect((await storedFileKeys()).length).toBe(2);

    // a second analysis, then back to the first: the second one is kept in its place
    await loadFcsFiles([fcs('B1.fcs'), fcs('B2.fcs'), fcs('B3.fcs')]);
    st().update((w) => {
      w.name = 'Second';
    });
    await settle();
    expect(await openRecent(list[0].id)).toBe(true);
    expect(st().ws.name).toBe('Screen 1');
    expect(st().ws.samples.every((s) => engine.has(s.id))).toBe(true);
    expect((await listRecent()).map((r) => r.name)).toEqual(['Second']);
    expect((await currentSessionInfo())?.name).toBe('Screen 1');
    expect((await storedFileKeys()).length).toBe(5);
  });

  it('the example is never kept; deleting an earlier analysis frees its files', async () => {
    newBlankWorkspace();
    await settle(300);
    loadDemo();
    await settle();
    expect(await archiveCurrent()).toBe(false);
    const names = (await listRecent()).map((r) => r.name).sort();
    expect(names).toEqual(['Screen 1', 'Second']);
    const second = (await listRecent()).find((r) => r.name === 'Second')!;
    await deleteRecent(second.id);
    expect((await listRecent()).map((r) => r.name)).toEqual(['Screen 1']);
    expect((await storedFileKeys()).length).toBe(2);
  });

  it('at the start screen (nothing open) opening an earlier analysis keeps the stored session', async () => {
    const first = (await listRecent())[0];
    await openRecent(first.id);
    await settle();
    // as after a reload: nothing open, the session stored
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    st().replaceWorkspace(emptyWorkspace());
    expect((await currentSessionInfo())?.name).toBe('Screen 1');
    await loadFcsFiles([]);
    // nothing earlier to open but the session itself: it is restored by "Continue"
    expect((await restoreSession()).status).toBe('restored');
    expect(st().ws.samples.length).toBe(2);
  });
});

describe('a full list', () => {
  it('opening the oldest of a full list keeps its files (the limit trims others, never the one opened)', async () => {
    for (let i = 0; i < RECENT_MAX + 1; i++) {
      newBlankWorkspace();
      await settle(150);
      await loadFcsFiles([fcs(`run${i}_A1.fcs`)]);
      st().update((w) => {
        w.name = `Run ${i}`;
      });
      await settle(1000);
    }
    // the list is full and the last run is open
    const list = await listRecent();
    expect(list.length).toBe(RECENT_MAX);
    expect(st().ws.name).toBe(`Run ${RECENT_MAX}`);
    const oldest = list[list.length - 1];
    expect(await openRecent(oldest.id)).toBe(true);
    expect(st().ws.samples.every((x) => engine.has(x.id))).toBe(true);
    await settle(300);
    expect((await listRecent()).length).toBe(RECENT_MAX);
    // shared files count once in the total
    expect(await recentBytes()).toBeGreaterThan(0);
  }, 60000);
});

describe('what the start screen shows of a workspace', () => {
  it('counts, plates, instruments and stored files from the workspace text', () => {
    const json = JSON.stringify({
      name: 'Exp 7',
      savedAt: '2026-10-12T10:00:00.000Z',
      samples: [
        { id: 'a', name: '01-Well-A1', fileSize: 1000, plate: 'Plate 1', info: { Cytometer: 'CytoFLEX' } },
        { id: 'b', name: '01-Well-A2', fileSize: 2000, plate: 'Plate 1' },
        { id: 'c', name: '02-Well-A1', fileSize: 4000, plate: 'Plate 2' },
      ],
      populations: [{}, {}],
    });
    expect(recentMetaOf(json, 0, new Set(['a', 'c']))).toMatchObject({ name: 'Exp 7', samples: 3, plates: 2, populations: 2, files: 2, bytes: 5000, instruments: ['CytoFLEX'], savedAt: Date.parse('2026-10-12T10:00:00.000Z') });
    expect(recentMetaOf('not json', 0, new Set())).toBeNull();
  });

  it('names a new analysis after its experiment, folder or samples, with the date', () => {
    const ws = emptyWorkspace();
    ws.samples = ['A1', 'A2', 'A3'].map((w, i) => ({ id: 's' + i, name: `01-Well-${w}`, fileName: `01-Well-${w}.fcs`, fileSize: 1, eventCount: 1, channels: [], compId: null, info: { Date: '12-OCT-2026' } }));
    const kw = (p: string) => () => ({ $PROJ: p });
    expect(autoName(ws, kw('HSV screen.xit'))).toBe('HSV screen 2026-10-12');
    expect(autoName(ws, () => ({}))).toBe('01-Well 2026-10-12');
    ws.samples.forEach((x, i) => {
      x.plate = i < 2 ? 'Plate 1' : 'Plate 2';
      x.well = 'A0' + (i + 1);
    });
    expect(autoName(ws, () => ({}))).toBe('Plate 1, Plate 2 2026-10-12');
    ws.samples.forEach((s) => (s.info!['Folder'] = 'Run 3/Plate 1'));
    expect(autoName(ws, () => ({}))).toBe('Run 3 2026-10-12');
    // named with the date already (CytExpert experiment folders, lab folders by date)
    ws.samples.forEach((s) => (s.info!['Folder'] = 'Exp_20261012_1 lipid panel'));
    expect(autoName(ws, () => ({}))).toBe('Exp_20261012_1 lipid panel');
    ws.samples.forEach((s) => (s.info!['Folder'] = '261012 bead sizes/Exp_20261012_1'));
    expect(autoName(ws, () => ({}))).toBe('261012 bead sizes');
  });
});

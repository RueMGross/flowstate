// Session restore guard and autosave hints (the IndexedDB parts are checked in the browser; see the QC scripts).
import { restoreInterrupted, restoreSession, restoreSettled, startAutosave } from '../src/io/session';
import { parseWorkspace, serializeWorkspace } from '../src/io/files';
import { DEMO_NAME, loadDemo } from '../src/state/demo';
import { useStore } from '../src/state/store';

const G = globalThis as unknown as Record<string, unknown>;

describe('crash-loop guard of the session restore', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    G.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
    G.indexedDB = undefined;
  });
  afterAll(() => {
    delete G.localStorage;
  });
  it('a start that finds the restoring flag knows the last restore broke down', () => {
    expect(restoreInterrupted()).toBe(false);
    store.set('fs.session.restoring', '123');
    expect(restoreInterrupted()).toBe(true);
    restoreSettled();
    expect(restoreInterrupted()).toBe(false);
  });
  it('with nothing saved, a restore reports "none" and leaves no flag behind', async () => {
    store.set('fs.session.restoring', '1');
    expect(await restoreSession()).toEqual({ status: 'none' });
    expect(restoreInterrupted()).toBe(false);
  });
});

describe('the stored session does not carry the saved time', () => {
  it('savedAt is dropped when a workspace is parsed (opened or restored)', () => {
    loadDemo();
    const text = serializeWorkspace(useStore.getState().ws);
    expect(text).toContain('"savedAt"');
    expect('savedAt' in parseWorkspace(text)).toBe(false);
  });
});

describe('edits of the example', () => {
  const listeners: string[] = [];
  beforeAll(() => {
    G.window = { addEventListener: (k: string) => listeners.push(k) };
    G.document = { addEventListener: (k: string) => listeners.push(k), visibilityState: 'visible' };
  });
  afterAll(() => {
    delete G.window;
    delete G.document;
  });
  it('a one-time, non-blocking hint that they are not kept; opening another workspace is no edit', () => {
    loadDemo();
    startAutosave();
    expect(listeners).toContain('pagehide');
    const st = useStore.getState;
    const hints = () => st().ui.toasts.filter((t) => /Example edits are not kept\. Save or open your own files to keep work\./.test(t.text)).length;
    const before = hints();
    // replacing the example by another workspace (here: a copy of it) is no edit
    st().replaceWorkspace(parseWorkspace(serializeWorkspace(st().ws)));
    expect(st().ws.name).toBe(DEMO_NAME);
    expect(hints()).toBe(before);
    st().update((w) => {
      w.populations[0].name = 'Edited';
    });
    expect(hints()).toBe(before + 1);
    st().update((w) => {
      w.populations[0].name = 'Edited again';
    });
    expect(hints()).toBe(before + 1);
    expect(st().ui.toasts.find((t) => /Example edits/.test(t.text))!.kind).toBe('info');
  });
});

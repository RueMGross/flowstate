// Files opened as a folder (folder picker or a dropped folder, e.g. a CytExpert experiment folder with a subfolder per
// plate): their path relative to the folder opened tells plates apart (core/plate.ts). Other files are unchanged.

const paths = new WeakMap<File, string>();

/** Remember where a file was in the folder opened ("Experiment/Plate 2/01-Well-A1.fcs"). */
export function setRelativePath(f: File, path: string) {
  paths.set(f, path.replace(/^\/+/, ''));
}

/** Path of a file relative to the folder it was opened with ('' when opened as a single file). */
export function relativePathOf(f: File): string {
  return paths.get(f) ?? ((f as File & { webkitRelativePath?: string }).webkitRelativePath || '');
}

/** Folder of a file relative to the folder opened ("Experiment/Plate 2"), '' when not opened as a folder. */
export function folderOf(f: File): string {
  const p = relativePathOf(f);
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

/** Data files read from folders (FCS / LMD); other files of an export folder (.xit, .comp, statistics) are skipped. */
export const FOLDER_DATA = /\.(fcs|lmd)$/i;

/** Files of an `<input webkitdirectory>`: the data files, with the number of other files skipped. */
export function folderInputFiles(list: FileList | File[]): { files: File[]; skipped: number } {
  const all = Array.from(list).filter((f) => !/(^|\/)(\.|__MACOSX\/)/.test(relativePathOf(f) || f.name));
  const files = all.filter((f) => FOLDER_DATA.test(f.name));
  // the order of the folder (by path, numbers in natural order): plates and wells come in acquisition order
  files.sort((a, b) => COLLATOR.compare(relativePathOf(a) || a.name, relativePathOf(b) || b.name));
  return { files, skipped: all.length - files.length };
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The entries of a drop when it holds at least one folder (null: only files, use dataTransfer.files as before). Must be
 * called in the drop event itself (the items are gone afterwards).
 */
export function droppedFolderEntries(dt: DataTransfer | null): FileSystemEntry[] | null {
  if (!dt?.items) return null;
  const entries: FileSystemEntry[] = [];
  for (const it of Array.from(dt.items)) {
    if (it.kind !== 'file') continue;
    const e = (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  return entries.some((e) => e.isDirectory) ? entries : null;
}

/**
 * All files below dropped entries (folders read recursively), each with its path relative to the drop: folders give
 * their data files only (FOLDER_DATA), files dropped beside them are kept as they are. `skipped`: other files in folders.
 */
export async function readDroppedEntries(entries: FileSystemEntry[]): Promise<{ files: File[]; skipped: number }> {
  const out: File[] = [];
  let skipped = 0;
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const readAll = async (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    const reader = dir.createReader();
    const list: FileSystemEntry[] = [];
    // readEntries returns the entries in batches (100 in Chrome) until an empty one
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      list.push(...batch);
    }
    return list;
  };
  const walk = async (e: FileSystemEntry, inFolder: boolean, depth: number) => {
    if (depth > 12 || /^(\.|__MACOSX$)/.test(e.name)) return;
    if (e.isDirectory) {
      for (const c of await readAll(e as FileSystemDirectoryEntry)) await walk(c, true, depth + 1);
      return;
    }
    if (inFolder && !FOLDER_DATA.test(e.name)) {
      skipped++;
      return;
    }
    try {
      const f = await fileOf(e as FileSystemFileEntry);
      if (inFolder) setRelativePath(f, e.fullPath);
      out.push(f);
    } catch {
      skipped++;
    }
  };
  for (const e of entries) await walk(e, false, 0);
  out.sort((a, b) => COLLATOR.compare(relativePathOf(a) || a.name, relativePathOf(b) || b.name));
  return { files: out, skipped };
}

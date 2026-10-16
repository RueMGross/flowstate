import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFcs, getSpillover } from '../src/core/fcs';
import { Engine } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { computeSpillover, guessControlChannel } from '../src/core/autocomp';

// reference single-stain controls (not part of the repository): skipped when the folder is missing
const DIR = '/home/claude/testdata/comp';
it.skipIf(!existsSync(DIR))('computes spillover close to the acquisition matrix', () => {
  const eng = new Engine();
  const ws = emptyWorkspace();
  const files = readdirSync(DIR).filter((f) => f.endsWith('.fcs'));
  let spill: ReturnType<typeof getSpillover> = null;
  for (const f of files) {
    const b = readFileSync(join(DIR, f));
    const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const id = f;
    eng.addSample(id, ds);
    spill = spill ?? getSpillover(ds);
    ws.samples.push({ id, name: f.replace('.fcs', ''), fileName: f, fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
  }
  const fl = spill!.channels;
  const controls = ws.samples
    .filter((s) => !/Unstained/.test(s.name))
    .map((s) => ({ sampleId: s.id, channel: guessControlChannel(ws, eng, s.id, fl)! }));
  // every control is assigned to its own detector
  expect(controls.every((c) => !!c.channel)).toBe(true);
  expect(new Set(controls.map((c) => c.channel)).size).toBe(controls.length);
  const un = ws.samples.find((s) => /Unstained/.test(s.name))!.id;
  const res = computeSpillover(ws, eng, controls, { population: 'root', unstainedId: process.env.INTERNAL ? null : un });
  expect(res.warnings).toEqual([]);
  expect(res.channels.length).toBe(6);
  const diffs: string[] = [];
  res.channels.forEach((ch, k) => {
    const i = fl.indexOf(ch);
    expect(i).toBeGreaterThanOrEqual(0);
    res.channels.forEach((c2, j) => {
      const mine = res.matrix[k][j];
      const ref = spill!.matrix[i][fl.indexOf(c2)];
      if (k === j) {
        expect(mine).toBeCloseTo(1, 10);
        return;
      }
      expect(Number.isFinite(mine)).toBe(true);
      // the large spillovers (file >= 5 %) match the acquisition matrix within 3 percentage points
      if (ref >= 0.05) expect(Math.abs(mine - ref)).toBeLessThan(0.03);
      // all others within 12 points; the APC-Cy7 control (tandem, whole sample incl. debris) deviates most
      expect(Math.abs(mine - ref)).toBeLessThan(0.12);
      if (!/Cy7/.test(ch)) expect(Math.abs(mine - ref)).toBeLessThan(0.035);
      if (Math.abs(mine - ref) > 0.02) diffs.push(`${ch} -> ${c2}: ${mine.toFixed(3)} vs ${ref.toFixed(3)}`);
    });
  });
  // the controls' own detectors carry the expected main spillovers (AF700 -> APC-Cy7, APC -> AF700, FITC -> PE)
  const at = (a: string, b: string) => res.matrix[res.channels.indexOf(a)][res.channels.indexOf(b)];
  expect(at('Alexa Fluor 700-A', 'APC-Cy7-A')).toBeGreaterThan(0.2);
  expect(at('Alexa Fluor 647-A', 'Alexa Fluor 700-A')).toBeGreaterThan(0.3);
  expect(at('Alexa Fluor 488-A', 'PE-A')).toBeGreaterThan(0.15);
  if (diffs.length) console.log('largest differences to the acquisition matrix:\n' + diffs.join('\n'));
});

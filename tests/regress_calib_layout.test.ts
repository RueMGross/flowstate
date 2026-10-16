// Regression (acceptance round 3): calibration panels drew their legend over the curves and cut entries
// ("EV (core 1.38 / shell 1.48, 5 n…"), the ERF detection threshold line ran through the legend text, and the bead fit
// y axis title ended with "…". The legend now goes where it covers nothing (else outside the frame), long entries wrap,
// and axis titles take two lines or a smaller size.
import { writeFileSync } from 'fs';
import { Engine } from '../src/core/engine';
import { emptyWorkspace, MM } from '../src/core/model';
import { clippedLength } from '../src/render/labels';
import { newCalibItem, renderCalibPanel, type CalibChartItem } from '../src/render/calibPanel';
import { measureRich, runs, SvgPainter, type Painter, type RichText, type TextStyle } from '../src/render/painter';
import { mesfFitPanel, sizeCurvePanel, sizeFitPanel } from '../src/ui/calib/sheetPanels';

const noop = () => {};
interface Rec {
  texts: { x: number; y: number; t: string; st: TextStyle; rot: number }[];
  lines: number[][];
  paths: number[][];
}
function recorder(): Rec & Painter {
  const r: Rec = { texts: [], lines: [], paths: [] };
  return Object.assign(r, {
    kind: 'canvas' as const,
    save: noop,
    restore: noop,
    translate: noop,
    clipRect: noop,
    line: (x1: number, y1: number, x2: number, y2: number) => void r.lines.push([x1, y1, x2, y2]),
    ellipse: noop,
    image: noop,
    path: (pts: ArrayLike<number>) => void r.paths.push(Array.from(pts)),
    rect: noop,
    text: (x: number, y: number, t: RichText, st: TextStyle, rot = 0) => void r.texts.push({ x, y, t: runs(t).map((q) => q.text).join(''), st, rot }),
  }) as Rec & Painter;
}

const logspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => 10 ** (Math.log10(a) + ((Math.log10(b) - Math.log10(a)) * i) / (n - 1)));

function panels() {
  const d = logspace(20, 1500, 120);
  const sig = d.map((x) => 1e-3 * (x / 20) ** 6 / (1 + ((x / 300) ** 4.5)) + 1e-3);
  const ps = d.map((x) => 7e-3 * (x / 20) ** 6 / (1 + (x / 150) ** 4.8));
  const curve = sizeCurvePanel({
    channel: 'SSC-A',
    modelName: 'EV (core 1.38 / shell 1.48, 5 nm)',
    diameters: d,
    sigma: sig,
    validRange: [42, 357],
    ps: { d, s: ps },
    beads: [80, 108, 142, 142, 304, 600, 1020].map((x, i) => ({ diameterNm: x, sigma: [23, 130, 480, 9, 80, 300, 1100][i] })),
    noiseSigma: 0.07,
  });
  const fit = sizeFitPanel({
    channel: 'SSC-A / SSC_1-A',
    beads: [142, 80, 304, 108, 600, 142, 1020].map((x, i) => ({ diameterNm: x, predicted: [3e4, 9e4, 2.8e5, 4.6e5, 1.1e6, 1.6e6, 4e6][i], measured: [3.1e4, 8.4e4, 2.9e5, 4.9e5, 1.15e6, 1.8e6, 4.1e6][i], used: true })),
    halfAngleDeg: 54.7,
    cvPct: 6.3,
    r2Log: 0.9988,
    fixed: false,
  });
  const mesf = mesfFitPanel({
    channel: 'FL2-A',
    unit: 'ERF',
    points: [{ median: 98, reference: 1500, used: true }, { median: 1100, reference: 6000, used: true }, { median: 3000, reference: 25000, used: true }],
    line: { x: [50, 6000], y: [800, 30000] },
    r2: 0.94071,
    slope: 0.766,
    thresholdMfi: 98,
  });
  return { curve, fit, mesf };
}

function render(panel: ReturnType<typeof panels>['curve'], wmm: number, hmm: number, pt: number) {
  const ws = emptyWorkspace();
  const it = newCalibItem(panel, 0, 0, wmm * MM, hmm * MM, pt) as CalibChartItem;
  ws.worksheets[0].items.push(it);
  const env = { ws, engine: new Engine(), activeSampleId: null, rasterScale: 1, makeCanvas: (() => null) as never };
  const rec = recorder();
  renderCalibPanel(rec, it, env);
  if (process.env.CALIB_SVG) {
    const p = new SvgPainter('c');
    renderCalibPanel(p, it, env);
    writeFileSync(`${process.env.CALIB_SVG}/${panel.kind}_${wmm}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${it.w * 4}" height="${it.h * 4}" viewBox="0 0 ${it.w} ${it.h}"><rect width="100%" height="100%" fill="#fff"/>${p.toString()}</svg>`);
  }
  return { rec, it };
}

/** box of a recorded (unrotated, left-aligned, middle baseline) legend text */
const boxOf = (t: Rec['texts'][number]) => ({ x: t.x, y: t.y - t.st.size * 0.5, w: measureRich(t.t, t.st), h: t.st.size });

describe('calibration panel layout', () => {
  for (const [wmm, hmm, pt] of [
    [60, 54, 7],
    [45, 40, 6],
  ] as const) {
    it(`legends cover no curve or reference line and keep their full text (${wmm} mm)`, () => {
      const { curve, fit, mesf } = panels();
      for (const panel of [curve, fit, mesf]) {
        const { rec } = render(panel, wmm, hmm, pt);
        const names = [...panel.series.filter((s) => s.name).map((s) => s.name), ...(panel.vlines ?? []).map((v) => v.label ?? ''), ...(panel.hlines ?? []).map((v) => v.label ?? '')].filter(Boolean);
        const all = rec.texts.map((t) => t.t).join('\n');
        // every legend entry in full (possibly wrapped over two lines), nothing shortened
        for (const n of names) expect(all.replace(/\n/g, ' ')).toContain(n);
        expect(all).not.toMatch(/…/);
        const legendTexts = rec.texts.filter((t) => !t.rot && t.st.align !== 'center' && t.st.align !== 'right' && names.some((n) => n.includes(t.t) || t.t.includes(n.split(' ')[0])));
        expect(legendTexts.length).toBeGreaterThan(0);
        for (const t of legendTexts) {
          const b = boxOf(t);
          for (const pth of rec.paths) for (let i = 0; i + 3 < pth.length; i += 2) expect(clippedLength(pth[i], pth[i + 1], pth[i + 2], pth[i + 3], b)).toBe(0);
          // reference lines (threshold, noise) are drawn as lines; legend swatches are short lines left of the text
          for (const l of rec.lines) if (Math.hypot(l[2] - l[0], l[3] - l[1]) > pt * 3) expect(clippedLength(l[0], l[1], l[2], l[3], b)).toBe(0);
        }
      }
    });
  }
  it('the bead fit y axis title is not cut', () => {
    const { fit } = panels();
    const { rec } = render(fit, 60, 54, 7);
    const ytitle = rec.texts.filter((t) => t.rot !== 0).map((t) => t.t).join(' ');
    expect(ytitle).toBe('Measured median SSC-A / SSC_1-A (a.u.)');
  });
});

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  annotationGroups,
  assignPlates,
  cellRange,
  compactNumber,
  fmtWellValue,
  csvText,
  formatForWells,
  keywordPlate,
  keywordWell,
  namePlate,
  nextOccupied,
  normWell,
  pickWells,
  plateCells,
  plateExportTables,
  plateLayout,
  samplesIn,
  stepWell,
  wellsBetween,
  wellsFromNames,
  type PlateInput,
  type PlateView,
} from '../src/core/plate';
import { parseFcsSamples } from '../src/core/fcs';
import { emptyWorkspace, type SampleRef } from '../src/core/model';

const nameWell = (names: string[]) => wellsFromNames(names).map((w) => w?.well ?? null);
const one = (n: string) => nameWell([n])[0];

describe('well ids', () => {
  it('normalizes the ways wells are written', () => {
    expect(normWell('A1')).toBe('A01');
    expect(normWell('a01')).toBe('A01');
    expect(normWell('H12')).toBe('H12');
    expect(normWell('P24')).toBe('P24');
    expect(normWell('A001')).toBe('A01');
    expect(normWell('Well A1')).toBe('A01');
    expect(normWell('Q1')).toBeNull();
    expect(normWell('A25')).toBeNull();
    expect(normWell('A0')).toBeNull();
    expect(normWell('NA')).toBeNull();
    expect(normWell('')).toBeNull();
  });
});

describe('wells in names', () => {
  it('finds strong forms even in a single name', () => {
    expect(one('Specimen_001_C2_C02')).toBe('C02'); // BD FACSDiva: tube and well
    expect(one('HC Specimen_001_C2_C02 Peptide')).toBe('C02');
    expect(one('ALS Specimen_001_C10_C10 Negative')).toBe('C10');
    expect(one('A01 Well - A01 WLSM')).toBe('A01'); // Sony
    expect(one('Sample_Well_A02')).toBe('A02');
    expect(one('EY_2013-07-19_PBS_FCS_2.0_Custom_Without_Add_Well_A1.001')).toBe('A01'); // MACSQuant export
    expect(one('EY_2013-07-19_PID_101_MG1655_Transformants_D01_Well_A4.001')).toBe('A04'); // the well, not D01
    expect(one('10-Well-D8')).toBe('D08'); // CytExpert default tube name
    expect(one('01-Well-A1')).toBe('A01');
    expect(one('20110225_11h15m29s(Protocol 8 Peak - FT, Well A1)')).toBe('A01'); // iCyt
    expect(one('ADM_12JAN2022_112816.VIA #3 A03')).toBe('A03'); // Guava data set label
    expect(one('G11')).toBe('G11');
    expect(one('BEADS-1_H7_H07_P3')).toBe('H07'); // BD with the exported gate
  });

  it('ignores lone ambiguous tokens and words that look like wells', () => {
    for (const n of ['CD8 PE', 'H2O control', 'B6 mice', 'IL-2', 'A549 cells', 'HEK293T', 'CD4+ CD25+', 'B525 AF488', 'Day D7', 'P3 passage'])
      expect(one(n), n).toBeNull();
    // the same "well" in every name is a word, not a well
    expect(nameWell(['B6 mice spleen', 'B6 mice LN', 'B6 mice blood', 'B6 mice BM'])).toEqual([null, null, null, null]);
    // days of a time course: one row, few values
    expect(nameWell(['HEK D1', 'HEK D2', 'HEK D3', 'HEK D7'])).toEqual([null, null, null, null]);
    // a mixed list: the files with a consistent well get it, the odd one does not
    const r = nameWell(['ctrl_A1', 'ctrl_A2', 'ctrl_B1', 'ctrl_B2', 'B6 mice']);
    expect(r).toEqual(['A01', 'A02', 'B01', 'B02', null]);
  });

  it('uses the position shared by the names', () => {
    // compound and well: the well varies, the compound repeats
    const names = ['E5-C12 10uM_B3', 'E5-C12 10uM_B4', 'E5-C12 1uM_C3', 'E5-C12 1uM_C4', 'E6-C1 10uM_D3'];
    expect(nameWell(names)).toEqual(['B03', 'B04', 'C03', 'C04', 'D03']);
    // Sony ID7000 names: well first
    expect(nameWell(['A01 Beads 20 BV421 Raw', 'A12 Unstained Beads Raw', 'B06 FITC Raw'])).toEqual(['A01', 'A12', 'B06']);
    // Cytek Aurora reference controls
    expect(nameWell(['Reference Group-A1 Unstained (Cells)', 'Reference Group-A5 CD206 PE (Beads)', 'Reference Group-A9 CD3 BV605 (Beads)', 'Reference Group-B4 CD8 FITC (Beads)'])).toEqual([
      'A01',
      'A05',
      'A09',
      'B04',
    ]);
    // lower case wells in a consistent pattern
    expect(nameWell(['sample_a1', 'sample_a2', 'sample_b1', 'sample_b2'])).toEqual(['A01', 'A02', 'B01', 'B02']);
    // a 384-well plate
    expect(nameWell(['x_I13', 'x_P24', 'x_A1', 'x_J2', 'x_K20', 'x_L5', 'x_M7', 'x_N9'])).toEqual(['I13', 'P24', 'A01', 'J02', 'K20', 'L05', 'M07', 'N09']);
  });

  it('a later name joins the pattern of names placed before', () => {
    const before = ['Screen_A01', 'Screen_A02', 'Screen_B01', 'Screen_B02'];
    expect(wellsFromNames(['Screen_C05'], before).map((w) => w?.well)).toEqual(['C05']);
    expect(wellsFromNames(['Screen_C05'])[0]).toBeNull();
  });
});

describe('plates in names and keywords', () => {
  it('reads plate tokens', () => {
    expect(namePlate('Plate 1_A01')?.label).toBe('Plate 1');
    expect(namePlate('Plate_2 A01')?.label).toBe('Plate 2');
    expect(namePlate('Plate-03_B4')?.label).toBe('Plate 3');
    expect(namePlate('screen plateB A1')).toBeNull(); // no delimiter
    expect(namePlate('screen plate B A1')?.label).toBe('Plate B');
    expect(namePlate('02-Well-A1')?.label).toBe('Plate 2'); // CytExpert
    expect(namePlate('Exp7_P2_A01')).toEqual({ label: 'Plate 2', kind: 'p' });
    expect(namePlate('Anna tumor 17 markers complete-Plate_001-Reference Group-A1 Unstained (Cells)')?.label).toBe('Plate 1');
  });

  it('reads vendor keywords', () => {
    expect(keywordWell({ $WELLID: 'G11', $PLATENAME: '20200302 HEK-GFP Benchmarking Plate 1' })).toBe('G11');
    expect(keywordWell({ 'WELL ID': 'C04', 'TUBE NAME': 'C4' })).toBe('C04');
    expect(keywordWell({ 'TUBE NAME': 'C4', 'PLATE NAME': '96 Well - U bottom' })).toBe('C04');
    expect(keywordWell({ 'TUBE NAME': 'B6' })).toBeNull(); // a tube, not a plate
    expect(keywordWell({ 'GTI$WELL': 'A03' })).toBe('A03');
    expect(keywordWell({ 'BDPM$WELL': 'A02' })).toBe('A02');
    expect(keywordWell({ $SMNO: 'D8', PLTNO: '10', TBNM: '10-Well-D8' })).toBe('D08'); // CytExpert
    expect(keywordWell({ $SMNO: '00022576' })).toBeNull(); // Beckman Navios sample number
    expect(keywordWell({ $SRC: 'A1', $CYT: 'MACSQuant' })).toBe('A01');
    expect(keywordWell({ $SRC: 'A1', $CYT: 'LSRII' })).toBeNull();
    expect(keywordWell({ $WELLID: 'NA' })).toBeNull();

    expect(keywordPlate({ PLTNO: '10' })?.label).toBe('Plate 10');
    expect(keywordPlate({ $PLATENAME: '01', $WELLID: 'A12' })?.label).toBe('Plate 1'); // CytExpert (LX / mosaic)
    expect(keywordPlate({ $PLATENAME: 'Plate_001', $PROJ: 'x', PLATEROWS: ' 8', PLATECOLS: '12' })).toMatchObject({ label: 'Plate 1', identity: true, format: { rows: 8, cols: 12 } });
    const bd = keywordPlate({ 'PLATE NAME': '96 Well - U bottom', 'PLATE ID': '8a0d540a-90d0', 'EXPERIMENT NAME': 'Experiment_031' });
    expect(bd).toMatchObject({ label: 'Experiment_031', identity: true, format: { rows: 8, cols: 12 } });
    const guava = keywordPlate({ $PLATENAME: '96-Well Plate' });
    expect(guava?.identity).toBe(false);
    expect(keywordPlate({ $PLATENAME: '96 Well Plate (standard) - 1' })?.label).toBe('Plate 1'); // Sony ID7000
    expect(keywordPlate({ $PLATEID: '1', $PROJ: 'OMIP69.ncf' })?.label).toBe('Plate 1'); // NovoCyte
    expect(keywordPlate({ $PLATEID: 'NA', $PLATENAME: 'NA' })).toBeNull(); // Attune tube files
    expect(keywordPlate({ $PLATENAME: '24 Well Plate' })?.format).toEqual({ rows: 4, cols: 6 });
  });
});

const inp = (id: string, name: string, extra: Partial<PlateInput> = {}): PlateInput => ({ id, name, ...extra });
const wells96 = () => Array.from({ length: 96 }, (_, i) => `${'ABCDEFGH'[Math.floor(i / 12)]}${(i % 12) + 1}`);

describe('plate assignment', () => {
  it('two CytExpert plates from the default tube names', () => {
    const ins = [1, 2].flatMap((p) => wells96().map((w) => inp(`${p}${w}`, `0${p}-Well-${w}`)));
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2']);
    expect(r.placements.get('2H12')).toEqual({ well: 'H12', plate: 'Plate 2', source: 'name' });
    expect(r.plates[0]).toMatchObject({ rows: 8, cols: 12 });
  });

  it('plates from keywords (CytExpert PLTNO / $SMNO), names ignored', () => {
    const ins = [inp('a', '01-TBM-R3_0H', { keywords: { PLTNO: '07', $SMNO: 'A5' } }), inp('b', 'x', { keywords: { PLTNO: '07', $SMNO: 'A6' } })];
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['Plate 7']);
    expect(r.placements.get('a')).toEqual({ well: 'A05', plate: 'Plate 7', source: 'keyword' });
  });

  it('plates from folders', () => {
    const ins = [1, 2].flatMap((p) => ['A1', 'A2', 'B1'].map((w) => inp(`${p}${w}`, `Well-${w}`, { folder: `Exp 12/Plate${p}` })));
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2']);
    expect(r.placements.get('2B1')?.plate).toBe('Plate 2');
    // one folder: its name names the plate
    const one = assignPlates(['A1', 'A2'].map((w) => inp(w, `Well-${w}`, { folder: 'Screen 2024-05-01' })));
    expect(one.plates.map((p) => p.name)).toEqual(['Screen 2024-05-01']);
  });

  it('repeated wells without plate names: split by a name token, else in loading order', () => {
    const ins = ['20240501', '20240502'].flatMap((d) => ['A1', 'A2', 'B1', 'B2'].map((w) => inp(`${d}${w}`, `Screen_${d}_${w}`)));
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['20240501', '20240502']);
    expect(r.notes.join()).toMatch(/sample names/);
    const same = ['A1', 'A2', 'B1', 'B2', 'A1', 'A2', 'B1', 'B2'].map((w, i) => inp(`s${i}`, `x_${w}`));
    const r2 = assignPlates(same);
    expect(r2.plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2']);
    expect(r2.placements.get('s5')?.plate).toBe('Plate 2');
    // date keyword tells the plates apart
    const dated = ['01-JAN-2024', '02-JAN-2024'].flatMap((d) => ['A1', 'A2'].map((w) => inp(`${d}${w}`, `x_${w}`, { keywords: { $DATE: d } })));
    // (2 wells per plate: too few for a weak name pattern; the keyword wells are added)
    for (const x of dated) x.keywords!['$WELLID'] = x.name.slice(2);
    expect(assignPlates(dated).plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2'].map((_, i) => ['01-JAN-2024', '02-JAN-2024'][i]));
  });

  it('BD plate with the same well twice (raw and gated export) stays one plate', () => {
    const kw = { 'PLATE NAME': '96 Well - U bottom', 'PLATE ID': 'g1', 'EXPERIMENT NAME': 'Exp' };
    const r = assignPlates([inp('a', 'A1', { keywords: { ...kw, 'WELL ID': 'A01' } }), inp('b', 'A1 gated', { keywords: { ...kw, 'WELL ID': 'A01' } })]);
    expect(r.plates.map((p) => p.name)).toEqual(['Exp']);
    expect([r.placements.get('a')?.plate, r.placements.get('b')?.plate]).toEqual(['Exp', 'Exp']);
  });

  it('Guava: one plate per multi-data-set file', () => {
    const ins = [1, 2].flatMap((f) => ['A01', 'A02'].map((w, i) => inp(`${f}${w}`, `run${f} #${i + 1} ${w}`, { fileName: `run${f}.fcs`, multi: true, keywords: { 'GTI$WELL': w, $WELLID: w, $PLATENAME: '96-Well Plate' } })));
    expect(assignPlates(ins).plates.map((p) => p.name)).toEqual(['run1', 'run2']);
  });

  it('later loads join a plate with the same key, or take the next free plate', () => {
    const first = assignPlates(['A1', 'A2'].map((w) => inp(w, `Plate 1_${w}`)).concat(['B1'].map((w) => inp(w, `Plate 1_${w}`))));
    // rename by the user keeps the key
    const plates = first.plates.map((p) => ({ ...p, name: 'Compounds' }));
    const placed = [...first.placements.values()].map((p) => ({ plate: 'Compounds', well: p.well! }));
    const more = assignPlates([inp('c', 'Plate 1_C5'), inp('d', 'Plate 1_D6'), inp('e', 'Plate 1_E7')], { plates, placed });
    expect(more.placements.get('c')?.plate).toBe('Compounds');
    // no plate information: a second full set of wells goes to a new plate
    const a = assignPlates(['A1', 'A2', 'B1', 'B2'].map((w) => inp('a' + w, `x_${w}`)));
    const placedA = [...a.placements.values()].map((p) => ({ plate: p.plate!, well: p.well! }));
    const b = assignPlates(['A1', 'A2', 'B1', 'B2'].map((w) => inp('b' + w, `x_${w}`)), { plates: a.plates, placed: placedA });
    expect(b.placements.get('bA1')?.plate).toBe('Plate 2');
    // ... and the missing wells of a half plate join it
    const c = assignPlates(['C1', 'C2', 'D1', 'D2'].map((w) => inp('c' + w, `x_${w}`)), { plates: a.plates, placed: placedA });
    expect(c.placements.get('cC1')?.plate).toBe('Plate 1');
  });

  it('a second run saved under the same names gets its own plate (not two samples per well)', () => {
    const run = (tag: string) => ['A1', 'A2', 'B1', 'B2'].map((w) => inp(tag + w, `01-Well-${w}`));
    const a = assignPlates(run('a'));
    const placedA = [...a.placements.values()].map((p) => ({ plate: p.plate!, well: p.well! }));
    const b = assignPlates(run('b'), { plates: a.plates, placed: placedA });
    expect(b.placements.get('aA1')).toBeUndefined();
    expect(b.placements.get('bA1')?.plate).toBe('Plate 1 (2)');
    expect(b.plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 1 (2)']);
    expect(b.notes.join()).toMatch(/already holds/);
    // a third run: a third plate; the missing wells of a run join its plate
    const placedB = placedA.concat([...b.placements.values()].map((p) => ({ plate: p.plate!, well: p.well! })));
    const c = assignPlates(run('c'), { plates: b.plates, placed: placedB });
    expect(c.placements.get('cA1')?.plate).toBe('Plate 1 (3)');
    const half = assignPlates([inp('dC1', '01-Well-C1'), inp('dC2', '01-Well-C2')], { plates: b.plates, placed: placedB });
    expect(half.placements.get('dC1')?.plate).toBe('Plate 1');
  });

  it('plates in the order of loading; folders name plates whose names all say "Plate 1"', () => {
    const ins = ['Zeta', 'Alpha'].flatMap((d) => ['A1', 'A2', 'B1', 'B2'].map((w) => inp(d + w, `01-Well-${w}`, { folder: `Exp/${d}` })));
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['Zeta', 'Alpha']);
    // BD: Specimen_001 measured first, named "Plate1_CG_AA"; the second plate "221116_plate2"
    const bd = (sp: string, plate: string, w: string) => inp(sp + w, `Specimen_${sp}_${w}`, { keywords: { 'WELL ID': w, 'PLATE NAME': plate, 'PLATE ID': plate + 'id' } });
    const r2 = assignPlates([bd('001', 'Plate1_CG_AA', 'D10'), bd('002', '221116_plate2', 'C02')]);
    expect(r2.plates.map((p) => p.name)).toEqual(['Plate1_CG_AA', '221116_plate2']);
  });

  it('formats', () => {
    expect(formatForWells(['A01', 'H12'])).toEqual({ rows: 8, cols: 12 });
    expect(formatForWells(['A01', 'P24'])).toEqual({ rows: 16, cols: 24 });
    // all 24 wells A1..D6: a 24-well plate; 6 wells A1..B3 or a part of a plate: a corner of a 96-well plate
    const w24 = Array.from({ length: 24 }, (_, i) => `${'ABCD'[Math.floor(i / 6)]}0${(i % 6) + 1}`);
    expect(formatForWells(w24)).toEqual({ rows: 4, cols: 6 });
    expect(formatForWells(w24.slice(1))).toEqual({ rows: 8, cols: 12 });
    expect(formatForWells(['A01', 'A02', 'A03', 'B01', 'B02', 'B03'])).toEqual({ rows: 8, cols: 12 });
    expect(formatForWells(['A01', 'A02', 'B01'])).toEqual({ rows: 8, cols: 12 });
    expect(formatForWells(['A01', 'B01'], { rows: 4, cols: 6 })).toEqual({ rows: 4, cols: 6 });
  });
});

// ---------------------------------------------------------------- real files (reference data, not in the repository)

const TD = '/home/claude/testdata';
function kwOf(path: string): Record<string, string>[] {
  const b = readFileSync(path);
  return parseFcsSamples(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer).map((s) => s.ds.keywords);
}

describe('real files', () => {
  const ics = join(TD, 'online/zenodo_16754553_ics_wsp');
  it.skipIf(!existsSync(ics))('BD FACSDiva HTS export (ICS screen): one plate, wells C1..C12 and H1..H12', () => {
    const files = readdirSync(ics).filter((f) => f.endsWith('.fcs'));
    const ins = files.map((f) => inp(f, f.replace(/\.fcs$/, ''), { fileName: f, keywords: kwOf(join(ics, f))[0] }));
    const r = assignPlates(ins);
    expect(r.plates.map((p) => p.name)).toEqual(['Experiment_031']);
    const wells = [...r.placements.values()].map((p) => p.well).sort();
    expect(wells.length).toBe(18);
    expect(new Set(wells).size).toBe(18);
    expect(wells.every((w) => /^[CH]\d\d$/.test(w!))).toBe(true);
    // without keywords (names only) the same wells
    const byName = assignPlates(files.map((f) => inp(f, f.replace(/\.fcs$/, ''))));
    expect([...byName.placements.values()].map((p) => p.well).sort()).toEqual(wells);
    expect(byName.plates.length).toBe(1);
  });

  const cf = [join(TD, 'online/zenodo_18439538_microalgae/L1.fcs'), join(TD, 'cytoflex/Beads20_BV711.fcs')];
  it.skipIf(!cf.every(existsSync))('CytExpert keywords: PLTNO / $SMNO (CytoFLEX) and $PLATENAME / $WELLID (CytoFLEX LX)', () => {
    const [a] = kwOf(cf[0]);
    expect(keywordWell(a)).toBe('D08');
    expect(keywordPlate(a)?.label).toBe('Plate 10');
    const [b] = kwOf(cf[1]);
    expect(keywordWell(b)).toBe('C01');
    expect(keywordPlate(b)?.label).toBe('Plate 2');
  });

  const guava = join(TD, 'online/cytoflow/Millipore_Guava.fcs');
  it.skipIf(!existsSync(guava))('Guava: wells of the data sets', () => {
    const kws = kwOf(guava);
    expect(kws.map(keywordWell).slice(0, 3)).toEqual(['A01', 'A02', 'A03']);
  });
});

// ---------------------------------------------------------------- selection

const plate = (wells: Record<string, string[]>, rows = 8, cols = 12): PlateView => ({ name: 'P', rows, cols, wells: new Map(Object.entries(wells)) });

describe('selection', () => {
  const p = plate({ A01: ['a1'], A02: ['a2'], A03: ['a3'], B01: ['b1'], B02: ['b2'], B03: ['b3', 'b3x'], H12: ['h12'] });
  it('rectangles, rows, columns', () => {
    expect(wellsBetween('B03', 'A01')).toEqual(['A01', 'A02', 'A03', 'B01', 'B02', 'B03']);
    expect(samplesIn(p, wellsBetween('A02', 'B03'))).toEqual(['a2', 'a3', 'b2', 'b3', 'b3x']);
  });
  it('click, ctrl-click, shift-click', () => {
    let s = pickWells({ selected: [], active: null }, p, ['A02'], 'set', 'A02');
    expect(s).toEqual({ selected: ['a2'], active: 'a2' });
    s = pickWells(s, p, ['B03'], 'toggle', 'B03');
    expect(s).toEqual({ selected: ['a2', 'b3', 'b3x'], active: 'b3' });
    s = pickWells(s, p, ['B03'], 'toggle', 'B03');
    expect(s).toEqual({ selected: ['a2'], active: 'a2' });
    s = pickWells(s, p, wellsBetween('A02', 'B01'), 'set', 'B01');
    expect(s).toEqual({ selected: ['a1', 'a2', 'b1', 'b2'], active: 'b1' });
    // empty well with ctrl: nothing changes
    expect(pickWells(s, p, ['D05'], 'toggle', 'D05')).toEqual(s);
    // a selection that is empty means the active sample
    expect(pickWells({ selected: [], active: 'a1' }, p, ['A02'], 'add', 'A02')).toEqual({ selected: ['a1', 'a2'], active: 'a2' });
  });
  it('arrow keys', () => {
    expect(stepWell(p, 'A01', -1, 0)).toBe('A01');
    expect(stepWell(p, 'A01', 1, 1)).toBe('B02');
    expect(nextOccupied(p, 'A03', 0, 1)).toBe('B01'); // next row
    expect(nextOccupied(p, 'B03', 0, 1)).toBe('H12');
    expect(nextOccupied(p, 'A01', 1, 0)).toBe('B01');
    expect(nextOccupied(p, 'B01', 1, 0)).toBe('A02'); // next column
    expect(nextOccupied(p, 'H12', 0, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------- heatmap and export

describe('heatmap values and export', () => {
  const p = plate({ A01: ['a1'], A02: ['a2', 'a2b'], B01: ['b1'] }, 2, 3);
  const vals: Record<string, number | null> = { a1: 10, a2: 20, a2b: 30, b1: null };
  it('cells: mean of shared wells, n/a, range', () => {
    const { cells } = plateCells(p, (id) => vals[id]);
    expect(cells[0][0].value).toBe(10);
    expect(cells[0][1].value).toBe(25);
    expect(cells[1][0].value).toBeNull(); // n/a
    expect(cells[1][2].samples).toEqual([]);
    expect(cellRange([cells])).toEqual([10, 25]);
    expect(cellRange([cells], [0, 100])).toEqual([0, 100]);
  });
  it('CSV: one block per plate (rows A.., columns 1..) and a long table', () => {
    const p2: PlateView = { ...p, def: { name: 'P', rows: 2, cols: 3, annotations: { A01: { Compound: 'X' } } } };
    const t = plateExportTables([p2], (id) => vals[id], '% Parent GFP+', (id) => id.toUpperCase(), ['Compound']);
    expect(csvText(t.layout).split('\n')).toEqual(['Plate: P,% Parent GFP+', ',1,2,3', 'A,10,25,', 'B,,,']);
    expect(csvText(t.long).split('\n')).toEqual(['Plate,Well,Sample,% Parent GFP+,Compound', 'P,A01,A1,10,X', 'P,A02,A2,20,', 'P,A02,A2B,30,', 'P,B01,B1,,']);
  });
});

// ---------------------------------------------------------------- workspace layout

describe('values in wells', () => {
  it('short forms that fit a well, the same for the whole plate', () => {
    expect([950, 999.4, 999.6, 2569, 16492, 100000, 999999, 1234567, -12000, 2.5e9].map(compactNumber)).toEqual(['950', '999', '1.00k', '2.57k', '16.5k', '100k', '1.00M', '1.23M', '-12.0k', '2.50G']);
    // a plate with values above 10,000: all short; above 1,000: no decimals; else the decimals chosen
    expect(fmtWellValue(2569.04, 1, [30, 100000])).toBe('2.57k');
    expect(fmtWellValue(256.9, 1, [30, 2500])).toBe('257');
    expect(fmtWellValue(25.69, 1, [0, 100])).toBe('25.7');
    expect(fmtWellValue(null, 1, [0, 100])).toBe('');
  });

  it('annotation values: numbers by value, text in natural order', () => {
    const p = { name: 'P', rows: 8, cols: 12, wells: new Map([['A01', ['a']], ['A02', ['b']], ['A03', ['c']], ['A04', ['d']]]), def: { name: 'P', rows: 8, cols: 12, annotations: { A01: { c: '0.5' }, A02: { c: '0.125' }, A03: { c: '1' }, A04: { c: '0.25' } } } };
    expect(annotationGroups([p], 'c').map((g) => g.value)).toEqual(['0.125', '0.25', '0.5', '1']);
    p.def.annotations = { A01: { c: 'Donor 10' }, A02: { c: 'Donor 2' }, A03: { c: 'ctrl' }, A04: { c: 'Donor 1' } };
    expect(annotationGroups([p], 'c').map((g) => g.value)).toEqual(['ctrl', 'Donor 1', 'Donor 2', 'Donor 10']);
  });
});

describe('plate layout of a workspace', () => {
  const smp = (id: string, name: string, extra: Partial<SampleRef> = {}): SampleRef => ({ id, name, fileName: name + '.fcs', fileSize: 0, eventCount: 0, channels: [], compId: null, ...extra });
  it('stored placements, derived ones for older workspaces, layouts without samples', () => {
    const ws = emptyWorkspace();
    ws.samples = [
      smp('s1', 'x', { well: 'A01', plate: 'Plate 1', wellSource: 'manual' }),
      smp('s2', 'Plate 2_B3'),
      smp('s3', 'Plate 2_B4'),
      smp('s4', 'Plate 2_C5'),
      smp('s5', 'tube 7', { wellSource: 'none' }),
    ];
    ws.plates = [{ name: 'Plate 1', rows: 8, cols: 12 }, { name: 'Layout only', rows: 8, cols: 12, annotations: { A01: { Compound: 'X' } } }];
    const L = plateLayout(ws);
    expect(L.plates.map((p) => p.name)).toEqual(['Plate 1', 'Layout only', 'Plate 2']);
    expect(L.plates[2].wells.get('B03')).toEqual(['s2']);
    expect(L.unplaced).toEqual(['s5']);
    expect(L.derived.get('s3')).toEqual({ well: 'B04', plate: 'Plate 2', source: 'name' });
    expect(annotationGroups(L.plates, 'Compound')).toEqual([{ value: 'X', sampleIds: [], wells: 1 }]);
  });
});

import { mieSphere, mieCoated, riWater, riPolystyrene, riSilica, resolveRI, sizeParameter } from '../src/core/mie';

// Reference values: miepython 3.3.0 (efficiencies; sign convention m = n − ik converted) and PyMieScatt 1.8.1.1
// (amplitude functions S1/S2 in the Bohren & Huffman normalization; coated sphere Q and S). The "tiny" case uses
// miepython for S (PyMieScatt switches to a low-frequency approximation there). Generated with a short Python script
// calling these packages (numeric results only, no code from them).
const ANGLES_DEG = [0, 90, 150];
const SPHERE_REFS = [
  { name: 'PS 50nm @405 water', m: [1.2112220741537918, 0.0], x: 0.5209193665464444, qext: 0.003375149039900808, qsca: 0.003375149039900808, qback: 0.004495099116918539, g: 0.047160680049382904, S1: [[0.000228967568066, -0.0195999917945], [0.00022864666681, -0.0185092568726], [0.000228368845946, -0.0175991493244]], S2: [[0.000228967568066, -0.0195999917945], [1.30901139733e-7, -9.4813335048e-5], [-0.000197740502686, 0.0152181536491]] },
  { name: 'PS 600nm @405 water', m: [1.2112220741537918, 0.0], x: 6.251032398557334, qext: 2.7007133214142414, qsca: 2.7007133214142414, qback: 0.09872973822975516, g: 0.9107719359029011, S1: [[26.3828674133, -18.6820101028], [1.2152785367, -0.115520155209], [1.00789486812, -0.282201975082]], S2: [[26.3828674133, -18.6820101028], [0.87994097726, 0.106219576291], [0.122747704547, -0.409630135421]] },
  { name: 'PS 1020nm @405 water', m: [1.2112220741537918, 0.0], x: 10.626755077547468, qext: 3.639829340810657, qsca: 3.639829340810657, qback: 0.2255114891235522, g: 0.9143155734969854, S1: [[102.759592318, 1.05471988201], [-0.565213222695, 1.23419106364], [2.11937876086, -1.15617322778]], S2: [[102.759592318, 1.05471988201], [-0.319819066607, 2.21927026079], [-0.071529041672, 0.111617699641]] },
  { name: 'absorbing 1.5+0.1i x=5', m: [1.5, 0.1], x: 5.0, qext: 3.1536935307277347, qsca: 1.9634681569280108, qback: 0.1398490449886156, g: 0.8361543450877744, S1: [[19.7105845671, 1.14604147926], [1.30627194694, 0.738259428825], [0.510680804781, -1.01018286146]], S2: [[19.7105845671, 1.14604147926], [1.02656128138, 0.0385794815203], [0.714105186511, -0.435496437319]] },
  { name: 'metal 0.3+3i x=2', m: [0.3, 3.0], x: 2.0, qext: 3.765558981554949, qsca: 3.398528750919804, qback: 2.5195223388073855, g: 0.39375338749600747, S1: [[3.76555898155, -0.729142990316], [0.896401420718, -0.881111056668], [-1.10776415065, -0.776598484887]], S2: [[3.76555898155, -0.729142990316], [-1.45235757903, 1.34924502235], [0.628583119382, 0.665118824605]] },
  { name: 'm=1.2 x=50', m: [1.2, 0.0], x: 50.0, qext: 1.9864847408084734, qsca: 1.9864847408084734, qback: 6.7748179951157725, g: 0.8736120316968161, S1: [[1241.552963, 141.226339175], [5.9415691431, 0.117402061389], [-5.09116797863, -2.33875635296]], S2: [[1241.552963, 141.226339175], [-7.09443474581, -0.835654408667], [-16.2244459587, 4.67260173124]] },
  { name: 'tiny m=1.1 x=0.05', m: [1.1, 0.0], x: 0.05, qext: 7.127817397449681e-8, qsca: 7.127817397449681e-8, qback: 1.0680730309859017e-7, g: 0.0004155852087494318, S1: [[4.4548858735e-11, -8.17875540978e-6], [4.45488539191e-11, -8.17455049768e-6], [4.45488497483e-11, -8.17091016444e-6]], S2: [[4.4548858735e-11, -8.17875540978e-6], [1.56030658171e-18, -1.69504088613e-10], [-3.85804352013e-11, 7.07617340773e-6]] },
];
const COATED_REFS = [
  { name: 'EV 200nm 5nm shell @405', m1: [1.0274801405318974, 0.0], m2: [1.1019352231791364, 0.0], xc: 1.979493592876489, xs: 2.0836774661857778, qext: 0.007777004149411038, qsca: 0.0077770041494110344, qback: 6.467506569163624e-5, g: 0.7067697108294039, S1: [[0.00844137763816, -0.232290280417], [0.00444987141762, -0.0630181337199], [0.00144247067292, 0.00255650819793]], S2: [[0.00844137763816, -0.232290280417], [0.00112623777097, -0.00383222361886], [-0.000991523023407, -0.00274919840805]] },
  { name: 'EV 1000nm 5nm shell @405', m1: [1.0274801405318974, 0.0], m2: [1.1019352231791364, 0.0], xc: 10.314203457619602, xs: 10.418387330928889, qext: 0.1797301752138843, qsca: 0.17973017521388743, qback: 0.0014002049044972605, g: 0.972612140414931, S1: [[4.87710387189, -22.1482444779], [0.119251576911, -0.329983522204], [0.0664407265673, -0.105139794046]], S2: [[4.87710387189, -22.1482444779], [-0.00395485706623, -0.0211461084512], [-0.0621817361924, 0.102455272803]] },
  { name: 'thick absorbing coat', m1: [1.5, 0.01], m2: [1.33, 0.05], xc: 3.0, xs: 4.0, qext: 3.3899224938507864, qsca: 2.934498770052448, qback: 0.04929715652486819, g: 0.8225007815814507, S1: [[13.5596899754, -3.93326835715], [-1.413735048, -0.0203587107912], [0.519413993842, 0.28135655491]], S2: [[13.5596899754, -3.93326835715], [-1.03872775024, -0.554463305366], [0.621387947307, -0.0283030882811]] },
  { name: 'high-index core', m1: [2.0, 0.0], m2: [1.2, 0.0], xc: 5.0, xs: 8.0, qext: 2.5531637775789124, qsca: 2.553163777578912, qback: 10.483687827157874, g: 0.6168769028924708, S1: [[40.8506204413, -11.0889318459], [-0.494058346359, 0.352847236657], [2.41001036881, 4.20793779749]], S2: [[40.8506204413, -11.0889318459], [2.00527418406, -2.08287858856], [2.62061241542, -0.119902175842]] },
];

const ang = ANGLES_DEG.map((a) => (a * Math.PI) / 180);
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function checkS(re: Float64Array, im: Float64Array, ref: number[][], tol: number) {
  for (let j = 0; j < ref.length; j++) {
    const [r, i] = ref[j];
    // reference S values were rounded to 12 significant digits
    expect(Math.hypot(re[j] - r, im[j] - i) / Math.hypot(r, i)).toBeLessThan(tol);
  }
}

describe('BHMIE homogeneous sphere vs miepython / PyMieScatt', () => {
  for (const c of SPHERE_REFS) {
    it(c.name, () => {
      const r = mieSphere({ re: c.m[0], im: c.m[1] }, c.x, ang);
      expect(rel(r.qext, c.qext)).toBeLessThan(1e-6);
      expect(rel(r.qsca, c.qsca)).toBeLessThan(1e-6);
      expect(rel(r.qback, c.qback)).toBeLessThan(1e-6);
      expect(rel(r.g, c.g)).toBeLessThan(1e-6);
      checkS(r.S1re, r.S1im, c.S1, 1e-6);
      checkS(r.S2re, r.S2im, c.S2, 1e-6);
    });
  }
  it('real index equals im = 0 complex index', () => {
    const a = mieSphere(1.2, 3);
    const b = mieSphere({ re: 1.2, im: 0 }, 3);
    expect(a.qsca).toBe(b.qsca);
  });
});

describe('BHCOAT coated sphere vs PyMieScatt', () => {
  for (const c of COATED_REFS) {
    it(c.name, () => {
      const r = mieCoated({ re: c.m1[0], im: c.m1[1] }, { re: c.m2[0], im: c.m2[1] }, c.xc, c.xs, ang);
      expect(rel(r.qext, c.qext)).toBeLessThan(1e-6);
      expect(rel(r.qsca, c.qsca)).toBeLessThan(1e-6);
      expect(rel(r.qback, c.qback)).toBeLessThan(1e-6);
      expect(rel(r.g, c.g)).toBeLessThan(1e-6);
      checkS(r.S1re, r.S1im, c.S1, 1e-6);
      checkS(r.S2re, r.S2im, c.S2, 1e-6);
    });
  }
  it('reduces to a homogeneous sphere when core = shell', () => {
    const a = mieCoated(1.1, 1.1, 2, 5, ang);
    const b = mieSphere(1.1, 5, ang);
    expect(rel(a.qsca, b.qsca)).toBeLessThan(1e-10);
    expect(rel(a.S1re[1], b.S1re[1])).toBeLessThan(1e-9);
  });
  it('large-x stability (x = 50, thin shell)', () => {
    const r = mieCoated(1.03, 1.1, 49.6, 50);
    expect(Number.isFinite(r.qsca) && r.qsca > 0 && r.qsca <= r.qext + 1e-12).toBe(true);
  });
});

describe('refractive indices', () => {
  it('water (Daimon & Masumura 20 °C)', () => {
    expect(Math.abs(riWater(405) - 1.343091653)).toBeLessThan(2e-6); // FCMPASS sheath RI at 405 nm
    expect(riWater(405).toFixed(3)).toBe('1.343'); // de Rond 2018 Table 1
    expect(riWater(488).toFixed(3)).toBe('1.337');
    expect(Math.abs(riWater(633) - 1.332)).toBeLessThan(1e-3);
  });
  it('polystyrene (Sultanova 2009)', () => {
    expect(riPolystyrene(488).toFixed(3)).toBe('1.605'); // de Rond 1.605
    expect(riPolystyrene(589).toFixed(2)).toBe('1.59');
    // 405 nm: formula 1.6268 (extrapolated); de Rond lists 1.633, Welsh et al. 2020 list 1.624
    expect(Math.abs(riPolystyrene(405) - 1.627)).toBeLessThan(1e-3);
    expect(Math.abs(riPolystyrene(405) - 1.633)).toBeLessThan(0.01);
  });
  it('silica (Malitson)', () => {
    expect(riSilica(405).toFixed(3)).toBe('1.470'); // Welsh et al. 2020 Table 2
    expect(riSilica(488).toFixed(3)).toBe('1.463');
    expect(riSilica(589).toFixed(4)).toBe('1.4584');
  });
  it('all common laser lines are finite and ordered (normal dispersion)', () => {
    const ls = [375, 405, 445, 488, 532, 561, 594, 638, 640];
    for (let i = 1; i < ls.length; i++) {
      for (const f of [riWater, riPolystyrene, riSilica]) expect(f(ls[i])).toBeLessThan(f(ls[i - 1]));
    }
  });
  it('RISpec offset to a certificate value', () => {
    expect(resolveRI({ material: 'silica', n: 1.43, atNm: 589 }, 589).re).toBeCloseTo(1.43, 12);
    const d = riSilica(405) - riSilica(589);
    expect(resolveRI({ material: 'silica', n: 1.43, atNm: 589 }, 405).re).toBeCloseTo(1.43 + d, 12);
    expect(resolveRI({ material: 'water', n: 1.38, atNm: 405 }, 488).re).toBeCloseTo(1.38 + riWater(488) - riWater(405), 12);
    expect(resolveRI({ re: 1.5, im: 0.01 }, 405)).toEqual({ re: 1.5, im: 0.01 });
    expect(sizeParameter(100, 405, 1.343)).toBeCloseTo((Math.PI * 100 * 1.343) / 405, 12);
  });
});

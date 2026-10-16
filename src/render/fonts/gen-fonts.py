#!/usr/bin/env python3
"""Generate src/render/fonts/data.ts: subsets of metric-compatible open fonts, used to measure text, as on-screen
fallback and embedded in PDF exports.

FlowState Sans = subset of Liberation Sans 2.1.5 (Arial / Helvetica metrics), FlowState Serif = subset of Liberation
Serif 2.1.5 (Times New Roman metrics), FlowState Humanist = subset of Carlito 1.104 (Calibri metrics); SIL OFL 1.1.
The subsets are Modified Versions in the sense of the OFL, so they must not carry the Reserved Font Names (Liberation,
Arimo, Tinos, Cousine, Carlito): name records 1, 3, 4 and 6 are replaced; the copyright (0), version (5) and license
(13, 14) records are kept. Subset: Latin-1 + WinAnsi extras + Greek + common scientific symbols; hinting, layout tables
and glyph names dropped.
Run from the repository root:  python3 src/render/fonts/gen-fonts.py  (needs fonttools and the fonts installed).
"""
import base64, io, os, zlib
from fontTools import subset
from fontTools.ttLib import TTFont

LIB = '/usr/share/fonts/truetype/liberation/'
CRX = '/usr/share/fonts/truetype/crosextra/'
FACES = [
    # key, file, family name of the subset, PDF base name (= PostScript name), serif, bold, italic
    ('sans', LIB + 'LiberationSans-Regular.ttf', 'FlowState Sans', 'FlowStateSans', False, False, False),
    ('sans-b', LIB + 'LiberationSans-Bold.ttf', 'FlowState Sans', 'FlowStateSans-Bold', False, True, False),
    ('sans-i', LIB + 'LiberationSans-Italic.ttf', 'FlowState Sans', 'FlowStateSans-Italic', False, False, True),
    ('serif', LIB + 'LiberationSerif-Regular.ttf', 'FlowState Serif', 'FlowStateSerif', True, False, False),
    ('serif-b', LIB + 'LiberationSerif-Bold.ttf', 'FlowState Serif', 'FlowStateSerif-Bold', True, True, False),
    ('serif-i', LIB + 'LiberationSerif-Italic.ttf', 'FlowState Serif', 'FlowStateSerif-Italic', True, False, True),
    ('carlito', CRX + 'Carlito-Regular.ttf', 'FlowState Humanist', 'FlowStateHumanist', False, False, False),
    ('carlito-b', CRX + 'Carlito-Bold.ttf', 'FlowState Humanist', 'FlowStateHumanist-Bold', False, True, False),
]
# names that the OFL reserves for the original fonts: none may appear in the subsets' names (except the copyright line)
RESERVED = ('Liberation', 'Arimo', 'Tinos', 'Cousine', 'Carlito')

CPS = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
CPS += [0x152, 0x153, 0x160, 0x161, 0x178, 0x17D, 0x17E, 0x192, 0x2C6, 0x2DC, 0x2013, 0x2014, 0x2018, 0x2019, 0x201A,
        0x201C, 0x201D, 0x201E, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203A, 0x20AC, 0x2122]
CPS += list(range(0x391, 0x3A2)) + list(range(0x3A3, 0x3AA)) + list(range(0x3B1, 0x3CA)) + [0x3D1, 0x3D5, 0x3D6]
CPS += [0x2212, 0x2264, 0x2265, 0x2260, 0x2248, 0x2126, 0x2206, 0x221E, 0x2190, 0x2191, 0x2192, 0x2193, 0x2032,
        0x2033, 0x2009, 0x202F, 0x2010, 0x2219, 0x221A, 0x2116, 0x2030]
CPS = sorted(set(CPS))


def b36(v, n):
    s = ''
    for _ in range(n):
        s = '0123456789abcdefghijklmnopqrstuvwxyz'[v % 36] + s
        v //= 36
    return s


def rename(f, family, ps):
    """Name records of the Modified Version: own family / full / unique / PostScript names, original copyright,
    version and license records unchanged."""
    name = f['name']
    style = name.getDebugName(2) or 'Regular'
    version = name.getDebugName(5) or ''
    name.names = [r for r in name.names if r.nameID in (0, 2, 5, 13, 14)]
    full = family if style == 'Regular' else family + ' ' + style
    for nid, text in ((1, family), (3, '%s %s; %s; FlowState subset' % (family, style, version)), (4, full), (6, ps)):
        name.setName(text, nid, 3, 1, 0x409)
    for r in name.names:
        if r.nameID != 0:
            assert not any(w in r.toUnicode() for w in RESERVED), (ps, r.nameID, r.toUnicode())
    for nid in (0, 13, 14):
        assert name.getDebugName(nid), (ps, 'missing name record', nid)


def face(key, path, family, base, serif, bold, italic):
    f = TTFont(path, recalcTimestamp=False)  # keep head.modified: reproducible output
    have = f.getBestCmap()
    opts = subset.Options()
    opts.hinting = False
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.name_languages = [0x409]
    opts.layout_features = []
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'kern', 'DSIG', 'gasp', 'hdmx', 'VDMX', 'LTSH', 'PCLT', 'FFTM', 'meta']
    s = subset.Subsetter(opts)
    s.populate(unicodes=[c for c in CPS if c in have])
    s.subset(f)
    rename(f, family, base)
    buf = io.BytesIO()
    f.save(buf)
    raw = buf.getvalue()
    f = TTFont(io.BytesIO(raw))
    upm = f['head'].unitsPerEm
    order = f.getGlyphOrder()
    gid = {g: i for i, g in enumerate(order)}
    cmap = f.getBestCmap()
    hmtx = f['hmtx']
    k = 1000 / upm
    widths = [round(hmtx[g][0] * k) for g in order]
    assert max(widths) < 36 ** 3
    gids = ''.join(b36(gid[cmap[c]] if c in cmap else 0, 2) for c in CPS)
    hd, hh, os2 = f['head'], f['hhea'], f['OS/2']
    stemv = 140 if bold else 80
    flags = (2 if serif else 0) | 32 | (64 if italic else 0)
    meta = dict(
        key=key, base=base, upm=upm,
        asc=round(hh.ascent * k), desc=round(hh.descent * k), cap=round(getattr(os2, 'sCapHeight', 0) * k) or round(hh.ascent * k * 0.75),
        bbox=[round(hd.xMin * k), round(hd.yMin * k), round(hd.xMax * k), round(hd.yMax * k)],
        italic=float(f['post'].italicAngle), flags=flags, stemV=stemv,
    )
    z = zlib.compress(raw, 9)
    return meta, gids, ''.join(b36(w, 3) for w in widths), base64.b64encode(z).decode(), len(raw), len(z)


def main():
    out = ['// Generated by gen-fonts.py: do not edit. FlowState Sans / Serif / Humanist: subsets (OFL Modified Versions) of',
           '// Liberation Sans / Liberation Serif 2.1.5 and Carlito 1.104, SIL Open Font License 1.1 (see THIRD_PARTY_NOTICES.md).',
           '// Each face: metrics in 1000 units/em, glyph ids for CPS (2 base-36 digits each, 0 = missing),',
           '// advance widths per glyph id (3 base-36 digits each), and the zlib-compressed TrueType subset (base64).',
           'export const CPS = ' + repr(''.join(b36(c, 4) for c in CPS)) + ';',
           'export interface FaceData { key: string; base: string; asc: number; desc: number; cap: number; bbox: number[]; italic: number; flags: number; stemV: number; gids: string; widths: string; ttf: string; len: number }',
           'export const FACES: FaceData[] = [']
    total = 0
    for spec in FACES:
        meta, gids, widths, ttf, n, nz = face(*spec)
        total += len(ttf)
        out.append('  { key: %r, base: %r, asc: %d, desc: %d, cap: %d, bbox: [%s], italic: %s, flags: %d, stemV: %d, len: %d,' % (
            meta['key'], meta['base'], meta['asc'], meta['desc'], meta['cap'], ', '.join(map(str, meta['bbox'])), repr(meta['italic']), meta['flags'], meta['stemV'], n))
        out.append('    gids: %r,' % gids)
        out.append('    widths: %r,' % widths)
        out.append('    ttf: %r },' % ttf)
        print(meta['key'], 'raw', n, 'zlib', nz, 'b64', len(ttf))
    out.append('];')
    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.ts')
    open(dst, 'w').write('\n'.join(out) + '\n')
    print('total base64', total, '->', dst)


main()

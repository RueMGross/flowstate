# Systematic feature walk-through with screenshots and console error capture.
import asyncio, os, sys
from playwright.async_api import async_playwright
OUT = '/tmp/claude-0/e2e'
URL = os.environ.get('URL', 'file:///home/claude/flowcanvas/dist-single/index.html')
log = []
def L(*a):
    s = ' '.join(str(x) for x in a); log.append(s); print(s, flush=True)

async def item_box(pg, i):
    return await pg.locator('.page .item').nth(i).bounding_box()

async def frame_pt(pg, i, fx, fy):
    """point inside item i at fractional position of its plot frame (approx: frame = item minus margins)"""
    b = await item_box(pg, i)
    # plot frame approx: left 5.4em, right .9em, top 1.9em, bottom 3.5em at 8pt*96/72*zoom
    fs = 8*96/72
    x0 = b['x'] + fs*5.4; x1 = b['x'] + b['width'] - fs*0.9
    y0 = b['y'] + fs*1.9; y1 = b['y'] + b['height'] - fs*3.5
    return x0 + (x1-x0)*fx, y1 - (y1-y0)*fy

async def shot(pg, name):
    await pg.screenshot(path=f'{OUT}/{name}.png')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE ' + m.text) if m.type in ('error','warning') and 'fonts.g' not in m.text else None)
        await pg.goto(URL); await pg.wait_for_timeout(1800)
        await shot(pg, '01_demo')
        n_items = await pg.locator('.page .item').count(); L('items', n_items)
        # --- plot types on item 6 (T cells CD4/CD8)
        await pg.locator('.page .item').nth(6).click(position={'x': 20, 'y': 10})
        await pg.wait_for_timeout(200)
        for t in ['Dot plot', 'Density', 'Contour', 'Pseudocolor']:
            await pg.locator(f'.seg button[title="{t}"]').first.click(); await pg.wait_for_timeout(300)
            await shot(pg, f'02_type_{t.replace(" ","_")}')
        # --- new plot for gating tests: add pseudocolor plot via ribbon (population = selection)
        await pg.keyboard.press('Escape')
        await pg.get_by_role('button', name='Pseudocolor').first.click(); await pg.wait_for_timeout(400)
        idx = await pg.locator('.page .item').count() - 1
        # scroll it into view
        await pg.locator('.page .item').nth(idx).scroll_into_view_if_needed(); await pg.wait_for_timeout(300)
        await shot(pg, '03_newplot')
        # polygon
        await pg.keyboard.press('p')
        pts = [(0.2,0.2),(0.5,0.15),(0.55,0.5),(0.25,0.55)]
        for k,(fx,fy) in enumerate(pts):
            x,y = await frame_pt(pg, idx, fx, fy); await pg.mouse.click(x,y); await pg.wait_for_timeout(80)
        x,y = await frame_pt(pg, idx, *pts[0]); await pg.mouse.click(x,y); await pg.wait_for_timeout(300)
        await shot(pg, '04_polygon_rename')
        await pg.keyboard.type('MyPoly'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        # rect
        await pg.keyboard.press('r')
        x0,y0 = await frame_pt(pg, idx, 0.6, 0.6); x1,y1 = await frame_pt(pg, idx, 0.9, 0.9)
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move(x1,y1,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Enter')
        # ellipse
        await pg.keyboard.press('e')
        x0,y0 = await frame_pt(pg, idx, 0.6, 0.1); x1,y1 = await frame_pt(pg, idx, 0.85, 0.4)
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move(x1,y1,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Enter')
        await shot(pg, '05_three_gates')
        # move ellipse body
        cx,cy = await frame_pt(pg, idx, 0.72, 0.25)
        await pg.mouse.move(cx,cy); await pg.mouse.down(); await pg.mouse.move(cx-30,cy+10,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await shot(pg, '06_moved_ellipse')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(300)
        await shot(pg, '07_undo_move')
        # quadrant on a duplicate plot
        await pg.keyboard.press('Escape')
        await pg.get_by_role('button', name='Pseudocolor').first.click(); await pg.wait_for_timeout(400)
        q = await pg.locator('.page .item').count() - 1
        await pg.locator('.page .item').nth(q).scroll_into_view_if_needed()
        await pg.keyboard.press('q'); x,y = await frame_pt(pg, q, 0.5, 0.5); await pg.mouse.click(x,y); await pg.wait_for_timeout(300)
        await shot(pg, '08_quadrant')
        # histogram: range and split
        await pg.keyboard.press('Escape')
        await pg.get_by_role('button', name='Histogram').first.click(); await pg.wait_for_timeout(400)
        h = await pg.locator('.page .item').count() - 1
        await pg.locator('.page .item').nth(h).scroll_into_view_if_needed()
        await pg.keyboard.press('h'); x0,y0 = await frame_pt(pg, h, 0.55, 0.5); x1,y1 = await frame_pt(pg, h, 0.95, 0.5)
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move(x1,y1,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Enter')
        await pg.keyboard.press('s'); x,y = await frame_pt(pg, h, 0.4, 0.5); await pg.mouse.click(x,y); await pg.wait_for_timeout(300)
        await shot(pg, '09_hist_gates')
        # --- axis dialog
        await pg.locator('.page .item').nth(h).click(position={'x': 20, 'y': 8}); await pg.wait_for_timeout(200)
        await pg.get_by_title('Edit axis scale').first.click(); await pg.wait_for_timeout(400)
        await shot(pg, '10_axis_dialog')
        await pg.keyboard.press('Escape')
        # --- layout: select all plots, align/distribute/arrange
        await pg.keyboard.press('Control+a'); await pg.wait_for_timeout(200)
        await pg.get_by_role('tab', name='Layout').click(); await pg.wait_for_timeout(200)
        await shot(pg, '11_layout_tab')
        await pg.get_by_role('button', name='Arrange grid').click(); await pg.wait_for_timeout(500)
        await shot(pg, '12_arranged')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(300)
        await pg.get_by_role('button', name='Gating strategy').click(); await pg.wait_for_timeout(800)
        await shot(pg, '13_gating_strategy')
        # --- tables, comp
        await pg.locator('.doc-tab', has_text='Statistics').click(); await pg.wait_for_timeout(500)
        await shot(pg, '14_tables')
        await pg.locator('.doc-tab', has_text='Compensation').click(); await pg.wait_for_timeout(500)
        await shot(pg, '15_comp')
        # --- export per sample pdf
        await pg.locator('.doc-tab', has_text='Gating').first.click(); await pg.wait_for_timeout(300)
        await pg.get_by_role('tab', name='Export').click()
        await pg.get_by_role('button', name='PDF').first.click(); await pg.wait_for_timeout(300)
        await pg.get_by_role('button', name='One per sample', exact=False).click(); await pg.wait_for_timeout(200)
        await shot(pg, '16_export_dialog')
        async with pg.expect_download() as dl:
            await pg.locator('.modal-foot .btn.primary').click()
        d = await dl.value; await d.save_as(f'{OUT}/per_sample.pdf'); L('download', d.suggested_filename)
        # --- dark
        await pg.emulate_media(color_scheme='dark'); await pg.wait_for_timeout(300)
        await shot(pg, '17_dark')
        L('ERRORS', len(errs)); [L(' ', e[:300]) for e in errs[:30]]
        await b.close()
asyncio.run(main())

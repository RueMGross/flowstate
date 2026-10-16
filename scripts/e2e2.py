import asyncio, glob
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000})
        errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        await pg.goto('file:///home/claude/flowcanvas/dist-single/index.html')
        await pg.wait_for_timeout(1500)
        # 1) open bundle exported earlier
        await pg.locator('input[type=file]').nth(1).set_input_files(['/tmp/claude-0/bundle.zip'])
        await pg.wait_for_timeout(2500)
        print('after bundle samples:', await pg.locator('.srow').count(), 'pops:', await pg.locator('.prow').count())
        await pg.screenshot(path='/tmp/claude-0/e2_bundle.png')
        # 2) comp controls + wizard
        await pg.get_by_role('button', name='New workspace').click()
        await pg.get_by_role('button', name='Discard and start new').click()
        files = sorted(glob.glob('/home/claude/testdata/comp/*.fcs'))
        await pg.locator('input[type=file]').first.set_input_files(files)
        await pg.wait_for_timeout(3000)
        await pg.locator('.doc-tab', has_text='Compensation').click()
        await pg.wait_for_timeout(300)
        await pg.get_by_role('button', name='From controls').first.click()
        await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/e2_wizard.png')
        await pg.get_by_role('button', name='Compute matrix').click()
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/e2_comp.png')
        # 3) import gating-ml into this workspace
        await pg.locator('input[type=file]').nth(1).set_input_files(['/tmp/claude-0/gates.xml'])
        await pg.wait_for_timeout(1000)
        print('pops after gml:', await pg.locator('.prow').count())
        print('errors:', errs[:5])
        await b.close()
asyncio.run(main())

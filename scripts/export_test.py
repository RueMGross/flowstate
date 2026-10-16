import asyncio
from playwright.async_api import async_playwright
URL = 'file:///home/claude/flowcanvas/dist-single/index.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL)
        await pg.wait_for_timeout(1500)
        await pg.get_by_role('tab', name='Export').first.click()
        for fmt, label in [('pdf', 'PDF'), ('svg', 'SVG'), ('png', 'PNG / TIFF-ready')]:
            await pg.get_by_role('button', name=label).first.click()
            await pg.wait_for_timeout(300)
            async with pg.expect_download() as dl:
                await pg.locator('.modal-foot .btn.primary').click()
            d = await dl.value
            await d.save_as(f'/tmp/claude-0/export.{fmt}')
            print('saved', fmt, d.suggested_filename)
        # workspace bundle
        async with pg.expect_download() as dl:
            await pg.get_by_role('button', name='With data').first.click()
        d = await dl.value
        await d.save_as('/tmp/claude-0/bundle.zip'); print('bundle', d.suggested_filename)
        async with pg.expect_download() as dl:
            await pg.get_by_role('button', name='Gating-ML').first.click()
        d = await dl.value
        await d.save_as('/tmp/claude-0/gates.xml'); print('gml', d.suggested_filename)
        for l in logs:
            if 'fonts.g' in l: continue
            print(l)
        await b.close()
asyncio.run(main())

import asyncio, time
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000})
        logs = []
        pg.on('console', lambda m: logs.append((time.time(), m.text)))
        await pg.goto('file:///home/claude/flowcanvas/dist-single/index.html')
        await pg.wait_for_timeout(1500)
        await pg.evaluate('window.__fcPerf = true')
        t0 = time.time()
        await pg.locator('input[type=file]').first.set_input_files(['/home/claude/testdata/big/big_1M.fcs'])
        await pg.get_by_text('Loaded 1 file').wait_for(timeout=60000)
        t1 = time.time()
        print(f'load+parse+render: {t1-t0:.2f}s')
        await pg.wait_for_timeout(1000)
        for t, l in logs:
            if l.startswith('render'): print(f'{t-t0:6.2f}s', l)
        logs.clear()
        # draw a polygon on the first plot and measure
        t0 = time.time()
        await pg.keyboard.press('r')
        await pg.mouse.move(450, 330); await pg.mouse.down(); await pg.mouse.move(560, 420, steps=4); await pg.mouse.up()
        await pg.wait_for_timeout(1500)
        for t, l in logs:
            if l.startswith('render'): print(f'gate {t-t0:6.2f}s', l)
        await pg.screenshot(path='/tmp/claude-0/perf.png')
        await b.close()
asyncio.run(main())

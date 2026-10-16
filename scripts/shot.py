import sys, asyncio, json
from playwright.async_api import async_playwright

import os
URL = os.environ.get('URL', 'file:///home/claude/flowcanvas/dist-single/index.html')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/shot.png'
ACTIONS = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL)
        await pg.wait_for_timeout(1500)
        for a in ACTIONS:
            kind = a[0]
            if kind == 'click': await pg.mouse.click(a[1], a[2])
            elif kind == 'rclick': await pg.mouse.click(a[1], a[2], button='right')
            elif kind == 'dblclick': await pg.mouse.dblclick(a[1], a[2])
            elif kind == 'key': await pg.keyboard.press(a[1])
            elif kind == 'text': await pg.get_by_text(a[1], exact=a[2] if len(a) > 2 else False).first.click()
            elif kind == 'role': await pg.get_by_role(a[1], name=a[2]).first.click()
            elif kind == 'drag':
                await pg.mouse.move(a[1], a[2]); await pg.mouse.down(); 
                steps = 8
                for i in range(1, steps+1):
                    await pg.mouse.move(a[1] + (a[3]-a[1])*i/steps, a[2] + (a[4]-a[2])*i/steps)
                await pg.mouse.up()
            elif kind == 'css': await pg.locator(a[1], has_text=a[2] if len(a) > 2 else None).first.click()
            elif kind == 'type': await pg.keyboard.type(a[1])
            elif kind == 'files':
                t0 = asyncio.get_event_loop().time()
                await pg.locator('input[type=file]').first.set_input_files(a[1])
                await pg.wait_for_timeout(200)
                logs.append(f'files set in {asyncio.get_event_loop().time()-t0:.2f}s')
            elif kind == 'timeit':
                t = await pg.evaluate(a[1])
                logs.append(f'TIMEIT {t}')
            elif kind == 'wait': await pg.wait_for_timeout(a[1])
            elif kind == 'eval': logs.append('EVAL: ' + str(await pg.evaluate(a[1])))
            elif kind == 'shot': await pg.screenshot(path=a[1])
            await pg.wait_for_timeout(250)
        await pg.screenshot(path=OUT)
        for l in logs:
            if 'fonts.googleapis' in l or 'ERR_NAME' in l or 'net::' in l: continue
            print(l)
        await b.close()

asyncio.run(main())

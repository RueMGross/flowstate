import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/claude-0/pwprofile', viewport={'width': 1400, 'height': 900})
        pg = await ctx.new_page()
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto('http://localhost:8765/index.html')
        await pg.wait_for_timeout(1500)
        await pg.locator('input[type=file]').first.set_input_files(['/home/claude/testdata/bd/fortessa.fcs', '/home/claude/testdata/bd/lsrii_hts.fcs'])
        await pg.wait_for_timeout(2000)
        # draw a rectangle gate on first plot
        await pg.keyboard.press('r')
        await pg.mouse.move(460, 380); await pg.mouse.down(); await pg.mouse.move(520, 420, steps=5); await pg.mouse.up()
        await pg.wait_for_timeout(400)
        await pg.keyboard.press('Enter')
        await pg.wait_for_timeout(1500)
        await pg.reload()
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path='/tmp/claude-0/restored.png')
        txt = await pg.locator('.ptree').inner_text()
        print('populations after reload:', txt.replace('\n', ' | ')[:200])
        print('samples:', (await pg.locator('.srow').all_inner_texts()))
        for l in logs: print(l)
        await ctx.close()
asyncio.run(main())

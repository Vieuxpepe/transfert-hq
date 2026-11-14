import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
DROP = """() => { document.querySelectorAll('aside').forEach(a => {
  if ((a.getAttribute('aria-label') || '').indexOf('Diagnostics') >= 0) a.remove(); }); }"""
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        for w, h, name in ((390, 844, "nav-mobile-plus-390.png"), (320, 568, "nav-mobile-plus-320.png")):
            ctx = await br.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=2)
            await ctx.request.post(BASE + "/login", form={"pin": PIN}, headers={"origin": BASE}, max_redirects=0)
            p = await ctx.new_page(); await p.goto(BASE + "/#accueil"); await p.wait_for_selector(".bottom-nav")
            await p.wait_for_timeout(1400)
            await p.evaluate(DROP)
            await p.locator('.bottom-nav [data-nav="plus"]').click()
            await p.wait_for_timeout(900)
            await p.evaluate(DROP)
            await p.screenshot(path=name)
            print("saved", name, await p.evaluate("[document.body.dataset.view, document.querySelectorAll('.hq-more-nav [data-view-link]').length]"))
            await ctx.close()
        await br.close()
asyncio.run(main())

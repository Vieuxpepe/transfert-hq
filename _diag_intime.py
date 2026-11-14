import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page()
        p.on("console", lambda m: print("  console", m.type, m.text[:100]) if m.type in ("error","warning") else None)
        p.on("pageerror", lambda e: print("  pageerror", str(e)[:160]))
        await p.goto(BASE+"/#plus"); await p.wait_for_selector(".bottom-nav"); await p.wait_for_timeout(1500)
        await p.locator('.hq-more-nav [data-view-link="intime"]').click()
        await p.wait_for_timeout(700)
        print("view after intime:", await p.evaluate("document.body.dataset.view"))
        info = await p.evaluate("""() => { const b = document.querySelector('.bottom-nav [data-nav="plus"]'); const r = b.getBoundingClientRect();
            const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
            return {rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                    top: el ? el.tagName + '#' + (el.id||'') + '.' + String(el.className||'').slice(0,40) : null,
                    navZ: getComputedStyle(document.querySelector('.bottom-nav')).zIndex}; }""")
        print("plus hit:", info)
        await p.locator('.bottom-nav [data-nav="plus"]').click()
        await p.wait_for_timeout(600)
        print("view after plus:", await p.evaluate("document.body.dataset.view"))
        print("setView direct:", await p.evaluate("() => { setView('plus'); return document.body.dataset.view; }"))
        await br.close()
asyncio.run(main())

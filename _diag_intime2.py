import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page()
        p.on("pageerror", lambda e: print("  pageerror", str(e)[:160]))
        await p.goto(BASE+"/#plus"); await p.wait_for_selector(".bottom-nav"); await p.wait_for_timeout(1500)
        print("start:", await p.evaluate("document.body.dataset.view"))
        await p.evaluate("setView('intime')")
        await p.wait_for_timeout(800)
        print("after setView(intime):", await p.evaluate("document.body.dataset.view"),
              "panel:", await p.evaluate("!!document.querySelector('[data-panel=intime]').offsetParent"))
        print("plus clickable:", await p.evaluate("""() => { const b=document.querySelector('.bottom-nav [data-nav=plus]');
            const r=b.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
            return {rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], top: e? e.tagName+'#'+(e.id||'')+'.'+String(e.className||'').slice(0,30):null}; }"""))
        await p.locator('.bottom-nav [data-nav=plus]').click()
        await p.wait_for_timeout(800)
        print("after plus click:", await p.evaluate("document.body.dataset.view"))
        ok = await p.evaluate("() => { try { setView('plus'); } catch (e) { return 'ERR ' + e.message; } return document.body.dataset.view; }")
        print("direct setView(plus):", ok)
        await p.screenshot(path="_intime_plus.png")
        await br.close()
asyncio.run(main())

import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        for w,h in ((320,568),(390,844)):
            ctx = await br.new_context(viewport={"width":w,"height":h}, is_mobile=True, has_touch=True, device_scale_factor=2)
            await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
            p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
            await p.wait_for_timeout(1200)
            info = await p.evaluate("""() => {
              const b = document.querySelector('.bottom-nav [data-nav="plus"]');
              const r = b.getBoundingClientRect();
              const cx = r.left + r.width/2, cy = r.top + r.height/2;
              const top = document.elementFromPoint(cx, cy);
              const n = document.querySelector('.bottom-nav').getBoundingClientRect();
              return {btn: {l:Math.round(r.left), t:Math.round(r.top), r:Math.round(r.right), b:Math.round(r.bottom)},
                      bar: {t:Math.round(n.top), b:Math.round(n.bottom)},
                      vh: innerHeight,
                      hit: top ? (top.tagName + '#' + (top.id||'') + '.' + (top.className||'').toString().slice(0,60)) : null,
                      hitParent: top && top.parentElement ? (top.parentElement.tagName + '#' + (top.parentElement.id||'')) : null}; }""")
            print(w, h, info)
            await p.screenshot(path=f"_diag_{w}.png")
            await ctx.close()
        await br.close()
asyncio.run(main())


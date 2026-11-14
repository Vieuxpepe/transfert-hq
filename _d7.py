import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav"); await p.wait_for_timeout(1400)
        for name in ("carnet", "calendrier", "fichiers", "plus"):
            await p.locator(f'.bottom-nav [data-nav="{name}"]').click(force=True)
            await p.wait_for_timeout(700)
            print(name, "->", await p.evaluate("""() => { const b=document.querySelector('.bottom-nav [data-nav="plus"]'); const r=b.getBoundingClientRect();
                const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
                return [document.body.dataset.view, document.body.classList.contains('hq-vt-active'),
                        e ? e.tagName+'.'+String(e.className||'').slice(0,30) : null]; }"""))
        await br.close()
asyncio.run(main())

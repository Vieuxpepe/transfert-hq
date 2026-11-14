import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
SEL = [".topbar", ".brand-lockup", ".topbar-actions", ".hq-companions-controls", "#hq-capture", ".hq-inventoria",
       ".bottom-nav", ".wrap", "#main", "body > *"]
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":320,"height":568}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1200)
        for sel in SEL:
            w = await p.evaluate("""(sel) => { const els=[...document.querySelectorAll(sel)]; const disp=els.map(e=>e.style.display);
                els.forEach(e=>e.style.display='none'); const out=innerWidth; els.forEach((e,i)=>e.style.display=disp[i]); return out; }""", sel)
            print(f"{sel:28s} -> innerWidth {w}")
        await br.close()
asyncio.run(main())

import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":1440,"height":900})
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        await ctx.add_init_script("try { localStorage.setItem('tf_hq_mode','complet'); } catch (_) {}")
        p = await ctx.new_page(); await p.goto(BASE+"/"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1500)
        for v in ("engine", "securite", "musique", "securite"):
            await p.evaluate(f"setView('{v}')")
            await p.wait_for_timeout(700)
            print(v, "->", await p.evaluate("[document.body.dataset.view, location.hash]"))
        # rapid double click: the last one must win, no late hash handler may revert it
        for a, b in (("engine", "securite"), ("musique", "accueil"), ("securite", "engine")):
            await p.evaluate(f"setView('{a}')")
            await p.wait_for_timeout(40)
            await p.evaluate(f"setView('{b}')")
            await p.wait_for_timeout(900)
            print("rapid", a, "then", b, "->", await p.evaluate("[document.body.dataset.view, location.hash]"))
        await br.close()
asyncio.run(main())

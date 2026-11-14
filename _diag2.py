import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":320,"height":568}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1200)
        print(await p.evaluate("""() => ({iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth,
            meta: (document.querySelector('meta[name=viewport]')||{}).content, scale: visualViewport.scale})"""))
        print("nav hidden:", await p.evaluate("""() => { const n=document.querySelector('.bottom-nav'); const was=n.style.display;
            n.style.display='none'; const out={iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth};
            n.style.display=was; return out; }"""))
        print("widest:", await p.evaluate("""() => { const list=[...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect();
            return {t:e.tagName+'.'+String(e.className||'').slice(0,30)+'#'+(e.id||''), w:Math.round(r.width), l:Math.round(r.left)};})
            .filter(x=>x.w>330).sort((a,b)=>b.w-a.w).slice(0,6); return list; }"""))
        await br.close()
asyncio.run(main())

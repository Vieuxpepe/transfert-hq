import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#plus"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1500)
        await p.evaluate("setView('intime')")
        await p.wait_for_timeout(1800)
        print(await p.evaluate("""() => {
          const box = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
          const b = document.querySelector('.bottom-nav [data-nav=plus]').getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
          return {nav: box('.bottom-nav'), companion: box('#hq-companion'), actions: box('.hq-companion-actions'),
                  bubble: box('.hq-companion-bubble'), capture: box('.hq-capture-fab'), inventoria: box('#hq-inventoria'),
                  plus: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
                  hit: hit ? hit.tagName + '#' + (hit.id||'') + '.' + String(hit.className||'').slice(0,40) : null,
                  ih: innerHeight, iw: innerWidth, navH: getComputedStyle(document.documentElement).getPropertyValue('--nav-h')}; }"""))
        await p.screenshot(path="_intime_390.png")
        await br.close()
asyncio.run(main())

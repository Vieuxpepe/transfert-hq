import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#plus"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1200); await p.evaluate("setView('intime')"); await p.wait_for_timeout(1500)
        print(await p.evaluate("""() => { const n = document.querySelector('.bottom-nav'), c = document.querySelector('#hq-companion');
            const cs = getComputedStyle(n), cc = getComputedStyle(c);
            const b = document.querySelector('.bottom-nav [data-nav=plus]').getBoundingClientRect();
            const stack = document.elementsFromPoint(b.left + b.width/2, b.top + b.height/2)
              .slice(0, 6).map(x => x.tagName + '#' + (x.id||'') + '.' + String(x.className||'').slice(0,24));
            const before = stack;
            const tries = {};
            for (const z of ['500', '600', '1000', '2000']) {
              n.style.zIndex = z;
              tries[z] = document.elementsFromPoint(b.left + b.width/2, b.top + b.height/2)[0].className.toString().slice(0, 24);
            }
            n.style.zIndex = '';
            const chain = []; let e = c;
            while (e && e !== document.body) { const s2 = getComputedStyle(e);
              chain.push(e.tagName + '#' + (e.id||'') + '.' + String(e.className||'').slice(0,24) + ' z=' + s2.zIndex + ' pos=' + s2.position + ' tr=' + (s2.transform !== 'none' ? 'yes' : 'no'));
              e = e.parentElement; }
            return {navZ: cs.zIndex, compZ: cc.zIndex, chain: chain, stack: before, tries: tries}; }"""))
        await br.close()
asyncio.run(main())

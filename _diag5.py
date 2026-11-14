import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
Q = """() => {
  const out = [];
  for (const el of document.querySelectorAll('.wrap *')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width > 322 && cs.position !== 'fixed' && cs.position !== 'absolute') {
      out.push({t: el.tagName + '#' + (el.id||'') + '.' + String(el.className||'').slice(0,40),
                w: Math.round(r.width), l: Math.round(r.left), minW: cs.minWidth, disp: cs.display});
    }
  }
  return out.sort((a,b)=>b.w-a.w).slice(0,10);
}"""
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":320,"height":568}, is_mobile=True, has_touch=True, device_scale_factor=2)
        r = await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        print("login", r.status)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1800)
        for row in await p.evaluate(Q):
            print(row)
        await br.close()
asyncio.run(main())

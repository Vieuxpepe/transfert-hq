import asyncio, json
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
STEP = """(sel) => {
  const host = document.querySelector(sel);
  if (!host) return null;
  const kids = [...host.children];
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i], prev = el.style.display;
    el.style.display = 'none';
    const w = innerWidth;
    el.style.display = prev;
    if (w <= 322) {
      const r = el.getBoundingClientRect();
      return {tag: el.tagName + '#' + (el.id || '') + '.' + String(el.className || '').slice(0, 50),
              idx: i, w: Math.round(r.width), h: Math.round(r.height)};
    }
  }
  return {none: true, kids: kids.length};
}"""
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":320,"height":568}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1500)
        sel = ".wrap"
        for _ in range(8):
            res = await p.evaluate(STEP, sel)
            print(sel, "->", res)
            if not res or res.get("none"):
                break
            path = await p.evaluate("""(idx) => { const host = document.querySelector(arguments[1]); }""", res["idx"]) if False else None
            sel = sel + " > *:nth-child(%d)" % (res["idx"] + 1)
        await br.close()
asyncio.run(main())

import asyncio
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8765"; PIN="1427785"
FIND = """() => {
  let host = document.querySelector('.wrap');
  const chain = [];
  for (let depth = 0; depth < 6; depth++) {
    const kids = [...host.children];
    let found = null;
    for (const el of kids) {
      const prev = el.style.display;
      el.style.display = 'none';
      const w = innerWidth;
      el.style.display = prev;
      if (w <= 322) { found = el; break; }
    }
    if (!found) break;
    chain.push(found.tagName + '#' + (found.id||'') + '.' + String(found.className||'').slice(0,60));
    host = found;
  }
  return chain;
}"""
async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={"width":320,"height":568}, is_mobile=True, has_touch=True, device_scale_factor=2)
        await ctx.request.post(BASE+"/login", form={"pin":PIN}, headers={"origin":BASE}, max_redirects=0)
        p = await ctx.new_page(); await p.goto(BASE+"/#accueil"); await p.wait_for_selector(".bottom-nav")
        await p.wait_for_timeout(1800)
        print("chain:", await p.evaluate(FIND))
        print(await p.evaluate("""() => { const out=[]; for (const el of document.querySelectorAll('body *')) {
            const r=el.getBoundingClientRect(), cs=getComputedStyle(el);
            if (Math.round(r.width) >= 380 && cs.position === 'fixed') out.push(el.tagName+'#'+(el.id||'')+'.'+String(el.className||'').slice(0,40)+' w'+Math.round(r.width)); }
            return out.slice(0,8); }"""))
        await br.close()
asyncio.run(main())

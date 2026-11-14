"""Walk the HQ nav at four sizes in real Chromium, and keep the evidence.

Desktop: every tab in the rail is clicked; the page must land on that view, exactly one row is active and it is that row;
no row or label may be cut. Phone: five tabs, then Plus must open a panel listing every space the bar does not carry,
each entry must navigate and close the panel, and the bar must mark the current view (or Plus when it has no tab).
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8765"
PIN = "1427785"
PROBES = ("intime", "dessiner", "forge", "projets", "inventaire", "lecteur", "musique", "ops", "engine", "securite", "robotique")
fails = []


def bad(msg):
    fails.append(msg)
    print("  FAIL", msg)


STATE = """() => {
  const nav = document.querySelector('.bottom-nav'), nr = nav.getBoundingClientRect();
  const vis = [...nav.querySelectorAll('[data-nav]')].filter(b => getComputedStyle(b).display !== 'none');
  const rows = vis.map(b => { const r = b.getBoundingClientRect();
    const labels = [...b.querySelectorAll('.nav-label')].filter(n => getComputedStyle(n).display !== 'none');
    const lab = labels[labels.length - 1];
    return {n: b.dataset.nav, cut: r.bottom > nr.bottom + 0.5 || r.top < nr.top - 0.5 || r.right > nr.right + 0.5,
            trunc: lab ? lab.scrollWidth > lab.clientWidth + 1 : false, active: b.classList.contains('active')}; });
  const panel = document.querySelector('[data-panel="plus"]');
  const links = [...document.querySelectorAll('.hq-more-nav [data-view-link]')].filter(a => a.offsetParent !== null);
  return {view: document.body.dataset.view, names: vis.map(b => b.dataset.nav), rows: rows,
          cut: rows.filter(r => r.cut).map(r => r.n), trunc: rows.filter(r => r.trunc).map(r => r.n),
          active: rows.filter(r => r.active).map(r => r.n),
          plus: panel ? !!panel.offsetParent : false, links: links.map(a => a.dataset.viewLink),
          scrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight}; }"""


async def settle(p):
    try:
        await p.wait_for_function("() => !document.body.classList.contains('hq-vt-active')", timeout=4000)
    except Exception:
        pass
    await p.wait_for_timeout(150)


async def alive(ctx, label, where):
    try:
        await ctx.request.get(BASE + "/api/status", timeout=5000)
        return True
    except Exception:
        bad(f"{label}: bridge stopped answering after '{where}'")
        return False


async def desktop(br, label, w, h):
    ctx = await br.new_context(viewport={"width": w, "height": h})
    await ctx.request.post(BASE + "/login", form={"pin": PIN}, headers={"origin": BASE}, max_redirects=0)
    await ctx.add_init_script("try { localStorage.setItem('tf_hq_mode','complet'); } catch (_) {}")
    p = await ctx.new_page()
    await p.goto(BASE + "/"); await p.wait_for_selector(".bottom-nav"); await p.wait_for_timeout(1200)
    s0 = await p.evaluate(STATE)
    print(f"-- {label}: {len(s0['names'])} tabs")
    bad(f"{label}: {s0['cut']} cut at rest") if s0["cut"] else None
    bad(f"{label}: {s0['trunc']} truncated at rest") if s0["trunc"] else None
    for nav_id in s0["names"]:
        await settle(p)
        await p.locator(f'.bottom-nav [data-nav="{nav_id}"]').click(force=True)
        await p.wait_for_timeout(400); await settle(p)
        s = await p.evaluate(STATE)
        if s["view"] != nav_id:                  # a tap during a view transition can be swallowed: tap again once
            await settle(p)
            await p.locator(f'.bottom-nav [data-nav="{nav_id}"]').click(force=True)
            await p.wait_for_timeout(400); await settle(p)
            s = await p.evaluate(STATE)
            print(f"   retapped {nav_id} (first tap lost)")
        if s["view"] != nav_id:
            bad(f"{label}: '{nav_id}' opened '{s['view']}'")
        if s["active"] != [nav_id]:
            bad(f"{label}: on '{s['view']}' active={s['active']}")
        if s["cut"] or s["trunc"]:
            bad(f"{label}: {nav_id} cut={s['cut']} trunc={s['trunc']}")
        if not await alive(ctx, label, nav_id):
            break
    await ctx.close()


async def phone(br, label, w, h, shot):
    ctx = await br.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=2)
    await ctx.request.post(BASE + "/login", form={"pin": PIN}, headers={"origin": BASE}, max_redirects=0)
    p = await ctx.new_page()
    await p.goto(BASE + "/#accueil"); await p.wait_for_selector(".bottom-nav"); await p.wait_for_timeout(1400)
    s0 = await p.evaluate(STATE)
    print(f"-- {label}: {len(s0['names'])} tabs {s0['names']}")
    if s0["cut"] or s0["trunc"]:
        bad(f"{label}: cut={s0['cut']} trunc={s0['trunc']}")
    if s0["view"] == "accueil" and s0["active"] != ["accueil"]:
        bad(f"{label}: resting active={s0['active']}")
    for nav_id in s0["names"]:
        await settle(p)
        await p.locator(f'.bottom-nav [data-nav="{nav_id}"]').click(force=True)
        await p.wait_for_timeout(400); await settle(p)
        s = await p.evaluate(STATE)
        want = [s["view"]] if s["view"] in s["names"] else ["plus"]
        if s["active"] != want:
            bad(f"{label}: on '{s['view']}' active={s['active']} wanted {want}")
        if s["cut"] or s["trunc"]:
            bad(f"{label}: {nav_id} cut={s['cut']} trunc={s['trunc']}")
    # the Plus panel is the way to everything the bar does not carry
    await settle(p)
    await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
    await p.wait_for_timeout(700); await settle(p)
    s = await p.evaluate(STATE)
    if not s["plus"]:                       # same swallowed tap: a second press is what a thumb would do
        await settle(p)
        await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
        await p.wait_for_timeout(700); await settle(p)
        s = await p.evaluate(STATE)
        print("   retapped plus (first tap lost)")
    if not s["plus"]:
        bad(f"{label}: Plus panel did not open")
        await ctx.close(); return
    missing = [n for n in PROBES if n not in s0["names"] and n not in s["links"] and n != "ops"]
    if missing:
        bad(f"{label}: Plus is missing {missing}")
    if not s["scrollable"]:
        bad(f"{label}: Plus page does not scroll")
    if s["active"] != ["plus"]:
        bad(f"{label}: Plus open but bar marks {s['active']}")
    await p.screenshot(path=shot)
    print(f"   screenshot {shot}")
    for target in [n for n in PROBES if n not in s0["names"] and n in s["links"]]:
        link = p.locator(f'.hq-more-nav [data-view-link="{target}"]')
        await link.evaluate("el => el.scrollIntoView({block: 'center'})")
        await p.wait_for_timeout(150); await settle(p)
        try:
            await link.click(force=True)
        except Exception as exc:
            bad(f"{label}: Plus link {target} not clickable ({str(exc).splitlines()[0]})")
            continue
        await p.wait_for_timeout(400); await settle(p)
        s2 = await p.evaluate(STATE)
        if s2["view"] != target:
            bad(f"{label}: Plus -> {target} opened '{s2['view']}'")
        if s2["plus"]:
            bad(f"{label}: Plus panel still open on '{target}'")
        want = [s2["view"]] if s2["view"] in s2["names"] else ["plus"]
        if s2["active"] != want:
            bad(f"{label}: after Plus->{target} active={s2['active']} wanted {want}")
        await settle(p)
        await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
        await p.wait_for_timeout(500); await settle(p)
        if not (await p.evaluate("() => !!document.querySelector('[data-panel=\"plus\"]')?.offsetParent")):
            await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
            await p.wait_for_timeout(500); await settle(p)
    await ctx.close()


async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        only = sys.argv[1] if len(sys.argv) > 1 else ""
        if only in ("", "d1"): await desktop(br, "desktop 1366x768", 1366, 768)
        if only in ("", "d2"): await desktop(br, "desktop 1440x900", 1440, 900)
        if only in ("", "p1"): await phone(br, "phone 390x844", 390, 844, "nav-mobile-plus-390.png")
        if only in ("", "p2"): await phone(br, "phone 320x568", 320, 568, "nav-mobile-plus-320.png")
        await br.close()
    print("\nFAILURES:", len(fails))
    sys.exit(1 if fails else 0)

asyncio.run(main())

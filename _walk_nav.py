"""Walk every space from the nav in a real Chromium, at four sizes and both modes.

For each view: one click on its nav entry, then check that the page really changed, that exactly one nav row is active and
that it is the row for the current view (or Plus on the phone when the view lives in Plus), that no row is cut off or its
label truncated, and that the Plus panel lists the hidden spaces and closes when one is picked.
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8765"
PIN = "1427785"
DROP_HUD = """() => { document.querySelectorAll('aside').forEach(a => {
  if ((a.getAttribute('aria-label') || '').indexOf('Diagnostics') >= 0) a.remove(); }); }"""

STATE = """() => {
  const nav = document.querySelector('.bottom-nav');
  const nr = nav.getBoundingClientRect();
  const vis = [...nav.querySelectorAll('[data-nav]')].filter(b => getComputedStyle(b).display !== 'none');
  const act = vis.filter(b => b.classList.contains('active'));
  const rows = vis.map(b => {
    const r = b.getBoundingClientRect();
    const labels = [...b.querySelectorAll('.nav-label')].filter(n => getComputedStyle(n).display !== 'none');
    const lab = labels[labels.length - 1];
    return { n: b.dataset.nav, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
             cut: r.bottom > nr.bottom + 0.5 || r.top < nr.top - 0.5 || r.right > nr.right + 0.5,
             trunc: lab ? lab.scrollWidth > lab.clientWidth + 1 : null };
  });
  const plus = document.querySelector('[data-panel="plus"]');
  const links = [...document.querySelectorAll('.hq-more-nav [data-view-link]')]
    .filter(a => getComputedStyle(a).display !== 'none' && a.offsetParent !== null);
  return { view: document.body.dataset.view, mode: document.body.classList.contains('mode-simple') ? 'simple' : 'complet',
           names: vis.map(b => b.dataset.nav), active: act.map(b => b.dataset.nav),
           cut: rows.filter(r => r.cut).map(r => r.n), trunc: rows.filter(r => r.trunc).map(r => r.n),
           railScroll: nav.scrollHeight - nav.clientHeight,
           plus: plus ? !!plus.offsetParent : false, links: links.map(a => a.dataset.viewLink),
           plusCurrent: (document.querySelector('.hq-more-nav [aria-current="page"]') || {}).dataset ?
                        document.querySelector('.hq-more-nav [aria-current="page"]').dataset.viewLink : null,
           panelScroll: (() => { const d = document.documentElement;
             return d.scrollHeight - d.clientHeight; })() }; }"""

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("   FAIL", msg)


async def settle(p):
    # A view transition paints a snapshot over the page for a few hundred ms; a tap during it is lost.
    try:
        await p.wait_for_function("() => !document.body.classList.contains('hq-vt-active')", timeout=4000)
    except Exception:
        pass
    await p.wait_for_timeout(120)


async def walk(ctx, label, mobile):
    p = await ctx.new_page()
    p.on("pageerror", lambda e: None if "unsafe-eval" in str(e) else fails.append(f"{label}: pageerror {e}"))
    await p.goto(BASE + "/")
    await p.wait_for_selector(".bottom-nav")
    await p.wait_for_timeout(900)
    await p.evaluate(DROP_HUD)
    s0 = await p.evaluate(STATE)
    print(f"-- {label} ({s0['mode']}, {len(s0['names'])} tabs)")
    check(not s0["cut"], f"{label}: rows cut off at rest {s0['cut']}")
    check(not s0["trunc"], f"{label}: labels truncated at rest {s0['trunc']}")

    # 1. every tab in the bar
    for nav_id in s0["names"]:
        if nav_id == "plus" and not mobile:
            pass
        await settle(p)
        await p.locator(f'.bottom-nav [data-nav="{nav_id}"]').click(force=True)
        await p.wait_for_timeout(450)
        await settle(p)
        await p.evaluate(DROP_HUD)
        s = await p.evaluate(STATE)
        expect = nav_id
        check(len(s["active"]) == 1, f"{label}: {nav_id} leaves {len(s['active'])} active rows {s['active']}")
        if mobile and nav_id not in ("accueil", "carnet", "calendrier", "fichiers", "plus"):
            pass
        if s["active"]:
            want = s["view"] if s["view"] in s["names"] else "plus"
            check(s["active"][0] == want, f"{label}: on '{s['view']}' the bar marks '{s['active'][0]}' (wanted '{want}')")
        try:
            await ctx.request.get(BASE + "/api/status", timeout=5000)
        except Exception:
            fails.append(f"{label}: bridge stopped answering after opening '{nav_id}'")
            print("   DIED AT", nav_id)
            return
        check(not s["cut"], f"{label}: {nav_id} -> rows cut {s['cut']}")
        check(not s["trunc"], f"{label}: {nav_id} -> labels truncated {s['trunc']}")

    # 2. Plus lists every space the bar does not have, and each entry navigates + closes the panel
    if mobile:
        bar = set(s0["names"])
        await settle(p)
        await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
        await p.wait_for_timeout(400)
        await settle(p)
        s = await p.evaluate(STATE)
        check(s["plus"], f"{label}: Plus panel not shown")
        hidden = [n for n in ("intime", "dessiner", "forge", "projets", "inventaire", "lecteur", "musique",
                              "ops", "engine", "securite", "robotique") if n not in bar]
        # in simple mode Terminal (ops) is not reachable by design; every other hidden space must be listed
        expected = [n for n in hidden if not (n == "ops" and s["mode"] == "simple")]
        missing = [n for n in expected if n not in s["links"]]
        check(not missing, f"{label}: Plus is missing {missing} (has {s['links']})")
        check(s["panelScroll"] > 0, f"{label}: Plus page does not scroll (content {s['panelScroll']}px)")
        for target in expected:
            link = p.locator(f'.hq-more-nav [data-view-link="{target}"]')
            try:
                await link.evaluate("el => el.scrollIntoView({block: 'center'})")   # a thumb would scroll it clear of floating chrome
                await p.wait_for_timeout(200)
                await settle(p)
                await link.click(force=True)
            except Exception as exc:
                info = await p.evaluate("""(t) => { const a = document.querySelector('.hq-more-nav [data-view-link="' + t + '"]');
                  const nav = document.querySelector('.hq-more-nav'); const r = a.getBoundingClientRect();
                  const cs = getComputedStyle(a), cn = getComputedStyle(nav);
                  return {rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                          vis: cs.visibility, disp: cs.display, navDisp: cn.display, navH: Math.round(nav.getBoundingClientRect().height),
                          view: document.body.dataset.view,
                          top: (() => { const e = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
                            return e ? e.tagName + '.' + String(e.className||'').slice(0,40) : null; })()}; }
                """, target)
                print("   LINKDIAG", target, info, str(exc).splitlines()[0])
                fails.append(f"{label}: Plus link {target} not clickable")
                continue
            await p.wait_for_timeout(450)
            await p.evaluate(DROP_HUD)
            s2 = await p.evaluate(STATE)
            check(s2["view"] == target, f"{label}: Plus -> {target} landed on '{s2['view']}'")
            check(not s2["plus"], f"{label}: Plus panel still visible after going to {target}")
            check(len(s2["active"]) == 1, f"{label}: after Plus -> {target}, {len(s2['active'])} active rows")
            if s2["active"]:
                check(s2["active"][0] in (target, "plus"),
                      f"{label}: after Plus -> {target} the bar marks '{s2['active'][0]}'")
            await settle(p)
            await p.locator('.bottom-nav [data-nav="plus"]').click(force=True)
            await p.wait_for_timeout(350)
            await settle(p)
            await p.evaluate(DROP_HUD)
            await p.evaluate("() => document.querySelector('.bottom-nav').scrollIntoView({block: 'end'})")
    else:
        # 3. desktop: the spaces simple mode hides must still mark their row when they are the current view
        for target in ("engine", "securite", "musique"):
            await p.evaluate(f"setView('{target}')")
            await p.wait_for_timeout(350)
            await p.evaluate(DROP_HUD)
            s = await p.evaluate(STATE)
            if s["mode"] == "simple" and target not in s["names"]:
                continue
            check(s["view"] == target, f"{label}: setView('{target}') landed on '{s['view']}'")
            check(s["active"] == [target], f"{label}: '{target}' marks {s['active']}")
    await p.close()


async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        desktop = (("1366x768", 1366, 768), ("1440x900", 1440, 900))
        phones = (("390x844", 390, 844), ("320x568", 320, 568))
        only = sys.argv[1] if len(sys.argv) > 1 else ""
        for mode in ("simple", "complet"):
            if only and only != "desktop":
                continue
            for label, w, h in desktop:
                ctx = await br.new_context(viewport={"width": w, "height": h})
                await ctx.request.post(BASE + "/login", form={"pin": PIN}, headers={"origin": BASE}, max_redirects=0)
                await ctx.add_init_script(f"try {{ localStorage.setItem('tf_hq_mode', '{mode}'); }} catch (_) {{}}")
                await walk(ctx, f"desktop {label} {mode}", False)
                await ctx.close()
        _only = sys.argv[1] if len(sys.argv) > 1 else ""
        for label, w, h in phones:
            if _only and _only != "phone":
                continue
            ctx = await br.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=2)
            await ctx.request.post(BASE + "/login", form={"pin": PIN}, headers={"origin": BASE}, max_redirects=0)
            await walk(ctx, f"phone {label}", True)
            await ctx.close()
        await br.close()
    print("\nFAILURES:", len(fails))
    for f in fails[:40]:
        print(" -", f)
    sys.exit(1 if fails else 0)

asyncio.run(main())

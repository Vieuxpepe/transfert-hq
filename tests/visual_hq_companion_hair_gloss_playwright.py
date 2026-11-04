"""Isolated fake-provider rendering check: pink crown-side rim must visibly change pixels, never crown/face."""
import json, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='hq-hair-gloss-') as fixture_root:
 proc=subprocess.Popen([sys.executable,str(ROOT/'tests/carnet_test_server.py'),fixture_root],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  info=json.loads(proc.stdout.readline().decode('utf-8'))
  with sync_playwright() as p:
   browser=p.chromium.launch();ctx=browser.new_context(viewport={'width':1200,'height':1000},reduced_motion='reduce')
   ctx.add_init_script("localStorage.setItem('hq_companion_collapsed','0');localStorage.setItem('hq_companion_nsfw','1');localStorage.setItem('hq_companion_layered_portrait','1')")
   page=ctx.new_page()
   def safe(route,request):
    if request.method=='POST':return route.fulfill(json={'ok':True,'line':'','messages':[]})
    return route.continue_()
   page.route('**/api/ai**',safe)
   page.goto(info['base']);page.locator('input[name="pin"]').fill(info['admin_pin']);page.locator('button[type="submit"]').click()
   page.wait_for_selector('.has-layered-portrait');page.wait_for_timeout(500)
   page.emulate_media(reduced_motion='no-preference')
   gloss=page.locator('.hq-companion-rig-hair-sheen').first
   assert gloss.evaluate('(e)=>getComputedStyle(e,"::before").animationName')=='hq-hair-side-gloss'
   page.locator('#hq-companion').evaluate('(e)=>e.classList.add("is-bust-pull")')
   assert gloss.evaluate('(e)=>getComputedStyle(e,"::before").animationPlayState')=='paused'
   page.locator('#hq-companion').evaluate('(e)=>e.classList.remove("is-bust-pull")')
   page.emulate_media(reduced_motion='reduce')
   assert gloss.evaluate('(e)=>getComputedStyle(e,"::before").animationName')=='none'
   page.add_style_tag(content='.hq-companion *{animation:none!important;transition:none!important}.hq-companion-frame>*{visibility:hidden!important}')
   # Hold the rendered physics pose fixed for an exact mask-only pixel comparison.
   page.evaluate('() => {for(let id=0;id<10000;id++) cancelAnimationFrame(id)}')
   avatar=page.locator('.hq-companion-avatar')
   avatar.screenshot(path=str(ROOT/'artifacts/hair-gloss-on.png'))
   box=avatar.bounding_box()
   page.screenshot(path=str(ROOT/'artifacts/hair-rim-crown-preview.png'),clip={
       'x':max(0,box['x']-8),'y':max(0,box['y']-box['height']*.32),
       'width':min(box['width']+16,1200-max(0,box['x']-8)),
       'height':min(box['height']*1.32+8,1000-max(0,box['y']-box['height']*.32))})
   page.add_style_tag(content='.hq-companion-rig-hair-sheen{visibility:hidden!important}')
   avatar.screenshot(path=str(ROOT/'artifacts/hair-gloss-off.png'))
   browser.close()
 finally:
  proc.terminate();proc.wait(timeout=10)
a=Image.open(ROOT/'artifacts/hair-gloss-on.png').convert('RGB');b=Image.open(ROOT/'artifacts/hair-gloss-off.png').convert('RGB');d=ImageChops.difference(a,b)
strong=sum(max(px)>40 for px in d.get_flattened_data());print('Visible gloss pixels (delta >40):',strong,'difference bounds:',d.getbbox())
assert strong>80, 'Rim light is not visible at normal avatar size'
pink=sum(max(delta)>40 and px[0]>px[1]+35 and px[2]>px[1]+15
         for px,delta in zip(a.get_flattened_data(),d.get_flattened_data()))
assert pink>100, 'The visible light must be pink, not white gloss'
print('Clearly pink changed pixels:',pink)
w,h=a.size
assert d.crop((0,int(h*.43),w,h)).getbbox() is None, 'Rim reached the lower curls'
assert d.crop((int(w*.43),0,int(w*.59),int(h*.14))).getbbox() is None, 'Rim reached the crown center'
assert d.crop((int(w*.42),int(h*.25),int(w*.62),int(h*.45))).getbbox() is None, 'Gloss reached central face'
print('Visible side gloss; lower curls, crown center and central face unchanged; no generation calls.')

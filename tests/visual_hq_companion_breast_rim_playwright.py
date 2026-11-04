"""Isolated rendering regression: remove the pink upper/inner breast seam.

Compares the new outer-only light with the previous full-perimeter light on
the same frozen portrait pose. No live data or provider calls.
"""
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
   page.add_style_tag(content='.hq-companion *{animation:none!important;transition:none!important}.hq-companion-frame>*{visibility:hidden!important}')
   # Hold the rendered physics pose fixed for an exact mask-only pixel comparison.
   page.evaluate('() => {for(let id=0;id<10000;id++) cancelAnimationFrame(id)}')
   avatar=page.locator('.hq-companion-avatar')
   avatar.screenshot(path=str(ROOT/'artifacts/breast-rim-soft.png'))
   box=avatar.bounding_box()
   page.screenshot(path=str(ROOT/'artifacts/breast-rim-soft-preview.png'),clip={
       'x':max(0,box['x']-8),'y':max(0,box['y']-box['height']*.32),
       'width':min(box['width']+16,1200-max(0,box['x']-8)),
       'height':min(box['height']*1.32+8,1000-max(0,box['y']-box['height']*.32))})
   page.add_style_tag(content='.hq-bust-light::after{background:radial-gradient(ellipse 21% 21% at var(--cx) var(--cy),transparent 72%,color-mix(in srgb,var(--frame-c,#ff4f97) 70%,#fff) 100%)!important;mask-image:none!important;-webkit-mask-image:none!important;opacity:.55!important}' )
   avatar.screenshot(path=str(ROOT/'artifacts/breast-rim-before.png'))
   browser.close()
 finally:
  proc.terminate();proc.wait(timeout=10)

a=Image.open(ROOT/'artifacts/breast-rim-soft.png').convert('RGB')
b=Image.open(ROOT/'artifacts/breast-rim-before.png').convert('RGB')
w,h=a.size
region=(int(w*.2),int(h*.45),int(w*.8),int(h*.7))
a=a.crop(region);b=b.crop(region)
changed=sum(max(d)>15 for d in ImageChops.difference(a,b).get_flattened_data())
blue_reduction=sum(old[2]-new[2] for new,old in zip(a.get_flattened_data(),b.get_flattened_data()))
print('Upper/inner chest changed pixels:',changed,'removed excess blue/pink:',blue_reduction)
assert changed>100 and blue_reduction>1000
